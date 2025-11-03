const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// Enhanced Pattern Analyzer with Focus on Repetition Detection
class EnhancedPatternAnalyzer {
    constructor() {
        this.patterns = new Map();
        this.minHistoryRequired = 100; // Increased for better statistical significance
        this.repetitionPatterns = {
            global: { totalOccurrences: 0, totalRepetitions: 0 },
            byDigit: Array(10).fill(null).map(() => ({
                occurrences: 0,
                repetitions: 0,
                maxGap: 0,
                minGap: Infinity,
                avgGap: 0,
                lastSeen: -1,
                currentGap: 0,
                gapHistory: [],
                repetitionRate: 0
            })),
            recentWindow: {
                size: 200,
                repetitions: 0,
                total: 0
            }
        };
        this.statisticalMetrics = {
            chi2: 0,
            entropy: 0,
            autocorrelation: [],
            markovChain: this.initializeMarkovChain()
        };
    }

    initializeMarkovChain() {
        const chain = {};
        for (let i = 0; i <= 9; i++) {
            chain[i] = Array(10).fill(0);
        }
        return chain;
    }

    analyze(history) {
        if (!history || history.length < this.minHistoryRequired) {
            return { 
                shouldTrade: false, 
                confidence: 0,
                reason: `Insufficient history: ${history ? history.length : 0}/${this.minHistoryRequired}`
            };
        }

        // Deep analysis of entire history
        this.analyzeFullHistory(history);
        
        // Get current digit
        const currentDigit = history[history.length - 1];
        
        // Multi-layer analysis
        const repetitionAnalysis = this.analyzeRepetitionProbability(history, currentDigit);
        const markovPrediction = this.getMarkovPrediction(currentDigit);
        const cyclicAnalysis = this.detectCyclicPatterns(history);
        const statisticalAnalysis = this.performStatisticalTests(history, currentDigit);
        const microPatterns = this.analyzeMicroPatterns(history.slice(-50), currentDigit);
        
        // Calculate composite confidence
        const confidence = this.calculateCompositeConfidence({
            repetitionAnalysis,
            markovPrediction,
            cyclicAnalysis,
            statisticalAnalysis,
            microPatterns
        });
        
        // Decision making with strict criteria
        const shouldTrade = this.makeTradeDecision({
            confidence,
            repetitionAnalysis,
            currentDigit,
            statisticalAnalysis
        });
        
        return {
            shouldTrade,
            confidence,
            predictedDigit: currentDigit, // Digit we predict WON'T appear
            analysis: {
                repetitionProbability: repetitionAnalysis.probability,
                markovProbability: markovPrediction.nonRepeatProbability,
                cyclicStrength: cyclicAnalysis.strength,
                statisticalSignificance: statisticalAnalysis.significance,
                microPatternMatch: microPatterns.matchScore
            },
            recommendation: repetitionAnalysis.recommendation
        };
    }

    analyzeFullHistory(history) {
        // Reset counters
        this.repetitionPatterns.global = { totalOccurrences: 0, totalRepetitions: 0 };
        this.repetitionPatterns.byDigit.forEach(digit => {
            digit.occurrences = 0;
            digit.repetitions = 0;
            digit.gapHistory = [];
            digit.lastSeen = -1;
        });

        // Analyze entire history
        for (let i = 0; i < history.length; i++) {
            const digit = history[i];
            const digitData = this.repetitionPatterns.byDigit[digit];
            
            digitData.occurrences++;
            this.repetitionPatterns.global.totalOccurrences++;
            
            // Check for repetition
            if (i > 0 && history[i-1] === digit) {
                digitData.repetitions++;
                this.repetitionPatterns.global.totalRepetitions++;
            }
            
            // Track gaps between occurrences
            if (digitData.lastSeen !== -1) {
                const gap = i - digitData.lastSeen;
                digitData.gapHistory.push(gap);
                digitData.maxGap = Math.max(digitData.maxGap, gap);
                digitData.minGap = Math.min(digitData.minGap, gap);
            }
            digitData.lastSeen = i;
            
            // Update Markov chain
            if (i > 0) {
                const prevDigit = history[i-1];
                this.statisticalMetrics.markovChain[prevDigit][digit]++;
            }
        }
        
        // Calculate statistics for each digit
        this.repetitionPatterns.byDigit.forEach((digit, idx) => {
            if (digit.gapHistory.length > 0) {
                digit.avgGap = digit.gapHistory.reduce((a, b) => a + b, 0) / digit.gapHistory.length;
            }
            digit.currentGap = history.length - 1 - digit.lastSeen;
            digit.repetitionRate = digit.occurrences > 0 ? digit.repetitions / digit.occurrences : 0;
        });
        
        // Normalize Markov chain
        for (let i = 0; i <= 9; i++) {
            const rowSum = this.statisticalMetrics.markovChain[i].reduce((a, b) => a + b, 0);
            if (rowSum > 0) {
                for (let j = 0; j <= 9; j++) {
                    this.statisticalMetrics.markovChain[i][j] /= rowSum;
                }
            }
        }
    }

    analyzeRepetitionProbability(history, currentDigit) {
    const digitData = this.repetitionPatterns.byDigit[currentDigit];
    const globalRate = this.repetitionPatterns.global.totalRepetitions / 
                      Math.max(1, this.repetitionPatterns.global.totalOccurrences - 1);

    // Recent window analysis (last 20 ticks)
    const recentHistory = history.slice(-20);
    let recentRepetitions = 0;
    let digitOccurrencesInWindow = 0;

    for (let i = 1; i < recentHistory.length; i++) {
        if (recentHistory[i] === currentDigit) {
            digitOccurrencesInWindow++;
            if (recentHistory[i-1] === currentDigit) {
                recentRepetitions++;
            }
        }
    }

    const recentRepetitionRate = digitOccurrencesInWindow > 0 ? 
        recentRepetitions / digitOccurrencesInWindow : 0;

    // --- Integration of lastAppearances ---
    const lastAppearances = this.getLastAppearances(history, currentDigit, 10);
    let lastAppearanceGap = null;
    let avgAppearanceGap = null;
    let minAppearanceGap = null;
    let maxAppearanceGap = null;

    // Check consecutive appearance patterns
    const consecutiveCount = this.countConsecutive(history);

    // Statistical deviation from expected
    const expectedRate = 0.1; // Expected 10% repetition rate for random
    const deviation = Math.abs(digitData.repetitionRate - expectedRate);
    const isSignificantlyLow = digitData.repetitionRate < expectedRate && deviation > 0.03;

    // Gap analysis
    const isOverdue = digitData.currentGap > digitData.avgGap * 1.5;
    const hasRegularPattern = this.checkRegularGapPattern(digitData.gapHistory);

    // Calculate probability of NON-repetition
    let probability = 1 - digitData.repetitionRate;

    // Adjust based on recent behavior
    if (recentRepetitionRate < digitData.repetitionRate) {
        probability += 0.1; // Recent trend shows fewer repetitions
    }

    if (lastAppearances.length > 1) {
        // Calculate gaps between last appearances
        const gaps = [];
        for (let i = 1; i < lastAppearances.length; i++) {
            gaps.push(lastAppearances[i-1] - lastAppearances[i]);
        }
        lastAppearanceGap = gaps[0]; // Most recent gap
        avgAppearanceGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        minAppearanceGap = Math.min(...gaps);
        maxAppearanceGap = Math.max(...gaps);

        // If the most recent gap is much larger than average, digit may be overdue
        if (lastAppearanceGap > avgAppearanceGap * 1.5) {
            // Increase probability of non-repetition (digit is overdue)
            probability += 0.1;
        }
        // If gaps are very small, digit is clustering, reduce probability
        if (avgAppearanceGap < 3) {
            probability -= 0.2;
        }
    }


    // Adjust based on consecutive appearances
    if (consecutiveCount > 1) {
        probability += consecutiveCount * 0.1; // Less likely to continue streak
    }

    // Cap probability
    probability = Math.min(probability, 0.95);

    return {
        probability,
        historicalRate: digitData.repetitionRate,
        recentRate: recentRepetitionRate,
        globalRate,
        isSignificantlyLow,
        isOverdue,
        hasRegularPattern,
        consecutiveCount,
        lastAppearances, // <-- Now included in the result
        lastAppearanceGap,
        avgAppearanceGap,
        minAppearanceGap,
        maxAppearanceGap,
        recommendation: probability > 0.85 ? 'STRONG_NO_REPEAT' : 
                      probability > 0.75 ? 'LIKELY_NO_REPEAT' : 'UNCERTAIN'
    };
}

    getMarkovPrediction(currentDigit) {
        const transitions = this.statisticalMetrics.markovChain[currentDigit];
        const selfTransition = transitions[currentDigit];
        
        return {
            repeatProbability: selfTransition,
            nonRepeatProbability: 1 - selfTransition,
            mostLikelyNext: transitions.indexOf(Math.max(...transitions))
        };
    }

    detectCyclicPatterns(history) {
        const cycles = [2, 3, 5, 7, 10, 13, 17, 20]; // Check various cycle lengths
        let maxStrength = 0;
        let dominantCycle = 0;
        
        for (const cycleLength of cycles) {
            if (history.length < cycleLength * 3) continue;
            
            let matches = 0;
            let total = 0;
            
            for (let i = cycleLength; i < history.length; i++) {
                total++;
                if (history[i] === history[i - cycleLength]) {
                    matches++;
                }
            }
            
            const strength = matches / total;
            if (strength > maxStrength) {
                maxStrength = strength;
                dominantCycle = cycleLength;
            }
        }
        
        return {
            hasCycle: maxStrength > 0.15,
            cycleLength: dominantCycle,
            strength: maxStrength
        };
    }

    performStatisticalTests(history, currentDigit) {
        // Chi-square test for independence
        const observed = Array(10).fill(0);
        const expected = history.length / 10;
        
        history.forEach(digit => observed[digit]++);
        
        let chi2 = 0;
        observed.forEach(count => {
            chi2 += Math.pow(count - expected, 2) / expected;
        });
        
        // Runs test for randomness
        const runs = this.calculateRuns(history);
        const expectedRuns = (2 * history.length * 9) / 100 + 1;
        const runsDeviation = Math.abs(runs - expectedRuns) / expectedRuns;
        
        // Autocorrelation at lag 1
        const autocorr = this.calculateAutocorrelation(history, 1);
        
        // Current digit frequency analysis
        const digitFreq = observed[currentDigit] / history.length;
        const isOverrepresented = digitFreq > 0.12; // More than 12% (expected 10%)
        
        return {
            chi2,
            significance: chi2 > 16.92 ? 'HIGH' : chi2 > 10 ? 'MEDIUM' : 'LOW',
            runsTest: runsDeviation < 0.1 ? 'RANDOM' : 'PATTERN',
            autocorrelation: autocorr,
            digitOverrepresented: isOverrepresented,
            digitFrequency: digitFreq
        };
    }

    analyzeMicroPatterns(recentHistory, currentDigit) {
        if (recentHistory.length < 20) {
            return { matchScore: 0, patterns: [] };
        }
        
        const patterns = [];
        
        // Look for specific micro-patterns
        // Pattern 1: After seeing digit twice, it rarely appears third time
        let doubleFollowedByDifferent = 0;
        let doubleTotal = 0;
        
        for (let i = 2; i < recentHistory.length; i++) {
            if (recentHistory[i-2] === recentHistory[i-1]) {
                doubleTotal++;
                if (recentHistory[i] !== recentHistory[i-1]) {
                    doubleFollowedByDifferent++;
                }
            }
        }
        
        if (doubleTotal > 0) {
            const pattern1Score = doubleFollowedByDifferent / doubleTotal;
            if (pattern1Score > 0.8) {
                patterns.push({ type: 'DOUBLE_BREAK', score: pattern1Score });
            }
        }
        
        // Pattern 2: Digit alternation detection
        let alternations = 0;
        for (let i = 2; i < recentHistory.length; i++) {
            if (recentHistory[i] === recentHistory[i-2] && 
                recentHistory[i] !== recentHistory[i-1]) {
                alternations++;
            }
        }
        
        const alternationRate = alternations / (recentHistory.length - 2);
        if (alternationRate > 0.15) {
            patterns.push({ type: 'ALTERNATION', score: alternationRate });
        }
        
        // Calculate match score
        const matchScore = patterns.reduce((sum, p) => sum + p.score, 0) / 
                          Math.max(1, patterns.length);
        
        return { matchScore, patterns };
    }

    calculateCompositeConfidence(analyses) {
        const weights = {
            repetition: 0.15,
            markov: 0.25,
            cyclic: 0.25,
            statistical: 0.25,
            micro: 0.10
        };
        
        let confidence = 0;
        
        // Repetition analysis contribution
        confidence += analyses.repetitionAnalysis.probability * weights.repetition;
        
        // Markov prediction contribution
        confidence += analyses.markovPrediction.nonRepeatProbability * weights.markov;
        
        // Cyclic pattern contribution (inverse - we want to avoid strong cycles)
        confidence += (1 - analyses.cyclicAnalysis.strength) * weights.cyclic;
        
        // Statistical significance contribution
        const statScore = analyses.statisticalAnalysis.significance === 'LOW' ? 0.3 :
                         analyses.statisticalAnalysis.significance === 'MEDIUM' ? 0.6 : 0.9;
        confidence += statScore * weights.statistical;
        
        // Micro patterns contribution
        confidence += analyses.microPatterns.matchScore * weights.micro;
        
        // Apply penalties
        if (analyses.repetitionAnalysis.consecutiveCount > 2) {
            confidence -= 0.9; // Reduce confidence for long streaks
        }
        
        if (analyses.statisticalAnalysis.digitOverrepresented) {
            confidence -= 1.05; // Slight boost if digit is overrepresented
        }
        
        return Math.min(confidence, 0.99); // Never claim 100% certainty
    }

    makeTradeDecision(params) {
        const { confidence, repetitionAnalysis, statisticalAnalysis } = params;
        
        // Strict criteria for trading
        if (confidence < 0.80) return false; // Minimum 80% confidence
        
        if (repetitionAnalysis.historicalRate > 0.15) return false; // Avoid high repetition digits
        
        if (repetitionAnalysis.consecutiveCount > 4) return false; // Avoid long streaks
        
        if (repetitionAnalysis.recommendation !== 'STRONG_NO_REPEAT' && 
            repetitionAnalysis.recommendation !== 'LIKELY_NO_REPEAT') {
            return false;
        }
        
        if (statisticalAnalysis.runsTest === 'RANDOM' && confidence < 0.85) {
            return false; // Need higher confidence for random markets
        }
        
        return true;
    }

    // Helper methods
    getLastAppearances(history, digit, count) {
        const appearances = [];
        for (let i = history.length - 1; i >= 0 && appearances.length < count; i--) {
            if (history[i] === digit) {
                appearances.push(i);
            }
        }
        return appearances;
    }

    countConsecutive(history) {
        if (history.length < 2) return 0;
        
        let count = 1;
        const lastDigit = history[history.length - 1];
        
        for (let i = history.length - 2; i >= 0; i--) {
            if (history[i] === lastDigit) {
                count++;
            } else {
                break;
            }
        }
        
        return count;
    }

    checkRegularGapPattern(gaps) {
        if (gaps.length < 5) return false;
        
        const recentGaps = gaps.slice(-5);
        const avg = recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length;
        const variance = recentGaps.reduce((sum, gap) => sum + Math.pow(gap - avg, 2), 0) / recentGaps.length;
        const stdDev = Math.sqrt(variance);
        
        return stdDev / avg < 0.3; // Low coefficient of variation indicates regular pattern
    }

    calculateRuns(history) {
        let runs = 1;
        for (let i = 1; i < history.length; i++) {
            if (history[i] !== history[i-1]) {
                runs++;
            }
        }
        return runs;
    }

    calculateAutocorrelation(history, lag) {
        if (history.length <= lag) return 0;
        
        const mean = history.reduce((a, b) => a + b, 0) / history.length;
        let numerator = 0;
        let denominator = 0;
        
        for (let i = lag; i < history.length; i++) {
            numerator += (history[i] - mean) * (history[i - lag] - mean);
        }
        
        for (let i = 0; i < history.length; i++) {
            denominator += Math.pow(history[i] - mean, 2);
        }
        
        return denominator > 0 ? numerator / denominator : 0;
    }
}

// Main Trading Bot Class
class UltimateDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = config.assets || ['R_50', 'R_75', 'R_100'];
        
        this.config = {
            initialStake: config.initialStake || 1,
            multiplier: config.multiplier || 2.1,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 100,
            minConfidence: config.minConfidence || 0.80
        };
        
        // Trading state
        this.currentStake = this.config.initialStake;
        this.currentAsset = null;
        this.tradeInProgress = false;
        this.tickHistory = [];
        this.requiredHistoryLength = 1000;
        
        // Performance tracking
        this.stats = {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            consecutiveLosses: 0,
            maxConsecutiveLosses: 0,
            totalProfit: 0,
            startTime: Date.now(),
            lastTradeTime: null,
            winRate: 0
        };
        
        // Pattern analyzer
        this.analyzer = new EnhancedPatternAnalyzer();
        
        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: config.emailUser || 'your-email@gmail.com',
                pass: config.emailPass || 'your-app-password'
            }
        };
        this.emailRecipient = config.emailRecipient || 'alerts@example.com';
        
        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectInterval = 5000;
        
        this.startReportTimer();
    }
    
    connect() {
        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
        
        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.connected = true;
            this.reconnectAttempts = 0;
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
        if (this.connected && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(request));
        } else {
            console.error('Cannot send request - not connected');
        }
    }
    
    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }
    
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                if (message.error) {
                    console.error('❌ Authentication failed:', message.error.message);
                    this.disconnect();
                } else {
                    console.log('✅ Authentication successful');
                    this.startTrading();
                }
                break;
                
            case 'history':
                this.handleTickHistory(message.history);
                break;
                
            case 'tick':
                this.handleTickUpdate(message.tick);
                break;
                
            case 'buy':
                if (message.error) {
                    console.error('❌ Trade placement failed:', message.error.message);
                    this.tradeInProgress = false;
                } else {
                    console.log('✅ Trade placed successfully');
                    this.currentTradeId = message.buy.contract_id;
                    this.subscribeToContract(message.buy.contract_id);
                }
                break;
                
            case 'proposal_open_contract':
                if (message.proposal_open_contract.is_sold) {
                    this.handleTradeResult(message.proposal_open_contract);
                }
                break;
                
            default:
                if (message.error) {
                    this.handleApiError(message.error);
                }
        }
    }
    
    startTrading() {
        // Select random asset
        this.currentAsset = this.assets[Math.floor(Math.random() * this.assets.length)];
        console.log(`📊 Selected asset: ${this.currentAsset}`);
        
        // Request tick history
        this.sendRequest({
            ticks_history: this.currentAsset,
            adjust_start_time: 1,
            count: this.requiredHistoryLength,
            end: 'latest',
            style: 'ticks'
        });
        
        // Subscribe to live ticks
        this.sendRequest({
            ticks: this.currentAsset,
            subscribe: 1
        });
    }
    
    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.extractLastDigit(price));
        // console.log(`📈 Loaded ${this.tickHistory.length} historical ticks`);
    }
    
    handleTickUpdate(tick) {
        const lastDigit = this.extractLastDigit(tick.quote);
        this.tickHistory.push(lastDigit);
        
        // Keep history size manageable
        if (this.tickHistory.length > this.requiredHistoryLength * 2) {
            this.tickHistory.shift();
        }
        
        console.log(`📊 10 Digits: ${this.tickHistory.slice(-10).join(',')}`);

        if (!this.tradeInProgress) {
            // Analyze the full history
            this.analyzer.analyzeFullHistory(this.tickHistory);
            this.evaluateTradingOpportunity();
        }
    }
    
    extractLastDigit(price) {
        const priceStr = price.toString();
        const parts = priceStr.split('.');
        
        if (!parts[1]) return 0;
        
        // Different decimal places for different assets
        const decimalPlaces = {
            'R_10': 3,
            'R_25': 3,
            'R_50': 4,
            'R_75': 4,
            'R_100': 2,
            'RDBULL': 4,
            'RDBEAR': 4
        };
        
        const places = decimalPlaces[this.currentAsset] || 2;
        const decimals = parts[1].padEnd(places, '0');
        
        return parseInt(decimals[places - 1]);
    }
    
    evaluateTradingOpportunity() {
        if (this.tradeInProgress || this.tickHistory.length < this.requiredHistoryLength) {
            return;
        }
        
        const analysis = this.analyzer.analyze(this.tickHistory);
        
        console.log('\n📊 PATTERN ANALYSIS RESULT:');
        console.log(`Confidence: ${(analysis.confidence * 100).toFixed(2)}%`);
        console.log(`Should Trade: ${analysis.shouldTrade}`);
        
        if (analysis.shouldTrade && analysis.confidence >= 0.91) {
            this.placeTrade(analysis.predictedDigit, analysis.confidence);
        }
    }
    
    placeTrade(digit, confidence) {
        if (this.tradeInProgress) return;
        
        this.tradeInProgress = true;
        
        console.log('\n🎯 PLACING TRADE');
        console.log(`Digit (won't appear): ${digit}`);
        console.log(`Confidence: ${(confidence * 100).toFixed(2)}%`);
        console.log(`Stake: $${this.currentStake.toFixed(2)}`);
        
        this.sendRequest({
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });
    }
    
    subscribeToContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }
    
    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        
        // Update statistics
        this.stats.totalTrades++;
        if (won) {
            this.stats.wins++;
            this.stats.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            console.log(`\n✅ TRADE WON! Profit: $${profit.toFixed(2)}`);
        } else {
            this.stats.losses++;
            this.stats.consecutiveLosses++;
            this.stats.maxConsecutiveLosses = Math.max(
                this.stats.maxConsecutiveLosses, 
                this.stats.consecutiveLosses
            );
            this.currentStake = Math.min(
                this.currentStake * this.config.multiplier,
                100 // Max stake cap
            );
            console.log(`\n❌ TRADE LOST! Loss: $${Math.abs(profit).toFixed(2)}`);
        }
        
        this.stats.totalProfit += profit;
        this.stats.winRate = this.stats.wins / this.stats.totalTrades;
        this.stats.lastTradeTime = Date.now();
        
        this.logSummary();
        
        // Check stop conditions
        if (this.shouldStop()) {
            console.log('🛑 Stop condition met. Shutting down...');
            this.sendEmailReport('STOP_CONDITION');
            this.disconnect();
            return;
        }
        
        // Reset for next trade
        this.tradeInProgress = false;
        
        // Wait before next trade
        const waitTime = 5000 + Math.random() * 10000; // 5-15 seconds
        console.log(`⏳ Waiting ${(waitTime/1000).toFixed(1)}s before next evaluation...\n`);
        
        setTimeout(() => {
            if (this.connected) {
                this.evaluateTradingOpportunity();
            }
        }, waitTime);
    }
    
    shouldStop() {
        return (
            this.stats.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.stats.totalProfit <= -this.config.stopLoss ||
            this.stats.totalProfit >= this.config.takeProfit
        );
    }
    
    logSummary() {
        console.log('\n📊 TRADING SUMMARY');
        console.log('═══════════════════════════');
        console.log(`Total Trades: ${this.stats.totalTrades}`);
        console.log(`Wins: ${this.stats.wins} | Losses: ${this.stats.losses}`);
        console.log(`Win Rate: ${(this.stats.winRate * 100).toFixed(2)}%`);
        console.log(`Consecutive Losses: ${this.stats.consecutiveLosses}`);
        console.log(`Total P/L: $${this.stats.totalProfit.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('═══════════════════════════\n');
    }
    
    handleDisconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        } else {
            console.log('❌ Max reconnection attempts reached');
            this.sendEmailReport('DISCONNECTED');
        }
    }
    
    handleApiError(error) {
        console.error('API Error:', error.message);
        if (error.code === 'InvalidToken') {
            this.disconnect();
        }
    }
    
    disconnect() {
        if (this.ws) {
            this.ws.close();
        }
    }
    
    startReportTimer() {
        setInterval(() => {
            if (this.stats.totalTrades > 0) {
                this.sendEmailReport('PERIODIC');
            }
        }, 30 * 60 * 1000); // Every 30 minutes
    }
    
    async sendEmailReport(type) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const runtime = ((Date.now() - this.stats.startTime) / 1000 / 60).toFixed(1);
        
        const subject = `Deriv Bot - ${type} Report`;
        const text = `
ENHANCED DIGIT DIFFER BOT REPORT
================================
Type: ${type}
Runtime: ${runtime} minutes

Performance:
-----------
Total Trades: ${this.stats.totalTrades}
Wins: ${this.stats.wins} | Losses: ${this.stats.losses}
Win Rate: ${(this.stats.winRate * 100).toFixed(2)}%
Max Consecutive Losses: ${this.stats.maxConsecutiveLosses}

Financial:
----------
Total P/L: $${this.stats.totalProfit.toFixed(2)}
Current Stake: $${this.currentStake.toFixed(2)}

Configuration:
-------------
Assets: ${this.assets.join(', ')}
Min Confidence: ${(this.config.minConfidence * 100).toFixed(0)}%
Stop Loss: $${this.config.stopLoss}
Take Profit: $${this.config.takeProfit}
        `;
        
        try {
            await transporter.sendMail({
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject,
                text
            });
            console.log('📧 Email report sent');
        } catch (error) {
            console.error('Failed to send email:', error.message);
        }
    }
    
    start() {
        console.log('\n🚀 ULTIMATE DERIV DIGIT DIFFER BOT');
        console.log('=====================================');
        console.log('Enhanced Pattern Recognition: ACTIVE');
        console.log('Statistical Analysis: ENABLED');
        console.log('Minimum Confidence: ' + (this.config.minConfidence * 100).toFixed(0) + '%');
        console.log('=====================================\n');
        
        this.connect();
    }
}

// Initialize and start the bot
const bot = new UltimateDerivTradingBot('0P94g4WdSrSrzir', {
    initialStake: 1,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    stopLoss: 50,
    takeProfit: 100,
    minConfidence: 0.80,
    assets: ['R_75'],
    emailUser: 'kenzkdp2@gmail.com',
    emailPass: 'jfjhtmussgfpbgpk',
    emailRecipient: 'kenotaru@gmail.com'
});

// Start the bot
bot.start();