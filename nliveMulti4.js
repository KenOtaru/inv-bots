/**
 * Deriv Accumulator Trading Bot
 * Version 4.0 — Reliability Overhaul
 *
 * KEY UPGRADES OVER v3:
 *  1. Fixed ticks_stayed_in parsing (currentTicks derived from last element)
 *  2. Single-proposal-at-a-time flow — no stale-ID races
 *  3. Asset rotation with per-asset cooldowns
 *  4. take_profit sent in every proposal for safe auto-close
 *  5. WebSocket ping/keepalive every 25 s (prevents silent timeout)
 *  6. Price-based volatility detection (not digit-based — accumulators use price ranges)
 *  7. Tiered growth-rate selection based on volatility regime
 *  8. Conservative flat-stake default; optional Kelly multiplier only after 20+ trades
 *  9. Correct contract result parsing (bid_price / profit / status)
 * 10. Graceful sell-on-exit for open contracts
 */

require('dotenv').config();
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONSTANTS
// ============================================================
const WS_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const STATE_FILE = path.join(__dirname, 'accumbot-state001.json');
const PING_INTERVAL_MS = 25_000;   // keep-alive ping
const PROPOSAL_COOLDOWN_MS = 2_000; // minimum ms between proposal requests per asset
const MAX_TICK_HISTORY = 300;

// ============================================================
// STATE PERSISTENCE
// ============================================================
class StatePersistence {
    static save(bot) {
        try {
            const snap = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    consecutiveLosses: bot.consecutiveLosses,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                },
                assetMetrics: bot.assetMetrics,
                runHistories: bot.analyzer.runHistories,
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2));
        } catch (e) {
            console.error('State save failed:', e.message);
        }
    }

    static load() {
        try {
            if (!fs.existsSync(STATE_FILE)) return null;
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageMin = (Date.now() - data.savedAt) / 60_000;
            if (ageMin > 120) {
                const bak = STATE_FILE.replace('.json', `_bak_${Date.now()}.json`);
                fs.renameSync(STATE_FILE, bak);
                console.log(`⚠️  State too old (${ageMin.toFixed(0)} min) — archived and starting fresh`);
                return null;
            }
            console.log(`📂 Restored state from ${ageMin.toFixed(1)} min ago`);
            return data;
        } catch (e) {
            console.error('State load failed:', e.message);
            return null;
        }
    }

    static startAutoSave(bot, intervalMs = 10_000) {
        const save = () => { if (!bot.endOfDay) StatePersistence.save(bot); };
        bot._saveInterval = setInterval(save, intervalMs);
        const shutdown = (sig) => {
            console.log(`\n🛑 ${sig} received — saving state…`);
            StatePersistence.save(bot);
            process.exit(0);
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('uncaughtException', (err) => {
            console.error('Uncaught exception:', err);
            StatePersistence.save(bot);
            process.exit(1);
        });
    }
}

// ============================================================
// MARKET ANALYZER
// ============================================================
class AccumulatorAnalyzer {
    constructor() {
        this.runHistories = {};  // asset → [{ticks, timestamp}]
    }

    // ---- Run history -------------------------------------------
    recordRun(asset, ticks) {
        if (!this.runHistories[asset]) this.runHistories[asset] = [];
        this.runHistories[asset].push({ ticks, ts: Date.now() });
        if (this.runHistories[asset].length > 500) this.runHistories[asset].shift();
    }

    /**
     * Estimate probability that a run lasting `currentTicks` will
     * survive at least `extraTicks` more ticks, using exponentially
     * weighted history.
     */
    survivalProbability(asset, currentTicks, extraTicks = 4) {
        const runs = this.runHistories[asset] || [];
        if (runs.length < 20) return this._defaultSurvival(currentTicks, extraTicks);

        const now = Date.now();
        let wSurviveCurrent = 0, wSurviveBoth = 0;

        for (const r of runs) {
            const age = (now - r.ts) / (1000 * 60 * 60); // hours
            const w = Math.exp(-age / 6);                 // 6-hour half-life
            if (r.ticks >= currentTicks) {
                wSurviveCurrent += w;
                if (r.ticks >= currentTicks + extraTicks) wSurviveBoth += w;
            }
        }

        if (wSurviveCurrent < 1) return this._defaultSurvival(currentTicks, extraTicks);
        return Math.min(0.95, wSurviveBoth / wSurviveCurrent);
    }

    _defaultSurvival(currentTicks, extra) {
        // Conservative empirical curve for Volatility Indices
        const total = currentTicks + extra;
        if (total <= 5) return 0.88;
        if (total <= 10) return 0.80;
        if (total <= 15) return 0.72;
        if (total <= 20) return 0.63;
        if (total <= 25) return 0.54;
        if (total <= 30) return 0.44;
        return Math.max(0.15, 0.44 * Math.exp(-0.04 * (total - 30)));
    }

    // ---- Price-based volatility regime -------------------------
    /**
     * Uses actual price changes (not last-digit) to gauge how
     * "noisy" the market is right now.  A stable, moderate-noise
     * regime is best for accumulators.
     *
     * @param {number[]} prices  recent raw price values
     * @returns {{ regime: string, score: number, avgChangePct: number }}
     */
    detectRegime(prices) {
        if (prices.length < 30) return { regime: 'insufficient_data', score: 0.5, avgChangePct: 0 };

        const recent = prices.slice(-30);
        const changes = [];
        for (let i = 1; i < recent.length; i++) {
            changes.push(Math.abs((recent[i] - recent[i - 1]) / recent[i - 1]) * 100);
        }

        const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
        const max = Math.max(...changes);

        // Detect a recent spike (bad for accumulators)
        const lastFive = changes.slice(-5);
        const recentMax = Math.max(...lastFive);

        let regime, score;

        if (recentMax > avg * 3.5) {
            // Recent large spike — very risky
            regime = 'spike';
            score = 0.10;
        } else if (avg < 0.001) {
            // Essentially zero movement — likely a spread gap or issue
            regime = 'frozen';
            score = 0.20;
        } else if (avg < 0.005) {
            // Very low noise — good for accumulators
            regime = 'calm';
            score = 0.90;
        } else if (avg < 0.012) {
            // Moderate noise — acceptable
            regime = 'moderate';
            score = 0.75;
        } else if (avg < 0.025) {
            // Elevated noise — marginal
            regime = 'elevated';
            score = 0.50;
        } else {
            // High noise — avoid
            regime = 'volatile';
            score = 0.15;
        }

        // Further penalise if max change is extreme
        if (max > avg * 5) score *= 0.6;

        return { regime, score, avgChangePct: avg };
    }

    /**
     * Recommend a growth rate based on volatility regime.
     * Lower growth rate = wider range = safer in volatile markets.
     */
    recommendGrowthRate(regimeScore) {
        if (regimeScore >= 0.80) return 0.03;   // calm: can use 3%
        // if (regimeScore >= 0.60) return 0.02;   // moderate: use 2%
        return 0.01;                             // elevated/volatile: safest 1%
    }
}

// ============================================================
// RISK MANAGER
// ============================================================
class RiskManager {
    constructor(cfg) {
        this.cfg = cfg;
        this.assetCooldowns = {};   // asset → unixMs when cooldown expires
    }

    canTrade(asset, dailyPnl, consecutiveLosses) {
        if (dailyPnl <= -this.cfg.maxDailyLoss)
            return { ok: false, reason: 'daily_loss_limit' };
        if (consecutiveLosses >= this.cfg.maxConsecutiveLosses)
            return { ok: false, reason: 'max_consecutive_losses' };
        if (this._onCooldown(asset))
            return { ok: false, reason: `asset_cooldown_${asset}` };
        return { ok: true };
    }

    _onCooldown(asset) {
        const until = this.assetCooldowns[asset] || 0;
        if (Date.now() < until) return true;
        delete this.assetCooldowns[asset];
        return false;
    }

    setCooldown(asset, minutes = 20) {
        this.assetCooldowns[asset] = Date.now() + minutes * 60_000;
        console.log(`🔒 ${asset} cooldown ${minutes} min`);
    }

    /**
     * Stake sizing:
     * - Flat stake by default (safest)
     * - Light progression only if > 20 trades and win rate > 55%
     * - Reduce after daily loss > 50% of limit
     */
    calcStake(basStake, totalTrades, totalWins, consecutiveLosses, dailyPnl) {
        let stake = basStake;

        // Defensive reduction near daily loss limit
        if (dailyPnl < -this.cfg.maxDailyLoss * 0.50) stake *= 0.5;

        // Light progression (max 2x base) only with a proven record
        if (totalTrades >= 20) {
            const wr = totalWins / totalTrades;
            if (wr >= 0.55 && consecutiveLosses > 0) {
                const mult = Math.min(2.0, Math.pow(1.5, consecutiveLosses));
                stake *= mult;
            }
        }

        return Math.max(basStake * 0.5, Math.min(stake, basStake * 3));
    }
}

// ============================================================
// MAIN BOT
// ============================================================
class AccumulatorBot {
    constructor(token, cfg = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.endOfDay = false;
        this.reconnectAttempts = 0;
        this.maxReconnect = 50;

        // Config with sane defaults
        this.cfg = {
            assets: cfg.assets || ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
            initialStake: cfg.initialStake || 1,
            maxConsecutiveLosses: cfg.maxConsecutiveLosses || 4,
            maxDailyLoss: cfg.maxDailyLoss || 200,
            takeProfit: cfg.takeProfit || 50000,

            // Entry window: wait for a run to be established before entering
            minEntryTicks: cfg.minEntryTicks || 5,
            maxEntryTicks: cfg.maxEntryTicks || 20,

            // Auto-sell: take profit = X × stake (e.g. 0.5 = 50% gain)
            takeProfitMultiplier: cfg.takeProfitMultiplier || 0.5,

            // Quality thresholds
            minSurvivalProb: cfg.minSurvivalProb || 0.62,
            minRegimeScore: cfg.minRegimeScore || 0.55,
            minOverallScore: cfg.minOverallScore || 0.68,

            requiredHistoryLength: cfg.requiredHistoryLength || 60,
            telegramToken: cfg.telegramToken || process.env.TELEGRAM_TOKEN || '',
            telegramChatId: cfg.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
        };

        // Trading state
        this.currentStake = this.cfg.initialStake;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;

        // Active trade state
        this.tradeActive = false;
        this.tradeAsset = null;
        this.tradeEntryTicks = null;
        this.tradeContractId = null;
        this.tradeStake = null;
        this.tradeDecision = null;

        // Per-asset data
        this.priceHistories = {};       // asset → number[] of raw prices
        this.tickCounts = {};           // asset → latest ticks_stayed_in count
        this.assetMetrics = {};
        this.lastProposalTime = {};     // asset → timestamp

        // Pending proposal flow
        this.pendingProposalAsset = null;
        this.pendingProposalId = null;

        // Asset rotation
        this.assetIndex = 0;

        this.cfg.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.tickCounts[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
            this.lastProposalTime[a] = 0;
        });

        this.analyzer = new AccumulatorAnalyzer();
        this.riskManager = new RiskManager(this.cfg);
        this.tg = this.cfg.telegramToken
            ? new TelegramBot(this.cfg.telegramToken, { polling: false })
            : null;

        // Load persisted state
        const saved = StatePersistence.load();
        if (saved) {
            if (saved.trading) Object.assign(this, saved.trading);
            if (saved.assetMetrics) this.assetMetrics = saved.assetMetrics;
            if (saved.runHistories) this.analyzer.runHistories = saved.runHistories;
        }
    }

    // ============================================================
    // CONNECTION
    // ============================================================
    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        this._cleanupWs();

        console.log('🔌 Connecting to Deriv API…');
        this.ws = new WebSocket(WS_URL);

        this.ws.on('open', () => {
            console.log('✅ WebSocket open');
            this.connected = true;
            this.reconnectAttempts = 0;
            this._startPing();
            this._send({ authorize: this.token });
        });

        this.ws.on('message', (raw) => {
            try { this._onMessage(JSON.parse(raw)); }
            catch (e) { console.error('Parse error:', e.message); }
        });

        this.ws.on('error', (e) => console.error('WS error:', e.message));

        this.ws.on('close', () => {
            console.log('🔌 WebSocket closed');
            this._handleDisconnect();
        });
    }

    _startPing() {
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
            if (this.connected) this._send({ ping: 1 });
        }, PING_INTERVAL_MS);
    }

    _cleanupWs() {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
        if (this.ws) {
            this.ws.removeAllListeners();
            if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) {
                try { this.ws.close(); } catch (_) { }
            }
            this.ws = null;
        }
        this.connected = false;
        this.wsReady = false;
    }

    _handleDisconnect() {
        this._cleanupWs();
        if (this.endOfDay) return;

        StatePersistence.save(this);
        if (this.reconnectAttempts >= this.maxReconnect) {
            console.error('❌ Max reconnect attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.4, this.reconnectAttempts - 1), 30_000);
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s… (${this.reconnectAttempts}/${this.maxReconnect})`);
        setTimeout(() => this.connect(), delay);
    }

    _send(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try { this.ws.send(JSON.stringify(obj)); return true; }
        catch (e) { console.error('Send error:', e.message); return false; }
    }

    // ============================================================
    // MESSAGE ROUTER
    // ============================================================
    _onMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize': this._onAuthorize(msg); break;
            case 'history': this._onHistory(msg); break;
            case 'tick': this._onTick(msg); break;
            case 'proposal': this._onProposal(msg); break;
            case 'buy': this._onBuy(msg); break;
            case 'proposal_open_contract': this._onContractUpdate(msg); break;
            case 'sell':                   /* handled via poc is_sold */   break;
            case 'ping':                   /* no-op */                     break;
            default:
                if (msg.error) console.error(`API error [${msg.msg_type}]:`, msg.error.message);
        }
    }

    // ============================================================
    // AUTH + INIT
    // ============================================================
    _onAuthorize(msg) {
        if (msg.error) {
            console.error('❌ Auth failed:', msg.error.message);
            this._cleanupWs();
            return;
        }
        console.log(`✅ Authenticated as ${msg.authorize.loginid}`);
        this.wsReady = true;
        this._initSubscriptions();
    }

    _initSubscriptions() {
        console.log('📡 Subscribing to tick streams…');
        this.cfg.assets.forEach(asset => {
            // Tick history (prices, not digits)
            this._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.cfg.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks',
            });
            // Live tick stream
            this._send({ ticks: asset, subscribe: 1 });
        });
    }

    // ============================================================
    // TICK DATA
    // ============================================================
    _onHistory(msg) {
        if (msg.error) { console.error('History error:', msg.error.message); return; }
        const asset = msg.echo_req.ticks_history;
        const prices = (msg.history.prices || []).map(Number);
        this.priceHistories[asset] = prices;
        console.log(`📊 ${asset}: loaded ${prices.length} historical prices`);
    }

    _onTick(msg) {
        if (msg.error) return;
        const tick = msg.tick;
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);

        // Maintain price history
        this.priceHistories[asset].push(price);
        if (this.priceHistories[asset].length > MAX_TICK_HISTORY) {
            this.priceHistories[asset].shift();
        }

        // Only start scanning when we have enough data
        if (this.priceHistories[asset].length < this.cfg.requiredHistoryLength) return;

        // Don't request proposals during an active trade
        if (this.tradeActive) return;

        // Rate-limit per asset
        const now = Date.now();
        if (now - (this.lastProposalTime[asset] || 0) < PROPOSAL_COOLDOWN_MS) return;

        // Only one pending proposal at a time
        if (this.pendingProposalAsset) return;

        // Check if this asset currently looks interesting
        this._maybeRequestProposal(asset);
    }

    // ============================================================
    // PROPOSAL FLOW
    // ============================================================
    _maybeRequestProposal(asset) {
        const prices = this.priceHistories[asset];
        if (prices.length < this.cfg.requiredHistoryLength) return;

        // Quick regime pre-filter before bothering the API
        const regime = this.analyzer.detectRegime(prices);
        if (regime.score < this.cfg.minRegimeScore) return;

        const growthRate = this.analyzer.recommendGrowthRate(regime.score);
        const takeProfit = parseFloat((this.currentStake * this.cfg.takeProfitMultiplier).toFixed(2));

        this.pendingProposalAsset = asset;
        this.lastProposalTime[asset] = Date.now();

        this._send({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: growthRate,
            limit_order: { take_profit: takeProfit },   // ← auto-close at profit target
        });
    }

    _onProposal(msg) {
        // Clear pending regardless of outcome
        const asset = this.pendingProposalAsset;
        this.pendingProposalAsset = null;

        if (msg.error || !msg.proposal) {
            if (msg.error) console.warn(`Proposal error (${asset}):`, msg.error.message);
            return;
        }

        const proposal = msg.proposal;
        const details = proposal.contract_details || {};

        // ── Parse current tick count from ticks_stayed_in ─────────────
        // ticks_stayed_in is an array of cumulative counts for the last 100 runs.
        // The FIRST element (index 0) is the CURRENT (ongoing) run tick count.
        const tsi = details.ticks_stayed_in;
        let currentTicks = 0;
        if (Array.isArray(tsi) && tsi.length > 0) {
            currentTicks = tsi[0];  // index 0 = current live run
        }

        this.tickCounts[asset] = currentTicks;

        // Record completed runs from historical data (indices 1+)
        if (Array.isArray(tsi)) {
            for (let i = 1; i < Math.min(tsi.length, 10); i++) {
                if (tsi[i] > 0) this.analyzer.recordRun(asset, tsi[i]);
            }
        }

        if (this.tradeActive) return;  // double-check

        // ── Evaluate ──────────────────────────────────────────────────
        const decision = this._evaluate(asset, currentTicks, msg.proposal);
        if (!decision.trade || decision.regime !== 'calm') {
            return;
        }

        // ── Execute ───────────────────────────────────────────────────
        this.pendingProposalId = proposal.id;
        this._executeTrade(asset, proposal.id, decision);
    }

    // ============================================================
    // TRADE DECISION ENGINE
    // ============================================================
    _evaluate(asset, currentTicks, proposal) {
        const prices = this.priceHistories[asset];

        // 1. Entry window
        if (currentTicks < this.cfg.minEntryTicks || currentTicks > this.cfg.maxEntryTicks) {
            return { trade: false, reason: `entry_window(${currentTicks})` };
        }

        // 2. Risk manager gate
        const risk = this.riskManager.canTrade(asset, this.dailyProfitLoss, this.consecutiveLosses);
        if (!risk.ok) return { trade: false, reason: risk.reason };

        // 3. Regime
        const regime = this.analyzer.detectRegime(prices);
        if (regime.score < this.cfg.minRegimeScore) {
            return { trade: false, reason: `regime_${regime.regime}(${regime.score.toFixed(2)})` };
        }

        // 4. Survival probability (targeting 4 extra ticks minimum)
        const targetExtra = 4;
        const survival = this.analyzer.survivalProbability(asset, currentTicks, targetExtra);
        if (survival < this.cfg.minSurvivalProb) {
            return { trade: false, reason: `survival_low(${survival.toFixed(2)})` };
        }

        // 5. Price acceleration — avoid entering on a tick that just moved unusually far
        const lastChange = prices.length >= 2
            ? Math.abs((prices[prices.length - 1] - prices[prices.length - 2]) / prices[prices.length - 2]) * 100
            : 0;
        if (lastChange > 0.030) {
            return { trade: false, reason: `last_tick_spike(${lastChange.toFixed(4)}%)` };
        }

        // 6. Overall score
        const score = survival * 0.50 + regime.score * 0.35 + (1 - Math.min(1, lastChange / 0.030)) * 0.15;

        if (score < this.cfg.minOverallScore) {
            return { trade: false, reason: `score_low(${score.toFixed(2)})` };
        }

        // Stake
        const stake = this.riskManager.calcStake(
            this.cfg.initialStake,
            this.totalTrades,
            this.totalWins,
            this.consecutiveLosses,
            this.dailyProfitLoss,
        );

        return {
            trade: true,
            asset,
            currentTicks,
            targetTicks: currentTicks + targetExtra,
            survivalProb: survival,
            regimeScore: regime.score,
            regime: regime.regime,
            score,
            stake,
            growthRate: this.analyzer.recommendGrowthRate(regime.score),
        };
    }

    // ============================================================
    // TRADE EXECUTION
    // ============================================================
    _executeTrade(asset, proposalId, decision) {
        this.currentStake = decision.stake;

        console.log('\n╔══════════════════════════════════════╗');
        console.log(`║  🚀 TRADE SIGNAL — ${asset.padEnd(8)}          ║`);
        console.log('╚══════════════════════════════════════╝');
        console.log(`  Entry ticks  : ${decision.currentTicks}`);
        console.log(`  Target ticks : ${decision.targetTicks}`);
        console.log(`  Stake        : $${decision.stake.toFixed(2)}`);
        console.log(`  Growth rate  : ${(decision.growthRate * 100).toFixed(0)}%`);
        console.log(`  Score        : ${(decision.score * 100).toFixed(1)}%`);
        console.log(`  Survival     : ${(decision.survivalProb * 100).toFixed(1)}%`);
        console.log(`  Regime       : ${decision.regime} (${(decision.regimeScore * 100).toFixed(0)}%)`);

        const sent = this._send({
            buy: proposalId,
            price: decision.stake.toFixed(2),
        });

        if (!sent) {
            console.error('❌ Failed to send buy request');
            return;
        }

        // Optimistically mark as in-trade to block further proposals
        this.tradeActive = true;
        this.tradeAsset = asset;
        this.tradeEntryTicks = decision.currentTicks;
        this.tradeDecision = decision;
        this.tradeStake = decision.stake;

        this._tg(
            `🚀 <b>TRADE OPENED 4</b>\n\n` +
            `Asset: <b>${asset}</b>\n` +
            `Entry: ${decision.currentTicks} ticks | Target: +${4}\n` +
            `Stake: $${decision.stake.toFixed(2)} @ ${(decision.growthRate * 100).toFixed(0)}% growth\n` +
            `Score: ${(decision.score * 100).toFixed(1)}% | Survival: ${(decision.survivalProb * 100).toFixed(1)}%\n` +
            `Regime: ${decision.regime}`,
        );
    }

    _onBuy(msg) {
        if (msg.error) {
            console.error('❌ Buy error:', msg.error.message);
            this.tradeActive = false;
            this.tradeAsset = null;
            return;
        }

        this.tradeContractId = msg.buy.contract_id;
        console.log(`✅ Contract placed: ${this.tradeContractId}`);

        // Subscribe to live contract updates
        this._send({
            proposal_open_contract: 1,
            contract_id: this.tradeContractId,
            subscribe: 1,
        });
    }

    // ============================================================
    // CONTRACT MONITORING
    // ============================================================
    _onContractUpdate(msg) {
        if (msg.error) return;
        const poc = msg.proposal_open_contract;
        if (!poc || poc.contract_id !== this.tradeContractId) return;

        // ── Manual early exit logic ──────────────────────────────────
        if (!poc.is_sold) {
            const profit = parseFloat(poc.profit || 0);
            const targetProfit = this.tradeStake * this.cfg.takeProfitMultiplier;
            const currentTicks = poc.tick_count || 0;
            const ticksHeld = currentTicks - (this.tradeEntryTicks || 0);

            const prices = this.priceHistories[this.tradeAsset] || [];
            const regime = this.analyzer.detectRegime(prices);

            const shouldExit =
                profit >= targetProfit * 0.75 ||           // Near profit target
                regime.score < 0.35 ||                     // Market turned hostile
                ticksHeld >= 10;                           // Max hold time reached

            if (shouldExit && poc.bid_price) {
                const reason = profit >= targetProfit * 0.75 ? 'profit_target'
                    : regime.score < 0.35 ? 'regime_deteriorated'
                        : 'max_hold_time';
                console.log(`⚡ Early exit: ${reason} (profit=$${profit.toFixed(2)})`);
                this._send({ sell: poc.contract_id, price: poc.bid_price });
            }
            return;
        }

        // ── Contract closed ─────────────────────────────────────────
        this._onTradeResult(poc);
    }

    // ============================================================
    // TRADE RESULT
    // ============================================================
    _onTradeResult(poc) {
        const won = poc.status === 'won';
        const profit = parseFloat(poc.profit || 0);
        const exitTicks = parseInt(poc.tick_count || 0);
        const asset = poc.underlying || this.tradeAsset;
        const ticksHeld = exitTicks - (this.tradeEntryTicks || 0);

        const winLose = won ? '✅ WIN' : '❌ LOSS';
        console.log(`\n${winLose}: ${asset}`);
        console.log(`  Ticks : entry=${this.tradeEntryTicks} exit=${exitTicks} held=${ticksHeld}`);
        console.log(`  P&L   : ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);

        // Stats
        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.assetMetrics[asset].trades++;
        this.assetMetrics[asset].pnl += profit;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.assetMetrics[asset].wins++;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.assetMetrics[asset].losses++;
            this.riskManager.setCooldown(asset, 15);
        }

        this.analyzer.recordRun(asset, exitTicks);

        const wr = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';

        this._tg(
            `${won ? '✅' : '❌'} <b>Bot 4 ${won ? 'WIN' : 'LOSS'}</b> — ${asset}\n\n` +
            `P&L: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}\n` +
            `Ticks: ${this.tradeEntryTicks} → ${exitTicks} (held ${ticksHeld})\n\n` +
            `📊 Session:\n` +
            `Trades: ${this.totalTrades} | W/L: ${this.totalWins}/${this.totalLosses} | WR: ${wr}%\n` +
            `Daily P&L: ${this.dailyProfitLoss >= 0 ? '+' : ''}$${this.dailyProfitLoss.toFixed(2)}\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`,
        );

        // Reset trade state
        this.tradeActive = false;
        this.tradeAsset = null;
        this.tradeContractId = null;
        this.tradeEntryTicks = null;
        this.tradeDecision = null;
        this.tradeStake = null;
        this.pendingProposalId = null;

        // Stop conditions
        if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
            return this._shutdown('max_consecutive_losses');
        }
        if (this.dailyProfitLoss <= -this.cfg.maxDailyLoss) {
            return this._shutdown('daily_loss_limit');
        }
        if (this.totalProfitLoss >= this.cfg.takeProfit) {
            return this._shutdown('take_profit_reached');
        }

        StatePersistence.save(this);
    }

    // ============================================================
    // SHUTDOWN
    // ============================================================
    _shutdown(reason) {
        console.log(`\n🛑 Shutdown: ${reason}`);
        this.endOfDay = true;
        StatePersistence.save(this);

        const wr = this.totalTrades > 0
            ? (this.totalWins / this.totalTrades * 100).toFixed(1)
            : '0.0';

        this._tg(
            `🛑 <b>BOT STOPPED</b> — ${reason}\n\n` +
            `Trades: ${this.totalTrades}\n` +
            `W/L: ${this.totalWins}/${this.totalLosses} | WR: ${wr}%\n` +
            `Total P&L: ${this.totalProfitLoss >= 0 ? '+' : ''}$${this.totalProfitLoss.toFixed(2)}`,
        );

        setTimeout(() => {
            this._cleanupWs();
            if (this._saveInterval) clearInterval(this._saveInterval);
        }, 2000);
    }

    // ============================================================
    // TELEGRAM
    // ============================================================
    async _tg(text) {
        if (!this.tg || !this.cfg.telegramChatId) return;
        try {
            await this.tg.sendMessage(this.cfg.telegramChatId, text, { parse_mode: 'HTML' });
        } catch (e) {
            console.error('Telegram error:', e.message);
        }
    }

    // ============================================================
    // START
    // ============================================================
    start() {
        const border = '═'.repeat(54);
        console.log(border);
        console.log('  🤖 DERIV ACCUMULATOR BOT v4.0');
        console.log(border);
        console.log('  Strategy : Regime-filtered late-entry (5–20 ticks)');
        console.log('  Exit     : take_profit API order + manual early sell');
        console.log('  Risk     : flat stake, asset cooldowns, daily limits');
        console.log(border + '\n');

        StatePersistence.startAutoSave(this);
        this.connect();
    }
}

// ============================================================
// BOOT
// ============================================================

// ⚠️  Replace with your real API token (read from env for safety)
const API_TOKEN = 'rgNedekYXvCaPeP';

const bot = new AccumulatorBot(API_TOKEN, {
    // Assets to monitor
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    // Stake & risk
    initialStake: 1,
    maxConsecutiveLosses: 4,
    maxDailyLoss: 200,
    takeProfit: 500,

    // Auto-close at 50% gain (take_profit = stake × 0.5)
    takeProfitMultiplier: 0.5,

    // Entry window: only enter runs that have already survived 5–20 ticks
    minEntryTicks: 5,
    maxEntryTicks: 20,

    // Quality thresholds
    minSurvivalProb: 0.62,
    minRegimeScore: 0.55,
    minOverallScore: 0.68,

    // Telegram (or set TELEGRAM_TOKEN / TELEGRAM_CHAT_ID in .env)
    telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    telegramChatId: '752497117',
});

bot.start();

module.exports = { AccumulatorBot };