const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { EMA, RSI, ATR } = require('technicalindicators');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_API_URL = 'https://api-fxtrade.oanda.com';

// Trading state
let dailyLoss = 0;
const dailyLossCap = 4500; // 3% of 150K
const riskPerTrade = 900; // 0.6% of 150K
let tradesToday = 0;

app.get('/api/status', (req, res) => {
    res.json({ status: 'Backend is running', dailyLoss, tradesToday });
});

app.get('/api/candles', async (req, res) => {
    try {
        const instrument = 'NAS100_USD';
        const response = await axios.get(`${OANDA_API_URL}/v3/instruments/${instrument}/candles`, {
            headers: { Authorization: `Bearer ${OANDA_API_KEY}` },
            params: { granularity: 'M5', count: 50 }
        });
        res.json(response.data.candles);
    } catch (error) {
        res.status(500).json({ error: 'Error fetching candles', details: error.message });
    }
});

app.post('/api/start-trading', async (req, res) => {
    try {
        // Reset daily stats at the start of the day (simplified)
        const now = new Date();
        if (now.getUTCHours() === 0) {
            dailyLoss = 0;
            tradesToday = 0;
        }

        // Fetch 5-minute candlestick data for MNQ
        const instrument = 'NAS100_USD';
        const candles = await axios.get(`${OANDA_API_URL}/v3/instruments/${instrument}/candles`, {
            headers: { Authorization: `Bearer ${OANDA_API_KEY}` },
            params: { granularity: 'M5', count: 50 }
        });

        const prices = candles.data.candles.map(candle => ({
            time: new Date(candle.time),
            close: parseFloat(candle.mid.c),
            high: parseFloat(candle.mid.h),
            low: parseFloat(candle.mid.l),
            volume: parseInt(candle.volume)
        }));

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

        // Strategy logic
        let tradeSignal = null;

        // 1. Opening Range Breakout (9:45 AM)
        if (hours === 9 && minutes === 45) {
            const rangeCandles = prices.slice(0, 3); // First 15 minutes (9:30-9:45)
            const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
            if (latestPrice.close > rangeHigh && latestRSI > 50 && latestVolume > volumeAvg * 1.2 && isDiscount) {
                tradeSignal = 'buy';
            }
        }

        // 2. Breakout Pullback
        if (!tradeSignal && previousPrice.close < previousEMA && latestPrice.close > latestEMA && latestVolume > volumeAvg * 1.3) {
            if (latestPrice.high > previousPrice.high && latestPrice.close < latestPrice.high && latestRSI > 60 && isDiscount) {
                if (fvg || breakerBlock) {
                    tradeSignal = 'buy';
                }
            }
        }

        // 3. VWAP Bounce (using EMA as a proxy)
        if (!tradeSignal && Math.abs(latestPrice.close - latestEMA) < 1 && latestRSI > 50 && latestVolume > volumeAvg * 1.2 && isDiscount) {
            tradeSignal = 'buy';
        }

        // 4. Mean Reversion
        if (!tradeSignal && latestRSI < 25 && latestVolume > volumeAvg * 1.5 && isDiscount) {
            if (fvg || breakerBlock) {
                tradeSignal = 'buy';
            }
        }

        // 5. Order Block Break
        if (!tradeSignal && breakerBlock && isDiscount) {
            tradeSignal = 'buy';
        }

        // Execute trade
        if (tradeSignal === 'buy') {
            const units = Math.floor(riskPerTrade / 2); // $2 stop loss per unit
            const order = {
                units: units, // 450 units
                instrument: 'NAS100_USD',
                type: 'MARKET',
                positionFill: 'DEFAULT',
                takeProfitOnFill: { price: (latestPrice.close + 8).toString() }, // 8 ticks
                stopLossOnFill: { price: (latestPrice.close - 4).toString() } // 4 ticks
            };
            const response = await axios.post(`${OANDA_API_URL}/v3/accounts/${OANDA_ACCOUNT_ID}/orders`, { order }, {
                headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
            });
            tradesToday++;
            res.json({ message: 'Trade executed', signal: tradeSignal, units, tradeId: response.data.orderCreateTransaction.id });
        } else {
            res.json({ message: 'No trade signal' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Trading error', details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
