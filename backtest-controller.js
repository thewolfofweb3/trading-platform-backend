// backend/src/controllers/backtest-controller.js
const express = require('express');
const axios = require('axios');
const router = express.Router();
const { EMA, RSI, BollingerBands, MACD, ATR } = require('technicalindicators');

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) {
    throw new Error('POLYGON_API_KEY is not set in the .env file. Please add it and restart the server.');
}
const POLYGON_API_URL = 'https://api.polygon.io';

// Determine MNQ/MES contract symbol
function getFrontMonthContract(instrument, date) {
    const month = date.getMonth() + 1; // 1-12
    const year = date.getFullYear() % 100; // Last two digits
    if (month <= 3) return `I:${instrument}H${year}`; // March
    if (month <= 6) return `I:${instrument}M${year}`; // June
    if (month <= 9) return `I:${instrument}U${year}`; // September
    return `I:${instrument}Z${year}`; // December
}

// Fetch candlestick data
async function fetchCandlestickData(instrument, startDate) {
    const ticker = getFrontMonthContract(instrument, startDate);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    console.log(`Fetching data for ${ticker} from ${startDateStr} to ${endDateStr}`);
    try {
        const response = await axios.get(
            `${POLYGON_API_URL}/v2/aggs/ticker/${ticker}/range/5/minute/${startDateStr}/${endDateStr}`,
            { params: { apiKey: POLYGON_API_KEY } }
        );
        if (!response.data.results) {
            throw new Error('No results returned from Polygon.io');
        }
        const candles = response.data.results.map(candle => ({
            time: new Date(candle.t),
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
        if (bb[i - 1] && bb[i - 2] && bb[i]) {
            const bandwidth = (bb[i - 1].upper - bb[i - 1].lower) / bb[i - 1].middle;
            const prevBandwidth = (bb[i - 2].upper - bb[i - 2].lower) / bb[i - 2].middle;
            if (bandwidth < 0.1 && closes[i] > bb[i].upper) {
                signals.push({ time: candles[i].time, signal: 'buy' });
            } else if (bandwidth < 0.1 && closes[i] < bb[i].lower) {
                signals.push({ time: curr.time, signal: 'sell' });
            }
        }
    }
    return signals;
}

// Simulate trades with risk management
function simulateTrades(candles, signals) {
    const trades = [];
    let position = null;
    const atrValues = ATR.calculate({ high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close), period: 14 });
    for (let i = 0; i < candles.length; i++) {
        const signal = signals.find(s => s.time.getTime() === candles[i].time.getTime());
        const atr = atrValues[i] || 50; // Default ATR if not enough data
        if (signal) {
            if (signal.signal === 'buy' && !position) {
                position = { entry: candles[i].close, stopLoss: candles[i].close - atr, takeProfit: candles[i].close + atr * 3, time: candles[i].time, units: 1 };
                trades.push({ timestamp: candles[i].time.toISOString(), signal: 'buy', entryPrice: candles[i].close, units: 1, stopLoss: position.stopLoss, takeProfit: position.takeProfit, profitLoss: 0 });
            } else if (signal.signal === 'sell' && position) {
                const profitLoss = (candles[i].close - position.entry) * position.units;
                trades.push({ timestamp: candles[i].time.toISOString(), signal: 'sell', entryPrice: position.entry, units: position.units, stopLoss: position.stopLoss, takeProfit: position.takeProfit, profitLoss: profitLoss });
                position = null;
            }
        }
        if (position && i > 0) {
            const currPrice = candles[i].close;
            if (currPrice <= position.stopLoss || currPrice >= position.takeProfit) {
                const profitLoss = (currPrice - position.entry) * position.units;
                trades.push({ timestamp: candles[i].time.toISOString(), signal: 'exit', entryPrice: position.entry, units: position.units, stopLoss: position.stopLoss, takeProfit: position.takeProfit, profitLoss: profitLoss });
                position = null;
            } else if (currPrice - position.entry > atr) {
                position.stopLoss = position.entry; // Shift to break-even
            }
        }
    }
    return trades;
}

router.post('/api/backtest', async (req, res) => {
    try {
        const { instrument, startDate, strategy } = req.body;
        const today = new Date().toISOString().split('T')[0];
        if (!instrument || !strategy || !startDate) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (startDate >= today) {
            return res.status(400).json({ error: 'Start date must be in the past' });
        }

        const candles = await fetchCandlestickData(instrument, new Date(startDate));
        if (!candles || candles.length === 0) {
            return res.status(404).json({ error: 'No data available for the selected period' });
        }

        const startDateTime = new Date(startDate);
        startDateTime.setUTCHours(13, 45, 0, 0); // 9:45 AM ET
        const endDateTime = new Date(startDate);
        endDateTime.setUTCHours(23, 59, 59, 999); // End of day
        const filteredCandles = candles.filter(candle => candle.time >= startDateTime && candle.time <= endDateTime);
        console.log(`After date filtering: ${filteredCandles.length} candles`);

        if (filteredCandles.length === 0) {
            return res.status(404).json({ error: 'No data available for the selected date after filtering' });
        }

        const sessionCandles = filteredCandles.filter(candle => {
            const hours = candle.time.getUTCHours() - 4;
            const minutes = candle.time.getUTCMinutes();
            return (hours === 9 && minutes >= 45) || (hours === 10) || (hours === 11 && minutes <= 30) ||
                   (hours === 13 && minutes >= 30) || (hours === 14) || (hours === 15 && minutes <= 30);
        });
        console.log(`After trading window filtering: ${sessionCandles.length} candles`);

        if (sessionCandles.length === 0) {
            return res.status(404).json({ error: 'No data available within the trading window' });
        }

        let signals;
        switch (strategy) {
            case 'ictScalping': signals = ictScalpingStrategy(sessionCandles); break;
            case 'maCrossover': signals = maCrossoverStrategy(sessionCandles); break;
            case 'bollingerSqueeze': signals = bollingerSqueezeStrategy(sessionCandles); break;
            default: return res.status(400).json({ error: 'Invalid strategy' });
        }

        const trades = simulateTrades(sessionCandles, signals);
        const netProfit = trades.reduce((sum, trade) => sum + trade.profitLoss, 0);
        const chartData = sessionCandles.map(candle => ({
            time: Math.floor(candle.time.getTime() / 1000),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
        }));

        res.json({ trades, netProfit, chartData });
    } catch (error) {
        console.error('Backtesting error:', error.message);
        res.status(500).json({ error: 'Backtesting error', details: error.message });
    }
});

module.exports = router;
