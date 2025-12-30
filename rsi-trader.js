#!/usr/bin/env node

/*
 * DERIV MULTIPLIER TRADING BOT
 * ========================================
 * Single-file automated trading bot for Deriv.com Multiplier contracts
 * Features: Risk Management, Money Management, Detailed Logging, Automated Strategy
 * 
 * USAGE:
 *   npm install ws winston
 *   node deriv-bot.js
 * 
 * CONFIGURATION:
 *   Set your credentials in the CONFIG section below
 */

// ============================================================
// DEPENDENCIES
// ============================================================
const WebSocket = require('ws');
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION - EDIT THESE VALUES
// ============================================================
const CONFIG = {
    // DERIV API CREDENTIALS
    DERIV_TOKEN: 'rgNedekYXvCaPeP', // Get from: deriv.com > Account Settings > API Token
    DERIV_WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',

    // TRADING PARAMETERS
    SYMBOL: 'R_100', // Synthetic Index: R_100 (Volatility 100 Index)
    MULTIPLIER: 100, // Multiplier value (10-2000 depending on symbol)
    CONTRACT_TYPE: 'MULTUP', // MULTUP or MULTDOWN

    // RISK MANAGEMENT (CRITICAL - ADJUST CAREFULLY)
    RISK_PERCENT_PER_TRADE: 0.02, // 2% of account balance per trade (0.01 = 1%)
    MIN_STAKE: 1, // Minimum stake in USD
    MAX_STAKE: 100, // Maximum stake in USD
    MAX_DAILY_LOSS_PERCENT: 0.05, // 5% max daily loss (bot stops)
    MAX_CONSECUTIVE_LOSSES: 3, // Stop after consecutive losses

    // REWARD CONFIGURATION
    TAKE_PROFIT_PERCENT: 0.50, // 50% profit target (0.5 = 50% of stake)
    STOP_LOSS_PERCENT: 0.85, // 85% of stake as stop loss
    DEAL_CANCELLATION: null, // null, '5m', '10m', '15m', '30m', '60m' (only for volatility indices)

    // MONEY MANAGEMENT
    COMPOUNDING_ENABLED: true, // true = stake based on current balance, false = fixed stake
    BASE_STAKE: 10, // Fixed stake if compounding is disabled

    // TRADING STRATEGY (RSI-Based)
    STRATEGY: {
        RSI_PERIOD: 14,
        OVERSOLD: 30,
        OVERBOUGHT: 70,
        MIN_SIGNAL_STRENGTH: 3, // Min consecutive ticks for signal
        TICK_HISTORY_SIZE: 100, // Number of ticks to analyze
    },

    // TIMING
    TRADE_COOLDOWN_MS: 5000, // Wait between trades (ms)
    HEARTBEAT_INTERVAL_MS: 30000, // Heartbeat ping interval

    // LOGGING
    LOG_LEVEL: 'info', // error, warn, info, debug
    LOG_FILE_ENABLED: true,
    LOG_FILE_MAX_SIZE: '10m',
    LOG_FILE_MAX_FILES: '5',
};

// ============================================================
// LOGGER SETUP
// ============================================================
const logger = winston.createLogger({
    level: CONFIG.LOG_LEVEL,
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
            let logMessage = `[${timestamp}] ${level.toUpperCase().padEnd(5)}: ${message}`;
            if (stack) logMessage += `\n${stack}`;
            if (Object.keys(meta).length > 0) {
                logMessage += ` | ${JSON.stringify(meta, null, 2)}`;
            }
            return logMessage;
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ],
});

// Add file transport if enabled
if (CONFIG.LOG_FILE_ENABLED) {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
        console.log(`Created log directory: ${logDir}`);
    }

    logger.add(new winston.transports.File({
        filename: path.join(logDir, 'bot-error.log'),
        level: 'error',
        maxsize: CONFIG.LOG_FILE_MAX_SIZE,
        maxFiles: CONFIG.LOG_FILE_MAX_FILES,
    }));

    logger.add(new winston.transports.File({
        filename: path.join(logDir, 'bot-combined.log'),
        maxsize: CONFIG.LOG_FILE_MAX_SIZE,
        maxFiles: CONFIG.LOG_FILE_MAX_FILES,
    }));
}

// Logger for trades specifically
const tradeLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({
            filename: path.join(__dirname, 'logs', 'trades.log'),
            maxsize: CONFIG.LOG_FILE_MAX_SIZE,
            maxFiles: CONFIG.LOG_FILE_MAX_FILES,
        })
    ]
});

// ============================================================
// DERIV API CLIENT
// ============================================================
class DerivAPIClient {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.balance = 0;
        this.currency = 'USD';
        this.activeSymbol = null;
        this.contractsFor = null;
        this.ticks = [];
        this.proposal = null;
        this.activeContract = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.heartbeatInterval = null;
        this.messageQueue = [];
    }

    connect() {
        return new Promise((resolve, reject) => {
            try {
                this.logger.info(`Connecting to Deriv API: ${this.config.DERIV_WS_URL}`);
                this.ws = new WebSocket(this.config.DERIV_WS_URL);

                this.ws.on('open', () => {
                    this.logger.info('✅ WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.startHeartbeat();
                    resolve();
                });

                this.ws.on('message', (data) => this.handleMessage(data));
                this.ws.on('close', () => this.handleDisconnect());
                this.ws.on('error', (error) => this.handleError(error));

            } catch (error) {
                this.logger.error('Failed to initialize WebSocket', error);
                reject(error);
            }
        });
    }

    disconnect() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.ws) {
            this.ws.close();
            this.isConnected = false;
            this.isAuthorized = false;
        }
    }

    send(message) {
        if (!this.isConnected) {
            this.logger.warn('Message queued (not connected):', message);
            this.messageQueue.push(message);
            return;
        }

        try {
            const messageStr = JSON.stringify(message);
            this.logger.debug(`SEND: ${messageStr}`);
            this.ws.send(messageStr);
        } catch (error) {
            this.logger.error('Failed to send message', error);
        }
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            this.logger.debug(`RECV: ${JSON.stringify(message)}`);

            // Handle message by type
            if (message.error) {
                this.logger.error('API Error:', message.error);
                return;
            }

            if (message.msg_type === 'authorize') {
                this.handleAuthorize(message);
            } else if (message.msg_type === 'balance') {
                this.handleBalance(message);
            } else if (message.msg_type === 'active_symbols') {
                this.handleActiveSymbols(message);
            } else if (message.msg_type === 'contracts_for') {
                this.handleContractsFor(message);
            } else if (message.msg_type === 'proposal') {
                this.handleProposal(message);
            } else if (message.msg_type === 'buy') {
                this.handleBuy(message);
            } else if (message.msg_type === 'proposal_open_contract') {
                this.handleOpenContract(message);
            } else if (message.msg_type === 'sell') {
                this.handleSell(message);
            } else if (message.msg_type === 'tick') {
                this.handleTick(message);
            } else if (message.msg_type === 'transaction') {
                this.handleTransaction(message);
            }

        } catch (error) {
            this.logger.error('Failed to handle message', error);
        }
    }

    handleAuthorize(message) {
        if (message.authorize) {
            this.isAuthorized = true;
            this.logger.info('✅ Authorization successful', {
                accountId: message.authorize.loginid,
                balance: message.authorize.balance
            });

            // Subscribe to balance updates
            this.send({ balance: 1, subscribe: 1 });

            // Get active symbols
            this.send({ active_symbols: 'brief', product_type: 'basic' });

            // Flush message queue
            this.flushMessageQueue();
        }
    }

    handleBalance(message) {
        if (message.balance) {
            const newBalance = parseFloat(message.balance.balance);
            const oldBalance = this.balance;
            this.balance = newBalance;
            this.currency = message.balance.currency;

            if (oldBalance !== 0 && oldBalance !== newBalance) {
                const change = ((newBalance - oldBalance) / oldBalance * 100).toFixed(2);
                this.logger.info(`💰 Balance update: ${newBalance.toFixed(2)} ${this.currency} (${change > 0 ? '+' : ''}${change}%)`);
            } else {
                this.logger.info(`💰 Current balance: ${newBalance.toFixed(2)} ${this.currency}`);
            }
        }
    }

    handleActiveSymbols(message) {
        if (message.active_symbols) {
            this.activeSymbol = message.active_symbols.find(s => s.symbol === this.config.SYMBOL);
            if (this.activeSymbol) {
                this.logger.info(`✅ Symbol loaded: ${this.activeSymbol.display_name} (${this.activeSymbol.symbol})`);
                this.getContractsFor();
            } else {
                this.logger.error(`Symbol ${this.config.SYMBOL} not found`);
            }
        }
    }

    handleContractsFor(message) {
        if (message.contracts_for) {
            this.contractsFor = message.contracts_for;
            this.logger.info(`✅ Contracts loaded for ${this.config.SYMBOL}`);
            this.subscribeTicks();
        }
    }

    handleProposal(message) {
        if (message.proposal) {
            this.proposal = message.proposal;
            this.logger.debug(`Proposal received: ID=${message.proposal.id}, Ask=${message.proposal.ask_price}`);
        }
    }

    handleBuy(message) {
        if (message.buy) {
            this.logger.info('🎫 Contract purchased successfully', {
                contractId: message.buy.contract_id,
                longcode: message.buy.longcode,
                buyPrice: message.buy.buy_price
            });
            this.activeContract = {
                contractId: message.buy.contract_id,
                startTime: Date.now(),
                stake: this.lastStake,
                targetProfit: this.lastTargetProfit,
                stopLoss: this.lastStopLoss
            };
            tradeLogger.info('TRADE_BUY', {
                contractId: message.buy.contract_id,
                symbol: this.config.SYMBOL,
                contractType: this.config.CONTRACT_TYPE,
                stake: this.lastStake,
                multiplier: this.config.MULTIPLIER,
                takeProfit: this.lastTargetProfit,
                stopLoss: this.lastStopLoss,
                balance: this.balance
            });
        }
    }

    handleOpenContract(message) {
        if (message.proposal_open_contract) {
            const contract = message.proposal_open_contract;

            // Check if contract is sold/closed
            if (contract.is_sold) {
                this.handleContractClose(contract);
            } else {
                // Log contract progress periodically
                const profit = parseFloat(contract.profit);
                const profitPercent = (profit / this.activeContract.stake * 100).toFixed(2);
                this.logger.debug(`Contract ${contract.contract_id} progress: ${profitPercent}% (${profit.toFixed(2)} USD)`);
            }
        }
    }

    handleContractClose(contract) {
        const profit = parseFloat(contract.profit);
        const profitPercent = (profit / this.activeContract.stake * 100).toFixed(2);
        const isWin = profit > 0;

        this.logger.info(`🏁 Contract closed: ${isWin ? 'WIN ✅' : 'LOSS ❌'}`, {
            contractId: contract.contract_id,
            profit: profit.toFixed(2),
            profitPercent: `${profitPercent}%`,
            finalPrice: contract.exit_tick,
            duration: `${((Date.now() - this.activeContract.startTime) / 1000).toFixed(1)}s`
        });

        tradeLogger.info('TRADE_SELL', {
            contractId: contract.contract_id,
            profit: profit,
            profitPercent: profitPercent,
            isWin: isWin,
            finalPrice: contract.exit_tick,
            duration: (Date.now() - this.activeContract.startTime) / 1000,
            balance: this.balance
        });

        // Emit event for bot to handle
        if (this.onContractClosed) {
            this.onContractClosed({ profit, profitPercent, isWin });
        }

        this.activeContract = null;
    }

    handleSell(message) {
        if (message.sell) {
            this.logger.info('💵 Contract sold manually', {
                soldFor: message.sell.sold_for,
                profit: message.sell.profit
            });
        }
    }

    handleTick(message) {
        if (message.tick) {
            const tick = {
                epoch: message.tick.epoch,
                quote: parseFloat(message.tick.quote),
                pipSize: message.tick.pip_size
            };

            this.ticks.push(tick);
            if (this.ticks.length > this.config.STRATEGY.TICK_HISTORY_SIZE) {
                this.ticks.shift(); // Keep array size limited
            }

            // Emit tick event for strategy
            if (this.onTick) {
                this.onTick(tick);
            }
        }
    }

    handleTransaction(message) {
        if (message.transaction) {
            this.logger.debug('Transaction update', message.transaction);
        }
    }

    handleDisconnect() {
        this.logger.warn('⚠️ WebSocket disconnected');
        this.isConnected = false;
        this.isAuthorized = false;
        this.stopHeartbeat();

        // Attempt reconnection
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            this.logger.info(`Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        } else {
            this.logger.error('❌ Max reconnection attempts reached');
        }
    }

    handleError(error) {
        this.logger.error('WebSocket error', error);
    }

    flushMessageQueue() {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            this.send(message);
        }
    }

    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.send({ ping: 1 });
        }, this.config.HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    // API Methods
    authorize() {
        this.logger.info('🔑 Authorizing...');
        this.send({ authorize: this.config.DERIV_TOKEN });
    }

    getContractsFor() {
        if (this.activeSymbol) {
            this.logger.info(`📋 Loading contracts for ${this.activeSymbol.symbol}...`);
            this.send({ contracts_for: this.activeSymbol.symbol });
        }
    }

    subscribeTicks() {
        this.logger.info(`📈 Subscribing to ticks: ${this.config.SYMBOL}`);
        this.send({ ticks: this.config.SYMBOL, subscribe: 1 });
        this.ticks = []; // Reset tick history
    }

    unsubscribeTicks() {
        this.send({ forget_all: 'ticks' });
    }

    calculateStake() {
        if (!this.config.COMPOUNDING_ENABLED) {
            return Math.min(this.config.BASE_STAKE, this.config.MAX_STAKE);
        }

        const stake = this.balance * this.config.RISK_PERCENT_PER_TRADE;
        return Math.max(this.config.MIN_STAKE, Math.min(stake, this.config.MAX_STAKE));
    }

    getProposal() {
        const stake = parseFloat(this.calculateStake().toFixed(2));
        const limitOrder = {
            take_profit: parseFloat((stake * this.config.TAKE_PROFIT_PERCENT).toFixed(2)),
            stop_loss: parseFloat((stake * this.config.STOP_LOSS_PERCENT).toFixed(2))
        };

        this.lastStake = stake;
        this.lastTargetProfit = limitOrder.take_profit;
        this.lastStopLoss = limitOrder.stop_loss;

        const proposal = {
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: this.CONTRACT_TYPE,
            currency: this.currency,
            multiplier: this.config.MULTIPLIER,
            symbol: this.config.SYMBOL,
            limit_order: limitOrder
        };

        // Add deal cancellation if configured
        if (this.config.DEAL_CANCELLATION) {
            proposal.cancellation = this.config.DEAL_CANCELLATION;
        }

        this.logger.info('📤 Requesting proposal', {
            symbol: this.config.SYMBOL,
            stake: stake,
            multiplier: this.config.MULTIPLIER,
            takeProfit: limitOrder.take_profit,
            stopLoss: limitOrder.stop_loss,
            contractType: this.CONTRACT_TYPE
        });

        this.send(proposal);
    }

    buy(proposalId) {
        if (proposalId) {
            this.logger.info('🛒 Buying contract...');
            this.send({ buy: proposalId, price: 100 }); // Price is max you're willing to pay
        }
    }

    sell(contractId) {
        if (contractId) {
            this.logger.info('💵 Selling contract...', { contractId });
            this.send({ sell: contractId, price: 100 });
        }
    }
}

// ============================================================
// TRADING STRATEGY (RSI-Based)
// ============================================================
class RSIStrategy {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.tickHistory = [];
        this.signalStrength = 0;
        this.lastSignal = null;
    }

    calculateRSI(period = 14) {
        if (this.tickHistory.length < period + 1) return null;

        const prices = this.tickHistory.map(t => t.quote);
        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));

        return rsi;
    }

    onTick(tick) {
        this.tickHistory.push(tick);

        // Keep only necessary history
        if (this.tickHistory.length > this.config.STRATEGY.TICK_HISTORY_SIZE) {
            this.tickHistory.shift();
        }

        // Need enough data for RSI calculation
        if (this.tickHistory.length < this.config.STRATEGY.RSI_PERIOD + 1) {
            this.logger.debug(`Collecting ticks... ${this.tickHistory.length}/${this.config.STRATEGY.RSI_PERIOD + 1}`);
            return null;
        }

        const rsi = this.calculateRSI(this.config.STRATEGY.RSI_PERIOD);
        if (rsi === null) return null;

        this.logger.debug(`RSI: ${rsi.toFixed(2)}`);

        // Generate signals
        let signal = null;

        if (rsi < this.config.STRATEGY.OVERSOLD) {
            signal = 'MULTUP'; // Oversold - buy signal
        } else if (rsi > this.config.STRATEGY.OVERBOUGHT) {
            signal = 'MULTDOWN'; // Overbought - sell signal
        }

        // Check signal strength (consecutive signals)
        if (signal === this.lastSignal) {
            this.signalStrength++;
        } else {
            this.signalStrength = 1;
            this.lastSignal = signal;
        }

        // Return signal if strength is sufficient
        if (signal && this.signalStrength >= this.config.STRATEGY.MIN_SIGNAL_STRENGTH) {
            this.logger.info(`🎯 Trade signal: ${signal} (RSI: ${rsi.toFixed(2)}, Strength: ${this.signalStrength})`);
            return signal;
        }

        return null;
    }

    reset() {
        this.signalStrength = 0;
        this.lastSignal = null;
    }
}

// ============================================================
// MAIN TRADING BOT
// ============================================================
class DerivBot {
    constructor(config) {
        this.config = config;
        this.logger = logger;
        this.client = new DerivAPIClient(config, logger);
        this.strategy = new RSIStrategy(config, logger);

        // Bot state
        this.isRunning = false;
        this.dailyLoss = 0;
        this.consecutiveLosses = 0;
        this.tradeCount = 0;
        this.winCount = 0;
        this.lastTradeTime = 0;

        // Bind event handlers
        this.client.onTick = (tick) => this.onTick(tick);
        this.client.onContractClosed = (result) => this.onContractClosed(result);

        // Shutdown handler
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    async start() {
        this.logger.info('🚀 Starting Deriv Multiplier Trading Bot...');
        this.logger.info('Configuration', {
            symbol: this.config.SYMBOL,
            multiplier: this.config.MULTIPLIER,
            riskPerTrade: `${(this.config.RISK_PERCENT_PER_TRADE * 100).toFixed(2)}%`,
            maxDailyLoss: `${(this.config.MAX_DAILY_LOSS_PERCENT * 100).toFixed(2)}%`
        });

        try {
            await this.client.connect();
            this.client.authorize();

            this.isRunning = true;
            this.logger.info('✅ Bot started successfully');

        } catch (error) {
            this.logger.error('❌ Failed to start bot', error);
            this.shutdown();
        }
    }

    shutdown() {
        this.logger.info('🛑 Shutting down bot...');
        this.isRunning = false;

        if (this.client.activeContract) {
            this.logger.warn('Closing active contract before shutdown');
            this.client.sell(this.client.activeContract.contractId);
        }

        this.client.unsubscribeTicks();
        this.client.disconnect();

        this.printPerformanceReport();

        setTimeout(() => {
            this.logger.info('👋 Bot stopped. Goodbye!');
            process.exit(0);
        }, 2000);
    }

    onTick(tick) {
        if (!this.isRunning) return;
        if (this.client.activeContract) return; // Wait for active contract to close

        // Check trade cooldown
        const now = Date.now();
        if (now - this.lastTradeTime < this.config.TRADE_COOLDOWN_MS) {
            return;
        }

        // Generate trading signal
        const signal = this.strategy.onTick(tick);

        if (signal) {
            // Update contract type based on signal
            this.client.CONTRACT_TYPE = signal;

            // Check risk limits before trading
            if (!this.checkRiskLimits()) {
                return;
            }

            // Get proposal and buy
            this.client.getProposal();

            // Wait for proposal, then buy
            setTimeout(() => {
                if (this.client.proposal) {
                    this.client.buy(this.client.proposal.id);
                    this.lastTradeTime = Date.now();
                    this.tradeCount++;
                }
            }, 1000);
        }
    }

    onContractClosed(result) {
        // Update statistics
        this.dailyLoss += result.profit;

        if (result.isWin) {
            this.winCount++;
            this.consecutiveLosses = 0;
            this.logger.info(`🏆 Win! Profit: +${result.profit.toFixed(2)} USD`);
        } else {
            this.consecutiveLosses++;
            this.logger.warn(`💸 Loss. Profit: ${result.profit.toFixed(2)} USD`);
        }

        // Check daily loss limit
        const maxDailyLoss = this.config.MAX_DAILY_LOSS_PERCENT * this.client.balance;
        if (this.dailyLoss <= -maxDailyLoss) {
            this.logger.error(`☠️ Daily loss limit reached! Stopping trading.`);
            this.logger.error(`Daily loss: ${this.dailyLoss.toFixed(2)} USD, Limit: ${maxDailyLoss.toFixed(2)} USD`);
            this.isRunning = false;
        }

        // Check consecutive losses
        if (this.consecutiveLosses >= this.config.MAX_CONSECUTIVE_LOSSES) {
            this.logger.error(`☠️ Max consecutive losses (${this.config.MAX_CONSECUTIVE_LOSSES}) reached! Stopping trading.`);
            this.isRunning = false;
        }

        // Print performance update
        this.printPerformanceUpdate();
    }

    checkRiskLimits() {
        // Check balance
        if (this.client.balance < this.config.MIN_STAKE) {
            this.logger.error('❌ Insufficient balance to trade');
            return false;
        }

        // Check daily loss
        const maxDailyLoss = this.config.MAX_DAILY_LOSS_PERCENT * this.client.balance;
        if (this.dailyLoss <= -maxDailyLoss) {
            if (this.isRunning) {
                this.logger.error(`Daily loss limit exceeded. Trading stopped.`);
                this.isRunning = false;
            }
            return false;
        }

        // Check consecutive losses
        if (this.consecutiveLosses >= this.config.MAX_CONSECUTIVE_LOSSES) {
            if (this.isRunning) {
                this.logger.error(`Max consecutive losses reached. Trading stopped.`);
                this.isRunning = false;
            }
            return false;
        }

        return true;
    }

    printPerformanceUpdate() {
        const winRate = this.tradeCount > 0 ? (this.winCount / this.tradeCount * 100).toFixed(2) : 0;
        this.logger.info('📊 Performance Update', {
            trades: this.tradeCount,
            wins: this.winCount,
            losses: this.tradeCount - this.winCount,
            winRate: `${winRate}%`,
            dailyProfit: this.dailyLoss.toFixed(2),
            balance: this.client.balance.toFixed(2)
        });
    }

    printPerformanceReport() {
        this.logger.info('═══════════════════════════════════════════════════');
        this.logger.info('📈 FINAL PERFORMANCE REPORT');
        this.logger.info('═══════════════════════════════════════════════════');
        this.logger.info(`Total Trades:     ${this.tradeCount}`);
        this.logger.info(`Wins:             ${this.winCount}`);
        this.logger.info(`Losses:           ${this.tradeCount - this.winCount}`);
        this.logger.info(`Win Rate:         ${this.tradeCount > 0 ? (this.winCount / this.tradeCount * 100).toFixed(2) : 0}%`);
        this.logger.info(`Daily P&L:        ${this.dailyLoss.toFixed(2)} USD`);
        this.logger.info(`Final Balance:    ${this.client.balance.toFixed(2)} USD`);
        this.logger.info('═══════════════════════════════════════════════════');
    }
}

// ============================================================
// VALIDATION & STARTUP
// ============================================================
function validateConfig() {
    logger.info('🔍 Validating configuration...');

    if (!CONFIG.DERIV_TOKEN || CONFIG.DERIV_TOKEN === 'your_deriv_api_token_here') {
        logger.error('❌ DERIV_TOKEN is not set! Get your token from: deriv.com > Account Settings > API Token');
        process.exit(1);
    }

    if (CONFIG.RISK_PERCENT_PER_TRADE > 0.05) {
        logger.warn('⚠️  Risk per trade exceeds 5%. This is extremely risky!');
    }

    if (CONFIG.MAX_DAILY_LOSS_PERCENT > 0.1) {
        logger.warn('⚠️  Max daily loss exceeds 10%. Consider reducing for safety.');
    }

    logger.info('✅ Configuration validated');
}

// ============================================================
// MAIN EXECUTION
// ============================================================
if (require.main === module) {
    // Run bot directly
    validateConfig();

    const bot = new DerivBot(CONFIG);

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught Exception', error);
        bot.shutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
        bot.shutdown();
    });

    // Start bot
    bot.start().catch(error => {
        logger.error('Failed to start bot', error);
        process.exit(1);
    });
}

// Export for module usage
module.exports = { DerivBot, CONFIG, logger };

/* 
 * ========================================
 * INSTRUCTIONS:
 * 1. Install dependencies: npm install ws winston
 * 2. Get API token from Deriv: deriv.com > Account Settings > API Token
 * 3. Configure settings in the CONFIG section above
 * 4. Run: node deriv-bot.js
 * 5. Monitor logs in logs/ directory
 * 
 * IMPORTANT RISK WARNING:
 * - This bot trades with real money
 * - Start with DEMO account first!
 * - Never risk more than you can afford to lose
 * - Past performance doesn't guarantee future results
 * - Use appropriate risk settings (2% or less per trade)
 * ========================================
 */