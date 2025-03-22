// backend/src/index.js
const express = require('express');
const { restClient, websocketClient } = require('@polygon.io/client-js');
require('dotenv').config();
const { EMA, RSI, BollingerBands, MACD, ATR } = require('technicalindicators');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
if (!POLYGON_API_KEY) {
    throw new Error('POLYGON_API_KEY is not set in the .env file. Please add it and restart the server.');
}

// Initialize Polygon.io REST and WebSocket clients
const rest = restClient(POLYGON_API_KEY);
const ws = websocketClient(POLYGON_API_KEY);

// Trading state
let dailyLoss = 0;
const dailyLossCap = 4500; // 3% of 150K
const riskPerTrade = 900; // 0.6% of 150K
let tradesToday = 0;
let lastDay = null;

// Set up WebSocket server to broadcast real-time data to the frontend
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', (wsClient) => {
    console.log('Frontend WebSocket client connected');
    wsClient.on('message', (message) => {
        const { instrument } = JSON.parse(message);
        console.log(`Subscribing to real-time data for ${instrument}`);

        // Subscribe to real-time trades for the specified instrument
        ws.subscribe(`T.${instrument}`);
    });

    wsClient.on('close', () => {
        console.log('Frontend WebSocket client disconnected');
        ws.unsubscribeAll();
    });
});

// Handle real-time trade updates from Polygon.io
ws.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.ev === 'T') { // Trade event
        const trade = {
            instrument: message.sym,
            price: message.p,
            size: message.s,
            timestamp: new Date(message.t).toISOString(),
        };
        console.log('Received trade:', trade);

        // Broadcast the trade to all connected frontend clients
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(trade));
            }
        });
    }
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error);
});

ws.on('open', () => {
    console.log('Connected to Polygon.io WebSocket');
});

// Determine MNQ/MES contract symbol
function getFrontMonthContract(instrument, date) {
    const month = date.getMonth() + 1; // 1-12
    const year = date.getFullYear() % 100; // Last two digits
    if (month <= 3) return `${instrument}H${year}`; // March
    if (month <= 6) return `${instrument}M${year}`; // June
    if (month <= 9) return `${instrument}U${year}`; // September
    return `${instrument}Z${year}`; // December
}

// Fetch candlestick data (for backtesting)
async function fetchCandlestickData(instrument, startDate) {
    const ticker = getFrontMonthContract(instrument, startDate);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    console.log(`Fetching data for ${ticker} from ${startDateStr} to ${endDateStr}`);
    try {
        const response = await rest.stocks.aggregates(ticker, 5, 'minute', startDateStr, endDateStr);
        if (!response.results) {
            throw new Error('No results returned from Polygon.io');
        }
        const candles = response.results.map(candle => ({
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
        // Fallback to mock data for testing
        const mockCandles = Array.from({ length: 100 }, (_, i) => {
            const time = new Date(startDate);
            time.setMinutes(time.getMinutes() + i * 5);
            const basePrice = instrument === 'MNQ' ? 18000 : 5700; // Approximate prices for MNQ and MES
            return {
                time,
                open: basePrice + i,
                high: basePrice + i + 10,
                low: basePrice + i - 10,
                close: basePrice + i + 5,
                volume: 1000 + i * 10,
                isBullish: i % 2 === 0,
            };
        });
        console.log('Using mock data due to fetch error');
        return mockCandles;
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

app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Trading Platform Backend' });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'Backend is running', dailyLoss, tradesToday });
});

app.get('/api/candles', async (req, res) => {
    try {
        const startDateStr = req.query.startDate || new Date(Date.now() - 50 * 5 * 60 * 1000).toISOString().split('T')[0];
        const instrument = req.query.instrument || 'MNQ';
        const startDate = new Date(startDateStr);
        const candles = await fetchCandlestickData(instrument, startDate);
        res.json({ candles });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching candles', details: error.message });
    }
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
