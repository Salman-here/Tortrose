'use strict';

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../../config/mail', () => ({
  isConfigured: true,
  BREVO_SENDER: { name: 'Rozare', email: 'hello@rozare.com' },
  BREVO_API_URL: 'https://api.brevo.test/v3/smtp/email',
  BREVO_API_KEY: 'test-only-key',
}));

const axios = require('axios');
const { sendEmail } = require('../../controllers/mailController');

beforeEach(() => {
  axios.post.mockReset().mockResolvedValue({ data: { messageId: 'preview-only' } });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('text-only outbox email is delivered with the complete soft HTML design', async () => {
  await sendEmail({
    to: 'test@example.com', subject: 'Store update', text: 'Your store setup is ready.',
    actionUrl: 'https://rozare.com/seller-dashboard/store-overview',
  });
  const [url, payload] = axios.post.mock.calls[0];
  expect(url).toBe('https://api.brevo.test/v3/smtp/email');
  expect(payload.textContent).toBe('Your store setup is ready.');
  expect(payload.htmlContent).toContain('https://rozare.com/favicon-512.png');
  expect(payload.htmlContent).toContain('Your store setup is ready.');
  expect(payload.htmlContent).toContain('https://rozare.com/seller-dashboard/store-overview');
  expect(payload.htmlContent).not.toMatch(/Lahore|Pakistan/);
});
