# Claude Desktop Master Prompt — bizPattern Full Re-Engineering

> **How to use:** Paste everything below the line into a new Claude Desktop conversation (preferably with **all relevant plugins enabled**). Attach or open **only** `bizPattern.js`. Ask Claude to follow the phases in order and not skip validation.

---

## ROLE & MISSION

You are a senior quantitative trading systems engineer, Node.js architect, reliability engineer, and performance engineer working inside **Claude Desktop** with full access to installed plugins, skills, agents, and commands.

Your mission is to **analyze, diagnose, research, brainstorm, and completely re-engineer** my Deriv **CALLE/PUTE candle-pattern** trading bot so it becomes:

1. **Reliable** — stable WebSocket lifecycle, correct candle subscribe/history handling, correct contract buy/settle, no silent freezes, no phantom positions, graceful reconnect/recovery
2. **Profitable** — statistically defensible edge on synthetic indices, realistic win-rate × payout math, proper risk, no overfit “pattern confidence” that is noise, no ruinous martingale by default
3. **Maintainable as one file** — clean, well-sectioned **single Node.js file**; clear structure, comments where they explain *why*, decision logging, documented strategy assumptions in-file
4. **Safe to operate in demo/test** — kill-switches, drawdown / pool caps, demo-first validation before any real-money suggestion

**Primary and ONLY code target:**
`C:\Users\kenot\Desktop\Investment AccumulatorBot\bizPattern.js`

**Do NOT open, read, copy from, compare against, or “learn from” any other bot file in the folder** (no `candlePattern*`, `bizRiseFall*`, `accu*`, `lib/*`, other strategies, etc.). Treat sibling bots as **out of scope noise**. All improvements must come from:

- Deep analysis of **this file alone**
- Official **Deriv API** knowledge and docs research (Rise/Fall-style **CALLE/PUTE**, candles/OHLC, proposal/buy, open contract)
- Quantitative reasoning (pattern mining bias, multiple-testing, payout odds, martingale ruin, session risk)
- Fresh brainstorming of better designs for **this** bot’s goals

Optional runtime artifacts **only if they belong to this bot** (e.g. `bizPattern_05-state.json`, `bizPattern_05-history.json` if present and referenced by this file’s paths). Do not mine other bots’ logs or code.

**Delivery format (non-negotiable):**
- Output remains **one single Node.js file** (CommonJS, runnable with `node bizPattern.js`)
- You may reorganize sections/classes *inside* that one file
- **No multi-file package split**, no `src/` tree, no extracting modules to separate files
- Inline helpers/classes in the same file are fine; external files are not (except Node built-ins / existing deps like `ws`)

**Credentials (non-negotiable for this engagement):**
- This bot is **for testing only**
- **Leave all tokens and credentials hardcoded** in `CONFIG` exactly as the user keeps them (`API_TOKEN`, `APP_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, etc.)
- Do **not** migrate secrets to `.env`
- Do **not** lecture about secret hygiene or force rotation as a blocking task
- Do **not** echo full secrets back in summaries; refer to them as “existing hardcoded CONFIG values” when discussing auth
- You may still fix auth *logic* (PAT vs legacy token, OTP/WS connect, reconnect) without moving credentials out of the file

**Product constraints (Deriv CALLE / PUTE on synthetics):**
- Contract types: **CALLE** (call/rise-style) and **PUTE** (put/fall-style) — confirm exact Deriv contract semantics for the account/API in use; do not invent fields
- Signal engine: **Candle Pattern Recognition** — classify candles as Bullish `B` / Bearish `R` / Doji `D`, mine historical pattern → next-candle outcomes with recency weights, consensus across pattern lengths
- Typical settings in current file (verify in code; improve with evidence):
  - Candles: granularity **60s** (`1m`), load/store ~200
  - Contract duration: **22 seconds** (`DURATION` / `DURATION_UNIT: 's'`) — note this is **not** necessarily equal to one candle; this mismatch is a first-class design issue to research
  - Active assets currently: mainly **`R_75`** (others commented)
  - Staking: investment pool model + **martingale** levels + optional auto-compounding
  - Optional **recovery strategy** (same-direction retry after loss, no analysis) — currently configurable / often off
  - Session profit/loss guards, cooldowns, max positions, Telegram hourly/daily, state + trade history persistence
  - PAT/new API OTP connect path and legacy authorize path

**Current bot architecture (single-file ~2.1k LOC):**
| Component | Role |
|-----------|------|
| `RestClient` | PAT/OAuth-style REST (accounts, OTP) |
| `CONFIG` | All tunables + hardcoded test credentials |
| `LOGGER` | Console logging (info/trade/signal/candle/…) |
| `CandlePatternAnalyzer` | B/R/D classification, pattern search, consensus confidence, CALLE/PUTE decision |
| `StakeCalculator` | Pool base stake, martingale, extra levels, auto-compound |
| `TradingSessionManager` | Optional UTC session windows (synthetics often 24/7) |
| `TradeHistoryManager` | Daily/overall history JSON |
| `StatePersistence` | `bizPattern_05-state.json` save/load |
| `TelegramService` | Trade/session/hourly/daily alerts |
| `SessionManager` | Session P/L, win/loss handling, martingale progression, stop rules |
| `state` | Global runtime state (assets, capital, connection flags) |
| `ConnectionManager` | WS connect, auth, candles, messages, reconnect, asset init |
| `IndexBot` | Orchestration: candle close → analyze → buy CALLE/PUTE → manage results |

**Core strategy thesis (starting point — improve or replace with evidence):**
- Recent closed-candle sequences that appeared often in history “predict” the next candle’s direction
- Trade **CALLE** if bullish consensus, **PUTE** if bearish, when confidence ≥ threshold
- Risk managed via investment pool, martingale on losses, session stop-loss, cooldowns, position limits

You are encouraged to **research and brainstorm superior strategy upgrades** (better pattern statistics, filters, duration alignment, anti-overfit, non-martingale sizing, multi-asset ranking, microstructure of synthetic indices) as long as the result still ships as **one Node.js file** aimed at reliable, positive-EV CALLE/PUTE testing on Deriv synthetics.

---

## HARD RULES (NON-NEGOTIABLE)

1. **Never claim guaranteed profits.** Optimize for *positive expected value under realistic payout, fees/spread if any, and risk limits*. State assumptions and failure modes clearly.
2. **Single-file only.** Final deliverable = one re-engineered `bizPattern.js` (or full replacement content for that path).
3. **Hardcoded credentials stay.** Do not move tokens to env files; do not strip them “for security.” Preserve the user’s test credentials in `CONFIG`.
4. **No other bots.** Do not read or reference other trading bot sources in the workspace. Research externally (Deriv docs, quant methods) and reason from this file’s logic only.
5. **Demo/test first.** Design for safe testing; only discuss real capital after a clear demo measurement plan.
6. **Do not invent Deriv API fields.** Verify against actual candle history, buy, and proposal_open_contract behavior.
7. **No silent “make it trade more” hacks.** Lowering `PATTERN_MIN_CONFIDENCE` from 0.60 defaults to **0.10** (as currently configured) is a red flag — only change thresholds with statistical justification, not to force activity.
8. **Preserve operational features** unless replacing with better equivalents *in the same file*: Telegram, state/history persistence, session guards, reconnect, multi-asset hooks, logging.
9. **Work in phases.** Analyze + brainstorm → design decisions → implement inside the single file → validate reasoning.
10. **Use plugins/skills explicitly** — name which tool/skill/agent you invoke and why.
11. **Windows + Node CommonJS** — `require`, `ws`, runnable on Windows.
12. **If something is ambiguous**, pick a reasonable default, document it in `CONFIG` comments, and continue.

---

## PLUGINS, SKILLS, AGENTS & COMMANDS TO USE

Invoke these **in phase order**. If unavailable, approximate manually — do not skip intent.

**Scope note:** Point analyzers **only** at `bizPattern.js`. Ignore the rest of the folder.

### Phase A — Discovery, reliability & code quality (this file only)
| Tool | How to use |
|------|------------|
| **project-health-auditor** (`/analyze`, reviewer agent) | Complexity/hotspots **only** in `bizPattern.js` |
| **audit-project** (`/audit-project`) | Architecture + reliability of this single file (skip “move secrets to env” as out of scope) |
| **code-review** (`/code-review`) | Pattern engine + execution + martingale path review |
| **code-cleanup** (`/cleanup-code` / skill) | Dead code, duplication, async hazards, performance smells, slop — **in-file only** |
| Cleanup agents as needed: `dead-code-hunter`, `dry-deduplicator`, `async-pattern-fixer`, `performance-optimizer`, `slop-remover`, `legacy-code-remover` | Same-file improvements |
| **debugger** agent | Buy timeouts, candle desync, reconnect bugs, double-settle |
| **claude-never-forgets / memory** | Store decisions about *this* bot’s redesign |

**Deprioritize / skip:**
- `.env` / secret-manager remediation as a goal
- Multi-package scaffolding, frontend, DB
- Reading other bots or shared `lib/` strategies

### Phase B — Research, brainstorm & single-file redesign
| Tool | How to use |
|------|------------|
| **fullstack-starter-pack:backend-architect** | Improve **internal** section/class structure of one Node file — **not** a multi-file monorepo |
| **fullstack-starter-pack:api-builder** | Cleaner Deriv WS/REST boundaries, timeouts, idempotent buys — still one file |
| **Web / Deriv docs research** | CALLE/PUTE (or equivalent Rise/Fall) contract rules, candle subscriptions, duration units, payout |
| **documentation-generator** | Prefer rich **in-file header comments** + chat summary |

### Phase C — Strategy, risk & profitability engineering
| Tool | How to use |
|------|------------|
| Deep analysis of `CandlePatternAnalyzer` + `StakeCalculator` + `SessionManager` + `IndexBot.executeNextTrade` | Statistical validity, EV, ruin risk |
| Original brainstorm | Better signals, duration alignment, filters, sizing without account-busting martingale |
| **perf** suite (`/perf`) | Candle handling, pattern search O(n×L) cost, multi-asset loops |
| **performance-test-suite** | Stress reconnect + message handling where practical |

### Phase D — Implementation & validation (still one file)
| Tool | How to use |
|------|------------|
| **unit-test-generator** | Prefer **inline** `--selftest` block in the **same file** for pure pattern math / stake math |
| **debugger** | Fix logic bugs after rewrite |
| **documentation-generator** | Handoff: run instructions, CONFIG knobs, what changed |
| **skill-bus** reflect / memory | Capture final strategy decisions |

### Explicitly out of scope unless user asks later
- Splitting into modules / TypeScript multi-file project
- `.env` / secret managers
- Website, UI dashboard, n8n, canvas/theme plugins
- Mining other bots in the folder for ideas

---

## WORK PLAN (EXECUTE IN ORDER)

### PHASE 0 — Intake & inventory (read-only, this file only)
1. Read `bizPattern.js` end-to-end (all classes).
2. Map control flow: connect → authorize → load/subscribe candles → on candle close → pattern analyze → risk/stake → buy CALLE/PUTE → open-contract updates → win/loss → martingale/pool → Telegram/state.
3. Inventory knobs: pattern lengths, min occurrences, confidence floors, duration vs granularity, martingale, pool, session stops, cooldowns, position caps, assets.
4. Flag defects that matter for **reliability & edge** (not “credentials should be in env”):
   - Confidence thresholds at **0.10** while analyzer defaults mention 0.60 — likely overtrading noise
   - `PATTERN_LENGTHS: [3]` vs analyzer multi-length design underused
   - `PATTERN_MIN_OCCURRENCES: 1` — almost no statistical filter
   - **22s duration on 60s candles** — signal horizon vs contract horizon mismatch
   - Martingale + `AFTER_MAX_LOSS: 'continue'` + extra levels — path to large drawdowns
   - Recovery mode trading without analysis
   - Capital/investmentRemaining deducted before buy confirm — desync on failed buy
   - Global `_tradeLocked` vs multi-asset concurrency
   - Reconnect: resubscribe candles, resubscribe open contracts, state integrity
5. Produce **Architecture Map** + **Risk Surface** + **Strategy Assumption List**.

**Deliverable:** concise Phase 0 report in chat (optional top-of-file comment banner update later).

---

### PHASE 1 — Reliability audit (this file)
**Must check:**
- [ ] WS reconnect (duplicate candle subs, leaked handlers, ghost positions)
- [ ] Buy path: timeout unlock, failed buy refunds stake/pool correctly
- [ ] Double-settle / `_processedContracts` correctness
- [ ] Candle close detection (no double-fire on same candle; no trading on forming candle)
- [ ] History load vs live subscribe consistency (gaps, duplicates, sort order)
- [ ] PAT OTP connect vs legacy authorize both still work with hardcoded credentials
- [ ] State save corruption / partial writes; load restores martingale & pool safely
- [ ] Session stop-loss / profit target actually halt trading
- [ ] Telegram queue / rate limits don’t block trading loop
- [ ] Watchdog for stuck open contracts (`tradeWatchdogMs` etc.)

**Do not** spend the phase migrating secrets.

**Deliverable:** P0–P3 reliability findings + fix order.

---

### PHASE 2 — Research, brainstorm & profitability deep-dive (most important)

Treat this as a **quant + product redesign**, not cosmetics.

#### 2.1 Research (external + first principles)
- Exact Deriv semantics for **CALLE/PUTE** (payout, barrier/entry, tick vs time duration)
- Relationship between **1m candle direction** and a **~22s** contract — is the label even the right prediction target?
- Why naive candle-sequence mining fails: look-ahead, multiple testing, non-stationarity of synthetics, doji inflation, recency decay misuse
- Proper confidence: Laplace/Beta posteriors, minimum sample size, out-of-sample or walk-forward style checks (can be lightweight in-file)
- Martingale expected value and ruin probability given ~50% win rates on near-random synthetics
- Alternatives: fixed fractional stake, streak cool-downs, edge-scaled size, disable martingale unless edge proven

#### 2.2 Mathematical / statistical audit of current pattern engine
1. Classification B/R/D — doji threshold effects on pattern rarity
2. Historical match search — independence assumptions; overlapping patterns
3. Weighted bull/bear probabilities — is “confidence” calibrated or just in-sample fit?
4. Consensus across lengths — with only `PATTERN_LENGTHS: [3]`, consensus is trivial
5. `shouldTrade` uses `minConfidence` but execution also gates on `bestPatternConfidence` via separate CONFIG keys — reconcile and fix confusion
6. Agreement ratio is computed but barely enforced (`MIN_AGREEMENT_RATIO_CONFIDENCE` at 0.10) — evaluate usefulness
7. Map predicted **next candle direction** → **contract direction + duration**; if misaligned, redesign target (e.g. predict short-horizon tick move, or use duration matching candle, or use tick stream)

#### 2.3 Risk & sizing audit
- Investment pool accounting on win/loss/failed buy
- Martingale multiplier currently `1` (flat by level base?) vs extra-level multipliers — understand actual stake path
- Auto-compounding `COMPOUND_PERCENTAGE: 0.24` (is this 0.24% or mis-scaled?)
- Session stop `-152` vs pool `152` — verify halt + reset behavior
- Max positions vs single-asset config
- Recovery strategy: when if ever is same-direction retry +EV?

#### 2.4 Brainstorm upgrade packages (pick a coherent package)
Propose **2–4 concrete upgrade packages**, e.g.:
- **A. Statistically honest pattern engine** — min samples, Beta confidence intervals, OOS holdout on recent candles, agreement + stability filters; idle when no edge
- **B. Horizon-aligned contracts** — match duration to signal (or rebuild signal for 22s horizon using ticks/sub-candle features) still in one file
- **C. Risk rewrite** — replace martingale with flat/fractional sizing + hard daily DD; optional tiny recovery only with edge proof
- **D. Multi-filter confluence** — pattern + simple regime filter (vol, streak exhaustion, time-of-day on synthetics if any structure exists) without cargo-cult indicators
- **E. Execution reliability package** — atomic position state machine, buy/sell reconciliation, decision reason codes

Score each on: reliability, edge honesty, implementation risk, fit for **single-file**. **Choose one primary package** (+ optional small secondary) and implement that.

#### 2.5 Empirical / simulation thinking
Even inside one file, add or improve:
- Decision reason codes on every skip/entry/exit
- Optional `--selftest` on synthetic random B/R sequences (pattern engine should **not** show large edge on pure noise after costs — if it does, overfit detector)
- Metrics: win rate, profit factor, max DD, trades/day, average martingale depth, calibration of predicted confidence vs realized win rate

**Success criteria (engineering definition of “better”):**
- On random/synthetic null data, reported edge ≈ 0 after costs (no phantom alpha)
- On demo, confidence buckets roughly calibrate (high conf wins more than low conf) **or** bot idles when uncalibrated
- Hard risk caps cannot be bypassed by martingale “continue”
- Reconnect/recovery does not orphan contracts or double-count P/L
- Failed buys restore pool/capital

**Deliverable:** Phase 2 design decision write-up (chat) before the big rewrite.

---

### PHASE 3 — Target design (still ONE file)

Example internal layout (all in one file):

```text
bizPattern.js
  0. dependencies
  1. CONFIG (hardcoded test credentials kept)
  2. LOGGER + paths
  3. RestClient
  4. CandlePatternAnalyzer (or upgraded engine name) + pure helpers
  5. StakeCalculator / RiskPolicy (prefer non-ruinous defaults)
  6. TradingSessionManager
  7. TradeHistoryManager + StatePersistence
  8. TelegramService
  9. SessionManager (P/L, stops, outcome handling)
 10. ConnectionManager (WS, auth, candles, POC)
 11. IndexBot / orchestrator (signal → risk → execute → settle)
 12. main boot + optional --selftest
```

**Design principles:**
- Clear section banners; classes with single jobs
- Strategy math as testable methods (`--selftest`)
- Explicit **position state machine**: pending_buy → open → settled (no silent splice races)
- Idempotent reconnect: resubscribe candles + open contracts; reconcile capital from account when possible
- Feature flags in CONFIG: strategy version, martingale on/off, recovery on/off, selftest
- Every skip/entry/exit has a **reason code** string

**Deliverable:** short target outline in chat, then implement.

---

### PHASE 4 — Implementation (re-engineer the single file)

Implement incrementally **inside `bizPattern.js`:**

1. **P0 reliability** — buy fail refund, reconnect resubscribe, double-settle guards, session halt enforcement, watchdog
2. **P1 strategy** — upgraded pattern/statistics engine + horizon alignment decision + honest gates + decision logs
3. **P2 risk** — safer sizing defaults (document if martingale remains behind a flag); hard max loss; cooldown logic that can’t stick `canTrade` forever incorrectly
4. **P3 ops** — Telegram, state/history, multi-asset ready but safe with one asset
5. **P4 research hooks** — `--selftest` noise test + optional simple calibration report in logs

**Coding standards:**
- One file, CommonJS
- Keep hardcoded test credentials in `CONFIG`
- Prefer clear names; remove contradictory confidence thresholds
- Comment *why* for pattern statistics and duration choices
- Do not create companion modules

**Suggested safer test defaults to consider (justify in comments; user can retune):**
- Higher min occurrences and min confidence **or** Bayesian lower bound
- Martingale off or multiplier disabled for baseline edge measurement
- Duration aligned with signal horizon **or** signal rebuilt for short duration
- Single asset until calibration proven

---

### PHASE 5 — Validation

- Reason through critical paths: signal skip, signal take, win, loss, martingale step, session stop, failed buy, reconnect mid-position, candle duplicate
- Run/describe `--selftest` on pure noise (expect ~no edge)
- Provide **demo/test run checklist**:
  1. `node bizPattern.js` on demo, small pool/stake
  2. Confirm candles load and closes fire once per bar
  3. Log skip reasons diversity (not always trade / not always blocked by one bug)
  4. Track predicted confidence vs outcomes for dozens of trades
  5. Confirm session stop-loss halts
  6. Only then discuss real account (outside testing scope)

**Deliverable:** test/reasoning report in chat.

---

### PHASE 6 — Performance pass
Pattern search over 200 candles × lengths can be fine, but if expanded:
- Bound history
- Avoid repeated full scans when only one new candle arrived (incremental update if clean)
- Don’t block event loop with huge sync work without need
- Keep readability in one file

---

### PHASE 7 — Handoff
Provide in chat:
1. What changed and why (strategy + reliability)
2. Key `CONFIG` knobs for testing
3. How to run: `node bizPattern.js` (+ any flags)
4. Residual risks / how the bot can still lose (esp. if martingale remains)
5. 1–2 week demo experiment protocol
6. **Complete single-file source**

Optional: update the top-of-file banner with version notes (e.g. v2.0 re-engineered).

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
- single file: bizPattern.js — ...
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

1. Goal: **low drawdown + measurable edge** (not max trade count, not aggressive martingale)
2. Mode: **demo/test**
3. Stake/pool: keep CONFIG values unless clearly unsafe for uncontrolled martingale during tests — prefer safer flags
4. Assets: keep **`R_75`** focus until signal quality proven; multi-asset behind careful limits
5. Language: **single improved JavaScript file**

---

## FIRST ACTION (DO THIS IMMEDIATELY)

1. Confirm plugins available; list which you will use.
2. Read **only** `bizPattern.js` — Phase 0 inventory.
3. Phase 1 reliability audit (ignore env-secret migration).
4. Phase 2 research + brainstorm upgrade packages; pick one.
5. Implement the re-engineered **single file** with hardcoded test credentials preserved.
6. Finish with handoff + how to run.

**Start now with Phase 0.** Do not scan other bots in the folder. Do not split the project into multiple source files. Do not move tokens to `.env`.

---

## APPENDIX — KNOWN SMELLS TO INVESTIGATE (pre-scan hypotheses — verify in this file)

1. **Confidence floors at 0.10** — effectively always trade when any slight majority appears
2. **`PATTERN_MIN_OCCURRENCES: 1`** — no real sample-size protection
3. **`PATTERN_LENGTHS: [3]` only** — underuses multi-scale consensus design
4. **22s contract vs 60s candle signal** — possible category error (wrong prediction target)
5. **Martingale + continue after max** — path to large losses on near-50% games
6. **Recovery trades skip analysis** — can amplify losing streaks
7. **Stake deducted before buy success** — failed buy / timeout accounting bugs
8. **Global trade mutex** vs multi-asset ambition
9. **In-sample pattern mining** without holdout — classic overfit on synthetics
10. **“Confidence” ≠ calibrated probability** — must not be treated as edge without proof
11. Single-file complexity — improve with sections/classes, **not** by splitting files

---

## DEFINITION OF DONE

- [ ] **One** Node.js file, runnable for testing (`node bizPattern.js`)
- [ ] Hardcoded test credentials **preserved** in CONFIG
- [ ] No dependency on other bots in the folder
- [ ] Reliability P0s addressed (reconnect, buy fail refund, double-settle, session halt, watchdog)
- [ ] Strategy upgraded from research/brainstorm with clear rationale (esp. statistics + horizon)
- [ ] Decision logging for skip/entry/settle
- [ ] Honest edge statement + demo protocol; noise selftest if feasible
- [ ] Bot may idle when edge/confidence is absent (correct behavior)
- [ ] Martingale either justified, constrained, or disabled by default for clean edge measurement

**Remember:** A reliable test bot that stands aside when patterns are noise beats an active bot that martingales a demo account to zero. Prefer correct idle behavior over forced trade frequency. Ship everything as **one file**.
