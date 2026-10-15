'use strict';
const { Readable } = require('node:stream');
const Order = require('../models/Order');
const Request = require('../models/ReturnRequest');
const Evidence = require('../models/AfterSalesEvidence');
const { cloudinary } = require('../utils/cloudinary');
const { objectId } = require('../services/afterSalesEvidenceService');

const imageMime = buffer => {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};
const createUploader = kind => {
  if (!['return','warranty'].includes(kind)) throw new TypeError('A fixed server-side evidence kind is required.');
  return async (req, res) => {
    try {
      const orderId = req.body?.orderId, claimId = req.body?.claimId;
      if (!objectId(orderId) || claimId && (kind !== 'warranty' || !objectId(claimId))) return res.status(400).json({ msg: 'A valid order and request are required.' });
      const mime = imageMime(req.file?.buffer);
      if (!mime || mime !== req.file.mimetype || !req.file.size || req.file.size > 5242880) return res.status(400).json({ msg: 'Upload a JPEG, PNG or WebP photo up to 5 MB.' });
      const order = await Order.findOne({ _id: orderId, user: req.user.id, awaitingPayment: { $ne: true } });
      if (!order) return res.status(404).json({ msg: 'Order not found in this account.' });
      let allowed;
      if (claimId) {
        const original = await Request.findOne({ _id: claimId, order: orderId, buyer: req.user.id, kind: 'warranty', status: 'rejected' });
        allowed = original?.warrantySnapshot?.version === 1 && original.requestedAt <= original.warrantySnapshot.deadline;
      } else if (kind === 'warranty') {
        const coverage = await require('../services/warrantyService').buildWarrantyEligibility(order);
        allowed = coverage.groups.some(group => group.items.some(item => item.eligible));
      } else {
        const groups = await require('../services/returnService').buildOrderReturnEligibility(order);
        allowed = groups.some(group => group.eligible && group.items.some(item => item.eligible && item.remainingReturnableQuantity > 0));
      }
      if (!allowed) return res.status(409).json({ msg: `No eligible ${kind === 'return' ? 'return' : 'warranty claim or original appeal'} was found.` });
      if (await Evidence.countDocuments({ user: req.user.id, createdAt: { $gte: new Date(Date.now() - 3600000) } }) >= 30) return res.status(429).json({ msg: 'Photo upload limit reached. Please try again later.' });
      const uploaded = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: kind === 'return' ? 'Rozare/Returns' : 'Rozare/Warranty', resource_type: 'image',
          allowed_formats: ['jpg','jpeg','png','webp'], timeout: 30000 }, (error, result) => error ? reject(error) : resolve(result));
        Readable.from(req.file.buffer).pipe(stream);
      });
      if (!uploaded?.secure_url?.startsWith('https://') || !uploaded.public_id) throw new Error('Photo storage could not be verified.');
      const evidence = await Evidence.create({ user: req.user.id, order: orderId, kind, url: uploaded.secure_url,
        publicId: uploaded.public_id, mime, size: req.file.size });
      return res.status(201).json({ success: true, evidence: { _id: evidence._id, url: evidence.url } });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ msg: error.statusCode ? error.message : 'The photo could not be uploaded. Please retry.', code: error.code });
    }
  };
};
module.exports = { imageMime, createUploader };
