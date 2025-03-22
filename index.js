// backend/src/index.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors({ origin: 'https://futuresairtrading.netlify.app' })); // Update with your Netlify URL
app.use(express.json());

const POLYGON_API_KEY = 'Pq2TNELGWQpjDQh8EByJmfNIhtFu6AP4'; // Your provided API key
const POLYGON_API_URL = 'https://api.polygon.io';

// Function to get the front-month futures contract symbol (e.g., I:MNQH25 for March 2025)
function getFrontMonthContract(instrument, date) {
    const month = date.getMonth() + 1; // 1-12
    const year = date.getFullYear() % 100; // Last two digits
    let contractMonth;
    if (month <= 3) contractMonth = 'H'; // March
    else if (month <= 6) contractMonth = 'M'; // June
    else if (month <= 9) contractMonth = 'U'; // September
    else contractMonth = 'Z'; // December
    return `I:${instrument}${contractMonth}${year}`;
}

// Fetch historical candlestick data from Polygon.io
async function fetchCandlestickData(instrument, startDate) {
    const ticker = getFrontMonthContract(instrument, new Date(startDate));
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1); // Fetch one day of data
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    try {
        const response = await axios.get(
            `${POLYGON_API_URL}/v2/aggs/ticker/${ticker}/range/5/minute/${startDateStr}/${endDateStr}`,
            { params: { apiKey: POLYGON_API_KEY } }
        );
        if (!response.data.results) {
            throw new Error('No results returned from Polygon.io');
        }
        const candles = response.data.results.map(candle => ({
            time: Math.floor(candle.t / 1000), // Unix timestamp in seconds
            open: candle.o,
            high: candle.h,
            low: candle.l,
            close: candle.c,
            volume: candle.v,
            isBullish: candle.c > candle.o,
        }));
        console.log(`Fetched ${candles.length} candles for ${ticker}`);
        return candles;
    } catch (error) {
        console.error('Error fetching candles:', error.message);
        throw error;
    }
}

// ICT Scalping Strategy
function ictScalpingStrategy(candles) {
    const signals = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1], curr = candles[i];
        if (!prev.isBullish && curr.isBullish && curr.volume > prev.volume * 1.5) {
            signals.push({ time: curr.time, signal: 'buy' });
        } else if (prev.isBullish && !curr.isBullish && curr.volume > prev.volume * 1.5) {
            signals.push({ time: curr.time, signal: 'sell' });
        } else if (Math.abs(curr.close - prev.close) > prev.close * 0.005 && curr.volume < prev.volume * 0.5) {
            signals.push({ time: curr.time, signal: curr.close > prev.close ? 'buy' : 'sell' });
        }
    }
    return signals;
}

// Simulate trades based on signals
function simulateTrades(candles, signals) {
    const trades = [];
    let position = null;
    for (let i = 0; i < candles.length; i++) {
        const signal = signals.find(s => s.time === candles[i].time);
        if (signal) {
            if (signal.signal === 'buy' && !position) {
                position = { entry: candles[i].close, time: candles[i].time };
            } else if (signal.signal === 'sell' && position) {
                const profitLoss = candles[i].close - position.entry;
                trades.push({
                    timestamp: new Date(candles[i].time * 1000).toISOString(),
                    signal: 'sell',
                    entryPrice: position.entry,
                    exitPrice: candles[i].close,
                    profitLoss
                });
                position = null;
            }
        }
    }
    return trades;
}

// Backtesting endpoint
app.post('/api/backtest', async (req, res) => {
    try {
        const { instrument, startDate, strategy } = req.body;
        const today = new Date().toISOString().split('T')[0];

        if (!instrument || !startDate || !strategy) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (startDate >= today) {
            return res.status(400).json({ error: 'Start date must be in the past' });
        }

        const candles = await fetchCandlestickData(instrument, startDate);
        let signals;
        switch (strategy) {
            case 'ictScalping': signals = ictScalpingStrategy(candles); break;
            // Add other strategies here if needed
            default: return res.status(400).json({ error: 'Invalid strategy' });
        }
        const trades = simulateTrades(candles, signals);
        const netProfit = trades.reduce((sum, trade) => sum + trade.profitLoss, 0);

        res.json({ trades, netProfit, chartData: candles });
    } catch (error) {
        console.error('Backtesting error:', error.message);
        res.status(500).json({ error: 'Backtesting error', details: error.message });
    }
});

// Real-time data endpoint for dashboard
app.get('/api/realtime', async (req, res) => {
    const { instrument } = req.query;
    const ticker = getFrontMonthContract(instrument, new Date());

    try {
        const response = await axios.get(
            `${POLYGON_API_URL}/v2/last/trade/${ticker}`,
            { params: { apiKey: POLYGON_API_KEY } }
        );
        const trade = response.data.results;
        res.json({
            instrument: ticker,
            price: trade.p,
            timestamp: new Date(trade.t).toISOString()
        });
    } catch (error) {
        console.error('Error fetching real-time data:', error.message);
        res.status(500).json({ error: 'Error fetching real-time data', details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
