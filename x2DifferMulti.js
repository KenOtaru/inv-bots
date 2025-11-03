const WebSocket = require('ws');
const nodemailer = require('nodemailer');

class QuantumInspiredDerivBot {
    constructor(token, config = {}) {
        this.token = token;
        this.ws = null;
        this.connected = false;
        this.assets = [
            // 'R_50', 'R_100', 'R_25', 'R_75', 'R_10', 'RDBULL', 'RDBEAR'
            'RDBULL', 'R_50', 'R_100', 'R_75',
        ];

        this.config = {
            initialStake: config.initialStake || 3,
            multiplier: config.multiplier || 11.3,
            maxConsecutiveLosses: config.maxConsecutiveLosses || 3,
            takeProfit: config.takeProfit || 40,
        };

        // Memory limits to prevent crashes
        this.memoryLimits = {
            maxArrayLength: 100,
            maxMapSize: 50,
            maxHistoryLength: this.requiredHistoryLength,
            cleanupInterval: 30000,
            analysisThrottle: 2000,
        };

        // Initialize quantum states with memory management
        this.quantumStates = {};
        this.assets.forEach(asset => {
            this.quantumStates[asset] = this.createAssetState();
        });

        // Global state management
        this.globalConsecutiveLosses = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.totalProfitLoss = 0;
        this.activeContracts = new Map();
        this.Pause = false;
        this.endOfDay = false;
        this.requiredHistoryLength = 100; // Minimum ticks before trading
        this.consensusNum = 4;
        
        // Simplified global adversarial state
        this.globalAdversarial = {
            systemExploits: [],
            successfulStrategies: [],
            failedStrategies: [],
            currentExploit: null
        };

        // Simplified configuration
        this.uniqueConfig = {
            minDataBeforeTrade: 150
        };

        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10000;
        this.wsReady = false;
        this.subscriptionQueue = [];
        this.isProcessingQueue = false;

        // Email configuration
        this.emailConfig = {
            service: 'gmail',
            auth: {
                user: 'kenzkdp2@gmail.com',
                pass: 'jfjhtmussgfpbgpk'
            }
        };
        this.emailRecipient = 'kenotaru@gmail.com';
        
        // Start cleanup timer
        this.startMemoryCleanup();
        this.startEmailTimer();
    }

    createAssetState() {
        return {
            // Standard tracking
            currentStake: this.config.initialStake,
            tickHistory: [],
            tradeInProgress: false,
            currentTradeId: null,
            tickSubscriptionId: null,
            isActive: false,
            lastTradeTime: 0,
            lastAnalysisTime: 0,
            
            // Analysis state
            analysisCache: {
                lastUpdate: 0,
                quantum: null,
                antiAlgorithm: null,
                chaos: null,
                swarm: null,
                gameTheory: null,
                contrarian: null,
                metaLearning: null
            },
            
            // Swarm state (properly initialized)
            swarm: {
                particles: Array(5).fill(null).map(() => ({
                    position: Math.floor(Math.random() * 10),
                    velocity: (Math.random() - 0.5) * 2,
                    fitness: 0,
                    bestPosition: null,
                    bestFitness: 0
                })),
                globalBest: null,
                convergence: 0
            },
            
            // Pattern tracking for meta-learning
            patternHistory: [],
            breakHistory: []
        };
    }

    // Memory cleanup function
    startMemoryCleanup() {
        setInterval(() => {
            this.cleanupMemory();
        }, this.memoryLimits.cleanupInterval);
    }

    cleanupMemory() {
        try {
            this.assets.forEach(asset => {
                const state = this.quantumStates[asset];
                
                if (state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                    state.tickHistory = state.tickHistory.slice(-this.memoryLimits.maxHistoryLength);
                }
                
                if (state.patternHistory.length > 50) {
                    state.patternHistory = state.patternHistory.slice(-50);
                }
                
                if (state.breakHistory.length > 50) {
                    state.breakHistory = state.breakHistory.slice(-50);
                }
            });

            if (this.globalAdversarial.successfulStrategies.length > this.memoryLimits.maxArrayLength) {
                this.globalAdversarial.successfulStrategies = 
                    this.globalAdversarial.successfulStrategies.slice(-this.memoryLimits.maxArrayLength);
            }

            if (this.globalAdversarial.failedStrategies.length > this.memoryLimits.maxArrayLength) {
                this.globalAdversarial.failedStrategies = 
                    this.globalAdversarial.failedStrategies.slice(-this.memoryLimits.maxArrayLength);
            }

            if (global.gc) {
                global.gc();
            }
        } catch (error) {
            console.error('Memory cleanup error:', error);
        }
    }

    // ============= FIXED QUANTUM METHOD =============
    measureQuantumProbability(asset) {
        const state = this.quantumStates[asset];
        const history = state.tickHistory.slice(-this.requiredHistoryLength);
        if (!history || history.length < 40) return null;

        const N = history.length;
        const currentDigit = history[N - 1];

        const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

        // 1) Conditional no-repeat statistics when previous == currentDigit
        let prevCount = 0;
        let noRepeatAfterPrev = 0;
        for (let i = 1; i < N; i++) {
            if (history[i - 1] === currentDigit) {
                prevCount++;
                if (history[i] !== currentDigit) noRepeatAfterPrev++;
            }
        }
        const noRepeatProb = prevCount ? noRepeatAfterPrev / prevCount : 0.5; // empirical P(next != digit | prev==digit)

        // 2) Sample confidence (more occurrences => more trust)
        const sampleTrust = clamp(Math.log10(prevCount + 1) / 2, 0, 1);

        // 3) Recent-window agreement (short vs long)
        const shortWindow = history.slice(-20);
        const longWindow = history.slice(-100);
        const shortStats = { total: 0, noRepeat: 0 };
        const longStats = { total: 0, noRepeat: 0 };
        for (let i = 1; i < shortWindow.length; i++) {
            if (shortWindow[i - 1] === currentDigit) {
                shortStats.total++;
                if (shortWindow[i] !== currentDigit) shortStats.noRepeat++;
            }
        }
        for (let i = 1; i < longWindow.length; i++) {
            if (longWindow[i - 1] === currentDigit) {
                longStats.total++;
                if (longWindow[i] !== currentDigit) longStats.noRepeat++;
            }
        }
        const shortNoRepeat = shortStats.total ? shortStats.noRepeat / shortStats.total : noRepeatProb;
        const longNoRepeat = longStats.total ? longStats.noRepeat / longStats.total : noRepeatProb;
        const agreement = 1 - clamp(Math.abs(shortNoRepeat - longNoRepeat) * 2, 0, 1);

        // 4) Setup exploitation detection (double/triple setups that often lead to repeats)
        let setups = 0, setupsFollowedByRepeat = 0;
        for (let i = 2; i < N; i++) {
            // double of same digit immediately before i
            if (history[i - 2] === history[i - 1]) {
                setups++;
                if (history[i] === history[i - 1]) setupsFollowedByRepeat++;
            }
        }
        const setupPrecision = setups ? setupsFollowedByRepeat / setups : 0.28; // how often setups lead to repeat (bad for differ)

        // 5) Honeypot / tail streak detection
        let tailStreak = 0;
        for (let i = N - 1; i >= 0 && history[i] === currentDigit; i--) tailStreak++;
        const honeypotFactor = tailStreak >= 2 ? clamp((tailStreak - 1) / 6, 0, 1) : 0;

        // 6) Overdue analysis (if digit hasn't appeared for long relative to its avg gap -> increases chance to appear)
        const positions = [];
        for (let i = 0; i < N; i++) if (history[i] === currentDigit) positions.push(i);
        let avgGap = 20;
        if (positions.length > 1) {
            const gaps = [];
            for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
            avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        }
        const lastPos = positions.length ? positions[positions.length - 1] : -1;
        const timeSinceLast = lastPos === -1 ? N : (N - 1) - lastPos;
        const overdueFactor = clamp((timeSinceLast / Math.max(1, avgGap)) - 1, 0, 2); // >0 means overdue (riskier for differ)

        // 7) Recent "differ" loss simulation (how often differ lost recently across any digit)
        const recent = history.slice(-20);
        let recentTrades = 0, recentLosses = 0;
        for (let i = 1; i < recent.length; i++) {
            recentTrades++;
            if (recent[i] === recent[i - 1]) recentLosses++;
        }
        const recentLossRate = recentTrades ? recentLosses / recentTrades : 0.25;

        // 8) Compose trap likelihood (0..1). Higher => market is likely trapping differ
        // Trap increases if setups often lead to repeat, honeypot streak exists, overdue increases appearance chance, and differ losing recently.
        const trapRaw =
            0.40 * clamp(setupPrecision, 0, 1) +
            0.25 * honeypotFactor +
            0.20 * clamp(overdueFactor, 0, 1) +
            0.15 * clamp(recentLossRate / 0.5, 0, 1);

        let trapLikelihood = clamp(trapRaw, 0, 1);

        // Penalize trap if historical repeat baseline of current digit is low (less likely to repeat overall)
        const historicalRepeatRate = positions.length > 0 ? (() => {
            let repeats = 0;
            for (let i = 0; i < N - 1; i++) if (history[i] === currentDigit && history[i + 1] === currentDigit) repeats++;
            return repeats / positions.length;
        })() : 0.12;
        trapLikelihood *= (1 - Math.min(0.25, 0.5 * (1 - historicalRepeatRate)));

        trapLikelihood = clamp(trapLikelihood, 0, 1);

        // 9) Expected value model for DIGITDIFF (approximate payout). Tune payoutWin to match real market.
        const payoutWin = 0.095; // approximate payout multiplier for a winning DIGITDIFF
        const winProb = noRepeatProb; // empirical estimate
        const loseProb = 1 - winProb;
        const rawEV = payoutWin * winProb - 1 * loseProb; // per $1 stake

        // Risk adjust EV by trap likelihood and short/long disagreement
        const delta = Math.abs(shortNoRepeat - longNoRepeat);
        const riskAdjustedEV = rawEV * (1 - trapLikelihood) - delta * 0.25 - overdueFactor * 0.12;

        // 10) Confidence: combines sample size, agreement, EV strength and low trapLikelihood
        const sampleFactor = sampleTrust;
        const agreementFactor = agreement;
        const evStrength = clamp((riskAdjustedEV + 1) / 2, 0, 1); // map (-1..1) -> 0..1
        let confidence = 0.40 * sampleFactor + 0.35 * agreementFactor + 0.25 * evStrength;
        // penalize by trap
        confidence = clamp(confidence * (1 - trapLikelihood * 0.9), 0.02, 0.99);

        // 11) Decision rule tuned for digit-differ
        const shouldTrade = (riskAdjustedEV > 0.06 && confidence >= 0.66 && trapLikelihood < 0.12 && sampleTrust > 0.15 && shortStats.total + longStats.total > 3);

        // 12) Useful diagnostics for logging and tuning
        return {
            probability: noRepeatProb,
            shouldTrade,
            confidence,
            predictedDigit: currentDigit,
            rawEV,
            riskAdjustedEV,
            trapLikelihood,
            diagnostics: {
                prevCount,
                sampleTrust,
                shortNoRepeat,
                longNoRepeat,
                agreement,
                setupPrecision,
                tailStreak,
                honeypotFactor,
                avgGap,
                timeSinceLast,
                overdueFactor,
                recentLossRate,
                historicalRepeatRate
            }
        };
    }


    // ============= FIXED SWARM INTELLIGENCE =============
    runSwarmOptimization(asset) {
        const state = this.quantumStates[asset];
        const history = state.tickHistory.slice(-this.requiredHistoryLength);
        if (history.length < 50) return null;
        
        const currentDigit = history[history.length - 1];
        const swarm = state.swarm;
        
        // Fitness function for non-repetition prediction
        const calculateFitness = (position) => {
            if (position < 0 || position > 9) return 0;
            
            let correct = 0;
            let total = 0;
            const checkHistory = history.slice(-Math.min(20, history.length));
            
            for (let i = 1; i < checkHistory.length; i++) {
                if (checkHistory[i-1] === Math.floor(position)) {
                    total++;
                    if (checkHistory[i] !== Math.floor(position)) {
                        correct++;
                    }
                }
            }
            
            return total > 0 ? correct / total : 0.5;
        };
        
        // Update particles
        swarm.particles.forEach((particle, idx) => {
            const fitness = calculateFitness(particle.position);
            particle.fitness = fitness;
            
            // Initialize best position if needed
            if (particle.bestPosition === null) {
                particle.bestPosition = particle.position;
                particle.bestFitness = fitness;
            }
            
            // Update personal best
            if (fitness > particle.bestFitness) {
                particle.bestPosition = particle.position;
                particle.bestFitness = fitness;
            }
            
            // Update global best
            if (!swarm.globalBest || fitness > swarm.globalBest.fitness) {
                swarm.globalBest = {
                    position: particle.position,
                    fitness: fitness
                };
            }
            
            // Update velocity and position
            const inertia = 0.7;
            const cognitive = 1.5;
            const social = 1.5;
            
            if (swarm.globalBest) {
                particle.velocity = 
                    inertia * particle.velocity +
                    cognitive * Math.random() * (particle.bestPosition - particle.position) +
                    social * Math.random() * (swarm.globalBest.position - particle.position);
                
                particle.position = Math.max(0, Math.min(9, 
                    particle.position + particle.velocity * 0.1));
            }
        });
        
        // Calculate convergence based on position variance
        const positions = swarm.particles.map(p => p.position);
        const avgPosition = positions.reduce((a, b) => a + b, 0) / positions.length;
        const positionVariance = positions.reduce((sum, pos) => 
            sum + Math.pow(pos - avgPosition, 2), 0) / positions.length;
        
        swarm.convergence = Math.max(0, 1 - (positionVariance / 25));
        
        // Get current digit fitness
        const currentFitness = calculateFitness(currentDigit);
        const swarmConfidence = Math.min(currentFitness * swarm.convergence, 1);
        
        return {
            shouldTrade: currentFitness >= 0.94 && swarm.convergence >= 0.94,
            confidence: swarmConfidence,
            predictedDigit: currentDigit,
            convergence: swarm.convergence,
            fitness: currentFitness
        };
    }

    // ============= FIXED GAME THEORY =============
    applyGameTheory(asset) {
        const state = this.quantumStates[asset];
        const history = state.tickHistory.slice(-this.requiredHistoryLength);
        if (history.length < 100) return null;
        
        const currentDigit = history[history.length - 1];
        
        // Build payoff statistics
        const stats = {
            repeat: 0,
            noRepeat: 0,
            total: 0
        };
        
        // Analyze recent history
        const recent = history.slice(-Math.min(30, history.length));
        
        for (let i = 1; i < recent.length; i++) {
            if (recent[i-1] === currentDigit) {
                stats.total++;
                if (recent[i] === currentDigit) {
                    stats.repeat++;
                } else {
                    stats.noRepeat++;
                }
            }
        }
        
        if (stats.total < 5) {
            return {
                shouldTrade: false,
                confidence: 0.3
            };
        }
        
        // Calculate probabilities
        const repeatProb = stats.repeat / stats.total;
        const noRepeatProb = stats.noRepeat / stats.total;
        
        // Expected value for non-repetition strategy
        const expectedValue = noRepeatProb - repeatProb;
        
        // Check recent trend (last 20 occurrences)
        let recentCount = 0;
        let recentNoRepeat = 0;
        
        for (let i = recent.length - 20; i < recent.length && i > 0; i++) {
            if (recent[i-1] === currentDigit) {
                recentCount++;
                if (recent[i] !== currentDigit) {
                    recentNoRepeat++;
                }
            }
        }
        
        const recentNoRepeatRate = recentCount > 0 ? recentNoRepeat / recentCount : 0.5;
        
        // Calculate confidence based on consistency and expected value
        let gameConfidence = 0.5;
        
        if (expectedValue > 0.2 && recentNoRepeatRate > 0.6) {
            gameConfidence = Math.min(0.75 + expectedValue * 0.3, 1);
        } else if (expectedValue > 0) {
            gameConfidence = 0.5 + expectedValue * 0.5;
        } else {
            gameConfidence = Math.max(0.3, 0.5 + expectedValue);
        }

        const confidence = Math.min(Math.max(gameConfidence, 0.2), 1);
        
        return {
            shouldTrade: expectedValue > 0.15 && noRepeatProb > 0.65 && confidence >= 0.8 && confidence < 0.99,
            confidence: Math.min(Math.max(gameConfidence, 0.2), 1),
            strategy: 'non-repetition',
            repeatProbability: repeatProb,
            noRepeatProbability: noRepeatProb,
            expectedValue: expectedValue
        };
    }

    // applyGameTheory(asset) {
    //     const state = this.quantumStates[asset];
    //     const history = state.tickHistory.slice(-Math.max(this.requiredHistoryLength, 100));
    //     if (!history || history.length < 80) return null;

    //     const N = history.length;
    //     const currentDigit = history[N - 1];

    //     // Helpers
    //     const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

    //     // Windows
    //     const longWindow = history.slice(-Math.min(N, 100));
    //     const shortWindow = history.slice(-Math.min(N, 20));

    //     // Compute conditional no-repeat / repeat probabilities when previous tick == target
    //     function conditionalRates(arr, target) {
    //         let total = 0, noRepeat = 0, repeat = 0;
    //         for (let i = 1; i < arr.length; i++) {
    //             if (arr[i - 1] === target) {
    //                 total++;
    //                 if (arr[i] !== target) noRepeat++; else repeat++;
    //             }
    //         }
    //         return {
    //             total,
    //             noRepeatProb: total ? noRepeat / total : 0.5,
    //             repeatProb: total ? repeat / total : 0.5
    //         };
    //     }

    //     const longRates = conditionalRates(longWindow, currentDigit);
    //     const shortRates = conditionalRates(shortWindow, currentDigit);

    //     // Recent streak information (how many consecutive currentDigit at the tail)
    //     let streak = 0;
    //     for (let i = N - 1; i >= 0 && history[i] === currentDigit; i--) streak++;

    //     // Setup precision: how often double/triple setups lead to repeat (historical)
    //     let setups = 0, setupsRepeat = 0;
    //     const scanFrom = Math.max(10, Math.floor(N * 0.1));
    //     for (let i = scanFrom; i < N - 1; i++) {
    //         const a = history[i - 2], b = history[i - 1];
    //         if (a === b) { // double/triple setup
    //             setups++;
    //             if (history[i] === b) setupsRepeat++;
    //         }
    //     }
    //     const setupPrecision = setups ? setupsRepeat / setups : 0.3;

    //     // Recent "differ" performance: over last 40 ticks simulate simple differ trades (when previous==digit)
    //     const perfWindow = history.slice(-Math.min(40, N));
    //     let trades = 0, wins = 0;
    //     for (let i = 1; i < perfWindow.length; i++) {
    //         if (perfWindow[i - 1] === currentDigit) {
    //             trades++;
    //             if (perfWindow[i] !== currentDigit) wins++;
    //         }
    //     }
    //     const recentNoRepeat = trades ? wins / trades : shortRates.noRepeatProb;

    //     // Drift detection: short vs long disagreement
    //     const deltaNoRepeat = shortRates.noRepeatProb - longRates.noRepeatProb; // positive means short suggests more no-repeat now
    //     const driftFactor = clamp(Math.abs(deltaNoRepeat) * 3, 0, 1);

    //     // Trap signals:
    //     //  - high setupPrecision followed by low recentNoRepeat => market exploiting setups
    //     //  - strong recent streaks + falling shortRates => honeypot
    //     //  - large negative deltaNoRepeat (short < long) => shift to trap
    //     const trapComponents = [];
    //     trapComponents.push(clamp(setupPrecision, 0, 1));                      // setup exploitation
    //     trapComponents.push(clamp((streak - 1) / 6, 0, 1));                    // streak lure
    //     trapComponents.push(clamp(Math.max(0, longRates.noRepeatProb - shortRates.noRepeatProb) * 3, 0, 1)); // recent drop
    //     // penalize if differ losing recently
    //     const simpleLossFactor = clamp(1 - recentNoRepeat, 0, 1);
    //     trapComponents.push(simpleLossFactor);

    //     // Weighted trap likelihood (weights tuned for digit-differ)
    //     const trapWeights = [0.30, 0.25, 0.30, 0.15];
    //     let trapRaw = 0;
    //     for (let i = 0; i < trapComponents.length; i++) trapRaw += trapComponents[i] * trapWeights[i];
    //     // if historical repeat rate for this digit is low, reduce trap impact slightly
    //     // compute historical repeat rate for target
    //     let occurrences = 0, repeatsAfter = 0;
    //     for (let i = 0; i < N - 1; i++) {
    //         if (history[i] === currentDigit) {
    //             occurrences++;
    //             if (history[i + 1] === currentDigit) repeatsAfter++;
    //         }
    //     }
    //     const histRepeatRate = occurrences ? repeatsAfter / occurrences : 0.12;
    //     trapRaw *= (1 - Math.min(0.25, 0.5 * (1 - histRepeatRate)));
    //     const trapLikelihood = clamp(trapRaw, 0, 1);

    //     // Expected value model for DIGITDIFF:
    //     // assume approximate payout when winning (no-repeat) around 0.095 (calibrated by market), losing costs 1
    //     const payoutWin = 0.095;
    //     const winProb = shortRates.noRepeatProb; // use most recent conditional estimate
    //     const loseProb = 1 - winProb;
    //     const rawEV = payoutWin * winProb - 1 * loseProb; // expectation per $1 stake

    //     // Risk adjust EV by trap likelihood and drift uncertainty
    //     const riskAdjustedEV = rawEV * (1 - trapLikelihood) - Math.abs(deltaNoRepeat) * 0.25;

    //     // Confidence: depends on sample size, agreement between windows, low trapLikelihood, and EV magnitude
    //     const sampleFactor = clamp(Math.log10((shortRates.total || 1) + 1) / 2, 0, 1); // more short samples => better
    //     const agreement = 1 - clamp(Math.abs(deltaNoRepeat) * 2, 0, 1); // 1 means no drift
    //     const evStrength = clamp((riskAdjustedEV + 1) / 2, 0, 1); // map EV (-1..1) to 0..1
    //     let confidence = 0.35 * sampleFactor + 0.45 * agreement + 0.20 * evStrength;
    //     // penalize confidence by trapLikelihood
    //     confidence = clamp(confidence * (1 - trapLikelihood * 0.9), 0.05, 0.99);

    //     // Recommendation rules
    //     const shouldTrade = riskAdjustedEV > 0.06 && confidence > 0.66 && trapLikelihood < 0.15;
    //     const recommendation = shouldTrade ? 'TRADE' :
    //                            (trapLikelihood > 0.6 ? 'AVOID_TRAP' :
    //                             (riskAdjustedEV <= 0.06 ? 'LOW_EV' : 'UNSURE'));

    //     // Return structured diagnostics for logging/tuning
    //     return {
    //         shouldTrade,
    //         recommendation,
    //         confidence: clamp(confidence, 0, 1),
    //         rawEV,
    //         riskAdjustedEV,
    //         trapLikelihood,
    //         diagnostics: {
    //             currentDigit,
    //             streak,
    //             setupPrecision,
    //             longNoRepeat: longRates.noRepeatProb,
    //             shortNoRepeat: shortRates.noRepeatProb,
    //             deltaNoRepeat,
    //             recentNoRepeat,
    //             simpleLossFactor,
    //             histRepeatRate,
    //             shortSamples: shortRates.total,
    //             longSamples: longRates.total,
    //             driftFactor
    //         }
    //     };
    // }

    
    // ============= FIXED CONTRARIAN =============
    performContrarianAnalysis(asset) {
        const state = this.quantumStates[asset];
        const history = state.tickHistory.slice(-Math.max(this.requiredHistoryLength, 250));
        if (!history || history.length < 80) return null;

        const N = history.length;
        const currentDigit = history[N - 1];

        // 1) Basic streak / honeypot detection
        let streak = 0;
        for (let i = N - 1; i >= 0; i--) {
            if (history[i] === currentDigit) streak++; else break;
        }
        const isHoneypot = streak >= 2 && streak <= 4; // classic tempting setup

        // 2) Last appearances & gap statistics for the current digit
        const positions = [];
        for (let i = 0; i < N; i++) {
            if (history[i] === currentDigit) positions.push(i);
        }
        const lastPos = positions.length ? positions[positions.length - 1] : -1;
        const timeSinceLast = lastPos === -1 ? N : (N - 1) - lastPos;
        const gaps = [];
        for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
        const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 10;
        const isOverdue = timeSinceLast > avgGap * 1.6;

        // 3) Setup -> repeat precision (historical)
        // Define "setup" patterns that lure users: double/triple of same digit immediately before a tick
        let setups = 0;
        let setupsFollowedByRepeat = 0;
        // scan older history (ignore very recent window to avoid leakage)
        const scanFrom = Math.max(30, Math.floor(N * 0.2));
        for (let i = scanFrom; i < N - 1; i++) {
            // check for double or triple setups ending at i
            const prev = history[i - 1];
            if (i - 2 >= 0 && history[i - 2] === prev && history[i - 1] === prev) {
                setups++;
                if (history[i] === prev) setupsFollowedByRepeat++;
            } else if (i - 1 >= 0 && history[i - 1] === history[i - 2]) {
                // double detected (redundant guard)
                setups++;
                if (history[i] === history[i - 1]) setupsFollowedByRepeat++;
            }
        }
        const setupPrecision = setups > 0 ? setupsFollowedByRepeat / setups : 0.35; // how often setups repeat

        // 4) Simple differ strategy loss rate (how often "differ" loses recently)
        const recent = history.slice(-20);
        let simpleTrades = 0;
        let simpleLosses = 0;
        for (let i = 1; i < recent.length; i++) {
            simpleTrades++;
            if (recent[i] === recent[i - 1]) simpleLosses++; // differ loses when repeat occurs
        }
        const simpleLossRate = simpleTrades ? simpleLosses / simpleTrades : 0.25;

        // 5) Historical repeat baseline for this digit
        const totalOccurrences = positions.length;
        let repeatsAfterOcc = 0;
        for (let i = 0; i < N - 1; i++) {
            if (history[i] === currentDigit && history[i + 1] === currentDigit) repeatsAfterOcc++;
        }
        const historicalRepeatRate = totalOccurrences ? repeatsAfterOcc / totalOccurrences : 0.12;

        // 6) Combining signals into trap likelihood (contrarian score)
        // weights tuned for digit-differ markets
        const weights = {
            honeypot: 0.32,
            setupPrecision: 0.30,
            overdue: 0.20,
            simpleLoss: 0.18
        };

        // normalize factors to 0..1
        const honeypotFactor = isHoneypot ? Math.min(1, 0.5 + (streak - 2) * 0.18) : 0;
        const setupFactor = setupPrecision; // already 0..1
        const overdueFactor = Math.min(1, Math.max(0, (timeSinceLast / Math.max(avgGap, 1)) - 1)); // 0 when t~avgGap, grows when overdue
        const simpleLossFactor = Math.min(1, simpleLossRate / 0.5); // relative to an extreme 50% loss

        // trap likelihood raw score
        let trapRaw = 0;
        trapRaw += weights.honeypot * honeypotFactor;
        trapRaw += weights.setupPrecision * setupFactor;
        trapRaw += weights.overdue * overdueFactor;
        trapRaw += weights.simpleLoss * simpleLossFactor;

        // penalize when historicalRepeatRate is very low (less chance of repeat)
        trapRaw *= (1 - Math.min(0.25, 0.5 * (1 - historicalRepeatRate)));

        // map to 0..1 and clamp
        const trapLikelihood = Math.max(0, Math.min(1, trapRaw));

        // 7) Confidence scaling and decision thresholding
        // dynamic threshold: if market has been punishing differ recently, be stricter
        const dynamicThreshold = 0.35 + Math.min(0.35, simpleLossRate); // baseline 0.35 -> up to ~0.7
        const isTrap = trapLikelihood > 0.05 || trapLikelihood < 0.015//dynamicThreshold;

        // A contrarian module's shouldTrade = true means "it's safe to place differ" -> return false when trap is present
        const shouldTrade = !isTrap;

        // Provide reasoning breakdown for logging/tuning
        return {
            isTrap,
            shouldTrade,
            confidence: trapLikelihood, // confidence of trap (0..1). high => avoid trading
            metrics: {
                streak,
                isHoneypot,
                setupPrecision,
                setups,
                setupsFollowedByRepeat,
                simpleLossRate,
                historicalRepeatRate,
                timeSinceLast,
                avgGap,
                isOverdue
            },
            reasoning: {
                note: 'High confidence means contrarian (differ) is likely to be trapped. Use shouldTrade=false to avoid.',
                dynamicThreshold
            }
        };
    }

    // ============= FIXED META-LEARNING =============
    // performMetaAnalysis(asset) {
    //     const state = this.quantumStates[asset];
    //     const history = state.tickHistory.slice(-this.requiredHistoryLength);
    //     if (history.length < 100) return null;

    //     const currentDigit = history[history.length - 1];

    //     // Track pattern breaks (non-repetition)
    //     let patternBreaks = 0;
    //     let patternCount = 0;
    //     for (let i = 50; i < history.length; i++) {
    //         const prevDigit = history[i - 1];
    //         // Define a "pattern" as a digit repeating at least twice in the last 5 ticks
    //         const recentSlice = history.slice(i - 5, i);
    //         const digitCount = recentSlice.filter(d => d === prevDigit).length;

    //         if (digitCount >= 2) { // A pattern of repetition was forming
    //             patternCount++;
    //             if (history[i] !== prevDigit) { // The pattern broke
    //                 patternBreaks++;
    //             }
    //         }
    //     }
    //     const breakRate = patternCount > 0 ? patternBreaks / patternCount : 0.5;

    //     // Analyze break timing (time between non-repeating ticks)
    //     const breaks = [];
    //     for (let i = 1; i < history.length; i++) {
    //         if (history[i] !== history[i - 1]) {
    //             breaks.push(i);
    //         }
    //     }

    //     const intervals = [];
    //     if (breaks.length > 1) {
    //         for (let i = 1; i < breaks.length; i++) {
    //             intervals.push(breaks[i] - breaks[i - 1]);
    //         }
    //     }
    //     const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 5;
    //     const lastBreakPosition = breaks.length > 0 ? breaks[breaks.length - 1] : 0;
    //     const timeSinceBreak = history.length - 1 - lastBreakPosition;
    //     const isDueForBreak = timeSinceBreak >= avgInterval * 0.9;

    //     // Detect algorithm "personality" from recent volatility
    //     const recent50 = history.slice(-50);
    //     let changes = 0;
    //     for (let i = 1; i < recent50.length; i++) {
    //         if (recent50[i] !== recent50[i - 1]) changes++;
    //     }
    //     const changeRate = changes / (recent50.length - 1); // Should be 49

    //     // Determine personality and a more dynamic base confidence
    //     let personality = 'balanced';
    //     let baseConfidence = 0.5;
    //     if (breakRate > 0.75) {
    //         personality = 'breaker'; // Frequently breaks repetition patterns
    //         baseConfidence = 0.7;
    //     } else if (changeRate > 0.8) {
    //         personality = 'chaotic'; // High volatility, frequent changes
    //         baseConfidence = 0.65;
    //     } else if (changeRate < 0.4) {
    //         personality = 'stable'; // Low volatility, tends to form streaks
    //         baseConfidence = 0.4; // Lower base confidence for breaking a pattern
    //     }

    //     // Check if a repetition pattern is currently forming
    //     const currentRepeats = history.slice(-5).filter(d => d === currentDigit).length;
    //     const hasPattern = currentRepeats >= 2;

    //     // Calculate final confidence with more granularity
    //     let metaConfidence = baseConfidence;

    //     // Adjust confidence based on confirming factors
    //     if (personality === 'breaker' && hasPattern) {
    //         metaConfidence += 0.15 * breakRate; // Strong signal
    //     } else if (personality === 'chaotic' && hasPattern) {
    //         metaConfidence += 0.1 * changeRate; // Good signal
    //     }
        
    //     if (isDueForBreak && breakRate > 0.6) {
    //         metaConfidence += 0.1; // Add bonus if a break is statistically due
    //     }

    //     // Penalize confidence for weak or conflicting signals
    //     if (!hasPattern) {
    //         metaConfidence -= 0.15; // No pattern to break, so less certainty
    //     }
    //     if (personality === 'stable') {
    //         metaConfidence -= 0.1; // Stable markets are less likely to break
    //     }
    //     if (breakRate < 0.55) {
    //         metaConfidence -= 0.1; // History shows it doesn't break patterns often
    //     }

    //     // Clamp confidence to a realistic range
    //     metaConfidence = Math.max(0.2, Math.min(metaConfidence, 0.95));

    //     // The goal is to trade when a break is likely
    //     const shouldBreak = (personality === 'breaker' && hasPattern && breakRate > 0.7) ||
    //                       (personality === 'chaotic' && hasPattern && isDueForBreak) ||
    //                       (isDueForBreak && breakRate > 0.8);

    //     return {
    //         shouldTrade: shouldBreak,
    //         confidence: metaConfidence,
    //         personality: personality,
    //         breakRate: breakRate,
    //         isDueForBreak: isDueForBreak,
    //         changeRate: changeRate
    //     };
    // }
    
    performMetaAnalysis(asset) {
        const state = this.quantumStates[asset];
        const history = state.tickHistory.slice(-this.requiredHistoryLength);
        if (history.length < 50) return null;

        const currentDigit = history[history.length - 1];

        // Track pattern breaks (non-repetition) over a larger window
        let patternBreaks = 0;
        let patternCount = 0;
        for (let i = 50; i < history.length; i++) {
            const prevDigit = history[i - 1];
            const recentSlice = history.slice(Math.max(0, i - 5), i);
            const digitCount = recentSlice.filter(d => d === prevDigit).length;

            if (digitCount >= 2) { // A repetition pattern forming
                patternCount++;
                if (history[i] !== prevDigit) { // pattern broke
                    patternBreaks++;
                }
            }
        }
        const breakRate = patternCount > 0 ? patternBreaks / patternCount : 0.5;

        // Analyze break timing (time between non-repeating ticks)
        const breaks = [];
        for (let i = 1; i < history.length; i++) {
            if (history[i] !== history[i - 1]) {
                breaks.push(i);
            }
        }

        const intervals = [];
        if (breaks.length > 1) {
            for (let i = 1; i < breaks.length; i++) {
                intervals.push(breaks[i] - breaks[i - 1]);
            }
        }
        const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 5;
        const lastBreakPosition = breaks.length > 0 ? breaks[breaks.length - 1] : 0;
        const timeSinceBreak = history.length - 1 - lastBreakPosition;
        const isDueForBreak = timeSinceBreak >= avgInterval * 0.9;

        // Recent volatility & change rate
        const recent50 = history.slice(-50);
        let changes = 0;
        for (let i = 1; i < recent50.length; i++) {
            if (recent50[i] !== recent50[i - 1]) changes++;
        }
        const changeRate = recent50.length > 1 ? changes / (recent50.length - 1) : 0;

        // Personality detection (simplified)
        let personality = 'balanced';
        if (breakRate > 0.72) {
            personality = 'breaker';
        } else if (changeRate > 0.75) {
            personality = 'chaotic';
        } else if (changeRate < 0.35) {
            personality = 'stable';
        }

        // Check if a repetition pattern is currently forming for current digit
        const currentRepeats = history.slice(-5).filter(d => d === currentDigit).length;
        const hasPattern = currentRepeats >= 2;

        // Pattern strength: proportion of recent windows (sliding) where repetition forms
        let patternStrength = 0;
        const windowSize = 8;
        let windows = 0;
        let windowsWithPattern = 0;
        for (let i = Math.max(0, history.length - 150); i <= history.length - windowSize; i++) {
            windows++;
            const w = history.slice(i, i + windowSize);
            // repetition pattern if any digit repeats at least twice in the window consecutively or frequently
            const maxCount = Math.max(...Array.from({ length: 10 }, (_, d) => w.filter(x => x === d).length));
            if (maxCount >= 3) windowsWithPattern++;
        }
        if (windows > 0) patternStrength = windowsWithPattern / windows;

        // Streak length for current digit
        let streak = 1;
        for (let i = history.length - 2; i >= 0 && history[i] === currentDigit; i--) {
            streak++;
        }

        // Weighted confidence model (tunable weights)
        const weights = {
            breakRate: 0.40,       // evidence that patterns break historically
            patternStrength: 0.20, // strong repeating formations (makes breaks meaningful)
            isDueForBreak: 0.15,   // recency-based due signal
            changeRate: 0.15,      // volatility increases chance to break
            streakPenalty: 0.10    // ongoing streak reduces chance to break
        };

        // Base confidence depends on personality
        let baseConfidence = 0.45;
        if (personality === 'breaker') baseConfidence = 0.55;
        if (personality === 'chaotic') baseConfidence = 0.50;
        if (personality === 'stable') baseConfidence = 0.38;

        // Compose score
        let score = baseConfidence;
        score += (breakRate - 0.5) * weights.breakRate; // center breakRate at 0.5
        score += (patternStrength - 0.2) * weights.patternStrength; // small baseline
        score += (isDueForBreak ? 1 : 0) * weights.isDueForBreak;
        score += (changeRate - 0.5) * weights.changeRate;
        // penalty for active streaks: longer streak -> lower chance of immediate break
        score -= Math.min(streak / 6, 1) * weights.streakPenalty;

        // If we don't actually have a repeating pattern, reduce expectation
        if (!hasPattern) {
            score -= 0.12;
        }

        // If personality is stable, penalize more
        if (personality === 'stable') {
            score -= 0.08;
        }

        // Apply small smoothing towards 0.5 to avoid extreme swings from sparse data
        const smoothing = 0.06;
        score = score * (1 - smoothing) + 0.5 * smoothing;

        // Final clamp
        const metaConfidence = Math.max(0.2, Math.min(score, 0.95));

        // Decision rule (tunable)
        const shouldBreak = metaConfidence > 0.90//(metaConfidence > 0.70 && hasPattern && breakRate > 0.6) ||
                            // (metaConfidence > 0.80 && isDueForBreak) ||
                            // (personality === 'breaker' && metaConfidence > 0.65 && hasPattern);

        return {
            shouldTrade: shouldBreak,
            confidence: metaConfidence,
            personality: personality,
            breakRate: breakRate,
            isDueForBreak: isDueForBreak,
            changeRate: changeRate,
            patternStrength: patternStrength,
            streak: streak,
            baseConfidence: baseConfidence,
            windowsChecked: windows,
            windowsWithPattern: windowsWithPattern
        };
    }


    // ============= FIXED CHAOS THEORY =============
    applyChaosTheory(asset) {
        const state = this.quantumStates[asset];
        const history = state.tickHistory.slice(-this.requiredHistoryLength);
        if (history.length < 50) return null;
        
        const currentDigit = history[history.length - 1];
        
        // Calculate entropy windows
        const windowSize = 50;
        const windows = [];
        
        for (let i = 0; i <= history.length - windowSize; i += 10) {
            const window = history.slice(i, i + windowSize);
            const uniqueDigits = new Set(window).size;
            windows.push(uniqueDigits / 10);
        }
        
        if (windows.length === 0) return null;
        
        // Calculate chaos metrics
        const avgEntropy = windows.reduce((a, b) => a + b, 0) / windows.length;
        const variance = windows.reduce((sum, val) => 
            sum + Math.pow(val - avgEntropy, 2), 0) / windows.length;
        
        // Sensitivity analysis
        const recent30 = history.slice(-Math.min(20, history.length));
        let changes = 0;
        for (let i = 1; i < recent30.length; i++) {
            if (recent30[i] !== recent30[i-1]) changes++;
        }
        
        const changeRate = changes / (recent30.length - 1);
        const chaosLevel = (variance + changeRate) / 2;
        
        const inChaos = chaosLevel > 0.5 && avgEntropy > 0.6;
        const chaosConfidence = inChaos ? Math.min(chaosLevel * 0.8, 1) : 0.3;
        
        return {
            inChaoticRegime: inChaos,
            chaosLevel: chaosLevel,
            shouldTrade: !inChaos && chaosLevel < 0.45,
            confidence: chaosConfidence,
            prediction: currentDigit
        };
    }

    // applyChaosTheory(asset) {
    // const state = this.quantumStates[asset];
    // const history = state.tickHistory.slice(-this.requiredHistoryLength);
    // if (!history || history.length < 80) return null; // need enough data

    // const currentDigit = history[history.length - 1];

    // // --- Helpers ---
    // const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

    // // Shannon entropy normalized to [0,1] for digits 0..9
    // const shannonEntropyNorm = (arr) => {
    //     const counts = Array(10).fill(0);
    //     arr.forEach(d => { if (Number.isInteger(d) && d >= 0 && d <= 9) counts[d]++; });
    //     const N = arr.length || 1;
    //     let H = 0;
    //     counts.forEach(c => {
    //         if (c > 0) {
    //             const p = c / N;
    //             H -= p * Math.log2(p);
    //         }
    //     });
    //     return H / Math.log2(10); // normalize by log2(10)
    // };

    // // Permutation entropy (order d) normalized
    // const permutationEntropy = (seq, order = 3) => {
    //     if (seq.length < order) return 0;
    //     const patterns = new Map();
    //     for (let i = 0; i <= seq.length - order; i++) {
    //         const window = seq.slice(i, i + order);
    //         // rank pattern
    //         const ranks = window
    //             .map((v, idx) => ({ v, idx }))
    //             .sort((a, b) => (a.v - b.v) || (a.idx - b.idx))
    //             .map(x => x.idx)
    //             .join(',');
    //         patterns.set(ranks, (patterns.get(ranks) || 0) + 1);
    //     }
    //     const M = seq.length - order + 1;
    //     let H = 0;
    //     for (const count of patterns.values()) {
    //         const p = count / M;
    //         H -= p * Math.log2(p);
    //     }
    //     // normalize by log2(factorial(order))
    //     const factorial = n => n <= 1 ? 1 : n * factorial(n - 1);
    //     return H / Math.log2(factorial(order));
    // };

    // // Simple Lyapunov-like estimator using embedding and nearest neighbors divergence
    // const estimateLyapunov = (seq, emb = 3, tau = 1, maxPairs = 300, maxSteps = 6) => {
    //     if (seq.length < emb * tau + maxSteps) return 0;
    //     // build vectors
    //     const vectors = [];
    //     for (let i = 0; i <= seq.length - (emb * tau); i++) {
    //         const v = [];
    //         for (let j = 0; j < emb; j++) v.push(seq[i + j * tau]);
    //         vectors.push({ idx: i, v });
    //     }
    //     const L = vectors.length;
    //     let totalSlope = 0;
    //     let pairs = 0;
    //     for (let i = 0; i < L && pairs < maxPairs; i++) {
    //         // find nearest neighbor j with separation > emb*tau
    //         let bestDist = Infinity;
    //         let bestIdx = -1;
    //         for (let j = 0; j < L; j++) {
    //             if (Math.abs(vectors[i].idx - vectors[j].idx) <= emb * tau) continue;
    //             // Euclidean distance
    //             let d = 0;
    //             for (let k = 0; k < emb; k++) d += Math.pow(vectors[i].v[k] - vectors[j].v[k], 2);
    //             d = Math.sqrt(d);
    //             if (d > 0 && d < bestDist) {
    //                 bestDist = d;
    //                 bestIdx = j;
    //             }
    //         }
    //         if (bestIdx === -1 || !isFinite(bestDist) || bestDist === 0) continue;
    //         // track divergence over next steps
    //         let sumLog = 0;
    //         let validSteps = 0;
    //         for (let s = 1; s <= maxSteps; s++) {
    //             const iNext = vectors[i].idx + s;
    //             const jNext = vectors[bestIdx].idx + s;
    //             if (iNext + emb * tau - 1 >= seq.length || jNext + emb * tau - 1 >= seq.length) break;
    //             // build next vectors
    //             const vi = [];
    //             const vj = [];
    //             for (let k = 0; k < emb; k++) {
    //                 vi.push(seq[iNext + k * tau]);
    //                 vj.push(seq[jNext + k * tau]);
    //             }
    //             let dNext = 0;
    //             for (let k = 0; k < emb; k++) dNext += Math.pow(vi[k] - vj[k], 2);
    //             dNext = Math.sqrt(dNext);
    //             if (dNext <= 0) continue;
    //             sumLog += Math.log(dNext / bestDist);
    //             validSteps++;
    //         }
    //         if (validSteps > 0) {
    //             const slope = sumLog / validSteps;
    //             totalSlope += slope;
    //             pairs++;
    //         }
    //     }
    //     if (pairs === 0) return 0;
    //     // average slope per step -> approximate lyapunov exponent (natural log base)
    //     const avgSlope = totalSlope / pairs;
    //     // map to a reasonable scale (most meaningful if > 0)
    //     return avgSlope;
    // };

    // // Autocorrelation lag-1
    // const autocorrLag1 = (arr) => {
    //     const N = arr.length;
    //     const mean = arr.reduce((a,b)=>a+b,0)/N;
    //     let num = 0, den = 0;
    //     for (let i = 0; i < N - 1; i++) num += (arr[i] - mean)*(arr[i+1] - mean);
    //     for (let i = 0; i < N; i++) den += Math.pow(arr[i] - mean, 2);
    //     return den === 0 ? 0 : num/den;
    // };

    // // --- Compute metrics ---
    // // sliding Shannon entropy windows
    // const winSize = 40;
    // const step = 8;
    // const entropies = [];
    // for (let i = 0; i <= history.length - winSize; i += step) {
    //     entropies.push(shannonEntropyNorm(history.slice(i, i + winSize)));
    // }
    // const avgEntropy = entropies.length ? entropies.reduce((a,b)=>a+b,0)/entropies.length : 0;
    // const varEntropy = entropies.length ? entropies.reduce((s,v)=>s+Math.pow(v-avgEntropy,2),0)/entropies.length : 0;

    // const permEnt = permutationEntropy(history.slice(-60), 3); // normalized 0..1

    // const lyap = estimateLyapunov(history.map(x => x/9), 3, 1, 250, 6); // normalize digits to 0..1

    // const ac1 = autocorrLag1(history.slice(-60));

    // // Normalize lyapunov into 0..1 score: positive -> stronger chaotic signal
    // let lyapScore = 0.5;
    // if (isFinite(lyap)) {
    //     // typical positive chaotic lyapunov near 0..1, scale conservatively
    //     lyapScore = clamp((lyap + 0.5) / 1.5, 0, 1);
    // }

    // const autocorrScore = clamp(1 - Math.abs(ac1), 0, 1); // lower autocorr -> higher chaos score

    // // Compose chaos score (weights tunable)
    // const weights = {
    //     avgEntropy: 0.35,
    //     permEnt: 0.30,
    //     lyap: 0.25,
    //     autocorr: 0.10
    // };

    // const chaosScore = clamp(
    //     avgEntropy * weights.avgEntropy +
    //     permEnt * weights.permEnt +
    //     lyapScore * weights.lyap +
    //     autocorrScore * weights.autocorr,
    //     0, 1
    // );

    // const inChaos = chaosScore > 0.60 || (lyap > 0.01 && avgEntropy > 0.55);
    // const confidence = clamp(chaosScore * 0.95 + 0.05, 0.0, 0.99);

    // // Recommend trading only when NOT in chaotic regime (safer)
    // const shouldTrade = !inChaos && chaosScore < 0.45;

    // return {
    //     inChaoticRegime: inChaos,
    //     chaosScore,
    //     confidence,
    //     avgEntropy,
    //     permEntropy: permEnt,
    //     lyapunovEstimate: lyap,
    //     lyapScore,
    //     autocorrLag1: ac1,
    //     shouldTrade,
    //     prediction: currentDigit,
    //     windowsChecked: entropies.length,
    //     entropyVariance: varEntropy
    // };
    // }


    // Main analysis method for each asset
    async analyzeAsset(asset) {
        const state = this.quantumStates[asset];
        const now = Date.now();
        
        // Throttle analysis
        if (now - state.lastAnalysisTime < this.memoryLimits.analysisThrottle) return;
        state.lastAnalysisTime = now;
        
        // Check conditions
        if (now - state.lastTradeTime < 10000) return; // 10 second cooling
        if (state.tradeInProgress || this.shouldStopTrading()) return;
        
        // Make decision
        const decision = this.measureQuantumProbability(asset);
        const decision2 = this.runSwarmOptimization(asset);
        const decision3 = this.applyGameTheory(asset); 
        const decision4 = this.performContrarianAnalysis(asset); 
        const decision5 = this.performMetaAnalysis(asset);
        const decision6 = this.applyChaosTheory(asset);


        console.log(` ${asset} Analysis:`);
         console.log(`Active Analyses: 
            Should Trade: ${decision6.shouldTrade} : ${decision.shouldTrade} : ${decision2.shouldTrade} : ${decision3.shouldTrade} : ${decision4.shouldTrade} : ${decision5.shouldTrade}
            `);

        // Final decision - require consensus
         const consensus = [decision.shouldTrade, decision2.shouldTrade, decision3.shouldTrade, decision4.shouldTrade, decision5.shouldTrade, decision6.shouldTrade].filter(Boolean).length >= this.consensusNum;
         console.log('Consensus:', consensus ? 'Achieved' : 'Not Achieved');
        if (consensus) {
            console.log(`Active Analyses: `);
            console.log(`n${asset} Tick: [${state.tickHistory.slice(-10).join(',')}]`);

            console.log(`\n🎯 ${asset} - SIGNAL DETECTED!`);
            console.log(`Confidence: ${(decision.confidence * 100).toFixed(2)}%`);
            const currentDigit = state.tickHistory[state.tickHistory.length - 1];
            state.lastTradeTime = now;
            this.placeTrade(asset, currentDigit);
        }
    }

    // Connection methods
    connect() {
        try {
            console.log('Initializing Quantum-Inspired Trading System...');
            this.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

            this.ws.on('open', () => {
                console.log('Connected to Deriv API');
                this.connected = true;
                this.wsReady = true;
                this.reconnectAttempts = 0;
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Message parsing error:', error);
                }
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
        } catch (error) {
            console.error('Connection error:', error);
            this.handleDisconnect();
        }
    }

    sendRequest(request, priority = false) {
        try {
            if (this.connected && this.wsReady) {
                const jitter = priority ? 0 : Math.random() * 200;
                
                setTimeout(() => {
                    if (this.connected && this.wsReady) {
                        this.ws.send(JSON.stringify(request));
                    }
                }, jitter);
            }
        } catch (error) {
            console.error('Send request error:', error);
        }
    }

    handleDisconnect() {
        this.connected = false;
        this.wsReady = false;
        
        this.assets.forEach(asset => {
            this.quantumStates[asset].isActive = false;
        });
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            console.log(`Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            const backoff = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts), 60000);
            setTimeout(() => this.connect(), backoff);
            this.reconnectAttempts++;
        }
    }

    handleApiError(error) {
        console.error('API Error:', error.message);
        
        switch (error.code) {
            case 'InvalidToken':
                console.error('Invalid token.');
                this.disconnect();
                break;
            case 'RateLimit':
                console.log('Rate limit detected - adjusting...');
                setTimeout(() => this.processSubscriptionQueue(), 10000);
                break;
            case 'MarketIsClosed':
                console.log('Market closed.');
                setTimeout(() => this.startTrading(), 3600000);
                break;
            default:
                console.log('Error encountered.');
        }
    }

    authenticate() {
        console.log('Authenticating...');
        this.sendRequest({
            authorize: this.token
        }, true);
    }

    async subscribeToAsset(asset) {
        return new Promise((resolve) => {
            const delay = Math.random() * 3000 + 2000;
            
            // setTimeout(() => {
                const historyRequest = {
                    ticks_history: asset,
                    adjust_start_time: 1,
                    count: this.memoryLimits.maxHistoryLength,
                    end: 'latest',
                    start: 1,
                    style: 'ticks'
                };
                
                this.sendRequest(historyRequest);
                console.log(`📊 Scanning ${asset}...`);
                
                // setTimeout(() => {
                    const tickRequest = {
                        ticks: asset,
                        subscribe: 1
                    };
                    
                    this.sendRequest(tickRequest);
                    console.log(`📡 Connected to ${asset}`);
                    
                    this.quantumStates[asset].isActive = true;
                    resolve();
                // }, 2000);
            // }, delay);
        });
    }

    async processSubscriptionQueue() {
        if (this.isProcessingQueue || this.subscriptionQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        // Limit to 7 assets for memory management
        const limitedAssets = this.subscriptionQueue.slice(0, 7);
        
        for (const asset of limitedAssets) {
            if (!this.quantumStates[asset].isActive) {
                await this.subscribeToAsset(asset);
                await new Promise(resolve => setTimeout(resolve, 7000));
            }
        }
        
        this.isProcessingQueue = false;
    }

    startTrading() {
        console.log('\n🚀 QUANTUM TRADING SYSTEM INITIALIZED');
        console.log('═══════════════════════════════════════\n');
        
        this.assets.forEach(asset => {
            const state = this.quantumStates[asset];
            state.tickHistory = [];
            state.tradeInProgress = false;
        });
        
        // Limit to 7 random assets
        const shuffled = [...this.assets].sort(() => Math.random() - 0.5);
        this.subscriptionQueue = shuffled.slice(0, 7);
        console.log('Trading assets:', this.subscriptionQueue.join(', '));
        
        this.processSubscriptionQueue();
    }

    handleMessage(message) {
        try {
            if (message.msg_type === 'authorize') {
                if (message.error) {
                    console.error('Authentication failed:', message.error.message);
                    this.disconnect();
                    return;
                }
                console.log('✅ Authentication successful');
                this.startTrading();

            } else if (message.msg_type === 'history') {
                this.handleTickHistory(message);
            } else if (message.msg_type === 'tick') {
                this.handleTickUpdate(message);
            } else if (message.msg_type === 'buy') {
                this.handleBuyResponse(message);
            } else if (message.msg_type === 'proposal_open_contract') {
                if (message.error) {
                    console.error('Contract error:', message.error.message);
                    return;
                }
                this.handleContractUpdate(message.proposal_open_contract);
            } else if (message.msg_type === 'forget') {
                console.log('Unsubscribed from tick stream');
            } else if (message.error) {
                this.handleApiError(message.error);
            }
        } catch (error) {
            console.error('Message handling error:', error);
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

    handleTickHistory(message) {
        try {
            let asset = null;
            if (message.echo_req && message.echo_req.ticks_history) {
                asset = message.echo_req.ticks_history;
            }

            if (asset && this.quantumStates[asset]) {
                const state = this.quantumStates[asset];
                state.tickHistory = message.history.prices.slice(-this.memoryLimits.maxHistoryLength).map(price => 
                    this.getLastDigit(price, asset)
                );
                
                console.log(`📊 ${asset}: Loaded ${state.tickHistory.length} data points`);
            }
        } catch (error) {
            console.error('Tick history error:', error);
        }
    }

    handleTickUpdate(message) {
        try {
            const tick = message.tick;
            const asset = tick.symbol;

            if (!this.quantumStates[asset] || !this.quantumStates[asset].isActive) return;

            const state = this.quantumStates[asset];
            const lastDigit = this.getLastDigit(tick.quote, asset);
            
            state.tickHistory.push(lastDigit);
            
            // Maintain rolling window
            if (state.tickHistory.length > this.memoryLimits.maxHistoryLength) {
                state.tickHistory.shift();
            }

            if (message.subscription && !state.tickSubscriptionId) {
                state.tickSubscriptionId = message.subscription.id;
            }

            if (state.tradeInProgress) {
            console.log(`${asset} Tick: [${state.tickHistory.slice(-10).join(',')}]`);
            } else {
                // console.log(`${asset} Tick: ${tick.quote} (${lastDigit})`);
                // console.log(`${asset} Tick: [${state.tickHistory.slice(-10).join(',')}]`);
            }
            
            // Analyze after sufficient data
            if (!state.tradeInProgress && state.tickHistory.length >= this.uniqueConfig.minDataBeforeTrade) {
                this.analyzeAsset(asset);
            }
        } catch (error) {
            console.error('Tick update error:', error);
        }
    }

    placeTrade(asset, predictedDigit) {
        const state = this.quantumStates[asset];
        
        if (state.tradeInProgress || this.shouldStopTrading()) return;

        state.tradeInProgress = true;
        
        console.log(`💰 ${asset} - EXECUTING TRADE`);
        console.log(`Barrier: ${predictedDigit}`);
        console.log(`Stake: $${state.currentStake.toFixed(2)}`);
        
        const request = {
            buy: 1,
            price: state.currentStake.toFixed(2),
            parameters: {
                amount: state.currentStake.toFixed(2),
                basis: 'stake',
                contract_type: 'DIGITDIFF',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: asset,
                barrier: predictedDigit
            }
        };
        
        this.sendRequest(request);
    }

    handleBuyResponse(message) {
        try {
            if (message.error) {
                console.error('Trade error:', message.error.message);
                
                if (message.echo_req && message.echo_req.parameters) {
                    const asset = message.echo_req.parameters.symbol;
                    if (this.quantumStates[asset]) {
                        this.quantumStates[asset].tradeInProgress = false;
                    }
                }
                return;
            }

            const contractId = message.buy.contract_id;
            let asset = null;
            
            if (message.echo_req && message.echo_req.parameters) {
                asset = message.echo_req.parameters.symbol;
            }
            
            if (asset && this.quantumStates[asset]) {
                console.log(`✅ Trade placed for ${asset}`);
                this.quantumStates[asset].currentTradeId = contractId;
                this.activeContracts.set(contractId, asset);
                this.subscribeToOpenContract(contractId);
            }
        } catch (error) {
            console.error('Buy response error:', error);
        }
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
        try {
            const won = contract.status === 'won';
            const profit = parseFloat(contract.profit);
            
            let asset = this.activeContracts.get(contract.contract_id);
            if (!asset) {
                asset = contract.underlying;
            }
            
            if (!asset || !this.quantumStates[asset]) return;
            
            const state = this.quantumStates[asset];
            
            console.log(`\n📊 ${asset} - RESULT: ${won ? '✅ WON' : '❌ LOST'}`);
            console.log(`Profit/Loss: $${profit.toFixed(2)}`);
            
            this.totalTrades++;
            this.activeContracts.delete(contract.contract_id);
            
            if (won) {
                this.totalWins++;
                this.globalConsecutiveLosses = 0;
                state.currentStake = this.config.initialStake;
                this.consensusNum = 4;
            } else {
                this.totalLosses++;
                this.globalConsecutiveLosses++;
                state.currentStake = Math.ceil(state.currentStake * this.config.multiplier * 100) / 100;
                
                if (this.globalConsecutiveLosses === 2) {
                    console.log('⚠️ Warning: 2 consecutive losses');
                }
                
                this.sendLossEmail(asset);
            }

            this.totalProfitLoss += profit;
            state.tradeInProgress = false;
            state.currentTradeId = null;

            this.logTradingSummary();
            
            // if(!won) {
            //   this.consensusNum++;
            // }

            if (this.shouldStopTrading()) {
                this.handleStopCondition();
            }
        } catch (error) {
            console.error('Trade result error:', error);
        }
    }

    shouldStopTrading() {
        return this.totalProfitLoss >= this.config.takeProfit ||
               this.globalConsecutiveLosses >= this.config.maxConsecutiveLosses ||
               this.endOfDay;
    }

    handleStopCondition() {
        if (this.totalProfitLoss >= this.config.takeProfit) {
            console.log('✅ TAKE PROFIT REACHED!');
        } else if (this.globalConsecutiveLosses >= this.config.maxConsecutiveLosses) {
            console.log('❌ MAX LOSSES REACHED!');
        }
        
        this.endOfDay = true;
        this.Pause = true;
        
        this.assets.forEach(asset => {
            if (this.quantumStates[asset]) {
                this.quantumStates[asset].isActive = false;
                this.quantumStates[asset].tradeInProgress = false;
            }
        });
        
        if (this.activeContracts.size > 0) {
            console.log(`Waiting for ${this.activeContracts.size} contracts...`);
            setTimeout(() => this.handleStopCondition(), 1000);
            return;
        }
        
        this.sendFinalReport();
        this.disconnect();
    }

    disconnect() {
        if (this.connected) {
            this.assets.forEach(asset => {
                if (this.quantumStates[asset]) {
                    const state = this.quantumStates[asset];
                    if (state.tickSubscriptionId) {
                        this.sendRequest({
                            forget: state.tickSubscriptionId
                        });
                    }
                }
            });
            
            setTimeout(() => {
                if (this.ws) {
                    this.ws.close();
                }
            }, 1000);
        }
    }

    logTradingSummary() {
        console.log('\n⚛️ TRADING SUMMARY ⚛️');
        console.log('═══════════════════════════');
        console.log(`Total Trades: ${this.totalTrades}`);
        console.log(`Won: ${this.totalWins} | Lost: ${this.totalLosses}`);
        console.log(`Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%`);
        console.log(`Consecutive Losses: ${this.globalConsecutiveLosses}`);
        console.log(`Total P/L: $${this.totalProfitLoss.toFixed(2)}`);
        console.log('═══════════════════════════\n');
    }
    
    startEmailTimer() {
        setInterval(() => {
            if (!this.shouldStopTrading()) {
                this.sendEmailSummary();
            }
        }, 1800000);
    }

    async sendEmailSummary() {
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);

            const summaryText = `
            QUANTUM TRADING REPORT
            =====================
            
            Performance:
            Total Trades: ${this.totalTrades}
            Won: ${this.totalWins} | Lost: ${this.totalLosses}
            Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
            Total P/L: $${this.totalProfitLoss.toFixed(2)}
            `;

            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: 'Quantum Trading Report',
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    async sendLossEmail(asset) {
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);

            const summaryText = `
            LOSS ALERT - ${asset}
            =====================
            Consecutive Losses: ${this.globalConsecutiveLosses}
            Total P/L: $${this.totalProfitLoss.toFixed(2)}
            `;

            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: `Loss Alert - ${asset}`,
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    async sendFinalReport() {
        try {
            const transporter = nodemailer.createTransport(this.emailConfig);

            const summaryText = `
            SESSION COMPLETE
            ================
            Total Trades: ${this.totalTrades}
            Won: ${this.totalWins} | Lost: ${this.totalLosses}
            Win Rate: ${this.totalTrades > 0 ? ((this.totalWins / this.totalTrades) * 100).toFixed(2) : 0}%
            Total P/L: $${this.totalProfitLoss.toFixed(2)}
            `;

            const mailOptions = {
                from: this.emailConfig.auth.user,
                to: this.emailRecipient,
                subject: 'Session Complete',
                text: summaryText
            };

            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Email error:', error);
        }
    }

    start() {
        console.log('\n🌌 QUANTUM-INSPIRED TRADING BOT 🌌');
        console.log('═══════════════════════════════════');
        console.log('Version: 2.0.0-STABLE');
        console.log('Analysis: Dynamic & Calibrated');
        console.log('═══════════════════════════════════\n');
        
        this.connect();
    }
}

// Initialize and start
const quantumBot = new QuantumInspiredDerivBot('0P94g4WdSrSrzir', {
    initialStake: 1,
    multiplier: 11.3,
    maxConsecutiveLosses: 3,
    takeProfit: 25
});

// Run with: node --expose-gc --max-old-space-size=2048 bot.js
quantumBot.start();

module.exports = QuantumInspiredDerivBot;