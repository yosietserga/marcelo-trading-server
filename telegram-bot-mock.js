// telegram-bot-mock.js

class TelegramBotMock {
  constructor() {
    this.messages = [];
  }

  handleCommand(command, data) {
    this.messages.push({ command, data });
  }

  getMockedResponse() {
    return this.messages.pop();
  }

  clearMessages() {
    this.messages = [];
  }
}

module.exports = TelegramBotMock;