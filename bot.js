require('dotenv').config();
const WebSocket = require('ws');
const fs = require('fs');

/**
 * Deriv Trading Bot - ML kNN + EMA Ribbon + RSI Strategy
 * Contract Type: MULTIPLIERS
 * Market: Volatility 100 Index (R_100)
 * Timeframe: 3-minute candles
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: process.env.API_TOKEN || 'DMylfkyce6VyZt7',
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
    SYMBOL: 'R_100',
    TIMEFRAME: 180, // 3 minutes in seconds

    // --- USER SETTINGS ---
    STAKE: 10,              // Stake amount in USD
    STOP_LOSS: 5,           // Stop loss amount in USD (positive number)
    TAKE_PROFIT: 10,        // Take profit amount in USD (positive number)
    // ---------------------

    MAX_DAILY_LOSS_PERCENT: 10, // 10% max daily loss
    INITIAL_CANDLES: 1000,      // Pre-load for training
    KNN_HISTORY_SIZE: 500,      // kNN lookback window
    KNN_K: 5,                   // Number of neighbors
    MAX_OPEN_TRADES: 1,

    // Multiplier Settings
    MULTIPLIER: 100, // x100 multiplier

    // Indicator Parameters
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 60,
    RSI_OVERSOLD: 40,
    EMA_RIBBON: [20, 25, 30, 35, 40, 45, 50, 55],
    EMA_TREND: 200,
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
class Indicators {
    static calculateEMA(data, period) {
        if (data.length < period) return null;
        const multiplier = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
        }
        return ema;
    }

    static calculateRSI(prices, period = 14) {
        if (prices.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        return 100 - (100 / (1 + (avgGain / avgLoss)));
    }

    static calculateROC(prices, period = 14) {
        if (prices.length < period + 1) return null;
        const currentPrice = prices[prices.length - 1];
        const oldPrice = prices[prices.length - period - 1];
        return ((currentPrice - oldPrice) / oldPrice) * 100;
    }
}

// ============================================
// kNN MACHINE LEARNING ENGINE
// ============================================
class KNNEngine {
    constructor(k = 5, historySize = 500) {
        this.k = k;
        this.historySize = historySize;
        this.history = [];
    }

    addDataPoint(features, label) {
        this.history.push({ features, label });
        if (this.history.length > this.historySize) this.history.shift();
    }

    euclideanDistance(features1, features2) {
        return Math.sqrt(features1.reduce((sum, val, idx) => sum + Math.pow(val - features2[idx], 2), 0));
    }

    predict(features) {
        if (this.history.length < this.k) return null;
        const distances = this.history.map(point => ({
            distance: this.euclideanDistance(features, point.features),
            label: point.label
        })).sort((a, b) => a.distance - b.distance);
        const neighbors = distances.slice(0, this.k);
        const votes = { UP: 0, DOWN: 0 };
        neighbors.forEach(n => votes[n.label] = (votes[n.label] || 0) + 1);
        return votes.UP > votes.DOWN ? 'UP' : 'DOWN';
    }
}

// ============================================
// DERIV TRADING BOT
// ============================================
class DerivBot {
    constructor() {
        this.ws = null;
        this.isAuthenticated = false;
        this.isSubscribed = false;
        this.candles = [];
        this.knnEngine = new KNNEngine(CONFIG.KNN_K, CONFIG.KNN_HISTORY_SIZE);
        this.balance = 0;
        this.startingBalance = 0;
        this.dailyProfit = 0;
        this.dailyLossLimit = 0;
        this.isTrading = false;
        this.activeContracts = new Map();
        this.lastCandleTime = 0;
        this.indicators = { emaRibbon: [], emaTrend: null, rsi: null, roc: null };
        this.requestId = 0;
        this.proposalSubscriptions = new Map();
    }

    log(msg, type = 'INFO') {
        const ts = new Date().toLocaleTimeString();
        const colors = { INFO: '\x1b[37m', SUCCESS: '\x1b[32m', WARNING: '\x1b[33m', ERROR: '\x1b[31m', SIGNAL: '\x1b[36m', TRADE: '\x1b[35m', DATA: '\x1b[93m' };
        console.log(`${colors[type] || ''}[${ts}] [${type}] ${msg}\x1b[0m`);
        fs.appendFileSync('trading_bot.log', `[${ts}] [${type}] ${msg}\n`, { flag: 'a' });
    }

    async start() {
        console.clear();
        this.log('🤖 DERIV MULTIPLIER BOT v5.1', 'SUCCESS');
        this.log(`⚙️ Settings: Stake=$${CONFIG.STAKE}, SL=$${CONFIG.STOP_LOSS}, TP=$${CONFIG.TAKE_PROFIT}`, 'INFO');
        this.connect();
    }

    connect() {
        this.ws = new WebSocket(CONFIG.WS_URL);
        this.ws.on('open', () => {
            this.log('✅ WebSocket Connected', 'SUCCESS');
            this.authenticate();
            setInterval(() => this.send({ ping: 1 }), 30000);
        });
        this.ws.on('message', (data) => this.handleMessage(JSON.parse(data.toString())));
        this.ws.on('close', () => {
            this.log('⚠️ Connection Closed. Reconnecting...', 'WARNING');
            this.isSubscribed = false; // Reset subscription flag
            setTimeout(() => this.connect(), 5000);
        });
    }

    authenticate() {
        this.send({ authorize: CONFIG.API_TOKEN, req_id: this.getRequestId() });
    }

    send(data) {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data));
    }

    getRequestId() { return ++this.requestId; }

    handleMessage(msg) {
        if (msg.error) {
            if (msg.error.code === 'AlreadySubscribed') return;
            this.log(`❌ API Error: ${msg.error.message}`, 'ERROR');
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.log(`👤 Authorized: ${msg.authorize.email}`, 'SUCCESS');
                this.balance = parseFloat(msg.authorize.balance);
                this.startingBalance = this.balance;
                this.dailyLossLimit = this.startingBalance * (CONFIG.MAX_DAILY_LOSS_PERCENT / 100);
                this.loadHistory();
                this.send({ balance: 1, subscribe: 1 });
                break;

            case 'balance':
                this.balance = parseFloat(msg.balance.balance);
                this.dailyProfit = this.balance - this.startingBalance;
                this.updateDashboard();
                this.checkLimits();
                break;

            case 'candles':
                this.processHistory(msg.candles);
                this.subscribeMarket();
                break;

            case 'ohlc':
                this.onNewCandle(msg.ohlc);
                break;

            case 'proposal':
                this.handleProposal(msg.proposal);
                break;

            case 'buy':
                this.handleBuyResponse(msg.buy);
                break;

            case 'proposal_open_contract':
                this.handleOpenContract(msg.proposal_open_contract);
                break;
        }
    }

    updateDashboard() {
        process.stdout.write(`\r\x1b[33m💰 Balance: ${this.balance.toFixed(2)} | Daily PnL: ${this.dailyProfit.toFixed(2)} USD\x1b[0m`);
    }

    loadHistory() {
        this.log('📊 Loading History...', 'INFO');
        this.send({
            ticks_history: CONFIG.SYMBOL,
            count: CONFIG.INITIAL_CANDLES,
            end: 'latest',
            style: 'candles',
            granularity: CONFIG.TIMEFRAME,
            req_id: this.getRequestId()
        });
    }

    subscribeMarket() {
        if (this.isSubscribed) return;
        this.send({
            ticks_history: CONFIG.SYMBOL,
            subscribe: 1,
            end: 'latest',
            style: 'candles',
            granularity: CONFIG.TIMEFRAME
        });
        this.isSubscribed = true;
    }

    processHistory(candlesData) {
        this.candles = candlesData.map(c => ({
            time: c.epoch,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));
        this.lastCandleTime = this.candles[this.candles.length - 1].time;
        this.trainKNN();
        this.log(`✅ Training Complete with ${this.knnEngine.history.length} points`, 'SUCCESS');
    }

    trainKNN() {
        if (this.candles.length < CONFIG.EMA_TREND + CONFIG.RSI_PERIOD + 1) return;
        for (let i = CONFIG.EMA_TREND + CONFIG.RSI_PERIOD + 1; i < this.candles.length; i++) {
            const sub = this.candles.slice(0, i).map(c => c.close);
            const rsi = Indicators.calculateRSI(sub);
            const roc = Indicators.calculateROC(sub);
            if (rsi !== null && roc !== null) {
                const label = this.candles[i].close > this.candles[i - 1].close ? 'UP' : 'DOWN';
                this.knnEngine.addDataPoint([rsi, roc], label);
            }
        }
    }

    onNewCandle(ohlc) {
        if (ohlc.open_time === ohlc.epoch) return; // Wait for close
        const candle = { time: ohlc.epoch, open: parseFloat(ohlc.open), high: parseFloat(ohlc.high), low: parseFloat(ohlc.low), close: parseFloat(ohlc.close) };

        if (candle.time > this.lastCandleTime) {
            this.candles.push(candle);
            this.lastCandleTime = candle.time;
            if (this.candles.length > CONFIG.INITIAL_CANDLES) this.candles.shift();
            this.log(`\n🕒 Candle Closed: ${candle.close.toFixed(2)}`, 'DATA');
            this.calculateIndicators();
            this.checkTradeSignals();
        }
    }

    calculateIndicators() {
        const closes = this.candles.map(c => c.close);
        this.indicators.emaRibbon = CONFIG.EMA_RIBBON.map(p => Indicators.calculateEMA(closes, p));
        this.indicators.emaTrend = Indicators.calculateEMA(closes, CONFIG.EMA_TREND);
        this.indicators.rsi = Indicators.calculateRSI(closes);
        this.indicators.roc = Indicators.calculateROC(closes);
    }

    checkTradeSignals() {
        if (this.isTrading || this.activeContracts.size >= CONFIG.MAX_OPEN_TRADES) return;

        const currentPrice = this.candles[this.candles.length - 1].close;
        const knnPrediction = this.knnEngine.predict([this.indicators.rsi, this.indicators.roc]);
        if (!knnPrediction) return;

        const ribbonAvg = this.indicators.emaRibbon.reduce((a, b) => a + b, 0) / this.indicators.emaRibbon.length;

        const longCond = currentPrice > this.indicators.emaTrend && ribbonAvg > this.indicators.emaTrend && this.indicators.rsi < CONFIG.RSI_OVERSOLD && knnPrediction === 'UP';
        const shortCond = currentPrice < this.indicators.emaTrend && ribbonAvg < this.indicators.emaTrend && this.indicators.rsi > CONFIG.RSI_OVERBOUGHT && knnPrediction === 'DOWN';

        if (longCond) {
            this.log('🎯 LONG SIGNAL DETECTED', 'SIGNAL');
            this.executeTrade('UP');
        } else if (shortCond) {
            this.log('🎯 SHORT SIGNAL DETECTED', 'SIGNAL');
            this.executeTrade('DOWN');
        }

        // Live Learning
        if (this.candles.length >= 2) {
            const label = this.candles[this.candles.length - 1].close > this.candles[this.candles.length - 2].close ? 'UP' : 'DOWN';
            this.knnEngine.addDataPoint([this.indicators.rsi, this.indicators.roc], label);
        }
    }

    executeTrade(direction) {
        this.isTrading = true;
        const stake = CONFIG.STAKE;
        const sl = CONFIG.STOP_LOSS;
        const tp = CONFIG.TAKE_PROFIT;

        const reqId = this.getRequestId();
        this.proposalSubscriptions.set(reqId, { direction, stake, sl, tp });

        this.send({
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: direction === 'UP' ? 'MULTUP' : 'MULTDOWN',
            currency: 'USD',
            multiplier: CONFIG.MULTIPLIER,
            symbol: CONFIG.SYMBOL,
            req_id: reqId
        });
    }

    handleProposal(proposal) {
        const details = this.proposalSubscriptions.get(proposal.req_id);
        if (!details) return;
        this.proposalSubscriptions.delete(proposal.req_id);

        this.log(`🛒 Executing Trade: Stake=$${details.stake}, SL=$${details.sl}, TP=$${details.tp}`, 'TRADE');
        this.send({
            buy: proposal.id,
            price: details.stake,
            parameters: {
                limit_order: { stop_loss: details.sl, take_profit: details.tp }
            },
            req_id: this.getRequestId()
        });
    }

    handleBuyResponse(buy) {
        this.log(`✅ Trade Opened: ${buy.contract_id}`, 'SUCCESS');
        this.activeContracts.set(buy.contract_id, {
            id: buy.contract_id,
            stake: parseFloat(buy.buy_price),
            sl: CONFIG.STOP_LOSS,
            tp: CONFIG.TAKE_PROFIT,
            startTime: Date.now()
        });
        this.send({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
        setTimeout(() => this.isTrading = false, 2000);
    }

    handleOpenContract(contract) {
        if (!this.activeContracts.has(contract.contract_id)) return;
        const trade = this.activeContracts.get(contract.contract_id);
        const profit = parseFloat(contract.profit || 0);

        // Clear line and display trade details
        process.stdout.write(`\r\x1b[36m📊 [TRADE ${trade.id}] Stake: $${trade.stake.toFixed(2)} | P/L: $${profit.toFixed(2)} | SL: -$${trade.sl.toFixed(2)} | TP: +$${trade.tp.toFixed(2)}\x1b[0m`);

        if (contract.is_sold) {
            console.log('\n'); // Move to next line after trade closure
            const finalProfit = parseFloat(contract.profit);
            this.log(`🏁 Trade Closed: ${finalProfit > 0 ? 'WIN' : 'LOSS'} | Profit: $${finalProfit.toFixed(2)}`, finalProfit > 0 ? 'SUCCESS' : 'ERROR');
            this.activeContracts.delete(contract.contract_id);
        }
    }

    checkLimits() {
        if (this.dailyProfit <= -this.dailyLossLimit) {
            this.log('\n🛑 Daily Loss Limit Hit. Stopping.', 'ERROR');
            process.exit(0);
        }
    }
}

const bot = new DerivBot();
bot.start();
