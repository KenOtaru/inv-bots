const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            'R_10', 'R_25', 'R_50','R_75', 'R_100',
        ];  
        
        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            multiplier2: config.multiplier2,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            takeProfit: config.takeProfit,
            growthRate: 0.05,
            accuTakeProfit: 0.01,
            minTradeDelay: 120000,
            maxTradeDelay: 880000
        };
        
        // Per-asset tracking
        this.assetStates = {};
        this.assets.forEach(asset => {
            this.assetStates[asset] = {
                tickHistory: [],
                lastDigitsList: [],
                tradeInProgress: false,
                currentProposalId: null,
                currentTradeId: null,
                tickSubscriptionId: null,
                currentStake: this.config.initialStake,
                stayedInArray25: [],
                totalArray: [],
                filteredArray: [],
                tradedDigitArray: [],
                filterNum: 5,
                isActive: false,
                isSubscribed: false,
                lastProposalTime: 0
            };
        });

        // Track pending proposals and buys by their IDs
        this.pendingProposals = new Map(); // Maps proposal ID to asset
        this.pendingBuys = new Map(); // Maps contract ID to asset

        // Global state management
        this.currentStake = this.config.initialStake;
        this.globalConsecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.consecutiveLosses6 = 0;
        this.Pause = false;
        this.endOfDay = false;
        this.requiredHistoryLength = 100;
        this.kLoss = 0.01;
        this.activeContracts = new Map(); // Maps contract ID to asset
        this.filterNum = 2;
        
        // Rate limit management
        this.subscriptionQueue = [];
        this.isProcessingQueue = false;
        this.subscriptionDelay = 1000;
        this.activeSubscriptions = 0;

        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.wsReady = false;

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

    sendRequest(request, priority = false) {
        if (this.connected && this.wsReady) {
            if (!priority) {
                setTimeout(() => {
                    if (this.connected && this.wsReady) {
                        this.ws.send(JSON.stringify(request));
                    }
                }, 100);
            } else {
                this.ws.send(JSON.stringify(request));
            }
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request, priority), this.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request.');
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        this.activeSubscriptions = 0;
        
        this.assets.forEach(asset => {
            this.assetStates[asset].isSubscribed = false;
        });
        
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
                console.log('Rate limit reached. Implementing longer delay...');
                this.subscriptionDelay = Math.min(this.subscriptionDelay * 1.5, 30000);
                setTimeout(() => {
                    this.processSubscriptionQueue();
                }, this.subscriptionDelay);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
        }
    }

    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        }, true);
    }

    subscribeToAsset(asset) {
        return new Promise((resolve) => {
            // First get tick history
            const historyRequest = {
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            };
            
            this.sendRequest(historyRequest);
            console.log(`Requested tick history for asset: ${asset}`);
            
            // Wait before subscribing to ticks
            // setTimeout(() => {
                const tickRequest = {
                    ticks: asset,
                    subscribe: 1
                };
                
                this.sendRequest(tickRequest);
                console.log(`Subscribed to ticks for asset: ${asset}`);
                
                this.assetStates[asset].isSubscribed = true;
                this.assetStates[asset].isActive = true;
                this.activeSubscriptions++;
                
                resolve();
            // }, 2000);
        });
    }

    async processSubscriptionQueue() {
        if (this.isProcessingQueue || this.subscriptionQueue.length === 0) {
            return;
        }
        
        this.isProcessingQueue = true;
        
        while (this.subscriptionQueue.length > 0) {
            const asset = this.subscriptionQueue.shift();
            
            if (!this.assetStates[asset].isSubscribed) {
                await this.subscribeToAsset(asset);
                await new Promise(resolve => setTimeout(resolve, this.subscriptionDelay));
            }
        }
        
        this.isProcessingQueue = false;
    }

    startTrading() {
        console.log('Starting sequential asset subscriptions...');
        
        this.subscriptionDelay = 1000;
        this.subscriptionQueue = [...this.assets];
        this.processSubscriptionQueue();
    }

    requestProposal(asset) {
        const assetState = this.assetStates[asset];
        if (assetState.tradeInProgress || !assetState.isActive) return;

        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.kLoss            
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
            this.startTrading();

        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);
        } else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message);
        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message);
        } else if (message.msg_type === 'buy') {
            this.handleBuyResponse(message);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Error receiving contract update:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            console.log('Successfully unsubscribed');
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('Error placing trade:', message.error.message);
            
            // Try to find the asset from echo_req
            if (message.echo_req && message.echo_req.buy) {
                const proposalId = message.echo_req.buy;
                const asset = this.pendingProposals.get(proposalId);
                if (asset && this.assetStates[asset]) {
                    this.assetStates[asset].tradeInProgress = false;
                    this.pendingProposals.delete(proposalId);
                }
            }
            return;
        }

        const contractId = message.buy.contract_id;
        
        // Find asset from the buy response or echo_req
        let asset = null;
        
        // Try to get from longcode
        const longcodeMatch = message.buy.longcode ? message.buy.longcode.match(/[R_]\d+/) : null;
        if (longcodeMatch) {
            asset = longcodeMatch[0];
        }
        
        // If still no asset, try to find from pending proposals
        if (!asset && message.echo_req && message.echo_req.buy) {
            asset = this.pendingProposals.get(message.echo_req.buy);
        }
        
        if (asset && this.assetStates[asset]) {
            console.log(`Trade placed successfully for ${asset}`);
            this.assetStates[asset].currentTradeId = contractId;
            this.activeContracts.set(contractId, asset);
            
            // Clean up pending proposal
            if (message.echo_req && message.echo_req.buy) {
                this.pendingProposals.delete(message.echo_req.buy);
            }
            
            this.subscribeToOpenContract(contractId);
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

    handleTickHistory(message) {
        // Get asset from echo_req
        let asset = null;
        if (message.echo_req && message.echo_req.ticks_history) {
            asset = message.echo_req.ticks_history;
        }

        if (asset && this.assetStates[asset]) {
            const assetState = this.assetStates[asset];
            assetState.tickHistory = message.history.prices.map(price => 
                this.getLastDigit(price, asset)
            );
            console.log(`Received tick history for ${asset}: ${assetState.tickHistory.length} ticks`);
        }
    }

    handleTickUpdate(message) {
        const tick = message.tick;
        const asset = tick.symbol;

        if (!this.assetStates[asset] || !this.assetStates[asset].isActive) return;

        const assetState = this.assetStates[asset];
        const lastDigit = this.getLastDigit(tick.quote, asset);
        
        assetState.lastDigitsList.push(lastDigit);
        assetState.tickHistory.push(lastDigit);
        
        if (assetState.tickHistory.length > this.requiredHistoryLength) {
            assetState.tickHistory.shift();
        }

        if (message.subscription && !assetState.tickSubscriptionId) {
            assetState.tickSubscriptionId = message.subscription.id;
        }

        // console.log(asset,':', assetState.tickHistory.slice(-5).join(','))
        if (assetState.tickHistory.length >= this.requiredHistoryLength && !assetState.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }

    handleProposal(response) {
        if (response.error) {
            console.error('Proposal error:', response.error.message);
            
            // Try to find asset from echo_req
            if (response.echo_req && response.echo_req.symbol) {
                const asset = response.echo_req.symbol;
                if (this.assetStates[asset]) {
                    this.assetStates[asset].tradeInProgress = false;
                }
            }
            return;
        }

        // Get asset from echo_req
        let asset = null;
        if (response.echo_req && response.echo_req.symbol) {
            asset = response.echo_req.symbol;
        }

        if (!asset || !this.assetStates[asset]) return;

        const assetState = this.assetStates[asset];

        if (response.proposal) {
            const stayedInArray = response.proposal.contract_details.ticks_stayed_in;
            assetState.stayedInArray25 = stayedInArray.slice(-16);
            
            const currentDigitCount2 = assetState.stayedInArray25[15] + 1;
            assetState.currentProposalId = response.proposal.id;
            assetState.totalArray = stayedInArray;
            
            // Store proposal ID to asset mapping
            this.pendingProposals.set(response.proposal.id, asset);

            const digitFrequency = {};
            assetState.stayedInArray25.forEach(digit => {
                digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
            });

            const appearedOnceArray = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === this.filterNum) 
                .map(Number);

            // Create array 2
            const appearedOnceArray1 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 3) 
                .map(Number);
            
            // Create array 3
            const appearedOnceArray2 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 4) 
                .map(Number);
            
            // Create array 4
            const appearedOnceArray3 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 5) 
                .map(Number);
            
            // Create array 5
            const appearedOnceArray4 = Object.keys(digitFrequency)
                .filter(digit => digitFrequency[digit] === 6) 
                .map(Number);

            // console.log("Asset", asset)
            // console.log("Filtered Array", assetState.stayedInArray25)
            // console.log("CurrentDigitCount", currentDigitCount2)
            
            if (!assetState.tradeInProgress && !this.shouldStopTrading()) {
                
                if (appearedOnceArray1.length > 0) {
                    if (appearedOnceArray.includes(currentDigitCount2)
                        && assetState.stayedInArray25[0] !== currentDigitCount2
                        && assetState.stayedInArray25[1] !== currentDigitCount2
                        && assetState.tradedDigitArray[assetState.tradedDigitArray.length - 1] !== currentDigitCount2
                        && assetState.stayedInArray25[15] >= 0
                    ) {
                        assetState.tradedDigitArray.push(currentDigitCount2);
                        assetState.filteredArray = appearedOnceArray;
                        this.filterNum = appearedOnceArray.length;
                        console.log("Asset", asset)
                        console.log("Asset Array", assetState.stayedInArray25)
                        console.log("Current Digit Count", currentDigitCount2)
                        console.log(`Filtered Array: ${appearedOnceArray} (${appearedOnceArray.length})`);

                        console.log(`
                            StayedIn Analysis: 
                            2 Array: ${appearedOnceArray} (${appearedOnceArray.length})
                            3 Array: ${appearedOnceArray1} (${appearedOnceArray1.length})
                            4 Array: ${appearedOnceArray2} (${appearedOnceArray2.length})
                            5 Array: ${appearedOnceArray3} (${appearedOnceArray3.length})
                            6 Array: ${appearedOnceArray4} (${appearedOnceArray4.length})
                        `)
                        this.placeTrade(asset);
                    }
                }
            }
        }
    }

    analyzeTicks(asset) {
        const assetState = this.assetStates[asset];
        
        // Throttle proposal requests
        const now = Date.now();
        if (now - assetState.lastProposalTime < 1000) {
            return;
        }
        
        if (!assetState.tradeInProgress && !this.shouldStopTrading() && assetState.isActive) {
            assetState.lastProposalTime = now;
            this.requestProposal(asset);
        }
    }

    placeTrade(asset) {
        const assetState = this.assetStates[asset];
        
        if (assetState.tradeInProgress || this.shouldStopTrading()) return;

        if (!assetState.currentProposalId) {
            console.error(`No valid proposal ID available for ${asset}`);
            assetState.tradeInProgress = false;
            return;
        }

        const request = {
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2)
        };

        console.log(`Placing trade for ${asset}: Stake=$${this.currentStake.toFixed(2)}`);
        this.sendRequest(request);
        assetState.tradeInProgress = true;
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
        
        // Get asset from our tracking or from contract
        let asset = this.activeContracts.get(contract.contract_id);
        if (!asset) {
            asset = contract.underlying;
        }
        
        if (!asset || !this.assetStates[asset]) return;
        
        const assetState = this.assetStates[asset];
        
        console.log(`${asset} Trade Result: ${won ? 'WON' : 'LOST'} - Profit: $${profit.toFixed(2)}`);
       
        this.totalTrades++;
        this.activeContracts.delete(contract.contract_id);
        
        if (won) {
            this.totalWins++;
            this.globalConsecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            this.kLoss = 0.01;
        } else {
            this.totalLosses++;
            this.globalConsecutiveLosses++;
            
            if (this.globalConsecutiveLosses === 2) this.consecutiveLosses2++;
            if (this.globalConsecutiveLosses === 3) this.consecutiveLosses3++;
            if (this.globalConsecutiveLosses === 4) this.consecutiveLosses4++;
            if (this.globalConsecutiveLosses === 5) this.consecutiveLosses5++;
            if (this.globalConsecutiveLosses === 6) this.consecutiveLosses6++;
            
            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            
            this.sendLossEmail(asset);

        }

        this.totalProfitLoss += profit;

        if (assetState.tradedDigitArray.length > 1) {
            assetState.tradedDigitArray.shift();
        }

        // assetState.tradeInProgress = false;
        // assetState.currentProposalId = null;
        // assetState.currentTradeId = null;

        this.logTradingSummary();

        if (this.shouldStopTrading()) {
            this.handleStopCondition();
            return;
        }

        const nextTradeDelay = Math.floor(Math.random() * (this.config.maxTradeDelay - this.config.minTradeDelay + 1)) + this.config.minTradeDelay;
        console.log(`Next trade for ${asset} in ${nextTradeDelay} seconds...`);

        setTimeout(() => {
            if (!this.shouldStopTrading() && assetState.isActive) {
                console.log(`${asset} ready for next trade`);
                assetState.tradeInProgress = false;
                assetState.currentProposalId = null;
                assetState.currentTradeId = null;
            }
        }, nextTradeDelay);
    }

    shouldStopTrading() {
        return this.totalProfitLoss >= this.config.takeProfit ||
               this.globalConsecutiveLosses >= this.config.maxConsecutiveLosses ||
               this.endOfDay;
    }

    handleStopCondition() {
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping all trading.');
        } else if (this.globalConsecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('Maximum consecutive losses reached... Stopping all trading.');
        }
        
        this.endOfDay = true;
        this.Pause = true;
        
        this.assets.forEach(asset => {
            this.assetStates[asset].isActive = false;
            this.assetStates[asset].tradeInProgress = false;
        });
        
        if (this.activeContracts.size > 0) {
            console.log(`Waiting for ${this.activeContracts.size} active contracts to close...`);
            setTimeout(() => this.handleStopCondition(), 1000);
            return;
        }
        
        this.sendDisconnectResumptionEmailSummary();
        this.disconnect();
    }

    disconnect() {
        if (this.connected) {
            this.assets.forEach(asset => {
                const assetState = this.assetStates[asset];
                if (assetState.tickSubscriptionId) {
                    this.sendRequest({
                        forget: assetState.tickSubscriptionId
                    });
                }
            });
            
            setTimeout(() => {
                this.ws.close();
            }, 1000);
        }
    }

    logTradingSummary() {
        console.log('\n======= Trading Summary =======');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Wins: ${this.totalWins}`);
        console.log(`Total Losses: ${this.totalLosses}`);
        console.log(`Global Consecutive Losses: ${this.globalConsecutiveLosses}`);
        console.log(`Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        
        // console.log('\n--- Active Assets ---');
        // this.assets.forEach(asset => {
        //     const state = this.assetStates[asset];
        //     if (state.isActive) {
        //         console.log(`${asset}: Stake=$${state.currentStake.toFixed(2)}, Trading=${state.tradeInProgress}`);
        //     }
        // });
        console.log('================================\n');
    }

    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000);
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        let assetDetails = '';
        this.assets.forEach(asset => {
            const state = this.assetStates[asset];
            if (state.isActive) {
                assetDetails += `\n${asset}: Stake=$${state.currentStake.toFixed(2)}, Trading=${state.tradeInProgress}`;
            }
        });

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Global Consecutive Losses: ${this.globalConsecutiveLosses}
        
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}
        x6 Losses: ${this.consecutiveLosses6}

        Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%

        Active Assets:${assetDetails}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: '1Concurrent Accumulator Bot - Summary',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        const assetState = this.assetStates[asset];

        const summaryText = `
        Loss Alert for ${asset}:
        
        Global Status:
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        Global Consecutive Losses: ${this.globalConsecutiveLosses}
        Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}

        Asset Details (${asset}):
        Current Stake: $${this.currentStake.toFixed(2)}
        Filtered Array: ${assetState.filteredArray}
        Traded Array: ${assetState.tradedDigitArray}
        Filter Number: ${this.filterNum}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `1Loss Alert - ${asset}`,
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending loss email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: '1Trading Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
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

        let assetDetails = '';
        this.assets.forEach(asset => {
            const state = this.assetStates[asset];
            assetDetails += `\n\n${asset}:
            Final Stake: $${state.currentStake.toFixed(2)}
            Filtered Array: ${state.filteredArray}
            Traded Array: ${state.tradedDigitArray}`;
        });

        const summaryText = `
        Session End - ${now.toLocaleString()}
        
        Final Results:
        Total Trades: ${this.totalTrades}
        Total Wins: ${this.totalWins}
        Total Losses: ${this.totalLosses}
        
        Total Profit/Loss: $${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%

        Asset Details:${assetDetails}
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Session End - 1Concurrent Trading',
            text: summaryText
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            // console.error('Error sending disconnect email:', error);
        }
    }

    start() {
        this.connect();
    }
}

// Configuration
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    // 'DMylfkyce6VyZt7', '0P94g4WdSrSrzir'
    initialStake: 20,
    multiplier: 21,
    maxConsecutiveLosses: 1,
    stopLoss: 105,
    takeProfit: 1,
    growthRate: 0.05,
    accuTakeProfit: 0.5,
    minTradeDelay: 120000,
    maxTradeDelay: 880000     
});

bot.start();