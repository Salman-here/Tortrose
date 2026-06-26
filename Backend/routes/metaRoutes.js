const express = require('express');
const { trackPageView } = require('../services/metaConversionsApi');

const router = express.Router();

router.post('/page-view', (req, res) => {
    const { eventId, pageUrl, referrer, tracking } = req.body || {};

    trackPageView({
        req,
        eventId,
        pageUrl,
        referrer,
        tracking: tracking || {},
    }).catch((error) => {
        console.warn('[meta] PageView relay failed:', error.message);
    });

    return res.status(202).json({ ok: true });
});

module.exports = router;
