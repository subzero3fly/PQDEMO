/**
 * copy-trading-engine.js — VectorProb Copy Trading Engine
 *
 * Ten expert traders with hidden personalities, Forex and Commodities only
 * (never Crypto — those prices are real and unpredictable). Each trader
 * fires on a per-trader timer, in pairs of up to 2 trades at a time, with
 * an interval between pairs derived from the FOLLOWING USER's own
 * copyMaxTrades setting (per-user config, set in admin.html's Copy Trading
 * Config tab — separate from Copy Betting's config). Re-read fresh on every
 * tick so admin changes take effect on the user's very next trade.
 * Users follow ONE trader at a time. Trades write to the same `trades`
 * collection as manual trading for the current signed-in user only — no
 * cross-user reads, respecting Firestore security rules. TP/SL closing and
 * stop-out are handled by trading-engine.js's existing checkTpSl/checkStopOut,
 * since copy trades are indistinguishable from manual ones once opened.
 *
 * Requires trading-engine.js to be loaded first (isMarketOpen, calcPnL,
 * _simState, loadLivePrices, startPriceRefresh).
 *
 * Usage:
 *   copyTradingEngine.start()
 *   copyTradingEngine.stop()
 *   copyTradingEngine.getTraders()
 *   copyTradingEngine.userStartCopying(uid, traderId)
 */

(function () {

  // ── Trader profiles — ported from NexTrade's COPY_TRADERS, Forex/Commodity only ──
  var TRADERS = [
    { id:'trader_marcus',   name:'Marcus Elliot',     style:'Trend Following', wr:0.87, bias:{ 'EUR/USD':0.6, 'GBP/USD':0.5, 'USD/JPY':0.4 }, isAI:false },
    { id:'trader_lena',     name:'Lena Hartmann',     style:'Swing Trading',   wr:0.84, bias:{ 'EUR/GBP':0.6, 'USD/CHF':0.5, 'NZD/USD':0.4 }, isAI:false },
    { id:'trader_rafael',   name:'Rafael Torres',     style:'Breakout',        wr:0.76, bias:{ 'XAU/USD':0.7, 'WTI/USD':0.6, 'XAG/USD':0.5 }, isAI:false },
    { id:'trader_kirk',     name:'Kirk Bonde',        style:'Trend Following', wr:0.91, bias:{ 'EUR/USD':0.7, 'USD/CHF':0.6, 'EUR/GBP':0.5 }, isAI:false },
    { id:'trader_isabelle', name:'Isabelle Fontaine', style:'Conservative',    wr:0.93, bias:{ 'EUR/USD':0.8, 'EUR/GBP':0.7, 'USD/CHF':0.6 }, isAI:false },
    { id:'trader_nexus',    name:'Nexus',             style:'Algorithmic',     wr:0.90, bias:{ 'EUR/USD':0.3, 'GBP/USD':0.3, 'USD/JPY':0.3, 'AUD/USD':0.3, 'USD/CAD':0.3, 'XAU/USD':0.3, 'XAG/USD':0.3, 'WTI/USD':0.3 }, isAI:true }
  ];

  // SL distances tuned for a few minutes of simulated movement — Forex/Commodity only.
  var SL_DIST = {
    'EUR/USD': 0.00187, 'GBP/USD': 0.00240, 'USD/JPY': 0.173,
    'USD/CHF': 0.00173, 'AUD/USD': 0.00160, 'USD/CAD': 0.00173,
    'EUR/GBP': 0.00147, 'NZD/USD': 0.00133,
    'XAU/USD': 4.8,     'XAG/USD': 0.12,    'WTI/USD': 0.48,
    'NGAS/USD': 0.0213, 'XPT/USD': 3.73
  };
  var COMMODITY_SYMS = ['XAU/USD','XAG/USD','WTI/USD','NGAS/USD','XPT/USD'];

  // ── State ─────────────────────────────────────────────────────────────────
  var _traderTimers = {};   // { traderId: timerHandle }
  var _started       = false;
  var _prices         = {};
  var DEFAULT_DELAY   = 60000 + Math.random() * 60000; // fallback when no one's actively following

  function todayUTC() {
    var d = new Date();
    return d.getUTCFullYear()+'-'+(d.getUTCMonth()+1)+'-'+d.getUTCDate();
  }

  // ── Fire a single trade for the current user, using their own config ───────
  async function mirrorTradeToUser(trader, riskPct, rrRatio) {
    var currentUser = auth.currentUser;
    if (!currentUser) return false;
    try {
      var uSnap = await db.collection('users').doc(currentUser.uid).get();
      if (!uSnap.exists) return false;
      var balance = uSnap.data().balance || 0;
      if (balance <= 0) return false;

      // Open positions: never stack a copy trade on a symbol that already has one,
      // and never open against any open position the user already holds there.
      var openSnap = await db.collection('trades')
        .where('userId', '==', currentUser.uid).where('status', '==', 'open').get();
      var openBySym = {};
      openSnap.forEach(function(d) { var t = d.data(); (openBySym[t.symbol] = openBySym[t.symbol] || []).push(t); });

      function dirFor(sym) {
        var sm = window._simState ? window._simState[sym] : null;
        return (!sm || sm.trendDir > 0) ? 'BUY' : 'SELL';
      }

      // Pick instrument by weighted bias, from the symbols that are free
      var instruments = Object.keys(trader.bias).filter(function(sym) {
        if (!_prices[sym]) return false;
        var d = dirFor(sym);
        return (openBySym[sym] || []).every(function(t) { return !t.isCopyTrade && t.type === d; });
      });
      if (!instruments.length) return false;   // nothing safe to open this tick

      var weights     = instruments.map(function(s) { return trader.bias[s]; });
      var totalWeight = weights.reduce(function(a,b){ return a+b; }, 0);
      var rand = Math.random() * totalWeight;
      var chosen = instruments[0];
      for (var i = 0; i < weights.length; i++) {
        rand -= weights[i];
        if (rand <= 0) { chosen = instruments[i]; break; }
      }
      var entryPrice = _prices[chosen];
      if (!entryPrice) return false;

      var tradeType = dirFor(chosen);

      // The trader's stated win rate decides the outcome up front: this trade will
      // close at its take-profit (win) or stop-loss (loss) after a short random delay.
      var plannedOutcome = Math.random() < trader.wr ? 'tp' : 'sl';
      var closeAtMs      = Date.now() + Math.floor(90000 + Math.random() * 270000);   // 1.5–6 min

      var isCommodity = COMMODITY_SYMS.indexOf(chosen) !== -1;
      var slDist = SL_DIST[chosen] || 0.0010;
      var tpDist = slDist * rrRatio;
      var targetLoss = balance * (riskPct / 100);
      var multiplier = chosen.indexOf('JPY') !== -1 ? 100 : isCommodity ? 1 : 10000;
      var lotSize = parseFloat((targetLoss / (slDist * multiplier)).toFixed(4));
      if (!lotSize || lotSize <= 0) lotSize = 0.01;

      var tp = tradeType === 'BUY' ? entryPrice + tpDist : entryPrice - tpDist;
      var sl = tradeType === 'BUY' ? entryPrice - slDist : entryPrice + slDist;

      await db.collection('trades').add({
        userId:       currentUser.uid,
        symbol:       chosen,
        type:         tradeType,
        lotSize:      lotSize,
        entryPrice:   entryPrice,
        takeProfit:   parseFloat(tp.toFixed(5)),
        stopLoss:     parseFloat(sl.toFixed(5)),
        status:       'open',
        profitLoss:   0,
        openedAt:     firebase.firestore.FieldValue.serverTimestamp(),
        closedAt:     null,
        exitPrice:    null,
        closedBy:     null,
        isCopyTrade:  true,
        traderId:     trader.id,
        plannedOutcome: plannedOutcome,
        closeAt:      firebase.firestore.Timestamp.fromMillis(closeAtMs)
      });
      await db.collection('copyTrading').doc(currentUser.uid).update({
        tradesToday:   firebase.firestore.FieldValue.increment(1),
        lastResetDate: todayUTC()
      });
      console.log('[copy-trading] mirrored', tradeType, chosen, 'for', currentUser.uid, 'via', trader.name);
      return true;
    } catch(e) {
      console.warn('[copy-trading] mirrorTradeToUser failed:', e.message);
      return false;
    }
  }

  // ── Cached copyTrading doc (per user) ───────────────────────────────────────
  var _ct = null;   // { uid, data, at }
  async function getCT(uid) {
    if (_ct && _ct.uid === uid && Date.now() - _ct.at < 5 * 60 * 1000) return _ct.data;
    var snap = await db.collection('copyTrading').doc(uid).get();
    _ct = { uid: uid, data: snap.exists ? snap.data() : null, at: Date.now() };
    return _ct.data;
  }

  // ── Trader tick — checks the current user's own per-user config fresh each
  // time (mirrors NexTrade's "re-read in case admin changed it" pattern), fires
  // a pair if there's headroom, and returns the delay to use for the next tick. ──
  async function traderTick(trader) {
    var currentUser = auth.currentUser;
    if (!currentUser) return null; // nobody signed in — use default delay

    try {
      // Cached 5 min: idle ticks (not following this trader) cost zero reads
      var ct = await getCT(currentUser.uid);
      if (!ct || ct.status !== 'active' || ct.traderId !== trader.id) {
        return null; // not following this trader — use default delay
      }
      var today = todayUTC();
      if (ct.lastResetDate !== today) {
        await db.collection('copyTrading').doc(currentUser.uid).update({ tradesToday: 0, lastResetDate: today });
        ct.tradesToday = 0; ct.lastResetDate = today; _ct = null;
      }

      var uSnap = await db.collection('users').doc(currentUser.uid).get();
      var ud = uSnap.exists ? uSnap.data() : {};
      var maxTrades = typeof ud.copyMaxTrades === 'number' ? ud.copyMaxTrades : 5;
      var riskPct   = typeof ud.copyRisk      === 'number' ? ud.copyRisk      : 10;
      var rrRatio   = typeof ud.copyRR        === 'number' ? ud.copyRR        : 1;

      var pairInterval = Math.floor((24 * 60 * 60 * 1000) / Math.ceil(maxTrades / 2));
      var remaining = maxTrades - (ct.tradesToday || 0);

      if (remaining > 0 && isMarketOpen()) {
        var toFire = Math.min(2, remaining);
        for (var i = 0; i < toFire; i++) {
          await mirrorTradeToUser(trader, riskPct, rrRatio);
        }
        _ct = null;   // tradesToday changed — re-read next tick
      }

      var jitter = (Math.random() - 0.5) * pairInterval * 0.4;
      return Math.max(pairInterval + jitter, 60000);
    } catch(e) {
      console.warn('[copy-trading] traderTick error:', e.message);
      return null;
    }
  }

  // ── Schedule each trader's clock ─────────────────────────────────────────────
  function scheduleTrader(trader, delay) {
    if (_traderTimers[trader.id]) return;
    _traderTimers[trader.id] = setTimeout(function () {
      _traderTimers[trader.id] = null;
      traderTick(trader).then(function (nextDelay) {
        scheduleTrader(trader, nextDelay || DEFAULT_DELAY);
      });
    }, delay || DEFAULT_DELAY);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.copyTradingEngine = {

    invalidate: function () { _ct = null; },

    start: async function () {
      if (_started) return;
      _started = true;
      await loadLivePrices(_prices);
      startPriceRefresh(_prices, function(){});
      TRADERS.forEach(function(t) { scheduleTrader(t); });
      console.log('[copy-trading] engine started with', TRADERS.length, 'traders');
    },

    stop: function () {
      Object.keys(_traderTimers).forEach(function(id) {
        clearTimeout(_traderTimers[id]);
        delete _traderTimers[id];
      });
      _started = false;
      console.log('[copy-trading] stopped');
    },

    getTraders: function () { return TRADERS.map(function(t){ return { id:t.id, name:t.name, style:t.style, isAI:!!t.isAI }; }); },

    /**
     * Call when user starts following a trader — fires one immediate pair
     * so the account doesn't sit idle until the next scheduled tick.
     */
    userStartCopying: async function (uid, traderId) {
      _ct = null;
      var trader = TRADERS.find(function(t) { return t.id === traderId; });
      if (!trader) return;
      await traderTick(trader);
    }
  };

})();
