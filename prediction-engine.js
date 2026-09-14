/**
 * prediction-engine.js — PredictIQ Probability Simulation Engine
 *
 * Runs in any signed-in user's browser. Reads marketSecrets for the
 * hidden resolution bias, then drifts currentProbability toward the
 * correct outcome every tick. Writes to marketLive so all users see
 * the same probability. Snapshots probabilityHistory every 3 minutes
 * for the P&L chart and breaking page spark lines.
 *
 * Usage:
 *   predictionEngine.start(optionalCallbackFn)
 *   predictionEngine.stop()
 *   predictionEngine.refresh()
 *   predictionEngine.getProbability(marketId)  → number | null
 */

(function () {

  var TICK_MS       = 7000;   // probability update every 7 seconds
  var SNAPSHOT_MS   = 180000; // probabilityHistory snapshot every 3 minutes
  var MIN_PROB      = 2;
  var MAX_PROB      = 98;

  var _markets      = [];     // [{id, currentProbability, resolutionBias, targetProbability, resolutionDate}]
  var _tickTimer    = null;
  var _snapTimer    = null;
  var _started      = false;
  var _callback     = null;   // fn(marketId, newProbability) called on each update
  var _lastSnapshot = 0;

  // ── Seeded noise — avoids Math.random() correlation between markets ───────
  function noise(seed) {
    var x = Math.sin(seed + Date.now() * 0.0001) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1; // -1 to 1
  }

  // ── Urgency — how strongly to drift toward target as deadline nears ───────
  function urgency(resolutionDate) {
    if (!resolutionDate) return 0.02;
    var end   = resolutionDate.toDate ? resolutionDate.toDate() : new Date(resolutionDate);
    var total = end - new Date();
    if (total <= 0) return 0.5;                          // past due — strong pull
    var days  = total / 86400000;
    if (days > 30)  return 0.005;                        // far away — very gentle
    if (days > 7)   return 0.015;
    if (days > 1)   return 0.04;
    if (days > 0.1) return 0.12;
    return 0.3;                                           // under 2.4 hours — strong
  }

  // ── Single market tick ────────────────────────────────────────────────────
  function tickMarket(m, seedOffset) {
    var u        = urgency(m.resolutionDate);
    var target   = m.targetProbability;
    var current  = m.currentProbability;

    // Drift component — pulls toward target
    var drift    = (target - current) * u;

    // Noise component — random walk, scaled down near limits
    var noiseMag = 1.5 * (1 - Math.abs(current - 50) / 50);
    var jitter   = noise(seedOffset) * noiseMag;

    var next = current + drift + jitter;
    next = Math.max(MIN_PROB, Math.min(MAX_PROB, next));
    next = Math.round(next * 10) / 10; // 1 decimal place

    return next;
  }

  // ── Write batch: update all marketLive docs in one pass ──────────────────
  async function writeTick() {
    if (!_markets.length) return;

    var now        = Date.now();
    var doSnapshot = (now - _lastSnapshot) >= SNAPSHOT_MS;
    if (doSnapshot) _lastSnapshot = now;

    // Process each market
    var updates = _markets.map(function (m, i) {
      var next = tickMarket(m, i * 97.3);
      m.currentProbability = next;
      return { m: m, next: next };
    });

    // Write to Firestore in batches of 400
    try {
      var batch = db.batch();
      var opCount = 0;

      for (var i = 0; i < updates.length; i++) {
        var u  = updates[i];
        var liveRef = db.collection('marketLive').doc(u.m.id);
        batch.set(liveRef, {
          currentProbability: u.next,
          lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        opCount++;

        if (doSnapshot) {
          var histRef = db.collection('markets').doc(u.m.id)
            .collection('probabilityHistory').doc();
          batch.set(histRef, {
            probability: u.next,
            timestamp:   firebase.firestore.FieldValue.serverTimestamp()
          });
          opCount++;
        }

        // Flush batch if approaching limit
        if (opCount >= 400) {
          await batch.commit();
          batch   = db.batch();
          opCount = 0;
        }
      }

      if (opCount > 0) await batch.commit();
    } catch (e) {
      console.warn('[prediction-engine] write failed:', e.message);
    }

    // Fire callback for any page listening (e.g. market-detail live update)
    if (_callback) {
      updates.forEach(function (u) {
        try { _callback(u.m.id, u.next); } catch (e) {}
      });
    }
  }

  // ── Load active markets + secrets ─────────────────────────────────────────
  async function loadMarkets() {
    try {
      var mSnap = await db.collection('markets')
        .where('status', '==', 'active')
        .get();

      if (mSnap.empty) {
        _markets = [];
        console.log('[prediction-engine] no active markets');
        return;
      }

      // Fetch marketLive and marketSecrets in parallel
      var ids = mSnap.docs.map(function (d) { return d.id; });

      var livePromises   = ids.map(function (id) {
        return db.collection('marketLive').doc(id).get().catch(function () { return null; });
      });
      var secretPromises = ids.map(function (id) {
        return db.collection('marketSecrets').doc(id).get().catch(function () { return null; });
      });

      var lives   = await Promise.all(livePromises);
      var secrets = await Promise.all(secretPromises);

      _markets = mSnap.docs.map(function (d, i) {
        var data   = d.data();
        var live   = lives[i]   && lives[i].exists   ? lives[i].data()   : {};
        var secret = secrets[i] && secrets[i].exists  ? secrets[i].data() : {};

        var currentProb = typeof live.currentProbability === 'number'
          ? live.currentProbability
          : (data.startingProbability || 50);

        // targetProbability defaults: YES bias → 85, NO bias → 15
        var bias   = secret.resolutionBias    || 'YES';
        var target = typeof secret.targetProbability === 'number'
          ? secret.targetProbability
          : (bias === 'YES' ? 85 : 15);

        return {
          id:                 d.id,
          currentProbability: currentProb,
          resolutionBias:     bias,
          targetProbability:  target,
          resolutionDate:     data.resolutionDate || null
        };
      }).filter(function (m) {
        // Skip markets that have no secret (no bias set = admin hasn't configured it)
        return !!secrets[ids.indexOf(m.id)] && secrets[ids.indexOf(m.id)].exists;
      });

      console.log('[prediction-engine] started, tracking', _markets.length, 'markets');
    } catch (e) {
      console.warn('[prediction-engine] loadMarkets failed:', e.message);
      _markets = [];
    }
  }

  // ── Schedule tick loop ────────────────────────────────────────────────────
  function scheduleTick() {
    if (_tickTimer) clearInterval(_tickTimer);
    _tickTimer = setInterval(function () {
      writeTick().catch(function (e) {
        console.warn('[prediction-engine] tick error:', e.message);
      });
    }, TICK_MS);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.predictionEngine = {

    /**
     * Start the engine. Call once per page inside onAuthStateChanged.
     * @param {Function} [callback] - fn(marketId, probability) fired on each tick.
     */
    start: async function (callback) {
      if (_started) {
        // Already running — just update callback if provided
        if (callback) _callback = callback;
        return;
      }
      _started  = true;
      _callback = callback || null;
      _lastSnapshot = Date.now();

      await loadMarkets();
      // Fire one tick immediately so pages get fresh data on load
      await writeTick();
      scheduleTick();
    },

    /**
     * Stop all timers. Call on signout if needed.
     */
    stop: function () {
      if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
      _started = false;
      _markets = [];
      console.log('[prediction-engine] stopped');
    },

    /**
     * Reload market list — call after admin creates a new market.
     */
    refresh: async function () {
      await loadMarkets();
      console.log('[prediction-engine] refreshed —', _markets.length, 'markets');
    },

    /**
     * Get the last known probability for a market.
     * @param {string} marketId
     * @returns {number|null}
     */
    getProbability: function (marketId) {
      var m = _markets.find(function (x) { return x.id === marketId; });
      return m ? m.currentProbability : null;
    },

    /**
     * Expose market list for debugging.
     */
    getMarkets: function () { return _markets.slice(); }
  };

})();
