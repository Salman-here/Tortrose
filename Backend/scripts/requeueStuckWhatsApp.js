// One-off repair script: requeue any whatsapp pending messages whose last
// send attempt used the broken "viewOnceMessage" path (status='sent' but
// no delivery to the buyer). Also reset pairs that were never completed.
//
// Run from Railway shell:  node Backend/scripts/requeueStuckWhatsApp.js

const mongoose = require('mongoose');
require('dotenv').config();

const WhatsAppPendingMessage = require('../models/WhatsAppPendingMessage');

// Orders to force-requeue regardless of state (pass via env var comma-separated)
const FORCE_ORDER_IDS = (process.env.REQUEUE_ORDER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
    const uri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) { console.error('MONGO_URI / MONGO_URL / MONGODB_URI not set'); process.exit(1); }
    await mongoose.connect(uri);
    console.log('Connected to Mongo');

    const query = FORCE_ORDER_IDS.length
        ? { orderId: { $in: FORCE_ORDER_IDS } }
        // Default: any 'sent' job from the last 6h whose buyer never replied
        //          (likely a casualty of the broken buttons path)
        : {
            status: 'sent',
            sentAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) },
            repliedAt: null,
        };

    const docs = await WhatsAppPendingMessage.find(query);
    console.log('Matched', docs.length, 'pending message(s)');

    for (const d of docs) {
        if (String(d.dedupeKey || '').startsWith('outbox:')) {
            console.log(`  Skipped ${d.orderId} — retry it through the outbox-aware admin endpoint`);
            continue;
        }
        const before = d.status;
        d.status = 'queued';
        d.attempts = 0;
        d.lastError = '';
        d.summaryMessageId = '';
        d.pollMessageId = '';
        d.sentAt = null;
        d.repliedAt = null;
        d.leaseToken = null;
        d.leaseOwner = '';
        d.leaseExpiresAt = null;
        d.nextAttemptAt = new Date(Date.now() + 2000);
        await d.save();
        console.log(`  Requeued ${d.orderId} → ${d.phone} (was ${before})`);
    }

    await mongoose.disconnect();
    console.log('Done');
    process.exit(0);
})().catch((e) => {
    console.error('Script failed:', e);
    process.exit(1);
});
