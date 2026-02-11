const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================
// STEP INDEX ARBITRAGE VERIFICATION BOT
// ============================================
// PURPOSE: Verify or disprove the claim that Step Index
// on odd tick durations provides ≥99% payouts (positive EV).
//
// This bot will:
// 1. Check actual proposal payouts before every trade
// 2. Log the REAL payout percentage for every trade
// 3. Trade only when connected and authorized
// 4. Record comprehensive data for statistical analysis
// 5. Test all odd tick durations and track by hour
//
// EXPECTED OUTCOME (my prediction):
//   Payouts will be 94-97%, NOT ≥99%
//   Net result will be negative over 10,000 trades
//
// YOUR JOB: Run this and let the data prove it either way.
// ============================================

const STATE_FILE = path.join(__dirname, 'stprng-verify-state02.json');
const TRADE_LOG_FILE = path.join(__dirname, 'stprng-verify-trades02.csv');
const PAYOUT_LOG_FILE = path.join(__dirname, 'stprng-verify-payouts02.csv');
const RESULTS_FILE = path.join(__dirname, 'stprng-verify-results02.json');
const STATE_SAVE_INTERVAL = 5000;

// ============================================
// LOGGER
// ============================================
const getGMTTime = () => new Date().toISOString().split('T')[1].split('.')[0] + ' GMT';

const LOGGER = {
    info: (msg) => console.log(`[INFO] ${getGMTTime()} - ${msg}`),
    trade: (msg) => console.log(`\x1b[32m[TRADE] ${getGMTTime()} - ${msg}\x1b[0m`),
    warn: (msg) => console.warn(`\x1b[33m[WARN] ${getGMTTime()} - ${msg}\x1b[0m`),
    error: (msg) => console.error(`\x1b[31m[ERROR] ${getGMTTime()} - ${msg}\x1b[0m`),
    debug: (msg) => { if (CONFIG.DEBUG_MODE) console.log(`\x1b[90m[DEBUG] ${getGMTTime()} - ${msg}\x1b[0m`); },
    experiment: (msg) => console.log(`\x1b[36m[VERIFY] ${getGMTTime()} - ${msg}\x1b[0m`),
    payout: (msg) => console.log(`\x1b[35m[PAYOUT] ${getGMTTime()} - ${msg}\x1b[0m`)
};

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // API Settings - UPDATE WITH YOUR DEMO TOKEN
    API_TOKEN: 'Dz2V2KvRf4Uukt3',
    APP_ID: '1089',
    WS_URL: 'wss://ws.derivws.com/websockets/v3',

    // Capital Settings
    INITIAL_CAPITAL: 500,
    STAKE: 1, // Small stake to maximize trade count on demo

    // Session limits
    SESSION_PROFIT_TARGET: 99999,
    SESSION_STOP_LOSS: -200,

    // Duration settings — odd ticks only as per the claim
    DURATION_UNIT: 't',
    ODD_TICK_DURATIONS: [2],//[5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25],

    // The REAL Step Index symbol on Deriv
    // NOTE: 'STP10', 'STP2', 'STP' are FAKE symbols from the scam document
    // The actual symbol is 'stpRNG'
    VERIFIED_SYMBOLS: {
        'stpRNG': 'Step Index (Classic)',
        // 'stpRNG2': 'Step Index (2)',  // Uncomment if you have access to this symbol
        // 'stpRNG3': 'Step Index (3)',
        // 'stpRNG4': 'Step Index (4)',
        // 'stpRNG5': 'Step Index (5)',
        // Add more ONLY after verifying they exist on your account:
        // To verify: send { active_symbols: "brief" } after authorization
        // and search for any Step Index variants in the response
    },

    // Payout monitoring
    MIN_PAYOUT_TO_TRADE: 90.0,   // Trade at any payout to collect data
    LOG_ALL_PAYOUTS: true,        // Log every payout check for analysis
    PAYOUT_CHECK_INTERVAL: 30000, // Check payouts every 30 seconds
    PROPOSAL_TIMEOUT: 10000,      // 10 second timeout for proposal responses

    // Trade settings
    MAX_OPEN_POSITIONS: 1,
    TRADE_DELAY: 2000,
    DIRECTION_STRATEGY: 'ALTERNATE', // ALTERNATE, RANDOM, ALWAYS_RISE, ALWAYS_FALL
    TARGET_TRADE_COUNT: 10000,

    // Debug
    DEBUG_MODE: true,

    // Telegram (optional)
    TELEGRAM_ENABLED: false,
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
};

// ============================================
// TELEGRAM SERVICE (simplified)
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
        const avgPayout = d.allPayoutsObserved.length > 0
            ? (d.allPayoutsObserved.reduce((a, b) => a + b, 0) / d.allPayoutsObserved.length).toFixed(2)
            : 'N/A';
        const message = `
🔬 <b>VERIFICATION MILESTONE: ${tradeCount} trades</b>
Win Rate: ${wr}%
Avg Observed Payout: ${avgPayout}%
Net P&L: $${d.totalProfit.toFixed(4)}
Capital: $${state.capital.toFixed(2)}
        `.trim();
        await this.sendMessage(message);
    }
}

// ============================================
// PAYOUT DATA LOGGER
// ============================================
class PayoutLogger {
    static initialized = false;

    static initialize() {
        if (this.initialized) return;
        if (!fs.existsSync(PAYOUT_LOG_FILE)) {
            const header = [
                'timestamp', 'symbol', 'duration_ticks', 'contract_type',
                'stake', 'ask_price', 'payout', 'payout_percentage',
                'utc_hour', 'is_claimed_good_hour'
            ].join(',');
            fs.writeFileSync(PAYOUT_LOG_FILE, header + '\n');
            LOGGER.experiment('📝 Payout log created: ' + PAYOUT_LOG_FILE);
        }
        this.initialized = true;
    }

    static log(data) {
        this.initialize();
        const hour = new Date().getUTCHours();
        const isGoodHour = (hour >= 22 || hour <= 6) ? 'YES' : 'NO';
        const row = [
            new Date().toISOString(),
            data.symbol,
            data.duration,
            data.contractType,
            data.stake.toFixed(4),
            data.askPrice.toFixed(4),
            data.payout.toFixed(4),
            data.payoutPercentage.toFixed(4),
            hour,
            isGoodHour
        ].join(',');
        fs.appendFileSync(PAYOUT_LOG_FILE, row + '\n');
    }
}

// ============================================
// TRADE DATA LOGGER
// ============================================
class TradeDataLogger {
    static initialized = false;

    static initialize() {
        if (this.initialized) return;
        if (!fs.existsSync(TRADE_LOG_FILE)) {
            const header = [
                'trade_number', 'timestamp', 'symbol', 'direction',
                'duration_ticks', 'stake', 'buy_price', 'sell_price',
                'profit', 'result', 'payout_ratio',
                'pre_trade_payout_pct', 'cumulative_pnl',
                'win_rate_so_far', 'utc_hour', 'is_claimed_good_hour'
            ].join(',');
            fs.writeFileSync(TRADE_LOG_FILE, header + '\n');
            LOGGER.experiment('📝 Trade log created: ' + TRADE_LOG_FILE);
        }
        this.initialized = true;
    }

    static logTrade(data) {
        this.initialize();
        const hour = new Date().getUTCHours();
        const isGoodHour = (hour >= 22 || hour <= 6) ? 'YES' : 'NO';
        const row = [
            data.tradeNumber,
            new Date().toISOString(),
            data.symbol,
            data.direction,
            data.durationTicks,
            data.stake.toFixed(4),
            data.buyPrice.toFixed(4),
            data.sellPrice.toFixed(4),
            data.profit.toFixed(4),
            data.result,
            data.payoutRatio.toFixed(6),
            data.preTradePayoutPct.toFixed(4),
            data.cumulativePnl.toFixed(4),
            data.winRateSoFar.toFixed(4),
            hour,
            isGoodHour
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
        ties: 0,
        totalStaked: 0,
        totalReturned: 0,
        totalProfit: 0,
        payoutRatios: [],
        winPayoutRatios: [],

        // CRITICAL: Track all observed proposal payouts
        allPayoutsObserved: [],
        payoutsByDuration: {},
        payoutsByHour: {},
        payoutsBySymbol: {},

        // Per-duration trade results
        byDuration: {},
        byHour: {},
        bySymbol: {},

        // Streak tracking
        currentStreak: 0,
        currentStreakType: null,
        maxWinStreak: 0,
        maxLossStreak: 0,

        startTime: Date.now()
    };

    static recordPayoutObservation(symbol, duration, payoutPct) {
        const d = this.data;
        d.allPayoutsObserved.push(payoutPct);

        if (!d.payoutsByDuration[duration]) d.payoutsByDuration[duration] = [];
        d.payoutsByDuration[duration].push(payoutPct);

        const hour = new Date().getUTCHours();
        if (!d.payoutsByHour[hour]) d.payoutsByHour[hour] = [];
        d.payoutsByHour[hour].push(payoutPct);

        if (!d.payoutsBySymbol[symbol]) d.payoutsBySymbol[symbol] = [];
        d.payoutsBySymbol[symbol].push(payoutPct);
    }

    static recordTrade(tradeData) {
        const d = this.data;
        d.totalTrades++;
        d.totalStaked += tradeData.stake;

        const duration = tradeData.durationTicks;
        const symbol = tradeData.symbol;
        const hour = new Date().getUTCHours();

        // Initialize tracking buckets
        if (!d.byDuration[duration]) {
            d.byDuration[duration] = { wins: 0, losses: 0, ties: 0, totalStaked: 0, totalReturned: 0, trades: 0, payoutsReceived: [] };
        }
        if (!d.byHour[hour]) {
            d.byHour[hour] = { wins: 0, losses: 0, ties: 0, totalStaked: 0, totalReturned: 0, trades: 0 };
        }
        if (!d.bySymbol[symbol]) {
            d.bySymbol[symbol] = { wins: 0, losses: 0, ties: 0, totalStaked: 0, totalReturned: 0, trades: 0 };
        }

        const isWin = tradeData.profit > 0;
        const isTie = tradeData.profit === 0;

        if (isWin) {
            d.wins++;
            const payoutReturn = tradeData.stake + tradeData.profit;
            const payoutRatio = payoutReturn / tradeData.stake;
            d.winPayoutRatios.push(payoutRatio);
            d.payoutRatios.push(payoutRatio);
            d.totalReturned += payoutReturn;

            d.byDuration[duration].wins++;
            d.byDuration[duration].totalReturned += payoutReturn;
            d.byDuration[duration].payoutsReceived.push(payoutRatio);
            d.byHour[hour].wins++;
            d.byHour[hour].totalReturned += payoutReturn;
            d.bySymbol[symbol].wins++;
            d.bySymbol[symbol].totalReturned += payoutReturn;

            if (d.currentStreakType === 'W') { d.currentStreak++; }
            else { d.currentStreak = 1; d.currentStreakType = 'W'; }
            d.maxWinStreak = Math.max(d.maxWinStreak, d.currentStreak);

        } else if (isTie) {
            d.ties++;
            d.totalReturned += tradeData.stake;
            d.payoutRatios.push(1.0);
            d.byDuration[duration].ties++;
            d.byDuration[duration].totalReturned += tradeData.stake;
            d.byHour[hour].ties++;
            d.byHour[hour].totalReturned += tradeData.stake;
            d.bySymbol[symbol].ties++;
            d.bySymbol[symbol].totalReturned += tradeData.stake;

        } else {
            d.losses++;
            d.totalReturned += 0;
            d.payoutRatios.push(0);

            d.byDuration[duration].losses++;
            d.byHour[hour].losses++;
            d.bySymbol[symbol].losses++;

            if (d.currentStreakType === 'L') { d.currentStreak++; }
            else { d.currentStreak = 1; d.currentStreakType = 'L'; }
            d.maxLossStreak = Math.max(d.maxLossStreak, d.currentStreak);
        }

        d.totalProfit += tradeData.profit;
        d.byDuration[duration].totalStaked += tradeData.stake;
        d.byDuration[duration].trades++;
        d.byHour[hour].totalStaked += tradeData.stake;
        d.byHour[hour].trades++;
        d.bySymbol[symbol].totalStaked += tradeData.stake;
        d.bySymbol[symbol].trades++;

        // Log to CSV
        // TradeDataLogger.logTrade({
        //     tradeNumber: d.totalTrades,
        //     symbol: tradeData.symbol,
        //     direction: tradeData.direction,
        //     durationTicks: tradeData.durationTicks,
        //     stake: tradeData.stake,
        //     buyPrice: tradeData.buyPrice || tradeData.stake,
        //     sellPrice: tradeData.sellPrice || (tradeData.stake + tradeData.profit),
        //     profit: tradeData.profit,
        //     result: isWin ? 'WIN' : (isTie ? 'TIE' : 'LOSS'),
        //     payoutRatio: isWin ? ((tradeData.stake + tradeData.profit) / tradeData.stake) : (isTie ? 1.0 : 0),
        //     preTradePayoutPct: tradeData.preTradePayoutPct || 0,
        //     cumulativePnl: d.totalProfit,
        //     winRateSoFar: d.totalTrades > 0 ? d.wins / d.totalTrades : 0
        // });

        // Print analysis every 100 trades
        if (d.totalTrades % 100 === 0) {
            this.printAnalysis();
        }

        if (d.totalTrades % 500 === 0) {
            this.saveResults();
        }

        if (d.totalTrades % 1000 === 0) {
            TelegramService.sendMilestone(d.totalTrades);
        }
    }

    static printAnalysis() {
        const d = this.data;
        const winRate = d.totalTrades > 0 ? (d.wins / d.totalTrades * 100).toFixed(2) : 0;
        const tieRate = d.totalTrades > 0 ? (d.ties / d.totalTrades * 100).toFixed(2) : 0;
        const avgWinPayout = d.winPayoutRatios.length > 0
            ? (d.winPayoutRatios.reduce((a, b) => a + b, 0) / d.winPayoutRatios.length * 100).toFixed(2)
            : 0;
        const avgObservedPayout = d.allPayoutsObserved.length > 0
            ? (d.allPayoutsObserved.reduce((a, b) => a + b, 0) / d.allPayoutsObserved.length).toFixed(2)
            : 'N/A';
        const roi = d.totalStaked > 0 ? ((d.totalReturned - d.totalStaked) / d.totalStaked * 100).toFixed(4) : 0;
        const elapsed = ((Date.now() - d.startTime) / 60000).toFixed(1);

        console.log('\n' + '═'.repeat(80));
        LOGGER.experiment(`📊 VERIFICATION REPORT — ${d.totalTrades} / ${CONFIG.TARGET_TRADE_COUNT} trades`);
        console.log('─'.repeat(80));
        LOGGER.experiment(`⏱️  Elapsed: ${elapsed} min | Rate: ${(d.totalTrades / (parseFloat(elapsed) || 1) * 60).toFixed(0)} trades/hr`);
        console.log('─'.repeat(80));

        // THE KEY METRICS — these directly test the claims
        console.log('');
        LOGGER.experiment(`🔑 KEY CLAIM VERIFICATION:`);
        LOGGER.experiment(`   CLAIM: "Payouts ≥99%"     → ACTUAL avg proposal payout: ${avgObservedPayout}%`);
        LOGGER.experiment(`   CLAIM: "Win rate ~50%"     → ACTUAL win rate: ${winRate}%`);
        LOGGER.experiment(`   CLAIM: "No ties odd ticks" → ACTUAL tie rate: ${tieRate}% (${d.ties} ties)`);
        LOGGER.experiment(`   CLAIM: "Positive EV"       → ACTUAL ROI: ${roi}%`);
        LOGGER.experiment(`   CLAIM: "+1% to +1.8% EV"   → ACTUAL net P&L: $${d.totalProfit.toFixed(4)}`);
        console.log('');

        LOGGER.experiment(`📈 Win/Loss/Tie: ${d.wins}W / ${d.losses}L / ${d.ties}T`);
        LOGGER.experiment(`💰 Avg Win Payout: ${avgWinPayout}% of stake`);
        LOGGER.experiment(`💵 Total Staked: $${d.totalStaked.toFixed(2)} | Returned: $${d.totalReturned.toFixed(2)}`);
        LOGGER.experiment(`🔥 Streaks — Max Win: ${d.maxWinStreak} | Max Loss: ${d.maxLossStreak}`);

        // Per-duration breakdown
        console.log('─'.repeat(80));
        LOGGER.experiment('📊 PER-DURATION RESULTS:');
        Object.keys(d.byDuration).sort((a, b) => Number(a) - Number(b)).forEach(dur => {
            const stats = d.byDuration[dur];
            const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : 0;
            const durRoi = stats.totalStaked > 0
                ? ((stats.totalReturned - stats.totalStaked) / stats.totalStaked * 100).toFixed(3)
                : 0;
            const avgPayoutForDur = d.payoutsByDuration[dur] && d.payoutsByDuration[dur].length > 0
                ? (d.payoutsByDuration[dur].reduce((a, b) => a + b, 0) / d.payoutsByDuration[dur].length).toFixed(2)
                : 'N/A';
            const avgActualWinPayout = stats.payoutsReceived && stats.payoutsReceived.length > 0
                ? (stats.payoutsReceived.reduce((a, b) => a + b, 0) / stats.payoutsReceived.length * 100).toFixed(2)
                : 'N/A';
            LOGGER.experiment(`  ${String(dur).padStart(2)}t: ${String(stats.trades).padStart(4)} trades | ${wr}% WR | ${durRoi}% ROI | ${stats.ties} ties | Proposal payout: ${avgPayoutForDur}% | Win payout: ${avgActualWinPayout}%`);
        });

        // Per-hour breakdown — tests "22:00-06:00 GMT" claim
        if (Object.keys(d.byHour).length > 3) {
            console.log('─'.repeat(80));
            LOGGER.experiment('📊 PER-HOUR RESULTS (UTC) — Testing "22:00-06:00 better payouts" claim:');
            for (let h = 0; h < 24; h++) {
                if (d.byHour[h] && d.byHour[h].trades > 0) {
                    const stats = d.byHour[h];
                    const wr = (stats.wins / stats.trades * 100).toFixed(1);
                    const hourRoi = stats.totalStaked > 0
                        ? ((stats.totalReturned - stats.totalStaked) / stats.totalStaked * 100).toFixed(3)
                        : 0;
                    const avgPayoutForHour = d.payoutsByHour[h] && d.payoutsByHour[h].length > 0
                        ? (d.payoutsByHour[h].reduce((a, b) => a + b, 0) / d.payoutsByHour[h].length).toFixed(2)
                        : 'N/A';
                    const marker = (h >= 22 || h <= 6) ? ' ⭐ CLAIMED GOOD HOUR' : '';
                    LOGGER.experiment(`  ${String(h).padStart(2)}:00 UTC: ${String(stats.trades).padStart(4)} trades | ${wr}% WR | ${hourRoi}% ROI | Avg payout: ${avgPayoutForHour}%${marker}`);
                }
            }
        }

        console.log('═'.repeat(80) + '\n');

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
        const avgObservedPayout = d.allPayoutsObserved.length > 0
            ? d.allPayoutsObserved.reduce((a, b) => a + b, 0) / d.allPayoutsObserved.length
            : 0;
        const roi = d.totalStaked > 0
            ? (d.totalReturned - d.totalStaked) / d.totalStaked
            : 0;

        // Statistical significance
        const expectedWinRate = 0.5;
        const standardError = Math.sqrt(expectedWinRate * (1 - expectedWinRate) / d.totalTrades);
        const zScore = (winRate - expectedWinRate) / standardError;
        const isSignificant = Math.abs(zScore) > 1.96;

        console.log('\n' + '🏁'.repeat(40));
        console.log('═'.repeat(80));
        LOGGER.experiment('🏁🏁🏁 EXPERIMENT COMPLETE — FINAL VERDICT 🏁🏁🏁');
        console.log('═'.repeat(80));

        console.log('\n📋 RAW DATA:');
        LOGGER.experiment(`Total Trades: ${d.totalTrades}`);
        LOGGER.experiment(`Wins: ${d.wins} | Losses: ${d.losses} | Ties: ${d.ties}`);
        LOGGER.experiment(`Win Rate: ${(winRate * 100).toFixed(3)}%`);
        LOGGER.experiment(`Average Win Payout: ${(avgWinPayout * 100).toFixed(3)}% of stake`);
        LOGGER.experiment(`Average Proposal Payout: ${avgObservedPayout.toFixed(3)}%`);
        LOGGER.experiment(`ROI: ${(roi * 100).toFixed(4)}%`);
        LOGGER.experiment(`Net P&L: $${d.totalProfit.toFixed(4)}`);
        LOGGER.experiment(`Total Staked: $${d.totalStaked.toFixed(2)}`);
        LOGGER.experiment(`Total Returned: $${d.totalReturned.toFixed(2)}`);

        console.log('\n📊 STATISTICAL TEST:');
        LOGGER.experiment(`Z-Score (win rate vs 50%): ${zScore.toFixed(4)}`);
        LOGGER.experiment(`Statistically Significant: ${isSignificant ? 'YES' : 'NO'} (95% CI)`);
        LOGGER.experiment(`Standard Error: ${(standardError * 100).toFixed(4)}%`);

        console.log('\n' + '═'.repeat(80));
        console.log('🔑 CLAIM-BY-CLAIM VERIFICATION:');
        console.log('═'.repeat(80));

        // Claim 1: Payout ≥ 99%
        const payoutClaim = avgObservedPayout >= 99.0;
        LOGGER.experiment(`${payoutClaim ? '✅' : '❌'} CLAIM: "Payouts ≥99%"`);
        LOGGER.experiment(`   Expected: ≥99.0% | Actual: ${avgObservedPayout.toFixed(2)}%`);
        LOGGER.experiment(`   Verdict: ${payoutClaim ? 'CONFIRMED' : 'DISPROVED'}`);

        // Claim 2: No ties on odd ticks
        const tieClaim = d.ties === 0;
        LOGGER.experiment(`${tieClaim ? '✅' : '❌'} CLAIM: "No ties on odd ticks"`);
        LOGGER.experiment(`   Expected: 0 ties | Actual: ${d.ties} ties (${(d.ties / d.totalTrades * 100).toFixed(2)}%)`);
        LOGGER.experiment(`   Verdict: ${tieClaim ? 'CONFIRMED' : 'DISPROVED'}`);

        // Claim 3: Positive EV
        const evClaim = roi > 0;
        LOGGER.experiment(`${evClaim ? '✅' : '❌'} CLAIM: "Positive expected value"`);
        LOGGER.experiment(`   Expected: ROI > 0% | Actual: ${(roi * 100).toFixed(4)}%`);
        LOGGER.experiment(`   Verdict: ${evClaim ? 'CONFIRMED' : 'DISPROVED'}`);

        // Claim 4: +1% to +1.8% EV
        const highEvClaim = roi >= 0.01;
        LOGGER.experiment(`${highEvClaim ? '✅' : '❌'} CLAIM: "+1% to +1.8% EV"`);
        LOGGER.experiment(`   Expected: ROI ≥+1.0% | Actual: ${(roi * 100).toFixed(4)}%`);
        LOGGER.experiment(`   Verdict: ${highEvClaim ? 'CONFIRMED' : 'DISPROVED'}`);

        // Claim 5: 22:00-06:00 GMT better payouts
        const goodHourPayouts = [];
        const badHourPayouts = [];
        for (let h = 0; h < 24; h++) {
            if (d.payoutsByHour[h] && d.payoutsByHour[h].length > 0) {
                const avg = d.payoutsByHour[h].reduce((a, b) => a + b, 0) / d.payoutsByHour[h].length;
                if (h >= 22 || h <= 6) {
                    goodHourPayouts.push(avg);
                } else {
                    badHourPayouts.push(avg);
                }
            }
        }
        const avgGoodHour = goodHourPayouts.length > 0
            ? (goodHourPayouts.reduce((a, b) => a + b, 0) / goodHourPayouts.length).toFixed(2)
            : 'N/A';
        const avgBadHour = badHourPayouts.length > 0
            ? (badHourPayouts.reduce((a, b) => a + b, 0) / badHourPayouts.length).toFixed(2)
            : 'N/A';
        const hourClaim = avgGoodHour !== 'N/A' && avgBadHour !== 'N/A' && parseFloat(avgGoodHour) > parseFloat(avgBadHour);
        LOGGER.experiment(`${hourClaim ? '✅' : '❌'} CLAIM: "Better payouts 22:00-06:00 GMT"`);
        LOGGER.experiment(`   22:00-06:00 avg: ${avgGoodHour}% | Other hours avg: ${avgBadHour}%`);
        LOGGER.experiment(`   Verdict: ${hourClaim ? 'CONFIRMED' : 'DISPROVED'}`);

        console.log('\n' + '═'.repeat(80));
        const claimsPassed = [payoutClaim, tieClaim, evClaim, highEvClaim, hourClaim].filter(Boolean).length;
        LOGGER.experiment(`📊 OVERALL: ${claimsPassed}/5 claims confirmed`);

        if (claimsPassed >= 4) {
            LOGGER.experiment(`🟢 OVERALL VERDICT: The arbitrage claim appears to have merit.`);
        } else if (claimsPassed >= 2) {
            LOGGER.experiment(`🟡 OVERALL VERDICT: Mixed results. Some claims partially supported.`);
        } else {
            LOGGER.experiment(`🔴 OVERALL VERDICT: The arbitrage claim is NOT supported by data.`);
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
                    ? d.winPayoutRatios.reduce((a, b) => a + b, 0) / d.winPayoutRatios.length : 0,
                avgObservedPayoutPct: d.allPayoutsObserved.length > 0
                    ? d.allPayoutsObserved.reduce((a, b) => a + b, 0) / d.allPayoutsObserved.length : 0,
                totalPayoutObservations: d.allPayoutsObserved.length,
                maxWinStreak: d.maxWinStreak,
                maxLossStreak: d.maxLossStreak,
                byDuration: {},
                byHour: {},
                elapsedMinutes: (Date.now() - d.startTime) / 60000
            };

            // Summarize duration data
            Object.keys(d.byDuration).forEach(dur => {
                const stats = d.byDuration[dur];
                results.byDuration[dur] = {
                    trades: stats.trades,
                    wins: stats.wins,
                    losses: stats.losses,
                    ties: stats.ties,
                    roi: stats.totalStaked > 0
                        ? (stats.totalReturned - stats.totalStaked) / stats.totalStaked : 0,
                    avgProposalPayout: d.payoutsByDuration[dur] && d.payoutsByDuration[dur].length > 0
                        ? d.payoutsByDuration[dur].reduce((a, b) => a + b, 0) / d.payoutsByDuration[dur].length : 0
                };
            });

            // Summarize hour data
            for (let h = 0; h < 24; h++) {
                if (d.byHour[h] && d.byHour[h].trades > 0) {
                    const stats = d.byHour[h];
                    results.byHour[h] = {
                        trades: stats.trades,
                        wins: stats.wins,
                        losses: stats.losses,
                        ties: stats.ties,
                        roi: stats.totalStaked > 0
                            ? (stats.totalReturned - stats.totalStaked) / stats.totalStaked : 0,
                        avgProposalPayout: d.payoutsByHour[h] && d.payoutsByHour[h].length > 0
                            ? d.payoutsByHour[h].reduce((a, b) => a + b, 0) / d.payoutsByHour[h].length : 0,
                        isClaimedGoodHour: (h >= 22 || h <= 6)
                    };
                }
            }

            fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
            LOGGER.experiment(`💾 Results saved to ${RESULTS_FILE}`);
        } catch (error) {
            LOGGER.error(`Failed to save results: ${error.message}`);
        }
    }
}

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
        activePositions: []
    },
    lastTradeDirection: null,
    currentDurationIndex: 0,
    requestId: 1,
    tradeInProgress: false,
    pendingTradeTimeout: null,

    // Payout monitoring
    currentPayouts: {},         // { 'stpRNG_5': 96.5, 'stpRNG_7': 95.8, ... }
    bestCurrentPayout: 0,
    bestCurrentSymbol: null,
    bestCurrentDuration: 5,
    lastPayoutCheck: 0,
    pendingProposals: {},       // Track pending proposal requests
    symbolDiscoveryDone: false,
    discoveredSymbols: {},      // Symbols found via active_symbols API

    // Asset validation
    validatedSymbols: [],       // Symbols confirmed to exist
    symbolValidationDone: false
};

// ============================================
// STATE PERSISTENCE
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
                        symbol: pos.symbol, direction: pos.direction,
                        stake: pos.stake, duration: pos.duration,
                        durationUnit: pos.durationUnit, entryTime: pos.entryTime,
                        contractId: pos.contractId, reqId: pos.reqId,
                        buyPrice: pos.buyPrice, currentProfit: pos.currentProfit,
                        preTradePayoutPct: pos.preTradePayoutPct
                    }))
                },
                lastTradeDirection: state.lastTradeDirection,
                currentDurationIndex: state.currentDurationIndex,
                experimentStats: ExperimentStats.data,
                validatedSymbols: state.validatedSymbols
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
        } catch (error) {
            LOGGER.error(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                LOGGER.info('📂 No previous state, starting fresh');
                return false;
            }

            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;

            if (ageMinutes > 120) {
                LOGGER.warn(`State too old (${ageMinutes.toFixed(1)}min), starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }

            state.capital = savedData.capital;
            state.session = { ...state.session, ...savedData.session };
            state.lastTradeDirection = savedData.lastTradeDirection;
            state.currentDurationIndex = savedData.currentDurationIndex || 0;
            state.portfolio.activePositions = savedData.portfolio.activePositions || [];
            state.validatedSymbols = savedData.validatedSymbols || [];

            // if (savedData.experimentStats) {
            //     // Restore experiment stats but ensure arrays exist
            //     const restored = savedData.experimentStats;
            //     ExperimentStats.data = {
            //         ...ExperimentStats.data,
            //         ...restored,
            //         payoutRatios: restored.payoutRatios || [],
            //         winPayoutRatios: restored.winPayoutRatios || [],
            //         allPayoutsObserved: restored.allPayoutsObserved || [],
            //         payoutsByDuration: restored.payoutsByDuration || {},
            //         payoutsByHour: restored.payoutsByHour || {},
            //         payoutsBySymbol: restored.payoutsBySymbol || {},
            //         byDuration: restored.byDuration || {},
            //         byHour: restored.byHour || {},
            //         bySymbol: restored.bySymbol || {},
            //         startTime: restored.startTime || Date.now()
            //     };

            //     // Ensure payoutsReceived arrays exist in byDuration
            //     Object.keys(ExperimentStats.data.byDuration).forEach(dur => {
            //         if (!ExperimentStats.data.byDuration[dur].payoutsReceived) {
            //             ExperimentStats.data.byDuration[dur].payoutsReceived = [];
            //         }
            //     });
            // }

            LOGGER.info(`✅ State restored! ${ExperimentStats.data.totalTrades} trades, $${state.capital.toFixed(2)}`);
            return true;
        } catch (error) {
            LOGGER.error(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave() {
        setInterval(() => {
            if (state.isAuthorized) this.saveState();
        }, STATE_SAVE_INTERVAL);
    }
}

// ============================================
// SESSION MANAGER
// ============================================
class SessionManager {
    static isSessionActive() { return state.session.isActive; }

    static checkSessionTargets() {
        if (state.session.netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.error(`🛑 STOP LOSS: $${state.session.netPL.toFixed(2)}`);
            ExperimentStats.printAnalysis();
            ExperimentStats.saveResults();
            state.session.isActive = false;
            return true;
        }
        if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            LOGGER.experiment('🏁 TARGET REACHED');
            ExperimentStats.printFinalConclusion();
            state.session.isActive = false;
            return true;
        }
        return false;
    }

    static recordTradeResult(profit, direction, symbol, durationTicks, buyPrice, sellPrice, preTradePayoutPct) {
        state.session.tradesCount++;
        state.capital += profit;
        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
        } else if (profit < 0) {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
        }
        state.session.netPL += profit;

        ExperimentStats.recordTrade({
            symbol, direction, durationTicks,
            stake: CONFIG.STAKE,
            buyPrice: buyPrice || CONFIG.STAKE,
            sellPrice: sellPrice || (CONFIG.STAKE + profit),
            profit,
            preTradePayoutPct: preTradePayoutPct || 0
        });
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
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        LOGGER.info('🔌 Connecting to Deriv API...');
        this.cleanup();
        this.ws = new WebSocket(`${CONFIG.WS_URL}?app_id=${CONFIG.APP_ID}`);
        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (error) => this.onError(error));
        this.ws.on('close', () => this.onClose());
    }

    cleanup() {
        if (this.ws) {
            this.ws.removeAllListeners();
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
        }
    }

    onOpen() {
        LOGGER.info('✅ Connected');
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

    onMessage(data) {
        try {
            this.handleResponse(JSON.parse(data));
        } catch (error) {
            LOGGER.error(`Parse error: ${error.message}`);
        }
    }

    handleResponse(response) {
        // Authorization
        if (response.msg_type === 'authorize') {
            if (response.error) {
                LOGGER.error(`Auth failed: ${response.error.message}`);
                return;
            }
            LOGGER.info(`🔐 Authorized: ${response.authorize.loginid} | Balance: ${response.authorize.balance} ${response.authorize.currency}`);
            state.isAuthorized = true;
            state.accountBalance = response.authorize.balance;
            if (state.capital === CONFIG.INITIAL_CAPITAL && response.authorize.balance > 0) {
                state.capital = response.authorize.balance;
                state.session.startCapital = response.authorize.balance;
            }
            this.send({ balance: 1, subscribe: 1 });

            // STEP 1: Discover available symbols first
            LOGGER.experiment('🔍 Discovering available Step Index symbols...');
            this.send({ active_symbols: 'brief', product_type: 'basic' });
        }

        // Balance update
        if (response.msg_type === 'balance') {
            state.accountBalance = response.balance.balance;
        }

        // Symbol discovery — CRITICAL: find real symbol names
        if (response.msg_type === 'active_symbols') {
            this.handleActiveSymbols(response);
        }

        // Proposal (payout check)
        if (response.msg_type === 'proposal') {
            this.handleProposal(response);
        }

        // Buy response
        if (response.msg_type === 'buy') {
            this.handleBuyResponse(response);
        }

        // Contract update
        if (response.msg_type === 'proposal_open_contract') {
            this.handleOpenContract(response);
        }
    }

    handleActiveSymbols(response) {
        if (response.error) {
            LOGGER.error(`Symbol discovery error: ${response.error.message}`);
            // Fall back to known symbol
            state.validatedSymbols = ['stpRNG'];
            state.symbolValidationDone = true;
            bot.start();
            return;
        }

        const symbols = response.active_symbols || [];

        // Search for ALL Step Index variants
        LOGGER.experiment('🔍 Searching for Step Index symbols in active_symbols...');
        const stepSymbols = symbols.filter(s =>
            s.display_name.toLowerCase().includes('step') ||
            s.symbol.toLowerCase().includes('stp') ||
            s.symbol.toLowerCase().includes('step')
        );

        if (stepSymbols.length > 0) {
            console.log('─'.repeat(80));
            LOGGER.experiment(`Found ${stepSymbols.length} Step Index symbols:`);
            stepSymbols.forEach(s => {
                LOGGER.experiment(`  Symbol: ${s.symbol} | Name: ${s.display_name} | Market: ${s.market} | Submarket: ${s.submarket}`);
                state.discoveredSymbols[s.symbol] = s.display_name;
            });
            console.log('─'.repeat(80));

            state.validatedSymbols = stepSymbols.map(s => s.symbol);
        } else {
            LOGGER.warn('⚠️ No Step Index symbols found! Checking for stpRNG directly...');

            // Check if stpRNG exists
            const stpRNG = symbols.find(s => s.symbol === 'stpRNG');
            if (stpRNG) {
                LOGGER.experiment(`  Found: ${stpRNG.symbol} | ${stpRNG.display_name}`);
                state.validatedSymbols = ['stpRNG'];
            } else {
                LOGGER.error('❌ No Step Index symbols available on this account!');
                LOGGER.error('Available synthetic symbols:');
                symbols.filter(s => s.market === 'synthetic_index').forEach(s => {
                    LOGGER.error(`  ${s.symbol} | ${s.display_name}`);
                });
                state.validatedSymbols = ['stpRNG']; // Try anyway
            }
        }

        state.symbolValidationDone = true;
        bot.start();
    }

    handleProposal(response) {
        if (response.error) {
            LOGGER.debug(`Proposal error: ${response.error.message} (${response.error.code})`);
            // Clean up pending proposal
            if (response.echo_req?.req_id) {
                delete state.pendingProposals[response.echo_req.req_id];
            }
            return;
        }

        const proposal = response.proposal;
        const reqId = response.echo_req?.req_id;
        const pendingInfo = state.pendingProposals[reqId] || {};

        const symbol = response.echo_req?.symbol || pendingInfo.symbol || 'unknown';
        const duration = response.echo_req?.duration || pendingInfo.duration || 0;
        const askPrice = parseFloat(proposal.ask_price) || 0;
        const payout = parseFloat(proposal.payout) || 0;

        // Calculate payout percentage
        // Payout percentage = (payout / ask_price) * 100
        // Where payout is what you receive if you WIN
        // ask_price is what you pay
        const payoutPct = askPrice > 0 ? (payout / askPrice * 100) : 0;

        const key = `${symbol}_${duration}`;
        state.currentPayouts[key] = payoutPct;

        // Log the payout observation
        ExperimentStats.recordPayoutObservation(symbol, duration, payoutPct);

        if (CONFIG.LOG_ALL_PAYOUTS) {
            PayoutLogger.log({
                symbol, duration,
                contractType: response.echo_req?.contract_type || 'CALL',
                stake: CONFIG.STAKE,
                askPrice, payout,
                payoutPercentage: payoutPct
            });
        }

        LOGGER.payout(`${symbol} ${duration}t: Ask=$${askPrice.toFixed(4)} Payout=$${payout.toFixed(4)} → ${payoutPct.toFixed(2)}% ${payoutPct >= 99 ? '🟢 ABOVE 99%!' : payoutPct >= 97 ? '🟡' : '🔴'}`);

        // Track best current payout
        if (payoutPct > state.bestCurrentPayout) {
            state.bestCurrentPayout = payoutPct;
            state.bestCurrentSymbol = symbol;
            state.bestCurrentDuration = duration;
        }

        // Forget the proposal subscription
        if (proposal.id) {
            this.send({ forget: proposal.id });
        }

        // Clean up pending
        delete state.pendingProposals[reqId];

        // If all proposals are checked and we're not trading, trigger a trade
        if (Object.keys(state.pendingProposals).length === 0 && !state.tradeInProgress) {
            bot.onPayoutCheckComplete();
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
            state.tradeInProgress = false;
            bot.scheduleNextTrade();
            return;
        }

        const contract = response.buy;
        LOGGER.trade(`✅ Opened: Contract ${contract.contract_id} | Buy: $${contract.buy_price}`);

        const reqId = response.echo_req.req_id;
        const position = state.portfolio.activePositions.find(p => p.reqId === reqId);
        if (position) {
            position.contractId = contract.contract_id;
            position.buyPrice = contract.buy_price;
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
            state.tradeInProgress = false;
            bot.scheduleNextTrade();
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
            const sellPrice = contract.sell_price || 0;
            const result = profit > 0 ? 'WIN' : (profit === 0 ? 'TIE' : 'LOSS');
            const emoji = profit > 0 ? '✅' : (profit === 0 ? '🟡' : '❌');

            LOGGER.trade(`${emoji} #${ExperimentStats.data.totalTrades + 1} ${result}: $${profit.toFixed(4)} | ${position.symbol} ${position.duration}t ${position.direction} | Payout: ${position.preTradePayoutPct?.toFixed(2) || '?'}%`);

            SessionManager.recordTradeResult(
                profit, position.direction, position.symbol,
                position.duration, position.buyPrice, sellPrice,
                position.preTradePayoutPct
            );

            state.portfolio.activePositions.splice(posIndex, 1);

            if (response.subscription?.id) {
                this.send({ forget: response.subscription.id });
            }

            state.tradeInProgress = false;
            const shouldStop = SessionManager.checkSessionTargets();
            StatePersistence.saveState();

            if (!shouldStop) {
                bot.scheduleNextTrade();
            }
        }
    }

    onError(error) {
        LOGGER.error(`WebSocket error: ${error.message}`);
    }

    onClose() {
        LOGGER.warn('🔌 Disconnected');
        state.isConnected = false;
        state.isAuthorized = false;
        this.stopPing();
        StatePersistence.saveState();

        if (this.isReconnecting) return;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.isReconnecting = true;
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
            LOGGER.info(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
            setTimeout(() => { this.isReconnecting = false; this.connect(); }, delay);
        } else {
            LOGGER.error('Max reconnection attempts reached');
            ExperimentStats.printFinalConclusion();
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
        if (!state.isConnected) return null;
        data.req_id = state.requestId++;
        try {
            this.ws.send(JSON.stringify(data));
        } catch (e) {
            LOGGER.error(`Send error: ${e.message}`);
            return null;
        }
        return data.req_id;
    }
}

// ============================================
// MAIN BOT
// ============================================
class DerivBot {
    constructor() {
        this.connection = new ConnectionManager();
        this.started = false;
        this.payoutScanInterval = null;
    }

    async start() {
        if (this.started) return;
        this.started = true;

        console.log('\n' + '═'.repeat(80));
        console.log(' 🔬 STEP INDEX ARBITRAGE CLAIM VERIFICATION BOT');
        console.log('═'.repeat(80));
        console.log(`💰 Capital: $${state.capital.toFixed(2)}`);
        console.log(`💵 Flat Stake: $${CONFIG.STAKE} (no martingale — clean experiment)`);
        console.log(`⏱️ Tick Durations: ${CONFIG.ODD_TICK_DURATIONS.join(', ')} (odd only)`);
        console.log(`🎯 Target: ${CONFIG.TARGET_TRADE_COUNT} trades`);
        console.log(`📝 Trade log: ${TRADE_LOG_FILE}`);
        console.log(`📊 Payout log: ${PAYOUT_LOG_FILE}`);
        console.log(`📋 Results: ${RESULTS_FILE}`);
        console.log('═'.repeat(80));
        console.log('');
        console.log('VALIDATED SYMBOLS:');
        state.validatedSymbols.forEach(sym => {
            const name = state.discoveredSymbols[sym] || CONFIG.VERIFIED_SYMBOLS[sym] || sym;
            console.log(`  ✅ ${sym} (${name})`);
        });
        console.log('');
        console.log('CLAIMS BEING TESTED:');
        console.log('  1. Payouts ≥99% on odd ticks');
        console.log('  2. No ties on odd ticks');
        console.log('  3. Positive expected value');
        console.log('  4. +1% to +1.8% EV');
        console.log('  5. Better payouts during 22:00-06:00 GMT');
        console.log('═'.repeat(80) + '\n');

        const remaining = CONFIG.TARGET_TRADE_COUNT - ExperimentStats.data.totalTrades;
        LOGGER.experiment(`Progress: ${ExperimentStats.data.totalTrades}/${CONFIG.TARGET_TRADE_COUNT} (${remaining} remaining)`);

        // if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
        //     ExperimentStats.printFinalConclusion();
        //     return;
        // }

        TradeDataLogger.initialize();
        PayoutLogger.initialize();

        // Start with payout scan, then trade
        this.checkPayoutsAndTrade();

        // Continuous payout scanning
        this.payoutScanInterval = setInterval(() => {
            if (state.isAuthorized && state.session.isActive && !state.tradeInProgress) {
                this.checkPayoutsAndTrade();
            }
        }, CONFIG.PAYOUT_CHECK_INTERVAL);

        LOGGER.info('✅ Verification bot started');
    }

    checkPayoutsAndTrade() {
        if (!state.isAuthorized || !state.isConnected) return;
        if (state.tradeInProgress) return;
        if (!SessionManager.isSessionActive()) return;

        // Reset best payout for this scan
        state.bestCurrentPayout = 0;
        state.bestCurrentSymbol = null;
        state.bestCurrentDuration = CONFIG.ODD_TICK_DURATIONS[0];
        state.pendingProposals = {};

        LOGGER.payout('🔍 Scanning payouts across all symbols and durations...');

        const symbols = state.validatedSymbols.length > 0
            ? state.validatedSymbols
            : ['stpRNG'];

        for (const symbol of symbols) {
            for (const duration of CONFIG.ODD_TICK_DURATIONS) {
                const reqId = this.connection.send({
                    proposal: 1,
                    amount: CONFIG.STAKE,
                    basis: 'stake',
                    contract_type: 'CALL',
                    currency: 'USD',
                    duration: duration,
                    duration_unit: 't',
                    symbol: symbol
                });

                if (reqId) {
                    state.pendingProposals[reqId] = { symbol, duration };
                }
            }
        }

        // Timeout: if proposals don't all respond, proceed anyway
        setTimeout(() => {
            if (Object.keys(state.pendingProposals).length > 0) {
                LOGGER.warn(`⚠️ ${Object.keys(state.pendingProposals).length} proposals timed out`);
                state.pendingProposals = {};
                this.onPayoutCheckComplete();
            }
        }, CONFIG.PROPOSAL_TIMEOUT);
    }

    onPayoutCheckComplete() {
        if (state.tradeInProgress) return;
        if (!SessionManager.isSessionActive()) return;

        LOGGER.payout(`📊 Payout scan complete. Best: ${state.bestCurrentPayout.toFixed(2)}% on ${state.bestCurrentSymbol || 'none'} ${state.bestCurrentDuration}t`);

        if (state.bestCurrentPayout >= CONFIG.MIN_PAYOUT_TO_TRADE && state.bestCurrentSymbol) {
            // Execute trade with best payout
            this.executeNextTrade(state.bestCurrentSymbol, state.bestCurrentDuration, state.bestCurrentPayout);
        } else {
            LOGGER.warn(`No payout above ${CONFIG.MIN_PAYOUT_TO_TRADE}%. Waiting...`);
            this.scheduleNextTrade();
        }
    }

    getNextDirection() {
        switch (CONFIG.DIRECTION_STRATEGY) {
            case 'RANDOM':
                return Math.random() < 0.5 ? 'CALL' : 'PUT';
            case 'ALTERNATE':
                if (state.lastTradeDirection === 'CALL') return 'PUT';
                if (state.lastTradeDirection === 'PUT') return 'CALL';
                return 'CALL';
            case 'ALWAYS_RISE':
                return 'CALL';
            case 'ALWAYS_FALL':
                return 'PUT';
            default:
                return Math.random() < 0.5 ? 'CALL' : 'PUT';
        }
    }

    scheduleNextTrade() {
        if (!SessionManager.isSessionActive()) return;
        if (state.tradeInProgress) return;
        if (ExperimentStats.data.totalTrades >= CONFIG.TARGET_TRADE_COUNT) {
            ExperimentStats.printFinalConclusion();
            return;
        }

        if (state.pendingTradeTimeout) clearTimeout(state.pendingTradeTimeout);

        state.pendingTradeTimeout = setTimeout(() => {
            this.checkPayoutsAndTrade();
        }, CONFIG.TRADE_DELAY);
    }

    executeNextTrade(symbol, duration, preTradePayoutPct) {
        if (!state.isAuthorized || !state.isConnected) {
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

        if (state.capital < CONFIG.STAKE) {
            LOGGER.error(`❌ Insufficient capital: $${state.capital.toFixed(2)}`);
            ExperimentStats.printFinalConclusion();
            state.session.isActive = false;
            return;
        }

        const direction = this.getNextDirection();
        state.lastTradeDirection = direction;
        state.tradeInProgress = true;

        const tradeNum = ExperimentStats.data.totalTrades + 1;
        LOGGER.trade(`🔬 #${tradeNum}/${CONFIG.TARGET_TRADE_COUNT} | ${symbol} | ${direction === 'CALL' ? 'RISE' : 'FALL'} | ${duration}t | $${CONFIG.STAKE} | Payout: ${preTradePayoutPct.toFixed(2)}%`);

        const position = {
            symbol, direction,
            stake: CONFIG.STAKE,
            duration, durationUnit: 't',
            entryTime: Date.now(),
            contractId: null, reqId: null,
            currentProfit: 0, buyPrice: 0,
            preTradePayoutPct: preTradePayoutPct
        };

        state.portfolio.activePositions.push(position);

        const tradeRequest = {
            buy: 1,
            subscribe: 1,
            price: CONFIG.STAKE.toFixed(2),
            parameters: {
                contract_type: direction,
                symbol: symbol,
                currency: 'USD',
                amount: CONFIG.STAKE.toFixed(2),
                duration: duration,
                duration_unit: 't',
                basis: 'stake'
            }
        };

        const reqId = this.connection.send(tradeRequest);
        position.reqId = reqId;
    }

    stop() {
        LOGGER.info('🛑 Stopping...');
        state.session.isActive = false;
        if (state.pendingTradeTimeout) clearTimeout(state.pendingTradeTimeout);
        if (this.payoutScanInterval) clearInterval(this.payoutScanInterval);
        ExperimentStats.printAnalysis();
        ExperimentStats.saveResults();
        StatePersistence.saveState();
        setTimeout(() => {
            if (this.connection.ws) this.connection.ws.close();
        }, 2000);
    }
}

// ============================================
// INITIALIZATION
// ============================================
const bot = new DerivBot();

process.on('SIGINT', () => {
    console.log('\n⚠️ Shutdown...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
});

const stateLoaded = StatePersistence.loadState();
LOGGER.info(stateLoaded ? '🔄 Resuming from saved state' : '🆕 Fresh experiment');

if (CONFIG.API_TOKEN === 'YOUR_DEMO_API_TOKEN_HERE') {
    console.log('═'.repeat(80));
    console.log(' 🔬 STEP INDEX VERIFICATION BOT');
    console.log('═'.repeat(80));
    console.log('\n⚠️ Set your DEMO API token!\n');
    console.log('Edit CONFIG.API_TOKEN or run:');
    console.log('  API_TOKEN=your_demo_token node stprng-verify.js\n');
    console.log('⚠️ USE A DEMO ACCOUNT — this is an experiment, not a money printer.');
    console.log('═'.repeat(80));
    process.exit(1);
}

console.log('═'.repeat(80));
console.log(' 🔬 STEP INDEX ARBITRAGE VERIFICATION');
console.log(` Target: ${CONFIG.TARGET_TRADE_COUNT} trades | Stake: $${CONFIG.STAKE} flat`);
console.log('═'.repeat(80));
console.log('🚀 Initializing...\n');

bot.connection.connect();

// Status every 60 seconds
setInterval(() => {
    if (state.isAuthorized) {
        const d = ExperimentStats.data;
        const wr = d.totalTrades > 0 ? (d.wins / d.totalTrades * 100).toFixed(1) : 0;
        const avgPayout = d.allPayoutsObserved.length > 0
            ? (d.allPayoutsObserved.reduce((a, b) => a + b, 0) / d.allPayoutsObserved.length).toFixed(1)
            : '?';
        const roi = d.totalStaked > 0
            ? ((d.totalReturned - d.totalStaked) / d.totalStaked * 100).toFixed(3)
            : '0';
        console.log(`\n📊 ${getGMTTime()} | ${d.totalTrades}/${CONFIG.TARGET_TRADE_COUNT} | WR: ${wr}% | Avg Payout: ${avgPayout}% | ROI: ${roi}% | P&L: $${d.totalProfit.toFixed(4)} | Capital: $${state.capital.toFixed(2)}`);
    }
}, 60000);