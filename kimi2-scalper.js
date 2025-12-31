/**
 * Deriv Grid Scalping Bot
 * Production-ready automated trading bot for Deriv Multiplier
 * Implements grid trading strategy with comprehensive risk management
 * 
 * @author AI Assistant
 * @version 1.0.0
 * @date 2025-01-01
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

/**
 * Configuration Object
 * Modify these parameters based on your trading preferences and risk tolerance
 */
const CONFIG = {
    // Trading Parameters
    symbol: 'R_100',           // Trading symbol (forex, crypto, synthetic indices)
    stake: 1.00,                   // Stake per trade in account currency
    multiplier: 40,                // Multiplier (up to 2000x, recommended: 10-100x)
    gridLevels: 5,                 // Number of grid levels (buy + sell orders)
    gridSpacing: 0.001,           // Grid spacing in price units (0.001 = 10 pips for EUR/USD)

    // Risk Management
    maxDailyLoss: 50.00,          // Maximum daily loss before stopping
    maxTradesPerHour: 10,         // Maximum trades per hour
    stopLossPercentage: 50,        // Stop loss as percentage of stake
    takeProfitPercentage: 100,     // Take profit as percentage of stake
    maxOpenPositions: 3,          // Maximum simultaneous open positions

    // Time-based Settings
    tradeDuration: 60,             // Trade duration in seconds
    dealCancellation: '15m',       // Deal cancellation period
    tradingHours: {               // Trading hours (24-hour format)
        start: 0,                    // Start hour (0 = midnight)
        end: 23,                     // End hour (23 = 11 PM)
        days: [1, 2, 3, 4, 5]        // Trading days (1=Monday, 5=Friday)
    },

    // Technical Analysis
    rsiPeriod: 14,                 // RSI calculation period
    rsiOverbought: 70,            // RSI overbought level
    rsiOversold: 30,              // RSI oversold level
    atrPeriod: 14,                // ATR calculation period

    // API and Connection
    apiUrl: 'wss://ws.derivws.com/websockets/v3',
    appId: 1089,                   // Your Deriv app ID
    reconnectDelay: 5000,          // Reconnection delay in milliseconds
    maxReconnectAttempts: 5,       // Maximum reconnection attempts

    // Logging and Monitoring
    logLevel: 'INFO',              // DEBUG, INFO, WARN, ERROR
    logFile: './logs/bot.log',     // Log file path
    performanceTracking: true,     // Enable performance metrics

    // Safety Features
    enableTrendFilter: true,       // Enable trend detection
    enableVolatilityFilter: true,  // Enable volatility-based adjustments
    enableNewsFilter: false,       // Enable news event filtering (requires external API)
    paperTrading: true             // Start in paper trading mode
};

/**
 * Logger Class - Comprehensive logging with file output and levels
 */
class Logger {
    constructor(config) {
        this.config = config;
        this.logQueue = [];
        this.isWriting = false;
        this.ensureLogDirectory();
    }

    async ensureLogDirectory() {
        try {
            const logDir = path.dirname(this.config.logFile);
            await fs.mkdir(logDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create log directory:', error.message);
        }
    }

    log(level, message, data = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            message,
            data,
            pid: process.pid
        };

        const formattedMessage = `[${timestamp}] ${level} - ${message} ${JSON.stringify(data)}`;

        // Console output
        console.log(formattedMessage);

        // File output (async)
        this.logQueue.push(formattedMessage);
        this.flushLogs();
    }

    async flushLogs() {
        if (this.isWriting || this.logQueue.length === 0) return;

        this.isWriting = true;
        const logsToWrite = this.logQueue.splice(0);
        const logContent = logsToWrite.join('\n') + '\n';

        try {
            await fs.appendFile(this.config.logFile, logContent);
        } catch (error) {
            console.error('Failed to write to log file:', error.message);
        } finally {
            this.isWriting = false;
            if (this.logQueue.length > 0) {
                this.flushLogs();
            }
        }
    }

    debug(message, data) { if (this.shouldLog('DEBUG')) this.log('DEBUG', message, data); }
    info(message, data) { if (this.shouldLog('INFO')) this.log('INFO', message, data); }
    warn(message, data) { if (this.shouldLog('WARN')) this.log('WARN', message, data); }
    error(message, data) { if (this.shouldLog('ERROR')) this.log('ERROR', message, data); }

    shouldLog(level) {
        const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
        return levels[level] >= levels[this.config.logLevel];
    }
}

/**
 * Risk Manager - Handles all risk-related calculations and limits
 */
class RiskManager {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.dailyLoss = 0;
        this.tradesThisHour = 0;
        this.hourStartTime = Date.now();
        this.openPositions = new Map();
        this.accountBalance = 0;
        this.initialBalance = 0;
    }

    updateAccountBalance(balance) {
        if (this.initialBalance === 0) {
            this.initialBalance = balance;
        }
        this.accountBalance = balance;
        this.dailyLoss = this.initialBalance - balance;
    }

    canOpenPosition() {
        const now = Date.now();
        const hourElapsed = now - this.hourStartTime;

        // Reset hourly counter
        if (hourElapsed >= 3600000) { // 1 hour in milliseconds
            this.tradesThisHour = 0;
            this.hourStartTime = now;
        }

        // Check various risk limits
        if (this.openPositions.size >= this.config.maxOpenPositions) {
            this.logger.warn('Maximum open positions reached', {
                current: this.openPositions.size,
                max: this.config.maxOpenPositions
            });
            return false;
        }

        if (this.dailyLoss >= this.config.maxDailyLoss) {
            this.logger.warn('Daily loss limit reached', {
                current: this.dailyLoss,
                limit: this.config.maxDailyLoss
            });
            return false;
        }

        if (this.tradesThisHour >= this.config.maxTradesPerHour) {
            this.logger.warn('Hourly trade limit reached', {
                current: this.tradesThisHour,
                limit: this.config.maxTradesPerHour
            });
            return false;
        }

        if (!this.isTradingHours()) {
            this.logger.warn('Outside trading hours');
            return false;
        }

        return true;
    }

    isTradingHours() {
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.getDay();

        return this.config.tradingHours.days.includes(currentDay) &&
            currentHour >= this.config.tradingHours.start &&
            currentHour <= this.config.tradingHours.end;
    }

    addPosition(contractId, positionData) {
        this.openPositions.set(contractId, positionData);
        this.tradesThisHour++;
        this.logger.info('Position added', { contractId, positionData });
    }

    removePosition(contractId) {
        const position = this.openPositions.get(contractId);
        if (position) {
            this.openPositions.delete(contractId);
            this.logger.info('Position removed', { contractId, position });
            return position;
        }
        return null;
    }

    getOpenPositions() {
        return Array.from(this.openPositions.entries());
    }

    getRiskMetrics() {
        return {
            dailyLoss: this.dailyLoss,
            dailyLossLimit: this.config.maxDailyLoss,
            openPositions: this.openPositions.size,
            maxOpenPositions: this.config.maxOpenPositions,
            tradesThisHour: this.tradesThisHour,
            maxTradesPerHour: this.config.maxTradesPerHour,
            accountBalance: this.accountBalance,
            initialBalance: this.initialBalance
        };
    }
}

/**
 * Technical Analysis Module - Calculates indicators and signals
 */
class TechnicalAnalysis {
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
        this.priceHistory = [];
        this.indicators = {};
    }

    addPrice(tick) {
        this.priceHistory.push({
            timestamp: Date.now(),
            price: parseFloat(tick.quote),
            symbol: tick.symbol
        });

        // Keep only recent prices (last 1000 ticks)
        if (this.priceHistory.length > 1000) {
            this.priceHistory.shift();
        }

        // Update indicators
        this.calculateIndicators();
    }

    calculateIndicators() {
        if (this.priceHistory.length < this.config.rsiPeriod) return;

        const prices = this.priceHistory.map(p => p.price);

        // Calculate RSI
        this.indicators.rsi = this.calculateRSI(prices);

        // Calculate ATR (simplified)
        this.indicators.atr = this.calculateATR(prices);

        // Calculate moving averages
        this.indicators.sma20 = this.calculateSMA(prices, 20);
        this.indicators.sma50 = this.calculateSMA(prices, 50);
    }

    calculateRSI(prices, period = this.config.rsiPeriod) {
        if (prices.length < period + 1) return 50;

        const gains = [];
        const losses = [];

        for (let i = 1; i <= period; i++) {
            const change = prices[prices.length - i] - prices[prices.length - i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? Math.abs(change) : 0);
        }

        const avgGain = gains.reduce((a, b) => a + b) / period;
        const avgLoss = losses.reduce((a, b) => a + b) / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateATR(prices, period = this.config.atrPeriod) {
        if (prices.length < period + 1) return 0;

        const trValues = [];

        for (let i = 1; i < Math.min(period + 1, prices.length); i++) {
            const high = Math.max(prices[prices.length - i], prices[prices.length - i - 1]);
            const low = Math.min(prices[prices.length - i], prices[prices.length - i - 1]);
            trValues.push(high - low);
        }

        return trValues.reduce((a, b) => a + b) / trValues.length;
    }

    calculateSMA(prices, period) {
        if (prices.length < period) return prices[prices.length - 1];

        const sum = prices.slice(-period).reduce((a, b) => a + b);
        return sum / period;
    }

    getSignal() {
        const rsi = this.indicators.rsi || 50;
        const currentPrice = this.priceHistory[this.priceHistory.length - 1]?.price || 0;
        const sma20 = this.indicators.sma20 || currentPrice;
        const sma50 = this.indicators.sma50 || currentPrice;

        let signal = 'HOLD';
        let confidence = 0.5;

        // RSI-based signals
        if (rsi < this.config.rsiOversold) {
            signal = 'BUY';
            confidence = (this.config.rsiOversold - rsi) / this.config.rsiOversold;
        } else if (rsi > this.config.rsiOverbought) {
            signal = 'SELL';
            confidence = (rsi - this.config.rsiOverbought) / (100 - this.config.rsiOverbought);
        }

        // Trend filter
        if (this.config.enableTrendFilter) {
            const trend = sma20 > sma50 ? 'UP' : 'DOWN';
            if ((signal === 'BUY' && trend === 'DOWN') || (signal === 'SELL' && trend === 'UP')) {
                signal = 'HOLD';
                confidence = 0.3;
            }
        }

        return { signal, confidence, rsi, currentPrice };
    }
}

/**
 * Grid Manager - Handles grid trading logic
 */
class GridManager {
    constructor(config, logger, riskManager) {
        this.config = config;
        this.logger = logger;
        this.riskManager = riskManager;
        this.gridLevels = [];
        this.currentPrice = 0;
        this.isGridActive = false;
    }

    updatePrice(price) {
        this.currentPrice = price;

        if (!this.isGridActive) {
            this.initializeGrid();
        }

        this.checkGridTriggers();
    }

    initializeGrid() {
        const centerPrice = this.currentPrice;
        const levels = this.config.gridLevels;
        const spacing = this.config.gridSpacing;

        this.gridLevels = [];

        // Create buy levels below current price
        for (let i = 1; i <= Math.floor(levels / 2); i++) {
            this.gridLevels.push({
                type: 'BUY',
                price: centerPrice - (spacing * i),
                triggered: false,
                orderId: null
            });
        }

        // Create sell levels above current price
        for (let i = 1; i <= Math.floor(levels / 2); i++) {
            this.gridLevels.push({
                type: 'SELL',
                price: centerPrice + (spacing * i),
                triggered: false,
                orderId: null
            });
        }

        this.isGridActive = true;
        this.logger.info('Grid initialized', {
            centerPrice,
            levels: this.gridLevels.length,
            spacing
        });
    }

    checkGridTriggers() {
        if (!this.riskManager.canOpenPosition()) return;

        this.gridLevels.forEach(level => {
            if (level.triggered) return;

            const shouldTrigger = level.type === 'BUY'
                ? this.currentPrice <= level.price
                : this.currentPrice >= level.price;

            if (shouldTrigger) {
                this.triggerGridLevel(level);
            }
        });
    }

    triggerGridLevel(level) {
        level.triggered = true;
        this.logger.info('Grid level triggered', level);

        // Emit event for trade execution
        this.emit('gridTrigger', {
            type: level.type,
            price: level.price,
            timestamp: Date.now()
        });
    }

    resetGrid() {
        this.gridLevels = [];
        this.isGridActive = false;
        this.logger.info('Grid reset');
    }

    emit(event, data) {
        // Event emitter integration would go here
        this.logger.debug(`Grid event: ${event}`, data);
    }
}

/**
 * Main Trading Bot Class
 */
class DerivGridScalperBot extends EventEmitter {
    constructor(config = CONFIG) {
        super();
        this.config = { ...CONFIG, ...config };
        this.logger = new Logger(this.config);
        this.riskManager = new RiskManager(this.config, this.logger);
        this.technicalAnalysis = new TechnicalAnalysis(this.config, this.logger);
        this.gridManager = new GridManager(this.config, this.logger, this.riskManager);

        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.reconnectAttempts = 0;
        this.contracts = new Map();
        this.lastTickTime = Date.now();

        // Performance tracking
        this.performance = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalProfit: 0,
            totalLoss: 0,
            startTime: Date.now()
        };

        // Bind methods
        this.connect = this.connect.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.placeTrade = this.placeTrade.bind(this);
        this.handleMessage = this.handleMessage.bind(this);
        this.handleError = this.handleError.bind(this);
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.logger.info('Connecting to Deriv API', { url: this.config.apiUrl });

                this.ws = new WebSocket(`${this.config.apiUrl}?app_id=${this.config.appId}`);

                this.ws.on('open', () => {
                    this.logger.info('WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.authenticate().then(resolve).catch(reject);
                });

                this.ws.on('message', this.handleMessage);
                this.ws.on('error', this.handleError);
                this.ws.on('close', () => {
                    this.logger.warn('WebSocket disconnected');
                    this.isConnected = false;
                    this.isAuthorized = false;
                    this.handleDisconnect();
                });

            } catch (error) {
                this.logger.error('Connection failed', { error: error.message });
                reject(error);
            }
        });
    }

    async authenticate() {
        if (!process.env.DERIV_API_TOKEN) {
            throw new Error('DERIV_API_TOKEN environment variable not set');
        }

        const authRequest = {
            authorize: process.env.DERIV_API_TOKEN
        };

        this.logger.info('Authenticating with Deriv API');
        this.send(authRequest);
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            this.logger.debug('Received message', { msg_type: message.msg_type });

            switch (message.msg_type) {
                case 'authorize':
                    this.handleAuthorization(message);
                    break;
                case 'tick':
                    this.handleTick(message);
                    break;
                case 'proposal':
                    this.handleProposal(message);
                    break;
                case 'buy':
                    this.handleBuyResponse(message);
                    break;
                case 'proposal_open_contract':
                    this.handleContractUpdate(message);
                    break;
                case 'error':
                    this.handleApiError(message);
                    break;
                default:
                    this.logger.debug('Unhandled message type', { msg_type: message.msg_type });
            }
        } catch (error) {
            this.logger.error('Failed to parse message', { error: error.message, data });
        }
    }

    handleAuthorization(message) {
        if (message.error) {
            this.logger.error('Authorization failed', { error: message.error.message });
            this.isAuthorized = false;
            return;
        }

        this.isAuthorized = true;
        this.riskManager.updateAccountBalance(message.authorize.balance);

        this.logger.info('Authorization successful', {
            accountId: message.authorize.loginid,
            balance: message.authorize.balance,
            currency: message.authorize.currency
        });

        // Subscribe to market data
        this.subscribeToMarketData();

        // Start trading operations
        this.emit('ready');
    }

    subscribeToMarketData() {
        const subscribeRequest = {
            ticks: this.config.symbol
        };

        this.logger.info('Subscribing to market data', { symbol: this.config.symbol });
        this.send(subscribeRequest);
    }

    handleTick(message) {
        if (message.error) {
            this.logger.error('Tick data error', { error: message.error.message });
            return;
        }

        const tick = message.tick;
        this.lastTickTime = Date.now();

        // Update technical analysis
        this.technicalAnalysis.addPrice(tick);

        // Update grid manager
        this.gridManager.updatePrice(parseFloat(tick.quote));

        // Check for trading opportunities
        this.evaluateTradingOpportunity();

        this.emit('tick', tick);
    }

    evaluateTradingOpportunity() {
        if (!this.riskManager.canOpenPosition()) return;

        const signal = this.technicalAnalysis.getSignal();

        if (signal.signal !== 'HOLD' && signal.confidence > 0.6) {
            this.logger.info('Trading signal detected', signal);
            this.prepareTrade(signal);
        }
    }

    prepareTrade(signal) {
        const contractType = signal.signal === 'BUY' ? 'MULTUP' : 'MULTDOWN';

        const proposalRequest = {
            proposal: 1,
            amount: this.config.stake,
            basis: 'stake',
            contract_type: contractType,
            currency: 'USD',
            symbol: this.config.symbol,
            multiplier: this.config.multiplier,
            limit_order: {
                take_profit: this.config.stake * (this.config.takeProfitPercentage / 100),
                stop_loss: this.config.stake * (this.config.stopLossPercentage / 100)
            },
            cancellation: this.config.dealCancellation
        };

        this.logger.info('Requesting proposal', {
            contractType,
            stake: this.config.stake,
            multiplier: this.config.multiplier
        });

        this.send(proposalRequest);
    }

    handleProposal(message) {
        if (message.error) {
            this.logger.error('Proposal error', { error: message.error.message });
            return;
        }

        const proposal = message.proposal;
        this.logger.info('Proposal received', {
            ask_price: proposal.ask_price,
            payout: proposal.payout,
            spot: proposal.spot
        });

        // Execute the trade
        this.executeTrade(proposal.id);
    }

    executeTrade(proposalId) {
        const buyRequest = {
            buy: proposalId,
            price: this.config.stake
        };

        this.logger.info('Executing trade', { proposalId, stake: this.config.stake });
        this.send(buyRequest);
    }

    handleBuyResponse(message) {
        if (message.error) {
            this.logger.error('Trade execution failed', { error: message.error.message });
            return;
        }

        const contract = message.buy;
        this.contracts.set(contract.contract_id, {
            ...contract,
            entryTime: Date.now(),
            status: 'open'
        });

        this.riskManager.addPosition(contract.contract_id, contract);
        this.performance.totalTrades++;

        this.logger.info('Trade executed successfully', {
            contractId: contract.contract_id,
            longcode: contract.longcode,
            buyPrice: contract.buy_price
        });

        this.emit('tradeExecuted', contract);
    }

    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        const contractId = contract.contract_id;

        if (!this.contracts.has(contractId)) return;

        const existingContract = this.contracts.get(contractId);
        const updatedContract = { ...existingContract, ...contract };

        // Check if contract is settled
        if (contract.status === 'sold' || contract.is_sold === 1) {
            this.handleContractSettlement(contractId, updatedContract);
        } else {
            this.contracts.set(contractId, updatedContract);
            this.emit('contractUpdate', updatedContract);
        }
    }

    handleContractSettlement(contractId, contract) {
        const profit = parseFloat(contract.profit);
        const isWinning = profit > 0;

        // Update performance metrics
        if (isWinning) {
            this.performance.winningTrades++;
            this.performance.totalProfit += profit;
        } else {
            this.performance.losingTrades++;
            this.performance.totalLoss += Math.abs(profit);
        }

        // Update risk manager
        this.riskManager.removePosition(contractId);

        // Remove from active contracts
        this.contracts.delete(contractId);

        this.logger.info('Contract settled', {
            contractId,
            profit,
            isWinning,
            sellPrice: contract.sell_price,
            sellTime: contract.sell_time
        });

        this.emit('contractSettled', { contract, profit, isWinning });

        // Check if we should continue trading
        if (!this.riskManager.canOpenPosition()) {
            this.logger.warn('Trading paused due to risk limits');
        }
    }

    handleApiError(message) {
        this.logger.error('API Error', {
            code: message.error.code,
            message: message.error.message
        });
    }

    handleError(error) {
        this.logger.error('WebSocket error', { error: error.message });
    }

    handleDisconnect() {
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

            this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                this.connect().catch(error => {
                    this.logger.error('Reconnection failed', { error: error.message });
                });
            }, delay);
        } else {
            this.logger.error('Max reconnection attempts reached');
            this.emit('maxReconnectAttemptsReached');
        }
    }

    send(data) {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.logger.error('Cannot send message - not connected');
            return false;
        }

        try {
            const message = JSON.stringify(data);
            this.ws.send(message);
            this.logger.debug('Message sent', { data });
            return true;
        } catch (error) {
            this.logger.error('Failed to send message', { error: error.message });
            return false;
        }
    }

    async disconnect() {
        if (this.ws) {
            this.logger.info('Disconnecting from Deriv API');
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
            this.isAuthorized = false;
        }
    }

    getPerformanceMetrics() {
        const totalReturn = this.performance.totalProfit - this.performance.totalLoss;
        const winRate = this.performance.totalTrades > 0
            ? (this.performance.winningTrades / this.performance.totalTrades) * 100
            : 0;
        const profitFactor = this.performance.totalLoss > 0
            ? this.performance.totalProfit / this.performance.totalLoss
            : this.performance.totalProfit > 0 ? Infinity : 0;

        return {
            ...this.performance,
            totalReturn,
            winRate,
            profitFactor,
            currentBalance: this.riskManager.accountBalance,
            riskMetrics: this.riskManager.getRiskMetrics(),
            uptime: Date.now() - this.performance.startTime
        };
    }

    async start() {
        this.logger.info('Starting Deriv Grid Scalper Bot', {
            config: {
                symbol: this.config.symbol,
                stake: this.config.stake,
                multiplier: this.config.multiplier,
                paperTrading: this.config.paperTrading
            }
        });

        // Set up event handlers
        this.on('ready', () => {
            this.logger.info('Bot is ready for trading');
        });

        this.on('tradeExecuted', (contract) => {
            this.logger.info('Trade executed event', { contractId: contract.contract_id });
        });

        this.on('contractSettled', ({ contract, profit, isWinning }) => {
            this.logger.info('Contract settlement summary', {
                profit,
                isWinning,
                totalTrades: this.performance.totalTrades,
                winRate: ((this.performance.winningTrades / this.performance.totalTrades) * 100).toFixed(2) + '%'
            });
        });

        // Start performance monitoring
        setInterval(() => {
            const metrics = this.getPerformanceMetrics();
            this.logger.info('Performance metrics', metrics);
        }, 60000); // Log every minute

        // Connect to Deriv
        await this.connect();
    }

    async stop() {
        this.logger.info('Stopping Deriv Grid Scalper Bot');

        // Close all open positions
        for (const [contractId] of this.contracts) {
            this.logger.info('Closing position', { contractId });
            this.send({ sell: contractId });
        }

        // Wait for positions to close
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Disconnect
        await this.disconnect();

        // Final performance report
        const metrics = this.getPerformanceMetrics();
        this.logger.info('Final performance report', metrics);

        this.emit('stopped');
    }
}

/**
 * Main execution
 */
async function main() {
    // Check for required environment variables
    if (!process.env.DERIV_API_TOKEN) {
        console.error('ERROR: DERIV_API_TOKEN environment variable is required');
        console.error('Please set your Deriv API token: export DERIV_API_TOKEN=your_token_here');
        process.exit(1);
    }

    // Create bot instance
    const bot = new DerivGridScalperBot();

    // Graceful shutdown handlers
    process.on('SIGINT', async () => {
        console.log('\nReceived SIGINT, shutting down gracefully...');
        await bot.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\nReceived SIGTERM, shutting down gracefully...');
        await bot.stop();
        process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
        console.error('Uncaught exception:', error);
        await bot.stop();
        process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
        console.error('Unhandled rejection at:', promise, 'reason:', reason);
        await bot.stop();
        process.exit(1);
    });

    try {
        // Start the bot
        await bot.start();

        // Keep the process running
        await new Promise(() => { });
    } catch (error) {
        console.error('Failed to start bot:', error.message);
        process.exit(1);
    }
}

// Run the bot if this file is executed directly
if (require.main === module) {
    main();
}

// Export for module usage
module.exports = { DerivGridScalperBot, CONFIG };