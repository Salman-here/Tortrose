import * as Crypto from 'expo-crypto';

export const chatActorKey = user => String(user?._id || user?.id || 'guest');
export const createAIChatHandoff = (prompt, user, source) => ({ id: Crypto.randomUUID(), prompt, actorKey: chatActorKey(user), source });
export const buildCartAIChatPrompt = lines => {
  const items = (Array.isArray(lines) ? lines : []).slice(0, 20).map(line => {
    const product = line.product || {}, options = Object.entries(line.selectedOptions || {}).map(([key, value]) => `${key}: ${value}`).join(', ');
    return `${product.name || 'Product'} — quantity ${line.qty || 1}${options ? `, ${options}` : line.selectedColor ? `, Color: ${line.selectedColor}` : ''}. Product reference: ${product._id || line.productId || ''}`;
  });
  return `Help me review my shopping cart and answer any questions about these items. Check current listing details when needed. Do not change my cart or place an order unless I ask.\n${items.join('\n')}`;
};
