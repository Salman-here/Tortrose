export const OPEN_AI_CHAT_EVENT = 'rozare:open-ai-chat';

const cleanText = (value) => String(value || '').trim();

export const buildProductAIChatPrompt = ({
  product,
  storeName = '',
  formattedPrice = '',
} = {}) => {
  const productName = cleanText(product?.name) || 'this product';
  const sellerName = cleanText(storeName);
  const price = cleanText(formattedPrice);
  const optionNames = (Array.isArray(product?.optionGroups) ? product.optionGroups : [])
    .map((group) => cleanText(group?.name))
    .filter(Boolean);
  const colors = (Array.isArray(product?.colors) ? product.colors : [])
    .map(cleanText)
    .filter(Boolean);

  const storeNote = sellerName ? ` from ${sellerName}` : '';
  const priceNote = price ? ` for ${price}` : '';
  const optionsNote = optionNames.length
    ? ` It has ${optionNames.join(', ')} options.`
    : colors.length
      ? ` It is available in ${colors.join(', ')}.`
      : '';

  return `I'm viewing "${productName}"${storeNote}${priceNote}.${optionsNote} Help me decide if it suits my needs, explain the important details, and suggest alternatives if useful.`;
};

export const openAIChat = ({ prompt = '', productId = null } = {}) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;

  window.dispatchEvent(new CustomEvent(OPEN_AI_CHAT_EVENT, {
    detail: {
      prompt: cleanText(prompt),
      productId: productId ? String(productId) : null,
      source: 'product-detail',
    },
  }));
  return true;
};
