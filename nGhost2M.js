#!/usr/bin/env node
// ============================================================================
//  ROMANIAN GHOST BOT — v4.0 Multi-Asset with State Persistence
//  Deriv Digit Differ — Multi-Method Ensemble Regime Engine
//  UPGRADED: Multi-Asset Support + State Persistence
// ============================================================================
'use strict';

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────────
const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8288121368:AAHYRb0Stk5dWUWN1iTYbdO3fyIEwIuZQR8";
const CHAT_ID = "752497117";
const STATE_FILE = path.join(__dirname, 'romanian-ghost01-state.json');
const STATE_SAVE_INTERVAL = 5000;

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m',
    red: '\x1b[31m', yellow: '\x1b[33m', magenta: '\x1b[35m',
    orange: '\x1b[38;5;208m', white: '\x1b[37m',
};
const col = (t, ...c) => c.join('') + t + C.reset;
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
    BOT: 'cyan', API: 'blue', TICK: 'dim', ANALYSIS: 'yellow',
    GHOST: 'magenta', TRADE: 'bold', RESULT: 'bold', RISK: 'red',
    STATS: 'cyan', ERROR: 'red+bold', HMM: 'orange', BOCPD: 'green',
    REGIME: 'magenta', STATE: 'blue',
};
const loggers = {};
['BOT', 'API', 'TICK', 'ANALYSIS', 'GHOST', 'TRADE', 'RESULT', 'RISK', 'STATS', 'ERROR', 'HMM', 'BOCPD', 'REGIME', 'STATE'].forEach(p => {
    const fn = {
        cyan: cyan, blue: blue, dim: dim, yellow: yellow, magenta: magenta,
        bold: bold, red: red, green: green, orange: t => col(t, C.orange),
        'red+bold': t => col(t, C.bold, C.red),
    }[PREFIX_COLOURS[p]] || (t => t);
    loggers[p] = m => {
        const ts = dim(`[${new Date().toTimeString().slice(0, 8)}]`);
        console.log(`${ts} ${fn(`[${p}]`)} ${m}`);
    };
});
const { BOT: logBot, API: logApi, TICK: logTick, ANALYSIS: logAnalysis,
    GHOST: logGhost, TRADE: logTrade, RESULT: logResult, RISK: logRisk,
    STATS: logStats, ERROR: logError, HMM: logHMM, BOCPD: logBocpd,
    REGIME: logRegime, STATE: logState } = loggers;

// ── State Persistence Manager ────────────────────────────────────────────────
class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                version: '4.0',
                config: {
                    base_stake: bot.config.base_stake,
                    martingale_multiplier: bot.config.martingale_multiplier,
                    max_martingale_steps: bot.config.max_martingale_steps,
                    take_profit: bot.config.take_profit,
                    stop_loss: bot.config.stop_loss,
                    repeat_threshold: bot.config.repeat_threshold,
                    hmm_nonrep_confidence: bot.config.hmm_nonrep_confidence,
                    bocpd_nonrep_confidence: bot.config.bocpd_nonrep_confidence,
                },
                global: {
                    sessionStartTime: bot.sessionStartTime,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    sessionProfit: bot.sessionProfit,
                    startingBalance: bot.startingBalance,
                    maxWinStreak: bot.maxWinStreak,
                    maxLossStreak: bot.maxLossStreak,
                    largestWin: bot.largestWin,
                    largestLoss: bot.largestLoss,
                },
                assets: {}
            };

            // Save per-asset state
            bot.assets.forEach(asset => {
                const assetBot = bot.assetBots[asset];
                if (assetBot) {
                    persistableState.assets[asset] = {
                        currentStake: assetBot.currentStake,
                        martingaleStep: assetBot.martingaleStep,
                        totalMartingaleLoss: assetBot.totalMartingaleLoss,
                        isTradeActive: assetBot.isTradeActive,
                        lastContractId: assetBot.lastContractId,
                        ghostConsecutiveWins: assetBot.ghostConsecutiveWins,
                        ghostRoundsPlayed: assetBot.ghostRoundsPlayed,
                        ghostConfirmed: assetBot.ghostConfirmed,
                        targetDigit: assetBot.targetDigit,
                        signalActive: assetBot.signalActive,
                        botState: assetBot.botState,
                        tickHistory: assetBot.tickHistory.slice(-bot.config.tick_history_size),
                        prevDigit: assetBot.prevDigit,
                        // Regime detector state
                        detector: {
                            bocpd: {
                                logR: assetBot.detector.bocpd.logR.slice(-100),
                                alphas: assetBot.detector.bocpd.alphas.slice(-100),
                                betas: assetBot.detector.bocpd.betas.slice(-100),
                                t: assetBot.detector.bocpd.t,
                                pNonRep: assetBot.detector.bocpd.pNonRep,
                                expectedRunLength: assetBot.detector.bocpd.expectedRunLength,
                            },
                            ewma: {
                                values: assetBot.detector.ewma.values,
                                n: assetBot.detector.ewma.n,
                            },
                            cusum: {
                                upC: assetBot.detector.cusum.upC,
                                downC: assetBot.detector.cusum.downC,
                                globalUp: assetBot.detector.cusum.globalUp,
                                globalDown: assetBot.detector.cusum.globalDown,
                            },
                            weights: assetBot.detector.weights,
                        }
                    };
                }
            });

            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            logState('💾 State saved to disk');
        } catch (error) {
            logError(`Failed to save state: ${error.message}`);
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                logState('📂 No previous state file found, starting fresh');
                return false;
            }
            const savedData = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMinutes = (Date.now() - savedData.savedAt) / 60000;
            
            // Only restore if state is less than 60 minutes old
            if (ageMinutes > 60) {
                logState(`⚠️ Saved state is ${ageMinutes.toFixed(1)} minutes old, starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }
            
            logState(`📂 Restoring state from ${ageMinutes.toFixed(1)} minutes ago`);
            return savedData;
        } catch (error) {
            logError(`Failed to load state: ${error.message}`);
            return false;
        }
    }

    static startAutoSave(bot) {
        setInterval(() => {
            StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);
        logState('🔄 Auto-save started (every 5 seconds)');
    }
}

// ── Config ────────────────────────────────────────────────────────────────────
function parseArgs() {
    return {
        api_token: TOKEN,
        app_id: '1089',
        endpoint: 'wss://ws.derivws.com/websockets/v3',
        assets: ['R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR'], // Multi-asset support
        base_stake: 0.61,
        currency: 'USD',
        contract_type: 'DIGITDIFF',
        // History
        tick_history_size: 5000,
        analysis_window: 5000,
        min_ticks_for_analysis: 50,
        // Regime detection thresholds
        repeat_threshold: 8,
        hmm_nonrep_confidence: 0.75,
        bocpd_nonrep_confidence: 0.82,
        min_regime_persistence: 8,
        acf_lag1_threshold: 0.15,
        ewma_trend_threshold: 2.0,
        cusum_up_threshold: 3.5,
        cusum_down_threshold: -4.0,
        cusum_slack: 0.15,
        structural_break_threshold: 0.15,
        // BOCPD
        bocpd_hazard: 1 / 150,
        bocpd_prior_alpha: 1,
        bocpd_prior_beta: 9,
        bocpd_min_run_for_signal: 15,
        // HMM
        hmm_refit_every: 50,
        hmm_min_discrimination: 0.10,
        // Ensemble
        repeat_confidence: 80,
        // Ghost
        ghost_enabled: false,
        ghost_wins_required: 1,
        ghost_max_rounds: 20000000000,
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
        // Multi-asset
        max_concurrent_trades: 2,
        asset_rotation_enabled: true,
    };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getLastDigit(price, asset) {
    const parts = price.toString().split('.');
    const frac = parts.length > 1 ? parts[1] : '';
    if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset))
        return frac.length >= 4 ? parseInt(frac[3], 10) : 0;
    if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset))
        return frac.length >= 3 ? parseInt(frac[2], 10) : 0;
    return frac.length >= 2 ? parseInt(frac[1], 10) : 0;
}

function formatMoney(v) { return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`; }
function formatDuration(ms) {
    const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function logSumExp(arr) {
    const m = Math.max(...arr);
    if (!isFinite(m)) return -Infinity;
    return m + Math.log(arr.reduce((s, x) => s + Math.exp(x - m), 0));
}

function binomialLogPMF(k, n, p) {
    if (p <= 0) return k === 0 ? 0 : -Infinity;
    if (p >= 1) return k === n ? 0 : -Infinity;
    let logC = 0;
    for (let i = 0; i < k; i++) logC += Math.log(n - i) - Math.log(i + 1);
    return logC + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

function betaIncomplete(x, a, b) {
    if (x < 0 || x > 1) return NaN;
    if (x === 0) return 0;
    if (x === 1) return 1;
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
    return front * continuedFraction(x, a, b);
}

function lgamma(z) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
        771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function continuedFraction(x, a, b) {
    const MAX = 200; const EPS = 3e-7;
    let f = 1, C = 1, D = 1 - (a + b) * x / (a + 1);
    if (Math.abs(D) < 1e-30) D = 1e-30;
    D = 1 / D; f = D;
    for (let m = 1; m <= MAX; m++) {
        let aa = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
        D = 1 + aa * D; C = 1 + aa / C;
        if (Math.abs(D) < 1e-30) D = 1e-30;
        if (Math.abs(C) < 1e-30) C = 1e-30;
        D = 1 / D; let delta = C * D; f *= delta;
        aa = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
        D = 1 + aa * D; C = 1 + aa / C;
        if (Math.abs(D) < 1e-30) D = 1e-30;
        if (Math.abs(C) < 1e-30) C = 1e-30;
        D = 1 / D; delta = C * D; f *= delta;
        if (Math.abs(delta - 1) < EPS) break;
    }
    return f;
}

// ── State Constants ────────────────────────────────────────────────────────────
const STATE = {
    INITIALIZING: 'INITIALIZING', CONNECTING: 'CONNECTING', AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS', ANALYZING: 'ANALYZING', GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE', WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT', COOLDOWN: 'COOLDOWN', STOPPED: 'STOPPED',
};

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 1: BAYESIAN ONLINE CHANGEPOINT DETECTION (BOCPD)
// ══════════════════════════════════════════════════════════════════════════════
class BOCPD {
    constructor(config) {
        this.hazard = config.bocpd_hazard;
        this.alpha0 = config.bocpd_prior_alpha;
        this.beta0 = config.bocpd_prior_beta;
        this.minRun = config.bocpd_min_run_for_signal;
        this.threshold = config.bocpd_nonrep_confidence;
        this.logR = [0];
        this.alphas = [this.alpha0];
        this.betas = [this.beta0];
        this.t = 0;
        this.lastChangepoint = 0;
        this.runHistory = [];
        this.obsHistory = [];
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
    }

    update(obs) {
        this.t++;
        this.obsHistory.push(obs);
        const H = this.hazard;
        const lenR = this.logR.length;

        const logPredictive = new Array(lenR);
        for (let r = 0; r < lenR; r++) {
            const theta = this.alphas[r] / (this.alphas[r] + this.betas[r]);
            const p = obs === 1 ? theta : (1 - theta);
            logPredictive[r] = Math.log(Math.max(p, 1e-300));
        }

        const logGrowthMass = logPredictive.map((lp, r) => lp + Math.log(1 - H) + this.logR[r]);
        const logChangepointMass = logSumExp(logPredictive.map((lp, r) => lp + Math.log(H) + this.logR[r]));

        const newLogR = new Array(lenR + 1);
        const newAlphas = new Array(lenR + 1);
        const newBetas = new Array(lenR + 1);

        newLogR[0] = logChangepointMass;
        newAlphas[0] = this.alpha0 + obs;
        newBetas[0] = this.beta0 + (1 - obs);

        for (let r = 0; r < lenR; r++) {
            newLogR[r + 1] = logGrowthMass[r];
            newAlphas[r + 1] = this.alphas[r] + obs;
            newBetas[r + 1] = this.betas[r] + (1 - obs);
        }

        const logZ = logSumExp(newLogR);
        this.logR = newLogR.map(v => v - logZ);
        this.alphas = newAlphas;
        this.betas = newBetas;

        if (this.logR.length > 800) {
            const threshold = Math.max(...this.logR) - 15;
            const keep = this.logR.map((v, i) => i).filter(i => this.logR[i] > threshold);
            if (!keep.includes(0)) keep.unshift(0);
            this.logR = keep.map(i => this.logR[i]);
            this.alphas = keep.map(i => this.alphas[i]);
            this.betas = keep.map(i => this.betas[i]);
            const logZ2 = logSumExp(this.logR);
            this.logR = this.logR.map(v => v - logZ2);
        }

        const probs = this.logR.map(Math.exp);
        this.expectedRunLength = probs.reduce((s, p, r) => s + p * r, 0);
        const modeIdx = this.logR.indexOf(Math.max(...this.logR));
        const thetaMode = this.alphas[modeIdx] / (this.alphas[modeIdx] + this.betas[modeIdx]);
        const pLongRun = probs.slice(this.minRun).reduce((s, p) => s + p, 0);
        const pLowTheta = betaIncomplete(0.15, this.alphas[modeIdx], this.betas[modeIdx]);
        this.pNonRep = clamp(pLongRun * 0.5 + pLowTheta * 0.5, 0, 1);

        this.runHistory.push({ t: this.t, modeRL: modeIdx, theta: thetaMode, pNonRep: this.pNonRep });
        if (this.runHistory.length > 200) this.runHistory.shift();

        return {
            pNonRep: this.pNonRep,
            expectedRL: this.expectedRunLength,
            modeRL: modeIdx,
            thetaEstimate: thetaMode,
            pLongRun,
            pLowTheta,
            pChangepoint: Math.exp(this.logR[0]),
        };
    }

    isNonRepRegime() {
        return this.pNonRep >= this.threshold && this.expectedRunLength >= this.minRun;
    }

    reset() {
        this.logR = [0];
        this.alphas = [this.alpha0];
        this.betas = [this.beta0];
        this.t = 0;
        this.pNonRep = 0.5;
        this.expectedRunLength = 0;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 2: 2-STATE BINARY HMM
// ══════════════════════════════════════════════════════════════════════════════
class BinaryHMM {
    constructor(config) {
        this.cfg = config;
        this.MIN_DISCRIM = config.hmm_min_discrimination || 0.10;
        this.pi = [0.65, 0.35];
        this.A = [[0.93, 0.07], [0.22, 0.78]];
        this.B = [[0.91, 0.09], [0.55, 0.45]];
        this.logAlpha = [Math.log(0.65), Math.log(0.35)];
        this.fitted = false;
        this.lastFitDiscrim = 0;
    }

    buildObs(digitSeq) {
        const obs = new Array(digitSeq.length - 1);
        for (let t = 1; t < digitSeq.length; t++) {
            obs[t - 1] = digitSeq[t] === digitSeq[t - 1] ? 1 : 0;
        }
        return obs;
    }

    baumWelch(obs, maxIter = 30, tol = 1e-6) {
        const T = obs.length, N = 2, O = 2;
        if (T < 30) return { accepted: false, reason: 'too few obs' };
        
        let pi = [...this.pi];
        let A = this.A.map(r => [...r]);
        let B = this.B.map(r => [...r]);
        let prevLogL = -Infinity;

        for (let iter = 0; iter < maxIter; iter++) {
            const logAlpha = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logAlpha[0][s] = Math.log(pi[s] + 1e-300) + Math.log(B[s][obs[0]] + 1e-300);
            for (let t = 1; t < T; t++) {
                for (let s = 0; s < N; s++) {
                    const inc = [0, 1].map(p => logAlpha[t - 1][p] + Math.log(A[p][s] + 1e-300));
                    logAlpha[t][s] = logSumExp(inc) + Math.log(B[s][obs[t]] + 1e-300);
                }
            }
            const logL = logSumExp(logAlpha[T - 1]);

            const logBeta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let s = 0; s < N; s++) logBeta[T - 1][s] = 0;
            for (let t = T - 2; t >= 0; t--) {
                for (let s = 0; s < N; s++) {
                    const vals = [0, 1].map(nx => Math.log(A[s][nx] + 1e-300) + Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx]);
                    logBeta[t][s] = logSumExp(vals);
                }
            }

            const logGamma = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
            for (let t = 0; t < T; t++) {
                const d = logSumExp([0, 1].map(s => logAlpha[t][s] + logBeta[t][s]));
                for (let s = 0; s < N; s++) logGamma[t][s] = logAlpha[t][s] + logBeta[t][s] - d;
            }

            const logXi = Array.from({ length: T - 1 }, () => Array.from({ length: N }, () => new Array(N).fill(-Infinity)));
            for (let t = 0; t < T - 1; t++) {
                const d = logSumExp([0, 1].map(s => logAlpha[t][s] + logBeta[t][s]));
                for (let s = 0; s < N; s++) for (let nx = 0; nx < N; nx++) {
                    logXi[t][s][nx] = logAlpha[t][s] + Math.log(A[s][nx] + 1e-300) + Math.log(B[nx][obs[t + 1]] + 1e-300) + logBeta[t + 1][nx] - d;
                }
            }

            for (let s = 0; s < N; s++) pi[s] = Math.exp(logGamma[0][s]);
            const piSum = pi.reduce((a, b) => a + b, 0);
            pi = pi.map(v => v / piSum);

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.slice(0, T - 1).map(g => g[s]));
                for (let nx = 0; nx < N; nx++) {
                    const numer = logSumExp(logXi.map(xi => xi[s][nx]));
                    A[s][nx] = Math.exp(numer - denom);
                }
                const rs = A[s].reduce((a, b) => a + b, 0);
                A[s] = A[s].map(v => v / rs);
            }

            for (let s = 0; s < N; s++) {
                const denom = logSumExp(logGamma.map(g => g[s]));
                for (let o = 0; o < O; o++) {
                    const relevant = logGamma.filter((_, t) => obs[t] === o).map(g => g[s]);
                    B[s][o] = relevant.length > 0 ? Math.exp(logSumExp(relevant) - denom) : 1e-10;
                }
                const bsum = B[s].reduce((a, b) => a + b, 0);
                B[s] = B[s].map(v => v / bsum);
            }

            if (Math.abs(logL - prevLogL) < tol) break;
            prevLogL = logL;
        }

        if (B[0][1] > B[1][1]) {
            [pi[0], pi[1]] = [pi[1], pi[0]];
            [A[0], A[1]] = [A[1], A[0]];
            A[0] = [A[0][1], A[0][0]];
            A[1] = [A[1][1], A[1][0]];
            [B[0], B[1]] = [B[1], B[0]];
        }

        const discrimination = B[1][1] - B[0][1];
        if (discrimination < this.MIN_DISCRIM) {
            return { accepted: false, discrimination, repeatNR: B[0][1], repeatREP: B[1][1], reason: `discrimination ${(discrimination * 100).toFixed(1)}% < ${(this.MIN_DISCRIM * 100).toFixed(0)}% threshold` };
        }

        this.pi = pi; this.A = A; this.B = B;
        this.fitted = true;
        this.lastFitDiscrim = discrimination;
        return { accepted: true, discrimination, repeatNR: B[0][1], repeatREP: B[1][1] };
    }

    viterbi(obs) {
        const T = obs.length, N = 2;
        if (T === 0) return null;
        const logDelta = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
        const psi = Array.from({ length: T }, () => new Array(N).fill(0));
        
        for (let s = 0; s < N; s++) logDelta[0][s] = Math.log(this.pi[s] + 1e-300) + Math.log(this.B[s][obs[0]] + 1e-300);
        for (let t = 1; t < T; t++) {
            for (let s = 0; s < N; s++) {
                let best = -Infinity, bp = 0;
                for (let p = 0; p < N; p++) {
                    const v = logDelta[t - 1][p] + Math.log(this.A[p][s] + 1e-300);
                    if (v > best) { best = v; bp = p; }
                }
                logDelta[t][s] = best + Math.log(this.B[s][obs[t]] + 1e-300);
                psi[t][s] = bp;
            }
        }

        const seq = new Array(T);
        seq[T - 1] = logDelta[T - 1][0] >= logDelta[T - 1][1] ? 0 : 1;
        for (let t = T - 2; t >= 0; t--) seq[t] = psi[t + 1][seq[t + 1]];
        
        const cur = seq[T - 1];
        let persistence = 1;
        for (let t = T - 2; t >= 0; t--) { if (seq[t] === cur) persistence++; else break; }
        
        let transitions = 0;
        for (let t = 1; t < T; t++) if (seq[t] !== seq[t - 1]) transitions++;
        
        const seg = Math.max(1, Math.floor(T / 5));
        const segFracs = [];
        for (let i = 0; i < 5 && i * seg < T; i++) {
            const sl = seq.slice(i * seg, Math.min((i + 1) * seg, T));
            segFracs.push(sl.filter(s => s === 0).length / sl.length);
        }
        const stability = segFracs.reduce((a, b) => a + b, 0) / segFracs.length;
        
        return { stateSeq: seq, currentState: cur, persistence, transitions, stability };
    }

    updateForward(obs_t) {
        const N = 2;
        const newLogA = new Array(N);
        for (let s = 0; s < N; s++) {
            const inc = this.logAlpha.map((la, p) => la + Math.log(this.A[p][s] + 1e-300));
            newLogA[s] = logSumExp(inc) + Math.log(this.B[s][obs_t] + 1e-300);
        }
        const d = logSumExp(newLogA);
        this.logAlpha = newLogA;
        return [Math.exp(newLogA[0] - d), Math.exp(newLogA[1] - d)];
    }

    repeatEmission(state) { return this.B[state][1]; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 3: MULTI-SCALE EWMA STACK
// ══════════════════════════════════════════════════════════════════════════════
class EWMAStack {
    constructor() {
        this.lambdas = [0.40, 0.18, 0.07, 0.025];
        this.names = ['ultra-short(~4t)', 'short(~15t)', 'medium(~40t)', 'long(~100t)'];
        this.values = [null, null, null, null];
        this.n = 0;
    }

    update(repeatObs) {
        const v = repeatObs * 100;
        this.n++;
        for (let i = 0; i < 4; i++) {
            if (this.values[i] === null) {
                this.values[i] = v;
            } else {
                this.values[i] = this.lambdas[i] * v + (1 - this.lambdas[i]) * this.values[i];
            }
        }
    }

    get(idx) { return this.values[i] ?? 50; }
    trend() { return this.get(1) - this.get(3); }
    allBelowThreshold(threshold) { return this.values.every(v => v === null || v < threshold); }
    summary() { return this.names.map((n, i) => `${n}=${this.get(i).toFixed(1)}%`).join(' | '); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 4: LAG AUTOCORRELATION
// ══════════════════════════════════════════════════════════════════════════════
function computeACF(seq, maxLag = 5) {
    const n = seq.length;
    if (n < maxLag + 2) return new Array(maxLag).fill(0);
    const mean = seq.reduce((s, v) => s + v, 0) / n;
    const variance = seq.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    if (variance < 1e-10) return new Array(maxLag).fill(0);
    const acf = [];
    for (let lag = 1; lag <= maxLag; lag++) {
        let cov = 0;
        for (let t = 0; t < n - lag; t++) {
            cov += (seq[t] - mean) * (seq[t + lag] - mean);
        }
        acf.push(cov / ((n - lag) * variance));
    }
    return acf;
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 5: STRUCTURAL BREAK DETECTOR
// ══════════════════════════════════════════════════════════════════════════════
function structuralBreakTest(repeatSeq) {
    const n = repeatSeq.length;
    if (n < 20) return { lrtStat: 0, pBreak: 0, rateOld: 0.1, rateNew: 0.1 };
    const half = Math.floor(n / 2);
    const oldHalf = repeatSeq.slice(0, half);
    const newHalf = repeatSeq.slice(half);
    const k1 = oldHalf.reduce((s, v) => s + v, 0);
    const k2 = newHalf.reduce((s, v) => s + v, 0);
    const n1 = oldHalf.length, n2 = newHalf.length;
    const p1 = k1 / n1, p2 = k2 / n2;
    const pPool = (k1 + k2) / (n1 + n2);

    function logLik(k, n, p) {
        if (p <= 0 || p >= 1) return 0;
        return k * Math.log(p) + (n - k) * Math.log(1 - p);
    }

    const llAlt = logLik(k1, n1, p1) + logLik(k2, n2, p2);
    const llNull = logLik(k1 + k2, n1 + n2, pPool);
    const lrtStat = 2 * (llAlt - llNull);
    const chi2cdf = lrtStat <= 0 ? 0 : Math.min(0.9999, 1 - Math.exp(-0.5 * Math.pow(Math.max(0, lrtStat), 1) * 0.5));
    const pBreak = p2 > p1 ? chi2cdf : 0;
    return { lrtStat: Math.max(0, lrtStat), pBreak, rateOld: p1, rateNew: p2 };
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMPONENT 6: TWO-SIDED CUSUM
// ══════════════════════════════════════════════════════════════════════════════
class TwoSidedCUSUM {
    constructor(config) {
        this.slack = config.cusum_slack;
        this.upThr = config.cusum_up_threshold;
        this.downThr = config.cusum_down_threshold;
        this.upC = new Array(10).fill(0);
        this.downC = new Array(10).fill(0);
        this.globalUp = 0;
        this.globalDown = 0;
    }

    update(digit, isRepeat, p0 = 0.10, p1 = 0.40) {
        const obs = isRepeat ? 1 : 0;
        const logLR = Math.log((isRepeat ? p1 : (1 - p1)) / ((isRepeat ? p0 : (1 - p0)) + 1e-300) + 1e-300);
        this.upC[digit] = Math.max(0, this.upC[digit] + logLR - this.slack);
        this.downC[digit] = Math.min(0, this.downC[digit] + logLR + this.slack);
        this.globalUp = Math.max(0, this.globalUp + logLR - this.slack);
        this.globalDown = Math.min(0, this.globalDown + logLR + this.slack);
    }

    resetDigit(d) { this.upC[d] = 0; this.downC[d] = 0; }
    resetGlobal() { this.globalUp = 0; this.globalDown = 0; }
    upAlarm(digit) { return this.upC[digit] > this.upThr || this.globalUp > this.upThr; }
    downConfirmed(digit) { return this.downC[digit] < this.downThr && this.globalDown < this.downThr; }
    summary(digit) {
        return `up=${this.upC[digit].toFixed(2)}(${this.upAlarm(digit) ? 'ALARM' : 'ok'}) ` +
            `down=${this.downC[digit].toFixed(2)}(${this.downConfirmed(digit) ? 'confirmed' : 'pending'}) ` +
            `globalUp=${this.globalUp.toFixed(2)} globalDown=${this.globalDown.toFixed(2)}`;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN REGIME DETECTOR: ENSEMBLE OF ALL COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════
class AdvancedRegimeDetector {
    constructor(config) {
        this.cfg = config;
        this.bocpd = new BOCPD(config);
        this.hmm = new BinaryHMM(config);
        this.ewma = new EWMAStack();
        this.cusum = new TwoSidedCUSUM(config);
        this.perDigitRate = new Array(10).fill(10);
        this.repeatBuffer = [];
        this.BUFFER_MAX = 500;
        this.weights = { bocpd: 1.0, hmm: 1.0, ewma: 1.0, acf: 0.7, structural: 0.6, cusum: 1.0 };
        this.ticksSinceRefit = 0;
        this.hmmResult = null;
        this.bocpdResult = null;
    }

    computePerDigitRepeatRate(window) {
        const transFrom = new Array(10).fill(0);
        const transRepeat = new Array(10).fill(0);
        for (let i = 0; i < window.length - 1; i++) {
            transFrom[window[i]]++;
            if (window[i + 1] === window[i]) transRepeat[window[i]]++;
        }
        return transFrom.map((n, d) => n > 0 ? (transRepeat[d] / n) * 100 : 10);
    }

    tick(prevDigit, curDigit) {
        const isRepeat = prevDigit === curDigit;
        const obs_binary = isRepeat ? 1 : 0;
        this.bocpdResult = this.bocpd.update(obs_binary);
        this.ewma.update(obs_binary);
        this.cusum.update(prevDigit, isRepeat, 0.10, 0.40);
        this.repeatBuffer.push(obs_binary);
        if (this.repeatBuffer.length > this.BUFFER_MAX) this.repeatBuffer.shift();
        this.ticksSinceRefit++;
    }

    analyze(tickHistory, targetDigit) {
        const window = tickHistory.slice(-this.cfg.analysis_window);
        const len = window.length;
        if (len < this.cfg.min_ticks_for_analysis) {
            return { valid: false, reason: `insufficient data (${len}/${this.cfg.min_ticks_for_analysis})` };
        }

        const binaryObs = this.hmm.buildObs(window);

        if (!this.hmm.fitted || this.ticksSinceRefit >= this.cfg.hmm_refit_every) {
            const fitResult = this.hmm.baumWelch(binaryObs);
            this.ticksSinceRefit = 0;
            if (fitResult) {
                if (fitResult.accepted) {
                    logHMM(`📐 HMM(binary) fitted | Discrimination: ${(fitResult.discrimination * 100).toFixed(1)}% ✅`);
                } else {
                    logHMM(yellow(`⚠️  HMM Baum-Welch rejected: ${fitResult.reason}`));
                }
            }
        }

        const vit = this.hmm.viterbi(binaryObs);
        if (!vit) return { valid: false, reason: 'viterbi failed' };

        let logA = [Math.log(this.hmm.pi[0] + 1e-300), Math.log(this.hmm.pi[1] + 1e-300)];
        logA[0] += Math.log(this.hmm.B[0][binaryObs[0]] + 1e-300);
        logA[1] += Math.log(this.hmm.B[1][binaryObs[0]] + 1e-300);
        for (let t = 1; t < binaryObs.length; t++) {
            const nA = [0, 1].map(s => {
                const inc = [0, 1].map(p => logA[p] + Math.log(this.hmm.A[p][s] + 1e-300));
                return logSumExp(inc) + Math.log(this.hmm.B[s][binaryObs[t]] + 1e-300);
            });
            logA = nA;
        }
        const denom = logSumExp(logA);
        const posteriorNR = Math.exp(logA[0] - denom);
        const posteriorRep = Math.exp(logA[1] - denom);

        const rawRepeatProb = this.computePerDigitRepeatRate(window);
        const shortWin = window.slice(-20);
        const shortRepeats = shortWin.slice(1).filter((d, i) => d === shortWin[i]).length;
        const recentRate = (shortRepeats / (shortWin.length - 1)) * 100;

        const acfWindow = this.repeatBuffer.slice(-Math.min(this.repeatBuffer.length, 200));
        const acf = computeACF(acfWindow, 5);

        const breakBuf = this.repeatBuffer.slice(-100);
        const breakResult = structuralBreakTest(breakBuf);

        const bocpd = this.bocpdResult || { pNonRep: 0.5, expectedRL: 0, modeRL: 0, thetaEstimate: 0.1, pChangepoint: 0.5 };
        const ewmaValues = [0, 1, 2, 3].map(i => this.ewma.get(i));
        const ewmaTrend = this.ewma.trend();
        const cusumUpAlarm = this.cusum.upAlarm(targetDigit);
        const cusumDownConfirm = this.cusum.downConfirmed(targetDigit);

        const threshold = this.cfg.repeat_threshold;
        const w = this.weights;

        const bocpdScore = (() => {
            if (!this.bocpd.isNonRepRegime()) return 0;
            const rl = Math.min(bocpd.modeRL, 150) / 150;
            return rl * 25 * w.bocpd;
        })();

        const hmmScore = (() => {
            if (vit.currentState !== 0) return 0;
            const persist = clamp(vit.persistence / this.cfg.min_regime_persistence, 0, 1);
            const stability = vit.stability;
            const posterior = clamp((posteriorNR - 0.5) / 0.5, 0, 1);
            return ((persist * 0.4 + stability * 0.3 + posterior * 0.3) * 25) * w.hmm;
        })();

        const ewmaScore = (() => {
            const allBelow = ewmaValues.every(v => v < threshold);
            if (!allBelow) return 0;
            const trendOk = ewmaTrend <= this.cfg.ewma_trend_threshold;
            const score = allBelow && trendOk ? 1.0 : 0.5;
            const margin = Math.min(...ewmaValues.map(v => Math.max(0, threshold - v))) / threshold;
            return (score * 0.7 + margin * 0.3) * 20 * w.ewma;
        })();

        const acfScore = (() => {
            const lag1 = acf[0] ?? 0;
            if (lag1 >= this.cfg.acf_lag1_threshold) return 0;
            const score = clamp(1 - lag1 / this.cfg.acf_lag1_threshold, 0, 1);
            const bonus = lag1 < 0 ? 0.1 : 0;
            return Math.min(1, score + bonus) * 15 * w.acf;
        })();

        const breakScore = (() => {
            if (breakResult.pBreak > this.cfg.structural_break_threshold) return 0;
            return (1 - breakResult.pBreak / this.cfg.structural_break_threshold) * 10 * w.structural;
        })();

        const cusumScore = (() => {
            if (cusumUpAlarm) return 0;
            const base = 3;
            const bonus = cusumDownConfirm ? 2 : 0;
            return (base + bonus) * w.cusum;
        })();

        let rawScore = bocpdScore + hmmScore + ewmaScore + acfScore + breakScore + cusumScore;

        if (vit.currentState !== 0) rawScore = 0;
        if (posteriorNR < this.cfg.hmm_nonrep_confidence) rawScore = Math.min(rawScore, 30);
        if (rawRepeatProb[targetDigit] >= threshold) rawScore = 0;
        if (this.ewma.get(0) >= threshold || this.ewma.get(1) >= threshold) rawScore = 0;
        if (cusumUpAlarm) rawScore = 0;
        if (bocpd.pChangepoint > 0.3) rawScore = Math.min(rawScore, 25);
        if (ewmaTrend > this.cfg.ewma_trend_threshold * 2) rawScore = 0;

        const safetyScore = Math.round(clamp(rawScore, 0, 100));

        const signalActive = (
            vit.currentState === 0 &&
            posteriorNR >= this.cfg.hmm_nonrep_confidence &&
            vit.persistence >= this.cfg.min_regime_persistence &&
            this.bocpd.isNonRepRegime() &&
            bocpd.pNonRep >= this.cfg.bocpd_nonrep_confidence &&
            bocpd.modeRL >= this.cfg.bocpd_min_run_for_signal &&
            rawRepeatProb[targetDigit] < threshold &&
            this.ewma.get(0) < threshold && this.ewma.get(1) < threshold &&
            ewmaTrend <= this.cfg.ewma_trend_threshold &&
            (acf[0] ?? 0) < this.cfg.acf_lag1_threshold &&
            !cusumUpAlarm &&
            breakResult.pBreak < this.cfg.structural_break_threshold &&
            safetyScore >= this.cfg.repeat_confidence
        );

        return {
            valid: true,
            hmmState: vit.currentState,
            hmmStateName: vit.currentState === 0 ? 'NON-REP' : 'REP',
            hmmPersistence: vit.persistence,
            hmmTransitions: vit.transitions,
            hmmStability: vit.stability,
            posteriorNR,
            posteriorRep,
            hmmA: this.hmm.A,
            hmmB_repeatNR: this.hmm.repeatEmission(0),
            hmmB_repeatREP: this.hmm.repeatEmission(1),
            hmmDiscrim: this.hmm.lastFitDiscrim,
            bocpdPNonRep: bocpd.pNonRep,
            bocpdModeRL: bocpd.modeRL,
            bocpdExpRL: bocpd.expectedRL,
            bocpdTheta: bocpd.thetaEstimate,
            bocpdPChangepoint: bocpd.pChangepoint,
            bocpdIsNonRep: this.bocpd.isNonRepRegime(),
            ewmaValues,
            ewmaTrend,
            acf,
            structBreak: breakResult,
            cusumUpAlarm,
            cusumDownConfirm,
            cusumUp: this.cusum.upC[targetDigit],
            cusumDown: this.cusum.downC[targetDigit],
            cusumGlobalUp: this.cusum.globalUp,
            rawRepeatProb,
            recentRate,
            componentScores: { bocpdScore, hmmScore, ewmaScore, acfScore, breakScore, cusumScore },
            safetyScore,
            signalActive,
        };
    }

    applyTradeFeedback(won, regime) {
        if (!regime || !regime.valid) return;
        const decay = 0.85, restore = 1.02;
        if (!won) {
            for (const key of Object.keys(this.weights)) this.weights[key] = Math.max(0.5, this.weights[key] * decay);
        } else {
            for (const key of Object.keys(this.weights)) this.weights[key] = Math.min(1.0, this.weights[key] * restore);
        }
    }

    resetCUSUM(digit) { this.cusum.resetDigit(digit); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-ASSET BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════
class MultiAssetRomanianGhostBot {
    constructor(config) {
        this.config = config;
        this.ws = null;
        this.botState = STATE.INITIALIZING;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT = 50;
        this.pingInterval = null;
        this.requestId = 0;
        this.accountBalance = 0;
        this.startingBalance = 0;
        this.accountId = '';
        
        // Multi-asset support
        this.assets = config.assets;
        this.assetBots = {};
        this.activeTrades = new Map(); // asset -> contract info
        this.suspendedAssets = new Set();
        
        // Global stats
        this.sessionStartTime = Date.now();
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.sessionProfit = 0;
        this.maxWinStreak = 0;
        this.maxLossStreak = 0;
        this.largestWin = 0;
        this.largestLoss = 0;
        this.cooldownTimer = null;
        this.telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        
        // Initialize per-asset bots
        this.assets.forEach(asset => {
            this.assetBots[asset] = {
                detector: new AdvancedRegimeDetector(config),
                tickHistory: [],
                prevDigit: -1,
                currentStake: config.base_stake,
                martingaleStep: 0,
                totalMartingaleLoss: 0,
                isTradeActive: false,
                lastContractId: null,
                ghostConsecutiveWins: 0,
                ghostRoundsPlayed: 0,
                ghostConfirmed: false,
                ghostAwaitingResult: false,
                targetDigit: -1,
                targetRepeatRate: 0,
                signalActive: false,
                pendingTrade: false,
                botState: STATE.INITIALIZING,
                currentWinStreak: 0,
                currentLossStreak: 0,
            };
        });
    }

    start() {
        this.printBanner();
        this.loadSavedState();
        this.connectWS();
        StatePersistence.startAutoSave(this);
    }

    printBanner() {
        const c = this.config;
        console.log('');
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log(bold(cyan('   👻  ROMANIAN GHOST BOT v4.0  —  Multi-Asset + State Persistence  ')));
        console.log(bold(cyan('   BOCPD + HMM + EWMA Stack + ACF + Structural Break + CUSUM        ')));
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log(`  Assets              : ${bold(c.assets.join(', '))}`);
        console.log(`  Base Stake          : ${bold('$' + c.base_stake.toFixed(2))}`);
        console.log(`  Max Concurrent      : ${bold(c.max_concurrent_trades)}`);
        console.log(`  Take Profit         : ${green('$' + c.take_profit.toFixed(2))}`);
        console.log(`  Stop Loss           : ${red('$' + c.stop_loss.toFixed(2))}`);
        console.log(bold(cyan('═══════════════════════════════════════════════════════════════════')));
        console.log('');
    }

    loadSavedState() {
        const savedState = StatePersistence.loadState();
        if (!savedState) return;
        
        try {
            // Restore global stats
            const global = savedState.global;
            this.sessionStartTime = global.sessionStartTime || Date.now();
            this.totalTrades = global.totalTrades || 0;
            this.totalWins = global.totalWins || 0;
            this.totalLosses = global.totalLosses || 0;
            this.sessionProfit = global.sessionProfit || 0;
            this.startingBalance = global.startingBalance || 0;
            this.maxWinStreak = global.maxWinStreak || 0;
            this.maxLossStreak = global.maxLossStreak || 0;
            this.largestWin = global.largestWin || 0;
            this.largestLoss = global.largestLoss || 0;

            // Restore per-asset state
            if (savedState.assets) {
                Object.keys(savedState.assets).forEach(asset => {
                    if (this.assetBots[asset]) {
                        const assetState = savedState.assets[asset];
                        const assetBot = this.assetBots[asset];
                        
                        assetBot.currentStake = assetState.currentStake || this.config.base_stake;
                        assetBot.martingaleStep = assetState.martingaleStep || 0;
                        assetBot.totalMartingaleLoss = assetState.totalMartingaleLoss || 0;
                        assetBot.isTradeActive = assetState.isTradeActive || false;
                        assetBot.lastContractId = assetState.lastContractId || null;
                        assetBot.ghostConsecutiveWins = assetState.ghostConsecutiveWins || 0;
                        assetBot.ghostRoundsPlayed = assetState.ghostRoundsPlayed || 0;
                        assetBot.ghostConfirmed = assetState.ghostConfirmed || false;
                        assetBot.targetDigit = assetState.targetDigit || -1;
                        assetBot.signalActive = assetState.signalActive || false;
                        assetBot.botState = assetState.botState || STATE.INITIALIZING;
                        assetBot.tickHistory = assetState.tickHistory || [];
                        assetBot.prevDigit = assetState.prevDigit || -1;

                        // Restore detector state
                        if (assetState.detector) {
                            const det = assetState.detector;
                            if (det.bocpd) {
                                assetBot.detector.bocpd.logR = det.bocpd.logR || [0];
                                assetBot.detector.bocpd.alphas = det.bocpd.alphas || [1];
                                assetBot.detector.bocpd.betas = det.bocpd.betas || [9];
                                assetBot.detector.bocpd.t = det.bocpd.t || 0;
                                assetBot.detector.bocpd.pNonRep = det.bocpd.pNonRep || 0.5;
                                assetBot.detector.bocpd.expectedRunLength = det.bocpd.expectedRunLength || 0;
                            }
                            if (det.ewma) {
                                assetBot.detector.ewma.values = det.ewma.values || [null, null, null, null];
                                assetBot.detector.ewma.n = det.ewma.n || 0;
                            }
                            if (det.cusum) {
                                assetBot.detector.cusum.upC = det.cusum.upC || new Array(10).fill(0);
                                assetBot.detector.cusum.downC = det.cusum.downC || new Array(10).fill(0);
                                assetBot.detector.cusum.globalUp = det.cusum.globalUp || 0;
                                assetBot.detector.cusum.globalDown = det.cusum.globalDown || 0;
                            }
                            if (det.weights) {
                                assetBot.detector.weights = det.weights || { bocpd: 1.0, hmm: 1.0, ewma: 1.0, acf: 0.7, structural: 0.6, cusum: 1.0 };
                            }
                        }

                        logState(`✅ Restored state for ${asset}: Stake=$${assetBot.currentStake.toFixed(2)}, Martingale=${assetBot.martingaleStep}`);
                    }
                });
            }

            logState(`✅ Global state restored: Trades=${this.totalTrades}, P&L=${formatMoney(this.sessionProfit)}`);
        } catch (error) {
            logError(`Error restoring state: ${error.message}`);
        }
    }

    connectWS() {
        this.botState = STATE.CONNECTING;
        const url = `${this.config.endpoint}?app_id=${this.config.app_id}`;
        logApi(`Connecting to ${dim(url)} ...`);
        
        try { this.ws = new WebSocket(url); } 
        catch (e) { logError(`WS create failed: ${e.message}`); this.attemptReconnect(); return; }
        
        this.ws.on('open', () => {
            logApi(green('✅ Connected'));
            this.reconnectAttempts = 0;
            this.botState = STATE.AUTHENTICATING;
            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ ping: 1 });
            }, 30000);
            logApi('Authenticating...');
            this.send({ authorize: this.config.api_token });
        });
        
        this.ws.on('message', raw => { 
            try { this.handleMessage(JSON.parse(raw)); } 
            catch (e) { logError(`Parse: ${e.message}`); } 
        });
        
        this.ws.on('close', code => {
            logApi(`⚠️  Closed (${code})`);
            if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
            StatePersistence.saveState(this);
            if (this.botState !== STATE.STOPPED) this.attemptReconnect();
        });
        
        this.ws.on('error', e => logError(`WS error: ${e.message}`));
    }

    attemptReconnect() {
        if (this.reconnectAttempts >= this.MAX_RECONNECT) { 
            this.stop('Max reconnects'); 
            return; 
        }
        this.reconnectAttempts++;
        const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 5000, 60000);
        logApi(`Reconnect in ${delay / 1000}s (${this.reconnectAttempts}/${this.MAX_RECONNECT})...`);
        
        this.assets.forEach(asset => {
            this.assetBots[asset].isTradeActive = false;
        });
        
        setTimeout(() => { 
            if (this.botState !== STATE.STOPPED) this.connectWS(); 
        }, delay);
    }

    send(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!payload.ping) payload.req_id = ++this.requestId;
        try { this.ws.send(JSON.stringify(payload)); } 
        catch (e) { logError(`Send: ${e.message}`); }
    }

    sendTelegram(text) { 
        this.telegramBot.sendMessage(CHAT_ID, text, { parse_mode: 'HTML' }).catch(() => { }); 
    }

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
        }
    }

    handleApiError(msg) {
        const code = msg.error.code || 'UNKNOWN', emsg = msg.error.message || 'Unknown';
        logError(`[${code}] on ${msg.msg_type || '?'}: ${emsg}`);
        if (['InvalidToken', 'AuthorizationRequired'].includes(code)) { this.stop('Auth failed'); return; }
        if (code === 'RateLimit') setTimeout(() => { 
            if (this.botState !== STATE.STOPPED) { 
                this.assets.forEach(asset => { this.assetBots[asset].isTradeActive = false; }); 
            } 
        }, 10000);
        if (code === 'InsufficientBalance') { this.stop('Insufficient balance'); return; }
        if (msg.msg_type === 'buy') { 
            const asset = this.activeTrades.get(msg.echo_req?.parameters?.symbol);
            if (asset) this.assetBots[asset].isTradeActive = false; 
        }
    }

    handleAuth(msg) {
        if (!msg.authorize) return;
        const auth = msg.authorize;
        this.accountBalance = parseFloat(auth.balance);
        this.startingBalance = this.accountBalance;
        this.accountId = auth.loginid || 'N/A';
        
        const isDemo = this.accountId.startsWith('VRTC');
        logApi(`${green('✅ Authenticated')} | ${bold(this.accountId)} ${isDemo ? dim('(Demo)') : red('(REAL MONEY!)')} | Balance: ${green('$' + this.accountBalance.toFixed(2))}`);
        if (!isDemo) logRisk('⚠️  REAL ACCOUNT — trading with real money!');
        
        this.send({ balance: 1, subscribe: 1 });
        this.send({ transaction: 1, subscribe: 1 });
        this.botState = STATE.COLLECTING_TICKS;
        
        // Fetch history for all assets
        this.assets.forEach(asset => {
            logBot(`Fetching last ${bold(this.config.tick_history_size)} ticks for ${asset}...`);
            this.send({ 
                ticks_history: asset, 
                count: this.config.tick_history_size, 
                end: 'latest', 
                style: 'ticks',
                subscribe: 0
            });
        });
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        if (!this.assetBots[asset]) return;
        
        if (!msg.history || !msg.history.prices) { 
            logError(`No history for ${asset}`); 
            return; 
        }
        
        const digits = msg.history.prices.map(p => getLastDigit(p, asset));
        this.assetBots[asset].tickHistory = digits.slice(-this.config.tick_history_size);
        logBot(`${green('✅ Loaded ' + this.assetBots[asset].tickHistory.length + ' historical ticks for ' + asset)}`);
        
        // Warm up regime detector
        logBot(`Warming up regime detector for ${asset}...`);
        const assetBot = this.assetBots[asset];
        for (let i = 1; i < assetBot.tickHistory.length; i++) {
            assetBot.detector.tick(assetBot.tickHistory[i - 1], assetBot.tickHistory[i]);
        }
        
        assetBot.prevDigit = assetBot.tickHistory[assetBot.tickHistory.length - 1];
        assetBot.botState = STATE.ANALYZING;
        
        // Subscribe to live ticks
        this.send({ ticks: asset, subscribe: 1 });
        
        // Check if all assets are ready
        const allReady = this.assets.every(a => 
            this.assetBots[a].tickHistory.length >= this.config.min_ticks_for_analysis
        );
        
        if (allReady) {
            logBot(green('✅ All assets ready for trading'));
        }
    }

    handleBalance(msg) {
        if (msg.balance) this.accountBalance = parseFloat(msg.balance.balance);
    }

    handleTick(msg) {
        if (!msg.tick) return;
        const asset = msg.tick.symbol;
        if (!this.assetBots[asset]) return;
        
        const price = msg.tick.quote;
        const curDigit = getLastDigit(price, asset);
        const assetBot = this.assetBots[asset];
        const prevDigit = assetBot.prevDigit;
        
        assetBot.tickHistory.push(curDigit);
        if (assetBot.tickHistory.length > this.config.tick_history_size)
            assetBot.tickHistory = assetBot.tickHistory.slice(-this.config.tick_history_size);
        
        // Update detectors incrementally
        if (prevDigit >= 0) {
            assetBot.detector.tick(prevDigit, curDigit);
        }
        assetBot.prevDigit = curDigit;
        
        const count = assetBot.tickHistory.length;
        
        // Log tick (limited to avoid spam)
        if (count % 10 === 0) {
            const last5 = assetBot.tickHistory.slice(Math.max(0, count - 6), count - 1);
            logTick(
                dim(`[${asset}] `) + dim(last5.join(' › ') + '  ›') + ` ${bold(cyan('[' + curDigit + ']'))}` +
                dim(`  ${price}  (${count}/${this.config.tick_history_size})`)
            );
        }
        
        // Process signal if not waiting for result
        if (assetBot.botState === STATE.ANALYZING && !assetBot.isTradeActive) {
            assetBot.regime = assetBot.detector.analyze(assetBot.tickHistory, curDigit);
            assetBot.targetDigit = curDigit;
            
            if (assetBot.regime && assetBot.regime.valid) {
                assetBot.targetRepeatRate = assetBot.regime.rawRepeatProb[curDigit];
                assetBot.signalActive = assetBot.regime.signalActive;
                
                if (assetBot.signalActive) {
                    this.processAssetSignal(asset, curDigit);
                }
            }
        }
        
        // Ghost trading logic
        if (assetBot.botState === STATE.GHOST_TRADING && !assetBot.isTradeActive) {
            this.runGhostCheck(asset, curDigit);
        }
    }

    processAssetSignal(asset, curDigit) {
        const assetBot = this.assetBots[asset];
        
        // Check concurrent trade limit
        const activeTradeCount = Array.from(this.activeTrades.values()).filter(t => !t.completed).length;
        if (activeTradeCount >= this.config.max_concurrent_trades) {
            return;
        }
        
        // Check if asset is suspended
        if (this.suspendedAssets.has(asset)) {
            return;
        }
        
        if (this.config.ghost_enabled && !assetBot.ghostConfirmed) {
            assetBot.botState = STATE.GHOST_TRADING;
            logGhost(`👻 [${asset}] Ghost phase started. Target: ${bold(cyan(assetBot.targetDigit))}`);
            this.runGhostCheck(asset, curDigit);
        } else {
            this.executeTradeFlow(asset, true);
        }
    }

    runGhostCheck(asset, curDigit) {
        const assetBot = this.assetBots[asset];
        if (assetBot.botState !== STATE.GHOST_TRADING) return;
        
        if (!assetBot.signalActive) {
            logGhost(dim(`⏳ [${asset}] Signal lost — re-analyzing...`));
            this.resetGhost(asset);
            assetBot.botState = STATE.ANALYZING;
            return;
        }
        
        assetBot.ghostRoundsPlayed++;
        
        if (assetBot.ghostAwaitingResult) {
            assetBot.ghostAwaitingResult = false;
            if (curDigit !== assetBot.targetDigit) {
                assetBot.ghostConsecutiveWins++;
                logGhost(`👻 [${asset}] ${green(`✅ Ghost WIN ${assetBot.ghostConsecutiveWins}/${this.config.ghost_wins_required}`)}`);
            } else {
                assetBot.ghostConsecutiveWins = 0;
                logGhost(`👻 [${asset}] ${red('❌ Ghost LOSS — digit REPEATED')} — reset`);
            }
        } else {
            if (curDigit === assetBot.targetDigit) {
                const wic = assetBot.ghostConsecutiveWins + 1;
                if (wic >= this.config.ghost_wins_required) {
                    assetBot.ghostConsecutiveWins = wic;
                    assetBot.ghostConfirmed = true;
                    logGhost(green(bold(`✅ [${asset}] Ghost confirmed! Live trade NOW`)));
                    this.executeTradeFlow(asset, true);
                } else {
                    assetBot.ghostAwaitingResult = true;
                    logGhost(`👻 [${asset}] Digit ${bold(cyan(assetBot.targetDigit))} appeared | Wins: ${assetBot.ghostConsecutiveWins}/${this.config.ghost_wins_required}`);
                }
            }
        }
        
        if (!assetBot.ghostConfirmed && assetBot.ghostRoundsPlayed >= this.config.ghost_max_rounds) {
            logGhost(yellow('⚠️  [${asset}] Max ghost rounds. Re-analyzing...'));
            this.resetGhost(asset);
            assetBot.botState = STATE.ANALYZING;
        }
    }

    resetGhost(asset) {
        const assetBot = this.assetBots[asset];
        assetBot.ghostConsecutiveWins = 0;
        assetBot.ghostRoundsPlayed = 0;
        assetBot.ghostConfirmed = false;
        assetBot.ghostAwaitingResult = false;
        assetBot.targetDigit = -1;
        assetBot.signalActive = false;
    }

    executeTradeFlow(asset, immediate) {
        const assetBot = this.assetBots[asset];
        
        if (assetBot.isTradeActive || assetBot.pendingTrade || this.botState === STATE.STOPPED) return;
        
        const risk = this.checkRiskLimits(asset);
        if (!risk.canTrade) {
            logRisk(`[${asset}] ${risk.reason}`);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(asset); return; }
            return;
        }
        
        assetBot.currentStake = this.calculateStake(asset);
        if (assetBot.currentStake > this.config.max_stake) { 
            logRisk(`[${asset}] Stake>max`); 
            return; 
        }
        if (assetBot.currentStake > this.accountBalance) { 
            this.stop('Insufficient balance'); 
            return; 
        }
        
        if (immediate) {
            this.placeTrade(asset);
        } else {
            assetBot.pendingTrade = true;
            assetBot.botState = STATE.GHOST_TRADING;
            logBot(`⚡ [${asset}] Recovery trade queued — waiting for digit ${bold(cyan(assetBot.targetDigit))}`);
        }
    }

    placeTrade(asset) {
        const assetBot = this.assetBots[asset];
        assetBot.isTradeActive = true;
        assetBot.botState = STATE.PLACING_TRADE;
        
        const stepInfo = this.config.martingale_enabled ? ` | Mart:${assetBot.martingaleStep}/${this.config.max_martingale_steps}` : '';
        const r = assetBot.regime;
        const score = r && r.valid ? r.safetyScore : 0;
        const pnr = r && r.valid ? (r.posteriorNR * 100).toFixed(1) + '%' : '?';
        
        logTrade(
            `🎯 [${asset}] DIFFER from ${bold(cyan(assetBot.targetDigit))} | ` +
            `Stake: ${bold('$' + assetBot.currentStake.toFixed(2))}${stepInfo} | ` +
            `Rate: ${assetBot.targetRepeatRate.toFixed(1)}% | Score: ${score}/100`
        );
        
        this.sendTelegram(`
            🎯 <b>TRADE</b>
            🔢 ${asset} | Digit: ${assetBot.targetDigit}
            📊 Last10: ${assetBot.tickHistory.slice(-10).join(',')}
            💰 Stake: $${assetBot.currentStake.toFixed(2)}${stepInfo}
            📊 ${this.totalTrades} trades | ${this.totalWins}W/${this.totalLosses}L | P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
        `.trim());
        
        this.send({
            buy: 1,
            price: assetBot.currentStake,
            parameters: {
                contract_type: this.config.contract_type,
                symbol: asset,
                duration: 1,
                duration_unit: 't',
                basis: 'stake',
                amount: assetBot.currentStake,
                barrier: String(assetBot.targetDigit),
                currency: this.config.currency,
            },
        });
        
        assetBot.botState = STATE.WAITING_RESULT;
        this.activeTrades.set(asset, { asset, startTime: Date.now(), completed: false });
    }

    handleBuy(msg) {
        if (!msg.buy) return;
        const asset = msg.echo_req?.parameters?.symbol;
        if (!asset || !this.assetBots[asset]) return;
        
        this.assetBots[asset].lastContractId = msg.buy.contract_id;
        logTrade(dim(`[${asset}] Contract ${msg.buy.contract_id} | Cost: $${parseFloat(msg.buy.buy_price).toFixed(2)}`));
    }

    handleTransaction(msg) {
        if (!msg.transaction || msg.transaction.action !== 'sell') return;
        
        // Find which asset this transaction belongs to
        let foundAsset = null;
        for (const [asset, tradeInfo] of this.activeTrades.entries()) {
            if (tradeInfo.contractId === msg.transaction.contract_id || 
                this.assetBots[asset].lastContractId === msg.transaction.contract_id) {
                foundAsset = asset;
                break;
            }
        }
        
        if (!foundAsset) return;
        
        const assetBot = this.assetBots[foundAsset];
        assetBot.botState = STATE.PROCESSING_RESULT;
        
        const payout = parseFloat(msg.transaction.amount) || 0;
        const profit = payout - (assetBot.lastBuyPrice || 0);
        this.totalTrades++;
        
        const resultDigit = assetBot.tickHistory.length > 0 ? assetBot.tickHistory[assetBot.tickHistory.length - 1] : null;
        const won = profit > 0;
        
        if (won) this.processWin(foundAsset, profit, resultDigit);
        else this.processLoss(foundAsset, assetBot.lastBuyPrice || 0, resultDigit);
        
        // Adaptive ensemble feedback
        assetBot.detector.applyTradeFeedback(won, assetBot.regime);
        
        assetBot.isTradeActive = false;
        this.activeTrades.set(foundAsset, { ...this.activeTrades.get(foundAsset), completed: true });
        
        this.decideNextAction(foundAsset);
    }

    processWin(asset, profit, resultDigit) {
        const assetBot = this.assetBots[asset];
        this.totalWins++;
        this.sessionProfit += profit;
        assetBot.currentWinStreak++;
        assetBot.currentLossStreak = 0;
        
        if (assetBot.currentWinStreak > this.maxWinStreak) this.maxWinStreak = assetBot.currentWinStreak;
        if (profit > this.largestWin) this.largestWin = profit;
        
        assetBot.detector.resetCUSUM(assetBot.targetDigit);
        
        logResult(`${green('✅ [${asset}] WIN!')} Profit: ${green('+$' + profit.toFixed(2))} | P/L: ${formatMoney(this.sessionProfit)}`);
        
        this.sendTelegram(`✅ <b>[${asset}] WIN!</b>
            🔢 Target:${assetBot.targetDigit} | Result:${resultDigit}
            📊 Last10: ${assetBot.tickHistory.slice(-10).join(',')}
            💰 +$${profit.toFixed(2)} | P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
            📊 ${this.totalWins}W/${this.totalLosses}L
            📈 Rate: ${assetBot.targetRepeatRate.toFixed(1)}% | Score: ${score}/100
        `);
        
        this.resetMartingale(asset);
        this.resetGhost(asset);
    }

    processLoss(asset, lostAmount, resultDigit) {
        const assetBot = this.assetBots[asset];
        this.totalLosses++;
        this.sessionProfit -= lostAmount;
        assetBot.totalMartingaleLoss += lostAmount;
        assetBot.currentLossStreak++;
        assetBot.currentWinStreak = 0;
        
        if (assetBot.currentLossStreak > this.maxLossStreak) this.maxLossStreak = assetBot.currentLossStreak;
        if (lostAmount > this.largestLoss) this.largestLoss = lostAmount;
        
        assetBot.martingaleStep++;
        
        logResult(`${red('❌ [${asset}] LOSS!')} Lost: ${red('-$' + lostAmount.toFixed(2))} | P/L: ${formatMoney(this.sessionProfit)}`);
        
        this.sendTelegram(`❌ <b>[${asset}] LOSS!</b>
            🔢 Target:${assetBot.targetDigit} | Result:${resultDigit}
            📊 Last10: ${assetBot.tickHistory.slice(-10).join(',')}
            💸 -$${lostAmount.toFixed(2)} | P&L: ${this.sessionProfit >= 0 ? '+' : ''}$${this.sessionProfit.toFixed(2)}
            📊 ${this.totalWins}W/${this.totalLosses}L
            📈 Rate: ${assetBot.targetRepeatRate.toFixed(1)}% | Score: ${score}/100
        `);
        
        assetBot.ghostConsecutiveWins = 0;
        assetBot.ghostConfirmed = false;
        assetBot.ghostRoundsPlayed = 0;
        assetBot.ghostAwaitingResult = false;
    }

    decideNextAction(asset) {
        const assetBot = this.assetBots[asset];
        const risk = this.checkRiskLimits(asset);
        
        if (!risk.canTrade) {
            logRisk(`[${asset}] ${risk.reason}`);
            if (risk.action === 'STOP') { this.stop(risk.reason); return; }
            if (risk.action === 'COOLDOWN') { this.startCooldown(asset); return; }
        }
        
        if (this.config.martingale_enabled && assetBot.martingaleStep > 0 && assetBot.martingaleStep < this.config.max_martingale_steps) {
            logBot(dim(`📈 [${asset}] Martingale recovery step ${assetBot.martingaleStep}/${this.config.max_martingale_steps}...`));
            assetBot.botState = this.config.ghost_enabled ? STATE.GHOST_TRADING : STATE.ANALYZING;
            if (!this.config.ghost_enabled) this.executeTradeFlow(asset, false);
            return;
        }
        
        if (this.config.martingale_enabled && assetBot.martingaleStep >= this.config.max_martingale_steps) {
            logRisk(`🛑 [${asset}] Max Martingale steps reached!`);
            this.resetMartingale(asset);
            this.startCooldown(asset);
            return;
        }
        
        assetBot.botState = STATE.ANALYZING;
    }

    calculateStake(asset) {
        const assetBot = this.assetBots[asset];
        if (!this.config.martingale_enabled || assetBot.martingaleStep === 0) return this.config.base_stake;
        const raw = this.config.base_stake * Math.pow(this.config.martingale_multiplier, assetBot.martingaleStep);
        const calc = Math.round(raw * 100) / 100;
        const final = Math.min(calc, this.config.max_stake);
        return final;
    }

    checkRiskLimits(asset) {
        if (this.sessionProfit >= this.config.take_profit) {
            this.sendTelegram(`🎉 <b>TAKE PROFIT!</b>\nP&L: $${this.sessionProfit.toFixed(2)}`);
            return { canTrade: false, reason: `🎯 Take profit! P/L:${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        if (this.sessionProfit <= -this.config.stop_loss) {
            this.sendTelegram(`🛑 <b>STOP LOSS!</b>\nP&L: $${this.sessionProfit.toFixed(2)}`);
            return { canTrade: false, reason: `🛑 Stop loss! P/L:${formatMoney(this.sessionProfit)}`, action: 'STOP' };
        }
        const assetBot = this.assetBots[asset];
        const ns = (!this.config.martingale_enabled || assetBot.martingaleStep === 0) 
            ? this.config.base_stake 
            : Math.min(Math.round(this.config.base_stake * Math.pow(this.config.martingale_multiplier, assetBot.martingaleStep) * 100) / 100, this.config.max_stake);
        if (ns > this.accountBalance) return { canTrade: false, reason: 'Next stake>balance', action: 'STOP' };
        if (ns > this.config.max_stake) return { canTrade: false, reason: 'Next stake>max', action: 'STOP' };
        if (this.config.martingale_enabled && assetBot.martingaleStep >= this.config.max_martingale_steps)
            return { canTrade: false, reason: 'Max Martingale steps reached.', action: 'COOLDOWN' };
        return { canTrade: true };
    }

    resetMartingale(asset) {
        const assetBot = this.assetBots[asset];
        assetBot.martingaleStep = 0;
        assetBot.totalMartingaleLoss = 0;
        assetBot.currentStake = this.config.base_stake;
    }

    startCooldown(asset) {
        const assetBot = this.assetBots[asset];
        assetBot.botState = STATE.COOLDOWN;
        this.resetMartingale(asset);
        this.resetGhost(asset);
        this.suspendedAssets.add(asset);
        logBot(`⏸️  [${asset}] Cooldown ${this.config.cooldown_after_max_loss / 1000}s...`);
        
        setTimeout(() => {
            if (assetBot.botState === STATE.COOLDOWN) {
                logBot(green(`▶️  [${asset}] Cooldown ended. Resuming...`));
                assetBot.botState = STATE.ANALYZING;
                this.suspendedAssets.delete(asset);
            }
        }, this.config.cooldown_after_max_loss);
    }

    stop(reason = 'User stopped') {
        this.botState = STATE.STOPPED;
        logBot(`🛑 ${bold('Stopping.')} Reason: ${reason}`);
        
        if (this.cooldownTimer) { clearTimeout(this.cooldownTimer); this.cooldownTimer = null; }
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        
        StatePersistence.saveState(this);
        
        this.assets.forEach(asset => {
            this.assetBots[asset].pendingTrade = false;
        });
        
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
                this.ws.send(JSON.stringify({ forget_all: 'balance' }));
                this.ws.send(JSON.stringify({ forget_all: 'transaction' }));
            } catch (_) { }
            setTimeout(() => { try { this.ws.close(); } catch (_) { } }, 500);
        }
        
        this.sendTelegram(`🛑 <b>STOPPED</b>\nReason: ${reason}\nP&L: $${this.sessionProfit.toFixed(2)}`);
        this.printFinalStats();
        setTimeout(() => process.exit(0), 1200);
    }

    printFinalStats() {
        const dur = Date.now() - this.sessionStartTime;
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const avg = this.totalTrades > 0 ? this.sessionProfit / this.totalTrades : 0;
        const plC = this.sessionProfit >= 0 ? green : red;
        
        console.log('');
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(bold(cyan('              SESSION SUMMARY                  ')));
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        logStats(`  Duration         : ${bold(formatDuration(dur))}`);
        logStats(`  Assets           : ${bold(this.assets.join(', '))}`);
        logStats(`  Total Trades     : ${bold(this.totalTrades)}`);
        logStats(`  Wins             : ${green(this.totalWins)}`);
        logStats(`  Losses           : ${red(this.totalLosses)}`);
        logStats(`  Win Rate         : ${bold(wr + '%')}`);
        logStats(`  Session P/L      : ${plC(bold(formatMoney(this.sessionProfit)))}`);
        logStats(`  Starting Balance : $${this.startingBalance.toFixed(2)}`);
        logStats(`  Final Balance    : $${this.accountBalance.toFixed(2)}`);
        logStats(bold(cyan('═══════════════════════════════════════════════')));
        console.log('');
    }
}

// ── Entry Point ──────────────────────────────────────────────────────────────
(function main() {
    const config = parseArgs();
    const bot = new MultiAssetRomanianGhostBot(config);
    
    process.on('SIGINT', () => { console.log(''); bot.stop('SIGINT'); });
    process.on('SIGTERM', () => bot.stop('SIGTERM'));
    process.on('uncaughtException', e => { 
        logError(`Uncaught: ${e.message}`); 
        if (e.stack) logError(e.stack); 
        bot.stop('Uncaught exception'); 
    });
    process.on('unhandledRejection', r => logError(`Rejection: ${r}`));
    
    bot.start();
})();