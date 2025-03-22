// backend/src/index.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: 'https://futuresairtrading.netlify.app' })); // Update with your Netlify URL
app.use(express.json());

// Generate mock candlestick data for testing
function generateMockCandles(instrument, startDate) {
    const candles = [];
    const basePrice = instrument === 'MNQ' ? 18000 : 5700; // Approximate prices for MNQ and MES
    const start = new Date(startDate);
    for (let i = 0; i < 100; i++) {
        const time = new Date(start);
        time.setMinutes(start.getMinutes() + i * 5);
        const price = basePrice + i * 10;
        candles.push({
            time: Math.floor(time.getTime() / 1000), // Unix timestamp in seconds
            open: price,
            high: price + 10,
            low: price - 10,
            close: price + 5
        });
    }
    return candles;
}

// Simple backtesting strategy for testing
function runStrategy(candles) {
    const trades = [];
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i - 1].close) {
            trades.push({
                timestamp: new Date(candles[i].time * 1000).toISOString(),
                signal: 'buy',
                entryPrice: candles[i].close,
                profitLoss: (candles[i].close - candles[i - 1].close)
            });
        }
    }
    return trades;
}

app.post('/api/backtest', (req, res) => {
    try {
        const { instrument, startDate, strategy } = req.body;
        const today = new Date().toISOString().split('T')[0];

        if (!instrument || !startDate || !strategy) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (startDate >= today) {
            return res.status(400).json({ error: 'Start date must be in the past' });
        }

        const chartData = generateMockCandles(instrument, startDate);
        const trades = runStrategy(chartData);
        const netProfit = trades.reduce((sum, trade) => sum + trade.profitLoss, 0);

        res.json({ trades, netProfit, chartData });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Server error', details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
