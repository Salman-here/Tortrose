'use strict';
const Order = require('../models/Order');
const Request = require('../models/ReturnRequest');
const { buildWarrantyEligibility, createWarrantyService } = require('../services/warrantyService');
const service = createWarrantyService();
const objectId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);
const errorResponse = (res, error) => res.status(error.statusCode || 500).json({ msg: error.statusCode ? error.message : 'Unable to complete the warranty action. Please try again.', code: error.code });

function requestKey(req) {
  const header = req.get('Idempotency-Key'), body = req.body?.requestKey;
  if (header && body && header !== body) throw Object.assign(new Error('Request keys must match.'), { statusCode: 400 });
  return header || body;
}

exports.eligibility = async (req, res) => {
  try {
    if (!objectId(req.params.orderId)) return res.status(400).json({ msg: 'A valid order is required.' });
    const order = await Order.findOne({ _id: req.params.orderId, user: req.user.id });
    if (!order) return res.status(404).json({ msg: 'Order not found in this account.' });
    return res.json({ success: true, ...await buildWarrantyEligibility(order) });
  } catch (error) { return errorResponse(res, error); }
};
exports.create = async (req, res) => {
  try {
    const returnRequest = await service.createClaim({ orderId: req.body?.orderId, buyerId: req.user.id,
      sellerId: req.body?.sellerId, items: req.body?.items, reasonDetails: req.body?.reasonDetails,
      evidenceIds: req.body?.evidenceIds, requestKey: requestKey(req) });
    const replayed = returnRequest.$locals?.idempotencyReplay === true;
    return res.status(replayed ? 200 : 201).json({ success: true, replayed, returnRequest, msg: 'Warranty claim sent to the seller.' });
  } catch (error) { return errorResponse(res, error); }
};
exports.decide = async (req, res) => {
  try {
    if (req.user.role !== 'seller') return res.status(403).json({ msg: 'Seller access required.' });
    const returnRequest = await service.decide({ claimId: req.params.id, sellerId: req.user.id,
      outcome: req.body?.outcome, resolution: req.body?.resolution, reason: req.body?.reason,
      expectedUpdatedAt: req.body?.expectedUpdatedAt });
    return res.json({ success: true, returnRequest, msg: 'Decision sent to the buyer.' });
  } catch (error) { return errorResponse(res, error); }
};
exports.appeal = async (req, res) => {
  try {
    const returnRequest = await service.appeal({ claimId: req.params.id, buyerId: req.user.id,
      reasonDetails: req.body?.reasonDetails, evidenceIds: req.body?.evidenceIds, requestKey: requestKey(req) });
    return res.json({ success: true, returnRequest, msg: 'Appeal sent for review under the original warranty.' });
  } catch (error) { return errorResponse(res, error); }
};

const evidenceController = require('./afterSalesEvidenceController');
exports.imageMime = evidenceController.imageMime;
exports.uploadEvidence = evidenceController.createUploader('warranty');
