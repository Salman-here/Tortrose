'use strict';

jest.mock('../../models/WhatsAppPendingMessage', () => ({ updateMany: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/WhatsAppConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../models/Order', () => ({ findById: jest.fn() }));
jest.mock('../../services/whatsapp/evolutionClient', () => ({
  isConfigured: jest.fn(), checkWhatsAppNumber: jest.fn(), sendText: jest.fn(), sendButtons: jest.fn(), sendList: jest.fn(),
}));

const Pending = require('../../models/WhatsAppPendingMessage');
const Config = require('../../models/WhatsAppConfig');
const Order = require('../../models/Order');
const evolution = require('../../services/whatsapp/evolutionClient');
const { buildOrderButtonsPayload, buildOrderConfirmationLinkMessage, parseConfirmReply } = require('../../services/whatsapp/messageBuilder');
const { _processOne: processOne } = require('../../services/whatsapp/queue');

let order, job;
const originalFrontendUrl = process.env.FRONTEND_URL;
beforeEach(() => {
  jest.resetAllMocks();
  process.env.FRONTEND_URL = 'https://rozare.com';
  order = {
    _id: 'order-1', orderId: 'ORD-TEST-COD', paymentMethod: 'cash_on_delivery', isPaid: false, orderStatus: 'pending', currency: 'PKR',
    orderItems: [{ name: 'Travel Mug', selectedOptions: { Color: 'Red' }, price: 225, lineSubtotal: 450, quantity: 2 }],
    orderSummary: { subtotal: 450, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 450 },
    shippingInfo: { fullName: 'Test Buyer', city: 'Lahore', phone: '+92 300 1234567' },
    confirmation: { token: 'a'.repeat(64), tokenExpiresAt: new Date(Date.now() + 3600000) }, save: jest.fn().mockResolvedValue(undefined),
  };
  job = { _id: 'job-1', order: order._id, orderId: order.orderId, messageType: 'confirmation',
    phone: '923001234567', confirmationToken: order.confirmation.token,
    interactiveButtonsPayloadJson: JSON.stringify(buildOrderButtonsPayload(order)),
    attempts: 1, status: 'sending', leaseToken: 'owned-lease' };
  Pending.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Pending.findOneAndUpdate.mockImplementation(async (_filter, update) => update.$inc ? job : { ...job, ...update.$set });
  Config.findOne.mockResolvedValue({ status: 'connected', sentWindowStartedAt: new Date(), sentInLastHour: 0 });
  Config.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Order.findById.mockReturnValue({
    populate: jest.fn(async () => order),
    then: (resolve, reject) => Promise.resolve(order).then(resolve, reject),
  });
  evolution.isConfigured.mockReturnValue(true);
  evolution.checkWhatsAppNumber.mockResolvedValue(true);
  evolution.sendText.mockResolvedValue({ messageId: 'accepted-text-1' });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => {
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
});

const lastWrite = () => Pending.findOneAndUpdate.mock.calls.at(-1)[1].$set;

test('COD uses one supported text message and a secure review link, not silently accepted buttons', async () => {
  order.confirmation.whatsappError = 'An old failed attempt';
  await processOne();
  expect(evolution.sendText).toHaveBeenCalledTimes(1);
  const [recipient, text] = evolution.sendText.mock.calls[0];
  expect(recipient).toBe('923001234567@s.whatsapp.net');
  expect(text).toContain('Travel Mug'); expect(text).toContain('Color: Red'); expect(text).toContain('x2');
  expect(text).toContain('Rs450.00 PKR');
  expect(text).toContain('https://rozare.com/orders/confirm/' + 'a'.repeat(64));
  expect(text).toContain('Opening the link does not confirm or cancel your order.');
  expect(text).not.toContain('below.');
  expect(evolution.sendButtons).not.toHaveBeenCalled(); expect(evolution.sendList).not.toHaveBeenCalled();
  expect(lastWrite()).toMatchObject({ status: 'sent', summaryMessageId: 'accepted-text-1', lastError: '', leaseToken: null });
  expect(order.confirmation.whatsappSentSuccess).toBe(true);
  expect(order.confirmation.whatsappError).toBe('');
  expect(order.confirmation.confirmedAt).toBeUndefined(); expect(order.orderStatus).toBe('pending');
});

test('delivery uses the frozen purchase details, not changed item prices on retry', async () => {
  order.orderItems[0].price = 9999; order.orderSummary.totalAmount = 9999;
  await processOne();
  const text = evolution.sendText.mock.calls[0][1];
  expect(text).toContain('Rs450.00 PKR'); expect(text).not.toContain('9,999');
});

test.each([
  ['already paid', current => { current.isPaid = true; }],
  ['not COD', current => { current.paymentMethod = 'safepay'; }],
  ['cancelled', current => { current.orderStatus = 'cancelled'; }],
  ['processing', current => { current.orderStatus = 'processing'; }],
  ['shipped', current => { current.orderStatus = 'shipped'; }],
  ['delivered', current => { current.orderStatus = 'delivered'; }],
  ['confirmed elsewhere', current => { current.confirmation.confirmedAt = new Date(); }],
  ['declined elsewhere', current => { current.confirmation.declinedAt = new Date(); }],
  ['token rotated', current => { current.confirmation.token = 'b'.repeat(64); }],
  ['token missing', current => { current.confirmation.token = ''; }],
  ['token expired', current => { current.confirmation.tokenExpiresAt = new Date(Date.now() - 1); }],
  ['expiry corrupt', current => { current.confirmation.tokenExpiresAt = 'not-a-date'; }],
])('stale %s requests are not delivered or acted upon', async (_name, mutate) => {
  mutate(order); await processOne();
  expect(lastWrite()).toMatchObject({ status: 'expired', leaseToken: null });
  expect(evolution.checkWhatsAppNumber).not.toHaveBeenCalled();
  expect(evolution.sendText).not.toHaveBeenCalled(); expect(order.save).not.toHaveBeenCalled();
});

test.each([1, 3])('text send failure preserves bounded retry/final-failure behaviour at attempt %s', async attempts => {
  job.attempts = attempts;
  evolution.sendText.mockRejectedValue({ response: { status: 503, data: { error: 'Temporarily unavailable' } } });
  await processOne();
  expect(lastWrite().status).toBe(attempts === 1 ? 'queued' : 'failed');
  expect(lastWrite().lastError).toContain('Temporarily unavailable');
  if (attempts === 1) {
    expect(lastWrite().nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(order.save).not.toHaveBeenCalled();
  } else expect(order.confirmation.whatsappSentSuccess).toBe(false);
  expect(evolution.sendButtons).not.toHaveBeenCalled();
});

test.each([{}, null, { messageId: '' }, { messageId: ' ' }])('invalid provider acknowledgement %s is retried rather than falsely marked sent', async response => {
  evolution.sendText.mockResolvedValue(response); await processOne();
  expect(lastWrite().status).toBe('queued');
  expect(lastWrite().lastError).toContain('did not acknowledge');
  expect(order.save).not.toHaveBeenCalled();
});

test('corrupt snapshots fail closed rather than rebuilding a different financial message', async () => {
  job.interactiveButtonsPayloadJson = '{bad json'; await processOne();
  expect(lastWrite().status).toBe('queued'); expect(lastWrite().lastError).toContain('corrupt');
  expect(evolution.sendText).not.toHaveBeenCalled();
});

test('pending legacy jobs without snapshots use the validated legacy builder', async () => {
  delete job.interactiveButtonsPayloadJson; await processOne();
  expect(evolution.sendText.mock.calls[0][1]).toContain('Rs450.00 PKR');
  expect(lastWrite().status).toBe('sent');
});

test('online-paid information messages remain information-only', async () => {
  job.messageType = 'info'; order.paymentMethod = 'safepay'; order.isPaid = true;
  order.orderStatus = 'confirmed'; order.confirmation.confirmedAt = new Date();
  await processOne();
  const text = evolution.sendText.mock.calls[0][1];
  expect(text).toContain('Your payment is confirmed.');
  expect(text).not.toContain('/orders/confirm/'); expect(lastWrite().status).toBe('sent');
});

test.each(['custom_info', 'generic_info'])('%s messages retain their existing delivery path', async messageType => {
  job.messageType = messageType; job.messageBody = 'An existing transactional update.';
  await processOne();
  expect(evolution.sendText).toHaveBeenCalledWith('923001234567@s.whatsapp.net', job.messageBody);
  if (messageType === 'generic_info') expect(Order.findById).not.toHaveBeenCalled();
  expect(lastWrite().status).toBe('sent');
});

test('a worker losing its lease after provider acceptance cannot save a second outcome', async () => {
  Pending.findOneAndUpdate.mockResolvedValueOnce(job).mockResolvedValueOnce(null);
  await processOne();
  expect(evolution.sendText).toHaveBeenCalledTimes(1);
  expect(order.save).not.toHaveBeenCalled();
  expect(Pending.findOneAndUpdate).toHaveBeenCalledTimes(2);
});

test('new link delivery does not enable ambiguous typed yes/no decisions', () => {
  expect(parseConfirmReply('yes')).toBeNull(); expect(parseConfirmReply('cancel')).toBeNull();
});

test('large multi-store summaries remain deliverable without truncating or recalculating the frozen total', () => {
  const payload = buildOrderButtonsPayload(order);
  payload.description += '\n' + 'A long store description '.repeat(250);
  const text = buildOrderConfirmationLinkMessage(payload, order.confirmation.token);
  expect(text.length).toBeLessThanOrEqual(4000);
  expect(text).toContain('Rs450.00 PKR');
  expect(text).toContain('View all products');
  expect(text).toContain('https://rozare.com/orders/confirm/' + order.confirmation.token);
});

test('link rendering rejects invalid tokens, insecure destinations and oversized/corrupt messages', () => {
  const payload = buildOrderButtonsPayload(order);
  expect(() => buildOrderConfirmationLinkMessage(payload, 'short')).toThrow(/valid order confirmation token/);
  expect(() => buildOrderConfirmationLinkMessage({}, order.confirmation.token)).toThrow(/frozen/);
  expect(() => buildOrderConfirmationLinkMessage({ ...payload, description: 'x'.repeat(4000) }, order.confirmation.token)).toThrow(/too long/);
  expect(() => buildOrderConfirmationLinkMessage(payload, order.confirmation.token, 'http://untrusted.example')).toThrow(/secure frontend/);
});
