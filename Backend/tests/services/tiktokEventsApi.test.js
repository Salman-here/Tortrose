const {
    sendTikTokEvent,
    sha256,
    trackCompleteRegistration,
    trackOrderEvent,
} = require('../../services/tiktokEventsApi');

describe('tiktokEventsApi', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;

    beforeEach(() => {
        process.env = { ...originalEnv, TIKTOK_EVENTS_API_TOKEN: 'test-token', TIKTOK_PIXEL_ID: 'PIXEL123' };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ code: 0, message: 'OK' }),
        });
    });

    afterEach(() => {
        process.env = originalEnv;
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('hashes identifiers with normalized SHA-256', () => {
        expect(sha256('  TEST@Example.COM ')).toBe(
            '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b'
        );
    });

    it('sends complete registration with numeric value and product content type', async () => {
        await trackCompleteRegistration({
            req: {
                headers: {
                    'user-agent': 'jest',
                    'x-forwarded-for': '1.2.3.4',
                    cookie: '_ttp=abc',
                },
            },
            user: { _id: 'user123', email: 'seller@example.com' },
            storeName: 'Seller Store',
            phone: '+15551234567',
            eventId: 'evt-1',
        });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.event_source).toBe('web');
        expect(body.event_source_id).toBe('PIXEL123');
        expect(body.data[0].event).toBe('CompleteRegistration');
        expect(body.data[0].event_id).toBe('evt-1');
        expect(body.data[0].properties.value).toBe(1);
        expect(body.data[0].properties.contents[0].content_type).toBe('product');
        expect(body.data[0].user.email).toBe(sha256('seller@example.com'));
        expect(body.data[0].user.ttp).toBe('abc');
    });

    it('sends purchase/order money in the persisted order currency', async () => {
        await trackOrderEvent({
            event: 'Purchase',
            order: {
                orderId: 'ORD-1',
                currency: 'PKR',
                shippingInfo: { email: 'buyer@example.com', phone: '+15550000000' },
                orderItems: [{
                    productId: 'prod1',
                    name: 'Toy Cart',
                    price: 10,
                    quantity: 2,
                    lineSubtotal: 5680,
                    sourceCurrency: 'USD',
                    sourceLineSubtotal: 20,
                }],
                orderSummary: { totalAmount: 6000 },
                tracking: { tiktokPurchaseEventId: 'purchase-1' },
            },
            eventId: 'purchase-1',
        });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.data[0].event).toBe('Purchase');
        expect(body.data[0].properties.order_id).toBe('ORD-1');
        expect(body.data[0].properties.value).toBe(6000);
        expect(body.data[0].properties.currency).toBe('PKR');
        expect(body.data[0].properties.contents).toEqual([
            expect.objectContaining({
                content_id: 'prod1',
                content_type: 'product',
                content_name: 'Toy Cart',
                price: 2840,
                quantity: 2,
            }),
        ]);
    });

    it('uses authoritative mixed-cart line allocations for web and mobile server events', async () => {
        await trackOrderEvent({
            event: 'PlaceAnOrder',
            req: { body: { clientSurface: 'mobile' }, headers: {} },
            order: {
                orderId: 'ORD-MIXED',
                currency: 'pkr',
                orderItems: [
                    {
                        productId: 'native-pkr',
                        name: 'Native PKR item',
                        price: 1000,
                        quantity: 2,
                        lineSubtotal: 2000,
                        sourceCurrency: 'PKR',
                        sourceLineSubtotal: 2000,
                    },
                    {
                        productId: 'foreign-usd',
                        name: 'Converted USD item',
                        price: 284.6,
                        quantity: 3,
                        lineSubtotal: 854,
                        sourceCurrency: 'USD',
                        sourceLineSubtotal: 3,
                    },
                ],
                orderSummary: { subtotal: 2854, shippingCost: 146, totalAmount: 3000 },
            },
            eventId: 'place-mixed',
        });

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.data[0].properties).toEqual(expect.objectContaining({
            order_id: 'ORD-MIXED',
            value: 3000,
            currency: 'PKR',
        }));
        expect(body.data[0].properties.contents).toEqual([
            expect.objectContaining({ content_id: 'native-pkr', price: 1000, quantity: 2 }),
            expect.objectContaining({ content_id: 'foreign-usd', price: 854 / 3, quantity: 3 }),
        ]);
    });

    it('omits unprovable legacy mixed-currency item prices instead of relabelling them', async () => {
        await trackOrderEvent({
            event: 'Purchase',
            order: {
                orderId: 'ORD-LEGACY-MIXED',
                currency: 'PKR',
                orderItems: [
                    {
                        productId: 'native-pkr',
                        name: 'Native PKR item',
                        price: 1000,
                        quantity: 2,
                        sourceCurrency: 'PKR',
                    },
                    {
                        productId: 'native-usd',
                        name: 'Native USD item',
                        price: 10,
                        quantity: 1,
                        sourceCurrency: 'USD',
                    },
                    {
                        productId: 'unknown-source',
                        name: 'Unknown denomination',
                        price: 50,
                        quantity: 1,
                    },
                ],
                orderSummary: { totalAmount: 5000 },
            },
        });

        const contents = JSON.parse(global.fetch.mock.calls[0][1].body).data[0].properties.contents;
        expect(contents[0]).toEqual(expect.objectContaining({ content_id: 'native-pkr', price: 1000 }));
        expect(contents[1]).toEqual(expect.objectContaining({ content_id: 'native-usd' }));
        expect(contents[1]).not.toHaveProperty('price');
        expect(contents[2]).toEqual(expect.objectContaining({ content_id: 'unknown-source' }));
        expect(contents[2]).not.toHaveProperty('price');
    });

    it.each(['JPY', 'USDX', '', '   ', undefined, true, 0, {}, { toString: () => 'USD' }])(
        'fails closed for a present invalid order currency: %p',
        async (currency) => {
            const result = await trackOrderEvent({
                event: 'Purchase',
                order: {
                    orderId: 'ORD-BAD-CURRENCY',
                    currency,
                    orderItems: [{ productId: 'prod1', price: 10, quantity: 1 }],
                    orderSummary: { totalAmount: 10 },
                },
            });

            expect(result).toEqual(expect.objectContaining({ skipped: true }));
            expect(global.fetch).not.toHaveBeenCalled();
        }
    );

    it('defaults genuinely missing legacy order currency to USD without guessing a present code', async () => {
        await trackOrderEvent({
            event: 'Purchase',
            order: {
                orderId: 'ORD-LEGACY-USD',
                orderItems: [{ productId: 'prod1', name: 'Legacy item', price: 12, quantity: 2 }],
                orderSummary: { totalAmount: 24 },
            },
        });

        const properties = JSON.parse(global.fetch.mock.calls[0][1].body).data[0].properties;
        expect(properties.currency).toBe('USD');
        expect(properties.contents[0]).toEqual(expect.objectContaining({ price: 12, quantity: 2 }));
    });

    it.each([Infinity, -1, 0.001, '', '10.00', true, {}])(
        'skips an order event with an invalid or non-cent total: %p',
        async (totalAmount) => {
            const result = await trackOrderEvent({
                event: 'Purchase',
                order: {
                    orderId: 'ORD-BAD-TOTAL',
                    currency: 'USD',
                    orderItems: [{ productId: 'prod1', price: 10, quantity: 1 }],
                    orderSummary: { totalAmount },
                },
            });

            expect(result).toEqual(expect.objectContaining({ skipped: true }));
            expect(global.fetch).not.toHaveBeenCalled();
        }
    );

    it.each(['', '10.00', true, Infinity, -1, 0.001])(
        'omits a present malformed line subtotal instead of reconstructing price: %p',
        async (lineSubtotal) => {
            await trackOrderEvent({
                event: 'Purchase',
                order: {
                    orderId: 'ORD-BAD-LINE',
                    currency: 'USD',
                    orderItems: [{
                        productId: 'prod1',
                        price: 10,
                        quantity: 1,
                        sourceCurrency: 'USD',
                        lineSubtotal,
                    }],
                    orderSummary: { totalAmount: 10 },
                },
            });

            const content = JSON.parse(global.fetch.mock.calls[0][1].body).data[0].properties.contents[0];
            expect(content).not.toHaveProperty('price');
        }
    );

    it.each(['2', true, 0, -1, 1.5, Infinity])(
        'omits an order content row with a malformed persisted quantity: %p',
        async (quantity) => {
            await trackOrderEvent({
                event: 'Purchase',
                order: {
                    orderId: 'ORD-BAD-QUANTITY',
                    currency: 'USD',
                    orderItems: [{ productId: 'prod1', price: 10, quantity, lineSubtotal: 10 }],
                    orderSummary: { totalAmount: 10 },
                },
            });

            const properties = JSON.parse(global.fetch.mock.calls[0][1].body).data[0].properties;
            expect(properties.contents).toBeUndefined();
            expect(properties.content_ids).toBeUndefined();
        }
    );

    it('skips cleanly when the token is missing', async () => {
        delete process.env.TIKTOK_EVENTS_API_TOKEN;
        const result = await sendTikTokEvent({ event: 'Purchase' });
        expect(result.skipped).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
