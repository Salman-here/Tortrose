'use strict';
const Review = require('../models/SafepayPaymentReview');
const Payment = require('../models/SafepayPayment');
const { publicReview, createSafepayPaymentReviewService } = require('../services/safepayPaymentReviewService');
const forbidden = async (req, res) => {
  const actor = String(req.user?.id || req.user?._id || '');
  if (req.user?.role === 'admin' && /^[a-f0-9]{24}$/i.test(actor)
      && await require('../models/User').exists({ _id: actor, role: 'admin', status: { $ne: 'blocked' } })) return false;
  res.status(403).json({ code: 'SAFEPAY_REVIEW_FORBIDDEN', msg: 'Admin access is required.' });
  return true;
};
const errorResponse = (res, error) => res.status(error.statusCode || 503).json({
  code: error.code || 'SAFEPAY_REVIEW_UNAVAILABLE',
  msg: error.statusCode ? error.message : 'Payment review could not be completed. No final decision was recorded.',
});
function createController({ serviceFor = createSafepayPaymentReviewService } = {}) {
const handlers = {};
handlers.listSafepayPaymentReviews = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (await forbidden(req, res)) return;
    const status = req.query?.status || 'pending', page = Number(req.query?.page || 1);
    if (!['pending', 'won', 'lost', 'all'].includes(status) || !Number.isSafeInteger(page) || page < 1 || page > 10000) return res.status(400).json({ msg: 'Invalid review filter or page.' });
    const scope = status === 'all' ? {} : { status }, limit = 50;
    const [reviews, total] = await Promise.all([Review.find(scope).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), Review.countDocuments(scope)]);
    const payments = await Payment.find({ _id: { $in: reviews.map(row => row.payment) } }).select('reference').lean();
    const byId = new Map(payments.map(row => [String(row._id), row]));
    res.json({ version: 1, reviews: reviews.map(row => publicReview(row, byId.get(String(row.payment)))), page, total, hasMore: page * limit < total });
  } catch (error) { errorResponse(res, error); }
};
handlers.recheckSafepayPaymentReview = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (await forbidden(req, res)) return;
    if (!/^[a-f0-9]{24}$/i.test(req.params.id || '')) return res.status(400).json({ msg: 'Invalid payment review.' });
    const review = await serviceFor().refreshReview(req.params.id);
    res.json({ version: 1, review });
  } catch (error) { errorResponse(res, error); }
};
handlers.resolveSafepayPaymentReview = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (await forbidden(req, res)) return;
    const review = await serviceFor().resolveReview(req.params.id,
      { ...req.body, operationKey: req.get('Idempotency-Key') }, String(req.user.id || req.user._id || ''));
    res.json({ version: 1, review });
  } catch (error) { errorResponse(res, error); }
};
handlers.getSafepayPaymentReviewAudit = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (await forbidden(req, res)) return;
    if (!/^[a-f0-9]{24}$/i.test(req.params.id || '')) return res.status(400).json({ msg: 'Invalid payment review.' });
    const review = await Review.findById(req.params.id).select('+providerCaseReference +evidenceText +evidenceFingerprint').lean();
    if (!review) return res.status(404).json({ msg: 'Payment review was not found.' });
    res.json({ version: 1, reviewId: String(review._id), audit: { status: review.status,
      authority: review.authority || null, caseReference: review.providerCaseReference || '', evidence: review.evidenceText || '',
      evidenceFingerprint: review.evidenceFingerprint || null, resolvedAt: review.resolvedAt,
      resolvedBy: review.resolvedBy ? String(review.resolvedBy) : null, principalMinor: review.principalMinor,
      currency: review.currency, sellerAllocations: review.sellerAllocations.map(row => ({ seller: String(row.seller),
        order: row.order ? String(row.order) : null, amountMinor: row.amountMinor })),
      platformPrincipalMinor: review.platformPrincipalMinor,
      buyerAllocations: review.buyerAllocations.map(row => ({ wallet: String(row.wallet), source: String(row.source), amountMinor: row.amountMinor })) } });
  } catch (error) { errorResponse(res, error); }
};
return handlers;
}
module.exports = { ...createController(), createController };
