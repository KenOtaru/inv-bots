/**
 * DERIV DIGITS OVER/UNDER - STATISTICAL ARBITRAGE BOT
 * Research-backed: Exploits short-term digit distribution deviations [1]
 * Strategy: Track last 500 ticks, bet on mean reversion to 10% uniform
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

const CONFIG = {
    API_TOKEN: 'rgNedekYXvCaPeP',
    APP_ID: 1089,
    WS_URL: 'wss://ws.derivws.com/websockets/v3',
    
    SYMBOL: 'R_10', // Most stable for digits
    STAKE: 1.0, // Fixed stake - NO martingale [1]
    MAX_TRADES_PER_HOUR: 30,
    
    // Statistical parameters
    LOOKBACK_TICKS: 500, // Analyze last 500 digits
    DEVIATION_THRESHOLD: 2.0, // 2% deviation from 10% triggers trade
    MIN_SAMPLE_SIZE: 100,
    
    // Over/Under levels (from research [7])
    OVER_LEVEL: 3,  // Trade OVER 3 when digits 0-3 underrepresented
    UNDER_LEVEL: 6, // Trade UNDER 6 when digits 7-9 overrepresented
    
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117',
};

const LOGGER = {
    info: m => console.log(`[INFO] ${new Date().toISOString()} - ${m}`),
    trade: m => console.log(`\x1b[32m[TRADE] ${m}\x1b[0m`),
    error: m => console.error(`\x1b[31m[ERROR] ${m}\x1b[0m`),
};

class TelegramService {
    static async send(msg) {
        if (!CONFIG.TELEGRAM_ENABLED) return;
        const data = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' });
        return new Promise(r => {
            const req = https.request(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            }, res => res.on('end', () => r(true)));
            req.write(data); req.end();
        });
    }
    
    static async sendEntry(symbol, type, barrier, stake, stats) {
        const emoji = type.includes('OVER') ? '📈' : '📉';
        const msg = `
${emoji} <b>DIGITS ENTRY</b>
Symbol: ${symbol}
Type: ${type}
Barrier: ${barrier}
Stake: $${stake}

<b>Statistical Edge:</b>
Sample: ${stats.sampleSize} ticks
Expected: 10.0% per digit
${stats.deviations.map(d => `Digit ${d.digit}: ${d.actual.toFixed(1)}% (${d.deviation > 0 ? '+' : ''}${d.deviation.toFixed(1)}%)`).join('\n')}

<b>Reason:</b> ${stats.reason}
        `.trim();
        await this.send(msg);
        LOGGER.trade(`ENTRY: ${type} ${barrier} | ${stats.reason}`);
    }
    
    static async sendResult(symbol, type, barrier, stake, profit, stats) {
        const win = profit > 0;
        const emoji = win ? '✅' : '❌';
        const msg = `
${emoji} <b>DIGITS RESULT</b>
Symbol: ${symbol}
Type: ${type}
Barrier: ${barrier}
${win ? 'WIN' : 'LOSS'}: $${profit.toFixed(2)}

<b>Trade Stats:</b>
Last Digit: ${stats.lastDigit}
Prediction: ${type}
Payout: ${((profit/stake)*100).toFixed(1)}%

<b>Session:</b>
Trades: ${state.session.trades}
W/L: ${state.session.wins}/${state.session.losses}
P/L: $${state.session.pnl.toFixed(2)}
        `.trim();
        await this.send(msg);
        LOGGER.trade(`RESULT: ${win?'WIN':'LOSS'} $${profit.toFixed(2)} | Last digit: ${stats.lastDigit}`);
    }
    
    static async sendDailySummary() {
        const s = state.session;
        const wr = s.trades > 0 ? ((s.wins/s.trades)*100).toFixed(1) : 0;
        const msg = `
📊 <b>DAILY DIGITS SUMMARY</b>

Trades: ${s.trades}
Win Rate: ${wr}%
W/L: ${s.wins}/${s.losses}
Net P/L: $${s.pnl.toFixed(2)}

<b>Digit Distribution (last ${state.digits.length}):</b>
${Array.from({length:10},(_,i)=> {
    const count = state.digits.filter(d => d === i).length;
    const pct = (count/state.digits.length*100).toFixed(1);
    return `${i}: ${pct}%`;
}).join(' | ')}

Capital: $${state.balance.toFixed(2)}
        `.trim();
        await this.send(msg);
    }
}

const state = {
    ws: null,
    digits: [], // Rolling window of last digits
    balance: 0,
    session: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    lastTradeTime: 0,
    activeContract: null,
};

class DigitsArbBot {
    constructor() {
        this.connect();
    }
    
    connect() {
        LOGGER.info('Connecting to Deriv...');
        state.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        state.ws.on('open', () => this.send({ authorize: CONFIG.API_TOKEN }));
        state.ws.on('message', m => this.handle(JSON.parse(m)));
    }
    
    send(d) { state.ws.send(JSON.stringify(d)); }
    
    handle(msg) {
        if (msg.msg_type === 'authorize') {
            state.balance = msg.authorize.balance;
            LOGGER.info(`Authorized, balance $${state.balance}`);
            TelegramService.send(`🤖 <b>DIGITS ARB BOT STARTED</b>\nSymbol: ${CONFIG.SYMBOL}\nStake: $${CONFIG.STAKE}\nLookback: ${CONFIG.LOOKBACK_TICKS} ticks`);
            this.subscribeTicks();
        }
        
        if (msg.msg_type === 'tick') {
            const digit = parseInt(msg.tick.quote.toString().slice(-1));
            state.digits.push(digit);
            if (state.digits.length > CONFIG.LOOKBACK_TICKS) state.digits.shift();
            
            if (state.digits.length >= CONFIG.MIN_SAMPLE_SIZE && !state.activeContract) {
                this.analyzeAndTrade();
            }
        }
        
        if (msg.msg_type === 'buy' && !msg.error) {
            state.activeContract = msg.buy.contract_id;
            this.send({ proposal_open_contract: 1, contract_id: msg.buy.contract_id, subscribe: 1 });
        }
        
        if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract.is_sold) {
            const profit = msg.proposal_open_contract.profit;
            state.session.trades++;
            state.session.pnl += profit;
            state.balance += profit;
            
            if (profit > 0) state.session.wins++; else state.session.losses++;
            
            const contract = msg.proposal_open_contract;
            TelegramService.sendResult(
                CONFIG.SYMBOL,
                contract.contract_type,
                contract.barrier,
                CONFIG.STAKE,
                profit,
                { lastDigit: contract.exit_tick ? contract.exit_tick.toString().slice(-1) : '?' }
            );
            
            state.activeContract = null;
            state.lastTradeTime = Date.now();
        }
    }
    
    subscribeTicks() {
        this.send({ ticks_history: CONFIG.SYMBOL, end: 'latest', count: CONFIG.LOOKBACK_TICKS, subscribe: 1 });
    }
    
    analyzeAndTrade() {
        // Rate limit
        if (Date.now() - state.lastTradeTime < 5000) return;
        if (state.session.trades >= CONFIG.MAX_TRADES_PER_HOUR) return;
        
        // Calculate digit frequencies
        const counts = Array(10).fill(0);
        state.digits.forEach(d => counts[d]++);
        const total = state.digits.length;
        
        const stats = counts.map((c, i) => ({
            digit: i,
            count: c,
            actual: (c/total)*100,
            expected: 10,
            deviation: ((c/total)*100) - 10
        }));
        
        // Statistical arbitrage: Find most under/over represented
        const underrepresented = stats.filter(s => s.deviation < -CONFIG.DEVIATION_THRESHOLD).sort((a,b) => a.deviation - b.deviation);
        const overrepresented = stats.filter(s => s.deviation > CONFIG.DEVIATION_THRESHOLD).sort((a,b) => b.deviation - a.deviation);
        
        let tradeType = null;
        let barrier = null;
        let reason = '';
        
        // Strategy from research [7]: Trade OVER 3 when low digits underrepresented
        const lowDigits = stats.slice(0, 4); // 0-3
        const lowAvg = lowDigits.reduce((sum,s) => sum + s.actual, 0) / 4;
        
        if (lowAvg < 8.0) { // Low digits appearing <8% instead of 10%
            tradeType = 'DIGITOVER';
            barrier = CONFIG.OVER_LEVEL;
            reason = `Low digits (0-3) underrepresented: ${lowAvg.toFixed(1)}% vs 10% expected`;
        }
        
        // Trade UNDER 6 when high digits overrepresented
        const highDigits = stats.slice(7, 10); // 7-9
        const highAvg = highDigits.reduce((sum,s) => sum + s.actual, 0) / 3;
        
        if (highAvg > 12.0) {
            tradeType = 'DIGITUNDER';
            barrier = CONFIG.UNDER_LEVEL;
            reason = `High digits (7-9) overrepresented: ${highAvg.toFixed(1)}% vs 10% expected`;
        }
        
        if (!tradeType) return;
        
        // Execute trade
        const deviations = [...underrepresented.slice(0,3), ...overrepresented.slice(0,3)];
        TelegramService.sendEntry(CONFIG.SYMBOL, tradeType, barrier, CONFIG.STAKE, {
            sampleSize: total,
            deviations,
            reason
        });
        
        this.send({
            buy: 1,
            price: CONFIG.STAKE,
            parameters: {
                contract_type: tradeType,
                symbol: CONFIG.SYMBOL,
                duration: 1,
                duration_unit: 't',
                barrier: barrier.toString(),
                basis: 'stake',
                currency: 'USD',
                amount: CONFIG.STAKE
            }
        });
        
        state.lastTradeTime = Date.now();
    }
}

// Start bot
LOGGER.info('=== DIGITS OVER/UNDER STATISTICAL ARBITRAGE BOT ===');
LOGGER.info(`Symbol: ${CONFIG.SYMBOL} | Stake: $${CONFIG.STAKE} | Lookback: ${CONFIG.LOOKBACK_TICKS}`);
new DigitsArbBot();

// Daily summary at midnight
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        TelegramService.sendDailySummary();
    }
}, 60000);