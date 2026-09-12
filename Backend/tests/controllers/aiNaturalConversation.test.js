'use strict';
process.env.OPENROUTER_API_KEY = 'natural-conversation-test';
jest.mock('../../services/aiActionExecutor', () => ({
  executeToolCall: jest.fn(), isClientSideTool: () => false, storeChangeLimits: jest.fn(),
  getDurableAIActionIntentKey: () => null, isDurableMutatingAITool: tool => ['add_to_cart', 'update_cart_item', 'edit_product'].includes(tool),
}));
jest.mock('../../services/aiAttachmentService', () => ({ processChatAttachments: jest.fn(), appendAttachmentContextToMessages: jest.fn() }));
jest.mock('../../services/aiChatRateLimitService', () => ({ consumeDailyUsageForRequest: jest.fn() }));
const { executeToolCall } = require('../../services/aiActionExecutor');
const { streamChat, chatOnce, processAIChatMessage } = require('../../controllers/aiChatController');

function upstream(message, streaming) {
  if (!streaming) return { ok: true, json: async () => ({ choices: [{ message }] }) };
  let consumed = false;
  return { ok: true, body: { getReader: () => ({ read: async () => {
    if (consumed) return { done: true };
    consumed = true;
    const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
    return { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\ndata: [DONE]\n`) };
  }, cancel: jest.fn() }) } };
}

const toolMessage = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
async function runChannel(channel, text, messages) {
  const fetchMock = jest.fn();
  messages.forEach(message => fetchMock.mockResolvedValueOnce(upstream(message, channel === 'web')));
  const oldFetch = global.fetch;
  global.fetch = fetchMock;
  const res = {
    setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn(),
    writableEnded: false, destroyed: false, flushHeaders: jest.fn(), write: jest.fn(),
    end: jest.fn(function () { this.writableEnded = true; }),
  };
  const req = { body: { messages: [{ role: 'user', content: text }] }, headers: { 'idempotency-key': 'natural-request-test' }, user: { role: 'seller' }, on: jest.fn(), aiChatDailyUsage: { allowed: true, limit: -1, remaining: -1 } };
  let result;
  try {
    if (channel === 'whatsapp') result = await processAIChatMessage(req.user, req.body.messages, { mode: 'whatsapp', requestKey: 'natural-request-test' });
    else if (channel === 'mobile') await chatOnce(req, res);
    else await streamChat(req, res);
  } finally { global.fetch = oldFetch; }
  let visible;
  if (channel === 'whatsapp') visible = result.responseText;
  else if (channel === 'mobile') visible = res.json.mock.calls[0]?.[0]?.message?.content;
  else visible = res.write.mock.calls.flatMap(([chunk]) => String(chunk).split('\n'))
    .filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    .map(event => event.choices?.[0]?.delta?.content || '').join('');
  return { visible, requests: fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body)) };
}

beforeEach(() => jest.clearAllMocks());

test.each(['web', 'mobile', 'whatsapp'])('%s always includes the actual product conversion disclosure even when model prose omits it', async channel => {
  const disclosure = 'Your store uses PKR. You supplied $10.00 USD; I converted it to Rs2,800.00 PKR and saved that as the product price. Your store currency remains PKR.';
  executeToolCall.mockResolvedValue({ success: true, message: 'Product updated.', requiredDisclosure: disclosure, data: { name: 'Travel Cup', price: 2800, currency: 'PKR' } });
  const result = await runChannel(channel, 'make my travel cup ten dollars please', [
    toolMessage('edit_product', { productName: 'Travel Cup', updates: { price: 10, currency: 'USD' } }),
    { role: 'assistant', content: 'Done.' },
  ]);
  expect(result.visible).toContain(disclosure);
  expect(result.visible).toContain('Product updated.');
  expect(result.visible.split(disclosure)).toHaveLength(2);
});

test.each(['web', 'mobile', 'whatsapp'])('%s uses authoritative currency facts instead of duplicate or contradictory model pricing prose', async channel => {
  const disclosure = 'Your store uses PKR. You supplied $10.00 USD; I converted it to Rs2,800.00 PKR. Your store currency remains PKR.';
  executeToolCall.mockResolvedValue({ success: true, message: disclosure, requiredDisclosure: disclosure, data: { name: 'Travel Cup', price: 2800, currency: 'PKR' } });
  const result = await runChannel(channel, 'make my travel cup ten dollars please', [
    toolMessage('edit_product', { productName: 'Travel Cup', updates: { price: 10, currency: 'USD' } }),
    { role: 'assistant', content: 'Done, your store is now USD and the cup costs 999 USD.' },
  ]);
  expect(result.visible).toBe(disclosure);
});

test.each(['web', 'mobile', 'whatsapp'])('%s always shows store-wide conversion consequences and sixty-day wait before confirmation', async channel => {
  const notice = 'Change store currency from PKR to USD? All 3 product prices will be converted and saved. You cannot change it again for 60 days. Past orders and balances stay unchanged. Confirm or say no.';
  executeToolCall.mockResolvedValue({ success: true, previewOnly: true, requiresConfirmation: true, requiredDisclosure: notice, message: notice, data: { quoteToken: `aic1.${'a'.repeat(64)}`, targetCurrency: 'USD', cooldownDays: 60 } });
  const result = await runChannel(channel, 'I want USD for my store long term', [
    toolMessage('preview_store_currency_change', { currency: 'USD' }),
    { role: 'assistant', content: 'Would you like to proceed?' },
  ]);
  expect(result.visible).toContain(notice);
  expect(result.visible).not.toContain('aic1.');
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(result.requests.at(-1).messages.filter(message => message.role === 'tool').every(message => !message.content.includes('aic1.'))).toBe(true);
});

test.each(['web', 'mobile', 'whatsapp'])('%s searches before asking for an exact name and does not leak IDs in the reply', async channel => {
  executeToolCall.mockResolvedValue({ success: true, data: { products: [{ _id: '6a9b77adb0befe27bd10f25d', name: 'Alpine Vacuum Lunch Jar', stock: 16 }] }, message: 'Found one product.' });
  const result = await runChannel(channel, 'can you find my lunch jarr and tell me the stock?', [
    { role: 'assistant', content: 'Could you provide the exact product name or a more specific description?' },
    toolMessage('list_my_products', { search: 'lunch jar' }),
    { role: 'assistant', content: 'Alpine Vacuum Lunch Jar has 16 in stock.\nProduct ID: 6a9b77adb0befe27bd10f25d' },
  ]);
  expect(result.requests).toHaveLength(3);
  expect(result.requests[1].tool_choice).toEqual({ type: 'function', function: { name: 'list_my_products' } });
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(result.visible).toBe('Alpine Vacuum Lunch Jar has 16 in stock.');
  expect(result.requests[2].messages.some(message => message.role === 'tool' && message.content.includes('6a9b77adb0befe27bd10f25d'))).toBe(true);
});

test.each(['web', 'mobile', 'whatsapp'])('%s can continue from a cart read to the requested update before replying', async channel => {
  executeToolCall.mockResolvedValueOnce({ success: true, data: { items: [{ cartItemId: '6a9b77adb0befe27bd10f25d', selectedColor: 'Black', quantity: 1 }] }, message: 'One Black mug in cart.' })
    .mockResolvedValueOnce({ success: true, message: 'Changed the mug to Silver, quantity 1.' });
  const result = await runChannel(channel, 'make the mug silver instead, still just one', [
    toolMessage('view_cart', {}),
    toolMessage('update_cart_item', { cartItemId: '6a9b77adb0befe27bd10f25d', selectedColor: 'Silver' }),
    { role: 'assistant', content: 'Your mug is now Silver, still quantity 1.' },
  ]);
  expect(result.requests[1].messages.at(-1).content).toContain('Call any remaining necessary tools');
  expect(result.requests[1].tools.some(tool => tool.function.name === 'update_cart_item')).toBe(true);
  expect(executeToolCall).toHaveBeenCalledTimes(2);
  expect(result.visible).toBe('Your mug is now Silver, still quantity 1.');
});

test.each(['web', 'mobile', 'whatsapp'])('%s does not end with an unexecuted action promise after a short option answer', async channel => {
  executeToolCall.mockResolvedValue({ success: true, message: 'Added one Black 500ml mug to the cart.' });
  const result = await runChannel(channel, 'black, the bigger one', [
    { role: 'assistant', content: 'Got it! Adding the Black 500ml mug to your cart now. Just a moment!' },
    toolMessage('add_to_cart', { productName: 'Aurora Thermal Travel Mug', quantity: 1, selectedOptions: { Color: 'Black', Capacity: '500ml' } }),
    { role: 'assistant', content: "I've added one Black 500ml mug to your cart." },
  ]);
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(result.visible).toBe("I've added one Black 500ml mug to your cart.");
  expect(result.requests[1].messages.at(-1).content).toContain('this response ends the turn');
});

test.each(['web', 'mobile', 'whatsapp'])('%s bounds unfinished-action retries and does not count a read as a completed change', async channel => {
  executeToolCall.mockResolvedValue({ success: true, message: 'Your cart is empty.' });
  const promise = { role: 'assistant', content: "I'll add the mug to your cart now." };
  const result = await runChannel(channel, 'black, the bigger one', [
    toolMessage('view_cart', {}), promise, promise, promise,
  ]);
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(result.requests).toHaveLength(4);
  expect(result.visible).toContain('Your cart is empty.');
  expect(result.visible).toContain('The requested change is not confirmed.');
  expect(result.visible).not.toContain("I'll add");
});

test.each(['web', 'mobile', 'whatsapp'])('%s completes a Roman Urdu correction instead of returning a progress promise', async channel => {
  executeToolCall.mockResolvedValue({ success: true, message: 'Updated one Black 350ml mug; the lunch jar is unchanged.' });
  const result = await runChannel(channel, 'meri cart mein aurora mug ko black kar do, chota size wahi rakho aur sirf ek mug. jar ko mat badalna', [
    { role: 'assistant', content: 'Main aapki cart mein Aurora mug ko black color mein update kar rahi hoon. Ek minute dijiye, main yeh kar deti hoon.' },
    toolMessage('update_cart_item', { productName: 'Aurora Thermal Travel Mug', selectedColor: 'Black', quantity: 1 }),
    { role: 'assistant', content: 'Maine mug ko Black kar diya hai. Size 350ml, quantity 1, aur jar wahi hai.' },
  ]);
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(result.visible).toContain('Maine mug ko Black kar diya hai.');
});

test.each(['web', 'mobile', 'whatsapp'])('%s requires an action receipt for a Roman Urdu completion claim', async channel => {
  executeToolCall.mockResolvedValue({ success: true, message: 'Updated one Black mug.' });
  const claim = { role: 'assistant', content: 'Maine mug ko Black kar diya hai.' };
  const result = await runChannel(channel, 'black kar do', [
    claim,
    toolMessage('update_cart_item', { productName: 'Aurora Thermal Travel Mug', selectedColor: 'Black' }),
    claim,
  ]);
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(result.requests).toHaveLength(3);
  expect(result.visible).toBe(claim.content);
});

test.each(['web', 'mobile', 'whatsapp'])('%s requires the preview guard and can clearly say no order was placed', async channel => {
  executeToolCall.mockResolvedValue({ success: true, data: { preview: true, summary: { totalAmount: 3939.5 } }, message: 'Order preview only. Total Rs3939.50. No order has been placed.' });
  const reply = 'I have not placed your order. Your delivered total is Rs3939.50. Shall I place it?';
  const result = await runChannel(channel, 'show me the delivered total first', [
    toolMessage('preview_order', { productName: 'Aurora Thermal Travel Mug' }),
    { role: 'assistant', content: reply },
  ]);
  expect(executeToolCall).toHaveBeenCalledTimes(1);
  expect(executeToolCall.mock.calls[0][1]._requireOrderPreview).toBe(true);
  expect(result.visible).toBe(reply);
});

test.each(['web', 'mobile', 'whatsapp'])('%s enforces seller input evidence even if a model tries to disable the guard', async channel => {
  executeToolCall.mockResolvedValue({ success: false, blocked: true, needsSellerInput: true, error: 'Please provide the selling price and stock quantity.' });
  const result = await runChannel(channel, 'For testing add this cup to my store and write a description', [
    toolMessage('add_product', { name: 'Cedar Trail Cup', price: 10, stock: 10, _requireExplicitSellerInputs: false }),
    { role: 'assistant', content: 'What selling price and stock quantity should I use?' },
  ]);
  expect(executeToolCall.mock.calls[0][1]._requireExplicitSellerInputs).toBe(true);
  expect(result.visible).toBe('What selling price and stock quantity should I use?');
});

test.each(['web', 'mobile', 'whatsapp'])('%s supplies the real server clock for relative dates and immediate coupon starts', async channel => {
  const before = Date.now();
  const result = await runChannel(channel, 'what date is it today?', [{ role: 'assistant', content: 'I can use the current server date.' }]);
  const system = result.requests[0].messages.find(message => message.role === 'system').content;
  const timestamp = system.match(/Current server time \(UTC\): ([0-9T:.-]+Z)/)?.[1];
  expect(timestamp).toBeTruthy();
  expect(new Date(timestamp).getTime()).toBeGreaterThanOrEqual(before);
  expect(new Date(timestamp).getTime()).toBeLessThanOrEqual(Date.now());
  expect(system).toContain('omit startDate so the server sets the actual current time');
});
