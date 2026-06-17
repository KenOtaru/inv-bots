/**
 * Deriv Accumulator Trading Bot
 * 
 * Features:
 * - Deriv API Token authentication
 * - Configurable Stake, Multiplier, Multiplier Step, Stop Loss, Take Profit
 * - Multi-Index asset trading
 * - Auto reconnection (server/network errors)
 * - Telegram notifications (Trade Open/Result, Hourly Summary, End of Day Summary)
 * - WebSocket-based real-time trading
 * 
 * Author: AI Assistant
 * 
 * Usage:
 *   1. npm install ws node-fetch dotenv
 *   2. Create a .env file with your credentials (see .env.example below)
 *   3. node deriv-accumulator-bot.js
 * 
 * .env example:
 *   DERIV_API_TOKEN=your_deriv_api_token_here
 *   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
 *   TELEGRAM_CHAT_ID=your_telegram_chat_id
 *   STAKE=1
 *   MULTIPLIER=5
 *   MULTIPLIER_STEP=1
 *   STOP_LOSS=10
 *   TAKE_PROFIT=20
 *   ASSETS=R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V
 *   MAX_TRADES_PER_HOUR=30
 *   TICK_ANALYSIS_WINDOW=100
 */

const WebSocket = require('ws');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // Deriv WebSocket endpoint
    WS_URL: 'wss://ws.derivws.com/websockets/v3?app_id=1089',
    
    // Telegram configuration
    TELEGRAM_API: 'https://api.telegram.org',
    
    // Trading assets (Volatility & Crash/Boom indices that support Accumulator)
    // ASSETS: (process.env.ASSETS || 'R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V').split(','),
    ASSETS: (process.env.ASSETS || '1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V').split(','),

    
    // Trading parameters
    STAKE: parseFloat(process.env.STAKE || '1'),
    MULTIPLIER: parseFloat(process.env.MULTIPLIER || '5'),
    MULTIPLIER_STEP: parseFloat(process.env.MULTIPLIER_STEP || '1'),
    STOP_LOSS: parseFloat(process.env.STOP_LOSS || '10'),
    TAKE_PROFIT: parseFloat(process.env.TAKE_PROFIT || '20'),
    
    // Analysis parameters
    TICK_ANALYSIS_WINDOW: parseInt(process.env.TICK_ANALYSIS_WINDOW || '100'),
    MIN_TICK_CONFIDENCE: parseFloat(process.env.MIN_TICK_CONFIDENCE || '0.55'),
    MAX_TRADES_PER_HOUR: parseInt(process.env.MAX_TRADES_PER_HOUR || '30'),
    
    // Reconnection
    RECONNECT_DELAY: 5000,
    MAX_RECONNECT_DELAY: 60000,
    PING_INTERVAL: 30000,
    
    // Telegram summary intervals (cron-like timers)
    HOURLY_SUMMARY_INTERVAL: 60 * 60 * 1000,   // 1 hour
    DAILY_SUMMARY_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
    
    // API Token
    DERIV_API_TOKEN: process.env.DERIV_API_TOKEN || '0P94g4WdSrSrzir',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '752497117',
};

// ============================================
// STATE MANAGEMENT
// ============================================
const STATE = {
    ws: null,
    isConnected: false,
    isAuthorized: false,
    reqId: 0,
    pendingRequests: new Map(),
    
    // Trading state
    activeTrades: new Map(),     // contract_id -> trade info
    dailyPnL: 0,
    sessionPnL: 0,
    totalStake: 0,
    totalPayout: 0,
    startingBalance: 0,
    currentBalance: 0,
    currency: 'USD',
    
    // Trade statistics
    tradeHistory: [],            // All trades for the session
    hourlyStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        startTime: Date.now(),
    },
    dailyStats: {
        date: new Date().toDateString(),
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0,
        assets: {},
    },
    
    // Rate limiting
    tradesThisHour: 0,
    hourStartTime: Date.now(),
    
    // Reconnection
    reconnectAttempts: 0,
    reconnectTimer: null,
    pingTimer: null,
    isShuttingDown: false,
    
    // Market data
    tickData: new Map(),         // asset -> array of recent ticks
    subscribedAssets: new Set(),
    
    // Strategy signals
    assetSignals: new Map(),     // asset -> { direction, confidence, timestamp }
};

// ============================================
// TELEGRAM NOTIFICATIONS
// ============================================
class TelegramNotifier {
    constructor(botToken, chatId) {
        this.botToken = botToken;
        this.chatId = chatId;
        this.enabled = !!(botToken && chatId);
    }
    
    async send(message, parseMode = 'HTML') {
        if (!this.enabled) {
            console.log(`[Telegram Disabled] ${message.replace(/<[^>]*>/g, '')}`);
            return;
        }
        
        return new Promise((resolve) => {
            const postData = JSON.stringify({
                chat_id: this.chatId,
                text: message,
                parse_mode: parseMode,
                disable_web_page_preview: true,
            });
            
            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${this.botToken}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: 10000,
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        console.log(`[Telegram] Sent: ${message.substring(0, 50)}...`);
                    } else {
                        console.error(`[Telegram Error] ${res.statusCode}: ${data}`);
                    }
                    resolve();
                });
            });
            
            req.on('error', (err) => {
                console.error(`[Telegram Network Error] ${err.message}`);
                resolve();
            });
            
            req.on('timeout', () => {
                req.destroy();
                console.error('[Telegram Timeout]');
                resolve();
            });
            
            req.write(postData);
            req.end();
        });
    }
    
    formatTradeOpen(trade) {
        const emoji = trade.direction === 'UP' ? '🟢' : '🔴';
        return `${emoji} <b>TRADE OPENED</b> ${emoji}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📊 <b>Asset:</b> ${trade.asset}\n` +
               `🎯 <b>Direction:</b> ${trade.direction}\n` +
               `💰 <b>Stake:</b> ${trade.stake.toFixed(2)} ${trade.currency}\n` +
               `⚡ <b>Multiplier:</b> ${trade.multiplier}x\n` +
               `📈 <b>Growth Rate:</b> ${(trade.growthRate * 100).toFixed(2)}%\n` +
               `🎲 <b>Confidence:</b> ${(trade.confidence * 100).toFixed(1)}%\n` +
               `🆔 <b>Contract ID:</b> <code>${trade.contractId}</code>\n` +
               `⏰ <b>Time:</b> ${new Date().toLocaleString()}\n` +
               `💵 <b>Balance:</b> ${trade.balance.toFixed(2)} ${trade.currency}\n` +
               `📉 <b>Daily P&L:</b> ${STATE.dailyPnL >= 0 ? '+' : ''}${STATE.dailyPnL.toFixed(2)} ${trade.currency}`;
    }
    
    formatTradeResult(trade) {
        const won = trade.profit > 0;
        const emoji = won ? '✅' : '❌';
        const resultText = won ? 'WON' : 'LOST';
        const profitEmoji = won ? '💚' : '❤️';
        
        return `${emoji} <b>TRADE ${resultText}</b> ${emoji}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📊 <b>Asset:</b> ${trade.asset}\n` +
               `🎯 <b>Direction:</b> ${trade.direction}\n` +
               `💰 <b>Stake:</b> ${trade.stake.toFixed(2)} ${trade.currency}\n` +
               `${profitEmoji} <b>Profit/Loss:</b> ${trade.profit >= 0 ? '+' : ''}${trade.profit.toFixed(2)} ${trade.currency}\n` +
               `💵 <b>Payout:</b> ${trade.payout.toFixed(2)} ${trade.currency}\n` +
               `⏱️ <b>Duration:</b> ${trade.duration} ticks\n` +
               `🆔 <b>Contract ID:</b> <code>${trade.contractId}</code>\n` +
               `⏰ <b>Closed:</b> ${new Date().toLocaleString()}\n` +
               `💵 <b>New Balance:</b> ${trade.newBalance.toFixed(2)} ${trade.currency}\n` +
               `📈 <b>Session P&L:</b> ${STATE.sessionPnL >= 0 ? '+' : ''}${STATE.sessionPnL.toFixed(2)} ${trade.currency}\n` +
               `📉 <b>Daily P&L:</b> ${STATE.dailyPnL >= 0 ? '+' : ''}${STATE.dailyPnL.toFixed(2)} ${trade.currency}\n` +
               `🔥 <b>Streak:</b> ${STATE.dailyStats.wins}W / ${STATE.dailyStats.losses}L`;
    }
    
    formatHourlySummary() {
        const winRate = STATE.hourlyStats.trades > 0 
            ? (STATE.hourlyStats.wins / STATE.hourlyStats.trades * 100).toFixed(1) 
            : '0.0';
        const roi = STATE.totalStake > 0 
            ? (STATE.hourlyStats.pnl / STATE.totalStake * 100).toFixed(2) 
            : '0.00';
        
        return `⏰ <b>HOURLY SUMMARY</b> ⏰\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `🕐 <b>Period:</b> ${new Date(STATE.hourlyStats.startTime).toLocaleTimeString()} - ${new Date().toLocaleTimeString()}\n` +
               `📊 <b>Total Trades:</b> ${STATE.hourlyStats.trades}\n` +
               `✅ <b>Wins:</b> ${STATE.hourlyStats.wins} | ❌ <b>Losses:</b> ${STATE.hourlyStats.losses}\n` +
               `🎯 <b>Win Rate:</b> ${winRate}%\n` +
               `💰 <b>P&L:</b> ${STATE.hourlyStats.pnl >= 0 ? '+' : ''}${STATE.hourlyStats.pnl.toFixed(2)} ${STATE.currency}\n` +
               `📈 <b>ROI:</b> ${roi}%\n` +
               `💵 <b>Current Balance:</b> ${STATE.currentBalance.toFixed(2)} ${STATE.currency}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📅 <b>Daily Total:</b> ${STATE.dailyStats.trades} trades | ${STATE.dailyStats.wins}W/${STATE.dailyStats.losses}L\n` +
               `💎 <b>Daily P&L:</b> ${STATE.dailyPnL >= 0 ? '+' : ''}${STATE.dailyPnL.toFixed(2)} ${STATE.currency}`;
    }
    
    formatDailySummary() {
        const winRate = STATE.dailyStats.trades > 0 
            ? (STATE.dailyStats.wins / STATE.dailyStats.trades * 100).toFixed(1) 
            : '0.0';
        
        // Asset breakdown
        let assetBreakdown = '';
        for (const [asset, stats] of Object.entries(STATE.dailyStats.assets)) {
            const assetWinRate = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(0) : '0';
            assetBreakdown += `  • ${asset}: ${stats.trades} trades (${stats.wins}W/${stats.losses}L) ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(2)}\n`;
        }
        
        if (!assetBreakdown) assetBreakdown = '  No trades today\n';
        
        return `📅 <b>END OF DAY SUMMARY</b> 📅\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📆 <b>Date:</b> ${STATE.dailyStats.date}\n` +
               `📊 <b>Total Trades:</b> ${STATE.dailyStats.trades}\n` +
               `✅ <b>Wins:</b> ${STATE.dailyStats.wins} | ❌ <b>Losses:</b> ${STATE.dailyStats.losses}\n` +
               `🎯 <b>Win Rate:</b> ${winRate}%\n` +
               `💰 <b>Total P&L:</b> ${STATE.dailyPnL >= 0 ? '+' : ''}${STATE.dailyPnL.toFixed(2)} ${STATE.currency}\n` +
               `📈 <b>ROI:</b> ${STATE.totalStake > 0 ? (STATE.dailyPnL / STATE.totalStake * 100).toFixed(2) : '0.00'}%\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `<b>📊 Asset Breakdown:</b>\n${assetBreakdown}` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `💵 <b>Starting Balance:</b> ${STATE.startingBalance.toFixed(2)} ${STATE.currency}\n` +
               `💵 <b>Ending Balance:</b> ${STATE.currentBalance.toFixed(2)} ${STATE.currency}\n` +
               `📈 <b>Net Change:</b> ${(STATE.currentBalance - STATE.startingBalance) >= 0 ? '+' : ''}${(STATE.currentBalance - STATE.startingBalance).toFixed(2)} ${STATE.currency}`;
    }
    
    formatStartup() {
        return `🤖 <b>DERIV ACCUMULATOR BOT STARTED</b> 🤖\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `💰 <b>Stake:</b> ${CONFIG.STAKE} ${STATE.currency}\n` +
               `⚡ <b>Multiplier:</b> ${CONFIG.MULTIPLIER}x (Step: ${CONFIG.MULTIPLIER_STEP})\n` +
               `🛑 <b>Stop Loss:</b> ${CONFIG.STOP_LOSS} ${STATE.currency}\n` +
               `🎯 <b>Take Profit:</b> ${CONFIG.TAKE_PROFIT} ${STATE.currency}\n` +
               `📊 <b>Assets:</b> ${CONFIG.ASSETS.length} markets\n` +
               `   ${CONFIG.ASSETS.join(', ')}\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `⏰ <b>Started:</b> ${new Date().toLocaleString()}\n` +
               `🆔 <b>Bot ID:</b> <code>${Date.now()}</code>`;
    }
    
    formatStop(reason) {
        return `🛑 <b>BOT STOPPED</b> 🛑\n` +
               `━━━━━━━━━━━━━━━━━━\n` +
               `📝 <b>Reason:</b> ${reason}\n` +
               `📊 <b>Session Trades:</b> ${STATE.tradeHistory.length}\n` +
               `💰 <b>Session P&L:</b> ${STATE.sessionPnL >= 0 ? '+' : ''}${STATE.sessionPnL.toFixed(2)} ${STATE.currency}\n` +
               `💵 <b>Final Balance:</b> ${STATE.currentBalance.toFixed(2)} ${STATE.currency}\n` +
               `⏰ <b>Stopped:</b> ${new Date().toLocaleString()}`;
    }
}

const telegram = new TelegramNotifier(CONFIG.TELEGRAM_BOT_TOKEN, CONFIG.TELEGRAM_CHAT_ID);

// ============================================
// WEBSOCKET CONNECTION MANAGER
// ============================================
class DerivWebSocket {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.isAuthorized = false;
        this.reqId = 0;
        this.pendingRequests = new Map();
        this.subscriptions = new Map();
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.pingTimer = null;
    }
    
    connect() {
        if (STATE.isShuttingDown) return;
        
        console.log(`[WS] Connecting to ${CONFIG.WS_URL}...`);
        
        try {
            this.ws = new WebSocket(CONFIG.WS_URL, {
                handshakeTimeout: 10000,
                perMessageDeflate: false,
            });
            
            this.ws.on('open', () => this.onOpen());
            this.ws.on('message', (data) => this.onMessage(data));
            this.ws.on('close', (code, reason) => this.onClose(code, reason));
            this.ws.on('error', (err) => this.onError(err));
        } catch (err) {
            console.error('[WS] Connection error:', err.message);
            this.scheduleReconnect();
        }
    }
    
    onOpen() {
        console.log('[WS] Connected successfully');
        STATE.isConnected = true;
        this.reconnectAttempts = 0;
        
        // Start ping interval
        this.startPing();
        
        // Authorize
        if (CONFIG.DERIV_API_TOKEN) {
            this.authorize(CONFIG.DERIV_API_TOKEN);
        } else {
            console.error('[WS] No DERIV_API_TOKEN provided in environment');
        }
    }
    
    onMessage(data) {
        try {
            const msg = JSON.parse(data.toString());
            
            // Handle ping response
            if (msg.msg_type === 'ping') return;
            
            // Handle subscription updates
            if (msg.subscription) {
                this.handleSubscriptionUpdate(msg);
                return;
            }
            
            // Handle request responses
            if (msg.req_id !== undefined) {
                const handler = this.pendingRequests.get(msg.req_id);
                if (handler) {
                    clearTimeout(handler.timeout);
                    this.pendingRequests.delete(msg.req_id);
                    if (msg.error) {
                        handler.reject(msg.error);
                    } else {
                        handler.resolve(msg);
                    }
                }
            }
        } catch (err) {
            console.error('[WS] Message parse error:', err.message);
        }
    }
    
    onClose(code, reason) {
        console.log(`[WS] Disconnected. Code: ${code}, Reason: ${reason.toString() || 'none'}`);
        STATE.isConnected = false;
        STATE.isAuthorized = false;
        this.isConnected = false;
        this.isAuthorized = false;
        this.stopPing();
        
        if (!STATE.isShuttingDown) {
            this.scheduleReconnect();
        }
    }
    
    onError(err) {
        console.error('[WS] Error:', err.message);
        // The close event will be triggered after error
    }
    
    scheduleReconnect() {
        if (STATE.isShuttingDown) return;
        if (this.reconnectTimer) return;
        
        this.reconnectAttempts++;
        const delay = Math.min(
            CONFIG.RECONNECT_DELAY * Math.pow(2, Math.min(this.reconnectAttempts - 1, 6)),
            CONFIG.MAX_RECONNECT_DELAY
        );
        
        console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`);
        
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }
    
    startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.isConnected) {
                this.send({ ping: 1 });
            }
        }, CONFIG.PING_INTERVAL);
    }
    
    stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
    
    send(request) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('[WS] Cannot send: not connected');
            return null;
        }
        
        this.reqId++;
        request.req_id = this.reqId;
        
        try {
            this.ws.send(JSON.stringify(request));
        } catch (err) {
            console.error('[WS] Send error:', err.message);
            return null;
        }
        
        return this.reqId;
    }
    
    sendAsync(request, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const reqId = this.send(request);
            if (reqId === null) {
                reject(new Error('WebSocket not connected'));
                return;
            }
            
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                reject(new Error('Request timeout'));
            }, timeoutMs);
            
            this.pendingRequests.set(reqId, { resolve, reject, timeout });
        });
    }
    
    async authorize(token) {
        try {
            console.log('[WS] Authorizing...');
            const response = await this.sendAsync({ authorize: token });
            
            if (response.error) {
                console.error('[WS] Authorization error:', response.error.message);
                telegram.send(`❌ <b>AUTHORIZATION FAILED</b>\n${response.error.message}`);
                return;
            }
            
            STATE.isAuthorized = true;
            this.isAuthorized = true;
            STATE.currency = response.authorize.currency || 'USD';
            STATE.currentBalance = parseFloat(response.authorize.balance);
            STATE.startingBalance = STATE.currentBalance;
            
            console.log(`[WS] Authorized as ${response.authorize.email}`);
            console.log(`[WS] Balance: ${STATE.currentBalance} ${STATE.currency}`);
            
            // Subscribe to balance updates
            this.send({ balance: 1, subscribe: 1 });
            this.send({ transaction: 1, subscribe: 1 });
            
            // Initialize bot
            await onAuthorized();
        } catch (err) {
            console.error('[WS] Authorization failed:', err.message);
        }
    }
    
    async handleSubscriptionUpdate(msg) {
        // Balance updates
        if (msg.msg_type === 'balance') {
            STATE.currentBalance = parseFloat(msg.balance.balance);
            return;
        }
        
        // Transaction updates
        if (msg.msg_type === 'transaction') {
            const transaction = msg.transaction;
            if (transaction.action === 'buy' || transaction.action === 'sell') {
                console.log(`[WS] Transaction: ${transaction.action} - ${transaction.amount} ${transaction.currency}`);
            }
            return;
        }
        
        // Tick updates
        if (msg.msg_type === 'tick') {
            const tick = msg.tick;
            if (!STATE.tickData.has(tick.symbol)) {
                STATE.tickData.set(tick.symbol, []);
            }
            const ticks = STATE.tickData.get(tick.symbol);
            ticks.push(parseFloat(tick.quote));
            if (ticks.length > CONFIG.TICK_ANALYSIS_WINDOW) {
                ticks.shift();
            }
            
            // Analyze tick and possibly trigger trade
            analyzeAsset(tick.symbol, ticks);
            return;
        }
    }
}

const wsManager = new DerivWebSocket();

// ============================================
// TRADING STRATEGY & ANALYSIS
// ============================================
function analyzeAsset(asset, ticks) {
    if (ticks.length < 20) return;
    
    // Calculate indicators
    const analysis = {
        asset,
        smaShort: calculateSMA(ticks, 5),
        smaLong: calculateSMA(ticks, 20),
        volatility: calculateVolatility(ticks, 20),
        momentum: calculateMomentum(ticks, 10),
        mean: calculateMean(ticks, 30),
        stdDev: calculateStdDev(ticks, 30),
    };
    
    // Determine signal
    let upScore = 0;
    let downScore = 0;
    
    // SMA crossover
    if (analysis.smaShort > analysis.smaLong) upScore += 2;
    else downScore += 2;
    
    // Momentum
    if (analysis.momentum > 0) upScore += 1.5;
    else if (analysis.momentum < 0) downScore += 1.5;
    
    // Mean reversion (price relative to mean)
    const lastPrice = ticks[ticks.length - 1];
    const zScore = (lastPrice - analysis.mean) / analysis.stdDev;
    
    if (zScore < -0.5) upScore += 1;  // Below mean -> expect reversion up
    else if (zScore > 0.5) downScore += 1;
    
    // Trend strength
    if (Math.abs(zScore) > 1.5) {
        // Strong trend - mean reversion less reliable for accumulator
        // Reduce confidence
        upScore *= 0.7;
        downScore *= 0.7;
    }
    
    const totalScore = upScore + downScore;
    const direction = upScore > downScore ? 'UP' : 'DOWN';
    const confidence = Math.max(upScore, downScore) / totalScore;
    
    STATE.assetSignals.set(asset, {
        direction,
        confidence,
        timestamp: Date.now(),
        analysis,
    });
}

function calculateSMA(ticks, period) {
    if (ticks.length < period) return 0;
    const slice = ticks.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateVolatility(ticks, period) {
    if (ticks.length < period) return 0;
    const slice = ticks.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    return Math.sqrt(variance);
}

function calculateMomentum(ticks, period) {
    if (ticks.length < period + 1) return 0;
    const current = ticks[ticks.length - 1];
    const past = ticks[ticks.length - 1 - period];
    return ((current - past) / past) * 100;
}

function calculateMean(ticks, period) {
    return calculateSMA(ticks, period);
}

function calculateStdDev(ticks, period) {
    if (ticks.length < period) return 0;
    const slice = ticks.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    return Math.sqrt(variance);
}

// ============================================
// TRADING EXECUTION
// ============================================
async function subscribeToAssets() {
    console.log(`[Trading] Subscribing to ${CONFIG.ASSETS.length} assets...`);
    
    for (const asset of CONFIG.ASSETS) {
        try {
            // Subscribe to ticks
            wsManager.send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: CONFIG.TICK_ANALYSIS_WINDOW,
                end: 'latest',
                start: 0,
                style: 'ticks',
                subscribe: 1,
            });
            
            STATE.subscribedAssets.add(asset);
            STATE.tickData.set(asset, []);
        } catch (err) {
            console.error(`[Trading] Failed to subscribe to ${asset}: ${err.message}`);
        }
    }
}

function canTrade() {
    // Check rate limiting
    const now = Date.now();
    if (now - STATE.hourStartTime >= CONFIG.HOURLY_SUMMARY_INTERVAL) {
        STATE.tradesThisHour = 0;
        STATE.hourStartTime = now;
    }
    
    if (STATE.tradesThisHour >= CONFIG.MAX_TRADES_PER_HOUR) {
        return { ok: false, reason: 'Hourly trade limit reached' };
    }
    
    // Check active trades limit
    if (STATE.activeTrades.size >= CONFIG.ASSETS.length) {
        return { ok: false, reason: 'Maximum active trades reached' };
    }
    
    // Check P&L limits
    if (STATE.dailyPnL <= -CONFIG.STOP_LOSS) {
        return { ok: false, reason: `Stop loss reached: ${STATE.dailyPnL.toFixed(2)}` };
    }
    
    if (STATE.dailyPnL >= CONFIG.TAKE_PROFIT) {
        return { ok: false, reason: `Take profit reached: ${STATE.dailyPnL.toFixed(2)}` };
    }
    
    // Check balance
    if (STATE.currentBalance < CONFIG.STAKE) {
        return { ok: false, reason: 'Insufficient balance' };
    }
    
    return { ok: true };
}

async function executeTrade(asset, signal) {
    if (!signal || signal.confidence < CONFIG.MIN_TICK_CONFIDENCE) return;
    
    // Check if we already have an active trade on this asset
    for (const [contractId, trade] of STATE.activeTrades) {
        if (trade.asset === asset) return;
    }
    
    const tradeCheck = canTrade();
    if (!tradeCheck.ok) {
        if (STATE.activeTrades.size === 0) {
            // Only log occasionally
            console.log(`[Trading] Cannot trade: ${tradeCheck.reason}`);
        }
        return;
    }
    
    try {
        // Get proposal for accumulator
        const proposal = await wsManager.sendAsync({
            proposal: 1,
            amount: CONFIG.STAKE.toString(),
            basis: 'stake',
            contract_type: 'ACCU',
            currency: STATE.currency,
            symbol: asset,
            growth_rate: 0.05, // 5% growth rate (can be adjusted)
        });
        
        if (proposal.error) {
            console.error(`[Trading] Proposal error for ${asset}: ${proposal.error.message}`);
            return;
        }
        
        if (!proposal.proposal || !proposal.proposal.id) {
            console.error(`[Trading] Invalid proposal for ${asset}`);
            return;
        }
        
        // Buy the contract
        const buyResponse = await wsManager.sendAsync({
            buy: proposal.proposal.id,
            price: CONFIG.STAKE.toString(),
        });
        
        if (buyResponse.error) {
            console.error(`[Trading] Buy error for ${asset}: ${buyResponse.error.message}`);
            return;
        }
        
        const contractId = buyResponse.buy.contract_id;
        const buyPrice = parseFloat(buyResponse.buy.buy_price);
        const payout = parseFloat(buyResponse.buy.payout);
        
        // Record trade
        const trade = {
            contractId,
            asset,
            direction: signal.direction,
            stake: buyPrice,
            multiplier: CONFIG.MULTIPLIER,
            growthRate: 0.05,
            confidence: signal.confidence,
            currency: STATE.currency,
            balance: STATE.currentBalance,
            buyPrice,
            payout,
            openTime: Date.now(),
            status: 'open',
        };
        
        STATE.activeTrades.set(contractId, trade);
        STATE.tradesThisHour++;
        STATE.totalStake += buyPrice;
        
        // Update daily stats
        STATE.dailyStats.trades++;
        if (!STATE.dailyStats.assets[asset]) {
            STATE.dailyStats.assets[asset] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }
        STATE.dailyStats.assets[asset].trades++;
        
        // Subscribe to contract updates
        wsManager.send({
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
        });
        
        console.log(`[Trading] ✅ Opened ${signal.direction} trade on ${asset} | Contract: ${contractId} | Stake: ${buyPrice} ${STATE.currency}`);
        
        // Send Telegram notification
        telegram.send(telegram.formatTradeOpen(trade));
        
    } catch (err) {
        console.error(`[Trading] Execute trade error for ${asset}:`, err.message);
    }
}

// ============================================
// TRADE MONITORING
// ============================================
function monitorContractUpdates() {
    // This is handled via the subscription handler
}

function handleContractUpdate(msg) {
    const contract = msg.proposal_open_contract;
    if (!contract) return;
    
    const contractId = contract.contract_id;
    const trade = STATE.activeTrades.get(contractId);
    if (!trade) return;
    
    // Update multiplier if available
    if (contract.multiplier !== undefined) {
        trade.currentMultiplier = parseFloat(contract.multiplier);
    }
    
    // Check if contract is sold or completed
    if (contract.is_sold === 1 || contract.status === 'lost' || contract.status === 'won') {
        const profit = parseFloat(contract.profit || 0);
        const payout = parseFloat(contract.payout || 0);
        const isWin = contract.status === 'won' || (profit > 0 && contract.status !== 'lost');
        
        // Update trade
        trade.profit = profit;
        trade.payout = payout;
        trade.status = contract.status;
        trade.isWin = isWin;
        trade.closeTime = Date.now();
        trade.duration = Math.floor((trade.closeTime - trade.openTime) / 1000);
        trade.newBalance = STATE.currentBalance;
        
        // Update statistics
        STATE.activeTrades.delete(contractId);
        STATE.totalPayout += payout;
        STATE.sessionPnL += profit;
        STATE.dailyPnL += profit;
        STATE.hourlyStats.pnl += profit;
        STATE.hourlyStats.trades++;
        
        if (isWin) {
            STATE.dailyStats.wins++;
            STATE.hourlyStats.wins++;
            STATE.dailyStats.assets[trade.asset].wins++;
        } else {
            STATE.dailyStats.losses++;
            STATE.hourlyStats.losses++;
            STATE.dailyStats.assets[trade.asset].losses++;
        }
        STATE.dailyStats.assets[trade.asset].pnl += profit;
        
        // Add to history
        STATE.tradeHistory.push({ ...trade });
        
        // Send notification
        telegram.send(telegram.formatTradeResult(trade));
        
        // Log
        const emoji = isWin ? '✅' : '❌';
        console.log(`[Trading] ${emoji} Closed ${trade.direction} on ${trade.asset} | Profit: ${profit.toFixed(2)} ${STATE.currency} | Daily P&L: ${STATE.dailyPnL.toFixed(2)} ${STATE.currency}`);
        
        // Check limits after trade
        if (STATE.dailyPnL <= -CONFIG.STOP_LOSS) {
            console.log(`[Trading] 🛑 STOP LOSS REACHED: ${STATE.dailyPnL.toFixed(2)}`);
            telegram.send(`🛑 <b>STOP LOSS REACHED</b>\nDaily P&L: ${STATE.dailyPnL.toFixed(2)} ${STATE.currency}\nBot will stop trading.`);
            stopBot('Stop loss reached');
        } else if (STATE.dailyPnL >= CONFIG.TAKE_PROFIT) {
            console.log(`[Trading] 🎯 TAKE PROFIT REACHED: ${STATE.dailyPnL.toFixed(2)}`);
            telegram.send(`🎯 <b>TAKE PROFIT REACHED</b>\nDaily P&L: ${STATE.dailyPnL.toFixed(2)} ${STATE.currency}\nBot will stop trading.`);
            stopBot('Take profit reached');
        }
    }
}

// Add contract update handler to wsManager
const originalHandler = wsManager.handleSubscriptionUpdate.bind(wsManager);
wsManager.handleSubscriptionUpdate = function(msg) {
    if (msg.msg_type === 'proposal_open_contract') {
        handleContractUpdate(msg);
        return;
    }
    originalHandler(msg);
};

// ============================================
// SIGNAL PROCESSOR
// ============================================
let lastSignalProcess = 0;
function processSignals() {
    const now = Date.now();
    if (now - lastSignalProcess < 5000) return; // Process every 5 seconds
    lastSignalProcess = now;
    
    // Process all asset signals
    for (const [asset, signal] of STATE.assetSignals) {
        if (now - signal.timestamp > 10000) continue; // Stale signal
        executeTrade(asset, signal);
    }
}

// ============================================
// TIMERS & SUMMARIES
// ============================================
let hourlyTimer = null;
let dailyTimer = null;
let signalTimer = null;
let statsTimer = null;

function startTimers() {
    // Hourly summary
    hourlyTimer = setInterval(() => {
        console.log('[Timer] Sending hourly summary');
        telegram.send(telegram.formatHourlySummary());
        
        // Reset hourly stats
        STATE.hourlyStats = {
            trades: 0,
            wins: 0,
            losses: 0,
            pnl: 0,
            startTime: Date.now(),
        };
        STATE.hourStartTime = Date.now();
        STATE.tradesThisHour = 0;
    }, CONFIG.HOURLY_SUMMARY_INTERVAL);
    
    // Daily summary (check every hour for day change)
    dailyTimer = setInterval(() => {
        const today = new Date().toDateString();
        if (today !== STATE.dailyStats.date) {
            console.log('[Timer] Sending daily summary');
            telegram.send(telegram.formatDailySummary());
            
            // Reset daily stats
            STATE.dailyStats = {
                date: today,
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0,
                assets: {},
            };
            STATE.dailyPnL = 0;
        }
    }, 60 * 60 * 1000); // Check every hour
    
    // Signal processor
    signalTimer = setInterval(processSignals, 5000);
    
    // Stats logger
    statsTimer = setInterval(() => {
        if (STATE.activeTrades.size > 0 || STATE.tradeHistory.length > 0) {
            console.log(`[Stats] Active: ${STATE.activeTrades.size} | Daily Trades: ${STATE.dailyStats.trades} | Daily P&L: ${STATE.dailyPnL.toFixed(2)} ${STATE.currency} | Balance: ${STATE.currentBalance.toFixed(2)} ${STATE.currency}`);
        }
    }, 60000);
}

function stopTimers() {
    if (hourlyTimer) clearInterval(hourlyTimer);
    if (dailyTimer) clearInterval(dailyTimer);
    if (signalTimer) clearInterval(signalTimer);
    if (statsTimer) clearInterval(statsTimer);
}

// ============================================
// BOT LIFECYCLE
// ============================================
async function onAuthorized() {
    console.log('[Bot] Authorized. Starting trading operations...');
    
    // Send startup notification
    await telegram.send(telegram.formatStartup());
    
    // Subscribe to assets
    await subscribeToAssets();
    
    // Start timers
    startTimers();
    
    console.log('[Bot] ✅ Bot is now running. Press Ctrl+C to stop.');
}

async function stopBot(reason = 'User requested shutdown') {
    if (STATE.isShuttingDown) return;
    STATE.isShuttingDown = true;
    
    console.log(`[Bot] Stopping... Reason: ${reason}`);
    
    // Stop timers
    stopTimers();
    
    // Send stop notification with final summary
    await telegram.send(telegram.formatStop(reason));
    
    // Close all active trades if possible (optional - comment out if you want to let them run)
    for (const [contractId, trade] of STATE.activeTrades) {
        try {
            await wsManager.sendAsync({ sell: contractId, price: 0 });
            console.log(`[Bot] Sold contract ${contractId}`);
        } catch (err) {
            console.error(`[Bot] Failed to sell contract ${contractId}: ${err.message}`);
        }
    }
    
    // Close websocket
    if (wsManager.ws) {
        wsManager.ws.close();
    }
    
    // Exit
    setTimeout(() => process.exit(0), 3000);
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', () => stopBot('SIGINT received'));
process.on('SIGTERM', () => stopBot('SIGTERM received'));
process.on('uncaughtException', (err) => {
    console.error('[Bot] Uncaught exception:', err);
    // Don't stop bot for minor errors
});
process.on('unhandledRejection', (err) => {
    console.error('[Bot] Unhandled rejection:', err);
});

// ============================================
// START BOT
// ============================================
function main() {
    console.log('========================================');
    console.log('  Deriv Accumulator Trading Bot');
    console.log('========================================');
    
    // Validate configuration
    if (!CONFIG.DERIV_API_TOKEN) {
        console.error('❌ ERROR: DERIV_API_TOKEN is required in .env file');
        console.log('Please create a .env file with:');
        console.log('DERIV_API_TOKEN=your_token_here');
        console.log('TELEGRAM_BOT_TOKEN=your_telegram_bot_token');
        console.log('TELEGRAM_CHAT_ID=your_telegram_chat_id');
        process.exit(1);
    }
    
    if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
        console.warn('⚠️  WARNING: Telegram notifications disabled (no token/chat ID)');
    }
    
    console.log(`[Config] Stake: ${CONFIG.STAKE} ${STATE.currency}`);
    console.log(`[Config] Multiplier: ${CONFIG.MULTIPLIER}x`);
    console.log(`[Config] Stop Loss: ${CONFIG.STOP_LOSS}`);
    console.log(`[Config] Take Profit: ${CONFIG.TAKE_PROFIT}`);
    console.log(`[Config] Assets: ${CONFIG.ASSETS.length}`);
    console.log('========================================');
    
    // Connect to Deriv
    wsManager.connect();
}

// Run
main();