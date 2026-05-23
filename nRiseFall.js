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
    BASE_STAKE: 3.75,
    RISK_PERCENT: 1.5,
    
    ACTIVE_ASSETS: ['R_10', 'R_25'],
    
    HEDGE_MIN_SCORE: 4,
    HEDGE_MAX_DIFF: 2,
    MIN_SCORE_TO_TRADE: 6,
    
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
// LOGGER
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
    static getRecentDays(n=5) {
        const days = Object.keys(tradeHistory.dailyHistory).sort().slice(-n);
        return days.map(d => tradeHistory.dailyHistory[d]);
    }
}

// ============================================
// TELEGRAM SERVICE (FULL from reference)
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
    }
    
    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverall();
        const msg = `
🤖 <b>HEDGED BOT v3 STARTED</b>
Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}
Base Stake: $${CONFIG.BASE_STAKE}
Strategy: Confluence + Hedging
Hedge: Both scores ≥${CONFIG.HEDGE_MIN_SCORE}

📊 <b>Historical:</b>
Total Trades: ${overall.tradesCount}
Total Hedges: ${overall.hedges}
Overall P/L: $${overall.netPL.toFixed(2)}
Win Rate: ${overall.tradesCount > 0 ? ((overall.winsCount/overall.tradesCount)*100).toFixed(1) : 0}%
        `.trim();
        await this.sendMessage(msg);
    }
    
    static async sendSessionSummary() {
        const today = TradeHistoryManager.getToday();
        const overall = TradeHistoryManager.getOverall();
        const recent = TradeHistoryManager.getRecentDays(5);
        
        const winRate = today.tradesCount > 0 ? ((today.winsCount/today.tradesCount)*100).toFixed(1) : '0.0';
        const overallWR = overall.tradesCount > 0 ? ((overall.winsCount/overall.tradesCount)*100).toFixed(1) : '0.0';
        
        let recentStr = '';
        recent.forEach(d => {
            const wr = d.tradesCount > 0 ? ((d.winsCount/d.tradesCount)*100).toFixed(0) : '0';
            recentStr += `\n  ${d.date}: ${d.tradesCount}t ${wr}% $${d.netPL.toFixed(2)} (${d.hedges}H)`;
        });
        
        const message = `
📊 <b>SESSION SUMMARY</b>

📅 <b>Today (${TradeHistoryManager.getDateKey()}):</b>
Trades: ${today.tradesCount} (${today.hedges} hedges)
Wins: ${today.winsCount} | Losses: ${today.lossesCount}
Win Rate: ${winRate}%
P/L: $${today.netPL.toFixed(2)}
Profit: $${today.profit.toFixed(2)} | Loss: $${today.loss.toFixed(2)}

📈 <b>Overall:</b>
Total Trades: ${overall.tradesCount}
Total Hedges: ${overall.hedges}
Win Rate: ${overallWR}%
Overall P/L: $${overall.netPL.toFixed(2)}
Period: ${overall.firstTradeDate || 'N/A'} to ${overall.lastTradeDate || 'N/A'}

📆 <b>Recent Days:</b>${recentStr || '\n  No history'}

💰 Current Capital: $${state.capital.toFixed(2)}
        `.trim();
        
        await this.sendMessage(message);
        LOGGER.info('📱 Session summary sent');
    }
    
    static async sendDayEndSummary(dateKey) {
        const day = tradeHistory.dailyHistory[dateKey];
        if (!day || day.tradesCount === 0) return;
        
        const wr = day.tradesCount > 0 ? ((day.winsCount/day.tradesCount)*100).toFixed(1) : '0.0';
        const emoji = day.netPL >= 0 ? '🟢' : '🔴';
        
        const message = `
🌙 <b>END OF DAY - ${dateKey}</b>

${emoji} <b>Results:</b>
Trades: ${day.tradesCount} (${day.hedges} hedges)
W/L: ${day.winsCount}/${day.lossesCount} (${wr}%)
Net P/L: $${day.netPL.toFixed(2)}
Start: $${day.startCapital.toFixed(2)} → End: $${day.endCapital.toFixed(2)}

💰 Capital: $${state.capital.toFixed(2)}
        `.trim();
        
        await this.sendMessage(message);
    }
    
    static async sendHourlySummary() {
        const hour = state.hourlyStats;
        if (hour.trades === 0) return;
        
        const wr = hour.trades > 0 ? ((hour.wins/hour.trades)*100).toFixed(1) : '0.0';
        const emoji = hour.pnl >= 0 ? '🟢' : '🔴';
        
        const message = `
⏰ <b>HOURLY SUMMARY</b>

Trades: ${hour.trades}
W/L: ${hour.wins}/${hour.losses} (${wr}%)
${emoji} P/L: $${hour.pnl.toFixed(2)}

Today: $${state.dailyPL.toFixed(2)}
Capital: $${state.capital.toFixed(2)}
        `.trim();
        
        await this.sendMessage(message);
        LOGGER.info(`📱 Hourly: ${hour.trades} trades, $${hour.pnl.toFixed(2)}`);
        
        // Reset
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
    }
    
    static startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now); nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const delay = nextHour - now;
        
        setTimeout(() => {
            this.sendHourlySummary();
            setInterval(() => this.sendHourlySummary(), 3600000);
        }, delay);
        LOGGER.info(`📱 Hourly timer started (${Math.round(delay/60000)}min)`);
    }
    
    static startDailyTimer() {
        const now = new Date();
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0,0,0,0);
        const delay = tomorrow - now;
        
        setTimeout(() => {
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
            const key = yesterday.toISOString().split('T')[0];
            this.sendDayEndSummary(key);
            setInterval(() => {
                const y = new Date(); y.setDate(y.getDate() - 1);
                this.sendDayEndSummary(y.toISOString().split('T')[0]);
            }, 86400000);
        }, delay);
    }
}

// ============================================
// SCORER
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
        if (rsi > 78) fall += 3; else if (rsi > 70) fall += 2;
        if (current >= bb.upper) fall += 3;
        if (roc < -0.02) fall += 2;
        if (ema5 > ema20) { rise += 4; if (rsi >= 60 && rsi < 79) rise += 2; if (current > bb.middle && current < bb.upper) rise += 2; }
        if (rsi < 22) rise += 3; else if (rsi < 30) rise += 2;
        if (current <= bb.lower) rise += 3;
        
        return { rise, fall, rsi: rsi.toFixed(1), trend: ema5 > ema20 ? 'BULL' : 'BEAR' };
    }
    static RSI(c,p){let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const ch=c[i]-c[i-1];if(ch>0)g+=ch;else l-=ch;}const rs=g/(l||1);return 100-(100/(1+rs));}
    static BB(c,p,s){const sl=c.slice(-p);const sma=sl.reduce((a,b)=>a+b)/p;const v=sl.reduce((a,b)=>a+Math.pow(b-sma,2),0)/p;const sd=Math.sqrt(v);return{middle:sma,upper:sma+s*sd,lower:sma-s*sd};}
    static EMA(c,p){const k=2/(p+1);let e=c[0];for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k);return e;}
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

CONFIG.ACTIVE_ASSETS.forEach(s => state.assets[s] = { closedCandles: [] });

// ============================================
// BOT
// ============================================
class HedgedBot {
    constructor() {
        this.ws = null;
        this.requestId = 1;
        TradeHistoryManager.loadHistory();
        this.connect();
    }
    
    connect() {
        LOGGER.info('🔌 Connecting...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        this.ws.on('open', () => { this.send({ authorize: CONFIG.API_TOKEN }); });
        this.ws.on('message', d => this.onMessage(JSON.parse(d)));
        this.ws.on('close', () => setTimeout(() => this.connect(), 5000));
    }
    
    send(data) { data.req_id = this.requestId++; this.ws.send(JSON.stringify(data)); return data.req_id; }
    
    onMessage(res) {
        if (res.msg_type === 'authorize') {
            state.capital = res.authorize.balance;
            LOGGER.info(`🔐 Authorized | $${state.capital}`);
            TelegramService.sendStartupMessage();
            TelegramService.startHourlyTimer();
            TelegramService.startDailyTimer();
            CONFIG.ACTIVE_ASSETS.forEach(s => this.subscribe(s));
        }
        
        if (res.msg_type === 'candles') {
            const sym = res.echo_req.ticks_history;
            state.assets[sym].closedCandles = res.candles.map(c => ({ open:+c.open, close:+c.close, high:+c.high, low:+c.low, epoch:c.epoch }));
        }
        
        if (res.msg_type === 'ohlc') this.onCandle(res.ohlc);
        
        if (res.msg_type === 'buy' && !res.error) {
            const pending = this.pendingTrades?.get(res.echo_req.req_id);
            if (pending) {
                state.activeHedges.set(res.buy.contract_id, { ...pending, contractId: res.buy.contract_id });
                this.send({ proposal_open_contract: 1, contract_id: res.buy.contract_id, subscribe: 1 });
            }
        }
        
        if (res.msg_type === 'proposal_open_contract') {
            const c = res.proposal_open_contract;
            if (c.is_sold) {
                const h = state.activeHedges.get(c.contract_id);
                if (!h) return;
                
                const profit = c.profit;
                state.capital += profit; state.dailyPL += profit; state.tradesToday++;
                state.hourlyStats.trades++; state.hourlyStats.pnl += profit;
                if (profit > 0) { state.hourlyStats.wins++; } else { state.hourlyStats.losses++; }
                
                LOGGER.trade(`[${h.symbol}] ${h.direction} ${profit>=0?'WIN':'LOSS'} $${profit.toFixed(2)}`);
                TradeHistoryManager.recordTrade(h.symbol, profit, true);
                TelegramService.sendTradeAlert(profit>=0?'WIN':'LOSS', h.symbol, h.direction, h.stake, { profit, isHedge: true, score: h.score });
                
                state.activeHedges.delete(c.contract_id);
                
                if (profit > 0) { state.dalembertLevel = Math.max(0, state.dalembertLevel-1); state.consecutiveLosses=0; }
                else { state.dalembertLevel = Math.min(CONFIG.MAX_DALEMBERT_STEPS, state.dalembertLevel+1); state.consecutiveLosses++; }
                
                if (state.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                    state.isPaused = true;
                    TelegramService.sendMessage('⏸️ <b>PAUSED</b> - 3 losses');
                    setTimeout(() => { state.isPaused = false; state.consecutiveLosses = 0; }, 900000);
                }
                
                if (state.dailyPL >= CONFIG.DAILY_PROFIT_TARGET || state.dailyPL <= CONFIG.DAILY_STOP_LOSS) {
                    TelegramService.sendSessionSummary().then(() => process.exit(0));
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
        asset.closedCandles.push({ open:+ohlc.open, close:+ohlc.close, high:+ohlc.high, low:+ohlc.low, epoch:ohlc.epoch });
        if (asset.closedCandles.length > 200) asset.closedCandles.shift();
        
        if (state.isPaused || state.activeHedges.size >= 4) return;
        
        const score = ConfluenceScorer.calculateScore(asset.closedCandles);
        const shouldHedge = score.rise >= CONFIG.HEDGE_MIN_SCORE && score.fall >= CONFIG.HEDGE_MIN_SCORE && Math.abs(score.rise - score.fall) <= CONFIG.HEDGE_MAX_DIFF;
        
        if (shouldHedge) this.executeHedge(ohlc.symbol, score);
    }
    
    getStake() { return Math.min(CONFIG.BASE_STAKE + (state.dalembertLevel * CONFIG.DALEMBERT_UNIT), state.capital * 0.03); }
    
    executeHedge(symbol, score) {
        const stake = this.getStake() * 0.6;
        const pairId = Date.now();
        LOGGER.trade(`⚖️ [${symbol}] HEDGE R:${score.rise} F:${score.fall} | $${stake.toFixed(2)} each`);
        
        this.pendingTrades = this.pendingTrades || new Map();
        const callReq = this.send({ buy: 1, price: stake.toFixed(2), parameters: { contract_type: 'CALL', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD', amount: stake.toFixed(2) }});
        this.pendingTrades.set(callReq, { symbol, direction: 'CALL', stake, pairId, score });
        
        setTimeout(() => {
            const putReq = this.send({ buy: 1, price: stake.toFixed(2), parameters: { contract_type: 'PUT', symbol, duration: CONFIG.DURATION, duration_unit: CONFIG.DURATION_UNIT, basis: 'stake', currency: 'USD', amount: stake.toFixed(2) }});
            this.pendingTrades.set(putReq, { symbol, direction: 'PUT', stake, pairId, score });
        }, 500);
        
        TelegramService.sendTradeAlert('HEDGE', symbol, 'CALL+PUT', stake*2, { score, isHedge: true });
    }
}

// START
console.log('\n' + '='.repeat(70));
console.log(' HEDGED BOT v3 - Full Telegram Summaries Enabled');
console.log('='.repeat(70) + '\n');

new HedgedBot();

setInterval(() => {
    LOGGER.info(`📊 Capital:$${state.capital.toFixed(2)} Daily:$${state.dailyPL.toFixed(2)} Trades:${state.tradesToday} Hedges:${state.activeHedges.size/2}`);
}, 60000);

// Manual summary command
process.on('SIGUSR1', () => { TelegramService.sendSessionSummary(); });