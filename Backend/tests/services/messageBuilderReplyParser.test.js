const { parseConfirmReply } = require('../../services/whatsapp/messageBuilder');

describe('WhatsApp order confirmation text parser', () => {
  test.each([
    ['yes', 'yes'],
    ['YES please', 'yes'],
    ['confirm my order', 'yes'],
    ['no', 'no'],
    ['No thanks', 'no'],
    ['cancel this order', 'no'],
  ])('accepts short explicit reply "%s"', (text, expected) => {
    expect(parseConfirmReply(text)).toBe(expected);
  });

  test.each([
    'Got no reply and its been 50+ secs',
    'why no reply?',
    'I am not getting a reply',
    'can you confirm the account is working?',
  ])('does not classify normal chat text "%s"', (text) => {
    expect(parseConfirmReply(text)).toBeNull();
  });
});
