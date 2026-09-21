# Binance Options WPR bot

`bizWillRFv2_BINANCE_OPTIONS.js` is a separate Binance crypto-Options bot. It discovers the current `TRADING` CALL and PUT contracts for the configured underlyings, uses closed spot candles for Williams %R signals, selects a liquid near-the-money contract near the requested delta, and buys the selected Call or Put.

## Safe startup

1. Copy `.env.example` to `.env` and keep `BINANCE_OPTIONS_PAPER_MODE=true`.
2. Adjust `config/binance-options.json`; the important guards are premium, position, daily-loss, days-to-expiry, and spread limits.
3. Run `node bizWillRFv2_BINANCE_OPTIONS.js`.

Paper mode needs no Binance credential and never sends an order. It logs the selected contract, premium and WPR values.

## Stake and martingale

The `martingale` block in `config/binance-options.json` mirrors the reference Deriv calculation per underlying: an initial `$0.50` stake, `×1.48` at level 1, then the configured extra-level multipliers. Each underlying has its own `$1,000` pool. A win resets its sequence to the initial stake; a loss advances only after a confirmed position settlement.

Options have contract-level minimum quantities and premiums, so a `$0.50` calculated stake can be below the Binance minimum. In that case the bot safely skips the trade. Raise `initialStake` only after checking the selected contracts' actual premiums and keep `maxPremiumUsdt` at or above the largest permitted sequence stake.

## Connectivity error: `ENOTFOUND eapi.binance.com`

This is a DNS/network error, not an API-key error. Verify that your computer can resolve both `eapi.binance.com` and `api.binance.com`, for example with `nslookup`. Configure a reliable DNS resolver on your router or Windows network adapter, then retry. Do not substitute an unofficial Binance endpoint; if Binance is unavailable in your jurisdiction, do not attempt to bypass those restrictions.

## Live mode

Before setting `BINANCE_OPTIONS_PAPER_MODE=false`, create a Binance API key restricted to Options trading, add an IP allowlist, do **not** enable withdrawals, and confirm that the account is eligible for Options. Put only the key and secret in `.env`; never put them in JavaScript or commit `.env`.

The current live entry path submits `BUY LIMIT IOC` orders only. Short/naked option selling is intentionally not implemented. Operate with a very small premium cap until order/fill reconciliation and exit management are extended for your account and strategy.
