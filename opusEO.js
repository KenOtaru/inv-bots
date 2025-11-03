require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class QuantumEvenOddTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Enhanced Asset Selection for Even/Odd
        this.assets = config.assets || [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100'
        ];

        // Advanced Configuration for Even/Odd Trading
        this.config = {
            // Enhanced Money Management for Even/Odd (96% payout)
            initialStake: config.initialStake || 0.35,
            baseMultiplier: config.baseMultiplier || 2.1, // Optimized for 96% payout
            dynamicMultiplierEnabled: true,
            maxStake: config.maxStake || 30,
            
            // Risk Management optimized for Even/Odd
            maxConsecutiveLosses: config.maxConsecutiveLosses || 4,
            stopLoss: config.stopLoss || -20,
            takeProfit: config.takeProfit || 8,
            dailyLossLimit: config.dailyLossLimit || -10,
            dailyProfitTarget: config.dailyProfitTarget || 15,
            
            // Pattern Analysis Windows
            ultraShortWindow: config.ultraShortWindow || 5,
            shortWindow: config.shortWindow || 20,
            mediumWindow: config.mediumWindow || 50,
            longWindow: config.longWindow || 100,
            megaWindow: config.megaWindow || 200,
            
            // Analysis Parameters
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidenceScore: config.minConfidenceScore || 75, // Lower threshold for 50/50 game
            patternStrength: config.patternStrength || 0.65,
            
            // Even/Odd Specific Parameters
            parityBias: config.parityBias || 0.52, // Expected value for bias detection
            clusterDetection: config.clusterDetection || true,
            streakThreshold: config.streakThreshold || 3,
            distributionSkewThreshold: config.distributionSkewThreshold || 0.05,
            
            // Timing Controls
            tickDuration: config.tickDuration || 1, // 1-tick contracts for quick results
            minWaitTime: config.minWaitTime || 2000,
            maxWaitTime: config.maxWaitTime || 8000,
            cooldownAfterLoss: config.cooldownAfterLoss || 15000,
            
            // Advanced Features
            bernoulliTracking: true,
            binomialAnalysis: true,
            markovChains: true,
            adaptiveThreshold: true,
        };

        // Trading State Management
        this.tradingState = {
            currentStake: this.config.initialStake,
            consecutiveLosses: 0,
            consecutiveWins: 0,
            lastTradeTime: 0,
            tradeInProgress: false,
            cooldownActive: false,
            currentParity: null, // 'even' or 'odd'
        };

        // Enhanced Statistics for Even/Odd
        this.statistics = {
            totalTrades: 0,
            evenWins: 0,
            oddWins: 0,
            evenLosses: 0,
            oddLosses: 0,
            totalProfitLoss: 0,
            sessionProfitLoss: 0,
            dailyProfitLoss: 0,
            maxDrawdown: 0,
            evenStreak: 0,
            oddStreak: 0,
            maxEvenStreak: 0,
            maxOddStreak: 0,
        };

        // Pattern Recognition for Even/Odd
        this.patternData = {};
        this.assets.forEach(asset => {
            this.patternData[asset] = {
                tickHistory: [],
                parityHistory: [], // Track even/odd sequence
                evenCount: 0,
                oddCount: 0,
                recentParity: [],
                streakData: { even: 0, odd: 0 },
                clusterMetrics: {},
                transitionMatrix: this.initializeTransitionMatrix(),
                binomialStats: {},
                lastPrediction: null,
                confidence: 0,
            };
        });

        // Binomial Distribution Analysis
        this.binomialAnalyzer = {
            sampleSize: 0,
            evenProbability: 0.5,
            oddProbability: 0.5,
            chiSquareValue: 0,
            pValue: 0,
            isRandom: true,
        };

        // Markov Chain Model
        this.markovModel = {
            transitionProbabilities: {
                evenToEven: 0.5,
                evenToOdd: 0.5,
                oddToEven: 0.5,
                oddToOdd: 0.5,
            },
            states: ['even', 'odd'],
            order: 2, // Second-order Markov chain
        };

        // Clustering Detection
        this.clusterAnalyzer = {
            currentCluster: null,
            clusterLength: 0,
            clusterHistory: [],
            avgClusterSize: 0,
        };

        // Session Management
        this.sessionManager = {
            sessionId: this.generateSessionId(),
            startTime: Date.now(),
            tradesInSession: 0,
            sessionPaused: false,
            emergencyStop: false,
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
        return `EO_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    initializeTransitionMatrix() {
        return {
            evenToEven: 0,
            evenToOdd: 0,
            oddToEven: 0,
            oddToOdd: 0,
            total: 0
        };
    }

    initializeAnalysisSystems() {
        // Start advanced pattern learning
        this.startParityAnalysis();
        
        // Initialize Bernoulli trial tracking
        this.startBernoulliTracking();
        
        // Start clustering detection
        this.startClusterDetection();
        
        // Initialize risk monitoring
        this.startRiskMonitoring();
    }

    // ============ CONNECTION MANAGEMENT ============
    connect() {
        if (this.sessionManager.emergencyStop) {
            console.log('⛔ Emergency stop activated. Manual intervention required.');
            return;
        }

        console.log('🔌 Connecting to Deriv API for Even/Odd Trading...');
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

    // ============ ADVANCED EVEN/ODD ANALYSIS ============
    analyzeEvenOddPattern(asset) {
        if (this.tradingState.tradeInProgress || this.tradingState.cooldownActive) {
            return;
        }

        const data = this.patternData[asset];
        if (data.parityHistory.length < this.config.requiredHistoryLength) {
            return;
        }

        // Multi-layer Analysis
        const bernoulliAnalysis = this.performBernoulliAnalysis(data);
        const markovPrediction = this.performMarkovAnalysis(data);
        const clusterAnalysis = this.analyzeClusterPatterns(data);
        const distributionAnalysis = this.analyzeParityDistribution(data);
        const streakAnalysis = this.analyzeStreakPatterns(data);
        const transitionAnalysis = this.analyzeTransitions(data);

        // Weighted Consensus Algorithm
        const predictions = [
            { parity: bernoulliAnalysis.prediction, weight: bernoulliAnalysis.confidence * 0.20 },
            { parity: markovPrediction.prediction, weight: markovPrediction.confidence * 0.25 },
            { parity: clusterAnalysis.prediction, weight: clusterAnalysis.confidence * 0.15 },
            { parity: distributionAnalysis.prediction, weight: distributionAnalysis.confidence * 0.15 },
            { parity: streakAnalysis.prediction, weight: streakAnalysis.confidence * 0.15 },
            { parity: transitionAnalysis.prediction, weight: transitionAnalysis.confidence * 0.10 }
        ].filter(p => p.parity !== null);

        if (predictions.length === 0) {
            console.log('No valid predictions available');
            return;
        }

        // Calculate weighted consensus
        let evenScore = 0;
        let oddScore = 0;
        let totalWeight = 0;

        predictions.forEach(pred => {
            if (pred.parity === 'even') {
                evenScore += pred.weight;
            } else {
                oddScore += pred.weight;
            }
            totalWeight += pred.weight;
        });

        // Determine prediction
        let predictedParity = evenScore > oddScore ? 'even' : 'odd';
        let confidence = Math.max(evenScore, oddScore) / totalWeight * 100;

        // Apply adaptive threshold
        if (this.config.adaptiveThreshold) {
            confidence = this.adjustConfidenceThreshold(confidence, data);
        }

        console.log(`
        📊 Even/Odd Analysis for ${asset}:
        - Even Score: ${(evenScore * 100).toFixed(1)}%
        - Odd Score: ${(oddScore * 100).toFixed(1)}%
        - Prediction: ${predictedParity.toUpperCase()}
        - Confidence: ${confidence.toFixed(1)}%
        `);

        // Execute trade if confidence meets threshold
        if (confidence >= this.config.minConfidenceScore) {
            data.lastPrediction = predictedParity;
            this.executeTrade(asset, predictedParity, confidence);
        }
    }

    performBernoulliAnalysis(data) {
        const recentHistory = data.parityHistory.slice(-100);
        const evenCount = recentHistory.filter(p => p === 'even').length;
        const oddCount = recentHistory.filter(p => p === 'odd').length;
        const total = evenCount + oddCount;

        if (total === 0) return { prediction: null, confidence: 0 };

        const evenProb = evenCount / total;
        const oddProb = oddCount / total;

        // Chi-square test for randomness
        const expected = total / 2;
        const chiSquare = Math.pow(evenCount - expected, 2) / expected + 
                         Math.pow(oddCount - expected, 2) / expected;

        // Determine if distribution is significantly skewed
        const isSkewed = chiSquare > 3.841; // 95% confidence level
        
        let prediction = null;
        let confidence = 0;

        if (isSkewed) {
            // Bet against the trend (regression to mean)
            prediction = evenProb > oddProb ? 'odd' : 'even';
            confidence = Math.abs(evenProb - oddProb) * 100;
        } else {
            // Random distribution, use recent micro-trend
            const microHistory = data.parityHistory.slice(-10);
            const microEven = microHistory.filter(p => p === 'even').length;
            prediction = microEven < 5 ? 'even' : 'odd';
            confidence = 50 + Math.abs(5 - microEven) * 5;
        }

        return { prediction, confidence, chiSquare, evenProb, oddProb };
    }

    performMarkovAnalysis(data) {
        const matrix = data.transitionMatrix;
        if (matrix.total < 50) return { prediction: null, confidence: 0 };

        // Calculate transition probabilities
        const probabilities = {
            evenToEven: matrix.evenToEven / Math.max(matrix.evenToEven + matrix.evenToOdd, 1),
            evenToOdd: matrix.evenToOdd / Math.max(matrix.evenToEven + matrix.evenToOdd, 1),
            oddToEven: matrix.oddToEven / Math.max(matrix.oddToEven + matrix.oddToOdd, 1),
            oddToOdd: matrix.oddToOdd / Math.max(matrix.oddToEven + matrix.oddToOdd, 1),
        };

        // Get last state
        const lastParity = data.parityHistory[data.parityHistory.length - 1];
        
        // Second-order Markov chain (look at last two states)
        let prediction = null;
        let confidence = 0;

        if (data.parityHistory.length >= 2) {
            const lastTwo = data.parityHistory.slice(-2);
            const pattern = lastTwo.join('_');
            
            // Enhanced pattern matching
            const patternCounts = this.countPatternOccurrences(data.parityHistory, 2);
            const nextCounts = this.getNextParityAfterPattern(data.parityHistory, pattern);
            
            if (nextCounts.total > 5) {
                prediction = nextCounts.even > nextCounts.odd ? 'even' : 'odd';
                confidence = Math.max(nextCounts.even, nextCounts.odd) / nextCounts.total * 100;
            }
        }

        // Fallback to first-order if second-order has low confidence
        if (confidence < 60) {
            if (lastParity === 'even') {
                prediction = probabilities.evenToOdd > probabilities.evenToEven ? 'odd' : 'even';
                confidence = Math.max(probabilities.evenToOdd, probabilities.evenToEven) * 100;
            } else {
                prediction = probabilities.oddToEven > probabilities.oddToOdd ? 'even' : 'odd';
                confidence = Math.max(probabilities.oddToEven, probabilities.oddToOdd) * 100;
            }
        }

        return { prediction, confidence, probabilities };
    }

    analyzeClusterPatterns(data) {
        const recentHistory = data.parityHistory.slice(-50);
        let clusters = [];
        let currentCluster = { parity: null, length: 0 };

        // Detect clusters (consecutive same parity)
        recentHistory.forEach(parity => {
            if (parity === currentCluster.parity) {
                currentCluster.length++;
            } else {
                if (currentCluster.length > 0) {
                    clusters.push({ ...currentCluster });
                }
                currentCluster = { parity, length: 1 };
            }
        });

        if (currentCluster.length > 0) {
            clusters.push(currentCluster);
        }

        // Analyze cluster patterns
        const avgClusterLength = clusters.reduce((sum, c) => sum + c.length, 0) / Math.max(clusters.length, 1);
        const lastCluster = clusters[clusters.length - 1] || { parity: null, length: 0 };

        let prediction = null;
        let confidence = 0;

        // If current cluster is getting long, predict switch
        if (lastCluster.length >= this.config.streakThreshold) {
            prediction = lastCluster.parity === 'even' ? 'odd' : 'even';
            confidence = 50 + (lastCluster.length - this.config.streakThreshold) * 10;
            confidence = Math.min(confidence, 85);
        } else if (avgClusterLength < 2) {
            // High alternation rate, continue pattern
            const lastParity = recentHistory[recentHistory.length - 1];
            prediction = lastParity === 'even' ? 'odd' : 'even';
            confidence = 65;
        } else {
            // Normal clustering, use recent bias
            const recentEven = recentHistory.slice(-10).filter(p => p === 'even').length;
            prediction = recentEven < 5 ? 'even' : 'odd';
            confidence = 55 + Math.abs(5 - recentEven) * 3;
        }

        return { prediction, confidence, clusters, avgClusterLength, lastCluster };
    }

    analyzeParityDistribution(data) {
        // Multiple time windows analysis
        const windows = [
            { size: 20, weight: 0.3 },
            { size: 50, weight: 0.4 },
            { size: 100, weight: 0.3 }
        ];

        let weightedPrediction = { even: 0, odd: 0 };
        let totalConfidence = 0;

        windows.forEach(window => {
            const history = data.parityHistory.slice(-window.size);
            if (history.length < window.size / 2) return;

            const evenCount = history.filter(p => p === 'even').length;
            const oddCount = history.filter(p => p === 'odd').length;
            const total = evenCount + oddCount;

            const evenRatio = evenCount / total;
            const oddRatio = oddCount / total;
            const deviation = Math.abs(evenRatio - 0.5);

            // If significant deviation, bet on regression to mean
            if (deviation > this.config.distributionSkewThreshold) {
                const underRepresented = evenRatio < oddRatio ? 'even' : 'odd';
                weightedPrediction[underRepresented] += window.weight;
                totalConfidence += deviation * 100 * window.weight;
            } else {
                // Random distribution, slight preference for alternation
                const lastParity = history[history.length - 1];
                const opposite = lastParity === 'even' ? 'odd' : 'even';
                weightedPrediction[opposite] += window.weight * 0.5;
                totalConfidence += 50 * window.weight;
            }
        });

        const prediction = weightedPrediction.even > weightedPrediction.odd ? 'even' : 'odd';
        const confidence = totalConfidence;

        return { prediction, confidence, distribution: weightedPrediction };
    }

    analyzeStreakPatterns(data) {
        const recentHistory = data.parityHistory.slice(-100);
        const streaks = this.identifyStreaks(recentHistory);
        
        // Calculate average streak lengths
        const evenStreaks = streaks.filter(s => s.parity === 'even');
        const oddStreaks = streaks.filter(s => s.parity === 'odd');
        
        const avgEvenStreak = evenStreaks.length > 0 ? 
            evenStreaks.reduce((sum, s) => sum + s.length, 0) / evenStreaks.length : 0;
        const avgOddStreak = oddStreaks.length > 0 ?
            oddStreaks.reduce((sum, s) => sum + s.length, 0) / oddStreaks.length : 0;

        // Get current streak
        const currentStreak = data.streakData;
        const currentParity = currentStreak.even > 0 ? 'even' : 
                            currentStreak.odd > 0 ? 'odd' : null;
        const currentLength = Math.max(currentStreak.even, currentStreak.odd);

        let prediction = null;
        let confidence = 0;

        if (currentParity) {
            const avgStreak = currentParity === 'even' ? avgEvenStreak : avgOddStreak;
            
            if (currentLength >= avgStreak && avgStreak > 0) {
                // Current streak exceeds average, predict break
                prediction = currentParity === 'even' ? 'odd' : 'even';
                confidence = 50 + Math.min((currentLength - avgStreak) * 10, 35);
            } else {
                // Streak below average, might continue
                prediction = currentParity;
                confidence = 45 + Math.min((avgStreak - currentLength) * 5, 25);
            }
        } else {
            // No current streak, use historical bias
            prediction = avgEvenStreak < avgOddStreak ? 'even' : 'odd';
            confidence = 50 + Math.abs(avgEvenStreak - avgOddStreak) * 5;
        }

        return { prediction, confidence, avgEvenStreak, avgOddStreak, currentStreak: currentLength };
    }

    analyzeTransitions(data) {
        const transitions = data.transitionMatrix;
        if (transitions.total < 30) return { prediction: null, confidence: 0 };

        // Calculate transition entropies
        const evenTransitions = transitions.evenToEven + transitions.evenToOdd;
        const oddTransitions = transitions.oddToEven + transitions.oddToOdd;

        if (evenTransitions === 0 || oddTransitions === 0) {
            return { prediction: null, confidence: 0 };
        }

        // Calculate probabilities
        const pEvenToEven = transitions.evenToEven / evenTransitions;
        const pEvenToOdd = transitions.evenToOdd / evenTransitions;
        const pOddToEven = transitions.oddToEven / oddTransitions;
        const pOddToOdd = transitions.oddToOdd / oddTransitions;

        // Calculate entropy for each state
        const evenEntropy = this.calculateEntropy([pEvenToEven, pEvenToOdd]);
        const oddEntropy = this.calculateEntropy([pOddToEven, pOddToOdd]);

        // Get last parity
        const lastParity = data.parityHistory[data.parityHistory.length - 1];
        
        let prediction = null;
        let confidence = 0;

        if (lastParity === 'even') {
            prediction = pEvenToOdd > pEvenToEven ? 'odd' : 'even';
            confidence = (1 - evenEntropy) * 100; // Lower entropy = higher confidence
        } else {
            prediction = pOddToEven > pOddToOdd ? 'even' : 'odd';
            confidence = (1 - oddEntropy) * 100;
        }

        return { prediction, confidence, evenEntropy, oddEntropy };
    }

    calculateEntropy(probabilities) {
        return probabilities.reduce((entropy, p) => {
            if (p > 0) {
                return entropy - p * Math.log2(p);
            }
            return entropy;
        }, 0);
    }

    identifyStreaks(history) {
        const streaks = [];
        let currentStreak = null;

        history.forEach(parity => {
            if (!currentStreak || currentStreak.parity !== parity) {
                if (currentStreak) {
                    streaks.push(currentStreak);
                }
                currentStreak = { parity, length: 1 };
            } else {
                currentStreak.length++;
            }
        });

        if (currentStreak) {
            streaks.push(currentStreak);
        }

        return streaks;
    }

    countPatternOccurrences(history, patternLength) {
        const patterns = {};
        
        for (let i = 0; i <= history.length - patternLength; i++) {
            const pattern = history.slice(i, i + patternLength).join('_');
            patterns[pattern] = (patterns[pattern] || 0) + 1;
        }
        
        return patterns;
    }

    getNextParityAfterPattern(history, pattern) {
        const patternLength = pattern.split('_').length;
        const results = { even: 0, odd: 0, total: 0 };
        
        for (let i = 0; i <= history.length - patternLength - 1; i++) {
            const currentPattern = history.slice(i, i + patternLength).join('_');
            if (currentPattern === pattern && i + patternLength < history.length) {
                const nextParity = history[i + patternLength];
                results[nextParity]++;
                results.total++;
            }
        }
        
        return results;
    }

    adjustConfidenceThreshold(confidence, data) {
        // Adaptive confidence based on recent performance
        const recentTrades = Math.min(this.statistics.totalTrades, 20);
        if (recentTrades < 5) return confidence;

        const recentWinRate = (this.statistics.evenWins + this.statistics.oddWins) / 
                             Math.max(this.statistics.totalTrades, 1);

        if (recentWinRate < 0.45) {
            // Performance below expectation, be more conservative
            return confidence * 0.9;
        } else if (recentWinRate > 0.55) {
            // Performance above expectation, can be slightly more aggressive
            return Math.min(confidence * 1.05, 95);
        }

        return confidence;
    }

    // ============ RISK MANAGEMENT FOR EVEN/ODD ============
    calculateDynamicStake() {
        let stake = this.config.initialStake;
        
        if (this.tradingState.consecutiveLosses > 0) {
            // Modified Martingale for 96% payout
            const multiplier = this.config.baseMultiplier;
            stake = this.tradingState.currentStake * multiplier;
            
            // Apply acceleration after multiple losses
            if (this.tradingState.consecutiveLosses >= 2) {
                stake *= 1.05; // Slight acceleration
            }
        } else if (this.tradingState.consecutiveWins > 2 && this.config.dynamicMultiplierEnabled) {
            // Positive progression after wins
            stake = this.tradingState.currentStake * 1.1;
        }

        // Apply Kelly Criterion for Even/Odd
        const kellyStake = this.calculateKellyStakeForEvenOdd();
        stake = Math.min(stake, kellyStake);

        // Apply hard limits
        stake = Math.min(stake, this.config.maxStake);
        stake = Math.max(stake, this.config.initialStake);

        return Math.round(stake * 100) / 100;
    }

    calculateKellyStakeForEvenOdd() {
        const winRate = (this.statistics.evenWins + this.statistics.oddWins) / 
                        Math.max(this.statistics.totalTrades, 1);
        const payout = 0.96; // 96% return on Even/Odd
        
        // Kelly formula for binary bets
        const kelly = (winRate * (1 + payout) - 1) / payout;
        const conservativeKelly = Math.max(kelly * 0.2, 0.01); // 20% Kelly for safety
        
        return this.tradingState.currentStake * (1 + conservativeKelly);
    }

    // ============ TRADE EXECUTION ============
    executeTrade(asset, predictedParity, confidence) {
        // Pre-trade validations
        if (!this.performPreTradeChecks()) {
            return;
        }

        this.tradingState.tradeInProgress = true;
        this.tradingState.currentStake = this.calculateDynamicStake();
        this.tradingState.currentParity = predictedParity;

        // Log current statistics for analysis
        const stats = this.patternData[asset];
        const evenPercentage = (stats.evenCount / Math.max(stats.evenCount + stats.oddCount, 1) * 100).toFixed(1);
        const oddPercentage = (stats.oddCount / Math.max(stats.evenCount + stats.oddCount, 1) * 100).toFixed(1);

        console.log(`
        ╔════════════════════════════════════════╗
        ║      🎯 EVEN/ODD TRADE EXECUTION       ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(32)} ║
        ║ Prediction: ${predictedParity.toUpperCase().padEnd(27)} ║
        ║ Confidence: ${confidence.toFixed(1)}%                  ║
        ║ Stake: $${this.tradingState.currentStake.toFixed(2)}                      ║
        ║ Stats: Even ${evenPercentage}% | Odd ${oddPercentage}%      ║
        ║ Current Streak: ${Math.max(stats.streakData.even, stats.streakData.odd)}                   ║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2)}            ║
        ╚════════════════════════════════════════╝
        `);

        const request = {
            buy: 1,
            price: this.tradingState.currentStake,
            parameters: {
                amount: this.tradingState.currentStake,
                basis: 'stake',
                contract_type: predictedParity === 'even' ? 'DIGITEVEN' : 'DIGITODD',
                currency: 'USD',
                duration: this.config.tickDuration,
                duration_unit: 't',
                symbol: asset,
            }
        };

        this.currentTradeData = {
            asset,
            predictedParity,
            confidence,
            stake: this.tradingState.currentStake,
            timestamp: Date.now()
        };

        this.sendRequest(request);
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
            console.log('⚠️ Max consecutive losses reached. Entering extended cooldown...');
            this.activateCooldown(this.config.cooldownAfterLoss * 2);
            return false;
        }

        // Check session time
        const sessionDuration = Date.now() - this.sessionManager.startTime;
        if (sessionDuration > 1800000) { // 30 minutes
            console.log('⏱️ Session time limit reached. Starting new session...');
            this.startNewSession();
            return false;
        }

        return true;
    }

    // ============ MONITORING SYSTEMS ============
    startParityAnalysis() {
        setInterval(() => {
            Object.keys(this.patternData).forEach(asset => {
                const data = this.patternData[asset];
                if (data.parityHistory.length > 100) {
                    this.updateParityStatistics(asset);
                }
            });
        }, 30000); // Every 30 seconds
    }

    startBernoulliTracking() {
        setInterval(() => {
            this.updateBinomialStatistics();
            this.checkForNonRandomness();
        }, 60000); // Every minute
    }

    startClusterDetection() {
        setInterval(() => {
            Object.keys(this.patternData).forEach(asset => {
                this.updateClusterMetrics(asset);
            });
        }, 45000); // Every 45 seconds
    }

    startRiskMonitoring() {
        setInterval(() => {
            this.checkRiskMetrics();
            this.adjustRiskParameters();
        }, 60000); // Every minute
    }

    updateParityStatistics(asset) {
        const data = this.patternData[asset];
        const recentHistory = data.parityHistory.slice(-200);
        
        // Update transition matrix
        for (let i = 1; i < recentHistory.length; i++) {
            const prev = recentHistory[i - 1];
            const curr = recentHistory[i];
            
            if (prev === 'even' && curr === 'even') data.transitionMatrix.evenToEven++;
            else if (prev === 'even' && curr === 'odd') data.transitionMatrix.evenToOdd++;
            else if (prev === 'odd' && curr === 'even') data.transitionMatrix.oddToEven++;
            else if (prev === 'odd' && curr === 'odd') data.transitionMatrix.oddToOdd++;
            
            data.transitionMatrix.total++;
        }

        // Update cluster metrics
        const clusters = this.identifyStreaks(recentHistory);
        data.clusterMetrics = {
            avgClusterSize: clusters.reduce((sum, c) => sum + c.length, 0) / Math.max(clusters.length, 1),
            maxClusterSize: Math.max(...clusters.map(c => c.length), 0),
            clusterCount: clusters.length
        };
    }

    updateBinomialStatistics() {
        // Aggregate statistics across all assets
        let totalEven = 0;
        let totalOdd = 0;
        
        Object.values(this.patternData).forEach(data => {
            totalEven += data.evenCount;
            totalOdd += data.oddCount;
        });
        
        const total = totalEven + totalOdd;
        if (total < 100) return;
        
        this.binomialAnalyzer.sampleSize = total;
        this.binomialAnalyzer.evenProbability = totalEven / total;
        this.binomialAnalyzer.oddProbability = totalOdd / total;
        
        // Chi-square test for randomness
        const expected = total / 2;
        this.binomialAnalyzer.chiSquareValue = 
            Math.pow(totalEven - expected, 2) / expected + 
            Math.pow(totalOdd - expected, 2) / expected;
        
        // Determine if distribution is random (chi-square < 3.841 for 95% confidence)
        this.binomialAnalyzer.isRandom = this.binomialAnalyzer.chiSquareValue < 3.841;
    }

    checkForNonRandomness() {
        if (!this.binomialAnalyzer.isRandom) {
            console.log(`
            ⚠️ Non-random distribution detected!
            Chi-square: ${this.binomialAnalyzer.chiSquareValue.toFixed(2)}
            Even probability: ${(this.binomialAnalyzer.evenProbability * 100).toFixed(1)}%
            Adjusting strategy...
            `);
            
            // Adjust confidence thresholds based on non-randomness
            if (this.binomialAnalyzer.chiSquareValue > 6.635) { // 99% confidence
                this.config.minConfidenceScore = Math.max(65, this.config.minConfidenceScore - 5);
            }
        }
    }

    updateClusterMetrics(asset) {
        const data = this.patternData[asset];
        const recentHistory = data.parityHistory.slice(-100);
        
        if (recentHistory.length < 20) return;
        
        const clusters = this.identifyStreaks(recentHistory);
        
        // Update cluster analyzer
        if (clusters.length > 0) {
            const lastCluster = clusters[clusters.length - 1];
            this.clusterAnalyzer.currentCluster = lastCluster.parity;
            this.clusterAnalyzer.clusterLength = lastCluster.length;
            this.clusterAnalyzer.clusterHistory = clusters;
            this.clusterAnalyzer.avgClusterSize = 
                clusters.reduce((sum, c) => sum + c.length, 0) / clusters.length;
        }
    }

    checkRiskMetrics() {
        const winRate = (this.statistics.evenWins + this.statistics.oddWins) / 
                        Math.max(this.statistics.totalTrades, 1);
        
        // Adjust strategy based on performance
        if (winRate < 0.45 && this.statistics.totalTrades > 20) {
            console.log('⚠️ Low win rate detected. Adjusting parameters...');
            this.config.minConfidenceScore = Math.min(85, this.config.minConfidenceScore + 5);
            this.config.cooldownAfterLoss = Math.min(30000, this.config.cooldownAfterLoss + 5000);
        } else if (winRate > 0.55 && this.statistics.totalTrades > 20) {
            console.log('✅ Good win rate. Optimizing parameters...');
            this.config.minConfidenceScore = Math.max(70, this.config.minConfidenceScore - 2);
        }
        
        // Check for extended losing streaks
        if (this.tradingState.consecutiveLosses >= 3) {
            console.log('⚠️ Extended losing streak. Implementing defensive measures...');
            this.config.baseMultiplier = Math.max(2.0, this.config.baseMultiplier - 0.05);
        }
    }

    adjustRiskParameters() {
        // Dynamic risk adjustment based on session performance
        const sessionWinRate = this.sessionManager.tradesInSession > 0 ?
            ((this.statistics.evenWins + this.statistics.oddWins) - 
             (this.sessionManager.startTime > 0 ? 0 : 0)) / this.sessionManager.tradesInSession : 0;
        
        if (sessionWinRate < 0.4 && this.sessionManager.tradesInSession > 10) {
            // Poor session performance, reduce risk
            this.config.maxStake = Math.max(10, this.config.maxStake * 0.8);
            console.log(`📉 Reducing max stake to $${this.config.maxStake.toFixed(2)}`);
        }
    }

    // ============ HELPER FUNCTIONS ============
    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        let lastDigit;
        if (['R_75', 'R_50'].includes(asset)) {
            lastDigit = fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            lastDigit = fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            lastDigit = fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }

        return lastDigit;
    }

    getParityFromDigit(digit) {
        return (digit % 2 === 0) ? 'even' : 'odd';
    }

    activateCooldown(duration) {
        this.tradingState.cooldownActive = true;
        console.log(`❄️ Cooldown activated for ${duration / 1000} seconds`);
        
        setTimeout(() => {
            this.tradingState.cooldownActive = false;
            console.log('🔥 Cooldown ended. Resuming analysis...');
        }, duration);
    }

    startNewSession() {
        console.log('🔄 Starting new trading session...');
        this.sessionManager.sessionId = this.generateSessionId();
        this.sessionManager.startTime = Date.now();
        this.sessionManager.tradesInSession = 0;
        this.statistics.sessionProfitLoss = 0;
        
        // Reset parity counts for fresh analysis
        Object.values(this.patternData).forEach(data => {
            data.evenCount = 0;
            data.oddCount = 0;
            data.streakData = { even: 0, odd: 0 };
        });
    }

    // ============ MESSAGE PROCESSORS ============
    initializeTrading() {
        console.log('🚀 Initializing Even/Odd trading systems...');
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
        const prices = message.history.prices;
        
        const data = this.patternData[asset];
        data.tickHistory = prices.map(price => this.getLastDigit(price, asset));
        data.parityHistory = data.tickHistory.map(digit => this.getParityFromDigit(digit));
        
        // Initialize counts
        data.evenCount = data.parityHistory.filter(p => p === 'even').length;
        data.oddCount = data.parityHistory.filter(p => p === 'odd').length;
        
        console.log(`📊 Loaded ${prices.length} ticks for ${asset}`);
        console.log(`   Even: ${data.evenCount} (${(data.evenCount / prices.length * 100).toFixed(1)}%)`);
        console.log(`   Odd: ${data.oddCount} (${(data.oddCount / prices.length * 100).toFixed(1)}%)`);
    }

    processTick(message) {
        const tick = message.tick;
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);
        const parity = this.getParityFromDigit(lastDigit);
        
        const data = this.patternData[asset];
        
        // Update tick history
        data.tickHistory.push(lastDigit);
        data.parityHistory.push(parity);
        
        // Update counts
        if (parity === 'even') {
            data.evenCount++;
            data.streakData.even++;
            data.streakData.odd = 0;
        } else {
            data.oddCount++;
            data.streakData.odd++;
            data.streakData.even = 0;
        }
        
        // Maintain history size
        if (data.tickHistory.length > this.config.requiredHistoryLength * 2) {
            const removedDigit = data.tickHistory.shift();
            const removedParity = data.parityHistory.shift();
            if (removedParity === 'even') data.evenCount--;
            else data.oddCount--;
        }
        
        // Update transition matrix
        if (data.parityHistory.length >= 2) {
            const prevParity = data.parityHistory[data.parityHistory.length - 2];
            if (prevParity === 'even' && parity === 'even') data.transitionMatrix.evenToEven++;
            else if (prevParity === 'even' && parity === 'odd') data.transitionMatrix.evenToOdd++;
            else if (prevParity === 'odd' && parity === 'even') data.transitionMatrix.oddToEven++;
            else if (prevParity === 'odd' && parity === 'odd') data.transitionMatrix.oddToOdd++;
            data.transitionMatrix.total++;
        }
        
        console.log(`[${asset}] Tick: ${lastDigit} (${parity}), Streak: ${parity === 'even' ? `Even ${data.streakData.even}` : `Odd ${data.streakData.odd}`}`);
        
        // Analyze if ready
        if (data.parityHistory.length >= this.config.requiredHistoryLength && 
            !this.tradingState.tradeInProgress && 
            !this.tradingState.cooldownActive) {
            this.analyzeEvenOddPattern(asset);
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
        const parity = this.tradingState.currentParity;
        
        // Update statistics
        this.statistics.totalTrades++;
        this.sessionManager.tradesInSession++;
        
        if (won) {
            if (parity === 'even') this.statistics.evenWins++;
            else this.statistics.oddWins++;
            
            this.tradingState.consecutiveWins++;
            this.tradingState.consecutiveLosses = 0;
            this.tradingState.currentStake = this.config.initialStake;
            
            console.log(`✅ WIN! ${parity.toUpperCase()} was correct! Profit: $${profit.toFixed(2)}`);
        } else {
            if (parity === 'even') this.statistics.evenLosses++;
            else this.statistics.oddLosses++;
            
            this.tradingState.consecutiveLosses++;
            this.tradingState.consecutiveWins = 0;
            
            console.log(`❌ LOSS! ${parity.toUpperCase()} was wrong! Loss: $${Math.abs(profit).toFixed(2)}`);
            
            // Apply cooldown after loss
            this.activateCooldown(this.config.cooldownAfterLoss);
        }
        
        // Update financial statistics
        this.statistics.totalProfitLoss += profit;
        this.statistics.sessionProfitLoss += profit;
        this.statistics.dailyProfitLoss += profit;
        
        // Update max drawdown
        if (this.statistics.sessionProfitLoss < this.statistics.maxDrawdown) {
            this.statistics.maxDrawdown = this.statistics.sessionProfitLoss;
        }
        
        // Update max streaks
        if (parity === 'even' && this.statistics.evenStreak > this.statistics.maxEvenStreak) {
            this.statistics.maxEvenStreak = this.statistics.evenStreak;
        }
        if (parity === 'odd' && this.statistics.oddStreak > this.statistics.maxOddStreak) {
            this.statistics.maxOddStreak = this.statistics.oddStreak;
        }
        
        // Log summary
        this.logTradingSummary();
        
        // Check exit conditions
        if (this.checkExitConditions()) {
            this.disconnect();
            return;
        }
        
        // Send email alerts for milestones
        if (this.statistics.sessionProfitLoss >= this.config.takeProfit * 0.8) {
            this.sendProgressAlert();
        }
        
        this.tradingState.tradeInProgress = false;
    }

    checkExitConditions() {
        if (this.statistics.sessionProfitLoss >= this.config.takeProfit) {
            console.log('🎯 Take profit reached!');
            this.sendSuccessAlert();
            return true;
        }
        
        if (this.statistics.sessionProfitLoss <= this.config.stopLoss) {
            console.log('🛑 Stop loss reached!');
            return true;
        }
        
        if (this.statistics.dailyProfitLoss >= this.config.dailyProfitTarget) {
            console.log('🏆 Daily profit target achieved!');
            this.sendSuccessAlert();
            return true;
        }
        
        if (this.statistics.dailyProfitLoss <= this.config.dailyLossLimit) {
            console.log('⛔ Daily loss limit reached!');
            return true;
        }
        
        return false;
    }

    logTradingSummary() {
        const totalWins = this.statistics.evenWins + this.statistics.oddWins;
        const totalLosses = this.statistics.evenLosses + this.statistics.oddLosses;
        const winRate = (totalWins / Math.max(this.statistics.totalTrades, 1)) * 100;
        
        const evenWinRate = this.statistics.evenWins / 
            Math.max(this.statistics.evenWins + this.statistics.evenLosses, 1) * 100;
        const oddWinRate = this.statistics.oddWins / 
            Math.max(this.statistics.oddWins + this.statistics.oddLosses, 1) * 100;
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║      📈 EVEN/ODD TRADING SUMMARY       ║
        ╟────────────────────────────────────────╢
        ║ Total Trades: ${this.statistics.totalTrades.toString().padEnd(25)}║
        ║ Overall Win Rate: ${winRate.toFixed(1)}%                ║
        ║ Even Win Rate: ${evenWinRate.toFixed(1)}%                  ║
        ║ Odd Win Rate: ${oddWinRate.toFixed(1)}%                   ║
        ║ Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2).padEnd(20)}║
        ║ Daily P/L: $${this.statistics.dailyProfitLoss.toFixed(2).padEnd(22)}║
        ║ Current Stake: $${this.tradingState.currentStake.toFixed(2).padEnd(17)}║
        ║ Consecutive Losses: ${this.tradingState.consecutiveLosses}                  ║
        ╚════════════════════════════════════════╝
        `);
    }

    async sendSuccessAlert() {
        if (!this.emailConfig || !this.emailRecipient) return;
        
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);
            
            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: '✅ Even/Odd Bot - Profit Target Reached!',
                text: `
                Great news! Your Even/Odd trading bot has reached its profit target.
                
                Session Statistics:
                - Total Trades: ${this.statistics.totalTrades}
                - Session P/L: $${this.statistics.sessionProfitLoss.toFixed(2)}
                - Win Rate: ${((this.statistics.evenWins + this.statistics.oddWins) / this.statistics.totalTrades * 100).toFixed(1)}%
                - Session Duration: ${((Date.now() - this.sessionManager.startTime) / 60000).toFixed(1)} minutes
                `
            };
            
            await transporter.sendMail(mailOptions);
            console.log('📧 Success alert email sent');
        } catch (error) {
            console.error('Failed to send email:', error);
        }
    }

    async sendProgressAlert() {
        // Similar to sendSuccessAlert but for progress updates
        // Implementation omitted for brevity
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
            case 'MarketIsClosed':
                console.log('Market closed. Waiting...');
                this.activateCooldown(3600000);
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
        ║   🎰 QUANTUM EVEN/ODD TRADING BOT      ║
        ║      Advanced Binary Trading System     ║
        ╟────────────────────────────────────────╢
        ║ Session ID: ${this.sessionManager.sessionId}      ║
        ║ Strategy: Even/Odd Prediction          ║
        ║ Payout: 96%                            ║
        ║ Initial Stake: $${this.config.initialStake.toFixed(2)}                 ║
        ║ Stop Loss: $${this.config.stopLoss}                    ║
        ║ Take Profit: $${this.config.takeProfit}                  ║
        ║                                        ║
        ║ Features:                              ║
        ║ ✓ Bernoulli Distribution Analysis     ║
        ║ ✓ Markov Chain Prediction             ║
        ║ ✓ Cluster Pattern Detection           ║
        ║ ✓ Adaptive Risk Management            ║
        ║ ✓ Multi-Window Analysis               ║
        ╚════════════════════════════════════════╝
        `);
        
        this.connect();
    }
}

// Configuration for Even/Odd Trading
const config = {
    // Money Management
    initialStake: 0.35,
    baseMultiplier: 2.1, // Optimized for 96% payout
    maxStake: 30,
    
    // Risk Management
    maxConsecutiveLosses: 4,
    stopLoss: -20,
    takeProfit: 8,
    dailyLossLimit: -10,
    dailyProfitTarget: 15,
    
    // Analysis Windows
    ultraShortWindow: 5,
    shortWindow: 20,
    mediumWindow: 50,
    longWindow: 100,
    megaWindow: 200,
    
    // Trading Parameters
    requiredHistoryLength: 500,
    minConfidenceScore: 95,
    cooldownAfterLoss: 15000,
    
    // Even/Odd Specific
    parityBias: 0.6,
    clusterDetection: true,
    streakThreshold: 3,
    distributionSkewThreshold: 0.15,
    
    // Advanced Features
    bernoulliTracking: true,
    binomialAnalysis: true,
    markovChains: true,
    adaptiveThreshold: true,
    
    // Assets to trade
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100']
};

// Initialize and start the bot
const bot = new QuantumEvenOddTradingBot(process.env.DERIV_TOKEN, config);
bot.start();