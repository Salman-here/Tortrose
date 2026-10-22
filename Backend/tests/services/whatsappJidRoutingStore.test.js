'use strict';

jest.mock('../../models/WhatsAppJidMapping', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn() }));
let store, model, mongoose, addressing;
const PHONE = '15550000001', PN = PHONE + '@s.whatsapp.net', LID = '155500000000001@lid';
const OWNER_LID = '155500000000000@lid';
const options = { instanceType: 'seller', instanceName: 'qa-seller-instance' };
const route = extra => ({ phone: PHONE, lidJid: LID, ...options,
  source: addressing.ROUTE_SOURCE, lastSeenAt: new Date(), ...extra });
const inbound = () => addressing.resolveInboundAddress({
  key: { remoteJid: LID, remoteJidAlt: PN, fromMe: false },
});
const databaseRoute = value => model.findOne.mockReturnValue({
  sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }),
});

beforeEach(() => {
  jest.resetModules();
  addressing = require('../../services/whatsapp/addressing');
  model = require('../../models/WhatsAppJidMapping');
  mongoose = require('mongoose');
  store = require('../../services/whatsapp/jidRoutingStore');
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 1 });
  databaseRoute(null);
});
afterEach(() => jest.restoreAllMocks());

test('only a same-envelope, explicitly inbound pair can populate the versioned store', async () => {
  model.findOneAndUpdate.mockResolvedValue(route());
  await expect(store.rememberInboundRoute(inbound(), options)).resolves.toMatchObject({ lidJid: LID });
  expect(model.findOneAndUpdate).toHaveBeenCalledWith(
    { phone: PHONE, instanceType: 'seller' },
    { $set: { lidJid: LID, instanceName: options.instanceName,
      source: addressing.ROUTE_SOURCE, lastSeenAt: expect.any(Date) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  expect(await store.resolveOutboundRecipient(PHONE, LID, options)).toBe(LID);
});

test.each([
  {}, { identityPhone: PHONE, lidJid: OWNER_LID },
  { identityPhone: PHONE, lidJid: OWNER_LID, verifiedPeerLid: false, routingSource: 'sender-envelope-v2' },
  { identityPhone: PHONE, lidJid: OWNER_LID, verifiedPeerLid: true, routingSource: 'webhook' },
  { identityPhone: PHONE, lidJid: OWNER_LID, verifiedPeerLid: true, routingSource: 'sender-envelope-v2', excludedOwnerLids: [OWNER_LID] },
])('cannot persist an unverified or excluded route: %j', async address => {
  expect(await store.rememberInboundRoute(address, options)).toBeNull();
  expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  expect(await store.resolveOutboundRecipient(PHONE, OWNER_LID, options)).toBe(PN);
});

test.each([PN, '15550000000@s.whatsapp.net'])('explicit phone requests (%s) retain the authoritative phone', async requested => {
  await store.rememberInboundRoute(inbound(), options);
  expect(await store.resolveOutboundRecipient(PHONE, requested, options)).toBe(PN);
  expect(model.findOne).not.toHaveBeenCalled();
});

test('uses a fresh versioned route only in the same physical instance', async () => {
  databaseRoute(route());
  expect(await store.resolveOutboundRecipient(PHONE, PHONE, options)).toBe(LID);
  expect(model.findOne).toHaveBeenCalledWith({ phone: PHONE, ...options,
    source: addressing.ROUTE_SOURCE, lastSeenAt: { $gte: expect.any(Date) } });
});

test('an explicit LID must match the verified phone association', async () => {
  databaseRoute(route());
  expect(await store.resolveOutboundRecipient(PHONE, OWNER_LID, options)).toBe(PN);
  expect(await store.resolveOutboundRecipient(PHONE, LID, options)).toBe(LID);
});

test.each([
  { source: 'webhook' }, { source: 'evolution-message-store' }, { source: undefined },
  { instanceName: 'other-instance' }, { phone: '15550000002' },
  { lidJid: PN }, { lastSeenAt: new Date(0) }, { lastSeenAt: 'invalid' },
])('legacy, expired, malformed and wrong-instance database routes are ignored: %j', async extra => {
  databaseRoute(route(extra));
  expect(await store.resolveOutboundRecipient(PHONE, OWNER_LID, options)).toBe(PN);
  expect(await store.resolveOutboundRecipient(PHONE, PHONE, options)).toBe(PN);
});

test('a route from another physical instance is not reused from memory', async () => {
  await store.rememberInboundRoute(inbound(), options);
  expect(await store.resolveOutboundRecipient(PHONE, LID, { ...options, instanceName: 'other-instance' })).toBe(PN);
  expect(await store.resolveOutboundRecipient(PHONE, LID, { instanceType: 'main', instanceName: options.instanceName })).toBe(PN);
});

test('memory routes expire and old persisted mappings cannot resurrect them', async () => {
  await store.rememberInboundRoute(inbound(), options);
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + addressing.LID_MAPPING_TTL_MS + 1);
  databaseRoute(route({ source: 'webhook' }));
  expect(await store.resolveOutboundRecipient(PHONE, LID, options)).toBe(PN);
});

test('database failure cannot redirect a customer to an unverified LID', async () => {
  model.findOne.mockImplementation(() => { throw new Error('synthetic unavailable database'); });
  expect(await store.resolveOutboundRecipient(PHONE, OWNER_LID, options)).toBe(PN);
});

test('database unavailable uses only a fresh in-process verified association or the original phone', async () => {
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, get: () => 0 });
  expect(await store.resolveOutboundRecipient(PHONE, OWNER_LID, options)).toBe(PN);
  await store.rememberInboundRoute(inbound(), options);
  expect(await store.resolveOutboundRecipient(PHONE, LID, options)).toBe(LID);
  expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  expect(model.findOne).not.toHaveBeenCalled();
});

test('does not derive a destination from an invalid account identity', async () => {
  expect(await store.resolveOutboundRecipient(LID, OWNER_LID, options)).toBe('');
  expect(await store.resolveOutboundRecipient('not a phone', OWNER_LID, options)).toBe('');
  expect(await store.resolveOutboundRecipient(PHONE, OWNER_LID, { instanceType: 'unknown' })).toBe(PN);
});
