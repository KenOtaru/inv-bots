/**
 * Monte Carlo Simulator
 * Runs simulations to estimate trade outcomes and risk metrics
 */

const { mean, percentile, valueAtRisk, conditionalVaR } = require('../utils/statisticalHelpers');

class MonteCarloSimulator {
    constructor(config = {}) {
        this.numSimulations = config.numSimulations || 10000;
        this.confidence = config.confidence || 0.95;
    }

    /**
     * Simulate single trade outcome
     */
    simulateTrade(params) {
        const {
            stake,
            growthRate,
            winProbability,
            estimatedTicks = 10,
            volatility = 0.5
        } = params;

        // Simulate if trade wins or loses
        const wins = Math.random() < winProbability;

        if (!wins) {
            return -stake; // Loss
        }

        // If wins, simulate tick duration with volatility
        // Use log-normal distribution for tick count
        const logMean = Math.log(estimatedTicks);
        const logStdDev = volatility * 0.5; // Volatility affects tick uncertainty

        const randomNormal = this._boxMullerTransform();
        const simulatedTicks = Math.max(1, Math.exp(logMean + logStdDev * randomNormal));

        // Calculate profit
        const multiplier = Math.pow(1 + growthRate, simulatedTicks);
        const payout = stake * multiplier;
        const profit = payout - stake;

        return profit;
    }

    /**
     * Run Monte Carlo simulation for a trade
     */
    simulateTradeOutcomes(params) {
        const outcomes = [];

        for (let i = 0; i < this.numSimulations; i++) {
            const outcome = this.simulateTrade(params);
            outcomes.push(outcome);
        }

        return this._analyzeOutcomes(outcomes, params.stake);
    }

    /**
     * Analyze simulation outcomes
     */
    _analyzeOutcomes(outcomes, stake) {
        const sorted = [...outcomes].sort((a, b) => a - b);

        // Calculate statistics
        const avgOutcome = mean(outcomes);
        const wins = outcomes.filter(o => o > 0).length;
        const losses = outcomes.filter(o => o <= 0).length;
        const winRate = wins / outcomes.length;

        // Risk metrics
        const var95 = valueAtRisk(outcomes, this.confidence);
        const cvar95 = conditionalVaR(outcomes, this.confidence);

        // Probability of ruin (losing more than 50% of stake)
        const ruinOutcomes = outcomes.filter(o => o < -stake * 0.5).length;
        const probRuin = ruinOutcomes / outcomes.length;

        // Percentiles
        const p10 = percentile(outcomes, 10);
        const p25 = percentile(outcomes, 25);
        const p50 = percentile(outcomes, 50);
        const p75 = percentile(outcomes, 75);
        const p90 = percentile(outcomes, 90);

        return {
            expectedValue: avgOutcome,
            winRate: winRate,
            wins: wins,
            losses: losses,
            var95: var95,
            cvar95: cvar95,
            probabilityOfRuin: probRuin,
            percentiles: {
                p10, p25, p50, p75, p90
            },
            min: sorted[0],
            max: sorted[sorted.length - 1],
            // Decision helpers
            isPositiveEV: avgOutcome > 0,
            isAcceptableRisk: var95 < stake * 2 && probRuin < 0.05
        };
    }

    /**
     * Simulate portfolio of trades
     */
    simulatePortfolio(trades, initialBalance) {
        const portfolioOutcomes = [];

        for (let sim = 0; sim < this.numSimulations; sim++) {
            let balance = initialBalance;
            const tradeResults = [];

            for (const trade of trades) {
                const outcome = this.simulateTrade(trade);
                balance += outcome;
                tradeResults.push({
                    outcome,
                    balance
                });

                // Stop if balance too low
                if (balance < trade.stake) break;
            }

            portfolioOutcomes.push({
                finalBalance: balance,
                totalProfit: balance - initialBalance,
                trades: tradeResults
            });
        }

        return this._analyzePortfolio(portfolioOutcomes, initialBalance);
    }

    /**
     * Analyze portfolio simulation results
     */
    _analyzePortfolio(portfolioOutcomes, initialBalance) {
        const finalBalances = portfolioOutcomes.map(p => p.finalBalance);
        const profits = portfolioOutcomes.map(p => p.totalProfit);

        const avgFinalBalance = mean(finalBalances);
        const avgProfit = mean(profits);

        const profitable = portfolioOutcomes.filter(p => p.totalProfit > 0).length;
        const probProfit = profitable / portfolioOutcomes.length;

        const var95 = valueAtRisk(profits, this.confidence);
        const cvar95 = conditionalVaR(profits, this.confidence);

        // Max drawdown across simulations
        const maxDrawdowns = portfolioOutcomes.map(p => {
            let peak = initialBalance;
            let maxDD = 0;

            for (const trade of p.trades) {
                peak = Math.max(peak, trade.balance);
                const dd = (peak - trade.balance) / peak;
                maxDD = Math.max(maxDD, dd);
            }

            return maxDD;
        });

        const avgMaxDrawdown = mean(maxDrawdowns);
        const worstDrawdown = Math.max(...maxDrawdowns);

        return {
            expectedFinalBalance: avgFinalBalance,
            expectedProfit: avgProfit,
            probabilityOfProfit: probProfit,
            var95: var95,
            cvar95: cvar95,
            avgMaxDrawdown: avgMaxDrawdown,
            worstDrawdown: worstDrawdown,
            percentiles: {
                p10: percentile(profits, 10),
                p25: percentile(profits, 25),
                p50: percentile(profits, 50),
                p75: percentile(profits, 75),
                p90: percentile(profits, 90)
            }
        };
    }

    /**
     * Box-Muller transform for generating normal distribution
     */
    _boxMullerTransform() {
        const u1 = Math.random();
        const u2 = Math.random();

        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return z0;
    }

    /**
     * Estimate optimal stake size using simulations
     */
    optimizeStakeSize(params, minStake, maxStake, steps = 10) {
        const stakeRange = maxStake - minStake;
        const stepSize = stakeRange / steps;

        const results = [];

        for (let i = 0; i <= steps; i++) {
            const stake = minStake + (i * stepSize);
            const simParams = { ...params, stake };
            const outcome = this.simulateTradeOutcomes(simParams);

            results.push({
                stake,
                expectedValue: outcome.expectedValue,
                winRate: outcome.winRate,
                var95: outcome.var95,
                sharpeRatio: outcome.expectedValue / (outcome.var95 || 1)
            });
        }

        // Find stake with best risk-adjusted return (Sharpe ratio)
        results.sort((a, b) => b.sharpeRatio - a.sharpeRatio);

        return {
            optimalStake: results[0].stake,
            results: results
        };
    }
}

module.exports = MonteCarloSimulator;
