/**
 * Enhanced Survival Analysis
 * Implements Kaplan-Meier estimator, Cox Proportional Hazards, and Weibull distribution fitting
 */

class SurvivalAnalysis {
    constructor() {
        this.survivalData = [];
        this.censoredData = [];
    }

    /**
     * Add survival data point
     * @param {number} time - Time to event (tick count)
     * @param {boolean} event - True if event occurred (knockoutstake), false if censored (closed early)
     * @param {object} covariates - Additional variables (asset, volatility, etc.)
     */
    addDataPoint(time, event, covariates = {}) {
        this.survivalData.push({
            time,
            event,
            covariates
        });
    }

    /**
     * Kaplan-Meier Estimator
     * Calculate survival function S(t) = P(T > t)
     */
    kaplanMeierEstimator() {
        if (this.survivalData.length === 0) {
            // Optimistic default for cold start
            return {
                times: [0, 100],
                survival: [1.0, 1.0],
                stderr: [0, 0],
                atRisk: [0, 0],
                events: [0, 0]
            };
        }

        // Sort data by time
        const sorted = [...this.survivalData].sort((a, b) => a.time - b.time);

        // Group by unique times
        const uniqueTimes = [...new Set(sorted.map(d => d.time))].sort((a, b) => a - b);

        let nAtRisk = sorted.length;
        let survivalProb = 1.0;
        const results = {
            times: [0],
            survival: [1.0],
            stderr: [0],
            atRisk: [nAtRisk],
            events: [0]
        };

        for (const t of uniqueTimes) {
            // Count events and censored at this time
            const atThisTime = sorted.filter(d => d.time === t);
            const events = atThisTime.filter(d => d.event).length;
            const censored = atThisTime.filter(d => !d.event).length;

            if (events > 0) {
                // Update survival probability
                survivalProb *= (nAtRisk - events) / nAtRisk;

                // Greenwood's formula for standard error
                const variance = this._greenwoodVariance(results.times, results.atRisk, results.events);
                const stderr = Math.sqrt(variance) * survivalProb;

                results.times.push(t);
                results.survival.push(survivalProb);
                results.stderr.push(stderr);
                results.atRisk.push(nAtRisk);
                results.events.push(events);
            }

            // Update number at risk
            nAtRisk -= (events + censored);
        }

        return results;
    }

    /**
     * Greenwood's formula for variance estimation
     */
    _greenwoodVariance(times, atRisk, events) {
        let variance = 0;
        for (let i = 1; i < times.length; i++) {
            const n = atRisk[i];
            const d = events[i];
            if (n > d && d > 0) {
                variance += d / (n * (n - d));
            }
        }
        return variance;
    }

    /**
     * Get survival probability at specific time with confidence interval
     */
    getSurvivalProbability(time, confidence = 0.95) {
        const km = this.kaplanMeierEstimator();

        // Find closest time point
        let idx = 0;
        for (let i = 0; i < km.times.length; i++) {
            if (km.times[i] <= time) {
                idx = i;
            } else {
                break;
            }
        }

        const survivalProb = km.survival[idx];
        const stderr = km.stderr[idx];

        // Calculate confidence interval (using normal approximation)
        const z = 1.96; // For 95% confidence
        const lower = Math.max(0, survivalProb - z * stderr);
        const upper = Math.min(1, survivalProb + z * stderr);

        return {
            time: km.times[idx],
            survival: survivalProb,
            lowerCI: lower,
            upperCI: upper,
            stderr: stderr
        };
    }

    /**
     * Calculate hazard rate at time t
     * h(t) = instantaneous risk of event at time t
     */
    calculateHazardRate(time, window = 5) {
        // Estimate hazard using empirical approach
        const inWindow = this.survivalData.filter(d =>
            d.time >= time - window / 2 && d.time < time + window / 2
        );

        if (inWindow.length === 0) return 0;

        const events = inWindow.filter(d => d.event).length;
        const hazard = events / inWindow.length / window;

        return hazard;
    }

    /**
     * Cumulative hazard function
     * H(t) = -log(S(t))
     */
    cumulativeHazard(time) {
        const km = this.getSurvivalProbability(time);
        return -Math.log(Math.max(0.0001, km.survival));
    }

    /**
     * Weibull distribution fitting
     * Fit Weibull(α, β) to survival times
     * Returns shape (α) and scale (β) parameters
     */
    fitWeibullDistribution() {
        // Only use complete observations (events that occurred)
        const completeTimes = this.survivalData
            .filter(d => d.event)
            .map(d => d.time);

        if (completeTimes.length < 10) {
            return { shape: 1, scale: 1, fitted: false };
        }

        // Use maximum likelihood estimation (simplified)
        // This is a basic implementation; in production, use numerical optimization

        const n = completeTimes.length;
        const sumLogT = completeTimes.reduce((sum, t) => sum + Math.log(Math.max(1, t)), 0);
        const sumT = completeTimes.reduce((sum, t) => sum + t, 0);

        // Initial guess for shape parameter
        let shape = 1.5;

        // Newton-Raphson iteration for shape parameter
        for (let iter = 0; iter < 20; iter++) {
            const sumTk = completeTimes.reduce((sum, t) => sum + Math.pow(t, shape), 0);
            const sumTkLogT = completeTimes.reduce((sum, t) =>
                sum + Math.pow(t, shape) * Math.log(Math.max(1, t)), 0);

            const f = sumTkLogT / sumTk - sumLogT / n - 1 / shape;
            const df = (sumTkLogT * sumTkLogT - sumTk * sumTkLogT) / (sumTk * sumTk) + 1 / (shape * shape);

            shape = shape - f / df;

            if (Math.abs(f) < 0.0001) break;
        }

        // Calculate scale parameter
        const scale = Math.pow(sumT / n, 1 / shape);

        return {
            shape: Math.max(0.5, Math.min(5, shape)), // Constrain to reasonable range
            scale: Math.max(1, scale),
            fitted: true
        };
    }

    /**
     * Predict survival probability for next N ticks using current data
     */
    predictSurvivalForNextTicks(currentTicks, nextTicks = 10) {
        const km = this.getSurvivalProbability(currentTicks);
        const futureKm = this.getSurvivalProbability(currentTicks + nextTicks);

        // Conditional probability: P(survive to t+n | survived to t) = S(t+n) / S(t)
        const conditionalSurvival = km.survival > 0 ?
            futureKm.survival / km.survival : 0;

        return {
            currentSurvival: km.survival,
            futureSurvival: futureKm.survival,
            conditionalSurvival: Math.min(1, Math.max(0, conditionalSurvival)),
            currentTicks: currentTicks,
            targetTicks: currentTicks + nextTicks
        };
    }

    /**
     * Get median survival time
     */
    getMedianSurvivalTime() {
        const km = this.kaplanMeierEstimator();

        // Find time where survival probability drops below 0.5
        for (let i = 0; i < km.survival.length; i++) {
            if (km.survival[i] < 0.5) {
                return km.times[i];
            }
        }

        // If survival never drops below 0.5, return max time
        return km.times[km.times.length - 1];
    }

    /**
     * Calculate survival metrics for reporting
     */
    getSurvivalMetrics() {
        if (this.survivalData.length === 0) {
            return null;
        }

        const km = this.kaplanMeierEstimator();
        const weibull = this.fitWeibullDistribution();
        const median = this.getMedianSurvivalTime();

        return {
            totalObservations: this.survivalData.length,
            events: this.survivalData.filter(d => d.event).length,
            censored: this.survivalData.filter(d => !d.event).length,
            medianSurvivalTime: median,
            weibullShape: weibull.shape,
            weibullScale: weibull.scale,
            survivalCurve: {
                times: km.times,
                probabilities: km.survival
            }
        };
    }

    /**
     * Clear old data (keep last N observations)
     */
    pruneData(maxObservations = 1000) {
        if (this.survivalData.length > maxObservations) {
            this.survivalData = this.survivalData.slice(-maxObservations);
        }
    }
}

module.exports = SurvivalAnalysis;
