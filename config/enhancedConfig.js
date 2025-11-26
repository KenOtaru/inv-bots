/**
 * Enhanced Bot Configuration
 * Centralized configuration for all advanced features
 */

module.exports = {
    // Account & API
    token: 'Dz2V2KvRf4Uukt3', // Default token, can be overridden
    appId: 1089,

    // Assets to trade
    assets: ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'],

    // Stake Management (Kelly Criterion & Anti-Martingale)
    stakeManagement: {
        initialStake: 1.0,
        minStake: 0.35,
        maxStake: 20.0, //50.0

        // Kelly Criterion
        useKelly: true,
        kellyFraction: 0.35, // Conservative fractional Kelly (25%)

        // Anti-Martingale (Increase on Win)
        useAntiMartingale: true,
        winStreakMultiplier: 1.2, // Increase stake by 20% after win
        maxStreakMultiplier: 1.5, // Cap at 1.5x base stake
        resetOnLoss: true,        // Reset to initial stake after any loss

        // Legacy Martingale (Disabled by default)
        useMartingale: false,
        martingaleMultiplier: 2.1
    },

    // Risk Management
    riskControl: {
        // Capital Preservation
        stopLoss: 100,           // Daily stop loss ($)
        takeProfit: 5000,         // Daily take profit ($)
        maxDrawdownPercent: 0.15, // Stop if account drops 15% from peak

        // Session Limits
        maxDailyTrades: 150,
        maxConsecutiveLosses: 4, // Strict stop after 2 losses
        cooldownAfterLoss: 300000, // 5 minutes cooldown

        // Circuit Breakers
        volatilityCircuitBreaker: 0.95, // Stop if volatility > 95%
        minSurvivalProbability: 0.98,   // Absolute minimum survival prob 98%

        // Correlation Risk
        maxCorrelatedExposure: 0.5, // Max 50% of risk on correlated assets
        correlationThreshold: 0.7   // Assets considered correlated above 0.7
    },

    // Trading Parameters
    trading: {
        // Growth Rate Optimization
        dynamicGrowthRate: true,
        minGrowthRate: 0.01,
        baseGrowthRate: 0.03,
        maxGrowthRate: 0.05,

        // Time Settings
        minWaitTime: 60000,     // 1 minute
        maxWaitTime: 300000,    // 5 minutes

        // Analysis Requirements
        requiredHistoryLength: 500,
        minSamplesForEstimate: 50,

        // Time of Day (GMT+1)
        tradingHours: {
            start: 7,
            end: 19,
            enabled: true
        }
    },

    // Advanced Analysis Engines
    analysis: {
        // Multi-timeframe
        timeframes: [60, 300, 900, 3600], // 1m, 5m, 15m, 1h

        // Monte Carlo
        monteCarlo: {
            enabled: true,
            simulations: 2000, // Reduced for performance
            confidenceLevel: 0.95,
            maxRiskOfRuin: 0.01 // Max 1% risk of ruin allowed
        },

        // Bayesian
        bayesian: {
            enabled: true,
            priorAlpha: 2, // Weak prior
            priorBeta: 2
        },

        // Pattern Recognition
        patterns: {
            enabled: true,
            maxMemory: 500,
            minOccurrences: 10,
            minWinRate: 0.4
        }
    },

    // Email Notifications
    notifications: {
        enabled: true,
        recipient: 'kenotaru@gmail.com',
        emailConfig: {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        },
        summaryInterval: 1800000 // 30 minutes
    }
};
