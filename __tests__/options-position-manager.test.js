const { OptionsRiskManager } = require('../lib/options-risk-manager');
const { OptionsPositionManager } = require('../lib/options-position-manager');

test('one-minute paper exit settles P/L and advances martingale only after exit', async () => {
  const config = { maxPremiumUsdt: 1000, maxOpenPositions: 1, maxDailyLossUsdt: 100, martingale: { investmentAmount: 100, initialStake: 10, multiplier: 1.5, maxLevel: 1, continueExtraLevels: 0, extraLevelMultipliers: [] }, exit: { holdSeconds: 60, takeProfitPercent: 100, stopLossPercent: 50 } };
  const risk = new OptionsRiskManager(config);
  risk.reserve({ clientOrderId: 'entry', underlying: 'BTCUSDT', symbol: 'BTC-X-C', premium: 10, entryPrice: 10, quantity: 1, unit: 1, openedAt: Date.now() - 61_000 });
  const client = { mark: async () => [{ markPrice: '9' }], depth: async () => ({ bids: [['9', '1']] }) };
  const manager = new OptionsPositionManager(client, risk, config, { paperMode: true });
  await manager.monitor();
  expect(risk.openPositions.size).toBe(0);
  expect(risk.status('BTCUSDT').level).toBe(1);
  expect(risk.status('BTCUSDT').nextStake).toBe(15);
});
