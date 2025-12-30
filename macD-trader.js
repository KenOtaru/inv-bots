const WebSocket = require('ws');

// ================= CONFIGURATION =================
const CONFIG = {
    APP_ID: 1089, // Default Deriv App ID
    TOKEN: 'rgNedekYXvCaPeP', // REPLACE WITH YOUR API TOKEN
    SYMBOL: 'R_75', // Volatility 75 Index
    TIMEFRAME: 300, // 5 Minutes (in seconds)

    // STRATEGY SETTINGS
    MA_SLOW_PERIOD: 100, // Red Line
    MA_FAST_PERIOD: 10,  // Green Line (Smoothed)
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,

    // MONEY MANAGEMENT
    STAKE: 10,           // Amount to risk per trade (USD)
    MULTIPLIER: 100,     // Leverage Multiplier (e.g., 100x)
    USE_MARTINGALE: false, // Set to true to double stake after loss
    MARTINGALE_FACTOR: 2.0,

    // RISK MANAGEMENT (USD Amounts)
    // Video suggests 1:3 Risk:Reward. 
    // Example: If Stake is $10, and you want to risk $5 max, TP should be $15.
    STOP_LOSS_AMT: 5,   // Stop Loss in USD
    TAKE_PROFIT_AMT: 15 // Take Profit in USD
};

// ================= GLOBAL VARIABLES =================
const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=' + CONFIG.APP_ID);
let candles = [];
let currentStake = CONFIG.STAKE;
let openContractId = null;
let activeContractData = null; // Track start time and extra details

// ================= UTILS =================
function logBox(message, color = '\x1b[36m') { // Default Cyan
    const reset = '\x1b[0m';
    const lines = message.split('\n');
    const width = 60;
    console.log(`${color}┏${'━'.repeat(width)}┓${reset}`);
    lines.forEach(line => {
        console.log(`${color}┃ ${line.padEnd(width - 2)} ┃${reset}`);
    });
    console.log(`${color}┗${'━'.repeat(width)}┛${reset}`);
}

// ================= WEBSOCKET HANDLERS =================
ws.on('open', function open() {
    console.log(`[${new Date().toISOString()}] Connected to Deriv WS.`);
    authorize();
});

ws.on('message', function incoming(data) {
    const msg = JSON.parse(data);

    if (msg.error) {
        console.error(`[ERROR] ${msg.error.message}`);
        return;
    }

    if (msg.msg_type === 'authorize') {
        console.log(`[AUTH] Logged in as ${msg.authorize.email}`);
        console.log(`[BALANCE] Current Balance: ${msg.authorize.balance} ${msg.authorize.currency}`);
        subscribeCandles();
    }

    if (msg.msg_type === 'ohlc') {
        // Handle new candle data
        processCandle(msg.ohlc);
    }

    if (msg.msg_type === 'buy') {
        console.log(`[TRADE] Contract Bought! ID: ${msg.buy.contract_id}`);
        console.log(`[TRADE] Details: ${msg.buy.longcode}`);
        openContractId = msg.buy.contract_id;
        // Subscribe to transaction updates to check for win/loss
        ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: openContractId }));
    }

    if (msg.msg_type === 'proposal_open_contract') {
        const contract = msg.proposal_open_contract;

        if (contract.is_sold) {
            handleTradeResult(contract);
            openContractId = null;
            activeContractData = null;
        } else {
            // Log real-time profit tracking
            const profit = parseFloat(contract.profit);
            const profitPercent = ((profit / currentStake) * 100).toFixed(2);
            const color = profit >= 0 ? '\x1b[32m' : '\x1b[31m'; // Green / Red
            const reset = '\x1b[0m';

            // Log frequently for visibility (roughly every ~2 seconds)
            if (Math.random() < 0.3) {
                console.log(`[MONITOR] ${CONFIG.SYMBOL} | ${color}${profitPercent}% ($${profit.toFixed(2)})${reset}`);
            }
        }
    }
});

// ================= CORE FUNCTIONS =================

function authorize() {
    ws.send(JSON.stringify({ authorize: CONFIG.TOKEN }));
}

function subscribeCandles() {
    const welcome =
        `📡 MONITORING ACTIVE: ${CONFIG.SYMBOL}\n` +
        `• Timeframe:  ${CONFIG.TIMEFRAME / 60}m\n` +
        `• Strategy:   MACD (${CONFIG.MACD_FAST}/${CONFIG.MACD_SLOW}) + LWMA\n` +
        `• Risk:       SL $${CONFIG.STOP_LOSS_AMT} | TP $${CONFIG.TAKE_PROFIT_AMT}`;
    logBox(welcome);

    console.log(`[INFO] Subscribing to ${CONFIG.SYMBOL} ${CONFIG.TIMEFRAME / 60}m candles...`);
    ws.send(JSON.stringify({
        ticks_history: CONFIG.SYMBOL,
        adjust_start_time: 1,
        count: CONFIG.MA_SLOW_PERIOD + 50, // Buffer for indicators
        end: 'latest',
        start: 1,
        style: 'candles',
        granularity: CONFIG.TIMEFRAME,
        subscribe: 1
    }));
}

function processCandle(ohlc) {
    // Determine if it's a new candle or an update
    const candleTime = parseInt(ohlc.open_time);
    const lastStored = candles.length > 0 ? candles[candles.length - 1].time : 0;

    if (candleTime > lastStored) {
        // New candle started, finalize previous
        candles.push({
            time: candleTime,
            close: parseFloat(ohlc.close),
            open: parseFloat(ohlc.open),
            high: parseFloat(ohlc.high),
            low: parseFloat(ohlc.low)
        });

        // Keep array size manageable
        if (candles.length > CONFIG.MA_SLOW_PERIOD + 100) {
            candles.shift();
        }

        console.log(`[CANDLE] New Close: ${ohlc.close} @ ${new Date(candleTime * 1000).toLocaleTimeString()}`);
        checkStrategy();
    } else if (candleTime === lastStored) {
        // Update current candle close
        candles[candles.length - 1].close = parseFloat(ohlc.close);
    }
}

// ================= STRATEGY LOGIC =================
function checkStrategy() {
    if (candles.length < CONFIG.MA_SLOW_PERIOD + 2) return;
    if (openContractId) return; // Do not trade if one is open

    // Extract Close Prices
    const closePrices = candles.map(c => c.close);

    // 1. Calculate Red Line: LWMA 100 on Close
    const maRed = calculateLWMA(closePrices, CONFIG.MA_SLOW_PERIOD);

    // 2. Calculate Green Line: LWMA 10 on Red Line Data (Smoothing)
    // We need a history of Red Line values to calculate the Green Line
    // This is computationally expensive to do fully every tick, so we do a slice
    const redLineHistory = [];
    for (let i = 0; i < 20; i++) {
        // Calculate MA Red for previous periods to build a buffer for MA Green
        const slice = closePrices.slice(0, closePrices.length - i);
        redLineHistory.unshift(calculateLWMAValue(slice, CONFIG.MA_SLOW_PERIOD));
    }
    const maGreen = calculateLWMA(redLineHistory, CONFIG.MA_FAST_PERIOD);

    // 3. Calculate MACD
    const macdData = calculateMACD(closePrices, CONFIG.MACD_FAST, CONFIG.MACD_SLOW, CONFIG.MACD_SIGNAL);

    // Get latest completed values (index -2 because -1 is forming candle)
    // However, strategy usually takes action on the OPEN of the new candle based on CLOSE of previous.
    // So we look at the last fully closed candle (index: length - 1 in our processed array? No, length-1 is current open)
    // Actually, processCandle pushes NEW candle. So index [length-2] is the just-closed candle.

    const idx = maGreen.length - 1;
    const prevIdx = idx - 1;

    const redCurrent = maRed[maRed.length - 1];
    const redPrev = maRed[maRed.length - 2];

    const greenCurrent = maGreen[maGreen.length - 1];
    const greenPrev = maGreen[maGreen.length - 2];

    const macdValue = macdData.macdLine[macdData.macdLine.length - 1];

    // Logging Analysis with Visuals
    const trendDir = greenCurrent > redCurrent ? 'BULLISH' : 'BEARISH';
    const trendColor = greenCurrent > redCurrent ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    // Simple visual for MACD
    const macdBar = (macdValue > 0 ? '📈' : '📉');
    console.log(`[ANALYSIS] ${trendColor}${trendDir}${reset} | MACD: ${macdBar} ${macdValue.toFixed(4)} | Green: ${greenCurrent.toFixed(3)} | Red: ${redCurrent.toFixed(3)}`);

    // BUY SIGNAL: Green crosses ABOVE Red && MACD > 0
    if (greenPrev <= redPrev && greenCurrent > redCurrent && macdValue > 0) {
        logBox("✅ BUY SIGNAL DETECTED\n• Strategy: MACD Divergence + LWMA Cross", '\x1b[32m');
        placeTrade('UP');
    }
    // SELL SIGNAL: Green crosses BELOW Red && MACD < 0
    else if (greenPrev >= redPrev && greenCurrent < redCurrent && macdValue < 0) {
        logBox("🔻 SELL SIGNAL DETECTED\n• Strategy: MACD Divergence + LWMA Cross", '\x1b[31m');
        placeTrade('DOWN');
    }
}

function placeTrade(direction) {
    const contractType = direction === 'UP' ? 'MULTUP' : 'MULTDOWN';
    console.log(`[TRADE] Placing ${direction} order with stake $${currentStake}...`);

    activeContractData = { startTime: Date.now() };

    const request = {
        buy: 1,
        price: currentStake,
        parameters: {
            contract_type: contractType,
            symbol: CONFIG.SYMBOL,
            currency: "USD",
            multiplier: CONFIG.MULTIPLIER,
            amount: currentStake,
            basis: "stake"
        }
    };

    // Add Stop Loss / Take Profit
    if (CONFIG.STOP_LOSS_AMT > 0 || CONFIG.TAKE_PROFIT_AMT > 0) {
        request.parameters.take_profit = CONFIG.TAKE_PROFIT_AMT;
        request.parameters.stop_loss = CONFIG.STOP_LOSS_AMT;
    }

    ws.send(JSON.stringify(request));
}

function handleTradeResult(contract) {
    const profit = parseFloat(contract.profit);
    const profitPercent = ((profit / currentStake) * 100).toFixed(2);
    const isWin = profit > 0;
    const color = isWin ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    const duration = activeContractData ? `${((Date.now() - activeContractData.startTime) / 1000).toFixed(1)}s` : 'Unknown';

    const summary =
        `🏁 TRADE COMPLETED: ${CONFIG.SYMBOL}\n` +
        `• Result:   ${isWin ? 'WIN ✅' : 'LOSS ❌'}\n` +
        `• P/L:      ${color}$${profit.toFixed(2)} (${profitPercent}%)${reset}\n` +
        `• Entry:    ${contract.buy_price.toFixed(2)} | Exit: ${contract.exit_tick.toFixed(2)}\n` +
        `• ID:       ${contract.contract_id}\n` +
        `• Duration: ${duration}`;

    logBox(summary, color);

    if (CONFIG.USE_MARTINGALE) {
        if (profit < 0) {
            currentStake = currentStake * CONFIG.MARTINGALE_FACTOR;
            console.log(`[MARTINGALE] Loss detected. Increasing stake to $${currentStake.toFixed(2)}`);
        } else {
            currentStake = CONFIG.STAKE;
            console.log(`[MARTINGALE] Win detected. Resetting stake to $${currentStake.toFixed(2)}`);
        }
    }
}

// ================= INDICATOR CALCULATIONS =================

// Helper to calculate full array of LWMA
function calculateLWMA(data, period) {
    let results = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            results.push(0);
            continue;
        }
        const slice = data.slice(i - period + 1, i + 1);
        results.push(calculateLWMAValue(slice, period));
    }
    return results;
}

// Helper to calculate single LWMA value
function calculateLWMAValue(data, period) {
    let sum = 0;
    let weightSum = 0;
    for (let i = 0; i < period; i++) {
        const weight = i + 1;
        sum += data[i] * weight;
        weightSum += weight;
    }
    return sum / weightSum;
}

// MACD Calculation
function calculateMACD(data, fastPeriod, slowPeriod, signalPeriod) {
    const emaFast = calculateEMA(data, fastPeriod);
    const emaSlow = calculateEMA(data, slowPeriod);

    let macdLine = [];
    for (let i = 0; i < data.length; i++) {
        macdLine.push(emaFast[i] - emaSlow[i]);
    }

    const signalLine = calculateEMA(macdLine, signalPeriod);

    // Histogram not strictly needed for logic, just MACD Line vs 0
    return { macdLine, signalLine };
}

function calculateEMA(data, period) {
    let results = [];
    const k = 2 / (period + 1);

    // Simple MA for first value
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    results[period - 1] = sum / period;

    // Fill previous with 0 or approx
    for (let i = 0; i < period - 1; i++) results[i] = 0;

    for (let i = period; i < data.length; i++) {
        results.push((data[i] * k) + (results[i - 1] * (1 - k)));
    }
    return results;
}