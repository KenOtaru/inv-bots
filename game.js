const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');


// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
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
        this.requiredHistoryLength = 5000; // Increased for better pattern analysis
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
        this.scanChaos = false;
        this.winProbNumber = 0;
        this.lastPredictedBatchEnd = null;
        this.lastPredictedDigit = null;
        this.globalHighestCount = 0;
        this.globalBestDigits = [];

        // Initialize predictionOutcomes
        this.predictionOutcomes = Array(10).fill(0).map(() => ({ wins: 0, total: 0 }));

        // Load persisted predictionOutcomes
        this.loadPredictionOutcomes();

        
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

    async loadPredictionOutcomes() {
        const filePath = path.join(__dirname, 'gameThoery.json');
        try {
            const data = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed) && parsed.length === 10 && 
                parsed.every(item => typeof item === 'object' && 'wins' in item && 'total' in item)) {
                this.predictionOutcomes = parsed;
                console.log('Successfully loaded predictionOutcomes from file:', this.predictionOutcomes);
            } else {
                console.warn('Invalid predictionOutcomes data in file, using default initialization.');
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('No existing predictionOutcomes file found, using default initialization.');
            } else {
                console.error('Error loading predictionOutcomes:', error.message);
            }
        }
    }

    async savePredictionOutcomes() {
        const filePath = path.join(__dirname, 'gameThoery.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.predictionOutcomes, null, 2));
            console.log('Successfully saved predictionOutcomes to file.');
        } catch (error) {
            console.error('Error saving predictionOutcomes:', error.message);
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
                       
        console.log(`Recent tick History: ${this.tickHistory.slice(-5).join(', ')}`);           

        // Enhanced logging
        if(!this.tradeInProgress) { 
            this.analyzeTicksEnhanced();           
        }
    }

        
    analyzeTicksEnhanced() {
        if (this.tradeInProgress) {
            console.log('Trade in progress, skipping analysis.');
            return;
        }

        const history = this.tickHistory || [];
        const historyLen = history.length;
        const recentWindow = 10; // Recent ticks for short-term analysis
        const minHistory = recentWindow; // Minimum for meaningful analysis

        if (historyLen < minHistory) {
            console.log('Insufficient tick history for analysis:', historyLen);
            return;
        }

        // Initialize predictionOutcomes if not exists
        if (!this.predictionOutcomes) {
            this.predictionOutcomes = Array(10).fill(0).map(() => ({ wins: 0, total: 0 }));
        }

        // Calculate historical equilibrium frequencies (Nash equilibrium)
        const historicalCounts = Array(10).fill(0);
        for (const d of history) {
            if (typeof d === 'number' && d >= 0 && d <= 9) historicalCounts[d]++;
        }
        const historicalProbs = historicalCounts.map(count => count / historyLen);
        console.log('Historical Equilibrium Probabilities (%):', historicalProbs.map(p => (p * 100).toFixed(2)));

        // Analyze recent ticks (last recentWindow ticks)
        const recentTicks = history.slice(-recentWindow);
        const recentCounts = Array(10).fill(0);
        for (const d of recentTicks) {
            if (typeof d === 'number' && d >= 0 && d <= 9) recentCounts[d]++;
        }
        const recentProbs = recentCounts.map(count => count / recentWindow);

        // Calculate deviations from equilibrium
        const deviations = Array(10).fill(0);
        for (let d = 0; d < 10; d++) {
            deviations[d] = recentProbs[d] - historicalProbs[d];
        }
        console.log('Recent Probabilities (%):', recentProbs.map(p => (p * 100).toFixed(2)));
        console.log('Deviations from Equilibrium:', deviations.map(dev => (dev * 100).toFixed(2)));

        // Calculate entropy of recent ticks to assess pattern stability
        let entropy = 0;
        for (let d = 0; d < 10; d++) {
            const p = recentProbs[d];
            if (p > 0) entropy -= p * Math.log2(p);
        }
        console.log('Recent Ticks Entropy:', entropy.toFixed(2));

        // Select digit with largest positive deviation (most overplayed, likely to revert)
        let predictedDigit = null;
        let maxDeviation = 0;
        for (let d = 0; d < 10; d++) {
            if (deviations[d] > maxDeviation) {
                maxDeviation = deviations[d];
                predictedDigit = d;
            }
        }

        if (predictedDigit === null || maxDeviation <= 0.03) { // Minimum deviation threshold (3%)
            console.log('No significant positive deviation. Max Deviation:', (maxDeviation * 100).toFixed(2));
            return;
        }

        // Avoid repeating trades
        if (this.lastPredictedBatchEnd === historyLen && this.lastPredictedDigit === predictedDigit) {
            console.log('Skipping trade: Same prediction as previous.');
            return;
        }

        // Ensure predicted digit differs from last tick
        const lastTick = history[historyLen - 1];
        if (predictedDigit === lastTick) {
            console.log('Skipping trade: Predicted digit matches last tick:', lastTick);
            return;
        }

        // Calculate confidence based on deviation, adjusted by historical outcomes
        let confidence = Math.min(maxDeviation * 1000, 100); // Scale deviation to % (adjust factor as needed)
        const outcomes = this.predictionOutcomes[predictedDigit];
        if (outcomes.total > 0) {
            confidence = (confidence * 0.6) + (outcomes.wins / outcomes.total * 100 * 0.4);
        }

        
        if (maxDeviation > 0.2 && entropy < 2.5 && confidence >= 100) { // Trade on significant deviation and non-random patterns
            this.lastPredictedBatchEnd = historyLen;
            this.lastPredictedDigit = predictedDigit;
            this.xDigit = predictedDigit;
            this.winProbNumber = Math.round(confidence);

            console.log('-------------------------------------------------');
            console.log('Predicted Digit Differ:', predictedDigit, 'Deviation:', (maxDeviation * 100).toFixed(2), '%');
            console.log('Confidence:', this.winProbNumber, '%');
            console.log('Recent Ticks Entropy:', entropy.toFixed(2));
            console.log('-------------------------------------------------');

            console.log(`Placing Digit Differ trade on digit ${predictedDigit} (expected reversion to equilibrium).`);
            this.placeTrade(this.xDigit, this.winProbNumber);
        } else {
            console.log('Skipping trade: Insufficient deviation or high entropy.');
            console.log('Max Deviation:', (maxDeviation * 100).toFixed(2), 'Entropy:', entropy.toFixed(2));
        }
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
    
    console.log(`\n📊 TRADE RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
    console.log(`Profit/Loss: $${profit.toFixed(2)}`);
   
    this.totalTrades++;
    
    // Update predictionOutcomes for the predicted digit
    if (this.xDigit !== null && this.predictionOutcomes && this.predictionOutcomes[this.xDigit]) {
        this.predictionOutcomes[this.xDigit].total++;
        if (won) {
            this.predictionOutcomes[this.xDigit].wins++;
        }
        console.log(`Prediction Outcomes for Digit ${this.xDigit}: ` +
                    `Wins=${this.predictionOutcomes[this.xDigit].wins}, ` +
                    `Total=${this.predictionOutcomes[this.xDigit].total}, ` +
                    `Win Rate=${((this.predictionOutcomes[this.xDigit].wins / 
                    this.predictionOutcomes[this.xDigit].total) * 100).toFixed(2)}%`);
        
        // Save predictionOutcomes after update
        this.savePredictionOutcomes();
    }
    
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

    this.kTrade = false;
    
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
        this.waitTime = Math.floor(Math.random() * (1000 - 1000 + 1)) + 2000;
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
        console.log(`Consecutive Losses: x2:${this.consecutiveLosses2} x3:${this.consecutiveLosses3} x4:${this.consecutiveLosses4}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log('Predicted Digit:', this.xDigit);
        console.log('Percentage:', this.winProbNumber),'%';
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
            subject: 'GameTheory Differ Bot - Trading Summary',
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
        Predicted Digit: ${this.xDigit}
        Percentage: ${this.winProbNumber}%
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'GameTheory Differ Bot - Loss Alert',
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
            subject: 'GameTheory Differ Bot - Error Report',
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
            subject: 'GameTheory Differ Bot - Status Update',
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
const bot = new EnhancedDerivTradingBot('DMylfkyce6VyZt7', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 0.61,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 10,
});

bot.start();
