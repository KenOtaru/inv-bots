/**
 * Deriv V75 Index Algorithmic Trading Bot
 * Single-file, production-ready NodeJS implementation
 * Strategy: EMA-RSI Momentum with Aggressive Risk Management
 */

const WebSocket = require('ws');

class DerivBot {
    constructor(config) {
        // ==================== CONFIGURATION ====================
        this.config = {
            appId: config.appId || '1089',
            token: config.token,
            symbol: 'R_75',
            stakePercent: 0.02, // 2% of balance
            dailyProfitTarget: 0.025, // 2.5%
            dailyLossLimit: 0.05, // 5%
            maxDrawdownPercent: 0.15, // 15%
            heartBeatInterval: 30000, // 30 seconds
            reconnectBaseDelay: 1000,
            maxReconnectDelay: 60000,
            ...config
        };

        // ==================== STATE MANAGEMENT ====================
        this.state = {
            connected: false,
            authenticated: false,
            balance: 0,
            equity: 0,
            equityPeak: 0,
            dailyStartBalance: 0,
            dailyPnL: 0,
            activeTrade: false,
            tradeStake: 0,
            tradeDirection: null,
            tradeEntryPrice: 0,
            reconnectAttempts: 0,
            heartBeatTimer: null,
            tickHistory: [],
            indicators: {
                ema20: 0,
                ema50: 0,
                rsi: 50
            },
            ws: null,
            pendingProposal: null,
            messageQueue: []
        };

        // ==================== DERIV API CONFIG ====================
        this.apiUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.config.appId}`;

        // ==================== START BOT ====================
        this.connect();
    }

    // ==================== WEBSOCKET CONNECTION ====================
    connect() {
        try {
            console.log(`[${new Date().toISOString()}] 🔌 Connecting to Deriv API...`);
            this.state.ws = new WebSocket(this.apiUrl);

            this.state.ws.on('open', () => {
                console.log(`[${new Date().toISOString()}] ✅ WebSocket connected`);
                this.state.connected = true;
                this.state.reconnectAttempts = 0;
                this.authenticate();
            });

            this.state.ws.on('message', (data) => {
                this.handleMessage(JSON.parse(data));
            });

            this.state.ws.on('error', (error) => {
                console.error(`[${new Date().toISOString()}] ❌ WebSocket error:`, error.message);
                this.handleDisconnect();
            });

            this.state.ws.on('close', () => {
                console.log(`[${new Date().toISOString()}] 🔌 WebSocket closed`);
                this.handleDisconnect();
            });

        } catch (error) {
            console.error(`[${new Date().toISOString()}] ❌ Connection error:`, error.message);
            this.handleDisconnect();
        }
    }

    handleDisconnect() {
        if (this.state.connected) {
            this.state.connected = false;
            this.state.authenticated = false;
            this.stopHeartbeat();

            // Exponential backoff
            const delay = Math.min(
                this.config.reconnectBaseDelay * Math.pow(2, this.state.reconnectAttempts),
                this.config.maxReconnectDelay
            );

            this.state.reconnectAttempts++;
            console.log(`[${new Date().toISOString()}] 🔄 Reconnecting in ${delay / 1000}s (attempt ${this.state.reconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        }
    }

    // ==================== AUTHENTICATION ====================
    authenticate() {
        if (!this.state.connected) return;

        console.log(`[${new Date().toISOString()}] 🔐 Authenticating...`);
        this.sendMessage({
            authorize: this.config.token
        });
    }

    // ==================== HEARTBEAT ====================
    startHeartbeat() {
        this.stopHeartbeat();
        this.state.heartBeatTimer = setInterval(() => {
            if (this.state.connected) {
                // Send ping to keep connection alive
                this.sendMessage({ ping: 1 });
            }
        }, this.config.heartBeatInterval);
    }

    stopHeartbeat() {
        if (this.state.heartBeatTimer) {
            clearInterval(this.state.heartBeatTimer);
            this.state.heartBeatTimer = null;
        }
    }

    // ==================== MESSAGE HANDLING ====================
    sendMessage(message) {
        if (this.state.connected && this.state.ws) {
            this.state.ws.send(JSON.stringify(message));
        } else {
            this.state.messageQueue.push(message);
        }
    }

    handleMessage(message) {
        // Handle authorization response
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error(`[${new Date().toISOString()}] ❌ Authorization failed:`, message.error.message);
                return;
            }

            this.state.authenticated = true;
            this.state.balance = message.authorize.balance;
            this.state.equity = this.state.balance;
            this.state.dailyStartBalance = this.state.balance;
            this.state.equityPeak = this.state.balance;

            console.log(`[${new Date().toISOString()}] ✅ Authorized. Balance: $${this.state.balance.toFixed(2)}`);

            this.startHeartbeat();
            this.subscribeToTicks();
            this.flushMessageQueue();
        }

        // Handle tick stream
        else if (message.msg_type === 'tick') {
            this.handleTick(message.tick);
        }

        // Handle proposal response
        else if (message.msg_type === 'proposal') {
            if (message.error) {
                console.error(`[${new Date().toISOString()}] ❌ Proposal error:`, message.error.message);
                this.state.activeTrade = false;
                return;
            }

            this.state.pendingProposal = message.proposal;
            console.log(`[${new Date().toISOString()}] 📋 Proposal received: ${message.proposal.id}`);

            // Immediately buy using the price from the proposal
            this.sendMessage({
                buy: message.proposal.id,
                price: message.proposal.ask_price
            });
        }

        // Handle buy response
        else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error(`[${new Date().toISOString()}] ❌ Buy error:`, message.error.message);
                this.handleApiError(message.error);
                this.state.activeTrade = false;
                return;
            }

            const contract = message.buy;
            console.log(`[${new Date().toISOString()}] 🚀 Trade executed: ${contract.contract_id} | ${this.state.tradeDirection.toUpperCase()} | Stake: $${this.state.tradeStake.toFixed(2)}`);

            // Subscribe to contract updates
            this.sendMessage({
                proposal_open_contract: 1,
                contract_id: contract.contract_id,
                subscribe: 1
            });
        }

        // Handle contract updates
        else if (message.msg_type === 'proposal_open_contract') {
            const contract = message.proposal_open_contract;

            if (contract.is_sold) {
                this.handleTradeResult(contract);
            }
        }

        // Handle balance updates
        else if (message.msg_type === 'balance') {
            this.state.balance = message.balance.balance;
            this.state.equity = this.state.balance;

            // Update equity peak
            if (this.state.equity > this.state.equityPeak) {
                this.state.equityPeak = this.state.equity;
            }
        }

        // Handle ping response
        else if (message.ping) {
            // Heartbeat acknowledged
        }

        // Handle errors
        else if (message.error) {
            console.error(`[${new Date().toISOString()}] ❌ API Error:`, message.error.message);
            this.handleApiError(message.error);
        }
    }

    flushMessageQueue() {
        while (this.state.messageQueue.length > 0) {
            this.sendMessage(this.state.messageQueue.shift());
        }
    }

    handleApiError(error) {
        switch (error.code) {
            case 'RateLimit':
                console.warn(`[${new Date().toISOString()}] ⚠️ Rate limit hit. Pausing for 60s...`);
                setTimeout(() => this.state.activeTrade = false, 60000);
                break;
            case 'InsufficientBalance':
                console.error(`[${new Date().toISOString()}] 💔 Insufficient balance. Stopping.`);
                process.exit(1);
                break;
            case 'MarketIsClosed':
                console.warn(`[${new Date().toISOString()}] ⏸️ Market closed. Retrying in 5min...`);
                setTimeout(() => this.state.activeTrade = false, 300000);
                break;
            default:
                console.error(`[${new Date().toISOString()}] ❌ Unknown error code:`, error.code);
        }
    }

    // ==================== TICK HANDLING & STRATEGY ====================
    subscribeToTicks() {
        console.log(`[${new Date().toISOString()}] 📡 Subscribing to ${this.config.symbol} ticks...`);
        this.sendMessage({
            ticks: this.config.symbol,
            subscribe: 1
        });
    }

    handleTick(tick) {
        // Update price history
        this.state.tickHistory.push(tick.quote);
        if (this.state.tickHistory.length > 100) {
            this.state.tickHistory.shift();
        }

        // Calculate indicators
        this.calculateIndicators();

        // Check if we can trade
        if (this.canTrade()) {
            this.checkSignal();
        }

        // Log status every 10 ticks
        if (this.state.tickHistory.length % 10 === 0) {
            this.logStatus();
        }
    }

    calculateIndicators() {
        const prices = this.state.tickHistory;
        if (prices.length < 51) return;

        // Calculate EMAs
        this.state.indicators.ema20 = this.calculateEMA(prices, 20, this.state.indicators.ema20);
        this.state.indicators.ema50 = this.calculateEMA(prices, 50, this.state.indicators.ema50);

        // Calculate RSI
        this.state.indicators.rsi = this.calculateRSI(prices, 14);
    }

    calculateEMA(prices, period, previousEMA) {
        const multiplier = 2 / (period + 1);
        const currentPrice = prices[prices.length - 1];

        if (!previousEMA) {
            // Initial SMA
            const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
            return sum / period;
        }

        return (currentPrice * multiplier) + (previousEMA * (1 - multiplier));
    }

    calculateRSI(prices, period) {
        if (prices.length < period + 1) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) {
                gains += change;
            } else {
                losses -= change;
            }
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    canTrade() {
        // Check if already in a trade
        if (this.state.activeTrade) return false;

        // Check daily profit target
        if (this.state.dailyPnL >= this.state.dailyStartBalance * this.config.dailyProfitTarget) {
            console.log(`[${new Date().toISOString()}] 🎯 Daily profit target reached. Stopping.`);
            return false;
        }

        // Check daily loss limit
        if (this.state.dailyPnL <= -this.state.dailyStartBalance * this.config.dailyLossLimit) {
            console.log(`[${new Date().toISOString()}] 🛑 Daily loss limit hit. Stopping.`);
            return false;
        }

        // Check max drawdown
        const drawdown = (this.state.equityPeak - this.state.equity) / this.state.equityPeak;
        if (drawdown > this.config.maxDrawdownPercent) {
            console.log(`[${new Date().toISOString()}] ⚠️ Max drawdown exceeded: ${(drawdown * 100).toFixed(2)}%`);
        }

        return true;
    }

    checkSignal() {
        const price = this.state.tickHistory[this.state.tickHistory.length - 1];
        const ema20 = this.state.indicators.ema20;
        const ema50 = this.state.indicators.ema50;
        const rsi = this.state.indicators.rsi;

        // LONG SIGNAL: Price > EMA20 > EMA50 AND RSI 50-70
        if (price > ema20 && ema20 > ema50 && rsi > 50 && rsi < 70) {
            this.executeTrade('CALL');
        }
        // SHORT SIGNAL: Price < EMA20 < EMA50 AND RSI 30-50
        else if (price < ema20 && ema20 < ema50 && rsi > 30 && rsi < 50) {
            this.executeTrade('PUT');
        }
    }

    executeTrade(direction) {
        this.state.activeTrade = true;
        this.state.tradeDirection = direction;

        // Calculate stake with drawdown protection
        let stake = this.calculateStake();

        // Store stake for trade tracking
        this.state.tradeStake = stake;

        console.log(`[${new Date().toISOString()}] 📊 SIGNAL: ${direction.toUpperCase()} detected`);
        console.log(`[${new Date().toISOString()}] 📊 Price: ${this.state.tickHistory[this.state.tickHistory.length - 1].toFixed(4)} | EMA20: ${this.state.indicators.ema20.toFixed(4)} | EMA50: ${this.state.indicators.ema50.toFixed(4)} | RSI: ${this.state.indicators.rsi.toFixed(2)}`);

        // Send proposal
        this.sendMessage({
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: direction,
            currency: 'USD',
            duration: 1, // 1 tick for multipliers, but using Rise/Fall
            duration_unit: 't',
            symbol: this.config.symbol,
            product_type: 'basic' // For Rise/Fall
        });
    }

    calculateStake() {
        const baseStake = this.state.balance * this.config.stakePercent;

        // Apply drawdown protection
        const drawdown = (this.state.equityPeak - this.state.equity) / this.state.equityPeak;
        if (drawdown > this.config.maxDrawdownPercent) {
            const protectedStake = baseStake * 0.5;
            console.log(`[${new Date().toISOString()}] ⚠️ Drawdown protection active. Stake reduced: $${protectedStake.toFixed(2)}`);
            return protectedStake;
        }

        return baseStake;
    }

    handleTradeResult(contract) {
        const profit = parseFloat(contract.profit);
        const won = profit > 0;

        // Update state
        this.state.activeTrade = false;
        this.state.dailyPnL += profit;
        this.state.balance += profit;
        this.state.equity = this.state.balance;

        // Update equity peak
        if (this.state.equity > this.state.equityPeak) {
            this.state.equityPeak = this.state.equity;
        }

        // Log result
        console.log(`[${new Date().toISOString()}] 📈 TRADE RESULT: ${won ? '✅ WIN' : '❌ LOSS'}`);
        console.log(`[${new Date().toISOString()}] 💰 Profit: $${profit.toFixed(2)} | Balance: $${this.state.balance.toFixed(2)} | Daily P&L: $${this.state.dailyPnL.toFixed(2)}`);
    }

    logStatus() {
        const price = this.state.tickHistory[this.state.tickHistory.length - 1] || 0;
        const ema20 = this.state.indicators.ema20 || 0;
        const ema50 = this.state.indicators.ema50 || 0;
        const rsi = this.state.indicators.rsi || 0;
        const drawdown = (this.state.equityPeak - this.state.equity) / this.state.equityPeak;

        console.log(`[${new Date().toISOString()}] 💓 STATUS | Price: ${price.toFixed(4)} | EMA20: ${ema20.toFixed(4)} | EMA50: ${ema50.toFixed(4)} | RSI: ${rsi.toFixed(2)} | Balance: $${this.state.balance.toFixed(2)} | DD: ${(drawdown * 100).toFixed(2)}%`);
    }
}

// ==================== BOT INITIALIZATION ====================
if (require.main === module) {
    // Load config from environment
    const config = {
        token: 'DMylfkyce6VyZt7',
        appId: '1089'
    };

    if (!config.token) {
        console.error('❌ DERIV_TOKEN environment variable is required');
        console.error('   Set it: export DERIV_TOKEN="your_token_here"');
        process.exit(1);
    }

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║     Deriv V75 Index Algorithmic Trading Bot                  ║
║     Strategy: EMA-RSI Momentum with Aggressive Risk Mgmt    ║
╚══════════════════════════════════════════════════════════════╝
  `);

    const bot = new DerivBot(config);

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log(`\n[${new Date().toISOString()}] 🛑 Shutting down gracefully...`);
        bot.stopHeartbeat();
        process.exit(0);
    });
}

module.exports = DerivBot;