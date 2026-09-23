# Comprehensive Plan: bizWillRFv2 Binance Options Bot

**Date:** 2026-09-23  
**Status:** APPROVED — implementing (2026-09-23)  
**Derived from:** `bizWillRFv2.js` (WPR strategy reference) + `bizWillRFv2_BINANCE_OPTIONS.js` (existing Binance options foundation)

---

---

## 1. Executive Summary

Create **`bizWillRFv2_Binance.js`** — a new trading bot that ports the proven WPR strategy from `bizWillRFv2.js` onto Binance's Options API, using API Key + Secret for authentication. The bot trades European PUT/CALL options on all available Binance underlyings and offers the user a **choice of entry mode**:

| Mode | Description |
|------|-------------|
| **WPR Mode** | Identical Williams %R crossover logic from the reference `bizWillRFv2.js` (period 7, oversold -80 → CALLE, overbought -20 → PUTE). Calculated from closed 1-minute Binance spot candles. |
| **Prediction Mode** | Uses Binance's options chain data to select a contract whose implied probability matches a user-configurable **prediction percentage** (e.g., 70% probability → the contract with delta closest to ±0.70). |

The user toggles between modes via a single config value (`TRADE_MODE: 'wpr' | 'prediction'`). Both modes share the same martingale, session management, state persistence, and Telegram notification system.

---

## 2. Background Context

### 2.1 Existing Binance Options Bot (`bizWillRFv2_BINANCE_OPTIONS.js`)
The project already has a functioning Binance Options bot with:
- WPR signal on 1m spot candles → discovers liquid CALL/PUT contracts → places BUY LIMIT FOK orders
- Env-var auth: `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_OPTIONS_PAPER_MODE`
- Risk manager: premium caps, position limits, daily loss limits
- Position monitor: take-profit (100% premium), stop-loss (50% premium), 60s time exit
- Telegram notifier with summary reports
- Paper mode (no credentials needed)

**Gap this plan fills:** That bot hardcodes WPR-only entry and uses env-var auth. This plan adds: (a) config-driven mode selection (WPR vs Prediction), (b) prediction percentage control, (c) direct CONFIG-based auth (matching the user's preference for hardcoded credentials like the Deriv bots), (d) richer per-mode signal reporting.

### 2.2 What Binance "Prediction" Means
Binance does not expose a native "Prediction Market" or "BUY UP/DOWN" binary product via API (confirmed by research). In the Binance Token Manager context, "Prediction" likely refers to **options delta/probability selection** — choosing a CALL or PUT contract whose implied probability (derived from delta) matches a target percentage. This plan implements it as:
- **Prediction % = target delta magnitude** (e.g., 70% → delta ≈ ±0.70, which corresponds to ~70% implied probability in the Black-Scholes approximation)
- The bot scans all available CALL/PUT contracts, scores them by proximity to the target delta, and selects the best match

### 2.3 Reusable Components (Strategy Layer is Exchange-Agnostic)
From the architecture study, these components from `bizWillRFv2.js` are 100% reusable with no Deriv-specific dependencies:

| Component | Reuse Strategy |
|-----------|---------------|
| `TechnicalIndicators.calculateWPR` | Direct port — formula identical |
| `SignalManager.checkBuySignal/checkSellSignal/analyze` | Direct port |
| `StakeCalculator` (martingale + extra levels) | Direct port with Binance-adapted stake units |
| `TradeHistoryManager` | Direct port |
| `StatePersistence` | Direct port (state file name changes) |
| `TelegramService` | Direct port (all notification methods) |
| `SessionManager` | Direct port |
| `TradingSessionManager` | Direct port (GMT clock) |
| `BacktestEngine` | Direct port (candle source changes) |
| Guard checks (position limits, session gating, PT/SL) | Direct port |

**Must be replaced:** `RestClient`, `DerivCandleFetcher`, `ConnectionManager`, `IndexBot` — all Deriv-specific.

---

## 3. Architecture Design

### 3.1 High-Level Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    BOT STARTUP                              │
│  1. Load CONFIG (mode, tokens, assets, stake params)        │
│  2. Authenticate with Binance (API Key + HMAC-SHA256)      │
│  3. Load/sync Options Universe (all PUT/CALL contracts)     │
│  4. Initialize per-asset state (pools, martingale, etc.)    │
│  5. Start Telegram notifier + timers                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              MAIN LOOP (pollSeconds interval)               │
│                                                             │
│  FOR each active underlying:                                │
│    ┌───────────────────────────────────────────────────┐    │
│    │  FETCH: 1m spot klines from Binance REST API     │    │
│    │  (or WebSocket stream for live updates)           │    │
│    └──────────────────┬────────────────────────────────┘    │
│                       │                                    │
│                       ▼                                    │
│    ┌───────────────────────────────────────────────────┐    │
│    │  CONFIRMED candle close detected                  │    │
│    └──────────────────┬────────────────────────────────┘    │
│                       │                                    │
│            ┌──────────┴──────────┐                          │
│            ▼                     ▼                          │
│    ┌──────────────┐   ┌───────────────────┐                │
│    │  WPR MODE    │   │ PREDICTION MODE   │                │
│    │              │   │                   │                │
│    │ Calculate    │   │ Use target        │                │
│    │ WPR on closed│   │ prediction % to   │                │
│    │ candles      │   │ select contract   │                │
│    │              │   │ from universe     │                │
│    │ Check cross: │   │                   │                │
│    │ prev<=os &   │   │ Filter liquid     │                │
│    │ cur>os →CALLE│   │ contracts by      │                │
│    │ prev>=ob &   │   │ delta proximity   │                │
│    │ cur<ob →PUTE │   │ to target %       │                │
│    └──────┬───────┘   └────────┬──────────┘                │
│           │                    │                           │
│           └────────┬───────────┘                           │
│                    ▼                                       │
│    ┌───────────────────────────────────────────────────┐    │
│    │  SIGNAL FOUND → Direction (CALLE/PUTE or BUY/SELL)│    │
│    └──────────────────┬────────────────────────────────┘    │
│                       │                                    │
│                       ▼                                    │
│    ┌───────────────────────────────────────────────────┐    │
│    │  GUARD CHECKS (session, positions, pool, PT/SL)   │    │
│    └──────────────────┬────────────────────────────────┘    │
│                       │                                    │
│                       ▼                                    │
│    ┌───────────────────────────────────────────────────┐    │
│    │  STAKE CALCULATION (martingale ladder)            │    │
│    └──────────────────┬────────────────────────────────┘    │
│                       │                                    │
│                       ▼                                    │
│    ┌───────────────────────────────────────────────────┐    │
│    │  PLACE ORDER via Binance REST API                 │    │
│    │  (BUY LIMIT FOK for CALL/PUT option)              │    │
│    └──────────────────┬────────────────────────────────┘    │
│                       │                                    │
│                       ▼                                    │
│    ┌───────────────────────────────────────────────────┐    │
│    │  START MONITORING (position exit + martingale)    │    │
│    │  Telegram alert sent                              │    │
│    └───────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Component Map

| New Component | Purpose | Deriv Equivalent |
|---------------|---------|-----------------|
| `BinanceAuth` | API Key + HMAC-SHA256 signing, timestamp, recvWindow | `RestClient` (PAT/OTP flow) |
| `BinanceCandleFetcher` | REST `/api/v3/klines` + WebSocket `{symbol}@kline_1m` | `DerivCandleFetcher` |
| `BinanceOptionsUniverse` | Fetch/discover all PUT/CALL contracts, filter liquid, calculate delta proxy from greeks | (new — no Deriv equivalent) |
| `BinanceOrderExecutor` | Place BUY/SELL LIMIT FOK orders, cancel, query status | `ConnectionManager._executeBuy` |
| `SignalStrategy` (interface) | Abstract entry: WPR mode OR Prediction mode | `SignalManager` |
| `PredictionSelector` | Score contracts by delta proximity to prediction % | (new — no Deriv equivalent) |
| `OptionsPositionMonitor` | Monitor exits (TP/SL/time), track realized P/L | `SessionManager` + watchdog |
| `IndexBotBinance` | Main orchestrator (replaces `IndexBot`) | `IndexBot` |

---

## 4. Binance API Integration

### 4.1 Authentication

Following the existing `lib/binance-options-client.js` HMAC pattern:

```
AUTH FLOW:
  1. CONFIG stores BINANCE_API_KEY and BINANCE_SECRET (hardcoded, like existing Deriv tokens)
     OR loaded from env vars (BINANCE_API_KEY, BINANCE_SECRET) — user chooses
  2. On startup: sync server time via GET /api/v3/time
  3. Sign every request with HMAC-SHA256:
     signature = HMAC_SHA256(secret, queryString)
  4. Headers: X-MBX-APIKEY (API key), timestamp (ms), recvWindow (5000)
  5. No OAuth/OTP flow needed (unlike Deriv PAT tokens)
```

### 4.2 Required Endpoints

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/v3/time` | GET | Sync server clock | Public |
| `/api/v3/exchangeInfo` | GET | Discover all symbols + options contract info | Public |
| `/api/v3/klines` | GET | Historical 1m OHLCV candles for WPR | Public |
| `/api/v3/ticker/price` | GET | Current mark price (fallback) | Public |
| `/api/v3/account` | GET | Balance check before order | Signed |
| `/api/v3/order` (POST) | Signed | Place BUY/SELL LIMIT FOK order | Signed |
| `/api/v3/order` (GET) | Signed | Query order status (monitoring) | Signed |
| `/api/v3/openOrders` | GET | Check all open orders | Signed |
| `/api/v3/myTrades` | GET | Filled trades (P/L reconciliation) | Signed |
| `/api/v3/order/test` | POST | Dry-run order (validation before live) | Signed |
| `wss://stream.binance.com:9443/ws/{symbol}@kline_1m` | WebSocket | Live candle stream (alternative to polling) | Public |

### 4.3 HMAC Signing Implementation

Reuse the proven pattern from `lib/binance-options-client.js`:

```javascript
const query = new URLSearchParams();
query.set('symbol', symbol);
query.set('side', side);          // 'BUY' or 'SELL'
query.set('type', 'LIMIT');
query.set('quantity', quantity);
query.set('price', price);
query.set('timeInForce', 'FOK');
query.set('timestamp', String(Date.now() + this.timeOffsetMs));
query.set('recvWindow', '5000');
query.set('signature', crypto.createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex'));
```

### 4.4 Order Placement for Options

```javascript
// BUY a CALL option:
POST /api/v3/order
  symbol: "BTC-24DEC31-45000-C"  (or whatever Binance assigns)
  side: "BUY"
  type: "LIMIT"
  quantity: <computed from stake/premium>
  price: <current ask>
  timeInForce: "FOK"

// SELL a PUT option (or buy a PUT):
POST /api/v3/order  
  side: "BUY"  // buying a PUT option = "down" prediction
  type: "LIMIT"
  ...
```

**Note:** Binance Options orders use option symbol format `STRIKE-EXPIRY-DIRECTION` (e.g., `BTC-24DEC31-45000-C` for a Call, `BTC-24DEC31-45000-P` for a Put). The Options Universe component discovers these symbols.

---

## 5. Mode Selection: WPR vs Prediction

### 5.1 Configuration

```javascript
// New CONFIG entries:
TRADE_MODE: 'wpr',           // 'wpr' or 'prediction' — user selects
PREDICTION_PERCENTAGE: 70,   // Target probability/delta (10-90) — used ONLY in prediction mode
```

### 5.2 WPR Mode (Default)

**Behavior:** Identical to `bizWillRFv2.js` — calculate WPR on closed 1m Binance spot candles, fire CALLE/PUTE on threshold crosses.

**Implementation:** Port `SignalManager` directly. The only change is the candle data source:
- Deriv: `ticks_history` WebSocket → `epoch`/`open_time` semantics
- Binance: `/api/v3/klines?interval=1m&limit=100` → `[openTime, open, high, low, close, closeTime]` array format

**WPR Parameters (unchanged):**
| Parameter | Value |
|-----------|-------|
| WPR_PERIOD | 7 |
| WPR_OVERBOUGHT | -20 |
| WPR_OVERSOLD | -80 |
| GRANULARITY | 60 seconds (1m candles) |

**Signal mapping:**
- CALLE signal → BUY a CALL option
- PUTE signal → BUY a PUT option

### 5.3 Prediction Mode

**Behavior:** When a signal fires (or continuously during evaluation), the bot scans all liquid PUT/CALL options for the configured underlyings and selects the contract whose implied probability (delta) best matches `PREDICTION_PERCENTAGE`.

```
PREDICTION MODE FLOW:
  1. WPR signal fires (CALLE or PUTE) — OR — user can configure continuous prediction mode
  2. Filter Options Universe for:
     - Contracts within expiry window (e.g., next 7 days)
     - Contracts with bid/ask spread < X% (liquidity filter)
     - CALL contracts for CALLE signal / PUT contracts for PUTE signal
  3. For each qualifying contract:
     - Calculate delta proxy from greeks (if available) OR
     - Use moneyness: delta ≈ N(d1) where d1 from Black-Scholes using spot, strike, implied vol, time-to-expiry, risk-free rate
     - OR simpler: use Binance's reported greeks if available via /eapi/v1/mark or /eapi/v1/open-interest
  4. Score = |contract_delta| - (PREDICTION_PERCENTAGE / 100)
  5. Select contract with score closest to 0 (delta ≈ target%)
  6. Place order for selected contract
```

**Prediction Percentage Interpretation:**
- 70% → select a contract with delta ≈ ±0.70 (high probability, near-the-money or slightly ITM)
- 50% → delta ≈ ±0.50 (at-the-money, ~50/50 probability)
- 90% → delta ≈ ±0.90 (deep ITM, very high probability but low payout)

**Important Note for User:** Binance does NOT have a literal "prediction percentage" parameter in any API endpoint. This feature is implemented by the bot in application logic — matching contract deltas to the user's desired probability level.

### 5.4 Mode Switching

```javascript
// In executeNextTrade():
if (CONFIG.TRADE_MODE === 'prediction') {
    const selected = await PredictionSelector.bestContract({
        direction,                          // CALLE or PUTE from WPR signal
        targetDelta: CONFIG.PREDICTION_PERCENTAGE / 100,
        underlyings: CONFIG.ACTIVE_ASSETS,
        maxSpreadPct: CONFIG.MAX_SPREAD_PCT, // liquidity filter
        maxExpiryDays: CONFIG.MAX_EXPIRY_DAYS // expiry window
    });
    if (!selected) return log('[SKIP] no contract matched prediction %');
    return executeBuy({
        symbol: selected.symbol,
        direction,                          // determines CALL vs PUT order side
        stake: risk.stakeFor(selected.underlying),
        optionType: selected.type,          // 'CALL' or 'PUT'
        entryPrice: selected.ask,
        predictionPct: CONFIG.PREDICTION_PERCENTAGE,
        delta: selected.delta
    });
} else {
    // WPR mode — use existing WPR signal → direct contract selection
    return executeBuyWPR(direction, stake);
}
```

---

## 6. Asset Configuration for Binance Options

### 6.1 Active Assets (Underlyings)

Unlike Deriv's fixed synthetic indices, Binance options underlyings are real spot assets. Default:

```javascript
ACTIVE_UNDERLYINGS: ['BTCUSDT', 'ETHUSDT'],  // Binance options available for BTC and ETH
```

User-configurable — the bot can trade any asset with active options markets on Binance.

### 6.2 Options Universe Discovery

On startup, the bot fetches all available options contracts:

```javascript
// From exchangeInfo or dedicated options endpoint:
// Filter: contracts with status ACTIVE, underlyings in ACTIVE_UNDERLYINGS
// Store: { symbol, underlying, strike, expiry, right: 'CALL'|'PUT', 
//          lastPrice, bid, ask, contractType, deliveryDate }
// Refresh: every 15 minutes (matching existing bot) or on-demand before trade
```

### 6.3 Per-Asset State (mirrors Deriv architecture)

Each underlying gets its own independent state (identical pattern to Deriv per-asset independence):

```javascript
{
  // Strategy state
  closedCandles: [],           // Recent 1m candles for WPR
  wpr: null,                   // Current WPR value
  prevWpr: null,               // Previous WPR value (for cross detection)
  
  // Pool & stake state
  investmentRemaining: 1000,   // Per-underlying pool (configurable)
  currentStake: 0.50,          // Current stake amount
  baseStake: 0.50,             // Initial stake
  martingaleLevel: 0,          // Current martingale level
  
  // Position tracking
  activePositions: [],         // Open options positions
  isRecovery: false,           // In martingale recovery?
  consecutiveLosses: 0,        // Consecutive losses (for mode switch)
  consecutiveWins: 0,
  
  // Trade counters
  tradesCount: 0, winsCount: 0, lossesCount: 0, netPL: 0,
  
  // Lock flags
  canTrade: true, stopped: false, exclusiveLock: false,
  
  // Prediction mode cache
  lastPredictionSelection: null // Last contract selected by prediction %
}
```

---

## 7. New CONFIG Structure

All config in a single `CONFIG` object (matching existing Deriv bot pattern). Env-var overrides supported (boolEnv/strEnv/numEnv pattern from project memory).

```javascript
const CONFIG = {
  // ── Binance Auth ──
  BINANCE_API_KEY:    'YOUR_API_KEY_HERE',     // Hardcoded (like Deriv tokens)
  BINANCE_SECRET:     'YOUR_SECRET_HERE',      // Hardcoded
  BASE_URL:           'https://eapi.binance.com', // Options API base
  SPOT_BASE_URL:      'https://api.binance.com',  // Klines/auth endpoint
  PAPER_MODE:         true,                    // true=dry-run, false=live
  
  // ── Mode Selection ──
  TRADE_MODE:         'wpr',                   // 'wpr' or 'prediction'
  PREDICTION_PERCENTAGE: 70,                   // Target delta/probability (10-90)
  
  // ── Prediction Mode Filters ──
  MAX_SPREAD_PCT:     5,                       // Max bid-ask spread % (liquidity)
  MAX_EXPIRY_DAYS:    14,                      // Max days to expiry
  MIN_LIQUIDITY:      1000,                    // Min open interest (optional)
  
  // ── WPR Strategy (from bizWillRFv2.js) ──
  WPR_PERIOD:         7,
  WPR_OVERBOUGHT:     -20,
  WPR_OVERSOLD:       -80,
  GRANULARITY:        60,
  TIMEFRAME_LABEL:    '1m',
  CANDLES_TO_LOAD:    100,
  MAX_CANDLES_STORED: 100,
  DURATION:           1,
  DURATION_UNIT:      'm',
  
  // ── General ──
  ACTIVE_UNDERLYINGS: ['BTCUSDT', 'ETHUSDT'],
  DEBUG_MODE:         true,
  POLL_SECONDS:       30,                      // Evaluation loop interval
  
  // ── Telegram ──
  TELEGRAM_ENABLED:   true,
  TELEGRAM_BOT_TOKEN: 'YOUR_BOT_TOKEN',
  TELEGRAM_CHAT_ID:   'YOUR_CHAT_ID',
  
  // ── Session Management (from bizWillRFv2.js) ──
  USE_TRADING_SESSIONS: true,
  SESSIONS: [{ LONDON_OPEN: 1, LONDON_CLOSE: 17 }, { NY_OPEN: 12, NY_CLOSE: 23 }],
  MAX_OPEN_POSITIONS_PER_UNDERLYING: 1,
  MAX_TOTAL_POSITIONS: 15,
  
  // ── Risk ──
  MAX_DAILY_LOSS_USDT: 500,
  MAX_PREMIUM_USDT: 1000,                       // Per-position premium cap
  
  // ── Per-Underlying Defaults (per-asset config) ──
  // ... (mirrors DEFAULT_ASSET_CONFIG from bizWillRFv2.js)
  // INITIAL_STAKE, INVESTMENT_AMOUNT, MARTINGALE_MULTIPLIER, etc.
};
```

---

## 8. Signal-to-Order Mapping

### 8.1 WPR Mode

| WPR Signal | Deriv Equivalent | Binance Order |
|------------|-----------------|---------------|
| CALLE (WPR crosses above -80) | BUY (CALLE) | BUY a CALL option |
| PUTE (WPR crosses below -20) | SELL (PUTE) | BUY a PUT option |

```javascript
// WPR → Direction mapping:
function wprToOrderSide(wprSignal) {
  return wprSignal === 'CALLE'
    ? { side: 'BUY', optionType: 'CALL' }   // Buy Call = predicting rise
    : { side: 'BUY', optionType: 'PUT' };   // Buy Put = predicting fall
}
```

**Note:** In Binance Options, you BUY both Calls and Puts (you're purchasing the option contract). The `side` in the order is always `BUY`; the option type (`CALL`/`PUT`) determines direction.

### 8.2 Prediction Mode

| WPR Signal | Prediction % | Action |
|------------|-------------|--------|
| CALLE (WPR > -80) | 70% | Find CALL contract with delta ≈ +0.70 → BUY |
| PUTE (WPR < -20) | 70% | Find PUT contract with delta ≈ -0.70 → BUY |
| CALLE | 30% | Find CALL contract with delta ≈ +0.30 → BUY (lower probability, higher payout) |
| PUTE | 90% | Find PUT contract with delta ≈ -0.90 → BUY (high probability, lower payout) |

### 8.3 Contract Selection (Prediction Mode)

```javascript
async function selectContract(direction, targetDelta, universe) {
  const candidates = universe.filter(c =>
    c.right === (direction === 'CALLE' ? 'CALL' : 'PUT') &&
    c.status === 'TRADING' &&
    c.ask > 0 &&                                          // Has a price
    Math.abs(c.ask - c.bid) / c.ask < CONFIG.MAX_SPREAD_PCT / 100 &&  // Liquid
    c.expiryDate - Date.now() < CONFIG.MAX_EXPIRY_DAYS * 86400000    // Not too far
  );
  
  if (candidates.length === 0) return null;
  
  // Score by delta proximity to target (lower = better)
  // Delta approximation: from Binance greeks if available, or Black-Scholes estimate
  for (const c of candidates) {
    c.delta = estimateDelta(c);  // From greeks or BS model
    c.score = Math.abs(Math.abs(c.delta) - targetDelta);
  }
  
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];  // Best match
}
```

---

## 9. Trade Lifecycle

### 9.1 Complete Flow

```
[Candle Close Event]
  │
  ├─ WPR Mode: Calculate WPR on closed candles → detect cross
  ├─ Prediction Mode: WPR signal triggers contract search
  │
  ▼
[Signal: direction = CALLE | PUTE]
  │
  ├─ Guard Checks:
  │   ├─ Underlying state exists
  │   ├─ canTrade === true
  │   ├─ Trading session active (GMT clock)
  │   ├─ Underlying not stopped
  │   ├─ Total positions < MAX_TOTAL_POSITIONS
  │   ├─ This underlying's positions < MAX_OPEN_PER_UNDERLYING
  │   ├─ isAuthorized (Binance auth OK)
  │   ├─ currentStake <= investmentRemaining (pool check)
  │   └─ PT/SL not hit
  │
  ▼
[SignalManager.analyze() returns { shouldTrade, direction, mode, details }]
  │
  ├─ WPR Mode: details = { wpr, prevWpr, mode: 'wpr' }
  ├─ Prediction Mode: details = { predictionPct, selectedContract, delta, mode: 'prediction' }
  │
  ▼
[StakeCalculator.calculate(symbol, martingaleLevel, investmentRemaining)]
  │
  ▼
[Mode-specific Order Construction]
  ├─ WPR: { symbol: contractSymbol, side: 'BUY', type: 'LIMIT', 
  │         quantity, price: ask, timeInForce: 'FOK' }
  └─ Prediction: same structure but contract from PredictionSelector
  │
  ▼
[Execute Order via Binance REST API]
  ├─ Paper mode: log only, no order sent
  ├─ Live mode: POST /api/v3/order with HMAC signature
  ├─ On FILLED: create position record, reserve stake
  ├─ On REJECTED: log reason, do NOT advance martingale
  └─ On PARTIAL: retry or cancel (FOK should prevent this)
  │
  ▼
[Telegram Alert]
  ├─ WPR mode: "OPEN | BTCUSDT | CALLE | stake=$X | WPR=Y.ZZ → AA.BB | mode=wpr"
  └─ Prediction mode: "OPEN | BTCUSDT | CALL | stake=$X | pred=70% | delta=0.71 | contract=BTC-..."
  │
  ▼
[Position Monitoring]
  ├─ Check every monitorSeconds (5s from existing bot)
  ├─ Exit rules (first match):
  │   ├─ 100% premium take-profit
  │   ├─ 50% premium stop-loss
  │   └─ Time exit (configurable hold seconds)
  ├─ On exit: realized P/L → martingale advance/reset
  └─ Telegram WIN/LOSS alert
```

### 9.2 Martingale Rules (Shared)

Identical to `bizWillRFv2.js` StakeCalculator:
- **Win:** Reset to base stake (martingaleLevel = 0)
- **Loss:** Advance one level (stake × MARTINGALE_MULTIPLIER)
- **Max level:** CONFIG.MAX_MARTINGALE_LEVEL (default 1)
- **Extra levels:** CONFIG.CONTINUE_EXTRA_LEVELS with CONFIG.EXTRA_LEVEL_MULTIPLIERS
- **Reset:** After MAX_MARTINGALE_LEVEL + CONTINUE_EXTRA_LEVELS, reset to base

### 9.3 Exit/Settlement (Binance-Specific)

Binance Options contracts have fixed expiry times. Monitoring:

```javascript
// Position Monitor (every monitorSeconds):
async function monitorPosition(position) {
  const order = await client.queryOrder(position.orderId);
  
  // Check current premium (mark price × quantity)
  const currentPremium = order.cummulativeQuoteQty;  // approximate
  const pnl = currentPremium - position.entryPremium;
  
  // Exit rules (first match):
  if (pnl >= position.entryPremium)                   return exitFull(position, 'TP: 100% premium');
  if (pnl <= -position.entryPremium * 0.5)            return exitFull(position, 'SL: 50% premium loss');
  if (Date.now() - position.openedAt > exitHoldMs)    return exitFull(position, 'TIME EXIT');
  
  // Still holding → leave open, check again next cycle
}
```

---

## 10. State Persistence

### 10.1 State File

**File name:** `bizWillRFv2_Binance_state.json` (matching pattern from existing bots)

**Save frequency:** Every 5 seconds (auto-save) + on each trade result + on disconnect + on manual stop.

**State structure** (mirrors Deriv bot, adapted for Binance):

```json
{
  "savedAt": "timestamp",
  "tradeMode": "wpr",
  "predictionPercentage": 70,
  "capital": "sum of all underlying investmentRemaining",
  "session": { "profit, loss, netPL, tradesCount, winsCount, lossesCount, isActive, startTime" },
  "assets": {
    "BTCUSDT": {
      "closedCandles": [...],
      "wpr": null, "prevWpr": null,
      "investmentRemaining": 1000,
      "currentStake": 0.50, "baseStake": 0.50, "martingaleLevel": 0,
      "activePositions": [{ underlying, contractSymbol, direction, stake, entryPrice, 
                            contractType, orderId, openedAt, predictionPct, delta }],
      "consecutiveWins": 0, "consecutiveLosses": 0,
      "tradesCount": 0, "winsCount": 0, "lossesCount": 0, "netPL": 0,
      "canTrade": true, "stopped": false, "exclusiveLock": false,
      "lastPredictionSelection": null
    }
  }
}
```

**Stale state:** State older than 120 minutes → fresh start (matching existing pattern).

### 10.2 History File

**File name:** `bizWillRFv2_Binance_history.json`

Structure mirrors `TradeHistoryManager` format (daily + overall stats per asset).

---

## 11. Telegram Notifications

All notification methods from `bizWillRFv2.js`/`bizWillRFv2_dualToken_v2.js` are reused. Additional notification for Prediction mode:

### 11.1 Reused Notifications (port directly)

| Event | Content |
|-------|---------|
| `sendStartupMessage` | Bot config, strategy, mode, underlyings, overall stats |
| `sendTradeAlert` (OPEN) | Direction, stake, WPR signal or prediction %, martingale level, mode badge |
| `sendTradeAlert` (WIN) | Profit, stats, stake reset notice |
| `sendTradeAlert` (LOSS) | Loss, stats, recovery level, "waiting for new signal" |
| `sendHourlySummary` | Last hour + today + per-asset stats |
| `sendSessionSummary` | Session duration, trades, P/L |
| `checkDayChange` (END OF DAY) | End of day P/L, capital |
| `BOT STOPPED` | Per-token final stats |

### 11.2 New Prediction Mode Fields in Notifications

When `TRADE_MODE === 'prediction'`, all trade alerts include:

```
┌─ TRADE ALERT ──────────────────────────┐
│ MODE: PREDICTION                       │
│ Token: 💰 MAIN (or 💵 REGULAR)        │
│ Underlying: BTCUSDT                    │
│ Direction: CALL (predicting rise)      │
│ Prediction: 70%                        │
│ Selected Contract: BTC-24DEC31-45000-C │
│ Delta: 0.71                            │
│ Stake: $0.50                           │
│ Entry Price: $1,234.56                 │
│ WPR Context: prev=-85.20 → cur=-78.15 │
│ Martingale Level: 0                    │
└────────────────────────────────────────┘
```

---

## 12. Backtest Compatibility

The `BacktestEngine` from `bizWillRFv2.js` is ported directly. Backtest command:

```bash
node bizWillRFv2_Binance.js --backtest --asset BTCUSDT --days 30 --payout 0.90 --mode wpr
node bizWillRFv2_Binance.js --backtest --asset BTCUSDT --days 30 --payout 0.90 --mode prediction --prediction-pct 70
```

**Backtest candle source:** Binance REST `/api/v3/klines` (same format as live).

**Prediction mode backtest:** During backtest, delta estimation uses Black-Scholes with historical implied volatility (approximated from realized vol of underlying) since live greeks aren't available in historical data.

---

## 13. Risk Management Additions

Beyond the existing `bizWillRFv2.js` risk controls, Binance-specific guards:

| Guard | Purpose | Config Key |
|-------|---------|------------|
| Premium cap per position | Never risk more than X USDT on one option | `MAX_PREMIUM_USDT` |
| Daily loss limit | Stop trading when daily P/L hits threshold | `MAX_DAILY_LOSS_USDT` |
| Minimum contract liquidity | Avoid illiquid contracts | `MAX_SPREAD_PCT` + `MIN_LIQUIDITY` |
| Maximum expiry window | Don't trade long-dated illiquid options | `MAX_EXPIRY_DAYS` |
| Paper mode validation | Dry-run before live | `PAPER_MODE` |
| Order test before live | `/api/v3/order/test` dry run | Built into executor |

---

## 14. File Structure

```
C:\Users\kenot\Desktop\Investment AccumulatorBot\
├── bizWillRFv2_Binance.js              # MAIN BOT FILE (new)
├── lib/
│   ├── binance-auth.js                 # HMAC signing, timestamp sync (new)
│   ├── binance-candle-fetcher.js       # Klines REST + WebSocket (new)
│   ├── binance-options-universe.js     # Contract discovery & filtering (new)
│   ├── binance-order-executor.js       # Place/cancel/query orders (new)
│   ├── prediction-selector.js          # Delta-based contract selection (new)
│   └── binance-options-client.js       # (EXISTING — reuse from bizWillRFv2_BINANCE_OPTIONS)
├── config/
│   └── binance-bot.json                # Per-bot config (new, similar to binance-options.json)
├── .env.example                        # Env var template (new)
└── Existing shared libraries:
    ├── lib/telegram-notifier.js        # (REUSE — already shared)
    └── lib/binance-options-client.js   # (REUSE — already exists)
```

---

## 15. Implementation Phases

### Phase 1 — Foundation (Day 1)
- [ ] Create `bizWillRFv2_Binance.js` shell with CONFIG, mode selection, startup flow
- [ ] Implement `BinanceAuth` (HMAC signing, timestamp sync, health check)
- [ ] Implement `BinanceCandleFetcher` (REST `/api/v3/klines`, candle close detection)
- [ ] Port `TechnicalIndicators.calculateWPR` + `SignalManager` (WPR mode)
- [ ] Port `StakeCalculator` (martingale)
- [ ] Port `TradeHistoryManager` + `StatePersistence` (file names updated)
- [ ] Port `TelegramService` (all notification methods)
- [ ] Verify: `node --check bizWillRFv2_Binance.js` syntax OK

### Phase 2 — Binance Integration (Day 2)
- [ ] Implement `BinanceOptionsUniverse` (contract discovery, filtering)
- [ ] Implement `BinanceOrderExecutor` (place/query/cancel orders with HMAC auth)
- [ ] Implement `OptionsPositionMonitor` (TP/SL/time exit, P/L tracking)
- [ ] Wire `ConnectionManager` equivalent: WebSocket kline stream + REST fallback
- [ ] Test auth: `GET /api/v3/account` returns balances

### Phase 3 — Prediction Mode (Day 3)
- [ ] Implement `PredictionSelector` (delta estimation, scoring, best-match selection)
- [ ] Implement `SignalStrategy` interface (WPR vs Prediction dispatch)
- [ ] Add `TRADE_MODE` + `PREDICTION_PERCENTAGE` to CONFIG
- [ ] Test: paper mode prediction selections logged correctly

### Phase 4 — Integration & Polish (Day 4)
- [ ] Full end-to-end test in paper mode (WPR + Prediction modes)
- [ ] Telegram notification validation (all 8 methods + prediction fields)
- [ ] State persistence validation (save/load, 120-minute staleness)
- [ ] Backtest validation (WPR mode and Prediction mode)
- [ ] Error handling: network failures, auth expiry, order rejections
- [ ] Documentation: `README_binance_bot.md`

### Phase 5 — Live Readiness (Day 5)
- [ ] Paper mode dry run for 48 hours
- [ ] Switch to live with minimal stake ($1-5 premium cap)
- [ ] Monitor first 100 trades for reconciliation issues
- [ ] Enable second underlying after stability confirmed

---

## 16. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Config-based auth (hardcoded + env override)** | Matches user preference from existing Deriv bots — all credentials in CONFIG, no .env migration required |
| **Two-mode architecture (WPR / Prediction)** | User explicitly requested the ability to choose between strategies via a single toggle |
| **Prediction % = delta proxy** | Binance has no "prediction %" API field; delta is the closest meaningful interpretation of probability |
| **FOK limit orders only** | Matches existing Binance options bot — ensures full fill or no fill, no partial positions |
| **1-minute candle granularity** | Matches Deriv bot's 60s granularity; WPR signals faster with shorter candles would increase noise |
| **Per-underlying pool independence** | Matches existing Deriv pattern — BTCUSDT losses don't affect ETHUSDT pool |
| **Reuse existing lib files** | `binance-options-client.js` and `telegram-notifier.js` are already tested and working |

---

## 17. Open Questions for User Approval

Before implementation begins, please confirm:

1. **ACTIVE_UNDERLYINGS:** Which Binance underlyings should be active by default? (`BTCUSDT`, `ETHUSDT` suggested — these are the only ones with liquid options markets)

2. **PREDICTION_PERCENTAGE default:** What should the default prediction percentage be? (70% suggested as a balanced starting point)

3. **Auth method:** Hardcoded in CONFIG (like Deriv tokens, as user preference) or env vars only?

4. **Prediction mode trigger:** Should Prediction mode wait for a WPR signal first (as described), or should it scan and buy continuously whenever a good match is found regardless of WPR?

5. **Delta estimation:** Binance Options API may or may not expose greeks directly. Should the bot:
   - (a) Use Binance greeks if available, fall back to Black-Scholes estimate
   - (b) Always use Black-Scholes estimate (no dependency on greeks)
   - (c) Use moneyness (delta ≈ 0.5 for ATM, higher for ITM) as a simple proxy

6. **Paper mode default:** `true` (safe) or `false` (live) on first run?

7. **Continue with existing Binance Options bot or create entirely new file?** The plan assumes a new `bizWillRFv2_Binance.js` file that combines the WPR strategy with Binance integration, rather than modifying the existing `bizWillRFv2_BINANCE_OPTIONS.js`.

---

## 18. Risk Warnings

- **Binance Options are high-risk:** Even with protective guards, options can lose 100% of premium
- **Prediction mode is more complex:** Contract selection depends on delta accuracy; wrong delta estimates lead to poor contract choices
- **Start in paper mode:** All trading should begin in paper mode until the user is confident in contract selection and P&L tracking
- **No guaranteed profit:** WPR is a momentum indicator; no strategy guarantees wins
- **Binance API rate limits:** Order placement and query must respect rate limits (implement backoff)

---

*Plan prepared for user review. Implementation begins only after user approval and answers to the 7 questions in Section 17.*
