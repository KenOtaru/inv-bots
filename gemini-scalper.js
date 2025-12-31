/**
 * Deriv Multiplier Grid Scalper Bot
 * 
 * DISCLAIMER:
 * This software is for educational purposes only. Do not risk money you cannot afford to lose.
 * The author is not responsible for financial losses incurred by using this software.
 * ALWAYS TEST ON A DEMO ACCOUNT FIRST.
 */

require('dotenv').config();
const WebSocket = require('ws');

// --- CONFIGURATION ---
const CONFIG = {
    symbol: 'R_100',          // Volatility 100 Index (Example)
    stake: 10,                // Stake amount in USD
    multiplier: 100,          // Multiplier value
    gridStep: 2.5,            // Price movement required to trigger next trade
    takeProfitAmt: 5.0,       // Take profit in USD
    stopLossAmt: 2.0,         // Stop loss in USD
    maxActiveTrades: 3,       // Safety limit
    tradingEnabled: true      // Master switch
};

class DerivBot {
    constructor() {
        this.ws = null;
        this.token = process.env.DERIV_TOKEN;
        this.appId = process.env.APP_ID || 1089;
        this.pingInterval = null;

        // State
        this.lastPrice = 0;
        this.referencePrice = 0; // The price of the last action
        this.activeContracts = 0; // Legacy counter, kept for safety but map is better
        this.balance = 0;
        this.currency = 'USD';

        // Tracking
        this.activeTrades = new Map();
        this.completedTrades = 0;
        this.totalProfit = 0.0;
        this.wins = 0;
        this.losses = 0;
    }

    /**
     * Initialize connection and listeners
     */
    start() {
        if (!this.token) {
            this.log('ERROR', 'API Token not found in .env file.');
            process.exit(1);
        }

        const url = `wss://ws.binaryws.com/websockets/v3?app_id=${this.appId}`;
        this.ws = new WebSocket(url);

        this.ws.on('open', () => this.onOpen());
        this.ws.on('message', (data) => this.onMessage(data));
        this.ws.on('error', (err) => this.log('ERROR', err.message));
        this.ws.on('close', () => {
            this.log('WARN', 'Connection closed. Reconnecting in 5s...');
            clearInterval(this.pingInterval);
            setTimeout(() => this.start(), 5000);
        });
    }

    /**
     * Handle Connection Open
     */
    onOpen() {
        this.log('INFO', 'Connected to Deriv WebSocket.');
        this.authorize();
        this.startHeartbeat();
    }

    /**
     * Handle Incoming Messages
     */
    onMessage(data) {
        const msg = JSON.parse(data);

        if (msg.error) {
            this.log('ERROR', `${msg.error.code}: ${msg.error.message}`);
            // If authorization fails, exit
            if (msg.error.code === 'InvalidToken') process.exit(1);
            return;
        }

        switch (msg.msg_type) {
            case 'authorize':
                this.handleAuth(msg);
                break;
            case 'tick':
                this.handleTick(msg);
                break;
            case 'buy':
                this.handleBuy(msg);
                break;
            case 'proposal': // Optional: if you want to check payout before buying
                this.handleProposal(msg);
                break;
            case 'proposal_open_contract':
                this.handleOpenContract(msg);
                break;
        }
    }

    /**
     * Authorize the session
     */
    authorize() {
        this.ws.send(JSON.stringify({ authorize: this.token }));
    }

    /**
     * Handle Authorization Response
     */
    handleAuth(msg) {
        this.balance = msg.authorize.balance;
        this.currency = msg.authorize.currency;
        this.log('SUCCESS', `Logged in. Balance: ${this.balance} ${this.currency}`);

        // Subscribe to ticks for the configured symbol
        this.subscribeTicks();
    }

    /**
     * Subscribe to market data
     */
    subscribeTicks() {
        this.ws.send(JSON.stringify({
            ticks: CONFIG.symbol,
            subscribe: 1
        }));
        this.log('INFO', `Subscribed to ${CONFIG.symbol}`);
    }

    /**
     * Core Trading Logic: Grid Strategy
     */
    handleTick(msg) {
        const currentPrice = msg.tick.quote;

        // Initialize reference price on startup
        if (this.referencePrice === 0) {
            this.referencePrice = currentPrice;
            this.log('INFO', `Baseline price set to ${this.referencePrice}`);
            return;
        }

        const diff = currentPrice - this.referencePrice;

        // Log heartbeat periodically or on significant movement
        // (Reducing log spam for production readiness)

        if (!CONFIG.tradingEnabled) return;
        if (this.activeContracts >= CONFIG.maxActiveTrades) return;

        // --- GRID LOGIC ---
        // If price moves UP by gridStep -> Sell (Counter-trend/Mean Reversion) or Buy (Trend Following)
        // Here we implement a Scalping Mean Reversion (Selling into strength, Buying into weakness)

        this.log(`Diff: ${diff.toFixed(2)} | GridStep: ${CONFIG.gridStep}`);

        if (Math.abs(diff) >= CONFIG.gridStep || Math.abs(diff) <= -CONFIG.gridStep) {
            this.log('INFO', `Grid Trigger: Price moved from ${this.referencePrice} to ${currentPrice} (Diff: ${diff.toFixed(2)})`);

            if (diff > 0) {
                // Price went UP, we assume it might pull back slightly -> SELL (Put)
                // Note: For Multipliers, "Down" is the contract type for shorting.
                this.placeTrade('CALL', currentPrice);
            } else {
                // Price went DOWN, we assume a bounce -> BUY (Call)
                this.placeTrade('PUT', currentPrice);
            }

            // Reset reference price to current to create the new grid baseline
            this.referencePrice = currentPrice;
        }
    }

    /**
     * Execute Trade
     */
    placeTrade(contractType, currentPrice) {
        // Multiplier contract parameters
        // 'UP' for Call, 'DOWN' for Put in some API contexts, but usually 'CALL'/'PUT' works for vanilla.
        // For Multipliers specifically, contract_type is 'MULTUP' or 'MULTDOWN'.

        const type = contractType === 'CALL' ? 'MULTUP' : 'MULTDOWN';

        const proposalRequest = {
            proposal: 1,
            amount: CONFIG.stake,
            basis: 'stake',
            contract_type: type,
            currency: this.currency,
            symbol: CONFIG.symbol,
            multiplier: CONFIG.multiplier,
            limit_order: {
                take_profit: CONFIG.takeProfitAmt,
                stop_loss: CONFIG.stopLossAmt
            }
        };

        this.log('ACTION', `Requesting proposal for ${type} at ${currentPrice}...`);
        this.ws.send(JSON.stringify(proposalRequest));
    }

    /**
     * Handle Proposal Response and Execute Buy
     */
    handleProposal(msg) {
        const proposal = msg.proposal;
        this.log('INFO', `Proposal ID: ${proposal.id} | Spot: ${proposal.spot}`);

        const buyRequest = {
            buy: proposal.id,
            price: proposal.ask_price
        };

        this.ws.send(JSON.stringify(buyRequest));
    }

    /**
     * Handle Buy Confirmation
     */
    handleBuy(msg) {
        const result = msg.buy;
        const contractId = result.contract_id;

        this.activeContracts++;
        this.log('SUCCESS', `Trade executed! ID: ${contractId}, Price: ${result.buy_price}`);

        // Track the trade
        this.activeTrades.set(contractId, {
            id: contractId,
            entryPrice: result.buy_price,
            profit: 0,
            status: 'OPEN'
        });

        // Subscribe to updates for this contract
        this.ws.send(JSON.stringify({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        }));
    }

    /**
     * Handle Open Contract Updates (P&L and Closure)
     */
    handleOpenContract(msg) {
        const contract = msg.proposal_open_contract;
        if (!this.activeTrades.has(contract.contract_id)) return;

        const trade = this.activeTrades.get(contract.contract_id);
        const profit = parseFloat(contract.profit);
        trade.profit = profit;

        // Check if trade is closed
        if (contract.is_sold) {
            this.activeTrades.delete(contract.contract_id);
            this.activeContracts--;
            if (this.activeContracts < 0) this.activeContracts = 0;

            this.completedTrades++;
            this.totalProfit += profit;

            if (profit > 0) this.wins++;
            else this.losses++;

            const result = profit >= 0 ? 'WIN' : 'LOSS';
            this.log(result === 'WIN' ? 'SUCCESS' : 'WARN', `Trade Closed [${result}]: $${profit.toFixed(2)} | Total P&L: $${this.totalProfit.toFixed(2)}`);
        } else {
            // Periodic status update (not on every tick to avoid spam)
            this.logStatus();
        }
    }

    /**
     * Periodic Status Log
     */
    logStatus() {
        const now = Date.now();
        if (now - (this.lastLogTime || 0) < 10000) return; // limit to once every 10s
        this.lastLogTime = now;

        const activeCount = this.activeTrades.size;
        let runningPnL = 0;
        this.activeTrades.forEach(t => runningPnL += t.profit);

        this.log('INFO', `STATUS: Active: ${activeCount} ($${runningPnL.toFixed(2)}) | Completed: ${this.completedTrades} (W:${this.wins}/L:${this.losses}) | Total P&L: $${this.totalProfit.toFixed(2)}`);
    }

    /**
     * Helper: Heartbeat to keep connection alive
     */
    startHeartbeat() {
        this.pingInterval = setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ ping: 1 }));
            }
        }, 10000); // 10 seconds
    }

    /**
     * Helper: Standardized Logging
     */
    log(level, message) {
        const timestamp = new Date().toISOString();
        const color = level === 'ERROR' ? '\x1b[31m' : level === 'SUCCESS' ? '\x1b[32m' : level === 'WARN' ? '\x1b[33m' : '\x1b[37m';
        const reset = '\x1b[0m';
        console.log(`[${timestamp}] ${color}[${level}]${reset} ${message}`);
    }
}

// Instantiate and start
const bot = new DerivBot();
bot.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nStopping bot...');
    process.exit();
});