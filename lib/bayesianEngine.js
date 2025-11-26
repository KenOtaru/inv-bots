/**
 * Bayesian Inference Engine
 * Implements Bayesian probability estimation using Beta distributions
 */

const { BetaDistribution } = require('../utils/statisticalHelpers');

class BayesianEngine {
    constructor() {
        // Store Beta distributions for different metrics
        this.priors = {
            // Asset-specific win probabilities
            assetWinProb: {},
            // Growth rate effectiveness
            growthRateSuccess: {},
            // Pattern success rates
            patternSuccess: {},
            // Regime-based probabilities
            regimeWinProb: {}
        };
    }

    /**
     * Initialize prior for an asset
     */
    initializeAssetPrior(asset, alpha = 1, beta = 1) {
        if (!this.priors.assetWinProb[asset]) {
            this.priors.assetWinProb[asset] = new BetaDistribution(alpha, beta);
        }
    }

    /**
     * Update asset win probability with new observation
     */
    updateAssetWinProb(asset, won) {
        this.initializeAssetPrior(asset);
        this.priors.assetWinProb[asset].update(won);
    }

    /**
     * Get estimated win probability for an asset
     */
    getAssetWinProb(asset, useMode = false) {
        this.initializeAssetPrior(asset);
        return useMode ?
            this.priors.assetWinProb[asset].getMode() :
            this.priors.assetWinProb[asset].getMean();
    }

    /**
     * Get credible interval for asset win probability
     */
    getAssetWinProbInterval(asset, confidence = 0.95) {
        this.initializeAssetPrior(asset);
        return this.priors.assetWinProb[asset].getCredibleInterval(confidence);
    }

    /**
     * Initialize growth rate prior
     */
    initializeGrowthRatePrior(growthRate) {
        const key = growthRate.toFixed(3);
        if (!this.priors.growthRateSuccess[key]) {
            this.priors.growthRateSuccess[key] = new BetaDistribution(1, 1);
        }
    }

    /**
     * Update growth rate effectiveness
     */
    updateGrowthRateSuccess(growthRate, success) {
        const key = growthRate.toFixed(3);
        this.initializeGrowthRatePrior(growthRate);
        this.priors.growthRateSuccess[key].update(success);
    }

    /**
     * Get success probability for a growth rate
     */
    getGrowthRateSuccessProb(growthRate) {
        const key = growthRate.toFixed(3);
        this.initializeGrowthRatePrior(growthRate);
        return this.priors.growthRateSuccess[key].getMean();
    }

    /**
     * Initialize pattern prior
     */
    initializePatternPrior(patternId) {
        if (!this.priors.patternSuccess[patternId]) {
            this.priors.patternSuccess[patternId] = new BetaDistribution(1, 1);
        }
    }

    /**
     * Update pattern success rate
     */
    updatePatternSuccess(patternId, success) {
        this.initializePatternPrior(patternId);
        this.priors.patternSuccess[patternId].update(success);
    }

    /**
     * Get pattern success probability
     */
    getPatternSuccessProb(patternId) {
        this.initializePatternPrior(patternId);
        return this.priors.patternSuccess[patternId].getMean();
    }

    /**
     * Initialize regime prior
     */
    initializeRegimePrior(regime) {
        if (!this.priors.regimeWinProb[regime]) {
            this.priors.regimeWinProb[regime] = new BetaDistribution(1, 1);
        }
    }

    /**
     * Update regime win probability
     */
    updateRegimeWinProb(regime, won) {
        this.initializeRegimePrior(regime);
        this.priors.regimeWinProb[regime].update(won);
    }

    /**
     * Get regime win probability
     */
    getRegimeWinProb(regime) {
        this.initializeRegimePrior(regime);
        return this.priors.regimeWinProb[regime].getMean();
    }

    /**
     * Comprehensive probability estimate combining multiple factors
     */
    estimateWinProbability(params) {
        const {
            asset,
            growthRate,
            patternId = null,
            regime = 'UNKNOWN'
        } = params;

        // Get individual probabilities
        const assetProb = this.getAssetWinProb(asset);
        const growthProb = this.getGrowthRateSuccessProb(growthRate);
        const regimeProb = this.getRegimeWinProb(regime);

        // Get pattern probability if available
        let patternProb = 0.5; // Neutral prior
        if (patternId) {
            patternProb = this.getPatternSuccessProb(patternId);
        }

        // Weighted combination (you can adjust weights)
        const weights = {
            asset: 0.3,
            growth: 0.2,
            pattern: 0.2,
            regime: 0.3
        };

        const combinedProb =
            weights.asset * assetProb +
            weights.growth * growthProb +
            weights.pattern * patternProb +
            weights.regime * regimeProb;

        return {
            combined: combinedProb,
            breakdown: {
                asset: assetProb,
                growthRate: growthProb,
                pattern: patternProb,
                regime: regimeProb
            },
            confidence: this._calculateConfidence(asset, growthRate, regime)
        };
    }

    /**
     * Calculate confidence in estimate based on sample size
     */
    _calculateConfidence(asset, growthRate, regime) {
        const assetDist = this.priors.assetWinProb[asset];
        if (!assetDist) return 0;

        // Higher alpha + beta means more samples, higher confidence
        const sampleSize = assetDist.alpha + assetDist.beta - 2; // Subtract initial priors

        // Confidence increases with samples but plateaus
        // Using logarithmic scale
        const confidence = Math.min(1, Math.log(sampleSize + 1) / Math.log(100));

        return confidence;
    }

    /**
     * Get all statistics for reporting
     */
    getStatistics() {
        const stats = {
            assets: {},
            growthRates: {},
            patterns: {},
            regimes: {}
        };

        // Asset stats
        for (const asset in this.priors.assetWinProb) {
            const dist = this.priors.assetWinProb[asset];
            stats.assets[asset] = {
                winProb: dist.getMean(),
                samples: dist.alpha + dist.beta - 2,
                credibleInterval: dist.getCredibleInterval()
            };
        }

        // Growth rate stats
        for (const gr in this.priors.growthRateSuccess) {
            const dist = this.priors.growthRateSuccess[gr];
            stats.growthRates[gr] = {
                successProb: dist.getMean(),
                samples: dist.alpha + dist.beta - 2
            };
        }

        // Pattern stats
        for (const pattern in this.priors.patternSuccess) {
            const dist = this.priors.patternSuccess[pattern];
            stats.patterns[pattern] = {
                successProb: dist.getMean(),
                samples: dist.alpha + dist.beta - 2
            };
        }

        // Regime stats
        for (const regime in this.priors.regimeWinProb) {
            const dist = this.priors.regimeWinProb[regime];
            stats.regimes[regime] = {
                winProb: dist.getMean(),
                samples: dist.alpha + dist.beta - 2
            };
        }

        return stats;
    }

    /**
     * Reset all priors (for testing or new trading session)
     */
    reset() {
        this.priors = {
            assetWinProb: {},
            growthRateSuccess: {},
            patternSuccess: {},
            regimeWinProb: {}
        };
    }
}

module.exports = BayesianEngine;
