const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const axios = require('axios');
const OpenAI = require('openai');

class EnhancedDerivTradingBot {
    constructor(token, config = {}) {
        this.token = token;
        // Support multiple OpenRouter API keys
        this.openRouterApiKeys = config.openRouterApiKeys || [config.openRouterApiKey];
        this.currentApiKeyIndex = 0;
        this.ws = null;
        this.connected = false;
        this.assets = [
            //  'R_10', 'RDBULL', 'R_25', 'R_50', 'RDBEAR', 'R_75', 'R_100'
            'R_50'
        ];

        // Initialize OpenAI client with OpenRouter configuration
        this.setOpenAIClient();

        // Trading strategy parameters
        this.minimumTicksRequired = 20;
        this.tradeReadyThreshold = 60;

        this.config = {
            initialStake: config.initialStake,
            multiplier: config.multiplier,
            maxConsecutiveLosses: config.maxConsecutiveLosses,
            stopLoss: config.stopLoss,
            takeProfit: config.takeProfit,
        };

        // Rest of your existing constructor properties
        this.currentStake = this.config.initialStake;
        this.usedAssets = new Set();
        this.consecutiveLosses = 0;
        this.currentAsset = null;
        this.currentTradeId = null;
        this.lastDigitsList = [];
        this.digitCounts = Array(10).fill(0);
        this.tickSubscriptionId = null;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.consecutiveLosses2 = 0;
        this.consecutiveLosses3 = 0;
        this.totalProfitLoss = 0;
        this.tradeInProgress = false;
        this.wsReady = false;
        this.tickHistory = [];
        this.requiredHistoryLength = 500;
        this.tradeThreshold = 5;
        this.winProbabilityThreshold = 95;
        this.predictedDigit = null;
        this.endOfDay = false;
        this.kProfitCount = 0;
        this.kWins = 0;
        this.winProbNumber2 = 0;
        this.digitFrequency2 = 0;
        this.SYS = 1;
        this.SYSCount = 0;
        this.SYSCountReset = 0;
        this.previousPredictions = [];
        this.predictionOutcomes = [];
        this.previousPredictions2 = [];
        this.predictionOutcomes2 = [];
        this.winningPatterns = new Map();
        this.lastPrediction = null;
        this.lastPredictionOutcome = null;
        this.kWinCount = 6;
        this.kLosses = 0;
        this.waitTime = 0;
        this.waitSeconds = 0;
        this.RestartTrading = true;
        this.isWinTrade = false;
        this.predictionInProgress = false;
        this.lastDigit = null;
        this.lastFewTicks = [];

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
        this.maxReconnectAttempts = 10000;
        this.reconnectInterval = 5000;
        this.Pause = false;
    }

    setOpenAIClient() {
        this.openai = new OpenAI({
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: this.openRouterApiKeys[this.currentApiKeyIndex],
            defaultHeaders: {
                "HTTP-Referer": "https://github.com/yourusername/deriv-trading-bot",
                "X-Title": "Deriv Trading Bot",
            },
        });
    }

    cycleApiKey() {
        if (this.openRouterApiKeys.length > 1) {
            this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.openRouterApiKeys.length;
            this.setOpenAIClient();
            console.log(`Switched to OpenRouter API key #${this.currentApiKeyIndex + 1}`);
        }
    }

    connect() {
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

    sendRequest(request) {
        if (this.connected && this.wsReady) {
            this.ws.send(JSON.stringify(request));
        } else if (this.connected && !this.wsReady) {
            console.log('WebSocket not ready. Queueing request...');
            setTimeout(() => this.sendRequest(request), this.reconnectInterval);
        } else {
            console.error('Not connected to Deriv API. Unable to send request:', request);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
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
                setTimeout(() => this.startTrading(), 60000); // Wait for 1 minute before retrying
                break;
            case 'MarketIsClosed':
                console.log('Market is closed. Waiting for market to open...');
                setTimeout(() => this.startTrading(), 3600000); // Wait for 1 hour before retrying
                break;
            default:
                console.log('Encountered an error. Continuing operation...');
                this.startTrading();
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
            count: this.requiredHistoryLength,
            end: 'latest',
            start: 1,
            style: 'ticks'
        };
        this.sendRequest(request);
        console.log(`Requested tick history for asset: ${asset}`);
    }

    subscribeToTicks(asset) {
        const request = {
            ticks: asset,
            subscribe: 1
        };
        this.sendRequest(request);
        // console.log(`Subscribed to ticks for asset: ${asset}`);
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
            this.lastDigitsList = [];
            this.tickHistory = [];
            this.digitCounts = Array(10).fill(0);
            this.startTrading();

        } else if (message.msg_type === 'history') {
            this.handleTickHistory(message.history);
        } else if (message.msg_type === 'tick') {
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
            console.log('Successfully unsubscribed from ticks');
            this.tickSubscriptionId = null;
        } else if (message.subscription && message.msg_type === 'tick') {
            this.tickSubscriptionId = message.subscription.id;
            console.log(`Subscribed to ticks. Subscription ID: ${this.tickSubscriptionId}`);
        } else if (message.error) {
            this.handleApiError(message.error);
        }
    }

    getLastDigit(quote, asset) {
        const quoteString = quote.toString();
        const [, fractionalPart = ''] = quoteString.split('.');

        if (['RDBULL', 'RDBEAR', 'R_75', 'R_50'].includes(asset)) {
            return fractionalPart.length >= 4 ? parseInt(fractionalPart[3]) : 0;
        } else if (['R_10', 'R_25'].includes(asset)) {
            return fractionalPart.length >= 3 ? parseInt(fractionalPart[2]) : 0;
        } else {
            return fractionalPart.length >= 2 ? parseInt(fractionalPart[1]) : 0;
        }
    }

    startTrading() {
        console.log('Starting trading...');
        this.tradeNextAsset();
    }

    tradeNextAsset() {
        if (this.usedAssets.size === this.assets.length) {
            this.usedAssets = new Set();
        }

        if (this.RestartTrading) {
            let availableAssets = this.assets.filter(asset => !this.usedAssets.has(asset));
            this.currentAsset = availableAssets[Math.floor(Math.random() * availableAssets.length)];
            this.usedAssets.add(this.currentAsset);
        }
        console.log(`Selected asset: ${this.currentAsset}`);

        this.unsubscribeFromTicks(() => {
            this.subscribeToTickHistory(this.currentAsset);
            this.subscribeToTicks(this.currentAsset);
        });

        this.RestartTrading = false;
    }

    handleTickHistory(history) {
        this.tickHistory = history.prices.map(price => this.getLastDigit(price, this.currentAsset));
        // console.log(`Received tick history. Length: ${this.tickHistory.length}`);

    }

    handleTickUpdate(tick) {
        const lastDigit = this.getLastDigit(tick.quote, this.currentAsset);
        this.lastDigitsList.push(lastDigit);
        this.lastDigit = lastDigit;

        this.tickHistory.push(lastDigit);
        if (this.tickHistory.length > this.requiredHistoryLength) {
            this.tickHistory.shift();
        }

        this.digitCounts[lastDigit]++;

        if (!this.tradeInProgress && !this.predictionInProgress) {
            this.analyzeTicks();
        }

        console.log(`Received tick history: ${this.tickHistory.length}`);
        console.log(`Received tick: ${this.currentAsset}=>  ${tick.quote} (Last digit: ${lastDigit})`);
    }

    // Deepseek AI Predictor Methods
    async predictBestDigit(tickHistory) {

        if (!this.tradeInProgress) {

            let retryCount = 0;
            const maxRetries = 5;
            const baseDelay = 2000; // 2 seconds

            while (retryCount < maxRetries) {
                try {
                    const recentDigits = tickHistory.slice(-300);

                    const currentTime = new Date().toISOString();

                    console.log('Current Time:', currentTime);


                    const previousOutcomesString = this.previousPredictions && this.predictionOutcomes ?
                        this.previousPredictions.map((pred, index) =>
                            `${pred}: ${this.predictionOutcomes[index] ? 'won' : 'lost'}`
                        ).join(", ") : "No previous predictions";

                    const prompt = `
                    You are an expert trading AI engaged in Deriv Digit Differ prediction against a self-learning, adaptive algorithm system, with full responsibility for prediction.

                    ADVERSARIAL CONTEXT:
                    - You are trading against an intelligent system that learns from your prediction patterns
                    - The opposing system actively tries to break your models and cause losses
                    - It adapts its digit generation to exploit your previous successful strategies
                    - You must continuously evolve your analysis and prediction methods

                    Input Data:
                    - Recent tick data (last 300 digits): [${recentDigits.join(', ')}]
                    - Last prediction: ${this.lastPrediction || 'None'}
                    - Previous predictions and outcomes: ${previousOutcomesString}
                    - Digits observed after last prediction: ${this.lastFewTicks.length > 0 ? this.lastFewTicks.join(', ') : 'None'}
                    - Consecutive losses: ${this.consecutiveLosses}
                    - Current time: ${new Date().toISOString()}
                    - Expected processing delay: ~4-8 seconds (2-4 additional ticks)

                    MULTI-DIMENSIONAL ANALYSIS FRAMEWORK:

                    1. **Odd/Even Sequence Analysis**:
                    - Examine odd/even patterns in last 50, 100, 200 digits
                    - Identify breaking points where patterns reverse
                    - Detect if system is forcing alternations or clusters

                    2. **High/Low Digit Distribution**:
                    - High digits (5-9) vs Low digits (0-4) ratios
                    - Recent shifts in high/low dominance
                    - Momentum analysis for range preferences

                    3. **Individual Digit Representation**:
                    - Over/under-representation relative to statistical norms (10% each)
                    - Digits showing unusual absence or excess
                    - Compensation patterns following over/under-representation

                    4. **Trend and Reversal Detection**:
                    - Identify established trends in recent 20-50 digits
                    - Spot potential reversal signals
                    - Detect artificial trend breaks (adversarial interventions)

                    5. **Advanced Pattern Recognition**:
                    - Consecutive digit relationships and sequences
                    - Cyclical patterns and their disruption points
                    - Mathematical progressions or anti-progressions
                    - Digit clustering vs distribution behaviors

                    6. **Meta-Analysis (Anti-Adversarial)**:
                    - Analyze which previous successful strategies may now be compromised
                    - Identify if the system is creating false patterns to trap your logic
                    - Detect unusual randomness indicating adaptive counter-measures
                    - Look for signs the system is deliberately avoiding your predicted digits

                    7. **Novel Adaptive Approaches**:
                    - Weight recent data more heavily than older data
                    - Employ chaos theory principles for highly volatile sequences

                    EXECUTION CONSIDERATIONS:
                    - Factor in 2-4 second delay and potential system responses
                    - To avoid consecutive losses consider that a loss might trigger more aggressive counter-measures from the system
                    - Account for slippage and execution delays in high-volatility periods

                    Output Format (JSON only):
                    {"predictedDigit": X, "confidence": XX, "primaryStrategy": "Main analysis method used"}

                    Where:
                    - predictedDigit: digit (0-9) or null if skipping
                    - confidence: 0-100
                    - primaryStrategy: main analysis method used
                    `;

                    console.log('Sending request to OpenRouter API...');
                    const completion = await this.openai.chat.completions.create({
                        // model: "deepseek/deepseek-r1:free",
                        model: "moonshotai/kimi-dev-72b:free",

                        messages: [
                            {
                                role: "system",
                                content: "You are an expert Deriv sythentic Index Differ trading AI engaged in adversarial prediction against a self-learning, adaptive algorithm system, with full responsibility for prediction. You must respond with only valid JSON with no additional text or explanation."
                            },
                            {
                                role: "user",
                                content: prompt
                            }
                        ],
                        temperature: 0.1,
                        max_tokens: 150,
                        response_format: { type: "json_object" }
                    });

                    const aiResponse = completion.choices[0].message.content;
                    // console.log('Raw AI Response:', aiResponse);

                    if (!aiResponse) {
                        throw new Error('Empty response from AI');
                    }

                    let prediction;
                    try {
                        // First try to parse the response directly
                        prediction = JSON.parse(aiResponse);
                    } catch (parseError) {
                        // console.log('Direct JSON parse failed, attempting to extract JSON from response');
                        // If direct parse fails, try to extract JSON from the response
                        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
                        if (!jsonMatch) {
                            throw new Error('No valid JSON found in response');
                        }
                        prediction = JSON.parse(jsonMatch[0]);
                    }

                    // Validate the prediction structure
                    if (!prediction || typeof prediction !== 'object') {
                        throw new Error('Invalid prediction: not an object');
                    }

                    if (typeof prediction.predictedDigit !== 'number' ||
                        prediction.predictedDigit < 0 ||
                        prediction.predictedDigit > 9) {
                        throw new Error('Invalid prediction: predictedDigit must be a number between 0 and 9');
                    }

                    if (typeof prediction.confidence !== 'number' ||
                        prediction.confidence < 0 ||
                        prediction.confidence > 100) {
                        throw new Error('Invalid prediction: confidence must be a number between 0 and 100');
                    }

                    console.log('Successfully parsed prediction:', prediction);
                    return prediction;

                } catch (error) {
                    console.error(`Attempt ${retryCount + 1} failed:`, error.message);
                    retryCount++;

                    if (retryCount < maxRetries) {
                        // Calculate exponential backoff with jitter
                        const delay = Math.min(baseDelay * Math.pow(2, retryCount - 1) * (0.8 + Math.random() * 0.4), 30000);
                        console.log(`Retrying in ${Math.round(delay / 1000)} seconds...`);

                        // Cycle to the next API key before retrying
                        this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.openRouterApiKeys.length;
                        this.setOpenAIClient();
                        console.log(`Switched to OpenRouter API key #${this.currentApiKeyIndex + 1}`);
                        // Wait before retrying
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        console.error('Max retries reached. Giving up.');
                        this.Pause = true;
                        this.disconnect();
                        // return null;
                    }
                }
            }
            return null;
        }
    }

    //Analysis
    async analyzeTicks() {
        if (this.tradeInProgress || this.predictionInProgress) {
            return; // Don't start a new prediction if one is already in progress
        }

        try {

            this.predictionInProgress = true;

            const tickHistory2 = this.tickHistory.slice(-200);

            const digitCounts = Array(10).fill(0);
            tickHistory2.forEach(digit => digitCounts[digit]++);

            let leastOccurringDigit = 0;
            let minCount = Infinity;
            digitCounts.forEach((count, digit) => {
                if (count < minCount) {
                    minCount = count;
                    leastOccurringDigit = digit;
                }
            });

            const leastPercentage = ((minCount / this.requiredHistoryLength) * 100).toFixed(2);
            console.log(`Digit counts:`, digitCounts);
            console.log(`Least Occuring Digit:`, leastOccurringDigit);

            //Measure AI processing time
            const startTime = Date.now();

            // Call the AI and wait for response
            console.log('Requesting AI prediction...');
            const prediction = await this.predictBestDigit(this.tickHistory);
            const endTime = Date.now();
            const processingTime = (endTime - startTime) / 1000; // Convert to seconds

            console.log(`AI processing time: ${processingTime} seconds`);

            if (processingTime > 6) {
                console.error('AI processing time exceeded 4 seconds, skipping trade.');
                this.predictionInProgress = false;
                this.RestartTrading = true;
                return;
            }

            if (!prediction || prediction.skipTrade) {
                console.log('AI recommends skipping this trade.');
                this.predictionInProgress = false;
                this.RestartTrading = true;
                return;
            }

            // Explicitly convert winProbability and predictedDigit to numbers
            const winProbNumber = prediction.confidence;
            const predictedDigitNumber = prediction.predictedDigit;

            this.predictedDigit = predictedDigitNumber;
            this.winProbNumber2 = winProbNumber;

            if (winProbNumber > 65) {
                this.predictionStrategy = prediction.primaryStrategy;
                this.lastPrediction = this.predictedDigit;
                this.placeTrade(this.predictedDigit, this.winProbNumber2);
            } else {
                console.error('Confidence too low, restarting Bot!');
                this.predictionInProgress = false;
                this.RestartTrading = true;
                // this.disconnect();
            }

        } catch (error) {
            console.error('Error in analyzeTicks:', error.message);
            this.Pause = true;
            this.disconnect();
        }
    }


    placeTrade(predictedDigit, winProbNumber2) {
        if (this.tradeInProgress) {
            // console.log('Trade already in progress. Skipping...');
            return;
        }

        this.tradeInProgress = true;
        console.log(`Placing trade for digit: ${predictedDigit}(${winProbNumber2}%) Stake: ${this.currentStake}`);
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
                symbol: this.currentAsset,
                barrier: predictedDigit,
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
        const won = contract.status === 'won';
        const profit = parseFloat(contract.profit);

        console.log(`Trade outcome: ${won ? 'Won' : 'Lost'}`);

        // Update AI feedback system
        if (this.lastPrediction !== null) {
            this.previousPredictions.push(this.lastPrediction);
            this.predictionOutcomes.push(won);

            this.previousPredictions2.push(this.lastPrediction);
            this.predictionOutcomes2.push(won);

            // Keep only last 20 predictions for logging
            if (this.previousPredictions2.length > 20) {
                this.previousPredictions2.shift();
                this.predictionOutcomes2.shift();
            }

            // Keep only last 20 predictions for analysis
            if (this.previousPredictions.length > 1000) {
                this.previousPredictions.shift();
                this.predictionOutcomes.shift();
            }

            // Include previous prediction outcomes in the prompt
            const previousOutcomes = this.previousPredictions.map((pred, index) =>
                `${pred}: ${this.predictionOutcomes[index] ? 'won' : 'lost'}`
            ).join(", ");

            // Include previous prediction outcomes2 in the prompt
            const previousOutcomes2 = this.previousPredictions2.map((pred, index) =>
                `${pred}: ${this.predictionOutcomes2[index] ? 'won' : 'lost'}`
            ).join(", ");

            console.log(`Previous Predictions: ${previousOutcomes2}`)

            // Update winning patterns database
            if (won) {
                const pattern = this.tickHistory.slice(-5).join('');
                this.winningPatterns.set(
                    pattern,
                    (this.winningPatterns.get(pattern) || 0) + 1
                );
            }
        }

        this.totalTrades++;
        if (won) {
            this.totalWins++;
            this.isWinTrade = true;
            this.consecutiveLosses = 0;
            this.currentStake = this.config.initialStake;

        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            this.isWinTrade = false;

            if (this.consecutiveLosses === 2) {
                this.consecutiveLosses2++;
            } else if (this.consecutiveLosses === 3) {
                this.consecutiveLosses3++;
            }

            this.currentStake = Math.ceil(this.currentStake * this.config.multiplier * 100) / 100;
        }

        this.totalProfitLoss += profit;

        this.RestartTrading = true;


        const minWaitTime = 600 * 1000; // 1 Second in milliseconds 120
        const maxWaitTime = 2000 * 1000; // 2 seconds in milliseconds 600
        const randomWaitTime = Math.floor(Math.random() * (maxWaitTime - minWaitTime + 1)) + minWaitTime;
        const waitTimeMinutes = Math.round(randomWaitTime / 60000); // Convert to minutes for logging

        this.waitTime = waitTimeMinutes;
        this.waitSeconds = randomWaitTime;

        this.sendLossEmail();

        this.logTradingSummary();

        this.Pause = true;

        // Switch to the next API key after every trade
        // this.cycleApiKey();

        if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('Max consecutive losses reached. Stopping trading.');
            this.disconnect();
            return;
        }
        // if (this.totalProfitLoss <= -this.config.stopLoss) {
        //     console.log('Max consecutive losses reached. Stopping trading.');
        //     this.disconnect();
        //     return;
        // }

        if (this.totalProfitLoss >= this.takeProfit) {
            console.log('Take Profit Reached... Stopping trading.');
            this.disconnect();
            return;
        }


        this.disconnect();


        if (!this.endOfDay) {
            setTimeout(() => {
                this.Pause = false;
                this.connect();
            }, randomWaitTime);
        }

    }

    unsubscribeFromTicks(callback) {
        if (this.tickSubscriptionId) {
            const request = {
                forget: this.tickSubscriptionId
            };
            this.sendRequest(request);
            console.log(`Unsubscribing from ticks with ID: ${this.tickSubscriptionId}`);

            this.ws.once('message', (data) => {
                const message = JSON.parse(data);
                if (message.msg_type === 'forget' && message.forget === this.tickSubscriptionId) {
                    console.log(`Unsubscribed from ticks successfully`);
                    this.tickSubscriptionId = null;
                    if (callback) callback();
                }
            });
        } else {
            if (callback) callback();
        }
    }

    //Check for Disconnect and Reconnect
    checkTimeForDisconnectReconnect() {
        setInterval(() => {
            const now = new Date();
            const currentHours = now.getHours();
            const currentMinutes = now.getMinutes();

            // Check for morning resume condition (8:00 AM)
            if (this.endOfDay && currentHours === 8 && currentMinutes >= 0) {
                console.log("It's 8:00 AM, reconnecting the bot.");
                this.LossDigitsList = [];
                // this.tradeInProgress = false;
                this.usedAssets = new Set();
                this.RestartTrading = true;
                this.Pause = false;
                this.endOfDay = false;
                this.connect();
            }

            // Check for evening stop condition (after 8:00 PM)
            if (this.isWinTrade && !this.endOfDay) {
                if (currentHours >= 20 && currentMinutes >= 0) {
                    console.log("It's past 8:00 PM after a win trade, disconnecting the bot.");
                    this.sendDisconnectResumptionEmailSummary();
                    this.Pause = true;
                    this.disconnect();
                    this.endOfDay = true;
                }
            }
        }, 20000); // Check every 20 seconds
    }


    disconnect() {
        if (this.connected) {
            this.ws.close();
        }
    }

    logTradingSummary() {
        console.log('Trading Summary:');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Total Trades Won: ${this.totalWins}`);
        console.log(`Total Trades Lost: ${this.totalLosses}`);
        console.log(`x2 Losses: ${this.consecutiveLosses2}`);
        console.log(`x3 Losses: ${this.consecutiveLosses3}`);
        console.log(`Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}`);
        console.log(`Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%`);
        console.log(`predictedDigit: ${this.lastPrediction}`);
        console.log(`winProbNumber: ${this.winProbNumber2} %`);
        console.log(`Current Stake: $${this.currentStake.toFixed(2)}`);
        console.log(`Waiting for: ${this.waitTime} (${this.waitSeconds}) minutes before reconnecting to trade the next asset...`);
    }

    startEmailTimer() {
        if (!this.endOfDay) {
            setInterval(() => {
                //this.sendEmailSummary();
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
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%
        `;

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'DeepseekAIPredictor_Differ Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendLossEmail() {
        const transporter = nodemailer.createTransport(this.emailConfig);

        this.lastFewTicks = this.tickHistory.slice(-3)

        const summaryText = `
        Trade Summary:
        Total Trades: ${this.totalTrades}
        Total Trades Won: ${this.totalWins}
        Total Trades Lost: ${this.totalLosses}
        x2 Losses: ${this.consecutiveLosses2}
        x3 Losses: ${this.consecutiveLosses3}
        Total Profit/Loss Amount: ${this.totalProfitLoss.toFixed(2)}
        Win Rate: ${((this.totalWins / this.totalTrades) * 100).toFixed(2)}%

        Last Digit Analysis:
        Asset: ${this.currentAsset}
        predictedDigit: ${this.lastPrediction}
        winProbNumber: ${this.winProbNumber2}%
        Prediction Strategy: ${this.predictionStrategy}
        Last 10 Digits: ${this.tickHistory.slice(-10)}

        Current Stake: $${this.currentStake.toFixed(2)}

        Waiting for: ${this.waitTime} (${this.waitSeconds}) minutes before reconnecting to trade the next asset...
        `;


        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'DeepseekAIPredictor_Differ Bot - Summary',
            text: summaryText
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            // console.log('Email sent successfully:', info.messageId);
        } catch (error) {
            // console.error('Error sending email:', error);
        }
    }

    async sendErrorEmail(errorMessage) {
        const transporter = nodemailer.createTransport(this.emailConfig);

        const mailOptions = {
            from: this.emailConfig.auth.user,
            to: this.emailRecipient,
            subject: 'DeepseekAIPredictor_Differ Bot - Error Report',
            text: `An error occurred in the trading bot: ${errorMessage}`
        };

        try {
            const info = await transporter.sendMail(mailOptions);
            console.log('Error email sent successfully:', info.messageId);
        } catch (error) {
            console.error('Error sending error email:', error);
        }
    }

    start() {
        this.connect();
        // this.checkTimeForDisconnectReconnect(); // Automatically handles disconnect/reconnect at specified times
    }
}

// Usage
const bot = new EnhancedDerivTradingBot('0P94g4WdSrSrzir', {
    openRouterApiKeys: [
        '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',
        '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',
        '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',
        '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',
        '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',
        // Add One or more keys as needed
    ],
    initialStake: 5,
    multiplier: 11.3,
    maxStake: 278,
    maxConsecutiveLosses: 3,
    stopLoss: 670,
    takeProfit: 250,
});

// Create and start the bot
console.log("🚀 Starting Deepseek AI Enhanced Trading Bot (via OpenRouter)...");
console.log("🤖 This bot will use Deepseek AI for immediate predictions and trading");

bot.start();

