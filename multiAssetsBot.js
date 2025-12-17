#!/usr/bin/env node

/**
 * Deriv.com Multi-Asset AI Trading Bot - Light Version
 * No TensorFlow dependency - uses rule-based AI instead
 */

const WebSocket = require('ws');
const math = require('mathjs');
const fs = require('fs');

// ==================== CONFIGURATION ====================

const CONFIG = {
    // API Configuration
    appId: 1089,
    apiToken: '0P94g4WdSrSrzir', //process.env.DERIV_TOKEN || '0P94g4WdSrSrzir',
    websocketUrl: 'wss://ws.derivws.com/websockets/v3',

    // Trading Configuration
    initialCapital: 500,
    maxDailyLossPercent: 5,
    dailyProfitTargetPercent: 2.5,
    maxRiskPerTradePercent: 2,
    maxOpenPositions: 5,

    // Asset Universe Configuration
    assets: {
        // Synthetic Indices
        'R_10': {
            type: 'synthetic',
            emaShort: 8,
            emaLong: 21,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 15, // minutes
            maxDailyTrades: 2,
            subscription: 'candles',
            granularity: 60, // 1 minute candles
            correlationGroup: 'volatility'
        },
        'R_25': {
            type: 'synthetic',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 20,
            maxDailyTrades: 2,
            subscription: 'candles',
            granularity: 60,
            correlationGroup: 'volatility'
        },
        'R_75': {
            type: 'synthetic',
            emaShort: 12,
            emaLong: 30,
            rsiPeriod: 21,
            rsiThreshold: 40,
            duration: 30,
            maxDailyTrades: 1,
            subscription: 'candles',
            granularity: 60,
            correlationGroup: 'volatility'
        },
        'BOOM1000': {
            type: 'synthetic',
            emaShort: 5,
            emaLong: 15,
            rsiPeriod: 7,
            rsiThreshold: 30,
            duration: 5,
            maxDailyTrades: 3,
            subscription: 'candles',
            granularity: 60,
            correlationGroup: 'boom_crash'
        },
        'CRASH1000': {
            type: 'synthetic',
            emaShort: 5,
            emaLong: 15,
            rsiPeriod: 7,
            rsiThreshold: 30,
            duration: 5,
            maxDailyTrades: 3,
            subscription: 'candles',
            granularity: 60,
            correlationGroup: 'boom_crash'
        },
        // Major Forex
        'frxEURUSD': {
            type: 'forex',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 240, // 4 hours
            maxDailyTrades: 1,
            subscription: 'candles',
            granularity: 300, // 5 minute candles
            correlationGroup: 'eur_usd'
        },
        'frxGBPUSD': {
            type: 'forex',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 240,
            maxDailyTrades: 1,
            subscription: 'candles',
            granularity: 300,
            correlationGroup: 'gbp_usd'
        },
        'frxUSDJPY': {
            type: 'forex',
            emaShort: 10,
            emaLong: 25,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 240,
            maxDailyTrades: 1,
            subscription: 'candles',
            granularity: 300,
            correlationGroup: 'usd_jpy'
        },
        // Commodities
        'WTI': {
            type: 'commodity',
            emaShort: 15,
            emaLong: 35,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 60, // 1 hour
            maxDailyTrades: 2,
            subscription: 'candles',
            granularity: 300,
            correlationGroup: 'commodities'
        },
        'XAUUSD': {
            type: 'commodity',
            emaShort: 15,
            emaLong: 35,
            rsiPeriod: 14,
            rsiThreshold: 35,
            duration: 60,
            maxDailyTrades: 2,
            subscription: 'candles',
            granularity: 300,
            correlationGroup: 'commodities'
        }
    },

    // AI and Scoring Configuration
    aiConfidenceThreshold: 0.60,
    assetScoringInterval: 300000, // 5 minutes
    portfolioRebalanceInterval: 14400000, // 4 hours
    maxCandleHistory: 200,

    // Scoring Weights
    scoringWeights: {
        recentWinRate: 0.30,
        trendStrength: 0.25,
        volatilityFit: 0.20,
        predictability: 0.25
    }
};

// ==================== STATE MANAGEMENT ====================

class StateManager {
    constructor() {
        this.state = {
            capital: CONFIG.initialCapital,
            initialCapital: CONFIG.initialCapital,
            connection: null,
            isRunning: false,
            lastAssetScoreTime: 0,
            lastPortfolioRebalanceTime: 0,

            // Asset-specific state
            assets: {},

            // Portfolio state
            portfolio: {
                dailyLoss: 0,
                dailyProfit: 0,
                activePositions: [],
                dailyTrades: 0,
                lastResetDate: new Date().toDateString(),
                blacklistedAssets: new Set(),
                assetCooldowns: new Map()
            },

            // Ranking
            assetRankings: [],
            currentTopAssets: []
        };

        // Initialize asset states
        Object.keys(CONFIG.assets).forEach(symbol => {
            this.state.assets[symbol] = {
                symbol,
                config: CONFIG.assets[symbol],
                candles: [],
                emaShort: 0,
                emaLong: 0,
                rsi: 50,
                dailyTrades: 0,
                dailyWinRate: 0.55,
                recentWinRate: 0.55,
                trendStrength: 0.5,
                volatility: 0,
                predictability: 0.5,
                lastSignal: null,
                consecutiveLosses: 0,
                lastTradeTime: 0,
                score: 0,
                isSubscribed: false
            };
        });

        // Load persisted state if exists
        this.loadState();
    }

    getState() {
        return this.state;
    }

    updateAsset(symbol, updates) {
        Object.assign(this.state.assets[symbol], updates);
        this.persistState();
    }

    addPosition(position) {
        this.state.portfolio.activePositions.push(position);
        this.state.portfolio.dailyTrades++;
        this.persistState();
    }

    closePosition(contractId, profit) {
        const position = this.state.portfolio.activePositions.find(p => p.contractId === contractId);
        if (position) {
            const capitalChange = profit - position.amount;
            this.state.capital += capitalChange;

            if (capitalChange > 0) {
                this.state.portfolio.dailyProfit += capitalChange;
                this.state.assets[position.symbol].consecutiveLosses = 0;
            } else {
                this.state.portfolio.dailyLoss += Math.abs(capitalChange);
                this.state.assets[position.symbol].consecutiveLosses++;
            }

            // Update win rate
            const asset = this.state.assets[position.symbol];
            const isWin = capitalChange > 0;
            asset.recentWinRate = this.calculateRollingWinRate(asset, isWin);

            this.state.portfolio.activePositions = this.state.portfolio.activePositions.filter(
                p => p.contractId !== contractId
            );

            this.persistState();
            return capitalChange;
        }
        return 0;
    }

    calculateRollingWinRate(asset, latestResult) {
        // Simple exponential moving average of win rate
        const alpha = 0.1; // Smoothing factor
        const currentRate = asset.recentWinRate || 0.55;
        const newResult = latestResult ? 1 : 0;
        return currentRate * (1 - alpha) + newResult * alpha;
    }

    resetDailyStats() {
        const today = new Date().toDateString();
        if (this.state.portfolio.lastResetDate !== today) {
            this.state.portfolio.dailyLoss = 0;
            this.state.portfolio.dailyProfit = 0;
            this.state.portfolio.dailyTrades = 0;
            this.state.portfolio.lastResetDate = today;

            Object.values(this.state.assets).forEach(asset => {
                asset.dailyTrades = 0;
            });

            this.state.portfolio.blacklistedAssets.clear();
            this.state.portfolio.assetCooldowns.clear();

            this.persistState();
        }
    }

    blacklistAsset(symbol, hours = 48) {
        this.state.portfolio.blacklistedAssets.add(symbol);
        setTimeout(() => {
            this.state.portfolio.blacklistedAssets.delete(symbol);
        }, hours * 3600000);
        this.persistState();
    }

    setCooldown(symbol, hours = 4) {
        this.state.portfolio.assetCooldowns.set(symbol, Date.now() + hours * 3600000);
        this.persistState();
    }

    isInCooldown(symbol) {
        const cooldownTime = this.state.portfolio.assetCooldowns.get(symbol);
        if (!cooldownTime) return false;
        if (Date.now() > cooldownTime) {
            this.state.portfolio.assetCooldowns.delete(symbol);
            return false;
        }
        return true;
    }

    persistState() {
        try {
            const serialized = JSON.stringify(this.state, (key, value) => {
                if (value instanceof Set) {
                    return Array.from(value);
                }
                if (value instanceof Map) {
                    return Object.fromEntries(value);
                }
                return value;
            });
            fs.writeFileSync('bot-state.json', serialized);
        } catch (error) {
            console.error('Failed to persist state:', error.message);
        }
    }

    loadState() {
        try {
            if (fs.existsSync('bot-state.json')) {
                const data = fs.readFileSync('bot-state.json', 'utf8');
                const loaded = JSON.parse(data);

                // Restore Set and Map objects
                loaded.portfolio.blacklistedAssets = new Set(loaded.portfolio.blacklistedAssets || []);
                loaded.portfolio.assetCooldowns = new Map(Object.entries(loaded.portfolio.assetCooldowns || {}));

                // Merge with current state
                this.state = { ...this.state, ...loaded };
            }
        } catch (error) {
            console.error('Failed to load state:', error.message);
        }
    }
}

// ==================== DERIV API CLIENT ====================

class DerivAPI {
    constructor(stateManager) {
        this.ws = null;
        this.stateManager = stateManager;
        this.state = stateManager.getState();
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.subscriptions = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(`${CONFIG.websocketUrl}?app_id=${CONFIG.appId}`);

                this.ws.on('open', () => {
                    console.log('Connected to Deriv API');
                    this.authenticate();
                });

                this.ws.on('message', (data) => {
                    const response = JSON.parse(data);
                    this.handleMessage(response);
                });

                this.ws.on('close', () => {
                    console.log('Disconnected from Deriv API');
                    this.reconnect();
                });

                this.ws.on('error', (error) => {
                    console.error('WebSocket error:', error);
                    reject(error);
                });

                // Wait for authentication
                const checkAuth = setInterval(() => {
                    if (this.state.connection?.authorized) {
                        clearInterval(checkAuth);
                        resolve();
                    }
                }, 1000);

            } catch (error) {
                reject(error);
            }
        });
    }

    authenticate() {
        const authRequest = {
            authorize: CONFIG.apiToken,
            req_id: this.requestId++
        };
        this.send(authRequest);
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const reqId = message.req_id || this.requestId++;
            message.req_id = reqId;

            if (message.subscribe || message.buy) {
                this.pendingRequests.set(reqId, message);
            }

            this.ws.send(JSON.stringify(message));
            return reqId;
        }
        return null;
    }

    handleMessage(response) {
        const { req_id, msg_type, error } = response;

        if (error) {
            console.error('API Error:', error.message);
            return;
        }

        if (msg_type === 'authorize') {
            this.state.connection = { authorized: true, account: response.authorize };
            console.log('Authenticated successfully');
            this.subscribeToBalance();
        }

        if (req_id && this.pendingRequests.has(req_id)) {
            const request = this.pendingRequests.get(req_id);

            if (msg_type === 'buy') {
                this.handleBuyResponse(response, request);
            } else if (msg_type === 'proposal') {
                this.handleProposalResponse(response, request);
            }

            this.pendingRequests.delete(req_id);
        }

        if (response.subscription && this.subscriptions.has(response.subscription.id)) {
            const handler = this.subscriptions.get(response.subscription.id);
            handler(response);
        }
    }

    subscribeToBalance() {
        const request = { balance: 1, subscribe: 1, req_id: this.requestId++ };
        const reqId = this.send(request);

        if (reqId) {
            this.subscriptions.set(reqId, (response) => {
                if (response.balance) {
                    this.state.capital = parseFloat(response.balance.balance);
                }
            });
        }
    }

    subscribeToAsset(symbol) {
        if (this.state.assets[symbol].isSubscribed) return;

        const config = CONFIG.assets[symbol];
        const request = {
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.maxCandleHistory,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: config.granularity,
            subscribe: 1,
            req_id: this.requestId++
        };

        const reqId = this.send(request);
        if (reqId) {
            this.subscriptions.set(reqId, (response) => {
                this.handleCandleResponse(symbol, response);
            });
            this.state.assets[symbol].isSubscribed = true;
            console.log(`Subscribed to ${symbol}`);
        }
    }

    handleCandleResponse(symbol, response) {
        if (response.candles) {
            const asset = this.state.assets[symbol];
            asset.candles = response.candles.slice(-CONFIG.maxCandleHistory);

            // Calculate indicators
            this.calculateIndicators(symbol);
        }

        if (response.candle) {
            const asset = this.state.assets[symbol];
            const candles = asset.candles;

            // Update with new candle
            const newCandle = response.candle;
            if (candles.length > 0 && candles[candles.length - 1].epoch === newCandle.epoch) {
                candles[candles.length - 1] = newCandle;
            } else {
                candles.push(newCandle);
                if (candles.length > CONFIG.maxCandleHistory) {
                    candles.shift();
                }
            }

            this.calculateIndicators(symbol);
        }
    }

    calculateIndicators(symbol) {
        const asset = this.state.assets[symbol];
        const candles = asset.candles;

        if (candles.length < Math.max(asset.config.emaLong, asset.config.rsiPeriod)) {
            return;
        }

        // Calculate EMAs
        const closes = candles.map(c => c.close);
        asset.emaShort = this.calculateEMA(closes, asset.config.emaShort);
        asset.emaLong = this.calculateEMA(closes, asset.config.emaLong);

        // Calculate RSI
        asset.rsi = this.calculateRSI(closes, asset.config.rsiPeriod);

        // Calculate volatility
        asset.volatility = this.calculateVolatility(closes);

        // Calculate trend strength
        asset.trendStrength = this.calculateTrendStrength(candles);

        // Check for signals
        this.checkTradeSignal(symbol);
    }

    calculateEMA(prices, period) {
        const k = 2 / (period + 1);
        let ema = prices[0];

        for (let i = 1; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
        }

        return ema;
    }

    calculateRSI(prices, period) {
        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateVolatility(prices) {
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
        }

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

        return Math.sqrt(variance);
    }

    calculateTrendStrength(candles) {
        if (candles.length < 20) return 0.5;

        const recent = candles.slice(-10);
        const highs = recent.map(c => c.high);
        const lows = recent.map(c => c.low);

        const highTrend = this.calculateEMA(highs, 5);
        const lowTrend = this.calculateEMA(lows, 5);

        const trendSlope = (highTrend - lowTrend) / recent.length;
        const normalizedSlope = Math.abs(trendSlope) / recent[recent.length - 1].close;

        return Math.min(normalizedSlope * 100, 1);
    }

    checkTradeSignal(symbol) {
        const asset = this.state.assets[symbol];
        const portfolioManager = global.portfolioManager;

        if (!portfolioManager) return;

        // Only trade top-2 ranked assets
        if (!portfolioManager.isTopRanked(symbol)) return;

        // Check asset-specific limits
        if (asset.dailyTrades >= asset.config.maxDailyTrades) return;

        // Check cooldown
        if (this.stateManager.isInCooldown(symbol)) return;

        // Check blacklist
        if (this.state.portfolio.blacklistedAssets.has(symbol)) return;

        // Check correlation constraints
        if (!portfolioManager.canTradeAsset(symbol)) return;

        // Check EMA crossover
        const candles = asset.candles;
        if (candles.length < 3) return;

        const prevClose = candles[candles.length - 2].close;
        const currentClose = candles[candles.length - 1].close;

        const prevEmaShort = this.calculateEMA(candles.slice(0, -1).map(c => c.close), asset.config.emaShort);
        const prevEmaLong = this.calculateEMA(candles.slice(0, -1).map(c => c.close), asset.config.emaLong);
        const currentEmaShort = asset.emaShort;
        const currentEmaLong = asset.emaLong;

        let signal = null;

        // CALL: Short EMA crosses above Long EMA and RSI below threshold
        if (prevEmaShort <= prevEmaLong && currentEmaShort > currentEmaLong && asset.rsi < asset.config.rsiThreshold) {
            signal = 'CALL';
        }

        // PUT: Short EMA crosses below Long EMA and RSI above (100 - threshold)
        if (prevEmaShort >= prevEmaLong && currentEmaShort < currentEmaLong && asset.rsi > (100 - asset.config.rsiThreshold)) {
            signal = 'PUT';
        }

        if (signal) {
            console.log(`Signal detected: ${signal} on ${symbol}`);
            portfolioManager.evaluateTradeSignal(symbol, signal);
        }
    }

    async sendProposal(symbol, signal) {
        const asset = this.state.assets[symbol];
        const portfolioManager = global.portfolioManager;
        const stake = portfolioManager.calculateStake(symbol);

        const proposal = {
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: signal,
            currency: 'USD',
            duration: asset.config.duration,
            duration_unit: 'm',
            symbol: symbol,
            req_id: this.requestId++
        };

        const reqId = this.send(proposal);
        if (reqId) {
            this.pendingRequests.set(reqId, { symbol, signal, stake });
        }
    }

    handleProposalResponse(response, request) {
        if (response.proposal) {
            // Check AI confidence (rule-based)
            const aiModel = global.aiEngine;
            const confidence = aiModel.predict(request.symbol, request.signal);

            if (confidence > CONFIG.aiConfidenceThreshold) {
                this.buyContract(response.proposal.id, request);
            } else {
                console.log(`AI rejected trade on ${request.symbol}: confidence ${confidence.toFixed(2)}`);
            }
        }
    }

    buyContract(proposalId, request) {
        const buyRequest = {
            buy: proposalId,
            price: request.stake,
            req_id: this.requestId++
        };

        const reqId = this.send(buyRequest);
        if (reqId) {
            this.pendingRequests.set(reqId, request);
        }
    }

    handleBuyResponse(response, request) {
        if (response.buy) {
            const position = {
                contractId: response.buy.contract_id,
                symbol: request.symbol,
                signal: request.signal,
                amount: request.stake,
                entryTime: Date.now(),
                entryPrice: response.buy.price
            };

            this.stateManager.addPosition(position);
            this.state.assets[request.symbol].dailyTrades++;

            console.log(`Trade executed: ${request.signal} on ${request.symbol} for $${request.stake}`);

            // Subscribe to contract updates
            this.subscribeToContract(response.buy.contract_id);
        }
    }

    subscribeToContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
            req_id: this.requestId++
        };

        const reqId = this.send(request);
        if (reqId) {
            this.subscriptions.set(reqId, (response) => {
                this.handleContractUpdate(response);
            });
        }
    }

    handleContractUpdate(response) {
        if (response.proposal_open_contract) {
            const contract = response.proposal_open_contract;

            if (contract.is_sold) {
                const profit = parseFloat(contract.profit);
                const capitalChange = this.stateManager.closePosition(contract.contract_id, profit);

                console.log(`Contract ${contract.contract_id} closed: P&L $${capitalChange.toFixed(2)}`);

                // Check risk limits
                global.riskManager.checkLimits();
            }
        }
    }

    reconnect() {
        console.log('Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
            this.connect().catch(error => {
                console.error('Reconnection failed:', error.message);
            });
        }, 5000);
    }
}

// ==================== AI ENGINE (RULE-BASED) ====================

class AIEngine {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.state = stateManager.getState();
    }

    predict(symbol, signal) {
        const asset = this.state.assets[symbol];

        if (!asset.candles || asset.candles.length < 10) {
            return 0.5;
        }

        // Rule-based confidence scoring
        const confidence = this.calculateRuleBasedConfidence(asset, signal);

        // Update predictability score
        asset.predictability = confidence;

        return confidence;
    }

    calculateRuleBasedConfidence(asset, signal) {
        let confidence = 0.5; // Base confidence

        // Factor 1: Trend alignment (30% weight)
        const trendScore = this.calculateTrendAlignment(asset, signal);
        confidence += trendScore * 0.3;

        // Factor 2: Volatility regime fit (25% weight)
        const volScore = this.calculateVolatilityFit(asset);
        confidence += volScore * 0.25;

        // Factor 3: Recent win rate (25% weight)
        confidence += asset.recentWinRate * 0.25;

        // Factor 4: RSI extreme (20% weight)
        const rsiScore = this.calculateRSIScore(asset);
        confidence += rsiScore * 0.2;

        // Factor 5: Confluence bonus (if multiple factors align)
        const confluenceBonus = this.calculateConfluenceBonus(asset, signal);
        confidence += confluenceBonus * 0.1;

        return Math.max(0, Math.min(1, confidence));
    }

    calculateTrendAlignment(asset, signal) {
        // Stronger trend = higher confidence
        const trendStrength = asset.trendStrength;

        if (signal === 'CALL') {
            // Bullish trend alignment
            return asset.emaShort > asset.emaLong ? trendStrength : 0.3;
        } else {
            // Bearish trend alignment
            return asset.emaShort < asset.emaLong ? trendStrength : 0.3;
        }
    }

    calculateVolatilityFit(asset) {
        const vol = asset.volatility || 0.01;
        const type = asset.config.type;

        // Optimal volatility per asset type
        const optimalVol = {
            'synthetic': 0.02,
            'forex': 0.01,
            'commodity': 0.015
        };

        const targetVol = optimalVol[type] || 0.015;
        const distance = Math.abs(vol - targetVol);

        // Score decreases as volatility deviates from optimal
        return Math.max(0, 1 - distance * 50);
    }

    calculateRSIScore(asset) {
        const rsi = asset.rsi;
        const threshold = asset.config.rsiThreshold;

        // Stronger RSI extremes = higher confidence
        if (rsi < threshold * 0.7 || rsi > (100 - threshold * 0.7)) {
            return 1.0; // Strong signal
        } else if (rsi < threshold || rsi > (100 - threshold)) {
            return 0.7; // Moderate signal
        }
        return 0.4; // Weak signal
    }

    calculateConfluenceBonus(asset, signal) {
        let bonus = 0;
        let factors = 0;

        // EMA alignment
        if ((signal === 'CALL' && asset.emaShort > asset.emaLong) ||
            (signal === 'PUT' && asset.emaShort < asset.emaLong)) {
            factors++;
        }

        // RSI extreme
        if (asset.rsi < asset.config.rsiThreshold * 0.8 ||
            asset.rsi > (100 - asset.config.rsiThreshold * 0.8)) {
            factors++;
        }

        // Volatility fit
        if (this.calculateVolatilityFit(asset) > 0.7) {
            factors++;
        }

        // Trend strength
        if (asset.trendStrength > 0.6) {
            factors++;
        }

        // Bonus based on number of confluence factors
        if (factors >= 4) bonus = 0.3;
        else if (factors >= 3) bonus = 0.2;
        else if (factors >= 2) bonus = 0.1;

        return bonus;
    }
}

// ==================== PORTFOLIO MANAGER ====================

class PortfolioManager {
    constructor(stateManager, apiClient) {
        this.stateManager = stateManager;
        this.state = stateManager.getState();
        this.apiClient = apiClient;
        this.riskManager = global.riskManager;
    }

    scoreAssets() {
        console.log('Scoring assets...');

        Object.values(this.state.assets).forEach(asset => {
            if (!asset.candles || asset.candles.length < 20) {
                asset.score = 0;
                return;
            }

            // Calculate components
            const recentWinRate = asset.recentWinRate;
            const trendStrength = asset.trendStrength;
            const volatilityFit = this.calculateVolatilityFit(asset);
            const predictability = asset.predictability || 0.5;

            // Calculate weighted score
            const score =
                recentWinRate * CONFIG.scoringWeights.recentWinRate +
                trendStrength * CONFIG.scoringWeights.trendStrength +
                volatilityFit * CONFIG.scoringWeights.volatilityFit +
                predictability * CONFIG.scoringWeights.predictability;

            asset.score = score;
        });

        // Rank assets (exclude blacklisted)
        this.state.assetRankings = Object.values(this.state.assets)
            .filter(asset => !this.state.portfolio.blacklistedAssets.has(asset.symbol))
            .sort((a, b) => b.score - a.score)
            .map(asset => asset.symbol);

        // Select top 2
        this.state.currentTopAssets = this.state.assetRankings.slice(0, 2);

        console.log(`Top assets: ${this.state.currentTopAssets.join(', ')}`);

        // Subscribe to top assets if not already
        this.state.currentTopAssets.forEach(symbol => {
            this.apiClient.subscribeToAsset(symbol);
        });
    }

    calculateVolatilityFit(asset) {
        // Prefer moderate volatility for most assets
        const optimalVolatility = asset.config.type === 'synthetic' ? 0.02 : 0.01;
        const vol = asset.volatility || 0.01;

        // Gaussian-like scoring around optimal volatility
        const distance = Math.abs(vol - optimalVolatility);
        return Math.max(0, 1 - distance * 50);
    }

    isTopRanked(symbol) {
        return this.state.currentTopAssets.includes(symbol);
    }

    canTradeAsset(symbol) {
        const asset = this.state.assets[symbol];
        const activePositions = this.state.portfolio.activePositions;

        // Check correlation constraints
        const correlationGroup = asset.config.correlationGroup;
        const sameGroupPositions = activePositions.filter(
            p => this.state.assets[p.symbol].config.correlationGroup === correlationGroup
        );

        // Prevent simultaneous trades in correlated assets
        if (correlationGroup === 'volatility' && sameGroupPositions.length > 0) {
            return false;
        }

        if (correlationGroup === 'boom_crash' && sameGroupPositions.length > 0) {
            return false;
        }

        if (correlationGroup === 'eur_usd' || correlationGroup === 'gbp_usd') {
            const forexPositions = activePositions.filter(
                p => this.state.assets[p.symbol].config.type === 'forex'
            );
            if (forexPositions.length > 0) return false;
        }

        return true;
    }

    calculateStake(symbol) {
        const asset = this.state.assets[symbol];
        const rankings = this.state.assetRankings;
        const rankIndex = rankings.indexOf(symbol);

        // Total risk per cycle: 2% of capital
        const totalRiskAmount = this.state.capital * (CONFIG.maxRiskPerTradePercent / 100);

        // Allocate based on ranking
        const allocationRatio = rankIndex === 0 ? 0.6 : 0.4;
        const stake = totalRiskAmount * allocationRatio;

        // Apply Kelly Criterion adjustment
        const kellyFraction = this.kellyCriterion(asset);
        const adjustedStake = stake * kellyFraction;

        // Ensure minimum stake
        return Math.max(0.35, Math.min(adjustedStake, this.state.capital * 0.05));
    }

    kellyCriterion(asset) {
        const winRate = asset.recentWinRate;
        const avgWin = 0.8; // Assume 80% payout
        const avgLoss = 1; // 100% loss on losing trades

        if (avgLoss === 0) return 0.5;

        const kelly = (winRate * avgWin - (1 - winRate) * avgLoss) / avgLoss;

        // Use half Kelly for safety
        return Math.max(0.1, Math.min(kelly * 0.5, 0.25));
    }

    evaluateTradeSignal(symbol, signal) {
        // Check if we can open new position
        if (this.state.portfolio.activePositions.length >= CONFIG.maxOpenPositions) {
            console.log('Max open positions reached');
            return;
        }

        // Check daily risk limits
        if (!this.riskManager.canOpenNewTrade()) {
            console.log('Daily risk limits reached');
            return;
        }

        // Check asset daily limit
        const asset = this.state.assets[symbol];
        if (asset.dailyTrades >= asset.config.maxDailyTrades) {
            console.log(`${symbol} daily trade limit reached`);
            return;
        }

        // Send proposal
        this.apiClient.sendProposal(symbol, signal);
    }

    rebalancePortfolio() {
        console.log('Rebalancing portfolio...');

        // Re-score assets
        this.scoreAssets();

        // Adjust allocations if needed
        // (Implementation would adjust position sizes here)
    }
}

// ==================== RISK MANAGER ====================

class RiskManager {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.state = stateManager.getState();
    }

    canOpenNewTrade() {
        const dailyLoss = this.state.portfolio.dailyLoss;
        const dailyProfit = this.state.portfolio.dailyProfit;
        const capital = this.state.capital;

        // Check daily loss limit
        const maxDailyLoss = capital * (CONFIG.maxDailyLossPercent / 100);
        if (dailyLoss >= maxDailyLoss) {
            console.log(`Daily loss limit reached: $${dailyLoss.toFixed(2)} / $${maxDailyLoss.toFixed(2)}`);
            return false;
        }

        // Check profit target (lock 50% of gains)
        const profitTarget = capital * (CONFIG.dailyProfitTargetPercent / 100);
        if (dailyProfit >= profitTarget) {
            console.log(`Daily profit target reached: $${dailyProfit.toFixed(2)} / $${profitTarget.toFixed(2)}`);
            return false;
        }

        return true;
    }

    checkLimits() {
        const capital = this.state.capital;
        const initialCapital = this.state.initialCapital;

        // Check if we need to stop for the day
        const maxDailyLoss = initialCapital * (CONFIG.maxDailyLossPercent / 100);
        if (this.state.portfolio.dailyLoss >= maxDailyLoss) {
            console.log('🛑 DAILY LOSS LIMIT REACHED - STOPPING TRADING');
            this.state.isRunning = false;
        }

        // Check profit target
        const profitTarget = initialCapital * (CONFIG.dailyProfitTargetPercent / 100);
        if (this.state.portfolio.dailyProfit >= profitTarget) {
            console.log('🎯 DAILY PROFIT TARGET REACHED - LOCKING GAINS');
            // Continue trading but be more conservative
        }

        // Check individual asset risk
        Object.values(this.state.assets).forEach(asset => {
            // Blacklist if win rate drops below 50% over 20 trades
            if (asset.dailyTrades >= 20 && asset.recentWinRate < 0.5) {
                console.log(`Blacklisting ${asset.symbol} due to low win rate`);
                this.stateManager.blacklistAsset(asset.symbol);
            }

            // Set cooldown after 3 consecutive losses
            if (asset.consecutiveLosses >= 3) {
                console.log(`Setting cooldown for ${asset.symbol} after 3 consecutive losses`);
                this.stateManager.setCooldown(asset.symbol);
                asset.consecutiveLosses = 0;
            }
        });
    }

    calculatePositionSize(symbol) {
        // This is called by PortfolioManager
        // Implement additional risk checks here if needed
        return true;
    }
}

// ==================== MAIN BOT ====================

class DerivMultiAssetBot {
    constructor() {
        this.stateManager = new StateManager();
        this.state = this.stateManager.getState();
        this.apiClient = new DerivAPI(this.stateManager);
        this.aiEngine = new AIEngine(this.stateManager);
        this.portfolioManager = new PortfolioManager(this.stateManager, this.apiClient);
        this.riskManager = new RiskManager(this.stateManager);

        // Make globally accessible
        global.portfolioManager = this.portfolioManager;
        global.riskManager = this.riskManager;
        global.aiEngine = this.aiEngine;
        global.stateManager = this.stateManager;

        this.scoringInterval = null;
        this.rebalanceInterval = null;
        this.dailyResetInterval = null;
    }

    async start() {
        console.log('🚀 Starting Deriv Multi-Asset AI Trading Bot (Light Version)');
        console.log(`Initial Capital: $${this.state.capital}`);
        console.log(`Max Daily Loss: ${CONFIG.maxDailyLossPercent}%`);
        console.log(`Daily Profit Target: ${CONFIG.dailyProfitTargetPercent}%`);

        try {
            // Connect to Deriv API
            await this.apiClient.connect();

            // Initial scoring
            this.portfolioManager.scoreAssets();

            // Start intervals
            this.startIntervals();

            this.state.isRunning = true;
            console.log('✅ Bot is running');

            // Handle graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n🛑 Shutting down bot...');
                this.stop();
                process.exit(0);
            });

        } catch (error) {
            console.error('❌ Failed to start bot:', error.message);
            process.exit(1);
        }
    }

    startIntervals() {
        // Asset scoring every 5 minutes
        this.scoringInterval = setInterval(() => {
            if (this.state.isRunning) {
                this.portfolioManager.scoreAssets();
            }
        }, CONFIG.assetScoringInterval);

        // Portfolio rebalancing every 4 hours
        this.rebalanceInterval = setInterval(() => {
            if (this.state.isRunning) {
                this.portfolioManager.rebalancePortfolio();
            }
        }, CONFIG.portfolioRebalanceInterval);

        // Daily reset check every hour
        this.dailyResetInterval = setInterval(() => {
            this.stateManager.resetDailyStats();
        }, 3600000);

        // Initial daily reset check
        this.stateManager.resetDailyStats();
    }

    stop() {
        this.state.isRunning = false;

        if (this.scoringInterval) {
            clearInterval(this.scoringInterval);
        }

        if (this.rebalanceInterval) {
            clearInterval(this.rebalanceInterval);
        }

        if (this.dailyResetInterval) {
            clearInterval(this.dailyResetInterval);
        }

        // Close WebSocket connection
        if (this.apiClient.ws) {
            this.apiClient.ws.close();
        }

        // Persist final state
        this.stateManager.persistState();

        console.log('Bot stopped');
    }

    getStatus() {
        return {
            capital: this.state.capital,
            dailyProfit: this.state.portfolio.dailyProfit,
            dailyLoss: this.state.portfolio.dailyLoss,
            activePositions: this.state.portfolio.activePositions.length,
            topAssets: this.state.currentTopAssets,
            isRunning: this.state.isRunning
        };
    }
}

// ==================== MAIN EXECUTION ====================

if (require.main === module) {
    // Check for required dependencies
    const requiredDeps = ['ws', 'mathjs'];
    const missingDeps = [];

    requiredDeps.forEach(dep => {
        try {
            require.resolve(dep);
        } catch (e) {
            missingDeps.push(dep);
        }
    });

    if (missingDeps.length > 0) {
        console.error('❌ Missing dependencies. Please install:');
        console.error(`npm install ${missingDeps.join(' ')}`);
        process.exit(1);
    }

    // Check for API token
    // if (!process.env.DERIV_TOKEN && CONFIG.apiToken === '0P94g4WdSrSrzir') {
    //     console.error('❌ No API token provided. Set DERIV_TOKEN environment variable or update CONFIG.apiToken');
    //     process.exit(1);
    // }

    // Start the bot
    const bot = new DerivMultiAssetBot();

    bot.start().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });

    // Expose bot instance for monitoring
    module.exports = bot;
}

// Also export for module usage
module.exports = DerivMultiAssetBot;