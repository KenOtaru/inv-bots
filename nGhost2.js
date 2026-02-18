#!/usr/bin/env node

// ============================================================================
//  ROMANIAN GHOST - Deriv Digit Differ Trading Bot v1.0
//  Strategy: Digit frequency analysis + Ghost confirmation + Martingale recovery
//  Market: Synthetic Indices - Digit Differ contracts
//  API: Deriv WebSocket API v3
// ============================================================================

const WebSocket = require('ws');

// ============================================================================
//  CONFIGURATION - Edit these values before running
// ============================================================================
const CONFIG = {
    // API Connection
    app_id: 1089,
    api_token: '0P94g4WdSrSrzir',
    endpoint: 'wss://ws.derivws.com/websockets/v3',

    // Trading Parameters
    symbol: 'R_100',
    base_stake: 0.61,
    currency: 'USD',
    contract_type: 'DIGITDIFF',

    // Analysis Parameters
    analysis_window: 30,
    frequency_threshold: 7,

    // Ghost Trading Parameters
    ghost_enabled: true,
    ghost_wins_required: 3,
    ghost_max_rounds: 20,

    // Martingale Parameters
    martingale_enabled: true,
    martingale_multiplier: 11,
    max_martingale_steps: 3,

    // Risk Management
    take_profit: 10,
    stop_loss: 50,
    max_stake: 500,

    // Session Management
    trades_per_session: 0,
    cooldown_after_max_loss: 30000,
    delay_between_trades: 1500,
};

// ============================================================================
//  ANSI COLOR CONSTANTS
// ============================================================================
const C = {
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    BG_RED: '\x1b[41m',
    BG_GREEN: '\x1b[42m',
};

// ============================================================================
//  BOT STATES
// ============================================================================
const STATE = {
    INITIALIZING: 'INITIALIZING',
    CONNECTING: 'CONNECTING',
    AUTHENTICATING: 'AUTHENTICATING',
    COLLECTING_TICKS: 'COLLECTING_TICKS',
    ANALYZING: 'ANALYZING',
    GHOST_TRADING: 'GHOST_TRADING',
    PLACING_TRADE: 'PLACING_TRADE',
    WAITING_RESULT: 'WAITING_RESULT',
    PROCESSING_RESULT: 'PROCESSING_RESULT',
    COOLDOWN: 'COOLDOWN',
    STOPPED: 'STOPPED',
};

// ============================================================================
//  STATE VARIABLES
// ============================================================================
let ws = null;
let botState = STATE.INITIALIZING;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let pingInterval = null;
let requestId = 0;

// Account
let accountBalance = 0;
let startingBalance = 0;
let accountId = '';
let accountCurrency = '';

// Tick Data
let tickHistory = [];
let decimalPlaces = 2;

// Analysis
let targetDigit = -1;
let digitFrequencies = new Array(10).fill(0);
let analysisConfidence = 'NONE';

// Ghost Trading
let ghostConsecutiveWins = 0;
let ghostRoundsPlayed = 0;
let ghostConfirmed = false;

// Trading
let currentStake = CONFIG.base_stake;
let martingaleStep = 0;
let totalMartingaleLoss = 0;
let isTradeActive = false;
let lastBuyPrice = 0;
let lastContractId = null;
let actualProfitRate = 0.10;

// Session Statistics
let sessionStartTime = Date.now();
let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let sessionProfit = 0;
let currentWinStreak = 0;
let currentLossStreak = 0;
let maxWinStreak = 0;
let maxLossStreak = 0;
let maxMartingaleStepReached = 0;
let largestWin = 0;
let largestLoss = 0;

// Cooldown
let cooldownTimer = null;

// Pending trade data for matching results
let pendingTradeDigit = -1;

// ============================================================================
//  UTILITY FUNCTIONS
// ============================================================================

function getTimestamp() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function log(prefix, color, message) {
    console.log(`${C.DIM}[${getTimestamp()}]${C.RESET} ${color}[${prefix}]${C.RESET} ${message}`);
}

function logBot(msg) { log('BOT', C.CYAN, msg); }
function logApi(msg) { log('API', C.BLUE, msg); }
function logTick(msg) { log('TICK', C.DIM, msg); }
function logAnalysis(msg) { log('ANALYSIS', C.YELLOW, msg); }
function logGhost(msg) { log('GHOST', C.MAGENTA, msg); }
function logTrade(msg) { log('TRADE', `${C.WHITE}${C.BOLD}`, msg); }
function logResult(msg) { log('RESULT', C.GREEN, msg); }
function logResultLoss(msg) { log('RESULT', C.RED, msg); }
function logRisk(msg) { log('RISK', `${C.RED}${C.BOLD}`, msg); }
function logStats(msg) { log('STATS', C.CYAN, msg); }
function logError(msg) { log('ERROR', C.RED, msg); }

function getNextReqId() {
    return ++requestId;
}

function getLastDigit(price) {
    const priceStr = String(price);

    if (priceStr.includes('.')) {
        return parseInt(priceStr.charAt(priceStr.length - 1), 10);
    }

    return parseInt(priceStr.charAt(priceStr.length - 1), 10);
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
    }
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatMoney(amount) {
    const sign = amount >= 0 ? '+' : '';
    return `${sign}$${amount.toFixed(2)}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
//  WEBSOCKET CONNECTION
// ============================================================================

function connect() {
    botState = STATE.CONNECTING;
    const url = `${CONFIG.endpoint}?app_id=${CONFIG.app_id}`;

    logApi(`Connecting to Deriv WebSocket API...`);
    logApi(`${C.DIM}Endpoint: ${url}${C.RESET}`);

    ws = new WebSocket(url);

    ws.on('open', onOpen);
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
}

function onOpen() {
    logApi(`${C.GREEN}✅ Connected successfully${C.RESET}`);
    reconnectAttempts = 0;

    // Start ping interval to keep connection alive
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            sendRequest({ ping: 1 });
        }
    }, 30000);

    // Authenticate
    botState = STATE.AUTHENTICATING;
    logApi('Authenticating...');
    sendRequest({ authorize: CONFIG.api_token });
}

function onMessage(data) {
    try {
        const msg = JSON.parse(data.toString());
        handleMessage(msg);
    } catch (err) {
        logError(`Failed to parse message: ${err.message}`);
    }
}

function onClose(code, reason) {
    logApi(`${C.YELLOW}⚠️ Connection closed (code: ${code})${C.RESET}`);

    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }

    if (botState !== STATE.STOPPED) {
        attemptReconnect();
    }
}

function onError(err) {
    logError(`WebSocket error: ${err.message}`);
}

function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        logError(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping bot.`);
        shutdown('Max reconnect attempts exceeded');
        return;
    }

    reconnectAttempts++;
    const delay = Math.pow(2, reconnectAttempts - 1) * 1000; // 1s, 2s, 4s, 8s, 16s

    logApi(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

    // Reset trade state on reconnect
    isTradeActive = false;

    setTimeout(() => {
        if (botState !== STATE.STOPPED) {
            connect();
        }
    }, delay);
}

function sendRequest(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        logError('Cannot send request - WebSocket not open');
        return;
    }

    if (!payload.ping) {
        payload.req_id = getNextReqId();
    }

    try {
        ws.send(JSON.stringify(payload));
    } catch (err) {
        logError(`Failed to send request: ${err.message}`);
    }
}

// ============================================================================
//  MESSAGE ROUTER
// ============================================================================

function handleMessage(msg) {
    // Check for error responses
    if (msg.error) {
        handleApiError(msg);
        return;
    }

    switch (msg.msg_type) {
        case 'authorize':
            handleAuth(msg);
            break;
        case 'balance':
            handleBalance(msg);
            break;
        case 'tick':
            handleTick(msg);
            break;
        case 'buy':
            handleBuy(msg);
            break;
        case 'transaction':
            handleTransaction(msg);
            break;
        case 'ping':
            // Pong - ignore
            break;
        default:
            // Ignore other message types silently
            break;
    }
}

function handleApiError(msg) {
    const errorCode = msg.error.code || 'UNKNOWN';
    const errorMsg = msg.error.message || 'Unknown error';
    const msgType = msg.msg_type || 'unknown';

    logError(`API Error [${errorCode}] on ${msgType}: ${errorMsg}`);

    // Handle specific errors
    switch (errorCode) {
        case 'InvalidToken':
        case 'AuthorizationRequired':
            logError('Invalid API token. Please check your CONFIG.api_token');
            shutdown('Authentication failed');
            break;

        case 'RateLimit':
            logError('Rate limited. Pausing for 10 seconds...');
            setTimeout(() => {
                if (botState !== STATE.STOPPED && isTradeActive) {
                    isTradeActive = false;
                    executeTradeFlow();
                }
            }, 10000);
            break;

        case 'InsufficientBalance':
            logRisk('💸 Insufficient balance to place trade!');
            shutdown('Insufficient balance');
            break;

        case 'ContractBuyValidationError':
        case 'InvalidContractProposal':
            logError(`Contract error: ${errorMsg}`);
            isTradeActive = false;
            if (martingaleStep > 0) {
                logRisk('Trade failed during Martingale recovery. Resetting...');
                resetMartingale();
            }
            botState = STATE.ANALYZING;
            break;

        default:
            if (msg.msg_type === 'buy') {
                logError('Buy failed. Resetting trade state...');
                isTradeActive = false;
                if (martingaleStep > 0) {
                    // Retry the trade after a delay
                    setTimeout(() => executeTradeFlow(), CONFIG.delay_between_trades);
                } else {
                    botState = STATE.ANALYZING;
                }
            }
            break;
    }
}

// ============================================================================
//  HANDLER: AUTHENTICATION
// ============================================================================

function handleAuth(msg) {
    if (msg.authorize) {
        const auth = msg.authorize;
        accountBalance = parseFloat(auth.balance);
        startingBalance = accountBalance;
        accountId = auth.loginid || 'N/A';
        accountCurrency = auth.currency || CONFIG.currency;

        logApi(`${C.GREEN}✅ Authenticated${C.RESET} | Account: ${C.BOLD}${accountId}${C.RESET} | Balance: ${C.GREEN}$${accountBalance.toFixed(2)}${C.RESET}`);

        // Check if it's a demo or real account
        if (accountId.startsWith('VRTC')) {
            logBot(`${C.YELLOW}📋 Demo account detected - safe for testing${C.RESET}`);
        } else {
            logBot(`${C.RED}${C.BOLD}⚠️  REAL ACCOUNT DETECTED - Trading with real money!${C.RESET}`);
        }

        // Subscribe to balance updates
        sendRequest({ balance: 1, subscribe: 1 });

        // Subscribe to transaction updates
        sendRequest({ transaction: 1, subscribe: 1 });

        // Subscribe to ticks
        botState = STATE.COLLECTING_TICKS;
        logBot(`Subscribing to ticks for ${C.BOLD}${CONFIG.symbol}${C.RESET}...`);
        sendRequest({ ticks: CONFIG.symbol, subscribe: 1 });

        logBot(`Collecting ticks for analysis (0/${CONFIG.analysis_window})...`);
    }
}

// ============================================================================
//  HANDLER: BALANCE UPDATES
// ============================================================================

function handleBalance(msg) {
    if (msg.balance) {
        const newBalance = parseFloat(msg.balance.balance);
        accountBalance = newBalance;
    }
}

// ============================================================================
//  HANDLER: TICK PROCESSING
// ============================================================================

function handleTick(msg) {
    if (!msg.tick) return;

    const tick = msg.tick;
    const price = tick.quote;
    const lastDigit = getLastDigit(price);

    // Add to history (rolling window)
    tickHistory.push(lastDigit);
    if (tickHistory.length > CONFIG.analysis_window * 2) {
        tickHistory = tickHistory.slice(-CONFIG.analysis_window * 2);
    }

    const tickCount = Math.min(tickHistory.length, CONFIG.analysis_window);

    // Log tick
    if (botState === STATE.COLLECTING_TICKS) {
        logTick(`Price: ${price} | Last Digit: ${C.BOLD}${lastDigit}${C.RESET} | Ticks: ${tickCount}/${CONFIG.analysis_window}`);
    }

    // State-specific tick processing
    switch (botState) {
        case STATE.COLLECTING_TICKS:
            if (tickHistory.length >= CONFIG.analysis_window) {
                botState = STATE.ANALYZING;
                analyzeDigits();
                processPostAnalysis(lastDigit);
            }
            break;

        case STATE.ANALYZING:
            analyzeDigits();
            processPostAnalysis(lastDigit);
            break;

        case STATE.GHOST_TRADING:
            analyzeDigits();
            runGhostCheck(lastDigit);
            break;

        case STATE.WAITING_RESULT:
            // Still collecting data while waiting
            break;

        case STATE.COOLDOWN:
            // Still collecting data during cooldown
            break;

        default:
            break;
    }
}

// ============================================================================
//  DIGIT FREQUENCY ANALYSIS
// ============================================================================

function analyzeDigits() {
    // Reset frequencies
    digitFrequencies = new Array(10).fill(0);

    // Get the analysis window
    const window = tickHistory.slice(-CONFIG.analysis_window);

    // Count frequencies
    for (const digit of window) {
        digitFrequencies[digit]++;
    }

    // Find most frequent digit
    let maxFreq = 0;
    let maxDigit = 0;
    const expectedFreq = CONFIG.analysis_window / 10;

    for (let i = 0; i <= 9; i++) {
        if (digitFrequencies[i] > maxFreq) {
            maxFreq = digitFrequencies[i];
            maxDigit = i;
        }
    }

    targetDigit = maxDigit;

    // Determine confidence
    const excess = maxFreq - expectedFreq;
    if (excess >= CONFIG.frequency_threshold) {
        analysisConfidence = 'HIGH';
    } else if (excess >= CONFIG.frequency_threshold / 2) {
        analysisConfidence = 'MEDIUM';
    } else {
        analysisConfidence = 'LOW';
    }

    // Format frequency display
    const freqDisplay = digitFrequencies.map((f, i) => {
        if (i === targetDigit) {
            return `${C.BOLD}${C.YELLOW}${i}:${f}${C.RESET}`;
        }
        return `${i}:${f}`;
    }).join(', ');

    logAnalysis(`Frequencies: {${freqDisplay}} | Target: ${C.BOLD}${targetDigit}${C.RESET} (${maxFreq}x, expected ${expectedFreq.toFixed(1)}, confidence: ${analysisConfidence})`);

    if (analysisConfidence === 'LOW') {
        logAnalysis(`${C.YELLOW}⚠️ Low confidence - digit distribution is relatively even${C.RESET}`);
    }
}

// ============================================================================
//  POST-ANALYSIS FLOW
// ============================================================================

function processPostAnalysis(lastDigit) {
    if (CONFIG.ghost_enabled && !ghostConfirmed) {
        botState = STATE.GHOST_TRADING;
        if (ghostRoundsPlayed === 0) {
            logGhost(`Starting ghost trading phase (need ${CONFIG.ghost_wins_required} consecutive wins)...`);
        }
        runGhostCheck(lastDigit);
    } else {
        // Ghost disabled or already confirmed - go straight to trading
        executeTradeFlow();
    }
}

// ============================================================================
//  GHOST TRADING SYSTEM
// ============================================================================

function runGhostCheck(lastDigit) {
    if (botState !== STATE.GHOST_TRADING) return;

    ghostRoundsPlayed++;

    // Simulate what would happen if we traded Differ on targetDigit
    const wouldWin = lastDigit !== targetDigit;

    if (wouldWin) {
        ghostConsecutiveWins++;
        logGhost(`Virtual trade: DIFFER from ${C.BOLD}${targetDigit}${C.RESET} | Tick digit: ${C.BOLD}${lastDigit}${C.RESET} | ${C.GREEN}✅ WIN${C.RESET} (streak: ${ghostConsecutiveWins}/${CONFIG.ghost_wins_required})`);

        if (ghostConsecutiveWins >= CONFIG.ghost_wins_required) {
            ghostConfirmed = true;
            logGhost(`${C.GREEN}${C.BOLD}✅ Ghost confirmation achieved! ${ghostConsecutiveWins} consecutive virtual wins. Going LIVE!${C.RESET}`);

            // Transition to live trading
            executeTradeFlow();
        }
    } else {
        logGhost(`Virtual trade: DIFFER from ${C.BOLD}${targetDigit}${C.RESET} | Tick digit: ${C.BOLD}${lastDigit}${C.RESET} | ${C.RED}❌ LOSS${C.RESET} (streak reset: 0/${CONFIG.ghost_wins_required})`);
        ghostConsecutiveWins = 0;
    }

    // Check if max ghost rounds exceeded
    if (!ghostConfirmed && ghostRoundsPlayed >= CONFIG.ghost_max_rounds) {
        logGhost(`${C.YELLOW}⚠️ Max ghost rounds (${CONFIG.ghost_max_rounds}) reached without confirmation. Re-analyzing...${C.RESET}`);
        resetGhost();
        botState = STATE.ANALYZING;
    }
}

function resetGhost() {
    ghostConsecutiveWins = 0;
    ghostRoundsPlayed = 0;
    ghostConfirmed = false;
}

// ============================================================================
//  TRADE EXECUTION FLOW
// ============================================================================

async function executeTradeFlow() {
    // Prevent concurrent trades
    if (isTradeActive) return;

    // Check risk limits before trading
    const riskCheck = checkRiskLimits();
    if (!riskCheck.canTrade) {
        logRisk(riskCheck.reason);
        if (riskCheck.action === 'STOP') {
            shutdown(riskCheck.reason);
        } else if (riskCheck.action === 'COOLDOWN') {
            startCooldown();
        }
        return;
    }

    // Calculate stake
    currentStake = calculateStake();

    // Final stake checks
    if (currentStake > CONFIG.max_stake) {
        logRisk(`Calculated stake $${currentStake.toFixed(2)} exceeds max stake $${CONFIG.max_stake.toFixed(2)}. Stopping.`);
        shutdown('Stake exceeds maximum');
        return;
    }

    if (currentStake > accountBalance) {
        logRisk(`💸 Stake $${currentStake.toFixed(2)} exceeds balance $${accountBalance.toFixed(2)}. Stopping.`);
        shutdown('Insufficient balance for stake');
        return;
    }

    // Delay between trades
    if (totalTrades > 0) {
        await sleep(CONFIG.delay_between_trades);
    }

    // Double-check we're still allowed to trade after the delay
    if (botState === STATE.STOPPED) return;

    placeTrade();
}

// ============================================================================
//  PLACE TRADE
// ============================================================================

function placeTrade() {
    isTradeActive = true;
    botState = STATE.PLACING_TRADE;
    pendingTradeDigit = targetDigit;

    const stepLabel = CONFIG.martingale_enabled ? ` | Martingale: Step ${martingaleStep}` : '';

    logTrade(`🎯 DIFFER from digit ${C.BOLD}${targetDigit}${C.RESET} | Stake: ${C.BOLD}$${currentStake.toFixed(2)}${C.RESET}${stepLabel}`);

    sendRequest({
        buy: 1,
        price: currentStake,
        parameters: {
            contract_type: CONFIG.contract_type,
            symbol: CONFIG.symbol,
            duration: 1,
            duration_unit: 't',
            basis: 'stake',
            amount: currentStake,
            barrier: String(targetDigit),
            currency: CONFIG.currency,
        },
    });

    botState = STATE.WAITING_RESULT;
}

// ============================================================================
//  HANDLER: BUY RESPONSE
// ============================================================================

function handleBuy(msg) {
    if (!msg.buy) return;

    const buy = msg.buy;
    lastContractId = buy.contract_id;
    lastBuyPrice = parseFloat(buy.buy_price);
    const payout = parseFloat(buy.payout);

    // Calculate actual profit rate from real payout data
    if (lastBuyPrice > 0 && payout > 0) {
        actualProfitRate = (payout / lastBuyPrice) - 1;
        // logBot(`${C.DIM}Actual profit rate: ${(actualProfitRate * 100).toFixed(2)}%${C.RESET}`);
    }

    logTrade(`${C.DIM}Contract ${lastContractId} purchased | Cost: $${lastBuyPrice.toFixed(2)} | Potential payout: $${payout.toFixed(2)}${C.RESET}`);

    // For 1-tick digit contracts, result comes via transaction stream
    // We wait in WAITING_RESULT state
}

// ============================================================================
//  HANDLER: TRANSACTION (TRADE RESULT)
// ============================================================================

function handleTransaction(msg) {
    if (!msg.transaction) return;

    const txn = msg.transaction;

    // We only care about sell transactions (contract settlement)
    if (txn.action !== 'sell') return;

    // Only process if we have an active trade
    if (!isTradeActive) return;

    botState = STATE.PROCESSING_RESULT;

    const payout = parseFloat(txn.amount) || 0;
    const profit = payout - lastBuyPrice;

    totalTrades++;

    if (profit > 0) {
        processWin(profit, payout);
    } else {
        processLoss(lastBuyPrice);
    }

    // Print mini stats every 10 trades
    if (totalTrades % 10 === 0) {
        printMiniStats();
    }

    isTradeActive = false;

    // Decide next action
    decideNextAction();
}

// ============================================================================
//  PROCESS WIN
// ============================================================================

function processWin(profit, payout) {
    totalWins++;
    sessionProfit += profit;
    currentWinStreak++;
    currentLossStreak = 0;

    if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
    if (profit > largestWin) largestWin = profit;

    const martingaleNote = martingaleStep > 0 ? ` ${C.GREEN}${C.BOLD}🔄 RECOVERY SUCCESS!${C.RESET}` : '';

    logResult(`${C.GREEN}✅ WIN!${C.RESET} Profit: ${C.GREEN}+$${profit.toFixed(2)}${C.RESET} | Session P/L: ${formatSessionPL()} | Balance: ${C.GREEN}$${accountBalance.toFixed(2)}${C.RESET}${martingaleNote}`);

    // Reset Martingale on win
    resetMartingale();

    // Reset ghost for next cycle
    if (CONFIG.ghost_enabled) {
        resetGhost();
    }
}

// ============================================================================
//  PROCESS LOSS
// ============================================================================

function processLoss(lostAmount) {
    totalLosses++;
    sessionProfit -= lostAmount;
    totalMartingaleLoss += lostAmount;
    currentLossStreak++;
    currentWinStreak = 0;

    if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    if (lostAmount > largestLoss) largestLoss = lostAmount;

    martingaleStep++;
    if (martingaleStep > maxMartingaleStepReached) {
        maxMartingaleStepReached = martingaleStep;
    }

    const martingaleInfo = CONFIG.martingale_enabled
        ? ` | Martingale: Step ${martingaleStep}/${CONFIG.max_martingale_steps}`
        : '';

    logResultLoss(`${C.RED}❌ LOSS!${C.RESET} Loss: ${C.RED}-$${lostAmount.toFixed(2)}${C.RESET} | Session P/L: ${formatSessionPL()} | Balance: $${accountBalance.toFixed(2)}${martingaleInfo}`);
}

// ============================================================================
//  DECIDE NEXT ACTION
// ============================================================================

function decideNextAction() {
    // Check risk limits
    const riskCheck = checkRiskLimits();
    if (!riskCheck.canTrade) {
        logRisk(riskCheck.reason);
        if (riskCheck.action === 'STOP') {
            shutdown(riskCheck.reason);
            return;
        } else if (riskCheck.action === 'COOLDOWN') {
            startCooldown();
            return;
        }
    }

    // If we're in a Martingale recovery and haven't exceeded max steps
    if (CONFIG.martingale_enabled && martingaleStep > 0 && martingaleStep < CONFIG.max_martingale_steps) {
        logBot(`${C.YELLOW}📈 Martingale recovery - preparing next trade...${C.RESET}`);
        // Re-analyze and trade again
        botState = STATE.ANALYZING;
        // The next tick will trigger analysis and trade
        // For Martingale, skip ghost phase
        ghostConfirmed = true;
        return;
    }

    // Max Martingale steps reached
    if (CONFIG.martingale_enabled && martingaleStep >= CONFIG.max_martingale_steps) {
        logRisk(`🛑 Max Martingale steps (${CONFIG.max_martingale_steps}) reached!`);
        resetMartingale();
        startCooldown();
        return;
    }

    // Normal flow - go back to analysis
    botState = STATE.ANALYZING;
}

// ============================================================================
//  STAKE CALCULATION
// ============================================================================

function calculateStake() {
    if (!CONFIG.martingale_enabled || martingaleStep === 0) {
        return CONFIG.base_stake;
    }

    // Calculate stake needed to recover all losses + earn base profit
    const profitRate = actualProfitRate > 0 ? actualProfitRate : 0.10;
    const recoveryStake = (totalMartingaleLoss + CONFIG.base_stake) / profitRate;

    // Round to 2 decimal places
    const calculatedStake = Math.round(recoveryStake * 100) / 100;

    // Apply max stake cap
    const finalStake = Math.min(calculatedStake, CONFIG.max_stake);

    logBot(`${C.DIM}Martingale stake calculation: Loss to recover: $${totalMartingaleLoss.toFixed(2)} | Profit rate: ${(profitRate * 100).toFixed(1)}% | Next stake: $${finalStake.toFixed(2)}${C.RESET}`);

    return finalStake;
}

// ============================================================================
//  RISK MANAGEMENT
// ============================================================================

function checkRiskLimits() {
    // Take profit
    if (sessionProfit >= CONFIG.take_profit) {
        return {
            canTrade: false,
            reason: `🎯 Take profit reached! Session profit: ${formatMoney(sessionProfit)}`,
            action: 'STOP',
        };
    }

    // Stop loss
    if (sessionProfit <= -CONFIG.stop_loss) {
        return {
            canTrade: false,
            reason: `🛑 Stop loss reached! Session loss: ${formatMoney(sessionProfit)}`,
            action: 'STOP',
        };
    }

    // Max trades per session
    if (CONFIG.trades_per_session > 0 && totalTrades >= CONFIG.trades_per_session) {
        return {
            canTrade: false,
            reason: `📊 Maximum trades per session (${CONFIG.trades_per_session}) reached.`,
            action: 'STOP',
        };
    }

    // Balance check
    const nextStake = calculateStakePreview();
    if (nextStake > accountBalance) {
        return {
            canTrade: false,
            reason: `💸 Next stake ($${nextStake.toFixed(2)}) exceeds balance ($${accountBalance.toFixed(2)})`,
            action: 'STOP',
        };
    }

    // Max stake check
    if (nextStake > CONFIG.max_stake) {
        return {
            canTrade: false,
            reason: `📈 Next stake ($${nextStake.toFixed(2)}) exceeds max stake ($${CONFIG.max_stake.toFixed(2)})`,
            action: 'STOP',
        };
    }

    // Max Martingale steps
    if (CONFIG.martingale_enabled && martingaleStep >= CONFIG.max_martingale_steps) {
        return {
            canTrade: false,
            reason: `🔄 Max Martingale steps (${CONFIG.max_martingale_steps}) reached. Entering cooldown.`,
            action: 'COOLDOWN',
        };
    }

    return { canTrade: true };
}

function calculateStakePreview() {
    if (!CONFIG.martingale_enabled || martingaleStep === 0) {
        return CONFIG.base_stake;
    }

    const profitRate = actualProfitRate > 0 ? actualProfitRate : 0.10;
    const recoveryStake = (totalMartingaleLoss + CONFIG.base_stake) / profitRate;
    return Math.min(Math.round(recoveryStake * 100) / 100, CONFIG.max_stake);
}

// ============================================================================
//  MARTINGALE RESET
// ============================================================================

function resetMartingale() {
    martingaleStep = 0;
    totalMartingaleLoss = 0;
    currentStake = CONFIG.base_stake;
}

// ============================================================================
//  COOLDOWN
// ============================================================================

function startCooldown() {
    botState = STATE.COOLDOWN;
    resetMartingale();
    resetGhost();

    const cooldownSec = CONFIG.cooldown_after_max_loss / 1000;
    logBot(`${C.YELLOW}⏸️ Entering cooldown for ${cooldownSec} seconds...${C.RESET}`);

    cooldownTimer = setTimeout(() => {
        if (botState === STATE.COOLDOWN) {
            logBot(`${C.GREEN}▶️ Cooldown ended. Resuming trading...${C.RESET}`);
            botState = STATE.ANALYZING;
            // Next tick will trigger analysis
        }
    }, CONFIG.cooldown_after_max_loss);
}

// ============================================================================
//  SESSION P/L FORMATTING
// ============================================================================

function formatSessionPL() {
    if (sessionProfit >= 0) {
        return `${C.GREEN}+$${sessionProfit.toFixed(2)}${C.RESET}`;
    } else {
        return `${C.RED}-$${Math.abs(sessionProfit).toFixed(2)}${C.RESET}`;
    }
}

// ============================================================================
//  STATISTICS
// ============================================================================

function printMiniStats() {
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';
    const avgProfit = totalTrades > 0 ? (sessionProfit / totalTrades).toFixed(4) : '0.00';

    logStats(`Trades: ${totalTrades} | W/L: ${C.GREEN}${totalWins}${C.RESET}/${C.RED}${totalLosses}${C.RESET} (${winRate}%) | P/L: ${formatSessionPL()} | Bal: $${accountBalance.toFixed(2)}`);
}

function printFullStats() {
    const duration = Date.now() - sessionStartTime;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0.0';
    const avgProfit = totalTrades > 0 ? (sessionProfit / totalTrades) : 0;

    console.log('');
    logStats(`${C.BOLD}══════════════════════════════════════════${C.RESET}`);
    logStats(`${C.BOLD}          SESSION SUMMARY${C.RESET}`);
    logStats(`${C.BOLD}══════════════════════════════════════════${C.RESET}`);
    logStats(`  Duration:           ${formatDuration(duration)}`);
    logStats(`  Symbol:             ${CONFIG.symbol}`);
    logStats(`  Total Trades:       ${totalTrades}`);
    logStats(`  Wins:               ${C.GREEN}${totalWins}${C.RESET}`);
    logStats(`  Losses:             ${C.RED}${totalLosses}${C.RESET}`);
    logStats(`  Win Rate:           ${winRate}%`);
    logStats(`  Session P/L:        ${formatSessionPL()}`);
    logStats(`  Starting Balance:   $${startingBalance.toFixed(2)}`);
    logStats(`  Final Balance:      $${accountBalance.toFixed(2)}`);
    logStats(`  Avg Profit/Trade:   ${formatMoney(avgProfit)}`);
    logStats(`  Largest Win:        ${C.GREEN}+$${largestWin.toFixed(2)}${C.RESET}`);
    logStats(`  Largest Loss:       ${C.RED}-$${largestLoss.toFixed(2)}${C.RESET}`);
    logStats(`  Max Win Streak:     ${C.GREEN}${maxWinStreak}${C.RESET}`);
    logStats(`  Max Loss Streak:    ${C.RED}${maxLossStreak}${C.RESET}`);
    logStats(`  Max Martingale:     Step ${maxMartingaleStepReached}`);
    logStats(`  Actual Profit Rate: ${(actualProfitRate * 100).toFixed(2)}%`);
    logStats(`${C.BOLD}══════════════════════════════════════════${C.RESET}`);
    console.log('');
}

// ============================================================================
//  SHUTDOWN
// ============================================================================

function shutdown(reason = 'User requested') {
    if (botState === STATE.STOPPED) return;

    botState = STATE.STOPPED;

    console.log('');
    logBot(`${C.YELLOW}${C.BOLD}🛑 Stopping bot... Reason: ${reason}${C.RESET}`);

    // Print final stats
    printFullStats();

    // Clear timers
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (cooldownTimer) {
        clearTimeout(cooldownTimer);
        cooldownTimer = null;
    }

    // Close WebSocket
    if (ws) {
        try {
            // Unsubscribe from all
            sendRequest({ forget_all: 'ticks' });
            sendRequest({ forget_all: 'balance' });
            sendRequest({ forget_all: 'transaction' });

            setTimeout(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
                logBot(`${C.CYAN}👋 Goodbye!${C.RESET}`);
                process.exit(0);
            }, 1000);
        } catch (e) {
            process.exit(0);
        }
    } else {
        logBot(`${C.CYAN}👋 Goodbye!${C.RESET}`);
        process.exit(0);
    }
}

// ============================================================================
//  SIGNAL HANDLERS
// ============================================================================

process.on('SIGINT', () => {
    console.log('');
    logBot('Received SIGINT (Ctrl+C)...');
    shutdown('User interrupted (Ctrl+C)');
});

process.on('SIGTERM', () => {
    logBot('Received SIGTERM...');
    shutdown('Process terminated');
});

process.on('uncaughtException', (err) => {
    logError(`Uncaught exception: ${err.message}`);
    logError(err.stack);
    shutdown('Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
    logError(`Unhandled rejection: ${reason}`);
    shutdown('Unhandled rejection');
});

// ============================================================================
//  STARTUP BANNER
// ============================================================================

function printBanner() {
    console.log('');
    console.log(`${C.CYAN}${C.BOLD}  ╔══════════════════════════════════════════════╗${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}  ║       👻 ROMANIAN GHOST BOT v1.0 👻          ║${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}  ║     Deriv Digit Differ Trading Strategy      ║${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}  ╚══════════════════════════════════════════════╝${C.RESET}`);
    console.log('');
    logBot(`Symbol:            ${C.BOLD}${CONFIG.symbol}${C.RESET}`);
    logBot(`Contract:          ${C.BOLD}${CONFIG.contract_type}${C.RESET}`);
    logBot(`Base Stake:        ${C.BOLD}$${CONFIG.base_stake.toFixed(2)}${C.RESET}`);
    logBot(`Analysis Window:   ${C.BOLD}${CONFIG.analysis_window} ticks${C.RESET}`);
    logBot(`Ghost Trading:     ${C.BOLD}${CONFIG.ghost_enabled ? `Enabled (${CONFIG.ghost_wins_required} wins needed)` : 'Disabled'}${C.RESET}`);
    logBot(`Martingale:        ${C.BOLD}${CONFIG.martingale_enabled ? `Enabled (max ${CONFIG.max_martingale_steps} steps, ~${CONFIG.martingale_multiplier}x multiplier)` : 'Disabled'}${C.RESET}`);
    logBot(`Take Profit:       ${C.GREEN}$${CONFIG.take_profit.toFixed(2)}${C.RESET}`);
    logBot(`Stop Loss:         ${C.RED}$${CONFIG.stop_loss.toFixed(2)}${C.RESET}`);
    logBot(`Max Stake:         ${C.BOLD}$${CONFIG.max_stake.toFixed(2)}${C.RESET}`);
    console.log('');
}

// ============================================================================
//  VALIDATE CONFIGURATION
// ============================================================================

function validateConfig() {
    const errors = [];

    if (CONFIG.api_token === 'YOUR_API_TOKEN_HERE' || !CONFIG.api_token) {
        errors.push('API token not set. Please edit CONFIG.api_token with your Deriv API token.');
        errors.push('Get one at: https://app.deriv.com/account/api-token');
    }

    if (CONFIG.base_stake < 0.35) {
        errors.push(`Base stake ($${CONFIG.base_stake}) is below Deriv minimum ($0.35).`);
    }

    if (CONFIG.max_martingale_steps < 1 || CONFIG.max_martingale_steps > 10) {
        errors.push('max_martingale_steps should be between 1 and 10.');
    }

    if (CONFIG.analysis_window < 10) {
        errors.push('analysis_window should be at least 10 ticks.');
    }

    if (CONFIG.take_profit <= 0) {
        errors.push('take_profit must be positive.');
    }

    if (CONFIG.stop_loss <= 0) {
        errors.push('stop_loss must be positive.');
    }

    // Warn about Martingale risks
    if (CONFIG.martingale_enabled && CONFIG.max_martingale_steps >= 3) {
        const profitRate = 0.10;
        let totalRisk = 0;
        let stake = CONFIG.base_stake;
        for (let i = 0; i < CONFIG.max_martingale_steps; i++) {
            totalRisk += stake;
            stake = Math.round(((totalRisk + CONFIG.base_stake) / profitRate) * 100) / 100;
        }
        logBot(`${C.YELLOW}⚠️ Martingale risk warning: ${CONFIG.max_martingale_steps} consecutive losses could cost ~$${totalRisk.toFixed(2)}${C.RESET}`);
    }

    if (errors.length > 0) {
        console.log('');
        logError(`${C.BOLD}Configuration errors found:${C.RESET}`);
        errors.forEach((err, i) => {
            logError(`  ${i + 1}. ${err}`);
        });
        console.log('');
        process.exit(1);
    }
}

// ============================================================================
//  MAIN ENTRY POINT
// ============================================================================

function main() {
    printBanner();
    validateConfig();

    logBot(`${C.BOLD}🤖 Starting Romanian Ghost Bot...${C.RESET}`);
    console.log('');

    sessionStartTime = Date.now();
    connect();
}

// Run the bot
main();