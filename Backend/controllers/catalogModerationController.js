'use strict';
const Product = require('../models/Product');

exports.getProductModerationStatus = async (req, res) => {
  if (!['seller', 'admin'].includes(req.user?.role)) return res.status(403).json({ msg: 'Seller access required.' });
  const ids = [...new Set((Array.isArray(req.query.ids) ? req.query.ids : String(req.query.ids || '').split(',')).filter(Boolean))];
  if (!ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) return res.status(400).json({ msg: 'Provide up to 100 valid product identifiers.' });
  try {
    const products = await Product.find({ _id: { $in: ids }, ...(req.user.role === 'seller' ? { seller: req.user.id || req.user._id } : {}) })
      .select('moderationStatus moderationPolicyVersion moderationRevision moderationReason moderationFields moderationReviewedAt isBlocked blockedReason image images').lean();
    return res.json({ products });
  } catch (_) { return res.status(503).json({ msg: 'Content status is temporarily unavailable.' }); }
};
