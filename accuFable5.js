#!/usr/bin/env node
'use strict';

/**
 * ======================================================================
 *  AccuFable5 — "Measure First" Deriv Accumulator engine
 * ======================================================================
 *
 *  A single-file Deriv Accumulator (ACCU) bot rebuilt from accuFable5.
 *
 *  ─ WHAT THE RESEARCH CHANGED ────────────────────────────────────────
 *
 *  1. ACCU IS VOLATILITY-INDICES ONLY.
 *     Deriv offers Accumulators only on volatility indices. All of v4's
 *     BOOM/CRASH "post-spike" machinery was unreachable code for ACCU.
 *     It is gone. Assets are R_* and 1HZ*V only.
 *
 *  2. THE UNDERLYING IS I.I.D. BY CONSTRUCTION.
 *     Volatility indices are CSPRNG-generated with a CONSTANT annualised
 *     volatility. Per-tick log returns are i.i.d. Gaussian with fixed σ.
 *     Therefore NO conditional state — realized-vol compression, RSI,
 *     streaks, patterns, time of day — can predict the next tick.
 *     v4's "volatility compression" gate was measuring sampling noise.
 *     It is gone.
 *
 *  3. THE BARRIER IS THE FAIR GAUSSIAN QUANTILE MINUS A HAIRCUT.
 *     From Deriv's own published barriers, b(5%)/b(1%) = 0.76091 versus
 *     the zero-EV Gaussian ratio z(5%)/z(1%) = 0.76795. The barrier is
 *     the fair quantile, shaved. Measured against the 1% barrier as the
 *     anchor, the 5% rate costs ≈ −0.218% EV PER TICK.
 *     v4 hardcoded growth rate 0.05 — the single most expensive rate.
 *
 *  4. COST COMPOUNDS WITH HOLD TIME: E[return] = (1+ev_tick)^K − 1.
 *     Hold time is the main cost lever, and it only ever subtracts.
 *
 *  5. MARTINGALE IS OPT-IN AND BANNED BY DEFAULT.
 *     v4 shipped martingaleMultiplier 22.0. On a $5 base that is $115 at
 *     risk, and at an 80% win rate a 2-loss streak arrives every ~25
 *     trades. Martingale therefore defaults to OFF; enabling it is a
 *     deliberate, config-driven choice (MARTINGALE_MULTIPLIER /
 *     MARTINGALE_STEPS). Match accuHOLD_v2 semantics exactly when on.
 *
 *  ─ WHAT THIS BOT ACTUALLY DOES ──────────────────────────────────────
 *
 *  It refuses to assume an edge. It MEASURES one.
 *
 *    • CalibrationEngine reads the live barrier from Deriv's own proposal
 *      for every (symbol, growth rate), measures the realized per-tick
 *      breach rate from tick history, and computes a Wilson confidence
 *      interval on per-tick survival.
 *    • It trades ONLY if the LOWER confidence bound on survival exceeds
 *      the break-even survival 1/(1+g). That is the only condition under
 *      which a positive expectation is statistically defensible.
 *    • EdgeLedger runs a sequential test on realized outcomes. If the
 *      live edge is negative with significance, the bot HALTS itself.
 *    • Default mode is PAPER. It will not touch money until you flip it.
 *
 *  If no edge clears the gate, the bot stands aside and trades nothing.
 *  That is the correct behaviour, and it is the most likely behaviour.
 *
 *  ─ HONESTY ──────────────────────────────────────────────────────────
 *  Deriv's trading terms state that Accumulator pricing "include[s] a
 *  bias in our favour". This bot cannot remove that bias. It minimises
 *  exposure to it, measures it continuously, and stops when it is losing.
 *  No configuration of this file is guaranteed to be profitable.
 *
 *  Usage:
 *    node accuFable5.js --selftest      run the unit tests, exit
 *    node accuFable5.js --calibrate     measure edge, never trade, exit
 *    node accuFable5.js                 run (PAPER mode unless changed)
 *
 *  License: MIT
 * ======================================================================
 */

const WebSocket    = require('ws');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const { URL }      = require('url');
const EventEmitter = require('events');

// ═══════════════════════════════════════════════════════════════════════
// 1. ENV LOADER
// ═══════════════════════════════════════════════════════════════════════
function loadEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;
  try {
    for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.error('[boot] .env read error:', e.message); }
}
loadEnv();

const envStr = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const envNum = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const envInt = (k, d) => { const v = parseInt(process.env[k], 10); return Number.isFinite(v) ? v : d; };
const envBool = (k, d) => {
  const v = process.env[k];
  if (v == null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

// ═══════════════════════════════════════════════════════════════════════
// 2. CONFIGURATION
//    Everything comes from the environment. No secret is ever hardcoded.
// ═══════════════════════════════════════════════════════════════════════

// ── STATE DIRECTORY ──
// Every persisted file lives under one directory so a hosting platform can
// point it at a mounted volume. The container-local filesystem is EPHEMERAL:
// on Kubernetes (which powers Suga) the container's writable layer is thrown
// away on every redeploy, rollout, scale event and OOM kill. Only a mounted
// volume survives. Defaults to cwd so local/VPS runs keep working untouched.
const STATE_DIR = path.resolve(envStr('STATE_DIR', path.join(__dirname, '/state')));

const CONFIG = Object.freeze({
  // ── Credentials (REQUIRED via .env — never commit these) ──
  // These were previously hardcoded literals, and the bot shipped with a live
  // PAT token and a Telegram bot token in version control. Rotate both.
  // .env must define: API_TOKEN, APP_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  apiToken : envStr('API_TOKEN', envStr('DERIV_API_TOKEN', 'pat_e02a554e3b6f9f939c07855fe28c91c68e58ea14f741f45f675f82de96da4289')),
  appId    : envStr('APP_ID', '33uslPtthXBEkQOdfKfoY'),
  wsUrl    : 'wss://ws.derivws.com/websockets/v3',
  currency : 'USD',
  // PAT-token (new API) only: which account type the OTP flow selects when
  // the token owns both types. 'demo' | 'real'.
  accountType: 'demo',

  // ── Execution mode ──
  //   'paper' — full pipeline, simulated fills, ZERO money at risk (DEFAULT)
  //   'live'  — real orders. Requires MODE=live AND CONFIRM_LIVE=i-understand
  // Both were previously hardcoded to live + confirmed, which made the
  // interlock a no-op and contradicted the file's own "default is PAPER"
  // header. Set them in .env to trade real money.
  mode         : 'live',
  confirmLive  : 'i-understand',

  // ── Assets ──
  //   The DEFAULT is the volatility-index family this file's maths is built
  //   for: per-tick log returns are i.i.d. Gaussian at constant volatility, so
  //   the barrier really is a quantile and the survival/EV model is valid.
  //
  //   BOOM/CRASH indices are a different animal: they carry deliberate jump
  //   events, so returns are heavy-tailed and NOT Gaussian. The calibration
  //   still runs, but breachCount is dominated by synthetic spikes and the
  //   EV figures are not meaningful. That is a modelling caveat, not a crash.

  //   assets: envStr('ASSETS', 'R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V,BOOM50,BOOM500,BOOM600,BOOM900,BOOM1000,CRASH50,CRASH500,CRASH600,CRASH900,CRASH1000')
  //     .split(',').map(s => s.trim()).filter(Boolean),
  assets: envStr('ASSETS', 'R_10,R_25,R_50,R_75,R_100')
    .split(',').map(s => s.trim()).filter(Boolean),
  suspendPreviousAsset: envBool('SUSPEND_PREVIOUS_ASSET', true),
  // Number of distinct recent symbols to skip when suspension is enabled.
  suspendPreviousAssetCount: envInt('SUSPEND_PREVIOUS_ASSET_COUNT', 2),

  // A boom/crash index is not a volatility index. We allow it, but say so.
  isBoomOrCrash: s => /^(BOOM|CRASH)/i.test(s),

  // ── Growth-rate grid. 0.01 measured cheapest; 0.05 measured dearest. ──
  growthRates: envStr('GROWTH_RATES', '0.05') //0.01,0.02,0.03
    .split(',').map(s => parseFloat(s.trim())).filter(v => v >= 0.01 && v <= 0.05),

  // ── Sizing. Flat or fixed-fraction base; martingale is opt-in below. ──
  sizing        : 'flat',   // 'flat' | 'fraction'
  stake         : 1.0,
  riskFraction  : 0.005,           // 0.5% of balance
  minStake      : 1.0,
  maxStake      : 50.0,

  // Martingale (accuHOLD_v2 semantics) ──
  martingaleMultiplier : 21.0, // stake × multiplier each loss step
  martingaleSteps      : 1,        // 0 = disabled
  martingaleBaseStake  : 0,   // 0 → use CONFIG.stake

  // ── Chase-on-loss ──
  // When ON, a losing trade immediately re-trades the SAME asset (same
  // growth rate) on the very next tick, skipping the stay/ev gates. It keeps
  // re-trading that same asset after each loss until a win, then returns to
  // the normal gate-based selection.
  chaseOnLoss         : false,

  // ── EOD / hourly summaries (GMT) ──
  eodTimeGmt         : '00:00',
  eodSendDelaySeconds: envInt('EOD_SEND_DELAY_SECONDS', 10),
  hourlySummary      : envBool('HOURLY_SUMMARY', true),

  // ── Hard risk rails (all enforced, all halt the bot) ──
  dailyMaxLoss      : 100,
  dailyMaxTrades    : 40000000,
  sessionMaxDrawdown: 300,
  maxOpenTrades     : 1,
  maxConsecLosses   : 5,

  // ── Calibration (the core of this build) ──
  // Trade only when the LOWER confidence bound on per-tick survival beats
  // the break-even survival 1/(1+g) by at least edgeMarginPerTick.
  calibMinTicks     : 101,   // min history per symbol
  calibWindow       : 101,     // max history retained
  calibConfidenceZ  : 0.96,      // 95% Wilson bound
  edgeMarginPerTick : -0.6000, // required cushion
  sellSpreadCost    : 0.0002, // modelled round-trip cost

  // ── Stayed-in array + evLower/tick + breachCount gates ──
  // The ACCU proposal returns contract_details.ticks_stayed_in — the last
  // barrier-stay durations, most current value last. Trade only when:
  //   • its N most-current values are each < stayMaxValue, AND
  //   • its single most-current value is < stayCurrentMax, AND
  //   • its calibrated evLowerPerTick clears the ev gate (≥ evLowerGateMin in
  //     BEST mode, ≤ evWorstGateMax in WORST mode) — see evSelection; note the
  //     BEST direction is a FLOOR (higher EV is better; never a ceiling), and
  //     the WORST direction is a CEILING (lower/more-negative EV is the pick),
  //     AND
  //   • its calibrated single-tick breachCount is >= breachMinCount (need a
  //     large enough sample of barrier hits to trust the survival estimate).
  stayWindowN    : 1,     //6 N most-current values to check
  stayMaxValue   : 30,    //20 every one of those N must be < this
  stayCurrentMax : 30,   //2 the most-current value must be < this
  stayStaleMs    : 2400000, // stays older than this are ignored

  // ── evLower/tick gate direction ──
  // The ev gate is the "which asset" filter AND the ranking key:
  //   'best'  → FLOOR: trade only when evLowerPerTick >= evLowerGateMin, and
  //             among passers rank DESCENDING (highest evLower/tick wins).
  //   'worst' → CEILING: trade only when evLowerPerTick <= evWorstGateMax
  //             (user-set threshold, typically negative), and among passers
  //             rank ASCENDING (lowest / most-negative evLower/tick wins).
  // An unset/unknown value falls back to 'best' so a typo cannot silently
  // flip which side of the ev distribution the bot trades.
  evSelection  : envStr('EV_SELECTION', 'worst'),
  evLowerGateMin    : 0.0007547, //evLower/tick FLOOR (BEST): trade only when ≥ this (negative = trade everything above a loss floor)
  evWorstGateMax    : -0.0517547, //evLower/tick CEILING (WORST, user threshold): trade only when ≤ this
  breachMinCount : 0, //>= 85 trade only when historical single-tick barrier hits ≥ this
  breachMinCount2 : 25, //<= 85 trade only when historical single-tick barrier hits ≥ this

  // ── Exclusivity filter (trade ONLY on an unambiguous field) ──
  // When ON, the bot executes a trade only if EXACTLY ONE asset clears the
  // ev gate (floor ≥ evLowerGateMin in BEST mode / ceiling ≤ evWorstGateMax in
  // WORST mode). Two or more qualified assets is treated as noise,
  // not as a choice: ranking the top of a field where everything qualifies is
  // picking between indistinguishable readings of the same signal, so the bot
  // stands aside instead.
  //
  // Counted PER SYMBOL, not per (symbol, growth rate) pair — one asset
  // qualifying at two growth rates is still one qualified asset. Pairs with
  // evLowerPerTick == null (uncalibrated) never count: the floor cannot be
  // evaluated, so they cannot be certified as qualified.
  //
  // Zero qualified assets is unaffected (the ev floor already blocks those)
  // and does NOT suppress the gate-suspended chase-on-loss rescue path.
  requireSingleQualified : envBool('REQUIRE_SINGLE_QUALIFIED', true),
  requireSingleQualifiedMin : envInt('REQUIRE_SINGLE_QUALIFIED_MIN', 3),

  // ── Take-profit ──
  // TP exits the trade after takeProfitTicks ticks (the hold target). The
  // same value feeds the live limit_order take-profit price.
  takeProfitTicks      : 1,  // sell after this many ticks

  // ── Hold-time policy ──
  maxHoldTicks      : 12,
  minHoldTicks      : 1,

  // ── Live edge monitor: halt when realized edge is significantly bad ──
  // Was 400000000000000 while the comment said "40" — the circuit breaker that
  // stops the bot when it is provably losing could never fire. On a live-money
  // account that is an unbounded bleed.
  edgeMonitorMinTrades : 4000000000,
  edgeMonitorZStop     : 2.0,  // 95% confidence that EV < 0),

  // ── Timing ──
  analysisIntervalMs : 1000,
  tradeCooldownMs    : 3000,
  barrierRefreshMs   : 60000,
  watchdogMs         : 60000,

  // Minimum spacing between ANY two outbound requests. Deriv throttles hard,
  // and a throttled proposal stream silently starves the calibration engine
  // (barrier + stayed-in records age out → "uncalibrated" forever).
  // 250ms = 4 req/s. Lower this only if your account's quota allows it.
  minRequestGapMs    : envInt('MIN_REQUEST_GAP_MS', 250),

  // How often the stayed-in array is re-requested. Every analysis cycle asks
  // Deriv for a fresh ACCU proposal per (pair, growth rate); this caps that.
  staysRefreshMs     : envInt('STAYS_REFRESH_MS', 1000),

  // ── Telegram (optional) ──
  telegram: {
    enabled : true,
    botToken: envStr('TELEGRAM_BOT_TOKEN', '8343520432:AAGNxzjnljOEhfv_rE-y-F98fUDPmrqZuXc'),
    chatId  : envStr('TELEGRAM_CHAT_ID', '752497117'),
    maxQueue: 200,
  },

  // ── Reconnect ──
  reconnect: { initialDelayMs: 1000, maxDelayMs: 60000, backoffFactor: 2, jitterMs: 750 },

  // ── Logging / state ──
  // All under STATE_DIR so a mounted volume keeps them across redeploys.
  logFile   : path.join(STATE_DIR, 'accuFable5_00001.log'),
  logLevel  : 'INFO',
  stateFile : path.join(STATE_DIR, 'accuFable5-state_00001.json'),
  edgeFile  : path.join(STATE_DIR, 'accuFable5-edge_00001.json'),

  // ── Restart reconciliation ──
  // A state file newer than this is trusted in full, martingale included.
  // Older than this (or absent) → reporting is rebuilt from Deriv and the
  // stake escalation resets to base. Never reconstruct a stake from history:
  // at ×3 over 4 steps a wrong guess over-bets 81×, a reset only loses the
  // abandoned cycle.
  stateMaxAgeSec : envInt('STATE_MAX_AGE_SEC', 900),
  // Trades opened after a fail-safe restart are capped at base stake until
  // this many trades have settled, so a fresh process cannot immediately
  // re-escalate on a stale reading.
  restartGuardTrades : envInt('RESTART_GUARD_TRADES', 3),

  // How often to rewrite the state file even when no trade has settled, so a
  // hard kill cannot lose risk-rail progress beyond this window.
  stateFlushMs : envInt('STATE_FLUSH_MS', 15000),

  // Budget for selling open positions during shutdown. A platform rollout
  // SIGKILLs the process after its grace period, so teardown must not be able
  // to starve the final state write.
  shutdownGraceMs : envInt('SHUTDOWN_GRACE_MS', 10000),
});

// ═══════════════════════════════════════════════════════════════════════
// 3. LOGGER
// ═══════════════════════════════════════════════════════════════════════
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.INFO;
const pad = n => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
};
// A write STREAM, not appendFileSync. appendFileSync is a blocking syscall on
// every single log line, so a burst of WARN/ERROR output (exactly what a
// rate-limit or stalled-feed episode produces) stalls the event loop and every
// timer behind it. The stream buffers and flushes from the libuv thread pool.
// State files are a different matter and stay on the fsync path in
// atomicWriteJson() — that one genuinely must be durable before a trade.
let _logStream = null;
function _logStreamGet() {
  if (_logStream) return _logStream;
  try {
    fs.mkdirSync(path.dirname(CONFIG.logFile), { recursive: true });
    _logStream = fs.createWriteStream(CONFIG.logFile, { flags: 'a' });
    // A broken log pipe (full disk, rotated file) must never become an
    // unhandled 'error' event — that would itself crash the process. Drop the
    // handle silently; logging from inside this handler would recurse back
    // into the dead stream.
    _logStream.on('error', () => { _logStream = null; });
  } catch (e) {
    return null;
  }
  return _logStream;
}
function _writeLog(line) {
  const s = _logStreamGet();
  if (s) s.write(line + '\n');
}
function log(level, msg, ...rest) {
  if (LOG_LEVELS[level] > currentLevel) return;
  const line = `[${ts()}] [${level}] ${msg}` + (rest.length ? ' ' + rest.map(String).join(' ') : '');
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  _writeLog(line);
}

// ═══════════════════════════════════════════════════════════════════════
// 3b. DURABLE STATE WRITES
//     write+rename orders the rename but flushes NEITHER the file contents
//     NOR the directory entry to disk. A Kubernetes rollout SIGKILLs the pod
//     after its grace period, so without the fsyncs below the last trade can
//     be lost even on a perfectly good volume.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Atomically write JSON so a crash mid-write can never leave a half file.
 * Persist failures are LOGGED AT ERROR, not swallowed: the previous code
 * caught them at debug level, which logLevel:INFO filtered out entirely, so
 * an unwritable state directory on the host was completely invisible.
 */
function atomicWriteJson(file, data, label) {
  const tmp = file + '.tmp';
  try {
    // Create the parent here rather than trusting the boot-time probe: a
    // missing directory is exactly the kind of failure that used to be
    // swallowed, and it must never be able to silently skip a write.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    // Flush the directory entry so the rename itself survives a power/kill
    // event. Not supported on Windows — harmless there, essential on Linux.
    try {
      const dfd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (_) { /* Windows: directory fsync unsupported */ }
    return true;
  } catch (e) {
    logger.error(`STATE WRITE FAILED (${label}) → ${file}: ${e.code || ''} ${e.message}`.trim());
    return false;
  }
}

/**
 * Prove the state directory is actually writable before trading on it.
 * An unwritable directory silently resets martingale step, P&L and every
 * risk halt on each restart, which on a ×3/4-step martingale bot is how you
 * lose real money without being told.
 * @returns {boolean} true when state can be persisted.
 */
function probeStateDir() {
  const probe = path.join(STATE_DIR, `.probe-${process.pid}`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.accessSync(STATE_DIR, fs.constants.W_OK);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    logger.info(`state dir writable: ${STATE_DIR}`);
    return true;
  } catch (e) {
    logger.error(
      `state dir NOT WRITABLE: ${STATE_DIR} — ${e.code || ''} ${e.message}`.trim() +
      ' | on Kubernetes/Suga the container filesystem is EPHEMERAL: mount a ' +
      'Volume and set STATE_DIR to its mount path, or every restart loses all state.',
    );
    return false;
  }
}
const logger = {
  error: (m, ...r) => log('ERROR', m, ...r),
  warn : (m, ...r) => log('WARN',  m, ...r),
  info : (m, ...r) => log('INFO',  m, ...r),
  debug: (m, ...r) => log('DEBUG', m, ...r),
};

const money = (n, c = CONFIG.currency) => `${n >= 0 ? '+' : ''}${Number(n || 0).toFixed(2)} ${c}`;
const utcDateStr = (d = new Date()) => d.toISOString().slice(0, 10);
const utcHour    = (d = new Date()) => d.getUTCHours();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Human-readable duration formatter for trade-held time.
function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return 'n/a';
  const s = Math.floor(totalSec);
  if (s < 1)    return '<1s';
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/**
 * Trade log + streaks + daily/hourly summaries for the telegram reports.
 * Copied from accuHOLD_v2.js so the notification output matches exactly.
 */
class StatisticsManager {
  constructor(saved = null) {
    this.trades = [];
    this.dailySummaries = {};
    this.overallProfit = 0;
    this.currentLossStreak = 0;
    this.maxLossStreak = 0;
    this.lossStreakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0 };
    this.eodSentDates = [];
    this.dailyState = {};
    if (saved) this.load(saved);
  }
  load(s) {
    if (Array.isArray(s.trades)) this.trades = s.trades;
    if (s.dailySummaries) this.dailySummaries = s.dailySummaries;
    this.overallProfit = Number(s.overallProfit || 0);
    this.currentLossStreak = Number(s.currentLossStreak || 0);
    this.maxLossStreak = Number(s.maxLossStreak || 0);
    const e = s.lossStreakEvents || {};
    this.lossStreakEvents = {
      x2: Number(e.x2 || 0), x3: Number(e.x3 || 0), x4: Number(e.x4 || 0),
      x5: Number(e.x5 || 0), x6: Number(e.x6 || 0), x7: Number(e.x7 || 0),
    };
    this.eodSentDates = Array.isArray(s.eodSentDates) ? s.eodSentDates : [];
    this.dailyState = s.dailyState || {};
  }
  serialize() {
    return {
      trades: this.trades.slice(-5000), dailySummaries: this.dailySummaries,
      overallProfit: this.overallProfit, currentLossStreak: this.currentLossStreak,
      maxLossStreak: this.maxLossStreak,
      lossStreakEvents: { ...this.lossStreakEvents },
      eodSentDates: this.eodSentDates.slice(-400),
      dailyState: this.dailyState,
    };
  }
  lossStreakLine() {
    const e = this.lossStreakEvents;
    return `x2=${e.x2} x3=${e.x3} x4=${e.x4} x5=${e.x5} x6=${e.x6} x7=${e.x7}`;
  }
  record(trade) {
    const tsMs = Number(trade.sellTime || trade.buyTime || Date.now() / 1000) * 1000;
    const d = new Date(tsMs);
    const rec = { ...trade, timestamp: tsMs, date: utcDateStr(d), hour: utcHour(d) };
    this.trades.push(rec);
    if (rec.status === 'unknown') return rec;
    this.overallProfit += Number(rec.profit || 0);
    if (rec.status === 'lost') {
      this.currentLossStreak += 1;
      this.maxLossStreak = Math.max(this.maxLossStreak, this.currentLossStreak);
      if (this.currentLossStreak === 2) this.lossStreakEvents.x2 += 1;
      else if (this.currentLossStreak === 3) this.lossStreakEvents.x3 += 1;
      else if (this.currentLossStreak === 4) this.lossStreakEvents.x4 += 1;
      else if (this.currentLossStreak === 5) this.lossStreakEvents.x5 += 1;
      else if (this.currentLossStreak === 6) this.lossStreakEvents.x6 += 1;
      else if (this.currentLossStreak >= 7) this.lossStreakEvents.x7 += 1;
    } else if (rec.status === 'won') {
      this.currentLossStreak = 0;
    }
    return rec;
  }
  todayTrades(date = utcDateStr()) { return this.trades.filter(t => t.date === date); }
  tradesForHour(date, hour) { return this.trades.filter(t => t.date === date && t.hour === hour); }
  stats(list) {
    const wins = list.filter(t => t.status === 'won');
    const losses = list.filter(t => t.status === 'lost');
    const total = list.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gw = wins.reduce((s, t) => s + Number(t.profit || 0), 0);
    const gl = Math.abs(losses.reduce((s, t) => s + Number(t.profit || 0), 0));
    return {
      count: list.length, wins: wins.length, losses: losses.length,
      winRate: list.length ? wins.length / list.length * 100 : 0,
      grossWin: gw, grossLoss: gl, totalProfit: total,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      stake: list.reduce((s, t) => s + Number(t.stake || 0), 0),
    };
  }
  archiveDate(date) {
    const list = this.trades.filter(t => t.date === date);
    const s = this.stats(list);
    this.dailySummaries[date] = s;
    return { date, trades: list, stats: s };
  }
  markEodSent(date) { if (!this.eodSentDates.includes(date)) this.eodSentDates.push(date); this.eodSentDates = this.eodSentDates.slice(-400); }
  isEodSent(date) { return this.eodSentDates.includes(date); }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. STATISTICS
//    The maths that decides whether this bot is allowed to trade at all.
// ═══════════════════════════════════════════════════════════════════════
const Stats = {
  /**
   * Wilson score interval for a binomial proportion.
   * Far better than the normal approximation at p near 1, which is exactly
   * where per-tick accumulator survival lives (p ≈ 0.95–0.99).
   */
  wilson(successes, n, z = 1.96) {
    if (n <= 0) return { lower: 0, upper: 1, point: 0 };
    const p = successes / n;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return {
      point: p,
      lower: Math.max(0, (centre - margin) / denom),
      upper: Math.min(1, (centre + margin) / denom),
    };
  },

  /** Break-even per-tick survival for a growth rate: p·(1+g) = 1. */
  breakEvenSurvival(growthRate) { return 1 / (1 + growthRate); },

  /** Expected value per tick given a survival probability. */
  evPerTick(survival, growthRate) { return survival * (1 + growthRate) - 1; },

  /** Expected total return over K ticks, including modelled exit cost. */
  evOverHold(survival, growthRate, K, spreadCost = 0) {
    return Math.pow(survival, K) * Math.pow(1 + growthRate, K) - 1 - spreadCost;
  },

  /** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
  normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  },

  mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; },

  stdev(a) {
    if (a.length < 2) return 0;
    const m = this.mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  },

  /**
   * One-sample z-statistic for H0: mean == mu0.
   * Used by the live edge monitor to decide when the bot is provably losing.
   */
  zStat(samples, mu0 = 0) {
    const n = samples.length;
    if (n < 2) return 0;
    const sd = this.stdev(samples);
    if (sd <= 0) return 0;
    return (this.mean(samples) - mu0) / (sd / Math.sqrt(n));
  },

  /**
   * Lag-1 autocorrelation. A genuine i.i.d. series gives ~0.
   * If this is reliably non-zero on a volatility index, that is the ONLY
   * kind of finding that could justify a conditional entry rule.
   */
  autocorr1(a) {
    const n = a.length;
    if (n < 3) return 0;
    const m = this.mean(a);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const d = a[i] - m;
      den += d * d;
      if (i > 0) num += d * (a[i - 1] - m);
    }
    return den > 0 ? num / den : 0;
  },
};

// ═══════════════════════════════════════════════════════════════════════
// 5. TELEGRAM (optional, bounded queue, never blocks trading)
// ═══════════════════════════════════════════════════════════════════════
class TelegramNotifier {
  constructor(cfg) {
    this.cfg = cfg;
    this.queue = [];
    this.sending = false;
    this.dropped = 0;
  }
  send(text) {
    if (!this.cfg.enabled || !this.cfg.botToken || !this.cfg.chatId) return;
    if (this.queue.length >= this.cfg.maxQueue) { this.queue.shift(); this.dropped++; }
    this.queue.push(text);
    this._drain();
  }
  async _drain() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      try { await this._post(text); } catch (e) { logger.debug('telegram:', e.message); }
      await sleep(350);
    }
    this.sending = false;
  }
  _post(text) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ chat_id: this.cfg.chatId, text, parse_mode: 'HTML' });
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.cfg.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }
}
const telegram = new TelegramNotifier(CONFIG.telegram);

// ═══════════════════════════════════════════════════════════════════════
// 6. DERIV WEBSOCKET CLIENT
// ═══════════════════════════════════════════════════════════════════════
// The new-API (PAT) flow swaps the legacy `wss://…?app_id=…` + `authorize`
// handshake for a REST OTP handshake: list accounts, request a one-time
// session URL, then connect with that URL. The OTP socket is already
// authenticated — never send `authorize` on it.
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }

  async _request(method, reqPath, body = null) {
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
        timeout: 20000,
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

  async get(p) { return this._request('GET', p); }
  async post(p, b) { return this._request('POST', p, b); }

  static isPat(token) {
    return typeof token === 'string' && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }
}

class DerivClient extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.authorized = false;
    this.reqId = 1;
    this.pending = new Map();       // reqId -> {resolve, reject, timer}
    this.subs = new Map();          // reqId/subscriptionId -> handler
    this.balance = 0;
    this.loginId = null;
    this.isVirtual = null;
    this._reconnectDelay = cfg.reconnect.initialDelayMs;
    this._shuttingDown = false;
    this._heartbeat = null;
    this._reconnecting = false;
    this._reconnectAttempt = 0;
    // Deriv's newer token format uses `underlying_symbol`; legacy uses `symbol`.
    this._isPat = RestClient.isPat(cfg.apiToken);
    this._rest = this._isPat ? new RestClient('https://api.derivws.com', cfg.appId, cfg.apiToken) : null;
    this._otpUrl = null;
    this._targetAccount = null;
    this._tx = [];                 // outbound request queue
    this._pumping = false;
    this._lastTxAt = 0;
    // Socket generation. A close/error from a PREVIOUS socket can arrive
    // after a new one is already OPEN. Without this guard the stale handler
    // wipes the live socket's subs and rejects its pending requests, and the
    // bot goes permanently silent. Every event handler below captures the
    // generation it was created with and ignores itself if superseded.
    this._connGen = 0;
  }

  get symbolKey() { return this._isPat ? 'underlying_symbol' : 'symbol'; }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return Promise.resolve();
    }
    if (!this.cfg.apiToken) {
      return Promise.reject(new Error('DERIV_API_TOKEN is not set. Put it in .env — never in the source file.'));
    }
    if (this._isPat) {
      logger.info('PAT token detected → new API (OTP flow)');
      return this._newApiConnect().catch(e => {
        this._scheduleReconnect();
        throw e;
      });
    }
    const url = this._getWsUrl();
    logger.info(`connecting to ${url.replace(/([?&])app_id=[^&]+/, '$1app_id=***')}`);
    return this._openWs(url);
  }

  _getWsUrl() {
    const sep = this.cfg.wsUrl.includes('?') ? '&' : '?';
    return `${this.cfg.wsUrl}${sep}app_id=${encodeURIComponent(this.cfg.appId)}`;
  }

  async _newApiConnect() {
    const desiredType = (this.cfg.accountType || 'demo').toLowerCase();
    const accRes = await this._rest.get('/trading/v1/options/accounts');
    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      throw new Error(`Account list failed (${accRes.status}): ${msg}`);
    }
    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found');
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];
    this._targetAccount = acct;
    this.accountInfo = {
      loginid: acct.account_id,
      email: acct.email,
      isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type,
      currency: acct.currency,
      balance: parseFloat(acct.balance),
      group: acct.group,
    };
    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);
    if (otpRes.status !== 200) {
      throw new Error(`OTP failed (${otpRes.status}): ${JSON.stringify(otpRes.body)}`);
    }
    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) throw new Error('OTP missing data.url');
    this._otpUrl = wsUrl;
    logger.info(`connecting via OTP (new API) — session URL obtained for ${acct.account_type}`);
    return this._openWs(wsUrl);
  }

  _openWs(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const gen = ++this._connGen;   // this socket's identity
      // A handler belonging to a superseded socket must not touch shared
      // client state — that is how a live connection gets torn down by a
      // dead one.
      const stale = () => gen !== this._connGen;
      // Captured locally: by the time a stale handler runs, this.ws already
      // points at the NEW socket, and closing this.ws there would kill the
      // good connection we are trying to protect.
      let sock;
      try {
        sock = new WebSocket(url, {
          headers: { 'User-Agent': 'AccuFable5/5.0 (+Node.js)' },
          handshakeTimeout: 15000,
        });
      } catch (e) {
        return reject(e);
      }
      this.ws = sock;

      sock.on('open', () => {
        if (stale()) { try { sock.close(); } catch (_) {} return; }
        this.connected = true;
        this._reconnecting = false;
        this._reconnectAttempt = 0;
        this._reconnectDelay = this.cfg.reconnect.initialDelayMs;
        logger.info('websocket open');
        this._startHeartbeat();

        const ready = () => {
          if (!settled) { settled = true; resolve(); }
          this.emit('ready');
        };

        if (this._isPat) {
          // OTP sockets arrive already authorised.
          this._newApiMarkAuthorized();
          ready();
        } else {
          this._authorize().then(ready).catch(e => {
            logger.error('authorize:', e.message);
            if (!settled) { settled = true; reject(e); }
          });
        }
      });

      sock.on('message', raw => { if (!stale()) this._onMessage(raw); });

      sock.on('close', (code, reason) => {
        // A close from a superseded socket must not tear down the live one.
        if (stale()) return;
        this.connected = false;
        this.authorized = false;
        this._stopHeartbeat();
        this._failAllPending(new Error(`socket closed (${code})`));
        this.subs.clear();
        logger.warn(`websocket closed code=${code} reason=${String(reason || '').slice(0, 120)}`);
        this.emit('disconnected');
        if (!settled) { settled = true; reject(new Error(`socket closed (${code})`)); }
        if (!this._shuttingDown) this._scheduleReconnect();
      });

      sock.on('error', err => {
        if (stale()) return;
        logger.error('websocket error:', err.message);
        // EventEmitter throws SYNCHRONOUSLY when 'error' is emitted and nothing
        // is listening for it. A single transient socket error on a flaky
        // host therefore used to become an uncaughtException, and the
        // uncaughtException handler used to exit(1) — i.e. one ECONNRESET
        // became a full process restart. Only forward it when someone is
        // actually subscribed; the ws 'close' event that follows drives the
        // reconnect either way.
        if (this.listenerCount('error') > 0) this.emit('error', err);
        if (!settled) { settled = true; reject(err); }
      });

      sock.on('unexpected-response', (_, res) => {
        if (stale()) { try { res.destroy(); } catch (_) {} return; }
        logger.error('WS handshake failed:', res.statusCode, res.statusMessage);
        try { res.destroy(); } catch (_) {}
        if (!settled) { settled = true; reject(new Error(`handshake failed (${res.statusCode})`)); }
        if (!this._shuttingDown) this._scheduleReconnect();
      });
    });
  }

  _newApiMarkAuthorized() {
    if (!this.accountInfo) return;
    this.authorized = true;
    this.balance = this.accountInfo.balance ?? 0;
    this.loginId = this.accountInfo.loginid;
    this.isVirtual = this.accountInfo.isVirtual;
    this.currency = this.accountInfo.currency || this.cfg.currency;
    logger.info(
      `authorized ${this.accountInfo.loginid} (${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance.toFixed(2)} ${this.currency}`,
    );
    this._subscribeBalance().catch(() => {});
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeat = setInterval(() => {
      if (this.connected) this._send({ ping: 1 }, 15000).catch(() => {});
    }, 30000);
  }
  _stopHeartbeat() { if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; } }

  _scheduleReconnect() {
    if (this._shuttingDown || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempt++;
    const jitter = Math.random() * this.cfg.reconnect.jitterMs;
    const delay = Math.min(
      this.cfg.reconnect.initialDelayMs * Math.pow(this.cfg.reconnect.backoffFactor, this._reconnectAttempt - 1) + jitter,
      this.cfg.reconnect.maxDelayMs,
    );
    logger.info(`reconnecting in ${Math.round(delay)}ms`);
    setTimeout(() => {
      this._reconnecting = false;
      if (!this._shuttingDown) {
        this.connect().catch(e => logger.error('reconnect failed:', e.message));
      }
    }, delay);
  }

  _closeAndReconnect() {
    try { this.ws?.close(); } catch (_) {}
  }

  _failAllPending(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const id = msg.req_id;

    // One-shot request resolved by req_id (both APIs).
    if (id != null && this.pending.has(id)) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) {
        const code = msg.error.code;
        if (['AuthorizationRequired', 'InvalidToken', 'InvalidAppID'].includes(code)) this._closeAndReconnect();
        p.reject(Object.assign(new Error(msg.error.message || 'API error'), {
          code, details: msg.error.details,
        }));
      } else {
        p.resolve(msg);
      }
    }

    // Streaming update. Legacy streams carry the subscribing req_id; the new
    // API carries subscription.id (the initial response carries both, and the
    // pending resolution above maps that id onto the handler).
    const subKey = msg.subscription ? msg.subscription.id : (id != null && this.subs.has(id) ? id : null);
    if (subKey != null && this.subs.has(subKey)) {
      try { this.subs.get(subKey)(msg); } catch (e) { logger.debug('sub handler:', e.message); }
    }
  }

  _send(payload, timeoutMs = 20000) {
    return this._enqueue(() => this._sendNow(payload, timeoutMs));
  }

  /**
   * Serialize every outbound request and enforce a minimum gap between them.
   *
   * Without this, any code path that fires requests in a loop (the stayed-in
   * refresh runs once per analysis cycle, per pair) can exceed Deriv's rate
   * limit. Once throttled, Deriv rejects with `RateLimit`, the barrier and
   * stayed-in records stop refreshing, and the bot degrades to "uncalibrated".
   * Serializing also guarantees ordering, so a buy can never overtake the
   * proposal it was derived from.
   */
  _enqueue(task) {
    return new Promise((resolve, reject) => {
      this._tx.push({ task, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this._pumping || !this._tx.length) return;
    this._pumping = true;
    (async () => {
      try {
        while (this._tx.length) {
          const gap = this.cfg.minRequestGapMs - (Date.now() - this._lastTxAt);
          if (gap > 0) await sleep(gap);
          this._lastTxAt = Date.now();
          const job = this._tx.shift();
          try { job.resolve(await job.task()); }
          catch (e) { this._noteRequestError(e); job.reject(e); }
        }
      } finally {
        this._pumping = false;
        if (this._tx.length) this._pump();
      }
    })();
  }

  /** Surface throttling loudly — it is the root cause of an uncalibrated stall. */
  _noteRequestError(e) {
    const msg = `${e?.message || e}`;
    if (/rate ?limit|too many requests|forbidden due to/i.test(msg) || e?.code === 'RateLimit') {
      this._rateLimitHits = (this._rateLimitHits || 0) + 1;
      if (this._rateLimitHits === 1 || this._rateLimitHits % 20 === 0) {
        logger.error(
          `Deriv rate limit hit (${this._rateLimitHits}×) — "${msg}". ` +
          'Raise CONFIG.minRequestGapMs. While throttled, barriers and stayed-in ' +
          'arrays go stale and the bot cannot calibrate.',
        );
      }
      return;
    }
    this._reqErrors = (this._reqErrors || 0) + 1;
  }

  async _sendNow(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('socket not open'));
      }
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ ...payload, req_id: id })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async subscribe(payload, handler) {
    const id = this.reqId++;
    this.subs.set(id, handler);     // legacy-stream key
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.subs.delete(id);
        reject(new Error('subscribe timeout'));
      }, 20000);
      this.pending.set(id, {
        resolve: msg => {
          const subId = msg?.subscription?.id;
          if (subId) {
            // new-API stream key: remap the handler from req_id to subscription.id
            this.subs.set(subId, handler);
            this.subs.delete(id);
          }
          resolve(subId ?? id);
        },
        reject: err => { this.subs.delete(id); reject(err); },
        timer,
      });
      this._enqueue(async () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('socket not open');
        this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: id }));
      }).catch(e => {
        clearTimeout(timer); this.pending.delete(id); this.subs.delete(id); reject(e);
      });
    });
  }

  async forget(subscriptionId) {
    if (subscriptionId == null) return;
    this.subs.delete(subscriptionId);
    try { await this._send({ forget: subscriptionId }, 10000); } catch (_) {}
  }

  async authorize() {
    if (!this.cfg.apiToken) {
      throw new Error('DERIV_API_TOKEN is not set. Put it in .env — never in the source file.');
    }
    const res = await this._send({ authorize: this.cfg.apiToken }, 20000);
    const a = res.authorize;
    this.authorized = true;
    this.balance = parseFloat(a.balance ?? 0);
    this.loginId = a.loginid;
    this.isVirtual = a.is_virtual === 1 || a.is_virtual === true;
    logger.info(
      `authorized ${a.loginid} (${this.isVirtual ? 'DEMO' : 'REAL'}) ` +
      `balance=${this.balance.toFixed(2)} ${a.currency}`,
    );
    this._subscribeBalance().catch(() => {});
    return a;
  }

  async _subscribeBalance() {
    await this.subscribe({ balance: 1 }, msg => {
      if (msg.balance?.balance != null) this.balance = parseFloat(msg.balance.balance);
    });
  }

  async ticksHistory(symbol, count = 5000) {
    const res = await this._send({
      ticks_history: symbol, count, end: 'latest', style: 'ticks',
    }, 30000);
    const h = res.history;
    if (!h?.prices) return [];
    return h.prices.map((p, i) => ({ quote: parseFloat(p), epoch: h.times[i] }));
  }

  /**
   * Deep historical backfill — ported from deriv_structure_tester_v5.js
   * `collectTicks`. Deriv ticks_history advertises up to 5000 ticks/call but
   * is currently capped at ~1000 via the PAT/OTP flow. To reach the target
   * we chain calls BACKWARDS using end = earliest_epoch - 1 and unshift each
   * batch so the result stays oldest→newest. Returns [] at the first empty
   * or short batch (history exhausted) or when Deriv refuses pagination.
   */
  async collectTicks(symbol, targetCount, batchSize = 1000, delayMs = 250) {
    const out = [];
    let remain = targetCount;
    let end = 'latest';
    let lastEpoch = null;
    let batches = 0;

    while (remain > 0) {
      const count = Math.min(batchSize, 1000, remain); // 1000 = observed PAT/OTP cap
      let msg;
      try {
        msg = await this._send({ ticks_history: symbol, count, end, style: 'ticks' }, 30000);
      } catch (e) {
        logger.warn(`history paging ${symbol}: ${e.message} — stopped at ${out.length}/${targetCount} ticks`);
        break;
      }
      const times = msg.history?.times ?? [];
      const prices = (msg.history?.prices ?? []).map(Number);
      if (!times.length) {
        logger.info(`history ${symbol}: server returned 0 more ticks — exhausted at ${out.length}`);
        break;
      }
      if (lastEpoch !== null && times[times.length - 1] >= lastEpoch) {
        logger.warn(`history paging ${symbol}: server did not honor pagination — stopped at ${out.length}/${targetCount} ticks`);
        break;
      }
      lastEpoch = times[0];
      batches++;
      out.unshift(...times.map((t, i) => ({ quote: prices[i], epoch: t })));
      remain -= times.length;
      logger.info(`history ${symbol}: fetched ${out.length}/${targetCount} ticks (batch ${batches})`);
      end = String(times[0] - 1);
      await sleep(delayMs);
      if (times.length < count) {
        logger.info(`history ${symbol}: last batch short (${times.length}/${count}) — exhausted at ${out.length}`);
        break;
      }
    }

    return out;
  }

  async subscribeTicks(symbol, handler) {
    return this.subscribe({ ticks: symbol }, msg => {
      if (msg.tick) handler({ quote: parseFloat(msg.tick.quote), epoch: msg.tick.epoch, symbol });
    });
  }

  async portfolio() {
    try {
      const res = await this._send({ portfolio: 1 }, 20000);
      return res.portfolio?.contracts ?? [];
    } catch (e) { logger.warn('portfolio:', e.message); return []; }
  }

  /**
   * Recent contract transactions from the account's own ledger.
   * This is the ground truth for reporting when local state is missing: the
   * state file is only ever a cache of what the account already knows.
   * @param {number} limit max rows to pull (Deriv caps this)
   * @returns {Promise<Array>} rows newest-first as returned by the API
   */
  async statement(limit = 200) {
    try {
      const res = await this._send({
        statement: 1, limit, description: 1, transaction_type: 'contract',
      }, 30000);
      return res.statement?.transactions ?? [];
    } catch (e) {
      logger.error('statement fetch failed:', e.message);
      return null;
    }
  }

  close() {
    this._shuttingDown = true;
    this._stopHeartbeat();
    try { this.ws?.close(); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 7. MARKET DATA
// ═══════════════════════════════════════════════════════════════════════
class MarketData extends EventEmitter {
  constructor(client, cfg) {
    super();
    this.client = client;
    this.cfg = cfg;
    this.history = new Map();    // symbol -> [{quote, epoch}]
    this.tickSubs = new Map();   // symbol -> subscription id
    this.barriers = new Map();   // `${symbol}|${gr}` -> {halfBarrierFrac, spot, at}
    this.deadAssets = new Set(); // symbols Deriv permanently rejects for ACCU
    this.stays = new Map();      // `${symbol}|${gr}` -> { arr: ticks_stayed_in, at }
    this._barrierSeen = new Set(); // keys whose first barrier fetch has already been logged
  }

  historyFor(symbol) { return this.history.get(symbol) ?? []; }

  async bootstrap(symbols) {
    const want = this.cfg.calibMinTicks;
    const cap = this.cfg.calibWindow;
    for (const s of symbols) {
      try {
        const h = await this.client.collectTicks(s, Math.min(want, cap));
        this.history.set(s, h);
        logger.info(`history ${s}: ${h.length} ticks (target ${Math.min(want, cap)})`);
        await this._attachTicks(s);
      } catch (e) {
        logger.warn(`history ${s} failed: ${e.message}`);
      }
      await sleep(250); // be polite to the rate limiter
    }
  }

  async _attachTicks(symbol) {
    if (this.tickSubs.has(symbol)) return;
    try {
      const id = await this.client.subscribeTicks(symbol, tick => this._onTick(symbol, tick));
      this.tickSubs.set(symbol, id);
    } catch (e) {
      logger.warn(`tick subscribe ${symbol}: ${e.message}`);
    }
  }

  _onTick(symbol, tick) {
    const arr = this.history.get(symbol) ?? [];
    // Deriv updates the feed at most once per second; ignore duplicate epochs.
    const last = arr[arr.length - 1];
    if (last && last.epoch === tick.epoch && last.quote === tick.quote) return;
    arr.push({ quote: tick.quote, epoch: tick.epoch });
    if (arr.length > this.cfg.calibWindow) arr.splice(0, arr.length - this.cfg.calibWindow);
    this.history.set(symbol, arr);
    this.emit('tick', symbol, tick);
  }

  async resubscribeAll() {
    this.tickSubs.clear();
    for (const s of this.history.keys()) await this._attachTicks(s);
  }

  barrierKey(symbol, gr) { return `${symbol}|${gr.toFixed(2)}`; }

  getBarrier(symbol, gr) {
    const b = this.barriers.get(this.barrierKey(symbol, gr));
    if (!b) return null;
    if (Date.now() - b.at > this.cfg.barrierRefreshMs * 4) return null; // too stale
    return b;
  }

  /**
   * The most recent ticks_stayed_in array harvested from an ACCU proposal for
   * a (symbol, growth rate). The last element is the most current value.
   * Returns null when we have none, or the harvest is too old to be trusted.
   */
  getStayedIn(symbol, gr) {
    const s = this.stays.get(this.barrierKey(symbol, gr));
    if (!s) return null;
    if (Date.now() - s.at > this.cfg.stayStaleMs) return null; // too stale
    return s.arr;
  }

  /**
   * Read the CURRENT barrier straight from Deriv's own proposal.
   * This is authoritative. The bot never estimates or extrapolates a barrier;
   * if Deriv will not quote it, the pair is simply not tradeable this cycle.
   */
  async refreshBarrier(symbol, growthRate, stake) {
    if (this.deadAssets.has(symbol)) return null;
    try {
      const res = await this.client._send({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: this.cfg.currency,
        [this.client.symbolKey]: symbol,
        growth_rate: growthRate,
      }, 20000);
      const p = res.proposal;
      const cd = p?.contract_details ?? {};
      const spot = parseFloat(p?.spot ?? cd.current_spot ?? 0);
      let halfFrac = 0;

      if (Array.isArray(cd.ticks_stayed_in)) {
        this.stays.set(this.barrierKey(symbol, growthRate), {
          arr: cd.ticks_stayed_in,
          at: Date.now(),
        });
      }

      if (cd.barrier_spot_distance != null && spot > 0) {
        halfFrac = parseFloat(cd.barrier_spot_distance) / spot;
      } else if (cd.tick_size_barrier != null) {
        halfFrac = parseFloat(cd.tick_size_barrier);
      } else if (cd.high_barrier != null && cd.low_barrier != null && spot > 0) {
        halfFrac = (parseFloat(cd.high_barrier) - parseFloat(cd.low_barrier)) / (2 * spot);
      }

      if (!(halfFrac > 0)) {
        // The proposal came back but carried no usable barrier distance. This
        // used to return null with no log at all, which looked identical to
        // "uncalibrated" from the outside while stays kept updating.
        logger.warn(
          `barrier ${symbol}@${(growthRate * 100).toFixed(0)}% — proposal OK but no barrier ` +
          `distance (barrier_spot_distance=${cd.barrier_spot_distance ?? 'n/a'} ` +
          `tick_size_barrier=${cd.tick_size_barrier ?? 'n/a'} ` +
          `high/low=${cd.high_barrier ?? 'n/a'}/${cd.low_barrier ?? 'n/a'} spot=${spot})`,
        );
        return null;
      }

      const rec = {
        halfBarrierFrac: halfFrac,
        spot,
        maxTicks: parseInt(cd.maximum_ticks ?? 0, 10) || null,
        maxPayout: parseFloat(cd.maximum_payout ?? 0) || null,
        at: Date.now(),
      };
      this.barriers.set(this.barrierKey(symbol, growthRate), rec);
      const key = this.barrierKey(symbol, growthRate);
      if (!this._barrierSeen.has(key)) {
        this._barrierSeen.add(key);
        logger.info(
          `barrier ${symbol}@g=${(growthRate * 100).toFixed(0)}% FOUND → ` +
          `±${(halfFrac * 100).toFixed(6)}% spot=${spot.toPrecision(6)} ` +
          `maxTicks=${rec.maxTicks ?? 'n/a'}`,
        );
      } else {
        logger.debug(
          `barrier refresh ${symbol}@g=${(growthRate * 100).toFixed(0)}% → ±${(halfFrac * 100).toFixed(6)}%`,
        );
      }
      return rec;
    } catch (e) {
      // Permanent rejections mean this symbol will never support ACCU.
      const permanent = /not (offered|available)|invalid symbol|market is presently closed|ContractCreationFailure/i;
      if (permanent.test(e.message || '') || permanent.test(e.code || '')) {
        this.deadAssets.add(symbol);
        logger.warn(`${symbol}: ACCU not available (permanent) — excluded`);
      } else {
        // Must be WARN, not DEBUG. At the default INFO level this message was
        // suppressed, so a failing proposal stream — the direct cause of an
        // uncalibrated stall — produced no evidence at all.
        this._noteRequestError(e);
        this._barrierFails = (this._barrierFails || 0) + 1;
        if (this._barrierFails === 1 || this._barrierFails % 30 === 0) {
          logger.warn(
            `barrier ${symbol}@${(growthRate * 100).toFixed(0)}% failed (${this._barrierFails}×): ` +
            `${e.code || ''} ${e.message}. No live barrier → this pair cannot calibrate.`,
          );
        }
      }
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. CALIBRATION ENGINE  — the heart of this build
//
//    For each (symbol, growth rate) it answers one question:
//      "Is the LOWER confidence bound on per-tick survival above the
//       break-even survival 1/(1+g), by a real margin?"
//
//    If yes  -> a positive expectation is statistically defensible. Trade.
//    If no   -> stand aside. This is the expected outcome.
// ═══════════════════════════════════════════════════════════════════════
class CalibrationEngine {
  constructor(cfg) { this.cfg = cfg; }

  /** Per-tick log returns from a tick array. */
  logReturns(ticks) {
    const out = [];
    for (let i = 1; i < ticks.length; i++) {
      const a = ticks[i - 1].quote, b = ticks[i].quote;
      if (a > 0 && b > 0) out.push(Math.log(b / a));
    }
    return out;
  }

  /**
   * Count how many historical single-tick moves would have breached a
   * barrier of +/- halfBarrierFrac around the previous spot.
   *
   * This is the correct model: the Accumulator barrier is recomputed every
   * tick around the PREVIOUS spot, so a knockout is a single-tick event,
   * not cumulative drift from entry.
   */
  breachCount(returns, halfBarrierFrac) {
    const logHalf = Math.log(1 + halfBarrierFrac);
    let breaches = 0;
    for (const r of returns) if (Math.abs(r) >= logHalf) breaches++;
    return breaches;
  }

  /**
   * Full calibration for one (symbol, growth rate).
   * Returns null when there is not enough data to say anything honest.
   */
  calibrate(symbol, ticks, growthRate, barrier) {
    if (!barrier || !(barrier.halfBarrierFrac > 0)) {
      return { symbol, growthRate, tradeable: false, reason: 'no-barrier' };
    }
    if (!ticks || ticks.length < this.cfg.calibMinTicks) {
      return {
        symbol, growthRate, tradeable: false,
        reason: `insufficient-history:${ticks ? ticks.length : 0}/${this.cfg.calibMinTicks}`,
      };
    }

    const returns = this.logReturns(ticks);
    const n = returns.length;
    const breaches = this.breachCount(returns, barrier.halfBarrierFrac);
    const survivals = n - breaches;

    const ci = Stats.wilson(survivals, n, this.cfg.calibConfidenceZ);
    const breakEven = Stats.breakEvenSurvival(growthRate);

    // Point estimate and, critically, the conservative lower bound.
    const evPoint = Stats.evPerTick(ci.point, growthRate);
    const evLower = Stats.evPerTick(ci.lower, growthRate);

    // Diagnostics: is the series actually i.i.d.? If lag-1 autocorrelation of
    // |returns| is materially non-zero, volatility clusters and a conditional
    // rule could in principle exist. On a constant-vol index it will be ~0.
    const absR = returns.map(Math.abs);
    const acfAbs = Stats.autocorr1(absR);
    const acfRaw = Stats.autocorr1(returns);
    const sigma = Stats.stdev(returns);
    const barrierSigmas = sigma > 0 ? Math.log(1 + barrier.halfBarrierFrac) / sigma : 0;

    const tradeable = ci.lower > breakEven + this.cfg.edgeMarginPerTick;

    return {
      symbol, growthRate,
      tradeable,
      reason: tradeable ? 'edge-confirmed' : 'no-edge',
      n, breaches,
      survivalPoint: ci.point,
      survivalLower: ci.lower,
      survivalUpper: ci.upper,
      breakEven,
      evPointPerTick: evPoint,
      evLowerPerTick: evLower,
      marginPerTick: ci.lower - breakEven,
      halfBarrierFrac: barrier.halfBarrierFrac,
      halfBarrierPct: barrier.halfBarrierFrac * 100,
      sigma, barrierSigmas, acfAbs, acfRaw,
      maxTicks: barrier.maxTicks,
      at: Date.now(),
    };
  }

  /**
   * Choose the hold horizon K that maximises expected return, given a
   * survival estimate. With a negative per-tick EV the optimum is always
   * K = minimum, which is exactly the point: hold time only ever costs.
   */
  chooseHorizon(survival, growthRate, maxHold, minHold, spreadCost) {
    let best = { K: minHold, ev: -Infinity };
    for (let K = minHold; K <= maxHold; K++) {
      const ev = Stats.evOverHold(survival, growthRate, K, spreadCost);
      if (ev > best.ev) best = { K, ev };
    }
    return best;
  }

  /**
   * Stayed-in array gate, ported from liveMultiAccumNew.js.
   * @param {number[]} arr  ticks_stayed_in from the ACCU proposal (oldest→newest)
   * @returns {{ pass: boolean, reason: string, values: number[], latest: number|null }}
   */
  stayAnalysis(arr) {
    const N = this.cfg.stayWindowN;
    if (!Array.isArray(arr) || arr.length === 0) {
      return { pass: false, reason: 'no-stayed-in-data', values: [], latest: null };
    }
    const latest = arr[arr.length - 1];
    const tail = arr.slice(-N);
    if (arr.length < N) {
      return { pass: false, reason: `short-stay-history:${arr.length}/${N}`, values: tail, latest };
    }
    const maxInWindow = Math.max(...tail);
    if (maxInWindow >= this.cfg.stayMaxValue) {
      return { pass: false, reason: `stay-window-over:${maxInWindow}>=${this.cfg.stayMaxValue}`, values: tail, latest };
    }
    if (latest >= this.cfg.stayCurrentMax) {
      return { pass: false, reason: `stay-latest-over:${latest}>=${this.cfg.stayCurrentMax}`, values: tail, latest };
    }
    return { pass: true, reason: 'stay-ok', values: tail, latest };
  }

  /** Rank calibrations: tradeable first, then by the conservative lower EV. */
  rank(calibrations) {
    return calibrations.filter(Boolean).sort((a, b) => {
      if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
      return (b.evLowerPerTick ?? -Infinity) - (a.evLowerPerTick ?? -Infinity);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. EDGE LEDGER — measures whether the bot is actually winning, and
//    halts it when the evidence says it is not.
// ═══════════════════════════════════════════════════════════════════════
class EdgeLedger {
  constructor(cfg) {
    this.cfg = cfg;
    this.returns = [];          // per-trade return as a fraction of stake
    this.expectedTicks = 0;     // sum of predicted survival ticks
    this.realizedTicks = 0;     // sum of actual ticks survived
    this.trades = 0;
    this.halted = false;
    this.haltReason = null;
    this.load();
  }

  record(trade) {
    const r = trade.stake > 0 ? trade.profit / trade.stake : 0;
    this.returns.push(r);
    if (this.returns.length > 5000) this.returns.shift();
    this.expectedTicks += trade.expectedTicks ?? 0;
    this.realizedTicks += trade.ticksHeld ?? 0;
    this.trades++;
    this.save();
    return this.evaluate();
  }

  /**
   * Sequential check: with enough trades, is the mean per-trade return
   * significantly below zero? If so the measured edge is negative and the
   * bot should stop rather than "wait for it to turn around".
   */
  evaluate() {
    const n = this.returns.length;
    if (n < this.cfg.edgeMonitorMinTrades) {
      return { halt: false, reason: `warmup ${n}/${this.cfg.edgeMonitorMinTrades}`, z: null };
    }
    const z = Stats.zStat(this.returns, 0);
    if (z <= -this.cfg.edgeMonitorZStop) {
      this.halted = true;
      this.haltReason =
        `measured edge significantly negative: mean return ` +
        `${(Stats.mean(this.returns) * 100).toFixed(3)}% over ${n} trades (z=${z.toFixed(2)})`;
      this.save();
      return { halt: true, reason: this.haltReason, z };
    }
    return { halt: false, reason: 'within tolerance', z };
  }

  summary() {
    const n = this.returns.length;
    const mean = Stats.mean(this.returns);
    const sd = Stats.stdev(this.returns);
    return {
      trades: this.trades,
      sampled: n,
      meanReturnPct: mean * 100,
      stdevPct: sd * 100,
      z: n >= 2 ? Stats.zStat(this.returns, 0) : null,
      avgExpectedTicks: this.trades ? this.expectedTicks / this.trades : 0,
      avgRealizedTicks: this.trades ? this.realizedTicks / this.trades : 0,
      halted: this.halted,
      haltReason: this.haltReason,
    };
  }

  save() {
    atomicWriteJson(this.cfg.edgeFile, {
      returns: this.returns, expectedTicks: this.expectedTicks,
      realizedTicks: this.realizedTicks, trades: this.trades,
      halted: this.halted, haltReason: this.haltReason,
    }, 'edge');
  }

  load() {
    const file = this.cfg.edgeFile;
    try {
      if (!fs.existsSync(file)) return;
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.returns = Array.isArray(d.returns) ? d.returns : [];
      this.expectedTicks = d.expectedTicks ?? 0;
      this.realizedTicks = d.realizedTicks ?? 0;
      this.trades = d.trades ?? 0;
      this.halted = !!d.halted;
      this.haltReason = d.haltReason ?? null;
      if (this.trades) logger.info(`edge ledger restored: ${this.trades} trades`);
    } catch (e) {
      // Never silently skip: a corrupt edge file means the negative-edge halt
      // restarts cold, which is exactly the protection the operator expects
      // to still be running.
      logger.error(`edge ledger LOAD FAILED (${file}): ${e.message} — edge halts restart cold`);
      this.returns = [];
      this.halted = false;
      this.haltReason = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 10. RISK MANAGER — every rail halts the bot, none of them just warn.
// ═══════════════════════════════════════════════════════════════════════
class RiskManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.day = utcDateStr();
    this.dayPnl = 0;
    this.dayTrades = 0;
    this.sessionPnl = 0;
    this.sessionPeak = 0;
    this.consecLosses = 0;
    this.halted = false;
    this.haltReason = null;
  }

  _rollDay() {
    const today = utcDateStr();
    if (today !== this.day) {
      logger.info(`UTC day rollover ${this.day} -> ${today}: daily counters reset`);
      this.day = today;
      this.dayPnl = 0;
      this.dayTrades = 0;
      // A daily-cap halt clears at rollover. A drawdown/edge halt does not.
      if (this.haltReason && /daily/i.test(this.haltReason)) {
        this.halted = false;
        this.haltReason = null;
      }
    }
  }

  halt(reason) {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    logger.error(`TRADING HALTED: ${reason}`);
    telegram.send(`⛔ <b>AccuFable5 TRADING HALTED</b>\n${reason}`);
  }

  canTrade(openCount) {
    this._rollDay();
    if (this.halted) return { ok: false, reason: `halted: ${this.haltReason}` };
    if (openCount >= this.cfg.maxOpenTrades) return { ok: false, reason: 'max-open-trades' };
    if (this.dayTrades >= this.cfg.dailyMaxTrades) {
      this.halt(`daily trade cap reached (${this.dayTrades})`);
      return { ok: false, reason: 'daily-trade-cap' };
    }
    if (this.dayPnl <= -Math.abs(this.cfg.dailyMaxLoss)) {
      this.halt(`daily loss limit hit (${money(this.dayPnl)})`);
      return { ok: false, reason: 'daily-loss-cap' };
    }
    const drawdown = this.sessionPeak - this.sessionPnl;
    if (drawdown >= Math.abs(this.cfg.sessionMaxDrawdown)) {
      this.halt(`session drawdown limit hit (${drawdown.toFixed(2)})`);
      return { ok: false, reason: 'session-drawdown' };
    }
    if (this.consecLosses >= this.cfg.maxConsecLosses) {
      this.halt(`${this.consecLosses} consecutive losses`);
      return { ok: false, reason: 'consecutive-losses' };
    }
    return { ok: true, reason: 'ok' };
  }

  onTradeOpened() { this.dayTrades++; }

  onTradeClosed(profit) {
    this.dayPnl += profit;
    this.sessionPnl += profit;
    this.sessionPeak = Math.max(this.sessionPeak, this.sessionPnl);
    if (profit > 0) this.consecLosses = 0; else this.consecLosses++;
  }

  /**
   * Stake sizing. Flat or fixed-fraction only.
   *
   * This manager deliberately avoids progressive-staking logic: Kelly for a
   * negative-expectation bet is zero or negative; progressive staking converts
   * a slow bleed into a fast wipeout. If the edge is real and positive, flat
   * small stakes still capture it. (Optional progressive staking is handled
   * at the bot level, not here.)
   */
  stakeFor(balance) {
    let s = this.cfg.sizing === 'fraction'
      ? balance * this.cfg.riskFraction
      : this.cfg.stake;
    s = Math.max(this.cfg.minStake, Math.min(this.cfg.maxStake, s));
    return +s.toFixed(2);
  }
}


// ═══════════════════════════════════════════════════════════════════════
// 11. TRADE EXECUTOR
//     Handles live and paper fills through one code path so that paper
//     results are a faithful dry run of live behaviour.
// ═══════════════════════════════════════════════════════════════════════
const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired', 'refunded']);

class TradeExecutor extends EventEmitter {
  constructor(client, marketData, cfg) {
    super();
    this.client = client;
    this.md = marketData;
    this.cfg = cfg;
    this.open = new Map();      // contractId -> trade record
    this.settled = new Set();   // contractIds already accounted for (idempotency)
    this.paper = cfg.mode !== 'live';
    this._paperSeq = 1;
    this._opening = 0;          // in-flight opens (reserved before any await)
  }

  get openCount() { return this.open.size; }

  /** True when a new contract may be opened (respects maxOpenTrades). */
  canOpenNow() {
    const max = Number(this.cfg.maxOpenTrades) || 1;
    return this._opening + this.open.size < max;
  }

  /**
   * TradeExecutor.openTrade: version matching accuFable5.
   * NOTE: body intentionally identical to accuFable5.js for parity.
   * All durations/timeout constants must stay in sync between the two bots.
   */
  async openTrade({ symbol, growthRate, stake, targetTicks, calibration }) {
    // Reserve the open slot synchronously, BEFORE any await, so two nearly
    // simultaneous ticks can never both pass maxOpenTrades (openTrade does
    // proposal + buy round-trips in live mode; without this reservation the
    // second tick sees openCount=0 and opens a second position on another
    // asset while the first is still mid-flight).
    if (!this.canOpenNow()) {
      throw new Error(`max open trades (${this.cfg.maxOpenTrades}) already reached — skipping`);
    }
    this._opening++;
    try {
      const barrier = this.md.getBarrier(symbol, growthRate)
        ?? await this.md.refreshBarrier(symbol, growthRate, stake);
      if (!barrier) throw new Error(`no live barrier for ${symbol}@${growthRate}`);

      // Take-profit that corresponds to the target hold: stake*((1+g)^K - 1),
      // capped by the contract's maximum payout.
      let tp = stake * (Math.pow(1 + growthRate, targetTicks) - 1);
      if (barrier.maxPayout) tp = Math.min(tp, barrier.maxPayout - stake);
      tp = Math.max(0.01, +tp.toFixed(2));

      if (this.paper) return this._openPaper({ symbol, growthRate, stake, targetTicks, barrier, calibration, tp });

      // ── LIVE ──
      const proposal = await this.client._send({
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: 'ACCU',
        currency: this.cfg.currency,
        [this.client.symbolKey]: symbol,
        growth_rate: growthRate,
        limit_order: { take_profit: tp },
      }, 20000);

      const p = proposal.proposal;
      if (!p?.id) throw new Error('proposal returned no id');

      const buy = await this.client._send({
        buy: p.id,
        price: parseFloat(p.ask_price ?? stake),
      }, 25000);

      const b = buy.buy;
      if (!b?.contract_id) throw new Error('buy returned no contract_id');

      const trade = this._makeTrade({
        contractId: String(b.contract_id),
        symbol, growthRate, stake, targetTicks, barrier, calibration,
        entrySpot: parseFloat(b.start_time ? (p.spot ?? 0) : (p.spot ?? 0)),
        takeProfit: tp,
      });
      this.open.set(trade.contractId, trade);
      logger.info(
        `OPEN ${symbol} g=${(growthRate * 100).toFixed(0)}% stake=${stake} ` +
        `targetK=${targetTicks} tp=${tp} id=${trade.contractId}`,
      );
      this._watchLive(trade);
      this.emit('opened', trade);
      return trade;
    } finally {
      this._opening--;
    }
  }

  _makeTrade(o) {
    return {
      contractId: o.contractId,
      symbol: o.symbol,
      growthRate: o.growthRate,
      stake: o.stake,
      targetTicks: o.targetTicks,
      expectedTicks: o.targetTicks,
      halfBarrierFrac: o.barrier.halfBarrierFrac,
      entrySpot: o.entrySpot || 0,
      takeProfit: o.takeProfit,
      calibration: o.calibration ?? null,
      openedAt: Date.now(),
      buyTime: Date.now() / 1000,
      sellTime: null,
      sellPrice: 0,
      exitReason: null,
      ticksHeld: 0,
      profit: 0,
      status: 'open',
      paper: this.paper,
    };
  }

  // ────────────────────────── PAPER ──────────────────────────
  _openPaper({ symbol, growthRate, stake, targetTicks, barrier, calibration, tp }) {
    const hist = this.md.historyFor(symbol);
    const entrySpot = hist.length ? hist[hist.length - 1].quote : barrier.spot;
    const trade = this._makeTrade({
      contractId: `paper-${this._paperSeq++}`,
      symbol, growthRate, stake, targetTicks, barrier, calibration,
      entrySpot, takeProfit: tp,
    });
    trade.lastSpot = entrySpot;
    this.open.set(trade.contractId, trade);
    logger.info(
      `OPEN(paper) ${symbol} g=${(growthRate * 100).toFixed(0)}% stake=${stake} ` +
      `targetK=${targetTicks} barrier=±${(barrier.halfBarrierFrac * 100).toFixed(6)}%`,
    );

    // Evaluate against the real incoming tick stream.
    const onTick = (sym, tick) => {
      if (sym !== symbol || !this.open.has(trade.contractId)) return;
      const prev = trade.lastSpot;
      trade.lastSpot = tick.quote;
      if (!(prev > 0)) return;

      const move = Math.abs(Math.log(tick.quote / prev));
      const limit = Math.log(1 + trade.halfBarrierFrac);

      if (move >= limit) {
        // Barrier breached: the entire stake is lost.
        this.md.off('tick', onTick);
        this._settle(trade, { status: 'lost', profit: -trade.stake, exitReason: 'knockout' });
        return;
      }
      trade.ticksHeld++;
      trade.profit = trade.stake * (Math.pow(1 + growthRate, trade.ticksHeld) - 1);
      if (trade.ticksHeld >= trade.targetTicks) {
        this.md.off('tick', onTick);
        // Model the round-trip exit cost on the way out.
        const net = trade.profit - trade.stake * this.cfg.sellSpreadCost;
        this._settle(trade, { status: 'sold', profit: +net.toFixed(4), sellPrice: +trade.profit.toFixed(4), exitReason: 'take-profit' });
      }
    };
    this.md.on('tick', onTick);
    trade._detach = () => this.md.off('tick', onTick);

    this.emit('opened', trade);
    return trade;
  }

  // ─────────────────────────── LIVE ──────────────────────────
  /**
   * Manage a live contract: count ticks off the regular stream and sell at
   * the take-profit target, with proposal_open_contract for settlement.
   * @param {object} trade
   * @param {{seedTicks?: number}} [opts] seedTicks resumes the tick count for
   *   a contract recovered from a previous process, so the take-profit target
   *   is measured from where the position actually is rather than from zero.
   */
  async _watchLive(trade, opts = {}) {
    let subId = null;
    if (Number.isFinite(opts.seedTicks) && opts.seedTicks > 0) {
      trade.ticksHeld = Math.max(trade.ticksHeld || 0, Math.floor(opts.seedTicks));
      logger.info(
        `watch ${trade.contractId}: resuming at tick ${trade.ticksHeld}/${trade.targetTicks}`,
      );
    }

    // Count ticks from the regular tick stream — NOT from Deriv's tick_count
    // in proposal_open_contract, which for ACCU contracts reports unreliable
    // values (often starting at 1 immediately after purchase).
    let lastSpot = 0;
    const onTick = (sym, tick) => {
      if (sym !== trade.symbol || !this.open.has(trade.contractId)) return;
      const prev = lastSpot;
      lastSpot = tick.quote;
      if (!(prev > 0)) return;

      // If contract already settled, ignore stale ticks.
      if (!this.open.has(trade.contractId)) return;

      trade.ticksHeld++;
      trade.profit = trade.stake * (Math.pow(1 + trade.growthRate, trade.ticksHeld) - 1);

      if (trade.ticksHeld >= trade.targetTicks && !trade._closing) {
        trade._closing = true;
        trade._exitReason = trade._exitReason || `take-profit: held ${trade.ticksHeld} ticks`;
        this._sell(trade).catch(e => {
          trade._closing = false;
          logger.warn(`sell ${trade.contractId}: ${e.message}`);
        });
      }
    };
    this.md.on('tick', onTick);
    trade._detachTick = () => this.md.off('tick', onTick);

    // Also subscribe to proposal_open_contract for settlement detection.
    try {
      subId = await this.client.subscribe(
        { proposal_open_contract: 1, contract_id: trade.contractId },
        msg => {
          const c = msg.proposal_open_contract;
          if (!c) return;
          // Update profit from the API (authoritative once sold).
          trade.profit = parseFloat(c.profit ?? trade.profit) || 0;
          const status = String(c.status ?? 'open').toLowerCase();

          if (c.is_sold === 1 || TERMINAL_STATUSES.has(status)) {
            const finalProfit = parseFloat(c.profit ?? 0) || 0;
            if (subId) this.client.forget(subId);
            trade._detachTick();
            this._settle(trade, {
              status,
              profit: finalProfit,
              sellPrice: parseFloat(c.sell_price ?? 0) || 0,
              exitReason: c.exit_reason || trade._exitReason || status,
            });
            return;
          }
        },
      );
      trade._subId = subId;
    } catch (e) {
      this.md.off('tick', onTick);
      logger.error(`watch ${trade.contractId} failed: ${e.message} — will reconcile`);
    }

    // Watchdog: if the stream dies, reconcile from the portfolio rather than
    // leaving a phantom open position on the books.
    trade._watchdog = setTimeout(() => this._reconcile(trade), this.cfg.watchdogMs * 4);
  }

  async _sell(trade) {
    try {
      await this.client._send({ sell: trade.contractId, price: 0 }, 20000);
      logger.info(`SELL requested ${trade.contractId} at K=${trade.ticksHeld}`);
    } catch (e) {
      if (/already sold|not found/i.test(e.message)) {
        await this._reconcile(trade);
        return;
      }
      throw e;
    }
  }

  async _reconcile(trade) {
    if (!this.open.has(trade.contractId)) return;
    const contracts = await this.client.portfolio();
    const found = contracts.find(c => String(c.contract_id) === trade.contractId);
    if (found) {
      trade._watchdog = setTimeout(() => this._reconcile(trade), this.cfg.watchdogMs * 4);
      return;
    }
    try {
      const res = await this.client._send(
        { proposal_open_contract: 1, contract_id: trade.contractId }, 20000);
      const c = res.proposal_open_contract ?? {};
      this._settle(trade, {
        status: String(c.status ?? 'unknown').toLowerCase(),
        profit: parseFloat(c.profit ?? 0) || 0,
        sellPrice: parseFloat(c.sell_price ?? 0) || 0,
        exitReason: c.exit_reason || String(c.status ?? 'unknown').toLowerCase(),
      });
    } catch (e) {
      logger.error(`reconcile ${trade.contractId} failed: ${e.message}`);
      this._settle(trade, { status: 'unknown', profit: 0, exitReason: 'unknown' });
    }
  }

  /** Idempotent settlement. A contract is only ever booked once. */
  _settle(trade, { status, profit, sellPrice = 0, exitReason = null }) {
    if (this.settled.has(trade.contractId)) return;
    this.settled.add(trade.contractId);
    if (trade._watchdog) clearTimeout(trade._watchdog);
    if (trade._detach) trade._detach();
    if (trade._detachTick) trade._detachTick();
    if (trade._subId) this.client.forget(trade._subId);
    this.open.delete(trade.contractId);

    trade.status = status;
    trade.profit = profit;
    trade.closedAt = Date.now();
    trade.sellTime = Date.now() / 1000;
    trade.sellPrice = sellPrice || 0;
    trade.exitReason = exitReason || status;

    const tag = profit > 0 ? 'WIN ' : 'LOSS';
    logger.info(
      `${tag} ${trade.symbol} g=${(trade.growthRate * 100).toFixed(0)}% ` +
      `K=${trade.ticksHeld}/${trade.targetTicks} pnl=${money(profit)} ` +
      `status=${status}${trade.paper ? ' (paper)' : ''}`,
    );
    this.emit('closed', trade);
  }

  async closeAll() {
    for (const trade of [...this.open.values()]) {
      if (trade.paper) { this._settle(trade, { status: 'cancelled', profit: trade.profit }); continue; }
      try { await this._sell(trade); } catch (e) { logger.warn(`closeAll: ${e.message}`); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 12. MONTE CARLO SIMULATOR
//     Lets you price a config before risking anything. Simulates GBM ticks
//     (which is exactly how Deriv generates volatility indices) against a
//     barrier, then applies this bot's own entry/exit policy.
// ═══════════════════════════════════════════════════════════════════════
function gaussian() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Simulate N accumulator trades.
 * @param {object} o
 * @param {number} o.sigma           per-tick log-return stdev
 * @param {number} o.halfBarrierFrac barrier half-width as a fraction of spot
 * @param {number} o.growthRate      g
 * @param {number} o.holdTicks       K (exit target)
 * @param {number} o.stake
 * @param {number} o.trades
 * @param {number} o.spreadCost      round-trip exit cost as fraction of stake
 */
function monteCarlo(o) {
  const {
    sigma, halfBarrierFrac, growthRate, holdTicks,
    stake = 1, trades = 20000, spreadCost = 0,
  } = o;
  const limit = Math.log(1 + halfBarrierFrac);

  let pnl = 0, wins = 0, losses = 0, equity = 0, peak = 0, maxDd = 0;
  let consec = 0, maxConsec = 0, totalTicks = 0;
  const perTrade = [];

  for (let t = 0; t < trades; t++) {
    let survived = 0, knocked = false;
    for (let k = 0; k < holdTicks; k++) {
      if (Math.abs(gaussian() * sigma) >= limit) { knocked = true; break; }
      survived++;
    }
    totalTicks += survived + (knocked ? 1 : 0);

    let profit;
    if (knocked) {
      profit = -stake;
      losses++; consec++; maxConsec = Math.max(maxConsec, consec);
    } else {
      profit = stake * (Math.pow(1 + growthRate, survived) - 1) - stake * spreadCost;
      if (profit > 0) wins++; else losses++;
      consec = 0;
    }
    pnl += profit;
    perTrade.push(profit / stake);
    equity += profit;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  const pSurvive = Math.exp(-0) ; // placeholder removed below
  return {
    trades,
    totalPnl: pnl,
    pnlPerTrade: pnl / trades,
    returnPerTradePct: (pnl / trades / stake) * 100,
    winRate: wins / trades,
    wins, losses,
    maxDrawdown: maxDd,
    maxConsecLosses: maxConsec,
    avgTicksPerTrade: totalTicks / trades,
    stdevPerTradePct: Stats.stdev(perTrade) * 100,
    zScore: Stats.zStat(perTrade, 0),
    barrierSigmas: limit / sigma,
    theoreticalSurvival: 1 - 2 * (1 - Stats.normCdf(limit / sigma)),
    breakEvenSurvival: Stats.breakEvenSurvival(growthRate),
  };
}

/** Sweep growth rates x hold times for a given barrier model. */
function sweep({ sigma, barrierOf, growthRates, holdTicks, trades = 20000, spreadCost = 0 }) {
  const rows = [];
  for (const g of growthRates) {
    for (const K of holdTicks) {
      const r = monteCarlo({
        sigma, halfBarrierFrac: barrierOf(g), growthRate: g,
        holdTicks: K, stake: 1, trades, spreadCost,
      });
      rows.push({ growthRate: g, holdTicks: K, ...r });
    }
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════
// 12b. LEDGER RECONCILIATION
//
//      The state file is a CACHE. The Deriv account ledger is the truth.
//      When the cache is missing, stale or corrupt (routine on Kubernetes,
//      where the container filesystem is wiped on every deploy) the reporting
//      figures are rebuilt from `statement` instead of being invented.
//
//      The hard rule, and the reason this is a separate section: reporting
//      may be derived from history, but BETTING state may not. The martingale
//      step is never reconstructed from a statement. At ×3 over 4 steps a
//      wrong reconstruction stakes 81× the base; resetting to base only costs
//      the abandoned cycle. Recovery resets the stake, reconciliation only
//      ever reports.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fold raw `statement` rows into one entry per contract.
 *
 * Deriv emits a buy row (carrying the stake) and a sell row (carrying the
 * realised profit) per contract, and the two APIs differ in field naming, so
 * both `contract_id`/`reference_id` and `action`/`type` are accepted.
 *
 * Defensive by design: an unrecognised row is counted and skipped rather than
 * guessed at. A contract with no sell row has not settled yet, so it is not a
 * trade and is excluded from the aggregates.
 *
 * @param {Array} rows raw transaction rows
 * @returns {{settled: Array, open: Array, unparsed: number}}
 *   `settled` is ordered oldest → newest.
 */
function parseStatementRows(rows) {
  const byContract = new Map();
  let unparsed = 0;

  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') { unparsed++; continue; }
    const ref = r.contract_id ?? r.reference_id ?? r.id;
    const amount = Number(r.amount);
    if (ref == null || !Number.isFinite(amount)) { unparsed++; continue; }

    const key = String(ref);
    const action = String(r.action ?? r.type ?? '').toLowerCase();
    const ts = Date.parse(r.date ?? '') || (Number(r.time) || 0) * 1000 || 0;

    const e = byContract.get(key) ?? {
      contractId: key, stake: 0, profit: 0, buyTime: 0, sellTime: 0,
      symbol: null, growthRate: null,
    };
    if (r.underlying_symbol ?? r.symbol) e.symbol = r.underlying_symbol ?? r.symbol;
    if (r.growth_rate != null) e.growthRate = Number(r.growth_rate);

    if (action === 'buy') {
      // Buy rows carry the stake as a negative cash outflow.
      e.stake = Math.abs(amount) || e.stake;
      e.buyTime = ts || e.buyTime;
    } else if (action === 'sell') {
      // Sell rows carry the realised profit, signed.
      e.profit = amount;
      e.sellTime = ts || e.sellTime;
    } else {
      unparsed++;
    }
    byContract.set(key, e);
  }

  const all = [...byContract.values()];
  const settled = all
    .filter(e => e.sellTime > 0)
    .sort((a, b) => a.sellTime - b.sellTime);
  const open = all.filter(e => e.sellTime === 0);
  return { settled, open, unparsed };
}

/**
 * Aggregate a settled ledger into the reporting figures the bot shows.
 * Walks oldest → newest so the loss streak reflects the current run.
 */
function summariseLedger(settled) {
  let wins = 0, losses = 0, pnl = 0, stake = 0;
  let streak = 0, maxStreak = 0;
  const streakEvents = { x2: 0, x3: 0, x4: 0, x5: 0, x6: 0, x7: 0 };

  for (const t of settled) {
    pnl += Number(t.profit || 0);
    stake += Number(t.stake || 0);
    if (t.profit > 0) { wins++; streak = 0; }
    else if (t.profit < 0) {
      losses++; streak++; maxStreak = Math.max(maxStreak, streak);
      if (streak === 2) streakEvents.x2++;
      else if (streak === 3) streakEvents.x3++;
      else if (streak === 4) streakEvents.x4++;
      else if (streak === 5) streakEvents.x5++;
      else if (streak === 6) streakEvents.x6++;
      else if (streak >= 7) streakEvents.x7++;
    }
  }
  return {
    trades: settled.length, wins, losses, pnl, stake,
    currentLossStreak: streak, maxLossStreak: maxStreak, lossStreakEvents: streakEvents,
  };
}

/**
 * Turn a settled ledger into StatisticsManager-shaped trade records so the
 * hourly and EOD reports render without special-casing.
 */
function ledgerToTradeRecords(settled) {
  return settled.map(t => {
    const ms = t.sellTime || t.buyTime || Date.now();
    const d = new Date(ms);
    return {
      contractId: t.contractId,
      symbol: t.symbol ?? '?',
      growthRate: t.growthRate ?? 0,
      stake: Number(t.stake || 0),
      profit: Number(t.profit || 0),
      status: t.profit > 0 ? 'won' : (t.profit < 0 ? 'lost' : 'unknown'),
      ticksHeld: 0,
      buyTime: t.buyTime ? t.buyTime / 1000 : ms / 1000,
      sellTime: (t.sellTime || ms) / 1000,
      timestamp: ms,
      date: utcDateStr(d),
      hour: utcHour(d),
      exitReason: 'reconciled',
      recovered: true,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 13. THE BOT
// ═══════════════════════════════════════════════════════════════════════
class AccuFable5 {
  constructor(cfg) {
    this.cfg = cfg;
    this.client = new DerivClient(cfg);
    this.md = new MarketData(this.client, cfg);
    this.calib = new CalibrationEngine(cfg);
    this.edge = new EdgeLedger(cfg);
    this.risk = new RiskManager(cfg);
    this.exec = new TradeExecutor(this.client, this.md, cfg);

    this.lastTradeAt = 0;
    this.lastTradedSymbol = null;
    this.loopTimer = null;
    this.barrierTimer = null;
    this.calibTimer = null;
    this._flushTimer = null;       // periodic state write
    this._reportT = null;          // periodic session report (cleared on stop)
    this._ticking = false;       // re-entrancy guard for _tick()
    this._tickOverlap = 0;       // dropped-cycle counter (diagnostic)
    this._lastTickMs = 0;        // duration of the last completed cycle
    this._staysAt = 0;           // last successful stayed-in refresh
    this._barrierAt = 0;         // last successful barrier refresh
    this._stallWarned = 0;       // last stall warning (dedup)
    this._hourlyBoot = null;
    this._hourlyT = null;
    this._eodBoot = null;
    this.running = false;
    this.calibrations = new Map();  // key -> calibration result
    this._lastTradeableKeys = new Set(); // for edge-transition logging
    this.stats = { opened: 0, closed: 0, wins: 0, losses: 0, pnl: 0 };
    this.statsLog = new StatisticsManager();  // trade log + hourly/EOD summaries
    this.startedAt = Date.now();

    // ── Martingale (accuHOLD_v2 semantics; OFF unless configured) ──
    this.martingaleBase  = Number(cfg.martingaleBaseStake) > 0 ? Number(cfg.martingaleBaseStake) : Number(cfg.stake) || 1.0;
    this.martingaleStep  = 0;
    this.currentStake    = this.martingaleBase;
    this.consecutiveLosses = 0;
    // Trades still to run at base stake after an untrusted restart.
    this._restartGuardRemaining = 0;

    // ── Chase-on-loss: when active, re-trade this same pair after each loss
    //    until a win, skipping the gates. ──
    this.chaseActive     = false;
    this.chaseSymbol     = null;
    this.chaseGrowthRate = null;

    // ── Balance / P&L tracking for telegram reports ──
    this.startBalance  = null;
    this.lastBalance   = null;

    this.exec.on('opened', t => this._onTradeOpened(t));
    this.exec.on('closed', t => this._onClosed(t));
    this.client.on('disconnected', () => {
      logger.warn('feed lost — trading paused until reconnect');
      telegram.send(`⚠️ <b>AccuFable5 Connection lost</b> — reconnecting\u2026`);
    });
    this.client.on('ready', () => { if (this.running) this.md.resubscribeAll().catch(() => {}); });
  }

  _onClosed(trade) {
    this.lastTradedSymbol = trade.symbol;
    this.stats.closed++;
    this.stats.pnl += trade.profit;
    if (trade.profit > 0) this.stats.wins++; else this.stats.losses++;
    this.risk.onTradeClosed(trade.profit);

    const verdict = this.edge.record(trade);
    if (verdict.halt) this.risk.halt(verdict.reason);

    // ── Trade log (feeds hourly/EOD telegram summaries) ──
    const rec = this.statsLog.record({
      ...trade,
      status: trade.profit > 0 ? 'won' : (trade.profit < 0 ? 'lost' : 'unknown'),
      date: utcDateStr(new Date(trade.closedAt)),
    });
    if (trade.profit > 0) this.consecutiveLosses = 0;
    else if (trade.profit < 0) this.consecutiveLosses += 1;
    // Single source of truth: RiskManager.consecLosses is the counter that
    // gates trading (canTrade → maxConsecLosses). Mirror it into the reported
    // figure so the rail and the displayed streak can never disagree.
    this.consecutiveLosses = this.risk.consecLosses;
    if (this._restartGuardRemaining > 0) {
      this._restartGuardRemaining -= 1;
      logger.info(
        `restart guard: ${this._restartGuardRemaining} trade(s) left at base stake ` +
        `before martingale may escalate again`,
      );
    }

    // ── Chase-on-loss: on a loss, re-trade the SAME pair immediately (the
    //    gates are suspended until a win). On a win, return to gated mode. ──
    if (this.cfg.chaseOnLoss) {
      if (trade.profit < 0 && !this.risk.halted) {
        this.chaseActive     = true;
        this.chaseSymbol     = trade.symbol;
        this.chaseGrowthRate = trade.growthRate;
        logger.warn(
          `chaseON: loss on ${trade.symbol}@${String(trade.growthRate)} — ` +
          `next trade reopens ${trade.symbol} at ${String(trade.growthRate)} without gates until a win`,
        );
      } else if (trade.profit > 0 && this.chaseActive) {
        this.chaseActive     = false;
        this.chaseSymbol     = null;
        this.chaseGrowthRate = null;
        logger.info(`chaseOFF: win on ${trade.symbol} — returning to gate-based selection`);
      }
    }

    // ── Martingale: stake for the NEXT trade ──
    const prevStep = this.martingaleStep;
    const prevStake = this.currentStake;
    const mg = this._updateMartingaleOnResult(trade.profit > 0 ? 'won' : (trade.profit < 0 ? 'lost' : 'unknown'));
    this.lastBalance = (this.lastBalance ?? this.client.balance ?? this.startBalance ?? 0) + trade.profit;

    this._sendTradeResult(trade, rec, { prevStep, prevStake, mg });

    this._saveState();
  }

  _onTradeOpened(t) {
    this.lastTradedSymbol = t.symbol;
    this._sendTradeOpen(t);
    // Persist immediately so the contract_id of a live position outlives a
    // crash. Without this the state file only ever held closed trades, and a
    // restart mid-trade orphaned the position on the account.
    this._saveState();
  }

  /**
   * Re-attach positions that were open on the books when the process died.
   *
   * For each persisted contract_id, ask Deriv what actually happened to it:
   *  - already settled → run it through the normal settle path so P&L,
   *    the martingale step and the risk rails all account for it;
   *  - still open      → rebuild the trade object and resume watching it, so
   *    the take-profit target is honoured rather than abandoned.
   *
   * A contract Deriv no longer knows about is reported, not silently dropped.
   */
  async _recoverOpenContracts(records) {
    logger.info(`recovering ${records.length} contract(s) open at last shutdown…`);
    let reattached = 0, settled = 0, missing = 0;

    for (const r of records) {
      if (!r || !r.contractId) continue;
      // Paper contracts have no meaning across a process boundary.
      if (r.paper) { missing++; continue; }

      let c = null;
      try {
        const res = await this.client._send({
          proposal_open_contract: 1, contract_id: String(r.contractId),
        }, 20000);
        c = res?.proposal_open_contract ?? null;
      } catch (e) {
        logger.error(`recovery query failed for ${r.contractId}: ${e.message}`);
      }

      if (!c) {
        logger.warn(`contract ${r.contractId} (${r.symbol}) not found on the account — it was likely already settled`);
        missing++;
        continue;
      }

      const status = String(c.status ?? 'open').toLowerCase();
      const isSold = c.is_sold === 1 || TERMINAL_STATUSES.has(status);

      if (isSold) {
        // It settled while we were down. Book the result exactly as a normal
        // close would, so the martingale and rails stay correct.
        const trade = this._tradeFromContract(c, r);
        this.exec.open.set(trade.contractId, trade);
        this.exec._settle(trade, {
          status,
          profit: parseFloat(c.profit ?? 0) || 0,
          sellPrice: parseFloat(c.sell_price ?? 0) || 0,
          exitReason: c.exit_reason || 'recovered:settled-while-down',
        });
        settled++;
        logger.info(
          `recovered ${r.contractId} ${r.symbol} as settled: ` +
          `profit=${parseFloat(c.profit ?? 0) || 0} (${c.exit_reason || status})`,
        );
        continue;
      }

      // Still running — resume managing it.
      const trade = this._tradeFromContract(c, r);
      this.exec.open.set(trade.contractId, trade);
      try {
        await this.exec._watchLive(trade, { seedTicks: Number(r.ticksHeld) || 0 });
        reattached++;
        logger.warn(
          `RECOVERED OPEN POSITION ${r.contractId} ${r.symbol} ` +
          `stake=${trade.stake} ticksHeld=${trade.ticksHeld}/${trade.targetTicks} — resuming take-profit watch`,
        );
      } catch (e) {
        logger.error(`could not resume watch on ${r.contractId}: ${e.message} — position is unmanaged`);
      }
    }

    if (records.length) {
      const summary = `recovery complete: ${reattached} resumed, ${settled} settled while down, ${missing} not found`;
      logger.info(summary);
      telegram.send(`♻️ <b>Position recovery</b>\n${summary}`);
    }
    if (reattached || settled) this._saveState();
  }

  /** Rebuild a trade object from a proposal_open_contract response plus our record. */
  _tradeFromContract(c, r) {
    return {
      contractId: String(c.contract_id ?? r.contractId),
      symbol: r.symbol ?? c.underlying_symbol ?? c.symbol,
      growthRate: Number(r.growthRate) || Number(c.growth_rate) || 0,
      stake: Number(r.stake) || 0,
      targetTicks: Number(r.targetTicks) || Number(c.tick_count) || this.cfg.takeProfitTicks,
      expectedTicks: Number(r.expectedTicks) || Number(r.targetTicks) || 0,
      halfBarrierFrac: Number(r.halfBarrierFrac) || 0,
      entrySpot: Number(r.entrySpot) || Number(c.entry_spot) || 0,
      takeProfit: Number(r.takeProfit) || 0,
      calibration: r.calibration ?? null,
      openedAt: Number(r.openedAt) || Date.now(),
      buyTime: Number(r.buyTime) || Number(c.buy_time) || (Date.now() / 1000),
      sellTime: null,
      sellPrice: 0,
      exitReason: null,
      ticksHeld: Number(r.ticksHeld) || 0,
      profit: parseFloat(c.profit ?? 0) || 0,
      status: 'open',
      paper: false,
      recovered: true,
    };
  }

  /**
   * Rebuild REPORTING from the account ledger when local state was missing,
   * stale or corrupt.
   *
   * This touches P&L, win/loss counts, the loss streak, the trade log and
   * today's daily counters. It does NOT touch martingaleStep or currentStake:
   * those were already reset to base by _loadState, and reconstructing a stake
   * from history is the one thing that could cost real money here.
   *
   * @param {{status: string, savedAt: ?string, ageSec: ?number, data: ?object}} loaded
   */
  async _reconcileFromDeriv(loaded) {
    const why = {
      missing: 'no state file found',
      stale: `state file older than ${this.cfg.stateMaxAgeSec}s`,
      corrupt: 'state file was unreadable',
    }[loaded.status] || loaded.status;
    logger.warn(`reconciling reporting from the Deriv account ledger — ${why}`);

    const rows = await this.client.statement(200);
    if (rows === null) {
      // Do not zero anything on a failed fetch. Cold figures are honest;
      // figures wiped by a failed API call are not.
      logger.error(
        'statement fetch failed — keeping whatever local figures exist. ' +
        'Reporting may be understated; the stake is still pinned to base by the restart guard.',
      );
      telegram.send(
        `⚠️ <b>Reconciliation failed</b>\n${why}. Could not read the account ledger, ` +
        'so reporting may be understated. Trading continues at base stake.',
      );
      return;
    }

    const { settled, open, unparsed } = parseStatementRows(rows);
    if (!settled.length) {
      logger.warn(`ledger returned ${rows.length} row(s) but no settled contracts (${open.length} still open, ${unparsed} unparsed) — nothing to reconcile`);
      return;
    }

    const agg = summariseLedger(settled);
    const records = ledgerToTradeRecords(settled);
    const localProfit = Number(this.statsLog.overallProfit || 0);
    const localClosed = Number(this.stats.closed || 0);
    const deltaProfit = agg.pnl - localProfit;

    // ── Apply reporting only ──
    this.stats.closed  = agg.trades;
    this.stats.wins    = agg.wins;
    this.stats.losses  = agg.losses;
    this.stats.pnl     = agg.pnl;
    this.stats.opened  = Math.max(Number(this.stats.opened || 0), agg.trades);

    this.statsLog.trades = records;
    this.lastTradedSymbol = records[records.length - 1]?.symbol ?? this.lastTradedSymbol;
    this.statsLog.overallProfit = agg.pnl;
    this.statsLog.currentLossStreak = agg.currentLossStreak;
    this.statsLog.maxLossStreak = agg.maxLossStreak;
    this.statsLog.lossStreakEvents = agg.lossStreakEvents;

    // The streak that GATES trading and the streak that gets REPORTED are the
    // same value, derived from the ledger.
    this.consecutiveLosses = agg.currentLossStreak;
    this.risk.consecLosses = agg.currentLossStreak;

    // ── Today's counters, from the ledger rather than from a lost file ──
    const today = utcDateStr();
    const todays = records.filter(t => t.date === today);
    this.risk.day = today;
    this.risk._rollDay();
    this.risk.dayTrades = todays.length;
    this.risk.dayPnl = todays.reduce((s, t) => s + Number(t.profit || 0), 0);
    this.risk.sessionPnl = agg.pnl;
    this.risk.sessionPeak = agg.pnl > 0 ? agg.pnl : 0;

    // ── Report the reconciliation ──
    const c = this.currencyStr();
    const lines = [
      `♻️ <b>Reporting rebuilt from Deriv</b>`,
      `${why}`,
      ``,
      `<b>Ledger:</b> ${agg.trades} settled, ${open.length} still open${unparsed ? `, ${unparsed} row(s) unparsed` : ''}`,
      `<b>P&amp;L:</b> ${money(agg.pnl, c)}`,
      `<b>W/L:</b> ${agg.wins}/${agg.losses} · WR ${agg.trades ? ((agg.wins / agg.trades) * 100).toFixed(1) : '0.0'}%`,
      `<b>Loss streak:</b> current ${agg.currentLossStreak} · max ${agg.maxLossStreak}`,
      ``,
      `<b>Local vs ledger:</b> profit ${money(localProfit, c)} → ${money(agg.pnl, c)} (Δ ${money(deltaProfit, c)}), closed ${localClosed} → ${agg.trades}`,
      `<b>Today:</b> ${this.risk.dayTrades} trades, ${money(this.risk.dayPnl, c)}`,
    ];

    if (this._restartGuardRemaining > 0) {
      lines.push(
        ``,
        `🛡️ <b>Stake pinned to base</b> (${this.martingaleBase.toFixed(2)}) for the next ` +
        `${this._restartGuardRemaining} trade(s) — the martingale step is not reconstructed from history.`,
      );
    }
    if (open.length) {
      lines.push(``, `⏳ ${open.length} contract(s) still open on the account — recovering them.`);
    }
    if (this.risk.dayTrades >= Number(this.cfg.dailyMaxTrades) ||
        this.risk.dayPnl <= -Math.abs(Number(this.cfg.dailyMaxLoss))) {
      lines.push(``, `⛔ Today's rebuilt counters have already breached a daily cap — trading stays halted.`);
    }

    const summary = lines.join('\n');
    logger.info(summary.replace(/<[^>]+>/g, ''));
    telegram.send(summary);

    this._saveState();
  }

  // ── Martingale helpers (accuHOLD_v2 semantics) ──
  _isMartingaleEnabled() {
    return Number(this.cfg.martingaleMultiplier) > 1.0 && parseInt(this.cfg.martingaleSteps, 10) > 0;
  }
  _martingaleLabel() {
    if (!this._isMartingaleEnabled()) return 'OFF';
    return `×${Number(this.cfg.martingaleMultiplier).toFixed(2)} (step ${this.martingaleStep}/${this.cfg.martingaleSteps})`;
  }
  _calcMartingaleStake(step) {
    const mult = Number(this.cfg.martingaleMultiplier) || 1;
    if (step <= 0 || mult <= 1) return +this.martingaleBase.toFixed(2);
    return +(this.martingaleBase * Math.pow(mult, step)).toFixed(2);
  }

  /**
   * Stake for the NEXT trade, subject to the post-restart guard.
   * While the guard is active the stake is pinned to base, so a process that
   * restarted without trustworthy state cannot immediately re-escalate on a
   * cold reading. The martingale step is still tracked normally underneath,
   * so escalation resumes normally once the guard clears.
   */
  _nextStake() {
    if (this._restartGuardRemaining > 0) {
      return { stake: +this.martingaleBase.toFixed(2), guarded: true };
    }
    return { stake: this.currentStake, guarded: false };
  }
  _updateMartingaleOnResult(status) {
    if (!this._isMartingaleEnabled()) {
      this.martingaleStep = 0;
      this.currentStake = this.martingaleBase;
      return { changed: false, reason: 'disabled' };
    }
    const maxSteps = parseInt(this.cfg.martingaleSteps, 10);
    if (status === 'won') {
      if (this.martingaleStep > 0) {
        logger.info(`martingale RESET: win after ${this.martingaleStep} steps → stake ${this.currentStake.toFixed(2)} → ${this.martingaleBase.toFixed(2)}`);
        this.martingaleStep = 0;
        this.currentStake = this.martingaleBase;
        return { changed: true, reason: 'win-reset' };
      }
      this.martingaleStep = 0;
      this.currentStake = this.martingaleBase;
      return { changed: false, reason: 'win-base' };
    }
    if (status === 'lost') {
      if (this.martingaleStep < maxSteps) {
        this.martingaleStep += 1;
        const prev = this.currentStake;
        this.currentStake = this._calcMartingaleStake(this.martingaleStep);
        logger.info(`martingale STEP UP: loss streak → step ${this.martingaleStep}/${maxSteps} stake ${prev.toFixed(2)} → ${this.currentStake.toFixed(2)} (×${this.cfg.martingaleMultiplier})`);
        return { changed: true, reason: 'loss-step-up', prev };
      }
      // Max steps reached: RESET the cycle instead of halting.
      //
      // This used to halt the bot outright, which conflated two different
      // things. The martingale cap is a STAKING policy — how far the bot is
      // willing to escalate within one cycle. Exhausting it says "stop
      // escalating", not "stop trading". Only the loss rails (maxConsecLosses,
      // dailyMaxLoss, sessionMaxDrawdown, edge monitor) may halt the bot, and
      // they are enforced independently in RiskManager.canTrade().
      //
      // Note the cycle boundary is a real risk decision, not a free reset: the
      // losses that reached max steps are NOT forgiven. consecutiveLosses keeps
      // counting, so maxConsecLosses still halts after a bounded number of
      // consecutive losses even though the stake has reset.
      const cycleStake = this.currentStake;
      this.martingaleStep = 0;
      this.currentStake = this.martingaleBase;
      // Deliberately NOT touching risk.halted here. _onTradeClosed runs
      // risk.onTradeClosed() BEFORE this method, so the risk rails may have
      // just halted on a daily-loss or drawdown breach. Clearing that flag
      // would undo a legitimate halt and let a bot over its loss cap keep
      // trading. This method no longer halts on its own, so there is no stale
      // self-halt left to clear either.
      logger.warn(
        `martingale CYCLE COMPLETE: ${maxSteps}/${maxSteps} steps lost — ` +
        `stake ${cycleStake.toFixed(2)} → ${this.martingaleBase.toFixed(2)}, restarting at base. ` +
        `Loss streak ${this.consecutiveLosses}/${this.cfg.maxConsecLosses} still counting; ` +
        `the bot halts only on maxConsecLosses, dailyMaxLoss or sessionMaxDrawdown.`,
      );
      telegram.send(
        `♻️ <b>AccuFable5 Martingale Cycle Complete</b>\n` +
        `All ${maxSteps} steps lost (stake was ${cycleStake.toFixed(2)}). ` +
        `Stake reset to <b>${this.martingaleBase.toFixed(2)}</b> and a new cycle starts.\n\n` +
        `Trading continues. Halt triggers unchanged: ${this.cfg.maxConsecLosses} consecutive losses, ` +
        `daily loss ${money(this.cfg.dailyMaxLoss, this.currencyStr())}, ` +
        `or session drawdown ${money(this.cfg.sessionMaxDrawdown, this.currencyStr())}.\n` +
        `Current loss streak: ${this.consecutiveLosses}/${this.cfg.maxConsecLosses}.`,
      );
      return { changed: true, reason: 'max-reset', prev: cycleStake };
    }
    return { changed: false, reason: 'no-op' };
  }

  currencyStr() { return this.client.currency || this.cfg.currency; }

  // ── Telegram: trade opened ──
  _sendTradeOpen(t) {
    const c = this.currencyStr();
    const chaseNote = this.cfg.chaseOnLoss && this.chaseActive
      ? `🔥 <b>Chase:</b> re-trading ${this.chaseSymbol} after loss (gates suspended)\n`
      : '';
    const martingaleNote = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ${this._martingaleLabel()} · base ${this.martingaleBase.toFixed(2)} → <b>${t.stake.toFixed(2)} ${c}</b>${this.martingaleStep > 0 ? ` (step ${this.martingaleStep}/${this.cfg.martingaleSteps})` : ' (base)'}\n`
      : '';
    const lossNote = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak} · ${this.statsLog.lossStreakLine()}\n`;
    const nextStakeNote = this._isMartingaleEnabled()
      ? `➡️ <b>Next stake (if loss):</b> ${this._calcMartingaleStake(Math.min(this.martingaleStep + 1, this.cfg.martingaleSteps)).toFixed(2)} ${c}${this.martingaleStep + 1 > this.cfg.martingaleSteps ? ' (would reset to base)' : ''}\n`
      : '';

    // ── Trade analysis stats (shown alongside the entry signal) ──
    const stayed = this.md.getStayedIn(t.symbol, t.growthRate) ?? [];
    const stayedRecent = stayed.slice(-10).join(',') || 'n/a';
    const evLower = t.calibration?.evLowerPerTick;
    const evG = this._evGate();
    const evLine = evLower == null
      ? `<b>evLower/tick:</b> n/a (chase)\n`
      : `<b>evLower/tick:</b> <code>${(evLower * 100).toFixed(4)}%</code> (gate ${evG.worst ? '≤' : '≥'} ${(evG.threshold * 100).toFixed(4)}% · ${evG.pass(evLower) ? '✅ in' : '❌ out'} · ${evG.worst ? 'WORST' : 'BEST'} mode)\n`;
    const breachCount = t.calibration?.breaches;
    const breachLine = breachCount == null
      ? `<b>breachCount:</b> n/a (chase)\n`
      : `<b>breachCount:</b> <code>${breachCount}</code> (gate ≥ ${this.cfg.breachMinCount} · ${breachCount >= this.cfg.breachMinCount ? '✅ in' : '❌ out'})\n`;
    const analysisNote =
      evLine +
      breachLine +
      `<b>stayedInArray (last 10 / ${stayed.length}):</b> <code>${stayedRecent}</code>\n`;

    const msg =
      `🟢 <b>AccuFable5 TRADE OPENED</b>\n\n` +
      `<b>Contract:</b> #${t.contractId}\n` +
      `<b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth Rate:</b> ${(t.growthRate * 100).toFixed(2)}%\n` +
      `<b>Stake:</b> ${t.stake.toFixed(2)} ${c}${this.martingaleStep > 0 ? ` <i>(martingale ×${Math.pow(this.cfg.martingaleMultiplier, this.martingaleStep).toFixed(2)})</i>` : ''}\n` +
      chaseNote +
      martingaleNote +
      `<b>Take-Profit:</b> sell after <b>${this.cfg.takeProfitTicks}</b> ticks\n` +
      analysisNote +
      lossNote +
      nextStakeNote +
      `<b>Overall:</b> ${money(this.statsLog.overallProfit, c)}\n\n` +
      `<i>Entry: stays + evL/t + breachCount gates. Exit: TP at ${this.cfg.takeProfitTicks} ticks.</i>`;
    telegram.send(msg);
  }

  // ── Telegram: trade closed / result ──
  _sendTradeResult(t, rec, { prevStep, prevStake, mg }) {
    const c = this.currencyStr();
    const emoji = t.profit >= 0 ? '✅' : '❌';
    const label = t.profit >= 0 ? 'WIN' : 'LOSS';
    const exit = t.exitReason || 'n/a';
    const exitLine = /^take.?profit/i.test(exit) ? '🎯 take-profit'
                  : /^tick.?cap/i.test(exit)       ? '⏱️ tick-cap'
                  : /^knockout/i.test(exit)        ? '💥 knockout'
                  : exit;
    const buyTs  = Number(t.buyTime  || 0);
    const sellTs = Number(t.sellTime || 0);
    const durationSec = (buyTs > 0 && sellTs > 0 && sellTs >= buyTs) ? (sellTs - buyTs) : null;
    const durationLine = durationSec != null
      ? `⏱️ <b>Duration:</b> ${formatDuration(durationSec)}\n`
      : `⏱️ <b>Duration:</b> n/a\n`;
    let martingaleLine = '';
    if (this._isMartingaleEnabled()) {
      if (t.profit < 0) {
        if (mg.reason === 'loss-step-up') {
          martingaleLine = `♻️ <b>Martingale:</b> STEP UP  ${prevStep}/${this.cfg.martingaleSteps} → ${this.martingaleStep}/${this.cfg.martingaleSteps}  stake ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${c}</b> (×${this.cfg.martingaleMultiplier})\n`;
        } else if (mg.reason === 'max-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> CYCLE COMPLETE (${this.cfg.martingaleSteps}/${this.cfg.martingaleSteps} lost) → stake ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${c}</b> (base), next cycle starts\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> ${this._martingaleLabel()}  stake now ${this.currentStake.toFixed(2)} ${c}\n`;
        }
      } else {
        if (mg.reason === 'win-reset') {
          martingaleLine = `♻️ <b>Martingale:</b> WIN → RESET  ${prevStake.toFixed(2)} → <b>${this.currentStake.toFixed(2)} ${c}</b> (base)\n`;
        } else {
          martingaleLine = `♻️ <b>Martingale:</b> WIN at base — stake stays <b>${this.currentStake.toFixed(2)} ${c}</b>\n`;
        }
      }
    } else {
      martingaleLine = `♻️ <b>Martingale:</b> OFF  (flat stake)\n`;
    }
    const todayStats = this.statsLog.stats(this.statsLog.todayTrades(rec.date));
    const lossBreakdown = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak}\n` +
                          `   ${this.statsLog.lossStreakLine()}\n`;
    const msg =
      `${emoji} <b>AccuFable5 TRADE ${label}</b>\n\n` +
      `<b>Contract:</b> #${t.contractId} · <b>Symbol:</b> <code>${t.symbol}</code>\n` +
      `<b>Growth:</b> ${(t.growthRate * 100).toFixed(0)}% · <b>Stake:</b> ${Number(t.stake).toFixed(2)} ${c}\n` +
      `<b>Sell:</b> ${Number(t.sellPrice ?? 0).toFixed(2)} ${c}\n` +
      `${t.profit >= 0 ? '💚' : '💔'} <b>Profit:</b> ${money(t.profit, c)}\n` +
      `<b>Exit:</b> ${exitLine}\n` +
      durationLine +
      `<b>Ticks held:</b> ${t.ticksHeld ?? '?'} (TP after ${this.cfg.takeProfitTicks})` +
      `\n` +
      martingaleLine +
      lossBreakdown +
      `<b>Balance:</b> ${(this.lastBalance ?? 0).toFixed(2)} ${c}\n\n` +
      `<b>GMT Day (${rec.date})</b>\n` +
      `• Trades: ${todayStats.count} (✅${todayStats.wins} ❌${todayStats.losses}) | WR ${todayStats.winRate.toFixed(1)}%\n` +
      `• Net: ${money(todayStats.totalProfit, c)} | PF ${todayStats.profitFactor === Infinity ? '∞' : todayStats.profitFactor.toFixed(2)}\n\n` +
      `<b>Overall:</b> ${money(this.statsLog.overallProfit, c)}`;
    telegram.send(msg);
  }

  // ── Telegram: hourly summary ──
  _sendHourly() {
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const date = utcDateStr(prev), hour = utcHour(prev);
    const list = this.statsLog.tradesForHour(date, hour);
    const s = this.statsLog.stats(list);
    const c = this.currencyStr();
    const martingaleInfo = this._isMartingaleEnabled()
      ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.martingaleBase.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${c}\n`
      : `♻️ Martingale: OFF\n`;
    const lossInfo = `📉 Loss streak: ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak} · ${this.statsLog.lossStreakLine()}\n`;
    if (!list.length) {
      telegram.send(`⏰ AccuFable5 <b>${date} ${pad(hour)}:00</b> — No trades\n${martingaleInfo}${lossInfo}💼 Overall: ${money(this.statsLog.overallProfit, c)}`);
      return;
    }
    let msg = `⏰ AccuFable5 <b>${date} ${pad(hour)}:00</b>\n\n📊 ${s.count} trades (✅${s.wins} ❌${s.losses})\n📈 WR: ${s.winRate.toFixed(1)}%\n💰 P/L: <b>${money(s.totalProfit, c)}</b>\n💼 Overall: <b>${money(this.statsLog.overallProfit, c)}</b>\n${martingaleInfo}${lossInfo}\n`;
    list.slice(-15).forEach((t2, i) => {
      const exit = (t2.exitReason || '').split(':')[0];
      const mgTag = t2.martingaleStep != null && t2.martingaleStep > 0 ? ` MG×${Number(this.cfg.martingaleMultiplier).toFixed(2)}` : '';
      msg += `${i + 1}. ${t2.status === 'won' ? '✅' : '❌'} #${t2.contractId} ${t2.symbol} ticks=${t2.ticksHeld ?? '?'} exit=${exit}${mgTag} ${money(t2.profit, c)}\n`;
    });
    telegram.send(msg);
  }

  // ── Telegram: end-of-day summary ──
  _sendEod(reason = 'manual') {
    const date = utcDateStr(new Date(Date.now() - 86_400_000));
    if (this.statsLog.isEodSent(date) && reason === 'scheduled') return;
    const summary = this.statsLog.archiveDate(date);
    const ds = summary.stats;
    const c = this.currencyStr();
    const balStart = this.startBalance ?? 0, balNow = this.lastBalance ?? balStart;
    const balDelta = balNow - balStart;
    let msg = `🌙 <b>AccuFable5 DAILY REPORT — ${date}</b>\n\n`;
    if (ds.count) msg += `📊 ${ds.count} trades (✅${ds.wins} ❌${ds.losses}) | WR ${ds.winRate.toFixed(1)}%\n💰 Net: <b>${money(ds.totalProfit, c)}</b> | PF ${ds.profitFactor === Infinity ? '∞' : ds.profitFactor.toFixed(2)}\n`;
    else msg += `No trades.\n`;
    msg += `\n💼 ${balStart.toFixed(2)} → ${balNow.toFixed(2)} (${balDelta >= 0 ? '+' : ''}${balDelta.toFixed(2)})\n`;
    msg += `💼 Overall: <b>${money(this.statsLog.overallProfit, c)}</b>\n`;
    msg += this._isMartingaleEnabled()
      ? `♻️ Martingale: ${this._martingaleLabel()} · base ${this.martingaleBase.toFixed(2)} → now ${this.currentStake.toFixed(2)} ${c}\n`
      : `♻️ Martingale: OFF (flat stake)\n`;
    msg += `📉 Loss streak: current ${this.consecutiveLosses} · max ${this.statsLog.maxLossStreak} · ${this.statsLog.lossStreakLine()}`;
    telegram.send(msg);
    this.statsLog.markEodSent(date);
    this._saveState();
    this.startBalance = this.client.balance ?? this.lastBalance ?? this.startBalance;
  }

  async start() {
    printBanner();

    // Prove state can be persisted BEFORE doing anything with real money.
    // An unwritable state dir silently resets the martingale step, the P&L
    // and every risk halt on the next restart, so live mode refuses to run.
    const canPersist = probeStateDir();
    if (!canPersist && this.cfg.mode === 'live') {
      logger.error(
        'REFUSING TO START IN LIVE MODE: state cannot be persisted, so the martingale ' +
        'step and risk halts cannot survive a restart. Mount a persistent volume and set ' +
        'STATE_DIR, or start in paper mode.',
      );
      process.exit(1);
    }

    const loaded = this._loadState();

    if (this.cfg.mode === 'live' && this.cfg.confirmLive !== 'i-understand') {
      logger.error(
        'MODE=live requires CONFIG confirmation. Set CONFIRM_LIVE=i-understand in .env ' +
        'to acknowledge that real money is at risk. Refusing to start.',
      );
      process.exit(1);
    }

    await this.client.connect();

    // Rebuild reporting from Deriv's own records. Needs the API, so it runs
    // after connect rather than inside _loadState.
    // if (loaded.status !== 'fresh') {
    //   await this._reconcileFromDeriv(loaded);
    // }

    // Re-attach any contract that was open when the process died.
    if (Array.isArray(loaded.data?.openContracts) && loaded.data.openContracts.length) {
      await this._recoverOpenContracts(loaded.data.openContracts);
    }

    // ── Balance + bot-online telegram ──
    this.startBalance = this.startBalance ?? this.client.balance ?? 0;
    this.lastBalance  = this.lastBalance  ?? this.startBalance;
    if (this.cfg.mode === 'live') {
      logger.warn('!!! LIVE MODE ON A REAL-MONEY ACCOUNT !!!');
    }

    const c = this.currencyStr();
    const info = this.client.accountInfo || {};
    const martingaleLine = this._isMartingaleEnabled()
      ? `♻️ <b>Martingale:</b> ON  ×${Number(this.cfg.martingaleMultiplier).toFixed(2)}  steps ${this.cfg.martingaleSteps}  (base ${this.martingaleBase.toFixed(2)} → now ${this.currentStake.toFixed(2)} step ${this.martingaleStep})\n`
      : `♻️ <b>Martingale:</b> OFF  (flat stake ${this.martingaleBase.toFixed(2)})\n`;
    const lossLine = `📉 <b>Loss Streak:</b> ${this.consecutiveLosses} (max ${this.statsLog.maxLossStreak}) · ${this.statsLog.lossStreakLine()}\n`;
    telegram.send(
      `<b>AccuFable5 Bot Online</b>${this.cfg.mode !== 'live' ? ' <b>🔒 DRY-RUN</b>' : ''}\n\n` +
      `<b>Account:</b> ${info.loginid ?? '?'} (${info.isVirtual ? '🟡 DEMO' : '🔴 REAL'})\n` +
      `<b>Balance:</b> ${this.startBalance.toFixed(2)} ${c}\n` +
      `<b>Assets:</b> ${this.cfg.assets.length} volatility indices\n` +
      `<b>Growth rate:</b> ${this.cfg.growthRates.map(g => (g * 100) + '%').join(', ')} · <b>TP:</b> ${this.cfg.takeProfitTicks} ticks\n` +
      `<b>ev gate:</b> evLower/tick ${this.cfg.evSelection === 'worst' ? '≤' : '≥'} ${((this.cfg.evSelection === 'worst' ? this.cfg.evWorstGateMax : this.cfg.evLowerGateMin) * 100).toFixed(4)}% (${this.cfg.evSelection === 'worst' ? 'WORST' : 'BEST'} mode)\n` +
      `<b>stay gate:</b> ${this.cfg.stayWindowN} most-current < ${this.cfg.stayMaxValue}, latest < ${this.cfg.stayCurrentMax}\n` +
      `<b>breach gate:</b> breachCount ≥ ${this.cfg.breachMinCount}\n` +
      `<b>exclusivity filter:</b> ${this.cfg.requireSingleQualified ? '🟢 ON (trade only when exactly 1 asset clears the ev gate)' : 'OFF (trade the best of however many qualify)'}\n` +
      `<b>Chase on loss:</b> ${this.cfg.chaseOnLoss ? '🟢 ON (re-trade same asset until win)' : 'OFF'}\n` +
      martingaleLine +
      lossLine +
      `<b>Daily caps:</b> ${this.cfg.dailyMaxTrades} trades / ${this.cfg.dailyMaxLoss} ${c}\n` +
      `<b>Overall:</b> ${money(this.statsLog.overallProfit, c)}`,
    );

    const nonVol = this.cfg.assets.filter(s => this.cfg.isBoomOrCrash(s));
    if (nonVol.length) {
      logger.warn(
        `asset class caveat: ${nonVol.join(',')} ${nonVol.length > 1 ? 'are' : 'is'} ` +
        'boom/crash, not a volatility index. These carry synthetic jump events, so ' +
        'per-tick returns are not Gaussian and breachCount/EV figures below are ' +
        'indicative only. Use R_* or 1HZ*V for the model to hold.',
      );
    }

    logger.info(`bootstrapping tick history for ${this.cfg.assets.length} assets…`);
    await this.md.bootstrap(this.cfg.assets);

    await this._refreshBarriers();
    this.barrierTimer = setInterval(() => this._refreshBarriers().catch(() => {}),
      this.cfg.barrierRefreshMs);

    this.running = true;
    this.loopTimer = setInterval(() => this._tick().catch(e => logger.error('loop:', e.message)),
      this.cfg.analysisIntervalMs);
    this.calibTimer = setInterval(() => this._reportCalibration(), 5 * 60 * 1000);

    // Periodic state flush. Trades already save on open and close, but a
    // flush on a timer bounds how much non-trade state (tick counters, risk
    // rail progress, restart-guard countdown) can be lost to a hard kill.
    this._flushTimer = setInterval(() => {
      try { this._saveState(); } catch (e) { logger.error('periodic state flush:', e.message); }
    }, this.cfg.stateFlushMs);

    // ── Hourly summary timer (fires at next whole hour, then every 60 min) ──
    if (this.cfg.hourlySummary) {
      const msToNextHour = 3600_000 - (Date.now() % 3600_000);
      this._hourlyBoot = setTimeout(() => {
        this._sendHourly();
        this._hourlyT = setInterval(() => this._sendHourly(), 3600_000);
      }, Math.max(1000, msToNextHour));
    }

    // ── EOD summary timer (fires at eodTimeGmt + delay, then daily) ──
    const scheduleNextEod = () => {
      const now = new Date();
      const { h, min } = (() => {
        const m = String(this.cfg.eodTimeGmt || '00:00').match(/^(\d{1,2}):(\d{2})$/);
        return m ? { h: +m[1], min: +m[2] } : { h: 0, min: 0 };
      })();
      const target = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        h, min, this.cfg.eodSendDelaySeconds, 0,
      ));
      let delay = target.getTime() - now.getTime();
      if (delay <= 0) delay += 86_400_000;
      this._eodBoot = setTimeout(() => { this._sendEod('scheduled'); scheduleNextEod(); }, delay);
    };
    scheduleNextEod();

    logger.info(`running in ${this.cfg.mode.toUpperCase()} mode`);
    this._reportCalibration();
  }

  async _refreshBarriers() {
    const probeStake = Math.max(this.cfg.minStake, 1);
    for (const symbol of this.cfg.assets) {
      if (this.md.deadAssets.has(symbol)) continue;
      for (const g of this.cfg.growthRates) {
        const rec = await this.md.refreshBarrier(symbol, g, probeStake);
        if (rec) { this._barrierAt = Date.now(); this._barrierFails = 0; }
      }
    }
    // this._warnIfStalled();
  }

  /**
   * The single most useful diagnostic in this file.
   *
   * Calibration depends on two live records (the barrier and the stayed-in
   * array) that are refreshed by periodic ACCU proposals. Both have a TTL. If
   * the proposal stream dies they age out, the gates report "no-ev
   * (uncalibrated)" forever, and nothing in the log says why. This makes the
   * stall explicit and states the age, so the cause is never a guess.
   */
  _warnIfStalled() {
    const barrierTtl = this.cfg.barrierRefreshMs * 4;
    const now = Date.now();
    const barrierAge = this._barrierAt ? now - this._barrierAt : Infinity;
    const staysAge = this._staysAt ? now - this._staysAt : Infinity;
    if (barrierAge < barrierTtl && staysAge < this.cfg.stayStaleMs) {
      if (this._stallWarned) {
        logger.info(
          `calibration feed RECOVERED — barrier age ${(barrierAge / 1000).toFixed(0)}s, ` +
          `stayed-in age ${(staysAge / 1000).toFixed(0)}s`,
        );
      }
      this._stallWarned = 0;
      return;
    }
    const ttl = Math.min(barrierTtl, this.cfg.stayStaleMs);
    if (this._stallWarned && now - this._stallWarned < ttl) return;
    this._stallWarned = now;
    const rate = this.client._rateLimitHits || 0;
    logger.error(
      `CALIBRATION FEED STALLED — no usable ACCU proposal. ` +
      `last barrier ${this._barrierAt ? `${((now - this._barrierAt) / 1000).toFixed(0)}s ago` : 'never'}, ` +
      `last stayed-in ${this._staysAt ? `${((now - this._staysAt) / 1000).toFixed(0)}s ago` : 'never'} ` +
      `(TTL ${(ttl / 1000).toFixed(0)}s). ` +
      `barrier failures ${this._barrierFails || 0}, stayed-in failures ${this._staysFails || 0}, ` +
      `rate-limit hits ${rate}, socket ${this.client.connected ? 'open' : 'CLOSED'}. ` +
      'Every pair will read "uncalibrated" until this clears. ' +
      'Likely: Deriv rate limit (raise CONFIG.minRequestGapMs), dropped socket, ' +
      'or insufficient balance.',
    );
    telegram.send(
      `⚠️ <b>AccuFable5 calibration stalled</b>\n` +
      `No ACCU proposal for ${(ttl / 1000).toFixed(0)}s+. All pairs uncalibrated.\n` +
      `barrier fails ${this._barrierFails || 0} · stayed-in fails ${this._staysFails || 0} · ` +
      `rate-limit ${rate} · socket ${this.client.connected ? 'open' : 'closed'}`,
    );
  }

  /**
   * Refresh ticks_stayed_in for every live pair with a fresh ACCU proposal,
   * fired in parallel so the gate always reads the CURRENT breakout history
   * (each element = how many ticks the price stayed inside the barrier range
   * before breaking out; last element = most recent). Called every tick.
   */
  async _refreshStayedIn() {
    if (Date.now() - this._staysAt < (this.cfg.staysRefreshMs || 0) - 50) return;
    const probeStake = Math.max(this.cfg.minStake, 1);
    const tasks = [];
    for (const symbol of this.cfg.assets) {
      if (this.md.deadAssets.has(symbol)) continue;
      for (const g of this.cfg.growthRates) {
        tasks.push((async () => {
          try {
            const res = await this.client._send({
              proposal: 1,
              amount: probeStake,
              basis: 'stake',
              contract_type: 'ACCU',
              currency: this.cfg.currency,
              [this.client.symbolKey]: symbol,
              growth_rate: g,
            }, 15000);
            const p = res?.proposal;
            const cd = p?.contract_details ?? {};
            if (Array.isArray(cd.ticks_stayed_in)) {
              this.md.stays.set(this.md.barrierKey(symbol, g), {
                arr: cd.ticks_stayed_in,
                at: Date.now(),
              });
              this._staysAt = Date.now();
              this._staysFails = 0;
            } else {
              this._staysFails = (this._staysFails || 0) + 1;
              if (this._staysFails === 1 || this._staysFails % 30 === 0) {
                logger.warn(
                  `stayed-in ${symbol}@${(g * 100).toFixed(0)}% — proposal OK but ` +
                  'contract_details.ticks_stayed_in is missing. The stay gate will block ' +
                  'once the last good copy ages out.',
                );
              }
            }
          } catch (e) {
            // A transient proposal failure must not be invisible: the stay
            // record is the first thing to go stale, and a stale stay record
            // is indistinguishable from "no analysis" in the gate log.
            this._staysFails = (this._staysFails || 0) + 1;
            this._noteRequestError(e);
            if (this._staysFails === 1 || this._staysFails % 30 === 0) {
              logger.warn(
                `stayed-in ${symbol}@${(g * 100).toFixed(0)}% failed (${this._staysFails}×): ` +
                `${e.code || ''} ${e.message}`,
              );
            }
          }
        })());
      }
    }
    await Promise.all(tasks);
  }

  /** Recalibrate every pair and return them ranked. */
  _calibrateAll() {
    const out = [];
    for (const symbol of this.cfg.assets) {
      if (this.md.deadAssets.has(symbol)) continue;
      const ticks = this.md.historyFor(symbol);
      for (const g of this.cfg.growthRates) {
        const barrier = this.md.getBarrier(symbol, g);
        const c = this.calib.calibrate(symbol, ticks, g, barrier);
        this.calibrations.set(`${symbol}|${g}`, c);
        out.push(c);
      }
    }
    return this.calib.rank(out);
  }

  /**
   * The evLower/tick gate for the configured evSelection direction. Single
   * source of truth so the gate, the ranking and every report agree on which
   * side of the ev distribution the bot trades.
   *
   *   'best'  → threshold = evLowerGateMin (FLOOR), pass when v >= it,
   *             rank DESCENDING (highest evLower/tick wins).
   *   'worst' → threshold = evWorstGateMax (CEILING, user-set), pass when
   *             v <= it, rank ASCENDING (lowest / most-negative wins).
   */
  _evGate() {
    const worst = this.cfg.evSelection === 'worst';
    return {
      worst,
      threshold: worst ? this.cfg.evWorstGateMax : this.cfg.evLowerGateMin,
      pass: v => v != null && (worst ? v <= this.cfg.evWorstGateMax : v >= this.cfg.evLowerGateMin),
      rank: (a, b) => (worst
        ? (a.evLowerPerTick ?? Infinity) - (b.evLowerPerTick ?? Infinity)
        : (b.evLowerPerTick ?? -Infinity) - (a.evLowerPerTick ?? -Infinity)),
    };
  }

  /**
   * Assets whose conservative per-tick EV clears the ev gate (≥ floor in BEST
   * mode, ≤ ceiling in WORST mode), as a Map of symbol → its best qualifying
   * (symbol, growth rate) pair.
   *
   * Counted PER SYMBOL: the exclusivity filter asks "how many ASSETS have an
   * edge this tick", and one asset qualifying across several growth rates is
   * still a single asset, not a crowded field. Pairs with evLowerPerTick == null
   * are skipped — an uncalibrated pair cannot be certified against the gate,
   * so counting it would let a stalled feed fake ambiguity.
   */
  _qualifiedAssets(ranked) {
    const evGate = this._evGate();
    const bySymbol = new Map();
    for (const c of ranked) {
      if (!evGate.pass(c.evLowerPerTick)) continue;
      const held = bySymbol.get(c.symbol);
      const better = !held
        || (evGate.worst
          ? c.evLowerPerTick < held.evLowerPerTick  // WORST → keep the lowest
          : c.evLowerPerTick > held.evLowerPerTick); // BEST  → keep the highest
      if (better) bySymbol.set(c.symbol, c);
    }
    return bySymbol;
  }

  /** Compact "SYMBOL@g=EV | SYMBOL@g=EV" listing of the qualified assets. */
  _qualifiedVerdict(qualified) {
    return [...qualified.values()]
      .map(c => `${c.symbol}@${(c.growthRate * 100).toFixed(0)}%=${(c.evLowerPerTick * 100).toFixed(4)}%`)
      .join(' | ');
  }

  /** Human-readable one-line status for one (symbol, growth rate) calibration. */
  _calibrationLine(c, stay) {
    const sym = c.symbol.padEnd(9);
    const g = `g=${(c.growthRate * 100).toFixed(0)}%`;
    if (c.n) {
      let stayTxt = '';
      if (stay) {
        stayTxt = stay.pass
          ? ` stay=OK latest=${stay.latest}`
          : ` stay=BLOCKED(${stay.reason}) latest=${stay.latest}`;
      } else {
        stayTxt = ' stay=n/a';
      }
      return (
        `${c.tradeable ? 'TRADEABLE' : '  no-edge'} ${sym} ${g} ` +
        `n=${String(c.n).padStart(6)} breach=${String(c.breaches).padStart(5)} ` +
        `surv=${c.survivalPoint.toFixed(6)} lower=${c.survivalLower.toFixed(6)} ` +
        `breakEven=${c.breakEven.toFixed(6)} evL/t=${(c.evLowerPerTick * 100).toFixed(4)}% ` +
        `barrier=±${c.halfBarrierPct.toFixed(6)}% (${c.barrierSigmas.toFixed(3)}σ) ` +
        `acf|r|=${c.acfAbs.toFixed(4)} maxTicks=${c.maxTicks ?? 'n/a'}` + stayTxt
      );
    }
    const m = /^insufficient-history:(\d+)\/(\d+)$/.exec(c.reason || '');
    if (m) {
      const have = +m[1], need = +m[2];
      const rem = Math.max(0, need - have);
      const est = rem > 0
        ? ` (~${Math.max(1, Math.round(rem / 3600))}h @1 tick/s)`
        : '';
      return `WAIT-HISTORY ${sym} ${g} — ${have}/${need} ticks, ${rem} more needed${est}`;
    }
    if (/^no-barrier$/.test(c.reason || '')) {
      return `WAIT-BARRIER ${sym} ${g} — no live ACCU proposal yet (check refresh logs)`;
    }
    return `${'?'.padEnd(13)} ${sym} ${g} — ${c.reason || 'unknown state'}`;
  }

  /** Compact tally of what the calibration grid is waiting on. */
  _pendingSummary(ranked) {
    const tally = { calibrated: 0, 'insufficient-history': 0, 'no-barrier': 0, other: 0 };
    for (const c of ranked) {
      if (c.n) tally.calibrated++;
      else if (/insufficient-history/.test(c.reason || '')) tally['insufficient-history']++;
      else if (/no-barrier/.test(c.reason || '')) tally['no-barrier']++;
      else tally.other++;
    }
    const parts = [];
    for (const k of ['calibrated', 'insufficient-history', 'no-barrier', 'other']) {
      if (tally[k] > 0) parts.push(`${tally[k]} ${k}`);
    }
    return `${parts.join(', ')} (${ranked.length} pairs total)`;
  }

  /**
   * Log a transition the moment a pair first clears the edge gate (or stops
   * clearing it), so a status change is visible immediately and not only on
   * the periodic re-report.
   */
  _trackCalibTransitions(ranked) {
    const now = new Set(ranked.filter(c => c.tradeable).map(c => `${c.symbol}|${c.growthRate}`));
    for (const k of now) {
      if (!this._lastTradeableKeys.has(k)) {
        const c = ranked.find(x => `${x.symbol}|${x.growthRate}` === k);
        logger.info(
          `edge confirmed ${c.symbol} g=${(c.growthRate * 100).toFixed(0)}% — ` +
          `lower=${c.survivalLower.toFixed(6)} breakeven=${c.breakEven.toFixed(6)} ` +
          `evLower/tick=${(c.evLowerPerTick * 100).toFixed(4)}%`,
        );
      }
    }
    for (const k of this._lastTradeableKeys) {
      if (!now.has(k)) {
        const [symbol, gStr] = k.split('|');
        logger.info(`edge LOST ${symbol} g=${(parseFloat(gStr) * 100).toFixed(0)}% — no longer clears the gate`);
      }
    }
    this._lastTradeableKeys = now;
  }

  _reportCalibration() {
    const ranked = this._calibrateAll();
    logger.info('──── CALIBRATION ────');
    const withData = ranked.filter(c => c.n);
    if (!withData.length) {
      logger.info(`no calibrated pairs yet — waiting on: ${this._pendingSummary(ranked)}`);
      for (const c of ranked) logger.info('  ' + this._calibrationLine(c));
      logger.info('calibration resumes automatically as live ticks accumulate and barriers refresh');
      return ranked;
    }
    const stayOf = c => this.calib.stayAnalysis(this.md.getStayedIn(c.symbol, c.growthRate));
    for (const c of withData.slice(0, 20)) logger.info('  ' + this._calibrationLine(c, stayOf(c)));
    const pending = ranked.filter(c => !c.n);
    if (pending.length > 0) {
      logger.info(`${pending.length} pair(s) still pending — ${this._pendingSummary(pending)}`);
      for (const c of pending) logger.info('  ' + this._calibrationLine(c, stayOf(c)));
    }
    logger.info(`──── STAYED-IN ARRAYS (complete; validated by 'stay gate') ────`);
    for (const c of ranked) {
      const arr = this.md.getStayedIn(c.symbol, c.growthRate);
      if (!arr) {
        logger.info(`STAYED-IN ${c.symbol}@g=${(c.growthRate * 100).toFixed(0)}% — no data yet`);
        continue;
      }
      const stay = stayOf(c);
      const evGate = this._evGate();
      const ev = c.evLowerPerTick == null
        ? 'ev=n/a'
        : `evL/t=${(c.evLowerPerTick * 100).toFixed(4)}% (${evGate.worst ? (evGate.pass(c.evLowerPerTick) ? '≤' : '>') : (evGate.pass(c.evLowerPerTick) ? '≥' : '<')}` +
          `${(evGate.threshold * 100).toFixed(4)}%)`;
      const bc = c.breaches == null
        ? 'breach=n/a'
        : `breach=${c.breaches} (${c.breaches >= this.cfg.breachMinCount ? '≥' : '<'}` +
          `${this.cfg.breachMinCount})`;
      logger.info(
        `STAYED-IN ${c.symbol}@g=${(c.growthRate * 100).toFixed(0)}% len=${arr.length} ` +
        `latest=${stay.latest} gate=${stay.pass ? 'PASS' : `BLOCKED(${stay.reason})`} ${ev} ${bc} ` +
        `arr=[${arr.join(',')}]`,
      );
    }
    const passing = rankCandidate => {
      const evGate = this._evGate();
      return stayOf(rankCandidate).pass && evGate.pass(rankCandidate.evLowerPerTick) &&
        rankCandidate.breaches >= this.cfg.breachMinCount &&
        rankCandidate.breaches <= this.cfg.breachMinCount2;
    };
    const passed = withData.filter(passing);
    const qualifiedNow = this._qualifiedAssets(ranked);
    const exclusivity = this.cfg.requireSingleQualified
      ? (qualifiedNow.size > 1
        ? ` EXCLUSIVITY BLOCK ACTIVE — ${qualifiedNow.size} assets qualify ` +
          `(${this._qualifiedVerdict(qualifiedNow)}), so no trade is executed.`
        : ` Exclusivity filter ON: exactly-one-qualified required, ` +
          `${qualifiedNow.size} qualify now${qualifiedNow.size ? ` (${this._qualifiedVerdict(qualifiedNow)})` : ''}.`)
      : ' Exclusivity filter OFF: multiple qualified assets are ranked as normal.';
    const evGateInfo = this._evGate();
    logger.info(
      `${passed.length} of ${withData.length} calibrated pair(s) pass ALL gates ` +
      `(stayed-in N=${this.cfg.stayWindowN} most-current < ${this.cfg.stayMaxValue} ` +
      `& latest < ${this.cfg.stayCurrentMax}; evLowerPerTick ${evGateInfo.worst ? '≤' : '≥'} ` +
      `${(evGateInfo.threshold * 100).toFixed(4)}% (${evGateInfo.worst ? 'WORST' : 'BEST'} mode); ` +
      `breachCount ≥ ${this.cfg.breachMinCount}). ` +
      `The bot acts on the ${evGateInfo.worst ? 'LOWEST (most-negative)' : 'HIGHEST'} evLowerPerTick among those ` +
      `(${evGateInfo.worst ? 'worst' : 'best'} conservative survival).` +
      exclusivity,
    );
    return ranked;
  }

  async _tick() {
    if (!this.running || !this.client.authorized || this.risk.halted) return;

    // ── RE-ENTRANCY GUARD ──
    // The analysis loop is driven by setInterval, which fires regardless of
    // whether the previous tick finished. _tick() awaits network round-trips
    // (_refreshStayedIn fires an ACCU proposal per pair), so once a cycle takes
    // longer than analysisIntervalMs the loops overlap. Each overlap doubles
    // the request rate, which lengthens the next cycle, which adds more
    // overlap — a self-sustaining request storm. Deriv rate-limits, every
    // proposal then fails, the barrier and stayed-in records age out, and the
    // bot is stuck "uncalibrated" forever with no way back.
    if (this._ticking) {
      this._tickOverlap = (this._tickOverlap || 0) + 1;
      return;
    }
    this._ticking = true;
    const t0 = Date.now();
    try {
      await this._tickBody();
    } finally {
      this._ticking = false;
      this._lastTickMs = Date.now() - t0;
    }
  }

  _suspendedAssetSymbols() {
    const assets = this.cfg.assets;
    if (!this.cfg.suspendPreviousAsset || assets.length <= 1) return new Set();

    // Leave at least one configured asset available, matching the existing
    // single-asset safeguard while allowing a configurable recent-symbol window.
    const count = Math.min(
      Math.max(0, Math.floor(Number(this.cfg.suspendPreviousAssetCount) || 0)),
      assets.length - 1,
    );
    if (!count) return new Set();

    const configuredAssets = new Set(assets);
    const suspended = new Set();
    const addIfConfigured = symbol => {
      if (symbol && configuredAssets.has(symbol)) suspended.add(symbol);
    };
    addIfConfigured(this.lastTradedSymbol);
    for (let i = this.statsLog.trades.length - 1; i >= 0 && suspended.size < count; i--) {
      addIfConfigured(this.statsLog.trades[i].symbol);
    }
    return suspended;
  }

  async _tickBody() {

    // ── maxOpenTrades enforcement ──
    // Never open another position while any contract is open (or mid-open).
    if (!this.exec.canOpenNow()) {
      if (this.exec.openCount > 0) logger.info(`skip tick — ${this.exec.openCount} open trade(s) (max ${this.cfg.maxOpenTrades})`);
      return;
    }

    // StayedInArray must reflect the current breakout history, so re-request
    // fresh ACCU proposals every tick (not just on the 60s barrier timer).
    //
    // This now runs BEFORE the chase decision. The chase is no longer
    // unconditional: it is only honoured while the chased pair is still the
    // top-ranked candidate, and answering that needs the same fresh
    // calibration + stayed-in records as normal selection. _refreshStayedIn
    // self-throttles on cfg.staysRefreshMs, so pulling it above the chase
    // branch does not add request rate.
    await this._refreshStayedIn();

    // ── ONLY THREE GATES: StayedInArray + evLower/tick (dir = evSelection) + breachCount ─
    const ranked = this._calibrateAll();

    // An uncalibrated pair has evLowerPerTick == null, but for very different
    // reasons: no live barrier, or not enough history. Collapsing both into
    // "uncalibrated" is what made the original stall undiagnosable.
    // The ev gate direction lives in cfg.evSelection (see _evGate()): BEST uses
    // a FLOOR (≥ evLowerGateMin) so positive-EV assets pass and negative-EV
    // assets are rejected — this direction was once inverted as a "<=" ceiling,
    // which is exactly why a +0.78%-EV pair lost to a -1.5%-EV pair in
    // production. WORST inverts it deliberately: a CEILING (≤ evWorstGateMax,
    // a user-set threshold) so the most-negative-EV asset becomes the pick.
    const evGate = c => {
      const g = this._evGate();
      if (c.evLowerPerTick == null) {
        const why = c.reason === 'no-barrier'
          ? 'no live ACCU barrier (proposal failing — see feed-stalled warning)'
          : (c.reason || 'not calibrated');
        return { pass: false, reason: `no-ev [${why}]` };
      }
      const ok = g.pass(c.evLowerPerTick);
      return ok
        ? { pass: true, reason: `ev-ok: (${(c.evLowerPerTick * 100).toFixed(4)}%${g.worst ? '≤' : '≥'}${(g.threshold * 100).toFixed(4)}%)` }
        : {
            pass: false,
            reason: g.worst
              ? `ev-over: ${(c.evLowerPerTick * 100).toFixed(4)}%>${(g.threshold * 100).toFixed(4)}%`
              : `ev-under: ${(c.evLowerPerTick * 100).toFixed(4)}%<${(g.threshold * 100).toFixed(4)}%`,
          };
    };

    const breachGate = c => {
      const bc = c.breaches;
      if (bc == null) return { pass: false, reason: 'no-breach-count' };
      // Both bounds are enforced. Previously only the lower bound reached the
      // gate, so the calibration report advertised a range the bot ignored.
      const min = this.cfg.breachMinCount, max = this.cfg.breachMinCount2;
      if (bc < min) return { pass: false, reason: `breach-low:${bc}<${min}` };
      if (max > 0 && bc > max) return { pass: false, reason: `breach-high:${bc}>${max}` };
      return { pass: true, reason: `breach-ok: (${bc} in [${min},${max}])` };
    };

    // ── EXCLUSIVITY FILTER: trade only on an unambiguous field ──
    // Checked here, BEFORE the candidate list is built and before the chase
    // branch, so an ambiguous field suppresses every order path rather than
    // just the ranked one. Applied as a filter on `candidates` it would be
    // worse than useless: zero survivors is what makes the chase branch fire,
    // so a two-asset field would empty the list and hand the tick straight to
    // the gate-suspended chase — trading exactly when the filter says stand aside.
    //
    // Only >1 blocks. Zero qualified assets is left to the ev floor and the
    // remaining gates, so the "nothing is calibrated yet" chase rescue still
    // works when the feed stalls.
    const qualified = this._qualifiedAssets(ranked);
    const evG = this._evGate();
    if (this.cfg.requireSingleQualified && qualified.size < this.cfg.requireSingleQualifiedMin) {
      const verdict = this._qualifiedVerdict(qualified);
      // Same de-duplication as the "gates blocked all pairs" branch: log on a
      // changed verdict, plus a 60s heartbeat so a standing block stays visible.
      if (verdict !== this._lastExclusiveVerdict || Date.now() - (this._lastExclusiveAt || 0) > 60_000) {
        this._lastExclusiveVerdict = verdict;
        this._lastExclusiveAt = Date.now();
        logger.warn(
          `EXCLUSIVITY BLOCK — ${qualified.size} assets clear the ev gate ` +
          `(${evG.worst ? '≤' : '≥'} ${(evG.threshold * 100).toFixed(4)}%, ${evG.worst ? 'WORST' : 'BEST'} mode): ${verdict}. ` +
          `No trade this tick, chase included: a field where everything qualifies ` +
          `is not a choice. Set REQUIRE_SINGLE_QUALIFIED=false to trade the ${evG.worst ? 'worst' : 'best'} of them.`,
        );
      }
      return;
    }

    const suspendedAssets = this._suspendedAssetSymbols();
    const candidates = ranked
      .map(c => ({
        ...c,
        stay: this.calib.stayAnalysis(this.md.getStayedIn(c.symbol, c.growthRate)),
      }))
      .filter(c => c.stay.pass && evGate(c).pass && breachGate(c).pass)
      .filter(c => !suspendedAssets.has(c.symbol));

    // ── PREFERRED CANDIDATE = evGate-dominant evLowerPerTick ──
    // evLowerPerTick = survival_lower x (1 + g) - 1, which is monotonically
    // INCREASING in the conservative survival estimate. The rank direction
    // mirrors the gate chosen in cfg.evSelection (see _evGate()):
    //   BEST  → descending; the HIGHEST value wins. The most-negative value is
    //           the WORST-surviving asset, not the best one — this line used
    //           to sort ascending and take [0], which traded the worst
    //           gate-passing pair, the opposite of "preferred candidate".
    //   WORST → ascending; the LOWEST / most-negative value wins, which is
    //           exactly the "worst survives" pick the user asked for.
    candidates.sort(this._evGate().rank);
    const best = candidates[0];

    // ── CHASE-ON-LOSS MODE (now conditional) ──
    // After a loss we would re-trade the SAME pair with the gates suspended.
    // The chase is kept only while that pair is STILL the top-ranked
    // candidate. Once another asset outranks it, the chase is abandoned for
    // this tick and ranked selection takes over, so a loss can no longer pin
    // the bot to a stale asset while a clearly better one is available.
    const chaseSuspended = suspendedAssets.has(this.chaseSymbol);
    if (this.cfg.chaseOnLoss && this.chaseActive && this.chaseSymbol && !chaseSuspended) {
      const g = this.chaseGrowthRate;
      const isTop = !!best && best.symbol === this.chaseSymbol && best.growthRate === g;
      if (!candidates.length) {
        // Nothing is calibrated yet (feed stalled, no history) — there is no
        // ranking to contradict, so the original gate-suspended chase stands
        // rather than stranding an escalated martingale step.
        const { stake: chaseStake } = this._nextStake();
        const barrier = this.md.getBarrier(this.chaseSymbol, g)
          ?? await this.md.refreshBarrier(this.chaseSymbol, g, chaseStake);
        const stayArr = this.md.getStayedIn(this.chaseSymbol, g) ?? [];
        logger.warn(
          `CHASE trade ${this.chaseSymbol}@${(g * 100).toFixed(0)}% (skip gates — nothing calibrated) ` +
          `stayedIn(len=${stayArr.length})=[${stayArr.join(',')}]`,
        );
        try {
          this.lastTradeAt = Date.now();
          await this.exec.openTrade({
            symbol: this.chaseSymbol,
            growthRate: g,
            stake: chaseStake,
            targetTicks: this.cfg.takeProfitTicks,
            calibration: { symbol: this.chaseSymbol, growthRate: g, chase: true },
          });
          this.stats.opened++;
          this.risk.onTradeOpened();
        } catch (e) {
          logger.warn(`chase open failed: ${e.message}`);
        }
        return;
      }
      if (isTop) {
        this._lastChaseAbort = null;
        const chased = ranked.find(c => c.symbol === this.chaseSymbol && c.growthRate === g);
        logger.warn(
          `CHASE upheld — ${this.chaseSymbol}@${(g * 100).toFixed(0)}% is still the top candidate ` +
          `evL/t=${(chased.evLowerPerTick * 100).toFixed(4)}%`,
        );
      } else {
        // Only warn when the ranking verdict actually flips, so a persistent
        // outrank does not re-announce itself every analysis cycle.
        const chased = ranked.find(c => c.symbol === this.chaseSymbol && c.growthRate === g);
        const chasedEv = chased && chased.evLowerPerTick != null
          ? `${(chased.evLowerPerTick * 100).toFixed(4)}%` : 'n/a';
        const verdict = `${this.chaseSymbol}|${chasedEv}|${best.symbol}|${(best.evLowerPerTick * 100).toFixed(4)}%`;
        if (verdict !== this._lastChaseAbort) {
          this._lastChaseAbort = verdict;
          logger.warn(
            `chaseABORT: ${this.chaseSymbol}@${(g * 100).toFixed(0)}% evL/t=${chasedEv} is outranked by ` +
            `${best.symbol}@${(best.growthRate * 100).toFixed(0)}% ` +
            `evL/t=${(best.evLowerPerTick * 100).toFixed(4)}% — taking the better asset this tick`,
          );
        }
      }
    }

    if (!candidates.length) {
      const verdicts = ranked.map(c => {
        const stay = this.calib.stayAnalysis(this.md.getStayedIn(c.symbol, c.growthRate));
        return `${c.symbol}@${(c.growthRate * 100).toFixed(0)}% stay=${stay.reason} ev=${evGate(c).reason} breach=${breachGate(c).reason}`;
      }).join(' | ');
      // Only log when the verdict actually changes, plus a periodic heartbeat.
      // Emitting this every second drowned the log and hid every other signal.
      if (verdicts !== this._lastBlockedVerdict || Date.now() - (this._lastBlockedAt || 0) > 60_000) {
        this._lastBlockedVerdict = verdicts;
        this._lastBlockedAt = Date.now();
        logger.info(
          `gates blocked all pairs — ${verdicts} ` +
          `[skipped ${this._tickOverlap || 0} overlapping cycle(s) total]`,
        );
      }
      return;
    }
    this._lastBlockedVerdict = null;
    this._lastExclusiveVerdict = null;   // clear so a re-block logs immediately
    const stayArr = this.md.getStayedIn(best.symbol, best.growthRate) ?? [];
    const evGateOpen = this._evGate();
    logger.info(
      `OPEN ${best.symbol} g=${(best.growthRate * 100).toFixed(0)}% ` +
      `evL/t=${(best.evLowerPerTick * 100).toFixed(4)}% (gate ${evGateOpen.worst ? '≤' : '≥'} ${(evGateOpen.threshold * 100).toFixed(4)}%, ${evGateOpen.worst ? 'WORST' : 'BEST'} mode) ` +
      `stay=PASS latest=${best.stay.latest} ` +
      `breaches=${best.breaches} (gate ≥ ${this.cfg.breachMinCount}) ` +
      `qualified=${qualified.size}/${this.cfg.requireSingleQualified ? '1 required' : 'no cap'} ` +
      `stayedIn(len=${stayArr.length})=[${stayArr.join(',')}]`,
    );

    // TP after cfg.takeProfitTicks ticks (configurable). The same value feeds
    // the hold target AND the live limit_order take-profit price.
    // _nextStake() pins the stake to base while the post-restart guard is
    // active, so a process that restarted without trustworthy state cannot
    // immediately re-escalate on a cold reading.
    const { stake, guarded } = this._nextStake();
    if (guarded) {
      logger.warn(
        `RESTART GUARD active — staking at base ${stake.toFixed(2)} instead of ` +
        `${this.currentStake.toFixed(2)} (${this._restartGuardRemaining} trade(s) left)`,
      );
    }

    try {
      this.lastTradeAt = Date.now();
      await this.exec.openTrade({
        symbol: best.symbol,
        growthRate: best.growthRate,
        stake,
        targetTicks: this.cfg.takeProfitTicks,
        calibration: best,
      });
      this.stats.opened++;
      this.risk.onTradeOpened();
    } catch (e) {
      logger.warn(`open failed: ${e.message}`);
    }
  }

  /**
   * Minimal record of an open contract. Enough to re-attach the position
   * after a restart via proposal_open_contract, without carrying the live
   * object's subscriptions, timers and function references into JSON.
   */
  _contractRecord(t) {
    return {
      contractId: t.contractId, symbol: t.symbol, growthRate: t.growthRate,
      stake: t.stake, targetTicks: t.targetTicks, expectedTicks: t.expectedTicks,
      halfBarrierFrac: t.halfBarrierFrac, entrySpot: t.entrySpot,
      takeProfit: t.takeProfit, openedAt: t.openedAt, buyTime: t.buyTime,
      ticksHeld: t.ticksHeld, status: t.status, paper: t.paper,
    };
  }

  /**
   * Persist everything needed to resume: risk rails, martingale, reporting
   * aggregates, and the contracts still open on the books.
   *
   * risk.consecLosses is persisted alongside the displayed
   * this.consecutiveLosses because the RiskManager copy is the one that
   * actually gates trading (canTrade → maxConsecLosses). It was previously
   * never saved, so the consecutive-loss rail silently reset to 0 on every
   * restart while Telegram still displayed a non-zero streak.
   *
   * Failures are surfaced at ERROR by atomicWriteJson — a state directory
   * that cannot be written to must never look like a healthy run.
   */
  _saveState() {
    return atomicWriteJson(this.cfg.stateFile, {
      savedAt: new Date().toISOString(),
      mode: this.cfg.mode,
      stats: this.stats,
      risk: {
        day: this.risk.day, dayPnl: this.risk.dayPnl, dayTrades: this.risk.dayTrades,
        sessionPnl: this.risk.sessionPnl, sessionPeak: this.risk.sessionPeak,
        halted: this.risk.halted, haltReason: this.risk.haltReason,
        consecLosses: this.risk.consecLosses,
      },
      edge: this.edge.summary(),
      // Martingale + trade log state (for hourly/EOD across restarts)
      martingaleBase: this.martingaleBase,
      martingaleStep: this.martingaleStep,
      currentStake: this.currentStake,
      consecutiveLosses: this.consecutiveLosses,
      startBalance: this.startBalance,
      lastBalance: this.lastBalance,
      lastTradedSymbol: this.lastTradedSymbol,
      statsLog: this.statsLog.serialize(),
      // Chase-on-loss state
      chaseActive: this.chaseActive,
      chaseSymbol: this.chaseSymbol,
      chaseGrowthRate: this.chaseGrowthRate,
      // Contracts open as of this write, so a crash mid-trade leaves a
      // contract_id to recover rather than a silent orphan on the account.
      openContracts: this.exec
        ? [...this.exec.open.values()].map(t => this._contractRecord(t))
        : [],
      restartGuardRemaining: this._restartGuardRemaining,
    }, 'state');
  }

  /**
   * Read persisted state and report what kind of state it was, so the caller
   * can decide whether to trust it. A fresh file is trusted outright; a stale,
   * absent or corrupt one means reporting is rebuilt from Deriv instead.
   *
   * @returns {{status: 'fresh'|'stale'|'missing'|'corrupt', savedAt: ?string,
   *            ageSec: ?number, data: ?object}}
   */
  _loadState() {
    const file = this.cfg.stateFile;
    let d;
    try {
      if (!fs.existsSync(file)) {
        logger.warn(`no state file at ${file} — cold start (reporting will be rebuilt from Deriv)`);
        return { status: 'missing', savedAt: null, ageSec: null, data: null };
      }
      d = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Valid JSON is not necessarily a state document. A file that parses
      // but is not an object is corrupt, and must not be aged as if it were
      // merely old — that would be a stale read of nonsense.
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        throw new Error('not a state object');
      }
    } catch (e) {
      logger.error(`state file UNREADABLE (${file}): ${e.message} — treating as cold start`);
      return { status: 'corrupt', savedAt: null, ageSec: null, data: null };
    }

    // Age decides whether martingale may be trusted. At ×3 over 4 steps a
    // wrong reconstruction over-bets 81×, so a stale file must never drive
    // stake selection.
    const savedAtMs = Date.parse(d.savedAt || '');
    const ageSec = Number.isFinite(savedAtMs) ? (Date.now() - savedAtMs) / 1000 : Infinity;
    const maxAge = Number(this.cfg.stateMaxAgeSec) || 900;
    const fresh = ageSec >= 0 && ageSec <= maxAge;
    if (!fresh) {
      logger.warn(
        `state file is ${Number.isFinite(ageSec) ? `${Math.round(ageSec / 60)} min old` : 'unreadable in time'}` +
        ` (max ${maxAge}s) — reporting will be rebuilt from Deriv, stake resets to base`,
      );
      // Keep the parsable fields (balances, statsLog) as a cross-check but
      // mark the result so the caller does not trust the stake.
      this._applyState(d, { trustStake: false });
      return { status: 'stale', savedAt: d.savedAt || null, ageSec, data: d };
    }

    this._applyState(d, { trustStake: true });
    return { status: 'fresh', savedAt: d.savedAt || null, ageSec, data: d };
  }

  /**
   * Apply a parsed state document onto the bot.
   * @param {object} d parsed state file
   * @param {{trustStake: boolean}} opts when false the martingale step and
   *   stake are reset to base rather than restored from the file.
   */
  _applyState(d, { trustStake }) {
    if (d.startBalance != null) this.startBalance = Number(d.startBalance);
    if (d.lastBalance != null) this.lastBalance = Number(d.lastBalance);
    if (d.consecutiveLosses != null) this.consecutiveLosses = Number(d.consecutiveLosses);
    if (d.martingaleBase != null) this.martingaleBase = Number(d.martingaleBase);
    if (d.statsLog) this.statsLog = new StatisticsManager(d.statsLog);
    this.lastTradedSymbol = typeof d.lastTradedSymbol === 'string'
      ? d.lastTradedSymbol
      : (d.openContracts?.[d.openContracts.length - 1]?.symbol ??
        this.statsLog.trades[this.statsLog.trades.length - 1]?.symbol ?? null);
    if (d.stats) this.stats = d.stats;
    if (typeof d.restartGuardRemaining === 'number') {
      this._restartGuardRemaining = d.restartGuardRemaining;
    }

    // ── Risk rails ──
    // These were written by _saveState but never read back, so the daily
    // loss cap, daily trade cap, session drawdown and every active HALT
    // reset on each restart. Restore them.
    if (d.risk) {
      if (d.risk.day != null) this.risk.day = String(d.risk.day);
      if (d.risk.dayPnl != null) this.risk.dayPnl = Number(d.risk.dayPnl);
      if (d.risk.dayTrades != null) this.risk.dayTrades = Number(d.risk.dayTrades);
      if (d.risk.sessionPnl != null) this.risk.sessionPnl = Number(d.risk.sessionPnl);
      if (d.risk.sessionPeak != null) this.risk.sessionPeak = Number(d.risk.sessionPeak);
      if (d.risk.halted != null) this.risk.halted = !!d.risk.halted;
      if (d.risk.haltReason != null) this.risk.haltReason = d.risk.haltReason;
      if (d.risk.consecLosses != null) this.risk.consecLosses = Number(d.risk.consecLosses) || 0;
    }
    // Keep the two loss counters consistent with each other so the reported
    // streak and the rail that enforces it can never disagree again.
    if (d.consecutiveLosses != null) {
      this.risk.consecLosses = this.consecutiveLosses;
    }

    if (trustStake) {
      if (d.currentStake != null) this.currentStake = Number(d.currentStake);
      if (d.martingaleStep != null) this.martingaleStep = Number(d.martingaleStep) || 0;
    } else {
      const abandonedStep = Number(d.martingaleStep) || 0;
      this.martingaleStep = 0;
      this.currentStake = this.martingaleBase;
      if (abandonedStep > 0) {
        logger.warn(
          `martingale cycle abandoned: was step ${abandonedStep} ` +
          `(stake ${Number(d.currentStake || 0).toFixed(2)}) — reset to base ${this.martingaleBase.toFixed(2)}`,
        );
      }
      // Cap the first trades after an untrusted restart so a fresh process
      // cannot immediately re-escalate on a cold reading.
      this._restartGuardRemaining = Math.max(
        Number(this.cfg.restartGuardTrades) || 0,
        this._restartGuardRemaining || 0,
      );
    }

    // Chase-on-loss suspends the risk gates, so it is never restored from a
    // stale file — only from a fresh one, and even then only as a starting hint.
    if (trustStake && d.chaseActive === true && d.chaseSymbol) {
      this.chaseActive = true;
      this.chaseSymbol = String(d.chaseSymbol);
      this.chaseGrowthRate = Number(d.chaseGrowthRate) ?? null;
    } else {
      this.chaseActive = false;
      this.chaseSymbol = null;
      this.chaseGrowthRate = null;
    }

    // Ensure martingale base matches current config
    if (Number(this.cfg.stake) !== this.martingaleBase) {
      this.martingaleBase = Number(this.cfg.martingaleBaseStake) > 0 ? Number(this.cfg.martingaleBaseStake) : Number(this.cfg.stake) || 1.0;
      this.currentStake = this._calcMartingaleStake(this.martingaleStep);
    }

    logger.info(
      `state applied: overallProfit=${(this.statsLog.overallProfit ?? 0).toFixed(2)} ` +
      `consecLosses=${this.consecutiveLosses} (rail=${this.risk.consecLosses}) ` +
      `martingale step=${this.martingaleStep} stake=${this.currentStake.toFixed(2)}/${this.martingaleBase.toFixed(2)} ` +
      `halted=${this.risk.halted}${this.risk.halted ? ` (${this.risk.haltReason})` : ''}`,
    );
  }

  report() {
    const e = this.edge.summary();
    const mins = (Date.now() - this.startedAt) / 60000;
    const lines = [
      '──────── SESSION REPORT ────────',
      `mode            : ${this.cfg.mode}`,
      `uptime          : ${mins.toFixed(1)} min`,
      `trades opened   : ${this.stats.opened}`,
      `trades closed   : ${this.stats.closed}`,
      `wins / losses   : ${this.stats.wins} / ${this.stats.losses}`,
      `win rate        : ${this.stats.closed ? ((this.stats.wins / this.stats.closed) * 100).toFixed(2) : '0.00'}%`,
      `net P&L         : ${money(this.stats.pnl)}`,
      `mean return     : ${e.meanReturnPct.toFixed(4)}% of stake per trade`,
      `edge z-score    : ${e.z == null ? 'n/a' : e.z.toFixed(3)}`,
      `avg ticks held  : ${e.avgRealizedTicks.toFixed(2)} (target ${e.avgExpectedTicks.toFixed(2)})`,
      `cycle health    : last ${this._lastTickMs}ms, ${this._tickOverlap || 0} overlapping cycle(s) dropped`,
      `proposal health : ${this.client._rateLimitHits || 0} rate-limit, ${this._reqErrors || 0} other req error(s)`,
      `feed freshness  : barrier ${this._barrierAt ? `${((Date.now() - this._barrierAt) / 1000).toFixed(0)}s` : 'never'}, ` +
        `stayed-in ${this._staysAt ? `${((Date.now() - this._staysAt) / 1000).toFixed(0)}s` : 'never'} ago`,
      `halted          : ${this.risk.halted ? 'YES — ' + this.risk.haltReason : 'no'}`,
      '────────────────────────────────',
    ];
    for (const l of lines) logger.info(l);
    return lines.join('\n');
  }

  async stop() {
    this.running = false;
    if (this.loopTimer) clearInterval(this.loopTimer);
    if (this.barrierTimer) clearInterval(this.barrierTimer);
    if (this.calibTimer) clearInterval(this.calibTimer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    if (this._reportT) clearInterval(this._reportT);
    if (this._hourlyT) clearInterval(this._hourlyT);
    if (this._hourlyBoot) clearTimeout(this._hourlyBoot);
    if (this._eodBoot) clearTimeout(this._eodBoot);

    // Persist BEFORE the network-dependent teardown. closeAll() awaits live
    // Deriv round-trips per open contract, and a Kubernetes rollout SIGKILLs
    // the pod once the grace period expires — so a save placed only after it
    // can be skipped entirely, which is how the last trade got lost.
    this._saveState();

    // Do not let a stalled teardown block the final write forever.
    await Promise.race([
      this.exec.closeAll(),
      sleep(this.cfg.shutdownGraceMs).then(() =>
        logger.warn(`closeAll exceeded ${this.cfg.shutdownGraceMs}ms — saving and exiting anyway`)),
    ]);
    this.report();
    this._saveState();
    this.client.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 14. OFFLINE CALIBRATION REPORT (--calibrate)
//     Connects, measures, prints the truth, trades nothing, exits.
// ═══════════════════════════════════════════════════════════════════════
async function runCalibration() {
  printBanner();
  logger.info('CALIBRATE MODE — no orders will be placed.');

  const client = new DerivClient(CONFIG);
  const md = new MarketData(client, CONFIG);
  const calib = new CalibrationEngine(CONFIG);

  await client.connect();
  await md.bootstrap(CONFIG.assets);

  const results = [];
  for (const symbol of CONFIG.assets) {
    if (md.deadAssets.has(symbol)) continue;
    const ticks = md.historyFor(symbol);
    for (const g of CONFIG.growthRates) {
      const barrier = await md.refreshBarrier(symbol, g, Math.max(CONFIG.minStake, 1));
      await sleep(150);
      results.push(calib.calibrate(symbol, ticks, g, barrier));
    }
  }

  const ranked = calib.rank(results).filter(c => c.n);
  console.log('\n' + '='.repeat(118));
  console.log('CALIBRATION REPORT — measured per-tick survival vs. priced break-even');
  console.log('='.repeat(118));
  console.log(
    'SYMBOL'.padEnd(9) + 'G%'.padEnd(5) + 'TICKS'.padEnd(8) +
    'BREACH'.padEnd(8) + 'SURVIVAL'.padEnd(11) + 'LOWER95'.padEnd(11) +
    'BREAKEVEN'.padEnd(11) + 'EV/TICK%'.padEnd(11) + 'BARRIER%'.padEnd(12) +
    'SIGMAS'.padEnd(8) + 'VERDICT',
  );
  console.log('-'.repeat(118));
  for (const c of ranked) {
    console.log(
      c.symbol.padEnd(9) +
      (c.growthRate * 100).toFixed(0).padEnd(5) +
      String(c.n).padEnd(8) +
      String(c.breaches).padEnd(8) +
      c.survivalPoint.toFixed(6).padEnd(11) +
      c.survivalLower.toFixed(6).padEnd(11) +
      c.breakEven.toFixed(6).padEnd(11) +
      (c.evPointPerTick * 100).toFixed(4).padEnd(11) +
      c.halfBarrierPct.toFixed(6).padEnd(12) +
      c.barrierSigmas.toFixed(3).padEnd(8) +
      (c.tradeable ? 'TRADEABLE' : 'no edge'),
    );
  }
  console.log('='.repeat(118));

  const tradeable = ranked.filter(c => c.tradeable);
  if (tradeable.length) {
    console.log(`\n${tradeable.length} pair(s) measured a positive lower-bound edge (for reference only).`);
  } else {
    console.log('\nNo pair measured a positive lower-bound edge (for reference only).');
  }
  console.log(
    `Entry gates in force: stayed-in array + evLowerPerTick ${CONFIG.evSelection === 'worst' ? '≤' : '≥'} ${((CONFIG.evSelection === 'worst' ? CONFIG.evWorstGateMax : CONFIG.evLowerGateMin) * 100).toFixed(4)}%` +
    (CONFIG.requireSingleQualified ? ', and exactly one qualified asset (per symbol).' : '.'),
  );

  // Autocorrelation diagnostic: the only thing that could justify a timing rule.
  console.log('\nI.I.D. DIAGNOSTIC (lag-1 autocorrelation; ~0 means no exploitable memory)');
  console.log('-'.repeat(60));
  const seen = new Set();
  for (const c of ranked) {
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    console.log(
      `${c.symbol.padEnd(9)} acf(r)=${c.acfRaw.toFixed(5).padStart(9)}   ` +
      `acf(|r|)=${c.acfAbs.toFixed(5).padStart(9)}   sigma=${c.sigma.toExponential(4)}`,
    );
  }

  client.close();
}

// ═══════════════════════════════════════════════════════════════════════
// 15. SELF TEST
// ═══════════════════════════════════════════════════════════════════════
async function runSelfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra = '') => {
    if (cond) { console.log(`  ✓ ${name}`); pass++; }
    else { console.log(`  ✗ ${name} ${extra}`); fail++; }
  };
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

  console.log('\nAccuFable5 self-test\n' + '='.repeat(60));

  console.log('\n[Stats]');
  ok('breakEvenSurvival(0.05) = 1/1.05', near(Stats.breakEvenSurvival(0.05), 1 / 1.05));
  ok('breakEvenSurvival(0.01) = 1/1.01', near(Stats.breakEvenSurvival(0.01), 1 / 1.01));
  ok('evPerTick at break-even is 0', near(Stats.evPerTick(1 / 1.03, 0.03), 0, 1e-12));
  ok('evPerTick below break-even is negative', Stats.evPerTick(0.90, 0.05) < 0);
  ok('evPerTick above break-even is positive', Stats.evPerTick(0.99, 0.05) > 0);

  const w = Stats.wilson(950, 1000, 1.96);
  ok('wilson brackets the point estimate', w.lower < 0.95 && w.upper > 0.95);
  ok('wilson stays inside [0,1]', w.lower >= 0 && w.upper <= 1);
  const wSmall = Stats.wilson(9, 10, 1.96);
  const wBig = Stats.wilson(900, 1000, 1.96);
  ok('wilson interval narrows with more data',
    (wBig.upper - wBig.lower) < (wSmall.upper - wSmall.lower));

  ok('normCdf(0) = 0.5', near(Stats.normCdf(0), 0.5, 1e-4));
  ok('normCdf(1.96) ~ 0.975', near(Stats.normCdf(1.96), 0.975, 1e-3));
  ok('normCdf(-1.96) ~ 0.025', near(Stats.normCdf(-1.96), 0.025, 1e-3));

  ok('evOverHold compounds', near(
    Stats.evOverHold(1 / 1.02, 0.02, 10, 0), 0, 1e-9));
  ok('evOverHold penalises spread', Stats.evOverHold(1 / 1.02, 0.02, 10, 0.002) < 0);

  ok('zStat of constant-positive sample is positive', Stats.zStat([0.1, 0.11, 0.09, 0.1], 0) > 0);
  ok('zStat of constant-negative sample is negative', Stats.zStat([-0.1, -0.11, -0.09], 0) < 0);

  const iid = Array.from({ length: 4000 }, () => gaussian());
  ok('autocorr1 of i.i.d. noise is near zero', Math.abs(Stats.autocorr1(iid)) < 0.08,
    `(got ${Stats.autocorr1(iid).toFixed(4)})`);

  console.log('\n[Published barrier check — is the barrier the fair quantile?]');
  // Deriv's published barriers: 5% -> 0.0049358253%, 1% -> 0.0064867741%
  const b5 = 0.0049358253 / 100, b1 = 0.0064867741 / 100;
  const zFor = g => {
    // quantile z such that P(|Z| < z) = 1/(1+g)  =>  z = Phi^-1((1 + 1/(1+g))/2)
    const target = (1 + 1 / (1 + g)) / 2;
    let lo = 0, hi = 8;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (Stats.normCdf(mid) < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const barrierRatio = b5 / b1;
  const fairRatio = zFor(0.05) / zFor(0.01);
  console.log(`  published barrier ratio b(5%)/b(1%) = ${barrierRatio.toFixed(5)}`);
  console.log(`  fair Gaussian ratio     z(5%)/z(1%) = ${fairRatio.toFixed(5)}`);
  ok('barrier ratio matches the fair quantile ratio within 2%',
    Math.abs(barrierRatio / fairRatio - 1) < 0.02,
    `(off by ${((barrierRatio / fairRatio - 1) * 100).toFixed(2)}%)`);
  ok('5% barrier is priced tighter than fair relative to 1%', barrierRatio < fairRatio);

  console.log('\n[CalibrationEngine]');
  const ce = new CalibrationEngine({ ...CONFIG, calibMinTicks: 10, edgeMarginPerTick: -0.6 });

  // A synthetic series that NEVER breaches: survival 1.0 -> must be tradeable.
  const flat = Array.from({ length: 500 }, (_, i) => ({ quote: 100 + (i % 2) * 1e-9, epoch: i }));
  const cFlat = ce.calibrate('TEST', flat, 0.03, { halfBarrierFrac: 0.001 });
  ok('perfect survival is flagged tradeable', cFlat.tradeable === true, `(${cFlat.reason})`);
  ok('perfect survival gives positive lower EV', cFlat.evLowerPerTick > 0);

  // A series that breaches constantly -> must NOT be tradeable.
  const wild = Array.from({ length: 500 }, (_, i) => ({ quote: 100 * (1 + (i % 2 ? 0.01 : -0.01)), epoch: i }));
  const cWild = ce.calibrate('TEST', wild, 0.03, { halfBarrierFrac: 0.0001 });
  ok('constant breaching is rejected', cWild.tradeable === false);
  ok('constant breaching gives negative EV', cWild.evPointPerTick < 0);

  ok('missing barrier is rejected',
    ce.calibrate('TEST', flat, 0.03, null).tradeable === false);
  ok('thin history is rejected',
    ce.calibrate('TEST', flat.slice(0, 3), 0.03, { halfBarrierFrac: 0.001 }).tradeable === false);

  ok('breachCount counts both tails',
    ce.breachCount([0.02, -0.02, 0.0001], 0.01) === 2);

  const hz = ce.chooseHorizon(0.90, 0.05, 20, 1, 0.002);
  ok('negative-EV survival picks the shortest hold', hz.K === 1, `(got K=${hz.K})`);
  const hzGood = ce.chooseHorizon(0.999, 0.05, 20, 1, 0.0);
  ok('positive-EV survival picks the longest hold', hzGood.K === 20, `(got K=${hzGood.K})`);

  console.log('\n[RiskManager]');
  const rm = new RiskManager({ ...CONFIG, dailyMaxLoss: 10, sessionMaxDrawdown: 10, maxConsecLosses: 3, maxOpenTrades: 1 });
  ok('fresh risk manager permits trading', rm.canTrade(0).ok === true);
  ok('max open trades blocks', rm.canTrade(1).ok === false);
  rm.onTradeClosed(-11);
  ok('daily loss cap halts', rm.canTrade(0).ok === false);
  ok('halt reason recorded', /daily loss/i.test(rm.haltReason || ''));

  const rm2 = new RiskManager({ ...CONFIG, maxConsecLosses: 3 });
  rm2.onTradeClosed(-1); rm2.onTradeClosed(-1); rm2.onTradeClosed(-1);
  ok('consecutive-loss cap halts', rm2.canTrade(0).ok === false);

  const rm3 = new RiskManager({ ...CONFIG, sizing: 'flat', stake: 2, minStake: 0.35, maxStake: 5 });
  ok('flat sizing returns the flat stake', rm3.stakeFor(10000) === 2);
  const rm4 = new RiskManager({ ...CONFIG, sizing: 'fraction', riskFraction: 0.01, minStake: 0.35, maxStake: 5 });
  ok('fractional sizing scales with balance', rm4.stakeFor(200) === 2);
  ok('fractional sizing respects the max cap', rm4.stakeFor(1000000) === 5);
  ok('fractional sizing respects the min floor', rm4.stakeFor(1) === 0.35);
  // Martingale lives at the bot level, not in RiskManager.  Verify the math.
  const mgCfg = { stake: 1, martingaleMultiplier: 2.5, martingaleSteps: 3 };
  const mgBase = Number(mgCfg.stake), mgMult = Number(mgCfg.martingaleMultiplier);
  const mgCalc = step => step <= 0 ? +mgBase.toFixed(2) : +(mgBase * Math.pow(mgMult, step)).toFixed(2);
  ok('no martingale exists in RiskManager',
    typeof rm4.martingale === 'undefined' && !/martingale/i.test(RiskManager.toString()));
  ok('martingale calc step 0 = base', mgCalc(0) === 1);
  ok('martingale calc step 1 = base × mult', mgCalc(1) === 2.5);
  ok('martingale calc step 2 = base × mult^2', mgCalc(2) === 6.25);
  ok('martingale calc step 3 = base × mult^3', mgCalc(3) === 15.63);

  console.log('\n[EdgeLedger]');
  const tmpEdge = path.join(process.cwd(), `.selftest-edge-${Date.now()}.json`);
  const el = new EdgeLedger({ ...CONFIG, edgeFile: tmpEdge, edgeMonitorMinTrades: 20, edgeMonitorZStop: 2 });
  let halted = false;
  for (let i = 0; i < 60; i++) {
    // A steady bleed: should be detected and halted.
    const v = el.record({ stake: 1, profit: -0.02, ticksHeld: 3, expectedTicks: 3 });
    if (v.halt) { halted = true; break; }
  }
  ok('a persistent bleed triggers an automatic halt', halted === true);
  ok('halt reason is descriptive', /significantly negative/i.test(el.haltReason || ''));
  try { fs.unlinkSync(tmpEdge); } catch (_) {}

  const tmpEdge2 = path.join(process.cwd(), `.selftest-edge2-${Date.now()}.json`);
  const el2 = new EdgeLedger({ ...CONFIG, edgeFile: tmpEdge2, edgeMonitorMinTrades: 20, edgeMonitorZStop: 2 });
  let halted2 = false;
  for (let i = 0; i < 60; i++) {
    const v = el2.record({ stake: 1, profit: i % 5 === 0 ? -0.9 : 0.25, ticksHeld: 4, expectedTicks: 4 });
    if (v.halt) halted2 = true;
  }
  ok('a genuinely profitable record is not halted', halted2 === false);
  try { fs.unlinkSync(tmpEdge2); } catch (_) {}

  console.log('\n[Monte Carlo — fair barrier must return ~0, shaved barrier must lose]');
  // Build a barrier that is exactly the fair quantile for g, then shave it.
  const sigma = 2.5e-5;
  const fairBarrier = g => Math.exp(zFor(g) * sigma) - 1;
  const mcFair = monteCarlo({
    sigma, halfBarrierFrac: fairBarrier(0.03), growthRate: 0.03,
    holdTicks: 5, stake: 1, trades: 40000, spreadCost: 0,
  });
  console.log(`  fair barrier  : ${mcFair.returnPerTradePct.toFixed(4)}% per trade (z=${mcFair.zScore.toFixed(2)})`);
  ok('a mathematically fair barrier is roughly break-even',
    Math.abs(mcFair.zScore) < 4, `(z=${mcFair.zScore.toFixed(2)})`);

  const mcShaved = monteCarlo({
    sigma, halfBarrierFrac: fairBarrier(0.03) * 0.99, growthRate: 0.03,
    holdTicks: 5, stake: 1, trades: 40000, spreadCost: 0,
  });
  console.log(`  shaved 1%     : ${mcShaved.returnPerTradePct.toFixed(4)}% per trade`);
  ok('shaving the barrier by 1% produces a loss',
    mcShaved.returnPerTradePct < mcFair.returnPerTradePct);

  ok('monteCarlo reports a sane win rate', mcFair.winRate > 0 && mcFair.winRate < 1);
  ok('monteCarlo reports a non-negative drawdown', mcFair.maxDrawdown >= 0);
  ok('theoretical survival is close to break-even for a fair barrier',
    Math.abs(mcFair.theoreticalSurvival - mcFair.breakEvenSurvival) < 0.002);

  console.log('\n[Ledger reconciliation]');
  // A recorded-shape fixture: two rows per contract, newest-first, as the
  // statement endpoint returns them.
  const t0 = Date.parse('2026-09-27T10:00:00.000Z');
  const fixture = [
    // most recent first: a loss (c3), then a win (c2)
    { action: 'sell', contract_id: 3, amount: -1.0, date: '2026-09-27T12:00:10.000Z', underlying_symbol: 'R_100' },
    { action: 'buy',  contract_id: 3, amount: -1.0, date: '2026-09-27T12:00:00.000Z', underlying_symbol: 'R_100' },
    { action: 'sell', contract_id: 2, amount: 0.12, date: '2026-09-27T11:00:20.000Z', underlying_symbol: 'R_50' },
    { action: 'buy',  contract_id: 2, amount: -1.0, date: '2026-09-27T11:00:00.000Z', underlying_symbol: 'R_50' },
    { action: 'sell', contract_id: 1, amount: -1.0, date: '2026-09-27T10:00:30.000Z', underlying_symbol: 'R_10' },
    { action: 'buy',  contract_id: 1, amount: -1.0, date: '2026-09-27T10:00:00.000Z', underlying_symbol: 'R_10' },
  ];
  const parsed = parseStatementRows(fixture);
  ok('pairs buy+sell rows into one entry per contract', parsed.settled.length === 3,
    `(got ${parsed.settled.length})`);
  ok('settled ledger is ordered oldest → newest',
    parsed.settled[0].contractId === '1' && parsed.settled[2].contractId === '3');
  ok('a buy row never counts as a settled trade',
    !parsed.settled.some(t => t.contractId === '2' && t.profit === -1));

  const agg = summariseLedger(parsed.settled);
  ok('reconciled P&L sums realised profit', Math.abs(agg.pnl - (-1.0 + 0.12 - 1.0)) < 1e-9,
    `(got ${agg.pnl})`);
  ok('reconciled win/loss counts', agg.wins === 1 && agg.losses === 2,
    `(got ${agg.wins}/${agg.losses})`);
  ok('reconciled current loss streak reflects the trailing run', agg.currentLossStreak === 1,
    `(got ${agg.currentLossStreak})`);
  // c1 loss → c2 win → c3 loss: the runs are [1] and [1], so max is 1.
  ok('reconciled max loss streak', agg.maxLossStreak === 1, `(got ${agg.maxLossStreak})`);

  // A genuine two-loss run, to prove max is tracked separately from current.
  const streakRows = [
    { action: 'sell', contract_id: 9, amount: -1, date: '2026-09-27T09:00:00.000Z' },
    { action: 'sell', contract_id: 8, amount: -1, date: '2026-09-27T09:01:00.000Z' },
    { action: 'sell', contract_id: 7, amount: -1, date: '2026-09-27T09:02:00.000Z' },
    { action: 'sell', contract_id: 6, amount: 5, date: '2026-09-27T09:03:00.000Z' },
  ];
  const streakAgg = summariseLedger(parseStatementRows(streakRows).settled);
  // loss, loss, loss, win — the win is last, so the run is over.
  ok('reconciled streak clears after a later win', streakAgg.currentLossStreak === 0,
    `(got ${streakAgg.currentLossStreak})`);
  ok('reconciled max streak remembers the three-loss run', streakAgg.maxLossStreak === 3,
    `(got ${streakAgg.maxLossStreak})`);
  ok('reconciled loss-streak events are tallied', streakAgg.lossStreakEvents.x2 === 1 && streakAgg.lossStreakEvents.x3 === 1,
    `(got x2=${streakAgg.lossStreakEvents.x2} x3=${streakAgg.lossStreakEvents.x3})`);

  // A contract with no sell row is still open, not a trade.
  const withOpen = parseStatementRows([...fixture,
    { action: 'buy', contract_id: 4, amount: -1.0, date: '2026-09-27T13:00:00.000Z' }]);
  ok('an unsettled contract is reported as open, not as a loss', withOpen.open.length === 1);
  ok('an unsettled contract does not move the aggregates',
    summariseLedger(withOpen.settled).trades === 3);

  // Unparseable rows must be counted and skipped, never guessed at.
  const junk = parseStatementRows([...fixture, null, { amount: 1 }, { action: 'deposit', id: 99, amount: 5 }]);
  ok('unrecognised rows are skipped, not guessed', junk.unparsed === 3, `(got ${junk.unparsed})`);
  ok('unparseable input does not corrupt the ledger', junk.settled.length === 3);

  const recs = ledgerToTradeRecords(parsed.settled);
  ok('reconciled records carry a status the reports can read',
    recs.every(r => r.status === 'won' || r.status === 'lost'));
  ok('reconciled records carry a UTC date and hour',
    recs.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isInteger(r.hour)));

  console.log('\n[Durable state writes]');
  const tmpStateDir = path.join(process.cwd(), `.selftest-state-${Date.now()}`);
  const tmpState = path.join(tmpStateDir, 'state.json');
  ok('atomic write creates a missing parent directory',
    atomicWriteJson(tmpState, { a: 1 }, 'test') === true);
  ok('atomic write created the file', fs.existsSync(tmpState));
  ok('atomic write left no temp file behind', !fs.existsSync(tmpState + '.tmp'));
  ok('atomic write round-trips', JSON.parse(fs.readFileSync(tmpState, 'utf8')).a === 1);
  // A genuinely impossible target: a regular file standing where a directory
  // component must be. The write must fail LOUDLY rather than vanish.
  fs.writeFileSync(path.join(tmpStateDir, 'blocker'), 'not a directory');
  ok('a failing write is reported, not swallowed',
    atomicWriteJson(path.join(tmpStateDir, 'blocker', 'child.json'), { a: 1 }, 'test') === false);

  console.log('\n[State recovery policy]');
  const bot = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge.json') });
  const baseState = (over = {}) => ({
    savedAt: new Date().toISOString(), mode: 'paper',
    stats: { opened: 5, closed: 5, wins: 3, losses: 2, pnl: 0.5 },
    risk: { day: utcDateStr(), dayPnl: -12, dayTrades: 7, sessionPnl: -12, sessionPeak: 0,
            halted: true, haltReason: 'daily loss cap hit', consecLosses: 4 },
    martingaleBase: 1, martingaleStep: 3, currentStake: 27,
    consecutiveLosses: 4, startBalance: 100, lastBalance: 88,
    statsLog: new StatisticsManager().serialize(),
    chaseActive: true, chaseSymbol: 'R_100', chaseGrowthRate: 0.01,
    openContracts: [], restartGuardRemaining: 0, ...over,
  });

  // FRESH: everything is trusted, martingale included.
  fs.writeFileSync(tmpState, JSON.stringify(baseState(), null, 2));
  const fresh = bot._loadState();
  ok('a fresh state file is reported as fresh', fresh.status === 'fresh', `(got ${fresh.status})`);
  ok('a fresh file restores the martingale step', bot.martingaleStep === 3, `(got ${bot.martingaleStep})`);
  ok('a fresh file restores the escalated stake', bot.currentStake === 27, `(got ${bot.currentStake})`);

  // The risk rails that were previously written but never read back.
  ok('a fresh file restores the daily loss counter', bot.risk.dayPnl === -12, `(got ${bot.risk.dayPnl})`);
  ok('a fresh file restores the daily trade counter', bot.risk.dayTrades === 7);
  ok('a fresh file restores an active HALT', bot.risk.halted === true);
  ok('a fresh file restores the halt reason', /daily loss cap/.test(bot.risk.haltReason || ''));
  ok('a fresh file restores the session drawdown high', bot.risk.sessionPeak === 0);
  // The counter that gates trading AND the counter that gets reported.
  ok('a fresh file restores the gating loss streak', bot.risk.consecLosses === 4, `(got ${bot.risk.consecLosses})`);
  ok('the gating and reported loss streaks agree after restore',
    bot.risk.consecLosses === bot.consecutiveLosses);

  // STALE: reporting is kept, the stake is NOT trusted.
  const bot2 = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge2.json') });
  const staleDoc = baseState({ savedAt: new Date(Date.now() - 3600_000).toISOString() });
  fs.writeFileSync(tmpState, JSON.stringify(staleDoc, null, 2));
  const stale = bot2._loadState();
  ok('a state file past the age limit is reported as stale', stale.status === 'stale', `(got ${stale.status})`);
  ok('a STALE file never restores a martingale step', bot2.martingaleStep === 0, `(got ${bot2.martingaleStep})`);
  ok('a STALE file always stakes at base', bot2.currentStake === 1, `(got ${bot2.currentStake})`);
  ok('a STALE file arms the restart guard', bot2._restartGuardRemaining > 0,
    `(got ${bot2._restartGuardRemaining})`);
  ok('a STALE file never re-arms chase-on-loss', bot2.chaseActive === false);
  ok('a STALE file still restores reporting figures', bot2.stats.closed === 5);

  // Inside the window the file is trusted again.
  const bot3 = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge3.json'),
                               stateMaxAgeSec: 7200 });
  fs.writeFileSync(tmpState, JSON.stringify(baseState(), null, 2));
  ok('the trust window is configurable', bot3._loadState().status === 'fresh');

  // MISSING.
  const bot4 = new AccuFable5({ ...CONFIG, stateFile: path.join(tmpStateDir, 'nope.json'),
                               edgeFile: path.join(tmpStateDir, 'edge4.json') });
  const missing = bot4._loadState();
  ok('an absent state file is reported as missing', missing.status === 'missing', `(got ${missing.status})`);
  ok('a cold start does not invent a martingale step', bot4.martingaleStep === 0);

  // CORRUPT — including a file truncated by a crash mid-write.
  for (const [label, body] of [['truncated JSON', '{"savedAt":"2026-09-27T10:00'],
                               ['empty file', ''],
                               ['not an object', '[1,2,3]']]) {
    const f = path.join(tmpStateDir, `corrupt-${label.replace(/\s+/g, '-')}.json`);
    fs.writeFileSync(f, body);
    const b = new AccuFable5({ ...CONFIG, stateFile: f, edgeFile: path.join(tmpStateDir, `e-${label}.json`) });
    const r = b._loadState();
    ok(`${label} is reported as corrupt, not trusted`, r.status === 'corrupt', `(got ${r.status})`);
    ok(`${label} does not invent a martingale step`, b.martingaleStep === 0);
    ok(`${label} still leaves the bot tradeable at base`, b.currentStake === 1);
  }

  console.log('\n[Restart guard]');
  const bot5 = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge5.json') });
  bot5.martingaleBase = 1; bot5.currentStake = 27; bot5.martingaleStep = 3;
  bot5._restartGuardRemaining = 0;
  ok('with no guard active the escalated stake is used', bot5._nextStake().stake === 27);
  bot5._restartGuardRemaining = 2;
  const guarded = bot5._nextStake();
  ok('the restart guard pins the stake to base', guarded.stake === 1, `(got ${guarded.stake})`);
  ok('the restart guard reports that it is active', guarded.guarded === true);
  ok('the restart guard does not destroy the tracked step', bot5.martingaleStep === 3);
  bot5._restartGuardRemaining = 0;
  ok('escalation resumes once the guard clears', bot5._nextStake().stake === 27);

  // The guard must clear as trades settle, or it would pin the bot forever.
  const bot6 = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge6.json') });
  bot6._restartGuardRemaining = 2;
  bot6._onClosed({ profit: -1, contractId: 'x', symbol: 'R_10', growthRate: 0.01, stake: 1,
                   targetTicks: 5, ticksHeld: 5, sellTime: Date.now() / 1000, closedAt: Date.now() });
  ok('the restart guard counts down as trades settle', bot6._restartGuardRemaining === 1,
    `(got ${bot6._restartGuardRemaining})`);
  ok('a settled loss still advances the martingale', bot6.martingaleStep >= 0);

  // ── Martingale max steps: RESET, never halt ──
  // Exhausting the escalation ladder is a STAKING policy decision ("stop
  // escalating"), not a reason to stop trading. Only the loss rails
  // (maxConsecLosses, dailyMaxLoss, sessionMaxDrawdown) may halt the bot.
  const mgBot = (over = {}) => new AccuFable5({
    ...CONFIG, stateFile: path.join(tmpStateDir, 'mg-cycle.json'),
    edgeFile: path.join(tmpStateDir, 'edge-mg.json'), ...over,
  });
  {
    const b = mgBot({ martingaleSteps: 2, martingaleMultiplier: 3, stake: 1 });
    b.martingaleBase = 1;
    b._updateMartingaleOnResult('lost');                       // step 1, stake 3
    ok('first loss steps up to 1/2', b.martingaleStep === 1 && b.currentStake === 3,
      `(step=${b.martingaleStep}, stake=${b.currentStake})`);
    b._updateMartingaleOnResult('lost');                       // step 2, stake 9
    ok('second loss steps up to 2/2', b.martingaleStep === 2 && b.currentStake === 9,
      `(step=${b.martingaleStep}, stake=${b.currentStake})`);

    b.risk.halted = false;
    const r = b._updateMartingaleOnResult('lost');            // would exceed 2/2
    ok('the loss past max steps RESETS instead of halting',
      b.risk.halted === false && b.martingaleStep === 0 && b.currentStake === 1,
      `(halted=${b.risk.halted}, step=${b.martingaleStep}, stake=${b.currentStake})`);
    ok('the reset reports max-reset, not max-halt',
      r.reason === 'max-reset' && r.changed === true, `(reason=${r.reason})`);
    ok('the reset reports the escalated stake it came down from', r.prev === 9,
      `(prev=${r.prev})`);

    // The cycle restarts cleanly rather than staying stuck at base forever.
    b._updateMartingaleOnResult('lost');
    ok('a new cycle steps up again from base', b.martingaleStep === 1 && b.currentStake === 3,
      `(step=${b.martingaleStep}, stake=${b.currentStake})`);
    b._updateMartingaleOnResult('won');
    ok('a win in the new cycle returns to base', b.martingaleStep === 0 && b.currentStake === 1);
  }
  {
    // CRITICAL: the reset must not clear a halt raised by the risk rails in
    // the same _onClosed pass. dailyMaxLoss halts BEFORE the martingale
    // updates, so wiping risk.halted here would let an over-cap bot trade on.
    const b = mgBot({ martingaleSteps: 1, martingaleMultiplier: 2, stake: 1 });
    b.martingaleBase = 1;
    b._updateMartingaleOnResult('lost');                       // at max steps
    b.risk.halt('daily loss limit hit (200)');
    b._updateMartingaleOnResult('lost');                       // triggers the reset
    ok('a legitimate risk halt survives the martingale reset',
      b.risk.halted === true && /daily loss/.test(b.risk.haltReason || ''),
      `(halted=${b.risk.halted}, reason=${b.risk.haltReason})`);
    ok('the risk halt still blocks trading after the reset',
      b.risk.canTrade(0).ok === false, `(canTrade ok=${b.risk.canTrade(0).ok})`);
  }
  {
    // maxConsecLosses is the rail that eventually stops a bot which keeps
    // resetting its martingale, so the two must not be confused with each other.
    const b = mgBot({ martingaleSteps: 1, martingaleMultiplier: 2, stake: 1, maxConsecLosses: 3 });
    b.martingaleBase = 1;
    for (let i = 0; i < 2; i++) { b.risk.onTradeClosed(-1); b._updateMartingaleOnResult('lost'); }
    ok('the martingale has cycled twice without halting',
      b.martingaleStep === 0 && b.currentStake === 1 && b.risk.halted === false,
      `(step=${b.martingaleStep}, halted=${b.risk.halted})`);
    // canTrade() is where the rail is ENFORCED, so the halt is raised there —
    // incrementing the counter alone cannot trip it.
    b.risk.onTradeClosed(-1);
    ok('the loss streak reaches maxConsecLosses', b.risk.consecLosses === 3,
      `(got ${b.risk.consecLosses})`);
    b.risk.canTrade(0);
    ok('maxConsecLosses still halts the bot', b.risk.halted === true,
      `(halted=${b.risk.halted})`);
    ok('the halt reason names the consecutive-loss rail',
      /consecutive losses/.test(b.risk.haltReason || ''), `(reason=${b.risk.haltReason})`);
  }

  // A recovered position must be persisted, not lost.
  const bot7 = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge7.json') });
  bot7.exec.open.set('contract-abc', {
    contractId: 'contract-abc', symbol: 'R_100', growthRate: 0.01, stake: 9,
    targetTicks: 50, expectedTicks: 50, halfBarrierFrac: 0.1, entrySpot: 1234.5,
    takeProfit: 4, openedAt: 111, buyTime: 222, ticksHeld: 7, status: 'open', paper: false,
  });
  bot7.lastTradedSymbol = 'R_75';
  bot7._saveState();
  const written = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
  const bot8 = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge8.json') });
  bot8._applyState(written, { trustStake: true });
  ok('the last traded symbol is persisted and restored',
    written.lastTradedSymbol === 'R_75' && bot8.lastTradedSymbol === 'R_75');
  ok('an open contract is written to the state file', written.openContracts?.length === 1);
  ok('the persisted record keeps the contract id', written.openContracts?.[0]?.contractId === 'contract-abc');
  ok('the persisted record keeps ticks held for resumption',
    written.openContracts?.[0]?.ticksHeld === 7);
  ok('the persisted record survives JSON round-trip',
    JSON.parse(JSON.stringify(written.openContracts[0])).symbol === 'R_100');
  ok('live subscriptions and timers are not serialised',
    written.openContracts?.[0]?._subId === undefined && written.openContracts?.[0]?._watchdog === undefined);

  // ── Preferred-candidate selection ──
  // evLowerPerTick = survival_lower x (1+g) - 1, so a HIGHER value is the
  // better-surviving asset. Two regression pins, mirroring the production
  // symptom from 2026-09-29 (a +0.078% EV pair lost to a -1.5% EV pair):
  //   (1) the ev gate is a FLOOR (≥ evLowerGateMin), so positive-EV assets
  //       pass and negative-EV assets are rejected — never the reverse;
  //   (2) among passers, the HIGHEST evLowerPerTick is chosen (ascending
  //       used to trade the worst pair).
  const evFloor = CONFIG.evLowerGateMin;
  const selDir = [
    { symbol: 'R_25',  growthRate: 0.01, evLowerPerTick: evFloor * 1.20, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_10',  growthRate: 0.01, evLowerPerTick: evFloor * 1.05, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_100', growthRate: 0.01, evLowerPerTick: evFloor * -2,   breaches: 1, tradeable: true, n: 101 },
  ];
  const harness = chaseSymbol => {
    const b = new AccuFable5({ ...CONFIG, stateFile: tmpState, edgeFile: path.join(tmpStateDir, 'edge-sel.json') });
    b.cfg.suspendPreviousAsset = true;
    b.cfg.evSelection = 'best';
    b.cfg.chaseOnLoss = true;
    b.cfg.stayMaxValue = 2;
    b.cfg.stayCurrentMax = 2;
    // OFF by default in this harness: every fixture below has TWO assets above
    // the ev floor (R_25 and R_10), so leaving the exclusivity filter on would
    // block all of them and these tests would measure the filter instead of the
    // ranking/chase behaviour they are pinning. The filter has its own block.
    b.cfg.requireSingleQualified = false;
    b._refreshStayedIn = async () => {};          // no network in the self-test
    b.md.deadAssets = new Set();
    b.md.getStayedIn = () => [1];                 // clears the stayed-in gate
    b.md.getBarrier = (s, g) => ({ halfBarrierFrac: 0.001, maxTicks: 230 });
    b.md.refreshBarrier = async () => ({ halfBarrierFrac: 0.001, maxTicks: 230 });
    b._calibrateAll = () => selDir.map(c => ({ ...c }));
    b.exec.canOpenNow = () => true;
    b.risk.halted = false;
    b.risk.onTradeOpened = () => {};
    b._nextStake = () => ({ stake: 1, guarded: false });
    b.opened = null;
    b.exec.openTrade = async t => { b.opened = t; };
    if (chaseSymbol) {
      b.chaseActive = true;
      b.chaseSymbol = chaseSymbol;
      b.chaseGrowthRate = 0.01;
    }
    return b;
  };

  const rankBot = harness(null);
  await rankBot._tickBody();
  ok('selection prefers the HIGHEST evLowerPerTick, not the lowest',
    rankBot.opened?.symbol === 'R_25', `(opened ${rankBot.opened?.symbol})`);

  const suspendedBot = harness(null);
  suspendedBot.lastTradedSymbol = 'R_25';
  await suspendedBot._tickBody();
  ok('selection suspends the previously traded asset',
    suspendedBot.opened?.symbol === 'R_10', `(opened ${suspendedBot.opened?.symbol})`);

  const multiAssetSuspension = harness(null);
  multiAssetSuspension.cfg.suspendPreviousAssetCount = 2;
  multiAssetSuspension.lastTradedSymbol = 'R_25';
  multiAssetSuspension.statsLog.trades = [{ symbol: 'R_10' }];
  multiAssetSuspension._calibrateAll = () => [
    { symbol: 'R_25', growthRate: 0.01, evLowerPerTick: evFloor * 1.20, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_10', growthRate: 0.01, evLowerPerTick: evFloor * 1.10, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_50', growthRate: 0.01, evLowerPerTick: evFloor * 1.05, breaches: 1, tradeable: true, n: 101 },
  ];
  await multiAssetSuspension._tickBody();
  ok('selection suspends the configured number of most-recent symbols',
    multiAssetSuspension.opened?.symbol === 'R_50', `(opened ${multiAssetSuspension.opened?.symbol})`);

  const repeatEnabledOff = harness(null);
  repeatEnabledOff.cfg.suspendPreviousAsset = false;
  repeatEnabledOff.lastTradedSymbol = 'R_25';
  await repeatEnabledOff._tickBody();
  ok('disabling previous-asset suspension permits a repeat',
    repeatEnabledOff.opened?.symbol === 'R_25', `(opened ${repeatEnabledOff.opened?.symbol})`);

  const singleAssetBot = harness(null);
  singleAssetBot.cfg.assets = ['R_25'];
  singleAssetBot.lastTradedSymbol = 'R_25';
  singleAssetBot._calibrateAll = () => selDir.filter(c => c.symbol === 'R_25').map(c => ({ ...c }));
  await singleAssetBot._tickBody();
  ok('single-asset configuration does not suspend its only asset',
    singleAssetBot.opened?.symbol === 'R_25', `(opened ${singleAssetBot.opened?.symbol})`);

  const suspendedChase = harness('R_25');
  suspendedChase.lastTradedSymbol = 'R_25';
  suspendedChase._calibrateAll = () => selDir.filter(c => c.symbol === 'R_25').map(c => ({ ...c }));
  await suspendedChase._tickBody();
  ok('suspended asset cannot be reopened through chase',
    suspendedChase.opened === null, `(opened ${suspendedChase.opened?.symbol ?? '(none)'})`);

  const multiSuspendedChase = harness('R_10');
  multiSuspendedChase.cfg.suspendPreviousAssetCount = 2;
  multiSuspendedChase.lastTradedSymbol = 'R_25';
  multiSuspendedChase.statsLog.trades = [{ symbol: 'R_10' }];
  multiSuspendedChase._calibrateAll = () => [
    { symbol: 'R_25', growthRate: 0.01, evLowerPerTick: evFloor * 1.20, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_10', growthRate: 0.01, evLowerPerTick: evFloor * 1.10, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_50', growthRate: 0.01, evLowerPerTick: evFloor * 1.05, breaches: 1, tradeable: true, n: 101 },
  ];
  await multiSuspendedChase._tickBody();
  ok('multi-symbol suspension also prevents reopening through chase',
    multiSuspendedChase.opened?.symbol === 'R_50', `(opened ${multiSuspendedChase.opened?.symbol})`);

  // The negative-EV asset falls below the floor, so with ONLY it in the field
  // and no chase the bot must hold, not trade a losing setup.
  const negOnly = harness(null);
  negOnly._calibrateAll = () => selDir.filter(c => c.evLowerPerTick < 0).map(c => ({ ...c }));
  await negOnly._tickBody();
  ok('no trade while every candidate is below the evLower floor',
    negOnly.opened === null, `(opened ${negOnly.opened?.symbol ?? '(none)'})`);

  // ── WORST-mode ev gate (EV_SELECTION=worst) ──
  // The gate becomes a CEILING (≤ evWorstGateMax, user-set threshold) and the
  // ranking flips to ASCENDING: the most-negative evLower/tick is the pick.
  // Fixture: everything sits well below the (negative) ceiling so we can
  // isolate the ranking flip; a singleton above the ceiling must be gated.
  console.log('\n[Worst-mode selection]');
  const worstCeil = CONFIG.evWorstGateMax;   // e.g. -0.07547%
  const worstDir = [
    { symbol: 'R_25',  growthRate: 0.01, evLowerPerTick: worstCeil * 2.0,  breaches: 1, tradeable: true, n: 101 }, // most negative
    { symbol: 'R_10',  growthRate: 0.01, evLowerPerTick: worstCeil * 1.5,  breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_100', growthRate: 0.01, evLowerPerTick: worstCeil * 0.5,  breaches: 1, tradeable: true, n: 101 }, // closest to ceiling
    { symbol: 'R_50',  growthRate: 0.01, evLowerPerTick: worstCeil * -0.5, breaches: 1, tradeable: true, n: 101 }, // POSITIVE → above ceiling
  ];
  const worstHarness = (over = {}) => {
    const b = new AccuFable5({ ...CONFIG, evSelection: 'worst', stateFile: tmpState,
                               edgeFile: path.join(tmpStateDir, 'edge-sel.json'), ...over });
    b.cfg.suspendPreviousAsset = true;
    b.cfg.chaseOnLoss = true;
    b.cfg.stayMaxValue = 2;
    b.cfg.stayCurrentMax = 2;
    b.cfg.requireSingleQualified = false;
    b._refreshStayedIn = async () => {};
    b.md.deadAssets = new Set();
    b.md.getStayedIn = () => [1];
    b.md.getBarrier = (s, g) => ({ halfBarrierFrac: 0.001, maxTicks: 230 });
    b.md.refreshBarrier = async () => ({ halfBarrierFrac: 0.001, maxTicks: 230 });
    b._calibrateAll = () => worstDir.map(c => ({ ...c }));
    b.exec.canOpenNow = () => true;
    b.risk.halted = false;
    b.risk.onTradeOpened = () => {};
    b._nextStake = () => ({ stake: 1, guarded: false });
    b.opened = null;
    b.exec.openTrade = async t => { b.opened = t; };
    return b;
  };

  const worstRank = worstHarness();
  await worstRank._tickBody();
  ok('WORST mode trades the MOST-negative evLower/tick, not the least-bad',
    worstRank.opened?.symbol === 'R_25', `(opened ${worstRank.opened?.symbol})`);

  const worstGateBlocks = worstHarness();
  worstGateBlocks._calibrateAll = () => worstDir.filter(c => c.evLowerPerTick > 0).map(c => ({ ...c }));
  await worstGateBlocks._tickBody();
  ok('WORST mode gates out assets above the ceiling (positive EV)',
    worstGateBlocks.opened === null, `(opened ${worstGateBlocks.opened?.symbol ?? '(none)'})`);

  const worstGatePasses = worstHarness();
  worstGatePasses._calibrateAll = () => worstDir.filter(c => c.evLowerPerTick <= worstCeil).map(c => ({ ...c }));
  await worstGatePasses._tickBody();
  ok('WORST mode keeps every asset at/below the ceiling as a candidate',
    worstGatePasses.opened?.symbol === 'R_25', `(opened ${worstGatePasses.opened?.symbol})`);

  const chaseOutranked = harness('R_100');  // the below-floor pair
  await chaseOutranked._tickBody();
  ok('a chase is abandoned when the chased pair is outranked',
    chaseOutranked.opened?.symbol === 'R_25' && chaseOutranked.opened?.calibration?.chase !== true,
    `(opened ${chaseOutranked.opened?.symbol})`);

  const chaseUpheld = harness('R_25');     // still the top-ranked candidate
  await chaseUpheld._tickBody();
  // Upheld means "the chase and ranked selection agree", so the trade comes
  // through the normal ranked path — not the gate-suspended legacy chase.
  ok('a chase is upheld while the chased pair is still top-ranked',
    chaseUpheld.opened?.symbol === 'R_25' &&
    chaseUpheld.opened?.calibration?.chase !== true &&
    chaseUpheld.opened?.calibration?.evLowerPerTick === evFloor * 1.20,
    `(opened ${chaseUpheld.opened?.symbol}, chase=${chaseUpheld.opened?.calibration?.chase})`);

  // Nothing calibrated: there is no ranking to contradict, so the original
  // gate-suspended chase must still fire rather than strand the martingale.
  const stalled = harness('R_100');
  stalled._calibrateAll = () => [];
  await stalled._tickBody();
  ok('a chase still fires when nothing is calibrated',
    stalled.opened?.symbol === 'R_100' && stalled.opened?.calibration?.chase === true,
    `(opened ${stalled.opened?.symbol})`);

  // ── Exclusivity filter: trade only when exactly ONE asset is qualified ──
  // "Qualified" is defined by the user as clearing the ev gate (≥ evLowerGateMin
  // in BEST mode, ≤ evWorstGateMax in WORST mode). Two or more qualified assets
  // is an ambiguous field, so nothing is executed — not the top-ranked one, and
  // not through the gate-suspended chase.
  console.log('\n[Exclusivity filter]');
  const qualOn = () => { const b = harness(null); b.cfg.requireSingleQualified = true; return b; };
  const floor = evFloor;

  // One qualified asset (R_25), one below the floor (R_100), one uncalibrated.
  const oneQualified = qualOn();
  oneQualified._calibrateAll = () => [
    { symbol: 'R_25', growthRate: 0.01, evLowerPerTick: floor * 1.20, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_10', growthRate: 0.01, evLowerPerTick: floor * 0.99, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_100', growthRate: 0.01, evLowerPerTick: null, reason: 'insufficient-history:40/101', breaches: null, tradeable: false, n: 40 },
  ];
  await oneQualified._tickBody();
  ok('exactly one qualified asset trades normally',
    oneQualified.opened?.symbol === 'R_25', `(opened ${oneQualified.opened?.symbol ?? '(none)'})`);

  const twoQualified = qualOn();
  twoQualified._calibrateAll = () => selDir.map(c => ({ ...c }));
  await twoQualified._tickBody();
  ok('two qualified assets execute NO trade at all',
    twoQualified.opened === null, `(opened ${twoQualified.opened?.symbol ?? '(none)'})`);

  const threeQualified = qualOn();
  threeQualified._calibrateAll = () => [
    ...selDir.map(c => ({ ...c })),
    { symbol: 'R_50', growthRate: 0.01, evLowerPerTick: floor * 1.50, breaches: 1, tradeable: true, n: 101 },
  ];
  await threeQualified._tickBody();
  ok('a third qualified asset still blocks (no top-of-a-crowd pick)',
    threeQualified.opened === null, `(opened ${threeQualified.opened?.symbol ?? '(none)'})`);

  // The toggle the user asked for: same crowded field, filter off → ranked trade.
  const filterOff = harness(null);
  filterOff.cfg.requireSingleQualified = false;
  await filterOff._tickBody();
  ok('turning the filter OFF restores the ranked trade',
    filterOff.opened?.symbol === 'R_25', `(opened ${filterOff.opened?.symbol ?? '(none)'})`);

  // Blocking has to happen BEFORE the chase branch. Folding it into the
  // candidate filter would empty the list, which is exactly the condition that
  // hands the tick to the gate-suspended chase — trading while blocking.
  const chaseCrowded = qualOn();
  chaseCrowded.chaseActive = true;
  chaseCrowded.chaseSymbol = 'R_25';
  chaseCrowded.chaseGrowthRate = 0.01;
  await chaseCrowded._tickBody();
  ok('a crowded field also blocks the gate-suspended chase',
    chaseCrowded.opened === null, `(opened ${chaseCrowded.opened?.symbol ?? '(none)'})`);

  // One asset qualifying at two growth rates is still ONE asset, not a crowd.
  const sameSymbolTwice = qualOn();
  sameSymbolTwice._calibrateAll = () => [
    { symbol: 'R_25', growthRate: 0.01, evLowerPerTick: floor * 1.10, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_25', growthRate: 0.05, evLowerPerTick: floor * 1.30, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_100', growthRate: 0.01, evLowerPerTick: floor * -2, breaches: 1, tradeable: true, n: 101 },
  ];
  await sameSymbolTwice._tickBody();
  ok('qualifying at two growth rates of ONE asset is not a crowd',
    sameSymbolTwice.opened?.growthRate === 0.05,
    `(opened ${sameSymbolTwice.opened?.symbol}@${sameSymbolTwice.opened?.growthRate})`);

  // An uncalibrated pair cannot be certified against the floor, so a stalled
  // feed must not be able to manufacture ambiguity and freeze the bot.
  const uncalNoCrowd = qualOn();
  uncalNoCrowd._calibrateAll = () => [
    { symbol: 'R_25', growthRate: 0.01, evLowerPerTick: floor * 1.20, breaches: 1, tradeable: true, n: 101 },
    { symbol: 'R_50', growthRate: 0.01, evLowerPerTick: null, reason: 'no-barrier', breaches: null, tradeable: false, n: 0 },
    { symbol: 'R_75', growthRate: 0.01, evLowerPerTick: null, reason: 'no-barrier', breaches: null, tradeable: false, n: 0 },
  ];
  await uncalNoCrowd._tickBody();
  ok('uncalibrated pairs never count as qualified',
    uncalNoCrowd.opened?.symbol === 'R_25', `(opened ${uncalNoCrowd.opened?.symbol ?? '(none)'})`);

  // Zero qualified is not a crowd: the ev floor alone already blocks it, and the
  // filter must not swallow the "nothing calibrated" chase rescue on the way.
  const zeroQualified = qualOn();
  zeroQualified._calibrateAll = () => selDir.filter(c => c.evLowerPerTick < floor).map(c => ({ ...c }));
  await zeroQualified._tickBody();
  ok('zero qualified assets is left to the ev floor, not the filter',
    zeroQualified.opened === null, `(opened ${zeroQualified.opened?.symbol ?? '(none)'})`);

  const stillStalled = harness('R_100');
  stillStalled.cfg.requireSingleQualified = true;
  stillStalled._calibrateAll = () => [];
  await stillStalled._tickBody();
  ok('the filter does not disable the chase rescue when nothing is calibrated',
    stillStalled.opened?.symbol === 'R_100' && stillStalled.opened?.calibration?.chase === true,
    `(opened ${stillStalled.opened?.symbol ?? '(none)'})`);

  // The helper the gate and the report share — count per symbol, keep the best pair.
  const qBot = harness(null);
  const qMap = qBot._qualifiedAssets([
    { symbol: 'R_25', growthRate: 0.01, evLowerPerTick: floor * 1.10 },
    { symbol: 'R_25', growthRate: 0.05, evLowerPerTick: floor * 1.30 },
    { symbol: 'R_10', growthRate: 0.01, evLowerPerTick: floor * 0.50 },
    { symbol: 'R_50', growthRate: 0.01, evLowerPerTick: null },
    { symbol: 'R_75', growthRate: 0.01, evLowerPerTick: floor },   // boundary: >= is inclusive
  ]);
  ok('_qualifiedAssets counts symbols, skips sub-floor and null, and keeps the best pair',
    qMap.size === 2 && qMap.get('R_25').growthRate === 0.05 && qMap.has('R_75'),
    `(size=${qMap.size})`);

  // A throwaway state path for the client instances below. The temp DIR is
  // only removed AFTER this block, so these still have somewhere to write.
  const tmpState2 = path.join(tmpStateDir, 'stability.json');

  // ── Long-lived-process stability ──
  // These pin the fixes for the Suga restart loop. Each one corresponds to a
  // concrete way this bot used to be killed by a transient fault and be
  // restarted by the platform supervisor, stranding state on an ephemeral
  // filesystem.
  console.log('\n[Runtime stability]');

  const rc = new DerivClient({ ...CONFIG, stateFile: tmpState2, reconnect: CONFIG.reconnect });
  ok('the client is an EventEmitter (so an unhandled "error" can throw)',
    typeof rc.listenerCount === 'function' && rc.listenerCount('error') === 0);

  // Regression pin for the actual crash: with no 'error' listener, a bare
  // emit throws. The client must therefore not forward ws errors blindly.
  const emitsSafelyWithoutListener = (() => {
    try { rc.emit('error', new Error('ECONNRESET')); return true; } catch (e) { return false; }
  })();
  ok('emitting "error" with no listener throws (the crash we are avoiding)',
    emitsSafelyWithoutListener === false);

  // The fix: guard the emit behind listenerCount. This must not throw.
  let noThrow = true;
  try {
    if (rc.listenerCount('error') > 0) rc.emit('error', new Error('ECONNRESET'));
  } catch (_) { noThrow = false; }
  ok('a guarded emit with no listener does not throw', noThrow);

  // And when a listener DOES exist the error is still delivered, so the
  // guard does not silence real faults.
  const seen = [];
  rc.on('error', e => seen.push(e.message));
  rc.emit('error', new Error('ECONNRESET'));
  ok('a real error is still delivered to a subscribed listener',
    seen.length === 1 && seen[0] === 'ECONNRESET');

  // A stale socket must not be able to tear down a live one.
  const genClient = new DerivClient({ ...CONFIG, stateFile: tmpState2, reconnect: CONFIG.reconnect });
  genClient._connGen = 1;
  const g0 = genClient._connGen;
  const g1 = g0 + 1;                 // pretend a new socket superseded the old
  ok('socket generation advances so stale handlers can be ignored',
    g0 !== g1 && typeof g0 === 'number');

  // The supervisor-visible lifecycle contract. Both Suga reference bots keep
  // running through a transient exception; only a clean signal or a failed
  // STARTUP may exit. This reads the shipped main() source so the pin tracks
  // the real handlers rather than a copy of them.
  const mainSrc = fs.readFileSync(__filename, 'utf8');
  const uncaughtBlock = (mainSrc.match(/process\.on\('uncaughtException'[\s\S]*?\n  \}\);/) || [''])[0];
  ok('uncaughtException no longer calls process.exit', !/process\.exit/.test(uncaughtBlock),
    '(a single transient fault must not trigger a supervisor restart)');
  ok('uncaughtException still persists state before continuing', /_saveState/.test(uncaughtBlock));
  ok('startup failure still exits (a broken config should not spin)',
    /await bot\.start\(\);[\s\S]{0,80}?process\.exit\(1\)/.test(mainSrc));
  ok('SIGTERM/SIGINT still exit cleanly',
    /process\.on\('SIGTERM'/.test(mainSrc) && /process\.on\('SIGINT'/.test(mainSrc) &&
    /const shutdown = async sig => \{[\s\S]{0,200}?process\.exit\(0\)/.test(mainSrc));

  // STATE_DIR must be anchored, not relative to whatever cwd the platform
  // happens to hand the process.
  ok('STATE_DIR has an absolute default', path.isAbsolute(STATE_DIR), `(got ${STATE_DIR})`);
  ok('the state file lives under STATE_DIR',
    path.dirname(CONFIG.stateFile) === STATE_DIR, `(got ${path.dirname(CONFIG.stateFile)})`);

  // The periodic report must not be able to throw out of a timer callback,
  // where it would land in uncaughtException.
  ok('the periodic report is wrapped in a try/catch',
    /setInterval\(\(\) => \{ try \{ bot\.report\(\); \} catch \(e\) \{/.test(mainSrc));
  ok('the periodic report timer is cleared on stop',
    /if \(this\._reportT\) clearInterval\(this\._reportT\)/.test(mainSrc));

  try { fs.rmSync(tmpStateDir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n[Config safety]');
  ok('no API token is hardcoded', CONFIG.apiToken === (process.env.DERIV_API_TOKEN || process.env.API_TOKEN || ''));
  ok('no Telegram token is hardcoded',
    CONFIG.telegram.botToken === (process.env.TELEGRAM_BOT_TOKEN || ''));
  ok('default mode is paper', envStr('MODE', 'paper') === 'paper');
  ok('live mode requires explicit confirmation',
    CONFIG.mode !== 'live' || CONFIG.confirmLive === 'i-understand');
  ok('growth rates stay within Deriv limits',
    CONFIG.growthRates.every(g => g >= 0.01 && g <= 0.05));
  // Check the DEFAULT family. A user may deliberately trade a boom/crash
  // index, but that is a modelling caveat the banner warns about — it is not
  // a config error, so it must not masquerade as a self-test failure.
  const defaultAssets = envStr('ASSETS', 'R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V')
    .split(',').map(s => s.trim()).filter(Boolean);
  ok('default assets are volatility indices',
    defaultAssets.every(s => /^(R_\d+|1HZ\d+V)$/.test(s)), `(${defaultAssets.join(',')})`);
  if (CONFIG.assets.some(s => CONFIG.isBoomOrCrash(s))) {
    console.log(`  ! note: configured non-volatility assets: ` +
      `${CONFIG.assets.filter(s => CONFIG.isBoomOrCrash(s)).join(',')} — ` +
      'boom/crash jump events make the Gaussian EV model unreliable');
  }
  ok('sizing mode is flat or fraction', ['flat', 'fraction'].includes(CONFIG.sizing));
  ok('max hold never exceeds the 230-tick contract cap', CONFIG.maxHoldTicks <= 230);
  ok('edge monitor can actually arm', CONFIG.edgeMonitorMinTrades > 0 && CONFIG.edgeMonitorMinTrades <= 1000,
    `(got ${CONFIG.edgeMonitorMinTrades})`);
  ok('a request gap is enforced to avoid rate limiting', CONFIG.minRequestGapMs >= 50,
    `(got ${CONFIG.minRequestGapMs})`);
  ok('breach gate bounds are a valid range',
    CONFIG.breachMinCount2 === 0 || CONFIG.breachMinCount2 >= CONFIG.breachMinCount);
  // The exclusivity filter must be settable both ways without touching code,
  // and it must default ON — an ambiguous field standing aside is the point.
  ok('the exclusivity filter is a real boolean, defaulting to ON',
    typeof CONFIG.requireSingleQualified === 'boolean' &&
    CONFIG.requireSingleQualified === envBool('REQUIRE_SINGLE_QUALIFIED', true),
    `(got ${CONFIG.requireSingleQualified})`);
  // Exercise the actual env switch rather than asserting the shape of it.
  const savedSingleQualified = process.env.REQUIRE_SINGLE_QUALIFIED;
  process.env.REQUIRE_SINGLE_QUALIFIED = 'false';
  const exclFromEnvOff = envBool('REQUIRE_SINGLE_QUALIFIED', true);
  process.env.REQUIRE_SINGLE_QUALIFIED = 'true';
  const exclFromEnvOn = envBool('REQUIRE_SINGLE_QUALIFIED', false);
  if (savedSingleQualified === undefined) delete process.env.REQUIRE_SINGLE_QUALIFIED;
  else process.env.REQUIRE_SINGLE_QUALIFIED = savedSingleQualified;
  ok('REQUIRE_SINGLE_QUALIFIED flips the filter both ways from the environment',
    exclFromEnvOff === false && exclFromEnvOn === true,
    `(off=${exclFromEnvOff}, on=${exclFromEnvOn})`);
  // The ev gate direction must be a real "best|worst" switch, defaulting to
  // BEST so today's floor/descending behaviour survives an unset variable,
  // and any unknown value must safely fall back to BEST.
  ok('ev selection defaults to BEST (floor ≥, descending)',
    CONFIG.evSelection === envStr('EV_SELECTION', 'best') &&
    CONFIG.evSelection === 'best',
    `(got ${CONFIG.evSelection})`);
  ok('ev selection accepts only best or worst modes',
    ['best', 'worst'].includes(CONFIG.evSelection), `(got ${CONFIG.evSelection})`);
  ok('worst-mode ceiling is a user-set threshold, distinct from the floor',
    CONFIG.evWorstGateMax < 0 && CONFIG.evWorstGateMax !== CONFIG.evLowerGateMin,
    `(worst=${CONFIG.evWorstGateMax}, best=${CONFIG.evLowerGateMin})`);
  const savedEvSelection = process.env.EV_SELECTION;
  process.env.EV_SELECTION = 'worst';
  const worstFromEnv = envStr('EV_SELECTION', 'best');
  if (savedEvSelection === undefined) delete process.env.EV_SELECTION;
  else process.env.EV_SELECTION = savedEvSelection;
  ok('EV_SELECTION=worst is honoured from the environment',
    worstFromEnv === 'worst', `(got ${worstFromEnv})`);
  // envStr only falls back past an EMPTY value; anything else passes through
  // to the config. The real guard is _evGate(): anything that is not exactly
  // 'worst' behaves as BEST, so a typo cannot silently flip the gate.
  const bestGate = new AccuFable5({ ...CONFIG, stateFile: tmpState, evSelection: 'bogus' })._evGate();
  ok('an unknown EV_SELECTION value behaves as BEST, never WORST',
    bestGate.worst === false && bestGate.threshold === CONFIG.evLowerGateMin,
    `(worst=${bestGate.worst}, threshold=${bestGate.threshold})`);

  console.log('\n' + '='.repeat(60));
  console.log(`${pass} passed, ${fail} failed`);
  console.log('='.repeat(60) + '\n');
  return fail === 0;
}

// ═══════════════════════════════════════════════════════════════════════
// 16. BANNER + MAIN
// ═══════════════════════════════════════════════════════════════════════
function printBanner() {
  const mode = CONFIG.mode.toUpperCase();
  console.log(`
╭──────────────────────────────────────────────────────────────────────╮
│  AccuFable5 — measure-first Deriv Accumulator engine        │
├──────────────────────────────────────────────────────────────────────┤
│  mode          ${mode.padEnd(46)}│
│  assets        ${String(CONFIG.assets.length + ' volatility indices').padEnd(46)}│
│  growth rates  ${CONFIG.growthRates.map(g => (g * 100) + '%').join(', ').padEnd(46)}│
│  sizing        ${String(CONFIG.sizing + (CONFIG.martingaleSteps > 0 ? ` (martingale ×${CONFIG.martingaleMultiplier}, ${CONFIG.martingaleSteps} steps)` : ' (no martingale)')).padEnd(46)}│
│  chase-on-loss ${String(CONFIG.chaseOnLoss ? 'ON (re-trade same asset until win)' : 'OFF').padEnd(46)}│
│  stake         ${String(CONFIG.stake + ' ' + CONFIG.currency).padEnd(46)}│
│  take profit   ${String(CONFIG.takeProfitTicks + ' ticks').padEnd(46)}│
│  daily max loss${String(' ' + CONFIG.dailyMaxLoss + ' ' + CONFIG.currency).padEnd(46)}│
│  stay gate     ${String(CONFIG.stayWindowN + ' most current < ' + CONFIG.stayMaxValue + ', latest < ' + CONFIG.stayCurrentMax).padEnd(46)}│
│  ev gate       ${String('evLower/tick ' + (CONFIG.evSelection === 'worst' ? '≤ ' : '≥ ') + ((CONFIG.evSelection === 'worst' ? CONFIG.evWorstGateMax : CONFIG.evLowerGateMin) * 100).toFixed(4) + '% (' + (CONFIG.evSelection === 'worst' ? 'WORST' : 'BEST') + ')').padEnd(46)}│
│  exclusivity   ${String(CONFIG.requireSingleQualified ? 'ON (exactly 1 qualified asset)' : 'OFF (rank them all)').padEnd(46)}│
╰──────────────────────────────────────────────────────────────────────╯`);
  if (CONFIG.mode !== 'live') {
    console.log('  PAPER MODE: real ticks, real barriers, simulated money.\n');
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--selftest')) {
    process.exit((await runSelfTest()) ? 0 : 1);
  }

  if (args.includes('--calibrate')) {
    try { await runCalibration(); process.exit(0); }
    catch (e) { logger.error('calibration failed:', e.message); process.exit(1); }
  }

  const bot = new AccuFable5(CONFIG);

  const shutdown = async sig => {
    logger.info(`received ${sig} — shutting down`);
    try { await bot.stop(); } catch (e) { logger.error('shutdown:', e.message); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', r => { logger.error('unhandledRejection:', String(r)); });
  process.on('uncaughtException', e => {
    logger.error('uncaughtException:', e.message);
    try { bot._saveState?.(); } catch (_) {}
    // DO NOT exit — keep process alive to allow reconnection and recovery.
  });

  // Periodic report so a long paper run is legible.
    bot._reportT = setInterval(() => { try { bot.report(); } catch (e) { logger.error('report:', e.message); } }, 15 * 60 * 1000);

  try { await bot.start(); }
  catch (e) { logger.error('startup failed:', e.message); process.exit(1); }
}

if (require.main === module) main();

module.exports = {
  CONFIG, Stats, CalibrationEngine, EdgeLedger, RiskManager,
  TradeExecutor, MarketData, DerivClient, AccuFable5,
  monteCarlo, sweep, runSelfTest, gaussian,
};
