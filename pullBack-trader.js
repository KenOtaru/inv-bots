/**
 * Deriv Multiplier Bot - Trend Pullback (FVG + 50 EMA)
 * Strategy Source: Data Trader YouTube - Strategy #1
 */

const WebSocket = require('ws');

// ================= CONFIGURATION =================
const CONFIG = {
    APP_ID: 1089, // Replace with your Deriv App ID
    TOKEN: 'hsj0tA0XJoIzJG5', // Replace with your Token
    SYMBOL: 'R_75', // Volatility 75 Index
    GRANULARITY: 900, // 15 Minutes (The "sweet spot" [00:03:54])

    // Risk Management
    RISK_PERCENT: 0.20, // 20% risk per trade [00:02:14]
    RR_RATIO: 3,        // 1:3 Reward-to-Risk [00:01:16]

    // Indicator Settings
    EMA_PERIOD: 50
};

const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);

let candles = [];
let balance = 0;
let isTrading = false;

// ================= LOGGING =================
function log(message, type = 'INFO') {
    const time = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
    console.log(`[${time}] [${type}] ${message}`);
}

// ================= INDICATORS =================
function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema[ema.length - 1];
}

function findFVG(c1, c2, c3) {
    // Bullish FVG: Low of candle 3 is above high of candle 1
    if (c3.low > c1.high) {
        return { type: 'BULLISH', top: c3.low, bottom: c1.high };
    }
    // Bearish FVG: High of candle 3 is below low of candle 1
    if (c3.high < c1.low) {
        return { type: 'BEARISH', top: c1.low, bottom: c3.high };
    }
    return null;
}

// ================= WEBSOCKET HANDLERS =================
ws.on('open', () => {
    log('Connected to Deriv. Authorizing...');
    ws.send(JSON.stringify({ authorize: CONFIG.TOKEN }));
});

ws.on('message', (data) => {
    const msg = JSON.parse(data);

    if (msg.error) {
        log(msg.error.message, 'ERROR');
        return;
    }

    if (msg.msg_type === 'authorize') {
        balance = msg.authorize.balance;
        log(`Authorized. Balance: ${balance} ${msg.authorize.currency}`);
        subscribeCandles();
    }

    if (msg.msg_type === 'ohlc') {
        processUpdate(msg.ohlc);
    }

    if (msg.msg_type === 'buy') {
        log(`Trade opened! ID: ${msg.buy.contract_id}`, 'TRADE');
        isTrading = true;
    }
});

function subscribeCandles() {
    ws.send(JSON.stringify({
        ticks_history: CONFIG.SYMBOL,
        adjust_start_time: 1,
        count: 100,
        end: 'latest',
        granularity: CONFIG.GRANULARITY,
        style: 'candles',
        subscribe: 1
    }));
}

function processUpdate(ohlc) {
    const currentCandle = {
        time: ohlc.open_time,
        open: parseFloat(ohlc.open),
        high: parseFloat(ohlc.high),
        low: parseFloat(ohlc.low),
        close: parseFloat(ohlc.close)
    };

    // Update existing or push new
    if (candles.length > 0 && candles[candles.length - 1].time === currentCandle.time) {
        candles[candles.length - 1] = currentCandle;
    } else {
        candles.push(currentCandle);
        if (candles.length > 100) candles.shift();
        log(`New candle formed. Checking strategy...`, 'SYSTEM');
        checkStrategy();
    }
}

// ================= STRATEGY EXECUTION =================
function checkStrategy() {
    if (isTrading || candles.length < 50) return;

    const closes = candles.map(c => c.close);
    const ema50 = calculateEMA(closes, CONFIG.EMA_PERIOD);
    const last = candles[candles.length - 1];

    // Get the last 3 candles to find a fresh FVG
    const c1 = candles[candles.length - 4];
    const c2 = candles[candles.length - 3];
    const c3 = candles[candles.length - 2];
    const fvg = findFVG(c1, c2, c3);

    if (!fvg) return;

    // BULLISH SETUP: Price above EMA + Bullish FVG [00:04:34]
    if (last.close > ema50 && fvg.type === 'BULLISH') {
        // Entry when price pulls back into the gap [00:06:28]
        if (last.low <= fvg.top && last.low >= fvg.bottom) {
            log('Bullish Trend Pullback into FVG detected.', 'SIGNAL');
            executeTrade('MULTUP', fvg.bottom);
        }
    }

    // BEARISH SETUP: Price below EMA + Bearish FVG [00:07:15]
    else if (last.close < ema50 && fvg.type === 'BEARISH') {
        if (last.high >= fvg.bottom && last.high <= fvg.top) {
            log('Bearish Trend Pullback into FVG detected.', 'SIGNAL');
            executeTrade('MULTDOWN', fvg.top);
        }
    }
}

function executeTrade(type, stopLevel) {
    const stake = (balance * CONFIG.RISK_PERCENT).toFixed(2);
    const currentPrice = candles[candles.length - 1].close;

    // Calculate Stop Loss distance in USD for Multipliers
    const slDistance = Math.abs(currentPrice - stopLevel);
    const tpDistance = slDistance * CONFIG.RR_RATIO;

    log(`Placing ${type} trade. Stake: ${stake.toFixed(2)}`, 'EXECUTION');

    ws.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
            amount: stake,
            basis: 'stake',
            contract_type: type,
            currency: 'USD',
            multiplier: 100, // Fixed multiplier
            symbol: CONFIG.SYMBOL,
            limit_order: {
                stop_loss: slDistance,//Math.floor(stake * 0.8), // 80% of stake risk as buffer
                take_profit: tpDistance//Math.floor(stake * 2.4) // 1:3 ratio
            }
        }
    }));
}