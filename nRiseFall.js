/**
 * DERIV HEDGED BOT v3.1 - FIXED
 * - Fixed syntax errors, websocket drops, and impossible hedge logic
 * - Now trades BOTH single-direction AND hedges
 * - Uses weighted confluence scoring + D'Alembert
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: 'rgNedekYXvCaPeP', // 
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    
    INITIAL_CAPITAL: 250,
    BASE_STAKE: 3.75,
    RISK_PERCENT: 1.5,
    
    ACTIVE_ASSETS: ['R_10', 'R_25', 'R_50'], 
    
    HEDGE_MIN_SCORE: 3,  // FIXED: lowered from 4
    HEDGE_MAX_DIFF: 1,   // FIXED: tighter diff
    MIN_SCORE_TO_TRADE: 5, // FIXED: lowered from 6
    
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
};

// ============================================
// LOGGER - FIXED
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';
const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// STATE & HISTORY
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
                LOGGER.info(`📂 Loaded history: ${tradeHistory.overall.tradesCount} trades, ${tradeHistory.overall.hedges} hedges`);
            }
        } catch (e) { LOGGER.error(`History load failed: ${e.message}`); }
    }
    
    static saveHistory() {
        try {
            tradeHistory.lastUpdated = Date.now();
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
        } catch (e) { LOGGER.error(`History save failed: ${e.message}`); }
    }
    
    static ensureDay(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = { 
                date: dateKey, tradesCount: 0, winsCount: 0, lossesCount: 0, 
                profit: 0, loss: 0, netPL: 0, hedges: 0,
                startCapital: state.capital, endCapital: state.capital
            };
        }
    }
    
    static recordTrade(symbol, profit, isHedge = false) {
        const dateKey = this.getDateKey();
        this.ensureDay(dateKey);
        
        const day = tradeHistory.dailyHistory[dateKey];
        const overall = tradeHistory.overall;
        
        if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
        overall.lastTradeDate = dateKey;
        
        day.tradesCount++; overall.tradesCount++;
        day.endCapital = state.capital;
        
        if (isHedge) { day.hedges++; overall.hedges++; }
        
        if (profit > 0) {
            day.winsCount++; overall.winsCount++;
            day.profit += profit; overall.profit += profit;
        } else if (profit < 0) {
            day.lossesCount++; overall.lossesCount++;
            day.loss += Math.abs(profit); overall.loss += Math.abs(profit);
        }
        day.netPL += profit; overall.netPL += profit;
        
        this.saveHistory();
    }
    
    static getToday() {
        this.ensureDay(this.getDateKey());
        return tradeHistory.dailyHistory[this.getDateKey()];
    }
    
    static getOverall() { return tradeHistory.overall; }
}

// ============================================
// TELEGRAM SERVICE
// ============================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            
            return new Promise((resolve) => {
                const req = https.request(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                }, res => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 200)); });
                req.on('error', () => resolve(false));
                req.write(data); req.end();
            });
        } catch (e) { LOGGER.error(`Telegram failed: ${e.message}`); }
    }
    
    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverall();
        const msg = `
🤖 <b>HEDGED BOT v3.1 STARTED</b>
Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}
Base Stake: $${CONFIG.BASE_STAKE}
Strategy: Confluence + Hedging (FIXED)

📊 <b>Historical:</b>
Total Trades: ${overall.tradesCount}
Total Hedges: ${overall.hedges}
Overall P/L: $${overall.netPL.toFixed(2)}
Win Rate: ${overall.tradesCount > 0 ? ((overall.winsCount/overall.tradesCount)*100).toFixed(1) : 0}%
        `.trim();
        await this.sendMessage(msg);
    }
}

// ============================================
// SCORER - COMPLETELY REWRITTEN
// ============================================
class ConfluenceScorer {
    static calculateScore(candles) {
        if (candles.length < 30) return { rise: 0, fall: 0, rsi: 0, trend: 'NONE' };
        
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
        
        // TREND (weight 4)
        if (ema5 > ema20 && ema20 > ema50) rise += 4;
        else if (ema5 < ema20 && ema20 < ema50) fall += 4;
        else if (ema5 > ema20) rise += 2;
        else if (ema5 < ema20) fall += 2;
        
        // RSI (weight 3)
        if (rsi < 30) rise += 3;
        else if (rsi < 40) rise += 2;
        else if (rsi > 70) fall += 3;
        else if (rsi > 60) fall += 2;
        else if (rsi >= 45 && rsi <= 55) { rise += 1; fall += 1; } // Neutral zone - good for hedge
        
        // Bollinger Bands (weight 3)
        if (current <= bb.lower) rise += 3;
        else if (current < bb.middle * 0.998) rise += 1;
        
        if (current >= bb.upper) fall += 3;
        else if (current > bb.middle * 1.002) fall += 1;
        
        // BB Squeeze - HIGH UNCERTAINTY = HEDGE OPPORTUNITY
        if (bbWidth < 0.15) { rise += 2; fall += 2; } // Both get points in squeeze
        else if (bbWidth < 0.3) { rise += 1; fall += 1; }
        
        // Volatility
        if (atr > 0.0008) { rise += 1; fall += 1; }
        
        return { 
            rise: Math.min(10, rise), 
            fall: Math.min(10, fall), 
            rsi: rsi.toFixed(1), 
            trend: ema5 > ema20 ? 'BULL' : 'BEAR',
            bbWidth: bbWidth.toFixed(3)
        };
    }
    
    static RSI(c,p){let g=0,l=0;for(let i=c.length-p+1;i<c.length;i++){const ch=c[i]-c[i-1];if(ch>0)g+=ch;else l-=ch;}const avgG=g/p;const avgL=l/p||0.0001;const rs=avgG/avgL;return 100-(100/(1+rs));}
    static BB(c,p,s){const sl=c.slice(-p);const sma=sl.reduce((a,b)=>a+b)/p;const v=sl.reduce((a,b)=>a+Math.pow(b-sma,2),0)/p;const sd=Math.sqrt(v);return{middle:sma,upper:sma+s*sd,lower:sma-s*sd};}
    static EMA(c,p){const k=2/(p+1);let e=c.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<c.length;i++)e=c[i]*k+e*(1-k);return e;}
    static ATR(h,l,c,p){let trs=[];for(let i=1;i<c.length;i++){trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}return trs.slice(-p).reduce((a,b)=>a+b)/p;}
}

// ============================================
// STATE
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
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() },
};

CONFIG.ACTIVE_ASSETS.forEach(s => state.assets[s] = { closedCandles: [], lastTradeTime: 0 });

// ============================================
// BOT - FIXED
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
            // FIXED: Add ping to prevent disconnects
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.send({ ping: 1 });
                }
            }, 30000);
        });
        
        this.ws.on('message', d => this.onMessage(JSON.parse(d)));
        
        this.ws.on('close', () => {
            LOGGER.warn('Connection closed, reconnecting...');
            clearInterval(this.pingInterval);
            setTimeout(() => this.connect(), 5000);
        });
        
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
            LOGGER.error(`API Error: ${res.error.message}`);
            return;
        }
        
        if (res.msg_type === 'authorize') {
            state.capital = res.authorize.balance;
            LOGGER.info(`🔐 Authorized | $${state.capital}`);
            TelegramService.sendStartupMessage();
            CONFIG.ACTIVE_ASSETS.forEach(s => this.subscribe(s));
        }
        
        if (res.msg_type === 'candles') {
            const sym = res.echo_req.ticks_history;
            state.assets[sym].closedCandles = res.candles.map(c => ({ 
                open: +c.open, close: +c.close, high: +c.high, low: +c.low, epoch: +c.epoch 
            }));
            LOGGER.info(`📈 ${sym} loaded ${res.candles.length} candles`);
        }
        
        if (res.msg_type === 'ohlc') this.onCandle(res.ohlc);
        
        if (res.msg_type === 'buy' && !res.error) {
            const pending = this.pendingTrades.get(res.echo_req.req_id);
            if (pending) {
                state.activeHedges.set(res.buy.contract_id, { ...pending, contractId: res.buy.contract_id });
                this.send({ proposal_open_contract: 1, contract_id: res.buy.contract_id, subscribe: 1 });
                this.pendingTrades.delete(res.echo_req.req_id);
            }
        }
        
        if (res.msg_type === 'proposal_open_contract') {
            const c = res.proposal_open_contract;
            if (c.is_sold) { // FIXED: was c.is_sold broken
                const h = state.activeHedges.get(c.contract_id);
                if (!h) return;
                
                const profit = c.profit;
                state.capital += profit; 
                state.dailyPL += profit; 
                state.tradesToday++;
                state.hourlyStats.trades++; 
                state.hourlyStats.pnl += profit;
                
                if (profit > 0) { 
                    state.hourlyStats.wins++; 
                    state.dalembertLevel = Math.max(0, state.dalembertLevel-1); 
                    state.consecutiveLosses = 0; 
                } else { 
                    state.hourlyStats.losses++; 
                    state.dalembertLevel = Math.min(CONFIG.MAX_DALEMBERT_STEPS, state.dalembertLevel+1); 
                    state.consecutiveLosses++; 
                }
                
                LOGGER.trade(`[${h.symbol}] ${h.direction} ${profit>=0?'WIN':'LOSS'} $${profit.toFixed(2)} | Score R${h.score.rise}/F${h.score.fall}`);
                TradeHistoryManager.recordTrade(h.symbol, profit, h.isHedge);
                
                state.activeHedges.delete(c.contract_id);
                
                if (state.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                    state.isPaused = true;
                    LOGGER.warn('⏸️ Paused after 3 losses');
                    TelegramService.sendMessage('⏸️ <b>PAUSED</b> - 3 consecutive losses');
                    setTimeout(() => { state.isPaused = false; state.consecutiveLosses = 0; LOGGER.info('▶️ Resumed'); }, 900000);
                }
            }
        }
    }
    
    subscribe(s) {
        this.send({ ticks_history: s, count: CONFIG.CANDLES_TO_LOAD, end: 'latest', style: 'candles', granularity: CONFIG.GRANULARITY });
        this.send({ ticks_history: s, subscribe: 1, style: 'candles', granularity: CONFIG.GRANULARITY });
    }
    
    onCandle(ohlc) {
        const asset = state.assets[ohlc.symbol];
        asset.closedCandles.push({ 
            open: +ohlc.open, close: +ohlc.close, high: +ohlc.high, low: +ohlc.low, epoch: +ohlc.epoch 
        });
        if (asset.closedCandles.length > 200) asset.closedCandles.shift();
        
        if (state.isPaused || state.activeHedges.size >= 6) return;
        if (Date.now() - asset.lastTradeTime < 30000) return; // 30s cooldown per asset
        
        const score = ConfluenceScorer.calculateScore(asset.closedCandles);
        LOGGER.debug(`[${ohlc.symbol}] R:${score.rise} F:${score.fall} | RSI:${score.rsi} ${score.trend} BBw:${score.bbWidth}%`);
        
        // FIXED LOGIC
        const shouldHedge = score.rise >= CONFIG.HEDGE_MIN_SCORE && score.fall >= CONFIG.HEDGE_MIN_SCORE && Math.abs(score.rise - score.fall) <= CONFIG.HEDGE_MAX_DIFF;
        const shouldRise = score.rise >= CONFIG.MIN_SCORE_TO_TRADE && score.rise > score.fall + 2;
        const shouldFall = score.fall >= CONFIG.MIN_SCORE_TO_TRADE && score.fall > score.rise + 2;
        
        if (shouldHedge) {
            asset.lastTradeTime = Date.now();
            this.executeHedge(ohlc.symbol, score);
        } else if (shouldRise) {
            asset.lastTradeTime = Date.now();
            this.executeSingle(ohlc.symbol, 'CALL', score);
        } else if (shouldFall) {
            asset.lastTradeTime = Date.now();
            this.executeSingle(ohlc.symbol, 'PUT', score);
        }
    }
    
    getStake() { 
        const riskStake = state.capital * (CONFIG.RISK_PERCENT / 100);
        const dalembertStake = CONFIG.BASE_STAKE + (state.dalembertLevel * CONFIG.DALEMBERT_UNIT);
        return Math.min(dalembertStake, riskStake, state.capital * 0.05); // Max 5% capital
    }
    
    executeSingle(symbol, direction, score) {
        const stake = this.getStake();
        LOGGER.trade(`🚀 [${symbol}] ${direction} R:${score.rise} F:${score.fall} | $${stake.toFixed(2)}`);
        
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
        this.pendingTrades.set(req_id, { symbol, direction, stake, score, isHedge: false });
    }
    
    executeHedge(symbol, score) {
        const stake = this.getStake() * 0.6; // 60% each side
        LOGGER.trade(`⚖️ [${symbol}] HEDGE R:${score.rise} F:${score.fall} | $${stake.toFixed(2)} each`);
        
        const callReq = this.send({ 
            buy: 1, price: stake.toFixed(2), 
            parameters: { contract_type: 'CALL', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD' }
        });
        this.pendingTrades.set(callReq, { symbol, direction: 'CALL', stake, score, isHedge: true });
        
        setTimeout(() => {
            const putReq = this.send({ 
                buy: 1, price: stake.toFixed(2), 
                parameters: { contract_type: 'PUT', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD' }
            });
            this.pendingTrades.set(putReq, { symbol, direction: 'PUT', stake, score, isHedge: true });
        }, 300);
    }
}

// START
console.log('\n' + '='.repeat(70));
console.log(' HEDGED BOT v3.1 - FIXED');
console.log('='.repeat(70) + '\n');

new HedgedBot();

setInterval(() => {
    LOGGER.info(`📊 Capital:$${state.capital.toFixed(2)} Daily:$${state.dailyPL.toFixed(2)} Trades:${state.tradesToday} Active:${state.activeHedges.size}`);
}, 60000);