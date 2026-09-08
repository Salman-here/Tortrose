'use strict';
const { percentageOfMoney, roundMoney } = require('./moneyMath');

// Commercial facts must come from the seller (or an explicit approval of a
// displayed proposal), not from values invented in a model's tool arguments.
const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, ek: 1, aik: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10, bees: 20, tees: 30, dhai: 2.5 };
const MULTIPLIERS = { hundred: 100, thousand: 1000, million: 1000000, sau: 100, so: 100, hazar: 1000, hazaar: 1000 };
const WORD = [...Object.keys(SMALL), ...Object.keys(MULTIPLIERS), 'and'].join('|');
const AMOUNT = `(?:\\d+(?:[,.]\\d+)*(?:\\s*(?:k|hundred|thousand|million|hazar|hazaar|sau))?|(?:${WORD})(?:[ -]+(?:${WORD})){0,12})`;
const CURRENCY = '(?:Pakistani\\s+rupees?|US\\s+dollars?|British\\s+pounds?|PKR|USD|EUR|GBP|Rs\\.?|[$£€]|rupees?|rupey|rupay|dollars?|pounds?|euros?)';
const codeFor = value => {
  const token = String(value || '').trim().replace(/[.!?]+$/, '');
  if (/^(?:PKR|Rs|rupees?|rupey|rupay|Pakistani\s+rupees?)$/i.test(token)) return 'PKR';
  if (/^(?:USD|\$|dollars?|US\s+dollars?)$/i.test(token)) return 'USD';
  if (/^(?:EUR|€|euros?)$/i.test(token)) return 'EUR';
  if (/^(?:GBP|£|pounds?|British\s+pounds?)$/i.test(token)) return 'GBP';
  return null;
};
const normalize = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = value => String(value || '').replace(/\[Attached product (?:image|file):[^\]]*\]/gi, '').replace(/https?:\/\/\S+/gi, '').replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 1632));
const escaped = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function productText(text, name, productNames = []) {
  const locate = value => value && value.length >= 3 ? new RegExp(`(?<!\\w)${escaped(value)}(?!\\w)`, 'i').exec(text)?.index : undefined;
  const current = locate(name);
  const others = productNames.filter(value => normalize(value) !== normalize(name)).map(locate).filter(index => index !== undefined);
  if (current !== undefined && others.length) {
    const next = others.filter(index => index > current).sort((a, b) => a - b)[0];
    return text.slice(current, next ?? text.length);
  }
  const completeRows = text.split(/[\n;]/).filter(line => locate(name) !== undefined && new RegExp(escaped(name), 'i').test(line)).filter(line => {
    const facts = readFacts(line);
    return facts.prices.length && facts.stocks.length;
  });
  return completeRows.length === 1 ? completeRows[0] : text;
}

function amountValue(value) {
  let text = String(value || '').trim().toLowerCase().replace(/-/g, ' ');
  if (text === 'so') return null; // English "so" alone is not a stock/price value.
  const numeric = /^(\d+(?:[,.]\d+)*)(?:\s*(k|hundred|thousand|million|hazar|hazaar|sau))?$/.exec(text);
  if (numeric) {
    let digits = numeric[1];
    if (digits.includes(',') && (!digits.includes('.') && /,\d{1,2}$/.test(digits) || digits.lastIndexOf(',') > digits.lastIndexOf('.') && digits.includes('.'))) digits = digits.replace(/\./g, '').replace(',', '.');
    else digits = digits.replace(/,/g, '');
    return Number(digits) * (numeric[2] === 'k' ? 1000 : MULTIPLIERS[numeric[2]] || 1);
  }
  let total = 0, current = 0, seen = false;
  for (const word of text.split(/\s+/)) {
    if (word === 'and') continue;
    if (Object.prototype.hasOwnProperty.call(SMALL, word)) { current += SMALL[word]; seen = true; }
    else if (MULTIPLIERS[word] === 100) { current = (current || 1) * 100; seen = true; }
    else if (MULTIPLIERS[word]) { total += (current || 1) * MULTIPLIERS[word]; current = 0; seen = true; }
    else return null;
  }
  return seen ? total + current : null;
}

function collect(text, pattern, make) {
  const out = [];
  for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
    const after = text.slice(match.index + match[0].length);
    if (/^\s*(?:[-–]|to|\.\.)\s*\d/i.test(after) || /^\s*(?:%|(?:ml|oz|kg|cm|mm|days?|weeks?|months?|years?|percent)\b)/i.test(after)) continue;
    if (/[a-z]$/i.test(match[0].trim()) && /^\s+(?:of|you|i|we|they|he|she|it|can|could|would|should|do|does|mean|recommend)\b/i.test(after)) continue;
    const value = make(match);
    if (value && Number.isFinite(value.amount) && value.amount >= 0) out.push(value);
  }
  return out;
}
function readFacts(content, previousAssistant = '') {
  const text = clean(content);
  const prices = [
    ...collect(text, `(?<!\\w)(${CURRENCY})\\s*(${AMOUNT})(?!\\w|\\.\\d)`, m => ({ amount: amountValue(m[2]), currency: codeFor(m[1]) })),
    ...collect(text, `(?<![\\w.\\-])(${AMOUNT})\\s*(${CURRENCY}|each)(?!\\w)`, m => ({ amount: amountValue(m[1]), currency: codeFor(m[2]) })),
    ...collect(text, `\\b(?:price|priced|cost|charge|sell(?:\\s+it)?\\s+for)["']?\\s*(?:is|at|of|to|:|=)?\\s*(${CURRENCY})?\\s*(${AMOUNT})(?!\\w|\\.\\d)`, m => ({ amount: amountValue(m[2]), currency: codeFor(m[1]) })),
  ];
  const stocks = [
    ...collect(text, `\\b(?:stock|inventory|quantity)\\b["']?\\s*(?:is|of|to|:|=)?\\s*(${AMOUNT})(?!\\w|\\.\\d)`, m => ({ amount: amountValue(m[1]) })),
    ...collect(text, `(?<![\\w.\\-])(${AMOUNT})\\s*(?:(?:units?|pieces?|items?)\\s*)?(?:in\\s+stock|available|on\\s+hand)\\b`, m => (new RegExp(CURRENCY + '\\s*$', 'i').test(text.slice(0, m.index)) || /\bbudget(?:\s+of)?\s*$/i.test(text.slice(0, m.index))) ? null : ({ amount: amountValue(m[1]) })),
    ...collect(text, `\\b(?:have|got)\\s+(${AMOUNT})\\s+(?:units?|pieces?|items?)\\b`, m => ({ amount: amountValue(m[1]) })),
  ];
  if (/\b(?:out of stock|no stock|zero stock)\b/i.test(text)) stocks.push({ amount: 0 });
  if (/\b(?:price is free|sell (?:it )?for free|make it free)\b/i.test(text)) prices.push({ amount: 0, currency: null });
  const askedPrice = /(?:what|which|provide|tell|need)[^.!?]{0,100}\bprice\b/i.test(previousAssistant);
  const askedStock = /(?:what|how many|provide|tell|need)[^.!?]{0,100}\b(?:stock|units|quantity)\b/i.test(previousAssistant);
  const bare = new RegExp(`^\\s*(${AMOUNT})\\s*[.!]?\\s*$`, 'i').exec(text);
  if (bare && askedPrice) prices.push({ amount: amountValue(bare[1]), currency: null });
  if (bare && askedStock && !askedPrice) stocks.push({ amount: amountValue(bare[1]) });
  if (askedPrice && askedStock) {
    const tuple = new RegExp(`^\\s*(${AMOUNT})\\s*(?:,(?:\\s+|(?=[a-z]))|;\\s*|&\\s*)(${AMOUNT})\\s*[.!]?\\s*$`, 'i').exec(text)
      || /^\s*(\d+(?:\.\d+)?)\s+and\s+(\d+)\s*[.!]?\s*$/i.exec(text);
    if (tuple) {
      const priceFirst = previousAssistant.search(/\bprice\b/i) < previousAssistant.search(/\b(?:stock|units|quantity)\b/i);
      prices.push({ amount: amountValue(tuple[priceFirst ? 1 : 2]), currency: null });
      stocks.push({ amount: amountValue(tuple[priceFirst ? 2 : 1]) });
    }
  }
  const discounts = collect(text, `\\b(?:sale price|discounted price|discount price|offer price|now)\\b["']?\\s*(?:is|of|to|:|=)?\\s*(${CURRENCY})?\\s*(${AMOUNT})(?!\\w|\\.\\d)`, m => ({ amount: amountValue(m[2]), currency: codeFor(m[1]) }));
  return { prices, stocks, discounts };
}

function parsedRows(content) {
  const text = String(content || '');
  const marker = 'Parsed product rows JSON:';
  const startMarker = text.indexOf(marker);
  if (startMarker < 0) {
    try {
      const data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
      const rows = Array.isArray(data) ? data : data.products || data.items || (data.name ? [data] : []);
      if (Array.isArray(rows)) return { text: '', rows };
    } catch { /* Ordinary prose can still contain an inline product array. */ }
  }
  const start = startMarker >= 0 ? text.indexOf('[', startMarker + marker.length) : /\[\s*\{/.exec(text)?.index ?? -1;
  if (start < 0) return { text, rows: [] };
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '[') depth += 1;
    else if (c === ']' && --depth === 0) {
      try { return { text: text.slice(0, startMarker >= 0 ? startMarker : start) + text.slice(i + 1), rows: JSON.parse(text.slice(start, i + 1)) }; } catch { break; }
    }
  }
  return { text: text.slice(0, startMarker >= 0 ? startMarker : start), rows: [] };
}

function assessSellerCreationInputs({ name, productNames = [], discountedPrice = 0, currency, messages = [], lastUserText = '' }) {
  const input = messages.length ? messages : [{ role: 'user', content: lastUserText }];
  let start = 0;
  input.forEach((message, index) => {
    if (message.role !== 'user') return;
    const text = clean(message.content);
    const continuation = /^(?:please\s+)?(?:add|create|publish|list)\s+(?:it|that|this)(?:\s+(?:now|please|to my store|to the store))*[.!]?$/i.test(text.trim()) && !message.attachments?.length && !/\[Attached/i.test(message.content || '');
    if (!continuation && /\b(?:add|create|publish|import|list|upload)\b/i.test(text) && !/\b(?:cart|basket|wishlist)\b/i.test(text) && !/^\s*(?:yes|okay|ok|sure|haan|ji)\b/i.test(text)) start = index;
  });
  let prices = [], stocks = [], discounts = [], percentageDiscount = null, discountRemoved = false, previousAssistant = '';
  for (const [index, message] of input.entries()) {
    if (message.role === 'assistant') { previousAssistant = String(message.content || '').split(/\n\s*\[Tool memory:/)[0]; continue; }
    if (message.role !== 'user') continue;
    const parsed = parsedRows(message.content);
    const sharedCurrency = /\ball prices\s+(?:are\s+)?(?:in\s+)?(USD|PKR|EUR|GBP)\b|\b(?:these|following|all)\s+(USD|PKR|EUR|GBP)\s+products\b/i.exec(clean(parsed.text));
    const rowCurrency = (sharedCurrency?.[1] || sharedCurrency?.[2] || '').toUpperCase();
    const rows = parsed.rows.filter(row => normalize(row?.name) === normalize(name));
    if (rows.length === 1) {
      const row = rows[0];
      const rowFacts = readFacts(`price ${row.price ?? ''}; stock ${row.stock ?? ''}; discounted price ${row.discountedPrice ?? ''}`);
      if ((row.priceCurrency || row.currency) && !codeFor(row.priceCurrency || row.currency)) return { ok: false, missing: ['supported price currency'], currency };
      prices = rowFacts.prices.map(fact => ({ ...fact, currency: codeFor(row.priceCurrency || row.currency) || fact.currency || rowCurrency || null }));
      stocks = rowFacts.stocks;
      discounts = rowFacts.discounts.map(fact => ({ ...fact, currency: codeFor(row.discountedPriceCurrency || row.currency) || fact.currency }));
    } else if (rows.length > 1) return { ok: false, missing: ['an unambiguous product row'], currency };
    if (index < start) continue; // Keep named uploaded rows, not unrelated old prose.
    const approved = /^(?:yes|yep|yeah|sure|ok(?:ay)?|confirmed?|approved?|haan|han|ji|theek(?: hai)?|looks good|that works)\b/i.test(parsed.text.trim())
      && !/\d|\b(?:but|not|no|change|cancel|different|another|other|instead|except|more|less|increase|decrease|nahi|mat)\b/i.test(parsed.text)
      && /\b(?:confirm|approve|shall i (?:add|publish|create)|should i (?:add|publish|create)|are these details correct|is (?:this|that) correct|does this look (?:right|correct))\b/i.test(previousAssistant);
    const source = approved ? previousAssistant : parsed.text;
    const facts = readFacts(productText(source, name, productNames), previousAssistant);
    if (rowCurrency) facts.prices = facts.prices.map(fact => ({ ...fact, currency: fact.currency || rowCurrency }));
    if (facts.prices.length) prices = facts.prices;
    if (facts.stocks.length) stocks = facts.stocks;
    if (facts.discounts.length) discounts = facts.discounts;
    if (/\b(?:remove|clear|no|without)\s+(?:the\s+)?discount\b/i.test(parsed.text)) {
      if (!facts.prices.length || facts.discounts.length) prices = prices.filter(fact => !discounts.some(discount => discount.amount === fact.amount));
      discounts = []; percentageDiscount = null; discountRemoved = true;
    }
    const percent = /\b(\d+(?:\.\d+)?)\s*%\s*(?:off|discount)\b|\bdiscount\s*(?:of|:|=)?\s*(\d+(?:\.\d+)?)\s*%/i.exec(parsed.text);
    if (percent) { percentageDiscount = Number(percent[1] || percent[2]); discountRemoved = false; }
    if (/^(?:USD|PKR|GBP|EUR|rupees?|dollars?|euros?|pounds?)\s*[.!]?$/i.test(parsed.text.trim()) && /\bcurrency\b/i.test(previousAssistant)) prices = prices.map(fact => ({ ...fact, currency: codeFor(parsed.text) }));
  }
  const discountAmounts = [...new Set(discounts.map(fact => fact.amount))];
  const basePrices = prices.filter(fact => !discountAmounts.includes(fact.amount));
  const priceAmounts = [...new Set(basePrices.map(fact => fact.amount))];
  const stockAmounts = [...new Set(stocks.map(fact => fact.amount).filter(Number.isSafeInteger))];
  const explicitCurrencies = [...new Set(basePrices.map(fact => fact.currency).filter(Boolean))];
  const missing = [];
  if (priceAmounts.length !== 1 || explicitCurrencies.length > 1) missing.push('selling price');
  if (stockAmounts.length !== 1) missing.push('stock quantity');
  if (percentageDiscount !== null && priceAmounts.length === 1) {
    if (percentageDiscount < 0 || percentageDiscount >= 100) missing.push('discount below 100% (or set a zero selling price for a free item)');
    else {
      try {
        const derived = roundMoney(priceAmounts[0] - percentageOfMoney(priceAmounts[0], percentageDiscount));
        if (derived <= 0 && percentageDiscount > 0) throw new Error('Sale price must be representable');
        if (discountAmounts.length && !discountAmounts.includes(derived)) missing.push('consistent sale price');
        else if (!discountAmounts.length) discountAmounts.push(derived);
      } catch { missing.push('valid sale price'); }
    }
  }
  if (discountAmounts.length > 1 || discountedPrice > 0 && !discountAmounts.length && !discountRemoved) missing.push('sale price');
  const discount = discounts[0];
  return { ok: missing.length === 0, missing, price: priceAmounts[0], stock: stockAmounts[0], discountedPrice: discountAmounts[0] || 0, currency: explicitCurrencies[0] || currency, discountedCurrency: discount?.currency || explicitCurrencies[0] || currency };
}

module.exports = { assessSellerCreationInputs, amountValue, readFacts };
