// Parses Evolution API webhook events and drives the order confirmation flow.
//
// What this handles:
//   - CONNECTION_UPDATE  → keeps WhatsAppConfig in sync so the admin status badge is accurate.
//   - MESSAGES_UPSERT    → looks at inbound buyer messages and accepts only
//                         WhatsApp button/list payloads for order decisions.
//
// Side-effects on CONFIRM:
//   1. order.orderStatus = 'confirmed', confirmation.* timestamps updated
//   2. Friendly thank-you reply sent on WhatsApp
//   3. Seller notified via email + Expo push + persistent in-app Notification
//
// Side-effects on CANCEL:
//   1. order.orderStatus = 'cancelled', confirmation.declinedAt set
//   2. Friendly "got it, cancelled" reply sent
//   3. Seller notified the buyer backed out

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const WhatsAppConfig = require('../../models/WhatsAppConfig');
const WhatsAppPendingMessage = require('../../models/WhatsAppPendingMessage');
const { sendEmail } = require('../../controllers/mailController');
const { sellerOrderConfirmedByBuyerEmail } = require('../../utils/emailTemplates');
const { sendPushToUser } = require('../../utils/expoPush');
const { findPendingJobByPhone, findPendingJobByOrderId, applyVote, markInboundConversationWindowOpen } = require('./queue');
const { buildReconfirmButtonsPayload } = require('./messageBuilder');
const evolution = require('./evolutionClient');
const { notifySeller } = require('./sellerNotificationService');
const sellerTemplates = require('./sellerMessageTemplates');
const { processIncomingWhatsAppMessage } = require('./whatsappAIChatService');
const {
    isGroupOrBroadcastJid,
    resolveInboundAddress,
    uniqueNonEmpty,
} = require('./addressing');
const {
    rememberInboundRoute,
    resolveOutboundRecipient,
} = require('./jidRoutingStore');
const {
    configKeyFor,
    routingScopeFor,
    useUnifiedWhatsAppInstance,
} = require('./gatewayMode');

const asArray = (value) => Array.isArray(value) ? value : [value].filter(Boolean);

const latestMessageUpdateStatus = (msg = {}) => {
    const updates = msg.MessageUpdate || msg.messageUpdate || msg.updates || [];
    const latest = Array.isArray(updates) ? updates[updates.length - 1] : updates;
    return String(
        msg.status ||
        msg.update?.status ||
        msg.message?.status ||
        latest?.status ||
        ''
    ).toUpperCase();
};

const messageKeyFromUpdate = (msg = {}) => (
    msg.key ||
    msg.message?.key ||
    msg.update?.key ||
    msg.data?.key ||
    {}
);

const toTimestampMs = (value) => {
    if (!value) return 0;
    if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const numeric = Number(value);
        return numeric > 1e12 ? numeric : numeric * 1000;
    }
    if (typeof value === 'object') {
        if (typeof value.toNumber === 'function') return toTimestampMs(value.toNumber());
        if (typeof value.low === 'number') return toTimestampMs(value.low);
    }
    return 0;
};

const inboundMessageAgeMs = (msg = {}) => {
    const ts = toTimestampMs(
        msg.messageTimestamp ||
        msg.timestamp ||
        msg.message?.messageTimestamp ||
        msg.message?.timestamp
    );
    return ts ? Math.max(0, Date.now() - ts) : 0;
};

const markOutboundDeliveryFailure = async (msg = {}, singletonKey = 'seller') => {
    const key = messageKeyFromUpdate(msg);
    const messageId = key.id || msg.id || msg.messageId || '';
    const remoteJid = key.remoteJid || msg.remoteJid || '';
    if (!messageId) return;

    const reason = `Evolution marked outbound WhatsApp message ${messageId} to ${remoteJid || 'unknown recipient'} as ERROR`;
    console.error(`[whatsapp] ${reason}`);

    await WhatsAppConfig.updateOne(
        { singletonKey },
        {
            $set: {
                status: 'connected',
                lastError: reason.slice(0, 500),
                lastSeen: new Date(),
            },
        },
        { upsert: true }
    ).catch(() => null);

    await WhatsAppPendingMessage.updateMany(
        {
            $or: [
                { summaryMessageId: messageId },
                { pollMessageId: messageId },
            ],
            status: { $in: ['sending', 'sent', 'queued'] },
        },
        {
            $set: {
                status: 'failed',
                lastError: reason.slice(0, 500),
                nextAttemptAt: new Date(Date.now() + 5 * 60 * 1000),
            },
        }
    ).catch((err) => {
        console.warn('[whatsapp] failed to mark pending message delivery error:', err.message);
    });
};

// ──────────────────────────────────────────────────────────────────────────
// Outgoing friendly replies
// ──────────────────────────────────────────────────────────────────────────
const sendResponseMessage = async (phone, isConfirmed, orderId, buyerName) => {
    try {
        const firstName = buyerName?.split(' ')[0] || 'there';

        const message = isConfirmed
            ? [
                `🎉 Awesome, ${firstName}!`,
                ``,
                `Your order *#${orderId}* is confirmed! ✅`,
                ``,
                `We're packing it up now — you'll get updates here as it moves to shipping.`,
                ``,
                `Need anything? Just reply to this chat. Thanks for shopping with Rozare! 💙`,
            ].join('\n')
            : [
                `Got it, ${firstName}! 👍`,
                ``,
                `Order *#${orderId}* has been cancelled. ❌`,
                ``,
                `No problem at all — nothing is charged, and your cart is still saved if you change your mind.`,
                ``,
                `Hope to see you again soon! 💙  — Rozare`,
            ].join('\n');

        await evolution.sendText(phone, message);
        console.log(`[whatsapp] Sent ${isConfirmed ? 'confirmation' : 'cancellation'} reply to ${phone}`);
    } catch (err) {
        console.error('[whatsapp] Failed to send response message:', err.message);
    }
};

const sendLockedMessage = async (phone, orderId, buyerName, prevDecision = '') => {
    try {
        const firstName = buyerName?.split(' ')[0] || 'there';
        // prevDecision is 'confirmed' | 'cancelled' | '' — describe the
        // locked-in state to the buyer so they know why tapping the other
        // button seems to do nothing.
        const prevLine = prevDecision === 'confirmed'
            ? `You already *confirmed* this order — we're processing it now. ✅`
            : prevDecision === 'cancelled'
                ? `You already *cancelled* this order. ❌`
                : `Your decision for order *#${orderId}* is now locked. 🔒`;

        const msg = [
            `Hey ${firstName}! 👋`,
            ``,
            prevLine,
            ``,
            `Need to change something? Please contact our support team — they'll sort it out for you. 💙`,
        ].join('\n');
        await evolution.sendText(phone, msg);
    } catch (err) {
        console.error('[whatsapp] Failed to send locked message:', err.message);
    }
};

const sendUnclearReplyHint = async (phone, orderId, buyerName) => {
    try {
        const firstName = buyerName?.split(' ')[0] || 'there';
        const msg = [
            `Hi ${firstName} 👋`,
            ``,
            `I didn't quite catch that for order *#${orderId}*.`,
            ``,
            `Please use the Confirm order or Cancel order buttons from the latest order message.`,
            `Typed replies are not accepted for order confirmation.`,
        ].join('\n');
        await evolution.sendText(phone, msg);
    } catch (err) {
        console.error('[whatsapp] Failed to send unclear-reply hint:', err.message);
    }
};

const sendReconfirmPrompt = async (phone, order, contextMessage) => {
    try {
        const payload = buildReconfirmButtonsPayload(order, contextMessage);
        await evolution.sendButtons(phone, payload);
    } catch (btnErr) {
        // No text decision fallback: order decisions must come from buttons.
        const firstName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
        const msg = [
            contextMessage || `Hey ${firstName}! This order was cancelled.`,
            ``,
            `I could not send the re-confirmation buttons right now.`,
            `Please place a new order or contact Rozare support if you need help.`,
        ].join('\n');
        await evolution.sendText(phone, msg);
    }
};

// ──────────────────────────────────────────────────────────────────────────
// Seller side-effects
// ──────────────────────────────────────────────────────────────────────────
const notifySellers = async (order, isConfirmed) => {
    try {
        const productIds = order.orderItems.map(i => i.productId);
        const products = await Product.find({ _id: { $in: productIds } });
        const sellerIds = [...new Set(products.map(p => p.seller?.toString()).filter(Boolean))];
        const buyerName = order.shippingInfo?.fullName || 'A buyer';

        for (const sellerId of sellerIds) {
            const seller = await User.findById(sellerId);

            // 1. Email (confirmation only — we don't spam sellers on cancel emails)
            if (isConfirmed && seller?.email) {
                const data = sellerOrderConfirmedByBuyerEmail(order, seller.username);
                sendEmail({ to: seller.email, ...data }).catch(e =>
                    console.error('[whatsapp] seller confirm email failed:', e.message)
                );
            }

            // 2. Expo push (both confirm + cancel)
            sendPushToUser(sellerId, {
                title: isConfirmed
                    ? 'Buyer confirmed via WhatsApp ✅'
                    : 'Buyer cancelled via WhatsApp ❌',
                body: isConfirmed
                    ? `${buyerName} confirmed order ${order.orderId} through Rozare WhatsApp.`
                    : `${buyerName} cancelled order ${order.orderId} through Rozare WhatsApp.`,
                channelId: 'seller',
                data: {
                    type: isConfirmed ? 'order_confirmed_by_buyer' : 'order_cancelled_by_buyer',
                    orderId: order.orderId,
                    orderObjectId: order._id?.toString(),
                    via: 'whatsapp',
                },
            }).catch(e => console.error('[whatsapp] seller push failed:', e.message));

            // 3. Persistent in-app Notification (the bell in the dashboard)
            Notification.create({
                user: sellerId,
                title: isConfirmed
                    ? 'Order confirmed via WhatsApp'
                    : 'Order cancelled via WhatsApp',
                body: isConfirmed
                    ? `${buyerName} confirmed order #${order.orderId} through Rozare WhatsApp automation.`
                    : `${buyerName} cancelled order #${order.orderId} through Rozare WhatsApp automation.`,
                category: 'order',
                linkTo: `/seller/orders/${order._id}`,
                source: 'system',
            }).catch(e => console.error('[whatsapp] seller in-app notification failed:', e.message));

            // 4. WhatsApp notification to seller (fire-and-forget)
            const waMsg = isConfirmed
                ? sellerTemplates.order_confirmed(order)
                : sellerTemplates.order_cancelled(order);
            notifySeller(sellerId, 'order_update', waMsg).catch(e =>
                console.error('[whatsapp] seller order update notification failed:', e.message)
            );
        }
    } catch (err) {
        console.error('[whatsapp] notifySellers failed:', err.message);
    }
};

// ──────────────────────────────────────────────────────────────────────────
// Message parsing helpers
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Decision extraction — looks at a Baileys message envelope and returns
// one of:
//   { source: 'button', decision: 'yes'|'no', rawId: '...' }
//   { source: 'text',   text: '...' }
//   null
//
// Sources we handle (in priority order):
//   1. Native-flow / interactive button click (v2.3.7 "viewOnceMessage →
//      interactiveResponseMessage → nativeFlowResponseMessage"):
//         msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson
//         → { id: "confirm_ORD-xxx", ... }
//   2. Classic buttonsResponseMessage (older WA clients):
//         msg.message.buttonsResponseMessage.selectedButtonId
//   3. Template button reply (template flow):
//         msg.message.templateButtonReplyMessage.selectedId
//   4. List reply (in case we ever switch):
//         msg.message.listResponseMessage.singleSelectReply.selectedRowId
//   5. Plain text:
//         msg.message.conversation  or  msg.message.extendedTextMessage.text
//      Text is returned only so it can be routed to AI chat; it never decides
//      an order confirmation.
// ──────────────────────────────────────────────────────────────────────────

const { parseButtonId } = require('./messageBuilder');

const extractDecision = (msg) => {
    if (!msg || typeof msg !== 'object') return null;
    // Skip our own outgoing messages
    if (msg?.key?.fromMe) return null;

    const m = msg.message || {};

    // ── 1. Native-flow interactive response (v2.3.7 shape) ───────────
    // Evolution wraps the payload; the actual id is in
    // interactiveResponseMessage.nativeFlowResponseMessage.paramsJson
    // (a JSON-stringified object with `.id`).
    const interactive =
        m.interactiveResponseMessage ||
        m.viewOnceMessage?.message?.interactiveResponseMessage ||
        m.ephemeralMessage?.message?.interactiveResponseMessage;
    if (interactive) {
        const nf = interactive.nativeFlowResponseMessage || interactive.body;
        const paramsJson = nf?.paramsJson;
        if (paramsJson) {
            try {
                const parsed = JSON.parse(paramsJson);
                // paramsJson shape varies by client — look at all likely fields
                const btnId = parsed?.id || parsed?.button_id || parsed?.buttonId;
                const decision = parseButtonId(btnId);
                if (decision) return { source: 'button', decision, rawId: btnId };
            } catch { /* malformed — fall through */ }
        }
        // Some builds include `name: 'quick_reply'` alongside a top-level id
        const directId = interactive?.id || interactive?.buttonId;
        const decision = parseButtonId(directId);
        if (decision) return { source: 'button', decision, rawId: directId };
    }

    // ── 2. Classic buttonsResponseMessage ─────────────────────────────
    const btnResp = m.buttonsResponseMessage;
    if (btnResp) {
        const id = btnResp.selectedButtonId;
        const decision = parseButtonId(id);
        if (decision) return { source: 'button', decision, rawId: id };
        // Fall back to the display text if the id doesn't match our prefixes
        const display = btnResp.selectedDisplayText;
        if (display) return { source: 'text', text: display };
    }

    // ── 3. Template button reply ──────────────────────────────────────
    const tpl = m.templateButtonReplyMessage;
    if (tpl) {
        const id = tpl.selectedId;
        const decision = parseButtonId(id);
        if (decision) return { source: 'button', decision, rawId: id };
        const display = tpl.selectedDisplayText;
        if (display) return { source: 'text', text: display };
    }

    // ── 4. List reply ──────────────────────────────────────────────────
    const list = m.listResponseMessage;
    if (list) {
        const id = list.singleSelectReply?.selectedRowId || list.rowId;
        const decision = parseButtonId(id);
        if (decision) return { source: 'button', decision, rawId: id };
        const title = list.title;
        if (title) return { source: 'text', text: title };
    }

    // ── 5. Plain text (conversation / extendedTextMessage) ────────────
    const text = m.conversation || m.extendedTextMessage?.text;
    if (typeof text === 'string' && text.trim()) {
        return { source: 'text', text: text.trim() };
    }

    return null;
};

// Legacy poll vote extraction — kept so old polls in flight still finalise.
const extractPollVote = (msg) => {
    const m = msg?.message || {};
    const upd = m.pollUpdateMessage || m.pollVoteMessage || msg?.pollUpdateMessage;
    if (!upd) return null;
    const indexes = upd?.vote?.selectedOptionIndexes || upd?.selectedOptionIndexes;
    const selected = upd?.vote?.selectedOptions || upd?.selectedOptions || upd?.options || [];

    let optionIndex = null;
    if (Array.isArray(indexes) && indexes.length > 0) optionIndex = Number(indexes[0]);
    else if (Array.isArray(selected) && selected.length > 0) optionIndex = 0;

    if (optionIndex === null) return null;
    return optionIndex === 0 ? 'yes' : 'no';
};

const findPendingJobByCandidatePhones = async (phones = []) => {
    for (const phone of uniqueNonEmpty(phones)) {
        const job = await findPendingJobByPhone(phone);
        if (job) return job;
    }
    return null;
};

const extractMessageText = (msg) => {
    const m = msg?.message || {};
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        ''
    );
};

const findWebhookBase64 = (msg, media) => (
    media?.base64 ||
    msg?.base64 ||
    msg?.message?.base64 ||
    msg?.message?.mediaMessage?.base64 ||
    msg?.message?.messageContextInfo?.base64 ||
    msg?.data?.base64 ||
    ''
);

const extractMediaAttachments = (msg, options = {}) => {
    const m = msg?.message || {};
    const candidates = [
        { kind: 'image', media: m.imageMessage },
        { kind: 'document', media: m.documentMessage },
        { kind: 'document', media: m.documentWithCaptionMessage?.message?.documentMessage },
        { kind: 'audio', media: m.audioMessage },
        { kind: 'video', media: m.videoMessage },
    ].filter(item => item.media);

    return candidates.map(({ kind, media }) => {
        const mimetype = media.mimetype || (kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/ogg' : 'application/octet-stream');
        const fallbackName = kind === 'image'
            ? 'whatsapp-image.jpg'
            : kind === 'audio'
                ? 'whatsapp-voice.ogg'
                : kind === 'video'
                    ? 'whatsapp-video.mp4'
                    : 'whatsapp-document';
        return {
            kind,
            mimetype,
            type: mimetype,
            filename: media.fileName || media.filename || fallbackName,
            name: media.fileName || media.filename || fallbackName,
            caption: media.caption || '',
            base64: findWebhookBase64(msg, media),
            url: media.url || media.mediaUrl || media.downloadUrl || '',
            mediaKey: media.mediaKey || '',
            messageId: msg?.key?.id || msg?.id || '',
            messageKey: msg?.key || (msg?.key?.id ? { id: msg.key.id } : null),
            source: 'whatsapp',
            evolutionInstance: options.instanceName || '',
            instanceType: options.instanceType || '',
        };
    });
};

// ──────────────────────────────────────────────────────────────────────────
// Main webhook entry
// ──────────────────────────────────────────────────────────────────────────
exports.handleEvolutionWebhook = async (req, res) => {
    try {
        // Optional shared-secret check
        const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
        if (expected) {
            const got = req.headers['x-rozare-webhook-secret'] || req.headers['apikey'];
            if (got !== expected && got !== process.env.EVOLUTION_API_KEY) {
                return res.status(401).json({ msg: 'Unauthorized webhook' });
            }
        }

        const body = req.body || {};
        const event = body.event || body.eventName || '';

        // ── Identify which Evolution instance this event belongs to ──
        // Both the buyer-order-verification (main) and seller-notification (seller)
        // instances POST to the same webhook URL. We MUST disambiguate, otherwise:
        //   - CONNECTION_UPDATE for seller instance would corrupt main's WhatsAppConfig
        //   - MESSAGES_UPSERT from seller's own WhatsApp (for normal admin/seller AI chat)
        //     would incorrectly auto-confirm unrelated buyer orders.
        const incomingInstance = body.instance || body.instanceName || body.data?.instance || '';
        const mainInstanceName = process.env.EVOLUTION_INSTANCE_NAME || 'rozare-main';
        const sellerInstanceName = process.env.EVOLUTION_SELLER_INSTANCE_NAME || 'rozare-seller';
        const singleInstanceMode = useUnifiedWhatsAppInstance();
        const isSellerInstance = incomingInstance && incomingInstance === sellerInstanceName;
        const isLegacyMainInstanceInSingleMode = singleInstanceMode && incomingInstance && incomingInstance === mainInstanceName;
        const isUnifiedGatewayEvent = singleInstanceMode && !isLegacyMainInstanceInSingleMode;
        const effectiveInstanceName = incomingInstance || (isUnifiedGatewayEvent ? sellerInstanceName : mainInstanceName);
        const singletonKey = configKeyFor(isSellerInstance ? 'seller' : 'main');

        if (isLegacyMainInstanceInSingleMode) {
            return res.status(200).json({ ok: true, ignored: 'legacy_main_instance_in_single_mode' });
        }

        // ── CONNECTION_UPDATE — keep WhatsAppConfig in sync for the CORRECT instance ──
        if (event === 'connection.update' || event === 'CONNECTION_UPDATE') {
            const state = body.data?.state || body.state;
            const cfg = await WhatsAppConfig.findOneAndUpdate(
                { singletonKey },
                {
                    $set: {
                        status: state === 'open' ? 'connected'
                            : state === 'connecting' ? 'connecting'
                            : 'disconnected',
                        lastSeen: new Date(),
                        ...(body.data?.wuid || body.data?.number
                            ? { linkedNumber: `+${(body.data.wuid || body.data.number).split('@')[0]}` }
                            : {}),
                        ...(state === 'open' ? { linkedAt: new Date(), lastError: '' } : {}),
                    },
                },
                { upsert: true, new: true }
            );
            return res.status(200).json({ ok: true, status: cfg.status, instance: singletonKey });
        }

        // Evolution accepts outbound sends as PENDING and later reports final
        // delivery state through MESSAGES_UPDATE. Capture ERROR updates so the
        // app does not silently report failed gateway sends as successful.
        if (event === 'messages.update' || event === 'MESSAGES_UPDATE') {
            const updates = asArray(body.data);
            for (const update of updates) {
                const status = latestMessageUpdateStatus(update);
                const key = messageKeyFromUpdate(update);
                if (status === 'ERROR' && key.fromMe !== false) {
                    await markOutboundDeliveryFailure(update, singletonKey);
                }
            }
            return res.status(200).json({ ok: true, instance: singletonKey });
        }

        // ── Seller instance: route inbound messages to AI chat ──
        // The seller instance now supports bidirectional AI chat for sellers and admins.
        // Messages are routed to the WhatsApp AI Chat Service (NOT order confirmation).
        if (isSellerInstance && !singleInstanceMode) {
            if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
                const messages = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean);
                for (const msg of messages) {
                    if (msg?.key?.fromMe) continue;
                    const address = resolveInboundAddress(msg);
                    const { remoteJid, identityPhone: phone, replyTo } = address;
                    // Skip group messages — only process 1:1 private chats
                    if (isGroupOrBroadcastJid(remoteJid)) continue;
                    if (!phone) continue;
                    await rememberInboundRoute(address, {
                        instanceType: 'seller',
                        instanceName: incomingInstance || sellerInstanceName,
                    });
                    const outboundTo = await resolveOutboundRecipient(phone, replyTo, { instanceType: 'seller' });
                    const ageMs = inboundMessageAgeMs(msg);
                    console.log(`[whatsapp] route seller phone=${phone} lid=${address.lidJid || ''} requested=${replyTo || ''} outbound=${outboundTo || ''} messageId=${msg?.key?.id || ''} ageMs=${ageMs || 'unknown'}`);
                    markInboundConversationWindowOpen(phone);

                    // Extract text from the message
                    const text = extractMessageText(msg);
                    const attachments = extractMediaAttachments(msg, {
                        instanceName: incomingInstance || sellerInstanceName,
                        instanceType: 'seller',
                    });
                    if ((!text || !text.trim()) && attachments.length === 0) continue;

                    // Route to AI chat (fire-and-forget — don't block webhook response)
                    processIncomingWhatsAppMessage(phone, String(text || '').trim(), 'seller', attachments, {
                        replyTo: outboundTo,
                        candidatePhones: address.candidatePhones,
                    }).catch(err => {
                        console.error('[whatsapp] seller AI chat error:', err.message);
                    });
                }
            }
            return res.status(200).json({ ok: true, instance: 'seller' });
        }

        // ── MESSAGES_UPSERT — button/list click (+ legacy poll) or AI chat ──
        // From here on, we ONLY process events from the main (buyer-verification) instance.
        if (event === 'messages.upsert' || event === 'MESSAGES_UPSERT') {
            const messages = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean);

            for (const msg of messages) {
                // Never process messages we sent
                if (msg?.key?.fromMe) continue;

                const address = resolveInboundAddress(msg);
                const { remoteJid, identityPhone: phone, replyTo } = address;
                if (isGroupOrBroadcastJid(remoteJid)) continue;
                if (!phone) continue;
                const routeScope = routingScopeFor(isUnifiedGatewayEvent ? 'seller' : 'main');
                const aiInstanceType = isUnifiedGatewayEvent ? 'unified' : 'main';
                const routeLabel = isUnifiedGatewayEvent ? 'unified' : 'main';

                await rememberInboundRoute(address, {
                    instanceType: routeScope,
                    instanceName: effectiveInstanceName,
                });
                const outboundTo = await resolveOutboundRecipient(phone, replyTo, { instanceType: routeScope });
                const ageMs = inboundMessageAgeMs(msg);
                console.log(`[whatsapp] route ${routeLabel} phone=${phone} lid=${address.lidJid || ''} requested=${replyTo || ''} outbound=${outboundTo || ''} messageId=${msg?.key?.id || ''} ageMs=${ageMs || 'unknown'}`);
                markInboundConversationWindowOpen(phone);
                const mediaText = extractMessageText(msg);
                const attachments = extractMediaAttachments(msg, {
                    instanceName: effectiveInstanceName,
                    instanceType: aiInstanceType,
                });

                // 1) Try the rich extractor — recognises button clicks and text
                //    replies in any of the 5 WhatsApp payload shapes.
                let decision = null;   // 'yes' | 'no' | null
                let decisionSource = ''; // 'button' | 'poll'
                let replyTextForHint = '';

                const extracted = extractDecision(msg);
                if (extracted) {
                    if (extracted.source === 'button') {
                        decision = extracted.decision;
                        decisionSource = 'button';
                        console.log(`[whatsapp] Button click from ${phone}: ${extracted.rawId} → ${decision}`);
                    } else if (extracted.source === 'text') {
                        replyTextForHint = extracted.text;
                    }
                }

                // 2) Legacy poll vote — kept so any old in-flight polls resolve
                if (!decision) {
                    const pollVote = extractPollVote(msg);
                    if (pollVote) { decision = pollVote; decisionSource = 'poll'; }
                }

                // Find the pending job for this buyer.
                // For button clicks, match by orderId extracted from the button id
                // for precise matching. Fall back to phone matching only for
                // legacy poll votes and non-decision chat routing.
                let job;
                if (decisionSource === 'button' && extracted?.rawId) {
                    // Extract orderId from button id like "confirm_ORD-1777617105232"
                    const idParts = extracted.rawId.split('_');
                    const btnOrderId = idParts.slice(1).join('_'); // everything after first underscore
                    if (btnOrderId) {
                        job = await findPendingJobByOrderId(btnOrderId);
                    }
                }
                if (!job) {
                    job = await findPendingJobByCandidatePhones(address.candidatePhones);
                }

                // ── No pending order confirmation → route to AI chat ──
                if (!job) {
                    const rawText = replyTextForHint || (extracted?.source === 'text' ? extracted.text : '') || mediaText;
                    if (rawText || attachments.length) {
                        processIncomingWhatsAppMessage(phone, rawText, aiInstanceType, attachments, {
                            replyTo: outboundTo,
                            candidatePhones: address.candidatePhones,
                        }).catch(err => {
                            console.error(`[whatsapp] ${routeLabel} AI chat error:`, err.message);
                        });
                    }
                    continue;
                }

                // If the buyer has a pending order but sent a normal text/media message,
                // route to AI chat instead of treating text as a confirmation decision. The AI is
                // smarter and can help with order questions or other requests.
                if (!decision && (replyTextForHint || attachments.length)) {
                    processIncomingWhatsAppMessage(phone, replyTextForHint || mediaText, aiInstanceType, attachments, {
                        replyTo: outboundTo,
                        candidatePhones: address.candidatePhones,
                    }).catch(err => {
                        console.error(`[whatsapp] ${routeLabel} AI chat error (with pending order):`, err.message);
                    });
                    continue;
                }
                if (!decision) continue; // silent message with no useful content

                const isYes = decision === 'yes';
                const order = await Order.findById(job.order);
                if (!order) continue;

                // ── Handle re-confirm / keep-cancel button responses ──
                // These are from the "Are you sure?" dialog sent after buyer tapped confirm on a cancelled order
                if (decision === 'reconfirm') {
                    console.log(`[whatsapp] Buyer confirmed re-order for ${order.orderId}`);
                    const firstName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
                    if (order.orderStatus !== 'cancelled') {
                        // Already re-confirmed (maybe from another tap) — show current status
                        const msg = [
                            `Hey ${firstName}! 👋`,
                            ``,
                            `Your order *#${order.orderId}* is already confirmed! ✅`,
                            ``,
                            `Status: *${order.orderStatus}* — we'll keep you updated. 💙`,
                        ].join('\n');
                        await evolution.sendText(outboundTo, msg);
                        continue;
                    }
                    const updated = await Order.findOneAndUpdate(
                        { _id: order._id, orderStatus: 'cancelled' },
                        {
                            $set: {
                                orderStatus: 'confirmed',
                                'confirmation.confirmedAt': new Date(),
                                'confirmation.confirmedVia': 'whatsapp',
                                'confirmation.decidedAt': new Date(),
                                'confirmation.decidedVia': 'whatsapp',
                                'confirmation.declinedAt': null,
                                'confirmation.cancelledFromDashboardAt': null,
                                'confirmation.cancelledFromDashboardNote': '',
                            }
                        },
                        { new: true }
                    );
                    if (updated) {
                        await applyVote(job, 'yes');
                        await sendResponseMessage(outboundTo, true, order.orderId, firstName);
                        notifySellers(updated, true);
                    } else {
                        const msg = `Hey ${firstName}! Something changed. Please visit rozare.com 💙`;
                        await evolution.sendText(outboundTo, msg);
                    }
                    continue;
                }

                if (decision === 'keepcancel') {
                    console.log(`[whatsapp] Buyer chose to keep/set order ${order.orderId} as cancelled`);
                    const firstName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';

                    // If order is currently confirmed (buyer re-confirmed then changed mind), cancel it
                    if (order.orderStatus !== 'cancelled') {
                        const updated = await Order.findOneAndUpdate(
                            { _id: order._id },
                            {
                                $set: {
                                    orderStatus: 'cancelled',
                                    'confirmation.declinedAt': new Date(),
                                    'confirmation.confirmedVia': 'whatsapp',
                                    'confirmation.decidedAt': new Date(),
                                    'confirmation.decidedVia': 'whatsapp',
                                    'confirmation.confirmedAt': null,
                                    'confirmation.cancelledFromDashboardAt': null,
                                    'confirmation.cancelledFromDashboardNote': '',
                                }
                            },
                            { new: true }
                        );
                        if (updated) {
                            await applyVote(job, 'no');
                            await sendResponseMessage(outboundTo, false, order.orderId, firstName);
                            notifySellers(updated, false);
                        } else {
                            const msg = `Hey ${firstName}! Something changed. Please visit rozare.com 💙`;
                            await evolution.sendText(outboundTo, msg);
                        }
                    } else {
                        // Order is already cancelled, just acknowledge
                        const msg = [
                            `Got it, ${firstName}! 👍`,
                            ``,
                            `Your order *#${order.orderId}* will stay cancelled. No worries! 💙`,
                            ``,
                            `If you change your mind, you can always place a new order at rozare.com`,
                        ].join('\n');
                        await evolution.sendText(outboundTo, msg);
                    }
                    continue;
                }

                // ── Guard: is the order already in a terminal state? ──
                //
                // Multiple paths can finalise an order:
                //   A. Buyer tapped confirm/cancel on WhatsApp earlier (first tap)
                //   B. Buyer cancelled from their website/app dashboard
                //   C. Admin changed the status
                //   D. Order moved to processing/shipped/delivered
                //
                // We detect ALL of these by checking both the confirmation
                // sub-document AND the top-level orderStatus. Then we respond
                // appropriately instead of silently ignoring or (worse)
                // flipping the order.

                const confirmedViaWA    = !!order.confirmation?.confirmedAt && (order.confirmation?.decidedVia === 'whatsapp' || order.confirmation?.confirmedVia === 'whatsapp');
                const declinedViaWA     = !!order.confirmation?.declinedAt && (order.confirmation?.decidedVia === 'whatsapp' || order.confirmation?.confirmedVia === 'whatsapp');
                const decidedViaWA      = confirmedViaWA || declinedViaWA;
                // Order was moved to a late stage by seller/admin — buyer can't override these
                const inLateStage       = ['processing', 'shipped', 'delivered'].includes(order.orderStatus);
                // Seller just confirmed it early but buyer hasn't decided yet — buyer CAN still override
                const sellerConfirmedEarly = order.orderStatus === 'confirmed' && !decidedViaWA && ['manual', 'admin'].includes(order.confirmation?.confirmedVia);
                // Seller cancelled early but buyer hasn't decided yet — buyer CAN still override
                const sellerCancelledEarly = order.orderStatus === 'cancelled' && !decidedViaWA && ['manual', 'admin'].includes(order.confirmation?.confirmedVia);
                const confirmedOnSite   = inLateStage && !decidedViaWA;
                // Check if buyer already decided via email
                const decidedViaEmail   = order.confirmation?.confirmedVia === 'email' || order.confirmation?.decidedVia === 'email';
                const confirmedViaEmail  = decidedViaEmail && !!order.confirmation?.confirmedAt;
                const declinedViaEmail   = decidedViaEmail && !!order.confirmation?.declinedAt;
                // NOT terminal if seller just set it early — buyer's decision takes precedence
                const cancelledOnSite   = order.orderStatus === 'cancelled' && !decidedViaWA && !sellerCancelledEarly && !decidedViaEmail;
                const alreadyTerminal   = decidedViaWA || cancelledOnSite || confirmedOnSite || decidedViaEmail;

                if (alreadyTerminal) {
                    const firstName = order.shippingInfo?.fullName?.split(' ')[0] || 'there';
                    const maskedEmail = order.shippingInfo?.email
                        ? order.shippingInfo.email.replace(/^(.{2})(.*)(@.*)$/, '$1••••$3')
                        : 'your email';

                    // ── Confirmed via email AND still confirmed (not subsequently cancelled) ──
                    if (confirmedViaEmail && order.orderStatus !== 'cancelled') {
                        if (isYes) {
                            // Tap confirm — already confirmed
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You have already confirmed this order via your email (${maskedEmail}). ✅`,
                                ``,
                                `No action needed — we'll keep you updated. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        } else {
                            // Tap cancel — already confirmed via email, tell them to visit account
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You have already confirmed this order via your email (${maskedEmail}). ✅`,
                                ``,
                                `Want to cancel? Visit your Rozare account to cancel this order. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        }
                        continue;
                    }

                    // ── Cancelled via email → buyer taps on WhatsApp ──
                    if (declinedViaEmail) {
                        if (!isYes) {
                            // Tap cancel — already cancelled
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You have already cancelled this order via your email (${maskedEmail}). ❌`,
                                ``,
                                `No action needed. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        } else {
                            // Tap confirm — wants to re-order! Send "Are you sure?" prompt
                            console.log(`[whatsapp] Order ${order.orderId} was cancelled via email; buyer tapped confirm on WA — sending reconfirm prompt`);
                            const contextMsg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You cancelled this order via your email (${maskedEmail}).`,
                            ].join('\n');
                            await sendReconfirmPrompt(outboundTo, order, contextMsg);
                        }
                        continue;
                    }

                    // ── Cancelled from account (user dashboard cancel) → buyer taps on WhatsApp ──
                    if (cancelledOnSite) {
                        if (!isYes) {
                            // Tap cancel — already cancelled from account
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You have already cancelled this order from your Rozare account. ❌`,
                                ``,
                                `No action needed. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        } else {
                            // Tap confirm — wants to re-order from account cancel! Send prompt
                            console.log(`[whatsapp] Order ${order.orderId} was cancelled from account; buyer tapped confirm on WA — sending reconfirm prompt`);
                            const contextMsg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You cancelled this order from your Rozare account.`,
                            ].join('\n');
                            await sendReconfirmPrompt(outboundTo, order, contextMsg);
                        }
                        continue;
                    }

                    // ── Confirmed (via any channel) but then cancelled from email page or account ──
                    if (order.confirmation?.cancelledFromDashboardAt && order.orderStatus === 'cancelled') {
                        const note = order.confirmation?.cancelledFromDashboardNote || '';
                        const cancelledFrom = note.includes('account') || note.includes('dashboard')
                            ? 'your Rozare account'
                            : `your email (${maskedEmail})`;
                        if (!isYes) {
                            // Tap cancel — already cancelled
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `Your order *#${order.orderId}* is already cancelled. ❌`,
                                ``,
                                `You cancelled it from ${cancelledFrom}.`,
                                ``,
                                `No action needed. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        } else {
                            // Tap confirm — wants to re-order! Send prompt
                            console.log(`[whatsapp] Order ${order.orderId} cancelled after WA confirm; buyer tapped confirm — sending reconfirm prompt`);
                            const contextMsg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `You cancelled this order from ${cancelledFrom} after confirming on WhatsApp.`,
                            ].join('\n');
                            await sendReconfirmPrompt(outboundTo, order, contextMsg);
                        }
                        continue;
                    }

                    // ── Order in late stage (processing/shipped/delivered) ──
                    if (confirmedOnSite) {
                        if (isYes) {
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `Your order *#${order.orderId}* is already being processed (status: *${order.orderStatus}*). ✅`,
                                ``,
                                `No action needed — we'll keep you updated. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        } else {
                            const msg = [
                                `Hey ${firstName}! 👋`,
                                ``,
                                `Your order *#${order.orderId}* is already being processed (status: *${order.orderStatus}*).`,
                                ``,
                                `Want to cancel? Visit your Rozare account. 💙`,
                            ].join('\n');
                            await evolution.sendText(outboundTo, msg);
                        }
                        continue;
                    }

                    // ── Already decided via WhatsApp ──
                    if ((confirmedViaWA && isYes) || (declinedViaWA && !isYes)) {
                        // Same decision again → silently ignore
                        console.log(`[whatsapp] Duplicate ${isYes ? 'yes' : 'no'} for order ${order.orderId} — ignored`);
                        continue;
                    }

                    // Confirmed via WA, now taps cancel → tell them to visit account with live status
                    if (confirmedViaWA && !isYes) {
                        const msg = [
                            `Hey ${firstName}! 👋`,
                            ``,
                            `You have already confirmed this order via WhatsApp. ✅`,
                            ``,
                            `Current status: *${order.orderStatus}*`,
                            ``,
                            `Want to cancel? Visit your Rozare account. 💙`,
                        ].join('\n');
                        await evolution.sendText(outboundTo, msg);
                        continue;
                    }

                    // Cancelled via WA, now taps confirm → send "Are you sure?" prompt
                    if (declinedViaWA && isYes) {
                        console.log(`[whatsapp] Order ${order.orderId} was cancelled via WA; buyer tapped confirm — sending reconfirm prompt`);
                        const contextMsg = [
                            `Hey ${firstName}! 👋`,
                            ``,
                            `You previously cancelled this order on WhatsApp.`,
                        ].join('\n');
                        await sendReconfirmPrompt(outboundTo, order, contextMsg);
                        continue;
                    }

                    // Fallback — shouldn't reach here but just in case
                    console.log(`[whatsapp] Unhandled terminal state for order ${order.orderId}, status=${order.orderStatus}`);
                    continue;
                }

                // ── First decision — apply it ──
                // Log if this buyer decision overrides a seller's early status change
                if (sellerConfirmedEarly || sellerCancelledEarly) {
                    console.log(`[whatsapp] Buyer ${isYes ? 'confirmed' : 'cancelled'} order ${order.orderId} — overriding seller's early ${order.orderStatus} status`);
                }

                // Use atomic update to prevent race with email confirmation
                const updateFields = isYes
                    ? {
                        'confirmation.confirmedAt': new Date(),
                        'confirmation.confirmedVia': 'whatsapp',
                        'confirmation.decidedAt': new Date(),
                        'confirmation.decidedVia': 'whatsapp',
                        orderStatus: 'confirmed',
                    }
                    : {
                        'confirmation.declinedAt': new Date(),
                        'confirmation.confirmedVia': 'whatsapp',
                        'confirmation.decidedAt': new Date(),
                        'confirmation.decidedVia': 'whatsapp',
                        orderStatus: 'cancelled',
                    };

                const updatedOrder = await Order.findOneAndUpdate(
                    {
                        _id: order._id,
                        // Guard: only apply if no one else decided yet via a real channel
                        $or: [
                            { 'confirmation.decidedVia': null },
                            { 'confirmation.decidedVia': { $exists: false } },
                            // Allow override if seller set it early (manual/admin)
                            { 'confirmation.decidedVia': { $in: ['manual', 'admin'] } },
                        ]
                    },
                    { $set: updateFields },
                    { new: true }
                );

                if (!updatedOrder) {
                    // Race lost — someone decided via email or another WA tap between our read and write
                    console.log(`[whatsapp] Race condition: order ${order.orderId} was decided by another path between read and atomic write`);
                    continue;
                }

                // NOW persist the vote on the job (dashboard reads this)
                await applyVote(job, isYes ? 'yes' : 'no');
                await sendResponseMessage(outboundTo, isYes, updatedOrder.orderId, updatedOrder.shippingInfo?.fullName);
                notifySellers(updatedOrder, isYes);
            }
            return res.status(200).json({ ok: true });
        }

        // Unknown event — ack so Evolution doesn't retry
        return res.status(200).json({ ok: true, ignored: event });
    } catch (err) {
        console.error('[whatsapp] webhook handler error:', err.message);
        return res.status(200).json({ ok: false, error: err.message });
    }
};
