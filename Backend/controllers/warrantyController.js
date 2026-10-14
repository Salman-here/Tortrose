'use strict';
const { Readable } = require('node:stream');
const Order = require('../models/Order');
const Request = require('../models/ReturnRequest');
const Evidence = require('../models/AfterSalesEvidence');
const { cloudinary } = require('../utils/cloudinary');
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

// Do not rely on a browser-supplied MIME type, or allow SVG/script payloads.
const imageMime = buffer => {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};
exports.imageMime = imageMime;
exports.uploadEvidence = async (req, res) => {
  try {
    const orderId = req.body?.orderId, claimId = req.body?.claimId;
    if (!objectId(orderId) || claimId && !objectId(claimId)) return res.status(400).json({ msg: 'A valid order and original claim are required.' });
    const mime = imageMime(req.file?.buffer);
    if (!mime || mime !== req.file.mimetype || !req.file.size || req.file.size > 5242880) return res.status(400).json({ msg: 'Upload a JPEG, PNG or WebP photo up to 5 MB.' });
    const order = await Order.findOne({ _id: orderId, user: req.user.id, awaitingPayment: { $ne: true } });
    if (!order) return res.status(404).json({ msg: 'Order not found in this account.' });
    let allowed = false;
    if (claimId) {
      const original = await Request.findOne({ _id: claimId, order: orderId, buyer: req.user.id, kind: 'warranty', status: 'rejected' });
      allowed = original?.warrantySnapshot?.version === 1 && original.requestedAt <= original.warrantySnapshot.deadline;
    } else {
      const coverage = await buildWarrantyEligibility(order);
      allowed = coverage.groups.some(group => group.items.some(item => item.eligible));
    }
    if (!allowed) return res.status(409).json({ msg: 'No eligible warranty claim or original appeal was found.' });
    const recent = await Evidence.countDocuments({ user: req.user.id, createdAt: { $gte: new Date(Date.now() - 3600000) } });
    if (recent >= 30) return res.status(429).json({ msg: 'Photo upload limit reached. Please try again later.' });
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'Rozare/Warranty', resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'], timeout: 30000 }, (error, result) => error ? reject(error) : resolve(result));
      Readable.from(req.file.buffer).pipe(stream);
    });
    if (!uploaded?.secure_url?.startsWith('https://') || !uploaded.public_id) throw new Error('Photo storage could not be verified.');
    const evidence = await Evidence.create({ user: req.user.id, order: orderId, url: uploaded.secure_url,
      publicId: uploaded.public_id, mime, size: req.file.size });
    return res.status(201).json({ success: true, evidence: { _id: evidence._id, url: evidence.url } });
  } catch (error) { return errorResponse(res, error); }
};
