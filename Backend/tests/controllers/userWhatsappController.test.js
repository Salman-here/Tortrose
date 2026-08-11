jest.mock('../../models/WhatsAppOTP', () => ({
  create: jest.fn(),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
}));
jest.mock('../../models/WhatsAppConfig', () => ({
  findOne: jest.fn(),
}));
jest.mock('../../models/User', () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../services/whatsapp/evolutionClient', () => ({
  isConfigured: jest.fn(() => true),
  checkWhatsAppNumber: jest.fn(),
  sendText: jest.fn(),
}));
jest.mock('../../services/whatsappOtpVerificationService', () => ({
  verifyAndClaimWhatsAppOTP: jest.fn(),
}));
jest.mock('../../services/whatsappOtpRateLimitService', () => ({
  reserveWhatsAppOtpSend: jest.fn(),
  releaseWhatsAppOtpSend: jest.fn(),
}));
jest.mock('../../services/whatsappIdentityService', () => ({
  conflictMessage: jest.fn(conflict => `conflict:${conflict.kind}`),
  findWhatsAppIdentityConflict: jest.fn(),
}));

const WhatsAppOTP = require('../../models/WhatsAppOTP');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const User = require('../../models/User');
const evolution = require('../../services/whatsapp/evolutionClient');
const { verifyAndClaimWhatsAppOTP } = require('../../services/whatsappOtpVerificationService');
const { findWhatsAppIdentityConflict } = require('../../services/whatsappIdentityService');
const {
  sendUserWhatsAppOTP,
  verifyUserWhatsAppOTP,
} = require('../../controllers/userWhatsappController');

const response = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('buyer WhatsApp identity exclusivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    evolution.isConfigured.mockReturnValue(true);
    WhatsAppConfig.findOne.mockResolvedValue({ status: 'connected' });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ whatsappInfo: {} }),
    });
  });

  test('blocks OTP delivery when the number belongs to a seller role', async () => {
    findWhatsAppIdentityConflict.mockResolvedValue({ kind: 'seller' });
    const res = response();

    await sendUserWhatsAppOTP({
      user: { id: 'buyer-1' },
      body: { whatsappNumber: '+923001112222' },
    }, res);

    expect(findWhatsAppIdentityConflict).toHaveBeenCalledWith('923001112222', {
      channel: 'buyer',
      userId: 'buyer-1',
    });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(evolution.checkWhatsAppNumber).not.toHaveBeenCalled();
    expect(evolution.sendText).not.toHaveBeenCalled();
  });

  test('rechecks global ownership after atomically claiming an account-bound OTP', async () => {
    verifyAndClaimWhatsAppOTP.mockResolvedValue({
      status: 'verified',
      record: { _id: 'otp-1' },
    });
    findWhatsAppIdentityConflict.mockResolvedValue({ kind: 'admin' });
    const res = response();

    await verifyUserWhatsAppOTP({
      user: { id: 'buyer-1' },
      body: { whatsappNumber: '+923001112222', otp: '123456' },
    }, res);

    expect(verifyAndClaimWhatsAppOTP).toHaveBeenCalledWith(expect.objectContaining({
      number: '923001112222',
      sellerId: 'buyer-1',
      otp: '123456',
    }));
    expect(WhatsAppOTP.deleteOne).toHaveBeenCalledWith({ _id: 'otp-1' });
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });
});
