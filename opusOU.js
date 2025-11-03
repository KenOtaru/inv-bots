require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class QuantumOverUnderTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Strategic Asset Selection for Over/Under
        this.assets = config.assets || [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBEAR', 'RDBULL',
        ];

        // Advanced Configuration with Over/Under Specific Parameters
        this.config = {
            // Enhanced Money Management
            initialStake: config.initialStake || 0.35,
            baseMultiplier: config.baseMultiplier || 2.5,
            dynamicMultiplier: true,
            maxStake: config.maxStake || 25,
            kellyFraction: 0.25, // Conservative Kelly
            
            // Risk Management
            maxConsecutiveLosses: config.maxConsecutiveLosses || 4,
            stopLoss: config.stopLoss || -20,
            takeProfit: config.takeProfit || 8,
            dailyLossLimit: config.dailyLossLimit || -15,
            dailyProfitTarget: config.dailyProfitTarget || 12,
            
            // Analysis Windows
            ultraShortWindow: config.ultraShortWindow || 5,
            shortWindow: config.shortWindow || 20,
            mediumWindow: config.mediumWindow || 50,
            longWindow: config.longWindow || 100,
            megaWindow: config.megaWindow || 200,
            
            // Over/Under Specific Parameters
            digitBoundaries: {
                veryLow: [0, 1],      // High probability Under
                low: [2, 3],          // Good Under opportunities
                middle: [4, 5],       // Neutral zone
                high: [6, 7],         // Good Over opportunities
                veryHigh: [8, 9]      // High probability Over
            },
            
            // Trading Parameters
            requiredHistoryLength: config.requiredHistoryLength || 250,
            minConfidenceScore: config.minConfidenceScore || 75,
            patternStrength: config.patternStrength || 0.65,
            
            // Timing Controls
            minWaitTime: config.minWaitTime || 120000,
            maxWaitTime: config.maxWaitTime || 880000,
            cooldownAfterLoss: config.cooldownAfterLoss || 20000,
            cooldownAfterWin: config.cooldownAfterWin || 5000,
            
            // Advanced Analysis
            useDistributionAnalysis: true,
            useMarkovChains: true,
            useNeuralPrediction: true,
            useQuantumEntanglement: true,
            useBayesianInference: true,
            
            // Strategy Selection
            strategyMode: 'hybrid', // 'conservative', 'aggressive', 'hybrid'
            overBarriers: [0, 1, 2, 3],
            underBarriers: [6, 7, 8, 9],
        };

        this.config.allowedBarriers = [...this.config.overBarriers, ...this.config.underBarriers];

        // Trading State Management
        this.tradingState = {
            currentStake: this.config.initialStake,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            lastTradeTime: 0,
            tradeInProgress: false,
            cooldownActive: false,
            currentStrategy: null,
        };

        // Statistics
        this.statistics = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            overWins: 0,
            underWins: 0,
            overLosses: 0,
            underLosses: 0,
            totalProfitLoss: 0,
            sessionProfitLoss: 0,
            dailyProfitLoss: 0,
            barrierPerformance: {}, // Track performance per barrier
        };

        // Initialize barrier performance tracking
        for (let i = 0; i <= 9; i++) {
            this.statistics.barrierPerformance[i] = {
                over: { trades: 0, wins: 0 },
                under: { trades: 0, wins: 0 }
            };
        }

        // Pattern Data Storage
        this.patternData = {};
        this.assets.forEach(asset => {
            this.patternData[asset] = {
                tickHistory: [],
                digitFrequency: Array(10).fill(0),
                recentDistribution: Array(10).fill(0),
                markovMatrix: this.initializeMarkovMatrix(),
                patterns: new Map(),
                digitStreaks: {},
                lastDigit: null,
                trendDirection: 0,
                volatilityLevel: 0,
                predictionAccuracy: [],
            };
        });

        // Machine Learning Components
        this.mlModel = {
            weights: this.initializeMLWeights(),
            bias: Array(10).fill(0).map(() => Math.random() * 0.1),
            learningRate: 0.005,
            momentum: 0.9,
            velocities: Array(10).fill(0),
            trainingHistory: [],
        };

        // Markov Chain Model
        this.markovModel = {
            transitionMatrix: {},
            orderDepth: 2, // Second-order Markov chain
        };

        // Bayesian Model
        this.bayesianModel = {
            priors: Array(10).fill(0.1), // Uniform prior
            likelihoods: {},
            posteriors: Array(10).fill(0),
        };

        // Session Management
        this.sessionManager = {
            sessionId: this.generateSessionId(),
            startTime: Date.now(),
            tradesInSession: 0,
            sessionPaused: false,
            emergencyStop: false,
        };

        // Performance Tracking
        this.performanceMetrics = {
            overUnderRatio: 0.5,
            digitMomentum: {},
            cycleDetection: {},
            anomalyScores: {},
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

        // Initialize subsystems
        this.initializeAdvancedSystems();
    }

    // ============ INITIALIZATION ============
    initializeMLWeights() {
        const weights = [];
        for (let i = 0; i < 100; i++) { // 10 inputs x 10 outputs
            weights.push((Math.random() - 0.5) * 0.2);
        }
        return weights;
    }

    initializeMarkovMatrix() {
        const matrix = {};
        for (let i = 0; i < 10; i++) {
            matrix[i] = {};
            for (let j = 0; j < 10; j++) {
                matrix[i][j] = 0;
            }
        }
        return matrix;
    }

    generateSessionId() {
        return `QOU_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    initializeAdvancedSystems() {
        this.startPatternLearning();
        this.startRiskMonitoring();
        this.startPerformanceOptimizer();
        this.startAnomalyDetection();
    }

    // ============ CONNECTION MANAGEMENT ============
    connect() {
        if (this.sessionManager.emergencyStop) {
            console.log('⛔ Emergency stop activated. Manual intervention required.');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');
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
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('❌ Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('✅ Authentication successful');
            this.initializeTrading();
        } else if (message.msg_type === 'history') {
            this.processTickHistory(message);
        } else if (message.msg_type === 'tick') {
            this.processTick(message);
        } else if (message.msg_type === 'buy') {
            this.processBuyResponse(message);
        } else if (message.msg_type === 'proposal_open_contract') {
            this.processContractUpdate(message);
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    // ============ CORE ANALYSIS ENGINE ============
    analyzeTicks(asset) {
        if (this.tradingState.tradeInProgress || this.tradingState.cooldownActive) {
            return;
        }

        const data = this.patternData[asset];
        if (data.tickHistory.length < this.config.requiredHistoryLength) {
            return;
        }

        // Multi-dimensional Analysis
        const distributionAnalysis = this.analyzeDigitDistribution(data);
        const markovPrediction = this.predictWithMarkovChain(data);
        const mlPrediction = this.predictWithML(data);
        const bayesianPrediction = this.predictWithBayesian(data);
        const cycleAnalysis = this.analyzeCycles(data);
        const extremeAnalysis = this.analyzeExtremes(data);

        // Combine predictions with weighted voting
        const finalPrediction = this.combinePredictions({
            distribution: distributionAnalysis,
            markov: markovPrediction,
            ml: mlPrediction,
            bayesian: bayesianPrediction,
            cycle: cycleAnalysis,
            extreme: extremeAnalysis
        });

        console.log('Final predictions:', finalPrediction);

        // Validate and execute if confidence is high
        if (finalPrediction.confidence >= this.config.minConfidenceScore) {
            this.executeTrade(asset, finalPrediction);
        }
    }

    analyzeDigitDistribution(data) {
        const recentHistory = data.tickHistory.slice(-this.config.mediumWindow);
        const distribution = Array(10).fill(0);
        
        recentHistory.forEach(digit => {
            distribution[digit]++;
        });

        // Calculate statistical measures
        const mean = recentHistory.reduce((sum, d) => sum + d, 0) / recentHistory.length;
        const variance = recentHistory.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / recentHistory.length;
        const stdDev = Math.sqrt(variance);

        // Identify outliers and opportunities
        const zScores = distribution.map((count, digit) => {
            const expected = recentHistory.length / 10;
            return (count - expected) / Math.sqrt(expected);
        });

        // Find best barrier and direction
        let bestBarrier = null;
        let bestDirection = null;
        let maxScore = 0;

        // Check for Under opportunities (digits 9, 8, 7, 6)
        const underDigits = [9, 8, 7, 6];
        let underCount = 0;
        underDigits.forEach(digit => underCount += distribution[digit]);
        const underProb = underCount / recentHistory.length;
        const expectedUnderProb = underDigits.length / 10;

        if (underProb > expectedUnderProb * 1.2) { // Over-represented, good for an "under" trade
            const score = (underProb - expectedUnderProb) * 100;
            if (score > maxScore) {
                maxScore = score;
                bestBarrier = 9; // Trade Under 9 for highest safety
                bestDirection = 'under';
            }
        }

        // Check for Over opportunities (digits 0, 1, 2, 3)
        const overDigits = [0, 1, 2, 3];
        let overCount = 0;
        overDigits.forEach(digit => overCount += distribution[digit]);
        const overProb = overCount / recentHistory.length;
        const expectedOverProb = overDigits.length / 10;

        if (overProb > expectedOverProb * 1.2) { // Over-represented, good for an "over" trade
            const score = (overProb - expectedOverProb) * 100;
            if (score > maxScore) {
                maxScore = score;
                bestBarrier = 0; // Trade Over 0 for highest safety
                bestDirection = 'over';
            }
        }

        return {
            barrier: bestBarrier,
            direction: bestDirection,
            confidence: Math.min(maxScore * 2, 100),
            distribution,
            mean,
            stdDev
        };
    }

    predictWithMarkovChain(data) {
        if (data.tickHistory.length < this.markovModel.orderDepth + 1) {
            return { barrier: null, direction: null, confidence: 0 };
        }

        // Build transition probabilities
        const lastSequence = data.tickHistory.slice(-this.markovModel.orderDepth);
        const sequenceKey = lastSequence.join('');
        
        if (!this.markovModel.transitionMatrix[sequenceKey]) {
            // No history for this sequence
            return { barrier: null, direction: null, confidence: 0 };
        }

        const transitions = this.markovModel.transitionMatrix[sequenceKey];
        const totalTransitions = Object.values(transitions).reduce((a, b) => a + b, 0);
        
        if (totalTransitions < 5) {
            return { barrier: null, direction: null, confidence: 0 };
        }

        // Calculate probabilities for each digit
        const probabilities = Array(10).fill(0);
        for (let digit = 0; digit < 10; digit++) {
            probabilities[digit] = (transitions[digit] || 0) / totalTransitions;
        }

        // Find best Over/Under opportunity
        let bestBarrier = null;
        let bestDirection = null;
        let maxExpectedValue = -Infinity;

        // Check Over
        for (let barrier of this.config.overBarriers) {
            const overProb = probabilities.slice(barrier + 1).reduce((a, b) => a + b, 0);
            const overPayout = this.estimatePayout(barrier, 'over');
            const overEV = (overProb * overPayout) - (1 - overProb);
            
            if (overEV > maxExpectedValue) {
                maxExpectedValue = overEV;
                bestBarrier = barrier;
                bestDirection = 'over';
            }
        }

        // Check Under
        for (let barrier of this.config.underBarriers) {
            const underProb = probabilities.slice(0, barrier).reduce((a, b) => a + b, 0);
            const underPayout = this.estimatePayout(barrier, 'under');
            const underEV = (underProb * underPayout) - (1 - underProb);
            
            if (underEV > maxExpectedValue) {
                maxExpectedValue = underEV;
                bestBarrier = barrier;
                bestDirection = 'under';
            }
        }

        return {
            barrier: bestBarrier,
            direction: bestDirection,
            confidence: Math.min(Math.max(maxExpectedValue * 50, 0), 100),
            probabilities
        };
    }

    predictWithML(data) {
        const input = this.prepareMLInput(data);
        const output = this.forwardPass(input);
        
        // Find optimal barrier and direction
        let bestBarrier = null;
        let bestDirection = null;
        let maxScore = 0;

        // Check Over
        for (let barrier of this.config.overBarriers) {
            const overScore = output.slice(barrier + 1).reduce((a, b) => a + b, 0);
            if (overScore > maxScore) {
                maxScore = overScore;
                bestBarrier = barrier;
                bestDirection = 'over';
            }
        }

        // Check Under
        for (let barrier of this.config.underBarriers) {
            const underScore = output.slice(0, barrier).reduce((a, b) => a + b, 0);
            if (underScore > maxScore) {
                maxScore = underScore;
                bestBarrier = barrier;
                bestDirection = 'under';
            }
        }

        return {
            barrier: bestBarrier,
            direction: bestDirection,
            confidence: Math.min(maxScore * 100, 100),
            output
        };
    }

    predictWithBayesian(data) {
        const recentHistory = data.tickHistory.slice(-30);
        
        // Update likelihoods based on recent observations
        const likelihoods = Array(10).fill(0);
        recentHistory.forEach(digit => {
            likelihoods[digit]++;
        });
        
        // Normalize likelihoods
        const total = likelihoods.reduce((a, b) => a + b, 0);
        for (let i = 0; i < 10; i++) {
            likelihoods[i] = likelihoods[i] / total;
        }

        // Calculate posteriors using Bayes' theorem
        const posteriors = Array(10).fill(0);
        let posteriorSum = 0;
        
        for (let i = 0; i < 10; i++) {
            posteriors[i] = likelihoods[i] * this.bayesianModel.priors[i];
            posteriorSum += posteriors[i];
        }

        // Normalize posteriors
        for (let i = 0; i < 10; i++) {
            posteriors[i] = posteriors[i] / posteriorSum;
        }

        // Find optimal barrier
        let bestBarrier = null;
        let bestDirection = null;
        let maxBenefit = 0;

        // Check allowed barriers
        for (const barrier of this.config.allowedBarriers) {
            // Check Over if applicable
            if (this.config.overBarriers.includes(barrier)) {
                const overProb = posteriors.slice(barrier + 1).reduce((a, b) => a + b, 0);
                const overBenefit = overProb * this.estimatePayout(barrier, 'over');
                
                if (overBenefit > maxBenefit) {
                    maxBenefit = overBenefit;
                    bestBarrier = barrier;
                    bestDirection = 'over';
                }
            }

            // Check Under if applicable
            if (this.config.underBarriers.includes(barrier)) {
                const underProb = posteriors.slice(0, barrier).reduce((a, b) => a + b, 0);
                const underBenefit = underProb * this.estimatePayout(barrier, 'under');
                
                if (underBenefit > maxBenefit) {
                    maxBenefit = underBenefit;
                    bestBarrier = barrier;
                    bestDirection = 'under';
                }
            }
        }

        // Update priors for next iteration
        this.bayesianModel.priors = posteriors;

        return {
            barrier: bestBarrier,
            direction: bestDirection,
            confidence: Math.min(maxBenefit * 20, 100),
            posteriors
        };
    }

    analyzeCycles(data) {
        const windowSize = 50;
        const history = data.tickHistory.slice(-windowSize);
        
        if (history.length < windowSize) {
            return { barrier: null, direction: null, confidence: 0 };
        }

        // Detect cyclic patterns
        const cycles = [];
        for (let cycleLength = 3; cycleLength <= 10; cycleLength++) {
            let matches = 0;
            for (let i = cycleLength; i < history.length; i++) {
                if (history[i] === history[i - cycleLength]) {
                    matches++;
                }
            }
            const cycleStrength = matches / (history.length - cycleLength);
            if (cycleStrength > 0.3) {
                cycles.push({ length: cycleLength, strength: cycleStrength });
            }
        }

        if (cycles.length === 0) {
            return { barrier: null, direction: null, confidence: 0 };
        }

        // Use strongest cycle for prediction
        cycles.sort((a, b) => b.strength - a.strength);
        const strongestCycle = cycles[0];
        const predictedDigit = history[history.length - strongestCycle.length];

        // Determine best barrier and direction
        let barrier, direction;
        if (predictedDigit <= 4) {
            // Predict it will be low, so go Under with high barrier
            barrier = Math.min(predictedDigit + 4, 9);
            direction = 'under';
        } else {
            // Predict it will be high, so go Over with low barrier
            barrier = Math.max(predictedDigit - 4, 0);
            direction = 'over';
        }

        // Ensure barrier is allowed for the direction
        if (direction === 'over' && !this.config.overBarriers.includes(barrier)) {
            return { barrier: null, direction: null, confidence: 0 };
        }
        if (direction === 'under' && !this.config.underBarriers.includes(barrier)) {
            return { barrier: null, direction: null, confidence: 0 };
        }

        return {
            barrier,
            direction,
            confidence: strongestCycle.strength * 100,
            predictedDigit,
            cycleLength: strongestCycle.length
        };
    }

    analyzeExtremes(data) {
        const recentHistory = data.tickHistory.slice(-100);
        const veryRecent = data.tickHistory.slice(-10);
        
        // Count extremes in recent history
        const lowCount = recentHistory.filter(d => d <= 1).length;
        const highCount = recentHistory.filter(d => d >= 8).length;
        const recentLowCount = veryRecent.filter(d => d <= 1).length;
        const recentHighCount = veryRecent.filter(d => d >= 8).length;

        // Calculate deviation from expected
        const expectedExtreme = recentHistory.length * 0.2; // 20% for 0-1 or 8-9
        const lowDeviation = (expectedExtreme - lowCount) / expectedExtreme;
        const highDeviation = (expectedExtreme - highCount) / expectedExtreme;

        let barrier = null;
        let direction = null;
        let confidence = 0;

        // If lows are underrepresented and not recent
        if (lowDeviation > 0.3 && recentLowCount === 0) {
            barrier = 9;
            direction = 'under';
            confidence = lowDeviation * 60;
        }
        // If highs are underrepresented and not recent
        else if (highDeviation > 0.3 && recentHighCount === 0) {
            barrier = 0;
            direction = 'over';
            confidence = highDeviation * 60;
        }

        return {
            barrier,
            direction,
            confidence: Math.min(confidence, 100),
            lowDeviation,
            highDeviation
        };
    }

    combinePredictions(predictions) {
        const weights = {
            distribution: 0.25,
            markov: 0.20,
            ml: 0.20,
            bayesian: 0.15,
            cycle: 0.10,
            extreme: 0.10
        };

        // Score each barrier/direction combination
        const scores = {};
        
        Object.entries(predictions).forEach(([method, pred]) => {
            if (pred.barrier !== null && pred.direction !== null) {
                const key = `${pred.barrier}_${pred.direction}`;
                if (!scores[key]) {
                    scores[key] = 0;
                }
                scores[key] += pred.confidence * weights[method];
            }
        });

        // Find best combination
        let bestKey = null;
        let maxScore = 0;
        
        Object.entries(scores).forEach(([key, score]) => {
            if (score > maxScore) {
                maxScore = score;
                bestKey = key;
            }
        });

        if (!bestKey) {
            return { barrier: null, direction: null, confidence: 0 };
        }

        const [barrier, direction] = bestKey.split('_');
        
        return {
            barrier: parseInt(barrier),
            direction,
            confidence: maxScore,
            scores
        };
    }

    estimatePayout(barrier, direction) {
        // Updated estimates based on typical Deriv payouts with symmetry
        if (direction === 'over') {
            if (barrier === 0) return 0.11;
            if (barrier === 1) return 0.23;
            if (barrier === 2) return 0.35;
            if (barrier === 3) return 0.58; // Adjusted for p~0.6
            return 0.85; // Fallback
        } else { // under
            if (barrier === 9) return 0.11;
            if (barrier === 8) return 0.23;
            if (barrier === 7) return 0.35;
            if (barrier === 6) return 0.58; // Adjusted for p~0.6
            return 0.85; // Fallback
        }
    }

    // ============ MACHINE LEARNING FUNCTIONS ============
    prepareMLInput(data) {
        const input = [];
        
        // Recent digit frequency
        const recent = data.tickHistory.slice(-10);
        for (let i = 0; i < 10; i++) {
            input.push(recent.filter(d => d === i).length / 10);
        }
        
        return input;
    }

    forwardPass(input) {
        const output = Array(10).fill(0);
        
        for (let i = 0; i < 10; i++) {
            output[i] = this.mlModel.bias[i];
            for (let j = 0; j < 10; j++) {
                output[i] += input[j] * this.mlModel.weights[i * 10 + j];
            }
            output[i] = 1 / (1 + Math.exp(-output[i])); // Sigmoid
        }
        
        return output;
    }

    updateModel(tradeResult) {
        if (!tradeResult) return;
        
        const { mlInput, actualDigit, won } = tradeResult;
        
        if (!mlInput || actualDigit == null) return;
        
        // Calculate target
        let target = Array(10).fill(0);
        target[actualDigit] = 1;
        
        const input = mlInput;
        const output = this.forwardPass(input);
        
        // Backpropagation
        for (let i = 0; i < 10; i++) {
            const error = target[i] - output[i];
            const delta = error * output[i] * (1 - output[i]); // Sigmoid derivative
            
            // Update weights with momentum
            for (let j = 0; j < 10; j++) {
                const weightIndex = i * 10 + j;
                const gradient = delta * input[j] * this.mlModel.learningRate;
                this.mlModel.velocities[weightIndex] = 
                    this.mlModel.momentum * this.mlModel.velocities[weightIndex] + gradient;
                this.mlModel.weights[weightIndex] += this.mlModel.velocities[weightIndex];
            }
            
            // Update bias
            this.mlModel.bias[i] += delta * this.mlModel.learningRate;
        }
    }

    // ============ MARKOV CHAIN FUNCTIONS ============
    updateMarkovChain(data) {
        if (data.tickHistory.length < this.markovModel.orderDepth + 1) return;
        
        const history = data.tickHistory;
        for (let i = this.markovModel.orderDepth; i < history.length; i++) {
            const sequence = history.slice(i - this.markovModel.orderDepth, i).join('');
            const nextDigit = history[i];
            
            if (!this.markovModel.transitionMatrix[sequence]) {
                this.markovModel.transitionMatrix[sequence] = {};
            }
            
            if (!this.markovModel.transitionMatrix[sequence][nextDigit]) {
                this.markovModel.transitionMatrix[sequence][nextDigit] = 0;
            }
            
            this.markovModel.transitionMatrix[sequence][nextDigit]++;
        }
    }

    // ============ RISK MANAGEMENT ============
    calculateDynamicStake() {
        let stake = this.config.initialStake;
        
        // Apply Martingale with limits
        if (this.tradingState.consecutiveLosses > 0) {
            const multiplier = Math.min(
                this.config.baseMultiplier + (this.tradingState.consecutiveLosses * 0.3),
                4.0
            );
            stake = this.tradingState.currentStake * multiplier;
        }
        
        // Anti-martingale for winning streaks
        if (this.tradingState.consecutiveWins > 2) {
            stake = this.tradingState.currentStake * 1.15;
        }

        // Apply Kelly Criterion
        const winRate = this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1);
        if (winRate > 0 && this.statistics.totalTrades > 20) {
            const avgPayout = 0.85; // Conservative estimate
            const kelly = (winRate * avgPayout - (1 - winRate)) / avgPayout;
            const kellyStake = this.tradingState.currentStake * (1 + Math.max(0, kelly) * this.config.kellyFraction);
            stake = Math.min(stake, kellyStake);
        }

        // Apply limits
        stake = Math.min(stake, this.config.maxStake);
        stake = Math.max(stake, this.config.initialStake);

        return Math.round(stake * 100) / 100;
    }

    performPreTradeChecks() {
        // Check daily limits
        if (this.statistics.dailyProfitLoss <= this.config.stopLoss) {
            console.log('❌ Daily stop loss reached');
            this.sessionManager.emergencyStop = true;
            return false;
        }

        if (this.statistics.dailyProfitLoss >= this.config.dailyProfitTarget) {
            console.log('✅ Daily profit target reached');
            this.sessionManager.sessionPaused = true;
            return false;
        }

        // Check consecutive losses
        if (this.tradingState.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('⚠️ Max consecutive losses reached. Extended cooldown...');
            this.activateCooldown(this.config.cooldownAfterLoss * 3);
            return false;
        }

        // Check session time
        const sessionDuration = Date.now() - this.sessionManager.startTime;
        if (sessionDuration > 3600000) { // 1 hour
            console.log('⏱️ Session time limit reached');
            this.startNewSession();
            return false;
        }

        return true;
    }

    // ============ TRADE EXECUTION ============
    executeTrade(asset, prediction) {
        if (!this.performPreTradeChecks()) {
            return;
        }

        this.tradingState.tradeInProgress = true;
        this.tradingState.currentStake = this.calculateDynamicStake();

        const { barrier, direction, confidence } = prediction;

        console.log(`
        ╔════════════════════════════════════════╗
        ║       🎯 OVER/UNDER TRADE              ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(28)}    ║
        ║ Barrier: ${barrier}                              ║
        ║ Direction: ${direction.toUpperCase().padEnd(24)}       ║
        ║ Confidence: ${confidence.toFixed(1)}%                  ║
        ║ Stake: $${this.tradingState.currentStake.toFixed(2)}                     ║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2)}                ║
        ╚════════════════════════════════════════╝
        `);

        const request = {
            buy: 1,
            price: this.tradingState.currentStake,
            parameters: {
                amount: this.tradingState.currentStake,
                basis: 'stake',
                contract_type: 'OVER', // Will be set based on direction
                currency: 'USD',
                duration: 5, // Can be 1-10 ticks
                duration_unit: 't',
                symbol: asset,
                barrier: barrier.toString(),
            }
        };

        // Set contract type based on direction
        if (direction === 'over') {
            request.parameters.contract_type = 'DIGITOVER';
        } else {
            request.parameters.contract_type = 'DIGITUNDER';
        }

        this.currentTradeData = {
            asset,
            barrier,
            direction,
            confidence,
            stake: this.tradingState.currentStake,
            timestamp: Date.now(),
            mlInput: this.prepareMLInput(this.patternData[asset])
        };

        this.sendRequest(request);
    }

    // ============ MONITORING SYSTEMS ============
    startPatternLearning() {
        setInterval(() => {
            Object.keys(this.patternData).forEach(asset => {
                const data = this.patternData[asset];
                if (data.tickHistory.length > 100) {
                    this.updateMarkovChain(data);
                    this.updateDigitStreaks(data);
                    this.detectAnomalies(data);
                }
            });
        }, 30000); // Every 30 seconds
    }

    startRiskMonitoring() {
        setInterval(() => {
            this.checkRiskMetrics();
            this.adjustRiskParameters();
        }, 60000); // Every minute
    }

    startPerformanceOptimizer() {
        setInterval(() => {
            this.optimizeStrategy();
            this.updatePerformanceMetrics();
        }, 300000); // Every 5 minutes
    }

    startAnomalyDetection() {
        setInterval(() => {
            Object.keys(this.patternData).forEach(asset => {
                const anomalyScore = this.calculateAnomalyScore(this.patternData[asset]);
                this.performanceMetrics.anomalyScores[asset] = anomalyScore;
            });
        }, 120000); // Every 2 minutes
    }

    updateDigitStreaks(data) {
        const lastDigit = data.tickHistory[data.tickHistory.length - 1];
        
        if (!data.digitStreaks[lastDigit]) {
            data.digitStreaks[lastDigit] = { current: 0, max: 0 };
        }
        
        // Update current streak
        data.digitStreaks[lastDigit].current++;
        
        // Update max streak
        if (data.digitStreaks[lastDigit].current > data.digitStreaks[lastDigit].max) {
            data.digitStreaks[lastDigit].max = data.digitStreaks[lastDigit].current;
        }
        
        // Reset other streaks
        for (let d = 0; d < 10; d++) {
            if (d !== lastDigit && data.digitStreaks[d]) {
                data.digitStreaks[d].current = 0;
            }
        }
    }

    detectAnomalies(data) {
        const recentWindow = 50;
        const recent = data.tickHistory.slice(-recentWindow);
        
        // Calculate expected distribution
        const expected = Array(10).fill(recentWindow / 10);
        const actual = Array(10).fill(0);
        recent.forEach(d => actual[d]++);
        
        // Chi-square test for anomaly
        let chiSquare = 0;
        for (let i = 0; i < 10; i++) {
            chiSquare += Math.pow(actual[i] - expected[i], 2) / expected[i];
        }
        
        // Critical value for 9 degrees of freedom at 95% confidence
        const criticalValue = 16.919;
        
        console.log(`Chi-square: ${chiSquare.toFixed(2)}`);
        console.log(`monConfidence: ${this.config.minConfidenceScore}`);
        if (chiSquare > criticalValue) {
            console.log(`📊 Anomaly detected! Chi-square: ${chiSquare.toFixed(2)} > ${criticalValue.toFixed(2)}`);
            // Adjust strategy for anomalous conditions
            return;
            // this.config.minConfidenceScore = Math.min(90, this.config.minConfidenceScore + 5);
        } else {
            // if(this.config.minConfidenceScore > 65) {
                this.config.minConfidenceScore = 21;
            // }
        }
    }

    calculateAnomalyScore(data) {
        if (data.tickHistory.length < 100) return 0;
        
        const recent = data.tickHistory.slice(-50);
        const older = data.tickHistory.slice(-100, -50);
        
        // Compare distributions
        const recentDist = Array(10).fill(0);
        const olderDist = Array(10).fill(0);
        
        recent.forEach(d => recentDist[d]++);
        older.forEach(d => olderDist[d]++);
        
        // Calculate KL divergence
        let klDivergence = 0;
        for (let i = 0; i < 10; i++) {
            const p = (recentDist[i] + 1) / 52; // Add 1 for smoothing
            const q = (olderDist[i] + 1) / 52;
            if (p > 0 && q > 0) {
                klDivergence += p * Math.log(p / q);
            }
        }
        
        return klDivergence;
    }

    checkRiskMetrics() {
        const winRate = this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1);
        
        if (winRate < 0.35 && this.statistics.totalTrades > 20) {
            console.log('⚠️ Low win rate detected. Adjusting strategy...');
            this.config.minConfidenceScore = Math.min(85, this.config.minConfidenceScore + 5);
        }
        
        if (this.statistics.sessionProfitLoss < -10) {
            console.log('⚠️ Session loss limit approaching. Reducing risk...');
            this.config.maxStake = this.config.maxStake * 0.5;
        }
    }

    adjustRiskParameters() {
        // Dynamically adjust based on performance
        const recentTrades = Math.min(this.statistics.totalTrades, 20);
        if (recentTrades > 0) {
            const recentWinRate = this.calculateRecentWinRate(recentTrades);
            
            if (recentWinRate > 0.5) {
                // Performing well, can be slightly more aggressive
                this.config.baseMultiplier = Math.min(3.0, this.config.baseMultiplier * 1.05);
            } else if (recentWinRate < 0.3) {
                // Performing poorly, be more conservative
                this.config.baseMultiplier = Math.max(2.0, this.config.baseMultiplier * 0.95);
            }
        }
    }

    calculateRecentWinRate(trades) {
        // This would need trade history tracking
        // For now, use overall win rate
        return this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1);
    }

    optimizeStrategy() {
        // Analyze barrier performance
        let bestBarrier = null;
        let bestWinRate = 0;
        
        Object.entries(this.statistics.barrierPerformance).forEach(([barrier, perf]) => {
            const overWinRate = perf.over.trades > 0 ? perf.over.wins / perf.over.trades : 0;
            const underWinRate = perf.under.trades > 0 ? perf.under.wins / perf.under.trades : 0;
            
            const maxRate = Math.max(overWinRate, underWinRate);
            if (maxRate > bestWinRate) {
                bestWinRate = maxRate;
                bestBarrier = parseInt(barrier);
            }
        });
        
        if (bestBarrier !== null && bestWinRate > 0.5) {
            console.log(`📊 Optimizing: Best barrier is ${bestBarrier} with ${(bestWinRate * 100).toFixed(1)}% win rate`);
        }
    }

    updatePerformanceMetrics() {
        const overTrades = this.statistics.overWins + this.statistics.overLosses;
        const underTrades = this.statistics.underWins + this.statistics.underLosses;
        
        if (overTrades > 0 && underTrades > 0) {
            this.performanceMetrics.overUnderRatio = overTrades / (overTrades + underTrades);
        }
        
        // Log performance summary
        console.log(`
        ╔════════════════════════════════════════╗
        ║       📊 PERFORMANCE METRICS           ║
        ╟────────────────────────────────────────╢
        ║ Total Trades: ${this.statistics.totalTrades.toString().padEnd(25)}║
        ║ Win Rate: ${((this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1)) * 100).toFixed(1)}%                     ║
        ║ Over Win Rate: ${((this.statistics.overWins / Math.max(overTrades, 1)) * 100).toFixed(1)}%                 ║
        ║ Under Win Rate: ${((this.statistics.underWins / Math.max(underTrades, 1)) * 100).toFixed(1)}%                ║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2).padEnd(21)}║
        ╚════════════════════════════════════════╝
        `);
    }

    // ============ UTILITIES ============
    activateCooldown() {
        const duration = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + 1000;
        this.tradingState.cooldownActive = true;
        console.log(`❄️ Cooldown activated for ${duration / 1000} seconds`);
        
        setTimeout(() => {
            this.tradingState.cooldownActive = false;
            console.log('🔥 Cooldown ended. Resuming analysis...');
        }, duration);
    }

    startNewSession() {
        console.log('🔄 Starting new session...');
        this.sessionManager.sessionId = this.generateSessionId();
        this.sessionManager.startTime = Date.now();
        this.statistics.sessionProfitLoss = 0;
        
        // Reset ML velocities
        this.mlModel.velocities = Array(10).fill(0);
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    // ============ MESSAGE PROCESSORS ============
    initializeTrading() {
        console.log('🚀 Initializing Over/Under trading systems...');
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
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

    processTickHistory(message) {
        const asset = message.echo_req.ticks_history;
        const history = message.history.prices.map(price => this.getLastDigit(price, asset));
        
        this.patternData[asset].tickHistory = history;
        
        // Initialize frequency analysis
        history.forEach(digit => {
            this.patternData[asset].digitFrequency[digit]++;
        });
        
        console.log(`📊 Loaded ${history.length} ticks for ${asset}`);
        console.log(`   Frequency distribution:`, this.patternData[asset].digitFrequency);
    }

    processTick(message) {
        const tick = message.tick;
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);
        
        const data = this.patternData[asset];
        data.tickHistory.push(lastDigit);
        data.lastDigit = lastDigit;
        
        // Maintain history size
        if (data.tickHistory.length > this.config.requiredHistoryLength * 2) {
            data.tickHistory.shift();
        }
        
        // Update frequency
        data.digitFrequency[lastDigit]++;
        
        // Update recent distribution
        const recentWindow = data.tickHistory.slice(-50);
        data.recentDistribution = Array(10).fill(0);
        recentWindow.forEach(d => data.recentDistribution[d]++);
        
        if (this.tradingState.tradeInProgress) {
            console.log(`[${asset}] Tick: ${lastDigit} | Frequency: [${data.digitFrequency.join(',')}]`);
        }
        
        // Analyze if ready
        if (!this.tradingState.tradeInProgress && 
            data.tickHistory.length >= this.config.requiredHistoryLength) {
            this.analyzeTicks(asset);
        }
    }

    processBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade failed:', message.error.message);
            this.tradingState.tradeInProgress = false;
            return;
        }
        
        console.log('✅ Trade placed successfully');
        this.currentContractId = message.buy.contract_id;
        this.subscribeToContract(this.currentContractId);
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
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const actualDigit = contract.exit_tick_display ? 
            parseInt(contract.exit_tick_display.slice(-1)) : null;

        // Update statistics
        this.statistics.totalTrades++;
        
        if (won) {
            this.statistics.totalWins++;
            this.tradingState.consecutiveWins++;
            this.tradingState.consecutiveLosses = 0;
            this.tradingState.currentStake = this.config.initialStake;
            
            // Track Over/Under specific wins
            if (this.currentTradeData.direction === 'over') {
                this.statistics.overWins++;
            } else {
                this.statistics.underWins++;
            }
            
            console.log(`✅ WIN! Profit: $${profit.toFixed(2)}`);
            this.activateCooldown(this.config.cooldownAfterWin);
        } else {
            this.statistics.totalLosses++;
            this.tradingState.consecutiveLosses++;
            this.tradingState.consecutiveWins = 0;
            
            // Track Over/Under specific losses
            if (this.currentTradeData.direction === 'over') {
                this.statistics.overLosses++;
            } else {
                this.statistics.underLosses++;
            }
            
            console.log(`❌ LOSS! Loss: $${Math.abs(profit).toFixed(2)}`);
            this.activateCooldown(this.config.cooldownAfterLoss);
        }

        // Update barrier performance
        const barrier = this.currentTradeData.barrier;
        const direction = this.currentTradeData.direction;
        
        this.statistics.barrierPerformance[barrier][direction].trades++;
        if (won) {
            this.statistics.barrierPerformance[barrier][direction].wins++;
        }

        // Update ML model with prediction-time input
        this.updateModel({
            asset: this.currentTradeData.asset,
            predictedBarrier: barrier,
            predictedDirection: direction,
            actualDigit,
            won,
            mlInput: this.currentTradeData.mlInput
        });

        // Update financial statistics
        this.statistics.totalProfitLoss += profit;
        this.statistics.sessionProfitLoss += profit;
        this.statistics.dailyProfitLoss += profit;

        // Log summary
        this.logTradingSummary();

        // Check exit conditions
        if (this.checkExitConditions()) {
            this.disconnect();
            return;
        }

        this.tradingState.tradeInProgress = false;
    }

    checkExitConditions() {
        if (this.statistics.sessionProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Take profit reached!');
            this.sendSuccessEmail();
            return true;
        }
        
        if (this.statistics.sessionProfitLoss <= this.config.stopLoss) {
            console.log('🛑 Stop loss reached!');
            this.sendAlertEmail();
            return true;
        }
        
        if (this.statistics.dailyProfitLoss >= this.config.dailyProfitTarget) {
            console.log('🏆 Daily profit target achieved!');
            this.sendSuccessEmail();
            return true;
        }
        
        return false;
    }

    logTradingSummary() {
        const winRate = ((this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1)) * 100).toFixed(1);
        const overTrades = this.statistics.overWins + this.statistics.overLosses;
        const underTrades = this.statistics.underWins + this.statistics.underLosses;
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║       📈 TRADING SUMMARY               ║
        ╟────────────────────────────────────────╢
        ║ Total Trades: ${this.statistics.totalTrades.toString().padEnd(25)}║
        ║ Overall Win Rate: ${winRate}%                  ║
        ║ Over Trades: ${overTrades.toString().padEnd(26)}║
        ║ Under Trades: ${underTrades.toString().padEnd(25)}║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2).padEnd(21)}║
        ║ Daily P/L: $${this.statistics.dailyProfitLoss.toFixed(2).padEnd(23)}║
        ║ Current Stake: $${this.tradingState.currentStake.toFixed(2).padEnd(19)}║
        ║ Consecutive W/L: ${this.tradingState.consecutiveWins}W/${this.tradingState.consecutiveLosses}L            ║
        ╚════════════════════════════════════════╝
        `);
    }

    async sendAlertEmail() {
        if (!this.emailConfig.auth.user || !this.emailRecipient) return;

        try {
            const transporter = nodemailer.createTransport(this.emailConfig);
            
            await transporter.sendMail({
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: '⚠️ Over/Under Bot - Stop Loss Alert',
                text: `
                Stop loss reached!
                
                Session Stats:
                - Total Trades: ${this.statistics.totalTrades}
                - Win Rate: ${((this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1)) * 100).toFixed(1)}%
                - Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2)}
                - Consecutive Losses: ${this.tradingState.consecutiveLosses}
                `
            });
            
            console.log('📧 Alert email sent');
        } catch (error) {
            console.error('Failed to send email:', error);
        }
    }

    async sendSuccessEmail() {
        if (!this.emailConfig.auth.user || !this.emailRecipient) return;

        try {
            const transporter = nodemailer.createTransport(this.emailConfig);
            
            await transporter.sendMail({
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: '✅ Over/Under Bot - Profit Target Reached',
                text: `
                Profit target achieved!
                
                Session Stats:
                - Total Trades: ${this.statistics.totalTrades}
                - Win Rate: ${((this.statistics.totalWins / Math.max(this.statistics.totalTrades, 1)) * 100).toFixed(1)}%
                - Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2)}
                - Best Performing Barrier: ${this.getBestBarrier()}
                `
            });
            
            console.log('📧 Success email sent');
        } catch (error) {
            console.error('Failed to send email:', error);
        }
    }

    getBestBarrier() {
        let bestBarrier = null;
        let bestWinRate = 0;
        
        Object.entries(this.statistics.barrierPerformance).forEach(([barrier, perf]) => {
            const totalTrades = perf.over.trades + perf.under.trades;
            const totalWins = perf.over.wins + perf.under.wins;
            
            if (totalTrades > 0) {
                const winRate = totalWins / totalTrades;
                if (winRate > bestWinRate) {
                    bestWinRate = winRate;
                    bestBarrier = barrier;
                }
            }
        });
        
        return bestBarrier || 'N/A';
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token.');
                this.sessionManager.emergencyStop = true;
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Pausing...');
                this.activateCooldown(60000);
                break;
            default:
                console.log('Unhandled error. Continuing...');
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        if (!this.sessionManager.emergencyStop) {
            console.log('Reconnecting in 5 seconds...');
            setTimeout(() => this.connect(), 5000);
        }
    }

    disconnect() {
        if (this.ws && this.connected) {
            console.log('Closing connection...');
            this.ws.close();
        }
    }

    start() {
        console.log(`
        ╔════════════════════════════════════════╗
        ║   🚀 QUANTUM OVER/UNDER BOT 1.0        ║
        ║      Advanced Prediction System         ║
        ╟────────────────────────────────────────╢
        ║ Session: ${this.sessionManager.sessionId}  ║
        ║ Initial Stake: $${this.config.initialStake.toFixed(2)}                 ║
        ║ Stop Loss: $${this.config.stopLoss}                    ║
        ║ Take Profit: $${this.config.takeProfit}                  ║
        ║ Strategy: ${this.config.strategyMode.toUpperCase().padEnd(22)}    ║
        ╚════════════════════════════════════════╝
        `);
        
        this.connect();
    }
}

// Configuration
const config = {
    // Assets to trade
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    
    // Money Management
    initialStake: 1,
    baseMultiplier: 11.3,
    maxStake: 150,
    
    // Risk Management
    maxConsecutiveLosses: 3,
    stopLoss: -20,
    takeProfit: 80,
    dailyLossLimit: -25,
    dailyProfitTarget: 12,
    
    // Analysis Windows
    ultraShortWindow: 5,
    shortWindow: 20,
    mediumWindow: 50,
    longWindow: 100,
    megaWindow: 200,
    
    // Trading Parameters
    requiredHistoryLength: 250,
    minConfidenceScore: 20,
    
    // Timing
    cooldownAfterLoss: 120000,
    cooldownAfterWin: 880000,
    
    // Strategy
    strategyMode: 'hybrid',
};

// Initialize and start the bot
const bot = new QuantumOverUnderTradingBot('0P94g4WdSrSrzir', config);
bot.start();