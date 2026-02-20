#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — Single-file Node.js Version
//  Deriv Digit Differ — Repetition Pattern Strategy
//
//  Usage:
//    node romanian-ghost-bot.js --token YOUR_DERIV_API_TOKEN [options]
//
//  Run with --help to see all options.
// ============================================================================

'use strict';

const WebSocket = require('ws');

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

// ── Logger ────────────────────────────────────────────────────────────────────
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
        base_stake: '0.61',
        currency: 'USD',
        contract_type: 'DIGITDIFF',
        tick_history_size: 300,
        analysis_window: 300,
        repeat_threshold: 5,
        ghost_enabled: true,
        ghost_wins_required: 3,
        ghost_max_rounds: 50000000000,
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

/**
 * Asset-aware last digit extractor.
 * Mirrors the web bot's getLastDigit(price, asset) function exactly.
 */
function getLastDigit(price, asset) {
    const quoteString = price.toString();
    const parts = quoteString.split('.');
    const fractionalPart = parts.length > 1 ? parts[1] : '';

    if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
        return fractionalPart.length >= 4 ? parseInt(fractionalPart[3], 10) : 0;
    } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
        return fractionalPart.length >= 3 ? parseInt(fractionalPart[2], 10) : 0;
    } else {
        // Default: R_100, 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, etc.
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

function avgRunLength(runs) {
    if (runs.length === 0) return 0;
    return runs.reduce((a, b) => a + b, 0) / runs.length;
}

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

        // ── Ticks — sliding window of exactly tick_history_size ───────────────
        this.tickHistory = [];

        // ── Regime-based repetition analysis ─────────────────────────────────
        this.digitRepeatRates = new Array(10).fill(0);
        this.digitCounts = new Array(10).fill(0);
        this.repTransitions = new Array(10).fill(0);
        this.totalTransitions = new Array(10).fill(0);
        this.repRunLengths = Array.from({ length: 10 }, () => []);
        this.nonRepRunLengths = Array.from({ length: 10 }, () => []);
        this.currentRunDigit = -1;
        this.currentRunLength = 0;
        this.currentRegime = 'non-rep';

        // ── Signal / Target ───────────────────────────────────────────────────
        // targetDigit: locked when signal fires, does NOT change during ghost phase
        // signalActive: true when targetDigit's repeat prob < repeat_threshold
        this.targetDigit = -1;
        this.targetRepeatRate = 0;
        this.signalActive = false;

        // ── Ghost state ───────────────────────────────────────────────────────
        // Ghost WIN  = currentDigit === targetDigit
        //   (target digit appeared → unlikely to repeat → count this observation)
        // Ghost LOSS = currentDigit !== targetDigit
        //   (target digit not seen → reset counter, keep waiting)
        //
        // Trade fires when ghostConsecutiveWins >= ghost_wins_required
        // AND currentDigit === targetDigit on the SAME tick.
        //
        // After LIVE TRADE LOSS → ghostConsecutiveWins = 0, ghostConfirmed = false
        // Bot must re-accumulate ghost wins before next trade (even martingale).
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;

        // ── Trading ───────────────────────────────────────────────────────────
        this.currentStake = config.base_stake;
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.isTradeActive = false;
        this.lastBuyPrice = 0;
        this.lastContractId = null;

        // Pending trade flag (set outside tick handler; fires on next matching tick)
        this.pendingTrade = false;

        // ── Session stats ─────────────────────────────────────────────────────
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
    }

    // ── Validation ─────────────────────────────────────────────────────────────
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

    // ── Start ──────────────────────────────────────────────────────────────────
    start() {
        const errors = this.validate();
        if (errors.length) {
            errors.forEach(e => logError(e));
            process.exit(1);
        }
        this.printBanner();
        this.connectWS();
    }

    // ── Banner ─────────────────────────────────────────────────────────────────
    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('═══════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT  —  Deriv Digit Differ           ')));
        console.log(bold(cyan('        Repetition Pattern Strategy                        ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════')));
        console.log(`  Symbol           : ${bold(c.symbol)}`);
        console.log(`  Base Stake       : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Tick History     : ${bold(c.tick_history_size)} ticks`);
        console.log(`  Analysis Window  : ${bold(c.analysis_window)} ticks`);
        console.log(`  Repeat Threshold : ${bold(c.repeat_threshold + '%')} — trade when digit repeat prob < this`);
        console.log(`  Ghost Trading    : ${c.ghost_enabled
            ? green('ON') + ` | Wins Required: ${bold(c.ghost_wins_required)} | Max Rounds: ${c.ghost_max_rounds}`
            : red('OFF')}`);
        console.log(`  Martingale       : ${c.martingale_enabled
            ? green('ON') + ` | Max Steps: ${c.max_martingale_steps} | Multiplier: ${c.martingale_multiplier}x`
            : red('OFF')}`);
        console.log(`  Take Profit      : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss        : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(`  Max Stake        : $${c.max_stake.toFixed(2)}`);
        console.log(`  Trade Delay      : ${c.delay_between_trades}ms`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════')));
        console.log('');

        if (c.martingale_enabled && c.max_martingale_steps >= 1) {
            let risk = 0;
            for (let i = 0; i < c.max_martingale_steps; i++) {
                risk += c.base_stake * Math.pow(c.martingale_multiplier, i);
            }
            logRisk(`⚠️  Martingale worst case: ${c.max_martingale_steps} consecutive losses ≈ ${red('-$' + risk.toFixed(2))} (${c.martingale_multiplier}x multiplier)`);
        }

        if (c.ghost_enabled) {
            logBot(`👻 Ghost mode: Target digit must appear ${bold(c.ghost_wins_required)} time(s) consecutively before LIVE trade fires.`);
            logBot(`   After any LIVE trade loss → ghost wins reset to 0. Must re-accumulate before next trade.`);
        }
        console.log('');
    }

    // ── WebSocket ──────────────────────────────────────────────────────────────
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
                        // Queue for next matching tick
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

    // ── Auth ───────────────────────────────────────────────────────────────────
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

        // Fetch tick history immediately
        this.botState = STATE.COLLECTING_TICKS;
        logBot(`Fetching last ${bold(this.config.tick_history_size)} ticks for ${bold(this.config.symbol)}...`);
        this.send({
            ticks_history: this.config.symbol,
            count: this.config.tick_history_size,
            end: 'latest',
            style: 'ticks',
        });
    }

    // ── Tick History (initial load) ────────────────────────────────────────────
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
            this.analyzeRepetitionPattern();
            const lastDigit = this.tickHistory[this.tickHistory.length - 1];
            this.checkSignal(lastDigit);
            this.logRepetitionAnalysis(lastDigit);
        } else {
            logBot(`Collecting more ticks (${this.tickHistory.length}/${this.config.analysis_window})...`);
        }
    }

    subscribeToLiveTicks() {
        logBot(`Subscribing to live ticks for ${bold(this.config.symbol)}...`);
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    // ── Balance ────────────────────────────────────────────────────────────────
    handleBalance(msg) {
        if (msg.balance) {
            this.accountBalance = parseFloat(msg.balance.balance);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  REGIME-BASED REPETITION PATTERN ANALYSIS
    //
    //  Pass 1: For each digit d, compute:
    //    repeatProbability(d) = (times d was followed by d) / (total transitions from d) × 100
    //
    //  Pass 2: Segment tick history into consecutive runs of the same digit.
    //    Track repRunLengths[d] and nonRepRunLengths[d] for regime analysis.
    //
    //  Tail: Detect the current run at the end of tick history.
    //    currentRunDigit, currentRunLength, currentRegime ('rep' | 'non-rep')
    // ════════════════════════════════════════════════════════════════════════════
    analyzeRepetitionPattern() {
        const window = this.tickHistory.slice(-this.config.analysis_window);
        const len = window.length;
        if (len < 2) return;

        this.repTransitions = new Array(10).fill(0);
        this.totalTransitions = new Array(10).fill(0);
        this.repRunLengths = Array.from({ length: 10 }, () => []);
        this.nonRepRunLengths = Array.from({ length: 10 }, () => []);

        const appearances = new Array(10).fill(0);
        const repeats = new Array(10).fill(0);

        // Pass 1: transition counts
        for (let i = 0; i < len; i++) {
            const d = window[i];
            appearances[d]++;
            if (i + 1 < len) {
                this.totalTransitions[d]++;
                if (window[i + 1] === d) {
                    this.repTransitions[d]++;
                    repeats[d]++;
                }
            }
        }

        this.digitCounts = appearances;
        for (let d = 0; d <= 9; d++) {
            this.digitRepeatRates[d] = appearances[d] === 0
                ? 0
                : (repeats[d] / appearances[d]) * 100;
        }

        // Pass 2: regime segmentation
        let i = 0;
        while (i < len) {
            const d = window[i];
            let runLen = 1;
            while (i + runLen < len && window[i + runLen] === d) runLen++;
            if (runLen > 1) this.repRunLengths[d].push(runLen);

            const afterStart = i + runLen;
            let nonRepLen = 0;
            let j = afterStart;
            while (j < len && window[j] !== d) { nonRepLen++; j++; }
            if (nonRepLen > 0) this.nonRepRunLengths[d].push(nonRepLen);

            i += runLen;
        }

        // Tail analysis
        let tailLen = 1;
        const tailDigit = window[len - 1];
        while (tailLen < len && window[len - 1 - tailLen] === tailDigit) tailLen++;
        this.currentRunDigit = tailDigit;
        this.currentRunLength = tailLen;
        this.currentRegime = tailLen >= 2 ? 'rep' : 'non-rep';
    }

    // ── checkSignal ─────────────────────────────────────────────────────────────
    // ANALYZING state: evaluate whether currentDigit's repeat rate < threshold.
    // If yes, lock targetDigit = currentDigit and activate signal.
    // Do NOT call during GHOST_TRADING — targetDigit must stay locked.
    checkSignal(currentDigit) {
        this.targetDigit = currentDigit;
        const tot = this.totalTransitions[currentDigit];
        const rep = this.repTransitions[currentDigit];
        const repeatProb = tot > 0 ? (rep / tot) * 100 : this.digitRepeatRates[currentDigit];
        this.targetRepeatRate = repeatProb;
        this.signalActive = repeatProb < this.config.repeat_threshold;
    }

    // ── refreshSignalForLockedTarget ────────────────────────────────────────────
    // GHOST_TRADING: targetDigit is already locked.
    // Re-evaluates signalActive WITHOUT changing targetDigit.
    refreshSignalForLockedTarget() {
        const d = this.targetDigit;
        if (d < 0) return;
        const tot = this.totalTransitions[d];
        const rep = this.repTransitions[d];
        const repeatProb = tot > 0 ? (rep / tot) * 100 : this.digitRepeatRates[d];
        this.targetRepeatRate = repeatProb;
        this.signalActive = repeatProb < this.config.repeat_threshold;
    }

    logRepetitionAnalysis(currentDigit) {
        const threshold = this.config.repeat_threshold;

        const rateStr = this.digitRepeatRates.map((r, i) => {
            const isTarget = i === currentDigit;
            const below = r < threshold;
            if (isTarget) return (below ? green : red)(`${i}:${r.toFixed(0)}%`);
            return dim(`${i}:${r.toFixed(0)}%`);
        }).join(' ');

        logAnalysis(`Repeat rates: [${rateStr}]`);

        const d = currentDigit;
        const avgRepRun = avgRunLength(this.repRunLengths[d]);
        const avgNonRep = avgRunLength(this.nonRepRunLengths[d]);
        const repCount = this.repRunLengths[d].length;
        const nonRepCount = this.nonRepRunLengths[d].length;

        logAnalysis(
            `Digit ${bold(d)} regime: ` +
            `Rep runs: ${repCount} (avg ${avgRepRun.toFixed(1)}) | ` +
            `Non-rep runs: ${nonRepCount} (avg ${avgNonRep.toFixed(1)}) | ` +
            `Tail: ${this.currentRunLength}× digit ${this.currentRunDigit} ` +
            `(${this.currentRegime === 'rep' ? yellow('🔁 rep') : green('✅ non-rep')})`
        );

        if (this.signalActive) {
            logAnalysis(green(`✅ SIGNAL — digit ${d} repeat prob ${this.targetRepeatRate.toFixed(1)}% < ${threshold}% → DIFFER`));
        } else {
            logAnalysis(red(`⛔ NO SIGNAL — digit ${d} repeat prob ${this.targetRepeatRate.toFixed(1)}% ≥ ${threshold}% → WAIT`));
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  LIVE TICK HANDLER
    //
    //  TRADE EXECUTION RULES:
    //  ─────────────────────
    //  • Signal fires when repeatProbability(currentDigit) < repeat_threshold.
    //    → targetDigit is locked to currentDigit.
    //
    //  • Both ghost and live trades execute ONLY when:
    //      currentDigit === targetDigit
    //    (The target digit just appeared, making it unlikely to repeat.)
    //
    //  • Ghost counts how many consecutive times targetDigit appeared.
    //    When count reaches ghost_wins_required on the SAME tick where
    //    currentDigit === targetDigit → fire LIVE DIFFER trade immediately.
    //
    //  • After a LIVE TRADE LOSS → ghostConsecutiveWins = 0, ghostConfirmed = false.
    //    Bot must re-satisfy ghost phase before next trade (even martingale).
    //
    //  Flow per tick:
    //  1. Push digit to sliding window
    //  2. Log last 5 digits + current live digit
    //  3. If pendingTrade → check if currentDigit === targetDigit; fire if yes
    //  4. Run state machine
    // ════════════════════════════════════════════════════════════════════════════
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

        // Tick display: last 5 history + current
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

        // ── Pending trade: fires only when currentDigit === targetDigit ────────
        // Used for martingale recovery queued outside tick handler.
        if (this.pendingTrade && !this.isTradeActive && this.botState !== STATE.STOPPED) {
            if (currentDigit === this.targetDigit) {
                this.pendingTrade = false;
                this.placeTrade();
                return;
            } else {
                logGhost(
                    dim(`⏳ Waiting for target digit ${bold(this.targetDigit)} — current: ${currentDigit}`)
                );
                return;
            }
        }

        // ── State machine ──────────────────────────────────────────────────────
        switch (this.botState) {
            case STATE.COLLECTING_TICKS:
                if (count >= this.config.analysis_window) {
                    this.botState = STATE.ANALYZING;
                    this.analyzeRepetitionPattern();
                    this.checkSignal(currentDigit);
                    this.logRepetitionAnalysis(currentDigit);
                    this.processSignal(currentDigit);
                }
                break;

            case STATE.ANALYZING:
                this.analyzeRepetitionPattern();
                this.checkSignal(currentDigit);
                this.logRepetitionAnalysis(currentDigit);
                if (this.signalActive) this.processSignal(currentDigit);
                break;

            case STATE.GHOST_TRADING:
                // Keep analysis fresh but do NOT change targetDigit — it stays locked
                this.analyzeRepetitionPattern();
                this.refreshSignalForLockedTarget();
                this.runGhostCheck(currentDigit);
                break;

            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                // Passively keep analysis data fresh
                this.analyzeRepetitionPattern();
                break;
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  processSignal
    //
    //  Called when signal fires (signalActive = true, targetDigit = currentDigit).
    //  • Ghost enabled → enter GHOST_TRADING, run ghost check immediately
    //    (since currentDigit === targetDigit on this signal tick)
    //  • Ghost disabled → fire trade immediately on this tick
    // ════════════════════════════════════════════════════════════════════════════
    processSignal(currentDigit) {
        if (!this.signalActive) {
            this.botState = STATE.ANALYZING;
            return;
        }

        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            logGhost(
                `👻 Ghost phase started. Target digit locked: ${bold(cyan(this.targetDigit))} ` +
                `(repeat rate ${this.targetRepeatRate.toFixed(1)}%). ` +
                `Need ${bold(this.config.ghost_wins_required)} appearance(s) before going LIVE.`
            );
            // Run ghost check immediately — currentDigit === targetDigit on this tick
            this.runGhostCheck(currentDigit);
        } else {
            // Ghost disabled or already confirmed — fire immediately
            this.executeTradeFlow(true);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  GHOST TRADING
    //
    //  Ghost WIN  = currentDigit === targetDigit
    //    (Target digit appeared → unlikely to repeat → good omen for DIFFER trade)
    //  Ghost LOSS = currentDigit !== targetDigit
    //    (Target digit not seen → reset counter, keep waiting)
    //
    //  When ghostConsecutiveWins >= ghost_wins_required AND currentDigit === targetDigit:
    //    → Fire LIVE DIFFER trade on THIS SAME TICK (immediate = true)
    //
    //  After ghost LOSS: reset counter, re-check signal for locked digit.
    //    If signal lost → back to ANALYZING.
    //
    //  After LIVE TRADE LOSS: ghostConsecutiveWins = 0, ghostConfirmed = false
    //    → bot re-enters ghost phase (set in processLoss / decideNextAction)
    // ════════════════════════════════════════════════════════════════════════════
    runGhostCheck(currentDigit) {
        if (this.botState !== STATE.GHOST_TRADING) return;

        // If signal is gone for the locked target → pause and re-analyze
        if (!this.signalActive) {
            logGhost(
                dim(`⏳ Signal lost for digit ${this.targetDigit} `) +
                dim(`(${this.targetRepeatRate.toFixed(1)}% ≥ ${this.config.repeat_threshold}%) — re-analyzing...`)
            );
            this.resetGhost();
            this.botState = STATE.ANALYZING;
            return;
        }

        this.ghostRoundsPlayed++;

        const isTargetDigit = currentDigit === this.targetDigit;

        if (isTargetDigit) {
            // ── Ghost WIN ──────────────────────────────────────────────────────
            this.ghostConsecutiveWins++;
            logGhost(
                `👻 Target digit ${bold(cyan(this.targetDigit))} appeared! ` +
                green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`) +
                ` | repeat rate ${this.targetRepeatRate.toFixed(1)}%`
            );

            if (this.ghostConsecutiveWins >= this.config.ghost_wins_required) {
                this.ghostConfirmed = true;
                logGhost(
                    green(bold(
                        `✅ Ghost confirmed! ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required} wins. ` +
                        `Digit ${this.targetDigit} appeared ${this.ghostConsecutiveWins} time(s). ` +
                        `Executing LIVE DIFFER trade NOW!`
                    ))
                );
                // Fire on THIS SAME TICK
                this.executeTradeFlow(true);
            }

        } else {
            // ── Ghost LOSS ─────────────────────────────────────────────────────
            const prevWins = this.ghostConsecutiveWins;
            this.ghostConsecutiveWins = 0;
            logGhost(
                `👻 Digit ${bold(currentDigit)} ≠ target ${bold(this.targetDigit)} — ` +
                red(`❌ Ghost LOSS`) +
                ` (had ${prevWins} win${prevWins !== 1 ? 's' : ''}) — ` +
                `reset to 0/${this.config.ghost_wins_required}. Waiting for digit ${bold(this.targetDigit)}...`
            );

            // Re-evaluate signal for the same locked targetDigit
            this.refreshSignalForLockedTarget();
            if (!this.signalActive) {
                logGhost(
                    dim(`Locked digit ${this.targetDigit} repeat rate now ` +
                        `${this.targetRepeatRate.toFixed(1)}% ≥ ${this.config.repeat_threshold}% — signal lost, returning to ANALYZING`)
                );
                this.resetGhost();
                this.botState = STATE.ANALYZING;
                return;
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
        this.targetDigit = -1;
        this.signalActive = false;
    }

    // ════════════════════════════════════════════════════════════════════════════
    //  TRADE EXECUTION
    //
    //  immediate = true  → called from inside handleTick; call placeTrade() NOW
    //  immediate = false → called outside tick handler; set pendingTrade flag.
    //                      placeTrade() fires on next tick where
    //                      currentDigit === targetDigit.
    // ════════════════════════════════════════════════════════════════════════════
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
            this.botState = STATE.GHOST_TRADING; // stay in ghost state, waiting for target digit
            logBot(
                `⚡ Recovery trade queued — waiting for digit ${bold(cyan(this.targetDigit))} ` +
                `| Stake: ${bold('$' + this.currentStake.toFixed(2))}`
            );
        }
    }

    // ── Place Trade ───────────────────────────────────────────────────────────
    placeTrade() {
        this.isTradeActive = true;
        this.botState = STATE.PLACING_TRADE;

        const stepInfo = this.config.martingale_enabled
            ? ` | Mart Step: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';

        logTrade(
            `🎯 DIFFER from ${bold(cyan(this.targetDigit))} | ` +
            `Stake: ${bold('$' + this.currentStake.toFixed(2))}${stepInfo} | ` +
            `Repeat Rate: ${this.targetRepeatRate.toFixed(1)}% | ` +
            `Ghost wins: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
        );

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

    // ── Buy Response ───────────────────────────────────────────────────────────
    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
        const payout = parseFloat(msg.buy.payout);
        logTrade(dim(`Contract ${this.lastContractId} | Cost: $${this.lastBuyPrice.toFixed(2)} | Payout: $${payout.toFixed(2)}`));
    }

    // ── Transaction (Result) ───────────────────────────────────────────────────
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

    // ── Process Win ────────────────────────────────────────────────────────────
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
            logResult(dim(
                `  Target digit: ${this.targetDigit} | Result digit: ${resultDigit} | ` +
                `Ghost wins: ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
            ));
        }

        this.resetMartingale();
        // Reset ghost fully after win — next trade cycle starts fresh
        this.resetGhost();
    }

    // ── Process Loss ───────────────────────────────────────────────────────────
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
                `  Target digit: ${this.targetDigit} | Result digit: ${resultDigit} ` +
                `(${resultDigit === this.targetDigit ? red('REPEATED — loss as expected') : green('different — unexpected loss')})`
            ));
        }

        // ── KEY: Reset ghost wins after every loss ─────────────────────────────
        // Ghost must be re-satisfied before the next trade, even during martingale.
        // We do NOT reset targetDigit here — it stays locked for martingale recovery
        // so the pending trade waits for the same digit to reappear.
        this.ghostConsecutiveWins = 0;
        this.ghostConfirmed = false;
        this.ghostRoundsPlayed = 0;
        logBot(
            dim(`Ghost wins reset to 0 after loss. `) +
            dim(`Must reach ${this.config.ghost_wins_required} ghost win(s) before next trade.`)
        );
    }

    // ── Decide Next Action ─────────────────────────────────────────────────────
    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }

        // Martingale recovery: keep targetDigit locked, re-enter ghost phase
        if (this.config.martingale_enabled &&
            this.martingaleStep > 0 &&
            this.martingaleStep < this.config.max_martingale_steps) {
            logBot(
                dim(`📈 Martingale recovery step ${this.martingaleStep}/${this.config.max_martingale_steps} — `) +
                dim(`going through ghost phase again (need ${this.config.ghost_wins_required} ghost win(s) on digit ${this.targetDigit})...`)
            );
            if (this.config.ghost_enabled) {
                // Re-enter ghost trading — targetDigit stays locked, ghost wins = 0
                this.botState = STATE.GHOST_TRADING;
            } else {
                // Ghost disabled: queue trade, fires when targetDigit appears
                this.executeTradeFlow(false);
            }
            return;
        }

        // Max martingale steps → cooldown
        if (this.config.martingale_enabled &&
            this.martingaleStep >= this.config.max_martingale_steps) {
            logRisk(`🛑 Max Martingale steps (${this.config.max_martingale_steps}) reached!`);
            this.resetMartingale();
            this.startCooldown();
            return;
        }

        // Normal cycle after win or no-martingale loss: back to analyzing
        this.botState = STATE.ANALYZING;
    }

    // ── Stake Calculation ──────────────────────────────────────────────────────
    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0) {
            return this.config.base_stake;
        }
        // base_stake × multiplier^step
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

    // ── Risk Limits ────────────────────────────────────────────────────────────
    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit)
            return { canTrade: false, reason: `🎯 Take profit reached! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };

        if (this.sessionProfit <= -this.config.stop_loss)
            return { canTrade: false, reason: `🛑 Stop loss hit! P/L: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };

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

    // ── Martingale Reset ───────────────────────────────────────────────────────
    resetMartingale() {
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake = this.config.base_stake;
    }

    // ── Cooldown ───────────────────────────────────────────────────────────────
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

    // ── Stop ───────────────────────────────────────────────────────────────────
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

        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    // ── Final Stats ────────────────────────────────────────────────────────────
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
${dim('Deriv Digit Differ — Repetition Pattern Strategy')}

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
                              ${dim('Trade when digit repeat % is below this value')}
                              ${dim('Lower = stricter signal')}

${bold('Ghost Trading:')}
  ${cyan('--no-ghost')}                    Disable ghost trading (default: enabled)
  ${cyan('--ghost-wins')}    3             Wins required before going LIVE
                              ${dim('Target digit must appear N consecutive times')}
                              ${dim('After any live trade loss, ghost resets to 0')}
  ${cyan('--ghost-max')}     500           Max ghost rounds before re-analyzing

${bold('Martingale:')}
  ${cyan('--no-mart')}                     Disable Martingale (default: enabled)
  ${cyan('--mart-steps')}    3             Max Martingale steps
  ${cyan('--mart-mult')}     11            Martingale multiplier (stake × mult^step)

${bold('Risk Management:')}
  ${cyan('--tp')}            10            Take profit ($)
  ${cyan('--sl')}            50            Stop loss ($)
  ${cyan('--max-stake')}     500           Maximum allowed stake ($)
  ${cyan('--delay')}         1500          Delay between trades (ms, for non-immediate)
  ${cyan('--cooldown')}      30000         Cooldown after max Martingale (ms)

${bold('Examples:')}
  ${dim('# Basic usage')}
  node romanian-ghost-bot.js --token YOUR_TOKEN

  ${dim('# Custom symbol and stake')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --symbol R_50 --stake 0.50 --tp 20 --sl 30

  ${dim('# Strict signal (5% threshold), 5 ghost wins required')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --threshold 5 --ghost-wins 5

  ${dim('# No ghost, no martingale (pure signal trading)')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --no-ghost --no-mart

  ${dim('# Large history window for better analysis')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --history 500 --window 500 --threshold 8

  ${dim('# Aggressive martingale')}
  node romanian-ghost-bot.js --token YOUR_TOKEN --mart-steps 5 --mart-mult 3 --max-stake 1000

${bold('Notes:')}
  • Bot fetches ${bold('tick history')} on startup (no waiting for live ticks to fill window)
  • Trades execute on the ${bold('current live tick')} — zero delay when signal fires
  • After a live trade loss, ${bold('ghost wins reset to 0')} — must re-accumulate before next trade
  • Use ${bold('Ctrl+C')} to stop the bot gracefully (prints session summary)
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

    // Graceful shutdown
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
