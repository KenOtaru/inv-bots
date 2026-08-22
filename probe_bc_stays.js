#!/usr/bin/env node
'use strict';
/**
 * Diagnostic: print the actual ticks_stayed_in distribution for one asset.
 */
const WebSocket = require('ws');
const https = require('https');
const { CONFIG } = require('./accuPULSE3BC_v5.js');

function rest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: 'api.derivws.com',
      port: 443,
      path,
      headers: {
        'Deriv-App-ID': CONFIG.appId,
        'Authorization': 'Bearer ' + CONFIG.apiToken,
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {})
      },
      timeout: 15000
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const accRes = await rest('GET', '/trading/v1/options/accounts');
  const acct = (accRes.body?.data || []).find(a => (a.account_type || '').toLowerCase() === 'demo') || accRes.body?.data?.[0];
  const otpRes = await rest('POST', `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
  const wsUrl = otpRes.body?.data?.url;

  const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('timeout')), 20000); });

  let reqId = 0;
  const pending = new Map();
  ws.on('message', d => {
    let msg; try { msg = JSON.parse(d.toString()); } catch { return; }
    const cb = pending.get(msg.req_id);
    pending.delete(msg.req_id);
    if (cb) cb(msg);
  });
  const send = (p) => new Promise(resolve => {
    const id = ++reqId;
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); } }, 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ ...p, req_id: id }));
  });

  // Check every combination
  for (const sym of ['BOOM500', 'BOOM1000', 'CRASH500', 'CRASH1000']) {
    for (const gr of [0.05, 0.03, 0.01]) {
      const res = await send({
        proposal: 1, amount: 1, basis: 'stake', contract_type: 'ACCU',
        currency: 'USD', underlying_symbol: sym, growth_rate: gr
      });
      const stays = res.proposal?.contract_details?.ticks_stayed_in || [];
      const maxTicks = res.proposal?.contract_details?.maximum_ticks || 0;
      if (!stays.length) { console.log(`${sym} g=${(gr*100).toFixed(0)}%  NO STAYS`); continue; }
      const sorted = [...stays].sort((a, b) => a - b);
      const N = CONFIG.plannedHoldTicks; // 20
      const reached = stays.filter(v => v >= N).length;
      const mean = stays.reduce((s, v) => s + v, 0) / stays.length;
      const med = sorted[Math.floor(sorted.length / 2)];
      console.log(
        `${sym} g=${(gr*100).toFixed(0)}%  maxTicks=${maxTicks} n=${stays.length}  ` +
        `mean=${mean.toFixed(1)} median=${med}  ` +
        `reached(N=${N})=${reached}/${stays.length} (${(reached/stays.length*100).toFixed(0)}%)  ` +
        `p25=${sorted[24]} p75=${sorted[74]} p90=${sorted[89]}`
      );
    }
  }
  ws.close();
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
