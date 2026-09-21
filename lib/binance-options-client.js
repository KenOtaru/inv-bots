'use strict';
const crypto = require('crypto');
const https = require('https');
class BinanceOptionsClient {
  constructor({ apiKey = '', apiSecret = '', baseUrl = 'https://eapi.binance.com' } = {}) { this.apiKey = apiKey; this.apiSecret = apiSecret; this.baseUrl = baseUrl; this.timeOffsetMs = 0; }
  async request(method, path, params = {}, { signed = false, baseUrl = this.baseUrl } = {}) {
    if (signed && (!this.apiKey || !this.apiSecret)) throw new Error('Missing Binance API credentials');
    const query = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.append(k, String(v));
    if (signed) { query.set('timestamp', String(Date.now() + this.timeOffsetMs)); query.set('recvWindow', '5000'); query.set('signature', crypto.createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex')); }
    const url = new URL(path + (query.size ? `?${query}` : ''), baseUrl);
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers: this.apiKey ? { 'X-MBX-APIKEY': this.apiKey } : {}, timeout: 15000 }, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { let json; try { json = data ? JSON.parse(data) : {}; } catch { return reject(new Error(`Invalid Binance response: ${data.slice(0, 200)}`)); } if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Binance ${res.statusCode}: ${json.msg || data}`)); resolve(json); }); });
      req.on('timeout', () => req.destroy(new Error('Binance request timed out')));
      req.on('error', error => {
        if (error.code === 'ENOTFOUND') return reject(new Error(`Cannot resolve ${url.hostname}. Check the computer/router DNS and whether Binance is available in your region; API credentials were not contacted.`));
        reject(error);
      });
      req.end();
    });
  }
  async syncTime() { const before = Date.now(); const { serverTime } = await this.request('GET', '/eapi/v1/time'); this.timeOffsetMs = Number(serverTime) - Math.round((before + Date.now()) / 2); return this.timeOffsetMs; }
  exchangeInfo() { return this.request('GET', '/eapi/v1/exchangeInfo'); }
  index(underlying) { return this.request('GET', '/eapi/v1/index', { underlying }); }
  mark(symbol) { return this.request('GET', '/eapi/v1/mark', { symbol }); }
  depth(symbol, limit = 20) { return this.request('GET', '/eapi/v1/depth', { symbol, limit }); }
  account() { return this.request('GET', '/eapi/v1/account', {}, { signed: true }); }
  placeLimitOrder({ symbol, side, quantity, price, clientOrderId, timeInForce = 'FOK', reduceOnly = false }) { return this.request('POST', '/eapi/v1/order', { symbol, side, type: 'LIMIT', quantity, price, timeInForce, reduceOnly, clientOrderId, newOrderRespType: 'RESULT' }, { signed: true }); }
  cancelOrder({ symbol, orderId, clientOrderId }) { return this.request('DELETE', '/eapi/v1/order', { symbol, orderId, clientOrderId }, { signed: true }); }
  queryOrder({ symbol, orderId, clientOrderId }) { return this.request('GET', '/eapi/v1/order', { symbol, orderId, clientOrderId }, { signed: true }); }
  positions(symbol) { return this.request('GET', '/eapi/v1/position', { symbol }, { signed: true }); }
  userTrades(symbol, startTime) { return this.request('GET', '/eapi/v1/userTrades', { symbol, startTime, limit: 100 }, { signed: true }); }
  startUserStream() { return this.request('POST', '/eapi/v1/listenKey'); }
  keepaliveUserStream() { return this.request('PUT', '/eapi/v1/listenKey'); }
}
module.exports = { BinanceOptionsClient };
