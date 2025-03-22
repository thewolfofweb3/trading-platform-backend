const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { EMA, RSI, BollingerBands, MACD, ATR } = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const POLYGON_API_URL = 'https://api.polygon.io';

// Trading state
let dailyLoss = 0;
const dailyLossCap = 4500; // 3% of 150K
const riskPerTrade = 900; // 0.6% of 150K
let tradesToday = 0;
let lastDay = null;

app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Trading Platform Backend' });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'Backend is running', dailyLoss, tradesToday });
});

// Determine MNQ/MES contract symbol
function getContractSymbol(instrument, date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const contractMonth = month <= 3 ? 'H' : month <= 6 ? 'M' : month <= 9 ? 'U' : 'Z';
    return `I:${instrument}${contractMonth}${year.toString().slice(-2)}`;
}

// Fetch candlestick data
async function fetchCandlestickData(instrument, startDate) {
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    const response = await axios.get(
        `${POLYGON_API_URL}/v2/aggs/ticker/${instrument}/range/5/minute/${startDateStr}/${endDateStr}`,
        { params: { apiKey: POLYGON_API_KEY } }
    );
    const candles = response.data.results.map(candle => ({
        time: new Date(candle.t),
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        volume: candle.v,
        isBullish: candle.c > candle.o,
    }));
    return candles;
}

// Strategy Implementations
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

function maCrossoverStrategy(candles) {
    const closes = candles.map(c => c.close);
    const shortMA = EMA.calculate({ period: 5, values: closes });
    const longMA = EMA.calculate({ period: 20, values: closes });
    const signals = [];
    for (let i = 1; i < closes.length; i++) {
        if (shortMA[i - 1] < longMA[i - 1] && shortMA[i] > longMA[i]) {
            signals.push({ time: candles[i].time, signal: 'buy' });
        } else if (shortMA[i - 1] > longMA[i - 1] && shortMA[i] < longMA[i]) {
            signals.push({ time: candles[i].time, signal: 'sell' });
        }
    }
    return signals;
}

function bollingerSqueezeStrategy(candles) {
    const closes = candles.map(c => c.close);
    const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const signals = [];
    for (let i = 1; i < closes.length; i++) {
        if (bb[i - 1].upper - bb[i - 1].lower < bb[i - 2].upper - bb[i - 2].lower && closes[i] > bb[i].upper) {
            signals.push({ time: candles[i].time, signal: 'buy' });
        } else if (bb[i - 1].upper - bb[i - 1].lower < bb[i - 2].upper - bb[i - 2].lower && closes[i] < bb[i].lower) {
            signals.push({ time: candles[i].time, signal: 'sell' });
        }
    }
    return signals;
}

// Add RSI Divergence and MACD Histogram similarly...

// Simulate trades with risk management
function simulateTrades(candles, signals) {
    const trades = [];
    let position = null;
    const atrValues = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close), period: 14 });
    for (let i = 0; i < candles.length; i++) {
        const signal = signals.find(s => s.time.getTime() === candles[i].time.getTime());
        const atr = atrValues[i] || 50; // Default ATR if not enough data
        if (signal && dailyLoss < dailyLossCap) {
            if (signal.signal === 'buy' && !position) {
                position = { entry: candles[i].close, stopLoss: candles[i].close - atr, takeProfit: candles[i].close + atr * 3, time: candles[i].time };
            } else if (signal.signal === 'sell' && position) {
                const profitLoss = position.entry - candles[i].close;
                trades.push({ ...position, exit: candles[i].close, profitLoss });
                dailyLoss += profitLoss < 0 ? -profitLoss : 0;
                position = null;
            }
        }
        if (position && i > 0) {
            const currPrice = candles[i].close;
            if (currPrice <= position.stopLoss || currPrice >= position.takeProfit) {
                const profitLoss = position.entry - currPrice;
                trades.push({ ...position, exit: currPrice, profitLoss });
                dailyLoss += profitLoss < 0 ? -profitLoss : 0;
                position = null;
            } else if (currPrice - position.entry > atr) {
                position.stopLoss = position.entry; // Shift to break-even
            }
        }
    }
    return trades;
}

app.post('/api/backtest', async (req, res) => {
    const { instrument, startDate, strategy } = req.body;
    if (!instrument || !startDate || !strategy) {
        return res.status(400).json({ error: 'Instrument, start date, and strategy required' });
    }
    const contractSymbol = getContractSymbol(instrument, new Date(startDate));
    const candles = await fetchCandlestickData(contractSymbol, new Date(startDate));
    let signals;
    switch (strategy) {
        case 'ictScalping': signals = ictScalpingStrategy(candles); break;
        case 'maCrossover': signals = maCrossoverStrategy(candles); break;
        case 'bollingerSqueeze': signals = bollingerSqueezeStrategy(candles); break;
        default: return res.status(400).json({ error: 'Invalid strategy' });
    }
    const trades = simulateTrades(candles, signals);
    res.json({ trades });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
