// ============================================================================
// DERIV RISE/FALL TRADING BOT v4.0 — RNG MEAN-REVERSION OPTIMIZED
// Stripped of TA noise. Focused on Statistical Extremes & Recovery Management.
// ============================================================================

'use strict';

require('dotenv').config();
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
        apiToken: '0P94g4WdSrSrzir',
        appId: '1089',
        endpoint: `wss://ws.derivws.com/websockets/v3?app_id=${'1089'}`,
        accountType: 'DEMO',
      },
      telegram: {
        botToken: '8565754902:AAHS6UQWEgLJ0DO-JTpAGQhZLs-UDVVNAQc',
        chatId: '752497117',
        enabled: true,
      },
      trading: {
        symbol: 'R_75',
        initialStake: 0.35,
        contractDuration: 1, // CHANGED: 1 Minute instead of 5 ticks
        contractDurationUnit: 'm', // CHANGED: Minutes
        maxDailyLoss: 20,
        maxDailyTrades: 150,
        takeProfitTarget: 30,
        minTimeBetweenTrades: 15000, // 15s cooldown
      },
      analysis: {
        bbPeriod: 50,
        bbStdDev: 2.2, // Wider bands for RNG
        rsiPeriod: 14,
        rsiOverbought: 75,
        rsiOversold: 25,
        warmupTicks: 100,
      },
      risk: {
        // Capped Recovery System (Replaces Martingale/Kelly)
        recoveryMultiplier: 2.1,
        maxRecoverySteps: 3,
        drawdownLimit: 20,
      },
      system: {
        tickHistoryCount: 500,
        maxTickBuffer: 1000,
        reconnectDelay: 5000,
        maxReconnectAttempts: 15,
        heartbeatInterval: 30000,
      },
    };
    this.validate();
  }

  validate() {
    if (!this.config.deriv.apiToken) {
      console.error('❌ DERIV_API_TOKEN is required');
      process.exit(1);
    }
  }
}

// ============================================================================
// SECTION 2: LOGGER & TELEGRAM (Condensed for brevity, same as v3)
// ============================================================================
class Logger {
  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
      ),
      transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'bot.log' })],
    });
  }
  info(msg) { this.logger.info(msg); }
  warn(msg) { this.logger.warn(msg); }
  error(msg) { this.logger.error(msg); }
}

class TelegramService {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = config.telegram.enabled;
    if (this.enabled) this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
  }
  async send(msg) {
    if (!this.enabled) return;
    try { await this.bot.sendMessage(this.config.telegram.chatId, msg, { parse_mode: 'HTML' }); } 
    catch (e) { this.logger.error(`TG Error: ${e.message}`); }
  }
}

// ============================================================================
// SECTION 3: INDICATORS (Stripped to only what works on RNG)
// ============================================================================
class Indicators {
  static SMA(data, period) {
    if (data.length < period) return null;
    return data.slice(-period).reduce((s, v) => s + v, 0) / period;
  }

  static BollingerBands(data, period, stdMult) {
    const sma = this.SMA(data, period);
    if (!sma) return null;
    const slice = data.slice(-period);
    const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      upper: sma + stdMult * stdDev,
      middle: sma,
      lower: sma - stdMult * stdDev,
      percentB: (data[data.length - 1] - (sma - stdMult * stdDev)) / (2 * stdMult * stdDev)
    };
  }

  static RSI(data, period) {
    if (data.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const diff = data[i] - data[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }
}

// ============================================================================
// SECTION 4: PREDICTION ENGINE (Pure Mean Reversion)
// ============================================================================
class PredictionEngine {
  constructor(config) {
    this.config = config.analysis;
  }

  predict(prices) {
    if (prices.length < this.config.warmupTicks) {
      return { signal: 'WAIT', reason: 'Warming up...' };
    }

    const bb = Indicators.BollingerBands(prices, this.config.bbPeriod, this.config.bbStdDev);
    const rsi = Indicators.RSI(prices, this.config.rsiPeriod);

    if (!bb || rsi === null) return { signal: 'WAIT', reason: 'Calculating...' };

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2];

    // 1. Extreme Oversold + Price starting to tick UP = CALLE
    if (currentPrice <= bb.lower && rsi < this.config.rsiOversold && currentPrice > prevPrice) {
      return {
        signal: 'CALLE',
        confidence: Math.min(95, 60 + (this.config.rsiOversold - rsi)),
        reason: `Price < Lower BB | RSI: ${rsi.toFixed(1)} | Tick UP confirmed`
      };
    }

    // 2. Extreme Overbought + Price starting to tick DOWN = PUTE
    if (currentPrice >= bb.upper && rsi > this.config.rsiOverbought && currentPrice < prevPrice) {
      return {
        signal: 'PUTE',
        confidence: Math.min(95, 60 + (rsi - this.config.rsiOverbought)),
        reason: `Price > Upper BB | RSI: ${rsi.toFixed(1)} | Tick DOWN confirmed`
      };
    }

    return { signal: 'WAIT', reason: 'No extreme deviation' };
  }
}

// ============================================================================
// SECTION 5: RISK & TRADE MANAGER (Capped Recovery System)
// ============================================================================
class RiskAndTradeManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.consecutiveLosses = 0;
    this.dailyPnL = 0;
    this.totalTrades = 0;
    this.wins = 0;
    this.lastResetDate = new Date().toDateString();
  }

  checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyPnL = 0;
      this.lastResetDate = today;
    }
  }

  // The ONLY way to beat the 95% payout math is a capped recovery system
  calculateStake() {
    const base = this.config.trading.initialStake;
    if (this.consecutiveLosses === 0) return base;
    
    const step = Math.min(this.consecutiveLosses, this.config.risk.maxRecoverySteps);
    // Multiplier is 2.1 to cover the 95% payout loss and make a tiny profit
    const stake = base * Math.pow(this.config.risk.recoveryMultiplier, step); 
    return parseFloat(stake.toFixed(2));
  }

  recordTrade(profit) {
    this.totalTrades++;
    this.dailyPnL += profit;
    
    if (profit > 0) {
      this.wins++;
      this.consecutiveLosses = 0; // Reset on win
    } else {
      this.consecutiveLosses++;
    }
  }

  canTrade() {
    this.checkDailyReset();
    if (this.dailyPnL <= -this.config.trading.maxDailyLoss) return { allowed: false, reason: 'Daily Loss Limit Hit' };
    if (this.dailyPnL >= this.config.trading.takeProfitTarget) return { allowed: false, reason: 'Daily Profit Target Hit' };
    if (this.totalTrades >= this.config.trading.maxDailyTrades) return { allowed: false, reason: 'Max Trades Hit' };
    return { allowed: true };
  }

  getStats() {
    return {
      trades: this.totalTrades,
      wins: this.wins,
      winRate: this.totalTrades > 0 ? ((this.wins / this.totalTrades) * 100).toFixed(1) : '0.0',
      dailyPnL: this.dailyPnL.toFixed(2),
      currentStreak: this.consecutiveLosses > 0 ? `-${this.consecutiveLosses}L` : '0'
    };
  }
}

// ============================================================================
// SECTION 6: DERIV API CLIENT (Optimized)
// ============================================================================
class DerivAPI extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map();
    this.balance = 0;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.deriv.endpoint);
      this.ws.on('open', () => { this.logger.info('WS Connected'); resolve(); });
      this.ws.on('message', (d) => this._handle(JSON.parse(d.toString())));
      this.ws.on('close', () => { this.logger.warn('WS Closed'); this.emit('disconnect'); this._reconnect(); });
      this.ws.on('error', (e) => { this.logger.error(`WS Error: ${e.message}`); reject(e); });
    });
  }

  _handle(res) {
    if (res.msg_type === 'tick') this.emit('tick', res.tick);
    if (res.msg_type === 'proposal_open_contract' && res.proposal_open_contract.is_sold) {
      this.emit('contract_sold', res.proposal_open_contract);
    }
    if (res.msg_type === 'balance') this.balance = parseFloat(res.balance.balance);
    
    if (res.req_id && this.pending.has(res.req_id)) {
      const { resolve, reject } = this.pending.get(res.req_id);
      this.pending.delete(res.req_id);
      res.error ? reject(new Error(res.error.message)) : resolve(res);
    }
  }

  send(req) {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      req.req_id = id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(req));
    });
  }

  async authorize() {
    const res = await this.send({ authorize: this.config.deriv.apiToken });
    this.balance = parseFloat(res.authorize.balance);
    await this.send({ balance: 1, subscribe: 1 });
    return res.authorize;
  }

  async buy(params) {
    const res = await this.send({
      buy: 1, subscribe: 1, price: params.amount,
      parameters: {
        contract_type: params.type, symbol: params.symbol,
        duration: params.duration, duration_unit: params.unit,
        basis: 'stake', amount: params.amount, currency: 'USD'
      }
    });
    return res.buy;
  }

  async _reconnect() {
    await new Promise(r => setTimeout(r, this.config.system.reconnectDelay));
    try { await this.connect(); await this.authorize(); this.emit('reconnect'); } 
    catch (e) { this.logger.error('Reconnect failed'); }
  }
}

// ============================================================================
// SECTION 7: MAIN BOT ORCHESTRATOR
// ============================================================================
class DerivBot {
  constructor() {
    this.config = new ConfigManager().config;
    this.logger = new Logger();
    this.tg = new TelegramService(this.config, this.logger);
    this.api = new DerivAPI(this.config, this.logger);
    this.predictor = new PredictionEngine(this.config);
    this.risk = new RiskAndTradeManager(this.config, this.logger);
    
    this.prices = [];
    this.isTrading = true;
    this.lastTradeTime = 0;
  }

  async start() {
    this.logger.info('🚀 Starting Deriv Bot v4.0 (RNG Optimized)...');
    await this.api.connect();
    const auth = await this.api.authorize();
    this.logger.info(`✅ Authorized: ${auth.loginid} | Balance: $${this.api.balance}`);
    
    await this.tg.send(`🤖 <b>Bot v4.0 Started</b>\nBalance: $${this.api.balance}\nSymbol: ${this.config.trading.symbol}\nDuration: ${this.config.trading.contractDuration}m`);

    this.api.on('tick', (t) => this.onTick(t));
    this.api.on('contract_sold', (c) => this.onContractSold(c));
    this.api.on('disconnect', () => { this.isTrading = false; });
    this.api.on('reconnect', async () => { 
      this.isTrading = true; 
      await this.api.send({ ticks: this.config.trading.symbol, subscribe: 1 }); 
    });

    // Subscribe to ticks
    await this.api.send({ ticks: this.config.trading.symbol, subscribe: 1 });
    this.logger.info('📡 Listening to ticks...');
  }

  async onTick(tick) {
    if (!this.isTrading) return;

    const price = parseFloat(tick.quote);
    this.prices.push(price);
    if (this.prices.length > this.config.system.maxTickBuffer) {
      this.prices = this.prices.slice(-500);
    }

    // Cooldown check
    if (Date.now() - this.lastTradeTime < this.config.trading.minTimeBetweenTrades) return;

    // Predict
    const prediction = this.predictor.predict(this.prices);
    if (prediction.signal === 'WAIT') return;

    // Risk Check
    const canTrade = this.risk.canTrade();
    if (!canTrade.allowed) {
      this.logger.warn(`Trading paused: ${canTrade.reason}`);
      this.isTrading = false;
      await this.tg.send(`⛔ <b>Paused:</b> ${canTrade.reason}`);
      return;
    }

    await this.executeTrade(prediction, price);
  }

  async executeTrade(prediction, price) {
    const stake = this.risk.calculateStake();
    
    if (stake > this.api.balance) {
      this.logger.error('Insufficient balance for recovery stake!');
      this.isTrading = false;
      await this.tg.send('⛔ <b>Stopped:</b> Insufficient balance for recovery stake.');
      return;
    }

    this.logger.info(`🎯 SIGNAL: ${prediction.signal} | Stake: $${stake} | ${prediction.reason}`);

    try {
      const contract = await this.api.buy({
        type: prediction.signal,
        symbol: this.config.trading.symbol,
        duration: this.config.trading.contractDuration,
        unit: this.config.trading.contractDurationUnit,
        amount: stake
      });

      this.lastTradeTime = Date.now();
      this.logger.info(`✅ Opened Contract: ${contract.contract_id}`);
      
      await this.tg.send(`📈 <b>TRADE OPENED</b>\nDir: ${prediction.signal}\nStake: $${stake}\nReason: ${prediction.reason}`);
    } catch (e) {
      this.logger.error(`Trade failed: ${e.message}`);
    }
  }

  async onContractSold(contract) {
    const profit = parseFloat(contract.profit);
    this.risk.recordTrade(profit);
    const stats = this.risk.getStats();

    const emoji = profit > 0 ? '✅' : '❌';
    this.logger.info(`${emoji} ${profit > 0 ? 'WIN' : 'LOSS'} | P/L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)} | Daily: $${stats.dailyPnL} | WR: ${stats.winRate}%`);
    
    await this.tg.send(`${emoji} <b>${profit > 0 ? 'WIN' : 'LOSS'}</b>\nP/L: ${profit > 0 ? '+' : ''}$${profit.toFixed(2)}\nDaily: $${stats.dailyPnL}\nWin Rate: ${stats.winRate}%`);

    // Check daily limits after trade
    const canTrade = this.risk.canTrade();
    if (!canTrade.allowed) {
      this.isTrading = false;
      await this.tg.send(`🛑 <b>Session Over:</b> ${canTrade.reason}`);
    }
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================
(async () => {
  const bot = new DerivBot();
  await bot.start();
})();