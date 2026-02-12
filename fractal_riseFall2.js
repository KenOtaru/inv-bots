const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'fractal_riseFall00002-state.json');
const STATE_SAVE_INTERVAL = 5000;

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
                cooldownUntil: state.cooldownUntil,
                consecutiveLosses: state.consecutiveLosses,
                assets: {}
            };

            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    closedCandles: asset.closedCandles.slice(-150),
                    lastProcessedCandleOpenTime: asset.lastProcessedCandleOpenTime,
                    candlesLoaded: asset.candlesLoaded,
                    lastFractalHigh: asset.lastFractalHigh,
                    lastFractalLow: asset.lastFractalLow,
                    tradedFractalHigh: asset.tradedFractalHigh,
                    tradedFractalLow: asset.tradedFractalLow,
                    ema20: asset.ema20,
                    ema50: asset.ema50,
                    atr: asset.atr
                };
            });

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

            if (ageMinutes > 30) {
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.session = {
                ...state.session,
                ...savedData.session,
                startTime: savedData.session.startTime || Date.now(),
                startCapital: savedData.session.startCapital || savedData.capital
            };

            state.portfolio.dailyProfit = savedData.portfolio.dailyProfit;
            state.portfolio.dailyLoss = savedData.portfolio.dailyLoss;
            state.portfolio.dailyWins = savedData.portfolio.dailyWins;
            state.portfolio.dailyLosses = savedData.portfolio.dailyLosses;

            state.portfolio.activePositions = (savedData.portfolio.activePositions || []).map(pos => ({
                ...pos,
                entryTime: pos.entryTime || Date.now()
            }));

            state.lastTradeDirection = savedData.lastTradeDirection || null;
            state.lastTradeWasWin = savedData.lastTradeWasWin !== undefined ? savedData.lastTradeWasWin : null;
            state.martingaleLevel = savedData.martingaleLevel || 0;
            state.cooldownUntil = savedData.cooldownUntil || 0;
            state.consecutiveLosses = savedData.consecutiveLosses || 0;
            state.hourlyStats = savedData.hourlyStats || {
                trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
            };

            if (savedData.assets) {
                Object.keys(savedData.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = savedData.assets[symbol];
                        const asset = state.assets[symbol];

                        if (saved.closedCandles && saved.closedCandles.length > 0) {
                            asset.closedCandles = saved.closedCandles;
                            LOGGER.info(`  📊 Restored ${saved.closedCandles.length} closed candles for ${symbol}`);
                        }

                        asset.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        asset.candlesLoaded = saved.candlesLoaded || false;
                        asset.lastFractalHigh = saved.lastFractalHigh || null;
                        asset.lastFractalLow = saved.lastFractalLow || null;
                        asset.tradedFractalHigh = saved.tradedFractalHigh || null;
                        asset.tradedFractalLow = saved.tradedFractalLow || null;
                        asset.ema20 = saved.ema20 || null;
                        asset.ema50 = saved.ema50 || null;
                        asset.atr = saved.atr || null;
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
            LOGGER.info(`   🧊 Cooldown Until: ${state.cooldownUntil > Date.now() ? new Date(state.cooldownUntil).toISOString() : 'None'}`);
            LOGGER.info(`   📉 Consecutive Losses: ${state.consecutiveLosses}`);

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

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, res => {
                    let body = '';
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode === 200) resolve(true);
                        else reject(new Error(body));
                    });
                });
                req.on('error', error => reject(error));
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Failed to send Telegram message: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, direction, stake, duration, durationUnit, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const stats = SessionManager.getSessionStats();
        const assetState = state.assets[symbol];
        const message = `
${emoji} <b>${type} TRADE ALERT</b>
Asset: ${symbol}
Direction: ${direction === 'CALLE' ? 'RISE' : 'FALL'}
Stake: $${stake.toFixed(2)}
Duration: ${duration} (${durationUnit == 't' ? 'Ticks' : durationUnit == 's' ? 'Seconds' : 'Minutes'})
Martingale Level: ${state.martingaleLevel}
Consec. Losses: ${state.consecutiveLosses}
${assetState ? `EMA20: ${assetState.ema20 ? assetState.ema20.toFixed(2) : 'N/A'} | ATR: ${assetState.atr ? assetState.atr.toFixed(5) : 'N/A'}` : ''}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}
Total P&L: $${state.session.netPL.toFixed(2)}
Wins: ${state.session.winsCount}/${state.session.lossesCount}
Win Rate: ${stats.winRate}
` : ''}`.trim();
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
Loss Stats: x2:${stats.x2Losses} | x3:${stats.x3Losses} | x4:${stats.x4Losses} | x5:${stats.x5Losses} | x6:${stats.x6Losses} | x7:${stats.x7Losses}
Net P/L: $${stats.netPL.toFixed(2)}
Current Capital: $${state.capital.toFixed(2)}
`.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
🤖 <b>DERIV RISE/FALL BOT STARTED</b>
Strategy: Fractal Breakout + Smart Filters
Capital: $${CONFIG.INITIAL_CAPITAL}
Stake: $${CONFIG.STAKE}
Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}
Assets: ${ACTIVE_ASSETS.join(', ')}
Session Target: $${CONFIG.SESSION_PROFIT_TARGET}
Stop Loss: $${CONFIG.SESSION_STOP_LOSS}
Filters: EMA Trend, ATR Volatility, Breakout Strength, Body Size, Cooldown
`.trim();
        await this.sendMessage(message);
    }

    static async sendHourlySummary() {
        const statsSnapshot = { ...state.hourlyStats };

        if (statsSnapshot.trades === 0) {
            LOGGER.info('📱 Telegram: Skipping hourly summary (no trades this hour)');
            return;
        }

        const totalTrades = statsSnapshot.wins + statsSnapshot.losses;
        const winRate = totalTrades > 0
            ? ((statsSnapshot.wins / totalTrades) * 100).toFixed(1)
            : 0;
        const pnlEmoji = statsSnapshot.pnl >= 0 ? '🟢' : '🔴';
        const pnlStr = (statsSnapshot.pnl >= 0 ? '+' : '') + '$' + statsSnapshot.pnl.toFixed(2);

        const message = `
⏰ <b>Rise/Fall Bot Hourly Summary</b>

📊 <b>Last Hour</b>
├ Trades: ${statsSnapshot.trades}
├ Wins: ${statsSnapshot.wins} | Losses: ${statsSnapshot.losses}
├ Win Rate: ${winRate}%
└ ${pnlEmoji} <b>P&L:</b> ${pnlStr}

📈 <b>Daily Totals</b>
├ Total Trades: ${state.session.tradesCount}
├ Total W/L: ${state.session.winsCount}/${state.session.lossesCount}
├ Daily P&L: ${state.session.netPL >= 0 ? '+' : ''}$${state.session.netPL.toFixed(2)}
└ Current Capital: $${state.capital.toFixed(2)}

⏰ ${new Date().toLocaleString()}
`.trim();

        try {
            await this.sendMessage(message);
            LOGGER.info('📱 Telegram: Hourly Summary sent');
        } catch (error) {
            LOGGER.error(`❌ Telegram hourly summary failed: ${error.message}`);
        }

        state.hourlyStats = {
            trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours()
        };
    }

    static startHourlyTimer() {
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(nextHour.getHours() + 1);
        nextHour.setMinutes(0);
        nextHour.setSeconds(0);
        nextHour.setMilliseconds(0);
        const timeUntilNextHour = nextHour.getTime() - now.getTime();

        setTimeout(() => {
            this.sendSessionSummary();
            setInterval(() => {
                this.sendSessionSummary();
            }, 60 * 60 * 1000);
        }, timeUntilNextHour);
    }
}

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: msg => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: msg => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: msg => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: msg => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: msg => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    filter: msg => console.log(`\x1b[35m[FILTER] ${getGMTTime()} - ${msg}\x1b[0m`)
};

// ============================================
// CANDLE ANALYSIS UTILITY
// ============================================
class CandleAnalyzer {
    static isBullish(candle) {
        return candle.close > candle.open;
    }

    static isBearish(candle) {
        return candle.close < candle.open;
    }

    static getLastClosedCandle(symbol) {
        const assetState = state.assets[symbol];
        if (!assetState || !assetState.closedCandles || assetState.closedCandles.length === 0) {
            return null;
        }
        return assetState.closedCandles[assetState.closedCandles.length - 1];
    }

    static getCandleDirection(candle) {
        if (this.isBullish(candle)) return 'BULLISH';
        if (this.isBearish(candle)) return 'BEARISH';
        return 'DOJI';
    }

    /**
     * Get the candle body size (absolute difference between open and close)
     */
    static getBodySize(candle) {
        return Math.abs(candle.close - candle.open);
    }

    /**
     * Get the full candle range (high - low)
     */
    static getRange(candle) {
        return candle.high - candle.low;
    }
}

// ============================================
// TECHNICAL INDICATORS
// ============================================
class TechnicalIndicators {
    /**
     * MT5 Williams Fractals — exact 5-bar pattern
     */
    static findFractals(closedCandles) {
        const result = {
            fractalHigh: null,
            fractalLow: null,
            fractalHighIndex: null,
            fractalLowIndex: null
        };

        if (!closedCandles || closedCandles.length < 5) {
            return result;
        }

        const len = closedCandles.length;

        for (let i = len - 3; i >= 2; i--) {
            const c = closedCandles;

            if (result.fractalHigh === null) {
                if (
                    c[i].high > c[i - 1].high &&
                    c[i].high > c[i - 2].high &&
                    c[i].high > c[i + 1].high &&
                    c[i].high > c[i + 2].high
                ) {
                    result.fractalHigh = c[i].high;
                    result.fractalHighIndex = i;
                }
            }

            if (result.fractalLow === null) {
                if (
                    c[i].low < c[i - 1].low &&
                    c[i].low < c[i - 2].low &&
                    c[i].low < c[i + 1].low &&
                    c[i].low < c[i + 2].low
                ) {
                    result.fractalLow = c[i].low;
                    result.fractalLowIndex = i;
                }
            }

            if (result.fractalHigh !== null && result.fractalLow !== null) {
                break;
            }
        }

        return result;
    }

    static findAllFractals(closedCandles) {
        const highs = [];
        const lows = [];

        if (!closedCandles || closedCandles.length < 5) {
            return { highs, lows };
        }

        const len = closedCandles.length;

        for (let i = 2; i <= len - 3; i++) {
            const c = closedCandles;

            if (
                c[i].high > c[i - 1].high &&
                c[i].high > c[i - 2].high &&
                c[i].high > c[i + 1].high &&
                c[i].high > c[i + 2].high
            ) {
                highs.push({ price: c[i].high, index: i, time: c[i].epoch });
            }

            if (
                c[i].low < c[i - 1].low &&
                c[i].low < c[i - 2].low &&
                c[i].low < c[i + 1].low &&
                c[i].low < c[i + 2].low
            ) {
                lows.push({ price: c[i].low, index: i, time: c[i].epoch });
            }
        }

        return { highs, lows };
    }

    /**
     * Exponential Moving Average (EMA)
     * Calculates the EMA of closing prices.
     */
    static calculateEMA(closedCandles, period) {
        if (!closedCandles || closedCandles.length < period) {
            return null;
        }

        const multiplier = 2 / (period + 1);

        // Start with SMA of first 'period' candles
        let ema = 0;
        for (let i = 0; i < period; i++) {
            ema += closedCandles[i].close;
        }
        ema /= period;

        // Then apply EMA formula for remaining candles
        for (let i = period; i < closedCandles.length; i++) {
            ema = (closedCandles[i].close - ema) * multiplier + ema;
        }

        return ema;
    }

    /**
     * Average True Range (ATR)
     * Measures market volatility.
     */
    static calculateATR(closedCandles, period = 14) {
        if (!closedCandles || closedCandles.length < period + 1) {
            return null;
        }

        const trueRanges = [];

        for (let i = 1; i < closedCandles.length; i++) {
            const current = closedCandles[i];
            const prevClose = closedCandles[i - 1].close;

            const tr = Math.max(
                current.high - current.low,
                Math.abs(current.high - prevClose),
                Math.abs(current.low - prevClose)
            );
            trueRanges.push(tr);
        }

        if (trueRanges.length < period) return null;

        // Use the last 'period' true ranges for ATR
        const recentTRs = trueRanges.slice(-period);
        const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / period;

        return atr;
    }

    /**
     * Calculate average candle body size over last N candles
     */
    static averageBodySize(closedCandles, period = 20) {
        if (!closedCandles || closedCandles.length < period) {
            return null;
        }

        const recent = closedCandles.slice(-period);
        const totalBody = recent.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0);
        return totalBody / period;
    }
}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 500,
    STAKE: 1,

    // Session Targets
    SESSION_PROFIT_TARGET: 5000,
    SESSION_STOP_LOSS: -250,

    // Candle Settings
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    MAX_CANDLES_STORED: 150,
    CANDLES_TO_LOAD: 150,

    // Trade Duration Settings
    DURATION: 54,
    DURATION_UNIT: 's',

    // Trade Settings
    MAX_OPEN_POSITIONS: 1,
    TRADE_DELAY: 1000,
    MARTINGALE_MULTIPLIER: 2,
    MARTINGALE_MULTIPLIER2: 2.3,
    MARTINGALE_MULTIPLIER3: 2.5,
    MARTINGALE_MULTIPLIER4: 2.3,
    MARTINGALE_MULTIPLIER5: 3,
    MAX_MARTINGALE_STEPS: 7,

    // ============================================
    // SMART FILTER SETTINGS
    // ============================================

    // EMA periods for trend detection
    EMA_FAST_PERIOD: 20,
    EMA_SLOW_PERIOD: 50,

    // ATR Settings
    ATR_PERIOD: 14,

    // FILTER 1: Breakout Strength — candle close must exceed fractal
    // level by at least this fraction of ATR.
    // e.g. 0.3 means close must be > fractalHigh + 0.3 * ATR
    BREAKOUT_ATR_MULTIPLIER: 0.3,

    // FILTER 2: Minimum candle body size as fraction of ATR.
    // Rejects tiny indecisive candles.
    MIN_BODY_ATR_RATIO: 0.25,

    // FILTER 3: Trend alignment required for initial breakout trades.
    // true = only trade breakouts in EMA trend direction
    REQUIRE_TREND_ALIGNMENT: true,

    // FILTER 4: Cooldown after consecutive losses.
    // After this many consecutive losses, enter cooldown.
    COOLDOWN_AFTER_LOSSES: 5,

    // Cooldown duration in minutes — bot waits this long before
    // accepting any new trade signal after hitting loss threshold.
    COOLDOWN_MINUTES: 5,

    // FILTER 5: Maximum consecutive losses before hard stop.
    // At this level, reset martingale and require fresh breakout only.
    MAX_RECOVERY_DEPTH: 5,

    // FILTER 6: Recovery trades must also align with trend.
    // true = recovery direction follows EMA trend, not blind alternation.
    SMART_RECOVERY: true,

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: true,
    TELEGRAM_BOT_TOKEN: '8306232249:AAGMwjFngs68Lcq27oGmqewQgthXTJJRxP0',
    TELEGRAM_CHAT_ID: '752497117'
};

let ACTIVE_ASSETS = ['R_100'];

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    assets: {},
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentStake: CONFIG.STAKE,
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        x2Losses: 0,
        x3Losses: 0,
        x4Losses: 0,
        x5Losses: 0,
        x6Losses: 0,
        x7Losses: 0,
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
    lastTradeDirection: null,
    lastTradeWasWin: null,
    martingaleLevel: 0,
    consecutiveLosses: 0,
    cooldownUntil: 0,       // Timestamp — no trades allowed before this time
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        lastHour: new Date().getHours()
    },
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

        if (netPL <= CONFIG.SESSION_STOP_LOSS || state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
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
            x2Losses: state.session.x2Losses,
            x3Losses: state.session.x3Losses,
            x4Losses: state.session.x4Losses,
            x5Losses: state.session.x5Losses,
            x6Losses: state.session.x6Losses,
            x7Losses: state.session.x7Losses,
            netPL: state.session.netPL
        };
    }

    static recordTradeResult(profit, direction) {
        const currentHour = new Date().getHours();
        if (currentHour !== state.hourlyStats.lastHour) {
            LOGGER.warn(`⏰ Hour changed (${state.hourlyStats.lastHour} → ${currentHour}), resetting hourly stats`);
            state.hourlyStats = {
                trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: currentHour
            };
        }

        state.session.tradesCount++;
        state.capital += profit;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            state.portfolio.dailyProfit += profit;
            state.portfolio.dailyWins++;
            state.martingaleLevel = 0;
            state.hourlyStats.wins++;
            state.lastTradeWasWin = true;
            state.consecutiveLosses = 0;    // Reset consecutive losses
            state.cooldownUntil = 0;        // Clear any cooldown
            state.currentStake = CONFIG.STAKE;

            LOGGER.trade(`✅ WIN: +$${profit.toFixed(2)} | Direction: ${direction} | Martingale Reset | Consecutive losses reset`);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            state.portfolio.dailyLoss += Math.abs(profit);
            state.portfolio.dailyLosses++;
            state.hourlyStats.losses++;
            state.martingaleLevel++;
            state.lastTradeWasWin = false;
            state.consecutiveLosses++;

            if (state.martingaleLevel === 2) state.session.x2Losses++;
            if (state.martingaleLevel === 3) state.session.x3Losses++;
            if (state.martingaleLevel === 4) state.session.x4Losses++;
            if (state.martingaleLevel === 5) state.session.x5Losses++;
            if (state.martingaleLevel === 6) state.session.x6Losses++;
            if (state.martingaleLevel === 7) state.session.x7Losses++;

            // ================================================
            // COOLDOWN LOGIC: After N consecutive losses,
            // pause trading for a cooldown period
            // ================================================
            if (state.consecutiveLosses >= CONFIG.COOLDOWN_AFTER_LOSSES) {
                state.cooldownUntil = Date.now() + CONFIG.COOLDOWN_MINUTES * 60 * 1000;
                LOGGER.warn(
                    `🧊 COOLDOWN ACTIVATED: ${state.consecutiveLosses} consecutive losses. No trades until ${new Date(state.cooldownUntil).toISOString().split('T')[1].split('.')[0]} GMT (${CONFIG.COOLDOWN_MINUTES} min)`
                );
                TelegramService.sendMessage(
                    `🧊 <b>COOLDOWN ACTIVATED</b>\n${state.consecutiveLosses} consecutive losses\nPausing for ${CONFIG.COOLDOWN_MINUTES} minutes\nResumes: ${new Date(state.cooldownUntil).toISOString().split('T')[1].split('.')[0]} GMT`
                );
            }

            // ================================================
            // HARD STOP at MAX_RECOVERY_DEPTH:
            // Reset martingale, require fresh signal only
            // ================================================
            if (state.consecutiveLosses >= CONFIG.MAX_RECOVERY_DEPTH) {
                LOGGER.warn(
                    `🛑 MAX RECOVERY DEPTH (${CONFIG.MAX_RECOVERY_DEPTH}) reached. Resetting martingale. Will wait for fresh breakout signal only.`
                );
                state.martingaleLevel = 0;
                state.currentStake = CONFIG.STAKE;
                state.lastTradeWasWin = null; // Force back to normal mode (no more recovery)
                state.consecutiveLosses = 0;

                // Reset traded fractal flags so fresh breakouts can be detected
                ACTIVE_ASSETS.forEach(symbol => {
                    if (state.assets[symbol]) {
                        state.assets[symbol].tradedFractalHigh = null;
                        state.assets[symbol].tradedFractalLow = null;
                    }
                });

                TelegramService.sendMessage(
                    `🛑 <b>RECOVERY DEPTH LIMIT</b>\nMax ${CONFIG.MAX_RECOVERY_DEPTH} losses hit.\nMartingale reset to $${CONFIG.STAKE}\nWaiting for fresh breakout signal.`
                );
                return; // Skip martingale multiplier below
            }

            // Martingale Multiplier (only if not hard-stopped above)
            if (state.martingaleLevel <= 3) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER * 100) / 100;
            } else if (state.martingaleLevel <= 10) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER2 * 100) / 100;
            } else if (state.martingaleLevel <= 15) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER3 * 100) / 100;
            } else if (state.martingaleLevel <= 20) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER4 * 100) / 100;
            } else if (state.martingaleLevel <= 25) {
                state.currentStake = Math.ceil(state.currentStake * CONFIG.MARTINGALE_MULTIPLIER5 * 100) / 100;
            }

            if (state.martingaleLevel >= CONFIG.MAX_MARTINGALE_STEPS) {
                LOGGER.warn(`⚠️ Max Martingale step (${CONFIG.MAX_MARTINGALE_STEPS}), resetting`);
                state.martingaleLevel = 0;
                state.currentStake = CONFIG.STAKE;
            } else {
                LOGGER.trade(
                    `❌ LOSS: -$${Math.abs(profit).toFixed(2)} | Dir: ${direction} | Consec: ${state.consecutiveLosses} | Next ML: ${state.martingaleLevel} | Next Stake: $${state.currentStake.toFixed(2)}`
                );
            }
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
        this.isReconnecting = false;
        this.activeSubscriptions = new Set();
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            LOGGER.info('Already connected');
            return;
        }

        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();

        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', data => this.onMessage(data));
        this.ws.on('error', error => this.onError(error));
        this.ws.on('close', () => this.onClose());

        return this.ws;
    }

    onOpen() {
        LOGGER.info('✅ Connected to Deriv API');
        state.isConnected = true;
        this.reconnectAttempts = 0;
        this.isReconnecting = false;

        this.startPing();

        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });
    }

    initializeAssets() {
        ACTIVE_ASSETS.forEach(symbol => {
            if (!state.assets[symbol]) {
                state.assets[symbol] = {
                    candles: [],
                    closedCandles: [],
                    currentFormingCandle: null,
                    lastProcessedCandleOpenTime: null,
                    candlesLoaded: false,
                    lastFractalHigh: null,
                    lastFractalLow: null,
                    tradedFractalHigh: null,
                    tradedFractalLow: null,
                    // Trend & Volatility indicators
                    ema20: null,
                    ema50: null,
                    atr: null
                };
                LOGGER.info(`📊 Initialized asset: ${symbol}`);
            } else {
                LOGGER.info(`📊 Asset ${symbol} already initialized (state restored)`);
            }
        });
    }

    restoreSubscriptions() {
        LOGGER.info('📊 Restoring subscriptions after reconnection...');
        state.portfolio.activePositions.forEach(pos => {
            if (pos.contractId) {
                LOGGER.info(`  ✅ Re-subscribing to contract ${pos.contractId}`);
                this.send({
                    proposal_open_contract: 1,
                    contract_id: pos.contractId,
                    subscribe: 1
                });
            }
        });
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                try { this.ws.close(); } catch (e) { }
            }
            this.ws = null;
        }
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

            if (this.reconnectAttempts > 0 || state.portfolio.activePositions.length > 0) {
                this.restoreSubscriptions();
            }

            bot.start();
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
            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) state.portfolio.activePositions.splice(posIndex, 1);
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
                'OPEN', position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit
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
        const posIndex = state.portfolio.activePositions.findIndex(p => p.contractId === contractId);

        if (posIndex < 0) return;

        const position = state.portfolio.activePositions[posIndex];
        position.currentProfit = contract.profit;

        if (contract.is_sold || contract.is_expired || contract.status === 'sold') {
            const profit = contract.profit;

            LOGGER.trade(`Contract ${contractId} closed: ${profit >= 0 ? 'WIN' : 'LOSS'} $${profit.toFixed(2)}`);

            SessionManager.recordTradeResult(profit, position.direction);

            TelegramService.sendTradeAlert(
                profit >= 0 ? 'WIN' : 'LOSS',
                position.symbol, position.direction,
                position.stake, position.duration, position.durationUnit,
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

                LOGGER.info(
                    `${symbol} ${candleEmoji} CANDLE CLOSED [${closeTime}] ${candleType}: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
                );

                // ===================================================
                // UPDATE ALL INDICATORS
                // ===================================================

                // 1. FRACTALS
                const fractals = TechnicalIndicators.findFractals(assetState.closedCandles);
                const prevHigh = assetState.lastFractalHigh;
                const prevLow = assetState.lastFractalLow;

                if (fractals.fractalHigh !== null) {
                    if (fractals.fractalHigh !== assetState.lastFractalHigh) {
                        assetState.tradedFractalHigh = null;
                        LOGGER.info(
                            `${symbol} 🔺 NEW Resistance: ${fractals.fractalHigh.toFixed(5)} (was ${assetState.lastFractalHigh !== null ? assetState.lastFractalHigh.toFixed(5) : 'N/A'}) — breakout reset`
                        );
                    }
                    assetState.lastFractalHigh = fractals.fractalHigh;
                }

                if (fractals.fractalLow !== null) {
                    if (fractals.fractalLow !== assetState.lastFractalLow) {
                        assetState.tradedFractalLow = null;
                        LOGGER.info(
                            `${symbol} 🔻 NEW Support: ${fractals.fractalLow.toFixed(5)} (was ${assetState.lastFractalLow !== null ? assetState.lastFractalLow.toFixed(5) : 'N/A'}) — breakout reset`
                        );
                    }
                    assetState.lastFractalLow = fractals.fractalLow;
                }

                // 2. EMAs
                assetState.ema20 = TechnicalIndicators.calculateEMA(
                    assetState.closedCandles, CONFIG.EMA_FAST_PERIOD
                );
                assetState.ema50 = TechnicalIndicators.calculateEMA(
                    assetState.closedCandles, CONFIG.EMA_SLOW_PERIOD
                );

                // 3. ATR
                assetState.atr = TechnicalIndicators.calculateATR(
                    assetState.closedCandles, CONFIG.ATR_PERIOD
                );

                LOGGER.debug(
                    `${symbol} Indicators — EMA20: ${assetState.ema20 ? assetState.ema20.toFixed(5) : 'N/A'} | EMA50: ${assetState.ema50 ? assetState.ema50.toFixed(5) : 'N/A'} | ATR: ${assetState.atr ? assetState.atr.toFixed(5) : 'N/A'} | R: ${assetState.lastFractalHigh ? assetState.lastFractalHigh.toFixed(5) : 'N/A'} | S: ${assetState.lastFractalLow ? assetState.lastFractalLow.toFixed(5) : 'N/A'}`
                );

                // TRIGGER TRADE ANALYSIS
                state.canTrade = true;
                bot.executeNextTrade(symbol, closedCandle);
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

        const asset = state.assets[symbol];
        asset.candles = [...candles];
        asset.closedCandles = [...candles];

        const lastCandle = candles[candles.length - 1];
        asset.lastProcessedCandleOpenTime = lastCandle.open_time;
        asset.currentFormingCandle = null;

        // Calculate initial indicators
        const fractals = TechnicalIndicators.findFractals(candles);
        asset.lastFractalHigh = fractals.fractalHigh;
        asset.lastFractalLow = fractals.fractalLow;
        asset.ema20 = TechnicalIndicators.calculateEMA(candles, CONFIG.EMA_FAST_PERIOD);
        asset.ema50 = TechnicalIndicators.calculateEMA(candles, CONFIG.EMA_SLOW_PERIOD);
        asset.atr = TechnicalIndicators.calculateATR(candles, CONFIG.ATR_PERIOD);

        LOGGER.info(`📊 Loaded ${candles.length} ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}`);
        LOGGER.info(`   🔺 Resistance: ${fractals.fractalHigh !== null ? fractals.fractalHigh.toFixed(5) : 'N/A'}`);
        LOGGER.info(`   🔻 Support:    ${fractals.fractalLow !== null ? fractals.fractalLow.toFixed(5) : 'N/A'}`);
        LOGGER.info(`   📈 EMA20: ${asset.ema20 ? asset.ema20.toFixed(5) : 'N/A'} | EMA50: ${asset.ema50 ? asset.ema50.toFixed(5) : 'N/A'}`);
        LOGGER.info(`   📊 ATR(${CONFIG.ATR_PERIOD}): ${asset.atr ? asset.atr.toFixed(5) : 'N/A'}`);

        if (CONFIG.DEBUG_MODE) {
            const allFractals = TechnicalIndicators.findAllFractals(candles);
            LOGGER.debug(`   Recent Fractal Highs: ${allFractals.highs.slice(-5).map(f => f.price.toFixed(2)).join(', ') || 'None'}`);
            LOGGER.debug(`   Recent Fractal Lows:  ${allFractals.lows.slice(-5).map(f => f.price.toFixed(2)).join(', ') || 'None'}`);
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

        if (this.isReconnecting) return;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(
                `⚠️ <b>CONNECTION LOST</b>\nAttempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\nRetrying in ${(delay / 1000).toFixed(1)}s`
            );

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nFinal P&L: $${state.session.netPL.toFixed(2)}`);
            process.exit(1);
        }
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (state.isConnected) this.send({ ping: 1 });
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) clearInterval(this.pingInterval);
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
// TRADE QUALITY FILTER
// ============================================
class TradeFilter {
    /**
     * Run all filters on a potential trade.
     * Returns { pass: boolean, reasons: string[] }
     * If pass=false, reasons[] explains why.
     */
    static evaluate(symbol, direction, closePrice, lastClosedCandle, isRecovery) {
        const asset = state.assets[symbol];
        const reasons = [];
        const passed = [];
        let pass = true;

        // ================================================
        // FILTER 0: COOLDOWN CHECK
        // ================================================
        if (Date.now() < state.cooldownUntil) {
            const remainingSec = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
            reasons.push(`🧊 COOLDOWN active (${remainingSec}s remaining)`);
            pass = false;
            // Don't even check other filters during cooldown
            return { pass, reasons, passed };
        }
        passed.push('✅ No cooldown');

        // ================================================
        // FILTER 1: TREND ALIGNMENT (EMA)
        // ================================================
        if (CONFIG.REQUIRE_TREND_ALIGNMENT && asset.ema20 !== null && asset.ema50 !== null) {
            const trendUp = asset.ema20 > asset.ema50;   // Fast EMA above slow = uptrend
            const trendDown = asset.ema20 < asset.ema50;  // Fast EMA below slow = downtrend
            const priceAboveEMA = closePrice > asset.ema20;
            const priceBelowEMA = closePrice < asset.ema20;

            if (direction === 'CALLE') {
                // RISE trade — need uptrend OR at least price above fast EMA
                if (trendDown && priceBelowEMA) {
                    reasons.push(
                        `📉 TREND CONFLICT: RISE signal but EMA20 (${asset.ema20.toFixed(2)}) < EMA50 (${asset.ema50.toFixed(2)}) AND price below EMA20`
                    );
                    pass = false;
                } else {
                    passed.push(`✅ Trend OK for RISE (EMA20: ${asset.ema20.toFixed(2)}, EMA50: ${asset.ema50.toFixed(2)})`);
                }
            } else if (direction === 'PUTE') {
                // FALL trade — need downtrend OR at least price below fast EMA
                if (trendUp && priceAboveEMA) {
                    reasons.push(
                        `📈 TREND CONFLICT: FALL signal but EMA20 (${asset.ema20.toFixed(2)}) > EMA50 (${asset.ema50.toFixed(2)}) AND price above EMA20`
                    );
                    pass = false;
                } else {
                    passed.push(`✅ Trend OK for FALL (EMA20: ${asset.ema20.toFixed(2)}, EMA50: ${asset.ema50.toFixed(2)})`);
                }
            }
        } else {
            passed.push('⏭️ Trend filter skipped (insufficient data)');
        }

        // ================================================
        // FILTER 2: BREAKOUT STRENGTH (only for non-recovery)
        // ================================================
        if (!isRecovery && asset.atr !== null) {
            const minBreakoutDistance = asset.atr * CONFIG.BREAKOUT_ATR_MULTIPLIER;
            const resistance = asset.lastFractalHigh;
            const support = asset.lastFractalLow;

            if (direction === 'CALLE' && resistance !== null) {
                const breakoutDistance = closePrice - resistance;
                if (breakoutDistance < minBreakoutDistance) {
                    reasons.push(
                        `📏 WEAK BREAKOUT UP: Distance ${breakoutDistance.toFixed(5)} < required ${minBreakoutDistance.toFixed(5)} (${CONFIG.BREAKOUT_ATR_MULTIPLIER}x ATR ${asset.atr.toFixed(5)})`
                    );
                    pass = false;
                } else {
                    passed.push(`✅ Breakout strength OK (+${breakoutDistance.toFixed(5)} > ${minBreakoutDistance.toFixed(5)})`);
                }
            } else if (direction === 'PUTE' && support !== null) {
                const breakoutDistance = support - closePrice;
                if (breakoutDistance < minBreakoutDistance) {
                    reasons.push(
                        `📏 WEAK BREAKOUT DOWN: Distance ${breakoutDistance.toFixed(5)} < required ${minBreakoutDistance.toFixed(5)} (${CONFIG.BREAKOUT_ATR_MULTIPLIER}x ATR ${asset.atr.toFixed(5)})`
                    );
                    pass = false;
                } else {
                    passed.push(`✅ Breakout strength OK (+${breakoutDistance.toFixed(5)} > ${minBreakoutDistance.toFixed(5)})`);
                }
            }
        } else if (!isRecovery) {
            passed.push('⏭️ Breakout strength skipped (no ATR)');
        }

        // ================================================
        // FILTER 3: CANDLE BODY SIZE (reject tiny candles)
        // ================================================
        if (asset.atr !== null) {
            const bodySize = CandleAnalyzer.getBodySize(lastClosedCandle);
            const minBodySize = asset.atr * CONFIG.MIN_BODY_ATR_RATIO;

            if (bodySize < minBodySize) {
                reasons.push(
                    `🕯️ TINY CANDLE: Body ${bodySize.toFixed(5)} < required ${minBodySize.toFixed(5)} (${CONFIG.MIN_BODY_ATR_RATIO}x ATR) — indecisive market`
                );
                pass = false;
            } else {
                passed.push(`✅ Candle body OK (${bodySize.toFixed(5)} > ${minBodySize.toFixed(5)})`);
            }
        }

        // ================================================
        // FILTER 4: CANDLE DIRECTION must match trade direction
        // (For initial breakouts, not recovery)
        // ================================================
        if (!isRecovery) {
            if (direction === 'CALLE' && !CandleAnalyzer.isBullish(lastClosedCandle)) {
                reasons.push(
                    `🕯️ CANDLE MISMATCH: RISE signal but candle is ${CandleAnalyzer.getCandleDirection(lastClosedCandle)}`
                );
                pass = false;
            } else if (direction === 'PUTE' && !CandleAnalyzer.isBearish(lastClosedCandle)) {
                reasons.push(
                    `🕯️ CANDLE MISMATCH: FALL signal but candle is ${CandleAnalyzer.getCandleDirection(lastClosedCandle)}`
                );
                pass = false;
            } else {
                passed.push(`✅ Candle direction matches signal`);
            }
        }

        // ================================================
        // FILTER 5: Recovery depth guard
        // ================================================
        if (isRecovery && state.consecutiveLosses >= CONFIG.MAX_RECOVERY_DEPTH) {
            reasons.push(
                `🛑 RECOVERY DEPTH: ${state.consecutiveLosses} consecutive losses >= max ${CONFIG.MAX_RECOVERY_DEPTH}`
            );
            pass = false;
        }

        return { pass, reasons, passed };
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
        console.log(' DERIV RISE/FALL FRACTAL BREAKOUT BOT — SMART FILTERS');
        console.log('═'.repeat(80));
        console.log(`💰 Initial Capital: $${state.capital}`);
        console.log(`📊 Active Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Stake: $${CONFIG.STAKE}`);
        console.log(`⏱️ Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT}`);
        console.log(`🕯️ Candle Timeframe: ${CONFIG.TIMEFRAME_LABEL}`);
        console.log(`🎯 Session Target: $${CONFIG.SESSION_PROFIT_TARGET} | Stop Loss: $${CONFIG.SESSION_STOP_LOSS}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(80));
        console.log('📋 Strategy: MT5 Fractal Breakout + Smart Filters');
        console.log('    🔺 Fractal = 5-bar pattern (2 left + pivot + 2 right)');
        console.log('    🟢 RISE: Close breaks ABOVE Resistance + all filters pass');
        console.log('    🔴 FALL: Close breaks BELOW Support + all filters pass');
        console.log('═'.repeat(80));
        console.log('🛡️ FILTERS:');
        console.log(`    📈 EMA Trend Alignment: EMA(${CONFIG.EMA_FAST_PERIOD}) vs EMA(${CONFIG.EMA_SLOW_PERIOD}) — ${CONFIG.REQUIRE_TREND_ALIGNMENT ? 'ENABLED' : 'DISABLED'}`);
        console.log(`    📏 Breakout Strength: Close must exceed level by ${CONFIG.BREAKOUT_ATR_MULTIPLIER}x ATR(${CONFIG.ATR_PERIOD})`);
        console.log(`    🕯️ Min Body Size: ${CONFIG.MIN_BODY_ATR_RATIO}x ATR — reject tiny candles`);
        console.log(`    🕯️ Candle Direction: Must match breakout direction`);
        console.log(`    🧊 Cooldown: ${CONFIG.COOLDOWN_MINUTES} min pause after ${CONFIG.COOLDOWN_AFTER_LOSSES} consecutive losses`);
        console.log(`    🛑 Max Recovery Depth: ${CONFIG.MAX_RECOVERY_DEPTH} — reset after this many losses`);
        console.log(`    🧠 Smart Recovery: ${CONFIG.SMART_RECOVERY ? 'TREND-BASED' : 'ALTERNATING'}`);
        console.log('═'.repeat(80) + '\n');

        this.connection.initializeAssets();

        ACTIVE_ASSETS.forEach(symbol => {
            this.subscribeToCandles(symbol);
        });

        TelegramService.sendStartupMessage();
        TelegramService.startHourlyTimer();

        LOGGER.info('✅ Bot started successfully!');
    }

    subscribeToCandles(symbol) {
        LOGGER.info(`📊 Subscribing to ${CONFIG.TIMEFRAME_LABEL} candles for ${symbol}...`);

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.CANDLES_TO_LOAD,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY
        });

        this.connection.send({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 1,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: CONFIG.GRANULARITY,
            subscribe: 1
        });
    }

    executeNextTrade(symbol, lastClosedCandle) {
        if (!state.canTrade) return;
        if (!SessionManager.isSessionActive()) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;

        const tradeSymbol = symbol || ACTIVE_ASSETS[0];
        const assetState = state.assets[tradeSymbol];
        const stake = state.currentStake;

        if (state.capital < stake) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)} (Need: $${stake.toFixed(2)})`);
            if (state.martingaleLevel > 0) {
                state.martingaleLevel = 0;
                state.currentStake = CONFIG.STAKE;
            }
            return;
        }

        // =============================================
        // GET CURRENT LEVELS
        // =============================================
        const resistance = assetState.lastFractalHigh;
        const support = assetState.lastFractalLow;
        const closePrice = lastClosedCandle.close;

        if (resistance === null || support === null) {
            LOGGER.info(
                `${tradeSymbol} ⏳ Waiting for fractal levels — R: ${resistance !== null ? resistance.toFixed(5) : 'PENDING'} | S: ${support !== null ? support.toFixed(5) : 'PENDING'}`
            );
            return;
        }

        LOGGER.info(
            `${tradeSymbol} 📐 Levels — R: ${resistance.toFixed(5)} | S: ${support.toFixed(5)} | Close: ${closePrice.toFixed(5)} | EMA20: ${assetState.ema20 ? assetState.ema20.toFixed(5) : 'N/A'} | ATR: ${assetState.atr ? assetState.atr.toFixed(5) : 'N/A'}`
        );

        // =============================================
        // DETERMINE TRADE DIRECTION
        // =============================================
        let direction = null;
        let signalReason = '';
        let isRecoveryMode = false;

        // Check if we are in recovery mode
        // BUT only if we haven't hit MAX_RECOVERY_DEPTH
        // (recordTradeResult resets lastTradeWasWin to null at max depth)
        if (state.lastTradeWasWin === false) {
            isRecoveryMode = true;

            if (CONFIG.SMART_RECOVERY) {
                // ================================================
                // SMART RECOVERY: Use EMA trend direction instead
                // of blind alternation.
                // ================================================
                if (assetState.ema20 !== null && assetState.ema50 !== null) {
                    if (assetState.ema20 > assetState.ema50) {
                        direction = 'CALLE'; // Trend is up → RISE
                        signalReason = `Smart Recovery — EMA20 (${assetState.ema20.toFixed(2)}) > EMA50 (${assetState.ema50.toFixed(2)}) → RISE with trend`;
                    } else {
                        direction = 'PUTE'; // Trend is down → FALL
                        signalReason = `Smart Recovery — EMA20 (${assetState.ema20.toFixed(2)}) < EMA50 (${assetState.ema50.toFixed(2)}) → FALL with trend`;
                    }
                } else {
                    // Fallback to alternation if EMAs not ready
                    if (state.lastTradeDirection === 'CALLE') {
                        direction = 'PUTE';
                        signalReason = 'Recovery fallback (no EMA) — alternating to FALL';
                    } else {
                        direction = 'CALLE';
                        signalReason = 'Recovery fallback (no EMA) — alternating to RISE';
                    }
                }
            } else {
                // Classic alternation
                if (state.lastTradeDirection === 'CALLE') {
                    direction = 'PUTE';
                    signalReason = 'Recovery (alternating to FALL)';
                } else {
                    direction = 'CALLE';
                    signalReason = 'Recovery (alternating to RISE)';
                }
            }

            LOGGER.trade(`🔄 RECOVERY MODE (loss #${state.consecutiveLosses}): ${signalReason}`);

        } else {
            // =============================================
            // NORMAL MODE: Fractal Breakout
            // =============================================

            // BREAKOUT UP
            if (closePrice > resistance) {
                if (assetState.tradedFractalHigh === resistance) {
                    LOGGER.debug(`${tradeSymbol} ⏭️ Breakout UP already traded at ${resistance.toFixed(5)}`);
                } else {
                    direction = 'CALLE';
                    signalReason = `BREAKOUT UP — Close ${closePrice.toFixed(5)} > R ${resistance.toFixed(5)} (+${(closePrice - resistance).toFixed(5)})`;
                }
            }
            // BREAKOUT DOWN
            else if (closePrice < support) {
                if (assetState.tradedFractalLow === support) {
                    LOGGER.debug(`${tradeSymbol} ⏭️ Breakout DOWN already traded at ${support.toFixed(5)}`);
                } else {
                    direction = 'PUTE';
                    signalReason = `BREAKOUT DOWN — Close ${closePrice.toFixed(5)} < S ${support.toFixed(5)} (-${(support - closePrice).toFixed(5)})`;
                }
            }
            // NO BREAKOUT
            else {
                LOGGER.debug(
                    `${tradeSymbol} No breakout — Close ${closePrice.toFixed(5)} between S ${support.toFixed(5)} and R ${resistance.toFixed(5)}`
                );
            }

            if (direction) {
                LOGGER.trade(`⚡ FRACTAL SIGNAL: ${signalReason}`);
            }
        }

        StatePersistence.saveState();

        if (!direction) {
            return;
        }

        // =============================================
        // RUN ALL FILTERS
        // =============================================
        const filterResult = TradeFilter.evaluate(
            tradeSymbol, direction, closePrice, lastClosedCandle, isRecoveryMode
        );

        // Log filter results
        if (filterResult.passed.length > 0) {
            filterResult.passed.forEach(p => LOGGER.filter(p));
        }

        if (!filterResult.pass) {
            LOGGER.filter(`❌ TRADE REJECTED for ${tradeSymbol} ${direction === 'CALLE' ? 'RISE' : 'FALL'}:`);
            filterResult.reasons.forEach(r => LOGGER.filter(`   ${r}`));

            // If recovery trade was rejected by filters, we DON'T want to
            // keep retrying blind recovery. Instead, reset to wait for
            // a fresh breakout signal.
            if (isRecoveryMode && state.consecutiveLosses >= CONFIG.COOLDOWN_AFTER_LOSSES) {
                LOGGER.warn(
                    `🧊 Recovery trade rejected during high-loss period. Maintaining cooldown.`
                );
            }

            return;
        }

        LOGGER.filter(`✅ ALL FILTERS PASSED for ${direction === 'CALLE' ? 'RISE' : 'FALL'}`);

        // =============================================
        // EXECUTE TRADE
        // =============================================
        state.canTrade = false;
        state.lastTradeDirection = direction;

        LOGGER.trade(`🎯 Executing ${direction === 'CALLE' ? 'RISE' : 'FALL'} on ${tradeSymbol}`);
        LOGGER.trade(`   Stake: $${stake.toFixed(2)} | Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT} | ML: ${state.martingaleLevel} | Consec Losses: ${state.consecutiveLosses}`);
        LOGGER.trade(`   ${signalReason}`);
        LOGGER.trade(`   R: ${resistance.toFixed(5)} | S: ${support.toFixed(5)} | Close: ${closePrice.toFixed(5)}`);

        const position = {
            symbol: tradeSymbol,
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
            price: stake.toFixed(2),
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

        // Mark fractal level as traded (only for non-recovery trades)
        if (!isRecoveryMode) {
            if (direction === 'CALLE') {
                assetState.tradedFractalHigh = resistance;
                LOGGER.info(`${tradeSymbol} ✅ Marked R ${resistance.toFixed(5)} as TRADED`);
            } else if (direction === 'PUTE') {
                assetState.tradedFractalLow = support;
                LOGGER.info(`${tradeSymbol} ✅ Marked S ${support.toFixed(5)} as TRADED`);
            }
        }
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
            const gmtPlus1Time = new Date(now.getTime() + 1 * 60 * 60 * 1000);
            const currentDay = gmtPlus1Time.getUTCDay();
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();

            const isWeekend =
                currentDay === 0 ||
                (currentDay === 6 && currentHours >= 23) ||
                (currentDay === 1 && currentHours < 2);

            if (isWeekend) {
                if (state.session.isActive) {
                    LOGGER.info('Weekend suspension. Disconnecting...');
                    TelegramService.sendHourlySummary();
                    if (this.connection.ws) this.connection.ws.close();
                    state.session.isActive = false;
                }
                return;
            }

            if (!state.session.isActive && currentHours === 2 && currentMinutes >= 0) {
                LOGGER.info("2:00 AM GMT+1, reconnecting.");
                this.resetDailyStats();
                state.session.isActive = true;
                this.connection.connect();
            }

            if (state.lastTradeWasWin && state.session.isActive) {
                if (currentHours >= 23) {
                    LOGGER.info("Past 23:00 GMT+1, disconnecting.");
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
        state.consecutiveLosses = 0;
        state.cooldownUntil = 0;
        state.canTrade = false;
        LOGGER.info('📊 Daily stats reset');
    }

    getStatus() {
        const sessionStats = SessionManager.getSessionStats();

        let nextAction = '';
        if (Date.now() < state.cooldownUntil) {
            const remainSec = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
            nextAction = `🧊 COOLDOWN (${remainSec}s)`;
        } else if (state.lastTradeWasWin === null) {
            nextAction = 'Waiting for breakout';
        } else if (state.lastTradeWasWin) {
            nextAction = 'Waiting for breakout';
        } else {
            nextAction = `Recovery #${state.consecutiveLosses + 1} (${CONFIG.SMART_RECOVERY ? 'trend-based' : 'alternating'})`;
        }

        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            accountBalance: state.accountBalance,
            session: sessionStats,
            lastDirection: state.lastTradeDirection,
            lastWasWin: state.lastTradeWasWin,
            nextAction,
            consecutiveLosses: state.consecutiveLosses,
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

const stateLoaded = StatePersistence.loadState();

if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' ⚠️ API Token not configured!');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' DERIV RISE/FALL FRACTAL BREAKOUT BOT — SMART FILTERS');
console.log(` Duration: ${CONFIG.DURATION} ${CONFIG.DURATION_UNIT} | Stake: $${CONFIG.STAKE}`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 30 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        const s = state.session;

        let fractalInfo = '';
        ACTIVE_ASSETS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                fractalInfo += ` | R:${a.lastFractalHigh !== null ? a.lastFractalHigh.toFixed(2) : '---'} S:${a.lastFractalLow !== null ? a.lastFractalLow.toFixed(2) : '---'} EMA20:${a.ema20 ? a.ema20.toFixed(2) : '---'}`;
            }
        });

        console.log(
            `\n📊 ${getGMTTime()} | ${status.session.trades} trades | ${status.session.winRate} | $${status.session.netPL.toFixed(2)} | ${status.activePositions.length} active${fractalInfo}`
        );
        console.log(
            `📉 x2:${s.x2Losses} x3:${s.x3Losses} x4:${s.x4Losses} x5:${s.x5Losses} x6:${s.x6Losses} x7:${s.x7Losses} | ML:${state.martingaleLevel} | CL:${state.consecutiveLosses} | ${status.nextAction}`
        );
    }
}, 30000);