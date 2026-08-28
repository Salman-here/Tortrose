const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const StoreReview = require('../models/StoreReview');
const Store = require('../models/Store');
const { findStoreReviewEligibility } = require('../services/reviewEligibilityService');
const { runInTransaction } = require('../services/walletService');
const {
  enqueueNewStoreReviewNotification,
} = require('../services/sellerOperationalNotificationService');
const {
  getStoreReviewSummaries,
  getStoreReviewSummary,
} = require('../services/storeReviewService');
const { getBlockedUserIds } = require('../services/userBlockService');

const validId = (id) => mongoose.Types.ObjectId.isValid(id);

// GET /api/store-reviews/:storeId — public
exports.getStoreReviews = asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  if (!validId(storeId)) return res.status(400).json({ msg: 'Invalid store ID' });

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

  const blockedReviewers = await getBlockedUserIds(req);
  const reviewFilter = { store: storeId, isVerifiedPurchase: true };
  if (blockedReviewers.length) reviewFilter.user = { $nin: blockedReviewers };

  const [reviews, summary] = await Promise.all([
    StoreReview.find(reviewFilter)
      .select('-helpfulBy -order')
      .populate('user', 'username avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    getStoreReviewSummary(storeId),
  ]);

  const visibleCount = blockedReviewers.length
    ? await StoreReview.countDocuments(reviewFilter)
    : summary.count;
  res.json({
    reviews,
    summary,
    pagination: { limit, skip, hasMore: skip + reviews.length < visibleCount },
  });
});

// GET /api/store-reviews/:storeId/summary — public lightweight aggregate
exports.getStoreReviewSummary = asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  if (!validId(storeId)) return res.status(400).json({ msg: 'Invalid store ID' });
  const summary = await getStoreReviewSummary(storeId);
  res.json({ summary });
});

// POST /api/store-reviews/summary/bulk — body: { storeIds: [] } — for listings
exports.getBulkStoreReviewSummaries = asyncHandler(async (req, res) => {
  const { storeIds = [] } = req.body || {};
  if (!Array.isArray(storeIds)) return res.status(400).json({ msg: 'storeIds must be an array' });
  const summaries = await getStoreReviewSummaries(storeIds.slice(0, 100));
  res.json({ summaries });
});

// GET /api/store-reviews/:storeId/eligibility - protected
exports.getReviewEligibility = asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const userId = req.user.id || req.user._id;
  if (!validId(storeId)) return res.status(400).json({ msg: 'Invalid store ID' });

  const store = await Store.findById(storeId).select('seller storeName storeSlug').lean();
  if (!store) return res.status(404).json({ msg: 'Store not found' });
  if (String(store.seller) === String(userId)) {
    return res.json({ eligibility: { eligible: false, reason: 'own_store', hasReview: false }, review: null });
  }

  const [purchase, review] = await Promise.all([
    findStoreReviewEligibility({ userId, store }),
    StoreReview.findOne({ store: storeId, user: userId })
      .select('-helpfulBy -order')
      .populate('user', 'username avatar')
      .lean(),
  ]);

  return res.json({
    eligibility: {
      eligible: purchase.eligible,
      reason: purchase.reason,
      hasReview: Boolean(review?.isVerifiedPurchase),
    },
    review: purchase.eligible ? review : null,
  });
});

// POST /api/store-reviews/:storeId — protected
exports.createOrUpdateReview = asyncHandler(async (req, res) => {
  const { storeId } = req.params;
  const userId = req.user.id || req.user._id;
  const { rating, title = '', comment = '' } = req.body;

  if (!validId(storeId)) return res.status(400).json({ msg: 'Invalid store ID' });
  const numRating = Number(rating);
  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ msg: 'Rating must be a whole number between 1 and 5' });
  }
  const cleanComment = typeof comment === 'string' ? comment.trim() : '';
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (typeof comment !== 'string' || cleanComment.length > 1000) {
    return res.status(400).json({ msg: 'Comment too long (max 1000 chars)' });
  }
  if (typeof title !== 'string' || cleanTitle.length > 100) {
    return res.status(400).json({ msg: 'Title too long (max 100 chars)' });
  }

  const store = await Store.findById(storeId).select('seller storeName storeSlug');
  if (!store) return res.status(404).json({ msg: 'Store not found' });
  if (store.seller.toString() === userId.toString()) {
    return res.status(403).json({ msg: 'You cannot review your own store' });
  }

  const eligibility = await findStoreReviewEligibility({ userId, store });
  if (!eligibility.eligible) {
    if (eligibility.reason === 'order_not_delivered') {
      return res.status(403).json({
        msg: 'You can rate this store after its part of your order is delivered.',
        reason: eligibility.reason,
      });
    }
    return res.status(403).json({
      msg: "You haven't received an order from this store yet, so you can't rate it.",
      reason: eligibility.reason,
    });
  }

  let existingReview;
  let review;
  await runInTransaction(async session => {
    existingReview = await StoreReview.findOne({ store: storeId, user: userId })
      .select('_id')
      .session(session)
      .lean();
    const currentStore = await Store.findById(storeId)
      .select('seller storeName storeSlug')
      .session(session);
    if (!currentStore) {
      const error = new Error('Store not found');
      error.statusCode = 404;
      throw error;
    }

    review = await StoreReview.findOneAndUpdate(
      { store: storeId, user: userId },
      {
        $set: {
          rating: numRating,
          title: cleanTitle,
          comment: cleanComment,
          order: eligibility.order._id,
          isVerifiedPurchase: true,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
        ...(session ? { session } : {}),
      }
    );

    if (!existingReview) {
      await enqueueNewStoreReviewNotification({
        review,
        store: currentStore,
        buyerName: req.user.username,
      }, { session });
    }
  });

  await review.populate('user', 'username avatar');
  const summary = await getStoreReviewSummary(storeId);

  res.status(existingReview ? 200 : 201).json({
    msg: existingReview ? 'Store review updated' : 'Store review added',
    review,
    summary,
  });
});

// DELETE /api/store-reviews/:reviewId — protected (owner or admin)
exports.deleteReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const userId = req.user.id || req.user._id;
  if (!validId(reviewId)) return res.status(400).json({ msg: 'Invalid review ID' });

  const review = await StoreReview.findById(reviewId);
  if (!review) return res.status(404).json({ msg: 'Review not found' });

  const isOwner = review.user.toString() === userId.toString();
  const isAdmin = req.user.isAdmin || req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ msg: 'Not authorized' });

  await review.deleteOne();
  const summary = await getStoreReviewSummary(review.store);
  res.json({ msg: 'Review deleted', summary });
});

// POST /api/store-reviews/:reviewId/helpful — toggle helpful
exports.toggleHelpful = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const userId = req.user.id || req.user._id;
  if (!validId(reviewId)) return res.status(400).json({ msg: 'Invalid review ID' });

  const review = await StoreReview.findById(reviewId);
  if (!review) return res.status(404).json({ msg: 'Review not found' });

  const idx = review.helpfulBy.findIndex((u) => u.toString() === userId.toString());
  if (idx >= 0) {
    review.helpfulBy.splice(idx, 1);
    review.helpfulCount = Math.max(0, review.helpfulCount - 1);
  } else {
    review.helpfulBy.push(userId);
    review.helpfulCount += 1;
  }
  await review.save();
  res.json({ helpfulCount: review.helpfulCount, marked: idx < 0 });
});

// POST /api/store-reviews/:reviewId/reply — seller reply (must own store)
exports.replyToReview = asyncHandler(async (req, res) => {
  const { reviewId } = req.params;
  const userId = req.user.id || req.user._id;
  const { text } = req.body;
  if (!validId(reviewId)) return res.status(400).json({ msg: 'Invalid review ID' });
  if (!text || typeof text !== 'string' || text.length > 1000) {
    return res.status(400).json({ msg: 'Reply text required (max 1000 chars)' });
  }

  const review = await StoreReview.findById(reviewId);
  if (!review) return res.status(404).json({ msg: 'Review not found' });

  const store = await Store.findById(review.store);
  if (!store) return res.status(404).json({ msg: 'Store not found' });
  if (store.seller.toString() !== userId.toString()) {
    return res.status(403).json({ msg: 'Only the store owner can reply' });
  }

  review.reply = { text: text.trim(), repliedAt: new Date() };
  await review.save();
  res.json({ review });
});
