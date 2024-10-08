const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const CryptoJS = require("crypto-js");
const winston = require("winston");
const { Telegraf } = require("telegraf");
const dotenv = require("dotenv");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  defaultMeta: { service: "user-service" },
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

dotenv.config();

const app = express();
const port = 3000;

// BingX API configuration
const API_KEY = process.env.BINGX_API_KEY;
const SECRET_KEY = process.env.BINGX_SECRET_KEY;
const BASE_URL = 'https://open-api.bingx.com';

// Telegram Bot configuration
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Use the logger in your error middleware
const errorMiddleware = (err, req, res, next) => {
  logger.error(`${err.message}`, { stack: err.stack });

  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  // Log the error
  console.error(`[${new Date().toISOString()}] ${err.stack}`);

  // Send error response
  res.status(statusCode).json({
    status: "error",
    statusCode,
    message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

// Use the middleware
app.use(errorMiddleware);

// Helper function to generate signature
function generateSignature(params, secretKey) {
  const orderedParams = Object.keys(params)
    .sort()
    .reduce((obj, key) => {
      if (params[key] !== "") {
        obj[key] = params[key];
      }
      return obj;
    }, {});

  const queryString = Object.entries(orderedParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  return CryptoJS.HmacSHA256(queryString, secretKey).toString(CryptoJS.enc.Hex);
}

const useTheOther = false;
// Function to make authenticated API requests
async function makeRequest(method, endpoint, params = {}) {
  const timestamp = Date.now();
  const fullParams = {
    ...params,
    timestamp,
  };

  if (Object.keys(params).length === 0 && method === "GET") {
    // For GET requests without additional params, we don't need to include them in the signature
    fullParams.signature = generateSignature({ timestamp }, SECRET_KEY);
  } else {
    fullParams.signature = generateSignature(fullParams, SECRET_KEY);
  }

  const url = `${BASE_URL}${endpoint}`;

  const config = {
    method,
    url,
    headers: {
      "X-BX-APIKEY": API_KEY,
    },
  };

  if (method === "GET") {
    config.params = fullParams;
  } else {
    config.data = fullParams;
  }

  try {
    const response = await axios(config);
    console.log(response.data);
    return response.data;
  } catch (error) {
    console.error(
      "API request failed:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

// Get account balance
async function checkServerTime() {
  try {
    const response = await makeRequest("GET", "/openApi/swap/v2/time");
    console.log(response);

    const serverTime = response.data.serverTime;
    const localTime = Date.now();
    const timeDiff = Math.abs(serverTime * 1 - localTime * 1);
    console.log(serverTime, localTime);
    console.log(`Time difference: ${timeDiff}ms`);
    if (timeDiff > 1000) {
      console.warn(
        "Warning: Local time is more than 1 second off from server time"
      );
    }
  } catch (error) {
    console.error("Failed to check server time:", error.message);
  }
}

// Call this function before making API requests
checkServerTime();

async function getAccountBalance() {
  return makeRequest("GET", "/openApi/swap/v2/user/balance");
}

async function getOpenPositions() {
  return makeRequest("GET", "/openApi/contract/v1/allPosition");
  return makeRequest("GET", "/openApi/swap/v2/user/positions");
}

async function getPendingOrders() {
  return makeRequest("GET", "/openApi/contract/v1/allOrders");
  return makeRequest("GET", "/openApi/swap/v2/trade/openOrders");
}

async function closePosition(symbol, positionSide) {
  return makeRequest("POST", "/openApi/swap/v2/trade/closePosition", {
    symbol,
    positionSide,
  });
}

async function cancelOrder(symbol, orderId) {
  return makeRequest("POST", "/openApi/swap/v2/trade/cancelOrder", {
    symbol,
    orderId,
  });
}

async function closeAllPositions(symbol = "") {
  const positions = await getOpenPositions();
  const closePromises = positions.data
    .filter((pos) => symbol === "" || pos.symbol === symbol)
    .map((pos) => closePosition(pos.symbol, pos.positionSide));
  return Promise.all(closePromises);
}

async function cancelAllOrders(symbol = "") {
  const orders = await getPendingOrders();
  const cancelPromises = orders.data
    .filter((order) => symbol === "" || order.symbol === symbol)
    .map((order) => cancelOrder(order.symbol, order.orderId));
  return Promise.all(cancelPromises);
}

async function setTrailingStop(symbol, activationPrice, callbackRate) {
  return makeRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol,
    type: "TRAILING_STOP_MARKET",
    activationPrice,
    callbackRate,
  });
}

async function setStopLoss(symbol, stopPrice) {
  return makeRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol,
    type: "STOP_MARKET",
    stopPrice,
  });
}

async function setTakeProfit(symbol, stopPrice) {
  return makeRequest("POST", "/openApi/swap/v2/trade/order", {
    symbol,
    type: "TAKE_PROFIT_MARKET",
    stopPrice,
  });
}

// Place a market order
async function placeMarketOrder(symbol, side, quantity) {
  const params = {
    symbol,
    side,
    orderType: "MARKET",
    quantity: parseFloat(quantity),
  };
  return makeRequest("POST", "/openApi/contract/v1/trade/order", params);
}

async function placeLimitOrder(symbol, side, quantity, price) {
  const params = {
    symbol,
    side,
    type: "LIMIT",
    quantity: parseFloat(quantity),
    price,
  };
  return makeRequest("POST", "/openApi/swap/v2/trade/order", params);
}

// Simple trading strategy based on price movement
async function simpleTradingStrategy(symbol) {
  try {
    // Get latest price
    const tickerData = await makeRequest('GET', '/openApi/swap/v2/quote/price', { symbol });
    const currentPrice = parseFloat(tickerData.price);

    // Get historical data (last 2 candles)
    const klineData = await makeRequest('GET', '/openApi/swap/v2/quote/klines', {
      symbol,
      interval: '1m',
      limit: 2,
    });

    const previousPrice = parseFloat(klineData.data[0][4]); // Close price of the previous candle

    // Simple strategy: Buy if price is going up, sell if it's going down
    if (currentPrice > previousPrice) {
      console.log(`Price is going up for ${symbol}. Placing a buy order.`);
      return placeMarketOrder(symbol, 'BUY', 0.01); // Buy 0.01 units
    } else if (currentPrice < previousPrice) {
      console.log(`Price is going down for ${symbol}. Placing a sell order.`);
      return placeMarketOrder(symbol, 'SELL', 0.01); // Sell 0.01 units
    } else {
      console.log(`No significant price movement for ${symbol}. No action taken.`);
      return null;
    }
  } catch (error) {
    console.error('Error in trading strategy:', error);
    next(error);
  }
}

// Express routes
app.get('/balance', async (req, res) => {
  try {
    const balance = await getAccountBalance();
    res.json(balance);
  } catch (error) {
    //res.status(500).json({ error: 'Failed to fetch account balance' });
    next(error);
  }
});

app.post('/trade/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    const result = await simpleTradingStrategy(symbol);
    res.json(result);
  } catch (error) {
    //res.status(500).json({ error: 'Failed to execute trade' });
    next(error);
  }
});

app.get('/positions', async (req, res) => {
  try {
    const positions = await makeRequest('GET', '/openApi/swap/v2/user/positions');
    res.json(positions);
  } catch (error) {
    //res.status(500).json({ error: 'Failed to fetch positions' });
    next(error);
  }
});

app.get('/price/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    const price = await makeRequest('GET', '/openApi/swap/v2/quote/price', { symbol });
    res.json(price);
  } catch (error) {
    //res.status(500).json({ error: 'Failed to fetch price' });
    next(error);
  }
});


// Alias for the help function
const help = (ctx) => {
  const commands = [
    { command: "/balance", description: "Get account balance" },
    { command: "/positions", description: "Get open positions" },
    { command: "/orders", description: "Get pending orders" },
    {
      command: "/close <symbol> <LONG|SHORT>",
      description: "Close a specific position",
    },
    {
      command: "/cancel <symbol> <orderId>",
      description: "Cancel a specific order",
    },
    {
      command: "/closeall [symbol]",
      description: "Close all positions (optionally for a specific symbol)",
    },
    {
      command: "/cancelall [symbol]",
      description: "Cancel all orders (optionally for a specific symbol)",
    },
    {
      command: "/trailingstop <symbol> <activationPrice> <callbackRate>",
      description: "Set a trailing stop",
    },
    { command: "/sl <symbol> <stopPrice>", description: "Set a stop loss" },
    { command: "/tp <symbol> <stopPrice>", description: "Set a take profit" },
    {
      command: "/market <symbol> <BUY|SELL> <quantity>",
      description: "Place a market order",
    },
    {
      command: "/limit <symbol> <BUY|SELL> <quantity> <price>",
      description: "Place a limit order",
    },
    { command: "/help", description: "Show this help message" },
  ];

  let helpMessage = "Available Commands:\n\n";
  commands.forEach((cmd) => {
    helpMessage += `${cmd.command} - ${cmd.description}\n`;
  });

  helpMessage +=
    "\nFor more detailed information on each command, use it without parameters.";

  ctx.reply(helpMessage);
};

// Telegram Bot commands
// Add this to your existing bot commands
bot.command("yosiet", help);
bot.command("help", help);

bot.command("market", async (ctx) => {
  const [symbol, side, quantity] = ctx.message.text.split(" ").slice(1);
  if (!symbol || !side || !quantity) {
    return ctx.reply("Usage: /market <symbol> <BUY|SELL> <quantity>");
  }

  // Validate inputs
  if (!["BUY", "SELL"].includes(side.toUpperCase())) {
    return ctx.reply("Side must be either BUY or SELL");
  }

  const parsedQuantity = parseFloat(quantity);
  if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
    return ctx.reply("Quantity must be a positive number");
  }

  try {
    const result = await placeMarketOrder(
      symbol,
      side.toUpperCase(),
      parsedQuantity
    );
    ctx.reply(`Market order placed:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("limit", async (ctx) => {
  const [symbol, side, quantity, price] = ctx.message.text.split(" ").slice(1);
  if (!symbol || !side || !quantity || !price) {
    return ctx.reply("Usage: /limit <symbol> <BUY|SELL> <quantity> <price>");
  }

  // Validate inputs
  if (!["BUY", "SELL"].includes(side.toUpperCase())) {
    return ctx.reply("Side must be either BUY or SELL");
  }

  const parsedQuantity = parseFloat(quantity);
  if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
    return ctx.reply("Quantity must be a positive number");
  }

  try {
    const result = await placeLimitOrder(
      symbol,
      side.toUpperCase(),
      parsedQuantity,
      price
    );
    ctx.reply(`Limit order placed:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("balance", async (ctx) => {
  try {
    const balance = await getAccountBalance();
    ctx.reply(`Account Balance:\n${JSON.stringify(balance, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("positions", async (ctx) => {
  try {
    const positions = await getOpenPositions();
    ctx.reply(`Open Positions:\n${JSON.stringify(positions, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("orders", async (ctx) => {
  try {
    const orders = await getPendingOrders();
    ctx.reply(`Pending Orders:\n${JSON.stringify(orders, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("close", async (ctx) => {
  const [symbol, positionSide] = ctx.message.text.split(" ").slice(1);
  if (!symbol || !positionSide) {
    return ctx.reply("Usage: /close <symbol> <LONG|SHORT>");
  }
  try {
    const result = await closePosition(symbol, positionSide);
    ctx.reply(`Position closed:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("cancel", async (ctx) => {
  const [symbol, orderId] = ctx.message.text.split(" ").slice(1);
  if (!symbol || !orderId) {
    return ctx.reply("Usage: /cancel <symbol> <orderId>");
  }
  try {
    const result = await cancelOrder(symbol, orderId);
    ctx.reply(`Order canceled:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("closeall", async (ctx) => {
  const [symbol] = ctx.message.text.split(" ").slice(1);
  try {
    const result = await closeAllPositions(symbol);
    ctx.reply(`All positions closed:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("cancelall", async (ctx) => {
  const [symbol] = ctx.message.text.split(" ").slice(1);
  try {
    const result = await cancelAllOrders(symbol);
    ctx.reply(`All orders canceled:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("trailingstop", async (ctx) => {
  const [symbol, activationPrice, callbackRate] = ctx.message.text
    .split(" ")
    .slice(1);
  if (!symbol || !activationPrice || !callbackRate) {
    return ctx.reply(
      "Usage: /trailingstop <symbol> <activationPrice> <callbackRate>"
    );
  }
  try {
    const result = await setTrailingStop(symbol, activationPrice, callbackRate);
    ctx.reply(`Trailing stop set:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("sl", async (ctx) => {
  const [symbol, stopPrice] = ctx.message.text.split(" ").slice(1);
  if (!symbol || !stopPrice) {
    return ctx.reply("Usage: /sl <symbol> <stopPrice>");
  }
  try {
    const result = await setStopLoss(symbol, stopPrice);
    ctx.reply(`Stop loss set:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

bot.command("tp", async (ctx) => {
  const [symbol, stopPrice] = ctx.message.text.split(" ").slice(1);
  if (!symbol || !stopPrice) {
    return ctx.reply("Usage: /tp <symbol> <stopPrice>");
  }
  try {
    const result = await setTakeProfit(symbol, stopPrice);
    ctx.reply(`Take profit set:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${error.message}`);
  }
});

// Start the bot
bot.launch();

// Start the server
const server = app.listen(port, () => {
  console.log(`Marcelo's trading Server running on port ${port}`);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    // Close database connections, etc.
    process.exit(0);
  });
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Application specific logging, throwing an error, or other logic here
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Application specific logging, throwing an error, or other logic here
  process.exit(1); // Exit with failure
});
