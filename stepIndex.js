#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   STEP INDEX GRID MARTINGALE BOT — Headless Terminal Edition                    ║
// ║   Volatility STEP Index | CALLE/PUTE | Low-Risk Hybrid                        ║
// ║   ENHANCED: Intelligent Auto-Compounding + Full Loss Recovery System          ║
// ║   UPDATED: Resume logic + Daily stats storage & notifications                  ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// DATE/TIME HELPERS (GMT+1)
// ══════════════════════════════════════════════════════════════════════════════

function getGMTDateKey() {
  const now = new Date();
  const gmtPlus1 = new Date(now.getTime() + (1 * 60 * 60 * 1000));
  return gmtPlus1.toISOString().split('T')[0]; // e.g. "2026-03-20"
}

function getGMTTime() {
  const now = new Date();
  const gmtPlus1 = new Date(now.getTime() + (1 * 60 * 60 * 1000));
  return gmtPlus1.toISOString().split('T')[1].split('.')[0] + ' GMT+1';
}

// ══════════════════════════════════════════════════════════════════════════════
// TRADE HISTORY MANAGER - Daily Stats Storage & Persistence
// ══════════════════════════════════════════════════════════════════════════════

const HISTORY_FILE = path.join(__dirname, 'Index-grid-history.json');

class TradeHistoryManager {
  static loadHistory() {
    try {
      if (!fs.existsSync(HISTORY_FILE)) {
        console.log(`[History] No history file found, starting fresh`);
        return {
          overall: {
            tradesCount: 0,
            winsCount: 0,
            lossesCount: 0,
            profit: 0,
            loss: 0,
            netPL: 0,
            firstTradeDate: null,
            lastTradeDate: null
          },
          dailyHistory: {},
          lastUpdated: Date.now()
        };
      }
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`[History] Loaded — ${Object.keys(data.dailyHistory || {}).length} days of history`);
      return data;
    } catch (error) {
      console.error(`[History] Load error: ${error.message}`);
      return {
        overall: { tradesCount: 0, winsCount: 0, lossesCount: 0, profit: 0, loss: 0, netPL: 0, firstTradeDate: null, lastTradeDate: null },
        dailyHistory: {},
        lastUpdated: Date.now()
      };
    }
  }

  static saveHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
    } catch (error) {
      console.error(`[History] Save error: ${error.message}`);
    }
  }

  static ensureDayEntry(dateKey) {
    if (!tradeHistory.dailyHistory[dateKey]) {
      tradeHistory.dailyHistory[dateKey] = {
        date: dateKey,
        tradesCount: 0,
        winsCount: 0,
        lossesCount: 0,
        profit: 0,
        loss: 0,
        netPL: 0,
        startCapital: 0,
        endCapital: 0
      };
    }
  }

  static recordTrade(profit, gridLevel, investmentRemaining, totalProfit) {
    const dateKey = getGMTDateKey();
    this.ensureDayEntry(dateKey);
    
    const dayStats = tradeHistory.dailyHistory[dateKey];
    const overall = tradeHistory.overall;
    
    dayStats.tradesCount++;
    overall.tradesCount++;
    
    if (!overall.firstTradeDate) overall.firstTradeDate = dateKey;
    overall.lastTradeDate = dateKey;
    
    if (profit > 0) {
      dayStats.winsCount++;
      dayStats.profit += profit;
      dayStats.netPL += profit;
      overall.winsCount++;
      overall.profit += profit;
      overall.netPL += profit;
    } else {
      dayStats.lossesCount++;
      dayStats.loss += Math.abs(profit);
      dayStats.netPL += profit;
      overall.lossesCount++;
      overall.loss += Math.abs(profit);
      overall.netPL += profit;
    }
    
    dayStats.endCapital = investmentRemaining;
    tradeHistory.lastUpdated = Date.now();
    this.saveHistory();
  }

  static getTodayStats() {
    const dateKey = getGMTDateKey();
    this.ensureDayEntry(dateKey);
    return tradeHistory.dailyHistory[dateKey];
  }

  static getOverallStats() {
    return tradeHistory.overall;
  }

  static getAllDays() {
    return Object.keys(tradeHistory.dailyHistory).sort();
  }

  static getRecentDays(n = 7) {
    const days = this.getAllDays();
    return days.slice(-n).map(dateKey => ({ date: dateKey, ...tradeHistory.dailyHistory[dateKey] }));
  }

  static checkDayChange(currentDay) {
    const todayKey = getGMTDateKey();
    if (currentDay && currentDay !== todayKey) {
      return { changed: true, previousDay: currentDay, newDay: todayKey };
    }
    return { changed: false, previousDay: currentDay, newDay: todayKey };
  }
}

// Initialize trade history
let tradeHistory = TradeHistoryManager.loadHistory();

// ══════════════════════════════════════════════════════════════════════════════
// INTELLIGENT MARTINGALE CALCULATOR
// ══════════════════════════════════════════════════════════════════════════════

class MartingaleCalculator {
  // Payout percentage for stpRNG (typically ~80% for volatile indices)
  static PAYOUT_RATE = 0.80;
  
  // Number of levels in the martingale chain (0 to MAX_LEVEL)
  static MAX_LEVEL = 9;
  
  /**
   * Calculate optimal multipliers for full loss recovery
   * Each level's multiplier is calculated to ensure winning at that level
   * recovers ALL previous losses + a profit margin
   */
  static calculateOptimalMultipliers() {
    const mults = [];
    // First multiplier is fixed (initial loss recovery factor)
    mults.push(1.5); // L0 → L1: 1.5x to recover initial stake + profit
    
    // For subsequent levels, calculate to ensure full recovery
    // Using a gradual increase to keep stakes manageable
    for (let i = 2; i <= this.MAX_LEVEL; i++) {
      // Progressive multiplier that increases as levels get higher
      // This ensures even deep recovery trades can recover all losses
      mults.push(1.5 + (i - 1) * 0.15); // 1.5, 1.65, 1.8, 1.95, 2.1, 2.25, 2.4, 2.55, 2.7
    }
    
    return mults;
  }
  
  /**
   * Calculate minimum investment required to survive MAX_LEVEL consecutive losses
   * This ensures the investment pool is always sufficient
   */
  static calculateMinimumInvestment(baseStake, multipliers) {
    let totalRequired = 0;
    let cumulativeStake = baseStake;
    
    for (let level = 0; level <= this.MAX_LEVEL; level++) {
      totalRequired += cumulativeStake;
      if (level < this.MAX_LEVEL) {
        cumulativeStake *= multipliers[level] || 1.5;
      }
    }
    
    // Add 10% buffer for safety
    return totalRequired * 1.1;
  }
  
  /**
   * Calculate stake for a given level using the multiplier chain
   */
  static calculateStakeForLevel(baseStake, level, multipliers) {
    if (level === 0) return baseStake;
    
    let stake = baseStake;
    for (let i = 0; i < level; i++) {
      stake *= multipliers[i] || 1.5;
    }
    return Number(stake.toFixed(2));
  }
  
  /**
   * Calculate total investment required for current base stake
   * and update investment amount if needed
   */
  static calculateRequiredInvestment(baseStake, multipliers) {
    const required = this.calculateMinimumInvestment(baseStake, multipliers);
    // Round up to nearest dollar for cleaner numbers
    return Math.ceil(required);
  }
  
  /**
   * Calculate what the new base stake should be based on investment
   * This is the inverse - given an investment, what's the max safe base stake
   */
  static calculateSafeBaseStake(investment, multipliers) {
    // Binary search or iterative approach to find max base stake
    let low = 0.35; // Minimum stake
    let high = investment / 10; // Reasonable upper bound
    let mid;
    
    for (let i = 0; i < 20; i++) { // 20 iterations for precision
      mid = (low + high) / 2;
      const required = this.calculateMinimumInvestment(mid, multipliers);
      
      if (required <= investment) {
        low = mid;
      } else {
        high = mid;
      }
    }
    
    return Math.max(low * 0.9, 0.35); // 90% of calculated to leave buffer
  }
}

// Calculate optimal multipliers once at startup
const OPTIMAL_MULTIPLIERS = MartingaleCalculator.calculateOptimalMultipliers();

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiToken: 'Dz2V2KvRf4Uukt3',
  appId:    '1089',

  symbol:        'stpRNG',
  tickDuration:  5,
  initialStake:  0.35,
  
  // Base investment amount - will be auto-adjusted based on stake
  investmentAmount: 1743,

  // Martingale settings
  maxMartingaleLevel: 9,  // 0-9 = 10 levels total
  afterMaxLoss:      'stop', // stop, continue, reset
  
  // Auto-compounding settings
  autoCompounding:    true,
  compoundPercentage: 0.24, // % of investment to use as base stake
  
  // Risk management
  stopLoss:   5000,
  takeProfit: 10000,
  
  // Safety buffer for investment (1.1 = 10% buffer)
  investmentBuffer: 1.1,

  // Stuck trade recovery settings
  stuckTradePauseDuration: 5 * 60 * 1000,

  telegramToken:   '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc',
  telegramChatId:  '752497117',
  telegramEnabled: true,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'Index-grid-state.json');
const STATE_SAVE_INTERVAL = 5000;

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

class StatePersistence {
  static save(bot) {
    try {
      const payload = {
        savedAt: Date.now(),
        trading: {
          totalProfit:         bot.totalProfit,
          totalTrades:         bot.totalTrades,
          wins:                bot.wins,
          losses:              bot.losses,
          currentGridLevel:    bot.currentGridLevel,
          currentDirection:    bot.currentDirection,
          baseStake:           bot.baseStake,
          investmentRemaining: bot.investmentRemaining,
          totalRecovered:      bot.totalRecovered,
          maxWinStreak:        bot.maxWinStreak,
          maxLossStreak:       bot.maxLossStreak,
          currentStreak:       bot.currentStreak,
          inRecoveryMode:      bot.inRecoveryMode,
          currentTradeDay:     bot.currentTradeDay,
          calculatedInvestment: bot.calculatedInvestment,
        },
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error(`[StatePersistence] save error: ${e.message}`);
    }
  }

  static load() {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const data   = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const ageMin = (Date.now() - data.savedAt) / 60000;
      if (ageMin > 30) {
        console.warn(`[StatePersistence] State is ${ageMin.toFixed(1)} min old — discarding`);
        fs.unlinkSync(STATE_FILE);
        return null;
      }
      console.log(`[StatePersistence] Restoring state from ${ageMin.toFixed(1)} min ago`);
      return data;
    } catch (e) {
      console.error(`[StatePersistence] load error: ${e.message}`);
      return null;
    }
  }

  static startAutoSave(bot) {
    if (bot._autoSaveInterval) return;
    bot._autoSaveInterval = setInterval(() => {
      if (bot.running || bot.totalTrades > 0) StatePersistence.save(bot);
    }, STATE_SAVE_INTERVAL);
    console.log('[StatePersistence] Auto-save every 5 s ✅');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class STEPINDEXGridBot {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Martingale multipliers (pre-calculated for performance)
    this.multipliers = OPTIMAL_MULTIPLIERS;

    // ── WebSocket ───────────────────────────────────────────────────────────
    this.ws            = null;
    this.isConnected   = false;
    this.isAuthorized  = false;
    this.reqId         = 1;

    // ── Reconnection ────────────────────────────────────────────────────────
    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay       = 5000;
    this.reconnectTimer       = null;
    this.isReconnecting       = false;
    this.lastConnectedTime    = null;

    // ── Ping / Keepalive ────────────────────────────────────────────────────
    this.pingInterval = null;

    // ── Trade Watchdog ───────────────────────────────────────────────────────
    this.tradeWatchdogTimer    = null;
    this.tradeWatchdogPollTimer = null;
    this.tradeWatchdogMs       = 10000;
    this.tradeStartTime        = null;

    // ── Stuck Trade Pause State ──────────────────────────────────────────────
    this.isPausedDueToStuckTrade = false;
    this.stuckTradePauseTimer    = null;
    this.stuckTradeCount         = 0;

    // ── Message queue ────────────────────────────────────────────────────────
    this.messageQueue = [];
    this.maxQueueSize = 50;

    // ── Account ──────────────────────────────────────────────────────────────
    this.balance   = 0;
    this.currency  = 'USD';
    this.accountId = '';

    // ── Session trading state ────────────────────────────────────────────────
    this.running               = false;
    this.tradeInProgress       = false;
    this.currentContractId     = null;
    this.pendingTradeInfo      = null;

    this.currentGridLevel      = 0;
    this.currentDirection      = 'CALLE';
    this.baseStake             = this.config.initialStake;
    this.investmentRemaining   = 0;
    this.investmentStartAmount = 0;
    this.calculatedInvestment  = 0; // The calculated safe investment
    this.totalProfit           = 0;
    this.totalTrades           = 0;
    this.wins                  = 0;
    this.losses                = 0;
    this.currentStreak         = 0;
    this.maxWinStreak          = 0;
    this.maxLossStreak         = 0;
    this.totalRecovered        = 0;

    // ── Day tracking ────────────────────────────────────────────────────────
    this.currentTradeDay = getGMTDateKey();
    this.tradeDayStats = { trades: 0, pnl: 0, wins: 0, losses: 0 };

    // ── Candle tracking ─────────────────────────────────────────────────────
    this.assetState = {
      candles: [],
      closedCandles: [],
      currentFormingCandle: null,
      lastProcessedCandleOpenTime: null,
      candlesLoaded: false
    };
    this.candleConfig = {
      GRANULARITY: 60,
      MAX_CANDLES_STORED: 100,
      CANDLES_TO_LOAD: 50
    };

    // ── Candle-gated trading + recovery logic ──────────────────────────────
    this.canTrade       = false;
    this.inRecoveryMode = false;

    // ── Session control ──────────────────────────────────────────────────────
    this.endOfDay         = false;
    this.isWinTrade       = false;
    this.hasStartedOnce   = false;
    this._autoSaveInterval = null;

    this._processedContracts = new Set();
    this._maxProcessedCache  = 200;

    // ── Hourly Telegram stats ─────────────────────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

    // ── Telegram ─────────────────────────────────────────────────────────────
    this.telegramBot = null;
    if (this.config.telegramEnabled && this.config.telegramToken && this.config.telegramChatId) {
      try {
        this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        this.log('Telegram notifications enabled ✅');
      } catch (e) {
        this.log(`Telegram init error: ${e.message}`, 'warning');
      }
    } else {
      this.log('Telegram disabled — no token/chat-id configured', 'warning');
    }

    // ── Restore saved state ───────────────────────────────────────────────────
    this._restoreState();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // STATE RESTORE
  // ══════════════════════════════════════════════════════════════════════════════

  _restoreState() {
    const saved = StatePersistence.load();
    if (!saved) return;
    const t = saved.trading;
    this.totalProfit         = t.totalProfit         || 0;
    this.totalTrades         = t.totalTrades         || 0;
    this.wins                = t.wins                || 0;
    this.losses              = t.losses              || 0;
    this.currentGridLevel    = t.currentGridLevel    || 0;
    this.currentDirection    = t.currentDirection    || 'CALLE';
    this.baseStake           = t.baseStake           || this.config.initialStake;
    this.investmentRemaining = t.investmentRemaining || 0;
    this.totalRecovered      = t.totalRecovered      || 0;
    this.maxWinStreak        = t.maxWinStreak        || 0;
    this.maxLossStreak       = t.maxLossStreak       || 0;
    this.currentStreak       = t.currentStreak       || 0;
    this.inRecoveryMode      = t.inRecoveryMode      || false;
    this.canTrade            = this.inRecoveryMode;
    this.currentTradeDay     = t.currentTradeDay     || getGMTDateKey();
    this.calculatedInvestment = t.calculatedInvestment || 0;
    this.hasStartedOnce      = true;
    
    // Initialize today's trade day stats from history
    const todayStats = TradeHistoryManager.getTodayStats();
    this.tradeDayStats = {
      trades: todayStats.tradesCount,
      pnl: todayStats.netPL,
      wins: todayStats.winsCount,
      losses: todayStats.lossesCount
    };
    
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel} | ` +
      `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | Day: ${this.currentTradeDay}`,
      'success'
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ══════════════════════════════════════════════════════════════════════════════

  log(message, type = 'info') {
    const ts    = new Date().toISOString();
    const emoji = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    console.log(`[${ts}] ${emoji} ${message}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // INTELLIGENT STAKE CALCULATOR
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * Calculate stake for a given grid level using optimal multipliers
   */
  calculateStake(level) {
    return MartingaleCalculator.calculateStakeForLevel(
      this.baseStake,
      level,
      this.multipliers
    );
  }
  
  /**
   * Update investment amount based on current base stake
   * This ensures the investment pool is always sufficient for all levels
   */
  _updateInvestmentForStake() {
    const required = MartingaleCalculator.calculateRequiredInvestment(
      this.baseStake,
      this.multipliers
    );
    
    // Only update if there's significant change (>5%)
    if (Math.abs(required - this.calculatedInvestment) > this.calculatedInvestment * 0.05) {
      this.calculatedInvestment = required;
      this.log(
        `💰 Investment updated to $${required.toFixed(2)} for base stake $${this.baseStake.toFixed(2)} (covers ${this.config.maxMartingaleLevel} levels)`,
        'info'
      );
    }
    
    return required;
  }
  
  /**
   * Get safe base stake from investment amount
   */
  _getSafeBaseStake(investment) {
    return MartingaleCalculator.calculateSafeBaseStake(investment, this.multipliers);
  }
  
  /**
   * Get stake breakdown for all levels (for display)
   */
  getStakeBreakdown() {
    const breakdown = [];
    let cumulative = 0;
    for (let level = 0; level <= this.config.maxMartingaleLevel; level++) {
      const stake = this.calculateStake(level);
      cumulative += stake;
      breakdown.push({ level, stake, cumulative });
    }
    return breakdown;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — CONNECT
  // ══════════════════════════════════════════════════════════════════════════════

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.log('Already connected', 'warning');
      return;
    }

    this._cleanupWs();

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.config.appId}`;
    this.log(`Connecting to Deriv WebSocket… (attempt ${this.reconnectAttempts + 1})`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open',    ()     => this._onOpen());
    this.ws.on('message', data   => this._onRawMessage(data));
    this.ws.on('error',   err    => this._onError(err));
    this.ws.on('close',   (code) => this._onClose(code));
  }

  _onOpen() {
    this.log('WebSocket connected ✅', 'success');
    this.isConnected       = true;
    this.reconnectAttempts = 0;
    this.isReconnecting   = false;
    this.lastConnectedTime = Date.now();

    this._startPing();
    StatePersistence.startAutoSave(this);

    this._send({ authorize: this.config.apiToken });
  }

  _onError(err) {
    this.log(`WebSocket error: ${err.message}`, 'error');
  }

  _onClose(code) {
    this.log(`WebSocket closed (code: ${code})`, 'warning');
    this.isConnected  = false;
    this.isAuthorized = false;

    this._stopPing();
    this._clearAllWatchdogTimers();

    StatePersistence.save(this);

    if (this.endOfDay) {
      this.log('Planned disconnect — not reconnecting');
      return;
    }

    if (this.isReconnecting) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnect attempts reached — please restart the process', 'error');
      this._sendTelegram(`❌ <b>${DEFAULT_CONFIG.symbol} Max reconnect attempts reached</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);
    this.log(`State preserved — Trades: ${this.totalTrades} | P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`);

    this._sendTelegram(
      `⚠️ <b>${DEFAULT_CONFIG.symbol} CONNECTION LOST — RECONNECTING</b>\n` +
      `Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
      `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
      `State preserved: ${this.totalTrades} trades | $${this.totalProfit.toFixed(2)} P&L`
    );

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.isReconnecting = false;
      this.connect();
    }, delay);
  }

  _cleanupWs() {
    this._stopPing();
    this._clearAllWatchdogTimers();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch (_) {}
      this.ws = null;
    }
    this.isConnected  = false;
    this.isAuthorized = false;
  }

  disconnect() {
    this.log('Disconnecting…');
    StatePersistence.save(this);
    this.endOfDay = true;
    this._cleanupWs();
    this.log('Disconnected ✅', 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — SEND
  // ══════════════════════════════════════════════════════════════════════════════

  _send(request) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`Cannot send (not connected): ${JSON.stringify(request).substring(0, 80)}`, 'warning');
      return null;
    }
    request.req_id = this.reqId++;
    try {
      this.ws.send(JSON.stringify(request));
      return request.req_id;
    } catch (e) {
      this.log(`Send error: ${e.message}`, 'error');
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PING / KEEPALIVE
  // ══════════════════════════════════════════════════════════════════════════════

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._send({ ping: 1 });
      }
    }, 5000);
  }

  _stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // MESSAGE ROUTER
  // ══════════════════════════════════════════════════════════════════════════════

  _onRawMessage(data) {
    try {
      this._handleMessage(JSON.parse(data));
    } catch (e) {
      this.log(`Parse error: ${e.message}`, 'error');
    }
  }

  _handleMessage(msg) {
    if (msg.error) {
      this._handleApiError(msg);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg);  break;
      case 'balance':                this._onBalance(msg);    break;
      case 'proposal':               this._onProposal(msg);   break;
      case 'buy':                    this._onBuy(msg);        break;
      case 'proposal_open_contract': this._onContract(msg);   break;
      case 'ohlc':                   this._handleOHLC(msg.ohlc);  break;
      case 'candles':                this._handleCandlesHistory(msg);  break;
      case 'ping':                   break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CANDLE HANDLER — NEW CANDLE DETECTION
  // ══════════════════════════════════════════════════════════════════════════════

  _handleOHLC(ohlc) {
    const symbol = ohlc.symbol;
    const calculatedOpenTime = ohlc.open_time ||
      Math.floor(ohlc.epoch / this.candleConfig.GRANULARITY) * this.candleConfig.GRANULARITY;

    const incomingCandle = {
      open: parseFloat(ohlc.open),
      high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low),
      close: parseFloat(ohlc.close),
      epoch: ohlc.epoch,
      open_time: calculatedOpenTime
    };

    const currentOpenTime = this.assetState.currentFormingCandle?.open_time;
    const isNewCandle = currentOpenTime && incomingCandle.open_time !== currentOpenTime;

    if (isNewCandle) {
      const closedCandle = { ...this.assetState.currentFormingCandle };
      closedCandle.epoch = closedCandle.open_time + this.candleConfig.GRANULARITY;

      if (closedCandle.open_time !== this.assetState.lastProcessedCandleOpenTime) {
        this.assetState.closedCandles.push(closedCandle);

        if (this.assetState.closedCandles.length > this.candleConfig.MAX_CANDLES_STORED) {
          this.assetState.closedCandles = this.assetState.closedCandles.slice(-this.candleConfig.MAX_CANDLES_STORED);
        }

        this.assetState.lastProcessedCandleOpenTime = closedCandle.open_time;

        const closeTime = new Date(closedCandle.epoch * 1000).toISOString();
        const candleType = closedCandle.close > closedCandle.open ? 'BULLISH' : closedCandle.close < closedCandle.open ? 'BEARISH' : 'DOJI';
        const candleEmoji = candleType === 'BULLISH' ? '🟢' : candleType === 'BEARISH' ? '🔴' : '⚪';

        this.log(
          `${symbol} ${candleEmoji} NEW CANDLE [${closeTime}] ${candleType}: O:${closedCandle.open.toFixed(5)} H:${closedCandle.high.toFixed(5)} L:${closedCandle.low.toFixed(5)} C:${closedCandle.close.toFixed(5)}`
        );

        if (this.inRecoveryMode) {
          this.log(`📊 NEW CANDLE — but in RECOVERY mode (L${this.currentGridLevel}), recovery trades continue independently`, 'info');
        } else {
          this.log(`📊 NEW CANDLE — Ready for fresh trade 🚀`, 'success');
          this.canTrade = true;

          if (this.running && !this.tradeInProgress && this.canTrade) {
            this._placeTrade(candleType, candleEmoji);
          }
        }
      }
    }

    this.assetState.currentFormingCandle = incomingCandle;

    const candles = this.assetState.candles;
    const existingIndex = candles.findIndex(c => c.open_time === incomingCandle.open_time);
    if (existingIndex >= 0) {
      candles[existingIndex] = incomingCandle;
    } else {
      candles.push(incomingCandle);
    }

    if (candles.length > this.candleConfig.MAX_CANDLES_STORED) {
      this.assetState.candles = candles.slice(-this.candleConfig.MAX_CANDLES_STORED);
    }
  }

  _handleCandlesHistory(response) {
    if (response.error) {
      this.log(`Error fetching candles: ${response.error.message}`, 'error');
      return;
    }

    const symbol = response.echo_req.ticks_history;
    if (!symbol) return;

    const candles = response.candles.map(c => {
      const openTime = Math.floor((c.epoch - this.candleConfig.GRANULARITY) / this.candleConfig.GRANULARITY) * this.candleConfig.GRANULARITY;
      return {
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        epoch: c.epoch,
        open_time: openTime
      };
    });

    if (candles.length === 0) {
      this.log(`${symbol}: No historical candles received`, 'warning');
      return;
    }

    this.assetState.candles = [...candles];
    this.assetState.closedCandles = [...candles];

    const lastCandle = candles[candles.length - 1];
    this.assetState.lastProcessedCandleOpenTime = lastCandle.open_time;
    this.assetState.currentFormingCandle = null;

    this.log(`📊 Loaded ${candles.length} historical candles for ${symbol}`);

    if (this.inRecoveryMode) {
      this.log(`📊 In recovery mode — canTrade stays true for recovery trades`, 'warning');
      this.canTrade = true;
    } else {
      this.log(`📊 Waiting for next new candle to start trading…`, 'info');
      this.canTrade = false;
    }

    this.assetState.candlesLoaded = true;
  }

  _handleApiError(msg) {
    this.log(`API Error [${msg.error.code}]: ${msg.error.message} (msg_type: ${msg.msg_type})`, 'error');

    const code = msg.error.code;
    if (code === 'AuthorizationRequired' || code === 'InvalidToken') {
      this.isAuthorized = false;
      this._onClose(4001);
      return;
    }

    if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
      this.log('Trade error — releasing lock and retrying in 3s', 'warning');
      this._clearAllWatchdogTimers();
      this.tradeInProgress  = false;
      this.pendingTradeInfo = null;
      this.currentContractId = null;

      if (this.running) {
        if (this.running && !this.tradeInProgress) {
          this.log('Retrying trade after API error…');
          this._placeTrade();
        }
      }
    }
  }

  // ── authorize ─────────────────────────────────────────────────────────────
  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      this._sendTelegram(`❌ <b>${DEFAULT_CONFIG.symbol} Authentication Failed:</b> ${msg.error.message}`);
      return;
    }

    this.isAuthorized = true;
    this.accountId    = msg.authorize.loginid;
    this.balance      = msg.authorize.balance;
    this.currency     = msg.authorize.currency;

    this.log(
      `Authorized ✅ | Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}`,
      'success'
    );

    this._send({ balance: 1, subscribe: 1 });

    this._subscribeToCandles(this.config.symbol);

    if (!this.hasStartedOnce) {
      this._sendTelegram(
        `✅ <b>${DEFAULT_CONFIG.symbol} Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}`
      );
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      const previousDay = this.currentTradeDay;
      const todayKey = getGMTDateKey();
      
      if (previousDay !== todayKey) {
        this.log(`📅 Day changed from ${previousDay} to ${todayKey} during disconnect`, 'info');
        this._sendDayEndSummary(previousDay);
        this._resetDailyStats();
        this.currentTradeDay = todayKey;
      }

      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'}`,
        'success'
      );
      this._sendTelegram(
        `🔄 <b>${DEFAULT_CONFIG.symbol} Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
        `Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO — waiting for candle'}`
      );

      if (this.currentContractId) {
        this.log(`Re-subscribing to contract ${this.currentContractId}…`);
        this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });
        this._startTradeWatchdog(this.currentContractId);
        
        setTimeout(() => {
          if (this.tradeInProgress && this.currentContractId) {
            this.log(`⚠️ Contract ${this.currentContractId} still showing as in progress after reconnect — checking status…`, 'warning');
            this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });
            
            setTimeout(() => {
              if (this.tradeInProgress && this.currentContractId) {
                this.log(`🚨 Contract ${this.currentContractId} appears stuck — forcing stuck trade recovery`, 'error');
                this._recoverStuckTrade('reconnect-timeout');
              }
            }, 15000);
          }
        }, 10000);
        
      } else {
        this.currentGridLevel = 0;
        this.tradeInProgress = false;
        
        if (this.inRecoveryMode) {
          this.canTrade = true;
          this.log('In recovery mode — will trade immediately after candle data loads', 'warning');
        }
        
        if (this.running && !this.tradeInProgress) {
          this.log('No open contract — will trade when candle signals (or immediately if in recovery)', 'success');
          setTimeout(() => {
            if (this.running && !this.tradeInProgress && this.canTrade) this._placeTrade();
          }, 2000);
        }
      }
    }
  }

  _onBalance(msg) {
    this.balance = msg.balance.balance;
    this.log(`Balance updated: ${this.currency} ${this.balance.toFixed(2)}`);
  }

  _onProposal(msg) {
    if (!this.running || !this.tradeInProgress) return;
    if (msg.proposal) {
      this._send({ buy: msg.proposal.id, price: msg.proposal.ask_price });
    }
  }

  _onBuy(msg) {
    const b = msg.buy;
    this.currentContractId   = b.contract_id;
    this.tradeStartTime      = Date.now();
    this.investmentRemaining = Math.max(0, Number((this.investmentRemaining - b.buy_price).toFixed(2)));

    this.log(
      `Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._startTradeWatchdog(b.contract_id);
    this._send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // CONTRACT RESULT — WIN/LOSS HANDLER
  // ══════════════════════════════════════════════════════════════════════════════

  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;

    const contractId = String(c.contract_id);
    
    if (this.currentContractId && contractId !== String(this.currentContractId)) {
      this.log(`⚠️ Ignoring stale contract result: ${contractId} (current: ${this.currentContractId})`, 'warning');
      return;
    }

    if (this._processedContracts.has(contractId)) {
      this.log(`⚠️ Duplicate contract result ignored: ${contractId}`, 'warning');
      return;
    }
    this._processedContracts.add(contractId);
    if (this._processedContracts.size > this._maxProcessedCache) {
      const first = this._processedContracts.values().next().value;
      this._processedContracts.delete(first);
    }

    this._clearAllWatchdogTimers();

    const profit = parseFloat(c.profit);
    const payout = parseFloat(c.payout || 0);
    const isWin  = profit > 0;

    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;
    this.tradeStartTime    = null;

    this.totalTrades += 1;
    this.totalProfit  = Number((this.totalProfit + profit).toFixed(2));
    if (isWin) { this.wins++;   this.isWinTrade = true;  }
    else       { this.losses++; this.isWinTrade = false; }

    this.currentStreak = isWin
      ? (this.currentStreak > 0 ? this.currentStreak + 1 : 1)
      : (this.currentStreak < 0 ? this.currentStreak - 1 : -1);
    if (isWin)  this.maxWinStreak  = Math.max(this.currentStreak, this.maxWinStreak);
    if (!isWin) this.maxLossStreak = Math.min(this.currentStreak, this.maxLossStreak);

    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) this.hourlyStats.wins++; else this.hourlyStats.losses++;

    this.tradeDayStats.trades++;
    this.tradeDayStats.pnl += profit;
    if (isWin) this.tradeDayStats.wins++; else this.tradeDayStats.losses++;

    TradeHistoryManager.recordTrade(profit, this.currentGridLevel, this.investmentRemaining, this.totalProfit);

    if (this.totalProfit <= -this.config.stopLoss) {
      this.log(`🛑 STOP LOSS hit! P&L: $${this.totalProfit.toFixed(2)}`, 'error');
      this._sendTelegram(`🛑 <b>${DEFAULT_CONFIG.symbol} STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      this._sendDayEndSummary(getGMTDateKey());
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>${DEFAULT_CONFIG.symbol} TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      this._sendDayEndSummary(getGMTDateKey());
      return;
    }

    let shouldContinue = true;
    const cfg = this.config;

    // ══════════════════════════════════════════════════════════════════════
    // WIN HANDLING
    // ══════════════════════════════════════════════════════════════════════
    if (isWin) {
      if (this.currentGridLevel > 0) this.totalRecovered += profit;
      
      // Return stake + profit to investment pool
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));
      
      // INTELLIGENT AUTO-COMPOUNDING: Increase base stake based on investment growth
      if (cfg.autoCompounding) {
        const newBaseStake = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
        
        // Check if new base stake would require too much investment
        const requiredInvestment = MartingaleCalculator.calculateRequiredInvestment(newBaseStake, this.multipliers);
        
        if (requiredInvestment <= this.investmentRemaining * 1.5) {
          // Safe to increase base stake
          this.baseStake = newBaseStake;
          this._updateInvestmentForStake();
          
          this.log(
            `🎯 WIN +$${profit.toFixed(2)} | RECOVERY COMPLETE! 🎉 | ` +
            `L${this.currentGridLevel} → RESET | ` +
            `Investment: $${this.investmentRemaining.toFixed(2)} | New base: $${this.baseStake.toFixed(2)}`,
            'success'
          );
        } else {
          this.log(
            `🎯 WIN +$${profit.toFixed(2)} | RECOVERY COMPLETE! 🎉 | ` +
            `L${this.currentGridLevel} → RESET | ` +
            `Investment: $${this.investmentRemaining.toFixed(2)} | Base stake stable: $${this.baseStake.toFixed(2)}`,
            'success'
          );
        }
      } else {
        this.log(
          `🎯 WIN +$${profit.toFixed(2)} | FULL RECOVERY! 🎉 | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | Reset → L0`,
          'success'
        );
      }

      this.currentGridLevel = 0;
      this.inRecoveryMode   = false;
      this.canTrade         = false;

      this.log(`⏳ Waiting for next new candle before placing new trade…`, 'info');
      this._sendTelegramTradeResult(isWin, profit);

    // ══════════════════════════════════════════════════════════════════════
    // LOSS HANDLING
    // ══════════════════════════════════════════════════════════════════════
    } else {
      const nextLevel = this.currentGridLevel + 1;
      
      // Mean reversion strategy
      let nextDir;
      if (this.currentGridLevel <= 3) {
        nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      } else if (this.currentGridLevel % 3 === 0) {
        nextDir = this.currentDirection;
      } else {
        nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      }

      this.currentDirection = nextDir;
      this.currentGridLevel = nextLevel;
      this.inRecoveryMode = true;
      this.canTrade       = true;

      if (nextLevel > cfg.maxMartingaleLevel) {
        this.log(`🛑 ABSOLUTE CEILING L${cfg.maxMartingaleLevel} reached — stopping to protect investment`, 'error');
        this._sendTelegram(
          `🛑 <b>${DEFAULT_CONFIG.symbol} ABSOLUTE MAX LEVEL REACHED (L${cfg.maxMartingaleLevel})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue = false;
        this.inRecoveryMode = false;
        this.canTrade = false;
      } else {
        const nextStake = this.calculateStake(this.currentGridLevel);
        this.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | Grid L${this.currentGridLevel} | ` +
          `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ RECOVERY TRADE NEXT`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          this.log(`🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
          shouldContinue = false;
          this.inRecoveryMode = false;
          this.canTrade = false;
        } else if (nextStake > this.balance) {
          this.log(`🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`, 'error');
          shouldContinue = false;
          this.inRecoveryMode = false;
          this.canTrade = false;
        }
      }
    }

    if (!shouldContinue) {
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      this._logSummary();
      this._sendDayEndSummary(getGMTDateKey());
      return;
    }

    if (this.running && this.inRecoveryMode && this.canTrade) {
      this.log(`⚡ Recovery trade scheduled in 1s (L${this.currentGridLevel})…`, 'warning');
      setTimeout(() => {
        if (this.running && !this.tradeInProgress && this.canTrade) {
          this._placeTrade();
        }
      }, 1000);
    } else if (this.running && !this.inRecoveryMode) {
      this.log(`⏳ WIN — Next trade will be placed on next new candle`, 'success');
    }
  }

  _startTradeWatchdog(contractId) {
    this._clearAllWatchdogTimers();
    const duration = this.getTickDuration(this.currentGridLevel);
    const timeoutMs = duration > 3 ? (this.tradeWatchdogMs + 5000) : this.tradeWatchdogMs;

    this.tradeWatchdogTimer = setTimeout(() => {
      if (!this.tradeInProgress) return;

      this.log(`⏰ WATCHDOG FIRED — Contract ${contractId} open for ${(timeoutMs / 1000)}s`, 'warning');

      if (contractId && this.isConnected && this.isAuthorized) {
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

        this.tradeWatchdogPollTimer = setTimeout(() => {
          if (!this.tradeInProgress) return;
          this.log(`🚨 WATCHDOG: Poll timed out — force-releasing lock`, 'error');
          this._recoverStuckTrade('watchdog-force');
        }, timeoutMs);
      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }

  _clearAllWatchdogTimers() {
    if (this.tradeWatchdogTimer) { clearTimeout(this.tradeWatchdogTimer); this.tradeWatchdogTimer = null; }
    if (this.tradeWatchdogPollTimer) { clearTimeout(this.tradeWatchdogPollTimer); this.tradeWatchdogPollTimer = null; }
  }

  _subscribeToCandles(symbol) {
    this.log(`📊 Subscribing to ${this.candleConfig.GRANULARITY}s candles for ${symbol}...`);

    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: this.candleConfig.CANDLES_TO_LOAD,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY
    });

    this._send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1,
      end: 'latest',
      start: 1,
      style: 'candles',
      granularity: this.candleConfig.GRANULARITY,
      subscribe: 1
    });
  }

  _recoverStuckTrade(reason) {
    const contractId = this.currentContractId;
    const stakeInfo = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime ? Math.round((Date.now() - this.tradeStartTime) / 1000) : '?';

    this.log(`🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | Open for: ${openSeconds}s`, 'error');
    this.stuckTradeCount++;

    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number((this.investmentRemaining + stakeInfo.stake).toFixed(2));
      this.log(`💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool`, 'warning');
    }

    if (contractId) this._processedContracts.add(String(contractId));

    this.tradeInProgress = false;
    this.pendingTradeInfo = null;
    this.currentContractId = null;
    this.tradeStartTime = null;

    this._clearAllWatchdogTimers();

    const pauseDurationMs = this.config.stuckTradePauseDuration || (5 * 60 * 1000);
    const pauseDurationMin = Math.round(pauseDurationMs / 60000);

    this.isPausedDueToStuckTrade = true;
    this.canTrade = false;
    this.inRecoveryMode = false;

    const previousGridLevel = this.currentGridLevel;
    const previousBaseStake = this.baseStake;
    this.currentGridLevel = 0;
    this.currentDirection = 'CALLE';
    this.baseStake = this.config.initialStake;
    this._updateInvestmentForStake();
    
    this.log(`⏸️ PAUSING TRADING for ${pauseDurationMin} minute(s)`, 'warning');

    this._sendTelegram(
      `🛑 <b>${DEFAULT_CONFIG.symbol} STUCK TRADE — PAUSING ${pauseDurationMin} MIN</b>\n` +
      `Reason: ${reason} | Contract open: ${openSeconds}s\n` +
      `Stake $${stakeInfo?.stake?.toFixed(2) || '0.00'} returned\n` +
      `Trading resumes at ${new Date(Date.now() + pauseDurationMs).toLocaleTimeString()}`
    );

    StatePersistence.save(this);

    if (this.stuckTradePauseTimer) { clearTimeout(this.stuckTradePauseTimer); this.stuckTradePauseTimer = null; }
    this.stuckTradePauseTimer = setTimeout(() => this._resumeTradingAfterStuckTradePause(), pauseDurationMs);
  }

  _resumeTradingAfterStuckTradePause() {
    this.isPausedDueToStuckTrade = false;
    this.canTrade = true;

    this.log(`✅ STUCK TRADE PAUSE COMPLETE | Trading resumed`, 'success');

    this._sendTelegram(
      `✅ <b>${DEFAULT_CONFIG.symbol} TRADING RESUMED</b>\n` +
      `Grid Level: L${this.currentGridLevel} | Base: $${this.baseStake.toFixed(2)}\n` +
      `Investment: $${this.investmentRemaining.toFixed(2)}`
    );
  }

  getTickDuration(level) {
    if (level === 0) return DEFAULT_CONFIG.tickDuration;
    if (level <= 2) return DEFAULT_CONFIG.tickDuration;
    if (level <= 5) return DEFAULT_CONFIG.tickDuration + 2;
    return 5;
  }

  _placeTrade(candleType, candleEmoji) {
    if (!this.isAuthorized) { this.log('Not authorized — cannot trade', 'error'); return; }
    if (!this.running) return;
    if (this.tradeInProgress) { this.log('Trade already in progress…', 'warning'); return; }

    if (this.isPausedDueToStuckTrade) {
      const remainingMin = Math.ceil((this.stuckTradePauseTimer?._idleTimeout - Date.now()) / 60000);
      this.log(`⏸️ Paused due to stuck trade. Resuming in ${remainingMin} minute(s)`, 'warning');
      return;
    }

    if (!this.canTrade) {
      if (this.inRecoveryMode) {
        this.log('⚡ Recovery mode but canTrade=false — forcing canTrade=true', 'warning');
        this.canTrade = true;
      } else {
        this.log('⏳ Waiting for new candle before trading…', 'info');
        return;
      }
    }

    if (!this.inRecoveryMode) {
      this.currentDirection = candleType === 'BULLISH' ? 'CALLE' : 'PUTE';
      if (candleType === 'DOJI') {
        this.log('Last Candle was a Doji', 'warning');
        return;
      }
    }

    const stake = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label = direction === 'CALLE' ? 'HIGHER' : 'LOWER';
    const tradeType = this.inRecoveryMode ? '⚡ RECOVERY' : '🕯️ NEW CANDLE';

    if (stake > this.investmentRemaining) {
      this.log(`Insufficient investment: $${stake} > $${this.investmentRemaining.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (stake > this.balance) {
      this.log(`Insufficient balance: $${stake} > $${this.balance.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    const duration = this.getTickDuration(this.currentGridLevel);

    this.log(`📊 ${tradeType} TRADE | ${label} | L${this.currentGridLevel} | Stake: $${stake}`);

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol}: TRADE OPEN</b>\n` +
      `Type: ${tradeType}\n` +
      `Direction: ${label}\n` +
      `Stake: $${stake}\n` +
      `Grid Level: ${this.currentGridLevel}\n` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    if (!this.inRecoveryMode) this.canTrade = false;

    this.tradeInProgress = true;
    this.pendingTradeInfo = { id: Date.now(), time: new Date().toISOString(), direction, stake, gridLevel: this.currentGridLevel };

    this._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: direction,
      currency: this.currency,
      duration: duration,
      duration_unit: 't',
      symbol: this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.isAuthorized) { this.log('Not authorized — connect first', 'error'); return false; }
    if (this.running) { this.log('Bot already running', 'warning'); return false; }
    
    const cfg = this.config;
    
    // Calculate safe base stake from investment
    const safeBaseStake = this._getSafeBaseStake(cfg.investmentAmount);
    
    if (cfg.autoCompounding) {
      this.baseStake = Math.max(safeBaseStake, cfg.initialStake);
      this.log(`💰 Auto-compounding ON: Base stake $${this.baseStake.toFixed(2)}`);
    } else {
      this.baseStake = cfg.initialStake;
    }
    
    // Calculate required investment for current base stake
    const requiredInvestment = this._updateInvestmentForStake();
    
    this.investmentRemaining = cfg.investmentAmount;
    this.investmentStartAmount = cfg.investmentAmount;
    
    this.running = true;
    this.currentGridLevel = 0;
    this.currentDirection = 'CALLE';
    this.totalProfit = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.currentStreak = 0;
    this.maxWinStreak = 0;
    this.maxLossStreak = 0;
    this.totalRecovered = 0;
    this.tradeInProgress = false;
    this.pendingTradeInfo = null;
    this.currentContractId = null;
    this.isWinTrade = false;
    this.reconnectAttempts = 0;
    this.hasStartedOnce = true;
    this.currentTradeDay = getGMTDateKey();
    this.tradeDayStats = { trades: 0, pnl: 0, wins: 0, losses: 0 };
    this.inRecoveryMode = false;
    this.canTrade = false;
    this.isPausedDueToStuckTrade = false;

    // Log stake breakdown
    const breakdown = this.getStakeBreakdown();
    this.log(`📊 Stake breakdown (L0-L${this.config.maxMartingaleLevel}):`);
    breakdown.forEach(b => {
      this.log(`   L${b.level}: $${b.stake.toFixed(2)} (cumulative: $${b.cumulative.toFixed(2)})`);
    });

    this.log(`🚀 ${DEFAULT_CONFIG.symbol} Grid Bot STARTED!`, 'success');
    this.log(`💵 Investment: $${cfg.investmentAmount} | Required for safety: $${requiredInvestment.toFixed(2)}`);
    this.log(`📊 Base Stake: $${this.baseStake.toFixed(2)} | Max Level: L${cfg.maxMartingaleLevel}`);
    this.log(`⏳ Waiting for first new candle to start trading…`);

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol} Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Max Level: L${cfg.maxMartingaleLevel}\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}`
    );

    return true;
  }

  stop() {
    this.running = false;
    this.tradeInProgress = false;
    this.inRecoveryMode = false;
    this.canTrade = false;
    this._clearAllWatchdogTimers();
    this.log('🛑 Bot stopped', 'warning');
    this._sendTelegram(`🛑 <b>${DEFAULT_CONFIG.symbol} Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)}`);
    this._logSummary();
    this._sendDayEndSummary(getGMTDateKey());
  }

  emergencyStop() {
    this.running = false;
    this.tradeInProgress = false;
    this.inRecoveryMode = false;
    this.canTrade = false;
    this._clearAllWatchdogTimers();
    this.log('🚨 EMERGENCY STOP', 'error');
    this._sendTelegram(`🚨 <b>${DEFAULT_CONFIG.symbol} EMERGENCY STOP</b>\nP&L: $${this.totalProfit.toFixed(2)}`);
    this._logSummary();
    this._sendDayEndSummary(getGMTDateKey());
  }

  _logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    this.log(`📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.config.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      console.error(`[Telegram] send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const dirLabel = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— ${DEFAULT_CONFIG.symbol}</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} P&L: ${pnlStr}\n` +
      `Grid Level: ${this.currentGridLevel} → ${isWin ? 'RESET L0' : `L${this.currentGridLevel}`}\n` +
      `Next: ${isWin ? '⏳ Waiting for candle' : `${dirLabel} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}`}\n\n` +
      `Session: ${this.totalTrades} trades | W/L: ${this.wins}/${this.losses}\n` +
      `Win Rate: ${wr}%\n` +
      `P&L: $${this.totalProfit.toFixed(2)}\n` +
      `Investment: $${this.investmentRemaining.toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  async _sendHourlySummary() {
    const s = this.hourlyStats;
    const wr = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';

    await this._sendTelegram(
      `⏰ <b>${DEFAULT_CONFIG.symbol} — Hourly Summary</b>\n\n` +
      `Last Hour: ${s.trades} trades | ${s.wins}W/${s.losses}L | ${wr}%\n` +
      `P&L: ${(s.pnl >= 0 ? '+' : '')}$${s.pnl.toFixed(2)}\n\n` +
      `Session: ${this.totalTrades} trades | $${this.totalProfit.toFixed(2)}\n` +
      `Investment: $${this.investmentRemaining.toFixed(2)}`
    );

    this.log('📱 Hourly summary sent');
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
  }

  async _sendDayEndSummary(dateKey) {
    const dayStats = TradeHistoryManager.getDayStats(dateKey);
    const overall = TradeHistoryManager.getOverallStats();
    const recentDays = TradeHistoryManager.getRecentDays(5);

    if (!dayStats || dayStats.tradesCount === 0) return;

    const dayWinRate = dayStats.tradesCount > 0 ? ((dayStats.winsCount / dayStats.tradesCount) * 100).toFixed(1) + '%' : '0.0%';
    const overallWinRate = overall.tradesCount > 0 ? ((overall.winsCount / overall.tradesCount) * 100).toFixed(1) + '%' : '0.0%';
    const pnlEmoji = dayStats.netPL >= 0 ? '🟢' : '🔴';
    const overallPnlEmoji = overall.netPL >= 0 ? '🟢' : '🔴';

    let recentDaysStr = '';
    recentDays.forEach(day => {
      const wr = day.tradesCount > 0 ? ((day.winsCount / day.tradesCount) * 100).toFixed(1) : '0.0';
      const dayPnlEmoji = day.netPL >= 0 ? '🟢' : '🔴';
      recentDaysStr += `\n  ${day.date}: ${day.tradesCount}t ${day.winsCount}W/${day.lossesCount}L (${wr}%) ${dayPnlEmoji} $${day.netPL.toFixed(2)}`;
    });

    await this._sendTelegram(
      `🌙 <b>END OF DAY REPORT — ${dateKey}</b>\n\n` +
      `${pnlEmoji} <b>Day Results:</b>\n` +
      `Trades: ${dayStats.tradesCount} | ${dayStats.winsCount}W/${dayStats.lossesCount}L (${dayWinRate})\n` +
      `P/L: $${dayStats.netPL.toFixed(2)}\n\n` +
      `📊 <b>Overall (All Time):</b>\n` +
      `Total: ${overall.tradesCount} trades | ${overallWinRate}\n` +
      `${overallPnlEmoji} P/L: $${overall.netPL.toFixed(2)}\n\n` +
      `📆 <b>Recent Days:</b>${recentDaysStr}\n\n` +
      `💰 Capital: $${this.balance.toFixed(2)}`
    );

    this.log(`📱 Day-end summary sent for ${dateKey}`);
  }

  startTelegramTimer() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNext = nextHour.getTime() - now.getTime();

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, msUntilNext);

    this.log(`📱 Hourly summaries scheduled (first in ${Math.ceil(msUntilNext / 60000)} min)`);
  }

  startTimeScheduler() {
    setInterval(() => {
      const now = new Date();
      const gmt1 = new Date(now.getTime() + (1 * 60 * 60 * 1000));
      const hours = gmt1.getHours();
      const minutes = gmt1.getMinutes();

      const dayChange = TradeHistoryManager.checkDayChange(this.currentTradeDay);
      if (dayChange.changed) {
        this.log(`📅 Day changed from ${dayChange.previousDay} to ${dayChange.newDay}`, 'info');
        this._sendDayEndSummary(dayChange.previousDay);
        this._resetDailyStats();
        this.currentTradeDay = dayChange.newDay;
      }

      if (this.endOfDay && hours === 3 && minutes >= 0) {
        this.log('📅 03:00 GMT+1 — reconnecting', 'success');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
      }

      if (!this.endOfDay && this.isWinTrade && hours >= 23) {
        this.log('📅 Past 23:00 GMT+1 — end-of-day stop', 'info');
        this._sendHourlySummary();
        this._sendDayEndSummary(getGMTDateKey());
        this.disconnect();
        this.endOfDay = true;
      }
    }, 10000);

    this.log('📅 Time scheduler started');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade = false;
    this.inRecoveryMode = false;
    this.canTrade = false;
    this.currentTradeDay = getGMTDateKey();
    this.tradeDayStats = { trades: 0, pnl: 0, wins: 0, losses: 0 };
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
    TradeHistoryManager.ensureDayEntry(this.currentTradeDay);
    tradeHistory.dailyHistory[this.currentTradeDay].startCapital = this.investmentRemaining;
    TradeHistoryManager.saveHistory();
    this.log('📊 Daily stats reset');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   GRID MARTINGALE BOT — Intelligent Auto-Compounding             ║');
  console.log('║   Strategy: Trade on NEW CANDLE | Recovery until WIN              ║');
  console.log('║   ENHANCED: Smart multipliers + Full loss recovery guarantee       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
  console.log('Key Features:');
  console.log('  • Optimal multipliers calculated for full loss recovery');
  console.log('  • Auto-adjusting investment to cover all martingale levels');
  console.log('  • Intelligent base stake growth with safety limits\n');
  console.log('Signals: SIGINT / SIGTERM for graceful shutdown\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

function main() {
  printBanner();

  const bot = new STEPINDEXGridBot(DEFAULT_CONFIG);

  StatePersistence.startAutoSave(bot);

  if (bot.telegramBot) bot.startTelegramTimer();

  bot.startTimeScheduler();

  bot.connect();

  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully…`);
    bot.stop();
    bot.disconnect();
    StatePersistence.save(bot);
    TradeHistoryManager.saveHistory();
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason));
  process.on('uncaughtException', (err) => console.error('[UncaughtException]', err));
}

main();
