'use strict';

// Actual webhook parser + route store. All database, AI and WhatsApp side
// effects are mocked: these events never reach a real order or real phone.
jest.mock('../../models/Order', () => ({ findById: jest.fn() }));
jest.mock('../../models/WhatsAppConfig', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('../../models/WhatsAppPendingMessage', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../../models/WhatsAppJidMapping', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../services/whatsapp/queue', () => ({
  findPendingJobByPhone: jest.fn(), findPendingJobByOrderId: jest.fn(),
  applyVote: jest.fn(), markInboundConversationWindowOpen: jest.fn(),
}));
jest.mock('../../services/whatsapp/evolutionClient', () => ({
  sendText: jest.fn().mockResolvedValue({ messageId: 'qa-no-network' }),
  sendButtons: jest.fn().mockResolvedValue({ messageId: 'qa-no-network-buttons' }),
}));
jest.mock('../../services/orderFulfillmentService', () => ({
  ensureOrderSellerFulfillment: jest.fn().mockResolvedValue(['qa-seller']),
  getBuyerCancellationBlock: jest.fn().mockReturnValue(null),
}));
jest.mock('../../services/orderStatusTransitionService', () => ({ confirmCodOrderByBuyer: jest.fn() }));
jest.mock('../../services/orderCancellationService', () => ({
  cancelOrderSafely: jest.fn(), reconfirmCancelledCodOrder: jest.fn(),
}));
jest.mock('../../services/whatsapp/whatsappAIChatService', () => ({ processIncomingWhatsAppMessage: jest.fn() }));
jest.mock('../../services/whatsapp/inboundProcessingService', () => ({
  processInboundMessageOnce: jest.fn(async input => ({ processed: true, value: await input.work({ attempt: 1 }) })),
}));
jest.mock('../../services/whatsapp/webhookSecurity', () => ({ requireWhatsAppWebhookAuthentication: jest.fn(() => true) }));

const mongoose = require('mongoose');
const Order = require('../../models/Order');
const Config = require('../../models/WhatsAppConfig');
const Pending = require('../../models/WhatsAppPendingMessage');
const evolution = require('../../services/whatsapp/evolutionClient');
const queue = require('../../services/whatsapp/queue');
const { confirmCodOrderByBuyer } = require('../../services/orderStatusTransitionService');
const { cancelOrderSafely } = require('../../services/orderCancellationService');
const { getBuyerCancellationBlock } = require('../../services/orderFulfillmentService');
const { processIncomingWhatsAppMessage } = require('../../services/whatsapp/whatsappAIChatService');
const { handleEvolutionWebhook } = require('../../services/whatsapp/webhookHandler');
const PHONE = '15550000001', PN = PHONE + '@s.whatsapp.net', PEER_LID = '155500000000001@lid';
const OWNER = '15550000000@s.whatsapp.net', OWNER_LID = '155500000000000@lid';
const envKeys = ['WHATSAPP_SINGLE_INSTANCE_MODE', 'EVOLUTION_SELLER_INSTANCE_NAME', 'EVOLUTION_INSTANCE_NAME'];
let envBefore;
const message = (content, key = {}, extra = {}) => ({
  key: { id: 'qa-event', fromMe: false, remoteJid: PN, remoteJidAlt: PN, ...key },
  contextInfo: { participant: OWNER_LID, stanzaId: 'quoted-bot-original' },
  message: content, ...extra,
});
async function deliver(data, event = 'messages.upsert', instance = 'rozare-seller') {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await handleEvolutionWebhook({ body: { event, instance, sender: OWNER, data } }, res);
  expect(res.status).toHaveBeenCalledWith(200);
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  envBefore = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.WHATSAPP_SINGLE_INSTANCE_MODE = 'true';
  process.env.EVOLUTION_SELLER_INSTANCE_NAME = 'rozare-seller';
  process.env.EVOLUTION_INSTANCE_NAME = 'rozare-main';
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 0 });
  queue.findPendingJobByPhone.mockResolvedValue(null);
  queue.findPendingJobByOrderId.mockResolvedValue(null);
  getBuyerCancellationBlock.mockReturnValue(null);
  processIncomingWhatsAppMessage.mockImplementation(async (_phone, _text, _scope, _attachments, options) => {
    await evolution.sendText(options.replyTo, 'QA mocked AI response');
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  for (const key of envKeys) {
    if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key];
  }
  jest.restoreAllMocks();
});

test.each(['confirm', 'cancel'])('full %s button path preserves the decision and avoids duplicate cancellation acknowledgement', async action => {
  const order = { _id: 'qa-order', orderId: 'ORD-QA', orderStatus: 'pending',
    confirmation: { token: 'qa-token', tokenExpiresAt: new Date(Date.now() + 60000) },
    shippingInfo: { fullName: 'QA Buyer' } };
  const job = { order: order._id, orderId: order.orderId, confirmationToken: 'qa-token', phone: PHONE };
  queue.findPendingJobByOrderId.mockResolvedValue(job);
  Order.findById.mockResolvedValue(order);
  confirmCodOrderByBuyer.mockResolvedValue({ status: 'confirmed', newlyConfirmed: true, order });
  cancelOrderSafely.mockResolvedValue({ status: 'cancelled', order });
  await deliver(message({ templateButtonReplyMessage: { selectedId: action + '_ORD-QA' } }));
  if(action === 'confirm') expect(evolution.sendText).toHaveBeenCalledWith(PN, expect.stringContaining('is confirmed'));
  else expect(evolution.sendText).not.toHaveBeenCalled();
  expect(queue.applyVote).toHaveBeenCalledWith(job, action === 'confirm' ? 'yes' : 'no');
  expect(action === 'confirm' ? confirmCodOrderByBuyer : cancelOrderSafely).toHaveBeenCalledTimes(1);
  expect(action === 'confirm' ? cancelOrderSafely : confirmCodOrderByBuyer).not.toHaveBeenCalled();
});

test('a keep-cancel action that actually cancels also relies on its durable status notice', async () => {
  const order={_id:'qa-order',orderId:'ORD-QA',orderStatus:'confirmed',confirmation:{token:'qa-token',confirmedAt:new Date(),decidedVia:'whatsapp'},shippingInfo:{fullName:'QA Buyer'}};
  const job={order:'qa-order',orderId:'ORD-QA',confirmationToken:'qa-token',phone:PHONE};
  queue.findPendingJobByOrderId.mockResolvedValue(job);Order.findById.mockResolvedValue(order);
  cancelOrderSafely.mockResolvedValue({status:'cancelled',order});
  await deliver(message({templateButtonReplyMessage:{selectedId:'keepcancel_ORD-QA'}}));
  expect(cancelOrderSafely).toHaveBeenCalledTimes(1);
  expect(queue.applyVote).toHaveBeenCalledWith(job,'no');
  expect(evolution.sendText).not.toHaveBeenCalled();
});

test('blocked cancellation still explains why the action was not performed', async () => {
  const order={_id:'qa-order',orderId:'ORD-QA',orderStatus:'pending',confirmation:{token:'qa-token'},shippingInfo:{fullName:'QA Buyer'}};
  queue.findPendingJobByOrderId.mockResolvedValue({order:'qa-order',orderId:'ORD-QA',confirmationToken:'qa-token',phone:PHONE});Order.findById.mockResolvedValue(order);
  getBuyerCancellationBlock.mockReturnValue({message:'Shipment already started.'});
  await deliver(message({templateButtonReplyMessage:{selectedId:'cancel_ORD-QA'}}));
  expect(evolution.sendText).toHaveBeenCalledWith(PN,expect.stringContaining('Shipment already started.'));
  expect(cancelOrderSafely).not.toHaveBeenCalled();expect(queue.applyVote).not.toHaveBeenCalled();
});

test('expired cancellation buttons still provide actionable guidance', async () => {
  const order={_id:'qa-order',orderId:'ORD-QA',orderStatus:'pending',confirmation:{token:'qa-token',tokenExpiresAt:new Date(0)},shippingInfo:{fullName:'QA Buyer'}};
  const job={order:'qa-order',orderId:'ORD-QA',confirmationToken:'qa-token',phone:PHONE,save:jest.fn()};
  queue.findPendingJobByOrderId.mockResolvedValue(job);Order.findById.mockResolvedValue(order);
  await deliver(message({templateButtonReplyMessage:{selectedId:'cancel_ORD-QA'}}));
  expect(evolution.sendText).toHaveBeenCalledWith(PN,expect.stringContaining('expired or was replaced'));
  expect(cancelOrderSafely).not.toHaveBeenCalled();expect(job.save).toHaveBeenCalled();
});

test('cancel after confirmed still returns the existing-order explanation to the buyer', async () => {
  const order = { _id: 'qa-order', orderId: 'ORD-QA', orderStatus: 'confirmed',
    confirmation: { token: 'qa-token', confirmedAt: new Date(), decidedVia: 'whatsapp' },
    shippingInfo: { fullName: 'QA Buyer' } };
  queue.findPendingJobByOrderId.mockResolvedValue({ order: 'qa-order', orderId: 'ORD-QA', confirmationToken: 'qa-token', phone: PHONE });
  Order.findById.mockResolvedValue(order);
  await deliver(message({ templateButtonReplyMessage: { selectedId: 'cancel_ORD-QA' } }));
  expect(evolution.sendText).toHaveBeenCalledWith(PN, expect.stringContaining('already confirmed'));
  expect(cancelOrderSafely).not.toHaveBeenCalled();
});

test.each([true, false])('buyer/seller AI route ignores quoted bot metadata (unified=%s)', async unified => {
  process.env.WHATSAPP_SINGLE_INSTANCE_MODE = String(unified);
  await deliver(message({ extendedTextMessage: { text: 'hello', contextInfo: { participant: OWNER_LID } } }));
  expect(processIncomingWhatsAppMessage).toHaveBeenCalledWith(PHONE, 'hello', unified ? 'unified' : 'seller', [],
    expect.objectContaining({ replyTo: PN, candidatePhones: [PHONE] }));
  expect(evolution.sendText).toHaveBeenCalledWith(PN, 'QA mocked AI response');
});

test('a genuine peer LID from the same key is retained, not the quoted bot LID', async () => {
  await deliver(message({ conversation: 'hi' }, { remoteJid: PEER_LID, remoteJidAlt: PN }));
  expect(evolution.sendText).toHaveBeenCalledWith(PEER_LID, 'QA mocked AI response');
});

test('interleaved customers cannot inherit one another or the quoted bot as a recipient', async () => {
  const pn2 = '15550000002@s.whatsapp.net', lid2 = '155500000000002@lid';
  await deliver([
    message({ conversation: 'one' }, { remoteJid: PEER_LID, remoteJidAlt: PN, id: 'one' }),
    message({ conversation: 'two' }, { remoteJid: lid2, remoteJidAlt: pn2, id: 'two' }),
    message({ conversation: 'three' }, { id: 'three' }),
  ]);
  expect(evolution.sendText.mock.calls.map(call => call[0])).toEqual([PEER_LID, lid2, PN]);
});

test('unknown and instance-owner senders cannot cause order or AI work', async () => {
  await deliver([
    message({ conversation: 'unknown' }, { remoteJid: PEER_LID, remoteJidAlt: undefined }),
    message({ conversation: 'owner' }, { remoteJid: OWNER, remoteJidAlt: OWNER }),
  ]);
  expect(evolution.sendText).not.toHaveBeenCalled();
  expect(processIncomingWhatsAppMessage).not.toHaveBeenCalled();
  expect(Order.findById).not.toHaveBeenCalled();
});

test('raw numeric ERROR receipts mark outbound failure instead of being dropped', async () => {
  await deliver({ key: { id: 'qa-outbound-id', remoteJid: PN, fromMe: true }, update: { status: 0 } }, 'messages.update');
  expect(Config.updateOne).toHaveBeenCalled();
  expect(Pending.updateMany).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
    $set: expect.objectContaining({ status: 'failed' }),
  }));
});
