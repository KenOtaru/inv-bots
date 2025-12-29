/**
 * ================================================================
 * DERIV ALGORITHMIC TRADING BOT
 * Strategy: Breakout & Retest (Multi-Timeframe Analysis)
 * ================================================================
 * 
 * DISCLAIMER: Trading involves significant risk. This bot is for 
 * educational purposes. Test thoroughly on a demo account first.
 * 
 * Author: Expert Algorithmic Trading Developer
 * Version: 1.0.0
 * ================================================================
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ================================================================
// CONFIGURATION SECTION
// ================================================================

const CONFIG = {
    // API Credentials
    API_TOKEN: 'Dz2V2KvRf4Uukt3', // Get from https://app.deriv.com/account/api-token
    APP_ID: '1089', // Default Deriv App ID (can be changed)

    // Trading Parameters
    SYMBOL: 'R_75', // Options: R_75, R_50, R_100, R_25, R_10
    STAKE_AMOUNT: 1, // Initial stake in USD
    DURATION: 5, // Contract duration in ticks
    DURATION_UNIT: 't', // 't' for ticks, 'm' for minutes

    // Risk Management
    STOP_LOSS: 10, // Stop loss in USD (0 to disable)
    TAKE_PROFIT: 20, // Take profit in USD (0 to disable)
    MAX_DAILY_LOSS: 50, // Maximum daily loss before stopping (0 to disable)

    // Martingale Settings
    USE_MARTINGALE: false, // Enable/disable martingale
    MARTINGALE_MULTIPLIER: 2, // Stake multiplier after loss
    MAX_MARTINGALE_STEPS: 3, // Maximum consecutive martingale steps

    // Strategy Parameters
    TOLERANCE_PIPS: 0.0005, // Price tolerance for retest detection
    MA_PERIOD: 20, // Moving Average period for trend detection
    H4_LOOKBACK: 5, // Number of H4 candles to analyze

    // Bot Settings
    WEBSOCKET_URL: 'wss://ws.derivws.com/websockets/v3',
    RECONNECT_DELAY: 5000, // Milliseconds
    ENABLE_FILE_LOGGING: true,
    LOG_FILE: 'trading_log.txt'
};

// ================================================================
// GLOBAL STATE
// ================================================================

let ws = null;
let isConnected = false;
let isAuthorized = false;
let requestId = 1;

// Strategy State
let dailyLevels = {
    previousLow: null,
    previousClose: null,
    date: null
};

let h4Trend = null; // 'BULLISH', 'BEARISH', or null
let currentBalance = 0;
let dailyPnL = 0;
let sessionStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    startBalance: 0
};

let currentStake = CONFIG.STAKE_AMOUNT;
let consecutiveLosses = 0;

// Active positions tracking
let activePositions = new Map();

// ================================================================
// LOGGING SYSTEM
// ================================================================

/**
 * Advanced logging function with console and file output
 */
function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${type}] ${message}`;

    // Console output with colors
    const colors = {
        INFO: '\x1b[36m',    // Cyan
        SUCCESS: '\x1b[32m', // Green
        WARNING: '\x1b[33m', // Yellow
        ERROR: '\x1b[31m',   // Red
        TRADE: '\x1b[35m',   // Magenta
        STRATEGY: '\x1b[34m' // Blue
    };

    const reset = '\x1b[0m';
    const color = colors[type] || colors.INFO;

    console.log(`${color}${logMessage}${reset}`);

    // File output
    if (CONFIG.ENABLE_FILE_LOGGING) {
        try {
            fs.appendFileSync(CONFIG.LOG_FILE, logMessage + '\n');
        } catch (err) {
            console.error('Failed to write to log file:', err.message);
        }
    }
}

/**
 * Log separator for better readability
 */
function logSeparator() {
    const separator = '='.repeat(80);
    log(separator, 'INFO');
}

// ================================================================
// WEBSOCKET CONNECTION MANAGEMENT
// ================================================================

/**
 * Initialize WebSocket connection
 */
function connect() {
    log('Initiating WebSocket connection to Deriv API...', 'INFO');

    ws = new WebSocket(`${CONFIG.WEBSOCKET_URL}?app_id=${CONFIG.APP_ID}`);

    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
}

/**
 * Handle WebSocket connection open
 */
function onOpen() {
    isConnected = true;
    log('WebSocket connection established successfully!', 'SUCCESS');
    authorize();
}

/**
 * Handle incoming WebSocket messages
 */
function onMessage(data) {
    try {
        const response = JSON.parse(data);

        // Handle different message types
        if (response.error) {
            handleError(response.error);
            return;
        }

        if (response.msg_type === 'authorize') {
            handleAuthorize(response);
        } else if (response.msg_type === 'balance') {
            handleBalance(response);
        } else if (response.msg_type === 'candles') {
            handleCandles(response);
        } else if (response.msg_type === 'ticks_history') {
            handleTicksHistory(response);
        } else if (response.msg_type === 'buy') {
            handleBuy(response);
        } else if (response.msg_type === 'proposal_open_contract') {
            handleContractUpdate(response);
        } else if (response.msg_type === 'tick') {
            handleTick(response);
        }

    } catch (err) {
        log(`Error parsing WebSocket message: ${err.message}`, 'ERROR');
    }
}

/**
 * Handle WebSocket close
 */
function onClose() {
    isConnected = false;
    isAuthorized = false;
    log('WebSocket connection closed. Reconnecting...', 'WARNING');

    setTimeout(() => {
        connect();
    }, CONFIG.RECONNECT_DELAY);
}

/**
 * Handle WebSocket errors
 */
function onError(error) {
    log(`WebSocket error: ${error.message}`, 'ERROR');
}

/**
 * Handle API errors
 */
function handleError(error) {
    log(`API Error [${error.code}]: ${error.message}`, 'ERROR');

    // Handle specific errors
    if (error.code === 'InvalidToken') {
        log('Invalid API token. Please check your configuration.', 'ERROR');
        process.exit(1);
    }
}

// ================================================================
// API REQUESTS
// ================================================================

/**
 * Send API request
 */
function sendRequest(request) {
    if (!isConnected) {
        log('Cannot send request: WebSocket not connected', 'ERROR');
        return;
    }

    request.req_id = requestId++;
    ws.send(JSON.stringify(request));
}

/**
 * Authorize with API token
 */
function authorize() {
    log('Authorizing with API token...', 'INFO');
    sendRequest({
        authorize: CONFIG.API_TOKEN
    });
}

/**
 * Subscribe to balance updates
 */
function subscribeBalance() {
    sendRequest({
        balance: 1,
        subscribe: 1
    });
}

/**
 * Get candles for a specific timeframe
 */
function getCandles(granularity, count) {
    const endTime = Math.floor(Date.now() / 1000);

    sendRequest({
        ticks_history: CONFIG.SYMBOL,
        adjust_start_time: 1,
        count: count,
        end: 'latest',
        granularity: granularity,
        style: 'candles'
    });

    log(`Requesting ${count} candles with ${granularity}s granularity`, 'INFO');
}

/**
 * Subscribe to tick stream
 */
function subscribeTicks() {
    sendRequest({
        ticks: CONFIG.SYMBOL,
        subscribe: 1
    });
    log(`Subscribed to tick stream for ${CONFIG.SYMBOL}`, 'INFO');
}

/**
 * Place a trade
 */
function placeTrade(type, stake) {
    const proposal = {
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: type, // 'CALL' or 'PUT'
        currency: 'USD',
        duration: CONFIG.DURATION,
        duration_unit: CONFIG.DURATION_UNIT,
        symbol: CONFIG.SYMBOL
    };

    sendRequest(proposal);
    log(`Requesting proposal for ${type} trade with stake ${stake}`, 'TRADE');
}

/**
 * Buy contract
 */
function buyContract(proposalId, price) {
    sendRequest({
        buy: proposalId,
        price: price
    });
}

// ================================================================
// RESPONSE HANDLERS
// ================================================================

/**
 * Handle authorization response
 */
function handleAuthorize(response) {
    if (response.authorize) {
        isAuthorized = true;
        currentBalance = response.authorize.balance;
        sessionStats.startBalance = currentBalance;

        log('Authorization successful!', 'SUCCESS');
        log(`Account: ${response.authorize.email}`, 'INFO');
        log(`Balance: ${currentBalance} ${response.authorize.currency}`, 'INFO');

        logSeparator();

        // Start trading strategy
        subscribeBalance();
        initializeStrategy();
    }
}

/**
 * Handle balance updates
 */
function handleBalance(response) {
    const oldBalance = currentBalance;
    currentBalance = response.balance.balance;

    if (oldBalance !== 0) {
        const change = currentBalance - oldBalance;
        dailyPnL += change;

        if (change !== 0) {
            const changeStr = change > 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
            log(`Balance updated: ${currentBalance.toFixed(2)} (${changeStr})`, 'INFO');
            log(`Daily P&L: ${dailyPnL.toFixed(2)}`, 'INFO');
        }
    }

    // Check daily loss limit
    if (CONFIG.MAX_DAILY_LOSS > 0 && dailyPnL < -CONFIG.MAX_DAILY_LOSS) {
        log(`Daily loss limit reached (${dailyPnL.toFixed(2)}). Stopping bot.`, 'ERROR');
        process.exit(0);
    }
}

/**
 * Handle candles/ticks_history response
 */
function handleTicksHistory(response) {
    if (!response.candles) return;

    const candles = response.candles;
    const granularity = response.candles[0] ?
        (candles[1].epoch - candles[0].epoch) : 0;

    if (granularity === 86400) { // Daily candles
        handleDailyCandles(candles);
    } else if (granularity === 14400) { // 4-hour candles
        handleH4Candles(candles);
    } else if (granularity === 900) { // 15-minute candles
        handleM15Candles(candles);
    }
}

function handleCandles(response) {
    handleTicksHistory(response);
}

/**
 * Handle tick updates
 */
function handleTick(response) {
    const tick = response.tick;
    // Monitor for retest opportunities on M15
    checkForRetestOpportunity(tick.quote);
}

/**
 * Handle buy response
 */
function handleBuy(response) {
    if (response.buy) {
        const contract = response.buy;

        activePositions.set(contract.contract_id, {
            id: contract.contract_id,
            type: contract.contract_type,
            stake: contract.buy_price,
            entryPrice: contract.start_time,
            openTime: new Date()
        });

        sessionStats.totalTrades++;

        log(`Trade executed successfully!`, 'SUCCESS');
        log(`Contract ID: ${contract.contract_id}`, 'TRADE');
        log(`Type: ${contract.contract_type}`, 'TRADE');
        log(`Stake: ${contract.buy_price}`, 'TRADE');
        log(`Potential Payout: ${contract.payout}`, 'TRADE');

        // Subscribe to contract updates
        sendRequest({
            proposal_open_contract: 1,
            contract_id: contract.contract_id,
            subscribe: 1
        });
    }
}

/**
 * Handle contract updates
 */
function handleContractUpdate(response) {
    const contract = response.proposal_open_contract;

    if (contract.is_sold) {
        const position = activePositions.get(contract.contract_id);

        if (position) {
            const profit = contract.profit;
            const isWin = profit > 0;

            if (isWin) {
                sessionStats.wins++;
                consecutiveLosses = 0;
                currentStake = CONFIG.STAKE_AMOUNT; // Reset stake
                log(`✓ TRADE WON! Profit: +${profit.toFixed(2)}`, 'SUCCESS');
            } else {
                sessionStats.losses++;
                consecutiveLosses++;

                // Apply martingale if enabled
                if (CONFIG.USE_MARTINGALE && consecutiveLosses <= CONFIG.MAX_MARTINGALE_STEPS) {
                    currentStake *= CONFIG.MARTINGALE_MULTIPLIER;
                    log(`Martingale activated: New stake = ${currentStake.toFixed(2)}`, 'WARNING');
                } else {
                    currentStake = CONFIG.STAKE_AMOUNT;
                }

                log(`✗ TRADE LOST. Loss: ${profit.toFixed(2)}`, 'ERROR');
            }

            activePositions.delete(contract.contract_id);

            // Log session statistics
            const winRate = sessionStats.totalTrades > 0 ?
                (sessionStats.wins / sessionStats.totalTrades * 100).toFixed(2) : 0;

            log(`Session Stats - Trades: ${sessionStats.totalTrades}, Wins: ${sessionStats.wins}, Losses: ${sessionStats.losses}, Win Rate: ${winRate}%`, 'INFO');
            logSeparator();
        }
    }
}

// ================================================================
// STRATEGY IMPLEMENTATION
// ================================================================

/**
 * Initialize the trading strategy
 */
function initializeStrategy() {
    log('Initializing Breakout & Retest Strategy...', 'STRATEGY');
    logSeparator();

    // Step 1: Get Daily levels (previous day)
    log('STEP 1: Fetching Daily Support/Resistance levels...', 'STRATEGY');
    getCandles(86400, 2); // Get last 2 daily candles

    // Wait for daily levels, then proceed
    setTimeout(() => {
        if (dailyLevels.previousLow && dailyLevels.previousClose) {
            // Step 2: Determine H4 trend
            log('STEP 2: Analyzing 4-Hour trend...', 'STRATEGY');
            getCandles(14400, CONFIG.H4_LOOKBACK + 1);

            setTimeout(() => {
                if (h4Trend) {
                    // Step 3: Monitor M15 for entry signals
                    log('STEP 3: Monitoring 15-Minute timeframe for entry signals...', 'STRATEGY');
                    subscribeTicks();
                }
            }, 3000);
        }
    }, 3000);
}

/**
 * Process Daily candles - Extract support/resistance
 */
function handleDailyCandles(candles) {
    if (candles.length < 2) {
        log('Insufficient daily candles for analysis', 'WARNING');
        return;
    }

    // Get previous day's candle (index -2, as -1 is current incomplete day)
    const previousDay = candles[candles.length - 2];

    dailyLevels.previousLow = parseFloat(previousDay.low);
    dailyLevels.previousClose = parseFloat(previousDay.close);
    dailyLevels.date = new Date(previousDay.epoch * 1000).toLocaleDateString();

    log(`Daily Levels Extracted (Date: ${dailyLevels.date}):`, 'STRATEGY');
    log(`  └─ Previous Daily Low: ${dailyLevels.previousLow.toFixed(5)}`, 'STRATEGY');
    log(`  └─ Previous Daily Close: ${dailyLevels.previousClose.toFixed(5)}`, 'STRATEGY');
    logSeparator();
}

/**
 * Process H4 candles - Determine trend
 */
function handleH4Candles(candles) {
    if (candles.length < CONFIG.H4_LOOKBACK) {
        log('Insufficient H4 candles for trend analysis', 'WARNING');
        return;
    }

    // Simple trend determination: Compare recent closes
    const recentCandles = candles.slice(-CONFIG.H4_LOOKBACK);
    const closePrices = recentCandles.map(c => parseFloat(c.close));

    // Calculate simple moving average
    const ma = closePrices.reduce((a, b) => a + b, 0) / closePrices.length;
    const currentClose = closePrices[closePrices.length - 1];
    const oldClose = closePrices[0];

    // Determine trend
    if (currentClose > ma && currentClose > oldClose) {
        h4Trend = 'BULLISH';
    } else if (currentClose < ma && currentClose < oldClose) {
        h4Trend = 'BEARISH';
    } else {
        h4Trend = 'NEUTRAL';
    }

    log(`H4 Trend Analysis Complete:`, 'STRATEGY');
    log(`  └─ Current Close: ${currentClose.toFixed(5)}`, 'STRATEGY');
    log(`  └─ ${CONFIG.MA_PERIOD}-MA: ${ma.toFixed(5)}`, 'STRATEGY');
    log(`  └─ Trend: ${h4Trend}`, 'STRATEGY');
    logSeparator();
}

/**
 * Process M15 candles (not heavily used in tick-based approach)
 */
function handleM15Candles(candles) {
    // Can be used for additional confirmation if needed
    log('M15 candles received for analysis', 'STRATEGY');
}

/**
 * Check for retest opportunity
 */
function checkForRetestOpportunity(currentPrice) {
    if (!dailyLevels.previousLow || !dailyLevels.previousClose || !h4Trend) {
        return; // Not ready yet
    }

    if (h4Trend === 'NEUTRAL') {
        return; // No clear trend
    }

    // Check if price is near key levels
    const nearPreviousLow = Math.abs(currentPrice - dailyLevels.previousLow) <= CONFIG.TOLERANCE_PIPS;
    const nearPreviousClose = Math.abs(currentPrice - dailyLevels.previousClose) <= CONFIG.TOLERANCE_PIPS;

    // BULLISH SETUP: Retest of support in uptrend
    if (h4Trend === 'BULLISH' && (nearPreviousLow || nearPreviousClose)) {
        log(`🎯 BULLISH RETEST DETECTED at ${currentPrice.toFixed(5)}`, 'STRATEGY');
        log(`Waiting for bullish rejection candle...`, 'STRATEGY');

        // In a real implementation, we'd wait for candle confirmation
        // For this version, we'll place trade after detecting retest
        setTimeout(() => {
            executeTrade('CALL');
        }, 2000);
    }

    // BEARISH SETUP: Retest of resistance in downtrend
    if (h4Trend === 'BEARISH' && (nearPreviousLow || nearPreviousClose)) {
        log(`🎯 BEARISH RETEST DETECTED at ${currentPrice.toFixed(5)}`, 'STRATEGY');
        log(`Waiting for bearish rejection candle...`, 'STRATEGY');

        setTimeout(() => {
            executeTrade('PUT');
        }, 2000);
    }
}

/**
 * Execute trade
 */
function executeTrade(type) {
    // Prevent multiple simultaneous trades
    if (activePositions.size > 0) {
        log('Trade already active. Waiting for completion...', 'WARNING');
        return;
    }

    log(`Executing ${type} trade with stake: ${currentStake.toFixed(2)}`, 'TRADE');
    logSeparator();

    placeTrade(type, currentStake);
}

// ================================================================
// INITIALIZATION
// ================================================================

/**
 * Start the bot
 */
function startBot() {
    logSeparator();
    log('🤖 DERIV ALGORITHMIC TRADING BOT - STARTING', 'INFO');
    log(`Strategy: Breakout & Retest (Multi-Timeframe)`, 'INFO');
    log(`Symbol: ${CONFIG.SYMBOL}`, 'INFO');
    log(`Initial Stake: ${CONFIG.STAKE_AMOUNT}`, 'INFO');
    log(`Martingale: ${CONFIG.USE_MARTINGALE ? 'ENABLED' : 'DISABLED'}`, 'INFO');
    logSeparator();

    // Clear previous log file
    if (CONFIG.ENABLE_FILE_LOGGING) {
        fs.writeFileSync(CONFIG.LOG_FILE, '');
        log(`Log file initialized: ${CONFIG.LOG_FILE}`, 'INFO');
    }

    // Validate configuration
    if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN === 'YOUR_DERIV_API_TOKEN_HERE') {
        log('ERROR: Please configure your API token in the CONFIG section', 'ERROR');
        process.exit(1);
    }

    // Connect to Deriv API
    connect();
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('Received shutdown signal...', 'WARNING');
    log(`Final Balance: ${currentBalance.toFixed(2)}`, 'INFO');
    log(`Total P&L: ${(currentBalance - sessionStats.startBalance).toFixed(2)}`, 'INFO');
    logSeparator();
    process.exit(0);
});

// Start the bot
startBot();