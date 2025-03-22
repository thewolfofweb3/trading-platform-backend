const express = require('express');
const axios = require('axios');
require('dotenv').config();
const { EMA, RSI, ATR } = require('technicalindicators');
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

// Default route for root URL
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Trading Platform Backend' });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'Backend is running', dailyLoss, tradesToday });
});

// Fetch candlestick data from Polygon.io
async function fetchCandlestickData(instrument, startDate) {
    try {
        const endDate = new Date().toISOString().split('T')[0]; // Today
        const response = await axios.get(`${POLYGON_API_URL}/v2/aggs/ticker/${instrument}/range/5/minute/${startDate}/${endDate}`, {
            params: {
                apiKey: POLYGON_API_KEY,
            },
        });

        const candles = response.data.results;
        return candles.map(candle => ({
            time: new Date(candle.t),
            open: candle.o,
            high: candle.h,
            low: candle.l,
            close: candle.c,
            volume: candle.v,
            isBullish: candle.c > candle.o,
        }));
    } catch (error) {
        throw new Error(`Error fetching candles: ${error.message}`);
    }
}

app.get('/api/candles', async (req, res) => {
    try {
        const startDate = req.query.startDate || new Date(Date.now() - 50 * 5 * 60 * 1000).toISOString().split('T')[0]; // Default to 50 candles ago if no start date
        const candles = await fetchCandlestickData('QQQ', startDate);

        // Calculate session highs and lows (9:45 AM - 3:30 PM ET)
        const sessionStartHour = 9;
        const sessionStartMinute = 45;
        const sessionEndHour = 15;
        const sessionEndMinute = 30;
        const sessionCandles = candles.filter(candle => {
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

        res.json({ candles, sessionHigh, sessionLow, fibLevels });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching candles', details: error.message });
    }
});

app.post('/api/backtest', async (req, res) => {
    try {
        const instrument = req.query.instrument || 'QQQ';
        const startDate = req.query.startDate;
        if (!startDate) {
            return res.status(400).json({ error: 'Start date is required' });
        }

        // Fetch historical data
        const candles = await fetchCandlestickData(instrument, startDate);
        if (!candles || candles.length === 0) {
            return res.status(404).json({ error: 'No data available for the selected period' });
        }

        // Filter candles to start from the New York session open (9:45 AM ET) on the start date
        const startDateTime = new Date(startDate);
        startDateTime.setUTCHours(13, 45, 0, 0); // 9:45 AM ET = 13:45 UTC
        const filteredCandles = candles.filter(candle => candle.time >= startDateTime);
        if (filteredCandles.length === 0) {
            return res.status(404).json({ error: 'No data available after the New York session open on the selected date' });
        }

        // Backtest state
        let trades = [];
        let netProfit = 0;
        let totalTrades = 0;
        let dailyLoss = 0;
        let tradesToday = 0;
        let lastDay = null;

        // Process each candle sequentially
        for (let i = 0; i < filteredCandles.length; i++) {
            const candle = filteredCandles[i];
            const currentDay = candle.time.toISOString().split('T')[0];

            // Reset daily stats at the start of a new day
            if (lastDay && lastDay !== currentDay) {
                dailyLoss = 0;
                tradesToday = 0;
            }
            lastDay = currentDay;

            // Skip if outside trading window (9:45 AM - 11:30 AM ET and 1:30 PM - 3:30 PM ET)
            const hours = candle.time.getUTCHours() - 4; // Convert UTC to ET
            const minutes = candle.time.getUTCMinutes();
            const isTradingWindow = (hours === 9 && minutes >= 45) || (hours === 10) || (hours === 11 && minutes <= 30) ||
                                   (hours === 13 && minutes >= 30) || (hours === 14) || (hours === 15 && minutes <= 30);
            if (!isTradingWindow || dailyLoss >= dailyLossCap) {
                continue;
            }

            // Use only candles up to the current index for indicators (no look-ahead)
            const prices = filteredCandles.slice(0, i + 1);
            const closes = prices.map(p => p.close);
            const highs = prices.map(p => p.high);
            const lows = prices.map(p => p.low);
            const ema20 = EMA.calculate({ period: 20, values: closes });
            const rsi9 = RSI.calculate({ period: 9, values: closes });
            const atr14 = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
            const volumes = prices.map(p => p.volume);
            const volumeAvg = volumes.slice(-Math.min(10, volumes.length)).reduce((a, b) => a + b, 0) / Math.min(10, volumes.length);

            if (ema20.length < 20 || rsi9.length < 9 || atr14.length < 14) {
                continue; // Skip if indicators are not yet calculated
            }

            const latestPrice = prices[prices.length - 1];
            const previousPrice = prices[prices.length - 2] || latestPrice;
            const latestEMA = ema20[ema20.length - 1];
            const previousEMA = ema20[ema20.length - 2] || latestEMA;
            const latestRSI = rsi9[rsi9.length - 1];
            const latestVolume = latestPrice.volume;
            const latestATR = atr14[atr14.length - 1];

            // Calculate session highs and lows (9:45 AM - 3:30 PM ET)
            const sessionStartHour = 9;
            const sessionStartMinute = 45;
            const sessionEndHour = 15;
            const sessionEndMinute = 30;
            const sessionCandles = prices.filter(candle => {
                const hours = candle.time.getUTCHours() - 4;
                const minutes = candle.time.getUTCMinutes();
                return (hours > sessionStartHour || (hours === sessionStartHour && minutes >= sessionStartMinute)) &&
                       (hours < sessionEndHour || (hours === sessionEndHour && minutes <= sessionEndMinute));
            });

            const sessionHigh = sessionCandles.length > 0 ? Math.max(...sessionCandles.map(c => c.high)) : null;
            const sessionLow = sessionCandles.length > 0 ? Math.min(...sessionCandles.map(c => c.low)) : null;

            // Calculate Fibonacci levels
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

            // PD Arrays (Premium/Discount Zones)
            const fairValue = latestEMA;
            const premiumZone = fairValue + latestATR;
            const discountZone = fairValue - latestATR;
            const isDiscount = latestPrice.close < discountZone;

            // FVG Detection
            let fvg = false;
            if (previousPrice.high < latestPrice.low) {
                fvg = true;
            }

            // Breaker Block Detection
            let breakerBlock = false;
            const bigMoveIndex = prices.slice(0, -1).findIndex((p, j) => Math.abs(p.close - prices[j + 1].close) > 50);
            if (bigMoveIndex !== -1) {
                const orderBlockHigh = prices[bigMoveIndex].high;
                if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                    breakerBlock = true;
                }
            }

            // Confluence: Price Near Fibonacci or Session Levels
            const isNearFibOrSession = fibLevels && (
                Math.abs(latestPrice.close - fibLevels.fib_236) < latestATR ||
                Math.abs(latestPrice.close - fibLevels.fib_382) < latestATR ||
                Math.abs(latestPrice.close - fibLevels.fib_500) < latestATR ||
                Math.abs(latestPrice.close - fibLevels.fib_618) < latestATR ||
                (sessionHigh && Math.abs(latestPrice.close - sessionHigh) < latestATR) ||
                (sessionLow && Math.abs(latestPrice.close - sessionLow) < latestATR)
            );

            // Entry Conditions
            let tradeSignal = null;

            // 1. Opening Range Breakout (9:45 AM)
            if (hours === 9 && minutes === 45) {
                const rangeCandles = prices.slice(Math.max(0, i - 3), i + 1); // Last 3 candles
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

            // 3. VWAP Bounce (using EMA as proxy)
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

            // Simulate trade execution
            if (tradeSignal === 'buy') {
                const units = Math.floor(riskPerTrade / 2); // $2 stop loss per unit
                const stopLoss = latestPrice.close - 4;
                const takeProfit = latestPrice.close + 4;

                // Simulate trade outcome (for backtesting only)
                let profitLoss = 0;
                let tradeClosed = false;
                for (let j = i + 1; j < filteredCandles.length; j++) {
                    const futureCandle = filteredCandles[j];
                    if (futureCandle.low <= stopLoss) {
                        profitLoss = -4 * units; // Loss
                        tradeClosed = true;
                        break;
                    } else if (futureCandle.high >= takeProfit) {
                        profitLoss = 4 * units; // Profit
                        tradeClosed = true;
                        break;
                    }
                }

                if (!tradeClosed) {
                    // If trade doesn't close by the end of the data, calculate profit/loss based on the last candle
                    const lastCandle = filteredCandles[filteredCandles.length - 1];
                    profitLoss = (lastCandle.close - latestPrice.close) * units;
                }

                trades.push({
                    timestamp: candle.time,
                    signal: tradeSignal,
                    units: units,
                    stopLoss: stopLoss,
                    takeProfit: takeProfit,
                    profitLoss: profitLoss,
                });

                totalTrades++;
                netProfit += profitLoss;
                if (profitLoss < 0) {
                    dailyLoss += Math.abs(profitLoss);
                }
                tradesToday++;
            }
        }

        res.json({
            totalTrades: totalTrades,
            netProfit: netProfit,
            trades: trades,
        });
    } catch (error) {
        res.status(500).json({ error: 'Backtesting error', details: error.message });
    }
});

app.post('/api/start-trading', async (req, res) => {
    try {
        const startDate = req.query.startDate || new Date(Date.now() - 50 * 5 * 60 * 1000).toISOString().split('T')[0];
        const candles = await fetchCandlestickData('QQQ', startDate);

        // Process the latest candle for real-time trading
        const latestPrice = candles[candles.length - 1];
        const previousPrice = candles[candles.length - 2] || latestPrice;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const ema20 = EMA.calculate({ period: 20, values: closes });
        const rsi9 = RSI.calculate({ period: 9, values: closes });
        const atr14 = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const volumes = candles.map(c => c.volume);
        const volumeAvg = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;

        const latestEMA = ema20[ema20.length - 1];
        const previousEMA = ema20[ema20.length - 2] || latestEMA;
        const latestRSI = rsi9[rsi9.length - 1];
        const latestVolume = latestPrice.volume;
        const latestATR = atr14[atr14.length - 1];

        // Calculate session highs and lows (9:45 AM - 3:30 PM ET)
        const sessionStartHour = 9;
        const sessionStartMinute = 45;
        const sessionEndHour = 15;
        const sessionEndMinute = 30;
        const sessionCandles = candles.filter(candle => {
            const hours = candle.time.getUTCHours() - 4;
            const minutes = candle.time.getUTCMinutes();
            return (hours > sessionStartHour || (hours === sessionStartHour && minutes >= sessionStartMinute)) &&
                   (hours < sessionEndHour || (hours === sessionEndHour && minutes <= sessionEndMinute));
        });

        const sessionHigh = sessionCandles.length > 0 ? Math.max(...sessionCandles.map(c => c.high)) : null;
        const sessionLow = sessionCandles.length > 0 ? Math.min(...sessionCandles.map(c => c.low)) : null;

        // Calculate Fibonacci levels
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
        const hours = latestPrice.time.getUTCHours() - 4;
        const minutes = latestPrice.time.getUTCMinutes();
        const isTradingWindow = (hours === 9 && minutes >= 45) || (hours === 10) || (hours === 11 && minutes <= 30) ||
                               (hours === 13 && minutes >= 30) || (hours === 14) || (hours === 15 && minutes <= 30);

        if (!isTradingWindow || dailyLoss >= dailyLossCap) {
            return res.json({ message: 'Outside trading window or daily loss cap reached', timestamp: latestPrice.time });
        }

        // PD Arrays (Premium/Discount Zones)
        const fairValue = latestEMA;
        const premiumZone = fairValue + latestATR;
        const discountZone = fairValue - latestATR;
        const isDiscount = latestPrice.close < discountZone;

        // FVG Detection
        let fvg = false;
        if (previousPrice.high < latestPrice.low) {
            fvg = true;
        }

        // Breaker Block Detection
        let breakerBlock = false;
        const bigMoveIndex = candles.slice(0, -1).findIndex((p, j) => Math.abs(p.close - candles[j + 1].close) > 50);
        if (bigMoveIndex !== -1) {
            const orderBlockHigh = candles[bigMoveIndex].high;
            if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                breakerBlock = true;
            }
        }

        // Confluence: Price Near Fibonacci or Session Levels
        const isNearFibOrSession = fibLevels && (
            Math.abs(latestPrice.close - fibLevels.fib_236) < latestATR ||
            Math.abs(latestPrice.close - fibLevels.fib_382) < latestATR ||
            Math.abs(latestPrice.close - fibLevels.fib_500) < latestATR ||
            Math.abs(latestPrice.close - fibLevels.fib_618) < latestATR ||
            (sessionHigh && Math.abs(latestPrice.close - sessionHigh) < latestATR) ||
            (sessionLow && Math.abs(latestPrice.close - sessionLow) < latestATR)
        );

        // Entry Conditions
        let tradeSignal = null;

        // 1. Opening Range Breakout (9:45 AM)
        if (hours === 9 && minutes === 45) {
            const rangeCandles = candles.slice(Math.max(0, candles.length - 4), candles.length - 1); // Last 3 candles
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

        // 3. VWAP Bounce (using EMA as proxy)
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

        if (tradeSignal === 'buy') {
            const units = Math.floor(riskPerTrade / 2); // $2 stop loss per unit
            const stopLoss = latestPrice.close - 4;
            const takeProfit = latestPrice.close + 4;
            tradesToday++;
            res.json({ message: 'Trade executed', signal: tradeSignal, units, stopLoss, takeProfit, timestamp: latestPrice.time });
        } else {
            res.json({ message: 'No trade signal', timestamp: latestPrice.time });
        }
    } catch (error) {
        res.status(500).json({ error: 'Trading error', details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
