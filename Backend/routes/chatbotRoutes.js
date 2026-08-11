const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const { optionalAuth, admin } = require('../middleware/authMiddleware');
const {
    chat,
    getUserContext,
    submitComplaint,
    getMyComplaints,
    getAllComplaints,
    updateComplaint,
    getChatHistory,
    saveChatHistory,
    clearChatHistory
} = require('../controllers/chatbotController');

// Chat endpoint (works for both authenticated and guest users)
router.post('/chat', optionalAuth, chat);

// User context for AI personalization (authenticated)
router.get('/user-context', verifyToken, getUserContext);

// Complaint routes (authenticated)
router.post('/complaint', verifyToken, submitComplaint);
router.get('/my-complaints', verifyToken, getMyComplaints);
router.get('/complaints', verifyToken, admin, getAllComplaints);
router.put('/complaint/:id', verifyToken, admin, updateComplaint);

// Chat history routes (authenticated)
router.get('/history', verifyToken, getChatHistory);
router.post('/history', verifyToken, saveChatHistory);
router.delete('/history', verifyToken, clearChatHistory);

module.exports = router;
