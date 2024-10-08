import express, { Request, Response, NextFunction } from 'express';
import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import winston from 'winston';
import { Telegraf, Context } from 'telegraf';
import dotenv from 'dotenv';

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'user-service' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

dotenv.config();

const app = express();
const port = 3000;

// BingX API configuration
const API_KEY = process.env.BINGX_API_KEY as string;
const SECRET_KEY = process.env.BINGX_SECRET_KEY as string;
const BASE_URL = 'https://open-api.bingx.com';

// Telegram Bot configuration
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

// Error middleware
interface CustomError extends Error {
  statusCode?: number;
}

const errorMiddleware = (err: CustomError, req: Request, res: Response, next: NextFunction) => {
  logger.error(`${err.message}`, { stack: err.stack });

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  console.error(`[${new Date().toISOString()}] ${err.stack}`);

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

app.use(errorMiddleware);

// Helper function to generate signature
function generateSignature(params: Record<string, any>, secretKey: string): string {
  const orderedParams = Object.keys(params)
    .sort()
    .reduce((obj: Record<string, any>, key) => {
      obj[key] = params[key];
      return obj;
    }, {});

  const queryString = Object.entries(orderedParams)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto
    .createHmac('sha256', secretKey)
    .update(queryString)
    .digest('hex');
}

// Function to make authenticated API requests
async function makeRequest(method: string, endpoint: string, params: Record<string, any> = {}): Promise<any> {
  const timestamp = Date.now();
  const fullParams: Record<string, any> = {
    ...params,
    timestamp,
    apiKey: API_KEY,
  };

  const signature = generateSignature(fullParams, SECRET_KEY);
  fullParams.signature = signature;

  const url = `${BASE_URL}${endpoint}`;
  
  try {
    const response: AxiosResponse = await axios({
      method,
      url,
      params: fullParams,
    });
    return response.data;
  } catch (error) {
    console.error('API request failed:', (error as any).response.data);
    throw error;
  }
}

// API functions
async function getAccountBalance(): Promise<any> {
  return makeRequest('GET', '/openApi/swap/v2/user/balance');
}

async function getOpenPositions(): Promise<any> {
  return makeRequest('GET', '/openApi/swap/v2/user/positions');
}

async function getPendingOrders(): Promise<any> {
  return makeRequest('GET', '/openApi/swap/v2/trade/openOrders');
}

async function closePosition(symbol: string, positionSide: string): Promise<any> {
  return makeRequest('POST', '/openApi/swap/v2/trade/closePosition', {
    symbol,
    positionSide,
  });
}

async function cancelOrder(symbol: string, orderId: string): Promise<any> {
  return makeRequest('POST', '/openApi/swap/v2/trade/cancelOrder', {
    symbol,
    orderId,
  });
}

async function closeAllPositions(symbol: string = ''): Promise<any[]> {
  const positions = await getOpenPositions();
  const closePromises = positions.data
    .filter((pos: any) => symbol === '' || pos.symbol === symbol)
    .map((pos: any) => closePosition(pos.symbol, pos.positionSide));
  return Promise.all(closePromises);
}

async function cancelAllOrders(symbol: string = ''): Promise<any[]> {
  const orders = await getPendingOrders();
  const cancelPromises = orders.data
    .filter((order: any) => symbol === '' || order.symbol === symbol)
    .map((order: any) => cancelOrder(order.symbol, order.orderId));
  return Promise.all(cancelPromises);
}

async function setTrailingStop(symbol: string, activationPrice: string, callbackRate: string): Promise<any> {
  return makeRequest('POST', '/openApi/swap/v2/trade/order', {
    symbol,
    type: 'TRAILING_STOP_MARKET',
    activationPrice,
    callbackRate,
  });
}

async function setStopLoss(symbol: string, stopPrice: string): Promise<any> {
  return makeRequest('POST', '/openApi/swap/v2/trade/order', {
    symbol,
    type: 'STOP_MARKET',
    stopPrice,
  });
}

async function setTakeProfit(symbol: string, stopPrice: string): Promise<any> {
  return makeRequest('POST', '/openApi/swap/v2/trade/order', {
    symbol,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice,
  });
}

async function placeMarketOrder(symbol: string, side: string, quantity: number): Promise<any> {
  const params = {
    symbol,
    side,
    type: 'MARKET',
    quantity,
  };
  return makeRequest('POST', '/openApi/swap/v2/trade/order', params);
}

// Simple trading strategy
async function simpleTradingStrategy(symbol: string): Promise<any> {
  try {
    const tickerData = await makeRequest('GET', '/openApi/swap/v2/quote/price', { symbol });
    const currentPrice = parseFloat(tickerData.price);

    const klineData = await makeRequest('GET', '/openApi/swap/v2/quote/klines', {
      symbol,
      interval: '1m',
      limit: 2,
    });

    const previousPrice = parseFloat(klineData.data[0][4]);

    if (currentPrice > previousPrice) {
      console.log(`Price is going up for ${symbol}. Placing a buy order.`);
      return placeMarketOrder(symbol, 'BUY', 0.01);
    } else if (currentPrice < previousPrice) {
      console.log(`Price is going down for ${symbol}. Placing a sell order.`);
      return placeMarketOrder(symbol, 'SELL', 0.01);
    } else {
      console.log(`No significant price movement for ${symbol}. No action taken.`);
      return null;
    }
  } catch (error) {
    console.error('Error in trading strategy:', error);
    throw error;
  }
}

// Express routes
app.get('/balance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const balance = await getAccountBalance();
    res.json(balance);
  } catch (error) {
    next(error);
  }
});

app.post('/trade/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  const { symbol } = req.params;
  try {
    const result = await simpleTradingStrategy(symbol);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/positions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const positions = await makeRequest('GET', '/openApi/swap/v2/user/positions');
    res.json(positions);
  } catch (error) {
    next(error);
  }
});

app.get('/price/:symbol', async (req: Request, res: Response, next: NextFunction) => {
  const { symbol } = req.params;
  try {
    const price = await makeRequest('GET', '/openApi/swap/v2/quote/price', { symbol });
    res.json(price);
  } catch (error) {
    next(error);
  }
});

// Telegram Bot commands
bot.command('balance', async (ctx: Context) => {
  try {
    const balance = await getAccountBalance();
    ctx.reply(`Account Balance:\n${JSON.stringify(balance, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('positions', async (ctx: Context) => {
  try {
    const positions = await getOpenPositions();
    ctx.reply(`Open Positions:\n${JSON.stringify(positions, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('orders', async (ctx: Context) => {
  try {
    const orders = await getPendingOrders();
    ctx.reply(`Pending Orders:\n${JSON.stringify(orders, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('close', async (ctx: Context) => {
  const [symbol, positionSide] = ctx.message!.text.split(' ').slice(1);
  if (!symbol || !positionSide) {
    return ctx.reply('Usage: /close <symbol> <LONG|SHORT>');
  }
  try {
    const result = await closePosition(symbol, positionSide);
    ctx.reply(`Position closed:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('cancel', async (ctx: Context) => {
  const [symbol, orderId] = ctx.message!.text.split(' ').slice(1);
  if (!symbol || !orderId) {
    return ctx.reply('Usage: /cancel <symbol> <orderId>');
  }
  try {
    const result = await cancelOrder(symbol, orderId);
    ctx.reply(`Order canceled:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('closeall', async (ctx: Context) => {
  const [symbol] = ctx.message!.text.split(' ').slice(1);
  try {
    const result = await closeAllPositions(symbol);
    ctx.reply(`All positions closed:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('cancelall', async (ctx: Context) => {
  const [symbol] = ctx.message!.text.split(' ').slice(1);
  try {
    const result = await cancelAllOrders(symbol);
    ctx.reply(`All orders canceled:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('trailingstop', async (ctx: Context) => {
  const [symbol, activationPrice, callbackRate] = ctx.message!.text
    .split(' ')
    .slice(1);
  if (!symbol || !activationPrice || !callbackRate) {
    return ctx.reply(
      'Usage: /trailingstop <symbol> <activationPrice> <callbackRate>'
    );
  }
  try {
    const result = await setTrailingStop(symbol, activationPrice, callbackRate);
    ctx.reply(`Trailing stop set:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('sl', async (ctx: Context) => {
  const [symbol, stopPrice] = ctx.message!.text.split(' ').slice(1);
  if (!symbol || !stopPrice) {
    return ctx.reply('Usage: /sl <symbol> <stopPrice>');
  }
  try {
    const result = await setStopLoss(symbol, stopPrice);
    ctx.reply(`Stop loss set:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
  }
});

bot.command('tp', async (ctx: Context) => {
  const [symbol, stopPrice] = ctx.message!.text.split(' ').slice(1);
  if (!symbol || !stopPrice) {
    return ctx.reply('Usage: /tp <symbol> <stopPrice>');
  }
  try {
    const result = await setTakeProfit(symbol, stopPrice);
    ctx.reply(`Take profit set:\n${JSON.stringify(result, null, 2)}`);
  } catch (error) {
    ctx.reply(`Error: ${(error as Error).message}`);
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

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    // Close database connections, etc.
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  // Application specific logging, throwing an error, or other logic here
  process.exit(1); // Exit with failure
});