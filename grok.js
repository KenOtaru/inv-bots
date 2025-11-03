const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class VolAccuEdgeBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100'
        ];

        this.config = {
            initialStake: config.initialStake || 1, // Base stake in USD
            riskPercentage: config.riskPercentage || 0.01, // 1% risk per trade
            volatilityThreshold: config.volatilityThreshold || 0.5, // Low vol entry threshold (std dev)
            maxTicks: config.maxTicks || 12, // Max ticks before forced exit
            profitTargetPercentage: config.profitTargetPercentage || 0.30, // 30% profit target
            growthRate: config.growthRate || 0.05, // 5% per tick growth
            compoundingFactor: config.compoundingFactor || 1.1, // Gentle increase after wins
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            dailyStopLoss: config.dailyStopLoss || -50, // Stop if daily loss reaches this
            dailyTakeProfit: config.dailyTakeProfit || 100 // Stop if daily profit reaches this
        };

        this.currentProposalId = null;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.tradeInProgress = false;
        this.wsReady = false;
        this.tickHistory = []; // For volatility calculation
        this.requiredHistoryLength = 20; // Ticks for std dev
        this.consecutiveLosses = 0;
        this.consecutiveWins = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.dailyProfitLoss = 0;
        this.accountBalance = 200; // Will fetch from API
        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.Pause = false;
        this.endOfDay = false;
        this.waitTime = 0;

        // Dynamic buffer for barriers (novelty: adjusts based on vol)
        this.barrierBuffer = 1.0; // Starts at 1%, adjusts up to 2%

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
            if (!this.Pause) {
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
            this.reconnectAttempts++;
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

    fetchBalance() {
        this.sendRequest({
            balance: 1,
            subscribe: 1
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

    requestProposal() {
        if (this.tradeInProgress) return;

        // Calculate dynamic stake: max 1% of balance
        this.currentStake = Math.max(this.config.initialStake, this.accountBalance * this.config.riskPercentage);

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: this.currentAsset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: (this.currentStake * this.config.profitTargetPercentage).toFixed(2) // Dynamic take profit
            }
        };

        this.sendRequest(proposal);
    }
    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('Authentication successful');
            this.fetchBalance(); // Get initial balance
            this.startTrading();

        } else if (message.msg_type === 'balance') {
            // this.accountBalance = message.balance.balance;
            console.log(`Account Balance: ${this.accountBalance}`);

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);

        } else if (message.msg_type === 'tick') {
            // Guard: only handle valid tick updates
            if (message && message.tick && Number.isFinite(Number(message.tick.quote))) {
                this.handleTickUpdate(message.tick);
            } else {
                // Silently ignore malformed tick messages but log at debug level
                const reason = !message?.tick ? 'missing tick' : `invalid quote: `;
                console.debug && console.debug(`[tick] Skipping malformed tick message ().`);
            }

        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);

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
            console.log('Successfully unsubscribed from Current Asset');
            this.currentTradeId = null;

        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
            console.log(`Subscribed to ticks. Subscription ID: `);

        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }
    handleTickHistory(history) {
        // Normalize to numeric array and filter invalids
        const prices = Array.isArray(history?.prices) ? history.prices : [];
        this.tickHistory = prices
            .map(p => Number(p))
            .filter(v => Number.isFinite(v));
        console.log(`Received initial tick history:  ticks`);
    }
    handleTickUpdate(tick) {
        // Defensive checks
        if (!tick || !Number.isFinite(Number(tick.quote))) {
            const reason = !tick ? 'tick is undefined/null' : `tick.quote not finite: `;
            console.debug && console.debug(`[handleTickUpdate] Skipping update ().`);
            return;
        }
        const quote = Number(tick.quote);

        // Maintain numeric history buffer
        this.tickHistory.push(quote);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        // Analyze for entry on every tick when sufficient data
        if (!this.tradeInProgress && this.tickHistory.length >= this.requiredHistoryLength) {
            this.analyzeTicks();
        }

        console.log(`Received tick:  => `);
        if (this.tradeInProgress) {
            const recent = this.tickHistory.slice(-5).filter(Number.isFinite);
            if (recent.length) {
                console.log(`Recent tick history: `);
            }
        }
    }
    calculateVolatility() {
        if (this.tickHistory.length < this.requiredHistoryLength) return Infinity; // Not enough data

        const changes = [];
        for (let i = 1; i < this.tickHistory.length; i++) {
            const a = this.tickHistory[i];
            const b = this.tickHistory[i - 1];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            changes.push(Math.abs(a - b));
        }

        if (!changes.length) return Infinity;

        const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
        const variance = changes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / changes.length;
        return Math.sqrt(variance); // Standard deviation
    }

    analyzeTicks() {
        const currentVol = this.calculateVolatility();
        console.log(`Current Volatility (std dev): ${currentVol.toFixed(4)}`);

        // Dynamic barrier buffer adjustment (novelty)
        this.barrierBuffer = 1.0 + (currentVol * 2); // Up to 2% buffer in higher vol, but we enter only in low vol
        this.barrierBuffer = Math.min(this.barrierBuffer, 2.0); // Cap at 2%

        if (currentVol < this.config.volatilityThreshold) {
            console.log('Low volatility detected - Requesting proposal for entry');
            this.requestProposal();
        } else {
            console.log('High volatility - Skipping entry');
        }
    }

    handleProposal(response) {
        if (response.error) {
            console.error('Proposal error:', response.error.message);
            this.tradeInProgress = false;
            return;
        }

        if (response.proposal) {
            this.currentProposalId = response.proposal.id;
            console.log(`Proposal received. Barrier Buffer: ${this.barrierBuffer}%`);

            // Since we already checked vol in analyzeTicks, proceed to place trade
            this.placeTrade();
        }
    }

    placeTrade() {
        if (this.tradeInProgress || !this.currentProposalId) return;

        const request = {
            buy: this.currentProposalId,
            price: this.currentStake.toFixed(2)
        };

        console.log('Placing accumulator trade:', JSON.stringify(request, null, 2));
        this.sendRequest(request);
        this.tradeInProgress = true;
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

        console.log(`Trade outcome: ${won ? 'Won' : 'Lost'} | Profit: $${profit.toFixed(2)}`);

        this.totalTrades++;
        this.dailyProfitLoss += profit;
        this.totalProfitLoss += profit;
        this.tradeInProgress = false;

        if (won) {
            this.totalWins++;
            this.consecutiveWins++;
            this.consecutiveLosses = 0;
            // Gentle compounding: increase stake slightly
            this.currentStake *= this.config.compoundingFactor;
            this.currentStake = Math.min(this.currentStake, this.accountBalance * this.config.riskPercentage * 2); // Cap at 2% risk
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.consecutiveWins = 0;
            // Reset stake after loss
            this.currentStake = this.config.initialStake;
            this.sendLossEmail();
        }

        this.logTradingSummary();
        this.fetchBalance(); // Update balance after trade

        // Check stopping conditions
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses ||
            this.dailyProfitLoss <= this.config.dailyStopLoss ||
            this.dailyProfitLoss >= this.config.dailyTakeProfit) {
            console.log('Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.Pause = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }

        // Rotate to next asset or wait
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.usedAssets.size === this.assets.length) {
            this.usedAssets.clear();
            this.waitTime = Math.floor(Math.random() * (30000 - 10000 + 1)) + 10000; // 10-30s wait after cycle
            // console.log(`All assets cycled. Waiting ${Math.round(this.waitTime / 1000)} seconds...`);
            // setTimeout(() => this.selectAndSubscribe(), this.waitTime);
            this.selectAndSubscribe();
        } else {
            this.selectAndSubscribe();
        }
    }

    selectAndSubscribe() {
        const availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
        this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
        this.usedAssets.add(this.currentAsset);
        console.log(`Selected asset: ${this.currentAsset}`);

        this.unsubscribeFromTicks(() => {
            this.subscribeToTickHistory(this.currentAsset);
            this.subscribeToTicks(this.currentAsset);
        });
    }

    startTrading() {
        console.log('Starting trading...');
        this.tradeNextAsset();
    }

    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
            this.tickSubscriptionId = null;
        }
        if (callback) callback();
    }

    // Other methods like checkTimeForDisconnectReconnect, disconnect, logTradingSummary, sendEmailSummary, sendLossEmail, sendErrorEmail, sendDisconnectResumptionEmailSummary, startEmailTimer remain similar, adapted as needed.
    // For brevity, assuming they are implemented similarly to the guide, with adjustments for new variables.

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary() {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Wins: ${this.totalWins}`);
        console.log(`Total Losses: ${this.totalLosses}`);
        console.log(`Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Daily Profit/Loss: $${this.dailyProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Consecutive Losses: ${this.consecutiveLosses}`);
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
        VolAccuEdge Bot Summary:
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}
        Daily Profit/Loss: $${this.dailyProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        Current Stake: $${this.currentStake.toFixed(2)}
        Consecutive Losses: ${this.consecutiveLosses}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'VolAccuEdge Accumulator Bot - Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Loss Alert - VolAccuEdge Bot:
        Asset: ${this.currentAsset}
        Recent Ticks: ${this.tickHistory.slice(-5).join(', ')}
        Volatility at Entry: ${this.calculateVolatility().toFixed(4)}
        Consecutive Losses: ${this.consecutiveLosses}
        Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'VolAccuEdge Bot - Loss Alert',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending loss email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'VolAccuEdge Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    async sendDisconnectResumptionEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const now = new Date();
        const time = `${now.getHours()}:${now.getMinutes()}`;

        const summaryText = `
        Disconnect Summary - Time: ${time}
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}
        Daily Profit/Loss: $${this.dailyProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'VolAccuEdge Bot - Disconnect Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending disconnect email:', error);
        }
    }

    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const hours = now.getHours();
            const minutes = now.getMinutes();

            if (this.endOfDay && hours === 11 && minutes >= 0) {
                console.log("Resuming trading at 11:00 AM.");
                this.endOfDay = false;
                this.dailyProfitLoss = 0;
                this.Pause = false;
                this.connect();
            }

            if (!this.endOfDay && hours >= 17 && minutes >= 0) {
                console.log("Stopping for the day after 5:00 PM.");
                this.endOfDay = true;
                this.sendDisconnectResumptionEmailSummary();
                this.disconnect();
            }
        }, 60000); // Check every minute
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Configuration
const bot = new VolAccuEdgeBot('0P94g4WdSrSrzir', { // Replace with your token
    initialStake: 5,
    riskPercentage: 0.01,
    volatilityThreshold: 0.005, // 1HZ10V(0.050), 1HZ25V(13.00), 1HZ50V(5.00), '1HZ75V(0.250), 1HZ100V(0.046), R_10(0.050), R_25(0.050), R_50(0.005), R_75(5.00), R_100(0.140)
    maxTicks: 12,
    profitTargetPercentage: 0.05,//20% of Stake 
    growthRate: 0.05,
    compoundingFactor: 1.1,
    maxConsecutiveLosses: 5,// 5
    dailyStopLoss: -20,
    dailyTakeProfit: 50 // 0.5
});
bot.start();