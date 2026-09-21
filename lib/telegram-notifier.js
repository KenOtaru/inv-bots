'use strict';

const https = require('https');
const n = value => Number(value || 0);

class TelegramNotifier {
  constructor({ token = '', chatId = '', enabled = true } = {}) { this.token = token; this.chatId = chatId; this.enabled = enabled && Boolean(token) && Boolean(chatId); }
  send(text) {
    if (!this.enabled) return Promise.resolve();
    const body = JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    return new Promise(resolve => {
      const req = https.request(`https://api.telegram.org/bot${this.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', error => { console.error(`[TELEGRAM] ${error.message}`); resolve(); }); req.write(body); req.end();
    });
  }
  tradeOpen(position, martingale) { return this.send(`🚀 <b>OPTIONS TRADE OPEN</b>\n${position.underlying} → ${position.optionSide} <code>${position.symbol}</code>\nQty: ${position.quantity} | Entry: $${n(position.entryPrice).toFixed(4)} | Premium: $${n(position.premium).toFixed(2)}\nMartingale: L${martingale.level} | Next stake: $${n(martingale.nextStake).toFixed(2)}\nExit: ${position.exitSeconds || 60}s`); }
  tradeResult({ position, reason, realizedPnl, settlement }) { return this.send(`${realizedPnl >= 0 ? '✅' : '❌'} <b>OPTIONS TRADE RESULT</b>\n${position.underlying} <code>${position.symbol}</code>\nExit: ${reason}\nRealized P/L: $${n(realizedPnl).toFixed(2)}\nMartingale: L${settlement.level} | Next stake: $${n(settlement.nextStake).toFixed(2)}\nPool: $${n(settlement.pool).toFixed(2)}`); }
  summary(label, report) {
    const assets = report.assets.map(a => `${a.underlying}: ${a.trades}T ${a.wins}W/${a.losses}L | P/L $${n(a.netPnl).toFixed(2)} | L${a.level} | pool $${n(a.pool).toFixed(2)}`).join('\n') || 'No settled trades';
    return this.send(`📊 <b>${label}</b>\nSettled P/L: $${n(report.realizedToday).toFixed(2)} | Open: ${report.openPositions}\n\n<b>Per underlying</b>\n${assets}`);
  }
}
module.exports = { TelegramNotifier };
