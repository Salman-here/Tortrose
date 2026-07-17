const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const {
  getStoreReviews,
  getStoreReviewSummary,
  getBulkStoreReviewSummaries,
  getReviewEligibility,
  createOrUpdateReview,
  deleteReview,
  toggleHelpful,
  replyToReview,
} = require('../controllers/storeReviewController');

// Public
router.get('/:storeId', getStoreReviews);
router.get('/:storeId/summary', getStoreReviewSummary);
router.post('/summary/bulk', getBulkStoreReviewSummaries);

// Protected
router.get('/:storeId/eligibility', verifyToken, getReviewEligibility);
router.post('/:storeId', verifyToken, createOrUpdateReview);
router.delete('/:reviewId', verifyToken, deleteReview);
router.post('/:reviewId/helpful', verifyToken, toggleHelpful);
router.post('/:reviewId/reply', verifyToken, replyToReview);

module.exports = router;
