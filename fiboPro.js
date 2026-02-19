#!/usr/bin/env node

// ============================================================================
//
//  ███████╗██╗██████╗  ██████╗     ██████╗ ██████╗  ██████╗
//  ██╔════╝██║██╔══██╗██╔═══██╗    ██╔══██╗██╔══██╗██╔═══██╗
//  █████╗  ██║██████╔╝██║   ██║    ██████╔╝██████╔╝██║   ██║
//  ██╔══╝  ██║██╔══██╗██║   ██║    ██╔═══╝ ██╔══██╗██║   ██║
//  ██║     ██║██████╔╝╚██████╔╝    ██║     ██║  ██║╚██████╔╝
//  ╚═╝     ╚═╝╚═════╝  ╚═════╝     ╚═╝     ╚═╝  ╚═╝ ╚═════╝
//
//  V75 2025 EDITION — $2500 PREMIUM
//  Triple Fibonacci · Adaptive Martingale · 500-Tick Pattern Memory
//  Dynamic Barrier · Auto Compound · Recovery Mode · Session Filter
//
//  ⚠️  THIS WILL DESTROY YOUR ACCOUNT IN 14-45 DAYS
//  ⚠️  41/41 TRACKED ACCOUNTS WIPED OUT
//  ⚠️  YOU HAVE BEEN WARNED
//
// ============================================================================

const WebSocket = require('ws');

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    APP_ID: '1089',
    TOKEN: '0P94g4WdSrSrzir',        // <-- REPLACE THIS
    SYMBOL: 'R_75',                             // R_75, R_100, R_50, R_25, R_10

    // Stake & Martingale
    BASE_STAKE: 0.50,
    MG_MULTIPLIER: 2.2,
    MG_MAX_STEPS: 7,
    MG_ADAPTIVE_BOOST_AFTER: 5,                // Increase multiplier after N consecutive losses
    MG_ADAPTIVE_BOOST_AMOUNT: 0.5,

    // Auto Compound
    COMPOUND_PERCENT: 5,                        // % of profit to add to base stake

    // Take Profit / Stop Loss (0 = disabled)
    TAKE_PROFIT: 0,
    STOP_LOSS: 0,

    // Digit Differ Engine
    TICK_HISTORY_SIZE: 12,
    PATTERN_MEMORY_SIZE: 500,
    WEIGHT_DIFF: 2.73,
    WEIGHT_TREND: 1.89,
    SIGNAL_THRESHOLD: 2.5, //4.8,

    // Triple Fibonacci
    CANDLE_COUNT: 120,
    FIB_LOOKBACK: 85,
    FIB_PROXIMITY_PIPS: 12,

    // Session Filter: 'all', 'active', 'london', 'newyork'
    SESSION_FILTER: 'all',

    // Recovery Mode
    RECOVERY_PAUSE_SECONDS: 300,               // 5 minutes pause after max MG
    RECOVERY_STAKE_DIVISOR: 2,                 // Divide base stake by this in recovery
    RECOVERY_WINS_TO_EXIT: 3,                  // Wins needed to exit recovery

    // Contract
    CONTRACT_TYPE: 'DIGITDIFF',
    DURATION: 1,
    DURATION_UNIT: 't',
};

// ============================================================================
// ANSI COLORS
// ============================================================================
const X = {
    R: '\x1b[0m', B: '\x1b[1m', D: '\x1b[2m',
    RED: '\x1b[31m', GRN: '\x1b[32m', YLW: '\x1b[33m',
    BLU: '\x1b[34m', MAG: '\x1b[35m', CYN: '\x1b[36m',
    WHT: '\x1b[37m', GRY: '\x1b[90m',
    BGRED: '\x1b[41m', BGGRN: '\x1b[42m', BGYLW: '\x1b[43m',
    BGBLU: '\x1b[44m', BGMAG: '\x1b[45m', BGCYN: '\x1b[46m',
    BGGLD: '\x1b[48;2;180;140;20m',
};

// ============================================================================
// STATE
// ============================================================================
const S = {
    ws: null,
    authorized: false,
    rid: 0,

    // Ticks & Digits
    ticks: [],
    allDigits: [],

    // Candles (M1, M5, M15)
    candlesM1: null,
    candlesM5: null,
    candlesM15: null,
    candlesLoaded: { M1: false, M5: false, M15: false },

    // Triple Fibonacci
    fibM1: null,
    fibM5: null,
    fibM15: null,
    tfScores: { M1: 0, M5: 0, M15: 0 },

    // Trading State
    stake: CONFIG.BASE_STAKE,
    compoundedBase: CONFIG.BASE_STAKE,
    mgStep: 0,
    barrier: 4,
    prediction: null,
    strength: 0,

    // Account
    balance: 0,
    startBalance: 0,
    peakBalance: 0,
    totalProfit: 0,
    maxDrawdown: 0,

    // Counters
    trades: 0,
    wins: 0,
    losses: 0,
    consecWins: 0,
    consecLosses: 0,
    bestStreak: 0,

    // Flags
    isTrading: false,
    awaitingResult: false,
    isPaused: false,
    isManualPause: false,
    isRecovery: false,
    pauseUntil: 0,

    // Logs
    tradeLog: [],
    profitHistory: [],

    // Timing
    sessionStart: Date.now(),
    lastPrice: 0,
    prevPrice: 0,
    lastTickTime: 0,

    // Display throttle
    lastRender: 0,
};

// ============================================================================
// FIBONACCI ENGINE — TRIPLE TIMEFRAME
// ============================================================================
const FibEngine = {
    RATIOS: {
        '0.0%': 0, '23.6%': 0.236, '38.2%': 0.382, '50.0%': 0.5,
        '61.8%': 0.618, '78.6%': 0.786, '88.6%': 0.886, '100.0%': 1.0,
        '127.2%': 1.272, '161.8%': 1.618, '200.0%': 2.0, '261.8%': 2.618,
    },
    ENTRY_RATIOS: [0.618, 0.786, 0.886],
    TP_RATIOS: [1.618, 2.618],

    calculate(candles) {
        if (!candles || candles.length < CONFIG.FIB_LOOKBACK) return null;
        const lb = candles.slice(-CONFIG.FIB_LOOKBACK);
        let hh = -Infinity, ll = Infinity, hi = 0, li = 0;

        for (let i = 0; i < lb.length; i++) {
            const h = parseFloat(lb[i].high), l = parseFloat(lb[i].low);
            if (h > hh) { hh = h; hi = i; }
            if (l < ll) { ll = l; li = i; }
        }

        const range = hh - ll;
        if (range <= 0) return null;
        const up = li < hi;
        const levels = {};

        for (const [name, ratio] of Object.entries(this.RATIOS)) {
            levels[name] = up ? hh - (range * ratio) : ll + (range * ratio);
        }

        return { hh, ll, range, up, levels };
    },

    checkTripleConfluence(price) {
        const fibs = [S.fibM1, S.fibM5, S.fibM15];
        const tfNames = ['M1', 'M5', 'M15'];
        let confluenceCount = 0;
        let nearestLevel = null, nearestDist = Infinity, nearestTF = '';
        const scores = { M1: 0, M5: 0, M15: 0 };

        const entryNames = { 0.618: '61.8%', 0.786: '78.6%', 0.886: '88.6%' };

        for (let f = 0; f < fibs.length; f++) {
            const fib = fibs[f];
            if (!fib) continue;

            for (const er of this.ENTRY_RATIOS) {
                const name = entryNames[er];
                if (!name) continue;
                const lp = fib.levels[name];
                if (lp === undefined) continue;

                const dist = Math.abs(price - lp) / 0.01;
                if (dist <= CONFIG.FIB_PROXIMITY_PIPS) {
                    confluenceCount++;
                    scores[tfNames[f]] = Math.max(
                        scores[tfNames[f]],
                        100 - dist * (100 / CONFIG.FIB_PROXIMITY_PIPS)
                    );
                    if (dist < nearestDist) {
                        nearestDist = dist;
                        nearestLevel = name;
                        nearestTF = tfNames[f];
                    }
                }
            }
        }

        S.tfScores = scores;

        return {
            confluent: confluenceCount >= 1,
            tripleConfluent: confluenceCount >= 3,
            count: confluenceCount,
            nearestLevel, nearestDist, nearestTF, scores,
        };
    },

    getTPTarget(price, fib) {
        if (!fib) return null;
        let closest = null, cDist = Infinity, cName = '';
        for (const r of this.TP_RATIOS) {
            const name = Object.entries(this.RATIOS).find(([_, v]) => v === r)?.[0];
            if (!name) continue;
            const lp = fib.levels[name];
            if (lp === undefined) continue;
            const d = Math.abs(price - lp);
            if (d < cDist) { cDist = d; closest = lp; cName = name; }
        }
        return { level: cName, price: closest, distance: cDist };
    }
};

// ============================================================================
// DIGIT DIFFER ENGINE — 500-TICK PATTERN MEMORY
// ============================================================================
const DigitEngine = {
    getLastDigit(price) {
        const s = String(price);
        return parseInt(s[s.length - 1], 10);
    },

    analyze() {
        if (S.ticks.length < CONFIG.TICK_HISTORY_SIZE) return null;

        const recent = S.ticks.slice(-CONFIG.TICK_HISTORY_SIZE);
        const digits = recent.map(t => this.getLastDigit(t));
        const diffs = [];
        for (let i = 1; i < digits.length; i++) diffs.push(digits[i] - digits[i - 1]);

        // Weighted trend
        let trend = 0, tw = 0;
        for (let i = 0; i < diffs.length; i++) {
            const w = (i + 1) / diffs.length;
            trend += diffs[i] * w;
            tw += w;
        }
        trend /= tw;

        const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const rawScore = (avgDiff * CONFIG.WEIGHT_DIFF) + (trend * CONFIG.WEIGHT_TREND);

        // Pattern memory boost
        const memBoost = this.patternMemoryBoost(digits);
        const score = rawScore + (memBoost * 1.2);

        let signal = 'NONE', strength = 0;
        if (score > CONFIG.SIGNAL_THRESHOLD) {
            signal = 'OVER';
            strength = Math.min(100, (score / CONFIG.SIGNAL_THRESHOLD) * 50);
        } else if (score < -CONFIG.SIGNAL_THRESHOLD) {
            signal = 'UNDER';
            strength = Math.min(100, (Math.abs(score) / CONFIG.SIGNAL_THRESHOLD) * 50);
        }

        // Frequency analysis
        const freq = new Array(10).fill(0);
        digits.forEach(d => freq[d]++);
        const hiDigits = freq.slice(5).reduce((a, b) => a + b, 0);
        const loDigits = freq.slice(0, 5).reduce((a, b) => a + b, 0);

        if (signal === 'OVER' && hiDigits > loDigits) strength = Math.min(100, strength * 1.35);
        else if (signal === 'UNDER' && loDigits > hiDigits) strength = Math.min(100, strength * 1.35);

        // Variance filter
        const mean = digits.reduce((a, b) => a + b, 0) / digits.length;
        const variance = digits.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / digits.length;
        if (variance > 8.5) strength *= 0.6;

        // Streak detection bonus
        const streakBonus = this.detectStreak(digits);
        strength = Math.min(100, strength + streakBonus);

        // Dynamic barrier selection
        const barrier = this.selectBarrier(signal, freq, digits);

        return {
            signal,
            strength: Math.round(strength),
            score: Math.round(score * 100) / 100,
            rawScore: Math.round(rawScore * 100) / 100,
            memBoost: Math.round(memBoost * 100) / 100,
            digits, diffs,
            trend: Math.round(trend * 100) / 100,
            avgDiff: Math.round(avgDiff * 100) / 100,
            freq, hiDigits, loDigits,
            variance: Math.round(variance * 100) / 100,
            barrier,
        };
    },

    patternMemoryBoost(currentDigits) {
        if (S.allDigits.length < 50) return 0;
        const pattern = currentDigits.slice(-4);
        const history = S.allDigits.slice(-CONFIG.PATTERN_MEMORY_SIZE);
        let matches = 0, afterSum = 0;

        for (let i = 0; i < history.length - 4; i++) {
            let match = true;
            for (let j = 0; j < 4; j++) {
                if (history[i + j] !== pattern[j]) { match = false; break; }
            }
            if (match && i + 4 < history.length) {
                matches++;
                afterSum += history[i + 4];
            }
        }

        if (matches < 2) return 0;
        return (afterSum / matches - 4.5) * 0.8;
    },

    detectStreak(digits) {
        let streak = 0;
        const last = digits[digits.length - 1];
        for (let i = digits.length - 2; i >= 0; i--) {
            if ((digits[i] >= 5) === (last >= 5)) streak++;
            else break;
        }
        return streak >= 4 ? streak * 2 : 0;
    },

    selectBarrier(signal, freq, digits) {
        const lastDigit = digits[digits.length - 1];
        let maxFreq = -1, maxDigit = 0;
        for (let i = 0; i < 10; i++) {
            if (freq[i] > maxFreq) { maxFreq = freq[i]; maxDigit = i; }
        }

        const candidates = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(d => d !== lastDigit);
        let bestBarrier = 4, bestScore = -Infinity;

        for (const c of candidates) {
            let s = 0;
            if (c === maxDigit) s += 2;
            if (Math.abs(c - lastDigit) >= 3) s += 1.5;
            s += freq[c] * 0.3;

            // Pattern memory: check which barrier had highest differ success
            const memScore = this.barrierMemoryScore(c);
            s += memScore;

            if (s > bestScore) { bestScore = s; bestBarrier = c; }
        }

        S.barrier = bestBarrier;
        return bestBarrier;
    },

    barrierMemoryScore(barrier) {
        if (S.allDigits.length < 30) return 0;
        const last30 = S.allDigits.slice(-30);
        let differs = 0;
        for (const d of last30) {
            if (d !== barrier) differs++;
        }
        return (differs / last30.length - 0.5) * 2;
    },
};

// ============================================================================
// SESSION FILTER
// ============================================================================
function isSessionActive() {
    if (CONFIG.SESSION_FILTER === 'all') return true;
    const h = new Date().getUTCHours();
    switch (CONFIG.SESSION_FILTER) {
        case 'active': return (h >= 6 && h <= 11) || (h >= 13 && h <= 20);
        case 'london': return h >= 7 && h <= 16;
        case 'newyork': return h >= 13 && h <= 21;
        default: return true;
    }
}

function getSessionName() {
    const h = new Date().getUTCHours();
    if (h >= 0 && h < 6) return 'ASIA';
    if (h >= 6 && h < 12) return 'LONDON';
    if (h >= 12 && h < 18) return 'NEW YORK';
    return 'LATE SESSION';
}

// ============================================================================
// DISPLAY ENGINE
// ============================================================================
const Display = {
    clear() { process.stdout.write('\x1b[2J\x1b[H'); },

    render(analysis, fibCheck) {
        // Throttle to max 2 renders per second
        const now = Date.now();
        if (now - S.lastRender < 500) return;
        S.lastRender = now;

        this.clear();

        const runtime = this.formatTime(Math.floor((now - S.sessionStart) / 1000));
        const profitPct = S.startBalance > 0 ? ((S.totalProfit / S.startBalance) * 100) : 0;
        const winRate = S.trades > 0 ? ((S.wins / S.trades) * 100) : 0;

        // Header
        // console.log(`${X.BGGLD}${X.B}${X.WHT}                                                                          ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}   ███████╗██╗██████╗  ██████╗     ██████╗ ██████╗  ██████╗               ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}   ██╔════╝██║██╔══██╗██╔═══██╗    ██╔══██╗██╔══██╗██╔═══██╗              ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}   █████╗  ██║██████╔╝██║   ██║    ██████╔╝██████╔╝██║   ██║              ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}   ██╔══╝  ██║██╔══██╗██║   ██║    ██╔═══╝ ██╔══██╗██║   ██║              ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}   ██║     ██║██████╔╝╚██████╔╝    ██║     ██║  ██║╚██████╔╝   V75 2025  ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}   ╚═╝     ╚═╝╚═════╝  ╚═════╝     ╚═╝     ╚═╝  ╚═╝ ╚═════╝   $2500    ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}                                                                          ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}     ★ PREMIUM · Triple Fibonacci · Adaptive MG · Pattern Memory ★        ${X.R}`);
        // console.log(`${X.BGGLD}${X.B}${X.WHT}                                                                          ${X.R}`);
        // console.log('');

        // Mode indicator
        const modeColor = S.isRecovery ? X.RED : X.GRN;
        const modeText = S.isRecovery ? '⚠ RECOVERY MODE' : '● NORMAL MODE';
        const sessionName = getSessionName();
        const sessionActive = isSessionActive();
        const sessionColor = sessionActive ? X.GRN : X.RED;

        console.log(`  ${modeColor}${X.B}${modeText}${X.R}  │  ${X.GRY}Runtime: ${X.YLW}${runtime}${X.R}  │  ${X.GRY}Session: ${sessionColor}${sessionName}${X.R}  │  ${X.GRY}Symbol: ${X.CYN}${CONFIG.SYMBOL}${X.R}`);
        console.log('');

        // ═══════════ ACCOUNT OVERVIEW ═══════════
        const pc = S.totalProfit >= 0 ? X.GRN : X.RED;
        const bc = S.balance >= S.startBalance ? X.GRN : X.RED;

        console.log(`${X.CYN}${X.B}  ╔══════════════════════════════════════════════════════════════════════════╗${X.R}`);
        console.log(`${X.CYN}  ║${X.WHT}  ACCOUNT                                                                  ${X.CYN}║${X.R}`);
        console.log(`${X.CYN}  ╠══════════════════════════════════════════════════════════════════════════╣${X.R}`);
        console.log(`${X.CYN}  ║${X.WHT}  Balance: ${bc}$${S.balance.toFixed(2).padEnd(12)}${X.WHT} Profit: ${pc}${(S.totalProfit >= 0 ? '+' : '')}$${S.totalProfit.toFixed(2).padEnd(12)}${X.WHT} P&L: ${pc}${(profitPct >= 0 ? '+' : '')}${profitPct.toFixed(2)}%       ${X.CYN}║${X.R}`);
        console.log(`${X.CYN}  ║${X.WHT}  Start:   ${X.YLW}$${S.startBalance.toFixed(2).padEnd(12)}${X.WHT} Trades: ${X.YLW}${String(S.trades).padEnd(12)}${X.WHT} WR:  ${X.YLW}${winRate.toFixed(1)}%          ${X.CYN}║${X.R}`);
        console.log(`${X.CYN}  ║${X.WHT}  Wins:    ${X.GRN}${String(S.wins).padEnd(12)}${X.WHT} Losses: ${X.RED}${String(S.losses).padEnd(12)}${X.WHT} DD:  ${X.RED}$${S.maxDrawdown.toFixed(2).padEnd(10)}    ${X.CYN}║${X.R}`);
        console.log(`${X.CYN}  ║${X.WHT}  Streak:  ${X.GRN}W:${S.consecWins} ${X.RED}L:${S.consecLosses}${X.WHT}       Best: ${X.YLW}${S.bestStreak} wins     ${X.WHT} Compound: ${X.YLW}$${S.compoundedBase.toFixed(2)}     ${X.CYN}║${X.R}`);
        console.log(`${X.CYN}  ╚══════════════════════════════════════════════════════════════════════════╝${X.R}`);
        console.log('');

        // ═══════════ LIVE PRICE ═══════════
        const priceStr = S.lastPrice.toFixed(4);
        const digit = priceStr[priceStr.length - 1];
        const priceColor = S.lastPrice >= S.prevPrice ? X.GRN : X.RED;
        const digitColor = parseInt(digit) >= 5 ? X.GRN : X.RED;

        console.log(`  ${X.GRY}LIVE PRICE:  ${priceColor}${X.B}${priceStr.slice(0, -1)}${X.R}${X.B}[${digitColor}${digit}${X.WHT}]${X.R}    ${X.GRY}Last Digit: ${digitColor}${X.B}${digit}${X.R}`);
        console.log('');

        // ═══════════ TRIPLE FIBONACCI ═══════════
        // console.log(`${X.BLU}${X.B}  ╔══════════════════════════════════════════════════════════════════════════╗${X.R}`);
        // console.log(`${X.BLU}  ║${X.WHT}  📐 TRIPLE FIBONACCI CONFLUENCE (M1 + M5 + M15)                          ${X.BLU}║${X.R}`);
        // console.log(`${X.BLU}  ╠══════════════════════════════════════════════════════════════════════════╣${X.R}`);

        if (S.fibM1) {
            const trend = S.fibM1.up ? `${X.GRN}📈 UPTREND` : `${X.RED}📉 DOWNTREND`;
            console.log(`${X.BLU}  ║${X.WHT}  M1 Swing: ${X.GRN}H:${S.fibM1.hh.toFixed(2)}${X.WHT}  ${X.RED}L:${S.fibM1.ll.toFixed(2)}${X.WHT}  Range:${X.YLW}${S.fibM1.range.toFixed(2)}${X.WHT}  ${trend}${X.WHT}            ${X.BLU}║${X.R}`);

            const entryLevels = ['61.8%', '78.6%', '88.6%'];
            const tpLevels = ['161.8%', '261.8%'];
            const displayOrder = ['23.6%', '38.2%', '50.0%', '61.8%', '78.6%', '88.6%', '161.8%', '261.8%'];

            for (const name of displayOrder) {
                const p1 = S.fibM1.levels[name];
                if (p1 === undefined) continue;

                let tag = '       ';
                let color = X.WHT;
                if (entryLevels.includes(name)) { tag = `${X.YLW}⬅ENTRY `; color = X.YLW; }
                else if (tpLevels.includes(name)) { tag = `${X.GRN}⬅TP    `; color = X.GRN; }

                // Check M5/M15 confluence
                let tfMarkers = '';
                if (S.fibM5) {
                    const p5 = S.fibM5.levels[name];
                    if (p5 !== undefined && Math.abs(p1 - p5) / 0.01 < 20) tfMarkers += `${X.CYN}[M5]`;
                }
                if (S.fibM15) {
                    const p15 = S.fibM15.levels[name];
                    if (p15 !== undefined && Math.abs(p1 - p15) / 0.01 < 30) tfMarkers += `${X.MAG}[M15]`;
                }

                const line = `${X.BLU}  ║  ${color}  ${name.padEnd(8)} = ${p1.toFixed(4).padEnd(14)} ${tag}${tfMarkers}`;
                console.log(`${line.padEnd(95)}${X.BLU}║${X.R}`);
            }

            // TF Confluence Scores
            // console.log(`${X.BLU}  ╠──────────────────────────────────────────────────────────────────────────╣${X.R}`);
            const m1s = S.tfScores.M1.toFixed(0).padStart(3);
            const m5s = S.tfScores.M5.toFixed(0).padStart(3);
            const m15s = S.tfScores.M15.toFixed(0).padStart(3);
            const m1c = S.tfScores.M1 >= 50 ? X.GRN : X.RED;
            const m5c = S.tfScores.M5 >= 50 ? X.GRN : X.RED;
            const m15c = S.tfScores.M15 >= 50 ? X.GRN : X.RED;
            // console.log(`${X.BLU}  ║${X.WHT}  TF Scores: M1:${m1c}${m1s}%${X.WHT}  M5:${m5c}${m5s}%${X.WHT}  M15:${m15c}${m15s}%${X.WHT}                                    ${X.BLU}║${X.R}`);

            // Proximity
            if (fibCheck) {
                const pxColor = fibCheck.confluent ? X.GRN : X.RED;
                const pxIcon = fibCheck.confluent ? '✅' : '❌';
                let pxText = `${pxIcon} ${fibCheck.nearestLevel || '--'} (${(fibCheck.nearestDist || 0).toFixed(1)}p) [${fibCheck.nearestTF || '--'}]`;
                if (fibCheck.tripleConfluent) pxText = `🔥 TRIPLE CONFLUENCE! ${pxText}`;
                else pxText += ` | ${fibCheck.count}/3 TFs`;
                // console.log(`${X.BLU}  ║  ${pxColor}  ${pxText.padEnd(72)}${X.BLU}║${X.R}`);
            }
        } else {
            // console.log(`${X.BLU}  ║${X.YLW}  ⏳ Loading candle data...                                                ${X.BLU}║${X.R}`);
        }
        // console.log(`${X.BLU}  ╚══════════════════════════════════════════════════════════════════════════╝${X.R}`);
        // console.log('');

        // ═══════════ DIGIT DIFFER ENGINE ═══════════
        console.log(`${X.MAG}${X.B}  ╔══════════════════════════════════════════════════════════════════════════╗${X.R}`);
        console.log(`${X.MAG}  ║${X.WHT}  🧠 DIGIT DIFFER ENGINE (500-Tick Pattern Memory)                         ${X.MAG}║${X.R}`);
        console.log(`${X.MAG}  ╠══════════════════════════════════════════════════════════════════════════╣${X.R}`);

        if (analysis) {
            // Digits
            const digitStr = analysis.digits.map((d, i) => {
                const c = d >= 5 ? X.GRN : X.RED;
                const marker = i === analysis.digits.length - 1 ? `${X.B}` : '';
                return `${c}${marker}${d}${X.R}`;
            }).join(' ');
            console.log(`${X.MAG}  ║${X.WHT}  Digits:  [${digitStr}${X.WHT}]                                     ${X.MAG}║${X.R}`);

            // Diffs
            const diffStr = analysis.diffs.map(d => {
                const c = d > 0 ? X.GRN : d < 0 ? X.RED : X.GRY;
                return `${c}${d > 0 ? '+' : ''}${d}${X.R}`;
            }).join(' ');
            console.log(`${X.MAG}  ║${X.WHT}  Diffs:   [${diffStr}${X.WHT}]                                        ${X.MAG}║${X.R}`);

            // Scores
            const scoreColor = analysis.score > 0 ? X.GRN : analysis.score < 0 ? X.RED : X.YLW;
            console.log(`${X.MAG}  ║${X.WHT}  Score: ${scoreColor}${X.B}${analysis.score.toFixed(2).padEnd(8)}${X.R}${X.WHT} Raw:${X.YLW}${analysis.rawScore.toFixed(2).padEnd(8)}${X.WHT} Mem:${X.CYN}${analysis.memBoost.toFixed(2).padEnd(8)}${X.WHT} Var:${X.YLW}${analysis.variance}     ${X.MAG}║${X.R}`);
            console.log(`${X.MAG}  ║${X.WHT}  Trend: ${X.YLW}${analysis.trend.toFixed(2).padEnd(8)}${X.WHT} AvgDiff:${X.YLW}${analysis.avgDiff.toFixed(2).padEnd(6)}${X.WHT} Hi:${X.GRN}${analysis.hiDigits}${X.WHT} Lo:${X.RED}${analysis.loDigits}${X.WHT}  Threshold:±${CONFIG.SIGNAL_THRESHOLD}  ${X.MAG}║${X.R}`);

            // Signal
            console.log(`${X.MAG}  ╠──────────────────────────────────────────────────────────────────────────╣${X.R}`);
            const sigColor = analysis.signal === 'OVER' ? X.GRN :
                analysis.signal === 'UNDER' ? X.RED : X.YLW;
            const strLabel = analysis.strength >= 70 ? `${X.GRN}STRONG` :
                analysis.strength >= 40 ? `${X.YLW}MEDIUM` : `${X.RED}WEAK`;

            console.log(`${X.MAG}  ║${X.WHT}  🎯 SIGNAL: ${sigColor}${X.B}${(analysis.signal || 'SCANNING').padEnd(10)}${X.R}${X.WHT} Strength: ${strLabel} (${analysis.strength}%)${X.R}${X.WHT}                   ${X.MAG}║${X.R}`);
            console.log(`${X.MAG}  ║${X.WHT}  🎲 BARRIER: ${X.YLW}${X.B}${analysis.barrier}${X.R}${X.WHT}  (Dynamic Select — Digit Differ from barrier)                ${X.MAG}║${X.R}`);

            // Digit frequency bar
            const maxFreq = Math.max(...analysis.freq, 1);
            let freqLine = '  Freq: ';
            for (let i = 0; i < 10; i++) {
                const bars = Math.round((analysis.freq[i] / maxFreq) * 5);
                const barStr = '█'.repeat(bars) + '░'.repeat(5 - bars);
                const c = i >= 5 ? X.GRN : X.RED;
                freqLine += `${c}${i}:${barStr} ${X.R}`;
            }
            console.log(`${X.MAG}  ║${freqLine}${X.MAG}║${X.R}`);

            // Pattern memory stats
            const memCount = S.allDigits.length;
            console.log(`${X.MAG}  ║${X.WHT}  Memory: ${X.CYN}${memCount}/${CONFIG.PATTERN_MEMORY_SIZE}${X.WHT} ticks stored | Pattern boost: ${X.CYN}${analysis.memBoost.toFixed(2)}${X.WHT}                     ${X.MAG}║${X.R}`);
        } else {
            console.log(`${X.MAG}  ║${X.YLW}  ⏳ Collecting ticks (${S.ticks.length}/${CONFIG.TICK_HISTORY_SIZE})...                                   ${X.MAG}║${X.R}`);
        }
        console.log(`${X.MAG}  ╚══════════════════════════════════════════════════════════════════════════╝${X.R}`);
        console.log('');

        // ═══════════ ADAPTIVE MARTINGALE ═══════════
        const mgColor = S.mgStep === 0 ? X.GRN :
            S.mgStep <= 3 ? X.YLW :
                S.mgStep <= 5 ? `${X.RED}` :
                    `${X.BGRED}${X.WHT}`;

        // console.log(`${X.RED}${X.B}  ╔══════════════════════════════════════════════════════════════════════════╗${X.R}`);
        // console.log(`${X.RED}  ║${X.WHT}  💣 ADAPTIVE MARTINGALE${S.isRecovery ? `  ${X.RED}${X.B}[RECOVERY MODE]` : ''}                                         ${X.RED}║${X.R}`);
        // console.log(`${X.RED}  ╠══════════════════════════════════════════════════════════════════════════╣${X.R}`);

        // Visual step bar
        let stepBar = '  [';
        for (let i = 0; i < CONFIG.MG_MAX_STEPS; i++) {
            if (i < S.mgStep) {
                stepBar += i >= 6 ? `${X.RED}█` : S.isRecovery ? `${X.BLU}█` : `${X.YLW}█`;
            } else {
                stepBar += `${X.GRY}░`;
            }
        }
        stepBar += `${X.R}]`;
        // console.log(`${X.RED}  ║${X.WHT}${stepBar}  Step: ${mgColor}${X.B}${S.mgStep}/${CONFIG.MG_MAX_STEPS}${X.R}${X.WHT}                                          ${X.RED}║${X.R}`);

        const currentMult = CONFIG.MG_MULTIPLIER + (S.consecLosses > CONFIG.MG_ADAPTIVE_BOOST_AFTER ? CONFIG.MG_ADAPTIVE_BOOST_AMOUNT : 0);
        // console.log(`${X.RED}  ║${X.WHT}  Stake: ${X.YLW}$${S.stake.toFixed(2).padEnd(10)}${X.WHT} Base: ${X.GRN}$${S.compoundedBase.toFixed(2).padEnd(10)}${X.WHT} Mult: ${X.YLW}×${currentMult.toFixed(1)}${S.consecLosses > CONFIG.MG_ADAPTIVE_BOOST_AFTER ? `${X.RED}+${CONFIG.MG_ADAPTIVE_BOOST_AMOUNT}` : ''}      ${X.RED}║${X.R}`);

        // Escalation preview
        // console.log(`${X.RED}  ╠──────────────────────────────────────────────────────────────────────────╣${X.R}`);
        const base = S.isRecovery ? S.compoundedBase / CONFIG.RECOVERY_STAKE_DIVISOR : S.compoundedBase;
        // for (let i = 0; i <= Math.min(CONFIG.MG_MAX_STEPS, 8); i++) {
        //     const st = base * Math.pow(currentMult, i);
        //     const sc = i === 0 ? X.GRN : i <= 3 ? X.YLW : i <= 5 ? `${X.RED}` : `${X.B}${X.RED}`;
        //     const arrow = i === S.mgStep ? ` ${X.WHT}◀ CURRENT` : '';
        //     console.log(`${X.RED}  ║${X.WHT}    Step ${i}: ${sc}$${st.toFixed(2).padEnd(14)}${arrow}${X.R}${''.padEnd(50 - (arrow ? 17 : 0))}${X.RED}║${X.R}`);
        // }

        if (S.isPaused) {
            const remainMs = S.pauseUntil - Date.now();
            const remainSec = Math.max(0, Math.ceil(remainMs / 1000));
            console.log(`${X.RED}  ║${X.BGRED}${X.WHT}${X.B}  ⚠️  PAUSED — ${remainSec}s remaining → Recovery Mode                         ${X.R}${X.RED}║${X.R}`);
        }
        console.log(`${X.RED}  ╚══════════════════════════════════════════════════════════════════════════╝${X.R}`);
        console.log('');

        // ═══════════ STATUS & LAST TRADES ═══════════
        const statusIcon = S.awaitingResult ? `${X.YLW}⏳ AWAITING RESULT` :
            S.isPaused ? `${X.RED}⏸  PAUSED` :
                S.isManualPause ? `${X.YLW}⏸  MANUAL PAUSE` :
                    S.isTrading ? `${X.CYN}🔄 TRADING` :
                        !isSessionActive() ? `${X.RED}🕐 SESSION INACTIVE` :
                            `${X.GRN}👁  SCANNING`;

        console.log(`  ${X.WHT}Status: ${statusIcon}${X.R}`);
        console.log('');

        // Last trades
        if (S.tradeLog.length > 0) {
            console.log(`${X.GRY}  ┌─────────┬────────┬──────────┬───────┬────────────┬────────────────────┐${X.R}`);
            console.log(`${X.GRY}  │ Time    │ Result │ Barrier  │ MG    │ Stake      │ P&L                │${X.R}`);
            console.log(`${X.GRY}  ├─────────┼────────┼──────────┼───────┼────────────┼────────────────────┤${X.R}`);

            const last8 = S.tradeLog.slice(-8);
            for (const t of last8) {
                const rc = t.result === 'WIN' ? X.GRN : X.RED;
                const pnlStr = `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`;
                console.log(`${X.GRY}  │${X.WHT} ${t.time.padEnd(8)}${X.GRY}│ ${rc}${X.B}${t.result.padEnd(7)}${X.R}${X.GRY}│${X.YLW} B:${String(t.barrier).padEnd(7)}${X.GRY}│${X.WHT} ${String(t.mgStep).padEnd(6)}${X.GRY}│${X.WHT} $${t.stake.toFixed(2).padEnd(9)}${X.GRY}│ ${rc}${pnlStr.padEnd(19)}${X.GRY}│${X.R}`);
            }
            console.log(`${X.GRY}  └─────────┴────────┴──────────┴───────┴────────────┴────────────────────┘${X.R}`);
        }
    },

    formatTime(sec) {
        const h = String(Math.floor(sec / 3600)).padStart(2, '0');
        const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        return `${h}:${m}:${s}`;
    },
};

// ============================================================================
// BOT ENGINE
// ============================================================================
class FiboProBot {
    constructor() {
        this.ws = null;
    }

    nextId() { return ++S.rid; }

    send(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }

    connect() {
        console.log(`${X.CYN}Connecting to Deriv WebSocket API...${X.R}`);

        this.ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${CONFIG.APP_ID}`);
        S.ws = this.ws;

        this.ws.on('open', () => {
            console.log(`${X.GRN}✅ Connected${X.R}`);
            this.send({ authorize: CONFIG.TOKEN, req_id: this.nextId() });
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(msg);
            } catch (e) {
                console.error(`${X.RED}Parse error: ${e.message}${X.R}`);
            }
        });

        this.ws.on('close', () => {
            console.log(`${X.RED}❌ Disconnected. Reconnecting in 5s...${X.R}`);
            if (S.authorized) setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            console.error(`${X.RED}WS Error: ${err.message}${X.R}`);
        });
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error(`${X.RED}API Error: ${msg.error.message}${X.R}`);
            if (msg.error.code === 'InvalidToken') {
                console.error(`${X.BGRED}${X.WHT}${X.B} INVALID TOKEN — Update CONFIG.TOKEN ${X.R}`);
                process.exit(1);
            }
            if (msg.msg_type === 'buy') {
                S.isTrading = false;
                S.awaitingResult = false;
            }
            return;
        }

        switch (msg.msg_type) {
            case 'authorize': this.onAuthorized(msg.authorize); break;
            case 'balance': this.onBalance(msg.balance); break;
            case 'tick': this.onTick(msg.tick); break;
            case 'candles': this.onCandles(msg); break;
            case 'history': this.onHistory(msg.history); break;
            case 'buy': this.onBuy(msg.buy); break;
            case 'proposal_open_contract': this.onContract(msg.proposal_open_contract); break;
            case 'transaction':
                if (msg.transaction && msg.transaction.balance) {
                    S.balance = parseFloat(msg.transaction.balance);
                }
                break;
        }
    }

    // ── AUTHORIZED ──
    onAuthorized(data) {
        S.authorized = true;
        S.balance = parseFloat(data.balance);
        S.startBalance = S.balance;
        S.peakBalance = S.balance;

        console.log(`${X.GRN}✅ Authorized: ${data.fullname} | Balance: $${S.balance.toFixed(2)}${X.R}`);

        // Subscriptions
        this.send({ balance: 1, subscribe: 1, req_id: this.nextId() });
        this.send({ transaction: 1, subscribe: 1, req_id: this.nextId() });
        this.send({ ticks: CONFIG.SYMBOL, subscribe: 1, req_id: this.nextId() });
        this.send({
            ticks_history: CONFIG.SYMBOL,
            count: CONFIG.TICK_HISTORY_SIZE + 10,
            end: 'latest', style: 'ticks',
            req_id: this.nextId(),
        });

        // Triple Fibonacci candles
        this.requestCandles(60, 'M1');
        this.requestCandles(300, 'M5');
        this.requestCandles(900, 'M15');

        // Refresh candles every 60s
        setInterval(() => {
            this.requestCandles(60, 'M1');
            this.requestCandles(300, 'M5');
            this.requestCandles(900, 'M15');
        }, 60000);
    }

    requestCandles(granularity, label) {
        this.send({
            ticks_history: CONFIG.SYMBOL,
            adjust_start_time: 1,
            count: CONFIG.CANDLE_COUNT,
            end: 'latest',
            granularity: granularity,
            style: 'candles',
            req_id: this.nextId(),
            passthrough: { tf: label },
        });
    }

    // ── CANDLES ──
    onCandles(msg) {
        const tf = msg.passthrough?.tf || 'M1';
        const candles = msg.candles;

        if (tf === 'M1') { S.candlesM1 = candles; S.fibM1 = FibEngine.calculate(candles); S.candlesLoaded.M1 = true; }
        else if (tf === 'M5') { S.candlesM5 = candles; S.fibM5 = FibEngine.calculate(candles); S.candlesLoaded.M5 = true; }
        else if (tf === 'M15') { S.candlesM15 = candles; S.fibM15 = FibEngine.calculate(candles); S.candlesLoaded.M15 = true; }

        if (S.fibM1) {
            console.log(`${X.GRN}✅ ${tf} Fibonacci calculated (${candles.length} candles)${X.R}`);
        }
    }

    // ── TICK HISTORY ──
    onHistory(history) {
        if (history && history.prices) {
            S.ticks = history.prices.map(p => parseFloat(p)).slice(-CONFIG.TICK_HISTORY_SIZE);
            history.prices.forEach(p => {
                const d = parseInt(String(p).slice(-1), 10);
                S.allDigits.push(d);
            });
        }
    }

    // ── BALANCE ──
    onBalance(data) {
        S.balance = parseFloat(data.balance);
        if (S.balance > S.peakBalance) S.peakBalance = S.balance;
        const dd = S.peakBalance - S.balance;
        if (dd > S.maxDrawdown) S.maxDrawdown = dd;

        // Auto compound
        if (CONFIG.COMPOUND_PERCENT > 0 && S.balance > S.startBalance) {
            S.compoundedBase = CONFIG.BASE_STAKE + (S.balance - S.startBalance) * (CONFIG.COMPOUND_PERCENT / 100) * 0.01;
            S.compoundedBase = Math.round(S.compoundedBase * 100) / 100;
            if (S.compoundedBase < CONFIG.BASE_STAKE) S.compoundedBase = CONFIG.BASE_STAKE;
        }

        // TP/SL
        if (CONFIG.TAKE_PROFIT > 0 && S.totalProfit >= CONFIG.TAKE_PROFIT) {
            S.isManualPause = true;
            console.log(`${X.BGGRN}${X.WHT}${X.B} 🎯 TAKE PROFIT HIT: $${S.totalProfit.toFixed(2)} ≥ $${CONFIG.TAKE_PROFIT} — BOT PAUSED ${X.R}`);
        }
        if (CONFIG.STOP_LOSS > 0 && S.totalProfit <= -CONFIG.STOP_LOSS) {
            S.isManualPause = true;
            console.log(`${X.BGRED}${X.WHT}${X.B} 🛑 STOP LOSS HIT: $${S.totalProfit.toFixed(2)} ≤ -$${CONFIG.STOP_LOSS} — BOT PAUSED ${X.R}`);
        }
    }

    // ── TICK ──
    onTick(tick) {
        const price = parseFloat(tick.quote);
        S.prevPrice = S.lastPrice;
        S.lastPrice = price;
        S.lastTickTime = Date.now();

        // Update tick history
        S.ticks.push(price);
        if (S.ticks.length > CONFIG.TICK_HISTORY_SIZE + 30) {
            S.ticks = S.ticks.slice(-CONFIG.TICK_HISTORY_SIZE - 10);
        }

        // Update digit memory
        const digit = parseInt(String(price).slice(-1), 10);
        S.allDigits.push(digit);
        if (S.allDigits.length > CONFIG.PATTERN_MEMORY_SIZE + 50) {
            S.allDigits = S.allDigits.slice(-CONFIG.PATTERN_MEMORY_SIZE - 10);
        }

        // Analysis
        const analysis = S.ticks.length >= CONFIG.TICK_HISTORY_SIZE ? DigitEngine.analyze() : null;
        const fibCheck = S.fibM1 ? FibEngine.checkTripleConfluence(price) : null;

        // Render
        Display.render(analysis, fibCheck);

        // Check pause expiry
        if (S.isPaused && Date.now() >= S.pauseUntil) {
            S.isPaused = false;
            S.isRecovery = true;
            S.stake = Math.max(0.35, S.compoundedBase / CONFIG.RECOVERY_STAKE_DIVISOR);
            S.mgStep = 0;
            S.consecLosses = 0;
            console.log(`${X.BLU}${X.B}🔄 ENTERING RECOVERY MODE — Stake: $${S.stake.toFixed(2)} (base ÷ ${CONFIG.RECOVERY_STAKE_DIVISOR})${X.R}`);
        }

        // Exit recovery after N wins
        if (S.isRecovery && S.consecWins >= CONFIG.RECOVERY_WINS_TO_EXIT) {
            S.isRecovery = false;
            S.stake = S.compoundedBase;
            console.log(`${X.GRN}${X.B}✅ RECOVERY COMPLETE — Back to normal mode${X.R}`);
        }

        // Session check
        const sessionOk = isSessionActive();

        // Trade decision
        if (
            S.authorized &&
            S.ticks.length >= CONFIG.TICK_HISTORY_SIZE &&
            S.candlesLoaded.M1 &&
            !S.isTrading &&
            !S.awaitingResult &&
            !S.isPaused &&
            !S.isManualPause &&
            analysis &&
            analysis.signal !== 'NONE' &&
            fibCheck &&
            fibCheck.confluent &&
            sessionOk
        ) {
            this.executeTrade(analysis);
        }
    }

    // ── EXECUTE TRADE ──
    executeTrade(analysis) {
        S.isTrading = true;
        S.awaitingResult = true;
        S.prediction = analysis.signal;
        S.strength = analysis.strength;

        const barrier = analysis.barrier;

        let stake = S.stake;
        if (S.isRecovery) stake = Math.max(0.35, S.compoundedBase / CONFIG.RECOVERY_STAKE_DIVISOR);
        if (stake > S.balance * 0.90) stake = Math.max(0.35, S.balance * 0.85);

        console.log(`${X.YLW}${X.B}📤 TRADE: DIGITDIFF | Barrier: ${barrier} | Stake: $${stake.toFixed(2)} | MG: ${S.mgStep} | Signal: ${analysis.signal} (${analysis.strength}%) | Score: ${analysis.score}${X.R}`);

        this.send({
            buy: 1,
            subscribe: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: 'stake',
                contract_type: CONFIG.CONTRACT_TYPE,
                currency: 'USD',
                duration: CONFIG.DURATION,
                duration_unit: CONFIG.DURATION_UNIT,
                symbol: CONFIG.SYMBOL,
                barrier: barrier,
            },
            req_id: this.nextId(),
        });
    }

    // ── BUY RESPONSE ──
    onBuy(buy) {
        if (buy && buy.contract_id) {
            console.log(`${X.GRN}✅ Contract #${buy.contract_id} | Cost: $${parseFloat(buy.buy_price).toFixed(2)}${X.R}`);
        } else {
            S.isTrading = false;
            S.awaitingResult = false;
            console.log(`${X.RED}❌ Buy failed${X.R}`);
        }
    }

    // ── CONTRACT RESULT ──
    onContract(poc) {
        if (!poc || !poc.is_sold) return;

        const pnl = parseFloat(poc.profit);
        const isWin = pnl > 0;

        S.trades++;
        S.totalProfit += pnl;
        S.isTrading = false;
        S.awaitingResult = false;
        S.profitHistory.push(S.totalProfit);

        const now = new Date().toLocaleTimeString();

        if (isWin) {
            S.wins++;
            S.consecLosses = 0;
            S.consecWins++;
            if (S.consecWins > S.bestStreak) S.bestStreak = S.consecWins;

            // Reset martingale
            S.mgStep = 0;
            S.stake = S.isRecovery
                ? Math.max(0.35, S.compoundedBase / CONFIG.RECOVERY_STAKE_DIVISOR)
                : S.compoundedBase;

            S.tradeLog.push({
                time: now, result: 'WIN', barrier: S.barrier,
                stake: parseFloat(poc.buy_price), pnl, mgStep: S.mgStep,
            });

            console.log(`${X.BGGRN}${X.WHT}${X.B} ✅ WIN +$${pnl.toFixed(2)} | Total: ${(S.totalProfit >= 0 ? '+' : '')}$${S.totalProfit.toFixed(2)} | Streak: ${S.consecWins} ${X.R}`);

        } else {
            S.losses++;
            S.consecLosses++;
            S.consecWins = 0;
            S.mgStep++;

            S.tradeLog.push({
                time: now, result: 'LOSS', barrier: S.barrier,
                stake: parseFloat(poc.buy_price), pnl, mgStep: S.mgStep,
            });

            console.log(`${X.BGRED}${X.WHT}${X.B} ❌ LOSS -$${Math.abs(pnl).toFixed(2)} | MG: ${S.mgStep}/${CONFIG.MG_MAX_STEPS} | Consec: ${S.consecLosses} ${X.R}`);

            if (S.mgStep >= CONFIG.MG_MAX_STEPS) {
                // MAX MARTINGALE HIT — PAUSE THEN RECOVERY
                S.isPaused = true;
                S.pauseUntil = Date.now() + (CONFIG.RECOVERY_PAUSE_SECONDS * 1000);
                S.mgStep = 0;
                S.stake = S.compoundedBase;
                S.consecLosses = 0;

                console.log('');
                console.log(`${X.BGRED}${X.WHT}${X.B}  ╔══════════════════════════════════════════════════════╗  ${X.R}`);
                console.log(`${X.BGRED}${X.WHT}${X.B}  ║  ⚠️  MAX MARTINGALE HIT                              ║  ${X.R}`);
                console.log(`${X.BGRED}${X.WHT}${X.B}  ║  Pausing ${CONFIG.RECOVERY_PAUSE_SECONDS}s → Recovery Mode                  ║  ${X.R}`);
                console.log(`${X.BGRED}${X.WHT}${X.B}  ║  This is where 41/41 accounts died.                  ║  ${X.R}`);
                console.log(`${X.BGRED}${X.WHT}${X.B}  ╚══════════════════════════════════════════════════════╝  ${X.R}`);
                console.log('');

            } else {
                // Adaptive martingale: increase multiplier after N consecutive losses
                const adaptiveMult = CONFIG.MG_MULTIPLIER +
                    (S.consecLosses > CONFIG.MG_ADAPTIVE_BOOST_AFTER
                        ? CONFIG.MG_ADAPTIVE_BOOST_AMOUNT : 0);

                const base = S.isRecovery
                    ? S.compoundedBase / CONFIG.RECOVERY_STAKE_DIVISOR
                    : S.compoundedBase;

                S.stake = base * Math.pow(adaptiveMult, S.mgStep);
                S.stake = Math.round(S.stake * 100) / 100;

                // Cap at 95% of balance
                if (S.stake > S.balance * 0.95) {
                    S.stake = Math.max(0.35, S.balance * 0.90);
                    console.log(`${X.RED}⚠ Stake capped to 90% of balance: $${S.stake.toFixed(2)}${X.R}`);
                }

                console.log(`${X.YLW}📈 MG Step ${S.mgStep}: Next stake = $${S.stake.toFixed(2)} (×${adaptiveMult.toFixed(1)})${X.R}`);
            }
        }
    }

    // ── START ──
    start() {
        console.log('');
        console.log(`${X.BGRED}${X.WHT}${X.B}                                                                    ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  FIBO PRO V75 2025 — $2500 PREMIUM EDITION                    ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  TRIPLE FIBONACCI + ADAPTIVE ×4.2 MARTINGALE                  ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  500-TICK PATTERN MEMORY + DYNAMIC BARRIER                    ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  AUTO COMPOUND + RECOVERY MODE                               ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  THIS WILL DESTROY YOUR ACCOUNT IN 14-45 DAYS                ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  41/41 TRACKED ACCOUNTS WIPED OUT                            ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}   ⚠️  LAUNCHING IN 5 SECONDS...                                   ${X.R}`);
        console.log(`${X.BGRED}${X.WHT}${X.B}                                                                    ${X.R}`);
        console.log('');

        console.log(`${X.YLW}Configuration:${X.R}`);
        console.log(`${X.GRY}  Symbol:          ${X.CYN}${CONFIG.SYMBOL}${X.R}`);
        console.log(`${X.GRY}  Base Stake:      ${X.GRN}$${CONFIG.BASE_STAKE}${X.R}`);
        console.log(`${X.GRY}  MG Multiplier:   ${X.YLW}×${CONFIG.MG_MULTIPLIER} (adaptive +${CONFIG.MG_ADAPTIVE_BOOST_AMOUNT} after ${CONFIG.MG_ADAPTIVE_BOOST_AFTER} losses)${X.R}`);
        console.log(`${X.GRY}  MG Max Steps:    ${X.RED}${CONFIG.MG_MAX_STEPS}${X.R}`);
        console.log(`${X.GRY}  Compound:        ${X.YLW}${CONFIG.COMPOUND_PERCENT}%${X.R}`);
        console.log(`${X.GRY}  Session Filter:  ${X.CYN}${CONFIG.SESSION_FILTER}${X.R}`);
        console.log(`${X.GRY}  Recovery Pause:  ${X.YLW}${CONFIG.RECOVERY_PAUSE_SECONDS}s${X.R}`);
        console.log(`${X.GRY}  Pattern Memory:  ${X.CYN}${CONFIG.PATTERN_MEMORY_SIZE} ticks${X.R}`);
        console.log(`${X.GRY}  Triple Fib:      ${X.MAG}M1 + M5 + M15${X.R}`);
        console.log(`${X.GRY}  Take Profit:     ${CONFIG.TAKE_PROFIT > 0 ? `${X.GRN}$${CONFIG.TAKE_PROFIT}` : `${X.GRY}Disabled`}${X.R}`);
        console.log(`${X.GRY}  Stop Loss:       ${CONFIG.STOP_LOSS > 0 ? `${X.RED}$${CONFIG.STOP_LOSS}` : `${X.GRY}Disabled`}${X.R}`);
        console.log('');

        // Escalation table preview
        console.log(`${X.RED}${X.B}  Martingale Escalation:${X.R}`);
        for (let i = 0; i <= CONFIG.MG_MAX_STEPS; i++) {
            const stake = CONFIG.BASE_STAKE * Math.pow(CONFIG.MG_MULTIPLIER, i);
            const c = i === 0 ? X.GRN : i <= 3 ? X.YLW : i <= 5 ? X.RED : `${X.B}${X.RED}`;
            console.log(`${X.GRY}    Step ${i}: ${c}$${stake.toFixed(2)}${X.R}`);
        }
        console.log('');

        setTimeout(() => this.connect(), 5000);
    }
}

// ============================================================================
// LAUNCH
// ============================================================================
const bot = new FiboProBot();
bot.start();