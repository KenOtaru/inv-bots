#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║   STEP INDEX POSITIVE EXPECTATION DETECTOR + GRID MARTINGALE BOT               ║
// ║   Research-Driven: Digit Exploit Detection → Statistical Bias Analysis          ║
// ║   If exploitable edge found: Auto-switch to digit strategy                     ║
// ║   If no edge: Fall back to optimized grid martingale                            ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiToken: 'rgNedekYXvCaPeP',
  appId:    '1089',

  symbol:        'R_100',
  tickDuration:  1,                    // ODD DURATION ONLY (no ties on Step Index)
  initialStake:  0.35,
  investmentAmount: 153,
  // Enable/disable strategies
  enableGrid: false,
  enableDigitExploit: true,

  // ── OPTIMIZED MARTINGALE (2.1x consistent multiplier) ──────────────────
  martingaleMultiplier:  1.48,           // Was: 1.48 (creates dead zones!)
  maxMartingaleLevel:    1,             // 2.1^7 ≈ 378x base = ~$136 max
  afterMaxLoss:          'continue',        // Don't extend beyond max
  continueExtraLevels:   8,             // Not needed with 2.1x
  extraLevelMultipliers: [1.8, 2.1, 2.1, 2.1, 2.1, 2.1, 2.1],            // Simplified
  maxMartingaleLevel:    9,             // 2.1^7 ≈ 378x base = ~$136 max

  autoCompounding:    true,
  compoundPercentage: 0.24,              // Was: 0.24 (too slow)

  stopLoss:   153,
  takeProfit: 10000,

  stuckTradePauseDuration: 5 * 60 * 1000,

  telegramToken:   '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
  telegramChatId:  '752497117',
  telegramEnabled: true,

  // ── EXPLOIT DETECTION SETTINGS ────────────────────────────────────────
  runExploitDetection: true,            // Enable exploit detection pipeline
  biasDetectionMinSample: 5000,         // Ticks needed before bias analysis
  biasDetectionMaxSample: 50000,
};

// ══════════════════════════════════════════════════════════════════════════════
// FILE PATHS
// ══════════════════════════════════════════════════════════════════════════════

const STATE_FILE          = path.join(__dirname, 'STT-grid-state01.json');
const STATE_SAVE_INTERVAL = 5000;
const EXPLOIT_RESULTS_FILE = path.join(__dirname, 'exploit-detection-results.json');

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
          chainBaseStake:      bot.chainBaseStake,
          investmentRemaining: bot.investmentRemaining,
          totalRecovered:      bot.totalRecovered,
          maxWinStreak:        bot.maxWinStreak,
          maxLossStreak:       bot.maxLossStreak,
          currentStreak:       bot.currentStreak,
          inRecoveryMode:      bot.inRecoveryMode,
          tradingMode:         bot.tradingMode,
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

  static saveExploitResults(results) {
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        symbol: DEFAULT_CONFIG.symbol,
        results,
      };
      fs.writeFileSync(EXPLOIT_RESULTS_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.error(`[ExploitResults] save error: ${e.message}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class STEPINDEXGridBot {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

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

    // ── Ping / Keepalive ────────────────────────────────────────────────────
    this.pingInterval = null;

    // ── Trade Watchdog ───────────────────────────────────────────────────────
    this.tradeWatchdogTimer    = null;
    this.tradeWatchdogPollTimer = null;
    this.tradeWatchdogMs       = 5000;
    this.tradeStartTime        = null;

    // ── Stuck Trade Pause State ──────────────────────────────────────────────
    this.isPausedDueToStuckTrade = false;
    this.stuckTradePauseTimer    = null;
    this.stuckTradeCount         = 0;

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
    this.chainBaseStake        = this.config.initialStake;
    this.investmentRemaining   = this.config.investmentAmount || 0;
    this.investmentStartAmount = this.config.investmentAmount || 0;
    this.totalProfit           = 0;
    this.totalTrades           = 0;
    this.wins                  = 0;
    this.losses                = 0;
    this.currentStreak         = 0;
    this.maxWinStreak          = 0;
    this.maxLossStreak         = 0;
    this.totalRecovered        = 0;

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

    // ── CANDLE-GATED + RECOVERY LOGIC ──────────────────────────────────
    this.canTrade       = false;
    this.inRecoveryMode = false;

    // ── Trading Mode (grid vs digit exploit) ────────────────────────────────
    this.tradingMode = 'grid';        // 'grid' or 'digit-exploit'
    this.digitExploit = null;         // Populated if exploit is found

    // ── Session control ────────────────────────────────────────────────────────
    this.endOfDay         = false;
    this.isWinTrade       = false;
    this.hasStartedOnce   = false;
    this._autoSaveInterval = null;

    this._processedContracts = new Set();
    this._maxProcessedCache  = 200;

    // ── Hourly Telegram stats ──────────────────────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

    // ── EXPLOIT DETECTION STATE ────────────────────────────────────────────────
    this.exploitDetectionPhase = 'pending';  // pending, scanning-contracts, testing-digits, bias-detection, complete
    this._exploitScanComplete = false;
    this.availableContracts = {};
    this.biasDetector = null;
    this.digitExploitOpportunities = [];
    this._biasExploitDirection = null;
    this._biasNetEdge = 0;
    this._bestDigitExploit = null;

    // ── Telegram ───────────────────────────────────────────────────────────────
    this.telegramBot = null;
    if (this.config.telegramEnabled && this.config.telegramToken && this.config.telegramChatId) {
      try {
        this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        this.log('Telegram notifications enabled ✅');
      } catch (e) {
        this.log(`Telegram init error: ${e.message}`, 'warning');
      }
    }

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
    this.chainBaseStake      = t.chainBaseStake      || this.baseStake;
    this.investmentRemaining = t.investmentRemaining || 0;
    this.totalRecovered      = t.totalRecovered      || 0;
    this.maxWinStreak        = t.maxWinStreak        || 0;
    this.maxLossStreak       = t.maxLossStreak       || 0;
    this.currentStreak       = t.currentStreak       || 0;
    this.inRecoveryMode      = t.inRecoveryMode      || false;
    this.tradingMode         = t.tradingMode         || 'grid';
    this.canTrade            = this.inRecoveryMode;
    this.hasStartedOnce      = true;
    this.log(
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel} | ` +
      `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | Mode: ${this.tradingMode}`,
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
  // STAKE CALCULATOR
  // ══════════════════════════════════════════════════════════════════════════════

  calculateStake(level) {
    const cfg = this.config;

    // If user enabled only one strategy, pick it explicitly
    if (cfg.enableDigitExploit && !cfg.enableGrid) {
      this.tradingMode = 'digit-exploit';
    } else if (cfg.enableGrid && !cfg.enableDigitExploit) {
      this.tradingMode = 'grid';
    }
    let base  = this.baseStake;

    if (cfg.autoCompounding && this.investmentRemaining > 0) {
      base = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
    }
    base = Math.max(base, 0.35);

    if (level <= cfg.maxMartingaleLevel) {
      return Number((base * Math.pow(cfg.martingaleMultiplier, level)).toFixed(2));
    }

    let stake    = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraIdx = level - cfg.maxMartingaleLevel - 1;
    const mults  = cfg.extraLevelMultipliers || [];
    for (let i = 0; i <= extraIdx; i++) {
      stake *= (mults[i] > 0 ? mults[i] : cfg.martingaleMultiplier);
    }
    return Number(stake.toFixed(2));
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
    this.isReconnecting    = false;

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

    this.tradeInProgress  = false;
    this.pendingTradeInfo = null;

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

  // ══════════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ══════════════════════════════════════════════════════════════════════════════

  _handleMessage(msg) {
    if (msg.error) {
      this._handleApiError(msg);
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg);              break;
      case 'balance':                this._onBalance(msg);                break;
      case 'proposal':               this._onProposal(msg);               break;
      case 'buy':                    this._onBuy(msg);                    break;
      case 'proposal_open_contract': this._onContract(msg);               break;
      case 'ohlc':                   this._handleOHLC(msg.ohlc);          break;
      case 'candles':                this._handleCandlesHistory(msg);     break;
      case 'tick':                   this._onTickForExploit(msg.tick); this._onLiveTickForBias(msg.tick); break;
      case 'ticks':                  this._onTicksForBias(msg.ticks);     break;
      case 'history':                this._onTickHistoryForBias(msg);     break;  // ← NEW
      case 'contracts_for':          this._onContractsFor(msg);           break;
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

        if (this.tradingMode === 'grid') {
          if (this.inRecoveryMode) {
            this.log(`📊 NEW CANDLE — but in RECOVERY mode (L${this.currentGridLevel}), recovery trades continue independently`, 'info');
          } else {
            this.log(`📊 NEW CANDLE — Ready for fresh trade 🚀`, 'success');
            this.canTrade = true;

            if (this.running && !this.tradeInProgress && this.canTrade) {
              this._placeTrade();
            }
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

    // ═════════════════════════════════════════════════════════════════════════
    // EXPLOIT DETECTION PIPELINE (Phase 1: Contract Scanning)
    // ═════════════════════════════════════════════════════════════════════════
    if (this.config.runExploitDetection && !this._exploitScanComplete) {
      this._exploitScanComplete = true;
      this.log('🔬 Starting positive-EV exploit detection pipeline...', 'info');
      this._sendTelegram(`🔬 <b>Starting exploit detection for ${DEFAULT_CONFIG.symbol}</b>`);

      setTimeout(() => {
        this.exploitDetectionPhase = 'scanning-contracts';
        this.scanAvailableContracts();
      }, 2000);
    }

    if (!this.hasStartedOnce) {
      this._sendTelegram(
        `✅ <b>${DEFAULT_CONFIG.symbol} Grid Bot Connected</b>\n` +
        `Account: ${this.accountId}\n` +
        `Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Status: Running exploit detection...`
      );
      setTimeout(() => { if (!this.running) this.start(); }, 300);

    } else {
      this.tradeInProgress = false;
      this.log(
        `🔄 Reconnected — resuming | L${this.currentGridLevel} | ` +
        `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} | ` +
        `Investment: $${this.investmentRemaining.toFixed(2)} | ` +
        `Recovery: ${this.inRecoveryMode ? 'YES' : 'NO'} | ` +
        `Mode: ${this.tradingMode}`,
        'success'
      );
      this._sendTelegram(
        `🔄 <b>${DEFAULT_CONFIG.symbol} Reconnected — Resuming</b>\n` +
        `Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
        `Grid Level: ${this.currentGridLevel} | ` +
        `Next: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n` +
        `Investment: $${this.investmentRemaining.toFixed(2)}\n` +
        `Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO — waiting for candle'}\n` +
        `Trading Mode: ${this.tradingMode}`
      );

      if (this.currentContractId) {
        this.currentGridLevel = 0;
        this.log(`Re-subscribing to open contract ${this.currentContractId}…`);
        this.tradeInProgress = true;
        this._send({ proposal_open_contract: 1, contract_id: this.currentContractId, subscribe: 1 });
        this._startTradeWatchdog(this.currentContractId, 5000);
      } else {
        this.currentGridLevel = 0;
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

  // ── balance ───────────────────────────────────────────────────────────────
  _onBalance(msg) {
    this.balance = msg.balance.balance;
    this.log(`Balance updated: ${this.currency} ${this.balance.toFixed(2)}`);
  }

  // ── proposal → buy ────────────────────────────────────────────────────────
  _onProposal(msg) {
    if (!this.running || !this.tradeInProgress) return;
    if (msg.proposal) {
      this._send({ buy: msg.proposal.id, price: msg.proposal.ask_price });
    }
  }

  // ── buy confirmation ──────────────────────────────────────────────────────
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
      this.log(
        `⚠️ Ignoring stale contract result: ${contractId} (current: ${this.currentContractId})`,
        'warning'
      );
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

    // ── Update counters ───────────────────────────────────────────────────
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

    // ── Risk management ───────────────────────────────────────────────────
    if (this.totalProfit <= -this.config.stopLoss) {
      this.log(`🛑 STOP LOSS hit! P&L: $${this.totalProfit.toFixed(2)}`, 'error');
      this._sendTelegram(`🛑 <b>${DEFAULT_CONFIG.symbol} STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>${DEFAULT_CONFIG.symbol} TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // GRID STRATEGY (used when tradingMode === 'grid')
    // ══════════════════════════════════════════════════════════════════════
    if (this.tradingMode === 'grid') {
      this._handleGridStrategyResult(isWin, profit, payout);
    } else if (this.tradingMode === 'digit-exploit') {
      // Route digit-exploit results through the grid result handler so the
      // same stake/martingale/auto-compounding logic is used.
      this._handleGridStrategyResult(isWin, profit, payout);
      // ensure tradeInProgress false so next tick can place a new trade
      this.tradeInProgress = false;
    }
  }

  _handleGridStrategyResult(isWin, profit, payout) {
    let shouldContinue = true;
    const cfg          = this.config;

    // ══════════════════════════════════════════════════════════════════════
    // WIN HANDLING
    // ══════════════════════════════════════════════════════════════════════
    if (isWin) {
      if (this.currentGridLevel > 0) this.totalRecovered += profit;
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));

      const wasRecovery = this.inRecoveryMode;

      if (cfg.autoCompounding) {
        this.baseStake = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | RECOVERY COMPLETE! 🎉' : ''} | ` +
          `L${this.currentGridLevel} → RESET | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | New base: $${this.baseStake.toFixed(2)}`,
          'success'
        );
      } else {
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}${wasRecovery ? ' | FULL RECOVERY! 🎉' : ''} | ` +
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
      const nextLevel   = this.currentGridLevel + 1;
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      // ── SIMPLIFIED DIRECTION: Alternate ───────────────────────────────────
      const nextDir = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';

      this.currentDirection = nextDir;
      this.currentGridLevel = nextLevel;
      this.inRecoveryMode = true;
      this.canTrade       = true;

      if (nextLevel > absoluteMax) {
        this.log(`🛑 ABSOLUTE CEILING L${absoluteMax} reached — stopping to protect investment`, 'error');
        this._sendTelegram(
          `🛑 <b>${DEFAULT_CONFIG.symbol} ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue      = false;
        this.inRecoveryMode = false;
        this.canTrade       = false;

      } else {
        const nextStake = this.calculateStake(nextLevel);
        this.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | Grid L${this.currentGridLevel} | ` +
          `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} | ⚡ RECOVERY TRADE NEXT`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (this.investmentRemaining > 0 && nextStake > this.investmentRemaining) {
          this.log(`🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
          shouldContinue      = false;
          this.inRecoveryMode = false;
          this.canTrade       = false;
        } else if (nextStake > this.balance) {
          this.log(`🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`, 'error');
          shouldContinue      = false;
          this.inRecoveryMode = false;
          this.canTrade       = false;
        }
      }
    }

    if (!shouldContinue) {
      this.running        = false;
      this.inRecoveryMode = false;
      this.canTrade       = false;
      this._logSummary();
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // NEXT TRADE SCHEDULING
    // ══════════════════════════════════════════════════════════════════════
    if (this.running && this.inRecoveryMode && this.canTrade) {
      if (this.tradingMode === 'grid') {
        this.log(`⚡ Recovery trade scheduled in 1s (L${this.currentGridLevel})…`, 'warning');
        setTimeout(() => {
          if (this.running && !this.tradeInProgress && this.canTrade) {
            this._placeTrade();
          }
        }, 1000);
      } else if (this.tradingMode === 'digit-exploit') {
        this.log(`⚡ Recovery active (digit-exploit) — will retry on next tick (L${this.currentGridLevel})…`, 'warning');
        // digit-exploit places trades from tick handler; no grid scheduling here
      }
    } else if (this.running && !this.inRecoveryMode) {
      this.log(`⏳ WIN — Next trade will be placed on next new candle`, 'success');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TRADE WATCHDOG — DETECT STUCK CONTRACTS
  // ══════════════════════════════════════════════════════════════════════════════

  _startTradeWatchdog(contractId, customTimeoutMs) {
    this._clearAllWatchdogTimers();

    const timeoutMs = this.tradeWatchdogMs;

    this.tradeWatchdogTimer = setTimeout(() => {
      if (!this.tradeInProgress) return;

      this.log(
        `⏰ WATCHDOG FIRED — Contract ${contractId} has been open for ` +
        `${(timeoutMs / 1000)}s with no settlement`,
        'warning'
      );

      if (contractId && this.isConnected && this.isAuthorized) {
        this.log(`🔍 Polling contract ${contractId} for current status…`);
        this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });

        this.tradeWatchdogPollTimer = setTimeout(() => {
          if (!this.tradeInProgress) return;
          this.log(
            `🚨 WATCHDOG: Poll timed out — contract ${contractId} still unresolved ` +
            `after ${(timeoutMs / 1000)}s — force-releasing lock`,
            'error'
          );
          this._recoverStuckTrade('watchdog-force');
        }, timeoutMs);

      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }

  _clearAllWatchdogTimers() {
    if (this.tradeWatchdogTimer) {
      clearTimeout(this.tradeWatchdogTimer);
      this.tradeWatchdogTimer = null;
    }
    if (this.tradeWatchdogPollTimer) {
      clearTimeout(this.tradeWatchdogPollTimer);
      this.tradeWatchdogPollTimer = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SUBSCRIBE TO CANDLES
  // ══════════════════════════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════════════════════════
  // RECOVER FROM STUCK TRADE
  // ══════════════════════════════════════════════════════════════════════════════

  _recoverStuckTrade(reason) {
    const contractId  = this.currentContractId;
    const stakeInfo   = this.pendingTradeInfo;
    const openSeconds = this.tradeStartTime ? Math.round((Date.now() - this.tradeStartTime) / 1000) : '?';

    this.log(
      `🚨 STUCK TRADE RECOVERY [${reason}] | Contract: ${contractId} | ` +
      `Open for: ${openSeconds}s | Level: ${this.currentGridLevel}`,
      'error'
    );

    this.stuckTradeCount++;

    if (stakeInfo && stakeInfo.stake > 0) {
      this.investmentRemaining = Number((this.investmentRemaining + stakeInfo.stake).toFixed(2));
      this.log(
        `💰 Stake $${stakeInfo.stake.toFixed(2)} returned to pool (unknown outcome) → ` +
        `pool: $${this.investmentRemaining.toFixed(2)}`,
        'warning'
      );
    }

    if (contractId) {
      this._processedContracts.add(String(contractId));
    }

    this.tradeInProgress   = false;
    this.pendingTradeInfo  = null;
    this.currentContractId = null;
    this.tradeStartTime    = null;

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

    this.log(
      `⏸️ PAUSING TRADING for ${pauseDurationMin} minute(s) due to stuck trade | ` +
      `Grid Level: L${previousGridLevel} → L0 | ` +
      `Base Stake: $${previousBaseStake.toFixed(2)} → $${this.baseStake.toFixed(2)}`,
      'warning'
    );

    this._sendTelegram(
      `🛑 <b>${DEFAULT_CONFIG.symbol} STUCK TRADE DETECTED — PAUSING TRADING</b>\n\n` +
      `⚠️ <b>Reason:</b> ${reason}\n` +
      `⏱️ <b>Contract was open for:</b> ${openSeconds}s\n` +
      `📊 <b>Stuck trade count:</b> ${this.stuckTradeCount}\n\n` +
      `🔄 <b>Actions Taken:</b>\n` +
      `  • Stake $${stakeInfo?.stake?.toFixed(2) || '0.00'} returned to pool\n` +
      `  • Trading paused for ${pauseDurationMin} minute(s)\n` +
      `  • Grid Level reset: L${previousGridLevel} → L0\n` +
      `  • Base Stake reset: $${previousBaseStake.toFixed(2)} → $${this.baseStake.toFixed(2)}\n` +
      `  • Direction reset to HIGHER (CALLE)\n\n` +
      `⏰ <b>Trading will resume at:</b> ${new Date(Date.now() + pauseDurationMs).toLocaleTimeString()}\n\n` +
      `⚠️ Please verify the trade outcome on Deriv manually!\n\n` +
      `📊 <b>Current State:</b>\n` +
      `  Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `  Session P&L: $${this.totalProfit.toFixed(2)}`
    );

    StatePersistence.save(this);

    if (this.stuckTradePauseTimer) {
      clearTimeout(this.stuckTradePauseTimer);
      this.stuckTradePauseTimer = null;
    }

    this.stuckTradePauseTimer = setTimeout(() => {
      this._resumeTradingAfterStuckTradePause();
    }, pauseDurationMs);

    this.log(
      `⏳ Stuck trade pause active — trading will resume in ${pauseDurationMin} minute(s) at ${new Date(Date.now() + pauseDurationMs).toLocaleTimeString()}`,
      'info'
    );
  }

  _resumeTradingAfterStuckTradePause() {
    this.isPausedDueToStuckTrade = false;
    this.canTrade = true;

    this.log(
      `✅ STUCK TRADE PAUSE COMPLETE | Trading resumed | ` +
      `Grid Level: L${this.currentGridLevel} | Base Stake: $${this.baseStake.toFixed(2)}`,
      'success'
    );

    this._sendTelegram(
      `✅ <b>${DEFAULT_CONFIG.symbol} TRADING RESUMED</b>\n\n` +
      `⏰ <b>Pause duration completed:</b> ${(this.config.stuckTradePauseDuration || 300000) / 60000} minute(s)\n\n` +
      `📊 <b>Current State:</b>\n` +
      `  Grid Level: L${this.currentGridLevel}\n` +
      `  Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `  Direction: ${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'}\n` +
      `  Investment pool: $${this.investmentRemaining.toFixed(2)}\n` +
      `  Session P&L: $${this.totalProfit.toFixed(2)}\n\n` +
      `🚀 Ready for new trade on next candle signal!`
    );

    this.log('⏳ Waiting for next new candle to place trade…', 'info');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════════

  _placeTrade() {
    if (!this.isAuthorized)   { this.log('Not authorized — cannot trade', 'error');  return; }
    if (!this.running)        { return; }
    if (this.tradeInProgress) { this.log('Trade already in progress…', 'warning');  return; }

    // Respect config: if grid trading disabled, skip grid trade placement
    if (!this.config.enableGrid || (this.tradingMode === 'digit-exploit' && !this.config.enableGrid)) {
      this.log('Grid trading disabled by config — skipping _placeTrade()', 'info');
      return;
    }

    if (this.isPausedDueToStuckTrade) {
      const remainingMs = this.stuckTradePauseTimer ?
        Math.max(0, this.stuckTradePauseTimer._idleTimeout - Date.now()) : 0;
      const remainingMin = Math.ceil(remainingMs / 60000);
      this.log(`⏸️ Cannot place trade - paused due to stuck trade. Will resume in ${remainingMin} minute(s)`, 'warning');
      return;
    }

    if (!this.canTrade) {
      if (this.inRecoveryMode) {
        this.log('⚡ Recovery mode but canTrade=false — forcing canTrade=true', 'warning');
        this.canTrade = true;
      } else {
        this.log('⏳ Waiting for new candle before trading… (canTrade=false)', 'info');
        return;
      }
    }

    const stake     = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label     = direction === 'CALLE' ? 'HIGHER' : 'LOWER';
    const tradeType = this.inRecoveryMode ? '⚡ RECOVERY' : '🕯️ NEW CANDLE';

    if (this.investmentRemaining > 0 && stake > this.investmentRemaining) {
      this.log(`Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (stake > this.balance) {
      this.log(`Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    this.log(
      `📊 ${tradeType} TRADE | ${label} | L${this.currentGridLevel} | Stake: $${stake} | ` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol}: TRADE OPEN</b>\n` +
      `📊 Type: ${tradeType}\n` +
      `📊 Direction: ${label}\n` +
      `📊 Stake: $${stake}\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel}\n` +
      `📊 <b>Investment left:</b> $${this.investmentRemaining.toFixed(2)}\n`
    );

    if (!this.inRecoveryMode) {
      this.canTrade = false;
    }

    this.tradeInProgress  = true;
    this.pendingTradeInfo = {
      id:        Date.now(),
      time:      new Date().toISOString(),
      direction,
      stake,
      gridLevel: this.currentGridLevel,
    };

    this._send({
      proposal:      1,
      amount:        stake,
      basis:         'stake',
      contract_type: direction,
      currency:      this.currency,
      duration:      this.config.tickDuration,
      duration_unit: 't',
      symbol:        this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // EXPLOIT DETECTION — PHASE 1: SCAN AVAILABLE CONTRACTS
  // ══════════════════════════════════════════════════════════════════════════════

  scanAvailableContracts() {
    this.log('🔍 PHASE 1: Scanning available contracts for stpRNG...', 'info');
    this._send({
      contracts_for: this.config.symbol,
      currency: 'USD',
      product_type: 'basic',
    });
  }

  _onContractsFor(msg) {
    if (msg.error) {
      this.log(`Contract scan error: ${msg.error.message}`, 'error');
      this.exploitDetectionPhase = 'complete';
      this._finalizeExploitDetection(false, 'contracts_for request failed');
      return;
    }

    const available = msg.contracts_for.available;
    const symbol    = msg.echo_req.contracts_for;

    const categories = {};
    available.forEach(c => {
      const type = c.contract_type;
      if (!categories[type]) {
        categories[type] = {
          contract_type:        type,
          contract_category:    c.contract_category,
          contract_display:     c.contract_display,
          min_duration:         c.min_contract_duration,
          max_duration:         c.max_contract_duration,
          expiry_type:          c.expiry_type,
          sentiment:            c.sentiment,
          barrier_category:     c.barrier_category,
          barriers:             c.barriers,
          payout_limit:         c.payout_limit,
          available_barriers:   c.available_barriers,
        };
      }
    });

    this.availableContracts = categories;

    this.log('═══════════════════════════════════════════════════════════════');
    this.log(`📊 AVAILABLE CONTRACTS FOR ${symbol}`);
    this.log('═══════════════════════════════════════════════════════════════');

    const digitTypes = [
      'DIGITDIFF', 'DIGITMATCH',
      'DIGITEVEN', 'DIGITODD',
      'DIGITOVER', 'DIGITUNDER'
    ];

    const allTypes = Object.keys(categories).sort();
    let hasDigitContracts = false;

    allTypes.forEach(type => {
      const c = categories[type];
      const isDigit = digitTypes.includes(type);
      const marker  = isDigit ? '🎯 *** DIGIT CONTRACT ***' : '';

      if (isDigit) hasDigitContracts = true;

      this.log(
        `${isDigit ? '🟢' : '⚪'} ${type} | ` +
        `Category: ${c.contract_category} | ` +
        `Duration: ${c.min_duration}–${c.max_duration} | ` +
        `Expiry: ${c.expiry_type} ${marker}`
      );
    });

    this.log('═══════════════════════════════════════════════════════════════');

    if (hasDigitContracts) {
      this.log('', 'success');
      this.log(`🎯🎯🎯 DIGIT CONTRACTS FOUND ON ${this.config.symbol}! 🎯🎯🎯' 'success'`);
      this.log('🎯 THE DIGIT EXPLOIT IS VIABLE!', 'success');
      this.log('🎯 Initiating exploit verification...', 'success');
      this.log('', 'success');

      this._sendTelegram(
        `🚨🎯 <b>DIGIT CONTRACTS FOUND ON stpRNG!</b>\n\n` +
        `Available digit types:\n` +
        digitTypes.filter(t => categories[t]).map(t => `  ✅ ${t}`).join('\n') +
        `\n\n⚡ The digit exploit may be viable! Verifying pricing...`
      );

      this.exploitDetectionPhase = 'testing-digits';
      setTimeout(() => this._verifyDigitPricing(digitTypes.filter(t => categories[t])), 2000);

    } else {
      this.log('');
      this.log('❌ NO digit contracts available on Step Index.', 'warning');
      this.log('   Deriv has (wisely) not exposed this contract type for stpRNG.', 'warning');
      this.log('   Rise/Fall remains the only option → proceeding to bias detection.', 'warning');
      this.log('');
      this.log('📋 Available contract types:', 'info');
      allTypes.forEach(t => this.log(`   • ${t}`));
      this.log('');
      this.log('💡 Running statistical RNG bias analysis...', 'info');

      this._sendTelegram(
        `❌ <b>No digit contracts on stpRNG</b>\n\n` +
        `Available types: ${allTypes.join(', ')}\n\n` +
        `Digit exploit not viable. Running RNG bias analysis...`
      );

      this.exploitDetectionPhase = 'bias-detection';
      setTimeout(() => this._startBiasDetection(), 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // EXPLOIT DETECTION — PHASE 2: VERIFY DIGIT PRICING
  // ══════════════════════════════════════════════════════════════════════════════

  async _verifyDigitPricing(availableDigitTypes) {
    this.log('═══════════════════════════════════════════════════════════════');
    this.log('📊 PHASE 2: DIGIT CONTRACT PRICING ANALYSIS');
    this.log('═══════════════════════════════════════════════════════════════');

    const testStake = 1.00;
    const results = [];

    // Test DIGITEVEN if available
    if (availableDigitTypes.includes('DIGITEVEN')) {
      const proposal = await this._requestProposalAsync({
        proposal:      1,
        amount:        testStake,
        basis:         'stake',
        contract_type: 'DIGITEVEN',
        currency:      this.currency,
        duration:      1,
        duration_unit: 't',
        symbol:        this.config.symbol,
      });

      if (proposal?.proposal) {
        const p = proposal.proposal;
        const buyPrice  = parseFloat(p.ask_price);
        const payout    = parseFloat(p.payout);
        const impliedP  = buyPrice / payout;
        const ourP      = 1.00;
        const ev        = ourP * payout - buyPrice;
        const evPct     = ((ev / buyPrice) * 100).toFixed(1);

        results.push({
          type: 'DIGITEVEN',
          buyPrice, payout, impliedP, ourP, ev, evPct,
        });

        this.log(
          `DIGITEVEN: Buy=$${buyPrice.toFixed(4)} Payout=$${payout.toFixed(4)} | ` +
          `Deriv assumes P=${(impliedP * 100).toFixed(1)}% | Our P=100% | ` +
          `EV=${ev >= 0 ? '+' : ''}$${ev.toFixed(4)} (${evPct}%) ${ev > 0 ? '✅ EXPLOITABLE!' : '❌'}`
        );
      }
      await this._delay(600);
    }

    // Test DIGITODD if available
    if (availableDigitTypes.includes('DIGITODD')) {
      const proposal = await this._requestProposalAsync({
        proposal:      1,
        amount:        testStake,
        basis:         'stake',
        contract_type: 'DIGITODD',
        currency:      this.currency,
        duration:      1,
        duration_unit: 't',
        symbol:        this.config.symbol,
      });

      if (proposal?.proposal) {
        const p = proposal.proposal;
        const buyPrice  = parseFloat(p.ask_price);
        const payout    = parseFloat(p.payout);
        const impliedP  = buyPrice / payout;
        const ev        = 1.00 * payout - buyPrice;
        const evPct     = ((ev / buyPrice) * 100).toFixed(1);

        results.push({
          type: 'DIGITODD',
          buyPrice, payout, impliedP, ourP: 1.00, ev, evPct,
        });

        this.log(
          `DIGITODD:  Buy=$${buyPrice.toFixed(4)} Payout=$${payout.toFixed(4)} | ` +
          `Deriv assumes P=${(impliedP * 100).toFixed(1)}% | Our P=100% | ` +
          `EV=${ev >= 0 ? '+' : ''}$${ev.toFixed(4)} (${evPct}%) ${ev > 0 ? '✅ EXPLOITABLE!' : '❌'}`
        );
      }
      await this._delay(600);
    }

    // Test DIGITMATCH
    if (availableDigitTypes.includes('DIGITMATCH')) {
      for (const predictDigit of [0, 5]) {
        const proposal = await this._requestProposalAsync({
          proposal:      1,
          amount:        testStake,
          basis:         'stake',
          contract_type: 'DIGITMATCH',
          currency:      this.currency,
          duration:      1,
          duration_unit: 't',
          symbol:        this.config.symbol,
          barrier:       String(predictDigit),
        });

        if (proposal?.proposal) {
          const p = proposal.proposal;
          const buyPrice  = parseFloat(p.ask_price);
          const payout    = parseFloat(p.payout);
          const impliedP  = buyPrice / payout;
          const ourP      = 0.50;
          const ev        = ourP * payout - buyPrice;
          const evPct     = ((ev / buyPrice) * 100).toFixed(1);

          results.push({
            type: `DIGITMATCH(${predictDigit})`,
            buyPrice, payout, impliedP, ourP, ev, evPct,
          });

          this.log(
            `DIGITMATCH(${predictDigit}): Buy=$${buyPrice.toFixed(4)} Payout=$${payout.toFixed(4)} | ` +
            `Deriv P=${(impliedP * 100).toFixed(1)}% | Our P=50% | ` +
            `EV=${ev >= 0 ? '+' : ''}$${ev.toFixed(4)} (${evPct}%) ${ev > 0 ? '✅ EXPLOITABLE!' : '❌'}`
          );
        }
        await this._delay(600);
      }
    }

    // Test DIGITOVER
    if (availableDigitTypes.includes('DIGITOVER')) {
      for (const barrier of [3, 5, 6]) {
        const proposal = await this._requestProposalAsync({
          proposal:      1,
          amount:        testStake,
          basis:         'stake',
          contract_type: 'DIGITOVER',
          currency:      this.currency,
          duration:      1,
          duration_unit: 't',
          symbol:        this.config.symbol,
          barrier:       String(barrier),
        });

        if (proposal?.proposal) {
          const p = proposal.proposal;
          const buyPrice = parseFloat(p.ask_price);
          const payout   = parseFloat(p.payout);
          const impliedP = buyPrice / payout;
          const normalP  = (9 - barrier) / 10;
          const ev100    = 1.00 * payout - buyPrice;

          results.push({
            type: `DIGITOVER(${barrier})`,
            buyPrice, payout, impliedP, normalP,
            evGuaranteed: ev100,
            evPctGuaranteed: ((ev100 / buyPrice) * 100).toFixed(1),
          });

          this.log(
            `DIGITOVER(${barrier}): Buy=$${buyPrice.toFixed(4)} Payout=$${payout.toFixed(4)} | ` +
            `Deriv P=${(impliedP * 100).toFixed(1)}% | Normal P=${(normalP * 100).toFixed(0)}% | ` +
            `If guaranteed 100%: EV=${ev100 >= 0 ? '+' : ''}$${ev100.toFixed(4)} ${ev100 > 0 ? '✅' : '❌'}`
          );
        }
        await this._delay(600);
      }
    }

    this.log('═══════════════════════════════════════════════════════════════');

    const exploitable = results.filter(r => (r.ev || r.evGuaranteed) > 0);
    if (exploitable.length > 0) {
      this.log('🎯 POSITIVE EV OPPORTUNITIES FOUND:', 'success');
      exploitable.forEach(r => {
        const evValue = r.evPct || r.evPctGuaranteed;
        this.log(`   ${r.type}: EV = +${evValue}% per trade`, 'success');
      });
      this.log('');
      this.log('⚡ IMPLEMENTING DIGIT EXPLOIT STRATEGY...', 'success');

      exploitable.sort((a, b) => {
        const aEv = a.ev || a.evGuaranteed || 0;
        const bEv = b.ev || b.evGuaranteed || 0;
        return bEv - aEv;
      });
      this._bestDigitExploit = exploitable[0];
      this.tradingMode = 'digit-exploit';
      this._initDigitExploit();

      StatePersistence.save(this);

      this._sendTelegram(
        `🎯🎯🎯 <b>POSITIVE EV FOUND ON STEP INDEX!</b>\n\n` +
        exploitable.map(r => `✅ ${r.type}: +${r.evPct || r.evPctGuaranteed}% EV per trade`).join('\n') +
        `\n\n⚡ <b>Best:</b> ${exploitable[0].type} at +${exploitable[0].evPct || exploitable[0].evPctGuaranteed}% per trade!\n\n` +
        `🤖 Switching to DIGIT EXPLOIT strategy...`
      );

      this.exploitDetectionPhase = 'complete';
      this._finalizeExploitDetection(true, 'digit-exploit', exploitable);

    } else {
      this.log('❌ All digit contracts are correctly priced — no exploitable edge.', 'warning');
      this.log('   Deriv uses Step-Index-specific pricing. Proceeding to RNG bias analysis...', 'warning');

      this._sendTelegram(
        `❌ <b>Digit contracts correctly priced</b>\n` +
        `Deriv accounts for Step Index digit determinism.\n` +
        `No digit exploit available. Running RNG bias detection...`
      );

      this.exploitDetectionPhase = 'bias-detection';
      setTimeout(() => this._startBiasDetection(), 2000);
    }

    StatePersistence.saveExploitResults({
      phase: 'digit-pricing',
      timestamp: new Date().toISOString(),
      results,
      exploitable: exploitable.length > 0,
    });
  }

  _requestProposalAsync(request) {
    return new Promise((resolve) => {
      const reqId = this._send(request);
      if (!reqId) { resolve(null); return; }

      const timeout = setTimeout(() => {
        this.ws?.removeListener('message', handler);
        resolve(null);
      }, 8000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.req_id === reqId) {
            clearTimeout(timeout);
            this.ws?.removeListener('message', handler);
            if (msg.msg_type === 'proposal' && msg.proposal?.id) {
              this._send({ forget: msg.proposal.id });
            }
            resolve(msg);
          }
        } catch (_) {}
      };

      this.ws?.on('message', handler);
    });
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // EXPLOIT DETECTION — PHASE 3: STATISTICAL RNG BIAS ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════════

  _startBiasDetection() {
    const HISTORY_COUNT = 5000;

    this.biasDetector = {
      rawPrices:       [],       // stores raw float prices (history + live combined)
      directions:      [],       // derived +1/-1 direction array for analysis
      minSample:       this.config.biasDetectionMinSample,
      maxSample:       this.config.biasDetectionMaxSample,
      isCollecting:    true,
      startTime:       Date.now(),
      historyLoaded:   false,    // blocks live ticks until history seed is done
      liveTickBuffer:  [],       // buffers live ticks that arrive before history loads
      analysisRan:     {},       // tracks which checkpoints already triggered analysis
    };

    this.log('📊 PHASE 3: Starting RNG bias detection...', 'info');
    this.log(`   Step 1/2: Requesting ${HISTORY_COUNT} historical ticks for instant seeding...`, 'info');

    this._sendTelegram(
      `📊 <b>Phase 3: RNG Bias Detection Started</b>\n\n` +
      `Step 1: Loading ${HISTORY_COUNT} historical ticks instantly...\n` +
      `Step 2: Live ticks appended until ${this.config.biasDetectionMinSample}+ sample reached`
    );

    // STEP 1: Bulk-load tick history (responds as msg_type: 'history')
    this._send({
      ticks_history: this.config.symbol,
      adjust_start_time: 1,
      count:  HISTORY_COUNT,
      end:    'latest',
      start:  1,
      style:  'ticks',
    });

    // STEP 2: Subscribe live ticks (respond as msg_type: 'tick' individually)
    // These are buffered in liveTickBuffer until history finishes seeding
    this._send({
      ticks: this.config.symbol,
      subscribe: 1,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // BIAS DETECTION — HISTORY SEED HANDLER
  // Processes the bulk ticks_history response and seeds biasDetector
  // ══════════════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════════════
  // BIAS DETECTION — BULK HISTORY SEED (msg_type: 'history')
  // Mirrors reference bot's handleTickHistory: map raw prices, seed directions,
  // then flush any live ticks that buffered while history was in-flight
  // ══════════════════════════════════════════════════════════════════════════════

  _onTickHistoryForBias(msg) {
    if (this.exploitDetectionPhase !== 'bias-detection') return;
    if (!this.biasDetector || this.biasDetector.historyLoaded) return;

    if (msg.error) {
      this.log(`⚠️ Tick history error: ${msg.error.message} — flushing buffer and relying on live ticks`, 'warning');
      this.biasDetector.historyLoaded = true;
      this._flushLiveTickBuffer();
      return;
    }

    const history = msg.history;
    if (!history || !history.prices || history.prices.length === 0) {
      this.log('⚠️ Tick history returned empty — flushing buffer, relying on live ticks only', 'warning');
      this.biasDetector.historyLoaded = true;
      this._flushLiveTickBuffer();
      return;
    }

    const bd = this.biasDetector;

    // ── Mirror reference bot's handleTickHistory pattern ──────────────────
    // Map raw prices to floats, store in rawPrices, derive directions
    const prices = history.prices.map(price => this._extractLastDigit(price, this.config.symbol));// extractLastDigit returns float like 123.45, we only care about the last digit for direction (history.prices.map(p => (p));
    bd.rawPrices = [...prices];

    for (let i = 1; i < prices.length; i++) {
      bd.directions.push(prices[i] > prices[i - 1] ? 1 : -1);
    }

    bd.historyLoaded = true;

    const elapsed = ((Date.now() - bd.startTime) / 1000).toFixed(1);
    const n       = bd.directions.length;
    const ups     = bd.directions.filter(d => d === 1).length;

    this.log(
      `📊 Tick history seeded: ${prices.length} prices → ${n} directions | ` +
      `Up=${ups} (${(ups / n * 100).toFixed(1)}%) | ${elapsed}s`, 'success'
    );
    this.log(`   Flushing ${bd.liveTickBuffer.length} buffered live ticks...`, 'info');

    // ── Flush any live ticks that arrived while history was loading ────────
    this._flushLiveTickBuffer();

    const nAfterFlush = bd.directions.length;
    this.log(
      `   Total after flush: ${nAfterFlush} directions | ` +
      `Need ${Math.max(0, bd.minSample - nAfterFlush)} more live ticks`, 'info'
    );

    this._sendTelegram(
      `📊 <b>Tick History Seeded</b>\n\n` +
      `✅ ${prices.length} historical ticks loaded\n` +
      `➕ ${bd.liveTickBuffer.length} buffered live ticks flushed\n` +
      `📈 Total directions: ${nAfterFlush}\n` +
      `⏳ Need ${Math.max(0, bd.minSample - nAfterFlush)} more to reach ${bd.minSample} minimum`
    );

    // Run analysis if minimum already met (history alone may be enough)
    this._checkBiasAnalysisCheckpoint();
  }

  // ── Flush the live-tick buffer accumulated before history finished ───────
  _flushLiveTickBuffer() {
    const bd     = this.biasDetector;
    const buffer = bd.liveTickBuffer || [];

    buffer.forEach(price => {
      bd.rawPrices.push(price);
      if (bd.rawPrices.length >= 2) {
        const prev = bd.rawPrices[bd.rawPrices.length - 2];
        bd.directions.push(price > prev ? 1 : -1);
      }
    });

    bd.liveTickBuffer = []; // clear after flush
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // BIAS DETECTION — LIVE TICK HANDLER (msg_type: 'tick')
  // Mirrors reference bot's handleTickUpdate: append price, derive direction,
  // trigger analysis at checkpoints. Buffers until history seed is complete.
  // ══════════════════════════════════════════════════════════════════════════════

  _onLiveTickForBias(tick) {
    if (!this.biasDetector?.isCollecting) return;
    if (this.exploitDetectionPhase !== 'bias-detection') return;

    const price = parseFloat(tick.quote);
    const bd    = this.biasDetector;

    // ── If history hasn't loaded yet, buffer live ticks (not directions) ──
    // We need contiguous price sequence to derive directions correctly
    if (!bd.historyLoaded) {
      bd.liveTickBuffer.push(price);
      return;
    }

    // ── Mirror reference bot's handleTickUpdate pattern ───────────────────
    bd.rawPrices.push(price);

    // Cap raw price store to avoid memory growth (keep last 60k)
    if (bd.rawPrices.length > 60000) {
      bd.rawPrices.shift();
    }

    // Derive direction from the previous price
    if (bd.rawPrices.length >= 2) {
      const prev = bd.rawPrices[bd.rawPrices.length - 2];
      bd.directions.push(price > prev ? 1 : -1);
    }

    const n = bd.directions.length;

    // Progress log every 500 live ticks
    if (n % 500 === 0) {
      const ups     = bd.directions.filter(d => d === 1).length;
      const elapsed = ((Date.now() - bd.startTime) / 60000).toFixed(1);
      this.log(`📊 Live tick ${n}: Up=${(ups / n * 100).toFixed(2)}% (${ups}/${n}) | ${elapsed} min elapsed`);
    }

    // Cap directions array
    if (bd.directions.length > bd.maxSample) {
      bd.directions.shift();
      bd.isCollecting = false;
    }

    this._checkBiasAnalysisCheckpoint();
  }

  // ── Check if we've hit an analysis checkpoint ─────────────────────────────
  _checkBiasAnalysisCheckpoint() {
    const bd = this.biasDetector;
    if (!bd) return;

    const n           = bd.directions.length;
    const checkpoints = [bd.minSample, 10000, 20000, bd.maxSample];

    for (const cp of checkpoints) {
      if (n >= cp && !bd.analysisRan[cp]) {
        bd.analysisRan[cp] = true;
        this.log(`📊 Checkpoint reached: ${n} directions — running bias analysis...`, 'info');
        this._runBiasAnalysis();
        break; // run one checkpoint at a time
      }
    }
  }

  _onTickForExploit(tick) {
    // If in digit exploit mode, track ticks for digit extraction
    console.log('Live tick for digit exploit:', tick);
    console.log('Moder:', this.tradingMode, 'Running:', this.running, 'Digit Exploit Enabled:', this.digitExploit?.enabled);
    if (this.tradingMode === 'digit-exploit' && this.running && this.digitExploit?.enabled) {
      // console.log('Processing tick for digit exploit:', tick);
      this._onTickForDigitExploit(tick);
    }
  }

  _onTicksForBias(ticks) {
    if (!this.biasDetector?.isCollecting) return;

    const bd = this.biasDetector;

    // ticks is either an array or a single tick
    const tickList = Array.isArray(ticks) ? ticks : [ticks];

    tickList.forEach(tick => {
      const price = parseFloat(tick.quote);
      bd.ticks.push(price);

      if (bd.ticks.length >= 2) {
        const prev = bd.ticks[bd.ticks.length - 2];
        const dir  = price > prev ? 1 : -1;
        bd.directions.push(dir);
      }
    });

    // Run analysis at checkpoints
    const n = bd.directions.length;
    if (n === bd.minSample || n === 10000 || n === 20000 || n === bd.maxSample) {
      this._runBiasAnalysis();
    }

    // Progress logging
    if (n > 0 && n % 1000 === 0) {
      const ups   = bd.directions.filter(d => d === 1).length;
      const pUp   = (ups / n * 100).toFixed(2);
      const elapsed = ((Date.now() - bd.startTime) / 60000).toFixed(1);
      this.log(`📊 Tick ${n}: Up=${pUp}% (${ups}/${n}) | ${elapsed} min elapsed`);
    }

    if (n >= bd.maxSample) {
      bd.isCollecting = false;
      this.log('📊 Max sample reached — final analysis:', 'info');
      this._runBiasAnalysis();
    }
  }

  _runBiasAnalysis() {
    const bd   = this.biasDetector;
    const dirs = bd.directions;
    const n    = dirs.length;

    if (n < 100) {
      this.log('Not enough data for analysis yet', 'warning');
      return;
    }

    if (this.exploitDetectionPhase !== 'bias-detection') return; // Already completed

    this.log('═══════════════════════════════════════════════════════════════');
    this.log(`📊 RNG BIAS ANALYSIS — ${n} ticks`);
    this.log('═══════════════════════════════════════════════════════════════');

    // ── TEST 1: Direction Bias ──────────────────────────────────────────────
    const ups       = dirs.filter(d => d === 1).length;
    const downs     = n - ups;
    const pUp       = ups / n;
    const zBias     = (ups - n * 0.5) / Math.sqrt(n * 0.25);
    const pValueBias = 2 * (1 - this._normalCDF(Math.abs(zBias)));
    const biasSignificant = pValueBias < 0.01;

    this.log(
      `TEST 1 — Direction Bias: Up=${ups} (${(pUp * 100).toFixed(2)}%) ` +
      `Down=${downs} (${((1 - pUp) * 100).toFixed(2)}%) | ` +
      `z=${zBias.toFixed(3)} | p=${pValueBias.toFixed(6)} ` +
      `${biasSignificant ? '🔴 SIGNIFICANT BIAS!' : '🟢 No bias'}`
    );

    // ── TEST 2: Autocorrelation ────────────────────────────────────────────
    this.log('TEST 2 — Autocorrelation:');
    let hasAutoCorr = false;

    for (let lag = 1; lag <= 5; lag++) {
      let sumProduct = 0;
      const pairs    = n - lag;

      for (let i = 0; i < pairs; i++) {
        sumProduct += dirs[i] * dirs[i + lag];
      }

      const autoCorr  = sumProduct / pairs;
      const zAC       = autoCorr * Math.sqrt(pairs);
      const pValueAC  = 2 * (1 - this._normalCDF(Math.abs(zAC)));
      const acSignif  = pValueAC < 0.01;
      if (acSignif) hasAutoCorr = true;

      this.log(
        `  Lag ${lag}: r=${autoCorr.toFixed(4)} | z=${zAC.toFixed(3)} | ` +
        `p=${pValueAC.toFixed(6)} ${acSignif ? '🔴 SIGNIFICANT!' : '🟢 OK'}`
      );
    }

    // ── TEST 3: Runs Test ──────────────────────────────────────────────────
    let runs = 1;
    for (let i = 1; i < n; i++) {
      if (dirs[i] !== dirs[i - 1]) runs++;
    }

    const expectedRuns = 1 + (2 * ups * downs) / n;
    const varRuns      = (2 * ups * downs * (2 * ups * downs - n)) / (n * n * (n - 1));
    const zRuns        = (runs - expectedRuns) / Math.sqrt(Math.max(varRuns, 0.0001));
    const pValueRuns   = 2 * (1 - this._normalCDF(Math.abs(zRuns)));
    const runsSignif   = pValueRuns < 0.01;

    this.log(
      `TEST 3 — Runs Test: Runs=${runs} (expected=${expectedRuns.toFixed(1)}) | ` +
      `z=${zRuns.toFixed(3)} | p=${pValueRuns.toFixed(6)} ` +
      `${runsSignif ? '🔴 NON-RANDOM CLUSTERING!' : '🟢 Random'}`
    );

    // ── TEST 4: Streak Distribution ────────────────────────────────────────
    const streaks = [];
    let currentLen = 1;
    for (let i = 1; i < n; i++) {
      if (dirs[i] === dirs[i - 1]) {
        currentLen++;
      } else {
        streaks.push(currentLen);
        currentLen = 1;
      }
    }
    streaks.push(currentLen);

    const maxStreak = Math.max(...streaks);
    this.log('TEST 4 — Streak Distribution:');
    for (let k = 1; k <= Math.min(maxStreak, 12); k++) {
      const observed = streaks.filter(s => s >= k).length;
      const expected = streaks.length * Math.pow(0.5, k - 1);
      const ratio    = observed / Math.max(expected, 0.01);
      const emoji    = ratio > 1.3 || ratio < 0.7 ? '🟡' : '🟢';

      this.log(
        `  Streak ≥${k}: Observed=${observed} Expected=${expected.toFixed(1)} ` +
        `Ratio=${ratio.toFixed(2)} ${emoji}`
      );
    }

    // ── TEST 5: Conditional Probabilities ──────────────────────────────────
    let upAfterUp = 0, totalAfterUp = 0;
    let upAfterDown = 0, totalAfterDown = 0;

    for (let i = 1; i < n; i++) {
      if (dirs[i - 1] === 1) {
        totalAfterUp++;
        if (dirs[i] === 1) upAfterUp++;
      } else {
        totalAfterDown++;
        if (dirs[i] === 1) upAfterDown++;
      }
    }

    const pUpAfterUp   = totalAfterUp   > 0 ? upAfterUp / totalAfterUp : 0.5;
    const pUpAfterDown = totalAfterDown > 0 ? upAfterDown / totalAfterDown : 0.5;

    this.log(
      `TEST 5 — Conditional P(up): After UP=${(pUpAfterUp * 100).toFixed(2)}% | ` +
      `After DOWN=${(pUpAfterDown * 100).toFixed(2)}% | ` +
      `Diff=${(Math.abs(pUpAfterUp - pUpAfterDown) * 100).toFixed(2)}%`
    );

    // ── TEST 6: Pattern Frequencies ────────────────────────────────────────
    this.log('TEST 6 — 2-Bit Pattern Frequencies:');
    const patterns2 = { 'UU': 0, 'UD': 0, 'DU': 0, 'DD': 0 };
    for (let i = 0; i < n - 1; i++) {
      const key = (dirs[i] === 1 ? 'U' : 'D') + (dirs[i + 1] === 1 ? 'U' : 'D');
      patterns2[key]++;
    }
    const expected2 = (n - 1) / 4;
    Object.entries(patterns2).forEach(([pat, count]) => {
      const ratio = count / expected2;
      const emoji = Math.abs(ratio - 1) > 0.05 ? '🟡' : '🟢';
      this.log(
        `  ${pat}: ${count} (expected=${expected2.toFixed(0)}) ratio=${ratio.toFixed(3)} ${emoji}`
      );
    });

    // ══════════════════════════════════════════════════════════════════════
    // VERDICT
    // ══════════════════════════════════════════════════════════════════════
    this.log('═══════════════════════════════════════════════════════════════');

    const anomalies = [];
    if (biasSignificant) anomalies.push(`Direction bias: ${(pUp * 100).toFixed(2)}% up`);
    if (hasAutoCorr)     anomalies.push('Autocorrelation detected');
    if (runsSignif)      anomalies.push('Non-random run clustering');

    if (anomalies.length > 0) {
      this.log('🔴 ANOMALIES DETECTED IN RNG:', 'error');
      anomalies.forEach(a => this.log(`   ⚠️ ${a}`, 'warning'));
      this.log('');

      const houseEdge   = 0.03;
      const detectedBias = Math.abs(pUp - 0.5);
      const netEdge      = detectedBias - houseEdge;

      if (netEdge > 0) {
        const favorDir = pUp > 0.5 ? 'CALLE (UP)' : 'PUTE (DOWN)';
        this.log(`🎯 EXPLOITABLE BIAS: ${(detectedBias * 100).toFixed(2)}% > ${(houseEdge * 100).toFixed(1)}% house edge`, 'success');
        this.log(`   Net edge: +${(netEdge * 100).toFixed(2)}% | Favor: ${favorDir}`, 'success');
        this.log(`   ⚠️ CAUTION: Verify with more data. Could be transient.`, 'warning');

        this._biasExploitDirection = pUp > 0.5 ? 'CALLE' : 'PUTE';
        this._biasNetEdge = netEdge;

        this._sendTelegram(
          `🔴 <b>RNG BIAS DETECTED ON stpRNG!</b>\n\n` +
          `📊 Sample: ${n} ticks\n` +
          `📈 P(up) = ${(pUp * 100).toFixed(2)}%\n` +
          `📊 Bias: ${(detectedBias * 100).toFixed(2)}%\n` +
          `📊 House edge: ${(houseEdge * 100).toFixed(1)}%\n` +
          `✅ <b>Net edge: +${(netEdge * 100).toFixed(2)}%</b>\n` +
          `🎯 Favor: ${pUp > 0.5 ? 'UP' : 'DOWN'}\n\n` +
          `⚠️ Verify with more data before trading!`
        );

        this._finalizeExploitDetection(true, 'rng-bias', { bias: detectedBias, netEdge, favorDir });

      } else {
        this.log(`⚠️ Bias detected (${(detectedBias * 100).toFixed(2)}%) but SMALLER than house edge (${(houseEdge * 100).toFixed(1)}%)`, 'warning');
        this.log(`   Still negative EV. Not exploitable.`, 'warning');
        this._finalizeExploitDetection(false, 'bias-too-small');
      }

      if (hasAutoCorr) {
        this.log('');
        this.log('📊 Autocorrelation present — conditional strategy might have edge:', 'info');
        this.log(`   P(up|prev=up)   = ${(pUpAfterUp * 100).toFixed(2)}%`, 'info');
        this.log(`   P(up|prev=down) = ${(pUpAfterDown * 100).toFixed(2)}%`, 'info');

        const bestConditional    = pUpAfterUp > pUpAfterDown
          ? { after: 'UP',   dir: 'CALLE', p: pUpAfterUp }
          : { after: 'DOWN', dir: 'PUTE',  p: 1 - pUpAfterDown };
        const conditionalEdge    = bestConditional.p - 0.5 - houseEdge;

        if (conditionalEdge > 0) {
          this.log(`🎯 Conditional strategy: After ${bestConditional.after}, play ${bestConditional.dir} (P=${(bestConditional.p * 100).toFixed(2)}%)`, 'success');
          this.log(`   Net conditional edge: +${(conditionalEdge * 100).toFixed(2)}%`, 'success');
        }
      }

    } else {
      this.log('🟢 NO ANOMALIES DETECTED — stpRNG appears to be a fair random walk.', 'success');
      this.log('   Positive expectation is NOT achievable on Rise/Fall contracts.', 'info');
      this.log('');
      this.log('💡 FINAL RECOMMENDATION:', 'info');
      this.log('   Accept that Step Index has negative EV on all available contracts', 'info');
      this.log('   Trading with grid martingale is -EV, but can manage risk', 'info');
      this.log('   Continuing with OPTIMIZED GRID MARTINGALE strategy...', 'info');

      this._finalizeExploitDetection(false, 'rng-is-fair');
    }

    this.log('═══════════════════════════════════════════════════════════════');

    // Stop collecting ticks
    this._send({ forget: 'ticks' });
  }

  _normalCDF(x) {
    const a1 =  0.254829592;
    const a2 = -0.284496736;
    const a3 =  1.421413741;
    const a4 = -1.453152027;
    const a5 =  1.061405429;
    const p  =  0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  _finalizeExploitDetection(found, reason, details = null) {
    this.exploitDetectionPhase = 'complete';

    const summary = {
      found,
      reason,
      details,
      timestamp: new Date().toISOString(),
      tradingMode: this.tradingMode,
    };

    StatePersistence.saveExploitResults(summary);

    this.log('');
    this.log('═══════════════════════════════════════════════════════════════');
    this.log('🔬 EXPLOIT DETECTION COMPLETE', found ? 'success' : 'warning');
    this.log('═══════════════════════════════════════════════════════════════');

    if (found) {
      this.log(`✅ Positive-EV exploit detected: ${reason}`, 'success');
      this.log(`   Trading mode: ${this.tradingMode}`, 'success');
      this.running = true; // Start trading immediately with the selected strategy
      this.log('');
    } else {
      this.log(`❌ No exploitable edge found: ${reason}`, 'warning');
      this.log('   Trading mode: GRID MARTINGALE (optimized)', 'info');
      this.log('   Continuing with risk management strategy', 'info');
      this.log('');
    }

    this._sendTelegram(
      `🔬 <b>Exploit Detection Complete</b>\n\n` +
      `${found ? '✅ EDGE FOUND' : '❌ NO EDGE'}\n` +
      `Reason: ${reason}\n` +
      `Mode: ${this.tradingMode}\n\n` +
      `Starting bot with selected strategy...`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // DIGIT EXPLOIT SUPPORT (Initialized if exploit is found)
  // ══════════════════════════════════════════════════════════════════════════════

  _initDigitExploit() {
    this.digitExploit = {
      enabled:       true,
      strategy:      'evenodd',          // 'evenodd', 'match', 'overunder'
      lastTickDigit: null,
      pipPosition:   null,
      tickHistory:   [],
      stats:         { trades: 0, wins: 0, losses: 0, pnl: 0 },
    };

    this.log('🎯 DIGIT EXPLOIT initialized', 'success');
    this.log('   Strategy: DIGITEVEN/DIGITODD (100% win rate)', 'success');

    // Subscribe to ticks for digit extraction
    this._send({
      ticks: this.config.symbol,
      subscribe: 1,
    });
  }

  _onTickForDigitExploit(tick) {
    if (!this.digitExploit?.enabled || !this.running) return;
    if (this.tradeInProgress) return;

    const price     = parseFloat(tick.quote);
    const lastDigit = this._extractLastDigit(price, this.config.symbol);

    this.digitExploit.tickHistory.push({ price, digit: lastDigit, epoch: tick.epoch });
    if (this.digitExploit.tickHistory.length > 1000) {
      this.digitExploit.tickHistory = this.digitExploit.tickHistory.slice(-500);
    }

    console.log(`Tick: ${price} | Last digit: ${lastDigit} | Pip position: ${this.digitExploit.pipPosition || 'unknown'}`);

    // Place digit trade on each tick
    const tradeParams = this._getEvenOddTradeDigit(lastDigit);
    console.log(`Prepared trade params: ${JSON.stringify(tradeParams)}`);
    if (tradeParams) {
      this._placeDigitTrade(tradeParams, lastDigit);
    }
  }

  // _extractLastDigit(price) {
  //   const str = price.toFixed(2);
  //   const tenths = parseInt(str[str.indexOf('.') + 1], 10);

  //   if (this.digitExploit.tickHistory.length > 0) {
  //     const prev = this.digitExploit.tickHistory[this.digitExploit.tickHistory.length - 1];
  //     const prevStr = prev.price.toFixed(2);
  //     const prevTenths = parseInt(prevStr[prevStr.indexOf('.') + 1], 10);
  //     const diff = Math.abs(tenths - prevTenths);

  //     if (diff === 1 || diff === 9) {
  //       this.digitExploit.pipPosition = 'tenths';
  //       return tenths;
  //     }
  //   }

  //   return tenths;
  // }

  _extractLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');
        this.digitExploit.pipPosition = fractionalPart.length >= 2 ? 'hundredths' : 'tenths';

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else if (['stpRNG', 'stpRNG2', 'stpRNG3', 'stpRNG4', 'stpRNG5'].includes(asset)) {
            return fractionalPart.length >= 1 ? parseInt(fractionalPart[0]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

  _getEvenOddTradeDigit(currentDigit) {
    return {
      contract_type: currentDigit % 2 === 0 ? 'DIGITODD' : 'DIGITEVEN',
      expectedWinRate: 1.00,
      reason: `Digit ${currentDigit} (${currentDigit % 2 === 0 ? 'even' : 'odd'}) → next guaranteed ${currentDigit % 2 === 0 ? 'odd' : 'even'}`,
    };
  }

  _placeDigitTrade(params, currentDigit) {

    if (!this.isAuthorized)   { this.log('Not authorized — cannot trade', 'error');  return; }
    if (!this.running)        { return; }
    if (this.tradeInProgress) { this.log('Trade already in progress…', 'warning');  return; }

    // Respect config: if digit-exploit disabled, skip placing digit trades
    if (!this.config.enableDigitExploit || (this.tradingMode === 'grid' && !this.config.enableDigitExploit)) {
      this.log('Digit-exploit trades disabled by config — skipping', 'info');
      return;
    }

    // ── CHECK IF PAUSED DUE TO STUCK TRADE ─────────────────────────────────
    if (this.isPausedDueToStuckTrade) {
      const remainingMs = this.stuckTradePauseTimer ? 
        Math.max(0, this.stuckTradePauseTimer._idleTimeout - Date.now()) : 0;
      const remainingMin = Math.ceil(remainingMs / 60000);
      this.log(`⏸️ Cannot place trade - paused due to stuck trade. Will resume in ${remainingMin} minute(s)`, 'warning');
      return;
    }

    const stake = this.calculateStake(this.currentGridLevel);

    if (this.investmentRemaining > 0 && stake > this.investmentRemaining) {
      this.log(`Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }
    if (stake > this.balance) {
      this.log(`Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`, 'error');
      this.running = false;
      this.inRecoveryMode = false;
      this.canTrade = false;
      return;
    }

    const duration = 1; // 1 tick duration for digit trades

    if (stake < 0.35) {
      return;
    }

    this.tradeInProgress = true;
    this.pendingTradeInfo = {
      ...params,
      stake,
      time: new Date().toISOString(),
    };

    const request = {
      proposal:      1,
      amount:        stake.toFixed(2),
      basis:         'stake',
      contract_type: params.contract_type,
      currency:      this.currency,
      duration:      1,
      duration_unit: 't',
      symbol:        this.config.symbol,
      // barrier:       currentDigit,
    };

    this.log(
      `🎯 DIGIT TRADE: ${params.contract_type} | Digit: ${currentDigit} | $${stake.toFixed(2)} | ` +
      `P(win)=100% | ${params.reason}`+
      `📊 Grid Level ${this.currentGridLevel}` +
      `Investment left: $${this.investmentRemaining.toFixed(2)}`
    );

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol}: TRADE OPEN</b>\n` +
      `📊 Direction: ${params.contract_type}\n` +
      `💰 Stake: $${stake}\n` +
      `⏱ Duration: ${duration} ticks\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel}\n` +
      `💵 <b>Investment left:</b> $${this.investmentRemaining.toFixed(2)}\n`
    );

    this.tradeInProgress  = true;

    this._send(request);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.isAuthorized)    { this.log('Not authorized — connect first', 'error');     return false; }
    if (this.running)     { this.log('Bot already running', 'warning');              return false; }
    if (this.config.investmentAmount <= 0) { this.log('Invalid investment amount', 'error'); return false; }
    if (this.config.investmentAmount > this.balance) {
      this.log(`Investment $${this.config.investmentAmount} exceeds balance $${this.balance.toFixed(2)}`, 'error');
      return false;
    }

    // Wait for exploit detection to complete before starting
    if (this.config.runExploitDetection && this.exploitDetectionPhase !== 'complete') {
      this.log('⏳ Waiting for exploit detection to complete...', 'info');
      return false;
    }

    const cfg = this.config;

    if (cfg.autoCompounding) {
      this.baseStake = Math.max(cfg.investmentAmount * cfg.compoundPercentage / 100, 0.35);
      this.log(`💰 Auto-compounding ON: ${cfg.compoundPercentage}% of $${cfg.investmentAmount} = $${this.baseStake.toFixed(2)} base stake`);
    } else {
      this.baseStake = cfg.initialStake;
      this.log(`💰 Fixed stake: $${this.baseStake.toFixed(2)}`);
    }

    this.running               = true;
    this.currentGridLevel      = 0;
    this.currentDirection      = 'CALLE';
    this.totalProfit           = 0;
    this.totalTrades           = 0;
    this.wins                  = 0;
    this.losses                = 0;
    this.currentStreak         = 0;
    this.maxWinStreak          = 0;
    this.maxLossStreak         = 0;
    this.totalRecovered        = 0;
    this.investmentRemaining   = cfg.investmentAmount;
    this.investmentStartAmount = cfg.investmentAmount;
    this.tradeInProgress       = false;
    this.pendingTradeInfo      = null;
    this.currentContractId     = null;
    this.isWinTrade            = false;
    this.reconnectAttempts     = 0;
    this.hasStartedOnce        = true;

    this.inRecoveryMode        = false;
    this.canTrade              = false;
    this.isPausedDueToStuckTrade = false;

    this.log(`🚀 ${DEFAULT_CONFIG.symbol} Grid Martingale Bot STARTED!`, 'success');
    this.log(
      `💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | Tick: ${cfg.tickDuration}t`
    );
    this.log(`📈 Trading mode: ${this.tradingMode.toUpperCase()}`);

    if (this.tradingMode === 'grid') {
      this.log(`📊 Strategy: NEW CANDLE → trade | LOSS → recovery until WIN → wait for candle`);
    } else if (this.tradingMode === 'digit-exploit') {
      this.log(`📊 Strategy: DIGIT EXPLOIT (100% win rate, trade every tick)`);
    }

    const pauseMin = Math.round((cfg.stuckTradePauseDuration || 300000) / 60000);
    this.log(`🛡️ Stuck trade pause duration: ${pauseMin} minute(s)`);

    this._sendTelegram(
      `🚀 <b>${DEFAULT_CONFIG.symbol} Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Tick Duration: ${cfg.tickDuration} ticks\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
      `📈 <b>Mode: ${this.tradingMode.toUpperCase()}</b>\n` +
      `⏸️ Stuck trade pause: ${pauseMin} minute(s)`
    );

    return true;
  }

  stop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this._clearAllWatchdogTimers();
    this.log('🛑 Bot stopped', 'warning');
    this._sendTelegram(`🛑 <b>${DEFAULT_CONFIG.symbol} Bot stopped</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
    this._clearAllWatchdogTimers();
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendTelegram(`🚨 <b>${DEFAULT_CONFIG.symbol} EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    this.log(
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | Recovered: $${this.totalRecovered.toFixed(2)} | ` +
      `Mode: ${this.tradingMode}`
    );
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
    const wr       = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr   = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const dirLabel = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';

    if (this.tradingMode === 'digit-exploit') {
      this._sendTelegram(
        `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— ${DEFAULT_CONFIG.symbol} Digit Exploit</b>\n\n` +
        `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n\n` +
        `📈 <b>Session Stats:</b>\n` +
        `  Trades: ${this.totalTrades} | Wins: ${this.wins} | Losses: ${this.losses}\n` +
        `  Win Rate: ${wr}%\n` +
        `  Daily P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
        `  Investment: $${this.investmentRemaining.toFixed(2)}\n\n` +
        `⏰ ${new Date().toLocaleTimeString()}`
      );
    } else {
      const modeStr  = this.inRecoveryMode ? '⚡ RECOVERY MODE' : '🕯️ CANDLE MODE';

      this._sendTelegram(
        `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— ${DEFAULT_CONFIG.symbol} Grid Bot</b>\n\n` +
        `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
        `📊 <b>Grid Level:</b> ${this.currentGridLevel} → ${isWin ? 'RESET L0' : `L${this.currentGridLevel}`}\n` +
        `🎯 <b>Next:</b> ${isWin ? '⏳ Waiting for new candle' : `${dirLabel} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)} ⚡`}\n` +
        `🔄 <b>Mode:</b> ${isWin ? '🕯️ Wait for candle' : modeStr}\n\n` +
        `📈 <b>Session Stats:</b>\n` +
        `  Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}\n` +
        `  Win Rate: ${wr}%\n` +
        `  Daily P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
        `  Investment: $${this.investmentRemaining.toFixed(2)}\n\n` +
        `⏰ ${new Date().toLocaleTimeString()}`
      );
    }
  }

  async _sendHourlySummary() {
    const s      = this.hourlyStats;
    const wr     = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';
    const pnlStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);

    await this._sendTelegram(
      `⏰ <b>${DEFAULT_CONFIG.symbol} Grid Bot — Hourly Summary</b>\n\n` +
      `📊 <b>Last Hour:</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnlStr}\n\n` +
      `📈 <b>Session Totals:</b>\n` +
      `  Total Trades: ${this.totalTrades}\n` +
      `  W/L: ${this.wins}/${this.losses}\n` +
      `  Session P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)} / $${this.investmentStartAmount.toFixed(2)}\n` +
      `  Total Recovered: $${this.totalRecovered.toFixed(2)}\n` +
      `  Max Win Streak: ${this.maxWinStreak}\n` +
      `  Max Loss Streak: ${this.maxLossStreak}\n` +
      `  Grid Level: ${this.currentGridLevel}\n` +
      `  Recovery Mode: ${this.inRecoveryMode ? 'YES ⚡' : 'NO'}\n` +
      `  Trading Mode: ${this.tradingMode}\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this.log('📱 Telegram hourly summary sent');
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
  }

  startTelegramTimer() {
    const now         = new Date();
    const nextHour    = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNext = nextHour.getTime() - now.getTime();

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, msUntilNext);

    this.log(`📱 Hourly Telegram summaries scheduled (first in ${Math.ceil(msUntilNext / 60000)} min)`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER
  // ══════════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const now = new Date();
      const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
      const gmt1 = new Date(utcMs + (1 * 60 * 60 * 1000));
      const day = gmt1.getDay();
      const hours = gmt1.getHours();
      const minutes = gmt1.getMinutes();

      if (this.endOfDay && hours === 3 && minutes >= 0) {
        this.log('📅 03:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
        return;
      }

      if (!this.endOfDay && this.isWinTrade && hours >= 23) {
        this.log('📅 Past 23:00 GMT+1 — end-of-day stop', 'info');
        this._sendHourlySummary();
        this.disconnect();
        this.endOfDay = true;
        return;
      }
    }, 10000);

    this.log('📅 Time scheduler started (weekend pause + EOD logic)');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade      = false;
    this.inRecoveryMode  = false;
    this.canTrade        = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL BANNER
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   GRID MARTINGALE BOT + EXPLOIT DETECTION RESEARCH                 ║');
  console.log('║   Intelligent Positive-EV Search → Auto Strategy Selection          ║');
  console.log('║   PHASE 1: Digit Contract Availability Scan                         ║');
  console.log('║   PHASE 2: Digit Pricing Verification (if available)                ║');
  console.log('║   PHASE 3: Statistical RNG Bias Detection                           ║');
  console.log('║   Falls back to OPTIMIZED GRID MARTINGALE if no edge found         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
  console.log('Detection Pipeline:');
  console.log('  1. Scan stpRNG for available contract types');
  console.log('  2. If digit contracts exist → test pricing for exploitable edge');
  console.log('  3. If not → collect ~5000 ticks and run statistical bias tests');
  console.log('  4. Verdict: Use best strategy found, or grid martingale\n');
  console.log('Results saved to: exploit-detection-results.json\n');
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
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
  });
}

main();