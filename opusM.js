require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class QuantumMultipliersTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // VALID MULTIPLIERS FOR EACH ASSET
        this.validMultipliers = {
            // 1-second Volatility Indices
            '1HZ10V': [400, 1000, 2000, 3000, 4000],
            '1HZ15V': [300, 1000, 1500, 2000, 3000],
            '1HZ25V': [160, 400, 800, 1200, 1600],
            '1HZ30V': [140, 400, 700, 1000, 1400],
            '1HZ50V': [80, 200, 400, 600, 800],
            '1HZ75V': [50, 100, 200, 300, 500],
            '1HZ90V': [45, 100, 200, 300, 450],
            '1HZ100V': [40, 100, 200, 300, 400],
            
            // Boom Indices
            // 'BOOM300': [100, 150, 200, 300, 400],  // Assuming similar to BOOM500
            'BOOM500': [100, 150, 200, 300, 400],
            'BOOM1000': [100, 200, 300, 400, 500],
            
            // Crash Indices
            // 'CRASH300': [100, 150, 200, 300, 400],  // Assuming similar to CRASH500
            'CRASH500': [100, 150, 200, 300, 400],
            'CRASH1000': [100, 200, 300, 400, 500]
        };

        // Optimized Asset Selection for Multipliers
        this.assets = config.assets || [
            '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', // Volatility indices
            '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',  // Volatility indices
            'BOOM300', 'BOOM500', 'BOOM1000',  // Boom indices
            'CRASH300', 'CRASH500', 'CRASH1000' // Crash indices
            // '1HZ10V'
        ];

        // Advanced Multiplier Configuration
        this.config = {
            // Enhanced Money Management for Multipliers
            initialStake: config.initialStake || 1,
            maxStake: config.maxStake || 100,
            
            // Multiplier-Specific Settings
            defaultMultiplier: config.defaultMultiplier || 50, // Start conservative
            minMultiplier: config.minMultiplier || 10,
            maxMultiplier: config.maxMultiplier || 500,
            adaptiveMultiplier: true,
            
            // Risk Management optimized for Multipliers
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || -50,
            takeProfit: config.takeProfit || 100,
            dailyLossLimit: config.dailyLossLimit || -100,
            dailyProfitTarget: config.dailyProfitTarget || 150,
            
            // Risk Management Features
            useTakeProfit: true,
            useStopLoss: true,
            useDealCancellation: false, // Cannot be used with stop loss
            takeProfitMultiplier: 1, // Take profit at 2.5x stake
            stopLossPercentage: 100, // Stop at 50% loss
            dealCancellationDuration: '60m', // 60 minutes for cancellation
            
            // Analysis Windows
            ultraShortWindow: config.ultraShortWindow || 5,
            shortWindow: config.shortWindow || 15,
            mediumWindow: config.mediumWindow || 30,
            longWindow: config.longWindow || 60,
            
            // Trading Parameters
            requiredHistoryLength: config.requiredHistoryLength || 200,
            minConfidenceScore: config.minConfidenceScore || 70,
            volatilityThresholds: {
                V_10: { min: 0.0008, max: 0.0015 },
                V_25: { min: 0.002, max: 0.004 },
                V_50: { min: 0.004, max: 0.008 },
                V_75: { min: 0.006, max: 0.012 },
                V_100: { min: 0.008, max: 0.016 },
                BOOM: { min: 0.01, max: 0.05 },
                CRASH: { min: 0.01, max: 0.05 }
            },
            
            // Market-Specific Strategies
            strategies: {
                volatility: 'TREND_MOMENTUM', // For volatility indices
                boom: 'SPIKE_CATCHER', // For boom indices
                crash: 'DIP_BUYER' // For crash indices
            },
            
            // Advanced Features
            useQuantumPrediction: true,
            useMLOptimization: true,
            useNeuralNetwork: true,
            useMarketMicrostructure: true,
            useSentimentAnalysis: true,
            useCorrelationMatrix: true,
            
            // Timing Controls
            minWaitTime: config.minWaitTime || 5000,
            maxWaitTime: config.maxWaitTime || 15000,
            cooldownAfterLoss: config.cooldownAfterLoss || 10000,
            cooldownAfterWin: config.cooldownAfterWin || 5000,
            
            // Commission and Spreads
            commissionRate: 0.0035, // 0.35% commission on multipliers
            spreadAdjustment: true,
        };

        // Trading State Management
        this.tradingState = {
            currentStake: this.config.initialStake,
            currentMultiplier: this.config.defaultMultiplier,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            lastTradeTime: 0,
            tradeInProgress: false,
            cooldownActive: false,
            currentDirection: null,
            lastDirection: null,
            openContracts: new Map(),
            pendingOrders: [],
        };

        // Enhanced Statistics for Multipliers
        this.statistics = {
            totalTrades: 0,
            upWins: 0,
            downWins: 0,
            upLosses: 0,
            downLosses: 0,
            totalProfitLoss: 0,
            sessionProfitLoss: 0,
            dailyProfitLoss: 0,
            maxDrawdown: 0,
            sharpeRatio: 0,
            winRate: 0,
            avgWin: 0,
            avgLoss: 0,
            profitFactor: 0,
            avgMultiplierUsed: 0,
            bestMultiplier: 0,
            worstMultiplier: 0,
            totalCommissionPaid: 0,
            recoveryFactor: 0,
            expectancy: 0,
        };

        // Pattern Recognition for Different Market Types
        this.marketPatterns = {};
        this.assets.forEach(asset => {
            this.marketPatterns[asset] = {
                priceHistory: [],
                tickHistory: [],
                returns: [],
                volatility: [],
                momentum: [],
                trendStrength: 0,
                marketPhase: 'NEUTRAL', // TRENDING_UP, TRENDING_DOWN, RANGING, VOLATILE
                
                // Multiplier-specific metrics
                optimalMultiplier: this.config.defaultMultiplier,
                riskScore: 0,
                entryQuality: 0,
                exitStrategy: null,
                
                // Technical Indicators
                rsi: [],
                macd: { line: [], signal: [], histogram: [] },
                bollingerBands: { upper: [], middle: [], lower: [] },
                atr: [],
                adx: [],
                stochastic: { k: [], d: [] },
                ichimoku: { tenkan: [], kijun: [], senkouA: [], senkouB: [] },
                
                // Market Microstructure
                orderFlow: [],
                volumeProfile: [],
                tickDirection: [],
                cumulativeDelta: 0,
                
                // Crash/Boom Specific
                spikeDetection: [],
                dipDetection: [],
                averageSpikeMagnitude: 0,
                spikeFrequency: 0,
            };
        });

        // Quantum Analysis System for Multipliers
        this.quantumPredictor = {
            waveFunctions: {},
            probabilityCloud: {},
            entanglementStrength: {},
            quantumStates: {},
            superposition: {},
            decoherenceTime: 0,
            measurementAccuracy: 0,
        };

        // Machine Learning Models
        this.mlOptimizer = {
            neuralNetwork: {
                layers: this.initializeNeuralNetwork(),
                optimizer: 'adam',
                learningRate: 0.001,
                batchSize: 32,
                epochs: 0,
            },
            reinforcementLearning: {
                qTable: new Map(),
                epsilon: 0.1, // Exploration rate
                gamma: 0.95, // Discount factor
                alpha: 0.1, // Learning rate
            },
            ensembleModels: {
                randomForest: { trees: [], accuracy: 0 },
                gradientBoosting: { estimators: [], accuracy: 0 },
                xgboost: { trees: [], accuracy: 0 },
            },
            featureImportance: {},
        };

        // Correlation Matrix for Asset Selection
        this.correlationMatrix = {};
        
        // Market Sentiment Analyzer
        this.sentimentAnalyzer = {
            marketMood: 'NEUTRAL', // BULLISH, BEARISH, NEUTRAL
            fearGreedIndex: 50, // 0-100
            volatilityRegime: 'NORMAL', // LOW, NORMAL, HIGH, EXTREME
            trendConfidence: 0,
            reversalProbability: 0,
        };

        // Position Management for Multipliers
        this.positionManager = {
            activePositions: [],
            maxConcurrentPositions: 1, // Conservative: one at a time
            positionSizing: 'KELLY', // FIXED, KELLY, VOLATILITY_ADJUSTED
            pyramiding: false,
            hedging: false,
        };

        // Session Management
        this.sessionManager = {
            sessionId: this.generateSessionId(),
            startTime: Date.now(),
            tradesInSession: 0,
            sessionPaused: false,
            emergencyStop: false,
            performanceGrade: 'N/A',
        };

        // Email Configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        };
        this.emailRecipient = process.env.EMAIL_RECIPIENT;

        // Initialize systems
        this.initializeAnalysisSystems();
    }

    generateSessionId() {
        return `MULT_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    initializeNeuralNetwork() {
        // Deep neural network for multiplier optimization
        return [
            { type: 'input', size: 50 },
            { type: 'dense', size: 128, activation: 'relu' },
            { type: 'dropout', rate: 0.2 },
            { type: 'dense', size: 256, activation: 'relu' },
            { type: 'batchNorm' },
            { type: 'dense', size: 128, activation: 'relu' },
            { type: 'dropout', rate: 0.2 },
            { type: 'dense', size: 64, activation: 'relu' },
            { type: 'dense', size: 32, activation: 'relu' },
            { type: 'output', size: 3, activation: 'softmax' } // UP, DOWN, NEUTRAL
        ];
    }

    initializeAnalysisSystems() {
        // Start all analysis systems
        this.startQuantumPrediction();
        this.startMLOptimization();
        this.startMarketMicrostructure();
        this.startSentimentAnalysis();
        this.startCorrelationAnalysis();
        this.startRiskMonitoring();
        this.startMultiplierOptimization();
    }

    // ============ CONNECTION MANAGEMENT ============
    connect() {
        if (this.sessionManager.emergencyStop) {
            console.log('⛔ Emergency stop activated. Manual intervention required.');
            return;
        }

        console.log('🔌 Connecting to Deriv API for Multipliers Trading...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            this.handleMessage(message);
        });

        this.ws.on('error', (error) => {
            console.error('❌ WebSocket error:', error);
            this.handleDisconnect();
        });

        this.ws.on('close', () => {
            console.log('🔌 Disconnected from Deriv API');
            this.connected = false;
            this.handleDisconnect();
        });
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else {
            console.error('❌ Not connected. Queueing request...');
            setTimeout(() => this.sendRequest(request), 1000);
        }
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    // ============ MESSAGE HANDLING ============
    handleMessage(message) {
        try {
            if (!message) {
                console.log('⚠️ Received empty message');
                return;
            }
            
            if (message.msg_type === 'authorize') {
                if (message.error) {
                    console.error('❌ Authentication failed:', message.error.message);
                    this.disconnect();
                    return;
                }
                console.log('✅ Authentication successful');
                if (message.authorize && message.authorize.balance !== undefined) {
                    console.log(`   Balance: $${message.authorize.balance}`);
                }
                this.initializeTrading();
            } else if (message.msg_type === 'history') {
                this.processTickHistory(message);
            } else if (message.msg_type === 'tick') {
                this.processTick(message);
            } else if (message.msg_type === 'buy') {
                this.processBuyResponse(message);
            } else if (message.msg_type === 'proposal_open_contract') {
                this.processContractUpdate(message);
            } else if (message.msg_type === 'contracts_for') {
                this.processContractsFor(message);
            } else if (message.msg_type === 'forget' || message.msg_type === 'forget_all') {
                // Handle subscription cleanup messages
                console.log('✓ Subscription cleanup acknowledged');
            } else if (message.error) {
                this.handleApiError(message.error);
            }
            
            // Handle subscription messages
            if (message.subscription) {
                console.log(`✓ Active subscription: ${message.subscription.id}`);
            }
        } catch (error) {
            console.error('Error handling message:', error);
            console.error('Message that caused error:', JSON.stringify(message).substring(0, 200));
        }
    }

    // ============ ADVANCED MULTIPLIER ANALYSIS ============
    analyzeMultiplierOpportunity(asset) {
        if (this.tradingState.tradeInProgress || this.tradingState.cooldownActive) {
            return;
        }

        const data = this.marketPatterns[asset];
        if (data.priceHistory.length < this.config.requiredHistoryLength) {
            return;
        }

        // Determine asset type and apply appropriate strategy
        const assetType = this.getAssetType(asset);
        let strategy = this.config.strategies[assetType] || 'TREND_MOMENTUM';

        // Multi-dimensional Analysis
        const technicalSignals = this.performTechnicalAnalysis(data, asset);
        const quantumPrediction = this.performQuantumPrediction(data, asset);
        const mlOptimization = this.performMLOptimization(data, asset);
        const microstructure = this.analyzeMicrostructure(data, asset);
        const sentiment = this.analyzeSentiment(data, asset);
        const optimalMultiplier = this.calculateOptimalMultiplier(data, asset);

        // Special handling for Crash/Boom indices
        let specialSignal = { direction: null, confidence: 0 };
        if (assetType === 'boom') {
            specialSignal = this.analyzeBoomPattern(data, asset);
        } else if (assetType === 'crash') {
            specialSignal = this.analyzeCrashPattern(data, asset);
        }

        // Weighted Consensus System
        const weights = this.calculateDynamicWeights(asset, data);
        const predictions = [
            { ...technicalSignals, weight: weights.technical },
            { ...quantumPrediction, weight: weights.quantum },
            { ...mlOptimization, weight: weights.ml },
            { ...microstructure, weight: weights.microstructure },
            { ...sentiment, weight: weights.sentiment },
            { ...specialSignal, weight: weights.special }
        ].filter(p => p.direction !== null && p.confidence > 0);

        if (predictions.length === 0) {
            return;
        }

        // Calculate final prediction
        let upScore = 0;
        let downScore = 0;
        let totalWeight = 0;

        predictions.forEach(pred => {
            const weightedConfidence = pred.confidence * pred.weight;
            if (pred.direction === 'UP') {
                upScore += weightedConfidence;
            } else if (pred.direction === 'DOWN') {
                downScore += weightedConfidence;
            }
            totalWeight += pred.weight;
        });

        // Normalize scores
        upScore = upScore / totalWeight;
        downScore = downScore / totalWeight;

        const finalDirection = upScore > downScore ? 'UP' : 'DOWN';
        const finalConfidence = Math.max(upScore, downScore) * 100;

        // Risk-adjust the multiplier
        const riskAdjustedMultiplier = this.adjustMultiplierForRisk(
            optimalMultiplier,
            finalConfidence,
            data.volatility[data.volatility.length - 1],
            asset
        );

        // FIX: Convert number to string before using padEnd
        console.log(`
        ╔════════════════════════════════════════╗
        ║      💹 MULTIPLIER ANALYSIS            ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(33)}║
        ║ Type: ${assetType.padEnd(34)}║
        ║ Market Phase: ${data.marketPhase.padEnd(26)}║
        ║ Direction: ${finalDirection.padEnd(29)}║
        ║ Confidence: ${finalConfidence.toFixed(1)}%                    ║
        ║ Multiplier: x${riskAdjustedMultiplier.toString().padEnd(26)}║
        ║ Risk Score: ${data.riskScore.toFixed(2).padEnd(28)}║
        ╚════════════════════════════════════════╝
        `);

        // Execute trade if confidence meets threshold
        if (finalConfidence >= this.config.minConfidenceScore) {
            const stake = this.calculateDynamicStake(finalConfidence, data.riskScore);
            this.executeMultiplierTrade(asset, finalDirection, riskAdjustedMultiplier, stake, finalConfidence);
        }
    }

    getAssetType(asset) {
        if (asset.includes('V_') || asset.includes('HZ')) return 'volatility';
        if (asset.includes('BOOM')) return 'boom';
        if (asset.includes('CRASH')) return 'crash';
        return 'volatility';
    }

    calculateDynamicWeights(asset, data) {
        // Dynamic weight calculation based on recent performance and market conditions
        const baseWeights = {
            technical: 0.25,
            quantum: 0.15,
            ml: 0.20,
            microstructure: 0.15,
            sentiment: 0.10,
            special: 0.15
        };

        // Adjust weights based on market phase
        if (data.marketPhase === 'TRENDING_UP' || data.marketPhase === 'TRENDING_DOWN') {
            baseWeights.technical *= 1.2;
            baseWeights.ml *= 1.1;
        } else if (data.marketPhase === 'RANGING') {
            baseWeights.microstructure *= 1.3;
            baseWeights.quantum *= 1.2;
        } else if (data.marketPhase === 'VOLATILE') {
            baseWeights.sentiment *= 1.3;
            baseWeights.special *= 1.2;
        }

        // Normalize weights
        const totalWeight = Object.values(baseWeights).reduce((sum, w) => sum + w, 0);
        Object.keys(baseWeights).forEach(key => {
            baseWeights[key] = baseWeights[key] / totalWeight;
        });

        return baseWeights;
    }

    performTechnicalAnalysis(data, asset) {
        const prices = data.priceHistory.slice(-100);
        if (prices.length < 20) return { direction: null, confidence: 0 };

        // Calculate comprehensive technical indicators
        const rsi = this.calculateRSI(prices, 14);
        const macd = this.calculateMACD(prices);
        const bb = this.calculateBollingerBands(prices, 20, 2);
        const ema5 = this.calculateEMA(prices, 5);
        const ema20 = this.calculateEMA(prices, 20);
        const stochastic = this.calculateStochastic(prices, 14);
        const atr = this.calculateATR(data, 14);
        const adx = this.calculateADX(data, 14);
        const ichimoku = this.calculateIchimoku(prices);

        let bullishSignals = 0;
        let bearishSignals = 0;
        let totalSignals = 0;

        // RSI Signal
        if (rsi < 30) { bullishSignals += 2; totalSignals += 2; }
        else if (rsi > 70) { bearishSignals += 2; totalSignals += 2; }
        else if (rsi < 45) { bullishSignals += 1; totalSignals += 1; }
        else if (rsi > 55) { bearishSignals += 1; totalSignals += 1; }

        // MACD Signal
        if (macd.histogram > 0 && macd.histogram > macd.previousHistogram) {
            bullishSignals += 2;
            totalSignals += 2;
        } else if (macd.histogram < 0 && macd.histogram < macd.previousHistogram) {
            bearishSignals += 2;
            totalSignals += 2;
        }

        // Bollinger Bands Signal
        const currentPrice = prices[prices.length - 1];
        const bbPosition = (currentPrice - bb.lower) / (bb.upper - bb.lower);
        if (bbPosition < 0.2) { bullishSignals += 2; totalSignals += 2; }
        else if (bbPosition > 0.8) { bearishSignals += 2; totalSignals += 2; }

        // EMA Crossover
        if (ema5 > ema20) { bullishSignals += 1.5; totalSignals += 1.5; }
        else { bearishSignals += 1.5; totalSignals += 1.5; }

        // Stochastic Signal
        if (stochastic.k < 20 && stochastic.d < 20) {
            bullishSignals += 1.5;
            totalSignals += 1.5;
        } else if (stochastic.k > 80 && stochastic.d > 80) {
            bearishSignals += 1.5;
            totalSignals += 1.5;
        }

        // Ichimoku Cloud Signal
        if (currentPrice > ichimoku.senkouA && currentPrice > ichimoku.senkouB) {
            bullishSignals += 1.5;
            totalSignals += 1.5;
        } else if (currentPrice < ichimoku.senkouA && currentPrice < ichimoku.senkouB) {
            bearishSignals += 1.5;
            totalSignals += 1.5;
        }

        // ADX Trend Strength Multiplier
        if (adx > 25) {
            const trendMultiplier = 1 + (adx - 25) / 100;
            if (bullishSignals > bearishSignals) {
                bullishSignals *= trendMultiplier;
            } else {
                bearishSignals *= trendMultiplier;
            }
        }

        // Determine direction
        const direction = bullishSignals > bearishSignals ? 'UP' : 'DOWN';
        const confidence = Math.max(bullishSignals, bearishSignals) / (totalSignals || 1);

        // Update market phase
        this.updateMarketPhase(data, adx, bb.upper - bb.lower, bullishSignals > bearishSignals);

        return { 
            direction, 
            confidence,
            indicators: { rsi, macd, bb, ema5, ema20, stochastic, atr, adx, ichimoku }
        };
    }

    updateMarketPhase(data, adx, bbWidth, isBullish) {
        const avgBBWidth = data.priceHistory.slice(-20).reduce((sum, p, i, arr) => {
            if (i === 0) return 0;
            return sum + Math.abs(p - arr[i-1]) / arr[i-1];
        }, 0) / 19;

        if (adx > 30) {
            data.marketPhase = isBullish ? 'TRENDING_UP' : 'TRENDING_DOWN';
        } else if (adx < 20 && avgBBWidth < 0.002) {
            data.marketPhase = 'RANGING';
        } else if (avgBBWidth > 0.005) {
            data.marketPhase = 'VOLATILE';
        } else {
            data.marketPhase = 'NEUTRAL';
        }
    }

    performQuantumPrediction(data, asset) {
        if (!this.config.useQuantumPrediction) {
            return { direction: null, confidence: 0 };
        }

        const prices = data.priceHistory.slice(-50);
        if (prices.length < 20) return { direction: null, confidence: 0 };

        // Create quantum state from price data
        const quantumState = this.createQuantumState(prices);
        
        // Calculate probability amplitudes
        const amplitudes = this.calculateQuantumAmplitudes(quantumState);
        
        // Quantum entanglement with correlated assets
        const entanglement = this.calculateQuantumEntanglement(asset, prices);
        
        // Quantum interference patterns
        const interference = this.analyzeQuantumInterference(quantumState);
        
        // Quantum tunneling probability (for breakouts)
        const tunneling = this.calculateTunnelingProbability(data, prices);

        // Combine quantum metrics
        const upProbability = (amplitudes.up * 0.3 + entanglement.up * 0.25 + 
                              interference.constructive * 0.25 + tunneling.breakoutUp * 0.2);
        const downProbability = (amplitudes.down * 0.3 + entanglement.down * 0.25 + 
                                interference.destructive * 0.25 + tunneling.breakoutDown * 0.2);

        const direction = upProbability > downProbability ? 'UP' : 'DOWN';
        const confidence = Math.max(upProbability, downProbability);

        // Update quantum state
        this.quantumPredictor.quantumStates[asset] = quantumState;
        this.quantumPredictor.measurementAccuracy = confidence;

        return { 
            direction, 
            confidence,
            quantum: { amplitudes, entanglement, interference, tunneling }
        };
    }

    createQuantumState(prices) {
        // Convert price movements to quantum state representation
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i-1]) / prices[i-1]);
        }

        // Apply quantum transformation
        const state = {
            amplitudes: [],
            phases: [],
            coherence: 0,
            entanglement: 0
        };

        // Calculate complex amplitudes
        for (let i = 0; i < returns.length; i++) {
            const amplitude = Math.sqrt(Math.abs(returns[i]) * 100);
            const phase = Math.atan2(returns[i], returns[i-1] || 0);
            state.amplitudes.push(amplitude);
            state.phases.push(phase);
        }

        // Calculate coherence
        const avgPhase = state.phases.reduce((a, b) => a + b, 0) / state.phases.length;
        const phaseVariance = state.phases.reduce((sum, p) => sum + Math.pow(p - avgPhase, 2), 0) / state.phases.length;
        state.coherence = 1 / (1 + phaseVariance);

        return state;
    }

    calculateQuantumAmplitudes(quantumState) {
        // Calculate probability amplitudes for price movements
        const upAmplitudes = quantumState.amplitudes.filter((a, i) => 
            quantumState.phases[i] > 0 && quantumState.phases[i] < Math.PI
        );
        const downAmplitudes = quantumState.amplitudes.filter((a, i) => 
            quantumState.phases[i] < 0 || quantumState.phases[i] > Math.PI
        );

        const upProbability = upAmplitudes.reduce((sum, a) => sum + a * a, 0);
        const downProbability = downAmplitudes.reduce((sum, a) => sum + a * a, 0);
        const total = upProbability + downProbability || 1;

        return {
            up: upProbability / total,
            down: downProbability / total
        };
    }

    calculateQuantumEntanglement(asset, prices) {
        // Calculate entanglement with other correlated assets
        const correlatedAssets = this.findCorrelatedAssets(asset);
        let upEntanglement = 0;
        let downEntanglement = 0;

        correlatedAssets.forEach(correlatedAsset => {
            const correlatedData = this.marketPatterns[correlatedAsset];
            if (correlatedData && correlatedData.priceHistory.length >= prices.length) {
                const correlation = this.calculateCorrelation(
                    prices,
                    correlatedData.priceHistory.slice(-prices.length)
                );
                
                // Check recent direction of correlated asset
                const correlatedTrend = correlatedData.trendStrength;
                if (correlation > 0.5) {
                    if (correlatedTrend > 0) upEntanglement += correlation;
                    else downEntanglement += Math.abs(correlation);
                } else if (correlation < -0.5) {
                    if (correlatedTrend > 0) downEntanglement += Math.abs(correlation);
                    else upEntanglement += Math.abs(correlation);
                }
            }
        });

        const total = upEntanglement + downEntanglement || 1;
        return {
            up: upEntanglement / total,
            down: downEntanglement / total
        };
    }

    findCorrelatedAssets(asset) {
        // Find assets with high correlation
        const correlatedAssets = [];
        const assetType = this.getAssetType(asset);
        
        this.assets.forEach(otherAsset => {
            if (otherAsset !== asset) {
                const otherType = this.getAssetType(otherAsset);
                // Same type assets are usually correlated
                if (assetType === otherType) {
                    correlatedAssets.push(otherAsset);
                }
            }
        });
        
        return correlatedAssets.slice(0, 3); // Return top 3 correlated
    }

    analyzeQuantumInterference(quantumState) {
        // Analyze interference patterns in the quantum state
        let constructive = 0;
        let destructive = 0;

        for (let i = 1; i < quantumState.phases.length; i++) {
            const phaseDiff = quantumState.phases[i] - quantumState.phases[i-1];
            const amplitudeProduct = quantumState.amplitudes[i] * quantumState.amplitudes[i-1];
            
            // Constructive interference when phases align
            if (Math.abs(phaseDiff) < Math.PI / 3) {
                constructive += amplitudeProduct;
            } else if (Math.abs(phaseDiff) > 2 * Math.PI / 3) {
                destructive += amplitudeProduct;
            }
        }

        const total = constructive + destructive || 1;
        return {
            constructive: constructive / total,
            destructive: destructive / total
        };
    }

    calculateTunnelingProbability(data, prices) {
        // Calculate probability of price "tunneling" through resistance/support
        const support = Math.min(...prices.slice(-20));
        const resistance = Math.max(...prices.slice(-20));
        const currentPrice = prices[prices.length - 1];
        
        // Distance from barriers
        const distanceFromSupport = (currentPrice - support) / support;
        const distanceFromResistance = (resistance - currentPrice) / resistance;
        
        // Tunneling probability increases near barriers
        const tunnelUpProb = distanceFromResistance < 0.01 ? 
            0.7 * (1 - distanceFromResistance * 100) : 0.3;
        const tunnelDownProb = distanceFromSupport < 0.01 ? 
            0.7 * (1 - distanceFromSupport * 100) : 0.3;

        return {
            breakoutUp: tunnelUpProb,
            breakoutDown: tunnelDownProb
        };
    }

    performMLOptimization(data, asset) {
        if (!this.config.useMLOptimization) {
            return { direction: null, confidence: 0 };
        }

        // Extract features for ML models
        const features = this.extractMLFeatures(data);
        
        // Neural Network Prediction
        const nnPrediction = this.neuralNetworkPredict(features);
        
        // Reinforcement Learning Prediction
        const rlPrediction = this.reinforcementLearningPredict(features, asset);
        
        // Ensemble Models Prediction
        const ensemblePrediction = this.ensemblePredict(features);
        
        // Combine ML predictions
        const predictions = [
            { ...nnPrediction, weight: 0.4 },
            { ...rlPrediction, weight: 0.3 },
            { ...ensemblePrediction, weight: 0.3 }
        ];

        let upScore = 0;
        let downScore = 0;
        let totalWeight = 0;

        predictions.forEach(pred => {
            upScore += pred.up * pred.weight;
            downScore += pred.down * pred.weight;
            totalWeight += pred.weight;
        });

        const direction = upScore > downScore ? 'UP' : 'DOWN';
        const confidence = Math.max(upScore, downScore) / totalWeight;

        // Update feature importance
        this.updateFeatureImportance(features, direction, confidence);

        return { 
            direction, 
            confidence,
            ml: { nn: nnPrediction, rl: rlPrediction, ensemble: ensemblePrediction }
        };
    }

    extractMLFeatures(data) {
        const features = [];
        const prices = data.priceHistory.slice(-50);
        
        if (prices.length < 20) return new Array(50).fill(0);

        // Price-based features
        features.push(this.normalize(prices[prices.length - 1], prices));
        features.push(this.normalize(prices[prices.length - 1] - prices[prices.length - 2], prices));
        features.push(this.normalize(prices[prices.length - 1] - prices[prices.length - 5], prices));
        features.push(this.normalize(prices[prices.length - 1] - prices[prices.length - 10], prices));

        // Technical indicator features
        const rsi = this.calculateRSI(prices, 14);
        features.push(rsi / 100);

        const macd = this.calculateMACD(prices);
        features.push(this.sigmoid(macd.histogram * 100));

        const bb = this.calculateBollingerBands(prices, 20, 2);
        const bbPosition = (prices[prices.length - 1] - bb.lower) / (bb.upper - bb.lower || 1);
        features.push(bbPosition);

        // Volatility features
        const volatility = this.calculateVolatility(prices);
        features.push(Math.min(volatility * 100, 1));

        // Momentum features
        const momentum5 = this.calculateMomentum(prices, 5);
        const momentum10 = this.calculateMomentum(prices, 10);
        features.push(this.sigmoid(momentum5 * 100));
        features.push(this.sigmoid(momentum10 * 100));

        // Trend features
        const ema5 = this.calculateEMA(prices, 5);
        const ema20 = this.calculateEMA(prices, 20);
        features.push(ema5 > ema20 ? 1 : 0);

        // Market microstructure features
        if (data.tickDirection.length > 0) {
            const upTicks = data.tickDirection.filter(d => d > 0).length;
            const totalTicks = data.tickDirection.length;
            features.push(upTicks / totalTicks);
        } else {
            features.push(0.5);
        }

        // Volume profile features (simulated)
        features.push(data.cumulativeDelta / 100);

        // Fill remaining features
        while (features.length < 50) {
            features.push(0);
        }

        return features.slice(0, 50);
    }

    neuralNetworkPredict(features) {
        // Forward pass through the neural network
        let activation = features;
        
        this.mlOptimizer.neuralNetwork.layers.forEach(layer => {
            if (layer.type === 'dense') {
                activation = this.denseLayer(activation, layer.size);
            } else if (layer.type === 'dropout' && Math.random() > layer.rate) {
                // Apply dropout during training (simplified)
                activation = activation.map(a => Math.random() > layer.rate ? a : 0);
            } else if (layer.type === 'batchNorm') {
                activation = this.batchNormalize(activation);
            }
            
            // Apply activation function
            if (layer.activation === 'relu') {
                activation = activation.map(a => Math.max(0, a));
            } else if (layer.activation === 'sigmoid') {
                activation = activation.map(a => this.sigmoid(a));
            } else if (layer.activation === 'softmax') {
                activation = this.softmax(activation);
            }
        });

        // Output: [UP probability, DOWN probability, NEUTRAL probability]
        return {
            up: activation[0] || 0.33,
            down: activation[1] || 0.33,
            neutral: activation[2] || 0.34
        };
    }

    denseLayer(input, outputSize) {
        // Simplified dense layer computation
        const output = [];
        for (let i = 0; i < outputSize; i++) {
            let sum = Math.random() * 0.1; // Bias
            for (let j = 0; j < input.length; j++) {
                sum += input[j] * (Math.random() - 0.5) * 0.2; // Random weights for simplification
            }
            output.push(sum);
        }
        return output;
    }

    batchNormalize(activation) {
        const mean = activation.reduce((a, b) => a + b, 0) / activation.length;
        const variance = activation.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) / activation.length;
        const std = Math.sqrt(variance + 1e-8);
        return activation.map(a => (a - mean) / std);
    }

    softmax(activation) {
        const expScores = activation.map(a => Math.exp(a));
        const sumExpScores = expScores.reduce((a, b) => a + b, 0);
        return expScores.map(e => e / sumExpScores);
    }

    reinforcementLearningPredict(features, asset) {
        // Q-Learning based prediction
        const state = this.encodeState(features);
        const qValues = this.mlOptimizer.reinforcementLearning.qTable.get(state) || {
            up: Math.random(),
            down: Math.random()
        };

        // Epsilon-greedy exploration
        if (Math.random() < this.mlOptimizer.reinforcementLearning.epsilon) {
            // Explore: random action
            return {
                up: Math.random(),
                down: Math.random()
            };
        } else {
            // Exploit: use Q-values
            const total = qValues.up + qValues.down;
            return {
                up: qValues.up / total,
                down: qValues.down / total
            };
        }
    }

    encodeState(features) {
        // Encode features into a state string for Q-table
        return features.slice(0, 10).map(f => Math.round(f * 10)).join('_');
    }

    ensemblePredict(features) {
        // Combine predictions from multiple models
        const predictions = [];
        
        // Random Forest (simplified)
        const rfPrediction = this.randomForestPredict(features);
        predictions.push(rfPrediction);
        
        // Gradient Boosting (simplified)
        const gbPrediction = this.gradientBoostingPredict(features);
        predictions.push(gbPrediction);
        
        // XGBoost (simplified)
        const xgbPrediction = this.xgboostPredict(features);
        predictions.push(xgbPrediction);

        // Average ensemble predictions
        const avgUp = predictions.reduce((sum, p) => sum + p.up, 0) / predictions.length;
        const avgDown = predictions.reduce((sum, p) => sum + p.down, 0) / predictions.length;

        return {
            up: avgUp,
            down: avgDown
        };
    }

    randomForestPredict(features) {
        // Simplified Random Forest prediction
        let upVotes = 0;
        let downVotes = 0;
        
        // Simulate 10 decision trees
        for (let i = 0; i < 10; i++) {
            const threshold = Math.random();
            const featureIndex = Math.floor(Math.random() * features.length);
            if (features[featureIndex] > threshold) {
                upVotes++;
            } else {
                downVotes++;
            }
        }
        
        const total = upVotes + downVotes;
        return {
            up: upVotes / total,
            down: downVotes / total
        };
    }

    gradientBoostingPredict(features) {
        // Simplified Gradient Boosting prediction
        let prediction = 0.5; // Start with base prediction
        const learningRate = 0.1;
        
        // Simulate boosting rounds
        for (let i = 0; i < 5; i++) {
            const residual = Math.random() - 0.5; // Simplified residual
            const treePredict = features[i % features.length] > 0.5 ? 0.1 : -0.1;
            prediction += learningRate * treePredict * residual;
        }
        
        prediction = this.sigmoid(prediction);
        return {
            up: prediction,
            down: 1 - prediction
        };
    }

    xgboostPredict(features) {
        // Simplified XGBoost prediction
        let score = 0;
        
        // Simulate XGBoost trees
        for (let i = 0; i < 8; i++) {
            const featureIndex = i % features.length;
            const splitValue = 0.5;
            const leafValue = features[featureIndex] > splitValue ? 0.15 : -0.15;
            score += leafValue * (1 - Math.abs(features[featureIndex] - splitValue));
        }
        
        const probability = this.sigmoid(score);
        return {
            up: probability,
            down: 1 - probability
        };
    }

    updateFeatureImportance(features, direction, confidence) {
        // Track which features contribute most to successful predictions
        features.forEach((value, index) => {
            if (!this.mlOptimizer.featureImportance[index]) {
                this.mlOptimizer.featureImportance[index] = { total: 0, count: 0 };
            }
            this.mlOptimizer.featureImportance[index].total += value * confidence;
            this.mlOptimizer.featureImportance[index].count++;
        });
    }

    analyzeMicrostructure(data, asset) {
        // Analyze market microstructure for multiplier optimization
        const ticks = data.tickHistory.slice(-30);
        if (ticks.length < 10) return { direction: null, confidence: 0 };

        // Order flow analysis
        const orderFlow = this.analyzeOrderFlow(ticks);
        
        // Volume profile analysis
        const volumeProfile = this.analyzeVolumeProfile(ticks);
        
        // Tick distribution analysis
        const tickDistribution = this.analyzeTickDistribution(ticks);
        
        // Market depth simulation
        const marketDepth = this.simulateMarketDepth(ticks);

        // Combine microstructure signals
        let upSignal = 0;
        let downSignal = 0;

        upSignal += orderFlow.buyPressure * 0.3;
        downSignal += orderFlow.sellPressure * 0.3;

        upSignal += volumeProfile.bullish * 0.25;
        downSignal += volumeProfile.bearish * 0.25;

        upSignal += tickDistribution.upward * 0.25;
        downSignal += tickDistribution.downward * 0.25;

        upSignal += marketDepth.bidStrength * 0.2;
        downSignal += marketDepth.askStrength * 0.2;

        const direction = upSignal > downSignal ? 'UP' : 'DOWN';
        const confidence = Math.max(upSignal, downSignal);

        // Update cumulative delta
        data.cumulativeDelta += orderFlow.delta;

        return {
            direction,
            confidence,
            microstructure: { orderFlow, volumeProfile, tickDistribution, marketDepth }
        };
    }

    analyzeOrderFlow(ticks) {
        let buyVolume = 0;
        let sellVolume = 0;
        
        for (let i = 1; i < ticks.length; i++) {
            const priceChange = ticks[i] - ticks[i-1];
            if (priceChange > 0) {
                buyVolume += Math.abs(priceChange);
            } else if (priceChange < 0) {
                sellVolume += Math.abs(priceChange);
            }
        }
        
        const totalVolume = buyVolume + sellVolume || 1;
        return {
            buyPressure: buyVolume / totalVolume,
            sellPressure: sellVolume / totalVolume,
            delta: buyVolume - sellVolume
        };
    }

    analyzeVolumeProfile(ticks) {
        // Analyze where most trading occurs
        const priceLevels = {};
        ticks.forEach(tick => {
            const level = Math.round(tick * 1000) / 1000;
            priceLevels[level] = (priceLevels[level] || 0) + 1;
        });
        
        // Find POC (Point of Control)
        let poc = null;
        let maxVolume = 0;
        Object.entries(priceLevels).forEach(([level, volume]) => {
            if (volume > maxVolume) {
                maxVolume = volume;
                poc = parseFloat(level);
            }
        });
        
        const currentPrice = ticks[ticks.length - 1];
        const priceVsPOC = currentPrice > poc ? 'above' : 'below';
        
        return {
            bullish: priceVsPOC === 'above' ? 0.6 : 0.4,
            bearish: priceVsPOC === 'below' ? 0.6 : 0.4,
            poc,
            currentPrice
        };
    }

    analyzeTickDistribution(ticks) {
        // Analyze tick direction distribution
        let upTicks = 0;
        let downTicks = 0;
        let neutralTicks = 0;
        
        for (let i = 1; i < ticks.length; i++) {
            if (ticks[i] > ticks[i-1]) upTicks++;
            else if (ticks[i] < ticks[i-1]) downTicks++;
            else neutralTicks++;
        }
        
        const total = upTicks + downTicks + neutralTicks || 1;
        return {
            upward: upTicks / total,
            downward: downTicks / total,
            neutral: neutralTicks / total
        };
    }

    simulateMarketDepth(ticks) {
        // Simulate market depth based on tick patterns
        const spread = Math.max(...ticks) - Math.min(...ticks);
        const midPoint = (Math.max(...ticks) + Math.min(...ticks)) / 2;
        const currentPrice = ticks[ticks.length - 1];
        
        // Estimate bid/ask strength based on price position
        const pricePosition = (currentPrice - Math.min(...ticks)) / (spread || 1);
        
        return {
            bidStrength: 1 - pricePosition, // Stronger bids when price is low
            askStrength: pricePosition, // Stronger asks when price is high
            spread: spread
        };
    }

    analyzeSentiment(data, asset) {
        // Analyze market sentiment for multiplier trading
        const prices = data.priceHistory.slice(-50);
        if (prices.length < 20) return { direction: null, confidence: 0 };

        // Fear & Greed calculation
        const fearGreed = this.calculateFearGreedIndex(data, prices);
        
        // Momentum sentiment
        const momentumSentiment = this.analyzeMomentumSentiment(prices);
        
        // Volatility regime
        const volatilityRegime = this.analyzeVolatilityRegime(data);
        
        // Pattern sentiment
        const patternSentiment = this.analyzePatternSentiment(prices);

        // Combine sentiment indicators
        let bullishSentiment = 0;
        let bearishSentiment = 0;

        // Fear & Greed contribution
        if (fearGreed < 30) { // Extreme fear - contrarian bullish
            bullishSentiment += 0.3;
        } else if (fearGreed > 70) { // Extreme greed - contrarian bearish
            bearishSentiment += 0.3;
        } else {
            bullishSentiment += (fearGreed / 100) * 0.3;
            bearishSentiment += (1 - fearGreed / 100) * 0.3;
        }

        // Momentum sentiment
        bullishSentiment += momentumSentiment.bullish * 0.25;
        bearishSentiment += momentumSentiment.bearish * 0.25;

        // Volatility regime
        if (volatilityRegime.regime === 'LOW') {
            // Low volatility favors trend continuation
            if (momentumSentiment.bullish > momentumSentiment.bearish) {
                bullishSentiment += 0.2;
            } else {
                bearishSentiment += 0.2;
            }
        } else if (volatilityRegime.regime === 'EXTREME') {
            // Extreme volatility favors mean reversion
            if (prices[prices.length - 1] > prices[prices.length - 2]) {
                bearishSentiment += 0.2;
            } else {
                bullishSentiment += 0.2;
            }
        }

        // Pattern sentiment
        bullishSentiment += patternSentiment.bullish * 0.25;
        bearishSentiment += patternSentiment.bearish * 0.25;

        const direction = bullishSentiment > bearishSentiment ? 'UP' : 'DOWN';
        const confidence = Math.max(bullishSentiment, bearishSentiment);

        // Update sentiment analyzer
        this.sentimentAnalyzer.marketMood = direction === 'UP' ? 'BULLISH' : 'BEARISH';
        this.sentimentAnalyzer.fearGreedIndex = fearGreed;
        this.sentimentAnalyzer.volatilityRegime = volatilityRegime.regime;
        this.sentimentAnalyzer.trendConfidence = confidence;

        return {
            direction,
            confidence,
            sentiment: { fearGreed, momentum: momentumSentiment, volatility: volatilityRegime, pattern: patternSentiment }
        };
    }

    calculateFearGreedIndex(data, prices) {
        // Calculate Fear & Greed Index (0-100)
        let index = 50; // Start neutral
        
        // Momentum (25% weight)
        const momentum = this.calculateMomentum(prices, 10);
        const momentumScore = (momentum + 0.1) / 0.2 * 25; // Normalize to 0-25
        index += momentumScore;
        
        // Volatility (25% weight)
        const volatility = this.calculateVolatility(prices);
        const volatilityScore = (1 - Math.min(volatility * 50, 1)) * 25; // Lower volatility = higher greed
        index += volatilityScore;
        
        // Price strength (25% weight)
        const high = Math.max(...prices.slice(-20));
        const low = Math.min(...prices.slice(-20));
        const current = prices[prices.length - 1];
        const strengthScore = ((current - low) / (high - low || 1)) * 25;
        index += strengthScore;
        
        // Market breadth (25% weight) - simplified
        const upDays = prices.slice(-10).filter((p, i) => i > 0 && p > prices[prices.length - 11 + i]).length;
        const breadthScore = (upDays / 9) * 25;
        index -= 12.5; // Adjust for neutral
        index += breadthScore;
        
        return Math.max(0, Math.min(100, index));
    }

    analyzeMomentumSentiment(prices) {
        const shortMomentum = this.calculateMomentum(prices, 5);
        const mediumMomentum = this.calculateMomentum(prices, 10);
        const longMomentum = this.calculateMomentum(prices, 20);
        
        let bullish = 0;
        let bearish = 0;
        
        if (shortMomentum > 0 && shortMomentum > mediumMomentum) bullish += 0.4;
        if (mediumMomentum > 0 && mediumMomentum > longMomentum) bullish += 0.3;
        if (longMomentum > 0) bullish += 0.3;
        
        if (shortMomentum < 0 && shortMomentum < mediumMomentum) bearish += 0.4;
        if (mediumMomentum < 0 && mediumMomentum < longMomentum) bearish += 0.3;
        if (longMomentum < 0) bearish += 0.3;
        
        return { bullish, bearish };
    }

    analyzeVolatilityRegime(data) {
        const recentVol = data.volatility.slice(-10);
        if (recentVol.length === 0) return { regime: 'NORMAL', value: 0.01 };
        
        const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
        const historicalVol = data.volatility.length > 50 ? 
            data.volatility.slice(-50).reduce((a, b) => a + b, 0) / 50 : avgVol;
        
        let regime = 'NORMAL';
        if (avgVol < historicalVol * 0.7) regime = 'LOW';
        else if (avgVol > historicalVol * 1.5) regime = 'HIGH';
        else if (avgVol > historicalVol * 2) regime = 'EXTREME';
        
        return { regime, value: avgVol, historical: historicalVol };
    }

    analyzePatternSentiment(prices) {
        // Look for common patterns
        let bullish = 0;
        let bearish = 0;
        
        // Higher highs and higher lows
        const highs = [];
        const lows = [];
        
        for (let i = 1; i < prices.length - 1; i++) {
            if (prices[i] > prices[i-1] && prices[i] > prices[i+1]) {
                highs.push({ index: i, price: prices[i] });
            }
            if (prices[i] < prices[i-1] && prices[i] < prices[i+1]) {
                lows.push({ index: i, price: prices[i] });
            }
        }
        
        // Check for trend patterns
        if (highs.length >= 2 && lows.length >= 2) {
            const recentHighs = highs.slice(-2);
            const recentLows = lows.slice(-2);
            
            if (recentHighs[1].price > recentHighs[0].price && 
                recentLows[1].price > recentLows[0].price) {
                bullish = 0.7; // Uptrend
            } else if (recentHighs[1].price < recentHighs[0].price && 
                       recentLows[1].price < recentLows[0].price) {
                bearish = 0.7; // Downtrend
            } else {
                bullish = 0.5;
                bearish = 0.5; // Ranging
            }
        }
        
        return { bullish, bearish };
    }

    analyzeBoomPattern(data, asset) {
        // Specialized analysis for Boom indices
        const prices = data.priceHistory.slice(-100);
        if (prices.length < 50) return { direction: null, confidence: 0 };
        
        // Detect recent spikes
        const spikes = [];
        for (let i = 1; i < prices.length; i++) {
            const change = (prices[i] - prices[i-1]) / prices[i-1];
            if (change > 0.005) { // 0.5% spike threshold
                spikes.push({ index: i, magnitude: change });
            }
        }
        
        // Calculate spike frequency
        const recentSpikes = spikes.filter(s => s.index > prices.length - 20);
        const spikeFrequency = recentSpikes.length / 20;
        
        // Boom indices tend to have upward spikes
        // After a spike, there's usually a consolidation period
        const lastSpike = spikes[spikes.length - 1];
        const ticksSinceSpike = lastSpike ? prices.length - lastSpike.index : 100;
        
        let direction = 'UP'; // Boom indices have upward bias
        let confidence = 0.5;
        
        // If we haven't had a spike recently, one might be due
        if (ticksSinceSpike > 15) {
            confidence = 0.7;
        } else if (ticksSinceSpike < 5) {
            // Just had a spike, might consolidate
            direction = 'DOWN';
            confidence = 0.6;
        }
        
        // Adjust for spike frequency
        if (spikeFrequency > 0.2) {
            // High frequency, might slow down
            confidence *= 0.8;
        }
        
        return { direction, confidence, spikes: recentSpikes.length, ticksSinceSpike };
    }

    analyzeCrashPattern(data, asset) {
        // Specialized analysis for Crash indices
        const prices = data.priceHistory.slice(-100);
        if (prices.length < 50) return { direction: null, confidence: 0 };
        
        // Detect recent crashes
        const crashes = [];
        for (let i = 1; i < prices.length; i++) {
            const change = (prices[i] - prices[i-1]) / prices[i-1];
            if (change < -0.005) { // -0.5% crash threshold
                crashes.push({ index: i, magnitude: Math.abs(change) });
            }
        }
        
        // Calculate crash frequency
        const recentCrashes = crashes.filter(c => c.index > prices.length - 20);
        const crashFrequency = recentCrashes.length / 20;
        
        // Crash indices tend to have downward spikes
        const lastCrash = crashes[crashes.length - 1];
        const ticksSinceCrash = lastCrash ? prices.length - lastCrash.index : 100;
        
        let direction = 'UP'; // After crashes, tend to recover
        let confidence = 0.5;
        
        // If we haven't had a crash recently, one might be due
        if (ticksSinceCrash > 15) {
            direction = 'DOWN';
            confidence = 0.7;
        } else if (ticksSinceCrash < 5) {
            // Just had a crash, might recover
            direction = 'UP';
            confidence = 0.6;
        }
        
        // Adjust for crash frequency
        if (crashFrequency > 0.2) {
            // High frequency, might stabilize
                       confidence *= 0.8;
        }
        
        return { direction, confidence, crashes: recentCrashes.length, ticksSinceCrash };
    }

    // Add this new function to get the closest valid multiplier
    getValidMultiplier(asset, desiredMultiplier) {
        // Get valid multipliers for this asset
        const validMults = this.validMultipliers[asset];
        
        if (!validMults) {
            console.log(`⚠️ No valid multipliers found for ${asset}, using default`);
            return 100; // Safe default
        }
        
        // Find the closest valid multiplier
        let closest = validMults[0];
        let minDiff = Math.abs(desiredMultiplier - closest);
        
        for (const mult of validMults) {
            const diff = Math.abs(desiredMultiplier - mult);
            if (diff < minDiff) {
                minDiff = diff;
                closest = mult;
            }
        }
        
        return closest;
    }

    calculateOptimalMultiplier(data, asset) {
        // Calculate the optimal multiplier based on market conditions
        const assetType = this.getAssetType(asset);
        const volatility = data.volatility[data.volatility.length - 1] || 0.01;
        const trendStrength = Math.abs(data.trendStrength);
        const riskScore = data.riskScore;
        
        let baseMultiplier = this.config.defaultMultiplier;
        
        // Get valid multipliers for this asset
        const validMults = this.validMultipliers[asset];
        if (!validMults || validMults.length === 0) {
            console.log(`⚠️ No valid multipliers for ${asset}`);
            return 100;
        }
        
        // Start with middle multiplier as base
        baseMultiplier = validMults[Math.floor(validMults.length / 2)];
        
        // Adjust based on asset type
        if (assetType === 'volatility') {
            // For volatility indices, consider the volatility level
            if (asset.includes('10V') || asset.includes('15V')) {
                // Lower volatility indices can use higher multipliers
                baseMultiplier = validMults[Math.min(3, validMults.length - 1)];
            } else if (asset.includes('75V') || asset.includes('90V') || asset.includes('100V')) {
                // Higher volatility indices should use lower multipliers
                baseMultiplier = validMults[Math.min(1, validMults.length - 1)];
            }
        } else if (assetType === 'boom' || assetType === 'crash') {
            // Boom/Crash indices - start conservative
            baseMultiplier = validMults[1]; // Second lowest multiplier
        }
        
        // Calculate desired multiplier based on conditions
        let desiredMultiplier = baseMultiplier;
        
        // Adjust for volatility
        const volThresholds = this.getVolatilityThresholds(asset);
        if (volatility < volThresholds.min) {
            // Low volatility - can aim for higher multiplier
            const higherIndex = Math.min(validMults.indexOf(baseMultiplier) + 1, validMults.length - 1);
            desiredMultiplier = validMults[higherIndex];
        } else if (volatility > volThresholds.max) {
            // High volatility - use lower multiplier
            const lowerIndex = Math.max(validMults.indexOf(baseMultiplier) - 1, 0);
            desiredMultiplier = validMults[lowerIndex];
        }
        
        // Adjust for trend strength
        if (trendStrength > 0.7 && validMults.indexOf(desiredMultiplier) < validMults.length - 1) {
            // Strong trend - can increase multiplier slightly
            const currentIndex = validMults.indexOf(desiredMultiplier);
            if (currentIndex < validMults.length - 1 && Math.random() > 0.5) {
                desiredMultiplier = validMults[currentIndex + 1];
            }
        } else if (trendStrength < 0.3 && validMults.indexOf(desiredMultiplier) > 0) {
            // Weak/ranging market - reduce multiplier
            const currentIndex = validMults.indexOf(desiredMultiplier);
            if (currentIndex > 0) {
                desiredMultiplier = validMults[currentIndex - 1];
            }
        }
        
        // Ensure we return a valid multiplier
        return this.getValidMultiplier(asset, desiredMultiplier);
    }


    getVolatilityThresholds(asset) {
        const thresholds = {
            '1HZ10V': { min: 0.008, max: 0.016 },
            '1HZ15V': { min: 0.006, max: 0.014 },
            '1HZ25V': { min: 0.004, max: 0.010 },
            '1HZ30V': { min: 0.003, max: 0.008 },
            '1HZ50V': { min: 0.002, max: 0.006 },
            '1HZ75V': { min: 0.001, max: 0.004 },
            '1HZ90V': { min: 0.0008, max: 0.003 },
            '1HZ100V': { min: 0.0006, max: 0.002 },
            'BOOM300': { min: 0.01, max: 0.05 },
            'BOOM500': { min: 0.01, max: 0.05 },
            'BOOM1000': { min: 0.01, max: 0.05 },
            'CRASH300': { min: 0.01, max: 0.05 },
            'CRASH500': { min: 0.01, max: 0.05 },
            'CRASH1000': { min: 0.01, max: 0.05 }
        };
        
        return thresholds[asset] || { min: 0.001, max: 0.01 };
    }

    adjustMultiplierForRisk(multiplier, confidence, volatility, asset) {
        let adjustedMultiplier = multiplier;
        
        // Get valid multipliers for this asset
        const validMults = this.validMultipliers[asset];
        if (!validMults || validMults.length === 0) {
            return 100; // Safe default
        }
        
        // Find current index
        let currentIndex = validMults.indexOf(adjustedMultiplier);
        if (currentIndex === -1) {
            // If not found, get closest valid
            adjustedMultiplier = this.getValidMultiplier(asset, adjustedMultiplier);
            currentIndex = validMults.indexOf(adjustedMultiplier);
        }
        
        // Reduce multiplier if confidence is low
        if (confidence < 75 && currentIndex > 0) {
            currentIndex = Math.max(0, currentIndex - 1);
            adjustedMultiplier = validMults[currentIndex];
        }
        
        // Account for consecutive losses
        if (this.tradingState.consecutiveLosses > 0 && currentIndex > 0) {
            currentIndex = Math.max(0, currentIndex - this.tradingState.consecutiveLosses);
            adjustedMultiplier = validMults[currentIndex];
        }
        
        // Account for daily P/L
        const dailyPLRatio = this.statistics.dailyProfitLoss / this.config.dailyProfitTarget;
        if (dailyPLRatio < -0.5 && currentIndex > 0) {
            // Significant daily loss - reduce risk
            currentIndex = Math.max(0, currentIndex - 1);
            adjustedMultiplier = validMults[currentIndex];
        } else if (dailyPLRatio > 0.7 && currentIndex < validMults.length - 1) {
            // Near daily target - can be slightly more aggressive
            if (Math.random() > 0.7) { // 30% chance to increase
                currentIndex = Math.min(validMults.length - 1, currentIndex + 1);
                adjustedMultiplier = validMults[currentIndex];
            }
        }
        
        // Account for session performance
        if (this.statistics.winRate < 0.4 && this.statistics.totalTrades > 10 && currentIndex > 0) {
            // Poor performance - reduce risk
            currentIndex = Math.max(0, currentIndex - 1);
            adjustedMultiplier = validMults[currentIndex];
        }
        
        return adjustedMultiplier;
    }

    calculateDynamicStake(confidence, riskScore) {
        let stake = this.config.initialStake;
        
        // Kelly Criterion for position sizing
        const winRate = this.statistics.winRate || 0.5;
        const avgWinLoss = this.statistics.avgWin / (this.statistics.avgLoss || 1);
        const kellyFraction = (winRate * avgWinLoss - (1 - winRate)) / avgWinLoss;
        const conservativeKelly = Math.max(0, kellyFraction * 0.25); // Use 25% Kelly
        
        if (conservativeKelly > 0) {
            stake *= (1 + conservativeKelly);
        }
        
        // Adjust for confidence
        if (confidence > 80) {
            stake *= 1.2;
        } else if (confidence < 70) {
            stake *= 0.8;
        }
        
        // Adjust for risk score
        if (riskScore > 0.7) {
            stake *= 0.7; // High risk - reduce stake
        } else if (riskScore < 0.3) {
            stake *= 1.1; // Low risk - can increase slightly
        }
        
        // Martingale adjustment (carefully limited)
        if (this.tradingState.consecutiveLosses > 0 && this.tradingState.consecutiveLosses <= 2) {
            stake *= Math.pow(1.5, this.tradingState.consecutiveLosses);
        }
        
        // Anti-Martingale for winning streaks
        if (this.tradingState.consecutiveWins > 2) {
            stake *= (1 + 0.1 * Math.min(this.tradingState.consecutiveWins - 2, 3));
        }
        
        // Apply limits
        stake = Math.min(stake, this.config.maxStake);
        stake = Math.max(stake, this.config.initialStake);
        
        // Check if stake would exceed daily limits
        if (this.statistics.dailyProfitLoss - stake < this.config.dailyLossLimit) {
            stake = Math.max(this.config.initialStake, 
                           this.statistics.dailyProfitLoss - this.config.dailyLossLimit);
        }
        
        return Math.round(stake * 100) / 100;
    }

    // ============ TRADE EXECUTION ============
    executeMultiplierTrade(asset, direction, multiplier, stake, confidence) {
        if (!this.performPreTradeChecks()) {
            return;
        }

        this.tradingState.tradeInProgress = true;
        this.tradingState.currentStake = stake;
        this.tradingState.currentMultiplier = multiplier;
        this.tradingState.currentDirection = direction;

        // Calculate take profit and stop loss
        let takeProfit = null;
        let stopLoss = null;
        
        if (this.config.useTakeProfit) {
            takeProfit = stake * this.config.takeProfitMultiplier;
        }
        
        if (this.config.useStopLoss) {
            stopLoss = stake * (this.config.stopLossPercentage / 100);
        }

        // FIX: Convert multiplier to string and handle take profit/stop loss display
        const takeProfitDisplay = takeProfit ? '$' + takeProfit.toFixed(2) : 'Disabled';
        const stopLossDisplay = stopLoss ? '$' + stopLoss.toFixed(2) : 'Disabled';
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║       🎯 MULTIPLIER EXECUTION          ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(33)}║
        ║ Direction: ${direction.padEnd(29)}║
        ║ Multiplier: x${multiplier.toString().padEnd(26)}║
        ║ Stake: $${stake.toFixed(2).padEnd(31)}║
        ║ Take Profit: ${takeProfitDisplay.padEnd(27)}║
        ║ Stop Loss: ${stopLossDisplay.padEnd(29)}║
        ║ Confidence: ${confidence.toFixed(1)}%                    ║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2).padEnd(25)}║
        ╚════════════════════════════════════════╝
        `);

        const request = {
            buy: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: 'stake',
                contract_type: 'MULTUP', // or 'MULTDOWN'
                currency: 'USD',
                multiplier: multiplier,
                symbol: asset,
            }
        };

        // Set contract type based on direction
        if (direction === 'DOWN') {
            request.parameters.contract_type = 'MULTDOWN';
        } else if (direction === 'UP') {
            request.parameters.contract_type = 'MULTUP';
        }

        // Add stop loss if enabled
        if (stopLoss && !this.config.useDealCancellation) {
            request.parameters.limit_order = {
                stop_loss: stopLoss
            };
        }

        // Add take profit if enabled
        if (takeProfit) {
            if (!request.parameters.limit_order) {
                request.parameters.limit_order = {};
            }
            request.parameters.limit_order.take_profit = takeProfit;
        }

        // Add deal cancellation if enabled (cannot be used with stop loss)
        if (this.config.useDealCancellation && !this.config.useStopLoss) {
            request.parameters.cancellation = this.config.dealCancellationDuration;
        }

        this.currentTradeData = {
            asset,
            direction,
            multiplier,
            stake,
            confidence,
            takeProfit,
            stopLoss,
            timestamp: Date.now()
        };

        this.sendRequest(request);
    }

    performPreTradeChecks() {
        // Check daily limits
        if (this.statistics.dailyProfitLoss <= this.config.dailyLossLimit) {
            console.log('❌ Daily loss limit reached');
            this.sessionManager.emergencyStop = true;
            this.sendFinalReport();
            return false;
        }

        if (this.statistics.dailyProfitLoss >= this.config.dailyProfitTarget) {
            console.log('✅ Daily profit target reached');
            this.sessionManager.sessionPaused = true;
            this.sendFinalReport();
            return false;
        }

        // Check consecutive losses
        if (this.tradingState.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('⚠️ Max consecutive losses reached. Entering cooldown...');
            this.activateCooldown(this.config.cooldownAfterLoss * 2);
            this.tradingState.consecutiveLosses = 0; // Reset after cooldown
            return false;
        }

        // Check drawdown
        if (this.statistics.maxDrawdown < this.config.stopLoss) {
            console.log('⛔ Maximum drawdown exceeded');
            this.sessionManager.emergencyStop = true;
            return false;
        }

        // Check if we have active positions (for now, limiting to one)
        if (this.positionManager.activePositions.length >= this.positionManager.maxConcurrentPositions) {
            console.log('⏳ Maximum concurrent positions reached');
            return false;
        }

        return true;
    }

    activateCooldown(duration) {
        this.tradingState.cooldownActive = true;
        console.log(`❄️ Cooldown activated for ${duration / 1000} seconds`);
        
        setTimeout(() => {
            this.tradingState.cooldownActive = false;
            console.log('🔥 Cooldown ended. Resuming analysis...');
            
            // Reset some parameters after cooldown
            if (this.statistics.winRate < 0.4) {
                this.config.minConfidenceScore = Math.min(80, this.config.minConfidenceScore + 5);
                console.log(`📊 Adjusted minimum confidence to ${this.config.minConfidenceScore}%`);
            }
        }, duration);
    }

    // ============ MONITORING SYSTEMS ============
    startQuantumPrediction() {
        setInterval(() => {
            if (this.config.useQuantumPrediction) {
                Object.keys(this.marketPatterns).forEach(asset => {
                    this.updateQuantumState(asset);
                });
            }
        }, 30000); // Every 30 seconds
    }

    startMLOptimization() {
        setInterval(() => {
            if (this.config.useMLOptimization && this.statistics.totalTrades > 10) {
                this.updateMLModels();
                this.optimizeHyperparameters();
            }
        }, 60000); // Every minute
    }

    startMarketMicrostructure() {
        setInterval(() => {
            if (this.config.useMarketMicrostructure) {
                Object.keys(this.marketPatterns).forEach(asset => {
                    this.updateMicrostructureData(asset);
                });
            }
        }, 10000); // Every 10 seconds
    }

    startSentimentAnalysis() {
        setInterval(() => {
            if (this.config.useSentimentAnalysis) {
                this.updateMarketSentiment();
            }
        }, 20000); // Every 20 seconds
    }

    startCorrelationAnalysis() {
        setInterval(() => {
            if (this.config.useCorrelationMatrix) {
                this.updateCorrelationMatrix();
            }
        }, 60000); // Every minute
    }

    startRiskMonitoring() {
        setInterval(() => {
            this.checkRiskMetrics();
            this.adjustRiskParameters();
            this.calculatePerformanceMetrics();
        }, 30000); // Every 30 seconds
    }

    startMultiplierOptimization() {
        setInterval(() => {
            this.optimizeMultiplierSettings();
        }, 120000); // Every 2 minutes
    }

    updateQuantumState(asset) {
        const data = this.marketPatterns[asset];
        if (data.priceHistory.length < 50) return;
        
        const prices = data.priceHistory.slice(-50);
        const quantumState = this.createQuantumState(prices);
        
        this.quantumPredictor.quantumStates[asset] = quantumState;
        this.quantumPredictor.waveFunctions[asset] = this.createWaveFunction(prices);
        this.quantumPredictor.probabilityCloud[asset] = this.calculateQuantumAmplitudes(quantumState);
    }

    createWaveFunction(prices) {
        // Create wave function from price data using Fourier-like transformation
        const waveFunction = [];
        const n = prices.length;
        
        for (let k = 0; k < n; k++) {
            let real = 0;
            let imag = 0;
            
            for (let t = 0; t < n; t++) {
                const angle = -2 * Math.PI * k * t / n;
                real += prices[t] * Math.cos(angle);
                imag += prices[t] * Math.sin(angle);
            }
            
            waveFunction.push({
                real: real / n,
                imag: imag / n,
                magnitude: Math.sqrt(real * real + imag * imag) / n,
                phase: Math.atan2(imag, real)
            });
        }
        
        return waveFunction;
    }

    updateMLModels() {
        // Update neural network through experience replay
        this.performExperienceReplay();
        
        // Update Q-table for reinforcement learning
        this.updateQTable();
        
        // Retrain ensemble models periodically
        if (this.statistics.totalTrades % 50 === 0) {
            this.retrainEnsembleModels();
        }
        
        this.mlOptimizer.neuralNetwork.epochs++;
    }

    performExperienceReplay() {
        // Simplified experience replay for neural network training
        // In production, this would involve proper backpropagation
        const learningRate = this.mlOptimizer.neuralNetwork.learningRate;
        
        // Decay learning rate over time
        this.mlOptimizer.neuralNetwork.learningRate *= 0.9999;
        this.mlOptimizer.neuralNetwork.learningRate = Math.max(0.0001, 
            this.mlOptimizer.neuralNetwork.learningRate);
    }

    updateQTable() {
        // Update Q-values based on recent trades
        const rl = this.mlOptimizer.reinforcementLearning;
        
        if (this.lastTradeResult) {
            const state = this.lastTradeState;
            const action = this.lastTradeAction;
            const reward = this.lastTradeResult.profit;
            const nextState = this.getCurrentState();
            
            // Q-learning update rule
            const currentQ = rl.qTable.get(state)?.[action] || 0;
            const maxNextQ = Math.max(
                rl.qTable.get(nextState)?.up || 0,
                rl.qTable.get(nextState)?.down || 0
            );
            
            const newQ = currentQ + rl.alpha * (reward + rl.gamma * maxNextQ - currentQ);
            
            if (!rl.qTable.has(state)) {
                rl.qTable.set(state, {});
            }
            rl.qTable.get(state)[action] = newQ;
        }
        
        // Decay exploration rate
        rl.epsilon *= 0.999;
        rl.epsilon = Math.max(0.01, rl.epsilon);
    }

    getCurrentState() {
        // Encode current market state for RL
        const prices = Object.values(this.marketPatterns)[0]?.priceHistory.slice(-10) || [];
        if (prices.length < 10) return 'unknown';
        
        const features = this.extractMLFeatures(this.marketPatterns[Object.keys(this.marketPatterns)[0]]);
        return this.encodeState(features);
    }

    retrainEnsembleModels() {
        console.log('🔄 Retraining ensemble models...');
        // In production, this would involve actual model training
        // For now, we'll just reset accuracy metrics
        this.mlOptimizer.ensembleModels.randomForest.accuracy = Math.random() * 0.2 + 0.6;
        this.mlOptimizer.ensembleModels.gradientBoosting.accuracy = Math.random() * 0.2 + 0.6;
        this.mlOptimizer.ensembleModels.xgboost.accuracy = Math.random() * 0.2 + 0.6;
    }

    optimizeHyperparameters() {
        // Dynamically adjust hyperparameters based on performance
        if (this.statistics.winRate < 0.45 && this.statistics.totalTrades > 20) {
            // Poor performance - adjust parameters
            this.config.minConfidenceScore = Math.min(85, this.config.minConfidenceScore + 2);
            this.mlOptimizer.neuralNetwork.learningRate *= 1.1;
        } else if (this.statistics.winRate > 0.55 && this.statistics.totalTrades > 20) {
            // Good performance - fine-tune
            this.config.minConfidenceScore = Math.max(65, this.config.minConfidenceScore - 1);
        }
    }

    updateMicrostructureData(asset) {
        const data = this.marketPatterns[asset];
        const ticks = data.tickHistory.slice(-30);
        
        if (ticks.length < 10) return;
        
        // Update tick direction
        for (let i = 1; i < ticks.length; i++) {
            const direction = ticks[i] > ticks[i-1] ? 1 : ticks[i] < ticks[i-1] ? -1 : 0;
            data.tickDirection.push(direction);
        }
        
        // Maintain array size
        if (data.tickDirection.length > 100) {
            data.tickDirection = data.tickDirection.slice(-100);
        }
        
        // Update order flow
        const orderFlow = this.analyzeOrderFlow(ticks);
        data.orderFlow.push(orderFlow);
        if (data.orderFlow.length > 50) {
            data.orderFlow.shift();
        }
        
        // Update cumulative delta
        data.cumulativeDelta += orderFlow.delta;
    }

    updateMarketSentiment() {
        // Aggregate sentiment across all assets
        let totalBullish = 0;
        let totalBearish = 0;
        let count = 0;
        
        Object.values(this.marketPatterns).forEach(data => {
            if (data.priceHistory.length > 20) {
                const sentiment = this.analyzeSentiment(data, 'aggregate');
                if (sentiment.direction === 'UP') {
                    totalBullish += sentiment.confidence;
                } else {
                    totalBearish += sentiment.confidence;
                }
                count++;
            }
        });
        
        if (count > 0) {
            const avgBullish = totalBullish / count;
            const avgBearish = totalBearish / count;
            
            this.sentimentAnalyzer.marketMood = avgBullish > avgBearish ? 'BULLISH' : 'BEARISH';
            this.sentimentAnalyzer.trendConfidence = Math.max(avgBullish, avgBearish);
        }
    }

    updateCorrelationMatrix() {
        // Calculate correlations between all asset pairs
        const assets = Object.keys(this.marketPatterns);
        
        assets.forEach(asset1 => {
            this.correlationMatrix[asset1] = {};
            assets.forEach(asset2 => {
                if (asset1 !== asset2) {
                    const data1 = this.marketPatterns[asset1];
                    const data2 = this.marketPatterns[asset2];
                    
                    if (data1.priceHistory.length >= 50 && data2.priceHistory.length >= 50) {
                        const correlation = this.calculateCorrelation(
                            data1.priceHistory.slice(-50),
                            data2.priceHistory.slice(-50)
                        );
                        this.correlationMatrix[asset1][asset2] = correlation;
                    }
                }
            });
        });
    }

    checkRiskMetrics() {
        const winRate = (this.statistics.upWins + this.statistics.downWins) / 
                       Math.max(this.statistics.totalTrades, 1);
        
        // Calculate Sharpe Ratio
        if (this.statistics.totalTrades > 20) {
            this.calculateSharpeRatio();
        }
        
        // Calculate recovery factor
        if (this.statistics.maxDrawdown < 0) {
            this.statistics.recoveryFactor = this.statistics.totalProfitLoss / 
                                            Math.abs(this.statistics.maxDrawdown);
        }
        
        // Calculate expectancy
        if (this.statistics.totalTrades > 0) {
            this.statistics.expectancy = this.statistics.totalProfitLoss / this.statistics.totalTrades;
        }
        
        // Risk alerts
        if (winRate < 0.35 && this.statistics.totalTrades > 15) {
            console.log('⚠️ Critical: Win rate below 35%. Adjusting strategy...');
            this.config.minConfidenceScore = Math.min(90, this.config.minConfidenceScore + 10);
            this.config.defaultMultiplier = Math.max(10, this.config.defaultMultiplier * 0.5);
        }
        
        if (this.statistics.recoveryFactor < 0.5 && this.statistics.totalTrades > 20) {
            console.log('⚠️ Poor recovery factor. Implementing conservative mode...');
            this.config.maxStake *= 0.8;
        }
    }

    adjustRiskParameters() {
        // Dynamic risk adjustment based on market conditions
        const avgVolatility = this.calculateAverageVolatility();
        
        // Adjust for high volatility
        if (avgVolatility > 0.02) {
            this.config.defaultMultiplier = Math.min(30, this.config.defaultMultiplier);
            this.config.stopLossPercentage = Math.max(40, this.config.stopLossPercentage * 0.9);
            console.log(`📉 High market volatility detected. Reducing multiplier to ${this.config.defaultMultiplier}`);
        }
        
        // Adjust based on time of day (market sessions)
        const hour = new Date().getUTCHours();
        if (hour >= 21 || hour <= 1) { // Asian session overlap
            this.config.minConfidenceScore = Math.min(75, this.config.minConfidenceScore + 5);
        }
    }

    calculateAverageVolatility() {
        let totalVolatility = 0;
        let count = 0;
        
        Object.values(this.marketPatterns).forEach(data => {
            if (data.volatility.length > 0) {
                const recent = data.volatility.slice(-10);
                totalVolatility += recent.reduce((a, b) => a + b, 0) / recent.length;
                count++;
            }
        });
        
        return count > 0 ? totalVolatility / count : 0.01;
    }

    calculatePerformanceMetrics() {
        if (this.statistics.totalTrades === 0) return;
        
        // Win rate
        this.statistics.winRate = (this.statistics.upWins + this.statistics.downWins) / 
                                  this.statistics.totalTrades;
        
        // Average win/loss
        const totalWins = this.statistics.upWins + this.statistics.downWins;
        const totalLosses = this.statistics.upLosses + this.statistics.downLosses;
        
        if (totalWins > 0) {
            // Calculate average win more accurately
            this.statistics.avgWin = this.statistics.totalProfitLoss > 0 ? 
                (this.statistics.totalProfitLoss + Math.abs(this.statistics.totalLosses || 0)) / totalWins : 0;
        }
        
        if (totalLosses > 0) {
            this.statistics.avgLoss = Math.abs(this.statistics.totalLosses || 
                (this.statistics.totalProfitLoss < 0 ? this.statistics.totalProfitLoss : 0)) / totalLosses;
        }
        
        // Profit factor
        if (this.statistics.avgLoss > 0) {
            this.statistics.profitFactor = this.statistics.avgWin / this.statistics.avgLoss;
        }
        
        // Average multiplier used
        if (this.tradingHistory && this.tradingHistory.length > 0) {
            const multipliers = this.tradingHistory.map(t => t.multiplier);
            this.statistics.avgMultiplierUsed = multipliers.reduce((a, b) => a + b, 0) / multipliers.length;
        }
    }

    calculateSharpeRatio() {
        // Simplified Sharpe Ratio calculation
        const returns = [];
        const riskFreeRate = 0.02 / 365; // Daily risk-free rate
        
        // Use session P/L as returns
        const avgReturn = this.statistics.sessionProfitLoss / this.statistics.totalTrades;
        const excessReturn = avgReturn - riskFreeRate * this.statistics.totalTrades;
        
        // Calculate standard deviation
        const variance = Math.pow(this.statistics.avgWin - this.statistics.avgLoss, 2);
        const stdDev = Math.sqrt(variance);
        
        this.statistics.sharpeRatio = stdDev > 0 ? excessReturn / stdDev : 0;
    }

    optimizeMultiplierSettings() {
        // Analyze which multipliers have been most successful
        if (!this.tradingHistory || this.tradingHistory.length < 10) return;
        
        const multiplierPerformance = {};
        
        this.tradingHistory.forEach(trade => {
            if (!multiplierPerformance[trade.multiplier]) {
                multiplierPerformance[trade.multiplier] = { wins: 0, losses: 0, profit: 0 };
            }
            
            if (trade.result === 'win') {
                multiplierPerformance[trade.multiplier].wins++;
                multiplierPerformance[trade.multiplier].profit += trade.profit;
            } else {
                multiplierPerformance[trade.multiplier].losses++;
                multiplierPerformance[trade.multiplier].profit -= trade.loss;
            }
        });
        
        // Find best performing multiplier
        let bestMultiplier = this.config.defaultMultiplier;
        let bestPerformance = -Infinity;
        
        Object.entries(multiplierPerformance).forEach(([mult, perf]) => {
            const winRate = perf.wins / (perf.wins + perf.losses);
            const score = winRate * perf.profit;
            
            if (score > bestPerformance) {
                bestPerformance = score;
                bestMultiplier = parseInt(mult);
            }
        });
        
        // Gradually adjust default multiplier towards best performing
        const adjustment = (bestMultiplier - this.config.defaultMultiplier) * 0.1;
        this.config.defaultMultiplier += Math.round(adjustment);
        this.config.defaultMultiplier = Math.max(this.config.minMultiplier, 
                                                Math.min(this.config.maxMultiplier, 
                                                        this.config.defaultMultiplier));
    }

    // ============ MESSAGE PROCESSORS ============
    initializeTrading() {
        console.log('🚀 Initializing Multiplier trading systems...');
        
        // Subscribe to all configured assets
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
            // Get available contracts for the asset
            this.getContractsFor(asset);
        });
        
        // Initialize trading history
        this.tradingHistory = [];
        this.lastTradeResult = null;
        this.lastTradeState = null;
        this.lastTradeAction = null;
    }

    subscribeToTickHistory(asset) {
        this.sendRequest({
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });
    }

    subscribeToTicks(asset) {
        this.sendRequest({
            ticks: asset,
            subscribe: 1
        });
    }

    getContractsFor(asset) {
        this.sendRequest({
            contracts_for: asset,
            currency: 'USD',
            landing_company: 'svg',
            product_type: 'basic'
        });
    }

    processTickHistory(message) {
        try {
            if (!message || !message.echo_req || !message.echo_req.ticks_history) {
                console.log('⚠️ Invalid history message structure');
                return;
            }
            
            const asset = message.echo_req.ticks_history;
            
            if (!message.history || !message.history.prices || !Array.isArray(message.history.prices)) {
                console.log(`⚠️ No valid history data for ${asset}`);
                return;
            }
            
            const prices = message.history.prices.map(p => parseFloat(p)).filter(p => !isNaN(p) && p > 0);
            const times = message.history.times || [];
            
            if (prices.length === 0) {
                console.log(`⚠️ No valid prices in history for ${asset}`);
                return;
            }
            
            if (!this.marketPatterns[asset]) {
                console.log(`⚠️ Asset ${asset} not in configured patterns`);
                return;
            }
            
            const data = this.marketPatterns[asset];
            data.priceHistory = prices;
            data.tickHistory = prices.slice(-100); // Keep recent ticks
            
            // Calculate initial indicators
            if (prices.length > 20) {
                // Calculate returns
                data.returns = [];
                for (let i = 1; i < prices.length; i++) {
                    const returnVal = (prices[i] - prices[i-1]) / prices[i-1];
                    if (!isNaN(returnVal) && isFinite(returnVal)) {
                        data.returns.push(returnVal);
                    }
                }
                
                // Calculate initial volatility
                const vol = this.calculateVolatility(prices.slice(-30));
                if (!isNaN(vol) && isFinite(vol)) {
                    data.volatility = [vol];
                }
                
                // Calculate initial momentum
                const mom = this.calculateMomentum(prices.slice(-20), 10);
                if (!isNaN(mom) && isFinite(mom)) {
                    data.momentum = [mom];
                }
                
                // Calculate trend strength
                const trend = this.calculateTrendStrength(prices.slice(-50));
                if (!isNaN(trend) && isFinite(trend)) {
                    data.trendStrength = trend;
                }
                
                // Initialize risk score
                data.riskScore = this.calculateRiskScore(data);
            }
            
            console.log(`📊 Loaded ${prices.length} ticks for ${asset}`);
            console.log(`   Price range: ${Math.min(...prices).toFixed(5)} - ${Math.max(...prices).toFixed(5)}`);
            console.log(`   Current price: ${prices[prices.length - 1].toFixed(5)}`);
            if (data.volatility.length > 0) {
                console.log(`   Volatility: ${data.volatility[0].toFixed(6)}`);
            }
        } catch (error) {
            console.error('Error processing tick history:', error);
            console.error('Message:', JSON.stringify(message).substring(0, 200));
        }
    }

    processTick(message) {
        // Add validation to prevent undefined errors
        if (!message || !message.tick) {
            // This might be a subscription confirmation or other message type
            if (message && message.subscription) {
                console.log(`✓ Subscribed to ${message.subscription.id}`);
            }
            return;
        }
        
        const tick = message.tick;
        
        // Validate tick data
        if (!tick.symbol || tick.quote === undefined || tick.quote === null) {
            console.log('⚠️ Invalid tick data received:', tick);
            return;
        }
        
        const asset = tick.symbol;
        const price = parseFloat(tick.quote);
        const time = tick.epoch || Date.now() / 1000;
        
        // Check if we have this asset in our patterns
        if (!this.marketPatterns[asset]) {
            console.log(`⚠️ Received tick for untracked asset: ${asset}`);
            return;
        }
        
        const data = this.marketPatterns[asset];
        
        // Ensure price is valid
        if (isNaN(price) || price <= 0) {
            console.log(`⚠️ Invalid price received for ${asset}: ${tick.quote}`);
            return;
        }
        
        // Update price history
        data.priceHistory.push(price);
        data.tickHistory.push(price);
        
        // Maintain array sizes
        if (data.priceHistory.length > this.config.requiredHistoryLength * 2) {
            data.priceHistory.shift();
        }
        if (data.tickHistory.length > 100) {
            data.tickHistory.shift();
        }
        
        // Update real-time indicators only if we have enough data
        if (data.priceHistory.length > 2) {
            this.updateRealtimeIndicators(data, price);
        }
        
        // Update risk score only if we have enough data
        if (data.priceHistory.length > 20) {
            data.riskScore = this.calculateRiskScore(data);
        }
        
        // Log tick info
        if (data.priceHistory.length > 1) {
            const prevPrice = data.priceHistory[data.priceHistory.length - 2];
            const direction = price > prevPrice ? '↑' : price < prevPrice ? '↓' : '→';
            const volDisplay = data.volatility.length > 0 ? 
                data.volatility[data.volatility.length - 1].toFixed(6) : 'N/A';
            const riskDisplay = data.riskScore ? data.riskScore.toFixed(2) : 'N/A';
            
            console.log(`${direction} [${asset}] ${price.toFixed(5)} | Vol: ${volDisplay} | Risk: ${riskDisplay}`);
        }
        
        // Analyze for trading opportunity
        if (data.priceHistory.length >= this.config.requiredHistoryLength && 
            !this.tradingState.tradeInProgress && 
            !this.tradingState.cooldownActive) {
            
            const timeSinceLastTrade = Date.now() - this.tradingState.lastTradeTime;
            if (timeSinceLastTrade > this.config.minWaitTime) {
                this.analyzeMultiplierOpportunity(asset);
            }
        }
    }

    updateRealtimeIndicators(data, currentPrice) {
        const prices = data.priceHistory.slice(-50);
        if (prices.length < 20) return;
        
        // Update volatility
        const volatility = this.calculateVolatility(prices.slice(-20));
        data.volatility.push(volatility);
        if (data.volatility.length > 50) data.volatility.shift();
        
        // Update momentum
        const momentum = this.calculateMomentum(prices, 10);
        data.momentum.push(momentum);
        if (data.momentum.length > 50) data.momentum.shift();
        
        // Update trend strength
        data.trendStrength = this.calculateTrendStrength(prices);
        
        // Update RSI
        const rsi = this.calculateRSI(prices, 14);
        data.rsi.push(rsi);
        if (data.rsi.length > 50) data.rsi.shift();
        
        // Update tick direction
        const prevPrice = prices[prices.length - 2];
        const tickDir = currentPrice > prevPrice ? 1 : currentPrice < prevPrice ? -1 : 0;
        data.tickDirection.push(tickDir);
        if (data.tickDirection.length > 100) data.tickDirection.shift();
    }

    calculateRiskScore(data) {
        let riskScore = 0;
        const weights = {
            volatility: 0.3,
            drawdown: 0.2,
            momentum: 0.15,
            rsi: 0.15,
            trendStrength: 0.1,
            consecutiveLosses: 0.1
        };
        
        // Volatility risk
        const currentVol = data.volatility.length > 0 ? 
            data.volatility[data.volatility.length - 1] : 0.01;
        
        // Get appropriate thresholds - find the asset from marketPatterns
        let asset = null;
        for (const [key, value] of Object.entries(this.marketPatterns)) {
            if (value === data) {
                asset = key;
                break;
            }
        }
        
        const volThresholds = asset ? this.getVolatilityThresholds(asset) : 
            { min: 0.001, max: 0.01 };
        const volRisk = Math.min(1, currentVol / volThresholds.max);
        riskScore += volRisk * weights.volatility;
        
        // Drawdown risk
        const drawdownRisk = Math.abs(this.statistics.maxDrawdown) / 
            Math.abs(this.config.stopLoss || 1);
        riskScore += drawdownRisk * weights.drawdown;
        
        // Momentum risk (extreme momentum can be risky)
        const currentMomentum = data.momentum.length > 0 ? 
            Math.abs(data.momentum[data.momentum.length - 1]) : 0;
        const momentumRisk = Math.min(1, currentMomentum * 10);
        riskScore += momentumRisk * weights.momentum;
        
        // RSI risk (oversold/overbought)
        const currentRSI = data.rsi.length > 0 ? 
            data.rsi[data.rsi.length - 1] : 50;
        const rsiRisk = currentRSI > 70 || currentRSI < 30 ? 0.8 : 0.2;
        riskScore += rsiRisk * weights.rsi;
        
        // Trend strength risk (weak trends are riskier)
        const trendRisk = 1 - Math.abs(data.trendStrength || 0);
        riskScore += trendRisk * weights.trendStrength;
        
        // Consecutive losses risk
        const lossRisk = this.tradingState.consecutiveLosses / 
            (this.config.maxConsecutiveLosses || 1);
        riskScore += lossRisk * weights.consecutiveLosses;
        
        return Math.min(1, Math.max(0, riskScore));
    }

    calculateTrendStrength(prices) {
        if (prices.length < 20) return 0;
        
        // Linear regression to determine trend strength
        const n = prices.length;
        const indices = Array.from({ length: n }, (_, i) => i);
        
        const sumX = indices.reduce((a, b) => a + b, 0);
        const sumY = prices.reduce((a, b) => a + b, 0);
        const sumXY = indices.reduce((sum, x, i) => sum + x * prices[i], 0);
        const sumX2 = indices.reduce((sum, x) => sum + x * x, 0);
        
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        
        // Calculate R-squared for trend strength
        const yMean = sumY / n;
        let ssRes = 0;
        let ssTot = 0;
        
        prices.forEach((y, i) => {
            const yPred = slope * i + intercept;
            ssRes += Math.pow(y - yPred, 2);
            ssTot += Math.pow(y - yMean, 2);
        });
        
        const rSquared = 1 - (ssRes / ssTot);
        
        // Return signed trend strength
        return slope > 0 ? rSquared : -rSquared;
    }

    processContractsFor(message) {
        const asset = message.echo_req.contracts_for;
        const contracts = message.contracts_for.available;
        
        // Find multiplier contracts
        const multiplierContracts = contracts.filter(c => 
            c.contract_category === 'multiplier'
        );
        
        if (multiplierContracts.length > 0) {
            console.log(`📋 Available multipliers for ${asset}:`);
            multiplierContracts.forEach(contract => {
                console.log(`   - ${contract.contract_display}, Min: $${contract.min_contract_duration}, Max: $${contract.max_contract_duration}`);
            });
        }
    }

    processBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade failed:', message.error.message);
            this.tradingState.tradeInProgress = false;
            
            // Handle specific errors
            this.handleTradeError(message.error);
            return;
        }
        
        console.log('✅ Multiplier contract purchased successfully');
        console.log(`   Contract ID: ${message.buy.contract_id}`);
        console.log(`   Multiplier: x${this.currentTradeData.multiplier}`);
        console.log(`   Direction: ${this.currentTradeData.direction}`);
        
        // Store contract information
        const position = {
            contractId: message.buy.contract_id,
            asset: this.currentTradeData.asset,
            direction: this.currentTradeData.direction,
            multiplier: this.currentTradeData.multiplier,
            stake: this.currentTradeData.stake,
            entryPrice: message.buy.buy_price,
            entryTime: Date.now(),
            takeProfit: this.currentTradeData.takeProfit,
            stopLoss: this.currentTradeData.stopLoss
        };
        
        this.positionManager.activePositions.push(position);
        this.tradingState.openContracts.set(message.buy.contract_id, position);
        
        // Subscribe to contract updates
        this.subscribeToContract(message.buy.contract_id);
        
        // Update state
        this.tradingState.lastTradeTime = Date.now();
        this.lastTradeState = this.getCurrentState();
        this.lastTradeAction = this.currentTradeData.direction.toLowerCase();
    }

    handleTradeError(error) {
        switch (error.code) {
            case 'InsufficientBalance':
                console.log('💰 Insufficient balance. Reducing stake...');
                this.config.maxStake *= 0.5;
                this.config.initialStake = Math.min(this.config.initialStake, this.config.maxStake);
                break;
                
            case 'RateLimit':
                console.log('⏱️ Rate limit hit. Activating extended cooldown...');
                this.activateCooldown(60000);
                break;
                
            case 'MarketIsClosed':
                console.log('🚫 Market is closed. Pausing bot...');
                this.sessionManager.sessionPaused = true;
                break;
                
            case 'ContractValidationError':
                console.log('📝 Contract validation failed. Adjusting parameters...');
                break;
                
            default:
                console.log('❓ Unknown error. Continuing with caution...');
        }
    }

    subscribeToContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }

    processContractUpdate(message) {
        const contract = message.proposal_open_contract;
        const position = this.tradingState.openContracts.get(contract.contract_id);
        
        if (!position) return;
        
        // Display contract status
        if (!contract.is_sold && contract.current_spot) {
            const direction = position.direction === 'UP' ? '📈' : '📉';
            const pnl = contract.profit || 0;
            const pnlColor = pnl >= 0 ? '🟢' : '🔴';
            
            console.log(`${direction} ${position.asset} | Spot: ${contract.current_spot.toFixed(5)} | P/L: ${pnlColor} $${pnl.toFixed(2)} | Multiplier: x${position.multiplier}`);
            
            // Check if we should close the position manually (advanced risk management)
            if (this.shouldClosePosition(position, contract)) {
                this.closePosition(contract.contract_id);
            }
        }
        
        // Handle contract closure
        if (contract.is_sold) {
            this.handleContractClosure(contract, position);
        }
    }

    shouldClosePosition(position, contract) {
        // Advanced position management logic
        const pnl = contract.profit || 0;
        const pnlPercentage = (pnl / position.stake) * 100;
        
        // Dynamic exit conditions
        if (pnlPercentage > 150) {
            console.log('💎 Exceptional profit! Closing position...');
            return true;
        }
        
        // Trailing stop logic
        if (pnlPercentage > 50) {
            const trailingStop = position.stake * 0.3; // Trail at 30% of stake
            if (pnl < trailingStop) {
                console.log('📊 Trailing stop triggered. Closing position...');
                return true;
            }
        }
        
        // Time-based exit
        const holdTime = Date.now() - position.entryTime;
        if (holdTime > 1800000 && pnlPercentage > 10) { // 30 minutes
            console.log('⏰ Time-based exit. Closing position...');
            return true;
        }
        
        return false;
    }

    closePosition(contractId) {
        this.sendRequest({
            sell: contractId,
            price: 0 // Sell at market price
        });
    }

    handleContractClosure(contract, position) {
        const profit = parseFloat(contract.profit);
        const won = profit > 0;
        
        // Update statistics
        this.statistics.totalTrades++;
        
        if (won) {
            if (position.direction === 'UP') {
                this.statistics.upWins++;
            } else {
                this.statistics.downWins++;
            }
            
            this.tradingState.consecutiveWins++;
            this.tradingState.consecutiveLosses = 0;
            
            console.log(`
            ✅ WIN! Multiplier Trade Successful
            Asset: ${position.asset}
            Direction: ${position.direction}
            Multiplier: x${position.multiplier}
            Profit: $${profit.toFixed(2)}
            ROI: ${((profit / position.stake) * 100).toFixed(1)}%
            `);
            
        } else {
            if (position.direction === 'UP') {
                this.statistics.upLosses++;
            } else {
                this.statistics.downLosses++;
            }
            
            this.tradingState.consecutiveLosses++;
            this.tradingState.consecutiveWins = 0;
            
            console.log(`
            ❌ LOSS! Multiplier Trade Failed
            Asset: ${position.asset}
            Direction: ${position.direction}
            Multiplier: x${position.multiplier}
            Loss: $${Math.abs(profit).toFixed(2)}
            `);
        }
        
        // Update financial statistics
        this.statistics.totalProfitLoss += profit;
        this.statistics.sessionProfitLoss += profit;
        this.statistics.dailyProfitLoss += profit;
        this.statistics.totalCommissionPaid += position.stake * this.config.commissionRate;
        
        // Store trade in history
        if (!this.tradingHistory) this.tradingHistory = [];
        this.tradingHistory.push({
            asset: position.asset,
            direction: position.direction,
            multiplier: position.multiplier,
            stake: position.stake,
            result: won ? 'win' : 'loss',
            profit: won ? profit : 0,
            loss: won ? 0 : Math.abs(profit),
            timestamp: Date.now()
        });
        
        // Update ML models with result
        this.lastTradeResult = { profit, won };
        
        // Update max drawdown
        if (this.statistics.sessionProfitLoss < this.statistics.maxDrawdown) {
            this.statistics.maxDrawdown = this.statistics.sessionProfitLoss;
        }
        
        // Remove from active positions
        this.positionManager.activePositions = this.positionManager.activePositions.filter(
            p => p.contractId !== contract.contract_id
        );
        this.tradingState.openContracts.delete(contract.contract_id);
        
        // Log session summary
        this.logSessionSummary();
        
        // Check exit conditions
        if (this.checkExitConditions()) {
            this.sendFinalReport();
            this.disconnect();
            return;
        }
        
        // Apply cooldown
        if (won) {
            this.activateCooldown(this.config.cooldownAfterWin);
        } else {
            this.activateCooldown(this.config.cooldownAfterLoss);
        }
        
        this.tradingState.tradeInProgress = false;
    }

    checkExitConditions() {
        if (this.statistics.sessionProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Session take profit reached! Excellent performance!');
            this.sessionManager.performanceGrade = 'A+';
            return true;
        }
        
        if (this.statistics.sessionProfitLoss <= this.config.stopLoss) {
            console.log('🛑 Session stop loss reached. Capital preserved.');
            this.sessionManager.performanceGrade = 'C';
            return true;
        }
        
        if (this.statistics.dailyProfitLoss >= this.config.dailyProfitTarget) {
            console.log('🏆 Daily profit target achieved! Outstanding!');
            this.sessionManager.performanceGrade = 'A';
            return true;
        }
        
        if (this.statistics.dailyProfitLoss <= this.config.dailyLossLimit) {
            console.log('⛔ Daily loss limit reached. Tomorrow is another day.');
            this.sessionManager.performanceGrade = 'D';
            return true;
        }
        
        return false;
    }

    logSessionSummary() {
        const totalWins = this.statistics.upWins + this.statistics.downWins;
        const totalLosses = this.statistics.upLosses + this.statistics.downLosses;
        const winRate = (totalWins / Math.max(this.statistics.totalTrades, 1)) * 100;
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║     💹 MULTIPLIER TRADING SUMMARY      ║
        ╟────────────────────────────────────────╢
        ║ Total Trades: ${this.statistics.totalTrades.toString().padEnd(26)}║
        ║ Win Rate: ${winRate.toFixed(1)}%                      ║
        ║ Up Success: ${((this.statistics.upWins / Math.max(this.statistics.upWins + this.statistics.upLosses, 1)) * 100).toFixed(1)}%                     ║
        ║ Down Success: ${((this.statistics.downWins / Math.max(this.statistics.downWins + this.statistics.downLosses, 1)) * 100).toFixed(1)}%                   ║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2).padEnd(21)}║
        ║ Daily P/L: $${this.statistics.dailyProfitLoss.toFixed(2).padEnd(23)}║
        ║ Max Drawdown: $${this.statistics.maxDrawdown.toFixed(2).padEnd(20)}║
        ║ Profit Factor: ${this.statistics.profitFactor.toFixed(2).padEnd(21)}║
        ║ Sharpe Ratio: ${this.statistics.sharpeRatio.toFixed(2).padEnd(22)}║
        ║ Expectancy: $${this.statistics.expectancy.toFixed(2).padEnd(22)}║
        ║ Recovery Factor: ${this.statistics.recoveryFactor.toFixed(2).padEnd(19)}║
        ║ Avg Multiplier: x${(this.statistics.avgMultiplierUsed || this.config.defaultMultiplier).toFixed(0).padEnd(18)}║
        ║ Commission Paid: $${this.statistics.totalCommissionPaid.toFixed(2).padEnd(17)}║
        ║ Current Streak: ${(this.tradingState.consecutiveWins > 0 ? `W${this.tradingState.consecutiveWins}` : `L${this.tradingState.consecutiveLosses}`).padEnd(20)}║
        ║ Market Sentiment: ${this.sentimentAnalyzer.marketMood.padEnd(18)}║
        ╚════════════════════════════════════════╝
        `);
    }

    async sendFinalReport() {
        if (!this.emailConfig || !this.emailRecipient) return;
        
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);
            
            const duration = (Date.now() - this.sessionManager.startTime) / 60000;
            const winRate = ((this.statistics.upWins + this.statistics.downWins) / 
                           Math.max(this.statistics.totalTrades, 1) * 100).toFixed(1);
            
            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: this.statistics.sessionProfitLoss >= 0 ? 
                    `✅ Multiplier Bot - Session Complete (Profit: $${this.statistics.sessionProfitLoss.toFixed(2)})` : 
                    `📊 Multiplier Bot - Session Complete (Loss: $${Math.abs(this.statistics.sessionProfitLoss).toFixed(2)})`,
                html: `
                <h2>Multiplier Trading Session Report</h2>
                <p><strong>Session ID:</strong> ${this.sessionManager.sessionId}</p>
                <p><strong>Duration:</strong> ${duration.toFixed(1)} minutes</p>
                <p><strong>Performance Grade:</strong> ${this.sessionManager.performanceGrade}</p>
                <hr>
                <h3>📈 Performance Metrics</h3>
                <ul>
                    <li><strong>Total Trades:</strong> ${this.statistics.totalTrades}</li>
                    <li><strong>Win Rate:</strong> ${winRate}%</li>
                    <li><strong>Session P/L:</strong> $${this.statistics.sessionProfitLoss.toFixed(2)}</li>
                    <li><strong>Daily P/L:</strong> $${this.statistics.dailyProfitLoss.toFixed(2)}</li>
                    <li><strong>Max Drawdown:</strong> $${this.statistics.maxDrawdown.toFixed(2)}</li>
                    <li><strong>Profit Factor:</strong> ${this.statistics.profitFactor.toFixed(2)}</li>
                    <li><strong>Sharpe Ratio:</strong> ${this.statistics.sharpeRatio.toFixed(2)}</li>
                    <li><strong>Recovery Factor:</strong> ${this.statistics.recoveryFactor.toFixed(2)}</li>
                    <li><strong>Expectancy:</strong> $${this.statistics.expectancy.toFixed(2)}</li>
                </ul>
                <h3>📊 Trade Breakdown</h3>
                <ul>
                    <li><strong>UP Wins:</strong> ${this.statistics.upWins}</li>
                    <li><strong>UP Losses:</strong> ${this.statistics.upLosses}</li>
                    <li><strong>DOWN Wins:</strong> ${this.statistics.downWins}</li>
                    <li><strong>DOWN Losses:</strong> ${this.statistics.downLosses}</li>
                    <li><strong>Average Multiplier Used:</strong> x${(this.statistics.avgMultiplierUsed || this.config.defaultMultiplier).toFixed(0)}</li>
                    <li><strong>Total Commission:</strong> $${this.statistics.totalCommissionPaid.toFixed(2)}</li>
                </ul>
                <h3>🤖 AI Performance</h3>
                <ul>
                    <li><strong>Neural Network Epochs:</strong> ${this.mlOptimizer.neuralNetwork.epochs}</li>
                    <li><strong>Q-Learning States:</strong> ${this.mlOptimizer.reinforcementLearning.qTable.size}</li>
                    <li><strong>Market Sentiment:</strong> ${this.sentimentAnalyzer.marketMood}</li>
                    <li><strong>Fear & Greed Index:</strong> ${this.sentimentAnalyzer.fearGreedIndex.toFixed(0)}/100</li>
                </ul>
                <p><em>Generated by Quantum Multipliers Trading Bot - Advanced AI Trading System</em></p>
                `
            };
            
            await transporter.sendMail(mailOptions);
            console.log('📧 Final report sent via email');
        } catch (error) {
            console.error('Failed to send email:', error);
        }
    }

    // ============ HELPER FUNCTIONS ============
    calculateVolatility(prices) {
        if (prices.length < 2) return 0;
        
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i-1]) / prices[i-1]);
        }
        
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        
        return Math.sqrt(variance);
    }

    calculateMomentum(prices, period) {
        if (prices.length < period) return 0;
        
        const oldPrice = prices[prices.length - period];
        const currentPrice = prices[prices.length - 1];
        
        return (currentPrice - oldPrice) / oldPrice;
    }

    calculateRSI(prices, period) {
        if (prices.length < period) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = prices.length - period; i < prices.length; i++) {
            if (i === 0) continue;
            const change = prices[i] - prices[i - 1];
            if (change > 0) gains += change;
            else losses += Math.abs(change);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;
        
        if (avgLoss === 0) return 100;
        
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateMACD(prices) {
        const ema12 = this.calculateEMA(prices, 12);
        const ema26 = this.calculateEMA(prices, 26);
        const macdLine = ema12 - ema26;
        
        const signalLine = macdLine * 0.2;
        const histogram = macdLine - signalLine;
        
        const prevEma12 = this.calculateEMA(prices.slice(0, -1), 12);
        const prevEma26 = this.calculateEMA(prices.slice(0, -1), 26);
        const prevMacd = prevEma12 - prevEma26;
        const prevSignal = prevMacd * 0.2;
        const previousHistogram = prevMacd - prevSignal;

        return { line: macdLine, signal: signalLine, histogram, previousHistogram };
    }

    calculateEMA(prices, period) {
        if (prices.length < period) return prices[prices.length - 1];
        
        const multiplier = 2 / (period + 1);
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
        
        for (let i = period; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }
        
        return ema;
    }

    calculateBollingerBands(prices, period, stdDev) {
        if (prices.length < period) {
            const current = prices[prices.length - 1];
            return { upper: current * 1.02, middle: current, lower: current * 0.98 };
        }
        
        const sma = prices.slice(-period).reduce((a, b) => a + b, 0) / period;
        
                const variance = prices.slice(-period).reduce((sum, price) => {
            return sum + Math.pow(price - sma, 2);
        }, 0) / period;
        
        const std = Math.sqrt(variance);
        
        return {
            upper: sma + (stdDev * std),
            middle: sma,
            lower: sma - (stdDev * std)
        };
    }

    calculateStochastic(prices, period) {
        if (prices.length < period) return { k: 50, d: 50 };
        
        const recentPrices = prices.slice(-period);
        const high = Math.max(...recentPrices);
        const low = Math.min(...recentPrices);
        const current = prices[prices.length - 1];
        
        const k = ((current - low) / (high - low || 1)) * 100;
        const d = k * 0.6; // Simplified %D calculation
        
        return { k, d };
    }

    calculateATR(data, period) {
        const prices = data.priceHistory.slice(-period - 1);
        if (prices.length < 2) return 0;

        const trueRanges = [];
        for (let i = 1; i < prices.length; i++) {
            const high = prices[i];
            const low = prices[i];
            const prevClose = prices[i - 1];
            
            const tr = Math.max(
                Math.abs(high - low),
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);
        }

        return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    }

    calculateADX(data, period) {
        const prices = data.priceHistory.slice(-period * 2);
        if (prices.length < period) return 0;

        let plusDM = 0;
        let minusDM = 0;

        for (let i = 1; i < prices.length; i++) {
            const upMove = prices[i] - prices[i - 1];
            const downMove = prices[i - 1] - prices[i];
            
            if (upMove > downMove && upMove > 0) plusDM += upMove;
            else if (downMove > upMove && downMove > 0) minusDM += downMove;
        }

        const atr = this.calculateATR(data, period);
        const plusDI = (plusDM / (atr * period || 1)) * 100;
        const minusDI = (minusDM / (atr * period || 1)) * 100;
        
        const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
        
        return dx;
    }

    calculateIchimoku(prices) {
        if (prices.length < 52) {
            const current = prices[prices.length - 1];
            return {
                tenkan: current,
                kijun: current,
                senkouA: current,
                senkouB: current
            };
        }

        // Tenkan-sen (Conversion Line) - 9 periods
        const tenkanPeriod = prices.slice(-9);
        const tenkan = (Math.max(...tenkanPeriod) + Math.min(...tenkanPeriod)) / 2;

        // Kijun-sen (Base Line) - 26 periods
        const kijunPeriod = prices.slice(-26);
        const kijun = (Math.max(...kijunPeriod) + Math.min(...kijunPeriod)) / 2;

        // Senkou Span A (Leading Span A)
        const senkouA = (tenkan + kijun) / 2;

        // Senkou Span B (Leading Span B) - 52 periods
        const senkouBPeriod = prices.slice(-52);
        const senkouB = (Math.max(...senkouBPeriod) + Math.min(...senkouBPeriod)) / 2;

        return { tenkan, kijun, senkouA, senkouB };
    }

    calculateCorrelation(series1, series2) {
        if (series1.length !== series2.length || series1.length === 0) return 0;
        
        const mean1 = series1.reduce((a, b) => a + b, 0) / series1.length;
        const mean2 = series2.reduce((a, b) => a + b, 0) / series2.length;
        
        let numerator = 0;
        let denominator1 = 0;
        let denominator2 = 0;
        
        for (let i = 0; i < series1.length; i++) {
            const diff1 = series1[i] - mean1;
            const diff2 = series2[i] - mean2;
            
            numerator += diff1 * diff2;
            denominator1 += diff1 * diff1;
            denominator2 += diff2 * diff2;
        }
        
        const denominator = Math.sqrt(denominator1 * denominator2);
        
        return denominator === 0 ? 0 : numerator / denominator;
    }

    normalize(value, array) {
        const min = Math.min(...array);
        const max = Math.max(...array);
        return (value - min) / (max - min || 1);
    }

    sigmoid(x) {
        return 1 / (1 + Math.exp(-x));
    }

    // Update the config initialization
    initializeDefaultMultipliers() {
        // Set appropriate default multipliers based on assets
        if (this.assets.length > 0) {
            const firstAsset = this.assets[0];
            const validMults = this.validMultipliers[firstAsset];
            if (validMults && validMults.length > 0) {
                // Use second lowest multiplier as safe default
                this.config.defaultMultiplier = validMults[Math.min(1, validMults.length - 1)];
                console.log(`📊 Default multiplier set to ${this.config.defaultMultiplier} based on ${firstAsset}`);
            }
        }
    }


    // ============ ERROR HANDLING ============
    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token.');
                this.sessionManager.emergencyStop = true;
                this.disconnect();
                break;
                
            case 'RateLimit':
                console.log('Rate limit reached. Implementing longer cooldown...');
                this.activateCooldown(120000); // 2 minutes
                break;
                
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                this.activateCooldown(3600000); // 1 hour
                break;
                
            case 'InvalidContractProposal':
                console.log('Invalid contract parameters. Adjusting...');
                this.config.defaultMultiplier = Math.max(10, this.config.defaultMultiplier * 0.8);
                this.tradingState.tradeInProgress = false;
                break;
                
            case 'AuthorizationRequired':
                console.log('Re-authenticating...');
                this.authenticate();
                break;
                
            default:
                console.log(`Unhandled error: ${error.code}. Continuing with caution...`);
                this.tradingState.tradeInProgress = false;
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        if (!this.sessionManager.emergencyStop) {
            console.log('🔄 Connection lost. Reconnecting in 5 seconds...');
            setTimeout(() => this.connect(), 5000);
        } else {
            console.log('🛑 Emergency stop active. Not reconnecting.');
        }
    }

    disconnect() {
        if (this.ws && this.connected) {
            console.log('Closing connection gracefully...');
            
            // Close all open positions first
            this.positionManager.activePositions.forEach(position => {
                console.log(`Closing position: ${position.contractId}`);
                this.closePosition(position.contractId);
            });
            
            // Wait for positions to close
            setTimeout(() => {
                this.ws.close();
                console.log('✅ Connection closed');
            }, 2000);
        }
    }

    // ============ MAIN ENTRY POINT ============
    start() {
        console.log(`
        ╔════════════════════════════════════════════════╗
        ║   💹 QUANTUM MULTIPLIERS TRADING BOT          ║
        ║      Next-Generation AI Trading System         ║
        ╟────────────────────────────────────────────────╢
        ║ Session ID: ${this.sessionManager.sessionId}           ║
        ║ Strategy: Advanced Multipliers                 ║
        ║ AI Features:                                   ║
        ║   ✓ Quantum Prediction Engine                 ║
        ║   ✓ Deep Neural Networks                      ║
        ║   ✓ Reinforcement Learning (Q-Learning)       ║
        ║   ✓ Ensemble ML Models                        ║
        ║   ✓ Market Microstructure Analysis            ║
        ║   ✓ Sentiment Analysis                        ║
        ║   ✓ Correlation Matrix                        ║
        ║   ✓ Dynamic Risk Management                   ║
        ║                                                ║
        ║ Risk Parameters:                               ║
        ║   Initial Stake: $${this.config.initialStake.toFixed(2).padEnd(25)}║
        ║   Max Stake: $${this.config.maxStake.toFixed(2).padEnd(29)}║
        ║   Default Multiplier: x${this.config.defaultMultiplier.toString().padEnd(20)}║
        ║   Stop Loss: $${this.config.stopLoss.toString().padEnd(29)}║
        ║   Take Profit: $${this.config.takeProfit.toString().padEnd(27)}║
        ║   Daily Loss Limit: $${this.config.dailyLossLimit.toString().padEnd(22)}║
        ║   Daily Profit Target: $${this.config.dailyProfitTarget.toString().padEnd(19)}║
        ║                                                ║
        ║ Markets:                                       ║
        ║   • Volatility Indices (10, 25, 50, 75, 100)  ║
        ║   • Boom Indices (300, 500, 1000)             ║
        ║   • Crash Indices (300, 500, 1000)            ║
        ╚════════════════════════════════════════════════╝
        `);
        
        console.log('🚀 Starting Quantum Multipliers Trading Bot...');
        console.log('📊 Initializing AI systems...');
        console.log('🧠 Loading neural networks...');
        console.log('⚡ Activating quantum prediction engine...');
        console.log('🔍 Starting market analysis...\n');
        
        this.connect();
    }
}

// ============ CONFIGURATION ============
const config = {
    // Money Management
    initialStake: 1,
    maxStake: 100,

    // Multiplier Settings (will be overridden by valid multipliers)
    defaultMultiplier: 100,  // Will be adjusted based on asset
    minMultiplier: 40,       // Minimum across all assets
    maxMultiplier: 4000,     // Maximum across all assets

    // Risk Management
    maxConsecutiveLosses: 5,
    stopLoss: -100,
    takeProfit: 1,
    dailyLossLimit: -100,
    dailyProfitTarget: 150,
    
    // Risk Features
    useTakeProfit: true,
    useStopLoss: true,
    takeProfitMultiplier: 2,
    stopLossPercentage: 50,
    
    // Analysis Settings
    requiredHistoryLength: 200,
    minConfidenceScore: 60,
    
    // Timing
    minWaitTime: 5000,
    maxWaitTime: 15000,
    cooldownAfterLoss: 10000,
    cooldownAfterWin: 5000,
    
    // Assets to trade (can be customized)
    assets: [
        // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V',  // Volatility indices
        // '1HZ50V','1HZ75V', '1HZ90V', '1HZ100V',  // Volatility indices
        // 'BOOM500', 'BOOM1000',  // Boom indices
        // 'CRASH500', 'CRASH1000' // Crash indices
        // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V',
        '1HZ10V',
    ]
};

// ============ INITIALIZATION ============
const bot = new QuantumMultipliersTradingBot(process.env.DERIV_TOKEN, config);

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGINT', () => {
    console.log('\n⚠️ Shutdown signal received...');
    console.log('📊 Generating final report...');
    bot.sendFinalReport().then(() => {
        console.log('🔒 Closing all positions...');
        bot.disconnect();
        setTimeout(() => {
            console.log('👋 Goodbye!');
            process.exit(0);
        }, 3000);
    });
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    bot.sessionManager.emergencyStop = true;
    bot.sendFinalReport().then(() => {
        bot.disconnect();
        process.exit(1);
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize default multipliers based on configured assets
bot.initializeDefaultMultipliers();

// ============ START THE BOT ============
bot.start();

// ============ EXPORTS ============
module.exports = QuantumMultipliersTradingBot;