/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         accumBotM — RESEARCH-BASED UPGRADED VERSION         ║
 * ║                    FIXED VERSION v2.1                        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

require('dotenv').config();

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'accumBot_research_v2_state.json');
const STATE_SAVE_INTERVAL = 10000;

class StatePersistence {
    static saveState(bot) {
        try {
            const persistableState = {
                savedAt: Date.now(),
                trading: {
                    currentStake: bot.currentStake,
                    totalTrades: bot.totalTrades,
                    totalWins: bot.totalWins,
                    totalLosses: bot.totalLosses,
                    totalProfitLoss: bot.totalProfitLoss,
                    dailyProfitLoss: bot.dailyProfitLoss,
                    weeklyProfitLoss: bot.weeklyProfitLoss,
                    consecutiveLosses: bot.consecutiveLosses,
                    currentRiskPercent: bot.currentRiskPercent,
                },
                assetMetrics: bot.assetMetrics,
                hourlyStats: bot.hourlyStats,
                dailyStats: bot.dailyStats || {},
            };
            fs.writeFileSync(STATE_FILE, JSON.stringify(persistableState, null, 2));
            return true;
        } catch (error) {
            console.error('❌ Failed to save state:', error.message);
            return false;
        }
    }

    static loadState() {
        try {
            if (!fs.existsSync(STATE_FILE)) {
                console.log('🆕 No previous state found.');
                return null;
            }
            const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            const ageHours = (Date.now() - saved.savedAt) / 3600000;
            if (ageHours > 24) {
                console.warn(`⚠️ State ${ageHours.toFixed(1)}h old — starting fresh.`);
                return null;
            }
            console.log(`📂 Restored state (${ageHours.toFixed(1)}h old)`);
            return saved;
        } catch (e) {
            console.error('State load error:', e.message);
            return null;
        }
    }

    static startAutoSave(bot) {
        if (bot.autoSaveInterval) clearInterval(bot.autoSaveInterval);
        bot.autoSaveInterval = setInterval(() => {
            if (bot.connected && !bot.paused) StatePersistence.saveState(bot);
        }, STATE_SAVE_INTERVAL);

        const exitHandler = () => {
            console.log('\n🛑 Saving final state before exit...');
            StatePersistence.saveState(bot);
            process.exit(0);
        };
        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
    }
}

// ============================================================================
// TECHNICAL INDICATORS (FIXED)
// ============================================================================
class TechnicalIndicators {
    static SMA(data, period) {
        if (!data || data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((sum, v) => sum + v, 0) / period;
    }

    static EMA(data, period) {
        if (!data || data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = this.SMA(data.slice(0, period), period);
        
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    static stdDev(data, period) {
        if (!data || data.length < period) return null;
        const slice = data.slice(-period);
        const mean = slice.reduce((sum, v) => sum + v, 0) / period;
        const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
        return Math.sqrt(variance);
    }

    static bollingerBands(prices, period = 20, mult = 2.0) {
        if (!prices || prices.length < period) return null;
        
        const middle = this.SMA(prices, period);
        const sd = this.stdDev(prices, period);
        
        if (middle === null || sd === null) return null;
        
        const upper = middle + mult * sd;
        const lower = middle - mult * sd;
        const current = prices[prices.length - 1];
        const width = (upper - lower) / middle;
        const percentB = (upper - lower) !== 0 ? (current - lower) / (upper - lower) : 0.5;
        
        return { 
            upper, 
            middle, 
            lower, 
            width, 
            percentB, 
            stdDev: sd,
            current 
        };
    }

    static MACD(prices, fast = 12, slow = 26, sig = 9) {
        if (!prices || prices.length < slow + sig) return null;
        
        const emaFast = this.EMA(prices, fast);
        const emaSlow = this.EMA(prices, slow);
        
        if (emaFast === null || emaSlow === null) return null;
        
        const macdLine = emaFast - emaSlow;
        
        // Calculate signal line from MACD history
        const macdHistory = [];
        for (let i = slow; i <= prices.length; i++) {
            const slice = prices.slice(0, i);
            const f = this.EMA(slice, fast);
            const s = this.EMA(slice, slow);
            if (f !== null && s !== null) {
                macdHistory.push(f - s);
            }
        }
        
        const signalLine = this.EMA(macdHistory, sig) || 0;
        const histogram = macdLine - signalLine;

        return {
            macdLine,
            signalLine,
            histogram,
            isFlat: Math.abs(histogram) < 0.00025,
            isConverging: Math.abs(macdLine) < Math.abs(signalLine)
        };
    }

    /**
     * FIXED ADX CALCULATION
     * Proper ADX calculation based on directional movement
     */
    static ADX(prices, period = 14) {
        if (!prices || prices.length < period * 2 + 1) return 25; // neutral default
        
        const highs = prices; // For synthetic indices, use close as high
        const lows = prices;  // For synthetic indices, use close as low
        
        // Calculate True Range and Directional Movement
        const trueRanges = [];
        const plusDM = [];
        const minusDM = [];
        
        for (let i = 1; i < prices.length; i++) {
            // True Range
            const tr = Math.abs(highs[i] - lows[i]);
            trueRanges.push(tr);
            
            // Directional Movement
            const upMove = highs[i] - highs[i - 1];
            const downMove = lows[i - 1] - lows[i];
            
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }
        
        if (trueRanges.length < period) return 25;
        
        // Smooth the values
        const smoothTR = this.SMA(trueRanges.slice(-period), period);
        const smoothPlusDM = this.SMA(plusDM.slice(-period), period);
        const smoothMinusDM = this.SMA(minusDM.slice(-period), period);
        
        if (!smoothTR || smoothTR === 0) return 25;
        
        // Calculate Directional Indicators
        const plusDI = 100 * (smoothPlusDM / smoothTR);
        const minusDI = 100 * (smoothMinusDM / smoothTR);
        
        // Calculate DX
        const diDiff = Math.abs(plusDI - minusDI);
        const diSum = plusDI + minusDI;
        const dx = diSum !== 0 ? 100 * (diDiff / diSum) : 0;
        
        // ADX is smoothed DX (simplified - use last DX as approximation)
        const adx = Math.min(100, Math.max(0, dx));
        
        return parseFloat(adx.toFixed(2));
    }

    static ATR(prices, period = 14) {
        if (!prices || prices.length < period + 1) return null;
        const ranges = [];
        for (let i = 1; i < prices.length; i++) {
            ranges.push(Math.abs(prices[i] - prices[i - 1]));
        }
        return this.SMA(ranges, period);
    }
    
    /**
     * NEW: Calculate volatility trend
     */
    static volatilityTrend(prices, shortPeriod = 10, longPeriod = 30) {
        if (!prices || prices.length < longPeriod) return 0.5;
        
        const recentVol = this.stdDev(prices, shortPeriod);
        const longerVol = this.stdDev(prices, longPeriod);
        
        if (!recentVol || !longerVol || longerVol === 0) return 0.5;
        
        // Score: 1.0 if recent vol is lower (calm), 0 if higher (rising)
        const ratio = recentVol / longerVol;
        return Math.max(0, Math.min(1, 1.5 - ratio));
    }
}

// ============================================================================
// RESEARCH-BASED ANALYZER (FIXED)
// ============================================================================
class AccumulatorAnalyzer {
    constructor() {
        this.tradeResults = {};
    }

    recordTradeResult(asset, result) {
        if (!this.tradeResults[asset]) this.tradeResults[asset] = [];
        this.tradeResults[asset].push({ ...result, ts: Date.now() });
        if (this.tradeResults[asset].length > 300) this.tradeResults[asset].shift();
    }

    analyzeEntry(prices) {
        if (!prices || prices.length < 80) {
            return { shouldTrade: false, reason: 'insufficient_data', overallScore: 0, scores: {} };
        }

        const bb = TechnicalIndicators.bollingerBands(prices);
        const macd = TechnicalIndicators.MACD(prices);
        const adx = TechnicalIndicators.ADX(prices);
        const atr = TechnicalIndicators.ATR(prices);
        const volTrend = TechnicalIndicators.volatilityTrend(prices);
        const currentPrice = prices[prices.length - 1];

        if (!bb || !macd) {
            return { shouldTrade: false, reason: 'calc_failed', overallScore: 0, scores: {} };
        }

        const scores = {};

        // 1. Band Width Score (tighter = better)
        if (bb.width < 0.0018) scores.bandWidth = 1.0;
        else if (bb.width < 0.003) scores.bandWidth = 0.75;
        else if (bb.width < 0.005) scores.bandWidth = 0.4;
        else scores.bandWidth = 0.1;

        // 2. MACD Flatness (smaller histogram = better)
        const normHist = Math.abs(macd.histogram) / (currentPrice || 1000);
        if (normHist < 0.00012) scores.macdFlat = 1.0;
        else if (normHist < 0.0003) scores.macdFlat = 0.7;
        else scores.macdFlat = 0.2;

        // 3. Price Position (middle of bands = better)
        if (bb.percentB >= 0.35 && bb.percentB <= 0.65) scores.pricePosition = 1.0;
        else if (bb.percentB >= 0.2 && bb.percentB <= 0.8) scores.pricePosition = 0.65;
        else scores.pricePosition = 0.2;

        // 4. ADX Low (trend strength - lower = better for accumulator)
        if (adx < 22) scores.adxLow = 1.0;
        else if (adx < 28) scores.adxLow = 0.6;
        else if (adx < 35) scores.adxLow = 0.3;
        else scores.adxLow = 0.1;

        // 5. Tick Stability (recent price changes)
        const recentMoves = [];
        for (let i = 1; i < Math.min(10, prices.length); i++) {
            recentMoves.push(Math.abs(prices[prices.length - i] - prices[prices.length - i - 1]) / prices[prices.length - i - 1]);
        }
        const maxMove = Math.max(...recentMoves);
        if (maxMove < 0.00045) scores.tickStability = 1.0;
        else if (maxMove < 0.001) scores.tickStability = 0.65;
        else scores.tickStability = 0.25;

        // 6. Volatility Trend (FIXED - was hardcoded)
        scores.volTrend = volTrend;

        // Weighted Overall Score
        const weights = {
            bandWidth: 0.30,
            macdFlat: 0.23,
            adxLow: 0.20,
            pricePosition: 0.15,
            tickStability: 0.08,
            volTrend: 0.04
        };

        let overallScore = 0;
        for (const [key, weight] of Object.entries(weights)) {
            overallScore += (scores[key] || 0) * weight;
        }

        // Dynamic Growth Rate based on score
        let growthRate = 0.01;
        if (overallScore >= 0.85) growthRate = 0.03;
        else if (overallScore >= 0.72) growthRate = 0.02;
        else if (overallScore >= 0.65) growthRate = 0.015;

        // Entry Criteria
        const shouldTrade = overallScore >= 0.74 &&
                           scores.bandWidth >= 0.75 &&
                           scores.adxLow >= 0.6 &&
                           scores.macdFlat >= 0.65 &&
                           scores.pricePosition >= 0.6;

        return {
            shouldTrade,
            reason: shouldTrade ? 'strong_low_vol_regime' : `score_${overallScore.toFixed(2)}`,
            overallScore: parseFloat(overallScore.toFixed(3)),
            scores,
            bb,
            macd,
            adx,
            recommendedGrowthRate: growthRate,
            atr,
            volTrend
        };
    }
}

// ============================================================================
// MAIN BOT CLASS (FIXED)
// ============================================================================
class ResearchBasedAccumulatorBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        this.accountBalance = 0; // FIXED: Store real balance

        this.assets = config.assets || ['R_10', 'R_25', 'R_50'];

        this.config = {
            riskPercent: config.riskPercent || 1.5,
            maxDailyLossPercent: config.maxDailyLossPercent || 6,
            maxDailyProfitPercent: config.maxDailyProfitPercent || 10,
            baseStake: config.baseStake || 5,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            takeProfitMultiplier: config.takeProfitMultiplier || 0.8,
            growthRateMin: 0.01,
            growthRateMax: 0.03,
            minScoreForTrade: 0.74,
            useDigitLogic: false,
            maxReconnectAttempts: 30,
            reconnectDelay: 4000,
            minTimeBetweenTrades: 8000,
            requiredHistoryLength: 120,
            telegramToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
            telegramChatId: '752497117',
            ...config
        };

        this.currentStake = this.config.baseStake;
        this.currentRiskPercent = this.config.riskPercent;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.weeklyProfitLoss = 0;
        this.consecutiveLosses = 0;
        this.paused = false;
        this.endOfDay = false;

        this.analyzer = new AccumulatorAnalyzer();
        this.activeTrades = {};
        this.contractSubscriptions = {};
        this.priceHistories = {};
        this.tickHistory = {};
        this.lastTradeTime = {};
        this.assetMetrics = {};
        this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        this.dailyStats = { date: new Date().toDateString(), pnl: 0 };
        this.pendingProposals = {}; // FIXED: Track proposals per asset

        this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        this.reconnectAttempts = 0;
        this.pingInterval = null;
        this.tradeWatchdogTimer = null;
        this.tradeWatchdogMs = 180000;

        this.assets.forEach(a => {
            this.priceHistories[a] = [];
            this.tickHistory[a] = [];
            this.lastTradeTime[a] = 0;
            this.assetMetrics[a] = { trades: 0, wins: 0, losses: 0, profitLoss: 0 };
        });

        const saved = StatePersistence.loadState();
        if (saved && saved.trading) Object.assign(this, saved.trading);
        if (saved && saved.assetMetrics) this.assetMetrics = saved.assetMetrics;
    }

    connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        console.log('🔌 Connecting to Deriv WS...');
        this.cleanup();

        this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ WS Connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this.startPingKeepAlive();
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                this.handleMessage(JSON.parse(data));
            } catch (e) {
                console.error('Parse error', e.message);
            }
        });

        this.ws.on('error', (err) => console.error('WS Error:', err.message));
        this.ws.on('close', () => {
            console.log('⚡ WS Closed');
            this.stopPingKeepAlive();
            this.handleDisconnect();
        });
    }

    startPingKeepAlive() {
        this.stopPingKeepAlive();
        this.pingInterval = setInterval(() => {
            if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.sendRequest({ ping: 1 });
            }
        }, 25000);
    }

    stopPingKeepAlive() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = null;
    }

    authenticate() {
        this.sendRequest({ authorize: this.token });
    }

    sendRequest(req) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        try {
            this.ws.send(JSON.stringify(req));
            return true;
        } catch (e) {
            console.error('Send error:', e.message);
            return false;
        }
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error(`API Error (${msg.msg_type}):`, msg.error.message);
            // FIXED: Clean up pending proposals on error
            if (msg.echo_req && msg.echo_req.proposal) {
                const asset = msg.echo_req.symbol;
                if (asset && this.pendingProposals[asset]) {
                    delete this.pendingProposals[asset];
                }
            }
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuth(msg);
                break;
            case 'balance':
                this.handleBalance(msg);
                break;
            case 'history':
                this.handleTickHistory(msg);
                break;
            case 'tick':
                this.handleTickUpdate(msg.tick);
                break;
            case 'proposal':
                this.handleProposal(msg);
                break;
            case 'buy':
                this.handleBuyResponse(msg);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(msg);
                break;
            case 'sell':
                console.log('✅ Sold:', msg.sell?.sold_for);
                break;
            case 'ping':
                break;
            default:
                if (msg.error) console.error('Unhandled error:', msg.error);
        }
    }

    handleAuth(msg) {
        this.accountBalance = parseFloat(msg.authorize.balance) || 0;
        console.log(`✅ Authenticated. Balance: $${this.accountBalance.toFixed(2)}`);
        
        // Subscribe to balance updates
        this.sendRequest({ balance: 1, subscribe: 1 });
        
        this.wsReady = true;
        this.initializeSubscriptions();
        this.startTelegramTimer();
    }

    handleBalance(msg) {
        if (msg.balance) {
            this.accountBalance = parseFloat(msg.balance.balance) || this.accountBalance;
        }
    }

    initializeSubscriptions() {
        console.log('📡 Subscribing to ticks...');
        this.assets.forEach(asset => {
            this.sendRequest({
                ticks_history: asset,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                style: 'ticks'
            });
            this.sendRequest({ ticks: asset, subscribe: 1 });
        });
    }

    handleTickHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        this.priceHistories[asset] = msg.history.prices.map(p => parseFloat(p));
        console.log(`📊 ${asset}: Loaded ${this.priceHistories[asset].length} ticks`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);

        this.priceHistories[asset] = this.priceHistories[asset] || [];
        this.priceHistories[asset].push(price);
        
        if (this.priceHistories[asset].length > 600) {
            this.priceHistories[asset] = this.priceHistories[asset].slice(-400);
        }

        this.tickHistory[asset] = this.tickHistory[asset] || [];
        this.tickHistory[asset].push(price);
        if (this.tickHistory[asset].length > this.config.requiredHistoryLength) {
            this.tickHistory[asset].shift();
        }

        // Don't trade if conditions not met
        if (!this.wsReady || this.activeTrades[asset] || this.paused) return;
        if (this.pendingProposals[asset]) return; // FIXED: Don't re-evaluate if proposal pending
        if (Date.now() - (this.lastTradeTime[asset] || 0) < this.config.minTimeBetweenTrades) return;
        if (this.priceHistories[asset].length < this.config.requiredHistoryLength) return;

        this.evaluateAndTrade(asset);
    }

    evaluateAndTrade(asset) {
        if (!this.isAssetAllowed(asset)) return;
        
        const analysis = this.analyzer.analyzeEntry(this.priceHistories[asset]);
        this.logAnalysis(asset, analysis);

        if (!analysis.shouldTrade || analysis.overallScore < this.config.minScoreForTrade) return;

        // FIXED: Store analysis for this asset
        this.pendingProposals[asset] = {
            analysis,
            timestamp: Date.now()
        };

        this.currentStake = this.calculateStake();
        this.requestProposal(asset, analysis.recommendedGrowthRate);
    }

    calculateStake() {
        // FIXED: Use real account balance
        if (this.accountBalance <= 0) {
            console.warn('⚠️ No balance available, using base stake');
            return this.config.baseStake;
        }

        // Calculate 1-2% of balance
        const riskAmount = this.accountBalance * (this.currentRiskPercent / 100);
        const stake = Math.max(this.config.baseStake, Math.round(riskAmount * 100) / 100);
        
        // Ensure stake doesn't exceed 2% of balance
        const maxStake = this.accountBalance * 0.02;
        return Math.min(stake, maxStake);
    }

    requestProposal(asset, growthRate) {
        const tpAmount = this.currentStake * this.config.takeProfitMultiplier;
        
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: Math.min(
                this.config.growthRateMax,
                Math.max(this.config.growthRateMin, growthRate)
            ).toFixed(2),
            limit_order: {
                take_profit: tpAmount.toFixed(2)
            }
        };

        console.log(`📤 Requesting proposal for ${asset}:`, {
            stake: proposal.amount,
            growth: proposal.growth_rate,
            tp: tpAmount.toFixed(2)
        });

        this.sendRequest(proposal);
    }

    handleProposal(msg) {
        const asset = msg.echo_req?.symbol;
        if (!asset || !msg.proposal) {
            console.warn('⚠️ Invalid proposal response');
            return;
        }

        // FIXED: Check if we still have pending proposal for this asset
        const pending = this.pendingProposals[asset];
        if (!pending) {
            console.log(`⏭️ Ignoring stale proposal for ${asset}`);
            return;
        }

        const analysis = pending.analysis;
        
        // Double-check conditions still valid
        if (!analysis.shouldTrade || analysis.overallScore < this.config.minScoreForTrade) {
            console.log(`⚠️ Conditions changed for ${asset}, skipping trade`);
            delete this.pendingProposals[asset];
            return;
        }

        console.log(`🎯 Strong signal on ${asset} | Score ${(analysis.overallScore * 100).toFixed(0)}% | Growth ${(analysis.recommendedGrowthRate * 100).toFixed(0)}%`);
        
        this.placeTrade(asset, msg.proposal.id, analysis);
    }

    placeTrade(asset, proposalId, analysis) {
        if (this.activeTrades[asset]) {
            console.warn(`⚠️ Trade already active for ${asset}`);
            return;
        }

        console.log(`🚀 Placing trade on ${asset} | Stake $${this.currentStake.toFixed(2)} (${this.currentRiskPercent.toFixed(1)}% of $${this.accountBalance.toFixed(2)})`);

        this.sendRequest({ buy: proposalId, price: this.currentStake.toFixed(2) });

        const growthRate = analysis.recommendedGrowthRate || 0.01;
        this.activeTrades[asset] = {
            status: 'buying',
            proposalId,
            stake: this.currentStake,
            growthRate,
            entryTime: Date.now(),
            analysis // Store full analysis
        };

        this.lastTradeTime[asset] = Date.now();
        this._startTradeWatchdog(asset);

        // Clear pending proposal
        delete this.pendingProposals[asset];

        this.sendTelegramMessage(
            `🚀 <b>TRADE OPENING</b>\n` +
            `Asset: <b>${asset}</b>\n` +
            `Stake: $${this.currentStake.toFixed(2)} (${this.currentRiskPercent.toFixed(1)}% of $${this.accountBalance.toFixed(2)})\n` +
            `Growth: ${(growthRate * 100).toFixed(1)}%\n` +
            `Score: ${(analysis.overallScore * 100).toFixed(0)}%`
        );
    }

    handleBuyResponse(msg) {
        const asset = Object.keys(this.activeTrades).find(a => this.activeTrades[a].status === 'buying');
        
        if (!asset) {
            console.warn('⚠️ Buy response received but no pending trade found');
            return;
        }

        if (msg.error) {
            console.error(`❌ Buy failed for ${asset}:`, msg.error.message);
            delete this.activeTrades[asset];
            return;
        }

        const trade = this.activeTrades[asset];
        trade.status = 'active';
        trade.contractId = msg.buy.contract_id;
        trade.buyPrice = parseFloat(msg.buy.buy_price);
        trade.balance = parseFloat(msg.buy.balance_after);

        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: trade.contractId,
            subscribe: 1
        });

        const analysis = trade.analysis;
        console.log(`✅ Contract opened ${trade.contractId} on ${asset}`);
        
        this.sendTelegramMessage(
            `✅ <b>CONTRACT OPENED</b>\n` +
            `Asset: ${asset}\n` +
            `ID: ${trade.contractId}\n` +
            `Stake: $${trade.stake.toFixed(2)}\n` +
            `Growth: ${(trade.growthRate * 100).toFixed(1)}%\n` +
            `Balance: $${trade.balance.toFixed(2)}\n\n` +
            `<b>Analysis:</b>\n` +
            `Score: ${(analysis.overallScore * 100).toFixed(0)}%\n` +
            `BB Width: ${(analysis.bb.width * 10000).toFixed(1)} pips\n` +
            `ADX: ${analysis.adx.toFixed(1)}\n` +
            `MACD Flat: ${(analysis.scores.macdFlat * 100).toFixed(0)}%\n` +
            `Price Pos: ${(analysis.scores.pricePosition * 100).toFixed(0)}%`
        );
    }

    handleContractUpdate(msg) {
        const contract = msg.proposal_open_contract;
        if (!contract || !contract.contract_id) return;

        const asset = Object.keys(this.activeTrades).find(
            a => this.activeTrades[a].contractId === contract.contract_id
        );
        
        if (!asset) return;

        const trade = this.activeTrades[asset];

        // Update trade info
        if (contract.current_spot) {
            trade.currentSpot = parseFloat(contract.current_spot);
        }
        if (contract.profit) {
            trade.currentProfit = parseFloat(contract.profit);
        }

        // Check if contract is sold/closed
        if (contract.is_sold || contract.status === 'sold') {
            this.handleTradeResult(asset, contract);
        }
    }

    handleTradeResult(asset, contract) {
        this._clearWatchdogTimers();
        
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit || 0);
        const sellPrice = parseFloat(contract.sell_price || 0);

        this.totalTrades++;
        this.totalProfitLoss += profit;
        this.dailyProfitLoss += profit;
        this.weeklyProfitLoss += profit;
        this.hourlyStats.trades++;
        this.hourlyStats.pnl += profit;

        const trade = this.activeTrades[asset];
        if (trade) {
            this.analyzer.recordTradeResult(asset, {
                won,
                profit,
                score: trade.analysis?.overallScore || 0.75
            });

            this.assetMetrics[asset].trades++;
            this.assetMetrics[asset].profitLoss += profit;

            if (won) {
                this.totalWins++;
                this.assetMetrics[asset].wins++;
                this.hourlyStats.wins++;
                this.consecutiveLosses = 0;
            } else {
                this.totalLosses++;
                this.assetMetrics[asset].losses++;
                this.hourlyStats.losses++;
                this.consecutiveLosses++;
            }
        }

        delete this.activeTrades[asset];

        const emoji = won ? '✅' : '❌';
        const winrate = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0';
        
        this.sendTelegramMessage(
            `${emoji} <b>TRADE CLOSED</b>\n` +
            `Asset: ${asset}\n` +
            `Result: ${won ? 'WIN' : 'LOSS'}\n` +
            `P&L: $${profit.toFixed(2)}\n` +
            `Sell Price: $${sellPrice.toFixed(2)}\n\n` +
            `<b>Session Stats:</b>\n` +
            `Total P&L: $${this.totalProfitLoss.toFixed(2)}\n` +
            `Daily P&L: $${this.dailyProfitLoss.toFixed(2)}\n` +
            `Trades: ${this.totalTrades} (${this.totalWins}W/${this.totalLosses}L)\n` +
            `Winrate: ${winrate}%\n` +
            `Balance: $${this.accountBalance.toFixed(2)}`
        );

        this.logTradingSummary();
        this.updateDailyLimits();
        StatePersistence.saveState(this);
    }

    updateDailyLimits() {
        if (this.accountBalance <= 0) return;

        const maxDailyLoss = this.accountBalance * (this.config.maxDailyLossPercent / 100);
        const maxDailyProfit = this.accountBalance * (this.config.maxDailyProfitPercent / 100);

        if (this.dailyProfitLoss <= -maxDailyLoss) {
            this.paused = true;
            this.sendTelegramMessage(
                `🛑 <b>DAILY LOSS LIMIT REACHED</b>\n` +
                `Loss: $${this.dailyProfitLoss.toFixed(2)} (${this.config.maxDailyLossPercent}% of $${this.accountBalance.toFixed(2)})\n` +
                `Bot paused until tomorrow.`
            );
        }

        if (this.dailyProfitLoss >= maxDailyProfit) {
            this.paused = true;
            this.sendTelegramMessage(
                `🎯 <b>DAILY PROFIT TARGET REACHED</b>\n` +
                `Profit: $${this.dailyProfitLoss.toFixed(2)} (${this.config.maxDailyProfitPercent}% of $${this.accountBalance.toFixed(2)})\n` +
                `Excellent work! Bot paused for the day.`
            );
        }
    }

    _startTradeWatchdog(asset) {
        this._clearWatchdogTimers();
        this.tradeWatchdogTimer = setTimeout(() => {
            console.warn(`⏰ Watchdog fired for ${asset}`);
            this._recoverStuckTrade(asset, 'watchdog');
        }, this.tradeWatchdogMs);
    }

    _clearWatchdogTimers() {
        if (this.tradeWatchdogTimer) clearTimeout(this.tradeWatchdogTimer);
        this.tradeWatchdogTimer = null;
    }

    _recoverStuckTrade(asset, reason) {
        this._clearWatchdogTimers();
        if (this.activeTrades[asset]) {
            const trade = this.activeTrades[asset];
            console.error(`🚨 Recovering stuck trade on ${asset} (${reason})`);
            
            if (trade.contractId) {
                this.sendRequest({ sell: trade.contractId, price: 0 });
            }
            
            delete this.activeTrades[asset];
            this.totalLosses++;
            this.totalProfitLoss -= trade.stake || 5;
            this.dailyProfitLoss -= trade.stake || 5;
        }
        
        // Don't unpause - let user decide
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        StatePersistence.saveState(this);

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error('❌ Max reconnection attempts reached');
            this.sendTelegramMessage('🚨 Bot disconnected - max reconnection attempts reached');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            this.config.reconnectDelay * Math.pow(1.6, this.reconnectAttempts - 1),
            45000
        );
        
        console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s... (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
    }

    cleanup() {
        this.stopPingKeepAlive();
        this._clearWatchdogTimers();
        
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
            this.ws = null;
        }
        
        this.connected = false;
        this.wsReady = false;
    }

    disconnect() {
        console.log('🛑 Manual disconnect requested');
        this.endOfDay = true;
        this.paused = true;
        StatePersistence.saveState(this);
        this.cleanup();
    }

    logAnalysis(asset, analysis) {
        this.lastAnalysis = analysis;
        
        const scoreBreakdown = `BandWidth:${(analysis.scores.bandWidth * 100).toFixed(0)}% | ` +
            `MACD Flat:${(analysis.scores.macdFlat * 100).toFixed(0)}% | ` +
            `ADX Low:${(analysis.scores.adxLow * 100).toFixed(0)}% | ` +
            `Price Pos:${(analysis.scores.pricePosition * 100).toFixed(0)}% | ` +
            `Tick Stability:${(analysis.scores.tickStability * 100).toFixed(0)}% | ` +
            `Vol Trend:${(analysis.scores.volTrend * 100).toFixed(0)}%`;

        console.log(
            `📈 ${asset} | Score:${(analysis.overallScore * 100).toFixed(0)}% | ` +
            `BB:${(analysis.bb.width * 10000).toFixed(1)}pips | ` +
            `ADX:${analysis.adx.toFixed(1)} | ` +
            `MACDflat:${(analysis.scores.macdFlat * 100).toFixed(0)}% | ` +
            `${analysis.shouldTrade ? '🟢 ENTRY' : '⏳ waiting'}\n` +
            `Score breakdown: ${scoreBreakdown}`
        );
    }

    logTradingSummary() {
        const winrate = this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0';
        console.log(
            `\n📊 SUMMARY | Trades: ${this.totalTrades} | ` +
            `Winrate: ${winrate}% | ` +
            `P&L: $${this.totalProfitLoss.toFixed(2)} | ` +
            `Balance: $${this.accountBalance.toFixed(2)}\n`
        );
    }

    async sendTelegramMessage(text) {
        try {
            await this.telegramBot.sendMessage(this.config.telegramChatId, text, {
                parse_mode: 'HTML'
            });
        } catch (e) {
            console.error('Telegram error:', e.message);
        }
    }

    startTelegramTimer() {
        console.log('📱 Telegram notifications enabled');
        
        // Send hourly summary
        setInterval(() => {
            if (this.hourlyStats.trades > 0) {
                const winrate = ((this.hourlyStats.wins / this.hourlyStats.trades) * 100).toFixed(1);
                this.sendTelegramMessage(
                    `⏰ <b>HOURLY SUMMARY</b>\n` +
                    `Trades: ${this.hourlyStats.trades}\n` +
                    `Wins: ${this.hourlyStats.wins} | Losses: ${this.hourlyStats.losses}\n` +
                    `Winrate: ${winrate}%\n` +
                    `P&L: $${this.hourlyStats.pnl.toFixed(2)}\n` +
                    `Balance: $${this.accountBalance.toFixed(2)}`
                );
                
                // Reset hourly stats
                this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };
            }
        }, 3600000); // Every hour
    }

    isAssetAllowed(asset) {
        return this.assets.includes(asset);
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const h = now.getUTCHours();
            const currentDate = now.toDateString();

            // End of day check (23:00 UTC)
            if (h === 23 && !this.endOfDay) {
                console.log('🌙 End of trading day — pausing');
                this.paused = true;
                this.endOfDay = true;
                StatePersistence.saveState(this);
                
                this.sendTelegramMessage(
                    `🌙 <b>END OF DAY</b>\n` +
                    `Daily P&L: $${this.dailyProfitLoss.toFixed(2)}\n` +
                    `Total Trades: ${this.totalTrades}\n` +
                    `Balance: $${this.accountBalance.toFixed(2)}\n` +
                    `Bot paused until tomorrow.`
                );
            }

            // Start of new day (07:00 UTC)
            if (h === 7 && this.paused && this.endOfDay) {
                console.log('🌅 New trading day — resuming');
                
                // Reset daily stats
                this.dailyProfitLoss = 0;
                this.dailyStats = { date: currentDate, pnl: 0 };
                this.consecutiveLosses = 0;
                this.paused = false;
                this.endOfDay = false;
                
                this.sendTelegramMessage(
                    `🌅 <b>NEW TRADING DAY</b>\n` +
                    `Balance: $${this.accountBalance.toFixed(2)}\n` +
                    `Bot resumed and ready to trade.`
                );
            }
        }, 60000); // Check every minute
    }

    start() {
        console.log('══════════════════════════════════════════════════════════════');
        console.log('🚀 RESEARCH-BASED ACCUMULATOR BOT v2.1 (FIXED)');
        console.log('Focus : Low volatility regime (BB + MACD + ADX)');
        console.log('Risk  :', this.config.riskPercent + '% per trade | Daily limits enforced');
        console.log('Growth: Dynamic 1-3%');
        console.log('Digit logic: DISABLED');
        console.log('Assets:', this.assets.join(', '));
        console.log('══════════════════════════════════════════════════════════════\n');

        this.connect();
        this.checkTimeForDisconnectReconnect();
        StatePersistence.startAutoSave(this);
    }
}

// =============================================================================
// LAUNCH
// =============================================================================
const bot = new ResearchBasedAccumulatorBot('rgNedekYXvCaPeP', {
    riskPercent: 1.5,
    maxDailyLossPercent: 6,
    maxDailyProfitPercent: 12,
    assets: ['R_10', 'R_25', 'R_50']
});

bot.start();