const WebSocket = require('ws');
const nodemailer = require('nodemailer');


class QuantumInspiredDerivBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_50', 'R_100', 'R_25', 'R_75', 'R_10', 'RDBULL', 'RDBEAR'
            'RDBEAR','R_75', 'R_10',
        ];

        this.config = {
            initialStake: config.initialStake || 3,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            takeProfit: config.takeProfit || 40,
        };

        // Memory limits to prevent crashes
        this.memoryLimits = {
            maxArrayLength: 100,
            maxMapSize: 50,
            maxHistoryLength: this.requiredHistoryLength,
            cleanupInterval: 30000,
            analysisThrottle: 2000,
        };

        // Initialize quantum states with memory management
        this.quantumStates = {};
        this.assets.forEach(asset => {
            this.quantumStates[asset] = this.createAssetState();
        });

        // Global state management
        this.globalConsecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.activeContracts = new Map();
        this.Pause = false;
        this.endOfDay = false;
        this.requiredHistoryLength = 100; // Minimum ticks before trading
        
        // Simplified global adversarial state
        this.globalAdversarial = {
            systemExploits: [],
            successfulStrategies: [],
            failedStrategies: [],
            currentExploit: null
        };

        // Simplified configuration
        this.uniqueConfig = {
            minDataBeforeTrade: 150
        };

        // Adaptive thresholds with exponential moving averages
        this.ema = {
            sampleEntropy: null,
            hurstExponent: null,
            permEntropy: null,
            varianceRatio: null,
            alpha: 0.1 // smoothing factor
        };
        
        // Chaos state tracking
        this.chaosHistory = [];
        this.maxHistoryLength = 20;

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

    createAssetState() {
        return {
            // Standard tracking
            currentStake: this.config.initialStake,
            tickHistory: [],
            tradeInProgress: false,
            currentTradeId: null,
            tickSubscriptionId: null,
            isActive: false,
            lastTradeTime: 0,
            lastAnalysisTime: 0,
            
        };
    }

    // Memory cleanup function
    startMemoryCleanup() {
        setInterval(() => {
            // this.cleanupMemory();
        }, this.memoryLimits.cleanupInterval);
    }

    cleanupMemory() {
        try {
            this.assets.forEach(asset => {
                const state = this.quantumStates[asset];
                
                if (state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                    state.tickHistory = state.tickHistory.slice(-this.memoryLimits.maxHistoryLength);
                }
                
                if (state.patternHistory.length > 50) {
                    state.patternHistory = state.patternHistory.slice(-50);
                }
                
                if (state.breakHistory.length > 50) {
                    state.breakHistory = state.breakHistory.slice(-50);
                }
            });

            if (this.globalAdversarial.successfulStrategies.length > this.memoryLimits.maxArrayLength) {
                this.globalAdversarial.successfulStrategies = 
                    this.globalAdversarial.successfulStrategies.slice(-this.memoryLimits.maxArrayLength);
            }

            if (this.globalAdversarial.failedStrategies.length > this.memoryLimits.maxArrayLength) {
                this.globalAdversarial.failedStrategies = 
                    this.globalAdversarial.failedStrategies.slice(-this.memoryLimits.maxArrayLength);
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
        console.log('\n🚀 QUANTUM TRADING SYSTEM INITIALIZED');
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
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
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
                state.tickHistory = message.history.prices.slice(-this.memoryLimits.maxHistoryLength).map(price => 
                    this.getLastDigit(price, asset)
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
            
            state.tickHistory.push(lastDigit);
            
            // Maintain rolling window
            if (state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                state.tickHistory.shift();
            }

            if (message.subscription && !state.tickSubscriptionId) {
                state.tickSubscriptionId = message.subscription.id;
            }

            if (state.tradeInProgress) {
            console.log(`${asset} Tick: [${state.tickHistory.slice(-10).join(',')}]`);
            } else {
                // console.log(`${asset} Tick: ${tick.quote} (${lastDigit})`);
                // console.log(`${asset} Tick: [${state.tickHistory.slice(-10).join(',')}]`);
            }
            
            // Analyze after sufficient data
            if (!state.tradeInProgress && state.tickHistory.length >= this.uniqueConfig.minDataBeforeTrade) {
                this.analyzeAsset(asset);
            }
        } catch (error) {
            console.error('Tick update error:', error);
        }
    }

    /**
     * Main chaos analysis function
     * Returns comprehensive chaos assessment
     */
    analyzeChaos(asset) {
        const state = this.quantumStates[asset];
        const tickHistory = state.tickHistory.slice(-100); // Use last 100 ticks for analysis
        const minLength = 100;
        if (!tickHistory || tickHistory.length < minLength) {
            return {
                isChaotic: false,
                confidence: 0,
                shouldTrade: false,
                reason: 'Insufficient data',
                metrics: null
            };
        }

        // Use last 300 ticks for analysis (balance between recency and statistical power)
        const data = tickHistory.slice(-Math.min(100, tickHistory.length));

        // Calculate multiple chaos indicators
        const metrics = {
            sampleEntropy: this.calculateSampleEntropy(data),
            hurstExponent: this.calculateHurstExponent(data),
            permutationEntropy: this.calculatePermutationEntropy(data),
            varianceRatio: this.calculateVarianceRatio(data),
            trendStrength: this.calculateTrendStrength(data),
            volatilityRegime: this.detectVolatilityRegime(data)
        };

        // Update exponential moving averages for adaptive thresholds
        this.updateEMA(metrics);

        // Compute chaos score using weighted combination
        const chaosScore = this.computeChaosScore(metrics);

        // Determine if market is chaotic
        const isChaotic = this.isChaotic(metrics, chaosScore);

        // Track chaos state history
        this.updateChaosHistory(isChaotic);

        // Calculate confidence based on consistency
        const confidence = this.calculateConfidence(metrics, chaosScore);

        return {
            isChaotic,
            confidence,
            shouldTrade: !isChaotic && confidence >= 0.4,
            chaosScore,
            metrics,
            consistency: this.getConsistencyScore(),
            reason: this.getReasonString(metrics, isChaotic)
        };
    }

    /**
     * Sample Entropy - measures unpredictability
     * Higher values = more chaotic/random
     * Range: 0 to ~2.5 for this application
     */
    calculateSampleEntropy(data, m = 2, r = null) {
        const N = data.length;
        if (N < 10) return 0;

        // Auto-compute tolerance if not provided (0.2 * std dev)
        if (r === null) {
            const std = Math.sqrt(this.variance(data));
            r = 0.2 * std;
        }

        const matches = (template, maxDist) => {
            let count = 0;
            for (let i = 0; i <= N - template.length; i++) {
                let dist = 0;
                let valid = true;
                for (let j = 0; j < template.length; j++) {
                    dist = Math.max(dist, Math.abs(data[i + j] - template[j]));
                    if (dist > maxDist) {
                        valid = false;
                        break;
                    }
                }
                if (valid) count++;
            }
            return count;
        };

        let A = 0, B = 0;
        const limit = N - m;

        for (let i = 0; i < limit; i++) {
            const templateM = data.slice(i, i + m);
            const templateM1 = data.slice(i, i + m + 1);
            
            const countB = matches(templateM, r);
            const countA = matches(templateM1, r);
            
            if (countB > 1) B += Math.log((countB - 1) / (N - m));
            if (countA > 0) A += Math.log(countA / (N - m));
        }

        const sampEn = -A / limit + B / limit;
        return isFinite(sampEn) && sampEn >= 0 ? sampEn : 0;
    }

    /**
     * Hurst Exponent (R/S method)
     * H < 0.5: Anti-persistent/Mean-reverting (CHAOTIC)
     * H = 0.5: Random walk
     * H > 0.5: Persistent/Trending (PREDICTABLE)
     */
    calculateHurstExponent(data) {
        const N = data.length;
        if (N < 20) return 0.5;

        // Calculate mean
        const mean = data.reduce((a, b) => a + b, 0) / N;

        // Calculate cumulative deviations
        const deviations = [];
        let cumSum = 0;
        for (let i = 0; i < N; i++) {
            cumSum += data[i] - mean;
            deviations.push(cumSum);
        }

        // Calculate range
        const R = Math.max(...deviations) - Math.min(...deviations);

        // Calculate standard deviation
        const S = Math.sqrt(this.variance(data));

        if (S === 0) return 0.5;

        // R/S ratio for different window sizes
        const minWindow = 10;
        const maxWindow = Math.floor(N / 4);
        const windows = [];
        const rs = [];

        for (let w = minWindow; w <= maxWindow; w += Math.max(1, Math.floor((maxWindow - minWindow) / 10))) {
            const numSegments = Math.floor(N / w);
            if (numSegments < 2) continue;

            let rsSum = 0;
            for (let seg = 0; seg < numSegments; seg++) {
                const segment = data.slice(seg * w, (seg + 1) * w);
                const segMean = segment.reduce((a, b) => a + b, 0) / w;
                
                let cumDev = 0;
                const segDevs = [];
                for (let i = 0; i < w; i++) {
                    cumDev += segment[i] - segMean;
                    segDevs.push(cumDev);
                }

                const segR = Math.max(...segDevs) - Math.min(...segDevs);
                const segS = Math.sqrt(this.variance(segment));
                
                if (segS > 0) {
                    rsSum += segR / segS;
                }
            }

            windows.push(Math.log(w));
            rs.push(Math.log(rsSum / numSegments));
        }

        if (windows.length < 3) return 0.5;

        // Linear regression to find Hurst exponent
        const H = this.linearRegression(windows, rs).slope;
        
        // Clamp between 0 and 1
        return Math.max(0, Math.min(1, H));
    }

    /**
     * Permutation Entropy - fast and robust chaos indicator
     * Higher values = more random/chaotic
     * Range: 0 to log(d!)
     */
    calculatePermutationEntropy(data, d = 3, tau = 1) {
        const N = data.length;
        if (N < d * tau + 1) return 0;

        const patterns = new Map();
        
        for (let i = 0; i <= N - d * tau; i++) {
            // Extract pattern
            const indices = [];
            for (let j = 0; j < d; j++) {
                indices.push(data[i + j * tau]);
            }
            
            // Convert to ordinal pattern
            const sorted = indices.map((v, idx) => ({ v, idx }))
                                 .sort((a, b) => a.v - b.v);
            const pattern = sorted.map(x => x.idx).join(',');
            
            patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
        }

        // Calculate entropy
        const total = N - d * tau + 1;
        let entropy = 0;
        for (const count of patterns.values()) {
            const p = count / total;
            entropy -= p * Math.log(p);
        }

        // Normalize by maximum possible entropy
        const maxEntropy = Math.log(this.factorial(d));
        return maxEntropy > 0 ? entropy / maxEntropy : 0;
    }

    /**
     * Variance Ratio Test - detects random walk vs predictable patterns
     * Ratio near 1 = random walk (chaotic)
     * Ratio >> 1 or << 1 = predictable patterns
     */
    calculateVarianceRatio(data, q = 5) {
        const N = data.length;
        if (N < q * 2) return 1;

        // Calculate returns
        const returns = [];
        for (let i = 1; i < N; i++) {
            returns.push(data[i] - data[i - 1]);
        }

        // Variance of 1-period returns
        const var1 = this.variance(returns);
        if (var1 === 0) return 1;

        // Variance of q-period returns
        const qReturns = [];
        for (let i = q; i < N; i++) {
            qReturns.push(data[i] - data[i - q]);
        }
        const varQ = this.variance(qReturns);

        // Variance ratio
        const vr = varQ / (q * var1);
        return isFinite(vr) ? vr : 1;
    }

    /**
     * Trend Strength - measures directional persistence
     * Low values = erratic/chaotic movement
     */
    calculateTrendStrength(data) {
        if (data.length < 10) return 0;

        const window = Math.min(20, Math.floor(data.length / 2));
        const recent = data.slice(-window);

        // Simple linear regression slope
        const indices = Array.from({ length: window }, (_, i) => i);
        const { slope, r2 } = this.linearRegression(indices, recent);

        // Normalize by data range
        const range = Math.max(...recent) - Math.min(...recent);
        const normalizedSlope = range > 0 ? Math.abs(slope) / range : 0;

        // Combine slope magnitude with R²
        return normalizedSlope * r2;
    }

    /**
     * Volatility Regime Detection
     * Returns: 'low', 'medium', 'high', or 'extreme'
     */
    detectVolatilityRegime(data) {
        if (data.length < 20) return 'unknown';

        const window = Math.min(20, data.length);
        const recent = data.slice(-window);

        // Calculate rolling standard deviation
        const std = Math.sqrt(this.variance(recent));
        
        // Calculate coefficient of variation
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const cv = mean !== 0 ? std / Math.abs(mean) : 0;

        if (cv < 0.15) return 'low';
        if (cv < 0.35) return 'medium';
        if (cv < 0.60) return 'high';
        return 'extreme';
    }

    /**
     * Compute overall chaos score (0-1 scale)
     */
    computeChaosScore(metrics) {
        // Normalize each metric to 0-1 chaos scale
        const sampleEntropyScore = Math.min(1, metrics.sampleEntropy / 2.0);
        
        // Invert Hurst: low Hurst = high chaos
        const hurstScore = metrics.hurstExponent < 0.5 
            ? (0.5 - metrics.hurstExponent) * 2 
            : 0;
        
        const permEntropyScore = metrics.permutationEntropy;
        
        // Variance ratio near 1 = chaos
        const vrScore = Math.max(0, 1 - Math.abs(metrics.varianceRatio - 1));
        
        // Low trend strength = chaos
        const trendScore = 1 - Math.min(1, metrics.trendStrength * 2);
        
        // Volatility contribution
        const volScore = {
            'low': 0.2,
            'medium': 0.4,
            'high': 0.7,
            'extreme': 1.0,
            'unknown': 0.5
        }[metrics.volatilityRegime];

        // Weighted combination
        const chaosScore = (
            0.30 * sampleEntropyScore +
            0.25 * hurstScore +
            0.20 * permEntropyScore +
            0.10 * vrScore +
            0.10 * trendScore +
            0.05 * volScore
        );

        return Math.max(0, Math.min(1, chaosScore));
    }

    /**
     * Determine if market is chaotic based on multiple criteria
     */
    isChaotic(metrics, chaosScore) {
        // Primary: Chaos score threshold
        if (chaosScore > 0.70) return true;

        // Secondary: Multiple indicators agreement
        const indicators = [];
        
        // Sample entropy threshold
        indicators.push(metrics.sampleEntropy > 1.5);
        
        // Hurst exponent (anti-persistent)
        indicators.push(metrics.hurstExponent < 0.45);
        
        // Permutation entropy threshold
        indicators.push(metrics.permutationEntropy > 0.85);
        
        // Variance ratio (random walk)
        indicators.push(Math.abs(metrics.varianceRatio - 1) < 0.15);
        
        // Weak or no trend
        indicators.push(metrics.trendStrength < 0.15);
        
        // High/extreme volatility
        indicators.push(['high', 'extreme'].includes(metrics.volatilityRegime));

        // If 4 or more indicators agree on chaos
        const agreeCount = indicators.filter(x => x).length;
        if (agreeCount >= 4) return true;

        // Moderate chaos score with some agreement
        if (chaosScore > 0.60 && agreeCount >= 3) return true;

        return false;
    }

    /**
     * Calculate confidence based on metric consistency
     */
    calculateConfidence(metrics, chaosScore) {
        // Check consistency across metrics
        const normalized = [
            Math.min(1, metrics.sampleEntropy / 2.0),
            metrics.hurstExponent < 0.5 ? (0.5 - metrics.hurstExponent) * 2 : 0,
            metrics.permutationEntropy,
            Math.max(0, 1 - Math.abs(metrics.varianceRatio - 1)),
            1 - Math.min(1, metrics.trendStrength * 2)
        ];

        // Calculate variance of normalized scores
        const mean = normalized.reduce((a, b) => a + b, 0) / normalized.length;
        const variance = normalized.reduce((sum, val) => 
            sum + Math.pow(val - mean, 2), 0) / normalized.length;
        
        // Low variance = high consistency = high confidence
        const consistency = Math.exp(-5 * variance);
        
        // Historical consistency
        const historyConsistency = this.getConsistencyScore();
        
        // Combine current and historical
        return 0.6 * consistency + 0.4 * historyConsistency;
    }

    /**
     * Update exponential moving averages for adaptive thresholds
     */
    updateEMA(metrics) {
        const alpha = this.ema.alpha;
        
        for (const key in metrics) {
            if (typeof metrics[key] === 'number' && isFinite(metrics[key])) {
                if (this.ema[key] === null) {
                    this.ema[key] = metrics[key];
                } else {
                    this.ema[key] = alpha * metrics[key] + (1 - alpha) * this.ema[key];
                }
            }
        }
    }

    /**
     * Track chaos state history
     */
    updateChaosHistory(isChaotic) {
        this.chaosHistory.push(isChaotic ? 1 : 0);
        if (this.chaosHistory.length > this.maxHistoryLength) {
            this.chaosHistory.shift();
        }
    }

    /**
     * Get consistency score from history
     */
    getConsistencyScore() {
        if (this.chaosHistory.length < 5) return 0.5;
        
        const recent = this.chaosHistory.slice(-10);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        
        // Calculate consistency (how close to pure 0 or 1)
        const consistency = 1 - 2 * Math.abs(mean - 0.5);
        return Math.max(0, Math.min(1, consistency));
    }

    /**
     * Get human-readable reason
     */
    getReasonString(metrics, isChaotic) {
        if (!isChaotic) {
            if (metrics.hurstExponent > 0.6 && metrics.trendStrength > 0.3) {
                return 'Strong trend detected - favorable for trading';
            }
            if (metrics.sampleEntropy < 1.0 && metrics.permutationEntropy < 0.7) {
                return 'Regular patterns detected - predictable market';
            }
            return 'Market shows predictable structure';
        } else {
            if (metrics.hurstExponent < 0.4) {
                return 'Anti-persistent behavior - highly chaotic';
            }
            if (metrics.volatilityRegime === 'extreme') {
                return 'Extreme volatility - unpredictable market';
            }
            if (metrics.sampleEntropy > 1.8) {
                return 'High randomness detected - avoid trading';
            }
            return 'Multiple chaos indicators active';
        }
    }

    // ========== UTILITY FUNCTIONS ==========

    variance(data) {
        if (data.length === 0) return 0;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        return data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length;
    }

    linearRegression(x, y) {
        const n = x.length;
        if (n === 0) return { slope: 0, intercept: 0, r2: 0 };

        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = y.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
        const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        // Calculate R²
        const meanY = sumY / n;
        const ssTotal = y.reduce((sum, yi) => sum + Math.pow(yi - meanY, 2), 0);
        const ssResidual = y.reduce((sum, yi, i) => 
            sum + Math.pow(yi - (slope * x[i] + intercept), 2), 0);
        const r2 = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;

        return {
            slope: isFinite(slope) ? slope : 0,
            intercept: isFinite(intercept) ? intercept : 0,
            r2: isFinite(r2) ? Math.max(0, r2) : 0
        };
    }

    factorial(n) {
        if (n <= 1) return 1;
        let result = 1;
        for (let i = 2; i <= n; i++) {
            result *= i;
        }
        return result;
    }


    // Main analysis method for each asset
    async analyzeAsset(asset) {
        const state = this.quantumStates[asset];
        const now = Date.now();
        
        // Throttle analysis
        if (now - state.lastAnalysisTime < this.memoryLimits.analysisThrottle) return;
        state.lastAnalysisTime = now;
        
        // Check conditions
        if (now - state.lastTradeTime < 10000) return; // 10 second cooling
        if (state.tradeInProgress || this.shouldStopTrading()) return;
        
        // Chaos theory application
        const chaosAnalysis = this.analyzeChaos(asset);

        if (!chaosAnalysis || !chaosAnalysis.metrics) {
           console.log('Chaos analysis: insufficient data');
           return;
        }

    console.log(` ${asset} Analysis`);
        // Log comprehensive analysis
    console.log('\n=== CHAOS ANALYSIS ===');
    console.log(`Chaos Score: ${(chaosAnalysis.chaosScore * 100).toFixed(1)}%`);
    console.log(`Market State: ${chaosAnalysis.isChaotic ? '🔴 CHAOTIC' : '🟢 PREDICTABLE'}`);
    // console.log(`Confidence: ${(chaosAnalysis.confidence * 100).toFixed(1)}%`);
    console.log(`Should Trade: ${chaosAnalysis.shouldTrade ? 'YES ✓' : 'NO ✗'}`);
    // console.log(`Reason: ${chaosAnalysis.reason}`);
    // console.log('\nMetrics:');
    // console.log(`  Sample Entropy: ${chaosAnalysis.metrics.sampleEntropy.toFixed(3)}`);
    // console.log(`  Hurst Exponent: ${chaosAnalysis.metrics.hurstExponent.toFixed(3)}`);
    // console.log(`  Perm Entropy: ${chaosAnalysis.metrics.permutationEntropy.toFixed(3)}`);
    // console.log(`  Variance Ratio: ${chaosAnalysis.metrics.varianceRatio.toFixed(3)}`);
    // console.log(`  Trend Strength: ${chaosAnalysis.metrics.trendStrength.toFixed(3)}`);
    // console.log(`  Volatility: ${chaosAnalysis.metrics.volatilityRegime}`);
    console.log('====================\n');

    // Only proceed with trading logic if market is not chaotic
    if (!chaosAnalysis.shouldTrade) {
        console.log('⚠️  Market too chaotic - skipping trade analysis');
        return;
    }

       // Least-occurring digit logic 
    const tickHistory2 = state.tickHistory.slice(-50);
    const digitCounts = Array(10).fill(0);
    tickHistory2.forEach(digit => digitCounts[digit]++);

    let leastOccurringDigit = null;
    let minCount = Infinity;
    digitCounts.forEach((count, digit) => {
        if (count < minCount) {
            minCount = count;
            leastOccurringDigit = digit;
        }
    });

    const leastPercentage = minCount;
    console.log(`Digit counts:`, digitCounts);
    console.log('Least occurring digit:', leastOccurringDigit, `(${minCount} times)`);

    this.lastDigit = tickHistory2[tickHistory2.length - 1];

    if (
        leastPercentage < 7 
        && 
        this.xDigit !== leastOccurringDigit 
        // && 
        // this.xLeastDigit === this.lastDigit 
        // && 
        // this.xLeastDigit !== null
        ) {
        console.log(`\n🎯 ${asset} - SIGNAL DETECTED!`);
        console.log(`\n${asset} Tick: [${state.tickHistory.slice(-10).join(',')}]`);
        state.lastTradeTime = now;
        this.xDigit = leastOccurringDigit;
        this.winProbNumber = leastPercentage;
        this.chaosLevel = (chaosAnalysis.chaosScore * 100).toFixed(1);
        this.kChaos = chaosAnalysis.isChaotic;
         
        this.placeTrade(asset, this.xDigit, this.winProbNumber);
    }
    
    this.xLeastDigit = leastOccurringDigit;
    }


    placeTrade(asset, predictedDigit, winProbability) {
        const state = this.quantumStates[asset];
        
        if (state.tradeInProgress || this.shouldStopTrading()) return;

        state.tradeInProgress = true;
        
        console.log(`💰 ${asset} - EXECUTING TRADE`);
        console.log(`Predicted Digit: ${predictedDigit} (${winProbability}%)`);
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
                
                if (this.globalConsecutiveLosses === 2) {
                    console.log('⚠️ Warning: 2 consecutive losses');
                }
                
                this.sendLossEmail(asset);
            }

            this.totalProfitLoss += profit;
            state.tradeInProgress = false;
            state.currentTradeId = null;

            this.logTradingSummary();

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
                subject: 'mLF Trading Report',
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
                subject: `mLF Loss Alert - ${asset}`,
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
                subject: 'mLF Session Complete',
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    start() {
        console.log('\n🌌 QUANTUM-INSPIRED TRADING BOT 🌌');
        console.log('═══════════════════════════════════');
        console.log('Version: 2.0.0-STABLE');
        console.log('Analysis: Dynamic & Calibrated');
        console.log('═══════════════════════════════════\n');
        
        this.connect();
    }
}

// Initialize and start
const quantumBot = new QuantumInspiredDerivBot('DMylfkyce6VyZt7', {
    initialStake: 1,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    takeProfit: 5
});

// Run with: node --expose-gc --max-old-space-size=2048 bot.js
quantumBot.start();

module.exports = QuantumInspiredDerivBot;