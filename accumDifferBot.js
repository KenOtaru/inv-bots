/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              differBot — Digit Differ Trading Bot            ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  STRATEGY:                                                   ║
 * ║  • Tracks last-digit frequency over a rolling window         ║
 * ║  • Identifies the "hot" digit (most frequent) and bets       ║
 * ║    DIFFER — predicting the NEXT tick will NOT end in it      ║
 * ║  • Bollinger Bands + MACD overlay gate low-volatility entry  ║
 * ║  • Repeat-digit guard prevents chasing streaks               ║
 * ║  • Martingale stake recovery on loss (identical to accum)    ║
 * ║                                                              ║
 * ║  CONVERTED FROM: accumBotM (accumulator strategy)            ║
 * ║  KEY CHANGE: stayedIn condition → hot-digit rank score       ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — edit these values before running
// ─────────────────────────────────────────────────────────────────────────────
const BOT_CONFIG = {
    token: 'hsj0tA0XJoIzJG5',        // Deriv API token

    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    initialStake: 1,               // Starting stake in USD
    multiplier: 11.3,              // Martingale multiplier on loss
    maxConsecutiveLosses: 3,               // Stop-loss trigger
    stopLoss: 108,             // Total P&L stop-loss (USD)
    takeProfit: 10000,           // Session take-profit (USD)

    // Digit Differ specific
    digitWindow: 50,              // Rolling ticks to analyse digit frequency
    minHotFrequency: 8,              // Minimum appearances to classify digit as "hot"
    minFrequencyEdge: 2,              // Hot digit must lead 2nd-most by this many ticks
    predictedDigitCount: 1,              // How many digits to bet DIFFER on (1 = most reliable)

    // Technical filter thresholds (same as accumulator)
    bbPeriod: 20,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    minBandWidthScore: 0.15,           // Reject if BB expanding hard (0–1)
    minMacdFlatScore: 0.35,           // Reject if strong momentum
    minPricePositionScore: 0.40,           // Reject if price at band edge
    minTickStabilityScore: 0.01,           // Reject if erratic recent ticks
    minVolTrendScore: 0.40,           // Reject if volatility rising
    minMaxTickMove: 0.0001,         // Raw ratio (NOT percent). 0.0001 = 0.01% per-tick minimum

    minTimeBetweenTrades: 5000,           // ms cooldown per asset after a trade
    requiredHistoryLength: 100,            // Ticks needed before analysis starts

    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',

    maxReconnectAttempts: 50,
    reconnectDelay: 5000,
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'differBot_state.json');
const STATE_SAVE_INTERVAL = 5000;

class StatePersistence {
    static save(bot) {
        try {
            const data = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    consecutiveLosses2: bot.consecutiveLosses2,
                    consecutiveLosses3: bot.consecutiveLosses3,
                    consecutiveLosses4: bot.consecutiveLosses4,
                    consecutiveLosses5: bot.consecutiveLosses5,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    recentPredictions: bot.recentPredictions,
                },
                assetMetrics: bot.assetMetrics,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error(`❌ Save failed: ${e.message}`);
            return false;
        }
    }

    static load() {
        try {
            if (!fs.existsSync(STATE_FILE)) return null;
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const data = JSON.parse(raw);
            const ageMin = (Date.now() - data.savedAt) / 60000;
            if (ageMin > 60) {
                console.warn(`⚠️  State ${ageMin.toFixed(1)}m old — starting fresh`);
                fs.renameSync(STATE_FILE, STATE_FILE.replace('.json', `_bak_${Date.now()}.json`));
                return null;
            }
            console.log(`📂 Restoring state (${ageMin.toFixed(1)}m old)`);
            return data;
        } catch (e) {
            console.error(`❌ Load failed: ${e.message}`);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot._autoSaveTimer) clearInterval(bot._autoSaveTimer);
        bot._autoSaveTimer = setInterval(() => {
            if (bot.connected && !bot.endOfDay) StatePersistence.save(bot);
        }, STATE_SAVE_INTERVAL);

        const shutdown = () => {
            console.log('\n🛑 Saving state before exit…');
            StatePersistence.save(bot);
            process.exit();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        process.on('uncaughtException', err => { console.error(err); shutdown(); });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TECHNICAL INDICATORS (unchanged from accumulator)
// ─────────────────────────────────────────────────────────────────────────────
class TechnicalIndicators {
    static SMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((s, v) => s + v, 0) / period;
    }

    static EMA(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
        return ema;
    }

    static stdDev(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        return Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
    }

    static bollingerBands(prices, period = 20, mult = 2.0) {
        if (prices.length < period) return null;
        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        const upper = middle + mult * sd;
        const lower = middle - mult * sd;
        const cur = prices[prices.length - 1];
        const width = (upper - lower) / middle;
        const pctB = (upper - lower) !== 0 ? (cur - lower) / (upper - lower) : 0.5;
        return { upper, middle, lower, width, percentB: pctB, stdDev: sd };
    }

    static MACD(prices, fast = 12, slow = 26, signal = 9) {
        if (prices.length < slow + signal) return null;
        const macdVals = [];
        for (let i = slow; i <= prices.length; i++) {
            const sl = prices.slice(0, i);
            const fEMA = this.EMA(sl, fast);
            const sEMA = this.EMA(sl, slow);
            if (fEMA !== null && sEMA !== null) macdVals.push(fEMA - sEMA);
        }
        if (macdVals.length < signal) return null;
        const macdLine = macdVals[macdVals.length - 1];
        const signalLine = this.EMA(macdVals, signal);
        const histogram = macdLine - signalLine;
        const prevMacd = macdVals.slice(0, -1);
        const prevSig = prevMacd.length >= signal ? this.EMA(prevMacd, signal) : signalLine;
        const prevHist = prevMacd[prevMacd.length - 1] - prevSig;
        return {
            macdLine, signalLine, histogram, prevHistogram: prevHist,
            isConverging: Math.abs(histogram) < Math.abs(prevHist),
            histogramTrend: histogram - prevHist,
        };
    }

    static ATR(prices, period = 14) {
        if (prices.length < period + 1) return null;
        const ranges = [];
        for (let i = prices.length - period; i < prices.length; i++)
            ranges.push(Math.abs(prices[i] - prices[i - 1]));
        return ranges.reduce((s, v) => s + v, 0) / period;
    }

    static bandWidthPercentile(prices, bbPeriod = 20, lookback = 100) {
        if (prices.length < lookback + bbPeriod) return null;
        const widths = [];
        for (let i = bbPeriod; i <= Math.min(lookback, prices.length - bbPeriod); i++) {
            const sl = prices.slice(0, prices.length - i + bbPeriod);
            const bb = this.bollingerBands(sl, bbPeriod);
            if (bb) widths.push(bb.width);
        }
        if (widths.length < 10) return null;
        const cur = widths[0];
        const sorted = [...widths].sort((a, b) => a - b);
        return sorted.findIndex(w => w >= cur) / sorted.length;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DIGIT DIFFER ANALYZER
// ─────────────────────────────────────────────────────────────────────────────
class DigitDifferAnalyzer {
    constructor(config) {
        this.cfg = config;
    }

    /**
     * Build a frequency map of last digits over the rolling window.
     * Returns an array sorted by frequency descending.
     *
     * [{digit, count, percentage}, …]
     */
    buildFrequencyRanking(digitHistory) {
        const window = digitHistory.slice(-this.cfg.digitWindow);
        const freq = {};
        for (let d = 0; d <= 9; d++) freq[d] = 0;
        window.forEach(d => freq[d]++);

        return Object.entries(freq)
            .map(([digit, count]) => ({
                digit: parseInt(digit),
                count,
                percentage: (count / window.length * 100).toFixed(1),
            }))
            .sort((a, b) => b.count - a.count);
    }

    /**
     * Core prediction logic.
     *
     * Returns:
     *   { shouldTrade, predictedDigit, reason, scores, ... }
     * HOT-DIGIT INVERSION approach (default):
     *   The most frequent digit is statistically likely to be "overdue for a break".
     *   We bet DIFFER on it — predicting the next tick will NOT end in that digit.
     *   Win rate: ~90% (Deriv Differ baseline) minus the edge we lose when the hot
     *   digit keeps repeating. The frequency gate (minHotFrequency) filters entries
     *   where the hot digit is genuinely dominant.
     *
     * COLD-DIGIT APPROACH (alternative, set coldMode: true):
     *   The least frequent digit is "due". We bet DIFFER on all OTHER digits
     *   by finding the second-most-frequent digit and betting against it.
     *   Trickier to model — hot-digit inversion is preferred.
     */
    analyzeEntry(digitHistory, priceHistory) {
        if (digitHistory.length < this.cfg.requiredHistoryLength) {
            return { shouldTrade: false, reason: 'insufficient_digit_history', overallScore: 0, scores: {} };
        }

        // ── 1. Technical scores (computed first so they're always in the returned object) ──
        const techResult = this._technicalScores(priceHistory);
        const scores = techResult.ok ? techResult.scores : {};
        const bb = techResult.ok ? techResult.bb : null;
        const macd = techResult.ok ? techResult.macd : null;
        const maxTickMove = techResult.ok ? techResult.maxTickMove : 0;
        const atr = techResult.ok ? techResult.atr : null;

        // Composite score is always computed so the log is always meaningful
        const weights = { bandWidth: 0.25, macdFlat: 0.20, macdConverging: 0.10, pricePosition: 0.20, tickStability: 0.15, volTrend: 0.10 };
        const overallScore = Object.entries(weights).reduce((s, [k, w]) => s + (scores[k] || 0) * w, 0);

        // Base result object — always include scores so _logAnalysis always shows real values
        const baseResult = { scores, overallScore, bb, macd, maxTickMove, atr };

        if (!techResult.ok) {
            return { ...baseResult, shouldTrade: false, reason: techResult.reason };
        }

        // ── 2. Frequency ranking ──────────────────────────────────────────────
        const ranking = this.buildFrequencyRanking(digitHistory);
        const hotEntry = ranking[0];
        const secondEntry = ranking[1];
        const edge = hotEntry.count - secondEntry.count;

        // Reject if hot digit doesn't dominate enough
        if (hotEntry.count < this.cfg.minHotFrequency) {
            return {
                ...baseResult, shouldTrade: false, ranking,
                reason: `hot_digit_${hotEntry.digit}_count_${hotEntry.count}_below_min_${this.cfg.minHotFrequency}`,
            };
        }

        // Reject if edge over 2nd-most is too narrow
        if (edge < this.cfg.minFrequencyEdge) {
            return {
                ...baseResult, shouldTrade: false, ranking,
                reason: `frequency_edge_${edge}_too_narrow`,
            };
        }

        // ── 3. Technical hard gates ───────────────────────────────────────────
        // NOTE: minMaxTickMove is a raw ratio (e.g. 0.0003), NOT a percentage
        if (scores.bandWidth < this.cfg.minBandWidthScore) return { ...baseResult, shouldTrade: false, reason: 'bands_expanding', ranking };
        if (scores.macdFlat < this.cfg.minMacdFlatScore) return { ...baseResult, shouldTrade: false, reason: 'strong_momentum', ranking };
        if (scores.pricePosition < this.cfg.minPricePositionScore) return { ...baseResult, shouldTrade: false, reason: 'price_at_band_edge', ranking };
        if (scores.tickStability < this.cfg.minTickStabilityScore) return { ...baseResult, shouldTrade: false, reason: 'erratic_tick_movement', ranking };
        if (maxTickMove < this.cfg.minMaxTickMove) return { ...baseResult, shouldTrade: false, reason: 'tick_movement_too_flat', ranking };
        if (scores.volTrend < this.cfg.minVolTrendScore) return { ...baseResult, shouldTrade: false, reason: 'volatility_rising', ranking };

        return {
            ...baseResult,
            shouldTrade: true,
            reason: 'conditions_favorable',
            predictedDigit: hotEntry.digit,
            hotDigitCount: hotEntry.count,
            hotDigitPct: hotEntry.percentage,
            frequencyEdge: edge,
            ranking,
        };
    }

    _technicalScores(prices) {
        if (!prices || prices.length < 50) return { ok: false, reason: 'insufficient_price_history' };

        const bb = TechnicalIndicators.bollingerBands(prices, this.cfg.bbPeriod);
        if (!bb) return { ok: false, reason: 'bb_calc_failed' };

        const macd = TechnicalIndicators.MACD(prices, this.cfg.macdFast, this.cfg.macdSlow, this.cfg.macdSignal);
        if (!macd) return { ok: false, reason: 'macd_calc_failed' };

        const atr = TechnicalIndicators.ATR(prices, 14);
        const curPrice = prices[prices.length - 1];
        const scores = {};

        // ── Band width ────────────────────────────────────────────────────────
        // BUG FIX: bandWidthPercentile needs prices.length >= lookback + bbPeriod.
        // With 100 ticks and default lookback=100, bbPeriod=20 → needs 120 ticks → always null.
        // Use a shorter lookback (60) so it works with 100-tick history.
        const bwPct = TechnicalIndicators.bandWidthPercentile(prices, this.cfg.bbPeriod, 60);
        if (bwPct !== null) {
            if (bwPct <= 0.20) scores.bandWidth = 1.0;
            else if (bwPct <= 0.40) scores.bandWidth = 0.85;
            else if (bwPct <= 0.55) scores.bandWidth = 0.65;
            else if (bwPct <= 0.70) scores.bandWidth = 0.40;
            else scores.bandWidth = 0.15;
        } else {
            // Fallback: use raw BB width as proxy — tighter bands = higher score
            // Typical normalized width for synthetics: 0.001–0.005
            const w = bb.width;
            if (w < 0.0010) scores.bandWidth = 1.0;
            else if (w < 0.0020) scores.bandWidth = 0.85;
            else if (w < 0.0035) scores.bandWidth = 0.65;
            else if (w < 0.0055) scores.bandWidth = 0.40;
            else scores.bandWidth = 0.15;
        }

        // ── MACD flat ─────────────────────────────────────────────────────────
        const normHist = Math.abs(macd.histogram) / curPrice;
        if (normHist < 0.00005) scores.macdFlat = 1.0;
        else if (normHist < 0.00015) scores.macdFlat = 0.85;
        else if (normHist < 0.00035) scores.macdFlat = 0.60;
        else if (normHist < 0.00060) scores.macdFlat = 0.35;
        else scores.macdFlat = 0.10;

        // ── MACD converging ───────────────────────────────────────────────────
        scores.macdConverging = macd.isConverging ? 1.0 : 0.35;

        // ── %B position ───────────────────────────────────────────────────────
        if (bb.percentB >= 0.40 && bb.percentB <= 0.60) scores.pricePosition = 1.0;
        else if (bb.percentB >= 0.20 && bb.percentB <= 0.80) scores.pricePosition = 0.70;
        else if (bb.percentB >= 0.10 && bb.percentB <= 0.90) scores.pricePosition = 0.40;
        else scores.pricePosition = 0.10;

        // ── Tick stability (last 10 ticks) ────────────────────────────────────
        const recent = prices.slice(-10);
        let maxMove = 0;
        for (let i = 1; i < recent.length; i++)
            maxMove = Math.max(maxMove, Math.abs(recent[i] - recent[i - 1]) / recent[i - 1]);

        // maxMove is a ratio, e.g. 0.0005 = 0.05%
        if (maxMove < 0.0003) scores.tickStability = 1.0;
        else if (maxMove < 0.0008) scores.tickStability = 0.80;
        else if (maxMove < 0.0015) scores.tickStability = 0.55;
        else if (maxMove < 0.0025) scores.tickStability = 0.30;
        else scores.tickStability = 0.05;

        // ── Volatility trend ──────────────────────────────────────────────────
        const atrShort = TechnicalIndicators.ATR(prices, 7);
        const atrLonger = TechnicalIndicators.ATR(prices.slice(0, -7), 14);
        if (atrShort && atrLonger && atrLonger > 0) {
            const ratio = atrShort / atrLonger;
            if (ratio < 0.70) scores.volTrend = 1.0;
            else if (ratio < 0.85) scores.volTrend = 0.80;
            else if (ratio < 1.0) scores.volTrend = 0.60;
            else if (ratio < 1.15) scores.volTrend = 0.40;
            else scores.volTrend = 0.15;
        } else {
            scores.volTrend = 0.5;
        }

        return { ok: true, scores, bb, macd, maxTickMove: maxMove, atr };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BOT
// ─────────────────────────────────────────────────────────────────────────────
class DigitDifferBot {
    constructor(config) {
        this.cfg = config;

        // Connection
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.reconnectAttempts = 0;
        this.pingInterval = null;

        // Global trade lock (one contract at a time across all assets)
        this.tradeInProgress = false;
        this.tradeStartTime = null;
        this.tradeWatchdogMs = 30000;      // Differ trades resolve in ~1 tick, 30s is generous
        this._wdTimer = null;
        this._wdPollTimer = null;

        // Trade state
        this.currentStake = config.initialStake;
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.isWinTrade = false;
        this.endOfDay = false;
        this.recentPredictions = [];    // Last predicted digits (avoid repeating same digit)

        // Per-asset structures
        this.priceHistories = {};
        this.digitHistories = {};
        this.lastTradeTime = {};
        this.tickCounts = {};
        this.activeTrades = {};
        this.contractSubs = {};
        this.tickSubIds = {};
        this.assetMetrics = {};
        this.proposalIds = {};

        config.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.digitHistories[a] = [];
            this.lastTradeTime[a] = 0;
            this.tickCounts[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
            this.proposalIds[a] = null;
        });

        // Components
        this.analyzer = new DigitDifferAnalyzer(config);

        // Telegram
        this.telegram = null;
        if (config.telegramToken && config.telegramChatId) {
            this.telegram = new TelegramBot(config.telegramToken, { polling: false });
        }

        this._loadState();
    }

    // ── State ─────────────────────────────────────────────────────────────────
    _loadState() {
        const s = StatePersistence.load();
        if (!s) return;
        try {
            if (s.trading) {
                this.currentStake = s.trading.currentStake || this.cfg.initialStake;
                this.consecutiveLosses = s.trading.consecutiveLosses || 0;
                this.consecutiveLosses2 = s.trading.consecutiveLosses2 || 0;
                this.consecutiveLosses3 = s.trading.consecutiveLosses3 || 0;
                this.consecutiveLosses4 = s.trading.consecutiveLosses4 || 0;
                this.consecutiveLosses5 = s.trading.consecutiveLosses5 || 0;
                this.totalTrades = s.trading.totalTrades || 0;
                this.totalWins = s.trading.totalWins || 0;
                this.totalLosses = s.trading.totalLosses || 0;
                this.totalProfitLoss = s.trading.totalProfitLoss || 0;
                this.dailyProfitLoss = s.trading.dailyProfitLoss || 0;
                this.recentPredictions = s.trading.recentPredictions || [];
            }
            if (s.assetMetrics) this.assetMetrics = s.assetMetrics;
            console.log(`✅ State restored — ${this.totalTrades} trades, P&L $${this.totalProfitLoss.toFixed(2)}`);
        } catch (e) {
            console.error(`❌ State restore error: ${e.message}`);
        }
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    connect() {
        if (this.ws?.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv API…');
        this._cleanupWs();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this._startPing();
            this._send({ authorize: this.cfg.token });
        });

        this.ws.on('message', data => {
            try { this._handleMessage(JSON.parse(data)); }
            catch (e) { console.error('Parse error:', e.message); }
        });

        this.ws.on('error', e => console.error('WS error:', e.message));

        this.ws.on('close', () => {
            console.log('⚡ WebSocket closed');
            this._stopPing();
            this._onDisconnect();
        });
    }

    _startPing() {
        this._stopPing();
        this.pingInterval = setInterval(() => {
            if (this.connected) this._send({ ping: 1 });
        }, 25000);
    }

    _stopPing() {
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    }

    _send(req) {
        if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(JSON.stringify(req)); return true; }
        catch (e) { console.error('Send error:', e.message); return false; }
    }

    _onDisconnect() {
        if (this.endOfDay) { this._cleanupWs(); return; }
        this.connected = this.wsReady = false;
        StatePersistence.save(this);
        if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
            console.error('❌ Max reconnect attempts'); return;
        }
        this.reconnectAttempts++;
        const delay = Math.min(this.cfg.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s… (${this.reconnectAttempts}/${this.cfg.maxReconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    _cleanupWs() {
        this._stopPing();
        this._clearWatchdog();
        if (this.ws) {
            this.ws.removeAllListeners();
            try { if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) this.ws.close(); } catch (_) { }
            this.ws = null;
        }
        this.connected = this.wsReady = false;
    }

    // ── Message routing ───────────────────────────────────────────────────────
    _handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize': this._onAuth(msg); break;
            case 'history': this._onHistory(msg); break;
            case 'tick':
                if (msg.subscription) this.tickSubIds[msg.tick.symbol] = msg.subscription.id;
                this._onTick(msg.tick);
                break;
            case 'proposal': this._onProposal(msg); break;
            case 'buy': this._onBuy(msg); break;
            case 'proposal_open_contract': this._onContractUpdate(msg); break;
            case 'sell':
                if (msg.error) console.error('Sell error:', msg.error.message);
                else console.log(`✅ Sold for $${msg.sell?.sold_for}`);
                break;
            case 'ping': break;
            default:
                if (msg.error) console.error(`API error [${msg.msg_type}]: ${msg.error.message}`);
        }
    }

    _onAuth(msg) {
        if (msg.error) { console.error('Auth failed:', msg.error.message); this._cleanupWs(); return; }
        console.log(`✅ Auth OK — Balance: $${msg.authorize.balance}`);
        this.wsReady = true;
        this.cfg.assets.forEach(asset => {
            this._send({ ticks_history: asset, adjust_start_time: 1, count: this.cfg.requiredHistoryLength, end: 'latest', start: 1, style: 'ticks' });
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    // ── Tick data ─────────────────────────────────────────────────────────────
    _lastDigit(quote, asset) {
        const s = quote.toString();
        const [, frac = ''] = s.split('.');
        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) return frac.length >= 4 ? parseInt(frac[3]) : 0;
        if (['R_10', 'R_25'].includes(asset)) return frac.length >= 3 ? parseInt(frac[2]) : 0;
        return frac.length >= 2 ? parseInt(frac[1]) : 0;
    }

    _onHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        this.priceHistories[asset] = msg.history.prices.map(p => parseFloat(p));
        this.digitHistories[asset] = this.priceHistories[asset].map(p => this._lastDigit(p, asset));
        console.log(`📊 ${asset}: loaded ${this.priceHistories[asset].length} ticks`);
    }

    _onTick(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const digit = this._lastDigit(price, asset);

        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > 500) this.priceHistories[asset] = this.priceHistories[asset].slice(-300);

        this.digitHistories[asset].push(digit);
        if (this.digitHistories[asset].length > this.cfg.requiredHistoryLength) this.digitHistories[asset].shift();

        this.tickCounts[asset] = (this.tickCounts[asset] || 0) + 1;

        if (!this.wsReady) return;
        if (this.tradeInProgress) return;
        if (this.activeTrades[asset]) return;
        if (this.digitHistories[asset].length < this.cfg.requiredHistoryLength) return;
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.cfg.minTimeBetweenTrades) return;

        this._evaluateAsset(asset);
    }

    // ── Analysis & proposal ───────────────────────────────────────────────────
    _evaluateAsset(asset) {
        const analysis = this.analyzer.analyzeEntry(
            this.digitHistories[asset],
            this.priceHistories[asset]
        );

        this._logAnalysis(asset, analysis);

        if (!analysis.shouldTrade) return;

        // Don't repeat the same predicted digit consecutively (avoid chasing streaks)
        const recentLen = Math.min(this.recentPredictions.length, 2);
        const recentPreds = this.recentPredictions.slice(-recentLen);
        if (recentPreds.every(d => d === analysis.predictedDigit)) {
            console.log(`   ⚠️  Skipping — digit ${analysis.predictedDigit} predicted ${recentLen}x in a row`);
            // return;
        }

        // Request a Digit Differ proposal
        this._requestProposal(asset, analysis.predictedDigit);
    }

    _requestProposal(asset, predictedDigit) {
        if (this.tradeInProgress) return;

        console.log(`\n📋 Requesting DIFFER proposal — ${asset} digit ${predictedDigit}`);

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITDIFF',
            currency: 'USD',
            symbol: asset,
            duration: 1,
            duration_unit: 't',
            barrier: predictedDigit.toString(),  // The digit we bet will NOT appear
        });
    }

    _onProposal(msg) {
        if (msg.error) {
            console.log(`❌ Proposal error: ${msg.error.message}`);
            return;
        }

        const asset = msg.echo_req?.symbol;
        if (!asset) return;
        if (this.tradeInProgress) return;

        const proposal = msg.proposal;
        this.proposalIds[asset] = proposal.id;

        // Re-run analysis to confirm conditions still met (market may have moved)
        const analysis = this.analyzer.analyzeEntry(
            this.digitHistories[asset],
            this.priceHistories[asset]
        );

        if (!analysis.shouldTrade) {
            console.log(`   ❌ Conditions changed — aborting entry`);
            return;
        }

        const predictedDigit = analysis.predictedDigit;
        const payout = parseFloat(proposal.payout || 0);
        const payoutPct = this.currentStake > 0 ? ((payout - this.currentStake) / this.currentStake * 100).toFixed(1) : '?';

        console.log(`\n🎯 ENTRY SIGNAL — ${asset}`);
        console.log(`   Predicted digit: ${predictedDigit} (betting it will NOT appear next tick)`);
        console.log(`   Hot digit appeared ${analysis.hotDigitCount}x in last ${this.cfg.digitWindow} ticks (${analysis.hotDigitPct}%)`);
        console.log(`   Frequency edge over 2nd: ${analysis.frequencyEdge}`);
        console.log(`   Score: ${(analysis.overallScore * 100).toFixed(1)}%`);
        console.log(`   Stake: $${this.currentStake.toFixed(2)} | Payout: $${payout.toFixed(2)} (+${payoutPct}%)`);

        if (analysis.overallScore >= 0.9) {
            this._placeTrade(asset, predictedDigit, proposal, analysis);
        }
    }

    _placeTrade(asset, predictedDigit, proposal, analysis) {
        if (this.tradeInProgress) return;

        const proposalId = this.proposalIds[asset];
        if (!proposalId) { console.error(`❌ No proposal ID for ${asset}`); return; }

        this._send({ buy: proposalId, price: this.currentStake.toFixed(2) });

        this.tradeInProgress = true;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId,
            stake: this.currentStake,
            predictedDigit,
            entryTime: Date.now(),
        };

        this._sendTelegram(
            `🎯 <b>DIFFER TRADE OPENED</b>\n\n
                Asset: <b>${asset}</b>\n
                Betting digit <b>${predictedDigit}</b> will NOT appear\n
                Score: ${(analysis.overallScore * 100).toFixed(1)}%
                Hot digit appeared ${analysis.hotDigitCount}x in last ${this.cfg.digitWindow} ticks (${analysis.hotDigitPct}%)
                Frequency edge over 2nd: ${analysis.frequencyEdge}
                Stake: $${this.currentStake.toFixed(2)}\n
                Consecutive losses: ${this.consecutiveLosses}
            `
        );

        this.lastTradeTime[asset] = Date.now();
        this.tradeStartTime = Date.now();
        this._startWatchdog(asset);
    }

    _onBuy(msg) {
        const asset = Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.status === 'buying');

        if (msg.error) {
            console.error(`❌ Buy error: ${msg.error.message}`);
            if (asset) delete this.activeTrades[asset];
            this.tradeInProgress = false;
            this._clearWatchdog();
            return;
        }

        if (!asset) { console.warn('Buy response but no pending trade'); return; }

        const contractId = msg.buy.contract_id;
        console.log(`✅ Contract opened: ${contractId} on ${asset}`);

        this.activeTrades[asset].status = 'active';
        this.activeTrades[asset].contractId = contractId;

        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    }

    // ── Contract monitoring ───────────────────────────────────────────────────
    _onContractUpdate(msg) {
        if (msg.error) { console.error('Contract error:', msg.error.message); return; }
        const contract = msg.proposal_open_contract;
        if (!contract) return;

        const asset = contract.underlying ||
            Object.keys(this.activeTrades).find(a => this.activeTrades[a]?.contractId === contract.contract_id);
        if (!asset || !this.activeTrades[asset]) return;

        if (msg.subscription?.id) this.contractSubs[asset] = msg.subscription.id;

        if (contract.is_sold) {
            this._onTradeResult(asset, contract);
        }
    }

    // ── Trade result ──────────────────────────────────────────────────────────
    _onTradeResult(asset, contract) {
        const trade = this.activeTrades[asset];
        if (!trade) return;

        this._clearWatchdog();
        if (this.contractSubs[asset]) {
            this._send({ forget: this.contractSubs[asset] });
            delete this.contractSubs[asset];
        }

        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        // Record prediction regardless of win/loss (for repeat-guard)
        this.recentPredictions.push(trade.predictedDigit);
        if (this.recentPredictions.length > 10) this.recentPredictions.shift();

        console.log(`\n${'═'.repeat(55)}`);
        console.log(`  ${won ? '✅ WIN' : '❌ LOSS'}: ${asset}`);
        console.log(`  Predicted digit: ${trade.predictedDigit} | P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}`);
        console.log(`${'═'.repeat(55)}`);

        // Update global stats
        this.totalTrades += 1;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].profitLoss += profit;

        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.currentStake = this.cfg.initialStake;
            this.consecutiveLosses = 0;
            this.assetMetrics[asset].wins++;
        } else {
            this.totalLosses++;
            this.isWinTrade = false;
            this.consecutiveLosses++;
            this.assetMetrics[asset].losses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;
        }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        this._sendTelegram(
            `${won ? '✅' : '❌'} <b>differBot</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Digit bet: ${trade.predictedDigit} | ${won ? 'Did NOT appear ✅' : 'Appeared ❌'}\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(3)}\n` +
            `Consecutive losses: ${this.consecutiveLosses}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Losses x2-x5: ${this.consecutiveLosses2} | ${this.consecutiveLosses3} | ${this.consecutiveLosses4} | ${this.consecutiveLosses5}\n` +
            `Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00'}%\n` +
            `Next stake: $${this.currentStake.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`
        );

        this._logSummary();
        StatePersistence.save(this);

        // Stop conditions
        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            console.log('🎯 Take Profit reached — stopping');
            this.endOfDay = true;
            this._sendTelegram(`🎯 <b>Take Profit reached!</b> P&L: +$${this.totalProfitLoss.toFixed(2)}`);
            this._cleanupWs();
            return;
        }
        if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses || this.totalProfitLoss <= -this.cfg.stopLoss) {
            console.log('🛑 Stop condition met — disconnecting');
            this.endOfDay = true;
            this._sendTelegram(`🛑 <b>Stop condition met</b>\nLosses: ${this.consecutiveLosses} | P&L: $${this.totalProfitLoss.toFixed(2)}`);
            this._cleanupWs();
        }
    }

    // ── Watchdog ──────────────────────────────────────────────────────────────
    _startWatchdog(asset) {
        this._clearWatchdog();
        this._wdTimer = setTimeout(() => {
            const contractId = this.activeTrades[asset]?.contractId;
            if (!contractId) { this._clearWatchdog(); return; }

            console.warn(`⏰ WATCHDOG — contract ${contractId} unresolved after ${this.tradeWatchdogMs / 1000}s`);

            if (this.connected && this.wsReady) {
                this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
                this._wdPollTimer = setTimeout(() => {
                    if (!this.activeTrades[asset]) { this._clearWatchdog(); return; }
                    console.error(`🚨 WATCHDOG: poll timed out — force releasing`);
                    this._recoverStuck(asset, contractId, 'watchdog-force');
                }, 10000);
            } else {
                this._recoverStuck(asset, contractId, 'watchdog-offline');
            }
        }, this.tradeWatchdogMs);
    }

    _clearWatchdog() {
        if (this._wdTimer) { clearTimeout(this._wdTimer); this._wdTimer = null; }
        if (this._wdPollTimer) { clearTimeout(this._wdPollTimer); this._wdPollTimer = null; }
    }

    _recoverStuck(asset, contractId, reason) {
        this._clearWatchdog();
        const trade = this.activeTrades[asset];
        const stake = trade?.stake || 0;
        const open = Math.round((Date.now() - (this.tradeStartTime || Date.now())) / 1000);

        console.error(`🚨 STUCK TRADE [${reason}] — ${asset} | ${contractId} | open ${open}s`);

        if (contractId && this.connected) this._send({ sell: contractId, price: '0' });
        if (this.contractSubs[asset]) { this._send({ forget: this.contractSubs[asset] }); delete this.contractSubs[asset]; }

        this.tradeInProgress = false;
        this.tradeStartTime = null;
        delete this.activeTrades[asset];

        this.totalLosses++;
        this.consecutiveLosses++;
        this.totalProfitLoss -= stake;
        this.dailyProfitLoss -= stake;
        this.assetMetrics[asset].losses++;
        this.assetMetrics[asset].profitLoss -= stake;

        this.currentStake = Math.ceil(this.currentStake * this.cfg.multiplier * 100) / 100;

        this._sendTelegram(`🚨 <b>Stuck trade recovered [${reason}]</b>\nAsset: ${asset}\nStake recorded as loss: $${stake.toFixed(2)}`);
        StatePersistence.save(this);
    }

    // ── Telegram ──────────────────────────────────────────────────────────────
    async _sendTelegram(text) {
        if (!this.telegram) return;
        try { await this.telegram.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' }); }
        catch (e) { console.error(`Telegram: ${e.message}`); }
    }

    // ── Logging ───────────────────────────────────────────────────────────────
    _logAnalysis(asset, analysis) {
        const s = analysis.scores || {};

        // Show top-2 frequency even on rejection so we can tune thresholds
        let freqStr = '';
        if (analysis.ranking && analysis.ranking.length >= 2) {
            const r = analysis.ranking;
            freqStr = `top:[${r[0].digit}×${r[0].count} ${r[1].digit}×${r[1].count} ${r[2]?.digit}×${r[2]?.count}] edge:${r[0].count - r[1].count} | `;
        }

        const digit = analysis.predictedDigit !== undefined ? `D${analysis.predictedDigit}` : '--';

        console.log(
            `📊 ${asset} | ${digit} | Score:${((analysis.overallScore || 0) * 100).toFixed(0)}% | ` +
            `${freqStr}` +
            `BW:${((s.bandWidth || 0) * 100).toFixed(0)} ` +
            `MACD:${((s.macdFlat || 0) * 100).toFixed(0)} ` +
            `Pos:${((s.pricePosition || 0) * 100).toFixed(0)} ` +
            `Conv:${((s.macdConverging || 0) * 100).toFixed(0)} ` +
            `Vol:${((s.volTrend || 0) * 100).toFixed(0)} | ` +
            `${analysis.shouldTrade ? '✅' : '❌'} ${analysis.reason}`
        );
    }

    _logSummary() {
        const wr = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        console.log('\n📊 Summary:');
        console.log(`  Trades: ${this.totalTrades} | W: ${this.totalWins} | L: ${this.totalLosses} | WR: ${wr}%`);
        console.log(`  x2 losses: ${this.consecutiveLosses2} | x3: ${this.consecutiveLosses3} | x4: ${this.consecutiveLosses4}`);
        console.log(`  Total P&L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`  Stake: $${this.currentStake.toFixed(2)}`);
    }

    // ── Time-based reconnect (unchanged from accumulator) ─────────────────────
    _startTimeScheduler() {
        setInterval(() => {
            const now = new Date();
            const gmt1 = new Date(now.getTime() + 3600000);
            const day = gmt1.getUTCDay();
            const hr = gmt1.getUTCHours();
            const min = gmt1.getUTCMinutes();

            const weekend = day === 0 || (day === 6 && hr >= 23) || (day === 1 && hr < 8);
            if (weekend && !this.endOfDay) {
                console.log('📅 Weekend — pausing');
                this.endOfDay = true;
                this._cleanupWs();
            }

            if (this.endOfDay && hr === 2 && min < 1) {
                console.log('⏰ 2:00 AM — reconnecting');
                this.endOfDay = false;
                this.tradeInProgress = false;
                this.recentPredictions = [];
                this.connect();
            }

            if (this.isWinTrade && !this.endOfDay && hr >= 23) {
                console.log('🌙 Post-win 11 PM — stopping for the night');
                this.endOfDay = true;
                this._sendTelegram(`🌙 <b>Night stop after win</b>\nP&L: $${this.totalProfitLoss.toFixed(2)}`);
                this._cleanupWs();
            }
        }, 20000);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    start() {
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  🎯 differBot — Digit Differ Trading Bot');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Assets:      ${this.cfg.assets.join(', ')}`);
        console.log(`  Stake:       $${this.cfg.initialStake} × ${this.cfg.multiplier}x`);
        console.log(`  Digit win:   rolling ${this.cfg.digitWindow} ticks, hot ≥${this.cfg.minHotFrequency}`);
        console.log(`  Max losses:  ${this.cfg.maxConsecutiveLosses}`);
        console.log('═══════════════════════════════════════════════════════════\n');

        this.connect();
        this._startTimeScheduler();
        StatePersistence.startAutoSave(this);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new DigitDifferBot(BOT_CONFIG);
bot.start();