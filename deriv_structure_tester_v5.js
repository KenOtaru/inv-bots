/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DERIV SYNTHETIC INDEX — STATISTICAL STRUCTURE TESTER  (v4)          ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║                                                                      ║
 * ║  NEW IN v5: FIXES TWO BUGS FOUND BY RUNNING v4 ON ALL SIX             ║
 * ║  BOOM/CRASH SYMBOLS — every symbol came back "significant," which     ║
 * ║  is itself the tell (a real effect should not be universal AND       ║
 * ║  should decay, not grow for 150+ ticks as CRASH600 did).             ║
 * ║                                                                      ║
 * ║  BUG (pseudo-replication): v4's control group sampled windows every  ║
 * ║  few ticks, but each window is `horizon` ticks long — adjacent       ║
 * ║  windows shared 95%+ of their data. Treating ~8,000 of these         ║
 * ║  massively overlapping windows as 8,000 independent samples          ║
 * ║  deflated the standard error enormously, making the t-test flag      ║
 * ║  "significant" results that were mostly statistical illusion.       ║
 * ║  FIX: control windows are now NON-OVERLAPPING (each starts a full    ║
 * ║  horizon-length after the last accepted one).                        ║
 * ║                                                                      ║
 * ║  BUG (contaminated windows): `horizon` (200 ticks) is not small      ║
 * ║  relative to the mean spike spacing for any of these six symbols     ║
 * ║  (ratios of 2.3–4.6×), so a large fraction (20–35%) of "post-spike"  ║
 * ║  windows actually contained a SECOND, unrelated spike partway        ║
 * ║  through — contaminating "what happens after a spike" with "what     ║
 * ║  happens when spikes cluster." This is the likely cause of           ║
 * ║  CRASH600's implausible late, growing divergence.                    ║
 * ║  FIX: both event AND control windows are now excluded unless they    ║
 * ║  are "clean" — no spike anywhere within their own horizon — so the   ║
 * ║  comparison is honestly apples-to-apples.                            ║
 * ║                                                                      ║
 * ║  Expect much smaller sample counts than v4 reported. That's the      ║
 * ║  correct, honest cost of removing an illusion rather than a signal.  ║
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
    symbol: 'CRASH1000',  // BOOM500, CRASH500, BOOM1000, CRASH1000, BOOM300, CRASH300

    apiToken: 'pat_cb2016855b5e6c61ac95f94432192dd6ed86bec7f7454e575d3fe1ed9f617692',
    appId: '33uslPtthXBEkQOdfKfoY',
    wsUrl: 'wss://ws.derivws.com/websockets/v3',
    accountType: 'demo',

    targetTicks: 80000,
    batchSize: 5000,
    requestDelayMs: 400,

    minSpikeSeparation: 2,
    spikeThresholdMAD: 10,
    spikeDirection: 'auto',

    baselineWindow: 2000,
    recomputeBaselineEvery: 2000,
    excludeBufferAfterSpike: 20,

    hazardBuckets: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, Infinity],

    accumulator: {
        growthRates: [0.01, 0.02, 0.03, 0.04, 0.05],
        testStake: 10,
    },

    // ── Post-spike event-study ────────────────────────────────────────────
    postSpike: {
        horizon: 200,            // ticks after a spike to analyze
        maxControlSamples: 8000, // cap control-group size for tractability
        printEveryNthOffset: 10, // console table granularity (full detail saved to JSON)
    },

    outputFile: path.join(__dirname, `structure_report_v5_${Date.now()}.json`),
};

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION  (unchanged from v3)
// ═══════════════════════════════════════════════════════════════════════════
function isPatToken(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_-]{16,}$/i.test(token.trim());
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
    if (!cfg.apiToken) {
        const sep = cfg.wsUrl.includes('?') ? '&' : '?';
        return { url: `${cfg.wsUrl}${sep}app_id=${encodeURIComponent(cfg.appId)}`, needsAuthorize: false, isPat: false, noToken: true };
    }

    if (!isPatToken(cfg.apiToken)) {
        const sep = cfg.wsUrl.includes('?') ? '&' : '?';
        return { url: `${cfg.wsUrl}${sep}app_id=${encodeURIComponent(cfg.appId)}`, needsAuthorize: true, isPat: false };
    }

    // PAT token → REST account lookup + OTP handshake (Deriv's Options API) — aligned with v4 / accuPULSE3.js _newApiConnect
    const rest = new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken);
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

    return { url: wsUrl, needsAuthorize: false, isPat: true, account: acct };
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET HELPERS  (ported from v4 for robust max-data fetch)
 // ═══════════════════════════════════════════════════════════════════════════
let reqIdCounter = 1;

function send(ws, req, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const req_id = reqIdCounter++;
        const timer = setTimeout(() => {
            ws.removeListener('message', listener);
            reject(new Error(`Request timeout (ticks_history)`));
        }, timeoutMs);
        const listener = (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch (e) { return; }
            if (msg.req_id === req_id) {
                clearTimeout(timer);
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

/**
 * Deep historical backfill — ported from v4 / v2 / accurateDiffer2.js:963 / accuAPEX.js:714
 * Deriv ticks_history returns up to 5000 ticks per call (currently capped at
 * ~1000 on BOOM/CRASH via PAT/OTP). We chain calls backwards using
 * end = earliest epoch - 1 (as String). Returns oldest→newest.
 * Fetches as much as possible up to targetCount, stopping only when server
 * returns short/empty batch or pagination fails.
 * Note: effective batch is capped at 1000 to avoid premature
 * 'short batch = exhausted' break when server caps at 1000.
 */
async function collectTicks(ws, symbol, targetCount, batchSize = 5000, delayMs = 200) {
    const outTimes = [];
    const outPrices = [];
    let remain = targetCount;
    let end = 'latest';
    let lastEpoch = null;
    const DERIV_MAX_TICKS_PER_CALL = 1000; // observed cap on PAT/OTP (was 5000)

    while (remain > 0) {
        const count = Math.min(batchSize, DERIV_MAX_TICKS_PER_CALL, remain);
        let msg;
        try {
            msg = await send(ws, { ticks_history: symbol, count, end, style: 'ticks' }, 30000);
        } catch (e) {
            console.log(`\n  ⚠️  collectTicks batch failed: ${e.message} — stopping at ${outTimes.length} ticks`);
            break;
        }
        const times = msg.history?.times ?? [];
        const prices = (msg.history?.prices ?? []).map(Number);
        if (!times.length) {
            console.log(`\n  (server returned 0 more ticks — Deriv history exhausted at ${outTimes.length} ticks)`);
            break;
        }
        if (lastEpoch !== null && times.length && times[times.length - 1] >= lastEpoch) {
            console.log(`\n  (server did not honor pagination — history exhausted at ${outTimes.length} ticks)`);
            break;
        }
        if (times.length) lastEpoch = times[0];
        outTimes.unshift(...times);
        outPrices.unshift(...prices);
        remain -= times.length;
        process.stdout.write(`\r  Collected ${outTimes.length} / ${targetCount} ticks...`);
        end = String(times[0] - 1);
        await sleep(delayMs);
        if (times.length < count) {
            console.log(`\n  (last batch short: ${times.length}/${count} — Deriv history exhausted at ${outTimes.length} ticks)`);
            break;
        }
    }
    console.log('');
    return { times: outTimes, prices: outPrices };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPIKE / EVENT DETECTION  (unchanged from v2/v3)
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
// STATISTICAL MACHINERY  (unchanged from v2/v3)
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
// NEW: POST-SPIKE EVENT-STUDY ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════
function buildPostEventPaths(prices, startIndices, horizon) {
    const paths = [];
    for (const idx of startIndices) {
        if (idx + horizon >= prices.length) continue;
        const base = prices[idx];
        const path = new Array(horizon);
        for (let k = 1; k <= horizon; k++) path[k - 1] = (prices[idx + k] - base) / base;
        paths.push(path);
    }
    return paths;
}

function pathStatsAtOffset(paths, k) {
    const vals = paths.map(p => p[k - 1]);
    const n = vals.length;
    const mean = vals.reduce((s, v) => s + v, 0) / n;
    const variance = n > 1 ? vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
    return { n, mean, variance };
}

function welchTTestApprox(stat1, stat2) {
    const se2 = stat1.variance / stat1.n + stat2.variance / stat2.n;
    const se = Math.sqrt(se2);
    const z = se > 0 ? (stat1.mean - stat2.mean) / se : 0;
    // Normal approximation to Welch's t — valid here given large n (hundreds to thousands)
    const pValue = 2 * (1 - normalCDF(Math.abs(z)));
    return { z, pValue, diff: stat1.mean - stat2.mean, se };
}

function analyzePostSpikeBehavior(prices, spikeIndices, cfg) {
    const horizon = cfg.horizon;
    const n = prices.length;

    // Distance from each tick to the NEXT spike at or after it (Infinity if none).
    // Used to require "clean" windows — no spike anywhere inside the horizon —
    // for BOTH groups, so the comparison is honestly apples-to-apples.
    const dist = new Array(n).fill(Infinity);
    {
        let ptr = 0;
        for (let i = 0; i < n; i++) {
            while (ptr < spikeIndices.length && spikeIndices[ptr] < i) ptr++;
            dist[i] = ptr < spikeIndices.length ? spikeIndices[ptr] - i : Infinity;
        }
    }

    // EVENT windows: start exactly at a spike, keep only if the NEXT spike after
    // this one is more than `horizon` ticks away (no contamination from a second spike).
    let excludedContaminatedEvents = 0;
    const eventStarts = [];
    for (let s = 0; s < spikeIndices.length; s++) {
        const idx = spikeIndices[s];
        if (idx + horizon >= n) continue;
        const nextSpikeGap = s + 1 < spikeIndices.length ? spikeIndices[s + 1] - idx : Infinity;
        if (nextSpikeGap > horizon) eventStarts.push(idx);
        else excludedContaminatedEvents++;
    }

    // CONTROL windows: NON-OVERLAPPING (jump a full horizon after each accepted
    // window), not within `horizon` ticks after a prior spike, AND clean (no
    // spike anywhere inside their own horizon either).
    const inPostSpikeWindow = new Uint8Array(n);
    for (const s of spikeIndices) {
        for (let k = s + 1; k <= Math.min(n - 1, s + horizon); k++) inPostSpikeWindow[k] = 1;
    }

    const controlStarts = [];
    let cursor = 0;
    while (cursor < n - horizon) {
        const clean = !inPostSpikeWindow[cursor] && dist[cursor] > horizon;
        if (clean) {
            controlStarts.push(cursor);
            cursor += horizon; // non-overlapping: full jump, not a small stride
        } else {
            cursor += 1;
        }
    }
    const finalControlStarts = controlStarts.length > cfg.maxControlSamples
        ? controlStarts.filter((_, i) => i % Math.ceil(controlStarts.length / cfg.maxControlSamples) === 0)
        : controlStarts;

    const eventPaths = buildPostEventPaths(prices, eventStarts, horizon);
    const controlPaths = buildPostEventPaths(prices, finalControlStarts, horizon);

    const bonferroniThreshold = 0.05 / horizon;
    const rows = [];
    let anySignificant = false;
    let firstSignificantOffset = null;

    for (let k = 1; k <= horizon; k++) {
        const evStat = pathStatsAtOffset(eventPaths, k);
        const ctrlStat = pathStatsAtOffset(controlPaths, k);
        const test = welchTTestApprox(evStat, ctrlStat);
        const significant = test.pValue < bonferroniThreshold;
        if (significant) {
            anySignificant = true;
            if (firstSignificantOffset === null) firstSignificantOffset = k;
        }
        rows.push({
            offset: k,
            eventMeanPct: evStat.mean * 100,
            controlMeanPct: ctrlStat.mean * 100,
            diffPct: test.diff * 100,
            z: test.z,
            pValue: test.pValue,
            significant,
        });
    }

    return {
        horizon, eventCount: eventPaths.length, controlCount: controlPaths.length,
        excludedContaminatedEvents, totalSpikes: spikeIndices.length,
        bonferroniThreshold, anySignificant, firstSignificantOffset, rows,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOL / ACCUMULATOR AVAILABILITY  (unchanged from v3)
// ═══════════════════════════════════════════════════════════════════════════
async function checkSymbolAvailability(ws, symbol) {
    console.log(`\n🔍 Verifying symbol "${symbol}" (active_symbols + contracts_for)...`);
    let foundInActive = null;
    try {
        const msg = await send(ws, { active_symbols: 'brief' });
        const list = msg.active_symbols ?? [];
        const keys = list.map(s => s.underlying_symbol || s.symbol).filter(Boolean);
        foundInActive = keys.includes(symbol);
        console.log(`  active_symbols: ${foundInActive ? '✅ found' : '❌ NOT found'} (${keys.length} symbols returned)`);
        if (!foundInActive) {
            const related = keys.filter(k => k.toUpperCase().includes('BOOM') || k.toUpperCase().includes('CRASH'));
            console.log(`  Boom/Crash symbols Deriv actually returned: ${related.join(', ') || '(none)'}`);
        }
    } catch (e) {
        console.log(`  ⚠️  active_symbols failed: ${e.message}`);
    }
    let hasAccu = null;
    try {
        // Aligned with v4 / v2 / accuPULSE3.js: contracts_for does not take currency; OTP API rejects unknown props
        const msg = await send(ws, { contracts_for: symbol });
        const available = msg.contracts_for?.available ?? [];
        const types = [...new Set(available.map(c => c.contract_type))];
        hasAccu = types.includes('ACCU');
        console.log(`  contracts_for: contract types = ${types.join(', ') || '(none)'}`);
        console.log(`  Accumulators (ACCU): ${hasAccu ? '✅ AVAILABLE' : '❌ NOT AVAILABLE'}`);
    } catch (e) {
        console.log(`  ⚠️  contracts_for failed: ${e.message}`);
    }
    return { foundInActive, hasAccu };
}

async function analyzeAccumulatorBarriers(ws, symbol, cfg, diffs, prices, spikeIndices, symbolKey) {
    console.log('\n' + '─'.repeat(72));
    console.log('ACCUMULATOR GROWTH-RATE BARRIER ANALYSIS');
    console.log('─'.repeat(72));

    const percentMoves = [];
    for (let i = 1; i < prices.length; i++) percentMoves.push(diffs[i] / prices[i - 1]);
    const spikeSet = new Set(spikeIndices);

    const results = [];
    for (const g of cfg.growthRates) {
        let proposal;
        try {
            const msg = await send(ws, {
                proposal: 1, contract_type: 'ACCU', [symbolKey]: symbol,
                amount: cfg.testStake, basis: 'stake', currency: 'USD', growth_rate: g,
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

        const fairKnockoutProb = g / (1 + g);
        let ordinaryBreaches = 0, ordinaryCount = 0, spikeBreaches = 0, spikeCount = 0;
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
    console.log('  DERIV SYNTHETIC INDEX — STATISTICAL STRUCTURE TESTER (v5)');
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
        try {
            await send(ws, { authorize: CONFIG.apiToken });
            console.log('  ✅ Authorized');
        } catch (e) {
            console.log(`  ⚠️  Authorization failed: ${e.message} — continuing unauthorized`);
        }
    } else if (conn.isPat) {
        console.log(`  ✅ Connected via OTP session (account ${conn.account?.account_id || 'unknown'})`);
    }

    const symbolKey = conn.isPat ? 'underlying_symbol' : 'symbol';
    const avail = await checkSymbolAvailability(ws, CONFIG.symbol);

    console.log('\n📡 Collecting tick history...');
    const { times, prices } = await collectTicks(ws, CONFIG.symbol, CONFIG.targetTicks, CONFIG.batchSize, CONFIG.requestDelayMs);
    if (prices.length < 1000) {
        console.error('❌ Not enough tick data returned. Check the symbol code and try again.');
        ws.close(); process.exit(1);
    }
    const hoursSpanned = (times[times.length - 1] - times[0]) / 3600;
    console.log(`✅ Collected ${prices.length} ticks spanning ${hoursSpanned.toFixed(1)} hours\n`);

    const report = {
        symbol: CONFIG.symbol, ticksCollected: prices.length, hoursSpanned,
        symbolFoundInActiveList: avail.foundInActive, accumulatorAvailable: avail.hasAccu,
    };

    console.log('─'.repeat(72));
    console.log('GENERAL RANDOMNESS CHECKS');
    console.log('─'.repeat(72));
    const rawDiffs = [];
    for (let i = 1; i < prices.length; i++) rawDiffs.push(prices[i] - prices[i - 1]);
    const runs = runsTest(rawDiffs);
    console.log(`Runs Test:              runs=${runs.runs}  p=${runs.pValue.toFixed(4)}  ${runs.pValue < 0.05 ? '⚠️  NON-RANDOM' : '✓  consistent with random'}`);
    const ac1 = lag1Autocorrelation(rawDiffs);
    console.log(`Lag-1 Autocorrelation:  r=${ac1.r1.toFixed(4)}  p=${ac1.pValue.toFixed(4)}  ${ac1.pValue < 0.05 ? '⚠️  SIGNIFICANT' : '✓  no significant autocorrelation'}\n`);
    report.runsTest = runs;
    report.autocorrelation = ac1;

    console.log('─'.repeat(72));
    console.log('SPIKE / EVENT TIMING ANALYSIS');
    console.log('─'.repeat(72));
    const { spikeIndices, direction, diffs } = detectSpikes(prices, CONFIG, CONFIG.symbol);
    console.log(`Spike direction filter : ${direction}`);
    console.log(`Spikes detected        : ${spikeIndices.length}`);
    report.spikeDirection = direction;
    report.spikesDetected = spikeIndices.length;

    if (spikeIndices.length < 20) {
        console.log('\n⚠️  Too few spikes detected for reliable statistics.\n');
    } else {
        const intervals = computeIntervals(spikeIndices);
        const floor = CONFIG.minSpikeSeparation;
        const disp = dispersionStats(intervals, floor);
        console.log(`\nMean spacing: ${disp.mean.toFixed(1)} ticks | CV: ${disp.cv.toFixed(3)} (theoretical ${disp.theoreticalCV.toFixed(3)})`);

        const chiSq = chiSquareGoodnessOfFitGeometric(intervals, floor);
        console.log(`Chi-Square GOF: p=${chiSq.pValue.toFixed(4)}  ${chiSq.pValue < 0.05 ? '⚠️  REJECTS memoryless' : '✓  fails to reject memoryless'}`);
        const ks = ksTestGeometric(intervals, floor);
        console.log(`KS Test:        p=${ks.pValue.toFixed(4)}  ${ks.pValue < 0.05 ? '⚠️  REJECTS memoryless' : '✓  fails to reject memoryless'}`);

        const hazard = hazardTable(intervals, CONFIG.hazardBuckets, disp.mean, disp.pHat);
        report.intervals = { count: intervals.length, mean: disp.mean, cv: disp.cv, theoreticalCV: disp.theoreticalCV, floor };
        report.chiSquareTest = chiSq;
        report.ksTest = ks;
        report.hazardTable = hazard;
        report.verdict = (chiSq.pValue < 0.05 || ks.pValue < 0.05) ? 'possible_structure_needs_validation' : 'no_structure_detected';

        // ── NEW: post-spike event-study ──────────────────────────────────
        console.log('\n' + '─'.repeat(72));
        console.log('POST-SPIKE EVENT-STUDY (event vs. random-tick control)');
        console.log('─'.repeat(72));
        console.log(`Horizon: ${CONFIG.postSpike.horizon} ticks | Bonferroni-corrected threshold: p < ${(0.05 / CONFIG.postSpike.horizon).toExponential(3)}\n`);

        const study = analyzePostSpikeBehavior(prices, spikeIndices, CONFIG.postSpike);
        console.log(`Event paths: ${study.eventCount} (excluded ${study.excludedContaminatedEvents}/${study.totalSpikes} as contaminated by a second spike within the horizon)`);
        console.log(`Control paths: ${study.controlCount} (non-overlapping — expect far fewer than v4's count, on purpose)\n`);
        console.log('  Offset   Event mean%   Control mean%   Diff%      p-value     Significant?');
        study.rows.forEach(r => {
            if (r.offset % CONFIG.postSpike.printEveryNthOffset === 0 || r.significant) {
                console.log(
                    `  ${String(r.offset).padEnd(8)} ${r.eventMeanPct.toFixed(5).padEnd(13)} ` +
                    `${r.controlMeanPct.toFixed(5).padEnd(15)} ${r.diffPct.toFixed(5).padEnd(10)} ` +
                    `${r.pValue.toExponential(2).padEnd(11)} ${r.significant ? '⚠️  YES' : ''}`
                );
            }
        });

        console.log(`\n${study.anySignificant
            ? `⚠️  Significant divergence found starting at offset ${study.firstSignificantOffset} ticks post-spike — worth an out-of-sample split before trusting it.`
            : '✓  No offset survives the Bonferroni-corrected threshold. No detectable post-spike price pattern in this sample.'}`);

        report.postSpikeEventStudy = {
            horizon: study.horizon, eventCount: study.eventCount, controlCount: study.controlCount,
            excludedContaminatedEvents: study.excludedContaminatedEvents, totalSpikes: study.totalSpikes,
            bonferroniThreshold: study.bonferroniThreshold, anySignificant: study.anySignificant,
            firstSignificantOffset: study.firstSignificantOffset, rows: study.rows,
        };

        // ── Accumulator barrier analysis ───────────────────────────────────
        if (!CONFIG.apiToken) {
            console.log('\n(Skipping accumulator analysis — no apiToken configured.)');
            report.accumulatorAnalysis = null;
        } else if (avail.hasAccu === false) {
            console.log('\n(Skipping accumulator analysis — ACCU not available on this symbol.)');
            report.accumulatorAnalysis = null;
        } else {
            report.accumulatorAnalysis = await analyzeAccumulatorBarriers(
                ws, CONFIG.symbol, CONFIG.accumulator, diffs, prices, spikeIndices, symbolKey
            );
        }
    }

    ws.close();
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(report, null, 2));
    console.log(`\n📁 Full report saved to: ${CONFIG.outputFile}`);
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
