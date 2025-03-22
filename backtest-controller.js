// backend/src/controllers/backtest-controller.js
const express = require('express');
const router = express.Router();

router.post('/api/backtest', (req, res) => {
    const { instrument, strategy, startDate } = req.body;
    const today = new Date().toISOString().split('T')[0];

    if (!instrument || !strategy || !startDate) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (startDate >= today) {
        return res.status(400).json({ error: 'Start date must be in the past' });
    }

    // Mock backtest logic (replace with real data source, e.g., OANDA API)
    const trades = [
        { timestamp: `${startDate} 09:00:00`, signal: 'buy', entryPrice: 500.00, units: 35, stopLoss: 499.90, takeProfit: 500.20, profitLoss: 7.00 },
        { timestamp: `${startDate} 09:05:00`, signal: 'sell', entryPrice: 500.10, units: 35, stopLoss: 500.20, takeProfit: 499.90, profitLoss: 3.50 },
    ];
    const netProfit = trades.reduce((sum, trade) => sum + trade.profitLoss, 0);
    const chartData = trades.map(trade => ({
        time: new Date(trade.timestamp).getTime() / 1000,
        open: trade.entryPrice,
        high: Math.max(trade.entryPrice, trade.takeProfit),
        low: Math.min(trade.entryPrice, trade.stopLoss),
        close: trade.profitLoss > 0 ? trade.takeProfit : trade.stopLoss,
    }));

    res.json({ trades, netProfit, chartData });
});

module.exports = router;
