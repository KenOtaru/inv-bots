#!/usr/bin/env node
'use strict';
/**
 * Live end-to-end check: fetch REAL ACCU proposals for every BC asset and
 * run them through the bot's actual analyzer. Read-only — never buys.
 * Run: node probe_bc_live_eval.js
 */
const WebSocket = require('ws');
const https = require('https');
const { CONFIG, EnhancedARCAAnalyzer } = require('./accuPULSE3BC_v5.js');

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
  const accounts = accRes.body?.data || [];
  const acct = accounts.find(a => (a.account_type || '').toLowerCase() === 'demo') || accounts[0];
  const otpRes = await rest('POST', `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
  const wsUrl = otpRes.body?.data?.url;

  const ws = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('ws open timeout')), 20000);
  });

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

  const analyzer = new EnhancedARCAAnalyzer(CONFIG);
  console.log(`=== Live evaluation of ${CONFIG.assets.length} BC assets × ${CONFIG.candidateGrowthRates.length} growth rates ===\n`);

  let passCount = 0;
  let failReasons = {};

  for (const sym of CONFIG.assets) {
    // Backfill ticks for the secondary regime check (like the bot does)
    const hist = await send({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' });
    const prices = hist.history?.prices || [];
    const times = hist.history?.times || [];
    const ticks = times.map((t, i) => ({ epoch: +t, quote: parseFloat(prices[i]) }));

    for (const gr of CONFIG.candidateGrowthRates) {
      const res = await send({
        proposal: 1, amount: 1, basis: 'stake', contract_type: 'ACCU',
        currency: 'USD', underlying_symbol: sym, growth_rate: gr
      });
      if (res.error || !res.proposal) {
        console.log(`${sym} g=${(gr*100).toFixed(0)}%  ERROR ${res.error?.code || 'no proposal'}`);
        continue;
      }
      const cd = res.proposal.contract_details || {};
      const proposalStays = Array.isArray(cd.ticks_stayed_in) ? { ticks_stayed_in: cd.ticks_stayed_in } : null;
      const m = analyzer.evaluateProposal(ticks, gr, res.proposal, sym, proposalStays);
      if (m.ok) passCount++;
      else failReasons[m.reason] = (failReasons[m.reason] || 0) + 1;

      const staysN = Array.isArray(cd.ticks_stayed_in) ? cd.ticks_stayed_in.length : 0;
      if (m.ok || ['EV_BELOW_HAIRCUT','SURVIVAL_BELOW_FLOOR'].includes(m.reason)) {
        console.log(
          `${sym} g=${(gr*100).toFixed(0)}%  ` +
          (m.ok
            ? `PASS EV=${(m.conservativeEV*100).toFixed(2)}% pReach=${(m.reachRate*100).toFixed(0)}% n=${m.staySamples||0}`
            : `REJECT ${m.reason}  EV=${((m.conservativeEV||0)*100).toFixed(2)}% pHorizon=${((m.pHorizon)||0).toFixed(3)} n=${m.staySamples||0}`) +
          `  [stays=${staysN}]`
        );
      } else {
        console.log(`${sym} g=${(gr*100).toFixed(0)}%  REJECT ${m.reason}  [stays=${staysN}]`);
      }
    }
  }

  console.log(`\n=== RESULT: ${passCount}/${CONFIG.assets.length * CONFIG.candidateGrowthRates.length} candidates would pass the EV gate ===`);
  if (Object.keys(failReasons).length) {
    console.log('Rejection breakdown:', JSON.stringify(failReasons));
  }
  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
