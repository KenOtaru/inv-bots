// Deriv Trading Bot - Multi-Asset 1s Index Price Action Strategy
// DISCLAIMER: This bot is for educational purposes. Trading involves risk. Test thoroughly on demo before live use.

const DerivAPI = require('@deriv/deriv-api/dist/DerivAPI');

// ========== CONFIGURATION ==========
const CONFIG = {
    app_id: '1089', // Replace with your Deriv app_id (get from api.deriv.com)
    token: 'Dz2V2KvRf4Uukt3',   // Replace with your API token (demo account recommended)

    // MULTI-ASSET CONFIGURATION
    symbols: [
        { name: '1HZ10V', label: 'Volatility 10 (1s)', enabled: true },
        { name: '1HZ25V', label: 'Volatility 25 (1s)', enabled: true },
        { name: '1HZ50V', label: 'Volatility 50 (1s)', enabled: true },
        { name: '1HZ75V', label: 'Volatility 75 (1s)', enabled: false },
        { name: '1HZ100V', label: 'Volatility 100 (1s)', enabled: false }
    ],

    stake: 5,              // $5 per trade per symbol
    multiplier: 50,        // 50x multiplier
    stop_loss: 5,          // $5 stop loss
    currency: 'USD',

    // Strategy parameters (applied to all symbols)
    dailyOpenThreshold: 0.5,  // Pips threshold for daily open proximity
    h4CandlesForTrend: 7,     // Number of H4 candles to analyze for trend
    h4CandlesForTP: 10,       // Number of H4 candles to find TP zone
    h1CandlesForConfirm: 6,   // Number of H1 candles for trend confirmation
    smaPeriod: 20,            // SMA period for H4 trend filter

    // Polling intervals (milliseconds)
    checkInterval: 15000,     // Check for entry signals every 15 seconds
    maxTradesPerSymbol: 1,    // Maximum trades per symbol
    maxTotalTrades: 5,        // Maximum total trades across all symbols
};

// ========== GLOBAL STATE ==========
let api;
let currentTrades = {}; // Track open trades by contract_id { contractId: { symbol, entryPrice, ... } }
let strategyStates = {}; // Track strategy state per symbol { symbolName: { dailyOpen, tpZone, ... } }
let isRunning = true;
let contractSubscriptions = {}; // Track subscriptions
let activeSymbols = []; // Enabled symbols to trade

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
        log('Connecting to Deriv API...');

        // Test connection
        const pingResponse = await api.ping();
        log('Connected to Deriv API');

        // Authorize
        const authResponse = await api.authorize(CONFIG.token);
        log(`Authorized as: ${authResponse.authorize.email} (Balance: ${authResponse.authorize.balance} ${authResponse.authorize.currency})`);

        // Update currency from account
        CONFIG.currency = authResponse.authorize.currency;

        return true;
    } catch (error) {
        log(`API initialization failed: ${error.message}`, 'ERROR');
        return false;
    }
}

async function fetchCandles(symbol, granularity, count = 20) {
    try {
        const response = await api.ticksHistory({
            ticks_history: symbol,
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
        log(`[${symbol}] Error fetching candles (granularity ${granularity}): ${error.message}`, 'ERROR');
        return null;
    }
}

async function buyMultiplierContract(symbol) {
    try {
        const symbolState = strategyStates[symbol];

        // Get proposal first
        const proposalResponse = await api.proposal({
            proposal: 1,
            amount: CONFIG.stake,
            basis: 'stake',
            contract_type: 'MULTUP',
            currency: CONFIG.currency,
            symbol: symbol,
            multiplier: CONFIG.multiplier,
            limit_order: {
                stop_loss: CONFIG.stop_loss
            }
        });

        if (proposalResponse.error) {
            throw new Error(proposalResponse.error.message);
        }

        // Buy the contract
        const buyResponse = await api.buy({
            buy: proposalResponse.proposal.id,
            price: CONFIG.stake
        });

        if (buyResponse.error) {
            throw new Error(buyResponse.error.message);
        }

        const contractId = buyResponse.buy.contract_id;
        const buyPrice = parseFloat(buyResponse.buy.buy_price);

        log(`✅ [${symbol}] BUY TRADE OPENED - Contract ID: ${contractId}, Entry: ${buyPrice.toFixed(2)} ${CONFIG.currency}`, 'TRADE');

        // Store trade info
        currentTrades[contractId] = {
            id: contractId,
            symbol: symbol,
            entryPrice: buyPrice,
            entryTime: Date.now(),
            tpZone: symbolState.tpZone
        };

        // Subscribe to contract updates
        subscribeToContract(contractId);

        return contractId;
    } catch (error) {
        log(`[${symbol}] Error buying contract: ${error.message}`, 'ERROR');
        return null;
    }
}

async function sellContract(contractId) {
    try {
        const trade = currentTrades[contractId];
        const symbol = trade?.symbol || 'UNKNOWN';

        const sellResponse = await api.sell({
            sell: contractId,
            price: 0 // Sell at market price
        });

        if (sellResponse.error) {
            throw new Error(sellResponse.error.message);
        }

        const soldFor = parseFloat(sellResponse.sell.sold_for);
        const entryPrice = trade?.entryPrice || 0;
        const profit = soldFor - entryPrice;

        log(`✅ [${symbol}] TRADE CLOSED - Contract ID: ${contractId}, Sold for: ${soldFor.toFixed(2)}, Profit: ${profit.toFixed(2)} ${CONFIG.currency}`, 'TRADE');

        // Unsubscribe from contract updates
        if (contractSubscriptions[contractId]) {
            contractSubscriptions[contractId].unsubscribe();
            delete contractSubscriptions[contractId];
        }

        delete currentTrades[contractId];
        return true;
    } catch (error) {
        log(`Error selling contract ${contractId}: ${error.message}`, 'ERROR');
        return false;
    }
}

function subscribeToContract(contractId) {
    try {
        const subscription = api.subscribeProposalOpenContract(contractId, (response) => {
            if (response.error) {
                log(`Contract subscription error: ${response.error.message}`, 'ERROR');
                return;
            }

            const contract = response.proposal_open_contract;
            if (!contract) return;

            const currentSpot = parseFloat(contract.current_spot);
            const profit = parseFloat(contract.profit || 0);
            const trade = currentTrades[contractId];
            const symbol = trade?.symbol || 'UNKNOWN';

            // Log current status periodically (every 30 seconds)
            if (trade && (!trade.lastLogTime || Date.now() - trade.lastLogTime > 30000)) {
                log(`📊 [${symbol}] Contract ${contractId} - Spot: ${currentSpot.toFixed(5)}, Profit: ${profit.toFixed(2)} ${CONFIG.currency}`, 'INFO');
                trade.lastLogTime = Date.now();
            }

            // Check if TP zone reached
            if (trade && trade.tpZone) {
                if (currentSpot >= trade.tpZone) {
                    log(`🎯 [${symbol}] TP ZONE REACHED - Current: ${currentSpot.toFixed(5)}, TP: ${trade.tpZone.toFixed(5)}`, 'TRADE');
                    sellContract(contractId);
                }
            }

            // Check if contract is closed (e.g., stop loss hit)
            if (contract.status === 'sold' || contract.status === 'cancelled') {
                if (currentTrades[contractId]) {
                    log(`ℹ️ [${symbol}] Contract ${contractId} closed automatically. Status: ${contract.status}, Profit: ${profit.toFixed(2)} ${CONFIG.currency}`, 'TRADE');

                    // Unsubscribe
                    if (contractSubscriptions[contractId]) {
                        contractSubscriptions[contractId].unsubscribe();
                        delete contractSubscriptions[contractId];
                    }

                    delete currentTrades[contractId];
                }
            }
        });

        contractSubscriptions[contractId] = subscription;
        if (currentTrades[contractId]) {
            currentTrades[contractId].lastLogTime = Date.now();
        }

    } catch (error) {
        log(`Error subscribing to contract ${contractId}: ${error.message}`, 'ERROR');
    }
}

// ========== STRATEGY LOGIC (PER SYMBOL) ==========

async function analyzeDailyCandles(symbol) {
    log(`[${symbol}] 📊 Analyzing Daily (D1) candles...`);
    const d1Candles = await fetchCandles(symbol, 86400, 2);

    if (!d1Candles || d1Candles.length < 2) {
        log(`[${symbol}] Insufficient D1 candles`, 'WARNING');
        return false;
    }

    const previousCandle = d1Candles[0];
    const currentCandle = d1Candles[1];

    strategyStates[symbol].dailyOpen = parseFloat(currentCandle.open);
    strategyStates[symbol].previousDailyCandle = previousCandle;

    const isBullish = isBullishCandle(previousCandle);
    log(`[${symbol}] Previous Daily Candle: ${isBullish ? 'BULLISH' : 'BEARISH'} | Close: ${previousCandle.close}`);
    log(`[${symbol}] Current Daily Open: ${strategyStates[symbol].dailyOpen.toFixed(5)}`);

    return true;
}

async function analyzeH4Trend(symbol) {
    log(`[${symbol}] 📈 Analyzing H4 trend...`);
    const h4Candles = await fetchCandles(symbol, 14400, CONFIG.h4CandlesForTrend + 5);

    if (!h4Candles || h4Candles.length < CONFIG.h4CandlesForTrend) {
        log(`[${symbol}] Insufficient H4 candles`, 'WARNING');
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

    // Check for higher swing lows
    const last5Lows = h4Candles.slice(-5).map(c => parseFloat(c.low));
    let hasHigherLows = true;
    for (let i = 1; i < last5Lows.length - 1; i++) {
        if (last5Lows[i] < last5Lows[i - 1] - 0.5) {
            hasHigherLows = false;
        }
    }

    const trendConfirmed = isUptrend && aboveSMA && hasHigherLows;

    log(`[${symbol}] H4 Trend: Uptrend=${isUptrend}, Above SMA20=${aboveSMA}, Higher Lows=${hasHigherLows} => ${trendConfirmed ? '✅ BULLISH' : '❌ NO TREND'}`);

    // Calculate TP zone
    const tpCandles = h4Candles.slice(-CONFIG.h4CandlesForTP);
    strategyStates[symbol].tpZone = getHighestHigh(tpCandles);
    log(`[${symbol}] TP Zone identified at: ${strategyStates[symbol].tpZone.toFixed(5)}`);

    return trendConfirmed;
}

async function confirmH1Trend(symbol) {
    log(`[${symbol}] 🔍 Confirming H1 trend...`);
    const h1Candles = await fetchCandles(symbol, 3600, CONFIG.h1CandlesForConfirm);

    if (!h1Candles || h1Candles.length < CONFIG.h1CandlesForConfirm) {
        log(`[${symbol}] Insufficient H1 candles`, 'WARNING');
        return false;
    }

    const recentCandles = h1Candles.slice(-4);
    let isUptrend = true;
    for (let i = 1; i < recentCandles.length; i++) {
        if (parseFloat(recentCandles[i].close) < parseFloat(recentCandles[i - 1].close) - 0.3) {
            isUptrend = false;
            break;
        }
    }

    log(`[${symbol}] H1 Trend Confirmation: ${isUptrend ? '✅ CONFIRMED' : '❌ NOT CONFIRMED'}`);
    return isUptrend;
}

async function checkM15Entry(symbol) {
    const m15Candles = await fetchCandles(symbol, 900, 5);

    if (!m15Candles || m15Candles.length < 2) {
        return false;
    }

    const latestCandle = m15Candles[m15Candles.length - 1];
    const currentPrice = parseFloat(latestCandle.close);
    const candleLow = parseFloat(latestCandle.low);

    const dailyOpen = strategyStates[symbol].dailyOpen;
    const distanceFromDailyOpen = Math.abs(currentPrice - dailyOpen);
    const nearDailyOpen = distanceFromDailyOpen <= CONFIG.dailyOpenThreshold;

    const touchedDailyOpen = Math.abs(candleLow - dailyOpen) <= CONFIG.dailyOpenThreshold;
    const isBullishRejection = isBullishCandle(latestCandle) && touchedDailyOpen;

    if (nearDailyOpen && isBullishRejection) {
        log(`🚀 [${symbol}] ENTRY SIGNAL DETECTED - M15 bullish rejection at daily open (${dailyOpen.toFixed(5)})`, 'SIGNAL');
        return true;
    }

    return false;
}

// Helper to count trades for a specific symbol
function countTradesForSymbol(symbol) {
    return Object.values(currentTrades).filter(trade => trade.symbol === symbol).length;
}

// ========== MAIN STRATEGY LOOP (MULTI-ASSET) ==========

async function runStrategyCheckForSymbol(symbol) {
    if (!isRunning) return;

    try {
        const symbolState = strategyStates[symbol];
        const now = Date.now();

        // Prevent too frequent checks per symbol
        if (now - symbolState.lastCheckTime < CONFIG.checkInterval) {
            return;
        }
        symbolState.lastCheckTime = now;

        const totalTrades = Object.keys(currentTrades).length;
        const symbolTrades = countTradesForSymbol(symbol);

        log(`[${symbol}] ========== STRATEGY CHECK ==========`);
        log(`[${symbol}] Symbol Trades: ${symbolTrades}/${CONFIG.maxTradesPerSymbol} | Total: ${totalTrades}/${CONFIG.maxTotalTrades}`);

        // Step 1: Analyze daily candles
        const dailySuccess = await analyzeDailyCandles(symbol);
        if (!dailySuccess) {
            log(`[${symbol}] ======================================`);
            return;
        }

        // Step 2: Check H4 trend
        const h4Bullish = await analyzeH4Trend(symbol);
        if (!h4Bullish) {
            log(`[${symbol}] ⚠️ H4 trend not bullish. Skipping entry.`, 'WARNING');
            symbolState.isBullishTrend = false;
            log(`[${symbol}] ======================================`);
            return;
        }

        // Step 3: Confirm on H1
        const h1Confirmed = await confirmH1Trend(symbol);
        if (!h1Confirmed) {
            log(`[${symbol}] ⚠️ H1 trend not confirmed. Skipping entry.`, 'WARNING');
            symbolState.isBullishTrend = false;
            log(`[${symbol}] ======================================`);
            return;
        }

        symbolState.isBullishTrend = true;
        log(`[${symbol}] ✅ BULLISH TREND CONFIRMED on H4 and H1`);

        // Step 4: Check for M15 entry signal
        const entrySignal = await checkM15Entry(symbol);

        if (entrySignal) {
            // Check trade limits
            if (totalTrades >= CONFIG.maxTotalTrades) {
                log(`[${symbol}] ⚠️ Max total trades (${CONFIG.maxTotalTrades}) reached. Skipping.`, 'WARNING');
            } else if (symbolTrades >= CONFIG.maxTradesPerSymbol) {
                log(`[${symbol}] ⚠️ Max trades per symbol (${CONFIG.maxTradesPerSymbol}) reached. Skipping.`, 'WARNING');
            } else {
                await buyMultiplierContract(symbol);
            }
        } else {
            log(`[${symbol}] No entry signal on M15. Waiting...`, 'INFO');
        }

        log(`[${symbol}] ======================================`);

    } catch (error) {
        log(`[${symbol}] Strategy check error: ${error.message}`, 'ERROR');
        console.error(error);
    }
}

async function runAllSymbolChecks() {
    if (!isRunning) return;

    log('');
    log('🔍 Running multi-asset strategy checks...');

    // Run checks for all active symbols in parallel
    const checkPromises = activeSymbols.map(symbol => runStrategyCheckForSymbol(symbol));
    await Promise.all(checkPromises);

    log(`✅ Completed checks for ${activeSymbols.length} symbols. Total open trades: ${Object.keys(currentTrades).length}`);
    log('');
}

// ========== BOT INITIALIZATION AND MAIN LOOP ==========

async function startBot() {
    log('=================================================');
    log('  DERIV MULTI-ASSET TRADING BOT');
    log('  1-Second Index Price Action Strategy (MULTUP)');
    log('=================================================');
    log('⚠️  WARNING: Test on DEMO account first!');
    log('=================================================');

    // Validate configuration
    if (!CONFIG.token || CONFIG.token === 'YOUR_API_TOKEN_HERE') {
        log('❌ Please set your API token in CONFIG.token', 'ERROR');
        log('Get your token from: https://app.deriv.com/account/api-token', 'ERROR');
        process.exit(1);
    }

    // Initialize active symbols
    activeSymbols = CONFIG.symbols.filter(s => s.enabled).map(s => s.name);

    if (activeSymbols.length === 0) {
        log('❌ No symbols enabled in configuration!', 'ERROR');
        process.exit(1);
    }

    log(`Active Symbols: ${activeSymbols.join(', ')}`);

    // Initialize strategy state for each symbol
    activeSymbols.forEach(symbol => {
        strategyStates[symbol] = {
            dailyOpen: null,
            previousDailyCandle: null,
            tpZone: null,
            isBullishTrend: false,
            lastCheckTime: 0
        };
    });

    // Initialize API connection
    api = new DerivAPI({ app_id: CONFIG.app_id });

    const initialized = await initializeAPI();
    if (!initialized) {
        log('Failed to initialize. Exiting.', 'ERROR');
        process.exit(1);
    }

    log('🤖 Bot started successfully. Monitoring markets...');
    log(`Stake: ${CONFIG.stake} ${CONFIG.currency} per trade`);
    log(`Multiplier: ${CONFIG.multiplier}x | Stop Loss: ${CONFIG.stop_loss} ${CONFIG.currency}`);
    log(`Max Trades Per Symbol: ${CONFIG.maxTradesPerSymbol} | Max Total: ${CONFIG.maxTotalTrades}`);
    log(`Check Interval: ${CONFIG.checkInterval / 1000} seconds`);
    log('=================================================');

    // Run initial strategy checks for all symbols
    await runAllSymbolChecks();

    // Set up recurring strategy checks
    const checkIntervalId = setInterval(async () => {
        await runAllSymbolChecks();
    }, CONFIG.checkInterval);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        log('\n🛑 Shutting down bot...');
        isRunning = false;

        // Stop the interval
        clearInterval(checkIntervalId);

        // Close any open trades
        const openTradeIds = Object.keys(currentTrades);
        if (openTradeIds.length > 0) {
            log(`Closing ${openTradeIds.length} open trade(s)...`);
            for (const tradeId of openTradeIds) {
                await sellContract(parseInt(tradeId));
            }
        }

        // Unsubscribe from all contracts
        Object.values(contractSubscriptions).forEach(sub => {
            try {
                sub.unsubscribe();
            } catch (e) {
                // Ignore errors during cleanup
            }
        });

        log('Bot stopped. Goodbye!');
        process.exit(0);
    });
}

// Start the bot
startBot().catch(error => {
    log(`Fatal error: ${error.message}`, 'ERROR');
    console.error(error);
    process.exit(1);
});