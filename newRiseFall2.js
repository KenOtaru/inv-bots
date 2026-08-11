// ============================================================================  
// DERIV RISE/FALL TRADING BOT v3.1 — HIGH-PROFITABILITY EDITION  
// Research-Backed Multi-Strategy Analysis, Persistence, & Prediction Engine  
// ============================================================================  
//  
// UPGRADES IMPLEMENTED in v3.1:  
// ──────────────────────────────────────────────────────────────  
// 1. Timeframe Alignment: Lookbacks and candles tuned for fast 5-tick trades.  
// 2. Persistent Learning weights (weights saved to/loaded from strategy_weights.json).  
// 3. Strict Consensus Filter: Hard requirement of minimum agreeing strategies.  
// 4. Daily Profit Target Unpause: Bot unpauses next day after Take Profit (fixes TP lock-out).  
// 5. Dynamic Martingale Max Stake expansion to allow actual recovery.  
// 6. Complete cleanup of all syntax and formatting errors.  
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
        symbol: 'stpRNG',  
        initialStake: 0.35,  
        contractDuration: 3,  
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
        minAgreeing: 1,  
        // Number of ticks to collect before trading  
        warmupTicks: 80,  
        // OHLC candle size in ticks (5 ticks is optimal for 5-tick duration)  
        candleSize: 5,  
        // Enable/disable individual strategies  
        enableMeanReversion: false,  
        enableTrendFollowing: false,  
        enableMomentum: true,  
        enableStatistical: false,  
        enableCandlePatterns: true,  
        enableHeikinAshi: false,  
        enableStochRSI: false,  
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
// SECTION 7: STRATEGY ENGINE  
// Each strategy returns: { signal: number (-1 to +1), confidence: number, name: string }  
// ============================================================================  
class StrategyEngine {  
  constructor(config) {  
    this.config = config;  
    this.strategyPerformance = {};  
  }  
  
  // ── STRATEGY 1: Mean Reversion ──  
  // Uses Bollinger Band extremes + RSI confirmation (short-term tuned)  
  meanReversionStrategy(prices, candles) {  
    const name = 'Mean Reversion';  
    if (prices.length < 25) return { signal: 0, confidence: 0, name };  
  
    const bb = IndicatorLibrary.BollingerBands(prices, 20, 2);  
    const rsi = IndicatorLibrary.RSI(prices, 8); // faster RSI for ticks  
    const zScore = IndicatorLibrary.ZScore(prices, 20);  
  
    if (!bb || rsi === null || zScore === null) return { signal: 0, confidence: 0, name };  
  
    let signal = 0;  
    let confidence = 0;  
    const reasons = [];  
  
    // Price below lower band + RSI oversold = Buy  
    if (bb.percentB < 0.08 && rsi < 32 && zScore < -1.7) {  
      signal = 1;  
      confidence = Math.min(95, (32 - rsi) * 1.8 + Math.abs(zScore) * 18);  
      reasons.push(`BB%B=${bb.percentB.toFixed(2)}, RSI=${rsi.toFixed(1)}, Z=${zScore.toFixed(2)}`);  
    }  
    // Price above upper band + RSI overbought = Sell  
    else if (bb.percentB > 0.92 && rsi > 68 && zScore > 1.7) {  
      signal = -1;  
      confidence = Math.min(95, (rsi - 68) * 1.8 + Math.abs(zScore) * 18);  
      reasons.push(`BB%B=${bb.percentB.toFixed(2)}, RSI=${rsi.toFixed(1)}, Z=${zScore.toFixed(2)}`);  
    }  
    // Moderate signals  
    else if (bb.percentB < 0.18 && rsi < 38) {  
      signal = 0.6;  
      confidence = Math.min(70, (38 - rsi) + (0.18 - bb.percentB) * 200);  
      reasons.push(`Moderate oversold`);  
    }  
    else if (bb.percentB > 0.82 && rsi > 62) {  
      signal = -0.6;  
      confidence = Math.min(70, (rsi - 62) + (bb.percentB - 0.82) * 200);  
      reasons.push(`Moderate overbought`);  
    }  
  
    return { signal, confidence, name, reasons };  
  }  
  
  // ── STRATEGY 2: Trend Following ──  
  // Triple EMA crossover + ADX confirmation (shorter lookbacks for speed)  
  trendFollowingStrategy(prices, candles) {  
    const name = 'Trend Following';  
    if (prices.length < 35) return { signal: 0, confidence: 0, name };  
  
    const emaFast = IndicatorLibrary.EMA(prices, 5);  
    const emaMid = IndicatorLibrary.EMA(prices, 12);  
    const emaSlow = IndicatorLibrary.EMA(prices, 26);  
  
    if (emaFast === null || emaMid === null || emaSlow === null) {  
      return { signal: 0, confidence: 0, name };  
    }  
  
    const ohlc = candles.length >= 14 ? {  
      highs: candles.map((c) => c.high),  
      lows: candles.map((c) => c.low),  
      closes: candles.map((c) => c.close),  
    } : null;  
  
    const adx = ohlc ? IndicatorLibrary.ADX(ohlc.highs, ohlc.lows, ohlc.closes, 14) : null;  
    const slope = IndicatorLibrary.LinearRegressionSlope(prices, 15);  
  
    let signal = 0;  
    let confidence = 0;  
    const reasons = [];  
  
    const bullishAlignment = emaFast > emaMid && emaMid > emaSlow;  
    const bearishAlignment = emaFast < emaMid && emaMid < emaSlow;  
    const isTrending = adx ? adx.adx > 18 : true;  
  
    if (bullishAlignment && isTrending && slope > 0) {  
      signal = 1;  
      const emaSpread = ((emaFast - emaSlow) / emaSlow) * 10000;  
      confidence = Math.min(90, 40 + emaSpread + (adx ? adx.adx : 0));  
      reasons.push(`EMA aligned bullish, ADX=${adx ? adx.adx.toFixed(1) : 'N/A'}`);  
    }  
    else if (bearishAlignment && isTrending && slope < 0) {  
      signal = -1;  
      const emaSpread = ((emaSlow - emaFast) / emaSlow) * 10000;  
      confidence = Math.min(90, 40 + emaSpread + (adx ? adx.adx : 0));  
      reasons.push(`EMA aligned bearish, ADX=${adx ? adx.adx.toFixed(1) : 'N/A'}`);  
    }  
    // Partial signals  
    else if (emaFast > emaMid && slope > 0) {  
      signal = 0.5;  
      confidence = 40;  
      reasons.push('Partial bullish EMA');  
    }  
    else if (emaFast < emaMid && slope < 0) {  
      signal = -0.5;  
      confidence = 40;  
      reasons.push('Partial bearish EMA');  
    }  
  
    return { signal, confidence, name, reasons };  
  }  
  
  // ── STRATEGY 3: Momentum Breakout ──  
  // Donchian Channel breakout + Volume proxy  
  momentumBreakoutStrategy(prices, candles) {  
    const name = 'Momentum Breakout';  
    if (candles.length < 15) return { signal: 0, confidence: 0, name };  
  
    const ohlc = {  
      highs: candles.map((c) => c.high),  
      lows: candles.map((c) => c.low),  
      closes: candles.map((c) => c.close),  
    };  
  
    const donchian = IndicatorLibrary.DonchianChannel(ohlc.highs, ohlc.lows, 12);  
    const roc = IndicatorLibrary.ROC(prices, 5);  
    const bb = IndicatorLibrary.BollingerBands(prices, 15, 2);  
  
    if (!donchian || roc === null) return { signal: 0, confidence: 0, name };  
  
    const currentPrice = prices[prices.length - 1];  
  
    // Volume proxy: measure tick volatility increase  
    const recentVolatility = this._tickVolatility(prices, 5);  
    const baselineVolatility = this._tickVolatility(prices, 20);  
    const volRatio = baselineVolatility > 0 ? recentVolatility / baselineVolatility : 1;  
  
    let signal = 0;  
    let confidence = 0;  
    const reasons = [];  
  
    // Breakout above Donchian upper  
    if (currentPrice >= donchian.upper && roc > 0 && volRatio > 1.2) {  
      signal = 1;  
      confidence = Math.min(85, 50 + volRatio * 15 + Math.abs(roc));  
      reasons.push(`Donchian breakout UP, ROC=${roc.toFixed(2)}, VolRatio=${volRatio.toFixed(2)}`);  
    }  
    // Breakout below Donchian lower  
    else if (currentPrice <= donchian.lower && roc < 0 && volRatio > 1.2) {  
      signal = -1;  
      confidence = Math.min(85, 50 + volRatio * 15 + Math.abs(roc));  
      reasons.push(`Donchian breakout DOWN, ROC=${roc.toFixed(2)}, VolRatio=${volRatio.toFixed(2)}`);  
    }  
  
    return { signal, confidence, name, reasons };  
  }  
  
  // ── STRATEGY 4: Statistical Edge ──  
  // Z-Score mean reversion + autocorrelation  
  statisticalStrategy(prices) {  
    const name = 'Statistical Edge';  
    if (prices.length < 35) return { signal: 0, confidence: 0, name };  
  
    const zScore = IndicatorLibrary.ZScore(prices, 20);  
    const zScore10 = IndicatorLibrary.ZScore(prices, 8);  
  
    // Autocorrelation (lag-1)  
    const returns = [];  
    for (let i = 1; i < Math.min(30, prices.length); i++) {  
      returns.push(prices[prices.length - i] - prices[prices.length - i - 1]);  
    }  
    const autoCorr = this._correlation(returns.slice(0, -1), returns.slice(1));  
  
    if (zScore === null) return { signal: 0, confidence: 0, name };  
  
    let signal = 0;  
    let confidence = 0;  
    const reasons = [];  
  
    // Strong mean reversion signal  
    if (zScore < -1.8 && zScore10 < -1.4) {  
      signal = 1;  
      confidence = Math.min(90, Math.abs(zScore) * 25);  
      reasons.push(`Z20=${zScore.toFixed(2)}, Z8=${zScore10.toFixed(2)}, AutoCorr=${autoCorr.toFixed(3)}`);  
    }  
    else if (zScore > 1.8 && zScore10 > 1.4) {  
      signal = -1;  
      confidence = Math.min(90, Math.abs(zScore) * 25);  
      reasons.push(`Z20=${zScore.toFixed(2)}, Z8=${zScore10.toFixed(2)}, AutoCorr=${autoCorr.toFixed(3)}`);  
    }  
    // Moderate Z-Score with negative autocorrelation (mean-reverting market)  
    else if (zScore < -1.3 && autoCorr < -0.05) {  
      signal = 0.7;  
      confidence = Math.min(70, Math.abs(zScore) * 20 + Math.abs(autoCorr) * 50);  
      reasons.push(`Moderate MR: Z=${zScore.toFixed(2)}, negAutoCorr`);  
    }  
    else if (zScore > 1.3 && autoCorr < -0.05) {  
      signal = -0.7;  
      confidence = Math.min(70, Math.abs(zScore) * 20 + Math.abs(autoCorr) * 50);  
      reasons.push(`Moderate MR: Z=${zScore.toFixed(2)}, negAutoCorr`);  
    }  
  
    return { signal, confidence, name, reasons };  
  }  
  
  // ── STRATEGY 5: Candlestick Pattern ──  
  candlePatternStrategy(candles) {  
    const name = 'Candle Patterns';  
    if (candles.length < 5) return { signal: 0, confidence: 0, name };  
  
    const pattern = CandlePatternDetector.analyze(candles);  
  
    if (pattern.signal === 0) return { signal: 0, confidence: 0, name };  
  
    return {  
      signal: pattern.signal,  
      confidence: Math.abs(pattern.signal) * 65,  
      name,  
      reasons: [pattern.name],  
    };  
  }  
  
  // ── STRATEGY 6: Heikin-Ashi Trend Filter ──  
  heikinAshiStrategy(candles) {  
    const name = 'Heikin-Ashi';  
    if (candles.length < 8) return { signal: 0, confidence: 0, name };  
  
    const ha = IndicatorLibrary.HeikinAshi(candles);  
    if (ha.length < 4) return { signal: 0, confidence: 0, name };  
  
    const recent = ha.slice(-4);  
  
    // Count consecutive bullish/bearish HA candles  
    let bullCount = 0, bearCount = 0;  
    for (const c of recent) {  
      if (c.close > c.open) bullCount++;  
      else bearCount++;  
    }  
  
    // Check for strong HA signals  
    const last = recent[recent.length - 1];  
    const noLowerWick = Math.min(last.open, last.close) === last.low;  
    const noUpperWick = Math.max(last.open, last.close) === last.high;  
  
    let signal = 0;  
    let confidence = 0;  
    const reasons = [];  
  
    if (bullCount >= 3 && last.close > last.open) {  
      signal = 1;  
      confidence = Math.min(80, bullCount * 20 + (noLowerWick ? 15 : 0));  
      reasons.push(`${bullCount}/4 bullish HA candles${noLowerWick ? ' + strong body' : ''}`);  
    }  
    else if (bearCount >= 3 && last.close < last.open) {  
      signal = -1;  
      confidence = Math.min(80, bearCount * 20 + (noUpperWick ? 15 : 0));  
      reasons.push(`${bearCount}/4 bearish HA candles${noUpperWick ? ' + strong body' : ''}`);  
    }  
  
    return { signal, confidence, name, reasons };  
  }  
  
  // ── STRATEGY 7: Stochastic RSI Divergence ──  
  stochRSIStrategy(prices, candles) {  
    const name = 'Stoch RSI';  
    if (prices.length < 35) return { signal: 0, confidence: 0, name };  
  
    const stochRSI = IndicatorLibrary.StochRSI(prices, 8, 8, 3, 3); // speed up periods for tick responsiveness  
    const rsi = IndicatorLibrary.RSI(prices, 8);  
  
    if (!stochRSI || rsi === null) return { signal: 0, confidence: 0, name };  
  
    let signal = 0;  
    let confidence = 0;  
    const reasons = [];  
  
    // Oversold StochRSI + RSI divergence  
    if (stochRSI.k < 15 && stochRSI.d < 20 && rsi < 35) {  
      signal = 1;  
      confidence = Math.min(85, (20 - stochRSI.k) * 2 + (35 - rsi) * 2);  
      reasons.push(`StochRSI K=${stochRSI.k.toFixed(1)}, D=${stochRSI.d.toFixed(1)}, RSI=${rsi.toFixed(1)}`);  
  
      if (stochRSI.k > stochRSI.d) {  
        confidence += 10;  
        reasons.push('K>D crossover');  
      }  
    }  
    // Overbought  
    else if (stochRSI.k > 85 && stochRSI.d > 80 && rsi > 65) {  
      signal = -1;  
      confidence = Math.min(85, (stochRSI.k - 80) * 2 + (rsi - 65) * 2);  
      reasons.push(`StochRSI K=${stochRSI.k.toFixed(1)}, D=${stochRSI.d.toFixed(1)}, RSI=${rsi.toFixed(1)}`);  
  
      if (stochRSI.k < stochRSI.d) {  
        confidence += 10;  
        reasons.push('K<D crossover');  
      }  
    }  
  
    return { signal, confidence, name, reasons };  
  }  
  
  // ── Utility: Tick volatility measurement ──  
  _tickVolatility(prices, period) {  
    if (prices.length < period + 1) return 0;  
    let sum = 0;  
    for (let i = prices.length - period; i < prices.length; i++) {  
      sum += Math.abs(prices[i] - prices[i - 1]);  
    }  
    return sum / period;  
  }  
  
  // ── Utility: Pearson correlation ──  
  _correlation(x, y) {  
    const n = Math.min(x.length, y.length);  
    if (n < 3) return 0;  
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;  
    for (let i = 0; i < n; i++) {  
      sumX += x[i]; sumY += y[i];  
      sumXY += x[i] * y[i];  
      sumX2 += x[i] * x[i]; sumY2 += y[i] * y[i];  
    }  
    const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));  
    return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;  
  }  
  
  // ── Record strategy performance ──  
  recordResult(strategyName, wasCorrect) {  
    if (!this.strategyPerformance[strategyName]) {  
      this.strategyPerformance[strategyName] = { wins: 0, total: 0 };  
    }  
    this.strategyPerformance[strategyName].total++;  
    if (wasCorrect) this.strategyPerformance[strategyName].wins++;  
  }  
  
  getStrategyWeight(strategyName) {  
    const perf = this.strategyPerformance[strategyName];  
    if (!perf || perf.total < 5) return 1.0; // Default weight until enough data  
    const winRate = perf.wins / perf.total;  
    // Scale weight: 0.5 at 40% WR, 1.0 at 55% WR, 1.5 at 70% WR  
    return Math.max(0.2, Math.min(2.0, (winRate - 0.35) * 4));  
  }  
}  
  
// ============================================================================  
// SECTION 8: ADVANCED PREDICTION ENGINE  
// Combines all strategies with adaptive weighting  
// ============================================================================  
class PredictionEngine {  
  constructor(config, logger) {  
    this.config = config;  
    this.logger = logger;  
    this.strategy = new StrategyEngine(config.analysis);  
    this.candleBuilder = new CandleBuilder(config.analysis.candleSize);  
    this.signalHistory = [];  
    this.predictionLog = [];  
    this.weightsFilePath = path.join(__dirname, 'strategy_weights.json');  
    this.loadWeights();  
  }  
  
  loadWeights() {  
    try {  
      if (fs.existsSync(this.weightsFilePath)) {  
        const data = JSON.parse(fs.readFileSync(this.weightsFilePath, 'utf8'));  
        this.strategy.strategyPerformance = data;  
        this.logger.info('🧠 Loaded persistent strategy performance weights');  
      }  
    } catch (e) {  
      this.logger.warn(`Failed to load persistent strategy weights: ${e.message}`);  
    }  
  }  
  
  saveWeights() {  
    try {  
      fs.writeFileSync(this.weightsFilePath, JSON.stringify(this.strategy.strategyPerformance, null, 2), 'utf8');  
    } catch (e) {  
      this.logger.error(`Failed to save persistent strategy weights: ${e.message}`);  
    }  
  }  
  
  addTick(price) {  
    this.candleBuilder.addTick(price);  
  }  
  
  predict(prices) {  
    if (prices.length < this.config.analysis.warmupTicks) {  
      return {  
        signal: 'WAIT',  
        direction: null,  
        confidence: 0,  
        reason: `Warming up: ${prices.length}/${this.config.analysis.warmupTicks} ticks`,  
        strategies: [],  
        regime: null,  
      };  
    }  
  
    const candles = this.candleBuilder.getCandles();  
  
    // ── Step 1: Detect Market Regime ──  
    const regime = MarketRegimeDetector.detect(prices, candles);  
  
    // ── Step 2: Run All Enabled Strategies ──  
    const strategyResults = [];  
  
    if (this.config.analysis.enableMeanReversion) {  
      strategyResults.push(this.strategy.meanReversionStrategy(prices, candles));  
    }  
    if (this.config.analysis.enableTrendFollowing) {  
      strategyResults.push(this.strategy.trendFollowingStrategy(prices, candles));  
    }  
    if (this.config.analysis.enableMomentum) {  
      strategyResults.push(this.strategy.momentumBreakoutStrategy(prices, candles));  
    }  
    if (this.config.analysis.enableStatistical) {  
      strategyResults.push(this.strategy.statisticalStrategy(prices));  
    }  
    if (this.config.analysis.enableCandlePatterns && candles.length >= 5) {  
      strategyResults.push(this.strategy.candlePatternStrategy(candles));  
    }  
    if (this.config.analysis.enableHeikinAshi && candles.length >= 8) {  
      strategyResults.push(this.strategy.heikinAshiStrategy(candles));  
    }  
    if (this.config.analysis.enableStochRSI) {  
      strategyResults.push(this.strategy.stochRSIStrategy(prices, candles));  
    }  
  
    // ── Step 3: Filter Strategies by Market Regime ──  
    const weightedResults = strategyResults  
      .filter((r) => r.signal !== 0 && r.confidence > 0)  
      .map((r) => {  
        let regimeMultiplier = 1.0;  
  
        // Boost strategies that match the current regime  
        if (regime.regime === 'STRONG_TREND' || regime.regime === 'WEAK_TREND') {  
          if (r.name === 'Trend Following' || r.name === 'Heikin-Ashi') regimeMultiplier = 1.4;  
          if (r.name === 'Mean Reversion') regimeMultiplier = 0.5; // Penalize MR in trends  
        }  
        if (regime.regime === 'RANGING') {  
          if (r.name === 'Mean Reversion' || r.name === 'Statistical Edge') regimeMultiplier = 1.4;  
          if (r.name === 'Trend Following' || r.name === 'Momentum Breakout') regimeMultiplier = 0.5;  
        }  
        if (regime.regime === 'SQUEEZE') {  
          if (r.name === 'Momentum Breakout') regimeMultiplier = 1.3;  
          if (r.name === 'Mean Reversion') regimeMultiplier = 0.7;  
        }  
  
        // Adaptive weight from past performance  
        const performanceWeight = this.strategy.getStrategyWeight(r.name);  
  
        return {  
          ...r,  
          adjustedConfidence: r.confidence * regimeMultiplier * performanceWeight,  
          regimeMultiplier,  
          performanceWeight,  
        };  
      });  
  
    if (weightedResults.length === 0) {  
      return {  
        signal: 'WAIT',  
        direction: null,  
        confidence: 0,  
        reason: 'No strategy signals',  
        strategies: [],  
        regime,  
      };  
    }  
  
    // ── Step 4: Weighted Voting System ──  
    let bullScore = 0, bearScore = 0;  
    let bullWeight = 0, bearWeight = 0;  
    const activeStrategies = [];  
  
    for (const result of weightedResults) {  
      const weight = result.adjustedConfidence;  
      if (result.signal > 0) {  
        bullScore += result.signal * weight;  
        bullWeight += weight;  
      } else {  
        bearScore += Math.abs(result.signal) * weight;  
        bearWeight += weight;  
      }  
      activeStrategies.push({  
        name: result.name,  
        signal: result.signal > 0 ? 'CALLE' : 'PUTE',  
        confidence: result.adjustedConfidence.toFixed(1),  
        reasons: result.reasons || [],  
      });  
    }  
  
    // ── Step 5: Consensus Check ──  
    const totalWeight = bullWeight + bearWeight;  
    const bullPercentage = totalWeight > 0 ? (bullWeight / totalWeight) * 100 : 0;  
    const bearPercentage = totalWeight > 0 ? (bearWeight / totalWeight) * 100 : 0;  
  
    // Require supermajority (100%+ agreement)  
    const CONSENSUS_THRESHOLD = 100;  
    let direction = null;  
    let finalConfidence = 0;  
  
    if (bullPercentage >= CONSENSUS_THRESHOLD && bullScore > bearScore) {  
      direction = 'CALLE';  
      finalConfidence = (bullScore / (bullScore + bearScore)) * 100;  
    } else if (bearPercentage >= CONSENSUS_THRESHOLD && bearScore > bullScore) {  
      direction = 'PUTE';  
      finalConfidence = (bearScore / (bullScore + bearScore)) * 100;  
    }  
  
    // ── Step 6: Apply Additional Filters ──  
  
    // Minimum active strategies check  
    const agreeing = weightedResults.filter((r) =>  
      direction === 'CALLE' ? r.signal > 0 : r.signal < 0  
    ).length;  
  
    // Strict Consensus Filter: If we don't have enough agreeing strategies, do not trade!  
    const minAgreeing = this.config.analysis.minAgreeing || 2;  
    if (direction && agreeing < minAgreeing) {  
      return {  
        signal: 'WAIT',  
        direction: null,  
        confidence: 0,  
        reason: `Weak consensus: Only ${agreeing} strategy agrees, minimum ${minAgreeing} required.`,  
        strategies: activeStrategies,  
        regime,  
      };  
    }  
  
    // Conflicting signal penalty  
    const conflicting = weightedResults.filter((r) =>  
      direction === 'CALLE' ? r.signal < 0 : r.signal > 0  
    );  
    if (conflicting.some((c) => c.adjustedConfidence > 60)) {  
      finalConfidence *= 0.8; // Strong opposing signal  
    }  
  
    // Cap confidence  
    finalConfidence = Math.min(95, finalConfidence);  
  
    // ── Step 7: Build Composite Reason ──  
    const topStrategies = activeStrategies  
      .sort((a, b) => parseFloat(b.confidence) - parseFloat(a.confidence))  
      .slice(0, 3)  
      .map((s) => `${s.name}(${s.signal}:${s.confidence}%)`)  
      .join(' + ');  
  
    const reason = `${topStrategies} | Regime: ${regime.regime} | Consensus: ${direction === 'CALLE' ? bullPercentage.toFixed(0) : bearPercentage.toFixed(0)}%`;  
  
    // ── Step 8: Final Decision ──  
    const minConfidence = this.config.analysis.minConfidence;  
    const signal = direction && finalConfidence >= minConfidence ? direction : 'WAIT';  
  
    // Log prediction  
    this.signalHistory.push({  
      time: Date.now(),  
      signal,  
      direction,  
      confidence: finalConfidence,  
      regime: regime.regime,  
    });  
  
    // Keep history manageable  
    if (this.signalHistory.length > 500) {  
      this.signalHistory = this.signalHistory.slice(-300);  
    }  
  
    return {  
      signal,  
      direction,  
      confidence: parseFloat(finalConfidence.toFixed(1)),  
      reason,  
      strategies: activeStrategies,  
      regime,  
      consensus: {  
        bullPercentage: bullPercentage.toFixed(1),  
        bearPercentage: bearPercentage.toFixed(1),  
        agreeing,  
        total: weightedResults.length,  
      },  
    };  
  }  
  
  recordTradeResult(prediction, won) {  
    // Update strategy performance weights  
    for (const strat of prediction.strategies || []) {  
      const stratDirection = strat.signal;  
      const tradeDirection = prediction.direction;  
      const stratAgreed = stratDirection === tradeDirection;  
      const stratCorrect = stratAgreed ? won : !won;  
      this.strategy.recordResult(strat.name, stratCorrect);  
    }  
  
    this.predictionLog.push({  
      time: Date.now(),  
      direction: prediction.direction,  
      confidence: prediction.confidence,  
      regime: prediction.regime?.regime,  
      won,  
    });  
  
    // Save updated performance weights persistently!  
    this.saveWeights();  
  }  
  
  getPerformanceReport() {  
    const report = {};  
    for (const [name, perf] of Object.entries(this.strategy.strategyPerformance)) {  
      report[name] = {  
        trades: perf.total,  
        wins: perf.wins,  
        winRate: perf.total > 0 ? ((perf.wins / perf.total) * 100).toFixed(1) + '%' : 'N/A',  
        currentWeight: this.strategy.getStrategyWeight(name).toFixed(2),  
      };  
    }  
    return report;  
  }  
}  
  
// ============================================================================  
// SECTION 9: RISK MANAGEMENT ENGINE  
// ============================================================================  
class RiskManager {  
  constructor(config, logger) {  
    this.config = config;  
    this.logger = logger;  
    this.peakBalance = 0;  
    this.sessionStartBalance = 0;  
    this.tradeResults = [];  
  }  
  
  initialize(balance) {  
    this.peakBalance = balance;  
    this.sessionStartBalance = balance;  
  }  
  
  updateBalance(balance) {  
    if (balance > this.peakBalance) this.peakBalance = balance;  
  }  
  
  // Kelly Criterion position sizing  
  calculateKellyStake(winRate, avgWinLoss, balance) {  
    if (winRate <= 0 || avgWinLoss <= 0) return this.config.trading.initialStake;  
  
    const kellyFraction = this.config.risk.kellyFraction;  
    const b = avgWinLoss; // ratio of avg win to avg loss  
    const p = winRate;  
    const q = 1 - p;  
  
    let kelly = (b * p - q) / b;  
    kelly = Math.max(0, kelly);  
    kelly *= kellyFraction; // Fractional Kelly for safety  
  
    let stake = balance * kelly;  
  
    // Apply limits  
    stake = Math.max(this.config.trading.initialStake, stake);  
    stake = Math.min(this.config.trading.initialStake * this.config.risk.maxStakeMultiplier, stake);  
  
    return parseFloat(stake.toFixed(2));  
  }  
  
  // Volatility-adjusted stake
  calculateVolatilityAdjustedStake(baseStake, currentVolatility, averageVolatility) {
    if (!this.config.risk.volatilityAdjust || !averageVolatility || averageVolatility === 0) {
      return baseStake;
    }

    const volRatio = averageVolatility / Math.max(currentVolatility, 0.0001);
    const adjusted = baseStake * Math.max(0.5, Math.min(1.5, volRatio));
    // Never drop below the minimum stake
    return parseFloat(Math.max(this.config.trading.initialStake, adjusted).toFixed(2));
  }
  
  // Check drawdown limits  
  checkDrawdown(currentBalance) {  
    const drawdownPercent = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;  
    const sessionDrawdown = ((this.sessionStartBalance - currentBalance) / this.sessionStartBalance) * 100;  
  
    return {  
      drawdownPercent: drawdownPercent.toFixed(2),  
      sessionDrawdown: sessionDrawdown.toFixed(2),  
      breached: drawdownPercent >= this.config.risk.drawdownLimit,  
      warning: drawdownPercent >= this.config.risk.drawdownLimit * 0.7,  
    };  
  }  
  
  // Calculate optimal stake considering all factors  
  getOptimalStake(tradeStats, currentBalance, volatility, averageVolatility) {  
    const baseStake = this.config.trading.initialStake;  
  
    // If martingale is enabled  
    if (this.config.risk.martingaleEnabled && tradeStats.consecutiveLosses > 0) {  
      const step = Math.min(tradeStats.consecutiveLosses, this.config.risk.martingaleMaxSteps);  
      const martingaleStake = baseStake * Math.pow(this.config.risk.martingaleMultiplier, step);  
      // Dynamic max stake calculation to support Martingale steps  
      const maxMultiplier = Math.max(this.config.risk.maxStakeMultiplier, Math.pow(this.config.risk.martingaleMultiplier, this.config.risk.martingaleMaxSteps));  
      const maxStake = baseStake * maxMultiplier;  
      return parseFloat(Math.min(martingaleStake, maxStake, currentBalance * 0.1).toFixed(2));  
    }  
  
    // Anti-martingale (increase stake on wins)  
    if (this.config.risk.antiMartingaleEnabled && tradeStats.consecutiveWins > 0) {  
      const boost = 1 + (tradeStats.consecutiveWins * 0.2);  
      const maxBoost = this.config.risk.maxStakeMultiplier;  
      return parseFloat((baseStake * Math.min(boost, maxBoost)).toFixed(2));  
    }  
  
    // Kelly Criterion  
    if (tradeStats.totalTrades >= 10) {  
      const winRate = tradeStats.wins / tradeStats.totalTrades;  
      const avgWin = tradeStats.daily.profit / Math.max(1, tradeStats.daily.wins);  
      const avgLoss = tradeStats.daily.loss / Math.max(1, tradeStats.daily.losses);  
      const avgWinLoss = avgLoss > 0 ? avgWin / avgLoss : 1;  
      const kellyStake = this.calculateKellyStake(winRate, avgWinLoss, currentBalance);  
  
      // Volatility adjust  
      return this.calculateVolatilityAdjustedStake(kellyStake, volatility, averageVolatility);  
    }  
  
    return this.calculateVolatilityAdjustedStake(baseStake, volatility, averageVolatility);  
  }  
}  
  
// ============================================================================  
// SECTION 10: TRADE MANAGER  
// ============================================================================  
class TradeManager {  
  constructor(config) {  
    this.config = config;  
    this.activeTrades = new Map();  
    this.tradeHistory = [];  
    this.dailyStats = this._resetDailyStats();  
    this.consecutiveLosses = 0;  
    this.consecutiveWins = 0;  
    this.lastTradeTime = 0;  
    this.lastResetDate = new Date().toDateString();  
    this.lastPrediction = null;  
  }  
  
  _resetDailyStats() {  
    return { totalTrades: 0, wins: 0, losses: 0, profit: 0, loss: 0, netPnL: 0 };  
  }  
  
  checkDailyReset() {  
    const today = new Date().toDateString();  
    if (today !== this.lastResetDate) {  
      this.dailyStats = this._resetDailyStats();  
      this.lastResetDate = today;  
      return true;  
    }  
    return false;  
  }  
  
  canTrade() {  
    this.checkDailyReset();  
    const now = Date.now();  
    const checks = {  
      maxDailyTrades: this.dailyStats.totalTrades < this.config.trading.maxDailyTrades,  
      maxDailyLoss: this.dailyStats.netPnL > -this.config.trading.maxDailyLoss,  
      maxConcurrent: this.activeTrades.size < this.config.trading.maxConcurrentTrades,  
      cooldown: now - this.lastTradeTime >= this.config.trading.minTimeBetweenTrades,  
      lossCooldown: this.consecutiveLosses < this.config.trading.cooldownAfterLoss ||  
                    now - this.lastTradeTime >= this.config.trading.cooldownAfterLoss * 10000,  
    };  
  
    const reasons = [];  
    if (!checks.maxDailyTrades) reasons.push('Max daily trades');  
    if (!checks.maxDailyLoss) reasons.push('Max daily loss');  
    if (!checks.maxConcurrent) reasons.push('Max concurrent trades');  
    if (!checks.cooldown) reasons.push('Cooldown period');  
    if (!checks.lossCooldown) reasons.push('Loss cooldown');  
  
    return { allowed: Object.values(checks).every(Boolean), reasons };  
  }  
  
  registerTrade(contractId, details) {  
    this.activeTrades.set(contractId, { ...details, openTime: new Date() });  
    this.dailyStats.totalTrades++;  
    this.lastTradeTime = Date.now();  
    this.lastPrediction = details.prediction;  
  }  
  
  completeTrade(contractId, result) {  
    const trade = this.activeTrades.get(contractId);  
    if (!trade) return null;  
    this.activeTrades.delete(contractId);  
  
    const tradeResult = { ...trade, ...result, closeTime: new Date() };  
    this.tradeHistory.push(tradeResult);  
  
    if (result.profit > 0) {  
      this.dailyStats.wins++;  
      this.dailyStats.profit += result.profit;  
      this.consecutiveWins++;  
      this.consecutiveLosses = 0;  
    } else {  
      this.dailyStats.losses++;  
      this.dailyStats.loss += Math.abs(result.profit);  
      this.consecutiveLosses++;  
      this.consecutiveWins = 0;  
    }  
    this.dailyStats.netPnL = this.dailyStats.profit - this.dailyStats.loss;  
    return tradeResult;  
  }  
  
  getStats() {  
    const total = this.tradeHistory.length;  
    const wins = this.tradeHistory.filter((t) => t.profit > 0).length;  
    const totalPnL = this.tradeHistory.reduce((sum, t) => sum + (t.profit || 0), 0);  
    return {  
      totalTrades: total,  
      wins,  
      losses: total - wins,  
      winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',  
      totalPnL: totalPnL.toFixed(2),  
      daily: { ...this.dailyStats },  
      consecutiveWins: this.consecutiveWins,  
      consecutiveLosses: this.consecutiveLosses,  
    };  
  }  
}  
  
// ============================================================================  
// SECTION 11: TELEGRAM SERVICE  
// ============================================================================  
class TelegramService {  
  constructor(config, logger) {  
    this.config = config;  
    this.logger = logger;  
    this.bot = null;  
    this.enabled = config.telegram.enabled;  
    if (this.enabled) {  
      try {  
        this.bot = new TelegramBot(config.telegram.botToken, { polling: false });  
        this.logger.info('Telegram service initialized');  
      } catch (error) {  
        this.logger.error(`Telegram init failed: ${error.message}`);  
        this.enabled = false;  
      }  
    }  
  }  
  
  async send(message) {  
    if (!this.enabled || !this.bot) return;  
    try {  
      await this.bot.sendMessage(this.config.telegram.chatId, message, { parse_mode: 'HTML' });  
    } catch (error) {  
      this.logger.error(`Telegram send failed: ${error.message}`);  
    }  
  }  
  
  async sendStartup(balance, config) {  
    await this.send(  
`🤖 <b>DERIV BOT v3.1 STARTED</b>\n\n` +  
`📊 <b>Config:</b>\n` +  
`• Symbol: <code>${config.trading.symbol}</code>\n` +  
`• Stake: <code>$${config.trading.initialStake}</code>\n` +  
`• Duration: <code>${config.trading.contractDuration}${config.trading.contractDurationUnit}</code>\n` +  
`• Account: <code>${config.deriv.accountType}</code>\n` +  
`• Balance: <code>$${balance}</code>\n` +  
`• Min Confidence: <code>${config.analysis.minConfidence}%</code>\n\n` +  
`🧠 <b>Strategies:</b>\n` +  
`• Mean Reversion: ${config.analysis.enableMeanReversion ? '✅' : '❌'}\n` +  
`• Trend Following: ${config.analysis.enableTrendFollowing ? '✅' : '❌'}\n` +  
`• Momentum: ${config.analysis.enableMomentum ? '✅' : '❌'}\n` +  
`• Statistical: ${config.analysis.enableStatistical ? '✅' : '❌'}\n` +  
`• Candle Patterns: ${config.analysis.enableCandlePatterns ? '✅' : '❌'}\n` +  
`• Heikin-Ashi: ${config.analysis.enableHeikinAshi ? '✅' : '❌'}\n` +  
`• Stoch RSI: ${config.analysis.enableStochRSI ? '✅' : '❌'}\n\n` +  
`⏰ <code>${new Date().toISOString()}</code>`  
    );  
  }  
  
  async sendTradeOpened(data) {  
    const emoji = data.direction === 'CALLE' ? '📈' : '📉';  
    await this.send(  
`${emoji} <b>TRADE OPENED</b>\n\n` +  
`• Direction: <code>${data.direction}</code>\n` +  
`• Stake: <code>$${data.stake}</code>\n` +  
`• Confidence: <code>${data.confidence}%</code>\n` +  
`• Regime: <code>${data.regime}</code>\n` +  
`• Strategies: <code>${data.agreeing}/${data.total} agree</code>\n` +  
`• Reason: <i>${data.reason}</i>\n` +  
`• Contract: <code>${data.contractId}</code>`  
    );  
  }  
  
  async sendTradeResult(data) {  
    const won = data.profit > 0;  
    await this.send(  
`${won ? '✅' : '❌'} <b>TRADE ${won ? 'WON' : 'LOST'}</b>\n\n` +  
`• Profit: <code>${won ? '+' : ''}$${data.profit.toFixed(2)}</code>\n` +  
`• Balance: <code>$${data.balance}</code>\n` +  
`• Daily P&L: <code>${data.dailyPnL >= 0 ? '+' : ''}$${data.dailyPnL.toFixed(2)}</code>\n` +  
`• Win Rate: <code>${data.winRate}%</code>\n` +  
`• Streak: <code>${data.streak}</code>`  
    );  
  }  
  
  async sendDailySummary(stats, strategyReport) {  
    let stratText = '';  
    for (const [name, data] of Object.entries(strategyReport)) {  
      stratText += `• ${name}: ${data.winRate} (${data.trades} trades, w=${data.currentWeight})\n`;  
    }  
    await this.send(  
`📊 <b>HOURLY REPORT</b>\n\n` +  
`• Trades: <code>${stats.daily.totalTrades}</code>\n` +  
`• Win Rate: <code>${stats.winRate}%</code>\n` +  
`• Net P&L: <code>${stats.daily.netPnL >= 0 ? '+' : ''}$${stats.daily.netPnL.toFixed(2)}</code>\n\n` +  
`🧠 <b>Strategy Performance:</b>\n` +  
`<code>${stratText || '  No data yet'}</code>`  
    );  
  }  
  
  async sendError(error) {  
    await this.send(`🚨 <b>ERROR:</b> <code>${error}</code>`);  
  }  
  
  async sendShutdown(stats) {  
    await this.send(  
`🔴 <b>BOT STOPPED</b>\n` +  
`• Trades: <code>${stats.totalTrades}</code>\n` +  
`• Win Rate: <code>${stats.winRate}%</code>\n` +  
`• P&L: <code>${parseFloat(stats.totalPnL) >= 0 ? '+' : ''}$${stats.totalPnL}</code>`  
    );  
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
// SECTION 12b: DERIV API CLIENT (PAT / OTP flow — same method as reference bot)
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

  async buyContract(params) {
    const symbolKey = this._isPat ? 'underlying_symbol' : 'symbol';
    const response = await this.sendRequest({
      buy: 1, subscribe: 1, price: params.amount,
      parameters: {
        contract_type: params.contractType, [symbolKey]: params.symbol,
        duration: params.duration, duration_unit: params.durationUnit,
        basis: 'stake', amount: params.amount, currency: this.currency,
      },
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
// SECTION 13: MAIN BOT  
// ============================================================================  
class DerivTradingBot {  
  constructor() {  
    this.configManager = new ConfigManager();  
    this.config = this.configManager.config;  
    this.logger = new Logger();  
    this.telegram = new TelegramService(this.config, this.logger);  
    this.api = new DerivAPIClient(this.config, this.logger);  
    this.prediction = new PredictionEngine(this.config, this.logger);  
    this.tradeManager = new TradeManager(this.config);  
    this.riskManager = new RiskManager(this.config, this.logger);  
  
    this.tickPrices = [];  
    this.isRunning = false;  
    this.isTradingPaused = false;  
    this.summaryInterval = null;  
    this.tickCount = 0;  
  
    this._setupEventHandlers();  
    this._setupGracefulShutdown();  
  }  
  
  _setupEventHandlers() {  
    this.api.on('tick', (tick) => this.handleTick(tick));  
    this.api.on('contract_update', (contract) => this._handleContractUpdate(contract));  
    this.api.on('disconnected', () => {  
      this.isTradingPaused = true;  
      this.logger.warn('Trading paused — disconnected');  
    });  
    this.api.on('reconnected', async () => {  
      this.isTradingPaused = false;  
      try { await this.api.subscribeTicks(this.config.trading.symbol); }  
      catch (e) { this.logger.error(`Re-subscribe failed: ${e.message}`); }  
      this.logger.info('Trading resumed');  
    });  
    this.api.on('max_reconnect', async () => {  
      await this.telegram.sendError('Max reconnection attempts. Shutting down.');  
      this._shutdown();  
    });  
    this.api.on('api_error', async (error) => {  
      if (error.code === 'InvalidToken' || error.code === 'AuthorizationRequired') {  
        await this.telegram.sendError(`Critical: ${error.message}`);  
        this._shutdown();  
      }  
    });  
  }  
  
  _setupGracefulShutdown() {  
    const shutdown = async (signal) => {  
      this.logger.info(`Received ${signal}`);  
      await this.shutdown();  
      process.exit(0);  
    };  
    process.on('SIGINT', () => shutdown('SIGINT'));  
    process.on('SIGTERM', () => shutdown('SIGTERM'));  
    process.on('uncaughtException', async (error) => {  
      this.logger.error(`Uncaught: ${error.message}\n${error.stack}`);  
      await this.telegram.sendError(`Uncaught: ${error.message}`);  
      await this._shutdown();  
      process.exit(1);  
    });  
    process.on('unhandledRejection', async (reason) => {  
      this.logger.error(`Unhandled Rejection: ${reason}`);  
    });  
  }  
  
  _shutdown() {  
    this.shutdown();  
  }  
  
  async start() {  
    this._printBanner();  
  
    try {  
      await this.api.connect();  
      this.logger.info('✅ Connected');  
  
      const auth = await this.api.authorize();  
      this.logger.info(`✅ Authorized: ${auth.loginid} | $${this.api.balance} ${this.api.currency}`);  
  
      this.riskManager.initialize(this.api.balance);  
  
      // Load tick history  
      const history = await this.api.getTickHistory(this.config.trading.symbol, this.config.system.tickHistoryCount);  
      if (history?.prices) {  
        this.tickPrices = history.prices.map(Number);  
        // Feed history to candle builder  
        for (const price of this.tickPrices) {  
          this.prediction.addTick(price);  
        }  
        this.logger.info(`📊 Loaded ${this.tickPrices.length} historical ticks, built ${this.prediction.candleBuilder.getCandles().length} candles`);  
      }  
  
      await this.api.subscribeTicks(this.config.trading.symbol);  
      this.logger.info(`📡 Subscribed to ${this.config.trading.symbol}`);  
  
      await this.telegram.sendStartup(this.api.balance, this.config);  
  
      this.isRunning = true;  
      this.logger.info('🚀 Bot running — analyzing market...\n');  
  
      // Hourly summary  
      this.summaryInterval = setInterval(async () => {  
        const stats = this.tradeManager.getStats();  
        if (stats.daily.totalTrades > 0) {  
          const report = this.prediction.getPerformanceReport();  
          await this.telegram.sendDailySummary(stats, report);  
        }  
      }, 3600000);  
  
    } catch (error) {  
      this.logger.error(`Startup failed: ${error.message}`);  
      await this.telegram.sendError(`Startup failed: ${error.message}`);  
      process.exit(1);  
    }  
  }  
  
  async handleTick(tick) {  
    if (!this.isRunning || this.isTradingPaused) return;  
  
    const price = parseFloat(tick.quote);  
    this.tickPrices.push(price);  
    this.prediction.addTick(price);  
    this.tickCount++;  
  
    // Buffer management  
    if (this.tickPrices.length > this.config.system.maxTickBuffer) {  
      this.tickPrices = this.tickPrices.slice(-Math.floor(this.config.system.maxTickBuffer * 0.7));  
    }  
  
    // Log every 100 ticks  
    if (this.tickCount % 100 === 0) {  
      const candles = this.prediction.candleBuilder.getCandles();  
      this.logger.debug(`Ticks: ${this.tickCount} | Candles: ${candles.length} | Price: ${price}`);  
    }  
  
    // Run prediction  
    const result = this.prediction.predict(this.tickPrices);  
  
    if (result.signal === 'WAIT') return;  
  
    // Check trade eligibility  
    const canTrade = this.tradeManager.canTrade();  
    if (!canTrade.allowed) {  
      this.logger.debug(`Blocked: ${canTrade.reasons.join(', ')}`);  
      return;  
    }  
  
    // Check drawdown  
    const drawdown = this.riskManager.checkDrawdown(this.api.balance);  
    if (drawdown.breached) {  
      this.logger.warn(`⛔ Drawdown limit breached (${drawdown.drawdownPercent}%)`);  
      this.isTradingPaused = true;  
      await this.telegram.send(`⛔ <b>Drawdown limit (${this.config.risk.drawdownLimit}%) breached!</b> Trading paused.`);  
      setTimeout(() => { this.isTradingPaused = false; }, 1800000); // 30 min cooldown  
      return;  
    }  
    if (drawdown.warning) {  
      this.logger.warn(`⚠️ Drawdown warning: ${drawdown.drawdownPercent}%`);  
    }  
  
    await this.executeTrade(result, price);  
  }  
  
  async executeTrade(prediction, currentPrice) {  
    const contractType = prediction.direction;  
    const stats = this.tradeManager.getStats();  
  
    // Calculate optimal stake  
    const volatility = this.tickPrices.length > 20  
      ? this._calculateVolatility(this.tickPrices, 10)  
      : 0;  
    const avgVolatility = this.tickPrices.length > 60  
      ? this._calculateVolatility(this.tickPrices, 50)  
      : volatility;  
  
    const stake = this.riskManager.getOptimalStake(stats, this.api.balance, volatility, avgVolatility);  
  
    if (stake > this.api.balance) {  
      this.logger.warn(`Insufficient balance: $${stake} > $${this.api.balance}`);  
      return;  
    }  
  
    // Print comprehensive trade info  
    this.logger.info(`\n${'═'.repeat(70)}`);  
    this.logger.info(`🎯 TRADE SIGNAL: ${contractType}`);  
    this.logger.info(`${'─'.repeat(70)}`);  
    this.logger.info(`Confidence:  ${prediction.confidence}%`);  
    this.logger.info(`Regime:      ${prediction.regime?.regime} (${prediction.regime?.trendDirection})`);  
    this.logger.info(`Consensus:   ${prediction.consensus.agreeing}/${prediction.consensus.total} strategies agree`);  
    this.logger.info(`Bull/Bear:   ${prediction.consensus.bullPercentage}% / ${prediction.consensus.bearPercentage}%`);  
    this.logger.info(`Stake:       $${stake} (Balance: $${this.api.balance})`);  
    this.logger.info(`Strategies:`);  
    for (const s of prediction.strategies) {  
      this.logger.info(`• ${s.name}: ${s.signal} (${s.confidence}%) ${s.reasons?.join(', ') || ''}`);  
    }  
    this.logger.info(`${'═'.repeat(70)}\n`);  
  
    try {  
      const result = await this.api.buyContract({  
        contractType,  
        symbol: this.config.trading.symbol,  
        duration: this.config.trading.contractDuration,  
        durationUnit: this.config.trading.contractDurationUnit,  
        amount: stake,  
      });  
  
      this.tradeManager.registerTrade(result.contract_id, {  
        direction: contractType,  
        stake,  
        entryPrice: currentPrice,  
        confidence: prediction.confidence,  
        reason: prediction.reason,  
        prediction,  
      });  
  
      this.logger.info(`✅ Contract ${result.contract_id} opened | Buy: $${result.buy_price}`);  
  
      await this.telegram.sendTradeOpened({  
        direction: contractType,  
        stake,  
        confidence: prediction.confidence,  
        regime: prediction.regime?.regime,  
        agreeing: prediction.consensus.agreeing,  
        total: prediction.consensus.total,  
        reason: prediction.reason,  
        contractId: result.contract_id,  
      });  
  
    } catch (error) {  
      this.logger.error(`Trade failed: ${error.message}`);  
      await this.telegram.sendError(`Trade failed: ${error.message}`);  
    }  
  }  
  
  async _handleContractUpdate(contract) {  
    if (!contract.is_sold) return;  
  
    const contractId = contract.contract_id;  
    const profit = parseFloat(contract.profit) || (parseFloat(contract.sell_price) - parseFloat(contract.buy_price));  
    const exitPrice = parseFloat(contract.sell_spot || contract.exit_tick);  
  
    const result = this.tradeManager.completeTrade(contractId, {  
      profit, exitPrice, sellPrice: parseFloat(contract.sell_price), status: contract.status,  
    });  
  
    if (!result) return;  
  
    const won = profit > 0;  
    const stats = this.tradeManager.getStats();  
  
    // Update risk manager  
    this.riskManager.updateBalance(this.api.balance);  
  
    // Record result for strategy adaptation  
    if (result.prediction) {  
      this.prediction.recordTradeResult(result.prediction, won);  
    }  
  
    const streak = stats.consecutiveWins > 0  
      ? `${stats.consecutiveWins}W 🔥` : `${stats.consecutiveLosses}L ❄️`;  
  
    this.logger.info(`\n${'─'.repeat(50)}`);  
    this.logger.info(`${won ? '✅ WIN' : '❌ LOSS'} | P&L: ${won ? '+' : ''}$${profit.toFixed(2)} | Bal: $${this.api.balance}`);  
    this.logger.info(`Win Rate: ${stats.winRate}% | Daily: $${stats.daily.netPnL.toFixed(2)} | ${streak}`);  
    this.logger.info(`${'─'.repeat(50)}\n`);  
  
    await this.telegram.sendTradeResult({  
      profit, balance: this.api.balance,  
      dailyPnL: stats.daily.netPnL, winRate: stats.winRate, streak,  
    });  
  
    // Daily loss limit  
    if (stats.daily.netPnL <= -this.config.trading.maxDailyLoss) {  
      this.isTradingPaused = true;  
      this.logger.warn('⛔ Daily loss limit reached');  
      await this.telegram.send('⛔ <b>Daily loss limit reached.</b> Paused until tomorrow.');  
      const now = new Date();  
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);  
      setTimeout(() => {  
        this.isTradingPaused = false;  
        this.tradeManager.checkDailyReset();  
      }, tomorrow - now);  
    }  
  
    // Daily profit target unpause (TP lock-out fix!)  
    if (stats.daily.netPnL >= this.config.trading.takeProfitTarget) {  
      this.isTradingPaused = true;  
      this.logger.info(`🎯 Daily profit target reached: $${stats.daily.netPnL.toFixed(2)}`);  
      await this.telegram.send(`🎯 <b>Profit target reached!</b> $${stats.daily.netPnL.toFixed(2)}. Paused until tomorrow.`);  
      const now = new Date();  
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);  
      setTimeout(() => {  
        this.isTradingPaused = false;  
        this.tradeManager.checkDailyReset();  
      }, tomorrow - now);  
    }  
  }  
  
  _calculateVolatility(prices, period) {  
    if (prices.length < period + 1) return 0;  
    let sum = 0;  
    for (let i = prices.length - period; i < prices.length; i++) {  
      sum += Math.abs(prices[i] - prices[i - 1]);  
    }  
    return sum / period;  
  }  
  
  async shutdown() {  
    this.isRunning = false;  
    if (this.summaryInterval) clearInterval(this.summaryInterval);  
  
    const stats = this.tradeManager.getStats();  
    const report = this.prediction.getPerformanceReport();  
  
    this.logger.info('\n📊 FINAL STATISTICS:');  
    this.logger.info(`Trades: ${stats.totalTrades} | Wins: ${stats.wins} | Losses: ${stats.losses}`);  
    this.logger.info(`Win Rate: ${stats.winRate}% | P&L: $${stats.totalPnL}`);  
    this.logger.info('\n🧠 STRATEGY PERFORMANCE:');  
    for (const [name, data] of Object.entries(report)) {  
      this.logger.info(`${name}: ${data.winRate} (${data.trades} trades, weight=${data.currentWeight})`);  
    }  
  
    await this.telegram.sendShutdown(stats);  
    this.api.disconnect();  
    this.logger.info('\nGoodbye! 👋\n');  
  }  
  
  _printBanner() {  
    const c = this.config;  
    console.log(  
`╔════════════════════════════════════════════════════════════════════╗\n` +  
`║                                                                    ║\n` +  
`║         ██████╗ ███████╗██████╗ ██╗██╗   ██╗  ██████╗             ║\n` +  
`║         ██╔══██╗██╔════╝██╔══██╗██║██║   ██║  ╚════██╗            ║\n` +  
`║         ██║  ██║█████╗  ██████╔╝██║██║   ██║   █████╔╝            ║\n` +  
`║         ██║  ██║██╔══╝  ██╔══██╗██║╚██╗ ██╔╝   ╚═══██╗            ║\n` +  
`║         ██████╔╝███████╗██║  ██║██║ ╚████╔╝   ██████╔╝            ║\n` +  
`║         ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═════╝             ║\n` +  
`║                                                                    ║\n` +  
`║         ADVANCED MULTI-STRATEGY TRADING ENGINE v3.1                ║\n` +  
`║         Rise/Fall • Research-Backed • Adaptive Weighting           ║\n` +  
`║                                                                    ║\n` +  
`╠════════════════════════════════════════════════════════════════════╣\n` +  
`║  Symbol:         ${(c.trading.symbol).padEnd(47)}║\n` +  
`║  Stake:          $${(c.trading.initialStake.toString()).padEnd(46)}║\n` +  
`║  Account:        ${(c.deriv.accountType).padEnd(47)}║\n` +  
`║  Min Confidence: ${(c.analysis.minConfidence + '%').padEnd(47)}║\n` +  
`║  Strategies:     ${('7 active').padEnd(47)}║\n` +  
`║  Risk:           ${(c.risk.martingaleEnabled ? 'Martingale' : c.risk.antiMartingaleEnabled ? 'Anti-Martingale' : 'Kelly Criterion').padEnd(47)}║\n` +  
`║  Telegram:       ${(c.telegram.enabled ? 'Connected ✅' : 'Disabled ❌').padEnd(47)}║\n` +  
`╚════════════════════════════════════════════════════════════════════╝`  
    );  
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
  
module.exports = { DerivTradingBot, ConfigManager, Logger, IndicatorLibrary, CandleBuilder, CandlePatternDetector, MarketRegimeDetector, StrategyEngine, PredictionEngine, RiskManager, TradeManager, TelegramService, DerivAPIClient };  
