/**
 * aiPromptService — admin-editable AI prompts with code defaults.
 * Uses mongodb-memory-server (same pattern as route tests) so the real
 * override/reset/knowledge assembly logic is exercised against a live store.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let aiPromptService;
let AIPrompt;
let defaults;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  aiPromptService = require('../../services/aiPromptService');
  AIPrompt = require('../../models/AIPrompt');
  defaults = require('../../services/aiPrompts/defaultPrompts');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await AIPrompt.deleteMany({});
  aiPromptService.invalidateCache();
});

describe('defaults and overrides', () => {
  test('returns code defaults when the store is empty', async () => {
    const content = await aiPromptService.getPromptContent('chat.base.user');
    expect(content).toBe(defaults.USER_PROMPT);
  });

  test('system prompt for a role includes base + language + tool memory', async () => {
    const prompt = await aiPromptService.getSystemPromptForRole('seller');
    expect(prompt).toContain(defaults.SELLER_PROMPT.slice(0, 60));
    expect(prompt).toContain('## Language and Urdu style');
    expect(prompt).toContain('## Internal tool memory');
    expect(prompt).toContain('## Immutable live financial truth');
    expect(prompt).not.toContain('chatting via WhatsApp');
  });

  test('subscription defaults contain no remembered founder prices and the immutable live-price rule follows overrides', async () => {
    expect(defaults.USER_PROMPT).not.toMatch(/\$5\.99|\$12\.99|\$16\.99/);
    expect(defaults.SELLER_PROMPT).not.toMatch(/\$5\.99|\$12\.99|\$16\.99/);
    await aiPromptService.updatePrompt(
      'chat.base.seller',
      { content: 'Legacy override says Starter is $5.99 forever.' },
      { username: 'legacy-admin' },
    );

    const prompt = await aiPromptService.getSystemPromptForRole('seller');
    expect(prompt).toContain('Legacy override says Starter is $5.99 forever.');
    expect(prompt.lastIndexOf('## Immutable live financial truth'))
      .toBeGreaterThan(prompt.indexOf('Legacy override says Starter'));
    expect(prompt).toContain('Never guess.');
  });

  test('whatsapp channel appends the WhatsApp addendum', async () => {
    const prompt = await aiPromptService.getSystemPromptForRole('user', { channel: 'whatsapp' });
    expect(prompt).toContain('You are chatting via WhatsApp');
  });

  test('guest/unknown roles use the buyer persona', async () => {
    const prompt = await aiPromptService.getSystemPromptForRole('guest');
    expect(prompt).toContain(defaults.USER_PROMPT.slice(0, 60));
  });

  test('admin edit overrides the default and reset restores it', async () => {
    await aiPromptService.updatePrompt(
      'chat.base.user',
      { content: 'You are TestBot, a minimal assistant.' },
      { username: 'admin-test' }
    );

    let prompt = await aiPromptService.getSystemPromptForRole('user');
    expect(prompt).toContain('You are TestBot');
    expect(prompt).not.toContain(defaults.USER_PROMPT.slice(0, 60));
    // Addendums still appended around the override
    expect(prompt).toContain('## Language and Urdu style');

    await aiPromptService.resetPrompt('chat.base.user');
    prompt = await aiPromptService.getSystemPromptForRole('user');
    expect(prompt).toContain(defaults.USER_PROMPT.slice(0, 60));
  });

  test('updating a builtin records history and bumps version', async () => {
    await aiPromptService.updatePrompt('chat.base.admin', { content: 'v1 admin prompt' }, { username: 'a1' });
    const updated = await aiPromptService.updatePrompt('chat.base.admin', { content: 'v2 admin prompt' }, { username: 'a2' });
    expect(updated.version).toBe(2);
    expect(updated.history.length).toBe(1);
    expect(updated.history[0].content).toBe('v1 admin prompt');
  });

  test('rejects empty content', async () => {
    await expect(
      aiPromptService.updatePrompt('chat.base.user', { content: '   ' }, {})
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('custom knowledge prompts', () => {
  test('active knowledge is appended only for matching role and channel', async () => {
    await aiPromptService.createCustomPrompt({
      title: 'Gift Cards Launch',
      content: 'Rozare now sells gift cards. Buyers can purchase them from /gift-cards.',
      appliesTo: ['user'],
      channels: ['web'],
    }, { username: 'admin-test' });

    const buyerWeb = await aiPromptService.getSystemPromptForRole('user', { channel: 'web' });
    expect(buyerWeb).toContain('Platform updates & knowledge');
    expect(buyerWeb).toContain('Gift Cards Launch');

    const buyerWhatsApp = await aiPromptService.getSystemPromptForRole('user', { channel: 'whatsapp' });
    expect(buyerWhatsApp).not.toContain('Gift Cards Launch');

    const sellerWeb = await aiPromptService.getSystemPromptForRole('seller', { channel: 'web' });
    expect(sellerWeb).not.toContain('Gift Cards Launch');
  });

  test('disabled knowledge prompts are not appended', async () => {
    const created = await aiPromptService.createCustomPrompt({
      title: 'Hidden Note',
      content: 'This should not appear.',
      appliesTo: ['user'],
      channels: ['web'],
    }, {});
    await aiPromptService.updatePrompt(created.key, { isActive: false }, {});

    const prompt = await aiPromptService.getSystemPromptForRole('user', { channel: 'web' });
    expect(prompt).not.toContain('This should not appear.');
  });

  test('custom prompts can be deleted; builtin cannot', async () => {
    const created = await aiPromptService.createCustomPrompt({
      title: 'Temp', content: 'temp', appliesTo: ['user'], channels: ['web'],
    }, {});
    await expect(aiPromptService.deletePrompt(created.key)).resolves.toEqual({ deleted: true });
    await expect(aiPromptService.deletePrompt('chat.base.user')).rejects.toMatchObject({ status: 404 });

    await aiPromptService.updatePrompt('chat.base.user', { content: 'override' }, {});
    await expect(aiPromptService.deletePrompt('chat.base.user')).rejects.toMatchObject({ status: 400 });
  });
});

describe('admin listing', () => {
  test('lists every registry prompt plus customs with override flags', async () => {
    await aiPromptService.updatePrompt('chat.addendum.whatsapp', { content: 'short wa rules' }, { username: 'boss' });
    await aiPromptService.createCustomPrompt({
      title: 'Returns policy', content: '30 days.', appliesTo: ['user', 'seller'], channels: ['web', 'whatsapp'],
    }, {});

    const { categories, prompts } = await aiPromptService.listForAdmin();
    expect(categories.map(c => c.id)).toEqual(['chat-personas', 'chat-addendums', 'product-assist', 'knowledge']);

    const byKey = Object.fromEntries(prompts.map(p => [p.key, p]));
    expect(Object.keys(byKey).length).toBe(aiPromptService.PROMPT_REGISTRY.length + 1);

    expect(byKey['chat.base.user'].isOverridden).toBe(false);
    expect(byKey['chat.base.user'].content).toBe(defaults.USER_PROMPT);

    expect(byKey['chat.addendum.whatsapp'].isOverridden).toBe(true);
    expect(byKey['chat.addendum.whatsapp'].content).toBe('short wa rules');
    expect(byKey['chat.addendum.whatsapp'].defaultContent).toBe(defaults.WHATSAPP_SYSTEM_PROMPT_ADDENDUM);

    const custom = prompts.find(p => p.type === 'custom');
    expect(custom.title).toBe('Returns policy');
    expect(custom.appliesTo).toEqual(['user', 'seller']);
  });
});
