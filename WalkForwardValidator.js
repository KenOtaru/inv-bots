class WalkForwardValidator {
  constructor(strategy, data, config = {}) {
    this.strategy = strategy;
    this.data = data;
    this.config = {
      trainPeriod: config.trainPeriod || 1000,
      testPeriod: config.testPeriod || 200,
      totalWalks: config.totalWalks || 20,
      minHistory: config.minHistory || 1000
    };
  }

  async executeWalkForward() {
    const results = [];
    const requiredData = this.config.trainPeriod + this.config.testPeriod;
    
    if (this.data.length < requiredData) {
      throw new Error(`Insufficient data: ${this.data.length} < ${requiredData}`);
    }

    console.log(`🔬 Running ${this.config.totalWalks} walk-forward periods...`);
    
    for (let i = 0; i < this.config.totalWalks; i++) {
      const trainStart = i * this.config.testPeriod;
      const trainEnd = trainStart + this.config.trainPeriod;
      const testStart = trainEnd;
      const testEnd = testStart + this.config.testPeriod;
      
      if (testEnd > this.data.length) {
        console.log(`⏹️  Stopping early at walk ${i+1}: insufficient data`);
        break;
      }
      
      const trainSet = this.data.slice(trainStart, trainEnd);
      const testSet = this.data.slice(testStart, testEnd);
      
      console.log(`📍 Walk ${i+1}: Train ${trainSet.length} | Test ${testSet.length} candles`);
      
      // Optimize parameters
      const params = this.optimizeParameters(trainSet);
      
      // Test on unseen data
      const performance = await this.simulate(testSet, params);
      
      results.push({
        walk: i + 1,
        params,
        performance
      });
      
      console.log(`   └─ Sharpe: ${performance.sharpe.toFixed(2)} | PF: ${performance.profitFactor.toFixed(2)} | Trades: ${performance.trades}`);
    }
    
    if (results.length === 0) {
      throw new Error('No walk-forward results generated');
    }
    
    return this.generateReport(results);
  }

  optimizeParameters(trainSet) {
    // Grid search over common parameter values
    const paramGrid = {
      entryThreshold: [2.0, 2.25, 2.5, 2.75, 3.0],
      lookback: [40, 45, 50, 55, 60]
    };
    
    let bestParams = { entryThreshold: 2.5, lookback: 50 }; // Defaults
    let bestScore = -Infinity;
    
    console.log(`   🔍 Optimizing parameters...`);
    
    for (const threshold of paramGrid.entryThreshold) {
      for (const lookback of paramGrid.lookback) {
        const params = { entryThreshold: threshold, lookback };
        const performance = this.simulate(trainSet, params);
        
        // Use Sharpe ratio as objective
        if (performance.sharpe > bestScore) {
          bestScore = performance.sharpe;
          bestParams = params;
        }
      }
    }
    
    console.log(`   ✅ Best: threshold=${bestParams.entryThreshold}, lookback=${bestParams.lookback} (Sharpe: ${bestScore.toFixed(2)})`);
    return bestParams;
  }

  async simulate(dataSet, params) {
    if (dataSet.length < this.config.minHistory) {
      return { sharpe: 0, profitFactor: 0, trades: 0, maxDrawdown: 0, winRate: 0 };
    }

    const trades = [];
    let capital = 10000;
    let peak = capital;
    let maxDrawdown = 0;

    // Apply parameters temporarily
    const originalConfig = this.strategy.config;
    this.strategy.config = { ...this.strategy.config, ...params };

    // Simulation loop
    for (let i = this.config.minHistory; i < dataSet.length - 2; i++) {
      const history = dataSet.slice(0, i);
      
      try {
        const signal = this.strategy.analyze(history);
        
        if (signal && trades.length === 0) {
          // Enter trade at next candle
          const entryPrice = dataSet[i + 1].open;
          const exitCandle = dataSet[i + 2];
          const exitPrice = exitCandle.open;
          
          // Calculate profit (simplified)
          const profit = signal.direction === 'CALL' 
            ? (exitPrice - entryPrice) * 100 
            : (entryPrice - exitPrice) * 100;
          
          const won = profit > 0;
          
          trades.push({
            profit,
            timestamp: exitCandle.timestamp,
            direction: signal.direction,
            won,
            confidence: signal.confidence
          });
          
          capital += profit;
          peak = Math.max(peak, capital);
          const drawdown = (peak - capital) / peak;
          maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
      } catch (error) {
        console.log(`   ⚠️  Simulation error: ${error.message}`);
      }
    }

    // Restore original config
    this.strategy.config = originalConfig;

    return this.calculatePerformance(trades, maxDrawdown);
  }

  calculatePerformance(trades, maxDrawdown) {
    if (!trades || trades.length === 0) {
      return { sharpe: 0, profitFactor: 0, trades: 0, maxDrawdown: 0, winRate: 0 };
    }
    
    const profits = trades.map(t => t.profit);
    const wins = trades.filter(t => t.profit > 0);
    const losses = trades.filter(t => t.profit < 0);
    
    // Sharpe ratio
    const mean = profits.reduce((a, b) => a + b, 0) / profits.length;
    const variance = profits.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / profits.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;
    
    // Profit factor
    const grossProfit = wins.reduce((sum, t) => sum + t.profit, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;
    
    // Win rate
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    
    return {
      sharpe,
      profitFactor,
      trades: trades.length,
      maxDrawdown: maxDrawdown || 0,
      winRate
    };
  }

  generateReport(results) {
    if (!results || results.length === 0) {
      throw new Error('No walk-forward results to analyze');
    }
    
    const sharpes = results.map(r => r.performance.sharpe);
    const drawdowns = results.map(r => r.performance.maxDrawdown);
    const profitFactors = results.map(r => r.performance.profitFactor);
    
    const sharpeMean = sharpes.reduce((a, b) => a + b) / sharpes.length;
    const sharpeStd = Math.sqrt(sharpes.reduce((sum, s) => sum + Math.pow(s - sharpeMean, 2), 0) / sharpes.length);
    const maxDD = Math.max(...drawdowns);
    const avgPF = profitFactors.reduce((a, b) => a + b) / profitFactors.length;
    
    // Statistical significance
    const tStatistic = sharpeMean / (sharpeStd / Math.sqrt(sharpes.length));
    const pValue = this.calculatePValue(tStatistic, sharpes.length - 1);
    
    // Parameter stability
    const paramStability = this.calculateParameterStability(results);
    
    return {
      sharpeMean,
      sharpeStd,
      maxDD,
      profitFactor: avgPF,
      tStatistic,
      pValue,
      paramStability,
      isValid: pValue < 0.05 && maxDD < 0.15 && sharpeMean > 0.3,
      failureReasons: this.getFailureReasons(sharpes, drawdowns, pValue, paramStability),
      results
    };
  }

  calculatePValue(tStatistic, df) {
    const a = Math.abs(tStatistic);
    if (a > 10) return 0;
    
    const b = df / (df + a * a);
    const t = Math.sqrt(b);
    const x = a * t / Math.sqrt(2);
    
    return 2 * (1 - this.erfApprox(x));
  }

  erfApprox(x) {
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    
    return sign * y;
  }

  calculateParameterStability(results) {
    const thresholds = results.map(r => r.params.entryThreshold);
    const lookbacks = results.map(r => r.params.lookback);
    
    const thresholdCV = this.coefficientOfVariation(thresholds);
    const lookbackCV = this.coefficientOfVariation(lookbacks);
    
    return (thresholdCV + lookbackCV) / 2;
  }

  coefficientOfVariation(data) {
    const mean = data.reduce((a, b) => a + b) / data.length;
    const stdDev = Math.sqrt(data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length);
    return mean > 0 ? stdDev / mean : 0;
  }

  getFailureReasons(sharpes, drawdowns, pValue, paramStability) {
    const reasons = [];
    const minSharpe = Math.min(...sharpes);
    const maxDrawdown = Math.max(...drawdowns);
    
    if (minSharpe <= 0.3) reasons.push(`Low Sharpe: ${minSharpe.toFixed(2)}`);
    if (maxDrawdown >= 0.15) reasons.push(`High drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
    if (pValue >= 0.05) reasons.push(`Not significant: p=${pValue.toFixed(3)}`);
    if (paramStability >= 0.3) reasons.push(`Unstable params: CV=${paramStability.toFixed(2)}`);
    
    return reasons;
  }
}

module.exports = WalkForwardValidator;