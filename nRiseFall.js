/**
 * DERIV HEDGED BOT v3.3 - FIXED & OPTIMIZED
 * - Fixed API 'end' validation error
 * - Fixed OHLC subscription for live data
 * - Corrected history message type handling
 * - Cleaned syntax artifacts
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
const CONFIG = {
    API_TOKEN: 'rgNedekYXvCaPeP',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    
    INITIAL_CAPITAL: 250,
    BASE_STAKE: 3.75,
    RISK_PERCENT: 1.5,
    
    ACTIVE_ASSETS: ['R_10', 'R_25', 'R_50'],
    
    HEDGE_MIN_SCORE: 3,
    HEDGE_MAX_DIFF: 1,
    MIN_SCORE_TO_TRADE: 5,
    
    DALEMBERT_UNIT: 0.5,
    MAX_DALEMBERT_STEPS: 5,
    
    MAX_CONSECUTIVE_LOSSES: 3,
    DAILY_PROFIT_TARGET: 15,
    DAILY_STOP_LOSS: -20,
    
    GRANULARITY: 60,
    CANDLES_TO_LOAD: 100,
    DURATION: 5,
    DURATION_UNIT: 't',
    
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',
    
    DEBUG_MODE: true,
    ANALYSIS_LOGGING: true, 
};

// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';
const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    analysis: msg => { if (CONFIG.ANALYSIS_LOGGING) console.log(`\x1b[36m[ANALYSIS] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
const HISTORY_FILE = path.join(__dirname, 'HedgedBot-history.json');
let tradeHistory = {
    overall: { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, hedges: 0, firstTradeDate: null, lastTradeDate: null },
    dailyHistory: {},
    lastUpdated: Date.now()
};

class TradeHistoryManager {
    static getDateKey() { return new Date().toISOString().split('T')[0]; }
    static loadHistory() {
        try {
            if (fs.existsSync(HISTORY_FILE)) {
                tradeHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
                LOGGER.info(`📂 Loaded history: ${tradeHistory.overall.tradesCount} trades`);
            }
        } catch (e) { LOGGER.error(`History load failed: ${e.message}`); }
    }
    static saveHistory() {
        try {
            tradeHistory.lastUpdated = Date.now();
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
        } catch (e) { }
    }
    static recordTrade(symbol, profit, isHedge = false) {
        const dateKey = this.getDateKey();
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = { date: dateKey, tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, hedges: 0, startCapital: state.capital, endCapital: state.capital };
        }
        const day = tradeHistory.dailyHistory[dateKey];
        const overall = tradeHistory.overall;
        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;
        day.tradesCount++; overall.tradesCount++;
        day.endCapital = state.capital;
        if (isHedge) { day.hedges++; overall.hedges++; }
        if (profit > 0) { day.winsCount++; overall.winsCount++; day.profit += profit; overall.profit += profit; }
        else if (profit < 0) { day.lossesCount++; overall.lossesCount++; day.loss += Math.abs(profit); overall.loss += Math.abs(profit); }
        day.netPL += profit; overall.netPL += profit;
        this.saveHistory();
    }
}

// ============================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            return new Promise((resolve) => {
                const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
                    res => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
                req.on('error', () => resolve(false));
                req.write(data); req.end();
            });
        } catch (e) { }
    }
}

// ============================================
class ConfluenceScorer {
    static calculateScore(candles) {
        if (candles.length < 30) return { rise: 0, fall: 0, rsi: 0, trend: 'NONE', bbWidth: 0, details: 'Not enough candles' };
        
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const current = closes[closes.length - 1];
        
        const rsi = this.RSI(closes, 14);
        const bb = this.BB(closes, 20, 2);
        const ema5 = this.EMA(closes, 5);
        const ema20 = this.EMA(closes, 20);
        const ema50 = this.EMA(closes, 50);
        const atr = this.ATR(highs, lows, closes, 14);
        const bbWidth = (bb.upper - bb.lower) / bb.middle * 100;
        
        let rise = 0, fall = 0;
        let reasonsRise = [], reasonsFall = [];
        
        if (ema5 > ema20 && ema20 > ema50) { rise += 4; reasonsRise.push('Strong uptrend'); }
        else if (ema5 < ema20 && ema20 < ema50) { fall += 4; reasonsFall.push('Strong downtrend'); }
        else if (ema5 > ema20) { rise += 2; reasonsRise.push('EMA5>EMA20'); }
        else if (ema5 < ema20) { fall += 2; reasonsFall.push('EMA5<EMA20'); }
        
        if (rsi < 30) { rise += 3; reasonsRise.push(`RSI oversold ${rsi.toFixed(1)}`); }
        else if (rsi < 40) { rise += 2; reasonsRise.push(`RSI low ${rsi.toFixed(1)}`); }
        else if (rsi > 70) { fall += 3; reasonsFall.push(`RSI overbought ${rsi.toFixed(1)}`); }
        else if (rsi > 60) { fall += 2; reasonsFall.push(`RSI high ${rsi.toFixed(1)}`); }
        else if (rsi >= 45 && rsi <= 55) { rise += 1; fall += 1; reasonsRise.push('RSI neutral'); reasonsFall.push('RSI neutral'); }
        
        if (current <= bb.lower) { rise += 3; reasonsRise.push('Price at lower BB'); }
        else if (current < bb.middle) { rise += 1; reasonsRise.push('Below mid BB'); }
        if (current >= bb.upper) { fall += 3; reasonsFall.push('Price at upper BB'); }
        else if (current > bb.middle) { fall += 1; reasonsFall.push('Above mid BB'); }
        
        if (bbWidth < 0.15) { rise += 2; fall += 2; reasonsRise.push(`BB squeeze ${bbWidth.toFixed(3)}%`); reasonsFall.push(`BB squeeze`); }
        else if (bbWidth < 0.3) { rise += 1; fall += 1; }
        if (atr > 0.0008) { rise += 1; fall += 1; }
        
        return { 
            rise: Math.min(10, rise), 
            fall: Math.min(10, fall), 
            rsi: rsi.toFixed(1), 
            trend: ema5 > ema20 ? 'BULL' : 'BEAR',
            bbWidth: bbWidth.toFixed(3),
            price: current.toFixed(5),
            reasonsRise,
            reasonsFall
        };
    }
    
    static RSI(c,p){let g=0,l=0;for(let i=c.length-p+1;i<c.length;i++){const ch=c[i]-c[i-1];if(ch>0)g+=ch;else l-=ch;}const avgG=g/p;const avgL=l/p||0.0001;const rs=avgG/avgL;return 100-(100/(1+rs));}
    static BB(c,p,s){const sl=c.slice(-p);const sma=sl.reduce((a,b)=>a+b)/p;const v=sl.reduce((a,b)=>a+Math.pow(b-sma,2),0)/p;const sd=Math.sqrt(v);return{middle:sma,upper:sma+s*sd,lower:sma-s*sd};}
    static EMA(c,p){const k=2/(p+1);let e=c.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<c.length;i++)e=c[i]*k+e*(1-k);return e;}
    static ATR(h,l,c,p){let trs=[];for(let i=1;i<c.length;i++){trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}return trs.slice(-p).reduce((a,b)=>a+b)/p;}
}

// ============================================
const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    dailyPL: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    isPaused: false,
    dalembertLevel: 0,
    assets: {},
    activeHedges: new Map(),
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    candlesReceived: 0,
};
CONFIG.ACTIVE_ASSETS.forEach(s => state.assets[s] = { closedCandles: [], lastTradeTime: 0, lastAnalysis: null });

// ============================================
class HedgedBot {
    constructor() {
        this.ws = null;
        this.requestId = 1;
        this.pendingTrades = new Map();
        this.pingInterval = null;
        TradeHistoryManager.loadHistory();
        this.connect();
    }
    
    connect() {
        LOGGER.info('🔌 Connecting...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        
        this.ws.on('open', () => { 
            this.send({ authorize: CONFIG.API_TOKEN });
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 });
            }, 30000);
        });
        
        this.ws.on('message', d => this.onMessage(JSON.parse(d)));
        this.ws.on('close', () => { LOGGER.warn('Connection closed'); clearInterval(this.pingInterval); setTimeout(() => this.connect(), 5000); });
        this.ws.on('error', (e) => LOGGER.error(`WS Error: ${e.message}`));
    }
    
    send(data) { 
        if (this.ws.readyState !== WebSocket.OPEN) return 0;
        data.req_id = this.requestId++; 
        this.ws.send(JSON.stringify(data)); 
        return data.req_id; 
    }

    onMessage(res) {
        if (res.error) {
            LOGGER.error(`API Error [${res.msg_type}]: ${res.error.message} | Details: ${JSON.stringify(res.error)}`);
            return;
        }
        
        if (res.msg_type === 'authorize') {
            state.capital = res.authorize.balance;
            LOGGER.info(`🔐 Authorized | Balance: $${state.capital} | Currency: ${res.authorize.currency}`);
            LOGGER.info(`📡 Subscribing to ${CONFIG.ACTIVE_ASSETS.length} assets...`);
            CONFIG.ACTIVE_ASSETS.forEach(s => this.subscribe(s));
        }
        
        // This handles the INITIAL historical data load
        if (res.msg_type === 'history') {
            const sym = res.echo_req.ticks_history;
            state.assets[sym].closedCandles = res.candles.map(c => ({ 
                open: +c.open, close: +c.close, high: +c.high, low: +c.low, epoch: +c.epoch 
            }));
            LOGGER.info(`📈 ${sym} | Loaded ${res.candles.length} historical candles | Latest: ${state.assets[sym].closedCandles.slice(-1)[0].close}`);
        }
        
        // This handles the LIVE streaming candles (even when requested via ticks_history)
        if (res.msg_type === 'ohlc') {
            state.candlesReceived++;
            this.onCandle(res.ohlc);
        }
        
        // ... rest of the onMessage handler (buy, proposal_open_contract, etc.) stays the same ...
        if (res.msg_type === 'buy') {
            const pending = this.pendingTrades.get(res.echo_req.req_id);
            if (pending) {
                LOGGER.info(`✅ Order placed: ${pending.direction} ${pending.symbol} $${pending.stake} | Contract ID: ${res.buy.contract_id}`);
                state.activeHedges.set(res.buy.contract_id, { ...pending, contractId: res.buy.contract_id });
                this.send({ proposal_open_contract: 1, contract_id: res.buy.contract_id, subscribe: 1 });
                this.pendingTrades.delete(res.echo_req.req_id);
            }
        }
        
        if (res.msg_type === 'proposal_open_contract') {
            const c = res.proposal_open_contract;
            if (c.is_sold) {
                const h = state.activeHedges.get(c.contract_id);
                if (!h) return;
                const profit = c.profit;
                state.capital += profit; 
                state.dailyPL += profit; 
                state.tradesToday++;
                const result = profit >= 0 ? 'WIN' : 'LOSS';
                LOGGER.trade(`[${h.symbol}] ${h.direction} ${result} $${profit.toFixed(2)} | Entry:${h.entrySpot} Exit:${c.exit_tick} | Balance: $${state.capital.toFixed(2)}`);
                TradeHistoryManager.recordTrade(h.symbol, profit, h.isHedge);
                state.activeHedges.delete(c.contract_id);
                if (profit > 0) { 
                    state.dalembertLevel = Math.max(0, state.dalembertLevel-1); 
                    state.consecutiveLosses = 0; 
                } else { 
                    state.dalembertLevel = Math.min(CONFIG.MAX_DALEMBERT_STEPS, state.dalembertLevel+1); 
                    state.consecutiveLosses++; 
                }
            }
        }
        
        if (res.msg_type === 'ping') {
            LOGGER.debug('🏓 Pong received');
        }
    }
    
    subscribe(s) {
        LOGGER.info(`→ Subscribing ${s}...`);
        
        // 1. Request Historical Candles (Required to prime the indicators)
        this.send({ 
            ticks_history: s, 
            count: CONFIG.CANDLES_TO_LOAD, 
            end: 'latest', 
            style: 'candles', 
            granularity: CONFIG.GRANULARITY 
        });

        // 2. Request Live Candle Stream (Using the most compatible method)
        this.send({ 
            ticks_history: s, 
            subscribe: 1, 
            style: 'candles', 
            granularity: CONFIG.GRANULARITY 
        });
    }
    
    subscribe(s) {
        LOGGER.info(`→ Subscribing ${s}...`);
        
        // FIXED: Re-added 'end: latest' as required by API
        this.send({ 
            ticks_history: s, 
            count: CONFIG.CANDLES_TO_LOAD, 
            end: 'latest', 
            style: 'candles', 
            granularity: CONFIG.GRANULARITY 
        });

        // FIXED: Using 'ohlc' for live streaming instead of ticks_history subscribe
        this.send({ 
            ohlc: s, 
            subscribe: 1, 
            granularity: CONFIG.GRANULARITY 
        });
    }
    
    onCandle(ohlc) {
        const asset = state.assets[ohlc.symbol];
        const candle = { 
            open: +ohlc.open, close: +ohlc.close, high: +ohlc.high, low: +ohlc.low, epoch: +ohlc.epoch 
        };
        
        asset.closedCandles.push(candle);
        if (asset.closedCandles.length > 200) asset.closedCandles.shift();
        
        const score = ConfluenceScorer.calculateScore(asset.closedCandles);
        asset.lastAnalysis = score;
        
        LOGGER.analysis(`${ohlc.symbol} | Price:${score.price} | R:${score.rise} (${score.reasonsRise.join(', ') || 'none'}) | F:${score.fall} (${score.reasonsFall.join(', ') || 'none'}) | RSI:${score.rsi} ${score.trend} BBw:${score.bbWidth}%`);
        
        if (state.isPaused) {
            LOGGER.analysis(`⏸️ ${ohlc.symbol} SKIPPED - Bot paused (${state.consecutiveLosses} losses)`);
            return;
        }
        
        if (state.activeHedges.size >= 6) {
            LOGGER.analysis(`⏸️ ${ohlc.symbol} SKIPPED - Too many active trades (${state.activeHedges.size})`);
            return;
        }
        
        if (Date.now() - asset.lastTradeTime < 30000) {
            const wait = Math.ceil((30000 - (Date.now() - asset.lastTradeTime))/1000);
            LOGGER.analysis(`⏳ ${ohlc.symbol} SKIPPED - Cooldown ${wait}s`);
            return;
        }
        
        const shouldHedge = score.rise >= CONFIG.HEDGE_MIN_SCORE && score.fall >= CONFIG.HEDGE_MIN_SCORE && Math.abs(score.rise - score.fall) <= CONFIG.HEDGE_MAX_DIFF;
        const shouldRise = score.rise >= CONFIG.MIN_SCORE_TO_TRADE && score.rise > score.fall + 2;
        const shouldFall = score.fall >= CONFIG.MIN_SCORE_TO_TRADE && score.fall > score.rise + 2;
        
        if (shouldHedge) {
            LOGGER.analysis(`✅ ${ohlc.symbol} DECISION: HEDGE (Both strong, diff=${Math.abs(score.rise-score.fall)})`);
            asset.lastTradeTime = Date.now();
            this.executeHedge(ohlc.symbol, score, candle.close);
        } else if (shouldRise) {
            LOGGER.analysis(`✅ ${ohlc.symbol} DECISION: CALL (Rise dominant)`);
            asset.lastTradeTime = Date.now();
            this.executeSingle(ohlc.symbol, 'CALL', score, candle.close);
        } else if (shouldFall) {
            LOGGER.analysis(`✅ ${ohlc.symbol} DECISION: PUT (Fall dominant)`);
            asset.lastTradeTime = Date.now();
            this.executeSingle(ohlc.symbol, 'PUT', score, candle.close);
        } else {
            LOGGER.analysis(`❌ ${ohlc.symbol} NO TRADE - R:${score.rise}<${CONFIG.MIN_SCORE_TO_TRADE} and F:${score.fall}<${CONFIG.MIN_SCORE_TO_TRADE}, not hedging`);
        }
    }
    
    getStake() { 
        const riskStake = state.capital * (CONFIG.RISK_PERCENT / 100);
        const dalembertStake = CONFIG.BASE_STAKE + (state.dalembertLevel * CONFIG.DALEMBERT_UNIT);
        return Math.min(dalembertStake, riskStake, state.capital * 0.05);
    }
    
    executeSingle(symbol, direction, score, entryPrice) {
        const stake = this.getStake();
        LOGGER.trade(`🚀 EXECUTING ${direction} | ${symbol} | Stake:$${stake.toFixed(2)} | Price:${entryPrice} | R${score.rise}/F${score.fall}`);
        
        const req_id = this.send({ 
            buy: 1, 
            price: stake.toFixed(2), 
            parameters: { 
                contract_type: direction, 
                symbol, 
                duration: CONFIG.DURATION, 
                duration_unit: CONFIG.DURATION_UNIT, 
                basis: 'stake', 
                currency: 'USD' 
            }
        });
        this.pendingTrades.set(req_id, { symbol, direction, stake, score, isHedge: false, entrySpot: entryPrice });
    }
    
    executeHedge(symbol, score, entryPrice) {
        const stake = this.getStake() * 0.6;
        LOGGER.trade(`⚖️ EXECUTING HEDGE | ${symbol} | $${stake.toFixed(2)} each | Price:${entryPrice} | R${score.rise}/F${score.fall}`);
        
        const callReq = this.send({ 
            buy: 1, price: stake.toFixed(2), 
            parameters: { contract_type: 'CALL', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD' }
        });
        this.pendingTrades.set(callReq, { symbol, direction: 'CALL', stake, score, isHedge: true, entrySpot: entryPrice });
        
        setTimeout(() => {
            const putReq = this.send({ 
                buy: 1, price: stake.toFixed(2), 
                parameters: { contract_type: 'PUT', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD' }
            });
            this.pendingTrades.set(putReq, { symbol, direction: 'PUT', stake, score, isHedge: true, entrySpot: entryPrice });
        }, 300);
    }
}

// START
console.log('\n' + '='.repeat(70));
console.log(' HEDGED BOT v3.3 - FIXED & OPTIMIZED');
console.log('='.repeat(70) + '\n');
new HedgedBot();
setInterval(() => {
    const totalAnalyses = Object.values(state.assets).reduce((sum, a) => sum + (a.lastAnalysis ? 1 : 0), 0);
    LOGGER.info(`📊 Capital:$${state.capital.toFixed(2)} | Daily:$${state.dailyPL.toFixed(2)} | Trades:${state.tradesToday} | Active:${state.activeHedges.size} | Candles:${state.candlesReceived} | Analyses:${totalAnalyses}`);
    
    CONFIG.ACTIVE_ASSETS.forEach(sym => {
        const asset = state.assets[sym];
        if (asset.lastAnalysis) {
            const s = asset.lastAnalysis;
            LOGGER.info(`${sym}: R${s.rise}/F${s.fall} | ${s.trend} | RSI${s.rsi}`);
        }
    });
}, 60000);