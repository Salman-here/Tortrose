import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProductAIChatPrompt } from '../src/utils/aiChatLauncher.js';

test('builds mobile-parity product context for the floating AI chat', () => {
  const prompt = buildProductAIChatPrompt({
    product: {
      _id: 'product-1',
      name: 'Premium overshirt',
      optionGroups: [
        { name: 'Size', values: ['Small', 'Large'] },
        { name: 'Material', values: ['Cotton'] },
      ],
    },
    storeName: 'North Studio',
    formattedPrice: '$89.00',
  });

  assert.equal(
    prompt,
    'I\'m viewing "Premium overshirt" from North Studio for $89.00. It has Size, Material options. Help me decide if it suits my needs, explain the important details, and suggest alternatives if useful.',
  );
});

test('uses legacy colors and remains useful when price or store is unavailable', () => {
  assert.equal(
    buildProductAIChatPrompt({
      product: { name: 'Travel cap', colors: ['Black', 'Stone'] },
    }),
    'I\'m viewing "Travel cap". It is available in Black, Stone. Help me decide if it suits my needs, explain the important details, and suggest alternatives if useful.',
  );
});
