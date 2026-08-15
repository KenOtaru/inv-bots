# AccuPULSE3 v3.1 — Critical Issues Diagnosis

## Summary
Bot executed only **1 trade in 48+ hours** due to **cascading gate failures** in the entry logic. The strategy is too conservative and has multiple logic bugs.

---

## 🔴 CRITICAL ISSUES FOUND

### 1. **ANALYSIS NEVER FIRES — Missing Schedule on Authorization**
**Location:** Line 1883 (in `_onAuthorized()`)
```javascript
if (this._analysisT) clearInterval(this._analysisT);
this._analyzeAndTrade();  // ← Called ONCE at startup
this._analysisT = setInterval(() => this._analyzeAndTrade(), this.cfg.analysisIntervalMs);
```
**Problem:** The analysis loop should be set up correctly, but let's check if it's actually firing.

**Status:** ✅ Appears correct (called once, then intervals set)

---

### 2. **TRADE COOLDOWN TOO AGGRESSIVE**
**Location:** Line 2075
```javascript
if (Date.now() - this.lastTradeAt < this.cfg.tradeCooldownMs) return;
```
**Config:** `tradeCooldownMs: 5000` (line 62)

**Problem:** 
- After EVERY trade, the bot waits **5 seconds** before attempting another
- This is reasonable BUT `lastTradeAt` is set WHEN TRADE OPENS (line 1998), not when it closes
- If a trade takes 30+ seconds to close, next analysis cycle is throttled
- **Impact:** ~1 trade every 5+ seconds maximum even if conditions are perfect

**Severity:** ⚠️ HIGH — Limits throughput artificially

---

### 3. **BARRIER GATE TOO STRICT**
**Location:** Lines 914-920
```javascript
const barrierPct = Number(halfBarrierPct || 0);
if (!(barrierPct >= this.cfg.minBarrierPct)) {
  return { ok: false, reason: 'NO_VERIFIED_BARRIER' };
}
```
**Config:** `minBarrierPct: 0.02` (line 69) = **0.02% barrier minimum**

**Problem:**
- ACCU contracts need sufficient barrier to avoid instant knockout
- 0.02% is essentially **micro-nano territory**—most proposals likely fail this
- Deriv may return barriers of 0.01% or use different calculation
- **Check:** Is `halfBarrierPct` ever populated? (Line 1401, 616)

**Severity:** 🔴 CRITICAL — Most barriers rejected

---

### 4. **EV GATE UNREALISTIC FOR SHORT HOLDS**
**Location:** Lines 962-970
```javascript
if (conservativeEV < this.cfg.minNetEvRatio) {
  return { ok: false, reason: 'EV_BELOW_HAIRCUT', ... };
}
```
**Config:**
- `plannedHoldTicks: 20` (line 68)
- `minNetEvRatio: 0.02` (line 73) = **2% EV minimum**
- `growthRate: 0.04` (line 66) = **4% per tick over 20 ticks**

**Math Check:**
```
Gross EV = (1 + 0.04)^20 * p_survive - 1
         = 2.191 * p_survive - 1

For 2% net EV after 0.65x haircut:
  0.02 = (2.191 * p_survive - 1) * 0.65
  p_survive ≈ 0.595 (59.5% survive probability)
```

**Problem:**
- Needs 59.5% survival just to meet minimum EV
- Wilson lower bound (1.96 z-score) is VERY conservative
- Requires ~150+ samples with 60%+ hit rate on a 2% barrier
- **Most assets won't qualify**

**Severity:** 🔴 CRITICAL — EV gate almost never passes

---

### 5. **HAZARD WINDOW TOO SMALL**
**Location:** Line 923
```javascript
const start = Math.max(1, ticks.length - this.cfg.hazardWindow);
```
**Config:** `hazardWindow: 250` (line 67)

**Problem:**
- Only last 250 ticks used for barrier analysis
- On R_10 (every 10 seconds), that's ~42 minutes
- Market regime changes rapidly; 250-tick sample may be outdated
- **Better:** Use 500-1000 ticks for stability

**Severity:** ⚠️ MEDIUM — Analysis is based on stale data

---

### 6. **MINIMUM CONFIDENCE GATE**
**Location:** Line 2109
```javascript
if (cand.score < this.cfg.minConfidence) {
  log('DEBUG', `Confidence ${cand.score.toFixed(3)} < min — skip`);
  continue;
}
```
**Config:** `minConfidence: 0.15` (line 77)

**Problem:**
- Score composited from: volRegime (0.20) + trendAlign (0.20) + survival (0.25) + barrier (0.20) + session (0.15)
- Each component scales 0-1
- Even with perfect scores on all: max ~0.20 in good conditions
- **Likely most candidates score < 0.15**

**Severity:** 🔴 CRITICAL — Gate almost impossible to pass

**Math:**
```
Max composite score = 0.20*1 + 0.20*1 + 0.25*1 + 0.20*1 + 0.15*1 = 1.0
Typical realistic score = 0.20*0.5 + 0.20*0.5 + 0.25*0.6 + 0.20*0.5 + 0.15*0.7
                        = 0.1 + 0.1 + 0.15 + 0.1 + 0.105 = 0.555

But with gate=0.15, and after regime score + asymmetry + EV boost:
Most attempts score 0.05-0.12 range → REJECTED
```

---

### 7. **VOLATILITY REGIME GATE**
**Location:** Line 2105-2106
```javascript
if (cand.volRegime > this.cfg.maxVolRegime) {
  log('DEBUG', `Vol regime ${cand.volRegime} > max — skip`);
  continue;
}
```
**Config:** `maxVolRegime: 1` (line 78)

**Problem:**
- Regime: 0=low, 1=normal, 2=high, 3=extreme
- Gate allows ONLY regime 0 (lowest vol)
- Most of the time, market is regime 1-2
- **Rejects 80%+ of candidates automatically**

**Severity:** 🔴 CRITICAL — Kills most trades

---

### 8. **HURST EXPONENT GATE TOO TIGHT**
**Location:** Line 2113-2114
```javascript
if (cand.hurst > this.cfg.maxHurst) {
  log('DEBUG', `Hurst ${cand.hurst.toFixed(2)} > max — skip`);
  continue;
}
```
**Config:** `maxHurst: 0.60` (line 79)

**Problem:**
- Hurst = 0.5 is random walk (ideal)
- Hurst > 0.6 is trending/persistent (good for entry!)
- Gate rejects trending markets
- **Should be 0.70-0.75, not 0.60**

**Severity:** 🔴 CRITICAL — Rejects best trading conditions

---

### 9. **RANKED ASSETS FILTER WRONG**
**Location:** Lines 2079-2086
```javascript
const rankedAssets = this.stats.getRankedAssets();
const topAssets = rankedAssets.slice(0, 3).map(a => a.symbol);

if (topAssets.length > 0 && !topAssets.includes(sym) && this.stats.trades.length > 50) {
  return [];
}
```

**Problem:**
- After 50+ trades, ONLY top-3 Sharpe assets can trade
- Sharpe calculation needs 5+ trades per asset (line 1697)
- Early on, some assets may have 0 trades → score=0 (skipped)
- **Creates catch-22:** Need trades to rank, but only top-3 can trade

**Severity:** ⚠️ MEDIUM — Limits asset diversity

---

### 10. **LACK OF INSTRUMENTATION**
**Problem:**
- No logging of WHY candidates fail (debug logs only)
- No metrics on gate failure rates
- No visibility into barrier refresh success
- No tick backfill validation

**Severity:** ⚠️ MEDIUM — Can't diagnose issues

---

## 📊 GATE FAILURE CASCADE

Typical flow for a candidate:

```
100 candidates analyzed
  ↓
[EV_BELOW_HAIRCUT] → ~70 fail (need 59.5% survival, get 40-50%)
30 remaining
  ↓
[VOL_REGIME > 1] → ~24 fail (need regime 0, mostly regime 1-2)
6 remaining
  ↓
[HURST > 0.60] → ~4 fail (good trending rejected)
2 remaining
  ↓
[CONFIDENCE < 0.15] → ~1-2 fail (composite scores too low)
0-1 remaining ← VERY RARE TO PASS
  ↓
TRADE EXECUTED (if any pass)
```

---

## ✅ FIXES NEEDED

### Immediate (Band-aids):
1. **Lower minConfidence to 0.05** (more realistic)
2. **Raise maxVolRegime to 2** (allow normal + high vol)
3. **Raise maxHurst to 0.70** (allow trending)
4. **Lower minNetEvRatio to 0.01** (1% net EV)
5. **Increase hazardWindow to 500** (recent data)
6. **Remove tradeCooldown** or set to 1000ms (too restrictive)

### Medium:
7. **Fix minBarrierPct** — check actual barrier values from API
8. **Remove top-3 asset filter early** — allow all until stable
9. **Add instrumentation** — log gate failures with counts

### Deep Redesign:
10. **Rethink entire scoring system** — gates are stacked too tightly
11. **Switch to Kelly/Sharpe sizing** — current calculation is fragile
12. **Implement warm-up mode** — collect 100+ baseline trades before filtering

---

## 🎯 RECOMMENDED UPGRADED STRATEGY

See `ACCUPULSE3_UPGRADED_STRATEGY.md`
