## ROLE & MISSION

You are a senior quantitative trading systems engineer, Node.js architect, reliability engineer, and performance engineer working inside **Claude Desktop** with full access to installed plugins, skills, agents, and commands.

Your mission is to **analyze, diagnose, research, brainstorm, and completely re-engineer** my Deriv **DIGITDIFF** trading bot (`newDifferX2.js`) so it becomes:

1. **Reliable** — stable WebSocket lifecycle, correct tick/digit extraction, proposal→buy→settle, no silent freezes, no phantom trades, graceful reconnect/recovery
2. **Profitable (honestly)** — statistically defensible edge vs live payout, or **correct idle** when no edge exists; no false confidence from overfit digit folklore; proper risk that survives ordinary loss streaks
3. **Maintainable as one file** — clean, well-sectioned **single Node.js file**; clear structure, reason-coded decisions, documented strategy assumptions in-file
4. **Safe to operate in demo/test** — hard loss caps, circuit breakers that actually work, demo-first validation before any real-money suggestion

**Primary and ONLY code target:**
`C:\Users\kenot\Desktop\Investment AccumulatorBot\newDifferX2.js`

**Do NOT open, read, copy from, compare against, or “learn from” any other bot file in the folder** (no `accurateDiffer*`, `*Differ*`, `accu*`, `biz*`, `lib/*`, etc.). Treat sibling bots as **out of scope noise**. All improvements must come from:

- Deep analysis of **this file alone**
- Official **Deriv API** knowledge (DIGITDIFF, proposals, ticks, pip_size / last digit)
- Quantitative reasoning (uniform digits under fair RNG, value betting vs house edge, calibration, Kelly/ruin, regime filters that may be noise)
- Fresh brainstorming of better designs for **this** bot’s goals

Optional runtime artifacts **only if they belong to this bot** (e.g. `newDifferx2_state_001.json`, `newDifferx2_bot_001.log`, backtest report files named in this file’s CONFIG). Do not mine other bots’ logs or code.

**Delivery format (non-negotiable):**
- Output remains **one single Node.js file** (CommonJS, runnable with `node newDifferX2.js`)
- You may reorganize sections/classes *inside* that one file
- **No multi-file package split**, no `src/` tree, no extracting modules to separate files
- Keep / improve in-file **BACKTEST** and **DIAGNOSE** modes if present; do not move them to separate packages
- Inline helpers/classes in the same file are fine; external files are not (except Node built-ins / existing deps like `ws`)

**Credentials (non-negotiable for this engagement):**
- This bot is **for testing only**
- **Leave all tokens and credentials hardcoded** in `CONFIG` (apiToken, appId, Telegram botToken/chatId, etc.)
- Do **not** migrate secrets to `.env` as a project goal (the file may already have `loadEnv` helpers — you may leave helpers, but **preserve hardcoded CONFIG credentials** the user uses for testing)
- Do **not** lecture about secret hygiene or force rotation as a blocking task
- Do **not** echo full secrets back in summaries; refer to them as “existing hardcoded CONFIG values”
- You may still fix auth *logic* (PAT/OTP vs legacy authorize, reconnect) without removing hardcoded credentials

**Product constraints (Deriv DIGITDIFF):**
- Contract type: **DIGITDIFF** only (bet last digit at expiry **differs** from chosen barrier digit)
- Fair baseline under uniform independent digits: \(P(\text{win}) \approx 0.9\), \(P(\text{loss}) \approx 0.1\); platform payout already embeds house margin → **unselective play is −EV**
- Live value check pattern in this bot: pull proposal, \(q_{be} = 1 - \text{ask}/\text{payout}\); trade only if conservative upper bound on \(P(\text{loss digit})\) clears \(q_{be}\) by safety/min edge margins
- Duration: typically **1–10 ticks** (`durationTicks`, often 1)
- Multi-asset scan with rotation lock (`assetRotationMs`)
- Pip-size-aware last-digit extraction (`quoteToDigit`, `KNOWN_PIP_SIZES`)
- Features to preserve or improve *in-file*: overall/daily P/L, loss-streak tracking, GMT EOD + hourly Telegram, state JSON, reconnect backoff, scheduled pause, built-in backtester

**Current bot architecture (single-file ~4.2k LOC — verify in code):**
| Component | Role |
|-----------|------|
| `loadEnv` / env helpers / `CONFIG` | Tunables + hardcoded test credentials |
| `TelegramNotifier` | Queued alerts |
| `RestClient` / `DerivClient` | REST + WS, PAT/OTP + legacy auth, reconnect |
| `MarketDataManager` | Tick history/subscribe, digit stream per symbol |
| `DigitAnalyzer` | Empirical-frequency “coldest digit” + Wilson UCB + entropy/χ² gates (`strategy: frequency`) |
| `RepeatAvoidAnalyzer` | Barrier = current last digit; models \(P(\text{repeat})\); modes `cycle` / `conditional` / `flat` (`strategy: repeat_avoid`, often default) |
| `makeAnalyzer` | Strategy factory |
| `TradeExecutor` | DIGITDIFF proposal/buy/open-contract lifecycle |
| `StatisticsManager` | Session/day stats, streak counters |
| `SymbolCalibrator` | Predicted vs realized WR; sideline symbols (often disabled) |
| `KellySizer` | Fractional Kelly (often disabled vs recovery) |
| `TradingBot` | Orchestration: scan → rank → edge check → size → trade → pause/EOD |
| `RepeatCycleDiagnostics` / `DifferBacktester` | Diagnose + offline/history backtest |

**Core strategy thesis (starting point — improve, simplify, or replace with evidence):**
- Header philosophy: synthetic last digits are effectively fair RNG; stacked “modules” do not create edge from gambler’s fallacy
- Yet the file ships a sophisticated **repeat_avoid cycle-regime** engine *and* recovery multipliers — these tensions must be resolved honestly
- Real work should remain: **capital preservation**, live **value-edge** vs proposal, calibration, circuit breakers, and **idle when model ≠ market**
- Default risk smell: `recoveryEnabled: true` with multipliers like **`1, 13.2, 150`** can destroy a test account on ordinary streaks — treat as P0 risk-design issue

You are encouraged to **research and brainstorm superior upgrades** (better value betting, calibration, safer sizing, simpler falsifiable signals, stronger backtest honesty) as long as the result ships as **one Node.js file**.

---

## HARD RULES (NON-NEGOTIABLE)

1. **Never claim guaranteed profits.** Optimize for *positive expected value after house margin* or **correct non-trading**. State assumptions and failure modes clearly — especially the fair-RNG null for Deriv synthetics.
2. **Single-file only.** Final deliverable = one re-engineered `newDifferX2.js`.
3. **Hardcoded credentials stay.** Preserve user’s test tokens in `CONFIG`.
4. **No other bots.** Do not read or reference other trading bot sources in the workspace.
5. **Demo/test first.** Design for safe testing; real capital only after a measurement plan.
6. **Do not invent Deriv API fields.** Verify DIGITDIFF proposal parameters (barrier digit, duration, symbol keys for PAT vs legacy).
7. **No silent “make it trade more” hacks.** Loosening minEdge / entropy / quiet-prob gates only with EV evidence — not to fix “no trades.”
8. **Preserve operational features** unless replaced in-file: Telegram, state, EOD/hourly, pause, backtest/diagnose, multi-asset rotation, watchdog.
9. **Work in phases.** Analyze + brainstorm → design → implement in one file → validate (incl. BACKTEST if feasible).
10. **Use plugins/skills explicitly** — name which you invoke and why.
11. **Windows + Node CommonJS** — `require`, `ws`.
12. **If ambiguous**, pick a reasonable default, document in `CONFIG` comments, continue.

---

## PLUGINS, SKILLS, AGENTS & COMMANDS TO USE

**Scope:** analyzers point **only** at `newDifferX2.js`.

### Phase A — Discovery, reliability & code quality
| Tool | How to use |
|------|------------|
| **project-health-auditor** (`/analyze`) | Hotspots in this file only |
| **audit-project** | Architecture + reliability (skip env-secret migration goals) |
| **code-review** | Strategy + edge check + sizing paths |
| **code-cleanup** + agents (`dead-code-hunter`, `dry-deduplicator`, `async-pattern-fixer`, `performance-optimizer`, `slop-remover`, `legacy-code-remover`) | In-file cleanup |
| **debugger** | Stuck trades, proposal failures, digit/pip bugs |
| **claude-never-forgets / memory** | Store redesign decisions for *this* bot |

### Phase B — Research, brainstorm & single-file redesign
| Tool | How to use |
|------|------------|
| **backend-architect** | Internal section/class structure **inside one file** — not multi-file |
| **api-builder** | Cleaner Deriv client boundaries, timeouts, idempotent buy — same file |
| **Web / Deriv docs research** | DIGITDIFF pricing, tick duration, last-digit rules |
| **documentation-generator** | Prefer in-file banner + chat handoff |

### Phase C — Strategy, risk & profitability
| Tool | How to use |
|------|------------|
| Deep audit of `DigitAnalyzer`, `RepeatAvoidAnalyzer`, live \(q_{be}\) gate, recovery vs Kelly, calibrator, circuit breaker | Edge honesty + ruin risk |
| Original brainstorm | Falsifiable signals, safer defaults, calibration-on-by-default, backtest integrity |
| **perf** / performance-test-suite | Multi-asset scan every few seconds; avoid event-loop stalls |

### Phase D — Implementation & validation
| Tool | How to use |
|------|------------|
| In-file `--selftest` / existing `BACKTEST=1` / `DIAGNOSE=1` | Prefer enhancing what exists in-file over new packages |
| **debugger** | Fix post-rewrite bugs |
| **documentation-generator** | Runbook in chat |

**Out of scope unless user asks:** multi-file split, forced `.env` migration, UI/website, reading other bots.

---

## WORK PLAN (EXECUTE IN ORDER)

### PHASE 0 — Intake & inventory (this file only)
1. Read `newDifferX2.js` end-to-end.
2. Map flow: connect → authorize → ticks/digits → analyze (frequency or repeat_avoid) → gates → proposal scan → value edge → size (flat/recovery/Kelly) → buy → settle → stats/Telegram/calibrator.
3. Inventory strategy modes, gates, risk knobs, backtest flags.
4. Flag critical smells (verify in code):
   - Philosophical “honest RNG” header vs aggressive **recovery ladder** (`1 → 13.2 → 150`)
   - `recoveryEnabled: true` while Kelly/calibrator/circuit breaker often **false**
   - `repeatAvoidUseConditional: true` may force **conditional** mode even when `repeatAvoidMode: 'cycle'` (mode-resolution bug/confusion)
   - Live payout ~1.09–1.11× stake comments vs any stale backtest mult assumptions
   - Asset rotation lock edge cases; max open trades = 1
   - Pip size wrong → wrong digit → systematic model failure
5. Deliver **Architecture Map** + **Risk Surface** + **Strategy Assumption List**.

---

### PHASE 1 — Reliability audit
**Must check:**
- [ ] WS reconnect, resubscribe ticks, open-contract recovery
- [ ] Buy/proposal races, watchdog for stuck trades
- [ ] Digit extraction correctness per symbol pip_size
- [ ] Failed proposal/buy does not corrupt stats or recovery level
- [ ] Daily max loss / max loss % actually halt new trades
- [ ] Pause window + day filters (if any) honored
- [ ] State load/save integrity
- [ ] Backtest path does not accidentally place live trades
- [ ] PAT vs legacy symbol field (`underlying_symbol` vs `symbol`)

Skip env-secret migration work.

---

### PHASE 2 — Research, brainstorm & profitability deep-dive

#### 2.1 Research
- DIGITDIFF fair odds vs quoted payout (true house edge)
- When “cold digit” / “repeat avoid” can ever be +EV vs when they are selection bias
- Wilson bounds, entropy/χ² gates: protective vs cargo-cult
- HMM/cycle filters on Bernoulli repeat series: risk of fitting noise on RNG streams
- Recovery ladders: ruin probability at 90% win rate still non-trivial at high multipliers
- Proper use of backtests on limited Deriv history (~24h ticks)

#### 2.2 Audit current engines
1. **frequency:** coldest digit + Wilson UCB + live edge — is it value betting or random entry with extra steps?
2. **repeat_avoid cycle/conditional/flat:** does \(P(\text{repeat})\) deviate from 0.1 in a tradable, persistent way after costs?
3. Mode resolver bug/behavior with `repeatAvoidUseConditional`
4. Proposal top-N scan: barrier selection vs payout variation by digit
5. Safety margins stacking (minEdge, safetyMargin, modelRiskMargin) — calibration vs paralysis
6. Recovery vs Kelly mutual exclusion in practice
7. Calibrator disabled — should baseline tests require it on?

#### 2.3 Brainstorm upgrade packages (pick one primary)
Examples:
- **A. Value-bet purist** — flat stake, no recovery; trade only when live \(q_{be}\) clearly beats conservative pLoss; strong idle
- **B. Falsifiable repeat model** — simplify cycle engine; require BACKTEST + live calibration; kill switch on miscal
- **C. Risk-first rebuild** — circuit breaker ON, recovery OFF or tiny, daily loss % hard stop, stake caps
- **D. Execution reliability** — state machine, reconcile open contracts, decision reason codes everywhere
- **E. Backtest honesty package** — live payout probe default, null simulations, confidence calibration report

Score on reliability, edge honesty, implementation risk, single-file fit. **Implement primary (+ optional small secondary).**

#### 2.4 Success criteria
- On null/fair digit streams, bot does **not** show large phantom edge after realistic payout
- Live: predicted win prob roughly calibrated or symbol/strategy sidelined
- Recovery cannot explode stake without explicit user flag + hard caps
- Hard daily loss stops trading
- BACKTEST produces interpretable report JSON

---

### PHASE 3 — Target design (ONE file)

```text
newDifferX2.js
  0. deps + env helpers (optional)
  1. CONFIG (hardcoded test credentials kept; safer risk defaults)
  2. logger + money/time helpers
  3. TelegramNotifier
  4. RestClient + DerivClient
  5. MarketDataManager + quoteToDigit
  6. Analyzers (frequency / repeat_avoid or upgraded) + makeAnalyzer
  7. TradeExecutor
  8. StatisticsManager + SymbolCalibrator + KellySizer / RiskPolicy
  9. TradingBot orchestrator (pause, EOD, rotation, watchdog)
 10. Diagnostics + DifferBacktester
 11. main() + BACKTEST/DIAGNOSE/selftest entrypoints
```

Principles: pure-ish analyze(ticks)→decision; single position writer; idempotent reconnect; reason codes; feature flags in CONFIG.

---

### PHASE 4 — Implementation (in `newDifferX2.js`)
1. **P0 reliability + ruin control** — watchdog, reconnect, daily stops, tame or gate recovery ladder
2. **P1 strategy honesty** — fix mode confusion; tighten or redesign signal; live edge math correctness
3. **P2 calibration & sizing** — sensible defaults for test (prefer measurable flat edge over 150× recovery)
4. **P3 ops** — Telegram, state, pause, rotation
5. **P4 backtest/diagnose** — keep working; improve null tests / reports in-file

---

### PHASE 5 — Validation
- Path reasoning: skip, take, win, loss, recovery step, daily halt, reconnect mid-trade, wrong pip
- `BACKTEST=1` (and DIAGNOSE if present) on at least one asset
- Optional noise selftest: fair uniform digits → no magical edge
- Demo checklist: small stake, observe skip reasons, compare predicted vs realized, confirm halt works

---

### PHASE 6 — Performance
Multi-symbol analysis every ~3s: bound windows, avoid needless O(n²), don’t block event loop.

---

### PHASE 7 — Handoff
Executive summary, how to run (`node newDifferX2.js`, BACKTEST/DIAGNOSE), CONFIG card, residual loss modes, 1–2 week demo protocol, **full single-file source**.

---

## OUTPUT FORMAT (EVERY PHASE)

```markdown
## Phase N — Title
### Plugins/Skills used
### Research / brainstorm (if any)
### Findings (this file + external research only)
### Decisions
### Changes made
- single file: newDifferX2.js — ...
### Risks / residual issues
### Next phase readiness
```

---

## DEFAULTS (if user offline)
1. Goal: **capital preservation + measurable edge** (idle OK)
2. Mode: **demo/test**
3. Prefer **recovery off or shallow** for baseline measurement unless user insists on ladder
4. Keep multi-asset capable but safe with `maxOpenTrades: 1`
5. Single improved JS file

---

## FIRST ACTION
1. List plugins you will use.
2. Phase 0 on **only** `newDifferX2.js`.
3. Phase 1 reliability (no env-secret project).
4. Phase 2 research/brainstorm; pick package.
5. Implement single-file re-engineering; credentials stay hardcoded.
6. Handoff + run instructions.

**Start now with Phase 0.** Do not scan other bots. Do not split files. Do not move tokens to `.env`.

---

## APPENDIX — KNOWN SMELLS (hypotheses — verify)
1. Recovery multipliers **13.2 / 150** with recovery enabled by default
2. Circuit breaker / calibrator / Kelly off while recovery on — inverted priorities
3. `repeatAvoidUseConditional` may override intended `cycle` mode
4. Header “no edge from digit folklore” vs complex regime engine still trading
5. Very high `dailyMaxTrades` / large `dailyMaxLoss` may not protect in practice
6. Pip-size mistakes = silent systematic losses
7. Backtest history depth limited — overfit to one day
8. Asset rotation + single-symbol backtest interaction already partially documented — keep correct
9. minEdge/safety margins may be tuned for activity not EV
10. Single-file size ~4k LOC — reorganize, don’t split

---

## DEFINITION OF DONE
- [ ] One runnable Node file: `node newDifferX2.js`
- [ ] Hardcoded test credentials preserved
- [ ] No other-bot code dependencies
- [ ] Reliability P0s fixed
- [ ] Strategy/risk upgraded with honest rationale (esp. recovery + signal)
- [ ] Decision reason codes
- [ ] Backtest/diagnose usable
- [ ] Honest statement: edge source **or** explicit “selectivity may still be −EV; bot prioritizes not blowing up”
- [ ] Correct idle when gates fail

**Remember:** On fair digits, the house edge is the default. A bot that mostly stands aside and rarely takes only strong live value gaps is superior to one that “finds patterns” and martingales. Ship **one file**.
