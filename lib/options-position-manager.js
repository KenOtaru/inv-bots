'use strict';

const n = value => Number(value || 0);

/** Monitors bot-owned long options and closes only whole positions with FOK orders. */
class OptionsPositionManager {
  constructor(client, risk, config, { paperMode = true, notifier = null } = {}) { this.client = client; this.risk = risk; this.exit = config.exit; this.paperMode = paperMode; this.notifier = notifier; }
  async monitor() { for (const position of [...this.risk.openPositions.values()]) { try { await this.monitorOne(position); } catch (error) { console.error(`[MONITOR] ${position.symbol}: ${error.message}`); } } }
  async monitorOne(position) {
    const ageMs = Date.now() - position.openedAt; let pnl = 0; let markPrice = position.entryPrice;
    if (this.paperMode) { const marks = await this.client.mark(position.symbol); const mark = Array.isArray(marks) ? marks[0] : marks; markPrice = n(mark?.markPrice); pnl = (markPrice - position.entryPrice) * position.quantity * position.unit; }
    else { const rows = await this.client.positions(position.symbol); const actual = (Array.isArray(rows) ? rows : [rows]).find(p => n(p.quantity) > 0); if (!actual) return console.warn(`[MONITOR] ${position.symbol}: exchange has no matching long position; retaining local state for manual reconciliation`); markPrice = n(actual.markPrice); pnl = n(actual.unrealizedPNL); }
    const take = position.premium * this.exit.takeProfitPercent / 100, stop = -position.premium * this.exit.stopLossPercent / 100;
    const reason = ageMs >= this.exit.holdSeconds * 1000 ? 'one-minute time exit' : pnl >= take ? 'take-profit' : pnl <= stop ? 'stop-loss' : null;
    if (reason) await this.close(position, markPrice, pnl, reason);
  }
  async close(position, markPrice, estimatedPnl, reason) {
    const book = await this.client.depth(position.symbol, 5); const bid = n(book.bids?.[0]?.[0]); if (!(bid > 0)) return console.warn(`[EXIT] ${position.symbol}: no bid; keeping position open`);
    if (this.paperMode) { const realizedPnl = Number(((bid - position.entryPrice) * position.quantity * position.unit).toFixed(8)); const result = this.risk.settle(position.clientOrderId, realizedPnl); this.notifier?.tradeResult({ position, reason, realizedPnl, settlement: result }); return console.log('[PAPER EXIT]', { symbol: position.symbol, reason, estimatedPnl, realizedPnl, nextStake: result.nextStake, level: result.level }); }
    const result = await this.client.placeLimitOrder({ symbol: position.symbol, side: 'SELL', quantity: position.quantity, price: bid, clientOrderId: `${position.clientOrderId}-exit`, timeInForce: 'FOK', reduceOnly: true });
    if (n(result.executedQty) !== n(position.quantity) || result.status !== 'FILLED') return console.warn(`[EXIT] ${position.symbol}: FOK exit not filled; position remains open`);
    const realizedPnl = Number(((n(result.avgPrice || bid) - position.entryPrice) * position.quantity * position.unit - Math.abs(n(result.fee))).toFixed(8)); const settlement = this.risk.settle(position.clientOrderId, realizedPnl);
    this.notifier?.tradeResult({ position, reason, realizedPnl, settlement }); console.log('[LIVE EXIT]', { symbol: position.symbol, reason, realizedPnl, nextStake: settlement.nextStake, level: settlement.level });
  }
}
module.exports = { OptionsPositionManager };
