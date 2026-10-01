/**
 * copy-betting-engine.js — VectorProb Copy Betting Engine
 *
 * Ten expert predictors with hidden personalities. Each expert fires
 * bets on a per-expert timer, betting correctly based on win rate vs
 * resolution bias. Users follow ONE expert at a time. Bets mirror to
 * copyPositions for the current signed-in user only — no cross-user
 * reads to respect Firestore security rules.
 *
 * Usage:
 *   copyBettingEngine.start()
 *   copyBettingEngine.stop()
 *   copyBettingEngine.getExperts()
 *   copyBettingEngine.userStartCopying(uid, expertId)  — catch-up on open markets
 *   copyBettingEngine.refresh()
 */

(function () {

  // ── Expert profiles ────────────────────────────────────────────────────────
  var EXPERTS = [
    { id:'expert_aria',    name:'Aria Voss',      winRate:0.87, categories:['politics','news'],          freqMs:95000,  isAI:false },
    { id:'expert_marco',   name:'Marco Reyes',    winRate:0.81, categories:['sports','entertainment'],   freqMs:110000, isAI:false },
    { id:'expert_tobias',  name:'Tobias Holt',    winRate:0.76, categories:['sports','politics'],        freqMs:130000, isAI:false },
    { id:'expert_jin',     name:'Jin Park',       winRate:0.79, categories:['crypto','sports'],          freqMs:70000,  isAI:false },
    { id:'expert_lena',    name:'Lena Strauss',   winRate:0.85, categories:['sports','economy'],        freqMs:115000, isAI:false },
    { id:'expert_axiom',   name:'Axiom',          winRate:0.89, categories:['politics','crypto','sports','finance','culture','news','entertainment','economy','geopolitics'], freqMs:85000, isAI:true }
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  var _activeMarkets = [];   // [{id, category, secret, currentProbability}]
  var _expertTimers  = {};   // { expertId: timerHandle }
  var _expertBets    = {};   // { expertId: Set<marketId> } — already bet on
  var _started       = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function todayUTC() {
    var d = new Date();
    return d.getUTCFullYear()+'-'+(d.getUTCMonth()+1)+'-'+d.getUTCDate();
  }

  // Pseudo-random seeded on time + expert — avoids all experts picking same market
  function seededRand(seed) {
    var s = (seed ^ 0xCAFEBABE) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 0xFFFFFFFF;
  }

  // Which side does the expert bet? winRate = P(correct outcome)
  function expertSide(expert, resolutionBias) {
    var r = seededRand(Date.now() + expert.id.length * 31);
    return r < expert.winRate ? resolutionBias : (resolutionBias === 'YES' ? 'NO' : 'YES');
  }

  // Weighted market pick — prefers expert's categories (3× weight)
  function pickMarket(expert, alreadyBet, userCreated) {
    var available = _activeMarkets.filter(function(m) {
      // only markets that have already appeared for this user
      return !alreadyBet.has(m.id) && m.secret && vpWindow.isVisible(userCreated, m);
    });
    if (!available.length) return null;
    var weighted = [];
    available.forEach(function(m) {
      var w = expert.categories.indexOf(m.category) >= 0 ? 3 : 1;
      for (var i = 0; i < w; i++) weighted.push(m);
    });
    var idx = Math.floor(seededRand(Date.now() + expert.id.charCodeAt(0)) * weighted.length);
    return weighted[idx];
  }

  function toDate(v) { return !v ? null : (v.toDate ? v.toDate() : new Date(v)); }

  // Close date = (later of user signup / market creation) + show-after days + resolution days
  function computeResolveAt(userCreated, market) {
    return vpWindow.closeAt(userCreated, market);
  }

  // ── Cached copyBetting doc (per user) ──────────────────────────────────────
  var CB_TTL = 5 * 60 * 1000;
  var _cb = null;   // { uid, data, at }
  async function getCB(uid) {
    if (_cb && _cb.uid === uid && Date.now() - _cb.at < CB_TTL) return _cb.data;
    var snap = await db.collection('copyBetting').doc(uid).get();
    _cb = { uid: uid, data: snap.exists ? snap.data() : null, at: Date.now() };
    return _cb.data;
  }

  // ── Mirror a bet to the current signed-in user ─────────────────────────────
  async function mirrorBetToUser(market, side, expertId) {
    var currentUser = auth.currentUser;
    if (!currentUser) return;

    var today = todayUTC();
    try {
      // Own copyBetting state is cached (5 min) so idle ticks cost zero reads
      var cb = await getCB(currentUser.uid);
      if (!cb || cb.status !== 'active') return;
      if (cb.expertId !== expertId) return; // following a different expert

      // Reset daily count if new UTC day
      if (cb.lastResetDate !== today) {
        await db.collection('copyBetting').doc(currentUser.uid).update({ betsToday: 0, lastResetDate: today });
        cb.betsToday = 0; cb.lastResetDate = today;
      }
      if (cb.betsToday >= (cb.maxBetsPerDay || 5)) return;

      // Read own balance
      var uSnap = await db.collection('users').doc(currentUser.uid).get();
      if (!uSnap.exists) return;
      var ud      = uSnap.data();
      var balance = ud.balance || 0;
      var stake   = Math.round(balance * ((cb.riskPercent || 10) / 100) * 100) / 100;
      if (stake < 1 || stake > balance) return;

      // Never mirror a market that hasn't appeared for this user yet
      if (!vpWindow.isVisible(ud.createdAt, market)) return;

      // Never mirror the same market twice for this user — checked against
      // Firestore (not just in-memory), so it holds even across page reloads.
      var dupSnap = await db.collection('copyPositions')
        .where('userId','==',currentUser.uid)
        .where('marketId','==',market.id)
        .limit(1).get();
      if (!dupSnap.empty) return;

      // Skip markets whose window has already closed for this user
      var resolveAt = computeResolveAt(ud.createdAt, market);
      if (resolveAt && resolveAt.getTime() <= Date.now()) return;

      var yesNow     = vpProb.now(market);   // computed locally, no read
      var entryProb  = side === 'YES' ? Math.round(yesNow) : Math.round(100 - yesNow);
      var potential  = entryProb > 0 ? Math.round(stake / (entryProb / 100) * 100) / 100 : 0;

      var batch = db.batch();
      var cpRef = db.collection('copyPositions').doc();
      batch.set(cpRef, {
        userId:           currentUser.uid,
        marketId:         market.id,
        expertId:         expertId,
        side:             side,
        stake:            stake,
        entryProbability: entryProb,
        potentialPayout:  potential,
        status:           'open',
        resolveAt:        resolveAt ? firebase.firestore.Timestamp.fromDate(resolveAt) : null,
        payoutAmount:     null,
        feeAmount:        null,
        createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
        settledAt:        null
      });
      batch.update(db.collection('users').doc(currentUser.uid), {
        balance: firebase.firestore.FieldValue.increment(-stake)
      });
      batch.set(db.collection('transactions').doc(), {
        userId:    currentUser.uid,
        type:      'stake',
        amount:    -stake,
        relatedId: cpRef.id,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.set(db.collection('marketLive').doc(market.id), {
        totalVolume: firebase.firestore.FieldValue.increment(stake)
      }, { merge: true });
      batch.update(db.collection('markets').doc(market.id), {
        totalVolume: firebase.firestore.FieldValue.increment(stake)
      });
      batch.update(db.collection('copyBetting').doc(currentUser.uid), {
        betsToday:     firebase.firestore.FieldValue.increment(1),
        lastResetDate: today
      });
      await batch.commit();
      cb.betsToday = (cb.betsToday || 0) + 1; cb.lastResetDate = today;
      console.log('[copy-betting] mirrored', side, '$'+stake, 'for', currentUser.uid, 'on market', market.id);
    } catch(e) {
      console.warn('[copy-betting] mirrorBetToUser failed:', e.message);
    }
  }

  // ── Expert tick ────────────────────────────────────────────────────────────
  async function expertTick(expert) {
    if (!_expertBets[expert.id]) _expertBets[expert.id] = new Set();
    var uc = await vpWindow.getUserCreated();
    var market = pickMarket(expert, _expertBets[expert.id], uc);
    if (!market) return;
    _expertBets[expert.id].add(market.id);
    var side = expertSide(expert, market.secret.resolutionBias);
    await mirrorBetToUser(market, side, expert.id);
  }

  // ── Schedule each expert ───────────────────────────────────────────────────
  function scheduleExpert(expert) {
    if (_expertTimers[expert.id]) return;
    var jitter = (Math.random() - 0.5) * expert.freqMs * 0.3;
    var delay  = expert.freqMs + jitter;
    _expertTimers[expert.id] = setTimeout(function () {
      _expertTimers[expert.id] = null;
      expertTick(expert).then(function () { scheduleExpert(expert); });
    }, delay);
  }

  // ── Load active markets + secrets ──────────────────────────────────────────
  async function loadActiveMarkets() {
    try {
      var mSnap = await db.collection('markets').where('status', '==', 'active').get();
      if (mSnap.empty) { _activeMarkets = []; return; }

      var secretFetches = mSnap.docs.map(function(d) {
        return db.collection('marketSecrets').doc(d.id).get().catch(function(){ return null; });
      });
      var secrets = await Promise.all(secretFetches);

      _activeMarkets = mSnap.docs.map(function(d, i) {
        var data   = d.data();
        var secret = secrets[i] && secrets[i].exists ? secrets[i].data() : null;
        return {
          id:                  d.id,
          category:            data.category || '',
          createdAt:           data.createdAt || null,
          showAfterDays:       data.showAfterDays || 0,
          startingProbability: data.startingProbability || 50,
          resolutionDays:      typeof data.resolutionDays === 'number' ? data.resolutionDays : null,
          resolutionDate:      data.resolutionDate || null,
          secret:              secret
        };
      }).filter(function(m) { return !!m.secret; });

      console.log('[copy-betting] loaded', _activeMarkets.length, 'active markets with secrets');
    } catch(e) {
      console.warn('[copy-betting] loadActiveMarkets failed:', e.message);
    }
  }

  // Refresh market list every 30 minutes (markets rarely change)
  function scheduleMarketRefresh() {
    setTimeout(function() {
      loadActiveMarkets().then(scheduleMarketRefresh);
    }, 30 * 60 * 1000);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.copyBettingEngine = {

    start: async function () {
      if (_started) return;
      _started = true;
      await loadActiveMarkets();
      EXPERTS.forEach(function(e) { scheduleExpert(e); });
      scheduleMarketRefresh();
      console.log('[copy-betting] engine started with', EXPERTS.length, 'experts');
    },

    stop: function () {
      Object.keys(_expertTimers).forEach(function(id) {
        clearTimeout(_expertTimers[id]);
        delete _expertTimers[id];
      });
      _started = false;
      console.log('[copy-betting] stopped');
    },

    getExperts: function () { return EXPERTS.slice(); },

    /**
     * Call when user starts following an expert — immediately places them
     * into all open markets the expert hasn't bet on yet.
     */
    invalidate: function () { _cb = null; },

    userStartCopying: async function (uid, expertId) {
      _cb = null;   // force a fresh read of the user's follow state
      var expert = EXPERTS.find(function(e) { return e.id === expertId; });
      if (!expert) return;
      if (!_expertBets[expertId]) _expertBets[expertId] = new Set();

      var uc = await vpWindow.getUserCreated();
      var catchUp = _activeMarkets.filter(function(m) {
        return !_expertBets[expertId].has(m.id) && m.secret && vpWindow.isVisible(uc, m);
      });

      for (var i = 0; i < catchUp.length; i++) {
        var market = catchUp[i];
        _expertBets[expertId].add(market.id);
        var side = expertSide(expert, market.secret.resolutionBias);
        await mirrorBetToUser(market, side, expertId);
      }
      console.log('[copy-betting] catch-up placed', catchUp.length, 'bet(s) for', uid);
    },

    refresh: async function () {
      await loadActiveMarkets();
    }
  };

})();
