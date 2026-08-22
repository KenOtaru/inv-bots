#!/usr/bin/env node
'use strict';
/**
 * Diagnostic probe: what does the Deriv API actually return for ACCU
 * proposals on Boom/Crash symbols? Read-only — sends proposal requests,
 * never buys. Run: node probe_bc_accu.js
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
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
  console.log('=== Boom/Crash ACCU probe (read-only) ===\n');

  // 1. Get demo account + OTP ws url (same flow as the bot)
  const accRes = await rest('GET', '/trading/v1/options/accounts');
  if (accRes.status !== 200) {
    console.log('ACCOUNT LIST FAILED:', JSON.stringify(accRes).slice(0, 500));
    process.exit(1);
  }
  const accounts = accRes.body?.data || [];
  const acct = accounts.find(a => (a.account_type || '').toLowerCase() === 'demo') || accounts[0];
  console.log(`Account: ${acct.account_id} (${acct.account_type}) bal=${acct.balance}`);

  const otpRes = await rest('POST', `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
  const wsUrl = otpRes.body?.data?.url;
  if (!wsUrl) {
    console.log('OTP FAILED:', JSON.stringify(otpRes.body).slice(0, 500));
    process.exit(1);
  }

  // 2. Connect and make proposal calls
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 20000);
  });
  console.log('WS connected\n');

  let reqId = 0;
  const pending = new Map();
  ws.on('message', d => {
    let msg; try { msg = JSON.parse(d.toString()); } catch { return; }
    if (msg.req_id && pending.has(msg.req_id)) {
      const p = pending.get(msg.req_id);
      pending.delete(msg.req_id);
      p(msg);
    }
  });
  const send = (payload) => new Promise(resolve => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); }
    }, 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ ...payload, req_id: id }));
  });

  const tests = [
    ['ACCU / underlying_symbol / gr=0.03', {
      proposal: 1, amount: 1, basis: 'stake', contract_type: 'ACCU',
      currency: 'USD', underlying_symbol: 'BOOM500', growth_rate: 0.03
    }],
    ['ACCU / symbol / gr=0.03', {
      proposal: 1, amount: 1, basis: 'stake', contract_type: 'ACCU',
      currency: 'USD', symbol: 'BOOM500', growth_rate: 0.03
    }],
    ['ACCU / underlying_symbol / CRASH500', {
      proposal: 1, amount: 1, basis: 'stake', contract_type: 'ACCU',
      currency: 'USD', underlying_symbol: 'CRASH500', growth_rate: 0.03
    }],
    ['CALL (RISE) / symbol / BOOM500 5t', {
      proposal: 1, amount: 1, basis: 'stake', contract_type: 'CALL',
      currency: 'USD', symbol: 'BOOM500', duration: 5, duration_unit: 't'
    }],
  ];

  for (const [label, payload] of tests) {
    console.log(`\n──── ${label}`);
    const res = await send(payload);
    if (res.__timeout) { console.log('TIMEOUT'); continue; }
    if (res.error) {
      console.log(`ERROR ${res.error.code}: ${res.error.message}`);
    } else if (res.proposal) {
      const p = res.proposal;
      console.log(`OK id=${p.id} spot=${p.spot} payout=${p.payout} ask=${p.ask_price}`);
      console.log('contract_details =', JSON.stringify(p.contract_details, null, 2));
    } else {
      console.log('UNEXPECTED:', JSON.stringify(res).slice(0, 600));
    }
  }

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
