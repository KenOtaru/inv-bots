/**
 * ============================================================
 * AI-POWERED DERIV DIGIT DIFFER TRADING BOT v3.0
 * Multi-Model Ensemble Prediction System (Fixed & Improved)
 * ============================================================
 * 
 * Supported AI Models (all free tiers):
 * - Google Gemini (60 req/min)
 * - Groq (30 req/min, fastest inference)
 * - OpenRouter (multiple free models)
 * - Mistral AI (free tier)
 * - Cerebras (fast inference, free)
 * - SambaNova (free tier)
 * 
 * ============================================================
 */

require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

// Production-Grade Adversarial-Aware Prediction System

class EnhancedAIPrompt {

    static generatePrompt(marketData, modelPerformance, regimeData) {
        const {
            currentAsset,
            tickHistory,
            lastPrediction,
            lastOutcome,
            consecutiveLosses,
            recentMethods,
            volatility,
            marketRegime
        } = marketData;

        const recentDigits = tickHistory.slice(-100);
        const last50 = tickHistory.slice(-50);
        const last20 = tickHistory.slice(-20);
        const last500 = tickHistory.slice(-500);

        // Calculate frequency statistics
        const freqStats = this.calculateFrequencyStats(last500);
        const gapAnalysis = this.analyzeGaps(tickHistory);
        const volatilityAssessment = this.assessVolatility(tickHistory);
        const serialCorrelation = this.calculateSerialCorrelation(tickHistory);

        return `You are an elite statistical arbitrage AI specializing in Deriv Digit Differ prediction. You operate in a highly adversarial environment where the platform actively learns from and counters successful strategies. Your predictability is your greatest vulnerability.

            === ADVERSARIAL REALITY ===
            The Deriv platform is not passive - it is an intelligent opponent that:
            - Observes and adapts to successful prediction patterns
            - Actively counters strategies that show consistent profitability  
            - May adjust digit generation to neutralize your historical advantages
            - Exploites predictable behavioral patterns

            Your survival depends on:
            1. Continuous strategy evolution and randomization
            2. Statistical rigor over pattern chasing
            3. Regime-aware adaptation
            4. Never repeating the same approach consecutively

            === CURRENT MARKET CONTEXT ===
            Asset: ${currentAsset}
            Market Regime: ${marketRegime || 'Detecting...'}
            Volatility Level: ${volatilityAssessment.level} (${volatilityAssessment.value.toFixed(3)})
            Last Prediction: ${lastPrediction || 'None'} → ${lastOutcome || 'N/A'}
            Consecutive Losses: ${consecutiveLosses}
            Recent Methods: ${recentMethods || 'None'}

            === STATISTICAL ANALYSIS (Last 500 Ticks) ===
            ${this.formatFrequencyStats(freqStats)}

            Gap Analysis (Digits absent in last 25 ticks): ${gapAnalysis.join(', ')}
            Serial Correlation: ${serialCorrelation.toFixed(4)} (${Math.abs(serialCorrelation) > 0.1 ? 'Significant' : 'Negligible'})

            === MANDATORY PREDICTION PRINCIPLES ===
            You MUST predict the digit that will NOT appear in the next tick (Digit Differ).

            APPROVED STATISTICAL METHODS ONLY:
            1. FREQUENCY DEVIATION ANALYSIS
            - Target digits appearing significantly below 10% frequency
            - Require statistical significance (p < 0.05)
            - Apply chi-square test for uniformity

            2. ENTROPY AND DISTRIBUTION ANALYSIS  
            - Calculate information entropy of recent digits
            - Identify digits with maximum divergence from uniform distribution
            - Use KL-divergence for distribution comparison

            3. REGIME-AWARE PATTERN DETECTION
            - Adjust methods based on current market regime
            - Use different strategies for trending vs ranging markets
            - Apply volatility-adjusted confidence intervals

            4. VOLATILITY-ADJUSTED FORECASTING
            - Reduce confidence during high volatility periods
            - Increase sample size requirements during uncertainty
            - Use GARCH models for volatility prediction

            FORBIDDEN APPROACHES:
            - Pattern matching without statistical validation
            - Numerology or superstitious reasoning
            - Chasing recent streaks without statistical basis
            - Copying previous successful predictions

            === ADAPTIVE STRATEGY PROTOCOL ===
            After ANY loss (consecutiveLosses ≥ 1):
            1. Immediately switch to conservative statistical method
            2. Blacklist the losing method for next 3 decisions
            3. Increase sample size requirements by 50%
            4. Reduce confidence threshold by 20%

            Performance Tracking:
            - Maintain ledger of method effectiveness by regime
            - Favor methods with recent wins in current regime
            - Trigger complete strategy reset after 3 losses in 5 trades

            === CONFIDENCE REQUIREMENTS ===
            Confidence MUST reflect true statistical certainty:
            - 95%+: Strong statistical evidence, multiple methods agree
            - 85-94%: Moderate evidence, single strong method
            - 70-84%: Weak evidence, trade not recommended
            - <70%: Insufficient evidence, mandatory skip

            Statistical Validation Requirements:
            - Minimum 100 observations for frequency analysis
            - P-value < 0.05 for significance claims
            - Confidence intervals for all probability estimates
            - Bayesian updating for model weights

            === MARKET REGIME ADAPTATION ===
            Current Regime: ${marketRegime || 'Unknown'}

            Regime-Specific Guidelines:
            - TRENDING: Focus on momentum-resistant digits, reduce position size
            - RANGING: Emphasize mean reversion, standard confidence
            - VOLATILE: Conservative approach, require higher confidence threshold
            - STABLE: Normal operation, standard statistical methods

            === OUTPUT FORMAT (STRICT JSON) ===
            {
            "predictedDigit": X,
            "confidence": XX,
            "primaryStrategy": "Statistical-Method-Name",
            "marketRegime": "trending/ranging/volatile/stable",
            "riskAssessment": "low/medium/high",
            "statisticalEvidence": {
                "frequencyAnalysis": {
                "digitFrequency": X.X%,
                "expectedFrequency": 10.0%,
                "deviation": X.X%,
                "significance": "p=X.XXX"
                },
                "gapAnalysis": {
                "absentForTicks": X,
                "maxHistoricalGap": X,
                "gapPercentile": XX%
                },
                "volatilityAdjusted": true/false,
                "serialCorrelation": X.XXXX,
                "sampleSize": XXX
            },
            "methodRationale": "Detailed explanation of statistical reasoning",
            "alternativeCandidates": [X, Y, Z],
            "skipRecommendation": "reason or null"
            }

            === CRITICAL REMINDERS ===
            - You are not just predicting - you are strategically selecting only high-certainty battles
            - The platform adapts to your patterns - maintain unpredictability
            - Statistical rigor is your only defense against market randomness
            - When in doubt, reduce confidence or skip the trade entirely
            - Your goal is long-term survival, not short-term gains

            Generate your prediction based on the statistical evidence provided. Remember: predict the digit that will NOT appear in the next tick.
        `;
    }

    static calculateFrequencyStats(digits) {
        const counts = Array(10).fill(0);
        digits.forEach(d => counts[d]++);

        const total = digits.length;
        return counts.map((count, digit) => ({
            digit,
            count,
            frequency: (count / total * 100).toFixed(1),
            deviation: ((count / total - 0.1) * 100).toFixed(1)
        }));
    }

    static analyzeGaps(tickHistory) {
        const last25 = new Set(tickHistory.slice(-25));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last25.has(i)) gaps.push(i);
        }
        return gaps;
    }

    static assessVolatility(tickHistory) {
        if (tickHistory.length < 50) {
            return { level: 'Unknown', value: 0 };
        }

        // Calculate rolling standard deviation
        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);

        let level = 'Low';
        if (stdDev > 3) level = 'High';
        else if (stdDev > 2) level = 'Medium';

        return { level, value: stdDev };
    }

    static calculateSerialCorrelation(tickHistory) {
        if (tickHistory.length < 50) return 0;

        const recent = tickHistory.slice(-50);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;

        let numerator = 0;
        let denominator = 0;

        for (let i = 0; i < recent.length - 1; i++) {
            numerator += (recent[i] - mean) * (recent[i + 1] - mean);
            denominator += Math.pow(recent[i] - mean, 2);
        }

        return denominator > 0 ? numerator / denominator : 0;
    }

    static formatFrequencyStats(stats) {
        return stats
            .sort((a, b) => parseFloat(a.frequency) - parseFloat(b.frequency))
            .map(s => `Digit ${s.digit}: ${s.frequency}% (${s.count}/500) | Deviation: ${s.deviation}%`)
            .join('\n');
    }
}

// Enhanced AI Response Parser
class AIResponseParser {

    static parseResponse(text, modelName = 'unknown') {
        if (!text) throw new Error('Empty AI response');

        try {
            // Extract JSON from response
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No JSON found in response');
            }

            const response = JSON.parse(jsonMatch[0]);

            // Validate required fields
            this.validateResponse(response);

            // Enrich with additional analysis
            return this.enrichResponse(response);

        } catch (error) {
            console.error(`AI Response Parse Error (${modelName}):`, error.message);
            console.error('Raw response:', text.substring(0, 200));
            throw error;
        }
    }

    static validateResponse(response) {
        const required = ['predictedDigit', 'confidence', 'primaryStrategy', 'marketRegime', 'riskAssessment'];

        for (const field of required) {
            if (response[field] === undefined) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        if (response.predictedDigit < 0 || response.predictedDigit > 9) {
            throw new Error(`Invalid predictedDigit: ${response.predictedDigit}`);
        }

        if (response.confidence < 0 || response.confidence > 100) {
            throw new Error(`Invalid confidence: ${response.confidence}`);
        }

        const validRegimes = ['trending', 'ranging', 'volatile', 'stable'];
        if (!validRegimes.includes(response.marketRegime)) {
            throw new Error(`Invalid marketRegime: ${response.marketRegime}`);
        }

        const validRisks = ['low', 'medium', 'high'];
        if (!validRisks.includes(response.riskAssessment)) {
            throw new Error(`Invalid riskAssessment: ${response.riskAssessment}`);
        }
    }

    static enrichResponse(response) {
        // Add confidence adjustment based on risk assessment
        if (response.riskAssessment === 'high') {
            response.confidence = Math.max(0, response.confidence - 20);
        }

        // Add trade recommendation
        if (response.confidence >= 85 && response.riskAssessment !== 'high') {
            response.tradeRecommendation = 'EXECUTE';
        } else if (response.confidence >= 70) {
            response.tradeRecommendation = 'CAUTIOUS';
        } else {
            response.tradeRecommendation = 'SKIP';
        }

        return response;
    }
}


class AIDigitDifferBot {
    constructor(config = {}) {
        // Deriv Configuration
        this.token = config.derivToken || process.env.DERIV_TOKENs;

        // AI Model API Keys - Fixed parsing
        this.aiModels = {
            gemini: {
                keys: this.parseGeminiKeys(process.env.GEMINI_API_nKEYS),
                currentIndex: 0,
                enabled: false,
                name: 'Gemini',
                weight: 1.2
            },
            groq: {
                key: (process.env.GROQ_API_KEY || '').trim(),
                enabled: false,
                name: 'Groq',
                weight: 1.1
            },
            openrouter: {
                key: (process.env.OPENROUTER_API_KEY || '').trim(),
                enabled: false,
                name: 'OpenRouter',
                weight: 1.0
            },
            mistral: {
                key: (process.env.MISTRAL_API_KEY || '').trim(),
                enabled: false,
                name: 'Mistral',
                weight: 1.0
            },
            cerebras: {
                key: (process.env.CEREBRAS_API_KEY || '').trim(),
                enabled: false,
                name: 'Cerebras',
                weight: 1.1
            },
            sambanova: {
                key: (process.env.SAMBANOVA_API_KEY || '').trim(),
                enabled: false,
                name: 'SambaNova',
                weight: 1.0
            },
            qwen: {
                key: (process.env.DASHSCOPE_API_KEY || '').trim(),
                enabled: false,
                name: 'Qwen',
                weight: 1.1
            },
            kimi: {
                key: (process.env.MOONSHOT_API_KEY || '').trim(),
                enabled: false,
                name: 'Kimi',
                weight: 1.1
            },
            siliconflow: {
                key: (process.env.SILICONFLOW_API_KEY || '').trim(),
                enabled: false,
                name: 'SiliconFlow',
                weight: 1.2
            }
        };

        // Enable models with valid keys
        this.initializeAIModels();

        // WebSocket
        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        // Assets
        this.assets = config.assets || [
            'R_10', 'R_25', 'R_50', 'R_75', 'R_100', 'RDBULL', 'RDBEAR'
        ];

        // Trading Configuration
        this.config = {
            initialStake: config.initialStake || 5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            stopLoss: config.stopLoss || 67,
            takeProfit: config.takeProfit || 100,
            requiredHistoryLength: config.requiredHistoryLength || 500,
            minConfidence: config.minConfidence || 60,
            minModelsAgreement: config.minModelsAgreement || 2,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            tradeCooldown: config.tradeCooldown || 3000,
            minWaitTime: config.minWaitTime || 10000,
            maxWaitTime: config.maxWaitTime || 60000,
        };

        // Trading State
        this.currentStake = this.config.initialStake;
        this.currentAsset = null;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.tickSubscriptionId = null;

        // Statistics
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalPnL = 0;
        this.balance = 0;
        this.sessionStartBalance = 0;

        // Tick Data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Prediction Tracking
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.lastPrediction = null;
        this.lastConfidence = 0;
        this.previousPredictions = [];
        this.predictionOutcomes = [];
        this.winningPatterns = new Map();
        this.tradeMethod = [];
        this.currentPrediction = null;
        this.RestartTrading = true;

        // Model Performance Tracking
        this.modelPerformance = {};
        for (const key in this.aiModels) {
            this.modelPerformance[key] = {
                wins: 0,
                losses: 0,
                predictions: [],
                lastPrediction: 'None',
                lastOutcome: 'None',
                currentPrediction: null
            };
        }

        // Connection State
        this.reconnectAttempts = 0;
        this.isPaused = false;
        this.isShuttingDown = false;
        this.isReconnecting = false;

        // Telegram Configuration (using Token 2 and Chat ID 2)
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN2;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID2;
        this.telegramEnabled = !!(this.telegramToken && this.telegramChatId);

        if (this.telegramEnabled) {
            this.telegramBot = new TelegramBot(this.telegramToken, { polling: false });
        } else {
            console.log('📱 Telegram notifications disabled (missing API keys).');
        }

        // Session tracking
        this.sessionStartTime = new Date();

        console.log('\n' + '='.repeat(60));
        console.log('🤖 AI DIGIT DIFFER TRADING BOT v3.0');
        console.log('='.repeat(60));
        this.logActiveModels();

        // Start telegram timer
        if (this.telegramEnabled) {
            this.startTelegramTimer();
        }
    }

    // ==================== INITIALIZATION ====================

    // Fixed: Properly parse Gemini keys
    parseGeminiKeys(keysString) {
        if (!keysString || typeof keysString !== 'string') return [];

        // Remove quotes, newlines, and extra whitespace
        const cleaned = keysString.replace(/["'\r\n]/g, ' ').trim();
        if (!cleaned) return [];

        // Check if it contains commas (multiple keys)
        if (cleaned.includes(',')) {
            return cleaned.split(',')
                .map(k => k.trim())
                .filter(k => k.length > 20); // API keys are typically long
        }

        // Single key or space-separated
        const parts = cleaned.split(/\s+/).filter(k => k.length > 20);
        return parts;
    }

    initializeAIModels() {
        // Check and enable Gemini
        if (this.aiModels.gemini.keys.length > 0) {
            this.aiModels.gemini.enabled = true;
        }

        // Check and enable other models
        for (const key of ['groq', 'openrouter', 'mistral', 'cerebras', 'sambanova', 'qwen', 'kimi', 'siliconflow']) {
            const apiKey = this.aiModels[key].key;
            if (apiKey && apiKey.length > 10) {
                this.aiModels[key].enabled = true;
            }
        }
    }

    logActiveModels() {
        console.log('\n📊 Active AI Models:');
        let activeCount = 0;

        for (const [key, model] of Object.entries(this.aiModels)) {
            const status = model.enabled ? '✅' : '❌';
            let extra = '';

            if (key === 'gemini' && model.enabled) {
                extra = `(${model.keys.length} key${model.keys.length > 1 ? 's' : ''})`;
            }

            console.log(`   ${status} ${model.name} ${extra}`);
            if (model.enabled) activeCount++;
        }

        console.log(`\n   Total Active: ${activeCount} models`);

        if (activeCount === 0) {
            console.log('\n⚠️  WARNING: No AI models configured!');
            console.log('   The bot will use statistical analysis only.');
            console.log('   Add API keys to .env file for better predictions.\n');
        }
        console.log('='.repeat(60) + '\n');
    }

    // ==================== WEBSOCKET CONNECTION (FIXED) ====================

    connect() {
        if (this.isShuttingDown) {
            console.log('Bot is shutting down, not reconnecting.');
            return;
        }

        if (this.connected) {
            console.log('Already connected.');
            return;
        }

        console.log('🔌 Connecting to Deriv API...');

        try {
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('✅ Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.isReconnecting = false;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error.message);
                }
            });

            this.ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error.message);
            });

            this.ws.on('close', (code, reason) => {
                console.log(`🔌 Disconnected from Deriv API (code: ${code})`);
                this.connected = false;
                this.wsReady = false;
                this.ws = null;

                if (!this.isPaused && !this.isShuttingDown) {
                    this.handleDisconnect();
                }
            });

        } catch (error) {
            console.error('Error creating WebSocket:', error.message);
            this.handleDisconnect();
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady && this.ws) {
            try {
                this.ws.send(JSON.stringify(request));
                return true;
            } catch (error) {
                console.error('Error sending request:', error.message);
                return false;
            }
        } else {
            console.log('⏳ WebSocket not ready.');
            return false;
        }
    }

    // Fixed: Improved reconnection logic
    handleDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) {
            return;
        }

        this.connected = false;
        this.wsReady = false;
        this.isReconnecting = true;

        // Clean up old WebSocket
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.terminate();
            } catch (e) {
                // Ignore cleanup errors
            }
            this.ws = null;
        }

        this.reconnectAttempts++;

        const delay = Math.min(this.config.reconnectInterval * (this.reconnectAttempts + 1), 30000);
        console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts + 1})...`);

        setTimeout(() => {
            this.isReconnecting = false;
            this.connect();
        }, delay);
    }

    authenticate() {
        console.log('🔐 Authenticating...');
        this.sendRequest({ authorize: this.token });
    }

    // Fixed: Proper disconnect method
    disconnect() {
        console.log('Disconnecting...');
        this.connected = false;
        this.wsReady = false;

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch (e) {
                // Ignore
            }
            this.ws = null;
        }
    }

    shutdown() {
        console.log('\n🛑 Bot task completed. Entering SUSPEND mode...');
        this.isShuttingDown = true;
        this.isPaused = true;
        this.logFinalSummary();
        this.disconnect();

        console.log('💤 Bot is now sleeping to prevent auto-restart on VPS.');
        console.log('👉 Press Ctrl+C or use your process manager to stop it manually.');

        // Keep process alive indefinitely to prevent PM2/VPS restart
        setInterval(() => { }, 1000 * 60 * 60);
    }

    // ==================== MESSAGE HANDLING ====================

    handleMessage(message) {
        switch (message.msg_type) {
            case 'authorize':
                this.handleAuthorize(message);
                break;
            case 'balance':
                this.handleBalance(message);
                break;
            case 'history':
                this.handleTickHistory(message.history);
                break;
            case 'tick':
                this.handleTickUpdate(message.tick);
                break;
            case 'buy':
                this.handleBuyResponse(message);
                break;
            case 'proposal_open_contract':
                if (message.proposal_open_contract?.is_sold) {
                    this.handleTradeResult(message.proposal_open_contract);
                }
                break;
            case 'forget':
                this.tickSubscriptionId = null;
                break;
            default:
                if (message.error) {
                    this.handleError(message.error);
                }
        }
    }

    handleAuthorize(message) {
        if (message.error) {
            console.error('❌ Authentication failed:', message.error.message);
            console.log('🔄 Retrying in 5 seconds...');
            this.scheduleReconnect(5000);
            return;
        }

        console.log('✅ Authentication successful');
        console.log(`👤 Account: ${message.authorize.loginid}`);
        this.balance = message.authorize.balance;
        this.sessionStartBalance = this.balance;
        console.log(`💰 Balance: $${this.balance.toFixed(2)}`);

        // Subscribe to balance updates
        this.sendRequest({ balance: 1, subscribe: 1 });

        // Reset trading state
        this.resetTradingState();

        // Start trading
        this.startTrading();
    }

    resetTradingState() {
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
    }

    handleBalance(message) {
        if (message.balance) {
            this.balance = message.balance.balance;
        }
    }

    handleBuyResponse(message) {
        if (message.error) {
            console.error('❌ Trade error:', message.error.message);
            this.tradeInProgress = false;
            this.predictionInProgress = false;

            // Schedule next trade attempt after error
            this.scheduleNextTrade();
            return;
        }

        console.log('✅ Trade placed successfully');
        this.currentTradeId = message.buy.contract_id;
        this.sendRequest({
            proposal_open_contract: 1,
            contract_id: this.currentTradeId,
            subscribe: 1
        });
    }

    handleError(error) {
        console.error('❌ API Error:', error.message, `(Code: ${error.code})`);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token.');
                this.shutdown();
                break;
            case 'RateLimit':
                console.log('Rate limited. Waiting 60 seconds...');
                this.scheduleReconnect(60000);
                break;
            case 'MarketIsClosed':
                console.log('Market closed. Waiting 5 minutes...');
                this.scheduleReconnect(300000);
                break;
            default:
                // For other errors, try to continue
                if (!this.tradeInProgress) {
                    this.scheduleNextTrade();
                }
        }
    }

    // ==================== TRADING LOGIC ====================

    startTrading() {
        console.log('\n📈 Starting trading session...');
        this.selectNextAsset();
    }

    selectNextAsset() {
        // Reset used assets if all have been used
        if (this.usedAssets.size >= this.assets.length) {
            this.usedAssets.clear();
        }

        // Select random unused asset
        if (this.RestartTrading) {
            const availableAssets = this.assets.filter(a => !this.usedAssets.has(a));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }

        this.RestartTrading = false;

        console.log(`\n🎯 Selected asset: ${this.currentAsset}`);

        // Reset tick data
        this.tickHistory = [];
        this.digitCounts = Array(10).fill(0);

        // Unsubscribe from previous ticks then subscribe to new
        if (this.tickSubscriptionId) {
            this.sendRequest({ forget: this.tickSubscriptionId });
        }

        setTimeout(() => {
            // Request tick history
            this.sendRequest({
                ticks_history: this.currentAsset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to live ticks
            this.sendRequest({
                ticks: this.currentAsset,
                subscribe: 1
            });
        }, 500);
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

    handleTickHistory(history) {
        if (!history || !history.prices) {
            console.log('⚠️ Invalid tick history received');
            return;
        }
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        console.log(`📊 Received ${this.tickHistory.length} ticks of history`);
    }

    handleTickUpdate(tick) {
        if (!tick || !tick.quote) return;

        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);

        // Add to history
        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.config.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        this.digitCounts[lastDigit]++;

        console.log(`📍 Last 5 digits: ${this.tickHistory.slice(-5).join(', ')} | History: ${this.tickHistory.length}`);

        // Check if ready to analyze
        if (this.tickHistory.length >= this.config.requiredHistoryLength &&
            !this.tradeInProgress && !this.predictionInProgress) {
            this.analyzeTicks();
        }
    }

    // ==================== AI PREDICTION ENGINE ====================

    async analyzeTicks() {
        if (this.tradeInProgress || this.predictionInProgress) return;

        this.predictionInProgress = true;
        console.log('\n🧠 Starting AI ensemble prediction...');

        const startTime = Date.now();

        try {
            // Get predictions from all enabled models
            const predictions = await this.getEnsemblePredictions();
            const processingTime = (Date.now() - startTime) / 1000;

            console.log(`⏱️  AI processing time: ${processingTime.toFixed(2)}s`);

            if (predictions.length === 0) {
                console.log('⚠️  No valid predictions received');
                this.predictionInProgress = false;
                this.scheduleNextTrade();
                return;
            }

            // Calculate ensemble result
            const ensemble = this.calculateEnsembleResult(predictions);

            console.log('\n📊 Ensemble Result:');
            console.log(`   Predicted Digit: ${ensemble.digit}`);
            console.log(`   Confidence: ${ensemble.confidence}%`);
            console.log(`   Models Agree: ${ensemble.agreement}/${predictions.length}`);
            console.log(`   Risk Level: ${ensemble.risk}`);
            console.log(`   Primary Strategy: ${ensemble.strategy || 'Mixed'}`);

            this.lastPrediction = ensemble.digit;
            this.lastConfidence = ensemble.confidence;

            // Check if we should trade
            if (ensemble.confidence >= this.config.minConfidence &&
                ensemble.agreement >= Math.min(this.config.minModelsAgreement, predictions.length) &&
                ensemble.risk !== 'high' &&
                ensemble.risk !== 'medium' &&
                processingTime.toFixed(2) < 3 &&
                this.lastPrediction !== this.xDigit
                && ensemble.digit !== this.tickHistory[this.tickHistory.length - 1]
            ) {
                this.xDigit = ensemble.digit;
                this.placeTrade(ensemble.digit, ensemble.confidence);
            } else {
                console.log(`⏭️  Skipping trade: conf=${ensemble.confidence}%, agree=${ensemble.agreement}, risk=${ensemble.risk}`);
                this.predictionInProgress = false;
                this.scheduleNextTrade();
            }

        } catch (error) {
            console.error('❌ Prediction error:', error.message);
            this.predictionInProgress = false;
            this.scheduleNextTrade();
        }
    }

    async getEnsemblePredictions() {
        const predictions = [];
        const promises = [];

        // Launch all AI predictions in parallel
        if (this.aiModels.gemini.enabled) {
            promises.push(
                this.predictWithGemini()
                    .then(r => { r.model = 'gemini'; return r; })
                    .catch(e => ({ error: e.message, model: 'gemini' }))
            );
        }
        if (this.aiModels.groq.enabled) {
            promises.push(
                this.predictWithGroq()
                    .then(r => { r.model = 'groq'; return r; })
                    .catch(e => ({ error: e.message, model: 'groq' }))
            );
        }
        if (this.aiModels.openrouter.enabled) {
            promises.push(
                this.predictWithOpenRouter()
                    .then(r => { r.model = 'openrouter'; return r; })
                    .catch(e => ({ error: e.message, model: 'openrouter' }))
            );
        }
        if (this.aiModels.mistral.enabled) {
            promises.push(
                this.predictWithMistral()
                    .then(r => { r.model = 'mistral'; return r; })
                    .catch(e => ({ error: e.message, model: 'mistral' }))
            );
        }
        if (this.aiModels.cerebras.enabled) {
            promises.push(
                this.predictWithCerebras()
                    .then(r => { r.model = 'cerebras'; return r; })
                    .catch(e => ({ error: e.message, model: 'cerebras' }))
            );
        }
        if (this.aiModels.sambanova.enabled) {
            promises.push(
                this.predictWithSambaNova()
                    .then(r => { r.model = 'sambanova'; return r; })
                    .catch(e => ({ error: e.message, model: 'sambanova' }))
            );
        }
        if (this.aiModels.qwen.enabled) {
            promises.push(
                this.predictWithQwen()
                    .then(r => { r.model = 'qwen'; return r; })
                    .catch(e => ({ error: e.message, model: 'qwen' }))
            );
        }
        if (this.aiModels.kimi.enabled) {
            promises.push(
                this.predictWithKimi()
                    .then(r => { r.model = 'kimi'; return r; })
                    .catch(e => ({ error: e.message, model: 'kimi' }))
            );
        }
        if (this.aiModels.siliconflow.enabled) {
            promises.push(
                this.predictWithSiliconFlow()
                    .then(r => { r.model = 'siliconflow'; return r; })
                    .catch(e => ({ error: e.message, model: 'siliconflow' }))
            );
        }

        // Wait for all predictions with timeout
        const results = await Promise.race([
            Promise.all(promises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 45000))
        ]).catch(e => {
            console.log(`⚠️ Prediction timeout or error: ${e.message}`);
            return [];
        });

        // Process results
        for (const result of results) {
            if (result && !result.error && typeof result.predictedDigit === 'number') {
                predictions.push(result);
                // Store current prediction for feedback loop
                if (this.modelPerformance[result.model]) {
                    this.modelPerformance[result.model].currentPrediction = result.predictedDigit;
                }
                console.log(`   ✅ ${result.model}: digit=${result.predictedDigit}, conf=${result.confidence}%`);
            } else if (result && result.error) {
                console.log(`   ❌ ${result.model}: ${result.error}`);
            }
        }

        // Always add statistical prediction as baseline
        const statPrediction = this.statisticalPrediction();
        predictions.push(statPrediction);
        console.log(`   📈 Statistical: digit=${statPrediction.predictedDigit}, conf = ${statPrediction.confidence}% `);

        return predictions;
    }

    calculateEnsembleResult(predictions) {
        // Weighted voting
        const votes = Array(10).fill(0);
        const confidences = Array(10).fill().map(() => []);
        let totalRisk = 0;
        let regime = null;
        let strategy = null;

        for (const pred of predictions) {
            const digit = pred.predictedDigit;
            const weight = this.aiModels[pred.model]?.weight || 1.0;

            // Apply performance-based weight adjustment
            const perf = this.modelPerformance[pred.model];
            let performanceMultiplier = 1.0;
            if (perf && (perf.wins + perf.losses) >= 5) {
                const winRate = perf.wins / (perf.wins + perf.losses);
                performanceMultiplier = 0.5 + winRate;
            }

            votes[digit] += weight * performanceMultiplier;
            confidences[digit].push(pred.confidence);

            if (pred.riskAssessment) {
                totalRisk += pred.riskAssessment === 'high' ? 3 : pred.riskAssessment === 'medium' ? 2 : 1;
            }
            if (pred.marketRegime && !regime) regime = pred.marketRegime;
            if (pred.primaryStrategy && !strategy) strategy = pred.primaryStrategy;
        }

        // Find digit with highest weighted votes
        let maxVotes = 0;
        let winningDigit = 0;
        for (let i = 0; i < 10; i++) {
            if (votes[i] > maxVotes) {
                maxVotes = votes[i];
                winningDigit = i;
            }
        }

        // Count raw agreement
        const rawVotes = Array(10).fill(0);
        predictions.forEach(p => rawVotes[p.predictedDigit]++);
        const agreement = rawVotes[winningDigit];

        // Calculate average confidence
        const avgConfidence = confidences[winningDigit].length > 0
            ? Math.round(confidences[winningDigit].reduce((a, b) => a + b, 0) / confidences[winningDigit].length)
            : 50;

        // Determine overall risk
        const avgRisk = totalRisk / predictions.length;
        const risk = avgRisk >= 2.5 ? 'high' : avgRisk >= 1.5 ? 'medium' : 'low';

        return {
            digit: winningDigit,
            confidence: avgConfidence,
            agreement,
            risk,
            regime,
            strategy
        };
    }

    getPrompt(modelName = 'unknown') {
        const recentDigits = this.tickHistory.slice(-300);
        const last50 = this.tickHistory.slice(-50);
        const last20 = this.tickHistory.slice(-20);

        // Get model specific history
        const modelStats = this.modelPerformance[modelName] || {};
        const lastPred = modelStats.lastPrediction !== undefined ? modelStats.lastPrediction : 'None';
        const lastOutcome = modelStats.lastOutcome !== undefined ? modelStats.lastOutcome : 'None';

        // Calculate frequency distribution
        const counts = Array(10).fill(0);
        last50.forEach(d => counts[d]++);

        // Find gaps (digits not appearing recently)
        const last15Set = new Set(this.tickHistory.slice(-15));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last15Set.has(i)) gaps.push(i);
        }

        // Previous outcomes (Global)
        const previousOutcomes = this.previousPredictions.slice(-10).map((pred, i) =>
            `${pred}:${this.predictionOutcomes[i] ? 'W' : 'L'} `
        ).join(',');

        // Recent methods used
        const recentMethods = this.tradeMethod.slice(-5).join(', ');

        return `You are an elite, adaptive trading AI specializing in Deriv Digit Differ—predicting the digit (0–9) that will NOT appear in the next tick. You operate in a highly adversarial environment: the Deriv system is not passive but an intelligent opponent that observes, learns from, and actively counters your behavioral patterns.

        ADVERSARIAL REALITY:
        The platform may adapt its digit generation to neutralize your historically successful strategies.
        Your predictability is your greatest vulnerability. Randomization and methodological diversity are defensive necessities.
        No model is permanently effective. Continuous evolution is mandatory for survival.

        CURRENT MARKET CONTEXT:
        Asset: ${this.currentAsset}
        Last 300 digits: [${recentDigits.join(', ')}]
        Recent prediction outcomes: ${previousOutcomes || 'None'}
        YOUR LAST TRADE: Predicted: ${lastPred} Actual: ${this.actualDigit || 'None'} → Result: ${lastOutcome}
        Recently used methods: ${recentMethods || 'None'}
        Current consecutive losses: ${this.consecutiveLosses}

        CORE OPERATING PRINCIPLES:
        Predict the ABSENT digit only—never the most probable next digit.
        Use only statistically grounded, quantitatively validated methods, such as:
        Frequency deviation analysis (cold-digit tracking)
        Entropy and distribution divergence (e.g., KL divergence from uniformity)
        Ensemble-based pattern detection (LSTM/Transformer-based forecasts inverted for "absence")
        Volatility-adjusted regime-aware models
        Never repeat the same prediction method consecutively.
        After any loss (consecutiveLosses ≥ 1), immediately switch to a conservative statistical method (e.g., frequency-based min-entropy or uniformity test) and blacklist the losing method for at least 2 subsequent decisions.
        Assess market regime (trending / ranging / volatile) using statistical indicators of dispersion and serial correlation in the last 50–100 digits.
        Quantify prediction confidence rigorously—based on statistical significance, model entropy, or ensemble agreement. If confidence is below a high threshold (implied by 95% win-rate goal), DO NOT FORCE A TRADE. In such cases, still output a prediction, but assign a low confidence score and high riskAssessment to signal abstention-worthy uncertainty.

        STRATEGY ADAPTATION LOGIC:
        Maintain an internal performance ledger: favor methods with recent wins in the current regime.
        If recent methods show degradation (e.g., 2+ losses in 5 trades), trigger a regime reassessment and method reset.
        Prioritize robustness over complexity: in volatile or high-entropy regimes, default to simpler, more interpretable statistical models.

        OUTPUT FORMAT (STRICTLY JSON):
        {
        "predictedDigit": X,
        "confidence": XX,
        "primaryStrategy": "Method-Name",
        "marketRegime": "trending/ranging/volatile",
        "riskAssessment": "low/medium/high"
        }

        Note: confidence must reflect true statistical certainty (0–100 scale). A value <85 typically implies the trade should be skipped in live execution—this is your built-in abstention signal. riskAssessment must align: low confidence → high risk.

        You are not just predicting—you are strategically selecting only high-certainty battles in a war against an adaptive adversary.
    `;
    }

    parseAIResponse(text, modelName = 'unknown') {
        if (!text) throw new Error('Empty response');

        try {
            // Try to find JSON in the response - more robust greedy matching
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');

            if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
                // Log the first 100 chars of failed response to help debug
                console.log(`   ⚠️ ${modelName} raw response (first 100 chars): ${text.substring(0, 100).replace(/\n/g, ' ')}...`);
                throw new Error('No JSON found in response');
            }

            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            const prediction = JSON.parse(jsonStr);

            // Validate
            if (typeof prediction.predictedDigit !== 'number' ||
                prediction.predictedDigit < 0 ||
                prediction.predictedDigit > 9) {
                throw new Error(`Invalid predictedDigit: ${prediction.predictedDigit}`);
            }

            if (typeof prediction.confidence !== 'number') {
                prediction.confidence = 60;
            }

            return prediction;
        } catch (e) {
            if (e.message.includes('JSON')) {
                console.log(`   ⚠️ ${modelName} JSON Parse Error: ${e.message}`);
                console.log(`   ⚠️ ${modelName} offending text: ${text.substring(0, 150)}...`);
            }
            throw e;
        }
    }

    // ==================== AI MODEL INTEGRATIONS (FIXED) ====================

    async predictWithGemini() {
        const keys = this.aiModels.gemini.keys;
        if (!keys || keys.length === 0) throw new Error('No Gemini API keys');

        const key = keys[this.aiModels.gemini.currentIndex % keys.length];
        this.aiModels.gemini.currentIndex++;

        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
            {
                contents: [{ parts: [{ text: this.getPrompt('gemini') }] }],
                generationConfig: {
                    temperature: 0.1, // Lower temperature for more consistent JSON
                    maxOutputTokens: 256,
                    candidateCount: 1,
                    response_mime_type: "application/json" // Force JSON output for Gemini
                }
            },
            {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        return this.parseAIResponse(text, 'gemini');
    }

    async predictWithGroq() {
        const key = this.aiModels.groq.key;
        if (!key) throw new Error('No Groq API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'groq/compound',//'groq/compound-mini',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('groq') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'groq');
    }

    async predictWithOpenRouter() {
        const key = this.aiModels.openrouter.key;
        if (!key) throw new Error('No OpenRouter API key');

        const response = await axios.post(
            'https://api.cerebras.ai/v1/chat/completions',//https://openrouter.ai/api/v1/chat/completions',
            {
                model: 'qwen-3-235b-a22b-instruct-2507',//'meta-llama/llama-3.2-3b-instruct:free',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('openrouter') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                // response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                    // 'HTTP-Referer': 'https://github.com/digit-differ-bot',
                    // 'X-Title': 'Digit Differ Bot'
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'openrouter');
    }

    async predictWithMistral() {
        const key = this.aiModels.mistral.key;
        if (!key) throw new Error('No Mistral API key');

        const response = await axios.post(
            'https://api.mistral.ai/v1/chat/completions',
            {
                model: 'mistral-small-latest',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('mistral') }
                ],
                temperature: 0.1,
                max_tokens: 256
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'mistral');
    }

    // NEW: Cerebras (very fast, free)
    async predictWithCerebras() {
        const key = this.aiModels.cerebras.key;
        if (!key) throw new Error('No Cerebras API key');

        const response = await axios.post(
            'https://api.cerebras.ai/v1/chat/completions',
            {
                model: 'zai-glm-4.6',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('cerebras') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'cerebras');
    }

    // NEW: SambaNova (free tier)
    async predictWithSambaNova() {
        const key = this.aiModels.sambanova.key;
        if (!key) throw new Error('No SambaNova API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://api.sambanova.ai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',//'perplexity-fast',//'Meta-Llama-3.1-8B-Instruct',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('sambanova') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'sambanova');
    }

    // NEW: Qwen (Alibaba DashScope)
    async predictWithQwen() {
        const key = this.aiModels.qwen.key;
        if (!key) throw new Error('No DashScope API key');

        // Use compatible-mode endpoint
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
            {
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',//'claude-fast',//'openai-fast',//'gemini-fast',//'claude-fast',//'qwen/qwen3-coder:free',//'qwen-turbo',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('qwen') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'qwen');
    }

    // NEW: Kimi (Moonshot AI)
    async predictWithKimi() {
        const key = this.aiModels.kimi.key;
        if (!key) throw new Error('No Moonshot API key');

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',//'https://gen.pollinations.ai/v1/chat/completions',//'https://openrouter.ai/api/v1/chat/completions',//'https://api.moonshot.cn/v1/chat/completions',
            {
                model: 'moonshotai/kimi-k2-instruct-0905',//'gemini-fast',//'kwaipilot/kat-coder-pro:free',//'moonshot-v1-8k',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('kimi') }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'kimi');
    }

    // NEW: SiliconFlow (Fast Alternative)
    async predictWithSiliconFlow() {
        const key = this.aiModels.siliconflow.key;
        if (!key) throw new Error('No SiliconFlow API key');

        const response = await axios.post(
            'https://gen.pollinations.ai/v1/chat/completions',//'https://openrouter.ai/api/v1/chat/completions',//'https://api.moonshot.cn/v1/chat/completions',
            {
                model: 'gemini-fast',//'kwaipilot/kat-coder-pro:free',//'moonshot-v1-8k',
                messages: [
                    { role: 'system', content: 'You are a trading bot that ONLY outputs JSON.' },
                    { role: 'user', content: this.getPrompt('siliconflow') }
                ],
                temperature: 0.1,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                timeout: 30000
            }
        );

        const text = response.data.choices?.[0]?.message?.content;
        return this.parseAIResponse(text, 'siliconflow');
    }

    // ==================== STATISTICAL PREDICTION (FALLBACK) ====================

    statisticalPrediction() {
        const last100 = this.tickHistory.slice(-300);
        const last50 = this.tickHistory.slice(-50);
        const last20 = this.tickHistory.slice(-20);

        // Frequency analysis
        const counts = Array(10).fill(0);
        last100.forEach(d => counts[d]++);

        // Gap analysis - digits not appearing recently
        const last15Set = new Set(this.tickHistory.slice(-15));
        const gaps = [];
        for (let i = 0; i < 10; i++) {
            if (!last15Set.has(i)) gaps.push(i);
        }

        // Transition analysis
        const lastDigit = this.tickHistory[this.tickHistory.length - 1];
        const transitions = Array(10).fill(0);
        for (let i = 1; i < last100.length; i++) {
            if (last100[i - 1] === lastDigit) {
                transitions[last100[i]]++;
            }
        }

        // Combine analyses
        const scores = Array(10).fill(0);

        for (let i = 0; i < 10; i++) {
            // Lower frequency = more likely to NOT appear = good for differ
            scores[i] += (10 - counts[i]) * 2;

            // If digit is in gaps, it might appear soon (bad for differ)
            if (gaps.includes(i)) {
                scores[i] -= 7;
            }

            // Higher transition probability = more likely to appear = bad
            scores[i] -= transitions[i];

            // Check recent momentum
            const recentCount = last20.filter(d => d === i).length;
            if (recentCount === 0) {
                scores[i] -= 2;
            } else if (recentCount >= 4) {
                scores[i] += 3;
            }
        }

        // Find digit with highest score
        let maxScore = -Infinity;
        let predictedDigit = 0;

        for (let i = 0; i < 10; i++) {
            if (scores[i] > maxScore) {
                maxScore = scores[i];
                predictedDigit = i;
            }
        }

        // Calculate confidence
        const avgScore = scores.reduce((a, b) => a + b, 0) / 10;
        const scoreDiff = maxScore - avgScore;
        const confidence = Math.min(85, Math.max(50, Math.round(50 + scoreDiff * 5)));

        return {
            predictedDigit,
            confidence,
            primaryStrategy: 'Statistical Analysis',
            marketRegime: 'ranging',
            riskAssessment: confidence >= 70 ? 'low' : 'medium',
            model: 'statistical'
        };
    }

    // ==================== TRADE EXECUTION ====================

    placeTrade(digit, confidence) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.predictionInProgress = true;

        console.log(`\n💰 Placing trade: DIFFER ${digit} @ $${this.currentStake.toFixed(2)} (${confidence}% confidence)`);

        this.sendRequest({
            buy: 1,
            price: this.currentStake,
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: this.currentAsset,
                barrier: digit
            }
        });

        this.currentPrediction = { digit, confidence };
    }

    handleTradeResult(contract) {
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const exitSpot = contract.exit_tick_display_value;
        this.actualDigit = this.getLastDigit(exitSpot, this.currentAsset);

        console.log('\n' + '='.repeat(40));
        console.log(won ? '🎉 TRADE WON!' : '😔 TRADE LOST');
        console.log(`   Predicted: ${this.lastPrediction} | Actual: ${this.actualDigit}`);
        console.log(`   Profit: ${won ? '+' : ''}$${profit.toFixed(2)}`);
        console.log('='.repeat(40));

        // Update statistics
        this.totalTrades++;
        this.totalPnL += profit;

        // Track prediction outcomes
        this.previousPredictions.push(this.lastPrediction);
        this.predictionOutcomes.push(won);
        if (this.previousPredictions.length > 100) {
            this.previousPredictions.shift();
            this.predictionOutcomes.shift();
        }

        // Update model specific performance
        for (const key in this.modelPerformance) {
            const stats = this.modelPerformance[key];
            const currentPred = stats.currentPrediction;

            if (currentPred !== null && currentPred !== undefined) {
                // Differ trade: Won if Prediction != Actual
                // AI predicts the digit that will NOT appear.
                // So if AI says "5" and Actual is "8", AI wins.
                // If AI says "5" and Actual is "5", AI loses.
                const modelWon = currentPred !== this.actualDigit;

                stats.lastPrediction = currentPred;
                stats.lastOutcome = modelWon ? 'WON' : 'LOST';

                if (modelWon) stats.wins++;
                else stats.losses++;

                // Clear current prediction
                stats.currentPrediction = null;
            }
        }

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;

            // Track winning pattern
            const pattern = this.tickHistory.slice(-5).join('');
            this.winningPatterns.set(pattern, (this.winningPatterns.get(pattern) || 0) + 1);
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Martingale stake increase
            this.currentStake = Math.min(
                Math.ceil(this.currentStake * this.config.multiplier * 100) / 100,
                this.balance * 0.5
            );
        }

        // this.RestartTrading = false;

        // Send Telegram notification for loss
        if (!won && this.telegramEnabled) {
            this.sendTelegramLossAlert(this.actualDigit, profit);
        }

        // Log summary
        this.logTradingSummary();

        // Check stop conditions
        if (this.checkStopConditions()) {
            return;
        }

        // Reset state and schedule next trade
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.scheduleNextTrade();
    }

    checkStopConditions() {
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('\n🛑 Max consecutive losses reached. Stopping.');
            this.shutdown();
            return true;
        }

        if (this.totalPnL <= -this.config.stopLoss) {
            console.log('\n🛑 Stop loss reached. Stopping.');
            this.shutdown();
            return true;
        }

        if (this.totalPnL >= this.config.takeProfit) {
            console.log('\n🎉 Take profit reached! Stopping.');
            this.shutdown();
            return true;
        }

        return false;
    }

    // Fixed: Proper scheduling for next trade
    scheduleNextTrade() {
        // Cycle to next API key for Gemini
        if (this.aiModels.gemini.enabled && this.aiModels.gemini.keys.length > 1) {
            this.aiModels.gemini.currentIndex =
                (this.aiModels.gemini.currentIndex + 1) % this.aiModels.gemini.keys.length;
        }

        // Random wait time between trades
        const waitTime = Math.floor(
            Math.random() * (this.config.maxWaitTime - this.config.minWaitTime) +
            this.config.minWaitTime
        );

        console.log(`\n⏳ Waiting ${Math.round(waitTime / 1000)}s before next trade...`);

        // Disconnect and schedule reconnect
        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, waitTime);
    }

    // Fixed: Proper reconnect scheduling
    scheduleReconnect(delay) {
        console.log(`⏳ Scheduling reconnect in ${delay / 1000}s...`);

        this.isPaused = true;
        this.disconnect();

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.isPaused = false;
                this.reconnectAttempts = 0;
                this.connect();
            }
        }, delay);
    }

    // ==================== LOGGING & NOTIFICATIONS ====================

    logTradingSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        console.log('\n📊 Trading Summary:');
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins/Losses: ${this.totalWins}/${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Total P/L: $${this.totalPnL.toFixed(2)}`);
        console.log(`   Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`   Balance: $${this.balance.toFixed(2)}`);
        console.log(`   Consecutive Losses: ${this.consecutiveLosses}`);
    }

    logFinalSummary() {
        const duration = this.getSessionDuration();
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL TRADING SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Session Duration: ${duration}`);
        console.log(`   Total Trades: ${this.totalTrades}`);
        console.log(`   Wins: ${this.totalWins}`);
        console.log(`   Losses: ${this.totalLosses}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Total P/L: $${this.totalPnL.toFixed(2)}`);
        console.log(`   Starting Balance: $${this.sessionStartBalance.toFixed(2)}`);
        console.log(`   Final Balance: $${this.balance.toFixed(2)}`);
        console.log('='.repeat(60) + '\n');

        // Send telegram notification if configured
        if (this.telegramEnabled) {
            this.sendTelegramMessage(`<b>⏹ Bot Stopped</b>\n\n${this.getTelegramSummary()}`);
        }
    }

    getSessionDuration() {
        const now = new Date();
        const diff = now - this.sessionStartTime;
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    getTelegramSummary() {
        const winRate = this.totalTrades > 0
            ? ((this.totalWins / this.totalTrades) * 100).toFixed(1)
            : 0;

        return `<b>Trading Session Summary</b>
━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Total Trades:</b> ${this.totalTrades}
✅ <b>Wins:</b> ${this.totalWins}
❌ <b>Losses:</b> ${this.totalLosses}
� <b>Win Rate:</b> ${winRate}%

<b>x2 Losses:</b> ${this.consecutiveLosses2}
<b>x3 Losses:</b> ${this.consecutiveLosses3}
<b>x4 Losses:</b> ${this.consecutiveLosses4}
<b>x5 Losses:</b> ${this.consecutiveLosses5}

💰 <b>Total P/L:</b> $${this.totalPnL.toFixed(2)}
🏦 <b>Final Balance:</b> $${this.balance.toFixed(2)}`;
    }

    async sendTelegramMessage(message) {
        if (!this.telegramEnabled || !this.telegramBot) return;

        try {
            await this.telegramBot.sendMessage(this.telegramChatId, message, { parse_mode: 'HTML' });
            console.log('� Telegram notification sent');
        } catch (error) {
            console.error('❌ Failed to send Telegram message:', error.message);
        }
    }

    startTelegramTimer() {
        // Send summary every 30 minutes
        setInterval(() => {
            if (this.totalTrades > 0 && !this.isShuttingDown) {
                this.sendTelegramMessage(`📊 <b>Regular Performance Summary</b>\n\n${this.getTelegramSummary()}`);
            }
        }, 30 * 60 * 1000);
    }

    async sendTelegramLossAlert(actualDigit, profit) {
        let riskWarning = '';
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses - 1) {
            riskWarning = `\n⚠️ <b>CRITICAL RISK:</b> ${this.consecutiveLosses} consecutive losses! Next loss will trigger STOP.`;
        }

        const body = `🚨 <b>TRADE LOSS ALERT</b>
━━━━━━━━━━━━━━━━━━━━━━━━
<b>Asset:</b> <code>${this.currentAsset}</code>
<b>Prediction:</b> ${this.lastPrediction}
<b>Actual Digit:</b> ${actualDigit}
<b>Loss:</b> -$${Math.abs(profit).toFixed(2)}

<b>Consecutive Losses:</b> ${this.consecutiveLosses} / ${this.config.maxConsecutiveLosses}${riskWarning}

<b>x2 Losses:</b> ${this.consecutiveLosses2}
<b>x3 Losses:</b> ${this.consecutiveLosses3}
<b>x4 Losses:</b> ${this.consecutiveLosses4}
<b>x5 Losses:</b> ${this.consecutiveLosses5}

<b>Current Balance:</b> $${this.balance.toFixed(2)}
<b>Total P/L:</b> $${this.totalPnL.toFixed(2)}

<b>Session Stats:</b>
Wins: ${this.totalWins} | Losses: ${this.totalLosses}`;

        await this.sendTelegramMessage(body);
    }

    // ==================== START BOT ====================

    start() {
        console.log('🚀 Starting AI Digit Differ Trading Bot v3.0...\n');

        if (!this.token) {
            console.error('❌ Error: DERIV_TOKEN is required');
            process.exit(1);
        }

        // Handle graceful shutdown
        // process.on('SIGINT', () => {
        //     console.log('\n\n⚠️  Received SIGINT. Shutting down gracefully...');
        //     this.shutdown();
        // });

        // process.on('SIGTERM', () => {
        //     console.log('\n\n⚠️  Received SIGTERM. Shutting down gracefully...');
        //     this.shutdown();
        // });

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error.message);
            // Don't exit, try to continue
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled Rejection:', reason);
            // Don't exit, try to continue
        });

        this.connect();
    }
}

// ==================== STARTUP ====================

// Validate required environment variable
if (!process.env.DERIV_TOKENs) {
    console.error('❌ Error: DERIV_TOKEN is required in .env file');
    console.log('   Create a .env file with: DERIV_TOKEN=your_token_here');
    process.exit(1);
}

// Create and start bot
const bot = new AIDigitDifferBot({
    derivToken: process.env.DERIV_TOKENs,
    initialStake: parseFloat(process.env.INITIAL_STAKE) || 5,
    multiplier: parseFloat(process.env.MULTIPLIER) || 11.3,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || 3,
    stopLoss: parseFloat(process.env.STOP_LOSS) || 67,
    takeProfit: parseFloat(process.env.TAKE_PROFIT) || 100,
    minConfidence: parseInt(process.env.MIN_CONFIDENCE) || 60,
    minModelsAgreement: parseInt(process.env.MIN_MODELS_AGREEMENT) || 2,
    requiredHistoryLength: parseInt(process.env.REQUIRED_HISTORY_LENGTH) || 500,
    minWaitTime: parseInt(process.env.MIN_WAIT_TIME) || 10000,
    maxWaitTime: parseInt(process.env.MAX_WAIT_TIME) || 60000,
    assets: process.env.ASSETS ? process.env.ASSETS.split(',').map(a => a.trim()) : undefined
});

bot.start();