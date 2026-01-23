const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'risefall-state.json');
const STATE_SAVE_INTERVAL = 5000; // Save every 5 seconds

class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
                session: { ...state.session },
                portfolio: {
                    dailyProfit: state.portfolio.dailyProfit,
                    dailyLoss: state.portfolio.dailyLoss,
                    dailyWins: state.portfolio.dailyWins,
                    dailyLosses: state.portfolio.dailyLosses,
                    activePositions: state.portfolio.activePositions.map(pos => ({
                        symbol: pos.symbol,
                        direction: pos.direction,
                        stake: pos.stake,
                        duration: pos.duration,
                        durationUnit: pos.durationUnit,
                        entryTime: pos.entryTime,
                        contractId: pos.contractId,
                        buyPrice: pos.buyPrice,
                        currentProfit: pos.currentProfit
                    }))
                },
                lastTradeDirection: state.lastTradeDirection
            };

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📂 No previous state file found, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            // Only restore if state is less than 30 minutes old
            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            // Restore capital and session
            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };

            // Restore portfolio
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            // Restore active positions
            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now()
            }));

            // Restore last trade direction
            state.lastTradeDirection = savedData.lastTradeDirection || null;

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            LOGGER.info(`   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            LOGGER.info(`   🚀 Active Positions: ${state.portfolio.activePositions.length}`);
            LOGGER.info(`   🔄 Last Direction: ${state.lastTradeDirection || 'None'}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) {
                this.saveState();
            }
        }, STATE_SAVE_INTERVAL);
        LOGGER.info(`💾 Auto-save enabled (every ${STATE_SAVE_INTERVAL / 1000}s)`);
    }

    static clearState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                fs.unlinkSync(STATE_FILE);
                LOGGER.info('🗑️ State file cleared');
            }
        } catch (error) {
            LOGGER.error(`Failed to clear state: ${error.message}`);
        }
    }
}

// ============================================
// TELEGRAM SERVICE
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

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(true);
                        } else {
                            reject(new Error(body));
                        }
                    });
                });
                req.on('error', (error) => {
                    reject(error);
                });
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Failed to send Telegram message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : (type === 'WIN' ? '✅' : '❌');
        const message = `
${emoji} <b>${type} TRADE ALERT</b>
Asset: ${symbol}
Direction: ${direction}
Stake: $${stake.toFixed(2)}
Duration: ${duration} ${durationUnit}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}` : ''}
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const message = `
            📊 <b>SESSION SUMMARY</b>
            Duration: ${stats.duration}
            Trades: ${stats.trades}
            Wins: ${stats.wins} | Losses: ${stats.losses}
            Win Rate: ${stats.winRate}
            Net P/L: $${stats.netPL.toFixed(2)}
            Current Capital: $${state.capital.toFixed(2)}
            Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
            🤖 <b>DERIV RISE/FALL BOT STARTED</b>
            Strategy: Alternating Rise/Fall
            Capital: $${CONFIG.INITIAL_CAPITAL}
            Stake: $${CONFIG.STAKE}
            Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}
            Assets: ${ACTIVE_ASSETS.join(', ')}
            Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
            Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
            Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 100,
    STAKE: 0.5,

    // Session Targets
    SESSION_PROFIT_TARGET: 10000,
    SESSION_STOP_LOSS: -60,

    // Trade Duration Settings
    DURATION: 1,
    DURATION_UNIT: 'm', // t=ticks, s=seconds, m=minutes

    // Trade Settings
    MAX_OPEN_POSITIONS: 1, // One at a time for alternating strategy
    TRADE_DELAY: 1000, // 2 seconds delay between trades

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8591937854:AAESyF-8b17sRK-xdQXzrHfALnKA1sAR3CI',
    TELEGRAM_CHAT_ID: '752497117',
};


let ACTIVE_ASSETS = ['R_100'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        isActive: true,
        startTime: Date.now(),
        startCapital: CONFIG.INITIAL_CAPITAL
    },
    isConnected: false,
    isAuthorized: false,
    portfolio: {
        dailyProfit: 0,
        dailyLoss: 0,
        dailyWins: 0,
        dailyLosses: 0,
        activePositions: []
    },
    lastTradeDirection: null, // 'CALL' or 'PUT'
    requestId: 1,
    canTrade: false
};

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() {
        return state.session.isActive;
    }

    static checkSessionTargets() {
        const netPL = state.session.netPL;

        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`🎯 SESSION PROFIT TARGET REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('PROFIT_TARGET');
            return true;
        }

        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            this.endSession('STOP_LOSS');
            return true;
        }

        return false;
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`⏸️ Session ended (${reason}).`);
        TelegramService.sendSessionSummary();

        // Stop trading
        state.canTrade = false;
    }

    static getSessionStats() {
        const duration = Date.now() - state.session.startTime;
        const hours = Math.floor(duration / 3600000);
        const minutes = Math.floor((duration % 3600000) / 60000);

        return {
            duration: `${hours}h ${minutes}m`,
            trades: state.session.tradesCount,
            wins: state.session.winsCount,
            losses: state.session.lossesCount,
            winRate: state.session.tradesCount > 0
                ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
                : '0%',
            netPL: state.session.netPL
        };
    }

    static recordTradeResult(profit, direction) {
        state.session.tradesCount++;
        state.capital += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction}`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            LOGGER.trade(`❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Direction: ${direction}`);
        }
    }
}

// ============================================
// CONNECTION MANAGER
// ============================================
class ConnectionManager {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 50;
        this.reconnectDelay = 5000;
        this.pingInterval = null;
        this.autoSaveStarted = false;
    }

    connect() {
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());

        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;

        this.startPing();

        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });
    }

    onMessage(data) {
        try {
            const response = JSON.parse(data);
            this.handleResponse(response);
        } catch (error) {
            LOGGER.error(`Error parsing message: ${error.message}`);
        }
    }

    handleResponse(response) {
        if (response.msg_type === 'authorize') {
            if (response.error) {
                LOGGER.error(`Authorization failed: ${response.error.message}`);
                return;
            }
            LOGGER.info('🔐 Authorized successfully');
            LOGGER.info(`👤 Account: ${response.authorize.loginid}`);
            LOGGER.info(`💰 Balance: ${response.authorize.balance} ${response.authorize.currency}`);

            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;

            if (state.capital === CONFIG.INITIAL_CAPITAL) {
                state.capital = response.authorize.balance;
            }

            this.send({ balance: 1, subscribe: 1 });

            bot.start();
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            // Remove failed position
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }

            // Allow next trade after delay
            setTimeout(() => {
                state.canTrade = true;
                bot.executeNextTrade();
            }, CONFIG.TRADE_DELAY);

            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;

            TelegramService.sendTradeAlert(
                'OPEN',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit
            );
        }

        // Subscribe to contract updates
        this.send({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }

    handleOpenContract(response) {
        if (response.error) {
            LOGGER.error(`Contract error: ${response.error.message}`);
            return;
        }

        const contract = response.proposal_open_contract;
        const contractId = contract.contract_id;
        const posIndex = state.portfolio.activePositions.findIndex(
            p => p.contractId === contractId
        );

        if (posIndex < 0) return;

        const position = state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        // Contract closed
        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            SessionManager.recordTradeResult(profit, position.direction);

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                position.symbol,
                position.direction,
                position.stake,
                position.duration,
                position.durationUnit,
                { profit }
            );

            state.portfolio.activePositions.splice(posIndex, 1);

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            SessionManager.checkSessionTargets();
            StatePersistence.saveState();

            // Schedule next trade
            setTimeout(() => {
                state.canTrade = true;
                bot.executeNextTrade();
            }, CONFIG.TRADE_DELAY);
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopPing();
        StatePersistence.saveState();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b>\nReconnecting... (attempt ${this.reconnectAttempts})`);

            setTimeout(() => this.connect(), delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.`);
            process.exit(1);
        }
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
            }
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
    }

    send(data) {
        if (!state.isConnected) {
            LOGGER.error('Cannot send: Not connected');
            return null;
        }

        data.req_id = state.requestId++;
        this.ws.send(JSON.stringify(data));
        return data.req_id;
    }
}

// ============================================
// MAIN BOT CLASS
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' DERIV RISE/FALL ALTERNATING BOT');
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Stake: $${CONFIG.STAKE}`);
        console.log(`⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(80));
        console.log('📋 Strategy: Alternating Rise/Fall trades');
        console.log('═'.repeat(80) + '\n');

        TelegramService.sendStartupMessage();

        // Wait a bit then start trading
        setTimeout(() => {
            state.canTrade = true;
            this.executeNextTrade();
        }, 3000);

        LOGGER.info('✅ Bot started successfully!');
    }

    executeNextTrade() {
        if (!state.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;
        if (state.capital < CONFIG.STAKE) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)}`);
            return;
        }

        // Determine next direction (alternate)
        let direction;
        if (state.lastTradeDirection === null) {
            // First trade - start with CALL (Rise)
            direction = 'CALL';
        } else if (state.lastTradeDirection === 'CALL') {
            direction = 'PUT';
        } else {
            direction = 'CALL';
        }

        const symbol = ACTIVE_ASSETS[0]; // Use first symbol
        const stake = CONFIG.STAKE;

        state.canTrade = false; // Prevent multiple trades
        state.lastTradeDirection = direction;

        LOGGER.trade(`🎯 Executing ${direction === 'CALL' ? 'RISE' : 'FALL'} trade on ${symbol}`);
        LOGGER.trade(` Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);

        const position = {
            symbol,
            direction,
            stake,
            duration: CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            currentProfit: 0,
            buyPrice: 0
        };

        state.portfolio.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                contract_type: direction,
                symbol: symbol,
                currency: 'USD',
                amount: stake,
                duration: CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');
        state.canTrade = false;

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            lastDirection: state.lastTradeDirection,
            nextDirection: state.lastTradeDirection === 'CALL' ? 'PUT' : 'CALL',
            activePositionsCount: state.portfolio.activePositions.length,
            activePositions: state.portfolio.activePositions.map(pos => ({
                symbol: pos.symbol,
                direction: pos.direction,
                stake: pos.stake,
                duration: `${pos.duration} ${pos.durationUnit}`,
                profit: pos.currentProfit,
                contractId: pos.contractId
            }))
        };
    }
}

// ============================================
// INITIALIZATION
// ============================================
const bot = new DerivBot();

process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

// Load saved state
const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' DERIV RISE/FALL ALTERNATING BOT');
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(' API_TOKEN=xxx DURATION=5 DURATION_UNIT=t node risefall-bot.js');
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' CAPITAL - Initial capital (default: 1000)');
    console.log(' STAKE - Stake per trade (default: 1)');
    console.log(' DURATION - Contract duration (default: 1)');
    console.log(' DURATION_UNIT - t=ticks, s=seconds, m=minutes (default: t)');
    console.log(' PROFIT_TARGET - Session profit target (default: 1000)');
    console.log(' STOP_LOSS - Session stop loss (default: -500)');
    console.log(' TELEGRAM_ENABLED - Enable Telegram (default: false)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL ALTERNATING BOT');
console.log(` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        console.log(`\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active`);
    }
}, 30000);