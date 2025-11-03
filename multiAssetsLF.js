require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            'R_10', 'RDBULL', 'R_25', 'R_50', 'RDBEAR', 'R_75', 'R_100'
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 1,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
            shortWindow: config.shortWindow || 25,  // For multi-window analysis
            mediumWindow: config.mediumWindow || 50,
            longWindow: config.longWindow || 100,
            minOccurrencesThreshold: config.minOccurrencesThreshold || 1,  // Bet if <= this
            greenArcThreshold: config.greenArcThreshold || 15.5,  // For max digit filter
        };

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.lastDigits = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.endOfDay = false;
        this.lastPredictionOutcome = null;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        this.kCount = 0;
        this.kTrade = false;
        this.previousConfidence = 100;
        this.kSys = 0;

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });

        // Add tracking for previous digit agreements
        this.lastDigitAgreement = {};
        this.assets.forEach(asset => {
            this.lastDigitAgreement[asset] = false;
        });

        this.shortLeasts = {};
        this.mediumLeasts = {};
        this.longLeasts = {};
        this.assets.forEach(asset => {
            this.shortLeasts[asset] = null;
            this.mediumLeasts[asset] = null;
            this.longLeasts[asset] = null;
        });

        //Email Configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        
        this.startEmailTimer();

        this.reconnectAttempts = 0;
        this.Pause = false;

        this.todayPnL = 0;
    }

    connect() {
        if (!this.Pause) {
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
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.config.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.config.reconnectInterval);
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
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.initializeSubscriptions();
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
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        // console.log(`Requested tick history for asset: ${asset}`);
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
            this.predictionInProgress = false;
            this.assets.forEach(asset => {
                this.tickHistories[asset] = [];
                this.digitCounts[asset] = Array(10).fill(0);
                this.predictedDigits[asset] = null;
                this.lastPredictions[asset] = [];
            });
            this.tickSubscriptionIds = {};
            this.retryCount = 0;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
                // console.log(`Subscribed to ticks for ${asset}. Subscription ID: ${this.tickSubscriptionIds[asset]}`);
            }
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
            // console.log('Successfully unsubscribed from ticks');
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

    initializeSubscriptions() {
        console.log('Initializing subscriptions for all assets...');
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        // console.log(`Received tick history for asset: ${asset}. Length: ${this.tickHistories[asset].length}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);
        // this.lastDigits[asset] = lastDigit;
        
        this.tickHistories[asset].push(lastDigit);
        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        this.digitCounts[asset][lastDigit]++;

        console.log(`[${asset}] Last 10 digits: ${this.tickHistories[asset].slice(-10).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return; 
        }

        if (!this.tradeInProgress) {
            this.lastDigits[asset] = this.tickHistories[asset].slice(-1)[0];
            console.log('kkklast Digit', this.lastDigits[asset])
            this.analyzeTicks(asset);
        }
    }

    // Novelty: Multi-window least frequent digit voting with green arc filter and streak adjustment
    analyzeTicks(asset) {
        if (this.tradeInProgress) {
            return;
        }

        const history = this.tickHistories[asset];

        // Short window
        const shortHistory = history.slice(-this.config.shortWindow);
        const shortLeast = this.getLeastFrequentDigit(shortHistory);
        this.shortLeasts[asset] = shortLeast;

        // Medium window
        const mediumHistory = history.slice(-this.config.mediumWindow);
        const mediumLeast = this.getLeastFrequentDigit(mediumHistory);
        this.mediumLeasts[asset] = mediumLeast;

        // Long window
        const longHistory = history.slice(-this.config.longWindow);
        const longLeast = this.getLeastFrequentDigit(longHistory);
        this.longLeasts[asset] = longLeast;

        // Voting: Most common least frequent digit across windows
        const votes = [shortLeast.digit, mediumLeast.digit, longLeast.digit].filter(d => d !== null);
        if (votes.length < 3) {
            console.log(`[${asset}] Insufficient signals. Skipping...`);
            return;
        }
        const voteCounts = Array(10).fill(0);
        votes.forEach(d => voteCounts[d]++);
        let maxVote = 0;
        let predicted = null;
        for (let d = 0; d < 10; d++) {
            if (voteCounts[d] > maxVote) {
                maxVote = voteCounts[d];
                predicted = d;
            }
        }

        // Adjust for streak: If predicted is on streak, shift to next least if possible
        const streak = this.checkStreak(longHistory, predicted);
        // if (streak >= 2) {  // Avoid if on rare streak
        //     return;  // Skip betting if on streak
        // }

        // Get least digits for this asset
        const leastDigits = this.getLeastFrequentDigits(history, 3);
        console.log(`[${asset}] Least digits: ${leastDigits}`);

        // Get max digits for this asset
        const maxDigits = this.getMaxFrequentDigits(history, 3);
        console.log(`[${asset}] Max digits: ${maxDigits}`);


        // Fix confidence calculation
        const shortPct = (shortLeast.count / this.config.shortWindow) * 100;
        const mediumPct = (mediumLeast.count / this.config.mediumWindow) * 100;
        const longPct = (longLeast.count / this.config.longWindow) * 100;

        const maxPercentage = Math.max(shortPct, mediumPct, longPct);
        
        // Invert the percentage to get confidence (rarer = higher confidence)
        const confidence = 100 - maxPercentage;

        // Log the detailed calculations
        // console.log(`[${asset}] Confidence Calculation:
        //     // Short Window: ${shortLeast.count}/${this.config.shortWindow} = ${shortPct.toFixed(2)}%
        //     // Medium Window: ${mediumLeast.count}/${this.config.mediumWindow} = ${mediumPct.toFixed(2)}%
        //     // Long Window: ${longLeast.count}/${this.config.longWindow} = ${longPct.toFixed(2)}%
        //     // Max Percentage: ${maxPercentage.toFixed(2)}%
        //     Final Confidence: ${confidence.toFixed(2)}%
        // `);

        // Store the last confidence value for this asset
        if (!this.lastConfidence) this.lastConfidence = {};
        const previousConfidence = this.lastConfidence[asset] || 0;
        this.lastConfidence[asset] = confidence;

        // Check if confidence just reached 100% for this specific asset
        const justReached100 = previousConfidence < this.config.winProbabilityThreshold && confidence >= this.config.winProbabilityThreshold;


        // Check if predicted digit is unique across other assets' least digits
        // let isUnique = true;
        // for (let otherAsset of this.assets) {
        //     if (otherAsset !== asset) {
        //         const otherShort = this.shortLeasts[otherAsset];
        //         const otherMedium = this.mediumLeasts[otherAsset];
        //         const otherLong = this.longLeasts[otherAsset];
        //         if ((otherShort && otherShort.digit === predicted) ||
        //             (otherMedium && otherMedium.digit === predicted) ||
        //             (otherLong && otherLong.digit === predicted)) {
        //             isUnique = false;
        //             console.log(`[${asset}] Predicted digit ${predicted} conflicts with ${otherAsset}'s least digits. Skipping...`);
        //             break;
        //         }
        //     }
        // }

        // Store current state of digit agreement
        const currentAgreement = (shortLeast.digit === mediumLeast.digit && 
                                shortLeast.digit === longLeast.digit && 
                                mediumLeast.digit === longLeast.digit);

        // Check if agreement just happened (transition from false to true)
        const justAgreed = !this.lastDigitAgreement[asset] && currentAgreement;
        
        // Update agreement state for next check
        this.lastDigitAgreement[asset] = currentAgreement;

        console.log(`[${asset}] Digit Agreement: previous=${!this.lastDigitAgreement[asset]}, current=${currentAgreement}, justAgreed=${justAgreed}`);
        console.log(`[${asset}] Previous confidence: ${previousConfidence}%, Current confidence: ${confidence.toFixed(2)}%`);
        console.log(`[${asset}] Predictions: Short=${shortLeast.digit} (${shortLeast.count}), Med=${mediumLeast.digit} (${mediumLeast.count}), Long=${longLeast.digit} (${longLeast.count})`);
        console.log(`[${asset}] Final Predicted Digit: ${predicted} (Confidence: ${confidence.toFixed(2)}%)`);
        
        const nPosition = this.kSys;
        
        // Trade if conditions are met
        if (
            justReached100
            && 
            confidence >= this.config.winProbabilityThreshold 
            && 
            justAgreed
            // (shortLeast.digit === mediumLeast.digit && shortLeast.digit === longLeast.digit && mediumLeast.digit === longLeast.digit) 
            && predicted === leastDigits[nPosition] 
        ) {
            this.predictedDigits[asset] = predicted;
            this.lastPredictions[asset].push(predicted);
            if (this.lastPredictions[asset].length > 2) this.lastPredictions[asset].shift();
            this.asset = asset;
            this.confidence = confidence;
            this.placeTrade(asset, predicted, confidence);
        } else {
            console.log(`[${asset}] Conditions not met. Scanning...`);
        }
    }

        
    getLeastFrequentDigit(history) {
        const counts = Array(10).fill(0);
        history.forEach(d => counts[d]++);
        let minCount = Infinity;
        let digit = null;
        for (let d = 0; d < 10; d++) {
            if (counts[d] < minCount) {
                minCount = counts[d];
                digit = d;
            }
        }
        return { digit, count: minCount };
    }

    getLeastFrequentDigits(history, topN) {
        const counts = Array(10).fill(0);
        history.forEach(d => counts[d]++);
        return counts.map((c, d) => ({ d, c })).sort((a, b) => a.c - b.c).slice(0, topN).map(item => item.d);
    }

    getMaxFrequentDigit(history) {
        const counts = Array(10).fill(0);
        history.forEach(d => counts[d]++);
        const total = history.length;
        let maxCount = 0;
        let digit = null;
        for (let d = 0; d < 10; d++) {
            if (counts[d] > maxCount) {
                maxCount = counts[d];
                digit = d;
            }
        }
        return { digit, count: maxCount };
    }

    getMaxFrequentDigits(history, topN) {
        const counts = Array(10).fill(0);
        history.forEach(d => counts[d]++);
        return counts.map((c, d) => ({ d, c })).sort((a, b) => b.c - a.c).slice(0, topN).map(item => item.d);
    }

    checkStreak(history, digit) {
        let streak = 0;
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i] === digit) {
                streak++;
            } else {
                break;
            }
        }
        return streak;
    }

    placeTrade(asset, predictedDigit, confidence) {
        if (this.tradeInProgress) {
            return;
        }
       
        this.tradeInProgress = true;

        console.log(`[${asset}] 🚀 Placing trade for digit: ${predictedDigit} (${confidence.toFixed(2)}%) Stake: ${this.currentStake.toFixed(2)}`);
        const request = {
            buy: 1,
            price: this.currentStake, 
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: predictedDigit.toString(),
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
        const asset = this.asset;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        
        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;
            this.kCount = 0;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }  

        this.totalProfitLoss += profit;	
        this.todayPnL += profit;	
        this.Pause = true;

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;
      
        // Log trading summary
        this.logTradingSummary(asset);

        if (!won) {
            this.sendLossEmail(asset);
            // Update kSys
            this.kSys === 2 ? this.kSys = 1 : this.kSys === 1 ? this.kSys = 0 : this.kSys = 2;
        }

        this.kTrade = false
        this.previousConfidence = 100; 
        this.lastDigitAgreement[asset] = false;

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });

        // Add tracking for previous digit agreements
        this.lastDigitAgreement = {};
        this.assets.forEach(asset => {
            this.lastDigitAgreement[asset] = false;
        });

        this.shortLeasts = {};
        this.mediumLeasts = {};
        this.longLeasts = {};
        this.assets.forEach(asset => {
            this.shortLeasts[asset] = null;
            this.mediumLeasts[asset] = null;
            this.longLeasts[asset] = null;
        });
        
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition reached. Stopping trading.');
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        this.unsubscribeAllTicks();

        if (!this.endOfDay) {               
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.initializeSubscriptions();
            }, randomWaitTime);
        }
    }

    unsubscribeAllTicks() {
        Object.values(this.tickSubscriptionIds).forEach(subId => {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
            // console.log(`Unsubscribing from ticks with ID: ${subId}`);
        });
        this.tickSubscriptionIds = {};
    }

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM, reconnecting the bot.");
                this.assets.forEach(asset => {
                    this.lastPredictions[asset] = [];
                });
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }
    
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 20 && currentMinutes >= 0) {
                    console.log("It's past 8:00 PM after a win trade, disconnecting the bot.");
                    this.Pause = true;
                    this.unsubscribeAllTicks();
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

    logTradingSummary(asset) {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Digit: ${this.predictedDigits[asset]}`);
        console.log(`kSys: ${this.kSys}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`); 
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }
    
    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 1800000); // 30 minutes
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        KSys: ${this.kSys}

        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'LF_Multi_Asset_Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const lastFewTicks = this.tickHistories[asset].slice(-20);

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${asset}
        Predicted Digit: ${this.predictedDigits[asset]}
        Last Digit: ${this.lastDigits[asset]}
        KSys: ${this.kSys}
        
        Last 20 Digits: ${lastFewTicks.join(', ')}

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'LF_Multi_Asset_Bot - Loss Alert',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Loss email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending loss email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'LF_Multi_Asset_Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Error email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('0P94g4WdSrSrzir', {
    initialStake: 1,
    multiplier: 11.3,
    maxConsecutiveLosses: 3, 
    stopLoss: 89,
    takeProfit: 200,
    requiredHistoryLength: 200,
    winProbabilityThreshold: 96,
    minWaitTime: 12000,
    maxWaitTime: 12000,
    shortWindow: 25,
    mediumWindow: 50,
    longWindow: 100,
    minOccurrencesThreshold: 1,
    greenArcThreshold: 15.5,
});

bot.start();