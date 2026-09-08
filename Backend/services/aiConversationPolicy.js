'use strict';

const NATURAL_COMMERCE_ADDENDUM = `

## Natural conversations and accurate actions
People use short names, spelling mistakes, pronouns and everyday language. Resolve those yourself using the conversation and live tools. Never require the person to know a tool name, database ID, exact product title, or technical field name.
- Search BEFORE asking someone to spell a product name or provide its exact title. Use their partial words, likely corrected spelling, brand or description. A seller's inventory/stock/product-management request uses list_my_products; a shopping request uses search_products. If there are several plausible matches, show names, pictures, prices and numbered choices, then ask which one. Never modify an uncertain match.
- "That one", "the second one", "same size", "the bigger one" and corrections refer to the recent conversation. Read the product options or cart to resolve the reference. Ask only about genuinely missing or ambiguous choices. Do not invent an option or silently choose a seller default.
- When a buyer changes an item already in their cart ("make it silver instead", "change it to medium", "just two of those"), first view_cart if you do not have the current line. Then use update_cart_item, preserving unspecified options and quantity. Its cartItemId identifies ONE variant line. Do not add another item or remove/re-add as a substitute for editing. A deliberate additional item uses add_to_cart. An absolute quantity change uses update_cart_item.quantity.
- If several variants of a product are in the cart, identify the requested line by its current options or ask which one. remove_from_cart removes only the chosen line; use allMatching only when the person expressly wants all variants of that product removed. clear_cart is for explicitly emptying the whole cart.
- After any cart change, check the returned item options, quantities and full cart total against the user's request. Only describe the operation that succeeded. If a call failed, use its recovery guidance or ask a relevant question. Never stop with a promise to fix something you have not fixed.
- A cart may have changed through the website, app, WhatsApp or another device. Use the current cart. Never invent why an item disappeared or claim you removed it without a corresponding action receipt.
- For ordering, use preview_order to show the exact requested items/options, delivery address, product subtotal, shipping, tax and delivered total before placing an order. A specific product can be previewed directly without adding it to the cart. If the buyer says only one product, do not include unrelated cart items. Ask for missing options/address, then show the preview and wait for their next confirmation message. Use that preview's quoteToken and orderRequest with place_order after confirmation. A preview does not create an order; changed/expired previews need a fresh total and confirmation. Coupons and online payments use secure checkout; never promise a coupon deduction that the order tool does not support.
- A short reply to your question ("black, the bigger one", "eight in stock", "yes please") supplies details for the user's earlier request. Complete that already-requested action when its details are now sufficient. Do not end with "adding it now", "just a moment", or another promise, in ANY language (including "main update kar rahi hoon", "ek minute dijiye", "main kar deta hoon"). Execute the tool and then explain its actual result.
- For adding seller products from an image and rough notes, use the attachment and supplied details. Ask together for missing price, stock or unclear brand; infer an obvious category. Keep supplied spelling for a NEW product's title. For edits, find existing products using names/context. Distinguish "add this to my store" from "add this to my cart".
- Keep product, cart-line, store and user IDs internal. Display friendly names and numbered choices, never raw database IDs or internal method names. Product links/cards are fine. Public order numbers such as ORD-123 remain visible.
- Apply these rules equally to web, mobile and WhatsApp, including Roman Urdu and short informal messages. The tool results are authoritative; an earlier assistant claim is not proof.
`;

function sanitizeCommerceReply(text = '') {
  const urls = [];
  return String(text || '')
    // IDs inside working links must not be removed from the destination.
    .replace(/https?:\/\/[^\s<>\])]+/gi, url => `ROZARELINKPLACEHOLDER${urls.push(url) - 1}END`)
    .replace(/\b(?:product|cart(?:[ -]?item|[ -]?line)?|store|seller|user|database|internal)\s*(?:_?id|identifier)\s*[*`]*\s*[:=#-]?\s*[*`]*\s*[a-f\d]{24}\b[*`]*/gi, '')
    .replace(/(?<![\w-])[a-f\d]{24}(?![\w-])/gi, '')
    .replace(/\baip1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '')
    .replace(/\b(?:please\s+)?provide\s+(?:a\s+|the\s+)?(?:product\s*Id|cart\s*Item\s*Id)\b\.?/gi, 'Please tell me which item you mean.')
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:[-*•]|\d+[.)])\s*[*`]*\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ROZARELINKPLACEHOLDER(\d+)END/g, (_, index) => urls[Number(index)])
    .trim();
}

// A refusal guard, not an instruction to perform a mutation. The model must
// choose the dedicated update operation and supply a validated target/changes.
function isCartReplacementRequest(text = '') {
  const value = String(text || '').toLowerCase();
  if (/\b(?:remove|delete|clear|empty)\b/.test(value)) return false;
  if (/\b(?:add|want|buy|get)\s+(?:me\s+)?(?:another|an extra|one more|an additional)\b/.test(value)) return false;
  return /\b(?:instead|rather than|replace|swap)\b/.test(value)
    || /\b(?:change|switch|make|set)\b[^.!?\n]{0,70}\b(?:colou?r|size|capacity|quantity|qty|it|that|those|one)\b/.test(value)
    || /\b(?:iski jagah|is ki jagah|rang badal|size badal|badal do)\b/.test(value);
}

function catalogLookupBeforeClarification(draft, lastUserText, role, results = []) {
  if (!['user', 'seller', 'guest'].includes(role)) return null;
  const calls = results.map(entry => entry.tool || entry.action);
  if (calls.some(tool => ['search_products', 'list_my_products', 'get_product_detail', 'view_cart'].includes(tool))) return null;
  if (!/\b(?:exact (?:product )?(?:name|title)|spell(?:ing)?|product\s*(?:id|identifier)|more specific description|need to search|will search|let me (?:search|look|find)|as in (?:[a-z]-){2})/i.test(draft)) return null;
  if (!/\b(?:find|search|show|stock|inventory|buy|want|edit|change|update|price|product|item)\b/i.test(lastUserText)) return null;
  const shopping = /\b(?:buy|shop|cart|basket|for myself)\b/i.test(lastUserText);
  return role === 'seller' && !shopping ? 'list_my_products' : 'search_products';
}

function explicitlyClearsWholeCart(text = '') {
  return /\bclear_cart\b|\b(?:clear|empty)\b[^.!?\n]{0,40}\b(?:cart|basket)\b|\b(?:remove|delete)\s+(?:everything|all(?:\s+the|\s+my)?\s+(?:items|products))\b|\b(?:cart|basket)\b[^.!?\n]{0,20}\b(?:khali|khaali|saaf)\b/i.test(text);
}

function hasUnfinishedActionPromise(text = '') {
  const value = String(text || '');
  const commerce = /\b(?:cart|basket|product|stock|order|store|coupon|price|quantity|mug|item|add|update|change|remove|delete|clear|save)\b|(?:کارٹ|قیمت|آرڈر|اسٹاک|پروڈکٹ|दाम|कार्ट|ऑर्डर|स्टॉक)/i.test(value);
  return /\b(?:i(?:['’](?:ll|m)| will| am)|let me)\s+(?:now\s+)?(?:add(?:ing)?|updat(?:e|ing)|chang(?:e|ing)|remov(?:e|ing)|creat(?:e|ing)|plac(?:e|ing)|delet(?:e|ing)|clear(?:ing)?|fix(?:ing)?|sav(?:e|ing)|switch(?:ing)?)\b/i.test(value)
    || /(?:^|[.!?]\s+)(?:adding|updating|changing|removing|creating|placing|deleting|clearing|saving|switching)\b[^.!?\n]{0,160}\b(?:cart|basket|product|stock|order|store|coupon|price|quantity)\b/i.test(value)
    || (commerce && (
      /\b(?:ek|aik|one|just a)\s+(?:minute|moment|second)\b|\b(?:thoda|thora)\s+(?:intezar|intezaar|wait)\b/i.test(value)
      || /\b(?:main|mein|mai)\b[^.!?\n]{0,220}\b(?:kar|kr|badal|hata|daal|dal)\s+(?:raha|rahi|rha|rhi|deta|deti|dunga|dungi|dun\s+ga|dun\s+gi)\b/i.test(value)
      || /(?:میں|मैं)[^.!?\n]{0,160}(?:کر\s*(?:رہا|رہی|دوں)|کر\s*دیت[ای]|कर\s*(?:रहा|रही|दूँ|दूंगा|दूंगी)|कर\s*देत[ाी])/.test(value)
    ));
}

function hasRomanUrduMutationClaim(text = '') {
  const value = String(text || '');
  return /\b(?:main\s+ne|maine|mein\s+ne)\b[^.!?\n]{0,200}\b(?:add|update|change|remove|delete|clear|save|kar|kr|badal|hata|daal|dal)\s+(?:kar\s+)?(?:diya|di|diye|dia)\b/i.test(value)
    || /(?:میں\s*نے|मैंने)[^.!?\n]{0,160}(?:کر\s*دی[ایے]|بدل\s*دی[ایے]|حذف\s*کر\s*دی[ایے]|कर\s*दिया|बदल\s*दिया)/.test(value);
}

function isOrderPreviewOnlyRequest(text = '') {
  return /\b(?:show|tell|check|calculate|quote|preview|review)\b[^.!?\n]{0,65}\b(?:total|delivery|shipping|cost|price|charges)\b|\b(?:do not|don't|dont|not yet|without)\b[^.!?\n]{0,35}\b(?:place|placing|order|ordering|buy|buying)\b|\b(?:pehle|pehlay)\b[^.!?\n]{0,35}\b(?:total|price|qeemat|keemat)\b/i.test(text);
}

module.exports = { NATURAL_COMMERCE_ADDENDUM, sanitizeCommerceReply, isCartReplacementRequest, catalogLookupBeforeClarification, explicitlyClearsWholeCart, hasUnfinishedActionPromise, hasRomanUrduMutationClaim, isOrderPreviewOnlyRequest };
