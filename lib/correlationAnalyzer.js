/**
 * Correlation Analyzer
 * Tracks cross-asset correlations and provides risk-adjusted position sizing
 */

const { pearsonCorrelation, rolling, mean } = require('../utils/statisticalHelpers');

class CorrelationAnalyzer {
    constructor(config = {}) {
        this.correlationWindow = config.correlationWindow || 500;
        this.correlationThreshold = config.correlationThreshold || 0.7;
        this.updateFrequency = config.updateFrequency || 100; // Update every 100 ticks

        this.tickCounter = 0;
        this.assetTickData = {}; // Store recent ticks for each asset
        this.correlationMatrix = {};
        this.lastUpdate = Date.now();
    }

    /**
     * Add tick data for an asset
     */
    addTick(asset, tickValue) {
        if (!this.assetTickData[asset]) {
            this.assetTickData[asset] = [];
        }

        this.assetTickData[asset].push(tickValue);

        // Keep only recent data
        if (this.assetTickData[asset].length > this.correlationWindow) {
            this.assetTickData[asset].shift();
        }

        this.tickCounter++;

        // Update correlations periodically
        if (this.tickCounter % this.updateFrequency === 0) {
            this.updateCorrelations();
        }
    }

    /**
     * Calculate correlation matrix for all assets
     */
    updateCorrelations() {
        const assets = Object.keys(this.assetTickData);

        // Reset matrix
        this.correlationMatrix = {};

        for (let i = 0; i < assets.length; i++) {
            const asset1 = assets[i];
            this.correlationMatrix[asset1] = {};

            for (let j = 0; j < assets.length; j++) {
                const asset2 = assets[j];

                if (i === j) {
                    this.correlationMatrix[asset1][asset2] = 1.0;
                } else if (this.correlationMatrix[asset2] &&
                    this.correlationMatrix[asset2][asset1] !== undefined) {
                    // Use already calculated correlation
                    this.correlationMatrix[asset1][asset2] = this.correlationMatrix[asset2][asset1];
                } else {
                    // Calculate correlation
                    const corr = this.calculateCorrelation(asset1, asset2);
                    this.correlationMatrix[asset1][asset2] = corr;
                }
            }
        }

        this.lastUpdate = Date.now();
    }

    /**
     * Calculate Pearson correlation between two assets
     */
    calculateCorrelation(asset1, asset2) {
        const data1 = this.assetTickData[asset1];
        const data2 = this.assetTickData[asset2];

        if (!data1 || !data2 || data1.length < 50 || data2.length < 50) {
            return 0;
        }

        // Use common length
        const len = Math.min(data1.length, data2.length);
        const arr1 = data1.slice(-len);
        const arr2 = data2.slice(-len);

        return pearsonCorrelation(arr1, arr2);
    }

    /**
     * Get correlation between two assets
     */
    getCorrelation(asset1, asset2) {
        if (this.correlationMatrix[asset1] && this.correlationMatrix[asset1][asset2] !== undefined) {
            return this.correlationMatrix[asset1][asset2];
        }
        return 0;
    }

    /**
     * Find assets highly correlated with given asset
     */
    getCorrelatedAssets(asset, threshold = null) {
        threshold = threshold || this.correlationThreshold;
        const correlated = [];

        if (!this.correlationMatrix[asset]) {
            return correlated;
        }

        for (const [otherAsset, correlation] of Object.entries(this.correlationMatrix[asset])) {
            if (otherAsset !== asset && Math.abs(correlation) >= threshold) {
                correlated.push({
                    asset: otherAsset,
                    correlation: correlation
                });
            }
        }

        return correlated.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    }

    /**
     * Calculate portfolio correlation for a set of assets
     */
    calculatePortfolioCorrelation(assets) {
        if (assets.length <= 1) return 0;

        let totalCorr = 0;
        let count = 0;

        for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
                const corr = this.getCorrelation(assets[i], assets[j]);
                totalCorr += Math.abs(corr);
                count++;
            }
        }

        return count > 0 ? totalCorr / count : 0;
    }

    /**
     * Adjust position size based on correlation
     * If trading multiple correlated assets, reduce exposure
     */
    adjustPositionForCorrelation(baseStake, asset, activeAssets = []) {
        if (activeAssets.length === 0) {
            return baseStake;
        }

        // Find correlated active assets
        const correlations = activeAssets.map(activeAsset => ({
            asset: activeAsset,
            correlation: this.getCorrelation(asset, activeAsset)
        }));

        const highlyCorrelated = correlations.filter(c =>
            Math.abs(c.correlation) >= this.correlationThreshold
        );

        if (highlyCorrelated.length === 0) {
            return baseStake;
        }

        // Calculate average correlation with active assets
        const avgCorrelation = mean(highlyCorrelated.map(c => Math.abs(c.correlation)));

        // Reduce stake based on correlation and number of correlated assets
        // Formula: adjusted = base / sqrt(n * correlation_factor)
        const n = highlyCorrelated.length + 1; // Include current asset
        const correlationFactor = 0.5 + 0.5 * avgCorrelation; // Scale from 0.5 to 1.0

        const adjusted = baseStake / Math.sqrt(n * correlationFactor);

        return Math.max(baseStake * 0.5, adjusted); // At least 50% of base
    }

    /**
     * Find optimal uncorrelated asset for trading
     */
    findUncorrelatedAsset(activeAssets = [], candidateAssets = []) {
        if (candidateAssets.length === 0) {
            return null;
        }

        const scores = candidateAssets.map(asset => {
            // Calculate average correlation with active assets
            let avgCorr = 0;
            if (activeAssets.length > 0) {
                const correlations = activeAssets.map(activeAsset =>
                    Math.abs(this.getCorrelation(asset, activeAsset))
                );
                avgCorr = mean(correlations);
            }

            return {
                asset,
                avgCorrelation: avgCorr,
                score: 1 - avgCorr // Lower correlation = higher score
            };
        });

        // Sort by score (prefer uncorrelated)
        scores.sort((a, b) => b.score - a.score);

        return scores[0];
    }

    /**
     * Calculate effective number of independent bets (diversification benefit)
     * Based on correlation structure
     */
    calculateEffectiveNBets(assets) {
        if (assets.length <= 1) return assets.length;

        const n = assets.length;
        const avgCorrelation = this.calculatePortfolioCorrelation(assets);

        // Formula: effective_n = n / (1 + (n-1) * avg_correlation)
        const effective = n / (1 + (n - 1) * avgCorrelation);

        return effective;
    }

    /**
     * Get correlation statistics for reporting
     */
    getCorrelationStatistics() {
        const assets = Object.keys(this.correlationMatrix);

        if (assets.length < 2) {
            return null;
        }

        const allCorrelations = [];

        for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
                const corr = this.getCorrelation(assets[i], assets[j]);
                allCorrelations.push({
                    pair: `${assets[i]}-${assets[j]}`,
                    correlation: corr
                });
            }
        }

        const corrValues = allCorrelations.map(c => c.correlation);
        const avgCorr = mean(corrValues);
        const maxCorr = Math.max(...corrValues.map(Math.abs));

        // Find most correlated pairs
        const sorted = [...allCorrelations].sort((a, b) =>
            Math.abs(b.correlation) - Math.abs(a.correlation)
        );

        return {
            totalPairs: allCorrelations.length,
            averageCorrelation: avgCorr,
            maxCorrelation: maxCorr,
            highlyCorrelatedPairs: sorted.filter(c =>
                Math.abs(c.correlation) >= this.correlationThreshold
            ).length,
            topCorrelations: sorted.slice(0, 5),
            lastUpdate: new Date(this.lastUpdate).toISOString()
        };
    }

    /**
     * Get the full correlation matrix
     */
    getCorrelationMatrix() {
        return this.correlationMatrix;
    }
}

module.exports = CorrelationAnalyzer;
