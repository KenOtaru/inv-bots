require('dotenv').config();
const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const EventEmitter = require('events');
const crypto = require('crypto');

// ── env + logging helpers ───────────────────────────────────────────────
function numEnv(n, d) { const v = process.env[n]; if (v == null || v === '') return d; const x = Number(v); return Number.isFinite(x) ? x : d; }
function intEnv(n, d) { const v = process.env[n]; if (v == null || v === '') return d; const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; }
function strEnv(n, d) { const v = process.env[n]; return v == null || v === '' ? d : String(v).trim(); }
function boolEnv(n, d) { const v = process.env[n]; if (v == null || v === '') return d; return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase()); }
const logger = {
    error: (...a) => console.error(...a),
    warn: (...a) => console.warn(...a),
    info: (...a) => console.log(...a),
    debug: (...a) => console.log(...a),
};
const pad = n => String(n).padStart(2, '0');
function utcTs() { const d = new Date(); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`; }
function htmlEscape(s) { return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch])); }

// ── CONFIG — credentials from randomDigitDifferV2.js ───────────────────
const CONFIG = Object.freeze({
    // ── DUAL PHASE ──────────────────────────────────────────────────────
    // The VIRTUAL phase (state key "REGULAR") simulates every trade locally —
    // no Deriv token, no real order, no Deriv balance. After
    // LOSSES_BEFORE_MAIN_SWITCH consecutive virtual losses the bot hands over
    // to the MAIN token, where the martingale ladder starts from
    // MAIN_INITIAL_STAKE and climbs per further loss. A MAIN win returns the
    // bot to the VIRTUAL phase at flat stake.
    // MAIN_TOKEN is mandatory: the VIRTUAL leg owns no token, so without MAIN
    // there is no real trading path and the bot refuses to boot.
    mainToken:    strEnv('MAIN_TOKEN', 'pat_e02a554e3b6f9f939c07855fe28c91c68e58ea14f741f45f675f82de96da4289'),

    // ── VIRTUAL phase economics ─────────────────────────────────────────
    // stake $0.35 → payout $0.37 on a win (+$0.02). Stored as a ratio so the
    // edge holds if initialStake is ever changed.
    virtualPayoutRatio:  numEnv('VIRTUAL_PAYOUT_RATIO', 0.37 / 0.35),
    virtualStartBalance: numEnv('VIRTUAL_START_BALANCE', 1000),

    // ── stuck-trade watchdog ────────────────────────────────────────────
    // A 1-tick DIGITDIFF settles on the very next tick (~1-2s). If nothing has
    // settled it by tradeWatchdogMs we re-query, then force-void after a
    // further watchdogPolls × watchdogPollGapMs.
    tradeWatchdogMs:   numEnv('WATCHDOG_MS', 10000),
    watchdogPolls:     intEnv('WATCHDOG_POLLS', 3),
    watchdogPollGapMs: intEnv('WATCHDOG_POLL_GAP_MS', 5000),
    // A buy that never acknowledges. Must stay ABOVE the 15s buy _send timeout
    // or the timer can never outlive the request it is watching.
    buyAckMs:          numEnv('BUY_ACK_MS', 20000),

    appId:       process.env.APP_ID || '33uslPtthXBEkQOdfKfoY',
    accountId:   process.env.ACCOUNT_ID || '',
    accountType: 'demo',
    legacyWsUrl: 'wss://ws.derivws.com/websockets/v3',
    restBaseUrl: 'https://api.derivws.com',
    currency:    'USD',

    // Consecutive REGULAR losses that hand the next trades to the MAIN token.
    lossesBeforeMainSwitch: intEnv('LOSSES_BEFORE_MAIN_SWITCH', 1),

    // ── multi-asset selection / suspension ─────────────────────────────
    randomAssetSelection:   boolEnv('RANDOM_ASSET_SELECTION', true), // pick a random asset each trade
    suspendAssetAfterTrade: boolEnv('SUSPEND_AFTER_TRADE', true),   // suspend traded asset after each trade
    singleActiveAsset:      boolEnv('ONE_ASSET_AT_A_TIME', true),     // subscribe + trade ONE random asset per cycle

    // ── SESSION takeProfit cooldown (random) ───────────────────────────
    takeProfitCooldownMinMs: intEnv('TAKE_PROFIT_COOLDOWN_MS_MIN', 15 * 60 * 1000), // 15 min
    takeProfitCooldownMaxMs: intEnv('TAKE_PROFIT_COOLDOWN_MS_MAX', 60 * 60 * 1000), // 60 min

    // ── persistence (survive restart / network drop) ───────────────────
    stateFile: strEnv('STATE_FILE', 'randomDifferv_state_001.json'),

    telegram: {
        enabled:  true,
        botToken: '8591937854:AAESyF-8b17sRK-xdQXzrHfALnKA1sAR3CI',
        chatId:   '752497117',
    },
    reconnect: {
        initialDelayMs: intEnv('RECONNECT_INITIAL_MS', 1000),
        maxDelayMs:     intEnv('RECONNECT_MAX_MS', 60000),
        backoffFactor:  numEnv('RECONNECT_BACKOFF', 2),
        jitterMs:       intEnv('RECONNECT_JITTER_MS', 750),
    },
});

// ── TELEGRAM notifier (flood-aware, same as randomDigitDifferV2.js) ─────
class TelegramNotifier extends EventEmitter {
    constructor(cfg) {
        super();
        this.enabled = cfg.enabled && !!cfg.botToken && !!cfg.chatId;
        this.botToken = cfg.botToken; this.chatId = cfg.chatId;
        this.q = []; this.sending = false;
        this.gapMs = Math.max(1000, numEnv('TELEGRAM_GAP_MS', 3000));
        this.maxQ = Math.max(10, intEnv('TELEGRAM_MAX_QUEUE', 100));
        this.bannedUntil = 0; this._lastBanLog = 0;
    }
    _parseRetryAfter(body) {
        try { const j = JSON.parse(String(body || '')); const s = j?.parameters?.retry_after; if (Number.isFinite(Number(s))) return Number(s); } catch (_) {}
        const m = String(body || '').match(/retry after (\d+)/i); return m ? Number(m[1]) : 0;
    }
    _post(text) {
        return new Promise(res => {
            if (!this.enabled) return res({ ok: false, retryAfter: 0 });
            try {
                const payload = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
                const u = new URL(`https://api.telegram.org/bot${this.botToken}/sendMessage`);
                const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 15000 }, r => {
                    let body = '';
                    r.on('data', c => { body += c; if (body.length > 500) body = body.slice(0, 500); });
                    r.on('end', () => {
                        const ok = r.statusCode === 200;
                        let retryAfter = 0;
                        if (!ok) {
                            retryAfter = (r.statusCode === 429) ? (this._parseRetryAfter(body) || 60) : 0;
                            logger.warn(`telegram send failed: http=${r.statusCode} retryAfter=${retryAfter}s body=${body.slice(0, 200)}`);
                        }
                        res({ ok, retryAfter });
                    });
                });
                req.on('error', e => { logger.warn('telegram:', e.message); res({ ok: false, retryAfter: 0 }); });
                req.on('timeout', () => { req.destroy(new Error('tg timeout')); res({ ok: false, retryAfter: 0 }); });
                req.write(payload); req.end();
            } catch (e) { logger.warn('telegram exc:', e.message); res({ ok: false, retryAfter: 0 }); }
        });
    }
    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    async _drain() {
        if (this.sending || !this.q.length) return;
        this.sending = true;
        try {
            while (this.q.length) {
                const waitMs = this.bannedUntil - Date.now();
                if (waitMs > 0) {
                    if (Date.now() - this._lastBanLog > 60000) { this._lastBanLog = Date.now(); logger.warn(`telegram flood ban active — pausing sends for ${(waitMs / 1000).toFixed(0)}s (queue=${this.q.length})`); }
                    await this._sleep(Math.min(waitMs, 30000));
                    continue;
                }
                const msg = this.q.shift();
                const r = await this._post(msg.text);
                if (!r.ok && r.retryAfter > 0) {
                    this.bannedUntil = Date.now() + r.retryAfter * 1000;
                    this._lastBanLog = 0;
                    if (r.retryAfter > 300) {
                        const kept = this.q.filter(m => m.pr === 'high');
                        const dropped = this.q.length - kept.length;
                        this.q.length = 0; this.q.push(...kept);
                        if (msg.pr === 'high') this.q.unshift(msg);
                        logger.warn(`telegram flood ban ${r.retryAfter}s — dropped ${dropped} queued routine notification(s), kept ${kept.length} alert(s)`);
                    } else {
                        this.q.unshift(msg);
                        logger.warn(`telegram 429 — retry_after ${r.retryAfter}s, pausing (queue=${this.q.length})`);
                    }
                    continue;
                }
                await this._sleep(this.gapMs);
            }
        } finally { this.sending = false; }
    }
    send(t, pr = 'normal') {
        if (!this.enabled) { logger.warn('telegram send skipped: notifier disabled (check botToken/chatId)'); return; }
        if (pr !== 'low' && pr !== 'high') pr = 'normal';
        this.q.push({ text: String(t), pr });
        while (this.q.length > this.maxQ) {
            const li = this.q.findIndex(m => m.pr === 'low');
            if (li >= 0) { this.q.splice(li, 1); continue; }
            const ni = this.q.findIndex(m => m.pr === 'normal');
            this.q.splice(ni >= 0 ? ni : 0, 1);
        }
        if (this.q.length > 20 && this.q.length % 10 === 1) logger.warn(`telegram queue backlogged (depth=${this.q.length}) — notifications will lag`);
        this._drain().catch(e => logger.warn('tg drain:', e.message));
    }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ── REST + WS CLIENT (new PAT connection — same as randomDigitDifferV2.js)
class RestClient {
    constructor(base, appId, token) { this.baseUrl = base; this.appId = appId; this.token = token; }
    static isPat(t) { return typeof t === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(t.trim()); }
    request(method, route, body = null) {
        return new Promise((res, rej) => {
            let u; try { u = new URL(route, this.baseUrl); } catch (e) { return rej(new Error(`Bad URL ${route}`)); }
            const payload = body == null ? null : JSON.stringify(body);
            const req = https.request({ method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: { Authorization: `Bearer ${this.token}`, 'Deriv-App-ID': this.appId, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }, timeout: 15000 }, r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => { try { d = JSON.parse(d); } catch (_) {} res({ status: r.statusCode, body: d }); });
            });
            req.on('timeout', () => req.destroy(new Error('REST timeout'))); req.on('error', rej);
            if (payload) req.write(payload); req.end();
        });
    }
    get(r) { return this.request('GET', r); }
    post(r, b) { return this.request('POST', r, b); }
}

class DerivClient extends EventEmitter {
    constructor(cfg) {
        super(); this.cfg = cfg; this.ws = null; this.connected = false; this.authorized = false;
        this.label = cfg.label || 'REGULAR';
        this._stopped = false; this._suspended = false; this._reconnecting = false; this._reconnectAttempt = 0; this._reqId = 0;
        this._pending = new Map(); this._subs = new Map(); this.balance = null; this.currency = cfg.currency;
        this.accountInfo = null; this.symbols = new Map();
        this._isPat = RestClient.isPat(cfg.apiToken);
        this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
        this._targetAccountId = cfg.accountId || '';
    }
    _log(level, msg) { logger[level](`[${this.label}] ${msg}`); }
    _nextId() { return ++this._reqId; }
    _legacyUrl() { const s = this.cfg.legacyWsUrl.includes('?') ? '&' : '?'; return `${this.cfg.legacyWsUrl}${s}app_id=${encodeURIComponent(this.cfg.appId)}`; }
    _redact(u) { return String(u).replace(/([?&])(otp|app_id|token|auth)=[^&]+/gi, '$1$2=***'); }
    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        if (!this.cfg.apiToken) { this._log('error', 'API token empty — connection skipped'); this._stopped = true; return; }
        if (this._isPat) this._connectPat().catch(e => { this._log('error', `PAT connect: ${e.message}`); this._schedReconnect(); });
        else this._openWs(this._legacyUrl());
    }
    async _connectPat() {
        const aid = await this._resolvePatAccountId();
        const route = `/trading/v1/options/accounts/${encodeURIComponent(aid)}/otp`;
        const res = await this._rest.post(route);
        if (res.status !== 200) { const m = res.body?.errors?.[0]?.message || res.body?.message || JSON.stringify(res.body); throw new Error(`OTP ${res.status}: ${m}`); }
        const wsUrl = res.body?.data?.url; if (!wsUrl) throw new Error(`OTP missing url: ${JSON.stringify(res.body)}`);
        this._targetAccountId = aid;
        this.accountInfo = { loginid: aid, accountType: this.cfg.accountType, isVirtual: this.cfg.accountType !== 'real', currency: this.cfg.currency };
        this._log('info', `connecting → ${this._redact(wsUrl)}`); this._openWs(wsUrl);
    }
    async _resolvePatAccountId() {
        if (this._targetAccountId) return this._targetAccountId;
        for (const [m, r] of [['GET', '/trading/v1/options/accounts'], ['POST', '/trading/v1/options/accounts/list']]) {
            try {
                const res = m === 'GET' ? await this._rest.get(r) : await this._rest.post(r, null);
                if (res.status >= 200 && res.status < 300) {
                    const arr = Array.isArray(res.body?.data) ? res.body.data : Array.isArray(res.body?.accounts) ? res.body.accounts : [];
                    if (arr.length) { const d = arr.find(a => String(a.account_type || '').toLowerCase() === this.cfg.accountType) || arr[0]; const id = d.account_id || d.loginid || d.id; if (id) { this.accountInfo = { loginid: id, accountType: d.account_type || this.cfg.accountType, isVirtual: String(d.account_type || this.cfg.accountType).toLowerCase() !== 'real', currency: d.currency || this.cfg.currency, balance: d.balance != null ? Number(d.balance) : null }; return id; } }
                }
            } catch (e) { this._log('debug', `PAT discovery ${m} ${r}: ${e.message}`); }
        }
        throw new Error('DERIV_ACCOUNT_ID required for PAT');
    }
    _openWs(url) {
        try { this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'DigitPredictorV2/2.0' } }); } catch (e) { this._log('error', `WS construct: ${e.message}`); this._schedReconnect(); return; }
        this.ws.on('open', () => this._onOpen()); this.ws.on('message', d => this._onMsg(d)); this.ws.on('error', e => this._onErr(e)); this.ws.on('close', (c, r) => this._onClose(c, r));
        this.ws.on('unexpected-response', (_, res) => { this._log('error', `WS handshake: ${res.statusCode} ${res.statusMessage}`); try { res.destroy(); } catch (_) {} this._schedReconnect(); });
    }
    _onOpen() { this._log('info', 'WS connected ✔'); this.connected = true; this._reconnecting = false; this._reconnectAttempt = 0; this.emit('open'); if (this._isPat) this._markPatAuth(); else this._authLegacy(); }
    async _authLegacy() {
        try {
            const res = await this._send({ authorize: this.cfg.apiToken }, 20000); const a = res.authorize;
            this.authorized = true; this.balance = Number(a.balance); this.currency = a.currency || this.cfg.currency;
            this.accountInfo = { loginid: a.loginid, email: a.email, isVirtual: !!a.is_virtual, accountType: a.account_type, currency: this.currency };
            this._log('info', `authorized ${a.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) bal=${this.balance} ${this.currency}`);
            this.emit('authorized', this.accountInfo, this.label);
        } catch (e) { this._log('error', `authorize: ${e.message}`); this.authorized = false; this._schedReconnect(); }
    }
    async _markPatAuth() {
        this.authorized = true; if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance); this.currency = this.accountInfo?.currency || this.cfg.currency;
        try { const b = await this._send({ balance: 1 }, 10000); if (b.balance) { this.balance = Number(b.balance.balance); this.currency = b.balance.currency || this.currency; } } catch (e) { this._log('debug', `balance skip: ${e.message}`); }
        this._log('info', `authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT bal=${this.balance ?? '?'} ${this.currency}`);
        this.emit('authorized', this.accountInfo || { loginid: this._targetAccountId, isVirtual: this.cfg.accountType !== 'real' }, this.label);
    }
    _onMsg(data) {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.error) {
            const code = msg.error.code || 'Error', text = msg.error.message || code;
            const benign = new Set(['AlreadySubscribedOrLimit', 'ContractNotFound', 'BetExpired', 'TradingDurationNotAllowed']);
            (benign.has(code) ? this._log.bind(this, 'debug') : this._log.bind(this, 'error'))(`api: ${code} - ${text} req=${msg.req_id || '?'}`);
            if (msg.req_id && this._pending.has(msg.req_id)) { const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); const err = new Error(text); err.apiError = true; err.code = code; p.reject(err); }
            if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) try { this.ws?.close(); } catch (_) {}
            return;
        }
        if (msg.req_id && this._pending.has(msg.req_id)) { const p = this._pending.get(msg.req_id); clearTimeout(p.timer); this._pending.delete(msg.req_id); p.resolve(msg); return; }
        if (msg.subscription?.id && this._subs.has(msg.subscription.id)) { const cb = this._subs.get(msg.subscription.id); try { cb(msg); } catch (e) { this._log('error', `sub handler: ${e.message}`); } return; }
        this.emit('message', msg);
    }
    _onErr(e) { this._log('error', `WS error: ${e.message} ${e.code || ''}`); this.emit('error', e); }
    _onClose(code, reason) {
        const rs = (() => { try { return reason?.toString() || ''; } catch { return ''; } })();
        this._log('warn', `WS closed code=${code} ${rs || ''}`); const was = this.authorized; this.connected = false; this.authorized = false;
        for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); } this._pending.clear(); this._subs.clear();
        this.emit('close', code, reason, was); if (!this._stopped && !this._suspended) this._schedReconnect();
    }
    _schedReconnect() {
        if (this._stopped || this._suspended || this._reconnecting) return; this._reconnecting = true; this._reconnectAttempt++;
        const base = Math.min(this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1), this.cfg.reconnect.maxDelayMs);
        const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
        this._log('info', `reconnect #${this._reconnectAttempt} in ${(delay / 1000).toFixed(1)}s`);
        setTimeout(() => { this._reconnecting = false; this.connect(); }, delay);
    }
    _send(payload, timeoutMs = 30000, onReqId = null) {
        return new Promise((res, rej) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('Not connected'));
            const id = this._nextId();
            const timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); rej(new Error('Request timeout')); } }, timeoutMs);
            this._pending.set(id, { resolve: res, reject: rej, timer });
            try {
                this.ws.send(JSON.stringify({ ...payload, req_id: id }));
                // Tell the caller the wire id so a later orphan reply can be
                // matched to the request even after it times out (buy-ack watch).
                if (onReqId) { try { onReqId(id); } catch (_) {} }
            } catch (e) { clearTimeout(timer); this._pending.delete(id); rej(e); }
        });
    }
    subscribe(payload, cb, timeoutMs = 30000) {
        return new Promise((res, rej) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(new Error('Not connected'));
            const id = this._nextId();
            const timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); rej(new Error('Subscribe timeout')); } }, timeoutMs);
            this._pending.set(id, { resolve: msg => { const sid = msg.subscription?.id; if (!sid) return rej(new Error('No sub id')); this._subs.set(sid, cb); res(sid); }, reject: rej, timer });
            try { this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: id })); } catch (e) { clearTimeout(timer); this._pending.delete(id); rej(e); }
        });
    }
    forget(subId) { if (!subId) return Promise.resolve(); this._subs.delete(subId); if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(); return this._send({ forget: subId }, 8000).catch(e => logger.debug('forget:', e.message)); }
    suspend() { this._suspended = true; try { this.ws?.close(); } catch (_) {} }
    resume() { this._suspended = false; this.connect(); }
    stop() { this._stopped = true; try { this.ws?.close(); } catch (_) {} }
    symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

class EnhancedDigitDifferTradingBot {
    constructor(config = {}) {
        this.currency = CONFIG.currency;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            'R_10','R_25','R_50','R_75', 'RDBULL', 'RDBEAR', 'JD10', 'JD25', 'JD50', 'JD75', 'JD100'
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            // 'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // 'R_75',
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            // ── DUAL PHASE ────────────────────────────────────────────
            // The VIRTUAL leg always stakes flat at initialStake. MAIN opens
            // at its own base (mainInitialStake) and only MAIN climbs the
            // martingale ladder.
            mainInitialStake: config.mainInitialStake != null ? config.mainInitialStake : 1.0,
            lossesBeforeMainSwitch: config.lossesBeforeMainSwitch != null
                ? config.lossesBeforeMainSwitch
                : CONFIG.lossesBeforeMainSwitch,
            multiplier: config.multiplier || 11.3,
            // This caps the MAIN martingale ladder (L0..L{max-1}).
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit != null ? config.takeProfit : 25,
            takeProfitCooldownMinMs: config.takeProfitCooldownMinMs || CONFIG.takeProfitCooldownMinMs,
            takeProfitCooldownMaxMs: config.takeProfitCooldownMaxMs || CONFIG.takeProfitCooldownMaxMs,
            // ── VIRTUAL phase economics ───────────────────────────────
            virtualPayoutRatio: config.virtualPayoutRatio != null ? config.virtualPayoutRatio : CONFIG.virtualPayoutRatio,
            virtualStartBalance: config.virtualStartBalance != null ? config.virtualStartBalance : CONFIG.virtualStartBalance,
            // ── stuck-trade watchdog / buy-ack ────────────────────────
            tradeWatchdogMs: config.tradeWatchdogMs != null ? config.tradeWatchdogMs : CONFIG.tradeWatchdogMs,
            watchdogPolls: config.watchdogPolls != null ? config.watchdogPolls : CONFIG.watchdogPolls,
            watchdogPollGapMs: config.watchdogPollGapMs != null ? config.watchdogPollGapMs : CONFIG.watchdogPollGapMs,
            buyAckMs: config.buyAckMs != null ? config.buyAckMs : CONFIG.buyAckMs,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            randomAssetSelection: config.randomAssetSelection != null ? config.randomAssetSelection : CONFIG.randomAssetSelection,
            suspendAssetAfterTrade: config.suspendAssetAfterTrade != null ? config.suspendAssetAfterTrade : CONFIG.suspendAssetAfterTrade,
            singleActiveAsset: config.singleActiveAsset || CONFIG.singleActiveAsset,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
        };

        this.stateFile = config.stateFile || CONFIG.stateFile;

        // ── DUAL PHASE state ────────────────────────────────────────────
        // tokenMode    = the phase the NEXT trade will execute on
        //                ('REGULAR' = VIRTUAL simulation, 'MAIN' = real token).
        // tradeTokenMode = the phase the in-flight trade actually executed on
        //                (mode can only change on settlement, but reconciling a
        //                contract across a restart must use the owning phase).
        // tokenLossStreak = consecutive losses accrued on VIRTUAL; reaching
        //                lossesBeforeMainSwitch hands trading to MAIN.
        // martingaleLevel = MAIN ladder level only — always 0 on VIRTUAL.
        // 'REGULAR' is the persisted key (state-file compatibility) even though
        // every user-facing label reads VIRTUAL.
        this.tokenMode = 'REGULAR';
        this.tradeTokenMode = 'REGULAR';
        this.tokenLossStreak = 0;
        this.martingaleLevel = 0;
        this.tokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        this._sessionTokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.currentAsset = null;
        this.activeAsset = null; // single-active-asset mode: the one asset subscribed + traded this cycle
        // No-repeat anchors: the previous trade's asset/digit are excluded from
        // the next selection so two consecutive trades never share either.
        this.lastTradedAsset = null;
        this.lastTradedDigit = null;
        this.lastOpenDigits = [];
        this.lastOpenStake = 0;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.tickHistories2 = {};
        this.lastDigits = {};
        this.lastDigits2 = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.endOfDay = false;
        this.lastPredictionOutcome = null;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        // this.startTime = null;
        this.isExcluded = [];
        // Add new property to track suspended assets
        this.suspendedAssets = new Set();
        this.settledContracts = new Set();
        this.rStats = {};
        this.sys = 1;

        // ── session / takeProfit state (V2) ─────────────────────────────
        this._sessionNum = 1;
        this._sessionStartAt = Date.now();
        this._sessionStartBal = 0;
        this._sessionPL = 0;
        this._sessionTrades = 0;
        this._tpAwaiting = false;
        this._tpPauseUntil = 0;
        this._tpResumeT = null;
        this._stopped = false;
        this.startBalance = null;

        // ── in-flight contract reconciliation (survive restart/drop) ────
        this.pendingContractId = null;
        this.pendingContractAsset = null;
        this.pendingContractDigit = null;
        this.pendingContractMode = null;
        this._contractPollTimer = null;

        // ── VIRTUAL phase ledger ────────────────────────────────────────
        // No Deriv account backs this leg, so the balance lives here.
        // _virtualSeq mints synthetic contract ids ('V1', 'V2', …) which can
        // never collide with Deriv's numeric ones inside settledContracts.
        this.virtualBalance = this.config.virtualStartBalance;
        this._virtualSeq = 0;
        this.pendingVirtual = null; // { id, asset, digit, stake, payout, buyAt }

        // ── stuck-trade watchdog / buy-ack (see _startTradeWatchdog) ────
        this._watchdogTimers = new Map(); // '123' | '123:poll' | 'ack:<n>'
        this._openSubIds = new Map();     // contractId → open-contract sub id
        this.stuckTrades = [];            // audit trail, cap 50, persisted
        this._pendingBuy = null;          // buy sent, no contract_id yet
        this._buyAckSeq = 0;

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.lastDigits2[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });

        // ── single real connection — the VIRTUAL phase needs no token ────
        // Market data always rides the MAIN connection; only MAIN sends orders.
        this.clientMain = CONFIG.mainToken
            ? new DerivClient({ ...CONFIG, apiToken: CONFIG.mainToken, label: 'MAIN' })
            : null;
        this.tickSubOwners = {};

        [this.clientMain].filter(Boolean).forEach(c => {
            c.on('open', () => {
                logger.info(`${c.label}: connected to Deriv API`);
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
            });
            c.on('authorized', (info, label) => this.handleAuthorized(info, label || c.label));
            c.on('close', () => {
                logger.warn(`${c.label}: disconnected from Deriv API`);
                this.connected = this._anyAuthorized();
                this.wsReady = this.connected;
            });
            c.on('error', (error) => {
                logger.error(`${c.label} WebSocket error: ${error.message}`);
            });
            // A buy that ack'd AFTER its request timed out falls through
            // DerivClient's _pending map onto this event (see _onMsg).
            c.on('message', msg => this.handleUnsolicitedMessage(msg));
        });

        this.reconnectAttempts = 0;
        this.Pause = false;

        this.todayPnL = 0;
        this.dailyStats = {};
        this.hourlyStats = {};
        this.eodTimeGmt = '00:00';
        this._hourlyBoot = null;
        this._hourlyT = null;
        this._eodBoot = null;

        this._loadState();

        this.startTelegramTimer();
    }

    // ── DUAL PHASE helpers ────────────────────────────────────────────
    _emptyTokenStats() {
        return { trades: 0, wins: 0, losses: 0, profit: 0, loss: 0, netPL: 0, stakes: 0, list: [] };
    }

    _dualTokenEnabled() { return !!(this.clientMain && CONFIG.mainToken); }

    // The VIRTUAL phase owns no connection of its own — market data and, when
    // trading MAIN, orders all ride the single real connection.
    clientFor(mode) { return this.clientMain; }

    _act() { return this.clientMain; }

    _anyAuthorized() { return !!(this.clientMain && this.clientMain.authorized); }

    // Total position across both ledgers: the simulated VIRTUAL balance plus
    // whatever the live MAIN account currently holds.
    _totalBalance() {
        const main = this.clientMain && this.clientMain.balance != null ? Number(this.clientMain.balance) : 0;
        return Number((this.virtualBalance + main).toFixed(2));
    }

    // VIRTUAL payout for a given stake: stake × ratio, rounded to cents.
    _virtualPayout(stake) {
        const s = stake != null ? Number(stake) : this._regularStake();
        const r = Number(this.config.virtualPayoutRatio) || 1;
        return Math.max(0, Math.round(s * r * 100) / 100);
    }

    // MAIN ladder stake: its own base, multiplied once per level. VIRTUAL never
    // calls this — VIRTUAL is pinned to initialStake.
    _mainStake(level) {
        const base = Number(this.config.mainInitialStake) || Number(this.config.initialStake) || 0.35;
        const mult = Number(this.config.multiplier) || 1;
        const raw = base * Math.pow(mult, Math.max(0, Number(level) || 0));
        return Math.max(base, Math.ceil(raw * 100) / 100);
    }

    // VIRTUAL never escalates. Called after every result so the flat-stake rule
    // holds even if a stale value was restored from disk.
    _regularStake() {
        const base = Number(this.config.initialStake) || 0.35;
        return Math.max(base, Math.ceil(base * 100) / 100);
    }

    connect() {
        if (!this.Pause) {
            logger.info('Attempting to connect to Deriv API (single real connection)...');
            if (this.clientMain) this.clientMain.connect();
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);

        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorNotification('Invalid API token');
                this.stopTrading();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.initializeSubscriptions();
        }
    }

    async handleAuthorized(accountInfo, label = 'MAIN') {
        const token = label === 'MAIN' ? 'MAIN' : 'REGULAR';
        logger.info(`Authentication successful (${token} connection)`);

        // The single real connection feeds market data for BOTH phases (the
        // VIRTUAL phase has no connection of its own), so every authorization
        // drives the trade cycle regardless of which phase trades next.

        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });
        this.tickSubscriptionIds = {};
        this.tickSubOwners = {};
        this.retryCount = 0;

        // Every authorization starts a fresh subscription cycle. The normal
        // post-trade cycle reuses the same authorization and follows the same
        // asset selection flow without reconnecting the socket.
        if (this.config.singleActiveAsset) {
            this.activeAsset = this._pickActiveAsset();
            console.log(`🎲 Next trade asset (random pick per trade): ${this.activeAsset}`);
        }

        await this.initializeSubscriptions();

        if (this.startBalance == null) this.startBalance = this._totalBalance();

        // If a session takeProfit pause survived the restart, honor it;
        // resume immediately only when the persisted cooldown already elapsed.
        if (this._tpAwaiting && Date.now() >= this._tpPauseUntil) {
            this._startNewSession('pause elapsed during restart');
        }

        // Reconcile any contract left open across a restart / network drop —
        // always on the connection that owns it.
        await this._reconcilePendingContract();

        const sessionLine = this._tpAwaiting
            ? '⏸ ' + this._sessionLine() + ' — resumes ' + new Date(this._tpPauseUntil).toUTCString()
            : '▶ ' + this._sessionLine();

        const assetsLine = this.config.singleActiveAsset
            ? '🎲 This trade: <code>' + htmlEscape(this.activeAsset || '?') + '</code> (random pick per trade) | pool: <code>' + this.assets.join(', ') + '</code>'
            : '📊 Assets: <code>' + this.assets.join(', ') + '</code> (' + (this.config.randomAssetSelection ? 'random pick' : 'tick-driven') + ')';

        const winRateLifetime = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';

        telegram.send(
            '🤖 <b>Random Digit Differ — ONLINE</b>\n' +
            '🔌 <b>Trading phases</b>\n' +
            this._tokenBadge('REGULAR') + '\n' +
            this._tokenBadge('MAIN') + '\n\n' +
            this._tokenPolicyLine() + '\n' +
            this._tokenBlock('Per-phase lifetime:', this.tokenStats) + '\n\n' +
            assetsLine + '\n' +
            '🧪 VIRTUAL stake: <b>$' + this._regularStake().toFixed(2) + '</b> (flat, simulated) | next trade stake: <b>$' + this.currentStake.toFixed(2) + '</b>\n' +
            sessionLine + '\n' +
            '💼 Lifetime: ' + this.totalTrades + ' trades (✅' + this.totalWins + ' ❌' + this.totalLosses + ') | WR ' + winRateLifetime + '% | P/L <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '🕒 ' + utcTs(),
            'high'
        );
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    async initializeSubscriptions() {
        // Single-active-asset mode: subscribe ONLY to the randomly selected
        // asset this cycle (one ticks_history + one ticks stream) to cut latency.
        const targets = this.config.singleActiveAsset
            ? (this.activeAsset ? [this.activeAsset] : [])
            : this.assets;
        // Ticks are always pulled on the single real connection so both the VIRTUAL
        // phase and a MAIN handover share one live feed.
        const conn = this._act();
        if (!conn || !conn.authorized) {
            logger.warn(`subscriptions skipped — MAIN connection not authorized yet`);
            return;
        }
        console.log(`Initializing [${conn.label}] subscriptions for ${targets.length} asset(s): ${targets.join(', ')}...`);
        for (const asset of targets) {
            await this.subscribeToTickHistory(asset, conn);
            await this.subscribeToTicks(asset, conn);
        }
    }

    async subscribeToTickHistory(asset, conn = this._act()) {
        try {
            const res = await conn._send({
                ticks_history: asset,
                adjust_start_time: 1,
                count: this.config.requiredHistoryLength,
                end: 'latest',
                start: 1,
                style: 'ticks'
            }, 30000);
            if (res && res.history) this.handleTickHistory(asset, res.history);
        } catch (e) {
            console.error(`[${conn.label}] Failed to fetch tick history for ${asset}:`, e.message);
        }
    }

    async subscribeToTicks(asset, conn = this._act()) {
        try {
            const subId = await conn.subscribe({ ticks: asset }, (msg) => {
                if (msg.tick) this.handleTickUpdate(msg.tick);
            });
            this.tickSubscriptionIds[asset] = subId;
            this.tickSubOwners[asset] = conn;
        } catch (e) {
            console.error(`[${conn.label}] Failed to subscribe to ticks for ${asset}:`, e.message);
        }
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;

        // Single-active-asset mode: only the selected asset is subscribed and
        // traded; ignore anything else that might arrive on the wire.
        if (this.config.singleActiveAsset && asset !== this.activeAsset) {
            return;
        }

        const lastDigit = this.getLastDigit(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;

        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        this.digitCounts[asset][lastDigit]++;

        console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);

        // A virtual (simulated) trade settles on the tick AFTER its buy — the
        // exact resolution rule of a 1-tick DIGITDIFF. This runs while a
        // virtual trade is in flight (tradeInProgress is true), so it sits
        // BEFORE the trading guard below.
        if (this.pendingVirtual && this.pendingVirtual.asset === asset) {
            this._settleVirtual(lastDigit, tick);
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return;
        }

        // While a session takeProfit pause is active, do not trade at all.
        if (this.Pause || this.tradeInProgress || this._tpAwaiting) {
            return;
        }

        // Random asset selection: pick a fresh asset from the eligible pool
        // each time (suspended assets excluded). In single-active-asset mode
        // we only ever trade the one asset we subscribed to this cycle.
        const tradeAsset = this.config.singleActiveAsset
            ? this.activeAsset
            : (this.config.randomAssetSelection ? this.pickRandomAsset() : asset);
        if (tradeAsset) this.analyzeTicks(tradeAsset);
    }

    pickRandomAsset() {
        const pool = this.assets.filter(a =>
            !this.suspendedAssets.has(a) &&
            Array.isArray(this.tickHistories[a]) &&
            this.tickHistories[a].length >= this.config.requiredHistoryLength
        );
        if (pool.length) return this._pickAvoidingLastAsset(pool);
        // Everything is suspended — reactivate one so trading can continue.
        if (this.suspendedAssets.size) {
            const revived = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(revived);
            return revived;
        }
        return null;
    }

    // Single-active-asset mode: choose ONE random asset to subscribe to and
    // trade this cycle (no history requirement — we seed history on connect).
    _pickActiveAsset() {
        const pool = this.assets.filter(a => !this.suspendedAssets.has(a));
        if (pool.length) return this._pickAvoidingLastAsset(pool);
        if (this.suspendedAssets.size) {
            const revived = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(revived);
            return revived;
        }
        return this.assets[0] || null;
    }

    // Uniform pick from `pool` that never returns the asset traded last.
    // A pool holding nothing but that asset (single-asset config, or every
    // other asset suspended) makes the rule unsatisfiable, so fall back to a
    // plain random pick rather than stalling the bot.
    _pickAvoidingLastAsset(pool) {
        const fresh = pool.filter(a => a !== this.lastTradedAsset);
        if (fresh.length) {
            if (this.lastTradedAsset) {
                console.log(`🚫 Not repeating last asset: ${this.lastTradedAsset}`);
            }
            return fresh[Math.floor(Math.random() * fresh.length)];
        }
        logger.warn(`only ${this.lastTradedAsset} is tradable — cannot avoid a consecutive asset repeat`);
        return pool[Math.floor(Math.random() * pool.length)];
    }

    analyzeTicks(asset) {
        if (this.tradeInProgress || this._tpAwaiting) {
            return;
        }

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return;
        }

        // Don't analyze suspended assets
        if (this.suspendedAssets.has(asset)) {
            console.log(`Skipping analysis for suspended asset: ${asset}`);
            return;
        }

        const history = this.tickHistories[asset];

        const lastDigit = history[history.length - 1];

        const predictedDigit = this.createRandomPrediction();

        // if(this.sys === 1) {
        //     if((predictedDigit == lastDigit ) || (predictedDigit === lastDigit + 1) || (predictedDigit === lastDigit - 1)) {
        //         this.xDigit = predictedDigit;
        //         this.placeTrade(asset, predictedDigit);
        //     }
        //     else{
        //         console.log(`[${asset}] Skipping trade for digit: ${predictedDigit} | Last Digit: ${lastDigit}`);
        //         this.disconnect();
        //     }
        // }
        // else {
        if ((predictedDigit !== lastDigit) && (predictedDigit !== lastDigit + 1) && (predictedDigit !== lastDigit - 1)) {
            this.xDigit = predictedDigit;
            this.placeTrade(asset, predictedDigit);
        }
        // else
        //     {
        //         console.log(`[${asset}] Skipping trade for digit: ${predictedDigit} | Last Digit: ${lastDigit}`);
        //         this.disconnect();
        //     }
        // }
    }

    // Uniform pick over 0-9 that never repeats the digit traded last. Excluding
    // here (rather than at trade time) also covers ticks where the pick is
    // later rejected by the adjacent-digit filter in analyzeTicks.
    createRandomPrediction() {
        const candidates = [];
        for (let d = 0; d <= 9; d++) {
            if (d !== this.lastTradedDigit) candidates.push(d);
        }
        if (!candidates.length) return crypto.randomInt(0, 10);
        return candidates[crypto.randomInt(0, candidates.length)];
    }

    clearContractPoll() {
        if (this._contractPollTimer) {
            clearTimeout(this._contractPollTimer);
            this._contractPollTimer = null;
        }
    }

    _scheduleContractPoll(contractId) {
        if (this._stopped || !this.client.authorized || this.pendingContractId !== contractId || this.settledContracts.has(contractId)) {
            this.clearContractPoll();
            return;
        }
        this.clearContractPoll();
        this._contractPollTimer = setTimeout(() => {
            this._contractPollTimer = null;
            (async () => {
                try {
                    const res = await this.client._send({ proposal_open_contract: 1, contract_id: contractId }, 15000);
                    const contract = res && res.proposal_open_contract;
                    if (contract) this.handleContractUpdate(contract);
                } catch (e) {
                    console.warn(`Contract #${contractId} poll failed:`, e.message);
                }
                this._scheduleContractPoll(contractId);
            })();
        }, 2000);
    }

    async placeTrade(asset, predictedDigit) {
        if (this.tradeInProgress || this._tpAwaiting) {
            return;
        }

        this.tradeInProgress = true;

        // Pin the executing phase for the lifetime of this trade. The mode only
        // flips on settlement, so the open-contract subscription and the
        // reconcile path always find the ledger that owns the contract.
        const mode = this.tokenMode;

        // The VIRTUAL phase owns no Deriv token — simulate the whole
        // proposal → buy → settlement sequence locally.
        if (mode !== 'MAIN') {
            await this._placeVirtualTrade(asset, mode, predictedDigit);
            return;
        }

        const conn = this.clientFor(mode);
        if (!conn || !conn.authorized) {
            logger.warn(`[${mode}] token not authorized — skipping trade on ${asset}`);
            this.tradeInProgress = false;
            return;
        }

console.log(`[${mode}] 🚀 Placing trade on ${asset} for digit: ${predictedDigit} | Stake: ${this.currentStake.toFixed(2)} | prev trade: ${this.lastTradedAsset ?? '-'}/${this.lastTradedDigit ?? '-'}`);
        try {
            const symbolField = conn.symbolField();
            const proposalRes = await conn._send({
                proposal: 1,
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: this.currency,
                duration: 1,
                duration_unit: 't',
                barrier: predictedDigit.toString(),
                [symbolField]: asset
            }, 15000);

            const proposal = proposalRes && proposalRes.proposal;
            if (!proposal || !proposal.id) {
                throw new Error('No proposal id returned');
            }

            // A buy that never acks leaves the outcome unknown — arm the ack
            // watch BEFORE sending so a slow reply is still adopted or flagged.
            this._beginBuyAck(asset, mode, predictedDigit);
            let buy;
            try {
                const buyRes = await conn._send({
                    buy: proposal.id,
                    price: Number(proposal.ask_price || this.currentStake)
                }, 15000, id => { if (this._pendingBuy) this._pendingBuy.reqId = id; });
                buy = buyRes && buyRes.buy;
                if (!buy || !buy.contract_id) throw new Error('Buy returned no contract_id');
                this._clearBuyAck();
            } catch (e) {
                // Definitive refusals (Deriv error, socket never sent) clear the
                // watch immediately; a pure timeout stays ambiguous so the ack
                // timer can adopt a late reply or flag an orphan.
                if (!this._isAckAmbiguous(e)) this._clearBuyAck();
                throw e;
            }

            console.log(`[${mode}] Trade placed successfully`);
            this.currentTradeId = buy.contract_id;
            this.currentAsset = asset;
            this.tradeTokenMode = mode;
            // Anchor the no-repeat rule to the trade that actually filled —
            // a failed proposal/buy above must not count as a trade.
            this.lastTradedAsset = asset;
            this.lastTradedDigit = predictedDigit;
            this.lastOpenStake = Number(proposal.ask_price || this.currentStake);
            this.lastOpenDigits = (this.tickHistories[asset] || []).slice(-10);
            // Remember the in-flight contract so a restart / network drop can
            // reconcile its result instead of losing it (persisted below).
            this.pendingContractId = this.currentTradeId;
            this.pendingContractAsset = asset;
            this.pendingContractDigit = predictedDigit;
            this.pendingContractMode = mode;
            this._save('trade-open');
            this.sendTradeOpenNotification(asset, predictedDigit, this.lastOpenStake, Number(proposal.payout || 0), mode);
            const subId = await this.subscribeToOpenContract(this.currentTradeId, mode);
            if (subId != null) this._openSubIds.set(String(this.currentTradeId), subId);
            // Watchdog: re-query / force-void any contract that fails to settle.
            this._startTradeWatchdog(this.currentTradeId, mode);
        } catch (e) {
            console.error(`[${mode}] Error placing trade:`, e.message);
            this.tradeInProgress = false;
        }
    }

    async subscribeToOpenContract(contractId) {
        try {
            await this.client.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (msg) => {
                const contract = msg.proposal_open_contract;
                if (contract) this.handleContractUpdate(contract);
            }, 15000);
        } catch (e) {
            console.warn(`Failed to subscribe to open contract #${contractId}:`, e.message);
        }
        // Poll continuously like the web version to ensure we catch settlement
        // even if subscription updates are delayed or missed
        this._scheduleContractPoll(contractId);
    }

    // ── VIRTUAL phase executor ──────────────────────────────────────────
    // A full proposal → buy → settlement round trip, simulated locally so the
    // cadence, latency and failure modes of a real trade stay visible.
    async _placeVirtualTrade(asset, mode, predictedDigit) {
        const stake = this.currentStake;
        const simLatency = (lo, hi) => new Promise(r => setTimeout(r, lo + Math.floor(Math.random() * (hi - lo + 1))));
        try {
            await simLatency(40, 180); // proposal round trip

            const payout = this._virtualPayout(stake);
            if (this.virtualBalance < stake) {
                // Faithful to Deriv's InsufficientBalance: the trade never exists.
                logger.error(`[VIRTUAL] insufficient simulated balance $${this.virtualBalance.toFixed(2)} < stake $${stake.toFixed(2)} on ${asset}`);
                telegram.send(
                    '⚠️ <b>VIRTUAL — INSUFFICIENT SIMULATED BALANCE</b>\n' +
                    'Stake <b>$' + stake.toFixed(2) + '</b> exceeds simulated balance <b>$' + this.virtualBalance.toFixed(2) + '</b>.\n' +
                    'Trading stopped — raise VIRTUAL_START_BALANCE (or edit the state file) to continue.\n' +
                    '🕒 ' + utcTs(), 'high');
                this.stop('virtual balance exhausted');
                return;
            }

            await simLatency(40, 180); // buy round trip

            this.virtualBalance = Number((this.virtualBalance - stake).toFixed(2));
            const contractId = 'V' + (++this._virtualSeq);

            this.currentTradeId = contractId;
            this.currentAsset = asset;
            this.tradeTokenMode = mode;
            this.lastTradedAsset = asset;
            this.lastTradedDigit = predictedDigit;
            this.lastOpenStake = stake;
            this.lastOpenDigits = (this.tickHistories[asset] || []).slice(-10);
            this.pendingContractId = contractId;
            this.pendingContractAsset = asset;
            this.pendingContractDigit = predictedDigit;
            this.pendingContractMode = mode;
            this.pendingVirtual = { id: contractId, asset, digit: predictedDigit, stake, payout, buyAt: Date.now() };
            this._save('virtual-open');

            this.sendTradeOpenNotification(asset, predictedDigit, stake, payout, mode);
            // Settles on the next tick; the watchdog force-voids any stall.
            this._startTradeWatchdog(contractId, mode);
            logger.info(`[VIRTUAL] open #${contractId} ${asset} digit ${predictedDigit} — stake $${stake.toFixed(2)} → payout $${payout.toFixed(2)} | balance $${this.virtualBalance.toFixed(2)}`);
        } catch (e) {
            logger.error(`[VIRTUAL] simulated trade failed:`, e.message);
            this.tradeInProgress = false;
        }
    }

    // The tick that follows a virtual buy settles it — exactly how a 1-tick
    // DIGITDIFF resolves on Deriv. The synthetic contract is shaped like a real
    // proposal_open_contract so the whole result pipeline runs unchanged.
    _settleVirtual(lastDigit, tick) {
        const pv = this.pendingVirtual;
        if (!pv || Date.now() < pv.buyAt) return;
        this.pendingVirtual = null;
        const won = lastDigit !== pv.digit;
        const profit = won ? Number((pv.payout - pv.stake).toFixed(2)) : -pv.stake;
        if (won) this.virtualBalance = Number((this.virtualBalance + pv.payout).toFixed(2));
        const contract = {
            contract_id: pv.id,
            underlying: pv.asset, symbol: pv.asset,
            contract_type: 'DIGITDIFF', barrier: String(pv.digit),
            short_code: 'Digit Differs ' + pv.digit,
            buy_price: pv.stake, stake: pv.stake, currency: this.currency,
            payout: won ? pv.payout : 0, profit,
            status: won ? 'won' : 'lost',
            is_sold: true, is_expired: true,
            exit_tick: tick && Number.isFinite(Number(tick.quote)) ? Number(tick.quote) : undefined,
            simulation: true,
        };
        logger.info(`[VIRTUAL] settle #${pv.id} ${pv.asset} — ${lastDigit} vs ${pv.digit} → ${won ? 'WON' : 'LOST'} ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} | balance $${this.virtualBalance.toFixed(2)}`);
        this.handleContractUpdate(contract);
    }

    // ── STUCK-TRADE WATCHDOG (port of bizWillRF) ────────────────────────
    // A 1-tick DIGITDIFF settles on the very next tick (~1-2s), so this fires
    // at tradeWatchdogMs (10s) — by then the contract is sold. We re-query,
    // poll a few times, then force-void whatever still hasn't settled.
    _startTradeWatchdog(contractId, mode) {
        this._clearWatchdogFor(contractId);
        const key = String(contractId);

        // The in-flight contract is still the one we opened and hasn't settled.
        const stillOpen = () =>
            this.pendingContractId != null &&
            String(this.pendingContractId) === key &&
            !this.settledContracts.has(key);

        const attempt = (n) => {
            if (!stillOpen()) { this._watchdogTimers.delete(key); return; }
            if (n === 0) logger.warn(`⏰ watchdog fired for #${key} (${mode}) — ${(this.config.tradeWatchdogMs / 1000).toFixed(0)}s elapsed`);
            if (mode === 'MAIN') {
                const c = this.clientMain;
                if (!c || !c.authorized) { this._recoverStuckTrade('watchdog-offline', key, mode); return; }
                // One-shot query; a settled response feeds the normal path which
                // clears this timer inside handleTradeResult.
                c._send({ proposal_open_contract: 1, contract_id: contractId }, 15000)
                    .then(r => { const p = r && r.proposal_open_contract; if (p) this.handleContractUpdate(p); })
                    .catch(() => {});
            }
            // VIRTUAL has nothing to query — polling only re-arms; the tick
            // handler settles it (clearing the timer) or force-recovery runs.

            if (n + 1 < this.config.watchdogPolls) {
                const t = setTimeout(() => { this._watchdogTimers.delete(key + ':poll'); attempt(n + 1); }, this.config.watchdogPollGapMs);
                this._watchdogTimers.set(key + ':poll', t);
            } else {
                const t = setTimeout(() => {
                    this._watchdogTimers.delete(key + ':poll');
                    if (!stillOpen()) return;
                    logger.error(`watchdog: ${this.config.watchdogPolls} polls exhausted for #${key} — forcing void`);
                    this._recoverStuckTrade('watchdog-timeout', key, mode);
                }, this.config.watchdogPollGapMs);
                this._watchdogTimers.set(key + ':poll', t);
            }
        };

        this._watchdogTimers.set(key, setTimeout(() => attempt(0), this.config.tradeWatchdogMs));
    }

    _clearWatchdogFor(contractId) {
        if (contractId == null) return;
        const key = String(contractId);
        for (const k of [key, key + ':poll']) {
            const t = this._watchdogTimers.get(k);
            if (t) { clearTimeout(t); this._watchdogTimers.delete(k); }
        }
    }

    _clearAllWatchdogTimers() {
        for (const t of this._watchdogTimers.values()) { try { clearTimeout(t); } catch (_) { } }
        this._watchdogTimers.clear();
    }

    // Force-recover a trade that never settled. Outcome is UNKNOWN, so — by
    // design — nothing is recorded: the martingale ladder and every P/L counter
    // stay exactly where they were (diverges from bizWillRF's assumed loss).
    // The real MAIN balance WAS debited by Deriv; voiding simply refuses to
    // guess, and the alert carries the exact numbers to reconcile by hand.
    _recoverStuckTrade(reason, contractId, mode) {
        const key = String(contractId);
        logger.warn(`stuck trade recovery (${reason}): voiding #${key} on ${mode}`);
        this._clearWatchdogFor(key);

        this._forgetOpenSub(key);

        // Block any late real settlement from being counted (the late-settlement
        // guard in handleContractUpdate still surfaces it loudly).
        this.settledContracts.add(key);

        const wasVirtual = mode !== 'MAIN';
        const stake = this.pendingVirtual ? this.pendingVirtual.stake
            : (Number(this.lastOpenStake) || this.currentStake || 0);
        const asset = this.pendingContractAsset || this.currentAsset || '?';
        const digit = this.pendingContractDigit != null
            ? this.pendingContractDigit
            : (this.pendingVirtual ? this.pendingVirtual.digit : this.lastTradedDigit);

        // VIRTUAL refunds the stake into its simulated ledger — nothing real
        // happened, so parity is restored. MAIN has no local ledger to refund.
        if (wasVirtual && Number.isFinite(this.virtualBalance) && stake > 0) {
            this.virtualBalance = Number((this.virtualBalance + stake).toFixed(2));
        }

        this.stuckTrades.push({
            contractId: key, mode: wasVirtual ? 'VIRTUAL' : 'MAIN', asset, digit,
            stake, reason, refunded: wasVirtual, time: Date.now(),
        });
        if (this.stuckTrades.length > 50) this.stuckTrades = this.stuckTrades.slice(-50);

        this.pendingContractId = null;
        this.pendingContractAsset = null;
        this.pendingContractDigit = null;
        this.pendingContractMode = null;
        this.pendingVirtual = null;
        this.currentTradeId = null;
        this.tradeInProgress = false;
        this._save('stuck-void');
        this._sendStuckAlert(reason, key, wasVirtual, asset, digit, stake);

        if (!this._stopped && !this.endOfDay && !this._tpAwaiting) {
            const wait = this._randomWaitMs();
            logger.warn(`stuck recovery — resuming in ${(wait / 1000).toFixed(0)}s`);
            setTimeout(() => this._startNextTradeCycle().catch(e => logger.error('cycle retry:', e.message)), wait);
        }
    }

    _forgetOpenSub(contractId) {
        const key = String(contractId);
        const subId = this._openSubIds.get(key);
        this._openSubIds.delete(key);
        if (subId == null) return;
        const c = this.clientMain;
        if (c) { try { c.forget(subId).catch(() => {}); } catch (_) { } }
    }

    _sendStuckAlert(reason, contractId, wasVirtual, asset, digit, stake) {
        telegram.send(
            '⚠️ <b>STUCK TRADE VOIDED [' + reason + ']</b>\n' +
            'Contract: <code>#' + contractId + '</code> (' + asset + ' d' + (digit != null ? digit : '?') + ' $' + stake.toFixed(2) + ')\n' +
            'Phase: ' + (wasVirtual ? '🧪 VIRTUAL' : '💰 MAIN') + '\n' +
            (wasVirtual
                ? '✔ Stake refunded to the simulated balance $' + Number(this.virtualBalance).toFixed(2) + '.\n'
                : '✖ The real MAIN balance was debited by Deriv — NOT accounted locally.\n') +
            '⚠️ Outcome UNKNOWN — VERIFY ON DERIV.\n' +
            'Ladder and P/L counters unchanged (voided, not counted as a loss).\n' +
            '🕒 ' + utcTs(), 'high');
    }

    _randomWaitMs() {
        const lo = Number(this.config.minWaitTime) || 0;
        const hi = Math.max(lo, Number(this.config.maxWaitTime) || lo);
        if (!(hi > lo)) return lo;
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    }

    // ── BUY-ACK WATCH (port of bizWillRF) ───────────────────────────────
    // The buy request can time out while Deriv actually created a contract.
    // This watch keeps that ambiguity alive past the request's own timeout;
    // handleUnsolicitedMessage adopts a late reply, and _onAckTimeout flags an
    // orphan for manual verification on Deriv.
    _beginBuyAck(asset, mode, digit) {
        this._clearBuyAck();
        const token = ++this._buyAckSeq;
        this._pendingBuy = { token, reqId: null, asset, mode, digit, stake: this.currentStake, startedAt: Date.now() };
        const timer = setTimeout(() => this._onAckTimeout(token), this.config.buyAckMs);
        this._watchdogTimers.set('ack:' + token, timer);
    }

    _clearBuyAck() {
        if (this._pendingBuy == null) return;
        const t = this._watchdogTimers.get('ack:' + this._pendingBuy.token);
        if (t) { clearTimeout(t); this._watchdogTimers.delete('ack:' + this._pendingBuy.token); }
        this._pendingBuy = null;
    }

    // True only when we genuinely don't know whether Deriv created a contract:
    // a request timeout. Deriv error replies and transport rejects are certain.
    _isAckAmbiguous(e) {
        return !!e && !e.apiError && /timeout/i.test(String(e.message));
    }

    _onAckTimeout(token) {
        this._watchdogTimers.delete('ack:' + token);
        const pb = this._pendingBuy;
        if (!pb || pb.token !== token) return;
        this._pendingBuy = null;
        logger.error(`BUY ACK TIMEOUT after ${(this.config.buyAckMs / 1000).toFixed(0)}s (${pb.asset}) — ${pb.reqId ? 'req ' + pb.reqId + ' ' : ''}no contract_id received`);
        telegram.send(
            '⚠️ <b>BUY ACK TIMEOUT</b>\n' +
            'No buy response in ' + (this.config.buyAckMs / 1000).toFixed(0) + 's (req ' + (pb.reqId || '?') + ')\n' +
            'Asset: <code>' + htmlEscape(pb.asset) + '</code> | Phase: 💰 MAIN | Stake: $' + Number(pb.stake || 0).toFixed(2) + '\n' +
            '⚠️ VERIFY ON DERIV that no contract was created for this request.\n' +
            'Nothing accounted locally. Next trade cycle continues.\n' +
            '🕒 ' + utcTs(), 'high');
        this.tradeInProgress = false;
        if (!this._stopped && !this.endOfDay && !this._tpAwaiting) {
            const wait = this._randomWaitMs();
            logger.warn(`buy-ack timeout — resuming in ${(wait / 1000).toFixed(0)}s`);
            setTimeout(() => this._startNextTradeCycle().catch(e => logger.error('cycle retry:', e.message)), wait);
        }
    }

    // Handles messages no longer matched by an in-flight request (DerivClient
    // drops them from _pending the moment a request times out). A late `buy`
    // success for our own req is adopted so the contract gets tracked.
    handleUnsolicitedMessage(msg) {
        if (!msg || !msg.buy || !msg.buy.contract_id) return;
        const pb = this._pendingBuy;
        const reqId = msg.echo_req && msg.echo_req.req_id;
        if (!pb) {
            logger.error(`UNTRACKED CONTRACT ${msg.buy.contract_id} — buy success with no pending ack state. VERIFY/MANAGE ON DERIV MANUALLY.`);
            telegram.send(
                '🚨 <b>UNTRACKED CONTRACT ' + msg.buy.contract_id + '</b>\n' +
                'Buy succeeded with no tracked position (price $' + (msg.buy.buy_price != null ? msg.buy.buy_price : '?') + ')\n' +
                'Bot is NOT tracking it — manage/close it ON DERIV MANUALLY.\n' +
                '🕒 ' + utcTs(), 'high');
            this._subscribeUntracked(msg.buy.contract_id);
            return;
        }
        if (pb.reqId != null && reqId != null && String(pb.reqId) !== String(reqId)) return;
        if (this.pendingContractId != null || this.tradeInProgress) {
            logger.error(`LATE BUY ack ${msg.buy.contract_id} but another trade is open (pending #${this.pendingContractId}) — NOT adopting. VERIFY ON DERIV.`);
            telegram.send('🚨 <b>LATE BUY ACK NOT ADOPTED</b> #' + msg.buy.contract_id + '\nAnother trade is open — manage this contract ON DERIV MANUALLY.', 'high');
            this._clearBuyAck();
            return;
        }
        // Adopt: this is the contract our timed-out buy actually created.
        logger.info(`LATE BUY ack #${msg.buy.contract_id} adopted (req ${reqId}) — tracking`);
        this._clearBuyAck();
        this.tradeInProgress = true;
        this.currentTradeId = msg.buy.contract_id;
        this.currentAsset = pb.asset;
        this.tradeTokenMode = pb.mode;
        this.lastTradedAsset = pb.asset;
        this.lastTradedDigit = pb.digit;
        this.lastOpenStake = Number(msg.buy.buy_price) || pb.stake;
        this.lastOpenDigits = (this.tickHistories[pb.asset] || []).slice(-10);
        this.pendingContractId = this.currentTradeId;
        this.pendingContractAsset = pb.asset;
        this.pendingContractDigit = pb.digit;
        this.pendingContractMode = pb.mode;
        this._save('late-buy-ack');
        this.sendTradeOpenNotification(pb.asset, pb.digit, this.lastOpenStake, Number(msg.buy.payout || 0), pb.mode);
        this._subscribeUntracked(msg.buy.contract_id, pb.mode);
        this._startTradeWatchdog(msg.buy.contract_id, pb.mode);
        telegram.send('ℹ️ <b>LATE BUY ACK — adopted</b> #' + msg.buy.contract_id + ' on ' + htmlEscape(pb.asset) + ' ($' + this.lastOpenStake.toFixed(2) + '). Tracking now.', 'high');
    }

    _subscribeUntracked(contractId, mode) {
        const c = this.clientMain;
        if (!c) return Promise.resolve();
        return this.subscribeToOpenContract(contractId, mode || 'MAIN').catch(() => {});
    }

    // A contract we force-voided earlier must NEVER be double-counted — the
    // void stands and the actual outcome is surfaced loudly for reconcile.
    // handleContractUpdate(contract) {
    //     const contractId = contract.contract_id;
    //     const cid = String(contractId);

    //     const stuck = this.stuckTrades.find(s => String(s.contractId) === cid);
    //     if (stuck) {
    //         const won = contract.status === 'won';
    //         const profit = Number(contract.profit);
    //         const profitFinite = Number.isFinite(profit);
    //         logger.error(`LATE SETTLEMENT #${cid}: actual ${won ? 'WIN' : 'LOSS'} but it was VOIDED on ${stuck.mode} — not double-counted`);
    //         telegram.send(
    //             '🚨 <b>LATE SETTLEMENT #' + cid + '</b> (' + stuck.mode + ')\n' +
    //             'Actual: ' + (won
    //                 ? '✅ WIN +$' + (profitFinite ? profit.toFixed(2) : '?')
    //                 : '❌ LOSS') + ' | Accounted: VOIDED locally (stake $' + Number(stuck.stake || 0).toFixed(2) + ')\n' +
    //             (won
    //                 ? 'ACTION: payout never credited — ' + (stuck.refunded
    //                     ? 'the virtual ledger already refunded the stake.'
    //                     : 'manually add $' + (profitFinite ? profit.toFixed(2) : '?') + ' to the MAIN balance or reset the ledger.') + '\n'
    //                 : 'Matches the void — no action needed.\n') +
    //             'Audit entry kept.\n' +
    //             '🕒 ' + utcTs(), 'high');
    //         this._forgetOpenSub(cid);
    //         return;
    //     }

    //     if (contract.is_sold && !this.settledContracts.has(contractId)) {
    //         this.settledContracts.add(contractId);
    //         if (this.settledContracts.size > 5000) {
    //             const first = this.settledContracts.values().next().value;
    //             this.settledContracts.delete(first);
    //         }
    //         this.handleTradeResult(contract);
    //     }
    // }

    handleContractUpdate(contract) {
        const contractId = contract.contract_id;
        if (this.pendingContractId && String(contractId) !== String(this.pendingContractId)) {
            return;
        }
        if (contract.is_sold && !this.settledContracts.has(contractId)) {
            this.clearContractPoll();
            this.settledContracts.add(contractId);
            if (this.settledContracts.size > 5000) {
                const first = this.settledContracts.values().next().value;
                this.settledContracts.delete(first);
            }
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        // Trade resolved — the watchdog (and any open subscription) is done.
        this._clearWatchdogFor(contract.contract_id);
        this._forgetOpenSub(contract.contract_id);

        const asset = this.currentAsset || contract.underlying || contract.symbol;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        // The token this trade actually executed on — recorded at buy time, so a
        // mode switch triggered by this very result can't relabel it.
        const mode = this.tradeTokenMode || this.tokenMode;

        console.log(`[${mode}][${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            // A win always ends the chain: any MAIN ladder collapses and trading
            // goes back to the flat-stake VIRTUAL phase.
            this._applyResultStake(mode, true);
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Suspend the asset after a loss
            // this.suspendAsset(asset);

            if (this.sys === 1) {
                this.sys = 2;
            } else {
                this.sys = 1;
            }

            this._applyResultStake(mode, false);
        }

        this.totalProfitLoss += profit;
        this.todayPnL += profit;
        this.Pause = true;

        // ── session tracking + durable checkpoint ───────────────────────
        this._sessionPL += profit;
        this._sessionTrades++;
        this._trackDaily(asset, contract, won, profit, mode);
        // Contract settled — clear the in-flight marker and persist the result
        // so a restart/network drop never loses this trade.
        this.pendingContractId = null;
        this.pendingContractAsset = null;
        this.pendingContractDigit = null;
        this.pendingContractMode = null;
        this._save('after-trade');
        // Contract settled — clear the in-flight marker and persist the result
        // so a restart/network drop never loses this trade.
        this.clearContractPoll();

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        this.sendTradeResultNotification(asset, contract, won, profit, mode);

        this.logTradingSummary(asset);

        // If there are suspended assets, reactivate the first one on win
        if (this.suspendedAssets.size > 1) {
            const firstSuspendedAsset = Array.from(this.suspendedAssets)[0];
            this.reactivateAsset(firstSuspendedAsset);
        }

        // Suspend the asset after a trade — optional (SUSPEND_AFTER_TRADE).
        if (this.config.suspendAssetAfterTrade) {
            this.suspendAsset(asset);
        }

        if (this._stopConditionHit()) {
            console.log('Stop condition reached. Stopping trading.');
            this.stopTrading();
            return;
        }

        // Session takeProfit: pause with a random cooldown, then start a new
        // session. Lifetime P/L is never reset by a session rollover.
        if (this.config.takeProfit > 0 && this._sessionPL >= this.config.takeProfit) {
            console.log(`Session takeProfit hit — session #${this._sessionNum} P/L ${this._sessionPL.toFixed(2)}. Pausing.`);
            this.sendTelegramSummary();
            this._pauseForTakeProfit();
            this.unsubscribeAllTicks();
            return;
        }

        if (!this.endOfDay) {
            const nextTradeAfter = randomWaitTime;
            console.log(`Waiting ${(nextTradeAfter / 1000).toFixed(0)}s before selecting the next asset...`);
            setTimeout(() => this._startNextTradeCycle(), nextTradeAfter);
        }
    }

    // ── Stake / token-mode transition ─────────────────────────────────
    // DUAL PHASE: the VIRTUAL phase (state key "REGULAR") is pinned flat. Only
    // once the loss streak on VIRTUAL trips lossesBeforeMainSwitch do we hand
    // over to MAIN, from where the martingale ladder climbs per further loss
    // until a win resets everything.
    _applyResultStake(mode, won) {
        if (!this._dualTokenEnabled()) {
            // Legacy single-token behaviour: martingale from the very first loss.
            if (won) {
                this.tokenMode = 'REGULAR';
                this.tokenLossStreak = 0;
                this.martingaleLevel = 0;
                this.currentStake = this._regularStake();
            } else {
                this.martingaleLevel = (this.martingaleLevel || 0) + 1;
                this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
            }
            return;
        }

        if (won) {
            const wasMain = mode === 'MAIN';
            this.tokenMode = 'REGULAR';
            this.tokenLossStreak = 0;
            this.martingaleLevel = 0;
            this.currentStake = this._regularStake();
            if (wasMain) {
                const t = this.tokenStats.MAIN;
                logger.warn(`[dual-phase] MAIN ladder resolved — back to VIRTUAL at $${this.currentStake.toFixed(2)} (MAIN: ${t.trades}t ${t.netPL >= 0 ? '+' : ''}$${t.netPL.toFixed(2)})`);
                telegram.send(
                    '✅ <b>DUAL PHASE — BACK TO VIRTUAL</b>\n' +
                    this._tokenBadge('MAIN') + '\n' +
                    this._tokenBadge('REGULAR') + '\n\n' +
                    'MAIN martingale ladder cleared on a win.\n' +
                    this._tokenBlock('Per-token session:', this._sessionTokenStats) + '\n' +
                    '▶ ' + this._sessionLine() + '\n' +
                    '💼 Lifetime P/L: <b>' + (this.totalProfitLoss >= 0 ? '+' : '') + this.totalProfitLoss.toFixed(2) + '</b>\n' +
                    '🕒 ' + utcTs(),
                    'high'
                );
            }
            return;
        }

        // ── loss ──
        if (mode === 'MAIN') {
            // Already on MAIN: climb one rung. This is the only place the
            // martingale multiplier is ever applied.
            this.martingaleLevel = (this.martingaleLevel || 0) + 1;
            this.currentStake = this._mainStake(this.martingaleLevel);
            logger.warn(`[dual-token] MAIN loss → ladder L${this.martingaleLevel}, next stake $${this.currentStake.toFixed(2)}`);
            return;
        }

        // REGULAR loss: flat stake, and count towards the MAIN handover.
        this.tokenLossStreak = (this.tokenLossStreak || 0) + 1;
        const threshold = Math.max(1, Number(this.config.lossesBeforeMainSwitch) || 1);
        if (this.tokenLossStreak >= threshold) {
            this.tokenMode = 'MAIN';
            this.martingaleLevel = 0; // MAIN opens at its own base, ladder builds from here
            this.currentStake = this._mainStake(0);
            logger.warn(`[dual-phase] SWITCH → MAIN after ${this.tokenLossStreak} consecutive VIRTUAL losses (threshold ${threshold}). First MAIN stake $${this.currentStake.toFixed(2)}`);
            telegram.send(
                '🔁 <b>DUAL PHASE — SWITCHING TO MAIN</b>\n' +
                this.tokenLossStreak + ' consecutive losses on VIRTUAL (threshold ' + threshold + ')\n\n' +
                this._tokenBadge('REGULAR') + '\n' +
                this._tokenBadge('MAIN') + '\n\n' +
                '💰 MAIN martingale starts at <b>L0 $' + this._mainStake(0).toFixed(2) + '</b> (own base stake), multiplier <b>x' + this.config.multiplier + '</b> per loss\n' +
                '🪜 Ladder cap: <b>L' + (Math.max(0, this.config.maxConsecutiveLosses - 1)) + '</b> (bot stops there)\n' +
                '↩️ Any MAIN win returns trading to VIRTUAL at flat $' + this._regularStake().toFixed(2) + '\n' +
                '🕒 ' + utcTs(),
                'high'
            );
        } else {
            // REGULAR never escalates — the martingale hazard is level 0.
            this.currentStake = this._regularStake();
            logger.info(`[dual-phase] VIRTUAL loss ${this.tokenLossStreak}/${threshold} — stake stays flat $${this.currentStake.toFixed(2)}`);
        }
    }

    // maxConsecutiveLosses now caps the MAIN ladder (L0..L{max-1}) rather than a
    // raw loss streak, so the REGULAR phase cannot trip it before the handover.
    // Lifetime stopLoss stays an aggregate guard across both tokens.
    _stopConditionHit() {
        if (this.totalProfitLoss <= -this.config.stopLoss) return true;
        if (!this._dualTokenEnabled()) return this.consecutiveLosses >= this.config.maxConsecutiveLosses;
        return this.martingaleLevel >= Math.max(1, Number(this.config.maxConsecutiveLosses) || 1);
    }

    async _startNextTradeCycle() {
        if (this._stopped || this.endOfDay || this._tpAwaiting) return;

        // The real connection that feeds the next trade may not have finished
        // connecting (e.g. right after a VIRTUAL → MAIN handover). Hold the
        // stake, don't burn the cycle, and retry.
        const conn = this._act();
        if (!conn || !conn.authorized) {
            logger.warn(`🔌 MAIN connection not authorized yet — next trade deferred, retrying in 15s (stake parked at $${this.currentStake.toFixed(2)})`);
            setTimeout(() => this._startNextTradeCycle().catch(e => logger.error('cycle retry:', e.message)), 15000);
            return;
        }

        this.tradeInProgress = true;
        await this.unsubscribeAllTicks();

        if (this.config.singleActiveAsset) {
            this.activeAsset = this._pickActiveAsset();
            console.log(`🎲 Next trade asset (random pick per trade): ${this.activeAsset}`);
        }

        await this.initializeSubscriptions();
        this.tradeInProgress = false;
        this.Pause = false;
    }

    // Add new method to handle asset suspension
    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`✅ Reactivated asset: ${asset}`);
    }

    // ── Session takeProfit: random cooldown, then a fresh session ───────
    _randomCooldownMs() {
        const min = Math.max(0, Number(this.config.takeProfitCooldownMinMs) || 0);
        const max = Math.max(min, Number(this.config.takeProfitCooldownMaxMs) || min);
        if (!(max > min)) return min;
        return min + Math.floor(Math.random() * (max - min + 1));
    }

    _sessionLine() {
        const target = this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : '∞';
        return '🚀 Session #' + this._sessionNum + ': $' + this._sessionPL.toFixed(2) + ' / ' + target;
    }

    _pauseForTakeProfit() {
        if (this._tpAwaiting) return;
        this._tpAwaiting = true;
        const cooldownMs = this._randomCooldownMs();
        this._tpPauseUntil = Date.now() + cooldownMs;
        const mins = Math.max(1, Math.round(cooldownMs / 60000));
        logger.warn(`session takeProfit ${this.config.takeProfit} hit — session #${this._sessionNum} paused for ${mins} min (random)`);
        telegram.send(
            '🎯 <b>SESSION TAKE PROFIT HIT</b> — Session #' + this._sessionNum + '\n\n' +
            'Session P/L: <b>$' + this._sessionPL.toFixed(2) + '</b> (target $' + this.config.takeProfit.toFixed(2) + ')\n' +
            'Trades this session: ' + this._sessionTrades + '\n' +
            this._tokenBlock('Session per token:', this._sessionTokenStats) + '\n\n' +
            this._tokenPolicyLine() + '\n' +
            '💼 Lifetime P/L: <b>$' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            this._tokenBlock('Lifetime per token:', this.tokenStats) + '\n\n' +
            '⏸ Trading paused until <b>' + new Date(this._tpPauseUntil).toUTCString() + '</b> (~' + mins + ' min, random cooldown)\n' +
            '🕒 ' + utcTs(),
            'high'
        );
        this._save('tp-pause');
    }

    _checkTpResume() {
        if (this._tpAwaiting && Date.now() >= this._tpPauseUntil) this._startNewSession('timer');
    }

    _startNewSession(reason = 'cooldown elapsed') {
        if (!this._tpAwaiting) return;
        this._sessionNum++;
        this._sessionStartAt = Date.now();
        this._sessionStartBal = this._totalBalance();
        this._sessionPL = 0;
        this._sessionTrades = 0;
        this._sessionTokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        this._tpAwaiting = false;
        this._tpPauseUntil = 0;
        logger.warn(`takeProfit cooldown over — new session #${this._sessionNum} started (${reason})`);
        telegram.send(
            '🚀 <b>NEW SESSION #' + this._sessionNum + '</b>\n\n' +
            'takeProfit cooldown ended (' + reason + '). Trading resumes — session P/L reset.\n' +
            'Start balance: <b>$' + (this._sessionStartBal || 0).toFixed(2) + '</b> | Target: ' +
            (this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : '∞') + '\n' +
            this._tokenPolicyLine() + '\n' +
            this._tokenBlock('Session per token:', this._sessionTokenStats) + '\n' +
            '💼 Lifetime P/L carried over: <b>$' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '🕒 ' + utcTs(),
            'high'
        );
        this._save('session-start');
        this._startNextTradeCycle().catch(e => {
            this.tradeInProgress = false;
            logger.error('next session setup:', e.message);
        });
    }

    // ── Reconcile a contract left open across a restart / network drop ──
    async _reconcilePendingContract() {
        const cid = this.pendingContractId;
        if (!cid || this.settledContracts.has(cid)) return;

        // A VIRTUAL contract has no Deriv counterpart — if this process is still
        // alive (pendingVirtual set) the next tick settles it and we're done.
        // But after a process restart the in-flight simulated trade died with us:
        // restart policy is VOID + refund the stake (never fabricate a result).
        if (this.pendingContractMode != null && this.pendingContractMode !== 'MAIN') {
            if (this.pendingVirtual) return;
            logger.warn(`reconcile #${cid}: in-flight VIRTUAL trade from a previous run — voiding & refunding stake`);
            this._recoverStuckTrade('restart-void', cid, 'REGULAR');
            return;
        }

        // Always query on the connection that owns the contract, not the one
        // currently trading — after a handover the two are different accounts.
        const mode = this.pendingContractMode || this.tradeTokenMode || 'MAIN';
        const conn = this.clientFor(mode);
        if (!conn || !conn.authorized) {
            logger.warn(`reconcile #${cid} deferred — ${mode} token not authorized`);
            return;
        }
        logger.info(`reconcile pending contract #${cid} on ${mode} after (re)connect`);
        try {
            const res = await conn._send({ proposal_open_contract: 1, contract_id: cid }, 15000);
            const c = res && res.proposal_open_contract;
            if (c && c.is_sold) {
                this.currentAsset = this.pendingContractAsset || this.currentAsset;
                if (this.pendingContractDigit != null) this.xDigit = this.pendingContractDigit;
                this.tradeTokenMode = mode;
                this.handleContractUpdate(c);
                return;
            }
            if (c) {
                this.currentAsset = this.pendingContractAsset || this.currentAsset;
                this.tradeTokenMode = mode;
                await this.subscribeToOpenContract(cid, mode);
                // Keep the watchdog running on the contract (no-op re-arm) so a
                // contract that lives past the poll window is still force-voided.
                this._startTradeWatchdog(cid, mode);
            }
            // Unconfirmed — keep pendingContractId so a later reconnect retries.
        } catch (e) {
            logger.warn(`reconcile #${cid} failed:`, e.message);
        }
    }

    // ── State persistence — survive restart / server & network drops ────
    _save(reason) {
        try {
            const f = this.stateFile, tmp = f + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({
                version: 3, savedAt: new Date().toISOString(), reason,
                totalTrades: this.totalTrades, totalWins: this.totalWins, totalLosses: this.totalLosses,
                consecutiveLosses: this.consecutiveLosses,
                consecutiveLosses2: this.consecutiveLosses2, consecutiveLosses3: this.consecutiveLosses3,
                consecutiveLosses4: this.consecutiveLosses4, consecutiveLosses5: this.consecutiveLosses5,
                totalProfitLoss: this.totalProfitLoss, currentStake: this.currentStake,
                todayPnL: this.todayPnL,
                // ── dual token ──
                tokenMode: this.tokenMode,
                tradeTokenMode: this.tradeTokenMode,
                tokenLossStreak: this.tokenLossStreak,
                martingaleLevel: this.martingaleLevel,
                tokenStats: this.tokenStats,
                sessionTokenStats: this._sessionTokenStats,
                suspendedAssets: Array.from(this.suspendedAssets),
                settledContracts: Array.from(this.settledContracts).slice(-1000),
                dailyStats: this.dailyStats,
                hourlyStats: this.hourlyStats,
                startBalance: this.startBalance,
                lastBalance: {
                    VIRTUAL: this.virtualBalance,
                    MAIN: this.clientMain ? this.clientMain.balance : null,
                },
                // ── v3 virtual ledger + audit ──
                virtualBalance: this.virtualBalance,
                virtualSeq: this._virtualSeq,
                stuckTrades: this.stuckTrades,
                lastOpenStake: this.lastOpenStake,
                sessionNum: this._sessionNum, sessionStartAt: this._sessionStartAt,
                sessionStartBal: this._sessionStartBal, sessionPL: this._sessionPL,
                sessionTrades: this._sessionTrades,
                tpAwaiting: this._tpAwaiting, tpPauseUntil: this._tpPauseUntil,
                pendingContractId: this.pendingContractId,
                pendingContractAsset: this.pendingContractAsset,
                pendingContractDigit: this.pendingContractDigit,
                pendingContractMode: this.pendingContractMode,
                lastTradedAsset: this.lastTradedAsset,
                lastTradedDigit: this.lastTradedDigit,
            }, null, 2));
            fs.renameSync(tmp, f);
        } catch (e) { logger.warn('save state:', e.message); }
    }

    _loadState() {
        const f = this.stateFile;
        if (!fs.existsSync(f)) return;
        try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (Number.isFinite(Number(d.totalTrades))) this.totalTrades = Number(d.totalTrades);
            if (Number.isFinite(Number(d.totalWins))) this.totalWins = Number(d.totalWins);
            if (Number.isFinite(Number(d.totalLosses))) this.totalLosses = Number(d.totalLosses);
            if (Number.isFinite(Number(d.consecutiveLosses))) this.consecutiveLosses = Number(d.consecutiveLosses);
            if (Number.isFinite(Number(d.consecutiveLosses2))) this.consecutiveLosses2 = Number(d.consecutiveLosses2);
            if (Number.isFinite(Number(d.consecutiveLosses3))) this.consecutiveLosses3 = Number(d.consecutiveLosses3);
            if (Number.isFinite(Number(d.consecutiveLosses4))) this.consecutiveLosses4 = Number(d.consecutiveLosses4);
            if (Number.isFinite(Number(d.consecutiveLosses5))) this.consecutiveLosses5 = Number(d.consecutiveLosses5);
            if (Number.isFinite(Number(d.totalProfitLoss))) this.totalProfitLoss = Number(d.totalProfitLoss);
            if (Number.isFinite(Number(d.todayPnL))) this.todayPnL = Number(d.todayPnL);
            if (Array.isArray(d.suspendedAssets)) this.suspendedAssets = new Set(d.suspendedAssets);
            if (Array.isArray(d.settledContracts)) this.settledContracts = new Set(d.settledContracts);
            if (d.dailyStats && typeof d.dailyStats === 'object') this.dailyStats = d.dailyStats;
            if (d.hourlyStats && typeof d.hourlyStats === 'object') this.hourlyStats = d.hourlyStats;
            if (d.startBalance != null) this.startBalance = Number(d.startBalance);

            // ── dual-phase restore ──
            // A saved MAIN mode restores as MAIN; anything else is the VIRTUAL
            // phase (the old REGULAR key is kept on disk for compatibility).
            this.tokenMode = d.tokenMode === 'MAIN' ? 'MAIN' : 'REGULAR';
            this.tradeTokenMode = d.tradeTokenMode === 'MAIN' ? 'MAIN' : 'REGULAR';
            this.tokenLossStreak = Math.max(0, Number(d.tokenLossStreak) || 0);
            this.martingaleLevel = Math.max(0, Number(d.martingaleLevel) || 0);
            this.tokenStats = this._mergeTokenStats(d.tokenStats);
            this._sessionTokenStats = this._mergeTokenStats(d.sessionTokenStats);
            // Stake is derived from the mode, never trusted from disk: VIRTUAL is
            // always flat and MAIN always rebuilds from its own base + ladder.
            if (this.tokenMode === 'MAIN') this.currentStake = this._mainStake(this.martingaleLevel);
            else { this.martingaleLevel = 0; this.currentStake = this._regularStake(); }

            // ── v3: virtual ledger + audit trails ──
            if (Number.isFinite(Number(d.virtualBalance))) this.virtualBalance = Number(d.virtualBalance);
            if (Number.isFinite(Number(d.virtualSeq)) && d.virtualSeq > 0) this._virtualSeq = Number(d.virtualSeq);
            if (Array.isArray(d.stuckTrades)) this.stuckTrades = d.stuckTrades.slice(-50);
            if (Number.isFinite(Number(d.lastOpenStake)) && d.lastOpenStake > 0) this.lastOpenStake = Number(d.lastOpenStake);

            // Daily/hourly buckets from a pre-dual-token state file have no
            // per-token rollups — backfill empty ones so reads never hit undefined.
            for (const store of [this.dailyStats, this.hourlyStats]) {
                for (const k of Object.keys(store)) {
                    const b = store[k];
                    if (b && typeof b === 'object' && !b.tokenStats) b.tokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
                }
            }

            if (Number.isFinite(Number(d.sessionNum))) this._sessionNum = Math.max(1, Number(d.sessionNum));
            if (Number.isFinite(Number(d.sessionStartAt))) this._sessionStartAt = Number(d.sessionStartAt);
            this._sessionStartBal = Number(d.sessionStartBal || 0);
            this._sessionPL = Number(d.sessionPL || 0);
            this._sessionTrades = Number(d.sessionTrades || 0);
            this._tpAwaiting = !!d.tpAwaiting;
            this._tpPauseUntil = Number(d.tpPauseUntil || 0);
            this.pendingContractId = d.pendingContractId || null;
            this.pendingContractAsset = d.pendingContractAsset || null;
            this.pendingContractDigit = d.pendingContractDigit != null ? Number(d.pendingContractDigit) : null;
            this.pendingContractMode = d.pendingContractMode === 'MAIN' ? 'MAIN' : 'REGULAR';
            // Restored so the very first trade after a restart/reconnect still
            // honours the no-repeat rule.
            this.lastTradedAsset = this.assets.includes(d.lastTradedAsset) ? d.lastTradedAsset : null;
            this.lastTradedDigit = typeof d.lastTradedDigit === 'number' && Number.isInteger(d.lastTradedDigit)
                ? d.lastTradedDigit : null;
            logger.info(
                `state restored: ${this.totalTrades} trades (✅${this.totalWins} ❌${this.totalLosses}) | ` +
                `P/L $${this.totalProfitLoss.toFixed(2)} | next stake $${this.currentStake.toFixed(2)} | ` +
                `token=${this.tokenMode}${this.tokenMode === 'MAIN' ? ' L' + this.martingaleLevel : ''} ` +
                `virtualStreak=${this.tokenLossStreak}/${this.config.lossesBeforeMainSwitch} | ` +
                `${this._sessionLine()} | tpPause=${this._tpAwaiting}` +
                (this._tpAwaiting ? ' until ' + new Date(this._tpPauseUntil).toUTCString() : '') +
                (this.pendingContractId ? ` | pending #${this.pendingContractId} (${this.pendingContractMode})` : '')
            );
        } catch (e) { logger.warn('load state:', e.message); }
    }

    // Accepts a persisted per-token rollup and fills any missing token/field so
    // every downstream reader can treat the shape as complete.
    _mergeTokenStats(src) {
        const out = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        if (!src || typeof src !== 'object') return out;
        for (const m of ['REGULAR', 'MAIN']) {
            const s = src[m];
            if (!s || typeof s !== 'object') continue;
            const t = out[m];
            t.trades = Number(s.trades) || 0;
            t.wins = Number(s.wins) || 0;
            t.losses = Number(s.losses) || 0;
            t.profit = Number(s.profit) || 0;
            t.loss = Number(s.loss) || 0;
            t.netPL = Number(s.netPL) || 0;
            t.stakes = Number(s.stakes) || 0;
            t.list = Array.isArray(s.list) ? s.list.slice(-50) : [];
        }
        return out;
    }

    stop(sig = 'shutdown') {
        if (this._stopped) return;
        this._stopped = true;
        logger.info(`stopping (${sig})`);
        this._clearAllWatchdogTimers();
        this._clearPendingTrade();
        if (this._tpResumeT) clearInterval(this._tpResumeT);
        if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
        if (this._hourlyT) clearInterval(this._hourlyT);
        if (this._eodBoot) clearTimeout(this._eodBoot);
        this._save('shutdown');
        this.stopAllClients();
        setTimeout(() => process.exit(0), 1500);
    }

    // Drops the buy-ack watch and any in-flight virtual trade at shutdown so the
    // next boot restarts clean.
    _clearPendingTrade() {
        this._clearBuyAck();
        this.pendingVirtual = null;
    }

    // Subscriptions live on whichever connection opened them, so a forget has to
    // go back to that same connection after a REGULAR → MAIN handover.
    async unsubscribeAllTicks() {
        const subscriptions = Object.values(this.tickSubscriptionIds);
        const owners = Object.values(this.tickSubOwners);
        this.tickSubscriptionIds = {};
        this.tickSubOwners = {};
        const jobs = subscriptions.map((subId, i) => {
            const conn = owners[i] || this._act();
            return conn ? conn.forget(subId) : Promise.resolve();
        });
        await Promise.all(jobs);
    }

    stopAllClients() {
        if (this.clientMain) this.clientMain.stop();
    }

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        // Set start time when first connecting
        if (!this.startTime) {
            this.startTime = new Date();
            console.log(`Bot started at: ${this.startTime.toLocaleTimeString()}`);
        }

        setInterval(() => {
            const now = new Date();
            const elapsedHours = (now - this.startTime) / (1000 * 60 * 60); // Convert to hours

            // Check if 2 hours have elapsed
            // if (elapsedHours >= 2 && this.isWinTrade) {
            //     console.log(`2 hours of trading completed. Started at ${this.startTime.toLocaleTimeString()}, stopping now at ${now.toLocaleTimeString()}`);
            //     this.Pause = true;
            //     this.unsubscribeAllTicks();
            //     this.disconnect();
            //     this.endOfDay = true;
            //     return;
            // }

            // Optional: Log remaining time every interval
            if (!this.endOfDay) {
                const remainingMins = Math.max(0, 120 - (elapsedHours * 60));
                // console.log(`Time remaining: ${remainingMins.toFixed(0)} minutes`);
            }

            // Reset for next day
            // const currentHours = now.getHours();
            // const currentMinutes = now.getMinutes();

            // if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
            //     console.log("It's 8:00 AM, reconnecting the bot for a new session.");
            //     this.startTime = new Date(); // Reset start time
            //     this.assets.forEach(asset => {
            //         this.lastPredictions[asset] = [];
            //     });
            //     this.Pause = false;
            //     this.endOfDay = false;
            //     this.connect();
            // }
        }, 20000); // Check every 20 seconds
    }

    disconnect() {
        this._clearAllWatchdogTimers();
        if (this.clientMain) this.clientMain.suspend();
    }

    stopTrading() {
        this._clearAllWatchdogTimers();
        this._save('stop-trading');
        this.stopAllClients();
    }

    logTradingSummary(asset) {
        const r = this.tokenStats.REGULAR, m = this.tokenStats.MAIN;
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Digit: ${this.xDigit}`);
        console.log('── DUAL PHASE ──');
        console.log(`Trading token: ${this.tokenMode} (VIRTUAL loss streak ${this.tokenLossStreak}/${this.config.lossesBeforeMainSwitch}, MAIN ladder L${this.martingaleLevel})`);
        console.log(`Next stake: $${this.currentStake.toFixed(2)} | VIRTUAL flat $${this._regularStake().toFixed(2)} | MAIN base $${this._mainStake(0).toFixed(2)} x${this.config.multiplier} (cap L${Math.max(0, this.config.maxConsecutiveLosses - 1)})`);
        console.log(`VIRTUAL lifetime: ${r.trades}t ${r.wins}W/${r.losses}L P/L $${r.netPL.toFixed(2)}`);
        console.log(`MAIN lifetime:    ${m.trades}t ${m.wins}W/${m.losses}L P/L $${m.netPL.toFixed(2)}`);
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }

    startTelegramTimer() {
        if (!this.endOfDay) {
            // Align to the top of the GMT hour (same scheduling as randomDigitDifferV2.js)
            const now = new Date();
            const msToNextHour = ((59 - now.getUTCMinutes()) * 60_000) + ((60 - now.getUTCSeconds()) * 1000) + 50;
            this._hourlyBoot = setTimeout(() => {
                this._sendHourly();
                this._hourlyT = setInterval(() => this._sendHourly(), 3600_000); // 1 hour
            }, Math.max(1000, msToNextHour));
        }
    }

    // ── Hourly trade summary (GMT), mirrors randomDigitDifferV2.js ─────
    _sendHourly() {
        const now = new Date();
        const prev = new Date(now.getTime() - 3600_000);
        const date = this._dayKey(prev);
        const hour = prev.getUTCHours();
        const bucket = this.hourlyStats[date + '|' + pad(hour)];
        const h = bucket || { trades: 0, wins: 0, losses: 0, netPL: 0, tokenStats: null, list: [] };
        const winRateLifetime = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(1) : '0.0';
        const sessLine = this._tpAwaiting
            ? '⏸ ' + this._sessionLine() + ' — paused until ' + new Date(this._tpPauseUntil).toUTCString()
            : this._sessionLine();
        const hourTok = h.tokenStats || { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        const today = this._todayStats();

        if (!h.trades) {
            telegram.send(
                '⏰ <b>Random Digit Differ — Hourly Summary GMT (' + date + ' ' + pad(hour) + ':00-' + pad(hour) + ':59)</b>\n\n' +
                'No trades this hour.\n\n' +
                this._tokenBlock('Last hour per token:', hourTok) + '\n\n' +
                this._tokenBlock('Today per token:', today.tokenStats) + '\n' +
                sessLine + '\n' +
                this._tokenBadge('REGULAR') + '\n' +
                this._tokenBadge('MAIN') + '\n' +
                this._tokenPolicyLine() + '\n' +
                '💼 Overall P/L: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
                '🕒 ' + utcTs(),
                'high'
            );
            return;
        }

        const hWR = ((h.wins / h.trades) * 100).toFixed(1);
        let msg =
            '⏰ <b>Random Digit Differ — Hourly Summary GMT (' + date + ' ' + pad(hour) + ':00-' + pad(hour) + ':59)</b>\n\n' +
            '📊 Trades: ' + h.trades + ' (✅' + h.wins + ' ❌' + h.losses + ') | WR ' + hWR + '%\n' +
            '💰 P/L: <b>' + (h.netPL >= 0 ? '+' : '') + h.netPL.toFixed(2) + '</b>\n\n' +
            this._tokenBlock('Last hour per token:', hourTok) + '\n\n' +
            this._tokenDetail('Last hour trades by token:', hourTok, 8) + '\n\n' +
            this._tokenBlock('Today per token:', today.tokenStats) + '\n' +
            sessLine + '\n' +
            this._tokenPolicyLine() + '\n' +
            this._tokenBadge('REGULAR') + '\n' +
            this._tokenBadge('MAIN') + '\n' +
            '💼 Overall P/L: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            '📊 Lifetime: ' + this.totalTrades + ' trades (✅' + this.totalWins + ' ❌' + this.totalLosses + ') | WR ' + winRateLifetime + '%\n' +
            '❌ Streaks: x2=' + this.consecutiveLosses2 + ' x3=' + this.consecutiveLosses3 + ' x4=' + this.consecutiveLosses4 + ' x5=' + this.consecutiveLosses5 + '\n' +
            '🕒 ' + utcTs();

        telegram.send(msg, 'high');
    }

    _dayKey(date = new Date()) {
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    }

    _trackDaily(asset, contract, won, profit, mode = 'REGULAR') {
        const key = this._dayKey();
        const token = mode === 'MAIN' ? 'MAIN' : 'REGULAR';
        const entry = { asset, won, profit, digit: this.xDigit, cid: contract.contract_id, token };
        const stake = this.lastOpenStake || Number(contract.stake) || this.currentStake;

        // ── lifetime per-token rollup ──
        const lt = this.tokenStats[token];
        lt.trades++;
        if (won) lt.wins++; else lt.losses++;
        if (profit > 0) lt.profit += profit; else lt.loss += Math.abs(profit);
        lt.netPL = Number((lt.netPL + profit).toFixed(2));
        lt.stakes = Number((lt.stakes + stake).toFixed(2));

        // ── session per-token rollup (reset on every session rollover) ──
        const st = this._sessionTokenStats[token];
        st.trades++;
        if (won) st.wins++; else st.losses++;
        if (profit > 0) st.profit += profit; else st.loss += Math.abs(profit);
        st.netPL = Number((st.netPL + profit).toFixed(2));
        st.stakes = Number((st.stakes + stake).toFixed(2));

        if (!this.dailyStats[key]) {
            this.dailyStats[key] = {
                trades: 0, wins: 0, losses: 0, netPL: 0, stakes: 0, list: [],
                tokenStats: { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() }
            };
        }
        const d = this.dailyStats[key];
        if (!d.tokenStats) d.tokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        d.trades++;
        if (won) d.wins++; else d.losses++;
        d.netPL += profit;
        d.stakes += stake;
        d.list.push(entry);
        if (d.list.length > 50) d.list.shift();
        this._recordTokenBucket(d.tokenStats[token], entry, won, profit, stake);

        const now = new Date();
        const hkey = key + '|' + pad(now.getUTCHours());
        if (!this.hourlyStats[hkey]) {
            this.hourlyStats[hkey] = {
                trades: 0, wins: 0, losses: 0, netPL: 0, stakes: 0, list: [],
                tokenStats: { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() }
            };
        }
        const h = this.hourlyStats[hkey];
        if (!h.tokenStats) h.tokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        h.trades++;
        if (won) h.wins++; else h.losses++;
        h.netPL += profit;
        h.stakes += stake;
        h.list.push(entry);
        if (h.list.length > 50) h.list.shift();
        this._recordTokenBucket(h.tokenStats[token], entry, won, profit, stake);

        const cutoff = this._dayKey(new Date(now.getTime() - 48 * 3600_000));
        for (const bk of Object.keys(this.hourlyStats)) {
            if (bk < cutoff) delete this.hourlyStats[bk];
        }
    }

    _recordTokenBucket(bucket, entry, won, profit, stake) {
        if (!bucket) return;
        bucket.trades++;
        if (won) bucket.wins++; else bucket.losses++;
        if (profit > 0) bucket.profit += profit; else bucket.loss += Math.abs(profit);
        bucket.netPL = Number((bucket.netPL + profit).toFixed(2));
        bucket.stakes = Number((bucket.stakes + stake).toFixed(2));
        if (entry) {
            bucket.list = bucket.list || [];
            bucket.list.push(entry);
            if (bucket.list.length > 50) bucket.list.shift();
        }
    }

    _todayStats() {
        const key = this._dayKey();
        const d = this.dailyStats[key] || { trades: 0, wins: 0, losses: 0, netPL: 0 };
        if (!d.tokenStats) d.tokenStats = { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };
        return {
            trades: d.trades,
            wins: d.wins,
            losses: d.losses,
            netPL: d.netPL,
            tokenStats: d.tokenStats,
            winRate: d.trades ? ((d.wins / d.trades) * 100).toFixed(2) : '0.00'
        };
    }

    // ── Telegram per-token formatting helpers ───────────────────────────
    // The VIRTUAL phase is the old REGULAR leg: simulated locally, its state key
    // stays "REGULAR" on disk but every human-facing render says VIRTUAL.
    _tokenIcon(mode) { return mode === 'MAIN' ? '💰' : '🧪'; }

    _tokenName(mode) { return mode === 'MAIN' ? 'MAIN' : 'VIRTUAL'; }

    // One-line status: the VIRTUAL phase is a simulation with no Deriv client,
    // MAIN shows the real account kind, loginid and balance.
    _tokenBadge(mode) {
        const m = this._tokenName(mode);
        if (m === 'VIRTUAL') {
            return `🧪 <b>VIRTUAL</b> (SIM) <code>sim</code> — simulated · $${Number(this.virtualBalance ?? 0).toFixed(2)} ${this.currency || 'USD'} (no Deriv token)`;
        }
        const c = this.clientFor(m);
        if (!c) return `${this._tokenIcon(m)} ${m}: <i>not configured</i>`;
        const acct = c.accountInfo;
        const kind = acct ? (acct.isVirtual ? 'DEMO' : 'REAL') : (m === 'MAIN' ? 'REAL' : 'DEMO');
        const status = c.authorized ? '✔ online' : (c.connected ? '…authorizing' : '✖ offline');
        const bal = acct || c.authorized ? '$' + Number(c.balance ?? 0).toFixed(2) + ' ' + (c.currency || this.currency) : 'balance ?';
        return `${this._tokenIcon(m)} <b>${m}</b> (${kind}) <code>${htmlEscape(acct?.loginid || '?')}</code> — ${status} · ${bal}`;
    }

    _tokenStatLine(mode, ts) {
        const t = (ts || {})[mode] || {};
        const trades = t.trades || 0;
        const wr = trades ? (((t.wins || 0) / trades) * 100).toFixed(1) : '0.0';
        const net = Number(t.netPL || 0);
        const stakeNote = mode === 'MAIN'
            ? `stake $${this._mainStake(0).toFixed(2)} base + x${this.config.multiplier} ladder`
            : `stake flat $${this._regularStake().toFixed(2)} → sim pays $${this._virtualPayout(this._regularStake()).toFixed(2)}`;
        const label = this._tokenName(mode);
        return `  ${this._tokenIcon(mode)} ${label}: ${trades}t | ${t.wins || 0}W/${t.losses || 0}L | WR ${wr}% | P/L ${net >= 0 ? '+' : ''}$${net.toFixed(2)} | ${stakeNote}`;
    }

    _tokenBlock(label, ts) {
        return `💳 <b>${label}</b>\n` + this._tokenStatLine('REGULAR', ts) + '\n' + this._tokenStatLine('MAIN', ts);
    }

    // Recent trades grouped per token, so a Telegram reader can see exactly what
    // each account did rather than one merged list.
    _tokenDetail(label, ts, n = 6) {
        const rows = ['REGULAR', 'MAIN'].map(m => {
            const list = ((ts || {})[m] || {}).list || [];
            if (!list.length) return `  ${this._tokenIcon(m)} ${this._tokenName(m)}: no trades`;
            const lines = list.slice(-n).map((t, i) =>
                `    ${i + 1}. ${t.won ? '✅' : '❌'} ${htmlEscape(t.asset)} d${t.digit} #${t.cid != null ? t.cid : '?'} ${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`);
            return `  ${this._tokenIcon(m)} ${this._tokenName(m)} (last ${Math.min(n, list.length)}):\n${lines.join('\n')}`;
        });
        return `📋 <b>${label}</b>\n` + rows.join('\n');
    }

    // Current trading-token policy line: where the next trade lands and why.
    _tokenPolicyLine() {
        if (!this._dualTokenEnabled()) {
            return '🔀 Single-token mode (no MAIN token) — martingale applies from the first loss';
        }
        const next = this.tokenMode;
        const nextLabel = this._tokenName(next);
        return '🔀 Trading token: <b>' + this._tokenIcon(next) + ' ' + nextLabel + '</b> · ' +
            (next === 'MAIN'
                ? `MAIN ladder <b>L${this.martingaleLevel}</b>, next stake <b>$${this.currentStake.toFixed(2)}</b> (cap L${Math.max(0, this.config.maxConsecutiveLosses - 1)})`
                : `VIRTUAL flat <b>$${this._regularStake().toFixed(2)}</b> · loss streak ${this.tokenLossStreak}/${this.config.lossesBeforeMainSwitch} → MAIN (base $${this._mainStake(0).toFixed(2)} + ladder)`);
    }

    sendTelegramSummary() {
        const winRate = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        const today = this._todayStats();

        const summaryText =
            '📊 <b>Random Digit Differ — DUAL PHASE Summary</b>\n' +
            this._tokenBadge('REGULAR') + '\n' +
            this._tokenBadge('MAIN') + '\n' +
            this._tokenPolicyLine() + '\n\n' +
            this._tokenBlock('Today per token (' + this._dayKey() + '):', today.tokenStats) + '\n\n' +
            this._tokenBlock('Session per token:', this._sessionTokenStats) + '\n\n' +
            this._tokenBlock('Lifetime per token:', this.tokenStats) + '\n\n' +
            'Total Trades: ' + this.totalTrades + ' | ✅ ' + this.totalWins + ' | ❌ ' + this.totalLosses + '\n' +
            'x2: ' + this.consecutiveLosses2 + ' | x3: ' + this.consecutiveLosses3 +
            ' | x4: ' + this.consecutiveLosses4 + ' | x5: ' + this.consecutiveLosses5 + '\n\n' +
            '📅 Today (UTC ' + this._dayKey() + '): ' + today.trades + ' trades (✅' + today.wins + ' ❌' + today.losses +
            ') | P/L <b>' + today.netPL.toFixed(2) + '</b>\n\n' +
            'Currently Suspended Assets: <code>' + (Array.from(this.suspendedAssets).join(', ') || 'None') + '</code>\n\n' +
            'Next trade: <b>' + this._tokenIcon(this.tokenMode) + ' ' + this._tokenName(this.tokenMode) + '</b> at <b>$' + this.currentStake.toFixed(2) + '</b>\n' +
            'Total Profit/Loss Amount: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            'Win Rate: <b>' + winRate + '%</b>\n' +
            '🕒 ' + utcTs();

        telegram.send(summaryText, 'high');
    }

    sendTradeOpenNotification(asset, digit, stake, payout, mode = 'REGULAR') {
        const token = this._tokenName(mode);
        const last10 = this.lastOpenDigits && this.lastOpenDigits.length ? this.lastOpenDigits.join(', ') : (this.tickHistories[asset] || []).slice(-10).join(', ') || '—';

        telegram.send(
            '🟢 <b>Random Digit Differ — OPEN</b>\n' +
            this._tokenBadge(mode) + '\n' +
            'Asset: <code>' + htmlEscape(asset) + '</code>\n' +
            'Predicted digit: <b>' + digit + '</b>\n' +
            'Stake: <b>$' + stake.toFixed(2) + '</b> → payout ' + (payout ? payout.toFixed(2) : '—') + '\n' +
            (mode === 'MAIN'
                ? '🪜 MAIN martingale <b>L' + this.martingaleLevel + '</b> (base $' + this._mainStake(0).toFixed(2) + ' × ' + this.config.multiplier + '^L)\n'
                : '🧪 VIRTUAL simulated trade — flat stake $' + stake.toFixed(2) + ', payout $' + (payout ? payout.toFixed(2) : '—') + ' (\u2212' + (payout ? (payout - stake).toFixed(2) : '?') + ' on loss)\n') +
            'Loss streak: ' + this.tokenLossStreak + '/' + this.config.lossesBeforeMainSwitch + ' before MAIN handover\n\n' +
            'Last 10 digits: <code>' + last10 + '</code>\n' +
            '🕒 ' + utcTs(),
            'low'
        );
    }

    sendTradeResultNotification(asset, contract, won, profit, mode = 'REGULAR') {
        const winRate = this.totalTrades ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : '0.00';
        const history = this.tickHistories[asset] || [];
        const lastFewTicks = history.slice(-20);
        const tradeId = contract.contract_id;
        const token = this._tokenName(mode);

        const summaryText =
            (won ? '✅ <b>Random Digit Differ — WIN</b>' : '❌ <b>Random Digit Differ — LOSS</b>') + '\n\n' +
            this._tokenBadge(mode) + '\n' +
            'Traded on token: <b>' + this._tokenIcon(mode) + ' ' + token + '</b>' +
            (mode === 'MAIN' ? ' (martingale L' + this.martingaleLevel + ')' : ' (simulated — flat stake)') + '\n' +
            'Trade #' + tradeId + '\n' +
            'Asset: <code>' + htmlEscape(asset) + '</code>\n' +
            'Predicted digit: <b>' + this.xDigit + '</b>\n' +
            'Last 20 digits: <code>' + (lastFewTicks.join(', ') || '—') + '</code>\n\n' +
            'Result P/L: <b>' + (won ? '+' : '') + profit.toFixed(2) + '</b>\n\n' +
            this._tokenBlock('Session per token:', this._sessionTokenStats) + '\n\n' +
            this._tokenPolicyLine() + '\n\n' +
            'Session P/L: <b>$' + this._sessionPL.toFixed(2) + '</b> (target ' + (this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : '∞') + ')\n' +
            'Trades this session: ' + this._sessionTrades + '\n' +
            this._tokenBlock('Lifetime per token:', this.tokenStats) + '\n' +
            'Total Trades: ' + this.totalTrades + ' | ✅ ' + this.totalWins + ' | ❌ ' + this.totalLosses + '\n' +
            'Win Rate: <b>' + winRate + '%</b>\n' +
            'Total P/L: <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n\n' +
            'x2: ' + this.consecutiveLosses2 + ' | x3: ' + this.consecutiveLosses3 +
            ' | x4: ' + this.consecutiveLosses4 + ' | x5: ' + this.consecutiveLosses5 + '\n\n' +
            'Next trade token: <b>' + this._tokenIcon(this.tokenMode) + ' ' + this._tokenName(this.tokenMode) + '</b> at <b>$' + this.currentStake.toFixed(2) + '</b>\n' +
            'Waiting for: ' + this.waitTime + ' (' + this.waitSeconds + ' ms)  before next trade...\n' +
            '🕒 ' + utcTs();

        telegram.send(summaryText, won ? 'low' : 'high');
    }

    sendErrorNotification(errorMessage) {
        telegram.send(
            '🚨 <b>Random Digit Differ — Error</b>\n\n' +
            'An error occurred: ' + errorMessage + '\n' +
            this._tokenBadge('REGULAR') + '\n' +
            this._tokenBadge('MAIN') + '\n' +
            this._tokenPolicyLine() + '\n' +
            '🕒 ' + utcTs(),
            'high'
        );
    }

    // ── End-of-Day summary (GMT) ───────────────────────────────────────
    _msToNextEod(now = new Date()) {
        const [h, min] = String(this.eodTimeGmt || '00:00').split(':').map(Number);
        const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h || 0, min || 0, 0, 0));
        if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
        return target.getTime() - now.getTime();
    }
    _eodReportDate(now = new Date()) {
        // Report the trade day that just closed (roll back past the trigger moment).
        return this._dayKey(new Date(now.getTime() - 60 * 1000));
    }
    _scheduleEod() {
        const delay = this._msToNextEod();
        console.log(`Next GMT EOD report in ${(delay / 3600000).toFixed(2)}h`);
        this._eodBoot = setTimeout(() => {
            this._sendEod();
            this._scheduleEod();
        }, delay);
    }
    _sendEod() {
        const date = this._eodReportDate();
        const d = this.dailyStats[date] || { trades: 0, wins: 0, losses: 0, netPL: 0, list: [], tokenStats: null };
        const winRate = d.trades ? ((d.wins / d.trades) * 100).toFixed(2) : '0.00';
        const dayTok = d.tokenStats || { REGULAR: this._emptyTokenStats(), MAIN: this._emptyTokenStats() };

        let msg = '🌙 <b>Random Digit Differ — END OF TRADE DAY</b>\n' +
            '📅 Trade day (UTC): <b>' + date + '</b>\n\n';

        if (d.trades === 0) {
            msg += 'No trades recorded for this trade day.\n\n';
        } else {
            msg += '📊 Trades: ' + d.trades + ' (✅' + d.wins + ' ❌' + d.losses + ') | WR <b>' + winRate + '%</b>\n' +
                '💰 Net P/L: <b>' + (d.netPL >= 0 ? '+' : '') + d.netPL.toFixed(2) + '</b>\n\n' +
                this._tokenBlock('Trade day per token:', dayTok) + '\n\n' +
                this._tokenDetail('Trade day detail by token:', dayTok, 15) + '\n\n';
        }

        msg += this._tokenBlock('Lifetime per token:', this.tokenStats) + '\n\n' +
            '💼 Lifetime: ' + this.totalTrades + ' trades (✅' + this.totalWins + ' ❌' + this.totalLosses +
            ') | Net P/L <b>' + this.totalProfitLoss.toFixed(2) + '</b>\n' +
            this._tokenBadge('REGULAR') + '\n' +
            this._tokenBadge('MAIN') + '\n' +
            '🕒 ' + utcTs();

        telegram.send(msg, 'high');
        this._save(`eod-${date}`);
    }

start() {
        console.log('═══ DUAL PHASE MODE (VIRTUAL → MAIN) ═══');
        console.log(`VIRTUAL phase: simulated 1-tick trades — no Deriv token | flat stake $${this._regularStake().toFixed(2)}, payout $${this._virtualPayout(this._regularStake()).toFixed(2)}`);
        console.log(`MAIN token:    ${this.clientMain ? 'configured' : 'MISSING — required'} | base stake $${this._mainStake(0).toFixed(2)}, multiplier x${this.config.multiplier}, ladder cap L${Math.max(0, this.config.maxConsecutiveLosses - 1)}`);
        console.log(`Handover to MAIN after ${this.config.lossesBeforeMainSwitch} consecutive VIRTUAL losses; any MAIN win returns to VIRTUAL`);
        console.log('Asset mode: ' + (this.config.singleActiveAsset ? 'ONE asset per cycle (random pick, lowest latency)' : 'ALL assets subscribed'));
        console.log('Random asset selection: ' + (this.config.randomAssetSelection ? 'ON' : 'OFF (tick-driven)'));
        console.log('Suspend asset after trade: ' + (this.config.suspendAssetAfterTrade ? 'ON' : 'OFF'));
        console.log('No consecutive repeats: ON (asset + digit excluded from the previous trade)');
        console.log(`Session takeProfit: ${this.config.takeProfit > 0 ? '$' + this.config.takeProfit.toFixed(2) : 'OFF'} | cooldown ${Math.round(this.config.takeProfitCooldownMinMs / 60000)}-${Math.round(this.config.takeProfitCooldownMaxMs / 60000)} min (random)`);
        console.log(`Stop conditions: MAIN ladder >= L${Math.max(0, this.config.maxConsecutiveLosses - 1) + 1} OR lifetime P/L <= -${this.config.stopLoss}`);
        console.log(`Watchdog: fire ${(this.config.tradeWatchdogMs / 1000).toFixed(0)}s, ${this.config.watchdogPolls} polls x ${(this.config.watchdogPollGapMs / 1000).toFixed(0)}s → force void | buy-ack ${(this.config.buyAckMs / 1000).toFixed(0)}s`);
        console.log('State file: ' + this.stateFile);

        if (!this.clientMain) {
            console.error('BOOT ABORTED — MAIN_TOKEN not configured (required for market data + MAIN phase).');
            logger.error('boot aborted — MAIN_TOKEN not configured');
            if (telegram && telegram.send) {
                telegram.send(
                    '🛑 <b>BOOT ABORTED</b>\n' +
                    'No <code>MAIN_TOKEN</code> configured — required for market data and MAIN-phase trades.\n' +
                    'Add it to CONFIG (or <code>MAIN_TOKEN</code> env) and restart.', 'high');
            }
            this._stopped = true;
            return;
        }

        this.connect();
        this.checkTimeForDisconnectReconnect();
        this._scheduleEod();
        this._tpResumeT = setInterval(() => this._checkTpResume(), 10000);

        process.on('SIGINT', () => this.stop('SIGINT'));
        process.on('SIGTERM', () => this.stop('SIGTERM'));
        process.on('uncaughtException', (e) => { logger.error('uncaught:', e); this._save('uncaught'); });
        process.on('unhandledRejection', (e) => { logger.error('unhandled:', e); this._save('unhandled'); });
    }
}

// Usage — trading config preserved from the original randomDiffer.js
const bot = new EnhancedDigitDifferTradingBot({
    initialStake: 0.35,             // VIRTUAL phase flat stake (simulated — martingale never applies)
    // ── MAIN token base stake: the first rung of the martingale ladder once
    // trading hands over from the VIRTUAL phase. Deliberately different from initialStake.
    mainInitialStake: 0.61,         // MAIN token base stake (martingale ladder L0)
    // Consecutive VIRTUAL losses before the next trades move to the MAIN token.
    lossesBeforeMainSwitch: 1,  // MAIN token handover threshold (1 = after 1 VIRTUAL loss)
    multiplier: 11.3,         //11.3 MAIN martingale ladder multiplier (L0 → L1 → L2 → L3)
    maxConsecutiveLosses: 4,     // MAIN martingale ladder cap (L0..L3), then the bot stops
    stopLoss: 906,                // lifetime P/L stop-loss (negative number, e.g. -1000)
    takeProfit: 0,              // per-session profit target (0 = off)
    requiredHistoryLength: 1000,
    winProbabilityThreshold: 100,
    minWaitTime: 1000, //1 * 60 * 1000,  // 15 min
    maxWaitTime: 16000, //11 * 60 * 1000,  // 30 min
    minOccurrencesThreshold: 1,
    assets: [
        // 'R_10','R_25','R_50','R_75', 'RDBULL','RDBEAR', 
        // '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V', 
        // 'JD10','JD25','JD50','JD75','JD100'
        // 'R_10','R_25','R_50','R_75', 'RDBULL','RDBEAR'
        // 'JD10','JD25','JD50','JD75'
        'R_10'
    ],
    // singleActiveAsset: ONE random asset subscribed + traded per trade, then
    // forgotten and re-picked on the next cycle (default true; hard-pinned below).
    // suspendAssetAfterTrade / cooldown default from CONFIG
    // (env SUSPEND_AFTER_TRADE, TAKE_PROFIT_COOLDOWN_MS_MIN/MAX).
    singleActiveAsset: true,
});

bot.start();