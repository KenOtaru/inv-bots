#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v2.1 Advanced Transition Detection
//  Deriv Digit Differ — Statistical Regime Switching + Pattern Recognition
//
//  ADVANCED DETECTION ENGINE:
//    1. Sliding Window Probability (Bayesian updates per tick)
//    2. Regime Transition Detection (Identifies the "Shift" from REP to NON-REP)
//    3. Z-Score Confidence (Statistical significance of the regime)
//    4. Dual-Filter: Global Market Regime vs Specific Digit Behavior
//    5. Persistence Scoring (Requires stability before trade)
//
//  TRADE CONDITION:
//    a) Global Market Regime = NON-REP (Random/Flat)
//    b) Target Digit is "Cold" (Low repeat prob)
//    c) Transition detected recently (Entered NON-REP within last X ticks)
//    d) Z-Score Confidence > 90%
//
//  Usage:
//    node romanian-ghost-bot-v2.1.js --token YOUR_DERIV_TOKEN
// ============================================================================

'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir"; // Use your token
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";

// ── ANSI Colour Helpers ───────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
    red: '\x1b[31m', yellow: '\x1b[33m', magenta: '\x1b[35m',
    orange: '\x1b[38;5;208m', white: '\x1b[37m',
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
    BOT: cyan, API: blue, TICK: dim, ANALYSIS: yellow,
    GHOST: magenta, TRADE: bold, RESULT: bold, RISK: red,
    STATS: cyan, ERROR: t => col(t, C.bold, C.red), REGIME: t => col(t, C.orange, C.bold),
};

function getTimestamp() {
    const n = new Date();
    return [String(n.getHours()).padStart(2,'0'), String(n.getMinutes()).padStart(2,'0'), String(n.getSeconds()).padStart(2,'0')].join(':');
}

function log(prefix, message) {
    const ts = dim(`[${getTimestamp()}]`);
    const pfx = (PREFIX_COLOURS[prefix] || (t => t))(`[${prefix}]`);
    console.log(`${ts} ${pfx} ${message}`);
}

const logBot      = m => log('BOT', m);
const logApi      = m => log('API', m);
const logTick     = m => log('TICK', m);
const logAnalysis = m => log('ANALYSIS', m);
const logGhost    = m => log('GHOST', m);
const logTrade    = m => log('TRADE', m);
const logResult   = m => log('RESULT', m);
const logRisk     = m => log('RISK', m);
const logStats    = m => log('STATS', m);
const logError    = m => log('ERROR', m);
const logRegime   = m => log('REGIME', m);

// ── Config ────────────────────────────────────────────────────────────────────
function parseArgs() {
    return {
        api_token: TOKEN,
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        symbol: 'R_75',
        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',

        // Advanced Regime Config
        tick_history_size: 5000,
        min_ticks_for_analysis: 50,
        
        // Thresholds
        // If global repeat rate > 25%, market is REPEATING (Bad for DigitDiff)
        // If global repeat rate < 15%, market is RANDOM (Good for DigitDiff)
        repeat_threshold_global: 25, 
        non_repeat_threshold_global: 15,
        
        // Digit specific (Must be cold to trade)
        digit_repeat_threshold: 20, 

        // Transition Logic
        // How many ticks must we stay in Non-Repeat before we trust it?
        min_persistence_ticks: 8, 
        // Z-Score required to be confident (Standard Deviations)
        min_confidence_zscore: 1.5, 

        // Ghost Trading
        ghost_enabled: false, 
        ghost_wins_required: 1, // Set to 0 for instant trading on signal, or 1+ to require consecutive wins before trading
        ghost_max_rounds: 200000000000,

        // Martingale
        martingale_enabled: true,
        martingale_multiplier: 11.3,
        max_martingale_steps: 3,

        // Risk
        take_profit: 100,
        stop_loss: 70,
        max_stake: 500,
        delay_between_trades: 1500,
        cooldown_after_max_loss: 30000,
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac = parts.length > 1 ? parts[1] : '';
    if (['RDBULL','RDBEAR','R_75','R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10','R_25','1HZ15V','1HZ30V','1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}

function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function formatDuration(ms) {
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    return `${m}m ${String(s).padStart(2,'0')}s`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── State Constants ───────────────────────────────────────────────────────────
const STATE = {
    INITIALIZING: 'INITIALIZING', CONNECTING: 'CONNECTING', AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS', ANALYZING: 'ANALYZING', GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE', WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT', COOLDOWN: 'COOLDOWN', STOPPED: 'STOPPED',
};

// ══════════════════════════════════════════════════════════════════════════════
//  ADVANCED REGIME DETECTION ENGINE (v2.1)
// ══════════════════════════════════════════════════════════════════════════════

class AdvancedRegimeDetector {
    constructor(config) {
        this.cfg = config;
        this.lastState = 'UNKNOWN'; // REP, NON-REP
        this.stateCounter = 0;     // How long have we been in current state?
        this.confidence = 0;       // 0-100%
        this.transitionDetected = false;
        
        // Metrics tracking
        this.historyShort = []; // Last 15 ticks (raw digits)
        this.historyLong = [];  // Last 100 ticks
    }

    // Calculate probability of repeat in a window
    calcRepeatProb(window) {
        if (window.length < 2) return 0;
        let repeats = 0;
        for (let i = 1; i < window.length; i++) {
            if (window[i] === window[i-1]) repeats++;
        }
        // Bayesian smoothing (Laplace)
        return ((repeats + 1) / (window.length + 2)) * 100;
    }

    // Calculate Standard Deviation for Z-Score
    calcStdDev(window, mean) {
        if (window.length < 2) return 1;
        let variance = 0;
        // We need binary array (1=repeat, 0=no) for true stats
        const binary = [];
        for (let i = 1; i < window.length; i++) binary.push(window[i] === window[i-1] ? 1 : 0);
        
        // Simple population std dev approximation for binary
        const p = mean / 100;
        return Math.sqrt(p * (1 - p) / binary.length) * 100 || 1; // *100 to get %
    }

    analyze(tickHistory, targetDigit) {
        const len = tickHistory.length;
        if (len < this.cfg.min_ticks_for_analysis) {
            return { valid: false, reason: 'insufficient data' };
        }

        // Update sliding windows
        this.historyShort = tickHistory.slice(-15);
        this.historyLong = tickHistory.slice(-100);

        // 1. Calculate Global Market Probabilities
        const probShort = this.calcRepeatProb(this.historyShort);
        const probLong = this.calcRepeatProb(this.historyLong);

        // 2. Determine Regime (REP vs NON-REP)
        // We are in NON-REP if Short Prob is significantly lower than Long Prob OR Short Prob is simply low
        let currentRegime = 'REP';
        
        // Logic: If Short Prob < Global Threshold OR Short Prob is much lower than Long Prob
        if (probShort < this.cfg.non_repeat_threshold_global || 
           (probShort < probLong * 0.7 && probShort < 30)) {
            currentRegime = 'NON-REP';
        }

        // 3. Detect Transition
        if (currentRegime !== this.lastState) {
            this.stateCounter = 0;
            if (this.lastState === 'REP' && currentRegime === 'NON-REP') {
                this.transitionDetected = true;
            }
        } else {
            this.stateCounter++;
            if (this.stateCounter > 5) this.transitionDetected = false; // Transition "faded"
        }
        this.lastState = currentRegime;

        // 4. Calculate Confidence (Z-Score based)
        // How many standard deviations is Short Prob below the threshold?
        // Or how far is Short Prob below Long Prob?
        const stdDev = this.calcStdDev(this.historyLong, probLong);
        const zScore = (probLong - probShort) / stdDev; 
        
        // Confidence 0-100 based on Z-Score and how "Low" the short prob is
        let confidence = clamp((zScore / 2.5) * 100, 0, 100);
        
        // Boost confidence if Short Prob is extremely low (< 10%)
        if (probShort < 10) confidence += 20;
        confidence = clamp(confidence, 0, 100);

        this.confidence = confidence;

        // 5. Target Digit Specifics
        // Does the digit we want to trade repeat often?
        let digitSpecificRepeatRate = 0;
        const digitWindow = this.historyShort.filter(d => d === targetDigit);
        if (digitWindow.length > 1) {
             digitSpecificRepeatRate = this.calcRepeatProb(digitWindow);
        } else {
            // If digit didn't appear enough, assume neutral
            digitSpecificRepeatRate = probShort; 
        }

        const isDigitSafe = digitSpecificRepeatRate < this.cfg.digit_repeat_threshold;

        // 6. Final Signal Generation
        const signalActive = (
            currentRegime === 'NON-REP' &&
            this.stateCounter >= this.cfg.min_persistence_ticks &&
            confidence >= (this.cfg.min_confidence_zscore * 30) && // Approx mapping
            isDigitSafe
        );

        // 7. Composite Safety Score (0-100)
        let safetyScore = 0;
        if (currentRegime === 'NON-REP') safetyScore += 40;
        safetyScore += (this.stateCounter / 20) * 20; // Up to 20 pts for persistence
        safetyScore += (confidence / 100) * 20;       // Up to 20 pts for confidence
        if (isDigitSafe) safetyScore += 20;
        
        // Hard Gates
        if (currentRegime !== 'NON-REP') safetyScore = 0;
        if (!isDigitSafe) safetyScore = Math.min(safetyScore, 20);
        if (this.transitionDetected && this.stateCounter < 3) safetyScore += 10; // Bonus for fresh transition

        safetyScore = clamp(safetyScore, 0, 100);

        return {
            valid: true,
            regime: currentRegime,           // 'REP' or 'NON-REP'
            persistence: this.stateCounter,
            transition: this.transitionDetected,
            probShort,
            probLong,
            zScore,
            confidence,
            digitRepeatRate: digitSpecificRepeatRate,
            isDigitSafe,
            safetyScore,
            signalActive
        };
    }

    // Reset detector when needed
    reset() {
        this.lastState = 'UNKNOWN';
        this.stateCounter = 0;
        this.confidence = 0;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class RomanianGhostBot {
    constructor(config) {
        this.config = config;
        this.ws = null;
        this.botState = STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT = 5;
        this.pingInterval = null;
        this.requestId = 0;

        this.accountBalance = 0;
        this.startingBalance = 0;
        this.accountId = '';

        this.tickHistory = [];

        // Replace HMM with Advanced Detector
        this.detector = new AdvancedRegimeDetector(config);

        this.regime = null;
        this.targetDigit = -1;
        this.targetRepeatRate = 0;
        this.signalActive = false;

        // Ghost state
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
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    }

    start() {
        this.printBanner();
        this.connectWS();
    }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v2.1  —  Advanced Transition Detection')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log(`  Symbol          : ${bold(c.symbol)}`);
        console.log(`  Base Stake     : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Repeat Threshold (Global): ${bold('< ' + c.non_repeat_threshold_global + '%')}`);
        console.log(`  Persistence Req: ${bold(c.min_persistence_ticks + ' ticks')}`);
        console.log(`  Z-Score Min    : ${bold(c.min_confidence_zscore)}`);
        console.log(`  Ghost Trading  : ${c.ghost_enabled ? green('ON') : red('OFF')}`);
        console.log(`  Martingale     : ${c.martingale_enabled ? green('ON') : red('OFF')}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════')));
        console.log('');
    }

    // --- WebSocket & Handlers (Same as before, simplified for brevity) ---
    connectWS() {
        this.botState = STATE.CONNECTING;
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);
        try { this.ws = new WebSocket(url); }
        catch (e) { logError(`Failed to create WebSocket: ${e.message}`); this.attemptReconnect(); return; }
        
        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.botState = STATE.AUTHENTICATING;
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 }); }, 30_000);
            logApi('Authenticating...');
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', raw => {
            try { this.handleMessage(JSON.parse(raw)); }
            catch (e) { logError(`Parse error: ${e.message}`); }
        });

        this.ws.on('close', code => {
            logApi(`⚠️  Connection closed (code: ${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.botState !== STATE.STOPPED) this.attemptReconnect();
        });
        
        this.ws.on('error', e => logError(`WebSocket error: ${e.message}`));
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT) {
            logError(`Max reconnection attempts reached. Stopping.`);
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
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => {});
    }

    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch (msg.msg_type) {
            case 'authorize':    this.handleAuth(msg); break;
            case 'balance':      this.handleBalance(msg); break;
            case 'history':      this.handleTickHistory(msg); break;
            case 'tick':         this.handleTick(msg); break;
            case 'buy':          this.handleBuy(msg); break;
            case 'transaction':  this.handleTransaction(msg); break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN';
        const emsg = msg.error.message || 'Unknown error';
        logError(`[${code}] on ${msg.msg_type || 'unknown'}: ${emsg}`);
        if (code === 'InvalidToken' || code === 'AuthorizationRequired') this.stop('Authentication failed');
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        this.sessionStartTime = Date.now();
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Authenticated')} | Account: ${bold(this.accountId)} ${isDemo ? dim('(Demo)') : red('(REAL)')} | Bal: ${green('$' + this.accountBalance.toFixed(2))}`);
        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.botState = STATE.COLLECTING_TICKS;
        logBot(`Fetching last ${bold(this.config.tick_history_size)} ticks...`);
        this.send({ ticks_history: this.config.symbol, count: this.config.tick_history_size, end: 'latest', style: 'ticks' });
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    handleTickHistory(msg) {
        if (!msg.history || !msg.history.prices) {
            logError('Failed to fetch tick history.');
            this.subscribeToLiveTicks();
            return;
        }
        const prices = msg.history.prices;
        const digits = prices.map(p => getLastDigit(p, this.config.symbol));
        this.tickHistory = digits.slice(-this.config.tick_history_size);
        logBot(`${green('✅ Loaded ' + this.tickHistory.length + ' ticks')}`);
        this.subscribeToLiveTicks();
        if (this.tickHistory.length >= this.config.min_ticks_for_analysis) {
            this.botState = STATE.ANALYZING;
            const lastDigit = this.tickHistory[this.tickHistory.length - 1];
            this.regime = this.detector.analyze(this.tickHistory, lastDigit);
            this.applyRegimeSignal(lastDigit);
            this.logRegimeAnalysis(lastDigit);
        }
    }

    subscribeToLiveTicks() {
        logBot(`Subscribing to live ticks for ${bold(this.config.symbol)}...`);
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    handleTick(msg) {
        if (!msg.tick || this.botState === STATE.STOPPED) return;
        const price = msg.tick.quote;
        const currentDigit = getLastDigit(price, this.config.symbol);
        this.tickHistory.push(currentDigit);
        if (this.tickHistory.length > this.config.tick_history_size) this.tickHistory = this.tickHistory.slice(-this.config.tick_history_size);

        const last5Str = this.tickHistory.slice(-6, -1).join(' › ');
        const stateHint = this.botState === STATE.WAITING_RESULT ? '⏳ result' : this.botState === STATE.GHOST_TRADING ? `👻 ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}` : '';
        logTick(`${dim(last5Str)} › ${bold(cyan(`[${currentDigit}]`))} ${stateHint}`);

        if (this.pendingTrade && !this.isTradeActive) {
            if (currentDigit === this.targetDigit) {
                this.pendingTrade = false;
                this.placeTrade();
                return;
            }
            return;
        }

        switch (this.botState) {
            case STATE.COLLECTING_TICKS:
                if (this.tickHistory.length >= this.config.min_ticks_for_analysis) {
                    this.botState = STATE.ANALYZING;
                    this.regime = this.detector.analyze(this.tickHistory, currentDigit);
                    this.applyRegimeSignal(currentDigit);
                    this.logRegimeAnalysis(currentDigit);
                    this.processSignal(currentDigit);
                }
                break;
            case STATE.ANALYZING:
            case STATE.GHOST_TRADING:
                this.regime = this.detector.analyze(this.tickHistory, this.targetDigit > -1 ? this.targetDigit : currentDigit);
                this.applyRegimeSignal(this.targetDigit > -1 ? this.targetDigit : currentDigit);
                this.logRegimeAnalysis(this.targetDigit > -1 ? this.targetDigit : currentDigit);
                if (this.botState === STATE.ANALYZING && this.signalActive) this.processSignal(currentDigit);
                if (this.botState === STATE.GHOST_TRADING) this.runGhostCheck(currentDigit);
                break;
            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                break;
        }
    }

    applyRegimeSignal(currentDigit) {
        this.targetDigit = currentDigit;
        if (!this.regime || !this.regime.valid) { this.signalActive = false; return; }
        this.signalActive = this.regime.signalActive;
    }

    logRegimeAnalysis(currentDigit) {
        if (!this.regime || !this.regime.valid) return;
        const r = this.regime;
        
        const stateCol = r.regime === 'NON-REP' ? green : yellow;
        
        logRegime(
            `Regime: ${stateCol(bold(r.regime))} | ` +
            `P(Short): ${r.probShort.toFixed(1)}% | ` +
            `P(Long): ${r.probLong.toFixed(1)}% | ` +
            `Z-Score: ${r.zScore.toFixed(2)} | ` +
            `Conf: ${r.confidence.toFixed(0)}% | ` +
            `Persist: ${r.persistence} | ` +
            `Trans: ${r.transition ? bold(green('YES')) : dim('No')}`
        );

        if (this.signalActive) {
            logAnalysis(green(`✅ SIGNAL ACTIVE | Digit: ${currentDigit} | Score: ${r.safetyScore}/100 | Safe: ${r.isDigitSafe}`));
        } else {
            const reasons = [];
            if (r.regime !== 'NON-REP') reasons.push('Global REP');
            if (r.persistence < this.config.min_persistence_ticks) reasons.push('Too volatile');
            if (!r.isDigitSafe) reasons.push('Digit Hot');
            logAnalysis(red(`⛔ NO SIGNAL: ${reasons.join(', ')}`));
        }
    }

    processSignal(currentDigit) {
        if (!this.signalActive) { this.botState = STATE.ANALYZING; return; }
        
        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            logGhost(`👻 Ghost phase: Target ${bold(cyan(this.targetDigit))} | Need ${bold(this.config.ghost_wins_required)} win(s)`);
            this.runGhostCheck(currentDigit);
        } else {
            this.executeTradeFlow(true);
        }
    }

    runGhostCheck(currentDigit) {
        if (this.botState !== STATE.GHOST_TRADING) return;
        if (!this.signalActive) {
            this.resetGhost();
            this.botState = STATE.ANALYZING;
            return;
        }

        this.ghostRoundsPlayed++;

        if (this.ghostAwaitingResult) {
            this.ghostAwaitingResult = false;
            if (currentDigit !== this.targetDigit) {
                this.ghostConsecutiveWins++;
                logGhost(`👻 ${green(`WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`);
            } else {
                const had = this.ghostConsecutiveWins;
                this.ghostConsecutiveWins = 0;
                logGhost(`👻 ${red(`LOSS (reset). Was ${had}`)}`);
            }
        } else {
            if (currentDigit === this.targetDigit) {
                const winsIfConfirmed = this.ghostConsecutiveWins + 1;
                if (winsIfConfirmed >= this.config.ghost_wins_required) {
                    this.ghostConsecutiveWins = winsIfConfirmed;
                    this.ghostConfirmed = true;
                    logGhost(green(`✅ Ghost Confirmed! Trading on ${this.targetDigit} NOW!`));
                    this.executeTradeFlow(true);
                } else {
                    this.ghostAwaitingResult = true;
                    logGhost(`👻 Target ${this.targetDigit} seen. Waiting next tick...`);
                }
            } else {
                logGhost(`⏳ Waiting for ${this.targetDigit} (${this.ghostConsecutiveWins}/${this.config.ghost_wins_required})`);
                if (!this.signalActive) { this.resetGhost(); this.botState = STATE.ANALYZING; }
            }
        }

        if (!this.ghostConfirmed && this.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`Max rounds. Re-analyzing...`));
            this.resetGhost();
            this.botState = STATE.ANALYZING;
        }
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.ghostAwaitingResult = false;
    }

    // --- Trade Execution Logic (Same structure, updated checks) ---
    executeTradeFlow(immediate) {
        if (this.isTradeActive || this.pendingTrade || this.botState === STATE.STOPPED) return;
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) { logRisk(risk.reason); return; }
        
        this.currentStake = this.calculateStake();
        if (this.currentStake > this.config.max_stake || this.currentStake > this.accountBalance) {
            this.stop('Stake/Balance limit');
            return;
        }

        if (immediate) this.placeTrade();
        else {
            this.pendingTrade = true;
            this.botState = STATE.GHOST_TRADING;
            logBot(`Queue trade for ${this.targetDigit}`);
        }
    }

    placeTrade() {
        this.isTradeActive = true;
        this.botState = STATE.PLACING_TRADE;
        const stepInfo = this.config.martingale_enabled ? ` | Mart: ${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        
        logTrade(`🎯 DIFFER from ${bold(cyan(this.targetDigit))} | Stake: ${bold('$' + this.currentStake.toFixed(2))}${stepInfo}`);

        this.sendTelegram(`🎯 <b>TRADE</b>\nTarget: ${this.targetDigit}\nStake: $${this.currentStake.toFixed(2)}\nP/L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}`);

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

    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
    }

    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;
        this.botState = STATE.PROCESSING_RESULT;
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.totalTrades++;
        
        if (profit > 0) this.processWin(profit);
        else this.processLoss(this.lastBuyPrice);
        
        this.isTradeActive = false;
        this.decideNextAction();
    }

    processWin(profit) {
        this.totalWins++;
        this.sessionProfit += profit;
        this.currentWinStreak++;
        this.currentLossStreak = 0;
        if (profit > this.largestWin) this.largestWin = profit;
        
        logResult(`${green('✅ WIN!')} +$${profit.toFixed(2)} | P/L: ${this.sessionProfit >= 0 ? green : red}($${this.sessionProfit.toFixed(2)})`);
        this.resetMartingale();
        this.resetGhost();
    }

    processLoss(lostAmount) {
        this.totalLosses++;
        this.sessionProfit -= lostAmount;
        this.currentLossStreak++;
        this.currentWinStreak = 0;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;
        
        logResult(`${red('❌ LOSS!')} -$${lostAmount.toFixed(2)} | P/L: ${this.sessionProfit >= 0 ? green : red}($${this.sessionProfit.toFixed(2)})`);
        
        this.ghostConsecutiveWins = 0;
        this.ghostConfirmed = false;
    }

    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            if (risk.action === 'STOP') this.stop(risk.reason);
            else if (risk.action === 'COOLDOWN') this.startCooldown();
            return;
        }
        if (this.config.martingale_enabled && this.martingaleStep > 0 && this.martingaleStep < this.config.max_martingale_steps) {
            this.botState = STATE.ANALYZING;
            this.executeTradeFlow(false);
            return;
        }
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps) {
            this.startCooldown();
            return;
        }
        this.botState = STATE.ANALYZING;
    }

    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0) return this.config.base_stake;
        return Math.min(this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep), this.config.max_stake);
    }

    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) return { canTrade: false, reason: 'Take Profit', action: 'STOP' };
        if (this.sessionProfit <= -this.config.stop_loss) return { canTrade: false, reason: 'Stop Loss', action: 'STOP' };
        return { canTrade: true };
    }

    resetMartingale() { this.martingaleStep = 0; this.currentStake = this.config.base_stake; }

    startCooldown() {
        this.botState = STATE.COOLDOWN;
        this.resetMartingale();
        this.resetGhost();
        logBot(`Cooldown for ${this.config.cooldown_after_max_loss/1000}s...`);
        this.cooldownTimer = setTimeout(() => {
            logBot('Resuming...');
            this.botState = STATE.ANALYZING;
        }, this.config.cooldown_after_max_loss);
    }

    stop(reason = 'User') {
        this.botState = STATE.STOPPED;
        logBot(`Stopping: ${reason}`);
        if (this.ws) this.ws.close();
        this.printFinalStats();
        process.exit(0);
    }

    printFinalStats() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : 0;
        console.log('');
        logStats(bold('SESSION SUMMARY'));
        logStats(`Trades: ${this.totalTrades} | Wins: ${this.totalWins} | Loss: ${this.totalLosses}`);
        logStats(`Win Rate: ${wr}% | P/L: ${this.sessionProfit >= 0 ? green : red}($${this.sessionProfit.toFixed(2)})`);
    }
}

// ── Entry Point ────────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();
    const bot = new RomanianGhostBot(config);
    process.on('SIGINT', () => bot.stop('SIGINT'));
    process.on('uncaughtException', e => { logError(e.message); bot.stop('Error'); });
    bot.start();
})();