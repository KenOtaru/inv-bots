// Deriv Trading Bot - Volatility 10 (1s) Index Price Action Strategy
// DISCLAIMER: This bot is for educational purposes. Trading involves risk. Test thoroughly on demo before live use.

const DerivAPI = require('@deriv/deriv-api').DerivAPI;

// ========== CONFIGURATION ==========
const CONFIG = {
    app_id: 'Dz2V2KvRf4Uukt3', // Replace with your Deriv app_id (get from api.deriv.com)
    token: 'your_token',   // Replace with your API token (demo account recommended)
    symbol: '1HZ10V',      // Volatility 10 (1s) Index
    stake: 5,              // $5 per trade
    multiplier: 50,        // 50x multiplier
    stop_loss: 5,          // $5 stop loss
    currency: 'USD',

    // Strategy parameters
    dailyOpenThreshold: 0.5,  // Pips threshold for daily open proximity
    h4CandlesForTrend: 7,     // Number of H4 candles to analyze for trend
    h4CandlesForTP: 10,       // Number of H4 candles to find TP zone
    h1CandlesForConfirm: 6,   // Number of H1 candles for trend confirmation
    smaPeriod: 20,            // SMA period for H4 trend filter

    // Polling intervals (milliseconds)
    checkInterval: 15000,     // Check for entry signals every 15 seconds
};

// ========== GLOBAL STATE ==========
let api;
let currentTrades = {}; // Track open trades by contract_id
let strategyState = {
    dailyOpen: null,
    previousDailyCandle: null,
    tpZone: null,
    isBullishTrend: false,
    lastCheckTime: 0
};

// ========== UTILITY FUNCTIONS ==========

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

function calculateSMA(candles, period) {
    if (candles.length < period) return null;
    const closes = candles.slice(-period).map(c => parseFloat(c.close));
    return closes.reduce((a, b) => a + b, 0) / period;
}

function isBullishCandle(candle) {
    return parseFloat(candle.close) > parseFloat(candle.open);
}

function isBearishCandle(candle) {
    return parseFloat(candle.close) < parseFloat(candle.open);
}

function getHighestHigh(candles) {
    return Math.max(...candles.map(c => parseFloat(c.high)));
}

function getLowestLow(candles) {
    return Math.min(...candles.map(c => parseFloat(c.low)));
}

// ========== API FUNCTIONS ==========

async function initializeAPI() {
    try {
        const connection = await api.basic.ping();
        log('Connected to Deriv API');

        const authResponse = await api.authorize(CONFIG.token);
        log(`Authorized as: ${authResponse.authorize.email} (Balance: ${authResponse.authorize.balance} ${authResponse.authorize.currency})`);

        return true;
    } catch (error) {
        log(`API initialization failed: ${error.message}`, 'ERROR');
        return false;
    }
}

async function fetchCandles(granularity, count = 20) {
    try {
        const response = await api.basic.sendRequest({
            ticks_history: CONFIG.symbol,
            adjust_start_time: 1,
            count: count,
            end: 'latest',
            granularity: granularity,
            style: 'candles'
        });

        if (response.error) {
            throw new Error(response.error.message);
        }

        return response.candles;
    } catch (error) {
        log(`Error fetching candles (granularity ${granularity}): ${error.message}`, 'ERROR');
        return null;
    }
}

async function buyMultiplierContract() {
    try {
        const proposal = await api.basic.sendRequest({
            proposal: 1,
            amount: CONFIG.stake,
            basis: 'stake',
            contract_type: 'MULTUP',
            currency: CONFIG.currency,
            symbol: CONFIG.symbol,
            multiplier: CONFIG.multiplier,
            limit_order: {
                stop_loss: CONFIG.stop_loss
            }
        });

        if (proposal.error) {
            throw new Error(proposal.error.message);
        }

        const buy = await api.basic.sendRequest({
            buy: proposal.proposal.id,
            price: CONFIG.stake
        });

        if (buy.error) {
            throw new Error(buy.error.message);
        }

        const contractId = buy.buy.contract_id;
        log(`✅ BUY TRADE OPENED - Contract ID: ${contractId}, Entry: ${buy.buy.buy_price}`, 'TRADE');

        // Store trade info
        currentTrades[contractId] = {
            id: contractId,
            entryPrice: parseFloat(buy.buy.buy_price),
            entryTime: Date.now(),
            tpZone: strategyState.tpZone
        };

        // Subscribe to contract updates
        subscribeToContract(contractId);

        return contractId;
    } catch (error) {
        log(`Error buying contract: ${error.message}`, 'ERROR');
        return null;
    }
}

async function sellContract(contractId) {
    try {
        const sell = await api.basic.sendRequest({
            sell: contractId,
            price: 0 // Sell at market price
        });

        if (sell.error) {
            throw new Error(sell.error.message);
        }

        const profit = parseFloat(sell.sell.sold_for) - currentTrades[contractId].entryPrice;
        log(`✅ TRADE CLOSED - Contract ID: ${contractId}, Profit: ${profit.toFixed(2)} ${CONFIG.currency}`, 'TRADE');

        delete currentTrades[contractId];
        return true;
    } catch (error) {
        log(`Error selling contract ${contractId}: ${error.message}`, 'ERROR');
        return false;
    }
}

function subscribeToContract(contractId) {
    api.basic.subscribeProposalOpenContract(contractId, (response) => {
        if (response.error) {
            log(`Contract subscription error: ${response.error.message}`, 'ERROR');
            return;
        }

        const contract = response.proposal_open_contract;
        const currentSpot = parseFloat(contract.current_spot);

        // Check if TP zone reached
        if (currentTrades[contractId] && strategyState.tpZone) {
            if (currentSpot >= strategyState.tpZone) {
                log(`🎯 TP ZONE REACHED - Current: ${currentSpot}, TP: ${strategyState.tpZone}`, 'TRADE');
                sellContract(contractId);
            }
        }

        // Check if contract is closed (e.g., stop loss hit)
        if (contract.status === 'sold' || contract.status === 'cancelled') {
            if (currentTrades[contractId]) {
                const profit = parseFloat(contract.profit || 0);
                log(`ℹ️ Contract ${contractId} closed automatically. Profit: ${profit.toFixed(2)}`, 'TRADE');
                delete currentTrades[contractId];
            }
        }
    });
}

// ========== STRATEGY LOGIC ==========

async function analyzeDailyCandles() {
    log('📊 Analyzing Daily (D1) candles...');
    const d1Candles = await fetchCandles(86400, 2);

    if (!d1Candles || d1Candles.length < 2) {
        log('Insufficient D1 candles', 'WARNING');
        return false;
    }

    const previousCandle = d1Candles[0];
    const currentCandle = d1Candles[1];

    strategyState.dailyOpen = parseFloat(currentCandle.open);
    strategyState.previousDailyCandle = previousCandle;

    const isBullish = isBullishCandle(previousCandle);
    log(`Previous Daily Candle: ${isBullish ? 'BULLISH' : 'BEARISH'} | Close: ${previousCandle.close}, Low: ${previousCandle.low}, High: ${previousCandle.high}`);
    log(`Current Daily Open: ${strategyState.dailyOpen}`);

    return true;
}

async function analyzeH4Trend() {
    log('📈 Analyzing H4 trend...');
    const h4Candles = await fetchCandles(14400, CONFIG.h4CandlesForTrend + 5);

    if (!h4Candles || h4Candles.length < CONFIG.h4CandlesForTrend) {
        log('Insufficient H4 candles', 'WARNING');
        return false;
    }

    // Check for uptrend: increasing closes over last 4 candles
    const recentCandles = h4Candles.slice(-4);
    let isUptrend = true;
    for (let i = 1; i < recentCandles.length; i++) {
        if (parseFloat(recentCandles[i].close) <= parseFloat(recentCandles[i - 1].close)) {
            isUptrend = false;
            break;
        }
    }

    // Check if price is above 20 SMA
    const sma20 = calculateSMA(h4Candles, CONFIG.smaPeriod);
    const currentPrice = parseFloat(h4Candles[h4Candles.length - 1].close);
    const aboveSMA = sma20 ? currentPrice > sma20 : true;

    // Check for higher swing lows (simplified: check last 5 lows are generally increasing)
    const last5Lows = h4Candles.slice(-5).map(c => parseFloat(c.low));
    let hasHigherLows = true;
    for (let i = 1; i < last5Lows.length - 1; i++) {
        if (last5Lows[i] < last5Lows[i - 1] - 0.5) { // Allow small variations
            hasHigherLows = false;
        }
    }

    const trendConfirmed = isUptrend && aboveSMA && hasHigherLows;

    log(`H4 Trend Analysis: Uptrend=${isUptrend}, Above SMA20=${aboveSMA}, Higher Lows=${hasHigherLows} => ${trendConfirmed ? '✅ BULLISH' : '❌ NO TREND'}`);

    // Calculate TP zone (highest high in last 10 H4 candles)
    const tpCandles = h4Candles.slice(-CONFIG.h4CandlesForTP);
    strategyState.tpZone = getHighestHigh(tpCandles);
    log(`TP Zone identified at: ${strategyState.tpZone}`);

    return trendConfirmed;
}

async function confirmH1Trend() {
    log('🔍 Confirming H1 trend...');
    const h1Candles = await fetchCandles(3600, CONFIG.h1CandlesForConfirm);

    if (!h1Candles || h1Candles.length < CONFIG.h1CandlesForConfirm) {
        log('Insufficient H1 candles', 'WARNING');
        return false;
    }

    // Check for increasing closes or higher lows
    const recentCandles = h1Candles.slice(-4);
    let isUptrend = true;
    for (let i = 1; i < recentCandles.length; i++) {
        if (parseFloat(recentCandles[i].close) < parseFloat(recentCandles[i - 1].close) - 0.3) {
            isUptrend = false;
            break;
        }
    }

    log(`H1 Trend Confirmation: ${isUptrend ? '✅ CONFIRMED' : '❌ NOT CONFIRMED'}`);
    return isUptrend;
}

async function checkM15Entry() {
    const m15Candles = await fetchCandles(900, 5);

    if (!m15Candles || m15Candles.length < 2) {
        return false;
    }

    const latestCandle = m15Candles[m15Candles.length - 1];
    const currentPrice = parseFloat(latestCandle.close);
    const candleLow = parseFloat(latestCandle.low);

    // Check if price is near daily open
    const distanceFromDailyOpen = Math.abs(currentPrice - strategyState.dailyOpen);
    const nearDailyOpen = distanceFromDailyOpen <= CONFIG.dailyOpenThreshold;

    // Check for bullish rejection at daily open
    const touchedDailyOpen = Math.abs(candleLow - strategyState.dailyOpen) <= CONFIG.dailyOpenThreshold;
    const isBullishRejection = isBullishCandle(latestCandle) && touchedDailyOpen;

    if (nearDailyOpen && isBullishRejection) {
        log(`🚀 ENTRY SIGNAL DETECTED - M15 bullish rejection at daily open (${strategyState.dailyOpen})`, 'SIGNAL');
        return true;
    }

    return false;
}

// ========== MAIN STRATEGY LOOP ==========

async function runStrategyCheck() {
    try {
        const now = Date.now();

        // Prevent too frequent checks
        if (now - strategyState.lastCheckTime < CONFIG.checkInterval) {
            return;
        }
        strategyState.lastCheckTime = now;

        log('==================== STRATEGY CHECK ====================');

        // Step 1: Analyze daily candles for key levels
        const dailySuccess = await analyzeDailyCandles();
        if (!dailySuccess) return;

        // Step 2: Check H4 trend
        const h4Bullish = await analyzeH4Trend();
        if (!h4Bullish) {
            log('⚠️ H4 trend not bullish. Skipping entry check.', 'WARNING');
            strategyState.isBullishTrend = false;
            return;
        }

        // Step 3: Confirm on H1
        const h1Confirmed = await confirmH1Trend();
        if (!h1Confirmed) {
            log('⚠️ H1 trend not confirmed. Skipping entry check.', 'WARNING');
            strategyState.isBullishTrend = false;
            return;
        }

        strategyState.isBullishTrend = true;
        log('✅ BULLISH TREND CONFIRMED on H4 and H1');

        // Step 4: Check for M15 entry signal
        const entrySignal = await checkM15Entry();

        if (entrySignal) {
            // Limit concurrent trades (optional, adjust as needed)
            const maxConcurrentTrades = 3;
            if (Object.keys(currentTrades).length < maxConcurrentTrades) {
                await buyMultiplierContract();
            } else {
                log(`⚠️ Max concurrent trades (${maxConcurrentTrades}) reached. Skipping entry.`, 'WARNING');
            }
        }

        log('========================================================');

    } catch (error) {
        log(`Strategy check error: ${error.message}`, 'ERROR');
    }
}

// ========== BOT INITIALIZATION AND MAIN LOOP ==========

async function startBot() {
    log('========================================');
    log('  DERIV TRADING BOT - VOLATILITY 10');
    log('  Price Action Strategy (MULTUP)');
    log('========================================');
    log('⚠️  WARNING: Test on DEMO account first!');
    log('========================================');

    // Initialize API connection
    api = new DerivAPI({ app_id: CONFIG.app_id });

    const initialized = await initializeAPI();
    if (!initialized) {
        log('Failed to initialize. Exiting.', 'ERROR');
        process.exit(1);
    }

    log('🤖 Bot started successfully. Monitoring market...');
    log(`Symbol: ${CONFIG.symbol}, Stake: $${CONFIG.stake}, Multiplier: ${CONFIG.multiplier}x, Stop Loss: $${CONFIG.stop_loss}`);

    // Run initial strategy check
    await runStrategyCheck();

    // Set up recurring strategy checks
    setInterval(async () => {
        await runStrategyCheck();
    }, CONFIG.checkInterval);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        log('\n🛑 Shutting down bot...');

        // Close any open trades
        const openTradeIds = Object.keys(currentTrades);
        if (openTradeIds.length > 0) {
            log(`Closing ${openTradeIds.length} open trade(s)...`);
            for (const tradeId of openTradeIds) {
                await sellContract(tradeId);
            }
        }

        log('Bot stopped. Goodbye!');
        process.exit(0);
    });
}

// Start the bot
startBot().catch(error => {
    log(`Fatal error: ${error.message}`, 'ERROR');
    process.exit(1);
});