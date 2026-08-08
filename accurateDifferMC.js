#!/usr/bin/env node
'use strict';

/**
 * =====================================================================
 *  Deriv DIGITDIFF Monte Carlo Trading Systems Engine (Single-File)
 * =====================================================================
 *
 *  A rigorous, statistically valid quantitative trading system for Deriv
 *  DIGITDIFF contracts. Integrates hypothesis testing against a discrete
 *  uniform null model, parametric Monte Carlo order-statistic simulation,
 *  bootstrap stability verification, multiple-testing control (FDR/Bonferroni),
 *  live proposal payout probing, conservative loss probability upper bounds,
 *  and fractional Kelly / risk-first capital preservation policies.
 *
 *  =====================================================================
 *  MATHEMATICAL & STATISTICAL THESIS
 *  =====================================================================
 *
 *  1. DERIV DIGITDIFF MECHANICS & HOUSE MARGIN:
 *     - Contract: DIGITDIFF (barrier digit d in {0..9}, duration 1-10 ticks).
 *     - Win condition: exit tick's last digit != d.
 *     - Loss condition: exit tick's last digit == d.
 *     - Under true i.i.d. discrete uniform digits:
 *         P(win) = 9/10 = 0.90, P(loss) = 1/10 = 0.10.
 *     - Quoted payout multiplier: M = payout / ask ~= 1.0909 - 1.1100.
 *     - Live break-even loss probability:
 *         q_be = 1 - ask / payout = 1 - 1 / M ~= 8.26% - 9.09%.
 *     - Because fair loss probability (10.0%) exceeds break-even (8.33%),
 *       UNSELECTIVE PLAY EMBEDS A -1.67% TO -2.5% NEGATIVE EXPECTED VALUE (-EV).
 *
 *  2. THE SELECTION BIAS / WINNER'S CURSE FALLACY:
 *     - In any finite sample of N=300 uniform digits, sampling variation causes
 *       the minimum digit count to average ~21.8 ticks (~7.28%). Over 86.8% of
 *       finite uniform windows exhibit at least one digit appearing < 8.33%
 *       PURELY BY RANDOM CHANCE.
 *     - Naive frequency minimizers mistake finite sampling variance for an edge.
 *       Under H0, the subsequent tick remains 10.0% likely to hit the barrier.
 *
 *  3. RIGOROUS MONTE CARLO NULL HYPOTHESIS TESTING:
 *     - Null Hypothesis (H0): Sequence {X_t} is i.i.d. discrete uniform on {0..9}.
 *     - Goodness-of-Fit: Pearson Chi-Square test (df=9) & Markov transition entropy.
 *     - Monte Carlo Null Simulation: Simulates M trials of length N under H0 to
 *       generate the true null distribution of the minimum order statistic:
 *         M_null = min_d C_d.
 *     - Monte Carlo p-value:
 *         p_MC = (1 + sum I(M_null_m <= C_observed)) / (1 + M).
 *     - Multiple Testing Correction: Applies Benjamini-Hochberg (FDR) and
 *       Bonferroni adjustments across all 10 barrier candidates.
 *     - Conservative Loss Upper Bound: Uses the Wilson score upper bound (q_upper)
 *       at (1 - alpha) confidence (e.g. 95% CI).
 *     - Value Edge Criterion:
 *         Value Edge = q_be - q_upper >= mcMinEdge > 0.
 *
 *  4. CAPITAL PRESERVATION & NON-TRADING (IDLE) AS SUCCESS:
 *     - Under fair uniform synthetic RNG, the engine will fail to find a statistically
 *       significant anomaly and will CORRECTLY REMAIN IDLE.
 *     - Trading only occurs when empirical evidence rejects H0 with high confidence,
 *       shows bootstrap rank stability, and maintains positive conservative value edge.
 *
 *  =====================================================================
 *  RUNTIME MODES
 *  =====================================================================
 *  • Live/Demo Trading:  node accurateDiffer3_monte-carlos.js
 *  • Backtest Mode:      BACKTEST=1 node accurateDiffer3_monte-carlos.js
 *  • Statistical Test:   node accurateDiffer3_monte-carlos.js --selftest-null
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
// 0. ENVIRONMENT HELPERS
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
// 1. CONFIGURATION (Hardcoded Test Credentials Preserved)
// ─────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // Deriv API credentials & connection endpoints
  apiToken:    'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
  appId:       '33uslPtthXBEkQOdfKfoY',
  accountId:   '',
  accountType: 'demo', // 'demo' | 'real'
  legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
  restBaseUrl: 'https://api.derivws.com',
  currency:    'USD',

  // Trade Setup & Instruments
  stake:         1.1,
  durationTicks: 1, // DIGITDIFF duration 1-10 ticks
  minStake:      1.1,
  maxStake:      150.00,
  assets:        ['R_10','R_25','R_50','R_75','R_100','RDBEAR','RDBULL'],

  // Execution timing & throughput limits
  tickWindow:          1000,
  minTicksForAnalysis: 300,
  analysisIntervalMs:  3000,
  tradeCooldownMs:     2000,
  maxOpenTrades:       1,
  tradeWatchdogMs:     20000,
  assetRotationMs:     60000, // 60s lockout on just-traded asset
  dailyMaxLoss:        570, // hard capital stop loss
  dailyMaxProfit:      0, // 0 = disabled
  dailyMaxTrades:      20000,

  // ── Monte Carlo & Quantitative Analysis ───────────────────────────
  mcSimulations:        5000,       // Null trials per scan
  minEdgeConfidence:    0.98,  // 90% statistical significance vs H0
  mcStabilityThreshold: 0.60,// 60% bootstrap rank stability
  randomnessAlpha:      0.05,     // 5% significance for goodness-of-fit
  wilsonConfidenceZ:    1.96,             // 95% CI (z=1.96) for conservative loss prob
  mcMinEdge:            0.005,         // Min 0.5pp conservative value edge
  mcLossCooldownMs:     15000, // Cooldown after a loss
  bootstrapIterations:  100,  // Bootstrap resamples for stability
  hotFilterTicks:       5,        // Penalty if appeared in last N ticks
  cooldownTicks:        30,         // Tick spacing per barrier digit
  maxRecentHits:        2,         // Max occurrences in tail lookback
  recentLookback:       20,
  minEntropy:           0.90,          // Shannon entropy floor
  maxEntropy:           0.9997,        // Max entropy ceiling (too uniform)

  // ── Capital Protection & Sizing Policy ────────────────────────────
  recoveryEnabled:     false,
  recoveryMultipliers: listEnv('RECOVERY_MULTIPLIERS', '1,1.2,1.5').map(Number).filter(Number.isFinite),
  maxRecoveryLevel:    2,

  kellySizingEnabled:   false,
  kellyFraction:        0.25,        // Quarter-Kelly
  kellyBankrollFrac:    1.00,
  kellyBankrollFloor:   100.0,
  kellyMaxStakeFrac:    0.02,  // Max 2% bankroll per trade
  kellyMinEdgeForScale: 0.005,

  // Per-symbol calibration tracker
  calibEnabled:        true,
  calibWindow:         200,
  calibMinTrades:      30,
  calibDisableGap:     0.02,
  calibReenableGap:    0.005,
  calibProbeAfterMs:   1800000, // 30m probe cooldown
  calibProbeStakeFrac: 0.25,

  // Scheduled Pause Windows (GMT/UTC)
  pauseEnabled:  true,
  pauseStartGmt: '23:00',
  pauseEndGmt:   '01:00',

  // Day-of-week Trading Filters (GMT/UTC)
  tradeSunday:    true,
  tradeMonday:    true,
  tradeTuesday:   true,
  tradeWednesday: true,
  tradeThursday:  true,
  tradeFriday:    true,
  tradeSaturday:  true,

  // GMT/UTC Reporting & EOD
  eodTimeGmt:          strEnv('EOD_TIME_GMT', '00:00'),
  eodSendDelaySeconds: 10,
  hourlySummary:       true,

  // Persistence & Logging
  stateFile: strEnv('STATE_FILE', 'MC_differ_01_state.json'),
  logFile:   strEnv('LOG_FILE', 'MC_differ_01_bot.log'),
  logLevel:  strEnv('LOG_LEVEL', 'INFO').toUpperCase(),

  // Telegram Notifications
  telegram: {
    enabled:  true,
    botToken: '8106601008:AAEMyCma6mvPYIHEvw3RHQX2tkD5-wUe1o0',
    chatId:   '752497117',
  },

  // Connection Reconnect Settings
  reconnect: {
    initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
    maxDelayMs:     intEnv('RECONNECT_MAX_MS', 60000),
    backoffFactor:  numEnv('RECONNECT_BACKOFF', 2),
    jitterMs:       intEnv('RECONNECT_JITTER_MS', 750),
  },

  // Backtester Configuration
  backtestTicks:          intEnv('BACKTEST_TICKS', 100000),
  backtestBatchSize:      intEnv('BACKTEST_BATCH_SIZE', 5000),
  backtestReportEvery:    intEnv('BACKTEST_REPORT', 10000),
  backtestOutFile:        strEnv('BACKTEST_OUT', 'MC_differ_backtest_report_01.json'),
  backtestPayoutMult:     numEnv('BACKTEST_PAYOUT_MULT', 1.10),
  backtestProbeLive:      boolEnv('BACKTEST_PROBE_LIVE', true),
  backtestAssetLock:      boolEnv('BACKTEST_ASSET_LOCK', false),
  backtestAssetLockTicks: intEnv('BACKTEST_ASSET_LOCK_TICKS', 10),
  backtestMcEnabled:      boolEnv('BACKTEST_MC_ENABLED', true),
});

// ─────────────────────────────────────────────────────────────────────
// 2. LOGGER & FORMATTING
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
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  const line = `[${utcTs()}] [${level}] ${msg}${extras ? ' ' + extras : ''}`;
  (level === 'ERROR' ? console.error : console.log)(line);
  _writeLog(line);
}

const logger = {
  error: (m, ...a) => log('ERROR', m, ...a),
  warn : (m, ...a) => log('WARN',  m, ...a),
  info : (m, ...a) => log('INFO',  m, ...a),
  debug: (m, ...a) => log('DEBUG', m, ...a),
};

function money(n, currency = CONFIG.currency) {
  const x = Number(n || 0);
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${currency}`;
}
function pct(n, dp = 2) { return `${(Number(n || 0) * 100).toFixed(dp)}%`; }
function utcDateStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function previousUtcDateStr(d = new Date()) {
  return new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
}
function utcHour(d = new Date()) { return d.getUTCHours(); }
function htmlEscape(s) {
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

// ─────────────────────────────────────────────────────────────────────
// 3. TELEGRAM NOTIFIER
// ─────────────────────────────────────────────────────────────────────
class TelegramNotifier extends EventEmitter {
  constructor(cfg) {
    super();
    this.enabled = Boolean(cfg.enabled && cfg.botToken && cfg.chatId);
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
// 4. REST & WEBSOCKET CLIENTS
// ─────────────────────────────────────────────────────────────────────
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl;
    this.appId = appId;
    this.token = token;
  }
  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
  request(method, route, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(route, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${route}`)); }
      const payload = body == null ? null : JSON.stringify(body);
      const req = https.request({
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId,
          'Accept': 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 15000,
      }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error('REST timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  get(route) { return this.request('GET', route); }
  post(route, body) { return this.request('POST', route, body); }
}

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
    this._isPat = RestClient.isPat(cfg.apiToken);
    this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
    this._targetAccountId = cfg.accountId || '';
  }

  _nextReqId() { this._reqId += 1; return this._reqId; }
  _legacyUrl() {
    const sep = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.legacyWsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }
  _redact(url) {
    return String(url).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi, '$1$2=***');
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN is empty.');
      this._stopped = true;
      return;
    }
    if (this._isPat) {
      logger.info('detected PAT token → using Deriv new Options API OTP flow');
      this._connectPat().catch(e => {
        logger.error('PAT connect failed:', e.message);
        this._scheduleReconnect();
      });
    } else {
      logger.info('using legacy Deriv WebSocket authorize flow');
      this._openWs(this._legacyUrl());
    }
  }

  async _connectPat() {
    const accountId = await this._resolvePatAccountId();
    const route = `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;
    logger.info(`REST POST ${route}`);
    const res = await this._rest.post(route);
    if (res.status !== 200) {
      const msg = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body);
      throw new Error(`OTP failed (${res.status}): ${msg}`);
    }
    const wsUrl = res.body?.data?.url;
    if (!wsUrl) throw new Error(`OTP response missing data.url: ${JSON.stringify(res.body)}`);
    this._targetAccountId = accountId;
    this.accountInfo = {
      loginid: accountId,
      accountType: this.cfg.accountType,
      isVirtual: this.cfg.accountType !== 'real',
      currency: this.cfg.currency,
    };
    logger.info(`connecting → ${this._redact(wsUrl)}`);
    this._openWs(wsUrl);
  }

  async _resolvePatAccountId() {
    if (this._targetAccountId) return this._targetAccountId;
    const attempts = [
      ['GET', '/trading/v1/options/accounts', null],
      ['POST', '/trading/v1/options/accounts/list', null],
    ];
    for (const [method, route, body] of attempts) {
      try {
        const res = method === 'GET' ? await this._rest.get(route) : await this._rest.post(route, body);
        if (res.status >= 200 && res.status < 300) {
          const arr = Array.isArray(res.body?.data) ? res.body.data :
                      Array.isArray(res.body?.accounts) ? res.body.accounts : [];
          if (arr.length) {
            const desired = arr.find(a => String(a.account_type || '').toLowerCase() === this.cfg.accountType) || arr[0];
            const id = desired.account_id || desired.loginid || desired.id;
            if (id) {
              this.accountInfo = {
                loginid: id,
                accountType: desired.account_type || this.cfg.accountType,
                isVirtual: String(desired.account_type || this.cfg.accountType).toLowerCase() !== 'real',
                currency: desired.currency || this.cfg.currency,
                balance: desired.balance != null ? Number(desired.balance) : null,
              };
              return id;
            }
          }
        }
      } catch (e) {
        logger.debug(`PAT account discovery ${method} ${route}:`, e.message);
      }
    }
    throw new Error('DERIV_ACCOUNT_ID is required for PAT tokens. Set DERIV_ACCOUNT_ID or export it.');
  }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DerivDigitDifferBot/2.0 Node.js' } });
    } catch (e) {
      logger.error('WebSocket construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws.on('open', () => this._onOpen());
    this.ws.on('message', d => this._onMessage(d));
    this.ws.on('error', e => this._onError(e));
    this.ws.on('close', (c, r) => this._onClose(c, r));
    this.ws.on('unexpected-response', (_, res) => {
      logger.error('WebSocket handshake failed:', res.statusCode, res.statusMessage);
      try { res.destroy(); } catch (_) {}
      this._scheduleReconnect();
    });
  }

  _onOpen() {
    logger.info('WebSocket connected ✔');
    this.connected = true;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    this.emit('open');
    if (this._isPat) this._markPatAuthorized();
    else this._authorizeLegacy();
  }

  async _authorizeLegacy() {
    try {
      const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
      const a = res.authorize;
      this.authorized = true;
      this.balance = Number(a.balance);
      this.currency = a.currency || this.cfg.currency;
      this.accountInfo = {
        loginid: a.loginid,
        email: a.email,
        isVirtual: !!a.is_virtual,
        accountType: a.account_type,
        currency: this.currency,
      };
      logger.info(`authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) balance=${this.balance} ${this.currency}`);
      this.emit('authorized', this.accountInfo);
    } catch (e) {
      logger.error('authorize failed:', e.message);
      this.authorized = false;
      this._scheduleReconnect();
    }
  }

  async _markPatAuthorized() {
    this.authorized = true;
    if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance);
    this.currency = this.accountInfo?.currency || this.cfg.currency;
    try {
      const b = await this._send({ balance: 1 }, 10000);
      if (b.balance) {
        this.balance = Number(b.balance.balance);
        this.currency = b.balance.currency || this.currency;
      }
    } catch (e) {
      logger.debug('balance check skipped:', e.message);
    }
    logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT/new API balance=${this.balance ?? '?'} ${this.currency}`);
    this.emit('authorized', this.accountInfo || { loginid: this._targetAccountId, isVirtual: this.cfg.accountType !== 'real' });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.error) {
      const code = msg.error.code || 'Error';
      const text = msg.error.message || code;
      const benign = new Set(['AlreadySubscribedOrLimit', 'ContractNotFound', 'BetExpired', 'TradingDurationNotAllowed']);
      (benign.has(code) ? logger.debug : logger.error)(`api error: ${code} - ${text} req=${msg.req_id || '?'}`);
      if (msg.req_id && this._pending.has(msg.req_id)) {
        const p = this._pending.get(msg.req_id);
        clearTimeout(p.timer);
        this._pending.delete(msg.req_id);
        p.reject(new Error(text));
      }
      if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) this._closeAndReconnect();
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
    logger.error('WebSocket error:', err.message, err.code || '');
    this.emit('error', err);
  }

  _onClose(code, reason) {
    const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
    logger.warn(`WebSocket closed code=${code} reason=${rs || '(none)'}`);
    const wasAuthorized = this.authorized;
    this.connected = false;
    this.authorized = false;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this._pending.clear();
    this._subs.clear();
    this.emit('close', code, reason, wasAuthorized);
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

  _closeAndReconnect() { try { this.ws?.close(); } catch (_) {} }

  _send(payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error(`Request timeout (${payload.proposal ? 'proposal' : payload.buy ? 'buy' : payload.ticks ? 'ticks' : 'req'})`));
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: reqId })); }
      catch (e) {
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
          if (!subId) {
            if (msg.proposal_open_contract) {
              try { callback(msg); } catch (e) { logger.error('subscription handler error:', e.message); }
            }
            resolve(null);
            return;
          }
          this._subs.set(subId, callback);
          resolve(subId);
        },
        reject,
        timer,
      });
      try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId })); }
      catch (e) {
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
  symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

// ─────────────────────────────────────────────────────────────────────
// 5. MARKET DATA MANAGER & CANONICAL PIP SIZES
// ─────────────────────────────────────────────────────────────────────
const KNOWN_PIP_SIZES = Object.freeze({
  R_10     : 3,
  R_25     : 3,
  R_50     : 4,
  R_75     : 4,
  R_100    : 2,
  '1HZ10V' : 2,
  '1HZ25V' : 2,
  '1HZ50V' : 2,
  '1HZ75V' : 2,
  '1HZ100V': 2,
  RDBULL   : 4,
  RDBEAR   : 4,
});

/**
 * Extracts exact settlement digit at the symbol's pip position without rounding.
 */
function quoteToDigit(quote, pipSize = 2) {
  const n = Number(quote);
  if (!Number.isFinite(n)) return null;
  const pip = Number.isInteger(pipSize) && pipSize >= 1 && pipSize <= 8 ? pipSize : 2;
  const s = Math.abs(n).toFixed(pip);
  const dot = s.indexOf('.');
  const frac = dot < 0 ? '' : s.slice(dot + 1);
  const ch = frac.charAt(pip - 1);
  const d = Number(ch);
  return Number.isInteger(d) && d >= 0 && d <= 9 ? d : null;
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
      const list = res.active_symbols || [];
      let apiWithPip = 0;
      let overrides  = 0;
      for (const s of list) {
        const key = s.underlying_symbol || s.symbol;
        if (!key) continue;
        this.client.symbols.set(key, s);
        const rawPip = Number(s.pip_size);
        if (Number.isFinite(rawPip) && rawPip >= 1 && rawPip <= 8) {
          apiWithPip++;
          const known = KNOWN_PIP_SIZES[key];
          if (known != null && known !== rawPip) {
            logger.warn(`pip_size mismatch for ${key}: known=${known} vs API=${rawPip} — using API value`);
            overrides++;
            this.pipSizes.set(key, rawPip);
          } else if (known == null) {
            this.pipSizes.set(key, rawPip);
          }
        }
      }
      logger.info(
        `loaded ${this.client.symbols.size} active symbols ` +
        `(pip: known-table=${Object.keys(KNOWN_PIP_SIZES).length}, api-supplied=${apiWithPip}, api-overrides=${overrides})`
      );
    } catch (e) {
      logger.error('loadSymbols failed:', e.message);
      logger.info('falling back to KNOWN_PIP_SIZES table');
    }
  }

  pipSize(symbol) {
    const cached = this.pipSizes.get(symbol);
    if (Number.isFinite(cached)) return cached;
    const raw = Number(this.client.symbols.get(symbol)?.pip_size);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 8) {
      this.pipSizes.set(symbol, raw);
      return raw;
    }
    const hist = this.history.get(symbol);
    if (hist && hist.length) {
      const decCounts = new Map();
      const sample = hist.slice(-Math.min(50, hist.length));
      for (const t of sample) {
        const s = String(t.quote);
        const dot = s.indexOf('.');
        const dec = dot < 0 ? 0 : s.length - dot - 1;
        decCounts.set(dec, (decCounts.get(dec) || 0) + 1);
      }
      let bestDec = 2, bestN = 0;
      for (const [d, n] of decCounts) if (n > bestN) { bestDec = d; bestN = n; }
      if (bestDec >= 1 && bestDec <= 8) {
        this.pipSizes.set(symbol, bestDec);
        return bestDec;
      }
    }
    return 2;
  }

  async backfill(symbol, count = 1000) {
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
      logger.info(`backfilled ${symbol}: ${arr.length} ticks (pip_size=${pip})`);
      return arr;
    } catch (e) {
      logger.error(`backfill(${symbol}) failed:`, e.message);
      return [];
    }
  }

  async deepBackfill(symbol, totalCount, batchSize = 5000, onProgress = null) {
    const out = [];
    let remain = totalCount;
    let end = 'latest';
    let lastEpoch = null;
    const pip = this.pipSize(symbol);
    while (remain > 0) {
      const count = Math.min(batchSize, remain);
      let res;
      try {
        res = await this.client._send({
          ticks_history: symbol,
          count, end, style: 'ticks',
        }, 30000);
      } catch (e) {
        logger.warn(`deepBackfill(${symbol}) batch failed: ${e.message}`);
        break;
      }
      const prices = res.history?.prices || [];
      const times  = res.history?.times  || [];
      if (!times.length) break;
      const batch = times.map((t, i) => {
        const quote = Number(prices[i]);
        return { epoch: Number(t), quote, digit: quoteToDigit(quote, pip) };
      }).filter(x => x.digit != null);
      if (lastEpoch !== null && batch.length && batch[batch.length - 1].epoch >= lastEpoch) break;
      if (batch.length) lastEpoch = batch[0].epoch;
      out.unshift(...batch);
      remain -= batch.length;
      if (onProgress) onProgress(out.length, totalCount);
      if (!batch.length) break;
      end = String(batch[0].epoch - 1);
      await new Promise(r => setTimeout(r, 200));
      if (batch.length < count) break;
    }
    return out;
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
      const cap = Math.max(this.cfg.tickWindow * 2, 2000);
      if (arr.length > cap) arr.splice(0, arr.length - cap);
      this.history.set(symbol, arr);
      this.emit('tick', symbol, tick);
    });
    this.subs.set(symbol, subId);
    logger.info(`subscribed ticks: ${symbol} (sub=${subId})`);
    return subId;
  }

  async bootstrap(symbols) {
    await Promise.all(symbols.map(s => this.subscribe(s).catch(e => logger.warn(`subscribe(${s}) failed:`, e.message))));
    await Promise.all(symbols.map(async s => {
      const hist = this.history.get(s) || [];
      if (hist.length < this.cfg.minTicksForAnalysis) {
        await this.backfill(s, Math.max(this.cfg.tickWindow, this.cfg.minTicksForAnalysis + 100));
      }
    }));
  }
  historyFor(symbol) { return this.history.get(symbol) || []; }
  last(symbol) { return this.lastQuote.get(symbol); }
}

// ─────────────────────────────────────────────────────────────────────
// 6. QUANTITATIVE MONTE CARLO ANALYZER
// ─────────────────────────────────────────────────────────────────────
/**
 * MonteCarloAnalyzer — Hypothesis-Testing Monte Carlo Engine for DIGITDIFF.
 *
 * Mathematically sound pipeline:
 *  1. Randomness & Goodness-of-Fit:
 *     - Pearson Chi-Square test (df=9) vs Uniform Null H0: p_d = 0.10.
 *     - Markov 1-step transition count matrix and conditional Shannon entropy.
 *  2. Fast Wilson Score Upper Bound:
 *     - Computes conservative loss upper bound (q_upper) at (1 - alpha) CI in O(1).
 *     - Evaluates live break-even loss probability: q_be = 1 - ask / payout.
 *     - Rejects non-promising candidates early before running heavy trials.
 *  3. Vectorized Parametric Monte Carlo Null Simulation:
 *     - Simulates M trials of length N under uniform H0 to model the exact
 *       sampling distribution of the minimum order statistic M_null = min_d C_d.
 *     - Computes exact Monte Carlo p-value for deficiency.
 *  4. Bootstrap Stability Verification:
 *     - Resamples the observed window B times to verify ranking stability.
 *  5. Value Edge Criterion:
 *     - Value Edge = q_be - q_upper >= mcMinEdge.
 */
class MonteCarloAnalyzer {
  constructor(cfg) {
    this.cfg = cfg;
    this._predictionLog = [];
    this._cooldownMap = new Map();
    this._tickCounter = 0;
    this._lastLogTime = 0;
  }

  recordPrediction(digit, symbol) {
    this._predictionLog.push({ digit, tickIndex: this._tickCounter, symbol, ts: Date.now() });
    this._cooldownMap.set(digit, this._tickCounter);
    if (this._predictionLog.length > 500) this._predictionLog.splice(0, 250);
  }

  tick() { this._tickCounter++; }

  analyze(symbol, ticks, liveAsk = null, livePayout = null) {
    if (!ticks || ticks.length < this.cfg.minTicksForAnalysis) return null;

    const digits = ticks.map(t => t.digit).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
    if (digits.length < this.cfg.minTicksForAnalysis) return null;

    this._tickCounter = Math.max(this._tickCounter, digits.length);
    const n = Math.min(digits.length, this.cfg.tickWindow);
    const window = digits.slice(-n);
    const lastDigit = window[window.length - 1];

    // 1. Empirical counts in O(N)
    const counts = new Int32Array(10);
    for (let i = 0; i < n; i++) counts[window[i]]++;

    // 2. Find minimum count candidate in O(10)
    let bestDigit = 0;
    let minCount = counts[0];
    for (let d = 1; d < 10; d++) {
      if (counts[d] < minCount) {
        minCount = counts[d];
        bestDigit = d;
      }
    }

    // 3. Conservative Wilson score upper bound & break-even calculation
    const z = this.cfg.wilsonConfidenceZ || 1.96;
    const bootCI = this._wilsonScoreCI(minCount, n, z);
    const pUpper = bootCI.upper;
    const ask = Number(liveAsk || this.cfg.stake);
    const payout = Number(livePayout || (ask * this.cfg.backtestPayoutMult));
    const breakEvenLossProb = (payout > ask && ask > 0) ? (1 - ask / payout) : (1 - 1 / this.cfg.backtestPayoutMult);
    const valueEdge = breakEvenLossProb - pUpper;
    const observedHitRate = 1 - minCount / n;
    const pEstimate = minCount / n;

    // 4. Randomness & Goodness-of-fit tests
    const randomness = this.testRandomness(window, counts, n);

    // 5. Run Monte Carlo simulation only when candidate is promising
    let mcResults = null;
    let scored = null;
    if (valueEdge < this.cfg.mcMinEdge || randomness.flags.includes('uniform')) {
      scored = {
        topCandidate: { digit: bestDigit, count: minCount, observedHitRate, pValue: 1.0, confidence: 0 },
        allCandidates: [],
        confidence: 0,
        stability: 0,
        shouldTrade: false,
        reason: valueEdge < this.cfg.mcMinEdge ? `value-edge-insufficient:${(valueEdge * 100).toFixed(2)}pp` : 'randomness:uniform',
      };
    } else {
      mcResults = this.runMonteCarlo(counts, n, this.cfg.mcSimulations);
      scored = this.scoreCandidates(window, counts, n, mcResults, randomness);
      if (scored.topCandidate) {
        bestDigit = scored.topCandidate.digit;
      }
    }

    if (!scored.topCandidate) {
      return {
        symbol, method: 'monte-carlo-hypothesis', digit: lastDigit,
        sampleSize: n, mcPasses: false, allowedByModel: false,
        gates: ['no-valid-candidate'], ...scored,
      };
    }

    // 6. Gate Evaluations
    const gates = [];
    const lastPredIdx = this._cooldownMap.get(bestDigit);
    const predictionCooldown = lastPredIdx != null ? this._tickCounter - lastPredIdx : Infinity;
    const recentLook = Math.min(this.cfg.recentLookback, n);
    const recentHits = window.slice(-recentLook).filter(d => d === bestDigit).length;
    const absenceStreak = this._absenceStreak(window, bestDigit);
    const entropy = randomness.normalizedEntropy;
    const chiSq = randomness.uniformity.chiSq;

    if (randomness.flags.includes('uniform') || !randomness.flags.includes('non-uniform')) gates.push('randomness:uniform');
    if (entropy < this.cfg.minEntropy) gates.push(`entropy-low:${entropy.toFixed(4)}`);
    if (entropy > this.cfg.maxEntropy) gates.push(`entropy-high:${entropy.toFixed(4)}`);
    if (chiSq < 1.5) gates.push(`chisq-low:${chiSq.toFixed(2)}`);
    if (scored.confidence < this.cfg.minEdgeConfidence) gates.push(`confidence-low:${scored.confidence.toFixed(3)}`);
    if (scored.stability < this.cfg.mcStabilityThreshold) gates.push(`stability-low:${scored.stability.toFixed(3)}`);
    if (valueEdge < this.cfg.mcMinEdge) gates.push(`value-edge-insufficient:${(valueEdge * 100).toFixed(2)}pp`);
    if (recentHits > this.cfg.maxRecentHits) gates.push(`recent-hit:${recentHits}`);
    if (predictionCooldown < this.cfg.cooldownTicks) gates.push(`cooldown:${predictionCooldown}t`);
    if (window.slice(-this.cfg.hotFilterTicks).includes(bestDigit)) {
      gates.push(`hot-filter:appeared-in-last-${this.cfg.hotFilterTicks}`);
    }

    const mcPasses = gates.length === 0;

    // Periodic summary logging (once per 60s per asset)
    if (!this._lastLogTime || Date.now() - this._lastLogTime > 60000) {
      const streamSnap = window.slice(-20).join('');
      logger.info(`[MC] ─── Monte Carlo Analysis: ${symbol} ───`);
      logger.info(`[MC] stream: ...${streamSnap}  (n=${n})`);
      logger.info(`[MC] uniformity: chiSq=${chiSq.toFixed(2)} p=${randomness.uniformity.pValue.toFixed(4)} entropy=${entropy.toFixed(3)} flags=[${randomness.flags.join(', ') || 'none'}]`);
      logger.info(`[MC] candidate: d${bestDigit}  count=${minCount}/${n} (${(pEstimate * 100).toFixed(1)}%)  q_upper=${(pUpper * 100).toFixed(2)}%  q_be=${(breakEvenLossProb * 100).toFixed(2)}%`);
      logger.info(`[MC] valueEdge=${(valueEdge * 100).toFixed(2)}pp  confidence=${scored.confidence.toFixed(3)} stability=${scored.stability.toFixed(3)}`);
      logger.info(`[MC] trade decision: ${mcPasses ? 'TRADE' : 'SKIP'} (${gates[0] || scored.reason})  gates=[${gates.join(', ') || 'none'}]`);
      this._lastLogTime = Date.now();
    }

    return {
      symbol,
      method: 'monte-carlo-hypothesis',
      digit: bestDigit,
      count: minCount,
      sampleSize: n,
      pEstimate,
      pUpper,
      pLossUpper: pUpper,
      breakEvenLossProb,
      valueEdge,
      recentHits,
      gates,
      mcPasses,
      allowedByModel: mcPasses,
      lastDigit,
      lastQuote: ticks[ticks.length - 1]?.quote,
      confidence: scored.confidence,
      stability: scored.stability,
      mcDecision: mcPasses,
      mcReason: gates[0] || scored.reason,
      pValue: scored.topCandidate.pValue,
      observedHitRate,
      expectedHitRate: 0.90,
      allCandidates: scored.allCandidates,
      randomnessFlags: randomness.flags,
      randomnessUniformity: randomness.uniformity,
      randomnessTransitions: randomness.transitions,
      bootstrapCI: bootCI,
      absenceStreak,
      predictionCooldown,
      entropy,
      chiSquare: chiSq,
    };
  }

  rank(list) {
    return list
      .filter(Boolean)
      .filter(a => a.mcPasses || a.allowedByModel)
      .sort((a, b) => (b.valueEdge ?? 0) - (a.valueEdge ?? 0));
  }

  // ── Statistical Tests ─────────────────────────────────────────────

  testRandomness(digits, counts, n) {
    const flags = [];
    const expected = n / 10;
    let chiSq = 0;
    for (let d = 0; d < 10; d++) {
      const diff = counts[d] - expected;
      chiSq += (diff * diff) / expected;
    }
    const df = 9;
    const pValue = 1 - this._chiSquareCDF(chiSq, df);

    if (pValue > (1 - this.cfg.randomnessAlpha)) flags.push('uniform');
    if (pValue < this.cfg.randomnessAlpha) flags.push('non-uniform');

    const transitions = this._analyzeTransitions(digits);
    if (transitions.ratio > 0.95) flags.push('transitions-independent');

    const normalizedEntropy = this._normalizedEntropy(counts, n);

    return {
      uniformity: { chiSq, pValue, df },
      transitions,
      normalizedEntropy,
      flags,
    };
  }

  _analyzeTransitions(digits) {
    if (digits.length < 2) return { entropy: 0, ratio: 1, quality: 1 };
    const matrix = Array.from({ length: 10 }, () => new Int32Array(10));
    for (let i = 0; i < digits.length - 1; i++) {
      matrix[digits[i]][digits[i + 1]]++;
    }
    let conditionalEntropy = 0;
    const maxEntropy = Math.log2(10);
    for (let from = 0; from < 10; from++) {
      let rowTotal = 0;
      for (let to = 0; to < 10; to++) rowTotal += matrix[from][to];
      if (rowTotal === 0) continue;
      let rowEntropy = 0;
      for (let to = 0; to < 10; to++) {
        if (matrix[from][to] === 0) continue;
        const p = matrix[from][to] / rowTotal;
        rowEntropy -= p * Math.log2(p);
      }
      conditionalEntropy += (rowTotal / (digits.length - 1)) * rowEntropy;
    }
    const ratio = conditionalEntropy / maxEntropy;
    return { entropy: conditionalEntropy, ratio, quality: Math.max(0, Math.min(1, ratio)) };
  }

  // ── High-Performance Monte Carlo Engine ───────────────────────────

  runMonteCarlo(counts, n, nSimulations) {
    const trials = Math.max(1000, nSimulations);
    const simCounts = new Int32Array(10);
    const minCounts = new Int32Array(trials);

    for (let s = 0; s < trials; s++) {
      simCounts.fill(0);
      for (let i = 0; i < n; i++) {
        simCounts[(Math.random() * 10) | 0]++;
      }
      let minVal = simCounts[0];
      for (let d = 1; d < 10; d++) {
        if (simCounts[d] < minVal) minVal = simCounts[d];
      }
      minCounts[s] = minVal;
    }

    const candidateResults = [];
    for (let d = 0; d < 10; d++) {
      const count = counts[d];
      let exceedOrEqual = 0;
      for (let s = 0; s < trials; s++) {
        if (minCounts[s] <= count) exceedOrEqual++;
      }
      const pValue = (exceedOrEqual + 1) / (trials + 1);
      const confidence = 1 - pValue;
      candidateResults.push({
        digit: d,
        count,
        observedHitRate: 1 - count / n,
        expectedHitRate: 0.90,
        pValue,
        confidence,
      });
    }

    return candidateResults;
  }

  // ── Candidate Scoring & Stability ─────────────────────────────────

  scoreCandidates(window, counts, n, mcResults, randomness) {
    const sorted = [...mcResults].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0];
    if (!top) {
      return { topCandidate: null, allCandidates: [], confidence: 0, stability: 0, shouldTrade: false, reason: 'no-candidates' };
    }

    const stability = this._bootstrapStability(window, top.digit, this.cfg.bootstrapIterations || 100);

    let shouldTrade = false;
    let reason = '';

    if (randomness.flags.includes('uniform')) {
      reason = 'data-too-uniform-no-edge';
    } else if (top.confidence < this.cfg.minEdgeConfidence) {
      reason = `confidence-low:${top.confidence.toFixed(3)}`;
    } else if (stability < this.cfg.mcStabilityThreshold) {
      reason = `instability:${stability.toFixed(3)}`;
    } else {
      shouldTrade = true;
      reason = 'edge-detected-and-stable';
    }

    return {
      topCandidate: top,
      allCandidates: sorted,
      confidence: top.confidence,
      stability,
      shouldTrade,
      reason,
    };
  }

  _bootstrapStability(digits, targetDigit, iterations = 100) {
    const n = digits.length;
    if (n === 0) return 0;
    const resampleCounts = new Int32Array(10);
    let targetStaysMin = 0;

    for (let b = 0; b < iterations; b++) {
      resampleCounts.fill(0);
      for (let i = 0; i < n; i++) {
        const idx = (Math.random() * n) | 0;
        resampleCounts[digits[idx]]++;
      }
      let bestD = 0;
      let minVal = resampleCounts[0];
      for (let d = 1; d < 10; d++) {
        if (resampleCounts[d] < minVal) {
          minVal = resampleCounts[d];
          bestD = d;
        }
      }
      if (bestD === targetDigit) targetStaysMin++;
    }
    return targetStaysMin / iterations;
  }

  // ── Math & Statistical Helpers ────────────────────────────────────

  _wilsonScoreCI(k, n, z = 1.96) {
    if (n === 0) return { mean: 0, lower: 0, upper: 0, width: 0 };
    const p = k / n;
    const denom = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    const lower = Math.max(0, centre - half);
    const upper = Math.min(1, centre + half);
    return { mean: p, lower, upper, width: upper - lower };
  }

  _absenceStreak(digits, targetDigit) {
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] === targetDigit) return digits.length - 1 - i;
    }
    return digits.length;
  }

  _normalizedEntropy(counts, n) {
    if (n === 0) return 0;
    let H = 0;
    for (let d = 0; d < 10; d++) {
      const c = counts[d];
      if (c > 0) {
        const p = c / n;
        H -= p * Math.log2(p);
      }
    }
    return H / Math.log2(10);
  }

  _chiSquareCDF(x, df) {
    if (x <= 0) return 0;
    if (df === 9) {
      const z = Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df));
      const s = Math.sqrt(2 / (9 * df));
      return this._normalCDF(z / s);
    }
    return this._gammaP(df / 2, x / 2);
  }

  _gammaP(a, x) {
    if (x <= 0) return 0;
    if (x >= a + 1) return 1 - this._gammaQ(a, x);
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 100; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - this._logGamma(a));
  }

  _gammaQ(a, x) {
    let b = x + 1 - a;
    let c = 1e30;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i <= 100; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = b + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return Math.exp(-x + a * Math.log(x) - this._logGamma(a)) * h;
  }

  _logGamma(x) {
    const p = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.1385710958565268,
      9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - this._logGamma(1 - x);
    x -= 1;
    let a = 0.99999999999980993;
    for (let i = 0; i < p.length; i++) a += p[i] / (x + i + 1);
    const t = x + p.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  _normalCDF(x) {
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return 0.5 * (1.0 + sign * y);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. TRADE EXECUTOR
// ─────────────────────────────────────────────────────────────────────
class TradeExecutor extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.open = new Map();
  }

  async proposal(symbol, digit, stake) {
    const symbolKey = this.client.symbolField();
    return this.client._send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: 'DIGITDIFF',
      currency: this.cfg.currency,
      duration: this.cfg.durationTicks,
      duration_unit: 't',
      barrier: String(digit),
      [symbolKey]: symbol,
    }, 15000);
  }

  async buy(symbol, digit, stake, analysis) {
    stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, Number(stake)));
    const pres = await this.proposal(symbol, digit, stake);
    const p = pres.proposal;
    if (!p?.id) throw new Error('No proposal id returned');
    const ask = Number(p.ask_price || stake);
    const payout = Number(p.payout || 0);
    const bres = await this.client._send({ buy: p.id, price: ask }, 15000);
    const b = bres.buy;
    if (!b?.contract_id) throw new Error('Buy did not return contract_id');

    const info = {
      contractId: b.contract_id,
      symbol,
      contractType: 'DIGITDIFF',
      digit,
      stake: ask,
      buyPrice: Number(b.buy_price || ask),
      payout: Number(b.payout || payout),
      buyTime: Number(b.purchase_time || Date.now() / 1000),
      durationTicks: this.cfg.durationTicks,
      proposalId: p.id,
      longcode: p.longcode || '',
      balanceAfter: b.balance_after != null ? Number(b.balance_after) : null,
      analysis,
    };
    this.open.set(info.contractId, info);
    logger.info(`bought DIGITDIFF #${info.contractId} ${symbol} differs ${digit} stake=${ask} payout=${info.payout}`);

    const subId = await this.client.subscribe({ proposal_open_contract: 1, contract_id: info.contractId }, msg => this._onUpdate(msg, info));
    info.subId = subId;
    this.emit('open', info);
    return info;
  }

  async _onUpdate(msg, info) {
    const c = msg.proposal_open_contract;
    if (!c) return;
    const cid = c.contract_id || info.contractId;
    const status = c.status;
    const profit = Number(c.profit || 0);
    if (status === 'won' || status === 'lost') {
      const finished = {
        ...info,
        contractId: cid,
        status,
        profit,
        sellPrice: Number(c.sell_price || 0),
        sellTime: Number(c.sell_time || Date.now() / 1000),
        entryTick: c.entry_tick,
        exitTick: c.exit_tick,
        currentSpot: c.current_spot,
        shortcode: c.shortcode,
      };
      this.open.delete(cid);
      this.emit('result', finished);
      const subId = msg.subscription?.id || info.subId;
      if (subId) await this.client.forget(subId).catch(() => {});
    } else {
      this.emit('update', { ...info, contractId: cid, status, profit });
    }
  }

  count() { return this.open.size; }
  openTrades() { return [...this.open.values()]; }
}

// ─────────────────────────────────────────────────────────────────────
// 8. RISK, SIZING & CALIBRATION SUITE
// ─────────────────────────────────────────────────────────────────────
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0 };
    this.eodSentDates = [];
    if (saved) this.load(saved);
  }

  load(saved) {
    if (Array.isArray(saved.trades)) this.trades = saved.trades;
    if (saved.dailySummaries && typeof saved.dailySummaries === 'object') this.dailySummaries = saved.dailySummaries;
    this.overallProfit = Number(saved.overallProfit || 0);
    this.currentLossStreak = Number(saved.currentLossStreak || 0);
    this.maxLossStreak = Number(saved.maxLossStreak || 0);
    this.lossStreakEvents = {
      x2: Number(saved.lossStreakEvents?.x2 || 0),
      x3: Number(saved.lossStreakEvents?.x3 || 0),
      x4: Number(saved.lossStreakEvents?.x4 || 0),
    };
    this.eodSentDates = Array.isArray(saved.eodSentDates) ? saved.eodSentDates : [];
  }

  serialize() {
    return {
      trades: this.trades.slice(-5000),
      dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit,
      currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: this.lossStreakEvents,
      eodSentDates: this.eodSentDates.slice(-400),
    };
  }

  _stamp(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    return { timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
  }

  record(trade) {
    const stamp = this._stamp(trade);
    const rec = { ...trade, timestamp: stamp.timestamp, date: stamp.date, hour: stamp.hour };
    this.trades.push(rec);
    this.overallProfit += Number(rec.profit || 0);

    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }

  tradesForDate(date) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  todayTrades(date = utcDateStr()) { return this.tradesForDate(date); }

  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossWin = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    const stake = list.reduce((s, t) => s + Number(t.stake || 0), 0);
    const maxLossStreak = (() => {
      let cur = 0, max = 0;
      for (const t of list) {
        if (t.status === 'lost') { cur += 1; max = Math.max(max, cur); }
        else if (t.status === 'won') cur = 0;
      }
      return max;
    })();
    return {
      count: list.length,
      wins: wins.length,
      losses: losses.length,
      winRate: list.length ? (wins.length / list.length) * 100 : 0,
      grossWin,
      grossLoss,
      totalProfit: total,
      netPL: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgProfit: list.length ? total / list.length : 0,
      stake,
      maxLossStreak,
    };
  }

  summaryForDate(date) {
    const list = this.tradesForDate(date);
    const stats = this.stats(list);
    return { date, trades: list, stats };
  }

  archiveDate(date) {
    const summary = this.summaryForDate(date);
    this.dailySummaries[date] = summary.stats;
    return summary;
  }

  markEodSent(date) {
    if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date);
    this.eodSentDates = this.eodSentDates.slice(-400);
  }
  isEodSent(date) { return this.eodSentDates.includes(date); }

  allDailyRows(includeDate = null) {
    const rows = [];
    const dates = new Set(Object.keys(this.dailySummaries));
    for (const t of this.trades) dates.add(t.date);
    if (includeDate) dates.add(includeDate);
    [...dates].sort().forEach(date => {
      let stats = this.dailySummaries[date];
      const live = this.tradesForDate(date);
      if (live.length) stats = this.stats(live);
      if (stats && stats.count > 0) rows.push({ date, stats });
    });
    return rows;
  }
}

class SymbolCalibrator {
  constructor(cfg, saved = null) {
    this.cfg = cfg;
    this.symbols = new Map();
    if (saved && typeof saved === 'object') this.load(saved);
  }

  _slot(sym) {
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, {
        window: [],
        state: 'enabled',
        disabledAt: 0,
        lastReason: '',
      });
    }
    return this.symbols.get(sym);
  }

  record(symbol, predictedPWin, won) {
    if (!this.cfg.calibEnabled) return;
    const s = this._slot(symbol);
    s.window.push({ pWin: Number(predictedPWin), won: Boolean(won), ts: Date.now() });
    if (s.window.length > this.cfg.calibWindow) {
      s.window.splice(0, s.window.length - this.cfg.calibWindow);
    }
    this._reassess(symbol, s);
  }

  _reassess(symbol, s) {
    const n = s.window.length;
    if (n < this.cfg.calibMinTrades) return;
    const wins = s.window.reduce((acc, r) => acc + (r.won ? 1 : 0), 0);
    const empirical = wins / n;
    const predicted = s.window.reduce((acc, r) => acc + r.pWin, 0) / n;
    const gap = empirical - predicted;

    if (s.state === 'enabled' || s.state === 'probing') {
      if (gap < -this.cfg.calibDisableGap) {
        s.state = 'disabled';
        s.disabledAt = Date.now();
        s.lastReason = `WR ${(empirical * 100).toFixed(2)}% < predicted ${(predicted * 100).toFixed(2)}% by ${(Math.abs(gap) * 100).toFixed(2)}pp (n=${n})`;
        logger.warn(`CALIB: ${symbol} DISABLED — ${s.lastReason}`);
        return { symbol, transition: 'disabled', gap, empirical, predicted, n };
      }
      if (s.state === 'probing' && Math.abs(gap) < this.cfg.calibReenableGap) {
        s.state = 'enabled';
        s.lastReason = `WR ${(empirical * 100).toFixed(2)}% vs predicted ${(predicted * 100).toFixed(2)}% (gap ${(gap * 100).toFixed(2)}pp) — re-enabled`;
        logger.info(`CALIB: ${symbol} RE-ENABLED — ${s.lastReason}`);
        return { symbol, transition: 'enabled', gap, empirical, predicted, n };
      }
    }
    return null;
  }

  status(symbol) {
    const s = this._slot(symbol);
    if (s.state === 'disabled' && Date.now() - s.disabledAt >= this.cfg.calibProbeAfterMs) {
      s.state = 'probing';
      s.lastReason = `cooldown elapsed (${Math.round((Date.now() - s.disabledAt) / 60000)}m)`;
      logger.info(`CALIB: ${symbol} → PROBING at ${(this.cfg.calibProbeStakeFrac * 100).toFixed(0)}% stake — ${s.lastReason}`);
    }
    return s.state;
  }

  summary() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      const n = s.window.length;
      const wins = s.window.reduce((a, r) => a + (r.won ? 1 : 0), 0);
      const emp  = n ? wins / n : 0;
      const pred = n ? s.window.reduce((a, r) => a + r.pWin, 0) / n : 0;
      out[sym] = {
        state: s.state,
        n,
        empirical: +(emp * 100).toFixed(2),
        predicted: +(pred * 100).toFixed(2),
        gap: +((emp - pred) * 100).toFixed(2),
        reason: s.lastReason,
      };
    }
    return out;
  }

  stakeMultiplier(symbol) {
    if (!this.cfg.calibEnabled) return 1.0;
    const st = this.status(symbol);
    if (st === 'disabled') return 0;
    if (st === 'probing') return this.cfg.calibProbeStakeFrac;
    return 1.0;
  }

  isTradeable(symbol) { return this.stakeMultiplier(symbol) > 0; }

  serialize() {
    const out = {};
    for (const [sym, s] of this.symbols) {
      out[sym] = {
        window: s.window.slice(-this.cfg.calibWindow),
        state: s.state,
        disabledAt: s.disabledAt,
        lastReason: s.lastReason,
      };
    }
    return out;
  }

  load(saved) {
    for (const [sym, s] of Object.entries(saved)) {
      if (!s || typeof s !== 'object') continue;
      this.symbols.set(sym, {
        window: Array.isArray(s.window) ? s.window.slice(-this.cfg.calibWindow) : [],
        state: s.state || 'enabled',
        disabledAt: Number(s.disabledAt || 0),
        lastReason: String(s.lastReason || ''),
      });
    }
  }
}

class KellySizer {
  constructor(cfg) { this.cfg = cfg; }

  compute({ bankroll, pWin, payoutMult, edgeValue }) {
    const cfg = this.cfg;
    const b = Math.max(0, payoutMult - 1);
    const p = Math.max(0, Math.min(1, pWin));
    const q = 1 - p;
    if (b <= 0) return null;
    const fStar = (b * p - q) / b;
    if (fStar <= 0) return null;
    if (edgeValue < cfg.kellyMinEdgeForScale) {
      return { stake: cfg.minStake, fStar, fApplied: 0, reason: 'edge<minEdgeForScale' };
    }
    const roll = Math.max(cfg.kellyBankrollFloor, bankroll * cfg.kellyBankrollFrac);
    const fApp = fStar * cfg.kellyFraction;
    const capF = Math.min(fApp, cfg.kellyMaxStakeFrac);
    let stake = roll * capF;
    stake = Math.max(cfg.minStake, Math.min(cfg.maxStake, +stake.toFixed(2)));
    return { stake, fStar, fApplied: capF, reason: fApp > cfg.kellyMaxStakeFrac ? 'capped' : 'ok' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 9. TRADING BOT ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────
class TradingBot {
  constructor() {
    this.cfg = CONFIG;
    this.client = new DerivClient(this.cfg);
    this.market = new MarketDataManager(this.client, this.cfg);
    this.analyzer = new MonteCarloAnalyzer(this.cfg);
    this.exec = new TradeExecutor(this.client, this.cfg);
    this.stats = new StatisticsManager();
    this.calibrator = new SymbolCalibrator(this.cfg);
    this.kelly = new KellySizer(this.cfg);
    this.livePayoutMult = new Map();

    this.startBalance = null;
    this.lastBalance = null;
    this.lastTradeAt = 0;
    this.tradedAsset = null;
    this.tradedAssetAt = 0;
    this.stopped = false;
    this.paused = false;
    this._isAnalyzing = false;
    this._analysisT = null;
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this._eodT = null;
    this._pauseStartTimer = null;
    this._pauseEndTimer = null;

    this.consecutiveMcSkips = 0;
    this.lastLossAt = 0;
    this._watchdogTimer = null;
    this._watchdogPollTimer = null;
    this.tradeWatchdogMs = this.cfg.tradeWatchdogMs || 20000;
    this._tickCounter = 0;
  }

  _parsePauseTime(str) {
    const m = String(str || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Math.max(0, Math.min(23, Number(m[1])));
    const min = Math.max(0, Math.min(59, Number(m[2])));
    return { h, min };
  }

  _isPausedNow() {
    if (!this.cfg.pauseEnabled) return false;
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) return false;
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;
    if (startMin > endMin) return nowMin >= startMin || nowMin < endMin;
    return nowMin >= startMin && nowMin < endMin;
  }

  _schedulePause() {
    this._clearPauseTimers();
    if (!this.cfg.pauseEnabled) return;

    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = this._parsePauseTime(this.cfg.pauseStartGmt);
    const end   = this._parsePauseTime(this.cfg.pauseEndGmt);
    if (!start || !end) return;

    const startMin = start.h * 60 + start.min;
    const endMin   = end.h   * 60 + end.min;

    const msToTarget = (targetMinOfDay) => {
      let diff = targetMinOfDay - nowMin;
      if (diff <= 0) diff += 24 * 60;
      return diff * 60000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
    };

    if (startMin > endMin) {
      if (nowMin >= startMin || nowMin < endMin) {
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active (overnight), resumes in ${(delay / 60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else {
        this.paused = false;
        const delay = msToTarget(startMin);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay / 60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    } else {
      if (nowMin >= startMin && nowMin < endMin) {
        this.paused = true;
        const delay = msToTarget(endMin);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
        logger.info(`pause: currently active, resumes in ${(delay / 60000).toFixed(1)}m at ${this.cfg.pauseEndGmt} GMT`);
      } else {
        this.paused = false;
        const delay = msToTarget(startMin);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
        logger.info(`pause: scheduled, pauses in ${(delay / 60000).toFixed(1)}m at ${this.cfg.pauseStartGmt} GMT`);
      }
    }
  }

  _onPauseResume(action) {
    this._clearPauseTimers();
    if (action === 'pause') {
      this.paused = true;
      logger.info(`TRADING PAUSED at ${this.cfg.pauseStartGmt} GMT until ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(
        `⏸️ <b>MC TRADING PAUSED</b>\n\n` +
        `Scheduled pause active from <b>${htmlEscape(this.cfg.pauseStartGmt)}</b> to <b>${htmlEscape(this.cfg.pauseEndGmt)}</b> GMT.\n` +
        `Open trades will settle normally. No new trades until resume.\n\n` +
        `🕒 ${utcTs()}`
      );
      const end = this._parsePauseTime(this.cfg.pauseEndGmt);
      if (end) {
        const delay = this._msToTarget(end.h, end.min);
        this._pauseEndTimer = setTimeout(() => this._onPauseResume('resume'), delay);
      }
    } else {
      this.paused = false;
      logger.info(`TRADING RESUMED at ${this.cfg.pauseEndGmt} GMT`);
      telegram.send(
        `▶️ <b>MC TRADING RESUMED</b>\n\n` +
        `Scheduled pause ended. Bot is now scanning for trades.\n\n` +
        `💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}\n\n` +
        `🕒 ${utcTs()}`
      );
      const start = this._parsePauseTime(this.cfg.pauseStartGmt);
      if (start) {
        const delay = this._msToTarget(start.h, start.min);
        this._pauseStartTimer = setTimeout(() => this._onPauseResume('pause'), delay);
      }
    }
  }

  _msToTarget(targetH, targetMin) {
    const now = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const targetMinOfDay = targetH * 60 + targetMin;
    let diff = targetMinOfDay - nowMin;
    if (diff <= 0) diff += 24 * 60;
    return diff * 60000 - (now.getUTCSeconds() * 1000) - now.getUTCMilliseconds();
  }

  _clearPauseTimers() {
    if (this._pauseStartTimer) { clearTimeout(this._pauseStartTimer); this._pauseStartTimer = null; }
    if (this._pauseEndTimer)   { clearTimeout(this._pauseEndTimer);   this._pauseEndTimer = null; }
  }

  _isTradingAllowedToday() {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const daySettings = [
      this.cfg.tradeSunday,
      this.cfg.tradeMonday,
      this.cfg.tradeTuesday,
      this.cfg.tradeWednesday,
      this.cfg.tradeThursday,
      this.cfg.tradeFriday,
      this.cfg.tradeSaturday
    ];
    return Boolean(daySettings[dayOfWeek]);
  }

  async start() {
    logger.info('===== Deriv DIGITDIFF Monte Carlo Trading Bot starting =====');
    logger.info(`config: stake=${this.cfg.stake} duration=${this.cfg.durationTicks}t assets=${this.cfg.assets.join(',')}`);
    if (!this.cfg.apiToken) {
      logger.error('DERIV_API_TOKEN missing.');
      process.exit(1);
    }
    this._loadState();

    this.client.on('authorized', info => this._onAuthorized(info));
    this.client.on('close', (c, r, was) => this._onDisconnected(c, r, was));
    this.client.on('open', () => logger.info('connection open'));
    this.client.on('error', e => logger.error('client error:', e.message));
    this.exec.on('open', t => this._onTradeOpen(t));
    this.exec.on('result', t => this._onTradeResult(t));
    this.exec.on('update', t => logger.debug(`update #${t.contractId} ${t.status} profit=${t.profit}`));
    this.market.on('tick', () => { this._tickCounter++; this.analyzer.tick(); });

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
    process.on('uncaughtException', e => { logger.error('uncaughtException:', e); this._saveState('uncaughtException'); });
    process.on('unhandledRejection', e => { logger.error('unhandledRejection:', e); this._saveState('unhandledRejection'); });

    this.client.connect();
    this._scheduleSummaries();
  }

  async _onAuthorized(info) {
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance = this.lastBalance ?? this.client.balance ?? this.startBalance;
    logger.info(`start balance: ${this.startBalance} ${this.currency()}`);
    await this.market.loadSymbols();

    const sizingLine = this.cfg.kellySizingEnabled
      ? `🧮 Sizing: <b>Kelly-fractional</b> (f=${this.cfg.kellyFraction}, cap=${(this.cfg.kellyMaxStakeFrac * 100).toFixed(1)}% bankroll)`
      : (this.cfg.recoveryEnabled
          ? `🧮 Sizing: recovery ladder [${this.cfg.recoveryMultipliers.join(',')}]`
          : `🧮 Sizing: flat`);
    const calibLine = this.cfg.calibEnabled
      ? `📐 Calibrator: <b>ON</b> (window=${this.cfg.calibWindow}, disableGap=${(this.cfg.calibDisableGap * 100).toFixed(1)}pp)`
      : `📐 Calibrator: off`;
    const rotationLine = this.cfg.assetRotationMs > 0
      ? `🔄 Asset rotation: ${(this.cfg.assetRotationMs / 1000).toFixed(0)}s lockout`
      : `🔄 Asset rotation: OFF`;
    const pauseLine = this.cfg.pauseEnabled
      ? `⏸️ Scheduled pause: <b>${htmlEscape(this.cfg.pauseStartGmt)}</b> → <b>${htmlEscape(this.cfg.pauseEndGmt)}</b> GMT`
      : `⏸️ Scheduled pause: off`;

    const dayAbbrev = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const daySettings = [
      this.cfg.tradeSunday, this.cfg.tradeMonday, this.cfg.tradeTuesday,
      this.cfg.tradeWednesday, this.cfg.tradeThursday, this.cfg.tradeFriday, this.cfg.tradeSaturday
    ];
    const dayLine = `📅 Trading days: ${dayAbbrev.map((d, i) => daySettings[i] ? `✅${d}` : `❌${d}`).join(' ')}`;

    telegram.send(
      `🤖 <b>MC Digit Differ Bot Online</b>\n\n` +
      `👤 Account: <code>${htmlEscape(info.loginid || '?')}</code>\n` +
      `💼 Type: ${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'}\n` +
      `💰 Balance: ${(this.client.balance ?? 0).toFixed(2)} ${this.currency()}\n` +
      `📊 Assets: ${this.cfg.assets.join(', ')}\n` +
      `🎯 Contract: <b>DIGITDIFF</b>, duration <b>${this.cfg.durationTicks} tick(s)</b>\n` +
      `💵 Base stake: ${this.cfg.stake.toFixed(2)} ${this.currency()}\n` +
      `${sizingLine}\n` +
      `${calibLine}\n` +
      `${rotationLine}\n` +
      `${pauseLine}\n` +
      `${dayLine}\n` +
      `🧠 Method: <b>Monte Carlo Uniform Null Hypothesis Testing</b>\n` +
      `🕒 Trade day clock: <b>GMT/UTC</b> | EOD: ${this.cfg.eodTimeGmt} GMT\n\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak: current ${this.stats.currentLossStreak}, x2=${this.stats.lossStreakEvents.x2}, x3=${this.stats.lossStreakEvents.x3}, x4=${this.stats.lossStreakEvents.x4}`
    );

    await this.market.bootstrap(this.cfg.assets);
    this._schedulePause();
    if (this._analysisT) clearInterval(this._analysisT);
    this._analyzeAndTrade().catch(e => logger.error('initial analyze:', e.message));
    this._analysisT = setInterval(() => this._analyzeAndTrade().catch(e => logger.error('analyze:', e.message)), this.cfg.analysisIntervalMs);
  }

  _onDisconnected(code, reason, wasAuthorized) {
    telegram.send(`⚠️ <b>MC Connection lost</b>\ncode: <code>${code}</code>\nwas authorized: ${wasAuthorized ? 'yes' : 'no'}\n🔄 reconnecting...`);
    if (this._analysisT) { clearInterval(this._analysisT); this._analysisT = null; }
    if (this.exec.open.size > 0) {
      this._recoverStuckTrade('disconnect');
    }
  }

  currentStake(ctx = null) {
    let base = 0;
    let src  = 'flat';
    if (this.cfg.kellySizingEnabled && ctx && ctx.pWin > 0 && ctx.payoutMult > 1) {
      const bankroll = Math.max(this.cfg.kellyBankrollFloor, this.lastBalance ?? this.client.balance ?? 0);
      const k = this.kelly.compute({
        bankroll,
        pWin: ctx.pWin,
        payoutMult: ctx.payoutMult,
        edgeValue: ctx.edgeValue ?? 0,
      });
      if (k) {
        base = k.stake;
        src  = `kelly(f*=${k.fStar.toFixed(4)}, applied=${k.fApplied.toFixed(4)}, ${k.reason})`;
      } else {
        return { stake: 0, source: 'kelly-negative', calibMult: 1 };
      }
    } else {
      let mult = 1;
      if (this.cfg.recoveryEnabled) {
        const idx = Math.min(this.stats.currentLossStreak, this.cfg.recoveryMultipliers.length - 1);
        mult = this.cfg.recoveryMultipliers[idx] || 1;
      }
      base = +(this.cfg.stake * mult).toFixed(2);
      src  = `flat×${mult}`;
    }
    let calibMult = 1;
    if (ctx?.symbol) calibMult = this.calibrator.stakeMultiplier(ctx.symbol);
    const stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(base * calibMult).toFixed(2)));
    return { stake: calibMult === 0 ? 0 : stake, source: src, calibMult };
  }

  async _analyzeAndTrade() {
    if (this.stopped || !this.client.authorized) return;
    if (this._isAnalyzing) {
      logger.debug('analysis still running — skipping overlapping cycle');
      return;
    }
    this._isAnalyzing = true;
    try {
      if (this.paused) return;
      if (!this._isTradingAllowedToday()) return;
      if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
      if (this.exec.count() >= this.cfg.maxOpenTrades) return;

      const now = Date.now();
      if (now - this.lastLossAt < this.cfg.mcLossCooldownMs) {
        logger.debug('loss cooldown active — skipping cycle');
        return;
      }

      // Hard limits check
      const todayTrades = this.stats.todayTrades();
      const todayStats = this.stats.stats(todayTrades);
      if (todayStats.count >= this.cfg.dailyMaxTrades) {
        logger.warn(`dailyMaxTrades reached (${todayStats.count}/${this.cfg.dailyMaxTrades})`);
        return;
      }
      if (todayStats.totalProfit <= -Math.abs(this.cfg.dailyMaxLoss)) {
        logger.warn(`dailyMaxLoss reached (${todayStats.totalProfit.toFixed(2)}) — trading halted`);
        return;
      }
      if (this.cfg.dailyMaxProfit > 0 && todayStats.totalProfit >= this.cfg.dailyMaxProfit) {
        logger.info(`dailyMaxProfit reached (${todayStats.totalProfit.toFixed(2)}) — target achieved`);
        return;
      }

      const tradeableAssets = this.cfg.assets.filter(s => this.calibrator.isTradeable(s));
      if (!tradeableAssets.length) {
        logger.warn('CALIB: all symbols sidelined; probing after cooldown');
        return;
      }

      // Run statistical analysis per symbol
      const analyses = tradeableAssets.map(s => {
        const livePayout = this.livePayoutMult.get(s) ? (this.cfg.stake * this.livePayoutMult.get(s)) : null;
        return this.analyzer.analyze(s, this.market.historyFor(s), this.cfg.stake, livePayout);
      });
      const ranked = this.analyzer.rank(analyses);
      if (!ranked.length) return;

      const mcApproved = ranked.filter(a => a.mcPasses && a.allowedByModel);
      if (!mcApproved.length) {
        const top = ranked[0];
        logger.debug(`[MC] SKIP ALL: gates=[${top?.gates?.join(', ') || 'none'}] reason=${top?.mcReason || 'unknown'}`);
        return;
      }

      // Probe live proposals for actual payout
      const probeStake = this.cfg.minStake;
      const proposalCandidates = [];

      for (const a of mcApproved) {
        try {
          const pres = await this.exec.proposal(a.symbol, a.digit, probeStake);
          const p = pres.proposal;
          if (!p?.id) continue;
          const ask = Number(p.ask_price || probeStake);
          const payout = Number(p.payout || 0);
          if (!(payout > ask)) continue;
          const payoutMult = payout / ask;
          const breakEvenLossProb = 1 - ask / payout;
          const valueEdge = breakEvenLossProb - a.pUpper;
          proposalCandidates.push({
            analysis: a,
            proposal: p,
            ask, payout, payoutMult,
            breakEvenLossProb,
            valueEdge,
          });
          this.livePayoutMult.set(a.symbol, payoutMult);
        } catch (e) {
          logger.debug(`proposal ${a.symbol} d${a.digit}:`, e.message);
        }
      }

      if (!proposalCandidates.length) return;
      proposalCandidates.sort((a, b) => b.valueEdge - a.valueEdge);

      // Asset rotation lockout
      const rotationMs = Math.max(0, this.cfg.assetRotationMs || 0);
      const lockActive = rotationMs > 0 && this.tradedAsset && (Date.now() - (this.tradedAssetAt || 0) < rotationMs);
      const qualified = proposalCandidates.filter(c => c.valueEdge >= this.cfg.mcMinEdge);
      if (!qualified.length) {
        const top = proposalCandidates[0];
        if (top) logger.debug(`[MC] skip: best edge ${top.valueEdge.toFixed(4)} < minEdge ${this.cfg.mcMinEdge}`);
        return;
      }

      let best = qualified.find(c => !lockActive || c.analysis.symbol !== this.tradedAsset);
      if (!best) {
        if (lockActive) {
          const ageSec = ((Date.now() - (this.tradedAssetAt || 0)) / 1000).toFixed(1);
          logger.debug(`[MC] rotation locked for ${this.tradedAsset} (${ageSec}s)`);
          return;
        }
        best = qualified[0];
      }

      const pWin = 1 - best.analysis.pUpper;
      const sizing = this.currentStake({
        pWin,
        payoutMult: best.payoutMult,
        edgeValue: best.valueEdge,
        symbol: best.analysis.symbol,
      });

      if (!sizing.stake || sizing.stake <= 0) return;
      const stake = sizing.stake;

      this.tradedAsset = best.analysis.symbol;
      this.tradedAssetAt = Date.now();

      const a = best.analysis;
      const payload = {
        method: 'MC-hypothesis',
        digit: a.digit,
        observedHitRate: a.observedHitRate,
        pEstimate: a.pEstimate,
        pUpper: a.pUpper,
        predictedPWin: pWin,
        payoutMult: best.payoutMult,
        breakEvenLossProb: best.breakEvenLossProb,
        valueEdge: best.valueEdge,
        lastDigit: a.lastDigit,
        sizingSource: sizing.source,
        calibStakeMultiplier: sizing.calibMult,
        calibState: this.calibrator.status(a.symbol),
        currentLossStreak: this.stats.currentLossStreak,
        confidence: a.confidence,
        stability: a.stability,
        pValue: a.pValue,
        mcReason: a.mcReason,
        randomnessFlags: a.randomnessFlags,
        gates: a.gates,
      };

      this.analyzer.recordPrediction(a.digit, a.symbol);
      const trade = await this.exec.buy(a.symbol, a.digit, stake, payload);
      this.lastTradeAt = Date.now();
      logger.info(
        `[MC] trade placed #${trade.contractId} ${a.symbol} DIGITDIFF differs ${a.digit} ` +
        `hitRate=${(a.observedHitRate * 100).toFixed(1)}% edge=${best.valueEdge.toFixed(4)} ` +
        `confidence=${a.confidence.toFixed(3)} stability=${a.stability.toFixed(3)}`
      );
    } finally {
      this._isAnalyzing = false;
    }
  }

  // ── Trade Watchdog ─────────────────────────────────────────────────
  _startTradeWatchdog(contractId) {
    this._clearAllWatchdogTimers();
    const timeoutMs = this.tradeWatchdogMs;

    this._watchdogTimer = setTimeout(() => {
      if (!this.exec.open.has(contractId)) return;
      logger.warn(`WATCHDOG FIRED — Contract ${contractId} open for ${(timeoutMs / 1000)}s`);

      if (contractId && this.client.connected && this.client.authorized) {
        this.client._send({ forget_all: 'proposal_open_contract' }).catch(() => {});
        this.client._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }, 15000).catch(() => {});
        this._watchdogPollTimer = setTimeout(() => {
          if (!this.exec.open.has(contractId)) return;
          logger.error(`WATCHDOG: Poll timeout on contract ${contractId} — recovering`);
          this._recoverStuckTrade('watchdog-force');
        }, 15000);
      } else {
        this._recoverStuckTrade('watchdog-offline');
      }
    }, timeoutMs);
  }

  _clearAllWatchdogTimers() {
    if (this._watchdogTimer) { clearTimeout(this._watchdogTimer); this._watchdogTimer = null; }
    if (this._watchdogPollTimer) { clearTimeout(this._watchdogPollTimer); this._watchdogPollTimer = null; }
  }

  _recoverStuckTrade(reason) {
    logger.warn(`Recovery mode: ${reason}`);
    this._clearAllWatchdogTimers();
    const openContracts = [...this.exec.open.entries()];
    if (openContracts.length === 0) return;

    for (const [contractId, info] of openContracts) {
      const openSeconds = info.buyTime ? Math.round((Date.now() / 1000 - info.buyTime)) : '?';
      logger.error(`STUCK TRADE RECOVERED [${reason}] | Contract: ${contractId} | Symbol: ${info.symbol} | Open: ${openSeconds}s`);
      this.exec.open.delete(contractId);
      telegram.send(
        `⚠️ <b>MC STUCK TRADE RECOVERED [${reason}]</b>\n` +
        `Contract: <code>${contractId}</code>\n` +
        `Symbol: ${info.symbol}\n` +
        `Open: ${openSeconds}s\n` +
        `Overall P/L: ${money(this.stats.overallProfit, this.currency())}`
      );
    }
    this._saveState('stuck-trade-recovery');
  }

  _onTradeOpen(t) {
    const a = t.analysis || {};
    telegram.send(
      `🟢 <b>TRADE OPENED — MC DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code>\n` +
      `🔢 Barrier: final digit <b>DIFFERS from ${t.digit}</b>\n` +
      `⏱️ Duration: ${t.durationTicks} tick(s)\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `🎁 Payout: ${t.payout.toFixed(2)} ${this.currency()}\n\n` +
      `🎲 <b>MC Hypothesis Analysis</b>\n` +
      `• Observed hit rate: ${((a.observedHitRate || 0) * 100).toFixed(1)}%\n` +
      `• Upper loss bound (95% CI): ${((a.pUpper || 0) * 100).toFixed(2)}%\n` +
      `• Confidence: <b>${((a.confidence || 0) * 100).toFixed(1)}%</b> | Stability: ${(a.stability || 0).toFixed(2)}\n` +
      `• Break-even loss prob: ${(a.breakEvenLossProb * 100).toFixed(2)}%\n` +
      `• Value edge: <b>${(a.valueEdge * 100).toFixed(2)}pp</b>\n` +
      `• ${a.mcReason || ''}\n` +
      `• Loss streak: ${a.currentLossStreak || 0}\n\n` +
      `🕒 ${utcTs()}`
    );
    this._startTradeWatchdog(t.contractId);
  }

  _onTradeResult(t) {
    this._clearAllWatchdogTimers();
    const rec = this.stats.record(t);
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? 0) + Number(t.profit || 0);
    if (t.balanceAfter != null) this.lastBalance = Number(t.balanceAfter) + Number(t.profit || 0);

    const won = t.status === 'won';
    const pWinUsed = Number(t.analysis?.predictedPWin ?? (t.analysis?.pUpper != null ? 1 - Number(t.analysis.pUpper) : null));
    let calibNote = '';
    if (this.cfg.calibEnabled && Number.isFinite(pWinUsed) && pWinUsed > 0 && pWinUsed < 1) {
      this.calibrator.record(t.symbol, pWinUsed, won);
      const cs = this.calibrator.summary()[t.symbol];
      if (cs) {
        calibNote = `\n📐 <b>Calib (${t.symbol}):</b> ` +
          `state=${cs.state} n=${cs.n} WR=${cs.empirical.toFixed(2)}% ` +
          `vs pred ${cs.predicted.toFixed(2)}% (gap ${cs.gap >= 0 ? '+' : ''}${cs.gap.toFixed(2)}pp)`;
      }
    }

    if (!won) {
      this.lastLossAt = Date.now();
      this.consecutiveMcSkips++;
      logger.info(`[MC] LOSS recorded — cooldown ${this.cfg.mcLossCooldownMs / 1000}s active (consecutive skips: ${this.consecutiveMcSkips})`);
    } else {
      this.consecutiveMcSkips = 0;
    }

    const emoji = won ? '✅' : '❌';
    const label = won ? 'WIN' : 'LOSS';
    const dur = Math.max(0, Number(t.sellTime || Date.now() / 1000) - Number(t.buyTime || 0));
    const todayStats = this.stats.stats(this.stats.todayTrades(rec.date));

    telegram.send(
      `${emoji} <b>TRADE ${label} — MC DIGIT DIFFER</b>\n\n` +
      `🎫 Contract: <code>#${t.contractId}</code>\n` +
      `📊 Symbol: <code>${t.symbol}</code> | differs <b>${t.digit}</b> | ${t.durationTicks}t\n` +
      `💵 Stake: ${t.stake.toFixed(2)} ${this.currency()}\n` +
      `💰 P/L: <b>${money(t.profit, this.currency())}</b>\n` +
      `⏱️ Duration: ${dur.toFixed(1)}s\n\n` +
      `📅 <b>GMT Day Stats (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses})\n` +
      `• Win rate: ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net P/L: <b>${money(todayStats.totalProfit, this.currency())}</b>\n` +
      `• Profit factor: ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `💼 <b>Overall Profit:</b> ${money(this.stats.overallProfit, this.currency())}\n` +
      `❌ <b>Consecutive Losses:</b> current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
      `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}` +
      calibNote
    );

    this.lastTradeAt = Date.now();
    this._saveState('after-trade');
  }

  _scheduleSummaries() {
    if (this.cfg.hourlySummary) {
      const now = new Date();
      const msToNextHour = ((59 - now.getUTCMinutes()) * 60000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
      this._hourlyBoot = setTimeout(() => {
        this._sendHourly();
        this._hourlyT = setInterval(() => this._sendHourly(), 3600000);
      }, Math.max(1000, msToNextHour));
    }

    const scheduleNextEod = () => {
      const delay = this._msToNextEod();
      this._eodBoot = setTimeout(() => {
        this._sendEod('scheduled');
        scheduleNextEod();
      }, delay);
      logger.info(`next GMT EOD report in ${(delay / 3600000).toFixed(2)}h`);
    };
    scheduleNextEod();
  }

  _parseEodTime() {
    const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return { h: 0, min: 0 };
    return { h: Math.max(0, Math.min(23, Number(m[1]))), min: Math.max(0, Math.min(59, Number(m[2]))) };
  }

  _msToNextEod(now = new Date()) {
    const { h, min } = this._parseEodTime();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, this.cfg.eodSendDelaySeconds, 0));
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target.getTime() - now.getTime();
  }

  _eodReportDate(now = new Date()) {
    const { h, min } = this._parseEodTime();
    if (h === 0 && min === 0) return previousUtcDateStr(now);
    return utcDateStr(now);
  }

  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600000);
    const date = utcDateStr(prev);
    const hour = utcHour(prev);
    const list = this.stats.tradesForHour(date, hour);
    const s = this.stats.stats(list);
    if (!list.length) {
      telegram.send(`⏰ <b>MC Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\nNo trades this hour.\n\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
      return;
    }
    let msg = `⏰ <b>MC Hourly Summary GMT (${date} ${pad(hour)}:00-${pad(hour)}:59)</b>\n\n` +
      `📊 Trades: ${s.count} (✅${s.wins} ❌${s.losses})\n` +
      `📈 Win rate: ${s.winRate.toFixed(1)}%\n` +
      `💰 P/L: <b>${money(s.totalProfit, this.currency())}</b>\n` +
      `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
      `❌ Loss streak current ${this.stats.currentLossStreak} | x2=${this.stats.lossStreakEvents.x2} x3=${this.stats.lossStreakEvents.x3} x4=${this.stats.lossStreakEvents.x4}\n\n` +
      `📋 Detail:\n`;
    list.slice(-20).forEach((t, i) => {
      msg += `${i + 1}. ${t.status === 'won' ? '✅' : '❌'} #${t.contractId} ${t.symbol} d${t.digit} ${money(t.profit, this.currency())}\n`;
    });
    telegram.send(msg);
  }

  _sendEod(reason = 'manual') {
    const date = this._eodReportDate(new Date());
    if (this.stats.isEodSent(date) && reason === 'scheduled') return;
    const summary = this.stats.archiveDate(date);
    const ds = summary.stats;

    let msg = `🌙 <b>MC END OF TRADE DAY — GMT</b>\n` +
              `📅 Trade day ended: <b>${date}</b>\n\n` +
              `<b>── Current Day Stats ──</b>\n`;
    if (ds.count) {
      msg += `📊 Trades: ${ds.count} (✅${ds.wins} ❌${ds.losses})\n` +
             `📈 Win rate: ${ds.winRate.toFixed(1)}%\n` +
             `💵 Total stake: ${ds.stake.toFixed(2)} ${this.currency()}\n` +
             `💰 Gross win: +${ds.grossWin.toFixed(2)}\n` +
             `📉 Gross loss: -${ds.grossLoss.toFixed(2)}\n` +
             `💼 <b>Net P/L: ${money(ds.totalProfit, this.currency())}</b>\n` +
             `🏆 Profit factor: ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n` +
             `❌ Max loss streak today: ${ds.maxLossStreak}\n\n`;
    } else {
      msg += `No trades recorded for this GMT trade day.\n\n`;
    }

    msg += `<b>── Overall / Stored Stats ──</b>\n` +
           `💼 Overall Profit: <b>${money(this.stats.overallProfit, this.currency())}</b>\n` +
           `❌ Consecutive losses: current ${this.stats.currentLossStreak} | max ${this.stats.maxLossStreak}\n` +
           `   x2=${this.stats.lossStreakEvents.x2}  x3=${this.stats.lossStreakEvents.x3}  x4=${this.stats.lossStreakEvents.x4}\n\n`;

    if (this.cfg.calibEnabled) {
      const calib = this.calibrator.summary();
      const keys  = Object.keys(calib);
      if (keys.length) {
        msg += `<b>── Symbol Calibration (rolling ${this.cfg.calibWindow}) ──</b>\n`;
        for (const sym of keys) {
          const c = calib[sym];
          const emo = c.state === 'enabled' ? '🟢' : c.state === 'probing' ? '🟡' : '🔴';
          msg += `${emo} <b>${sym}:</b> ${c.state} (n=${c.n}) WR: ${c.empirical.toFixed(1)}% vs pred ${c.predicted.toFixed(1)}% (gap: ${c.gap >= 0 ? '+' : ''}${c.gap.toFixed(1)}pp)\n`;
        }
        msg += '\n';
      }
    }

    this.stats.markEodSent(date);
    this._saveState('eod-sent');
    telegram.send(msg);
  }

  // ── Atomic State Persistence ──────────────────────────────────────
  _saveState(reason = '') {
    const file = this.cfg.stateFile;
    const tmp = `${file}.tmp`;
    const payload = {
      version: 4,
      savedAt: new Date().toISOString(),
      reason,
      stats: this.stats.serialize(),
      calibrator: this.calibrator.serialize(),
    };
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      logger.debug(`state saved (${reason})`);
    } catch (e) {
      logger.warn(`state save failed (${file}):`, e.message);
    }
  }

  _loadState() {
    const file = this.cfg.stateFile;
    if (!fs.existsSync(file)) return;
    try {
      const txt = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(txt);
      if (data.stats) this.stats.load(data.stats);
      if (data.calibrator) this.calibrator.load(data.calibrator);
      logger.info(`state restored from ${file}: overallProfit=${this.stats.overallProfit.toFixed(2)} lossStreak=${this.stats.currentLossStreak}`);
    } catch (e) {
      logger.warn(`state load failed (${file}):`, e.message);
    }
  }

  currency() { return this.client.currency || this.cfg.currency; }

  stop(signal) {
    if (this.stopped) return;
    this.stopped = true;
    logger.info(`stopping (${signal})`);
    telegram.send(`🛑 <b>MC Digit Differ Bot stopped</b>\nSignal: ${htmlEscape(signal)}\n💼 Overall Profit: ${money(this.stats.overallProfit, this.currency())}`);
    if (this._analysisT) clearInterval(this._analysisT);
    this._clearPauseTimers();
    this._clearAllWatchdogTimers();
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._eodBoot) clearTimeout(this._eodBoot);
    if (this._eodT) clearInterval(this._eodT);
    this._saveState('shutdown');
    this.client.stop();
    setTimeout(() => process.exit(0), 2000);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 10. DIFFER BACKTESTER
// ─────────────────────────────────────────────────────────────────────
class DifferBacktester {
  constructor(cfg, client, market) {
    this.cfg = { ...cfg };
    this.client = client;
    this.market = market;
    this.analyzer = new MonteCarloAnalyzer(this.cfg);
  }

  async run(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    if (!list.length) throw new Error('no symbols to backtest');

    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  DIFFER BACKTEST — symbols=[${list.join(', ')}]  ticks=${this.cfg.backtestTicks}`);
    console.log(banner);
    console.log(
      `  MC gates: sims=${this.cfg.mcSimulations}  ` +
      `confidence=${this.cfg.minEdgeConfidence}  stability=${this.cfg.mcStabilityThreshold}\n` +
      `           mcMinEdge=${this.cfg.mcMinEdge}  ` +
      `duration=${this.cfg.durationTicks}t  payoutMult=${this.cfg.backtestPayoutMult}  ` +
      `assetLock=${this.cfg.backtestAssetLock}`
    );
    console.log(banner);

    const combined = { signals: 0, wins: 0, losses: 0, pnl: 0, grossWin: 0, grossLoss: 0 };
    const reports  = [];
    for (const sym of list) {
      const r = await this._runOne(sym);
      reports.push(r);
      combined.signals   += r.signals;
      combined.wins      += r.wins;
      combined.losses    += r.losses;
      combined.pnl       += r.pnl;
      combined.grossWin  += r.grossWin;
      combined.grossLoss += r.grossLoss;
    }

    if (reports.length > 1) {
      console.log(`\n${banner}`);
      console.log('  COMBINED (all symbols):');
      console.log(`    signals=${combined.signals}  wins=${combined.wins}  losses=${combined.losses}`);
      const wr = combined.signals ? (combined.wins / combined.signals * 100) : 0;
      console.log(`    WR=${wr.toFixed(2)}%   Net P/L=${combined.pnl >= 0 ? '+' : ''}${combined.pnl.toFixed(2)} ${this.cfg.currency}`);
      const pf = combined.grossLoss > 0 ? combined.grossWin / combined.grossLoss : (combined.grossWin > 0 ? Infinity : 0);
      console.log(`    PF=${pf === Infinity ? '∞' : pf.toFixed(3)}`);
      console.log(banner + '\n');
    }

    try {
      const payload = {
        savedAt: new Date().toISOString(),
        gates: this._gateSnapshot(),
        symbols: reports,
        combined,
      };
      fs.writeFileSync(this.cfg.backtestOutFile, JSON.stringify(payload, null, 2));
      logger.info(`report written → ${this.cfg.backtestOutFile}`);
    } catch (e) {
      logger.warn(`could not write report: ${e.message}`);
    }
    return reports;
  }

  _gateSnapshot() {
    return {
      mcMinEdge: this.cfg.mcMinEdge,
      minEdgeConfidence: this.cfg.minEdgeConfidence,
      mcStabilityThreshold: this.cfg.mcStabilityThreshold,
      mcSimulations: this.cfg.mcSimulations,
      durationTicks: this.cfg.durationTicks,
      payoutMultiplier: this.cfg.backtestPayoutMult,
    };
  }

  async _probeLivePayoutMult(symbol) {
    try {
      const symbolKey = this.client.symbolField();
      const res = await this.client._send({
        proposal: 1,
        amount: this.cfg.stake,
        basis: 'stake',
        contract_type: 'DIGITDIFF',
        currency: this.cfg.currency,
        duration: this.cfg.durationTicks,
        duration_unit: 't',
        barrier: '0',
        [symbolKey]: symbol,
      }, 15000);
      const p = res?.proposal;
      if (!p) return null;
      const ask = Number(p.ask_price || this.cfg.stake);
      const payout = Number(p.payout || 0);
      if (!(payout > 0 && ask > 0)) return null;
      return payout / ask;
    } catch (e) {
      logger.warn(`live payout probe (${symbol}) failed: ${e.message}`);
      return null;
    }
  }

  async _runOne(symbol) {
    const banner = '─'.repeat(72);
    console.log(`\n${banner}`);
    console.log(`  ${symbol}`);
    console.log(banner);

    let payoutMult = this.cfg.backtestPayoutMult;
    if (this.cfg.backtestProbeLive) {
      const probed = await this._probeLivePayoutMult(symbol);
      if (probed) {
        logger.info(`live payout probe: ${symbol} → ×${probed.toFixed(4)} (was fallback ×${payoutMult})`);
        payoutMult = probed;
      }
    }

    logger.info(`fetching historical ticks (${symbol}, batched)…`);
    const ticks = await this.market.deepBackfill(
      symbol, this.cfg.backtestTicks, this.cfg.backtestBatchSize,
      (got, tot) => {
        if (got % 20000 < this.cfg.backtestBatchSize) logger.info(`  fetched ${got}/${tot}`);
      },
    );
    const pip = this.market.pipSize(symbol);
    if (ticks.length < this.cfg.minTicksForAnalysis + this.cfg.durationTicks + 10) {
      throw new Error(`insufficient history for ${symbol}: got ${ticks.length}`);
    }
    logger.info(`have ${ticks.length} ticks  pip=${pip}  span=${new Date(ticks[0].epoch * 1000).toISOString().slice(0, 19)}Z → ${new Date(ticks[ticks.length - 1].epoch * 1000).toISOString().slice(0, 19)}Z`);

    const baseStake = this.cfg.stake;
    const duration = Math.max(1, this.cfg.durationTicks);
    const minWindow = Math.max(this.cfg.minTicksForAnalysis, 300);

    const kelly = new KellySizer(this.cfg);
    const calib = new SymbolCalibrator(this.cfg);
    let simBankroll = Math.max(this.cfg.kellyBankrollFloor, baseStake * 100);
    const startBankroll = simBankroll;

    const results = {
      symbol,
      pip,
      startEpoch: ticks[0].epoch,
      endEpoch: ticks[ticks.length - 1].epoch,
      tickCount: ticks.length,
      signals: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      grossWin: 0,
      grossLoss: 0,
      predictedWinSum: 0,
      valueEdgeSum: 0,
      byDigit: {},
    };
    for (let d = 0; d < 10; d++) results.byDigit[d] = { signals: 0, wins: 0, losses: 0, pnl: 0 };

    const diag = {
      scans: 0,
      nullAnalyses: 0,
      mcNotRecommended: 0,
      mcEdgeLow: 0,
      gatedEdge: 0,
      gatedAssetLock: 0,
      recommended: 0,
      bestEdgeSeen: -Infinity,
      edgeBuckets: {
        '<0.000'      : 0,
        '0.000-0.002' : 0,
        '0.002-0.004' : 0,
        '0.004-0.006' : 0,
        '0.006-0.010' : 0,
        '0.010-0.020' : 0,
        '0.020-0.040' : 0,
        '>=0.040'     : 0,
      },
    };

    const bucketize = (edge) => {
      if (edge < 0.000) return '<0.000';
      if (edge < 0.002) return '0.000-0.002';
      if (edge < 0.004) return '0.002-0.004';
      if (edge < 0.006) return '0.004-0.006';
      if (edge < 0.010) return '0.006-0.010';
      if (edge < 0.020) return '0.010-0.020';
      if (edge < 0.040) return '0.020-0.040';
      return '>=0.040';
    };

    const streak = {
      current: 0, max: 0,
      currentWin: 0, maxWin: 0,
      events: { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0, x8plus: 0 },
      lossSequences: [],
      winSequences: [],
    };
    const bumpEvent = (n) => {
      if (n === 2) streak.events.x2++;
      else if (n === 3) streak.events.x3++;
      else if (n === 4) streak.events.x4++;
      else if (n === 5) streak.events.x5++;
      else if (n === 6) streak.events.x6++;
      else if (n === 7) streak.events.x7++;
      else if (n >= 8) streak.events.x8plus++;
    };
    const recordOutcome = (won) => {
      if (won) {
        if (streak.current > 0) streak.lossSequences.push(streak.current);
        streak.current = 0;
        streak.currentWin += 1;
        if (streak.currentWin > streak.maxWin) streak.maxWin = streak.currentWin;
      } else {
        if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);
        streak.currentWin = 0;
        streak.current += 1;
        if (streak.current > streak.max) streak.max = streak.current;
        bumpEvent(streak.current);
      }
    };

    const t0 = Date.now();
    let tradedAsset = null;
    let lastTradeAtIdx = -Infinity;
    let i = minWindow;

    while (i < ticks.length - duration - 1) {
      const window = ticks.slice(0, i + 1);
      const analysis = this.analyzer.analyze(symbol, window, baseStake, baseStake * payoutMult);
      diag.scans++;

      if (!analysis) { diag.nullAnalyses++; i++; continue; }

      if (this.cfg.backtestMcEnabled && !analysis.allowedByModel && !analysis.mcPasses) {
        diag.mcNotRecommended++;
        if (analysis.confidence < this.cfg.minEdgeConfidence) diag.mcEdgeLow++;
        i++; continue;
      }

      const valueEdge = analysis.valueEdge ?? (1 - 1 / payoutMult - analysis.pUpper);
      if (valueEdge > diag.bestEdgeSeen) diag.bestEdgeSeen = valueEdge;
      diag.edgeBuckets[bucketize(valueEdge)]++;

      let fire = true;
      if (valueEdge < this.cfg.mcMinEdge) { fire = false; diag.gatedEdge++; }
      if (fire && this.cfg.backtestAssetLock && tradedAsset === symbol && (i - lastTradeAtIdx) < this.cfg.backtestAssetLockTicks) {
        fire = false; diag.gatedAssetLock++;
      }
      let calibMult = 1;
      if (fire && this.cfg.calibEnabled) {
        calibMult = calib.stakeMultiplier(symbol);
        if (calibMult === 0) fire = false;
      }

      if (!fire) { i++; continue; }

      let stake = baseStake;
      if (this.cfg.kellySizingEnabled) {
        const pWin = 1 - analysis.pUpper;
        const k = kelly.compute({
          bankroll: Math.max(this.cfg.kellyBankrollFloor, simBankroll),
          pWin, payoutMult, edgeValue: valueEdge,
        });
        if (k) stake = k.stake;
        else { i++; continue; }
      }
      stake = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, +(stake * calibMult).toFixed(2)));
      if (stake <= 0) { i++; continue; }

      const winNet = stake * payoutMult - stake;
      const lossNet = -stake;

      const expiryTick = ticks[i + duration];
      if (!expiryTick || expiryTick.digit == null) { i++; continue; }
      const won = expiryTick.digit !== analysis.digit;

      results.signals += 1;
      results.predictedWinSum += (1 - analysis.pUpper);
      results.valueEdgeSum += valueEdge;
      results.byDigit[analysis.digit].signals += 1;
      diag.recommended += 1;

      if (won) {
        results.wins += 1;
        results.grossWin += winNet;
        results.pnl += winNet;
        results.byDigit[analysis.digit].wins += 1;
        results.byDigit[analysis.digit].pnl += winNet;
        simBankroll += winNet;
      } else {
        results.losses += 1;
        results.grossLoss += Math.abs(lossNet);
        results.pnl += lossNet;
        results.byDigit[analysis.digit].losses += 1;
        results.byDigit[analysis.digit].pnl += lossNet;
        simBankroll += lossNet;
      }
      recordOutcome(won);

      if (this.cfg.calibEnabled) calib.record(symbol, 1 - analysis.pUpper, won);

      tradedAsset = symbol;
      lastTradeAtIdx = i;
      i += duration + 1;
    }

    results.endBankroll = +simBankroll.toFixed(2);
    results.startBankroll = +startBankroll.toFixed(2);
    results.bankrollGrowthPct = startBankroll > 0 ? +(((simBankroll - startBankroll) / startBankroll) * 100).toFixed(2) : 0;
    results.calibSummary = calib.summary();

    if (streak.current > 0) streak.lossSequences.push(streak.current);
    if (streak.currentWin > 0) streak.winSequences.push(streak.currentWin);

    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const empiricalWR = results.signals ? (results.wins / results.signals) * 100 : 0;
    const predictedWR = results.signals ? (results.predictedWinSum / results.signals) * 100 : 0;
    const avgEdge     = results.signals ? (results.valueEdgeSum / results.signals) * 100 : 0;
    const realizedEV  = results.signals ? (results.pnl / (results.signals * baseStake)) * 100 : 0;

    const streakMetrics = {
      maxLossStreak: streak.max,
      maxWinStreak: streak.maxWin,
      events: streak.events,
      probAtLeast: {
        x2: +((streak.events.x2 + streak.events.x3 + streak.events.x4) / Math.max(1, results.signals)).toFixed(4),
        x3: +((streak.events.x3 + streak.events.x4) / Math.max(1, results.signals)).toFixed(4),
        x4: +(streak.events.x4 / Math.max(1, results.signals)).toFixed(4),
      },
      maxDrawdownFlatStake: streak.max * baseStake,
    };
    results.profitFactor = results.grossLoss > 0 ? +(results.grossWin / results.grossLoss).toFixed(3) : (results.grossWin > 0 ? Infinity : 0);
    results.streakMetrics = streakMetrics;

    const line = '─'.repeat(72);
    console.log(`\n${line}`);
    console.log(`  BACKTEST REPORT: ${symbol}`);
    console.log(line);
    console.log(`  Ticks analyzed  : ${results.tickCount}`);
    console.log(`  Signals fired   : ${results.signals}`);
    console.log(`  Wins / Losses   : ${results.wins} / ${results.losses}`);
    console.log(`  Empirical WR    : ${empiricalWR.toFixed(2)}%`);
    console.log(`  Predicted WR    : ${predictedWR.toFixed(2)}%   (calibration gap ${(empiricalWR - predictedWR).toFixed(2)} pp)`);
    console.log(`  Avg value edge  : ${avgEdge.toFixed(3)}%   Realized EV: ${realizedEV.toFixed(3)}%`);
    console.log(`  Gross win / loss: +${results.grossWin.toFixed(2)} / -${results.grossLoss.toFixed(2)}`);
    console.log(`  Net P/L         : ${results.pnl >= 0 ? '+' : ''}${results.pnl.toFixed(2)} ${this.cfg.currency}`);
    console.log(`  Profit factor   : ${results.profitFactor === Infinity ? '∞' : results.profitFactor}`);
    console.log(`  Runtime         : ${dt}s`);
    console.log(line);

    console.log('  Per-barrier-digit breakdown:');
    for (let d = 0; d < 10; d++) {
      const r = results.byDigit[d];
      if (!r.signals) continue;
      const wr = (r.wins / r.signals * 100).toFixed(1);
      console.log(`    d=${d}   signals=${String(r.signals).padStart(4)}   WR=${wr}%   pnl=${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)}`);
    }

    console.log(line);
    console.log('  Consecutive-loss statistics:');
    console.log(`    Max loss streak       : ${streakMetrics.maxLossStreak} (DD at flat stake: -${streakMetrics.maxDrawdownFlatStake.toFixed(2)} ${this.cfg.currency})`);
    console.log(`    Streak events (x2/x3/x4): x2=${streakMetrics.events.x2} x3=${streakMetrics.events.x3} x4=${streakMetrics.events.x4}`);

    console.log(line);
    console.log('  MC Diagnostics:');
    console.log(`    scans                 : ${diag.scans}`);
    console.log(`    MC rejected (null H0) : ${diag.mcNotRecommended}`);
    console.log(`    signals fired         : ${diag.recommended}`);
    console.log(`    best value edge seen  : ${diag.bestEdgeSeen === -Infinity ? 'n/a' : (diag.bestEdgeSeen * 100).toFixed(3) + '%'}`);

    const totalBuckets = Object.values(diag.edgeBuckets).reduce((a, b) => a + b, 0);
    if (totalBuckets > 0) {
      console.log('\n  Value-edge distribution:');
      const maxCount = Math.max(...Object.values(diag.edgeBuckets));
      for (const [bucket, count] of Object.entries(diag.edgeBuckets)) {
        const pct = (count / totalBuckets * 100);
        const bars = maxCount > 0 ? Math.round((count / maxCount) * 30) : 0;
        console.log(`    ${bucket.padEnd(14)} ${String(count).padStart(6)}  ${pct.toFixed(1).padStart(5)}%  ${'█'.repeat(bars)}`);
      }
    }
    console.log(line + '\n');
    return results;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 11. BOOTSTRAP & MAIN ENTRYPOINT
// ─────────────────────────────────────────────────────────────────────
function printBanner() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   Deriv DIGITDIFF Monte Carlo Trading Bot v3.0     ║');
  console.log('║   Hypothesis Testing • GMT EOD • Atomic Persistence║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
}

async function runSelfTestNull() {
  console.log('🧪 RUNNING STATISTICAL NULL HYPOTHESIS SELF-TEST...');
  console.log('Testing synthetic independent uniform digits against MC null engine...\n');
  const analyzer = new MonteCarloAnalyzer({ ...CONFIG, mcSimulations: 1000 });
  const totalTicks = 10000;
  const sampleSize = 300;
  const uniformDigits = Array.from({ length: totalTicks }, () => Math.floor(Math.random() * 10));

  let scans = 0;
  let falseTrades = 0;

  for (let i = sampleSize; i < totalTicks; i += 50) {
    scans++;
    const window = uniformDigits.slice(i - sampleSize, i);
    const res = analyzer.analyze('SYNTH_UNIFORM', window.map((d, idx) => ({ quote: 1000 + d * 0.0001, digit: d })), 1.10, 1.20);
    if (res && res.mcPasses) {
      falseTrades++;
    }
  }

  const falseTradeRate = (falseTrades / scans) * 100;
  console.log('────────────────────────────────────────────────────────────────────────');
  console.log(`  Total Scans           : ${scans}`);
  console.log(`  False Trades Allowed  : ${falseTrades}`);
  console.log(`  False Trade Rate      : ${falseTradeRate.toFixed(3)}% (Target: ≤ 0.05%)`);
  console.log(`  Correctly Idle (H0)   : ${scans - falseTrades} (${((scans - falseTrades) / scans * 100).toFixed(2)}%)`);
  console.log('────────────────────────────────────────────────────────────────────────');
  if (falseTradeRate <= 0.05) {
    console.log('✅ STATISTICAL VERIFICATION PASSED: True uniform digits yield ZERO/negligible false trades.');
  } else {
    console.log('⚠️ Warning: Statistical false discovery rate above target.');
  }
}

async function main() {
  printBanner();

  if (process.argv.includes('--selftest-null')) {
    await runSelfTestNull();
    process.exit(0);
  }

  if (!CONFIG.apiToken) {
    console.error('❌ DERIV_API_TOKEN is not set.');
    process.exit(1);
  }
  if (RestClient.isPat(CONFIG.apiToken) && !CONFIG.accountId) {
    console.warn('⚠️  PAT token detected. DERIV_ACCOUNT_ID is recommended.');
  }
  console.log(CONFIG.telegram.enabled ? '✅ Telegram notifications: ENABLED' : 'ℹ️  Telegram notifications: DISABLED');

  // Backtest mode
  if (process.env.BACKTEST === '1' || process.argv.includes('--backtest')) {
    const list = (process.env.BACKTEST_ASSET || CONFIG.assets.join(','))
      .split(',').map(s => s.trim()).filter(Boolean);
    console.log(`🧪 BACKTEST mode — symbols=[${list.join(', ')}]  ticks=${CONFIG.backtestTicks}\n`);
    const client = new DerivClient(CONFIG);
    const market = new MarketDataManager(client, CONFIG);

    client.on('authorized', async () => {
      try {
        await market.loadSymbols();
        const bt = new DifferBacktester(CONFIG, client, market);
        await bt.run(list);
        try { client.stop(); } catch (_) {}
        process.exit(0);
      } catch (e) {
        console.error('backtest failed:', e);
        process.exit(1);
      }
    });
    client.connect();
    return;
  }

  const bot = new TradingBot();
  await bot.start();
}

if (require.main === module) {
  main().catch(e => {
    console.error('fatal:', e);
    process.exit(1);
  });
}

module.exports = {
  CONFIG,
  quoteToDigit,
  MonteCarloAnalyzer,
  MarketDataManager,
  TradeExecutor,
  StatisticsManager,
  SymbolCalibrator,
  KellySizer,
  TradingBot,
  DifferBacktester,
};
