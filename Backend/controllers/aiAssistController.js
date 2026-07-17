/**
 * AI Assist Controller
 * Lightweight helpers for the seller product form:
 *   - improveDescription: rewrite a product description so it's more
 *     compelling, clear and SEO-friendly.
 *   - generateTags: produce relevant tags from product name + description
 *     (no saved product required).
 *
 * Both endpoints call OpenRouter (same key the chat assistant uses).
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';
const SITE_URL = process.env.FRONTEND_URL || 'https://www.rozare.com';
const { sanitizeProductDescription } = require('../services/productTextService');
const { getAssistPrompts } = require('../services/aiPromptService');

async function callAI(messages, { json = false } = {}) {
  if (!OPENROUTER_API_KEY) {
    const err = new Error('AI service not configured');
    err.status = 500;
    throw err;
  }
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE_URL,
      'X-Title': 'Rozare',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.7,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`AI upstream error: ${resp.status} ${text}`);
    err.status = 502;
    throw err;
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

exports.improveDescription = async (req, res) => {
  try {
    const { name = '', description = '', category = '', brand = '' } = req.body || {};
    if (!description.trim()) {
      return res.status(400).json({ msg: 'Description is required' });
    }

    // Prompts are admin-editable from the dashboard (AI Prompts tab).
    const { describeSystem, describeFormat } = await getAssistPrompts();
    const messages = [
      { role: 'system', content: describeSystem },
      { role: 'system', content: describeFormat },
      {
        role: 'user',
        content: `Improve this product description.\n\nProduct name: ${name}\nBrand: ${brand}\nCategory: ${category}\n\nOriginal description:\n"""${description}"""`,
      },
    ];

    const improved = sanitizeProductDescription((await callAI(messages)).trim().replace(/^["']|["']$/g, ''));
    res.json({ description: improved });
  } catch (e) {
    console.error('improveDescription error:', e);
    res.status(e.status || 500).json({ msg: 'Failed to improve description' });
  }
};

exports.generateTags = async (req, res) => {
  try {
    const { name = '', description = '', category = '', brand = '' } = req.body || {};
    if (!name.trim() && !description.trim()) {
      return res.status(400).json({ msg: 'Name or description required' });
    }

    // Prompt is admin-editable from the dashboard (AI Prompts tab).
    const { tagsSystem } = await getAssistPrompts();
    const messages = [
      { role: 'system', content: tagsSystem },
      {
        role: 'user',
        content: `Product name: ${name}\nBrand: ${brand}\nCategory: ${category}\nDescription: ${description}`,
      },
    ];

    const raw = await callAI(messages, { json: true });
    let tags = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tags)) tags = parsed.tags;
    } catch {
      // Fallback: extract comma list
      tags = raw.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    }
    tags = [...new Set(
      tags
        .map((t) => String(t).toLowerCase().replace(/^#/, '').trim())
        .filter((t) => t && t.length <= 30)
    )].slice(0, 10);

    res.json({ tags });
  } catch (e) {
    console.error('generateTags error:', e);
    res.status(e.status || 500).json({ msg: 'Failed to generate tags' });
  }
};
