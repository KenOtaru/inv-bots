#!/usr/bin/env node
'use strict';

/**
 * Deriv Multi-Asset Bot (single file)
 * ------------------------------------------------------------
 * Educational template implementing:
 * - Multi-asset universe
 * - Dynamic top-2 selection (portfolio manager) every 5 minutes
 * - Allocation rebalance every 4 hours (60/40 split)
 * - Per-asset EMA/RSI entry rules with AI confidence filter
 * - Portfolio + per-asset risk rules and correlation blocks
 * - Single WebSocket multiplexing with max 5 candle subscriptions
 * - Worker threads: one per asset for indicator calculation
 *
 * Install (core):
 *   npm i ws mathjs kmeans-js
 * Optional AI models (requires native bindings; easiest on Node 18/20 LTS):
 *   npm i @tensorflow/tfjs-node
 *
 * Run (live):
 *   DERIV_APP_ID=xxxx DERIV_TOKEN=xxxx CAPITAL=500 node deriv-multi-asset-bot.js
 * Run (paper mode):
 *   DERIV_APP_ID=xxxx CAPITAL=500 node deriv-multi-asset-bot.js --paper
 */

const WebSocket = require('ws');
const math = require('mathjs');
const KMeansJs = require('kmeans-js');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Optional dependency: TensorFlow. On Windows, @tensorflow/tfjs-node often fails on Node 22+
// because prebuilt binaries may not exist (requires compiling native bindings).
let tf = null;
try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    tf = require('@tensorflow/tfjs-node');
} catch (e) {
    tf = null;
}

// --------------------------- Worker code ---------------------------
if (!isMainThread) {
    const cfg = workerData?.config || {};

    function ema(values, period) {
        if (!values || values.length === 0) return 0;
        const k = 2 / (period + 1);
        let e = values[0];
        for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
        return e;
    }

    function rsi(values, period) {
        if (!values || values.length < period + 1) return 50;
        let gains = 0;
        let losses = 0;
        for (let i = values.length - period; i < values.length; i++) {
            const diff = values[i] - values[i - 1];
            if (diff >= 0) gains += diff;
            else losses += -diff;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - 100 / (1 + rs);
    }

    function safeStd(arr) {
        if (!arr || arr.length < 2) return 0;
        try {
            return Number(math.std(arr));
        } catch {
            const m = arr.reduce((a, b) => a + b, 0) / arr.length;
            const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
            return Math.sqrt(v);
        }
    }

    function safeMean(arr) {
        if (!arr || arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    function clamp01(x) {
        return Math.max(0, Math.min(1, x));
    }

    // ADX-equivalent proxy: directional drift vs volatility, mapped to [0,1]
    function trendStrengthFromReturns(returns) {
        if (!returns || returns.length < 10) return 0.3;
        const mu = safeMean(returns);
        const vol = safeStd(returns);
        if (vol === 0) return 0.3;
        const z = Math.abs(mu) / vol; // signal-to-noise
        // squash to 0..1
        const s = 1 - Math.exp(-z);
        return clamp01(s);
    }

    // Predictability proxy: lag-1 autocorrelation magnitude, mapped to [0,1]
    function predictabilityFromReturns(returns) {
        if (!returns || returns.length < 30) return 0.4;
        const x = returns.slice(0, returns.length - 1);
        const y = returns.slice(1);
        const mx = safeMean(x);
        const my = safeMean(y);
        let num = 0;
        let dx = 0;
        let dy = 0;
        for (let i = 0; i < x.length; i++) {
            const vx = x[i] - mx;
            const vy = y[i] - my;
            num += vx * vy;
            dx += vx * vx;
            dy += vy * vy;
        }
        const denom = Math.sqrt(dx * dy) || 1;
        const r = num / denom;
        return clamp01(Math.abs(r));
    }

    parentPort.on('message', (msg) => {
        if (!msg || msg.type !== 'calc') return;

        const candles = msg.candles || [];
        const closes = candles.map(c => Number(c.close)).filter(n => Number.isFinite(n));

        const emaS = ema(closes, cfg.emaShort || 10);
        const emaL = ema(closes, cfg.emaLong || 25);
        const r = rsi(closes, cfg.rsiPeriod || 14);

        const rets = [];
        for (let i = 1; i < closes.length; i++) {
            const prev = closes[i - 1];
            const cur = closes[i];
            if (prev !== 0) rets.push((cur - prev) / prev);
        }

        const vol = safeStd(rets);
        const trendStrength = trendStrengthFromReturns(rets);
        const predictability = predictabilityFromReturns(rets);

        // Additional feature: normalized EMA divergence
        const emaDiff = emaL === 0 ? 0 : (emaS - emaL) / Math.abs(emaL);

        parentPort.postMessage({
            type: 'indicators',
            symbolId: workerData.symbolId,
            ts: Date.now(),
            emaShort: emaS,
            emaLong: emaL,
            rsi: r,
            volatility: vol,
            trendStrength,
            predictability,
            emaDiff,
            candleEpoch: candles.length ? Number(candles[candles.length - 1].epoch) : null,
        });
    });

    // keep worker alive
    setInterval(() => { }, 1 << 30);
    return;
}

// --------------------------- Main code ---------------------------
const APP_ID = String(process.env.DERIV_APP_ID || process.env.APP_ID || '1089');
const TOKEN = '0P94g4WdSrSrzir';//process.env.DERIV_TOKEN || process.env.TOKEN || 
const PAPER = false; //process.argv.includes('--paper') || !TOKEN;
const ENDPOINT = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`;

const CONFIG = {
    scoringEveryMs: 5 * 60 * 1000,
    rebalanceEveryMs: 4 * 60 * 60 * 1000,
    candleHistory: 220,
    maxSubscribedAssets: 5,
    maxOpenPositions: 5,

    // Portfolio limits
    totalRiskPerCycle: 0.02, // 2% capital
    maxRiskPerTrade: 0.02,   // 2% capital
    dailyLossLimit: 0.05,    // 5%
    dailyProfitTarget: 0.025, // 2.5%

    // Kelly assumptions for binary payout ratio
    assumedPayoutB: Number(process.env.PAYOUT_B || 0.95),

    minStake: Number(process.env.MIN_STAKE || 0.35),

    // Deriv candle granularity per asset category (seconds)
    granularity: {
        SYNTH: 60,
        BOOMCRASH: 60,
        FX: 900, // 15m
        CMDTY: 300, // 5m
    },
};

// Asset universe
// Keys are internal IDs; apiSymbol is what is sent to Deriv.
const ASSETS = {
    R_10: {
        apiSymbol: 'R_10', category: 'SYNTH',
        emaShort: 8, emaLong: 21, rsiPeriod: 14,
        duration: 15, durationUnit: 'm',
        maxTradesPerDay: 2,
        rsiThreshold: 45,
        spreadCost: 0.85,
        volPreference: 'LOW',
        correlationGroup: 'SYNTH_VOL',
    },
    R_25: {
        apiSymbol: 'R_25', category: 'SYNTH',
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 20, durationUnit: 'm',
        maxTradesPerDay: 2,
        rsiThreshold: 45,
        spreadCost: 0.82,
        volPreference: 'MID',
        correlationGroup: 'SYNTH_VOL',
    },
    R_75: {
        apiSymbol: 'R_75', category: 'SYNTH',
        emaShort: 12, emaLong: 30, rsiPeriod: 21,
        duration: 30, durationUnit: 'm',
        maxTradesPerDay: 1,
        rsiThreshold: 40,
        spreadCost: 0.78,
        volPreference: 'HIGH',
        correlationGroup: 'SYNTH_VOL',
    },
    BOOM1000: {
        apiSymbol: 'BOOM1000', category: 'BOOMCRASH',
        emaShort: 5, emaLong: 15, rsiPeriod: 7,
        duration: 5, durationUnit: 'm',
        maxTradesPerDay: 3,
        rsiThreshold: 50,
        spreadCost: 0.75,
        volPreference: 'HIGH',
        correlationGroup: 'BOOMCRASH',
    },
    CRASH1000: {
        apiSymbol: 'CRASH1000', category: 'BOOMCRASH',
        emaShort: 5, emaLong: 15, rsiPeriod: 7,
        duration: 5, durationUnit: 'm',
        maxTradesPerDay: 3,
        rsiThreshold: 50,
        spreadCost: 0.75,
        volPreference: 'HIGH',
        correlationGroup: 'BOOMCRASH',
    },
    FRXEURUSD: {
        apiSymbol: 'frxEURUSD', category: 'FX',
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 4, durationUnit: 'h',
        maxTradesPerDay: 1,
        rsiThreshold: 46,
        spreadCost: 0.65,
        volPreference: 'MID',
        correlationGroup: 'FX_EU_GB',
    },
    FRXGBPUSD: {
        apiSymbol: 'frxGBPUSD', category: 'FX',
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 4, durationUnit: 'h',
        maxTradesPerDay: 1,
        rsiThreshold: 46,
        spreadCost: 0.62,
        volPreference: 'MID',
        correlationGroup: 'FX_EU_GB',
    },
    FRXUSDJPY: {
        apiSymbol: 'frxUSDJPY', category: 'FX',
        emaShort: 10, emaLong: 25, rsiPeriod: 14,
        duration: 4, durationUnit: 'h',
        maxTradesPerDay: 1,
        rsiThreshold: 46,
        spreadCost: 0.60,
        volPreference: 'MID',
        correlationGroup: 'FX_USD',
    },
    // WTI: {
    //     apiSymbol: 'frxWTIUSD', category: 'CMDTY',
    //     emaShort: 15, emaLong: 35, rsiPeriod: 14,
    //     duration: 1, durationUnit: 'h',
    //     maxTradesPerDay: 2,
    //     rsiThreshold: 45,
    //     spreadCost: 0.58,
    //     volPreference: 'MID',
    //     correlationGroup: 'CMDTY',
    // },
    XAUUSD: {
        apiSymbol: 'frxXAUUSD', category: 'CMDTY',
        emaShort: 15, emaLong: 35, rsiPeriod: 14,
        duration: 1, durationUnit: 'h',
        maxTradesPerDay: 2,
        rsiThreshold: 45,
        spreadCost: 0.56,
        volPreference: 'MID',
        correlationGroup: 'CMDTY',
    },
};

// Requested state shape (extended)
const state = {
    capital: Number(process.env.CAPITAL || 500),
    assets: {},
    portfolio: {
        dailyPnL: 0,
        activePositions: [],
        tradingHalted: false,
        lockedProfit: 0,
        lastRebalanceAt: 0,
        allocationWeights: {},
    },
    selection: {
        top2: [],
        scores: {},
        lastScoredAt: 0,
    },
    runtime: {
        wsReady: false,
        authorized: false,
        reqId: 0,
        pending: new Map(),
        candleSubscriptions: new Map(), // symbolId -> subscriptionId
        contractSubscriptions: new Map(), // contract_id -> subscriptionId
        workers: {},
        models: {},
        lastCandleEpochBySymbol: {},
    },
};

function now() { return Date.now(); }
function fmt(n, d = 2) { return Number(n).toFixed(d); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

function ensureAssetState(symbolId) {
    if (state.assets[symbolId]) return state.assets[symbolId];
    state.assets[symbolId] = {
        candles: [],
        emaShort: 0,
        emaLong: 0,
        rsi: 50,
        volatility: 0,
        trendStrength: 0,
        predictability: 0,
        emaDiff: 0,

        dailyTrades: 0,
        tradesByDirection: { CALL: 0, PUT: 0 },
        wins: 0,
        losses: 0,
        recentResults: [], // last 20
        winRate: 0.55,

        consecutiveLosses: 0,
        cooldownUntil: 0,
        blacklistUntil: 0,

        prevEmaDiff: null,
        lastSignalAt: 0,
    };
    return state.assets[symbolId];
}

// --------------------------- AI Models (optional) ---------------------------
async function loadModelsIfPresent() {
    // If tfjs-node isn't installed, we can still run the bot using heuristicConfidence.
    if (!tf) {
        for (const symbolId of Object.keys(ASSETS)) state.runtime.models[symbolId] = null;
        log('[AI] @tensorflow/tfjs-node not installed. Using heuristic confidence filter only.');
        return;
    }

    for (const symbolId of Object.keys(ASSETS)) {
        const modelDir = path.join(process.cwd(), 'models', symbolId);
        const modelPath = path.join(modelDir, 'model.json');
        if (!fs.existsSync(modelPath)) {
            state.runtime.models[symbolId] = null;
            continue;
        }
        try {
            const m = await tf.loadLayersModel('file://' + modelPath);
            state.runtime.models[symbolId] = m;
            log(`[AI] Loaded model for ${symbolId} from ${modelPath}`);
        } catch (e) {
            state.runtime.models[symbolId] = null;
            log(`[AI] Failed to load model for ${symbolId}: ${e.message}`);
        }
    }
}

function heuristicConfidence(symbolId, direction) {
    const a = ensureAssetState(symbolId);
    // A simple, conservative confidence proxy based on alignment + RSI location
    const trend = a.trendStrength; // 0..1
    const pred = a.predictability; // 0..1
    const rsiNorm = clamp(a.rsi / 100, 0, 1);

    const emaAligned = direction === 'CALL' ? (a.emaDiff > 0 ? 1 : 0) : (a.emaDiff < 0 ? 1 : 0);
    const rsiEdge = direction === 'CALL' ? (1 - rsiNorm) : rsiNorm;

    const score01 = clamp(0.15 + 0.35 * trend + 0.20 * pred + 0.20 * emaAligned + 0.10 * rsiEdge, 0, 1);
    return score01;
}

async function aiConfidence(symbolId, direction) {
    const model = state.runtime.models[symbolId];
    const a = ensureAssetState(symbolId);

    // If tf isn't available or we have no model, fall back.
    if (!tf || !model) return heuristicConfidence(symbolId, direction);

    try {
        const features = tf.tensor2d([[
            clamp(a.trendStrength, 0, 1),
            clamp(a.predictability, 0, 1),
            clamp(a.volatility * 100, 0, 2),
            clamp(a.rsi / 100, 0, 1),
            clamp(a.emaDiff, -0.05, 0.05),
            direction === 'CALL' ? 1 : 0,
        ]]);
        const out = model.predict(features);
        const val = (await out.data())[0];
        tf.dispose([features, out]);
        return clamp(val, 0, 1);
    } catch (e) {
        log(`[AI] Predict error for ${symbolId}: ${e.message}`);
        return heuristicConfidence(symbolId, direction);
    }
}

// --------------------------- Portfolio scoring ---------------------------
function scoreFormula({ recentWinRate, trendStrength, volatilityFit, predictability }) {
    return (recentWinRate * 0.30) + (trendStrength * 0.25) + (volatilityFit * 0.20) + (predictability * 0.25);
}

function desiredVolLabel(symbolId) {
    const pref = ASSETS[symbolId].volPreference;
    if (pref === 'LOW') return 0;
    if (pref === 'MID') return 1;
    return 2;
}

function localKmeans1D(values, k = 3, iters = 20) {
    // Very small fallback k-means for 1D values.
    const xs = values.slice();
    xs.sort((a, b) => a - b);
    const centroids = [];
    for (let i = 0; i < k; i++) {
        const idx = Math.floor((i + 0.5) * xs.length / k);
        centroids.push(xs[Math.min(xs.length - 1, Math.max(0, idx))]);
    }

    let assign = new Array(values.length).fill(0);
    for (let t = 0; t < iters; t++) {
        // assign
        for (let i = 0; i < values.length; i++) {
            let best = 0;
            let bestD = Infinity;
            for (let c = 0; c < k; c++) {
                const d = Math.abs(values[i] - centroids[c]);
                if (d < bestD) { bestD = d; best = c; }
            }
            assign[i] = best;
        }
        // update
        for (let c = 0; c < k; c++) {
            const pts = values.filter((_, i) => assign[i] === c);
            if (pts.length) centroids[c] = pts.reduce((a, b) => a + b, 0) / pts.length;
        }
    }

    // order labels by centroid ascending -> [LOW, MID, HIGH]
    const order = centroids.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const relabel = new Map(order.map((o, idx) => [o.i, idx]));
    return assign.map(a => relabel.get(a));
}

function clusterVolatilityRegimes(symbolIds) {
    const vols = symbolIds.map(id => ensureAssetState(id).volatility || 0);

    // If not enough data, default everyone to MID
    const finite = vols.filter(v => Number.isFinite(v));
    if (finite.length < 4) return symbolIds.reduce((acc, id) => (acc[id] = 1, acc), {});

    let labels = null;

    // Try kmeans-js (best effort) but fall back to local kmeans.
    try {
        // kmeans-js API varies; this is a best-effort attempt.
        // If it fails, we fall back.
        if (typeof KMeansJs === 'function') {
            const km = new KMeansJs({ K: 3, runs: 1 });
            km.cluster(vols.map(v => [v]));
            // Attempt common field names
            const idx = km.idx || km.indexes || km.labels;
            if (idx && idx.length === vols.length) {
                // Convert to relative ordering by centroid (if available)
                const cents = (km.centroids || km.means || []).map(c => Array.isArray(c) ? c[0] : c);
                if (cents.length === 3) {
                    const order = cents.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
                    const relabel = new Map(order.map((o, j) => [o.i, j]));
                    labels = idx.map(i => relabel.get(i));
                } else {
                    labels = idx;
                }
            }
        }
    } catch {
        labels = null;
    }

    if (!labels) labels = localKmeans1D(vols, 3, 25);

    const out = {};
    for (let i = 0; i < symbolIds.length; i++) out[symbolIds[i]] = labels[i];
    return out;
}

function volatilityFitScore(symbolId, regimeLabel) {
    // Fit is 1 when regime matches preference; 0.6 when adjacent; 0.2 when far.
    const desired = desiredVolLabel(symbolId);
    const dist = Math.abs(regimeLabel - desired);
    if (dist === 0) return 1.0;
    if (dist === 1) return 0.6;
    return 0.2;
}

function computeAssetScores() {
    const ids = Object.keys(ASSETS);
    const regimes = clusterVolatilityRegimes(ids);

    const scores = {};
    for (const id of ids) {
        const a = ensureAssetState(id);
        const cfg = ASSETS[id];

        const recentWinRate = clamp(a.winRate || 0.5, 0, 1);
        const trendStrength = clamp(a.trendStrength || 0, 0, 1);
        const predictability = clamp(a.predictability || 0, 0, 1);
        const volatilityFit = volatilityFitScore(id, regimes[id] ?? 1);

        // Incorporate spread cost efficiency as a mild multiplier
        const spreadEff = clamp(cfg.spreadCost ?? 0.75, 0.3, 1.0);

        const s01 = scoreFormula({ recentWinRate, trendStrength, volatilityFit, predictability });
        const sAdj = s01 * (0.85 + 0.15 * spreadEff);
        scores[id] = clamp(sAdj, 0, 1);
    }
    return scores;
}

function isBlacklisted(symbolId) {
    const a = ensureAssetState(symbolId);
    return now() < (a.blacklistUntil || 0);
}

function isInCooldown(symbolId) {
    const a = ensureAssetState(symbolId);
    return now() < (a.cooldownUntil || 0);
}

function selectTop2(scores) {
    const ids = Object.keys(ASSETS)
        .filter(id => !isBlacklisted(id))
        .filter(id => !isInCooldown(id));

    ids.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
    return ids.slice(0, 2);
}

function rebalanceAllocation(top2) {
    const weights = {};
    if (top2.length > 0) weights[top2[0]] = 0.6;
    if (top2.length > 1) weights[top2[1]] = 0.4;
    state.portfolio.allocationWeights = weights;
    state.portfolio.lastRebalanceAt = now();
    log(`[PM] Rebalanced weights: ${JSON.stringify(weights)}`);
}

function kellyFraction(p, b = CONFIG.assumedPayoutB) {
    // Kelly for binary-like outcome with net odds b (profit on win = b*stake, loss = 1*stake)
    // f* = (bp - q) / b
    const q = 1 - p;
    const f = (b * p - q) / b;
    return clamp(f, 0, 1);
}

function calcStake(symbolId, rankIndex) {
    const weights = state.portfolio.allocationWeights;
    const w = weights[symbolId] ?? (rankIndex === 0 ? 0.6 : 0.4);

    const a = ensureAssetState(symbolId);
    const p = clamp(a.winRate || 0.5, 0, 1);
    const fKelly = kellyFraction(p);

    const cycleRisk = state.capital * CONFIG.totalRiskPerCycle;
    const raw = cycleRisk * w * fKelly;

    const capped = Math.min(raw, state.capital * CONFIG.maxRiskPerTrade);
    return clamp(capped, CONFIG.minStake, Math.max(CONFIG.minStake, state.capital * CONFIG.maxRiskPerTrade));
}

// --------------------------- Risk rules ---------------------------
function dailyGuard() {
    const pnl = state.portfolio.dailyPnL;
    const lossLimit = -CONFIG.dailyLossLimit * state.capital;
    const profitTarget = CONFIG.dailyProfitTarget * state.capital;

    if (pnl <= lossLimit) {
        state.portfolio.tradingHalted = true;
        return { ok: false, reason: `Daily loss limit hit (${fmt(pnl)} <= ${fmt(lossLimit)})` };
    }

    if (pnl >= profitTarget) {
        state.portfolio.tradingHalted = true;
        state.portfolio.lockedProfit = Math.max(state.portfolio.lockedProfit, pnl * 0.5);
        return { ok: false, reason: `Daily profit target hit (${fmt(pnl)} >= ${fmt(profitTarget)}). Locking 50% gains: ${fmt(state.portfolio.lockedProfit)}` };
    }

    return { ok: true };
}

function correlationBlocked(symbolId) {
    const active = state.portfolio.activePositions;

    // EURUSD and GBPUSD cannot both have active trades
    const fxEU = ['FRXEURUSD', 'FRXGBPUSD'];
    if (fxEU.includes(symbolId)) {
        const other = fxEU.find(x => x !== symbolId);
        if (active.some(p => p.symbolId === other)) return { blocked: true, reason: `${symbolId} blocked by FX correlation rule with ${other}` };
    }

    // Synthetic index correlation: if another SYNTH_VOL is active, allow only the higher-ranked asset.
    // Implementation: if you already have an open SYNTH_VOL position in another symbol, block opening a second.
    const myGroup = ASSETS[symbolId].correlationGroup;
    if (myGroup === 'SYNTH_VOL') {
        const hasOtherSynth = active.some(p => p.symbolId !== symbolId && ASSETS[p.symbolId]?.correlationGroup === 'SYNTH_VOL');
        if (hasOtherSynth) return { blocked: true, reason: `${symbolId} blocked (SYNTH_VOL correlation): another synthetic vol position already active` };
    }

    return { blocked: false };
}

function canTrade(symbolId, direction) {
    if (state.portfolio.tradingHalted) return { ok: false, reason: 'Trading halted by portfolio guard' };

    const g = dailyGuard();
    if (!g.ok) return { ok: false, reason: g.reason };

    if (state.portfolio.activePositions.length >= CONFIG.maxOpenPositions) {
        return { ok: false, reason: `Max open positions reached (${CONFIG.maxOpenPositions})` };
    }

    const a = ensureAssetState(symbolId);
    const cfg = ASSETS[symbolId];

    if (now() < (a.cooldownUntil || 0)) return { ok: false, reason: `Cooldown active until ${new Date(a.cooldownUntil).toISOString()}` };
    if (now() < (a.blacklistUntil || 0)) return { ok: false, reason: `Blacklisted until ${new Date(a.blacklistUntil).toISOString()}` };

    if (a.dailyTrades >= cfg.maxTradesPerDay) return { ok: false, reason: `Max trades/day for ${symbolId} reached (${cfg.maxTradesPerDay})` };
    if ((a.tradesByDirection[direction] || 0) >= 3) return { ok: false, reason: `Max trades per direction/day reached for ${symbolId} ${direction}` };

    const corr = correlationBlocked(symbolId);
    if (corr.blocked) return { ok: false, reason: corr.reason };

    return { ok: true };
}

function updateWinRate(symbolId) {
    const a = ensureAssetState(symbolId);
    const n = a.recentResults.length;
    if (n === 0) { a.winRate = 0.55; return; }
    const wins = a.recentResults.reduce((s, x) => s + x, 0);
    a.winRate = wins / n;

    if (n >= 20 && a.winRate < 0.5) {
        a.blacklistUntil = now() + 48 * 60 * 60 * 1000;
        log(`[RISK] ${symbolId} winRate ${fmt(a.winRate, 3)} < 0.50 over ${n} trades. Blacklisting 48h.`);
    }
}

// --------------------------- Deriv WS plumbing ---------------------------
let ws;

function send(req) {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WS not open');
    const req_id = ++state.runtime.reqId;
    req.req_id = req_id;
    return new Promise((resolve, reject) => {
        state.runtime.pending.set(req_id, { resolve, reject, at: now(), req });
        ws.send(JSON.stringify(req));
    });
}

function forget(subscriptionId) {
    if (!subscriptionId) return;
    try { ws.send(JSON.stringify({ forget: subscriptionId })); } catch { /* noop */ }
}

function symbolIdFromApiSymbol(apiSymbol) {
    return Object.keys(ASSETS).find(id => ASSETS[id].apiSymbol === apiSymbol) || null;
}

function assetGranularity(symbolId) {
    const cat = ASSETS[symbolId].category;
    return CONFIG.granularity[cat] || 60;
}

async function fetchCandlesSnapshot(symbolId) {
    const apiSymbol = ASSETS[symbolId].apiSymbol;
    const granularity = assetGranularity(symbolId);
    try {
        const res = await send({
            ticks_history: apiSymbol,
            adjust_start_time: 1,
            style: 'candles',
            granularity,
            count: CONFIG.candleHistory,
            end: 'latest',
        });
        const candles = res.candles || [];
        if (candles.length) {
            mergeCandles(symbolId, candles);
            postToWorker(symbolId);
        }
    } catch (e) {
        log(`[DATA] Snapshot failed for ${symbolId}: ${e.message}`);
    }
}

async function subscribeCandles(symbolId) {
    if (state.runtime.candleSubscriptions.has(symbolId)) return;
    const apiSymbol = ASSETS[symbolId].apiSymbol;
    const granularity = assetGranularity(symbolId);

    const res = await send({
        ticks_history: apiSymbol,
        adjust_start_time: 1,
        style: 'candles',
        granularity,
        count: CONFIG.candleHistory,
        end: 'latest',
        subscribe: 1,
    });

    const subId = res.subscription?.id;
    if (subId) state.runtime.candleSubscriptions.set(symbolId, subId);

    const candles = res.candles || [];
    if (candles.length) {
        mergeCandles(symbolId, candles);
        postToWorker(symbolId);
    }

    log(`[SUB] Subscribed candles: ${symbolId} (${apiSymbol}) g=${granularity}s sub=${subId || 'n/a'}`);
}

async function unsubscribeCandles(symbolId) {
    const subId = state.runtime.candleSubscriptions.get(symbolId);
    if (!subId) return;
    forget(subId);
    state.runtime.candleSubscriptions.delete(symbolId);
    log(`[SUB] Unsubscribed candles: ${symbolId}`);
}

async function updateCandleSubscriptions(desiredSymbolIds) {
    // Keep within maxSubscribedAssets
    const desired = desiredSymbolIds.slice(0, CONFIG.maxSubscribedAssets);

    // Unsubscribe those not desired
    for (const [symbolId] of Array.from(state.runtime.candleSubscriptions.entries())) {
        if (!desired.includes(symbolId)) await unsubscribeCandles(symbolId);
    }

    // Subscribe missing
    for (const symbolId of desired) {
        if (!state.runtime.candleSubscriptions.has(symbolId)) {
            try { await subscribeCandles(symbolId); }
            catch (e) { log(`[SUB] Subscribe error ${symbolId}: ${e.message}`); }
        }
    }
}

function mergeCandles(symbolId, newCandles) {
    const a = ensureAssetState(symbolId);
    const map = new Map(a.candles.map(c => [Number(c.epoch), c]));
    for (const c of newCandles) map.set(Number(c.epoch), c);
    const merged = Array.from(map.values()).sort((x, y) => Number(x.epoch) - Number(y.epoch));
    a.candles = merged.slice(-CONFIG.candleHistory);
}

function postToWorker(symbolId) {
    const a = ensureAssetState(symbolId);
    const w = state.runtime.workers[symbolId];
    if (!w) return;
    w.postMessage({ type: 'calc', candles: a.candles });
}

function startWorkers() {
    for (const symbolId of Object.keys(ASSETS)) {
        ensureAssetState(symbolId);
        const w = new Worker(__filename, { workerData: { symbolId, config: ASSETS[symbolId] } });
        w.on('message', onWorkerMessage);
        w.on('error', (e) => log(`[WORKER] ${symbolId} error: ${e.message}`));
        w.on('exit', (code) => log(`[WORKER] ${symbolId} exit code=${code}`));
        state.runtime.workers[symbolId] = w;
    }
}

function onWorkerMessage(msg) {
    if (!msg || msg.type !== 'indicators') return;
    const symbolId = msg.symbolId;
    const a = ensureAssetState(symbolId);

    a.emaShort = msg.emaShort;
    a.emaLong = msg.emaLong;
    a.rsi = msg.rsi;
    a.volatility = msg.volatility;
    a.trendStrength = msg.trendStrength;
    a.predictability = msg.predictability;
    a.emaDiff = msg.emaDiff;

    // Only evaluate signals on new candle epoch
    if (msg.candleEpoch != null) {
        const last = state.runtime.lastCandleEpochBySymbol[symbolId];
        if (last === msg.candleEpoch) return;
        state.runtime.lastCandleEpochBySymbol[symbolId] = msg.candleEpoch;
    }

    maybeEvaluateAndTrade(symbolId).catch(e => log(`[TRADE] Evaluate error ${symbolId}: ${e.message}`));
}

// --------------------------- Strategy rules ---------------------------
function computeSignal(symbolId) {
    const a = ensureAssetState(symbolId);
    const cfg = ASSETS[symbolId];

    const diff = a.emaShort - a.emaLong;
    const prev = a.prevEmaDiff;
    a.prevEmaDiff = diff;

    if (prev == null) return null;

    const crossUp = prev <= 0 && diff > 0;
    const crossDown = prev >= 0 && diff < 0;

    // Entry rules
    if (crossUp && a.rsi < cfg.rsiThreshold) return 'CALL';
    if (crossDown && a.rsi > (100 - cfg.rsiThreshold)) return 'PUT';
    return null;
}

function isTop2(symbolId) {
    return state.selection.top2.includes(symbolId);
}

async function maybeEvaluateAndTrade(symbolId) {
    if (!isTop2(symbolId)) return; // new signals only on top-2
    if (PAPER === false && state.runtime.authorized === false) return;

    const direction = computeSignal(symbolId);
    if (!direction) return;

    const a = ensureAssetState(symbolId);
    const cfg = ASSETS[symbolId];

    // Prevent too-frequent signals on same candle stream
    if (now() - (a.lastSignalAt || 0) < 5 * 1000) return;
    a.lastSignalAt = now();

    const can = canTrade(symbolId, direction);
    if (!can.ok) {
        log(`[SKIP] ${symbolId} ${direction} — ${can.reason}`);
        return;
    }

    const conf = await aiConfidence(symbolId, direction);
    if (conf < 0.60) {
        log(`[AI] Filtered ${symbolId} ${direction} conf=${fmt(conf * 100, 1)}% (<60%)`);
        return;
    }

    const rankIndex = state.selection.top2[0] === symbolId ? 0 : 1;
    const stake = calcStake(symbolId, rankIndex);

    log(`[SIGNAL] ${symbolId} ${direction} | conf=${fmt(conf * 100, 1)}% | stake=${fmt(stake)} | RSI=${fmt(a.rsi, 1)} | trend=${fmt(a.trendStrength, 3)} vol=${fmt(a.volatility, 5)}`);

    if (PAPER) {
        log(`[PAPER] Not placing live trade. Use DERIV_TOKEN and remove --paper for live.`);
        return;
    }

    await proposeAndBuy(symbolId, direction, stake, cfg.duration, cfg.durationUnit);
}

// --------------------------- Trading (proposal/buy) ---------------------------
async function proposeAndBuy(symbolId, direction, stake, duration, durationUnit) {
    const apiSymbol = ASSETS[symbolId].apiSymbol;

    const proposalReq = {
        proposal: 1,
        amount: Number(stake),
        basis: 'stake',
        contract_type: direction, // CALL / PUT
        currency: 'USD',
        duration: Number(duration),
        duration_unit: durationUnit,
        symbol: apiSymbol,
    };

    const prop = await send(proposalReq);
    if (prop.error) throw new Error(prop.error.message);
    const proposalId = prop.proposal?.id;
    if (!proposalId) throw new Error('No proposal.id');

    const buy = await send({ buy: proposalId, price: Number(stake) });
    if (buy.error) throw new Error(buy.error.message);

    const contractId = buy.buy?.contract_id;
    const buyPrice = buy.buy?.buy_price;

    if (!contractId) throw new Error('No contract_id after buy');

    // Track position
    state.portfolio.activePositions.push({
        symbolId,
        apiSymbol,
        direction,
        contractId,
        stake: Number(stake),
        buyPrice: Number(buyPrice || stake),
        openedAt: now(),
    });

    const a = ensureAssetState(symbolId);
    a.dailyTrades += 1;
    a.tradesByDirection[direction] = (a.tradesByDirection[direction] || 0) + 1;

    log(`[BUY] ${symbolId} ${direction} stake=${fmt(stake)} contractId=${contractId}`);

    // Subscribe to contract updates
    const oc = await send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    const subId = oc.subscription?.id;
    if (subId) state.runtime.contractSubscriptions.set(String(contractId), subId);

    // Immediately process first open_contract payload
    if (oc.proposal_open_contract) onOpenContract(oc.proposal_open_contract);
}

function onOpenContract(poc) {
    const contractId = String(poc.contract_id);
    const posIdx = state.portfolio.activePositions.findIndex(p => String(p.contractId) === contractId);
    if (posIdx === -1) return;

    const isSold = Number(poc.is_sold) === 1;
    if (!isSold) return;

    const profit = Number(poc.profit || 0);
    const symbolId = state.portfolio.activePositions[posIdx].symbolId;

    // Remove position
    const pos = state.portfolio.activePositions.splice(posIdx, 1)[0];

    // Update PnL
    state.portfolio.dailyPnL += profit;

    // Update win/loss stats
    const a = ensureAssetState(symbolId);
    const win = profit > 0 ? 1 : 0;

    if (win) {
        a.wins += 1;
        a.consecutiveLosses = 0;
    } else {
        a.losses += 1;
        a.consecutiveLosses += 1;
    }

    a.recentResults.push(win);
    if (a.recentResults.length > 20) a.recentResults.shift();
    updateWinRate(symbolId);

    if (a.consecutiveLosses >= 3) {
        a.cooldownUntil = now() + 4 * 60 * 60 * 1000;
        log(`[RISK] ${symbolId} hit ${a.consecutiveLosses} consecutive losses. Cooldown for 4 hours.`);
        a.consecutiveLosses = 0; // reset counter after triggering cooldown
    }

    // Forget contract subscription
    const subId = state.runtime.contractSubscriptions.get(contractId);
    if (subId) forget(subId);
    state.runtime.contractSubscriptions.delete(contractId);

    log(`[CLOSE] ${symbolId} ${pos.direction} profit=${fmt(profit)} dailyPnL=${fmt(state.portfolio.dailyPnL)}`);

    const g = dailyGuard();
    if (!g.ok) log(`[GUARD] ${g.reason}`);
}

// --------------------------- Scheduling ---------------------------
async function scoringLoop() {
    // Pull snapshots for non-subscribed assets to score the full universe.
    const allIds = Object.keys(ASSETS);
    const subscribed = new Set(state.runtime.candleSubscriptions.keys());
    const needSnapshot = allIds.filter(id => !subscribed.has(id));

    // Rate-limit snapshots to avoid spamming
    for (const id of needSnapshot) {
        await fetchCandlesSnapshot(id);
        await sleep(350);
    }

    const scores = computeAssetScores();
    state.selection.scores = scores;
    state.selection.lastScoredAt = now();

    const top2 = selectTop2(scores);
    state.selection.top2 = top2;

    // Ensure we have weights (rebalance every 4 hours, but also if empty)
    if (!state.portfolio.lastRebalanceAt || (now() - state.portfolio.lastRebalanceAt) > CONFIG.rebalanceEveryMs) {
        rebalanceAllocation(top2);
    }

    log(`[PM] Top-2: ${top2.map(id => `${id}:${fmt((scores[id] || 0) * 100, 1)}%`).join(' | ')}`);

    // Candle subscriptions: keep top2 plus up to 3 additional best-scored for data freshness (max 5 total)
    const ranked = Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
    const desired = Array.from(new Set([...top2, ...ranked])).slice(0, CONFIG.maxSubscribedAssets);
    await updateCandleSubscriptions(desired);
}

function scheduleDailyReset() {
    const d = new Date();
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5);
    const ms = next - Date.now();
    setTimeout(() => {
        state.portfolio.dailyPnL = 0;
        state.portfolio.tradingHalted = false;
        state.portfolio.lockedProfit = 0;

        for (const symbolId of Object.keys(ASSETS)) {
            const a = ensureAssetState(symbolId);
            a.dailyTrades = 0;
            a.tradesByDirection = { CALL: 0, PUT: 0 };
            a.consecutiveLosses = 0;
            // keep recentResults and winRate
        }

        log('[RESET] Daily counters reset (UTC).');
        scheduleDailyReset();
    }, ms);
}

// --------------------------- WS message handling ---------------------------
function onWsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Resolve request/response promises
    if (msg.req_id && state.runtime.pending.has(msg.req_id)) {
        const p = state.runtime.pending.get(msg.req_id);
        state.runtime.pending.delete(msg.req_id);
        p.resolve(msg);
    }

    if (msg.error) {
        // Still log errors even if promise was resolved
        log(`[WS] Error: ${msg.error.message}`);
    }

    switch (msg.msg_type) {
        case 'authorize':
            state.runtime.authorized = true;
            log(`[AUTH] Authorized as ${msg.authorize?.loginid || 'unknown'}`);
            break;

        case 'candles': {
            const apiSymbol = msg.echo_req?.ticks_history;
            const symbolId = symbolIdFromApiSymbol(apiSymbol);
            if (!symbolId) break;

            const candles = msg.candles || [];
            if (candles.length) {
                mergeCandles(symbolId, candles);
                postToWorker(symbolId);
            }
            break;
        }

        case 'proposal_open_contract': {
            const poc = msg.proposal_open_contract;
            if (poc) onOpenContract(poc);
            break;
        }

        default:
            break;
    }
}

async function connect() {
    ws = new WebSocket(ENDPOINT);

    ws.on('open', async () => {
        state.runtime.wsReady = true;
        log(`[WS] Connected ${ENDPOINT}`);

        if (!PAPER) {
            try {
                const auth = await send({ authorize: TOKEN });
                if (auth.error) throw new Error(auth.error.message);
            } catch (e) {
                log(`[AUTH] Failed. Falling back to paper mode. Error: ${e.message}`);
            }
        } else {
            log('[MODE] Paper mode enabled (no token provided or --paper flag used).');
        }

        // Bootstrap subscriptions (up to 5) so we get data quickly
        const bootstrap = ['R_10', 'R_75', 'BOOM1000', 'FRXEURUSD', 'XAUUSD'].filter(x => ASSETS[x]);
        await updateCandleSubscriptions(bootstrap.slice(0, CONFIG.maxSubscribedAssets));

        // Run an initial scoring shortly after bootstrap
        setTimeout(() => scoringLoop().catch(e => log(`[PM] Scoring error: ${e.message}`)), 2500);
    });

    ws.on('message', onWsMessage);

    ws.on('close', () => {
        state.runtime.wsReady = false;
        state.runtime.authorized = false;
        log('[WS] Closed. Reconnecting in 3s…');
        setTimeout(connect, 3000);
    });

    ws.on('error', (e) => {
        log(`[WS] Error: ${e.message}`);
    });
}

// --------------------------- Startup ---------------------------
(async function main() {
    log(`Starting Deriv Multi-Asset Bot | app_id=${APP_ID} | mode=${PAPER ? 'PAPER' : 'LIVE'} | capital=${fmt(state.capital)}`);

    startWorkers();
    loadModelsIfPresent().catch(e => log(`[AI] Model load error: ${e.message}`));

    scheduleDailyReset();

    await connect();

    setInterval(() => {
        scoringLoop().catch(e => log(`[PM] Scoring error: ${e.message}`));
    }, CONFIG.scoringEveryMs);

    // Rebalance timer (only affects future trades)
    setInterval(() => {
        if (state.selection.top2.length) rebalanceAllocation(state.selection.top2);
    }, CONFIG.rebalanceEveryMs);

    // Safety: cleanup old pending requests
    setInterval(() => {
        const t = now();
        for (const [id, p] of state.runtime.pending.entries()) {
            if (t - p.at > 20_000) {
                state.runtime.pending.delete(id);
                p.reject(new Error('Request timeout'));
            }
        }
    }, 5_000);
})();