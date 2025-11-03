require('dotenv').config();
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class EnhancedDigitDifferTradingBot {
    constructor(token, config = {}) {
        this.token = token;

        this.ws = null;
        this.connected = false;
        this.wsReady = false;

        this.assets = config.assets || [
            // 'R_10','R_25','R_50','R_75', 'R_100', 
            // 'RDBULL', 'RDBEAR', 
            // '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V',
            // 'JD10', 'JD25', 'JD50', 'JD75', 'JD100',
            'R_10','R_25','R_50','R_75', 'R_100', 'RDBULL', 'RDBEAR',
            // 'R_75',
        ];

        this.config = {
            initialStake: config.initialStake || 10.5,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
            stopLoss: config.stopLoss || 50,
            takeProfit: config.takeProfit || 1,
            requiredHistoryLength: config.requiredHistoryLength || 200,
            winProbabilityThreshold: config.winProbabilityThreshold || 100,
            maxReconnectAttempts: config.maxReconnectAttempts || 10000,
            reconnectInterval: config.reconnectInterval || 5000,
            minWaitTime: config.minWaitTime || 200 * 1000,
            maxWaitTime: config.maxWaitTime || 500 * 1000,
        };

        this.currentStake = this.config.initialStake;
        this.consecutiveLosses = 0;
        this.currentTradeId = null;
        this.digitCounts = {};
        this.tickSubscriptionIds = {};
        this.tickHistories = {};
        this.tickHistories2 = {};
        this.lastDigits = {};
        this.lastDigits2 = {};
        this.predictedDigits = {};
        this.lastPredictions = {};
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.consecutiveLosses4 = 0;
        this.consecutiveLosses5 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.predictionInProgress = false;
        this.endOfDay = false;
        this.lastPredictionOutcome = null;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.isWinTrade = false;
        this.retryCount = 0;
        // this.startTime = null;
        this.isExcluded = [];
        // Add new property to track suspended assets
        this.suspendedAssets = new Set();

        this.assets.forEach(asset => {
            this.tickHistories[asset] = [];
            this.tickHistories2[asset] = [];
            this.digitCounts[asset] = Array(10).fill(0);
            this.lastDigits[asset] = null;
            this.lastDigits2[asset] = null;
            this.predictedDigits[asset] = null;
            this.lastPredictions[asset] = [];
        });

        //Email Configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        
        this.startEmailTimer();

        this.reconnectAttempts = 0;
        this.Pause = false;

        this.todayPnL = 0;
    }

    connect() {
        if (!this.Pause) {
            console.log('Attempting to connect to Deriv API...');
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                const message = JSON.parse(data);
                this.handleMessage(message);
            });

            this.ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.handleDisconnect();
            });

            this.ws.on('close', () => {
                console.log('Disconnected from Deriv API');
                this.connected = false;
                if (!this.Pause) {
                    this.handleDisconnect();
                }
            });
        }
    }

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.config.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.config.reconnectInterval);
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token. Please check your API token and restart the bot.');
                this.sendErrorEmail('Invalid API token');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit reached. Waiting before next request...');
                setTimeout(() => this.initializeSubscriptions(), 60000);
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.initializeSubscriptions(), 3600000);
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.initializeSubscriptions();
        }
    }

    authenticate() {
        console.log('Attempting to authenticate...');
        this.sendRequest({
            authorize: this.token
        });
    }

    subscribeToTickHistory(asset) {
        const request = {
            ticks_history: asset,
            adjust_start_time: 1,
            count: this.config.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        // console.log(`Requested tick history for asset: ${asset}`);
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleMessage(message) {
        if (message.msg_type === 'authorize') {
            if (message.error) {
                console.error('Authentication failed:', message.error.message);
                this.disconnect();
                return;
            }
            console.log('Authentication successful');

            this.tradeInProgress = false;
            this.predictionInProgress = false;
            this.assets.forEach(asset => {
                this.tickHistories[asset] = [];
                this.tickHistories2[asset] = [];
                this.digitCounts[asset] = Array(10).fill(0);
                this.predictedDigits[asset] = null;
                this.lastPredictions[asset] = [];
            });
            this.tickSubscriptionIds = {};
            this.retryCount = 0;
            this.initializeSubscriptions();

        } else if (message.msg_type === 'history') {
            const asset = message.echo_req.ticks_history;
            this.handleTickHistory(asset, message.history);
        } else if (message.msg_type === 'tick') {
            if (message.subscription) {
                const asset = message.tick.symbol;
                this.tickSubscriptionIds[asset] = message.subscription.id;
                // console.log(`Subscribed to ticks for ${asset}. Subscription ID: ${this.tickSubscriptionIds[asset]}`);
            }
            this.handleTickUpdate(message.tick);
        } else if (message.msg_type === 'buy') {
            if (message.error) {
                console.error('Error placing trade:', message.error.message);
                this.tradeInProgress = false;
                return;
            }
            console.log('Trade placed successfully');
            this.currentTradeId = message.buy.contract_id;
            this.subscribeToOpenContract(this.currentTradeId);
        } else if (message.msg_type === 'proposal_open_contract') {
            if (message.error) {
                console.error('Error receiving contract update:', message.error.message);
                return;
            }
            this.handleContractUpdate(message.proposal_open_contract);
        } else if (message.msg_type === 'forget') {
            // console.log('Successfully unsubscribed from ticks');
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V',].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    getLastDigit2(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            // Second-to-last is index 2 (third digit) if length >= 4
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[2]) : 0;
        } else if (['R_10', 'R_25', '1HZ15V', '1HZ30V', '1HZ90V'].includes(asset)) {
            // Second-to-last is index 1 (second digit) if length >= 3
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[1]) : 0;
        } else {
            // Second-to-last is index 0 (first digit) if length >= 2
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[0]) : 0;
        }
    }

    initializeSubscriptions() {
        console.log('Initializing subscriptions for all assets...');
        this.assets.forEach(asset => {
            this.subscribeToTickHistory(asset);
            this.subscribeToTicks(asset);
        });
    }

    handleTickHistory(asset, history) {
        this.tickHistories[asset] = history.prices.map(price => this.getLastDigit(price, asset));
        this.tickHistories2[asset] = history.prices.map(price => this.getLastDigit2(price, asset));

        // console.log(`Received tick history for asset: ${asset}. Length: ${this.tickHistories[asset].length}`);
    }

    handleTickUpdate(tick) {
        const asset = tick.symbol;
        const lastDigit = this.getLastDigit(tick.quote, asset);
        const secondToLast = this.getLastDigit2(tick.quote, asset);

        this.lastDigits[asset] = lastDigit;
        this.lastDigits2[asset] = secondToLast;
        
        this.tickHistories[asset].push(lastDigit);

        if (this.tickHistories[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories[asset].shift();
        }

        this.tickHistories2[asset].push(secondToLast);
        this.tickHistories2[asset].push(this.getLastDigit2(tick.quote, asset));
        if (this.tickHistories2[asset].length > this.config.requiredHistoryLength) {
            this.tickHistories2[asset].shift();
        }

        this.digitCounts[asset][lastDigit]++;

        console.log(`[${asset}] ${tick.quote}: ${this.tickHistories[asset].slice(-5).join(', ')}`);
        console.log('Second & Last Digit:', this.lastDigits2[asset], '|', this.lastDigits[asset]);

        if (this.tickHistories[asset].length < this.config.requiredHistoryLength) {
            console.log(`[${asset}] Waiting for more ticks. Current length: ${this.tickHistories[asset].length}`);
            return; 
        }

        if (!this.tradeInProgress && !this.predictionInProgress) {
            this.analyzeTicks(asset);
        }
    }

    
    analyzeTicks(asset) {
        if (this.tradeInProgress) {
            return;
        }

        //Get tick history
        const history = this.tickHistories[asset];
        const secondHistory = this.tickHistories2[asset];
        const history2 = history.slice(-500); // use last 500 ticks for Max & Least Digit analysis

        // Analyze recent pairs of second-to-last vs last digits
        const tickNumber = 5000;
        const recentLast = history;
        const recentSecond = secondHistory;
        const len = Math.min(recentLast.length, recentSecond.length);
        if (len < 2) return; // need at least two ticks to evaluate "previous" vs "current" pattern

        let totalLosses = 0;
        let longestConsecutiveLosses = 0;
        let currentRun = 0;
        let totalConsecutiveLosses = 0; // sum of (runLength - 1) for each run > 1
        let runsGE2 = 0, runsGE3 = 0, runsGE4 = 0, runsGE5 = 0;
        const lossSamples = [];

        // New matching rule:
        // A match at index i (current) is valid if:
        //   previousLast === previousSecond  AND  currentLast === previousLast
        // i.e. previous latestLast equals previous latestSecond, and current latestLast equals previous latestLast
        // start loop at 1 since we reference previous index
        let totalTriggers = 0;
        for (let i = 1; i < len; i++) {
            const prevLast = recentLast[i - 1];
            const prevSecond = recentSecond[i - 1];  // Renamed for clarity
            const currLast = recentLast[i];
            const currSecond = recentSecond[i];

            // apply same exclusions used in single-asset bot against the digit we compare (prevLast)
            if (prevLast === prevSecond && !this.isExcluded.includes(prevLast) && prevLast !== 0) {
                totalTriggers++;
                if (currLast === prevLast) {
                    totalLosses++;
                    currentRun++;
                    if (lossSamples.length < 30) lossSamples.push(`${i}:prev=${prevLast}|sec=${prevSecond}|last=${currLast}`);
                } else {
                if (currentRun > 0) {
                    if (currentRun > 1) totalConsecutiveLosses += (currentRun - 1);
                    if (currentRun >= 2) runsGE2++;
                    if (currentRun >= 3) runsGE3++;
                    if (currentRun >= 4) runsGE4++;
                    if (currentRun >= 5) runsGE5++;
                    if (currentRun > longestConsecutiveLosses) longestConsecutiveLosses = currentRun;
                }
                currentRun = 0;
            }
        }}

        // finalize any run that reached to the end of the buffer
        if (currentRun > 0) {
            if (currentRun > 1) totalConsecutiveLosses += (currentRun - 1);
            if (currentRun >= 2) runsGE2++;
            if (currentRun >= 3) runsGE3++;
            if (currentRun >= 4) runsGE4++;
            if (currentRun >= 5) runsGE5++;
            if (currentRun > longestConsecutiveLosses) longestConsecutiveLosses = currentRun;
        }

        const winCalculation = ((totalTriggers - totalLosses) / 11) * this.currentStake;
        const lossCalculation = (totalLosses * this.currentStake);
        const profitCalculation = (winCalculation - lossCalculation);

        // console.log(`[${asset} Pair Analysis]
        //     samples=${len}
        //     triggers=${totalTriggers}
        //     totalLosses=${totalLosses}
        //     totalConsecutiveLosses=${totalConsecutiveLosses}
        //     2xConsecutive=${runsGE2}
        //     3xConsecutive=${runsGE3}
        //     4xConsecutive=${runsGE4}
        //     5xConsecutive=${runsGE5}
        //     longestConsecutiveLosses=${longestConsecutiveLosses}
        //     winCalc=$${winCalculation.toFixed(2)}
        //     lossCalc=$${lossCalculation.toFixed(2)}
        //     profitCalc=$${profitCalculation.toFixed(2)}
        //     losses=${lossSamples.join(', ')}
        // `);

        console.log(`[${asset} Pair Analysis]
            samples=${len}
            triggers=${totalTriggers}
            totalLosses=${totalLosses}
            longestConsecutiveLosses=${longestConsecutiveLosses}
        `);

        // If we have enough data, place a trade
        const latestLast = history[history.length - 1];
        const latestSecond = secondHistory[secondHistory.length - 1];

        // Add repeat pattern analysis
        const repeatAnalysis = this.analyzeDigitRepeatPatterns(history);
        let highRepeatDigits = []; // Initialize outside the if block
        
        if (repeatAnalysis) {
            console.log(`\n[${asset}] Advanced Repeat Analysis (Overall Repeat: ${repeatAnalysis.overallRepeatProb.toFixed(2)}%):`);
            
            // Sort digits by their individual repeat probability
            const sortedDigits = [...repeatAnalysis.digitStats].sort((a, b) => b.repeatProbability - a.repeatProbability);
                
            // sortedDigits.forEach(d => {
            //     if (d.occurrences > 0) {
            //         console.log(`  Digit ${d.digit}: Repeat Prob: ${d.repeatProbability.toFixed(2)}% | Avg Run: ${d.avgRun.toFixed(2)} | Max Run: ${d.maxRun}`);
            //     }
            // });
            
            // Find digits with unusually high repeat rates (e.g., > 15% or sticky with long runs)
            highRepeatDigits = sortedDigits
                .filter(d => d.repeatProbability > 10 || d.avgRun > 1.1)
                .map(d => d.digit);
                
            if (highRepeatDigits.length > 0) {
                console.log(`⚠️ High repeat/sticky digits: ${highRepeatDigits.join(', ')}`);
            }
        }

        const repeatDigitStats = repeatAnalysis ? repeatAnalysis.digitStats[latestLast] : null;
        console.log(`\n[${asset}] Digit Repeat Analysis (Digit: ${latestLast} | Repeat Prob: ${repeatDigitStats.repeatProbability.toFixed(2)}%)`);

        // Don't analyze suspended assets
        if (this.suspendedAssets.has(asset)) {
            console.log(`Skipping analysis for suspended asset: ${asset}`);
            return;
        }

        // show suspended Digit
        if (this.isExcluded.length > 0) {
            console.log(`Skipped analysis for suspended Digits: [${this.isExcluded}]`);
            // return;
        }

       // Filter Out High Frequency Digits
        const leastDigits = this.getLeastFrequentDigits(history2, 2);
        console.log(`[${asset}] Skipped Least digits: ${leastDigits}`);

        const maxDigits = this.getMaxFrequentDigits(history2, 5);
        console.log(`[${asset}] Skipped Max digits: ${maxDigits}`);

        // If we have more than 3 suspended assets, reactivate the first one
            if (this.suspendedAssets.has(asset) && longestConsecutiveLosses >= 3) {
                this.reactivateAsset.delete(asset);
            }

            // Suspend asset that has x2 losses
            if(longestConsecutiveLosses < 3) {
            this.suspendAsset(asset);
            }
    

        // Prediction logic
        if (latestSecond === latestLast
            && latestLast !== 0
            // && latestLast !== 9
            && !this.isExcluded.includes(latestLast)
            // && longestConsecutiveLosses > 0
            && !this.suspendedAssets.has(asset)
            // && !maxDigits.includes(latestLast)
            && !leastDigits.includes(latestLast)
            // Add repeat pattern conditions
            && repeatAnalysis // Ensure analysis was successful
            && repeatAnalysis.overallRepeatProb < 10 // Trade only if the market isn't overly repetitive 
            && repeatDigitStats.repeatProbability <= 8 // The specific digit's repeat chance is lower than the overall market
            && repeatDigitStats.avgRun < 1.5 // The specific digit is not "sticky"
            && !highRepeatDigits.includes(latestLast) // Double-check it's not in the high-risk list
            ) {

            // Place trade using existing placeTrade(asset, predictedDigit)
            console.log(`\n🎯 ${asset} - PREDICTING DIGIT ${latestLast} (placing trade)`);
            this.placeTrade(asset, latestLast);
        }
    }

    // Add this new method to your EnhancedDigitDifferTradingBot class
    analyzeDigitRepeatPatterns(history) {
        if (!history || history.length < 2) {
            return null;
        }

        const n = history.length;
        const transitionCounts = Array(10).fill(0).map(() => Array(10).fill(0));
        const digitOccurrences = Array(10).fill(0);
        const runStats = Array(10).fill(0).map(() => ({
            runs: 0,
            totalLength: 0,
            maxRun: 0
        }));

        let currentRunDigit = -1;
        let currentRunLength = 0;

        // First pass: Build transition matrix and analyze runs
        for (let i = 0; i < n; i++) {
            const currentDigit = history[i];

            // Transition analysis (from previous to current)
            if (i > 0) {
                const prevDigit = history[i - 1];
                transitionCounts[prevDigit][currentDigit]++;
                digitOccurrences[prevDigit]++;
            }

            // Run length analysis
            if (currentDigit === currentRunDigit) {
                currentRunLength++;
            } else {
                // End of a run, record stats for the previous run
                if (currentRunDigit !== -1) {
                    runStats[currentRunDigit].runs++;
                    runStats[currentRunDigit].totalLength += currentRunLength;
                    if (currentRunLength > runStats[currentRunDigit].maxRun) {
                        runStats[currentRunDigit].maxRun = currentRunLength;
                    }
                }
                // Start of a new run
                currentRunDigit = currentDigit;
                currentRunLength = 1;
            }
        }

        // Record the very last run in the history
        if (currentRunDigit !== -1) {
            runStats[currentRunDigit].runs++;
            runStats[currentRunDigit].totalLength += currentRunLength;
            if (currentRunLength > runStats[currentRunDigit].maxRun) {
                runStats[currentRunDigit].maxRun = currentRunLength;
            }
        }
        // Add the final digit's occurrence to the count
        if (n > 0) {
            digitOccurrences[history[n - 1]]++;
        }

        // Calculate probabilities and final stats
        let totalRepeats = 0;
        const digitStats = Array(10).fill(0).map((_, digit) => {
            const occurrences = digitOccurrences[digit];
            const repeats = transitionCounts[digit][digit];
            totalRepeats += repeats;

            const rs = runStats[digit];

            return {
                digit,
                occurrences,
                repeats,
                // P(digit | digit) - Probability of this digit repeating
                repeatProbability: occurrences > 0 ? (repeats / occurrences) * 100 : 0,
                // Average length of a consecutive streak of this digit
                avgRun: rs.runs > 0 ? rs.totalLength / rs.runs : 0,
                maxRun: rs.maxRun,
            };
        });

        const overallRepeatProb = (n > 1) ? (totalRepeats / (n - 1)) * 100 : 0;

        return {
            overallRepeatProb,
            digitStats,
            sampleSize: n,
        };
    }

    getLeastFrequentDigits(history, topN) {
        const counts = Array(10).fill(0);
        history.forEach(d => counts[d]++);
        return counts.map((c, d) => ({ d, c })).sort((a, b) => a.c - b.c).slice(0, topN).map(item => item.d);
    }

    getMaxFrequentDigits(history, topN) {
        const counts = Array(10).fill(0);
        history.forEach(d => counts[d]++);
        return counts.map((c, d) => ({ d, c })).sort((a, b) => b.c - a.c).slice(0, topN).map(item => item.d);
    }


    placeTrade(asset, predictedDigit) {
        if (this.tradeInProgress) {
            return;
        }
       
        this.tradeInProgress = true;

        console.log(`[${asset}] 🚀 Placing trade for digit: ${predictedDigit} | Stake: ${this.currentStake.toFixed(2)}`);
        const request = {
            buy: 1,
            price: this.currentStake, 
            parameters: {
                amount: this.currentStake,
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: predictedDigit.toString(),
            }
        };
        this.sendRequest(request);
    }

    subscribeToOpenContract(contractId) {
        const request = {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1
        };
        this.sendRequest(request);
    }

    handleContractUpdate(contract) {
        if (contract.is_sold) {
            this.handleTradeResult(contract);
        }
    }

    handleTradeResult(contract) {
        const asset = contract.underlying;
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);
        
        console.log(`[${asset}] Trade outcome: ${won ? '✅ WON' : '❌ LOST'}`);

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;
            // If this asset was suspended, reactivate it on win
            // if (this.suspendedAssets.length > 2) {
            //     this.reactivateAsset.delete(asset[0]);
            // }

            //Remove earliest suspended Digit
            if (this.isExcluded.length > 1) {
                console.log('Re-activated', 'Digit', this.isExcluded[0])
                this.isExcluded.delete([0]);
            }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.consecutiveLosses === 2) this.consecutiveLosses2++;
            else if (this.consecutiveLosses === 3) this.consecutiveLosses3++;
            else if (this.consecutiveLosses === 4) this.consecutiveLosses4++;
            else if (this.consecutiveLosses === 5) this.consecutiveLosses5++;

            // Suspend the asset after a loss
            // this.suspendAsset(asset);

            this.isExcluded.push(this.xDigit);
            console.log('Suspended', 'Digit', this.xDigit)

            // If suspended digit reaches 3, shift the oldest one out on win
            // if (this.isExcluded.length > 9) {
            //     this.isExcluded = [];
            //     console.log('Resetting', this.isExcluded, 'Array')
            //     this.isExcluded.push(this.xDigit);
            // }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }  

        this.totalProfitLoss += profit;	
        this.todayPnL += profit;	
        this.Pause = true;

        const randomWaitTime = Math.floor(Math.random() * (this.config.maxWaitTime - this.config.minWaitTime + 1)) + this.config.minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000);

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        if (!won) {
            this.sendLossEmail(asset);
        }

        this.logTradingSummary(asset);
        
        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses || this.totalProfitLoss <= -this.config.stopLoss) {
            console.log('Stop condition reached. Stopping trading.');
            this.disconnect();
            return;
        }

        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.sendEmailSummary();
            this.disconnect();
            return;
        }

        this.unsubscribeAllTicks();

        if (!this.endOfDay) {               
            setTimeout(() => {
                this.tradeInProgress = false;
                this.Pause = false;
                this.initializeSubscriptions();
            }, randomWaitTime);
        }
    }

    // Add new method to handle asset suspension
    suspendAsset(asset) {
        this.suspendedAssets.add(asset);
        console.log(`🚫 Suspended asset: ${asset}`);
    }

    // Add new method to reactivate asset
    reactivateAsset(asset) {
        this.suspendedAssets.delete(asset);
        console.log(`✅ Reactivated asset: ${asset}`);
    }

    unsubscribeAllTicks() {
        Object.values(this.tickSubscriptionIds).forEach(subId => {
            const request = {
                forget: subId
            };
            this.sendRequest(request);
            // console.log(`Unsubscribing from ticks with ID: ${subId}`);
        });
        this.tickSubscriptionIds = {};
    }

    // Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        // Set start time when first connecting
        if (!this.startTime) {
            this.startTime = new Date();
            console.log(`Bot started at: ${this.startTime.toLocaleTimeString()}`);
        }

        setInterval(() => {
            const now = new Date();
            const elapsedHours = (now - this.startTime) / (1000 * 60 * 60); // Convert to hours

            // Check if 2 hours have elapsed
            // if (elapsedHours >= 2 && this.isWinTrade) {
            //     console.log(`2 hours of trading completed. Started at ${this.startTime.toLocaleTimeString()}, stopping now at ${now.toLocaleTimeString()}`);
            //     this.Pause = true;
            //     this.unsubscribeAllTicks();
            //     this.disconnect();
            //     this.endOfDay = true;
            //     return;
            // }

            // Optional: Log remaining time every interval
            if (!this.endOfDay) {
                const remainingMins = Math.max(0, 120 - (elapsedHours * 60));
                // console.log(`Time remaining: ${remainingMins.toFixed(0)} minutes`);
            }

            // Reset for next day
            // const currentHours = now.getHours();
            // const currentMinutes = now.getMinutes();

            // if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
            //     console.log("It's 8:00 AM, reconnecting the bot for a new session.");
            //     this.startTime = new Date(); // Reset start time
            //     this.assets.forEach(asset => {
            //         this.lastPredictions[asset] = [];
            //     });
            //     this.Pause = false;
            //     this.endOfDay = false;
            //     this.connect();
            // }
        }, 20000); // Check every 20 seconds
    }
    

    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary(asset) {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`x4 Losses: ${this.consecutiveLosses4}`);
        console.log(`x5 Losses: ${this.consecutiveLosses5}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`[${asset}] Predicted Digit: ${this.xDigit}`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`); 
        console.log(`Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}`);
        console.log(`Waiting for: ${this.waitTime} minutes (${this.waitSeconds} ms) before resubscribing...`);
    }
    
    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                this.sendEmailSummary();
            }, 1800000); // 30 minutes
        }
    }

    async sendEmailSummary() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const summaryText = `
        Trading Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Currently Suspended Assets: ${Array.from(this.suspendedAssets).join(', ') || 'None'}

        Current Stake: $${this.currentStake.toFixed(2)}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'n-n Multi_Asset_Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail(asset) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const history = this.tickHistories[asset];
        const lastFewTicks = history.slice(-20);

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        x4 Losses: ${this.consecutiveLosses4}
        x5 Losses: ${this.consecutiveLosses5}

        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${asset}
        Predicted Digit: ${this.predictedDigits[asset]}
        Last Digit: ${this.xDigit}
        
        Last 20 Digits: ${lastFewTicks.join(', ')}

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} minutes before next trade...
        `;      

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'n-n Multi_Asset_Bot - Loss Alert',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Loss email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending loss email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'n-n Multi_Asset_Bot - Error Report',
            text: `An error occurred: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Error email sent:', info.messageId);
        } catch (error) {
            // console.error('Error sending error email:', error);
        }
    }

    start() {
        this.connect();
        this.checkTimeForDisconnectReconnect();
    }
}

// Usage
const bot = new EnhancedDigitDifferTradingBot('0P94g4WdSrSrzir', {
    initialStake: 10.5,
    multiplier: 11.3,
    maxConsecutiveLosses: 1, 
    stopLoss: 89,
    takeProfit: 1,
    requiredHistoryLength: 5000,
    winProbabilityThreshold: 100,
    minWaitTime: 1000,
    maxWaitTime: 1000,
    minOccurrencesThreshold: 1,
});

bot.start();