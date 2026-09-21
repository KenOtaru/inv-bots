# Binance Options WPR bot

`bizWillRFv2_BINANCE_OPTIONS.js` is a separate Binance crypto-Options bot. It discovers the current `TRADING` CALL and PUT contracts for the configured underlyings, uses closed spot candles for Williams %R signals, selects a liquid near-the-money contract near the requested delta, and buys the selected Call or Put.

## Safe startup

1. Copy `.env.example` to `.env` and keep `BINANCE_OPTIONS_PAPER_MODE=true`.
2. Adjust `config/binance-options.json`; the important guards are premium, position, daily-loss, days-to-expiry, and spread limits.
3. Run `node bizWillRFv2_BINANCE_OPTIONS.js`.

Paper mode needs no Binance credential and never sends an order. It logs the selected contract, premium and WPR values.

## Live mode

Before setting `BINANCE_OPTIONS_PAPER_MODE=false`, create a Binance API key restricted to Options trading, add an IP allowlist, do **not** enable withdrawals, and confirm that the account is eligible for Options. Put only the key and secret in `.env`; never put them in JavaScript or commit `.env`.

The current live entry path submits `BUY LIMIT IOC` orders only. Short/naked option selling is intentionally not implemented. Operate with a very small premium cap until order/fill reconciliation and exit management are extended for your account and strategy.
