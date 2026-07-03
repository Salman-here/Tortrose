const { parseConfirmReply } = require('../../services/whatsapp/messageBuilder');

describe('WhatsApp order confirmation text parser', () => {
  test.each([
    'yes',
    'YES please',
    'confirm my order',
    'no',
    'No thanks',
    'cancel this order',
    'Got no reply and its been 50+ secs',
    'why no reply?',
    'I am not getting a reply',
    'can you confirm the account is working?',
  ])('does not classify typed text "%s" as an order decision', (text) => {
    expect(parseConfirmReply(text)).toBeNull();
  });
});
