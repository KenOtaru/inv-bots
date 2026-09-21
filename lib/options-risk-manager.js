'use strict';

/** Per-underlying stake pools and sequence match bizWillRFv2_FX2's StakeCalculator. */
class OptionsRiskManager {
  constructor(config) {
    this.config = config;
    this.rules = config.martingale;
    this.realizedToday = 0;
    this.openPositions = new Map();
    this.assets = new Map();
  }
  asset(underlying) {
    if (!this.assets.has(underlying)) this.assets.set(underlying, { pool: this.rules.investmentAmount, level: 0, wins: 0, losses: 0 });
    return this.assets.get(underlying);
  }
  stakeFor(underlying) {
    const state = this.asset(underlying); const r = this.rules; let stake;
    if (state.level <= r.maxLevel) stake = r.initialStake * Math.pow(r.multiplier, state.level);
    else {
      stake = r.initialStake * Math.pow(r.multiplier, r.maxLevel);
      for (let i = 0; i <= state.level - r.maxLevel - 1; i++) stake *= r.extraLevelMultipliers[i] || r.multiplier;
      if (state.level > r.maxLevel + r.continueExtraLevels) stake = r.initialStake;
    }
    return Number(Math.min(stake, state.pool).toFixed(2));
  }
  canOpen({ underlying, premium }) {
    const state = this.asset(underlying); const intendedStake = this.stakeFor(underlying);
    if (premium <= 0 || premium > intendedStake || premium > this.config.maxPremiumUsdt) return 'stake/premium limit';
    if (premium > state.pool) return 'insufficient per-underlying investment pool';
    if ([...this.openPositions.values()].some(p => p.underlying === underlying)) return 'open position already exists for underlying';
    if (this.openPositions.size >= this.config.maxOpenPositions) return 'position limit';
    if (this.realizedToday <= -this.config.maxDailyLossUsdt) return 'daily loss limit';
    return null;
  }
  reserve(position) { const state = this.asset(position.underlying); state.pool = Number((state.pool - position.premium).toFixed(2)); this.openPositions.set(position.clientOrderId, position); }
  release(clientOrderId) { const position = this.openPositions.get(clientOrderId); if (!position) return; const state = this.asset(position.underlying); state.pool = Number((state.pool + position.premium).toFixed(2)); this.openPositions.delete(clientOrderId); }
  settle(clientOrderId, realizedPnL) {
    const position = this.openPositions.get(clientOrderId); if (!position) throw new Error(`Unknown position ${clientOrderId}`);
    const state = this.asset(position.underlying); const pnl = Number(realizedPnL);
    state.pool = Number((state.pool + position.premium + pnl).toFixed(2));
    this.realizedToday = Number((this.realizedToday + pnl).toFixed(2)); this.openPositions.delete(clientOrderId);
    if (pnl >= 0) { state.level = 0; state.wins++; }
    else { state.level++; state.losses++; }
    return { underlying: position.underlying, pnl, level: state.level, nextStake: this.stakeFor(position.underlying), pool: state.pool };
  }
  status(underlying) { const state = this.asset(underlying); return { ...state, nextStake: this.stakeFor(underlying) }; }
}
module.exports = { OptionsRiskManager };
