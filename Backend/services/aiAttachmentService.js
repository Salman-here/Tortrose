'use strict';

const { Readable } = require('stream');
const axios = require('axios');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const { cloudinary } = require('../utils/cloudinary');
const { getMediaFromMessage } = require('./whatsapp/evolutionMediaService');

const MAX_ATTACHMENT_BYTES = Number(process.env.AI_CHAT_ATTACHMENT_MAX_BYTES || 15 * 1024 * 1024);
const MAX_CONTEXT_CHARS = Number(process.env.AI_CHAT_ATTACHMENT_CONTEXT_CHARS || 30000);
const TRANSCRIPTION_PROVIDER = String(process.env.TRANSCRIPTION_PROVIDER || 'openrouter').trim().toLowerCase();
const transcriptionModelFor = (provider, env = process.env) => (
  provider === 'openai'
    ? (env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe')
    : (env.OPENROUTER_TRANSCRIPTION_MODEL || 'openai/whisper-large-v3')
);
// Keep provider model configuration isolated. An OpenAI model id such as
// `gpt-4o-transcribe` is not a valid OpenRouter id (which is provider-prefixed),
// so falling across env vars can silently break every WhatsApp voice note.
// Whisper Large V3 is the verified production default for OpenRouter's
// dedicated STT endpoint; deployments can still opt into another model with
// OPENROUTER_TRANSCRIPTION_MODEL.
const OPENROUTER_TRANSCRIPTION_MODEL = transcriptionModelFor('openrouter');
const OPENAI_TRANSCRIPTION_MODEL = transcriptionModelFor('openai');
const TRANSCRIPTION_TIMEOUT_MS = Number(process.env.AI_TRANSCRIPTION_TIMEOUT_MS || 45000);

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const AUDIO_EXTENSIONS = new Set(['ogg', 'oga', 'opus', 'mp3', 'm4a', 'mp4', 'mpeg', 'mpga', 'wav', 'webm', 'flac']);
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls']);
const TEXT_EXTENSIONS = new Set(['json', 'csv', 'tsv', 'txt']);
const DOCUMENT_TEXT_EXTENSIONS = new Set(['pdf', 'docx']);

const HEADER_ALIASES = {
  name: ['name', 'product name', 'product_name', 'productname', 'title', 'product title', 'item', 'item name'],
  description: ['description', 'desc', 'details', 'product description'],
  price: ['price', 'regular price', 'amount', 'unit price', 'sale amount'],
  currency: ['currency', 'currency code', 'price currency'],
  discountedPrice: ['discounted price', 'discount price', 'sale price', 'discounted_price', 'discountedprice', 'compare price'],
  discountedCurrency: ['discounted currency', 'discount currency', 'discountedcurrency', 'sale currency'],
  category: ['category', 'type', 'product category'],
  brand: ['brand', 'maker', 'manufacturer', 'vendor'],
  stock: ['stock', 'quantity', 'qty', 'inventory', 'units'],
  image: ['image', 'image url', 'image_url', 'imageurl', 'photo', 'photo url', 'main image'],
  images: ['images', 'image urls', 'imageurls', 'gallery', 'gallery images'],
  tags: ['tags', 'keywords', 'labels'],
  colors: ['colors', 'colour', 'color', 'color options', 'colour options'],
  optionGroups: ['options', 'variants', 'option groups', 'sizes'],
};

function extensionFromName(name = '') {
  const clean = String(name || '').split('?')[0].split('#')[0];
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function canonicalField(header) {
  const normalized = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(normalized)) return field;
  }
  return normalized.replace(/[^a-z0-9]+(.)/g, (_, ch) => ch.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  return String(value || '')
    .split(/[,\n;|]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeProductRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const key = canonicalField(rawKey);
    const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }

  for (const field of ['price', 'discountedPrice', 'stock']) {
    if (out[field] !== undefined && typeof out[field] !== 'string') {
      const n = Number(out[field]);
      if (Number.isFinite(n)) out[field] = n;
    }
  }

  if (out.tags !== undefined) out.tags = splitList(out.tags);
  if (out.colors !== undefined) out.colors = splitList(out.colors);
  if (out.images !== undefined) out.images = splitList(out.images);
  if (!out.images && out.image && String(out.image).includes(',')) {
    const images = splitList(out.image);
    out.image = images[0];
    out.images = images;
  }

  return Object.keys(out).length ? out : null;
}

function findProductArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of ['products', 'items', 'data', 'rows', 'inventory']) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [json];
}

function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some(v => String(v).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  row.push(cell);
  if (row.some(v => String(v).trim())) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => String(h || '').trim());
  return rows.slice(1).map(values => {
    const obj = {};
    headers.forEach((header, index) => {
      if (header) obj[header] = values[index] ?? '';
    });
    return obj;
  });
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');
  if (buffer.length >= 2) {
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.subarray(2).toString('utf16le');
    if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
      const swapped = Buffer.alloc(Math.max(0, buffer.length - 2));
      for (let i = 2; i + 1 < buffer.length; i += 2) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
      return swapped.toString('utf16le');
    }
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let nulEven = 0;
  let nulOdd = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0 && i % 2 === 0) nulEven += 1;
    if (sample[i] === 0 && i % 2 === 1) nulOdd += 1;
  }
  if (nulOdd > sample.length / 8 && nulOdd > nulEven * 4) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

function parseBestDelimited(text, preferredDelimiter = ',') {
  const candidates = [preferredDelimiter, ',', ';', '\t']
    .filter((value, index, arr) => value && arr.indexOf(value) === index);
  let best = [];
  let bestScore = -1;
  for (const delimiter of candidates) {
    const rows = parseDelimited(text, delimiter);
    const score = rows.reduce((sum, row) => sum + Object.keys(row || {}).length, 0);
    if (rows.length && score > bestScore) {
      best = rows;
      bestScore = score;
    }
  }
  return best;
}

function normalizedProductRows(rows = []) {
  return rows.map(normalizeProductRow).filter(Boolean);
}

function hasProductSignal(rows = []) {
  return rows.some(row => row?.name || row?.price !== undefined || row?.description || row?.image || row?.category);
}

async function parseSpreadsheet(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const headers = [];
  worksheet.getRow(1).eachCell((cell, col) => {
    headers[col - 1] = String(cell.value || '').trim();
  });

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const value = row.getCell(index + 1).value;
      obj[header] = value && typeof value === 'object' && value.text ? value.text : value;
    });
    if (Object.values(obj).some(v => v !== undefined && v !== null && String(v).trim() !== '')) rows.push(obj);
  });
  return rows;
}

async function parseProductFile(buffer, { filename = '', mimetype = '' } = {}) {
  const ext = extensionFromName(filename);
  const type = String(mimetype || '').toLowerCase();

  if (ext === 'json' || type.includes('json')) {
    const json = JSON.parse(decodeTextBuffer(buffer).replace(/^\uFEFF/, ''));
    return normalizedProductRows(findProductArray(json));
  }

  if (ext === 'csv' || type.includes('csv')) {
    return normalizedProductRows(parseBestDelimited(decodeTextBuffer(buffer), ','));
  }

  if (ext === 'tsv' || type.includes('tab-separated')) {
    return normalizedProductRows(parseBestDelimited(decodeTextBuffer(buffer), '\t'));
  }

  if (SPREADSHEET_EXTENSIONS.has(ext) || type.includes('spreadsheet') || type.includes('excel')) {
    return normalizedProductRows(await parseSpreadsheet(buffer));
  }

  const text = decodeTextBuffer(buffer).replace(/\u0000/g, '').trim();
  if (!text) return [];
  if (/^[\[{]/.test(text)) {
    try {
      const rows = normalizedProductRows(findProductArray(JSON.parse(text.replace(/^\uFEFF/, ''))));
      if (hasProductSignal(rows)) return rows;
    } catch { /* not JSON */ }
  }

  const rows = normalizedProductRows(parseBestDelimited(text, ','));
  return hasProductSignal(rows) ? rows : [];
}

function sniffMimetype(buffer, fallback = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return fallback;
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (head[0] === 0x50 && head[1] === 0x4B) return fallback || 'application/zip';
  return fallback;
}

function isImageAttachment(att) {
  const type = String(att.mimetype || att.type || '').toLowerCase();
  const ext = extensionFromName(att.originalname || att.filename || att.name || att.url);
  return type.startsWith('image/') || IMAGE_EXTENSIONS.has(ext);
}

function isAudioAttachment(att) {
  const type = String(att.mimetype || att.type || '').toLowerCase();
  const ext = extensionFromName(att.originalname || att.filename || att.name || att.url);
  return type.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext) || att.kind === 'audio';
}

function isLikelyTextAttachment(att) {
  const type = String(att.mimetype || att.type || '').toLowerCase();
  const ext = extensionFromName(att.originalname || att.filename || att.name || att.url);
  return att.kind === 'document' ||
    type.startsWith('text/') || TEXT_EXTENSIONS.has(ext) || SPREADSHEET_EXTENSIONS.has(ext) ||
    DOCUMENT_TEXT_EXTENSIONS.has(ext) ||
    type.includes('json') || type.includes('csv') || type.includes('spreadsheet') || type.includes('excel') ||
    type.includes('pdf') || type.includes('wordprocessingml.document');
}

function isSpreadsheetAttachment(att) {
  const type = String(att.mimetype || att.type || '').toLowerCase();
  const ext = extensionFromName(att.originalname || att.filename || att.name || att.url);
  return SPREADSHEET_EXTENSIONS.has(ext) || type.includes('spreadsheet') || type.includes('excel');
}

function isDocumentTextAttachment(att) {
  const type = String(att.mimetype || att.type || '').toLowerCase();
  const ext = extensionFromName(att.originalname || att.filename || att.name || att.url);
  return DOCUMENT_TEXT_EXTENSIONS.has(ext) || type.includes('pdf') || type.includes('wordprocessingml.document');
}

function bufferFromBase64(value = '') {
  if (!value) return null;
  const raw = String(value).replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');
  if (!raw) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) return null;
  // Check encoded size before allocating the decoded Buffer. The webhook has a
  // larger HTTP body allowance so several normal attachments can arrive, but
  // each individual AI attachment still observes the stricter product limit.
  if (raw.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8) {
    throw new Error('Attachment is too large.');
  }
  return Buffer.from(raw, 'base64');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
  timeout.unref?.();
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Voice transcription timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isWhatsAppAttachment(att = {}) {
  return att.source === 'whatsapp' || att.evolutionInstance || att.messageKey || att.messageId;
}

async function getEvolutionAttachmentBuffer(att) {
  if (!isWhatsAppAttachment(att)) return null;
  const media = await getMediaFromMessage({
    instanceName: att.evolutionInstance,
    messageKey: att.messageKey,
    messageId: att.messageId,
    convertToMp4: att.kind === 'video',
  });
  if (media?.mimetype && !att.mimetype) att.mimetype = media.mimetype;
  return media.buffer;
}

async function getAttachmentBuffer(att) {
  if (Buffer.isBuffer(att.buffer)) return att.buffer;

  if (isWhatsAppAttachment(att)) {
    // Prefer the media bytes Evolution already inlined in the webhook payload
    // (webhookBase64). Evolution downloads inbound media at webhook time from
    // the live message, so this is present and reliable. The re-download-by-key
    // path below is only a fallback: inbound messages are not persisted in
    // Evolution (fast-inbound transport mode), so getBase64FromMediaMessage
    // usually cannot find them.
    const fromWebhookBase64 = bufferFromBase64(att.base64 || att.mediaBase64);
    if (fromWebhookBase64) return fromWebhookBase64;
    try {
      const fromEvolution = await getEvolutionAttachmentBuffer(att);
      if (fromEvolution) return fromEvolution;
    } catch (error) {
      att._evolutionMediaError = error.message;
    }
  }

  const url = att.url || att.mediaUrl || att.downloadUrl;
  if (url && /^https?:\/\//i.test(url)) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: MAX_ATTACHMENT_BYTES,
      maxBodyLength: MAX_ATTACHMENT_BYTES,
    });
    return Buffer.from(response.data);
  }

  const fromBase64 = bufferFromBase64(att.base64 || att.mediaBase64);
  if (fromBase64) return fromBase64;

  if (!isWhatsAppAttachment(att)) {
    try {
      const fromEvolution = await getEvolutionAttachmentBuffer(att);
      if (fromEvolution) return fromEvolution;
    } catch (error) {
      att._evolutionMediaError = error.message;
    }
  }

  return null;
}

function uploadImageBuffer(buffer, { filename = 'product-image', mimetype = 'image/jpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'E-Commerce/AI Chat',
        resource_type: 'image',
        allowed_formats: [...IMAGE_EXTENSIONS],
        filename_override: filename,
        timeout: 30000,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url || result.url);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function transcribeAudioBuffer(buffer, { filename = 'voice-message.ogg', mimetype = 'audio/ogg' } = {}) {
  if (TRANSCRIPTION_PROVIDER === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      return { text: '', error: 'Voice transcription is not configured. Set OPENAI_API_KEY to enable voice notes.' };
    }

    const form = new FormData();
    const blob = new Blob([buffer], { type: mimetype || 'audio/ogg' });
    form.append('file', blob, filename);
    form.append('model', OPENAI_TRANSCRIPTION_MODEL);
    form.append('response_format', 'json');

    const response = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Transcription failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    return { text: String(data.text || '').trim(), error: '' };
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return { text: '', error: 'Voice transcription is not configured. Set OPENROUTER_API_KEY to enable voice notes.' };
  }

  const ext = extensionFromName(filename);
  const type = String(mimetype || '').toLowerCase();
  let format = ext || type.split('/')[1] || 'ogg';
  format = String(format).split(';')[0].trim().toLowerCase();
  if (format === 'oga' || format === 'opus') format = 'ogg';
  if (format === 'mpeg' || format === 'mpga') format = 'mp3';
  if (format === 'mp4' && type.startsWith('audio/')) format = 'm4a';

  const body = {
    input_audio: {
      data: buffer.toString('base64'),
      format,
    },
    model: OPENROUTER_TRANSCRIPTION_MODEL,
  };

  if (process.env.OPENROUTER_TRANSCRIPTION_LANGUAGE) {
    body.language = process.env.OPENROUTER_TRANSCRIPTION_LANGUAGE;
  }

  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      ...(process.env.FRONTEND_URL ? { 'HTTP-Referer': process.env.FRONTEND_URL } : {}),
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE || 'Rozare AI Seller Assistant',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'Rozare AI Seller Assistant',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Transcription failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  return { text: String(data.text || '').trim(), error: '' };
}

async function extractDocumentText(buffer, { filename = '', mimetype = '' } = {}) {
  const ext = extensionFromName(filename);
  const type = String(mimetype || '').toLowerCase();

  if (ext === 'docx' || type.includes('wordprocessingml.document')) {
    const result = await mammoth.extractRawText({ buffer });
    return String(result.value || '').trim();
  }

  if (ext === 'pdf' || type.includes('pdf')) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return String(result.text || '').trim();
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  return '';
}

function getDisplayName(att) {
  return att.originalname || att.filename || att.fileName || att.name || 'attachment';
}

function truncateContext(text) {
  const value = String(text || '');
  return value.length > MAX_CONTEXT_CHARS ? `${value.slice(0, MAX_CONTEXT_CHARS)}\n[Attachment context truncated]` : value;
}

async function processChatAttachments(inputAttachments = []) {
  const attachments = Array.isArray(inputAttachments) ? inputAttachments.slice(0, 10) : [];
  const visibleAttachments = [];
  const contextParts = [];
  const processed = [];

  for (const att of attachments) {
    const name = getDisplayName(att);
    let mimetype = att.mimetype || att.type || 'application/octet-stream';

    try {
      const buffer = await getAttachmentBuffer(att);
      if (!buffer) {
        processed.push({ name, success: false, error: 'No attachment data found.' });
        continue;
      }
      mimetype = sniffMimetype(buffer, att.mimetype || att.type || mimetype);
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        processed.push({ name, success: false, error: 'Attachment is too large.' });
        continue;
      }

      if (isImageAttachment({ ...att, mimetype })) {
        const reusableUrl = !isWhatsAppAttachment(att) && att.url && /^https?:\/\//i.test(att.url);
        const url = reusableUrl ? att.url : await uploadImageBuffer(buffer, { filename: name, mimetype });
        visibleAttachments.push({ type: 'image', url, name });
        contextParts.push(`[Attached product image: ${url}]`);
        processed.push({ name, type: 'image', success: true, url });
        continue;
      }

      if (isAudioAttachment({ ...att, mimetype })) {
        const transcript = await transcribeAudioBuffer(buffer, { filename: name, mimetype }).catch(error => ({ text: '', error: error.message }));
        if (transcript.text) {
          contextParts.push(`[Voice message transcription from ${name}]\n${transcript.text}`);
          processed.push({ name, type: 'audio', success: true, transcript: transcript.text });
        } else {
          contextParts.push(`[Voice message from ${name} could not be transcribed: ${transcript.error || 'unknown error'}]`);
          processed.push({ name, type: 'audio', success: false, error: transcript.error || 'Transcription failed.' });
        }
        continue;
      }

      if (isLikelyTextAttachment({ ...att, mimetype })) {
        const rows = await parseProductFile(buffer, { filename: name, mimetype }).catch(() => []);
        const attachmentMeta = { ...att, mimetype };
        const canReadRawText = !isSpreadsheetAttachment(attachmentMeta) && !isDocumentTextAttachment(attachmentMeta);
        const documentText = isDocumentTextAttachment(attachmentMeta)
          ? await extractDocumentText(buffer, { filename: name, mimetype }).catch(() => '')
          : '';
        const rawText = documentText || (canReadRawText ? decodeTextBuffer(buffer).replace(/\u0000/g, '').trim() : '');
        contextParts.push([
          `[Attached product file: name="${name}" type="${mimetype}"]`,
          rows.length ? `Parsed product rows JSON:\n${JSON.stringify(rows.slice(0, 50), null, 2)}` : '',
          !rows.length && rawText ? `Extracted file text:\n${rawText.slice(0, 12000)}` : '',
          !rows.length && !rawText ? 'No product rows could be parsed from this file.' : '',
        ].filter(Boolean).join('\n'));
        processed.push({ name, type: 'file', success: true, parsedRows: rows.length });
        continue;
      }

      contextParts.push(`[Unsupported attachment: name="${name}" type="${mimetype}". Ask the seller to send CSV, JSON, XLSX, TXT, PDF, DOCX, image, or voice note.]`);
      processed.push({ name, type: 'unsupported', success: false, error: 'Unsupported attachment type.' });
    } catch (error) {
      processed.push({ name, success: false, error: error.message });
      contextParts.push(`[Attachment "${name}" could not be processed: ${error.message}]`);
    }
  }

  return {
    context: truncateContext(contextParts.filter(Boolean).join('\n\n')),
    attachments: visibleAttachments,
    processed,
  };
}

function appendAttachmentContextToMessages(messages = [], attachmentResult = {}) {
  const context = String(attachmentResult.context || '').trim();
  const attachments = Array.isArray(attachmentResult.attachments) ? attachmentResult.attachments : [];
  if (!context && attachments.length === 0) return messages;

  const next = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
  let index = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]?.role === 'user') {
      index = i;
      break;
    }
  }

  if (index < 0) {
    next.push({ role: 'user', content: context || 'Attachment uploaded', attachments });
    return next;
  }

  const current = next[index];
  const baseContent = typeof current.content === 'string' ? current.content : JSON.stringify(current.content || '');
  next[index] = {
    ...current,
    content: [baseContent, context].filter(Boolean).join('\n\n'),
    attachments: [...(Array.isArray(current.attachments) ? current.attachments : []), ...attachments],
  };
  return next;
}

module.exports = {
  processChatAttachments,
  appendAttachmentContextToMessages,
  parseProductFile,
  extractDocumentText,
  normalizeProductRow,
  __private: {
    decodeTextBuffer,
    parseBestDelimited,
    transcriptionModelFor,
  },
};
