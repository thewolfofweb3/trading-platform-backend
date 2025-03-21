const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { EMA, RSI, ATR } = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ALPACA_API_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;
const ALPACA_API_URL = 'https://paper-api.alpaca.markets'; // Paper trading URL

// Trading state
let dailyLoss = 0;
const dailyLossCap = 4500; // 3% of 150K
const riskPerTrade = 900; // 0.6% of 150K
let tradesToday = 0;

// Default route for root URL
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Trading Platform Backend' });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'Backend is running', dailyLoss, tradesToday });
});

// Helper function to fetch candlestick data from Alpaca
async function fetchCandlestickData() {
    try {
        const response = await axios.get(`${ALPACA_API_URL}/v2/stocks/QQQ/bars`, {
            headers: {
                'APCA-API-KEY-ID': ALPACA_API_KEY,
                'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
            },
            params: {
                timeframe: '5Min',
                limit: 50,
            },
        });

        const bars = response.data.bars;
        return bars.map(bar => ({
            time: new Date(bar.t),
            close: bar.c,
            high: bar.h,
            low: bar.l,
            volume: bar.v,
            isBullish: bar.c > bar.o,
        }));
    } catch (error) {
        throw new Error(`Error fetching candles: ${error.message}`);
    }
}

app.post('/api/start-trading', async (req, res) => {
    try {
        // Reset daily stats at the start of the day (simplified)
        const now = new Date();
        if (now.getUTCHours() === 0) {
            dailyLoss = 0;
            tradesToday = 0;
        }

        // Fetch 5-minute candlestick data for QQQ
        const prices = await fetchCandlestickData();

        // Calculate indicators
        const closes = prices.map(p => p.close);
        const highs = prices.map(p => p.high);
        const lows = prices.map(p => p.low);
        const ema20 = EMA.calculate({ period: 20, values: closes });
        const rsi9 = RSI.calculate({ period: 9, values: closes });
        const atr14 = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const volumes = prices.map(p => p.volume);
        const volumeAvg = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;

        const latestPrice = prices[prices.length - 1];
        const previousPrice = prices[prices.length - 2];
        const latestEMA = ema20[ema20.length - 1];
        const previousEMA = ema20[ema20.length - 2];
        const latestRSI = rsi9[rsi9.length - 1];
        const latestVolume = latestPrice.volume;
        const latestATR = atr14[atr14.length - 1];

        // Calculate session highs and lows (9:45 AM - 3:30 PM ET)
        const sessionStartHour = 9;
        const sessionStartMinute = 45;
        const sessionEndHour = 15;
        const sessionEndMinute = 30;
        const sessionCandles = prices.filter(candle => {
            const hours = candle.time.getUTCHours() - 4; // Convert UTC to ET
            const minutes = candle.time.getUTCMinutes();
            return (hours > sessionStartHour || (hours === sessionStartHour && minutes >= sessionStartMinute)) &&
                   (hours < sessionEndHour || (hours === sessionEndHour && minutes <= sessionEndMinute));
        });

        const sessionHigh = sessionCandles.length > 0 ? Math.max(...sessionCandles.map(c => c.high)) : null;
        const sessionLow = sessionCandles.length > 0 ? Math.min(...sessionCandles.map(c => c.low)) : null;

        // Calculate Fibonacci levels (based on session high and low)
        const fibLevels = sessionHigh && sessionLow ? {
            high: sessionHigh,
            low: sessionLow,
            fib_0: sessionHigh,
            fib_236: sessionHigh - (sessionHigh - sessionLow) * 0.236,
            fib_382: sessionHigh - (sessionHigh - sessionLow) * 0.382,
            fib_500: sessionHigh - (sessionHigh - sessionLow) * 0.500,
            fib_618: sessionHigh - (sessionHigh - sessionLow) * 0.618,
            fib_100: sessionLow,
        } : null;

        // Check time window (9:45 AM - 11:30 AM ET and 1:30 PM - 3:30 PM ET)
        const hours = latestPrice.time.getUTCHours() - 4; // Convert UTC to ET
        const minutes = latestPrice.time.getUTCMinutes();
        const isTradingWindow = (hours === 9 && minutes >= 45) || (hours === 10) || (hours === 11 && minutes <= 30) ||
                               (hours === 13 && minutes >= 30) || (hours === 14) || (hours === 15 && minutes <= 30);

        if (!isTradingWindow || dailyLoss >= dailyLossCap) {
            return res.json({ message: 'Outside trading window or daily loss cap reached' });
        }

        // PD Arrays (Premium/Discount Zones)
        const fairValue = latestEMA;
        const premiumZone = fairValue + latestATR;
        const discountZone = fairValue - latestATR;
        const isDiscount = latestPrice.close < discountZone;

        // FVG Detection
        let fvg = null;
        if (previousPrice.high < latestPrice.low) {
            fvg = { type: 'bullish', range: [previousPrice.high, latestPrice.low] };
        }

        // Breaker Block Detection
        let breakerBlock = null;
        const bigMoveIndex = prices.slice(0, -1).findIndex((p, i) => Math.abs(p.close - prices[i + 1].close) > 50);
        if (bigMoveIndex !== -1) {
            const orderBlockHigh = prices[bigMoveIndex].high;
            if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                breakerBlock = { level: orderBlockHigh };
            }
        }

        // Strategy logic (tightened for higher win rate, with Fibonacci and session levels)
        let tradeSignal = null;

        // Check if price is near Fibonacci levels or session levels for confluence
        const isNearFibOrSession = fibLevels && (
            Math.abs(latestPrice.close - fibLevels.fib_236) < latestATR ||
            Math.abs(latestPrice.close - fibLevels.fib_382) < latestATR ||
            Math.abs(latestPrice.close - fibLevels.fib_500) < latestATR ||
            Math.abs(latestPrice.close - fibLevels.fib_618) < latestATR ||
            (sessionHigh && Math.abs(latestPrice.close - sessionHigh) < latestATR) ||
            (sessionLow && Math.abs(latestPrice.close - sessionLow) < latestATR)
        );

        // 1. Opening Range Breakout (9:45 AM)
        if (hours === 9 && minutes === 45) {
            const rangeCandles = prices.slice(0, 3); // First 15 minutes (9:30-9:45)
            const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
            if (latestPrice.close > rangeHigh && latestRSI > 70 && latestVolume > volumeAvg * 1.5 && isDiscount && isNearFibOrSession) {
                tradeSignal = 'buy';
            }
        }

        // 2. Breakout Pullback
        if (!tradeSignal && previousPrice.close < previousEMA && latestPrice.close > latestEMA && latestVolume > volumeAvg * 1.5) {
            if (latestPrice.high > previousPrice.high && latestPrice.close < latestPrice.high && latestRSI > 70 && isDiscount && isNearFibOrSession) {
                if (fvg || breakerBlock) {
                    tradeSignal = 'buy';
                }
            }
        }

        // 3. VWAP Bounce (using EMA as a proxy)
        if (!tradeSignal && Math.abs(latestPrice.close - latestEMA) < 0.5 && latestRSI > 70 && latestVolume > volumeAvg * 1.5 && isDiscount && isNearFibOrSession) {
            tradeSignal = 'buy';
        }

        // 4. Mean Reversion
        if (!tradeSignal && latestRSI < 20 && latestVolume > volumeAvg * 2.0 && isDiscount && isNearFibOrSession) {
            if (fvg || breakerBlock) {
                tradeSignal = 'buy';
            }
        }

        // 5. Order Block Break
        if (!tradeSignal && breakerBlock && isDiscount && latestRSI > 70 && isNearFibOrSession) {
            tradeSignal = 'buy';
        }

        // Execute trade
        if (tradeSignal === 'buy') {
            const units = Math.floor(riskPerTrade / 2); // $2 stop loss per unit
            const order = {
                symbol: 'QQQ',
                qty: units, // Alpaca uses qty for shares
                side: 'buy',
                type: 'market',
                time_in_force: 'gtc',
                take_profit: {
                    limit_price: (latestPrice.close + 4).toString(), // 4 ticks (1:1 R:R)
                },
                stop_loss: {
                    stop_price: (latestPrice.close - 4).toString(), // 4 ticks
                },
            };
            const response = await axios.post(`${ALPACA_API_URL}/v2/orders`, order, {
                headers: {
                    'APCA-API-KEY-ID': ALPACA_API_KEY,
                    'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
                },
            });
            tradesToday++;
            res.json({ message: 'Trade executed', signal: tradeSignal, units, tradeId: response.data.id });
        } else {
            res.json({ message: 'No trade signal' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Trading error', details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
