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
        [{ role: 'user', content: 'Restore Fast shipping to inactive with 0 PKR and 2 days.' }],
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
    expect(__private.isUnbackedMutationClaim('You can restore it from Shipping.', request, [])).toBe(false);
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
        body: { messages: [{ role: 'user', content: 'Restore Fast shipping now.' }] },
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
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('exposes explicit supported currencies on every seller money-action schema', () => {
    const schemas = new Map(__private.getTools('seller').map((tool) => [tool.function.name, tool.function]));
    const supported = ['USD', 'PKR', 'EUR', 'GBP'];

    expect(schemas.get('bulk_discount').parameters.properties.currency.enum).toEqual(supported);
    expect(schemas.get('bulk_price_update').parameters.properties.currency.enum).toEqual(supported);
    expect(schemas.get('update_shipping').parameters.properties.currency.enum).toEqual(supported);
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
