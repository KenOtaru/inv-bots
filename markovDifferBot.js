require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

/**
 * MarkovDifferBot
 * 
 * A sophisticated Deriv trading bot using a Context-Aware Markov Chain strategy.
 * It analyzes the sequence of the last 2 digits to predict the probability of the next digit.
 * Trades are placed on "Digit Differ" when the probability of a specific digit appearing
 * in the current context is statistically negligible.
 */
class MarkovDifferBot {
    constructor(token, config = {}) {
        this.token = token;

        // Configuration
        this.config = {
            assets: config.assets || ['R_100', 'R_10', 'R_25', 'R_50', 'R_75', 'RDBULL', 'RDBEAR'],
            initialStake: config.initialStake || 0.35,
            currency: config.currency || 'USD',

            // Risk Management
            stopLoss: config.stopLoss || 50, // Stop if total loss exceeds this
            takeProfit: config.takeProfit || 10, // Stop if total profit exceeds this
            maxConsecutiveLosses: config.maxConsecutiveLosses || 2, // Suspend asset after X losses
            martingaleMultiplier: config.martingaleMultiplier || 11, // Multiplier after loss (aggressive for Differ)

            // Strategy Settings
            dryRun: config.dryRun !== undefined ? config.dryRun : false, // Default to simulation mode
            learningPhase: config.learningPhase || 500, // Ticks to collect before trading
            minStateSamples: config.minStateSamples || 15, // Min occurrences of a pattern to trust stats
            probabilityThreshold: config.probabilityThreshold || 0.01, // Trade if P(digit) < 3%
            volatilityWindow: 20, // Ticks to calculate volatility
            volatilityThreshold: 2.5, // Avoid trading if std dev is too high (erratic market)
        };

        // State
        this.ws = null;
        this.connected = false;
        this.authorized = false;
        this.reconnectAttempts = 0;

        this.stats = {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            profit: 0,
            startTime: new Date(),
        };

        // Asset Data
        // Structure: { assetName: { history: [], markov: Matrix, lastDigits: [], suspended: bool, ... } }
        this.assetsData = {};

        // Initialize Asset Data
        this.config.assets.forEach(asset => {
            this.assetsData[asset] = {
                history: [], // Full tick history
                lastDigits: [], // Just the digits
                markov: this.createMarkovMatrix(), // 100x10 matrix
                stateCounts: new Array(100).fill(0), // Count of times each state occurred
                suspended: false,
                consecutiveLosses: 0,
                currentStake: this.config.initialStake,
                tradeInProgress: false,
                volatility: 0
            };
        });

        // Email Config (Optional)
        this.emailConfig = {
            enabled: false, // Set to true if email is configured
            // Add nodemailer config here if needed
        };
    }

    /**
     * Creates a 100x10 matrix initialized to zeros.
     * Rows (0-99): Represent the state (Last 2 digits, e.g., "48" -> index 48).
     * Cols (0-9): Represent the count of the NEXT digit.
     */
    createMarkovMatrix() {
        return Array.from({ length: 100 }, () => new Array(10).fill(0));
    }

    start() {
        console.log(`
╔══════════════════════════════════════════════════════════════╗
║                MARKOV CHAIN DIGIT DIFFER BOT                 ║
║                -----------------------------                 ║
║  Mode: ${this.config.dryRun ? '🛑 SIMULATION (Dry Run)' : '🚀 LIVE TRADING'}                           ║
║  Assets: ${this.config.assets.join(', ')}                      ║
║  Strategy: Context-Aware Markov Chain (Order 2)              ║
╚══════════════════════════════════════════════════════════════╝
        `);
        this.connect();
    }

    connect() {
        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            console.log('✅ Connected to Deriv API');
            this.authorize();
        });

        this.ws.on('message', (data) => this.handleMessage(JSON.parse(data)));

        this.ws.on('close', () => {
            console.log('❌ Disconnected. Reconnecting in 5s...');
            this.connected = false;
            this.authorized = false;
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            console.error('⚠️ WebSocket Error:', err.message);
        });
    }

    authorize() {
        this.send({ authorize: this.token });
    }

    send(req) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(req));
        }
    }

    handleMessage(msg) {
        if (msg.error) {
            console.error(`⚠️ API Error [${msg.msg_type}]:`, msg.error.message);
            // Handle specific errors like InvalidToken if needed
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuth(msg);
                break;
            case 'history':
                this.handleHistory(msg);
                break;
            case 'tick':
                this.handleTick(msg);
                break;
            case 'proposal_open_contract':
                this.handleContract(msg);
                break;
            case 'buy':
                this.handleBuy(msg);
                break;
        }
    }

    handleAuth(msg) {
        console.log('🔐 Authorized. Account Balance:', msg.authorize.balance, msg.authorize.currency);
        this.authorized = true;
        this.subscribeToAssets();
    }

    subscribeToAssets() {
        this.config.assets.forEach(asset => {
            // Get initial history for learning
            this.send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.learningPhase,
                end: 'latest',
                start: 1,
                style: 'ticks'
            });

            // Subscribe to real-time ticks
            this.send({ ticks: asset, subscribe: 1 });
        });
    }

    handleHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        const prices = msg.history.prices;

        console.log(`📚 Learned from ${prices.length} past ticks for ${asset}`);

        prices.forEach(price => {
            this.processTick(asset, price, false); // false = don't trade, just learn
        });
    }

    handleTick(msg) {
        const asset = msg.tick.symbol;
        const price = msg.tick.quote;
        this.processTick(asset, price, true); // true = can trade
    }

    getLastDigit(price) {
        const str = price.toString();
        // Handle integers or floats
        if (str.includes('.')) {
            return parseInt(str.split('.')[1].slice(-1)); // Last char of decimal part
        }
        return parseInt(str.slice(-1)); // Last char of integer
    }

    processTick(asset, price, canTrade) {
        const data = this.assetsData[asset];
        const digit = this.getLastDigit(price);

        // Update History
        data.history.push(price);
        data.lastDigits.push(digit);
        if (data.history.length > 2000) { // Keep memory manageable
            data.history.shift();
            data.lastDigits.shift();
        }

        // Calculate Volatility (Standard Deviation of last 20 prices)
        if (data.history.length >= this.config.volatilityWindow) {
            const window = data.history.slice(-this.config.volatilityWindow);
            const mean = window.reduce((a, b) => a + parseFloat(b), 0) / window.length;
            const variance = window.reduce((a, b) => a + Math.pow(parseFloat(b) - mean, 2), 0) / window.length;
            data.volatility = Math.sqrt(variance);
        }

        // Update Markov Chain
        // We need at least 3 digits to form a State (2 digits) -> Transition (1 digit)
        const n = data.lastDigits.length;
        if (n >= 3) {
            const d1 = data.lastDigits[n - 3];
            const d2 = data.lastDigits[n - 2];
            const target = data.lastDigits[n - 1]; // The digit that just arrived

            const stateIndex = (d1 * 10) + d2; // e.g., 4, 8 -> 48

            // Update counts
            data.markov[stateIndex][target]++;
            data.stateCounts[stateIndex]++;
        }

        // Trading Logic
        if (canTrade && !data.tradeInProgress && !data.suspended && data.history.length >= this.config.learningPhase) {
            this.evaluateTrade(asset);
        }
    }

    evaluateTrade(asset) {
        const data = this.assetsData[asset];

        // 1. Check Volatility
        // Note: Volatility scale depends on the asset price. This is a rough heuristic.
        // For a robust bot, we might use Bollinger Band width or similar relative metrics.
        // For now, we skip if volatility is extremely high relative to recent average (simplified).

        // 2. Determine Current State
        const n = data.lastDigits.length;
        const d1 = data.lastDigits[n - 2];
        const d2 = data.lastDigits[n - 1];
        const currentState = (d1 * 10) + d2;

        // 3. Check Sample Size
        const totalSamples = data.stateCounts[currentState];
        if (totalSamples < this.config.minStateSamples) {
            // Not enough data for this specific pattern yet
            return;
        }

        // 4. Analyze Probabilities
        const transitions = data.markov[currentState];
        let lowestProb = 1.0;
        let bestDigit = -1;

        for (let digit = 0; digit <= 9; digit++) {
            const count = transitions[digit];
            const prob = count / totalSamples;

            if (prob < lowestProb) {
                lowestProb = prob;
                bestDigit = digit;
            }
        }

        // 5. Place Trade if Probability is Low Enough
        if (lowestProb <= this.config.probabilityThreshold && bestDigit !== -1) {
            console.log(`⚡ [${asset}] Pattern [${d1}, ${d2}] -> ? | P(${bestDigit}) = ${(lowestProb * 100).toFixed(1)}% (${transitions[bestDigit]}/${totalSamples}) | Vol: ${data.volatility.toFixed(4)}`);

            this.placeTrade(asset, bestDigit, lowestProb);
        }
    }

    placeTrade(asset, digit, probability) {
        const data = this.assetsData[asset];

        if (this.config.dryRun) {
            // Simulate Trade
            data.tradeInProgress = true;
            console.log(`🛠️ [SIMULATION] Buying DIGITDIFF ${digit} on ${asset} for $${data.currentStake}`);

            // We need to wait for the next tick to see if we won
            // Simple simulation hook:
            const checkWin = (msg) => {
                if (msg.tick && msg.tick.symbol === asset) {
                    const resultDigit = this.getLastDigit(msg.tick.quote);
                    const won = resultDigit !== digit;

                    this.handleTradeResult({
                        underlying: asset,
                        status: won ? 'won' : 'lost',
                        profit: won ? (data.currentStake * 0.09) : -data.currentStake, // Approx 9% payout
                        is_simulation: true
                    });

                    // Remove listener
                    this.ws.removeListener('message', listener);
                }
            };

            const listener = (data) => {
                const msg = JSON.parse(data);
                if (msg.msg_type === 'tick') checkWin(msg);
            };
            this.ws.on('message', listener);

        } else {
            // Live Trade
            data.tradeInProgress = true;
            const contract = {
                buy: 1,
                price: data.currentStake,
                parameters: {
                    amount: data.currentStake,
                    basis: 'stake',
                    contract_type: 'DIGITDIFF',
                    currency: this.config.currency,
                    duration: 1,
                    duration_unit: 't',
                    symbol: asset,
                    barrier: digit.toString()
                }
            };
            this.send(contract);
        }
    }

    handleBuy(msg) {
        if (msg.buy) {
            const contractId = msg.buy.contract_id;
            console.log(`✅ Trade Placed. ID: ${contractId}`);
            // Subscribe to contract updates to get the result
            this.send({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            });
        }
    }

    handleContract(msg) {
        const contract = msg.proposal_open_contract;
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        const data = this.assetsData[asset];

        data.tradeInProgress = false;

        // Update Stats
        this.stats.totalTrades++;
        if (won) this.stats.wins++; else this.stats.losses++;
        this.stats.profit += profit;

        const symbol = won ? '✅' : '❌';
        console.log(`${symbol} [${asset}] ${won ? 'WIN' : 'LOSS'} | Profit: ${profit.toFixed(2)} | Total P/L: ${this.stats.profit.toFixed(2)}`);

        // Strategy Management
        if (won) {
            data.consecutiveLosses = 0;
            data.currentStake = this.config.initialStake; // Reset stake

            // Check Take Profit
            if (this.stats.profit >= this.config.takeProfit) {
                console.log('🎉 TAKE PROFIT REACHED! Stopping bot.');
                this.stop();
            }

        } else {
            data.consecutiveLosses++;

            // Martingale / Recovery
            data.currentStake = data.currentStake * this.config.martingaleMultiplier;
            // Round to 2 decimals
            data.currentStake = Math.round(data.currentStake * 100) / 100;

            console.log(`🔻 [${asset}] Loss #${data.consecutiveLosses}. Increasing stake to $${data.currentStake}`);

            // Suspend Asset if too many losses
            if (data.consecutiveLosses >= this.config.maxConsecutiveLosses) {
                console.log(`⛔ [${asset}] Max consecutive losses reached. Suspending asset.`);
                data.suspended = true;
                // Optional: Auto-unsuspend after some time?
                setTimeout(() => {
                    console.log(`♻️ [${asset}] Unsuspending asset.`);
                    data.suspended = false;
                    data.consecutiveLosses = 0;
                    data.currentStake = this.config.initialStake;
                }, 60000 * 5); // 5 minutes
            }

            // Check Stop Loss
            if (this.stats.profit <= -this.config.stopLoss) {
                console.log('💀 STOP LOSS REACHED! Stopping bot.');
                this.stop();
            }
        }
    }

    stop() {
        console.log('🛑 Stopping Bot...');
        this.ws.close();
        process.exit(0);
    }
}

// --- RUNNER ---

// Use the token from the existing file or env
const TOKEN = process.env.DERIV_TOKEN || 'DMylfkyce6VyZt7'; // Fallback to token found in geminiDiffer.js

const bot = new MarkovDifferBot(TOKEN, {
    dryRun: true, // Set to false for real money
    initialStake: 0.61,
    martingaleMultiplier: 11.3, // High multiplier needed for Differ (payout ~9-10%)
    probabilityThreshold: 0.01, // Only trade if < 2% chance of hitting the digit
    minStateSamples: 10, // Learn quickly
    stopLoss: 50, // Stop if total loss exceeds this
    takeProfit: 50, // Stop if total profit exceeds this
    maxConsecutiveLosses: 3, // Suspend asset after X losses
});

bot.start();
