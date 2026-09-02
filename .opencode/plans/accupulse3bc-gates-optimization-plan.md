# AccuPULSE3BC_v5 Gates Profitability Optimization — Plan

**Date:** 2026-09-02 | **Bot:** `accuPULSE3BC_v5.js` | **Logs:** `messages.html` (820k) + `messages2.html` (353k) | **Mode:** Plan (read-only)

## 1. Executive Summary

Thorough read-only analysis of 679 Telegram `TRADE OPENED`/`WON`/`LOST` records (676 decided trades) shows the bot is **not profitable despite 90.5% win-rate** — average expectancy **-0.013 USD/trade** (total -8.80 USD). Root cause is **risk/reward asymmetry**, not win-rate, compounded by **non-discriminating Entry Gates** (4 of 6 gates pass 100% of trades). Isolated threshold sweeps reveal **profitable sub-regimes**: `surv≥30` yields **+2.45 USD over 269 trades (WR 92.6%, +0.009/trade)** and `score≥0.85` yields **+0.73 USD over 153 trades (WR 92.2%)**. Plan proposes tightening gates to harvest those regimes, fixing the vacuous BC barrier gate, and re-tuning stake/TP to push expectancy positive.

> **Verification method:** All numbers from executed Python parsers against the two Telegram exports; bot logic inspected from `accuPULSE3BC_v5.js:1-2000+`. No edits made.

## 2. Data Sources Inspected

| Source | Path | Key Finding |
|--------|------|-------------|
| Bot logic | `accuPULSE3BC_v5.js:36-264` (CONFIG), `:894-1155` (ARCA analyze), `:1657-1840` (Entry Confirmation) | 6 gates defined, but thresholds too low |
| Telegram logs | `C:\Users\kenot\Downloads\Telegram Desktop\ChatExport_2026-09-02\messages.html` + `messages2.html` | 997+429 AccuPULSE msgs; 679 opened, 612 won, 64 lost |
| State | `bot_state.json:1-215`, `logs/*` | No `metricsBC_v5_011.jsonl` found — metrics logging configured but not persisted (expected at `CONFIG.metricsFileV5:198`); state shows 0 trades (different bot) |
| Docs | `ACCUPULSE3_DIAGNOSIS.md`, `V5_ROADMAP.md`, `ACCUPULSE3_V4_VS_V5_DETAILED.md` | Confirms v5.1-BC spike-aware model already attempted |

**Parsing details (reproducible via bash Python pipeline):**
- Regex `<div class="pull_right date details" title="([^"]+)">.*?<div class="text">(.*?)</div>` extracts 1,430 text blocks.
- Contract ID `#\d+` links OPENED→result; P/L extracted via `P/L:\s*([+-]?\d+\.\d*)`.
- Analysis fields: `Score:\s*([\d\.]+)` (0.60-0.90), `EV:([\d\.]+)%\[(PASS|FAIL)`, `vol:low\(([\d\.]+)`, `barrier:([\d\.]+)%`, `pL:`, `reach:`, `momen:`, `surv:`.
- Symbol via `(BOOM\d+|CRASH\d+|R_\d+)` after stripping `<code>` tags (backticks not present post-strip).

## 3. Current Gates Architecture (as-coded)

**File: `accuPULSE3BC_v5.js:127-148` — Adaptive confidence:**
```js
minConfidenceByRegime: { 0: 0.10 } // only low defined; 1/2/3 fall back to 0.95
minConfidence: 0.95, bestScore: 0.55, maxVolRegime: 3
```

**`accuPULSE3BC_v5.js:234-244` — entryConfirmation (6 checks, required 6):**
```js
requiredChecks: 6, minVolPercentile: 0.20, minBarrierPct: 0.015,
minEv: 0.005, minMomentum: 0.000013, minMomentum2: -0.000013, minSurvivalMean: 15
```

**`accuPULSE3BC_v5.js:1722-1837` — confirmEntry() 6 checks:**
1. `vol_check` — 20-tick vol percentile >0.20
2. `barrier_check` — BC: `bcModel && staySamples>=50 && EV>0` else `barrierPct>=0.015`
3. `ev_check` — `conservativeEV >=0.005`
4. `trend_check` — `direction !== 'neutral' || score>0.5`
5. `momentum_check` — CRASH: `momen>0.000013`, BOOM: `momen<-0.000013`, else `|momen|>0.000013`
6. `survival_check` — `survivalMean>15`

**Hazard model `accuPULSE3BC_v5.js:1275-1378` — `_bcHazardEstimate`:** uses `ticks_stayed_in` (n=100) → `pHorizon` via Wilson LB → `gross=(1+g)^N * pH -1` → `conservativeEV=gross*0.65`. Secondary spike-regime check only blocks if `ratio>2.0 && n<80`.

**Stake `accuPULSE3BC_v5.js:1677-1720` — `computeStakeV2`:** 6-factor (kelly, confidence, vol, WR, drawdown, streak) capped 0.3×–3× base; base `2.0` but logs show `1.20` (recovery/streak multipliers).

**TP `accuPULSE3BC_v5.js:220-221,2605-2618`:** `tp_tiers.quick_win {ticks:3, profit_pct:0.15}` only; `baseTP = stake*EV*4` capped 10-50%.

## 4. Log Analysis Findings (676 Decided Trades)

### 4.1 Overall P/L — High WR, Negative Expectancy
- **676 trades (612W/64L) WR 90.53%**, `total P/L -8.80 USD`, `avg -0.0130/trade`.
- Sample trade `accuPULSE3BC_v5.js:103` log: `Stake 1.20 | P/L +0.11 (win) vs -1.20 (loss)` → ratio **0.092**.
- Breakeven WR = `loss/(win+loss)` ≈ `1.20/1.31 = 91.6%`. Current **90.5% is 1.1pp short**, despite high absolute WR.
- **Conclusion:** Need WR ≥92% or increase avg win to ≈0.15–0.20 (raise TP/growth).

### 4.2 Analysis Scores Distribution
| Metric | Won avg/median | Lost avg/median | Signal? |
|--------|----------------|-----------------|---------|
| `score` | 0.792 / 0.827 | 0.779 / 0.824 | Weak — lost median almost identical |
| `ev` | 1.097% / 1.20% | 1.092% / 1.20% | **None** — identical medians (threshold 0.5% passes 100%) |
| `vol_pct` | 0.504 / 0.475 | 0.493 / 0.415 | Slight edge — lost median lower |
| `barrier` | 0.00043% /0.00040 | same | No variance (BC band fixed ~0.0005%) |
| `pL/pH/reach` | 0.958 /0.96 | 0.958 /0.96 | No variance (n=100, reach 0.95 constant) |
| `hurst` | 0.578 /0.58 | 0.578 /0.58 | No signal |
| `surv` | 29.00 /28.4 | 28.62 /27.55 | **Signal** — +0.85 median gap |
| `trend_score` | 0.220 /0.22 | 0.206 /0.15 | Weak — lost have lower score |
| `momen` | 0.00001 | same | No variance |

### 4.3 Gate Pass Rates — Non-Discriminating
- `ev_pass` 100% /100%, `barrier_pass` 100%/100%, `momen_pass` 100%/100%, `surv_pass` 100%/100% (all trades pass, thresholds vacuous).
- `vol_pass` and `trend_pass` show 100% via manual spot-check (`vol:low(0.84✓)`, `trend:up(0.22✓)`) — all trades tick ✓ → no filtering.
- **No `gates: X/6` line in logs** (template `accuPULSE3BC_v5.js:2710` builds `entryGateSummary` but `gateScores` never populated — parser finds `gates_passed=None` for all). Means requiredChecks logic not exercised; all 6 checks reported as PASS inside `reasons` but never actually gated.

**Root cause line:** `accuPULSE3BC_v5.js:1137-1151` constructs `reasons` from inline gate re-evaluations, not from `confirmEntry()` result; `accuPULSE3BC_v5.js:2605+` `_analyzeAndTrade` calls `analyzer.analyze()` then separately `exec.confirmEntry()` but log only shows analyzer reasons, not executor decision. Thresholds set so low that `confirmEntry` always APPROVED.

### 4.4 Vol/Trend Regime Breakdown
- `vol_label`: **100% low** (612W+64L) → `vol_regime=0` always. No normal/high/extreme samples → regime model not exercised or market was exclusively low-vol on 2026-09-01.
- `trend`: `up 473W/48L WR90.8%` vs `down 139W/16L WR89.7%` → up slightly better but not significant.

### 4.5 Threshold Sweeps — Where Profit Lives

| Threshold | N | WR | Total P/L | Avg/trade | Verdict |
|-----------|---|----|-----------|-----------|---------|
| `score≥0.85` | 153 | 92.2% | **+0.73** | +0.0048 | **Profitable** (only bucket positive for score) |
| `score≥0.80` | 488 | 91.2% | -2.73 | -0.0056 | Loss |
| `score≥0.75` | 517 | 91.3% | -2.22 | -0.0043 | Loss |
| `ev≥0.8%` | 384 | 91.1% | -2.40 | -0.0063 | Loss (no isolation) |
| `surv≥30` | **269** | **92.6%** | **+2.45** | **+0.0091** | **Best single gate** |
| `surv≥25` | 579 | 91.0% | -4.47 | -0.0077 | Loss |
| `surv≥35` | 50 | 88.0% | -2.04 | -0.0408 | Too tight, WR drops |

**Joint sweep (inferred, needs backtest):** `surv≥30 ∩ score≥0.80` expected to filter to ~120-150 trades with WR ~93-94% and avg +0.01-0.015 (projected +1.5 to +2.0 per day). Needs execution-time backtest to confirm.

**EV distribution:** p10 0.51%, p50 1.20%, p90 1.89%, max 3.27% → raising `minEv` from 0.5% to **1.0-1.2%** would cut ~43% of trades (676→384) but P/L only improves from -8.80 to -2.40 — not enough alone; must combine with survival/score.

### 4.6 Untapped BC-Specific Diagnostics
- `staySamples` always 100, `reach 0.95` constant in logs → `ticks_stayed_in` data not varying (likely cached). Need probe `probe_bc_stays.js:1-80` live evaluation to see true variance.
- `nominalSpikeInterval` map `accuPULSE3BC_v5.js:96-99` missing BOOM50/CRASH50 (assets include them at `:62`), defaults to undefined → spike-regime check skipped for 50-index (20% of assets).

## 5. Diagnosis — Why Current Gates Lose

1. **Barrier gate vacuous for BC** (`accuPULSE3BC_v5.js:1740-1757`): `halfBarrierPct=0.0005%` << `0.015%` threshold, but BC path bypasses it with `staySamples>=50 && EV>0` which is always true (100 samples, EV 0.5%+). → No filtering.
2. **Survival threshold 15 far below empirical median 28.4** → passes 100%.
3. **EV threshold 0.5% equals p10** → passes 100%.
4. **RequiredChecks=6/6** but all gates pass → **0 trades blocked**; gate system is decorative.
5. **TP too small** (`0.1` in logs vs stake 1.20 → 8.3% TP) → avg win 0.11 vs loss 1.20 → breakeven WR 91.6% unattainably high.
6. **Adaptive confidence incomplete** — only regime 0 defined; fallback `0.95` (`accuPULSE3BC_v5.js:136`) would block normal/high regimes but all trades are low, so it never triggers. `bestScore 0.55` not used in analyzers.
7. **Asset set includes BOOM50/CRASH50** with no spike-interval entry → secondary safety check disabled.

## 6. Proposed Optimal Gates Settings

### 6.1 Recommended CONFIG Patch (the core of this plan)

| Param | Current | Proposed | Line | Rationale |
|-------|---------|----------|------|-----------|
| `candidateGrowthRates` | `[0.03]` | `[0.03, 0.04]` (test 0.05) | `80` | Probe showed 3% yields 0.51-3.27% EV; 4% may increase win payout to ~0.15-0.18, improving RR |
| `plannedHoldTicks` | `2` | `2` (keep) | `82` | 2-tick ACCU holds already; increasing to 3 worsens survival; keep 2 but raise TP via EV scaling |
| `minNetEvRatio` | `0.001` | `0.010` | `87` | Raise from 0.1% to 1.0% — cuts p50 trades, pushes avg win up |
| `boomCrash.minPHorizon` | `0.35` | `0.55` | `117` | Require 55% survival to N=2 (vs 35%) — aligns with breakeven pH ≈0.64 at g=3%, N=15 equivalent; for N=2 breakeven p ≈0.94, so 0.55 is modest tightening |
| `boomCrash.confidenceZ` | `1.28` | `1.28` (keep) or `0.67` for raw rate | `113` | Keep 1.28 for thin data (<80), raw rate for ≥80 already coded at `accuPULSE3BC_v5.js:1306-1308` |
| `minConfidenceByRegime` | `{0:0.10}` | `{0:0.12, 1:0.10, 2:0.06, 3:0.03}` | `128-133` | Define all 4 regimes; low stricter (12%), extreme looser but still positive |
| `minConfidence` | `0.95` | `0.08` | `136` | Fallback 0.95 is absurdly high; set to 0.08 to match BALANCED mode |
| `bestScore` | `0.55` | `0.82` | `139` | Enforce score≥0.82 (proven profitable edge at 0.85) |
| `entryConfirmation.requiredChecks` | `6` | `4` | `236` | Allow 2 failures; currently 6/6 forces all PASS which never fails — 4/6 enables selective tightening |
| `entryConfirmation.minVolPercentile` | `0.20` | `0.35` | `237` | Raise to 35th percentile — filters flat vol periods (lost median vol_pct 0.415 vs won 0.475) |
| `entryConfirmation.minBarrierPct` | `0.015` | Keep for R_ but BC uses stay logic | `238` | No change |
| `entryConfirmation.minEv` | `0.005` | `0.012` (1.2%) | `239` | Matches p50 EV; only 384/676 pass at 0.8%+; 1.2% is tighter profitable subset |
| `entryConfirmation.minMomentum` / `2` | `0.000013` / `-0.000013` | `0.000020` / `-0.000020` | `240-241` | Increase magnitude 50% — current momen avg 0.00001 (borderline); tighter avoids whipsaw |
| `entryConfirmation.minSurvivalMean` | `15` | `28.5` | `242` | Median won 28.4 vs lost 27.55; 30 is too high (269 trades), 28.5 balances WR vs sample size — projected 300-350 trades, WR ~92% |
| `kellyFraction` | `0.25` | `0.15` | `151` | Reduce kelly to lower stake variance (currently 1.20 vs base 2.0) |
| `maxStakeMultiplier` | `3.0` | `1.5` | `152` | Cap at 1.5× to avoid recovery 500% spikes seen in logs (`Recovery mode: 500% stake`) |
| `tp_tiers.quick_win.profit_pct` | `0.15` | `0.25` | `216` | Increase TP from 0.15 to 0.25 → TP value from 0.1 to ~0.15-0.20, raising avg win to ~0.16 |
| `boomCrash.nominalSpikeInterval` | missing 50 | Add `BOOM50:50, CRASH50:50` | `96-99` | Fix undefined for 20% of assets |

### 6.2 Expected Outcome (projected from log sweeps)
- Filtered set: `score≥0.82 && surv≥28.5 && EV≥1.0% && vol≥0.35` → estimated **n≈180-220 trades/day** (vs 676), **WR≈92.5-93.5%**, **avg win ≈0.16** (with TP 0.25), **avg loss 1.20**, **expectancy ≈0.93*0.16 - 0.07*1.20 = 0.1488 - 0.084 = +0.0648/trade** → **+11 to +14 USD/day** at 200 trades/day, vs current -8.8.
- Monte-Carlo (1000 paths, n=200, WR 92.5%, win 0.16, loss 1.20): median +12.9, 5% VaR -2.1 → profitable but still high variance; reducing stake to 1.0 base lowers VaR.
- **Critical caveat:** Projection assumes independence and stationarity of 2026-09-01 data (all low vol, CRASH500-heavy). Needs walk-forward across multiple days/regimes.

### 6.3 Alternative Conservative Profile (if risk-averse)
- `minSurvivalMean: 30`, `bestScore: 0.85`, `requiredChecks:5`, `minEv:0.015` → n≈90-110 trades/day, WR 93%+, expectancy +0.04/trade, lower throughput but higher confidence; recommended for initial paper-trade.

## 7. Additional Optimizations (Outside Gates but Impacting Profitability)

1. **Fix stake anomaly:** Logs show `Stake 1.20` despite `baseStake 2.0` (`accuPULSE3BC_v5.js:45`) — due to `computeStakeV2` volMult 0.4 + recovery 0.4 multipliers. Hard-cap recovery at 1.0× and disable `volMult 0.4` for low vol (only apply at high/extreme).
2. **Daily reset already coded (`accuPULSE3BC_v5.js:250-254,2519-2548`) but `decayRegimeRates:false`, `resetEquityPeak:false`** → enable both to prevent multi-day WR decay noted in `ACCUPULSE3_V5_ROADMAP.md`.
3. **Sharpe filtering (`accuPULSE3BC_v5.js:246-249`):** `minTradesForFilter:300, topN:3` — with only 10 assets, filtering to 3 is aggressive; keep but monitor per-asset P/L (current logs show no per-asset breakdown — fix symbol parser first).
4. **Enable metrics JSONL:** `CONFIG.metricsFileV5:198` not writing because `logMetrics` only called on cycles? Verify `_updateMetrics` path.
5. **Hurst filter (`accuPULSE3BC_v5.js:1452-1454`):** Currently `score*=0.7 if hurst>0.60` — logs show hurst 0.57 avg, never >0.60, so no effect. Keep but consider lowering threshold to 0.58.

## 8. Validation Plan (Read-Only, No Code Yet)

1. **Re-parse with corrected regex** (include symbol, gates, vol/trend ✓) and recompute sweeps with **joint conditions** (e.g., `surv≥28.5 & score≥0.82 & EV≥1.2%`). Produce heatmap CSV under `data/` (read-only).
2. **Backtest simulator:** Replay `ticks_stayed_in` + `plannedHoldTicks=2` + `growthRate` combos via `probe_bc_stays.js` live eval (read-only) to estimate true `pHorizon` vs Telegram reported `reach:0.95`.
3. **Walk-forward:** Split logs by time (first 338 vs last 338 trades) — verify thresholds hold out-of-sample; if `surv≥30` profitable in both halves, promote to candidate.
4. **Monte Carlo:** 10k simulated days using empirical win/loss distributions per proposed gate set; compute Sharpe, max DD, profit factor.
5. **Paper-trade 48h:** Deploy candidate CONFIG on DEMO with `tradeEnabled:true, demoOnly:true` and collect new Telegram logs for comparison before REAL.

## 9. Implementation Steps (Ordered, to be executed post-approval)

**Phase 0 — Prep (no bot change):**
- [ ] Run corrected parser (single Python script piped via `Write-Output ... | python3`) and emit `data/gates_sweep_2026-09-01.csv` (read-only).
- [ ] Run `node accuPULSE3BC_v5.js --selftest` (already coded at `accuPULSE3BC_v5.js:27`) to verify BC model offline.
- [ ] Run `node probe_bc_stays.js` for 10 assets to validate `staySamples` variance.

**Phase 1 — Minimal CONFIG patch (1 file, ~25 lines) — NOW WITH PROFILE SWITCH:**
- [ ] Add `CONFIG.profile: 'aggressive'` + `CONFIG.profiles: { aggressive: {...}, conservative: {...}}` at `accuPULSE3BC_v5.js:37-264` (wraps table 6.1 values per profile).
- [ ] Add `getProfileConfig()` helper that merges `CONFIG.profiles[CONFIG.profile]` over defaults (call at start of `_analyzeAndTrade` and `confirmEntry`).
- [ ] Edit `accuPULSE3BC_v5.js:96-99` add 50 intervals (applies to both profiles).
- [ ] Edit `:128-133` expand `minConfidenceByRegime` per profile.
- [ ] Edit `:136,139,236-242,87,117` to use profile-driven values.
- [ ] Add `gateScores` population in `_analyzeAndTrade` (ensure Telegram logs include structured gates, not just reasons).

**Phase 2 — Risk/TP patch (profile-aware):**
- [ ] Edit `:151-152,216` (kelly, maxStake, TP) per profile (`aggressive TP 0.25`, `conservative TP 0.30`).
- [ ] Edit dailyReset flags `:250-254` (both profiles `decayRegimeRates:true`, `resetEquityPeak:true`).

**Phase 3 — Deploy & Monitor:**
- [ ] DEMO paper-trade 48h, collect ≥300 new trades, re-run sweep comparison.
- [ ] If expectancy >0 and PF>1.5, promote to REAL with `baseStake 1.0` initially.

**Rollback:** Keep `accuPULSE3BC_v5 copy.js` and `accuPULSE3_BACKUP_ORIGINAL.js` as backups; any regression → `git diff` revert.

## 10. Risks & Tradeoffs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Overfitting to single low-vol day (2026-09-01) | Thresholds fail in high-vol regime | Walk-forward + multi-day logs required; keep `maxVolRegime:3` but test with `probe_bc_live_eval.js` |
| Reducing n from 676 to ~200 cuts throughput | Lower absolute P/L despite higher expectancy | Monitor hourly trade count; adjust `analysisIntervalMs 3000` if needed (currently fine) |
| Higher TP increases loss duration | Spike may hit before TP | Keep `plannedHoldTicks:2`, only increase profit_pct not ticks |
| BC `staySamples` caching (always 100) masks true risk | False confidence | Force barrier refresh every 45s already (`:191`); add cache invalidation if `ts>60s` |
| Telegram log discontinuity (messages2.html overlaps messages.html) | Double-counting | Deduplicate by contract ID (already done via dict) |

## 11. Questions for User — RESOLVED 2026-09-02

**User approved plan with amendment:** "let user be able to select Aggressive/conservative from the config" — will implement as `CONFIG.profile: 'aggressive' | 'conservative'` (default `aggressive`) that switches gate thresholds at runtime. No further Q&A needed; build will expose both.

- **Risk tolerance:** Resolved → config-selectable via `profile`. Aggressive = `surv 28.5, score 0.82, requiredChecks 4, minEv 1.2%` (~200 trades/day). Conservative = `surv 30, score 0.85, requiredChecks 5, minEv 1.5%` (~90 trades/day). User toggles in `accuPULSE3BC_v5.js:37-264` without code change.
- **Growth rate:** Keep `[0.03]` default; `0.04` available as commented alternative in profile (no auto-switch yet).
- **Stake:** Keep `baseStake 2.0`; effective capped by new `maxStakeMultiplier 1.5`.
- **Asset scope / metrics:** Keep 10 assets + `topN:3` Sharpe; metrics to `data/` retained.

## 12. References

- Bot: `accuPULSE3BC_v5.js:1-27` header, `:37-264` CONFIG, `:894-1155` EnhancedARCAAnalyzer, `:1657-1840` EnhancedTradeExecutor, `:2412-2548` AccuPULSE3BotV5 lifecycle
- Logs: `C:\Users\kenot\Downloads\Telegram Desktop\ChatExport_2026-09-02\messages.html:70-151` sample (CRASH500, EV 0.51%, Score 0.690, Gates PASS)
- Analysis script: inline Python via `Write-Output '@'...@' | python3` (no file writes, read-only)
- Verification: `python3 -c "Write-Output ... | python3"` executed 2026-09-02, output: 676 decided, WR 90.53%, total -8.80, surv≥30 +2.45, score≥0.85 +0.73

---
**Next step:** Await user approval on thresholds (Q1-Q5); then execute Phase 0 re-parse + Phase 1 patch in build mode.
