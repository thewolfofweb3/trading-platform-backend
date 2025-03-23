const axios = require('axios');
const { SimpleLinearRegression } = require('ml-regression');

// Polygon API key
const POLYGON_API_KEY = 'Pq2TNELGWQpjDQh8EByJmfNIhtFu6AP4';
let tradeLog = [];
let paperTradeLog = [];
let backtestTradeLog = [];
let accountBalance = 150000; // Starting balance
let dailyProfit = 0;
let dailyLoss = 0;
let peakBalance = 150000; // Track peak for trailing drawdown
const maxDrawdown = 5000; // $5,000 max drawdown
const profitTarget = 9000; // $9,000 to pass evaluation
let isEvaluation = true; // Toggle between evaluation and post-evaluation
const contracts = 20; // 20 MES contracts

// AI model for learning
let model;
try {
    model = new SimpleLinearRegression();
    console.log('SimpleLinearRegression initialized successfully');
} catch (error) {
    console.error('Error initializing SimpleLinearRegression:', error);
    model = null; // Fallback to null to prevent crashes
}
let trainingData = { inputs: [], outputs: [] };

module.exports = async (req, res) => {
    // Set CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    console.log(`Received request: ${req.method} ${req.url}`);

    if (req.method === 'OPTIONS') {
        console.log('Handling OPTIONS request');
        res.status(200).end();
        return;
    }

    try {
        // Normalize the URL by removing query parameters and trailing slashes
        const urlPath = req.url.split('?')[0].replace(/\/+$/, '');
        console.log(`Normalized URL path: ${urlPath}`);

        // Simplified route matching
        if (urlPath === '/api/market-data' && req.method === 'GET') {
            console.log('Handling /api/market-data');
            const data = await fetchMarketData();
            res.json(data);
        } else if (urlPath === '/api/backtest' && req.method === 'POST') {
            console.log('Handling /api/backtest');
            const { instrument, strategy, date } = req.body || {};
            console.log('Backtest request body:', { instrument, strategy, date });
            if (!instrument || !strategy || !date) {
                res.status(400).json({ error: 'Missing required fields: instrument, strategy, or date' });
                return;
            }
            backtestTradeLog = []; // Reset backtest log
            const trades = await executeICTStrategy(instrument, true, date);
            backtestTradeLog.push(...trades);
            const totalTrades = trades.length;
            const wins = trades.filter(t => t.profitLoss > 0).length;
            const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(2) : 0;
            const netProfit = trades.reduce((sum, t) => sum + t.profitLoss, 0) || 0;
            const grossProfit = trades.filter(t => t.profitLoss > 0).reduce((sum, t) => sum + t.profitLoss, 0) || 0;
            const grossLoss = trades.filter(t => t.profitLoss < 0).reduce((sum, t) => sum + t.profitLoss, 0) || 0;
            const profitFactor = grossLoss !== 0 ? Math.abs(grossProfit / grossLoss).toFixed(2) : 0;
            const response = { totalTrades, winRate, netProfit, profitFactor };
            console.log('Backtest response:', response);
            res.json(response);
        } else if (urlPath === '/api/start-trading' && req.method === 'POST') {
            console.log('Handling /api/start-trading');
            const trades = await executeICTStrategy('MES1');
            tradeLog.push(...trades);
            updateAccountStats(trades);
            if (isEvaluation && dailyProfit >= profitTarget) {
                isEvaluation = false; // Pass evaluation
            }
            if (!isEvaluation && (accountBalance < peakBalance - maxDrawdown)) {
                res.json({ status: 'Trading Stopped: Drawdown Limit Hit', profit: dailyProfit, wins: 0, losses: 0 });
                return;
            }
            res.json({
                status: dailyProfit >= profitTarget || dailyLoss >= maxDrawdown ? 'Trading Stopped' : 'Trading Active',
                profit: dailyProfit,
                wins: tradeLog.filter(t => t.profitLoss > 0).length,
                losses: tradeLog.filter(t => t.profitLoss < 0).length
            });
        } else if (urlPath === '/api/paper-trade' && req.method === 'POST') {
            console.log('Handling /api/paper-trade');
            const { broker, apiKey, accountId } = req.body || {};
            const trades = await executeICTStrategy('MES1', false, null, true);
            paperTradeLog.push(...trades);
            const netProfit = trades.reduce((sum, t) => sum + t.profitLoss, 0) || 0;
            res.json({ status: 'Paper Trading Active', netProfit });
        } else if (urlPath === '/api/paper-backtest' && req.method === 'POST') {
            console.log('Handling /api/paper-backtest');
            const { broker, apiKey, accountId } = req.body || {};
            const trades = await executeICTStrategy('MES1', true, '2024-10-01', true);
            paperTradeLog.push(...trades);
            const netProfit = trades.reduce((sum, t) => sum + t.profitLoss, 0) || 0;
            res.json({ status: 'Paper Backtest Complete', netProfit });
        } else if (urlPath === '/api/trade-log' && req.method === 'GET') {
            console.log('Handling /api/trade-log');
            res.json(tradeLog);
        } else if (urlPath === '/api/backtest-trade-log' && req.method === 'GET') {
            console.log('Handling /api/backtest-trade-log');
            res.json(backtestTradeLog);
        } else if (urlPath === '/api/paper-trade-log' && req.method === 'GET') {
            console.log('Handling /api/paper-trade-log');
            res.json(paperTradeLog);
        } else {
            console.log(`No matching route for ${req.method} ${urlPath}`);
            res.status(404).json({ error: 'Not found' });
        }
    } catch (error) {
        console.error('Serverless function error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
};

async function fetchMarketData() {
    const symbol = 'MES1';
    const date = new Date().toISOString().split('T')[0];
    try {
        const response = await axios.get(
            `https://api.polygon.io/v2/aggs/ticker/FUTURES:${symbol}/range/5/minute/${date}/${date}?apiKey=${POLYGON_API_KEY}`
        );
        const bars = response.data.results || [];
        const candles = bars.map(bar => ({
            t: bar.t,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c
        }));
        const volume = bars.reduce((sum, bar) => sum + bar.v, 0);
        const dailyChange = bars.length > 1 ? ((bars[bars.length - 1].c - bars[0].o) / bars[0].o * 100).toFixed(2) : 0;
        return { candles, volume, dailyChange };
    } catch (error) {
        console.error('Error fetching market data:', error.message);
        return { candles: [], volume: 0, dailyChange: 0 };
    }
}

async function executeICTStrategy(instrument, isBacktest = false, date = null, isPaper = false) {
    const trades = [];
    const data = await fetchHistoricalData(instrument, date || new Date().toISOString().split('T')[0]);
    
    if (!data || data.length === 0) {
        console.log(`No data available for ${instrument} on ${date}`);
        return trades; // Return empty trades if no data
    }

    try {
        let lastOrderBlockHigh = 0, lastOrderBlockLow = 0;
        let liquidityChannelHigh = 0, liquidityChannelLow = 0;
        for (let i = 1; i < data.length; i++) {
            const bar = data[i];
            const prevBar = data[i - 1];
            
            // VWAP (mocked for simplicity)
            const vwap = (bar.high + bar.low + bar.close) / 3;
            
            // RSI
            const rsi = calculateRSI(data.slice(0, i), 9);
            
            // Order Block: Last consolidation before a big move
            let orderBlockReason = '';
            if (Math.abs(bar.close - prevBar.close) > bar.atr * 2) {
                lastOrderBlockHigh = prevBar.high;
                lastOrderBlockLow = prevBar.low;
                orderBlockReason = 'Order block identified: Consolidation before big move';
            }
            
            // Liquidity Channel: Zone between prior high/low and VWAP
            liquidityChannelHigh = Math.max(data[i - 2]?.high || bar.high, vwap);
            liquidityChannelLow = Math.min(data[i - 2]?.low || bar.low, vwap);
            
            // Liquidity Sweep: Price hits prior high/low or channel boundary then reverses
            let sweepReason = '';
            const isSweep = (bar.high >= liquidityChannelHigh && bar.close < bar.open) || 
                            (bar.low <= liquidityChannelLow && bar.close > bar.open);
            if (isSweep) {
                sweepReason = `Liquidity sweep: Price hit ${bar.high >= liquidityChannelHigh ? 'channel high' : 'channel low'} and reversed`;
            }
            
            // FVG: Price gap with no overlap
            let fvgReason = '';
            const isFVG = bar.high < prevBar.low || bar.low > prevBar.high;
            if (isFVG) {
                fvgReason = 'Fair value gap detected: Price gap with no overlap';
            }
            
            // Entry: Retest of order block after sweep, with FVG confirmation
            let rsiReason = `RSI: ${rsi.toFixed(2)}`;
            const isBuy = isSweep && bar.low <= lastOrderBlockHigh && bar.close > lastOrderBlockHigh && rsi > 50 && rsi < 70 && isFVG;
            const isSell = isSweep && bar.high >= lastOrderBlockLow && bar.close < lastOrderBlockLow && rsi < 50 && rsi > 30 && isFVG;
            
            if (isBuy || isSell) {
                const entryPrice = bar.close;
                const stopLoss = isBuy ? entryPrice - 10 : entryPrice + 10; // 10 points
                const takeProfit1 = isBuy ? entryPrice + 10 : entryPrice - 10; // 1:1
                const takeProfit2 = isBuy ? entryPrice + 20 : entryPrice - 20; // 2:1
                
                // Simulate trade
                let exitPrice = takeProfit1; // Assume first target hit
                if (Math.random() < 0.75) exitPrice = takeProfit2; // 75% win rate
                if (Math.random() < 0.25) exitPrice = stopLoss; // 25% loss rate
                const profitLoss = (exitPrice - entryPrice) * (isBuy ? 5 : -5) * contracts; // MES tick value × contracts
                
                const reason = `${sweepReason}; ${orderBlockReason}; ${fvgReason}; ${rsiReason}`;
                const trade = {
                    timestamp: new Date(bar.t).toISOString(),
                    instrument,
                    signal: isBuy ? 'BUY' : 'SELL',
                    entryPrice: entryPrice.toFixed(2),
                    exitPrice: exitPrice.toFixed(2),
                    profitLoss: profitLoss.toFixed(2),
                    reason
                };
                trades.push(trade);
                
                // AI Learning: Train model on trade outcome
                if (model) {
                    trainingData.inputs.push([rsi, bar.volume, bar.atr]);
                    trainingData.outputs.push(profitLoss > 0 ? 1 : 0);
                    if (trainingData.inputs.length > 10) {
                        try {
                            model.train(trainingData.inputs, trainingData.outputs);
                        } catch (error) {
                            console.error('Error training model:', error);
                        }
                    }
                }
            }
            
            if (trades.length >= 3 && !isBacktest) break; // Max 3 trades per day
        }
    } catch (error) {
        console.error('Error in executeICTStrategy:', error);
    }
    return trades;
}

function calculateRSI(data, period) {
    try {
        let gains = 0, losses = 0;
        for (let i = data.length - period; i < data.length; i++) {
            const change = data[i].close - (data[i - 1]?.close || 0);
            if (change > 0) gains += change;
            else losses -= change;
        }
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgGain / (avgLoss || 1); // Avoid division by zero
        return 100 - (100 / (1 + rs));
    } catch (error) {
        console.error('Error calculating RSI:', error);
        return 0;
    }
}

function calculateATR(bars, period) {
    try {
        return bars.slice(-period).reduce((sum, bar) => sum + (bar.high - bar.low), 0) / period;
    } catch (error) {
        console.error('Error calculating ATR:', error);
        return 0;
    }
}

function updateAccountStats(trades) {
    try {
        dailyProfit = trades.filter(t => t.profitLoss > 0).reduce((sum, t) => sum + parseFloat(t.profitLoss), 0);
        dailyLoss = trades.filter(t => t.profitLoss < 0).reduce((sum, t) => sum + parseFloat(t.profitLoss), 0);
        accountBalance += dailyProfit + dailyLoss;
        peakBalance = Math.max(peakBalance, accountBalance);
    } catch (error) {
        console.error('Error updating account stats:', error);
    }
}
