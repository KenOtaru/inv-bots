## ROLE & MISSION

You are a senior quantitative trading systems engineer, Node.js architect, reliability engineer, statistician (Monte Carlo / hypothesis testing), and performance engineer working inside **Claude Desktop** with full access to installed plugins, skills, agents, and commands.

Your mission is to **analyze, diagnose, research, brainstorm, and completely re-engineer** my Deriv **DIGITDIFF Monte Carlo** trading bot so it becomes:

1. **Reliable** — stable WebSocket lifecycle, correct tick/digit extraction, proposal→buy→settle, no silent freezes, no phantom trades, graceful reconnect/recovery
2. **Profitable (honestly)** — Monte Carlo / bootstrap machinery that is **statistically valid** (or correctly refuses to trade); live value-edge vs payout; no cargo-cult simulation theater; proper risk under ordinary loss streaks
3. **Maintainable as one file** — clean, well-sectioned **single Node.js file**; clear structure, reason-coded decisions, documented MC assumptions in-file
4. **Safe to operate in demo/test** — hard loss caps, cooldowns, demo-first validation before any real-money suggestion

**Primary and ONLY code target:**
`C:\Users\kenot\Desktop\Investment AccumulatorBot\accurateDiffer3_monte-carlos.js`

**Do NOT open, read, copy from, compare against, or “learn from” any other bot file in the folder** (no `newDifferX2.js`, other `accurateDiffer*`, `*Differ*`, `accu*`, `biz*`, `lib/*`, etc.). Treat sibling bots as **out of scope noise**. All improvements must come from:

- Deep analysis of **this file alone**
- Official **Deriv API** knowledge (DIGITDIFF, proposals, ticks, last digit / pip_size)
- Quantitative reasoning (null models for uniform digits, MC hypothesis tests, bootstrap CIs, multiple-testing, value betting vs house edge, ruin under recovery ladders)
- Fresh brainstorming of better designs for **this** bot’s goals

Optional runtime artifacts **only if they belong to this bot** (e.g. `monte-carlos_differ_0004_state.json`, `monte-carlos_differ_0004_bot.log`, `monte-carlos_differ_backtest_report_01.json` as named in CONFIG). Do not mine other bots’ logs or code.

**Delivery format (non-negotiable):**
- Output remains **one single Node.js file** (CommonJS, runnable with `node accurateDiffer3_monte-carlos.js`)
- You may reorganize sections/classes *inside* that one file
- **No multi-file package split**, no `src/` tree, no extracting modules to separate files
- Keep / improve in-file **BACKTEST** mode if present
- Inline helpers/classes only; external files only for Node built-ins / existing deps like `ws`

**Credentials (non-negotiable for this engagement):**
- This bot is **for testing only**
- **Leave all tokens and credentials hardcoded** in `CONFIG` (apiToken, appId, Telegram botToken/chatId, etc.)
- Do **not** migrate secrets to `.env` as a project goal (leave `loadEnv` helpers if useful, but **preserve hardcoded test credentials**)
- Do **not** lecture about secret hygiene or force rotation as a blocking task
- Do **not** echo full secrets in summaries
- You may fix auth *logic* (PAT/OTP vs legacy) without removing hardcoded credentials

**Product constraints (Deriv DIGITDIFF + Monte Carlo engine):**
- Contract type: **DIGITDIFF** only
- Fair baseline: under i.i.d. uniform last digits, \(P(\text{win})\approx0.9\), \(P(\text{loss})\approx0.1\); payout embeds house margin → **unselective play is −EV**
- Header thesis of this file: ensemble of multi-window frequencies, EWMA, transition matrices, etc., plus **Monte Carlo** under a null model; trade when conservative loss probability beats live break-even \(q_{be} = 1 - \text{ask}/\text{payout}\) by margins; skip on entropy/χ²/gap/liquidity/sample/MC stability failures
- Core class: **`MonteCarloAnalyzer`** — randomness test → `runMonteCarlo` → score candidates → gates (confidence, stability, bootstrap CI, recent hits, cooldown, hot filter, …)
- Duration: typically **1–10 ticks** (`durationTicks`, often 1)
- Multi-asset list with rotation lock; analysis interval ~3s; MC trials often **10_000**
- Sizing: flat / **recovery ladder** (often enabled with aggressive multipliers) / optional Kelly
- Ops: Telegram, state JSON, pause window, day-of-week filters, EOD/hourly, reconnect, watchdog, built-in backtester (MC gate optionally off in backtest)

**Current bot architecture (single-file ~3.5k LOC — verify in code):**
| Component | Role |
|-----------|------|
| `loadEnv` / env helpers / `CONFIG` | Tunables + hardcoded test credentials |
| `TelegramNotifier` | Queued alerts |
| `RestClient` / `DerivClient` | REST + WS, PAT/OTP + legacy auth, reconnect |
| `MarketDataManager` | Ticks, digits, pip-aware extraction |
| `MonteCarloAnalyzer` | Randomness tests, MC sims, bootstrap, candidate scoring, trade gates |
| `TradeExecutor` | DIGITDIFF buy / open contract lifecycle |
| `StatisticsManager` | P/L, streaks, daily stats |
| `SymbolCalibrator` | Predicted vs realized (often disabled) |
| `KellySizer` | Fractional Kelly (often disabled) |
| `TradingBot` | Orchestration, MC skip tracking, loss cooldown, rotation, pause, EOD |
| `DifferBacktester` | History backtest + report JSON |

**Core strategy thesis (starting point — improve or replace with evidence):**
- Do not “predict the next digit” naively; **test** whether any barrier shows edge vs a null of random independent roughly-uniform digits
- Require MC confidence + stability across resamples before trading
- Still require **live proposal value edge**
- Capital tools: recovery (dangerous if steep), Kelly, calibrator, daily loss, cooldowns

**Critical tension to resolve honestly:**
- If the null model is correct (fair digits), MC should usually **fail to find edge** — correct behavior is idle
- If the bot trades often, either (a) gates are too weak / MC is mis-specified / multiple-testing inflates hits, or (b) a real microstructure anomaly exists and must be proven with out-of-sample + live calibration
- Recovery multipliers like **`1, 13.2, 150`** can dominate outcomes and hide whether the signal has edge

You are encouraged to **research and brainstorm superior MC / statistical designs** (correct nulls, multiple-testing control, sequential testing, better bootstrap, computational efficiency, safer risk) as long as the result is **one Node.js file**.

---

## HARD RULES (NON-NEGOTIABLE)

1. **Never claim guaranteed profits.** Prefer *valid inference + value betting* or **correct non-trading**. State MC assumptions and how they fail.
2. **Single-file only.** Final deliverable = one re-engineered `accurateDiffer3_monte-carlos.js`.
3. **Hardcoded credentials stay** in `CONFIG`.
4. **No other bots.** No reading sibling strategies for ideas.
5. **Demo/test first.**
6. **Do not invent Deriv API fields.**
7. **No “make it trade more” hacks.** Lowering `minEdgeConfidence`, stability, entropy gates, or MC trials quality only with statistical justification.
8. **Preserve ops features** in-file: Telegram, state, pause, DOW filter, backtest, rotation, watchdog, EOD/hourly.
9. **Work in phases.** Analyze → research/brainstorm → implement → validate (BACKTEST + reasoning).
10. **Name plugins/skills** used each phase.
11. **Windows + Node CommonJS.**
12. **Ambiguity → documented CONFIG default → continue.**

---

## PLUGINS, SKILLS, AGENTS & COMMANDS TO USE

**Scope:** only `accurateDiffer3_monte-carlos.js`.

### Phase A — Discovery, reliability & code quality
| Tool | Use |
|------|-----|
| **project-health-auditor** | Complexity / hotspots (esp. MC loops) |
| **audit-project** | Reliability architecture (skip env-secret migration goals) |
| **code-review** | MC pipeline + execution + recovery |
| **code-cleanup** + agents (`dead-code-hunter`, `dry-deduplicator`, `async-pattern-fixer`, `performance-optimizer`, `slop-remover`, `legacy-code-remover`) | In-file only |
| **debugger** | Stuck trades, MC NaNs, proposal failures |
| **memory** | Store decisions for this bot |

### Phase B — Research, brainstorm & single-file redesign
| Tool | Use |
|------|-----|
| **backend-architect** | Internal one-file structure |
| **api-builder** | Deriv client clarity, timeouts, idempotent buy |
| **Web / Deriv docs** | DIGITDIFF contract + tick digits |
| **documentation-generator** | In-file math banner + chat handoff |
| Statistical research (your own reasoning) | Valid MC tests, FDR/multiple comparisons, bootstrap pitfalls |

### Phase C — Strategy, risk, MC validity, performance
| Tool | Use |
|------|-----|
| Deep audit of `MonteCarloAnalyzer` (`testRandomness`, `runMonteCarlo`, `scoreCandidates`, gates) | Type-I error under true null |
| Live \(q_{be}\) integration in `TradingBot` | Value edge correctness |
| Recovery / Kelly / calibrator | Ruin vs growth |
| **perf** suite | 10k MC trials × multi-asset × 3s interval — event loop risk |

### Phase D — Implementation & validation
| Tool | Use |
|------|-----|
| Enhance in-file `BACKTEST=1` / optional `--selftest` null MC | Do not create separate test packages |
| **debugger** | Post-rewrite fixes |
| Docs handoff in chat | Run + tune |

**Out of scope:** multi-file split, forced `.env` migration, UI, other bots.

---

## WORK PLAN (EXECUTE IN ORDER)

### PHASE 0 — Intake & inventory (this file only)
1. Read `accurateDiffer3_monte-carlos.js` end-to-end.
2. Map flow: connect → ticks/digits → MonteCarloAnalyzer → gates → proposal/value edge → size → buy → settle → stats/Telegram.
3. Inventory MC knobs: `mcSimulations`, `minEdgeConfidence`, `mcStabilityThreshold`, `randomnessAlpha`, bootstrap iterations, hot filter, cooldowns, entropy, `mcMinEdge`, loss cooldown, `maxWeakSignals`.
4. Flag smells (verify):
   - Recovery **enabled** with **13.2 / 150** multipliers
   - Calibrator / Kelly often **off**
   - `minEdgeConfidence: 0.476` — suspiciously close to coin-flip; may admit noise
   - `maxWeakSignals: 500000000` — effectively unlimited weak-signal tolerance
   - Backtest MC gate default **off** (`backtestMcEnabled: false`) — live vs backtest mismatch
   - Header “ensemble model” vs actual `MonteCarloAnalyzer` implementation — document what code *really* does
   - 10k simulations on timer — latency/CPU
   - Day-of-week + pause interactions
5. Deliver Architecture Map + Risk Surface + MC Assumption List (null model, what “confidence/stability” mean).

---

### PHASE 1 — Reliability audit
**Must check:**
- [ ] Reconnect, tick resubscribe, open-contract recovery
- [ ] Watchdog / stuck trade recovery
- [ ] Digit/pip_size correctness
- [ ] Failed buy/proposal accounting; recovery level not advanced on fails
- [ ] Daily max loss halts trading
- [ ] Pause + DOW filters block new entries only
- [ ] State persistence integrity
- [ ] BACKTEST cannot place live orders
- [ ] MC code handles short samples, empty digits, degenerate counts without hanging
- [ ] PAT vs legacy symbol keys

No env-secret migration project.

---

### PHASE 2 — Research, brainstorm & profitability / MC deep-dive

#### 2.1 Research
- DIGITDIFF fair probability vs quoted payout (house edge math)
- Valid null models for last digits on Deriv synthetics
- What a Monte Carlo test **can** claim (p-values, stability) vs what traders wish it claimed (predict next digit)
- Multiple testing across 10 digits × many scans per day → false discovery control
- Bootstrap CI on frequencies: coverage, dependence from overlapping windows
- When “non-uniform looking” finite samples are expected under true uniform (χ² distribution)
- Computational: streaming / fewer trials / early exit MC without faking significance
- Recovery ladder ruin at ~90% hit rate still real

#### 2.2 Audit MonteCarloAnalyzer mathematically
1. `testRandomness` — what flags mean; does “non-uniform” imply tradable edge?
2. `runMonteCarlo` — null DGP; independence assumptions; seeded vs unseeded; bias
3. `scoreCandidates` — ranking rule; stability definition across resamples
4. Gate stack interactions (entropy, χ², confidence, stability, bootstrap width, recent hits, cooldown, hot filter)
5. How analysis output maps to barrier digit + live \(q_{be}\) / `mcMinEdge`
6. Prediction log / cooldown — prevents re-picking same digit; good or harmful?
7. Backtest path with MC disabled — are live results comparable?

#### 2.3 Brainstorm upgrade packages (pick one primary)
- **A. Statistically valid MC** — proper null, multiple-testing correction, calibrated confidence; default idle under null
- **B. Value-bet + light MC** — MC only as sanity/stability; main decision = live payout vs conservative pLoss
- **C. Risk-first** — recovery off/shallow; hard DD; enable calibrator; consecutive loss cooldown that matters
- **D. Performance MC** — adaptive trials, early abort, incremental stats, so 3s loop stays healthy
- **E. Backtest parity** — same gates live and backtest; live payout probe; null-sim report

Score reliability, statistical honesty, speed, single-file fit. **Implement primary (+ optional secondary).**

#### 2.4 Success criteria
- Under synthetic uniform digits, false-trade rate is controlled (report it)
- Live trades rare unless gates + value edge agree; skip reasons intelligible
- Recovery cannot 150× without explicit flag + hard cap
- Daily loss stop works
- BACKTEST report reflects the **same** decision logic as live (or documents intentional diffs)
- MC runtime acceptable on Windows Node for configured asset count

---

### PHASE 3 — Target design (ONE file)

```text
accurateDiffer3_monte-carlos.js
  0. deps + env helpers
  1. CONFIG (hardcoded credentials kept; safer risk + clearer MC knobs)
  2. logger + helpers
  3. TelegramNotifier
  4. RestClient + DerivClient
  5. MarketDataManager + quoteToDigit
  6. MonteCarloAnalyzer (or upgraded name) — pure-ish API
  7. TradeExecutor
  8. StatisticsManager + SymbolCalibrator + KellySizer / RiskPolicy
  9. TradingBot (value edge, rotation, pause, DOW, watchdog, MC skip bookkeeping)
 10. DifferBacktester
 11. main() + BACKTEST / optional --selftest-null
```

Principles: testable `analyze(digits)`; explicit null model comments; reason codes; single position writer; idempotent reconnect; feature flags.

---

### PHASE 4 — Implementation (in `accurateDiffer3_monte-carlos.js`)
1. **P0** reliability + ruin control (watchdog, reconnect, daily stop, tame recovery)
2. **P1** MC statistical correctness + gate honesty + live value-edge math
3. **P2** sizing/calibration defaults fit for testing
4. **P3** ops (Telegram, state, pause, DOW, rotation)
5. **P4** backtest parity + null selftest + perf of MC loop

---

### PHASE 5 — Validation
- Reason through: MC reject, MC accept but value-edge reject, full trade win/loss, recovery step, daily halt, reconnect
- BACKTEST with MC on and off; compare
- Null selftest: uniform random digits → low trade rate / ~0 edge after costs
- Demo checklist: small stake, log gate reasons, calibration of confidence vs outcomes, CPU OK

---

### PHASE 6 — Performance pass
- Profile `runMonteCarlo` cost vs `analysisIntervalMs` × `|assets|`
- Reduce trials adaptively, cache rolling counts, avoid full re-copy each scan
- Keep code readable in one file

---

### PHASE 7 — Handoff
Summary, run commands, CONFIG card (MC + risk), residual risks, demo protocol, **complete single-file source**.

---

## OUTPUT FORMAT (EVERY PHASE)

```markdown
## Phase N — Title
### Plugins/Skills used
### Research / brainstorm (if any)
### Findings (this file + external research only)
### Decisions
### Changes made
- single file: accurateDiffer3_monte-carlos.js — ...
### Risks / residual issues
### Next phase readiness
```

Final package: executive summary, how to run, parameter card, loss modes, demo protocol, full file.

---

## DEFAULTS (if user offline)
1. Goal: **statistical honesty + capital preservation** (idle is success under null)
2. Mode: **demo/test**
3. Prefer recovery **off or shallow** while measuring MC quality
4. Keep `maxOpenTrades: 1`
5. Single improved JS file

---

## FIRST ACTION
1. List plugins to use.
2. Phase 0 on **only** `accurateDiffer3_monte-carlos.js`.
3. Phase 1 reliability.
4. Phase 2 MC/research brainstorm; pick package.
5. Implement one-file re-engineering; credentials stay hardcoded.
6. Handoff.

**Start now with Phase 0.** No other bots. No multi-file split. No `.env` credential migration.

---

## APPENDIX — KNOWN SMELLS (hypotheses — verify)
1. Steep recovery ladder enabled by default
2. `minEdgeConfidence ≈ 0.476` may be weak
3. Unlimited weak-signal counter effectively
4. Backtest MC disabled by default → optimistic or incomparable offline results
5. MC “edge” under true uniform should be rare — if live is busy, suspect false positives
6. 10k sims × many symbols may stall analysis loop
7. Calibrator off → no live model feedback
8. Header ensemble description may drift from code — align docs with implementation
9. Hot filter / cooldown may interact badly with multi-asset rotation
10. Single-file ~3.5k LOC — reorganize sections, don’t split project

---

## DEFINITION OF DONE
- [ ] One runnable file: `node accurateDiffer3_monte-carlos.js`
- [ ] Hardcoded test credentials preserved
- [ ] No dependency on other bots
- [ ] Reliability P0s fixed
- [ ] MC logic statistically reasoned (null, gates, multiple testing) and/or simplified to honest value-bet
- [ ] Decision reason codes for MC + value + risk skips
- [ ] BACKTEST usable and documented vs live
- [ ] Safer risk defaults or explicit dangerous flags
- [ ] Honest edge statement under fair-digit null
- [ ] Correct idle when tests fail

**Remember:** A Monte Carlo engine that almost never fires on fair RNG is often **working**. A bot that always finds “stable edge” on synthetic digits is usually **overfitting or mis-testing**. Prefer valid inference and capital survival over trade frequency. Ship **one file**.
