/**
 * Market Regime Detector
 * Identifies and classifies market regimes based on volatility and trend
 */

const { mean, standardDeviation, ema } = require('../utils/statisticalHelpers');

class RegimeDetector {
    constructor(config = {}) {
        this.volatilityThreshold = config.volatilityThreshold || 0.6;
        this.trendThreshold = config.trendThreshold || 0.4;
        this.lookbackPeriod = config.lookbackPeriod || 50;

        // Regime types
        this.REGIMES = {
            LOW_VOL_TRENDING: 'LOW_VOL_TRENDING',
            HIGH_VOL_TRENDING: 'HIGH_VOL_TRENDING',
            LOW_VOL_RANGING: 'LOW_VOL_RANGING',
            HIGH_VOL_RANGING: 'HIGH_VOL_RANGING',
            UNKNOWN: 'UNKNOWN'
        };

        // Regime-specific parameters
        this.regimeParams = {
            LOW_VOL_TRENDING: {
                growthRate: 0.05,
                survivalThreshold: 0.97,
                kellyFraction: 0.30,
                description: 'Low volatility with clear trend'
            },
            HIGH_VOL_TRENDING: {
                growthRate: 0.02,
                survivalThreshold: 0.995,
                kellyFraction: 0.15,
                description: 'High volatility with trend'
            },
            LOW_VOL_RANGING: {
                growthRate: 0.04,
                survivalThreshold: 0.98,
                kellyFraction: 0.25,
                description: 'Low volatility ranging market'
            },
            HIGH_VOL_RANGING: {
                growthRate: 0.01,
                survivalThreshold: 0.998,
                kellyFraction: 0.10,
                description: 'High volatility ranging market'
            },
            UNKNOWN: {
                growthRate: 0.03,
                survivalThreshold: 0.985,
                kellyFraction: 0.20,
                description: 'Insufficient data'
            }
        };

        this.currentRegime = this.REGIMES.UNKNOWN;
        this.regimeHistory = [];
    }

    /**
     * Calculate realized volatility from tick data
     */
    calculateVolatility(tickData) {
        if (!tickData || tickData.length < 10) return 0;

        const recent = tickData.slice(-this.lookbackPeriod);

        // Calculate tick-to-tick changes
        let changes = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] !== recent[i - 1]) {
                changes++;
            }
        }

        // Volatility = frequency of changes
        return changes / (recent.length - 1);
    }

    /**
     * Calculate trend strength using directional movement
     */
    calculateTrendStrength(tickData) {
        if (!tickData || tickData.length < 20) return 0;

        const recent = tickData.slice(-this.lookbackPeriod);
        const period = 14; // ADX-like calculation

        // Calculate directional movements
        const ups = [];
        const downs = [];

        for (let i = 1; i < recent.length; i++) {
            const move = recent[i] - recent[i - 1];
            ups.push(move > 0 ? move : 0);
            downs.push(move < 0 ? -move : 0);
        }

        // Calculate smoothed directional indicators
        const avgUps = mean(ups.slice(-period));
        const avgDowns = mean(downs.slice(-period));

        // Directional Index
        const total = avgUps + avgDowns;
        if (total === 0) return 0;

        const dx = Math.abs(avgUps - avgDowns) / total;

        return dx;
    }

    /**
     * Detect current market regime
     */
    detectRegime(tickData, asset = 'UNKNOWN') {
        if (!tickData || tickData.length < this.lookbackPeriod) {
            this.currentRegime = this.REGIMES.UNKNOWN;
            return this.currentRegime;
        }

        const volatility = this.calculateVolatility(tickData);
        const trendStrength = this.calculateTrendStrength(tickData);

        // Classify regime
        const isHighVol = volatility > this.volatilityThreshold;
        const isTrending = trendStrength > this.trendThreshold;

        let regime;
        if (!isHighVol && isTrending) {
            regime = this.REGIMES.LOW_VOL_TRENDING;
        } else if (isHighVol && isTrending) {
            regime = this.REGIMES.HIGH_VOL_TRENDING;
        } else if (!isHighVol && !isTrending) {
            regime = this.REGIMES.LOW_VOL_RANGING;
        } else {
            regime = this.REGIMES.HIGH_VOL_RANGING;
        }

        this.currentRegime = regime;

        // Record regime change
        this.regimeHistory.push({
            timestamp: Date.now(),
            regime,
            volatility,
            trendStrength,
            asset
        });

        // Keep only recent history
        if (this.regimeHistory.length > 1000) {
            this.regimeHistory.shift();
        }

        return {
            regime,
            volatility,
            trendStrength,
            params: this.regimeParams[regime]
        };
    }

    /**
     * Get parameters for current regime
     */
    getRegimeParams(regime = null) {
        const targetRegime = regime || this.currentRegime;
        return this.regimeParams[targetRegime];
    }

    /**
     * Get regime-adjusted trading decision thresholds
     */
    getAdjustedThresholds(baseConfig) {
        const params = this.getRegimeParams();

        return {
            growthRate: params.growthRate,
            survivalThreshold: params.survivalThreshold,
            kellyFraction: params.kellyFraction,
            shouldTrade: this.shouldTradeInRegime()
        };
    }

    /**
     * Determine if trading should occur in current regime
     */
    shouldTradeInRegime() {
        // Avoid trading in high volatility ranging markets
        if (this.currentRegime === this.REGIMES.HIGH_VOL_RANGING) {
            return Math.random() < 0.2; // Only 20% of opportunities
        }

        return true;
    }

    /**
     * Get regime stability (how long we've been in current regime)
     */
    getRegimeStability() {
        if (this.regimeHistory.length < 2) return 0;

        let consecutiveCount = 1;
        const currentRegime = this.currentRegime;

        for (let i = this.regimeHistory.length - 2; i >= 0; i--) {
            if (this.regimeHistory[i].regime === currentRegime) {
                consecutiveCount++;
            } else {
                break;
            }
        }

        return consecutiveCount;
    }

    /**
     * Get regime statistics for reporting
     */
    getRegimeStatistics() {
        if (this.regimeHistory.length === 0) {
            return null;
        }

        const regimeCounts = {};
        for (const regime in this.REGIMES) {
            regimeCounts[regime] = 0;
        }

        for (const entry of this.regimeHistory) {
            regimeCounts[entry.regime]++;
        }

        const total = this.regimeHistory.length;
        const distribution = {};

        for (const regime in regimeCounts) {
            distribution[regime] = {
                count: regimeCounts[regime],
                percentage: (regimeCounts[regime] / total * 100).toFixed(1)
            };
        }

        return {
            currentRegime: this.currentRegime,
            stability: this.getRegimeStability(),
            distribution,
            totalObservations: total,
            params: this.getRegimeParams()
        };
    }

    /**
     * Multi-timeframe regime analysis
     */
    analyzeMultiTimeframeRegime(tickDataByTimeframe) {
        const regimes = {};
        const votes = {};

        // Detect regime for each timeframe
        for (const [timeframe, data] of Object.entries(tickDataByTimeframe)) {
            const detection = this.detectRegime(data, `TF_${timeframe}`);
            regimes[timeframe] = detection;

            // Count votes for each regime type
            votes[detection.regime] = (votes[detection.regime] || 0) + 1;
        }

        // Find consensus regime (most votes)
        let consensusRegime = this.REGIMES.UNKNOWN;
        let maxVotes = 0;

        for (const [regime, count] of Object.entries(votes)) {
            if (count > maxVotes) {
                maxVotes = count;
                consensusRegime = regime;
            }
        }

        // Calculate alignment score (how many timeframes agree)
        const totalTimeframes = Object.keys(tickDataByTimeframe).length;
        const alignmentScore = maxVotes / totalTimeframes;

        return {
            byTimeframe: regimes,
            consensus: consensusRegime,
            alignment: alignmentScore,
            params: this.regimeParams[consensusRegime],
            // Only trade if good alignment
            shouldTrade: alignmentScore >= 0.5
        };
    }
}

module.exports = RegimeDetector;
