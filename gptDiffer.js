require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// ===== Strategy Plumbing =====
class StrategyManager {
    constructor(cfg = {}) {
        this.minConfidenceBase = cfg.minConfidenceBase ?? 0.012;   // min margin over 0.10 baseline
        this.minConfidenceMax  = cfg.minConfidenceMax ?? 0.03;     // upper bound after bad streaks
        this.lastStrategyName  = null;
        this.results = []; // {strategy, won, asset, time}
        this.rng = () => Math.random();

        // Pool of strategies with diverse logic
        this.pool = [
            new LeastFrequentStrategy('LF_Short', { windows: [30, 40, 60] }),
            new LeastFrequentStrategy('LF_Long',  { windows: [120, 180, 240] }),
            new EWMARecencyStrategy('EWMA',       { taus: [15, 30, 60], prior: 1 }),
            new Markov1Strategy('MK1',            { maxPairs: [300, 600, 900], alpha: [0.5, 1, 2] }),
            new Markov2Strategy('MK2',            { maxTriples: [400, 800, 1200], alpha: [0.5, 1, 2], minObs: 8 }),
        ];
    }

    // Pick strategy (not the same as last), compute a prediction with randomized params
    decide(asset, history, lastDigit, lossPressure = 0) {
        if (!history || history.length < 50) return null;

        // Tighten or loosen gating based on recent outcomes
        const minConf = Math.min(
            this.minConfidenceBase + 0.003 * Math.max(0, lossPressure - 1),
            this.minConfidenceMax
        );

        // Shuffle pool order
        const candidates = this.pool
            .map(s => ({ s, r: this.rng() }))
            .sort((a,b) => a.r - b.r)
            .map(o => o.s);

        for (const strategy of candidates) {
            if (strategy.name === this.lastStrategyName && candidates.length > 1) continue; // avoid immediate reuse

            const decision = strategy.predict(history, lastDigit);
            if (!decision) continue;

            const baseline = 0.10; // uniform digit probability
            const margin = baseline - decision.predictedProb;
            if (margin > minConf && decision.digitToAvoid >= 0 && decision.digitToAvoid <= 9) {
                return {
                    asset,
                    strategy: strategy.name,
                    digitToAvoid: decision.digitToAvoid,
                    predictedProb: decision.predictedProb,
                    confidenceMargin: margin,
                    debug: decision.debug
                };
            }
        }
        return null;
    }

    feedback(lastDecision, won) {
        if (!lastDecision) return;
        this.results.push({ strategy: lastDecision.strategy, won, asset: lastDecision.asset, time: Date.now() });
        this.lastStrategyName = lastDecision.strategy;
    }
}

// ===== Strategies =====
class LeastFrequentStrategy {
    constructor(name, cfg = {}) {
        this.name = name;
        this.windows = cfg.windows || [50, 100, 150];
        this.prior = cfg.prior ?? 1;
    }
    predict(history) {
        const W = this.windows[Math.floor(Math.random()*this.windows.length)];
        if (history.length < W) return null;

        const slice = history.slice(-W);
        const counts = Array(10).fill(0);
        for (const d of slice) counts[d]++;

        // Smoothed probabilities
        const smooth = counts.map(c => c + this.prior);
        const sum = smooth.reduce((a,b) => a+b, 0);
        const probs = smooth.map(x => x / sum);

        let digitToAvoid = 0, p = probs[0];
        for (let d = 1; d < 10; d++) if (probs[d] < p) { p = probs[d]; digitToAvoid = d; }

        return {
            digitToAvoid,
            predictedProb: p,
            debug: { W, counts, probs }
        };
    }
}

class EWMARecencyStrategy {
    constructor(name, cfg = {}) {
        this.name = name;
        this.taus = cfg.taus || [20, 40, 80];
        this.prior = cfg.prior ?? 1;
    }
    predict(history) {
        const N = history.length;
        const tau = this.taus[Math.floor(Math.random()*this.taus.length)];
        if (N < 40) return null;

        // Exponential recency weights
        const weights = [];
        let sumW = 0;
        for (let i = 0; i < N; i++) {
            const w = Math.exp(-(N - 1 - i) / tau);
            weights.push(w);
            sumW += w;
        }
        const counts = Array(10).fill(0);
        for (let i = 0; i < N; i++) counts[history[i]] += weights[i];

        const smooth = counts.map(c => c + this.prior);
        const sum = smooth.reduce((a,b) => a+b, 0);
        const probs = smooth.map(x => x / sum);

        let digitToAvoid = 0, p = probs[0];
        for (let d = 1; d < 10; d++) if (probs[d] < p) { p = probs[d]; digitToAvoid = d; }

        return {
            digitToAvoid,
            predictedProb: p,
            debug: { tau, counts, probs }
        };
    }
}

class Markov1Strategy {
    constructor(name, cfg = {}) {
        this.name = name;
        this.maxPairsArr = cfg.maxPairs || [400, 800];
        this.alphaArr = cfg.alpha || [1];
    }
    predict(history, lastDigit) {
        const N = history.length;
        if (N < 50) return null;

        const maxPairs = this.maxPairsArr[Math.floor(Math.random()*this.maxPairsArr.length)];
        const alpha = this.alphaArr[Math.floor(Math.random()*this.alphaArr.length)];

        const start = Math.max(1, N - maxPairs);
        const trans = Array.from({length:10}, () => Array(10).fill(0));
        for (let i = start; i < N; i++) {
            const prev = history[i - 1];
            const cur  = history[i];
            trans[prev][cur]++;
        }

        const row = trans[lastDigit];
        const smooth = row.map(c => c + alpha);
        const sum = smooth.reduce((a,b) => a+b, 0);
        const probs = smooth.map(x => x / sum);

        let digitToAvoid = 0, p = probs[0];
        for (let d = 1; d < 10; d++) if (probs[d] < p) { p = probs[d]; digitToAvoid = d; }

        return {
            digitToAvoid,
            predictedProb: p,
            debug: { maxPairs, alpha, row, probs }
        };
    }
}

class Markov2Strategy {
    constructor(name, cfg = {}) {
        this.name = name;
        this.maxTriplesArr = cfg.maxTriples || [600, 1000];
        this.alphaArr = cfg.alpha || [1];
        this.minObs = cfg.minObs ?? 5;
    }
    predict(history) {
        const N = history.length;
        if (N < 80) return null;

        const maxTriples = this.maxTriplesArr[Math.floor(Math.random()*this.maxTriplesArr.length)];
        const alpha = this.alphaArr[Math.floor(Math.random()*this.alphaArr.length)];

        const start = Math.max(2, N - maxTriples);
        const map = new Map(); // key = 10*a + b -> counts[10]
        for (let i = start; i < N; i++) {
            const a = history[i - 2], b = history[i - 1], c = history[i];
            const key = a * 10 + b;
            if (!map.has(key)) map.set(key, Array(10).fill(0));
            map.get(key)[c]++;
        }
        const a = history[N - 2], b = history[N - 1];
        const key = a * 10 + b;
        if (!map.has(key)) return null;

        const row = map.get(key);
        const obs = row.reduce((x,y) => x+y, 0);
        if (obs < this.minObs) return null;

        const smooth = row.map(c => c + alpha);
        const sum = smooth.reduce((x,y) => x+y, 0);
        const probs = smooth.map(x => x / sum);

        let digitToAvoid = 0, p = probs[0];
        for (let d = 1; d < 10; d++) if (probs[d] < p) { p = probs[d]; digitToAvoid = d; }

        return {
            digitToAvoid,
            predictedProb: p,
            debug: { maxTriples, alpha, row, probs }
        };
    }
}


class BanditStrategyManager extends StrategyManager {
    constructor(cfg = {}) {
        super(cfg);
        this.epsilon = cfg.epsilon ?? 0.2; // exploration rate
        this.perAsset = new Map(); // asset -> { strategyName -> {trades, wins, avgMargin} }
    }

    _getAssetStats(asset) {
        if (!this.perAsset.has(asset)) {
            const map = new Map();
            for (const s of this.pool) map.set(s.name, { trades: 0, wins: 0, avgMargin: 0 });
            this.perAsset.set(asset, map);
        }
        return this.perAsset.get(asset);
    }

    decide(asset, history, lastDigit, lossPressure = 0) {
        if (!history || history.length < 50) return null;
        const stats = this._getAssetStats(asset);

        const minConf = Math.min(
            this.minConfidenceBase + 0.003 * Math.max(0, lossPressure - 1),
            this.minConfidenceMax
        );

        // Choose strategy name with epsilon-greedy on win rate (ties → higher avgMargin)
        let chosen;
        if (Math.random() < this.epsilon) {
            // Explore
            const options = this.pool.filter(s => s.name !== this.lastStrategyName || this.pool.length === 1);
            chosen = options[Math.floor(Math.random()*options.length)];
        } else {
            // Exploit
            let best = null, bestScore = -Infinity;
            for (const s of this.pool) {
                if (s.name === this.lastStrategyName && this.pool.length > 1) continue;
                const st = stats.get(s.name);
                const winRate = st.trades > 0 ? st.wins / st.trades : 0.5;
                const score = winRate + 0.05 * st.avgMargin; // small bonus for higher-margin strategies
                if (score > bestScore) { bestScore = score; best = s; }
            }
            chosen = best || this.pool[0];
        }

        // Randomize the rest as in base class: compute decision, check margin
        const decision = chosen.predict(history, lastDigit);
        if (!decision) return null;

        const baseline = 0.10;
        const margin = baseline - decision.predictedProb;
        if (margin > minConf) {
            return {
                asset,
                strategy: chosen.name,
                digitToAvoid: decision.digitToAvoid,
                predictedProb: decision.predictedProb,
                confidenceMargin: margin,
                debug: decision.debug
            };
        }
        return null;
    }

    feedback(lastDecision, won) {
        if (!lastDecision) return;
        super.feedback(lastDecision, won);
        const stats = this._getAssetStats(lastDecision.asset);
        const st = stats.get(lastDecision.strategy);
        st.trades += 1;
        if (won) st.wins += 1;
        // Track avg margin
        st.avgMargin = ((st.avgMargin * (st.trades - 1)) + lastDecision.confidenceMargin) / st.trades;
    }
}

class EnsembleManager extends StrategyManager {
    constructor(cfg = {}) {
        super(cfg);
        this.maxMembers = cfg.maxMembers ?? 3; // random subset size per trade
        this.weightRange = cfg.weightRange ?? [0.5, 1.5];
    }

    decide(asset, history, lastDigit, lossPressure = 0) {
        if (!history || history.length < 50) return null;
        const minConf = Math.min(
            this.minConfidenceBase + 0.003 * Math.max(0, lossPressure - 1),
            this.minConfidenceMax
        );

        // Random subset of strategies
        const shuffled = this.pool
            .map(s => ({ s, r: Math.random() }))
            .sort((a,b) => a.r - b.r)
            .map(o => o.s);

        const k = Math.max(2, Math.min(this.maxMembers, shuffled.length));
        const subset = shuffled.slice(0, k);

        // Collect probability vectors
        const probMatrix = [];
        const members = [];
        for (const s of subset) {
            const d = s.predict(history, lastDigit);
            if (!d) continue;
            const probs = this._toVector(d);
            if (!probs) continue;
            probMatrix.push(probs);
            members.push({ name: s.name, predictedProb: d.predictedProb, digitToAvoid: d.digitToAvoid, debug: d.debug });
        }
        if (probMatrix.length === 0) return null;

        // Random weights
        const [wMin, wMax] = this.weightRange;
        const weights = probMatrix.map(() => (wMin + Math.random()*(wMax - wMin)));

        // Log-prob sum to avoid underflow: log P(d) = sum_s w_s * log P_s(d)
        const logProbs = Array(10).fill(0);
        for (let s = 0; s < probMatrix.length; s++) {
            const w = weights[s];
            for (let d = 0; d < 10; d++) {
                const p = Math.max(1e-6, probMatrix[s][d]); // floor
                logProbs[d] += w * Math.log(p);
            }
        }
        // Convert back
        const maxLog = Math.max(...logProbs);
        const exps = logProbs.map(x => Math.exp(x - maxLog));
        const sum = exps.reduce((a,b) => a+b, 0);
        const P = exps.map(x => x / sum);

        // Choose argmin
        let digitToAvoid = 0, p = P[0];
        for (let d = 1; d < 10; d++) if (P[d] < p) { p = P[d]; digitToAvoid = d; }

        const baseline = 0.10;
        const margin = baseline - p;
        if (margin > minConf) {
            return {
                asset,
                strategy: 'Ensemble(' + members.map(m => m.name).join(',') + ')',
                digitToAvoid,
                predictedProb: p,
                confidenceMargin: margin,
                debug: { members, weights, P }
            };
        }
        return null;
    }

    _toVector(decision) {
        // Some strategies only return single digit prob; reconstruct a vector if provided in debug
        // Prefer full probs when available
        if (decision.debug?.probs && Array.isArray(decision.debug.probs) && decision.debug.probs.length === 10) {
            return decision.debug.probs;
        }
        // Fallback: build a flat vector placing the predicted prob at the chosen digit,
        // distribute the remainder uniformly (not ideal, but maintains a vector)
        // const p = Math.min(0.2, Math.max(0.01, decision.predictedProb ?? 0.1));
        // const rest = (1 - p) / 9;
        // const vec = Array(10).fill(rest);
        // vec[decision.digitToAvoid] = p;
        // return vec;
    }
}


class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // 'R_75',
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
        };

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.tickHistories2 = {};
        this.lastDigits = {};
        this.lastDigits2 = {};
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
        // this.startTime = null;
        this.isExcluded = [];
        // Add new property to track suspended assets
        this.suspendedAssets = new Set();
        this.rStats = {};
        this.sys = 1;

        //StrategyManager
        // this.strategyManager = new StrategyManager({
        //     minConfidenceBase: 0.012,
        //     minConfidenceMax: 0.03
        // });
        this.lastDecision = null;

        //BanditStrategyManager
        // this.strategyManager = new BanditStrategyManager({
        //     minConfidenceBase: 0.012,
        //     minConfidenceMax: 0.03,
        //     epsilon: 0.25
        // });

        this.strategyManager = new EnsembleManager({
            minConfidenceBase: 0.012,
            minConfidenceMax: 0.03,
            maxMembers: 3,
            weightRange: [0.6, 1.4]
        });


        // Initialize per-asset storage
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.lastDigits[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
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
                this.tickHistories2[asset] = [];
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
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
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

        this.lastDigits[asset] = lastDigit;
  
        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        } 

         console.log(`[${asset}] ${tick.quote} → Last 5: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`⏳ [${asset}] Buffering... (${this.tickHistories[asset].length}/${this.config.requiredHistoryLength})`);
            return;
        }

        if (!this.tradeInProgress) {
            this.analyzeTicks(asset);
        }
    }
    

    analyzeTicks(asset) {
    if (this.tradeInProgress) return;

    const history = this.tickHistories[asset];
    if (!history || history.length < this.config.requiredHistoryLength) {
        console.log(`[${asset}] Waiting for more ticks. Current length: ${history?.length ?? 0}`);
        return;
    }
    if (this.suspendedAssets.has(asset)) {
        console.log(`Skipping analysis for suspended asset: ${asset}`);
        return;
    }

    // Use StrategyManager to choose digit to avoid
    const lossPressure = this.consecutiveLosses; // tighten gating if losing
    const lastDigit = history[history.length - 1];
    const decision = this.strategyManager.decide(asset, history, lastDigit, lossPressure);
    if (!decision) {
        // No sufficiently confident edge; skip
        return;
    }

    this.xDigit = decision.digitToAvoid; // for your logs/emails
    this.lastDecision = decision;

    console.log(`[${asset}] Strategy=${decision.strategy} avoid=${decision.digitToAvoid} p≈${decision.predictedProb.toFixed(3)} margin≈${decision.confidenceMargin.toFixed(3)}`);
    if(decision.digitToAvoid >= 6) {
        this.placeTrade(asset, decision.digitToAvoid, Math.round((1 - decision.predictedProb) * 1000) / 1000);
    }
}


    placeTrade(asset, predictedDigit, probability) {
        if (this.tradeInProgress) return;

        this.tradeInProgress = true;
        this.xDigit = predictedDigit;

        console.log(`🚀 [${asset}] Placing trade : Digit: ${predictedDigit}(${probability}%) | Stake: $${this.currentStake}`);

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
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        
        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.strategyManager.feedback(this.lastDecision, won);
        this.lastDecision = null;

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

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Suspend the asset after a loss
            // this.suspendAsset(asset);

            if (this.sys === 1) {
                this.sys = 2;
            } else {
                this.sys = 1;
            }               

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }  

        this.totalProfitLoss += profit;	
        this.todayPnL += profit;	
        this.Pause = true;

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if (!won) {
            this.sendLossEmail(asset);
        }

        if(!this.endOfDay) {
            this.logTradingSummary(asset);
        }

        // If there are suspended assets, reactivate the first one on win
        if (this.suspendedAssets.size > 3) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        // Suspend the asset after a trade
        this.suspendAsset(asset);
        
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition reached. Stopping trading.');
            this.endOfDay = true;
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.endOfDay = true;
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        // this.unsubscribeAllTicks();
        this.disconnect();

        if (!this.endOfDay) {               
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }
    }

    // Add new method to handle asset suspension
    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`✅ Reactivated asset: ${asset}`);
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

            // Check for afternoon resume condition (7:00 AM)
            if (this.endOfDay && currentHours === 14 && currentMinutes >= 0) {
                console.log("It's 7:00 AM, reconnecting the bot.");
                this.LossDigitsList = [];
                this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.tradedDigitArray = [];
                this.tradedDigitArray2 = [];
                this.tradeNum = Math.floor(Math.random() * (40 - 21 + 1)) + 21;
                this.connect();
            }
    
            // Check for evening stop condition (after 5:00 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 23 && currentMinutes >= 0) {
                    console.log("It's past 5:00 PM after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000); // Check every 20 seconds
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
        console.log(`[${asset}] Predicted Digit: ${this.xDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`); 
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }
    
    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 21600000); // 6 Hours
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

        Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

        Current Stake: $${this.currentStake.toFixed(2)}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'GptDigit_Differ3-Multi_Asset_Bot - Summary',
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

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-20);

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
        predicted Digit: ${this.xDigit}
        
        Last 20 Digits: ${lastFewTicks.join(', ')} 

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'GptDigit_Differ3-Multi_Asset_Bot - Loss Alert',
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
            subject: 'GptDigit_Differ3-Multi_Asset_Bot - Error Report',
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
        this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('0P94g4WdSrSrzir', {
    initialStake: 0.61,
    multiplier: 11.3,
    maxConsecutiveLosses: 3, 
    stopLoss: 129,
    takeProfit: 5000,
    requiredHistoryLength: 1000,
    winProbabilityThreshold: 0.6,
    minWaitTime: 300000, //5 Minutes
    maxWaitTime: 2600000, //1 Hour
});

bot.start();

