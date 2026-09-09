#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  accuHOLD v2 — spike-pattern BOOM/CRASH ACCU bot
 * =====================================================================
 *
 *  Single-file Deriv Accumulator (ACCU) trading bot — TEST/DEMO ONLY.
 *
 *  ─ STRATEGY (v2 — pattern-based) ─────────────────────────────────
 *  1. Detect spikes: subscribe to tick stream, identify ≥2% growth
 *     events (configurable threshold).
 *  2. Store spike history: timestamp, symbol, growth magnitude,
 *     post-spike tick behavior (for learning).
 *  3. Analyze last N spikes (default 5, user-configurable): compute
 *     optimal entry delay (seconds after spike) and optimal hold
 *     duration (ticks, default = half of mean survival, configurable).
 *  4. Execute ONE trade per new spike: after detected spike, wait
 *     the learned delay, enter ACCU contract, hold for learned tick
 *     count, exit.
 *  5. Learn continuously: each completed trade updates the spike's
 *     outcome data, refining future entry/hold parameters.
 *
 *  ─ KEY DIFFERENCES FROM v1 ──────────────────────────────────────
 *  • v1 = memoryless (no timing signal)
 *  • v2 = pattern-based (spike detection + post-spike timing learned
 *         from historical data)
 *
 *  ─ RISK CONTROLS ─────────────────────────────────────────────────
 *  Flat stake, max consecutive losses, daily loss cap, one trade per
 *  spike (prevents overtrading), warm-up period (requires N spikes
 *  observed before first trade).
 *
 *  Author: Cowork 3P  |  License: MIT
 * =====================================================================
 */

// ═══════════════════════════════════════════════════════════════════════
// 0. DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════
const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ═══════════════════════════════════════════════════════════════════════
// 1. .ENV LOADER
// ═══════════════════════════════════════════════════════════════════════
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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.error('[boot] .env read error:', e.message); }
}
loadEnv();

// ═══════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  // ── Deriv API ──
  apiToken   : 'pat_8e0a3285bd6e74f52a67985b8069f4bea42aa96ce65d129c60ebb838ed1065ee',
  appId      : '33uslPtthXBEkQOdfKfoY',
  wsUrl      : 'wss://ws.derivws.com/websockets/v3',
  currency   : 'USD',
  accountType: 'demo',

  // ── Trade parameters (spike-pattern strategy) ──
  stake              : parseFloat('1.00'),
  takeProfitMultiple : parseFloat('1.50'),   // fallback exit if pattern prediction wrong
  growthRate         : parseFloat('0.02'),   // 2% ACCU growth rate

  // ── Spike detection ──
  spikeThresholdPct  : parseFloat('2.0'),    // ≥2% tick growth = spike

  // ── Pattern analysis ──
  spikeHistoryCount  : parseInt('5', 10),    // analyze last N spikes
  holdDurationFactor : parseFloat('0.25'),    // hold ticks = factor × mean survival
  minSpikesForTrade  : parseInt('5', 10),    // warm-up: need N spikes before first trade

  // ── Rate-limiting (one trade per spike) ──
  maxOpenTrades       : parseInt('1', 10),   // one at a time
  minSecondsBetweenTrades: parseInt('10', 10), // safety: min 10s between trades

  // ── Risk controls ──
  maxConsecutiveLosses : parseInt('7', 10),
  dailyMaxLoss        : parseFloat('50'),
  dailyMaxTrades      : parseInt('120', 10),

  // ── Instruments ──
  assets: ('BOOM500,BOOM600,BOOM900,BOOM1000,CRASH500,CRASH600,CRASH900,CRASH1000')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Telegram ──
  telegram: {
    enabled : true,
    botToken: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    chatId  : '752497117',
    maxQueue: parseInt('200', 10),
  },

  // ── Reconnect ──
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, backoffFactor: 2, jitterMs: 750 },

  // ── Watchdog ──
  tradeWatchdogMs: parseInt('90000', 10),

  // ── Scheduled pause/resume (GMT) ──
  pauseEnabled : true,
  pauseStartGmt: '23:00',
  pauseEndGmt  : '1:00',

  // ── Day-of-week filter (GMT) ──
  tradeSunday: true, tradeMonday: true, tradeTuesday: true,
  tradeWednesday: true, tradeThursday: true, tradeFriday: true, tradeSaturday: true,

  // ── Logging ──
  logLevel: 'INFO',
  logFile : 'accuHOLD_v2.log',

  // ── State persistence ──
  stateFile: 'accuHOLD_v2_state.json',
  spikeHistoryFile: 'accuHOLD_v2_spikes.json',

  // ── Hourly summary + EOD ──
  hourlyStatsEnabled: true,
  eodStatsEnabled   : true,
});

// ═══════════════════════════════════════════════════════════════════════
// 3. LOGGER
// ═══════════════════════════════════════════════════════════════════════
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
function _writeLog(line) { try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {} }
function log(level, msg, ...rest) {
  if ((LOG_LEVELS[level] ?? 1) > currentLevel) return;
  const extras = rest.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${ts()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}
const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

// ═══════════════════════════════════════════════════════════════════════
// 4. TELEGRAM NOTIFIER (with retry and timeout handling)
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier {
  constructor(botToken, chatId, maxQueue = 200) {
    this.botToken = botToken;
    this.chatId   = chatId;
    this.maxQueue = maxQueue;
    this.queue    = [];
    this.sending  = false;
    this.enabled  = CONFIG.telegram.enabled && botToken && chatId;
    if (!this.enabled) logger.info('[telegram] disabled');
  }
  send(text, parseMode = 'HTML') {
    if (!this.enabled) return;
    if (this.queue.length >= this.maxQueue) {
      logger.warn(`[telegram] queue full (${this.maxQueue}), dropping message`);
      return;
    }
    this.queue.push({ text, parseMode, retries: 0 });
    this._process();
  }
  async _process() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    while (this.queue.length) {
      const msg = this.queue[0];
      try {
        const body = JSON.stringify({
          chat_id   : this.chatId,
          text      : msg.text,
          parse_mode: msg.parseMode,
        });
        await new Promise((resolve, reject) => {
          const req = https.request('https://api.telegram.org/bot' + this.botToken + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 15000,
          }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              if (res.statusCode === 200) resolve();
              else reject(new Error(`Telegram HTTP ${res.statusCode}: ${data}`));
            });
          });
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Telegram request timeout'));
          });
          req.write(body);
          req.end();
        });
        this.queue.shift(); // success
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        msg.retries++;
        if (msg.retries >= 3) {
          logger.warn('[telegram] send failed after 3 retries:', e.message);
          this.queue.shift(); // give up
        } else {
          logger.warn(`[telegram] send failed (retry ${msg.retries}/3):`, e.message);
          await new Promise(r => setTimeout(r, 2000 * msg.retries)); // backoff
        }
      }
    }
    this.sending = false;
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram.botToken, CONFIG.telegram.chatId, CONFIG.telegram.maxQueue);

// ═══════════════════════════════════════════════════════════════════════
// 5. DERIV REST CLIENT (PAT/OAuth)
// ═══════════════════════════════════════════════════════════════════════
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }
  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
  _request(method, reqPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(reqPath, this.baseUrl); } catch (e) { return reject(new Error(`Invalid URL: ${reqPath}`)); }
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : require('http');
      const opts = {
        method, hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Deriv-App-ID': this.appId, 'Authorization': 'Bearer ' + this.token,
          'Accept': 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 15000,
      };
      const req = lib.request(opts, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { let parsed = data; try { parsed = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: parsed }); });
      });
      req.on('timeout', () => { req.destroy(new Error('REST timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  async get(p) { return this._request('GET', p); }
  async post(p, b) { return this._request('POST', p, b); }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. DERIV WEBSOCKET CLIENT (PAT/OAuth, reconnect, keep-alive)
// ═══════════════════════════════════════════════════════════════════════
class DerivClient extends EventEmitter {
  constructor(wsUrl, appId, apiToken) {
    super();
    this.wsUrl    = wsUrl;
    this.appId    = appId;
    this.apiToken = apiToken;
    this.ws       = null;
    this.reqId    = 1000;
    this.pending  = new Map();
    this.authorized = false;
    this.stopped    = false;
    this.reconnectDelay = CONFIG.reconnect.initialDelayMs;
    this.reconnecting   = false;
    this.keepAliveTicksSub = null;
    this.keepAlivePingTimer = null;
    this.accountInfo = null;
    this.balance = null;
    this._isPat = RestClient.isPat(apiToken);
    this._rest = this._isPat ? new RestClient('https://api.derivws.com', appId, apiToken) : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }
  start() {
    if (this.ws) return;
    this.stopped = false;
    this._connect();
  }
  stop() {
    this.stopped = true;
    this._stopKeepAlive();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.pending.forEach(({ reject }) => reject(new Error('client stopped')));
    this.pending.clear();
    this.authorized = false;
  }
  async call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new Error('WebSocket not open');
    const id = ++this.reqId;
    const req = { [method]: 1, ...params, req_id: id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(req));
    });
  }
  async subscribe(method, params, handler) {
    const resp = await this.call(method, { ...params, subscribe: 1 });
    const subId = resp.subscription?.id;
    if (!subId) throw new Error('no subscription id');
    this.on(`sub:${subId}`, handler);
    return { id: subId, unsubscribe: () => this._unsub(subId) };
  }
  async _unsub(subId) {
    try {
      await this.call('forget', { forget: subId });
      this.removeAllListeners(`sub:${subId}`);
    } catch (e) {
      logger.warn(`[deriv] unsub ${subId} failed:`, e.message);
    }
  }
  _redact(url) { return url.replace(/([?&])(otp|app_id|token)=[^&]+/g, '$1$2=***'); }
  _connect() {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    if (this._isPat) {
      logger.info('[deriv] PAT token detected → new API (OTP flow)');
      this._newApiConnect().catch(e => {
        logger.error('[deriv] new API connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      const url = `${this.wsUrl}?app_id=${this.appId}`;
      logger.info(`[deriv] connecting → ${this._redact(url)}`);
      this._openWs(url);
    }
  }
  async _newApiConnect() {
    const desiredType = (CONFIG.accountType || 'demo').toLowerCase();
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      throw new Error(`account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('no Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = {
      loginid: acct.account_id,
      email: acct.email,
      isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type,
      currency: acct.currency,
      balance: parseFloat(acct.balance),
      group: acct.group,
    };
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    this._otpUrl = wsUrl;
    logger.info(`[deriv] connecting OTP → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }
  _openWs(url) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'accuHOLD_v2/1.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      logger.error('[deriv] ws construct failed:', e.message);
      this._scheduleReconnect();
      return false;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', data => this._onMessage(data));
    this.ws.on('error', err => this._onError(err));
    this.ws.on('close', (code, reason) => this._onClose(code, reason));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('[deriv] ws handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {}
      this._scheduleReconnect();
    });
    return true;
  }
  async _onOpen() {
    this.reconnecting = false;
    this.reconnectDelay = CONFIG.reconnect.initialDelayMs;
    logger.info('[deriv] ws connected');
    if (this._isPat) {
      this._newApiMarkAuthorized();
    } else {
      this._authorize();
    }
  }
  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance = this.accountInfo.balance ?? null;
    logger.info(`[deriv] authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
    this._startPing();
    this._startKeepAlive().catch(e => logger.debug('[deriv] keep-alive start:', e.message));
    this.emit('authorized', this.accountInfo);
  }
  async _authorize() {
    try {
      const authResp = await this.call('authorize', { authorize: this.apiToken });
      if (authResp.error) throw new Error(authResp.error.message);
      this.authorized = true;
      this.balance = parseFloat(authResp.authorize.balance);
      this.accountInfo = {
        loginid: authResp.authorize.loginid,
        email: authResp.authorize.email,
        isVirtual: !!authResp.authorize.is_virtual,
        accountType: authResp.authorize.account_type,
        currency: authResp.authorize.currency,
      };
      logger.info(`[deriv] authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance}`);
      this._startPing();
      this._startKeepAlive().catch(e => logger.debug('[deriv] keep-alive start:', e.message));
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('[deriv] auth failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }
  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.error) {
      const code = msg.error.code;
      logger.error(`[deriv] api error: ${code} – ${msg.error.message}`);
      if (msg.req_id && this.pending.has(msg.req_id)) {
        const p = this.pending.get(msg.req_id);
        clearTimeout(p.timer);
        this.pending.delete(msg.req_id);
        p.reject(new Error(msg.error.message || code));
      }
      return;
    }
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id);
      clearTimeout(p.timer);
      this.pending.delete(msg.req_id);
      p.resolve(msg);
    }
    if (msg.subscription) {
      this.emit(`sub:${msg.subscription.id}`, msg);
    }
    if (msg.msg_type === 'ping') {
      this.ws.send(JSON.stringify({ ping: 1 }));
    }
  }
  _onError(err) {
    logger.warn('[deriv] ws error:', err.message);
  }
  _onClose(code, reason) {
    logger.warn(`[deriv] closed: ${code} ${reason || ''}`);
    this._stopKeepAlive();
    this.authorized = false;
    this.ws = null;
    if (!this.stopped) {
      this._scheduleReconnect();
    }
  }
  _scheduleReconnect() {
    if (this.stopped || this.reconnecting) return;
    const delay = this.reconnectDelay + Math.random() * CONFIG.reconnect.jitterMs;
    logger.info(`[deriv] reconnect in ${(delay/1000).toFixed(1)}s`);
    setTimeout(() => {
      this.reconnecting = false;
      this._connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * CONFIG.reconnect.backoffFactor, CONFIG.reconnect.maxDelayMs);
  }
  async _startKeepAlive() {
    if (this.keepAliveTicksSub) return;
    // Use a symbol NOT in the spike detector's list to avoid AlreadySubscribed
    const symbol = 'R_10';
    try {
      const resp = await this.call('ticks', { ticks: symbol, subscribe: 1 });
      this.keepAliveTicksSub = resp.subscription?.id;
      logger.debug(`[deriv] keep-alive ticks started (${symbol})`);
    } catch (e) {
      logger.warn('[deriv] keep-alive ticks failed:', e.message);
    }
  }
  _startPing() {
    this._stopPing();
    this.keepAlivePingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch {}
      }
    }, 25000);
  }
  _stopKeepAlive() {
    if (this.keepAliveTicksSub) {
      this._unsub(this.keepAliveTicksSub).catch(() => {});
      this.keepAliveTicksSub = null;
    }
    this._stopPing();
  }
  _stopPing() {
    if (this.keepAlivePingTimer) {
      clearInterval(this.keepAlivePingTimer);
      this.keepAlivePingTimer = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. SPIKE DETECTOR & HISTORY MANAGER
// ═══════════════════════════════════════════════════════════════════════
class SpikeDetector extends EventEmitter {
  constructor(client, symbols, thresholdPct) {
    super();
    this.client = client;
    this.symbols = symbols;
    this.thresholdPct = thresholdPct;
    this.lastPrices = new Map(); // symbol → last quote
    this.subscriptions = new Map();
  }
  async start() {
    for (const sym of this.symbols) {
      try {
        const sub = await this.client.subscribe('ticks', { ticks: sym }, msg => this._onTick(sym, msg));
        this.subscriptions.set(sym, sub);
        logger.info(`[spike] subscribed to ${sym}`);
      } catch (e) {
        logger.error(`[spike] subscribe ${sym} failed:`, e.message);
      }
    }
  }
  stop() {
    for (const [sym, sub] of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
    this.lastPrices.clear();
  }
  _onTick(symbol, msg) {
    if (!msg.tick) return;
    const quote = msg.tick.quote;
    if (!quote || !Number.isFinite(quote)) return;

    const last = this.lastPrices.get(symbol);
    if (last != null && Number.isFinite(last)) {
      const growthPct = ((quote - last) / last) * 100;
      if (Math.abs(growthPct) >= this.thresholdPct) {
        const spike = {
          symbol,
          timestamp: Date.now() / 1000,
          epoch: msg.tick.epoch,
          priceBefore: last,
          priceAfter: quote,
          growthPct: growthPct,
          direction: growthPct > 0 ? 'up' : 'down',
        };
        logger.info(`[spike] detected ${symbol} ${growthPct > 0 ? '📈' : '📉'} ${growthPct.toFixed(2)}% (${last.toFixed(2)} → ${quote.toFixed(2)})`);
        this.emit('spike', spike);
      }
    }
    this.lastPrices.set(symbol, quote);
  }
}

class SpikeHistoryManager {
  constructor(maxCount = 100, filePath = CONFIG.spikeHistoryFile) {
    this.maxCount = maxCount;
    this.filePath = filePath;
    this.spikes = []; // array of spike records
    this._load();
  }
  addSpike(spike) {
    this.spikes.push({
      ...spike,
      id: `${spike.symbol}_${spike.timestamp}`,
      tradeExecuted: false,
      tradeOutcome: null, // will be set after trade completes
    });
    if (this.spikes.length > this.maxCount) {
      this.spikes.shift();
    }
    this._save();
  }
  getRecentSpikes(symbol, count = CONFIG.spikeHistoryCount) {
    return this.spikes
      .filter(s => s.symbol === symbol && s.tradeExecuted)
      .slice(-count);
  }
  updateTradeOutcome(spikeId, outcome) {
    const spike = this.spikes.find(s => s.id === spikeId);
    if (!spike) return;
    spike.tradeOutcome = outcome;
    this._save();
  }
  markTradeExecuted(spikeId) {
    const spike = this.spikes.find(s => s.id === spikeId);
    if (!spike) return;
    spike.tradeExecuted = true;
    this._save();
  }
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.spikes = data.spikes || [];
        logger.info(`[spike-history] loaded ${this.spikes.length} spikes`);
      }
    } catch (e) {
      logger.warn('[spike-history] load failed:', e.message);
    }
  }
  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ spikes: this.spikes }, null, 2));
    } catch (e) {
      logger.warn('[spike-history] save failed:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. PATTERN ANALYZER
// ═══════════════════════════════════════════════════════════════════════
class PatternAnalyzer {
  constructor(spikeHistory, holdFactor = CONFIG.holdDurationFactor) {
    this.history = spikeHistory;
    this.holdFactor = holdFactor;
  }
  analyze(symbol) {
    const recent = this.history.getRecentSpikes(symbol, CONFIG.spikeHistoryCount);
    if (recent.length < CONFIG.minSpikesForTrade) {
      logger.debug(`[pattern] ${symbol}: insufficient data (${recent.length}/${CONFIG.minSpikesForTrade})`);
      return null; // not enough data
    }

    // Compute mean entry delay (seconds after spike) from successful trades
    const successfulTrades = recent.filter(s => s.tradeOutcome && s.tradeOutcome.profit > 0);
    let entryDelaySec = 3; // default 3s if no successful trades yet
    if (successfulTrades.length > 0) {
      const delays = successfulTrades.map(s => s.tradeOutcome.entryDelaySec || 3);
      entryDelaySec = delays.reduce((a, b) => a + b, 0) / delays.length;
      logger.debug(`[pattern] ${symbol}: entry delay from ${successfulTrades.length} wins → ${entryDelaySec.toFixed(1)}s`);
    } else {
      logger.debug(`[pattern] ${symbol}: no wins yet, using default entry delay ${entryDelaySec}s`);
    }

    // Compute mean hold ticks from all completed trades
    const completedTrades = recent.filter(s => s.tradeOutcome && s.tradeOutcome.ticksHeld > 0);
    let holdTicks = 30; // default 30 ticks if no data
    if (completedTrades.length > 0) {
      const ticks = completedTrades.map(s => s.tradeOutcome.ticksHeld);
      const meanTicks = ticks.reduce((a, b) => a + b, 0) / ticks.length;
      holdTicks = Math.max(5, Math.floor(meanTicks * this.holdFactor));
      logger.info(`[pattern] ${symbol}: hold duration from ${completedTrades.length} trades → mean=${meanTicks.toFixed(1)} × ${this.holdFactor} = ${holdTicks} ticks`);
    } else {
      logger.debug(`[pattern] ${symbol}: no completed trades yet, using default hold ${holdTicks} ticks`);
    }

    const pattern = {
      entryDelaySec: Math.max(1, Math.floor(entryDelaySec)),
      holdTicks,
      sampleSize: recent.length,
      winRate: successfulTrades.length / recent.length,
    };

    logger.info(`[pattern] ${symbol}: delay=${pattern.entryDelaySec}s hold=${pattern.holdTicks}t sample=${pattern.sampleSize} wr=${(pattern.winRate*100).toFixed(0)}%`);
    return pattern;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. TRADE EXECUTOR (spike-triggered, learned timing)
// ═══════════════════════════════════════════════════════════════════════
class TradeExecutor extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.openTrades = new Map(); // contractId → info
    this._settledIds = new Set();
    this._selling = new Set();
  }
  async buy(symbol, stake, growthRate, holdTicks, spikeId) {
    try {
      const proposal = await this.client.call('proposal', {
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: CONFIG.currency,
        symbol,
        growth_rate: growthRate,
      });
      if (proposal.error) throw new Error(proposal.error.message);
      const p = proposal.proposal;
      const buyResp = await this.client.call('buy', {
        buy: p.id,
        price: stake,
      });
      if (buyResp.error) throw new Error(buyResp.error.message);
      const b = buyResp.buy;
      const contractId = String(b.contract_id);

      const info = {
        contractId,
        symbol,
        stake,
        growthRate,
        targetHoldTicks: holdTicks,
        spikeId,
        buyTime: b.purchase_time || (Date.now() / 1000),
        buyPrice: b.buy_price,
        ticksHeld: 0,
        _tickAnchor: null,
        status: 'open',
      };
      this.openTrades.set(contractId, info);

      // Subscribe to updates
      const sub = await this.client.subscribe('proposal_open_contract', { contract_id: contractId }, msg => {
        this._onUpdate(contractId, msg);
      });
      info.subscription = sub;

      logger.info(`[trade] opened #${contractId} ${symbol} stake=${stake} holdTarget=${holdTicks} ticks`);
      this.emit('opened', info);
      return info;
    } catch (e) {
      logger.error('[trade] buy failed:', e.message);
      throw e;
    }
  }
  async sell(contractId, reason = 'manual') {
    const info = this.openTrades.get(contractId);
    if (!info || info.status !== 'open') {
      logger.warn(`[trade] sell #${contractId} rejected: not open`);
      return null;
    }
    if (this._selling.has(contractId)) {
      logger.debug(`[trade] sell #${contractId} already in progress`);
      return null;
    }
    this._selling.add(contractId);
    try {
      const sellResp = await this.client.call('sell', { sell: contractId, price: 0 });
      if (sellResp.error) {
        if (sellResp.error.code === 'InvalidtoSell') {
          // Entry tick, defer
          this._selling.delete(contractId);
          return null;
        }
        throw new Error(sellResp.error.message);
      }
      const s = sellResp.sell;
      logger.info(`[trade] sold #${contractId} price=${s.sold_for} [${reason}]`);
      return s;
    } catch (e) {
      logger.error(`[trade] sell #${contractId} failed:`, e.message);
      this._selling.delete(contractId);
      return null;
    }
  }
  _onUpdate(contractId, msg) {
    const info = this.openTrades.get(contractId);
    if (!info) return;
    const c = msg.proposal_open_contract;
    if (!c) return;

    // Anchor ticks on first update
    if (info._tickAnchor == null && c.tick_count != null) {
      info._tickAnchor = c.tick_count;
      logger.debug(`[trade] #${contractId} tick anchor=${info._tickAnchor}`);
    }

    // Compute ticks held
    if (c.tick_count != null && info._tickAnchor != null) {
      info.ticksHeld = Math.max(0, c.tick_count - info._tickAnchor) + 1;
    }

    // Terminal status
    const TERMINAL_STATUSES = new Set(['sold', 'won', 'lost', 'cancelled']);
    if (c.status && TERMINAL_STATUSES.has(c.status)) {
      if (this._settledIds.has(contractId)) return;
      this._settledIds.add(contractId);
      this._selling.delete(contractId);

      const profit = Number(c.profit || 0);
      const status = c.status === 'won' ? 'won' : 'lost';
      const exitReason = c.status === 'sold' ? 'voluntary-sell' : c.status;

      this._finalize(contractId, {
        status,
        exitReason,
        profit,
        sellPrice: Number(c.sell_price || 0),
        sellTime: c.sell_time ?? (Date.now() / 1000),
        ticksHeld: info.ticksHeld,
      });
      return;
    }

    // Check learned tick-cap exit
    if (info.ticksHeld >= info.targetHoldTicks) {
      logger.info(`[trade] #${contractId} hit learned tick-cap (${info.ticksHeld} ≥ ${info.targetHoldTicks})`);
      this.sell(contractId, 'learned-tick-cap');
      return;
    }

    // Fallback: take-profit
    const profit = Number(c.profit || 0);
    if (profit >= info.stake * (CONFIG.takeProfitMultiple - 1)) {
      logger.info(`[trade] #${contractId} take-profit ${profit.toFixed(2)}`);
      this.sell(contractId, 'take-profit');
    }
  }
  _finalize(contractId, outcome) {
    const info = this.openTrades.get(contractId);
    if (!info) return;

    info.status = outcome.status;
    info.exitReason = outcome.exitReason;
    info.profit = outcome.profit;
    info.sellPrice = outcome.sellPrice;
    info.sellTime = outcome.sellTime;
    info.ticksHeld = outcome.ticksHeld;

    if (info.subscription) {
      info.subscription.unsubscribe();
    }

    this.openTrades.delete(contractId);
    logger.info(`[trade] settled #${contractId} status=${outcome.status} profit=${outcome.profit.toFixed(2)} [${outcome.exitReason}]`);
    this.emit('closed', info);
  }
  hasOpenTrades() {
    return this.openTrades.size > 0;
  }
  getOpenCount() {
    return this.openTrades.size;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. STATISTICS
// ═══════════════════════════════════════════════════════════════════════
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour    = (d = new Date()) => d.getUTCHours();
const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;

function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return 'n/a';
  const s = Math.floor(totalSec);
  if (s < 1)    return '<1s';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.maxLossStreak = 0;
    if (saved) {
      this.trades = saved.trades || [];
      this.maxLossStreak = saved.maxLossStreak || 0;
    }
  }
  addTrade(t) {
    this.trades.push(t);
    const recent = this.trades.slice(-20);
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].status === 'lost') streak++;
      else break;
    }
    if (streak > this.maxLossStreak) this.maxLossStreak = streak;
  }
  todayTrades(dateStr = utcDateStr()) {
    return this.trades.filter(t => t.date === dateStr);
  }
  stats(trades) {
    if (!trades.length) return { count: 0, wins: 0, losses: 0, winRate: 0, totalProfit: 0, profitFactor: 0 };
    const wins = trades.filter(t => t.status === 'won').length;
    const losses = trades.filter(t => t.status === 'lost').length;
    const totalProfit = trades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const grossWin = trades.filter(t => t.profit > 0).reduce((s, t) => s + t.profit, 0);
    const grossLoss = Math.abs(trades.filter(t => t.profit < 0).reduce((s, t) => s + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
    return {
      count: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalProfit,
      profitFactor,
    };
  }
  serialize() {
    return { trades: this.trades, maxLossStreak: this.maxLossStreak };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. MAIN BOT
// ═══════════════════════════════════════════════════════════════════════
class AccuHoldV2Bot {
  constructor() {
    this.client = new DerivClient(CONFIG.wsUrl, CONFIG.appId, CONFIG.apiToken);
    this.executor = new TradeExecutor(this.client);
    this.spikeHistory = new SpikeHistoryManager(100);
    this.analyzer = new PatternAnalyzer(this.spikeHistory);
    this.detector = new SpikeDetector(this.client, CONFIG.assets, CONFIG.spikeThresholdPct);
    this.stats = new StatisticsManager();

    this.lastBalance = null;
    this.consecutiveLosses = 0;
    this.overallProfit = 0;
    this.paused = false;
    this.lastTradeAt = 0;
    this.pendingSpikes = []; // spikes waiting for their entry delay

    this._loadState();
  }
  async start() {
    logger.info('╔══════════════════════════════════════════════════════╗');
    logger.info('║   accuHOLD v2 — spike-pattern BOOM/CRASH ACCU bot  ║');
    logger.info('║   Detects spikes, learns timing, 1 trade per spike   ║');
    logger.info('╚══════════════════════════════════════════════════════╝');

    this.client.on('authorized', () => this._onAuthorized());
    this.executor.on('opened', t => this._onTradeOpened(t));
    this.executor.on('closed', t => this._onTradeClosed(t));
    this.detector.on('spike', s => this._onSpikeDetected(s));

    this.client.start();

    // Pause check
    this._pauseCheckTimer = setInterval(() => this._checkPause(), 60000);

    // Hourly/EOD
    this._statsTimer = setInterval(() => this._checkStats(), 60000);

    telegram.send('🤖 <b>accuHOLD v2 started</b>\nSpike-pattern strategy · 1 trade per spike');
  }
  stop() {
    clearInterval(this._pauseCheckTimer);
    clearInterval(this._statsTimer);
    this.detector.stop();
    this.client.stop();
    logger.info('[bot] stopped');
  }
  async _onAuthorized() {
    try {
      const balResp = await this.client.call('balance', { balance: 1 });
      this.lastBalance = Number(balResp.balance.balance || 0);
      logger.info(`[bot] balance: ${this.lastBalance.toFixed(2)} ${CONFIG.currency}`);

      await this.detector.start();
      logger.info('[bot] spike detector started');
    } catch (e) {
      logger.error('[bot] init failed:', e.message);
    }
  }
  _onSpikeDetected(spike) {
    this.spikeHistory.addSpike(spike);
    const totalSpikes = this.spikeHistory.spikes.filter(s => s.symbol === spike.symbol).length;
    logger.info(`[bot] spike ${spike.symbol} recorded (total for ${spike.symbol}: ${totalSpikes})`);

    // Check if we can trade (warm-up, pause, max open)
    if (this.paused) {
      logger.info(`[bot] spike ${spike.symbol} ignored: paused`);
      return;
    }
    if (!this._isTradingAllowedToday()) {
      logger.info(`[bot] spike ${spike.symbol} ignored: day-of-week filter`);
      return;
    }

    const todayTrades = this.stats.todayTrades();
    if (todayTrades.length >= CONFIG.dailyMaxTrades) {
      logger.info(`[bot] spike ${spike.symbol} ignored: daily trade cap`);
      return;
    }

    const todayStats = this.stats.stats(todayTrades);
    if (todayStats.totalProfit <= -CONFIG.dailyMaxLoss) {
      logger.warn(`[bot] spike ${spike.symbol} ignored: daily loss cap`);
      telegram.send(`⛔ <b>Daily loss cap reached</b>\nLoss: ${money(todayStats.totalProfit)}`);
      this.paused = true;
      return;
    }

    if (this.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
      logger.warn(`[bot] spike ${spike.symbol} ignored: max consecutive losses`);
      telegram.send(`⛔ <b>Max consecutive losses</b>\nStreak: ${this.consecutiveLosses}`);
      this.paused = true;
      return;
    }

    if (this.executor.getOpenCount() >= CONFIG.maxOpenTrades) {
      logger.info(`[bot] spike ${spike.symbol} ignored: max open trades`);
      return;
    }

    // Analyze pattern
    const pattern = this.analyzer.analyze(spike.symbol);
    if (!pattern) {
      const current = this.spikeHistory.spikes.filter(s => s.symbol === spike.symbol && s.tradeExecuted).length;
      logger.info(`[bot] spike ${spike.symbol} ignored: warm-up (${current}/${CONFIG.minSpikesForTrade} spikes needed)`);
      telegram.send(`📊 <b>Spike detected: ${spike.symbol}</b>\n${spike.growthPct > 0 ? '📈' : '📉'} ${spike.growthPct.toFixed(2)}%\n\nWarm-up phase: ${current}/${CONFIG.minSpikesForTrade} spikes needed before trading.`);
      return;
    }

    logger.info(`[bot] spike ${spike.symbol}: scheduling trade (delay=${pattern.entryDelaySec}s hold=${pattern.holdTicks}t wr=${(pattern.winRate*100).toFixed(0)}%)`);

    // Schedule trade entry
    const executeAt = Date.now() + (pattern.entryDelaySec * 1000);
    this.pendingSpikes.push({ spike, pattern, executeAt });

    telegram.send(
      `🎯 <b>Spike detected: ${spike.symbol}</b>\n` +
      `${spike.growthPct > 0 ? '📈' : '📉'} Growth: ${spike.growthPct.toFixed(2)}%\n` +
      `Entry in: ${pattern.entryDelaySec}s\n` +
      `Hold target: ${pattern.holdTicks} ticks\n` +
      `Pattern: ${pattern.sampleSize} spikes, WR ${(pattern.winRate*100).toFixed(0)}%`
    );

    // Process pending entries
    setTimeout(() => this._processPendingSpikes(), pattern.entryDelaySec * 1000 + 100);
  }
  async _processPendingSpikes() {
    const now = Date.now();
    const ready = this.pendingSpikes.filter(p => p.executeAt <= now);
    this.pendingSpikes = this.pendingSpikes.filter(p => p.executeAt > now);

    for (const { spike, pattern } of ready) {
      // Rate limit check
      if (now - this.lastTradeAt < CONFIG.minSecondsBetweenTrades * 1000) {
        logger.info(`[bot] spike ${spike.symbol} deferred: rate limit`);
        continue;
      }

      if (this.executor.getOpenCount() >= CONFIG.maxOpenTrades) {
        logger.info(`[bot] spike ${spike.symbol} skipped: max open`);
        continue;
      }

      try {
        const info = await this.executor.buy(
          spike.symbol,
          CONFIG.stake,
          CONFIG.growthRate,
          pattern.holdTicks,
          spike.id
        );
        this.spikeHistory.markTradeExecuted(spike.id);
        this.lastTradeAt = Date.now();
      } catch (e) {
        logger.error(`[bot] spike ${spike.symbol} entry failed:`, e.message);
      }
    }
  }
  _onTradeOpened(t) {
    telegram.send(
      `🟢 <b>TRADE OPENED</b>\n\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code> · #${t.contractId}\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}% · <b>Stake:</b> ${t.stake.toFixed(2)} ${CONFIG.currency}\n` +
      `<b>Hold target:</b> ${t.targetHoldTicks} ticks (learned)\n` +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${CONFIG.currency}`
    );
  }
  async _onTradeClosed(t) {
    // Update balance
    try {
      const balResp = await this.client.call('balance', { balance: 1 });
      this.lastBalance = Number(balResp.balance.balance || 0);
    } catch {}

    const profit = t.profit || 0;
    this.overallProfit += profit;

    if (t.status === 'won') {
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
    }

    const rec = {
      date: utcDateStr(new Date(t.buyTime * 1000)),
      contractId: t.contractId,
      symbol: t.symbol,
      growthRate: t.growthRate,
      stake: t.stake,
      buyTime: t.buyTime,
      sellTime: t.sellTime,
      sellPrice: t.sellPrice,
      profit,
      status: t.status,
      exitReason: t.exitReason,
      ticksHeld: t.ticksHeld,
      targetHoldTicks: t.targetHoldTicks,
      spikeId: t.spikeId,
    };
    this.stats.addTrade(rec);

    // Update spike outcome
    const entryDelaySec = 3; // we don't track actual delay, use pattern default
    this.spikeHistory.updateTradeOutcome(t.spikeId, {
      profit,
      ticksHeld: t.ticksHeld,
      entryDelaySec,
    });

    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));
    const emoji = t.status === 'won' ? '✅' : '❌';
    const label = t.status === 'won' ? 'WIN' : 'LOSS';
    const exit = t.exitReason || 'n/a';
    const exitLine = exit.startsWith('learned-tick-cap') ? '🧠 learned-tick-cap'
                  : exit.startsWith('take-profit')       ? '🎯 take-profit'
                  : exit.startsWith('knockout')          ? '💥 knockout'
                  : exit;
    const buyTs  = Number(t.buyTime  || 0);
    const sellTs = Number(t.sellTime || 0);
    const durationSec = (buyTs > 0 && sellTs > 0 && sellTs >= buyTs) ? (sellTs - buyTs) : null;
    const durationLine = durationSec != null
      ? `⏱️ <b>Duration:</b> ${formatDuration(durationSec)}\n`
      : `⏱️ <b>Duration:</b> n/a\n`;

    const msg =
      `${emoji} <b>TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId} · <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate*100).toFixed(0)}% · <b>Stake:</b> ${Number(t.stake).toFixed(2)} ${CONFIG.currency}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice ?? 0).toFixed(2)} ${CONFIG.currency}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)} ${CONFIG.currency}\n` +
      `<b>Exit:</b> ${exitLine}\n` +
      durationLine +
      `<b>Ticks held:</b> ${t.ticksHeld ?? '?'} (target was ${t.targetHoldTicks})\n` +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${CONFIG.currency}\n\n` +
      `<b>GMT Day (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}) | WR ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net: ${money(todayStats.totalProfit)} | PF ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${money(this.overallProfit)}\n` +
      `<b>Consecutive losses:</b> ${this.consecutiveLosses} | max ${this.stats.maxLossStreak}`;
    telegram.send(msg);

    this._saveState();
  }
  _checkPause() {
    if (!CONFIG.pauseEnabled) return;
    const now = new Date();
    const hm = `${now.getUTCHours()}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    const [startH, startM] = CONFIG.pauseStartGmt.split(':').map(Number);
    const [endH, endM] = CONFIG.pauseEndGmt.split(':').map(Number);
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    const inPauseWindow = (endMin > startMin)
      ? (nowMin >= startMin && nowMin < endMin)
      : (nowMin >= startMin || nowMin < endMin);

    if (inPauseWindow && !this.paused) {
      this.paused = true;
      logger.info('[bot] scheduled pause activated');
      telegram.send('🛑 <b>Scheduled pause</b>\nResuming at ' + CONFIG.pauseEndGmt + ' GMT');
    } else if (!inPauseWindow && this.paused) {
      this.paused = false;
      logger.info('[bot] scheduled pause ended');
      telegram.send('▶️ <b>Resumed</b>');
    }
  }
  _isTradingAllowedToday() {
    const dow = new Date().getUTCDay();
    const allowed = [
      CONFIG.tradeSunday, CONFIG.tradeMonday, CONFIG.tradeTuesday, CONFIG.tradeWednesday,
      CONFIG.tradeThursday, CONFIG.tradeFriday, CONFIG.tradeSaturday
    ];
    return allowed[dow];
  }
  _checkStats() {
    const h = utcHour();
    const today = utcDateStr();

    if (CONFIG.hourlyStatsEnabled && !this._lastHourlyStat) {
      this._lastHourlyStat = h;
    }
    if (CONFIG.hourlyStatsEnabled && h !== this._lastHourlyStat) {
      this._lastHourlyStat = h;
      const todayStats = this.stats.stats(this.stats.todayTrades(today));
      if (todayStats.count > 0) {
        telegram.send(
          `📊 <b>Hourly summary</b>\n` +
          `Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
          `Net: ${money(todayStats.totalProfit)}\n` +
          `Balance: ${(this.lastBalance ?? 0).toFixed(2)} ${CONFIG.currency}`
        );
      }
    }

    if (CONFIG.eodStatsEnabled && h === 0 && !this._eodSent) {
      this._eodSent = true;
      const yest = utcDateStr(new Date(Date.now() - 86400000));
      const stats = this.stats.stats(this.stats.todayTrades(yest));
      if (stats.count > 0) {
        telegram.send(
          `🌙 <b>EOD summary (${yest})</b>\n` +
          `Trades: ${stats.count} (✅${stats.wins} ❌${stats.losses}) | WR ${stats.winRate.toFixed(1)}%\n` +
          `Net: ${money(stats.totalProfit)} | PF ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}\n` +
          `Balance: ${(this.lastBalance ?? 0).toFixed(2)} ${CONFIG.currency}`
        );
      }
    }
    if (h !== 0) this._eodSent = false;
  }
  _loadState() {
    try {
      if (fs.existsSync(CONFIG.stateFile)) {
        const data = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
        this.overallProfit = data.overallProfit || 0;
        this.consecutiveLosses = data.consecutiveLosses || 0;
        this.stats = new StatisticsManager(data.stats);
        logger.info('[bot] state loaded');
      }
    } catch (e) {
      logger.warn('[bot] state load failed:', e.message);
    }
  }
  _saveState() {
    try {
      fs.writeFileSync(CONFIG.stateFile, JSON.stringify({
        overallProfit: this.overallProfit,
        consecutiveLosses: this.consecutiveLosses,
        stats: this.stats.serialize(),
      }, null, 2));
    } catch (e) {
      logger.warn('[bot] state save failed:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 11. ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════
if (require.main === module) {
  const bot = new AccuHoldV2Bot();
  bot.start();

  process.on('SIGINT', () => {
    logger.info('[main] SIGINT received');
    bot.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('[main] SIGTERM received');
    bot.stop();
    process.exit(0);
  });
}

module.exports = { AccuHoldV2Bot };
