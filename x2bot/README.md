# Deriv Digit Differ Trading Bot v2.0

An advanced trading bot for Deriv's Digit Differ contracts with rigorous statistical analysis.

## ⚠️ IMPORTANT DISCLAIMER

**No trading bot can guarantee 100% success.** This is mathematically impossible in any financial market. This bot is designed to:

- Maximize probability of winning trades
- Only trade under optimal statistical conditions
- Implement strict risk management

Trading involves significant risk of financial loss. Only trade with money you can afford to lose.

## How It Works

### Digit Differ Contract
- You select a digit (0-9)
- The contract wins if the NEXT tick's last digit is DIFFERENT from your selection
- Theoretical win rate: 90% (9 out of 10 possible outcomes are winners)
- Payout: ~1.9x stake (varies)

### Bot Strategy
1. **Collects 5000 ticks** of historical data before any trading
2. **Analyzes multiple factors**:
   - Overall repetition rate (how often digits repeat)
   - Recent repetition patterns (last 100 ticks)
   - Current non-repetition streak
   - Digit-specific self-repetition rate
   - Transition probabilities
   - Shannon entropy
3. **Only trades when ALL conditions are met**:
   - Confidence ≥ 92%
   - Repetition rate < 8%
   - Non-repetition streak ≥ 8
   - Digit self-repetition rate < 12%
   - Current digit is not in a repeat streak

## Installation

```bash
# Install dependencies
npm install

# Configure your API token
# Edit config.js and add your Deriv API token
```

## Configuration

Edit `config.js` to customize:

```javascript
module.exports = {
    API_TOKEN: 'YOUR_DERIV_API_TOKEN',  // Get from Deriv

    TRADING: {
        initialStake: 1.00,       // Starting stake
        multiplier: 2.5,          // Martingale multiplier
        maxConsecutiveLosses: 4,  // Stop after X losses
        stopLoss: 50,             // Max total loss
        takeProfit: 20,           // Target profit
        maxStake: 100,            // Maximum stake
    },

    ANALYSIS: {
        minHistoryLength: 5000,   // Ticks before trading
        minConfidence: 0.92,      // Min confidence (92%)
        maxRepetitionRate: 0.08,  // Max rep rate (8%)
        minNonRepStreak: 8,       // Min non-rep streak
    }
};
```

## Usage

```bash
# Start the bot
npm start

# Or with auto-restart on changes (development)
npm run dev
```

## What Was Removed from Original

1. **Chaos Theory Analysis** - Pseudo-scientific, added noise not signal
2. **Anti-Algorithm Detection** - Unfounded assumptions about market manipulation
3. **Lyapunov Exponents** - Misapplied to discrete digit data
4. **Butterfly Effects** - Not applicable to this context
5. **Strange Attractors** - Phase space embedding not meaningful here
6. **50+ unused variables** - Cleaned up state management
7. **Contradictory logic** - Fixed conditions that checked both >40 AND <-40

## What Was Improved

1. **Clean Statistical Analysis**
   - Proper repetition rate calculation
   - Z-score for statistical significance
   - Transition probability matrix
   - Shannon entropy for randomness detection

2. **Strict Trading Conditions**
   - Multiple independent checks must ALL pass
   - Higher confidence threshold (92%)
   - Lower repetition rate threshold (8%)

3. **Better Code Structure**
   - Separated configuration
   - Modular analyzer class
   - Clear logging and documentation
   - Proper error handling

4. **Risk Management**
   - Configurable stop-loss
   - Configurable take-profit
   - Maximum stake limit
   - Consecutive loss limit

## Understanding the Output

```
┌─────────────────────────────────────────────────────────┐
│                   ANALYSIS SUMMARY                      │
├─────────────────────────────────────────────────────────┤
│  History Length:    5000                                │
│  Current Digit:     7                                   │
│  Confidence:        94.2%                               │
│  Repetition Rate:   7.82%         (< 8% = good)        │
│  Recent Rep Rate:   6.06%         (< 12% = good)       │
│  Non-Rep Streak:    12            (≥ 8 = good)         │
│  Should Trade:      ✅ YES                              │
└─────────────────────────────────────────────────────────┘
```

## Realistic Expectations

Even with all optimizations:
- **Expected win rate**: ~90-92%
- **Consecutive losses WILL happen**: Statistically, 2-3 in a row is normal
- **No guarantees**: Past patterns don't guarantee future outcomes

The bot maximizes your edge but cannot eliminate risk.

## File Structure

```
├── package.json           # Dependencies
├── config.js              # Configuration
├── StatisticalAnalyzer.js # Analysis engine
├── index.js               # Main bot
└── README.md              # This file
```

## License

MIT - Use at your own risk.