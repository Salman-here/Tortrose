const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { buildSellerPaymentSummary, buildAdminPaymentsOverviewData } = require('../../controllers/PaymentController');
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');
const { convertToUSD } = require('../../services/currencyService');

let mongoServer;

const createUser = (suffix, role = 'user') =>
    User.create({
        username: `${role}${suffix}`,
        email: `${role}${suffix}@test.com`,
        password: 'password123',
        role,
    });

const createProduct = (seller, suffix, price) =>
    Product.create({
        name: `Product ${suffix}`,
        description: `Product ${suffix} description`,
        price,
        category: 'Test',
        brand: 'Test Brand',
        stock: 10,
        image: `https://example.com/${suffix}.jpg`,
        images: [{ url: `https://example.com/${suffix}.jpg` }],
        seller: seller._id,
    });

const shippingInfoFor = (buyer) => ({
    fullName: 'Buyer One',
    email: buyer.email,
    phone: '+923001234567',
    address: '123 Test Street',
    city: 'Lahore',
    state: 'Punjab',
    postalCode: '54000',
    country: 'Pakistan',
});

const createOrder = ({
    buyer,
    items,
    sellerShipping,
    paymentMethod,
    orderStatus = 'pending',
    isPaid = false,
    tax = 0,
    couponDiscount = 0,
    currency = 'USD',
}) => {
    const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    const shippingCost = sellerShipping.reduce((sum, entry) => sum + entry.shippingMethod.price, 0);

    return Order.create({
        user: buyer._id,
        currency,
        orderId: `ORD-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        orderItems: items.map((item) => ({
            productId: item.product._id,
            seller: item.product.seller || null,
            name: item.product.name,
            image: item.product.image,
            price: item.product.price,
            quantity: item.quantity,
        })),
        shippingInfo: shippingInfoFor(buyer),
        shippingMethod: {
            name: 'standard',
            price: shippingCost,
            estimatedDays: 5,
            seller: sellerShipping[0].seller,
        },
        sellerShipping,
        orderSummary: {
            subtotal,
            shippingCost,
            tax,
            couponDiscount,
            totalAmount: subtotal + shippingCost + tax - couponDiscount,
        },
        paymentMethod,
        isPaid,
        paidAt: isPaid ? new Date() : undefined,
        isDelivered: orderStatus === 'delivered',
        deliveredAt: orderStatus === 'delivered' ? new Date() : undefined,
        orderStatus,
    });
};

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
    if (mongoServer) {
        await mongoServer.stop();
    }
}, 60000);

beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        Product.deleteMany({}),
        Order.deleteMany({}),
        SellerPaymentAccount.deleteMany({}),
        SellerWithdrawalRequest.deleteMany({}),
    ]);
});

describe('PaymentController buildSellerPaymentSummary', () => {
    test('separates Stripe withdrawable revenue, COD revenue, pending estimates, and withdrawal reservations', async () => {
        const seller = await createUser('seller', 'seller');
        const otherSeller = await createUser('otherseller', 'seller');
        const buyer = await createUser('buyer', 'user');
        const sellerProduct = await createProduct(seller, 'seller', 100);
        const otherProduct = await createProduct(otherSeller, 'other', 50);

        await createOrder({
            buyer,
            items: [
                { product: sellerProduct, quantity: 2 },
                { product: otherProduct, quantity: 1 },
            ],
            sellerShipping: [
                { seller: seller._id, shippingMethod: { name: 'standard', price: 8, estimatedDays: 5 } },
                { seller: otherSeller._id, shippingMethod: { name: 'standard', price: 4, estimatedDays: 5 } },
            ],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
            tax: 25,
            couponDiscount: 10,
        });

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 3 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 7, estimatedDays: 5 } }],
            paymentMethod: 'cash_on_delivery',
            isPaid: false,
            orderStatus: 'delivered',
        });

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 2, estimatedDays: 5 } }],
            paymentMethod: 'cash_on_delivery',
            isPaid: false,
            orderStatus: 'pending',
        });

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 4, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'processing',
        });

        await SellerWithdrawalRequest.create([
            { seller: seller._id, amount: 50, status: 'pending' },
            { seller: seller._id, amount: 15, status: 'approved' },
            { seller: seller._id, amount: 25, status: 'paid' },
        ]);

        const summary = await buildSellerPaymentSummary(seller._id);

        expect(summary.revenue.stripeDeliveredRevenue).toBe(220);
        expect(summary.revenue.codDeliveredRevenue).toBe(307);
        expect(summary.revenue.codPendingRevenue).toBe(102);
        expect(summary.revenue.stripePendingRevenue).toBe(104);
        expect(summary.revenue.pendingWithdrawalAmount).toBe(50);
        expect(summary.revenue.approvedWithdrawalAmount).toBe(15);
        expect(summary.revenue.totalWithdrawn).toBe(25);
        expect(summary.revenue.withdrawableBalance).toBe(130);
        expect(summary.revenue.totalDeliveredRevenue).toBe(527);
        expect(summary.revenue.estimatedRevenue).toBe(733);
    });

    test('converts non-USD order revenue to USD before exposing seller balances', async () => {
        const seller = await createUser('sellerpkr', 'seller');
        const buyer = await createUser('buyerpkr', 'user');
        const sellerProduct = await createProduct(seller, 'pkr', 200);

        await createOrder({
            buyer,
            currency: 'PKR',
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });

        const expectedUSD = await convertToUSD(200, 'PKR');
        const summary = await buildSellerPaymentSummary(seller._id);

        expect(summary.revenue.stripeDeliveredRevenue).toBe(expectedUSD);
        expect(summary.revenue.withdrawableBalance).toBe(expectedUSD);
        expect(summary.recentStripeOrders[0]).toMatchObject({
            amount: expectedUSD,
            amountCurrency: 'USD',
            sourceAmount: 200,
            sourceCurrency: 'PKR',
        });
    });

    test('builds admin overview in bulk and uses order item seller snapshots', async () => {
        const seller = await createUser('snapshot', 'seller');
        const buyer = await createUser('snapshotbuyer', 'user');
        const sellerProduct = await createProduct(seller, 'snapshot', 50);

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });
        await Product.deleteOne({ _id: sellerProduct._id });

        await SellerPaymentAccount.create({
            seller: seller._id,
            accountHolderName: 'Snapshot Seller',
            bankName: 'Test Bank',
            accountNumber: '1234567890',
            accountNumberLast4: '7890',
        });
        await SellerWithdrawalRequest.create({ seller: seller._id, amount: 5, status: 'pending' });

        const overview = await buildAdminPaymentsOverviewData();
        const row = overview.sellers.find((sellerRow) => sellerRow.seller.email === seller.email);

        expect(row).toBeTruthy();
        expect(row.revenue.stripeDeliveredRevenue).toBe(50);
        expect(row.revenue.pendingWithdrawalAmount).toBe(5);
        expect(row.revenue.withdrawableBalance).toBe(45);
        expect(row.paymentAccount.accountNumber).toBe('1234567890');
        expect(overview.summary.stripeDeliveredRevenue).toBe(50);
        expect(overview.summary.withdrawableBalance).toBe(45);
        expect(overview.withdrawals).toHaveLength(1);
    });
});
