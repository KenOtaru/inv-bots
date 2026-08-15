# AccuPULSE3 v4.0 — Upgraded Efficient Strategy

## Philosophy
**Current:** Too conservative (gates stacked, 99% rejection rate)
**New:** Balanced efficiency—eliminate artificial gates, use adaptive risk management instead

---

## Core Changes

### 1. **GATE OVERHAUL**
Remove stacked gates. Replace with **adaptive thresholds** based on market regime:

#### Old (Fails):
```javascript
minConfidence: 0.15        // ← Rejects 80%+ of trades
maxVolRegime: 1            // ← Rejects 70% (only allow low vol)
maxHurst: 0.60             // ← Rejects trending (backwards!)
minNetEvRatio: 0.02        // ← Needs 59.5% survival
hazardWindow: 250          // ← Stale data
```

#### New (Adaptive):
```javascript
// Adaptive confidence based on vol regime
minConfidence: {
  0: 0.08,     // low vol → stricter (good conditions, be selective)
  1: 0.05,     // normal vol → balanced
  2: 0.03,     // high vol → looser (harder to pass anyway)
  3: 0.01      // extreme → only obvious setups
}

// Allow all regimes, but adjust stake
maxVolRegime: 3            // ALLOW all (scale stake instead)

// Hurst: INVERT logic
minHurst: 0.55             // Require at least slight persistence
maxHurst: 0.70             // But not too much (mean reversion still works)

// EV gate: Realistic for 20-tick holds
minNetEvRatio: 0.005       // 0.5% net EV (achievable)

// Bigger hazard window = fresher analysis
hazardWindow: 600          // 100 minutes for R_10
```

---

### 2. **DYNAMIC STAKE SIZING (Enhanced Phase 2)**

**Current:**
- Flat Kelly with vol multiplier
- No account balance tracking
- No drawdown adaptation

**New - Multi-factor Sizing:**

```javascript
computeStakeV2(balance, equity_peak, baseStake, confidence, vol_regime, win_rate) {
  // 1. KELLY EDGE (from recent trades)
  const kelly_edge = computeKellyEdge(last_100_trades);
  const kelly_mult = 1 + (0.20 * kelly_edge);  // 20% Kelly
  
  // 2. CONFIDENCE BOOST
  const confidence_mult = Math.pow(confidence / 0.10, 0.5);  // Square root scaling
  
  // 3. VOL REGIME MULTIPLIER (new: scales up in high vol)
  const vol_mult = {
    0: 1.2,    // Low vol: scale UP (predictable, can be aggressive)
    1: 1.0,    // Normal: baseline
    2: 0.8,    // High vol: scale DOWN (risk up, reduce size)
    3: 0.4     // Extreme: very defensive
  }[vol_regime];
  
  // 4. WIN-RATE MULTIPLIER (recent performance)
  let wr_mult = 1.0;
  if (win_rate > 0.55) {
    wr_mult = Math.min(1.8, 1.0 + (win_rate - 0.50) * 1.6);
  } else if (win_rate < 0.45) {
    wr_mult = Math.max(0.4, 1.0 - (0.50 - win_rate) * 1.2);
  }
  
  // 5. DRAWDOWN BRAKE (new: adaptive to losing trades)
  const dd = (equity_peak - balance) / equity_peak;
  let dd_mult = 1.0;
  if (dd > 0.10) dd_mult = 0.7;    // 10% DD: 30% reduction
  if (dd > 0.20) dd_mult = 0.4;    // 20% DD: 60% reduction
  if (dd > 0.30) dd_mult = 0.1;    // 30% DD: almost stop
  
  // 6. STREAK MULTIPLIER
  let streak_mult = 1.0;
  if (loss_streak >= 3) streak_mult = 0.5;   // After 3 losses: halve stake
  if (loss_streak >= 5) streak_mult = 0.2;   // After 5 losses: 80% reduction
  
  // FINAL STAKE
  const stake = baseStake 
    * kelly_mult 
    * confidence_mult 
    * vol_mult 
    * wr_mult 
    * dd_mult 
    * streak_mult;
    
  // Hard caps
  return Math.max(
    baseStake * 0.3,           // Min: 30% base
    Math.min(baseStake * 3.0, stake)  // Max: 300% base
  );
}
```

**Benefits:**
- Low vol (predictable) → scale UP (less risky)
- High vol → scale DOWN (more risky)
- Winning streak → scale UP (momentum)
- Losing streak → scale DOWN (recovery mode)
- Large DD → near-stop (capital preservation)

---

### 3. **SMARTER ENTRY CONFIRMATION**

**Current:** Micro-structure check is weak (lines 1297-1322)

**New - Multi-confirmation:**

```javascript
async confirmEntry(symbol, analysis, ticks, proposal) {
  const checks = {
    // 1. Volatility regime match
    vol_check: () => {
      const recent_vol = computeRecentVol(ticks, 20);
      const vol_percentile = getVolPercentile(symbol, recent_vol);
      return vol_percentile > 0.2;  // At least 20th percentile
    },
    
    // 2. Barrier sufficiency
    barrier_check: () => {
      const barrier_pct = getBarrierPct(proposal);
      return barrier_pct >= 0.015;  // 1.5% minimum (realistic)
    },
    
    // 3. EV sufficiency
    ev_check: () => {
      return analysis.model.conservativeEV >= 0.005;  // 0.5% net EV
    },
    
    // 4. Trend alignment
    trend_check: () => {
      return analysis.trendDirection !== 'neutral' || analysis.trendScore > 0.5;
    },
    
    // 5. Recent momentum (new)
    momentum_check: () => {
      const recent = ticks.slice(-10);
      const returns = recent.map((t, i) => 
        i === 0 ? 0 : Math.log(t.quote / recent[i-1].quote)
      );
      const momentum = returns.reduce((a, b) => a + b, 0);
      return Math.abs(momentum) > 0.0001;  // Non-flat
    },
    
    // 6. Survival pattern (new)
    survival_check: () => {
      const survival_mean = analysis.survivalMean;
      return survival_mean > 15;  // Average 15+ ticks stay in
    }
  };
  
  const passed = Object.values(checks).filter(f => f()).length;
  const required = 4;  // Need 4/6 checks to pass
  
  return {
    approved: passed >= required,
    passed,
    required,
    details: Object.entries(checks).map(([name, fn]) => ({
      check: name,
      result: fn()
    }))
  };
}
```

---

### 4. **BETTER EXIT STRATEGY**

**Current:** 
- Single take-profit based on EV
- No trailing stop
- No scale-out on wins

**New - Tiered Exit:**

```javascript
// TAKE PROFIT TIERS (for 20-tick holds)
const tp_tiers = {
  quick_win: {
    ticks_elapsed: 3,
    profit_target: stake * 0.15,  // 15% on 3 ticks
  },
  early_win: {
    ticks_elapsed: 8,
    profit_target: stake * 0.25,  // 25% on 8 ticks
  },
  mid_win: {
    ticks_elapsed: 15,
    profit_target: stake * 0.35,  // 35% on 15 ticks
  },
  full_hold: {
    ticks_elapsed: 20,
    profit_target: stake * Math.max(0.10, ev * 4),  // EV-based
  }
};

// STOP LOSS (dynamic)
const stop_loss = {
  // After 5 ticks with no progress
  5_ticks: stake * 0.10,   // Stop if down 10%
  // After 10 ticks
  10_ticks: stake * 0.20,  // Stop if down 20%
  // Safety stop
  hard_stop: stake * 0.30  // Never lose >30% per trade
};

// SCALE OUT (if supports partial exits)
if (current_profit >= tp_tiers.early_win.profit_target && ticks_held >= 5) {
  // Sell 30% of position
  sellFraction(0.30);
}
```

---

### 5. **ASSET ROTATION & CORRELATION**

**Current:**
- Top-3 Sharpe only after 50 trades
- No correlation check between open positions

**New:**

```javascript
selectBestAsset(analyses, open_positions) {
  // Filter by Sharpe (but allow all in first 30 trades)
  let candidates = analyses;
  
  if (this.stats.trades.length > 30) {
    const ranked = this.stats.getRankedAssets();
    const top_families = [...new Set(ranked.slice(0, 3).map(a => a.family))];
    candidates = analyses.filter(a => top_families.includes(a.family));
  }
  
  // Correlation filter: don't open correlated pairs
  const open_families = open_positions.map(t => getFamily(t.symbol));
  candidates = candidates.filter(c => {
    const correlation = computeCorrelation(c.symbol, open_families);
    return correlation < 0.80;  // Allow some correlation
  });
  
  // Sort by score
  return candidates.sort((a, b) => b.score - a.score)[0];
}
```

---

### 6. **WARM-UP MODE (New)**

**Problem:** Early trades have no historical data for ranking/filtering

**Solution:**

```javascript
const MODES = {
  WARMUP: {
    duration: 30,        // First 30 trades
    gates: {
      minConfidence: 0.01,
      maxVolRegime: 3,
      minNetEvRatio: 0.003
    },
    assetFilter: false,  // Trade all assets
    maxOpenTrades: 5,    // Collect data faster
  },
  BALANCED: {
    duration: 300,       // Trades 30-300
    gates: {
      minConfidence: 0.05,
      maxVolRegime: 2,
      minNetEvRatio: 0.005
    },
    assetFilter: true,   // Use top assets
    maxOpenTrades: 3,
  },
  OPTIMIZED: {
    duration: Infinity,  // After 300+ trades
    gates: {
      minConfidence: 0.08,
      maxVolRegime: 1,
      minNetEvRatio: 0.008
    },
    assetFilter: true,
    maxOpenTrades: 2,
  }
};

getCurrentMode() {
  const count = this.stats.trades.length;
  if (count < 30) return MODES.WARMUP;
  if (count < 300) return MODES.BALANCED;
  return MODES.OPTIMIZED;
}
```

**Benefits:**
- First 30 trades: aggressive (build baseline)
- Next 270 trades: balanced (learn preferences)
- Then: optimized (stable, proven patterns)

---

### 7. **STREAK RECOVERY (Improved Phase 5)**

**Current:**
- Pause after 3 losses
- Reduce stake to 50%

**New - Smarter Recovery:**

```javascript
updateStreakRecovery() {
  if (this.win_streak >= 5) {
    // Reset any recovery penalties
    this.recovery_mode = false;
    return;
  }
  
  if (this.loss_streak >= 3) {
    if (!this.recovery_mode) {
      this.recovery_mode = true;
      this.recovery_start = Date.now();
      log('WARN', `Entering recovery mode (loss streak: ${this.loss_streak})`);
      telegram.send(`🔄 Recovery mode activated\nLoss streak: ${this.loss_streak}\nReducing to 40% stake`);
    }
  }
  
  // Exit recovery after 10 wins in a row OR 2 hours
  if (this.win_streak >= 10 || Date.now() - this.recovery_start > 7200000) {
    this.recovery_mode = false;
    this.loss_streak = 0;
    log('INFO', 'Recovery mode complete');
    telegram.send(`✅ Recovery complete\nBack to normal operations`);
  }
}

currentStakeMultiplier() {
  if (this.recovery_mode) {
    // Graduated recovery: 40% → 60% → 80% → 100%
    const ticks = this.stats.trades.slice(-20);
    const recent_wr = ticks.filter(t => t.status === 'won').length / ticks.length;
    if (recent_wr > 0.70) return 1.0;   // 100%
    if (recent_wr > 0.60) return 0.80;  // 80%
    if (recent_wr > 0.50) return 0.60;  // 60%
    return 0.40;                         // 40%
  }
  return 1.0;
}
```

---

### 8. **BETTER LOGGING & METRICS**

**Add to every analysis cycle:**

```javascript
logAnalysisCycle(cycle_id, analyses, ranked, best, decision) {
  const metrics = {
    cycle: cycle_id,
    timestamp: Date.now(),
    
    // Funnel metrics
    total_candidates: analyses.length,
    passed_ev_gate: analyses.filter(a => a.model?.ok).length,
    passed_confidence_gate: analyses.filter(a => a.score >= this.cfg.minConfidence).length,
    passed_vol_gate: analyses.filter(a => a.volRegime <= this.cfg.maxVolRegime).length,
    passed_hurst_gate: analyses.filter(a => a.hurst <= this.cfg.maxHurst).length,
    
    // Winner info
    best_symbol: best?.symbol,
    best_score: best?.score,
    best_ev: best?.model?.conservativeEV,
    best_vol_regime: best?.volRegimeLabel,
    
    // Trading state
    open_trades: this.exec.count(),
    balance: this.lastBalance,
    win_streak: this.winStreak,
    loss_streak: this.lossStreak,
    
    // Decision
    decision: decision,  // 'TRADE' | 'SKIP' | 'BLOCKED'
  };
  
  // Append to metrics file
  fs.appendFileSync('accuPULSE3_analysis.jsonl', JSON.stringify(metrics) + '\n');
}
```

**Dashboard query:**
```bash
# See rejection funnel
jq -s 'group_by(.cycle_id) | map({
  total: .[0].total_candidates,
  ev_pass: .[0].passed_ev_gate,
  conf_pass: .[0].passed_confidence_gate,
  vol_pass: .[0].passed_vol_gate,
  hurst_pass: .[0].passed_hurst_gate,
  traded: (.[0].decision == "TRADE")
})' accuPULSE3_analysis.jsonl | tail -50
```

---

## Config Defaults (v4.0)

```javascript
const CONFIG = {
  // Entry gates (adaptive)
  minConfidence: 0.05,
  maxVolRegime: 2,        // Allow normal + high vol
  maxHurst: 0.70,         // Allow trending
  minNetEvRatio: 0.005,   // 0.5% net EV
  minBarrierPct: 0.015,   // 1.5% barrier
  hazardWindow: 600,      // 100 min for R_10
  
  // Sizing
  baseStake: 1.0,
  kellyFraction: 0.20,    // 20% Kelly
  maxStakeMultiplier: 3.0,
  minStakeMultiplier: 0.3,
  
  // Exit
  scaleOutLevels: [0.25, 0.50, 0.75, 1.0],
  scaleOutProfits: [0.15, 0.25, 0.35, 0.50],
  
  // Risk
  maxOpenTrades: 3,
  dailyMaxLoss: 500,
  dailyMaxTrades: 100,
  streakReduceStake: 3,   // Reduce at 3 losses
  streakStopDay: 10,      // Stop at 10 losses
  
  // Timing
  analysisIntervalMs: 3000,   // 3 seconds (faster)
  tradeCooldownMs: 500,       // 500ms (less restrictive)
  barrierRefreshMs: 30000,    // 30 seconds
};
```

---

## Expected Improvements

| Metric | Current | Expected (v4.0) |
|--------|---------|-----------------|
| Trades/48h | 1 | 20-50 |
| Win rate | ~55% | 50-60% |
| Profit factor | Low | 1.5-2.5x |
| Drawdown | N/A | <15% |
| Recovery time | N/A | <1 day |

---

## Implementation Priority

1. **Phase 1:** Update gate thresholds (10 min, immediate relief)
2. **Phase 2:** Add adaptive stake sizing (30 min, big impact)
3. **Phase 3:** Improve exit logic (20 min, better P&L)
4. **Phase 4:** Add warm-up mode (15 min, safer ramp)
5. **Phase 5:** Better logging (10 min, visibility)
6. **Phase 6:** Streak recovery overhaul (20 min, capital preservation)

**Total time: ~1.5 hours to implement full v4.0**
