#!/usr/bin/env node

const WebSocket = require('ws');
const chalk = require('chalk');
const figlet = require('figlet');
const boxen = require('boxen');
const cliProgress = require('cli-progress');
const prompt = require('prompt-sync')({ sigint: true });

// ===================== CONFIGURATION =====================
const CONFIG = {
    apiToken: '', // Will be prompted
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],
    initialStake: 1,
    growthRate: 0.05,
    takeProfit: 50,
    stopLoss: 100,
    survivalThreshold: 0.985,
    minWaitTime: 120000,
    maxWaitTime: 300000,
    volatilityUpperBound: 0.85,
    volatilityLowerBound: 0.35,
    maxConsecutiveLosses: 3,
};

// ===================== BOT CLASS =====================
class EnhancedAccumulatorBot {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.tradeInProgress = false;
        this.currentTradeId = null;
        this.currentStake = CONFIG.initialStake;

        // Stats
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalPnL = 0;
        this.consecutiveLosses = 0;
        this.pnlHistory = [];
        this.survival = {
            probability: 0,
            confidence: 0,
        };

        // Asset data
        this.assetData = {};
        CONFIG.assets.forEach(a => {
            this.assetData[a] = {
                tickHistory: [],
                extendedStayedIn: [],
                previousStayedIn: null,
                trades: [],
                volatility: { short: 0, medium: 0, long: 0 },
                regime: 'unknown',
                score: 0,
            };
        });

        this.riskManager = {
            cooldownUntil: 0,
            adaptiveThreshold: CONFIG.survivalThreshold,
        };
    }

    log(msg, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const icons = { success: '✓', error: '✗', warning: '⚠', trade: '↗', info: 'ℹ' };
        const colors = { success: 'green', error: 'red', warning: 'yellow', trade: 'cyan', info: 'white' };

        console.log(`${(`[${timestamp}]`)} ${colors[type]}${icons[type]} ${msg}`);
    }

    printHeader() {
        console.clear();
        console.log((('Deriv ACCU Bot', { font: 'Slant' })));
        console.log(('Enhanced Accumulator Bot v2.0 - Node.js Edition\n'));
    }

    printStats() {
        const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : 0;

        const stats = boxen(
            `${colors.cyan('Wins:')} ${colors.green(this.totalWins)}   ` +
            `${colors.cyan('Losses:')} ${colors.red(this.totalLosses)}   ` +
            `${colors.cyan('Win Rate:')} ${colors.yellow(winRate + '%')}\n` +
            `${colors.cyan('Total P/L:')} ${('$' + this.totalPnL.toFixed(2))}   ` +
            `${colors.cyan('Stake:')} ${colors.magenta('$' + this.currentStake.toFixed(2))}   ` +
            `${colors.cyan('Trades:')} ${this.totalTrades}`,
            // { padding: 1, borderColor: 'cyan', title: 'Trading Stats' }
        );
        console.log(stats);
    }

    connect() {
        this.printHeader();
        this.log('Connecting to Deriv WebSocket...', 'info');

        this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

        this.ws.on('open', () => {
            this.log('Connected! Authenticating...', 'success');
            this.ws.send(JSON.stringify({ authorize: CONFIG.apiToken }));
        });

        this.ws.on('message', (data) => {
            const msg = JSON.parse(data);
            this.handleMessage(msg);
        });

        this.ws.on('close', () => {
            this.log('Disconnected. Reconnecting in 5s...', 'warning');
            setTimeout(() => this.connect(), 5000);
        });

        this.ws.on('error', (err) => {
            this.log('WebSocket Error: ' + err.message, 'error');
        });
    }

    handleMessage(msg) {
        switch (msg.msg_type) {
            case 'authorize':
                if (msg.error) {
                    this.log('Auth failed: ' + msg.error.message, 'error');
                    process.exit(1);
                }
                this.log('Authenticated successfully!', 'success');
                this.subscribeToTicks();
                break;

            case 'tick':
                this.handleTick(msg.tick);
                break;

            case 'proposal':
                this.handleProposal(msg);
                break;

            case 'buy':
                this.handleBuy(msg);
                break;

            case 'proposal_open_contract':
                if (msg.proposal_open_contract?.is_sold) {
                    this.handleContractClose(msg.proposal_open_contract);
                }
                break;

            case 'history':
                this.handleHistory(msg);
                break;
        }
    }

    handleHistory(msg) {
        const asset = msg.echo_req.ticks_history;
        if (!this.assetData[asset]) return;

        const prices = msg.history.prices;
        if (prices && prices.length > 0) {
            prices.forEach(price => {
                const digit = this.getLastDigit(price, asset);
                this.assetData[asset].tickHistory.push(digit);
            });

            if (this.assetData[asset].tickHistory.length > 500) {
                this.assetData[asset].tickHistory = this.assetData[asset].tickHistory.slice(-500);
            }

            this.log(`Loaded ${prices.length} historical ticks for ${asset}`, 'success');
        }
    }

    subscribeToTicks() {
        CONFIG.assets.forEach(asset => {
            this.ws.send(JSON.stringify({
                ticks_history: asset,
                end: 'latest',
                count: 200,
                style: 'ticks',
                adjust_start_time: 1
            }));
            this.ws.send(JSON.stringify({ ticks: asset, subscribe: 1 }));
        });
        this.log(`Subscribed to ${CONFIG.assets.length} assets`, 'info');
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

    handleTick(tick) {
        const asset = tick.symbol;
        if (!this.assetData[asset]) return;

        const digit = this.getLastDigit(tick.quote, asset);
        const data = this.assetData[asset];
        data.tickHistory.push(digit);
        if (data.tickHistory.length > 500) data.tickHistory.shift();

        if (data.tickHistory.length >= 100 && !this.tradeInProgress) {
            this.analyzeAsset(asset);
        }
    }

    analyzeAsset(asset) {
        const h = this.assetData[asset].tickHistory;
        if (h.length < 100) return;

        // Volatility
        const vol = (arr) => {
            let changes = 0;
            for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1]) changes++;
            return changes / (arr.length - 1);
        };
        const v = {
            short: vol(h.slice(-20)),
            medium: vol(h.slice(-50)),
            long: vol(h.slice(-100))
        };
        this.assetData[asset].volatility = v;

        // Score (simplified)
        const avgVol = (v.short + v.medium) / 2;
        let score = 50;
        if (avgVol >= 0.4 && avgVol <= 0.7) score += 30;
        if (avgVol > 0.85 || avgVol < 0.3) score -= 25;
        this.assetData[asset].score = Math.max(0, Math.min(100, score));

        this.printAssetAnalysis(asset);
        if (this.shouldTrade(asset)) {
            this.requestProposal(asset);
        }
    }

    printAssetAnalysis(asset) {
        const d = this.assetData[asset];
        const avgVol = ((d.volatility.short + d.volatility.medium) / 2 * 100).toFixed(1);

        console.log((
            `${(asset)} → Score: ${(d.score.toFixed(0))} | Vol: ${avgVol}% | Survival: ${(this.survival.probability.toFixed(2) + '%')}`
        ));
    }

    shouldTrade(asset) {
        if (this.tradeInProgress) return false;
        if (Date.now() < this.riskManager.cooldownUntil) return false;
        const d = this.assetData[asset];
        const avgVol = ((d.volatility.short + d.volatility.medium) / 2 * 100).toFixed(1);
        return this.assetData[asset].score >= 50 && avgVol < 85;
    }

    requestProposal(asset) {
        this.ws.send(JSON.stringify({
            proposal: 1,
            amount: this.currentStake.toFixed(2),
            basis: "stake",
            contract_type: "ACCU",
            currency: "USD",
            symbol: asset,
            growth_rate: CONFIG.growthRate
        }));
    }

    handleProposal(msg) {
        if (msg.error) return this.log('Proposal error: ' + msg.error.message, 'error');
        const asset = msg.echo_req.symbol;
        const stayedIn = msg.proposal.contract_details.ticks_stayed_in;

        // Update extended history
        const prev = this.assetData[asset].previousStayedIn;
        if (prev && stayedIn[99] !== prev[99] + 1) {
            this.assetData[asset].extendedStayedIn.push(prev[99] + 1);
        }
        this.assetData[asset].previousStayedIn = stayedIn.slice();

        const survival = this.calculateSurvivalProbability(asset, stayedIn);
        this.survival = survival;
        const currentK = stayedIn[99] + 1;

        this.printTradeDecision(asset, survival, currentK);

        if (survival.probability >= this.riskManager.adaptiveThreshold && survival.confidence !== 'low') {
            this.placeTrade(asset, msg.proposal.id, survival);
        }
    }

    calculateSurvivalProbability(asset, stayedInArray) {
        const history = this.assetData[asset].extendedStayedIn;
        const currentK = stayedInArray[99] + 1;

        if (history.length < 30) return { probability: 0.5, confidence: 'low' };

        const freq = {};
        history.forEach(l => freq[l] = (freq[l] || 0) + 1);

        let survival = 1;
        let atRisk = history.length;
        for (let k = 1; k < currentK; k++) {
            const events = freq[k] || 0;
            survival *= (1 - events / atRisk);
            atRisk -= events;
        }

        const nextHazard = (freq[currentK] || 0) / atRisk || 0.1;
        const prob = 1 - nextHazard;

        return {
            probability: prob,
            confidence: history.length > 50 ? 'high' : history.length > 20 ? 'medium' : 'low'
        };
    }

    printTradeDecision(asset, survival, currentK) {
        console.log((`${(asset)}\n` + `KCount: ${currentK} → Survival: ${((survival.probability * 100).toFixed(2) + '%')}\n` + `Confidence: ${survival.confidence.toUpperCase()}`));
    }

    placeTrade(asset, proposalId, survival) {
        this.tradeInProgress = true;
        this.log(`PLACING TRADE on ${asset} | $${this.currentStake} | ${(survival.probability * 100).toFixed(2)}%`, 'trade');
        this.ws.send(JSON.stringify({ buy: proposalId, price: this.currentStake.toFixed(2) }));
    }

    handleBuy(msg) {
        if (msg.error) {
            this.log('Buy failed: ' + msg.error.message, 'error');
            this.tradeInProgress = false;
            return;
        }
        this.currentTradeId = msg.buy.contract_id;
        this.ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: this.currentTradeId, subscribe: 1 }));
    }

    handleContractClose(contract) {
        const won = contract.profit > 0;
        const profit = parseFloat(contract.profit);
        const asset = contract.underlying;

        this.totalTrades++;
        this.totalPnL += profit;
        this.pnlHistory.push(this.totalPnL);
        won ? this.totalWins++ : this.totalLosses++;
        this.consecutiveLosses = won ? 0 : this.consecutiveLosses + 1;

        if (won) {
            this.log(`WON $${profit.toFixed(2)} on ${asset} | Total: $${this.totalPnL.toFixed(2)}`, 'success');
            this.currentStake = CONFIG.initialStake;
        } else {
            this.log(`LOST $${Math.abs(profit).toFixed(2)} on ${asset}`, 'error');
            this.currentStake = this.consecutiveLosses >= 2 ? CONFIG.initialStake : CONFIG.initialStake * 2.5;
        }

        this.tradeInProgress = false;
        this.printStats();
        this.printRunLengthDistribution();

        // Stop conditions
        if (this.totalPnL >= CONFIG.takeProfit) {
            this.log('TAKE PROFIT REACHED! Stopping bot.', 'success');
            process.exit(0);
        }
        if (this.totalPnL <= -CONFIG.stopLoss || this.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
            this.log('STOP LOSS or MAX LOSSES! Stopping.', 'error');
            process.exit(0);
        }

        // Cooldown
        const wait = CONFIG.minWaitTime + Math.random() * (CONFIG.maxWaitTime - CONFIG.minWaitTime);
        this.riskManager.cooldownUntil = Date.now() + wait;
        this.log(`Waiting ${(wait / 1000).toFixed(0)}s before next trade...`, 'info');
    }

    printRunLengthDistribution() {
        const all = [];
        CONFIG.assets.forEach(a => all.push(...this.assetData[a].extendedStayedIn));
        if (all.length === 0) return;

        const freq = {};
        all.forEach(l => {
            const b = l > 15 ? '15+' : l;
            freq[b] = (freq[b] || 0) + 1;
        });

        let dist = 'Run Length Distribution: ';
        Object.keys(freq).sort((a, b) => a - b).forEach(k => {
            dist += `${k}: ${'█'.repeat(Math.min(freq[k] / 2, 20))} (${freq[k]})  `;
        });
        console.log((dist));
    }
}

// ===================== START BOT =====================
function start() {
    console.log(('Enhanced Deriv Accumulator Bot v2.0 (Node.js)\n'));
    CONFIG.apiToken = 'Dz2V2KvRf4Uukt3'; // prompt('Enter your Deriv API Token: ', { echo: '*' });

    const bot = new EnhancedAccumulatorBot();
    bot.connect();

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\nBot stopped by user.');
        process.exit();
    });
}

start();