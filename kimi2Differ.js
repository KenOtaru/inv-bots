const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class RepetitionAnalyzer {
  constructor(config = {}) {
    this.windowSizes = config.windowSizes || [200, 500, 1000];
    this.zThreshold = config.extremeThreshold || 1.8;
    this.minHistoryLength = config.minHistoryLength || 1500;
    this.maxHistoryStored = 1000;
    
    // Statistical storage
    this.overallRepetitionHistory = [];
    this.digitRepetitionHistory = Array(10).fill().map(() => []);
  }

  calculateOverallRepetitionRate(history, windowSize) {
    if (history.length < windowSize + 1) return null;
    const recent = history.slice(-windowSize);
    let repetitions = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] === recent[i - 1]) repetitions++;
    }
    return repetitions / (recent.length - 1);
  }

  calculateDigitRepetitionRate(history, digit, windowSize) {
    if (history.length < windowSize + 1) return null;
    const recent = history.slice(-windowSize);
    let occurrences = 0, repetitions = 0;
    
    for (let i = 1; i < recent.length; i++) {
      if (recent[i - 1] === digit) {
        occurrences++;
        if (recent[i] === digit) repetitions++;
      }
    }
    return occurrences > 0 ? repetitions / occurrences : 0;
  }

  calculateZScore(currentRate, historicalRates) {
    if (historicalRates.length < 30) return 0;
    const mean = historicalRates.reduce((a, b) => a + b, 0) / historicalRates.length;
    const variance = historicalRates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / historicalRates.length;
    const stdDev = Math.sqrt(variance);
    return stdDev === 0 ? 0 : (currentRate - mean) / stdDev;
  }

  analyze(tickHistory, currentDigit) {
    if (tickHistory.length < this.minHistoryLength) {
      return { shouldTrade: false, reason: `Insufficient data: ${tickHistory.length}/${this.minHistoryLength}` };
    }

    const analysisResults = [];
    let totalConfidence = 0;

    for (const windowSize of this.windowSizes) {
      const rate = this.calculateOverallRepetitionRate(tickHistory, windowSize);
      if (rate === null) continue;

      this.overallRepetitionHistory.push(rate);
      if (this.overallRepetitionHistory.length > this.maxHistoryStored) {
        this.overallRepetitionHistory.shift();
      }

      const zScore = this.calculateZScore(rate, this.overallRepetitionHistory);
      const isExtreme = Math.abs(zScore) > this.zThreshold;
      const confidence = Math.min(Math.abs(zScore) / 3, 1);

      analysisResults.push({ window: windowSize, rate, zScore, isExtreme, confidence });
      totalConfidence += confidence;
    }

    const digitResult = this.analyzeDigit(tickHistory, currentDigit);
    const avgConfidence = analysisResults.length > 0 ? totalConfidence / analysisResults.length : 0;
    const finalConfidence = (avgConfidence + digitResult.confidence) / 2;
    
    const shouldTrade = finalConfidence > 0.6 && (analysisResults.some(r => r.isExtreme) || digitResult.isExtreme);

    return {
      shouldTrade,
      confidence: finalConfidence,
      targetDigit: currentDigit,
      reason: shouldTrade 
        ? `Extreme pattern detected (${analysisResults.filter(r => r.isExtreme).length}/${analysisResults.length} windows)`
        : 'Market conditions not favorable',
      details: { overall: analysisResults, digit: digitResult }
    };
  }

  analyzeDigit(history, digit) {
    const results = [];
    for (const windowSize of this.windowSizes) {
      const rate = this.calculateDigitRepetitionRate(history, digit, windowSize);
      if (rate === null) continue;

      this.digitRepetitionHistory[digit].push(rate);
      if (this.digitRepetitionHistory[digit].length > 500) {
        this.digitRepetitionHistory[digit].shift();
      }

      const zScore = this.calculateZScore(rate, this.digitRepetitionHistory[digit]);
      results.push({ windowSize, rate, zScore, isExtreme: Math.abs(zScore) > this.zThreshold });
    }

    const avgZScore = results.reduce((sum, r) => sum + Math.abs(r.zScore), 0) / results.length;
    return {
      digit,
      isExtreme: results.some(r => r.isExtreme),
      confidence: Math.min(avgZScore / 3, 1),
      details: results
    };
  }
}

class ProfessionalDigitAnalyzer {
  constructor() {
    this.regimes = {
      meanReversion: { windows: [200, 500, 1000], threshold: 2.2 },
      momentum: { windows: [50, 100, 150], threshold: 1.8 },
      volatility: { lookback: 100, threshold: 1.5 }
    };
    
    this.digitStats = Array(10).fill().map(() => ({
      repetitionRates: [],
      frequencyRates: [],
      transitionMatrix: Array(10).fill().map(() => Array(10).fill(0))
    }));
  }

  // Calculate digit transition probabilities
  updateTransitionMatrix(history) {
    if (history.length < 100) return;
    for (let i = 1; i < history.length; i++) {
      const from = history[i-1];
      const to = history[i];
      this.digitStats[from].transitionMatrix[to]++;
    }
  }

    // Calculate repetition rate for a specific digit
    calculateRepetitionRate(history) {
        let repetitions = 0;
        for (let i = 1; i < history.length; i++) {
            if (history[i] === history[i - 1]) repetitions++;
        }
        return repetitions / (history.length - 1);
    }

    // Calculate historical average repetition rate for given window
    getHistoricalAverage(window) {
        const rates = this.digitStats.flatMap(digitStat => digitStat.repetitionRates);
        if (rates.length === 0) return 0;
        return rates.reduce((a, b) => a + b, 0) / rates.length;
    }

    // Calculate standard deviation of repetition rates for given window
    getStdDev(window) {
        const rates = this.digitStats.flatMap(digitStat => digitStat.repetitionRates);
        if (rates.length === 0) return 1;
        const mean = this.getHistoricalAverage(window);
        const variance = rates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rates.length;
        return Math.sqrt(variance);
    }

  // Identify statistically unusual regimes
  detectRegime(history, currentDigit) {
    const regimes = [];
    
    // Mean-reversion detection
    for (const window of this.regimes.meanReversion.windows) {
      const recent = history.slice(-window);
      const repeatRate = this.calculateRepetitionRate(recent);
      const historicalAvg = this.getHistoricalAverage(window);
      const zScore = (repeatRate - historicalAvg) / this.getStdDev(window);
      
      if (Math.abs(zScore) > this.regimes.meanReversion.threshold) {
        regimes.push({
          type: zScore > 0 ? 'high-repetition' : 'low-repetition',
          zScore,
          confidence: Math.min(Math.abs(zScore) / 4, 1)
        });
      }
    }
    
    return regimes;
  }

    // Analyze specific digit behavior
    analyzeSpecificDigit(history, digit) {
        const results = [];
        for (const window of this.regimes.meanReversion.windows) {
            const recent = history.slice(-window);
            const repeatRate = this.calculateRepetitionRate(recent.filter(d => d === digit));
            const historicalAvg = this.getHistoricalAverage(window);
            const zScore = (repeatRate - historicalAvg) / this.getStdDev(window);
            results.push({ window, repeatRate, zScore });
        }
        const avgZScore = results.reduce((sum, r) => sum + Math.abs(r.zScore), 0) / results.length;
        return {
            digit,
            zScore: avgZScore,
            confidence: Math.min(avgZScore / 4, 1)
        };
    }

  // Core trade decision logic
  shouldExecuteTrade(history, currentDigit) {
    if (history.length < 1500) return { trade: false, reason: 'Insufficient history' };
    
    const regimes = this.detectRegime(history, currentDigit);
    const digitAnalysis = this.analyzeSpecificDigit(history, currentDigit);
    
    // Only trade when multiple signals align
    const highConfidenceSignals = regimes.filter(r => r.confidence > 0.7);
    const digitExtreme = digitAnalysis.zScore > 2.0 || digitAnalysis.zScore < -2.0;
    
    const shouldTrade = highConfidenceSignals.length >= 2 && digitExtreme;
    
    return {
      trade: shouldTrade,
      targetDigits: this.calculateOptimalTargets(history, currentDigit, regimes),
      confidence: this.aggregateConfidence(regimes, digitAnalysis),
      rationale: this.generateTradeRationale(regimes, digitAnalysis)
    };
  }

  // Get statistically "hot" digits to avoid
    getStatisticallyHotDigits(history) {
        const digitCounts = Array(10).fill(0);
        history.forEach(digit => {
            digitCounts[digit]++;
        });
        const averageCount = history.length / 10;
        const hotDigits = [];
        digitCounts.forEach((count, digit) => {
            if (count > averageCount * 1.3) { // 30% more than average
                hotDigits.push(digit);
            }
        });
        return hotDigits;
    }

    // Aggregate confidence from regimes and digit analysis
    aggregateConfidence(regimes, digitAnalysis) {
        const regimeConfidence = regimes.reduce((sum, r) => sum + r.confidence, 0) / (regimes.length || 1);
        return (regimeConfidence + digitAnalysis.confidence) / 2;
    }

    // Generate rationale for trade decision
    generateTradeRationale(regimes, digitAnalysis) {
        const reasons = regimes.map(r => `Regime: ${r.type} (z=${r.zScore.toFixed(2)})`).join('; ');
        return `Digit z-score: ${digitAnalysis.zScore.toFixed(2)}; ${reasons}`;
    }

    // Calculate digit score based on its frequency in the history
    // Accepts an optional `history` argument; falls back to `this.tickHistory` or empty array.
    getDigitScore(digit, history) {
        const hist = Array.isArray(history) ? history : (Array.isArray(this.tickHistory) ? this.tickHistory : []);
        const digitCounts = Array(10).fill(0);
        hist.forEach(d => {
            if (typeof d === 'number' && d >= 0 && d <= 9) digitCounts[d]++;
        });
        return digitCounts[digit] || 0;
    }

    // Calculate optimal targets based on digit scores
    // calculateOptimalTargets(history, currentDigit, regimes) {
    //     const digitScores = Array(10).fill(0);
    //     history.forEach(d => {
    //         digitScores[d]++;
    //     });
    //     // Exclude current digit and statistically "hot" digits
    //     const excludeDigits = new Set([currentDigit]);
    //     const hotDigits = this.getStatisticallyHotDigits(history);
    //     hotDigits.forEach(d => excludeDigits.add(d));
    //     const bestDigits = Array.from({length: 10}, (_, i) => i)
    //       .filter(d => !excludeDigits.has(d))
    //       .sort((a, b) => digitScores[b] - digitScores[a])
    //         .slice(0, 3);
    //     return bestDigits;
    // }

  // Calculate optimal digit targets (not just single digit)
  calculateOptimalTargets(history, currentDigit, regimes) {
    // Exclude current digit and statistically "hot" digits
    const excludeDigits = new Set([currentDigit]);
    const hotDigits = this.getStatisticallyHotDigits(history);
    hotDigits.forEach(d => excludeDigits.add(d));
    
    // Return 2-3 best targets for diversification
    return Array.from({length: 10}, (_, i) => i)
    .filter(d => !excludeDigits.has(d))
    .sort((a, b) => this.getDigitScore(a, history) - this.getDigitScore(b, history))
      .slice(0, 3);
  }
}

// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'RDBULL',
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
        // this.requiredHistoryLength = Math.floor(Math.random() * 4981) + 20; //Random history length (20 to 5000)
        this.requiredHistoryLength = 5000; // Fixed history length for consistency
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
        this.kTrade = false;
        this.xDigit = null;
        // Repetition analysis properties
        this.repetitionAnalyzer = new RepetitionAnalyzer({
            // windowSizes: [200, 500, 1000],
            windowSizes: [100, 300, 500],        // Shorter windows for faster signals
            extremeThreshold: 2,// Stricter (2.0 = 95% confidence)
            minHistoryLength: 2000
        });

        this.ProfessionalDigitAnalyzer = new ProfessionalDigitAnalyzer();

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
        if (!this.endOfDay) {
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
                if (!this.endOfDay && !this.Pause) {
                    this.handleDisconnect();
                }
            });
        }
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

        this.tradeInProgress = false;
        this.lastDigitsList = [];
        this.tickHistory = [];
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
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
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

        console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);
        // console.log('Digits:', this.tickHistory[this.tickHistory.length - 1], '|', this.tickHistory[this.tickHistory.length - 2], '|', this.tickHistory[this.tickHistory.length - 3])
        console.log('Digits:', this.tickHistory[this.tickHistory.length - 1])

        if (!this.tradeInProgress) {
            this.analyzeTicksEnhanced();
        }
    }


    analyzeTicksEnhanced() {
        if (this.tradeInProgress || !this.wsReady) return;

        if (this.tickHistory.length < this.requiredHistoryLength * 0.7) {
            console.log(`⏳ Building history... (${this.tickHistory.length}/${this.requiredHistoryLength})`);
            return;
        }

        const currentDigit = this.tickHistory[this.tickHistory.length - 1];
        const analysis = this.repetitionAnalyzer.analyze(this.tickHistory, currentDigit);

        // FILTER 1: Statistical anomaly detection
        const statisticalAnalysis = this.ProfessionalDigitAnalyzer.shouldExecuteTrade(
            this.tickHistory, 
            this.currentDigit
        );

        if (!statisticalAnalysis.trade || statisticalAnalysis.confidence < 0.75) {
            console.log(`❌ Analysis failed: ${statisticalAnalysis.rationale}`);
            return;
        }
        
        this.winProbNumber = (statisticalAnalysis.confidence*100).toFixed(1);

        console.log(`📊 ANALYSIS | Digits: ${statisticalAnalysis.targetDigits} | Confidence: ${this.winProbNumber}%`);
        console.log(`✅ EXECUTING=> Reason:${statisticalAnalysis.reason} | Rationale: ${statisticalAnalysis.rationale}`);
        
        this.xDigit = statisticalAnalysis.targetDigits[0]; // Pick first target digit

        
        this.placeTrade(this.xDigit, this.winProbNumber);

    }


    placeTrade(predictedDigit, confidence) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;

        console.log(`\n PLACING TRADE`);
        console.log(`Digit: ${predictedDigit} (${confidence}%)`);
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
        const exitSpot = contract.exit_tick_display_value;
        const actualDigit = this.getLastDigit(parseFloat(exitSpot), this.currentAsset);
        this.actualDigit = actualDigit;

        console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
        console.log(`   Predicted to differ from: ${this.xDigit} | Actual: ${actualDigit}`);
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
            this.waitTime = Math.floor(Math.random() * (1000 - 1000 + 1)) + 1000;
            console.log(`⏳ Waiting ${Math.round(this.waitTime / 1000)} seconds before next trade...\n`);
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
            // Always use GMT +1 time regardless of server location
            const now = new Date();
            const gmtPlus1Time = new Date(now.getTime() + (1 * 60 * 60 * 1000)); // Convert UTC → GMT+1
            const currentHours = gmtPlus1Time.getUTCHours();
            const currentMinutes = gmtPlus1Time.getUTCMinutes();
            const currentDay = gmtPlus1Time.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

            // Optional: log current GMT+1 time for monitoring
            // console.log(
            // "Current GMT+1 time:",
            // gmtPlus1Time.toISOString().replace("T", " ").substring(0, 19)
            // );

            // Check if it's Sunday - no trading on Sundays
            if (currentDay === 0) {
                if (!this.endOfDay) {
                    console.log("It's Sunday, disconnecting the bot. No trading on Sundays.");
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
                return; // Skip all other checks on Sunday
            }

            // Check for Morning resume condition (7:00 AM GMT+1) - but not on Sunday
            if (this.endOfDay && currentHours === 7 && currentMinutes >= 0) {
                console.log("It's 7:00 AM GMT+1, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tickHistory = [];
                this.regimCount = 0;
                this.kChaos = null;
                this.scanChaos = false;
                this.requiredHistoryLength = Math.floor(Math.random() * 4981) + 20; //Random
                this.tradeInProgress = false;
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }

            // Check for evening stop condition (after 5:00 PM GMT+1)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 17 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM GMT+1 after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 5000); // Check every 5 seconds
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
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('Predicted Digit:', this.xDigit);
        console.log('Percentage:', this.winProbNumber), '%';
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
            subject: 'Kimi2v75 Differ Bot - Trading Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const klastDigits = this.tickHistory.slice(-20);

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
        
        x2:${this.consecutiveLosses2} 
        x3:${this.consecutiveLosses3} 
        x4:${this.consecutiveLosses4}        
        
        Pattern Analysis:
        ----------------
        Asset: ${this.currentAsset}
        Predicted Digit: ${this.xDigit} | Actual Digit: ${this.actualDigit}
        Percentage: ${this.winProbNumber}%
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Kimi2v75 Differ Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Kimi2v75 Differ Bot - Error Report',
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
            subject: 'Kimi2v75 Differ Bot - Status Update',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Email sending error:', error);
        }
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('Dz2V2KvRf4Uukt3', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 0.61,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 2.5,
});

bot.start();
