const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class QuantumInspiredDerivBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            // 'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
            'RDBULL',
        ];

        this.config = {
            initialStake: config.initialStake || 3,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            takeProfit: config.takeProfit || 40,
        };
        
        // Global state management
        this.globalConsecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.activeContracts = new Map();
        this.Pause = false;
        this.endOfDay = false;
        this.requiredHistoryLength = 5000; // Minimum ticks before trading
        
        // Per-asset runtime state (added)
        this.quantumStates = {};
        this.assets.forEach(asset => {
            this.quantumStates[asset] = {
                tickHistory: [],
                tickHistory2: [],
                tradeInProgress: false,
                isActive: false,
                lastAnalysisTime: 0,
                lastTradeTime: 0,
                currentStake: this.config.initialStake,
                tickSubscriptionId: null,
                xDigit: null, // last predicted digit used for this asset
            };
        });

        // Simplified configuration
        this.uniqueConfig = {
            minDataBeforeTrade: 150
        };

        // Memory limits to prevent crashes
        this.memoryLimits = {
            maxArrayLength: 100,
            maxMapSize: 50,
            maxHistoryLength: this.requiredHistoryLength,
            cleanupInterval: 30000,
            analysisThrottle: 2000,
        };

        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.wsReady = false;
        this.subscriptionQueue = [];
        this.isProcessingQueue = false;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        
        // Start cleanup timer
        this.startMemoryCleanup();
        this.startEmailTimer();
    }

    // Memory cleanup function
    startMemoryCleanup() {
        setInterval(() => {
            this.cleanupMemory();
        }, this.memoryLimits.cleanupInterval);
    }

    cleanupMemory() {
        try {
            this.assets.forEach(asset => {
                const state = this.quantumStates[asset];
                
                if (state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                    state.tickHistory = state.tickHistory.slice(-this.memoryLimits.maxHistoryLength);
                }
            });

            this.assets.forEach(asset => {
                const state = this.quantumStates[asset];
                if (!state) return;
                if (Array.isArray(state.tickHistory) && state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                    state.tickHistory = state.tickHistory.slice(-this.memoryLimits.maxHistoryLength);
                }
                if (Array.isArray(state.tickHistory2) && state.tickHistory2.length > this.memoryLimits.maxHistoryLength) {
                    state.tickHistory2 = state.tickHistory2.slice(-this.memoryLimits.maxHistoryLength);
                }
            });

            const max = this.memoryLimits.maxArrayLength;
            if (this.globalAdversarial && Array.isArray(this.globalAdversarial.successfulStrategies) &&
                this.globalAdversarial.successfulStrategies.length > max) {
                this.globalAdversarial.successfulStrategies =
                    this.globalAdversarial.successfulStrategies.slice(-max);
            }

            if (global.gc) {
                global.gc();
            }
        } catch (error) {
            console.error('Memory cleanup error:', error);
        }
    }


    // Connection methods
    connect() {
        try {
            console.log('Initializing Quantum-Inspired Trading System...');
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Message parsing error:', error);
                }
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
        } catch (error) {
            console.error('Connection error:', error);
            this.handleDisconnect();
        }
    }

    sendRequest(request, priority = false) {
        try {
            if (this.connected && this.wsReady) {
                const jitter = priority ? 0 : Math.random() * 200;
                
                setTimeout(() => {
                    if (this.connected && this.wsReady) {
                        this.ws.send(JSON.stringify(request));
                    }
                }, jitter);
            }
        } catch (error) {
            console.error('Send request error:', error);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        this.assets.forEach(asset => {
            this.quantumStates[asset].isActive = false;
        });
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            const backoff = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts), 60000);
            setTimeout(() => this.connect(), backoff);
            this.reconnectAttempts++;
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token.');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit detected - adjusting...');
                setTimeout(() => this.processSubscriptionQueue(), 10000);
                break;
            case 'MarketIsClosed':
                console.log('Market closed.');
                setTimeout(() => this.startTrading(), 3600000);
                break;
            default:
                console.log('Error encountered.');
        }
    }

    authenticate() {
        console.log('Authenticating...');
        this.sendRequest({
            authorize: this.token
        }, true);
    }

    async subscribeToAsset(asset) {
        return new Promise((resolve) => {
            const delay = Math.random() * 3000 + 2000;
            
            // setTimeout(() => {
                const historyRequest = {
                    ticks_history: asset,
                    adjust_start_time: 1,
                    count: this.memoryLimits.maxHistoryLength,
                    end: 'latest',
                    start: 1,
                    style: 'ticks'
                };
                
                this.sendRequest(historyRequest);
                console.log(`📊 Scanning ${asset}...`);
                
                // setTimeout(() => {
                    const tickRequest = {
                        ticks: asset,
                        subscribe: 1
                    };
                    
                    this.sendRequest(tickRequest);
                    console.log(`📡 Connected to ${asset}`);
                    
                    this.quantumStates[asset].isActive = true;
                    resolve();
                // }, 2000);
            // }, delay);
        });
    }

    async processSubscriptionQueue() {
        if (this.isProcessingQueue || this.subscriptionQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        // Limit to 7 assets for memory management
        const limitedAssets = this.subscriptionQueue.slice(0, 7);
        
        for (const asset of limitedAssets) {
            if (!this.quantumStates[asset].isActive) {
                await this.subscribeToAsset(asset);
                await new Promise(resolve => setTimeout(resolve, 7000));
            }
        }
        
        this.isProcessingQueue = false;
    }

    startTrading() {
        console.log('\n🚀 Multi n-n TRADING SYSTEM INITIALIZED');
        console.log('═══════════════════════════════════════\n');
        
        this.assets.forEach(asset => {
            const state = this.quantumStates[asset];
            state.tickHistory = [];
            state.tradeInProgress = false;
        });
        
        // Limit to 7 random assets
        const shuffled = [...this.assets].sort(() => Math.random() - 0.5);
        this.subscriptionQueue = shuffled.slice(0, 7);
        console.log('Trading assets:', this.subscriptionQueue.join(', '));
        
        this.processSubscriptionQueue();
    }

    handleMessage(message) {
        try {
            if (message.msg_type === 'authorize') {
                if (message.error) {
                    console.error('Authentication failed:', message.error.message);
                    this.disconnect();
                    return;
                }
                console.log('✅ Authentication successful');
                this.startTrading();

            } else if (message.msg_type === 'history') {
                this.handleTickHistory(message);
            } else if (message.msg_type === 'tick') {
                this.handleTickUpdate(message);
            } else if (message.msg_type === 'buy') {
                this.handleBuyResponse(message);
            } else if (message.msg_type === 'proposal_open_contract') {
                if (message.error) {
                    console.error('Contract error:', message.error.message);
                    return;
                }
                this.handleContractUpdate(message.proposal_open_contract);
            } else if (message.msg_type === 'forget') {
                console.log('Unsubscribed from tick stream');
            } else if (message.error) {
                this.handleApiError(message.error);
            }
        } catch (error) {
            console.error('Message handling error:', error);
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

    handleTickHistory(message) {
        try {
            let asset = null;
            if (message.echo_req && message.echo_req.ticks_history) {
                asset = message.echo_req.ticks_history;
            }

            if (asset && this.quantumStates[asset]) {
                const state = this.quantumStates[asset];
                // populate both last-digit and second-to-last digit histories
                state.tickHistory = message.history.prices.slice(-this.memoryLimits.maxHistoryLength).map(price => 
                    this.getLastDigit(price, asset)
                );
                state.tickHistory2 = message.history.prices.slice(-this.memoryLimits.maxHistoryLength).map(price => 
                    this.getLastDigit2(price, asset)
                );
                
                console.log(`📊 ${asset}: Loaded ${state.tickHistory.length} data points`);
            }

        } catch (error) {
            console.error('Tick history error:', error);
        }
    }

    handleTickUpdate(message) {
        try {
            const tick = message.tick;
            const asset = tick.symbol;

            if (!this.quantumStates[asset] || !this.quantumStates[asset].isActive) return;

            const state = this.quantumStates[asset];
            const lastDigit = this.getLastDigit(tick.quote, asset);
            const secondToLast = this.getLastDigit2(tick.quote, asset);

            state.tickHistory.push(lastDigit);
            state.tickHistory2.push(secondToLast);
            
            // Maintain rolling window
            if (state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                state.tickHistory.shift();
            }
            if (state.tickHistory2.length > this.memoryLimits.maxHistoryLength) {
                state.tickHistory2.shift();
            }

            if (message.subscription && !state.tickSubscriptionId) {
                state.tickSubscriptionId = message.subscription.id;
            }

            if (state.tradeInProgress) {
                console.log(`${asset} Tick (in-trade): [${state.tickHistory.slice(-10).join(',')}]`);
            } else {
                // Light logging (comment/uncomment as needed)
                // console.log(`${asset} Tick: ${tick.quote} (${lastDigit}) 2nd:${secondToLast}`);
            }
            
            // Analyze after sufficient data
            if (!state.tradeInProgress && state.tickHistory.length >= this.uniqueConfig.minDataBeforeTrade) {
                this.analyzeAsset(asset);
            }
        } catch (error) {
            console.error('Tick update error:', error);
        }
    }


    async analyzeAsset(asset) {
        const state = this.quantumStates[asset];
        const now = Date.now();
        
        // Throttle analysis
        if (now - state.lastAnalysisTime < this.memoryLimits.analysisThrottle) return;
        state.lastAnalysisTime = now;
        
        // Basic safety / cooldown guards
        if (now - state.lastTradeTime < 2000) return; // 10s cooling between trades per asset
        if (state.tradeInProgress || this.shouldStopTrading()) return;

          // Analyze recent pairs
        const tickNumber = 5000;
        const recentLast = state.tickHistory.slice(-tickNumber);
        const recentSecond = state.tickHistory2.slice(-tickNumber);
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
            const isExcluded = [0, 1, 2, 3, 4, 5, 6, 7, 9].includes(prevLast);
            if (prevLast === prevSecond && !isExcluded) {
                totalTriggers++;
                if (currLast === prevLast) {
                    totalLosses++;
                    currentRun++;
                    if (lossSamples.length < 30) lossSamples.push(`${i}:prev=${prevLast}|sec=${prevSecond}|last=${currLast}`);
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

        const winCalculation = ((totalTriggers - totalLosses) / 11) * state.currentStake;
        const lossCalculation = (totalLosses * state.currentStake);
        const profitCalculation = (winCalculation - lossCalculation);

        console.log(`[${asset} Pair Analysis]
            samples=${len}
            triggers=${totalTriggers}
            totalLosses=${totalLosses}
            totalConsecutiveLosses=${totalConsecutiveLosses}
            2xConsecutive=${runsGE2}
            3xConsecutive=${runsGE3}
            4xConsecutive=${runsGE4}
            5xConsecutive=${runsGE5}
            longestConsecutiveLosses=${longestConsecutiveLosses}
            winCalc=$${winCalculation.toFixed(2)}
            lossCalc=$${lossCalculation.toFixed(2)}
            profitCalc=$${profitCalculation.toFixed(2)}
            losses=${lossSamples.join(', ')}
        `);

        // console.log(`[${asset} Pair Analysis]
        //     samples=${len}
        //     totalMatches=${totalMatches}
        //     totalConsecutivePairs=${totalConsecutivePairs}
        //     2xConsecutive=${runsGE2}
        //     3xConsecutive=${runsGE3}
        //     longestConsecutiveRun=${longestRun}
        // `);
    

        // If we have enough data, place a trade
        const latestLast = state.tickHistory[state.tickHistory.length - 1];
        const latestSecond = state.tickHistory2[state.tickHistory2.length - 1];

        if (latestSecond === latestLast
            && latestLast !== 0 
            && latestLast !== 9 
            && latestLast !== 3 
            && latestLast !== 6
            && latestLast !== 2 
            && latestLast !== 7
            ) {

            // set marker to avoid duplicate immediate trades on same digit
            state.xDigit = latestLast;
            state.lastTradeTime = now;

            // Place trade using existing placeTrade(asset, predictedDigit)
            // console.log(`\n🎯 ${asset} - PREDICTING DIGIT ${latestLast} (placing trade)`);
            // this.placeTrade(asset, latestLast);
        }
    }

    placeTrade(asset, predictedDigit) {
        const state = this.quantumStates[asset];
        
        if (state.tradeInProgress || this.shouldStopTrading()) return;

        state.tradeInProgress = true;
        
        console.log(`💰 ${asset} - EXECUTING TRADE`);
        console.log(`Barrier: ${predictedDigit}`);
        console.log(`Stake: $${state.currentStake.toFixed(2)}`);
        
        const request = {
            buy: 1,
            price: state.currentStake.toFixed(2),
            parameters: {
                amount: state.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: predictedDigit
            }
        };
        
        this.sendRequest(request);
    }

    handleBuyResponse(message) {
        try {
            if (message.error) {
                console.error('Trade error:', message.error.message);
                
                if (message.echo_req && message.echo_req.parameters) {
                    const asset = message.echo_req.parameters.symbol;
                    if (this.quantumStates[asset]) {
                        this.quantumStates[asset].tradeInProgress = false;
                    }
                }
                return;
            }

            const contractId = message.buy.contract_id;
            let asset = null;
            
            if (message.echo_req && message.echo_req.parameters) {
                asset = message.echo_req.parameters.symbol;
            }
            
            if (asset && this.quantumStates[asset]) {
                console.log(`✅ Trade placed for ${asset}`);
                this.quantumStates[asset].currentTradeId = contractId;
                this.activeContracts.set(contractId, asset);
                this.subscribeToOpenContract(contractId);
            }
        } catch (error) {
            console.error('Buy response error:', error);
        }
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
        try {
            const won = contract.status === 'won';
            const profit = parseFloat(contract.profit);
            
            let asset = this.activeContracts.get(contract.contract_id);
            if (!asset) {
                asset = contract.underlying;
            }
            
            if (!asset || !this.quantumStates[asset]) return;
            
            const state = this.quantumStates[asset];
            
            console.log(`\n📊 ${asset} - RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
            console.log(`Profit/Loss: $${profit.toFixed(2)}`);
            
            this.totalTrades++;
            this.activeContracts.delete(contract.contract_id);
            
            if (won) {
                this.totalWins++;
                this.globalConsecutiveLosses = 0;
                state.currentStake = this.config.initialStake;
            } else {
                this.totalLosses++;
                this.globalConsecutiveLosses++;
                state.currentStake = Math.ceil(state.currentStake * this.config.multiplier * 100) / 100;
                
                // if (this.globalConsecutiveLosses === 2) {
                //     console.log('⚠️ Warning: 2 consecutive losses');
                // }  
            }

            this.totalProfitLoss += profit;
            state.tradeInProgress = false;
            state.currentTradeId = null;

            this.logTradingSummary();
            
            if(!won) {
              this.sendLossEmail(asset);
            }

            if (this.shouldStopTrading()) {
                this.handleStopCondition();
            }
        } catch (error) {
            console.error('Trade result error:', error);
        }
    }

    shouldStopTrading() {
        return this.totalProfitLoss >= this.config.takeProfit ||
               this.globalConsecutiveLosses >= this.config.maxConsecutiveLosses ||
               this.endOfDay;
    }

    handleStopCondition() {
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('✅ TAKE PROFIT REACHED!');
        } else if (this.globalConsecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('❌ MAX LOSSES REACHED!');
        }
        
        this.endOfDay = true;
        this.Pause = true;
        
        this.assets.forEach(asset => {
            if (this.quantumStates[asset]) {
                this.quantumStates[asset].isActive = false;
                this.quantumStates[asset].tradeInProgress = false;
            }
        });
        
        if (this.activeContracts.size > 0) {
            console.log(`Waiting for ${this.activeContracts.size} contracts...`);
            setTimeout(() => this.handleStopCondition(), 1000);
            return;
        }
        
        this.sendFinalReport();
        this.disconnect();
    }

    disconnect() {
        if (this.connected) {
            this.assets.forEach(asset => {
                if (this.quantumStates[asset]) {
                    const state = this.quantumStates[asset];
                    if (state.tickSubscriptionId) {
                        this.sendRequest({
                            forget: state.tickSubscriptionId
                        });
                    }
                }
            });
            
            setTimeout(() => {
                if (this.ws) {
                    this.ws.close();
                }
            }, 1000);
        }
    }

    logTradingSummary() {
        console.log('\n⚛️ TRADING SUMMARY ⚛️');
        console.log('═══════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Won: ${this.totalWins} | Lost: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Consecutive Losses: ${this.globalConsecutiveLosses}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log('═══════════════════════════\n');
    }
    
    startEmailTimer() {
        setInterval(() => {
            if (!this.shouldStopTrading()) {
                this.sendEmailSummary();
            }
        }, 1800000);
    }

    async sendEmailSummary() {
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);

            const summaryText = `
            QUANTUM TRADING REPORT
            =====================
            
            Performance:
            Total Trades: ${this.totalTrades}
            Won: ${this.totalWins} | Lost: ${this.totalLosses}
            Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
            Total P/L: $${this.totalProfitLoss.toFixed(2)}
            `;

            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: 'Multi n-n Deriv Bot - Trading Report',
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    async sendLossEmail(asset) {
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);

            const summaryText = `
            LOSS ALERT - ${asset}
            =====================
            Consecutive Losses: ${this.globalConsecutiveLosses}
            Total P/L: $${this.totalProfitLoss.toFixed(2)}
            `;

            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: `Multi n-n Deriv Bot - Loss Alert - ${asset}`,
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    async sendFinalReport() {
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);

            const summaryText = `
            SESSION COMPLETE
            ================
            Total Trades: ${this.totalTrades}
            Won: ${this.totalWins} | Lost: ${this.totalLosses}
            Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
            Total P/L: $${this.totalProfitLoss.toFixed(2)}
            `;

            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: 'Multi n-n Deriv Bot - Session Complete',
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    start() {
        this.connect();
    }
}

// Initialize and start
const quantumBot = new QuantumInspiredDerivBot('0P94g4WdSrSrzir', {
    initialStake: 5,
    multiplier: 11.3,
    maxConsecutiveLosses: 6,
    takeProfit: 50
});

// Run with: node --expose-gc --max-old-space-size=2048 bot.js
quantumBot.start();

module.exports = QuantumInspiredDerivBot;