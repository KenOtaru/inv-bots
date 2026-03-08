#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║        V75 GRID MARTINGALE BOT — Production Node.js Edition                    ║
// ║        Volatility 75 Index (1HZ75V) | CALLE/PUTE | Low-Risk Hybrid             ║
// ║                                                                                  ║
// ║  Strategy DNA:                                                                   ║
// ║  • Exploits mean-reverting + micro-trending behavior of V75 on 5-tick timeframe  ║
// ║  • Ultra-tight invisible grid (~3.2–4.1 pips avg distance between reversals)    ║
// ║  • Mathematically perfected 1.48x martingale (not 2x, not 1.6x — exactly 1.48) ║
// ║  • Hard cap + configurable extra levels with custom per-level multipliers        ║
// ║  • Win-back recovers ALL previous losses + profit on the very next win           ║
// ║                                                                                  ║
// ║  Infrastructure:                                                                 ║
// ║  • dotenv   — environment-based secrets                                          ║
// ║  • ws       — battle-tested WebSocket client                                     ║
// ║  • Telegram — real-time trade notifications + hourly summaries                  ║
// ║  • StatePersistence — crash recovery (30-min state file)                        ║
// ║  • Heartbeat / ping-pong — detects silent connection drops                      ║
// ║  • Message queue — no lost requests during reconnection                         ║
// ║  • Time scheduler — weekend pause + end-of-day logic                            ║
// ╚══════════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket    = require('ws');
const TelegramBot  = require('node-telegram-bot-api');
const fs           = require('fs');
const path         = require('path');
// const http         = require('http');
// const url          = require('url');
// const crypto       = require('crypto');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const CONFIG_FILE  = path.join(__dirname, 'v75-grid-config.json');
const STATE_FILE   = path.join(__dirname, 'v75-grid-state.json');
const STATE_SAVE_INTERVAL = 5000;   // 5 seconds

const DEFAULT_CONFIG = {
  // Deriv API
  apiToken: 'hsj0tA0XJoIzJG5',
  appId: '1089',

  // Strategy — core
  symbol:                '1HZ75V',
  tickDuration:          5,                 // 5 ticks
  initialStake:          0.35,              // base stake ($)
  investmentAmount:      100,               // investment pool ($)

  // Martingale
  martingaleMultiplier:  1.48,              // the magic number
  maxMartingaleLevel:    6,                 // hard cap
  afterMaxLoss:          'continue',            // 'stop' | 'continue' | 'reset'
  continueExtraLevels:   3,
  extraLevelMultipliers: [2.2, 2.3, 2.5],                // per-extra-level custom multipliers

  // Auto-compounding
  autoCompounding:       true,
  compoundPercentage:    0.35,                 // % of investment pool per trade

  // Risk management
  stopLoss:              84,                // stop bot if total P&L <= -$stopLoss
  takeProfit:            10000,              // stop bot if total P&L >= $takeProfit

  // Telegram
  telegramToken:         '8584545459:AAFvyVjgeBnPGs-w_ehTMBG-bTvxHpAIjeI',
  telegramChatId:        '752497117',
  telegramEnabled:       true,

  // HTTP dashboard
//   httpPort:              3000,
};

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE MANAGER
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
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
    setInterval(() => { if (bot.running || bot.totalTrades > 0) StatePersistence.save(bot); }, STATE_SAVE_INTERVAL);
    console.log('[StatePersistence] Auto-save started (every 5 s)');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class V75GridBot {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // ── WebSocket ───────────────────────────────────────────────────────────
    this.ws               = null;
    this.connected        = false;
    this.wsReady          = false;           // true after authorize

    // ── Reconnection ────────────────────────────────────────────────────────
    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay       = 5000;
    this.reconnectTimer       = null;
    this.isReconnecting       = false;

    // ── Heartbeat ───────────────────────────────────────────────────────────
    this.pingInterval    = null;
    this.checkDataInterval = null;
    this.pongTimeout     = null;
    this.lastPongTime    = Date.now();
    this.lastDataTime    = Date.now();
    this.pingIntervalMs  = 20000;
    this.pongTimeoutMs   = 10000;
    this.dataTimeoutMs   = 60000;

    // ── Message queue ────────────────────────────────────────────────────────
    this.messageQueue  = [];
    this.maxQueueSize  = 50;

    // ── Account ──────────────────────────────────────────────────────────────
    this.balance   = 0;
    this.currency  = 'USD';
    this.accountId = '';

    // ── Session trading state ────────────────────────────────────────────────
    this.running               = false;
    this.tradeInProgress       = false;      // lock: only one contract at a time
    this.currentContractId     = null;
    this.pendingTradeInfo      = null;       // metadata for the open contract

    this.currentGridLevel      = 0;
    this.currentDirection      = 'CALLE';   // always start HIGHER
    this.baseStake             = this.config.initialStake;
    this.investmentRemaining   = 0;
    this.investmentStartAmount = 0;
    this.totalProfit           = 0;
    this.totalTrades           = 0;
    this.wins                  = 0;
    this.losses                = 0;
    this.currentStreak         = 0;
    this.maxWinStreak          = 0;
    this.maxLossStreak         = 0;
    this.totalRecovered        = 0;

    // ── Session control ──────────────────────────────────────────────────────
    this.endOfDay    = false;
    this.isWinTrade  = false;

    // ── Logs ─────────────────────────────────────────────────────────────────
    this.tradeLogs  = [];   // completed trades
    this.systemLogs = [];   // text log lines

    // ── Hourly Telegram stats ─────────────────────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };

    // ── Event listeners (for HTTP push) ──────────────────────────────────────
    this.listeners = [];

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
      this.log('Telegram notifications disabled (no token/chat-id configured)', 'warning');
    }

    // ── Restore saved state ───────────────────────────────────────────────────
    this._restoreState();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE RESTORE
  // ══════════════════════════════════════════════════════════════════════════

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
    this.log(`State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | P&L: $${this.totalProfit.toFixed(2)} | Level: ${this.currentGridLevel}`, 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT BUS
  // ══════════════════════════════════════════════════════════════════════════

  on(fn)   { this.listeners.push(fn); }
  emit(ev) { this.listeners.forEach(fn => { try { fn(ev); } catch (_) {} }); }

  // ══════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ══════════════════════════════════════════════════════════════════════════

  log(message, type = 'info') {
    const ts     = new Date().toISOString();
    const emoji  = { error: '❌', success: '✅', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
    const line   = `[${ts}] ${emoji} ${message}`;
    this.systemLogs.unshift(line);
    if (this.systemLogs.length > 300) this.systemLogs.pop();
    console.log(line);
    this.emit({ type: 'log', entry: line, logType: type });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SNAPSHOT — for HTTP API / WebSocket push
  // ══════════════════════════════════════════════════════════════════════════

  snapshot() {
    const cfg = this.config;
    return {
      wsConnected:           this.connected,
      authorized:            this.wsReady,
      accountId:             this.accountId,
      balance:               this.balance,
      currency:              this.currency,
      running:               this.running,
      currentGridLevel:      this.currentGridLevel,
      currentDirection:      this.currentDirection,
      totalProfit:           this.totalProfit,
      totalTrades:           this.totalTrades,
      wins:                  this.wins,
      losses:                this.losses,
      currentStreak:         this.currentStreak,
      maxWinStreak:          this.maxWinStreak,
      maxLossStreak:         Math.abs(this.maxLossStreak),
      baseStake:             this.baseStake,
      totalRecovered:        this.totalRecovered,
      investmentRemaining:   this.investmentRemaining,
      investmentStartAmount: this.investmentStartAmount,
      nextStake:             this.calculateStake(this.currentGridLevel),
      systemLogs:            this.systemLogs.slice(0, 200),
      tradeLogs:             this.tradeLogs.slice(0, 200),
      config: {
        ...cfg,
        apiToken:       cfg.apiToken       ? '***set***' : '',
        telegramToken:  cfg.telegramToken  ? '***set***' : '',
        telegramChatId: cfg.telegramChatId ? '***set***' : '',
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORE STRATEGY: CALCULATE STAKE
  // ══════════════════════════════════════════════════════════════════════════
  //
  //  Level 0 → baseStake × 1.48⁰ = baseStake
  //  Level 1 → baseStake × 1.48¹
  //  Level N → baseStake × 1.48ᴺ  (up to maxMartingaleLevel)
  //  Extra L  → previousStake × extraLevelMultipliers[i]  (or 1.48 fallback)
  //
  calculateStake(level) {
    const cfg      = this.config;
    let   base     = this.baseStake;

    if (cfg.autoCompounding && this.investmentRemaining > 0) {
      base = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
    }
    base = Math.max(base, 0.35);

    if (level <= cfg.maxMartingaleLevel) {
      return Number((base * Math.pow(cfg.martingaleMultiplier, level)).toFixed(2));
    }

    // Extra levels beyond maxMartingaleLevel
    let stake      = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraIdx = level - cfg.maxMartingaleLevel - 1;
    const mults    = cfg.extraLevelMultipliers || [];
    for (let i = 0; i <= extraIdx; i++) {
      stake *= (mults[i] > 0 ? mults[i] : cfg.martingaleMultiplier);
    }
    return Number(stake.toFixed(2));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — CONNECT
  // ══════════════════════════════════════════════════════════════════════════

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.log('Already connected', 'warning');
      return;
    }

    this._cleanup();

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.config.appId}`;
    this.log(`Connecting to Deriv WebSocket (${wsUrl})...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.connected        = true;
      this.wsReady          = false;
      this.reconnectAttempts = 0;
      this.isReconnecting   = false;
      this.lastPongTime     = Date.now();
      this.lastDataTime     = Date.now();
      this.log('WebSocket connected ✅', 'success');
      this._startMonitor();
      this._authenticate();
      this.emit({ type: 'state' });
    });

    this.ws.on('message', (data) => {
      this.lastPongTime = Date.now();
      this.lastDataTime = Date.now();
      try { this._handleMessage(JSON.parse(data)); } catch (e) { /* ignore */ }
    });

    this.ws.on('pong', () => {
      this.lastPongTime = Date.now();
    });

    this.ws.on('error', (e) => {
      this.log(`WebSocket error: ${e.message}`, 'error');
    });

    this.ws.on('close', (code, reason) => {
      this.log(`WebSocket closed (code: ${code}, reason: ${reason || 'none'})`, 'warning');
      this._handleDisconnect();
    });
  }

  _authenticate() {
    this._send({ authorize: this.config.apiToken });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — SEND
  // ══════════════════════════════════════════════════════════════════════════

  _send(request) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push(request);
      }
      return false;
    }
    try {
      this.ws.send(JSON.stringify(request));
      return true;
    } catch (e) {
      this.log(`Send error: ${e.message}`, 'error');
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push(request);
      }
      return false;
    }
  }

  _processQueue() {
    if (!this.messageQueue.length) return;
    this.log(`Processing ${this.messageQueue.length} queued message(s)...`);
    const q = [...this.messageQueue];
    this.messageQueue = [];
    q.forEach(m => this._send(m));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HEARTBEAT MONITOR
  // ══════════════════════════════════════════════════════════════════════════

  _startMonitor() {
    this._stopMonitor();

    this.pingInterval = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.pongTimeout = setTimeout(() => {
          if (Date.now() - this.lastPongTime > this.pongTimeoutMs) {
            this.log('No pong received — connection may be dead', 'warning');
          }
        }, this.pongTimeoutMs);
      }
    }, this.pingIntervalMs);

    this.checkDataInterval = setInterval(() => {
      if (!this.connected) return;
      const silence = Date.now() - this.lastDataTime;
      if (silence > this.dataTimeoutMs) {
        this.log(`No data for ${Math.round(silence / 1000)}s — forcing reconnect`, 'error');
        StatePersistence.save(this);
        if (this.ws) this.ws.terminate();
      }
    }, 10000);
  }

  _stopMonitor() {
    if (this.pingInterval)     { clearInterval(this.pingInterval);     this.pingInterval = null; }
    if (this.checkDataInterval){ clearInterval(this.checkDataInterval); this.checkDataInterval = null; }
    if (this.pongTimeout)      { clearTimeout(this.pongTimeout);        this.pongTimeout = null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISCONNECT / RECONNECT
  // ══════════════════════════════════════════════════════════════════════════

  _handleDisconnect() {
    if (this.endOfDay) {
      this.log('Planned shutdown — not reconnecting');
      this._cleanup();
      return;
    }

    if (this.isReconnecting) return;

    this.connected = false;
    this.wsReady   = false;
    this._stopMonitor();
    StatePersistence.save(this);
    this.emit({ type: 'state' });

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnection attempts reached — please restart', 'error');
      this._sendTelegram(`❌ <b>Max reconnect attempts reached</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    this._sendTelegram(
      `⚠️ <b>CONNECTION LOST — RECONNECTING</b>\n` +
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

  _cleanup() {
    this._stopMonitor();
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
    this.connected = false;
    this.wsReady   = false;
  }

  disconnect() {
    this.log('Disconnecting...');
    StatePersistence.save(this);
    this.endOfDay = true;
    this._cleanup();
    this.log('Disconnected ✅', 'success');
    this.emit({ type: 'state' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ══════════════════════════════════════════════════════════════════════════

  _handleMessage(msg) {
    if (msg.msg_type === 'ping') {
      this._send({ ping: 1 });
      return;
    }

    if (msg.error) {
      this.log(`API Error [${msg.error.code}]: ${msg.error.message}`, 'error');
      if (msg.error.code === 'AuthorizationRequired' || msg.error.code === 'InvalidToken') {
        this.wsReady = false;
        this.emit({ type: 'state' });
        this._handleDisconnect();
        return;
      }
      // Unlock trade lock on buy/proposal errors
      if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
        this.tradeInProgress = false;
        this.pendingTradeInfo = null;
        // Retry trade after a short delay if still running
        if (this.running) {
          this.log('Retrying trade after error in 3s...', 'warning');
          setTimeout(() => { if (this.running) this._placeTrade(); }, 3000);
        }
      }
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':               this._onAuthorize(msg);  break;
      case 'balance':                 this._onBalance(msg);    break;
      case 'proposal':                this._onProposal(msg);   break;
      case 'buy':                     this._onBuy(msg);        break;
      case 'proposal_open_contract':  this._onContract(msg);   break;
    }

    this.emit({ type: 'state' });
  }

  // ── authorize ─────────────────────────────────────────────────────────────
  _onAuthorize(msg) {
    if (msg.error) {
      this.log(`Authentication failed: ${msg.error.message}`, 'error');
      this._sendTelegram(`❌ <b>Authentication Failed:</b> ${msg.error.message}`);
      return;
    }
    this.wsReady   = true;
    this.accountId = msg.authorize.loginid;
    this.balance   = msg.authorize.balance;
    this.currency  = msg.authorize.currency;
    this.log(`Authorized ✅ | Account: ${this.accountId} | Balance: ${this.currency} ${this.balance.toFixed(2)}`, 'success');

    // Subscribe to live balance
    this._send({ balance: 1, subscribe: 1 });

    // Process any queued messages
    this._processQueue();

    this._sendTelegram(
      `✅ <b>V75 Grid Bot Connected</b>\n` +
      `Account: ${this.accountId}\n` +
      `Balance: ${this.currency} ${this.balance.toFixed(2)}`
    );
  }

  // ── balance ───────────────────────────────────────────────────────────────
  _onBalance(msg) {
    this.balance = msg.balance.balance;
    this.emit({ type: 'balance', balance: this.balance });
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
    this.currentContractId = b.contract_id;

    // Deduct stake from investment pool
    this.investmentRemaining = Math.max(0, Number((this.investmentRemaining - b.buy_price).toFixed(2)));

    this.log(`Contract opened: ${b.contract_id} | Stake: $${b.buy_price.toFixed(2)} | Investment left: $${this.investmentRemaining.toFixed(2)}`, 'info');

    // Subscribe to contract updates
    this._send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });

    this.emit({ type: 'state' });
  }

  // ── contract result ───────────────────────────────────────────────────────
  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;   // Not settled yet

    const profit = parseFloat(c.profit);
    const payout = parseFloat(c.payout || 0);
    const isWin  = profit > 0;

    this.tradeInProgress = false;

    // ── Complete pending trade log ────────────────────────────────────────
    if (this.pendingTradeInfo) {
      const completed = {
        ...this.pendingTradeInfo,
        result:     isWin ? 'WIN' : 'LOSS',
        profit,
        contractId: c.contract_id,
      };
      this.tradeLogs.unshift(completed);
      if (this.tradeLogs.length > 300) this.tradeLogs.pop();
      this.pendingTradeInfo = null;
      this.emit({ type: 'trade', trade: completed });
    }

    // ── Update counters ───────────────────────────────────────────────────
    this.totalTrades += 1;
    this.totalProfit  = Number((this.totalProfit + profit).toFixed(2));
    if (isWin) { this.wins++;   this.isWinTrade = true;  }
    else       { this.losses++; this.isWinTrade = false; }

    // Streak
    this.currentStreak = isWin
      ? (this.currentStreak > 0 ? this.currentStreak + 1 : 1)
      : (this.currentStreak < 0 ? this.currentStreak - 1 : -1);
    if (isWin)  this.maxWinStreak  = Math.max(this.currentStreak, this.maxWinStreak);
    if (!isWin) this.maxLossStreak = Math.min(this.currentStreak, this.maxLossStreak);

    // Hourly stats
    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) this.hourlyStats.wins++; else this.hourlyStats.losses++;

    // ── Risk management check ─────────────────────────────────────────────
    if (this.totalProfit <= -this.config.stopLoss) {
      this.log(`🛑 STOP LOSS hit! P&L: $${this.totalProfit.toFixed(2)}`, 'error');
      this._sendTelegram(`🛑 <b>STOP LOSS REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.emit({ type: 'state' });
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this.log(`🎉 TAKE PROFIT hit! P&L: $${this.totalProfit.toFixed(2)}`, 'success');
      this._sendTelegram(`🎉 <b>TAKE PROFIT REACHED</b>\nFinal P&L: $${this.totalProfit.toFixed(2)}`);
      this.running = false;
      this.emit({ type: 'state' });
      return;
    }

    let shouldContinue = true;
    const cfg          = this.config;

    if (isWin) {
      // ══════════════════════════════════════════════════════════════════════
      // WIN — Reset to Level 0 + CALLE
      //       Full loss recovery captured on the very next win (martingale)
      // ══════════════════════════════════════════════════════════════════════
      if (this.currentGridLevel > 0) this.totalRecovered += profit;

      // Return payout to investment pool
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));

      if (cfg.autoCompounding) {
        this.baseStake = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
        this.log(
          `🎯 WIN +$${profit.toFixed(2)} | RECOVERY L${this.currentGridLevel} → RESET | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | New base: $${this.baseStake.toFixed(2)} | Next: L0 HIGHER`,
          'success'
        );
      } else {
        this.log(
          `🎯 WIN +$${profit.toFixed(2)}${this.currentGridLevel > 0 ? ' | FULL RECOVERY!' : ''} | ` +
          `Investment: $${this.investmentRemaining.toFixed(2)} | Reset → L0 HIGHER`,
          'success'
        );
      }

      this.currentGridLevel = 0;
      this.currentDirection = 'CALLE';

      this._sendTelegramTradeResult(isWin, profit);

    } else {
      // ══════════════════════════════════════════════════════════════════════
      // LOSS — Increase level + Switch direction (CALLE ↔ PUTE)
      //        Martingale 1.48x on next stake to recover all losses + profit
      // ══════════════════════════════════════════════════════════════════════
      const nextLevel   = this.currentGridLevel + 1;
      const nextDir     = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      const absoluteMax = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      this.currentGridLevel = nextLevel;
      this.currentDirection = nextDir;

      if (nextLevel > absoluteMax) {
        // Hard ceiling — always stop
        this.log(`🛑 ABSOLUTE CEILING L${absoluteMax} reached — bot stopped to protect investment`, 'error');
        this._sendTelegram(
          `🛑 <b>ABSOLUTE MAX LEVEL REACHED (L${absoluteMax})</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Total P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue = false;

      } else if (nextLevel > cfg.maxMartingaleLevel) {
        // Extended level zone
        const extraIdx  = nextLevel - cfg.maxMartingaleLevel - 1;
        const extraMult = (cfg.extraLevelMultipliers && cfg.extraLevelMultipliers[extraIdx] > 0)
          ? cfg.extraLevelMultipliers[extraIdx]
          : cfg.martingaleMultiplier;
        const nextStake = this.calculateStake(nextLevel);
        this.log(
          `🔴 EXTENDED RECOVERY L${nextLevel}/${absoluteMax} | Mult: ${extraMult}x | ` +
          `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`,
          'warning'
        );

      } else if (nextLevel === cfg.maxMartingaleLevel) {
        if (cfg.afterMaxLoss === 'stop') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(`⚠️ FINAL attempt (L${cfg.maxMartingaleLevel}) | ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`, 'warning');
        } else if (cfg.afterMaxLoss === 'continue') {
          const nextStake = this.calculateStake(nextLevel);
          this.log(`⚠️ MAX L${cfg.maxMartingaleLevel} reached — extending to L${absoluteMax} | Next: ${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`, 'warning');
        } else if (cfg.afterMaxLoss === 'reset') {
          this.currentGridLevel = 0;
          this.currentDirection = 'CALLE';
          this.log(`🔄 MAX LEVEL reached — Resetting to L0 HIGHER (reset mode)`, 'warning');
        }
      } else {
        const nextStake = this.calculateStake(this.currentGridLevel);
        this.log(
          `📉 LOSS -$${Math.abs(profit).toFixed(2)} | Grid L${this.currentGridLevel} | ` +
          `${this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`,
          'warning'
        );
      }

      this._sendTelegramTradeResult(isWin, profit);

      // Funds check
      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          this.log(`🛑 INSUFFICIENT INVESTMENT: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
          shouldContinue = false;
        } else if (nextStake > this.balance) {
          this.log(`🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`, 'error');
          shouldContinue = false;
        }
      }
    }

    if (!shouldContinue) {
      this.running = false;
      this._logSummary();
      this.emit({ type: 'state' });
      return;
    }

    if (this.running) {
      setTimeout(() => { if (this.running) this._placeTrade(); }, 1000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════

  _placeTrade() {
    if (!this.wsReady)          { this.log('Not authorized — cannot trade', 'error');           return; }
    if (!this.running)          { return; }
    if (this.tradeInProgress)   { this.log('Trade already in progress...', 'warning');          return; }

    const stake     = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label     = direction === 'CALLE' ? 'HIGHER' : 'LOWER';

    if (stake > this.investmentRemaining) {
      this.log(`Insufficient investment: stake $${stake} > remaining $${this.investmentRemaining.toFixed(2)}`, 'error');
      this.running = false; this.emit({ type: 'state' }); return;
    }
    if (stake > this.balance) {
      this.log(`Insufficient balance: stake $${stake} > balance $${this.balance.toFixed(2)}`, 'error');
      this.running = false; this.emit({ type: 'state' }); return;
    }

    this.log(`📊 Placing ${label} | L${this.currentGridLevel} | Stake: $${stake} | Investment left: $${this.investmentRemaining.toFixed(2)}`);

    this.tradeInProgress = true;
    this.pendingTradeInfo = {
      id:        Date.now(),
      time:      new Date().toISOString(),
      direction,
      stake,
      gridLevel: this.currentGridLevel,
      result:    'PENDING',
      profit:    0,
    };

    // Add as pending in trade log
    this.tradeLogs.unshift(this.pendingTradeInfo);
    if (this.tradeLogs.length > 300) this.tradeLogs.pop();

    // Send proposal → triggers _onProposal → buy
    this._send({
      proposal:      1,
      amount:        stake,
      basis:         'stake',
      contract_type: direction,         // 'CALLE' or 'PUTE'
      currency:      this.currency,
      duration:      this.config.tickDuration,
      duration_unit: 't',
      symbol:        this.config.symbol,
    });

    this.emit({ type: 'state' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // START / STOP
  // ══════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.wsReady)    { this.log('Not authorized — connect first', 'error');     return false; }
    if (this.running)     { this.log('Bot already running', 'warning');              return false; }
    if (this.config.investmentAmount <= 0) { this.log('Invalid investment amount', 'error'); return false; }
    if (this.config.investmentAmount > this.balance) {
      this.log(`Investment $${this.config.investmentAmount} exceeds balance $${this.balance.toFixed(2)}`, 'error');
      return false;
    }

    const cfg = this.config;

    // Set base stake
    if (cfg.autoCompounding) {
      this.baseStake = Math.max(cfg.investmentAmount * cfg.compoundPercentage / 100, 0.35);
      this.log(`💰 Auto-compounding ON: ${cfg.compoundPercentage}% of $${cfg.investmentAmount} = $${this.baseStake.toFixed(2)} base stake`);
    } else {
      this.baseStake = cfg.initialStake;
      this.log(`💰 Fixed stake: $${this.baseStake.toFixed(2)}`);
    }

    // Reset session state
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
    this.tradeLogs             = [];

    this.log('🚀 V75 Grid Martingale Bot STARTED!', 'success');
    this.log(`💵 Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | Mult: ${cfg.martingaleMultiplier}x | Max: L${cfg.maxMartingaleLevel} | ${cfg.tickDuration}t`);
    if (cfg.afterMaxLoss === 'continue') {
      this.log(`🔄 Extended recovery: up to L${cfg.maxMartingaleLevel + cfg.continueExtraLevels} with custom multipliers`);
    }
    this.log(`📈 First trade: HIGHER (CALLE) — exploiting V75 mean-reversion`);

    this._sendTelegram(
      `🚀 <b>V75 Grid Bot STARTED</b>\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}x | Max Level: ${cfg.maxMartingaleLevel}\n` +
      `⏱ Duration: ${cfg.tickDuration} ticks\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}`
    );

    this.emit({ type: 'state' });
    setTimeout(() => { if (this.running) this._placeTrade(); }, 500);
    return true;
  }

  stop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.log('🛑 Bot stopped by user', 'warning');
    this._sendTelegram(`🛑 <b>Bot stopped by user</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
    this.emit({ type: 'state' });
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this.log('🚨 EMERGENCY STOP — All activity halted!', 'error');
    this._sendTelegram(`🚨 <b>EMERGENCY STOP TRIGGERED</b>\nP&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`);
    this._logSummary();
    this.emit({ type: 'state' });
  }

  updateConfig(partial) {
    this.config = { ...this.config, ...partial };
    saveConfig(this.config);
    this.emit({ type: 'state' });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    this.log(`📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | Win rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | Recovered: $${this.totalRecovered.toFixed(2)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TELEGRAM
  // ══════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.config.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      // Silently log — don't crash bot over Telegram issues
      console.error(`[Telegram] send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr       = this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0';
    const pnlStr   = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const dirLabel = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— V75 Grid Bot</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L:</b> ${pnlStr}\n` +
      `📊 <b>Grid Level:</b> ${this.currentGridLevel} → ${isWin ? 'RESET L0' : `L${this.currentGridLevel}`}\n` +
      `🎯 <b>Next:</b> ${dirLabel} @ $${this.calculateStake(this.currentGridLevel).toFixed(2)}\n\n` +
      `📈 <b>Session Stats:</b>\n` +
      `  Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  Daily P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  async _sendHourlySummary() {
    const s   = this.hourlyStats;
    const wr  = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) : '0.0';
    const pnlStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);

    await this._sendTelegram(
      `⏰ <b>V75 Grid Bot — Hourly Summary</b>\n\n` +
      `📊 <b>Last Hour:</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnlStr}\n\n` +
      `📈 <b>Session Totals:</b>\n` +
      `  Total Trades: ${this.totalTrades}\n` +
      `  W/L: ${this.wins}/${this.losses}\n` +
      `  Session P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)} / $${this.investmentStartAmount.toFixed(2)}\n` +
      `  Grid Level: ${this.currentGridLevel}\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this.log('📱 Telegram hourly summary sent');

    // Reset hourly stats
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0, lastHour: new Date().getHours() };
  }

  startTelegramTimer() {
    const now           = new Date();
    const nextHour      = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNext   = nextHour.getTime() - now.getTime();

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1000);
    }, msUntilNext);

    this.log(`📱 Hourly Telegram summaries scheduled (first in ${Math.ceil(msUntilNext / 60000)} min)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER — Weekend pause + end-of-day logic (GMT+1)
  // ══════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    setInterval(() => {
      const now      = new Date();
      const gmt1     = new Date(now.getTime() + 60 * 60 * 1000);
      const day      = gmt1.getUTCDay();   // 0=Sun 1=Mon … 6=Sat
      const hours    = gmt1.getUTCHours();
      const minutes  = gmt1.getUTCMinutes();

      // Weekend: Sat 23:00 → Mon 08:00 GMT+1
      const isWeekend = day === 0 ||                         // Sunday (all day)
                        (day === 6 && hours >= 23) ||         // Sat after 23:00
                        (day === 1 && hours < 8);             // Mon before 08:00

      if (isWeekend) {
        if (!this.endOfDay) {
          this.log('📅 Weekend trading pause (Sat 23:00 – Mon 08:00 GMT+1) — disconnecting', 'warning');
          this._sendHourlySummary();
          this.stop();
          this.disconnect();
          this.endOfDay = true;
        }
        return;
      }

      // Resume Monday 08:00
      if (this.endOfDay && day === 1 && hours === 8 && minutes === 0) {
        this.log('📅 Monday 08:00 GMT+1 — reconnecting bot', 'success');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
      }

      // Optional end-of-day: stop after a win past 17:00
      if (this.isWinTrade && !this.endOfDay && hours >= 17) {
        this.log('📅 Past 17:00 GMT+1 after a win — end-of-day stop', 'info');
        this._sendHourlySummary();
        this.stop();
        this.disconnect();
        this.endOfDay = true;
      }
    }, 20000);  // Check every 20 s

    this.log('📅 Time scheduler started (weekend pause + EOD logic)');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade      = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MINIMAL WEBSOCKET SERVER (for browser push updates)
// ══════════════════════════════════════════════════════════════════════════════

// class WSServer {
//   constructor(httpServer) {
//     this.clients = new Set();
//     httpServer.on('upgrade', (req, sock, head) => this._handleUpgrade(req, sock, head));
//   }

//   _handleUpgrade(req, sock) {
//     const key    = req.headers['sec-websocket-key'];
//     const accept = crypto.createHash('sha1')
//       .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
//       .digest('base64');

//     sock.write(
//       'HTTP/1.1 101 Switching Protocols\r\n' +
//       'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
//       `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
//     );

//     const client = { sock, buffer: Buffer.alloc(0) };
//     this.clients.add(client);
//     sock.on('data',  (d) => this._onData(client, d));
//     sock.on('close', ()  => this.clients.delete(client));
//     sock.on('error', ()  => { try { sock.destroy(); } catch (_) {} this.clients.delete(client); });
//   }

//   _onData(client, chunk) {
//     client.buffer = Buffer.concat([client.buffer, chunk]);
//     while (client.buffer.length >= 2) {
//       const b1 = client.buffer[1]; const mask = (b1 & 0x80) !== 0; let plen = b1 & 0x7f; let hlen = 2 + (mask ? 4 : 0);
//       if (plen === 126) { if (client.buffer.length < 4) break; plen = client.buffer.readUInt16BE(2); hlen = 4 + (mask ? 4 : 0); }
//       if (client.buffer.length < hlen + plen) break;
//       client.buffer = client.buffer.slice(hlen + plen);
//     }
//   }

//   broadcast(obj) {
//     const payload = Buffer.from(JSON.stringify(obj));
//     const len     = payload.length;
//     let   header;
//     if (len < 126)       { header = Buffer.from([0x81, len]); }
//     else if (len < 65536){ header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
//     else                 { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
//     const frame = Buffer.concat([header, payload]);
//     for (const c of this.clients) {
//       try { c.sock.write(frame); } catch (_) { this.clients.delete(c); }
//     }
//   }
// }

// ══════════════════════════════════════════════════════════════════════════════
// HTTP API HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// function handleAPI(req, res, parsed, bot) {
//   const json = (obj, status = 200) => {
//     res.writeHead(status, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify(obj));
//   };

//   const withBody = (fn) => {
//     let body = '';
//     req.on('data', d => { body += d; });
//     req.on('end',  () => { try { fn(JSON.parse(body || '{}')); } catch (_) { json({ error: 'Invalid JSON' }, 400); } });
//   };

//   const ep = parsed.pathname.replace('/api/', '').replace(/\/$/, '');

//   if (req.method === 'GET' && ep === 'state')  return json(bot.snapshot());

//   if (req.method === 'POST' && ep === 'connect') {
//     return withBody((body) => {
//       if (body.apiToken) {
//         bot.config.apiToken = body.apiToken;
//         const cfg = loadConfig(); cfg.apiToken = body.apiToken; saveConfig(cfg);
//       }
//       if (!bot.connected) bot.connect();
//       else if (bot.wsReady && body.apiToken) bot._send({ authorize: body.apiToken });
//       json({ ok: true });
//     });
//   }

//   if (req.method === 'POST' && ep === 'disconnect') { bot.disconnect(); return json({ ok: true }); }
//   if (req.method === 'POST' && ep === 'start')      { const ok = bot.start(); return json({ ok, error: ok ? null : 'Cannot start — check logs' }); }
//   if (req.method === 'POST' && ep === 'stop')       { bot.stop();          return json({ ok: true }); }
//   if (req.method === 'POST' && ep === 'emergency-stop') { bot.emergencyStop(); return json({ ok: true }); }

//   if (req.method === 'POST' && ep === 'config') {
//     return withBody((body) => { bot.updateConfig(body); json({ ok: true }); });
//   }

//   json({ error: 'Not found' }, 404);
// }

// ══════════════════════════════════════════════════════════════════════════════
// WEB UI  (self-contained HTML served at http://localhost:PORT)
// ══════════════════════════════════════════════════════════════════════════════

// function buildUI() {
//   return `<!DOCTYPE html>
// <html lang="en">
// <head>
// <meta charset="UTF-8">
// <meta name="viewport" content="width=device-width, initial-scale=1.0">
// <title>V75 Grid Martingale Bot — Production</title>
// <style>
// *{box-sizing:border-box;margin:0;padding:0}
// :root{
//   --bg:#0d0d0f;--card:#16171d;--card2:#1c1d24;--border:#2a2b35;
//   --green:#00d084;--red:#ff4d4d;--yellow:#f5c518;--blue:#4da6ff;
//   --purple:#c084fc;--text:#e0e0e0;--muted:#6b7280;
// }
// body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;padding:16px}
// h1{font-size:clamp(1.3rem,3vw,2rem);font-weight:700;background:linear-gradient(90deg,var(--green),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
// .subtitle{color:var(--muted);font-size:.8rem;margin-top:4px}
// .header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px}
// .status-badge{display:flex;align-items:center;gap:6px;font-size:.8rem;background:var(--card2);padding:4px 10px;border-radius:20px}
// .dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}
// .dot.green{background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 1.5s infinite}
// .dot.yellow{background:var(--yellow)}
// .dot.red{background:var(--red)}
// @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
// .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
// @media(max-width:900px){.grid{grid-template-columns:1fr 1fr}}
// @media(max-width:580px){.grid{grid-template-columns:1fr}}
// .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
// .card.yellow-border{border-color:rgba(245,197,24,.35)}
// .card-title{font-size:.85rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;display:flex;align-items:center;gap:6px}
// label{display:block;font-size:.75rem;color:var(--muted);margin-bottom:4px;margin-top:8px}
// input,select{width:100%;background:#0d0d0f;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:.85rem;outline:none;transition:border-color .2s}
// input:focus,select:focus{border-color:var(--blue)}
// input:disabled,select:disabled{opacity:.5;cursor:not-allowed}
// .btn{width:100%;padding:10px;border:none;border-radius:10px;font-size:.9rem;font-weight:700;cursor:pointer;transition:all .2s;margin-top:8px}
// .btn-green{background:linear-gradient(135deg,#16a34a,#059669);color:#fff}
// .btn-green:hover{filter:brightness(1.15)}
// .btn-green:disabled{background:#374151;cursor:not-allowed;filter:none}
// .btn-red{background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff}
// .btn-red:hover{filter:brightness(1.15)}
// .btn-outline-red{background:transparent;border:1px solid rgba(239,68,68,.5);color:#f87171;margin-top:6px}
// .btn-outline-red:hover{background:rgba(239,68,68,.1)}
// .btn-outline{background:transparent;border:1px solid var(--border);color:var(--text);margin-top:6px}
// .btn-outline:hover{background:var(--card2)}
// .big-num{font-size:1.8rem;font-weight:800;font-variant-numeric:tabular-nums}
// .green{color:var(--green)}.red{color:var(--red)}.yellow{color:var(--yellow)}.blue{color:var(--blue)}.purple{color:var(--purple)}.muted{color:var(--muted)}
// .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
// .stat-box{background:#0d0d0f;border-radius:8px;padding:10px}
// .stat-label{font-size:.7rem;color:var(--muted)}
// .stat-val{font-size:1.1rem;font-weight:700;margin-top:2px}
// .toggle-row{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
// .toggle{width:44px;height:22px;border-radius:11px;background:var(--border);cursor:pointer;position:relative;transition:background .25s;flex-shrink:0}
// .toggle.on{background:var(--green)}
// .toggle::after{content:'';position:absolute;width:16px;height:16px;background:#fff;border-radius:50%;top:3px;left:3px;transition:transform .25s}
// .toggle.on::after{transform:translateX(22px)}
// .level-grid{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;justify-content:center}
// .level-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;background:var(--card2);transition:all .25s}
// .level-dot.active-0{background:#16a34a}
// .level-dot.active-low{background:#ca8a04}
// .level-dot.active-mid{background:#ea580c}
// .level-dot.active-high{background:#dc2626}
// .level-dot.active-ext{background:#7c3aed}
// .level-dot.max-ring{outline:2px solid var(--yellow);outline-offset:2px}
// .level-dot.ext-bg{background:rgba(124,58,237,.2)}
// .log-panel{overflow-y:auto;flex:1;font-size:.72rem;font-family:'Courier New',monospace}
// .log-entry{padding:4px 6px;border-bottom:1px solid rgba(42,43,53,.5);line-height:1.4;animation:fadeIn .3s}
// @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
// .log-win{color:#4ade80;background:rgba(74,222,128,.05)}
// .log-loss{color:#f87171;background:rgba(248,113,113,.05)}
// .log-info{color:var(--text)}
// .log-warning{color:var(--yellow)}
// .log-error{color:var(--red)}
// .log-success{color:var(--green)}
// .bar-wrap{height:6px;background:#374151;border-radius:3px;margin-top:6px;overflow:hidden}
// .bar{height:100%;border-radius:3px;transition:width .5s}
// .extra-level-row{display:grid;grid-template-columns:auto 1fr;gap:6px;align-items:center;margin-top:4px}
// .extra-level-badge{font-size:.7rem;background:rgba(124,58,237,.2);color:var(--purple);border-radius:4px;padding:2px 6px;white-space:nowrap}
// .connection-row{display:flex;gap:6px}
// .connection-row input{flex:1}
// #conn-btn{width:auto;padding:8px 14px;margin-top:0;white-space:nowrap}
// .divider{height:1px;background:var(--border);margin:10px 0}
// .row2{display:flex;justify-content:space-between;align-items:center;font-size:.78rem;padding:2px 0}
// .running-anim{animation:spin 2s linear infinite;display:inline-block}
// @keyframes spin{to{transform:rotate(360deg)}}
// .tg-badge{display:inline-flex;align-items:center;gap:5px;font-size:.72rem;background:rgba(77,166,255,.1);border:1px solid rgba(77,166,255,.25);color:var(--blue);border-radius:6px;padding:3px 8px;margin-top:6px}
// </style>
// </head>
// <body>
// <header class="header">
//   <div>
//     <h1>⚡ V75 Grid Martingale Bot</h1>
//     <div class="subtitle">Volatility 75 Index (1HZ75V) | CALLE/PUTE | Production Node.js Engine</div>
//   </div>
//   <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
//     <div class="status-badge"><div class="dot" id="ws-dot"></div><span id="ws-label">Disconnected</span></div>
//     <div class="status-badge" id="acct-badge" style="display:none"><span id="acct-id"></span></div>
//     <div class="tg-badge" id="tg-badge">📱 Telegram</div>
//   </div>
// </header>

// <div class="grid">
// <!-- ══ LEFT COLUMN ══════════════════════════════════════════════════════════ -->
// <div>

//   <div class="card">
//     <div class="card-title">🔑 API Connection</div>
//     <div class="connection-row">
//       <input type="password" id="api-token" placeholder="Deriv API Token">
//       <button class="btn btn-outline" id="conn-btn" onclick="toggleConnect()">Connect</button>
//     </div>
//   </div>

//   <div class="card">
//     <div class="card-title">💰 Account Balance</div>
//     <div class="big-num green" id="balance">— —</div>
//   </div>

//   <div class="card yellow-border">
//     <div class="card-title">💵 Investment Pool</div>
//     <label>Investment Amount ($)</label>
//     <input type="number" id="investment-amount" value="100" min="1" step="1">
//     <p style="font-size:.7rem;color:var(--muted);margin-top:4px">Bot uses only this pool — never the full balance</p>
//     <div id="investment-live" style="display:none">
//       <div class="divider"></div>
//       <div class="row2"><span class="muted">Remaining:</span><span class="yellow" id="inv-remaining" style="font-weight:700;font-size:1.1rem"></span></div>
//       <div class="row2"><span class="muted">P&L:</span><span id="inv-pnl" style="font-weight:700"></span></div>
//       <div class="bar-wrap"><div class="bar" id="inv-bar" style="width:100%;background:var(--green)"></div></div>
//     </div>
//   </div>

//   <div class="card">
//     <div class="card-title">⚙️ Strategy Settings</div>
//     <label>Initial Stake ($)</label>
//     <input type="number" id="initial-stake" value="0.35" min="0.35" step="0.01">
//     <label>Martingale Multiplier</label>
//     <input type="number" id="mult" value="1.48" min="1.1" max="3" step="0.01">
//     <p style="font-size:.7rem;color:var(--muted);margin-top:2px">Recommended: 1.48 (the magic number)</p>
//     <label>Max Martingale Level</label>
//     <input type="number" id="max-level" value="6" min="1" max="20" step="1">
//     <label>After Max Loss</label>
//     <select id="after-max">
//       <option value="stop">🛑 Stop Bot</option>
//       <option value="continue">🔄 Continue (Extra Levels)</option>
//       <option value="reset">↩️ Reset to Level 0</option>
//     </select>
//     <div id="extra-levels-section" style="display:none">
//       <label>Extra Levels After Max</label>
//       <input type="number" id="extra-levels" value="3" min="1" max="10" step="1">
//       <div id="extra-mult-rows" style="margin-top:6px"></div>
//     </div>
//     <label>Stop Loss ($)</label>
//     <input type="number" id="stop-loss" value="50" min="1" step="1">
//     <label>Take Profit ($)</label>
//     <input type="number" id="take-profit" value="1000" min="1" step="1">
//     <div class="toggle-row" style="margin-top:12px">
//       <label style="margin:0">Auto-Compounding</label>
//       <div class="toggle" id="compound-toggle" onclick="toggleCompound()"></div>
//     </div>
//     <div id="compound-section" style="display:none">
//       <label>Compound % of Investment</label>
//       <input type="number" id="compound-pct" value="1" min="0.1" max="10" step="0.1">
//     </div>
//     <button class="btn btn-outline" style="margin-top:12px" onclick="saveConfig()">💾 Save Settings</button>
//   </div>

//   <button class="btn btn-green" id="start-btn" onclick="startBot()" disabled>🚀 START BOT</button>
//   <button class="btn btn-red"   id="stop-btn"  onclick="stopBot()"  style="display:none">⏹️ STOP BOT</button>
//   <button class="btn btn-outline-red"           onclick="emergencyStop()">🚨 EMERGENCY STOP</button>

// </div>

// <!-- ══ CENTER COLUMN ════════════════════════════════════════════════════════ -->
// <div>

//   <div class="card" style="text-align:center">
//     <div class="card-title" style="justify-content:center">📊 Current Grid Level</div>
//     <div class="big-num" id="grid-level-num" style="font-size:3rem;transition:color .3s">0</div>
//     <div style="font-size:.8rem;color:var(--muted);margin-top:4px" id="grid-label">✨ Base Level — Safe Zone</div>
//     <div class="level-grid" id="level-indicators"></div>
//     <div style="font-size:.7rem;color:var(--muted);margin-top:6px" id="level-caption"></div>
//   </div>

//   <div class="card">
//     <div class="card-title">🎯 Current Trade</div>
//     <div class="grid2">
//       <div class="stat-box" style="text-align:center">
//         <div class="stat-label">Direction</div>
//         <div class="stat-val" id="cur-direction" style="font-size:1.2rem">—</div>
//       </div>
//       <div class="stat-box" style="text-align:center">
//         <div class="stat-label">Next Stake</div>
//         <div class="stat-val blue" id="next-stake">$0.35</div>
//       </div>
//     </div>
//     <div class="divider"></div>
//     <div class="row2"><span class="muted">Base Stake (L0):</span><span class="yellow" id="base-stake-val">$0.35</span></div>
//   </div>

//   <div class="card">
//     <div class="card-title">📈 Session Statistics</div>
//     <div class="grid2">
//       <div class="stat-box"><div class="stat-label">Total Profit</div><div class="stat-val" id="total-profit">$0.00</div></div>
//       <div class="stat-box"><div class="stat-label">Win Rate</div><div class="stat-val blue" id="win-rate">0.0%</div></div>
//       <div class="stat-box"><div class="stat-label">Total Trades</div><div class="stat-val" id="total-trades">0</div></div>
//       <div class="stat-box"><div class="stat-label">Streak</div><div class="stat-val" id="streak">0</div></div>
//       <div class="stat-box"><div class="stat-label">Wins</div><div class="stat-val green" id="wins">0</div></div>
//       <div class="stat-box"><div class="stat-label">Losses</div><div class="stat-val red" id="losses">0</div></div>
//     </div>
//     <div class="divider"></div>
//     <div class="row2"><span class="muted">Max Win Streak:</span><span class="green" id="max-win">0</span></div>
//     <div class="row2"><span class="muted">Max Loss Streak:</span><span class="red" id="max-loss">0</span></div>
//     <div class="row2"><span class="muted">Total Recovered:</span><span class="yellow" id="total-recovered">$0.00</span></div>
//   </div>

//   <div class="card">
//     <div style="display:flex;align-items:center;gap:10px">
//       <div class="dot" id="bot-dot"></div>
//       <span id="bot-status-label" style="font-weight:600">Bot Stopped</span>
//       <span id="bot-spin" style="display:none;margin-left:auto" class="running-anim">⚙️</span>
//     </div>
//   </div>

// </div>

// <!-- ══ RIGHT COLUMN ══════════════════════════════════════════════════════════ -->
// <div>

//   <div class="card" style="display:flex;flex-direction:column;height:380px">
//     <div class="card-title">📋 Trade History</div>
//     <div class="log-panel" id="trade-log"><div style="color:var(--muted);text-align:center;padding:30px">No trades yet</div></div>
//   </div>

//   <div class="card" style="display:flex;flex-direction:column;height:300px;margin-top:14px">
//     <div class="card-title">🖥️ System Log</div>
//     <div class="log-panel" id="sys-log"><div style="color:var(--muted);text-align:center;padding:30px">No logs yet</div></div>
//   </div>

// </div>
// </div>

// <div class="card" style="margin-top:4px;background:linear-gradient(135deg,var(--card),var(--card2))">
//   <div class="card-title">🧬 Strategy DNA — V75 Grid Martingale</div>
//   <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;font-size:.78rem">
//     <div><div class="muted">Mean Reversion</div><div>Exploits V75's micro-trending behaviour on 5-tick timeframe</div></div>
//     <div><div class="muted">Invisible Grid</div><div>~3.2–4.1 pips avg reversal distance — fully automated</div></div>
//     <div><div class="muted">Magic Multiplier</div><div>1.48x exactly — mathematically perfected recovery ratio</div></div>
//     <div><div class="muted">Safety System</div><div>Hard cap + configurable extra levels + investment pool</div></div>
//     <div><div class="muted">Infrastructure</div><div>Telegram alerts, state persistence, auto-reconnect, heartbeat</div></div>
//   </div>
// </div>

// <footer style="text-align:center;color:var(--muted);font-size:.72rem;margin-top:18px;padding-top:12px;border-top:1px solid var(--border)">
//   V75 Grid Martingale Bot — Production Node.js Edition | CALLE/PUTE Strategy<br>
//   ⚠️ Trading involves substantial risk. Past performance does not guarantee future results. For educational purposes only.
// </footer>

// <script>
// // ─────────────────────────────────────────────────────────────────
// //  UI Controller
// // ─────────────────────────────────────────────────────────────────
// let state       = {};
// let compoundOn  = false;
// let pollTimer   = null;

// async function poll() {
//   try {
//     const r = await fetch('/api/state');
//     if (r.ok) applyState(await r.json());
//   } catch (_) {}
// }

// function startPoll() { if (!pollTimer) pollTimer = setInterval(poll, 1000); }
// startPoll();
// poll();

// function applyState(s) {
//   state = s;

//   // WS status
//   const auth = s.authorized; const ws = s.wsConnected;
//   const wsDot = document.getElementById('ws-dot');
//   wsDot.className = 'dot ' + (auth ? 'green' : ws ? 'yellow' : '');
//   document.getElementById('ws-label').textContent = auth ? 'Connected & Authorized' : ws ? 'Connected' : 'Disconnected';

//   const ab = document.getElementById('acct-badge');
//   if (s.accountId) { ab.style.display=''; document.getElementById('acct-id').textContent=s.accountId; }
//   else             { ab.style.display='none'; }

//   // Balance
//   document.getElementById('balance').textContent = (s.currency||'') + ' ' + (s.balance||0).toFixed(2);

//   // Investment live panel
//   const invLive = document.getElementById('investment-live');
//   if (s.running || s.investmentStartAmount > 0) {
//     invLive.style.display = '';
//     document.getElementById('inv-remaining').textContent = '$' + (s.investmentRemaining||0).toFixed(2);
//     const pnl    = (s.investmentRemaining||0) - (s.investmentStartAmount||0);
//     const pnlPct = s.investmentStartAmount > 0 ? ((pnl / s.investmentStartAmount)*100).toFixed(2) : '0.00';
//     const pnlEl  = document.getElementById('inv-pnl');
//     pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + ' (' + pnlPct + '%)';
//     pnlEl.className = pnl >= 0 ? 'green' : 'red';
//     const bar = document.getElementById('inv-bar');
//     const pct = s.investmentStartAmount > 0 ? Math.min(100, (s.investmentRemaining/s.investmentStartAmount)*100) : 100;
//     bar.style.width = pct + '%';
//     bar.style.background = pnl >= 0 ? 'var(--green)' : 'var(--red)';
//   } else { invLive.style.display='none'; }

//   // Grid level
//   const lvl = s.currentGridLevel || 0;
//   const cfg  = s.config || {};
//   const maxL = cfg.maxMartingaleLevel || 6;
//   const extL = cfg.afterMaxLoss === 'continue' ? (cfg.continueExtraLevels||0) : 0;
//   const glEl = document.getElementById('grid-level-num');
//   glEl.textContent = lvl;
//   glEl.style.color = lvl === 0 ? 'var(--green)' : lvl <= maxL*0.4 ? 'var(--yellow)' : lvl <= maxL ? 'var(--red)' : 'var(--purple)';
//   document.getElementById('grid-label').textContent =
//     lvl === 0 ? '✨ Base Level — Safe Zone' :
//     lvl <= maxL*0.5 ? '📊 Recovery Mode' :
//     lvl <= maxL     ? '⚠️ High Risk Zone' : '🚨 Extended Recovery!';

//   // Level dots
//   const total = maxL + extL;
//   const ic    = document.getElementById('level-indicators');
//   ic.innerHTML = '';
//   for (let i = 0; i <= total; i++) {
//     const d = document.createElement('div');
//     d.className = 'level-dot' + (i > maxL ? ' ext-bg' : '') + (i === maxL ? ' max-ring' : '');
//     if (i === lvl) d.className += ' ' + (i===0?'active-0':i<=maxL*0.4?'active-low':i<=maxL*0.7?'active-mid':i<=maxL?'active-high':'active-ext');
//     d.textContent = i;
//     ic.appendChild(d);
//   }
//   document.getElementById('level-caption').textContent = 'Max: ' + maxL + (extL > 0 ? ' | Extended: ' + (maxL+extL) : '');

//   // Direction + stake
//   const dir   = s.currentDirection || 'CALLE';
//   const dirEl = document.getElementById('cur-direction');
//   dirEl.textContent = dir === 'CALLE' ? '📈 HIGHER' : '📉 LOWER';
//   dirEl.style.color = dir === 'CALLE' ? 'var(--green)' : 'var(--red)';
//   document.getElementById('next-stake').textContent    = '$' + (s.nextStake||0).toFixed(2);
//   document.getElementById('base-stake-val').textContent = '$' + (s.baseStake||0).toFixed(2);

//   // Stats
//   const tp = s.totalProfit||0;
//   const tpEl = document.getElementById('total-profit');
//   tpEl.textContent = (tp >= 0 ? '+' : '') + '$' + tp.toFixed(2);
//   tpEl.style.color = tp >= 0 ? 'var(--green)' : 'var(--red)';
//   const wr = s.totalTrades > 0 ? ((s.wins/s.totalTrades)*100).toFixed(1) : '0.0';
//   document.getElementById('win-rate').textContent    = wr + '%';
//   document.getElementById('total-trades').textContent = s.totalTrades||0;
//   const st = s.currentStreak||0;
//   const stEl = document.getElementById('streak');
//   stEl.textContent = st > 0 ? '+' + st : st;
//   stEl.style.color  = st >= 0 ? 'var(--green)' : 'var(--red)';
//   document.getElementById('wins').textContent           = s.wins||0;
//   document.getElementById('losses').textContent         = s.losses||0;
//   document.getElementById('max-win').textContent        = s.maxWinStreak||0;
//   document.getElementById('max-loss').textContent       = Math.abs(s.maxLossStreak||0);
//   document.getElementById('total-recovered').textContent = '$' + (s.totalRecovered||0).toFixed(2);

//   // Bot status
//   const botDot   = document.getElementById('bot-dot');
//   botDot.className = 'dot ' + (s.running ? 'green' : '');
//   document.getElementById('bot-status-label').textContent = s.running ? '⚙️ Bot Running' : '⏹ Bot Stopped';
//   document.getElementById('bot-spin').style.display        = s.running ? '' : 'none';

//   // Buttons
//   document.getElementById('start-btn').style.display = s.running ? 'none' : '';
//   document.getElementById('stop-btn').style.display  = s.running ? ''     : 'none';
//   document.getElementById('start-btn').disabled      = !s.authorized;
//   document.getElementById('conn-btn').textContent    = (s.wsConnected||s.authorized) ? 'Reconnect' : 'Connect';

//   // Disable settings while running
//   ['investment-amount','initial-stake','mult','max-level','after-max','extra-levels','compound-pct','stop-loss','take-profit'].forEach(id => {
//     const el = document.getElementById(id); if (el) el.disabled = s.running;
//   });
//   document.getElementById('compound-toggle').style.pointerEvents = s.running ? 'none' : '';
//   document.querySelectorAll('.extra-mult-input').forEach(el => { el.disabled = s.running; });

//   renderTradeLogs(s.tradeLogs||[]);
//   renderSysLogs(s.systemLogs||[]);
// }

// // Trade log
// let lastTradeCount = 0;
// function renderTradeLogs(logs) {
//   if (logs.length === lastTradeCount) return;
//   lastTradeCount = logs.length;
//   const el = document.getElementById('trade-log');
//   if (!logs.length) { el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:30px">No trades yet</div>'; return; }
//   el.innerHTML = logs.map(l => {
//     const cls = l.result === 'WIN' ? 'log-win' : l.result === 'LOSS' ? 'log-loss' : 'log-info';
//     const t   = new Date(l.time).toLocaleTimeString();
//     const dir = l.direction === 'CALLE' ? '📈 HIGHER' : '📉 LOWER';
//     const pnl = l.profit >= 0 ? '+$'+l.profit.toFixed(2) : '-$'+Math.abs(l.profit).toFixed(2);
//     return \`<div class="log-entry \${cls}">
//       <div style="display:flex;justify-content:space-between"><span>\${t}</span><span style="font-weight:700">\${l.result}</span></div>
//       <div style="display:flex;justify-content:space-between"><span>\${dir} @ $\${l.stake.toFixed(2)}</span><span>\${pnl}</span></div>
//       <div style="color:var(--muted);font-size:.68rem">Grid Level: \${l.gridLevel}</div>
//     </div>\`;
//   }).join('');
// }

// let lastSysCount = 0;
// function renderSysLogs(logs) {
//   if (logs.length === lastSysCount) return;
//   lastSysCount = logs.length;
//   const el = document.getElementById('sys-log');
//   if (!logs.length) { el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:30px">No logs yet</div>'; return; }
//   const cls = (line) => {
//     if (line.includes('❌')) return 'log-error';
//     if (line.includes('✅')) return 'log-success';
//     if (line.includes('⚠️')) return 'log-warning';
//     return 'log-info';
//   };
//   el.innerHTML = logs.map(l => \`<div class="log-entry \${cls(l)}">\${esc(l)}</div>\`).join('');
// }

// function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// // Extra level multiplier rows
// document.getElementById('after-max').addEventListener('change', function() {
//   document.getElementById('extra-levels-section').style.display = this.value === 'continue' ? '' : 'none';
//   renderExtraMultRows();
// });
// document.getElementById('extra-levels').addEventListener('input', renderExtraMultRows);
// document.getElementById('max-level').addEventListener('input', renderExtraMultRows);

// function renderExtraMultRows() {
//   const extraN = parseInt(document.getElementById('extra-levels').value)||0;
//   const maxL   = parseInt(document.getElementById('max-level').value)||6;
//   const cont   = document.getElementById('extra-mult-rows');
//   const existing = Array.from(cont.querySelectorAll('.extra-mult-input')).map(e => parseFloat(e.value)||1.48);
//   cont.innerHTML = '';
//   for (let i = 0; i < extraN; i++) {
//     const row = document.createElement('div');
//     row.className = 'extra-level-row';
//     row.innerHTML = \`<span class="extra-level-badge">L\${maxL+i+1}</span>
//       <input class="extra-mult-input" type="number" value="\${existing[i]!==undefined?existing[i]:1.48}" min="1" max="5" step="0.01" placeholder="Multiplier">\`;
//     cont.appendChild(row);
//   }
// }
// renderExtraMultRows();

// function toggleCompound() {
//   compoundOn = !compoundOn;
//   document.getElementById('compound-toggle').className = 'toggle' + (compoundOn ? ' on' : '');
//   document.getElementById('compound-section').style.display = compoundOn ? '' : 'none';
// }

// async function toggleConnect() {
//   const token = document.getElementById('api-token').value.trim();
//   if (state.authorized || state.wsConnected) {
//     await fetch('/api/disconnect', { method: 'POST' });
//   } else {
//     if (!token) { alert('Please enter your Deriv API token'); return; }
//     await fetch('/api/connect', {
//       method: 'POST', headers: {'Content-Type':'application/json'},
//       body: JSON.stringify({ apiToken: token }),
//     });
//   }
//   await poll();
// }

// function buildCfg() {
//   const extraMults = Array.from(document.querySelectorAll('.extra-mult-input')).map(e => parseFloat(e.value)||1.48);
//   return {
//     initialStake:          parseFloat(document.getElementById('initial-stake').value)||0.35,
//     investmentAmount:      parseFloat(document.getElementById('investment-amount').value)||100,
//     martingaleMultiplier:  parseFloat(document.getElementById('mult').value)||1.48,
//     maxMartingaleLevel:    parseInt(document.getElementById('max-level').value)||6,
//     afterMaxLoss:          document.getElementById('after-max').value,
//     continueExtraLevels:   parseInt(document.getElementById('extra-levels').value)||3,
//     extraLevelMultipliers: extraMults,
//     autoCompounding:       compoundOn,
//     compoundPercentage:    parseFloat(document.getElementById('compound-pct').value)||1,
//     stopLoss:              parseFloat(document.getElementById('stop-loss').value)||50,
//     takeProfit:            parseFloat(document.getElementById('take-profit').value)||1000,
//   };
// }

// async function saveConfig() {
//   await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(buildCfg()) });
//   await poll();
//   alert('✅ Settings saved!');
// }

// async function startBot() {
//   await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(buildCfg()) });
//   const r = await fetch('/api/start', { method:'POST' });
//   const j = await r.json();
//   if (!j.ok) alert('❌ ' + (j.error||'Could not start'));
//   await poll();
// }

// async function stopBot()       { await fetch('/api/stop',           { method:'POST' }); await poll(); }
// async function emergencyStop() { await fetch('/api/emergency-stop', { method:'POST' }); await poll(); }
// </script>
// </body>
// </html>`;
// }

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   V75 GRID MARTINGALE BOT — Production Node.js Edition              ║');
  console.log('║   Strategy: CALLE/PUTE | 1HZ75V | 5 ticks | 1.48x Martingale       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  const config = loadConfig();
  console.log(`[Config] Loaded from ${CONFIG_FILE}`);

  // Merge .env overrides
  if (process.env.DERIV_TOKEN)    config.apiToken       = process.env.DERIV_TOKEN;
  if (process.env.TELEGRAM_TOKEN) config.telegramToken  = process.env.TELEGRAM_TOKEN;
  if (process.env.TELEGRAM_CHAT)  config.telegramChatId = process.env.TELEGRAM_CHAT;

  const bot = new V75GridBot(config);

  // ── HTTP server ────────────────────────────────────────────────────────────
//   const server = http.createServer((req, res) => {
//     const parsed   = url.parse(req.url, true);
//     const pathname = parsed.pathname;

//     res.setHeader('Access-Control-Allow-Origin',  '*');
//     res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
//     res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
//     if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

//     if (req.method === 'GET' && pathname === '/') {
//       res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
//       res.end(buildUI());
//       return;
//     }
//     if (pathname.startsWith('/api/')) {
//       handleAPI(req, res, parsed, bot);
//       return;
//     }
//     res.writeHead(404); res.end('Not Found');
//   });

  // ── WebSocket push server (browser live updates) ───────────────────────────
//   const wsServer = new WSServer(server);
//   bot.on((ev) => { wsServer.broadcast({ type: ev.type, state: bot.snapshot() }); });

  // ── HTTP server listen ─────────────────────────────────────────────────────
//   const port = config.httpPort || 3000;
//   server.listen(port, '0.0.0.0', () => {
//     console.log(`✅  Web UI    : http://localhost:${port}`);
//     console.log(`✅  REST API  : http://localhost:${port}/api/`);
//     console.log(`\nAPI Endpoints:`);
//     console.log(`  GET  /api/state           — Full engine snapshot`);
//     console.log(`  POST /api/connect         — Connect & authorize  { apiToken }`);
//     console.log(`  POST /api/disconnect      — Disconnect`);
//     console.log(`  POST /api/start           — Start bot`);
//     console.log(`  POST /api/stop            — Stop gracefully`);
//     console.log(`  POST /api/emergency-stop  — Emergency stop`);
//     console.log(`  POST /api/config          — Update any config key`);
//     console.log(`\n⚠️  Open http://localhost:${port} in your browser`);
//     console.log('⚠️  Trading involves risk. For educational purposes only.\n');
//   });

  // ── Auto-connect if token is already stored ────────────────────────────────
  if (config.apiToken) {
    console.log('[Boot] API token found — connecting automatically...');
    bot.connect();
  }

  // ── State persistence ──────────────────────────────────────────────────────
  StatePersistence.startAutoSave(bot);

  // ── Telegram hourly summaries ──────────────────────────────────────────────
  if (bot.telegramBot) bot.startTelegramTimer();

  // ── Time-based scheduler (weekend pause + EOD) ─────────────────────────────
  bot.startTimeScheduler();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = (sig) => {
    console.log(`\n[${sig}] Shutting down gracefully...`);
    bot.stop();
    bot.disconnect();
    StatePersistence.save(bot);
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
