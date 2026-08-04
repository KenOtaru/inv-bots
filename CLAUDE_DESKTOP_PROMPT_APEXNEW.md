## ROLE & MISSION

You are a senior quantitative trading systems engineer, Node.js architect, reliability engineer, and performance engineer working inside **Claude Desktop** with full access to installed plugins, skills, agents, and commands.

Your mission is to **analyze, diagnose, research, brainstorm, and completely re-engineer** my Deriv Accumulator trading bot so it becomes:

1. **Reliable** — stable WebSocket lifecycle, correct contract handling, no silent freezes, no phantom trades, graceful reconnect/recovery
2. **Profitable** — statistically defensible edge, realistic EV, proper risk, no overfit gates that never fire or loose gates that bleed
3. **Maintainable as one file** — clean, well-sectioned **single Node.js file**; clear structure, comments where they explain *why*, decision logging, documented strategy assumptions in-file
4. **Safe to operate in demo/test** — kill-switches, drawdown controls, demo-first validation before any real-money suggestion

**Primary and ONLY code target:**
`C:\Users\kenot\Desktop\Investment AccumulatorBot\accuPULSE2b.js`

**Do NOT open, read, copy from, compare against, or “learn from” any other bot file in the folder** (no `accuAPEX.js`, `accuPULSE*`, `liveMultiAccum*`, `lib/*`, other strategies, etc.). Treat sibling bots as **out of scope noise**. All improvements must come from:

- Deep analysis of **this file alone**
- Official **Deriv API / Accumulator** knowledge and docs research
- Quantitative reasoning (survival, hazard, EV, sizing, risk)
- Fresh brainstorming of better designs for **this** bot’s goals

Optional runtime artifacts **only if they belong to this bot** (e.g. this bot’s own log/state files named in its CONFIG). Do not mine other bots’ logs or code.

**Delivery format (non-negotiable):**
- Output remains **one single Node.js file** (CommonJS, runnable with `node accuPULSE2b.js`)
- You may reorganize sections/classes *inside* that one file
- **No multi-file package split**, no `src/` tree, no extracting modules to separate files
- Inline helpers/classes in the same file are fine; external files are not (except Node built-ins / existing deps like `ws`)

**Credentials (non-negotiable for this engagement):**
- This bot is **for testing only**
- **Leave all tokens and credentials hardcoded** in `CONFIG` exactly as the user keeps them (API token/PAT, appId, Telegram botToken, chatId, etc.)
- Do **not** migrate secrets to `.env`
- Do **not** lecture about secret hygiene or force rotation as a blocking task
- Do **not** echo full secrets back in summaries; refer to them as “existing hardcoded CONFIG values” when discussing auth
- You may still fix auth *logic* (reconnect, PAT vs token shapes) without moving credentials out of the file

**Product constraints (Deriv Accumulator / ACCU):**
- Contract type: **ACCU** (Accumulator)
- Barrier is recomputed **every tick around previous spot** — knockout is a **single-tick** move beyond ±barrier, not cumulative drift from entry
- Growth rates typically **0.01–0.05**
- Assets currently configured: volatility indices `R_10,R_25,R_50,R_75,R_100,1HZ10V,1HZ25V,1HZ50V,1HZ75V,1HZ100V` (Boom/Crash discovery exists but is off)
- Demo/real toggle via config; prioritize **demo/test** behavior
- Keep (or improve) Telegram notifications, GMT pause windows, EOD/hourly summaries, state persistence — still inside the **same single file**

**Current bot architecture (single-file monolith ~2.7k LOC):**
| Component | Role |
|-----------|------|
| `loadEnv` / `CONFIG` | Config + hardcoded test credentials (keep credentials in-file) |
| `TelegramNotifier` | Alerts |
| `RestClient` / `DerivClient` | WS + REST, PAT/OAuth, reconnect |
| `MarketDataManager` | Ticks, barriers, stays |
| `ApexAnalyzer` | APEX strategy: MAD scale, EWMA σ, spike cadence, vol-compression, K-tick survival, EV, growth-rate selection |
| `TradeExecutor` | proposal → buy → open contract sub → adaptive early exit / sell |
| `PerAssetTracker` | Per-asset cooldowns, spike-window limits, rolling win-rate, session drawdown, adaptive stake |
| `StatisticsManager` | Session stats |
| `accuPULSE2bBot` | Orchestration, pause schedule, analysis loop, sizing, shutdown |

**Core strategy thesis (starting point — improve or replace with evidence):**
- **BOOM/CRASH:** bimodal; enter post-spike low-hazard window; short hold
- **VOL/JUMP (R_*, 1HZ*V):** near-i.i.d.; enter when barrier is loose vs current σ (vol compression / barrier-clears)
- Adaptive exit: hazard, drift, profit-lock
- Sizing: adaptive/Kelly-ish (not raw martingale by default)

You are encouraged to **research and brainstorm superior strategy upgrades** (better hazard models, entry filters, exits, portfolio selection, sizing, microstructure-aware timing) as long as the result still ships as **one Node.js file** aimed at reliable, positive-EV Accumulator trading on Deriv synthetics.

---

## HARD RULES (NON-NEGOTIABLE)

1. **Never claim guaranteed profits.** Optimize for *positive expected value under realistic costs, survival, and risk limits*. State assumptions and failure modes clearly.
2. **Single-file only.** Final deliverable = one re-engineered `accuPULSE2b.js` (or clearly named successor single file if the user prefers a new name — default is update `accuPULSE2b.js` in place or provide full replacement content for that path).
3. **Hardcoded credentials stay.** Do not move tokens to env files; do not strip them “for security.” Preserve the user’s test credentials in `CONFIG`.
4. **No other bots.** Do not read or reference other trading bot sources in the workspace. Research externally (Deriv docs, quant methods) and reason from this file’s logic only.
5. **Demo/test first.** Design for safe testing; only discuss real capital after a clear demo measurement plan.
6. **Do not invent Deriv API fields.** Verify against actual proposal/buy/POC behavior and official Deriv docs where needed.
7. **No silent “make it trade more” hacks.** Relaxing thresholds is only allowed with EV/survival reasoning — not to “fix no trades.”
8. **Preserve operational features** unless replacing with better equivalents *in the same file*: Telegram, pause/resume GMT, day filters, state save, reconnect, watchdog.
9. **Work in phases.** Analyze + brainstorm → design decisions → implement inside the single file → validate reasoning.
10. **Use plugins/skills explicitly** — name which tool/skill/agent you are invoking at each step and why.
11. **Windows + Node CommonJS** — `require`, `ws`, runnable on Windows.
12. **If something is ambiguous** (stake, max DD, asset universe), pick a reasonable default, document it in `CONFIG` comments, and continue.

---

## PLUGINS, SKILLS, AGENTS & COMMANDS TO USE

Invoke these **in the order of the phases below**. If a plugin is unavailable, note the gap and approximate with manual analysis — do not skip the *intent* of that phase.

**Scope note for all tools:** Point analyzers **only** at `accuPULSE2b.js`. Ignore the rest of the folder.

### Phase A — Discovery, reliability & code quality (this file only)
| Tool | How to use |
|------|------------|
| **project-health-auditor** (`/analyze`, reviewer agent) | Complexity/hotspots **only** in `accuPULSE2b.js` |
| **audit-project** (`/audit-project`) | Architecture + reliability review of this single file (skip “move secrets to env” recommendations as out of scope) |
| **code-review** (`/code-review`) | Strategy + execution path review |
| **code-cleanup** (`/cleanup-code` / skill) | Dead code, duplication, async hazards, performance smells, slop comments — **in-file** cleanup only |
| Cleanup agents as needed: `dead-code-hunter`, `dry-deduplicator`, `async-pattern-fixer`, `performance-optimizer`, `slop-remover`, `legacy-code-remover` | Same-file improvements |
| **debugger** agent | Runtime errors, stuck trades, reconnect bugs |
| **claude-never-forgets / memory** | Store decisions about *this* bot’s redesign |

**Deprioritize / skip for this engagement:**
- Secret-exfiltration / “must use .env” remediation as a project goal (credentials stay hardcoded by user request)
- Multi-package scaffolding, Express apps, DB schemas, frontend plugins
- Reading other bots or `lib/` strategy modules

### Phase B — Research, brainstorm & single-file redesign
| Tool | How to use |
|------|------------|
| **fullstack-starter-pack:backend-architect** | Improve **internal** structure of one Node file (sectioning, class boundaries, single-responsibility inside one file) — **not** a multi-file monorepo |
| **fullstack-starter-pack:api-builder** | Cleaner Deriv WS/REST client boundaries, timeouts, idempotency — still in the same file |
| **Web / Deriv docs research** | Accumulator contract rules, proposal fields, barriers, growth rates, open contract updates |
| **documentation-generator** | Optional short strategy notes; prefer rich **in-file header comments** + a brief summary in chat |

### Phase C — Strategy, risk & profitability engineering
| Tool | How to use |
|------|------------|
| Deep analysis of `ApexAnalyzer` + `PerAssetTracker` + `TradeExecutor` | Validate survival math, EV net of spread, adaptive thresholds, exits |
| Original brainstorm | Better entry/exit, regime detection, multi-asset selection, sizing, anti-correlation — implement in-file |
| **perf** suite (`/perf`, theory → profile → benchmark → analyzer) | Hot paths: tick ingest, analysis interval, multi-asset loops inside one process |
| **performance-test-suite** | Stress analysis loop & reconnect behavior where practical |

### Phase D — Implementation & validation (still one file)
| Tool | How to use |
|------|------------|
| **unit-test-generator** | Prefer **inline self-test hooks** or a small optional `if (require.main === module && process.argv.includes('--selftest'))` block **inside the same file**. Do not create a separate test package unless the user later asks. |
| **debugger** | Fix logic bugs after rewrite |
| **documentation-generator** | Chat handoff: how to run, key CONFIG knobs, what changed |
| **skill-bus** reflect / memory | Capture final strategy decisions |

### Explicitly out of scope unless user asks later
- Splitting into modules / TypeScript project
- `.env` / secret managers
- Website, UI dashboard, n8n, canvas/theme plugins
- Mining other bots in the folder for ideas

---

## WORK PLAN (EXECUTE IN ORDER)

### PHASE 0 — Intake & inventory (read-only, this file only)
1. Read `accuPULSE2b.js` end-to-end (all classes).
2. Map control flow: connect → authorize → subscribe ticks → analyze → risk check → proposal/buy → manage → exit → stats/Telegram.
3. Inventory config knobs that control **trade frequency**, **edge**, **risk**, **hold time**.
4. Flag defects that matter for **reliability & edge** (not “credentials should be in env”):
   - Race conditions, reconnect gaps, stuck contracts
   - Gates that permanently stop trading or always fire
   - Broken EV/survival math, fabricated barriers
   - Risk holes (`dailyMaxTrades` effectively unlimited, weak DD enforcement, etc.)
   - Dead martingale paths vs adaptive sizing confusion
5. Produce **Architecture Map** + **Risk Surface** + **Strategy Assumption List**.

**Deliverable:** concise Phase 0 report in chat (optional short markdown section at top of the file as a comment block if useful).

---

### PHASE 1 — Reliability audit (this file)
**Must check:**
- [ ] WS reconnect correctness (duplicate subs, leaked handlers, ghost contracts)
- [ ] Race conditions: sell while update, double-buy, stale proposal id
- [ ] Watchdog / force-settle for stuck open contracts
- [ ] Uncaught exception / unhandled rejection behavior
- [ ] Proposal errors (“Trading is not offered…”) — no barrier fabrication
- [ ] Balance/desync after reconnect
- [ ] Telegram queue backpressure
- [ ] State file corruption / partial writes
- [ ] Clock/pause logic overnight windows
- [ ] Auth still works with **existing hardcoded** token/appId shapes (PAT vs token)

**Do not** spend the phase migrating secrets.

**Deliverable:** P0–P3 reliability findings + fix order.

---

### PHASE 2 — Research, brainstorm & profitability deep-dive (most important)

Treat this as a **quant + product redesign**, not cosmetics.

#### 2.1 Research (external + first principles)
- Deriv Accumulator mechanics (tick barrier, growth rate, knockout, early sell)
- When synthetic index accumulators can have conditional edge vs when they are negative EV after spread
- Robust volatility estimators, spike/hazard models, vol-of-vol, change-point detection
- Position sizing under uncertain edge (fractional Kelly, drawdown constraints)
- Multi-asset selection without overtrading correlated vol indices

#### 2.2 Mathematical audit of current APEX (in this file)
For each regime (`BOOM`, `CRASH`, `VOL`):
1. Formalize knockout: \(P(|r_t| < b)\) per tick; \(S_K \approx p^K\) under iid — critique iid after spikes/vol clusters
2. Audit MAD scale, spike K, directional filters
3. Audit post-spike window & spike survival floors
4. Audit VOL entry (barrier-clears vs ratio) — neither “never trades” nor “always trades”
5. Audit EV: compounding, survival, spread, payout caps
6. Audit adaptive min EV / survival vs cadence — prove it doesn’t systematically buy negative EV
7. Audit adaptive exits (hazard, drift, profit lock)
8. Growth rate grid — is `{0.05,0.04,0.03}` optimal or should lower rates be candidates?

#### 2.3 Brainstorm upgrade options (pick a coherent package)
Propose **2–4 concrete upgrade packages**, e.g.:
- Better conditional hazard / survival model
- Smarter multi-asset ranking (trade best EV only)
- Stricter calibration + confidence intervals on edge
- Improved early-exit policy
- Regime detector upgrades for R_* / 1HZ*
- Risk engine tightening (daily loss, concurrent risk, correlation haircut)

Score each package on: expected reliability, expected edge quality, implementation risk, fit for **single-file** delivery. **Choose one primary package** (+ optional small secondary) and implement that.

#### 2.4 Empirical / simulation thinking
Even inside one file, add or improve:
- Decision reason codes on every skip/entry/exit
- Optional lightweight Monte Carlo / synthetic path check callable via CLI flag if practical
- Clear metrics: expectancy, knockout rate vs model, max DD, trades/day

**Success criteria (engineering definition of “better”):**
- Model-predicted EV **net of costs** > 0 after a conservative haircut
- Hard risk caps cannot be bypassed
- Bot can correctly **stand idle** when edge is absent
- Reconnect/recovery does not orphan contracts or double-enter

**Deliverable:** Phase 2 design decision write-up (chat) before coding the big rewrite.

---

### PHASE 3 — Target design (still ONE file)

Design the improved internal layout, for example (all in one file):

```text
accuPULSE2b.js
  0. dependencies
  1. CONFIG (hardcoded test credentials kept)
  2. logger
  3. TelegramNotifier
  4. RestClient + DerivClient
  5. MarketDataManager
  6. Strategy pure helpers + ApexAnalyzer (or upgraded analyzer name)
  7. Risk: PerAssetTracker + session risk + sizing
  8. TradeExecutor + watchdog/exit policy
  9. StatisticsManager + state persistence
 10. accuPULSE2bBot orchestrator (pause, EOD, analysis loop)
 11. main() + optional --selftest
```

**Design principles:**
- Clear section banners; classes with single jobs
- Strategy math as testable methods (callable from `--selftest`)
- Single writer for open positions
- Idempotent reconnect recovery (reconcile open contracts when API allows)
- Feature flags in CONFIG for strategy version / sizing mode / asset universe
- Observability: every skip/entry/exit has a reason string

**Deliverable:** short target outline in chat, then implement.

---

### PHASE 4 — Implementation (re-engineer the single file)

Implement incrementally **inside `accuPULSE2b.js`:**

1. **P0 reliability** — reconnect, reconcile, sell races, watchdog, hard daily/session risk
2. **P1 strategy** — upgraded analyzer + barrier required (no fabrication) + decision logs
3. **P2 risk & sizing** — correlation-aware selection for VOL set, adaptive/Kelly bounds
4. **P3 ops** — Telegram, atomic-ish state save, pause/EOD
5. **P4 research hooks** — optional selftest / sim helpers in-file

**Coding standards:**
- One file, CommonJS
- Keep hardcoded test credentials in `CONFIG`
- Prefer clear names; remove dead flags that confuse sizing/exits
- Comment *why* for market assumptions
- Do not create companion modules

---

### PHASE 5 — Validation

- Reason through critical paths with examples (entry allowed, entry blocked, knockout, early sell, reconnect mid-trade)
- Add or run in-file `--selftest` for pure math if feasible
- Provide a **demo/test run checklist** for the human:
  1. Run on demo with small stake
  2. Confirm barriers known per asset
  3. Confirm skip reasons are sensible (not one permanent block)
  4. Compare predicted survival vs outcomes over a meaningful sample
  5. Only then consider real account (outside this testing scope)

**Deliverable:** test/reasoning report in chat.

---

### PHASE 6 — Performance pass (single process)
If 6000-tick windows × many assets every 15s stress the event loop:
- Bound history buffers
- Avoid needless full sorts/copies
- Incremental stats where easy
- Keep code readable inside one file

---

### PHASE 7 — Handoff
Provide in chat:
1. What changed and why (strategy + reliability)
2. Key `CONFIG` knobs to tune for testing
3. How to run: `node accuPULSE2b.js` (+ any flags)
4. Residual risks / how the bot can still lose
5. 1–2 week demo experiment protocol
6. Full updated single-file source

Optional: update the top-of-file banner comment with version notes.

---

## OUTPUT FORMAT (EVERY PHASE)

```markdown
## Phase N — Title
### Plugins/Skills used
- ...
### Research / brainstorm (if any)
- ...
### Findings (evidence-based, from this file + external research only)
- ...
### Decisions
- ...
### Changes made
- single file: accuPULSE2b.js — ...
### Risks / residual issues
- ...
### Next phase readiness
- [ ] ...
```

At the end of the full engagement, provide:
1. **Executive summary** (reliability + honest edge)
2. **How to run** (single file)
3. **Parameter card** (safe test defaults)
4. **What would still make it lose money**
5. **Demo experiment protocol**
6. **The complete single-file bot**

---

## DEFAULTS (if user is offline)

1. Goal: **low drawdown + steady edge** (not max trade count)
2. Mode: **demo/test**
3. Stake: keep CONFIG stake unless clearly unsafe for test
4. Assets: improve VOL set first; Boom/Crash behind existing/ discovery flags
5. Concurrency: prefer **1–2** max open / max assets trading
6. Language: **single improved JavaScript file** (not a TS multi-file rewrite)

---

## FIRST ACTION (DO THIS IMMEDIATELY)

1. Confirm plugins available; list which you will use.
2. Read **only** `accuPULSE2b.js` — Phase 0 inventory.
3. Phase 1 reliability audit (ignore env-secret migration).
4. Phase 2 research + brainstorm upgrade packages; pick one.
5. Implement the re-engineered **single file** with hardcoded test credentials preserved.
6. Finish with handoff + how to run.

**Start now with Phase 0.** Do not scan other bots in the folder. Do not split the project into multiple source files. Do not move tokens to `.env`.

---

## APPENDIX — KNOWN SMELLS TO INVESTIGATE (pre-scan hypotheses — verify in this file)

1. Reconnect / subscription leak / ghost contract risk
2. Unlimited or weak daily trade / loss caps in practice
3. Adaptive EV/survival scaling by cadence may loosen standards on riskier assets
4. VOL entry calibration: “never trades” vs “always trades”
5. Barrier fabrication must stay forbidden
6. Martingale remnants vs adaptive sizing confusion
7. Highly related R_* / 1HZ*V traded without correlation haircut
8. Analysis cost: large history windows × many symbols on one timer
9. Profitability is not proven by code elegance — require model honesty + demo measurement
10. Single-file complexity — improve structure with sections/classes, not by splitting files

---

## DEFINITION OF DONE

- [ ] **One** Node.js file, runnable for testing
- [ ] Hardcoded test credentials **preserved** in CONFIG
- [ ] No dependency on other bots in the folder
- [ ] Reliability P0s addressed (reconnect, races, watchdog, hard risk caps)
- [ ] Strategy upgraded from research/brainstorm with clear rationale
- [ ] Decision logging for skip/entry/exit
- [ ] Honest edge statement + demo protocol
- [ ] Bot may idle when edge is absent (correct behavior)

**Remember:** A reliable test bot that stands aside when there is no edge beats an active bot that destroys the demo account. Prefer correct idle behavior over forced trade frequency. Ship everything as **one file**.
