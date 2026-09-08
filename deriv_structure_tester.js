/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  DERIV SYNTHETIC INDEX — STATISTICAL STRUCTURE TESTER                ║
 * ╠══════════════════════════════════════════════════════════════════════╣
 * ║                                                                      ║
 * ║  PURPOSE: Test whether a synthetic index's disclosed event structure ║
 * ║  (Boom/Crash spikes, Range Break events, Jump events) is truly       ║
 * ║  memoryless (geometric spacing — no exploitable timing pattern) or   ║
 * ║  has detectable structure (regular spacing / clustering — a real,    ║
 * ║  testable signal). Also runs general randomness checks (runs test,  ║
 * ║  autocorrelation) that apply to ANY symbol, including plain          ║
 * ║  Volatility indices, as a control/sanity check.                      ║
 * ║                                                                      ║
 * ║  THIS SCRIPT DOES NOT TRADE. It only reads public historical tick   ║
 * ║  data and runs statistical hypothesis tests against it. No API      ║
 * ║  token or account is required.                                       ║
 * ║                                                                      ║
 * ║  METHOD SUMMARY:                                                      ║
 * ║   1. Pull N historical ticks for a symbol (paginated).               ║
 * ║   2. Runs test + lag-1 autocorrelation on raw tick moves             ║
 * ║      (general randomness check — expect null result on symmetric     ║
 * ║      Volatility indices).                                            ║
 * ║   3. Detect spike/event ticks via rolling-MAD outlier detection.     ║
 * ║   4. Extract inter-event intervals (ticks between events).           ║
 * ║   5. Test intervals against the Geometric distribution (the          ║
 * ║      "memoryless" null hypothesis) via:                              ║
 * ║        - Coefficient of variation vs theoretical                     ║
 * ║        - Chi-square goodness-of-fit (quantile-binned)                ║
 * ║        - Kolmogorov–Smirnov test                                     ║
 * ║        - Empirical hazard-rate table vs theoretical hazard           ║
 * ║   6. Print a plain-language verdict + save a full JSON report.       ║
 * ║                                                                      ║
 * ║  USAGE:                                                              ║
 * ║    node deriv_structure_tester.js                                    ║
 * ║    (edit CONFIG below to change symbol / sample size / thresholds)  ║
 * ║                                                                      ║
 * ║  IMPORTANT: A significant result here is a HYPOTHESIS worth          ║
 * ║  validating out-of-sample — not a trading signal on its own. Split   ║
 * ║  your data, refit on one half, and confirm the pattern replicates    ║
 * ║  on the held-out half before ever risking capital on it.             ║
 * ║                                                                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — edit these for your target symbol / sensitivity
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
    // Deriv symbol codes, e.g.:
    //   Boom/Crash: 'BOOM1000', 'BOOM500', 'BOOM300N', 'CRASH1000', 'CRASH500', 'CRASH300N'
    //   Volatility (control group, expect no structure): 'R_10', 'R_25', 'R_50', 'R_75', 'R_100'
    //   Step / Range Break / Jump: use their exact Deriv symbol codes
    symbol: 'BOOM50',

    targetTicks: 80000,        //50000 total historical ticks to pull (more = more statistical power)
    batchSize: 5000,           // ticks per API request
    requestDelayMs: 400,       // pause between paginated requests (avoid rate limiting)

    // ── Spike / event detection ──────────────────────────────────────────
    madWindow: 50,             // rolling window (ticks) used to define "normal" local move size
    spikeThresholdMAD: 10,     // a tick counts as a "spike" if |move| >= this × rolling MAD
    minSpikeSeparation: 5,     // ignore spikes within N ticks of the previous one (de-dupe one event)

    // 'up' | 'down' | 'both' | 'auto' (auto infers from symbol name: BOOM→up, CRASH→down, else both)
    spikeDirection: 'auto',

    // ── Hazard table bucket edges, expressed as multiples of the mean interval ──
    hazardBuckets: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, Infinity],

    outputFile: path.join(__dirname, `structure_report_${Date.now()}.json`),
};

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET DATA COLLECTION
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectTicks(ws, symbol, targetCount, batchSize, delayMs) {
    let allTimes = [];
    let allPrices = [];
    let endParam = 'latest';

    while (allTimes.length < targetCount) {
        const req = {
            ticks_history: symbol,
            style: 'ticks',
            count: batchSize,
            end: endParam,
            adjust_start_time: 1,
        };
        const msg = await send(ws, req);
        const times = msg.history?.times ?? [];
        const prices = (msg.history?.prices ?? []).map(Number);

        if (times.length === 0) break;

        allTimes = [...times, ...allTimes];
        allPrices = [...prices, ...allPrices];

        process.stdout.write(`\r  Collected ${allTimes.length} / ${targetCount} ticks...`);

        if (times.length < batchSize) break; // reached the start of available history
        endParam = times[0] - 1;              // page further back in time
        await sleep(delayMs);
    }
    console.log('');
    return { times: allTimes, prices: allPrices };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPIKE / EVENT DETECTION
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

    // Rolling MAD of |move| — causal (uses only preceding ticks)
    const rollingMAD = new Array(n).fill(null);
    for (let i = cfg.madWindow; i < n; i++) {
        const windowAbs = diffs.slice(i - cfg.madWindow, i).map(Math.abs);
        const med = median(windowAbs);
        const absDevs = windowAbs.map(v => Math.abs(v - med));
        rollingMAD[i] = median(absDevs) || 1e-9;
    }

    let direction = cfg.spikeDirection;
    if (direction === 'auto') {
        const upperSym = symbol.toUpperCase();
        if (upperSym.includes('BOOM')) direction = 'up';
        else if (upperSym.includes('CRASH')) direction = 'down';
        else direction = 'both';
    }

    const spikeIndices = [];
    let lastSpike = -Infinity;
    for (let i = cfg.madWindow; i < n; i++) {
        const mad = rollingMAD[i];
        if (!mad) continue;
        const move = diffs[i];
        const magnitude = Math.abs(move) / mad;
        const directionOK = direction === 'both' ? true : direction === 'up' ? move > 0 : move < 0;

        if (directionOK && magnitude >= cfg.spikeThresholdMAD) {
            if (i - lastSpike >= cfg.minSpikeSeparation) {
                spikeIndices.push(i);
                lastSpike = i;
            }
        }
    }
    return { spikeIndices, direction };
}

function computeIntervals(spikeIndices) {
    const intervals = [];
    for (let i = 1; i < spikeIndices.length; i++) {
        intervals.push(spikeIndices[i] - spikeIndices[i - 1]);
    }
    return intervals;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICAL MACHINERY
// ═══════════════════════════════════════════════════════════════════════════

// ── Log-gamma (Lanczos approximation) ──────────────────────────────────────
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

// ── Regularized lower incomplete gamma function P(a,x) ─────────────────────
const ITMAX = 200, EPS = 3e-9, FPMIN = 1e-300;

function gammaP(a, x) {
    if (x < 0 || a <= 0) return NaN;
    if (x === 0) return 0;

    if (x < a + 1) {
        // Series representation
        const gln = gammln(a);
        let ap = a, sum = 1 / a, del = sum;
        for (let n = 1; n <= ITMAX; n++) {
            ap += 1;
            del *= x / ap;
            sum += del;
            if (Math.abs(del) < Math.abs(sum) * EPS) break;
        }
        return sum * Math.exp(-x + a * Math.log(x) - gln);
    } else {
        // Continued fraction gives Q = 1-P
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

/** Upper-tail p-value P(X >= chiSq) for a chi-square distribution with df degrees of freedom */
function chiSquarePValue(chiSq, df) {
    return 1 - gammaP(df / 2, chiSq / 2);
}

// ── Normal CDF (via Abramowitz–Stegun erf approximation) ───────────────────
function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
          a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}
function normalCDF(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ── Dispersion / coefficient-of-variation test ──────────────────────────────
function dispersionStats(intervals) {
    const n = intervals.length;
    const mean = intervals.reduce((s, v) => s + v, 0) / n;
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const cv = Math.sqrt(variance) / mean;
    const pHat = 1 / mean;
    const theoreticalCV = Math.sqrt(1 - pHat); // geometric distribution CV
    return { n, mean, variance, cv, theoreticalCV, pHat, dispersionRatio: variance / mean };
}

// ── Chi-square goodness-of-fit vs Geometric (quantile-binned) ──────────────
function chiSquareGoodnessOfFitGeometric(intervals) {
    const n = intervals.length;
    const mean = intervals.reduce((s, v) => s + v, 0) / n;
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
    for (const v of intervals) {
        for (let b = 0; b < numBins; b++) {
            if (v > edges[b] && v <= edges[b + 1]) { observed[b]++; break; }
        }
    }
    const expected = new Array(numBins).fill(n / numBins); // approx equal by quantile construction

    let chiSq = 0;
    for (let b = 0; b < numBins; b++) {
        const diff = observed[b] - expected[b];
        chiSq += (diff * diff) / expected[b];
    }
    // df = bins - 1, minus 1 more because we estimated p from the same data
    const df = Math.max(numBins - 2, 1);
    const pValue = chiSquarePValue(chiSq, df);

    return { chiSq, df, pValue, numBins, observed, expected, pHat, mean };
}

// ── Kolmogorov–Smirnov test vs Geometric ────────────────────────────────────
function ksTestGeometric(intervals) {
    const n = intervals.length;
    const mean = intervals.reduce((s, v) => s + v, 0) / n;
    const pHat = 1 / mean;
    const sorted = [...intervals].sort((a, b) => a - b);

    let D = 0;
    for (let i = 0; i < n; i++) {
        const F = 1 - Math.pow(1 - pHat, sorted[i]);
        D = Math.max(D, Math.abs((i + 1) / n - F), Math.abs(i / n - F));
    }

    // Stephens (1970) asymptotic approximation for the p-value
    const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * D;
    let pValue = 0;
    for (let k = 1; k <= 100; k++) {
        pValue += (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
    }
    pValue = Math.max(0, Math.min(1, 2 * pValue));

    return { D, pValue, pHat };
}

// ── Empirical hazard-rate table vs theoretical (memoryless) hazard ─────────
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
        rows.push({
            range: `${lo}-${hi === Infinity ? '∞' : hi}`,
            survivors, events, empiricalHazard, theoreticalHazard,
        });
    }
    return rows;
}

// ── Wald–Wolfowitz runs test (sign randomness) ──────────────────────────────
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

// ── Lag-1 autocorrelation ────────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
    console.log('═'.repeat(72));
    console.log('  DERIV SYNTHETIC INDEX — STATISTICAL STRUCTURE TESTER');
    console.log('═'.repeat(72));
    console.log(`  Symbol       : ${CONFIG.symbol}`);
    console.log(`  Target ticks : ${CONFIG.targetTicks}`);
    console.log('═'.repeat(72) + '\n');

    const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    console.log('📡 Collecting tick history (read-only, no account needed)...');
    const { times, prices } = await collectTicks(
        ws, CONFIG.symbol, CONFIG.targetTicks, CONFIG.batchSize, CONFIG.requestDelayMs
    );
    ws.close();

    if (prices.length < 1000) {
        console.error('❌ Not enough tick data returned. Check the symbol code and try again.');
        process.exit(1);
    }

    const hoursSpanned = (times[times.length - 1] - times[0]) / 3600;
    console.log(`✅ Collected ${prices.length} ticks spanning ${hoursSpanned.toFixed(1)} hours\n`);

    const report = { symbol: CONFIG.symbol, ticksCollected: prices.length, hoursSpanned };

    // ── 1. General randomness checks (any symbol) ───────────────────────────
    console.log('─'.repeat(72));
    console.log('GENERAL RANDOMNESS CHECKS (raw tick-to-tick price moves)');
    console.log('─'.repeat(72));

    const diffs = [];
    for (let i = 1; i < prices.length; i++) diffs.push(prices[i] - prices[i - 1]);

    const runs = runsTest(diffs);
    console.log(
        `Runs Test:              runs=${runs.runs}  expected=${runs.meanR.toFixed(1)}  ` +
        `z=${runs.z.toFixed(3)}  p=${runs.pValue.toFixed(4)}  ` +
        `${runs.pValue < 0.05 ? '⚠️  NON-RANDOM sign pattern' : '✓  consistent with random signs'}`
    );

    const ac1 = lag1Autocorrelation(diffs);
    console.log(
        `Lag-1 Autocorrelation:  r=${ac1.r1.toFixed(4)}  z=${ac1.z.toFixed(3)}  ` +
        `p=${ac1.pValue.toFixed(4)}  ` +
        `${ac1.pValue < 0.05 ? '⚠️  SIGNIFICANT autocorrelation' : '✓  no significant autocorrelation'}`
    );
    console.log('');

    report.runsTest = runs;
    report.autocorrelation = ac1;

    // ── 2. Spike/event timing analysis ───────────────────────────────────────
    console.log('─'.repeat(72));
    console.log('SPIKE / EVENT TIMING ANALYSIS');
    console.log('─'.repeat(72));

    const { spikeIndices, direction } = detectSpikes(prices, CONFIG, CONFIG.symbol);
    console.log(`Spike direction filter : ${direction}`);
    console.log(`Spikes detected        : ${spikeIndices.length}`);

    report.spikeDirection = direction;
    report.spikesDetected = spikeIndices.length;

    if (spikeIndices.length < 20) {
        console.log(
            '\n⚠️  Too few spikes detected for reliable interval statistics.\n' +
            '    Try: lower spikeThresholdMAD, raise targetTicks, or confirm this symbol has spike events.\n'
        );
    } else {
        const intervals = computeIntervals(spikeIndices);
        const disp = dispersionStats(intervals);

        console.log(`\nInterval count          : ${intervals.length}`);
        console.log(`Mean spacing            : ${disp.mean.toFixed(1)} ticks`);
        console.log(
            `Coefficient of Variation: ${disp.cv.toFixed(3)}  ` +
            `(memoryless/geometric expects ≈ ${disp.theoreticalCV.toFixed(3)})`
        );

        if (disp.cv < disp.theoreticalCV * 0.85) {
            console.log('  → CV notably BELOW memoryless expectation: spacing is more REGULAR than random — possible predictable structure.');
        } else if (disp.cv > disp.theoreticalCV * 1.15) {
            console.log('  → CV notably ABOVE memoryless expectation: events CLUSTER more than random — possible burstiness structure.');
        } else {
            console.log('  → CV consistent with memoryless (geometric) spacing — no obvious structure from this test.');
        }

        const chiSq = chiSquareGoodnessOfFitGeometric(intervals);
        console.log(
            `\nChi-Square GOF vs Geometric : χ²=${chiSq.chiSq.toFixed(2)}  df=${chiSq.df}  ` +
            `p=${chiSq.pValue.toFixed(4)}  ` +
            `${chiSq.pValue < 0.05 ? '⚠️  REJECTS memoryless (p<0.05)' : '✓  fails to reject memoryless'}`
        );

        const ks = ksTestGeometric(intervals);
        console.log(
            `KS Test vs Geometric         : D=${ks.D.toFixed(4)}              ` +
            `p=${ks.pValue.toFixed(4)}  ` +
            `${ks.pValue < 0.05 ? '⚠️  REJECTS memoryless (p<0.05)' : '✓  fails to reject memoryless'}`
        );

        console.log(`\nHazard Table (empirical P(event in bucket | survived to bucket start) vs memoryless theory):`);
        console.log('  Range (ticks)      Survivors  Events   Empirical Hazard   Theoretical Hazard');
        const hazard = hazardTable(intervals, CONFIG.hazardBuckets, disp.mean, disp.pHat);
        hazard.forEach(row => {
            const emp  = row.empiricalHazard   !== null ? row.empiricalHazard.toFixed(4)   : 'n/a';
            const theo = row.theoreticalHazard !== null ? row.theoreticalHazard.toFixed(4) : 'n/a';
            console.log(
                `  ${row.range.padEnd(18)} ${String(row.survivors).padEnd(10)} ` +
                `${String(row.events).padEnd(8)} ${emp.padEnd(19)} ${theo}`
            );
        });

        report.intervals = { count: intervals.length, mean: disp.mean, cv: disp.cv, theoreticalCV: disp.theoreticalCV };
        report.chiSquareTest = chiSq;
        report.ksTest = ks;
        report.hazardTable = hazard;

        console.log(`\n${'═'.repeat(72)}`);
        console.log('VERDICT');
        console.log('═'.repeat(72));

        const structureFound = chiSq.pValue < 0.05 || ks.pValue < 0.05;
        if (structureFound) {
            console.log('⚠️  Statistical evidence AGAINST pure memorylessness (p<0.05 on at least one test).');
            console.log('    This is a HYPOTHESIS, not a trading signal. Before risking anything:');
            console.log('      1. Split this dataset in half (by time).');
            console.log('      2. Re-fit the hazard model on the first half only.');
            console.log('      3. Check whether the same pattern replicates on the held-out second half.');
            console.log('      4. Compare the resulting edge against the contract\'s actual payout breakeven.');
        } else {
            console.log('✓  No statistically significant deviation from memoryless (geometric) spacing found.');
            console.log('   Consistent with a well-implemented, audited RNG. No timing edge detected on this sample.');
        }
        report.verdict = structureFound ? 'possible_structure_needs_validation' : 'no_structure_detected';
    }

    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(report, null, 2));
    console.log(`\n📁 Full report saved to: ${CONFIG.outputFile}`);
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
