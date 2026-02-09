const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// EXPERIMENT CONFIGURATION
// ============================================
// This bot tests the claim that Step Index on odd ticks
// provides ≥99% payout (positive EV on a ~50% probability event).
//
// HYPOTHESIS BEING TESTED:
// "Step Index on odd tick durations (5,7,9,...,25) gives payouts
//  ≥99%, creating positive expected value."
//
// NULL HYPOTHESIS:
// "Payouts are ≤98.5%, meaning negative EV regardless of tick parity."
//
// We run 10,000+ flat-stake trades and measure:
//   1. Actual win rate
//   2. Actual average payout received
//   3. Net P&L over the full sample
// ============================================

const STATE_FILE = path.join(__dirname, 'stepindex-experiment-state.json');
const TRADE_LOG_FILE = path.join(__dirname, 'stepindex-experiment-trades.csv');
const RESULTS_FILE = path.join(__dirname, 'stepindex-experiment-results.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// LOGGER UTILITY
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    experiment: (msg) => console.log(`\x1b[36m[EXPERIMENT] ${getGMTTime()} - ${msg}\x1b[0m`)
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings
    API_TOKEN: 'Dz2V2KvRf4Uukt3',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 500,

    // FLAT STAKE — no martingale for clean experiment
    STAKE: 0.35, // Minimum or small stake to maximize trade count

    // Session Targets — set high to allow 10k+ trades
    SESSION_PROFIT_TARGET: 99999,
    SESSION_STOP_LOSS: -250,

    // TICK-BASED TRADING (the core of the stpRNG claim)
    DURATION_UNIT: 't', // TICKS — this is critical

    // Odd tick durations to cycle through (as per the claim)
    ODD_TICK_DURATIONS: [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25],

    // Current duration index (cycles through ODD_TICK_DURATIONS)
    CURRENT_DURATION_INDEX: 0,

    // Trade Settings
    MAX_OPEN_POSITIONS: 1,
    TRADE_DELAY: 1500,        // ms between trades
    TARGET_TRADE_COUNT: 10000, // Experiment target

    // NO MARTINGALE — flat betting for clean data
    USE_MARTINGALE: false,

    // Direction strategy: 'RANDOM' | 'ALTERNATE' | 'ALWAYS_RISE' | 'ALWAYS_FALL'
    DIRECTION_STRATEGY: 'ALTERNATE',

    // Debug
    DEBUG_MODE: true,

    // Telegram Settings
    TELEGRAM_ENABLED: false,
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
};

// Assets to test — the three Step Index variants from the claim
// NOTE: You must verify these symbol names exist on your Deriv account
// The standard Step Index symbol on Deriv is 'stpRNG'
// 'Step Index v2' and 'Step Index 0.1' may use different symbols
let ACTIVE_ASSETS = [
    'stpRNG',          // Step Index (classic)
    // Uncomment below if these symbols exist on your account:
    // 'stpRNG2',       // Step Index v2 (verify actual symbol)
    // 'stpRNG01',      // Step Index 0.1 (verify actual symbol)
];

// ============================================
// TRADE DATA LOGGER — records every trade to CSV
// ============================================
class TradeDataLogger {
    static initialized = false;

    static initialize() {
        if (this.initialized) return;

        // Create CSV header if file doesn't exist
        if (!fs.existsSync(TRADE_LOG_FILE)) {
            const header = [
                'trade_number',
                'timestamp',
                'symbol',
                'direction',
                'duration_ticks',
                'stake',
                'buy_price',
                'payout_received',
                'profit',
                'result',         // WIN or LOSS
                'payout_ratio',   // payout/stake — the KEY metric
                'cumulative_pnl',
                'win_rate_so_far',
                'avg_payout_ratio'
            ].join(',');

            fs.writeFileSync(TRADE_LOG_FILE, header + '\n');
            LOGGER.experiment('📝 Trade log CSV created: ' + TRADE_LOG_FILE);
        }

        this.initialized = true;
    }

    static logTrade(data) {
        this.initialize();

        const row = [
            data.tradeNumber,
            new Date().toISOString(),
            data.symbol,
            data.direction,
            data.durationTicks,
            data.stake.toFixed(4),
            data.buyPrice.toFixed(4),
            data.payoutReceived.toFixed(4),
            data.profit.toFixed(4),
            data.result,
            data.payoutRatio.toFixed(6),
            data.cumulativePnl.toFixed(4),
            data.winRateSoFar.toFixed(4),
            data.avgPayoutRatio.toFixed(6)
        ].join(',');

        fs.appendFileSync(TRADE_LOG_FILE, row + '\n');
    }
}

// ============================================
// EXPERIMENT STATISTICS TRACKER
// ============================================
class ExperimentStats {
    static data = {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        ties: 0,  // Track ties separately — critical for the claim
        totalStaked: 0,
        totalReturned: 0,
        totalProfit: 0,
        payoutRatios: [],   // Store every payout ratio
        winPayoutRatios: [], // Payout ratios on wins only

        // Per-duration tracking
        byDuration: {},     // { 5: {wins, losses, totalStaked, totalReturned}, ... }

        // Per-asset tracking
        byAsset: {},        // { 'stpRNG': {wins, losses, ...}, ... }

        // Time-based tracking
        byHour: {},         // { 0: {...}, 1: {...}, ..., 23: {...} }

        // Streak tracking
        currentStreak: 0,
        currentStreakType: null, // 'W' or 'L'
        maxWinStreak: 0,
        maxLossStreak: 0,

        startTime: Date.now(),
        lastAnalysisAt: 0
    };

    static recordTrade(tradeData) {
        const d = this.data;
        d.totalTrades++;
        d.totalStaked += tradeData.stake;

        const duration = tradeData.durationTicks;
        const asset = tradeData.symbol;
        const hour = new Date().getUTCHours();

        // Initialize tracking buckets
        if (!d.byDuration[duration]) {
            d.byDuration[duration] = { wins: 0, losses: 0, ties: 0, totalStaked: 0, totalReturned: 0, trades: 0 };
        }
        if (!d.byAsset[asset]) {
            d.byAsset[asset] = { wins: 0, losses: 0, ties: 0, totalStaked: 0, totalReturned: 0, trades: 0 };
        }
        if (!d.byHour[hour]) {
            d.byHour[hour] = { wins: 0, losses: 0, ties: 0, totalStaked: 0, totalReturned: 0, trades: 0 };
        }

        const isWin = tradeData.profit > 0;
        const isTie = tradeData.profit === 0;

        if (isWin) {
            d.wins++;
            d.byDuration[duration].wins++;
            d.byAsset[asset].wins++;
            d.byHour[hour].wins++;

            const payoutReturn = tradeData.stake + tradeData.profit;
            const payoutRatio = payoutReturn / tradeData.stake;
            d.winPayoutRatios.push(payoutRatio);
            d.payoutRatios.push(payoutRatio);
            d.totalReturned += payoutReturn;
            d.byDuration[duration].totalReturned += payoutReturn;
            d.byAsset[asset].totalReturned += payoutReturn;
            d.byHour[hour].totalReturned += payoutReturn;

            // Streak tracking
            if (d.currentStreakType === 'W') {
                d.currentStreak++;
            } else {
                d.currentStreak = 1;
                d.currentStreakType = 'W';
            }
            d.maxWinStreak = Math.max(d.maxWinStreak, d.currentStreak);

        } else if (isTie) {
            d.ties++;
            d.byDuration[duration].ties++;
            d.byAsset[asset].ties++;
            d.byHour[hour].ties++;
            d.totalReturned += tradeData.stake; // Stake returned on tie
            d.byDuration[duration].totalReturned += tradeData.stake;
            d.byAsset[asset].totalReturned += tradeData.stake;
            d.byHour[hour].totalReturned += tradeData.stake;
            d.payoutRatios.push(1.0);

        } else {
            d.losses++;
            d.byDuration[duration].losses++;
            d.byAsset[asset].losses++;
            d.byHour[hour].losses++;
            d.totalReturned += 0;
            d.payoutRatios.push(0);

            // Streak tracking
            if (d.currentStreakType === 'L') {
                d.currentStreak++;
            } else {
                d.currentStreak = 1;
                d.currentStreakType = 'L';
            }
            d.maxLossStreak = Math.max(d.maxLossStreak, d.currentStreak);
        }

        d.totalProfit += tradeData.profit;
        d.byDuration[duration].totalStaked += tradeData.stake;
        d.byDuration[duration].trades++;
        d.byAsset[asset].totalStaked += tradeData.stake;
        d.byAsset[asset].trades++;
        d.byHour[hour].totalStaked += tradeData.stake;
        d.byHour[hour].trades++;

        // Log to CSV
        const winRate = d.wins / d.totalTrades;
        const avgPayoutRatio = d.winPayoutRatios.length > 0
            ? d.winPayoutRatios.reduce((a, b) => a + b, 0) / d.winPayoutRatios.length
            : 0;

        TradeDataLogger.logTrade({
            tradeNumber: d.totalTrades,
            symbol: tradeData.symbol,
            direction: tradeData.direction,
            durationTicks: tradeData.durationTicks,
            stake: tradeData.stake,
            buyPrice: tradeData.buyPrice || tradeData.stake,
            payoutReceived: isWin ? (tradeData.stake + tradeData.profit) : (isTie ? tradeData.stake : 0),
            profit: tradeData.profit,
            result: isWin ? 'WIN' : (isTie ? 'TIE' : 'LOSS'),
            payoutRatio: isWin ? ((tradeData.stake + tradeData.profit) / tradeData.stake) : (isTie ? 1.0 : 0),
            cumulativePnl: d.totalProfit,
            winRateSoFar: winRate,
            avgPayoutRatio: avgPayoutRatio
        });

        // Print analysis every 100 trades
        if (d.totalTrades % 100 === 0) {
            this.printAnalysis();
        }

        // Save results every 500 trades
        if (d.totalTrades % 500 === 0) {
            this.saveResults();
        }
    }

    static printAnalysis() {
        const d = this.data;
        const winRate = d.totalTrades > 0 ? (d.wins / d.totalTrades * 100).toFixed(2) : 0;
        const tieRate = d.totalTrades > 0 ? (d.ties / d.totalTrades * 100).toFixed(2) : 0;
        const lossRate = d.totalTrades > 0 ? (d.losses / d.totalTrades * 100).toFixed(2) : 0;
        const avgWinPayout = d.winPayoutRatios.length > 0
            ? (d.winPayoutRatios.reduce((a, b) => a + b, 0) / d.winPayoutRatios.length * 100).toFixed(2)
            : 0;
        const roi = d.totalStaked > 0 ? ((d.totalReturned - d.totalStaked) / d.totalStaked * 100).toFixed(4) : 0;
        const elapsed = ((Date.now() - d.startTime) / 60000).toFixed(1);

        console.log('\n' + '═'.repeat(80));
        LOGGER.experiment(`📊 EXPERIMENT ANALYSIS — ${d.totalTrades} / ${CONFIG.TARGET_TRADE_COUNT} trades`);
        console.log('─'.repeat(80));
        LOGGER.experiment(`⏱️  Elapsed: ${elapsed} min | Rate: ${(d.totalTrades / (elapsed || 1) * 60).toFixed(0)} trades/hr`);
        LOGGER.experiment(`📈 Win Rate: ${winRate}% (${d.wins}W / ${d.losses}L / ${d.ties}T)`);
        LOGGER.experiment(`💰 Avg Win Payout: ${avgWinPayout}% of stake`);
        LOGGER.experiment(`📊 ROI: ${roi}%`);
        LOGGER.experiment(`💵 Net P&L: $${d.totalProfit.toFixed(4)} (Staked: $${d.totalStaked.toFixed(2)}, Returned: $${d.totalReturned.toFixed(2)})`);
        LOGGER.experiment(`🔥 Streaks — Max Win: ${d.maxWinStreak} | Max Loss: ${d.maxLossStreak} | Current: ${d.currentStreak}${d.currentStreakType}`);

        // Per-duration breakdown
        console.log('─'.repeat(80));
        LOGGER.experiment('📊 PER-DURATION BREAKDOWN:');
        Object.keys(d.byDuration).sort((a, b) => Number(a) - Number(b)).forEach(dur => {
            const stats = d.byDuration[dur];
            const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : 0;
            const durRoi = stats.totalStaked > 0
                ? ((stats.totalReturned - stats.totalStaked) / stats.totalStaked * 100).toFixed(3)
                : 0;
            LOGGER.experiment(`  ${dur} ticks: ${stats.trades} trades, ${wr}% WR, ${durRoi}% ROI, ${stats.ties} ties`);
        });

        // Per-hour breakdown (to test the "22:00-06:00 GMT" claim)
        if (Object.keys(d.byHour).length > 3) {
            console.log('─'.repeat(80));
            LOGGER.experiment('📊 PER-HOUR BREAKDOWN (UTC):');
            for (let h = 0; h < 24; h++) {
                if (d.byHour[h] && d.byHour[h].trades > 0) {
                    const stats = d.byHour[h];
                    const wr = (stats.wins / stats.trades * 100).toFixed(1);
                    const hourRoi = stats.totalStaked > 0
                        ? ((stats.totalReturned - stats.totalStaked) / stats.totalStaked * 100).toFixed(3)
                        : 0;
                    const isClaimedGoodHour = (h >= 22 || h <= 6) ? ' ⭐ (claimed good hour)' : '';
                    LOGGER.experiment(`  ${String(h).padStart(2, '0')}:00 UTC: ${stats.trades} trades, ${wr}% WR, ${hourRoi}% ROI${isClaimedGoodHour}`);
                }
            }
        }

        console.log('═'.repeat(80) + '\n');

        // Check if target reached
        if (d.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            this.printFinalConclusion();
        }
    }

    static printFinalConclusion() {
        const d = this.data;
        const winRate = d.wins / d.totalTrades;
        const avgWinPayout = d.winPayoutRatios.length > 0
            ? d.winPayoutRatios.reduce((a, b) => a + b, 0) / d.winPayoutRatios.length
            : 0;
        const roi = d.totalStaked > 0
            ? (d.totalReturned - d.totalStaked) / d.totalStaked
            : 0;

        // Statistical significance test
        // Under null hypothesis: win rate = 50%, expected variance = p(1-p)/n
        const expectedWinRate = 0.5;
        const standardError = Math.sqrt(expectedWinRate * (1 - expectedWinRate) / d.totalTrades);
        const zScore = (winRate - expectedWinRate) / standardError;
        const isSignificant = Math.abs(zScore) > 1.96; // 95% confidence

        console.log('\n' + '🏁'.repeat(40));
        console.log('═'.repeat(80));
        LOGGER.experiment('🏁 EXPERIMENT COMPLETE — FINAL RESULTS');
        console.log('═'.repeat(80));
        LOGGER.experiment(`Total Trades: ${d.totalTrades}`);
        LOGGER.experiment(`Win Rate: ${(winRate * 100).toFixed(3)}%`);
        LOGGER.experiment(`Tie Rate: ${(d.ties / d.totalTrades * 100).toFixed(3)}%`);
        LOGGER.experiment(`Average Win Payout: ${(avgWinPayout * 100).toFixed(3)}% of stake`);
        LOGGER.experiment(`ROI: ${(roi * 100).toFixed(4)}%`);
        LOGGER.experiment(`Net P&L: $${d.totalProfit.toFixed(4)}`);
        LOGGER.experiment(`Total Staked: $${d.totalStaked.toFixed(2)}`);
        LOGGER.experiment(`Total Returned: $${d.totalReturned.toFixed(2)}`);
        console.log('─'.repeat(80));
        LOGGER.experiment(`Z-Score (win rate vs 50%): ${zScore.toFixed(4)}`);
        LOGGER.experiment(`Statistically Significant: ${isSignificant ? 'YES' : 'NO'} (95% CI)`);
        console.log('─'.repeat(80));

        if (roi > 0) {
            LOGGER.experiment(`✅ RESULT: POSITIVE ROI — The claim MAY have merit.`);
            LOGGER.experiment(`   However, verify this is not due to variance.`);
            LOGGER.experiment(`   Expected: roi > 0 AND z-score > 1.96 for significance.`);
        } else {
            LOGGER.experiment(`❌ RESULT: NEGATIVE ROI — The claim is NOT supported.`);
            LOGGER.experiment(`   The payout does NOT exceed the break-even threshold.`);
        }

        if (avgWinPayout >= 1.99) {
            LOGGER.experiment(`✅ PAYOUT CHECK: Average win payout ≥ 99% — MATCHES claim`);
        } else {
            LOGGER.experiment(`❌ PAYOUT CHECK: Average win payout < 99% — CONTRADICTS claim`);
            LOGGER.experiment(`   Claimed: ≥99% | Actual: ${(avgWinPayout * 100).toFixed(2)}%`);
        }

        console.log('═'.repeat(80));
        console.log('🏁'.repeat(40) + '\n');

        this.saveResults();
    }

    static saveResults() {
        try {
            const d = this.data;
            const results = {
                savedAt: new Date().toISOString(),
                totalTrades: d.totalTrades,
                wins: d.wins,
                losses: d.losses,
                ties: d.ties,
                winRate: d.totalTrades > 0 ? d.wins / d.totalTrades : 0,
                totalStaked: d.totalStaked,
                totalReturned: d.totalReturned,
                totalProfit: d.totalProfit,
                roi: d.totalStaked > 0 ? (d.totalReturned - d.totalStaked) / d.totalStaked : 0,
                avgWinPayoutRatio: d.winPayoutRatios.length > 0
                    ? d.winPayoutRatios.reduce((a, b) => a + b, 0) / d.winPayoutRatios.length
                    : 0,
                maxWinStreak: d.maxWinStreak,
                maxLossStreak: d.maxLossStreak,
                byDuration: d.byDuration,
                byAsset: d.byAsset,
                byHour: d.byHour,
                elapsedMinutes: (Date.now() - d.startTime) / 60000
            };

            fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
            LOGGER.experiment(`💾 Results saved to ${RESULTS_FILE}`);
        } catch (error) {
            LOGGER.error(`Failed to save results: ${error.message}`);
        }
    }
}

// ============================================
// STATE PERSISTENCE MANAGER
// ============================================
class StatePersistence {
    static saveState() {
        try {
            const persistableState = {
                savedAt: Date.now(),
                capital: state.capital,
                session: { ...state.session },
                portfolio: {
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
                currentDurationIndex: state.currentDurationIndex,
                experimentStats: ExperimentStats.data
            };

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📂 No previous state file found, starting fresh experiment');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 120) { // 2 hours timeout for experiment
                LOGGER.warn(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            LOGGER.info(`📂 Restoring experiment state from ${ageMinutes.toFixed(1)} minutes ago`);

            state.capital = savedData.capital;
            state.session = { ...state.session, ...savedData.session };
            state.lastTradeDirection = savedData.lastTradeDirection || null;
            state.currentDurationIndex = savedData.currentDurationIndex || 0;

            state.portfolio.activePositions = (savedData.portfolio.activePositions || []);

            // Restore experiment stats
            if (savedData.experimentStats) {
                ExperimentStats.data = savedData.experimentStats;
                ExperimentStats.data.startTime = savedData.experimentStats.startTime || Date.now();
                LOGGER.info(`   📊 Restored ${ExperimentStats.data.totalTrades} trades of experiment data`);
            }

            LOGGER.info(`✅ Experiment state restored!`);
            LOGGER.info(`   💰 Capital: $${state.capital.toFixed(2)}`);
            LOGGER.info(`   📊 Trades so far: ${ExperimentStats.data.totalTrades}/${CONFIG.TARGET_TRADE_COUNT}`);
            LOGGER.info(`   📈 Net P&L: $${ExperimentStats.data.totalProfit.toFixed(4)}`);

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
}

// ============================================
// TELEGRAM SERVICE (simplified for experiment)
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
                headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
            };

            return new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => resolve(true));
                });
                req.on('error', reject);
                req.write(data);
                req.end();
            });
        } catch (error) {
            LOGGER.error(`Telegram error: ${error.message}`);
        }
    }

    static async sendMilestone(tradeCount) {
        const d = ExperimentStats.data;
        const wr = d.totalTrades > 0 ? (d.wins / d.totalTrades * 100).toFixed(2) : 0;
        const message = `
🔬 <b>EXPERIMENT MILESTONE: ${tradeCount} trades</b>
Win Rate: ${wr}%
Net P&L: $${d.totalProfit.toFixed(4)}
ROI: ${d.totalStaked > 0 ? ((d.totalReturned - d.totalStaked) / d.totalStaked * 100).toFixed(4) : 0}%
Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }

    static startHourlyTimer() { /* Not needed for experiment */ }
}

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
    capital: CONFIG.INITIAL_CAPITAL,
    accountBalance: 0,
    currentStake: CONFIG.STAKE,
    currentDurationIndex: 0,
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
        activePositions: []
    },
    lastTradeDirection: null,
    requestId: 1,
    canTrade: false,
    tradeInProgress: false,
    pendingTradeTimeout: null
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

        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 SESSION STOP LOSS REACHED! Net P/L: $${netPL.toFixed(2)}`);
            state.session.isActive = false;
            ExperimentStats.printAnalysis();
            ExperimentStats.saveResults();
            return true;
        }

        if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            LOGGER.experiment(`🏁 TARGET TRADE COUNT REACHED: ${CONFIG.TARGET_TRADE_COUNT}`);
            ExperimentStats.printFinalConclusion();
            state.session.isActive = false;
            return true;
        }

        return false;
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

    static recordTradeResult(profit, direction, symbol, durationTicks, buyPrice) {
        state.session.tradesCount++;
        state.capital += profit;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
        } else if (profit < 0) {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
        }
        // profit === 0 is a tie, counted separately

        // Record in experiment stats
        ExperimentStats.recordTrade({
            symbol: symbol,
            direction: direction,
            durationTicks: durationTicks,
            stake: CONFIG.STAKE,
            buyPrice: buyPrice || CONFIG.STAKE,
            profit: profit
        });

        // Send Telegram milestone every 1000 trades
        if (ExperimentStats.data.totalTrades % 1000 === 0) {
            TelegramService.sendMilestone(ExperimentStats.data.totalTrades);
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
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
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

            if (state.capital === CONFIG.INITIAL_CAPITAL && response.authorize.balance > 0) {
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

            const reqId = response.echo_req?.req_id;
            if (reqId) {
                const posIndex = state.portfolio.activePositions.findIndex(p => p.reqId === reqId);
                if (posIndex >= 0) {
                    state.portfolio.activePositions.splice(posIndex, 1);
                }
            }

            // Allow next trade after error
            state.tradeInProgress = false;
            bot.scheduleNextTrade();
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Position opened: Contract ${contract.contract_id}, Buy Price: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);

        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;
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
            state.tradeInProgress = false;
            bot.scheduleNextTrade();
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
            const result = profit > 0 ? 'WIN' : (profit === 0 ? 'TIE' : 'LOSS');
            const emoji = profit > 0 ? '✅' : (profit === 0 ? '🟡' : '❌');

            LOGGER.trade(`${emoji} Contract ${contractId}: ${result} $${profit.toFixed(4)} | Duration: ${position.duration}t | Direction: ${position.direction}`);

            SessionManager.recordTradeResult(
                profit,
                position.direction,
                position.symbol,
                position.duration,
                position.buyPrice
            );

            state.portfolio.activePositions.splice(posIndex, 1);

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            state.tradeInProgress = false;

            const shouldStop = SessionManager.checkSessionTargets();
            StatePersistence.saveState();

            if (!shouldStop) {
                // Schedule next trade
                bot.scheduleNextTrade();
            }
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

            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                this.isReconnecting = false;
                this.connect();
            }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached.');
            ExperimentStats.printFinalConclusion();
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
// MAIN BOT CLASS — EXPERIMENT MODE
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
    }

    async start() {
        console.log('\n' + '═'.repeat(80));
        console.log(' 🔬 STEP INDEX ARBITRAGE VERIFICATION EXPERIMENT');
        console.log('═'.repeat(80));
        console.log(`💰 Capital: $${state.capital.toFixed(2)}`);
        console.log(`📊 Assets: ${ACTIVE_ASSETS.join(', ')}`);
        console.log(`💵 Flat Stake: $${CONFIG.STAKE} (no martingale)`);
        console.log(`⏱️ Durations: ${CONFIG.ODD_TICK_DURATIONS.join(', ')} ticks (odd only)`);
        console.log(`🎯 Target: ${CONFIG.TARGET_TRADE_COUNT} trades`);
        console.log(`📝 Trade log: ${TRADE_LOG_FILE}`);
        console.log(`📊 Results: ${RESULTS_FILE}`);
        console.log('═'.repeat(80));
        console.log('');
        console.log('HYPOTHESIS: Step Index on odd ticks gives ≥99% payout (positive EV)');
        console.log('NULL HYPOTHESIS: Payouts are <99%, resulting in negative EV');
        console.log('');
        console.log('METHODOLOGY:');
        console.log('  - Flat stake (no martingale) to isolate payout edge');
        console.log('  - Cycle through odd tick durations (5,7,9,...,25)');
        console.log('  - Alternate RISE/FALL to eliminate directional bias');
        console.log('  - Record every trade to CSV for analysis');
        console.log('  - Statistical significance test at completion');
        console.log('═'.repeat(80) + '\n');

        const remaining = CONFIG.TARGET_TRADE_COUNT - ExperimentStats.data.totalTrades;
        LOGGER.experiment(`📊 Progress: ${ExperimentStats.data.totalTrades}/${CONFIG.TARGET_TRADE_COUNT} (${remaining} remaining)`);

        if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            LOGGER.experiment('🏁 Experiment already complete! Printing final results...');
            ExperimentStats.printFinalConclusion();
            return;
        }

        // Initialize trade logger
        TradeDataLogger.initialize();

        // Start trading immediately (no candle subscription needed for tick-based)
        this.scheduleNextTrade();

        LOGGER.info('✅ Experiment bot started!');
    }

    getNextDuration() {
        const durations = CONFIG.ODD_TICK_DURATIONS;
        const duration = durations[state.currentDurationIndex % durations.length];
        state.currentDurationIndex++;
        return duration;
    }

    getNextDirection() {
        switch (CONFIG.DIRECTION_STRATEGY) {
            case 'RANDOM':
                return Math.random() < 0.5 ? 'CALL' : 'PUT';

            case 'ALTERNATE':
                if (state.lastTradeDirection === 'CALL') return 'PUT';
                if (state.lastTradeDirection === 'PUT') return 'CALL';
                return 'CALL'; // First trade

            case 'ALWAYS_RISE':
                return 'CALL';

            case 'ALWAYS_FALL':
                return 'PUT';

            default:
                return Math.random() < 0.5 ? 'CALL' : 'PUT';
        }
    }

    getNextAsset() {
        // Cycle through active assets
        const tradeNum = ExperimentStats.data.totalTrades;
        return ACTIVE_ASSETS[tradeNum % ACTIVE_ASSETS.length];
    }

    scheduleNextTrade() {
        if (!SessionManager.isSessionActive()) return;
        if (state.tradeInProgress) return;
        if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            ExperimentStats.printFinalConclusion();
            return;
        }

        // Clear any existing timeout
        if (state.pendingTradeTimeout) {
            clearTimeout(state.pendingTradeTimeout);
        }

        state.pendingTradeTimeout = setTimeout(() => {
            this.executeNextTrade();
        }, CONFIG.TRADE_DELAY);
    }

    executeNextTrade() {
        if (!state.isAuthorized || !state.isConnected) {
            LOGGER.warn('Not connected/authorized, will retry...');
            setTimeout(() => this.scheduleNextTrade(), 5000);
            return;
        }

        if (!SessionManager.isSessionActive()) return;
        if (state.tradeInProgress) return;
        if (state.portfolio.activePositions.length >= CONFIG.MAX_OPEN_POSITIONS) return;

        if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            ExperimentStats.printFinalConclusion();
            return;
        }

        const stake = CONFIG.STAKE; // Always flat stake

        if (state.capital < stake) {
            LOGGER.error(`❌ Insufficient capital: $${state.capital.toFixed(2)} < $${stake}`);
            LOGGER.experiment('🛑 Experiment ended due to insufficient capital');
            ExperimentStats.printFinalConclusion();
            state.session.isActive = false;
            return;
        }

        const symbol = this.getNextAsset();
        const direction = this.getNextDirection();
        const duration = this.getNextDuration();

        state.tradeInProgress = true;
        state.lastTradeDirection = direction;

        const tradeNum = ExperimentStats.data.totalTrades + 1;
        LOGGER.trade(`🔬 Trade #${tradeNum}/${CONFIG.TARGET_TRADE_COUNT} | ${symbol} | ${direction === 'CALL' ? 'RISE' : 'FALL'} | ${duration} ticks | $${stake}`);

        const position = {
            symbol: symbol,
            direction: direction,
            stake: stake,
            duration: duration,
            durationUnit: 't',
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
                symbol: symbol,
                currency: 'USD',
                amount: stake.toFixed(2),
                duration: duration,
                duration_unit: 't', // TICKS — critical
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    stop() {
        LOGGER.info('🛑 Stopping experiment bot...');
        state.session.isActive = false;

        if (state.pendingTradeTimeout) {
            clearTimeout(state.pendingTradeTimeout);
        }

        ExperimentStats.printAnalysis();
        ExperimentStats.saveResults();
        StatePersistence.saveState();

        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
            LOGGER.info('👋 Bot stopped');
        }, 2000);
    }

    getStatus() {
        const d = ExperimentStats.data;
        return {
            connected: state.isConnected,
            authorized: state.isAuthorized,
            capital: state.capital,
            experimentProgress: `${d.totalTrades}/${CONFIG.TARGET_TRADE_COUNT}`,
            winRate: d.totalTrades > 0 ? (d.wins / d.totalTrades * 100).toFixed(2) + '%' : 'N/A',
            netPL: d.totalProfit,
            roi: d.totalStaked > 0 ? ((d.totalReturned - d.totalStaked) / d.totalStaked * 100).toFixed(4) + '%' : 'N/A',
            activePositions: state.portfolio.activePositions.length
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
    LOGGER.info('🔄 Resuming experiment from saved state');
} else {
    LOGGER.info('🆕 Starting fresh experiment');
}

if (CONFIG.API_TOKEN === 'YOUR_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' 🔬 STEP INDEX ARBITRAGE VERIFICATION EXPERIMENT');
    console.log('═'.repeat(80));
    console.log('\n⚠️ API Token not configured!\n');
    console.log('Set your API token in CONFIG.API_TOKEN or via environment variable:');
    console.log('  API_TOKEN=your_token_here node stepindex-experiment.js');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' 🔬 STEP INDEX ARBITRAGE VERIFICATION EXPERIMENT');
console.log(` Target: ${CONFIG.TARGET_TRADE_COUNT} trades | Stake: $${CONFIG.STAKE} flat`);
console.log(` Durations: ${CONFIG.ODD_TICK_DURATIONS.join(',')} ticks`);
console.log('═'.repeat(80));
console.log('\n🚀 Initializing...\n');

bot.connection.connect();

// Status display every 60 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const status = bot.getStatus();
        console.log(`\n📊 ${getGMTTime()} | Progress: ${status.experimentProgress} | WR: ${status.winRate} | ROI: ${status.roi} | P&L: $${status.netPL.toFixed(4)} | Capital: $${status.capital.toFixed(2)}`);
    }
}, 60000);