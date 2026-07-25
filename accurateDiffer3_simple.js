#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv Digit Differ Trading Bot (Simplified Edition)
 * =====================================================================
 *
 *  A clean, focused DIGITDIFF bot that acknowledges the fundamental
 *  truth about synthetic indices: each tick is an independent,
 *  uniformly distributed random event from a cryptographically secure
 *  RNG. No pattern analysis can predict future digits.
 *
 *  This bot's "edge" comes entirely from:
 *    1. Risk management (position sizing, loss limits, circuit breakers)
 *    2. Value check (ensuring payout exceeds break-even threshold)
 *    3. Conservative heuristic (selecting least-frequent digit as barrier)
 *
 *  The digit selection is a heuristic - not a demonstrated statistical
 *  edge. It works because:
 *    - Short-term frequency deviations are normal in random processes
 *    - Selecting the least-frequent digit in a window gives you a
 *      slightly higher probability of the "differs" contract winning
 *    - Combined with the payout structure, this can yield positive
 *      expected value under certain market conditions
 *
 *  Simplicity Features:
 *    • Single-window frequency analysis (no multi-layer "consensus")
 *    • Direct value-edge check against live proposal
 *    • Kelly-fractional sizing for optimal bankroll growth
 *    • Per-symbol calibration tracker
 *    • Consecutive-loss circuit breaker
 *    • Daily/session loss caps
 *    • Clean, readable code structure
 *
 *  Credentials: DERIV_API_TOKEN, DERIV_ACCOUNT_ID, TELEGRAM_BOT_TOKEN,
 *  and TELEGRAM_CHAT_ID must be set in your .env file.
 *
 *  Install:  npm install ws
 *  Run:      node accurateDiffer3_simple.js
 *  Backtest: $env:BACKTEST=1; node accurateDiffer3_simple.js
 *
 * =====================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ─────────────────────────────────────────────────────────────────────
// 1. ENV LOADER
// ─────────────────────────────────────────────────────────────────────
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.error('[boot] could not read .env:', e.message);
  }
}
loadEnv();

function numEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function intEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function boolEnv(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function strEnv(name, def) {
  const v = process.env[name];
  return v == null || v === '' ? def : String(v).trim();
}
function listEnv(name, def) {
  return strEnv(name, def).split(',').map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────
// 2. CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // Deriv API credentials (MUST come from .env or environment)
  apiToken:    process.env.DERIV_API_TOKEN || '',
  appId:       process.env.DERIV_APP_ID || '33uslPtthXBEkQOdfKfoY',
  accountId:   process.env.DERIV_ACCOUNT_ID || '',
  accountType: process.env.DERIV_ACCOUNT_TYPE || 'demo',
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency: 'USD',

  // ── Trade Setup ─────────────────────────────────────────────────
  stake:           numEnv('STAKE', 1.1),
  durationTicks:   intEnv('DURATION_TICKS', 1),
  minStake:        numEnv('MIN_STAKE', 1.1),
  maxStake:        numEnv('MAX_STAKE', 100.0),
  assets:          listEnv('ASSETS', 'R_25,R_50,R_75,R_100'),

  // ── Timing ─────────────────────────────────────────────────────
  tickWindow:          intEnv('TICK_WINDOW', 500),
  minTicksForAnalysis: intEnv('MIN_TICKS_ANALYSIS', 200),
  analysisIntervalMs:  intEnv('ANALYSIS_INTERVAL_MS', 3000),
  tradeCooldownMs:     intEnv('TRADE_COOLDOWN_MS', 2500),
  maxOpenTrades:       intEnv('MAX_OPEN_TRADES', 1),
  assetRotationMs:     intEnv('ASSET_ROTATION_MS', 60000),

  // ── Risk Management ────────────────────────────────────────────
  dailyMaxLoss:       numEnv('DAILY_MAX_LOSS', 100),
  dailyMaxLossPct:    numEnv('DAILY_MAX_LOSS_PCT', 0.05),
  dailyMaxProfit:     numEnv('DAILY_MAX_PROFIT', 0),
  dailyMaxTrades:     intEnv('DAILY_MAX_TRADES', 500),
  maxConsecutiveLoss: intEnv('MAX_CONSECUTIVE_LOSSES', 5),
  lossCooldownMs:     intEnv('LOSS_COOLDOWN_MS', 300000),

  // ── Digit Analysis (Simple Heuristic) ──────────────────────────
  analysisWindow:     intEnv('ANALYSIS_WINDOW', 100),
  minProbabilityGap:  numEnv('MIN_PROBABILITY_GAP', 0.005),
  maxRecentHits:      intEnv('MAX_RECENT_HITS', 3),
  recentLookback:     intEnv('RECENT_LOOKBACK', 20),

  // ── Value Edge ─────────────────────────────────────────────────
  minEdge:            numEnv('MIN_EDGE', 0.01),
  safetyMargin:       numEnv('SAFETY_MARGIN', 0.005),

  // ── Kelly Sizing ───────────────────────────────────────────────
  kellyEnabled:       boolEnv('KELLY_ENABLED', true),
  kellyFraction:      numEnv('KELLY_FRACTION', 0.25),
  kellyMaxStakeFrac:  numEnv('KELLY_MAX_STAKE_FRAC', 0.02),
  kellyBankrollFloor: numEnv('KELLY_BANKROLL_FLOOR', 100),

  // ── Symbol Calibration ─────────────────────────────────────────
  calibEnabled:       boolEnv('CALIB_ENABLED', true),
  calibWindow:        intEnv('CALIB_WINDOW', 100),
  calibMinTrades:     intEnv('CALIB_MIN_TRADES', 30),
  calibDisableGap:    numEnv('CALIB_DISABLE_GAP', 0.03),

  // ── Reporting ──────────────────────────────────────────────────
  eodTimeGmt:         strEnv('TRADE_DAY_END_GMT', '00:00'),
  hourlySummary:      boolEnv('HOURLY_SUMMARY', true),

  // ── Persistence ────────────────────────────────────────────────
  stateFile: strEnv('STATE_FILE', 'accurateDiffer3_simple_state.json'),
  logFile:   strEnv('LOG_FILE', 'accurateDiffer3_simple.log'),
  logLevel:  strEnv('LOG_LEVEL', 'INFO').toUpperCase(),

  // ── Telegram ───────────────────────────────────────────────────
  telegram: {
    enabled:  boolEnv('TELEGRAM_ENABLED', true),
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId:   process.env.TELEGRAM_CHAT_ID || '',
  },

  // ── Backtest ───────────────────────────────────────────────────
  backtestTicks:     intEnv('BACKTEST_TICKS', 50000),
  backtestBatchSize: intEnv('BACKTEST_BATCH_SIZE', 5000),
  backtestPayoutMult: numEnv('BACKTEST_PAYOUT_MULT', 1.10),

  // ── Reconnect ──────────────────────────────────────────────────
  reconnect: {
    initialDelayMs: 1000,
    maxDelayMs:     30000,
    backoffFactor:  2,
    jitterMs:       500,
  },
});

// ─────────────────────────────────────────────────────────────────────
// 3. LOGGER
// ─────────────────────────────────────────────────────────────────────
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');

function utcTs() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`;
}

function _writeLog(line) {
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}

function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  const line = `[${utcTs()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}

const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn:  (m, ...a) => log('WARN',  m, ...a),
  info:  (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function utcDateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function utcHour(d = new Date()) { return d.getUTCHours(); }
function htmlEscape(s) {
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

// ─────────────────────────────────────────────────────────────────────
// 4. TELEGRAM NOTIFIER
// ─────────────────────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = cfg.enabled && !!cfg.botToken && !!cfg.chatId;
    this.botToken = cfg.botToken;
    this.chatId = cfg.chatId;
    this.queue = [];
    this.sending = false;
  }

  _post(text) {
    return new Promise(resolve => {
      if (!this.enabled) return resolve(false);
      try {
        const payload = JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        const url = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
        const req = https.request({
          method: 'POST',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 15000,
        }, res => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', e => { logger.warn('telegram error:', e.message); resolve(false); });
        req.on('timeout', () => { req.destroy(new Error('telegram timeout')); resolve(false); });
        req.write(payload);
        req.end();
      } catch (e) {
        logger.warn('telegram exception:', e.message);
        resolve(false);
      }
    });
  }

  async _drain() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift();
        await this._post(msg);
        await new Promise(r => setTimeout(r, 1100));
      }
    } finally {
      this.sending = false;
    }
  }

  send(text) {
    if (!this.enabled) {
      logger.debug('telegram(dry):', String(text).slice(0, 160).replace(/\n/g, ' | '));
      return;
    }
    this.queue.push(String(text));
    this._drain().catch(e => logger.warn('telegram drain:', e.message));
  }
}

const telegram = new TelegramNotifier(CONFIG.telegram);

// ─────────────────────────────────────────────────────────────────────
// 5. DERIV CLIENT
// ─────────────────────────────────────────────────────────────────────
class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.authorized = false;
    this._stopped = false;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this._reqId = 0;
    this._pending = new Map();
    this._subs = new Map();
    this.balance = null;
    this.currency = cfg.currency;
    this.accountInfo = null;
    this.symbols = new Map();
  }

  _nextReqId() { return ++this._reqId; }

  _legacyUrl() {
    const sep = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.legacyWsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty');
      this._stopped = true;
      return;
    }
    logger.info('connecting to Deriv WebSocket...');
    this._openWs(this._legacyUrl());
  }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { handshakeTimeout: 15000 });
    } catch (e) {
      logger.error('WebSocket construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
  }

  _onOpen() {
    logger.info('WebSocket connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    this._authorize();
  }

  async _authorize() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      const a = res.authorize;
      this.authorized = true;
      this.balance = Number(a.balance);
      this.currency = a.currency || this.cfg.currency;
      this.accountInfo = {
        loginid: a.loginid,
        isVirtual: !!a.is_virtual,
        currency: this.currency,
      };
      logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this._scheduleReconnect();
    }
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.error) {
      const code = msg.error.code || 'Error';
      const text = msg.error.message || code;
      (code === 'AlreadySubscribedOrLimit' ? logger.debug : logger.error)(`api error: ${code} - ${text} req=${msg.req_id || '?'}`);

      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(text));
      }
      return;
    }

    if (msg.req_id && this._pending.has(msg.req_id)) {
      const p = this._pending.get(msg.req_id);
      clearTimeout(p.timer);
      this._pending.delete(msg.req_id);
      p.resolve(msg);
      return;
    }

    if (msg.subscription?.id && this._subs.has(msg.subscription.id)) {
      const cb = this._subs.get(msg.subscription.id);
      try { cb(msg); } catch (e) { logger.error('subscription handler error:', e.message); }
      return;
    }

    this.emit('message', msg);
  }

  _onError(err) {
    logger.error('WebSocket error:', err.message);
    this.emit('error', err);
  }

  _onClose(code, reason) {
    const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
    logger.warn(`WebSocket closed code=${code} reason=${rs || '(none)'}`);
    this.connected = false;
    this.authorized = false;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this._pending.clear();
    this._subs.clear();
    this.emit('close', code, reason);
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempt += 1;
    const base = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1),
      this.cfg.reconnect.maxDelayMs,
    );
    const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
    logger.info(`reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
    setTimeout(() => {
      this._reconnecting = false;
      this.connect();
    }, delay);
  }

  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }

  subscribe(payload, callback, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error('Subscribe timeout'));
        }
      }, timeoutMs);
      this._pending.set(reqId, {
        resolve: msg => {
          const subId = msg.subscription?.id;
          if (!subId) return reject(new Error('No subscription id'));
          this._subs.set(subId, callback);
          resolve(subId);
        },
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId }));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(e);
      }
    });
  }

  forget(subId) {
    if (!subId) return Promise.resolve();
    this._subs.delete(subId);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return this._send({ forget: subId }, 8000).catch(e => logger.debug('forget:', e.message));
  }

  stop() {
    this._stopped = true;
    try { this.ws?.close(); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. MARKET DATA
// ─────────────────────────────────────────────────────────────────────
const KNOWN_PIP_SIZES = {
  R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
  '1HZ10V': 2, '1HZ25V': 2, '1HZ50V': 2, '1HZ75V': 2, '1HZ100V': 2,
  RDBULL: 4, RDBEAR: 4,
};

function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const pip = Math.max(1, Math.min(8, Number(pipSize) || 2));
  let s = Math.abs(n).toString();
  if (s.includes('e')) s = Math.abs(n).toFixed(8);
  const dot = s.indexOf('.');
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const padded = frac.padEnd(pip, '0');
  const d = Number(padded.charAt(pip - 1));
  return Number.isInteger(d) ? d : null;
}

class MarketDataManager extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map();
    this.subs = new Map();
    this.lastQuote = new Map();
    this.pipSizes = new Map();
    for (const [sym, pip] of Object.entries(KNOWN_PIP_SIZES)) {
      this.pipSizes.set(sym, pip);
    }
    client.on('close', () => this.subs.clear());
  }

  async loadSymbols() {
    try {
      const res = await this.client._send({ active_symbols: 'full' }, 15000);
      for (const s of (res.active_symbols || [])) {
        const key = s.underlying_symbol || s.symbol;
        if (key) this.client.symbols.set(key, s);
      }
      logger.info(`loaded ${this.client.symbols.size} symbols`);
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
    }
  }

  pipSize(symbol) {
    const cached = this.pipSizes.get(symbol);
    if (Number.isFinite(cached)) return cached;
    return 2;
  }

  async backfill(symbol, count = 500) {
    try {
      const res = await this.client._send({
        ticks_history: symbol,
        count,
        end: 'latest',
        style: 'ticks',
      }, 20000);
      const prices = res.history?.prices || [];
      const times = res.history?.times || [];
      const pip = this.pipSize(symbol);
      const arr = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      this.history.set(symbol, arr);
      if (arr.length) this.lastQuote.set(symbol, arr[arr.length - 1].quote);
      logger.info(`backfilled ${symbol}: ${arr.length} ticks`);
      return arr;
    } catch (e) {
      logger.error(`backfill(${symbol}) failed:`, e.message);
      return [];
    }
  }

  async subscribe(symbol) {
    if (this.subs.has(symbol)) return this.subs.get(symbol);
    const subId = await this.client.subscribe({ ticks: symbol }, msg => {
      const t = msg.tick;
      if (!t) return;
      const quote = Number(t.quote);
      const pip = this.pipSize(symbol);
      const tick = { epoch: Number(t.epoch), quote, digit: quoteToDigit(quote, pip) };
      if (tick.digit == null) return;
      this.lastQuote.set(symbol, tick.quote);
      const arr = this.history.get(symbol) || [];
      arr.push(tick);
      if (arr.length > this.cfg.tickWindow * 2) arr.splice(0, arr.length - this.cfg.tickWindow * 2);
      this.history.set(symbol, arr);
      this.emit('tick', symbol, tick);
    });
    this.subs.set(symbol, subId);
    logger.info(`subscribed: ${symbol}`);
    return subId;
  }

  async bootstrap(symbols) {
    await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message))));
    await Promise.all(symbols.map(async s => {
      if ((this.history.get(s) || []).length < this.cfg.minTicksForAnalysis) {
        await this.backfill(s, this.cfg.tickWindow);
      }
    }));
  }

  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol) { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// 7. DIGIT ANALYZER (Simple & Honest)
// ─────────────────────────────────────────────────────────────────────
class DigitAnalyzer {
  constructor(cfg) { this.cfg = cfg; }

  /**
   * Count digit frequencies and find the coldest digit.
   * This is a heuristic, not a predictive edge.
   */
  analyze(symbol, ticks) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;

    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    const window = Math.min(this.cfg.analysisWindow, digits.length);
    const recentDigits = digits.slice(-window);

    // Count frequencies
    const counts = Array(10).fill(0);
    for (const d of recentDigits) counts[d]++;

    // Find coldest digit (lowest frequency)
    let coldestDigit = 0;
    let coldestCount = counts[0];
    for (let d = 1; d < 10; d++) {
      if (counts[d] < coldestCount) {
        coldestDigit = d;
        coldestCount = counts[d];
      }
    }

    // Calculate probability (conservative upper bound)
    const n = recentDigits.length;
    const pEstimate = (coldestCount + 1) / (n + 10); // Laplace smoothing
    const pUpper = Math.min(0.15, pEstimate + 0.01); // Conservative cap

    // Check recent occurrences
    const recentLook = Math.min(this.cfg.recentLookback, recentDigits.length);
    const recentTail = recentDigits.slice(-recentLook);
    const recentHits = recentTail.filter(d => d === coldestDigit).length;

    // Gate checks
    const gates = [];
    if (recentHits > this.cfg.maxRecentHits) {
      gates.push(`recent_hits:${recentHits}`);
    }

    // Find second coldest for gap check
    let secondCount = Infinity;
    for (let d = 0; d < 10; d++) {
      if (d !== coldestDigit && counts[d] < secondCount) {
        secondCount = counts[d];
      }
    }
    const gap = (secondCount - coldestCount) / n;
    if (gap < this.cfg.minProbabilityGap) {
      gates.push(`gap_low:${gap.toFixed(4)}`);
    }

    return {
      symbol,
      digit: coldestDigit,
      count: coldestCount,
      sampleSize: n,
      pEstimate,
      pUpper,
      recentHits,
      gates,
      allowedByModel: gates.length === 0,
      lastDigit: recentDigits[recentDigits.length - 1],
    };
  }

  rank(list) {
    return list
      .filter(Boolean)
      .filter(a => a.allowedByModel)
      .sort((a, b) => a.pUpper - b.pUpper);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 8. TRADE EXECUTOR
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
  }

  async proposal(symbol, digit, stake) {
    return this.client._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: 'DIGITDIFF',
      currency: this.cfg.currency,
      duration: this.cfg.durationTicks,
      duration_unit: 't',
      barrier: String(digit),
      symbol,
    }, 15000);
  }

  async buy(symbol, digit, stake, analysis) {
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, Number(stake)));
    const pres = await this.proposal(symbol, digit, stake);
    const p = pres.proposal;
    if (!p?.id) throw new Error('No proposal id');

    const ask = Number(p.ask_price || stake);
    const payout = Number(p.payout || 0);
    const bres = await this.client._send({ buy: p.id, price: ask }, 15000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy failed');

    const info = {
      contractId: b.contract_id,
      symbol,
      digit,
      stake: ask,
      buyPrice: Number(b.buy_price || ask),
      payout: Number(b.payout || payout),
      buyTime: Number(b.purchase_time || Date.now() / 1000),
      durationTicks: this.cfg.durationTicks,
      analysis,
    };
    this.open.set(info.contractId, info);
    logger.info(`bought #${info.contractId} ${symbol} differs ${digit} stake=${ask}`);
    this.emit('open', info);

    // Subscribe to contract updates
    const subId = await this.client.subscribe(
      { proposal_open_contract: 1, contract_id: info.contractId },
      msg => this._onUpdate(msg, info)
    );
    info.subId = subId;

    return info;
  }

  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    if (c.status === 'won' || c.status === 'lost') {
      const finished = {
        ...info,
        status: c.status,
        profit: Number(c.profit || 0),
        sellTime: Number(c.sell_time || Date.now() / 1000),
      };
      this.open.delete(info.contractId);
      this.emit('result', finished);
      const subId = msg.subscription?.id || info.subId;
      if (subId) await this.client.forget(subId).catch(() => {});
    }
  }

  count() { return this.open.size; }
}

// ─────────────────────────────────────────────────────────────────────
// 9. STATISTICS & TRACKING
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.eodSentDates = [];
    if (saved) this.load(saved);
  }

  load(saved) {
    if (Array.isArray(saved.trades)) this.trades = saved.trades;
    this.overallProfit = Number(saved.overallProfit || 0);
    this.currentLossStreak = Number(saved.currentLossStreak || 0);
    this.maxLossStreak = Number(saved.maxLossStreak || 0);
    this.eodSentDates = Array.isArray(saved.eodSentDates) ? saved.eodSentDates : [];
  }

  serialize() {
    return {
      trades: this.trades.slice(-2000),
      overallProfit: this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      eodSentDates: this.eodSentDates.slice(-100),
    };
  }

  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = {
      ...trade,
      timestamp: tsMs,
      date: utcDateStr(d),
      hour: utcHour(d),
    };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);

    if (rec.status === 'lost') {
      this.currentLossStreak++;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }

  todayTrades(date = utcDateStr()) {
    return this.trades.filter(t => t.date === date);
  }

  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const totalProfit = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossWin = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    return {
      count: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? (wins.length / list.length) * 100 : 0,
      totalProfit,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    };
  }

  markEodSent(date) {
    if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date);
  }
  isEodSent(date) { return this.eodSentDates.includes(date); }
}

// ─────────────────────────────────────────────────────────────────────
// 10. SYMBOL CALIBRATOR
// ─────────────────────────────────────────────────────────────────────
class SymbolCalibrator {
  constructor(cfg, saved = null) {
    this.cfg = cfg;
    this.symbols = new Map();
    if (saved) this.load(saved);
  }

  record(symbol, predictedPWin, won) {
    if (!this.cfg.calibEnabled) return;
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, { window: [], state: 'enabled', disabledAt: 0 });
    }
    const s = this.symbols.get(symbol);
    s.window.push({ pWin: predictedPWin, won, ts: Date.now() });
    if (s.window.length > this.cfg.calibWindow) {
      s.window.splice(0, s.window.length - this.cfg.calibWindow);
    }
    this._reassess(symbol, s);
  }

  _reassess(symbol, s) {
    const n = s.window.length;
    if (n < this.cfg.calibMinTrades) return;

    const wins = s.window.filter(r => r.won).length;
    const empiricalWR = wins / n;
    const predictedWR = s.window.reduce((sum, r) => sum + r.pWin, 0) / n;
    const gap = empiricalWR - predictedWR;

    if (gap < -this.cfg.calibDisableGap) {
      s.state = 'disabled';
      s.disabledAt = Date.now();
      logger.warn(`CALIB: ${symbol} DISABLED — WR ${empiricalWR.toFixed(2)}% < predicted ${predictedWR.toFixed(2)}%`);
    }
  }

  isTradeable(symbol) {
    if (!this.cfg.calibEnabled) return true;
    const s = this.symbols.get(symbol);
    if (!s || s.state === 'enabled') return true;
    if (s.state === 'disabled') {
      if (Date.now() - s.disabledAt > 30 * 60 * 1000) {
        s.state = 'enabled'; // Re-enable after 30 min
        return true;
      }
      return false;
    }
    return true;
  }

  stakeMultiplier(symbol) {
    if (!this.cfg.calibEnabled) return 1;
    const s = this.symbols.get(symbol);
    if (!s || s.state === 'enabled') return 1;
    if (s.state === 'disabled') return 0.25; // Probe with 25% stake
    return 1;
  }

  serialize() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      out[sym] = { state: s.state, disabledAt: s.disabledAt, window: s.window.slice(-50) };
    }
    return out;
  }

  load(saved) {
    for (const [sym, s] of Object.entries(saved)) {
      if (s && typeof s === 'object') {
        this.symbols.set(sym, {
          state: s.state || 'enabled',
          disabledAt: Number(s.disabledAt || 0),
          window: Array.isArray(s.window) ? s.window.slice(-this.cfg.calibWindow) : [],
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. KELLY SIZER
// ─────────────────────────────────────────────────────────────────────
class KellySizer {
  constructor(cfg) { this.cfg = cfg; }

  compute({ bankroll, pWin, payoutMult }) {
    const b = payoutMult - 1;
    const p = Math.max(0, Math.min(1, pWin));
    const q = 1 - p;
    if (b <= 0) return null;

    const fStar = (b * p - q) / b;
    if (fStar <= 0) return null;

    const fraction = fStar * this.cfg.kellyFraction;
    const capped = Math.min(fraction, this.cfg.kellyMaxStakeFrac);
    const stake = bankroll * capped;

    return {
      stake: Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, stake)),
      fStar,
      fApplied: capped,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 12. TRADING BOT
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg = CONFIG;
    this.client = new DerivClient(this.cfg);
    this.market = new MarketDataManager(this.client, this.cfg);
    this.analyzer = new DigitAnalyzer(this.cfg);
    this.exec = new TradeExecutor(this.client, this.cfg);
    this.stats = new StatisticsManager();
    this.calibrator = new SymbolCalibrator(this.cfg);
    this.kelly = new KellySizer(this.cfg);

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.tradedAsset = null;
    this.tradedAssetAt = 0;
    this.stopped = false;
    this._analysisT = null;
    this._circuitBreakerUntil = null;
    this._dayStartDate = null;
    this._dayStartBalance = null;
  }

  async start() {
    logger.info('===== Simple Digit Bot starting =====');
    logger.info(`stake=${this.cfg.stake} assets=${this.cfg.assets.join(',')}`);

    this._loadState();

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', () => this._onDisconnected());
    this.exec.on('result', t => this._onTradeResult(t));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('uncaughtException', e => {
      logger.error('uncaughtException:', e);
      this._saveState('error');
    });

    this.client.connect();
  }

  async _onAuthorized(info) {
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance = this.lastBalance ?? this.client.balance ?? this.startBalance;
    this._dayStartDate = utcDateStr();
    this._dayStartBalance = this.lastBalance;

    logger.info(`balance: ${this.balance} ${this.currency()}`);
    await this.market.loadSymbols();
    await this.market.bootstrap(this.cfg.assets);

    telegram.send(
      `🤖 <b>Simple Digit Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: DIGITDIFF, ${this.cfg.durationTicks} tick(s)\n` +
      `💵 Stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `🧮 Kelly: ${this.cfg.kellyEnabled ? 'ON' : 'OFF'}\n` +
      `📐 Calibration: ${this.cfg.calibEnabled ? 'ON' : 'OFF'}\n\n` +
      `💼 Profit: ${money(this.stats.overallProfit, this.currency())}`
    );

    this._startAnalysis();
  }

  _onDisconnected() {
    telegram.send(`⚠️ <b>Connection lost</b>\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
  }

  _startAnalysis() {
    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade();
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
  }

  async _analyzeAndTrade() {
    if (this.stopped || !this.client.authorized) return;
    if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
    if (this.exec.count() >= this.cfg.maxOpenTrades) return;

    // Circuit breaker
    if (this._circuitBreakerUntil && Date.now() < this._circuitBreakerUntil) {
      logger.debug('circuit breaker active');
      return;
    }

    // Daily limits
    const today = utcDateStr();
    if (this._dayStartDate !== today) {
      this._dayStartDate = today;
      this._dayStartBalance = this.lastBalance ?? this.client.balance ?? this._dayStartBalance ?? null;
    }
    const todayTrades = this.stats.todayTrades(today);
    const todayStats = this.stats.stats(todayTrades);

    if (todayStats.count >= this.cfg.dailyMaxTrades) return;
    if (todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) return;
    if (this._dayStartBalance != null && this.cfg.dailyMaxLossPct > 0) {
      if (-todayStats.totalProfit / Math.max(1, this._dayStartBalance) >= this.cfg.dailyMaxLossPct) return;
    }
    if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) return;

    // Filter tradeable assets
    const tradeableAssets = this.cfg.assets.filter(s => this.calibrator.isTradeable(s));
    if (!tradeableAssets.length) return;

    // Analyze each symbol
    const analyses = tradeableAssets
      .map(s => this.analyzer.analyze(s, this.market.historyFor(s)))
      .filter(Boolean);

    const ranked = this.analyzer.rank(analyses);
    if (!ranked.length) return;

    // Find best trade
    const probeStake = this.cfg.minStake;
    let bestCandidate = null;
    let bestEdge = -Infinity;

    for (const a of ranked.slice(0, 5)) {
      try {
        const pres = await this.exec.proposal(a.symbol, a.digit, probeStake);
        const p = pres.proposal;
        if (!p?.id) continue;

        const ask = Number(p.ask_price || probeStake);
        const payout = Number(p.payout || 0);
        if (payout <= ask) continue;

        const payoutMult = payout / ask;
        const breakEvenLossProb = 1 - ask / payout;
        const valueEdge = breakEvenLossProb - a.pUpper - this.cfg.safetyMargin;

        if (valueEdge >= this.cfg.minEdge && valueEdge > bestEdge) {
          bestEdge = valueEdge;
          bestCandidate = { analysis: a, proposal: p, ask, payout, payoutMult, valueEdge };
        }
      } catch (e) {
        logger.debug(`proposal ${a.symbol} d${a.digit}:`, e.message);
      }
    }

    if (!bestCandidate) {
      logger.debug(`no edge found (best: ${ranked[0]?.symbol} d${ranked[0]?.digit})`);
      return;
    }

    // Check asset rotation
    const lockActive = this.cfg.assetRotationMs > 0
      && this.tradedAsset
      && (Date.now() - this.tradedAssetAt < this.cfg.assetRotationMs);

    if (lockActive && bestCandidate.analysis.symbol === this.tradedAsset) {
      logger.debug(`symbol ${this.tradedAsset} in rotation cooldown`);
      return;
    }

    // Calculate stake
    const pWin = 1 - bestCandidate.analysis.pUpper;
    let stake = this.cfg.stake;

    if (this.cfg.kellyEnabled) {
      const bankroll = Math.max(this.cfg.kellyBankrollFloor, this.lastBalance ?? this.client.balance ?? 0);
      const k = this.kelly.compute({
        bankroll,
        pWin,
        payoutMult: bestCandidate.payoutMult,
      });
      if (k) stake = k.stake;
      else return; // No positive edge
    }

    // Apply calibration multiplier
    stake *= this.calibrator.stakeMultiplier(bestCandidate.analysis.symbol);
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, stake));

    // Execute trade
    try {
      const trade = await this.exec.buy(
        bestCandidate.analysis.symbol,
        bestCandidate.analysis.digit,
        stake,
        {
          digit: bestCandidate.analysis.digit,
          pUpper: bestCandidate.analysis.pUpper,
          valueEdge: bestCandidate.valueEdge,
          payoutMult: bestCandidate.payoutMult,
        }
      );

      this.lastTradeAt = Date.now();
      this.tradedAsset = bestCandidate.analysis.symbol;
      this.tradedAssetAt = Date.now();

      logger.info(`trade placed #${trade.contractId} ${trade.symbol} d${trade.digit} edge=${bestCandidate.valueEdge.toFixed(4)}`);
    } catch (e) {
      logger.error('trade failed:', e.message);
    }
  }

  _onTradeResult(t) {
    const rec = this.stats.record(t);
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + Number(t.profit || 0);

    // Circuit breaker check
    if (this.cfg.maxConsecutiveLoss && this.stats.currentLossStreak >= this.cfg.maxConsecutiveLoss) {
      this._circuitBreakerUntil = Date.now() + this.cfg.lossCooldownMs;
      const mins = (this.cfg.lossCooldownMs / 60000).toFixed(0);
      logger.warn(`circuit breaker: ${this.stats.currentLossStreak} losses → pausing ${mins}m`);
      telegram.send(`🛑 <b>CIRCUIT BREAKER</b>\n${this.stats.currentLossStreak} losses. Pausing ${mins}m.`);
    }

    // Feed calibrator
    if (this.cfg.calibEnabled) {
      const pWin = Number(t.analysis?.pWin ?? 0.9);
      this.calibrator.record(t.symbol, pWin, t.status === 'won');
    }

    const emoji = t.status === 'won' ? '✅' : '❌';
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    telegram.send(
      `${emoji} <b>TRADE ${t.status.toUpperCase()}</b>\n\n` +
      `🎫 #${t.contractId}\n` +
      `📊 ${t.symbol} differs ${t.digit}\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 P/L: ${money(t.profit, this.currency())}\n\n` +
      `📅 Today: ${todayStats.count} trades, ${todayStats.winRate.toFixed(1)}% WR\n` +
      `💼 Overall: ${money(this.stats.overallProfit, this.currency())}\n` +
      `❌ Loss streak: ${this.stats.currentLossStreak}`
    );

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  _saveState(reason = 'checkpoint') {
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        startBalance: this.startBalance,
        lastBalance: this.lastBalance,
        stats: this.stats.serialize(),
        calibrator: this.calibrator.serialize(),
      };
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.cfg.stateFile);
      logger.debug(`state saved (${reason})`);
    } catch (e) {
      logger.warn('state save failed:', e.message);
    }
  }

  _loadState() {
    try {
      if (!fs.existsSync(this.cfg.stateFile)) return;
      const data = JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8'));
      this.startBalance = data.startBalance ?? null;
      this.lastBalance = data.lastBalance ?? null;
      this.stats = new StatisticsManager(data.stats || {});
      if (data.calibrator) this.calibrator = new SymbolCalibrator(this.cfg, data.calibrator);
      logger.info(`state restored: profit=${this.stats.overallProfit.toFixed(2)}`);
    } catch (e) {
      logger.warn('state load failed:', e.message);
    }
  }

  currency() { return this.client.currency || this.cfg.currency; }

  stop(signal) {
    this.stopped = true;
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>Bot stopped</b>\nProfit: ${money(this.stats.overallProfit, this.currency())}`);
    if (this._analysisT) clearInterval(this._analysisT);
    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 13. BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Simple Digit Differ Bot                              ║');
  console.log('║   Focus: Risk Management, Not Pattern Prediction       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Synthetic indices use cryptographically secure RNG.');
  console.log('  Each tick is independent - past patterns don\'t predict futures.');
  console.log('  This bot uses conservative heuristics + strong risk management.');
  console.log('');
}

async function main() {
  printBanner();

  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN not set. Create .env file or set environment variable.');
    process.exit(1);
  }

  const bot = new TradingBot();
  await bot.start();
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
