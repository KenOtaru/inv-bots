'use strict';
require('dotenv').config();

const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { BinanceOptionsClient } = require('./lib/binance-options-client');
const { OptionsUniverse } = require('./lib/options-universe');
const { OptionsRiskManager } = require('./lib/options-risk-manager');
const { TelegramNotifier } = require('./lib/telegram-notifier');

// ── Env-var overrides ──────────────────────────────────────────────
const BINANCE_API_KEY    = process.env.BINANCE_API_KEY     || '';
const BINANCE_SECRET     = process.env.BINANCE_API_SECRET  || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN  || '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID    || '752497117';
const TELEGRAM_ENABLED   = process.env.TELEGRAM_ENABLED    !== 'false';

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const CONFIG = {
    // ── Binance Auth ──
    BINANCE_API_KEY,
    BINANCE_SECRET,
    BASE_URL: 'https://eapi.binance.com',
    SPOT_BASE_URL: 'https://api.binance.com',
    PAPER_MODE: true, // true = paper trading (no real trades), false = live trading

    // ── Mode Selection ──
    TRADE_MODE: 'wpr',               // 'wpr' | 'prediction'
    PREDICTION_PERCENTAGE: 70,       // target delta % (min 70, user-adjustable)

    // ── Prediction Mode Filters ──
    // NOTE: Binance Options liquidity is very thin — live spreads range 0.8%–200%+.
    // Hard 5% cutoff blocks nearly every contract (~90% filtered). Use score-based
    // selection (delta proximity + spread penalty) + a soft advisory cap instead.
    MAX_SPREAD_PCT: 15,

    // ── WPR Strategy ──
    WPR_PERIOD: 7,
    WPR_OVERBOUGHT: -20,
    WPR_OVERSOLD: -80,
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    CANDLES_TO_LOAD: 100,
    MAX_CANDLES_STORED: 100,
    DURATION: 1,
    DURATION_UNIT: 'm',

    // ── Active Underlyings ──
    ACTIVE_UNDERLYINGS: ['BTCUSDT', 'ETHUSDT'],

    // ── General ──
    DEBUG_MODE: true,
    POLL_SECONDS: 30,

    // ── Telegram ──
    TELEGRAM_ENABLED,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,

    // ── Trading Sessions (GMT-based) ──
    USE_TRADING_SESSIONS: true,
    SESSIONS: [
        { name: 'LONDON_OPEN', start: 1, end: 17 },
        { name: 'NY_OPEN', start: 12, end: 23 },
    ],

    // ── Position Management ──
    MAX_OPEN_POSITIONS_PER_UNDERLYING: 1,
    MAX_TOTAL_POSITIONS: 15,
    MAX_TRADES_PER_CYCLE: 1,

    // ── Exit Config ─
    EXIT_CONFIG: { takeProfitPercent: 100, stopLossPercent: 50, holdSeconds: 60 },

    // ── Risk ──
    MAX_DAILY_LOSS_USDT: 500,
    MAX_PREMIUM_USDT: 1000,

    // ── Session Targets ──
    SESSION_PROFIT_TARGET: 500000,
    SESSION_STOP_LOSS: -200,
};

const DEFAULT_ASSET_CONFIG = {
    GRANULARITY: 60,
    TIMEFRAME_LABEL: '1m',
    DURATION: 1,
    DURATION_UNIT: 'm',
    INITIAL_STAKE: 0.50,
    INVESTMENT_AMOUNT: 1000,
    MARTINGALE_MULTIPLIER: 1.48,
    MAX_MARTINGALE_LEVEL: 1,
    AFTER_MAX_LOSS: 'continue',
    CONTINUE_EXTRA_LEVELS: 8,
    EXTRA_LEVEL_MULTIPLIERS: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5],
    AUTO_COMPOUNDING: false,
    COMPOUND_PERCENTAGE: 0.1,
    STOP_LOSS: 500,
};

function getAssetConfig(symbol) {
    return { ...DEFAULT_ASSET_CONFIG };
}

// ═══════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════
const LOGGER = {
    info: (msg) => console.log(`[${getGMTTime()}] [INFO] ${msg}`),
    error: (msg) => console.error(`[${getGMTTime()}] [ERROR] ${msg}`),
    warn: (msg) => console.warn(`[${getGMTTime()}] [WARN] ${msg}`),
    trade: (msg) => console.log(`[${getGMTTime()}] [TRADE] ${msg}`),
};

function getGMTTime() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function getUTCDay() {
    return new Date().getUTCDay(); // 0=Sun ... 6=Sat
}

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
const STATE_FILE = 'bizWillRFv2_Binance_state.json';
const HISTORY_FILE = 'bizWillRFv2_Binance_history.json';
const STATE_SAVE_INTERVAL = 5000;

const state = {
    assets: {},
    capital: CONFIG.ACTIVE_UNDERLYINGS.reduce((s, sym) => s + getAssetConfig(sym).INVESTMENT_AMOUNT, 0),
    isConnected: false,
    isAuthorized: false,
    currentTradeDay: new Date().toISOString().split('T')[0],
    session: {
        profit: 0, loss: 0, netPL: 0,
        tradesCount: 0, winsCount: 0, lossesCount: 0,
        isActive: true, startTime: Date.now(),
        startCapital: CONFIG.ACTIVE_UNDERLYINGS.length
            ? getAssetConfig(CONFIG.ACTIVE_UNDERLYINGS[0]).INVESTMENT_AMOUNT : DEFAULT_ASSET_CONFIG.INVESTMENT_AMOUNT,
    },
    hourlyStats: { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() },
    requestId: 1,
    dailyLossToday: 0,
    openPositions: new Map(),
};

let tradeHistory = null;
let BinanceClient = null;
let Universe = null;
let Risk = null;
let Notifier = null;
let mainIntervalId = null;
let hourlyTimerId = null;
let dailyTimerId = null;
let autoSaveId = null;
let statusIntervalId = null;

// ═══════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS — Williams %R  (DIRECT PORT from bizWillRFv2.js)
// ═══════════════════════════════════════════════════════════════════
class TechnicalIndicators {
    static calculateWPR(candles, period = CONFIG.WPR_PERIOD) {
        if (!Array.isArray(candles) || candles.length < period) return null;
        const window = candles.slice(-period);
        let highestHigh = -Infinity;
        let lowestLow = Infinity;
        for (const c of window) {
            const high = Number(c?.high);
            const low = Number(c?.low);
            const close = Number(c?.close);
            if (![high, low, close].every(Number.isFinite) || high < low || close > high || close < low) {
                return null;
            }
            highestHigh = Math.max(highestHigh, high);
            lowestLow = Math.min(lowestLow, low);
        }
        const range = highestHigh - lowestLow;
        if (!Number.isFinite(range) || range <= 0) return null;
        const close = Number(window[window.length - 1].close);
        const value = -100 * ((highestHigh - close) / range);
        if (!Number.isFinite(value)) return null;
        return Math.max(-100, Math.min(0, value));
    }

    static calculateWPRSeries(candles, period = CONFIG.WPR_PERIOD) {
        if (!Array.isArray(candles) || candles.length < period) return [];
        const values = [];
        for (let end = period; end <= candles.length; end++) {
            const v = this.calculateWPR(candles.slice(0, end), period);
            if (Number.isFinite(v)) values.push({ candleIndex: end - 1, value: v });
        }
        return values;
    }
}

// ═══════════════════════════════════════════════════════════════════
// SIGNAL MANAGER — EVERY valid cross trades (DIRECT PORT)
// ═══════════════════════════════════════════════════════════════════
class SignalManager {
    static seedWPRState(symbol) {
        const a = state.assets[symbol];
        if (!a) return false;
        const cfg = getAssetConfig(symbol);
        const period = cfg.WPR_PERIOD ?? CONFIG.WPR_PERIOD;
        const series = TechnicalIndicators.calculateWPRSeries(a.closedCandles, period);
        if (!series.length) return false;
        a.prevWpr = series.length > 1 ? series[series.length - 2].value : null;
        a.wpr = series[series.length - 1].value;
        a.buyFlagActive = false;
        a.sellFlagActive = false;
        a.indicatorsReady = Number.isFinite(a.prevWpr) && Number.isFinite(a.wpr);
        return true;
    }

    static updateWPRState(symbol) {
        const a = state.assets[symbol];
        if (!a) return false;
        a.buyFlagActive = false;
        a.sellFlagActive = false;
        return false;
    }

    static checkBuySignal(symbol) {
        const a = state.assets[symbol];
        const wpr = a?.wpr;
        const prevWpr = a?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) {
            return { shouldTrade: false, reason: `WPR not ready (${String(prevWpr)}→${String(wpr)})`, details: { wpr, prevWpr } };
        }
        const isCrossingAbove = prevWpr <= CONFIG.WPR_OVERSOLD && wpr > CONFIG.WPR_OVERSOLD;
        if (!isCrossingAbove) {
            return { shouldTrade: false, reason: `No BUY cross: ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} (need ≤${CONFIG.WPR_OVERSOLD}→>${CONFIG.WPR_OVERSOLD})`, details: { wpr, prevWpr } };
        }
        return {
            shouldTrade: true, direction: 'CALLE', confidence: 1,
            reason: `WPR BUY cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} above oversold ${CONFIG.WPR_OVERSOLD}`,
            details: { wpr, prevWpr }
        };
    }

    static checkSellSignal(symbol) {
        const a = state.assets[symbol];
        const wpr = a?.wpr;
        const prevWpr = a?.prevWpr;
        if (!Number.isFinite(wpr) || !Number.isFinite(prevWpr)) {
            return { shouldTrade: false, reason: `WPR not ready (${String(prevWpr)}→${String(wpr)})`, details: { wpr, prevWpr } };
        }
        const isCrossingBelow = prevWpr >= CONFIG.WPR_OVERBOUGHT && wpr < CONFIG.WPR_OVERBOUGHT;
        if (!isCrossingBelow) {
            return { shouldTrade: false, reason: `No SELL cross: ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} (need ≥${CONFIG.WPR_OVERBOUGHT}→<${CONFIG.WPR_OVERBOUGHT})`, details: { wpr, prevWpr } };
        }
        return {
            shouldTrade: true, direction: 'PUTE', confidence: 1,
            reason: `WPR SELL cross ${prevWpr.toFixed(2)}→${wpr.toFixed(2)} below overbought ${CONFIG.WPR_OVERBOUGHT}`,
            details: { wpr, prevWpr }
        };
    }

    static analyze(symbol) {
        const buySig = this.checkBuySignal(symbol);
        if (buySig.shouldTrade) return buySig;
        const sellSig = this.checkSellSignal(symbol);
        if (sellSig.shouldTrade) return sellSig;
        const a = state.assets[symbol];
        return {
            shouldTrade: false, direction: null, confidence: 0,
            reason: buySig.reason || sellSig.reason || `No WPR signal wpr=${a?.wpr?.toFixed(2) ?? 'n/a'} prev=${a?.prevWpr?.toFixed(2) ?? 'n/a'}`,
            details: { wpr: a?.wpr, prevWpr: a?.prevWpr }
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// STAKE CALCULATOR (DIRECT PORT)
// ═══════════════════════════════════════════════════════════════════
class StakeCalculator {
    static getBaseStake(symbol, investmentRemaining) {
        const cfg = getAssetConfig(symbol);
        if (cfg.AUTO_COMPOUNDING && investmentRemaining > 0) {
            return Math.max(Number((investmentRemaining * cfg.COMPOUND_PERCENTAGE / 100).toFixed(2)), cfg.INITIAL_STAKE);
        }
        return cfg.INITIAL_STAKE;
    }

    static calculate(symbol, martingaleLevel, investmentRemaining) {
        const cfg = getAssetConfig(symbol);
        let level = Math.max(0, martingaleLevel || 0);
        let base = this.getBaseStake(symbol, investmentRemaining);
        base = Math.max(base, cfg.INITIAL_STAKE);
        let stake;
        if (level <= cfg.MAX_MARTINGALE_LEVEL) {
            stake = base * Math.pow(cfg.MARTINGALE_MULTIPLIER, level);
        } else {
            stake = base * Math.pow(cfg.MARTINGALE_MULTIPLIER, cfg.MAX_MARTINGALE_LEVEL);
            const extraIdx = level - cfg.MAX_MARTINGALE_LEVEL - 1;
            for (let i = 0; i <= extraIdx; i++) {
                stake *= (cfg.EXTRA_LEVEL_MULTIPLIERS[i] || cfg.MARTINGALE_MULTIPLIER);
            }
            if (level > cfg.MAX_MARTINGALE_LEVEL + cfg.CONTINUE_EXTRA_LEVELS) {
                stake = base;
                level = 0;
            }
        }
        stake = Math.min(stake, investmentRemaining > 0 ? investmentRemaining : stake);
        stake = Math.max(cfg.INITIAL_STAKE, stake);
        return parseFloat(stake.toFixed(2));
    }

    static describe(symbol, investmentRemaining, martingaleLevel) {
        const stake = this.calculate(symbol, martingaleLevel, investmentRemaining);
        const pct = investmentRemaining > 0 ? ((stake / investmentRemaining) * 100).toFixed(2) : '0.00';
        return `$${stake.toFixed(2)} (${pct}% pool, martingale level ${martingaleLevel})`;
    }
}

// ═══════════════════════════════════════════════════════════════════
// TRADE HISTORY MANAGER (DIRECT PORT with symbol-based keys)
// ═══════════════════════════════════════════════════════════════════
class TradeHistoryManager {
    static getDateKey() { return new Date().toISOString().split('T')[0]; }

    static loadHistory() {
        try {
            if (!fs.existsSync(HISTORY_FILE)) return this._emptyHistory();
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!data.dailyHistory) data.dailyHistory = {};
            if (!data.overallAssets) data.overallAssets = {};
            if (!data.overall) data.overall = this._emptyOverall();
            LOGGER.info(`History loaded — ${Object.keys(data.dailyHistory).length} days on record`);
            return data;
        } catch (e) {
            LOGGER.error(`Failed to load history: ${e.message}`);
            return this._emptyHistory();
        }
    }

    static _emptyOverall() {
        return { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0,
            x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
            firstTradeDate: null, lastTradeDate: null };
    }

    static _emptyHistory() {
        return { overall: this._emptyOverall(), overallAssets: {}, dailyHistory: {}, lastUpdated: Date.now() };
    }

    static saveHistory() {
        try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2)); }
        catch (e) { LOGGER.error(`Failed to save history: ${e.message}`); }
    }

    static ensureDayEntry(dateKey) {
        if (!tradeHistory.dailyHistory[dateKey]) {
            tradeHistory.dailyHistory[dateKey] = {
                date: dateKey, tradesCount: 0, winsCount: 0, lossesCount: 0,
                profit: 0, loss: 0, netPL: 0, x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
                assets: {}, startCapital: state.capital, endCapital: state.capital,
            };
        }
    }

    static ensureAssetDayEntry(dateKey, symbol) {
        this.ensureDayEntry(dateKey);
        if (!tradeHistory.dailyHistory[dateKey].assets[symbol]) {
            tradeHistory.dailyHistory[dateKey].assets[symbol] = {
                tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0,
                x2Losses: 0, x3Losses: 0, x4Losses: 0, x5Losses: 0, x6Losses: 0, x7Losses: 0, x8Losses: 0, x9Losses: 0,
            };
        }
    }

    static ensureOverallAssetEntry(symbol) {
        if (!tradeHistory.overallAssets[symbol]) {
            tradeHistory.overallAssets[symbol] = { ...this._emptyOverall() };
        }
    }

    static recordTrade(symbol, profit, martingaleLevel = 0) {
        const dateKey = this.getDateKey();
        this.ensureAssetDayEntry(dateKey, symbol);
        this.ensureOverallAssetEntry(symbol);
        const dayStats = tradeHistory.dailyHistory[dateKey];
        const dayAssetStats = dayStats.assets[symbol];
        const overall = tradeHistory.overall;
        const overallAsset = tradeHistory.overallAssets[symbol];
        dayStats.tradesCount++; dayAssetStats.tradesCount++; overall.tradesCount++; overallAsset.tradesCount++;
        if (profit > 0) {
            dayStats.winsCount++; dayStats.profit += profit; dayStats.netPL += profit;
            dayAssetStats.winsCount++; dayAssetStats.profit += profit; dayAssetStats.netPL += profit;
            overall.winsCount++; overall.profit += profit; overall.netPL += profit;
            overallAsset.winsCount++; overallAsset.profit += profit; overallAsset.netPL += profit;
        } else {
            dayStats.lossesCount++; dayStats.loss += Math.abs(profit); dayStats.netPL += profit;
            dayAssetStats.lossesCount++; dayAssetStats.loss += Math.abs(profit); dayAssetStats.netPL += profit;
            overall.lossesCount++; overall.loss += Math.abs(profit); overall.netPL += profit;
            overallAsset.lossesCount++; overallAsset.loss += Math.abs(profit); overallAsset.netPL += profit;
            if (martingaleLevel >= 2 && martingaleLevel <= 9) {
                const key = `x${martingaleLevel}Losses`;
                dayStats[key]++; dayAssetStats[key]++; overall[key]++; overallAsset[key]++;
            }
        }
        if (!tradeHistory.overall.firstTradeDate) tradeHistory.overall.firstTradeDate = dateKey;
        tradeHistory.overall.lastTradeDate = dateKey;
        tradeHistory.dailyHistory[dateKey].endCapital = state.capital;
        tradeHistory.lastUpdated = Date.now();
        this.saveHistory();
    }

    static getDayStats(dateKey) { this.ensureDayEntry(dateKey); return tradeHistory.dailyHistory[dateKey]; }
    static getTodayStats() { return this.getDayStats(this.getDateKey()); }
    static getOverallStats() { return tradeHistory.overall; }
}

// ═══════════════════════════════════════════════════════════════════
// STATE PERSISTENCE (DIRECT PORT, Binance-adapted file names)
// ═══════════════════════════════════════════════════════════════════
class StatePersistence {
    static saveState() {
        try {
            const data = {
                savedAt: Date.now(),
                capital: state.capital,
                tradeMode: CONFIG.TRADE_MODE,
                predictionPercentage: CONFIG.PREDICTION_PERCENTAGE,
                session: { ...state.session },
                hourlyStats: { ...state.hourlyStats },
                currentTradeDay: state.currentTradeDay,
                dailyLossToday: state.dailyLossToday,
                assets: {},
            };
            Object.keys(state.assets).forEach(symbol => {
                const a = state.assets[symbol];
                data.assets[symbol] = {
                    closedCandles: (a.closedCandles || []).slice(-CONFIG.MAX_CANDLES_STORED),
                    wpr: a.wpr ?? null,
                    prevWpr: a.prevWpr ?? null,
                    indicatorsReady: a.indicatorsReady || false,
                    investmentRemaining: a.investmentRemaining,
                    currentStake: a.currentStake,
                    baseStake: a.baseStake,
                    martingaleLevel: a.martingaleLevel,
                    isRecovery: (a.martingaleLevel || 0) > 0,
                    canTrade: a.canTrade,
                    stopped: !!a.stopped,
                    stoppedReason: a.stoppedReason || null,
                    consecutiveWins: a.consecutiveWins || 0,
                    consecutiveLosses: a.consecutiveLosses || 0,
                    tradesCount: a.tradesCount || 0,
                    winsCount: a.winsCount || 0,
                    lossesCount: a.lossesCount || 0,
                    netPL: a.netPL || 0,
                    profit: a.profit || 0,
                    loss: a.loss || 0,
                    activePositions: [...(a.activePositions || [])].map(([k, p]) => [k, { ...p }]),
                    lastPredictionSelection: a.lastPredictionSelection || null,
                    lastProcessedCandleOpenTime: a.lastProcessedCandleOpenTime || 0,
                    candlesLoaded: a.candlesLoaded || false,
                };
            });
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
        } catch (e) { LOGGER.error(`Save state error: ${e.message}`); }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) return false;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMins = (Date.now() - data.savedAt) / 60000;
            if (ageMins > 120) {
                LOGGER.warn(`State is ${ageMins.toFixed(1)}min old — starting fresh`);
                fs.unlinkSync(STATE_FILE);
                return false;
            }
            LOGGER.info(`Restoring Binance state from ${ageMins.toFixed(1)} minutes ago`);
            if (data.tradeMode) CONFIG.TRADE_MODE = data.tradeMode;
            if (data.predictionPercentage) CONFIG.PREDICTION_PERCENTAGE = data.predictionPercentage;
            state.session = { ...state.session, ...data.session };
            state.hourlyStats = data.hourlyStats || state.hourlyStats;
            state.currentTradeDay = data.currentTradeDay || TradeHistoryManager.getDateKey();
            state.dailyLossToday = data.dailyLossToday || 0;
            if (data.assets) {
                Object.keys(data.assets).forEach(symbol => {
                    if (state.assets[symbol]) {
                        const saved = data.assets[symbol];
                        const a = state.assets[symbol];
                        if (saved.closedCandles?.length) a.closedCandles = saved.closedCandles;
                        a.lastProcessedCandleOpenTime = saved.lastProcessedCandleOpenTime || 0;
                        a.candlesLoaded = false;
                        a.wpr = Number.isFinite(saved.wpr) ? Number(saved.wpr) : null;
                        a.prevWpr = Number.isFinite(saved.prevWpr) ? Number(saved.prevWpr) : null;
                        a.indicatorsReady = saved.indicatorsReady || false;
                        a.martingaleLevel = saved.martingaleLevel || 0;
                        a.isRecovery = a.martingaleLevel > 0;
                        a.canTrade = saved.canTrade !== false;
                        a.currentStake = saved.currentStake || StakeCalculator.calculate(symbol, 0, a.investmentRemaining);
                        a.baseStake = saved.baseStake || StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
                        a.investmentRemaining = saved.investmentRemaining || getAssetConfig(symbol).INVESTMENT_AMOUNT;
                        a.stopped = saved.stopped || false;
                        a.stoppedReason = saved.stoppedReason || null;
                        a.consecutiveWins = saved.consecutiveWins || 0;
                        a.consecutiveLosses = saved.consecutiveLosses || 0;
                        a.tradesCount = saved.tradesCount || 0;
                        a.winsCount = saved.winsCount || 0;
                        a.lossesCount = saved.lossesCount || 0;
                        a.netPL = saved.netPL || 0;
                        a.profit = saved.profit || 0;
                        a.loss = saved.loss || 0;
                        a.lastPredictionSelection = saved.lastPredictionSelection || null;
                        a.activePositions = new Map((saved.activePositions || []).map(([k, p]) => [k, { ...p }]));
                        LOGGER.info(`${symbol}: L${a.martingaleLevel} Stake=$${(a.currentStake || 0).toFixed(2)} Pool=$${(a.investmentRemaining || 0).toFixed(2)} P/L=$${(a.netPL || 0).toFixed(2)} | WPR ${(a.prevWpr ?? 'n/a')}→${(a.wpr ?? 'n/a')}`);
                    }
                });
            }
            return true;
        } catch (e) { LOGGER.error(`Load state error: ${e.message}`); return false; }
    }

    static startAutoSave() {
        autoSaveId = setInterval(() => { if (state.isAuthorized) this.saveState(); }, STATE_SAVE_INTERVAL);
        LOGGER.info(`Auto-save every ${STATE_SAVE_INTERVAL / 1000}s`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM SERVICE (DIRECT PORT, adapted for Binance PUT/CALL)
// ═══════════════════════════════════════════════════════════════════
class TelegramService {
    static hourlyTimerStarted = false;
    static dailyTimerStarted = false;
    static hourlyTimerId = null;
    static dailyTimerId = null;

    static async sendMessage(message) {
        if (!CONFIG.TELEGRAM_ENABLED || !message?.length) return;
        try {
            const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
            const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
            return new Promise((resolve) => {
                const req = https.request(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                }, res => { res.resume(); res.on('end', () => resolve()); });
                req.on('error', e => { LOGGER.error(`Telegram error: ${e.message}`); resolve(); });
                req.write(body); req.end();
            });
        } catch (e) { LOGGER.error(`Telegram exception: ${e.message}`); }
    }

    static async sendTradeAlert(type, symbol, direction, stake, optionContract, mode = 'wpr', details = {}) {
        // Defensive: mode must be a string (callers historically passed objects)
        if (typeof mode !== 'string') mode = typeof mode?.mode === 'string' ? mode.mode : 'wpr';
        const emoji = type === 'OPEN' ? '🚀' : type === 'WIN' ? '✅' : '❌';
        const a = state.assets[symbol];
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        let analysisDetails = '';
        if (type === 'OPEN' && details) {
            const wpr = details.wpr;
            const prevWpr = details.prevWpr;
            const wprStr = Number.isFinite(wpr) && Number.isFinite(prevWpr) ? `${prevWpr.toFixed(1)}→${wpr.toFixed(1)}` : 'N/A';
            if (mode === 'prediction') {
                analysisDetails = `
        📊 <b>Prediction Mode</b> — target: ${CONFIG.PREDICTION_PERCENTAGE}%
        📊 WPR Context: ${wprStr} (OB ${CONFIG.WPR_OVERBOUGHT} / OS ${CONFIG.WPR_OVERSOLD})
        🎯 Delta: ${details.delta?.toFixed?.(2) ?? 'N/A'} | Contract: <code>${details.contractSymbol ?? 'N/A'}</code>
        📊 Signal: ${direction === 'CALLE' ? 'BUY CALL (rise)' : 'BUY PUT (fall)'}`;
            } else {
                analysisDetails = `
        📊 <b>WPR(${CONFIG.WPR_PERIOD}) Signal:</b>
        📊 WPR: ${wprStr} (OB ${CONFIG.WPR_OVERBOUGHT} / OS ${CONFIG.WPR_OVERSOLD})
        📊 Signal: ${direction === 'CALLE' ? 'BUY (CALLE — rise)' : 'SELL (PUTE — fall)'}`;
            }
        }
        let resultDetails = '';
        if (details.profit !== undefined) {
            const profitNum = Number(details.profit) || 0;
            const isWin = profitNum > 0;
            resultDetails = `
        ${isWin ? '🟢' : '🔴'} <b>Profit: $${profitNum.toFixed(2)}</b>
        📋 <b>${symbol} Stats:</b> W/L: ${a?.winsCount ?? 0}/${a?.lossesCount ?? 0} | P/L: $${(a?.netPL ?? 0).toFixed(2)}
        🔢 Martingale Level: ${a?.martingaleLevel ?? 0} | Pool: $${(a?.investmentRemaining ?? 0).toFixed(2)}
        ${isWin ? '✅ Stake reset to default (L0)' : `⏳ Continue to L${(a?.martingaleLevel ?? 0) + 1}`}
        📋 <b>Today:</b> Trades: ${today.tradesCount} | W/L: ${today.winsCount || 0}/${today.lossesCount || 0} | P/L: $${(today.netPL || 0).toFixed(2)}
        📋 <b>Overall:</b> Trades: ${overall.tradesCount} | W/L: ${overall.winsCount}/${overall.lossesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`;
        }
        const recoveryStatus = (a?.martingaleLevel || 0) > 0 ? `🔄 RECOVERY L${a.martingaleLevel}` : '🎯 NORMAL';
        const dirLabel = direction === 'CALLE' ? 'CALL (RISE 📈)' : direction === 'PUTE' ? 'PUT (FALL 📉)' : direction;
        const contractInfo = details.contractSymbol ? `\n        📋 Contract: <code>${details.contractSymbol}</code>` : '';
        const deltaInfo = details.delta ? `\n        📊 Delta: ${details.delta.toFixed(2)}` : '';
        const msg = `
        ${emoji} <b>${type} Binance TRADE — ${recoveryStatus}</b>
        📊 Asset: ${symbol} (pool $${(a?.investmentRemaining ?? 0).toFixed(2)})
        📈 Direction: ${dirLabel}${contractInfo}${deltaInfo}
        💵 Stake: $${stake.toFixed(2)}
        ⏱ Duration: ${CONFIG.DURATION}${CONFIG.DURATION_UNIT?.toUpperCase()}
        🔢 Mode: ${mode.toUpperCase()}
        🔢 Martingale Level: ${a ? a.martingaleLevel : 0}
        ${analysisDetails}${resultDetails}
        `.trim();
        await this.sendMessage(msg);
    }

    static async sendHourlySummary() {
        const h = state.hourlyStats;
        if (h.trades === 0) return;
        const wr = h.trades > 0 ? ((h.wins / h.trades) * 100).toFixed(1) : '0.0';
        const today = TradeHistoryManager.getTodayStats();
        let assetInfo = '';
        CONFIG.ACTIVE_UNDERLYINGS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                assetInfo += `\n  ${sym}: ${a.tradesCount || 0}t ${a.winsCount || 0}W/${a.lossesCount || 0}L $${(a?.netPL || 0).toFixed(2)} L${a?.martingaleLevel || 0} pool $${(a?.investmentRemaining || 0).toFixed(2)}${a?.stopped ? ' STOPPED' : ''}`;
            }
        });
        await this.sendMessage([
            `⏰ <b>Binance HOURLY SUMMARY</b>`,
            `Last Hour: ${h.trades}t ${h.wins}W/${h.losses}L ${wr}% ${h.pnl >= 0 ? '' : ''} $${h.pnl.toFixed(2)}`,
            `Today: ${today.tradesCount}t P/L: $${(today.netPL || 0).toFixed(2)}`,
            `Pools sum: $${state.capital.toFixed(2)}`,
            TradingSessionManager.getStatusString(),
            assetInfo ? `\n<b>Per-Asset:</b>${assetInfo}` : '',
        ].join('\n'));
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };
    }

    static async sendSessionSummary() {
        const stats = SessionManager.getSessionStats();
        const overall = TradeHistoryManager.getOverallStats();
        const today = TradeHistoryManager.getTodayStats();
        const wr = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) : '0.0';
        let pairBreakdown = '';
        CONFIG.ACTIVE_UNDERLYINGS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                const pairWr = a.tradesCount > 0 ? ((a.winsCount / a.tradesCount) * 100).toFixed(1) : '0.0';
                pairBreakdown += `\n  ${sym}: ${a.tradesCount}t ${a.winsCount}W/${a.lossesCount}L (${pairWr}%) $${(a.netPL || 0).toFixed(2)} L${a.martingaleLevel || 0} pool $${(a.investmentRemaining || 0).toFixed(2)}`;
            }
        });
        await this.sendMessage([
            `📊 <b>Binance SESSION SUMMARY</b>`,
            `Duration: ${stats.duration} | Trades: ${stats.trades}`,
            `W: ${stats.wins} | L: ${stats.losses} | WR: ${stats.winRate}`,
            `Session P/L: $${(stats.netPL || 0).toFixed(2)}`,
            `Today P/L: $${(today.netPL || 0).toFixed(2)}`,
            `<b>Overall:</b> ${overall.tradesCount} trades | WR: ${wr}% | P/L: $${(overall.netPL || 0).toFixed(2)}`,
            pairBreakdown ? `\n<b>Per-Asset:</b>${pairBreakdown}` : '',
            `💰 Pools sum: $${state.capital.toFixed(2)}`,
        ].join('\n'));
    }

    static async sendStartupMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        let pairInfo = '';
        CONFIG.ACTIVE_UNDERLYINGS.forEach(sym => {
            pairInfo += `\n  ${sym}: ${CONFIG.TIMEFRAME_LABEL} | stake $${getAssetConfig(sym).INITIAL_STAKE} | pool $${getAssetConfig(sym).INVESTMENT_AMOUNT}`;
        });
        const modeDesc = CONFIG.TRADE_MODE === 'prediction'
            ? `Prediction Mode (target ${CONFIG.PREDICTION_PERCENTAGE}% delta)`
            : `WPR Mode (Williams %R cross)`;
        await this.sendMessage([
            `🤖 <b>Binance Bot STARTED — ${modeDesc}</b>`,
            `Strategy: ${CONFIG.TRADE_MODE === 'prediction' ? 'Delta-matching prediction' : 'Williams %R(' + CONFIG.WPR_PERIOD + ') cross above ' + CONFIG.WPR_OVERSOLD + ' → CALL | below ' + CONFIG.WPR_OVERBOUGHT + ' → PUT (every cross trades)'}`,
            `Paper Mode: ${CONFIG.PAPER_MODE ? 'ON' : 'OFF'}`,
            `Active Underlyings:${pairInfo}`,
            `📊 Overall: ${overall.tradesCount} trades | P/L: $${(overall.netPL || 0).toFixed(2)}`,
        ].join('\n'));
    }

    static async sendStoppedMessage() {
        const overall = TradeHistoryManager.getOverallStats();
        await this.sendMessage(
            `🛑 <b>Binance Bot STOPPED</b>\nOverall: ${overall.tradesCount} trades | W/L: ${overall.winsCount}/${overall.lossesCount} | P/L: $${(overall.netPL || 0).toFixed(2)}`
        );
    }

    static startHourlyTimer() {
        if (this.hourlyTimerStarted) return;
        this.hourlyTimerStarted = true;
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
        setTimeout(() => { this.sendHourlySummary(); hourlyTimerId = setInterval(() => this.sendHourlySummary(), 3600000); }, nextHour.getTime() - now.getTime());
    }

    static startDailyTimer() {
        if (this.dailyTimerStarted) return;
        this.dailyTimerStarted = true;
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        nextDay.setUTCHours(0, 0, 0, 0);
        setTimeout(() => { SessionManager.checkDayChange(); dailyTimerId = setInterval(() => SessionManager.checkDayChange(), 86400000); }, nextDay.getTime() - now.getTime());
    }

    static clearTimers() {
        if (hourlyTimerId) { clearInterval(hourlyTimerId); hourlyTimerId = null; this.hourlyTimerStarted = false; }
        if (dailyTimerId) { clearInterval(dailyTimerId); dailyTimerId = null; this.dailyTimerStarted = false; }
    }
}

// ═══════════════════════════════════════════════════════════════════
// TRADING SESSION MANAGER (GMT-based, DIRECT PORT adapted)
// ═══════════════════════════════════════════════════════════════════
class TradingSessionManager {
    static getCurrentUTCHour() { return new Date().getUTCHours(); }
    static isWithinAnySession() {
        if (!CONFIG.USE_TRADING_SESSIONS) return { inSession: true, sessionName: '24/7' };
        const hour = this.getCurrentUTCHour();
        for (const session of CONFIG.SESSIONS) {
            if (this._inSession(hour, session.start, session.end)) {
                return { inSession: true, sessionName: session.name };
            }
        }
        return { inSession: false, sessionName: null };
    }
    static _inSession(hour, start, end) {
        if (end <= start) return hour >= start || hour < end;
        return hour >= start && hour < end;
    }
    static getStatusString() {
        if (!CONFIG.USE_TRADING_SESSIONS) return `\u{1f7e2} SYNTHETIC 24/7 MODE`;
        const info = this.isWithinAnySession();
        if (!info.inSession) return `\u{1f534} OUTSIDE SESSIONS`;
        return `\u{1f7e2} ${info.sessionName}`;
    }
}

// ═══════════════════════════════════════════════════════════════════
// SESSION MANAGER (DIRECT PORT, Binance-adapted)
// ═══════════════════════════════════════════════════════════════════
class SessionManager {

    static isSessionActive() { return state.session.isActive; }

    // Global targets are REPORT-ONLY in v4 (never halt other assets).
    static checkSessionTargets() {
        const netPL = state.session?.netPL || 0;
        if (netPL >= CONFIG.SESSION_PROFIT_TARGET) {
            LOGGER.trade(`Global profit milestone: $${netPL.toFixed(2)} (report-only, assets continue)`);
        }
        if (netPL <= CONFIG.SESSION_STOP_LOSS) {
            LOGGER.warn(`Global loss milestone: $${netPL.toFixed(2)} (report-only, assets continue)`);
        }
        return false;
    }

    // Per-asset guard — one asset stopping never affects the others.
    static checkAssetTargets(symbol) {
        const a = state.assets[symbol];
        if (!a || a.stopped) return true;
        const cfg = getAssetConfig(symbol);
        const pt = cfg.SESSION_PROFIT_TARGET ?? CONFIG.SESSION_PROFIT_TARGET;
        const sl = cfg.SESSION_STOP_LOSS ?? CONFIG.SESSION_STOP_LOSS;
        if (Number.isFinite(pt) && a.netPL >= pt) {
            a.stopped = true; a.stoppedReason = 'PROFIT_TARGET';
            LOGGER.trade(`[${symbol}] Per-asset profit target $${a.netPL.toFixed(2)} — asset stopped, others continue`);
            TelegramService.sendMessage(`🏁 <b>[${symbol}] Binance PROFIT TARGET</b>\nP/L: $${a.netPL.toFixed(2)}\nPool: $${(a.investmentRemaining || 0).toFixed(2)} — others continue`);
            return true;
        }
        if (Number.isFinite(sl) && a.netPL <= sl) {
            a.stopped = true; a.stoppedReason = 'STOP_LOSS';
            LOGGER.error(`[${symbol}] Per-asset stop-loss $${a.netPL.toFixed(2)} — asset stopped, others continue`);
            TelegramService.sendMessage(`\u{1f534} <b>[${symbol}] Binance STOP-LOSS</b>\nP/L: $${a.netPL.toFixed(2)}\nPool: $${(a.investmentRemaining || 0).toFixed(2)} — others continue`);
            return true;
        }
        return false;
    }

    static recalcGlobalCapital() {
        try {
            const sum = CONFIG.ACTIVE_UNDERLYINGS.reduce((s, sym) => s + (Number(state.assets[sym]?.investmentRemaining) || 0), 0);
            state.capital = Number(sum.toFixed(2));
        } catch (_) { }
    }

    static async endSession(reason) {
        state.session.isActive = false;
        LOGGER.info(`Session ended: ${reason}`);
        await TelegramService.sendSessionSummary();
    }

    static getSessionStats() {
        const dur = Date.now() - state.session.startTime;
        const hrs = Math.floor(dur / 3600000);
        const mins = Math.floor((dur % 3600000) / 60000);
        const wr = state.session.tradesCount > 0
            ? ((state.session.winsCount / state.session.tradesCount) * 100).toFixed(1) + '%'
            : '0%';
        return { duration: `${hrs}h ${mins}m`, trades: state.session.tradesCount, wins: state.session.winsCount, losses: state.session.lossesCount, winRate: wr, netPL: state.session.netPL };
    }

    static checkDayChange() {
        const today = TradeHistoryManager.getDateKey();
        if (state.currentTradeDay && state.currentTradeDay !== today) {
            LOGGER.info(`Day changed: ${state.currentTradeDay} -> ${today}`);
            const dayStats = TradeHistoryManager.getDayStats(state.currentTradeDay);
            TelegramService.sendMessage(
                `\u{1f319} <b>Binance END OF DAY ${state.currentTradeDay}</b>\nP/L: $${(dayStats?.netPL || 0).toFixed(2)}\nCapital: $${state.capital.toFixed(2)}`
            );
            this._resetDailyStats();
            if (!state.session.isActive) {
                state.session.isActive = true;
                LOGGER.info('Session re-activated for new day');
            }
        }
        state.currentTradeDay = today;
    }

    static _resetDailyStats() {
        const s = state.session;
        s.tradesCount = 0; s.winsCount = 0; s.lossesCount = 0;
        s.profit = 0; s.loss = 0; s.netPL = 0;
        s.startTime = Date.now(); s.startCapital = state.capital;
        state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getUTCHours() };

        CONFIG.ACTIVE_UNDERLYINGS.forEach(sym => {
            const a = state.assets[sym];
            if (a) {
                a.tradesCount = 0; a.winsCount = 0; a.lossesCount = 0;
                a.profit = 0; a.loss = 0; a.netPL = 0;
            }
        });
    }

    static recordTradeResult(symbol, profit, direction, stake) {
        const a = state.assets[symbol];
        if (!a) return;

        this.checkDayChange();

        // Per-asset pool accounting:
        //   WIN  → credit stake + profit back to THIS asset's pool only.
        //   LOSS → stake was already deducted from pool on order open.
        // state.capital is a reporting sum only (recalculated, never deducted directly).

        const hour = new Date().getUTCHours();
        if (hour !== state.hourlyStats.lastHour) {
            state.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: hour };
        }

        state.session.tradesCount++;
        state.hourlyStats.trades++;
        state.hourlyStats.pnl += profit;
        a.tradesCount++;

        if (profit > 0) {
            state.session.winsCount++;
            state.session.profit += profit;
            state.session.netPL += profit;
            a.winsCount++;
            a.profit += profit; a.netPL += profit;
            a.consecutiveWins++;
            a.consecutiveLosses = 0;
            a.martingaleLevel = 0; // WIN resets stake to default (L0)
            a.isRecovery = false;

            // Credit payout (stake + profit) back to THIS asset's pool only.
            a.investmentRemaining = Number((a.investmentRemaining + stake + profit).toFixed(2));
            a.currentStake = StakeCalculator.getBaseStake(symbol, a.investmentRemaining);
            LOGGER.trade(`WIN [${symbol}] +$${(profit || 0).toFixed(2)} | ${direction} | P/L: $${(a.netPL || 0).toFixed(2)} | stake reset to $${a.currentStake.toFixed(2)} (L0)`);
            this.checkAssetTargets(symbol);
        } else {
            state.session.lossesCount++;
            state.session.loss += Math.abs(profit);
            state.session.netPL += profit;
            a.lossesCount++;
            a.loss += Math.abs(profit);
            a.netPL += profit;
            a.consecutiveLosses++;
            a.consecutiveWins = 0;
            a.martingaleLevel = (a.martingaleLevel || 0) + 1;
            a.isRecovery = a.martingaleLevel > 0; // informational only (L>0 = in recovery)

            a.currentStake = StakeCalculator.calculate(symbol, a.martingaleLevel, a.investmentRemaining);

            LOGGER.trade(`LOSS [${symbol}] -$${Math.abs(profit || 0).toFixed(2)} | ${direction} | next Stake: $${(a.currentStake || 0).toFixed(2)} (martingale L${a.martingaleLevel})`);
            this.checkAssetTargets(symbol);
        }

        this.recalcGlobalCapital();
        TradeHistoryManager.recordTrade(symbol, profit, a.martingaleLevel);
    }
}

// ═══════════════════════════════════════════════════════════════════
// BINANCE CANDLE FETCHER (Binance REST klines API)
// ═══════════════════════════════════════════════════════════════════
class BinanceCandleFetcher {
    constructor(client, baseUrl) {
        this.client = client;
        this.baseUrl = baseUrl || 'https://api.binance.com';
        this._seenCandle = new Map();
    }

    async fetch(underlying, interval = '1m', limit = 100) {
        try {
            const rows = await this.client.request('GET', '/api/v3/klines',
                { symbol: underlying, interval, limit },
                { baseUrl: this.baseUrl });
            if (!Array.isArray(rows) || !rows.length) return [];
            return rows.map(r => ({
                openTime: Number(r[0]),
                open: parseFloat(r[1]),
                high: parseFloat(r[2]),
                low: parseFloat(r[3]),
                close: parseFloat(r[4]),
                volume: parseFloat(r[5]),
                closeTime: Number(r[6]),
            })).filter(c => Number.isFinite(c.open) && Number.isFinite(c.close));
        } catch (e) {
            LOGGER.error(`[BinanceCandleFetcher] ${underlying}: ${e.message}`);
            return [];
        }
    }

    getSeenTime(underlying) { return this._seenCandle.get(underlying) || null; }
    setSeenTime(underlying, openTime) { this._seenCandle.set(underlying, openTime); }
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// PREDICTION SELECTOR — delta-matching contract selection
// ═══════════════════════════════════════════════════════════════════
class PredictionSelector {
    static async select(underlying, optionSide, mode = 'wpr') {
        if (mode === 'prediction') {
            return this._selectByDelta(underlying, optionSide);
        }
        return this._selectByProximity(underlying, optionSide);
    }

    // Delta-matching: scan all liquid CALL/PUT contracts, pick the one
    // whose |delta| is closest to PREDICTION_PERCENTAGE/100.
    static async _selectByDelta(underlying, optionSide) {
        try {
            const info = await BinanceClient.exchangeInfo();
            const candidates = (info.optionSymbols || [])
                .filter(s => s.status === 'TRADING' && s.underlying === underlying && s.side === optionSide);
            if (!candidates.length) { LOGGER.warn(`[Prediction] No ${optionSide} candidates for ${underlying}`); return null; }

            const targetDelta = CONFIG.PREDICTION_PERCENTAGE / 100;
            const results = await Promise.all(candidates.map(async sym => {
                try {
                    // Binance eapi/depth rejects limit=5 — use 10 (valid for options).
                    // Falls back to mark-only if depth fails (spread = Infinity, filtered out).
                    let bid = 0, ask = 0, spreadPercent = Infinity;
                    try {
                        const book = await BinanceClient.depth(sym.symbol, 10);
                        bid = Number(book?.bids?.[0]?.[0] || 0);
                        ask = Number(book?.asks?.[0]?.[0] || 0);
                        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
                            spreadPercent = Math.abs(ask - bid) / ((bid + ask) / 2) * 100;
                        }
                    } catch { /* depth unavailable — spread stays Infinity */ }

                    // Get mark for delta (REQUIRED) — if this fails, skip the contract
                    let delta = 0;
                    try {
                        const marks = await BinanceClient.mark(sym.symbol);
                        const mark = Array.isArray(marks) ? marks[0] : marks;
                        delta = Number(mark?.delta || 0);
                    } catch { return null; }

                    const mid = (bid + ask) / 2;
                    if (!Number.isFinite(mid) || mid <= 0) return null;
                    // Hard cap only at 50% — beyond that the contract is unusable
                    if (spreadPercent > 50) return null;
                    return {
                        symbol: sym, mark: { delta }, bid, ask, delta,
                        spreadPercent,
                        // score = (delta distance as % of target) + (spread as % of target)
                        // so delta proximity dominates unless spreads are extreme
                        score: Math.abs(Math.abs(delta) - targetDelta) * 2 + Math.min(spreadPercent, 50) / 100,
                    };
                } catch { return null; }
            }));
            return results.filter(Boolean).sort((a, b) => a.score - b.score)[0] || null;
        } catch (e) {
            LOGGER.error(`[Prediction] Selection error: ${e.message}`);
            return null;
        }
    }

    // Nearest-to-index: pick the contract whose strike is closest to index price.
    // IMPROVED: Sample only near-expiry, reasonably-priced contracts to avoid rate limits.
    static async _selectByProximity(underlying, optionSide) {
        try {
            const info = await BinanceClient.exchangeInfo();
            const candidates = (info.optionSymbols || [])
                .filter(s => s.status === 'TRADING' && s.underlying === underlying && s.side === optionSide);
            if (!candidates.length) { LOGGER.warn(`[WPR] No ${optionSide} candidates for ${underlying}`); return null; }

            const indexRes = await BinanceClient.index(underlying);
            const indexPrice = Number(indexRes?.indexPrice || 0);
            if (!Number.isFinite(indexPrice)) { LOGGER.warn(`[WPR] No index price for ${underlying}`); return null; }

            // Filter to near-expiry (≤7 days) and near-ATM (±30% from index) to reduce API calls
            const now = Date.now();
            const filtered = candidates.filter(c => {
                const daysToExpiry = (Number(c.expiryDate) - now) / 86400000;
                const strike = Number(c.strikePrice);
                const distPct = Math.abs(strike - indexPrice) / indexPrice;
                return daysToExpiry <= 7 && distPct <= 0.30;
            });

            if (!filtered.length) {
                LOGGER.warn(`[WPR] No near-term ${optionSide} candidates for ${underlying}`);
                return null;
            }

            // Sample up to 10 contracts (nearest to ATM) to limit API calls
            filtered.sort((a, b) => Math.abs(Number(a.strikePrice) - indexPrice) - Math.abs(Number(b.strikePrice) - indexPrice));
            const sample = filtered.slice(0, 10);

            // Score: prefer cheap contracts that are tradeable
            const scored = [];
            for (const sym of sample) {
                try {
                    const marks = await BinanceClient.mark(sym.symbol);
                    const mark = Array.isArray(marks) ? marks[0] : marks;
                    if (!mark) continue;
                    const book = await BinanceClient.depth(sym.symbol, 10).catch(() => null);
                    const bid = Number(book?.bids?.[0]?.[0] || 0);
                    const ask = Number(book?.asks?.[0]?.[0] || 0);
                    if (!ask || ask <= 0) continue;
                    const spreadPct = (bid > 0 && ask > 0) ? (ask - bid) / ((bid + ask) / 2) * 100 : Infinity;
                    if (spreadPct > 50) continue;
                    const distanceFromATM = Math.abs(Number(sym.strikePrice) - indexPrice) / indexPrice;
                    // Score = ask price (prefer cheap) + penalty for distance from ATM
                    const score = ask + 1000 * distanceFromATM;
                    scored.push({ symbol: sym, mark, bid, ask, delta: Number(mark?.delta || 0), spreadPercent: spreadPct, score });
                } catch { /* skip */ }
            }

            if (!scored.length) { LOGGER.warn(`[WPR] No affordable ${optionSide} contracts for ${underlying}`); return null; }
            const pick = scored.sort((a, b) => a.score - b.score)[0];
            LOGGER.info(`[WPR] Selected: ${pick.symbol.symbol} ask=${pick.ask} spread=${pick.spreadPercent.toFixed(1)}%`);
            return pick;
        } catch (e) {
            LOGGER.error(`[WPR] Proximity selection error: ${e.message}`);
            return null;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// TRADE EXECUTION — place order, track position
// ═══════════════════════════════════════════════════════════════════
async function executeBuy(underlying, direction, signalDetails = {}) {
    const a = state.assets[underlying];
    if (!a || a.stopped) { LOGGER.warn(`[${underlying}] Asset stopped — no trade`); return null; }
    if (!a.canTrade) { LOGGER.warn(`[${underlying}] Cannot trade yet`); return null; }

    const cfg = getAssetConfig(underlying);
    const stake = StakeCalculator.calculate(underlying, a.martingaleLevel, a.investmentRemaining);
    const premium = stake; // for options: stake = premium budget
    LOGGER.info(`[${underlying}] EXECUTE: direction=${direction} stake=$${stake} pool=$${a.investmentRemaining} L${a.martingaleLevel}`);

    // Check risk limits
    const riskReason = Risk.canOpen({ underlying, premium });
    if (riskReason) { LOGGER.warn(`[${underlying}] Risk blocked: ${riskReason}`); return null; }
    LOGGER.info(`[${underlying}] Risk OK`);

    // Select contract
    const optionSide = direction === 'CALLE' ? 'CALL' : 'PUT';
    const picked = await PredictionSelector.select(underlying, optionSide, CONFIG.TRADE_MODE);
    LOGGER.info(`[${underlying}] SELECTED: ${picked ? picked.symbol.symbol + ' ask=' + picked.ask : 'null'}`);
    if (!picked) { LOGGER.warn(`[${underlying}] No eligible ${optionSide} contract`); return null; }

    // Calculate quantity from premium budget
    const quantity = OptionsUniverse.quantityForPremium(picked.symbol, picked.ask, stake);
    LOGGER.info(`[${underlying}] QUANTITY: ${quantity} (ask=${picked.ask} stake=${stake})`);
    if (!quantity || quantity <= 0) { LOGGER.warn(`[${underlying}] Quantity 0 for stake $${stake}`); return null; }

    const contractSymbol = picked.symbol.symbol;
    const entryPrice = Number(picked.ask);
    const unit = Number(picked.symbol.unit || 1);
    const contractPremium = Number((quantity * entryPrice * unit).toFixed(8));

    // Build position entry
    const orderId = `wpr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const position = {
        orderId,
        symbol: contractSymbol,
        underlying,
        direction,
        optionSide,
        quantity,
        entryPrice,
        unit,
        stake,
        premium: contractPremium,
        enteredAt: Date.now(),
        exitAt: Date.now() + (CONFIG.DURATION * 60 * 1000), // duration in ms
        mode: CONFIG.TRADE_MODE,
        delta: Number(picked.delta?.toFixed?.(4) ?? 0),
        wpr: signalDetails.wpr ?? a.wpr,
        prevWpr: signalDetails.prevWpr ?? a.prevWpr,
        status: 'OPEN',
    };

    // ── Place order (live) or simulate (paper) ──
    if (!CONFIG.PAPER_MODE) {
        try {
            const order = {
                symbol: contractSymbol,
                side: 'BUY',
                quantity,
                price: entryPrice,
                clientOrderId: orderId,
                timeInForce: 'FOK',
                newOrderRespType: 'RESULT',
            };
            const result = await BinanceClient.placeLimitOrder(order);
            if (result.status !== 'FILLED') {
                LOGGER.error(`[${underlying}] Order not filled: ${JSON.stringify(result)}`);
                return null;
            }
            position.orderId = result.orderId;
            position.entryPrice = Number(result.avgPrice || entryPrice);
            position.premium = Number((result.avgPrice * quantity * unit).toFixed(8));
            LOGGER.trade(`[${underlying}] ORDER FILLED: ${result.orderId} @ $${result.avgPrice} qty=${quantity}`);
        } catch (e) {
            LOGGER.error(`[${underlying}] Order failed: ${e.message}`);
            // Refund pool on failure
            a.investmentRemaining = Number((a.investmentRemaining + stake).toFixed(2));
            return null;
        }
    } else {
        LOGGER.trade(`[PAPER] [${underlying}] ${direction} ${contractSymbol} @ $${entryPrice} qty=${quantity} stake=$${stake} delta=${position.delta}`);
    }

    // ── Reserve resources ──
    a.activePositions.set(orderId, position);
    a.investmentRemaining = Number((a.investmentRemaining - stake).toFixed(2));
    a.currentStake = StakeCalculator.calculate(underlying, a.martingaleLevel, a.investmentRemaining);
    a.baseStake = StakeCalculator.getBaseStake(underlying, a.investmentRemaining);

    // ── Record trade in history ──
    TradeHistoryManager.ensureAssetDayEntry(TradeHistoryManager.getDateKey(), underlying);
    TradeHistoryManager.ensureOverallAssetEntry(underlying);

    // ── Notify ──
    await TelegramService.sendTradeAlert('OPEN', underlying, direction, stake, {
        contractSymbol,
        delta: position.delta,
    }, CONFIG.TRADE_MODE, {
        wpr: a.wpr,
        prevWpr: a.prevWpr,
    });

    LOGGER.trade(`[${underlying}] TRADE OPEN: ${direction} ${contractSymbol} L${a.martingaleLevel} stake=$${stake} pool=$${(a.investmentRemaining || 0).toFixed(2)}`);
    return position;
}

// ═══════════════════════════════════════════════════════════════════
// POSITION MONITOR — check open positions for TP/SL/expiry
// ═══════════════════════════════════════════════════════════════════
async function monitorPositions() {
    const exitCfg = CONFIG.EXIT_CONFIG || { takeProfitPercent: 100, stopLossPercent: 50, holdSeconds: 60 };
    for (const sym of CONFIG.ACTIVE_UNDERLYINGS) {
        const a = state.assets[sym];
        if (!a) continue;
        const positionsToSettle = [];

        for (const [orderId, pos] of a.activePositions) {
            if (pos.status !== 'OPEN') continue;

            const now = Date.now();
            const ageMs = now - pos.enteredAt;

            // Time expiry
            if (now >= pos.exitAt) {
                positionsToSettle.push({ pos, reason: 'TIME EXIT' });
                continue;
            }

            // TP/SL via mark price
            try {
                const marks = await BinanceClient.mark(pos.symbol);
                const mark = Array.isArray(marks) ? marks[0] : marks;
                const markPrice = Number(mark?.markPrice || 0);
                const entry = Number(pos.entryPrice || 0);
                if (Number.isFinite(markPrice) && entry > 0 && Number.isFinite(pos.quantity) && pos.unit > 0) {
                    const pnl = (markPrice - entry) * Number(pos.quantity) * Number(pos.unit);
                    const take = pos.premium * (exitCfg.takeProfitPercent / 100);
                    const stop = -pos.premium * (exitCfg.stopLossPercent / 100);
                    if (pnl >= take) { positionsToSettle.push({ pos, reason: 'TAKE-PROFIT' }); continue; }
                    if (pnl <= stop) { positionsToSettle.push({ pos, reason: 'STOP-LOSS' }); continue; }
                }
            } catch { /* no mark data — let time check handle it */ }
        }

        for (const { pos, reason } of positionsToSettle) {
            await settlePosition(sym, pos, reason);
        }
    }
}

async function settlePosition(symbol, position, reason) {
    const a = state.assets[symbol];
    if (!a) return;

    const pos = a.activePositions.get(position.orderId);
    if (!pos || pos.status !== 'OPEN') return;

    // Determine profit/loss
    let profit = 0;
    let settled = false;

    if (!CONFIG.PAPER_MODE) {
        try {
            const result = await BinanceClient.queryOrder({
                symbol: position.symbol,
                orderId: position.orderId,
            });
            const pnl = Number(result?.cummulativeQuotePnl || 0);
            profit = pnl;
            settled = true;
        } catch (e) {
            LOGGER.warn(`[${symbol}] Cannot query order ${position.orderId}: ${e.message}`);
        }
    }

    // Paper mode: use mark price vs entry to determine win/loss
    if (CONFIG.PAPER_MODE && !settled) {
        try {
            const marks = await BinanceClient.mark(position.symbol);
            const mark = Array.isArray(marks) ? marks[0] : marks;
            const markPrice = Number(mark?.markPrice || 0);
            const entry = Number(position.entryPrice || 0);
            if (Number.isFinite(markPrice) && entry > 0 && Number.isFinite(pos.quantity) && pos.unit > 0) {
                profit = (markPrice - entry) * Number(pos.quantity) * Number(pos.unit);
            } else {
                // Fallback: assume loss (premium lost) if cannot determine direction
                profit = -pos.stake;
            }
        } catch {
            // No market data — assume loss
            profit = -pos.stake;
        }
    }

    // Mark position as settled
    pos.status = 'SETTLED';
    pos.settledAt = Date.now();
    pos.profit = profit;

    // Credit back: WIN → stake + profit, LOSS → nothing (stake already deducted on open)
    if (profit >= 0) {
        a.investmentRemaining = Number((a.investmentRemaining + pos.stake + profit).toFixed(2));
        LOGGER.trade(`[${symbol}] WIN ${position.direction} ${position.symbol} +$${profit.toFixed(2)}`);
    } else {
        LOGGER.trade(`[${symbol}] LOSS ${position.direction} ${position.symbol} -$${Math.abs(profit).toFixed(2)}`);
    }

    // Remove from active positions
    a.activePositions.delete(position.orderId);

    // Record result via SessionManager (handles martingale, stats, Telegram)
    SessionManager.recordTradeResult(symbol, profit, position.direction, pos.stake);

    // Telegram alert (WIN/LOSS)
    await TelegramService.sendTradeAlert(
        profit >= 0 ? 'WIN' : 'LOSS',
        symbol,
        position.direction,
        pos.stake,
        { contractSymbol: position.symbol },
        CONFIG.TRADE_MODE,
        { profit },
    );
}

function stakeForPosition(pos) {
    return pos?.stake || 0;
}

// ═══════════════════════════════════════════════════════════════════
// RECONNECT RECONCILIATION — pick up positions after auth refresh
// ═══════════════════════════════════════════════════════════════════
async function reconcilePositions() {
    if (CONFIG.PAPER_MODE) return;
    LOGGER.info('Reconciling positions from exchange...');
    for (const sym of CONFIG.ACTIVE_UNDERLYINGS) {
        try {
            const positions = await BinanceClient.positions(sym);
            const posList = Array.isArray(positions) ? positions : (positions?.data ? positions.data : []);
            for (const p of posList) {
                if (Number(p.qty) > 0) {
                    LOGGER.info(`[${sym}] Active exchange position found: ${p.symbol} qty=${p.qty}`);
                    // Mark asset as in-trade (canTrade = false until position resolves)
                    const a = state.assets[sym];
                    if (a) a.canTrade = false;
                }
            }
        } catch (e) { LOGGER.warn(`[${sym}] Reconcile error: ${e.message}`); }
    }
    LOGGER.info('Reconciliation complete');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EVALUATION — candle close → WPR signal → executeBuy
// ═══════════════════════════════════════════════════════════════════
function evaluate(symbol, candleFetcher) {
    const a = state.assets[symbol];
    if (!a) return;

    // Fetch fresh 1m candles from Binance
    candleFetcher.fetch(symbol, '1m', CONFIG.CANDLES_TO_LOAD).then(candles => {
        if (!candles || candles.length < 2) return;

        // Store candle; detect new closed candle (new openTime)
        const lastCandle = candles[candles.length - 1];
        const lastOpenTime = lastCandle.openTime;
        const prevSeen = candleFetcher.getSeenTime(symbol);

        if (prevSeen !== null && lastOpenTime === prevSeen) return; // no new candle
        candleFetcher.setSeenTime(symbol, lastOpenTime);

        // Build closed candles (all candles except the current forming one)
        a.closedCandles = candles.slice(0, -1).map(c => ({
            open: c.open, high: c.high, low: c.low, close: c.close,
        }));
        a.currentFormingCandle = lastCandle;
        a.candlesLoaded = true;

        // Update WPR state (cross detection needs prev + current WPR on closed candles)
        const period = getAssetConfig(symbol).WPR_PERIOD ?? CONFIG.WPR_PERIOD;
        const series = TechnicalIndicators.calculateWPRSeries(a.closedCandles, period);
        if (series.length >= 2) {
            a.prevWpr = series[series.length - 2].value;
            a.wpr = series[series.length - 1].value;
            a.indicatorsReady = true;
        } else if (series.length === 1) {
            a.wpr = series[0].value;
            a.prevWpr = null;
            a.indicatorsReady = series[0].value > -100 && series[0].value < 0;
        }

        // Run signal analysis → execute
        const signal = SignalManager.analyze(symbol);
        if (signal.shouldTrade) {
            LOGGER.info(`[${symbol}] SIGNAL: ${signal.direction} — ${signal.reason}`);
            executeBuy(symbol, signal.direction, signal.details);
        }
    }).catch(e => LOGGER.error(`[EVAL] ${symbol}: ${e.message}`));
}

async function runEvaluationLoop(candleFetcher) {
    for (const symbol of CONFIG.ACTIVE_UNDERLYINGS) {
        const a = state.assets[symbol];
        if (!a || a.stopped || !a.canTrade || !a.candlesLoaded) continue;
        evaluate(symbol, candleFetcher);
    }
}

// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════
async function initializeBot() {
    // ── CONFIG validation ──
    if (!CONFIG.BINANCE_API_KEY || !CONFIG.BINANCE_SECRET) {
        LOGGER.error('BINANCE_API_KEY and BINANCE_SECRET are required in CONFIG');
        process.exit(1);
    }
    if (!CONFIG.ACTIVE_UNDERLYINGS || !CONFIG.ACTIVE_UNDERLYINGS.length) {
        LOGGER.error('ACTIVE_UNDERLYINGS is empty — at least one symbol required');
        process.exit(1);
    }
    if (!CONFIG.TRADE_MODE || !['wpr', 'prediction'].includes(CONFIG.TRADE_MODE)) {
        LOGGER.error(`Invalid TRADE_MODE: ${CONFIG.TRADE_MODE} — use 'wpr' or 'prediction'`);
        process.exit(1);
    }
    if (CONFIG.TRADE_MODE === 'prediction' && (!CONFIG.PREDICTION_PERCENTAGE || CONFIG.PREDICTION_PERCENTAGE < 50)) {
        LOGGER.error(`PREDICTION_PERCENTAGE must be >= 50 (got ${CONFIG.PREDICTION_PERCENTAGE})`);
        process.exit(1);
    }

    LOGGER.info('═══════════════════════════════════════════════════════');
    LOGGER.info('Binance Bot v2 — INITIALIZING');
    LOGGER.info(`Mode: ${CONFIG.TRADE_MODE.toUpperCase()}${CONFIG.TRADE_MODE === 'prediction' ? ' (target ' + CONFIG.PREDICTION_PERCENTAGE + '%)' : ''}`);
    LOGGER.info(`Underlyings: ${CONFIG.ACTIVE_UNDERLYINGS.join(', ')}`);
    LOGGER.info(`Paper Mode: ${CONFIG.PAPER_MODE ? 'ON' : 'OFF'}`);
    LOGGER.info('═══════════════════════════════════════════════════════');

    // ── Initialize assets ──
    CONFIG.ACTIVE_UNDERLYINGS.forEach(symbol => {
        const cfg = getAssetConfig(symbol);
        state.assets[symbol] = {
            candles: [],
            closedCandles: [],
            currentFormingCandle: null,
            lastProcessedCandleOpenTime: null,
            candlesLoaded: false,
            wpr: null,
            prevWpr: null,
            buyFlagActive: false,
            sellFlagActive: false,
            indicatorsReady: false,
            lastTradeDirection: null,
            lastTradeWasWin: null,
            currentStake: cfg.INITIAL_STAKE,
            baseStake: cfg.INITIAL_STAKE,
            martingaleLevel: 0,
            investmentRemaining: cfg.INVESTMENT_AMOUNT,
            canTrade: false,
            stopped: false,
            stoppedReason: null,
            consecutiveWins: 0,
            consecutiveLosses: 0,
            tradesCount: 0,
            winsCount: 0,
            lossesCount: 0,
            profit: 0,
            loss: 0,
            netPL: 0,
            activePositions: new Map(),
            lastPredictionSelection: null,
            lastProcessedCandleOpenTime: 0,
        };
        LOGGER.info(`Initialized ${symbol}: stake $${cfg.INITIAL_STAKE}, pool $${cfg.INVESTMENT_AMOUNT}`);
    });

    // ── Binance client ──
    BinanceClient = new BinanceOptionsClient({
        apiKey: CONFIG.BINANCE_API_KEY,
        apiSecret: CONFIG.BINANCE_SECRET,
        baseUrl: CONFIG.BASE_URL,
    });

    // OptionsUniverse config fields must match lib options-universe.js:
    // underlyings, minDaysToExpiry, maxDaysToExpiry, maxSpreadPercent, maxContractsPerSide, targetDelta
    Universe = new OptionsUniverse(BinanceClient, {
        underlyings: CONFIG.ACTIVE_UNDERLYINGS,
        minDaysToExpiry: 1,
        maxDaysToExpiry: CONFIG.MAX_EXPIRY_DAYS,
        maxSpreadPercent: CONFIG.MAX_SPREAD_PCT,
        maxContractsPerSide: 24,
        targetDelta: (CONFIG.PREDICTION_PERCENTAGE / 100) || 0.7,
    });

    // Risk manager config: maxDailyLossUsdt, maxPremiumUsdt, maxOpenPositions, paperMode
    // martingale: { initialStake, multiplier, maxLevel, extraLevelMultipliers, continueExtraLevels, investmentAmount }
    Risk = new OptionsRiskManager({
        maxDailyLossUsdt: CONFIG.MAX_DAILY_LOSS_USDT,
        maxPremiumUsdt: CONFIG.MAX_PREMIUM_USDT,
        maxOpenPositions: CONFIG.MAX_TOTAL_POSITIONS,
        paperMode: CONFIG.PAPER_MODE,
        martingale: {
            initialStake: DEFAULT_ASSET_CONFIG.INITIAL_STAKE,
            multiplier: DEFAULT_ASSET_CONFIG.MARTINGALE_MULTIPLIER,
            maxLevel: DEFAULT_ASSET_CONFIG.MAX_MARTINGALE_LEVEL,
            extraLevelMultipliers: DEFAULT_ASSET_CONFIG.EXTRA_LEVEL_MULTIPLIERS,
            continueExtraLevels: DEFAULT_ASSET_CONFIG.CONTINUE_EXTRA_LEVELS,
            investmentAmount: DEFAULT_ASSET_CONFIG.INVESTMENT_AMOUNT,
        },
    });

    // ── Telegram notifier ──
    Notifier = new TelegramNotifier({
        token: CONFIG.TELEGRAM_BOT_TOKEN,
        chatId: CONFIG.TELEGRAM_CHAT_ID,
        enabled: CONFIG.TELEGRAM_ENABLED,
    });

    // ── Candle fetcher ──
    const candleFetcher = new BinanceCandleFetcher(BinanceClient, CONFIG.SPOT_BASE_URL);

    // ── Load state ──
    const stateLoaded = StatePersistence.loadState();
    LOGGER.info(stateLoaded ? 'Restored state from file' : 'Starting fresh session');

    // ── Start auto-save ──
    if (!autoSaveId) { StatePersistence.startAutoSave(); autoSaveId = setInterval(() => { if (state.isAuthorized) StatePersistence.saveState(); }, STATE_SAVE_INTERVAL); }

    // ── Load trade history ──
    tradeHistory = TradeHistoryManager.loadHistory();

    // ── Verify connectivity ──
    if (!CONFIG.PAPER_MODE) {
        LOGGER.info('Verifying Binance connectivity...');
        try {
            await BinanceClient.syncTime();
            LOGGER.info('Binance API reachable — time synced');
            state.isConnected = true;
            state.isAuthorized = true;
        } catch (e) {
            LOGGER.error(`Binance connection failed: ${e.message} — running in offline/display mode`);
            state.isConnected = false;
        }
    } else {
        LOGGER.info('Paper mode — skipping Binance auth (simulated)');
        state.isConnected = true;
        state.isAuthorized = true;
    }

    // ── Telegram startup ──
    await TelegramService.sendStartupMessage();

    // ── Initial candle load (so first evaluation cycle has data) ──
    LOGGER.info('Loading initial candles...');
    await Promise.all(CONFIG.ACTIVE_UNDERLYINGS.map(async (sym) => {
        const candles = await candleFetcher.fetch(sym, '1m', CONFIG.CANDLES_TO_LOAD);
        if (candles && candles.length >= 2) {
            const a = state.assets[sym];
            a.closedCandles = candles.slice(0, -1).map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close }));
            a.currentFormingCandle = candles[candles.length - 1];
            a.candlesLoaded = true;
            a.canTrade = true; // assets ready for trading
            const period = getAssetConfig(sym).WPR_PERIOD ?? CONFIG.WPR_PERIOD;
            const series = TechnicalIndicators.calculateWPRSeries(a.closedCandles, period);
            if (series.length >= 2) {
                a.prevWpr = series[series.length - 2].value;
                a.wpr = series[series.length - 1].value;
                a.indicatorsReady = true;
            }
            LOGGER.info(`[${sym}] Loaded ${candles.length} candles, WPR ready`);
        }
    }));

    // ── Timers ──
    TelegramService.startHourlyTimer();
    TelegramService.startDailyTimer();

    // ── Main evaluation loop (POLL_SECONDS) ──
    mainIntervalId = setInterval(() => {
        runEvaluationLoop(candleFetcher).catch(e => LOGGER.error(`[EVAL] ${e.message}`));
    }, CONFIG.POLL_SECONDS * 1000);

    // ── Initial evaluation after candle load settles ──
    setTimeout(() => { runEvaluationLoop(candleFetcher).catch(e => LOGGER.error(`[EVAL] ${e.message}`)); }, 3000);

    // ── Position monitor (every 30s) ──
    setInterval(() => { monitorPositions().catch(e => LOGGER.error(`[MONITOR] ${e.message}`)); }, 30000);

    // ── Status display every 60s ──
    statusIntervalId = setInterval(() => {
        if (!state.isAuthorized) return;
        const now = new Date();
        let line = `\u{1f680} [${getGMTTime()}] Binance Bot | Mode: ${CONFIG.TRADE_MODE.toUpperCase()}`;
        if (CONFIG.TRADE_MODE === 'prediction') line += ` (target ${CONFIG.PREDICTION_PERCENTAGE}%)`;
        line += ` | Pools: $${state.capital.toFixed(2)}`;
        line += ` | ${CONFIG.ACTIVE_UNDERLYINGS.map(s => {
            const a = state.assets[s];
            return `${s}: L${a?.martingaleLevel || 0} $${(a?.investmentRemaining || 0).toFixed(2)} WPR:${a?.wpr?.toFixed?.(1) ?? 'n/a'}`;
        }).join(' | ')}`;
        console.log(line);
    }, 60000);

    LOGGER.info('Binance Bot v2 — INITIALIZED');
    console.log('\n' + '═'.repeat(55));
    console.log('  Bot running. Press Ctrl+C to stop.');
    console.log('═'.repeat(55) + '\n');
}


// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
initializeBot().catch(err => { LOGGER.error(`FATAL: ${err.message}`); process.exit(1); });

process.on('SIGINT', () => {
    LOGGER.info('SIGINT received — stopping...');
    TelegramService.sendStoppedMessage().catch(() => {});
    if (mainIntervalId) clearInterval(mainIntervalId);
    if (statusIntervalId) clearInterval(statusIntervalId);
    TelegramService.clearTimers();
    try { StatePersistence.saveState(); } catch {}
    setTimeout(() => process.exit(0), 1000);
});
process.on('SIGTERM', () => {
    LOGGER.info('SIGTERM received — stopping...');
    TelegramService.sendStoppedMessage().catch(() => {});
    if (mainIntervalId) clearInterval(mainIntervalId);
    if (statusIntervalId) clearInterval(statusIntervalId);
    TelegramService.clearTimers();
    try { StatePersistence.saveState(); } catch {}
    setTimeout(() => process.exit(0), 1000);
});
process.on('uncaughtException', (err) => { LOGGER.error(`UNCAUGHT: ${err.message}
${err.stack}`); try { StatePersistence.saveState(); } catch {} });
process.on('unhandledRejection', (reason) => { LOGGER.error(`UNHANDLED: ${reason}`); try { StatePersistence.saveState(); } catch {} });
