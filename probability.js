/**
 * probability.js — VectorProb displayed-probability generator (zero Firestore usage)
 *
 * The displayed YES probability is a deterministic, bounded (20–80%) wandering
 * value computed from the market id and the clock. Every user's browser computes
 * the same number, so nothing is stored or read. It has NO relationship to the
 * hidden resolution bias — purely cosmetic.
 *
 *   vpProb.now(market)                → number (1 decimal)
 *   vpProb.at(market, ms)             → number at a given time
 *   vpProb.history(market, n, spanMs) → [{probability, t}] oldest → newest
 *   vpProb.apply(marketsArray)        → sets .currentProbability on each
 *
 * `market` needs: id, startingProbability, createdAt (Timestamp/Date/ms).
 */
(function () {
  var MIN = 20, MAX = 80, TICK_MS = 7000, ANCHOR_MS = 45 * 60000;

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rnd(seed) {                       // mulberry32, one shot → [0,1)
    var t = (seed + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function toMs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    return v.toDate ? v.toDate().getTime() : new Date(v).getTime();
  }

  var _cache = {};
  function params(id) {
    if (_cache[id]) return _cache[id];
    var h = hash(String(id));
    var p = {
      h:  h,
      p1: rnd(h + 1) * 6.283, p2: rnd(h + 2) * 6.283, p3: rnd(h + 3) * 6.283,
      T1: (5 + rnd(h + 4) * 3) * 3600000,      // ~5–8 h   slow swing
      T2: (40 + rnd(h + 5) * 30) * 60000,      // ~40–70 m medium swing
      T3: (6 + rnd(h + 6) * 6) * 60000         // ~6–12 m  short swing
    };
    return (_cache[id] = p);
  }

  // Smooth part: amplitudes 11 + 8 + 4 = 23 max around 50
  function smooth(p, t) {
    return 50 + 11 * Math.sin(6.283 * t / p.T1 + p.p1)
              +  8 * Math.sin(6.283 * t / p.T2 + p.p2)
              +  4 * Math.sin(6.283 * t / p.T3 + p.p3);
  }

  function at(market, ms) {
    var p     = params(market.id);
    var t0    = toMs(market.createdAt);
    var t     = Math.max(ms, t0);
    var start = Math.max(MIN, Math.min(MAX, market.startingProbability || 50));

    var v = smooth(p, t);
    // Begin at the admin's starting probability, easing into the swing
    if (t0) v += (start - smooth(p, t0)) * Math.exp(-(t - t0) / ANCHOR_MS);
    // Small per-tick jitter (±1.5) so it visibly moves every few seconds
    v += (rnd(p.h ^ Math.floor(t / TICK_MS)) * 2 - 1) * 1.5;

    return Math.round(Math.max(MIN, Math.min(MAX, v)) * 10) / 10;
  }

  // ── Market window: when a market appears for a user, and when it closes for them ──
  //   appears = max(user signup, market creation) + showAfterDays
  //   closes  = appears + resolutionDays
  var DAY = 86400000;
  function appearsMs(userCreated, market) {
    var base = Math.max(toMs(userCreated), toMs(market.createdAt));
    if (!base) return null;
    return base + (market.showAfterDays || 0) * DAY;
  }
  function getUserCreated() {            // signup date, cached so it costs 1 read ever
    return new Promise(function (resolve) {
      var done = false, un = null;
      un = auth.onAuthStateChanged(function (u) {
        if (done) return; done = true; if (un) un();
        if (!u) { resolve(null); return; }
        var key = 'vp_created_' + u.uid;
        try { var c = localStorage.getItem(key); if (c) { resolve(new Date(parseInt(c, 10))); return; } } catch (e) {}
        db.collection('users').doc(u.uid).get().then(function (s) {
          var ms = s.exists ? toMs(s.data().createdAt) : 0;
          if (ms) { try { localStorage.setItem(key, String(ms)); } catch (e) {} }
          resolve(ms ? new Date(ms) : null);
        }).catch(function () { resolve(null); });
      });
    });
  }
  window.vpWindow = {
    getUserCreated: getUserCreated,
    appearsAt: function (uc, m) { var t = appearsMs(uc, m); return t == null ? null : new Date(t); },
    isVisible: function (uc, m) {
      if (!m.showAfterDays) return true;            // immediate markets: always visible
      var t = appearsMs(uc, m);
      return t == null || t <= Date.now();
    },
    closeAt: function (uc, m) {
      if (typeof m.resolutionDays === 'number') {
        var t = appearsMs(uc, m);
        return t == null ? null : new Date(t + m.resolutionDays * DAY);
      }
      var legacy = toMs(m.resolutionDate);
      return legacy ? new Date(legacy) : null;
    }
  };

  window.vpProb = {
    now: function (m) { return at(m, Date.now()); },
    at:  at,
    history: function (m, n, spanMs) {
      var now = Date.now(), t0 = toMs(m.createdAt);
      var from = Math.max(t0 || 0, now - spanMs);
      if (now - from < 60000) from = now - 60000;
      var out = [];
      for (var i = 0; i < n; i++) {
        var t = from + (now - from) * i / (n - 1);
        out.push({ probability: at(m, t), t: t });
      }
      return out;
    },
    apply: function (list) {
      list.forEach(function (m) { m.currentProbability = at(m, Date.now()); });
      return list;
    }
  };
})();
