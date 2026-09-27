/**
 * copy-trading-engine.js — PredictIQ Copy Trading Engine
 *
 * Ten expert traders with hidden personalities, Forex and Commodities only
 * (never Crypto — those prices are real and unpredictable). Each trader
 * fires on a per-trader timer, in pairs of up to 2 trades at a time, with
 * an interval between pairs derived from the admin-configured daily cap.
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
    { id:'trader_marcus',   name:'Marcus Elliot',     style:'Trend Following', wr:0.87, bias:{ 'EUR/USD':0.6, 'GBP/USD':0.5, 'USD/JPY':0.4 } },
    { id:'trader_sophia',   name:'Sophia Chen',       style:'Mixed Strategy',  wr:0.82, bias:{ 'EUR/USD':0.5, 'XAU/USD':0.4, 'GBP/USD':0.3 } },
    { id:'trader_micheal',  name:'Micheal Robertson', style:'Scalping',        wr:0.79, bias:{ 'GBP/USD':0.7, 'USD/JPY':0.6, 'AUD/USD':0.4 } },
    { id:'trader_lena',     name:'Lena Hartmann',     style:'Swing Trading',   wr:0.84, bias:{ 'EUR/GBP':0.6, 'USD/CHF':0.5, 'NZD/USD':0.4 } },
    { id:'trader_rafael',   name:'Rafael Torres',     style:'Breakout',        wr:0.76, bias:{ 'XAU/USD':0.7, 'WTI/USD':0.6, 'XAG/USD':0.5 } },
    { id:'trader_kirk',     name:'Kirk Bonde',        style:'Trend Following', wr:0.91, bias:{ 'EUR/USD':0.7, 'USD/CHF':0.6, 'EUR/GBP':0.5 } },
    { id:'trader_dmitri',   name:'Dmitri Volkov',     style:'Algorithmic',     wr:0.88, bias:{ 'USD/JPY':0.7, 'USD/CAD':0.6, 'AUD/USD':0.5 } },
    { id:'trader_priya',    name:'Priya Nair',        style:'Commodities',     wr:0.80, bias:{ 'XAU/USD':0.8, 'XAG/USD':0.7, 'XPT/USD':0.5 } },
    { id:'trader_carlos',   name:'Carlos Mendez',     style:'News-Driven',     wr:0.74, bias:{ 'GBP/USD':0.6, 'WTI/USD':0.5, 'USD/CAD':0.4 } },
    { id:'trader_isabelle', name:'Isabelle Fontaine', style:'Conservative',    wr:0.93, bias:{ 'EUR/USD':0.8, 'EUR/GBP':0.7, 'USD/CHF':0.6 } }
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
  var _settings        = { maxTradesPerDay:6, riskPercent:10, rrRatio:1 }; // defaults, overridden by settings/copyTrading

  function todayUTC() {
    var d = new Date();
    return d.getUTCFullYear()+'-'+(d.getUTCMonth()+1)+'-'+d.getUTCDate();
  }

  // ── Load / refresh admin-configured settings ────────────────────────────────
  async function loadSettings() {
    try {
      var snap = await db.collection('settings').doc('copyTrading').get();
      if (snap.exists) {
        var d = snap.data();
        _settings = {
          maxTradesPerDay: typeof d.maxTradesPerDay === 'number' ? d.maxTradesPerDay : 6,
          riskPercent:     typeof d.riskPercent     === 'number' ? d.riskPercent     : 10,
          rrRatio:         typeof d.rrRatio         === 'number' ? d.rrRatio         : 1
        };
      }
    } catch(e) { console.warn('[copy-trading] loadSettings failed:', e.message); }
  }
  function scheduleSettingsRefresh() {
    setTimeout(function() { loadSettings().then(scheduleSettingsRefresh); }, 5 * 60 * 1000);
  }

  // ── Mirror a trade to the current signed-in user ────────────────────────────
  async function mirrorTradeToUser(trader) {
    var currentUser = auth.currentUser;
    if (!currentUser) return false;
    if (!isMarketOpen()) return false; // Forex/Commodity markets closed — never fire

    var today = todayUTC();
    try {
      var ctSnap = await db.collection('copyTrading').doc(currentUser.uid).get();
      if (!ctSnap.exists || ctSnap.data().status !== 'active') return false;
      if (ctSnap.data().traderId !== trader.id) return false; // following a different trader

      var ct = ctSnap.data();
      if (ct.lastResetDate !== today) {
        await db.collection('copyTrading').doc(currentUser.uid).update({ tradesToday: 0, lastResetDate: today });
        ct.tradesToday = 0;
      }
      if ((ct.tradesToday || 0) >= _settings.maxTradesPerDay) return false;

      var uSnap = await db.collection('users').doc(currentUser.uid).get();
      if (!uSnap.exists) return false;
      var balance = uSnap.data().balance || 0;
      if (balance <= 0) return false;

      // Pick instrument by weighted bias
      var instruments = Object.keys(trader.bias);
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

      // Direction: win rate determines how often we align with the live sim trend
      var sim = window._simState ? window._simState[chosen] : null;
      var trendDir = sim ? sim.trendDir : 1;
      var alignWithTrend = Math.random() < trader.wr;
      var tradeType = alignWithTrend ? (trendDir > 0 ? 'BUY' : 'SELL') : (trendDir > 0 ? 'SELL' : 'BUY');

      var isCommodity = COMMODITY_SYMS.indexOf(chosen) !== -1;
      var slDist = SL_DIST[chosen] || 0.0010;
      var tpDist = slDist * _settings.rrRatio;
      var targetLoss = balance * (_settings.riskPercent / 100);
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
        traderId:     trader.id
      });
      await db.collection('copyTrading').doc(currentUser.uid).update({
        tradesToday:   firebase.firestore.FieldValue.increment(1),
        lastResetDate: today
      });
      console.log('[copy-trading] mirrored', tradeType, chosen, 'for', currentUser.uid, 'via', trader.name);
      return true;
    } catch(e) {
      console.warn('[copy-trading] mirrorTradeToUser failed:', e.message);
      return false;
    }
  }

  // ── Trader tick — fires a pair (up to 2 trades) ─────────────────────────────
  async function traderTick(trader) {
    await mirrorTradeToUser(trader);
    await mirrorTradeToUser(trader);
  }

  // ── Schedule each trader's clock ─────────────────────────────────────────────
  function scheduleTrader(trader) {
    if (_traderTimers[trader.id]) return;
    var pairInterval = Math.floor((24 * 60 * 60 * 1000) / Math.ceil(_settings.maxTradesPerDay / 2));
    var jitter = (Math.random() - 0.5) * pairInterval * 0.4;
    var delay  = Math.max(pairInterval + jitter, 60000);
    _traderTimers[trader.id] = setTimeout(function () {
      _traderTimers[trader.id] = null;
      traderTick(trader).then(function () { scheduleTrader(trader); });
    }, delay);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.copyTradingEngine = {

    start: async function () {
      if (_started) return;
      _started = true;
      await loadSettings();
      await loadLivePrices(_prices);
      startPriceRefresh(_prices, function(){});
      TRADERS.forEach(function(t) { scheduleTrader(t); });
      scheduleSettingsRefresh();
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

    getTraders: function () { return TRADERS.map(function(t){ return { id:t.id, name:t.name, style:t.style }; }); },

    /**
     * Call when user starts following a trader — fires one immediate pair
     * so the account doesn't sit idle until the next scheduled tick.
     */
    userStartCopying: async function (uid, traderId) {
      var trader = TRADERS.find(function(t) { return t.id === traderId; });
      if (!trader) return;
      await traderTick(trader);
    }
  };

})();
