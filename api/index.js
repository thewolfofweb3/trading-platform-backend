const axios = require('axios');
const cors = require('cors');
const { ML } = require('ml-js');

// Polygon API key (replace with your key)
const POLYGON_API_KEY = 'YOUR_POLYGON_API_KEY';
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
let model = new ML.Regression.SimpleLinearRegression();
let trainingData = { inputs: [], outputs: [] };

// CORS configuration
const corsOptions = {
    origin: '*', // Allow all origins (you can restrict to 'https://futureaitrading.netlify.app' if needed)
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200
};

// Apply CORS middleware
const corsMiddleware = cors(corsOptions);

module.exports = async (req, res) => {
    // Apply CORS middleware
    corsMiddleware(req, res, async () => {
        console.log(`Received ${req.method} request to ${req.url}`);

        if (req.method === 'POST') {
            if (req.url === '/api/start-trading') {
                try {
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
                } catch (error) {
                    console.error('Error in start-trading:', error);
                    res.status(500).json({ error: 'Internal server error', details: error.message });
                }
            } else if (req.url === '/api/backtest') {
                try {
                    const { instrument, strategy, date } = req.body;
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
                } catch (error) {
                    console.error('Error in backtest:', error);
                    res.status(500).json({ error: 'Internal server error', details: error.message });
                }
            } else if (req.url === '/api/paper-trade') {
                try {
                    const { broker, apiKey, accountId } = req.body;
                    const trades = await executeICTStrategy('MES1', false, null, true);
                    paperTradeLog.push(...trades);
                    const netProfit = trades.reduce((sum, t) => sum + t.profitLoss, 0) || 0;
                    res.json({ status: 'Paper Trading Active', netProfit });
                } catch (error) {
                    console.error('Error in paper-trade:', error);
                    res.status(500).json({ error: 'Internal server error', details: error.message });
                }
            } else if (req.url === '/api/paper-backtest') {
                try {
                    const { broker, apiKey, accountId } = req.body;
                    const trades = await executeICTStrategy('MES1', true, '2024-10-01', true);
                    paperTradeLog.push(...trades);
                    const netProfit = trades.reduce((sum, t) => sum + t.profitLoss, 0) || 0;
                    res.json({ status: 'Paper Backtest Complete', netProfit });
                } catch (error) {
                    console.error('Error in paper-backtest:', error);
                    res.status(500).json({ error: 'Internal server error', details: error.message });
                }
            }
        } else if (req.method === 'GET') {
            if (req.url === '/api/trade-log') {
                res.json(tradeLog);
            } else if (req.url === '/api/backtest-trade-log') {
                res.json(backtestTradeLog);
            } else if (req.url === '/api/paper-trade-log') {
                res.json(paperTradeLog);
            } else if (req.url === '/api/market-data') {
                const data = await fetchMarketData();
                res.json(data);
            } else {
                res.status(404).json({ error: 'Not found' });
            }
        } else {
            res.status(405).json({ error: 'Method not allowed' });
        }
    });
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
        console.error('Error fetching market data:', error);
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

    // ICT Strategy with Liquidity Channels
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
            trainingData.inputs.push([rsi, bar.volume, bar.atr]);
            trainingData.outputs.push(profitLoss > 0 ? 1 : 0);
            if (trainingData.inputs.length > 10) {
                model.train(trainingData.inputs, trainingData.outputs);
            }
        }
        
        if (trades.length >= 3 && !isBacktest) break; // Max 3 trades per day
    }
    return trades;
}

async function fetchHistoricalData(symbol, date) {
    try {
        const response = await axios.get(
            `https://api.polygon.io/v2/aggs/ticker/FUTURES:${symbol}/range/5/minute/${date}/${date}?apiKey=${POLYGON_API_KEY}`
        );
        const bars = response.data.results || [];
        return bars.map(bar => ({
            t: bar.t,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
            atr: calculateATR(bars, 14)
        }));
    } catch (error) {
        console.error('Error fetching historical data:', error);
        return [];
    }
}

function calculateRSI(data, period) {
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
        const change = data[i].close - data[i - 1]?.close;
        if (change > 0) gains += change;
        else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(bars, period) {
    return bars.slice(-period).reduce((sum, bar) => sum + (bar.high - bar.low), 0) / period;
}

function updateAccountStats(trades) {
    dailyProfit = trades.filter(t => t.profitLoss > 0).reduce((sum, t) => sum + parseFloat(t.profitLoss), 0);
    dailyLoss = trades.filter(t => t.profitLoss < 0).reduce((sum, t) => sum + parseFloat(t.profitLoss), 0);
    accountBalance += dailyProfit + dailyLoss;
    peakBalance = Math.max(peakBalance, accountBalance);
}
