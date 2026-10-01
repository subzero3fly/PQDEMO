/**
 * settlement-engine.js — VectorProb per-user settlement
 *
 * Runs in the signed-in user's browser. It does NOT poll. Reads are spent only:
 *   - on a page load, at most once per 10 min (remembered in localStorage)
 *   - when a tab becomes visible again (same 10 min throttle)
 *   - when the soonest known close date arrives (in-memory timer, zero reads)
 * Each sweep = 2 queries (positions, copyPositions) + 1 read per open position.
 * Each settlement is a Firestore transaction, so two tabs can't double-pay.
 *
 * Fallback for positions without resolveAt:
 *   max(user signup, market creation) + resolutionDays
 *
 * Usage: just include <script src="settlement-engine.js"></script> after
 * firebase-config.js. It starts itself. Also exposes:
 *   settlementEngine.start() / stop() / runNow()
 * Fires window event 'settlement:done' ({detail:{count}}) after a sweep that
 * settled something.
 */
(function () {

  var FEE      = 0.02;     // 2% platform fee on winnings (same as old resolve)
  var MIN_GAP  = 10 * 60 * 1000;   // min time between sweeps that hit Firestore

  var _uid = null, _dueTimer = null, _running = false, _userCreated = null, _nextDue = null;
  var _markets = {}, _bias = {};

  function toDate(v) {
    if (!v) return null;
    return v.toDate ? v.toDate() : new Date(v);
  }

  async function getMarket(id) {
    if (_markets[id]) return _markets[id];
    try {
      var s = await db.collection('markets').doc(id).get();
      if (s.exists) { _markets[id] = s.data(); return _markets[id]; }
    } catch (e) {}
    return null;
  }

  async function getBias(id) {
    if (_bias[id]) return _bias[id];
    try {
      var s = await db.collection('marketSecrets').doc(id).get();
      if (s.exists && s.data().resolutionBias) {
        _bias[id] = s.data().resolutionBias;
        return _bias[id];
      }
    } catch (e) {}
    return null;
  }

  async function getUserCreated() {
    if (_userCreated) return _userCreated;
    try {
      var us = await db.collection('users').doc(_uid).get();
      if (us.exists) _userCreated = toDate(us.data().createdAt);
    } catch (e) {}
    return _userCreated;
  }

  // New positions carry resolveAt, so this costs no extra reads for them.
  async function resolveAtFor(pos) {
    var at = toDate(pos.resolveAt);
    if (at) return at;
    var market = await getMarket(pos.marketId);
    if (!market) return null;
    await getUserCreated();
    if (typeof market.resolutionDays === 'number') {
      var mc = toDate(market.createdAt);
      var base = null;
      [_userCreated, mc].forEach(function (d) {
        if (d && (!base || d > base)) base = d;
      });
      if (base) return new Date(base.getTime() + ((market.showAfterDays || 0) + market.resolutionDays) * 86400000);
    }
    return toDate(market.resolutionDate); // legacy fixed-date markets
  }

  // Settle one position inside a transaction. Returns true if it settled here.
  async function settleOne(col, id, bias) {
    var ref     = db.collection(col).doc(id);
    var userRef = db.collection('users').doc(_uid);
    return db.runTransaction(async function (tx) {
      var snap = await tx.get(ref);
      if (!snap.exists) return false;
      var d = snap.data();
      if (d.status !== 'open') return false;          // another tab got it first

      var ts = firebase.firestore.FieldValue.serverTimestamp();
      if (d.side === bias) {
        var gross = d.stake / ((d.entryProbability || 50) / 100);
        var fee   = Math.round(gross * FEE * 100) / 100;
        var net   = Math.round((gross - fee) * 100) / 100;
        tx.update(ref, { status: 'won', payoutAmount: net, feeAmount: fee, settledAt: ts });
        tx.update(userRef, { balance: firebase.firestore.FieldValue.increment(net) });
        tx.set(db.collection('transactions').doc(), {
          userId: _uid, type: 'payout', amount: net, relatedId: id, createdAt: ts });
        tx.set(db.collection('transactions').doc(), {
          userId: _uid, type: 'fee', amount: -fee, relatedId: id, createdAt: ts });
      } else {
        tx.update(ref, { status: 'lost', payoutAmount: 0, feeAmount: 0, settledAt: ts });
      }
      return true;
    });
  }

  var LS = function () { return 'vp_settle_' + _uid; };

  function schedule() {
    if (_dueTimer) clearTimeout(_dueTimer);
    _dueTimer = null;
    if (_nextDue == null) return;
    var delay = Math.max(1000, _nextDue - Date.now() + 1000);
    _dueTimer = setTimeout(function () { sweep(true); }, Math.min(delay, 2147000000));
  }

  async function sweep(force) {
    if (_running || !_uid) return;

    // Throttle: skip Firestore entirely if we swept recently and nothing is due yet.
    if (!force) {
      try {
        var st = JSON.parse(localStorage.getItem(LS()) || 'null');
        if (st && Date.now() - st.last < MIN_GAP && (st.next == null || Date.now() < st.next)) {
          _nextDue = st.next; schedule(); return;
        }
      } catch (e) {}
    }

    _running = true;
    var settled = 0, next = null;
    try {
      var cols  = ['positions', 'copyPositions'];
      var snaps = await Promise.all(cols.map(function (c) {
        return db.collection(c).where('userId', '==', _uid).where('status', '==', 'open').get();
      }));
      var now = Date.now();

      for (var i = 0; i < cols.length; i++) {
        for (var j = 0; j < snaps[i].docs.length; j++) {
          var doc = snaps[i].docs[j], d = doc.data();
          var at = await resolveAtFor(d);
          if (!at) continue;
          if (at.getTime() > now) { if (next == null || at.getTime() < next) next = at.getTime(); continue; }
          var bias = await getBias(d.marketId);
          if (!bias) continue;
          try {
            if (await settleOne(cols[i], doc.id, bias)) settled++;
          } catch (e) {
            console.warn('[settlement] failed for', doc.id, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[settlement] sweep failed:', e.message);
    }
    _running = false;
    _nextDue = next;
    try { localStorage.setItem(LS(), JSON.stringify({ last: Date.now(), next: next })); } catch (e) {}
    schedule();
    if (settled) {
      console.log('[settlement] settled', settled, 'position(s)');
      window.dispatchEvent(new CustomEvent('settlement:done', { detail: { count: settled } }));
    }
  }

  function start(user) {
    if (!user) { stop(); return; }
    if (_uid === user.uid) return;
    _uid = user.uid; _userCreated = null;
    sweep(false);
  }
  function stop() {
    if (_dueTimer) clearTimeout(_dueTimer);
    _dueTimer = null; _uid = null; _userCreated = null; _nextDue = null;
  }

  // Coming back to a tab: catch up, but only if the throttle allows.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) sweep(false);
  });

  window.settlementEngine = {
    start:  function () { start(auth.currentUser); },
    stop:   stop,
    runNow: function () { return sweep(true); }
  };

  auth.onAuthStateChanged(start);   // self-start on every page

})();
