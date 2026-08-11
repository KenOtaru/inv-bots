// ============================================================================  
// DERIV RISE/FALL TRADING BOT v4.0 — MICRO-STRUCTURE & PAYOUT OPTIMIZED
// ============================================================================
'use strict';  
  
require('dotenv').config();  
const fs = require('fs');  
const path = require('path');  
const https = require('https');  
const http = require('http');  
const { URL } = require('url');  
const WebSocket = require('ws');  
const TelegramBot = require('node-telegram-bot-api');  
const winston = require('winston');  
const { EventEmitter } = require('events');  

// [KEEP YOUR EXISTING SECTION 1 (ConfigManager), SECTION 2 (Logger), 
// and SECTION 3 (IndicatorLibrary) EXACTLY AS THEY WERE TO SAVE SPACE]
// ... (Assuming ConfigManager, Logger, IndicatorLibrary, CandleBuilder, 
// CandlePatternDetector, MarketRegimeDetector are imported/kept from v3.1) ...

// ============================================================================  
// SECTION 1: CONFIGURATION  
// ============================================================================  
class ConfigManager {  
  constructor() {  
    this.config = {  
      deriv: {   
        apiToken: 'pat_27a3197287bae3ec6c2c9cbdd68fffaa2a524e3b0a6e1ecf298b5ffb338adb10',
        appId: '33uslPtthXBEkQOdfKfoY',
        endpoint: `wss://ws.derivws.com/websockets/v3?app_id=${'33uslPtthXBEkQOdfKfoY'}`,
        accountType: 'DEMO',
      },  
      telegram: {  
        botToken: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
        chatId: '752497117',
        enabled: true,  
      },  
      trading: {  
        symbol: 'R_75',  
        initialStake: 1.5,  
        contractDuration: 5,  
        contractDurationUnit: 't',  
        maxConcurrentTrades: 1,  
        maxDailyLoss: 10,  
        maxDailyTrades: 100,  
        takeProfitTarget: 20,  
        cooldownAfterLoss: 3,  
        minTimeBetweenTrades: 5000,  
      },  
      analysis: {  
        // Minimum confidence to place a trade (0-100)  
        minConfidence: 62,  
        // Minimum agreeing strategies to trade (1-7)  
        minAgreeing: 2,  
        // Number of ticks to collect before trading  
        warmupTicks: 80,  
        // OHLC candle size in ticks (5 ticks is optimal for 5-tick duration)  
        candleSize: 5,  
        // Enable/disable individual strategies  
        enableMeanReversion: true,  
        enableTrendFollowing: true,  
        enableMomentum: true,  
        enableStatistical: true,  
        enableCandlePatterns: true,  
        enableHeikinAshi: true,  
        enableStochRSI: true,  
      },  
      risk: {  
        kellyFraction: 0.25,  
        maxStakeMultiplier: 10, // increased to allow Martingale steps  
        drawdownLimit: 15,  
        volatilityAdjust: true,  
        martingaleEnabled: true,  
        martingaleMultiplier: 2.0,  
        martingaleMaxSteps: 3,  
        antiMartingaleEnabled: false,  
      },  
      system: {  
        tickHistoryCount: 1000, // increased from 500 to allow immediate ADX calculations  
        maxTickBuffer: 1000,  
        reconnectDelay: 5000,  
        maxReconnectAttempts: 15,  
        heartbeatInterval: 30000,  
      },  
    };  
    this.validate();  
  }  
  
  validate() {  
    const errors = [];  
    if (!this.config.deriv.apiToken) {  
      errors.push('DERIV_API_TOKEN is required');  
    }  
    if (this.config.trading.initialStake <= 0) {  
      errors.push('INITIAL_STAKE must be > 0');  
    }  
    if (errors.length > 0) {  
      console.error('\n❌ Configuration Errors:');  
      errors.forEach((e) => console.error(`• ${e}`));  
      process.exit(1);  
    }  
  }  
  
  get(pathStr) {  
    return pathStr.split('.').reduce((obj, key) => obj?.[key], this.config);  
  }  
}  
  
// ============================================================================  
// SECTION 2: LOGGER  
// ============================================================================  
class Logger {  
  constructor() {  
    this.logger = winston.createLogger({  
      level: process.env.LOG_LEVEL || 'info',  
      format: winston.format.combine(  
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),  
        winston.format.printf(({ timestamp, level, message }) => {  
          const icons = { info: 'ℹ️', warn: '⚠️', error: '❌', debug: '🔍' };  
          return `[${timestamp}] ${icons[level] || '📌'} ${level.toUpperCase()}: ${message}`;  
        })  
      ),  
      transports: [  
        new winston.transports.Console(),  
        new winston.transports.File({  
          filename: 'bot-error.log',  
          level: 'error',  
          maxsize: 5242880,  
          maxFiles: 3,  
        }),  
        new winston.transports.File({  
          filename: 'bot-combined.log',  
          maxsize: 10485760,  
          maxFiles: 5,  
        }),  
      ],  
    });  
  }  
  
  info(msg) { this.logger.info(msg); }  
  warn(msg) { this.logger.warn(msg); }  
  error(msg) { this.logger.error(msg); }  
  debug(msg) { this.logger.debug(msg); }  
}  
  
// ============================================================================  
// SECTION 3: INDICATOR LIBRARY  
// Core mathematical functions for all technical indicators  
// ============================================================================  
class IndicatorLibrary {  
  // ── Simple Moving Average ──  
  static SMA(data, period) {  
    if (data.length < period) return null;  
    const slice = data.slice(-period);  
    return slice.reduce((s, v) => s + v, 0) / period;  
  }  
  
  // ── Exponential Moving Average ──  
  static EMA(data, period) {  
    if (data.length < period) return null;  
    const k = 2 / (period + 1);  
    let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;  
    for (let i = period; i < data.length; i++) {  
      ema = (data[i] - ema) * k + ema;  
    }  
    return ema;  
  }  
  
  // ── Full EMA Series ──  
  static EMASeries(data, period) {  
    if (data.length < period) return [];  
    const k = 2 / (period + 1);  
    const series = [];  
    let ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;  
    series.push(ema);  
    for (let i = period; i < data.length; i++) {  
      ema = (data[i] - ema) * k + ema;  
      series.push(ema);  
    }  
    return series;  
  }  
  
  // ── Relative Strength Index ──  
  static RSI(data, period = 14) {  
    if (data.length < period + 1) return null;  
    const changes = [];  
    for (let i = 1; i < data.length; i++) {  
      changes.push(data[i] - data[i - 1]);  
    }  
    let avgGain = 0, avgLoss = 0;  
    for (let i = 0; i < period; i++) {  
      if (changes[i] > 0) avgGain += changes[i];  
      else avgLoss += Math.abs(changes[i]);  
    }  
    avgGain /= period;  
    avgLoss /= period;  
    for (let i = period; i < changes.length; i++) {  
      const gain = changes[i] > 0 ? changes[i] : 0;  
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;  
      avgGain = (avgGain * (period - 1) + gain) / period;  
      avgLoss = (avgLoss * (period - 1) + loss) / period;  
    }  
    if (avgLoss === 0) return 100;  
    return 100 - 100 / (1 + avgGain / avgLoss);  
  }  
  
  // ── RSI Series (full history) ──  
  static RSISeries(data, period = 14) {  
    if (data.length < period + 1) return [];  
    const changes = [];  
    for (let i = 1; i < data.length; i++) {  
      changes.push(data[i] - data[i - 1]);  
    }  
    const series = [];  
    let avgGain = 0, avgLoss = 0;  
    for (let i = 0; i < period; i++) {  
      if (changes[i] > 0) avgGain += changes[i];  
      else avgLoss += Math.abs(changes[i]);  
    }  
    avgGain /= period;  
    avgLoss /= period;  
    series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));  
    for (let i = period; i < changes.length; i++) {  
      const gain = changes[i] > 0 ? changes[i] : 0;  
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;  
      avgGain = (avgGain * (period - 1) + gain) / period;  
      avgLoss = (avgLoss * (period - 1) + loss) / period;  
      series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));  
    }  
    return series;  
  }  
  
  // ── Stochastic Oscillator ──  
  static Stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {  
    if (closes.length < kPeriod) return null;  
    const kValues = [];  
    for (let i = kPeriod - 1; i < closes.length; i++) {  
      const highSlice = highs.slice(i - kPeriod + 1, i + 1);  
      const lowSlice = lows.slice(i - kPeriod + 1, i + 1);  
      const highestHigh = Math.max(...highSlice);  
      const lowestLow = Math.min(...lowSlice);  
      const range = highestHigh - lowestLow;  
      kValues.push(range === 0 ? 50 : ((closes[i] - lowestLow) / range) * 100);  
    }  
    const k = kValues[kValues.length - 1];  
    const d = kValues.length >= dPeriod  
      ? kValues.slice(-dPeriod).reduce((s, v) => s + v, 0) / dPeriod  
      : k;  
    return { k, d, kValues };  
  }  
  
  // ── Stochastic RSI ──  
  static StochRSI(data, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {  
    const rsiSeries = IndicatorLibrary.RSISeries(data, rsiPeriod);  
    if (rsiSeries.length < stochPeriod) return null;  
  
    const stochRSIValues = [];  
    for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {  
      const slice = rsiSeries.slice(i - stochPeriod + 1, i + 1);  
      const max = Math.max(...slice);  
      const min = Math.min(...slice);  
      const range = max - min;  
      stochRSIValues.push(range === 0 ? 50 : ((rsiSeries[i] - min) / range) * 100);  
    }  
  
    // Smooth K  
    const kValues = [];  
    for (let i = kSmooth - 1; i < stochRSIValues.length; i++) {  
      const avg = stochRSIValues.slice(i - kSmooth + 1, i + 1).reduce((s, v) => s + v, 0) / kSmooth;  
      kValues.push(avg);  
    }  
  
    // Smooth D  
    const k = kValues.length > 0 ? kValues[kValues.length - 1] : 50;  
    const d = kValues.length >= dSmooth  
      ? kValues.slice(-dSmooth).reduce((s, v) => s + v, 0) / dSmooth  
      : k;  
  
    return { k, d, kValues };  
  }  
  
  // ── Bollinger Bands ──  
  static BollingerBands(data, period = 20, stdMult = 2) {  
    const sma = IndicatorLibrary.SMA(data, period);  
    if (sma === null) return null;  
    const slice = data.slice(-period);  
    const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;  
    const stdDev = Math.sqrt(variance);  
    return {  
      upper: sma + stdMult * stdDev,  
      middle: sma,  
      lower: sma - stdMult * stdDev,  
      bandwidth: (2 * stdMult * stdDev) / sma,  
      percentB: stdDev === 0 ? 0.5 : (data[data.length - 1] - (sma - stdMult * stdDev)) / (2 * stdMult * stdDev),  
      stdDev,  
    };  
  }  
  
  // ── MACD ──  
  static MACD(data, fast = 12, slow = 26, signal = 9) {  
    if (data.length < slow + signal) return null;  
    const macdLine = [];  
    for (let i = slow; i <= data.length; i++) {  
      const slice = data.slice(0, i);  
      const f = IndicatorLibrary.EMA(slice, fast);  
      const s = IndicatorLibrary.EMA(slice, slow);  
      if (f !== null && s !== null) macdLine.push(f - s);  
    }  
    if (macdLine.length < signal) return null;  
    const signalLine = IndicatorLibrary.EMA(macdLine, signal);  
    const currentMACD = macdLine[macdLine.length - 1];  
    const prevMACD = macdLine.length > 1 ? macdLine[macdLine.length - 2] : currentMACD;  
    return {  
      macd: currentMACD,  
      signal: signalLine,  
      histogram: signalLine !== null ? currentMACD - signalLine : 0,  
      prevMACD,  
      rising: currentMACD > prevMACD,  
    };  
  }  
  
  // ── Average Directional Index (ADX) ──  
  static ADX(highs, lows, closes, period = 14) {  
    if (highs.length < period * 2) return null;  
    const trueRanges = [];  
    const plusDM = [];  
    const minusDM = [];  
  
    for (let i = 1; i < highs.length; i++) {  
      const hl = highs[i] - lows[i];  
      const hpc = Math.abs(highs[i] - closes[i - 1]);  
      const lpc = Math.abs(lows[i] - closes[i - 1]);  
      trueRanges.push(Math.max(hl, hpc, lpc));  
  
      const upMove = highs[i] - highs[i - 1];  
      const downMove = lows[i - 1] - lows[i];  
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);  
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);  
    }  
  
    if (trueRanges.length < period) return null;  
  
    // Smoothed averages  
    let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;  
    let aPlusDM = plusDM.slice(0, period).reduce((s, v) => s + v, 0) / period;  
    let aMinusDM = minusDM.slice(0, period).reduce((s, v) => s + v, 0) / period;  
  
    const dxValues = [];  
  
    for (let i = period; i < trueRanges.length; i++) {  
      atr = (atr * (period - 1) + trueRanges[i]) / period;  
      aPlusDM = (aPlusDM * (period - 1) + plusDM[i]) / period;  
      aMinusDM = (aMinusDM * (period - 1) + minusDM[i]) / period;  
  
      const plusDI = atr === 0 ? 0 : (aPlusDM / atr) * 100;  
      const minusDI = atr === 0 ? 0 : (aMinusDM / atr) * 100;  
      const diSum = plusDI + minusDI;  
      const dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;  
      dxValues.push({ dx, plusDI, minusDI });  
    }  
  
    if (dxValues.length < period) return null;  
  
    let adx = dxValues.slice(0, period).reduce((s, v) => s + v.dx, 0) / period;  
    for (let i = period; i < dxValues.length; i++) {  
      adx = (adx * (period - 1) + dxValues[i].dx) / period;  
    }  
  
    const last = dxValues[dxValues.length - 1];  
    return {  
      adx,  
      plusDI: last.plusDI,  
      minusDI: last.minusDI,  
      trending: adx > 25,  
      strongTrend: adx > 40,  
    };  
  }  
  
  // ── Donchian Channels ──  
  static DonchianChannel(highs, lows, period = 20) {  
    if (highs.length < period) return null;  
    const hSlice = highs.slice(-period);  
    const lSlice = lows.slice(-period);  
    const upper = Math.max(...hSlice);  
    const lower = Math.min(...lSlice);  
    return {  
      upper,  
      lower,  
      middle: (upper + lower) / 2,  
      width: upper - lower,  
    };  
  }  
  
  // ── Average True Range ──  
  static ATR(highs, lows, closes, period = 14) {  
    if (highs.length < period + 1) return null;  
    const trs = [];  
    for (let i = 1; i < highs.length; i++) {  
      trs.push(Math.max(  
        highs[i] - lows[i],  
        Math.abs(highs[i] - closes[i - 1]),  
        Math.abs(lows[i] - closes[i - 1])  
      ));  
    }  
    if (trs.length < period) return null;  
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;  
    for (let i = period; i < trs.length; i++) {  
      atr = (atr * (period - 1) + trs[i]) / period;  
    }  
    return atr;  
  }  
  
  // ── Z-Score ──  
  static ZScore(data, period = 20) {  
    if (data.length < period) return null;  
    const slice = data.slice(-period);  
    const mean = slice.reduce((s, v) => s + v, 0) / period;  
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;  
    const stdDev = Math.sqrt(variance);  
    if (stdDev === 0) return 0;  
    return (data[data.length - 1] - mean) / stdDev;  
  }  
  
  // ── Linear Regression Slope ──  
  static LinearRegressionSlope(data, period = 20) {  
    if (data.length < period) return null;  
    const slice = data.slice(-period);  
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;  
    for (let i = 0; i < period; i++) {  
      sumX += i;  
      sumY += slice[i];  
      sumXY += i * slice[i];  
      sumX2 += i * i;  
    }  
    const denom = (period * sumX2 - sumX * sumX);  
    if (denom === 0) return 0;  
    return (period * sumXY - sumX * sumY) / denom;  
  }  
  
  // ── Heikin-Ashi ──  
  static HeikinAshi(candles) {  
    if (candles.length < 2) return [];  
    const ha = [];  
    for (let i = 0; i < candles.length; i++) {  
      const c = candles[i];  
      if (i === 0) {  
        ha.push({  
          open: (c.open + c.close) / 2,  
          close: (c.open + c.high + c.low + c.close) / 4,  
          high: c.high,  
          low: c.low,  
        });  
      } else {  
        const haClose = (c.open + c.high + c.low + c.close) / 4;  
        const haOpen = (ha[i - 1].open + ha[i - 1].close) / 2;  
        ha.push({  
          open: haOpen,  
          close: haClose,  
          high: Math.max(c.high, haOpen, haClose),  
          low: Math.min(c.low, haOpen, haClose),  
        });  
      }  
    }  
    return ha;  
  }  
  
  // ── Williams %R ──  
  static WilliamsR(highs, lows, closes, period = 14) {  
    if (highs.length < period) return null;  
    const hh = Math.max(...highs.slice(-period));  
    const ll = Math.min(...lows.slice(-period));  
    const range = hh - ll;  
    if (range === 0) return -50;  
    return ((hh - closes[closes.length - 1]) / range) * -100;  
  }  
  
  // ── Commodity Channel Index (CCI) ──  
  static CCI(highs, lows, closes, period = 20) {  
    if (highs.length < period) return null;  
    const tps = [];  
    for (let i = 0; i < highs.length; i++) {  
      tps.push((highs[i] + lows[i] + closes[i]) / 3);  
    }  
    const sma = tps.slice(-period).reduce((s, v) => s + v, 0) / period;  
    const meanDev = tps.slice(-period).reduce((s, v) => s + Math.abs(v - sma), 0) / period;  
    if (meanDev === 0) return 0;  
    return (tps[tps.length - 1] - sma) / (0.015 * meanDev);  
  }  
  
  // ── Rate of Change (ROC) ──  
  static ROC(data, period = 10) {  
    if (data.length < period + 1) return null;  
    const prev = data[data.length - 1 - period];  
    if (prev === 0) return 0;  
    return ((data[data.length - 1] - prev) / prev) * 100;  
  }  
  
  // ── Pivot Points ──  
  static PivotPoints(high, low, close) {  
    const pivot = (high + low + close) / 3;  
    return {  
      pivot,  
      r1: 2 * pivot - low,  
      r2: pivot + (high - low),  
      r3: high + 2 * (pivot - low),  
      s1: 2 * pivot - high,  
      s2: pivot - (high - low),  
      s3: low - 2 * (high - pivot),  
    };  
  }  
  
  // ── Ichimoku Cloud (simplified) ──  
  static Ichimoku(highs, lows, closes, tenkanPeriod = 9, kijunPeriod = 26) {  
    if (highs.length < kijunPeriod) return null;  
    const tenkanHigh = Math.max(...highs.slice(-tenkanPeriod));  
    const tenkanLow = Math.min(...lows.slice(-tenkanPeriod));  
    const tenkan = (tenkanHigh + tenkanLow) / 2;  
  
    const kijunHigh = Math.max(...highs.slice(-kijunPeriod));  
    const kijunLow = Math.min(...lows.slice(-kijunPeriod));  
    const kijun = (kijunHigh + kijunLow) / 2;  
  
    const senkouA = (tenkan + kijun) / 2;  
    const senkouBHigh = Math.max(...highs.slice(-kijunPeriod * 2 > 0 ? -kijunPeriod * 2 : 0));  
    const senkouBLow = Math.min(...lows.slice(-kijunPeriod * 2 > 0 ? -kijunPeriod * 2 : 0));  
    const senkouB = (senkouBHigh + senkouBLow) / 2;  
  
    const currentPrice = closes[closes.length - 1];  
    const cloudTop = Math.max(senkouA, senkouB);  
    const cloudBottom = Math.min(senkouA, senkouB);  
  
    return {  
      tenkan,  
      kijun,  
      senkouA,  
      senkouB,  
      aboveCloud: currentPrice > cloudTop,  
      belowCloud: currentPrice < cloudBottom,  
      inCloud: currentPrice >= cloudBottom && currentPrice <= cloudTop,  
      bullishCloud: senkouA > senkouB,  
    };  
  }  
} 

// ============================================================================  
// SECTION 4: OHLC CANDLE BUILDER  
// Converts tick data into candles for pattern recognition  
// ============================================================================  
class CandleBuilder {  
  constructor(ticksPerCandle = 5) {  
    this.ticksPerCandle = ticksPerCandle;  
    this.candles = [];  
    this.currentCandle = null;  
    this.tickCount = 0;  
  }  
  
  addTick(price) {  
    this.tickCount++;  
    if (!this.currentCandle) {  
      this.currentCandle = { open: price, high: price, low: price, close: price, ticks: 1 };  
    } else {  
      this.currentCandle.high = Math.max(this.currentCandle.high, price);  
      this.currentCandle.low = Math.min(this.currentCandle.low, price);  
      this.currentCandle.close = price;  
      this.currentCandle.ticks++;  
    }  
  
    if (this.currentCandle.ticks >= this.ticksPerCandle) {  
      this.candles.push({ ...this.currentCandle });  
      this.currentCandle = null;  
  
      // Keep buffer manageable  
      if (this.candles.length > 200) {  
        this.candles = this.candles.slice(-150);  
      }  
      return true; // New candle formed  
    }  
    return false;  
  }  
  
  getCandles() { return this.candles; }  
  
  getOHLC() {  
    return {  
      opens: this.candles.map((c) => c.open),  
      highs: this.candles.map((c) => c.high),  
      lows: this.candles.map((c) => c.low),  
      closes: this.candles.map((c) => c.close),  
    };  
  }  
}  
  
// ============================================================================  
// SECTION 5: CANDLESTICK PATTERN DETECTOR  
// ============================================================================  
class CandlePatternDetector {  
  static analyze(candles) {  
    if (candles.length < 5) return { pattern: 'NONE', signal: 0, name: '' };  
  
    const results = [];  
  
    results.push(CandlePatternDetector.detectEngulfing(candles));  
    results.push(CandlePatternDetector.detectDoji(candles));  
    results.push(CandlePatternDetector.detectHammer(candles));  
    results.push(CandlePatternDetector.detectMorningStar(candles));  
    results.push(CandlePatternDetector.detectThreeSoldiers(candles));  
    results.push(CandlePatternDetector.detectPinBar(candles));  
  
    // Return the strongest signal  
    results.sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal));  
    return results[0].signal !== 0 ? results[0] : { pattern: 'NONE', signal: 0, name: '' };  
  }  
  
  static detectEngulfing(candles) {  
    const prev = candles[candles.length - 2];  
    const curr = candles[candles.length - 1];  
    const prevBody = Math.abs(prev.close - prev.open);  
    const currBody = Math.abs(curr.close - curr.open);  
  
    // Bullish Engulfing  
    if (prev.close < prev.open && curr.close > curr.open &&  
        curr.open <= prev.close && curr.close >= prev.open && currBody > prevBody * 1.2) {  
      return { pattern: 'BULLISH_ENGULFING', signal: 1, name: 'Bullish Engulfing' };  
    }  
    // Bearish Engulfing  
    if (prev.close > prev.open && curr.close < curr.open &&  
        curr.open >= prev.close && curr.close <= prev.open && currBody > prevBody * 1.2) {  
      return { pattern: 'BEARISH_ENGULFING', signal: -1, name: 'Bearish Engulfing' };  
    }  
    return { pattern: 'NONE', signal: 0, name: '' };  
  }  
  
  static detectDoji(candles) {  
    const curr = candles[candles.length - 1];  
    const body = Math.abs(curr.close - curr.open);  
    const range = curr.high - curr.low;  
    if (range === 0) return { pattern: 'NONE', signal: 0, name: '' };  
    if (body / range < 0.1) {  
      // Determine direction from context  
      const prev3 = candles.slice(-4, -1);  
      const trend = prev3[2].close - prev3[0].close;  
      if (trend > 0) return { pattern: 'DOJI_BEARISH', signal: -0.5, name: 'Doji (Bearish Reversal)' };  
      if (trend < 0) return { pattern: 'DOJI_BULLISH', signal: 0.5, name: 'Doji (Bullish Reversal)' };  
    }  
    return { pattern: 'NONE', signal: 0, name: '' };  
  }  
  
  static detectHammer(candles) {  
    const curr = candles[candles.length - 1];  
    const body = Math.abs(curr.close - curr.open);  
    const range = curr.high - curr.low;  
    if (range === 0 || body === 0) return { pattern: 'NONE', signal: 0, name: '' };  
  
    const lowerShadow = Math.min(curr.open, curr.close) - curr.low;  
    const upperShadow = curr.high - Math.max(curr.open, curr.close);  
  
    // Hammer (bullish)  
    if (lowerShadow > body * 2 && upperShadow < body * 0.5) {  
      return { pattern: 'HAMMER', signal: 0.8, name: 'Hammer' };  
    }  
    // Inverted Hammer / Shooting Star (bearish)  
    if (upperShadow > body * 2 && lowerShadow < body * 0.5) {  
      return { pattern: 'SHOOTING_STAR', signal: -0.8, name: 'Shooting Star' };  
    }  
    return { pattern: 'NONE', signal: 0, name: '' };  
  }  
  
  static detectMorningStar(candles) {  
    if (candles.length < 3) return { pattern: 'NONE', signal: 0, name: '' };  
    const [first, second, third] = candles.slice(-3);  
    const firstBody = Math.abs(first.close - first.open);  
    const secondBody = Math.abs(second.close - second.open);  
    const thirdBody = Math.abs(third.close - third.open);  
  
    // Morning Star (bullish)  
    if (first.close < first.open && firstBody > secondBody * 2 &&  
        third.close > third.open && thirdBody > secondBody * 2 &&  
        third.close > (first.open + first.close) / 2) {  
      return { pattern: 'MORNING_STAR', signal: 1, name: 'Morning Star' };  
    }  
    // Evening Star (bearish)  
    if (first.close > first.open && firstBody > secondBody * 2 &&  
        third.close < third.open && thirdBody > secondBody * 2 &&  
        third.close < (first.open + first.close) / 2) {  
      return { pattern: 'EVENING_STAR', signal: -1, name: 'Evening Star' };  
    }  
    return { pattern: 'NONE', signal: 0, name: '' };  
  }  
  
  static detectThreeSoldiers(candles) {  
    if (candles.length < 3) return { pattern: 'NONE', signal: 0, name: '' };  
    const last3 = candles.slice(-3);  
  
    const allBullish = last3.every((c) => c.close > c.open);  
    const allBearish = last3.every((c) => c.close < c.open);  
    const ascending = last3[0].close < last3[1].close && last3[1].close < last3[2].close;  
    const descending = last3[0].close > last3[1].close && last3[1].close > last3[2].close;  
  
    if (allBullish && ascending) {  
      return { pattern: 'THREE_WHITE_SOLDIERS', signal: 1, name: 'Three White Soldiers' };  
    }  
    if (allBearish && descending) {  
      return { pattern: 'THREE_BLACK_CROWS', signal: -1, name: 'Three Black Crows' };  
    }  
    return { pattern: 'NONE', signal: 0, name: '' };  
  }  
  
  static detectPinBar(candles) {  
    const curr = candles[candles.length - 1];  
    const body = Math.abs(curr.close - curr.open);  
    const range = curr.high - curr.low;  
    if (range === 0) return { pattern: 'NONE', signal: 0, name: '' };  
  
    const upperWick = curr.high - Math.max(curr.open, curr.close);  
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;  
  
    // Bullish pin bar  
    if (lowerWick > range * 0.6 && body < range * 0.25) {  
      return { pattern: 'BULLISH_PIN_BAR', signal: 0.9, name: 'Bullish Pin Bar' };  
    }  
    // Bearish pin bar  
    if (upperWick > range * 0.6 && body < range * 0.25) {  
      return { pattern: 'BEARISH_PIN_BAR', signal: -0.9, name: 'Bearish Pin Bar' };  
    }  
    return { pattern: 'NONE', signal: 0, name: '' };  
  }  
}  
  
// ============================================================================  
// SECTION 6: MARKET REGIME DETECTOR  
// Determines if market is Trending, Ranging, or Volatile  
// ============================================================================  
class MarketRegimeDetector {  
  static detect(prices, candles) {  
    if (prices.length < 100) {  
      return { regime: 'UNKNOWN', confidence: 0, details: {} };  
    }  
  
    const ohlc = {  
      highs: candles.map((c) => c.high),  
      lows: candles.map((c) => c.low),  
      closes: candles.map((c) => c.close),  
    };  
  
    // ADX for trend strength  
    const adx = candles.length >= 14  
      ? IndicatorLibrary.ADX(ohlc.highs, ohlc.lows, ohlc.closes, 14)  
      : null;  
  
    // Bollinger Bandwidth for volatility  
    const bb = IndicatorLibrary.BollingerBands(prices, 20, 2);  
  
    // Price efficiency ratio (directional movement vs total movement)  
    const lookback = Math.min(30, prices.length);  
    const netMovement = Math.abs(prices[prices.length - 1] - prices[prices.length - lookback]);  
    let totalMovement = 0;  
    for (let i = prices.length - lookback + 1; i < prices.length; i++) {  
      totalMovement += Math.abs(prices[i] - prices[i - 1]);  
    }  
    const efficiency = totalMovement === 0 ? 0 : netMovement / totalMovement;  
  
    // Linear regression slope  
    const slope = IndicatorLibrary.LinearRegressionSlope(prices, 15);  
    const slopeNormalized = slope !== null ? Math.abs(slope) / (IndicatorLibrary.SMA(prices, 15) || 1) * 1000 : 0;  
  
    // Determine regime  
    let regime = 'RANGING';  
    let confidence = 0;  
  
    if (adx && adx.adx > 25 && efficiency > 0.35 && slopeNormalized > 0.3) {  
      regime = 'STRONG_TREND';  
      confidence = Math.min(100, adx.adx * 1.5 + efficiency * 100);  
    } else if ((adx && adx.adx > 18) || efficiency > 0.25) {  
      regime = 'WEAK_TREND';  
      confidence = Math.min(100, (adx ? adx.adx : 18) + efficiency * 100);  
    } else if (bb && bb.bandwidth < 0.01) {  
      regime = 'SQUEEZE';  
      confidence = Math.min(100, (1 - bb.bandwidth / 0.01) * 100);  
    } else if (bb && bb.bandwidth > 0.04) {  
      regime = 'HIGH_VOLATILITY';  
      confidence = Math.min(100, bb.bandwidth / 0.04 * 50);  
    } else {  
      regime = 'RANGING';  
      confidence = Math.min(100, (1 - efficiency) * 100);  
    }  
  
    // Trend direction  
    const trendDirection = slope > 0 ? 'UP' : slope < 0 ? 'DOWN' : 'FLAT';  
  
    return {  
      regime,  
      confidence,  
      trendDirection,  
      details: {  
        adx: adx ? adx.adx.toFixed(1) : 'N/A',  
        efficiency: efficiency.toFixed(3),  
        bandwidth: bb ? bb.bandwidth.toFixed(4) : 'N/A',  
        slope: slope ? slope.toFixed(6) : 'N/A',  
      },  
    };  
  }  
}  

// ============================================================================  
// SECTION 7: UPGRADED STRATEGY ENGINE (TICK-SPECIFIC)
// Optimized for 5-tick micro-structure, removing lagging macro indicators
// ============================================================================  
class StrategyEngine {  
  constructor(config) {  
    this.config = config;  
    this.strategyPerformance = {};  
  }  

  // ── STRATEGY 1: Tick Velocity & Acceleration (Momentum) ──  
  // Measures the speed and acceleration of the last 5 ticks.
  tickVelocityStrategy(prices) {  
    const name = 'Tick Velocity';  
    if (prices.length < 10) return { signal: 0, confidence: 0, name };  

    const last5 = prices.slice(-5);  
    const prev5 = prices.slice(-10, -5);  

    const velCurrent = (last5[4] - last5[0]) / 5;  
    const velPrev = (prev5[4] - prev5[0]) / 5;  
    const acceleration = velCurrent - velPrev;  

    let signal = 0, confidence = 0;  

    // Strong upward momentum accelerating
    if (velCurrent > 0 && acceleration > 0 && last5[4] > last5[0]) {  
      signal = 1;  
      confidence = Math.min(85, 50 + (acceleration * 100000)); // Scale to price magnitude
    } 
    // Strong downward momentum accelerating
    else if (velCurrent < 0 && acceleration < 0 && last5[4] < last5[0]) {  
      signal = -1;  
      confidence = Math.min(85, 50 + (Math.abs(acceleration) * 100000));  
    }  

    return { signal, confidence, name, reasons: [`Vel: ${velCurrent.toFixed(5)}, Acc: ${acceleration.toFixed(5)}`] };  
  }  

  // ── STRATEGY 2: Micro-Pullback (Mean Reversion) ──  
  // If 4 out of last 5 ticks were strictly one direction, a 1-tick pullback is highly probable.
  microPullbackStrategy(prices) {  
    const name = 'Micro Pullback';  
    if (prices.length < 6) return { signal: 0, confidence: 0, name };  

    const last5 = prices.slice(-5);  
    let ups = 0, downs = 0;  
    for (let i = 1; i < 5; i++) {  
      if (last5[i] > last5[i-1]) ups++;  
      else if (last5[i] < last5[i-1]) downs++;  
    }  

    let signal = 0, confidence = 0;  

    // Extreme upward extension -> expect a micro pullback (Fall)
    if (ups >= 4 && last5[4] > last5[0]) {  
      signal = -1;  
      confidence = 65 + (ups * 5);  
    } 
    // Extreme downward extension -> expect a micro pullback (Rise)
    else if (downs >= 4 && last5[4] < last5[0]) {  
      signal = 1;  
      confidence = 65 + (downs * 5);  
    }  

    return { signal, confidence, name, reasons: [`Ups: ${ups}, Downs: ${downs}`] };  
  }  

  // ── STRATEGY 3: Tick Consolidation Breakout ──  
  // Measures tick range. If range compresses, trade the immediate breakout direction.
  consolidationBreakout(prices) {  
    const name = 'Consolidation Breakout';  
    if (prices.length < 15) return { signal: 0, confidence: 0, name };  

    const recent5 = prices.slice(-5);  
    const prev10 = prices.slice(-15, -5);  

    const rangeRecent = Math.max(...recent5) - Math.min(...recent5);  
    const rangePrev = Math.max(...prev10) - Math.min(...prev10);  

    let signal = 0, confidence = 0;  

    // If recent range is significantly smaller than previous range (consolidation)
    if (rangeRecent < rangePrev * 0.4) {  
      const breakoutDir = recent5[4] - recent5[0];  
      if (breakoutDir > 0) {  
        signal = 1;  
        confidence = 70;  
      } else if (breakoutDir < 0) {  
        signal = -1;  
        confidence = 70;  
      }  
    }  

    return { signal, confidence, name, reasons: [`PrevRange: ${rangePrev.toFixed(5)}, RecRange: ${rangeRecent.toFixed(5)}`] };  
  }  

  recordResult(strategyName, wasCorrect) {  
    if (!this.strategyPerformance[strategyName]) {  
      this.strategyPerformance[strategyName] = { wins: 0, total: 0 };  
    }  
    this.strategyPerformance[strategyName].total++;  
    if (wasCorrect) this.strategyPerformance[strategyName].wins++;  
  }  
  
  getStrategyWeight(strategyName) {  
    const perf = this.strategyPerformance[strategyName];  
    if (!perf || perf.total < 10) return 1.0;  
    const winRate = perf.wins / perf.total;  
    // Strict weighting: penalize strategies below 53% win rate (the breakeven threshold)
    if (winRate < 0.53) return 0.2; 
    return Math.max(0.5, Math.min(2.0, (winRate - 0.50) * 5));  
  }  
}  

// ============================================================================  
// SECTION 8: UPGRADED PREDICTION ENGINE (Streamlined for Low Latency)
// ============================================================================  
class PredictionEngine {  
  constructor(config, logger) {  
    this.config = config;  
    this.logger = logger;  
    this.strategy = new StrategyEngine(config.analysis);  
    this.weightsFilePath = path.join(__dirname, 'strategy_weights_v4.json');  
    this.loadWeights();  
  }  
  
  loadWeights() {  
    try {  
      if (fs.existsSync(this.weightsFilePath)) {  
        this.strategy.strategyPerformance = JSON.parse(fs.readFileSync(this.weightsFilePath, 'utf8'));  
      }  
    } catch (e) { /* ignore */ }  
  }  
  
  saveWeights() {  
    try {  
      fs.writeFileSync(this.weightsFilePath, JSON.stringify(this.strategy.strategyPerformance, null, 2), 'utf8');  
    } catch (e) { /* ignore */ }  
  }  
  
  predict(prices) {  
    if (prices.length < 20) return { signal: 'WAIT', confidence: 0, reason: 'Warming up' };  

    // Run only the 3 tick-optimized strategies
    const results = [  
      this.strategy.tickVelocityStrategy(prices),  
      this.strategy.microPullbackStrategy(prices),  
      this.strategy.consolidationBreakout(prices)  
    ];  

    let bullScore = 0, bearScore = 0;  
    let activeStrategies = [];  

    for (const r of results) {  
      if (r.signal === 0) continue;  
      const weight = this.strategy.getStrategyWeight(r.name);  
      const adjConf = r.confidence * weight;  

      if (r.signal > 0) bullScore += adjConf;  
      else bearScore += adjConf;  

      activeStrategies.push({ name: r.name, signal: r.signal > 0 ? 'CALLE' : 'PUTE', confidence: adjConf });  
    }  

    const total = bullScore + bearScore;  
    if (total === 0) return { signal: 'WAIT', confidence: 0, reason: 'No signals' };  

    let direction = null, finalConfidence = 0;  
    const bullPct = (bullScore / total) * 100;  
    const bearPct = (bearScore / total) * 100;  

    // Require 65% consensus among the tick strategies
    if (bullPct >= 65 && bullScore > bearScore) {  
      direction = 'CALLE';  
      finalConfidence = bullPct;  
    } else if (bearPct >= 65 && bearScore > bullScore) {  
      direction = 'PUTE';  
      finalConfidence = bearPct;  
    }  

    if (!direction || finalConfidence < this.config.analysis.minConfidence) {  
      return { signal: 'WAIT', confidence: 0, reason: 'Below confidence threshold' };  
    }  

    return {  
      signal: direction,  
      direction,  
      confidence: parseFloat(finalConfidence.toFixed(1)),  
      reason: activeStrategies.map(s => `${s.name}(${s.signal})`).join(' + '),  
      strategies: activeStrategies  
    };  
  }  
  
  recordTradeResult(prediction, won) {  
    for (const strat of prediction.strategies || []) {  
      this.strategy.recordResult(strat.name, won);  
    }  
    this.saveWeights();  
  }  
}  

// ============================================================================  
// SECTION 9: UPGRADED RISK MANAGEMENT (No Martingale, Payout Checked)
// ============================================================================  
class RiskManager {  
  constructor(config, logger) {  
    this.config = config;  
    this.logger = logger;  
    this.peakBalance = 0;  
  }  
  
  initialize(balance) { this.peakBalance = balance; }  
  updateBalance(balance) { if (balance > this.peakBalance) this.peakBalance = balance; }  
  
  getOptimalStake(tradeStats, currentBalance) {  
    const baseStake = this.config.trading.initialStake;  
    
    // ANTI-MARTINGALE (Paroli): Increase stake on wins, reset on loss.
    // This protects the bankroll during losing streaks.
    if (tradeStats.consecutiveWins > 0 && tradeStats.consecutiveWins <= 3) {  
      const boost = 1 + (tradeStats.consecutiveWins * 0.5); // 50% increase per win
      return parseFloat((baseStake * boost).toFixed(2));  
    }  
    
    // Reset to base on loss or after 3 wins
    return baseStake;  
  }  
  
  checkDrawdown(currentBalance) {  
    const drawdownPercent = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;  
    return {  
      drawdownPercent: drawdownPercent.toFixed(2),  
      breached: drawdownPercent >= this.config.risk.drawdownLimit,  
    };  
  }  
}  

// ============================================================================  
// SECTION 12: DERIV REST CLIENT (PAT / OAuth OTP auth flow — same as reference)
// ============================================================================  
class RestClient {
  constructor(baseUrl, appId, token) {
    this.baseUrl = baseUrl || 'https://api.derivws.com';
    this.appId = appId || '1089';
    this.token = token || '';
  }

  static isPat(token) {
    return typeof token === 'string'
      && /^pat_[a-z0-9_\-]{16,}$/i.test(token.trim());
  }

  _request(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(urlPath, this.baseUrl); }
      catch (e) { return reject(new Error(`Invalid URL: ${urlPath}`)); }

      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const opts = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Deriv-App-ID': this.appId,
          'Authorization': 'Bearer ' + this.token,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 15000,
      };

      const req = lib.request(opts, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch (_) { }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('timeout', () => { req.destroy(new Error('REST request timeout')); });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  get(p) { return this._request('GET', p); }
  post(p, b) { return this._request('POST', p, b); }
  delete(p) { return this._request('DELETE', p); }
}

// ============================================================================  
// SECTION 12b: UPGRADED DERIV API CLIENT (PAT / OTP flow + Payout Validation)
// ============================================================================  
class DerivAPIClient extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.isConnected = false;
    this.isAuthorized = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.system.maxReconnectAttempts;
    this.reconnectDelay = config.system.reconnectDelay;
    this.isReconnecting = false;
    this.isShuttingDown = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.balance = 0;
    this.currency = 'USD';
    this.accountId = '';
    this.accountInfo = null;
    this._connectResolve = null;
    this._connectReject = null;

    this._isPat = RestClient.isPat(config.deriv.apiToken);
    this._rest = this._isPat
      ? new RestClient('https://api.derivws.com', config.deriv.appId, config.deriv.apiToken)
      : null;
    this._otpUrl = null;
    this._targetAccount = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) { this.logger.info('Already connected'); resolve(); return; }
      if (!this.config.deriv.apiToken) { this.logger.error('API_TOKEN is empty — aborting'); reject(new Error('API_TOKEN is empty')); return; }
      this.logger.info('Connecting to Deriv API...');
      this.cleanup();
      this.isShuttingDown = false;
      this._connectResolve = resolve;
      this._connectReject = reject;

      if (this._isPat) {
        this.logger.info('PAT token detected -> using NEW Deriv API (OTP flow)');
        this._newApiConnect().catch(err => {
          this.logger.error(`New API connect failed: ${err.message}`);
          if (this._connectReject) { this._connectReject(err); this._connectResolve = null; this._connectReject = null; }
          this.onClose();
        });
      } else {
        this.logger.info('Using legacy Deriv API (token authorize flow)');
        this._openWs(`${this.config.deriv.endpoint}`);
      }
    });
  }

  _openWs(url) {
    try {
      this.ws = new WebSocket(url, {
        headers: { 'User-Agent': 'Bot/1.0 (+Node.js)' },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      this.logger.error(`WS construct failed: ${e.message}`);
      this.onClose();
      return;
    }

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', data => this._onMessage(data));
    this.ws.on('error', err => this._onError(err));
    this.ws.on('close', () => this.onClose());
    this.ws.on('unexpected-response', (_req, res) => {
      this.logger.error(`WS handshake failed: ${res.statusCode} ${res.statusMessage}`);
      try { res.destroy(); } catch (_) { }
      this.onClose();
    });
  }

  async _newApiConnect() {
    this.logger.info('REST: GET /trading/v1/options/accounts');
    const accRes = await this._rest.get('/trading/v1/options/accounts');

    if (accRes.status !== 200) {
      const msg = accRes.body?.errors?.[0]?.message || accRes.body?.message || JSON.stringify(accRes.body);
      let hint = '';
      if (accRes.status === 401) hint = ' — check PAT validity and APP_ID registration';
      else if (accRes.status === 403) hint = ' — PAT may lack "trade" scope';
      throw new Error(`Account list failed (${accRes.status}): ${msg}${hint}`);
    }

    const accounts = Array.isArray(accRes.body?.data) ? accRes.body.data : [];
    if (!accounts.length) throw new Error('No Options accounts found for this token');

    const desiredType = (this.config.deriv.accountType || 'demo').toLowerCase();
    const acct = accounts.find(a => (a.account_type || '').toLowerCase() === desiredType) || accounts[0];

    this._targetAccount = acct;
    this.accountInfo = {
      loginid: acct.account_id, email: acct.email,
      isVirtual: (acct.account_type || '').toLowerCase() === 'demo',
      accountType: acct.account_type, currency: acct.currency,
      balance: parseFloat(acct.balance), group: acct.group,
    };

    this.logger.info(`Selected account ${acct.account_id} (${acct.account_type}, ${acct.currency}, balance=${acct.balance})`);

    const otpPath = `/trading/v1/options/accounts/${encodeURIComponent(acct.account_id)}/otp`;
    const otpRes = await this._rest.post(otpPath);

    if (otpRes.status !== 200) {
      const msg = otpRes.body?.errors?.[0]?.message || JSON.stringify(otpRes.body);
      throw new Error(`OTP request failed (${otpRes.status}): ${msg}`);
    }

    const wsUrl = otpRes.body?.data?.url;
    if (!wsUrl || !/^wss?:/i.test(wsUrl)) {
      throw new Error(`OTP response missing .data.url: ${JSON.stringify(otpRes.body)}`);
    }

    this._otpUrl = wsUrl;
    this._openWs(wsUrl);
  }

  _markAuthorized() {
    if (!this.accountInfo) return;

    this.logger.info(
      `Authorized ${this.accountInfo.loginid}` +
      `(${this.accountInfo.isVirtual ? 'DEMO' : 'REAL'})` +
      `balance=${this.accountInfo.balance} ${this.accountInfo.currency} via PAT/new-API`
    );

    this.isAuthorized = true;
    this.balance = this.accountInfo.balance;
    this.currency = this.accountInfo.currency;
    this.accountId = this.accountInfo.loginid;
    this.sendRequest({ balance: 1, subscribe: 1 }).catch(() => {});
  }

  onOpen() {
    this.logger.info('WebSocket connected');
    this.isConnected = true;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this._startHeartbeat();

    if (this._connectResolve) { this._connectResolve(); this._connectResolve = null; this._connectReject = null; }

    if (this._isPat) {
      this._markAuthorized();
    }
  }

  _onMessage(data) {
    let response;
    try { response = JSON.parse(data); }
    catch (e) { this.logger.error(`Parse error: ${e.message}`); return; }
    this._handleMessage(response);
  }

  _handleMessage(response) {
    const reqId = response.req_id;
    if (reqId && this.pendingRequests.has(reqId)) {
      const { resolve, reject } = this.pendingRequests.get(reqId);
      this.pendingRequests.delete(reqId);
      if (response.error) { reject(new Error(response.error.message)); return; }
      else resolve(response);
    }

    if (response.msg_type === 'tick' && response.tick && typeof response.tick.quote !== 'undefined') {
      this.emit('tick', response.tick); return;
    }
    if (response.msg_type === 'proposal_open_contract') {
      this.emit('contract_update', response.proposal_open_contract); return;
    }
    if (response.msg_type === 'transaction') { this.emit('transaction', response.transaction); return; }
    if (response.msg_type === 'balance' && response.balance) {
      this.balance = response.balance.balance;
      this.currency = response.balance.currency;
      this.emit('balance_update', response.balance);
    }
    if (response.msg_type === 'authorize' && !this._isPat) {
      if (response.error) { this.logger.error(`Auth failed: ${response.error.message}`); return; }
      this.isAuthorized = true;
      this.balance = response.authorize.balance;
      this.currency = response.authorize.currency;
      this.accountId = response.authorize.loginid;
    }

    if (response.error && !response.req_id) {
      this.logger.error(`API Error: ${response.error.message}`);
      this.emit('api_error', response.error);
    }
  }

  sendRequest(request, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) { reject(new Error('Not connected')); return; }
      const reqId = ++this.requestId;
      request.req_id = reqId;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Timeout: ${JSON.stringify(request).slice(0, 50)}`));
      }, timeout);
      this.pendingRequests.set(reqId, {
        resolve: (d) => { clearTimeout(timer); resolve(d); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(request));
    });
  }

  async authorize() {
    if (this._isPat) {
      if (!this.accountInfo) throw new Error('PAT flow did not provide account info');
      this.isAuthorized = true;
      this.balance = this.accountInfo.balance;
      this.currency = this.accountInfo.currency;
      this.accountId = this.accountInfo.loginid;
      return this.accountInfo;
    }
    const response = await this.sendRequest({ authorize: this.config.deriv.apiToken });
    this.isAuthorized = true;
    this.balance = response.authorize.balance;
    this.currency = response.authorize.currency;
    this.accountId = response.authorize.loginid;
    this.sendRequest({ balance: 1, subscribe: 1 }).catch(() => {});
    return response.authorize;
  }

  async subscribeTicks(symbol) {
    return this.sendRequest({ ticks: symbol, subscribe: 1 });
  }

  async getTickHistory(symbol, count = 1000) {
    const response = await this.sendRequest({ ticks_history: symbol, count, end: 'latest', style: 'ticks' });
    return response.history;
  }

  // UPGRADED: Checks payout ratio BEFORE buying. Rejects bad odds.
  async buyContract(params) {
    const symbolKey = this._isPat ? 'underlying_symbol' : 'symbol';

    // 1. Request Proposal to check exact payout
    const proposalRes = await this.sendRequest({
      proposal: 1,
      amount: params.amount,
      basis: 'stake',
      contract_type: params.contractType,
      currency: this.currency,
      duration: params.duration,
      duration_unit: params.durationUnit,
      [symbolKey]: params.symbol
    });
    const payout = parseFloat(proposalRes.proposal.payout);
    const askPrice = parseFloat(proposalRes.proposal.ask_price);

    // 2. Calculate Required Win Rate
    const requiredWinRate = askPrice / payout;

    // 3. Reject if payout is too low (e.g., requires > 53% win rate to break even)
    const MAX_ACCEPTABLE_WIN_RATE = 0.535;
    if (requiredWinRate > MAX_ACCEPTABLE_WIN_RATE) {
      this.logger.warn(`⛔ Payout rejected! Required WR: ${(requiredWinRate*100).toFixed(1)}% > Max ${(MAX_ACCEPTABLE_WIN_RATE*100).toFixed(1)}%`);
      return null; // Signal to main bot to skip this trade
    }

    // 4. Execute Buy (clean parameters — no proposal field)
    const response = await this.sendRequest({
      buy: 1,
      subscribe: 1,
      price: Number(params.amount).toFixed(2),
      parameters: {
        contract_type: params.contractType,
        [symbolKey]: params.symbol,
        currency: this.currency,
        amount: Number(params.amount).toFixed(2),
        duration: params.duration,
        duration_unit: params.durationUnit,
        basis: 'stake'
      }
    });

    return response.buy;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected) this.ws.send(JSON.stringify({ ping: 1 }));
    }, this.config.system.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  _onError(err) { this.logger.error(`WebSocket error: ${err.message}`); }

  onClose() {
    this.logger.warn('Disconnected from Deriv API');
    this.isConnected = false;
    this.isAuthorized = false;
    this._stopHeartbeat();
    this.emit('disconnected');

    if (this.isShuttingDown) return;
    if (this.isReconnecting) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.isReconnecting = true;
      this.reconnectAttempts++;
      const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
      this.logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isShuttingDown) return;
        this.isReconnecting = false;
        this.connect().then(async () => {
          try {
            await this.authorize();
            this.emit('reconnected');
          } catch (e) {
            this.logger.error(`Reconnect auth failed: ${e.message}`);
            this.onClose();
          }
        }).catch(err => {
          this.logger.error(`Reconnect failed: ${err.message}`);
          this.onClose();
        });
      }, delay);
    } else {
      this.logger.error('Max reconnection attempts reached — giving up');
      this.emit('max_reconnect');
    }
  }

  disconnect() {
    this.isShuttingDown = true;
    this.isReconnecting = false;
    this._stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { if (this.ws.readyState <= 1) this.ws.close(); } catch { }
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthorized = false;
  }

  cleanup() {
    this._stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      try { if (this.ws.readyState <= 1) this.ws.close(); } catch { }
      this.ws = null;
    }
  }
}

// ============================================================================  
// SECTION 13: UPGRADED MAIN BOT (Latency Optimized)
// ============================================================================  
class DerivTradingBot {  
  constructor() {  
    // ... [Keep v3.1 initialization] ...
    this.configManager = new ConfigManager();  
    this.config = this.configManager.config;  
    this.logger = new Logger();  
    this.api = new DerivAPIClient(this.config, this.logger);  
    this.prediction = new PredictionEngine(this.config, this.logger);  
    this.riskManager = new RiskManager(this.config, this.logger);  
    
    this.tickPrices = [];  
    this.isRunning = false;  
    this.tradeHistory = [];
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.dailyPnL = 0;
    this.isTradingPaused = false;
  }  
  
  async start() {  
    // ... [Keep v3.1 connection and tick history loading] ...
    await this.api.connect();  
    await this.api.authorize();  
    this.riskManager.initialize(this.api.balance);  
    
    const history = await this.api.getTickHistory(this.config.trading.symbol, 100);  
    if (history?.prices) this.tickPrices = history.prices.map(Number);  
    
    await this.api.subscribeTicks(this.config.trading.symbol);  
    this.isRunning = true;  
    this.logger.info('🚀 Bot v4.0 running — Micro-structure mode active.\n');  
  }  
  
  async handleTick(tick) {  
    if (!this.isRunning || this.isTradingPaused) return;  
  
    const price = parseFloat(tick.quote);  
    this.tickPrices.push(price);  
    if (this.tickPrices.length > 200) this.tickPrices.shift(); // Keep buffer small for speed
  
    // Run prediction (Highly optimized)
    const result = this.prediction.predict(this.tickPrices);  
    if (result.signal === 'WAIT') return;  
  
    // Check daily limits
    if (this.dailyPnL <= -this.config.trading.maxDailyLoss) {
        this.isTradingPaused = true;
        this.logger.warn('Daily loss limit reached. Pausing.');
        return;
    }
  
    await this.executeTrade(result, price);  
  }  
  
  async executeTrade(prediction, currentPrice) {  
    const stats = { consecutiveWins: this.consecutiveWins, consecutiveLosses: this.consecutiveLosses };
    const stake = this.riskManager.getOptimalStake(stats, this.api.balance);  
  
    if (stake > this.api.balance) return;  
  
    this.logger.info(`🎯 SIGNAL: ${prediction.direction} | Conf: ${prediction.confidence}% | Stake: $${stake}`);  
  
    try {  
      // buyContract now internally checks the payout ratio!
      const result = await this.api.buyContract({  
        contractType: prediction.direction,  
        symbol: this.config.trading.symbol,  
        duration: this.config.trading.contractDuration,  
        durationUnit: this.config.trading.contractDurationUnit,  
        amount: stake,  
      });  
  
      if (!result) {
          this.logger.warn('Trade skipped due to poor payout ratio.');
          return;
      }
  
      this.logger.info(`✅ Contract ${result.contract_id} opened.`);  
  
      // Listen for contract close
      const closeHandler = (contract) => {  
        if (contract.contract_id === result.contract_id && contract.is_sold) {  
          this.api.removeListener('contract_update', closeHandler);  
          this._handleTradeClose(contract, prediction);  
        }  
      };  
      this.api.on('contract_update', closeHandler);  
  
    } catch (error) {  
      this.logger.error(`Trade failed: ${error.message}`);  
    }  
  }  
  
  _handleTradeClose(contract, prediction) {  
    const profit = parseFloat(contract.profit);  
    const won = profit > 0;  
  
    if (won) {  
      this.consecutiveWins++;  
      this.consecutiveLosses = 0;  
    } else {  
      this.consecutiveLosses++;  
      this.consecutiveWins = 0;  
    }  
    
    this.dailyPnL += profit;
    this.riskManager.updateBalance(this.api.balance);
    this.prediction.recordTradeResult(prediction, won);
  
    this.logger.info(`${won ? '✅ WIN' : '❌ LOSS'} | P&L: $${profit.toFixed(2)} | Daily: $${this.dailyPnL.toFixed(2)}`);  
  }  
}  
  
// ============================================================================  
// ENTRY POINT  
// ============================================================================  
if (require.main === module) {  
  (async () => {  
    const bot = new DerivTradingBot();  
    await bot.start();  
  })();  
}  