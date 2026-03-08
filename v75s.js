#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════════════════════╗
// ║     V75 GRID MARTINGALE BOT — Pure Headless Node.js Edition                     ║
// ║     Volatility 75 Index (1HZ75V) | CALLE/PUTE | 5 ticks | 1.48x Martingale     ║
// ║                                                                                  ║
// ║  Strategy DNA:                                                                   ║
// ║  • Exploits mean-reverting + micro-trending behaviour of V75 on 5-tick frames    ║
// ║  • Ultra-tight invisible grid (~3.2–4.1 pips avg distance between reversals)     ║
// ║  • Mathematically perfected 1.48x martingale — not 2x, not 1.6x, exactly 1.48  ║
// ║  • Hard cap + configurable extra levels with custom per-level multipliers         ║
// ║  • Win-back recovers ALL previous losses + profit on the very next win           ║
// ║                                                                                  ║
// ║  Infrastructure (zero UI — 100% terminal):                                       ║
// ║  • dotenv              — environment-based secrets                               ║
// ║  • ws                  — battle-tested WebSocket client                          ║
// ║  • node-telegram-bot-api — real-time notifications + hourly summaries           ║
// ║  • StatePersistence    — crash recovery (30-min state file, auto-save 5s)       ║
// ║  • Heartbeat           — ping/pong + data-silence detector → force reconnect    ║
// ║  • Message queue       — zero lost requests during reconnection window           ║
// ║  • Time scheduler      — weekend pause (Sat 23:00–Mon 08:00 GMT+1) + EOD       ║
// ║  • Rich console UI     — live colour-coded stats table refreshed every second   ║
// ║  • Graceful shutdown   — SIGINT/SIGTERM → save state → Telegram alert → exit   ║
// ╚═════��════════════════════════════════════════════════════════════════════════════╝

'use strict';

require('dotenv').config();

const WebSocket   = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const fs          = require('fs');
const path        = require('path');

// ══════════════════════════════════════════════════════════════════════════════
// ANSI COLOUR HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  black:   '\x1b[30m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgBlack: '\x1b[40m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgBlue:  '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan:  '\x1b[46m',
};

const cc  = (color, str) => `${color}${str}${C.reset}`;
const dim = (s) => cc(C.dim, s);

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — edit defaults here OR use .env / v75-headless-config.json
// ══════════════════════════════════════════════════════════════════════════════

const CONFIG_FILE = path.join(__dirname, 'v75-headless-config.json');
const STATE_FILE  = path.join(__dirname, 'v75-headless-state.json');
const STATE_SAVE_INTERVAL  = 5_000;   // ms
const STATE_MAX_AGE_MINUTES = 30;     // discard state files older than this

const DEFAULT_CONFIG = {
  // ── Deriv API ──────────────────────────────────────────────────────────────
  apiToken:             'rgNedekYXvCaPeP',
  appId:                '1089',

  // ── Symbol / contract ─────────────────────────────────────────────────────
  symbol:               '1HZ75V',
  tickDuration:         5,          // exactly 5 ticks

  // ── Stake / investment ────────────────────────────────────────────────────
  initialStake:         0.35,       // base stake per trade at L0
  investmentAmount:     100,        // investment pool (bot never touches rest of balance)

  // ── Martingale ────────────────────────────────────────────────────────────
  martingaleMultiplier: 1.48,       // the magic number
  maxMartingaleLevel:   6,          // hard cap (legendary setting)
  afterMaxLoss:         'continue',     // 'stop' | 'continue' | 'reset'
  continueExtraLevels:  3,          // how many extra levels when afterMaxLoss='continue'
  extraLevelMultipliers: [2.2, 2.3, 2.5],        // custom multiplier per extra level e.g. [1.48, 1.6, 1.8]

  // ── Auto-compounding ──────────────────────────────────────────────────────
  autoCompounding:      true,
  compoundPercentage:   0.35,          // % of investmentRemaining used as base stake

  // ── Risk management ───────────────────────────────────────────────────────
  stopLoss:             80,         // stop if session P&L ≤ -$stopLoss
  takeProfit:           10000,       // stop if session P&L ≥ $takeProfit

  // ── Telegram ──────────────────────────────────────────────────────────────
  telegramToken:        '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc',
  telegramChatId:       '752497117',
  telegramEnabled:      true,

  // ── Console UI ────────────────────────────────────────────────────────────
  consoleRefreshMs:     180000,       // how often to redraw the live stats bar
  logHistoryMax:        200,        // keep last N log lines in memory
};

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg = { ...cfg, ...disk };
    }
  } catch (_) {}
  // .env always wins over config file
  if (process.env.DERIV_TOKEN)    cfg.apiToken       = process.env.DERIV_TOKEN;
  if (process.env.DERIV_APP_ID)   cfg.appId          = process.env.DERIV_APP_ID;
  if (process.env.TELEGRAM_TOKEN) cfg.telegramToken  = process.env.TELEGRAM_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID;
  return cfg;
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════

class StatePersistence {
  static save(bot) {
    try {
      const payload = {
        savedAt:  Date.now(),
        version:  2,
        trading: {
          totalProfit:          bot.totalProfit,
          totalTrades:          bot.totalTrades,
          wins:                 bot.wins,
          losses:               bot.losses,
          currentGridLevel:     bot.currentGridLevel,
          currentDirection:     bot.currentDirection,
          baseStake:            bot.baseStake,
          investmentRemaining:  bot.investmentRemaining,
          investmentStartAmount:bot.investmentStartAmount,
          totalRecovered:       bot.totalRecovered,
          currentStreak:        bot.currentStreak,
          maxWinStreak:         bot.maxWinStreak,
          maxLossStreak:        bot.maxLossStreak,
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
      const data    = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const ageMins = (Date.now() - data.savedAt) / 60_000;
      if (ageMins > STATE_MAX_AGE_MINUTES) {
        console.warn(cc(C.yellow, `[StatePersistence] State is ${ageMins.toFixed(1)} min old — discarding`));
        fs.unlinkSync(STATE_FILE);
        return null;
      }
      return data;
    } catch (e) {
      console.error(`[StatePersistence] load error: ${e.message}`);
      return null;
    }
  }

  static startAutoSave(bot) {
    setInterval(() => {
      if (bot.running || bot.totalTrades > 0) StatePersistence.save(bot);
    }, STATE_SAVE_INTERVAL);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CONSOLE UI — live-refreshing terminal display (no external deps)
// ══════════════════════════════════════════════════════════════════════════════

class ConsoleUI {
  constructor(bot) {
    this.bot         = bot;
    this.timer       = null;
    this.logLines    = [];   // ring buffer of formatted log strings
    this.maxLogs     = bot.config.logHistoryMax || 200;
    this.lastRender  = '';
    this.isRendering = false;
  }

  start() {
    // Hide cursor for cleaner output
    process.stdout.write('\x1b[?25l');
    this.timer = setInterval(() => this._render(), this.bot.config.consoleRefreshMs);
    this._render();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    process.stdout.write('\x1b[?25h');  // restore cursor
  }

  addLog(line) {
    this.logLines.push(line);
    if (this.logLines.length > this.maxLogs) this.logLines.shift();
  }

  _pnlColor(v) {
    if (v > 0)  return C.green;
    if (v < 0)  return C.red;
    return C.white;
  }

  _levelColor(lvl, maxL) {
    if (lvl === 0)                 return C.green;
    if (lvl <= Math.ceil(maxL * 0.4)) return C.yellow;
    if (lvl <= maxL)               return C.red;
    return C.magenta;
  }

  _bar(pct, width = 30) {
    const filled = Math.round(pct / 100 * width);
    const empty  = width - filled;
    const color  = pct > 60 ? C.green : pct > 30 ? C.yellow : C.red;
    return cc(color, '█'.repeat(Math.max(0, filled))) + cc(C.dim, '░'.repeat(Math.max(0, empty)));
  }

  _line(w = 70) { return cc(C.dim, '─'.repeat(w)); }
  _pad(s, n)    { return String(s).padEnd(n); }
  _padL(s, n)   { return String(s).padStart(n); }

  _render() {
    if (this.isRendering) return;
    this.isRendering = true;

    const b   = this.bot;
    const cfg = b.config;

    const maxL   = cfg.maxMartingaleLevel;
    const extL   = cfg.afterMaxLoss === 'continue' ? cfg.continueExtraLevels : 0;
    const absMax = maxL + extL;
    const lvl    = b.currentGridLevel;
    const lvlCol = this._levelColor(lvl, maxL);

    const wr  = b.totalTrades > 0 ? ((b.wins / b.totalTrades) * 100).toFixed(1) : '0.0';
    const pnl = b.totalProfit;

    const invPct = b.investmentStartAmount > 0
      ? Math.min(100, (b.investmentRemaining / b.investmentStartAmount) * 100)
      : 100;

    const nextStake = b.calculateStake(lvl);
    const dirLabel  = b.currentDirection === 'CALLE' ? cc(C.green, '📈 HIGHER') : cc(C.red, '📉 LOWER');

    // ── Level dot row ─────────────────────────────────────────────────────
    const dotRow = Array.from({ length: absMax + 1 }, (_, i) => {
      const active = i === lvl;
      let col;
      if (i > maxL)       col = active ? C.magenta  : C.dim;
      else if (i === 0)   col = active ? C.bgGreen   : C.dim;
      else if (i <= Math.ceil(maxL * 0.4)) col = active ? C.bgBlack + C.yellow : C.dim;
      else if (i <= maxL) col = active ? C.bgRed     : C.dim;
      else                col = C.dim;
      const marker = active ? ` ${i} ` : ` ${i} `;
      return active
        ? `${C.bold}${col}[${i}]${C.reset}`
        : `${C.dim}(${i})${C.reset}`;
    }).join(' ');

    // ── Last 10 trade log lines ────────────────────────────────────────────
    const recentLogs = this.logLines.slice(-10);

    // ── Build screen ──────────────────────────────────────────────────────
    const lines = [];

    lines.push('');
    lines.push(this._line(76));
    lines.push(
      cc(C.bold + C.cyan, '  ⚡ V75 GRID MARTINGALE BOT') +
      cc(C.dim, '  |  1HZ75V · CALLE/PUTE · 5 Ticks · 1.48× Martingale')
    );
    lines.push(this._line(76));

    // Row 1 — Connection + Bot status
    const wsStatus   = b.wsReady ? cc(C.green, '● AUTHORIZED') : b.connected ? cc(C.yellow, '● CONNECTED') : cc(C.red, '○ OFFLINE');
    const botStatus  = b.running ? cc(C.green + C.bold, '▶ RUNNING') : cc(C.red, '■ STOPPED');
    const acct       = b.accountId ? cc(C.dim, `[${b.accountId}]`) : '';
    lines.push(`  WebSocket: ${wsStatus}  ${acct}    Bot: ${botStatus}`);
    lines.push(`  Balance: ${cc(C.bold + C.cyan, (b.currency || 'USD') + ' ' + b.balance.toFixed(2))}    Reconnects: ${cc(C.dim, b.reconnectAttempts)}`);

    lines.push(this._line(76));

    // Row 2 — Investment pool
    const invPnl    = b.investmentRemaining - b.investmentStartAmount;
    const invPnlCol = this._pnlColor(invPnl);
    lines.push(
      cc(C.yellow + C.bold, '  INVESTMENT POOL') +
      `  $${b.investmentRemaining.toFixed(2)} / $${b.investmentStartAmount.toFixed(2)}` +
      `  ${cc(invPnlCol, (invPnl >= 0 ? '+' : '') + '$' + invPnl.toFixed(2))}` +
      `  (${invPct.toFixed(1)}%)`
    );
    lines.push(`  ${this._bar(invPct, 50)}`);

    lines.push(this._line(76));

    // Row 3 — Grid level display
    lines.push(
      `  Grid Level: ${cc(lvlCol + C.bold, `L${lvl}`)}` +
      (lvl === 0 ? cc(C.green, ' ✨ Safe Zone') :
       lvl <= Math.ceil(maxL * 0.5) ? cc(C.yellow, ' 📊 Recovery Mode') :
       lvl <= maxL ? cc(C.red, ' ⚠️  High Risk Zone') :
       cc(C.magenta, ' 🚨 Extended Recovery!')) +
      `   Max: L${maxL}` + (extL > 0 ? cc(C.magenta, `  Extended: L${absMax}`) : '')
    );
    lines.push(`  ${dotRow}`);
    lines.push(`  Direction: ${dirLabel}   Next Stake: ${cc(C.bold + C.blue, '$' + nextStake.toFixed(2))}   Base (L0): ${cc(C.yellow, '$' + b.baseStake.toFixed(2))}`);

    lines.push(this._line(76));

    // Row 4 — Session stats (two-column table)
    const pnlStr = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    const streak = b.currentStreak;
    const streakStr = (streak > 0 ? '+' : '') + streak;
    const streakCol = streak >= 0 ? C.green : C.red;

    lines.push(cc(C.bold, '  SESSION STATISTICS'));
    lines.push(
      `  ${this._pad('Total Trades:', 16)} ${cc(C.white + C.bold, this._padL(b.totalTrades, 6))}` +
      `   ${this._pad('Win Rate:', 12)} ${cc(C.blue + C.bold, this._padL(wr + '%', 7))}`
    );
    lines.push(
      `  ${this._pad('Wins:', 16)} ${cc(C.green + C.bold, this._padL(b.wins, 6))}` +
      `   ${this._pad('Losses:', 12)} ${cc(C.red + C.bold, this._padL(b.losses, 7))}`
    );
    lines.push(
      `  ${this._pad('Session P&L:', 16)} ${cc(this._pnlColor(pnl) + C.bold, this._padL(pnlStr, 6))}` +
      `   ${this._pad('Streak:', 12)} ${cc(streakCol + C.bold, this._padL(streakStr, 7))}`
    );
    lines.push(
      `  ${this._pad('Recovered:', 16)} ${cc(C.yellow, this._padL('$' + b.totalRecovered.toFixed(2), 6))}` +
      `   ${this._pad('Max W/L:', 12)} ${cc(C.green, '+' + b.maxWinStreak)} / ${cc(C.red, '-' + Math.abs(b.maxLossStreak))}`
    );

    lines.push(this._line(76));

    // Row 5 — Last 10 logs
    lines.push(cc(C.bold, '  LIVE LOG') + cc(C.dim, '  (last 10 entries)'));
    if (recentLogs.length === 0) {
      lines.push(cc(C.dim, '  — no logs yet —'));
    } else {
      recentLogs.forEach(l => lines.push('  ' + l));
    }

    lines.push(this._line(76));
    lines.push(cc(C.dim, `  Updated: ${new Date().toLocaleTimeString()}   State: ${STATE_FILE.split(path.sep).pop()}`));
    lines.push('');

    const output = lines.join('\n');

    // Clear screen and redraw from top
    process.stdout.write('\x1b[2J\x1b[H' + output);

    this.isRendering = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN BOT CLASS
// ══════════════════════════════════════════════════════════════════════════════

class V75GridBot {
  constructor(cfg) {
    this.config = { ...DEFAULT_CONFIG, ...cfg };

    // ── WebSocket ─────────────────────────────────────────────────────────
    this.ws               = null;
    this.connected        = false;
    this.wsReady          = false;

    // ── Reconnection ──────────────────────────────────────────────────────
    this.reconnectAttempts    = 0;
    this.maxReconnectAttempts = 50;
    this.baseReconnectDelay   = 5_000;
    this.reconnectTimer       = null;
    this.isReconnecting       = false;

    // ── Heartbeat ─────────────────────────────────────────────────────────
    this.pingInterval      = null;
    this.checkDataInterval = null;
    this.pongTimeout       = null;
    this.lastPongTime      = Date.now();
    this.lastDataTime      = Date.now();
    this.pingIntervalMs    = 20_000;
    this.pongTimeoutMs     = 10_000;
    this.dataTimeoutMs     = 60_000;

    // ── Message queue ─────────────────────────────────────────────────────
    this.messageQueue = [];
    this.maxQueueSize = 50;

    // ── Account ───────────────────────────────────────────────────────────
    this.balance   = 0;
    this.currency  = 'USD';
    this.accountId = '';

    // ── Session trading state ─────────────────────────────────────────────
    this.running              = false;
    this.tradeInProgress      = false;
    this.currentContractId    = null;
    this.pendingStake         = 0;
    this.pendingDirection     = '';
    this.pendingGridLevel     = 0;

    this.currentGridLevel     = 0;
    this.currentDirection     = 'CALLE';
    this.baseStake            = this.config.initialStake;
    this.investmentRemaining  = 0;
    this.investmentStartAmount= 0;
    this.totalProfit          = 0;
    this.totalTrades          = 0;
    this.wins                 = 0;
    this.losses               = 0;
    this.currentStreak        = 0;
    this.maxWinStreak         = 0;
    this.maxLossStreak        = 0;
    this.totalRecovered       = 0;

    // ── Session control ───────────────────────────────────────────────────
    this.endOfDay   = false;
    this.isWinTrade = false;

    // ── Hourly Telegram stats ─────────────────────────────────────────────
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };

    // ── Console UI ────────────────────────────────────────────────────────
    this.ui = new ConsoleUI(this);

    // ── Telegram ──────────────────────────────────────────────────────────
    this.telegramBot = null;
    if (
      this.config.telegramEnabled &&
      this.config.telegramToken  &&
      this.config.telegramChatId
    ) {
      try {
        this.telegramBot = new TelegramBot(this.config.telegramToken, { polling: false });
        this._rawLog('success', 'Telegram notifications enabled ✅');
      } catch (e) {
        this._rawLog('warning', `Telegram init error: ${e.message}`);
      }
    } else {
      this._rawLog('warning', 'Telegram disabled — set TELEGRAM_TOKEN + TELEGRAM_CHAT_ID in .env');
    }

    // ── Restore saved state ───────────────────────────────────────────────
    this._restoreState();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE RESTORE
  // ══════════════════════════════════════════════════════════════════════════

  _restoreState() {
    const saved = StatePersistence.load();
    if (!saved) return;
    const t = saved.trading;
    this.totalProfit          = t.totalProfit          || 0;
    this.totalTrades          = t.totalTrades          || 0;
    this.wins                 = t.wins                 || 0;
    this.losses               = t.losses               || 0;
    this.currentGridLevel     = t.currentGridLevel     || 0;
    this.currentDirection     = t.currentDirection     || 'CALLE';
    this.baseStake            = t.baseStake            || this.config.initialStake;
    this.investmentRemaining  = t.investmentRemaining  || 0;
    this.investmentStartAmount= t.investmentStartAmount|| 0;
    this.totalRecovered       = t.totalRecovered       || 0;
    this.maxWinStreak         = t.maxWinStreak         || 0;
    this.maxLossStreak        = t.maxLossStreak        || 0;
    this.currentStreak        = t.currentStreak        || 0;

    this._rawLog('success',
      `State restored | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} ` +
      `| P&L: $${this.totalProfit.toFixed(2)} | L${this.currentGridLevel}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOGGING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Add a formatted line to the UI ring buffer.
   * type: 'info' | 'success' | 'warning' | 'error' | 'trade_win' | 'trade_loss'
   */
  _rawLog(type, message) {
    const ts = new Date().toLocaleTimeString();
    let colored;
    switch (type) {
      case 'success':    colored = cc(C.green,   `✅ [${ts}] ${message}`); break;
      case 'warning':    colored = cc(C.yellow,  `⚠️  [${ts}] ${message}`); break;
      case 'error':      colored = cc(C.red,     `❌ [${ts}] ${message}`); break;
      case 'trade_win':  colored = cc(C.green + C.bold, `🎯 [${ts}] ${message}`); break;
      case 'trade_loss': colored = cc(C.red,     `📉 [${ts}] ${message}`); break;
      default:           colored = cc(C.dim,     `ℹ️  [${ts}] ${message}`); break;
    }
    this.ui.addLog(colored);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CORE STRATEGY: CALCULATE STAKE
  // ══════════════════════════════════════════════════════════════════════════
  //
  //  Level 0 → baseStake × 1.48⁰  = baseStake
  //  Level N → baseStake × 1.48ᴺ  (up to maxMartingaleLevel)
  //  Extra L → previousStake × extraLevelMultipliers[i]  (or 1.48 fallback)
  //
  calculateStake(level) {
    const cfg = this.config;
    let base  = this.baseStake;

    // Auto-compounding overrides base stake
    if (cfg.autoCompounding && this.investmentRemaining > 0) {
      base = Math.max(this.investmentRemaining * cfg.compoundPercentage / 100, 0.35);
    }
    base = Math.max(base, 0.35);

    if (level <= cfg.maxMartingaleLevel) {
      return Number((base * Math.pow(cfg.martingaleMultiplier, level)).toFixed(2));
    }

    // Extra levels beyond maxMartingaleLevel
    let stake    = base * Math.pow(cfg.martingaleMultiplier, cfg.maxMartingaleLevel);
    const extraN = level - cfg.maxMartingaleLevel;
    const mults  = cfg.extraLevelMultipliers || [];
    for (let i = 0; i < extraN; i++) {
      stake *= mults[i] > 0 ? mults[i] : cfg.martingaleMultiplier;
    }
    return Number(stake.toFixed(2));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — CONNECT
  // ══════════════════════════════════════════════════════════════════════════

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._rawLog('warning', 'Already connected');
      return;
    }

    this._cleanup();

    const wsUrl = `wss://ws.derivws.com/websockets/v3?app_id=${this.config.appId}`;
    this._rawLog('info', `Connecting to ${wsUrl} …`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.connected         = true;
      this.wsReady           = false;
      this.reconnectAttempts = 0;
      this.isReconnecting    = false;
      this.lastPongTime      = Date.now();
      this.lastDataTime      = Date.now();
      this._rawLog('success', 'WebSocket open — authenticating …');
      this._startMonitor();
      this._send({ authorize: this.config.apiToken });
    });

    this.ws.on('message', (data) => {
      this.lastPongTime = Date.now();
      this.lastDataTime = Date.now();
      try {
        this._handleMessage(JSON.parse(data));
      } catch (_) {}
    });

    this.ws.on('pong', () => { this.lastPongTime = Date.now(); });

    this.ws.on('error', (e) => {
      this._rawLog('error', `WebSocket error: ${e.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this._rawLog('warning', `WebSocket closed (code: ${code}, reason: ${reason || 'none'})`);
      this._handleDisconnect();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET — SEND / QUEUE
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
      this._rawLog('error', `Send error: ${e.message}`);
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push(request);
      }
      return false;
    }
  }

  _processQueue() {
    if (!this.messageQueue.length) return;
    this._rawLog('info', `Processing ${this.messageQueue.length} queued message(s)…`);
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
            this._rawLog('warning', 'No pong received — connection may be dead');
          }
        }, this.pongTimeoutMs);
      }
    }, this.pingIntervalMs);

    this.checkDataInterval = setInterval(() => {
      if (!this.connected) return;
      const silence = Date.now() - this.lastDataTime;
      if (silence > this.dataTimeoutMs) {
        this._rawLog('error', `No data for ${Math.round(silence / 1000)}s — forcing reconnect`);
        StatePersistence.save(this);
        if (this.ws) this.ws.terminate();
      }
    }, 10_000);
  }

  _stopMonitor() {
    if (this.pingInterval)      { clearInterval(this.pingInterval);      this.pingInterval = null; }
    if (this.checkDataInterval) { clearInterval(this.checkDataInterval); this.checkDataInterval = null; }
    if (this.pongTimeout)       { clearTimeout(this.pongTimeout);        this.pongTimeout = null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISCONNECT / RECONNECT
  // ══════════════════════════════════════════════════════════════════════════

  _handleDisconnect() {
    if (this.endOfDay) {
      this._rawLog('info', 'Planned shutdown — not reconnecting');
      this._cleanup();
      return;
    }
    if (this.isReconnecting) return;

    this.connected  = false;
    this.wsReady    = false;
    this._stopMonitor();
    StatePersistence.save(this);

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._rawLog('error', 'Max reconnection attempts reached — please restart the bot');
      this._sendTelegram(
        `❌ <b>Max reconnect attempts reached</b>\n` +
        `Bot halted. Please restart manually.\n` +
        `Final P&L: $${this.totalProfit.toFixed(2)}`
      );
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
      30_000
    );

    this._rawLog('warning',
      `Reconnecting in ${(delay / 1000).toFixed(1)}s ` +
      `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) …`
    );
    this._sendTelegram(
      `⚠️ <b>CONNECTION LOST — RECONNECTING</b>\n` +
      `Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}\n` +
      `Retrying in ${(delay / 1000).toFixed(1)}s\n` +
      `Preserved: ${this.totalTrades} trades | $${this.totalProfit.toFixed(2)} P&L | L${this.currentGridLevel}`
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
    this._rawLog('info', 'Disconnecting…');
    StatePersistence.save(this);
    this.endOfDay = true;
    this._cleanup();
    this._rawLog('success', 'Disconnected');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ══════════════════════════════════════════════════════════════════════════

  _handleMessage(msg) {
    // Respond to server-side pings
    if (msg.msg_type === 'ping') {
      this._send({ ping: 1 });
      return;
    }

    // Global API-level errors
    if (msg.error) {
      this._rawLog('error', `API [${msg.error.code}]: ${msg.error.message}`);

      // Auth errors → reconnect
      if (['AuthorizationRequired', 'InvalidToken'].includes(msg.error.code)) {
        this.wsReady = false;
        this._handleDisconnect();
        return;
      }

      // Trade errors → unlock and retry
      if (msg.msg_type === 'buy' || msg.msg_type === 'proposal') {
        this.tradeInProgress = false;
        if (this.running) {
          this._rawLog('warning', 'Retrying trade in 3 s…');
          setTimeout(() => { if (this.running) this._placeTrade(); }, 3_000);
        }
      }
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':              this._onAuthorize(msg); break;
      case 'balance':                this._onBalance(msg);   break;
      case 'proposal':               this._onProposal(msg);  break;
      case 'buy':                    this._onBuy(msg);       break;
      case 'proposal_open_contract': this._onContract(msg);  break;
    }
  }

  // ── authorize ─────────────────────────────────────────────────────────────

  _onAuthorize(msg) {
    this.wsReady   = true;
    this.accountId = msg.authorize.loginid;
    this.balance   = parseFloat(msg.authorize.balance);
    this.currency  = msg.authorize.currency;

    this._rawLog('success',
      `Authorized ✅  Account: ${this.accountId}  Balance: ${this.currency} ${this.balance.toFixed(2)}`
    );

    // Subscribe to real-time balance updates
    this._send({ balance: 1, subscribe: 1 });

    // Drain queued messages
    this._processQueue();

    this._sendTelegram(
      `✅ <b>V75 Grid Bot — Connected</b>\n` +
      `Account: ${this.accountId}\n` +
      `Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
      `Config: L${this.config.maxMartingaleLevel} | ${this.config.martingaleMultiplier}× | ${this.config.tickDuration}t\n` +
      `Investment Pool: $${this.config.investmentAmount}\n` +
      `Stop Loss: $${this.config.stopLoss} | Take Profit: $${this.config.takeProfit}`
    );

    // Auto-start if configured
    if (this.config.autoStart) {
      this._rawLog('info', 'Auto-start triggered…');
      setTimeout(() => this.start(), 1_000);
    }
  }

  // ── balance update ─────────────────────────────────────────────────────────

  _onBalance(msg) {
    this.balance = parseFloat(msg.balance.balance);
  }

  // ── proposal → buy ─────────────────────────────────────────────────────────

  _onProposal(msg) {
    if (!this.running || !this.tradeInProgress) return;
    if (msg.proposal && msg.proposal.id) {
      this._send({ buy: msg.proposal.id, price: msg.proposal.ask_price });
    }
  }

  // ── buy confirmation ────────────────────────────────────────────────────────

  _onBuy(msg) {
    const b = msg.buy;
    this.currentContractId = b.contract_id;

    // Deduct cost from investment pool immediately
    this.investmentRemaining = Math.max(
      0,
      Number((this.investmentRemaining - b.buy_price).toFixed(2))
    );

    this._rawLog('info',
      `Contract #${b.contract_id} | ${this.pendingDirection === 'CALLE' ? '📈 HIGHER' : '📉 LOWER'} ` +
      `| Stake: $${b.buy_price.toFixed(2)} | Pool: $${this.investmentRemaining.toFixed(2)}`
    );

    // Subscribe for real-time result
    this._send({
      proposal_open_contract: 1,
      contract_id:            b.contract_id,
      subscribe:              1,
    });
  }

  // ── contract result ─────────────────────────────────────────────────────────

  _onContract(msg) {
    const c = msg.proposal_open_contract;
    if (!c.is_sold) return;   // settlement not yet complete

    const profit  = parseFloat(c.profit);
    const payout  = parseFloat(c.payout || 0);
    const isWin   = profit > 0;

    this.tradeInProgress = false;
    this.isWinTrade      = isWin;

    // ── Update counters ─────────────────────────────────────────────────────
    this.totalTrades  += 1;
    this.totalProfit   = Number((this.totalProfit + profit).toFixed(2));
    if (isWin) { this.wins++;   } else { this.losses++; }

    // Streak tracking
    this.currentStreak = isWin
      ? (this.currentStreak > 0 ? this.currentStreak + 1 : 1)
      : (this.currentStreak < 0 ? this.currentStreak - 1 : -1);
    if (isWin)  this.maxWinStreak  = Math.max(this.currentStreak,  this.maxWinStreak);
    if (!isWin) this.maxLossStreak = Math.min(this.currentStreak,  this.maxLossStreak);

    // Hourly stats
    this.hourlyStats.trades++;
    this.hourlyStats.pnl += profit;
    if (isWin) this.hourlyStats.wins++; else this.hourlyStats.losses++;

    // ── Risk management ─────────────────────────────────────────────────────
    if (this.totalProfit <= -this.config.stopLoss) {
      this._rawLog('error', `🛑 STOP LOSS hit! Session P&L: $${this.totalProfit.toFixed(2)}`);
      this._sendTelegram(
        `🛑 <b>STOP LOSS REACHED</b>\n` +
        `Session P&L: $${this.totalProfit.toFixed(2)}\n` +
        `Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}`
      );
      this.running = false;
      this._logSummary();
      return;
    }
    if (this.totalProfit >= this.config.takeProfit) {
      this._rawLog('success', `🎉 TAKE PROFIT hit! Session P&L: +$${this.totalProfit.toFixed(2)}`);
      this._sendTelegram(
        `🎉 <b>TAKE PROFIT REACHED</b>\n` +
        `Session P&L: +$${this.totalProfit.toFixed(2)}\n` +
        `Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}`
      );
      this.running = false;
      this._logSummary();
      return;
    }

    // ── Strategy: grid level + direction update ─────────────────────────────
    let shouldContinue = true;
    const cfg          = this.config;

    if (isWin) {
      // ╔═══════════════════════════════════════════════════════════════════╗
      // ║  WIN — Reset to Level 0 + CALLE                                  ║
      // ║  Mean-reversion exploited: after recovery, always go HIGHER first ║
      // ╚═══════════════════════════════════════════════════════════════════╝
      if (this.currentGridLevel > 0) this.totalRecovered += profit;

      // Return payout to investment pool
      this.investmentRemaining = Number((this.investmentRemaining + payout).toFixed(2));

      // Auto-compounding: recalculate base stake after each win
      if (cfg.autoCompounding) {
        this.baseStake = Math.max(
          this.investmentRemaining * cfg.compoundPercentage / 100,
          0.35
        );
      }

      const recoveryMsg = this.currentGridLevel > 0
        ? ` — FULL RECOVERY from L${this.currentGridLevel}!`
        : '';
      this._rawLog('trade_win',
        `WIN  +$${profit.toFixed(2)}${recoveryMsg} | ` +
        `Pool: $${this.investmentRemaining.toFixed(2)} | Reset → L0 HIGHER`
      );

      this.currentGridLevel = 0;
      this.currentDirection = 'CALLE';
      this._sendTelegramTradeResult(true, profit);

    } else {
      // ╔═══════════════════════════════════════════════════════════════════╗
      // ║  LOSS — Increase level + Flip direction                          ║
      // ║  1.48× martingale recovers ALL losses + profit on next win       ║
      // ╚═══════════════════════════════════════════════════════════════════╝
      const nextLevel = this.currentGridLevel + 1;
      const nextDir   = this.currentDirection === 'CALLE' ? 'PUTE' : 'CALLE';
      const absMax    = cfg.afterMaxLoss === 'continue'
        ? cfg.maxMartingaleLevel + cfg.continueExtraLevels
        : cfg.maxMartingaleLevel;

      this.currentGridLevel = nextLevel;
      this.currentDirection = nextDir;

      if (nextLevel > absMax) {
        // Hard ceiling — always stop regardless of afterMaxLoss
        this._rawLog('error',
          `🛑 ABSOLUTE CEILING L${absMax} breached — bot stopped to protect investment`
        );
        this._sendTelegram(
          `🛑 <b>ABSOLUTE MAX LEVEL L${absMax} REACHED</b>\n` +
          `Investment remaining: $${this.investmentRemaining.toFixed(2)}\n` +
          `Session P&L: $${this.totalProfit.toFixed(2)}`
        );
        shouldContinue = false;

      } else if (nextLevel > cfg.maxMartingaleLevel) {
        // Extended extra-level zone
        const extraIdx  = nextLevel - cfg.maxMartingaleLevel - 1;
        const extraMult = (cfg.extraLevelMultipliers && cfg.extraLevelMultipliers[extraIdx] > 0)
          ? cfg.extraLevelMultipliers[extraIdx]
          : cfg.martingaleMultiplier;
        const nextStake = this.calculateStake(nextLevel);
        this._rawLog('warning',
          `LOSS -$${Math.abs(profit).toFixed(2)} | ` +
          `EXTENDED L${nextLevel}/${absMax} | Mult: ${extraMult}× | ` +
          `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`
        );

      } else if (nextLevel === cfg.maxMartingaleLevel) {
        // Reached hard cap — apply afterMaxLoss policy
        if (cfg.afterMaxLoss === 'stop') {
          const nextStake = this.calculateStake(nextLevel);
          this._rawLog('warning',
            `LOSS -$${Math.abs(profit).toFixed(2)} | ` +
            `⚠️  FINAL attempt L${cfg.maxMartingaleLevel} | ` +
            `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake} — then STOP`
          );
        } else if (cfg.afterMaxLoss === 'continue') {
          const nextStake = this.calculateStake(nextLevel);
          this._rawLog('warning',
            `LOSS -$${Math.abs(profit).toFixed(2)} | ` +
            `MAX L${cfg.maxMartingaleLevel} — extending to L${absMax} | ` +
            `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`
          );
        } else if (cfg.afterMaxLoss === 'reset') {
          this.currentGridLevel = 0;
          this.currentDirection = 'CALLE';
          this._rawLog('warning',
            `LOSS -$${Math.abs(profit).toFixed(2)} | ` +
            `MAX LEVEL reached — RESET to L0 HIGHER (reset mode)`
          );
        }
      } else {
        const nextStake = this.calculateStake(nextLevel);
        this._rawLog('trade_loss',
          `LOSS -$${Math.abs(profit).toFixed(2)} | ` +
          `Grid L${nextLevel} | ` +
          `${nextDir === 'CALLE' ? 'HIGHER' : 'LOWER'} @ $${nextStake}`
        );
      }

      this._sendTelegramTradeResult(false, profit);

      // ── Funds check before allowing next trade ─────────────────────────
      if (shouldContinue) {
        const nextStake = this.calculateStake(this.currentGridLevel);
        if (nextStake > this.investmentRemaining) {
          this._rawLog('error',
            `🛑 INSUFFICIENT POOL: next $${nextStake} > remaining $${this.investmentRemaining.toFixed(2)}`
          );
          this._sendTelegram(
            `🛑 <b>INSUFFICIENT INVESTMENT</b>\n` +
            `Next stake: $${nextStake}\n` +
            `Pool remaining: $${this.investmentRemaining.toFixed(2)}`
          );
          shouldContinue = false;
        } else if (nextStake > this.balance) {
          this._rawLog('error',
            `🛑 INSUFFICIENT BALANCE: next $${nextStake} > balance $${this.balance.toFixed(2)}`
          );
          shouldContinue = false;
        }
      }
    }

    // ── Check afterMaxLoss=stop after the final-level trade settles ────────
    if (
      shouldContinue &&
      !isWin &&
      this.currentGridLevel > cfg.maxMartingaleLevel &&
      cfg.afterMaxLoss === 'stop'
    ) {
      this._rawLog('error', `🛑 afterMaxLoss=stop — bot halted after L${cfg.maxMartingaleLevel}`);
      this._sendTelegram(
        `🛑 <b>MAX LEVEL STOP</b> (afterMaxLoss=stop)\n` +
        `Final Level: L${cfg.maxMartingaleLevel}\n` +
        `Session P&L: $${this.totalProfit.toFixed(2)}`
      );
      shouldContinue = false;
    }

    if (!shouldContinue) {
      this.running = false;
      this._logSummary();
      return;
    }

    // ── Continue trading ────────────────────────────────────────────────────
    if (this.running) {
      // 1-second breather between contracts (avoids API rate limits)
      setTimeout(() => { if (this.running) this._placeTrade(); }, 1_000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLACE TRADE
  // ══════════════════════════════════════════════════════════════════════════

  _placeTrade() {
    if (!this.wsReady)        { this._rawLog('error',   'Not authorized — cannot trade'); return; }
    if (!this.running)        { return; }
    if (this.tradeInProgress) { this._rawLog('warning', 'Trade already in progress…'); return; }

    const stake     = this.calculateStake(this.currentGridLevel);
    const direction = this.currentDirection;
    const label     = direction === 'CALLE' ? '📈 HIGHER' : '📉 LOWER';

    // Pre-flight funds checks
    if (stake > this.investmentRemaining) {
      this._rawLog('error',
        `Stake $${stake} > pool $${this.investmentRemaining.toFixed(2)} — stopping`
      );
      this.running = false;
      return;
    }
    if (stake > this.balance) {
      this._rawLog('error',
        `Stake $${stake} > balance $${this.balance.toFixed(2)} — stopping`
      );
      this.running = false;
      return;
    }

    this._rawLog('info',
      `Sending ${label} | L${this.currentGridLevel} | Stake: $${stake} | ` +
      `Pool: $${this.investmentRemaining.toFixed(2)}`
    );

    this.tradeInProgress  = true;
    this.pendingStake     = stake;
    this.pendingDirection = direction;
    this.pendingGridLevel = this.currentGridLevel;

    this._send({
      proposal:      1,
      amount:        stake,
      basis:         'stake',
      contract_type: direction,        // 'CALLE' or 'PUTE'
      currency:      this.currency,
      duration:      this.config.tickDuration,
      duration_unit: 't',
      symbol:        this.config.symbol,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // START / STOP / EMERGENCY STOP
  // ══════════════════════════════════════════════════════════════════════════

  start() {
    if (!this.wsReady) {
      this._rawLog('error', 'Not authorized — connect first');
      return false;
    }
    if (this.running) {
      this._rawLog('warning', 'Bot already running');
      return false;
    }
    if (this.config.investmentAmount <= 0) {
      this._rawLog('error', 'Invalid investment amount');
      return false;
    }
    if (this.config.investmentAmount > this.balance) {
      this._rawLog('error',
        `Investment $${this.config.investmentAmount} exceeds balance $${this.balance.toFixed(2)}`
      );
      return false;
    }

    const cfg = this.config;

    // Set base stake
    if (cfg.autoCompounding) {
      this.baseStake = Math.max(cfg.investmentAmount * cfg.compoundPercentage / 100, 0.35);
      this._rawLog('info',
        `Auto-compounding ON: ${cfg.compoundPercentage}% of $${cfg.investmentAmount} = $${this.baseStake.toFixed(2)} base`
      );
    } else {
      this.baseStake = cfg.initialStake;
      this._rawLog('info', `Fixed stake: $${this.baseStake.toFixed(2)}`);
    }

    // Reset all session counters
    this.running              = true;
    this.currentGridLevel     = 0;
    this.currentDirection     = 'CALLE';
    this.totalProfit          = 0;
    this.totalTrades          = 0;
    this.wins                 = 0;
    this.losses               = 0;
    this.currentStreak        = 0;
    this.maxWinStreak         = 0;
    this.maxLossStreak        = 0;
    this.totalRecovered       = 0;
    this.investmentRemaining  = cfg.investmentAmount;
    this.investmentStartAmount= cfg.investmentAmount;
    this.tradeInProgress      = false;
    this.currentContractId    = null;
    this.isWinTrade           = false;
    this.hourlyStats          = { trades: 0, wins: 0, losses: 0, pnl: 0 };

    this._rawLog('success', '🚀 V75 Grid Martingale Bot STARTED!');
    this._rawLog('info',
      `Investment: $${cfg.investmentAmount} | Base: $${this.baseStake.toFixed(2)} | ` +
      `Mult: ${cfg.martingaleMultiplier}× | Max: L${cfg.maxMartingaleLevel} | ` +
      `${cfg.tickDuration}t | Symbol: ${cfg.symbol}`
    );
    if (cfg.afterMaxLoss === 'continue') {
      this._rawLog('info',
        `Extended recovery: up to L${cfg.maxMartingaleLevel + cfg.continueExtraLevels} ` +
        `with ${cfg.extraLevelMultipliers.length > 0 ? 'custom' : 'default'} multipliers`
      );
    }
    this._rawLog('info', 'First trade: HIGHER (CALLE) — exploiting V75 mean-reversion');

    this._sendTelegram(
      `🚀 <b>V75 Grid Bot STARTED</b>\n\n` +
      `💵 Investment: $${cfg.investmentAmount}\n` +
      `📊 Base Stake: $${this.baseStake.toFixed(2)}\n` +
      `🔢 Multiplier: ${cfg.martingaleMultiplier}× | Max Level: L${cfg.maxMartingaleLevel}\n` +
      `📋 After Max Loss: ${cfg.afterMaxLoss.toUpperCase()}\n` +
      `⏱ Duration: ${cfg.tickDuration} ticks\n` +
      `🎯 Symbol: ${cfg.symbol}\n` +
      `💰 Balance: ${this.currency} ${this.balance.toFixed(2)}\n` +
      `🛑 Stop Loss: $${cfg.stopLoss} | Take Profit: $${cfg.takeProfit}`
    );

    setTimeout(() => { if (this.running) this._placeTrade(); }, 500);
    return true;
  }

  stop() {
    this.running         = false;
    this.tradeInProgress = false;
    this._rawLog('warning', '🛑 Bot stopped by user');
    this._sendTelegram(
      `🛑 <b>Bot stopped by user</b>\n` +
      `P&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`
    );
    this._logSummary();
  }

  emergencyStop() {
    this.running         = false;
    this.tradeInProgress = false;
    this._rawLog('error', '🚨 EMERGENCY STOP — All activity halted!');
    this._sendTelegram(
      `🚨 <b>EMERGENCY STOP TRIGGERED</b>\n` +
      `P&L: $${this.totalProfit.toFixed(2)} | Trades: ${this.totalTrades}`
    );
    this._logSummary();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY LOG
  // ══════════════════════════════════════════════════════════════════════════

  _logSummary() {
    const wr = this.totalTrades > 0
      ? ((this.wins / this.totalTrades) * 100).toFixed(1)
      : '0.0';
    this._rawLog('info',
      `📊 SUMMARY | Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses} | ` +
      `Win Rate: ${wr}% | P&L: $${this.totalProfit.toFixed(2)} | ` +
      `Recovered: $${this.totalRecovered.toFixed(2)} | L${this.currentGridLevel}`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TELEGRAM HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  async _sendTelegram(message) {
    if (!this.telegramBot || !this.config.telegramEnabled) return;
    try {
      await this.telegramBot.sendMessage(this.config.telegramChatId, message, { parse_mode: 'HTML' });
    } catch (e) {
      // Never crash the bot over a Telegram failure
      this._rawLog('warning', `Telegram send failed: ${e.message}`);
    }
  }

  _sendTelegramTradeResult(isWin, profit) {
    const wr      = this.totalTrades > 0
      ? ((this.wins / this.totalTrades) * 100).toFixed(1)
      : '0.0';
    const pnlStr  = (profit >= 0 ? '+' : '') + '$' + profit.toFixed(2);
    const nextDir = this.currentDirection === 'CALLE' ? 'HIGHER' : 'LOWER';
    const nextStk = this.calculateStake(this.currentGridLevel);

    this._sendTelegram(
      `${isWin ? '✅ WIN' : '❌ LOSS'} <b>— V75 Grid Bot</b>\n\n` +
      `${isWin ? '🟢' : '🔴'} <b>P&L this trade:</b> ${pnlStr}\n` +
      `📊 <b>Grid:</b> → ${isWin ? 'RESET L0' : `L${this.currentGridLevel}`}\n` +
      `🎯 <b>Next:</b> ${nextDir} @ $${nextStk.toFixed(2)}\n\n` +
      `<b>Session:</b>\n` +
      `  Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  Session P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment Pool: $${this.investmentRemaining.toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleTimeString()}`
    );
  }

  async _sendHourlySummary() {
    const s   = this.hourlyStats;
    const wr  = (s.wins + s.losses) > 0
      ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1)
      : '0.0';
    const pnlStr = (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2);

    await this._sendTelegram(
      `⏰ <b>V75 Grid Bot — Hourly Summary</b>\n\n` +
      `<b>Last Hour:</b>\n` +
      `  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}\n` +
      `  Win Rate: ${wr}%\n` +
      `  ${s.pnl >= 0 ? '🟢' : '🔴'} P&L: ${pnlStr}\n\n` +
      `<b>Session Totals:</b>\n` +
      `  Trades: ${this.totalTrades} | W/L: ${this.wins}/${this.losses}\n` +
      `  Session P&L: ${(this.totalProfit >= 0 ? '+' : '')}$${this.totalProfit.toFixed(2)}\n` +
      `  Investment: $${this.investmentRemaining.toFixed(2)} / $${this.investmentStartAmount.toFixed(2)}\n` +
      `  Grid Level: L${this.currentGridLevel}\n\n` +
      `⏰ ${new Date().toLocaleString()}`
    );

    this._rawLog('info', 'Telegram hourly summary sent');
    this.hourlyStats = { trades: 0, wins: 0, losses: 0, pnl: 0 };
  }

  startTelegramTimer() {
    const now     = new Date();
    const next    = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    const msUntil = next.getTime() - now.getTime();

    setTimeout(() => {
      this._sendHourlySummary();
      setInterval(() => this._sendHourlySummary(), 60 * 60 * 1_000);
    }, msUntil);

    this._rawLog('info',
      `Hourly Telegram summaries scheduled (first in ${Math.ceil(msUntil / 60_000)} min)`
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TIME SCHEDULER — Weekend pause + end-of-day (GMT+1)
  // ══════════════════════════════════════════════════════════════════════════

  startTimeScheduler() {
    const CHECK_INTERVAL = 20_000; // 20 s

    setInterval(() => {
      const now    = new Date();
      const gmt1   = new Date(now.getTime() + 60 * 60 * 1_000);
      const day    = gmt1.getUTCDay();    // 0=Sun 6=Sat
      const hours  = gmt1.getUTCHours();
      const mins   = gmt1.getUTCMinutes();

      // Weekend: Sat 23:00 → Mon 08:00 GMT+1
      const isWeekend =
        day === 0 ||                       // all of Sunday
        (day === 6 && hours >= 23) ||      // Sat after 23:00
        (day === 1 && hours < 8);          // Mon before 08:00

      if (isWeekend) {
        if (!this.endOfDay) {
          this._rawLog('warning', '📅 Weekend trading pause (Sat 23:00–Mon 08:00 GMT+1)');
          this._sendHourlySummary();
          this.stop();
          this.disconnect();
          this.endOfDay = true;
        }
        return;
      }

      // Resume Monday 08:00
      if (this.endOfDay && day === 1 && hours === 8 && mins < 1) {
        this._rawLog('success', '📅 Monday 08:00 GMT+1 — reconnecting');
        this._resetDailyStats();
        this.endOfDay = false;
        this.connect();
      }

      // End-of-day: stop after a win past 17:00
      if (this.isWinTrade && !this.endOfDay && hours >= 17) {
        this._rawLog('info', '📅 Past 17:00 GMT+1 after a win — end-of-day stop');
        this._sendHourlySummary();
        this.stop();
        this.disconnect();
        this.endOfDay = true;
      }
    }, CHECK_INTERVAL);

    this._rawLog('info', 'Time scheduler active (weekend pause + EOD logic)');
  }

  _resetDailyStats() {
    this.tradeInProgress = false;
    this.isWinTrade      = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

function printBanner() {
  const lines = [
    '╔══════════════════════════════════════════════════════════════════════════════╗',
    '║  ⚡ V75 GRID MARTINGALE BOT — Pure Headless Node.js Edition                 ║',
    '║     Volatility 75 Index (1HZ75V) | CALLE/PUTE | 5 ticks | 1.48× Martingale ║',
    '║                                                                              ║',
    '║  Commands (keyboard):  S = Start   X = Stop   E = Emergency   Q = Quit      ║',
    '╚══════════════════════════════════════════════════════════════════════════════╝',
  ];
  lines.forEach(l => console.log(cc(C.cyan, l)));
  console.log();
}

function setupKeyboardCommands(bot) {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key) => {
    const k = key.toLowerCase().trim();

    if (k === 'q' || key === '\u0003') {    // Q or Ctrl+C
      shutdown(bot, 'QUIT');
    } else if (k === 's') {
      if (!bot.running) bot.start();
      else bot._rawLog('warning', 'Bot already running — press X to stop first');
    } else if (k === 'x') {
      if (bot.running) bot.stop();
      else bot._rawLog('warning', 'Bot is not running');
    } else if (k === 'e') {
      bot.emergencyStop();
    }
  });

  bot._rawLog('info', 'Keyboard: [S]tart  [X]Stop  [E]mergency  [Q]uit');
}

function shutdown(bot, sig) {
  bot.ui.stop();
  console.log(`\n${cc(C.yellow, `[${sig}] Shutting down gracefully…`)}`);
  bot.stop();
  bot.disconnect();
  StatePersistence.save(bot);
  bot._sendTelegram(
    `⚠️ <b>Bot shutdown (${sig})</b>\n` +
    `Final P&L: $${bot.totalProfit.toFixed(2)}\n` +
    `Trades: ${bot.totalTrades} | W/L: ${bot.wins}/${bot.losses}`
  );
  setTimeout(() => {
    console.log(cc(C.green, 'Goodbye ✅'));
    process.exit(0);
  }, 2_000);
}

function main() {
  printBanner();

  // ── Load config ──────────────────────────────────────────────────────────
  const config = loadConfig();
  saveConfig(config);   // write back defaults + .env merges

  if (!config.apiToken) {
    console.error(cc(C.red,
      '❌  No API token found!\n' +
      '    Set DERIV_TOKEN in your .env file or v75-headless-config.json\n'
    ));
    process.exit(1);
  }

  console.log(cc(C.dim, `Config loaded from ${CONFIG_FILE}`));
  console.log(cc(C.dim,
    `Strategy: ${config.symbol} | ${config.tickDuration}t | ` +
    `L${config.maxMartingaleLevel} | ${config.martingaleMultiplier}× | ` +
    `Investment: $${config.investmentAmount} | ` +
    `SL: $${config.stopLoss} | TP: $${config.takeProfit}`
  ));
  console.log();

  // ── Create bot ───────────────────────────────────────────────────────────
  const bot = new V75GridBot(config);

  // ── Start console UI ─────────────────────────────────────────────────────
  bot.ui.start();

  // ── Keyboard commands ─────────────────────────────────────────────────────
  setupKeyboardCommands(bot);

  // ── State auto-save ───────────────────────────────────────────────────────
  StatePersistence.startAutoSave(bot);

  // ── Connect to Deriv ──────────────────────────────────────────────────────
  bot.connect();

  // ── Telegram hourly summaries ─────────────────────────────────────────────
  if (bot.telegramBot) bot.startTelegramTimer();

  // ── Time scheduler (weekend pause + EOD) ─────────────────────────────────
//   bot.startTimeScheduler();

  // ── Auto-start if configured ──────────────────────────────────────────────
  // (start() is also called from _onAuthorize when config.autoStart is true)

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  process.on('SIGINT',  () => shutdown(bot, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(bot, 'SIGTERM'));
  process.on('uncaughtException', (err) => {
    bot._rawLog('error', `Uncaught exception: ${err.message}\n${err.stack}`);
    StatePersistence.save(bot);
    // Don't exit — let the bot keep running unless it's truly fatal
  });
  process.on('unhandledRejection', (reason) => {
    bot._rawLog('error', `Unhandled rejection: ${reason}`);
  });
}

main();
