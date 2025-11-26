/**
 * Kelly Criterion Calculator
 * Implements Kelly Criterion for optimal position sizing with fractional Kelly support
 */

class KellyCalculator {
    constructor(config = {}) {
        this.kellyFraction = config.kellyFraction || 0.35; // 25% of full Kelly (fractional Kelly)
        this.minStake = config.minStake || 1.0;
        this.maxStake = config.maxStake || 1000;
        this.accountBalance = 100;//config.accountBalance
    }

    /**
     * Calculate Kelly fraction
     * f* = (bp - q) / b
     * where:
     *   b = odds (payout ratio)
     *   p = probability of winning
     *   q = probability of losing = 1 - p
     */
    calculateKellyFraction(winProbability, payoutRatio) {
        if (winProbability <= 0 || winProbability >= 1) return 0;
        if (payoutRatio <= 0) return 0;

        const p = winProbability;
        const q = 1 - p;
        const b = payoutRatio;

        const kellyFraction = (b * p - q) / b;

        // Never bet if Kelly is negative (negative expectation)
        return Math.max(0, kellyFraction);
    }

    /**
     * Calculate recommended stake size
     */
    calculateStakeSize(winProbability, payoutRatio, accountBalance = null) {
        const balance = accountBalance || this.accountBalance;

        // Calculate full Kelly
        const fullKelly = this.calculateKellyFraction(winProbability, payoutRatio);

        // Apply fractional Kelly for safety
        const fractionalKelly = fullKelly * this.kellyFraction;

        // Calculate stake
        let stake = balance * fractionalKelly;

        // Apply min/max constraints
        stake = Math.max(this.minStake, stake);
        stake = Math.min(this.maxStake, stake);

        // Round to 2 decimal places
        return Math.round(stake * 100) / 100;
    }

    /**
     * Calculate expected value of a bet
     */
    calculateExpectedValue(winProbability, payoutRatio, stake) {
        const p = winProbability;
        const q = 1 - p;
        const profit = stake * payoutRatio;
        const loss = stake;

        return (p * profit) - (q * loss);
    }

    /**
     * Estimate payout ratio from accumulator growth rate
     * For accumulators: payout ≈ stake * (1 + growth_rate)^ticks
     * We estimate average ticks to expiration
     */
    estimatePayoutRatio(growthRate, estimatedTicks = 10) {
        // Conservative estimate: assume we exit at avg tick count
        const multiplier = Math.pow(1 + growthRate, estimatedTicks);
        // Payout ratio = (total return - stake) / stake
        return multiplier - 1;
    }

    /**
     * Calculate optimal growth rate given target payout and Kelly constraints
     */
    calculateOptimalGrowthRate(winProbability, targetTicks = 10, minGrowth = 0.01, maxGrowth = 0.08) {
        // Binary search for optimal growth rate
        let low = minGrowth;
        let high = maxGrowth;
        let bestGrowth = minGrowth;
        let bestKelly = 0;

        for (let i = 0; i < 20; i++) {
            const mid = (low + high) / 2;
            const payoutRatio = this.estimatePayoutRatio(mid, targetTicks);
            const kelly = this.calculateKellyFraction(winProbability, payoutRatio);

            if (kelly > bestKelly) {
                bestKelly = kelly;
                bestGrowth = mid;
            }

            // Adjust search based on Kelly gradient
            if (kelly > 0.1) {
                // Kelly too high, reduce growth rate
                high = mid;
            } else if (kelly < 0.05) {
                // Kelly too low, increase growth rate
                low = mid;
            } else {
                // Good range
                break;
            }
        }

        return bestGrowth;
    }

    /**
     * Update account balance
     */
    updateBalance(newBalance) {
        this.accountBalance = newBalance;
    }

    /**
     * Get current settings
     */
    getSettings() {
        return {
            kellyFraction: this.kellyFraction,
            minStake: this.minStake,
            maxStake: this.maxStake,
            accountBalance: this.accountBalance
        };
    }

    /**
     * Validate if a trade meets Kelly criteria
     */
    validateTrade(winProbability, payoutRatio) {
        const kelly = this.calculateKellyFraction(winProbability, payoutRatio);
        const ev = this.calculateExpectedValue(winProbability, payoutRatio, 1);

        return {
            isValid: kelly > 0 && ev > 0,
            kelly: kelly,
            fractionalKelly: kelly * this.kellyFraction,
            expectedValue: ev,
            reason: kelly <= 0 ? 'Negative Kelly (negative expectation)' :
                ev <= 0 ? 'Negative expected value' : 'Valid trade'
        };
    }
}

module.exports = KellyCalculator;
