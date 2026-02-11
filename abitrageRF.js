const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'abitrageRF00001-state.json');
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
                        reqId: pos.reqId,
                        buyPrice: pos.buyPrice,
                        currentProfit: pos.currentProfit
                    }))
                },
                lastTradeDirection: state.lastTradeDirection,
                lastTradeWasWin: state.lastTradeWasWin,
                martingaleLevel: state.martingaleLevel,
                hourlyStats: { ...state.hourlyStats },
                assets: {}
            };

            // FIX: Save essential asset state for each symbol
            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    // Save last few closed candles for continuity
                    closedCandles: asset.closedCandles.slice(-20),
                    tickHistory: asset.tickHistory ? asset.tickHistory.slice(-1000) : [],
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded
                };
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            // LOGGER.debug('💾 State saved to disk');
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
                fs.unlinkSync(STATE_FILE); // FIX: Delete old state file
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            // Restore capital and session
            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(), // FIX: Preserve original start time
                startCapital: savedData.session.startCapital || savedData.capital
            };

            // Restore portfolio
            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            // FIX: Restore active positions with all fields
            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now() // FIX: Ensure entryTime exists
            }));

            // Restore last trade direction and martingale
            state.lastTradeDirection = savedData.lastTradeDirection || null;
            state.lastTradeWasWin = savedData.lastTradeWasWin !== undefined ? savedData.lastTradeWasWin : null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: new Date().getHours()
            };

            // FIX: Restore asset states
            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        // FIX: Restore closed candles if available
                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }

                        // Restore tick history if available
                        if (saved.tickHistory && saved.tickHistory.length > 0) {
                            asset.tickHistory = saved.tickHistory;
                            LOGGER.info(`  📊 Restored ${saved.tickHistory.length} ticks for ${symbol}`);
                        }

                        // FIX: Restore critical fields
                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;
                    }
                });
            }

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            LOGGER.info(`   🎯 Trades: ${state.session.tradesCount} (W:${state.session.winsCount} L:${state.session.lossesCount})`);
            LOGGER.info(`   📉 Loss Stats: x2:${state.session.x2Losses} x3:${state.session.x3Losses} x4:${state.session.x4Losses} x5:${state.session.x5Losses} x6:${state.session.x6Losses} x7:${state.session.x7Losses}`);
            LOGGER.info(`   🚀 Active Positions: ${state.portfolio.activePositions.length}`);
            LOGGER.info(`   🔄 Last Direction: ${state.lastTradeDirection || 'None'}`);
            LOGGER.info(`   📈 Martingale Level: ${state.martingaleLevel}`);

            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            LOGGER.error(`Stack: ${error.stack}`);
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

            await new Promise((resolve, reject) => {
                const req = https.request(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': data.length
                    }
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve());
                });
                req.on('error', reject);
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Telegram error: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, extra = {}) {
        let msg = '';
        if (type === 'OPEN') {
            msg = `🎯 <b>TRADE OPENED</b>\n` +
                `Symbol: ${symbol}\n` +
                `Direction: ${direction}\n` +
                `Stake: $${stake.toFixed(2)}\n` +
                `Duration: ${duration} ${durationUnit}`;
        } else if (type === 'WIN') {
            msg = `✅ <b>WIN</b>\n` +
                `Symbol: ${symbol}\n` +
                `Direction: ${direction}\n` +
                `Profit: $${extra.profit.toFixed(2)}`;
        } else if (type === 'LOSS') {
            msg = `❌ <b>LOSS</b>\n` +
                `Symbol: ${symbol}\n` +
                `Direction: ${direction}\n` +
                `Loss: $${extra.profit.toFixed(2)}`;
        }
        await this.sendMessage(msg);
    }

    static async sendHourlySummary() {
        const s = state.session;
        const winRate = s.tradesCount > 0 ?
            ((s.winsCount / s.tradesCount) * 100).toFixed(1) + '%' : '0%';

        const msg = `📊 <b>HOURLY SUMMARY</b>\n` +
            `Trades: ${s.tradesCount}\n` +
            `Wins: ${s.winsCount} | Losses: ${s.lossesCount}\n` +
            `Win Rate: ${winRate}\n` +
            `Net P/L: $${s.netPL.toFixed(2)}\n` +
            `Capital: $${state.capital.toFixed(2)}`;

        await this.sendMessage(msg);
    }
}

// ============================================
// LOGGER
// ============================================
const LOGGER = {
    getTime: () => {
        const now = new Date();
        return now.toISOString().substr(11, 8) + ' GMT';
    },

    info: (msg) => console.log(`[INFO] ${LOGGER.getTime()} - ${msg}`),
    warn: (msg) => console.log(`[WARN] ${LOGGER.getTime()} - ${msg}`),
    error: (msg) => console.log(`[ERROR] ${LOGGER.getTime()} - ${msg}`),
    trade: (msg) => console.log(`[TRADE] ${LOGGER.getTime()} - ${msg}`),
    debug: (msg) => console.log(`[DEBUG] ${LOGGER.getTime()} - ${msg}`)
};

function getGMTTime() {
    const now = new Date();
    return now.toISOString().substr(11, 8) + ' GMT';
}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: 1089,
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',

    // Trading settings
    SYMBOLS: ['stpRNG'],
    CAPITAL: 1000,
    STAKE: 1,
    DURATION: 2,
    DURATION_UNIT: 't',

    // Session limits
    PROFIT_TARGET: 1000,
    STOP_LOSS: -500,

    // Martingale settings
    MARTINGALE_ENABLED: true,
    MARTINGALE_MULTIPLIER: 1,
    MAX_MARTINGALE_LEVEL: 7,

    // Telegram settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8356265372:AAELmgFj-xJP3EJNPR5G_D2R2fke-T9wxBA',
    TELEGRAM_CHAT_ID: '752497117',

    // Candle settings
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1M',
    MAX_CANDLES_STORED: 100,
    LOOKBACK_CANDLES: 50,

    // Strategy
    highestPercentageDigit: null,

    // UPGRADED: 80% probability threshold for avoiding repeat pattern
    REPEAT_AVOIDANCE_THRESHOLD: 0.80  // 80% probability threshold
};

// ============================================
// STATE
// ============================================
const state = {
    isConnected: false,
    isAuthorized: false,
    canTrade: false,

    capital: CONFIG.CAPITAL,
    currentStake: CONFIG.STAKE,
    accountBalance: 0,

    lastTradeDirection: null,
    lastTradeWasWin: null,
    martingaleLevel: 0,

    session: {
        startTime: Date.now(),
        startCapital: CONFIG.CAPITAL,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        profit: 0,
        loss: 0,
        netPL: 0,
        x2Losses: 0,
        x3Losses: 0,
        x4Losses: 0,
        x5Losses: 0,
        x6Losses: 0,
        x7Losses: 0,
        isActive: true
    },

    portfolio: {
        dailyProfit: 0,
        dailyLoss: 0,
        dailyWins: 0,
        dailyLosses: 0,
        activePositions: []
    },

    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },

    tickData: {
        lastTick: null,
        lastDigit: null
    },

    assets: {}
};

// Initialize asset states
CONFIG.SYMBOLS.forEach(symbol => {
    state.assets[symbol] = {
        candles: [],
        closedCandles: [],
        currentFormingCandle: null,
        lastProcessedCandleOpenTime: 0,
        tickHistory: [],
        lastTick: null,
        lastDigit: null,
        candlesLoaded: false
    };
});

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static recordTradeResult(profit, direction) {
        const isWin = profit >= 0;

        state.session.tradesCount++;
        if (isWin) {
            state.session.winsCount++;
            state.session.profit += Math.abs(profit);
            state.lastTradeWasWin = true;
            state.martingaleLevel = 0;
            state.currentStake = CONFIG.STAKE;
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.lastTradeWasWin = false;

            if (CONFIG.MARTINGALE_ENABLED) {
                state.martingaleLevel = Math.min(state.martingaleLevel + 1, CONFIG.MAX_MARTINGALE_LEVEL);
                state.currentStake = CONFIG.STAKE * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, state.martingaleLevel);

                // Track consecutive losses
                switch (state.martingaleLevel) {
                    case 2: state.session.x2Losses++; break;
                    case 3: state.session.x3Losses++; break;
                    case 4: state.session.x4Losses++; break;
                    case 5: state.session.x5Losses++; break;
                    case 6: state.session.x6Losses++; break;
                    case 7: state.session.x7Losses++; break;
                }
            }
        }

        state.session.netPL = state.session.profit - state.session.loss;
        state.capital += profit;
        state.lastTradeDirection = direction;

        // Update hourly stats
        state.hourlyStats.trades++;
        if (isWin) state.hourlyStats.wins++;
        else state.hourlyStats.losses++;
        state.hourlyStats.pnl += profit;

        const winRate = state.session.tradesCount > 0 ?
            ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%' : '0%';

        LOGGER.trade(`${isWin ? '✅ WIN' : '❌ LOSS'}: ${isWin ? '+' : ''}$${profit.toFixed(2)} | Direction: ${direction} | Next Martingale Level: ${state.martingaleLevel}`);
    }

    static getSessionStats() {
        const winRate = state.session.tradesCount > 0 ?
            ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%' : '0%';

        return {
            trades: state.session.tradesCount,
            wins: state.session.winsCount,
            losses: state.session.lossesCount,
            winRate: winRate,
            profit: state.session.profit,
            loss: state.session.loss,
            netPL: state.session.netPL
        };
    }

    static checkSessionTargets() {
        if (state.session.netPL >= CONFIG.PROFIT_TARGET) {
            LOGGER.info(`🎯 Profit target reached: $${state.session.netPL.toFixed(2)}`);
            TelegramService.sendMessage(`🎯 Profit target reached: $${state.session.netPL.toFixed(2)}`);
            state.canTrade = false;
        }

        if (state.session.netPL <= CONFIG.STOP_LOSS) {
            LOGGER.warn(`🛑 Stop loss hit: $${state.session.netPL.toFixed(2)}`);
            TelegramService.sendMessage(`🛑 Stop loss hit: $${state.session.netPL.toFixed(2)}`);
            state.canTrade = false;
        }
    }

    static checkHourlyReset() {
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            TelegramService.sendHourlySummary();

            state.hourlyStats = {
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                lastHour: currentHour
            };
        }
    }
}

// ============================================
// CANDLE ANALYZER
// ============================================
class CandleAnalyzer {
    static getCandleDirection(candle) {
        if (candle.close > candle.open) return 'BULLISH';
        if (candle.close < candle.open) return 'BEARISH';
        return 'DOJI';
    }
}

// ============================================
// DERIV BOT
// ============================================
class DerivBot {
    constructor() {
        this.connection = new DerivConnection();
        this.ticksCount = 0;
    }

    getLastDigit(price, asset) {
        const priceStr = price.toString();
        const lastDigit = parseInt(priceStr[priceStr.length - 1]);
        return lastDigit;
    }

    executeNextTrade(symbol) {
        if (!state.canTrade || state.portfolio.activePositions.length > 0) return;

        const direction = 'CALL';
        const stake = state.currentStake;

        LOGGER.trade(`🎯 Executing ${direction} trade on ${symbol}`);
        LOGGER.trade(`   Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Martingale Level: ${state.martingaleLevel}`);

        const position = {
            symbol: symbol,
            direction: direction,
            stake: stake,
            duration: CONFIG.DURATION,
            durationUnit: CONFIG.DURATION_UNIT,
            entryTime: Date.now(),
            contractId: null,
            reqId: null,
            buyPrice: null,
            currentProfit: 0
        };

        state.portfolio.activePositions.push(position);
        state.canTrade = false;

        this.placeOrder(position);
    }

    placeOrder(position) {
        const tradeSymbol = position.symbol;
        const direction = position.direction;
        const stake = position.stake;

        const tradeRequest = {
            buy: 1,
            price: stake.toFixed(2),
            subscribe: 1,
            parameters: {
                contract_type: direction,
                symbol: tradeSymbol,
                currency: 'USD',
                amount: stake.toFixed(2),
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

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000));
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            const isWeekend = (currentDay === 0) ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 2);

            if (isWeekend) {
                if (state.session.isActive) {
                    LOGGER.info("Weekend trading suspension (Saturday 11pm - Monday 2am). Disconnecting...");
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
                return;
            }

            if (!state.session.isActive && currentHours === 2 && currentMinutes >= 0) {
                LOGGER.info("It's 2:00 AM GMT+1, reconnecting the bot.");
                this.resetDailyStats();
                state.session.isActive = true;
                this.connection.connect();
            }

            if (state.lastTradeWasWin && state.session.isActive) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    LOGGER.info("It's past 23:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
            }
        }, 20000);
    }

    resetDailyStats() {
        state.session.tradesCount = 0;
        state.session.winsCount = 0;
        state.session.lossesCount = 0;
        state.session.profit = 0;
        state.session.loss = 0;
        state.session.netPL = 0;
        state.session.x2Losses = 0;
        state.session.x3Losses = 0;
        state.session.x4Losses = 0;
        state.session.x5Losses = 0;
        state.session.x6Losses = 0;
        state.session.x7Losses = 0;
        state.martingaleLevel = 0;
        state.currentStake = CONFIG.STAKE;
        state.lastTradeWasWin = null;
        state.canTrade = false;
        LOGGER.info('📊 Daily stats reset');
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        const nextDirection = state.lastTradeWasWin === null
            ? 'CALL (First trade)'
            : state.lastTradeWasWin
                ? state.lastTradeDirection
                : (state.lastTradeDirection === 'CALL' ? 'PUT' : 'CALL');

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            lastDirection: state.lastTradeDirection,
            lastWasWin: state.lastTradeWasWin,
            nextDirection: nextDirection,
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
// DERIV CONNECTION
// ============================================
class DerivConnection {
    constructor() {
        this.ws = null;
        this.reqId = 1;
        this.pingInterval = null;
        this.bot = null;
    }

    connect() {
        LOGGER.info('🔌 Connecting to Deriv...');
        this.ws = new WebSocket(CONFIG.WS_URL);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv');
        state.isConnected = true;

        this.send({ authorize: CONFIG.API_TOKEN });

        this.pingInterval = setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.send({ ping: 1 });
            }
        }, 30000);
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('❌ Disconnected from Deriv');
        state.isConnected = false;
        state.isAuthorized = false;

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }

        setTimeout(() => {
            if (state.session.isActive) {
                LOGGER.info('🔄 Reconnecting in 5 seconds...');
                this.connect();
            }
        }, 5000);
    }

    send(request) {
        const reqId = this.reqId++;
        request.req_id = reqId;
        this.ws.send(JSON.stringify(request));
        return reqId;
    }

    onMessage(data) {
        const response = JSON.parse(data);

        if (response.error) {
            LOGGER.error(`API Error: ${response.error.message}`);
            return;
        }

        if (response.msg_type === 'authorize') {
            this.handleAuthorize(response);
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        if (response.msg_type === 'ohlc') {
            this.handleOHLC(response.ohlc);
        }

        if (response.msg_type === 'candles') {
            this.handleCandlesHistory(response);
        }

        if (response.msg_type === 'history') {
            this.handleTickHistory(response.echo_req.ticks_history, response.history);
        }

        if (response.msg_type === 'tick') {
            this.handleTickUpdate(response.tick);
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }
    }

    handleAuthorize(response) {
        const account = response.authorize;
        LOGGER.info(`✅ Authorized: ${account.email}`);
        LOGGER.info(`💰 Balance: $${account.balance} ${account.currency}`);

        state.isAuthorized = true;
        state.accountBalance = account.balance;

        this.send({ balance: 1, subscribe: 1, account: 'current' });

        CONFIG.SYMBOLS.forEach(symbol => {
            this.send({
                ticks_history: symbol,
                count: 1000,
                end: 'latest',
                style: 'ticks'
            });

            this.send({
                ticks: symbol,
                subscribe: 1
            });
        });

        StatePersistence.startAutoSave();
        SessionManager.checkHourlyReset();
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);

            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }

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
        }
    }

    handleOHLC(ohlc) {
        const symbol = ohlc.symbol;
        if (!state.assets[symbol]) return;

        const assetState = state.assets[symbol];
        const calculatedOpenTime = ohlc.open_time ||
            Math.floor(ohlc.epoch / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;

        const incomingCandle = {
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low),
            close: parseFloat(ohlc.close),
            epoch: ohlc.epoch,
            open_time: calculatedOpenTime
        };

        const currentOpenTime = assetState.currentFormingCandle?.open_time;
        const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

        if (isNewCandle) {
            const closedCandle = { ...assetState.currentFormingCandle };
            closedCandle.epoch = closedCandle.open_time + CONFIG.GRANULARITY;

            if (closedCandle.open_time !== assetState.lastProcessedCandleOpenTime) {
                assetState.closedCandles.push(closedCandle);

                if (assetState.closedCandles.length > CONFIG.MAX_CANDLES_STORED) {
                    assetState.closedCandles = assetState.closedCandles.slice(-CONFIG.MAX_CANDLES_STORED);
                }

                assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

                const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
                const candleType = CandleAnalyzer.getCandleDirection(closedCandle);
                const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';
            }
        }

        assetState.currentFormingCandle = incomingCandle;

        const candles = assetState.candles;
        const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
        if (existingIndex >= 0) {
            candles[existingIndex] = incomingCandle;
        } else {
            candles.push(incomingCandle);
        }

        if (candles.length > CONFIG.MAX_CANDLES_STORED) {
            assetState.candles = candles.slice(-CONFIG.MAX_CANDLES_STORED);
        }
    }

    handleCandlesHistory(response) {
        if (response.error) {
            LOGGER.error(`Error fetching candles: ${response.error.message}`);
            return;
        }

        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const candles = response.candles.map(c => {
            const openTime = Math.floor((c.epoch - CONFIG.GRANULARITY) / CONFIG.GRANULARITY) * CONFIG.GRANULARITY;
            return {
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                epoch: c.epoch,
                open_time: openTime
            };
        });

        if (candles.length === 0) {
            LOGGER.warn(`${symbol}: No historical candles received`);
            return;
        }

        state.assets[symbol].candles = [...candles];
        state.assets[symbol].closedCandles = [...candles];

        const lastCandle = candles[candles.length - 1];
        state.assets[symbol].lastProcessedCandleOpenTime = lastCandle.open_time;
        state.assets[symbol].currentFormingCandle = null;

        LOGGER.info(`📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`);
    }

    handleTickHistory(asset, history) {
        if (!state.assets[asset]) return;
        state.assets[asset].tickHistory = history.prices.map(price => bot.getLastDigit(price, asset));
        LOGGER.info(`📊 Loaded ${state.assets[asset].tickHistory.length} ticks for ${asset}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = bot.getLastDigit(tick.quote, asset);

        if (!state.assets[asset]) return;

        const assetState = state.assets[asset];
        assetState.lastTick = tick;
        assetState.lastDigit = lastDigit;

        state.tickData.lastTick = tick;
        state.tickData.lastDigit = lastDigit;

        if (!assetState.tickHistory) assetState.tickHistory = [];
        assetState.tickHistory.push(lastDigit);
        if (assetState.tickHistory.length > 1000) {
            assetState.tickHistory.shift();
        }

        LOGGER.debug(`[${asset}] Tick: ${tick.quote} | Last Digit: ${lastDigit} (${lastDigit % 2 === 0 ? 'EVEN' : 'ODD'})`);

        this.analyzeTicks(asset);
    }

    // ============================================
    // UPGRADED: ENHANCED analyzeTicks METHOD WITH 80% PROBABILITY FILTER
    // ============================================
    analyzeTicks(asset) {
        const assetState = state.assets[asset];
        if (!assetState || !assetState.tickHistory || assetState.tickHistory.length < 100) return;

        const history = assetState.tickHistory.slice(-100);
        const currentDigit = assetState.lastDigit;

        // Check amount of times and percentage each digit repeats (as first and third)
        let countTotal = 0;
        let countRepeat = 0;

        for (let i = 0; i < history.length - 2; i++) {
            if (history[i] === currentDigit) {
                countTotal++;
                if (history[i + 2] === currentDigit) {
                    countRepeat++;
                }
            }
        }

        if (countTotal > 0) {
            const percentage = (countRepeat / countTotal) * 100;

            const last5TicksTrendHigh = history[history.length - 1] < history[history.length - 2] && history[history.length - 2] < history[history.length - 3];

            LOGGER.debug(`[${asset}] Digit ${currentDigit} Analysis: Total=${countTotal}, Repeats=${countRepeat}, Percentage=${percentage.toFixed(2)}%`);
            LOGGER.debug(`[${asset}] Trend High: ${last5TicksTrendHigh} (${history[history.length - 1]} < ${history[history.length - 2]} < ${history[history.length - 3]})`);

            this.ticksCount++;

            if (countTotal >= 15) {
                CONFIG.highestPercentageDigit = currentDigit;
            }

            // ============================================
            // UPGRADED: 80% PROBABILITY FILTER
            // ============================================
            // Calculate the probability that the 1st and 3rd positions WILL repeat
            const repeatProbability = countTotal > 0 ? countRepeat / countTotal : 0;

            // We want to trade only when there's 80% probability that there will NOT be a repeat
            // This means: repeatProbability should be <= 0.20 (or 20%)
            // In other words: non-repeatProbability >= 0.80 (or 80%)
            const nonRepeatProbability = 1 - repeatProbability;

            // Check if the non-repeat probability meets the 80% threshold
            const meetsRepeatAvoidanceThreshold = nonRepeatProbability >= CONFIG.REPEAT_AVOIDANCE_THRESHOLD;

            LOGGER.debug(`[${asset}] 🎯 Repeat Probability: ${(repeatProbability * 100).toFixed(2)}% | Non-Repeat Probability: ${(nonRepeatProbability * 100).toFixed(2)}%`);
            LOGGER.debug(`[${asset}] ✅ Meets 80% Non-Repeat Threshold: ${meetsRepeatAvoidanceThreshold}`);

            // Execute trade only if:
            // 1. Current digit is one less than the highest percentage digit
            // 2. Trend is high (descending last 3 ticks)
            // 3. No active positions
            // 4. UPGRADED: Non-repeat probability >= 80%
            if ((currentDigit === (CONFIG.highestPercentageDigit - 1)) &&
                last5TicksTrendHigh &&
                !state.portfolio.activePositions.length &&
                meetsRepeatAvoidanceThreshold) {

                LOGGER.trade(`🎯 STRATEGY SIGNAL TRIGGERED:`);
                LOGGER.trade(`   Digit ${CONFIG.highestPercentageDigit} | ${currentDigit} Trend High: ${last5TicksTrendHigh} (${history.slice(-3).join(' > ')})`);
                LOGGER.trade(`   ✅ 80% Non-Repeat Threshold MET: ${(nonRepeatProbability * 100).toFixed(2)}%`);
                LOGGER.trade(`   📊 Repeat Analysis: ${countRepeat}/${countTotal} = ${(repeatProbability * 100).toFixed(2)}% repeat rate`);

                state.canTrade = true;
                bot.executeNextTrade(asset);
            } else if ((currentDigit === (CONFIG.highestPercentageDigit - 1)) &&
                last5TicksTrendHigh &&
                !state.portfolio.activePositions.length &&
                !meetsRepeatAvoidanceThreshold) {
                // Log when signal would have triggered but didn't meet the 80% threshold
                LOGGER.debug(`[${asset}] ⚠️ SIGNAL BLOCKED: Non-Repeat Probability ${(nonRepeatProbability * 100).toFixed(2)}% < 80% threshold`);
                LOGGER.debug(`   Repeat rate too high: ${countRepeat}/${countTotal} = ${(repeatProbability * 100).toFixed(2)}%`);
            }

            if (this.ticksCount > 10) {
                CONFIG.highestPercentageDigit = null;
                this.ticksCount = 0;
            }
        }
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
    console.log(' DERIV RISE/FALL ALTERNATING BOT - UPGRADED v2.0');
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(' API_TOKEN=xxx DURATION=5 DURATION_UNIT=t node riseFall_bot_upgraded.js');
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' CAPITAL - Initial capital (default: 1000)');
    console.log(' STAKE - Stake per trade (default: 1)');
    console.log(' DURATION - Contract duration (default: 2)');
    console.log(' DURATION_UNIT - t=ticks, s=seconds, m=minutes (default: t)');
    console.log(' PROFIT_TARGET - Session profit target (default: 1000)');
    console.log(' STOP_LOSS - Session stop loss (default: -500)');
    console.log(' TELEGRAM_ENABLED - Enable Telegram (default: false)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log('═'.repeat(80));
    console.log('\n✨ UPGRADES:');
    console.log(' • 80% Non-Repeat Probability Filter');
    console.log(' • Enhanced Signal Logging');
    console.log(' • Improved Trade Validation');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL ALTERNATING BOT - UPGRADED v2.0');
console.log(` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`);
console.log(` 🎯 80% Non-Repeat Threshold ACTIVE`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;
        console.log(`\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active`);
        console.log(`📉 Loss Stats: x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} | Level: ${state.martingaleLevel}`);
    }
}, 30000);