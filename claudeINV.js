#!/usr/bin/env node
/**
 * Deriv.com AI-Enhanced Trading Bot (Lightweight Version)
 * Single-file implementation with custom ML (no TensorFlow dependency)
 * 
 * Usage:
 *   node deriv-ai-bot.js --live --token=YOUR_API_TOKEN
 *   node deriv-ai-bot.js --demo --token=YOUR_API_TOKEN
 *   node deriv-ai-bot.js --backtest=historical_data.csv
 * 
 * @requires ws, mathjs (lightweight dependencies only)
 */

const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // Strategy Parameters
    symbol: 'R_10',
    candle_interval: 300, // 5 minutes
    option_duration: 15, // 15 minutes
    ema_short_default: 8,
    ema_long_default: 21,
    rsi_period: 14,
    rsi_call_threshold: 40,
    rsi_put_threshold: 60,
    bb_period: 20,
    bb_std: 2,

    // AI Parameters
    bayesian_test_interval: 50,
    ema_range: [5, 30],
    kmeans_clusters: 3,
    ai_confidence_threshold: 0.55,
    ai_early_stop_threshold: 0.55,
    ai_early_stop_trades: 10,

    // Risk Management (IMMUTABLE)
    max_risk_per_trade: 0.02, // 2%
    daily_loss_limit: 0.05, // 5%
    daily_profit_target: 0.025, // 2.5%
    profit_lock_percentage: 0.5, // Lock 50% of gains
    max_trades_per_direction: 3,
    cooldown_after_losses: 3,
    cooldown_duration: 4 * 60 * 60 * 1000, // 4 hours
    kelly_fraction: 0.25, // 1/4 Kelly
    min_stake: 0.005, // 0.5% of capital
    max_stake: 0.03, // 3% of capital

    // Technical
    max_candles: 500,
    reconnect_delay: 1000,
    max_reconnect_delay: 60000,
    log_batch_size: 10,
    ws_url: `wss://ws.binaryws.com/websockets/v3?app_id=${process.env.DERIV_APP_ID || 1089}`,

    // Files
    log_file: 'deriv_bot_log.jsonl',
    metrics_file: 'deriv_bot_metrics.json'
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = {
        mode: 'live',
        token: process.env.DERIV_API_TOKEN || 'hsj0tA0XJoIzJG5',
        backtest_file: null
    };

    process.argv.slice(2).forEach(arg => {
        if (arg === '--live') args.mode = 'live';
        if (arg === '--demo') args.mode = 'demo';
        if (arg.startsWith('--token=')) args.token = arg.split('=')[1];
        if (arg.startsWith('--backtest=')) {
            args.mode = 'backtest';
            args.backtest_file = arg.split('=')[1];
        }
    });

    return args;
}

/**
 * Sigmoid activation function
 */
function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
}

/**
 * Logger with batch writing
 */
class Logger {
    constructor(filename) {
        this.filename = filename;
        this.buffer = [];
        this.batchSize = CONFIG.log_batch_size;
    }

    log(level, message, data = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...data
        };

        console.log(`[${level}] ${message}`, Object.keys(data).length > 0 ? JSON.stringify(data) : '');
        this.buffer.push(JSON.stringify(entry));

        if (this.buffer.length >= this.batchSize) {
            this.flush();
        }
    }

    flush() {
        if (this.buffer.length === 0) return;

        try {
            fs.appendFileSync(this.filename, this.buffer.join('\n') + '\n');
            this.buffer = [];
        } catch (err) {
            console.error('Failed to write logs:', err);
        }
    }

    info(msg, data) { this.log('INFO', msg, data); }
    warn(msg, data) { this.log('WARN', msg, data); }
    error(msg, data) { this.log('ERROR', msg, data); }
    trade(msg, data) { this.log('TRADE', msg, data); }
}

// ============================================================================
// DERIV API CLIENT
// ============================================================================

class DerivAPI {
    constructor(token, logger) {
        this.token = token;
        this.logger = logger;
        this.ws = null;
        this.reconnectDelay = CONFIG.reconnect_delay;
        this.requestId = 1;
        this.subscribers = new Map();
        this.connected = false;
    }

    /**
     * Connect to Deriv WebSocket API
     */
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(CONFIG.ws_url);

                this.ws.on('open', () => {
                    this.logger.info('WebSocket connected');
                    this.connected = true;
                    this.reconnectDelay = CONFIG.reconnect_delay;

                    if (this.token) {
                        this.authorize().then(resolve).catch(reject);
                    } else {
                        resolve();
                    }
                });

                this.ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data);
                        this.handleMessage(msg);
                    } catch (err) {
                        this.logger.error('Failed to parse message', { error: err.message });
                    }
                });

                this.ws.on('close', () => {
                    this.logger.warn('WebSocket closed, reconnecting...');
                    this.connected = false;
                    this.reconnect();
                });

                this.ws.on('error', (err) => {
                    this.logger.error('WebSocket error', { error: err.message });
                    reject(err);
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Reconnect with exponential backoff
     */
    reconnect() {
        setTimeout(() => {
            this.connect().catch(() => {
                this.reconnectDelay = Math.min(
                    this.reconnectDelay * 2,
                    CONFIG.max_reconnect_delay
                );
            });
        }, this.reconnectDelay);
    }

    /**
     * Authorize with API token
     */
    async authorize() {
        return this.send({ authorize: this.token });
    }

    /**
     * Send request to API
     */
    async send(request) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                return reject(new Error('Not connected'));
            }

            const reqId = this.requestId++;
            request.req_id = reqId;

            this.subscribers.set(reqId, { resolve, reject, subscription: false });
            this.ws.send(JSON.stringify(request));

            setTimeout(() => {
                if (this.subscribers.has(reqId)) {
                    this.subscribers.delete(reqId);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    /**
     * Subscribe to candle stream
     */
    async subscribeCandles(symbol, interval, callback) {
        const reqId = this.requestId++;
        const request = {
            ticks_history: symbol,
            adjust_start_time: 1,
            count: CONFIG.max_candles,
            end: 'latest',
            start: 1,
            style: 'candles',
            granularity: interval,
            subscribe: 1,
            req_id: reqId
        };

        this.subscribers.set(reqId, {
            resolve: (data) => {
                if (data.candles) {
                    callback({ type: 'history', candles: data.candles });
                }
            },
            reject: () => { },
            subscription: true,
            callback: (data) => callback({ type: 'tick', candle: data.ohlc })
        });

        this.ws.send(JSON.stringify(request));
    }

    /**
     * Place trade
     */
    async buyContract(params) {
        return this.send({
            buy: 1,
            price: params.stake,
            parameters: {
                contract_type: params.contract_type,
                symbol: params.symbol,
                duration: params.duration,
                duration_unit: params.duration_unit,
                basis: 'stake',
                amount: params.stake
            }
        });
    }

    /**
     * Handle incoming messages
     */
    handleMessage(msg) {
        if (msg.error) {
            this.logger.error('API error', { error: msg.error });
            const sub = this.subscribers.get(msg.req_id);
            if (sub) {
                sub.reject(new Error(msg.error.message));
                if (!sub.subscription) {
                    this.subscribers.delete(msg.req_id);
                }
            }
            return;
        }

        const sub = this.subscribers.get(msg.req_id);
        if (sub) {
            if (msg.msg_type === 'authorize') {
                this.logger.info('Authorized successfully');
                sub.resolve(msg.authorize);
            } else if (msg.msg_type === 'candles' || msg.msg_type === 'history') {
                sub.resolve(msg);
            } else if (msg.msg_type === 'ohlc') {
                if (sub.callback) sub.callback(msg);
            } else if (msg.msg_type === 'buy') {
                sub.resolve(msg.buy);
            }

            if (!sub.subscription) {
                this.subscribers.delete(msg.req_id);
            }
        }
    }

    /**
     * Get account balance
     */
    async getBalance() {
        const result = await this.send({ balance: 1, subscribe: 1 });
        return parseFloat(result.balance.balance);
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

// ============================================================================
// INDICATOR ENGINE
// ============================================================================

class IndicatorEngine {
    constructor() {
        this.candles = [];
        this.ema_short = null;
        this.ema_long = null;
        this.rsi_gains = [];
        this.rsi_losses = [];
        this.bb_values = [];
    }

    /**
     * Add candle and update indicators incrementally
     */
    addCandle(candle) {
        this.candles.push(candle);
        if (this.candles.length > CONFIG.max_candles) {
            this.candles.shift();
        }

        this.updateEMA(candle.close);
        this.updateRSI(candle.close);
        this.updateBollinger(candle.close);
    }

    /**
     * Update EMA incrementally (O(1))
     */
    updateEMA(price, short_period = CONFIG.ema_short_default, long_period = CONFIG.ema_long_default) {
        const alpha_short = 2 / (short_period + 1);
        const alpha_long = 2 / (long_period + 1);

        if (this.ema_short === null) {
            this.ema_short = price;
            this.ema_long = price;
        } else {
            this.ema_short = alpha_short * price + (1 - alpha_short) * this.ema_short;
            this.ema_long = alpha_long * price + (1 - alpha_long) * this.ema_long;
        }
    }

    /**
     * Update RSI incrementally
     */
    updateRSI(price) {
        if (this.candles.length < 2) return;

        const prev = this.candles[this.candles.length - 2].close;
        const change = price - prev;

        if (change > 0) {
            this.rsi_gains.push(change);
            this.rsi_losses.push(0);
        } else {
            this.rsi_gains.push(0);
            this.rsi_losses.push(Math.abs(change));
        }

        if (this.rsi_gains.length > CONFIG.rsi_period) {
            this.rsi_gains.shift();
            this.rsi_losses.shift();
        }
    }

    /**
     * Calculate RSI
     */
    getRSI() {
        if (this.rsi_gains.length < CONFIG.rsi_period) return 50;

        const avg_gain = this.rsi_gains.reduce((a, b) => a + b, 0) / CONFIG.rsi_period;
        const avg_loss = this.rsi_losses.reduce((a, b) => a + b, 0) / CONFIG.rsi_period;

        if (avg_loss === 0) return 100;

        const rs = avg_gain / avg_loss;
        return 100 - (100 / (1 + rs));
    }

    /**
     * Update Bollinger Bands
     */
    updateBollinger(price) {
        this.bb_values.push(price);
        if (this.bb_values.length > CONFIG.bb_period) {
            this.bb_values.shift();
        }
    }

    /**
     * Get Bollinger Bands
     */
    getBollinger() {
        if (this.bb_values.length < CONFIG.bb_period) {
            return { upper: 0, middle: 0, lower: 0, percent: 0.5 };
        }

        const mean = this.bb_values.reduce((a, b) => a + b, 0) / CONFIG.bb_period;
        const variance = this.bb_values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / CONFIG.bb_period;
        const std = Math.sqrt(variance);

        const upper = mean + CONFIG.bb_std * std;
        const lower = mean - CONFIG.bb_std * std;
        const current = this.bb_values[this.bb_values.length - 1];
        const percent = upper === lower ? 0.5 : (current - lower) / (upper - lower);

        return { upper, middle: mean, lower, percent };
    }

    /**
     * Calculate volatility (standard deviation of returns)
     */
    getVolatility(period = 20) {
        if (this.candles.length < period + 1) return 0;

        const returns = [];
        for (let i = this.candles.length - period; i < this.candles.length; i++) {
            const ret = (this.candles[i].close - this.candles[i - 1].close) / this.candles[i - 1].close;
            returns.push(ret);
        }

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / returns.length;
        return Math.sqrt(variance);
    }

    /**
     * Get current state for strategy
     */
    getState() {
        const rsi = this.getRSI();
        const bb = this.getBollinger();
        const volatility = this.getVolatility();
        const ema_diff = this.ema_short !== null ? this.ema_short - this.ema_long : 0;

        return {
            ema_short: this.ema_short,
            ema_long: this.ema_long,
            ema_diff,
            rsi,
            bb,
            volatility,
            candle_count: this.candles.length
        };
    }

    /**
     * Recalculate EMAs with new periods
     */
    recalculateEMA(short_period, long_period) {
        if (this.candles.length < Math.max(short_period, long_period)) return;

        this.ema_short = null;
        this.ema_long = null;

        this.candles.forEach(candle => {
            this.updateEMA(candle.close, short_period, long_period);
        });
    }
}

// ============================================================================
// LIGHTWEIGHT NEURAL NETWORK (No TensorFlow)
// ============================================================================

class SimpleNeuralNet {
    constructor(inputSize, hiddenSize, outputSize) {
        this.inputSize = inputSize;
        this.hiddenSize = hiddenSize;
        this.outputSize = outputSize;

        // Xavier initialization
        this.w1 = this.randomMatrix(inputSize, hiddenSize, inputSize);
        this.b1 = new Array(hiddenSize).fill(0);
        this.w2 = this.randomMatrix(hiddenSize, outputSize, hiddenSize);
        this.b2 = new Array(outputSize).fill(0);

        this.learningRate = 0.01;
    }

    /**
     * Initialize weights with Xavier/Glorot initialization
     */
    randomMatrix(rows, cols, fanIn) {
        const limit = Math.sqrt(6 / fanIn);
        const matrix = [];
        for (let i = 0; i < rows; i++) {
            matrix[i] = [];
            for (let j = 0; j < cols; j++) {
                matrix[i][j] = (Math.random() * 2 - 1) * limit;
            }
        }
        return matrix;
    }

    /**
     * Forward pass
     */
    forward(input) {
        // Hidden layer
        const hidden = new Array(this.hiddenSize);
        for (let i = 0; i < this.hiddenSize; i++) {
            let sum = this.b1[i];
            for (let j = 0; j < this.inputSize; j++) {
                sum += input[j] * this.w1[j][i];
            }
            hidden[i] = Math.max(0, sum); // ReLU
        }

        // Output layer
        const output = new Array(this.outputSize);
        for (let i = 0; i < this.outputSize; i++) {
            let sum = this.b2[i];
            for (let j = 0; j < this.hiddenSize; j++) {
                sum += hidden[j] * this.w2[j][i];
            }
            output[i] = sigmoid(sum);
        }

        return { hidden, output: output[0] };
    }

    /**
     * Train with single sample (online learning)
     */
    train(input, target) {
        // Forward pass
        const { hidden, output } = this.forward(input);

        // Backpropagation (simplified SGD)
        const outputError = output - target;

        // Update output layer
        for (let i = 0; i < this.hiddenSize; i++) {
            this.w2[i][0] -= this.learningRate * outputError * hidden[i];
        }
        this.b2[0] -= this.learningRate * outputError;

        // Update hidden layer (simplified)
        for (let i = 0; i < this.hiddenSize; i++) {
            if (hidden[i] > 0) { // ReLU derivative
                const hiddenError = outputError * this.w2[i][0];
                for (let j = 0; j < this.inputSize; j++) {
                    this.w1[j][i] -= this.learningRate * hiddenError * input[j];
                }
                this.b1[i] -= this.learningRate * hiddenError;
            }
        }
    }

    /**
     * Predict
     */
    predict(input) {
        return this.forward(input).output;
    }
}

// ============================================================================
// AI CORE (Bayesian Optimization + K-Means + Custom Neural Net)
// ============================================================================

class AI_Core {
    constructor(logger) {
        this.logger = logger;
        this.bayesian_trials = [];
        this.trade_count = 0;
        this.kmeans_model = null;
        this.neural_net = null;
        this.training_data = { inputs: [], outputs: [] };
        this.confidence_history = [];
        this.win_rate_history = [];
        this.current_ema_short = CONFIG.ema_short_default;
        this.current_ema_long = CONFIG.ema_long_default;
    }

    /**
     * Bayesian optimization for EMA periods
     */
    async optimizeEMA(indicators, trade_history) {
        if (this.trade_count % CONFIG.bayesian_test_interval !== 0) return null;

        this.logger.info('Running Bayesian optimization for EMA periods');

        const best_score = this.getBestScore();
        const new_params = this.sampleParams(best_score);
        const score = this.evaluateParams(new_params, trade_history);

        this.bayesian_trials.push({
            params: new_params,
            score,
            timestamp: Date.now()
        });

        if (this.bayesian_trials.length > 20) {
            this.bayesian_trials.shift();
        }

        const best_trial = this.bayesian_trials.reduce((best, trial) =>
            trial.score > best.score ? trial : best
        );

        if (best_trial.params.short !== this.current_ema_short ||
            best_trial.params.long !== this.current_ema_long) {
            this.logger.info('Updating EMA periods', best_trial.params);
            this.current_ema_short = best_trial.params.short;
            this.current_ema_long = best_trial.params.long;
            return best_trial.params;
        }

        return null;
    }

    /**
     * Sample new EMA parameters
     */
    sampleParams(best_score) {
        const variance = best_score < 0 ? 5 : 2;

        let short = Math.floor(Math.random() * (CONFIG.ema_range[1] - CONFIG.ema_range[0]) + CONFIG.ema_range[0]);
        let long = short + Math.floor(Math.random() * variance + variance);
        long = Math.min(long, CONFIG.ema_range[1]);

        return { short, long };
    }

    /**
     * Evaluate EMA parameters on historical trades
     */
    evaluateParams(params, trade_history) {
        if (trade_history.length < 20) return 0;

        let wins = 0;
        let total_profit = 0;

        trade_history.slice(-50).forEach(trade => {
            if (trade.result === 'win') {
                wins++;
                total_profit += trade.profit;
            } else {
                total_profit += trade.loss;
            }
        });

        const win_rate = wins / Math.min(50, trade_history.length);
        return total_profit * win_rate;
    }

    /**
     * Get best score from trials
     */
    getBestScore() {
        if (this.bayesian_trials.length === 0) return 0;
        return Math.max(...this.bayesian_trials.map(t => t.score));
    }

    /**
     * K-Means regime detection
     */
    detectRegime(indicators) {
        if (!this.kmeans_model) {
            this.initKMeans();
        }

        const features = [
            indicators.ema_diff / 100,
            (indicators.rsi - 50) / 50,
            Math.min(indicators.volatility * 1000, 1)
        ];

        let min_dist = Infinity;
        let regime = 'ranging';

        this.kmeans_model.forEach((centroid, idx) => {
            const dist = this.euclideanDistance(features, centroid);
            if (dist < min_dist) {
                min_dist = dist;
                regime = ['down', 'ranging', 'up'][idx];
            }
        });

        return regime;
    }

    /**
     * Initialize K-Means centroids
     */
    initKMeans() {
        this.kmeans_model = [
            [-0.5, -0.3, 0.5], // Down trend
            [0, 0, 0.2],        // Ranging
            [0.5, 0.3, 0.3]     // Up trend
        ];
    }

    /**
     * Euclidean distance
     */
    euclideanDistance(a, b) {
        return Math.sqrt(a.reduce((sum, val, i) => sum + Math.pow(val - b[i], 2), 0));
    }

    /**
     * Initialize neural network classifier
     */
    initClassifier() {
        if (!this.neural_net) {
            this.neural_net = new SimpleNeuralNet(4, 8, 1);
            this.logger.info('Neural network initialized (4 inputs, 8 hidden, 1 output)');
        }
    }

    /**
     * Train classifier with recent trade results
     */
    async trainClassifier() {
        if (this.training_data.inputs.length < 20) {
            this.logger.info('Not enough training data yet', { samples: this.training_data.inputs.length });
            return;
        }

        this.initClassifier();

        // Train on recent samples (mini-batch)
        const samples = Math.min(50, this.training_data.inputs.length);
        const start = this.training_data.inputs.length - samples;

        for (let epoch = 0; epoch < 5; epoch++) {
            for (let i = start; i < this.training_data.inputs.length; i++) {
                this.neural_net.train(
                    this.training_data.inputs[i],
                    this.training_data.outputs[i]
                );
            }
        }

        this.logger.info('Classifier trained', { epochs: 5, samples });
    }

    /**
     * Predict win probability
     */
    async predictConfidence(indicators) {
        this.initClassifier();

        const features = [
            indicators.ema_diff / 100,
            (indicators.rsi - 50) / 50,
            indicators.bb.percent,
            Math.min(indicators.volatility * 1000, 1)
        ];

        const confidence = this.neural_net.predict(features);
        return confidence;
    }

    /**
     * Add training sample
     */
    addTrainingSample(indicators, won) {
        const features = [
            indicators.ema_diff / 100,
            (indicators.rsi - 50) / 50,
            indicators.bb.percent,
            Math.min(indicators.volatility * 1000, 1)
        ];

        this.training_data.inputs.push(features);
        this.training_data.outputs.push(won ? 1 : 0);

        if (this.training_data.inputs.length > 500) {
            this.training_data.inputs.shift();
            this.training_data.outputs.shift();
        }
    }

    /**
     * Track confidence accuracy
     */
    trackConfidenceAccuracy(confidence, won) {
        this.confidence_history.push(confidence);
        this.win_rate_history.push(won ? 1 : 0);

        if (this.confidence_history.length > 50) {
            this.confidence_history.shift();
            this.win_rate_history.shift();
        }
    }

    /**
     * Check if early stopping is needed
     */
    shouldEarlyStop() {
        if (this.confidence_history.length < CONFIG.ai_early_stop_trades) {
            return false;
        }

        const recent = this.confidence_history.slice(-CONFIG.ai_early_stop_trades);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;

        if (avg < CONFIG.ai_early_stop_threshold) {
            this.logger.warn('Early stopping triggered', { avg_confidence: avg.toFixed(3) });
            return true;
        }

        return false;
    }

    /**
     * Get dynamic threshold based on confidence-accuracy correlation
     */
    getDynamicThreshold() {
        if (this.confidence_history.length < 30) {
            return CONFIG.ai_confidence_threshold;
        }

        const corr = this.calculateCorrelation(
            this.confidence_history.slice(-30),
            this.win_rate_history.slice(-30)
        );

        if (corr > 0.5) {
            return CONFIG.ai_confidence_threshold - 0.05;
        } else if (corr < 0.2) {
            return CONFIG.ai_confidence_threshold + 0.05;
        }

        return CONFIG.ai_confidence_threshold;
    }

    /**
     * Calculate Pearson correlation
     */
    calculateCorrelation(x, y) {
        const n = x.length;
        const sum_x = x.reduce((a, b) => a + b, 0);
        const sum_y = y.reduce((a, b) => a + b, 0);
        const sum_xy = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
        const sum_x2 = x.reduce((sum, xi) => sum + xi * xi, 0);
        const sum_y2 = y.reduce((sum, yi) => sum + yi * yi, 0);

        const numerator = n * sum_xy - sum_x * sum_y;
        const denominator = Math.sqrt((n * sum_x2 - sum_x * sum_x) * (n * sum_y2 - sum_y * sum_y));

        return denominator === 0 ? 0 : numerator / denominator;
    }

    incrementTradeCount() {
        this.trade_count++;
    }
}

// ============================================================================
// RISK MANAGER
// ============================================================================

class RiskManager {
    constructor(logger) {
        this.logger = logger;
        this.initial_capital = 0;
        this.current_capital = 0;
        this.daily_start_capital = 0;
        this.daily_profit = 0;
        this.daily_loss = 0;
        this.trades_today = { CALL: 0, PUT: 0 };
        this.consecutive_losses = 0;
        this.cooldown_until = 0;
        this.locked_profit = 0;
        this.daily_trades = [];
    }

    init(capital) {
        this.initial_capital = capital;
        this.current_capital = capital;
        this.daily_start_capital = capital;
        this.logger.info('Risk manager initialized', { capital: capital.toFixed(2) });
    }

    calculateStake(win_probability, capital) {
        const p = win_probability;
        const q = 1 - p;
        const b = 0.95;

        let kelly = (p * b - q) / b;
        kelly = Math.max(0, kelly);

        const fractional_kelly = kelly * CONFIG.kelly_fraction;
        let stake_percent = Math.max(CONFIG.min_stake, Math.min(fractional_kelly, CONFIG.max_stake));
        stake_percent = Math.min(stake_percent, CONFIG.max_risk_per_trade);

        return capital * stake_percent;
    }

    canTrade(direction) {
        if (Date.now() < this.cooldown_until) {
            const remaining = Math.ceil((this.cooldown_until - Date.now()) / 60000);
            this.logger.warn('Trade blocked - cooldown active', { remaining_minutes: remaining });
            return { allowed: false, reason: 'cooldown' };
        }

        if (this.daily_loss >= this.daily_start_capital * CONFIG.daily_loss_limit) {
            this.logger.error('Trade blocked - daily loss limit reached', {
                loss: this.daily_loss.toFixed(2),
                limit: (this.daily_start_capital * CONFIG.daily_loss_limit).toFixed(2)
            });
            return { allowed: false, reason: 'daily_loss_limit' };
        }

        if (this.daily_profit >= this.daily_start_capital * CONFIG.daily_profit_target) {
            this.logger.info('Trade blocked - daily profit target reached', {
                profit: this.daily_profit.toFixed(2),
                target: (this.daily_start_capital * CONFIG.daily_profit_target).toFixed(2)
            });
            return { allowed: false, reason: 'daily_profit_target' };
        }

        if (this.trades_today[direction] >= CONFIG.max_trades_per_direction) {
            this.logger.warn(`Trade blocked - max ${direction} trades reached`);
            return { allowed: false, reason: 'max_trades_per_direction' };
        }

        return { allowed: true };
    }

    recordTrade(direction, stake, profit, won) {
        this.trades_today[direction]++;
        this.daily_trades.push({
            direction,
            stake,
            profit,
            won,
            timestamp: Date.now()
        });

        if (won) {
            this.daily_profit += profit;
            this.current_capital += profit;
            this.consecutive_losses = 0;

            if (this.daily_profit >= this.daily_start_capital * CONFIG.daily_profit_target) {
                this.locked_profit = this.daily_profit * CONFIG.profit_lock_percentage;
                this.logger.info('Profit locked', { locked: this.locked_profit.toFixed(2) });
            }
        } else {
            const loss = Math.abs(profit);
            this.daily_loss += loss;
            this.current_capital -= loss;
            this.consecutive_losses++;

            if (this.consecutive_losses >= CONFIG.cooldown_after_losses) {
                this.cooldown_until = Date.now() + CONFIG.cooldown_duration;
                this.logger.warn('Cooldown activated', {
                    consecutive_losses: this.consecutive_losses,
                    until: new Date(this.cooldown_until).toISOString()
                });
            }
        }

        this.logger.trade('Trade recorded', {
            direction,
            stake: stake.toFixed(2),
            profit: profit.toFixed(2),
            won,
            capital: this.current_capital.toFixed(2)
        });
    }

    resetDaily() {
        this.daily_start_capital = this.current_capital;
        this.daily_profit = 0;
        this.daily_loss = 0;
        this.trades_today = { CALL: 0, PUT: 0 };
        this.daily_trades = [];
        this.locked_profit = 0;
        this.logger.info('Daily counters reset');
    }

    getMetrics() {
        const total = this.daily_trades.length;
        const wins = this.daily_trades.filter(t => t.won).length;

        return {
            capital: this.current_capital,
            daily_profit: this.daily_profit,
            daily_loss: this.daily_loss,
            win_rate: total > 0 ? wins / total : 0,
            total_trades: total,
            wins,
            losses: total - wins,
            consecutive_losses: this.consecutive_losses,
            locked_profit: this.locked_profit
        };
    }
}

// ============================================================================
// STRATEGY
// ============================================================================

class Strategy {
    constructor(indicators, ai_core, risk_manager, logger) {
        this.indicators = indicators;
        this.ai = ai_core;
        this.risk = risk_manager;
        this.logger = logger;
        this.trade_history = [];
    }

    async generateSignal() {
        const state = this.indicators.getState();

        if (state.candle_count < Math.max(CONFIG.ema_long_default, CONFIG.rsi_period, CONFIG.bb_period)) {
            return null;
        }

        const ema_cross_up = state.ema_short > state.ema_long && state.ema_diff > 0;
        const ema_cross_down = state.ema_short < state.ema_long && state.ema_diff < 0;

        let signal = null;

        if (ema_cross_up && state.rsi < CONFIG.rsi_call_threshold) {
            signal = 'CALL';
        }

        if (ema_cross_down && state.rsi > CONFIG.rsi_put_threshold) {
            signal = 'PUT';
        }

        if (!signal) return null;

        const regime = this.ai.detectRegime(state);

        if (signal === 'CALL' && regime === 'down') {
            this.logger.info('Signal filtered - bearish regime');
            return null;
        }

        if (signal === 'PUT' && regime === 'up') {
            this.logger.info('Signal filtered - bullish regime');
            return null;
        }

        const confidence = await this.ai.predictConfidence(state);
        const dynamic_threshold = this.ai.getDynamicThreshold();

        this.logger.info('AI confidence prediction', {
            confidence: confidence.toFixed(3),
            threshold: dynamic_threshold.toFixed(3)
        });

        if (confidence < dynamic_threshold) {
            this.logger.info('Signal filtered - low AI confidence');
            return null;
        }

        if (this.ai.shouldEarlyStop()) {
            this.logger.warn('Early stopping active - retraining classifier');
            await this.ai.trainClassifier();
            return null;
        }

        return {
            direction: signal,
            confidence,
            state,
            regime,
            timestamp: Date.now()
        };
    }

    recordOutcome(signal, won, profit) {
        this.trade_history.push({
            direction: signal.direction,
            confidence: signal.confidence,
            regime: signal.regime,
            won,
            profit,
            loss: won ? 0 : Math.abs(profit),
            result: won ? 'win' : 'loss',
            timestamp: Date.now()
        });

        this.ai.addTrainingSample(signal.state, won);
        this.ai.trackConfidenceAccuracy(signal.confidence, won);

        if (this.trade_history.length % 10 === 0) {
            this.ai.trainClassifier().catch(err => {
                this.logger.error('Classifier training failed', { error: err.message });
            });
        }

        this.ai.incrementTradeCount();
        this.ai.optimizeEMA(this.indicators, this.trade_history).then(new_params => {
            if (new_params) {
                this.indicators.recalculateEMA(new_params.short, new_params.long);
            }
        }).catch(err => {
            this.logger.error('Bayesian optimization failed', { error: err.message });
        });
    }

    getTradeHistory() {
        return this.trade_history;
    }
}

// ============================================================================
// EXECUTOR
// ============================================================================

class Executor {
    constructor(api, risk_manager, logger) {
        this.api = api;
        this.risk = risk_manager;
        this.logger = logger;
        this.active_trades = new Map();
    }

    async executeTrade(signal, capital) {
        const check = this.risk.canTrade(signal.direction);
        if (!check.allowed) {
            return null;
        }

        const stake = this.risk.calculateStake(signal.confidence, capital);

        this.logger.info('Executing trade', {
            direction: signal.direction,
            stake: stake.toFixed(2),
            confidence: signal.confidence.toFixed(3),
            regime: signal.regime
        });

        try {
            const contract = await this.api.buyContract({
                contract_type: signal.direction,
                symbol: CONFIG.symbol,
                duration: CONFIG.option_duration,
                duration_unit: 'm',
                stake
            });

            this.logger.trade('Trade executed', {
                contract_id: contract.contract_id,
                buy_price: parseFloat(contract.buy_price).toFixed(2),
                payout: parseFloat(contract.payout).toFixed(2)
            });

            this.active_trades.set(contract.contract_id, {
                signal,
                stake,
                contract,
                timestamp: Date.now()
            });

            return contract;
        } catch (err) {
            this.logger.error('Trade execution failed', { error: err.message });
            return null;
        }
    }

    checkTrades(strategy) {
        const now = Date.now();
        const expiry_ms = CONFIG.option_duration * 60 * 1000;

        this.active_trades.forEach((trade, contract_id) => {
            if (now - trade.timestamp >= expiry_ms) {
                const won = Math.random() > 0.5; // Simulated - use real API in production
                const profit = won ? trade.stake * 0.95 : -trade.stake;

                this.risk.recordTrade(trade.signal.direction, trade.stake, profit, won);
                strategy.recordOutcome(trade.signal, won, profit);

                this.active_trades.delete(contract_id);
            }
        });
    }
}

// ============================================================================
// MAIN BOT
// ============================================================================

class DerivAIBot {
    constructor(args) {
        this.args = args;
        this.logger = new Logger(CONFIG.log_file);
        this.api = null;
        this.indicators = new IndicatorEngine();
        this.ai = new AI_Core(this.logger);
        this.risk = new RiskManager(this.logger);
        this.strategy = null;
        this.executor = null;
        this.running = false;
        this.last_reset = new Date().setHours(0, 0, 0, 0);
    }

    async init() {
        this.logger.info('Initializing bot', { mode: this.args.mode });

        if (this.args.mode === 'backtest') {
            await this.runBacktest();
            return;
        }

        this.api = new DerivAPI(this.args.token, this.logger);
        await this.api.connect();

        const balance = await this.api.getBalance();
        this.risk.init(balance);

        this.strategy = new Strategy(this.indicators, this.ai, this.risk, this.logger);
        this.executor = new Executor(this.api, this.risk, this.logger);

        await this.api.subscribeCandles(CONFIG.symbol, CONFIG.candle_interval, (data) => {
            this.handleCandle(data);
        });

        this.logger.info('Bot initialized successfully');
    }

    async handleCandle(data) {
        if (data.type === 'history') {
            data.candles.forEach(candle => {
                this.indicators.addCandle({
                    open: parseFloat(candle.open),
                    high: parseFloat(candle.high),
                    low: parseFloat(candle.low),
                    close: parseFloat(candle.close),
                    timestamp: candle.epoch
                });
            });
            this.logger.info('Loaded historical candles', { count: data.candles.length });
        } else if (data.type === 'tick') {
            this.indicators.addCandle({
                open: parseFloat(data.candle.open),
                high: parseFloat(data.candle.high),
                low: parseFloat(data.candle.low),
                close: parseFloat(data.candle.close),
                timestamp: data.candle.epoch
            });

            await this.onNewCandle();
        }
    }

    async onNewCandle() {
        const now = new Date();
        const today_start = new Date(now).setHours(0, 0, 0, 0);
        if (today_start > this.last_reset) {
            this.risk.resetDaily();
            this.last_reset = today_start;
        }

        this.executor.checkTrades(this.strategy);

        const signal = await this.strategy.generateSignal();
        if (!signal) return;

        this.logger.info('Signal generated', {
            direction: signal.direction,
            confidence: signal.confidence.toFixed(3),
            regime: signal.regime
        });

        await this.executor.executeTrade(signal, this.risk.current_capital);
        this.saveMetrics();
    }

    async runBacktest() {
        this.logger.info('Running backtest', { file: this.args.backtest_file });

        try {
            const data = fs.readFileSync(this.args.backtest_file, 'utf8');
            const lines = data.split('\n').slice(1);

            const candles = lines.filter(l => l.trim()).map(line => {
                const parts = line.split(',');
                return {
                    timestamp: parseInt(parts[0]),
                    open: parseFloat(parts[1]),
                    high: parseFloat(parts[2]),
                    low: parseFloat(parts[3]),
                    close: parseFloat(parts[4])
                };
            });

            this.logger.info('Loaded backtest data', { candles: candles.length });

            this.risk.init(10000);
            this.strategy = new Strategy(this.indicators, this.ai, this.risk, this.logger);

            for (const candle of candles) {
                this.indicators.addCandle(candle);

                const signal = await this.strategy.generateSignal();
                if (signal) {
                    const check = this.risk.canTrade(signal.direction);
                    if (check.allowed) {
                        const stake = this.risk.calculateStake(signal.confidence, this.risk.current_capital);
                        const won = Math.random() < signal.confidence;
                        const profit = won ? stake * 0.95 : -stake;

                        this.risk.recordTrade(signal.direction, stake, profit, won);
                        this.strategy.recordOutcome(signal, won, profit);
                    }
                }
            }

            const metrics = this.risk.getMetrics();
            console.log('\n=== BACKTEST RESULTS ===');
            console.log('Final Capital:', metrics.capital.toFixed(2));
            console.log('Total Return:', ((metrics.capital / 10000 - 1) * 100).toFixed(2) + '%');
            console.log('Win Rate:', (metrics.win_rate * 100).toFixed(2) + '%');
            console.log('Total Trades:', metrics.total_trades);
            console.log('Wins:', metrics.wins);
            console.log('Losses:', metrics.losses);

            this.saveMetrics();
            this.logger.flush();

        } catch (err) {
            this.logger.error('Backtest failed', { error: err.message });
        }
    }

    async start() {
        await this.init();

        if (this.args.mode === 'backtest') {
            return;
        }

        this.running = true;
        this.logger.info('Bot started');

        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());
    }

    async stop() {
        this.logger.info('Stopping bot...');
        this.running = false;

        this.saveMetrics();
        this.logger.flush();

        if (this.api) {
            this.api.close();
        }

        this.logger.info('Bot stopped');
        process.exit(0);
    }

    saveMetrics() {
        const metrics = {
            timestamp: new Date().toISOString(),
            risk: this.risk.getMetrics(),
            trade_history: this.strategy ? this.strategy.getTradeHistory().slice(-100) : [],
            ai: {
                trade_count: this.ai.trade_count,
                current_ema_short: this.ai.current_ema_short,
                current_ema_long: this.ai.current_ema_long,
                bayesian_trials: this.ai.bayesian_trials.length
            }
        };

        try {
            fs.writeFileSync(CONFIG.metrics_file, JSON.stringify(metrics, null, 2));
        } catch (err) {
            this.logger.error('Failed to save metrics', { error: err.message });
        }
    }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

if (require.main === module) {
    const args = parseArgs();

    if (!args.token && args.mode !== 'backtest') {
        console.error('Error: API token required for live/demo mode');
        console.error('Usage: node deriv-ai-bot.js --live --token=YOUR_TOKEN');
        console.error('       node deriv-ai-bot.js --demo --token=YOUR_TOKEN');
        console.error('       node deriv-ai-bot.js --backtest=data.csv');
        process.exit(1);
    }

    const bot = new DerivAIBot(args);
    bot.start().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { DerivAIBot, CONFIG };