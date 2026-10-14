const express = require('express');
const verifyToken = require('../middleware/authMiddleware');
const {
    getSellerPaymentSummary,
    getSellerRevenueOverview,
    upsertSellerPaymentAccount,
    createWithdrawalRequest,
    getSellerWithdrawals,
    getAdminPaymentsOverview,
    updateWithdrawalRequestStatus,
} = require('../controllers/PaymentController');

const router = express.Router();
const { listSafepayPaymentReviews, recheckSafepayPaymentReview, resolveSafepayPaymentReview, getSafepayPaymentReviewAudit } = require('../controllers/safepayPaymentReviewController');

router.get('/seller/summary', verifyToken, getSellerPaymentSummary);
router.get('/seller/revenue-overview', verifyToken, getSellerRevenueOverview);
router.put('/seller/account', verifyToken, upsertSellerPaymentAccount);
router.post('/seller/withdrawals', verifyToken, createWithdrawalRequest);
router.get('/seller/withdrawals', verifyToken, getSellerWithdrawals);

router.get('/admin/overview', verifyToken, getAdminPaymentsOverview);
router.get('/admin/payment-reviews', verifyToken, listSafepayPaymentReviews);
router.get('/admin/payment-reviews/:id/audit', verifyToken, getSafepayPaymentReviewAudit);
router.post('/admin/payment-reviews/:id/recheck', verifyToken, recheckSafepayPaymentReview);
router.post('/admin/payment-reviews/:id/resolve', verifyToken, resolveSafepayPaymentReview);
router.patch('/admin/withdrawals/:id', verifyToken, updateWithdrawalRequestStatus);

module.exports = router;
