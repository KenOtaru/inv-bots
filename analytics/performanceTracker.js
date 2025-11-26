/**
 * Performance Tracker
 * Comprehensive metrics tracking for trade and portfolio performance
 */

const { mean, sharpeRatio, percentile } = require('../utils/statisticalHelpers');

class PerformanceTracker {
    constructor() {
        this.trades = [];
        this.sessionStart = Date.now();
        this.initialBalance = 0;
        this.currentBalance = 0;

        // Performance metrics
        this.metrics = {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            totalProfit: 0,
            totalLoss: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            currentDrawdown: 0,
            peakBalance: 0,
            longestWinStreak: 0,
            longestLossStreak: 0,
            currentStreak: 0,
            streakType: null
        };
    }

    /**
     * Initialize with starting balance
     */
    initialize(balance) {
        this.initialBalance = balance;
        this.currentBalance = balance;
        this.metrics.peakBalance = balance;
    }

    /**
     * Record a trade
     */
    recordTrade(tradeData) {
        const {
            asset,
            stake,
            growthRate,
            outcome, // 'win' or 'loss'
            profit,
            duration, // in ticks
            survivalProbAtEntry,
            regime,
            pattern = null,
            timestamp = Date.now()
        } = tradeData;

        const trade = {
            id: this.trades.length + 1,
            timestamp,
            asset,
            stake,
            growthRate,
            outcome,
            profit,
            duration,
            survivalProbAtEntry,
            regime,
            pattern,
            balanceAfter: this.currentBalance + profit
        };

        this.trades.push(trade);
        this.currentBalance += profit;

        // Update metrics
        this.updateMetrics(trade);

        return trade;
    }

    /**
     * Update performance metrics
     */
    updateMetrics(trade) {
        this.metrics.totalTrades++;

        const won = trade.outcome === 'win';

        if (won) {
            this.metrics.wins++;
            this.metrics.totalProfit += trade.profit;

            // Update streak
            if (this.metrics.streakType === 'win') {
                this.metrics.currentStreak++;
            } else {
                this.metrics.currentStreak = 1;
                this.metrics.streakType = 'win';
            }

            this.metrics.longestWinStreak = Math.max(
                this.metrics.longestWinStreak,
                this.metrics.currentStreak
            );
        } else {
            this.metrics.losses++;
            this.metrics.totalLoss += Math.abs(trade.profit);

            // Update streak
            if (this.metrics.streakType === 'loss') {
                this.metrics.currentStreak++;
            } else {
                this.metrics.currentStreak = 1;
                this.metrics.streakType = 'loss';
            }

            this.metrics.longestLossStreak = Math.max(
                this.metrics.longestLossStreak,
                this.metrics.currentStreak
            );
        }

        // Update peak and drawdown
        if (trade.balanceAfter > this.metrics.peakBalance) {
            this.metrics.peakBalance = trade.balanceAfter;
            this.metrics.currentDrawdown = 0;
        } else {
            const dd = this.metrics.peakBalance - trade.balanceAfter;
            const ddPercent = dd / this.metrics.peakBalance;

            this.metrics.currentDrawdown = dd;
            this.metrics.maxDrawdown = Math.max(this.metrics.maxDrawdown, dd);
            this.metrics.maxDrawdownPercent = Math.max(
                this.metrics.maxDrawdownPercent,
                ddPercent
            );
        }
    }

    /**
     * Get current win rate
     */
    getWinRate() {
        if (this.metrics.totalTrades === 0) return 0;
        return this.metrics.wins / this.metrics.totalTrades;
    }

    /**
     * Get profit factor
     */
    getProfitFactor() {
        if (this.metrics.totalLoss === 0) return this.metrics.totalProfit > 0 ? Infinity : 1;
        return this.metrics.totalProfit / this.metrics.totalLoss;
    }

    /**
     * Calculate Sharpe ratio
     */
    getSharpeRatio() {
        if (this.trades.length < 2) return 0;

        const returns = this.trades.map(t => t.profit / t.stake);
        return sharpeRatio(returns);
    }

    /**
     * Get average win and loss
     */
    getAverageWinLoss() {
        const wins = this.trades.filter(t => t.outcome === 'win');
        const losses = this.trades.filter(t => t.outcome === 'loss');

        const avgWin = wins.length > 0 ?
            mean(wins.map(t => t.profit)) : 0;
        const avgLoss = losses.length > 0 ?
            mean(losses.map(t => Math.abs(t.profit))) : 0;

        return { avgWin, avgLoss };
    }

    /**
     * Get performance by asset
     */
    getPerformanceByAsset() {
        const byAsset = {};

        for (const trade of this.trades) {
            if (!byAsset[trade.asset]) {
                byAsset[trade.asset] = {
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    profit: 0
                };
            }

            byAsset[trade.asset].trades++;
            if (trade.outcome === 'win') {
                byAsset[trade.asset].wins++;
            } else {
                byAsset[trade.asset].losses++;
            }
            byAsset[trade.asset].profit += trade.profit;
        }

        // Calculate win rate for each
        for (const asset in byAsset) {
            byAsset[asset].winRate = byAsset[asset].wins / byAsset[asset].trades;
        }

        return byAsset;
    }

    /**
     * Get performance by regime
     */
    getPerformanceByRegime() {
        const byRegime = {};

        for (const trade of this.trades) {
            const regime = trade.regime || 'UNKNOWN';

            if (!byRegime[regime]) {
                byRegime[regime] = {
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    profit: 0
                };
            }

            byRegime[regime].trades++;
            if (trade.outcome === 'win') {
                byRegime[regime].wins++;
            } else {
                byRegime[regime].losses++;
            }
            byRegime[regime].profit += trade.profit;
        }

        // Calculate win rate for each
        for (const regime in byRegime) {
            byRegime[regime].winRate = byRegime[regime].wins / byRegime[regime].trades;
        }

        return byRegime;
    }

    /**
     * Get time-based performance (by hour of day)
     */
    getPerformanceByHour() {
        const byHour = {};

        for (let i = 0; i < 24; i++) {
            byHour[i] = {
                trades: 0,
                wins: 0,
                profit: 0
            };
        }

        for (const trade of this.trades) {
            const hour = new Date(trade.timestamp).getHours();

            byHour[hour].trades++;
            if (trade.outcome === 'win') {
                byHour[hour].wins++;
            }
            byHour[hour].profit += trade.profit;
        }

        // Calculate win rate for each hour
        for (const hour in byHour) {
            byHour[hour].winRate = byHour[hour].trades > 0 ?
                byHour[hour].wins / byHour[hour].trades : 0;
        }

        return byHour;
    }

    /**
     * Get comprehensive summary
     */
    getSummary() {
        const { avgWin, avgLoss } = this.getAverageWinLoss();

        return {
            overview: {
                totalTrades: this.metrics.totalTrades,
                wins: this.metrics.wins,
                losses: this.metrics.losses,
                winRate: this.getWinRate(),
                profitFactor: this.getProfitFactor(),
                sharpeRatio: this.getSharpeRatio()
            },
            financial: {
                initialBalance: this.initialBalance,
                currentBalance: this.currentBalance,
                totalProfit: this.currentBalance - this.initialBalance,
                totalProfitPercent: ((this.currentBalance - this.initialBalance) / this.initialBalance * 100),
                avgWin,
                avgLoss,
                expectancy: (this.getWinRate() * avgWin) - ((1 - this.getWinRate()) * avgLoss)
            },
            risk: {
                maxDrawdown: this.metrics.maxDrawdown,
                maxDrawdownPercent: this.metrics.maxDrawdownPercent * 100,
                currentDrawdown: this.metrics.currentDrawdown,
                longestWinStreak: this.metrics.longestWinStreak,
                longestLossStreak: this.metrics.longestLossStreak,
                currentStreak: this.metrics.currentStreak,
                streakType: this.metrics.streakType
            },
            session: {
                duration: Date.now() - this.sessionStart,
                startTime: new Date(this.sessionStart).toISOString()
            },
            breakdown: {
                byAsset: this.getPerformanceByAsset(),
                byRegime: this.getPerformanceByRegime(),
                byHour: this.getPerformanceByHour()
            }
        };
    }

    /**
     * Get recent trades
     */
    getRecentTrades(count = 10) {
        return this.trades.slice(-count);
    }

    /**
     * Export all trades to JSON
     */
    exportTrades() {
        return {
            sessionStart: this.sessionStart,
            initialBalance: this.initialBalance,
            trades: this.trades,
            summary: this.getSummary()
        };
    }
}

module.exports = PerformanceTracker;
