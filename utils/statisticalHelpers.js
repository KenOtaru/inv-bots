/**
 * Statistical Helper Functions
 * Provides utility functions for statistical calculations used throughout the enhanced bot
 */

/**
 * Calculate mean of an array
 */
function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

/**
 * Calculate standard deviation
 */
function standardDeviation(arr) {
    if (!arr || arr.length === 0) return 0;
    const avg = mean(arr);
    const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
    return Math.sqrt(mean(squareDiffs));
}

/**
 * Calculate Pearson correlation coefficient between two arrays
 */
function pearsonCorrelation(arr1, arr2) {
    if (!arr1 || !arr2 || arr1.length !== arr2.length || arr1.length === 0) return 0;

    const n = arr1.length;
    const mean1 = mean(arr1);
    const mean2 = mean(arr2);

    let numerator = 0;
    let sumSq1 = 0;
    let sumSq2 = 0;

    for (let i = 0; i < n; i++) {
        const diff1 = arr1[i] - mean1;
        const diff2 = arr2[i] - mean2;
        numerator += diff1 * diff2;
        sumSq1 += diff1 * diff1;
        sumSq2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(sumSq1 * sumSq2);
    return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Calculate percentile of a sorted or unsorted array
 */
function percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;

    if (lower === upper) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Calculate Value at Risk (VaR)
 */
function valueAtRisk(returns, confidence = 0.95) {
    if (!returns || returns.length === 0) return 0;
    return -percentile(returns, (1 - confidence) * 100);
}

/**
 * Calculate Conditional Value at Risk (CVaR)
 */
function conditionalVaR(returns, confidence = 0.95) {
    if (!returns || returns.length === 0) return 0;
    const var_threshold = valueAtRisk(returns, confidence);
    const losses = returns.filter(r => -r >= var_threshold);
    return losses.length > 0 ? -mean(losses) : var_threshold;
}

/**
 * Calculate Sharpe Ratio
 */
function sharpeRatio(returns, riskFreeRate = 0) {
    if (!returns || returns.length === 0) return 0;
    const excessReturns = returns.map(r => r - riskFreeRate);
    const avgExcessReturn = mean(excessReturns);
    const stdDev = standardDeviation(excessReturns);
    return stdDev === 0 ? 0 : avgExcessReturn / stdDev;
}

/**
 * Beta distribution for Bayesian analysis
 */
class BetaDistribution {
    constructor(alpha = 1, beta = 1) {
        this.alpha = alpha;
        this.beta = beta;
    }

    update(success) {
        if (success) {
            this.alpha += 1;
        } else {
            this.beta += 1;
        }
    }

    getMean() {
        return this.alpha / (this.alpha + this.beta);
    }

    getMode() {
        if (this.alpha > 1 && this.beta > 1) {
            return (this.alpha - 1) / (this.alpha + this.beta - 2);
        }
        return this.getMean();
    }

    getVariance() {
        const sum = this.alpha + this.beta;
        return (this.alpha * this.beta) / (sum * sum * (sum + 1));
    }

    getStdDev() {
        return Math.sqrt(this.getVariance());
    }

    // Get 95% credible interval
    getCredibleInterval(confidence = 0.95) {
        const mean = this.getMean();
        const stdDev = this.getStdDev();
        const z = 1.96; // For 95% confidence
        return {
            lower: Math.max(0, mean - z * stdDev),
            upper: Math.min(1, mean + z * stdDev)
        };
    }
}

/**
 * Exponential moving average
 */
function ema(arr, period) {
    if (!arr || arr.length === 0) return [];
    const k = 2 / (period + 1);
    const emaArr = [arr[0]];

    for (let i = 1; i < arr.length; i++) {
        emaArr.push(arr[i] * k + emaArr[i - 1] * (1 - k));
    }

    return emaArr;
}

/**
 * Calculate rolling statistic
 */
function rolling(arr, window, fn) {
    if (!arr || arr.length < window) return [];
    const result = [];

    for (let i = window - 1; i < arr.length; i++) {
        const slice = arr.slice(i - window + 1, i + 1);
        result.push(fn(slice));
    }

    return result;
}

/**
 * Levenshtein distance for pattern similarity
 */
function levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[str2.length][str1.length];
}

/**
 * Cosine similarity for vectors
 */
function cosineSimilarity(vec1, vec2) {
    if (!vec1 || !vec2 || vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    for (let i = 0; i < vec1.length; i++) {
        dotProduct += vec1[i] * vec2[i];
        mag1 += vec1[i] * vec1[i];
        mag2 += vec2[i] * vec2[i];
    }

    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);

    if (mag1 === 0 || mag2 === 0) return 0;
    return dotProduct / (mag1 * mag2);
}

/**
 * Normalize array to [0, 1] range
 */
function normalize(arr) {
    if (!arr || arr.length === 0) return [];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min;

    if (range === 0) return arr.map(() => 0.5);
    return arr.map(val => (val - min) / range);
}

/**
 * Z-score normalization
 */
function zScore(arr) {
    if (!arr || arr.length === 0) return [];
    const avg = mean(arr);
    const std = standardDeviation(arr);

    if (std === 0) return arr.map(() => 0);
    return arr.map(val => (val - avg) / std);
}

module.exports = {
    mean,
    standardDeviation,
    pearsonCorrelation,
    percentile,
    valueAtRisk,
    conditionalVaR,
    sharpeRatio,
    BetaDistribution,
    ema,
    rolling,
    levenshteinDistance,
    cosineSimilarity,
    normalize,
    zScore
};
