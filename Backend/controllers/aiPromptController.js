'use strict';

// Admin API for managing the AI prompts used across the platform.
// All routes are admin-only (enforced in routes/aiPromptRoutes.js).

const aiPromptService = require('../services/aiPromptService');

const editorFromReq = (req) => ({
    id: req.user?.id || req.user?._id,
    username: req.user?.username || '',
    email: req.user?.email || '',
});

const sendError = (res, err, fallback) => {
    const status = err.status || 500;
    if (status >= 500) console.error(`[ai-prompts] ${fallback}:`, err.message);
    return res.status(status).json({ msg: err.status ? err.message : fallback });
};

// GET /api/ai-prompts — all prompts grouped metadata + categories
exports.listPrompts = async (req, res) => {
    try {
        const data = await aiPromptService.listForAdmin();
        res.json(data);
    } catch (err) {
        sendError(res, err, 'Failed to load AI prompts');
    }
};

// PUT /api/ai-prompts/:key — edit a prompt (builtin override or custom fields)
exports.updatePrompt = async (req, res) => {
    try {
        const { content, title, description, appliesTo, channels, isActive } = req.body || {};
        const prompt = await aiPromptService.updatePrompt(
            req.params.key,
            { content, title, description, appliesTo, channels, isActive },
            editorFromReq(req)
        );
        res.json({ msg: 'Prompt updated', prompt });
    } catch (err) {
        sendError(res, err, 'Failed to update prompt');
    }
};

// POST /api/ai-prompts — create a custom knowledge prompt
exports.createPrompt = async (req, res) => {
    try {
        const { title, description, content, appliesTo, channels, isActive } = req.body || {};
        const prompt = await aiPromptService.createCustomPrompt(
            { title, description, content, appliesTo, channels, isActive },
            editorFromReq(req)
        );
        res.status(201).json({ msg: 'Prompt created', prompt });
    } catch (err) {
        sendError(res, err, 'Failed to create prompt');
    }
};

// POST /api/ai-prompts/:key/reset — remove a builtin override (back to code default)
exports.resetPrompt = async (req, res) => {
    try {
        const prompt = await aiPromptService.resetPrompt(req.params.key);
        res.json({ msg: 'Prompt reset to default', prompt });
    } catch (err) {
        sendError(res, err, 'Failed to reset prompt');
    }
};

// DELETE /api/ai-prompts/:key — delete a custom knowledge prompt
exports.deletePrompt = async (req, res) => {
    try {
        await aiPromptService.deletePrompt(req.params.key);
        res.json({ msg: 'Prompt deleted' });
    } catch (err) {
        sendError(res, err, 'Failed to delete prompt');
    }
};

// GET /api/ai-prompts/preview/:role?channel=web|whatsapp
// Returns the fully assembled system prompt exactly as the AI will receive it
// (minus the per-user context block, which is generated per conversation).
exports.previewPrompt = async (req, res) => {
    try {
        const role = req.params.role;
        const channel = req.query.channel === 'whatsapp' ? 'whatsapp' : 'web';
        const content = await aiPromptService.getSystemPromptForRole(role, { channel });
        res.json({
            role,
            channel,
            characters: content.length,
            note: 'Live per-user context (name, orders, store stats) is appended per conversation and is not shown here.',
            content,
        });
    } catch (err) {
        sendError(res, err, 'Failed to build preview');
    }
};
