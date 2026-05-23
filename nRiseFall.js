/**
 * DERIV HEDGED BOT v3
 * - Trades CALL and PUT simultaneously during high-uncertainty regimes
 * - Includes full logging and Telegram from reference bot
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
    API_TOKEN: 'rgNedekYXvCaPeP',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    
    INITIAL_CAPITAL: 250,
    BASE_STAKE: 3.75, // 1.5% risk
    RISK_PERCENT: 1.5,
    
    ACTIVE_ASSETS: ['R_10', 'R_25'], // Hedge across 2 low-vol assets
    
    // Hedging triggers
    HEDGE_MIN_SCORE: 4,
    HEDGE_MAX_DIFF: 2, // If rise and fall scores within 2 points, hedge
    
    // Directional trade
    MIN_SCORE_TO_TRADE: 6,
    
    // D'Alembert
    DALEMBERT_UNIT: 0.5,
    MAX_DALEMBERT_STEPS: 5,
    
    // Risk controls
    MAX_CONSECUTIVE_LOSSES: 3,
    DAILY_PROFIT_TARGET: 15,
    DAILY_STOP_LOSS: -20,
    
    // Technical
    GRANULARITY: 60,
    CANDLES_TO_LOAD: 100,
    DURATION: 5,
    DURATION_UNIT: 't',
    
    // Telegram
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',
    
    DEBUG_MODE: true,
};

// ============================================
// LOGGER (from reference bot)
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
// STATE PERSISTENCE (from reference)
// ============================================
const STATE_FILE = path.join(__dirname, 'HedgedBot-state.json');
const HISTORY_FILE = path.join(__dirname, 'HedgedBot-history.json');

let tradeHistory = {
    overall: { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, hedges: 0 },
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
        } catch (e) { LOGGER.error(`History save failed: ${e.message}`); }
    }
    
    static recordTrade(symbol, profit, isHedge = false) {
        const dateKey = this.getDateKey();
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, hedges: 0 };
        }
        
        const day = tradeHistory.dailyHistory[dateKey];
        const overall = tradeHistory.overall;
        
        day.tradesCount++; overall.tradesCount++;
        if (isHedge) { day.hedges++; overall.hedges++; }
        
        if (profit > 0) {
            day.winsCount++; overall.winsCount++;
            day.profit += profit; overall.profit += profit;
        } else {
            day.lossesCount++; overall.lossesCount++;
            day.loss += Math.abs(profit); overall.loss += Math.abs(profit);
        }
        day.netPL += profit; overall.netPL += profit;
        
        this.saveHistory();
    }
}

// ============================================
// TELEGRAM SERVICE (from reference, fixed)
// ============================================
class TelegramService {
    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const data = JSON.stringify({
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            });
            
            return new Promise((resolve) => {
                const req = https.request(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                }, res => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve(res.statusCode === 200));
                });
                req.on('error', () => resolve(false));
                req.write(data);
                req.end();
            });
        } catch (e) { LOGGER.error(`Telegram failed: ${e.message}`); }
    }
    
    static async sendTradeAlert(type, symbol, direction, stake, details = {}) {
        const emoji = type === 'HEDGE' ? '⚖️' : type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const hedgeTag = details.isHedge ? '[HEDGE] ' : '';
        
        const message = `
${emoji} <b>${hedgeTag}${type} TRADE</b>
Asset: ${symbol}
Direction: ${direction}
Stake: $${stake.toFixed(2)}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}` : ''}
${details.score ? `Score: R${details.score.rise}/F${details.score.fall}` : ''}
Capital: $${state.capital.toFixed(2)}
Daily P/L: $${state.dailyPL.toFixed(2)}
        `.trim();
        
        await this.sendMessage(message);
        LOGGER.info(`[TELEGRAM] ${type} alert sent for ${symbol}`);
    }
    
    static async sendStartupMessage() {
        const msg = `
🤖 <b>HEDGED BOT v3 STARTED</b>
Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}
Base Stake: $${CONFIG.BASE_STAKE}
Strategy: Confluence scoring + Hedging
Hedge Trigger: Both scores ≥${CONFIG.HEDGE_MIN_SCORE}
Risk: ${CONFIG.RISK_PERCENT}% per trade
        `.trim();
        await this.sendMessage(msg);
    }
}

// ============================================
// CONFLUENCE SCORER (from v2)
// ============================================
class ConfluenceScorer {
    static calculateScore(candles) {
        if (candles.length < 30) return { rise: 0, fall: 0 };
        
        const closes = candles.map(c => c.close);
        const current = closes[closes.length - 1];
        
        const rsi = this.RSI(closes, 14);
        const bb = this.BB(closes, 20, 2);
        const ema5 = this.EMA(closes, 5);
        const ema20 = this.EMA(closes, 20);
        const roc = ((current - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
        
        let rise = 0, fall = 0;
        
        // Fall signals
        if (rsi > 78) fall += 3; else if (rsi > 70) fall += 2;
        if (current >= bb.upper) fall += 3;
        if (roc < -0.02) fall += 2;
        
        // Rise signals
        if (ema5 > ema20) {
            rise += 4;
            if (rsi >= 60 && rsi < 79) rise += 2;
            if (current > bb.middle && current < bb.upper) rise += 2;
        }
        if (rsi < 22) rise += 3; else if (rsi < 30) rise += 2;
        if (current <= bb.lower) rise += 3;
        
        return { rise, fall, rsi: rsi.toFixed(1), trend: ema5 > ema20 ? 'BULL' : 'BEAR' };
    }
    
    static RSI(c, p) { let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const ch=c[i]-c[i-1]; if(ch>0)g+=ch;else l-=ch;} const rs=g/(l||1); return 100-(100/(1+rs)); }
    static BB(c,p,s){ const sl=c.slice(-p); const sma=sl.reduce((a,b)=>a+b)/p; const v=sl.reduce((a,b)=>a+Math.pow(b-sma,2),0)/p; const sd=Math.sqrt(v); return {middle:sma,upper:sma+s*sd,lower:sma-s*sd}; }
    static EMA(c,p){ const k=2/(p+1); let e=c[0]; for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k); return e; }
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
    activeHedges: new Map(), // contractId -> {symbol, pairId, direction}
};

CONFIG.ACTIVE_ASSETS.forEach(s => state.assets[s] = { candles: [], closedCandles: [] });

// ============================================
// HEDGED BOT
// ============================================
class HedgedBot {
    constructor() {
        this.ws = null;
        this.requestId = 1;
        TradeHistoryManager.loadHistory();
        this.connect();
    }
    
    connect() {
        LOGGER.info('🔌 Connecting to Deriv...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', d => this.onMessage(JSON.parse(d)));
        this.ws.on('close', () => { LOGGER.warn('Disconnected'); setTimeout(() => this.connect(), 5000); });
    }
    
    onOpen() {
        LOGGER.info('✅ Connected');
        this.send({ authorize: CONFIG.API_TOKEN });
    }
    
    send(data) {
        data.req_id = this.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }
    
    onMessage(res) {
        if (res.msg_type === 'authorize') {
            // state.capital = res.authorize.balance;
            LOGGER.info(`🔐 Authorized | Balance: $${state.capital}`);
            TelegramService.sendStartupMessage();
            CONFIG.ACTIVE_ASSETS.forEach(s => this.subscribe(s));
        }
        
        if (res.msg_type === 'candles') {
            const sym = res.echo_req.ticks_history;
            state.assets[sym].closedCandles = res.candles.map(c => ({ open:+c.open, close:+c.close, high:+c.high, low:+c.low, epoch:c.epoch }));
            LOGGER.info(`📊 ${sym}: Loaded ${res.candles.length} candles`);
        }
        
        if (res.msg_type === 'ohlc') this.onCandle(res.ohlc);
        
        if (res.msg_type === 'buy') {
            if (res.error) { LOGGER.error(`Trade failed: ${res.error.message}`); return; }
            const contractId = res.buy.contract_id;
            const reqId = res.echo_req.req_id;
            LOGGER.trade(`✅ Position opened: ${contractId} | Price: $${res.buy.buy_price}`);
            
            // Track hedge pairs
            const pending = this.pendingTrades?.get(reqId);
            if (pending) {
                state.activeHedges.set(contractId, { ...pending, contractId });
                this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
            }
        }
        
        if (res.msg_type === 'proposal_open_contract') {
            const c = res.proposal_open_contract;
            if (c.is_sold) {
                const hedge = state.activeHedges.get(c.contract_id);
                if (!hedge) return;
                
                const profit = c.profit;
                state.capital += profit;
                state.dailyPL += profit;
                state.tradesToday++;
                
                LOGGER.trade(`[${hedge.symbol}] ${hedge.direction} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)} | Pair: ${hedge.pairId}`);
                
                TradeHistoryManager.recordTrade(hedge.symbol, profit, true);
                TelegramService.sendTradeAlert(profit >= 0 ? 'WIN' : 'LOSS', hedge.symbol, hedge.direction, hedge.stake, { profit, isHedge: true });
                
                state.activeHedges.delete(c.contract_id);
                
                // Update D'Alembert
                if (profit > 0) {
                    state.dalembertLevel = Math.max(0, state.dalembertLevel - 1);
                    state.consecutiveLosses = 0;
                } else {
                    state.dalembertLevel = Math.min(CONFIG.MAX_DALEMBERT_STEPS, state.dalembertLevel + 1);
                    state.consecutiveLosses++;
                }
                
                // Check pause
                if (state.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                    LOGGER.warn('⏸️ Three losses - pausing 15min');
                    state.isPaused = true;
                    TelegramService.sendMessage('⏸️ <b>PAUSED</b> - 3 consecutive losses');
                    setTimeout(() => { state.isPaused = false; state.consecutiveLosses = 0; LOGGER.info('▶️ Resumed'); }, 900000);
                }
            }
        }
    }
    
    subscribe(symbol) {
        this.send({ ticks_history: symbol, count: CONFIG.CANDLES_TO_LOAD, end: 'latest', style: 'candles', granularity: CONFIG.GRANULARITY });
        this.send({ ticks_history: symbol, subscribe: 1, style: 'candles', granularity: CONFIG.GRANULARITY });
    }
    
    onCandle(ohlc) {
        const symbol = ohlc.symbol;
        const asset = state.assets[symbol];
        if (!asset) return;
        
        asset.closedCandles.push({ open:+ohlc.open, close:+ohlc.close, high:+ohlc.high, low:+ohlc.low, epoch:ohlc.epoch });
        if (asset.closedCandles.length > 200) asset.closedCandles.shift();
        
        if (state.isPaused) return;
        if (state.activeHedges.size >= 4) return; // Max 2 hedges (4 contracts)
        
        const score = ConfluenceScorer.calculateScore(asset.closedCandles);
        LOGGER.debug(`[${symbol}] Score R:${score.rise} F:${score.fall} | RSI:${score.rsi} | ${score.trend}`);
        
        // HEDGING LOGIC
        const shouldHedge = score.rise >= CONFIG.HEDGE_MIN_SCORE && 
                           score.fall >= CONFIG.HEDGE_MIN_SCORE && 
                           Math.abs(score.rise - score.fall) <= CONFIG.HEDGE_MAX_DIFF;
        
        const shouldDirectional = (score.rise >= CONFIG.MIN_SCORE_TO_TRADE || score.fall >= CONFIG.MIN_SCORE_TO_TRADE) && 
                                 Math.abs(score.rise - score.fall) > 2;
        
        if (shouldHedge) {
            this.executeHedge(symbol, score);
        } else if (shouldDirectional) {
            const direction = score.rise > score.fall ? 'CALLE' : 'PUTE';
            this.executeSingle(symbol, direction, score);
        }
    }
    
    getStake() {
        const base = CONFIG.BASE_STAKE + (state.dalembertLevel * CONFIG.DALEMBERT_UNIT);
        return Math.min(base, state.capital * 0.03);
    }
    
    executeHedge(symbol, score) {
        const stake = this.getStake() * 0.6; // 60% each side
        const pairId = `HEDGE_${Date.now()}`;
        
        LOGGER.trade(`⚖️ [${symbol}] HEDGE TRIGGER | R:${score.rise} F:${score.fall} | Stake $${stake.toFixed(2)} each`);
        LOGGER.info(`📝 Detailed Log: Opening simultaneous CALLE and PUTE | PairID: ${pairId} | RSI:${score.rsi} | Trend:${score.trend} | Capital:$${state.capital.toFixed(2)}`);
        
        this.pendingTrades = this.pendingTrades || new Map();
        
        // Open CALLE
        const callReq = this.send({
            buy: 1, price: stake.toFixed(2),
            parameters: { contract_type: 'CALLE', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD', amount: stake.toFixed(2) }
        });
        this.pendingTrades.set(callReq, { symbol, direction: 'CALLE', stake, pairId, score });
        
        // Open PUT (500ms delay to avoid rate limit)
        setTimeout(() => {
            const putReq = this.send({
                buy: 1, price: stake.toFixed(2),
                parameters: { contract_type: 'PUT', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD', amount: stake.toFixed(2) }
            });
            this.pendingTrades.set(putReq, { symbol, direction: 'PUT', stake, pairId, score });
        }, 500);
        
        TelegramService.sendTradeAlert('HEDGE', symbol, 'CALLE+PUTE', stake * 2, { score, isHedge: true });
        TradeHistoryManager.recordTrade(symbol, 0, true); // Log hedge initiation
    }
    
    executeSingle(symbol, direction, score) {
        const stake = this.getStake();
        LOGGER.trade(`🎯 [${symbol}] DIRECTIONAL ${direction} | Score:${direction==='CALLE'?score.rise:score.fall} | Stake:$${stake.toFixed(2)}`);
        
        this.pendingTrades = this.pendingTrades || new Map();
        const reqId = this.send({
            buy: 1, price: stake.toFixed(2),
            parameters: { contract_type: direction, symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD', amount: stake.toFixed(2) }
        });
        this.pendingTrades.set(reqId, { symbol, direction, stake, pairId: null, score });
        
        TelegramService.sendTradeAlert('OPEN', symbol, direction, stake, { score });
    }
}

// ============================================
// START
// ============================================
console.log('\n' + '='.repeat(70));
console.log(' DERIV HEDGED BOT v3 - Simultaneous CALLE/PUTE STRATEGY');
console.log('='.repeat(70));
console.log(`Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
console.log(`Hedge when both scores ≥${CONFIG.HEDGE_MIN_SCORE} and diff ≤${CONFIG.HEDGE_MAX_DIFF}`);
console.log(`Base stake: $${CONFIG.BASE_STAKE} | D'Alembert unit: $${CONFIG.DALEMBERT_UNIT}`);
console.log('='.repeat(70) + '\n');

new HedgedBot();

// Status every 60s
setInterval(() => {
    LOGGER.info(`📊 Status | Capital:$${state.capital.toFixed(2)} | Daily:$${state.dailyPL.toFixed(2)} | Trades:${state.tradesToday} | Active Hedges:${state.activeHedges.size/2} | D'Alembert:L${state.dalembertLevel}`);
}, 60000);