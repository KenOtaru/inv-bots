#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — Single-file Node.js Version
//  Deriv Digit Differ — Advanced Regime Detection Strategy
//
//  Analysis: HMM-inspired regime segmentation + EWMA + Transition Matrix
//            + Non-rep run exhaustion + Composite safety score
//
//  Usage:
//    node romanian-ghost-bot.js --token YOUR_DERIV_API_TOKEN [options]
//    node romanian-ghost-bot.js --help
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

// ── ANSI Colour Helpers ───────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    orange: '\x1b[38;5;208m',
    white: '\x1b[37m',
};

const col = (text, ...codes) => codes.join('') + text + C.reset;
const bold = t => col(t, C.bold);
const dim = t => col(t, C.dim);
const cyan = t => col(t, C.cyan);
const blue = t => col(t, C.blue);
const green = t => col(t, C.green);
const red = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta = t => col(t, C.magenta);

// ── Logger ─────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT: cyan,
    API: blue,
    TICK: dim,
    ANALYSIS: yellow,
    GHOST: magenta,
    TRADE: bold,
    RESULT: bold,
    RISK: red,
    STATS: cyan,
    ERROR: t => col(t, C.bold, C.red),
};

function getTimestamp() {
    const n = new Date();
    return [
        String(n.getHours()).padStart(2, '0'),
        String(n.getMinutes()).padStart(2, '0'),
        String(n.getSeconds()).padStart(2, '0'),
    ].join(':');
}

function log(prefix, message) {
    const ts = dim(`[${getTimestamp()}]`);
    const pfx = (PREFIX_COLOURS[prefix] || (t => t))(`[${prefix}]`);
    console.log(`${ts} ${pfx} ${message}`);
}

const logBot = m => log('BOT', m);
const logApi = m => log('API', m);
const logTick = m => log('TICK', m);
const logAnalysis = m => log('ANALYSIS', m);
const logGhost = m => log('GHOST', m);
const logTrade = m => log('TRADE', m);
const logResult = m => log('RESULT', m);
const logRisk = m => log('RISK', m);
const logStats = m => log('STATS', m);
const logError = m => log('ERROR', m);

// ── Argument Parser ───────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, def) => {
        const i = args.indexOf(flag);
        if (i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1];
        return def;
    };
    const has = flag => args.includes(flag);

    return {
        api_token: '0P94g4WdSrSrzir',
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        symbol: 'R_10',
        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',
        tick_history_size: 5000,
        analysis_window: 25,
        repeat_threshold: 8,
        ghost_enabled: true,
        ghost_wins_required: 2,
        ghost_max_rounds: 20000000000,
        martingale_enabled: true,
        martingale_multiplier: 11.3,
        max_martingale_steps: 3,
        take_profit: 100,
        stop_loss: 70,
        max_stake: 500,
        delay_between_trades: 1500,
        cooldown_after_max_loss: 30000,
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getLastDigit(price, asset) {
    const quoteString = price.toString();
    const parts = quoteString.split('.');
    const fractionalPart = parts.length > 1 ? parts[1] : '';
    if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
        return fractionalPart.length >= 4 ? parseInt(fractionalPart[3], 10) : 0;
    } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
        return fractionalPart.length >= 3 ? parseInt(fractionalPart[2], 10) : 0;
    } else {
        return fractionalPart.length >= 2 ? parseInt(fractionalPart[1], 10) : 0;
    }
}

function formatMoney(v) {
    return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`;
}

function formatDuration(ms) {
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

function medianArr(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avgArr(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── EWMA decay factor ──────────────────────────────────────────────────────────
const EWMA_ALPHA = 0.15;

// ── State Constants ───────────────────────────────────────────────────────────
const STATE = {
    INITIALIZING: 'INITIALIZING',
    CONNECTING: 'CONNECTING',
    AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS',
    ANALYZING: 'ANALYZING',
    GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE',
    WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT',
    COOLDOWN: 'COOLDOWN',
    STOPPED: 'STOPPED',
};

// ── Bot Class ─────────────────────────────────────────────────────────────────
class RomanianGhostBot {
    constructor(config) {
        this.config = config;

        // WebSocket
        this.ws = null;
        this.botState = STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT = 5;
        this.pingInterval = null;
        this.requestId = 0;

        // Account
        this.accountBalance = 0;
        this.startingBalance = 0;
        this.accountId = '';

        // Ticks — sliding window
        this.tickHistory = [];

        // Regime analysis result
        this.regime = null;

        // Signal / Target
        this.targetDigit = -1;
        this.targetRepeatRate = 0;
        this.signalActive = false;

        // Ghost state — TWO-TICK model
        //
        //  Tick A: currentDigit === targetDigit
        //    → If (wins + 1) >= wins_required → fire LIVE trade NOW.
        //    → Else set ghostAwaitingResult = true, wait for Tick B.
        //
        //  Tick B: (immediately after Tick A)
        //    → ghostAwaitingResult = true
        //    → currentDigit !== targetDigit → Ghost WIN (didn't repeat). Wins++.
        //    → currentDigit === targetDigit → Ghost LOSS (repeated). Wins = 0.
        //
        // After LIVE TRADE LOSS → ghostConsecutiveWins = 0, ghostConfirmed = false.
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;

        // Trading
        this.currentStake = config.base_stake;
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.isTradeActive = false;
        this.lastBuyPrice = 0;
        this.lastContractId = null;
        this.pendingTrade = false;

        // Session stats
        this.sessionStartTime = Date.now();
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.sessionProfit = 0;
        this.currentWinStreak = 0;
        this.currentLossStreak = 0;
        this.maxWinStreak = 0;
        this.maxLossStreak = 0;
        this.maxMartingaleReached = 0;
        this.largestWin = 0;
        this.largestLoss = 0;

        this.cooldownTimer = null;

        // Telegram
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    }

    // ── Validation ──────────────────────────────────────────────────────────────
    validate() {
        const errors = [];
        const c = this.config;
        if (!c.api_token)
            errors.push('--token is required. Get one at https://app.deriv.com/account/api-token');
        if (c.base_stake < 0.35)
            errors.push('--stake must be at least 0.35');
        if (c.tick_history_size < 10)
            errors.push('--history must be at least 10');
        if (c.analysis_window < 10)
            errors.push('--window must be at least 10');
        if (c.analysis_window > c.tick_history_size)
            errors.push('--window cannot be larger than --history');
        if (c.repeat_threshold <= 0 || c.repeat_threshold > 100)
            errors.push('--threshold must be between 1 and 100');
        if (c.ghost_enabled && c.ghost_wins_required < 1)
            errors.push('--ghost-wins must be at least 1');
        if (c.take_profit <= 0)
            errors.push('--tp must be positive');
        if (c.stop_loss <= 0)
            errors.push('--sl must be positive');
        return errors;
    }

    // ── Start ───────────────────────────────────────────────────────────────────
    start() {
        const errors = this.validate();
        if (errors.length) {
            errors.forEach(e => logError(e));
            process.exit(1);
        }
        this.printBanner();
        this.connectWS();
    }

    // ── Banner ──────────────────────────────────────────────────────────────────
    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('═══════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT  —  Deriv Digit Differ           ')));
        console.log(bold(cyan('   Advanced Regime Detection Strategy                      ')));
        console.log(bold(cyan('   HMM-inspired + EWMA + Transition Matrix + Safety Score  ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════')));
        console.log(`  Symbol           : ${bold(c.symbol)}`);
        console.log(`  Base Stake       : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Tick History     : ${bold(c.tick_history_size)} ticks`);
        console.log(`  Analysis Window  : ${bold(c.analysis_window)} ticks`);
        console.log(`  Repeat Threshold : ${bold(c.repeat_threshold + '%')} — signal when raw+EWMA < threshold, regime=non-rep, score≥50`);
        console.log(`  Ghost Trading    : ${c.ghost_enabled
            ? green('ON') + ` | Wins Required: ${bold(c.ghost_wins_required)} | Max Rounds: ${c.ghost_max_rounds}`
            : red('OFF')}`);
        console.log(`  Martingale       : ${c.martingale_enabled
            ? green('ON') + ` | Max Steps: ${c.max_martingale_steps} | Multiplier: ${c.martingale_multiplier}x`
            : red('OFF')}`);
        console.log(`  Take Profit      : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss        : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(`  Max Stake        : $${c.max_stake.toFixed(2)}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════')));
        console.log('');

        if (c.martingale_enabled && c.max_martingale_steps >= 1) {
            let risk = 0;
            for (let i = 0; i < c.max_martingale_steps; i++) {
                risk += c.base_stake * Math.pow(c.martingale_multiplier, i);
            }
            logRisk(`⚠️  Martingale worst case: ${c.max_martingale_steps} consecutive losses ≈ ${red('-$' + risk.toFixed(2))}`);
        }

        if (c.ghost_enabled) {
            logBot(`👻 Ghost mode: target digit must appear ${bold(c.ghost_wins_required)} time(s) before LIVE trade.`);
            logBot(`   After any LIVE trade loss → ghost wins reset to 0. Must re-accumulate before next trade.`);
        }
        console.log('');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  ADVANCED REGIME DETECTION ENGINE
    //
    //  Combines four signals into a composite safety score (0-100):
    //
    //  1. TRANSITION PROBABILITY (raw): P(d→d) from full history
    //  2. EWMA REPEAT RATE: exponentially weighted, α=0.15 (~13-tick half-life)
    //     Detects recent regime shifts faster than simple average.
    //  3. REGIME SEGMENTATION: run-length encoding of tick history.
    //     Tracks rep/non-rep run lengths per digit.
    //     Computes P(non-rep→rep) transition probability from regime sequence.
    //  4. NON-REP RUN EXHAUSTION: currentRegimeDuration / avgNonRepRunLen
    //     High exhaustion → non-rep regime may be about to flip → lower safety.
    //
    //  COMPOSITE SAFETY SCORE:
    //    A) Raw repeat prob below threshold:   up to 30 pts
    //    B) EWMA rate below threshold:          up to 30 pts
    //    C) Non-rep run not exhausted:          up to 20 pts
    //    D) Low P(non-rep→rep) flip prob:       up to 20 pts
    //    Hard gates: score=0 if in rep regime OR raw≥threshold OR EWMA≥threshold
    //
    //  SIGNAL CONDITION (ALL must hold):
    //    a) Current regime for digit = 'non-rep'
    //    b) Raw repeat prob < repeat_threshold
    //    c) EWMA rate < repeat_threshold
    //    d) Safety score >= 50
    // ══════════════════════════════════════════════════════════════════════════
    analyzeRegime() {
        const window = this.tickHistory.slice(-this.config.analysis_window);
        const len = window.length;
        if (len < 2) return null;

        const appearances = new Array(10).fill(0);
        const repeatCount = new Array(10).fill(0);
        const transCount = new Array(10).fill(0);
        const ewma = new Array(10).fill(0);
        const ewmaInit = new Array(10).fill(false);

        const repRunLengths = Array.from({ length: 10 }, () => []);
        const nonRepRunLengths = Array.from({ length: 10 }, () => []);
        const regimeSeq = Array.from({ length: 10 }, () => []);

        // ── Pass 1: EWMA + transition counts ────────────────────────────────
        for (let i = 0; i < len; i++) {
            const d = window[i];
            appearances[d]++;
            const isRepeat = i > 0 && window[i] === window[i - 1];

            if (!ewmaInit[d]) {
                ewma[d] = isRepeat ? 100 : 0;
                ewmaInit[d] = true;
            } else {
                ewma[d] = EWMA_ALPHA * (isRepeat ? 100 : 0) + (1 - EWMA_ALPHA) * ewma[d];
            }

            if (i + 1 < len) {
                transCount[d]++;
                if (window[i + 1] === d) repeatCount[d]++;
            }
        }

        // ── Pass 2: Run-length encoding + regime segmentation ───────────────
        let totalRegimeShifts = 0;
        let i = 0;
        while (i < len) {
            const d = window[i];
            let runLen = 1;
            while (i + runLen < len && window[i + runLen] === d) runLen++;

            if (runLen >= 2) {
                repRunLengths[d].push(runLen);
                regimeSeq[d].push({ type: 'rep', len: runLen });
            } else {
                let gapLen = 0;
                let j = i + 1;
                while (j < len && window[j] !== d) { gapLen++; j++; }
                nonRepRunLengths[d].push(gapLen + 1);
                regimeSeq[d].push({ type: 'non-rep', len: gapLen + 1 });
            }
            i += runLen;
        }

        // Count global regime shifts (rep↔non-rep at tick level)
        const tickLabels = new Array(len).fill(0);
        for (let k = 1; k < len; k++) {
            tickLabels[k] = window[k] === window[k - 1] ? 1 : 0;
        }
        for (let k = 1; k < len; k++) {
            if (tickLabels[k] !== tickLabels[k - 1]) totalRegimeShifts++;
        }

        // ── Pass 3: Per-digit statistics ─────────────────────────────────────
        const repeatProb = new Array(10).fill(0);
        const nonRepToRepProb = new Array(10).fill(0);
        const avgNonRepRunLen = new Array(10).fill(0);
        const medNonRepRunLen = new Array(10).fill(0);
        const maxNonRepRunLen = new Array(10).fill(0);
        const currentRegimeArr = new Array(10).fill('non-rep');
        const currentRegimeDur = new Array(10).fill(0);
        const nonRepRunExhaust = new Array(10).fill(0);
        const safetyScore = new Array(10).fill(0);

        const threshold = this.config.repeat_threshold;

        for (let d = 0; d <= 9; d++) {
            repeatProb[d] = transCount[d] > 0 ? (repeatCount[d] / transCount[d]) * 100 : 0;

            const nrLens = nonRepRunLengths[d];
            if (nrLens.length > 0) {
                avgNonRepRunLen[d] = avgArr(nrLens);
                medNonRepRunLen[d] = medianArr(nrLens);
                maxNonRepRunLen[d] = Math.max(...nrLens);
            }

            // P(non-rep → rep)
            const seq = regimeSeq[d];
            let nonRepToRep = 0, nonRepTotal = 0;
            for (let s = 0; s < seq.length - 1; s++) {
                if (seq[s].type === 'non-rep') {
                    nonRepTotal++;
                    if (seq[s + 1].type === 'rep') nonRepToRep++;
                }
            }
            nonRepToRepProb[d] = nonRepTotal > 0 ? (nonRepToRep / nonRepTotal) * 100 : 50;

            // Current regime from tail of regimeSeq
            if (seq.length > 0) {
                const last = seq[seq.length - 1];
                currentRegimeArr[d] = last.type;
                currentRegimeDur[d] = last.len;
            }

            // Non-rep run exhaustion
            const avgLen = avgNonRepRunLen[d] > 0 ? avgNonRepRunLen[d] : 10;
            if (currentRegimeArr[d] === 'non-rep') {
                nonRepRunExhaust[d] = Math.min(100, (currentRegimeDur[d] / avgLen) * 100);
            } else {
                nonRepRunExhaust[d] = 100;
            }

            // ── Composite Safety Score (0–100) ──────────────────────────────
            const rawBelow = repeatProb[d] < threshold;
            const ewmaBelow = ewma[d] < threshold;

            const rawMargin = rawBelow ? Math.min(30, ((threshold - repeatProb[d]) / threshold) * 30) : 0;
            const ewmaMargin = ewmaBelow ? Math.min(30, ((threshold - ewma[d]) / threshold) * 30) : 0;
            const exhaustScore = currentRegimeArr[d] === 'non-rep'
                ? Math.max(0, 20 - (nonRepRunExhaust[d] / 100) * 20)
                : 0;
            const flipScore = Math.max(0, 20 - (nonRepToRepProb[d] / 100) * 20);

            safetyScore[d] = Math.round(rawMargin + ewmaMargin + exhaustScore + flipScore);

            // Hard gates
            if (currentRegimeArr[d] === 'rep' || !rawBelow || !ewmaBelow) {
                safetyScore[d] = 0;
            }
        }

        // ── Tail analysis ────────────────────────────────────────────────────
        let tailLen = 1;
        const tailDig = window[len - 1];
        while (tailLen < len && window[len - 1 - tailLen] === tailDig) tailLen++;
        const tailRegime = tailLen >= 2 ? 'rep' : 'non-rep';

        return {
            repeatProb,
            ewmaRepeatRate: ewma,
            currentRegime: currentRegimeArr,
            currentRegimeDuration: currentRegimeDur,
            nonRepToRepProb,
            avgNonRepRunLen,
            medNonRepRunLen,
            maxNonRepRunLen,
            nonRepRunExhaustion: nonRepRunExhaust,
            safetyScore,
            repRunLengths,
            nonRepRunLengths,
            tailDigit: tailDig,
            tailLength: tailLen,
            tailRegime,
            totalRegimeShifts,
            digitCounts: appearances,
        };
    }

    // ── checkSignal ─────────────────────────────────────────────────────────────
    // ANALYZING: check if currentDigit meets ALL signal conditions.
    checkSignal(currentDigit) {
        this.targetDigit = currentDigit;
        if (!this.regime) { this.signalActive = false; return; }

        const r = this.regime;
        const d = currentDigit;
        this.targetRepeatRate = r.repeatProb[d];

        const inNonRep = r.currentRegime[d] === 'non-rep';
        const rawOk = r.repeatProb[d] < this.config.repeat_threshold;
        const ewmaOk = r.ewmaRepeatRate[d] < this.config.repeat_threshold;
        const safeOk = r.safetyScore[d] >= 50;

        this.signalActive = inNonRep && rawOk && ewmaOk && safeOk;
    }

    // ── refreshSignalForLockedTarget ─────────────────────────────────────────────
    // GHOST: re-evaluate signal for locked targetDigit WITHOUT changing it.
    refreshSignalForLockedTarget() {
        const d = this.targetDigit;
        if (d < 0 || !this.regime) return;

        const r = this.regime;
        this.targetRepeatRate = r.repeatProb[d];

        const inNonRep = r.currentRegime[d] === 'non-rep';
        const rawOk = r.repeatProb[d] < this.config.repeat_threshold;
        const ewmaOk = r.ewmaRepeatRate[d] < this.config.repeat_threshold;
        const safeOk = r.safetyScore[d] >= 50;

        this.signalActive = inNonRep && rawOk && ewmaOk && safeOk;
    }

    // ── logRegimeAnalysis ────────────────────────────────────────────────────────
    logRegimeAnalysis(currentDigit) {
        if (!this.regime) return;
        const r = this.regime;
        const threshold = this.config.repeat_threshold;

        // Compact rate display: raw/EWMA(score) for each digit
        const rateStr = r.repeatProb.map((rp, i) => {
            const ew = r.ewmaRepeatRate[i].toFixed(0);
            const raw = rp.toFixed(0);
            const safe = r.safetyScore[i] >= 50;
            const isTarget = i === currentDigit;
            if (isTarget) return (safe ? green : red)(`${i}:${raw}%/${ew}%🄴(${r.safetyScore[i]})`);
            return dim(`${i}:${raw}%`);
        }).join(' ');

        logAnalysis(`Rates [raw/EWMA(score)]: [${rateStr}]`);

        // Per-digit regime detail for target digit
        const d = currentDigit;
        const nrLens = r.nonRepRunLengths[d];
        const regStr = r.currentRegime[d] === 'non-rep' ? green('NON-REP') : yellow('REP');
        const exhaustCol = r.nonRepRunExhaustion[d] > 70 ? red : green;
        const flipCol = r.nonRepToRepProb[d] > 40 ? red : green;

        logAnalysis(
            `Digit ${bold(d)} | ` +
            `Regime: ${regStr} (${r.currentRegimeDuration[d]} ticks) | ` +
            `Non-rep runs: ${nrLens.length} avg:${r.avgNonRepRunLen[d].toFixed(1)} ` +
            `med:${r.medNonRepRunLen[d].toFixed(1)} max:${r.maxNonRepRunLen[d]} | ` +
            `Exhaust: ${exhaustCol(r.nonRepRunExhaustion[d].toFixed(0) + '%')} | ` +
            `P(flip→rep): ${flipCol(r.nonRepToRepProb[d].toFixed(0) + '%')}`
        );

        logAnalysis(
            `Tail: ${bold(r.tailLength + '× digit ' + r.tailDigit)} ` +
            `(${r.tailRegime === 'non-rep' ? green('✅ non-rep') : yellow('🔁 rep')}) | ` +
            `Regime shifts: ${dim(r.totalRegimeShifts)} | ` +
            `Threshold: ${bold(threshold + '%')}`
        );

        if (this.signalActive) {
            logAnalysis(green(
                `✅ SIGNAL — digit ${d} | ` +
                `raw:${r.repeatProb[d].toFixed(1)}% EWMA:${r.ewmaRepeatRate[d].toFixed(1)}% ` +
                `score:${r.safetyScore[d]}/100 regime:${r.currentRegime[d]} → DIFFER`
            ));
        } else {
            const reasons = [];
            if (r.currentRegime[d] !== 'non-rep') reasons.push('in REP regime');
            if (r.repeatProb[d] >= threshold) reasons.push(`raw ${r.repeatProb[d].toFixed(1)}%≥${threshold}%`);
            if (r.ewmaRepeatRate[d] >= threshold) reasons.push(`EWMA ${r.ewmaRepeatRate[d].toFixed(1)}%≥${threshold}%`);
            if (r.safetyScore[d] < 50) reasons.push(`score ${r.safetyScore[d]}<50`);
            logAnalysis(red(`⛔ NO SIGNAL — digit ${d}: ${reasons.join(', ')} → WAIT`));
        }
    }

    // ── WebSocket ────────────────────────────────────────────────────────────────
    connectWS() {
        this.botState = STATE.CONNECTING;
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);

        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            logError(`Failed to create WebSocket: ${e.message}`);
            this.attemptReconnect();
            return;
        }

        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.botState = STATE.AUTHENTICATING;

            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN)
                    this.send({ ping: 1 });
            }, 30_000);

            logApi('Authenticating...');
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', raw => {
            try {
                const msg = JSON.parse(raw);
                this.handleMessage(msg);
            } catch (e) {
                logError(`Parse error: ${e.message}`);
            }
        });

        this.ws.on('close', code => {
            logApi(`⚠️  Connection closed (code: ${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.botState !== STATE.STOPPED) this.attemptReconnect();
        });

        this.ws.on('error', e => {
            logError(`WebSocket error: ${e.message}`);
        });
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT) {
            logError(`Max reconnection attempts (${this.MAX_RECONNECT}) reached. Stopping.`);
            this.stop('Max reconnect attempts exceeded');
            return;
        }
        this.reconnectAttempts++;
        const delay = Math.pow(2, this.reconnectAttempts - 1) * 1000;
        logApi(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT})...`);
        this.isTradeActive = false;
        setTimeout(() => { if (this.botState !== STATE.STOPPED) this.connectWS(); }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); }
        catch (e) { logError(`Send error: ${e.message}`); }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => { });
    }

    // ── Message Router ────────────────────────────────────────────────────────
    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch (msg.msg_type) {
            case 'authorize': this.handleAuth(msg); break;
            case 'balance': this.handleBalance(msg); break;
            case 'history': this.handleTickHistory(msg); break;
            case 'tick': this.handleTick(msg); break;
            case 'buy': this.handleBuy(msg); break;
            case 'transaction': this.handleTransaction(msg); break;
            case 'ping': break;
            default: break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN';
        const emsg = msg.error.message || 'Unknown error';
        const mtype = msg.msg_type || 'unknown';
        logError(`[${code}] on ${mtype}: ${emsg}`);

        switch (code) {
            case 'InvalidToken':
            case 'AuthorizationRequired':
                logError('Invalid API token. Check your --token value.');
                this.stop('Authentication failed');
                break;
            case 'RateLimit':
                logError('Rate limited. Pausing 10s...');
                setTimeout(() => {
                    if (this.botState !== STATE.STOPPED) {
                        this.isTradeActive = false;
                        this.executeTradeFlow(false);
                    }
                }, 10_000);
                break;
            case 'InsufficientBalance':
                logRisk('💸 Insufficient balance!');
                this.stop('Insufficient balance');
                break;
            default:
                if (msg.msg_type === 'buy') {
                    this.isTradeActive = false;
                    this.botState = STATE.ANALYZING;
                }
                break;
        }
    }

    // ── Auth ─────────────────────────────────────────────────────────────────────
    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        this.sessionStartTime = Date.now();

        const isDemo = this.accountId.startsWith('VRTC');
        logApi(
            `${green('✅ Authenticated')} | Account: ${bold(this.accountId)} ` +
            `${isDemo ? dim('(Demo)') : red('(REAL MONEY!)')} | ` +
            `Balance: ${green('$' + this.accountBalance.toFixed(2))}`
        );
        if (!isDemo) logRisk('⚠️  REAL ACCOUNT — trading with real money!');

        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });

        this.botState = STATE.COLLECTING_TICKS;
        logBot(`Fetching last ${bold(this.config.tick_history_size)} ticks for ${bold(this.config.symbol)}...`);
        this.send({
            ticks_history: this.config.symbol,
            count: this.config.tick_history_size,
            end: 'latest',
            style: 'ticks',
        });
    }

    // ── Tick History ─────────────────────────────────────────────────────────────
    handleTickHistory(msg) {
        if (!msg.history || !msg.history.prices) {
            logError('Failed to fetch tick history. Falling back to live collection...');
            this.subscribeToLiveTicks();
            return;
        }

        const prices = msg.history.prices;
        const digits = prices.map(p => getLastDigit(p, this.config.symbol));
        this.tickHistory = digits.slice(-this.config.tick_history_size);

        logBot(`${green('✅ Loaded ' + this.tickHistory.length + ' historical ticks')}`);
        logTick(`History tail (last 10): [${this.tickHistory.slice(-10).join(', ')}]`);

        this.subscribeToLiveTicks();

        if (this.tickHistory.length >= this.config.analysis_window) {
            this.botState = STATE.ANALYZING;
            this.regime = this.analyzeRegime();
            const lastDigit = this.tickHistory[this.tickHistory.length - 1];
            this.checkSignal(lastDigit);
            this.logRegimeAnalysis(lastDigit);
        } else {
            logBot(`Collecting more ticks (${this.tickHistory.length}/${this.config.analysis_window})...`);
        }
    }

    subscribeToLiveTicks() {
        logBot(`Subscribing to live ticks for ${bold(this.config.symbol)}...`);
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    // ── Balance ───────────────────────────────────────────────────────────────────
    handleBalance(msg) {
        if (msg.balance) {
            this.accountBalance = parseFloat(msg.balance.balance);
        }
    }

    // ── Live Tick Handler ─────────────────────────────────────────────────────────
    handleTick(msg) {
        if (!msg.tick || this.botState === STATE.STOPPED) return;

        const price = msg.tick.quote;
        const currentDigit = getLastDigit(price, this.config.symbol);

        // Push to sliding window
        this.tickHistory.push(currentDigit);
        if (this.tickHistory.length > this.config.tick_history_size) {
            this.tickHistory = this.tickHistory.slice(-this.config.tick_history_size);
        }

        const count = this.tickHistory.length;

        // Tick display: last 5 + current
        const histLen = this.tickHistory.length;
        const last5 = histLen >= 2
            ? this.tickHistory.slice(Math.max(0, histLen - 6), histLen - 1)
            : [];
        const last5Str = last5.length > 0 ? last5.join(' › ') : '—';
        const stateHint =
            this.botState === STATE.WAITING_RESULT ? '⏳ waiting result'
                : this.botState === STATE.COOLDOWN ? '❄️ cooldown'
                    : this.botState === STATE.GHOST_TRADING
                        ? `👻 ghost ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
                        : '';

        logTick(
            dim(`${last5Str} ›`) + ` ${bold(cyan(`[${currentDigit}]`))}` +
            dim(`  ${price}  (${count}/${this.config.tick_history_size})`) +
            (stateHint ? `  ${dim(stateHint)}` : '')
        );

        // ── Pending trade: fires only when currentDigit === targetDigit ─────
        if (this.pendingTrade && !this.isTradeActive && this.botState !== STATE.STOPPED) {
            if (currentDigit === this.targetDigit) {
                this.pendingTrade = false;
                this.placeTrade();
                return;
            } else {
                logGhost(dim(`⏳ Waiting for target digit ${bold(this.targetDigit)} — current: ${currentDigit}`));
                return;
            }
        }

        // ── State machine ────────────────────────────────────────────────────
        switch (this.botState) {
            case STATE.COLLECTING_TICKS:
                if (count >= this.config.analysis_window) {
                    this.botState = STATE.ANALYZING;
                    this.regime = this.analyzeRegime();
                    this.checkSignal(currentDigit);
                    this.logRegimeAnalysis(currentDigit);
                    this.processSignal(currentDigit);
                }
                break;

            case STATE.ANALYZING:
                this.regime = this.analyzeRegime();
                this.checkSignal(currentDigit);
                this.logRegimeAnalysis(currentDigit);
                if (this.signalActive) this.processSignal(currentDigit);
                break;

            case STATE.GHOST_TRADING:
                // Keep regime fresh but do NOT change targetDigit
                this.regime = this.analyzeRegime();
                this.refreshSignalForLockedTarget();
                this.runGhostCheck(currentDigit);
                break;

            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                this.regime = this.analyzeRegime();
                break;
        }
    }

    // ── processSignal ─────────────────────────────────────────────────────────────
    processSignal(currentDigit) {
        if (!this.signalActive) {
            this.botState = STATE.ANALYZING;
            return;
        }

        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            const r = this.regime;
            logGhost(
                `👻 Ghost phase started. Target locked: ${bold(cyan(this.targetDigit))} ` +
                `(raw:${r ? r.repeatProb[this.targetDigit].toFixed(1) : '?'}% ` +
                `EWMA:${r ? r.ewmaRepeatRate[this.targetDigit].toFixed(1) : '?'}% ` +
                `score:${r ? r.safetyScore[this.targetDigit] : '?'}/100). ` +
                `Need ${bold(this.config.ghost_wins_required)} confirmed non-repeat(s).`
            );
            this.runGhostCheck(currentDigit);
        } else {
            this.executeTradeFlow(true);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  GHOST TRADING — TWO-TICK MODEL
    //
    //  Tick A: currentDigit === targetDigit
    //    → wins+1 >= wins_required → fire LIVE trade NOW
    //    → else set ghostAwaitingResult = true
    //
    //  Tick B: (after Tick A)
    //    → currentDigit !== targetDigit → Ghost WIN (didn't repeat). Wins++.
    //    → currentDigit === targetDigit → Ghost LOSS (repeated). Wins = 0.
    //
    //  Other ticks (currentDigit !== targetDigit, not awaiting result):
    //    → Skip silently, keep waiting.
    // ══════════════════════════════════════════════════════════════════════════
    runGhostCheck(currentDigit) {
        if (this.botState !== STATE.GHOST_TRADING) return;

        if (!this.signalActive) {
            logGhost(dim(`⏳ Signal lost for digit ${this.targetDigit} — re-analyzing...`));
            this.resetGhost();
            this.botState = STATE.ANALYZING;
            return;
        }

        this.ghostRoundsPlayed++;

        if (this.ghostAwaitingResult) {
            // ── Tick B: check if target digit repeated ─────────────────────────
            this.ghostAwaitingResult = false;

            if (currentDigit !== this.targetDigit) {
                this.ghostConsecutiveWins++;
                logGhost(
                    `👻 ${green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)} — ` +
                    `digit ${bold(cyan(this.targetDigit))} did NOT repeat (next: ${bold(currentDigit)})`
                );
            } else {
                const hadWins = this.ghostConsecutiveWins;
                this.ghostConsecutiveWins = 0;
                logGhost(
                    `👻 ${red(`❌ Ghost LOSS — digit ${bold(cyan(this.targetDigit))} REPEATED`)} ` +
                    `(had ${hadWins} win${hadWins !== 1 ? 's' : ''}) — reset to 0/${this.config.ghost_wins_required}`
                );
            }

        } else {
            // ── Watching for target digit ──────────────────────────────────────
            if (currentDigit === this.targetDigit) {
                const winsIfConfirmed = this.ghostConsecutiveWins + 1;

                if (winsIfConfirmed >= this.config.ghost_wins_required) {
                    // Wins requirement reached → fire LIVE trade NOW
                    this.ghostConsecutiveWins = winsIfConfirmed;
                    this.ghostConfirmed = true;
                    logGhost(
                        `👻 Target digit ${bold(cyan(this.targetDigit))} appeared! ` +
                        green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)
                    );
                    logGhost(green(bold(
                        `✅ Ghost confirmed! Executing LIVE DIFFER trade on digit ${this.targetDigit} NOW!`
                    )));
                    this.executeTradeFlow(true);
                } else {
                    // Set awaiting — next tick resolves WIN or LOSS
                    this.ghostAwaitingResult = true;
                    logGhost(
                        `👻 Target digit ${bold(cyan(this.targetDigit))} appeared | ` +
                        `Wins: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required} | ` +
                        dim(`Awaiting next tick to confirm non-repeat...`)
                    );
                }
            } else {
                // Not the target digit — skip silently
                logGhost(dim(
                    `⏳ Digit ${currentDigit} — waiting for target ${bold(this.targetDigit)} ` +
                    `(${this.ghostConsecutiveWins}/${this.config.ghost_wins_required})`
                ));

                this.refreshSignalForLockedTarget();
                if (!this.signalActive) {
                    logGhost(dim(`Digit ${this.targetDigit} signal lost — returning to ANALYZING`));
                    this.resetGhost();
                    this.botState = STATE.ANALYZING;
                    return;
                }
            }
        }

        // Max rounds guard
        if (!this.ghostConfirmed && this.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`⚠️  Max ghost rounds (${this.config.ghost_max_rounds}) reached. Re-analyzing...`));
            this.resetGhost();
            this.botState = STATE.ANALYZING;
        }
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;
        this.targetDigit = -1;
        this.signalActive = false;
    }

    // ── Trade Execution ───────────────────────────────────────────────────────────
    executeTradeFlow(immediate) {
        if (this.isTradeActive || this.pendingTrade || this.botState === STATE.STOPPED) return;

        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
            return;
        }

        this.currentStake = this.calculateStake();

        if (this.currentStake > this.config.max_stake) {
            logRisk(`Stake $${this.currentStake.toFixed(2)} exceeds max $${this.config.max_stake.toFixed(2)}`);
            this.stop('Stake exceeds maximum');
            return;
        }

        if (this.currentStake > this.accountBalance) {
            logRisk(`Stake $${this.currentStake.toFixed(2)} exceeds balance $${this.accountBalance.toFixed(2)}`);
            this.stop('Insufficient balance for stake');
            return;
        }

        if (immediate) {
            this.placeTrade();
        } else {
            this.pendingTrade = true;
            this.botState = STATE.GHOST_TRADING;
            logBot(`⚡ Recovery trade queued — waiting for digit ${bold(cyan(this.targetDigit))} | Stake: ${bold('$' + this.currentStake.toFixed(2))}`);
        }
    }

    // ── Place Trade ───────────────────────────────────────────────────────────────
    placeTrade() {
        this.isTradeActive = true;
        this.botState = STATE.PLACING_TRADE;

        const stepInfo = this.config.martingale_enabled
            ? ` | Mart Step: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const r = this.regime;
        const score = r ? r.safetyScore[this.targetDigit] : 0;

        logTrade(
            `🎯 DIFFER from ${bold(cyan(this.targetDigit))} | ` +
            `Stake: ${bold('$' + this.currentStake.toFixed(2))}${stepInfo} | ` +
            `Rate: ${this.targetRepeatRate.toFixed(1)}% | ` +
            `Score: ${score}/100 | ` +
            `Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
        );

        this.sendTelegram(`
            🎯 <b>GHOST TRADE</b>

            📊 Symbol: ${this.config.symbol}
            🔢 Target Digit: ${this.targetDigit}
            💰 Stake: $${this.currentStake.toFixed(2)}${stepInfo}
            📈 Rate: ${this.targetRepeatRate.toFixed(1)}%
            🔬 Score: ${score}/100
            👻 Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}
            📊 Session: ${this.totalTrades} trades | ${this.totalWins < 1 ? '0' : this.totalWins}W/${this.totalLosses}L
            💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
        `.trim());

        this.send({
            buy: 1,
            price: this.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol: this.config.symbol,
                duration: 1,
                duration_unit: 't',
                basis: 'stake',
                amount: this.currentStake,
                barrier: String(this.targetDigit),
                currency: this.config.currency,
            },
        });

        this.botState = STATE.WAITING_RESULT;
    }

    // ── Buy Response ──────────────────────────────────────────────────────────────
    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
        const payout = parseFloat(msg.buy.payout);
        logTrade(dim(`Contract ${this.lastContractId} | Cost: $${this.lastBuyPrice.toFixed(2)} | Payout: $${payout.toFixed(2)}`));
    }

    // ── Transaction (Result) ──────────────────────────────────────────────────────
    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;

        this.botState = STATE.PROCESSING_RESULT;

        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.totalTrades++;

        const resultDigit = this.tickHistory.length > 0
            ? this.tickHistory[this.tickHistory.length - 1]
            : null;

        if (profit > 0) {
            this.processWin(profit, resultDigit);
        } else {
            this.processLoss(this.lastBuyPrice, resultDigit);
        }

        this.isTradeActive = false;
        this.decideNextAction();
    }

    // ── Process Win ───────────────────────────────────────────────────────────────
    processWin(profit, resultDigit) {
        this.totalWins++;
        this.sessionProfit += profit;
        this.currentWinStreak++;
        this.currentLossStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;

        const recovery = this.martingaleStep > 0 ? green(' 🔄 RECOVERY!') : '';
        const plStr = this.sessionProfit >= 0
            ? green(formatMoney(this.sessionProfit))
            : red(formatMoney(this.sessionProfit));

        logResult(
            `${green('✅ WIN!')} Profit: ${green('+$' + profit.toFixed(2))} | ` +
            `P/L: ${plStr} | Bal: ${green('$' + this.accountBalance.toFixed(2))}${recovery}`
        );

        if (resultDigit !== null) {
            logResult(dim(`  Target: ${this.targetDigit} | Result: ${resultDigit} | Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`));
        }

        this.sendTelegram(`
            ✅ <b>WIN!</b>

            📊 Symbol: ${this.config.symbol}
            🎯 Target: ${this.targetDigit}
            🔢 Result: ${resultDigit !== null ? resultDigit : 'N/A'}
            💰 Profit: +$${profit.toFixed(2)}
            💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
            📊 Balance: $${this.accountBalance.toFixed(2)}
            📈 Record: ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentWinStreak}W
            👻 Ghost: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}
            ⏰ ${new Date().toLocaleString()}
        `.trim());

        this.resetMartingale();
        this.resetGhost();
    }

    // ── Process Loss ──────────────────────────────────────────────────────────────
    processLoss(lostAmount, resultDigit) {
        this.totalLosses++;
        this.sessionProfit -= lostAmount;
        this.totalMartingaleLoss += lostAmount;
        this.currentLossStreak++;
        this.currentWinStreak = 0;
        if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;

        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached)
            this.maxMartingaleReached = this.martingaleStep;

        const martInfo = this.config.martingale_enabled
            ? ` | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const plStr = this.sessionProfit >= 0
            ? green(formatMoney(this.sessionProfit))
            : red(formatMoney(this.sessionProfit));

        logResult(
            `${red('❌ LOSS!')} Lost: ${red('-$' + lostAmount.toFixed(2))} | ` +
            `P/L: ${plStr} | Bal: $${this.accountBalance.toFixed(2)}${martInfo}`
        );

        if (resultDigit !== null) {
            logResult(dim(
                `  Target: ${this.targetDigit} | Result: ${resultDigit} ` +
                `(${resultDigit === this.targetDigit ? red('REPEATED') : green('different — unexpected loss')})`
            ));
        }

        this.sendTelegram(`
            ❌ <b>LOSS!</b>

            📊 Symbol: ${this.config.symbol}
            🎯 Target: ${this.targetDigit}
            🔢 Result: ${resultDigit !== null ? resultDigit : 'N/A'} ${resultDigit === this.targetDigit ? red('(REPEATED)') : '(different)'}
            💸 Lost: -$${lostAmount.toFixed(2)}
            💵 P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
            📊 Balance: $${this.accountBalance.toFixed(2)}
            📈 Record: ${this.totalWins}W/${this.totalLosses}L | Streak: ${this.currentLossStreak}L${martInfo}
            👻 Ghost: Reset to 0
            ⏰ ${new Date().toLocaleString()}
        `.trim());

        // Reset ghost after live trade loss — targetDigit stays locked for martingale
        this.ghostConsecutiveWins = 0;
        this.ghostConfirmed = false;
        this.ghostRoundsPlayed = 0;
        this.ghostAwaitingResult = false;
        logBot(dim(
            `Ghost wins reset to 0 after live trade loss. ` +
            `Waiting for digit ${bold(this.targetDigit)} ` +
            `(${this.config.ghost_wins_required} ghost win(s) required).`
        ));
    }

    // ── Decide Next Action ─────────────────────────────────────────────────────────
    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }

        if (this.config.martingale_enabled &&
            this.martingaleStep > 0 &&
            this.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(
                `📈 Martingale recovery step ${this.martingaleStep}/${this.config.max_martingale_steps} — ` +
                `going through ghost phase again (need ${this.config.ghost_wins_required} ghost win(s) on digit ${this.targetDigit})...`
            ));
            if (this.config.ghost_enabled) {
                this.botState = STATE.GHOST_TRADING;
            } else {
                this.executeTradeFlow(false);
            }
            return;
        }

        if (this.config.martingale_enabled &&
            this.martingaleStep >= this.config.max_martingale_steps) {
            logRisk(`🛑 Max Martingale steps (${this.config.max_martingale_steps}) reached!`);
            this.resetMartingale();
            this.startCooldown();
            return;
        }

        this.botState = STATE.ANALYZING;
    }

    // ── Stake Calculation ──────────────────────────────────────────────────────────
    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0) {
            return this.config.base_stake;
        }
        const raw = this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep);
        const calc = Math.round(raw * 100) / 100;
        const final = Math.min(calc, this.config.max_stake);
        logBot(dim(
            `Mart calc: Step ${this.martingaleStep} | ` +
            `$${this.config.base_stake.toFixed(2)} × ${this.config.martingale_multiplier}^${this.martingaleStep} ` +
            `= $${calc.toFixed(2)} → Final: $${final.toFixed(2)}`
        ));
        return final;
    }

    // ── Risk Limits ────────────────────────────────────────────────────────────────
    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}\n\nSession end at ${new Date().toLocaleString()}`);
            return { canTrade: false, reason: `🎯 Take profit reached! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }

        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}\n\nSession end at ${new Date().toLocaleString()}`);
            return { canTrade: false, reason: `🛑 Stop loss hit! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }

        const nextStake = (!this.config.martingale_enabled || this.martingaleStep === 0)
            ? this.config.base_stake
            : Math.min(
                Math.round(this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep) * 100) / 100,
                this.config.max_stake
            );

        if (nextStake > this.accountBalance)
            return { canTrade: false, reason: `💸 Next stake $${nextStake.toFixed(2)} > balance $${this.accountBalance.toFixed(2)}`, action: 'STOP' };

        if (nextStake > this.config.max_stake)
            return { canTrade: false, reason: `📈 Next stake $${nextStake.toFixed(2)} > max $${this.config.max_stake.toFixed(2)}`, action: 'STOP' };

        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: '🔄 Max Martingale steps reached. Cooldown.', action: 'COOLDOWN' };

        return { canTrade: true };
    }

    // ── Martingale Reset ───────────────────────────────────────────────────────────
    resetMartingale() {
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake = this.config.base_stake;
    }

    // ── Cooldown ───────────────────────────────────────────────────────────────────
    startCooldown() {
        this.botState = STATE.COOLDOWN;
        this.resetMartingale();
        this.resetGhost();
        const sec = this.config.cooldown_after_max_loss / 1000;
        logBot(`⏸️  Cooldown for ${sec}s...`);

        this.cooldownTimer = setTimeout(() => {
            if (this.botState === STATE.COOLDOWN) {
                logBot(green('▶️  Cooldown ended. Resuming...'));
                this.botState = STATE.ANALYZING;
            }
        }, this.config.cooldown_after_max_loss);
    }

    // ── Stop ───────────────────────────────────────────────────────────────────────
    stop(reason = 'User stopped') {
        this.botState = STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping bot...')} Reason: ${reason}`);

        if (this.cooldownTimer) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.pendingTrade = false;

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) { /* ignore */ }
            setTimeout(() => { try { this.ws.close(); } catch (_) { /* ignore */ } }, 500);
        }

        this.sendTelegram(`🛑 <b>SESSION STOPPED</b>\n\nReason: ${reason}\n\nFinal P&L: $${this.sessionProfit.toFixed(2)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    // ── Final Stats ────────────────────────────────────────────────────────────────
    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;

        console.log('');
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY                  ')));
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(`  Duration          : ${bold(formatDuration(dur))}`);
        logStats(`  Symbol            : ${bold(this.config.symbol)}`);
        logStats(`  Repeat Threshold  : ${bold(this.config.repeat_threshold + '%')}`);
        logStats(`  Ghost Wins Req.   : ${bold(this.config.ghost_wins_required)}`);
        logStats(`  Total Trades      : ${bold(this.totalTrades)}`);
        logStats(`  Wins              : ${green(this.totalWins)}`);
        logStats(`  Losses            : ${red(this.totalLosses)}`);
        logStats(`  Win Rate          : ${bold(wr + '%')}`);
        logStats(`  Session P/L       : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Starting Balance  : $${this.startingBalance.toFixed(2)}`);
        logStats(`  Final Balance     : $${this.accountBalance.toFixed(2)}`);
        logStats(`  Avg P/L per Trade : ${formatMoney(avg)}`);
        logStats(`  Largest Win       : ${green('+$' + this.largestWin.toFixed(2))}`);
        logStats(`  Largest Loss      : ${red('-$' + this.largestLoss.toFixed(2))}`);
        logStats(`  Max Win Streak    : ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak   : ${red(this.maxLossStreak)}`);
        logStats(`  Max Martingale    : Step ${this.maxMartingaleReached}`);
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Help ───────────────────────────────────────────────────────────────────────
function printHelp() {
    console.log(`
${bold(cyan('Romanian Ghost Bot — Node.js CLI'))}
${dim('Deriv Digit Differ — Advanced Regime Detection Strategy')}
${dim('HMM-inspired + EWMA + Transition Matrix + Composite Safety Score')}

${bold('Usage:')}
  node romanian-ghost-bot.js ${cyan('--token')} YOUR_API_TOKEN [options]

${bold('Required:')}
  ${cyan('--token')}         YOUR_TOKEN    Deriv API token (Read + Trade + Payments)

${bold('Connection:')}
  ${cyan('--appid')}         1089          Deriv App ID

${bold('Trading:')}
  ${cyan('--symbol')}        R_100         Trading symbol
                            ${dim('R_10, R_25, R_50, R_75, R_100')}
                            ${dim('1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V')}
  ${cyan('--stake')}         0.35          Base stake amount ($, min 0.35)

${bold('Analysis:')}
  ${cyan('--history')}       300           Tick history window size (sliding)
  ${cyan('--window')}        300           Analysis window (must be ≤ history)
  ${cyan('--threshold')}     10            Repeat probability threshold (%)
                            ${dim('Signal fires when:')}
                            ${dim('  • Raw transition prob < threshold')}
                            ${dim('  • EWMA repeat rate < threshold')}
                            ${dim('  • Current regime = non-rep')}
                            ${dim('  • Composite safety score ≥ 50/100')}

${bold('Ghost Trading:')}
  ${cyan('--no-ghost')}                    Disable ghost trading (default: enabled)
  ${cyan('--ghost-wins')}    3             Wins required before going LIVE
                            ${dim('Two-tick model:')}
                            ${dim('  Tick A: target digit appears → trigger')}
                            ${dim('  Tick B: if next ≠ target → ghost WIN')}
                            ${dim('         if next = target → ghost LOSS (reset)')}
                            ${dim('  When wins = required → LIVE trade fires on Tick A')}
                            ${dim('  After LIVE trade loss → ghost wins reset to 0')}
  ${cyan('--ghost-max')}     500           Max ghost rounds before re-analyzing

${bold('Martingale:')}
  ${cyan('--no-mart')}                     Disable Martingale (default: enabled)
  ${cyan('--mart-steps')}    3             Max Martingale steps
  ${cyan('--mart-mult')}     11            Multiplier: stake × mult^step

${bold('Risk Management:')}
  ${cyan('--tp')}            10            Take profit ($)
  ${cyan('--sl')}            50            Stop loss ($)
  ${cyan('--max-stake')}     500           Maximum allowed stake ($)
  ${cyan('--cooldown')}      30000         Cooldown after max Martingale (ms)

${bold('Examples:')}
  ${dim('# Basic usage')}
  node romanian-ghost-bot.js --token YOUR_TOKEN

  ${dim('# Strict signal (5% threshold), 5 ghost wins required')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --threshold 5 --ghost-wins 5

  ${dim('# Custom symbol, larger history window')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --symbol R_50 --history 500 --window 500

  ${dim('# No ghost, no martingale (pure signal trading)')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --no-ghost --no-mart

  ${dim('# Aggressive martingale recovery')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --mart-steps 5 --mart-mult 3 --max-stake 1000

${bold('Regime Detection:')}
  The bot uses 4 signals combined into a safety score (0-100):
  1. ${bold('Raw transition prob')}:  P(d→d) from full history (up to 30 pts)
  2. ${bold('EWMA repeat rate')}:     α=0.15 weighting (~13-tick half-life) (up to 30 pts)
  3. ${bold('Non-rep exhaustion')}:   How far into the non-rep run duration (up to 20 pts)
  4. ${bold('Flip probability')}:     P(non-rep→rep) from regime sequences (up to 20 pts)
  Score ≥ 50 = valid signal. Hard gates: must be non-rep regime + both rates below threshold.

${bold('Notes:')}
  • Bot fetches ${bold('tick history')} on startup (no waiting for live ticks to fill window)
  • Trades execute ${bold('immediately')} on the current tick when signal+ghost fire together
  • Use ${bold('Ctrl+C')} to stop gracefully (prints session summary)
  • Token requires: Read, Trade, Payments permissions
  • Get token at: ${cyan('https://app.deriv.com/account/api-token')}
`);
}

// ── Entry Point ────────────────────────────────────────────────────────────────
(function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    const config = parseArgs();

    if (!config.api_token) {
        console.log('');
        logError('No API token provided. Use --token YOUR_TOKEN');
        console.log('');
        console.log(`Run ${cyan('node romanian-ghost-bot.js --help')} for usage information.`);
        console.log('');
        process.exit(1);
    }

    const bot = new RomanianGhostBot(config);

    process.on('SIGINT', () => { console.log(''); bot.stop('SIGINT (Ctrl+C)'); });
    process.on('SIGTERM', () => { bot.stop('SIGTERM'); });
    process.on('uncaughtException', e => {
        logError(`Uncaught exception: ${e.message}`);
        if (e.stack) logError(e.stack);
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', (reason) => {
        logError(`Unhandled rejection: ${reason}`);
    });

    bot.start();
})();
