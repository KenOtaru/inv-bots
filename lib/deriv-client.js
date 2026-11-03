const WebSocket = require('ws');
const https = require('https');
const { URL } = require('url');
const EventEmitter = require('events');

class DerivApiError extends Error {
    constructor(message, { code = 'Error', reqId, requestType, buyOutcomeUnknown = false } = {}) {
        super(message);
        this.name = 'DerivApiError';
        this.code = code;
        this.reqId = reqId;
        this.requestType = requestType;
        this.buyOutcomeUnknown = buyOutcomeUnknown;
    }
}

function restErrorMessage(response) {
    return response.body?.errors?.[0]?.message || response.body?.error?.message || response.body?.message || 'Request failed';
}

class RestClient {
    constructor(base, appId, token) { this.baseUrl = base; this.appId = appId; this.token = token; }
    static isPat(token) { return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim()); }
    request(method, route, body = null) {
        return new Promise((resolve, reject) => {
            let url;
            try { url = new URL(route, this.baseUrl); } catch (_) { return reject(new Error(`Bad URL ${route}`)); }
            const payload = body == null ? null : JSON.stringify(body);
            const req = https.request({
                method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
                headers: {
                    Authorization: `Bearer ${this.token}`, 'Deriv-App-ID': this.appId, Accept: 'application/json',
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
                timeout: 15000,
            }, response => {
                let data = '';
                response.on('data', chunk => { data += chunk; });
                response.on('error', reject);
                response.on('end', () => {
                    try { data = JSON.parse(data); } catch (_) {}
                    resolve({ status: response.statusCode, body: data });
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

// Shared by both bot entrypoints; importing this module never opens a connection.
class DerivClient extends EventEmitter {
    constructor(cfg, logger = console) {
        super();
        this.cfg = cfg;
        this.logger = logger;
        this.ws = null;
        this.connected = false;
        this.authorized = false;
        this._stopped = false;
        this._suspended = false;
        this._connecting = false;
        this._reconnecting = false;
        this._reconnectAttempt = 0;
        this._reconnectTimer = null;
        this._reqId = 0;
        this._pending = new Map();
        this._subs = new Map();
        this.balance = null;
        this.currency = cfg.currency;
        this.accountInfo = null;
        this._isPat = RestClient.isPat(cfg.apiToken);
        this._rest = this._isPat ? new RestClient(cfg.restBaseUrl, cfg.appId, cfg.apiToken) : null;
        this._targetAccountId = cfg.accountId || '';
    }

    _legacyUrl() {
        const separator = this.cfg.legacyWsUrl.includes('?') ? '&' : '?';
        return `${this.cfg.legacyWsUrl}${separator}app_id=${encodeURIComponent(this.cfg.appId)}`;
    }

    connect() {
        if (this._stopped || this._suspended || this._connecting) return;
        if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
        if (!this.cfg.apiToken || !this.cfg.appId) {
            this.logger.error('Set API_TOKEN and APP_ID in .env before starting the bot');
            this._stopped = true;
            return;
        }
        if (this._isPat) {
            this._connecting = true;
            this._connectPat().catch(error => {
                this.logger.error('PAT connect:', error.message);
                if (error.code === 'AccountTypeMismatch' || error.code === 'AccountNotFound') this.stop();
                else this._schedReconnect();
            }).finally(() => { this._connecting = false; });
        } else {
            this._openWs(this._legacyUrl());
        }
    }

    async _resolvePatAccountId() {
        const response = await this._rest.get('/trading/v1/options/accounts');
        if (response.status !== 200) throw new Error(`Accounts ${response.status}: ${restErrorMessage(response)}`);
        const accounts = Array.isArray(response.body?.data) ? response.body.data : [];
        const accountId = account => account.account_id ?? account.loginid ?? account.id;
        const account = this._targetAccountId
            ? accounts.find(item => String(accountId(item)) === String(this._targetAccountId))
            : accounts.find(item => String(item.account_type).toLowerCase() === this.cfg.accountType);
        if (!account || !accountId(account)) {
            throw new DerivApiError(`No matching ${this.cfg.accountType} options account. Check ACCOUNT_ID and ACCOUNT_TYPE.`, { code: 'AccountNotFound' });
        }
        const type = String(account.account_type).toLowerCase();
        if (type !== this.cfg.accountType) {
            throw new DerivApiError(`ACCOUNT_ID is a ${type} account, but ACCOUNT_TYPE=${this.cfg.accountType}. Refusing to trade.`, { code: 'AccountTypeMismatch' });
        }
        this.accountInfo = {
            loginid: String(accountId(account)), accountType: type, isVirtual: type === 'demo',
            currency: account.currency || this.cfg.currency,
            balance: account.balance != null ? Number(account.balance) : null,
        };
        return this.accountInfo.loginid;
    }

    async _connectPat() {
        const accountId = await this._resolvePatAccountId();
        if (this._stopped || this._suspended) return;
        const response = await this._rest.post(`/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`);
        if (response.status !== 200) throw new Error(`OTP ${response.status}: ${restErrorMessage(response)}`);
        const url = response.body?.data?.url;
        if (!url) throw new Error('OTP response missing WebSocket URL');
        if (this._stopped || this._suspended) return;
        this._targetAccountId = accountId;
        // Do not log the OTP-bearing URL or overwrite the discovered account currency/balance.
        this.logger.info('connecting via PAT/OTP');
        this._openWs(url);
    }

    _openWs(url) {
        try {
            this.ws = new WebSocket(url, { handshakeTimeout: 15000, headers: { 'User-Agent': 'x2Differ/1.0' } });
        } catch (error) {
            this.logger.error('WS construct:', error.message);
            this._schedReconnect();
            return;
        }
        this.ws.on('open', () => this._onOpen());
        this.ws.on('message', data => this._onMsg(data));
        this.ws.on('error', error => { this.logger.error('WS error:', error.message); this.emit('error', error); });
        this.ws.on('close', (code, reason) => this._onClose(code, reason));
        this.ws.on('unexpected-response', (_, response) => {
            this.logger.error('WS handshake:', response.statusCode, response.statusMessage);
            response.destroy();
            this.ws.terminate();
        });
    }

    _onOpen() {
        this.logger.info('WS connected ✔');
        this.connected = true;
        this._reconnecting = false;
        this._reconnectAttempt = 0;
        this.emit('open');
        if (this._isPat) this._markPatAuth();
        else this._authLegacy();
    }

    async _authLegacy() {
        try {
            const response = await this._send({ authorize: this.cfg.apiToken }, 20000);
            if (!this.connected) return;
            const account = response.authorize;
            if (!account) throw new Error('Authorization response missing account');
            const type = account.is_virtual ? 'demo' : 'real';
            if (type !== this.cfg.accountType) {
                throw new DerivApiError(`Token is for a ${type} account, but ACCOUNT_TYPE=${this.cfg.accountType}. Refusing to trade.`, { code: 'AccountTypeMismatch' });
            }
            this.balance = Number(account.balance);
            this.currency = account.currency || this.cfg.currency;
            this.accountInfo = { loginid: account.loginid, isVirtual: type === 'demo', accountType: type, currency: this.currency };
            this.authorized = true;
            this.logger.info(`authorized ${account.loginid} (${type.toUpperCase()}) bal=${this.balance} ${this.currency}`);
            this.emit('authorized', this.accountInfo);
        } catch (error) {
            this.logger.error('authorize:', error.message);
            this.authorized = false;
            if (error.code === 'AccountTypeMismatch') this.stop();
            else { this.ws?.close(); this._schedReconnect(); }
        }
    }

    async _markPatAuth() {
        if (this.accountInfo?.balance != null) this.balance = Number(this.accountInfo.balance);
        this.currency = this.accountInfo?.currency || this.cfg.currency;
        try {
            const response = await this._send({ balance: 1 }, 10000);
            if (response.balance) {
                this.balance = Number(response.balance.balance);
                this.currency = response.balance.currency || this.currency;
            }
        } catch (error) { this.logger.debug('balance skip:', error.message); }
        if (!this.connected) return;
        this.authorized = true;
        this.logger.info(`authorized ${this.accountInfo?.loginid || this._targetAccountId} via PAT bal=${this.balance ?? '?'} ${this.currency}`);
        this.emit('authorized', this.accountInfo);
    }

    _onMsg(data) {
        let message;
        try { message = JSON.parse(data.toString()); } catch (_) { return; }
        if (!message || typeof message !== 'object') return;
        const pending = this._pending.get(message.req_id);
        if (message.error) {
            const error = new DerivApiError(message.error.message || message.error.code || 'API error', {
                code: message.error.code, reqId: message.req_id, requestType: pending?.requestType || message.msg_type,
            });
            this.logger.error(`api: ${error.code} - ${error.message} type=${error.requestType || '?'} req=${error.reqId ?? '?'}`);
            if (pending) {
                clearTimeout(pending.timer);
                this._pending.delete(message.req_id);
                pending.reject(error);
            }
            if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(error.code)) this.ws?.close();
            return;
        }
        if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(message.req_id);
            pending.resolve(message);
            return;
        }
        const callback = this._subs.get(message.subscription?.id);
        if (callback) this._deliver(callback, message);
        else this.emit('message', message);
    }

    _deliver(callback, message) {
        try { callback(message); } catch (error) { this.logger.error('sub handler:', error.message); }
    }

    _transportError(message, code, pending) {
        return new DerivApiError(message, {
            code, reqId: pending?.id, requestType: pending?.requestType,
            buyOutcomeUnknown: pending?.requestType === 'buy' && pending.sent,
        });
    }

    _onClose(code, reason) {
        this.logger.warn(`WS closed code=${code}`);
        const wasAuthorized = this.authorized;
        this.connected = false;
        this.authorized = false;
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(this._transportError('Connection closed', 'ConnectionClosed', pending));
        }
        this._pending.clear();
        this._subs.clear();
        this.emit('close', code, reason, wasAuthorized);
        this._schedReconnect();
    }

    _schedReconnect() {
        if (this._stopped || this._suspended || this._reconnecting) return;
        this._reconnecting = true;
        const attempt = this._reconnectAttempt++;
        const base = Math.min(this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, attempt), this.cfg.reconnect.maxDelayMs);
        const delay = base + Math.random() * this.cfg.reconnect.jitterMs;
        this.logger.info(`reconnect #${attempt + 1} in ${(delay / 1000).toFixed(1)}s`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._reconnecting = false;
            this.connect();
        }, delay);
    }

    _request(payload, timeoutMs, transform = message => message) {
        return new Promise((resolve, reject) => {
            const requestType = Object.keys(payload)[0];
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(this._transportError('Not connected', 'NotConnected', { requestType, sent: false }));
            }
            const id = ++this._reqId;
            const pending = {
                id, requestType, sent: false, reject,
                resolve: message => { try { resolve(transform(message)); } catch (error) { reject(error); } },
            };
            const fail = (message, code) => {
                if (!this._pending.has(id)) return;
                clearTimeout(pending.timer);
                this._pending.delete(id);
                reject(this._transportError(message, code, pending));
            };
            pending.timer = setTimeout(() => fail(`${requestType} request timeout`, 'RequestTimeout'), timeoutMs);
            this._pending.set(id, pending);
            try {
                pending.sent = true;
                this.ws.send(JSON.stringify({ ...payload, req_id: id }), error => {
                    if (error) fail(error.message, 'SendFailed');
                });
            } catch (error) { fail(error.message, 'SendFailed'); }
        });
    }

    _send(payload, timeoutMs = 30000) { return this._request(payload, timeoutMs); }

    subscribe(payload, callback, timeoutMs = 30000) {
        return this._request({ ...payload, subscribe: 1 }, timeoutMs, message => {
            const id = message.subscription?.id;
            if (id) this._subs.set(id, callback);
            // The initial frame can already contain a SOLD one-tick contract.
            // Deliver it even if the server ends the stream without a subscription ID.
            this._deliver(callback, message);
            if (!id) throw new DerivApiError('No subscription id returned', { code: 'NoSubscriptionId' });
            return id;
        });
    }

    async buyDigitDiffer({ asset, digit, stake }) {
        if (!this.connected || !this.authorized) throw new DerivApiError('Trading requires an authorized connection', { code: 'NotAuthorized' });
        if (!Number.isFinite(stake) || stake <= 0) throw new RangeError('Stake must be a positive finite number');
        if (!Number.isInteger(digit) || digit < 0 || digit > 9) throw new RangeError('Barrier digit must be an integer from 0 to 9');
        if (typeof asset !== 'string' || !/^\w{2,30}$/.test(asset)) throw new TypeError('Invalid asset symbol');
        if (!this.currency) throw new Error('Account currency unavailable');
        // Both APIs document buy: "1" + parameters. This avoids the proposal-ID
        // lookup that can return InvalidContractProposal, and an extra round trip.
        // price is a hard maximum; never increase the stake to make a trade fill.
        const response = await this._send({
            buy: '1', price: stake,
            parameters: {
                amount: stake, basis: 'stake', contract_type: 'DIGITDIFF', currency: this.currency,
                duration: 1, duration_unit: 't', barrier: String(digit), [this.symbolField()]: asset,
            },
        }, 15000);
        if (!response?.buy?.contract_id) {
            throw new DerivApiError('Buy response missing contract_id; check account history before resuming', {
                code: 'InvalidBuyResponse', requestType: 'buy', buyOutcomeUnknown: true,
            });
        }
        if (response.buy.balance_after != null && Number.isFinite(Number(response.buy.balance_after))) this.balance = Number(response.buy.balance_after);
        return response.buy;
    }

    forget(id) {
        if (!id) return Promise.resolve();
        this._subs.delete(id);
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();
        return this._send({ forget: id }, 8000).catch(error => this.logger.debug('forget:', error.message));
    }

    _cancelReconnect() {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        this._reconnecting = false;
    }
    suspend() { this._suspended = true; this._cancelReconnect(); this.ws?.close(); }
    resume() { this._suspended = false; this.connect(); }
    stop() { this._stopped = true; this._cancelReconnect(); this.ws?.close(); }
    symbolField() { return this._isPat ? 'underlying_symbol' : 'symbol'; }
}

module.exports = { DerivClient, DerivApiError, RestClient };
