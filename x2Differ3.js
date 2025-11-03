const nodemailer = require('nodemailer');
const WebSocket = require('ws');

class PatternAnalyzer {
    constructor() {
        this.patterns = new Map();
        this.confidence = 0;
        this.minHistoryRequired = 500;
        this.patternHistory = {
            repetitions: [],
            digitFrequency: Array(10).fill(0),
            lastDigits: [],
            nonRepetitionStreak: 0,
            currentStreak: { digit: null, count: 0 }
        };
    }
    
    analyze(history) {
        // Ensure we have enough history
        if (!history || history.length < this.minHistoryRequired) {
            return { 
                shouldTrade: false, 
                confidence: 0,
                reason: `Insufficient history: ${history ? history.length : 0}/${this.minHistoryRequired}`
            };
        }
        
        // Validate that history contains only single digits (0-9)
        const validHistory = this.validateHistory(history);
        if (!validHistory) {
            console.error('Invalid history data - contains non-digit values');
            return { shouldTrade: false, confidence: 0, reason: 'Invalid history data' };
        }
        
        // Get the current (last) digit
        const currentDigit = history[history.length - 1];
        
        // Ensure currentDigit is a valid single digit
        if (!this.isValidDigit(currentDigit)) {
            console.error(`Invalid current digit: ${currentDigit}`);
            return { shouldTrade: false, confidence: 0, reason: 'Invalid current digit' };
        }
        
        // Analyze patterns
        const repetitionAnalysis = this.analyzeRepetitionPattern(history);
        const frequencyAnalysis = this.analyzeFrequency(history);
        const streakAnalysis = this.analyzeStreaks(history);
        const gapAnalysis = this.analyzeGaps(history, currentDigit);
        
        // Calculate confidence score
        const confidence = this.calculateConfidence({
            repetitionAnalysis,
            frequencyAnalysis,
            streakAnalysis,
            gapAnalysis
        });
        
        // Determine if we should trade
        const shouldTrade = this.shouldPlaceTrade({
            confidence,
            repetitionAnalysis,
            currentDigit
        });
        
        return {
            shouldTrade,
            confidence,
            predictedDigit: currentDigit, // The digit we predict WON'T appear next
            riskRewardRatio: 1.95,
            pattern: {
                type: 'non-repetition',
                currentDigit,
                repetitionRate: repetitionAnalysis.rate,
                nonRepetitionStreak: repetitionAnalysis.nonRepetitionStreak,
                frequency: frequencyAnalysis
            },
            analysis: {
                repetitionAnalysis,
                frequencyAnalysis,
                streakAnalysis,
                gapAnalysis
            }
        };
    }
    
    validateHistory(history) {
        if (!Array.isArray(history)) {
            return false;
        }
        
        // Check that all elements are single digits (0-9)
        for (const digit of history) {
            if (!this.isValidDigit(digit)) {
                console.error(`Invalid digit in history: ${digit}`);
                return false;
            }
        }
        
        return true;
    }
    
    isValidDigit(digit) {
        // Check if digit is a number between 0 and 9
        return Number.isInteger(digit) && digit >= 0 && digit <= 9;
    }
    
    analyzeRepetitionPattern(history) {
        let repetitions = 0;
        let nonRepetitionStreak = 0;
        let maxNonRepStreak = 0;
        const recent50 = history.slice(-50);
        const recent100 = history.slice(-100);
        
        // Count repetitions and non-repetition streaks
        for (let i = 1; i < history.length; i++) {
            if (history[i] === history[i-1]) {
                repetitions++;
                maxNonRepStreak = Math.max(maxNonRepStreak, nonRepetitionStreak);
                nonRepetitionStreak = 0;
            } else {
                nonRepetitionStreak++;
            }
        }
        
        // Check recent pattern
        let recentRepetitions = 0;
        for (let i = 1; i < recent50.length; i++) {
            if (recent50[i] === recent50[i-1]) {
                recentRepetitions++;
            }
        }

        // Per-digit repetition stats (overall)
        let perDigit = Array(10).fill(0).map(() => ({repeats: 0, appearances: 0, prob: 0}));
        for (let i = 0; i < history.length - 1; i++) {
            const d = history[i];
            if (this.isValidDigit(d)) {
                perDigit[d].appearances++;
                if (history[i + 1] === d) {
                    perDigit[d].repeats++;
                }
            }
        }
        perDigit.forEach(s => {
            s.prob = s.appearances > 0 ? s.repeats / s.appearances : 0;
        });

        // Per-digit repetition stats (recent 100)
        let recentPerDigit = Array(10).fill(0).map(() => ({repeats: 0, appearances: 0, prob: 0}));
        for (let i = 0; i < recent100.length - 1; i++) {
            const d = recent100[i];
            if (this.isValidDigit(d)) {
                recentPerDigit[d].appearances++;
                if (recent100[i + 1] === d) {
                    recentPerDigit[d].repeats++;
                }
            }
        }
        recentPerDigit.forEach(s => {
            s.prob = s.appearances > 0 ? s.repeats / s.appearances : 0;
        });
        
        return {
            rate: repetitions / (history.length - 1),
            recentRate: recentRepetitions / (recent50.length - 1),
            nonRepetitionStreak,
            maxNonRepStreak,
            totalRepetitions: repetitions,
            perDigit,
            recentPerDigit
        };
    }
    
    analyzeFrequency(history) {
        const frequency = Array(10).fill(0);
        const recent100 = history.slice(-100);
        const recentFrequency = Array(10).fill(0);
        
        // Count overall frequency
        for (const digit of history) {
            if (this.isValidDigit(digit)) {
                frequency[digit]++;
            }
        }
        
        // Count recent frequency
        for (const digit of recent100) {
            if (this.isValidDigit(digit)) {
                recentFrequency[digit]++;
            }
        }
        
        // Calculate distribution metrics
        const expectedFreq = history.length / 10;
        const expectedRecentFreq = recent100.length / 10;
        
        const distribution = frequency.map(count => ({
            count,
            percentage: (count / history.length) * 100,
            deviation: Math.abs(count - expectedFreq) / expectedFreq
        }));
        
        const recentDistribution = recentFrequency.map(count => ({
            count,
            percentage: (count / recent100.length) * 100,
            deviation: Math.abs(count - expectedRecentFreq) / expectedRecentFreq
        }));
        
        return {
            overall: distribution,
            recent: recentDistribution,
            totalSamples: history.length,
            recentSamples: recent100.length
        };
    }
    
    analyzeStreaks(history) {
        const streaks = Array(10).fill(null).map(() => ({
            current: 0,
            max: 0,
            count: 0,
            avgLength: 0
        }));
        
        let currentDigit = null;
        let currentStreak = 0;
        let allStreaks = [];
        
        for (const digit of history) {
            if (!this.isValidDigit(digit)) continue;
            
            if (digit === currentDigit) {
                currentStreak++;
            } else {
                if (currentDigit !== null && currentStreak > 0) {
                    streaks[currentDigit].max = Math.max(streaks[currentDigit].max, currentStreak);
                    allStreaks.push({ digit: currentDigit, length: currentStreak });
                }
                currentDigit = digit;
                currentStreak = 1;
            }
        }
        
        // Handle last streak
        if (currentDigit !== null) {
            streaks[currentDigit].current = currentStreak;
            streaks[currentDigit].max = Math.max(streaks[currentDigit].max, currentStreak);
        }
        
        return {
            byDigit: streaks,
            allStreaks,
            currentStreakDigit: currentDigit,
            currentStreakLength: currentStreak
        };
    }
    
    analyzeGaps(history, targetDigit) {
        if (!this.isValidDigit(targetDigit)) {
            return { gaps: [], avgGap: 0, lastGap: 0 };
        }
        
        const gaps = [];
        let lastIndex = -1;
        
        for (let i = 0; i < history.length; i++) {
            if (history[i] === targetDigit) {
                if (lastIndex !== -1) {
                    gaps.push(i - lastIndex);
                }
                lastIndex = i;
            }
        }
        
        const avgGap = gaps.length > 0 
            ? gaps.reduce((a, b) => a + b, 0) / gaps.length 
            : 0;
            
        const lastGap = history.length - 1 - lastIndex;
        
        return {
            gaps,
            avgGap,
            lastGap,
            gapCount: gaps.length,
            maxGap: gaps.length > 0 ? Math.max(...gaps) : 0,
            minGap: gaps.length > 0 ? Math.min(...gaps) : 0
        };
    }
    
    calculateConfidence(analyses) {
        const { repetitionAnalysis, frequencyAnalysis, streakAnalysis, gapAnalysis } = analyses;
        
        let confidence = 0;
        const weights = {
            repetition: 0.35,
            frequency: 0.20,
            streak: 0.25,
            gap: 0.20
        };
        
        // Repetition-based confidence (upgraded with per-digit analysis)
        const currentDigit = streakAnalysis.currentStreakDigit;
        const repAnalysis = repetitionAnalysis;
        let probRepeat = 0;
        let recentProb = 0;
        if (this.isValidDigit(currentDigit)) {
            probRepeat = repAnalysis.perDigit[currentDigit].prob;
            recentProb = repAnalysis.recentPerDigit[currentDigit].prob;
        }
        let repScore = 0;
        const currentPer = repAnalysis.perDigit[currentDigit] || {repeats: 0, appearances: 0};
        const recentPer = repAnalysis.recentPerDigit[currentDigit] || {repeats: 0, appearances: 0};

        if (currentPer.repeats === 0 && currentPer.appearances >= 50) {
            repScore = 1.0; // High certainty based on history (no repeats ever for this digit)
        } else if (probRepeat < 0.05) {
            repScore = 0.8 + (0.2 * (1 - probRepeat / 0.05));
        } else if (probRepeat < 0.15) {
            repScore = 0.5;
        } else if (probRepeat < 0.25) {
            repScore = 0.3;
        }

        // Boost with recent data
        if (recentPer.repeats === 0 && recentPer.appearances >= 10) {
            repScore = Math.max(repScore, 0.9);
        }
        repScore *= (1 - recentProb); // Adjust down if recent prob is higher
        confidence += weights.repetition * repScore;
        
        // Non-repetition streak bonus
        if (repAnalysis.nonRepetitionStreak > 5) {
            confidence += 0.1;
        }
        if (repAnalysis.nonRepetitionStreak > 10) {
            confidence += 0.1;
        }
        
        // Frequency-based confidence (looking for outliers)
        if (this.isValidDigit(currentDigit)) {
            const digitFreq = frequencyAnalysis.overall[currentDigit];
            if (digitFreq && digitFreq.deviation > 0.3) {
                confidence += weights.frequency * 0.5;
            }
        }
        
        // Streak-based confidence
        if (streakAnalysis.currentStreakLength === 1) {
            confidence += weights.streak * 0.3; // Less likely to repeat immediately
        }
        
        // Gap-based confidence
        if (gapAnalysis.avgGap > 10) {
            confidence += weights.gap;
        } else if (gapAnalysis.avgGap > 5) {
            confidence += weights.gap * 0.5;
        }
        
        return Math.min(confidence, 1.0); // Cap at 100%
    }
    
    shouldPlaceTrade(params) {
        const { confidence, repetitionAnalysis, currentDigit } = params;
        
        // Validate current digit
        if (!this.isValidDigit(currentDigit)) {
            console.error(`Invalid digit for trade: ${currentDigit}`);
            return false;
        }
        
        // Basic confidence threshold (upgraded to higher for more certainty)
        if (confidence < 0.85) {
            return false;
        }
        
        // Additional safety checks
        if (repetitionAnalysis.rate > 0.20) {
            return false; // Too many repetitions in history
        }
        
        if (repetitionAnalysis.nonRepetitionStreak < 5) {
            return false; // Not enough non-repetition momentum
        }
        
        return true;
    }
    
    analyzeHistory(history) {
        // Validate history first
        if (!this.validateHistory(history)) {
            console.error('Cannot analyze invalid history');
            return;
        }
        
        console.log(`Analyzing ${history.length} historical data points...`);
        
        // Update pattern history
        this.patternHistory.lastDigits = history.slice(-20);
        
        // Count digit frequency
        this.patternHistory.digitFrequency = Array(10).fill(0);
        for (const digit of history) {
            if (this.isValidDigit(digit)) {
                this.patternHistory.digitFrequency[digit]++;
            }
        }
        
        // Log analysis summary
        const analysis = this.analyze(history);
        if (analysis) {
            console.log('Pattern Analysis Summary:');
            console.log(`- Should Trade: ${analysis.shouldTrade}`);
            console.log(`- Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
            if (this.isValidDigit(analysis.predictedDigit)) {
                // console.log(`- Predicted Digit (to avoid): ${analysis.predictedDigit}`);
            }
        }
    }
}

// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_50','R_100','R_25','R_75', 'R_10',
            'R_100'
        ];

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
        };

        // Initialize existing properties
        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.tickHistory = [];
        this.tradeInProgress = false;
        this.wsReady = false;
        this.predictedDigit = null;
        this.Percentage = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.Pause = false;
        this.RestartTrading = true;
        this.endOfDay = false;
        this.requiredHistoryLength = 1000; // Increased for deeper history analysis
        this.kCount = false;
        this.kCountNum = 0;
        this.kLoss = 0;
        this.multiplier2 = false;
        this.confidenceThreshold = null; 
        this.kTradeCount = 0;
        this.isWinTrade = true;
        this.waitTime = 0;
        this.LossDigitsList = [];
        this.threeConsecutiveDigits = 0;
        this.patternAnalyzer = new PatternAnalyzer();// Advanced pattern analyzer
        this.kTrade = false;
        this.xDigit = null;

        // Anti-Algorithm Detection System
        this.antiAlgorithm = {
            trapIndicators: [],
            algorithmFatigue: 0,
            counterPatternDetected: false,
            manipulationScore: 0,
            suspiciousPatterns: [],
            baitPatterns: new Map(),
            reverseLogicScore: 0,
            chaosLevel: 0,
            predictabilityInversion: false
        };

        // Chaos Theory Metrics
        this.chaos = {
            lyapunovExponent: 0,
            butterflyEffect: [],
            strangeAttractor: null,
            bifurcationPoints: [],
            sensitivityScore: 0,
            fractalDimension: 0,
            emergentPatterns: []
        };
        
        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.tickSubscriptionId = null;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        this.startEmailTimer();
    }

    connect() {
        console.log('Attempting to connect to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('Connected to Deriv API');
            this.connected = true;
            this.wsReady = true;
            this.reconnectAttempts = 0;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data);
            this.handleMessage(message);
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            this.handleDisconnect();
        });

        this.ws.on('close', () => {
            console.log('Disconnected from Deriv API');
            this.connected = false;
            if(!this.Pause) {
                this.handleDisconnect();
            }
        });
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        } 
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorEmail('Invalid API token');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.startTrading(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.startTrading();
        }
    }

    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        });
    }

    subscribeToTickHistory(asset) {
        const request = {
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        console.log(`Requested tick history for asset: ${asset}`);
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('Authentication successful');

            this.tradeInProgress = false;
            this.lastDigitsList = [];
            this.tickHistory = [];
            
            this.startTrading();

        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);
        } else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('Trade placed successfully');
            this.currentTradeId = message.buy.contract_id;
            this.subscribeToOpenContract(this.currentTradeId);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Error receiving contract update:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            console.log('Successfully unsubscribed from ticks');
            this.tickSubscriptionId = null;
        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
            console.log(`Subscribed to ticks. Subscription ID: ${this.tickSubscriptionId}`);
        } else if (message.error) {
            this.handleApiError(message.error);
        }
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

    startTrading() {
        console.log('Starting trading...');
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.usedAssets.size === this.assets.length) {
            this.usedAssets = new Set();
        }
            
        if (this.RestartTrading) {            
            let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }
        console.log(`Selected asset: ${this.currentAsset}`);
        
        this.unsubscribeFromTicks(() => {
            this.subscribeToTickHistory(this.currentAsset);
            this.subscribeToTicks(this.currentAsset);
        });

        this.RestartTrading = false;
    }
        
    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        
    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);
        
        // Update tick history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        // Update pattern analyzer with new history
        if(!this.tradeInProgress) { 
         this.patternAnalyzer.analyzeHistory(this.tickHistory);
        }
                       
        if(this.tradeInProgress) { 
            console.log(`📊 Recent tick History: ${this.tickHistory.slice(-10).join(',')}`);           
        } else {
            console.log(`📊 Recent tick History: ${this.tickHistory.slice(-10).join(',')}`); 
        }

        // Enhanced logging
        if(!this.tradeInProgress) { 
            this.analyzeTicksEnhanced();           
        }
    }
        
    analyzeTicksEnhanced() {
        if (this.tradeInProgress) {
            return;
        }

        // Get pattern analysis
        const analysis = this.patternAnalyzer.analyze(this.tickHistory);
        // Anti-algorithm detection
        const antiAlgAnalysis = this.detectAlgorithmicManipulation();
        // Chaos theory application
        const chaosAnalysis = this.applyChaosTheory();
       
        const confidence = (analysis.confidence * 100).toFixed(1);
        let antiAlgorithmScore = 0;
        if (antiAlgAnalysis) {
            antiAlgorithmScore = (1 - antiAlgAnalysis.trapLikelihood) * 100;
        }

        // console.log('Anti-Algorithm Manipulation Score:', antiAlgorithmScore.toFixed(1), '%');
        // console.log('Chaos Level:', chaosAnalysis ? chaosAnalysis.confidence.toFixed(2) : 'N/A');
        // if (chaosAnalysis && chaosAnalysis.components) {
        //     console.log(' - Lyapunov:', chaosAnalysis.components.lyapunovScore.toFixed(2), 'Sensitivity:', chaosAnalysis.components.sensitivityScore.toFixed(2), 'Butterfly:', chaosAnalysis.components.butterflyScore.toFixed(2), 'Bifurcation:', chaosAnalysis.components.bifurcationScore.toFixed(2), 'AttractorDisp:', chaosAnalysis.components.attractorDispersion.toFixed(2));
        // }
        // console.log('Market in Chaos? :', chaosAnalysis ? chaosAnalysis.inChaoticRegime : 'N/A');


        // if(confidence > 85) {
        //   this.kTrade = true;
        // }

        // Chaos check
        // if (chaosAnalysis && chaosAnalysis.inChaoticRegime) {
        //     console.log('Market is in a chaotic state. No trade will be placed.');
        //     return;
        // }
        
        // Place trade if confidence is above 85% (upgraded for higher certainty)
        if (this.consecutiveLosses < 1) {
          if (confidence > 76) {
            this.xDigit = analysis.predictedDigit;
             this.placeTrade(analysis.predictedDigit, confidence);
           } 
        } else {
           if (confidence > 76 && this.xDigit !== analysis.predictedDigit && this.xDigit - 1 !== analysis.predictedDigit && this.xDigit + 1 !== analysis.predictedDigit) {
             this.xDigit = analysis.predictedDigit;
             this.placeTrade(analysis.predictedDigit, confidence);
           }
        }
    }

    // Anti-Algorithm Detection
    detectAlgorithmicManipulation() {
        const history = this.tickHistory;
        if (history.length < 50) return null;
        
        const antiAlg = this.antiAlgorithm;
        
        // Detect if patterns break exactly when expected (trap indicator)
        let trapScore = 0;
        const recentPatterns = this.findRecentPatterns(history.slice(-100));
        
        recentPatterns.forEach(pattern => {
            // Check if pattern breaks right when we would trade
            if (pattern.brokeAtExpected) {
                trapScore += 0.2;
                antiAlg.trapIndicators.push({
                    timestamp: Date.now(),
                    pattern: pattern.sequence,
                    confidence: pattern.confidence
                });
            }
        });
        
        // Detect algorithm fatigue (after many trades, patterns might emerge)
        const tradeDensity = this.calculateTradeDensity();
        antiAlg.algorithmFatigue = Math.min(tradeDensity / 100, 1.0);
        
        // Detect counter-patterns (algorithm responding to our trades)
        const counterPattern = this.detectCounterPattern();
        if (counterPattern) {
            antiAlg.counterPatternDetected = true;
            antiAlg.manipulationScore += 0.3;
        }
        
        // Calculate reverse logic score
        antiAlg.reverseLogicScore = this.calculateReverseLogic(history);
        
        // Update chaos level
        antiAlg.chaosLevel = this.calculateChaosLevel(history);
        
        return {
            trapLikelihood: trapScore,
            fatigue: antiAlg.algorithmFatigue,
            isBeingCountered: antiAlg.counterPatternDetected,
            manipulation: antiAlg.manipulationScore,
            shouldInvert: antiAlg.reverseLogicScore > 0.7,
            chaosTrading: antiAlg.chaosLevel > 0.7
        };
    }

    findRecentPatterns(history) {
        const patterns = [];
        const windowSizes = [3, 5, 7, 10];
        
        windowSizes.forEach(size => {
            for (let i = 0; i <= history.length - size * 2; i++) {
                const pattern = history.slice(i, i + size);
                const nextOccurrence = this.findNextOccurrence(history, pattern, i + size);
                
                if (nextOccurrence !== -1) {
                    const actualNext = history[nextOccurrence + size];
                    const expectedNext = history[i + size];
                    
                    patterns.push({
                        sequence: pattern,
                        brokeAtExpected: actualNext !== expectedNext,
                        confidence: this.calculatePatternConfidence(pattern, history)
                    });
                }
            }
        });
        
        return patterns;
    }

    findNextOccurrence(history, pattern, startIndex) {
        for (let i = startIndex; i <= history.length - pattern.length; i++) {
            let match = true;
            for (let j = 0; j < pattern.length; j++) {
                if (history[i + j] !== pattern[j]) {
                    match = false;
                    break;
                }
            }
            if (match) return i;
        }
        return -1;
    }

    calculatePatternConfidence(pattern, history) {
        let occurrences = 0;
        for (let i = 0; i <= history.length - pattern.length; i++) {
            let match = true;
            for (let j = 0; j < pattern.length; j++) {
                if (history[i + j] !== pattern[j]) {
                    match = false;
                    break;
                }
            }
            if (match) occurrences++;
        }
        return occurrences / (history.length - pattern.length + 1);
    }

    calculateTradeDensity() {
        return this.tickHistory.length;
    }

    detectCounterPattern() {
        const history = this.tickHistory;
        
        if (history.length < 30) return false;
        
        let brokenPatterns = 0;
        let totalPatterns = 0;
        
        for (let i = 2; i < history.length; i++) {
            if (history[i-2] === history[i-1]) {
                totalPatterns++;
                if (history[i] !== history[i-1]) {
                    brokenPatterns++;
                }
            }
        }
        
        return totalPatterns > 10 && (brokenPatterns / totalPatterns) > 0.85;
    }

    calculateReverseLogic(history) {
        if (history.length < 50) return 0;
        
        let reverseSuccess = 0;
        let totalChecks = 0;
        
        for (let i = 1; i < history.length; i++) {
            const current = history[i-1];
            const next = history[i];
            
            const conventionalSaysRepeat = this.conventionalRepeatLogic(history.slice(0, i));
            
            if (conventionalSaysRepeat) {
                totalChecks++;
                if (next !== current) {
                    reverseSuccess++;
                }
            }
        }
        
        return totalChecks > 0 ? reverseSuccess / totalChecks : 0.5;
    }

    conventionalRepeatLogic(history) {
        if (history.length < 10) return false;
        
        const recent = history.slice(-10);
        let repetitions = 0;
        
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] === recent[i-1]) repetitions++;
        }
        
        return repetitions > 3;
    }

    calculateChaosLevel(history) {
        if (history.length < 30) return 0;
        
        let divergence = 0;
        const windowSize = 10;
        
        for (let i = 0; i < history.length - windowSize * 2; i++) {
            const seq1 = history.slice(i, i + windowSize);
            const seq2 = history.slice(i + windowSize, i + windowSize * 2);
            
            let diff = 0;
            for (let j = 0; j < windowSize; j++) {
                diff += Math.abs(seq1[j] - seq2[j]);
            }
            
            divergence += diff / windowSize;
        }
        
        return Math.min(divergence / (history.length - windowSize * 2), 1.0);
    }

    // Chaos Theory Analysis
    applyChaosTheory() {
        const history = this.tickHistory;
        if (history.length < 100) return null;

        const lyapunovRaw = this.calculateLyapunovExponent(history);
        const sensitivityScore = this.calculateSensitivity(history);
        const butterfly = this.detectButterflyEffects(history);
        const strangeAttractor = this.findStrangeAttractor(history);
        const bifurcation = this.findBifurcationPoints(history);

        // Normalize Lyapunov to [0,1] for discrete digits and create component scores
        const lyapunovScore = Math.max(0, Math.min(1, lyapunovRaw / 0.5)); // 0.5 is a heuristic scale

        // Butterfly score: use count density normalized
        const butterflyCount = Array.isArray(butterfly) ? butterfly.length : 0;
        const butterflyScore = Math.max(0, Math.min(1, butterflyCount / 5)); // cap after ~5 detections

        // Bifurcation score: based on number of points normalized by history span
        const bifurcationCount = Array.isArray(bifurcation) ? bifurcation.length : 0;
        const bifurcationScore = Math.max(0, Math.min(1, bifurcationCount / Math.max(1, Math.floor(history.length / 50))));

        // Attractor dispersion score (if available)
        const attractorDispersion = strangeAttractor && typeof strangeAttractor.dispersion === 'number'
            ? Math.max(0, Math.min(1, strangeAttractor.dispersion / 4)) // digits span 0..9, typical dispersion < 4
            : 0;

        // Composite chaos score (weighted)
        const chaosScore = (
            0.30 * lyapunovScore +
            0.30 * sensitivityScore +
            0.15 * butterflyScore +
            0.15 * bifurcationScore +
            0.10 * attractorDispersion
        );

        const inChaos = chaosScore > 0.6 || ((lyapunovScore > 0.5 || sensitivityScore > 0.6) && (butterflyScore > 0.2 || bifurcationScore > 0.2));

        // Integrate strange attractor into prediction (safe)
        let prediction = history[history.length - 1];
        if (strangeAttractor && strangeAttractor.center) {
            const c = Array.isArray(strangeAttractor.center) ? strangeAttractor.center[0] : strangeAttractor.center;
            if (typeof c === 'number' && !Number.isNaN(c)) {
                prediction = Math.max(0, Math.min(9, Math.round(c) % 10));
            }
        }

        this.chaos = {
            lyapunov: { raw: lyapunovRaw, score: lyapunovScore },
            sensitivityScore,
            butterfly: { count: butterflyCount, score: butterflyScore },
            strangeAttractor,
            bifurcation: { count: bifurcationCount, score: bifurcationScore },
            attractorDispersion,
            chaosScore
        };

        return {
            inChaoticRegime: inChaos,
            shouldTrade: inChaos,
            confidence: chaosScore,
            prediction,
            attractor: strangeAttractor,
            components: {
                lyapunovScore,
                sensitivityScore,
                butterflyScore,
                bifurcationScore,
                attractorDispersion
            }
        };
    }

    calculateLyapunovExponent(history) {
        const n = history.length;
        if (n < 60) return 0;

        // Use 2D delay embedding to reduce ties in discrete space
        const tau = 2; // shorter delay works better for digits
        const m = 2;   // embedding dimension
        const embedded = [];
        for (let i = 0; i < n - (m - 1) * tau; i++) {
            embedded.push([history[i], history[i + tau]]);
        }
        const en = embedded.length;
        if (en < 30) return 0;

        let sum = 0;
        let count = 0;
        const evolve = 5; // shorter evolution horizon for digits
        const maxSamples = Math.min(400, en - evolve);

        for (let i = 0; i < maxSamples; i++) {
            const ref = embedded[i];
            let bestDist = Infinity;
            let bestIdx = -1;

            for (let j = 0; j < en - evolve; j++) {
                if (Math.abs(i - j) > evolve) {
                    const dx = ref[0] - embedded[j][0];
                    const dy = ref[1] - embedded[j][1];
                    const dist = Math.hypot(dx, dy);
                    if (dist > 0 && dist < bestDist) {
                        bestDist = dist;
                        bestIdx = j;
                    }
                }
            }

            if (bestIdx !== -1 && bestDist > 0) {
                const refNext = embedded[i + evolve];
                const nbrNext = embedded[bestIdx + evolve];
                const dx = refNext[0] - nbrNext[0];
                const dy = refNext[1] - nbrNext[1];
                const div = Math.hypot(dx, dy);
                if (div > 0) {
                    sum += Math.log(div / bestDist);
                    count++;
                }
            }
        }

        // Average local exponent
        return count > 0 ? sum / count : 0;
    }

    detectButterflyEffects(history) {
        const effects = [];
        const windowSize = 15;
        
        for (let i = 0; i < history.length - windowSize; i++) {
            const window = history.slice(i, i + windowSize);
            const nextWindow = history.slice(i + 1, i + windowSize + 1);
            
            // Small change
            let initialDiff = Math.abs(window[0] - nextWindow[0]);
            let finalDiff = Math.abs(window[windowSize-1] - nextWindow[windowSize-1]);
            
            if (initialDiff <= 1 && finalDiff >= 3) {
                effects.push({
                    position: i,
                    amplification: finalDiff / (initialDiff + 0.1)
                });
            }
        }
        
        return effects;
    }

    findStrangeAttractor(history) {
        const embedDim = 3;
        const delay = 2;
        if (history.length < embedDim * delay) return null;

        const phaseSpace = [];
        for (let i = 0; i < history.length - (embedDim - 1) * delay; i++) {
            const point = [];
            for (let j = 0; j < embedDim; j++) {
                point.push(history[i + j * delay]);
            }
            phaseSpace.push(point);
        }

        // Simplified: return the centroid of the phase space
        const center = Array(embedDim).fill(0);
        for (const point of phaseSpace) {
            for (let i = 0; i < embedDim; i++) {
                center[i] += point[i];
            }
        }

        for (let i = 0; i < embedDim; i++) {
            center[i] /= phaseSpace.length;
        }

        return {
            center: center, // Return the first dimension for prediction
            dimension: embedDim,
            points: phaseSpace.length,
        };
    }

    findBifurcationPoints(history) {
        const points = [];
        const windowSize = 15;
        const threshold = 1.25;

        if (history.length < windowSize * 2) return points;

        for (let i = windowSize; i < history.length - windowSize; i++) {
            const before = history.slice(i - windowSize, i);
            const after = history.slice(i, i + windowSize);

            const beforeStdDev = Math.sqrt(this.calculateVariance(before));
            const afterStdDev = Math.sqrt(this.calculateVariance(after));

            if (afterStdDev / (beforeStdDev + 1e-9) > threshold) {
                points.push({
                    position: i,
                    change: afterStdDev - beforeStdDev,
                });
            }
        }
        return points;
    }

    calculateVariance(data) {
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        return data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    }

    calculateSensitivity(history) {
        if (history.length < 50) return 0;

        let totalDivergence = 0;
        let comparisons = 0;
        const evolutionTime = 10;

        for (let i = 0; i < history.length - evolutionTime; i++) {
            for (let j = i + 1; j < history.length - evolutionTime; j++) {
                if (Math.abs(history[i] - history[j]) < 1) { // Initial condition
                    const divergence = Math.abs(history[i + evolutionTime] - history[j + evolutionTime]);
                    totalDivergence += divergence;
                    comparisons++;
                }
            }
        }

        return comparisons > 0 ? Math.min(totalDivergence / comparisons / 9, 1.0) : 0; // Normalize
    }

    placeTrade(predictedDigit, confidence) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;
        
        console.log(`\n💰 PLACING TRADE 💰`);
        console.log(`Digit: ${predictedDigit} | Confidence: ${confidence}%`);
        console.log(`Stake: $${this.currentStake.toFixed(2)}`);
        
        const request = {
            buy: 1,
            price: this.currentStake.toFixed(2), 
            parameters: {
                amount: this.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: predictedDigit
            }
        };
        this.sendRequest(request);
    }

    subscribeToOpenContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleContractUpdate(contract) {
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        
        console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(`Profit/Loss: $${profit.toFixed(2)}`);
       
        this.totalTrades++;
        
        if (won) {
            this.totalWins++;            
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.isWinTrade = false;
            this.totalLosses++;
            this.consecutiveLosses++;
            
            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            } else if (this.consecutiveLosses === 4) {
                this.consecutiveLosses4++;
            } else if (this.consecutiveLosses === 5) {
                this.consecutiveLosses5++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            
            // this.RestartTrading = true; 
        }

        this.totalProfitLoss += profit;

        if (!won) {
            this.sendLossEmail();
        }

        this.Pause = true;

        this.RestartTrading = true; 

        if (!this.endOfDay) {
            this.logTradingSummary();
        }
        
        // Take profit condition
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        // Check stopping conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stopping condition met. Disconnecting...');
            this.endOfDay = true; 
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        this.disconnect();
        
        if (!this.endOfDay) {
            this.waitTime = Math.floor(Math.random() * (2000 - 1000 + 1)) + 1000;
            console.log(`⏳ Waiting ${Math.round(this.waitTime/1000)} seconds before next trade...\n`);
            setTimeout(() => {
                this.Pause = false;
                this.kTrade = false;
                this.connect();
            }, this.waitTime);
        }
    }

    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            const request = {
                forget: this.tickSubscriptionId
            };
            this.sendRequest(request);
            console.log(`Unsubscribing from ticks with ID: ${this.tickSubscriptionId}`);
            
            this.ws.once('message', (data) => {
                const message = JSON.parse(data);
                if (message.msg_type === 'forget' && message.forget === this.tickSubscriptionId) {
                    console.log(`Unsubscribed from ticks successfully`);
                    this.tickSubscriptionId = null;
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            // Check for morning resume condition (8:00 AM)
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 8:00 AM, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }
    
            // Check for evening stop condition (after 8:00 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours === 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000);
    }

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary() {
        console.log('\n📈 TRADING SUMMARY 📈');
        console.log('═══════════════════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Won: ${this.totalWins} | Lost: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4} x5:${this.consecutiveLosses5}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Pattern Confidence: ${this.confidenceThreshold}%`);
        console.log('═══════════════════════════════════════\n');
    }
    
    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        ENHANCED TRADING BOT SUMMARY
        ============================
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Loss Analysis:
        -------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Differ Bot - Trading Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email sending error:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.lastDigitsList.slice(-20);

        const summaryText = `
        LOSS ALERT - DETAILED ANALYSIS
        ===============================
        
        Trade Result: LOSS
        
        Performance Metrics:
        -------------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.predictedDigit}
        Confidence: ${this.confidenceThreshold}%
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        Loss Digits List: ${this.LossDigitsList.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email sending error:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const currentHours = now.getHours();
        const currentMinutes = now.getMinutes();

        const summaryText = `
        BOT STATUS UPDATE
        =================
        Time: ${currentHours}:${currentMinutes.toString().padStart(2, '0')}
        Status: ${this.endOfDay ? 'Day Trading Complete' : 'Session Update'}
        
        Final Performance:
        -----------------
        Total Trades: ${this.totalTrades}
        Won: ${this.totalWins} | Lost: ${this.totalLosses}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
        
        Loss Distribution:
        -----------------
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        
        Financial Summary:
        -----------------
        Total P/L: $${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'x2 Deriv Bot - Status Update',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email sending error:', error);
        }
    }

    start() {
        console.log('🚀 STARTING ENHANCED DERIV TRADING BOT 🚀');
        console.log('=========================================');
        console.log('Pattern Recognition: ENABLED');
        console.log('Advanced Analysis: ACTIVE');
        console.log('Confidence Threshold: 85%'); // Upgraded
        console.log('=========================================\n');
        
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    initialStake: 1,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 100,
});

bot.start();