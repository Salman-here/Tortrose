'use strict';
const { getOwnedOrderReceipt } = require('../services/orderReceiptService');

exports.getOrderReceipt = async (req, res) => {
  res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', Expires: '0' });
  try {
    return res.json(await getOwnedOrderReceipt({ reference: req.params.reference, buyerId: req.user?.id || req.user?._id }));
  } catch (error) {
    return res.status(error.statusCode || 503).json({ msg: error.statusCode ? error.message : 'Order confirmation is temporarily unavailable. Please retry.',
      code: error.code || 'ORDER_RECEIPT_UNAVAILABLE' });
  }
};
