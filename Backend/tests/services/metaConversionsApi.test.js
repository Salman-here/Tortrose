const {
  buildUserData,
  createFbcFromFbclid,
  sendMetaLeadEvent,
  sha256,
} = require('../../services/metaConversionsApi');

describe('metaConversionsApi', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-25T12:00:00Z'));
    process.env = { ...originalEnv };
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('hashes customer data and includes Meta click cookies', () => {
    const req = {
      headers: {
        cookie: '_fbc=fb.1.123.click; _fbp=fb.1.123.browser',
        'user-agent': 'jest-agent',
        'x-forwarded-for': '203.0.113.10, 10.0.0.1',
      },
    };

    const userData = buildUserData({
      req,
      email: ' TEST@Example.COM ',
      phone: '+1 (555) 123-4567',
      externalId: 'user-1',
    });

    expect(userData).toMatchObject({
      em: [sha256('test@example.com')],
      ph: [sha256('15551234567')],
      external_id: [sha256('user-1')],
      fbc: 'fb.1.123.click',
      fbp: 'fb.1.123.browser',
      client_ip_address: '203.0.113.10',
      client_user_agent: 'jest-agent',
    });
  });

  test('builds fbc from fbclid when no _fbc cookie exists', () => {
    expect(createFbcFromFbclid('abc123', 1710000000000)).toBe('fb.1.1710000000000.abc123');
  });

  test('skips when backend Meta config is missing', async () => {
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_CAPI_DATASET_ID;

    const result = await sendMetaLeadEvent({ eventName: 'Lead', email: 'lead@example.com' });

    expect(result).toEqual({ skipped: true, reason: 'Meta Conversions API is not configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sends CRM lead events to the configured Meta dataset', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'test_token';
    process.env.META_CAPI_DATASET_ID = '1234567890';
    process.env.META_CAPI_API_VERSION = 'v25.0';
    process.env.META_CAPI_TEST_EVENT_CODE = 'TEST123';

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    });

    const result = await sendMetaLeadEvent({
      eventName: 'Lead',
      eventId: 'lead_1',
      eventTime: 1782398400,
      leadEventSource: 'Rozare Seller Signup',
      email: 'lead@example.com',
      phone: '+15551234567',
      externalId: 'seller-1',
      tracking: {
        fbc: 'fb.1.123.click',
        fbp: 'fb.1.123.browser',
      },
    });

    expect(result).toEqual({ ok: true, body: { events_received: 1 } });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v25.0/1234567890/events?access_token=test_token');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.test_event_code).toBe('TEST123');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      event_name: 'Lead',
      event_time: 1782398400,
      event_id: 'lead_1',
      action_source: 'system_generated',
      custom_data: {
        event_source: 'crm',
        lead_event_source: 'Rozare Seller Signup',
      },
      user_data: {
        em: [sha256('lead@example.com')],
        ph: [sha256('15551234567')],
        external_id: [sha256('seller-1')],
        fbc: 'fb.1.123.click',
        fbp: 'fb.1.123.browser',
      },
    });
  });
});
