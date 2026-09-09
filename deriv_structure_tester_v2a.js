/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DERIV SYNTHETIC INDEX — STATISTICAL STRUCTURE TESTER  (v2)          ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║                                                                      ║
 * ║  CHANGELOG vs v1 — fixes two confirmed bugs found when reviewing     ║
 * ║  real BOOM50/CRASH50 output:                                         ║
 * ║                                                                      ║
 * ║  BUG #1 (baseline self-contamination): v1 used a 50-tick rolling     ║
 * ║  MAD window to define "normal" move size — comparable to the mean    ║
 * ║  spike spacing (~57 ticks). Right after a real spike, that huge      ║
 * ║  move sat inside the lookback window and inflated the baseline,      ║
 * ║  making the NEXT spike harder to detect for ~50 ticks. This alone    ║
 * ║  explained the suppressed hazard in the first hazard bucket.         ║
 * ║  FIX: the baseline is now a stable value recomputed periodically     ║
 * ║  from a large trailing sample, with any tick within                  ║
 * ║  `excludeBufferAfterSpike` ticks of a known spike excluded from      ║
 * ║  that calculation — a spike can no longer contaminate its own        ║
 * ║  detection threshold.                                                ║
 * ║                                                                      ║
 * ║  BUG #2 (impossible bin): v1's `minSpikeSeparation: 5` guarantees    ║
 * ║  no interval can be < 5 ticks, but the chi-square test binned        ║
 * ║  against an UNSHIFTED geometric distribution whose first quantile    ║
 * ║  bin was (0, 4] — a bin that could never contain a single            ║
 * ║  observation. In the real output this single empty bin accounted    ║
 * ║  for ~70% of the "significant" chi-square statistic on both assets.  ║
 * ║  FIX: all three tests (dispersion/CV, chi-square, KS) now fit a      ║
 * ║  SHIFTED geometric distribution whose support correctly starts at    ║
 * ║  `minSpikeSeparation`, not 1.                                        ║
 * ║                                                                      ║
 * ║  NEW: Accumulator (ACCU) support.                                    ║
 * ║   - Checks live via `contracts_for` whether ACCU is actually         ║
 * ║     offered on the configured symbol before assuming anything.       ║
 * ║   - If available, pulls live proposals for growth rates 1–5% and     ║
 * ║     empirically compares each barrier against your real historical   ║
 * ║     tick data: what fraction of ORDINARY ticks would breach it       ║
 * ║     (vs. the theoretical zero-edge rate g/(1+g)), and what fraction  ║
 * ║     of DETECTED SPIKES would breach it (the number that matters for  ║
 * ║     connecting the spike-timing hypothesis to accumulator risk).     ║
 * ║                                                                      ║
 * ║  THIS SCRIPT DOES NOT TRADE. Read-only historical + proposal calls.  ║
 * ║                                                                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const WebSocket = require('ws');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
    symbol: 'BOOM50',   // run once per symbol; also test 'CRASH50', etc.

    // ── Credentials — PAT/OTP flow auto-detected (aligned with accuPULSE3.js) ─
    // Set DERIV_API_TOKEN env var or edit here. Supports classic token OR "pat_..." .
    apiToken: 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
    demoToken: null, // legacy alias — if apiToken empty, demoToken is used
    appId: '33uslPtthXBEkQOdfKfoY',
    wsUrl: 'wss://ws.derivws.com/websockets/v3',
    accountType: 'demo',

    targetTicks: 80000,
    batchSize: 5000,
    requestDelayMs: 400,

    // ── Spike / event detection ──────────────────────────────────────────
    minSpikeSeparation: 2,      // now safe to keep low — tests account for it
    spikeThresholdMAD: 10,
    spikeDirection: 'both',     // 'up' | 'down' | 'both' | 'auto'

    // ── Baseline (fixed, contamination-resistant) ───────────────────────
    baselineWindow: 2000,         // ticks used to compute each baseline recalculation
    recomputeBaselineEvery: 2000, // how often the baseline is refreshed
    excludeBufferAfterSpike: 20,  // ticks after a spike excluded from baseline calc

    hazardBuckets: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, Infinity],

    // ── Accumulator analysis ─────────────────────────────────────────────
    accumulator: {
        growthRates: [0.01, 0.02, 0.03, 0.04, 0.05],
        testStake: 10, // only used to request price quotes, nothing is bought
    },

    outputFile: path.join(__dirname, `structure_report_v2_${Date.now()}.json`),
};

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION — auto-detects classic token vs PAT/Options-API token
// (copied from deriv_structure_tester_v2.js / accuPULSE3.js _newApiConnect)
// ═══════════════════════════════════════════════════════════════════════════
function isPatToken(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
}

class RestClient {
    constructor(baseUrl, appId, token) {
        this.baseUrl = baseUrl || 'https://api.derivws.com';
        this.appId = appId || '1089';
        this.token = token || '';
    }
    _request(method, reqPath, body = null) {
        return new Promise((resolve, reject) => {
            let url;
            try { url = new URL(reqPath, this.baseUrl); } catch (e) {
                return reject(new Error(`Invalid URL: ${reqPath}`));
            }
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : require('http');
            const opts = {
                method,
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                headers: {
                    'Deriv-App-ID': this.appId,
                    'Authorization': 'Bearer ' + this.token,
                    'Accept': 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                timeout: 15000,
            };
            const req = lib.request(opts, res => {
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
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }
    get(p) { return this._request('GET', p); }
    post(p, b) { return this._request('POST', p, b); }
}

/**
 * Resolves the correct WebSocket URL + auth mode for the configured token.
 * Returns { url, needsAuthorize, isPat, account? }.
 */
async function resolveConnection(cfg) {
    const token = cfg.apiToken || cfg.demoToken || null;
    if (!token) {
        const sep = cfg.wsUrl.includes('?') ? '&' : '?';
        return { url: `${cfg.wsUrl}${sep}app_id=${encodeURIComponent(cfg.appId)}`, needsAuthorize: false, isPat: false, noToken: true };
    }
    if (!isPatToken(token)) {
        const sep = cfg.wsUrl.includes('?') ? '&' : '?';
        return { url: `${cfg.wsUrl}${sep}app_id=${encodeURIComponent(cfg.appId)}`, needsAuthorize: true, isPat: false, token };
    }
    // PAT token → REST account lookup + OTP handshake (Deriv's Options API) — aligned with accuPULSE3.js _newApiConnect
    const rest = new RestClient('https://api.derivws.com', cfg.appId, token);
    const accRes = await rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
        const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
        throw new Error(`Account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found for this token');
    const desired = (cfg.accountType || 'demo').toLowerCase();
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desired) || accounts[0];
    const otpRes = await rest.post(`/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`);
    if (otpRes.status !== 200) throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP response missing data.url');
    return { url: wsUrl, needsAuthorize: false, isPat: true, account: acct, token };
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET HELPERS
// ═══════════════════════════════════════════════════════════════════════════
let reqIdCounter = 1;

function send(ws, req) {
    return new Promise((resolve, reject) => {
        const req_id = reqIdCounter++;
        const listener = (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch (e) { return; }
            if (msg.req_id === req_id) {
                ws.removeListener('message', listener);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg);
            }
        };
        ws.on('message', listener);
        ws.send(JSON.stringify({ ...req, req_id }));
    });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function collectTicks(ws, symbol, targetCount, batchSize, delayMs) {
    let allTimes = [];
    let allPrices = [];
    let endParam = 'latest';

    while (allTimes.length < targetCount) {
        const req = { ticks_history: symbol, style: 'ticks', count: batchSize, end: endParam, adjust_start_time: 1 };
        const msg = await send(ws, req);
        const times = msg.history?.times ?? [];
        const prices = (msg.history?.prices ?? []).map(Number);
        if (times.length === 0) break;

        allTimes = [...times, ...allTimes];
        allPrices = [...prices, ...allPrices];
        process.stdout.write(`\r  Collected ${allTimes.length} / ${targetCount} ticks...`);

        if (times.length < batchSize) break;
        endParam = times[0] - 1;
        await sleep(delayMs);
    }
    console.log('');
    return { times: allTimes, prices: allPrices };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPIKE / EVENT DETECTION  (contamination-resistant baseline)
// ═══════════════════════════════════════════════════════════════════════════
function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectSpikes(prices, cfg, symbol) {
    const n = prices.length;
    const diffs = new Array(n).fill(0);
    for (let i = 1; i < n; i++) diffs[i] = prices[i] - prices[i - 1];

    let direction = cfg.spikeDirection;
    if (direction === 'auto') {
        const upperSym = symbol.toUpperCase();
        if (upperSym.includes('BOOM')) direction = 'up';
        else if (upperSym.includes('CRASH')) direction = 'down';
        else direction = 'both';
    }

    const excludedFromBaseline = new Uint8Array(n);
    const spikeIndices = [];
    let lastSpike = -Infinity;
    let baseline = null;
    let lastBaselineRecompute = -Infinity;

    for (let i = cfg.baselineWindow; i < n; i++) {
        if (baseline === null || i - lastBaselineRecompute >= cfg.recomputeBaselineEvery) {
            const windowStart = i - cfg.baselineWindow;
            const clean = [];
            for (let j = windowStart; j < i; j++) {
                if (!excludedFromBaseline[j]) clean.push(Math.abs(diffs[j]));
            }
            if (clean.length >= 30) {
                const med = median(clean);
                const absDevs = clean.map(v => Math.abs(v - med));
                baseline = median(absDevs) || 1e-9;
            }
            lastBaselineRecompute = i;
        }
        if (baseline === null) continue;

        const move = diffs[i];
        const magnitude = Math.abs(move) / baseline;
        const directionOK = direction === 'both' ? true : direction === 'up' ? move > 0 : move < 0;

        if (directionOK && magnitude >= cfg.spikeThresholdMAD) {
            if (i - lastSpike >= cfg.minSpikeSeparation) {
                spikeIndices.push(i);
                lastSpike = i;
                for (let k = i; k < Math.min(n, i + cfg.excludeBufferAfterSpike); k++) {
                    excludedFromBaseline[k] = 1;
                }
            }
        }
    }
    return { spikeIndices, direction, diffs };
}

function computeIntervals(spikeIndices) {
    const intervals = [];
    for (let i = 1; i < spikeIndices.length; i++) intervals.push(spikeIndices[i] - spikeIndices[i - 1]);
    return intervals;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL MACHINERY
// ═══════════════════════════════════════════════════════════════════════════
function gammln(xx) {
    const cof = [
        76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let x = xx, y = xx;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) { y += 1; ser += cof[j] / y; }
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

const ITMAX = 200, EPS = 3e-9, FPMIN = 1e-300;

function gammaP(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 0;
    if (x < a + 1) {
        const gln = gammln(a);
        let ap = a, sum = 1 / a, del = sum;
        for (let n = 1; n <= ITMAX; n++) {
            ap += 1; del *= x / ap; sum += del;
            if (Math.abs(del) < Math.abs(sum) * EPS) break;
        }
        return sum * Math.exp(-x + a * Math.log(x) - gln);
    } else {
        const gln = gammln(a);
        let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
        for (let i = 1; i <= ITMAX; i++) {
            const an = -i * (i - a);
            b += 2;
            d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
            c = b + an / c;  if (Math.abs(c) < FPMIN) c = FPMIN;
            d = 1 / d;
            const del = d * c;
            h *= del;
            if (Math.abs(del - 1) < EPS) break;
        }
        const Q = Math.exp(-x + a * Math.log(x) - gln) * h;
        return 1 - Q;
    }
}

function chiSquarePValue(chiSq, df) { return 1 - gammaP(df / 2, chiSq / 2); }

function erf(x) {
    const sign = x < 0 ? -1 : 1; x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
          a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}
function normalCDF(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

// ── Dispersion / CV — now shift-aware ───────────────────────────────────────
function dispersionStats(intervals, floor) {
    const shifted = intervals.map(v => v - floor + 1);
    const n = shifted.length;
    const sMean = shifted.reduce((s, v) => s + v, 0) / n;
    const variance = shifted.reduce((s, v) => s + (v - sMean) ** 2, 0) / (n - 1);
    const cv = Math.sqrt(variance) / sMean;
    const pHat = 1 / sMean;
    const theoreticalCV = Math.sqrt(1 - pHat);
    return { n, mean: sMean + floor - 1, shiftedMean: sMean, variance, cv, theoreticalCV, pHat, floor };
}

// ── Chi-square GOF — now shift-aware (fixes the impossible-bin bug) ───────
function chiSquareGoodnessOfFitGeometric(intervals, floor) {
    const shifted = intervals.map(v => v - floor + 1);
    const n = shifted.length;
    const mean = shifted.reduce((s, v) => s + v, 0) / n;
    const pHat = 1 / mean;

    const numBins = Math.max(5, Math.min(15, Math.floor(n / 8)));
    const bins = [];
    for (let i = 1; i < numBins; i++) {
        const target = i / numBins;
        let k = Math.ceil(Math.log(1 - target) / Math.log(1 - pHat));
        if (bins.length && k <= bins[bins.length - 1]) k = bins[bins.length - 1] + 1;
        bins.push(k);
    }
    const edges = [0, ...bins, Infinity];

    const observed = new Array(numBins).fill(0);
    for (const v of shifted) {
        for (let b = 0; b < numBins; b++) {
            if (v > edges[b] && v <= edges[b + 1]) { observed[b]++; break; }
        }
    }
    const expected = new Array(numBins).fill(n / numBins);

    let chiSq = 0;
    for (let b = 0; b < numBins; b++) {
        const diff = observed[b] - expected[b];
        chiSq += (diff * diff) / expected[b];
    }
    const df = Math.max(numBins - 2, 1);
    const pValue = chiSquarePValue(chiSq, df);

    return { chiSq, df, pValue, numBins, observed, expected, pHat, mean: mean + floor - 1, floor };
}

// ── KS test — now shift-aware ────────────────────────────────────────────
function ksTestGeometric(intervals, floor) {
    const shifted = intervals.map(v => v - floor + 1);
    const n = shifted.length;
    const mean = shifted.reduce((s, v) => s + v, 0) / n;
    const pHat = 1 / mean;
    const sorted = [...shifted].sort((a, b) => a - b);

    let D = 0;
    for (let i = 0; i < n; i++) {
        const F = 1 - Math.pow(1 - pHat, sorted[i]);
        D = Math.max(D, Math.abs((i + 1) / n - F), Math.abs(i / n - F));
    }
    const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * D;
    let pValue = 0;
    for (let k = 1; k <= 100; k++) {
        pValue += (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
    }
    pValue = Math.max(0, Math.min(1, 2 * pValue));

    return { D, pValue, pHat, floor };
}

function hazardTable(intervals, bucketMultiples, mean, pHat) {
    const edges = bucketMultiples.map(m => (m === Infinity ? Infinity : Math.round(m * mean)));
    const rows = [];
    for (let i = 0; i < edges.length - 1; i++) {
        const lo = edges[i], hi = edges[i + 1];
        const survivors = intervals.filter(v => v >= lo).length;
        const events = intervals.filter(v => v >= lo && v < hi).length;
        const empiricalHazard = survivors > 0 ? events / survivors : null;
        const width = hi === Infinity ? null : hi - lo;
        const theoreticalHazard = width !== null ? 1 - Math.pow(1 - pHat, width) : null;
        rows.push({ range: `${lo}-${hi === Infinity ? '∞' : hi}`, survivors, events, empiricalHazard, theoreticalHazard });
    }
    return rows;
}

function runsTest(values) {
    const signs = values.filter(v => v !== 0).map(v => (v > 0 ? 1 : -1));
    const n1 = signs.filter(s => s === 1).length;
    const n2 = signs.filter(s => s === -1).length;
    const n = n1 + n2;
    let runs = 1;
    for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) runs++;
    const meanR = (2 * n1 * n2) / n + 1;
    const varR = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n ** 2 * (n - 1));
    const z = (runs - meanR) / Math.sqrt(varR);
    const pValue = 2 * (1 - normalCDF(Math.abs(z)));
    return { n1, n2, runs, meanR, z, pValue };
}

function lag1Autocorrelation(values) {
    const n = values.length;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n - 1; i++) num += (values[i] - mean) * (values[i + 1] - mean);
    for (let i = 0; i < n; i++) den += (values[i] - mean) ** 2;
    const r1 = num / den;
    const se = 1 / Math.sqrt(n);
    const z = r1 / se;
    const pValue = 2 * (1 - normalCDF(Math.abs(z)));
    return { r1, z, pValue, n };
}

function summarizeArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const n = arr.length;
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    return { n, mean, median: sorted[Math.floor(n / 2)], min: sorted[0], max: sorted[n - 1] };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCUMULATOR: AVAILABILITY CHECK + GROWTH-RATE BARRIER ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════
async function checkAccumulatorAvailability(ws, symbol) {
    console.log(`\n🔍 Checking contract availability for ${symbol} (contracts_for)...`);
    try {
        // Aligned with accuPULSE3.js: contracts_for does not take currency; OTP API rejects unknown props
        const msg = await send(ws, { contracts_for: symbol });
        const available = msg.contracts_for?.available ?? [];
        const types = [...new Set(available.map(c => c.contract_type))];
        const hasAccu = types.includes('ACCU');
        console.log(`  Contract types found: ${types.join(', ') || '(none returned)'}`);
        console.log(`  Accumulators (ACCU): ${hasAccu ? '✅ AVAILABLE' : '❌ NOT AVAILABLE'} on ${symbol}`);
        return hasAccu;
    } catch (e) {
        console.log(`  ⚠️  contracts_for check failed: ${e.message}`);
        console.log('  Proceeding, but the accumulator barrier analysis below may also fail.');
        return null; // unknown — let the proposal calls below settle it definitively
    }
}

async function analyzeAccumulatorBarriers(ws, symbol, cfg, diffs, prices, spikeIndices, symbolKey) {
    console.log('\n' + '─'.repeat(72));
    console.log('ACCUMULATOR GROWTH-RATE BARRIER ANALYSIS');
    console.log('─'.repeat(72));
    console.log('(Field names below are our best understanding of the ACCU proposal');
    console.log(' response. Raw JSON is printed per growth rate so you can verify.)\n');

    const percentMoves = [];
    for (let i = 1; i < prices.length; i++) percentMoves.push(diffs[i] / prices[i - 1]);
    const spikeSet = new Set(spikeIndices);

    const results = [];
    for (const g of cfg.growthRates) {
        let proposal;
        try {
            const effectiveKey = symbolKey || 'symbol';
            const msg = await send(ws, {
                proposal: 1,
                contract_type: 'ACCU',
                [effectiveKey]: symbol,
                amount: cfg.testStake,
                basis: 'stake',
                currency: 'USD',
                growth_rate: g,
            });
            proposal = msg.proposal;
        } catch (e) {
            console.log(`  Growth rate ${(g * 100).toFixed(0)}%: proposal error — ${e.message}`);
            results.push({ growthRate: g, available: false, error: e.message });
            continue;
        }

        const cd = proposal?.contract_details || {};
        console.log(`\n  Growth rate ${(g * 100).toFixed(0)}% — contract_details: ${JSON.stringify(cd)}`);

        const spot = parseFloat(cd.current_spot || 0);
        const distance = parseFloat(cd.barrier_spot_distance || 0);
        const highBarrier = parseFloat(cd.high_barrier || 0);
        const tickBarrierPct = parseFloat(cd.tick_size_barrier_percentage || 0);
        const maxPayout = parseFloat(cd.maximum_payout || 0);
        const ticksStayedIn = Array.isArray(cd.ticks_stayed_in) ? cd.ticks_stayed_in : null;

        let barrierPercent = null;
        if (tickBarrierPct > 0) barrierPercent = tickBarrierPct / 100;
        else if (spot > 0 && distance > 0) barrierPercent = distance / spot;
        else if (spot > 0 && highBarrier > 0) barrierPercent = Math.abs(highBarrier - spot) / spot;

        if (barrierPercent === null) {
            console.log('    ⚠️  Could not extract a barrier percentage — inspect contract_details above.');
            results.push({ growthRate: g, available: true, rawContractDetails: cd, barrierPercent: null });
            continue;
        }

        const fairKnockoutProb = g / (1 + g); // zero-edge per-tick knockout probability

        let ordinaryBreaches = 0, ordinaryCount = 0;
        let spikeBreaches = 0, spikeCount = 0;
        for (let i = 0; i < percentMoves.length; i++) {
            const tickIdx = i + 1;
            const breach = Math.abs(percentMoves[i]) > barrierPercent;
            if (spikeSet.has(tickIdx)) { spikeCount++; if (breach) spikeBreaches++; }
            else { ordinaryCount++; if (breach) ordinaryBreaches++; }
        }
        const empOrdinary = ordinaryCount > 0 ? ordinaryBreaches / ordinaryCount : null;
        const empSpike = spikeCount > 0 ? spikeBreaches / spikeCount : null;
        const stayedSummary = summarizeArray(ticksStayedIn);

        console.log(`    Barrier                      : ±${(barrierPercent * 100).toFixed(6)}% per tick`);
        console.log(`    Max payout                   : ${maxPayout || 'n/a'}`);
        console.log(`    Fair (zero-edge) knockout     : ${(fairKnockoutProb * 100).toFixed(4)}% per tick`);
        console.log(`    Empirical ordinary knockout   : ${empOrdinary !== null ? (empOrdinary * 100).toFixed(4) + '%' : 'n/a'}`);
        console.log(`    Empirical SPIKE-tick knockout  : ${empSpike !== null ? (empSpike * 100).toFixed(2) + '%' : 'n/a'} (${spikeCount} spikes checked)`);
        console.log(`    Deriv's ticks_stayed_in sample : ${stayedSummary ? `n=${stayedSummary.n} mean=${stayedSummary.mean.toFixed(1)} median=${stayedSummary.median} range=[${stayedSummary.min},${stayedSummary.max}]` : 'not returned'}`);

        results.push({
            growthRate: g, available: true, barrierPercent, fairKnockoutProb, maxPayout,
            empiricalOrdinaryKnockoutProb: empOrdinary, empiricalSpikeKnockoutProb: empSpike,
            spikeCount, ordinaryCount, ticksStayedInSummary: stayedSummary,
        });
    }
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
    console.log('═'.repeat(72));
    console.log('  DERIV SYNTHETIC INDEX — STATISTICAL STRUCTURE TESTER (v2)');
    console.log('═'.repeat(72));
    console.log(`  Symbol       : ${CONFIG.symbol}`);
    console.log(`  Target ticks : ${CONFIG.targetTicks}`);
    console.log('═'.repeat(72));

    const conn = await resolveConnection(CONFIG);
    console.log(`\n🔌 Connecting (${conn.noToken ? 'no token — public data only' : conn.isPat ? 'PAT/OTP flow' : 'classic app_id flow'})...`);

    const ws = new WebSocket(conn.url, {
        headers: { 'User-Agent': 'AccuPULSE3/3.1 (+Node.js)' },
        handshakeTimeout: 15000,
    });
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        ws.on('unexpected-response', (_, res) => {
            try { res.destroy(); } catch (_) {}
            reject(new Error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`));
        });
    });

    if (conn.needsAuthorize) {
        console.log('\n🔑 Authorizing with token...');
        try {
            await send(ws, { authorize: conn.token });
            console.log('  ✅ Authorized');
        } catch (e) {
            console.log(`  ⚠️  Authorization failed: ${e.message} — continuing unauthorized`);
        }
    } else if (conn.isPat) {
        console.log(`  ✅ Connected via OTP session (account ${conn.account?.account_id || 'unknown'})`);
    }

    const symbolKey = conn.isPat ? 'underlying_symbol' : 'symbol';
    const accuAvailable = await checkAccumulatorAvailability(ws, CONFIG.symbol);

    console.log('\n📡 Collecting tick history...');
    const { times, prices } = await collectTicks(
        ws, CONFIG.symbol, CONFIG.targetTicks, CONFIG.batchSize, CONFIG.requestDelayMs
    );

    if (prices.length < 1000) {
        console.error('❌ Not enough tick data returned. Check the symbol code and try again.');
        ws.close();
        process.exit(1);
    }

    const hoursSpanned = (times[times.length - 1] - times[0]) / 3600;
    console.log(`✅ Collected ${prices.length} ticks spanning ${hoursSpanned.toFixed(1)} hours\n`);

    const report = { symbol: CONFIG.symbol, ticksCollected: prices.length, hoursSpanned, accumulatorAvailable: accuAvailable };

    // ── General randomness checks ────────────────────────────────────────
    console.log('─'.repeat(72));
    console.log('GENERAL RANDOMNESS CHECKS (raw tick-to-tick price moves)');
    console.log('─'.repeat(72));
    const rawDiffs = [];
    for (let i = 1; i < prices.length; i++) rawDiffs.push(prices[i] - prices[i - 1]);

    const runs = runsTest(rawDiffs);
    console.log(`Runs Test:              runs=${runs.runs}  expected=${runs.meanR.toFixed(1)}  z=${runs.z.toFixed(3)}  p=${runs.pValue.toFixed(4)}  ${runs.pValue < 0.05 ? '⚠️  NON-RANDOM sign pattern' : '✓  consistent with random signs'}`);
    const ac1 = lag1Autocorrelation(rawDiffs);
    console.log(`Lag-1 Autocorrelation:  r=${ac1.r1.toFixed(4)}  z=${ac1.z.toFixed(3)}  p=${ac1.pValue.toFixed(4)}  ${ac1.pValue < 0.05 ? '⚠️  SIGNIFICANT autocorrelation' : '✓  no significant autocorrelation'}\n`);
    report.runsTest = runs;
    report.autocorrelation = ac1;

    // ── Spike/event timing analysis ──────────────────────────────────────
    console.log('─'.repeat(72));
    console.log('SPIKE / EVENT TIMING ANALYSIS  (contamination-resistant baseline)');
    console.log('─'.repeat(72));

    const { spikeIndices, direction, diffs } = detectSpikes(prices, CONFIG, CONFIG.symbol);
    console.log(`Spike direction filter : ${direction}`);
    console.log(`Spikes detected        : ${spikeIndices.length}`);
    report.spikeDirection = direction;
    report.spikesDetected = spikeIndices.length;

    if (spikeIndices.length < 20) {
        console.log('\n⚠️  Too few spikes detected for reliable interval statistics.\n');
    } else {
        const intervals = computeIntervals(spikeIndices);
        const floor = CONFIG.minSpikeSeparation;
        const disp = chiSquareAwareDispersion(intervals, floor);

        console.log(`\nInterval count          : ${intervals.length}`);
        console.log(`Mean spacing            : ${disp.mean.toFixed(1)} ticks`);
        console.log(`Coefficient of Variation: ${disp.cv.toFixed(3)}  (shifted-geometric expects ≈ ${disp.theoreticalCV.toFixed(3)})`);
        if (disp.cv < disp.theoreticalCV * 0.85) {
            console.log('  → CV notably BELOW expectation: spacing more REGULAR than memoryless — possible structure.');
        } else if (disp.cv > disp.theoreticalCV * 1.15) {
            console.log('  → CV notably ABOVE expectation: events CLUSTER more than memoryless — possible burstiness.');
        } else {
            console.log('  → CV consistent with memoryless spacing once the separation floor is accounted for.');
        }

        const chiSq = chiSquareGoodnessOfFitGeometric(intervals, floor);
        console.log(`\nChi-Square GOF (shifted) : χ²=${chiSq.chiSq.toFixed(2)}  df=${chiSq.df}  p=${chiSq.pValue.toFixed(4)}  ${chiSq.pValue < 0.05 ? '⚠️  REJECTS memoryless' : '✓  fails to reject memoryless'}`);
        console.log(`  Bin 0 observed: ${chiSq.observed[0]} (expected ${chiSq.expected[0].toFixed(1)}) — should no longer be forced to 0`);

        const ks = ksTestGeometric(intervals, floor);
        console.log(`KS Test (shifted)        : D=${ks.D.toFixed(4)}  p=${ks.pValue.toFixed(4)}  ${ks.pValue < 0.05 ? '⚠️  REJECTS memoryless' : '✓  fails to reject memoryless'}`);

        console.log('\nHazard Table:');
        console.log('  Range (ticks)      Survivors  Events   Empirical Hazard   Theoretical Hazard');
        const hazard = hazardTable(intervals, CONFIG.hazardBuckets, disp.mean, disp.pHat);
        hazard.forEach(row => {
            const emp  = row.empiricalHazard   !== null ? row.empiricalHazard.toFixed(4)   : 'n/a';
            const theo = row.theoreticalHazard !== null ? row.theoreticalHazard.toFixed(4) : 'n/a';
            console.log(`  ${row.range.padEnd(18)} ${String(row.survivors).padEnd(10)} ${String(row.events).padEnd(8)} ${emp.padEnd(19)} ${theo}`);
        });

        report.intervals = { count: intervals.length, mean: disp.mean, cv: disp.cv, theoreticalCV: disp.theoreticalCV, floor };
        report.chiSquareTest = chiSq;
        report.ksTest = ks;
        report.hazardTable = hazard;

        const structureFound = chiSq.pValue < 0.05 || ks.pValue < 0.05;
        console.log(`\n${structureFound ? '⚠️  Still shows possible structure after fixes — worth an out-of-sample split.' : '✓  No significant deviation from memoryless once the bugs are fixed.'}`);
        report.verdict = structureFound ? 'possible_structure_needs_validation' : 'no_structure_detected';

        // ── Accumulator barrier analysis ───────────────────────────────────
        if (accuAvailable === false) {
            console.log('\n(Skipping accumulator barrier analysis — ACCU not available on this symbol.)');
            report.accumulatorAnalysis = null;
        } else {
            const accuResults = await analyzeAccumulatorBarriers(
                ws, CONFIG.symbol, CONFIG.accumulator, diffs, prices, spikeIndices, symbolKey
            );
            report.accumulatorAnalysis = accuResults;
        }
    }

    ws.close();
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(report, null, 2));
    console.log(`\n📁 Full report saved to: ${CONFIG.outputFile}`);
}

// Small alias so main() reads cleanly — same function as dispersionStats
function chiSquareAwareDispersion(intervals, floor) { return dispersionStats(intervals, floor); }

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
