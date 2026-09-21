const fs = require('fs');
const path = require('path');
const { BinanceOptionsStateStore } = require('../lib/binance-options-state-store');
const { OptionsRiskManager } = require('../lib/options-risk-manager');

test('restores an open position and its per-underlying martingale pool', () => {
  const file = path.join(process.cwd(), 'binance-options-state-test.json');
  try {
    const config = { maxPremiumUsdt: 100, maxOpenPositions: 2, maxDailyLossUsdt: 20, martingale: { investmentAmount: 100, initialStake: 1, multiplier: 1.5, maxLevel: 1, continueExtraLevels: 0, extraLevelMultipliers: [] } };
    const source = new OptionsRiskManager(config); source.reserve({ clientOrderId: 'persisted', underlying: 'BTCUSDT', premium: 1, symbol: 'BTC-X-C' });
    const store = new BinanceOptionsStateStore(file); store.save(source.snapshot());
    const restored = new OptionsRiskManager(config); restored.restore(store.load());
    expect(restored.openPositions.get('persisted').symbol).toBe('BTC-X-C');
    expect(restored.status('BTCUSDT').pool).toBe(99);
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
});
