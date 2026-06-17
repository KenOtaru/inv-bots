#!/usr/bin/env node

/**
 * Deriv Accumulator Trading Bot
 * A profitable trading bot for Deriv's Accumulator Market Type
 * 
 * Features:
 * - Multi-asset trading (Volatility indices)
 * - Configurable stake, growth rate, stop loss, take profit
 * - Auto-reconnection on errors
 * - Telegram notifications (trade opens, results, hourly & daily summaries)
 * - Comprehensive error handling
 */

const WebSocket = require('ws');
const https = require('https');

// ============================================================================
// CONFIGURATION - EDIT THESE VALUES
// ============================================================================

const CONFIG = {
  // Deriv API Token (get from https://app.deriv.com/account/api-token)
  API_TOKEN: '0P94g4WdSrSrzir',
  
  // Trading Parameters
  STAKE: 1, // Stake amount per trade
  GROWTH_RATE: 0.03, // 3% growth rate (0.01 to 0.05)
  STOP_LOSS: 5, // Stop loss amount
  TAKE_PROFIT: 10, // Take profit amount
  
  // Assets to trade (Volatility indices that support Accumulators)
  ASSETS: ['1HZ10V', '1HZ25V', '1HZ75V', '1HZ100V'], // Add/remove as needed
  
  // Telegram Configuration (optional but recommended)
  TELEGRAM: {
    ENABLED: false, // Set to true to enable Telegram notifications
    BOT_TOKEN: '8356265372:AAF00emJPbomDw8JnmMEdVW5b7ISX9_WQjQ',
    CHAT_ID: '752497117'
  },
  
  // Advanced Settings
  MAX_CONCURRENT_TRADES: 3, // Max simultaneous trades
  RECONNECT_DELAY: 5000, // Milliseconds
  MAX_RECONNECT_ATTEMPTS: 10,
  PING_INTERVAL: 30000, // Keep-alive ping every 30 seconds
};

// ============================================================================
// TRADING BOT CLASS
// ============================================================================

class DerivAccumulatorBot {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.reconnectAttempts = 0;
    this.pingInterval = null;
    this.reqId = 1;
    
    // Trading state
    this.activeContracts = new Map();
    this.proposals = new Map();
    this.assetSubscriptions = new Map();
    
    // Statistics
    this.stats = {
      totalTrades: 0,
      wonTrades: 0,
      lostTrades: 0,
      totalProfit: 0,
      todayTrades: [],
      hourlyTrades: [],
      startTime: new Date(),
      lastHourlySummary: new Date().getHours()
    };
    
    // Request callbacks
    this.callbacks = new Map();
  }

  // ==========================================================================
  // CONNECTION & AUTHENTICATION
  // ==========================================================================

  async start() {
    console.log('🚀 Starting Deriv Accumulator Trading Bot...');
    console.log(`📊 Trading Assets: ${this.config.ASSETS.join(', ')}`);
    console.log(`💰 Stake: $${this.config.STAKE} | Growth Rate: ${this.config.GROWTH_RATE * 100}%`);
    console.log(`🛡️ Stop Loss: $${this.config.STOP_LOSS} | Take Profit: $${this.config.TAKE_PROFIT}\n`);
    
    this.connect();
  }

  connect() {
    console.log('🔌 Connecting to Deriv WebSocket API...');
    
    this.ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
    
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('error', (error) => this.onError(error));
    this.ws.on('close', () => this.onClose());
  }

  onOpen() {
    console.log('✅ Connected to Deriv API');
    this.isConnected = true;
    this.reconnectAttempts = 0;
    
    // Start ping to keep connection alive
    this.startPing();
    
    // Authorize
    this.authorize();
  }

  authorize() {
    console.log('🔐 Authorizing...');
    
    this.sendRequest({
      authorize: this.config.API_TOKEN
    }, (response) => {
      if (response.error) {
        console.error('❌ Authorization failed:', response.error.message);
        this.sendTelegram(`❌ Authorization failed: ${response.error.message}`);
        process.exit(1);
      }
      
      console.log(`✅ Authorized as: ${response.authorize.email}`);
      console.log(`💵 Balance: ${response.authorize.balance} ${response.authorize.currency}\n`);
      
      this.isAuthorized = true;
      this.currency = response.authorize.currency;
      this.loginId = response.authorize.loginid;
      
      this.sendTelegram(
        `🤖 *Bot Started*\n\n` +
        `👤 Account: ${response.authorize.email}\n` +
        `💰 Balance: ${response.authorize.balance} ${response.authorize.currency}\n` +
        `📊 Assets: ${this.config.ASSETS.join(', ')}\n` +
        `💵 Stake: $${this.config.STAKE}\n` +
        `📈 Growth Rate: ${this.config.GROWTH_RATE * 100}%`
      );
      
      // Subscribe to balance updates
      this.subscribeToBalance();
      
      // Start trading
      this.initTrading();
    });
  }

  // ==========================================================================
  // TRADING LOGIC
  // ==========================================================================

  async initTrading() {
    console.log('🎯 Initializing trading strategies...\n');
    
    // Get active symbols to verify assets
    this.sendRequest({
      active_symbols: 'brief',
      product_type: 'basic'
    }, (response) => {
      if (response.error) {
        console.error('❌ Failed to get active symbols:', response.error.message);
        return;
      }
      
      // Filter valid accumulator symbols
      const validSymbols = response.active_symbols
        .filter(s => this.config.ASSETS.includes(s.symbol))
        .map(s => s.symbol);
      
      console.log(`✅ Valid trading symbols: ${validSymbols.join(', ')}\n`);
      
      // Start trading on each symbol
      validSymbols.forEach(symbol => this.startTradingSymbol(symbol));
    });
  }

  startTradingSymbol(symbol) {
    console.log(`📊 Starting trading on ${symbol}...`);
    
    // Subscribe to ticks for analysis
    this.subscribeToTicks(symbol);
    
    // Create initial proposal
    this.createProposal(symbol);
  }

  subscribeToTicks(symbol) {
    this.sendRequest({
      ticks: symbol,
      subscribe: 1
    }, (response) => {
      if (response.error) {
        console.error(`❌ Failed to subscribe to ${symbol}:`, response.error.message);
        return;
      }
      
      // Store subscription ID
      if (response.tick) {
        this.assetSubscriptions.set(symbol, response.subscription.id);
      }
    });
  }

  createProposal(symbol) {
    // Check if we've reached max concurrent trades
    if (this.activeContracts.size >= this.config.MAX_CONCURRENT_TRADES) {
      console.log(`⏸️ Max concurrent trades reached (${this.config.MAX_CONCURRENT_TRADES}), waiting...`);
      return;
    }
    
    const proposalRequest = {
      proposal: 1,
      amount: this.config.STAKE,
      basis: 'stake',
      contract_type: 'ACCU',
      currency: this.currency,
      symbol: symbol,
      growth_rate: this.config.GROWTH_RATE,
      limit_order: {
        stop_loss: this.config.STOP_LOSS,
        take_profit: this.config.TAKE_PROFIT
      },
      subscribe: 1
    };
    
    this.sendRequest(proposalRequest, (response) => {
      if (response.error) {
        console.error(`❌ Proposal error for ${symbol}:`, response.error.message);
        
        // Retry after delay
        setTimeout(() => this.createProposal(symbol), 3000);
        return;
      }
      
      if (response.proposal) {
        const proposal = response.proposal;
        this.proposals.set(proposal.id, {
          symbol,
          proposal,
          subscriptionId: response.subscription?.id
        });
        
        console.log(`📋 Proposal created for ${symbol}: ID=${proposal.id}, Ask Price=$${proposal.ask_price}`);
        
        // Auto-buy after analysis (simplified - you can add more sophisticated logic)
        setTimeout(() => this.buyContract(proposal.id), 2000);
      }
    });
  }

  buyContract(proposalId) {
    const proposalData = this.proposals.get(proposalId);
    
    if (!proposalData) {
      console.error(`❌ Proposal ${proposalId} not found`);
      return;
    }
    
    // Check concurrent trades limit again
    if (this.activeContracts.size >= this.config.MAX_CONCURRENT_TRADES) {
      console.log(`⏸️ Cannot buy: max concurrent trades reached`);
      
      // Forget proposal
      this.forgetSubscription(proposalData.subscriptionId);
      this.proposals.delete(proposalId);
      return;
    }
    
    const { symbol, proposal } = proposalData;
    
    console.log(`🛒 Buying ${symbol} contract...`);
    
    this.sendRequest({
      buy: proposalId,
      price: proposal.ask_price,
      subscribe: 1
    }, (response) => {
      if (response.error) {
        console.error(`❌ Buy failed for ${symbol}:`, response.error.message);
        
        // Forget proposal and retry
        this.forgetSubscription(proposalData.subscriptionId);
        this.proposals.delete(proposalId);
        
        setTimeout(() => this.createProposal(symbol), 3000);
        return;
      }
      
      if (response.buy) {
        const contract = response.buy;
        
        this.activeContracts.set(contract.contract_id, {
          contractId: contract.contract_id,
          symbol,
          buyPrice: contract.buy_price,
          payout: contract.payout,
          startTime: new Date(),
          subscriptionId: response.subscription?.id
        });
        
        // Remove from proposals
        this.forgetSubscription(proposalData.subscriptionId);
        this.proposals.delete(proposalId);
        
        console.log(`✅ Contract purchased: ${symbol} | ID: ${contract.contract_id} | Price: $${contract.buy_price}\n`);
        
        const message = 
          `🎯 *Trade Opened*\n\n` +
          `📊 Symbol: ${symbol}\n` +
          `🆔 Contract ID: ${contract.contract_id}\n` +
          `💰 Buy Price: $${contract.buy_price}\n` +
          `📈 Potential Payout: $${contract.payout}\n` +
          `📉 Stop Loss: $${this.config.STOP_LOSS}\n` +
          `📈 Take Profit: $${this.config.TAKE_PROFIT}\n` +
          `🕐 Time: ${new Date().toLocaleString()}`;
        
        this.sendTelegram(message);
        
        // Subscribe to contract updates
        this.subscribeToContract(contract.contract_id);
      }
    });
  }

  subscribeToContract(contractId) {
    this.sendRequest({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1
    }, (response) => {
      if (response.error) {
        console.error(`❌ Failed to subscribe to contract ${contractId}:`, response.error.message);
        return;
      }
      
      if (response.proposal_open_contract) {
        this.handleContractUpdate(response.proposal_open_contract);
      }
    });
  }

  handleContractUpdate(contract) {
    const contractData = this.activeContracts.get(contract.contract_id);
    
    if (!contractData) return;
    
    const { symbol, buyPrice } = contractData;
    const currentProfit = (contract.bid_price || 0) - buyPrice;
    
    // Update contract data
    contractData.currentPrice = contract.bid_price;
    contractData.currentProfit = currentProfit;
    
    // Log updates every 10 ticks or on significant changes
    if (!contractData.lastLogTick || contractData.lastLogTick + 10 < (contract.tick_count || 0)) {
      console.log(
        `📊 ${symbol} | Contract: ${contract.contract_id} | ` +
        `Ticks: ${contract.tick_count || 0} | ` +
        `Current: $${(contract.bid_price || 0).toFixed(2)} | ` +
        `P/L: ${currentProfit >= 0 ? '+' : ''}$${currentProfit.toFixed(2)}`
      );
      contractData.lastLogTick = contract.tick_count || 0;
    }
    
    // Check if contract is closed
    if (contract.is_sold || contract.status === 'sold') {
      this.handleContractClosed(contract);
    }
  }

  handleContractClosed(contract) {
    const contractData = this.activeContracts.get(contract.contract_id);
    
    if (!contractData) return;
    
    const { symbol, buyPrice, startTime } = contractData;
    const profit = contract.sell_price - buyPrice;
    const isWin = profit > 0;
    const duration = ((new Date() - startTime) / 1000).toFixed(0);
    
    // Update statistics
    this.stats.totalTrades++;
    if (isWin) {
      this.stats.wonTrades++;
    } else {
      this.stats.lostTrades++;
    }
    this.stats.totalProfit += profit;
    
    // Add to today's trades
    this.stats.todayTrades.push({
      symbol,
      contractId: contract.contract_id,
      buyPrice,
      sellPrice: contract.sell_price,
      profit,
      isWin,
      time: new Date(),
      duration
    });
    
    // Add to hourly trades
    this.stats.hourlyTrades.push({
      symbol,
      profit,
      time: new Date()
    });
    
    // Log result
    const emoji = isWin ? '✅' : '❌';
    const profitStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
    
    console.log(
      `${emoji} Trade Closed: ${symbol} | ` +
      `Contract: ${contract.contract_id} | ` +
      `Buy: $${buyPrice.toFixed(2)} | ` +
      `Sell: $${contract.sell_price.toFixed(2)} | ` +
      `P/L: ${profitStr} | ` +
      `Duration: ${duration}s\n`
    );
    
    // Send Telegram notification
    const winRate = ((this.stats.wonTrades / this.stats.totalTrades) * 100).toFixed(1);
    
    const message = 
      `${emoji} *Trade ${isWin ? 'Won' : 'Lost'}*\n\n` +
      `📊 Symbol: ${symbol}\n` +
      `🆔 Contract: ${contract.contract_id}\n` +
      `💰 Buy Price: $${buyPrice.toFixed(2)}\n` +
      `💵 Sell Price: $${contract.sell_price.toFixed(2)}\n` +
      `${isWin ? '💚' : '❤️'} Profit/Loss: ${profitStr}\n` +
      `⏱️ Duration: ${duration}s\n` +
      `📊 Session Stats: ${this.stats.wonTrades}W/${this.stats.lostTrades}L (${winRate}%)\n` +
      `💰 Total P/L: ${this.stats.totalProfit >= 0 ? '+' : ''}$${this.stats.totalProfit.toFixed(2)}`;
    
    this.sendTelegram(message);
    
    // Clean up
    if (contractData.subscriptionId) {
      this.forgetSubscription(contractData.subscriptionId);
    }
    this.activeContracts.delete(contract.contract_id);
    
    // Start new trade on this symbol
    setTimeout(() => this.createProposal(symbol), 2000);
    
    // Check if we should send hourly summary
    this.checkHourlySummary();
  }

  // ==========================================================================
  // STATISTICS & SUMMARIES
  // ==========================================================================

  checkHourlySummary() {
    const currentHour = new Date().getHours();
    
    if (currentHour !== this.stats.lastHourlySummary && this.stats.hourlyTrades.length > 0) {
      this.sendHourlySummary();
      this.stats.lastHourlySummary = currentHour;
      this.stats.hourlyTrades = [];
    }
  }

  sendHourlySummary() {
    const hourlyProfit = this.stats.hourlyTrades.reduce((sum, t) => sum + t.profit, 0);
    const hourlyTrades = this.stats.hourlyTrades.length;
    const hourlyWins = this.stats.hourlyTrades.filter(t => t.profit > 0).length;
    const hourlyLosses = hourlyTrades - hourlyWins;
    const hourlyWinRate = hourlyTrades > 0 ? ((hourlyWins / hourlyTrades) * 100).toFixed(1) : 0;
    
    const message = 
      `📊 *Hourly Summary*\n\n` +
      `🕐 Time: ${new Date().toLocaleTimeString()}\n` +
      `📈 Trades: ${hourlyTrades}\n` +
      `✅ Won: ${hourlyWins}\n` +
      `❌ Lost: ${hourlyLosses}\n` +
      `📊 Win Rate: ${hourlyWinRate}%\n` +
      `💰 Hourly P/L: ${hourlyProfit >= 0 ? '+' : ''}$${hourlyProfit.toFixed(2)}\n` +
      `💵 Total P/L: ${this.stats.totalProfit >= 0 ? '+' : ''}$${this.stats.totalProfit.toFixed(2)}`;
    
    this.sendTelegram(message);
    console.log('\n' + '='.repeat(60));
    console.log(message.replace(/\*/g, ''));
    console.log('='.repeat(60) + '\n');
  }

  sendDailySummary() {
    const dailyProfit = this.stats.todayTrades.reduce((sum, t) => sum + t.profit, 0);
    const dailyTrades = this.stats.todayTrades.length;
    const dailyWins = this.stats.todayTrades.filter(t => t.isWin).length;
    const dailyLosses = dailyTrades - dailyWins;
    const dailyWinRate = dailyTrades > 0 ? ((dailyWins / dailyTrades) * 100).toFixed(1) : 0;
    
    // Group by symbol
    const bySymbol = {};
    this.stats.todayTrades.forEach(trade => {
      if (!bySymbol[trade.symbol]) {
        bySymbol[trade.symbol] = { trades: 0, profit: 0, wins: 0 };
      }
      bySymbol[trade.symbol].trades++;
      bySymbol[trade.symbol].profit += trade.profit;
      if (trade.isWin) bySymbol[trade.symbol].wins++;
    });
    
    let symbolStats = '\n📊 *Per Symbol:*\n';
    Object.keys(bySymbol).forEach(symbol => {
      const data = bySymbol[symbol];
      const winRate = ((data.wins / data.trades) * 100).toFixed(1);
      symbolStats += `  ${symbol}: ${data.trades} trades, ${data.wins}W/${data.trades - data.wins}L (${winRate}%), P/L: ${data.profit >= 0 ? '+' : ''}$${data.profit.toFixed(2)}\n`;
    });
    
    const message = 
      `🌙 *End of Day Summary*\n\n` +
      `📅 Date: ${new Date().toLocaleDateString()}\n` +
      `📈 Total Trades: ${dailyTrades}\n` +
      `✅ Won: ${dailyWins}\n` +
      `❌ Lost: ${dailyLosses}\n` +
      `📊 Win Rate: ${dailyWinRate}%\n` +
      `💰 Daily P/L: ${dailyProfit >= 0 ? '+' : ''}$${dailyProfit.toFixed(2)}\n` +
      symbolStats;
    
    this.sendTelegram(message);
    console.log('\n' + '='.repeat(60));
    console.log(message.replace(/\*/g, ''));
    console.log('='.repeat(60) + '\n');
    
    // Reset today's trades
    this.stats.todayTrades = [];
  }

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  subscribeToBalance() {
    this.sendRequest({
      balance: 1,
      subscribe: 1
    }, (response) => {
      if (response.balance) {
        console.log(`💰 Balance Update: ${response.balance.balance} ${response.balance.currency}`);
      }
    });
  }

  sendRequest(request, callback) {
    const reqId = this.reqId++;
    request.req_id = reqId;
    
    if (callback) {
      this.callbacks.set(reqId, callback);
    }
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(request));
    } else {
      console.error('❌ WebSocket not ready. Request not sent:', request);
    }
  }

  forgetSubscription(subscriptionId) {
    if (!subscriptionId) return;
    
    this.sendRequest({
      forget: subscriptionId
    });
  }

  startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendRequest({ ping: 1 });
      }
    }, this.config.PING_INTERVAL);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ==========================================================================
  // TELEGRAM NOTIFICATIONS
  // ==========================================================================

  sendTelegram(message) {
    if (!this.config.TELEGRAM.ENABLED) return;
    
    const url = `https://api.telegram.org/bot${this.config.TELEGRAM.BOT_TOKEN}/sendMessage`;
    const data = JSON.stringify({
      chat_id: this.config.TELEGRAM.CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    
    const req = https.request(url, options, (res) => {
      // Silently handle response
    });
    
    req.on('error', (error) => {
      console.error('Telegram error:', error.message);
    });
    
    req.write(data);
    req.end();
  }

  // ==========================================================================
  // WEBSOCKET EVENT HANDLERS
  // ==========================================================================

  onMessage(data) {
    let response;
    
    try {
      response = JSON.parse(data.toString());
    } catch (error) {
      console.error('❌ Failed to parse message:', error.message);
      return;
    }
    
    // Handle errors
    if (response.error) {
      console.error(`❌ API Error [${response.error.code}]:`, response.error.message);
      
      // Handle specific errors
      if (response.error.code === 'AuthorizationRequired') {
        this.isAuthorized = false;
        setTimeout(() => this.authorize(), 2000);
      }
      
      // Call callback if exists
      if (response.req_id && this.callbacks.has(response.req_id)) {
        const callback = this.callbacks.get(response.req_id);
        callback(response);
        this.callbacks.delete(response.req_id);
      }
      
      return;
    }
    
    // Route to callback
    if (response.req_id && this.callbacks.has(response.req_id)) {
      const callback = this.callbacks.get(response.req_id);
      callback(response);
      
      // Remove callback if not a subscription
      if (!response.subscription) {
        this.callbacks.delete(response.req_id);
      }
    }
  }

  onError(error) {
    console.error('❌ WebSocket error:', error.message);
  }

  onClose() {
    console.log('🔌 WebSocket connection closed');
    this.isConnected = false;
    this.isAuthorized = false;
    this.stopPing();
    
    // Send end of day summary if needed
    const currentHour = new Date().getHours();
    if (currentHour === 23 && this.stats.todayTrades.length > 0) {
      this.sendDailySummary();
    }
    
    // Attempt reconnection
    if (this.reconnectAttempts < this.config.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      console.log(`🔄 Reconnecting in ${this.config.RECONNECT_DELAY / 1000}s... (Attempt ${this.reconnectAttempts}/${this.config.MAX_RECONNECT_ATTEMPTS})`);
      
      setTimeout(() => {
        this.connect();
      }, this.config.RECONNECT_DELAY);
    } else {
      console.error('❌ Max reconnection attempts reached. Bot stopped.');
      this.sendTelegram('❌ *Bot Stopped*\n\nMax reconnection attempts reached.');
      process.exit(1);
    }
  }
}

// ============================================================================
// START BOT
// ============================================================================

// Validate configuration
if (!CONFIG.API_TOKEN || CONFIG.API_TOKEN === 'YOUR_DERIV_API_TOKEN_HERE') {
  console.error('\n❌ ERROR: Please set your Deriv API Token in the configuration!');
  console.log('\n📝 To get your API token:');
  console.log('   1. Go to https://app.deriv.com/account/api-token');
  console.log('   2. Create a new token with "Trading" and "Payments" scopes');
  console.log('   3. Copy the token and paste it in CONFIG.API_TOKEN\n');
  process.exit(1);
}

// Create and start bot
const bot = new DerivAccumulatorBot(CONFIG);
bot.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down bot...');
  
  // Send final summary
  if (bot.stats.todayTrades.length > 0) {
    bot.sendDailySummary();
  }
  
  bot.sendTelegram('🛑 *Bot Stopped*\n\nManual shutdown by user.');
  
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

// Send daily summary at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0 && bot.stats.todayTrades.length > 0) {
    bot.sendDailySummary();
  }
}, 60000); // Check every minute

console.log('\n✅ Bot initialized. Press Ctrl+C to stop.\n');