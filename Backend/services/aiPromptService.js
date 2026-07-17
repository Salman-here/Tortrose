'use strict';

// Central AI prompt service.
//
// Every AI prompt the platform uses is resolved through this module:
//   final prompt = admin override from MongoDB (if any) → else code default.
//
// Admins manage prompts from the dashboard (AI Prompts tab). Changes take
// effect within CACHE_TTL_MS on the running server — no deploy needed. Admins
// can also add "knowledge" prompts (new features, policies, FAQ answers) that
// are appended to the chat system prompt for the roles/channels they select.
//
// Design notes:
//   - The DB stores only overrides + custom prompts. Defaults ship with the
//     code (services/aiPrompts/defaultPrompts.js), so a fresh environment
//     works with an empty collection and "Reset to default" simply deletes
//     the override document.
//   - All prompts are read through a single cached loadAll() so chat requests
//     never add more than one (cached) DB query.

const mongoose = require('mongoose');
const AIPrompt = require('../models/AIPrompt');
const defaults = require('./aiPrompts/defaultPrompts');

const CACHE_TTL_MS = Number(process.env.AI_PROMPT_CACHE_TTL_MS || 30 * 1000);
const HISTORY_LIMIT = 20;
const MAX_CONTENT_CHARS = 60000;

const CHAT_ROLES = ['user', 'seller', 'admin'];
const CHANNELS = ['web', 'whatsapp'];

// ── Registry of built-in prompts ─────────────────────────────────────────────
// key → metadata + code default. The admin API lists these even when no DB
// document exists.
const PROMPT_REGISTRY = [
    {
        key: 'chat.base.user',
        category: 'chat-personas',
        title: 'Buyer chat — core persona',
        description: 'Main system prompt for shoppers/buyers chatting with Rozare AI on the website and WhatsApp. Defines identity, tone, capabilities, and buyer-facing rules.',
        usedIn: 'Website AI chat, WhatsApp AI chat (buyer role), guest visitors',
        getDefault: () => defaults.USER_PROMPT,
    },
    {
        key: 'chat.base.seller',
        category: 'chat-personas',
        title: 'Seller chat — core persona',
        description: 'Main system prompt for sellers chatting with the Rozare AI Business Partner. Defines seller tools usage, store management behavior, and business advice style.',
        usedIn: 'Website AI chat, WhatsApp AI chat (seller role)',
        getDefault: () => defaults.SELLER_PROMPT,
    },
    {
        key: 'chat.base.admin',
        category: 'chat-personas',
        title: 'Admin chat — core persona',
        description: 'Main system prompt for platform admins chatting with the Rozare AI Platform Commander. Defines administrative capabilities and authority.',
        usedIn: 'Website AI chat, WhatsApp AI chat (admin numbers)',
        getDefault: () => defaults.ADMIN_PROMPT,
    },
    {
        key: 'chat.addendum.language',
        category: 'chat-addendums',
        title: 'Language & Urdu style rules',
        description: 'Appended to every chat persona. Controls reply language (English / Roman Urdu) and wording style.',
        usedIn: 'All chat roles, website + WhatsApp',
        getDefault: () => defaults.LANGUAGE_STYLE_ADDENDUM,
    },
    {
        key: 'chat.addendum.tool-memory',
        category: 'chat-addendums',
        title: 'Internal tool memory rules',
        description: 'Appended to every chat persona. Tells the AI how to use hidden [Tool memory:] notes without revealing internal IDs to users.',
        usedIn: 'All chat roles, website + WhatsApp',
        getDefault: () => defaults.TOOL_MEMORY_ADDENDUM,
    },
    {
        key: 'chat.addendum.whatsapp',
        category: 'chat-addendums',
        title: 'WhatsApp formatting rules',
        description: 'Appended only for WhatsApp conversations. Keeps replies short, plain-text, mobile-friendly, and controls product-image sending behavior.',
        usedIn: 'WhatsApp AI chat only (all roles)',
        getDefault: () => defaults.WHATSAPP_SYSTEM_PROMPT_ADDENDUM,
    },
    {
        key: 'assist.description.system',
        category: 'product-assist',
        title: 'Product description improver',
        description: 'System prompt for the "Improve description" button on the seller product form.',
        usedIn: 'Seller product form → AI assist',
        getDefault: () => defaults.ASSIST_DESCRIPTION_SYSTEM,
    },
    {
        key: 'assist.description.format',
        category: 'product-assist',
        title: 'Description output format rule',
        description: 'Extra formatting instruction sent with the description improver (plain text only, no markdown).',
        usedIn: 'Seller product form → AI assist',
        getDefault: () => defaults.ASSIST_DESCRIPTION_FORMAT,
    },
    {
        key: 'assist.tags.system',
        category: 'product-assist',
        title: 'Product tag generator',
        description: 'System prompt for the "Generate tags" button on the seller product form. Returns JSON tags.',
        usedIn: 'Seller product form → AI assist',
        getDefault: () => defaults.ASSIST_TAGS_SYSTEM,
    },
];

const CATEGORY_META = {
    'chat-personas': { title: 'Chat assistant — personas', order: 1, description: 'The core system prompts that define who Rozare AI is for each audience.' },
    'chat-addendums': { title: 'Chat assistant — shared addendums', order: 2, description: 'Rule blocks appended to every persona (language, internal memory, WhatsApp formatting).' },
    'product-assist': { title: 'Product assist tools', order: 3, description: 'Prompts behind the AI buttons on the seller product form.' },
    knowledge: { title: 'Platform knowledge (custom)', order: 4, description: 'Admin-added knowledge the AI should know: new features, policies, FAQs. Appended to chat prompts for the selected roles and channels.' },
};

const registryByKey = new Map(PROMPT_REGISTRY.map(item => [item.key, item]));

// ── Cache ────────────────────────────────────────────────────────────────────
let cache = null;       // { byKey: Map<key, doc>, customs: doc[] }
let cacheLoadedAt = 0;

const isMongoReady = () => mongoose.connection.readyState === 1;

async function loadAll(force = false) {
    const fresh = cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS;
    if (fresh && !force) return cache;
    if (!isMongoReady()) {
        // No DB (tests, early boot) — behave as "no overrides".
        return { byKey: new Map(), customs: [] };
    }
    try {
        const docs = await AIPrompt.find({}).lean();
        const byKey = new Map();
        const customs = [];
        for (const doc of docs) {
            byKey.set(doc.key, doc);
            if (doc.type === 'custom') customs.push(doc);
        }
        cache = { byKey, customs };
        cacheLoadedAt = Date.now();
        return cache;
    } catch (err) {
        console.warn('[ai-prompts] failed to load prompts, using defaults:', err.message);
        return cache || { byKey: new Map(), customs: [] };
    }
}

function invalidateCache() {
    cache = null;
    cacheLoadedAt = 0;
}

// ── Resolution ───────────────────────────────────────────────────────────────

function defaultContent(key) {
    const item = registryByKey.get(key);
    return item ? item.getDefault() : '';
}

async function getPromptContent(key) {
    const { byKey } = await loadAll();
    const override = byKey.get(key);
    if (override && override.type === 'builtin' && typeof override.content === 'string' && override.content.trim()) {
        return override.content;
    }
    return defaultContent(key);
}

function normalizeRole(role) {
    // Guests get the buyer persona (same behavior as before this service).
    return CHAT_ROLES.includes(role) ? role : 'user';
}

function buildKnowledgeBlock(customs, role, channel) {
    const active = customs.filter(p =>
        p.isActive !== false &&
        String(p.content || '').trim() &&
        (Array.isArray(p.appliesTo) ? p.appliesTo : []).includes(role) &&
        (Array.isArray(p.channels) ? p.channels : []).includes(channel)
    );
    if (!active.length) return '';

    const sections = active.map(p => {
        const title = String(p.title || '').trim();
        return (title ? `### ${title}\n` : '') + String(p.content).trim();
    });

    return [
        '',
        '## Platform updates & knowledge (admin-maintained)',
        'The notes below are maintained by the Rozare platform admin and describe current features, policies, and answers. Treat them as authoritative and up to date; prefer them over older assumptions when they conflict.',
        '',
        sections.join('\n\n'),
        '',
    ].join('\n');
}

/**
 * Assemble the full chat system prompt for a role + channel.
 * Replaces the old hardcoded getSystemPrompt() + WhatsApp addendum concat.
 *
 * @param {string} role - 'user' | 'seller' | 'admin' | anything else = guest→user persona
 * @param {object} [options]
 * @param {string} [options.channel='web'] - 'web' | 'whatsapp'
 */
async function getSystemPromptForRole(role, { channel = 'web' } = {}) {
    const effectiveRole = normalizeRole(role);
    const effectiveChannel = CHANNELS.includes(channel) ? channel : 'web';

    const [base, language, toolMemory, whatsapp] = await Promise.all([
        getPromptContent(`chat.base.${effectiveRole}`),
        getPromptContent('chat.addendum.language'),
        getPromptContent('chat.addendum.tool-memory'),
        effectiveChannel === 'whatsapp' ? getPromptContent('chat.addendum.whatsapp') : Promise.resolve(''),
    ]);

    const { customs } = await loadAll();
    const knowledge = buildKnowledgeBlock(customs, effectiveRole, effectiveChannel);

    return base + language + toolMemory + whatsapp + knowledge;
}

async function getAssistPrompts() {
    const [describeSystem, describeFormat, tagsSystem] = await Promise.all([
        getPromptContent('assist.description.system'),
        getPromptContent('assist.description.format'),
        getPromptContent('assist.tags.system'),
    ]);
    return { describeSystem, describeFormat, tagsSystem };
}

// ── Admin API helpers ────────────────────────────────────────────────────────

function presentPrompt(registryItem, doc) {
    if (registryItem) {
        const overridden = Boolean(doc && String(doc.content || '').trim());
        return {
            key: registryItem.key,
            type: 'builtin',
            category: registryItem.category,
            title: registryItem.title,
            description: registryItem.description,
            usedIn: registryItem.usedIn,
            content: overridden ? doc.content : registryItem.getDefault(),
            defaultContent: registryItem.getDefault(),
            isOverridden: overridden,
            isActive: true,
            appliesTo: [],
            channels: [],
            version: doc?.version || 0,
            updatedAt: doc?.updatedAt || null,
            updatedByName: doc?.updatedByName || '',
            history: (doc?.history || []).slice().reverse(),
        };
    }
    return {
        key: doc.key,
        type: 'custom',
        category: 'knowledge',
        title: doc.title || '',
        description: doc.description || '',
        usedIn: 'Appended to chat prompts for the selected roles/channels',
        content: doc.content || '',
        defaultContent: '',
        isOverridden: false,
        isActive: doc.isActive !== false,
        appliesTo: doc.appliesTo || [],
        channels: doc.channels || [],
        version: doc.version || 1,
        updatedAt: doc.updatedAt || null,
        updatedByName: doc.updatedByName || '',
        history: (doc.history || []).slice().reverse(),
    };
}

async function listForAdmin() {
    const { byKey, customs } = await loadAll(true);

    const prompts = PROMPT_REGISTRY.map(item => presentPrompt(item, byKey.get(item.key)));
    for (const custom of customs) prompts.push(presentPrompt(null, custom));

    const categories = Object.entries(CATEGORY_META)
        .map(([id, meta]) => ({ id, ...meta }))
        .sort((a, b) => a.order - b.order);

    return { categories, prompts };
}

function pushHistory(doc, editorName) {
    doc.history = [
        ...(doc.history || []),
        {
            content: doc.content,
            version: doc.version || 1,
            updatedAt: new Date(),
            updatedByName: doc.updatedByName || editorName || '',
        },
    ].slice(-HISTORY_LIMIT);
}

function validateContent(content) {
    const text = String(content ?? '');
    if (!text.trim()) throw Object.assign(new Error('Prompt content cannot be empty'), { status: 400 });
    if (text.length > MAX_CONTENT_CHARS) {
        throw Object.assign(new Error(`Prompt content is too long (max ${MAX_CONTENT_CHARS} characters)`), { status: 400 });
    }
    return text;
}

async function updatePrompt(key, { content, title, description, appliesTo, channels, isActive }, editor = {}) {
    const registryItem = registryByKey.get(key);
    const existing = await AIPrompt.findOne({ key });

    if (!registryItem && !existing) {
        throw Object.assign(new Error('Prompt not found'), { status: 404 });
    }

    const editorName = editor.username || editor.email || '';

    if (registryItem) {
        // Built-in override
        const text = validateContent(content);
        if (existing) {
            pushHistory(existing, editorName);
            existing.content = text;
            existing.version = (existing.version || 1) + 1;
            existing.updatedBy = editor.id || existing.updatedBy;
            existing.updatedByName = editorName;
            await existing.save();
        } else {
            await AIPrompt.create({
                key,
                type: 'builtin',
                title: registryItem.title,
                description: registryItem.description,
                category: registryItem.category,
                content: text,
                updatedBy: editor.id || undefined,
                updatedByName: editorName,
            });
        }
    } else {
        // Custom prompt update
        if (content !== undefined) {
            pushHistory(existing, editorName);
            existing.content = validateContent(content);
            existing.version = (existing.version || 1) + 1;
        }
        if (title !== undefined) existing.title = String(title).slice(0, 200);
        if (description !== undefined) existing.description = String(description).slice(0, 500);
        if (Array.isArray(appliesTo)) existing.appliesTo = appliesTo.filter(r => CHAT_ROLES.includes(r));
        if (Array.isArray(channels)) existing.channels = channels.filter(c => CHANNELS.includes(c));
        if (isActive !== undefined) existing.isActive = Boolean(isActive);
        existing.updatedBy = editor.id || existing.updatedBy;
        existing.updatedByName = editorName;
        await existing.save();
    }

    invalidateCache();
    const { byKey } = await loadAll(true);
    return presentPrompt(registryItem || null, byKey.get(key));
}

async function createCustomPrompt({ title, description, content, appliesTo, channels, isActive }, editor = {}) {
    const text = validateContent(content);
    const cleanTitle = String(title || '').trim().slice(0, 200);
    if (!cleanTitle) throw Object.assign(new Error('Title is required'), { status: 400 });

    const roles = (Array.isArray(appliesTo) ? appliesTo : []).filter(r => CHAT_ROLES.includes(r));
    const chans = (Array.isArray(channels) ? channels : []).filter(c => CHANNELS.includes(c));

    const key = `knowledge.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const doc = await AIPrompt.create({
        key,
        type: 'custom',
        category: 'knowledge',
        title: cleanTitle,
        description: String(description || '').slice(0, 500),
        content: text,
        appliesTo: roles.length ? roles : CHAT_ROLES,
        channels: chans.length ? chans : CHANNELS,
        isActive: isActive === undefined ? true : Boolean(isActive),
        updatedBy: editor.id || undefined,
        updatedByName: editor.username || editor.email || '',
    });

    invalidateCache();
    return presentPrompt(null, doc.toObject());
}

async function resetPrompt(key) {
    const registryItem = registryByKey.get(key);
    if (!registryItem) throw Object.assign(new Error('Only built-in prompts can be reset to default'), { status: 400 });
    await AIPrompt.deleteOne({ key, type: 'builtin' });
    invalidateCache();
    return presentPrompt(registryItem, null);
}

async function deletePrompt(key) {
    const doc = await AIPrompt.findOne({ key });
    if (!doc) throw Object.assign(new Error('Prompt not found'), { status: 404 });
    if (doc.type !== 'custom') {
        throw Object.assign(new Error('Built-in prompts cannot be deleted — use reset to default instead'), { status: 400 });
    }
    await AIPrompt.deleteOne({ key });
    invalidateCache();
    return { deleted: true };
}

module.exports = {
    getSystemPromptForRole,
    getAssistPrompts,
    getPromptContent,
    listForAdmin,
    updatePrompt,
    createCustomPrompt,
    resetPrompt,
    deletePrompt,
    invalidateCache,
    PROMPT_REGISTRY,
    CATEGORY_META,
    _buildKnowledgeBlock: buildKnowledgeBlock,
};
