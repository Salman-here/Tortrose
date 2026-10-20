'use strict';
jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn() }));
jest.mock('../../services/whatsapp/evolutionClient', () => ({ sendText: jest.fn() }));
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => ({ sendText: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Notification = require('../../models/Notification');
const { dismissMine, listMine } = require('../../controllers/notificationController');
const { buildScopedNotificationQuery } = require('../../services/notificationAudienceService');
let mongo;
const owner = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(data) { this.body = JSON.parse(JSON.stringify(data)); return this; } });
const row = fields => Notification.create({ user: owner, title: 'QA update', body: 'A durable order update.', category: 'order', source: 'system', targetRole: 'user', ...fields });
const request = (ids, overrides = {}) => ({ user: { id: String(owner), role: 'user' }, query: {}, body: { ids }, ...overrides });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterEach(async () => Notification.deleteMany({}));
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

test('dismissal is saved across refreshes, removes unread count and retains the audit record', async () => {
  const n = await row({ read: false });
  const res = response(); await dismissMine(request([String(n._id)]), res);
  expect(res.statusCode).toBe(200); expect(res.body.dismissedIds).toEqual([String(n._id)]);
  const retained = await Notification.findById(n._id).lean();
  expect(retained.read).toBe(true); expect(retained.dismissedAt).toBeInstanceOf(Date);
  const inbox = response(); await listMine(request([]), inbox);
  expect(inbox.body.items).toEqual([]); expect(inbox.body.unread).toBe(0);
});
test('a retry after a lost response is idempotent, and a new event is not dismissed', async () => {
  const n = await row({});
  for (let i = 0; i < 2; i++) { const res = response(); await dismissMine(request([String(n._id)]), res); expect(res.statusCode).toBe(200); }
  const later = await row({ title: 'A later update' });
  const visible = await Notification.find(buildScopedNotificationQuery({ userId: owner, role: 'user' })).lean();
  expect(visible.map(n => String(n._id))).toEqual([String(later._id)]);
});
test('another owner or another role cannot be dismissed, even in a mixed batch', async () => {
  const mine = await row({}), theirs = await row({ user: other }), sellerOnly = await row({ targetRole: 'seller' });
  for (const forbidden of [theirs, sellerOnly]) {
    const res = response(); await dismissMine(request([String(mine._id), String(forbidden._id)]), res);
    expect(res.statusCode).toBe(404);
    expect(await Notification.countDocuments({ dismissedAt: { $ne: null } })).toBe(0);
  }
});
test('seller surface allows only seller notifications and verifies the response envelope', async () => {
  const n = await row({ targetRole: 'seller' }), buyer = await row({});
  const req = request([String(n._id)], { user: { id: String(owner), role: 'seller' }, query: { surface: 'seller' } });
  const res = response(); await dismissMine(req, res);
  expect(res.body.account).toEqual({ userId: String(owner), role: 'seller', surface: 'seller' });
  const bad = response(); await dismissMine({ ...req, body: { ids: [String(buyer._id)] } }, bad); expect(bad.statusCode).toBe(404);
});
test.each([[], ['not-an-id'], new Array(201).fill(String(owner)), [' ' + String(owner)]].map(ids => [ids]))('rejects malformed or overbroad dismissal ids', async ids => {
  const res = response(); await dismissMine(request(ids), res); expect(res.statusCode).toBe(400);
});
test('legacy rows without a dismissedAt field remain visible', async () => {
  const n = await row({}); await Notification.collection.updateOne({ _id: n._id }, { $unset: { dismissedAt: '' } });
  expect(await Notification.countDocuments(buildScopedNotificationQuery({ userId: owner, role: 'user' }))).toBe(1);
});
test('optional dismissal identities are owner- and role-scoped and contain no notification body', async () => {
  const mine = await row({ dismissedAt: new Date(), eventKey: 'order:qa:paid:v1', aggregateType: 'Order', aggregateId: 'order-qa' });
  await row({ user: other, dismissedAt: new Date() }); await row({ targetRole: 'seller', dismissedAt: new Date() });
  const res = response(); await listMine(request([], { query: { includeDismissals: 'true' } }), res);
  expect(res.body.dismissedItems).toHaveLength(1);
  expect(res.body.dismissedItems[0]).toEqual({ _id: String(mine._id), eventKey: 'order:qa:paid:v1', aggregateType: 'Order', aggregateId: 'order-qa' });
});
