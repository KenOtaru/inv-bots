#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — Single-file Node.js Version
//  Deriv Digit Differ Trading Strategy
//
//  Usage:
//    node romanian-ghost-bot.js [options]
//
//  Options (all optional — defaults shown):
//    --token       YOUR_DERIV_API_TOKEN     (required)
//    --appid       1089
//    --symbol      R_100
//    --stake       0.35
//    --history     30                       (tick history window size)
//    --window      30                       (analysis window, must be <= history)
//    --threshold   2                        (frequency threshold)
//    --ghost                                (enable ghost trading, default: on)
//    --no-ghost                             (disable ghost trading)
//    --ghost-wins  3                        (fallback wins required)
//    --ghost-max   200                      (max ghost rounds)
//    --no-auto                              (disable auto ghost wins)
//    --mart                                 (enable martingale, default: on)
//    --no-mart                              (disable martingale)
//    --mart-steps  3
//    --mart-mult   11
//    --tp          10                       (take profit $)
//    --sl          50                       (stop loss $)
//    --max-stake   500
//    --delay       1500                     (ms between trades)
//    --cooldown    30000                    (ms cooldown after max loss)
//
//  Example:
//    node romanian-ghost-bot.js --token YOUR_TOKEN --symbol R_50 --stake 0.50 --tp 20 --sl 30
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
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
};

function colour(text, ...codes) { return codes.join('') + text + C.reset; }
function bold(t) { return colour(t, C.bold); }
function dim(t) { return colour(t, C.dim); }
function cyan(t) { return colour(t, C.cyan); }
function blue(t) { return colour(t, C.blue); }
function green(t) { return colour(t, C.green); }
function red(t) { return colour(t, C.red); }
function yellow(t) { return colour(t, C.yellow); }
function magenta(t) { return colour(t, C.magenta); }
function orange(t) { return colour(t, C.orange); }

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
    ERROR: (t) => colour(t, C.bold, C.red),
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

const logBot = (m) => log('BOT', m);
const logApi = (m) => log('API', m);
const logTick = (m) => log('TICK', m);
const logAnalysis = (m) => log('ANALYSIS', m);
const logGhost = (m) => log('GHOST', m);
const logTrade = (m) => log('TRADE', m);
const logResult = (m) => log('RESULT', m);
const logRisk = (m) => log('RISK', m);
const logStats = (m) => log('STATS', m);
const logError = (m) => log('ERROR', m);

// ── Argument Parser ───────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag, def) => {
        const i = args.indexOf(flag);
        if (i !== -1 && args[i + 1] !== undefined) return args[i + 1];
        return def;
    };
    const has = (flag) => args.includes(flag);

    return {
        api_token: get('--token', ''),
        app_id: parseInt(get('--appid', '1089')),
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        symbol: get('--symbol', 'R_100'),
        base_stake: parseFloat(get('--stake', '0.35')),
        currency: 'USD',
        contract_type: 'DIGITDIFF',
        tick_history_size: parseInt(get('--history', '30')),
        analysis_window: parseInt(get('--window', '30')),
        frequency_threshold: parseInt(get('--threshold', '2')),
        ghost_enabled: !has('--no-ghost'),
        ghost_wins_required: parseInt(get('--ghost-wins', '3')),
        ghost_max_rounds: parseInt(get('--ghost-max', '200')),
        auto_ghost_wins: !has('--no-auto'),
        martingale_enabled: !has('--no-mart'),
        martingale_multiplier: parseInt(get('--mart-mult', '11')),
        max_martingale_steps: parseInt(get('--mart-steps', '3')),
        take_profit: parseFloat(get('--tp', '10')),
        stop_loss: parseFloat(get('--sl', '50')),
        max_stake: parseFloat(get('--max-stake', '500')),
        delay_between_trades: parseInt(get('--delay', '1500')),
        cooldown_after_max_loss: parseInt(get('--cooldown', '30000')),
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getLastDigit(price) {
    const s = String(price);
    return parseInt(s.charAt(s.length - 1), 10);
}

function formatMoney(v) {
    const sign = v >= 0 ? '+' : '';
    return `${sign}$${v.toFixed(2)}`;
}

function formatDuration(ms) {
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

        // Ticks — sliding window of exactly tick_history_size
        this.tickHistory = [];

        // Analysis
        this.targetDigit = -1;
        this.digitFrequencies = new Array(10).fill(0);
        this.frequencyMet = false;

        // Ghost
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;

        // ── AUTO GHOST WINS LOGIC ──
        // winsRequired is NULL at the start of every trade cycle.
        // When ghost trading LOSES after N consecutive wins:
        //   → proposed = N - 1  (e.g. 4 wins before loss → proposed = 3)
        //   → simulate tick history with proposed: every time we accumulate
        //     `proposed` consecutive DIFFER wins the NEXT tick is a simulated trade.
        //     If ANY such trade would LOSE → NOT SAFE.
        //   → If SAFE: set winsRequired = proposed, continue ghost until reaching it, then LIVE.
        //   → If NOT SAFE: keep winsRequired = null, wait for next ghost loss to try again.
        // If winsRequired is set but ghost loses before reaching it:
        //   → update winsRequired with new proposed from that loss, check safety again.
        // After LIVE trade executes → reset winsRequired = null for the next trade cycle.
        this.winsRequired = null;

        // Trading
        this.currentStake = config.base_stake;
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.isTradeActive = false;
        this.lastBuyPrice = 0;
        this.lastContractId = null;

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
    }

    // ── Validation ──────────────────────────────────────────────────────────────
    validate() {
        const errors = [];
        if (!this.config.api_token)
            errors.push('--token is required. Get one at https://app.deriv.com/account/api-token');
        if (this.config.base_stake < 0.35)
            errors.push('--stake must be at least 0.35');
        if (this.config.tick_history_size < 10)
            errors.push('--history must be at least 10');
        if (this.config.analysis_window < 10)
            errors.push('--window must be at least 10');
        if (this.config.analysis_window > this.config.tick_history_size)
            errors.push('--window cannot be larger than --history');
        if (this.config.take_profit <= 0)
            errors.push('--tp must be positive');
        if (this.config.stop_loss <= 0)
            errors.push('--sl must be positive');
        return errors;
    }

    // ── Start ────────────────────────────────────────────────────────────────────
    start() {
        const errors = this.validate();
        if (errors.length) {
            errors.forEach(e => logError(e));
            process.exit(1);
        }

        this.printBanner();
        this.connectWS();
    }

    // ── Banner ───────────────────────────────────────────────────────────────────
    printBanner() {
        const cfg = this.config;
        console.log('');
        console.log(bold(cyan('══════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT  —  Deriv Digit Differ      ')));
        console.log(bold(cyan('══════════════════════════════════════════════════════')));
        console.log(`  Symbol         : ${bold(cfg.symbol)}`);
        console.log(`  Base Stake     : ${bold('$' + cfg.base_stake.toFixed(2))}`);
        console.log(`  Tick History   : ${bold(cfg.tick_history_size)} ticks`);
        console.log(`  Analysis Window: ${bold(cfg.analysis_window)} ticks`);
        console.log(`  Freq Threshold : ${bold(cfg.frequency_threshold)}`);
        console.log(`  Ghost Trading  : ${cfg.ghost_enabled ? green('ON') + (cfg.auto_ghost_wins ? ' (AUTO wins)' : ` (${cfg.ghost_wins_required} wins)`) : red('OFF')}`);
        console.log(`  Martingale     : ${cfg.martingale_enabled ? green('ON') + ` (${cfg.max_martingale_steps} steps × ${cfg.martingale_multiplier}x)` : red('OFF')}`);
        console.log(`  Take Profit    : ${green('$' + cfg.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss      : ${red('$' + cfg.stop_loss.toFixed(2))}`);
        console.log(`  Max Stake      : $${cfg.max_stake.toFixed(2)}`);
        console.log(bold(cyan('══════════════════════════════════════════════════════')));
        console.log('');

        if (cfg.martingale_enabled && cfg.max_martingale_steps >= 1) {
            let risk = 0;
            for (let i = 0; i < cfg.max_martingale_steps; i++) {
                risk += cfg.base_stake * Math.pow(cfg.martingale_multiplier, i);
            }
            logRisk(`⚠️  Martingale worst case: ${cfg.max_martingale_steps} consecutive losses ≈ ${red('$' + risk.toFixed(2))} (${cfg.martingale_multiplier}x)`);
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

            // Keep-alive ping every 30 s
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN)
                    this.send({ ping: 1 });
            }, 30_000);

            logApi('Authenticating...');
            this.send({ authorize: this.config.api_token });
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                this.handleMessage(msg);
            } catch (e) {
                logError(`Parse error: ${e.message}`);
            }
        });

        this.ws.on('close', (code) => {
            logApi(`⚠️  Connection closed (code: ${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.botState !== STATE.STOPPED) this.attemptReconnect();
        });

        this.ws.on('error', (e) => {
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
                logError('Invalid API token. Please check your --token value.');
                this.stop('Authentication failed');
                break;
            case 'RateLimit':
                logError('Rate limited. Pausing 10 s...');
                setTimeout(() => {
                    if (this.botState !== STATE.STOPPED) {
                        this.isTradeActive = false;
                        this.executeTradeFlow();
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
                    if (this.martingaleStep > 0) {
                        setTimeout(() => this.executeTradeFlow(), this.config.delay_between_trades);
                    } else {
                        this.botState = STATE.ANALYZING;
                    }
                }
                break;
        }
    }

    // ── Auth ────────────────────────────────────────────────────────────────────
    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        this.sessionStartTime = Date.now();

        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Authenticated')} | Account: ${bold(this.accountId)} ${isDemo ? '(Demo)' : red('(REAL)')} | Balance: ${green('$' + this.accountBalance.toFixed(2))}`);
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

    // ── Tick History (initial load) ──────────────────────────────────────────────
    handleTickHistory(msg) {
        if (!msg.history || !msg.history.prices) {
            logError('Failed to fetch tick history. Falling back to live collection...');
            this.subscribeToLiveTicks();
            return;
        }

        const prices = msg.history.prices;
        const digits = prices.map(p => getLastDigit(p));
        this.tickHistory = digits.slice(-this.config.tick_history_size);

        logBot(`${green('✅ Loaded ' + this.tickHistory.length + ' historical ticks')}`);
        logTick(`History: [${this.tickHistory.join(', ')}]`);

        this.subscribeToLiveTicks();

        if (this.tickHistory.length >= this.config.analysis_window) {
            this.botState = STATE.ANALYZING;
            this.analyzeDigits();
            // No live tick yet so we wait for the first live tick to call processPostAnalysis
        } else {
            logBot(`Collecting more ticks (${this.tickHistory.length}/${this.config.analysis_window})...`);
        }
    }

    subscribeToLiveTicks() {
        logBot(`Subscribing to live ticks for ${bold(this.config.symbol)}...`);
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    // ── Balance ─────────────────────────────────────────────────────────────────
    handleBalance(msg) {
        if (msg.balance) {
            this.accountBalance = parseFloat(msg.balance.balance);
        }
    }

    // ── Live Tick ────────────────────────────────────────────────────────────────
    handleTick(msg) {
        if (!msg.tick || this.botState === STATE.STOPPED) return;

        const price = msg.tick.quote;
        const lastDigit = getLastDigit(price);

        // Push and maintain sliding window
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.tick_history_size)
            this.tickHistory = this.tickHistory.slice(-this.config.tick_history_size);

        const count = this.tickHistory.length;

        if (this.botState === STATE.COLLECTING_TICKS) {
            logTick(`Price: ${price} | Digit: ${bold(lastDigit)} | Ticks: ${count}/${this.config.tick_history_size}`);
        }

        switch (this.botState) {
            case STATE.COLLECTING_TICKS:
                if (count >= this.config.analysis_window) {
                    this.botState = STATE.ANALYZING;
                    this.analyzeDigits();
                    this.processPostAnalysis(lastDigit);
                }
                break;

            case STATE.ANALYZING:
                this.analyzeDigits();
                this.processPostAnalysis(lastDigit);
                break;

            case STATE.GHOST_TRADING:
                this.analyzeDigits();
                this.runGhostCheck(lastDigit);
                break;

            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                // Just collecting ticks — no action
                break;
        }
    }

    // ── Digit Analysis ────────────────────────────────────────────────────────
    analyzeDigits() {
        this.digitFrequencies = new Array(10).fill(0);
        const window = this.tickHistory.slice(-this.config.analysis_window);
        for (const d of window) this.digitFrequencies[d]++;

        let maxFreq = 0, maxDigit = 0;
        const expected = this.config.analysis_window / 10;

        for (let i = 0; i <= 9; i++) {
            if (this.digitFrequencies[i] > maxFreq) {
                maxFreq = this.digitFrequencies[i];
                maxDigit = i;
            }
        }

        this.targetDigit = maxDigit;
        const excess = maxFreq - expected;
        this.frequencyMet = excess >= this.config.frequency_threshold;

        const confidence = this.frequencyMet ? 'HIGH'
            : excess >= this.config.frequency_threshold / 2 ? 'MEDIUM' : 'LOW';

        const freqStr = this.digitFrequencies.map((f, i) =>
            i === this.targetDigit ? cyan(bold(`${i}:${f}`)) : dim(`${i}:${f}`)
        ).join(', ');

        logAnalysis(
            `{${freqStr}} | 🎯 Target: ${bold(this.targetDigit)} (${maxFreq}x, exp ${expected.toFixed(1)}, ${confidence})` +
            (!this.frequencyMet ? ` ${red('[THRESHOLD NOT MET]')}` : '')
        );

        if (!this.frequencyMet) {
            logAnalysis(dim(`⏳ Waiting for frequency threshold (need excess ≥ ${this.config.frequency_threshold}, got ${excess.toFixed(1)})`));
        }

        return this.frequencyMet;
    }

    // ── Post-Analysis Flow ────────────────────────────────────────────────────
    processPostAnalysis(lastDigit) {
        if (!this.frequencyMet) {
            this.botState = STATE.ANALYZING;
            return;
        }

        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            if (this.ghostRoundsPlayed === 0) {
                if (this.config.auto_ghost_wins) {
                    logGhost(`Starting ghost phase — ${magenta('AUTO')} mode. Wins Required = ${yellow('NULL')} (waiting for loss)`);
                } else {
                    logGhost(`Starting ghost phase — need ${bold(this.config.ghost_wins_required)} consecutive wins`);
                    this.winsRequired = this.config.ghost_wins_required;
                }
            }
            this.runGhostCheck(lastDigit);
        } else {
            this.executeTradeFlow();
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  AUTO GHOST WINS — SAFETY CHECK (Simulation-Based)
    //
    //  Walk through tick history sequentially.
    //  Every time we accumulate `winsRequired` consecutive DIFFER wins,
    //  the NEXT tick is a simulated trade result.
    //    • If that tick == targetDigit  → trade LOSES → NOT SAFE
    //    • If that tick != targetDigit  → trade WINS  → skip trade tick, reset counter, continue
    //  If ALL simulated trades WIN and at least 1 opportunity was found → SAFE
    // ══════════════════════════════════════════════════════════════════════════
    isWinsRequiredSafe(winsRequired) {
        if (winsRequired < 1) return false;
        if (this.targetDigit < 0) return false;
        if (this.tickHistory.length < winsRequired + 1) return false;

        const target = this.targetDigit;
        let consecutive = 0;
        let tradeOpportunities = 0;
        let tradeLosses = 0;
        let i = 0;

        while (i < this.tickHistory.length) {
            const digit = this.tickHistory[i];

            if (digit !== target) {
                // DIFFER win → increment consecutive counter
                consecutive++;

                if (consecutive >= winsRequired) {
                    // We have enough consecutive wins — simulate placing a trade.
                    // The NEXT tick determines whether we win or lose.
                    if (i + 1 < this.tickHistory.length) {
                        tradeOpportunities++;
                        const tradeTick = this.tickHistory[i + 1];

                        if (tradeTick === target) {
                            // Trade would LOSE
                            tradeLosses++;
                            logGhost(
                                dim(`  Sim ${winsRequired}: ${winsRequired} wins at [${i - winsRequired + 1}..${i}], `) +
                                dim(`trade tick [${i + 1}] = ${tradeTick} → `) +
                                red('LOSS — NOT SAFE')
                            );
                            return false;
                        }
                        // Trade wins — skip trade tick, reset counter
                        i += 2;
                        consecutive = 0;
                        continue;
                    }
                    // No next tick to verify — stop scanning
                    break;
                }
            } else {
                // DIFFER loss → reset consecutive counter
                consecutive = 0;
            }
            i++;
        }

        if (tradeOpportunities > 0) {
            logGhost(
                dim(`  Sim ${winsRequired}: ${tradeOpportunities} opp, `) +
                green(`${tradeOpportunities - tradeLosses}W`) +
                dim('/') +
                (tradeLosses > 0 ? red(`${tradeLosses}L`) : dim('0L')) +
                ` → ` +
                (tradeLosses === 0 ? green('SAFE ✓') : red('NOT SAFE ✗'))
            );
        } else {
            logGhost(dim(`  Sim ${winsRequired}: no trade opportunities in history — insufficient data`));
        }

        return tradeOpportunities > 0 && tradeLosses === 0;
    }

    // ── Ghost Loss Handler ────────────────────────────────────────────────────
    //
    //  Called every time ghost trading loses.
    //
    //  Logic:
    //   1. proposed = achievedWins - 1
    //   2. If proposed < 1 → set winsRequired = null (can't determine safely)
    //   3. Simulate tick history with proposed
    //   4. If SAFE  → set winsRequired = proposed (continue ghost until reaching it)
    //   5. If NOT SAFE → set winsRequired = null (wait for next ghost loss)
    //
    handleGhostLoss() {
        const achievedWins = this.ghostConsecutiveWins;

        if (!this.config.auto_ghost_wins) {
            // Manual mode — always use the configured value
            this.winsRequired = this.config.ghost_wins_required;
            logGhost(`Manual mode: Wins Required = ${bold(this.winsRequired)}`);
            return;
        }

        const proposed = achievedWins - 1;

        if (proposed < 1) {
            this.winsRequired = null;
            logGhost(
                `Ghost loss after ${bold(achievedWins)} win(s). ` +
                `Proposed ${proposed} is too low. ` +
                `Wins Required = ${yellow('NULL')} (waiting for next loss)`
            );
            return;
        }

        logGhost(
            `🎯 Ghost loss after ${bold(achievedWins)} wins. ` +
            `Proposed Wins Required = ${cyan(proposed)}. ` +
            `Simulating through tick history...`
        );

        const safe = this.isWinsRequiredSafe(proposed);

        if (safe) {
            this.winsRequired = proposed;
            logGhost(
                `${green('✅ ' + proposed + ' is SAFE!')} ` +
                `Every simulated trade in history would WIN. ` +
                `Wins Required = ${bold(proposed)}. ` +
                `Continue ghost until ${proposed} wins, then go LIVE.`
            );
        } else {
            this.winsRequired = null;
            logGhost(
                `${red('❌ ' + proposed + ' is NOT SAFE!')} ` +
                `A simulated trade in history would LOSE. ` +
                `Wins Required = ${yellow('NULL')}. Waiting for next ghost loss...`
            );
        }
    }

    // ── Ghost Check (called on each tick during ghost phase) ──────────────────
    runGhostCheck(lastDigit) {
        if (this.botState !== STATE.GHOST_TRADING) return;

        if (!this.frequencyMet) {
            logGhost(dim('⏳ Frequency threshold not met — ghost trading paused'));
            this.botState = STATE.ANALYZING;
            return;
        }

        this.ghostRoundsPlayed++;
        const wouldWin = lastDigit !== this.targetDigit;

        if (wouldWin) {
            this.ghostConsecutiveWins++;
            const winsDisplay = this.winsRequired !== null ? this.winsRequired : '?';
            logGhost(
                `DIFFER from ${bold(this.targetDigit)} | Tick: ${bold(lastDigit)} | ` +
                green('✅ WIN') +
                ` (${this.ghostConsecutiveWins}/${winsDisplay})`
            );

            // If winsRequired is set and we've reached it → go LIVE
            if (this.winsRequired !== null && this.ghostConsecutiveWins >= this.winsRequired) {
                this.ghostConfirmed = true;
                logGhost(
                    green(bold(`✅ Ghost confirmed! Reached ${this.winsRequired} wins. Going LIVE!`))
                );
                this.executeTradeFlow();
                return;
            }
            // winsRequired is null → keep ghost trading until we lose

        } else {
            // ── Ghost LOSS ─────────────────────────────────────────────────────────
            logGhost(
                `DIFFER from ${bold(this.targetDigit)} | Tick: ${bold(lastDigit)} | ` +
                red('❌ LOSS') +
                ` after ${this.ghostConsecutiveWins} wins`
            );

            // Apply ghost loss logic — sets or resets this.winsRequired
            this.handleGhostLoss();

            // Reset consecutive win counter and continue ghost trading
            this.ghostConsecutiveWins = 0;

            const winsDisplay = this.winsRequired !== null
                ? bold(this.winsRequired)
                : yellow('NULL') + ' (waiting for next loss)';
            logGhost(`Continuing ghost. Wins Required = ${winsDisplay}`);
        }

        // Max ghost rounds guard
        if (!this.ghostConfirmed && this.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(
                yellow(`⚠️  Max ghost rounds (${this.config.ghost_max_rounds}) reached. Re-analyzing...`)
            );
            this.resetGhost();
            this.botState = STATE.ANALYZING;
        }
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed = 0;
        this.ghostConfirmed = false;
        this.winsRequired = null; // Always reset to null for new trade cycle
    }

    // ── Trade Execution Flow ──────────────────────────────────────────────────
    async executeTradeFlow() {
        if (this.isTradeActive || this.botState === STATE.STOPPED) return;

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

        if (this.totalTrades > 0) {
            this.botState = STATE.PLACING_TRADE;
            await sleep(this.config.delay_between_trades);
        }

        if (this.botState === STATE.STOPPED) return;
        this.placeTrade();
    }

    // ── Place Trade ───────────────────────────────────────────────────────────
    placeTrade() {
        this.isTradeActive = true;
        this.botState = STATE.PLACING_TRADE;

        const stepInfo = this.config.martingale_enabled ? ` | Mart Step: ${this.martingaleStep}` : '';
        const ghostInfo = this.config.auto_ghost_wins && this.config.ghost_enabled && this.winsRequired !== null
            ? ` | Ghost Safe: ${this.winsRequired}` : '';

        logTrade(
            `🎯 DIFFER from ${bold(this.targetDigit)} | ` +
            `Stake: ${bold('$' + this.currentStake.toFixed(2))}${stepInfo}${ghostInfo}`
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

    // ── Buy Response ──────────────────────────────────────────────────────────
    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice = parseFloat(msg.buy.buy_price);
        const payout = parseFloat(msg.buy.payout);
        logTrade(dim(`Contract ${this.lastContractId} | Cost: $${this.lastBuyPrice.toFixed(2)} | Payout: $${payout.toFixed(2)}`));
    }

    // ── Transaction (Result) ──────────────────────────────────────────────────
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

    // ── Process Win ───────────────────────────────────────────────────────────
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

        this.resetMartingale();
        if (this.config.ghost_enabled) this.resetGhost(); // winsRequired → null for new cycle
    }

    // ── Process Loss ──────────────────────────────────────────────────────────
    processLoss(lostAmount, _resultDigit) {
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
            `${red('❌ LOSS!')} Loss: ${red('-$' + lostAmount.toFixed(2))} | ` +
            `P/L: ${plStr} | Bal: $${this.accountBalance.toFixed(2)}${martInfo}`
        );
    }

    // ── Decide Next Action ────────────────────────────────────────────────────
    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }

        // Martingale recovery — skip ghost phase
        if (this.config.martingale_enabled &&
            this.martingaleStep > 0 &&
            this.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim('📈 Martingale recovery — next trade...'));
            this.botState = STATE.ANALYZING;
            this.ghostConfirmed = true; // skip ghost during recovery
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

        // New trade cycle — reset ghost (winsRequired → null)
        if (this.config.ghost_enabled) this.resetGhost();
        this.botState = STATE.ANALYZING;
    }

    // ── Stake Calculation ─────────────────────────────────────────────────────
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
            `= $${calc.toFixed(2)} | Final: $${final.toFixed(2)}`
        ));
        return final;
    }

    // ── Risk Limits ───────────────────────────────────────────────────────────
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

    // ── Martingale Reset ──────────────────────────────────────────────────────
    resetMartingale() {
        this.martingaleStep = 0;
        this.totalMartingaleLoss = 0;
        this.currentStake = this.config.base_stake;
    }

    // ── Cooldown ──────────────────────────────────────────────────────────────
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

    // ── Stop ──────────────────────────────────────────────────────────────────
    stop(reason = 'User stopped') {
        this.botState = STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping bot...')} Reason: ${reason}`);

        if (this.cooldownTimer) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) { /* ignore */ }
            setTimeout(() => { try { this.ws.close(); } catch (_) { /* ignore */ } }, 500);
        }

        this.printFinalStats();
        setTimeout(() => process.exit(0), 1000);
    }

    // ── Final Stats ───────────────────────────────────────────────────────────
    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plColour = this.sessionProfit >= 0 ? green : red;

        console.log('');
        logStats(bold('═══════════════════════════════════════════'));
        logStats(bold('          SESSION SUMMARY                  '));
        logStats(bold('═══════════════════════════════════════════'));
        logStats(`  Duration:         ${bold(formatDuration(dur))}`);
        logStats(`  Symbol:           ${bold(this.config.symbol)}`);
        logStats(`  Total Trades:     ${bold(this.totalTrades)}`);
        logStats(`  Wins:             ${green(this.totalWins)}`);
        logStats(`  Losses:           ${red(this.totalLosses)}`);
        logStats(`  Win Rate:         ${bold(wr + '%')}`);
        logStats(`  Session P/L:      ${plColour(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Starting Balance: $${this.startingBalance.toFixed(2)}`);
        logStats(`  Final Balance:    $${this.accountBalance.toFixed(2)}`);
        logStats(`  Avg/Trade:        ${formatMoney(avg)}`);
        logStats(`  Largest Win:      ${green('+$' + this.largestWin.toFixed(2))}`);
        logStats(`  Largest Loss:     ${red('-$' + this.largestLoss.toFixed(2))}`);
        logStats(`  Max Win Streak:   ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak:  ${red(this.maxLossStreak)}`);
        logStats(`  Max Martingale:   Step ${this.maxMartingaleReached}`);
        logStats(bold('═══════════════════════════════════════════'));
        console.log('');
    }
}

// ── Entry Point ───────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();

    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`
${bold(cyan('Romanian Ghost Bot — Node.js CLI'))}

Usage:
  node romanian-ghost-bot.js --token YOUR_API_TOKEN [options]

Options:
  ${cyan('--token')}       ${bold('YOUR_TOKEN')}   Deriv API token (required)
  ${cyan('--appid')}       1089           Deriv App ID
  ${cyan('--symbol')}      R_100          Trading symbol
  ${cyan('--stake')}       0.35           Base stake amount ($)
  ${cyan('--history')}     30             Tick history window size
  ${cyan('--window')}      30             Analysis window (must be <= history)
  ${cyan('--threshold')}   2              Frequency threshold (excess over expected)
  ${cyan('--no-ghost')}                   Disable ghost trading
  ${cyan('--ghost-wins')}  3              Fallback wins required (manual mode)
  ${cyan('--ghost-max')}   200            Max ghost rounds before re-analysis
  ${cyan('--no-auto')}                    Disable auto ghost wins calculation
  ${cyan('--no-mart')}                    Disable Martingale
  ${cyan('--mart-steps')}  3              Max Martingale steps
  ${cyan('--mart-mult')}   11             Martingale multiplier
  ${cyan('--tp')}          10             Take profit ($)
  ${cyan('--sl')}          50             Stop loss ($)
  ${cyan('--max-stake')}   500            Maximum allowed stake ($)
  ${cyan('--delay')}       1500           Delay between trades (ms)
  ${cyan('--cooldown')}    30000          Cooldown after max Martingale (ms)
  ${cyan('--help')}                       Show this help

Examples:
  node romanian-ghost-bot.js --token YOUR_TOKEN
  node romanian-ghost-bot.js --token YOUR_TOKEN --symbol R_50 --stake 0.50 --tp 20 --sl 30
  node romanian-ghost-bot.js --token YOUR_TOKEN --no-ghost --no-mart --symbol 1HZ100V
`);
        process.exit(0);
    }

    const bot = new RomanianGhostBot(config);

    // Handle Ctrl+C / SIGTERM gracefully
    process.on('SIGINT', () => { console.log(''); bot.stop('SIGINT (Ctrl+C)'); });
    process.on('SIGTERM', () => { bot.stop('SIGTERM'); });
    process.on('uncaughtException', (e) => {
        logError(`Uncaught exception: ${e.message}`);
        logError(e.stack || '');
        bot.stop('Uncaught exception');
    });

    bot.start();
})();
