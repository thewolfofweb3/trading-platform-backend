// backend/src/server.js
const express = require('express');
const app = express();
const backtestRouter = require('./controllers/backtest-controller');

app.use(express.json());
app.use('/', backtestRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
