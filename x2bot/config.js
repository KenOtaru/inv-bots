/**
 * Bot Configuration
 * Adjust these settings based on your risk tolerance
 */

module.exports = {
    // Deriv API Token - Replace with your actual token
    API_TOKEN: 'YOUR_API_TOKEN_HERE',

    // Trading Parameters
    TRADING: {
        initialStake: 1.00,           // Starting stake in USD
        multiplier: 2.5,              // Stake multiplier after loss (Martingale)
        maxConsecutiveLosses: 4,      // Stop after this many consecutive losses
        stopLoss: 50,                 // Maximum total loss before stopping
        takeProfit: 20,               // Target profit before stopping
        maxStake: 100,                // Maximum allowed stake
    },

    // Analysis Thresholds - CRITICAL for trade decisions
    ANALYSIS: {
        minHistoryLength: 5000,       // Minimum ticks before trading
        minConfidence: 0.92,          // Minimum confidence to trade (92%)
        maxRepetitionRate: 0.08,      // Max acceptable repetition rate (8%)
        minNonRepStreak: 8,           // Minimum consecutive non-repetitions
        minSampleSize: 500,           // Minimum samples for digit analysis
    },

    // Assets to trade (synthetic indices)
    ASSETS: ['R_100'],

    // Email notifications (optional)
    EMAIL: {
        enabled: false,
        service: 'gmail',
        user: 'your-email@gmail.com',
        pass: 'your-app-password',
        recipient: 'recipient@email.com'
    },

    // Timing
    TIMING: {
        reconnectInterval: 5000,      // ms between reconnect attempts
        maxReconnectAttempts: 100,
        tradeCooldown: 2000,          // ms to wait after each trade
    }
};