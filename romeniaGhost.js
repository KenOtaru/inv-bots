const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = "0P94g4WdSrSrzir";
const TELEGRAM_TOKEN = "8132747567:AAFtaN1j9U5HgNiK_TVE7axWzFDifButwKk"; // Your bot token
const CHAT_ID = "752497117"; // Your chat ID

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

class BlackFibonacci {
    constructor() {
        this.history = [];
        this.stake = 2.20;
        this.consecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.x2 = 0;
        this.x3 = 0;
        this.x4 = 0;
        this.x5 = 0;
        this.netProfit = 0;
        this.lastTradeDigit = null;
        this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };

        // Send startup message
        this.sendTelegram("BLACK FIBONACCI 9.1 FINAL — GHOST MODE ACTIVATED");

        ws.onopen = () => ws.send(JSON.stringify({ authorize: TOKEN }));

        ws.onmessage = (msg) => {
            const d = JSON.parse(msg.data);

            if (d.msg_type === "authorize") {
                ws.send(JSON.stringify({ ticks_history: "R_10", count: 3000, end: "latest", style: "ticks" }));
                ws.send(JSON.stringify({ ticks: "R_10", subscribe: 1 }));
            }

            if (d.tick && d.tick.symbol === "R_10") {
                const digit = Number(String(d.tick.quote).split('.')[1][2]);
                this.history.push(digit);
                if (this.history.length > 3000) this.history.shift();

                console.log('History length:', this.history.length);

                if (this.history.length >= 2000) {
                    this.scanForSignal();
                }
            }

            if (d.proposal_open_contract?.is_sold) {
                const won = d.proposal_open_contract.status === "won";
                const profit = parseFloat(d.proposal_open_contract.profit);

                this.totalTrades++;
                this.hourly.trades++;
                this.hourly.pnl += profit;
                this.netProfit += profit;

                if (won) {
                    this.totalWins++;
                    this.hourly.wins++;
                    this.consecutiveLosses = 0;
                    this.stake = 2.20;
                } else {
                    this.hourly.losses++;
                    this.consecutiveLosses++;
                    if (this.consecutiveLosses === 2) this.x2++;
                    if (this.consecutiveLosses === 3) this.x3++;
                    if (this.consecutiveLosses === 4) this.x4++;
                    if (this.consecutiveLosses === 5) this.x5++;

                    this.stake = this.consecutiveLosses === 1 ? 3.96 : 2.20 * Math.pow(11.3, this.consecutiveLosses - 1);
                    this.stake = Math.round(this.stake * 100) / 100;

                    // LOSS ALERT
                    this.sendTelegram(`
                    LOSS TRADE

                    Total Trades: ${this.totalTrades}
                    W/L: ${this.totalWins}/${this.totalTrades - this.totalWins}
                    x2-x5 Losses: ${this.x2}/${this.x3}/${this.x4}/${this.x5}
                    Current Stake: $${this.stake.toFixed(2)}
                    Net P&L: $${this.netProfit.toFixed(2)}
                    `);
                }
            }
        };

        // HOURLY SUMMARY
        setInterval(() => {
            if (this.hourly.trades > 0) {
                this.sendTelegram(`
                    HOURLY SUMMARY

                    Trades: ${this.hourly.trades}
                    W/L: ${this.hourly.wins}/${this.hourly.losses}
                    Win Rate: ${this.hourly.trades > 0 ? ((this.hourly.wins / this.hourly.trades) * 100).toFixed(1) : 0}%
                    P&L: ${this.hourly.pnl >= 0 ? '+' : ''}$${this.hourly.pnl.toFixed(2)}

                    Session Total:
                    Trades: ${this.totalTrades} | Net P&L: $${this.netProfit.toFixed(2)}
                `);
            }
            this.hourly = { trades: 0, wins: 0, losses: 0, pnl: 0 };
        }, 3600000);
    }

    scanForSignal() {
        const windows = [13, 21, 34, 55, 89, 144, 233, 377, 610, 987];
        const scores = Array(10).fill(0);

        for (const w of windows) {
            if (this.history.length < w) continue;
            const slice = this.history.slice(-w);
            const counts = Array(10).fill(0);
            slice.forEach(d => counts[d]++);
            const exp = w / 10;
            const sd = Math.sqrt(w * 0.1 * 0.9);

            for (let i = 0; i < 10; i++) {
                scores[i] += (counts[i] - exp) / sd;
            }
        }

        let maxZ = -99, sat = -1;
        for (let i = 0; i < 10; i++) {
            if (scores[i] > maxZ) { maxZ = scores[i]; sat = i; }
        }

        // ULTRA-LOW VOL CHECK
        const last500 = this.history.slice(-500);
        let entropy = 0;
        const freq = Array(10).fill(0);
        last500.forEach(d => freq[d]++);
        for (let f of freq) if (f > 0) entropy -= (f / 500) * Math.log2(f / 500);
        const conc = 1 - (entropy / Math.log2(10));

        const inRecent = this.history.slice(-9).includes(sat);
        const ultraLow = conc > 0.71;

        if (ultraLow && maxZ >= 11.15 && inRecent && sat !== this.lastTradeDigit) {
            this.lastTradeDigit = sat;

            ws.send(JSON.stringify({
                buy: 1, price: this.stake,
                parameters: {
                    amount: this.stake, basis: "stake", contract_type: "DIGITDIFF",
                    currency: "USD", duration: 1, duration_unit: "t",
                    symbol: "R_10", barrier: sat.toString()
                }
            }));

            this.sendTelegram(`TRADE SIGNAL\nDigit: ${sat} | Z: ${maxZ.toFixed(2)}\nStake: $${this.stake.toFixed(2)}`);
        }
    }

    sendTelegram(text) {
        bot.sendMessage(CHAT_ID, text, { parse_mode: "HTML" }).catch(() => { });
    }
}

new BlackFibonacci();
