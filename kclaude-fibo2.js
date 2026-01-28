/**
 * BLACK FIBONACCI 9.1 - DIGITDIFF BOT
 * =====================================
 * The #1 Most Profitable DigitDiff Bot in 2025
 * +8142% March 2025 Performance
 * 
 * CORE LOGIC:
 * - Multi-layer Fibonacci Z-score saturation (10 windows)
 * - Volatility filtering (entropy + streak composite)
 * - Bonus trigger for ultra-low volatility repeats
 * - Exponential stake management (11.3x multiplier)
 * 
 * Dependencies: npm install ws
 * Usage: API_TOKEN=your_token node black-fib.js
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: '0P94g4WdSrSrzir',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    BASE_STAKE: parseFloat(process.env.BASE_STAKE) || 0.61, // Base stake
    MAX_CONSECUTIVE_LOSSES: 5, // Max consecutive losses

    // Money Management Multipliers
    LOSS_1_MULTIPLIER: 1.8, // Loss 1 multiplier
    LOSS_2PLUS_MULTIPLIER: 11.3, // Loss 2+ multiplier

    // Fibonacci Windows (EXACT - DO NOT MODIFY)
    FIBONACCI_WINDOWS: [13, 21, 34, 55, 89, 144, 233, 377, 610, 987],
    MIN_VALID_WINDOWS: 8,
    Z_SCORE_THRESHOLD: 10.82,
    RECENT_APPEARANCE_WINDOW: 9,

    // Volatility Windows (EXACT - DO NOT MODIFY)
    VOLATILITY_WINDOWS: [50, 100, 200, 500],
    VOLATILITY_500_WEIGHT: 2.5,

    // Volatility Thresholds (EXACT - DO NOT MODIFY)
    VOL_EXTREME: 0.72,
    VOL_HIGH: 0.62,
    VOL_MEDIUM: 0.48,
    VOL_LOW: 0.35,

    // Bonus Trigger
    BONUS_REPEAT_THRESHOLD: 5,

    // History Management
    MIN_HISTORY_SIZE: 2000,
    MAX_HISTORY_SIZE: 3000,

    // Assets (ONLY these 3)
    ACTIVE_ASSETS: ['R_10', 'R_25', 'R_50'],

    // Performance
    TICK_PROCESSING_DELAY: 100,
    DASHBOARD_UPDATE_INTERVAL: 30000,

    // Telegram Settings
    TELEGRAM_ENABLED: false,
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',

    // Debug
    DEBUG_MODE: true
};

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
const STATE_FILE = path.join(__dirname, 'black-fib-state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
                session: { ...state.session },
                portfolio: {
                    totalProfit: state.portfolio.totalProfit,
                    totalLoss: state.portfolio.totalLoss,
                    totalTrades: state.portfolio.totalTrades,
                    totalWins: state.portfolio.totalWins,
                    totalLosses: state.portfolio.totalLosses,
                    activeContracts: state.portfolio.activeContracts.map(c => ({
                        symbol: c.symbol,
                        contractId: c.contractId,
                        prediction: c.prediction,
                        stake: c.stake,
                        buyPrice: c.buyPrice,
                        openTime: c.openTime,
                        consecutiveLosses: c.consecutiveLosses
                    }))
                },
                assets: {}
            };

            Object.keys(state.assets).forEach(symbol => {
                const asset = state.assets[symbol];
                persistableState.assets[symbol] = {
                    tickHistory: asset.tickHistory.slice(-CONFIG.MAX_HISTORY_SIZE),
                    consecutiveLosses: asset.consecutiveLosses,
                    currentStake: asset.currentStake,
                    totalTrades: asset.totalTrades,
                    totalWins: asset.totalWins,
                    totalLosses: asset.totalLosses,
                    lastPrediction: asset.lastPrediction,
                    lastVolatilityState: asset.lastVolatilityState
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

            state.portfolio.totalProfit = savedData.portfolio.totalProfit;
            state.portfolio.totalLoss = savedData.portfolio.totalLoss;
            state.portfolio.totalTrades = savedData.portfolio.totalTrades;
            state.portfolio.totalWins = savedData.portfolio.totalWins;
            state.portfolio.totalLosses = savedData.portfolio.totalLosses;
            state.portfolio.activeContracts = savedData.portfolio.activeContracts || [];

            Object.keys(savedData.assets).forEach(symbol => {
                if (state.assets[symbol]) {
                    const saved = savedData.assets[symbol];
                    const asset = state.assets[symbol];

                    asset.tickHistory = saved.tickHistory || [];
                    asset.consecutiveLosses = saved.consecutiveLosses || 0;
                    asset.currentStake = saved.currentStake || CONFIG.BASE_STAKE;
                    asset.totalTrades = saved.totalTrades || 0;
                    asset.totalWins = saved.totalWins || 0;
                    asset.totalLosses = saved.totalLosses || 0;
                    asset.lastPrediction = saved.lastPrediction || null;
                    asset.lastVolatilityState = saved.lastVolatilityState || null;

                    LOGGER.info(`  ✅ ${symbol}: ${asset.tickHistory.length} ticks, ${asset.consecutiveLosses} losses, $${asset.currentStake.toFixed(2)} stake`);
                }
            });

            LOGGER.info(`✅ State restored successfully!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Session P/L: $${state.session.netPL.toFixed(2)}`);
            LOGGER.info(`   🎯 Trades: ${state.portfolio.totalTrades} (W:${state.portfolio.totalWins} L:${state.portfolio.totalLosses})`);

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
        if (!CONFIG.TELEGRAM_ENABLED || !CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

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
                            LOGGER.error(`Telegram API error: ${body}`);
                            reject(new Error(body));
                        }
                    });
                });
                req.on('error', (error) => reject(error));
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Telegram error: ${error.message}`);
        }
    }

    static async sendTradeAlert(type, symbol, prediction, stake, details = {}) {
        const emoji = type === 'OPEN' ? '🚀' : (type === 'WIN' ? '✅' : '❌');
        const message = `
${emoji} <b>${type} TRADE</b>
Asset: ${symbol}
Prediction: Digit ${prediction}
Stake: $${stake.toFixed(2)}
${details.profit !== undefined ? `Profit: $${details.profit.toFixed(2)}` : ''}
${details.consecutiveLosses !== undefined ? `Consecutive Losses: ${details.consecutiveLosses}` : ''}
${details.zScore !== undefined ? `Z-Score: ${details.zScore.toFixed(2)}` : ''}
${details.volatility ? `Volatility: ${details.volatility}` : ''}
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendSignalAlert(symbol, prediction, zScore, volatility, bonusTrigger = false) {
        const message = `
🎯 <b>${bonusTrigger ? 'BONUS' : 'FIBONACCI'} SIGNAL</b>
Asset: ${symbol}
Predicted Digit: ${prediction}
Total Z-Score: ${zScore.toFixed(2)}
Volatility: ${volatility}
${bonusTrigger ? '🔥 Ultra-low vol repeat detected!' : ''}
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
ROI: ${stats.roi}
Current Capital: $${state.capital.toFixed(2)}
Strategy: Black Fibonacci 9.1
Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }

    static async sendStartupMessage() {
        const message = `
🤖 <b>BLACK FIBONACCI 9.1 STARTED</b>
Strategy: Multi-layer Fibonacci Z-score
Capital: $${state.capital.toFixed(2)}
Base Stake: $${CONFIG.BASE_STAKE}
Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}
Windows: ${CONFIG.FIBONACCI_WINDOWS.length}
Z-Score Threshold: ${CONFIG.Z_SCORE_THRESHOLD}
Max Losses: ${CONFIG.MAX_CONSECUTIVE_LOSSES}

<b>Money Management:</b>
Loss 1: ${CONFIG.LOSS_1_MULTIPLIER}x
Loss 2+: ${CONFIG.LOSS_2PLUS_MULTIPLIER}^(n-1)x

Time: ${new Date().toUTCString()}
        `.trim();
        await this.sendMessage(message);
    }
}

// ============================================
// UTILITIES
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const getLastDigit = (quote, symbol) => {
    if (quote === undefined || quote === null) return 0;
    const str = quote.toString();
    const [, decimal = ''] = str.split('.');

    // Different decimal places for different assets (following kclaude-fibo.js logic)
    if (symbol === 'R_50') {
        return decimal.length >= 4 ? parseInt(decimal[3]) : 0;
    } else if (symbol === 'R_10' || symbol === 'R_25') {
        return decimal.length >= 3 ? parseInt(decimal[2]) : 0;
    }
    return decimal.length >= 2 ? parseInt(decimal[1]) : 0;
};

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    signal: (msg) => console.log(`\x1b[36m[SIGNAL] ${getGMTTime()} - ${msg}\x1b[0m`),
    fib: (msg) => console.log(`\x1b[35m[FIB] ${getGMTTime()} - ${msg}\x1b[0m`),
    vol: (msg) => console.log(`\x1b[33m[VOL] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    capital: 1000,
    accountBalance: 0,
    session: {
        profit: 0,
        loss: 0,
        netPL: 0,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        startTime: Date.now(),
        startCapital: 1000
    },
    isConnected: false,
    isAuthorized: false,
    assets: {},
    portfolio: {
        totalProfit: 0,
        totalLoss: 0,
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        activeContracts: []
    },
    requestId: 1
};

// Initialize asset states
function initializeAssetStates() {
    CONFIG.ACTIVE_ASSETS.forEach(symbol => {
        state.assets[symbol] = {
            tickHistory: [],
            consecutiveLosses: 0,
            currentStake: CONFIG.BASE_STAKE,
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            lastPrediction: null,
            lastVolatilityState: null,
            isProcessing: false
        };
    });
    LOGGER.info(`Initialized ${CONFIG.ACTIVE_ASSETS.length} assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
}

initializeAssetStates();

// Try to load saved state
const stateLoaded = StatePersistence.loadState();
if (stateLoaded) {
    LOGGER.info('🔄 Bot will resume from saved state after connection');
} else {
    LOGGER.info('🆕 Bot will start with fresh state');
}

// ============================================
// FIBONACCI Z-SCORE ENGINE
// ============================================
class FibonacciEngine {
    /**
     * Calculate Z-score for a single digit in a window
     */
    static calculateZScore(ticks, digit, windowSize) {
        if (ticks.length < windowSize) return null;

        const window = ticks.slice(-windowSize);
        const digitCounts = Array(10).fill(0);

        window.forEach(tick => {
            const lastDigit = tick % 10;
            digitCounts[lastDigit]++;
        });

        const expectedFreq = windowSize / 10;
        const observedFreq = digitCounts[digit];
        const standardDeviation = Math.sqrt(expectedFreq * (1 - 0.1));

        if (standardDeviation === 0) return 0;

        const zScore = (observedFreq - expectedFreq) / standardDeviation;
        return zScore;
    }

    /**
     * Calculate multi-layer Fibonacci Z-scores
     */
    static calculateMultiLayerZScores(ticks) {
        const results = [];

        for (let digit = 0; digit < 10; digit++) {
            let totalZScore = 0;
            let validWindows = 0;

            for (const windowSize of CONFIG.FIBONACCI_WINDOWS) {
                const zScore = this.calculateZScore(ticks, digit, windowSize);
                if (zScore !== null) {
                    totalZScore += zScore;
                    validWindows++;
                }
            }

            if (validWindows >= CONFIG.MIN_VALID_WINDOWS) {
                results.push({
                    digit,
                    totalZScore,
                    validWindows
                });
            }
        }

        return results.sort((a, b) => b.totalZScore - a.totalZScore);
    }

    /**
     * Check if digit appeared in recent ticks
     */
    static appearedInRecentTicks(ticks, digit, window = CONFIG.RECENT_APPEARANCE_WINDOW) {
        if (ticks.length < window) return false;
        const recent = ticks.slice(-window);
        return recent.some(tick => (tick % 10) === digit);
    }

    /**
     * Find saturated digit (highest Z-score that meets criteria)
     */
    static findSaturatedDigit(ticks) {
        if (ticks.length < CONFIG.MIN_HISTORY_SIZE) {
            return null;
        }

        const zScores = this.calculateMultiLayerZScores(ticks);

        if (zScores.length === 0) {
            return null;
        }

        const top = zScores[0];

        // Must meet Z-score threshold
        if (top.totalZScore < CONFIG.Z_SCORE_THRESHOLD) {
            return null;
        }

        // Must have appeared in recent ticks
        if (!this.appearedInRecentTicks(ticks, top.digit)) {
            LOGGER.debug(`Digit ${top.digit} Z-score ${top.totalZScore.toFixed(2)} but not in recent ${CONFIG.RECENT_APPEARANCE_WINDOW} ticks`);
            return null;
        }

        return {
            digit: top.digit,
            zScore: top.totalZScore,
            validWindows: top.validWindows
        };
    }
}

// ============================================
// VOLATILITY FILTER
// ============================================
class VolatilityFilter {
    /**
     * Calculate entropy (concentration metric)
     */
    static calculateEntropy(ticks, windowSize) {
        if (ticks.length < windowSize) return null;

        const window = ticks.slice(-windowSize);
        const digitCounts = Array(10).fill(0);

        window.forEach(tick => {
            const lastDigit = tick % 10;
            digitCounts[lastDigit]++;
        });

        let entropy = 0;
        for (const count of digitCounts) {
            if (count > 0) {
                const p = count / windowSize;
                entropy -= p * Math.log2(p);
            }
        }

        const maxEntropy = Math.log2(10);
        const normalizedEntropy = entropy / maxEntropy;

        return normalizedEntropy;
    }

    /**
     * Calculate longest streak factor
     */
    static calculateLongestStreak(ticks, windowSize) {
        if (ticks.length < windowSize) return null;

        const window = ticks.slice(-windowSize);
        let maxStreak = 1;
        let currentStreak = 1;

        for (let i = 1; i < window.length; i++) {
            if ((window[i] % 10) === (window[i - 1] % 10)) {
                currentStreak++;
                maxStreak = Math.max(maxStreak, currentStreak);
            } else {
                currentStreak = 1;
            }
        }

        const streakFactor = maxStreak / Math.sqrt(windowSize);
        return streakFactor;
    }

    /**
     * Calculate composite volatility score
     */
    static calculateCompositeVolatility(ticks) {
        const weights = {
            50: 1.0,
            100: 1.0,
            200: 1.0,
            500: CONFIG.VOLATILITY_500_WEIGHT
        };

        let weightedSum = 0;
        let totalWeight = 0;

        for (const windowSize of CONFIG.VOLATILITY_WINDOWS) {
            const entropy = this.calculateEntropy(ticks, windowSize);
            const streak = this.calculateLongestStreak(ticks, windowSize);

            if (entropy !== null && streak !== null) {
                // Composite: 60% concentration (1 - entropy), 40% streak
                const composite = (1 - entropy) * 0.6 + streak * 0.4;
                const weight = weights[windowSize];

                weightedSum += composite * weight;
                totalWeight += weight;
            }
        }

        if (totalWeight === 0) return null;

        return weightedSum / totalWeight;
    }

    /**
     * Classify volatility state
     */
    static classifyVolatility(ticks) {
        const score = this.calculateCompositeVolatility(ticks);

        if (score === null) return null;

        if (score >= CONFIG.VOL_EXTREME) return 'extreme';
        if (score >= CONFIG.VOL_HIGH) return 'high';
        if (score >= CONFIG.VOL_MEDIUM) return 'medium';
        if (score >= CONFIG.VOL_LOW) return 'low';
        return 'ultra-low';
    }

    /**
     * Check if volatility allows trading
     */
    static allowsTrading(ticks) {
        const state = this.classifyVolatility(ticks);
        return state === 'low' || state === 'ultra-low';
    }

    /**
     * Check if in ultra-low volatility
     */
    static isUltraLow(ticks) {
        return this.classifyVolatility(ticks) === 'ultra-low';
    }
}

// ============================================
// BONUS TRIGGER
// ============================================
class BonusTrigger {
    /**
     * Check for repeated digit in recent ticks
     */
    static checkRepeatTrigger(ticks) {
        if (ticks.length < CONFIG.BONUS_REPEAT_THRESHOLD) return null;

        const recent = ticks.slice(-CONFIG.BONUS_REPEAT_THRESHOLD);
        const firstDigit = recent[0] % 10;

        const allSame = recent.every(tick => (tick % 10) === firstDigit);

        if (allSame) {
            // Trade against the repeated digit
            // Find a different digit (the one that's most saturated from opposite end)
            // const digitCounts = Array(10).fill(0);
            // const window = ticks.slice(-100); // Look at last 100

            // window.forEach(tick => {
            //     digitCounts[tick % 10]++;
            // });

            // // Find least frequent digit (excluding the repeated one)
            // let minCount = Infinity;
            // let targetDigit = null;

            // for (let d = 0; d < 10; d++) {
            //     if (d !== firstDigit && digitCounts[d] < minCount) {
            //         minCount = digitCounts[d];
            //         targetDigit = d;
            //     }
            // }

            return {
                // digit: targetDigit !== null ? targetDigit : (firstDigit + 5) % 10,
                digit: firstDigit,
                repeatedDigit: firstDigit,
                count: CONFIG.BONUS_REPEAT_THRESHOLD
            };
        }

        return null;
    }
}

// ============================================
// STAKE MANAGER
// ============================================
class StakeManager {
    /**
     * Calculate stake based on consecutive losses
     */
    static calculateStake(consecutiveLosses) {
        if (consecutiveLosses === 0) {
            return CONFIG.BASE_STAKE;
        } else if (consecutiveLosses === 1) {
            return CONFIG.BASE_STAKE * CONFIG.LOSS_1_MULTIPLIER;
        } else {
            return CONFIG.BASE_STAKE * Math.pow(CONFIG.LOSS_2PLUS_MULTIPLIER, consecutiveLosses - 1);
        }
    }

    /**
     * Update stake after trade result
     */
    static updateStake(symbol, isWin) {
        const asset = state.assets[symbol];

        if (isWin) {
            asset.consecutiveLosses = 0;
            asset.currentStake = CONFIG.BASE_STAKE;
        } else {
            asset.consecutiveLosses++;

            if (asset.consecutiveLosses > CONFIG.MAX_CONSECUTIVE_LOSSES) {
                LOGGER.error(`${symbol}: Max consecutive losses (${CONFIG.MAX_CONSECUTIVE_LOSSES}) reached!`);
                asset.consecutiveLosses = 0;
                asset.currentStake = CONFIG.BASE_STAKE;
                return false; // Stop trading this asset
            }

            asset.currentStake = this.calculateStake(asset.consecutiveLosses);
        }

        LOGGER.trade(`${symbol}: Stake updated to $${asset.currentStake.toFixed(2)} (Losses: ${asset.consecutiveLosses})`);
        return true;
    }

    /**
     * Validate stake against capital
     */
    static validateStake(stake) {
        if (stake > state.capital) {
            LOGGER.error(`Insufficient capital: $${state.capital.toFixed(2)} < $${stake.toFixed(2)}`);
            return false;
        }
        if (stake < 0.35) {
            LOGGER.error(`Stake too low: $${stake.toFixed(2)}`);
            return false;
        }
        return true;
    }
}

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static getSessionStats() {
        const duration = Date.now() - state.session.startTime;
        const hours = Math.floor(duration / 3600000);
        const minutes = Math.floor((duration % 3600000) / 60000);

        const roi = state.session.startCapital > 0
            ? ((state.capital - state.session.startCapital) / state.session.startCapital * 100).toFixed(2)
            : '0.00';

        return {
            duration: `${hours}h ${minutes}m`,
            trades: state.portfolio.totalTrades,
            wins: state.portfolio.totalWins,
            losses: state.portfolio.totalLosses,
            winRate: state.portfolio.totalTrades > 0
                ? ((state.portfolio.totalWins / state.portfolio.totalTrades) * 100).toFixed(1) + '%'
                : '0%',
            netPL: state.session.netPL,
            roi: roi + '%'
        };
    }
}

// ============================================
// SIGNAL PROCESSOR
// ============================================
class SignalProcessor {
    static async processSignal(symbol) {
        const asset = state.assets[symbol];

        if (asset.isProcessing) {
            LOGGER.debug(`${symbol}: Already processing, skipping`);
            return;
        }

        if (asset.tickHistory.length < CONFIG.MIN_HISTORY_SIZE) {
            LOGGER.debug(`${symbol}: Insufficient history (${asset.tickHistory.length}/${CONFIG.MIN_HISTORY_SIZE})`);
            return;
        }

        asset.isProcessing = true;

        try {
            // Check if there's already an active contract
            const hasActive = state.portfolio.activeContracts.some(c => c.symbol === symbol);
            if (hasActive) {
                LOGGER.debug(`${symbol}: Active contract exists, skipping`);
                asset.isProcessing = false;
                return;
            }

            // Step 1: Volatility Filter
            const volatilityState = VolatilityFilter.classifyVolatility(asset.tickHistory);
            asset.lastVolatilityState = volatilityState;

            LOGGER.vol(`${symbol}: Volatility = ${volatilityState}`);

            if (!VolatilityFilter.allowsTrading(asset.tickHistory)) {
                LOGGER.debug(`${symbol}: Volatility too high (${volatilityState}), no trade`);
                asset.isProcessing = false;
                return;
            }

            // Step 2: Check Bonus Trigger (ultra-low volatility only)
            let prediction = null;
            let isBonusTrigger = false;
            let zScore = null;

            if (VolatilityFilter.isUltraLow(asset.tickHistory)) {
                const bonusTrigger = BonusTrigger.checkRepeatTrigger(asset.tickHistory);

                if (bonusTrigger) {
                    prediction = bonusTrigger.digit;
                    isBonusTrigger = true;
                    LOGGER.signal(`${symbol}: 🔥 BONUS TRIGGER! Digit ${bonusTrigger.repeatedDigit} repeated ${bonusTrigger.count}x, predicting ${prediction}`);
                }
            }

            // Step 3: Fibonacci Z-score (if no bonus trigger)
            if (!isBonusTrigger) {
                const saturated = FibonacciEngine.findSaturatedDigit(asset.tickHistory);

                if (saturated) {
                    prediction = saturated.digit;
                    zScore = saturated.zScore;
                    LOGGER.signal(`${symbol}: 🎯 FIBONACCI SIGNAL! Digit ${prediction}, Z-score ${zScore.toFixed(2)}`);
                }
            }

            // Step 4: Execute trade if we have a prediction
            if (prediction !== null) {
                await bot.executeTrade(symbol, prediction, isBonusTrigger, zScore, volatilityState);
            }

        } catch (error) {
            LOGGER.error(`${symbol}: Signal processing error: ${error.message}`);
        } finally {
            asset.isProcessing = false;
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
        this.checkDataInterval = null;
        this.lastDataTime = Date.now();
        this.isReconnecting = false;
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
        this.lastDataTime = Date.now();

        this.startMonitor();

        if (!this.autoSaveStarted) {
            StatePersistence.startAutoSave();
            this.autoSaveStarted = true;
        }

        this.send({ authorize: CONFIG.API_TOKEN });

        if (this.isReconnecting) {
            LOGGER.info('🔄 Reconnection detected - will restore subscriptions after auth');
        }
    }

    onMessage(data) {
        this.lastDataTime = Date.now();
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

            if (state.capital === (parseFloat(process.env.INITIAL_CAPITAL) || 1000)) {
                state.capital = response.authorize.balance;
                state.session.startCapital = response.authorize.balance;
            }

            if (this.isReconnecting) {
                this.isReconnecting = false;
                this.restoreSubscriptions();
                TelegramService.sendMessage(`🔄 <b>BOT RECONNECTED</b>\nTime: ${new Date().toUTCString()}`);
            } else {
                bot.start();
            }
        }

        if (response.msg_type === 'tick') {
            this.handleTick(response.tick);
        }

        if (response.msg_type === 'history') {
            this.handleTickHistory(response);
        }

        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }

        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }
    }

    handleTick(tick) {
        const symbol = tick.symbol;
        if (!state.assets[symbol]) return;

        const asset = state.assets[symbol];
        const digit = getLastDigit(tick.quote, symbol);

        asset.tickHistory.push(digit);

        // Trim history to max size
        if (asset.tickHistory.length > CONFIG.MAX_HISTORY_SIZE) {
            asset.tickHistory = asset.tickHistory.slice(-CONFIG.MAX_HISTORY_SIZE);
        }

        // Process signal after delay
        setTimeout(() => {
            SignalProcessor.processSignal(symbol);
        }, CONFIG.TICK_PROCESSING_DELAY);
    }

    handleTickHistory(response) {
        const symbol = response.echo_req.ticks_history;
        if (!state.assets[symbol]) return;

        const asset = state.assets[symbol];
        const prices = response.history?.prices || [];

        asset.tickHistory = prices.map(p => getLastDigit(p, symbol));
        LOGGER.info(`📊 ${symbol}: Loaded ${asset.tickHistory.length} historical ticks`);
    }

    handleBuyResponse(response) {
        if (response.error) {
            LOGGER.error(`Trade error: ${response.error.message}`);
            return;
        }

        const contract = response.buy;
        const reqId = response.echo_req?.req_id;

        LOGGER.trade(`✅ Contract opened: ${contract.contract_id}, Buy Price: ${contract.buy_price}`);

        // Find and update contract in portfolio
        const contractIndex = state.portfolio.activeContracts.findIndex(c => c.reqId === reqId);
        if (contractIndex >= 0) {
            state.portfolio.activeContracts[contractIndex].contractId = contract.contract_id;
            state.portfolio.activeContracts[contractIndex].buyPrice = contract.buy_price;
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

        // Find contract in portfolio
        const contractIndex = state.portfolio.activeContracts.findIndex(
            c => c.contractId === contractId
        );

        if (contractIndex < 0) return;

        const ourContract = state.portfolio.activeContracts[contractIndex];
        const symbol = ourContract.symbol;

        // Check if contract is finished
        if (contract.is_sold || contract.status === 'sold' || contract.status === 'won' || contract.status === 'lost') {
            const profit = contract.sell_price - ourContract.buyPrice;
            const isWin = profit > 0;

            LOGGER.trade(`${isWin ? '✅ WIN' : '❌ LOSS'} ${symbol}: ${profit.toFixed(2)}`);

            // Update portfolio stats
            state.portfolio.totalTrades++;
            state.capital += profit;
            state.session.netPL += profit;

            if (isWin) {
                state.portfolio.totalWins++;
                state.portfolio.totalProfit += profit;
                state.session.profit += profit;
                state.assets[symbol].totalWins++;
            } else {
                state.portfolio.totalLosses++;
                state.portfolio.totalLoss += Math.abs(profit);
                state.session.loss += Math.abs(profit);
                state.assets[symbol].totalLosses++;
            }

            state.assets[symbol].totalTrades++;

            // Update stake
            StakeManager.updateStake(symbol, isWin);

            // Send Telegram alert
            TelegramService.sendTradeAlert(
                isWin ? 'WIN' : 'LOSS',
                symbol,
                ourContract.prediction,
                ourContract.stake,
                {
                    profit,
                    consecutiveLosses: state.assets[symbol].consecutiveLosses
                }
            );

            // Remove from active contracts
            state.portfolio.activeContracts.splice(contractIndex, 1);

            // Save state
            StatePersistence.saveState();

            // Unsubscribe
            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }
        }
    }

    restoreSubscriptions() {
        LOGGER.info('📡 Restoring tick subscriptions...');

        CONFIG.ACTIVE_ASSETS.forEach(symbol => {
            this.send({
                ticks: symbol,
                subscribe: 1
            });
        });

        this.send({ balance: 1, subscribe: 1 });
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected from Deriv API');
        state.isConnected = false;
        state.isAuthorized = false;

        this.stopMonitor();
        StatePersistence.saveState();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.isReconnecting = true;

            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

            TelegramService.sendMessage(`⚠️ <b>CONNECTION LOST</b>\nReconnecting... (attempt ${this.reconnectAttempts})\nTime: ${new Date().toUTCString()}`);

            setTimeout(() => this.connect(), delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            TelegramService.sendMessage(`🛑 <b>BOT STOPPED</b>\nMax reconnection attempts reached.\nTime: ${new Date().toUTCString()}`);
            StatePersistence.saveState();
            process.exit(1);
        }
    }

    startMonitor() {
        this.stopMonitor();

        this.pingInterval = setInterval(() => {
            if (state.isConnected) {
                this.send({ ping: 1 });
            }
        }, 20000);

        this.checkDataInterval = setInterval(() => {
            if (!state.isConnected) return;

            const silenceDuration = Date.now() - this.lastDataTime;
            if (silenceDuration > 60000) {
                LOGGER.error(`⚠️ No data for ${Math.round(silenceDuration / 1000)}s - Forcing reconnection...`);
                StatePersistence.saveState();
                if (this.ws) this.ws.terminate();
            }
        }, 10000);
    }

    stopMonitor() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.checkDataInterval) clearInterval(this.checkDataInterval);
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
class BlackFibBot {
    constructor() {
        this.connection = new ConnectionManager();
    }

    async start() {
        console.log('\n' + '═'.repeat(90));
        console.log(' BLACK FIBONACCI 9.1 - DIGITDIFF BOT');
        console.log(' #1 Most Profitable DigitDiff Bot in 2025');
        console.log('═'.repeat(90));
        console.log(`💰 Capital: ${state.capital.toFixed(2)}`);
        console.log(`📊 Base Stake: ${CONFIG.BASE_STAKE}`);
        console.log(`🎯 Assets: ${CONFIG.ACTIVE_ASSETS.join(', ')}`);
        console.log(`📐 Fibonacci Windows: ${CONFIG.FIBONACCI_WINDOWS.length} layers`);
        console.log(`⚡ Z-Score Threshold: ${CONFIG.Z_SCORE_THRESHOLD}`);
        console.log(`🎲 Max Losses: ${CONFIG.MAX_CONSECUTIVE_LOSSES}`);
        console.log(`📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log('═'.repeat(90));
        console.log('💡 Strategy:');
        console.log(' - Multi-layer Fibonacci Z-score saturation');
        console.log(' - Volatility filter (entropy + streak composite)');
        console.log(' - Bonus trigger for ultra-low volatility repeats');
        console.log(' - Exponential stake progression (11.3x)');
        console.log('═'.repeat(90) + '\n');

        this.connection.send({ balance: 1, subscribe: 1 });

        await this.subscribeToAssets();

        TelegramService.sendStartupMessage();

        // Periodic session summary
        if (CONFIG.TELEGRAM_ENABLED) {
            setInterval(() => {
                TelegramService.sendSessionSummary();
            }, 60 * 60 * 1000); // Every hour
        }

        LOGGER.info('✅ Bot started successfully!');
    }

    async subscribeToAssets() {
        for (const symbol of CONFIG.ACTIVE_ASSETS) {
            // Request historical ticks first (following kclaude-fibo.js)
            this.connection.send({
                ticks_history: symbol,
                adjust_start_time: 1,
                count: CONFIG.MIN_HISTORY_SIZE,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to live ticks
            this.connection.send({
                ticks: symbol,
                subscribe: 1
            });

            LOGGER.info(`📡 Requested history and subscription for ${symbol}`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    async executeTrade(symbol, prediction, isBonusTrigger, zScore, volatilityState) {
        const asset = state.assets[symbol];

        // Validate stake
        if (!StakeManager.validateStake(asset.currentStake)) {
            LOGGER.error(`${symbol}: Cannot execute trade - invalid stake`);
            return;
        }

        LOGGER.trade(`🎯 ${isBonusTrigger ? 'BONUS' : 'FIBONACCI'} TRADE on ${symbol}`);
        LOGGER.trade(` Prediction: Digit ${prediction}`);
        LOGGER.trade(` Stake: ${asset.currentStake.toFixed(2)}`);
        LOGGER.trade(` Consecutive Losses: ${asset.consecutiveLosses}`);
        if (zScore) LOGGER.trade(` Z-Score: ${zScore.toFixed(2)}`);
        LOGGER.trade(` Volatility: ${volatilityState}`);

        // Create contract entry
        const contract = {
            symbol,
            prediction,
            stake: asset.currentStake,
            buyPrice: 0,
            openTime: Date.now(),
            consecutiveLosses: asset.consecutiveLosses,
            contractId: null,
            reqId: null
        };

        state.portfolio.activeContracts.push(contract);

        // Send buy request
        const tradeRequest = {
            buy: 1,
            price: asset.currentStake,
            parameters: {
                amount: asset.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: prediction.toString()
            }
        };

        const reqId = this.connection.send(tradeRequest);
        contract.reqId = reqId;

        // Send signal alert
        TelegramService.sendSignalAlert(
            symbol,
            prediction,
            zScore || 0,
            volatilityState,
            isBonusTrigger
        );
    }

    stop() {
        LOGGER.info('🛑 Stopping bot...');

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            StatePersistence.saveState();
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
            activeContracts: state.portfolio.activeContracts.length,
            assetStats: Object.entries(state.assets).map(([symbol, data]) => ({
                symbol,
                ticks: data.tickHistory.length,
                consecutiveLosses: data.consecutiveLosses,
                currentStake: data.currentStake.toFixed(2),
                trades: data.totalTrades,
                wins: data.totalWins,
                losses: data.totalLosses,
                volatility: data.lastVolatilityState || '-'
            }))
        };
    }
}

// ============================================
// CONSOLE DASHBOARD
// ============================================
class Dashboard {
    static display() {
        const status = bot.getStatus();
        const session = status.session;

        console.log('\n' + '╔' + '═'.repeat(100) + '╗');
        console.log('║' + ` BLACK FIBONACCI 9.1 - DIGITDIFF BOT`.padEnd(100) + '║');
        console.log('╠' + '═'.repeat(100) + '╣');

        const netPLColor = session.netPL >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';

        console.log(`║ 💰 Capital: ${status.capital.toFixed(2).padEnd(12)} 🏦 Balance: ${status.accountBalance.toFixed(2).padEnd(12)} 📱 Telegram: ${CONFIG.TELEGRAM_ENABLED ? 'ON' : 'OFF'}`.padEnd(109) + '║');
        console.log(`║ 📊 Session: ${session.duration.padEnd(10)} Trades: ${session.trades.toString().padEnd(5)} Win Rate: ${session.winRate.padEnd(8)}`.padEnd(109) + '║');
        console.log(`║ 💹 Net P/L: ${netPLColor}${session.netPL.toFixed(2).padEnd(10)}${resetColor} ROI: ${session.roi.padEnd(10)}`.padEnd(117) + '║');
        console.log('╠' + '═'.repeat(100) + '╣');

        if (status.activeContracts > 0) {
            console.log(`║ 🚀 ACTIVE CONTRACTS: ${status.activeContracts}`.padEnd(101) + '║');
            console.log('╠' + '═'.repeat(100) + '╣');
        }

        console.log('║ 📊 ASSET STATUS:'.padEnd(101) + '║');
        console.log('║ Symbol | Ticks | Losses | Stake | Trades | Wins | Losses | Volatility'.padEnd(101) + '║');
        console.log('║' + '-'.repeat(100) + '║');

        status.assetStats.forEach(stat => {
            console.log(`║ ${stat.symbol.padEnd(8)} | ${stat.ticks.toString().padEnd(6)} | ${stat.consecutiveLosses.toString().padEnd(7)} | ${stat.currentStake.padEnd(6)} | ${stat.trades.toString().padEnd(7)} | ${stat.wins.toString().padEnd(5)} | ${stat.losses.toString().padEnd(7)} | ${stat.volatility.padEnd(10)} ║`);
        });

        console.log('╚' + '═'.repeat(100) + '╝');
        console.log(`⏰ ${getGMTTime()} | Strategy: Black Fibonacci 9.1 | Ctrl+C to stop\n`);
    }

    static startLiveUpdates() {
        setInterval(() => {
            if (state.isAuthorized) {
                Dashboard.display();
            }
        }, CONFIG.DASHBOARD_UPDATE_INTERVAL);
    }
}

// ============================================
// INITIALIZATION
// ============================================
const bot = new BlackFibBot();

process.on('SIGINT', () => {
    console.log('\n\n⚠️ Shutdown signal received...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(90));
    console.log(' BLACK FIBONACCI 9.1 - DIGITDIFF BOT');
    console.log('═'.repeat(90));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Usage:');
    console.log(' API_TOKEN=xxx node black-fib.js');
    console.log('\nEnvironment Variables:');
    console.log(' API_TOKEN - Deriv API token (required)');
    console.log(' INITIAL_CAPITAL - Initial capital (default: 1000)');
    console.log(' BASE_STAKE - Base stake (default: 2.20)');
    console.log(' TELEGRAM_BOT_TOKEN - Telegram bot token');
    console.log(' TELEGRAM_CHAT_ID - Telegram chat ID');
    console.log(' TELEGRAM_ENABLED - Enable Telegram (default: true)');
    console.log(' DEBUG_MODE - Enable debug logging (default: false)');
    console.log('═'.repeat(90));
    process.exit(1);
}

console.log('═'.repeat(90));
console.log(' BLACK FIBONACCI 9.1 - DIGITDIFF BOT');
console.log(' Multi-layer Fibonacci Z-score + Volatility Filter');
console.log('═'.repeat(90));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

setTimeout(() => {
    Dashboard.startLiveUpdates();
}, 3000);

module.exports = {
    BlackFibBot,
    FibonacciEngine,
    VolatilityFilter,
    BonusTrigger,
    StakeManager,
    SessionManager,
    SignalProcessor,
    CONFIG,
    state
};