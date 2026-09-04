process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

jest.mock('../../services/aiActionExecutor', () => ({
  executeToolCall: jest.fn(),
  isClientSideTool: jest.fn(),
  storeChangeLimits: jest.fn(),
  getDurableAIActionIntentKey: jest.fn((toolName, args) => (
    ['add_product', 'toggle_coupon', 'bulk_price_update'].includes(toolName)
      ? `${toolName}:${JSON.stringify(args || {})}`
      : null
  )),
  isDurableMutatingAITool: jest.fn(toolName => [
    'add_product',
    'toggle_coupon',
    'bulk_price_update',
    'update_shipping',
    'update_profile',
    'add_address',
  ].includes(toolName)),
}));
jest.mock('../../services/aiAttachmentService', () => ({
  processChatAttachments: jest.fn(),
  appendAttachmentContextToMessages: jest.fn(),
}));
jest.mock('../../services/aiChatRateLimitService', () => ({
  consumeDailyUsageForRequest: jest.fn(),
}));

const { consumeDailyUsageForRequest } = require('../../services/aiChatRateLimitService');
const { executeToolCall } = require('../../services/aiActionExecutor');
const {
  streamChat,
  chatOnce,
  processAIChatMessage,
  __private,
} = require('../../controllers/aiChatController');

const response = () => ({
  headersSent: false,
  setHeader: jest.fn(),
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('AI chat controller daily limit enforcement', () => {
  let consoleError;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('preserves an explicit inactive zero-cost shipping request when the model substitutes 0.01', () => {
    expect(__private.normalizeAIChatToolArgs(
      'update_shipping',
      { method: 'fast', cost: 0.01, deliveryDays: 2, isActive: false },
      'Set Fast inactive, exactly 0 PKR, with 2 delivery days.',
    )).toEqual({ method: 'fast', cost: 0, deliveryDays: 2, isActive: false });

    expect(__private.normalizeAIChatToolArgs(
      'update_shipping',
      { updates: { method: 'standard', cost: 0.01, isActive: true } },
      'Deactivate Standard and set its cost to zero.',
    )).toEqual({ updates: { method: 'standard', cost: 0, isActive: false } });

    expect(__private.normalizeAIChatToolArgs(
      'update_shipping',
      { method: 'fast', cost: 0.01, isActive: true },
      'Keep Fast active at 0.01 PKR.',
    )).toEqual({ method: 'fast', cost: 0.01, isActive: true });
  });

  it.each([
    ['stream', streamChat],
    ['once', chatOnce],
  ])('rejects an exhausted quota before the %s endpoint processes a message', async (_name, handler) => {
    consumeDailyUsageForRequest.mockResolvedValue({
      allowed: false,
      used: 5,
      limit: 5,
      remaining: 0,
      role: 'guest',
      resetAt: '2035-06-15T00:00:00.000Z',
    });
    const req = { body: { messages: [{ role: 'user', content: 'hello' }] }, ip: '203.0.113.40' };
    const res = response();

    await handler(req, res);

    expect(consumeDailyUsageForRequest).toHaveBeenCalledWith(req);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AI_DAILY_LIMIT_REACHED',
      used: 5,
      limit: 5,
      remaining: 0,
    }));
  });

  it('fails closed before chat processing when usage storage is unavailable', async () => {
    consumeDailyUsageForRequest.mockRejectedValue(new Error('database unavailable'));
    const res = response();

    await chatOnce({ body: {}, ip: '203.0.113.41' }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AI_USAGE_UNAVAILABLE',
    }));
  });

  it('uses an attached authoritative usage result without consuming again', async () => {
    const usage = {
      allowed: true,
      used: 1,
      limit: 5,
      remaining: 4,
      role: 'guest',
      resetAt: '2035-06-15T00:00:00.000Z',
    };
    const res = response();
    usage.allowed = false;

    await chatOnce({ body: {}, ip: '203.0.113.42', aiChatDailyUsage: usage }, res);

    expect(consumeDailyUsageForRequest).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it.each([
    ['stream', streamChat],
    ['once', chatOnce],
  ])('rejects an unsupported selected currency at the %s boundary', async (_name, handler) => {
    const req = {
      body: { currency: 'CAD', messages: [{ role: 'user', content: 'show prices' }] },
      ip: '203.0.113.43',
      aiChatDailyUsage: {
        allowed: true,
        used: 1,
        limit: 5,
        remaining: 4,
        role: 'guest',
        resetAt: '2035-06-15T00:00:00.000Z',
      },
    };
    const res = response();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHAT_CURRENCY_NOT_SUPPORTED',
    }));
  });

  it('passes a guest selected currency into server-side tool execution', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'tool-1',
                type: 'function',
                function: {
                  name: 'validate_coupon',
                  arguments: JSON.stringify({ code: 'SAVE10', cartTotal: 100 }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        }),
      });
    executeToolCall.mockResolvedValue({ success: true, data: { currency: 'PKR' } });

    try {
      await processAIChatMessage(
        { role: 'guest' },
        [{ role: 'user', content: 'Validate SAVE10 for my cart.' }],
        { mode: 'web', currency: 'PKR', requestKey: 'currency-test' },
      );
    } finally {
      global.fetch = originalFetch;
    }

    expect(executeToolCall).toHaveBeenCalledWith(
      'validate_coupon',
      expect.objectContaining({
        code: 'SAVE10',
        cartTotal: 100,
        // The raw client key is deliberately one-way hashed before it becomes
        // a durable tool-execution key.
        _chatRequestKey: expect.stringMatching(/^web:[a-f0-9]{64}$/),
        _chatToolOrdinal: 0,
      }),
      expect.objectContaining({ role: 'guest', currency: 'PKR' }),
    );
  });

  it('retries an unsupported mutation success claim and executes the real tool', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: "I've restored your Fast shipping method.",
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'shipping-1',
                type: 'function',
                function: {
                  name: 'update_shipping',
                  arguments: JSON.stringify({
                    method: 'fast',
                    cost: 0,
                    currency: 'PKR',
                    deliveryDays: 2,
                    isActive: false,
                  }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Fast shipping is now inactive.' } }],
        }),
      });
    global.fetch = fetchMock;
    executeToolCall.mockResolvedValue({ success: true, message: 'Shipping updated.' });

    try {
      const result = await processAIChatMessage(
        { role: 'seller' },
        [{ role: 'user', content: 'Use update_shipping now to restore Fast shipping to inactive with 0 PKR and 2 days.' }],
        { mode: 'whatsapp', currency: 'PKR', requestKey: 'mutation-integrity-retry' },
      );

      expect(result.responseText).toBe('Fast shipping is now inactive.');
      expect(result.toolResults).toEqual([
        expect.objectContaining({
          tool: 'update_shipping',
          result: expect.objectContaining({ success: true }),
        }),
      ]);
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initialRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retryRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    const summaryRequest = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(initialRequest.tool_choice).toEqual({ type: 'function', function: { name: 'update_shipping' } });
    expect(initialRequest.parallel_tool_calls).toBe(false);
    expect(initialRequest.tools.map(tool => tool.function.name)).toEqual(['update_shipping']);
    expect(retryRequest.tool_choice).toEqual({ type: 'function', function: { name: 'update_shipping' } });
    expect(retryRequest.tools.map(tool => tool.function.name)).toEqual(['update_shipping']);
    expect(summaryRequest).not.toHaveProperty('tool_choice');
    expect(summaryRequest).not.toHaveProperty('tools');
    expect(executeToolCall).toHaveBeenCalledWith(
      'update_shipping',
      expect.objectContaining({ method: 'fast', cost: 0, isActive: false }),
      expect.objectContaining({ role: 'seller', currency: 'PKR' }),
    );
  });

  it('detects a claimed mutation only when no successful durable result exists', () => {
    const text = "I've restored your Fast shipping method.";
    const request = 'Restore Fast shipping now.';

    expect(__private.isUnbackedMutationClaim(text, request, [])).toBe(true);
    expect(__private.isUnbackedMutationClaim(text, request, [{
      tool: 'update_shipping',
      result: { success: true },
    }])).toBe(false);
    expect(__private.isUnbackedMutationClaim(
      'Your store description has been updated.',
      'Restore my store description now.',
      [],
    )).toBe(true);
    expect(__private.isUnbackedMutationClaim(
      'Your coupon is now active.',
      'Activate my coupon.',
      [],
    )).toBe(true);
    expect(__private.isUnbackedMutationClaim(
      'No problem at all! Your display name has been updated back to "Rozare Mobile Buyer".',
      'Restore my display name using update_profile now.',
      [],
    )).toBe(true);
    expect(__private.isUnbackedMutationClaim('You can restore it from Shipping.', request, [])).toBe(false);
  });

  it('requires every explicitly named mutation tool to succeed in the current turn', () => {
    const tools = __private.getTools('user');
    const request = 'Use add_address now, then invoke update_profile to save my name. I confirm both.';

    expect(__private.explicitlyRequestedDurableMutationTools(request, tools))
      .toEqual(['add_address', 'update_profile']);
    expect(__private.missingExplicitDurableMutationTools(request, tools, [{
      tool: 'add_address',
      result: { success: true },
    }])).toEqual(['update_profile']);
    expect(__private.missingExplicitDurableMutationTools(request, tools, [
      { tool: 'add_address', result: { success: true } },
      { tool: 'update_profile', result: { success: true } },
    ])).toEqual([]);
    expect(__private.explicitlyRequestedDurableMutationTools(
      'Do not use update_profile; only explain what it does.',
      tools,
    )).toEqual([]);
  });

  it('requires every explicitly listed live read instead of allowing an answer from memory', () => {
    const tools = __private.getTools('user');
    const request = [
      'Call exactly these five live tools and report each result:',
      'get_my_profile, get_addresses, get_notifications, get_my_orders, and get_my_complaints.',
      'Do not infer or skip any.',
    ].join(' ');
    const requested = __private.explicitlyRequestedAITools(request, tools);

    expect(requested).toEqual(expect.arrayContaining([
      'get_my_profile',
      'get_addresses',
      'get_notifications',
      'get_my_orders',
      'get_my_complaints',
    ]));
    expect(requested).toHaveLength(5);
    expect(__private.missingExplicitAITools(request, tools, [{
      tool: 'get_my_profile',
      result: { success: true },
    }])).toEqual(expect.arrayContaining([
      'get_addresses',
      'get_notifications',
      'get_my_orders',
      'get_my_complaints',
    ]));
    expect(__private.explicitlyRequestedAITools(
      'What happens if I use update_profile?',
      tools,
    )).toEqual([]);
  });

  it('preserves the user-stated order for dependent explicit tools', () => {
    const tools = __private.getTools('user');
    const request = 'Call add_to_wishlist now, then call get_wishlist to verify the saved result.';
    const requested = __private.explicitlyRequestedAITools(request, tools);

    expect(requested).toEqual(['add_to_wishlist', 'get_wishlist']);
    expect(__private.explicitToolRequestOptions(requested, requested, tools)).toMatchObject({
      offeredTools: [expect.objectContaining({ function: expect.objectContaining({ name: 'add_to_wishlist' }) })],
      toolChoice: { type: 'function', function: { name: 'add_to_wishlist' } },
      parallelToolCalls: false,
    });
  });

  it('executes only one copy of the currently forced explicit tool', () => {
    const calls = [
      { id: 'orders-all', function: { name: 'get_my_orders', arguments: '{}' } },
      { id: 'orders-pending', function: { name: 'get_my_orders', arguments: '{"status":"pending"}' } },
      { id: 'wrong-tool', function: { name: 'get_addresses', arguments: '{}' } },
    ];

    expect(__private.constrainExplicitToolCalls(calls, 'get_my_orders')).toEqual([calls[0]]);
    expect(__private.constrainExplicitToolCalls(calls, 'get_addresses')).toEqual([calls[2]]);
    expect(__private.constrainExplicitToolCalls(calls, 'get_notifications')).toEqual([]);
    expect(__private.constrainExplicitToolCalls(calls, '')).toEqual(calls);
  });

  it('adds a current-turn-only grounding guard before a tool summary', () => {
    const messages = [{ role: 'user', content: 'Call get_wishlist.' }];
    const grounded = __private.messagesForCurrentTurnSummary(
      messages,
      [{ tool: 'get_wishlist', result: { success: true } }],
      [],
    );

    expect(grounded).toHaveLength(2);
    expect(grounded[1]).toMatchObject({ role: 'system' });
    expect(grounded[1].content).toContain('only the latest user message');
    expect(grounded[1].content).toContain('Do not recap');
  });

  it('uses an authoritative successful tool receipt when the model summary is empty', () => {
    const placed = {
      tool: 'place_order',
      result: {
        success: true,
        message: 'Order placed successfully! Order #ORD-1788546075206 — Rs1,990.00 PKR — Cash on Delivery',
      },
    };

    expect(__private.groundedAssistantResponseText('', [placed])).toBe(placed.result.message);
    expect(__private.groundedAssistantResponseText('The order is confirmed.', [placed]))
      .toBe('The order is confirmed.');
    expect(__private.groundedAssistantResponseText("Sorry, I couldn't process that.", [placed]))
      .toBe(placed.result.message);
  });

  it('builds explicit multi-tool summaries from the exact current receipts', () => {
    const summary = __private.explicitToolReceiptSummary(
      ['get_my_profile', 'add_address', 'get_addresses'],
      [
        { tool: 'get_my_profile', result: { success: true, message: 'Profile has 1 address.' } },
        { tool: 'add_address', result: { success: true, message: 'Address added.' } },
        { tool: 'get_addresses', result: { success: true, message: 'Profile has 2 addresses.' } },
      ],
    );

    expect(summary).toContain('**Get My Profile:** Profile has 1 address.');
    expect(summary).toContain('**Add Address:** Address added.');
    expect(summary).toContain('**Get Addresses:** Profile has 2 addresses.');
    expect(summary).not.toContain('Both live reads completed');
  });

  it('does not turn an empty failed tool receipt into a success claim', () => {
    expect(__private.groundedAssistantResponseText('', [{
      tool: 'place_order',
      result: { success: false, error: 'The delivery phone number is invalid.' },
    }])).toBe('The delivery phone number is invalid.');
  });

  it('attempts an explicitly requested failed tool once and reports its receipt', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'order-detail-1',
                type: 'function',
                function: {
                  name: 'get_order_detail',
                  arguments: JSON.stringify({ orderId: 'ORD-1788546075206' }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }),
      });
    global.fetch = fetchMock;
    executeToolCall.mockResolvedValue({ success: false, error: 'Order not found or access denied.' });
    const res = response();

    try {
      await chatOnce({
        body: {
          source: 'mobile',
          messages: [{
            role: 'user',
            content: 'Use get_order_detail now for order ORD-1788546075206.',
          }],
        },
        headers: { 'idempotency-key': 'mobile-order-detail-failure-key' },
        user: { role: 'user' },
        aiChatDailyUsage: { allowed: true, used: 0, limit: 20, remaining: 19, role: 'user' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ content: 'Order not found or access denied.' }),
      toolResults: [expect.objectContaining({ tool: 'get_order_detail' })],
    }));
  });

  it('returns the successful mobile mutation receipt when the final model message is empty', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'address-add-1',
                type: 'function',
                function: {
                  name: 'add_address',
                  arguments: JSON.stringify({
                    address: { fullName: 'Buyer QA', address: '1 Test Road', city: 'Islamabad' },
                  }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }),
      });
    global.fetch = fetchMock;
    executeToolCall.mockResolvedValue({ success: true, message: 'New address "Home" added successfully!' });
    const res = response();

    try {
      await chatOnce({
        body: { source: 'mobile', messages: [{ role: 'user', content: 'Add this address now.' }] },
        headers: { 'idempotency-key': 'mobile-empty-summary-key' },
        user: { role: 'user' },
        aiChatDailyUsage: { allowed: true, used: 0, limit: 20, remaining: 19, role: 'user' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ content: 'New address "Home" added successfully!' }),
      toolResults: [expect.objectContaining({
        tool: 'add_address',
        result: expect.objectContaining({ success: true }),
      })],
    }));
  });

  it('forces every explicitly requested mobile tool and only summarizes after completion', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'profile-read-1',
                type: 'function',
                function: { name: 'get_my_profile', arguments: '{}' },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'addresses-read-1',
                type: 'function',
                function: { name: 'get_addresses', arguments: '{}' },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Both live reads completed.' } }],
        }),
      });
    global.fetch = fetchMock;
    executeToolCall
      .mockResolvedValueOnce({ success: true, data: { name: 'Buyer QA' } })
      .mockResolvedValueOnce({ success: true, data: [] });
    const res = response();

    try {
      await chatOnce({
        body: {
          source: 'mobile',
          messages: [{
            role: 'user',
            content: 'Call exactly get_my_profile and get_addresses now, then report both live results.',
          }],
        },
        headers: { 'idempotency-key': 'mobile-explicit-read-key' },
        user: { role: 'user' },
        aiChatDailyUsage: { allowed: true, used: 0, limit: 20, remaining: 19, role: 'user' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initialRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
    const remainingRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    const summaryRequest = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(initialRequest.tool_choice).toEqual({ type: 'function', function: { name: 'get_my_profile' } });
    expect(initialRequest.parallel_tool_calls).toBe(false);
    expect(initialRequest.tools.map(tool => tool.function.name)).toEqual(['get_my_profile']);
    expect(remainingRequest.tool_choice).toEqual({ type: 'function', function: { name: 'get_addresses' } });
    expect(remainingRequest.tools.map(tool => tool.function.name)).toEqual(['get_addresses']);
    expect(summaryRequest).not.toHaveProperty('tool_choice');
    expect(summaryRequest).not.toHaveProperty('tools');
    expect(executeToolCall).toHaveBeenNthCalledWith(
      1,
      'get_my_profile',
      expect.objectContaining({ _chatToolOrdinal: 0 }),
      expect.objectContaining({ role: 'user' }),
    );
    expect(executeToolCall).toHaveBeenNthCalledWith(
      2,
      'get_addresses',
      expect.objectContaining({ _chatToolOrdinal: 0 }),
      expect.objectContaining({ role: 'user' }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        content: [
          'Here are the exact results:',
          '- **Get My Profile:** Completed.',
          '- **Get Addresses:** Completed.',
        ].join('\n'),
      }),
      toolResults: expect.arrayContaining([
        expect.objectContaining({ tool: 'get_my_profile' }),
        expect.objectContaining({ tool: 'get_addresses' }),
      ]),
    }));
  });

  it('normalizes AI navigation to real role-scoped routes', () => {
    expect(__private.normalizeAIClientRoute('/seller-dashboard/products', 'seller'))
      .toBe('/seller-dashboard/product-management');
    expect(__private.normalizeAIClientRoute('/seller-dashboard/orders', 'seller'))
      .toBe('/seller-dashboard/order-management');
    expect(__private.normalizeAIClientRoute('/seller-dashboard/not-a-page', 'seller'))
      .toBe('/seller-dashboard');
    expect(__private.normalizeAIClientRoute('/admin-dashboard/user-management', 'seller'))
      .toBe('/seller-dashboard');
    expect(__private.normalizeAIClientRoute('https://outside.example/seller-dashboard/products', 'seller'))
      .toBe('/seller-dashboard/product-management');
    expect(__private.normalizeAIClientRoute('/user-dashboard/orders', 'user'))
      .toBe('/user-dashboard/orders');
  });

  it('assigns stable mutation slots across read reordering and repeated identical calls', () => {
    const slot = __private.createDurableMutationSlotAllocator();
    const addArgs = { name: 'One product', price: 10 };

    expect(slot('search_products', { query: 'bag' })).toBe(0);
    expect(slot('add_product', addArgs)).toBe(0);
    expect(slot('get_my_coupons', {})).toBe(0);
    expect(slot('add_product', { ...addArgs })).toBe(0);
    expect(slot('toggle_coupon', { couponId: 'coupon-1' })).toBe(1);

    const retryWithoutReads = __private.createDurableMutationSlotAllocator();
    expect(retryWithoutReads('add_product', addArgs)).toBe(0);
    expect(retryWithoutReads('toggle_coupon', { couponId: 'coupon-1' })).toBe(1);
  });

  it('returns HTTP 409 and retainAttempt when a once mutation receipt is pending', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'toggle-1',
              type: 'function',
              function: {
                name: 'toggle_coupon',
                arguments: JSON.stringify({ couponId: '64b000000000000000000001' }),
              },
            }],
          },
        }],
      }),
    });
    executeToolCall.mockResolvedValue({
      success: false,
      code: 'AI_ACTION_PENDING',
      error: 'The mutation result is still pending.',
    });
    const res = response();

    try {
      await chatOnce({
        body: { messages: [{ role: 'user', content: 'Toggle that coupon.' }] },
        headers: { 'idempotency-key': 'pending-once-key' },
        user: { role: 'seller' },
        aiChatDailyUsage: { allowed: true, used: 0, limit: -1, remaining: -1, role: 'seller' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AI_ACTION_PENDING',
      retryable: true,
      retainAttempt: true,
      tool: 'toggle_coupon',
    }));
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('fails a once mutation closed when the caller did not supply a reusable request key', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'toggle-without-key',
              type: 'function',
              function: {
                name: 'toggle_coupon',
                arguments: JSON.stringify({ couponId: '64b000000000000000000001' }),
              },
            }],
          },
        }],
      }),
    });
    executeToolCall.mockImplementation(async (_toolName, args) => ({
      success: false,
      code: args._chatRequestKey
        ? 'UNEXPECTED_TEST_KEY'
        : 'AI_ACTION_IDEMPOTENCY_REQUIRED',
      error: 'A reusable Idempotency-Key is required.',
    }));
    const res = response();

    try {
      await chatOnce({
        body: { messages: [{ role: 'user', content: 'Toggle that coupon.' }] },
        headers: {},
        user: { role: 'seller' },
        aiChatDailyUsage: { allowed: true, used: 0, limit: -1, remaining: -1, role: 'seller' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    expect(executeToolCall).toHaveBeenCalledWith(
      'toggle_coupon',
      expect.objectContaining({ _chatRequestKey: '' }),
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AI_ACTION_IDEMPOTENCY_REQUIRED',
      retryable: true,
      retainAttempt: false,
    }));
  });

  it('ends SSE with a request_error and no DONE marker when a mutation receipt is pending', async () => {
    const originalFetch = global.fetch;
    const encoder = new TextEncoder();
    const streamPayload = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'toggle-stream-1',
        function: {
          name: 'toggle_coupon',
          arguments: JSON.stringify({ couponId: '64b000000000000000000001' }),
        },
      }] } }] })}\n`,
      'data: [DONE]\n',
    ].join('');
    let read = false;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest.fn(async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: encoder.encode(streamPayload) };
          }),
          cancel: jest.fn(),
        }),
      },
    });
    executeToolCall.mockResolvedValue({
      success: false,
      code: 'AI_ACTION_PENDING',
      error: 'The mutation result is still pending.',
    });
    const res = {
      ...response(),
      writableEnded: false,
      destroyed: false,
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(function end() { this.writableEnded = true; }),
    };

    try {
      await streamChat({
        body: { messages: [{ role: 'user', content: 'Toggle that coupon.' }] },
        headers: { 'idempotency-key': 'pending-stream-key' },
        user: { role: 'seller' },
        on: jest.fn(),
        aiChatDailyUsage: { allowed: true, used: 0, limit: -1, remaining: -1, role: 'seller' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(output).toContain('"type":"request_error"');
    expect(output).toContain('"retainAttempt":true');
    expect(output).not.toContain('data: [DONE]');
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('ends a stalled streaming provider request with a bounded user-facing timeout', async () => {
    const originalFetch = global.fetch;
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const res = {
      ...response(),
      writableEnded: false,
      destroyed: false,
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(function end() { this.writableEnded = true; }),
    };

    try {
      const pending = streamChat({
        body: { messages: [{ role: 'user', content: 'Show my wishlist.' }] },
        headers: { 'idempotency-key': 'stalled-stream-request' },
        user: { role: 'user' },
        on: jest.fn(),
        aiChatDailyUsage: { allowed: true, used: 1, limit: 20, remaining: 19, role: 'user' },
      }, res);
      await jest.advanceTimersByTimeAsync(60001);
      await pending;
    } finally {
      global.fetch = originalFetch;
      jest.useRealTimers();
    }

    const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(output).toContain('AI service timed out. Please try again.');
    expect(output).toContain('data: [DONE]');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('ends SSE without DONE when a mutation has no caller-supplied request key', async () => {
    const originalFetch = global.fetch;
    const encoder = new TextEncoder();
    const streamPayload = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'toggle-stream-without-key',
        function: {
          name: 'toggle_coupon',
          arguments: JSON.stringify({ couponId: '64b000000000000000000001' }),
        },
      }] } }] })}\n`,
      'data: [DONE]\n',
    ].join('');
    let read = false;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest.fn(async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: encoder.encode(streamPayload) };
          }),
          cancel: jest.fn(),
        }),
      },
    });
    executeToolCall.mockResolvedValue({
      success: false,
      code: 'AI_ACTION_IDEMPOTENCY_REQUIRED',
      error: 'A reusable Idempotency-Key is required.',
    });
    const res = {
      ...response(),
      writableEnded: false,
      destroyed: false,
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(function end() { this.writableEnded = true; }),
    };

    try {
      await streamChat({
        body: { messages: [{ role: 'user', content: 'Toggle that coupon.' }] },
        headers: {},
        user: { role: 'seller' },
        on: jest.fn(),
        aiChatDailyUsage: { allowed: true, used: 0, limit: -1, remaining: -1, role: 'seller' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(output).toContain('"type":"request_error"');
    expect(output).toContain('"code":"AI_ACTION_IDEMPOTENCY_REQUIRED"');
    expect(output).toContain('"retainAttempt":false');
    expect(output).not.toContain('data: [DONE]');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('does not stream an unsupported mutation claim and retries through the real action', async () => {
    const originalFetch = global.fetch;
    const encoder = new TextEncoder();
    const streamResponse = (events) => {
      let read = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn(async () => {
              if (read) return { done: true, value: undefined };
              read = true;
              return {
                done: false,
                value: encoder.encode(`${events.join('\n')}\ndata: [DONE]\n`),
              };
            }),
            cancel: jest.fn(),
          }),
        },
      };
    };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "I've restored your Fast shipping method." } }] })}`,
      ]))
      .mockResolvedValueOnce(streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: 'shipping-stream-1',
          function: {
            name: 'update_shipping',
            arguments: JSON.stringify({ method: 'fast', cost: 0, currency: 'PKR', deliveryDays: 2, isActive: false }),
          },
        }] } }] })}`,
      ]))
      .mockResolvedValueOnce(streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Fast shipping is now inactive.' } }] })}`,
      ]));
    global.fetch = fetchMock;
    executeToolCall.mockResolvedValue({ success: true, message: 'Shipping updated.' });
    const res = {
      ...response(),
      writableEnded: false,
      destroyed: false,
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(function end() { this.writableEnded = true; }),
    };

    try {
      await streamChat({
        body: { messages: [{ role: 'user', content: 'Use update_shipping now to restore Fast shipping.' }] },
        headers: { 'idempotency-key': 'stream-mutation-integrity' },
        user: { role: 'seller' },
        on: jest.fn(),
        aiChatDailyUsage: { allowed: true, used: 0, limit: -1, remaining: -1, role: 'seller' },
      }, res);
    } finally {
      global.fetch = originalFetch;
    }

    const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(output).not.toContain("I've restored your Fast shipping method.");
    expect(output).toContain('Fast shipping is now inactive.');
    expect(output).toContain('"type":"tool_result"');
    expect(output).toContain('data: [DONE]');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initialRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
    const retryRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    const summaryRequest = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(initialRequest.tool_choice).toEqual({ type: 'function', function: { name: 'update_shipping' } });
    expect(initialRequest.parallel_tool_calls).toBe(false);
    expect(initialRequest.tools.map(tool => tool.function.name)).toEqual(['update_shipping']);
    expect(retryRequest.tool_choice).toEqual({ type: 'function', function: { name: 'update_shipping' } });
    expect(retryRequest.tools.map(tool => tool.function.name)).toEqual(['update_shipping']);
    expect(summaryRequest).not.toHaveProperty('tool_choice');
    expect(summaryRequest).not.toHaveProperty('tools');
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('exposes explicit supported currencies on every seller money-action schema', () => {
    const schemas = new Map(__private.getTools('seller').map((tool) => [tool.function.name, tool.function]));
    const supported = ['USD', 'PKR', 'EUR', 'GBP'];

    expect(schemas.get('bulk_discount').parameters.properties.currency.enum).toEqual(supported);
    expect(schemas.get('bulk_price_update').parameters.properties.currency.enum).toEqual(supported);
    expect(schemas.get('update_shipping').parameters.properties.currency.enum).toEqual(supported);
    expect(schemas.get('update_shipping').description).toContain('inactive paid method may use 0');
    expect(schemas.get('update_shipping').parameters.properties.cost).toMatchObject({
      type: 'number',
      minimum: 0,
    });
    expect(schemas.get('update_shipping').parameters.properties.cost.description).toContain('Send 0 unchanged');
    expect(schemas.get('update_profile').parameters.properties.updates.properties.currency.enum).toEqual(supported);
    expect(schemas.get('update_profile').parameters.properties.updates.additionalProperties).toBe(false);
    expect(schemas.get('get_order_detail').parameters.properties.orderId.description).toContain('Public ORD- number');
    expect(schemas.get('cancel_order').parameters.properties.orderId.description).toContain('Public ORD- number');
    expect(schemas.get('send_product_image').description).toContain('web and mobile display a rich image card');
    expect(schemas.get('create_coupon').parameters.properties.coupon.properties.currency.enum).toEqual(supported);
    expect(schemas.get('update_coupon').parameters.properties.updates.properties.currency.enum).toEqual(supported);
  });

  it('gives every role live catalog access and gives sellers the complete status tool', () => {
    const guestTools = new Map(__private.getTools('guest').map(tool => [tool.function.name, tool.function]));
    const userTools = new Map(__private.getTools('user').map(tool => [tool.function.name, tool.function]));
    const sellerTools = new Map(__private.getTools('seller').map(tool => [tool.function.name, tool.function]));

    expect(guestTools.has('get_subscription_catalog')).toBe(true);
    expect(userTools.has('get_subscription_catalog')).toBe(true);
    expect(sellerTools.get('get_subscription_status').description).toContain('complete live subscription truth');
    expect(sellerTools.get('get_subscription_status').description).toContain('bonus expiry or grace');
  });
});

describe('AI chat persisted money context integrity', () => {
  it('uses USD only for missing legacy currency and rejects corrupt present codes', () => {
    expect(__private.requireAIContextCurrency(undefined)).toBe('USD');
    expect(__private.requireAIContextCurrency(null)).toBe('USD');
    expect(__private.requireAIContextCurrency('PKR')).toBe('PKR');
    for (const value of ['', 'usd', ' USD ', 'CAD', false]) {
      expect(() => __private.requireAIContextCurrency(value)).toThrow(
        expect.objectContaining({ code: 'AI_CONTEXT_DATA_INVALID' })
      );
    }
  });

  it('rejects missing, coercible, non-finite, negative, and sub-cent order totals', () => {
    expect(__private.requireAIContextMoney(0, 'order total')).toBe(0);
    expect(__private.requireAIContextMoney(10.01, 'order total')).toBe(10.01);
    for (const value of [undefined, null, '', '10', false, Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.004]) {
      expect(() => __private.requireAIContextMoney(value, 'order total')).toThrow(
        expect.objectContaining({ code: 'AI_CONTEXT_DATA_INVALID' })
      );
    }
  });

  it('formats recent orders only from already validated amount and currency', () => {
    expect(__private.formatContextBlock({
      role: 'user',
      recentOrders: [{ orderId: 'A-1', items: ['Bag'], status: 'confirmed', total: 10, currency: 'PKR' }],
    }, 'user')).toContain('PKR');
    expect(() => __private.formatContextBlock({
      role: 'user',
      recentOrders: [{ orderId: 'A-2', items: ['Bag'], status: 'confirmed', total: '', currency: 'USD' }],
    }, 'user')).toThrow(expect.objectContaining({ code: 'AI_CONTEXT_DATA_INVALID' }));
  });
});
