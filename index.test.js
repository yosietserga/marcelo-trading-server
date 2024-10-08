// index.test.js

const { expect } = require('chai');
const request = require('supertest');
const TelegramBotMock = require('./telegram-bot-mock'); 


describe('Marcelo Trading Server', () => {
  describe('GET /balance', () => {
    it('should return account balance', async () => {
      const res = await request('http://localhost:3000').get('/balance');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('status');
      expect(res.body).to.have.property('statusCode');
      expect(res.body).to.have.property('message');
      expect(res.body.message).to.include('Account Balance:');
    });
  });

  describe('GET /positions', () => {
    it('should return open positions', async () => {
      const res = await request('http://localhost:3000').get('/positions');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
    });
  });

  describe('GET /price/:symbol', () => {
    it('should return price for a given symbol', async () => {
      const res = await request('http://localhost:3000').get('/price/BTCUSDT');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('price');
    });
  });

  describe('Telegram Bot commands', () => {
    let mockBot;

    beforeEach(() => {
      mockBot = new TelegramBotMock();
    });

    afterEach(() => {
      mockBot.clearMessages();
    });

    it('should handle /balance command', async () => {
      const balance = { amount: 10000 };
      mockBot.handleCommand('/balance', balance);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: JSON.stringify(balance),
        parseMode: 'Markdown'
      });
    });

    it('should handle /positions command', async () => {
      const positions = [{ symbol: 'BTCUSDT', quantity: 1 }];
      mockBot.handleCommand('/positions', positions);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: JSON.stringify(positions),
        parseMode: 'Markdown'
      });
    });

    it('should handle /close command', async () => {
      const [symbol, positionSide] = ['BTCUSDT', 'LONG'];
      mockBot.handleCommand(`/close ${symbol} ${positionSide}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'Position closed:',
        parseMode: 'Markdown'
      });
    });

    it('should handle /cancel command', async () => {
      const [symbol, orderId] = ['BTCUSDT', '12345'];
      mockBot.handleCommand(`/cancel ${symbol} ${orderId}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'Order canceled:',
        parseMode: 'Markdown'
      });
    });

    it('should handle /closeall command', async () => {
      const symbol = 'BTCUSDT';
      mockBot.handleCommand(`/closeall ${symbol}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'All positions closed:',
        parseMode: 'Markdown'
      });
    });

    it('should handle /cancelall command', async () => {
      const symbol = 'BTCUSDT';
      mockBot.handleCommand(`/cancelall ${symbol}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'All orders canceled:',
        parseMode: 'Markdown'
      });
    });

    it('should handle /trailingstop command', async () => {
      const [symbol, activationPrice, callbackRate] = ['BTCUSDT', '50000', '0.01'];
      mockBot.handleCommand(`/trailingstop ${symbol} ${activationPrice} ${callbackRate}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'Trailing stop set:',
        parseMode: 'Markdown'
      });
    });

    it('should handle /sl command', async () => {
      const [symbol, stopPrice] = ['BTCUSDT', '49000'];
      mockBot.handleCommand(`/sl ${symbol} ${stopPrice}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'Stop loss set:',
        parseMode: 'Markdown'
      });
    });

    it('should handle /tp command', async () => {
      const [symbol, stopPrice] = ['BTCUSDT', '51000'];
      mockBot.handleCommand(`/tp ${symbol} ${stopPrice}`);

      const result = await mockBot.getMockedResponse();
      expect(result).to.deep.equal({
        text: 'Take profit set:',
        parseMode: 'Markdown'
      });
    });
  });
});