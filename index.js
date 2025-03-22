// backend/src/index.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: 'https://futuresairtrading.netlify.app' }));
app.use(express.json());

// Mock data for testing (replace with Polygon.io API call once confirmed working)
function generateMockCandles(instrument, startDate) {
    const candles = [];
    const basePrice = instrument === 'MNQ' ? 18000 : 5700; // Approximate prices for MNQ and MES
    for (let i = 0; i < 100; i++) {
        const time = new Date(startDate);
        time.setMinutes(time.getMinutes() + i * 5);
        const price = basePrice + i * 10;
        candles.push({
            time,
            open: price,
            high: price + 10,
            low: price - 10,
            close: price + 5,
            volume: 1000 + i * 10,
            isBullish: i % 2 === 0,
        });
    }
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
    const shortMA = Array(closes.length).fill(null);
    const longMA = Array(closes.length).fill(null);
    let shortSum = 0, longSum = 0;
    for (let i = 0; i < closes.length; i++) {
        shortSum += closes[i];
        longSum += closes[i];
        if (i >= 5) shortSum -= closes[i - 5];
        if (i >= 20) longSum -= closes[i - 20];
        if (i >= 4) shortMA[i] = shortSum / 5;
        if (i >= 19) longMA[i] = longSum / 20;
    }
    const signals = [];
    for (let i = 1; i < closes.length; i++) {
        if (shortMA[i - 1] && longMA[i - 1] && shortMA[i] && longMA[i]) {
            if (shortMA[i - 1] < longMA[i - 1] && shortMA[i] > longMA[i]) {
                signals.push({ time: candles[i].time, signal: 'buy' });
            } else if (shortMA[i - 1] > longMA[i - 1] && shortMA[i] < longMA[i]) {
                signals.push({ time: candles[i].time, signal: 'sell' });
            }
        }
    }
    return signals;
}

function bollingerSqueezeStrategy(candles) {
    const closes = candles.map(c => c.close);
    const sma = Array(closes.length).fill(null);
    const bands = [];
    for (let i = 0; i < closes.length; i++) {
        if (i >= 20) {
            const window = closes.slice(i - 20, i);
            const mean = window.reduce((a, b) => a + b, 0) / 20;
            sma[i] = mean;
            const stdDev = Math.sqrt(window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20);
            bands.push({
                upper: mean + 2 * stdDev,
                middle: mean,
                lower: mean - 2 * stdDev,
            });
        } else {
            bands.push(null);
        }
    }
    const signals = [];
    for (let i = 1; i < closes.length; i++) {
        if (bands[i - 1] && bands[i - 2] && bands[i]) {
            const bandwidth = (bands[i - 1].upper - bands[i - 1].lower) / bands[i - 1].middle;
            const prevBandwidth = (bands[i - 2].upper - bands[i - 2].lower) / bands[i - 2].middle;
            if (bandwidth < 0.1 && closes[i] > bands[i].upper) {
                signals.push({ time: candles[i].time, signal: 'buy' });
            } else if (bandwidth < 0.1 && closes[i] < bands[i].lower) {
                signals.push({ time: candles[i].time, signal: 'sell' });
            }
        }
    }
    return signals;
}

// Simulate trades with risk management
function simulateTrades(candles, signals) {
    const trades = [];
    let position = null;
    const atrValues = Array(candles.length).fill(50); // Mock ATR for simplicity
    for (let i = 0; i < candles.length; i++) {
        const signal = signals.find(s => s.time.getTime() === candles[i].time.getTime());
        const atr = atrValues[i];
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

app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Trading Platform Backend' });
});

app.post('/api/backtest', async (req, res) => {
    try {
        const { instrument, startDate, strategy } = req.body;
        const today = new Date().toISOString().split('T')[0];
        if (!instrument || !strategy || !startDate) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (startDate >= today) {
            return res.status(400).json({ error: 'Start date must be in the past' });
        }

        const candles = generateMockCandles(instrument, new Date(startDate));
        console.log(`Generated ${candles.length} mock candles for ${instrument}`);

        let signals;
        switch (strategy) {
            case 'ictScalping': signals = ictScalpingStrategy(candles); break;
            case 'maCrossover': signals = maCrossoverStrategy(candles); break;
            case 'bollingerSqueeze': signals = bollingerSqueezeStrategy(candles); break;
            default: return res.status(400).json({ error: 'Invalid strategy' });
        }
        console.log(`Generated ${signals.length} signals`);

        const trades = simulateTrades(candles, signals);
        console.log(`Simulated ${trades.length} trades`);

        const netProfit = trades.reduce((sum, trade) => sum + trade.profitLoss, 0);
        const chartData = candles.map(candle => ({
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
