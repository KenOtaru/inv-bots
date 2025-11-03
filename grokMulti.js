const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class MultiAssetVolAccuEdgeBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.wsReady = false;
        
        // Asset configuration with specific volatility thresholds
        this.assetConfigs = {
            // '1HZ10V': { volatilityThreshold: 0.050 },
            // '1HZ25V': { volatilityThreshold: 13.00 },
            // '1HZ50V': { volatilityThreshold: 5.00 },
            // '1HZ75V': { volatilityThreshold: 0.250 },
            // '1HZ100V': { volatilityThreshold: 0.046 },
            'R_10': { volatilityThreshold: 0.0400 },
            'R_25': { volatilityThreshold: 0.0450 },
            'R_50': { volatilityThreshold: 0.0040 },
            'R_75': { volatilityThreshold: 3.0000 },
            'R_100': { volatilityThreshold: 0.0800}
        };
        
        this.assets = Object.keys(this.assetConfigs);
        
        this.config = {
            initialStake: config.initialStake || 1,
            riskPercentage: config.riskPercentage || 0.01,
            maxTicks: config.maxTicks || 12,
            profitTargetPercentage: config.profitTargetPercentage || 0.05,
            growthRate: config.growthRate || 0.05,
            compoundingFactor: config.compoundingFactor || 1.1,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            dailyStopLoss: config.dailyStopLoss || -50,
            dailyTakeProfit: config.dailyTakeProfit || 100,
            maxConcurrentTrades: config.maxConcurrentTrades || 5,
            requiredHistoryLength: config.requiredHistoryLength || 20,
            minTimeBetweenTrades: config.minTimeBetweenTrades || 5000,
            assetCooldownPeriod: config.assetCooldownPeriod || 30000
        };
        
        // Per-Asset State Management
        this.assetStates = {};
        this.initializeAssetStates();
        
        // Global Statistics
        this.globalStats = {
            totalTrades: 0,
            totalWins: 0,
            totalLosses: 0,
            totalProfitLoss: 0,
            dailyProfitLoss: 0,
            activeTrades: 0,
            sessionStartTime: Date.now()
        };
        
        this.currentStake = this.config.initialStake;
        this.accountBalance = 200;
        this.completedAssetsInRound = new Set();
        this.Pause = false;
        this.endOfDay = false;
        this.suspendTradedAsset = false;
        
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
                consecutiveWins: 0,
                currentProposalId: null,
                currentContractId: null,
                lastTradeTime: 0,
                cooldownUntil: 0,
                suspended: false,
                
                // Tick history for volatility calculation
                tickHistory: [],
                tickSubscriptionId: null,
                
                // Dynamic barrier buffer
                barrierBuffer: 1.0,
                
                // Performance tracking
                totalTrades: 0,
                totalWins: 0,
                totalLosses: 0,
                totalProfit: 0,
                winRate: 0,
                
                // Asset-specific volatility threshold
                volatilityThreshold: this.assetConfigs[asset].volatilityThreshold,
                
                // Analysis tracking
                lastAnalysisTime: 0,
                currentVolatility: Infinity
            };
        });
    }
    
    // ============ CONNECTION MANAGEMENT ============
    connect() {
        console.log('🔌 Attempting to connect to Deriv API...');
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
            if (!this.Pause) {
                this.handleDisconnect();
            }
        });
    }
    
    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('⏳ WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.reconnectInterval);
        } else {
            console.error('❌ Not connected. Unable to send request:', request);
        }
    }
    
    authenticate() {
        console.log('🔐 Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        });
    }
    
    // ============ MESSAGE HANDLING ============
    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('❌ Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('✅ Authentication successful');
            this.fetchBalance();
            this.startMultiAssetTrading();
            
        } else if (message.msg_type === 'balance') {
            // Update balance from subscription
            // if (message.balance) {
            //     console.log(`💰 Account Balance: $${this.accountBalance}`);
            // }
            
        } else if (message.msg_type === 'proposal') {
            this.handleProposal(message);
            
        } else if (message.msg_type === 'tick') {
            this.handleTickUpdate(message);
            
        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message);
            
        } else if (message.msg_type === 'buy') {
            this.handleBuyResponse(message);
            
        } else if (message.msg_type === 'proposal_open_contract') {
            this.handleContractUpdate(message);
            
        } else if (message.msg_type === 'forget') {
            console.log('✅ Successfully unsubscribed');
            
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }
    
    fetchBalance() {
        this.sendRequest({
            balance: 1,
            subscribe: 1
        });
    }
    
    // ============ MULTI-ASSET TRADING INITIALIZATION ============
    async startMultiAssetTrading() {
        console.log('🚀 Starting Multi-Asset Volatility Trading...');
        console.log(`📊 Monitoring ${this.assets.length} assets with specific volatility thresholds`);
        
        // Initialize all assets
        for (const asset of this.assets) {
            await this.initializeAsset(asset);
            await this.delay(1000); // Delay between initializations
        }
    }
    
    async initializeAsset(asset) {
        const assetState = this.assetStates[asset];
        console.log(`📈 Initializing ${asset} (Vol Threshold: ${assetState.volatilityThreshold.toFixed(4)})...`);
        
        // Request tick history first
        this.sendRequest({
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        });
        
        // Subscribe to live ticks after a delay
        await this.delay(500);
        this.sendRequest({
            ticks: asset,
            subscribe: 1
        });
    }
    
    // ============ TICK HANDLING ============
    handleTickHistory(message) {
        if (!message.history) return;
        
        const asset = message.echo_req.ticks_history;
        const assetState = this.assetStates[asset];
        
        if (!assetState) return;
        
        const prices = Array.isArray(message.history?.prices) ? message.history.prices : [];
        assetState.tickHistory = prices
            .map(p => Number(p))
            .filter(v => Number.isFinite(v));
            
        console.log(`📊 [${asset}] Received ${assetState.tickHistory.length} historical ticks`);
    }
    
    handleTickUpdate(message) {
        if (!message.tick) return;
        
        const tick = message.tick;
        const asset = tick.symbol;
        const assetState = this.assetStates[asset];
        
        if (!assetState || !Number.isFinite(Number(tick.quote))) {
            return;
        }
        
        const quote = Number(tick.quote);
        
        // Store subscription ID if present
        if (message.subscription?.id) {
            assetState.tickSubscriptionId = message.subscription.id;
        }
        
        // Update tick history
        assetState.tickHistory.push(quote);
        if (assetState.tickHistory.length > this.config.requiredHistoryLength) {
            assetState.tickHistory.shift();
        }
        
        // Calculate current volatility
        assetState.currentVolatility = this.calculateVolatilityForAsset(asset);
        
        // Log tick with volatility info
        const activeTrades = this.globalStats.activeTrades;
        console.log(`[${asset}] Tick: ${quote.toFixed(5)} | Vol: ${assetState.currentVolatility.toFixed(4)} | Threshold: ${assetState.volatilityThreshold} | Active: ${activeTrades}/${this.config.maxConcurrentTrades}`);
        
        // Analyze for trading opportunity
        if (this.shouldAnalyzeAsset(asset)) {
            this.analyzeAssetForEntry(asset);
        }
    }
    
    calculateVolatilityForAsset(asset) {
        const assetState = this.assetStates[asset];
        
        if (assetState.tickHistory.length < this.config.requiredHistoryLength) {
            return Infinity;
        }
        
        const changes = [];
        for (let i = 1; i < assetState.tickHistory.length; i++) {
            const a = assetState.tickHistory[i];
            const b = assetState.tickHistory[i - 1];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            changes.push(Math.abs(a - b));
        }
        
        if (!changes.length) return Infinity;
        
        const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
        const variance = changes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / changes.length;
        return Math.sqrt(variance); // Standard deviation
    }
    
    // ============ TRADING ANALYSIS ============
    shouldAnalyzeAsset(asset) {
        const assetState = this.assetStates[asset];
        const now = Date.now();
        
        // Check if suspended or in cooldown
        if (assetState.suspended || now < assetState.cooldownUntil) {
            return false;
        }
        
        // Check if already trading this asset
        if (assetState.tradeInProgress) {
            return false;
        }
        
        // Check global trade limit
        if (this.globalStats.activeTrades >= this.config.maxConcurrentTrades) {
            return false;
        }
        
        // Check minimum time between analyses
        if (now - assetState.lastAnalysisTime < 2000) {
            return false;
        }
        
        // Check if we have enough history
        if (assetState.tickHistory.length < this.config.requiredHistoryLength) {
            return false;
        }
        
        return true;
    }
    
    analyzeAssetForEntry(asset) {
        const assetState = this.assetStates[asset];
        assetState.lastAnalysisTime = Date.now();
        
        const currentVol = assetState.currentVolatility;
        
        console.log(`🔍 [${asset}] Analyzing: Vol=${currentVol.toFixed(4)}, Threshold=${assetState.volatilityThreshold.toFixed(4)}`);
        
        // Dynamic barrier buffer adjustment based on volatility
        assetState.barrierBuffer = 1.0 + (currentVol * 2);
        assetState.barrierBuffer = Math.min(assetState.barrierBuffer, 2.0);
        
        // Check if volatility is below threshold for this specific asset
        if (currentVol < assetState.volatilityThreshold.toFixed(4)) {
            console.log(`✅ [${asset}] Low volatility detected - Requesting proposal`);
            this.requestProposalForAsset(asset);
        } else {
            console.log(`⏸️ [${asset}] High volatility - Skipping entry`);
        }
    }
    
    requestProposalForAsset(asset) {
        const assetState = this.assetStates[asset];
        
        if (assetState.tradeInProgress) return;
        
        // Calculate dynamic stake
        // assetState.currentStake = Math.max(
        //     this.config.initialStake, 
        //     this.accountBalance * this.config.riskPercentage
        // );
        
        const proposal = {
            proposal: 1,
            amount: this.currentStake.toFixed(2),//assetState.currentStake.toFixed(2),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: 'USD',
            symbol: asset,
            growth_rate: this.config.growthRate,
            limit_order: {
                take_profit: 0.01 //(assetState.currentStake * this.config.profitTargetPercentage).toFixed(2)
            },
            passthrough: { asset } // Track which asset this proposal is for
        };
        
        console.log(`📝 [${asset}] Requesting proposal with stake: $${this.currentStake.toFixed(2)}`);
        this.sendRequest(proposal);
    }
    
    // ============ PROPOSAL HANDLING ============
    handleProposal(response) {
        if (response.error) {
            console.error('❌ Proposal error:', response.error.message);
            return;
        }
        
        // Get asset from passthrough
        const asset = response.echo_req?.passthrough?.asset || response.echo_req?.symbol;
        if (!asset) return;
        
        const assetState = this.assetStates[asset];
        if (!assetState || assetState.tradeInProgress) return;
        
        if (response.proposal) {
            assetState.currentProposalId = response.proposal.id;
            console.log(`📋 [${asset}] Proposal received. Barrier Buffer: ${assetState.barrierBuffer.toFixed(2)}%`);
            
            // Since we already checked volatility, proceed to place trade
            this.placeTrade(asset);
        }
    }
    
    placeTrade(asset) {
        const assetState = this.assetStates[asset];
        
        if (assetState.tradeInProgress || !assetState.currentProposalId) return;
        
        console.log(`
        ╔════════════════════════════════════════╗
        ║        🎯 EXECUTING TRADE              ║
        ╟────────────────────────────────────────╢
        ║ Asset: ${asset.padEnd(32)} ║
        ║ Stake: $${this.currentStake.toFixed(2).padEnd(30)} ║
        ║ Volatility: ${assetState.currentVolatility.toFixed(4).padEnd(27)} ║
        ║ Active Trades: ${this.globalStats.activeTrades}/${this.config.maxConcurrentTrades}                      ║
        ╚════════════════════════════════════════╝
        `);
        
        const request = {
            buy: assetState.currentProposalId,
            price: this.currentStake.toFixed(2) //assetState.currentStake.toFixed(2)
        };
        
        assetState.tradeInProgress = true;
        assetState.lastTradeTime = Date.now();
        this.globalStats.activeTrades++;
        
        this.sendRequest(request);
    }
    
    // ============ BUY RESPONSE HANDLING ============
    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Buy error:', message.error.message);
            
            // Reset the asset that failed to buy
            for (const [asset, state] of Object.entries(this.assetStates)) {
                if (state.tradeInProgress && !state.currentContractId) {
                    state.tradeInProgress = false;
                    state.currentProposalId = null;
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
            console.log(`✅ [${tradedAsset}] Trade placed - Contract ID: ${contractId}`);
            this.subscribeToContract(contractId);
        }
    }
    
    subscribeToContract(contractId) {
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });
    }
    
    // ============ CONTRACT UPDATE HANDLING ============
    handleContractUpdate(message) {
        if (message.error) {
            console.error('❌ Contract update error:', message.error.message);
            return;
        }
        
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
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit || 0);
        
        // Update asset-specific statistics
        assetState.totalTrades++;
        this.globalStats.totalTrades++;
        this.globalStats.dailyProfitLoss += profit;
        this.globalStats.totalProfitLoss += profit;
        this.globalStats.activeTrades--;
        
        if (won) {
            assetState.totalWins++;
            assetState.consecutiveWins++;
            assetState.consecutiveLosses = 0;
            this.globalStats.totalWins++;
            
            // Gentle compounding
            // assetState.currentStake *= this.config.compoundingFactor;
            // assetState.currentStake = Math.min(
            //     assetState.currentStake, 
            //     this.accountBalance * this.config.riskPercentage * 2
            // );
            // assetState.currentStake = this.config.initialStake;
            this.currentStake = this.config.initialStake;
            
            console.log(`✅ [${asset}] Trade WON! Profit: $${profit.toFixed(2)}`);

            // Apply cooldown
            assetState.cooldownUntil = Date.now() + this.config.assetCooldownPeriod;
        } else {
            assetState.totalLosses++;
            assetState.consecutiveLosses++;
            assetState.consecutiveWins = 0;
            this.globalStats.totalLosses++;
            
            // Reset stake after loss
            // assetState.currentStake = this.config.initialStake;
            // assetState.currentStake = Math.ceil(assetState.currentStake * this.config.compoundingFactor * 100) / 100;
            this.currentStake = Math.ceil(this.currentStake * this.config.compoundingFactor * 100) / 100;

            // Apply cooldown
            assetState.cooldownUntil = Date.now() + this.config.assetCooldownPeriod + 300000;
            
            console.log(`❌ [${asset}] Trade LOST! Loss: $${Math.abs(profit).toFixed(2)}`);
            this.sendLossEmail(asset, assetState);
        }
        
        assetState.totalProfit += profit;
        assetState.winRate = assetState.totalWins / assetState.totalTrades;
        
        // Mark as completed in this round
        this.completedAssetsInRound.add(asset);

        if(this.suspendTradedAsset) {
            assetState.suspended = true;
        }
        
        // Reset trading state
        assetState.tradeInProgress = false;
        assetState.currentContractId = null;
        assetState.currentProposalId = null;
        
        // Log results
        this.logTradeResult(asset, won, profit);
        this.logGlobalSummary();
        
        // Update balance
        this.fetchBalance();
        
        // Check stopping conditions
        if (this.checkStoppingConditions()) {
            console.log('🛑 Stopping condition met. Disconnecting...');
            this.endOfDay = true;
            this.Pause = true;
            this.sendDisconnectResumptionEmailSummary();
            this.disconnect();
            return;
        }
        
        // Check for new round
        this.checkForNewRound();
        
        // Continue trading
        setTimeout(() => {
            this.startNextAsset();
        }, this.config.minTimeBetweenTrades);
    }
    
    checkStoppingConditions() {
        // Check consecutive losses across all assets
        const maxConsecutiveLosses = Math.max(
            ...Object.values(this.assetStates).map(s => s.consecutiveLosses)
        );
        
        if (maxConsecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('🛑 Max consecutive losses reached');
            return true;
        }
        
        // Check daily stop loss
        if (this.globalStats.dailyProfitLoss <= this.config.dailyStopLoss) {
            console.log('🛑 Daily stop loss reached');
            return true;
        }
        
        // Check daily take profit
        if (this.globalStats.dailyProfitLoss >= this.config.dailyTakeProfit) {
            console.log('🎯 Daily take profit reached');
            return true;
        }
        
        return false;
    }
    
    checkForNewRound() {
        if (this.completedAssetsInRound.size === this.assets.length) {
            console.log('\n🔄 === All assets traded. Starting new round ===\n');
            this.completedAssetsInRound.clear();
            
            // Resume all assets
            for (const [asset, state] of Object.entries(this.assetStates)) {
                state.suspended = false;
                console.log(`📈 [${asset}] Resumed for trading`);
            }
            
            // Random wait time
            const waitTime = Math.floor(Math.random() * (30000 - 10000 + 1)) + 10000;
            console.log(`⏰ Waiting ${(waitTime / 1000).toFixed(0)} seconds before new round...`);
            
            setTimeout(() => {
                this.startNextAsset();
            }, waitTime);
        }
    }
    
    startNextAsset() {
        const availableAssets = this.getAvailableAssets();
        
        if (availableAssets.length > 0 && 
            this.globalStats.activeTrades < this.config.maxConcurrentTrades) {
            
            const nextAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            console.log(`🔍 Starting analysis for: ${nextAsset}`);
            this.analyzeAssetForEntry(nextAsset);
        }
    }
    
    getAvailableAssets() {
        const now = Date.now();
        return this.assets.filter(asset => {
            const state = this.assetStates[asset];
            return !state.suspended && 
                   !state.tradeInProgress && 
                   now >= state.cooldownUntil &&
                   !this.completedAssetsInRound.has(asset);
        });
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
        ║ Volatility: ${assetState.currentVolatility.toFixed(4).padEnd(27)} ║
        ╚════════════════════════════════════════╝
        `);
    }
    
    logGlobalSummary() {
        const winRate = this.globalStats.totalTrades > 0 ? 
            ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(2) : 0;
        
        console.log('\n=== 🌍 GLOBAL TRADING SUMMARY ===');
        console.log(`📈 Total Trades: ${this.globalStats.totalTrades}`);
        console.log(`✅ Total Wins: ${this.globalStats.totalWins}`);
        console.log(`❌ Total Losses: ${this.globalStats.totalLosses}`);
        console.log(`📊 Win Rate: ${winRate}%`);
        console.log(`💰 Daily P/L: $${this.globalStats.dailyProfitLoss.toFixed(2)}`);
        console.log(`💰 Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}`);
        console.log(`🔥 Active Trades: ${this.globalStats.activeTrades}`);
        console.log(`💼 Account Balance: $${this.accountBalance.toFixed(2)}`);
        
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
                    `P/L: $${state.totalProfit.toFixed(2)} | ` +
                    `Vol: ${state.currentVolatility.toFixed(4)}`
                );
            }
        }
        console.log('=====================================\n');
    }
    
    // ============ ERROR HANDLING ============
    handleApiError(error) {
        console.error('❌ API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token.');
                this.sendErrorEmail('Invalid API token');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting...');
                setTimeout(() => this.startNextAsset(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting...');
                setTimeout(() => this.startNextAsset(), 3600000);
                break;
            default:
                console.log('Non-critical error. Continuing...');
        }
    }
    
    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Reconnecting (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        }
    }
    
    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }
    
    // ============ EMAIL FUNCTIONS ============
    startEmailTimer() {
        setInterval(() => {
            if (!this.endOfDay) {
                this.sendEmailSummary();
            }
        }, 1800000); // 30 minutes
    }
    
    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        let assetDetails = '\n--- Asset Performance ---\n';
        for (const [asset, state] of Object.entries(this.assetStates)) {
            if (state.totalTrades > 0) {
                assetDetails += `
${asset} (Vol Threshold: ${state.volatilityThreshold}):
  Trades: ${state.totalTrades} | Wins: ${state.totalWins} | Losses: ${state.totalLosses}
  Profit: $${state.totalProfit.toFixed(2)} | Win Rate: ${(state.winRate * 100).toFixed(1)}%
  Current Vol: ${state.currentVolatility.toFixed(4)} | Stake: $${state.currentStake.toFixed(2)}
`;
            }
        }
        
        const globalWinRate = this.globalStats.totalTrades > 0 ? 
            ((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(2) : 0;
        
        const summaryText = `
Multi-Asset VolAccuEdge Bot Summary

--- Global Statistics ---
Total Trades: ${this.globalStats.totalTrades}
Total Wins: ${this.globalStats.totalWins}
Total Losses: ${this.globalStats.totalLosses}
Win Rate: ${globalWinRate}%
Daily P/L: $${this.globalStats.dailyProfitLoss.toFixed(2)}
Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}
Account Balance: $${this.accountBalance.toFixed(2)}

${assetDetails}
        `;
        
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Multi-Asset VolAccuEdge Bot - Summary',
            text: summaryText
        };
        
        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
        }
    }
    
    async sendLossEmail(asset, assetState) {
        const transporter = nodemailer.createTransport(this.emailConfig);
        
        const summaryText = `
Loss Alert - ${asset}

Asset: ${asset}
Volatility at Entry: ${assetState.currentVolatility.toFixed(4)}
Volatility Threshold: ${assetState.volatilityThreshold}
Recent Ticks: ${assetState.tickHistory.slice(-5).map(t => t.toFixed(5)).join(', ')}
Consecutive Losses: ${assetState.consecutiveLosses}
Asset P/L: $${assetState.totalProfit.toFixed(2)}
Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}
        `;
        
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Multi-Asset VolAccuEdge Bot - Loss Alert',
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
            subject: 'Multi-Asset VolAccuEdge Bot - Error',
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
Total Trades: ${this.globalStats.totalTrades}
Total Wins: ${this.globalStats.totalWins}
Total Losses: ${this.globalStats.totalLosses}
Daily P/L: $${this.globalStats.dailyProfitLoss.toFixed(2)}
Total P/L: $${this.globalStats.totalProfitLoss.toFixed(2)}
Win Rate: ${((this.globalStats.totalWins / this.globalStats.totalTrades) * 100).toFixed(2)}%
        `;
        
        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'Multi-Asset VolAccuEdge Bot - Disconnect',
            text: summaryText
        };
        
        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending disconnect email:', error);
        }
    }
    
    // ============ UTILITY FUNCTIONS ============
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const hours = now.getHours();
            const minutes = now.getMinutes();
            
            if (this.endOfDay && hours === 11 && minutes >= 0) {
                console.log("Resuming trading at 11:00 AM.");
                this.endOfDay = false;
                this.globalStats.dailyProfitLoss = 0;
                this.Pause = false;
                this.connect();
            }
            
            if (!this.endOfDay && hours >= 17 && minutes >= 0) {
                console.log("Stopping for the day after 5:00 PM.");
                this.endOfDay = true;
                this.sendDisconnectResumptionEmailSummary();
                this.disconnect();
            }
        }, 60000);
    }
    
    // ============ STARTUP ============
    start() {
        console.log(`
        ╔════════════════════════════════════════╗
        ║  🚀 MULTI-ASSET VOLACCUEDGE BOT v2.0  ║
        ╟────────────────────────────────────────╢
        ║ Assets: ${this.assets.length} Volatility Indices         ║
        ║ Max Concurrent: ${this.config.maxConcurrentTrades} trades              ║
        ║ Initial Stake: $${this.config.initialStake.toFixed(2)}                   ║
        ║ Risk %: ${(this.config.riskPercentage * 100).toFixed(1)}%                     ║
        ║ Daily Stop Loss: $${this.config.dailyStopLoss.toFixed(2)}                ║
        ║ Daily Take Profit: $${this.config.dailyTakeProfit.toFixed(2)}              ║
        ╚════════════════════════════════════════╝
        `);
        
        console.log('📊 Trading Assets with Volatility Thresholds:');
        this.assets.forEach(asset => {
            console.log(`   • ${asset}: ${this.assetConfigs[asset].volatilityThreshold.toFixed(4)}`);
        });
        console.log('');
        
        this.connect();
        // this.checkTimeForDisconnectReconnect();
    }
}

// Configuration
const bot = new MultiAssetVolAccuEdgeBot('0P94g4WdSrSrzir', { // Replace with your token
    initialStake: 5,
    riskPercentage: 0.01,
    maxTicks: 12,
    profitTargetPercentage: 0.05, // 5% of stake
    growthRate: 0.05,
    compoundingFactor: 20,
    maxConsecutiveLosses: 5,
    dailyStopLoss: -20,
    dailyTakeProfit: 50,
    maxConcurrentTrades: 5,
    requiredHistoryLength: 20,
    minTimeBetweenTrades: 5000,
    assetCooldownPeriod: 30000
});

bot.start();

module.exports = MultiAssetVolAccuEdgeBot;