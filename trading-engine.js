// ============================================================
// PredictIQ — Trading Engine
// Shared logic for Forex/Commodity/Crypto trading (trade.html).
// Ported from NexTrade's firebase-config.js — instrument data,
// live price feeds, PnL calculation and market-hours handling.
// Assumes firebase-config.js (db, auth) is already loaded.
// ============================================================

// ============================================================
// TRADING INSTRUMENTS
// ============================================================
var INSTRUMENTS = {
  forex: [
    { symbol: 'EUR/USD', name: 'Euro / US Dollar',              pip: 0.0001, defaultPrice: 1.0842 },
    { symbol: 'GBP/USD', name: 'British Pound / US Dollar',     pip: 0.0001, defaultPrice: 1.2674 },
    { symbol: 'USD/JPY', name: 'US Dollar / Japanese Yen',      pip: 0.01,   defaultPrice: 149.82 },
    { symbol: 'USD/CHF', name: 'US Dollar / Swiss Franc',       pip: 0.0001, defaultPrice: 0.9012 },
    { symbol: 'AUD/USD', name: 'Australian Dollar / US Dollar', pip: 0.0001, defaultPrice: 0.6521 },
    { symbol: 'USD/CAD', name: 'US Dollar / Canadian Dollar',   pip: 0.0001, defaultPrice: 1.3612 },
    { symbol: 'EUR/GBP', name: 'Euro / British Pound',          pip: 0.0001, defaultPrice: 0.8556 },
    { symbol: 'NZD/USD', name: 'New Zealand Dollar / USD',      pip: 0.0001, defaultPrice: 0.6018 },
  ],
  commodities: [
    { symbol: 'XAU/USD', name: 'Gold / US Dollar',     pip: 0.01,  defaultPrice: 2345.00 },
    { symbol: 'XAG/USD', name: 'Silver / US Dollar',   pip: 0.001, defaultPrice: 27.85   },
    { symbol: 'WTI/USD', name: 'Crude Oil (WTI)',      pip: 0.01,  defaultPrice: 78.40   },
    { symbol: 'NGAS/USD', name: 'Natural Gas',         pip: 0.001, defaultPrice: 2.145   },
    { symbol: 'XPT/USD', name: 'Platinum / US Dollar', pip: 0.01,  defaultPrice: 965.00  },
  ],
  crypto: [
    { symbol: 'BTC/USD', name: 'Bitcoin / US Dollar',    pip: 1,      defaultPrice: 67420  },
    { symbol: 'ETH/USD', name: 'Ethereum / US Dollar',   pip: 0.1,    defaultPrice: 3512   },
    { symbol: 'BNB/USD', name: 'BNB / US Dollar',        pip: 0.01,   defaultPrice: 398.50 },
    { symbol: 'SOL/USD', name: 'Solana / US Dollar',     pip: 0.01,   defaultPrice: 142.30 },
    { symbol: 'XRP/USD', name: 'Ripple / US Dollar',     pip: 0.0001, defaultPrice: 0.5842 },
    { symbol: 'ADA/USD', name: 'Cardano / US Dollar',    pip: 0.0001, defaultPrice: 0.4521 },
    { symbol: 'AVAX/USD', name: 'Avalanche / US Dollar', pip: 0.01,   defaultPrice: 38.20  },
  ]
};

var ALL_INSTRUMENTS = INSTRUMENTS.forex.concat(INSTRUMENTS.commodities, INSTRUMENTS.crypto);

function getInstrument(symbol) {
  return ALL_INSTRUMENTS.find(function(i) { return i.symbol === symbol; }) || null;
}

// ============================================================
// LIVE PRICE FETCHING
// Crypto     : CoinGecko    — direct to browser,     every 60 seconds (real)
// Forex      : Frankfurter  — Firestore cache + SIM, seed every 24h, sim every 10s
// Commodities: GoldAPI.io   — Firestore cache + SIM, seed hourly,   sim every 10s
// One user fetches and saves to Firestore; all others read from Firestore.
// Simulation engine creates realistic trending price movement between fetches.
// ============================================================

var COMMODITY_TTL = 60 * 60 * 1000;   // 1 hour   — commodity fetch interval
var SIM_TICK      = 10 * 1000;        // 10 sec   — simulation tick speed
var GOLD_API_KEY  = 'goldapi-a879adf4012e64507e836cb34c6bf9d2-io';

var CRYPTO_SYMBOLS = {
  'BTC/USD':  'bitcoin',
  'ETH/USD':  'ethereum',
  'BNB/USD':  'binancecoin',
  'SOL/USD':  'solana',
  'XRP/USD':  'ripple',
  'ADA/USD':  'cardano',
  'AVAX/USD': 'avalanche-2'
};

// ── SIMULATION ENGINE ──
// Each instrument has a hidden daily bias and trend personality.
// Prices drift in a direction, then reverse — like real markets.
var _simState = {};

var SIM_RANGES = {
  'EUR/USD': 0.0070, 'GBP/USD': 0.0090, 'USD/JPY': 0.65,
  'USD/CHF': 0.0065, 'AUD/USD': 0.0060, 'USD/CAD': 0.0065,
  'EUR/GBP': 0.0055, 'NZD/USD': 0.0050,
  'XAU/USD': 18.0,   'XAG/USD': 0.45,   'WTI/USD': 1.80,
  'NGAS/USD': 0.08,  'XPT/USD': 14.0
};

function _getSimSeed(symbol, dayOffset) {
  var d = new Date();
  var doy = Math.floor((d - new Date(d.getFullYear(),0,0)) / 86400000) + (dayOffset||0);
  var idx = Object.keys(SIM_RANGES).indexOf(symbol) + 1;
  return ((doy * 2971 + idx * 6791) % 9973) / 9973;
}

function _initSimState(symbol, basePrice) {
  if (_simState[symbol] && _simState[symbol].base === basePrice) return;
  var seed  = _getSimSeed(symbol, 0);
  var seed2 = _getSimSeed(symbol, 1);
  var range = SIM_RANGES[symbol] || 0.001;
  var rawBias = Math.sin(seed * Math.PI * 3.7) * Math.cos(seed2 * Math.PI * 2.3);
  var bias = rawBias * 0.6;
  var trendDuration = Math.floor(8 + seed * 16 + seed2 * 8);
  var tickSize = range / 30 * (1 + Math.abs(bias));
  _simState[symbol] = {
    base: basePrice, current: basePrice, bias: bias, tickSize: tickSize, range: range,
    trendDir: bias >= 0 ? 1 : -1, trendCount: 0, trendDuration: trendDuration,
    high: basePrice, low: basePrice, floor: basePrice - range, ceiling: basePrice + range,
    seed: seed
  };
}

function _tickSimPrice(symbol) {
  var s = _simState[symbol];
  if (!s) return null;
  s.trendCount++;
  if (s.trendCount >= s.trendDuration) {
    s.trendDir *= -1;
    s.trendDuration = Math.floor(6 + s.seed * 18 + Math.random() * 8);
    s.trendCount = 0;
  }
  var noise = (Math.random() - 0.5) * s.tickSize * 0.4;
  var move  = s.trendDir * s.tickSize * (0.6 + Math.random() * 0.4) + noise;
  move += s.bias * s.tickSize * 0.15;
  var newPrice = s.current + move;
  if (newPrice > s.ceiling) { newPrice = s.ceiling; s.trendDir = -1; s.trendCount = 0; }
  if (newPrice < s.floor)   { newPrice = s.floor;   s.trendDir =  1; s.trendCount = 0; }
  s.current = newPrice;
  if (newPrice > s.high) s.high = newPrice;
  if (newPrice < s.low)  s.low  = newPrice;
  var dec = symbol.includes('JPY') ? 3
          : (symbol === 'XAU/USD' || symbol === 'WTI/USD' || symbol === 'XPT/USD') ? 2
          : (symbol === 'XAG/USD' || symbol === 'NGAS/USD') ? 3 : 5;
  return parseFloat(newPrice.toFixed(dec));
}

// ── CRYPTO: direct CoinGecko, every 60s (no simulation) ──
async function fetchCryptoPrices(pricesObj) {
  try {
    var ids = Object.values(CRYPTO_SYMBOLS).join(',');
    var r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd&_=' + Date.now());
    if (!r.ok) return;
    var data = await r.json();
    Object.keys(CRYPTO_SYMBOLS).forEach(function(sym) {
      var id = CRYPTO_SYMBOLS[sym];
      if (data[id] && data[id].usd) pricesObj[sym] = parseFloat(data[id].usd);
    });
  } catch(e) { console.error('CoinGecko fetch error:', e); }
}

// ── FOREX: Frankfurter seed + simulation ──
async function loadForexPrices(pricesObj) {
  try {
    var now  = Date.now();
    var snap = await db.collection('forexPrices').doc('latest').get();
    if (snap.exists) {
      var saved = snap.data();
      var forexSyms = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','EUR/GBP','NZD/USD'];
      forexSyms.forEach(function(sym) {
        if (!saved[sym]) return;
        var startPrice = saved['sim_' + sym.replace('/', '_')] || saved[sym];
        delete _simState[sym];
        _initSimState(sym, startPrice);
        pricesObj[sym] = startPrice;
      });
      var baseAge = now - (saved.baseUpdatedAt || 0);
      if (baseAge < 24 * 60 * 60 * 1000) return;
    }
    var r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY,CHF,AUD,CAD,NZD&_=' + now);
    if (!r.ok) return;
    var data = await r.json();
    if (!data.rates) return;
    var rates  = data.rates;
    var toSave = { baseUpdatedAt: now, updatedAt: now };
    if (rates.EUR) toSave['EUR/USD'] = parseFloat((1 / rates.EUR).toFixed(5));
    if (rates.GBP) toSave['GBP/USD'] = parseFloat((1 / rates.GBP).toFixed(5));
    if (rates.JPY) toSave['USD/JPY'] = parseFloat(rates.JPY.toFixed(3));
    if (rates.CHF) toSave['USD/CHF'] = parseFloat(rates.CHF.toFixed(5));
    if (rates.AUD) toSave['AUD/USD'] = parseFloat((1 / rates.AUD).toFixed(5));
    if (rates.CAD) toSave['USD/CAD'] = parseFloat(rates.CAD.toFixed(5));
    if (rates.EUR && rates.GBP) toSave['EUR/GBP'] = parseFloat((rates.GBP / rates.EUR).toFixed(5));
    if (rates.NZD) toSave['NZD/USD'] = parseFloat((1 / rates.NZD).toFixed(5));
    await db.collection('forexPrices').doc('latest').set(toSave);
    Object.keys(toSave).forEach(function(k) {
      if (k !== 'updatedAt' && k !== 'baseUpdatedAt') {
        delete _simState[k];
        _initSimState(k, toSave[k]);
        pricesObj[k] = toSave[k];
      }
    });
  } catch(e) { console.error('Forex price error:', e); }
}

// ── COMMODITIES: GoldAPI.io seed + simulation ──
async function loadCommodityPrices(pricesObj) {
  var staticSeeds = { 'WTI/USD': 78.50, 'NGAS/USD': 2.10, 'XPT/USD': 965.00 };
  try {
    var now  = Date.now();
    var snap = await db.collection('commodityPrices').doc('latest').get();
    if (snap.exists) {
      var saved = snap.data();
      Object.keys(staticSeeds).forEach(function(sym) {
        var startPrice = saved['sim_' + sym.replace('/', '_')] || staticSeeds[sym];
        delete _simState[sym];
        _initSimState(sym, startPrice);
        pricesObj[sym] = startPrice;
      });
      var goldStart   = saved['sim_XAU_USD'] || saved['XAU/USD'];
      var silverStart = saved['sim_XAG_USD'] || saved['XAG/USD'];
      if (goldStart)   { delete _simState['XAU/USD']; _initSimState('XAU/USD', goldStart);   pricesObj['XAU/USD'] = goldStart; }
      if (silverStart) { delete _simState['XAG/USD']; _initSimState('XAG/USD', silverStart); pricesObj['XAG/USD'] = silverStart; }
      var baseAge = now - (saved.baseUpdatedAt || 0);
      if (baseAge < COMMODITY_TTL) return;
    } else {
      Object.keys(staticSeeds).forEach(function(sym) {
        _initSimState(sym, staticSeeds[sym]);
        pricesObj[sym] = staticSeeds[sym];
      });
    }
    var rGold = await fetch('https://www.goldapi.io/api/XAU/USD', { headers: { 'x-access-token': GOLD_API_KEY, 'Content-Type': 'application/json' } });
    if (rGold.ok) {
      var gData = await rGold.json();
      if (gData.price) {
        delete _simState['XAU/USD'];
        _initSimState('XAU/USD', parseFloat(gData.price));
        pricesObj['XAU/USD'] = _simState['XAU/USD'].current;
      }
    }
    var rSilver = await fetch('https://www.goldapi.io/api/XAG/USD', { headers: { 'x-access-token': GOLD_API_KEY, 'Content-Type': 'application/json' } });
    if (rSilver.ok) {
      var sData = await rSilver.json();
      if (sData.price) {
        delete _simState['XAG/USD'];
        _initSimState('XAG/USD', parseFloat(sData.price));
        pricesObj['XAG/USD'] = _simState['XAG/USD'].current;
      }
    }
    var toSave = { baseUpdatedAt: now, updatedAt: now };
    if (pricesObj['XAU/USD']) toSave['XAU/USD'] = _simState['XAU/USD'] ? _simState['XAU/USD'].base : pricesObj['XAU/USD'];
    if (pricesObj['XAG/USD']) toSave['XAG/USD'] = _simState['XAG/USD'] ? _simState['XAG/USD'].base : pricesObj['XAG/USD'];
    await db.collection('commodityPrices').doc('latest').set(toSave);
  } catch(e) { console.error('Commodity price error:', e); }
}

// ── MAIN LOADER ──
async function loadLivePrices(pricesObj) {
  ALL_INSTRUMENTS.forEach(function(i) {
    if (!pricesObj[i.symbol]) pricesObj[i.symbol] = i.defaultPrice;
  });
  await Promise.all([
    fetchCryptoPrices(pricesObj),
    loadForexPrices(pricesObj),
    loadCommodityPrices(pricesObj)
  ]);
}

// ============================================================
// MARKET HOURS
// Forex/Commodity market: Sunday 10pm UTC open, Friday 10pm UTC close.
// Crypto trades 24/7 regardless.
// ============================================================
function isMarketOpen() {
  var now     = new Date();
  var utcDay  = now.getUTCDay();
  var utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  var closeMins = 22 * 60;
  if (utcDay === 6) return false;
  if (utcDay === 0) return utcMins >= closeMins;
  if (utcDay === 5) return utcMins < closeMins;
  return true;
}

var FX_COMMODITY_SYMBOLS = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','EUR/GBP','NZD/USD','XAU/USD','XAG/USD','WTI/USD','NGAS/USD','XPT/USD'];

function isCryptoSymbol(symbol) {
  return INSTRUMENTS.crypto.some(function(i) { return i.symbol === symbol; });
}

// ── START PRICE REFRESH ──
function startPriceRefresh(pricesObj, onUpdate) {
  loadLivePrices(pricesObj).then(function() { if (onUpdate) onUpdate(); });

  // Crypto: real data every 60s — no market hours
  setInterval(function() {
    fetchCryptoPrices(pricesObj).then(function() { if (onUpdate) onUpdate(); });
  }, 60000);

  // Forex seed refresh every 24 hours — only when market open
  setInterval(function() {
    if (isMarketOpen()) loadForexPrices(pricesObj);
  }, 24 * 60 * 60 * 1000);

  // Commodity seed refresh every hour — only when market open
  setInterval(function() {
    if (isMarketOpen()) loadCommodityPrices(pricesObj).then(function() { if (onUpdate) onUpdate(); });
  }, COMMODITY_TTL);

  // Simulation tick every 10s — pauses on weekends/after hours
  var _saveTimer = null;
  setInterval(function() {
    if (!isMarketOpen()) return;
    var simSymbols = Object.keys(SIM_RANGES);
    var changed = false;
    var forexUpdate  = { updatedAt: Date.now() };
    var commodUpdate = { updatedAt: Date.now() };
    var forexSyms  = ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','EUR/GBP','NZD/USD'];
    var commodSyms = ['XAU/USD','XAG/USD','WTI/USD','NGAS/USD','XPT/USD'];
    simSymbols.forEach(function(sym) {
      if (_simState[sym]) {
        var newPrice = _tickSimPrice(sym);
        if (newPrice) {
          pricesObj[sym] = newPrice;
          changed = true;
          if (forexSyms.indexOf(sym) !== -1)  forexUpdate['sim_' + sym.replace('/', '_')] = newPrice;
          if (commodSyms.indexOf(sym) !== -1) commodUpdate['sim_' + sym.replace('/', '_')] = newPrice;
        }
      }
    });
    if (changed) {
      if (onUpdate) onUpdate();
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(function() {
        db.collection('forexPrices').doc('latest').update(forexUpdate).catch(function(){});
        db.collection('commodityPrices').doc('latest').update(commodUpdate).catch(function(){});
      }, 500);
    }
  }, SIM_TICK);

  // ── MARKET CLOSE WATCHER ──
  // Checks every minute for the Friday 10pm UTC transition.
  // Closes all open Forex/Commodity trades (crypto stays open).
  var _marketWasOpen = isMarketOpen();
  var _closingForMarket = false;
  setInterval(function() {
    var nowOpen = isMarketOpen();
    if (_marketWasOpen && !nowOpen && !_closingForMarket) {
      _closingForMarket = true;
      closeAllTradesForMarketClose().then(function() { _closingForMarket = false; });
    }
    _marketWasOpen = nowOpen;
  }, 60000);
}

// Close all open Forex + Commodity trades at market close (crypto unaffected).
// Balance updates flow into the single shared users/{uid}.balance field.
async function closeAllTradesForMarketClose() {
  try {
    var user = auth.currentUser;
    if (!user) return;
    var snap = await db.collection('trades')
      .where('userId', '==', user.uid)
      .where('status', '==', 'open').get();
    if (snap.empty) return;
    var closedCount = 0;
    var totalPnL    = 0;
    for (var i = 0; i < snap.docs.length; i++) {
      var doc = snap.docs[i];
      var t   = doc.data();
      if (FX_COMMODITY_SYMBOLS.indexOf(t.symbol) === -1) continue; // skip crypto
      var exitPrice = _simState[t.symbol] ? _simState[t.symbol].current : t.entryPrice;
      var pnl = calcPnL(t, exitPrice);
      await db.collection('trades').doc(doc.id).update({
        status: 'closed', exitPrice: exitPrice, profitLoss: pnl,
        closedAt: firebase.firestore.FieldValue.serverTimestamp(), closedBy: 'market_close'
      });
      totalPnL += pnl;
      closedCount++;
    }
    if (closedCount > 0) {
      var userSnap = await db.collection('users').doc(user.uid).get();
      var newBal   = (userSnap.data().balance || 0) + totalPnL;
      await db.collection('users').doc(user.uid).update({ balance: newBal });
      if (typeof showToast === 'function') {
        var pnlStr = (totalPnL >= 0 ? '+' : '') + '$' + Math.abs(totalPnL).toFixed(2);
        showToast('Market closed — ' + closedCount + ' position' + (closedCount > 1 ? 's' : '') + ' closed. P&L: ' + pnlStr, totalPnL >= 0 ? 'success' : 'error');
      }
    }
  } catch(e) { console.error('Market close error:', e); }
}

// ============================================================
// TRADE P&L CALCULATION
// ============================================================
function calcPnL(trade, currentPrice) {
  if (!currentPrice || !trade.entryPrice) return 0;
  var multiplier = trade.symbol.includes('JPY') ? 100 : 10000;
  var cryptoSymbols = ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'BNB/USD', 'ADA/USD', 'AVAX/USD'];
  var commoditySymbols = ['XAU/USD', 'XAG/USD', 'WTI/USD', 'NGAS/USD', 'XPT/USD'];
  var isCrypto = cryptoSymbols.includes(trade.symbol);
  var isCommodity = commoditySymbols.includes(trade.symbol);
  var mult = (isCrypto || isCommodity) ? 1 : multiplier;
  var priceDiff = trade.type === 'BUY'
    ? currentPrice - trade.entryPrice
    : trade.entryPrice - currentPrice;
  return parseFloat((priceDiff * trade.lotSize * mult).toFixed(2));
}

// ============================================================
// PRICE FORMATTING
// ============================================================
function fmtPrice(price, symbol) {
  var inst = getInstrument(symbol);
  if (!inst) return parseFloat(price).toFixed(4);
  if (symbol === 'BTC/USD') return parseFloat(price).toFixed(2);
  if (['ETH/USD', 'SOL/USD', 'BNB/USD', 'AVAX/USD'].includes(symbol)) return parseFloat(price).toFixed(2);
  if (['XRP/USD', 'ADA/USD'].includes(symbol)) return parseFloat(price).toFixed(4);
  if (symbol.includes('JPY')) return parseFloat(price).toFixed(3);
  if (['XAU/USD', 'XPT/USD', 'WTI/USD'].includes(symbol)) return '$' + parseFloat(price).toFixed(2);
  if (['XAG/USD', 'NGAS/USD'].includes(symbol)) return '$' + parseFloat(price).toFixed(3);
  return parseFloat(price).toFixed(4);
}
