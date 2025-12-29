/**
 * Deriv Trading Bot - Multi-Asset 1s Index Price Action Strategy
 * Manual WebSocket Implementation (Refactored)
 */

const WebSocket = require('ws');
const fs = require('fs');
require('dotenv').config();

// ========== CONFIGURATION ==========
const CONFIG = {
    app_id: '1089',
    token: process.env.DERIV_API_TOKEN || 'Dz2V2KvRf4Uukt3',
    ws_url: 'wss://ws.derivws.com/websockets/v3',

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

    // Investment Management
    INVESTMENT_CAPITAL: process.env.INITIAL_CAPITAL ? parseFloat(process.env.INITIAL_CAPITAL) : 100,
    RISK_PERCENT: 5, // 5% risk per trade if using capital

    // Strategy parameters
    dailyOpenThreshold: 0.5,
    h4CandlesForTrend: 7,
    h4CandlesForTP: 10,
    h1CandlesForConfirm: 6,
    smaPeriod: 20,

    checkInterval: 15000,
    maxTradesPerSymbol: 1,
    maxTotalTrades: 5,
};

// ========== GLOBAL STATE ==========
let ws = null;
let isConnected = false;
let isAuthorized = false;
let requestId = 1;
let currentTrades = {};
let strategyStates = {};
let isRunning = true;
let activeSymbols = [];
let pendingPromises = new Map();

// ========== UTILITY FUNCTIONS ==========

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

function calculateSMA(candles, period) {
    if (!candles || candles.length < period) return null;
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

// ========== CONNECTION MANAGEMENT ==========

function connect() {
    log('Connecting to Deriv API...');
    ws = new WebSocket(`${CONFIG.ws_url}?app_id=${CONFIG.app_id}`);

    ws.on('open', () => {
        isConnected = true;
        log('WebSocket connected');
        authorize();
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        handleMessage(response);
    });

    ws.on('close', () => {
        isConnected = false;
        isAuthorized = false;
        log('WebSocket disconnected. Reconnecting in 5s...');
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        log(`WebSocket error: ${err.message}`, 'ERROR');
    });
}

function sendRequest(request) {
    if (!isConnected) return null;
    const reqId = requestId++;
    request.req_id = reqId;
    ws.send(JSON.stringify(request));
    return reqId;
}

function sendRequestWithPromise(request) {
    return new Promise((resolve, reject) => {
        if (!isConnected) {
            return reject(new Error('Not connected'));
        }
        const reqId = requestId++;
        request.req_id = reqId;

        pendingPromises.set(reqId, {
            resolve, reject, timeout: setTimeout(() => {
                if (pendingPromises.has(reqId)) {
                    pendingPromises.delete(reqId);
                    reject(new Error(`Request ${reqId} timed out`));
                }
            }, 30000)
        });

        ws.send(JSON.stringify(request));
    });
}

function handleMessage(msg) {
    // Handle promises
    if (msg.req_id && pendingPromises.has(msg.req_id)) {
        const { resolve, reject, timeout } = pendingPromises.get(msg.req_id);
        clearTimeout(timeout);
        pendingPromises.delete(msg.req_id);
        if (msg.error) reject(msg.error);
        else resolve(msg);
        return;
    }

    if (msg.error) {
        log(`API Error: ${msg.error.message}`, 'ERROR');
        return;
    }

    switch (msg.msg_type) {
        case 'authorize':
            isAuthorized = true;
            log(`Authorized: ${msg.authorize.email} (Balance: ${msg.authorize.balance} ${msg.authorize.currency})`);
            CONFIG.currency = msg.authorize.currency;
            // Start the main strategy loop once authorized
            startStrategyLoop();
            break;
        case 'buy':
            handleBuyResponse(msg);
            break;
        case 'proposal_open_contract':
            handleContractUpdate(msg.proposal_open_contract);
            break;
        case 'sell':
            handleSellResponse(msg);
            break;
    }
}

function authorize() {
    sendRequest({ authorize: CONFIG.token });
}

// ========== API FUNCTIONS ==========

async function fetchCandles(symbol, granularity, count = 20) {
    try {
        const response = await sendRequestWithPromise({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: count,
            end: 'latest',
            granularity: granularity,
            style: 'candles'
        });
        return response.candles;
    } catch (error) {
        log(`[${symbol}] Error fetching candles: ${error.message}`, 'ERROR');
        return null;
    }
}

async function buyMultiplierContract(symbol) {
    try {
        const symbolState = strategyStates[symbol];

        // Calculate stake based on capital
        const baseCapital = CONFIG.INVESTMENT_CAPITAL || CONFIG.stake;
        const stake = Math.max(baseCapital * (CONFIG.RISK_PERCENT / 100), 0.35).toFixed(2);

        log(`[${symbol}] Requesting proposal for stake: ${stake}...`);

        const proposalResponse = await sendRequestWithPromise({
            proposal: 1,
            amount: parseFloat(stake),
            basis: 'stake',
            contract_type: 'MULTUP',
            currency: CONFIG.currency,
            symbol: symbol,
            multiplier: CONFIG.multiplier,
            limit_order: {
                stop_loss: CONFIG.stop_loss
            }
        });

        log(`[${symbol}] Buying contract: ${proposalResponse.proposal.id}...`);

        const buyResponse = await sendRequestWithPromise({
            buy: proposalResponse.proposal.id,
            price: parseFloat(stake)
        });

        const contractId = buyResponse.buy.contract_id;
        const buyPrice = parseFloat(buyResponse.buy.buy_price);

        log(`✅ [${symbol}] BUY TRADE OPENED - ID: ${contractId}, Entry: ${buyPrice.toFixed(2)}`, 'TRADE');

        currentTrades[contractId] = {
            id: contractId,
            symbol: symbol,
            entryPrice: buyPrice,
            entryTime: Date.now(),
            tpZone: symbolState.tpZone
        };

        // Subscribe to contract
        sendRequest({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        });

    } catch (error) {
        log(`[${symbol}] Error buying contract: ${error.message}`, 'ERROR');
    }
}

function handleContractUpdate(contract) {
    if (!contract) return;
    const contractId = contract.contract_id;
    if (!currentTrades[contractId]) return;

    const trade = currentTrades[contractId];
    const symbol = trade.symbol;
    const currentSpot = parseFloat(contract.current_spot);
    const profit = parseFloat(contract.profit || 0);

    // Periodic log
    if (!trade.lastLogTime || Date.now() - trade.lastLogTime > 30000) {
        log(`📊 [${symbol}] Contract ${contractId} - Spot: ${currentSpot.toFixed(5)}, Profit: ${profit.toFixed(2)}`, 'INFO');
        trade.lastLogTime = Date.now();
    }

    // Check TP zone
    if (trade.tpZone && currentSpot >= trade.tpZone) {
        log(`🎯 [${symbol}] TP ZONE REACHED - Current: ${currentSpot.toFixed(5)}, TP: ${trade.tpZone.toFixed(5)}`, 'TRADE');
        sellContract(contractId);
    }

    // Handle closure
    if (contract.is_sold) {
        log(`ℹ️ [${symbol}] Contract ${contractId} closed. Profit: ${profit.toFixed(2)}`, 'TRADE');
        delete currentTrades[contractId];
    }
}

async function sellContract(contractId) {
    try {
        await sendRequestWithPromise({
            sell: contractId,
            price: 0
        });
    } catch (error) {
        log(`Error selling contract ${contractId}: ${error.message}`, 'ERROR');
    }
}

function handleBuyResponse(msg) { /* Not strictly needed if using promises */ }
function handleSellResponse(msg) { /* Not strictly needed if using promises */ }

// ========== STRATEGY LOGIC ==========

async function analyzeDailyCandles(symbol) {
    const d1Candles = await fetchCandles(symbol, 86400, 2);
    if (!d1Candles || d1Candles.length < 2) return false;

    const currentCandle = d1Candles[1];
    strategyStates[symbol].dailyOpen = parseFloat(currentCandle.open);
    return true;
}

async function analyzeH4Trend(symbol) {
    const h4Candles = await fetchCandles(symbol, 14400, CONFIG.h4CandlesForTrend + 5);
    if (!h4Candles || h4Candles.length < CONFIG.h4CandlesForTrend) return false;

    const recentCandles = h4Candles.slice(-4);
    let isUptrend = true;
    for (let i = 1; i < recentCandles.length; i++) {
        if (parseFloat(recentCandles[i].close) <= parseFloat(recentCandles[i - 1].close)) {
            isUptrend = false;
            break;
        }
    }

    const sma20 = calculateSMA(h4Candles, CONFIG.smaPeriod);
    const currentPrice = parseFloat(h4Candles[h4Candles.length - 1].close);
    const aboveSMA = sma20 ? currentPrice > sma20 : true;

    const trendConfirmed = isUptrend && aboveSMA;

    // TP zone
    const tpCandles = h4Candles.slice(-CONFIG.h4CandlesForTP);
    strategyStates[symbol].tpZone = getHighestHigh(tpCandles);

    return trendConfirmed;
}

async function confirmH1Trend(symbol) {
    const h1Candles = await fetchCandles(symbol, 3600, CONFIG.h1CandlesForConfirm);
    if (!h1Candles || h1Candles.length < CONFIG.h1CandlesForConfirm) return false;

    const recentCandles = h1Candles.slice(-4);
    return recentCandles.every((c, i) => i === 0 || parseFloat(c.close) >= parseFloat(recentCandles[i - 1].close) - 0.3);
}

async function checkM15Entry(symbol) {
    const m15Candles = await fetchCandles(symbol, 900, 5);
    if (!m15Candles || m15Candles.length < 2) return false;

    const latestCandle = m15Candles[m15Candles.length - 1];
    const currentPrice = parseFloat(latestCandle.close);
    const candleLow = parseFloat(latestCandle.low);
    const dailyOpen = strategyStates[symbol].dailyOpen;

    const nearDailyOpen = Math.abs(currentPrice - dailyOpen) <= CONFIG.dailyOpenThreshold;
    const touchedDailyOpen = Math.abs(candleLow - dailyOpen) <= CONFIG.dailyOpenThreshold;

    return nearDailyOpen && isBullishCandle(latestCandle) && touchedDailyOpen;
}

async function runStrategyCheckForSymbol(symbol) {
    if (!isRunning || !isAuthorized) return;

    try {
        const symbolState = strategyStates[symbol];
        const totalTrades = Object.keys(currentTrades).length;
        const symbolTrades = Object.values(currentTrades).filter(t => t.symbol === symbol).length;

        if (totalTrades >= CONFIG.maxTotalTrades || symbolTrades >= CONFIG.maxTradesPerSymbol) return;

        if (await analyzeDailyCandles(symbol) && await analyzeH4Trend(symbol) && await confirmH1Trend(symbol)) {
            if (await checkM15Entry(symbol)) {
                await buyMultiplierContract(symbol);
            }
        }
    } catch (error) {
        log(`[${symbol}] Strategy error: ${error.message}`, 'ERROR');
    }
}

async function startStrategyLoop() {
    log('🤖 Strategy loop started');

    const loop = async () => {
        if (!isRunning) return;

        log('🔍 Scanning symbols...');
        for (const symbol of activeSymbols) {
            await runStrategyCheckForSymbol(symbol);
        }
        log(`✅ Scan complete. Active trades: ${Object.keys(currentTrades).length}`);

        setTimeout(loop, CONFIG.checkInterval);
    };

    loop();
}

// ========== MAIN ==========

async function startBot() {
    log('=================================================');
    log('  DERIV MULTI-ASSET TRADING BOT (REF)          ');
    log('=================================================');

    activeSymbols = CONFIG.symbols.filter(s => s.enabled).map(s => s.name);
    activeSymbols.forEach(symbol => {
        strategyStates[symbol] = { lastCheckTime: 0 };
    });

    log(`Active Symbols: ${activeSymbols.join(', ')}`);
    log(`Capital: $${CONFIG.INVESTMENT_CAPITAL} | Risk: ${CONFIG.RISK_PERCENT}%`);

    connect();

    process.on('SIGINT', () => {
        log('\n🛑 Shutting down...');
        isRunning = false;
        setTimeout(() => process.exit(0), 1000);
    });
}

startBot();