'use strict';

const mockSendText = jest.fn();
const mockResolveOutboundRecipient = jest.fn();

jest.mock('../../services/whatsapp/sellerEvolutionClient', () => ({
  sendText: (...args) => mockSendText(...args),
}));
jest.mock('../../services/whatsapp/jidRoutingStore', () => ({
  resolveOutboundRecipient: (...args) => mockResolveOutboundRecipient(...args),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const SellerNotificationLog = require('../../models/SellerNotificationLog');
const User = require('../../models/User');
const {
  _tryReserveHourlySlot: tryReserveHourlySlot,
  NOTIFICATION_CATEGORIES,
  notifySeller,
} = require('../../services/whatsapp/sellerNotificationService');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    WhatsAppConfig.init(),
    SellerNotificationLog.init(),
    User.init(),
  ]);
}, 60000);

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveOutboundRecipient.mockResolvedValue('923001234567@s.whatsapp.net');
  mockSendText.mockResolvedValue({ messageId: 'evolution-seller-message-1' });
});

afterEach(async () => {
  await Promise.all([
    WhatsAppConfig.deleteMany({}),
    SellerNotificationLog.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('seller WhatsApp delivery authority and quota', () => {
  test('maps seller operational events to the intended preference or critical policy', () => {
    for (const category of [
      'store_created',
      'store_verification_approved',
      'store_verification_rejected',
      'store_verification_removed',
      'store_review',
    ]) {
      expect(NOTIFICATION_CATEGORIES[category]).toEqual({
        prefKey: 'storeAlerts',
        critical: false,
      });
    }
    for (const category of ['seller_welcome', 'product_blocked', 'payout_account_updated']) {
      expect(NOTIFICATION_CATEGORIES[category]).toEqual({
        prefKey: null,
        critical: true,
      });
    }
  });

  test('concurrent replicas cannot reserve beyond the hourly cap', async () => {
    await WhatsAppConfig.create({
      singletonKey: 'seller',
      status: 'connected',
      sentWindowStartedAt: new Date(),
      sentInLastHour: 58,
    });

    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => tryReserveHourlySlot())
    );
    expect(reservations.filter(result => result.allowed)).toHaveLength(2);
    expect(reservations.filter(result => result.reason === 'hourly_cap_reached')).toHaveLength(6);
    const config = await WhatsAppConfig.findOne({ singletonKey: 'seller' }).lean();
    expect(config.sentInLastHour).toBe(60);
  });

  test('an expired window resets once and every concurrent reservation is retained', async () => {
    await WhatsAppConfig.create({
      singletonKey: 'seller',
      status: 'connected',
      sentWindowStartedAt: new Date(Date.now() - (2 * 60 * 60 * 1000)),
      sentInLastHour: 60,
    });

    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => tryReserveHourlySlot())
    );
    expect(reservations.every(result => result.allowed)).toBe(true);
    const config = await WhatsAppConfig.findOne({ singletonKey: 'seller' }).lean();
    expect(config.sentInLastHour).toBe(8);
  });

  test('uses the verified seller destination and returns the provider message id', async () => {
    await WhatsAppConfig.create({
      singletonKey: 'seller',
      status: 'connected',
      sentWindowStartedAt: new Date(),
      sentInLastHour: 0,
    });
    const seller = await User.create({
      username: 'seller-wa-provider-id',
      email: 'seller-wa-provider-id@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
      sellerInfo: {
        whatsappNumber: '+92 300 1234567',
        whatsappVerified: true,
      },
      whatsappNotificationPrefs: {
        enabled: true,
        orderUpdates: true,
      },
    });

    await expect(notifySeller(seller._id, 'return_request', 'A buyer opened a return.'))
      .resolves.toEqual({ sent: true, messageId: 'evolution-seller-message-1' });
    expect(mockResolveOutboundRecipient).toHaveBeenCalledWith(
      '923001234567',
      '923001234567',
      { instanceType: 'seller' }
    );
    expect(mockSendText).toHaveBeenCalledWith(
      '923001234567@s.whatsapp.net',
      'A buyer opened a return.'
    );
  });

  test('a return request respects the seller order-update preference', async () => {
    await WhatsAppConfig.create({
      singletonKey: 'seller',
      status: 'connected',
      sentWindowStartedAt: new Date(),
      sentInLastHour: 0,
    });
    const seller = await User.create({
      username: 'seller-wa-disabled',
      email: 'seller-wa-disabled@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
      sellerInfo: {
        whatsappNumber: '+92 300 1234567',
        whatsappVerified: true,
      },
      whatsappNotificationPrefs: {
        enabled: true,
        orderUpdates: false,
      },
    });

    await expect(notifySeller(seller._id, 'return_request', 'A buyer opened a return.'))
      .resolves.toEqual({ sent: false, reason: 'category_disabled:orderUpdates' });
    expect(mockResolveOutboundRecipient).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
    const config = await WhatsAppConfig.findOne({ singletonKey: 'seller' }).lean();
    expect(config.sentInLastHour).toBe(0);
  });

  test('a store review respects store-alert preferences while a payout-account change remains critical', async () => {
    await WhatsAppConfig.create({
      singletonKey: 'seller',
      status: 'connected',
      sentWindowStartedAt: new Date(),
      sentInLastHour: 0,
    });
    const seller = await User.create({
      username: 'seller-wa-operational-prefs',
      email: 'seller-wa-operational-prefs@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
      sellerInfo: {
        whatsappNumber: '+92 300 1234567',
        whatsappVerified: true,
      },
      whatsappNotificationPrefs: {
        enabled: false,
        storeAlerts: false,
      },
    });

    await expect(notifySeller(seller._id, 'store_review', 'A buyer rated your store.'))
      .resolves.toEqual({ sent: false, reason: 'notifications_disabled' });
    await expect(notifySeller(seller._id, 'payout_account_updated', 'Your payout account changed.'))
      .resolves.toEqual({ sent: true, messageId: 'evolution-seller-message-1' });
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });
});
