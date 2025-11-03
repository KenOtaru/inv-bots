const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class MultiAssetDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        
        //Please use only one type of assets per time
        this.assets = [
            // '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',// 1 tick per second. 
            'R_10','R_25', 'R_50', 'R_75', 'R_100'//1 tick every 2 seconds
            //  'R_50', 'R_75', 'R_100'
        ];
        
        this.config = {
            initialStake: config.initialStake || 5,
            multiplier: config.multiplier || 1,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 4,
            stopLoss: config.stopLoss || 15,
            takeProfit: config.takeProfit || 10,
            growthRate: config.growthRate || 0.05,
            accuTakeProfit: config.accuTakeProfit || 0.01,
            maxConcurrentTrades: config.maxConcurrentTrades || 5,
            requiredHistoryLength: config.requiredHistoryLength || 100,
            minTimeBetweenTrades: config.minTimeBetweenTrades || 5000,
            assetCooldownPeriod: config.assetCooldownPeriod || 30000,
            minWaitTime: config.minWaitTime || 60000,// 1 minute
            maxWaitTime: config.maxWaitTime || 1800000,// 30 minutes
        };
        
        // Per-Asset State Management (following working bot pattern)
        this.assetStates = {};
        this.initializeAssetStates();
        
        // Global Statistics
        this.globalStats = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfit: 0,
            activeTrades: 0,
            sessionStartTime: Date.now(),
            roundsCompleted: 0
        };
        
        // Trading control
        this.currentStake = this.config.initialStake;
        this.completedAssetsInRound = new Set();
        this.consecutiveLosses = 0;
        this.tradingPaused = false;
        this.endOfDay = false;
        this.suspendTradedAsset = true;
        this.lostDigit = null;
        this.Pause = false;
        this.endOfDay = false;
        
        // WebSocket management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        
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
    
    initializeAssetStates() {
        this.assets.forEach(asset => {
            this.assetStates[asset] = {
                // Trading state
                tradeInProgress: false,
                currentStake: this.config.initialStake,
                consecutiveLosses: 0,
                consecutiveLosses2: 0,
                consecutiveLosses3: 0,
                consecutiveLosses4: 0,
                consecutiveLosses5: 0,
                consecutiveLosses6: 0,
                currentProposalId: null,
                currentContractId: null,
                lastTradeTime: 0,
                cooldownUntil: 0,
                suspended: false,
                
                // History and analysis
                tickHistory: [],
                lastDigitsList: [],
                stayedInArray25: [],
                tradedDigitArray: [],
                filteredArray: [],
                totalArray: [],
                
                // Performance tracking
                totalTrades: 0,
                totalWins: 0,
                totalLosses: 0,
                totalProfit: 0,
                winRate: 0,
                
                // Analysis data
                confidenceScore: 0,
                lastAnalysisTime: 0,
                filterNum: 4,
                filterNum2: 5,
                filterNum3: 6,
                filterNum4: 7,
            };
        });
    }
    
    // ============ CONNECTION MANAGEMENT ============
    connect() {
        console.log('🔌 Connecting to Deriv API...');
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
        
        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
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
            console.error('❌ WebSocket error:', error);
            this.handleDisconnect();
        });
        
        this.ws.on('close', () => {
            console.log('🔌 Disconnected from Deriv API');
            this.connected = false;
            if (!this.tradingPaused) {
                this.handleDisconnect();
            }
        });
    }
    
    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else {
            console.log('⏳ WebSocket not ready, queueing request...');
            setTimeout(() => this.sendRequest(request), 1000);
        }
    }
    
    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({
            authorize: this.token
        });
    }
    
    // ============ MESSAGE HANDLING (Following working bot pattern) ============
    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorization(message);
                break;
            case 'proposal':
                this.handleProposal(message);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                this.handleContractUpdate(message);
                break;
            case 'tick':
                this.handleTick(message);
                break;
            case 'history':
                this.handleHistory(message);
                break;
            case 'error':
                this.handleApiError(message.error);
                break;
        }
    }
    
    handleAuthorization(message) {
        if (message.error) {
            console.error('❌ Authorization failed:', message.error.message);
            this.disconnect();
            return;
        }
        
        console.log('✅ Authorization successful');
        this.startMultiAssetTrading();
    }
    
    // ============ MULTI-ASSET TRADING INITIALIZATION ============
    async startMultiAssetTrading() {
        console.log('🚀 Starting Multi-Asset Trading...');
        
        // Initialize all assets
        for (const asset of this.assets) {
            await this.initializeAsset(asset);
            await this.delay(1000); // Small delay between asset initializations
        }
        
        console.log(`📊 Monitoring ${this.assets.length} assets for opportunities`);
    }
    
    async initializeAsset(asset) {
        console.log(`📈 Initializing ${asset}...`);
        
        // Request tick history
        this.sendRequest({
            ticks_history: asset,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            style: 'ticks'
        });
        
        // Subscribe to live ticks
        await this.delay(500);
        this.sendRequest({
            ticks: asset,
            subscribe: 1
        });
        
        // Start analyzing after initial data loads
        setTimeout(() => {
            this.analyzeAsset(asset);
        }, 3000);
    }

    //Method to get correct Asset Last Digit 
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
    
    // ============ TICK & HISTORY HANDLING ============
    handleHistory(message) {
        const asset = message.echo_req.ticks_history;
        const assetState = this.assetStates[asset];
        
        if (!assetState) return;
        
        const prices = message.history.prices;
        assetState.tickHistory = prices.map(price => 
            this.getLastDigit(price, asset)
        );
        
        console.log(`📊 Loaded ${prices.length} historical ticks for ${asset}`);
    }
    
    handleTick(message) {
        const tick = message.tick;
        const asset = tick.symbol;
        const assetState = this.assetStates[asset];
        
        if (!assetState) return;
        
        const lastDigit = this.getLastDigit(tick.quote, asset);
        
        // Update tick history
        assetState.lastDigitsList.push(lastDigit);
        assetState.tickHistory.push(lastDigit);
        
        if (assetState.tickHistory.length > this.config.requiredHistoryLength) {
            assetState.tickHistory.shift();
        }
        
        // Log current state
        const activeTrades = Object.values(this.assetStates)
            .filter(s => s.tradeInProgress).length;
        
        // console.log(`[${asset}] Tick: ${tick.quote} (Last digit: ${lastDigit}) | Recent: ${assetState.tickHistory.slice(-5).join(',')}`);
        
        // Check if we should analyze this asset
        if (this.shouldAnalyzeAsset(asset)) {
            this.analyzeAsset(asset);
        }
    }
        
    // ============ ASSET ANALYSIS ============
    shouldAnalyzeAsset(asset) {
        const assetState = this.assetStates[asset];
        const now = Date.now();
        
        // Check if asset is suspended or in cooldown
        if (assetState.suspended || now < assetState.cooldownUntil) {
            return false;
        }
        
        // Check if already trading this asset
        if (assetState.tradeInProgress) {
            return false;
        }
        
        // Check global trade limit
        const activeTrades = Object.values(this.assetStates)
            .filter(s => s.tradeInProgress).length;
        if (activeTrades >= this.config.maxConcurrentTrades) {
            return false;
        }
        
        // Check minimum time between analyses
        if (now - assetState.lastAnalysisTime < 3000) {
            return false;
        }
        
        // Check if we have enough history
        if (assetState.tickHistory.length < this.config.requiredHistoryLength) {
            return false;
        }
        
        return true;
    }
    
    analyzeAsset(asset) {
        const assetState = this.assetStates[asset];
        assetState.lastAnalysisTime = Date.now();
        
        // Request accumulator proposal (using passthrough like working bot)
        this.requestProposalForAsset(asset);
    }
    
    requestProposalForAsset(asset) {
        const assetState = this.assetStates[asset];
        
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2), //assetState.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: this.config.accuTakeProfit
            },
            // Use passthrough to track asset (like working bot)
            passthrough: { asset }
        };
        
        this.sendRequest(proposal);
    }
    
    // ============ PROPOSAL HANDLING ============
    handleProposal(message) {
        if (message.error) {
            console.error('Proposal error:', message.error.message);
            return;
        }
        
        // Get asset from passthrough or echo_req (following working bot pattern)
        const asset = message.echo_req?.passthrough?.asset || message.echo_req?.symbol;
        if (!asset) return;
        
        const assetState = this.assetStates[asset];
        if (!assetState || assetState.tradeInProgress) return;
        
        const proposal = message.proposal;
        if (!proposal || !proposal.contract_details) return;
        
        // Extract stayed_in statistics
        const stayedInArray = proposal.contract_details.ticks_stayed_in || [];
        
        // Your existing analysis logic
        this.analyzeStayedInForAsset(asset, stayedInArray, proposal.id);
    }
    
    analyzeStayedInForAsset(asset, stayedInArray, proposalId) {
        const assetState = this.assetStates[asset];
        
        if (stayedInArray.length < 100) {
            return;
        }
        
        assetState.currentProposalId = proposalId;
        assetState.stayedInArray25 = stayedInArray.slice(-16);
        assetState.totalArray = stayedInArray;
        
        const currentDigitCount = assetState.stayedInArray25[15] + 1;

        // console.log('Received proposal:', stayedInArray);
        console.log('16 proposal:', assetState.stayedInArray25, 'Current Count', currentDigitCount);
        
        // Create frequency map
        const digitFrequency = {};
        assetState.stayedInArray25.forEach(digit => {
            digitFrequency[digit] = (digitFrequency[digit] || 0) + 1;
        });
        
        // Your existing trading logic
        const appearedOnceArray = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === assetState.filterNum)
            .map(Number);
        
        const appearedOnceArray1 = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === assetState.filterNum2)
            .map(Number);
        
        const appearedOnceArray2 = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === assetState.filterNum3)
            .map(Number);

        const appearedOnceArray3 = Object.keys(digitFrequency)
            .filter(digit => digitFrequency[digit] === assetState.filterNum4)
            .map(Number);
        
        console.log(`
        📊 [${asset}] StayedIn Analysis:
        Current: ${currentDigitCount} (Freq: ${digitFrequency[currentDigitCount - 1] || 0})
        ${assetState.filterNum} Array: ${appearedOnceArray.length}  
        ${assetState.filterNum2} Array: ${appearedOnceArray1.length}  
        ${assetState.filterNum3} Array: ${appearedOnceArray2.length}
        ${assetState.filterNum4} Array: ${appearedOnceArray3.length}
        `);
        
        // Check trading conditions
        if (!assetState.tradeInProgress && !assetState.suspended) {
            if (assetState.consecutiveLosses < 1) {
                if ((
                     appearedOnceArray.includes(currentDigitCount)  
                    //  || 
                    //  appearedOnceArray1.includes(currentDigitCount) 
                    //  || 
                    //  appearedOnceArray2.includes(currentDigitCount)
                     )
                     &&
                     appearedOnceArray1.length < 1
                     &&
                     appearedOnceArray2.length < 1
                     &&
                     appearedOnceArray3.length < 1 
                     &&
                     assetState.stayedInArray25[15] >= 0
                     &&
                     assetState.stayedInArray25[0] !== currentDigitCount 
                     && assetState.stayedInArray25[1] !== currentDigitCount
                    ) {
                        assetState.tradedDigitArray.push(currentDigitCount);
                        assetState.filteredArray = appearedOnceArray;
                        this.lostDigit = currentDigitCount;
                        console.log(`🔄 [${asset}] Trading conditions met`);
                        this.executeTrade(asset);
                }
            } else {
                if (
                     (appearedOnceArray.includes(currentDigitCount) 
                    //  || 
                    //  appearedOnceArray1.includes(currentDigitCount) 
                    //  || 
                    //  appearedOnceArray2.includes(currentDigitCount)
                     )
                     &&
                     appearedOnceArray1.length < 1
                     &&
                     appearedOnceArray2.length < 1
                     &&
                     appearedOnceArray3.length < 1
                     &&
                     this.lostDigit !== currentDigitCount
                     &&
                     assetState.stayedInArray25[15] >= 0
                     &&
                     assetState.stayedInArray25[0] !== currentDigitCount 
                     && assetState.stayedInArray25[1] !== currentDigitCount
                    ) {
                        assetState.tradedDigitArray.push(currentDigitCount);
                        assetState.filteredArray = appearedOnceArray;
                        console.log(`🔄 [${asset}] Trading conditions met`);
                        this.executeTrade(asset);
                }
            }
        }
        
        // Continue monitoring if not trading
        if (!assetState.tradeInProgress) {
            // setTimeout(() => {
                if (this.shouldAnalyzeAsset(asset)) {
                    this.analyzeAsset(asset);
                }
            // }, 3000);
        }
    }
    
    // ============ TRADE EXECUTION ============
    executeTrade(asset) {
        const assetState = this.assetStates[asset];
        
        if (!assetState.currentProposalId) {
            console.error(`No proposal ID for ${asset}`);
            return;
        }
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║        🎯 EXECUTING TRADE              ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(32)} ║
        ║ Stake: $${this.currentStake.toFixed(2).padEnd(30)} ║
        ║ Active Trades: ${this.globalStats.activeTrades}/${this.config.maxConcurrentTrades}         ║
        ╚════════════════════════════════════════╝
        `);
        
        const buyRequest = {
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2)
        };
        
        // Mark as in progress
        assetState.tradeInProgress = true;
        assetState.lastTradeTime = Date.now();
        this.globalStats.activeTrades++;
        
        this.sendRequest(buyRequest);
    }
    
    // ============ BUY RESPONSE HANDLING ============
    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Buy error:', message.error.message);
            
            // Find which asset this was for and reset
            for (const [asset, state] of Object.entries(this.assetStates)) {
                if (state.tradeInProgress && !state.currentContractId) {
                    state.tradeInProgress = false;
                    this.globalStats.activeTrades--;
                    break;
                }
            }
            return;
        }
        
        const contractId = message.buy.contract_id;
        
        // Find the asset for this contract
        let tradedAsset = null;
        for (const [asset, state] of Object.entries(this.assetStates)) {
            if (state.tradeInProgress && !state.currentContractId) {
                state.currentContractId = contractId;
                tradedAsset = asset;
                break;
            }
        }
        
        if (tradedAsset) {
            console.log(`🎯 [${tradedAsset}] Trade placed - Contract ID: ${contractId}`);
            
            // Subscribe to contract updates
            this.subscribeToContract(contractId);
        }
    }
    
    subscribeToContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };
        
        this.sendRequest(request);
    }
    
    // ============ CONTRACT UPDATE HANDLING ============
    handleContractUpdate(message) {
        const contract = message.proposal_open_contract;
        if (!contract) return;
        
        const contractId = contract.contract_id;
        
        // Find the asset for this contract
        let asset = null;
        let assetState = null;
        
        for (const [assetName, state] of Object.entries(this.assetStates)) {
            if (state.currentContractId === contractId) {
                asset = assetName;
                assetState = state;
                break;
            }
        }
        
        if (!asset || !assetState) return;
        
        // Check if contract ended
        if (contract.is_sold) {
            this.handleTradeResult(asset, contract);
        }
    }
    
    // ============ TRADE RESULT HANDLING ============
    handleTradeResult(asset, contract) {
        const assetState = this.assetStates[asset];
        const profit = parseFloat(contract.profit || 0);
        const won = contract.status === 'won';
        
        // Update asset-specific statistics
        assetState.totalTrades++;
        if (won) {
            assetState.totalWins++;
            assetState.consecutiveLosses = 0;
            this.consecutiveLosses = 0;
            // assetState.currentStake = this.config.initialStake;
            this.currentStake = this.config.initialStake;
            console.log(`✅ [${asset}] Trade WON! Profit: $${profit.toFixed(2)}`);
        } else {
            assetState.totalLosses++;
            assetState.consecutiveLosses++;
            this.consecutiveLosses++;
            
            // Track consecutive losses
            if (assetState.consecutiveLosses === 2) assetState.consecutiveLosses2++;
            if (assetState.consecutiveLosses === 3) assetState.consecutiveLosses3++;
            if (assetState.consecutiveLosses === 4) assetState.consecutiveLosses4++;
            if (assetState.consecutiveLosses === 5) assetState.consecutiveLosses5++;
            if (assetState.consecutiveLosses === 6) assetState.consecutiveLosses6++;
            
            // assetState.currentStake = Math.ceil(assetState.currentStake * this.config.multiplier * 100) / 100;

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;

            assetState.cooldownUntil = Date.now() + this.config.assetCooldownPeriod;
            
            console.log(`❌ [${asset}] Trade LOST! Loss: $${Math.abs(profit).toFixed(2)}`);
            
            //Suspen Asset
            if(this.suspendTradedAsset) {
                assetState.suspended = true;
            }
        }
        
        assetState.totalProfit += profit;
        assetState.winRate = assetState.totalWins / assetState.totalTrades;
        
        // Update global statistics
        this.globalStats.totalTrades++;
        if (won) {
            this.globalStats.totalWins++;
        } else {
            this.globalStats.totalLosses++;
        }
        this.globalStats.totalProfit += profit;
        this.globalStats.activeTrades--;
        
        // Mark asset as completed in this round
        this.completedAssetsInRound.add(asset);

        // if(this.suspendTradedAsset) {
        //     assetState.suspended = true;
        // }

        // Send loss email if needed
        if (!won) {
            this.sendLossEmail(asset, assetState);
        }
        
        // Keep traded digit array under limit
        if (assetState.tradedDigitArray.length > 10) {
            assetState.tradedDigitArray.shift();
        }
        
        // Reset asset state
        assetState.tradeInProgress = false;
        assetState.currentContractId = null;
        assetState.currentProposalId = null;
        
        // Log results
        this.logTradeResult(asset, won, profit);
        this.logGlobalSummary();
        
        // Check global exit conditions
        if (this.checkGlobalExitConditions()) {
            this.stopTrading();
            return;
        }
        
        // Check if we should start a new round
        this.checkForNewRound();
        
        // Continue trading other assets
        setTimeout(() => {
            this.startNextAsset();
        }, this.config.minTimeBetweenTrades);
    }
    
    checkForNewRound() {
        // If all assets have been traded, start a new round
        if (this.completedAssetsInRound.size === this.assets.length) {
            console.log('\n🔄 === All assets traded. Starting new round ===\n');
            this.globalStats.roundsCompleted++;
            this.completedAssetsInRound.clear();
            
            // Resume all assets
            for (const [asset, state] of Object.entries(this.assetStates)) {
                state.suspended = false;
                console.log(`📈 ${asset} resumed for trading`);
            }
            
            // Wait before starting new round
            const waitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime; //Random time between minimum and maximum wait times
            console.log(`Waiting ${(waitTime).toFixed(0)} seconds before starting new round...`);
            
            setTimeout(() => {
                this.startNextAsset();
            }, waitTime);
        }
    }
    
    startNextAsset() {
        const availableAssets = this.getAvailableAssets();
        
        if (availableAssets.length > 0) {
            const activeTrades = Object.values(this.assetStates)
                .filter(s => s.tradeInProgress).length;
                
            if (activeTrades < this.config.maxConcurrentTrades) {
                const nextAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
                console.log(`Starting analysis for: ${nextAsset}`);
                this.analyzeAsset(nextAsset);
            }
        }
    }
    
    getAvailableAssets() {
        return this.assets.filter(asset => {
            const state = this.assetStates[asset];
            const now = Date.now();
            return !state.suspended && 
                   !state.tradeInProgress && 
                   now >= state.cooldownUntil &&
                   !this.completedAssetsInRound.has(asset);
        });
    }
    
    checkGlobalExitConditions() {
        // Check stop loss
        if (this.globalStats.totalProfit <= -this.config.stopLos || this.consecutiveLosses > this.config.maxConsecutiveLosses) {
            console.log('🛑 Global stop loss reached!');
            this.Pause = true;
            this.endOfDay = true;
            this.disconnect();
            return true;
        }
        
        // Check take profit
        if (this.globalStats.totalProfit >= this.config.takeProfit) {
            console.log('🎯 Global take profit reached!');
            this.Pause = true;
            this.endOfDay = true;
            this.disconnect();
            return true;
        }
        
        return false;
    }
    
    // ============ LOGGING ============
    logTradeResult(asset, won, profit) {
        const assetState = this.assetStates[asset];
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║      TRADE RESULT - ${won ? '✅ WIN' : '❌ LOSS'}             ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(32)} ║
        ║ Profit/Loss: $${profit.toFixed(2).padEnd(25)} ║
        ║ Asset Win Rate: ${(assetState.winRate * 100).toFixed(1)}%                ║
        ║ Asset P/L: $${assetState.totalProfit.toFixed(2).padEnd(26)} ║
        ╚════════════════════════════════════════╝
        `);
    }
    
    logGlobalSummary() {
        const winRate = this.globalStats.totalTrades > 0 ? 
            ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(2) : 0;
        
        console.log('\n=== 🌍 GLOBAL TRADING SUMMARY ===');
        console.log(`🔄 Rounds Completed: ${this.globalStats.roundsCompleted}`);
        console.log(`📈 Total Trades: ${this.globalStats.totalTrades}`);
        console.log(`✅ Total Wins: ${this.globalStats.totalWins}`);
        console.log(`❌ Total Losses: ${this.globalStats.totalLosses}`);
        console.log(`📊 Win Rate: ${winRate}%`);
        console.log(`💰 Total Profit/Loss: $${this.globalStats.totalProfit.toFixed(2)}`);
        console.log(`🔥 Active Trades: ${this.globalStats.activeTrades}`);
        
        // Log individual asset performance
        console.log('\n📊 Asset Performance:');
        for (const [asset, state] of Object.entries(this.assetStates)) {
            if (state.totalTrades > 0) {
                const status = state.tradeInProgress ? '🔄' : 
                              (state.suspended ? '⏸️' : 
                              (state.cooldownUntil > Date.now() ? '❄️' : '✅'));
                console.log(
                    `${status} ${asset}: ` +
                    `Trades: ${state.totalTrades} | ` +
                    `WR: ${(state.winRate * 100).toFixed(1)}% | ` +
                    `P/L: $${state.totalProfit.toFixed(2)}`
                );
            }
        }
        console.log('=====================================\n');
    }
    
    // ============ ERROR HANDLING ============
    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token.');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting...');
                this.pauseAllTrading(60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting...');
                this.pauseAllTrading(3600000);
                break;
            default:
                console.log('Non-critical error encountered. Continuing...');
        }
    }
    
    pauseAllTrading(duration) {
        console.log(`⏸️ Pausing all trading for ${duration / 1000} seconds`);
        
        const until = Date.now() + duration;
        for (const state of Object.values(this.assetStates)) {
            state.cooldownUntil = Math.max(state.cooldownUntil, until);
        }
    }
    
    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Reconnecting (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
            this.reconnectAttempts++;
        }
    }
    
    disconnect() {
        if (this.connected) {
            this.tradingPaused = true;
            this.ws.close();
        }
    }
    
    stopTrading() {
        console.log('🛑 Stopping all trading activities...');
        this.endOfDay = true;
        this.sendEmailSummary(true);
        this.disconnect();
    }
    
    // ============ EMAIL FUNCTIONS ============
    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }
    
    async sendEmailSummary(isFinal = false) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        let assetDetails = '\n--- Individual Asset Performance ---\n';
        for (const [asset, state] of Object.entries(this.assetStates)) {
            if (state.totalTrades > 0) {
                assetDetails += `
${asset}:
  Trades: ${state.totalTrades} | Wins: ${state.totalWins} | Losses: ${state.totalLosses}
  Profit: $${state.totalProfit.toFixed(2)} | Win Rate: ${(state.winRate * 100).toFixed(1)}%
  Current Stake: $${state.currentStake.toFixed(2)}
  x2 Losses: ${state.consecutiveLosses2} | x3: ${state.consecutiveLosses3} | x4: ${state.consecutiveLosses4}
`;
            }
        }
        
        const globalWinRate = this.globalStats.totalTrades > 0 ? 
            ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(2) : 0;
        
        const summaryText = `
${isFinal ? 'FINAL ' : ''}Multi-Asset Trading Summary

--- Global Statistics ---
Rounds Completed: ${this.globalStats.roundsCompleted}
Total Trades: ${this.globalStats.totalTrades}
Total Wins: ${this.globalStats.totalWins}
Total Losses: ${this.globalStats.totalLosses}
Win Rate: ${globalWinRate}%
Total Profit/Loss: $${this.globalStats.totalProfit.toFixed(2)}

${assetDetails}
        `;
        
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: `Multi-Asset Bot - ${isFinal ? 'Final ' : ''}Summary`,
            text: summaryText
        };
        
        try {
            await transporter.sendMail(mailOptions);
            console.log('📧 Email sent successfully');
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }
    
    async sendLossEmail(asset, assetState) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const summaryText = `
Loss Alert - ${asset}

Asset Performance:
Total Trades: ${assetState.totalTrades}
Wins: ${assetState.totalWins}
Losses: ${assetState.totalLosses}
Win Rate: ${(assetState.winRate * 100).toFixed(1)}%
Profit/Loss: $${assetState.totalProfit.toFixed(2)}

Trading Analysis:
Filtered Array: ${assetState.filteredArray}
Traded Array: ${assetState.tradedDigitArray}
Current Stake: $${this.currentStake.toFixed(2)}

Global Status:
Total P/L: $${this.globalStats.totalProfit.toFixed(2)}
        `;
        
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Multi-Asset Bot - Loss Alert',
            text: summaryText
        };
        
        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending loss email:', error);
        }
    }
    
    // ============ UTILITY FUNCTIONS ============
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // ============ STARTUP ============
    start() {
        console.log(`
        ╔════════════════════════════════════════╗
        ║   🚀 MULTI-ASSET TRADING BOT v2.0     ║
        ╟────────────────────────────────────────╢
        ║ Assets: ${this.assets.length} Volatility Indices         ║
        ║ Max Concurrent: ${this.config.maxConcurrentTrades} trades              ║
        ║ Initial Stake: $${this.config.initialStake.toFixed(2)}                   ║
        ║ Stop Loss: $${this.config.stopLoss.toFixed(2)}                      ║
        ║ Take Profit: $${this.config.takeProfit.toFixed(2)}                   ║
        ╚════════════════════════════════════════╝
        `);
        
        console.log('📊 Trading Assets:');
        this.assets.forEach(asset => console.log(`   • ${asset}`));
        console.log('');
        
        this.connect();
    }
}

// Start the bot
const bot = new MultiAssetDerivTradingBot('DMylfkyce6VyZt7', {
    initialStake: 5,
    multiplier: 21,
    maxConsecutiveLosses: 2,
    stopLoss: 110,
    takeProfit: 10,
    growthRate: 0.05,
    accuTakeProfit: 0.01,
    maxConcurrentTrades: 10,
    requiredHistoryLength: 100,
    minTimeBetweenTrades: 60000,
    assetCooldownPeriod: 60000,
    minWaitTime: 60000,// 1 Minute
    maxWaitTime: 180000,// 30 Minutes
});

bot.start();

module.exports = MultiAssetDerivTradingBot;