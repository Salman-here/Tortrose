/**
 * WhatsApp AI Chat Service
 * ─────────────────────────
 * Processes incoming WhatsApp messages through the Rozare AI pipeline.
 * Handles user/seller/admin identification, conversation history,
 * rate limiting, and response delivery.
 *
 * Called by webhookHandler when a message is NOT an order confirmation.
 */

'use strict';

const User = require('../../models/User');
const AdminWhatsAppNumber = require('../../models/AdminWhatsAppNumber');
const WhatsAppAIChatRateLimit = require('../../models/WhatsAppAIChatRateLimit');
const ChatHistory = require('../../models/ChatHistory');
const { processAIChatMessage } = require('../../controllers/aiChatController');
const { processChatAttachments } = require('../aiAttachmentService');
const evolution = require('./evolutionClient');           // buyer instance (rozare-main)
const sellerEvolution = require('./sellerEvolutionClient'); // seller instance (rozare-seller)
const { resolveReplyTo } = require('./addressing');

const SITE_URL = process.env.FRONTEND_URL || 'https://www.rozare.com';
const RATE_LIMIT_PER_HOUR = Number(process.env.WHATSAPP_AI_RATE_LIMIT_PER_HOUR || 30);
const AI_CHAT_ENABLED = process.env.WHATSAPP_AI_CHAT_ENABLED !== 'false'; // default true

// ─── Per-user sequential processing queue ─────────────────────────────
// Prevents race conditions when a user sends multiple messages rapidly.
// Each user gets their own promise chain so messages are processed one at a time.
const userQueues = new Map(); // userId → Promise
const QUEUE_CLEANUP_INTERVAL = 10 * 60 * 1000; // Clean up resolved queues every 10 min

// Clean up old queue entries periodically to avoid memory leaks
setInterval(() => {
    for (const [key, promise] of userQueues.entries()) {
        // If the promise is resolved (settled), remove it
        Promise.race([promise, Promise.resolve('done')]).then(v => {
            if (v === 'done') userQueues.delete(key); // queue was already resolved
        }).catch(() => userQueues.delete(key));
    }
}, QUEUE_CLEANUP_INTERVAL);

// ─── Rejection message cooldown ───────────────────────────────────────
// Prevents spamming unlinked/non-seller users with rejection messages on every message.
// Max 1 rejection message per phone per 10 minutes.
const rejectionCooldowns = new Map(); // phone → timestamp
const REJECTION_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function canSendRejection(phone) {
    const lastSent = rejectionCooldowns.get(phone);
    if (lastSent && Date.now() - lastSent < REJECTION_COOLDOWN_MS) return false;
    rejectionCooldowns.set(phone, Date.now());
    return true;
}

// Clean up old cooldown entries periodically
setInterval(() => {
    const cutoff = Date.now() - REJECTION_COOLDOWN_MS;
    for (const [phone, ts] of rejectionCooldowns.entries()) {
        if (ts < cutoff) rejectionCooldowns.delete(phone);
    }
}, REJECTION_COOLDOWN_MS);

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalize phone number to digits only (strip + and spaces).
 */
function normalizePhoneDigits(phone) {
    return String(phone || '').replace(/\D/g, '');
}

/**
 * Get the correct Evolution client for an instance type.
 */
function getClient(instanceType) {
    return instanceType === 'seller' ? sellerEvolution : evolution;
}

/**
 * Send a text message via the correct WhatsApp instance, splitting long messages.
 * WhatsApp has a ~4096 char limit per message.
 */
async function sendResponse(recipient, text, instanceType) {
    const client = getClient(instanceType);
    if (!client.isConfigured()) {
        console.warn(`[wa-ai-chat] ${instanceType} instance not configured, cannot send response`);
        return;
    }

    const MAX_LEN = 4000; // leave room for overhead
    if (text.length <= MAX_LEN) {
        await client.sendText(recipient, text);
        return;
    }

    // Split at paragraph boundaries
    const parts = [];
    let remaining = text;
    while (remaining.length > MAX_LEN) {
        let splitAt = remaining.lastIndexOf('\n\n', MAX_LEN);
        if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('\n', MAX_LEN);
        if (splitAt < MAX_LEN / 2) splitAt = remaining.lastIndexOf('. ', MAX_LEN);
        if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN;
        parts.push(remaining.slice(0, splitAt + 1).trim());
        remaining = remaining.slice(splitAt + 1).trim();
    }
    if (remaining) parts.push(remaining);

    for (const part of parts) {
        await client.sendText(recipient, part);
        // Small delay between messages to avoid spam detection
        await new Promise(r => setTimeout(r, 500));
    }
}

// ─── User Identification ──────────────────────────────────────────────

/**
 * Identify the user by phone number and determine their role.
 *
 * For 'main' (buyer) instance:
 *   - Look up User where whatsappInfo.number matches and verified === true
 *   - Role is the user's actual role (typically 'user')
 *
 * For 'seller' instance:
 *   - First check AdminWhatsAppNumber (active) → admin role
 *   - Then look up User where sellerInfo.whatsappNumber matches and whatsappVerified === true
 *   - Must be role=seller → seller role
 *   - Otherwise → null (rejected)
 */
function summarizeToolEventsForMemory(toolEvents = []) {
    const lines = [];
    for (const event of toolEvents || []) {
        if (event?.type !== 'tool_result') continue;
        const tool = event.tool;
        const result = event.result || {};
        const data = result.data || {};

        if (tool === 'add_product' && result.success && result.blocked && data.productId) {
            lines.push(`[Tool memory: add_product saved but blocked. productId=${data.productId}; name="${data.name || ''}"; reason="${data.moderationReason || result.message || ''}". Tell the seller it is blocked and ask them to edit the real product details; do not add it again.]`);
        } else if (tool === 'add_product' && result.success && data.productId) {
            lines.push(`[Tool memory: add_product succeeded. productId=${data.productId}; name="${data.name || ''}"; brand="${data.brand || ''}"; price=${data.price ?? ''}; tags=${JSON.stringify(data.tags || [])}; colors=${JSON.stringify(data.colors || [])}. Use this productId for follow-up edits; do not add it again unless the seller explicitly asks for a duplicate.]`);
        } else if (tool === 'bulk_add_products' && result.success && Array.isArray(data.products)) {
            const products = data.products.slice(0, 12).map(p => `${p.productId || p._id}:${p.name}; brand=${p.brand || ''}; price=${p.price ?? ''}; stock=${p.stock ?? ''}`);
            lines.push(`[Tool memory: bulk_add_products imported ${data.added ?? data.products.length} products. Internal product lookup: ${products.join(' | ')}. Use these ids internally only; do not show or ask the seller for product IDs.]`);
        } else if (tool === 'edit_product' && result.success && (data._id || data.productId)) {
            lines.push(`[Tool memory: edit_product succeeded. productId=${data._id || data.productId}; name="${data.name || ''}". Continue editing this product if the seller gives more details.]`);
        } else if (tool === 'feature_product' && result.success && (data.productId || data._id)) {
            lines.push(`[Tool memory: feature_product succeeded. productId=${data.productId || data._id}; name="${data.name || ''}"; isFeatured=${data.isFeatured === true}.]`);
        } else if (tool === 'delete_product' && result.success && Array.isArray(data.deleted)) {
            lines.push(`[Tool memory: delete_product succeeded. Deleted products: ${data.deleted.map(p => `${p.productId || p._id}:${p.name}`).join(', ')}.]`);
        } else if (tool === 'list_my_products' && result.success && Array.isArray(data.products)) {
            const products = data.products.slice(0, 10).map(p => `${p._id || p.productId}:${p.name}; brand=${p.brand || ''}; price=${p.price ?? ''}; stock=${p.stock ?? ''}; featured=${p.isFeatured === true}; blocked=${p.blocked === true || p.isBlocked === true || p.moderationStatus === 'blocked'}; createdAt=${p.createdAt || ''}`);
            lines.push(`[Tool memory: list_my_products returned ${data.total ?? data.products.length} products. Internal product lookup: ${products.join(' | ')}. Use these ids internally only; do not show or ask the seller for product IDs.]`);
        } else if (tool === 'search_products' && result.success && Array.isArray(data.products)) {
            const products = data.products.slice(0, 12).map(p => `${p._id || p.productId}:${p.name}; store=${p.storeName || ''}; slug=${p.storeSlug || ''}; price=${p.discountedPrice || p.price || ''}; stock=${p.stock ?? ''}; colors=${JSON.stringify(p.colors || [])}; options=${JSON.stringify(p.optionGroups || [])}`);
            lines.push(`[Tool memory: search_products returned ${data.count ?? data.products.length} products. Internal product lookup for shopper follow-ups: ${products.join(' | ')}. Use these ids internally only; do not show raw product IDs.]`);
        } else if (tool === 'get_product_detail' && result.success && data._id) {
            lines.push(`[Tool memory: get_product_detail productId=${data._id}; name="${data.name || ''}"; store="${data.storeName || ''}"; stock=${data.stock ?? ''}; colors=${JSON.stringify(data.colors || [])}; options=${JSON.stringify(data.optionGroups || [])}.]`);
        } else if (tool === 'search_stores' && result.success && Array.isArray(data.stores)) {
            const stores = data.stores.slice(0, 8).map(s => `${s._id}:${s.storeName}; slug=${s.storeSlug || s.slug || ''}; matches=${(s.matchingProducts || []).map(p => p.name).join(', ')}`);
            lines.push(`[Tool memory: search_stores returned stores: ${stores.join(' | ')}. Use storeSlug/storeId internally when searching products from a chosen store.]`);
        } else if (tool === 'add_product' && result.duplicate) {
            const existing = data.existingProduct || {};
            lines.push(`[Tool memory: add_product duplicate blocked. Existing productId=${existing.productId || ''}; name="${existing.name || ''}". Ask for explicit duplicate confirmation before creating another listing.]`);
        } else if (result.success === false) {
            lines.push(`[Tool memory: ${tool} failed: ${result.error || result.message || 'unknown error'}. Do not claim it succeeded.]`);
        }

        if (lines.length >= 6) break;
    }
    return lines.join('\n');
}

function sanitizeVisibleAIResponse(text = '') {
    return String(text || '')
        .split(/\r?\n/)
        .filter((line) => {
            const trimmed = line.trim().replace(/^_+|_+$/g, '');
            return !trimmed.includes('[Tool memory:') && !/^Action note:/i.test(trimmed);
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function identifyUserByPhone(phone, instanceType) {
    const digits = normalizePhoneDigits(phone);
    if (!digits || digits.length < 8) return null;

    const phoneVariants = [digits, `+${digits}`];

    if (instanceType === 'seller') {
        // 1. Check admin numbers first
        const adminNumber = await AdminWhatsAppNumber.findOne({
            number: digits,
            isActive: true,
        }).populate('addedBy', '_id role username');
        if (adminNumber) {
            // Prefer the admin who added this number; fall back to any admin
            let adminUser = adminNumber.addedBy?.role === 'admin' ? adminNumber.addedBy : null;
            if (!adminUser) {
                adminUser = await User.findOne({ role: 'admin' }).select('_id role username');
            }
            if (adminUser) {
                return { user: adminUser, role: 'admin' };
            }
        }

        // 2. Check sellers
        const seller = await User.findOne({
            role: 'seller',
            'sellerInfo.whatsappNumber': { $in: phoneVariants },
            'sellerInfo.whatsappVerified': true,
        }).select('_id role username sellerInfo.whatsappNumber');

        if (seller) {
            return { user: seller, role: 'seller' };
        }

        // 3. Not found — not a seller or admin
        return null;
    }

    // Main (buyer) instance
    // Everyone on the buyer instance is treated as a USER (buyer), regardless of
    // their actual role. This means sellers who linked their number on their user
    // dashboard get buyer tools, not seller tools — as intended. The seller instance
    // is where they get seller/admin AI capabilities.
    const user = await User.findOne({
        'whatsappInfo.number': { $in: phoneVariants },
        'whatsappInfo.verified': true,
    }).select('_id role username whatsappInfo.number');

    if (user) {
        // Force role to 'user' on buyer instance — sellers are treated as ordinary buyers here
        return { user, role: 'user' };
    }

    return null;
}

// ─── Rate Limiting ────────────────────────────────────────────────────

async function checkRateLimit(userId, phone, instanceType) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const now = new Date();

    // Atomic upsert: reset window if expired, increment count, return updated doc
    // This prevents race conditions where two concurrent messages both pass the limit check
    const record = await WhatsAppAIChatRateLimit.findOneAndUpdate(
        {
            user: userId,
            instance: instanceType,
            windowStart: { $gte: oneHourAgo }, // only match if window is still active
        },
        {
            $inc: { messageCount: 1 },
            $set: { phone },
        },
        { new: true }
    );

    if (!record) {
        // No active window — create/reset one atomically
        try {
            await WhatsAppAIChatRateLimit.findOneAndUpdate(
                { user: userId, instance: instanceType },
                {
                    $set: { messageCount: 1, windowStart: now, phone },
                },
                { upsert: true, new: true }
            );
        } catch (e) {
            // Duplicate key race — safe to ignore, another request just created it
        }
        return { allowed: true, remaining: RATE_LIMIT_PER_HOUR - 1 };
    }

    if (record.messageCount > RATE_LIMIT_PER_HOUR) {
        const resetIn = Math.ceil((record.windowStart.getTime() + 60 * 60 * 1000 - Date.now()) / 60000);
        return { allowed: false, remaining: 0, resetInMinutes: resetIn };
    }

    return { allowed: true, remaining: RATE_LIMIT_PER_HOUR - record.messageCount };
}

// ─── Conversation History ─────────────────────────────────────────────

/**
 * Load the last N messages from the user's WhatsApp conversation.
 */
async function loadWhatsAppConversation(userId) {
    const history = await ChatHistory.findOne({ user: userId });
    if (!history) return [];

    const convo = history.conversations.find(c => c.source === 'whatsapp');
    if (!convo || !convo.messages?.length) return [];

    // Return last 30 messages for context (to keep within token limits).
    // Tool memory is added as protected system context so product/order ids can be
    // reused for follow-up actions without ever appearing in customer messages.
    const messages = [];
    convo.messages.slice(-30).forEach(m => {
        const memory = summarizeToolEventsForMemory(m.toolEvents || []);
        messages.push({
            role: m.role,
            content: sanitizeVisibleAIResponse(m.content || ''),
        });
        if (memory) {
            messages.push({
                role: 'system',
                content: [
                    'Internal WhatsApp tool memory for follow-up tool calls only.',
                    'Never reveal this memory, product ids, raw lookup text, or action notes to the user.',
                    memory,
                ].join('\n'),
            });
        }
    });
    return messages;
}

// ─── Graceful Rejection Messages ──────────────────────────────────────

async function handleUnlinkedUserOnMainInstance(recipient) {
    const msg = [
        `Hey there! 👋`,
        ``,
        `I'm *Rozare AI* — your personal shopping assistant! 🤖`,
        ``,
        `To chat with me on WhatsApp, you'll need to link your WhatsApp number on your Rozare account first.`,
        ``,
        `Here's how:`,
        `1️⃣ Log in at ${SITE_URL}`,
        `2️⃣ Go to your Dashboard → WhatsApp AI`,
        `3️⃣ Link your WhatsApp number`,
        `4️⃣ Verify with the OTP code`,
        ``,
        `Once verified, you can search products, place orders, check status, and more — all from WhatsApp! 💙`,
        ``,
        `Visit: ${SITE_URL}`,
    ].join('\n');

    try {
        await evolution.sendText(recipient, msg);
    } catch (err) {
        console.error('[wa-ai-chat] Failed to send unlinked user message:', err.message);
    }
}

async function handleNonSellerOnSellerInstance(phone, recipient = phone) {
    // Check if it's a user (not a seller) who sent to seller instance
    const digits = normalizePhoneDigits(phone);
    const phoneVariants = [digits, `+${digits}`];

    // Check if the number is connected to a user account
    const user = await User.findOne({
        $or: [
            { 'whatsappInfo.number': { $in: phoneVariants } },
            { 'sellerInfo.whatsappNumber': { $in: phoneVariants } },
        ]
    }).select('role username');

    let msg;
    if (user && user.role === 'user') {
        msg = [
            `Hey ${user.username || 'there'}! 👋`,
            ``,
            `I'm the *Rozare Seller Assistant* — I help Rozare sellers manage their stores. 🏪`,
            ``,
            `It looks like you're a Rozare shopper, not a seller. This WhatsApp number is for sellers only.`,
            ``,
            `To chat with Rozare AI as a shopper, please use the buyer WhatsApp line or visit:`,
            `${SITE_URL}/ai-chat`,
            ``,
            `Want to become a seller? Visit: ${SITE_URL}/become-seller 🚀`,
        ].join('\n');
    } else {
        msg = [
            `Hey there! 👋`,
            ``,
            `I'm the *Rozare Seller Assistant* — I help Rozare sellers manage their stores. 🏪`,
            ``,
            `This number is not registered as a Rozare seller account.`,
            ``,
            `If you're a Rozare seller, make sure your WhatsApp number is verified in your seller dashboard.`,
            ``,
            `If you're looking to shop, visit: ${SITE_URL}`,
            `Want to become a seller? Visit: ${SITE_URL}/become-seller 🚀`,
        ].join('\n');
    }

    try {
        await sellerEvolution.sendText(recipient, msg);
    } catch (err) {
        console.error('[wa-ai-chat] Failed to send non-seller message:', err.message);
    }
}

// ─── Main Entry Point ─────────────────────────────────────────────────

/**
 * Process an incoming WhatsApp text message through the AI pipeline.
 * Called by webhookHandler for non-order-confirmation messages.
 *
 * @param {string} phone - Sender's real phone number for identity lookup/rate limiting
 * @param {string} messageText - The text content of the message
 * @param {string} instanceType - 'main' | 'seller'
 * @param {Array} rawAttachments - Media attachments extracted from Evolution
 * @param {object} options - Optional routing hints
 * @param {string} options.replyTo - Exact WhatsApp chat JID/number to reply to
 */
async function processIncomingWhatsAppMessage(phone, messageText, instanceType, rawAttachments = [], options = {}) {
    if (!AI_CHAT_ENABLED) {
        console.log(`[wa-ai-chat] AI chat disabled, ignoring message from ${phone}`);
        return;
    }

    const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
    if ((!messageText || !messageText.trim()) && attachments.length === 0) return;

    const replyTo = resolveReplyTo(phone, options.replyTo || phone);
    const trimmedText = String(messageText || '').trim();
    console.log(`[wa-ai-chat] Processing ${instanceType} message from ${phone} (replyTo=${replyTo}): "${trimmedText.slice(0, 100)}..." attachments=${attachments.length}`);

    try {
        // 1. Identify the user
        const identified = await identifyUserByPhone(phone, instanceType);
        if (!identified) {
            // Graceful rejection — with cooldown to prevent spamming
            if (canSendRejection(phone)) {
                if (instanceType === 'main') {
                    await handleUnlinkedUserOnMainInstance(replyTo);
                } else {
                    await handleNonSellerOnSellerInstance(phone, replyTo);
                }
            } else {
                console.log(`[wa-ai-chat] Skipping rejection message for ${phone} (cooldown)`);
            }
            return;
        }

        const { user, role } = identified;
        console.log(`[wa-ai-chat] Identified: ${user.username} (${role}) from ${instanceType} instance`);

        // 2. Rate limiting
        const rateCheck = await checkRateLimit(user._id, phone, instanceType);
        if (!rateCheck.allowed) {
            const msg = [
                `Hey ${user.username || 'there'}! 😅`,
                ``,
                `You've sent a lot of messages this hour. To keep things running smoothly, please try again in about ${rateCheck.resetInMinutes} minutes.`,
                ``,
                `In the meantime, you can use the web chat at:`,
                `${SITE_URL}/ai-chat`,
            ].join('\n');
            await sendResponse(replyTo, msg, instanceType);
            return;
        }

        // 3. Process media/files after the user is identified and rate-limited.
        const attachmentResult = attachments.length
            ? await processChatAttachments(attachments)
            : { context: '', attachments: [] };
        const userContent = [trimmedText, attachmentResult.context].filter(Boolean).join('\n\n') ||
            (attachments.length ? 'Attachment uploaded' : trimmedText);

        // 4. Load conversation history
        const conversationHistory = await loadWhatsAppConversation(user._id);

        // 5. Build messages array (history + new message)
        const messages = [
            ...conversationHistory,
            {
                role: 'user',
                content: userContent,
                attachments: attachmentResult.attachments || [],
            },
        ];

        // 6. Process through AI pipeline
        const userObj = { _id: user._id, id: user._id.toString(), role };

        const aiOptions = { mode: 'whatsapp' };
        const result = await processAIChatMessage(userObj, messages, aiOptions);

        // 7. Send AI response
        if (result.responseText) {
            const responseText = sanitizeVisibleAIResponse(result.responseText);
            await sendResponse(replyTo, responseText, instanceType);
        } else {
            // AI returned empty response — send a fallback
            await sendResponse(replyTo, "I'm sorry, I couldn't process that. Could you try rephrasing? 🤔", instanceType);
        }

        // 8. Send pending product images (if AI used send_product_image tool)
        if (aiOptions._pendingImages?.length) {
            const client = getClient(instanceType);
            for (const img of aiOptions._pendingImages) {
                try {
                    await client.sendMedia(replyTo, img.imageUrl, img.caption, 'image');
                    await new Promise(r => setTimeout(r, 800)); // delay between images
                } catch (imgErr) {
                    console.error(`[wa-ai-chat] Failed to send product image to ${phone}:`, imgErr.message);
                    // Fallback: send image URL as text
                    await client.sendText(replyTo, `📸 Image: ${img.imageUrl}\n${img.caption}`).catch(() => {});
                }
            }
        }

        console.log(`[wa-ai-chat] Response sent to ${phone} (${role}) via ${instanceType}`);

    } catch (err) {
        console.error(`[wa-ai-chat] Error processing message from ${phone}:`, err.message);

        // Send error message to user
        try {
            const errorMsg = err.message?.includes('rate limit')
                ? "I'm a bit busy right now. Please try again in a moment! 🙏"
                : err.message?.includes('credits')
                    ? "I'm temporarily unavailable. Please try again later or use the web chat at " + SITE_URL + "/ai-chat"
                    : "Oops! Something went wrong on my end. Please try again or visit " + SITE_URL + "/ai-chat 💙";
            await sendResponse(replyTo, errorMsg, instanceType);
        } catch (sendErr) {
            console.error('[wa-ai-chat] Failed to send error message:', sendErr.message);
        }
    }
}

module.exports = {
    processIncomingWhatsAppMessage,
    identifyUserByPhone,
    normalizePhoneDigits,
};
