process.env.OPENROUTER_API_KEY = 'tool-surface-contract-test';

const fs = require('fs');
const path = require('path');
const { CLIENT_SIDE_TOOLS } = require('../../services/aiActionExecutor');
const { collectAIPriceCandidates } = require('../../services/aiActionExecutor').__private;
const { NEW_COMMERCE_TOOL_NAMES } = require('../../services/aiCommerceTools');
const { __private } = require('../../controllers/aiChatController');

const toolNamesFor = role => __private.getTools(role).map(tool => tool.function.name);

describe('AI role tool surface contract', () => {
  test('price ordering considers matches after the former 300-product cutoff with bounded retained candidates', async () => {
    const rows = Array.from({ length: 321 }, (_, index) => ({ id: index, price: index === 320 ? 1 : 100 + index }));
    const cursor = { async *[Symbol.asyncIterator]() { yield* rows; }, close: jest.fn() };
    const selected = await collectAIPriceCandidates(cursor, async batch => batch.sort((a, b) => a.price - b.price).slice(0, 5));
    expect(selected).toHaveLength(5); expect(selected[0].id).toBe(320); expect(cursor.close).toHaveBeenCalledTimes(1);
  });
  test('asking to confirm a shipment review without producing its server quote forces the actual review tool, not a prose approval question', () => {
    const state = {}, messages = [];
    const result = __private.completeActionDraft(state, 'If you want the portion marked delivered, please confirm.',
      [{ tool: 'get_order_detail', result: { success: true } }], messages, true,
      'Review changing my own store portion of ORD-QA to delivered and wait for my confirmation.', 'seller');
    expect(result.retry).toBe(true); expect(state.tool).toBe('update_order_status');
    expect(messages[0].content).toContain('confirm=false');
    expect(__private.explicitReviewTool('Review changing my own store portion of ORD-QA to delivered and wait for my confirmation.', 'seller')).toBe('update_order_status');
    expect(__private.explicitReviewTool('Can I mark ORD-QA delivered?', 'seller')).toBe('');
    expect(__private.explicitReviewTool('Review a withdrawal for 5 USD', 'user')).toBe('');
  });
  test('only current payment configuration is public; private financial actions require authentication and seller ownership', () => {
    expect(toolNamesFor('guest')).toContain('get_payment_options');
    expect(toolNamesFor('guest')).not.toContain('get_wallet_balance');
    expect(toolNamesFor('guest')).not.toContain('request_return');
    expect(toolNamesFor('user')).not.toContain('request_withdrawal');
    expect(toolNamesFor('seller')).toContain('request_withdrawal');
    expect(toolNamesFor('seller')).toContain('get_purchase_orders');
  });
  test('store currency tools are seller-only and context separates store currency from account display currency', () => {
    expect(toolNamesFor('seller')).toEqual(expect.arrayContaining(['preview_store_currency_change', 'change_store_currency']));
    expect(toolNamesFor('user')).not.toEqual(expect.arrayContaining(['change_store_currency']));
    const context = __private.formatContextBlock({ currency: 'USD', store: { name: 'PKR Shop', slug: 'pkr-shop', productCurrency: 'PKR', changeLimits: { productCurrency: { canChange: false, cooldownDays: 60, nextAllowedAt: '2026-11-08T00:00:00.000Z' } } } }, 'seller');
    expect(context).toContain('Store product currency: PKR');
    expect(context).toContain('waiting period after a completed change: 60 days');
    expect(context).toContain('2026-11-08T00:00:00.000Z');
  });
  test.each(['user', 'seller'])('%s exposes unique tools and every tool has an executor', role => {
    const toolNames = toolNamesFor(role);
    const executorSource = fs.readFileSync(
      path.join(__dirname, '../../services/aiActionExecutor.js'),
      'utf8',
    );
    const serverExecutors = new Set(
      [...executorSource.matchAll(/case '([^']+)':/g)].map(match => match[1]),
    );

    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(toolNames).not.toHaveLength(0);

    const missingExecutors = toolNames.filter(toolName => (
      !CLIENT_SIDE_TOOLS.has(toolName) && !serverExecutors.has(toolName) && !NEW_COMMERCE_TOOL_NAMES.has(toolName)
    ));
    expect(missingExecutors).toEqual([]);
    expect(executorSource).toContain('NEW_COMMERCE_TOOL_NAMES.has(toolName)');
    expect(executorSource).toContain('return executeCommerceTool(toolName, args, user)');
  });

  test('seller access is a strict superset of the buyer tool surface', () => {
    const buyerTools = toolNamesFor('user');
    const sellerTools = new Set(toolNamesFor('seller'));

    expect(buyerTools.every(toolName => sellerTools.has(toolName))).toBe(true);
    expect(sellerTools.size).toBeGreaterThan(buyerTools.length);
  });

  test('all browser and mobile client actions use the same three server declarations', () => {
    expect([...CLIENT_SIDE_TOOLS].sort()).toEqual([
      'navigate',
      'show_style_advice',
      'suggest_outfit',
    ]);
  });
});
