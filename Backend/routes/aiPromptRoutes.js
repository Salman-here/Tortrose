const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/authMiddleware');
const { admin } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/aiPromptController');

// All AI prompt management is admin-only.
router.get('/', verifyToken, admin, ctrl.listPrompts);
router.post('/', verifyToken, admin, ctrl.createPrompt);
router.get('/preview/:role', verifyToken, admin, ctrl.previewPrompt);
router.put('/:key', verifyToken, admin, ctrl.updatePrompt);
router.post('/:key/reset', verifyToken, admin, ctrl.resetPrompt);
router.delete('/:key', verifyToken, admin, ctrl.deletePrompt);

module.exports = router;
