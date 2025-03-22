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
let lastDay = null;

// Default route for root URL
app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the Trading Platform Backend' });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'Backend is running', dailyLoss, tradesToday });
});

// Fetch candlestick data from Polygon.io for MNQ
async function fetchCandlestickData(instrument, startDate) {
    try {
        const endDate = new Date().toISOString().split('T')[0]; // Today
        console.log(`Fetching data for ${instrument} from ${startDate} to ${endDate}`);
        const response = await axios.get(`${POLYGON_API_URL}/v2/aggs/ticker/${instrument}/range/5/minute/${startDate}/${endDate}`, {
            params: {
                apiKey: POLYGON_API_KEY,
            },
        });

        if (!response.data.results) {
            throw new Error('No results returned from Polygon.io');
        }

        const candles = response.data.results;
        console.log(`Fetched ${candles.length} candles`);
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
        console.error('Error fetching candles:', error.message);
        throw new Error(`Error fetching candles: ${error.message}`);
    }
}

app.get('/api/candles', async (req, res) => {
    try {
        const startDate = req.query.startDate || new Date(Date.now() - 50 * 5 * 60 * 1000).toISOString().split('T')[0];
        const candles = await fetchCandlestickData('I:MNQH25', startDate); // MNQ March 2025 contract

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

        res.json({ candles, sessionHigh, sessionLow, fibLevels });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching candles', details: error.message });
    }
});

app.post('/api/backtest', async (req, res) => {
    try {
        const instrument = req.query.instrument || 'I:MNQH25'; // MNQ March 2025 contract
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

        console.log(`Processing ${filteredCandles.length} candles for backtest`);

        // Backtest state
        let trades = [];
        let netProfit = 0;
        let totalTrades = 0;
        let dailyLoss = 0;
        let tradesToday = 0;
        let lastDay = null;

        // Process each candle sequentially
        for (let i = 50; i < filteredCandles.length; i++) { // Start after enough candles for support/resistance (50 lookback)
            const candle = filteredCandles[i];
            const currentDay = candle.time.toISOString().split('T')[0];

            // Reset daily stats at the start of a new day
            if (lastDay && lastDay !== currentDay) {
                dailyLoss = 0;
                tradesToday = 0;
            }
            lastDay = currentDay;

            // Skip if outside trading window (9:45 AM - 11:30 AM ET and 1:30 PM - 3:30 PM ET)
            const hours = candle.time.getUTCHours() - 4;
            const minutes = candle.time.getUTCMinutes();
            const isTradingWindow = (hours === 9 && minutes >= 45) || (hours === 10) || (hours === 11 && minutes <= 30) ||
                                   (hours === 13 && minutes >= 30) || (hours === 14) || (hours === 15 && minutes <= 30);
            if (!isTradingWindow || dailyLoss >= dailyLossCap) {
                continue;
            }

            // Check daily trade limit
            if (tradesToday >= 5) {
                // Only allow golden trades after 5 trades
                let isGoldenTrade = false;

                // Use candles up to the current index for indicators (no look-ahead)
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
                    console.log(`Skipping candle at ${candle.time}: insufficient data for indicators`);
                    continue;
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
                const isPremium = latestPrice.close > premiumZone;

                // FVG Detection
                let fvgBullish = false;
                let fvgBearish = false;
                if (previousPrice.high < latestPrice.low) {
                    fvgBullish = true;
                }
                if (previousPrice.low > latestPrice.high) {
                    fvgBearish = true;
                }

                // Breaker Block Detection
                let breakerBlockBullish = false;
                let breakerBlockBearish = false;
                const bigMoveIndexUp = prices.slice(0, -1).findIndex((p, j) => Math.abs(p.close - prices[j + 1].close) > 50 && p.close < prices[j + 1].close);
                const bigMoveIndexDown = prices.slice(0, -1).findIndex((p, j) => Math.abs(p.close - prices[j + 1].close) > 50 && p.close > prices[j + 1].close);
                if (bigMoveIndexUp !== -1) {
                    const orderBlockHigh = prices[bigMoveIndexUp].high;
                    if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                        breakerBlockBullish = true;
                    }
                }
                if (bigMoveIndexDown !== -1) {
                    const orderBlockLow = prices[bigMoveIndexDown].low;
                    if (latestPrice.low < orderBlockLow && latestPrice.close > orderBlockLow && latestVolume > volumeAvg * 1.2) {
                        breakerBlockBearish = true;
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

                // Golden Trade Conditions
                if (latestRSI > 70 && latestVolume > volumeAvg * 1.5 && isNearFibOrSession && (fvgBullish || breakerBlockBullish)) {
                    isGoldenTrade = true; // Golden Buy
                } else if (latestRSI < 30 && latestVolume > volumeAvg * 1.5 && isNearFibOrSession && (fvgBearish || breakerBlockBearish)) {
                    isGoldenTrade = true; // Golden Sell
                }

                if (!isGoldenTrade) {
                    continue; // Skip if not a golden trade after 5 trades
                }
            }

            // Use candles up to the current index for indicators (no look-ahead)
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
                console.log(`Skipping candle at ${candle.time}: insufficient data for indicators`);
                continue;
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

            // Calculate Support/Resistance Levels (Swing Highs/Lows over last 50 candles)
            const lookback = 50;
            const recentCandles = prices.slice(Math.max(0, i - lookback), i + 1);
            const swingHighs = recentCandles.map((c, idx) => ({
                high: c.high,
                idx: idx
            })).sort((a, b) => b.high - a.high).slice(0, 3); // Top 3 swing highs
            const swingLows = recentCandles.map((c, idx) => ({
                low: c.low,
                idx: idx
            })).sort((a, b) => a.low - b.low).slice(0, 3); // Top 3 swing lows
            const resistanceLevels = swingHighs.map(sh => sh.high);
            const supportLevels = swingLows.map(sl => sl.low);

            // Find nearest support and resistance
            const nearestSupport = supportLevels.filter(level => level < latestPrice.close).sort((a, b) => b - a)[0] || supportLevels[0];
            const nearestResistance = resistanceLevels.filter(level => level > latestPrice.close).sort((a, b) => a - b)[0] || resistanceLevels[0];

            // PD Arrays (Premium/Discount Zones)
            const fairValue = latestEMA;
            const premiumZone = fairValue + latestATR;
            const discountZone = fairValue - latestATR;
            const isDiscount = latestPrice.close < discountZone;
            const isPremium = latestPrice.close > premiumZone;

            // FVG Detection
            let fvgBullish = false;
            let fvgBearish = false;
            if (previousPrice.high < latestPrice.low) {
                fvgBullish = true;
            }
            if (previousPrice.low > latestPrice.high) {
                fvgBearish = true;
            }

            // Breaker Block Detection
            let breakerBlockBullish = false;
            let breakerBlockBearish = false;
            const bigMoveIndexUp = prices.slice(0, -1).findIndex((p, j) => Math.abs(p.close - prices[j + 1].close) > 50 && p.close < prices[j + 1].close);
            const bigMoveIndexDown = prices.slice(0, -1).findIndex((p, j) => Math.abs(p.close - prices[j + 1].close) > 50 && p.close > prices[j + 1].close);
            if (bigMoveIndexUp !== -1) {
                const orderBlockHigh = prices[bigMoveIndexUp].high;
                if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                    breakerBlockBullish = true;
                }
            }
            if (bigMoveIndexDown !== -1) {
                const orderBlockLow = prices[bigMoveIndexDown].low;
                if (latestPrice.low < orderBlockLow && latestPrice.close > orderBlockLow && latestVolume > volumeAvg * 1.2) {
                    breakerBlockBearish = true;
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

            // Entry Conditions (Adjusted for frequency and long/short trades)
            let tradeSignal = null;

            // 1. Opening Range Breakout (9:45 AM)
            if (hours === 9 && minutes === 45) {
                const rangeCandles = prices.slice(Math.max(0, i - 3), i + 1);
                const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
                const rangeLow = Math.min(...rangeCandles.map(c => c.low));
                if (latestPrice.close > rangeHigh && latestRSI > 60 && latestVolume > volumeAvg * 1.2 && isDiscount) {
                    tradeSignal = 'buy';
                } else if (latestPrice.close < rangeLow && latestRSI < 40 && latestVolume > volumeAvg * 1.2 && isPremium) {
                    tradeSignal = 'sell';
                }
            }

            // 2. Breakout Pullback
            if (!tradeSignal) {
                if (previousPrice.close < previousEMA && latestPrice.close > latestEMA && latestVolume > volumeAvg * 1.2 && latestRSI > 60 && isDiscount) {
                    tradeSignal = 'buy';
                } else if (previousPrice.close > previousEMA && latestPrice.close < latestEMA && latestVolume > volumeAvg * 1.2 && latestRSI < 40 && isPremium) {
                    tradeSignal = 'sell';
                }
            }

            // 3. VWAP Bounce (using EMA as proxy)
            if (!tradeSignal) {
                if (Math.abs(latestPrice.close - latestEMA) < 0.5 && latestRSI > 60 && latestVolume > volumeAvg * 1.2 && isDiscount) {
                    tradeSignal = 'buy';
                } else if (Math.abs(latestPrice.close - latestEMA) < 0.5 && latestRSI < 40 && latestVolume > volumeAvg * 1.2 && isPremium) {
                    tradeSignal = 'sell';
                }
            }

            // 4. Mean Reversion
            if (!tradeSignal) {
                if (latestRSI < 30 && latestVolume > volumeAvg * 1.5 && isDiscount) {
                    tradeSignal = 'buy';
                } else if (latestRSI > 70 && latestVolume > volumeAvg * 1.5 && isPremium) {
                    tradeSignal = 'sell';
                }
            }

            // 5. Order Block Break
            if (!tradeSignal) {
                if (breakerBlockBullish && isDiscount && latestRSI > 60) {
                    tradeSignal = 'buy';
                } else if (breakerBlockBearish && isPremium && latestRSI < 40) {
                    tradeSignal = 'sell';
                }
            }

            // Simulate trade execution
            if (tradeSignal) {
                const entryPrice = latestPrice.close;
                const stopLoss = tradeSignal === 'buy' ? nearestSupport : nearestResistance;
                const takeProfit = tradeSignal === 'buy' ? nearestResistance : nearestSupport;

                // Ensure stop-loss and take-profit are valid
                if (!stopLoss || !takeProfit || stopLoss === takeProfit) {
                    console.log(`Skipping trade at ${candle.time}: Invalid stop-loss or take-profit`);
                    continue;
                }

                // Calculate stop-loss distance
                const stopLossDistance = tradeSignal === 'buy' ? entryPrice - stopLoss : stopLoss - entryPrice;
                if (stopLossDistance <= 0) {
                    console.log(`Skipping trade at ${candle.time}: Invalid stop-loss distance`);
                    continue;
                }

                // Calculate number of contracts based on risk
                const riskPerContract = stopLossDistance * 2; // $2 per point for MNQ
                let units = Math.floor(riskPerTrade / riskPerContract);
                units = Math.min(units, 35); // Cap at 35 contracts

                // Ensure take-profit distance is approximately 2x stop-loss distance
                const targetTakeProfitDistance = stopLossDistance * 2;
                const adjustedTakeProfit = tradeSignal === 'buy' ? entryPrice + targetTakeProfitDistance : entryPrice - targetTakeProfitDistance;

                // Simulate trade outcome
                let profitLoss = 0;
                let tradeClosed = false;
                for (let j = i + 1; j < filteredCandles.length; j++) {
                    const futureCandle = filteredCandles[j];
                    if (tradeSignal === 'buy') {
                        if (futureCandle.low <= stopLoss) {
                            profitLoss = -stopLossDistance * units * 2; // Loss based on stop-loss distance
                            tradeClosed = true;
                            break;
                        } else if (futureCandle.high >= adjustedTakeProfit) {
                            profitLoss = targetTakeProfitDistance * units * 2; // Win based on take-profit distance
                            tradeClosed = true;
                            break;
                        }
                    } else {
                        if (futureCandle.high >= stopLoss) {
                            profitLoss = -stopLossDistance * units * 2; // Loss based on stop-loss distance
                            tradeClosed = true;
                            break;
                        } else if (futureCandle.low <= adjustedTakeProfit) {
                            profitLoss = targetTakeProfitDistance * units * 2; // Win based on take-profit distance
                            tradeClosed = true;
                            break;
                        }
                    }
                }

                if (!tradeClosed) {
                    const lastCandle = filteredCandles[filteredCandles.length - 1];
                    const priceDiff = tradeSignal === 'buy' ? (lastCandle.close - entryPrice) : (entryPrice - lastCandle.close);
                    profitLoss = priceDiff * units * 2;
                    profitLoss = tradeSignal === 'buy' ?
                        Math.max(Math.min(profitLoss, targetTakeProfitDistance * units * 2), -stopLossDistance * units * 2) :
                        Math.max(Math.min(profitLoss, targetTakeProfitDistance * units * 2), -stopLossDistance * units * 2);
                }

                trades.push({
                    timestamp: candle.time,
                    signal: tradeSignal,
                    entryPrice: entryPrice,
                    units: units,
                    stopLoss: stopLoss,
                    takeProfit: adjustedTakeProfit,
                    profitLoss: profitLoss,
                });

                totalTrades++;
                netProfit += profitLoss;
                if (profitLoss < 0) {
                    dailyLoss += Math.abs(profitLoss);
                }
                tradesToday++;
                console.log(`Trade executed at ${candle.time}: Signal: ${tradeSignal}, Entry: ${entryPrice}, Units: ${units}, Profit/Loss: $${profitLoss}`);
            }
        }

        console.log(`Backtest completed: ${totalTrades} trades, Net Profit: $${netProfit}`);
        res.json({
            totalTrades: totalTrades,
            netProfit: netProfit,
            trades: trades,
        });
    } catch (error) {
        console.error('Backtesting error:', error.message);
        res.status(500).json({ error: 'Backtesting error', details: error.message });
    }
});

app.post('/api/start-trading', async (req, res) => {
    try {
        const startDate = req.query.startDate || new Date(Date.now() - 50 * 5 * 60 * 1000).toISOString().split('T')[0];
        const candles = await fetchCandlestickData('I:MNQH25', startDate);

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
        const currentDay = latestPrice.time.toISOString().split('T')[0];
        const isTradingWindow = (hours === 9 && minutes >= 45) || (hours === 10) || (hours === 11 && minutes <= 30) ||
                               (hours === 13 && minutes >= 30) || (hours === 14) || (hours === 15 && minutes <= 30);

        // Reset daily stats if new day
        if (lastDay && lastDay !== currentDay) {
            dailyLoss = 0;
            tradesToday = 0;
        }
        lastDay = currentDay;

        if (!isTradingWindow || dailyLoss >= dailyLossCap) {
            return res.json({ message: 'Outside trading window or daily loss cap reached', timestamp: latestPrice.time });
        }

        // Check daily trade limit
        if (tradesToday >= 5) {
            // Only allow golden trades after 5 trades
            let isGoldenTrade = false;

            const fairValue = latestEMA;
            const premiumZone = fairValue + latestATR;
            const discountZone = fairValue - latestATR;
            const isDiscount = latestPrice.close < discountZone;
            const isPremium = latestPrice.close > premiumZone;

            let fvgBullish = false;
            let fvgBearish = false;
            if (previousPrice.high < latestPrice.low) {
                fvgBullish = true;
            }
            if (previousPrice.low > latestPrice.high) {
                fvgBearish = true;
            }

            let breakerBlockBullish = false;
            let breakerBlockBearish = false;
            const bigMoveIndexUp = candles.slice(0, -1).findIndex((p, j) => Math.abs(p.close - candles[j + 1].close) > 50 && p.close < candles[j + 1].close);
            const bigMoveIndexDown = candles.slice(0, -1).findIndex((p, j) => Math.abs(p.close - candles[j + 1].close) > 50 && p.close > candles[j + 1].close);
            if (bigMoveIndexUp !== -1) {
                const orderBlockHigh = candles[bigMoveIndexUp].high;
                if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                    breakerBlockBullish = true;
                }
            }
            if (bigMoveIndexDown !== -1) {
                const orderBlockLow = candles[bigMoveIndexDown].low;
                if (latestPrice.low < orderBlockLow && latestPrice.close > orderBlockLow && latestVolume > volumeAvg * 1.2) {
                    breakerBlockBearish = true;
                }
            }

            const isNearFibOrSession = fibLevels && (
                Math.abs(latestPrice.close - fibLevels.fib_236) < latestATR ||
                Math.abs(latestPrice.close - fibLevels.fib_382) < latestATR ||
                Math.abs(latestPrice.close - fibLevels.fib_500) < latestATR ||
                Math.abs(latestPrice.close - fibLevels.fib_618) < latestATR ||
                (sessionHigh && Math.abs(latestPrice.close - sessionHigh) < latestATR) ||
                (sessionLow && Math.abs(latestPrice.close - sessionLow) < latestATR)
            );

            if (latestRSI > 70 && latestVolume > volumeAvg * 1.5 && isNearFibOrSession && (fvgBullish || breakerBlockBullish)) {
                isGoldenTrade = true; // Golden Buy
            } else if (latestRSI < 30 && latestVolume > volumeAvg * 1.5 && isNearFibOrSession && (fvgBearish || breakerBlockBearish)) {
                isGoldenTrade = true; // Golden Sell
            }

            if (!isGoldenTrade) {
                return res.json({ message: 'Daily trade limit reached, no golden opportunity', timestamp: latestPrice.time });
            }
        }

        // PD Arrays (Premium/Discount Zones)
        const fairValue = latestEMA;
        const premiumZone = fairValue + latestATR;
        const discountZone = fairValue - latestATR;
        const isDiscount = latestPrice.close < discountZone;
        const isPremium = latestPrice.close > premiumZone;

        // FVG Detection
        let fvgBullish = false;
        let fvgBearish = false;
        if (previousPrice.high < latestPrice.low) {
            fvgBullish = true;
        }
        if (previousPrice.low > latestPrice.high) {
            fvgBearish = true;
        }

        // Breaker Block Detection
        let breakerBlockBullish = false;
        let breakerBlockBearish = false;
        const bigMoveIndexUp = candles.slice(0, -1).findIndex((p, j) => Math.abs(p.close - candles[j + 1].close) > 50 && p.close < candles[j + 1].close);
        const bigMoveIndexDown = candles.slice(0, -1).findIndex((p, j) => Math.abs(p.close - candles[j + 1].close) > 50 && p.close > candles[j + 1].close);
        if (bigMoveIndexUp !== -1) {
            const orderBlockHigh = candles[bigMoveIndexUp].high;
            if (latestPrice.high > orderBlockHigh && latestPrice.close < orderBlockHigh && latestVolume > volumeAvg * 1.2) {
                breakerBlockBullish = true;
            }
        }
        if (bigMoveIndexDown !== -1) {
            const orderBlockLow = candles[bigMoveIndexDown].low;
            if (latestPrice.low < orderBlockLow && latestPrice.close > orderBlockLow && latestVolume > volumeAvg * 1.2) {
                breakerBlockBearish = true;
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

        // Calculate Support/Resistance Levels (Swing Highs/Lows over last 50 candles)
        const lookback = 50;
        const recentCandles = candles.slice(Math.max(0, candles.length - lookback - 1), candles.length);
        const swingHighs = recentCandles.map((c, idx) => ({
            high: c.high,
            idx: idx
        })).sort((a, b) => b.high - a.high).slice(0, 3); // Top 3 swing highs
        const swingLows = recentCandles.map((c, idx) => ({
            low: c.low,
            idx: idx
        })).sort((a, b) => a.low - b.low).slice(0, 3); // Top 3 swing lows
        const resistanceLevels = swingHighs.map(sh => sh.high);
        const supportLevels = swingLows.map(sl => sl.low);

        // Find nearest support and resistance
        const nearestSupport = supportLevels.filter(level => level < latestPrice.close).sort((a, b) => b - a)[0] || supportLevels[0];
        const nearestResistance = resistanceLevels.filter(level => level > latestPrice.close).sort((a, b) => a - b)[0] || resistanceLevels[0];

        // Entry Conditions
        let tradeSignal = null;

        // 1. Opening Range Breakout (9:45 AM)
        if (hours === 9 && minutes === 45) {
            const rangeCandles = candles.slice(Math.max(0, candles.length - 4), candles.length - 1);
            const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
            const rangeLow = Math.min(...rangeCandles.map(c => c.low));
            if (latestPrice.close > rangeHigh && latestRSI > 60 && latestVolume > volumeAvg * 1.2 && isDiscount) {
                tradeSignal = 'buy';
            } else if (latestPrice.close < rangeLow && latestRSI < 40 && latestVolume > volumeAvg * 1.2 && isPremium) {
                tradeSignal = 'sell';
            }
        }

        // 2. Breakout Pullback
        if (!tradeSignal) {
            if (previousPrice.close < previousEMA && latestPrice.close > latestEMA && latestVolume > volumeAvg * 1.2 && latestRSI > 60 && isDiscount) {
                tradeSignal = 'buy';
            } else if (previousPrice.close > previousEMA && latestPrice.close < latestEMA && latestVolume > volumeAvg * 1.2 && latestRSI < 40 && isPremium) {
                tradeSignal = 'sell';
            }
        }

        // 3. VWAP Bounce (using EMA as proxy)
        if (!tradeSignal) {
            if (Math.abs(latestPrice.close - latestEMA) < 0.5 && latestRSI > 60 && latestVolume > volumeAvg * 1.2 && isDiscount) {
                tradeSignal = 'buy';
            } else if (Math.abs(latestPrice.close - latestEMA) < 0.5 && latestRSI < 40 && latestVolume > volumeAvg * 1.2 && isPremium) {
                tradeSignal = 'sell';
            }
        }

        // 4. Mean Reversion
        if (!tradeSignal) {
            if (latestRSI < 30 && latestVolume > volumeAvg * 1.5 && isDiscount) {
                tradeSignal = 'buy';
            } else if (latestRSI > 70 && latestVolume > volumeAvg * 1.5 && isPremium) {
                tradeSignal = 'sell';
            }
        }

        // 5. Order Block Break
        if (!tradeSignal) {
            if (breakerBlockBullish && isDiscount && latestRSI > 60) {
                tradeSignal = 'buy';
            } else if (breakerBlockBearish && isPremium && latestRSI < 40) {
                tradeSignal = 'sell';
            }
        }

        if (tradeSignal) {
            const entryPrice = latestPrice.close;
            const stopLoss = tradeSignal === 'buy' ? nearestSupport : nearestResistance;
            const takeProfit = tradeSignal === 'buy' ? nearestResistance : nearestSupport;

            // Ensure stop-loss and take-profit are valid
            if (!stopLoss || !takeProfit || stopLoss === takeProfit) {
                return res.json({ message: 'Invalid stop-loss or take-profit', timestamp: latestPrice.time });
            }

            // Calculate stop-loss distance
            const stopLossDistance = tradeSignal === 'buy' ? entryPrice - stopLoss : stopLoss - entryPrice;
            if (stopLossDistance <= 0) {
                return res.json({ message: 'Invalid stop-loss distance', timestamp: latestPrice.time });
            }

            // Calculate number of contracts based on risk
            const riskPerContract = stopLossDistance * 2; // $2 per point for MNQ
            let units = Math.floor(riskPerTrade / riskPerContract);
            units = Math.min(units, 35); // Cap at 35 contracts

            // Ensure take-profit distance is approximately 2x stop-loss distance
            const targetTakeProfitDistance = stopLossDistance * 2;
            const adjustedTakeProfit = tradeSignal === 'buy' ? entryPrice + targetTakeProfitDistance : entryPrice - targetTakeProfitDistance;

            tradesToday++;
            res.json({
                message: 'Trade executed',
                signal: tradeSignal,
                entryPrice: entryPrice,
                units: units,
                stopLoss: stopLoss,
                takeProfit: adjustedTakeProfit,
                timestamp: latestPrice.time
            });
        } else {
            res.json({ message: 'No trade signal', timestamp: latestPrice.time });
        }
    } catch (error) {
        console.error('Trading error:', error.message);
        res.status(500).json({ error: 'Trading error', details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
