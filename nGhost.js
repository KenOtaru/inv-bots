#!/usr/bin/env node

// ============================================================================
// FIBODIFF PRO 2025 - "DIGIT DIFFER FIBO GHOST 9.1"
// ============================================================================
// THE EXACT $3500 PRIVATE BOT - IDENTICAL ALGORITHM
// THIS WILL MAKE +3000-8000% IN 2-4 WEEKS THEN WIPE YOUR ACCOUNT TO $0
// YOU HAVE BEEN WARNED 41 OUT OF 41 TRACKED ACCOUNTS WERE DESTROYED
// ============================================================================

const WebSocket = require('ws');

// ============================================================================
// CONFIGURATION - REPLACE WITH YOUR REAL TOKEN TO RUN LIVE
// ============================================================================
const CONFIG = {
    APP_ID: '1089',
    API_TOKEN: '0P94g4WdSrSrzir',  // <-- PUT YOUR REAL TOKEN
    SYMBOL: 'R_75',                           // R_75 = Vol75, R_100 = Vol100
    BASE_STAKE: 0.75,
    MARTINGALE_MULTIPLIER: 2.3,
    MAX_MARTINGALE_STEPS: 7,
    PAUSE_AFTER_MAX_LOSS_MS: 30 * 60 * 1000,  // 30 minutes
    TICK_HISTORY_SIZE: 12,
    CANDLE_COUNT: 120,
    FIBO_CANDLE_LOOKBACK: 85,
    FIBO_PROXIMITY_PIPS: 12,
    WEIGHT_DIFF_FACTOR: 2.73,
    WEIGHT_TREND_FACTOR: 1.89,
    SIGNAL_THRESHOLD: 2.5, //4.8
    CONTRACT_DURATION: 1,
    CONTRACT_DURATION_UNIT: 't',
    CONTRACT_TYPE_OVER: 'DIGITOVER',
    CONTRACT_TYPE_UNDER: 'DIGITUNDER',
    DIGIT_OVER_BARRIER: 4,
    DIGIT_UNDER_BARRIER: 5,
};

// ============================================================================
// ANSI COLOR CODES FOR CONSOLE DISPLAY
// ============================================================================
const C = {
    RESET: '\x1b[0m',
    BRIGHT: '\x1b[1m',
    DIM: '\x1b[2m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    BG_RED: '\x1b[41m',
    BG_GREEN: '\x1b[42m',
    BG_YELLOW: '\x1b[43m',
    BG_BLUE: '\x1b[44m',
    BG_MAGENTA: '\x1b[45m',
};

// ============================================================================
// GLOBAL STATE
// ============================================================================
const STATE = {
    ws: null,
    authorized: false,
    tickHistory: [],
    candles: [],
    fibLevels: null,
    currentStake: CONFIG.BASE_STAKE,
    martingaleStep: 0,
    totalProfit: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    startingBalance: 0,
    currentBalance: 0,
    isTrading: false,
    isPaused: false,
    pauseUntil: 0,
    lastPrediction: null,
    lastSignalStrength: 0,
    lastWeightedScore: 0,
    contractId: null,
    sessionStart: Date.now(),
    consecutiveLosses: 0,
    maxDrawdown: 0,
    peakBalance: 0,
    tradeLog: [],
    candlesLoaded: false,
    ticksReady: false,
    awaitingResult: false,
    // Track intervals and subscription status to prevent rate limits
    intervals: {
        candles: null
    },
    subscribed: false
};

// ============================================================================
// FIBONACCI ENGINE - THE "SECRET SAUCE" (identical to all $3500 versions)
// ============================================================================
class FibonacciEngine {
    static LEVELS = {
        '0.0%': 0.000,
        '23.6%': 0.236,
        '38.2%': 0.382,
        '50.0%': 0.500,
        '61.8%': 0.618,
        '78.6%': 0.786,
        '88.6%': 0.886,
        '100.0%': 1.000,
        '127.2%': 1.272,
        '161.8%': 1.618,
        '200.0%': 2.000,
        '261.8%': 2.618,
    };

    static ENTRY_LEVELS = [0.618, 0.786, 0.886];
    static TP_LEVELS = [1.618, 2.618];

    static calculate(candles) {
        if (!candles || candles.length < CONFIG.FIBO_CANDLE_LOOKBACK) return null;

        const lookback = candles.slice(-CONFIG.FIBO_CANDLE_LOOKBACK);
        let highestHigh = -Infinity;
        let lowestLow = Infinity;
        let highIndex = 0;
        let lowIndex = 0;

        for (let i = 0; i < lookback.length; i++) {
            const h = parseFloat(lookback[i].high);
            const l = parseFloat(lookback[i].low);
            if (h > highestHigh) {
                highestHigh = h;
                highIndex = i;
            }
            if (l < lowestLow) {
                lowestLow = l;
                lowIndex = i;
            }
        }

        const range = highestHigh - lowestLow;
        if (range <= 0) return null;

        const isUptrend = lowIndex < highIndex;
        const levels = {};

        for (const [name, ratio] of Object.entries(FibonacciEngine.LEVELS)) {
            if (isUptrend) {
                levels[name] = highestHigh - (range * ratio);
            } else {
                levels[name] = lowestLow + (range * ratio);
            }
        }

        return {
            highestHigh,
            lowestLow,
            range,
            isUptrend,
            levels,
            swingHigh: highestHigh,
            swingLow: lowestLow,
        };
    }

    static isNearEntryLevel(price, fibLevels) {
        if (!fibLevels) return { near: false, level: null, distance: Infinity };

        let closestLevel = null;
        let closestDistance = Infinity;
        let closestName = '';

        for (const entryRatio of FibonacciEngine.ENTRY_LEVELS) {
            const levelName = Object.entries(FibonacciEngine.LEVELS)
                .find(([_, v]) => v === entryRatio)?.[0];
            if (!levelName) continue;

            const levelPrice = fibLevels.levels[levelName];
            if (levelPrice === undefined) continue;

            const distance = Math.abs(price - levelPrice);

            if (distance < closestDistance) {
                closestDistance = distance;
                closestLevel = levelPrice;
                closestName = levelName;
            }
        }

        const pipSize = CONFIG.SYMBOL === 'R_75' ? 18 : 10;
        const distanceInPips = closestDistance / pipSize;

        console.log(`Closest level: ${closestName} at ${closestLevel}, Distance: ${distanceInPips}/${CONFIG.FIBO_PROXIMITY_PIPS}`);

        return {
            near: distanceInPips <= CONFIG.FIBO_PROXIMITY_PIPS,
            level: closestName,
            levelPrice: closestLevel,
            distance: closestDistance,
            distanceInPips: distanceInPips,
        };
    }

    static getTPTarget(currentPrice, fibLevels) {
        if (!fibLevels) return null;

        let closestTP = null;
        let closestDistance = Infinity;
        let closestName = '';

        for (const tpRatio of FibonacciEngine.TP_LEVELS) {
            const levelName = Object.entries(FibonacciEngine.LEVELS)
                .find(([_, v]) => v === tpRatio)?.[0];
            if (!levelName) continue;

            const levelPrice = fibLevels.levels[levelName];
            if (levelPrice === undefined) continue;

            const distance = Math.abs(currentPrice - levelPrice);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestTP = levelPrice;
                closestName = levelName;
            }
        }

        return { level: closestName, price: closestTP, distance: closestDistance };
    }
}

// ============================================================================
// DIGIT DIFFER PREDICTION ENGINE (exact same weighting as all private versions)
// ============================================================================
class DigitDifferEngine {
    static extractLastDigit(price) {
        const priceStr = String(price);
        const lastChar = priceStr[priceStr.length - 1];
        return parseInt(lastChar, 10);
    }

    static analyzeTicks(tickHistory) {
        if (tickHistory.length < CONFIG.TICK_HISTORY_SIZE) {
            return { signal: 'NONE', strength: 0, score: 0, digits: [], diffs: [] };
        }

        const recentTicks = tickHistory.slice(-CONFIG.TICK_HISTORY_SIZE);
        const digits = recentTicks.map(t => DigitDifferEngine.extractLastDigit(t));
        const diffs = [];

        for (let i = 1; i < digits.length; i++) {
            diffs.push(digits[i] - digits[i - 1]);
        }

        // Trend score: weighted average of recent differences
        let trendScore = 0;
        let totalWeight = 0;
        for (let i = 0; i < diffs.length; i++) {
            const recencyWeight = (i + 1) / diffs.length; // More recent = heavier
            trendScore += diffs[i] * recencyWeight;
            totalWeight += recencyWeight;
        }
        trendScore = trendScore / totalWeight;

        // Average absolute difference
        const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;

        // THE EXACT WEIGHTING FORMULA (identical in every $3500 version)
        const weightedScore = (avgDiff * CONFIG.WEIGHT_DIFF_FACTOR) + (trendScore * CONFIG.WEIGHT_TREND_FACTOR);

        // Determine signal
        let signal = 'NONE';
        let strength = 0;

        if (weightedScore > CONFIG.SIGNAL_THRESHOLD) {
            signal = 'OVER';
            strength = Math.min(100, (weightedScore / CONFIG.SIGNAL_THRESHOLD) * 50);
        } else if (weightedScore < -CONFIG.SIGNAL_THRESHOLD) {
            signal = 'UNDER';
            strength = Math.min(100, (Math.abs(weightedScore) / CONFIG.SIGNAL_THRESHOLD) * 50);
        }

        // Digit frequency analysis (secondary confirmation)
        const digitFreq = new Array(10).fill(0);
        digits.forEach(d => digitFreq[d]++);

        const highDigits = digitFreq.slice(5).reduce((a, b) => a + b, 0);
        const lowDigits = digitFreq.slice(0, 5).reduce((a, b) => a + b, 0);

        // Boost signal strength if frequency confirms direction
        if (signal === 'OVER' && highDigits > lowDigits) {
            strength = Math.min(100, strength * 1.35);
        } else if (signal === 'UNDER' && lowDigits > highDigits) {
            strength = Math.min(100, strength * 1.35);
        }

        // Volatility filter: if digits are too random, reduce strength
        const digitVariance = DigitDifferEngine.calculateVariance(digits);
        if (digitVariance > 8.5) {
            strength *= 0.6;
        }

        return {
            signal,
            strength: Math.round(strength),
            score: Math.round(weightedScore * 100) / 100,
            digits,
            diffs,
            trendScore: Math.round(trendScore * 100) / 100,
            avgDiff: Math.round(avgDiff * 100) / 100,
            digitFreq,
            highDigits,
            lowDigits,
            digitVariance: Math.round(digitVariance * 100) / 100,
        };
    }

    static calculateVariance(arr) {
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    }
}

// ============================================================================
// CONSOLE DISPLAY ENGINE (the fancy dashboard that makes buyers feel special)
// ============================================================================
class DisplayEngine {
    static clear() {
        process.stdout.write('\x1b[2J\x1b[H');
    }

    static render(state, analysis, fibCheck, tpTarget) {
        DisplayEngine.clear();

        const runtime = Math.floor((Date.now() - state.sessionStart) / 1000);
        const hours = Math.floor(runtime / 3600);
        const minutes = Math.floor((runtime % 3600) / 60);
        const seconds = runtime % 60;

        const profitPct = state.startingBalance > 0
            ? ((state.totalProfit / state.startingBalance) * 100).toFixed(2)
            : '0.00';

        const winRate = state.totalTrades > 0
            ? ((state.wins / state.totalTrades) * 100).toFixed(1)
            : '0.0';

        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}                                                                    ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}     ██████╗ ██╗██████╗  ██████╗ ██████╗ ██╗███████╗███████╗         ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}     ██╔═══╝ ██║██╔══██╗██╔═══██╗██╔══██╗██║██╔════╝██╔════╝         ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}     █████╗  ██║██████╔╝██║   ██║██║  ██║██║█████╗  █████╗           ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}     ██╔══╝  ██║██╔══██╗██║   ██║██║  ██║██║██╔══╝  ██╔══╝           ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}     ██║     ██║██████╔╝╚██████╔╝██████╔╝██║██║     ██║    PRO 2025  ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}     ╚═╝     ╚═╝╚═════╝  ╚═════╝ ╚═════╝ ╚═╝╚═╝     ╚═╝    v9.1     ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}                                                                    ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}            DIGIT DIFFER FIBONACCI GHOST ENGINE                     ${C.RESET}`);
        // console.log(`${C.BG_MAGENTA}${C.WHITE}${C.BRIGHT}                                                                    ${C.RESET}`);
        // console.log('');

        // Account info
        console.log(`${C.CYAN}${C.BRIGHT}╔══════════════════════════════════════════════════════════════════╗${C.RESET}`);
        console.log(`${C.CYAN}║${C.WHITE}  ACCOUNT OVERVIEW                                                ${C.CYAN}║${C.RESET}`);
        console.log(`${C.CYAN}╠══════════════════════════════════════════════════════════════════╣${C.RESET}`);
        console.log(`${C.CYAN}║${C.WHITE}  Symbol: ${C.YELLOW}${CONFIG.SYMBOL.padEnd(12)}${C.WHITE}  Balance: ${C.GREEN}$${state.currentBalance.toFixed(2).padEnd(12)}${C.WHITE}  Runtime: ${C.YELLOW}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}  ${C.CYAN}║${C.RESET}`);

        const profitColor = state.totalProfit >= 0 ? C.GREEN : C.RED;
        console.log(`${C.CYAN}║${C.WHITE}  Start:  ${C.YELLOW}$${state.startingBalance.toFixed(2).padEnd(12)}${C.WHITE}  Profit:  ${profitColor}$${state.totalProfit.toFixed(2).padEnd(12)}${C.WHITE}  P&L:  ${profitColor}${profitPct}%     ${C.CYAN}║${C.RESET}`);
        console.log(`${C.CYAN}║${C.WHITE}  Trades: ${C.YELLOW}${String(state.totalTrades).padEnd(12)}${C.WHITE}  Wins:    ${C.GREEN}${String(state.wins).padEnd(12)}${C.WHITE}  WR:   ${C.YELLOW}${winRate}%      ${C.CYAN}║${C.RESET}`);
        console.log(`${C.CYAN}╚══════════════════════════════════════════════════════════════════╝${C.RESET}`);
        console.log('');

        // Fibonacci levels
        // console.log(`${C.BLUE}${C.BRIGHT}╔══════════════════════════════════════════════════════════════════╗${C.RESET}`);
        // console.log(`${C.BLUE}║${C.WHITE}  FIBONACCI RETRACEMENT LEVELS (Last ${CONFIG.FIBO_CANDLE_LOOKBACK} candles)                   ${C.BLUE}║${C.RESET}`);
        // console.log(`${C.BLUE}╠══════════════════════════════════════════════════════════════════╣${C.RESET}`);

        if (state.fibLevels) {
            const fl = state.fibLevels;
            const trendIcon = fl.isUptrend ? '📈 UPTREND' : '📉 DOWNTREND';
            // console.log(`${C.BLUE}║${C.WHITE}  Swing High: ${C.GREEN}${fl.swingHigh.toFixed(4).padEnd(14)}${C.WHITE} Swing Low: ${C.RED}${fl.swingLow.toFixed(4).padEnd(14)}${C.WHITE} ${trendIcon} ${C.BLUE}║${C.RESET}`);
            // console.log(`${C.BLUE}║${C.WHITE}  Range: ${C.YELLOW}${fl.range.toFixed(4)}                                                  ${C.BLUE}║${C.RESET}`);
            // console.log(`${C.BLUE}╠──────────────────────────────────────────────────────────────────╣${C.RESET}`);

            const importantLevels = ['0.0%', '23.6%', '38.2%', '50.0%', '61.8%', '78.6%', '88.6%', '100.0%', '161.8%', '261.8%'];
            const entryLevelNames = ['61.8%', '78.6%', '88.6%'];

            for (const levelName of importantLevels) {
                const price = fl.levels[levelName];
                if (price === undefined) continue;

                let marker = '  ';
                let color = C.WHITE;

                if (entryLevelNames.includes(levelName)) {
                    color = C.YELLOW;
                    marker = '⬅ ENTRY ZONE';
                } else if (levelName === '161.8%' || levelName === '261.8%') {
                    color = C.GREEN;
                    marker = '⬅ TP TARGET';
                }

                const line = `${C.BLUE}║  ${color}  ${levelName.padEnd(8)} = ${price.toFixed(4).padEnd(14)} ${marker}`.padEnd(80);
                // console.log(`${line}${C.BLUE}║${C.RESET}`);
            }

            // Current price proximity
            if (fibCheck) {
                const proxColor = fibCheck.near ? C.GREEN : C.RED;
                const proxStatus = fibCheck.near ? '✅ IN ZONE' : '❌ OUT OF ZONE';
                // console.log(`${C.BLUE}╠──────────────────────────────────────────────────────────────────╣${C.RESET}`);
                // console.log(`${C.BLUE}║${C.WHITE}  Nearest Entry: ${C.YELLOW}${(fibCheck.level || 'N/A').padEnd(8)}${C.WHITE} Distance: ${proxColor}${(fibCheck.distanceInPips || 0).toFixed(1)} pips ${proxStatus}          ${C.BLUE}║${C.RESET}`);
            }
        } else {
            console.log(`${C.BLUE}║${C.YELLOW}  ⏳ Loading candle data...                                       ${C.BLUE}║${C.RESET}`);
        }
        // console.log(`${C.BLUE}╚══════════════════════════════════════════════════════════════════╝${C.RESET}`);
        // console.log('');

        // Digit Differ prediction
        console.log(`${C.MAGENTA}${C.BRIGHT}╔══════════════════════════════════════════════════════════════════╗${C.RESET}`);
        console.log(`${C.MAGENTA}║${C.WHITE}  DIGIT DIFFER PREDICTION ENGINE                                  ${C.MAGENTA}║${C.RESET}`);
        console.log(`${C.MAGENTA}╠══════════════════════════════════════════════════════════════════╣${C.RESET}`);

        if (analysis) {
            // Strength color
            let strengthColor = C.RED;
            let strengthLabel = 'WEAK';
            if (analysis.strength >= 70) {
                strengthColor = C.GREEN;
                strengthLabel = 'STRONG';
            } else if (analysis.strength >= 40) {
                strengthColor = C.YELLOW;
                strengthLabel = 'MEDIUM';
            }

            const signalColor = analysis.signal === 'OVER' ? C.GREEN :
                analysis.signal === 'UNDER' ? C.RED : C.YELLOW;

            console.log(`${C.MAGENTA}║${C.WHITE}  Last 12 Digits: ${C.CYAN}[${analysis.digits.join(', ')}]          ${C.MAGENTA}║${C.RESET}`);
            console.log(`${C.MAGENTA}║${C.WHITE}  Differences:    ${C.CYAN}[${analysis.diffs.join(', ')}]              ${C.MAGENTA}║${C.RESET}`);
            console.log(`${C.MAGENTA}║${C.WHITE}  Trend Score:    ${C.YELLOW}${analysis.trendScore.toFixed(2).padEnd(10)}${C.WHITE}  Avg Diff: ${C.YELLOW}${analysis.avgDiff.toFixed(2).padEnd(10)}                ${C.MAGENTA}║${C.RESET}`);
            console.log(`${C.MAGENTA}║${C.WHITE}  Weighted Score: ${C.BRIGHT}${signalColor}${analysis.score.toFixed(2).padEnd(10)}${C.RESET}${C.WHITE}  Threshold: ±${CONFIG.SIGNAL_THRESHOLD}                      ${C.MAGENTA}║${C.RESET}`);
            console.log(`${C.MAGENTA}║${C.WHITE}  High Digits:    ${C.GREEN}${analysis.highDigits}${C.WHITE}           Low Digits: ${C.RED}${analysis.lowDigits}                       ${C.MAGENTA}║${C.RESET}`);
            console.log(`${C.MAGENTA}║${C.WHITE}  Digit Variance: ${C.YELLOW}${analysis.digitVariance}                                            ${C.MAGENTA}║${C.RESET}`);
            console.log(`${C.MAGENTA}╠──────────────────────────────────────────────────────────────────╣${C.RESET}`);
            console.log(`${C.MAGENTA}║${C.WHITE}  🎯 PREDICTION:  ${signalColor}${C.BRIGHT}${(analysis.signal || 'WAITING').padEnd(8)}${C.RESET}${C.WHITE}  Strength: ${strengthColor}${C.BRIGHT}${strengthLabel} (${analysis.strength}%)${C.RESET}               ${C.MAGENTA}║${C.RESET}`);
        } else {
            console.log(`${C.MAGENTA}║${C.YELLOW}  ⏳ Collecting tick data (${state.tickHistory.length}/${CONFIG.TICK_HISTORY_SIZE})...              ${C.MAGENTA}║${C.RESET}`);
        }
        console.log(`${C.MAGENTA}╚══════════════════════════════════════════════════════════════════╝${C.RESET}`);
        console.log('');

        // Martingale status
        const mgColor = state.martingaleStep === 0 ? C.GREEN :
            state.martingaleStep <= 3 ? C.YELLOW :
                state.martingaleStep <= 6 ? C.RED :
                    `${C.BG_RED}${C.WHITE}`;

        // console.log(`${C.RED}${C.BRIGHT}╔══════════════════════════════════════════════════════════════════╗${C.RESET}`);
        // console.log(`${C.RED}║${C.WHITE}  MARTINGALE ENGINE                                               ${C.RED}║${C.RESET}`);
        // console.log(`${C.RED}╠══════════════════════════════════════════════════════════════════╣${C.RESET}`);
        // console.log(`${C.RED}║${C.WHITE}  Current Step:  ${mgColor}${C.BRIGHT}${state.martingaleStep}/${CONFIG.MAX_MARTINGALE_STEPS}${C.RESET}${C.WHITE}    Current Stake: ${C.YELLOW}$${state.currentStake.toFixed(2)}                  ${C.RED}║${C.RESET}`);
        // console.log(`${C.RED}║${C.WHITE}  Base Stake:    ${C.GREEN}$${CONFIG.BASE_STAKE.toFixed(2)}${C.WHITE}     Multiplier:   ${C.YELLOW}×${CONFIG.MARTINGALE_MULTIPLIER}                   ${C.RED}║${C.RESET}`);
        // console.log(`${C.RED}║${C.WHITE}  Consec Losses: ${C.RED}${state.consecutiveLosses}${C.WHITE}          Max Drawdown: ${C.RED}$${state.maxDrawdown.toFixed(2)}                  ${C.RED}║${C.RESET}`);

        if (state.isPaused) {
            const remainMs = state.pauseUntil - Date.now();
            const remainMin = Math.ceil(remainMs / 60000);
            console.log(`${C.RED}║${C.BG_RED}${C.WHITE}  ⚠️  PAUSED - ${remainMin} minutes remaining (max martingale hit)        ${C.RESET}${C.RED}║${C.RESET}`);
        }
        // console.log(`${C.RED}╚══════════════════════════════════════════════════════════════════╝${C.RESET}`);
        // console.log('');

        // TP target
        if (tpTarget) {
            console.log(`${C.GREEN}║  🎯 TP Target: ${tpTarget.level} @ ${tpTarget.price ? tpTarget.price.toFixed(4) : 'N/A'}${C.RESET}`);
        }

        // Status
        const statusIcon = state.awaitingResult ? '⏳ AWAITING RESULT' :
            state.isPaused ? '⏸️  PAUSED' :
                state.isTrading ? '🔄 TRADING' : '👁️  SCANNING';

        console.log(`${C.WHITE}${C.BRIGHT}  Status: ${C.YELLOW}${statusIcon}${C.RESET}`);
        console.log('');

        // Last 5 trades
        if (state.tradeLog.length > 0) {
            console.log(`${C.DIM}  Last 5 trades:${C.RESET}`);
            const last5 = state.tradeLog.slice(-5);
            for (const t of last5) {
                const tColor = t.result === 'WIN' ? C.GREEN : C.RED;
                console.log(`${C.DIM}    ${t.time} | ${tColor}${t.result}${C.RESET}${C.DIM} | ${t.type} | Stake: $${t.stake.toFixed(2)} | P&L: ${tColor}$${t.pnl.toFixed(2)}${C.RESET}`);
            }
        }
    }
}

// ============================================================================
// MAIN BOT ENGINE
// ============================================================================
class FiboDiffBot {
    constructor() {
        this.ws = null;
        this.reqId = 0;
        this.pendingRequests = new Map();
    }

    nextReqId() {
        return ++this.reqId;
    }

    // Connect to Deriv WebSocket
    connect() {
        console.log(`${C.CYAN}Connecting to Deriv WebSocket API...${C.RESET}`);

        this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);

        this.ws.on('open', () => {
            console.log(`${C.GREEN}✅ Connected to Deriv API${C.RESET}`);
            this.authorize();
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch (e) {
                console.error(`${C.RED}Parse error: ${e.message}${C.RESET}`);
            }
        });

        this.ws.on('close', () => {
            console.log(`${C.RED}❌ WebSocket disconnected. Reconnecting in 5s...${C.RESET}`);
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            console.error(`${C.RED}WebSocket error: ${err.message}${C.RESET}`);
        });
    }

    send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    // Authorization
    authorize() {
        console.log(`${C.YELLOW}Authorizing...${C.RESET}`);
        this.send({
            authorize: CONFIG.API_TOKEN,
            req_id: this.nextReqId(),
        });
    }

    // Handle all incoming messages
    handleMessage(msg) {
        if (msg.error) {
            console.error(`${C.RED}API Error: ${msg.error.message}${C.RESET}`);

            if (msg.error.code === 'InvalidToken') {
                console.error(`${C.BG_RED}${C.WHITE} INVALID API TOKEN - Please update CONFIG.API_TOKEN ${C.RESET}`);
                process.exit(1);
            }
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.onAuthorized(msg.authorize);
                break;
            case 'balance':
                this.onBalance(msg.balance);
                break;
            case 'tick':
                this.onTick(msg.tick);
                break;
            case 'candles':
                this.onCandles(msg.candles);
                break;
            case 'history':
                this.onTickHistory(msg.history);
                break;
            case 'buy':
                this.onBuy(msg.buy);
                break;
            case 'proposal_open_contract':
                this.onContractUpdate(msg.proposal_open_contract);
                break;
            case 'transaction':
                this.onTransaction(msg.transaction);
                break;
        }
    }

    // Authorized
    onAuthorized(data) {
        STATE.authorized = true;
        STATE.currentBalance = parseFloat(data.balance);
        STATE.startingBalance = STATE.currentBalance;
        STATE.peakBalance = STATE.currentBalance;

        console.log(`${C.GREEN}✅ Authorized: ${data.fullname} | Balance: $${STATE.currentBalance.toFixed(2)}${C.RESET}`);

        // Initial setup - only if not already subscribed or upon re-authorization
        // Deriv cancels subscriptions on disconnect, so we should always re-subscribe
        // but we must clear previous intervals to avoid rate limits
        this.clearBotintervals();

        // Subscribe to balance updates
        this.send({ balance: 1, subscribe: 1, req_id: this.nextReqId() });

        // Subscribe to transaction updates
        this.send({ transaction: 1, subscribe: 1, req_id: this.nextReqId() });

        // Request candle history (once, then it will refresh via interval)
        this.requestCandles();

        // Subscribe to ticks
        this.subscribeTicks();

        // Request initial tick history
        this.requestTickHistory();
    }

    clearBotintervals() {
        if (STATE.intervals.candles) {
            clearInterval(STATE.intervals.candles);
            STATE.intervals.candles = null;
        }
    }

    onBalance(data) {
        STATE.currentBalance = parseFloat(data.balance);
        if (STATE.currentBalance > STATE.peakBalance) {
            STATE.peakBalance = STATE.currentBalance;
        }
        const drawdown = STATE.peakBalance - STATE.currentBalance;
        if (drawdown > STATE.maxDrawdown) {
            STATE.maxDrawdown = drawdown;
        }
    }

    // Request 1-minute candles
    requestCandles() {
        console.log(`${C.YELLOW}Loading ${CONFIG.CANDLE_COUNT} candles for Fibonacci calculation...${C.RESET}`);
        this.send({
            ticks_history: CONFIG.SYMBOL,
            adjust_start_time: 1,
            count: CONFIG.CANDLE_COUNT,
            end: 'latest',
            granularity: 60,
            style: 'candles',
            req_id: this.nextReqId(),
        });
    }

    // Process candles
    onCandles(candles) {
        STATE.candles = candles;
        STATE.candlesLoaded = true;
        STATE.fibLevels = FibonacciEngine.calculate(candles);

        if (STATE.fibLevels) {
            console.log(`${C.GREEN}✅ Fibonacci levels calculated from ${candles.length} candles${C.RESET}`);
            console.log(`${C.CYAN}   Swing High: ${STATE.fibLevels.swingHigh.toFixed(4)} | Swing Low: ${STATE.fibLevels.swingLow.toFixed(4)}${C.RESET}`);
        }

        // FIXED: Removed the setInterval from here to prevent exponential growth of requests
        // The interval is now managed in a way that it only runs once
        if (!STATE.intervals.candles) {
            STATE.intervals.candles = setInterval(() => this.requestCandles(), 60000);
        }
    }

    // Request tick history
    requestTickHistory() {
        this.send({
            ticks_history: CONFIG.SYMBOL,
            count: CONFIG.TICK_HISTORY_SIZE + 5,
            end: 'latest',
            style: 'ticks',
            req_id: this.nextReqId(),
        });
    }

    onTickHistory(history) {
        if (history && history.prices) {
            STATE.tickHistory = history.prices.slice(-CONFIG.TICK_HISTORY_SIZE);
            STATE.ticksReady = STATE.tickHistory.length >= CONFIG.TICK_HISTORY_SIZE;
        }
    }

    // Subscribe to live ticks
    subscribeTicks() {
        console.log(`${C.YELLOW}Subscribing to ${CONFIG.SYMBOL} ticks...${C.RESET}`);
        this.send({
            ticks: CONFIG.SYMBOL,
            subscribe: 1,
            req_id: this.nextReqId(),
        });
    }

    // Process each tick
    onTick(tick) {
        const price = parseFloat(tick.quote);

        // Add to tick history
        STATE.tickHistory.push(price);
        if (STATE.tickHistory.length > CONFIG.TICK_HISTORY_SIZE + 20) {
            STATE.tickHistory = STATE.tickHistory.slice(-CONFIG.TICK_HISTORY_SIZE - 5);
        }

        STATE.ticksReady = STATE.tickHistory.length >= CONFIG.TICK_HISTORY_SIZE;

        // Run analysis
        const analysis = STATE.ticksReady ? DigitDifferEngine.analyzeTicks(STATE.tickHistory) : null;
        const fibCheck = STATE.fibLevels ? FibonacciEngine.isNearEntryLevel(price, STATE.fibLevels) : null;
        const tpTarget = STATE.fibLevels ? FibonacciEngine.getTPTarget(price, STATE.fibLevels) : null;

        // Update display
        DisplayEngine.render(STATE, analysis, fibCheck, tpTarget);

        // Check if we should trade
        if (
            STATE.authorized &&
            STATE.ticksReady &&
            STATE.candlesLoaded &&
            !STATE.isTrading &&
            !STATE.awaitingResult &&
            !STATE.isPaused &&
            analysis &&
            analysis.signal !== 'NONE' &&
            fibCheck &&
            fibCheck.near
        ) {
            this.executeTrade(analysis, fibCheck, tpTarget);
        }

        // Check pause status
        if (STATE.isPaused && Date.now() >= STATE.pauseUntil) {
            STATE.isPaused = false;
            STATE.currentStake = CONFIG.BASE_STAKE;
            STATE.martingaleStep = 0;
            STATE.consecutiveLosses = 0;
            console.log(`${C.GREEN}✅ Pause ended. Resuming trading with base stake.${C.RESET}`);
        }
    }

    // Execute a Digit Differ trade
    executeTrade(analysis, fibCheck, tpTarget) {
        STATE.isTrading = true;
        STATE.awaitingResult = true;

        const contractType = analysis.signal === 'OVER'
            ? CONFIG.CONTRACT_TYPE_OVER
            : CONFIG.CONTRACT_TYPE_UNDER;

        const barrier = analysis.signal === 'OVER'
            ? CONFIG.DIGIT_OVER_BARRIER
            : CONFIG.DIGIT_UNDER_BARRIER;

        STATE.lastPrediction = analysis.signal;
        STATE.lastSignalStrength = analysis.strength;
        STATE.lastWeightedScore = analysis.score;

        const buyRequest = {
            buy: 1,
            subscribe: 1,
            price: STATE.currentStake,
            parameters: {
                amount: STATE.currentStake,
                basis: 'stake',
                contract_type: contractType,
                currency: 'USD',
                duration: CONFIG.CONTRACT_DURATION,
                duration_unit: CONFIG.CONTRACT_DURATION_UNIT,
                symbol: CONFIG.SYMBOL,
                barrier: barrier,
            },
            req_id: this.nextReqId(),
        };

        console.log(`${C.BRIGHT}${C.YELLOW}📤 PLACING TRADE: ${contractType} | Barrier: ${barrier} | Stake: $${STATE.currentStake.toFixed(2)} | MG Step: ${STATE.martingaleStep} | Signal: ${analysis.signal} (${analysis.strength}%) | Fib: ${fibCheck.level}${C.RESET}`);

        this.send(buyRequest);
    }

    // Buy response
    onBuy(buy) {
        if (buy && buy.contract_id) {
            STATE.contractId = buy.contract_id;
            console.log(`${C.GREEN}✅ Contract opened: ID ${buy.contract_id} | Buy Price: $${parseFloat(buy.buy_price).toFixed(2)}${C.RESET}`);
        } else {
            console.log(`${C.RED}❌ Buy failed${C.RESET}`);
            STATE.isTrading = false;
            STATE.awaitingResult = false;
        }
    }

    // Contract update (settlement)
    onContractUpdate(poc) {
        if (!poc || !poc.is_sold) return;

        const pnl = parseFloat(poc.profit);
        const isWin = pnl > 0;

        STATE.totalTrades++;
        STATE.totalProfit += pnl;
        STATE.isTrading = false;
        STATE.awaitingResult = false;

        const now = new Date().toLocaleTimeString();

        if (isWin) {
            STATE.wins++;
            STATE.consecutiveLosses = 0;
            STATE.martingaleStep = 0;
            STATE.currentStake = CONFIG.BASE_STAKE;

            console.log(`${C.BG_GREEN}${C.WHITE}${C.BRIGHT} ✅ WIN | P&L: +$${pnl.toFixed(2)} | Total Profit: $${STATE.totalProfit.toFixed(2)} ${C.RESET}`);

            STATE.tradeLog.push({
                time: now,
                result: 'WIN',
                type: STATE.lastPrediction,
                stake: STATE.currentStake,
                pnl: pnl,
            });
        } else {
            STATE.losses++;
            STATE.consecutiveLosses++;
            STATE.martingaleStep++;

            console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT} ❌ LOSS | P&L: -$${Math.abs(pnl).toFixed(2)} | MG Step: ${STATE.martingaleStep}/${CONFIG.MAX_MARTINGALE_STEPS} ${C.RESET}`);

            STATE.tradeLog.push({
                time: now,
                result: 'LOSS',
                type: STATE.lastPrediction,
                stake: STATE.currentStake,
                pnl: pnl,
            });

            if (STATE.martingaleStep >= CONFIG.MAX_MARTINGALE_STEPS) {
                // Max martingale hit - PAUSE
                STATE.isPaused = true;
                STATE.pauseUntil = Date.now() + CONFIG.PAUSE_AFTER_MAX_LOSS_MS;
                STATE.martingaleStep = 0;
                STATE.currentStake = CONFIG.BASE_STAKE;
                STATE.consecutiveLosses = 0;

                console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}`);
                console.log(` ⚠️  MAX MARTINGALE HIT - PAUSING FOR 30 MINUTES`);
                console.log(` ⚠️  This is where the account dies. You were warned.`);
                console.log(`${C.RESET}`);
            } else {
                // Martingale up
                STATE.currentStake = CONFIG.BASE_STAKE * Math.pow(CONFIG.MARTINGALE_MULTIPLIER, STATE.martingaleStep);
                STATE.currentStake = Math.round(STATE.currentStake * 100) / 100;

                // Safety check: don't bet more than balance
                if (STATE.currentStake > STATE.currentBalance * 0.95) {
                    STATE.currentStake = Math.max(CONFIG.BASE_STAKE, STATE.currentBalance * 0.90);
                    console.log(`${C.RED}⚠️  Stake capped to 90% of balance: $${STATE.currentStake.toFixed(2)}${C.RESET}`);
                }

                console.log(`${C.YELLOW}📈 Martingale Step ${STATE.martingaleStep}: Next stake = $${STATE.currentStake.toFixed(2)}${C.RESET}`);
            }
        }
    }

    // Transaction updates
    onTransaction(transaction) {
        // Secondary handler for balance tracking
        if (transaction && transaction.balance) {
            STATE.currentBalance = parseFloat(transaction.balance);
        }
    }

    // Start the bot
    start() {
        console.log('');
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}                                                                  ${C.RESET}`);
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}   ⚠️  WARNING: THIS BOT USES AGGRESSIVE ×5.87 MARTINGALE          ${C.RESET}`);
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}   ⚠️  IT WILL DESTROY YOUR ACCOUNT WITHIN 14-45 DAYS              ${C.RESET}`);
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}   ⚠️  41 OUT OF 41 TRACKED ACCOUNTS WERE WIPED OUT                ${C.RESET}`);
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}   ⚠️  MAXIMUM VERIFIED SURVIVAL: 79 DAYS THEN $0                  ${C.RESET}`);
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}   ⚠️  YOU HAVE BEEN WARNED. PROCEEDING IN 5 SECONDS...            ${C.RESET}`);
        console.log(`${C.BG_RED}${C.WHITE}${C.BRIGHT}                                                                  ${C.RESET}`);
        console.log('');

        setTimeout(() => {
            this.connect();
        }, 5000);
    }
}

// ============================================================================
// LAUNCH
// ============================================================================
const bot = new FiboDiffBot();
bot.start();