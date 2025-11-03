const WebSocket = require('ws');
const nodemailer = require('nodemailer');


// EnhancedDerivTradingBot class with Advanced Pattern Recognition
class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_75'
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
        this.tickHistory2 = [];
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
        this.xDigit = null;
        this.isExcluded = [1,3,4,5,6,7,8,9];
        
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
            this.tickHistory2 = [];
            
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

    getLastDigit2(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            // Second-to-last is index 2 (third digit) if length >= 4
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[2]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            // Second-to-last is index 1 (second digit) if length >= 3
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[1]) : 0;
        } else {
            // Second-to-last is index 0 (first digit) if length >= 2
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[0]) : 0;
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
        this.tickHistory2 = history.prices.map(price => this.getLastDigit2(price, this.currentAsset));
    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        const SecondToLastDigit = this.getLastDigit2(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);
        
        // Update tick history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        // Update tick history2
        this.tickHistory2.push(SecondToLastDigit);
        if (this.tickHistory2.length > this.requiredHistoryLength) {
            this.tickHistory2.shift();
        }       
        
        console.log(`Recent ${this.currentAsset} tick History: ${tick.quote} => ${this.tickHistory.slice(-5).join(', ')}`);  
        console.log('SecondToLastDigit and Last Digit:',  SecondToLastDigit, '|' , lastDigit)   
        

        // Enhanced logging
        if(!this.tradeInProgress) {
            // if(SecondToLastDigit === lastDigit) {
                this.analyzeTicksEnhanced(SecondToLastDigit, lastDigit);           
            // }           
        }
    }

            
    analyzeTicksEnhanced() {
        if (this.tradeInProgress) {
            return;
        }

        // show suspended Digit
        if (this.isExcluded.length > 0) {
            console.log(`Skipped analysis for suspended Digits: [${this.isExcluded}]`);
            // return;
        }

          // Analyze recent pairs
        const tickNumber = 5000;
        const recentLast = this.tickHistory.slice(-tickNumber);
        const recentSecond = this.tickHistory2.slice(-tickNumber);
        const len = Math.min(recentLast.length, recentSecond.length);
        if (len < 2) return; // need at least two ticks to evaluate "previous" vs "current" pattern

        let totalLosses = 0;
        let longestConsecutiveLosses = 0;
        let currentRun = 0;
        let totalConsecutiveLosses = 0; // sum of (runLength - 1) for each run > 1
        let runsGE2 = 0, runsGE3 = 0, runsGE4 = 0, runsGE5 = 0;
        const lossSamples = [];

        // New matching rule:
        // A match at index i (current) is valid if:
        //   previousLast === previousSecond  AND  currentLast === previousLast
        // i.e. previous latestLast equals previous latestSecond, and current latestLast equals previous latestLast
        // start loop at 1 since we reference previous index
        let totalTriggers = 0;
        for (let i = 1; i < len; i++) {
            const prevLast = recentLast[i - 1];
            const prevSecond = recentSecond[i - 1];  // Renamed for clarity
            const currLast = recentLast[i];
            const currSecond = recentSecond[i];

            // apply same exclusions used in single-asset bot against the digit we compare (prevLast)
            if (prevLast === prevSecond && !this.isExcluded.includes(prevLast) && prevLast !== 0) {
                totalTriggers++;
                if (currLast === prevLast) {
                    totalLosses++;
                    currentRun++;
                    if (lossSamples.length < 100) lossSamples.push(`
                        ${i}:prev=${prevLast}|
                        sec=${prevSecond}|
                        currlast=${currLast}
                    `);
                } else {
                if (currentRun > 0) {
                    if (currentRun > 1) totalConsecutiveLosses += (currentRun - 1);
                    if (currentRun >= 2) runsGE2++;
                    if (currentRun >= 3) runsGE3++;
                    if (currentRun >= 4) runsGE4++;
                    if (currentRun >= 5) runsGE5++;
                    if (currentRun > longestConsecutiveLosses) longestConsecutiveLosses = currentRun;
                }
                currentRun = 0;
            }
        }}

        // finalize any run that reached to the end of the buffer
        if (currentRun > 0) {
            if (currentRun > 1) totalConsecutiveLosses += (currentRun - 1);
            if (currentRun >= 2) runsGE2++;
            if (currentRun >= 3) runsGE3++;
            if (currentRun >= 4) runsGE4++;
            if (currentRun >= 5) runsGE5++;
            if (currentRun > longestConsecutiveLosses) longestConsecutiveLosses = currentRun;
        }

        const winCalculation = ((totalTriggers - totalLosses) / 11) * this.currentStake;
        const lossCalculation = (totalLosses * this.currentStake);
        const profitCalculation = (winCalculation - lossCalculation);

        // console.log(`[${this.currentAsset} Pair Analysis]
        //     samples=${len}
        //     triggers=${totalTriggers}
        //     totalLosses=${totalLosses}
        //     totalConsecutiveLosses=${totalConsecutiveLosses}
        //     2xConsecutive=${runsGE2}
        //     3xConsecutive=${runsGE3}
        //     4xConsecutive=${runsGE4}
        //     5xConsecutive=${runsGE5}
        //     longestConsecutiveLosses=${longestConsecutiveLosses}
        //     winCalc=$${winCalculation.toFixed(2)}
        //     lossCalc=$${lossCalculation.toFixed(2)}
        //     profitCalc=$${profitCalculation.toFixed(2)}
        //     losses=${lossSamples.join(', ')}
        // `);

        console.log(`[${this.currentAsset} Pair Analysis]
            samples=${len}
            triggers=${totalTriggers}
            totalLosses=${totalLosses}
            totalConsecutiveLosses=${totalConsecutiveLosses}
            2xConsecutive=${runsGE2}
            3xConsecutive=${runsGE3}
            4xConsecutive=${runsGE4}
            5xConsecutive=${runsGE5}
            longestConsecutiveLosses=${longestConsecutiveLosses}
        `);

        this.lastDigit = this.tickHistory[this.tickHistory.length - 1];
        const SecondToLastDigit = this.tickHistory2[this.tickHistory2.length - 1];

        if ( SecondToLastDigit === this.lastDigit
            && this.lastDigit !== 0
            && !this.isExcluded.includes(this.lastDigit) 
            ) {
            
            this.xDigit = this.lastDigit;
            // this.winProbNumber = leastPercentage;
            
            this.placeTrade(this.xDigit);
        }
    }


    placeTrade(predictedDigit) {
        if (this.tradeInProgress) {
            return;
        }

        this.tradeInProgress = true;
        
        console.log(`\n PLACING TRADE`);
        console.log(`Digit: ${predictedDigit}`);
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

            // this.isExcluded.push(this.xDigit);
            // console.log('Suspended', this.xDigit, 'Digit')

            // If suspended digit reaches 3, shift the oldest one out on win
            if (this.isExcluded.length > 9) {
                this.isExcluded = [];
                console.log('Resetting', this.isExcluded, 'Array')
                this.isExcluded.push(this.xDigit);
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
            subject: 'n-n Deriv Differ Bot - Trading Summary',
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
        
        Recent History:
        --------------
        Last 20 Digits: ${klastDigits.join(', ')}
        
        Current Stake: $${this.currentStake.toFixed(2)}
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'n-n Deriv Bot - Loss Alert',
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
            subject: 'n-n Deriv Bot - Error Report',
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
            subject: 'n-n Deriv Bot - Status Update',
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
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 1,
    multiplier: 11.3,
    maxStake: 127,
    maxConsecutiveLosses: 3,
    stopLoss: 127,
    takeProfit: 100,
});

bot.start();
