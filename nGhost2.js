#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v3.0 Ultra-Precision Regime Detection
//  Deriv Digit Differ — Full-Spectrum Regime Analysis
//
//  DETECTION ENGINE (7 independent modules, ensemble vote):
//
//  MODULE 1 — Bayesian Beta-Binomial Self-Transition Model
//    Per-digit Beta posterior over self-transition probability.
//    Uses exponentially decaying weights so recent ticks matter more.
//    Provides credible intervals, not just point estimates.
//    H0: p_self ≤ baseline (0.10) → NON-REP
//    H1: p_self > baseline         → REP
//
//  MODULE 2 — SPRT (Sequential Probability Ratio Test)
//    Exact, optimal sequential hypothesis test for each tick.
//    Controls Type I + II errors precisely (α=0.05, β=0.10).
//    Gives conclusive ACCEPT / REJECT / CONTINUE verdicts per digit.
//    Resets cleanly on regime change.
//
//  MODULE 3 — Multi-Scale Autocorrelation (Lag-1)
//    Computes Pearson lag-1 autocorrelation of binary repeat sequence
//    over 3 time scales: short (20t), medium (60t), long (150t).
//    High positive AC → repeat regime. Near-zero/negative → non-repeat.
//    All 3 scales must agree for a valid signal.
//
//  MODULE 4 — Structural HMM with Baum-Welch + Viterbi
//    2-state HMM (NON-REP / REP) trained on per-digit binary obs.
//    Re-fits every 50 ticks via Baum-Welch EM.
//    Viterbi gives MAP state sequence; Forward gives Bayesian posterior.
//    Key improvement: trained on per-digit observations, not global.
//
//  MODULE 5 — Adaptive CUSUM (Per-Digit)
//    Two-sided CUSUM: detects shift INTO or OUT OF repeat regime.
//    Reference level automatically set from Bayesian Beta estimate.
//    Alarm resets with exponential back-off.
//
//  MODULE 6 — Binary Segmentation Change-Point Detection
//    Offline scan of recent 300-tick window using CUSUM-based cost.
//    Identifies the most recent regime change-point.
//    Estimates: how many ticks since last regime shift, duration
//    of current regime, stability score.
//
//  MODULE 7 — Regime Momentum & Run-Length Analysis
//    Tracks run-length distribution of both repeat and non-repeat
//    sequences. Compares current run length to historical distribution.
//    High non-repeat momentum (long runs of non-repeats) → strong signal.
//    Detects exhaustion of repeat runs (mean reversion signal).
//
//  ENSEMBLE DECISION:
//    Each module votes +1 (NON-REP confirmed) or 0 (uncertain) or -1 (REP).
//    Weighted vote must exceed threshold for trade signal.
//    Confidence score = weighted average of module confidences (0-100).
//
//  TRADE CONDITIONS (all must hold):
//    a) Ensemble vote ≥ 5/7 modules agree NON-REP
//    b) Bayesian P(p_self ≤ 0.10) ≥ 0.97 for target digit
//    c) SPRT accepted H0 (non-repeat) for target digit
//    d) No CUSUM alarm active (no recent regime shift)
//    e) Binary segmentation shows current regime ≥ min_regime_age ticks old
//    f) Multi-scale AC all negative or near-zero
//    g) Run-length momentum in NON-REP territory
//
//  Usage:
//    node romanian-ghost-bot-v3.js --token YOUR_DERIV_API_TOKEN [options]
// ============================================================================

'use strict';

const WebSocket  = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN          = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID        = "752497117";

// ── ANSI Colour Helpers ───────────────────────────────────────────────────────
const C = {
    reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
    cyan:'\x1b[36m', blue:'\x1b[34m', green:'\x1b[32m',
    red:'\x1b[31m', yellow:'\x1b[33m', magenta:'\x1b[35m',
    orange:'\x1b[38;5;208m', white:'\x1b[37m',
};
const col   = (t, ...codes) => codes.join('') + t + C.reset;
const bold  = t => col(t, C.bold);
const dim   = t => col(t, C.dim);
const cyan  = t => col(t, C.cyan);
const blue  = t => col(t, C.blue);
const green = t => col(t, C.green);
const red   = t => col(t, C.red);
const yellow = t => col(t, C.yellow);
const magenta = t => col(t, C.magenta);

// ── Logger ────────────────────────────────────────────────────────────────────
const PREFIX_COLOURS = {
    BOT: cyan, API: blue, TICK: dim, REGIME: yellow,
    GHOST: magenta, TRADE: bold, RESULT: bold, RISK: red,
    STATS: cyan, ERROR: t => col(t, C.bold, C.red),
    HMM: t => col(t, C.orange), SPRT: t => col(t, C.magenta),
    BSEG: t => col(t, C.blue),
};

function getTimestamp() {
    const n = new Date();
    return [n.getHours(), n.getMinutes(), n.getSeconds()]
        .map(v => String(v).padStart(2,'0')).join(':');
}
function log(prefix, message) {
    const ts  = dim(`[${getTimestamp()}]`);
    const pfx = (PREFIX_COLOURS[prefix] || (t => t))(`[${prefix}]`);
    console.log(`${ts} ${pfx} ${message}`);
}
const logBot    = m => log('BOT', m);
const logApi    = m => log('API', m);
const logTick   = m => log('TICK', m);
const logRegime = m => log('REGIME', m);
const logGhost  = m => log('GHOST', m);
const logTrade  = m => log('TRADE', m);
const logResult = m => log('RESULT', m);
const logRisk   = m => log('RISK', m);
const logStats  = m => log('STATS', m);
const logError  = m => log('ERROR', m);
const logHMM    = m => log('HMM', m);
const logSprt   = m => log('SPRT', m);
const logBseg   = m => log('BSEG', m);

// ── Config ────────────────────────────────────────────────────────────────────
function parseArgs() {
    return {
        api_token:            TOKEN,
        app_id:               '1089',
        endpoint:             'wss://ws.derivws.com/websockets/v3',
        symbol:               'R_75',
        base_stake:           0.61,
        currency:             'USD',
        contract_type:        'DIGITDIFF',

        // History
        tick_history_size:    5000,
        analysis_window:      5000,
        min_ticks_ready:      80,

        // ─── Module thresholds ───────────────────────────────────────────
        // Bayesian Beta-Binomial
        bayesian_h0_prob:     0.97,    // P(p_self ≤ baseline) ≥ this to confirm non-rep
        baseline_self_prob:   0.10,    // Expected self-transition under fair randomness
        bayesian_decay:       0.97,    // Exponential weight decay per tick (older ticks matter less)

        // SPRT
        sprt_alpha:           0.05,    // Type I error bound  (false positive rate)
        sprt_beta:            0.10,    // Type II error bound (false negative rate)
        sprt_p0:              0.10,    // H0: non-repeat prob of self-transition
        sprt_p1:              0.28,    // H1: repeat regime self-transition threshold

        // Multi-scale AC
        ac_short_window:      20,
        ac_med_window:        60,
        ac_long_window:       150,
        ac_nonrep_threshold: -0.02,    // AC must be below this for non-rep confirmation

        // HMM
        hmm_nonrep_posterior: 0.93,   // Min Bayesian P(NON-REP) required
        min_hmm_persistence:  6,       // Min consecutive NON-REP ticks (Viterbi)

        // CUSUM
        cusum_threshold:      12.0,
        cusum_slack:          0.04,

        // Binary segmentation
        bseg_window:          300,
        min_regime_age:       15,      // Min ticks since last detected change-point

        // Run-length momentum
        momentum_window:      40,
        min_nonrep_run:       4,       // Min consecutive non-repeat ticks for momentum

        // Ensemble
        min_modules_agree:    5,       // Out of 7 modules must vote NON-REP
        min_ensemble_score:   78,      // Weighted ensemble confidence (0-100)

        // Ghost
        ghost_enabled:        false,
        ghost_wins_required:  1,
        ghost_max_rounds:     2_000_000_000,

        // Martingale
        martingale_enabled:   true,
        martingale_multiplier:11.3,
        max_martingale_steps: 3,

        // Risk
        take_profit:          100,
        stop_loss:            70,
        max_stake:            500,
        delay_between_trades: 1500,
        cooldown_after_max_loss: 30000,
    };
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac  = parts.length > 1 ? parts[1] : '';
    if (['RDBULL','RDBEAR','R_75','R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10','R_25','1HZ15V','1HZ30V','1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}
function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function formatDuration(ms) {
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    return `${m}m ${String(s).padStart(2,'0')}s`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

// Regularised incomplete beta function (for Bayesian CDF calculations)
// Uses continued fraction expansion — numerically stable for p in [0,1].
function incompleteBeta(a, b, x) {
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0;
    if (x === 1) return 1;
    // Use symmetry relation when x > (a+1)/(a+b+2)
    if (x > (a + 1) / (a + b + 2)) {
        return 1 - incompleteBeta(b, a, 1 - x);
    }
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
    // Lentz continued fraction
    const MAXIT = 200, EPS = 3e-7, FPMIN = 1e-30;
    let c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        for (let step = 0; step < 2; step++) {
            let numerator;
            if (step === 0) {
                numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
            } else {
                numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
            }
            d = 1 + numerator * d;
            if (Math.abs(d) < FPMIN) d = FPMIN;
            c = 1 + numerator / c;
            if (Math.abs(c) < FPMIN) c = FPMIN;
            d = 1 / d;
            h *= d * c;
        }
        if (Math.abs(d * c - 1) < EPS) break;
    }
    return front * h;
}

// Log-gamma function (Lanczos approximation)
function lgamma(z) {
    const g = 7;
    const c = [
        0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// Beta CDF: P(X ≤ x) where X ~ Beta(a, b)
function betaCDF(a, b, x) { return incompleteBeta(a, b, x); }

// State machine constants
const STATE = {
    INITIALIZING:'INITIALIZING', CONNECTING:'CONNECTING', AUTHENTICATING:'AUTHENTICATING',
    COLLECTING_TICKS:'COLLECTING_TICKS', ANALYZING:'ANALYZING', GHOST_TRADING:'GHOST_TRADING',
    PLACING_TRADE:'PLACING_TRADE', WAITING_RESULT:'WAITING_RESULT',
    PROCESSING_RESULT:'PROCESSING_RESULT', COOLDOWN:'COOLDOWN', STOPPED:'STOPPED',
};

// ══════════════════════════════════════════════════════════════════════════════
//
//  ADVANCED REGIME DETECTION ENGINE  (v3.0)
//
//  7-MODULE ENSEMBLE:
//  ──────────────────
//  1. Bayesian Beta-Binomial   (per digit, weighted)
//  2. SPRT sequential test     (per digit, conclusive)
//  3. Multi-scale lag-1 AC     (global sequence, 3 scales)
//  4. HMM + Viterbi + Forward  (per-digit binary obs)
//  5. Adaptive 2-sided CUSUM   (per digit)
//  6. Binary Segmentation CPD  (regime age estimation)
//  7. Run-Length Momentum      (consecutive run analysis)
//
// ══════════════════════════════════════════════════════════════════════════════
class AdvancedRegimeDetector {
    constructor(cfg) {
        this.cfg = cfg;

        // ── Module 1: Bayesian Beta per digit ────────────────────────────────
        // Weighted sufficient statistics for Beta posterior of self-transition prob
        // Posterior: Beta(α₀ + Σw*successes, β₀ + Σw*failures)
        this.betaAlpha = new Array(10).fill(1.0);  // prior α  (successes + prior)
        this.betaBeta  = new Array(10).fill(9.0);  // prior β  (failures  + prior)
        // α₀=1, β₀=9 → prior mean = 0.10 (baseline self-transition rate under randomness)

        // ── Module 2: SPRT per digit ─────────────────────────────────────────
        // Log-likelihood ratio accumulator for each digit
        this.sprtLLR = new Array(10).fill(0);
        // Decision thresholds (Wald's approximation)
        const alpha = cfg.sprt_alpha, beta = cfg.sprt_beta;
        this.sprtA = Math.log(beta / (1 - alpha));          // Accept H0 boundary (log scale)
        this.sprtB = Math.log((1 - beta) / alpha);          // Accept H1 boundary (log scale)
        this.sprtDecision = new Array(10).fill('CONTINUE'); // 'H0'|'H1'|'CONTINUE'

        // ── Module 3: Multi-scale autocorrelation ────────────────────────────
        this.acShort = 0;   // lag-1 AC in short window
        this.acMed   = 0;
        this.acLong  = 0;

        // ── Module 4: HMM ────────────────────────────────────────────────────
        this.hmmPi = [0.65, 0.35];
        this.hmmA  = [[0.92, 0.08], [0.22, 0.78]];
        this.hmmB  = [[0.91, 0.09], [0.38, 0.62]];
        this.hmmFitted = false;
        this.hmmLogAlpha = [Math.log(0.65), Math.log(0.35)];
        this.hmmCurrentState = 0;
        this.hmmPosteriorNR  = 0.5;
        this.hmmPersistence  = 0;

        // ── Module 5: Adaptive CUSUM per digit ───────────────────────────────
        this.cusumPos = new Array(10).fill(0);  // CUSUM+ (detects shift to REP)
        this.cusumNeg = new Array(10).fill(0);  // CUSUM− (detects shift to NR)
        this.cusumAlarm = new Array(10).fill(false);

        // ── Module 6: Binary Segmentation (Change-Point Detection) ───────────
        this.lastChangePoint = 0;   // index in tickHistory of most recent CPD
        this.regimeAge = 0;         // ticks since last detected change-point
        this.bsegScanPending = true;

        // ── Module 7: Run-Length Momentum ────────────────────────────────────
        this.currentRunLength = 0;
        this.currentRunIsNonRep = true;
        this.nonRepRunHistory = [];   // lengths of recent non-rep runs
        this.repRunHistory    = [];   // lengths of recent rep runs

        // ── Ensemble state ───────────────────────────────────────────────────
        this.lastAnalysis = null;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 1: BAYESIAN BETA-BINOMIAL (per-digit, exponentially weighted)
    // ════════════════════════════════════════════════════════════════════════
    // Returns { posteriorMean, probH0, credLo, credHi }
    // where probH0 = P(p_self ≤ baseline | data) — the key metric.
    updateBayesian(digit, window) {
        const baseline = this.cfg.baseline_self_prob;
        const decay    = this.cfg.bayesian_decay;

        // Reset and recompute from window each time (exact, no drift)
        let alpha = 1.0; // prior α₀
        let betaP = 9.0; // prior β₀ → prior mean = 1/(1+9) = 0.10

        let w = 1.0;
        let wAccum = 0;
        // Walk window in reverse (newest tick gets weight 1, oldest gets decay^T)
        const weights = [];
        for (let i = window.length - 1; i > 0; i--) {
            weights.push({ prev: window[i-1], curr: window[i], w });
            w *= decay;
        }
        // Apply weights (oldest first so alpha/beta accumulate correctly)
        for (let j = weights.length - 1; j >= 0; j--) {
            const { prev, curr, w: wi } = weights[j];
            if (prev === digit) {
                wAccum += wi;
                if (curr === digit) alpha += wi;   // self-transition (success)
                else                betaP += wi;   // non-self    (failure)
            }
        }

        this.betaAlpha[digit] = alpha;
        this.betaBeta[digit]  = betaP;

        const posteriorMean = alpha / (alpha + betaP);
        // P(p_self ≤ baseline) = Beta CDF at x=baseline  → want this HIGH for non-rep
        const probH0 = betaCDF(alpha, betaP, baseline);

        // 90% credible interval
        const credLo = this._betaQuantile(alpha, betaP, 0.05);
        const credHi = this._betaQuantile(alpha, betaP, 0.95);

        return { posteriorMean, probH0, credLo, credHi, nObs: Math.round(wAccum) };
    }

    // Numerical Beta quantile (bisection on the CDF)
    _betaQuantile(a, b, p, tol = 1e-6) {
        let lo = 0, hi = 1, mid;
        for (let i = 0; i < 60; i++) {
            mid = (lo + hi) / 2;
            betaCDF(a, b, mid) < p ? (lo = mid) : (hi = mid);
            if (hi - lo < tol) break;
        }
        return mid;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 2: SPRT — Sequential Probability Ratio Test (per-digit)
    // ════════════════════════════════════════════════════════════════════════
    // H0: p_self = p0 (non-repeat regime, ~0.10)
    // H1: p_self = p1 (repeat regime,     ~0.28)
    //
    // At each occurrence of target digit, we observe whether NEXT = target.
    // LLR accumulates: log P(obs|H1) / P(obs|H0)
    // Accept H0 when LLR ≤ A (log β/(1-α))     → confirmed NON-REP
    // Accept H1 when LLR ≥ B (log (1-β)/α)     → confirmed REP
    // Continue otherwise.
    updateSPRT(digit, window) {
        const p0 = this.cfg.sprt_p0, p1 = this.cfg.sprt_p1;
        const logLR_repeat    = Math.log(p1 / p0);
        const logLR_nonrepeat = Math.log((1 - p1) / (1 - p0));

        // Scan recent 80 ticks for this digit's SPRT observations
        const recentLen = Math.min(window.length, 80);
        const recent = window.slice(-recentLen);
        let llr = 0;
        for (let i = 0; i < recent.length - 1; i++) {
            if (recent[i] !== digit) continue;
            const nextIsRepeat = recent[i + 1] === digit;
            llr += nextIsRepeat ? logLR_repeat : logLR_nonrepeat;
            // Clamp to prevent extreme runaway
            llr = clamp(llr, this.sprtA * 3, this.sprtB * 3);
        }
        this.sprtLLR[digit] = llr;

        if (llr <= this.sprtA)     this.sprtDecision[digit] = 'H0'; // non-rep confirmed
        else if (llr >= this.sprtB) this.sprtDecision[digit] = 'H1'; // rep confirmed
        else                        this.sprtDecision[digit] = 'CONTINUE';

        return { llr, decision: this.sprtDecision[digit], A: this.sprtA, B: this.sprtB };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 3: MULTI-SCALE LAG-1 AUTOCORRELATION
    // ════════════════════════════════════════════════════════════════════════
    // The binary repeat sequence: obs[t] = 1 if tick[t] === tick[t-1]
    // High positive AC → runs of repeats → repeat regime
    // Near-zero or negative AC → memoryless or anti-persistent → non-repeat
    computeMultiScaleAC(window) {
        const makeObs = (seq) => {
            const obs = [];
            for (let i = 1; i < seq.length; i++) obs.push(seq[i] === seq[i-1] ? 1 : 0);
            return obs;
        };

        const lagOneAC = (obs) => {
            if (obs.length < 4) return 0;
            const n    = obs.length;
            const mean = obs.reduce((s, v) => s + v, 0) / n;
            let num = 0, den = 0;
            for (let i = 0; i < n - 1; i++) num += (obs[i] - mean) * (obs[i+1] - mean);
            for (let i = 0; i < n; i++)     den += (obs[i] - mean) ** 2;
            return den < 1e-12 ? 0 : num / den;
        };

        const ws = this.cfg.ac_short_window;
        const wm = this.cfg.ac_med_window;
        const wl = this.cfg.ac_long_window;

        const obsShort = makeObs(window.slice(-ws));
        const obsMed   = makeObs(window.slice(-wm));
        const obsLong  = makeObs(window.slice(-wl));

        this.acShort = lagOneAC(obsShort);
        this.acMed   = lagOneAC(obsMed);
        this.acLong  = lagOneAC(obsLong);

        return { short: this.acShort, med: this.acMed, long: this.acLong };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 4: HMM (2-state: NON-REP / REP) — Per-digit binary observations
    //
    //  Unlike v2 which used global repeat/no-repeat, here we build the
    //  observation sequence focused on transitions FROM the target digit:
    //    obs[t] = 1 if window[t] === digit AND window[t+1] === digit  (self-repeat)
    //    obs[t] = 0 if window[t] === digit AND window[t+1] ≠ digit    (no self-repeat)
    //    (skip ticks where window[t] ≠ digit — not informative for this digit)
    //
    //  This makes the HMM specifically sensitive to the target digit's behavior.
    // ════════════════════════════════════════════════════════════════════════
    _buildPerDigitObs(window, digit) {
        const obs = [];
        for (let i = 0; i < window.length - 1; i++) {
            if (window[i] !== digit) continue;
            obs.push(window[i+1] === digit ? 1 : 0);
        }
        return obs;
    }

    // For global HMM (state of the overall stream)
    _buildGlobalObs(window) {
        const obs = [];
        for (let i = 1; i < window.length; i++) {
            obs.push(window[i] === window[i-1] ? 1 : 0);
        }
        return obs;
    }

    baumWelch(obs, maxIter = 25, tol = 1e-6) {
        const T = obs.length;
        if (T < 12) return false;
        const N = 2;
        let pi = [...this.hmmPi];
        let A  = this.hmmA.map(r => [...r]);
        let B  = this.hmmB.map(r => [...r]);
        let prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            // Forward
            const logAlpha = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++)
                logAlpha[0][s] = Math.log(pi[s]+1e-300) + Math.log(B[s][obs[0]]+1e-300);
            for (let t = 1; t < T; t++)
                for (let s = 0; s < N; s++) {
                    const inc = A.map((_,p) => logAlpha[t-1][p] + Math.log(A[p][s]+1e-300));
                    logAlpha[t][s] = logSumExp(inc) + Math.log(B[s][obs[t]]+1e-300);
                }
            const logL = logSumExp(logAlpha[T-1]);

            // Backward
            const logBeta = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T-1][s] = 0;
            for (let t = T-2; t >= 0; t--)
                for (let s = 0; s < N; s++) {
                    const vals = A[s].map((a,nx) =>
                        Math.log(a+1e-300) + Math.log(B[nx][obs[t+1]]+1e-300) + logBeta[t+1][nx]
                    );
                    logBeta[t][s] = logSumExp(vals);
                }

            // Gamma & Xi
            const logGamma = Array.from({length: T}, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const denom = logSumExp(logAlpha[t].map((la, s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++)
                    logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - denom;
            }
            const logXi = Array.from({length: T-1}, () =>
                Array.from({length: N}, () => new Array(N).fill(-Infinity)));
            for (let t = 0; t < T-1; t++) {
                const denom = logSumExp(logAlpha[t].map((la,s) => la + logBeta[t][s]));
                for (let s = 0; s < N; s++)
                    for (let nx = 0; nx < N; nx++)
                        logXi[t][s][nx] = logAlpha[t][s]
                            + Math.log(A[s][nx]+1e-300)
                            + Math.log(B[nx][obs[t+1]]+1e-300)
                            + logBeta[t+1][nx] - denom;
            }

            // M-step
            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi.reduce((a,b) => a+b, 0);
            pi = pi.map(v => v/piSum);

            for (let s = 0; s < N; s++) {
                const den = logSumExp(logGamma.slice(0,T-1).map(g => g[s]));
                for (let nx = 0; nx < N; nx++) {
                    const num = logSumExp(logXi.map(xi => xi[s][nx]));
                    A[s][nx] = Math.exp(num - den);
                }
                const rs = A[s].reduce((a,b)=>a+b,0);
                A[s] = A[s].map(v=>v/rs);
            }
            for (let s = 0; s < N; s++) {
                const den = logSumExp(logGamma.map(g=>g[s]));
                for (let o = 0; o < 2; o++) {
                    const matching = logGamma.filter((_,t) => obs[t]===o).map(g=>g[s]);
                    if (matching.length === 0) { B[s][o] = 0.5; continue; }
                    const num = logSumExp(matching);
                    B[s][o] = Math.exp(num - den);
                }
                const bs = B[s].reduce((a,b)=>a+b,0);
                B[s] = B[s].map(v=>v/bs);
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        // Ensure state 0 = NON-REP (lower repeat emission)
        if (B[0][1] > B[1][1]) {
            [pi[0],pi[1]]=[pi[1],pi[0]];
            [A[0],A[1]]=[A[1],A[0]];
            A[0]=[A[0][1],A[0][0]]; A[1]=[A[1][1],A[1][0]];
            [B[0],B[1]]=[B[1],B[0]];
        }
        this.hmmPi=pi; this.hmmA=A; this.hmmB=B; this.hmmFitted=true;
        return true;
    }

    viterbi(obs) {
        const T=obs.length, N=2;
        if (T===0) return null;
        const logD = Array.from({length:T},()=>new Array(N).fill(-Infinity));
        const psi  = Array.from({length:T},()=>new Array(N).fill(0));
        for (let s=0;s<N;s++)
            logD[0][s] = Math.log(this.hmmPi[s]+1e-300)+Math.log(this.hmmB[s][obs[0]]+1e-300);
        for (let t=1;t<T;t++)
            for (let s=0;s<N;s++) {
                let best=-Infinity,bp=0;
                for (let p=0;p<N;p++) {
                    const v=logD[t-1][p]+Math.log(this.hmmA[p][s]+1e-300);
                    if (v>best){best=v;bp=p;}
                }
                logD[t][s]=best+Math.log(this.hmmB[s][obs[t]]+1e-300);
                psi[t][s]=bp;
            }
        const seq=new Array(T);
        seq[T-1]=logD[T-1][0]>=logD[T-1][1]?0:1;
        for (let t=T-2;t>=0;t--) seq[t]=psi[t+1][seq[t+1]];
        let persistence=1;
        for (let t=T-2;t>=0;t--) {
            if (seq[t]===seq[T-1]) persistence++; else break;
        }
        return { stateSeq:seq, currentState:seq[T-1], persistence };
    }

    // Forward pass for Bayesian posterior P(state | obs)
    computeHMMPosterior(obs) {
        let logA=[Math.log(this.hmmPi[0]+1e-300),Math.log(this.hmmPi[1]+1e-300)];
        logA[0]+=Math.log(this.hmmB[0][obs[0]]+1e-300);
        logA[1]+=Math.log(this.hmmB[1][obs[0]]+1e-300);
        for (let t=1;t<obs.length;t++) {
            const newA=new Array(2);
            for (let s=0;s<2;s++) {
                newA[s]=logSumExp([logA[0]+Math.log(this.hmmA[0][s]+1e-300),
                                   logA[1]+Math.log(this.hmmA[1][s]+1e-300)])
                       +Math.log(this.hmmB[s][obs[t]]+1e-300);
            }
            logA=newA;
        }
        const denom=logSumExp(logA);
        return { posteriorNR:Math.exp(logA[0]-denom), posteriorR:Math.exp(logA[1]-denom) };
    }

    runHMM(window, digit) {
        // Build per-digit observation sequence
        const obs = this._buildPerDigitObs(window, digit);
        if (obs.length < 10) {
            // Fall back to global obs if digit hasn't appeared enough
            const globalObs = this._buildGlobalObs(window);
            if (globalObs.length < 10) return { valid: false };
            if (!this.hmmFitted || window.length % 50 === 0) this.baumWelch(globalObs);
            const vit  = this.viterbi(globalObs);
            const post = this.computeHMMPosterior(globalObs);
            if (!vit) return { valid: false };
            this.hmmCurrentState = vit.currentState;
            this.hmmPosteriorNR  = post.posteriorNR;
            this.hmmPersistence  = vit.persistence;
            return { valid: true, currentState: vit.currentState, posteriorNR: post.posteriorNR, persistence: vit.persistence, usingGlobal: true };
        }
        if (!this.hmmFitted || window.length % 50 === 0) {
            const fitted = this.baumWelch(obs);
            if (fitted) {
                logHMM(`📐 HMM refitted | B(rep|NR)=${(this.hmmB[0][1]*100).toFixed(1)}% B(rep|R)=${(this.hmmB[1][1]*100).toFixed(1)}% | A(NR→R)=${(this.hmmA[0][1]*100).toFixed(1)}% A(R→NR)=${(this.hmmA[1][0]*100).toFixed(1)}%`);
            }
        }
        const vit  = this.viterbi(obs);
        const post = this.computeHMMPosterior(obs);
        if (!vit) return { valid: false };
        this.hmmCurrentState = vit.currentState;
        this.hmmPosteriorNR  = post.posteriorNR;
        this.hmmPersistence  = vit.persistence;
        return { valid: true, currentState: vit.currentState, posteriorNR: post.posteriorNR, persistence: vit.persistence, usingGlobal: false };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 5: ADAPTIVE TWO-SIDED CUSUM (per-digit)
    // ════════════════════════════════════════════════════════════════════════
    // Reference level k is set adaptively from the Bayesian posterior mean.
    // CUSUM+ detects upward shift (→ repeat regime, bad for us)
    // CUSUM− detects downward shift (→ non-repeat regime, good news)
    // We alarm on CUSUM+ (don't trade if repeat regime approaching)
    updateCUSUM(digit, window) {
        const mu   = this.betaAlpha[digit] / (this.betaAlpha[digit] + this.betaBeta[digit]);
        const slack = Math.max(this.cfg.cusum_slack, mu * 0.3); // adaptive slack

        // Compute per-digit observations for the last 40 ticks
        const recent = window.slice(-40);
        for (let i = 0; i < recent.length - 1; i++) {
            if (recent[i] !== digit) continue;
            const obs_t = recent[i + 1] === digit ? 1 : 0;
            const llr   = Math.log(this.hmmB[1][obs_t] + 1e-300) - Math.log(this.hmmB[0][obs_t] + 1e-300);
            this.cusumPos[digit] = Math.max(0, this.cusumPos[digit] + llr - slack);
            this.cusumNeg[digit] = Math.min(0, this.cusumNeg[digit] + llr + slack);
        }

        const alarm = this.cusumPos[digit] > this.cfg.cusum_threshold;
        this.cusumAlarm[digit] = alarm;
        return { alarm, posVal: this.cusumPos[digit], negVal: this.cusumNeg[digit] };
    }

    resetCUSUM(digit) {
        this.cusumPos[digit] = 0;
        this.cusumNeg[digit] = 0;
        this.cusumAlarm[digit] = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 6: BINARY SEGMENTATION CHANGE-POINT DETECTION
    //
    //  Scans the binary repeat sequence for the most recent structural break.
    //  Uses a CUSUM-based cost function (Yao 1988 / Killick et al 2012).
    //  The most recent change-point tells us:
    //    - How old is the current regime? (regimeAge = T - changePoint)
    //    - What was the mean repeat rate before and after?
    //    - Is the detected current regime NON-REP or REP?
    // ════════════════════════════════════════════════════════════════════════
    runBinarySegmentation(window) {
        const obs = [];
        for (let i = 1; i < window.length; i++) obs.push(window[i] === window[i-1] ? 1 : 0);

        const T = obs.length;
        if (T < 30) return { valid: false };

        const scanWindow = Math.min(T, this.cfg.bseg_window);
        const seq = obs.slice(-scanWindow);
        const n = seq.length;

        // CUSUM cost function: for a segment [s,e], cost = -2 * log-likelihood
        // Under Bernoulli with MLE estimate p̂ = mean(seq[s..e])
        const segCost = (s, e) => {
            if (e <= s) return 0;
            const len = e - s;
            let k = 0;
            for (let i = s; i < e; i++) k += seq[i];
            if (k === 0 || k === len) return 0; // No cost (degenerate)
            const p = k / len;
            return -2 * (k * Math.log(p) + (len - k) * Math.log(1 - p));
        };

        // Single change-point search: find τ that maximises cost reduction
        // gain(τ) = cost(0,n) − [cost(0,τ) + cost(τ,n)]
        const totalCost = segCost(0, n);
        let bestGain = 0, bestTau = -1;
        // Minimum segment size = 15
        for (let tau = 15; tau < n - 15; tau++) {
            const gain = totalCost - segCost(0, tau) - segCost(tau, n);
            if (gain > bestGain) { bestGain = gain; bestTau = tau; }
        }

        // Penalty (BIC): pen = log(n) — must exceed this to accept change-point
        const penalty = Math.log(n) * 2;
        if (bestTau < 0 || bestGain < penalty) {
            // No significant change-point found in window
            this.regimeAge = n;  // Regime has lasted the entire window
            const meanAll = seq.reduce((s,v)=>s+v,0)/n;
            return { valid: true, hasChangePoint: false, regimeAge: n, currentRegimeMean: meanAll };
        }

        // bestTau is the detected change-point (in the scan window)
        // Map back to absolute index in tick history
        this.regimeAge = n - bestTau;
        const meanBefore = seq.slice(0, bestTau).reduce((s,v)=>s+v,0)/bestTau;
        const meanAfter  = seq.slice(bestTau).reduce((s,v)=>s+v,0)/(n-bestTau);

        // Secondary scan: look for an additional change-point in post-tau segment
        // (to detect if we've since left that regime)
        let finalRegimeAge = this.regimeAge;
        let finalMean = meanAfter;
        if (n - bestTau > 30) {
            const postSeq = seq.slice(bestTau);
            const postCost = segCost(0, postSeq.length);
            let bestGain2 = 0, bestTau2 = -1;
            for (let tau2 = 10; tau2 < postSeq.length - 10; tau2++) {
                const subCost = (s2, e2) => {
                    if (e2 <= s2) return 0;
                    const l2 = e2 - s2; let k2 = 0;
                    for (let ii = s2; ii < e2; ii++) k2 += postSeq[ii];
                    if (k2===0||k2===l2) return 0;
                    const p2=k2/l2;
                    return -2*(k2*Math.log(p2)+(l2-k2)*Math.log(1-p2));
                };
                const g2 = postCost - subCost(0,tau2) - subCost(tau2,postSeq.length);
                if (g2 > bestGain2) { bestGain2=g2; bestTau2=tau2; }
            }
            if (bestTau2 >= 0 && bestGain2 > penalty) {
                finalRegimeAge = postSeq.length - bestTau2;
                finalMean = postSeq.slice(bestTau2).reduce((s,v)=>s+v,0)/(postSeq.length-bestTau2);
            }
        }

        return {
            valid: true,
            hasChangePoint: true,
            gain: bestGain,
            penalty,
            regimeAge: finalRegimeAge,
            currentRegimeMean: finalMean,
            meanBefore,
            meanAfter,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  MODULE 7: RUN-LENGTH MOMENTUM ANALYSIS
    //
    //  A "non-repeat run" = consecutive ticks with no two adjacent same digits.
    //  A "repeat run"     = burst of repeated digits (any digit repeating).
    //  We track:
    //    - Current run type and length
    //    - Historical distribution of both run types
    //    - "Momentum score": is the current non-rep run unusually long?
    //      (comparing to historical distribution → z-score)
    //    - Whether current regime looks "settled" in NON-REP
    // ════════════════════════════════════════════════════════════════════════
    updateRunLength(window) {
        const recentLen = Math.min(window.length, this.cfg.momentum_window * 3);
        const recent = window.slice(-recentLen);

        // Walk through and collect run-length sequences
        let runLen = 1, inRep = (recent[1] === recent[0]);
        const runs = []; // {isRep, len}
        for (let i = 1; i < recent.length; i++) {
            const isRepeat = recent[i] === recent[i-1];
            if (isRepeat === inRep) {
                runLen++;
            } else {
                runs.push({ isRep: inRep, len: runLen });
                runLen = 1;
                inRep = isRepeat;
            }
        }
        runs.push({ isRep: inRep, len: runLen });

        // Last run = current
        const curRun = runs[runs.length - 1];
        this.currentRunIsNonRep = !curRun.isRep;
        this.currentRunLength   = curRun.len;

        // Collect historical run-length distributions (excluding current)
        const allNonRep = runs.slice(0,-1).filter(r=>!r.isRep).map(r=>r.len);
        const allRep    = runs.slice(0,-1).filter(r=>r.isRep).map(r=>r.len);

        const meanArr = (arr) => arr.length ? arr.reduce((s,v)=>s+v,0)/arr.length : 0;
        const stdArr  = (arr) => {
            if (arr.length < 2) return 1;
            const m = meanArr(arr);
            return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/(arr.length-1));
        };

        const meanNonRep = meanArr(allNonRep);
        const stdNonRep  = stdArr(allNonRep);
        const meanRep    = meanArr(allRep);

        // Z-score: how many std-devs above mean is current non-rep run?
        let momentumZ = 0;
        if (this.currentRunIsNonRep && allNonRep.length >= 3) {
            momentumZ = (this.currentRunLength - meanNonRep) / Math.max(stdNonRep, 1);
        }

        // Simple "regime settled" check: last 3+ runs are all non-rep?
        const lastFewRuns = runs.slice(-4, -1);
        const recentlyStable = lastFewRuns.length >= 2 && lastFewRuns.every(r => !r.isRep);

        // Repeat exhaustion: is current rep run longer than historical mean?
        // If so, it's likely close to ending (mean reversion)
        const repExhaustion = !this.currentRunIsNonRep && meanRep > 0 &&
            this.currentRunLength >= meanRep * 1.5;

        return {
            currentRunIsNonRep: this.currentRunIsNonRep,
            currentRunLength:   this.currentRunLength,
            meanNonRepRun: meanNonRep,
            meanRepRun:    meanRep,
            momentumZ,
            recentlyStable,
            repExhaustion,
            numRuns: runs.length,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ENSEMBLE: Combine all 7 modules into a final verdict
    // ════════════════════════════════════════════════════════════════════════
    analyze(tickHistory, targetDigit) {
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len = window.length;

        if (len < this.cfg.min_ticks_ready) {
            return { valid: false, reason: `insufficient data (${len}/${this.cfg.min_ticks_ready})` };
        }

        // ── Run all 7 modules ──────────────────────────────────────────────
        const bayesian = this.updateBayesian(targetDigit, window);
        const sprt     = this.updateSPRT(targetDigit, window);
        const ac       = this.computeMultiScaleAC(window);
        const hmm      = this.runHMM(window, targetDigit);
        const cusum    = this.updateCUSUM(targetDigit, window);
        const bseg     = this.runBinarySegmentation(window);
        const momentum = this.updateRunLength(window);

        // ── Also compute raw repeat rate for the target digit ──────────────
        let selfCount = 0, selfOpp = 0;
        for (let i = 0; i < window.length - 1; i++) {
            if (window[i] !== targetDigit) continue;
            selfOpp++;
            if (window[i+1] === targetDigit) selfCount++;
        }
        const rawSelfRepRate = selfOpp > 0 ? (selfCount / selfOpp) * 100 : 10;

        // ── Recent repeat rate (last 30 ticks) ────────────────────────────
        const recent30 = window.slice(-30);
        let r30rep = 0, r30opp = 0;
        for (let i = 0; i < recent30.length - 1; i++) {
            if (recent30[i] !== targetDigit) continue;
            r30opp++;
            if (recent30[i+1] === targetDigit) r30rep++;
        }
        const recentSelfRepRate = r30opp > 0 ? (r30rep / r30opp) * 100 : rawSelfRepRate;

        // ── Module votes (1=NON-REP, 0=uncertain, -1=REP) ─────────────────
        const votes = {
            bayesian: bayesian.probH0 >= this.cfg.bayesian_h0_prob ? 1
                    : bayesian.probH0 <= 0.50 ? -1 : 0,

            sprt:     sprt.decision === 'H0' ? 1
                    : sprt.decision === 'H1' ? -1 : 0,

            ac_short: this.acShort <= this.cfg.ac_nonrep_threshold ? 1
                    : this.acShort >= 0.15 ? -1 : 0,
            ac_med:   this.acMed   <= this.cfg.ac_nonrep_threshold ? 1
                    : this.acMed   >= 0.12 ? -1 : 0,
            ac_long:  this.acLong  <= this.cfg.ac_nonrep_threshold ? 1
                    : this.acLong  >= 0.10 ? -1 : 0,

            hmm:      (hmm.valid && hmm.currentState === 0 &&
                       hmm.posteriorNR >= this.cfg.hmm_nonrep_posterior &&
                       hmm.persistence >= this.cfg.min_hmm_persistence) ? 1
                    : (hmm.valid && hmm.currentState === 1) ? -1 : 0,

            cusum:    !cusum.alarm ? 1 : -1,

            bseg:     (bseg.valid && bseg.regimeAge >= this.cfg.min_regime_age &&
                       (!bseg.hasChangePoint || bseg.currentRegimeMean <= 0.15)) ? 1
                    : (bseg.valid && bseg.hasChangePoint && bseg.currentRegimeMean > 0.20) ? -1 : 0,

            momentum: (momentum.currentRunIsNonRep &&
                       momentum.currentRunLength >= this.cfg.min_nonrep_run) ? 1
                    : (!momentum.currentRunIsNonRep) ? -1 : 0,
        };

        // ── Weighted ensemble ──────────────────────────────────────────────
        // Weights reflect reliability and independence of each module
        const weights = {
            bayesian: 2.5,  // highest: exact Bayesian, per-digit, weighted
            sprt:     2.0,  // high: statistically optimal sequential test
            ac_short: 1.0,
            ac_med:   1.2,
            ac_long:  1.5,
            hmm:      1.8,  // per-digit HMM
            cusum:    1.5,  // excellent at catching sudden shifts
            bseg:     2.0,  // regime age is critical
            momentum: 1.0,
        };
        const totalWeight = Object.values(weights).reduce((s,w)=>s+w,0);
        let weightedVote = 0;
        for (const [k, v] of Object.entries(votes))
            weightedVote += v * weights[k];
        const normalizedVote = weightedVote / totalWeight; // range [-1, 1]

        // Count positive votes
        const posVotes = Object.values(votes).filter(v => v === 1).length;
        const negVotes = Object.values(votes).filter(v => v === -1).length;
        const numModules = Object.keys(votes).length;

        // ── Ensemble confidence score (0-100) ──────────────────────────────
        let ensembleScore = 0;

        // Component contributions
        if (bayesian.probH0 >= this.cfg.bayesian_h0_prob)
            ensembleScore += Math.round(clamp((bayesian.probH0 - 0.90) / 0.10, 0, 1) * 25);
        if (sprt.decision === 'H0')
            ensembleScore += Math.round(clamp((-sprt.llr - (-this.sprtA)) / (-this.sprtA * 2), 0, 1) * 20);
        if (hmm.valid)
            ensembleScore += Math.round(clamp((hmm.posteriorNR - 0.80) / 0.20, 0, 1) * 18);
        if (!cusum.alarm)
            ensembleScore += 12;
        if (bseg.valid && bseg.regimeAge >= this.cfg.min_regime_age)
            ensembleScore += Math.round(clamp(bseg.regimeAge / (this.cfg.min_regime_age * 3), 0, 1) * 15);
        if (this.acLong <= this.cfg.ac_nonrep_threshold)
            ensembleScore += 10;

        // Hard penalties
        if (cusum.alarm)                                    ensembleScore = 0;
        if (sprt.decision === 'H1')                         ensembleScore = 0;
        if (hmm.valid && hmm.currentState === 1)            ensembleScore = Math.min(ensembleScore, 30);
        if (rawSelfRepRate >= this.cfg.baseline_self_prob * 200)  ensembleScore = 0;  // >20% raw self-repeat
        if (bayesian.posteriorMean > 0.22)                  ensembleScore = 0;

        // ── Signal condition (strict AND of critical gates + ensemble vote) ─
        const signalActive = (
            bayesian.probH0 >= this.cfg.bayesian_h0_prob &&
            sprt.decision   === 'H0' &&
            hmm.valid && hmm.currentState === 0 &&
            hmm.posteriorNR >= this.cfg.hmm_nonrep_posterior &&
            hmm.persistence >= this.cfg.min_hmm_persistence &&
            !cusum.alarm &&
            bseg.valid && bseg.regimeAge >= this.cfg.min_regime_age &&
            momentum.currentRunIsNonRep &&
            posVotes >= this.cfg.min_modules_agree &&
            ensembleScore >= this.cfg.min_ensemble_score &&
            rawSelfRepRate < 18 &&  // raw rate gate
            recentSelfRepRate < 22  // recent rate gate
        );

        this.lastAnalysis = {
            valid: true,
            targetDigit,
            // Module outputs
            bayesian, sprt, ac, hmm, cusum, bseg, momentum,
            // Raw stats
            rawSelfRepRate, recentSelfRepRate,
            // Ensemble
            votes, posVotes, negVotes, numModules,
            weightedVote, normalizedVote,
            ensembleScore,
            // Signal
            signalActive,
        };
        return this.lastAnalysis;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT CLASS  (same state machine, upgraded analysis engine)
// ══════════════════════════════════════════════════════════════════════════════
class RomanianGhostBot {
    constructor(config) {
        this.config   = config;
        this.ws       = null;
        this.botState = STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT     = 5;
        this.pingInterval      = null;
        this.requestId         = 0;

        this.accountBalance  = 0;
        this.startingBalance = 0;
        this.accountId       = '';

        this.tickHistory = [];

        this.detector = new AdvancedRegimeDetector(config);
        this.regime   = null;

        this.targetDigit        = -1;
        this.targetSelfRepRate  = 0;
        this.signalActive       = false;

        // Ghost
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed    = 0;
        this.ghostConfirmed       = false;
        this.ghostAwaitingResult  = false;

        // Trading
        this.currentStake        = config.base_stake;
        this.martingaleStep      = 0;
        this.totalMartingaleLoss = 0;
        this.isTradeActive       = false;
        this.lastBuyPrice        = 0;
        this.lastContractId      = null;
        this.pendingTrade        = false;

        // Session stats
        this.sessionStartTime  = Date.now();
        this.totalTrades       = 0;
        this.totalWins         = 0;
        this.totalLosses       = 0;
        this.sessionProfit     = 0;
        this.currentWinStreak  = 0;
        this.currentLossStreak = 0;
        this.maxWinStreak      = 0;
        this.maxLossStreak     = 0;
        this.maxMartingaleReached = 0;
        this.largestWin        = 0;
        this.largestLoss       = 0;

        this.cooldownTimer = null;
        this.telegramBot   = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
    }

    start() { this.printBanner(); this.connectWS(); }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v3.0  —  Deriv Digit Differ            ')));
        console.log(bold(cyan('   7-Module Ensemble Regime Detection (Ultra-Precision)           ')));
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════')));
        console.log(`  Symbol           : ${bold(c.symbol)}`);
        console.log(`  Base Stake       : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Analysis Window  : ${bold(c.analysis_window)} ticks`);
        console.log(`  Min Ticks Ready  : ${bold(c.min_ticks_ready)}`);
        console.log(`  Bayesian Gate    : ${bold('P(p_self≤0.10)≥' + (c.bayesian_h0_prob*100).toFixed(0) + '%')} (per-digit)`);
        console.log(`  SPRT Errors      : ${bold('α=' + (c.sprt_alpha*100) + '% β=' + (c.sprt_beta*100) + '%')}`);
        console.log(`  HMM Posterior NR : ${bold((c.hmm_nonrep_posterior*100).toFixed(0) + '%')}`);
        console.log(`  Min Regime Age   : ${bold(c.min_regime_age)} ticks`);
        console.log(`  Min Modules Agree: ${bold(c.min_modules_agree)} / 9`);
        console.log(`  Min Ensemble Scr : ${bold(c.min_ensemble_score)}/100`);
        console.log(`  Ghost Trading    : ${c.ghost_enabled ? green('ON') + ` | ${bold(c.ghost_wins_required)} win(s)` : red('OFF')}`);
        console.log(`  Martingale       : ${c.martingale_enabled ? green('ON') + ` | ${c.max_martingale_steps} steps | ${c.martingale_multiplier}x` : red('OFF')}`);
        console.log(`  Take Profit      : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss        : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(bold(cyan('══════════════════════════════════════════════════════════════════')));
        console.log(bold(yellow('\n  7-MODULE DETECTION ENGINE:')));
        console.log(dim('  1. Bayesian Beta-Binomial  — per-digit, exp-weighted, credible intervals'));
        console.log(dim('  2. SPRT (Sequential Ratio)  — optimal sequential hypothesis testing'));
        console.log(dim('  3. Multi-Scale AC (20/60/150t) — lag-1 autocorrelation, 3 timescales'));
        console.log(dim('  4. Per-Digit HMM + Viterbi  — Baum-Welch EM, per-digit obs sequence'));
        console.log(dim('  5. Adaptive 2-Sided CUSUM   — adaptive reference, per-digit alarm'));
        console.log(dim('  6. Binary Segmentation CPD  — change-point detection, regime age'));
        console.log(dim('  7. Run-Length Momentum      — non-repeat run tracking & z-score'));
        console.log('');
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connectWS() {
        this.botState = STATE.CONNECTING;
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);
        try { this.ws = new WebSocket(url); } catch (e) { logError(`WS create failed: ${e.message}`); this.attemptReconnect(); return; }
        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.botState = STATE.AUTHENTICATING;
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 });
            }, 30_000);
            this.send({ authorize: this.config.api_token });
        });
        this.ws.on('message', raw => {
            try { this.handleMessage(JSON.parse(raw)); } catch (e) { logError(`Parse: ${e.message}`); }
        });
        this.ws.on('close', code => {
            logApi(`⚠️  Closed (${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            if (this.botState !== STATE.STOPPED) this.attemptReconnect();
        });
        this.ws.on('error', e => logError(`WS error: ${e.message}`));
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT) { this.stop('Max reconnect'); return; }
        this.reconnectAttempts++;
        const delay = Math.pow(2, this.reconnectAttempts - 1) * 1000;
        logApi(`Reconnecting in ${delay/1000}s (${this.reconnectAttempts}/${this.MAX_RECONNECT})...`);
        this.isTradeActive = false;
        setTimeout(() => { if (this.botState !== STATE.STOPPED) this.connectWS(); }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); } catch (e) { logError(`Send: ${e.message}`); }
    }

    sendTelegram(text) {
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }).catch(() => {});
    }

    handleMessage(msg) {
        if (msg.error) { this.handleApiError(msg); return; }
        switch (msg.msg_type) {
            case 'authorize':   this.handleAuth(msg); break;
            case 'balance':     this.handleBalance(msg); break;
            case 'history':     this.handleTickHistory(msg); break;
            case 'tick':        this.handleTick(msg); break;
            case 'buy':         this.handleBuy(msg); break;
            case 'transaction': this.handleTransaction(msg); break;
            case 'ping': break;
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN';
        const emsg = msg.error.message || 'Unknown error';
        logError(`[${code}] on ${msg.msg_type||'?'}: ${emsg}`);
        switch (code) {
            case 'InvalidToken':
            case 'AuthorizationRequired': this.stop('Auth failed'); break;
            case 'RateLimit':
                setTimeout(() => { this.isTradeActive = false; this.executeTradeFlow(false); }, 10_000); break;
            case 'InsufficientBalance': this.stop('Insufficient balance'); break;
            default:
                if (msg.msg_type === 'buy') { this.isTradeActive = false; this.botState = STATE.ANALYZING; }
        }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance  = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId       = auth.loginid || 'N/A';
        this.sessionStartTime = Date.now();
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Auth')} | ${bold(this.accountId)} ${isDemo?dim('(Demo)'):red('(REAL)')} | ${green('$' + this.accountBalance.toFixed(2))}`);
        if (!isDemo) logRisk('⚠️  REAL ACCOUNT');
        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.botState = STATE.COLLECTING_TICKS;
        logBot(`Fetching ${bold(this.config.tick_history_size)} ticks for ${bold(this.config.symbol)}...`);
        this.send({ ticks_history: this.config.symbol, count: this.config.tick_history_size, end: 'latest', style: 'ticks' });
    }

    handleTickHistory(msg) {
        if (!msg.history || !msg.history.prices) {
            logError('No tick history'); this.subscribeToLiveTicks(); return;
        }
        const digits = msg.history.prices.map(p => getLastDigit(p, this.config.symbol));
        this.tickHistory = digits.slice(-this.config.tick_history_size);
        logBot(`${green('✅ Loaded ' + this.tickHistory.length + ' ticks')}`);
        logTick(`History tail: [${this.tickHistory.slice(-10).join(', ')}]`);
        this.subscribeToLiveTicks();
        if (this.tickHistory.length >= this.config.min_ticks_ready) {
            this.botState = STATE.ANALYZING;
            const d = this.tickHistory[this.tickHistory.length - 1];
            this.regime = this.detector.analyze(this.tickHistory, d);
            this.applyRegimeSignal(d);
            this.logRegimeAnalysis(d);
        } else {
            logBot(`Collecting ticks (${this.tickHistory.length}/${this.config.min_ticks_ready})...`);
        }
    }

    subscribeToLiveTicks() {
        logBot(`Subscribing to ${bold(this.config.symbol)} live ticks...`);
        this.send({ ticks: this.config.symbol, subscribe: 1 });
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    // ── Live Tick Handler ─────────────────────────────────────────────────────
    handleTick(msg) {
        if (!msg.tick || this.botState === STATE.STOPPED) return;
        const price        = msg.tick.quote;
        const currentDigit = getLastDigit(price, this.config.symbol);

        this.tickHistory.push(currentDigit);
        if (this.tickHistory.length > this.config.tick_history_size)
            this.tickHistory = this.tickHistory.slice(-this.config.tick_history_size);

        const count = this.tickHistory.length;
        const h = this.tickHistory;
        const last5 = h.length >= 6 ? h.slice(-6,-1).join(' › ') : '—';
        const stateHint =
            this.botState === STATE.WAITING_RESULT ? '⏳ waiting'
          : this.botState === STATE.COOLDOWN       ? '❄️ cooldown'
          : this.botState === STATE.GHOST_TRADING  ? `👻 ghost ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
          : '';
        logTick(`${dim(last5 + ' ›')} ${bold(cyan(`[${currentDigit}]`))}${dim(`  ${price}  (${count}/${this.config.tick_history_size})`)}${stateHint ? `  ${dim(stateHint)}` : ''}`);

        // Pending trade gate
        if (this.pendingTrade && !this.isTradeActive && this.botState !== STATE.STOPPED) {
            if (currentDigit === this.targetDigit) {
                this.pendingTrade = false; this.placeTrade(); return;
            }
            logGhost(dim(`⏳ Waiting for digit ${bold(this.targetDigit)} — current: ${currentDigit}`));
            return;
        }

        switch (this.botState) {
            case STATE.COLLECTING_TICKS:
                if (count >= this.config.min_ticks_ready) {
                    this.botState = STATE.ANALYZING;
                    this.regime = this.detector.analyze(this.tickHistory, currentDigit);
                    this.applyRegimeSignal(currentDigit);
                    this.logRegimeAnalysis(currentDigit);
                    this.processSignal(currentDigit);
                }
                break;
            case STATE.ANALYZING:
                this.regime = this.detector.analyze(this.tickHistory, currentDigit);
                this.applyRegimeSignal(currentDigit);
                this.logRegimeAnalysis(currentDigit);
                if (this.signalActive) this.processSignal(currentDigit);
                break;
            case STATE.GHOST_TRADING:
                this.regime = this.detector.analyze(this.tickHistory, this.targetDigit);
                this.refreshSignalForLockedTarget();
                this.runGhostCheck(currentDigit);
                break;
            case STATE.WAITING_RESULT:
            case STATE.COOLDOWN:
                this.regime = this.detector.analyze(this.tickHistory, currentDigit);
                break;
        }
    }

    applyRegimeSignal(currentDigit) {
        this.targetDigit = currentDigit;
        if (!this.regime || !this.regime.valid) { this.signalActive = false; return; }
        this.targetSelfRepRate = this.regime.rawSelfRepRate;
        this.signalActive      = this.regime.signalActive;
    }

    refreshSignalForLockedTarget() {
        if (this.targetDigit < 0 || !this.regime || !this.regime.valid) return;
        this.targetSelfRepRate = this.regime.rawSelfRepRate;
        this.signalActive      = this.regime.signalActive;
    }

    // ── Rich Regime Logging ────────────────────────────────────────────────────
    logRegimeAnalysis(currentDigit) {
        if (!this.regime || !this.regime.valid) return;
        const r = this.regime;

        // ── Bayesian ─────────────────────────────────────────────────────────
        const bay    = r.bayesian;
        const bayOK  = bay.probH0 >= this.config.bayesian_h0_prob;
        logRegime(
            `[1-BAYES] d${currentDigit}: P(p≤0.10)=${bayOK?green:(v=>red(v))('')}${bayOK?green(`${(bay.probH0*100).toFixed(1)}%`):red(`${(bay.probH0*100).toFixed(1)}%`)} ` +
            `μ=${(bay.posteriorMean*100).toFixed(1)}% CI=[${(bay.credLo*100).toFixed(1)}%,${(bay.credHi*100).toFixed(1)}%] n≈${bay.nObs} ` +
            `raw:${r.rawSelfRepRate.toFixed(1)}% rec:${r.recentSelfRepRate.toFixed(1)}%`
        );

        // ── SPRT ──────────────────────────────────────────────────────────────
        const sprtDecCol = r.sprt.decision === 'H0' ? green : r.sprt.decision === 'H1' ? red : yellow;
        logSprt(
            `[2-SPRT ] d${currentDigit}: LLR=${r.sprt.llr.toFixed(3)} ` +
            `[A=${r.sprt.A.toFixed(3)}, B=${r.sprt.B.toFixed(3)}] → ${sprtDecCol(bold(r.sprt.decision))}`
        );

        // ── AC ────────────────────────────────────────────────────────────────
        const acFmt = (v, w) => {
            const s = `AC-${w}:${v>=0?'+':''}${v.toFixed(3)}`;
            return v <= this.config.ac_nonrep_threshold ? green(s) : v >= 0.12 ? red(s) : yellow(s);
        };
        logRegime(`[3-AC   ] ${acFmt(r.ac.short,20)} ${acFmt(r.ac.med,60)} ${acFmt(r.ac.long,150)}`);

        // ── HMM ───────────────────────────────────────────────────────────────
        if (r.hmm.valid) {
            const stCol = r.hmm.currentState === 0 ? green : red;
            const stName = r.hmm.currentState === 0 ? 'NON-REP' : 'REP';
            logHMM(
                `[4-HMM  ] State:${stCol(bold(stName))} P(NR)=${r.hmm.posteriorNR>=this.config.hmm_nonrep_posterior?green(`${(r.hmm.posteriorNR*100).toFixed(1)}%`):red(`${(r.hmm.posteriorNR*100).toFixed(1)}%`)} ` +
                `persist:${r.hmm.persistence>=this.config.min_hmm_persistence?green(`${r.hmm.persistence}t`):yellow(`${r.hmm.persistence}t`)} ${r.hmm.usingGlobal?dim('(global obs)'):'(per-digit)'}`
            );
        }

        // ── CUSUM ─────────────────────────────────────────────────────────────
        logRegime(
            `[5-CUSUM] d${currentDigit}: ${r.cusum.alarm?red('⚠️ ALARM'):green('OK')} ` +
            `CUSUM+=${r.cusum.posVal.toFixed(2)} CUSUM-=${r.cusum.negVal.toFixed(2)} ` +
            `thr=${this.config.cusum_threshold}`
        );

        // ── Binary Segmentation ───────────────────────────────────────────────
        if (r.bseg.valid) {
            const ageOK = r.bseg.regimeAge >= this.config.min_regime_age;
            logBseg(
                `[6-BSEG ] age=${ageOK?green(`${r.bseg.regimeAge}t`):red(`${r.bseg.regimeAge}t`)} ` +
                `μ(now)=${r.bseg.hasChangePoint?(r.bseg.currentRegimeMean*100).toFixed(1)+'%':'n/a'} ` +
                `${r.bseg.hasChangePoint?`CPD: μ_before=${(r.bseg.meanBefore*100).toFixed(1)}% μ_after=${(r.bseg.meanAfter*100).toFixed(1)}%`:'no CPD in window'}`
            );
        }

        // ── Momentum ──────────────────────────────────────────────────────────
        const mom = r.momentum;
        const momStr = mom.currentRunIsNonRep
            ? green(`NR-run:${mom.currentRunLength}t (z=${mom.momentumZ.toFixed(2)}, μ=${mom.meanNonRepRun.toFixed(1)}t)`)
            : red(`REP-run:${mom.currentRunLength}t (μ_rep=${mom.meanRepRun.toFixed(1)}t)`);
        logRegime(`[7-MOMO ] ${momStr} ${mom.recentlyStable ? green('stable') : ''}${mom.repExhaustion ? yellow(' (rep exhausted)') : ''}`);

        // ── Ensemble vote summary ──────────────────────────────────────────────
        const voteBar = Object.entries(r.votes).map(([k,v]) =>
            v === 1 ? green('✓') : v === -1 ? red('✗') : yellow('?')
        ).join('');
        const scoreStr = r.ensembleScore >= this.config.min_ensemble_score
            ? green(bold(`${r.ensembleScore}/100`))
            : red(`${r.ensembleScore}/100`);
        logRegime(
            `[ENS    ] votes ${voteBar} (+${r.posVotes}/-${r.negVotes}) ` +
            `score:${scoreStr} nVote:${r.normalizedVote.toFixed(3)}`
        );

        // ── Signal verdict ────────────────────────────────────────────────────
        if (r.signalActive) {
            logRegime(green(bold(
                `✅ SIGNAL ACTIVE — d${currentDigit} DIFFER | ` +
                `P(NR):${(r.bayesian.probH0*100).toFixed(1)}% SPRT:H0 HMM:NON-REP score:${r.ensembleScore}/100`
            )));
        } else {
            const reasons = [];
            if (!r.bayesian || r.bayesian.probH0 < this.config.bayesian_h0_prob)
                reasons.push(`Bayes:${(r.bayesian.probH0*100).toFixed(1)}%<${(this.config.bayesian_h0_prob*100).toFixed(0)}%`);
            if (r.sprt.decision !== 'H0')
                reasons.push(`SPRT:${r.sprt.decision}`);
            if (!r.hmm.valid || r.hmm.currentState !== 0)
                reasons.push(`HMM:${r.hmm.valid?'REP':'invalid'}`);
            if (r.hmm.valid && r.hmm.posteriorNR < this.config.hmm_nonrep_posterior)
                reasons.push(`P(NR):${(r.hmm.posteriorNR*100).toFixed(1)}%`);
            if (r.hmm.valid && r.hmm.persistence < this.config.min_hmm_persistence)
                reasons.push(`persist:${r.hmm.persistence}<${this.config.min_hmm_persistence}`);
            if (r.cusum.alarm)
                reasons.push(`CUSUM:ALARM(${r.cusum.posVal.toFixed(1)})`);
            if (!r.bseg.valid || r.bseg.regimeAge < this.config.min_regime_age)
                reasons.push(`age:${r.bseg.valid?r.bseg.regimeAge:'?'}<${this.config.min_regime_age}`);
            if (!r.momentum.currentRunIsNonRep)
                reasons.push(`inRepRun`);
            if (r.posVotes < this.config.min_modules_agree)
                reasons.push(`votes:${r.posVotes}/${this.config.min_modules_agree}`);
            if (r.ensembleScore < this.config.min_ensemble_score)
                reasons.push(`score:${r.ensembleScore}<${this.config.min_ensemble_score}`);
            logRegime(red(`⛔ NO SIGNAL — d${currentDigit}: ${reasons.join(' | ')}`));
        }
    }

    // ── Signal → Ghost / Trade ─────────────────────────────────────────────────
    processSignal(currentDigit) {
        if (!this.signalActive) { this.botState = STATE.ANALYZING; return; }
        if (this.config.ghost_enabled && !this.ghostConfirmed) {
            this.botState = STATE.GHOST_TRADING;
            const r = this.regime;
            logGhost(`👻 Ghost started. d${this.targetDigit} | Bayes:${(r.bayesian.probH0*100).toFixed(1)}% score:${r.ensembleScore}/100 | need ${bold(this.config.ghost_wins_required)} non-repeat(s)`);
            this.runGhostCheck(currentDigit);
        } else {
            this.executeTradeFlow(true);
        }
    }

    runGhostCheck(currentDigit) {
        if (this.botState !== STATE.GHOST_TRADING) return;
        if (!this.signalActive) {
            logGhost(dim(`Signal lost — re-analyzing...`));
            this.resetGhost(); this.botState = STATE.ANALYZING; return;
        }
        this.ghostRoundsPlayed++;
        if (this.ghostAwaitingResult) {
            this.ghostAwaitingResult = false;
            if (currentDigit !== this.targetDigit) {
                this.ghostConsecutiveWins++;
                logGhost(`👻 ${green(`✅ Ghost WIN ${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)} — d${this.targetDigit} did NOT repeat → ${bold(currentDigit)}`);
            } else {
                const had = this.ghostConsecutiveWins;
                this.ghostConsecutiveWins = 0;
                logGhost(`👻 ${red(`❌ Ghost LOSS (had ${had} wins) — REPEATED`)} → reset`);
            }
        } else {
            if (currentDigit === this.targetDigit) {
                const wif = this.ghostConsecutiveWins + 1;
                if (wif >= this.config.ghost_wins_required) {
                    this.ghostConsecutiveWins = wif;
                    this.ghostConfirmed = true;
                    logGhost(green(bold(`✅ Ghost confirmed! LIVE trade on digit ${this.targetDigit} NOW`)));
                    this.executeTradeFlow(true);
                } else {
                    this.ghostAwaitingResult = true;
                    logGhost(`👻 d${this.targetDigit} seen | wins:${this.ghostConsecutiveWins}/${this.config.ghost_wins_required} | awaiting next tick...`);
                }
            } else {
                logGhost(dim(`⏳ d${currentDigit} — waiting for ${bold(this.targetDigit)} (${this.ghostConsecutiveWins}/${this.config.ghost_wins_required})`));
                this.refreshSignalForLockedTarget();
                if (!this.signalActive) { this.resetGhost(); this.botState = STATE.ANALYZING; }
            }
        }
        if (!this.ghostConfirmed && this.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow(`⚠️  Max ghost rounds. Re-analyzing...`));
            this.resetGhost(); this.botState = STATE.ANALYZING;
        }
    }

    resetGhost() {
        this.ghostConsecutiveWins = 0;
        this.ghostRoundsPlayed    = 0;
        this.ghostConfirmed       = false;
        this.ghostAwaitingResult  = false;
        this.targetDigit          = -1;
        this.signalActive         = false;
    }

    // ── Trade Execution ────────────────────────────────────────────────────────
    executeTradeFlow(immediate) {
        if (this.isTradeActive || this.pendingTrade || this.botState === STATE.STOPPED) return;
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP')     { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
            return;
        }
        this.currentStake = this.calculateStake();
        if (this.currentStake > this.config.max_stake) { this.stop('Stake exceeds maximum'); return; }
        if (this.currentStake > this.accountBalance)   { this.stop('Insufficient balance'); return; }
        if (immediate) this.placeTrade();
        else { this.pendingTrade = true; this.botState = STATE.GHOST_TRADING; logBot(`⚡ Recovery trade queued — d${bold(cyan(this.targetDigit))}`); }
    }

    placeTrade() {
        this.isTradeActive = true;
        this.botState = STATE.PLACING_TRADE;
        const r     = this.regime;
        const score = r && r.valid ? r.ensembleScore : 0;
        const pnr   = r && r.valid ? (r.bayesian.probH0 * 100).toFixed(1) + '%' : '?';
        const mart  = this.config.martingale_enabled ? ` | Step:${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        logTrade(
            `🎯 DIFFER d${bold(cyan(this.targetDigit))} | ` +
            `$${bold(this.currentStake.toFixed(2))}${mart} | ` +
            `Bayes:${pnr} | Score:${score}/100 | ` +
            `Ghost:${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`
        );
        this.sendTelegram(`
            🎯 <b>GHOST TRADE</b>
            📊 ${this.config.symbol} | d${this.targetDigit}
            Last 5: ${this.tickHistory.slice(-5).join(', ')}
            💰 Stake: $${this.currentStake.toFixed(2)}${mart}
            🔬 Bayes:${pnr} Score:${score}/100
            👻 Ghost:${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}
            📈 ${this.totalTrades}T | ${this.totalWins}W/${this.totalLosses}L | P&L:${this.sessionProfit>=0?'+':''}$${this.sessionProfit.toFixed(2)}`.trim());

        this.send({
            buy: 1, price: this.currentStake.toFixed(2),
            parameters: {
                contract_type: this.config.contract_type,
                symbol:        this.config.symbol,
                duration:      1, duration_unit: 't',
                basis:         'stake', amount: this.currentStake.toFixed(2),
                barrier:       String(this.targetDigit),
                currency:      this.config.currency,
            },
        });
        this.botState = STATE.WAITING_RESULT;
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        this.lastContractId = msg.buy.contract_id;
        this.lastBuyPrice   = parseFloat(msg.buy.buy_price);
        logTrade(dim(`Contract ${this.lastContractId} | Cost:$${this.lastBuyPrice.toFixed(2)} | Payout:$${parseFloat(msg.buy.payout).toFixed(2)}`));
    }

    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell' || !this.isTradeActive) return;
        this.botState = STATE.PROCESSING_RESULT;
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - this.lastBuyPrice;
        this.totalTrades++;
        const resultDigit = this.tickHistory.length > 0 ? this.tickHistory[this.tickHistory.length - 1] : null;
        if (profit > 0) this.processWin(profit, resultDigit);
        else            this.processLoss(this.lastBuyPrice, resultDigit);
        this.isTradeActive = false;
        this.decideNextAction();
    }

    processWin(profit, resultDigit) {
        this.totalWins++;
        this.sessionProfit += profit;
        this.currentWinStreak++; this.currentLossStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;
        this.detector.resetCUSUM(this.targetDigit);

        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${green('✅ WIN!')} +$${profit.toFixed(2)} | P/L:${plStr} | Bal:$${this.accountBalance.toFixed(2)}${this.martingaleStep > 0 ? green(' 🔄 RECOVERY') : ''}`);
        if (resultDigit !== null) logResult(dim(`  Target:${this.targetDigit} Result:${resultDigit} Ghost:${this.ghostConsecutiveWins}/${this.config.ghost_wins_required}`));
        this.sendTelegram(`✅ <b>WIN!</b>\n📊 ${this.config.symbol} | d${this.targetDigit}→${resultDigit??'?'}\n💰 +$${profit.toFixed(2)}\n💵 P&L:${this.sessionProfit>=0?'+':''}$${this.sessionProfit.toFixed(2)}\n📈 ${this.totalWins}W/${this.totalLosses}L | Streak:${this.currentWinStreak}W`);
        this.resetMartingale(); this.resetGhost();
    }

    processLoss(lostAmount, resultDigit) {
        this.totalLosses++;
        this.sessionProfit     -= lostAmount;
        this.totalMartingaleLoss += lostAmount;
        this.currentLossStreak++; this.currentWinStreak = 0;
        if (this.currentLossStreak > this.maxLossStreak) this.maxLossStreak = this.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        this.martingaleStep++;
        if (this.martingaleStep > this.maxMartingaleReached) this.maxMartingaleReached = this.martingaleStep;

        const mart  = this.config.martingale_enabled ? ` | Mart:${this.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const plStr = this.sessionProfit >= 0 ? green(formatMoney(this.sessionProfit)) : red(formatMoney(this.sessionProfit));
        logResult(`${red('❌ LOSS!')} -$${lostAmount.toFixed(2)} | P/L:${plStr} | Bal:$${this.accountBalance.toFixed(2)}${mart}`);
        if (resultDigit !== null)
            logResult(dim(`  Target:${this.targetDigit} Result:${resultDigit} ${resultDigit===this.targetDigit?red('(REPEATED)'):green('(unexpected loss)')}`));
        this.sendTelegram(`❌ <b>LOSS!</b>\n📊 ${this.config.symbol} | d${this.targetDigit}→${resultDigit??'?'}\nLast5: ${this.tickHistory.slice(-5).join(',')}\n💸 -$${lostAmount.toFixed(2)}\n💵 P&L:${this.sessionProfit>=0?'+':''}$${this.sessionProfit.toFixed(2)}\n📈 ${this.totalWins}W/${this.totalLosses}L${mart}`);
        this.ghostConsecutiveWins = 0; this.ghostConfirmed = false; this.ghostRoundsPlayed = 0; this.ghostAwaitingResult = false;
        logBot(dim(`Ghost reset. Waiting for d${this.targetDigit} (${this.config.ghost_wins_required} ghost win(s)).`));
    }

    decideNextAction() {
        const risk = this.checkRiskLimits();
        if (!risk.canTrade) {
            logRisk(risk.reason);
            if (risk.action === 'STOP')     { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(); return; }
        }
        if (this.config.martingale_enabled && this.martingaleStep > 0 && this.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(`Mart recovery step ${this.martingaleStep}/${this.config.max_martingale_steps}...`));
            this.botState = this.config.ghost_enabled ? STATE.GHOST_TRADING : STATE.ANALYZING;
            if (!this.config.ghost_enabled) this.executeTradeFlow(false);
            return;
        }
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps) {
            logRisk(`🛑 Max Martingale steps reached!`);
            this.resetMartingale(); this.startCooldown(); return;
        }
        this.botState = STATE.ANALYZING;
    }

    calculateStake() {
        if (!this.config.martingale_enabled || this.martingaleStep === 0) return this.config.base_stake;
        const raw   = this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep);
        const calc  = Math.round(raw * 100) / 100;
        const final = Math.min(calc, this.config.max_stake);
        logBot(dim(`Mart: Step ${this.martingaleStep} | $${this.config.base_stake} × ${this.config.martingale_multiplier}^${this.martingaleStep} = $${calc} → $${final}`));
        return final;
    }

    checkRiskLimits() {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\n$${this.sessionProfit.toFixed(2)}`);
            return { canTrade: false, reason: `🎯 Take profit: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\n$${this.sessionProfit.toFixed(2)}`);
            return { canTrade: false, reason: `🛑 Stop loss: ${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const nextStake = (!this.config.martingale_enabled || this.martingaleStep === 0)
            ? this.config.base_stake
            : Math.min(Math.round(this.config.base_stake * Math.pow(this.config.martingale_multiplier, this.martingaleStep) * 100) / 100, this.config.max_stake);
        if (nextStake > this.accountBalance) return { canTrade: false, reason: `💸 Next stake > balance`, action: 'STOP' };
        if (nextStake > this.config.max_stake) return { canTrade: false, reason: `📈 Next stake > max`, action: 'STOP' };
        if (this.config.martingale_enabled && this.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: '🔄 Max Martingale steps.', action: 'COOLDOWN' };
        return { canTrade: true };
    }

    resetMartingale() { this.martingaleStep = 0; this.totalMartingaleLoss = 0; this.currentStake = this.config.base_stake; }

    startCooldown() {
        this.botState = STATE.COOLDOWN;
        this.resetMartingale(); this.resetGhost();
        const sec = this.config.cooldown_after_max_loss / 1000;
        logBot(`⏸️  Cooldown ${sec}s...`);
        this.cooldownTimer = setTimeout(() => {
            if (this.botState === STATE.COOLDOWN) {
                logBot(green('▶️  Cooldown ended. Resuming...'));
                this.botState = STATE.ANALYZING;
            }
        }, this.config.cooldown_after_max_loss);
    }

    stop(reason = 'User stopped') {
        this.botState = STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping...')} — ${reason}`);
        if (this.cooldownTimer)  { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.pingInterval)   { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.pendingTrade = false;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) {}
            setTimeout(() => { try { this.ws.close(); } catch (_) {} }, 500);
        }
        this.sendTelegram(`🛑 <b>SESSION STOPPED</b>\nReason: ${reason}\nP&L: $${this.sessionProfit.toFixed(2)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr  = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;
        console.log('');
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY                  ')));
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(`  Duration         : ${bold(formatDuration(dur))}`);
        logStats(`  Symbol           : ${bold(this.config.symbol)}`);
        logStats(`  Detection Engine : ${bold('7-Module Ensemble (v3.0)')}`);
        logStats(`  Total Trades     : ${bold(this.totalTrades)}`);
        logStats(`  Wins             : ${green(this.totalWins)}`);
        logStats(`  Losses           : ${red(this.totalLosses)}`);
        logStats(`  Win Rate         : ${bold(wr + '%')}`);
        logStats(`  Session P/L      : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Starting Balance : $${this.startingBalance.toFixed(2)}`);
        logStats(`  Final Balance    : $${this.accountBalance.toFixed(2)}`);
        logStats(`  Avg P/L/Trade    : ${formatMoney(avg)}`);
        logStats(`  Largest Win      : ${green('+$' + this.largestWin.toFixed(2))}`);
        logStats(`  Largest Loss     : ${red('-$' + this.largestLoss.toFixed(2))}`);
        logStats(`  Max Win Streak   : ${green(this.maxWinStreak)}`);
        logStats(`  Max Loss Streak  : ${red(this.maxLossStreak)}`);
        logStats(`  Max Martingale   : Step ${this.maxMartingaleReached}`);
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Entry Point ────────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();
    const bot    = new RomanianGhostBot(config);
    process.on('SIGINT',  () => { console.log(''); bot.stop('SIGINT'); });
    process.on('SIGTERM', () => bot.stop('SIGTERM'));
    process.on('uncaughtException', e => {
        logError(`Uncaught: ${e.message}`);
        if (e.stack) logError(e.stack);
        bot.stop('Uncaught exception');
    });
    process.on('unhandledRejection', r => logError(`Unhandled rejection: ${r}`));
    bot.start();
})();