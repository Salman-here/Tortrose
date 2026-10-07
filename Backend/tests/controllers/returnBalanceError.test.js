'use strict';
jest.mock('../../models/ReturnRequest', () => ({ findOne: jest.fn() }));
jest.mock('../../models/Order', () => ({ findById: jest.fn() }));
jest.mock('../../services/returnService', () => ({ settleFromSellerBalance: jest.fn() }));
jest.mock('../../services/returnNotificationService', () => ({}));
const ReturnRequest = require('../../models/ReturnRequest');
const Order = require('../../models/Order');
const { settleFromSellerBalance } = require('../../services/returnService');
const { acceptReturn } = require('../../controllers/returnController');

test.each(['PKR', 'USD', 'EUR', 'GBP'])('insufficient return balance exposes exact %s money without relabeling it as USD', async currency => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    ReturnRequest.findOne.mockResolvedValue({ _id: 'return-1', order: 'order-1', policySnapshot: { refundType: 'full_refund' } });
    Order.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ paymentMethod: 'cash_on_delivery', isPaid: false }) });
    settleFromSellerBalance.mockRejectedValue(Object.assign(new Error('Not enough native balance'), {
      statusCode: 400, code: 'INSUFFICIENT_SELLER_BALANCE', availableBalance: 1999.90, currency,
    }));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await acceptReturn({ user: { role: 'seller', id: 'seller-1' }, params: { id: 'return-1' }, body: { fundingSource: 'seller_balance' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_SELLER_BALANCE',
      availableBalance: 1999.90, availableBalanceCurrency: currency, availableBalanceUSD: currency === 'USD' ? 1999.90 : undefined }));
  } finally { log.mockRestore(); }
});
