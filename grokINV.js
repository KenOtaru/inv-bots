// deriv-multi-asset-bot.js

const WebSocket = require('ws');
const math = require('mathjs');
const KMeans = require('kmeans-js');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

function log(message, level = 'INFO') {
    console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

function calculateEMA(prices, period) {
    if (prices.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = math.mean(prices.slice(0, period));
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateRSI(prices, period) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

function calculateADX(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return 0;
    let dmPlus = [], dmMinus = [], tr = [];
    for (let i = 1; i < highs.length; i++) {
        const dmP = highs[i] - highs[i - 1];
        const dmM = lows[i - 1] - lows[i];
        dmPlus.push(dmP > dmM && dmP > 0 ? dmP : 0);
        dmMinus.push(dmM > dmP && dmM > 0 ? dmM : 0);
        tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    let smoothDmPlus = math.sum(dmPlus.slice(0, period));
    let smoothDmMinus = math.sum(dmMinus.slice(0, period));
    let smoothTr = math.sum(tr.slice(0, period));
    let dx = [];
    for (let i = period; i < dmPlus.length; i++) {
        smoothDmPlus = smoothDmPlus - smoothDmPlus / period + dmPlus[i];
        smoothDmMinus = smoothDmMinus - smoothDmMinus / period + dmMinus[i];
        smoothTr = smoothTr - smoothTr / period + tr[i];
        const diPlus = 100 * smoothDmPlus / smoothTr;
        const diMinus = 100 * smoothDmMinus / smoothTr;
        dx.push(100 * Math.abs(diPlus - diMinus) / (diPlus + diMinus));
    }
    let adx = math.mean(dx.slice(0, period));
    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
    }
    return adx;
}

if (isMainThread) {
    // Main code
    const APP_ID = '1089'; // Replace with your Deriv app ID
    const API_TOKEN = 'Dz2V2KvRf4Uukt3'; // Replace with your Deriv API token

    const state = {
        capital: 500,
        assets: {},
        portfolio: { dailyLoss: 0, dailyProfit: 0, activePositions: [] }
    };

    const assets = ['R_10', 'R_25', 'R_75', 'BOOM1000', 'CRASH1000', 'FRXEURUSD', 'FRXGBPUSD', 'FRXUSDJPY', 'WTI', 'XAUUSD'];

    const symbolMap = {
        'R_10': 'R_10',
        'R_25': 'R_25',
        'R_75': 'R_75',
        'BOOM1000': '1HZ1000V',
        'CRASH1000': '1HZ1000',
        'FRXEURUSD': 'frxEURUSD',
        'FRXGBPUSD': 'frxGBPUSD',
        'FRXUSDJPY': 'frxUSDJPY',
        'WTI': 'frxWTIOIL',
        'XAUUSD': 'frxXAUUSD',
    };

    const perAssetConfig = {
        'R_10': { emaShort: 8, emaLong: 21, rsiPeriod: 14, duration: '15m', maxTradesDay: 2, threshold: 30 },
        'R_25': { emaShort: 8, emaLong: 21, rsiPeriod: 14, duration: '15m', maxTradesDay: 2, threshold: 30 },
        'R_75': { emaShort: 12, emaLong: 30, rsiPeriod: 21, duration: '30m', maxTradesDay: 1, threshold: 30 },
        'BOOM1000': { emaShort: 5, emaLong: 15, rsiPeriod: 7, duration: '5m', maxTradesDay: 3, threshold: 30 },
        'CRASH1000': { emaShort: 5, emaLong: 15, rsiPeriod: 7, duration: '5m', maxTradesDay: 3, threshold: 30 },
        'FRXEURUSD': { emaShort: 10, emaLong: 25, rsiPeriod: 14, duration: '4h', maxTradesDay: 1, threshold: 30 },
        'FRXGBPUSD': { emaShort: 10, emaLong: 25, rsiPeriod: 14, duration: '4h', maxTradesDay: 1, threshold: 30 },
        'FRXUSDJPY': { emaShort: 10, emaLong: 25, rsiPeriod: 14, duration: '4h', maxTradesDay: 1, threshold: 30 },
        'WTI': { emaShort: 15, emaLong: 35, rsiPeriod: 14, duration: '1h', maxTradesDay: 2, threshold: 30 },
        'XAUUSD': { emaShort: 15, emaLong: 35, rsiPeriod: 14, duration: '1h', maxTradesDay: 2, threshold: 30 }
    };

    assets.forEach(asset => {
        state.assets[asset] = {
            candles: [],
            emaShort: 0,
            emaLong: 0,
            rsi: 0,
            adx: 0,
            dailyTrades: 0,
            dailyCalls: 0,
            dailyPuts: 0,
            winRate: 0.55,
            lossStreak: 0,
            lastTrades: [],
            blacklistUntil: 0,
            cooldownUntil: 0,
            previousEmaShort: 0,
            previousEmaLong: 0
        };
    });

    const workers = {};
    assets.forEach(asset => {
        workers[asset] = new Worker(__filename, { workerData: { asset } });
        workers[asset].on('message', (msg) => {
            if (msg.type === 'indicators') {
                const { emaShort, emaLong, rsi, adx } = msg;
                const prevShort = state.assets[asset].emaShort;
                const prevLong = state.assets[asset].emaLong;
                state.assets[asset].emaShort = emaShort;
                state.assets[asset].emaLong = emaLong;
                state.assets[asset].rsi = rsi;
                state.assets[asset].adx = adx;
                state.assets[asset].previousEmaShort = prevShort;
                state.assets[asset].previousEmaLong = prevLong;
                log(`Updated indicators for ${asset}: EMA${perAssetConfig[asset].emaShort}=${emaShort.toFixed(2)}, EMA${perAssetConfig[asset].emaLong}=${emaLong.toFixed(2)}, RSI=${rsi.toFixed(2)}, ADX=${adx.toFixed(2)}`);
                checkForSignal(asset);
            }
        });
    });

    let ws;
    function connect() {
        log('Connecting to Deriv WebSocket...');
        ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

        ws.on('open', () => {
            log('WebSocket connection opened');
            ws.send(JSON.stringify({ authorize: API_TOKEN }));
        });

        ws.on('close', () => {
            log('WebSocket connection closed, reconnecting in 5s...', 'WARN');
            setTimeout(connect, 5000);
        });

        ws.on('error', (error) => {
            log(`WebSocket error: ${error.message}`, 'ERROR');
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            handleMessage(msg);
        });
    }

    function handleMessage(msg) {
        if (msg.msg_type === 'authorize' && msg.authorize) {
            log('Authorized successfully');
            assets.forEach(asset => {
                const symbol = symbolMap[asset];
                log(`Requesting historical candles for ${asset} (${symbol})`);
                ws.send(JSON.stringify({
                    ticks_history: symbol,
                    adjust_start_time: 1,
                    count: 1000,
                    end: 'latest',
                    start: 1,
                    style: 'candles'
                }));
                log(`Subscribing to OHLC updates for ${asset} (${symbol})`);
                ws.send(JSON.stringify({
                    ohlc: symbol,
                    subscribe: 1,
                    granularity: 60
                }));
            });
        } else if (msg.msg_type === 'candles' || msg.msg_type === 'history' || msg.msg_type === 'ticks_history') {
            const asset = assets.find(a => symbolMap[a] === msg.echo_req.ticks_history);
            const candles = msg.candles || msg.history;
            if (asset && candles) {
                state.assets[asset].candles = candles.map(c => ({
                    time: c.epoch,
                    open: parseFloat(c.open || c.close),
                    high: parseFloat(c.high || c.close),
                    low: parseFloat(c.low || c.close),
                    close: parseFloat(c.close)
                }));
                log(`Received ${state.assets[asset].candles.length} historical records for ${asset}`);
                workers[asset].postMessage({ type: 'calculate', candles: state.assets[asset].candles, config: perAssetConfig[asset] });
            }
        } else if (msg.msg_type === 'ohlc') {
            const asset = assets.find(a => symbolMap[a] === msg.ohlc.symbol);
            if (asset) {
                const lastCandle = state.assets[asset].candles[state.assets[asset].candles.length - 1];
                if (lastCandle && lastCandle.time === msg.ohlc.open_time) {
                    lastCandle.high = Math.max(lastCandle.high, parseFloat(msg.ohlc.high));
                    lastCandle.low = Math.min(lastCandle.low, parseFloat(msg.ohlc.low));
                    lastCandle.close = parseFloat(msg.ohlc.close);
                } else {
                    state.assets[asset].candles.push({
                        time: msg.ohlc.open_time,
                        open: parseFloat(msg.ohlc.open),
                        high: parseFloat(msg.ohlc.high),
                        low: parseFloat(msg.ohlc.low),
                        close: parseFloat(msg.ohlc.close)
                    });
                    if (state.assets[asset].candles.length > 1000) state.assets[asset].candles.shift();
                }
                workers[asset].postMessage({ type: 'calculate', candles: state.assets[asset].candles, config: perAssetConfig[asset] });
            }
        } else if (msg.msg_type === 'tick') {
            const asset = assets.find(a => symbolMap[a] === msg.tick.symbol);
            if (asset) {
                const lastCandle = state.assets[asset].candles[state.assets[asset].candles.length - 1];
                if (lastCandle) {
                    lastCandle.close = parseFloat(msg.tick.quote);
                    lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
                    lastCandle.low = Math.min(lastCandle.low, lastCandle.close);
                    workers[asset].postMessage({ type: 'calculate', candles: state.assets[asset].candles, config: perAssetConfig[asset] });
                }
            }
        } else if (msg.msg_type === 'proposal') {
            const proposalId = msg.proposal.id;
            const buyPrice = msg.proposal.ask_price;
            log(`Received proposal ${proposalId}, buying for ${buyPrice}`);
            ws.send(JSON.stringify({ buy: proposalId, price: buyPrice }));
        } else if (msg.msg_type === 'buy') {
            const contractId = msg.buy.contract_id;
            const asset = msg.echo_req.passthrough.asset;
            log(`Bought contract ${contractId} for ${asset}`);
            state.portfolio.activePositions.push({ asset, contractId, type: msg.echo_req.contract_type });
            ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }));
            state.assets[asset].dailyTrades++;
            if (msg.echo_req.contract_type === 'CALL') state.assets[asset].dailyCalls++;
            else state.assets[asset].dailyPuts++;
        } else if (msg.msg_type === 'proposal_open_contract') {
            if (msg.proposal_open_contract.is_sold) {
                const profit = msg.proposal_open_contract.profit;
                const assetObj = state.portfolio.activePositions.find(p => p.contractId === msg.proposal_open_contract.contract_id);
                if (!assetObj) return;
                const asset = assetObj.asset;
                log(`Contract for ${asset} closed with profit: ${profit}`);
                state.portfolio.dailyProfit += profit;
                if (profit > 0) {
                    state.assets[asset].lossStreak = 0;
                    state.assets[asset].lastTrades.push(1);
                } else {
                    state.assets[asset].lossStreak++;
                    state.assets[asset].lastTrades.push(0);
                    state.portfolio.dailyLoss -= profit; // loss is negative profit
                    if (state.assets[asset].lossStreak >= 3) {
                        state.assets[asset].cooldownUntil = Date.now() + 4 * 3600 * 1000;
                        log(`${asset} entered cooldown due to 3 consecutive losses`);
                    }
                }
                if (state.assets[asset].lastTrades.length > 20) state.assets[asset].lastTrades.shift();
                state.assets[asset].winRate = state.assets[asset].lastTrades.length > 0
                    ? state.assets[asset].lastTrades.reduce((a, b) => a + b, 0) / state.assets[asset].lastTrades.length
                    : 0.55;
                state.portfolio.activePositions = state.portfolio.activePositions.filter(p => p.contractId !== msg.proposal_open_contract.contract_id);
                if (state.portfolio.dailyProfit > 0.025 * state.capital) {
                    state.capital += profit * 0.5;
                    log(`Locked 50% of gains, adjusted capital to ${state.capital}`);
                }
            }
        }
    }

    connect();


    function checkForSignal(asset) {
        const s = state.assets[asset];
        const config = perAssetConfig[asset];
        const crossUp = s.emaShort > s.emaLong && s.previousEmaShort <= s.previousEmaLong;
        const crossDown = s.emaShort < s.emaLong && s.previousEmaShort >= s.previousEmaLong;
        const rsiLow = s.rsi < config.threshold;
        const rsiHigh = s.rsi > (100 - config.threshold);
        const aiScore = calculateAIScore(s.emaShort, s.emaLong, s.rsi, s.adx);
        log(`Checking signal for ${asset}: CrossUp=${crossUp}, RSI Low=${rsiLow}, CrossDown=${crossDown}, RSI High=${rsiHigh}, AI Score=${aiScore}`);
        if (crossUp && rsiLow && aiScore > 60) {
            log(`CALL signal detected for ${asset}`);
            placeTrade(asset, 'CALL');
        } else if (crossDown && rsiHigh && aiScore > 60) {
            log(`PUT signal detected for ${asset}`);
            placeTrade(asset, 'PUT');
        }
    }

    function placeTrade(asset, type) {
        if (state.portfolio.activePositions.length >= 5) {
            log(`Cannot place trade on ${asset}: Max open positions reached`);
            return;
        }
        if (state.portfolio.dailyLoss > 0.05 * state.capital) {
            log(`Cannot place trade: Daily loss limit exceeded`);
            return;
        }
        if (state.portfolio.dailyProfit > 0.025 * state.capital) {
            log(`Cannot place trade: Daily profit target reached`);
            return;
        }
        const s = state.assets[asset];
        const config = perAssetConfig[asset];
        if (s.dailyTrades >= config.maxTradesDay) {
            log(`Cannot place trade on ${asset}: Max daily trades reached`);
            return;
        }
        if (type === 'CALL' && s.dailyCalls >= 3) {
            log(`Cannot place CALL on ${asset}: Max daily CALLs reached`);
            return;
        }
        if (type === 'PUT' && s.dailyPuts >= 3) {
            log(`Cannot place PUT on ${asset}: Max daily PUTs reached`);
            return;
        }
        if (Date.now() < s.cooldownUntil) {
            log(`Cannot place trade on ${asset}: In cooldown`);
            return;
        }
        if (Date.now() < s.blacklistUntil) {
            log(`Cannot place trade on ${asset}: Blacklisted`);
            return;
        }
        const topAssets = getTopAssets();
        if (!topAssets.includes(asset)) {
            log(`Cannot place trade on ${asset}: Not in top-2 assets`);
            return;
        }
        if (isCorrelatedSignal(asset, type)) {
            log(`Cannot place trade on ${asset}: Correlated signal on higher-ranked asset`);
            return;
        }
        const rank = topAssets.indexOf(asset);
        const riskSplit = rank === 0 ? 0.6 : 0.4;
        const stake = state.capital * 0.02 * riskSplit;
        const symbol = symbolMap[asset];
        const durationNum = parseInt(config.duration);
        const durationUnit = config.duration.slice(-1);
        log(`Placing ${type} trade on ${asset} (${symbol}) with stake ${stake.toFixed(2)}, duration ${durationNum}${durationUnit}`);
        ws.send(JSON.stringify({
            proposal: 1,
            amount: stake,
            basis: 'stake',
            contract_type: type,
            currency: 'USD',
            duration: durationNum,
            duration_unit: durationUnit,
            symbol: symbol,
            passthrough: { asset }
        }));
    }

    function getTopAssets() {
        const scores = assets.map(asset => ({ asset, score: calculateScore(asset) }));
        scores.sort((a, b) => b.score - a.score);
        const top = scores.slice(0, 2).map(s => s.asset);
        log(`Top assets: ${top.join(', ')} with scores ${scores.slice(0, 2).map(s => s.score.toFixed(2)).join(', ')}`);
        return top;
    }

    function calculateScore(asset) {
        const s = state.assets[asset];
        const recentWinRate = s.winRate;
        const trendStrength = s.adx / 100;
        const volatilityFit = calculateVolFit(asset);
        const predictability = calculatePredictability(asset);
        const score = (recentWinRate * 0.3) + (trendStrength * 0.25) + (volatilityFit * 0.2) + (predictability * 0.25);
        log(`Calculated score for ${asset}: ${score.toFixed(2)} (WinRate=${recentWinRate}, Trend=${trendStrength.toFixed(2)}, VolFit=${volatilityFit.toFixed(2)}, Predict=${predictability.toFixed(2)})`);
        return score;
    }

    function calculateVolFit(asset) {
        const candles = state.assets[asset].candles;
        if (candles.length < 2) return 0.5;
        const closes = candles.map(c => c.close);
        const returns = [];
        for (let i = 1; i < closes.length; i++) {
            returns.push(Math.abs(closes[i] - closes[i - 1]) / closes[i - 1]);
        }
        const vol = math.std(returns) || 0;
        let expected = 0.05;
        if (asset.includes('10') || asset.includes('V10')) expected = 0.01;
        else if (asset.includes('25')) expected = 0.025;
        else if (asset.includes('75')) expected = 0.075;
        else if (asset.includes('BOOM') || asset.includes('CRASH')) expected = 0.1;
        return Math.max(0, 1 - Math.abs(vol - expected) / expected);
    }

    function calculatePredictability(asset) {
        const prices = state.assets[asset].candles.map(c => c.close);
        if (prices.length < 5) return 0.5;

        const data = prices.map(p => [p]);
        const km = new KMeans({ K: 5 });
        km.autoCluster(data);

        const clusterSizes = km.clusters.map(c => c.length);
        const probs = clusterSizes.map(size => size / prices.length).filter(p => p > 0);
        const entropy = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
        return 1 - entropy / Math.log2(5);
    }

    function calculateAIScore(emaS, emaL, rsi, adx) {
        // Enhanced rule-based logic using multiple factors without TensorFlow
        let score = 50; // Base score
        const emaDiff = Math.abs(emaS - emaL) / emaL;
        if (emaDiff > 0.02) score += 10; // Strong EMA separation
        else if (emaDiff > 0.01) score += 5;
        if (adx > 30) score += 15; // Strong trend
        else if (adx > 20) score += 10;
        if (rsi < 20 || rsi > 80) score += 15; // Extreme RSI
        else if (rsi < 30 || rsi > 70) score += 10;
        // Additional logic: Check for divergence or other patterns if needed
        return Math.min(100, Math.max(0, score));
    }

    function isCorrelatedSignal(asset, type) {
        const correlatedGroups = [
            ['R_75', 'R_25'], // Assuming R_100 typo or similar; adjust as needed
            ['FRXEURUSD', 'FRXGBPUSD']
        ];
        for (const group of correlatedGroups) {
            if (group.includes(asset)) {
                const other = group.find(a => a !== asset);
                if (other && hasSignal(other, type)) {
                    const scoreA = calculateScore(asset);
                    const scoreO = calculateScore(other);
                    if (scoreA < scoreO) return true;
                }
            }
        }
        return false;
    }

    function hasSignal(asset, type) {
        const s = state.assets[asset];
        const config = perAssetConfig[asset];
        const crossUp = s.emaShort > s.emaLong && s.previousEmaShort <= s.previousEmaLong;
        const crossDown = s.emaShort < s.emaLong && s.previousEmaShort >= s.previousEmaLong;
        const rsiLow = s.rsi < config.threshold;
        const rsiHigh = s.rsi > (100 - config.threshold);
        if (type === 'CALL') return crossUp && rsiLow;
        if (type === 'PUT') return crossDown && rsiHigh;
        return false;
    }

    // Set interval for rebalancing (every 4 hours)
    setInterval(() => {
        log('Rebalancing portfolio');
        // Logic for rebalance if needed; allocations are dynamic per trade
    }, 4 * 3600 * 1000);

    // Set interval for scoring (every 5 min), but since signal-driven, optional
    setInterval(() => {
        log('Performing asset scoring');
        getTopAssets();
    }, 5 * 60 * 1000);

} else {
    // Worker code
    const perAssetConfig = { // Duplicated for worker
        'R_10': { emaShort: 8, emaLong: 21, rsiPeriod: 14, duration: '15m', maxTradesDay: 2, threshold: 30 },
        'R_25': { emaShort: 8, emaLong: 21, rsiPeriod: 14, duration: '15m', maxTradesDay: 2, threshold: 30 },
        'R_75': { emaShort: 12, emaLong: 30, rsiPeriod: 21, duration: '30m', maxTradesDay: 1, threshold: 30 },
        'BOOM1000': { emaShort: 5, emaLong: 15, rsiPeriod: 7, duration: '5m', maxTradesDay: 3, threshold: 30 },
        'CRASH1000': { emaShort: 5, emaLong: 15, rsiPeriod: 7, duration: '5m', maxTradesDay: 3, threshold: 30 },
        'FRXEURUSD': { emaShort: 10, emaLong: 25, rsiPeriod: 14, duration: '4h', maxTradesDay: 1, threshold: 30 },
        'FRXGBPUSD': { emaShort: 10, emaLong: 25, rsiPeriod: 14, duration: '4h', maxTradesDay: 1, threshold: 30 },
        'FRXUSDJPY': { emaShort: 10, emaLong: 25, rsiPeriod: 14, duration: '4h', maxTradesDay: 1, threshold: 30 },
        'WTI': { emaShort: 15, emaLong: 35, rsiPeriod: 14, duration: '1h', maxTradesDay: 2, threshold: 30 },
        'XAUUSD': { emaShort: 15, emaLong: 35, rsiPeriod: 14, duration: '1h', maxTradesDay: 2, threshold: 30 }
    };
    parentPort.on('message', (msg) => {
        if (msg.type === 'calculate') {
            const { candles, config } = msg;
            if (candles.length < 100) return;
            const closes = candles.map(c => parseFloat(c.close));
            const highs = candles.map(c => parseFloat(c.high));
            const lows = candles.map(c => parseFloat(c.low));
            const emaShort = calculateEMA(closes, config.emaShort);
            const emaLong = calculateEMA(closes, config.emaLong);
            const rsi = calculateRSI(closes, config.rsiPeriod);
            const adx = calculateADX(highs, lows, closes);
            parentPort.postMessage({ type: 'indicators', emaShort, emaLong, rsi, adx });
        }
    });
}