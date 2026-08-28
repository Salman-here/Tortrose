const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const userRoutes = require('../../routes/userRoutes')
const whatsappRoutes = require('../../routes/whatsappRoutes')
const User = require('../../models/User')
const SellerSubscription = require('../../models/SellerSubscription')
const Store = require('../../models/Store')
const Product = require('../../models/Product')
const Order = require('../../models/Order')
const AdminWhatsAppNumber = require('../../models/AdminWhatsAppNumber')
const ExpoPushTokenRegistration = require('../../models/ExpoPushTokenRegistration')
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction')
const UserBlock = require('../../models/UserBlock')
const Complaint = require('../../models/Complaint')
const { hashValue } = require('../../services/pushTokenRevocationService')

let app
let mongoServer

const tokenFor = (user) => `Bearer ${jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET)}`

beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-users-test-secret'
    mongoServer = await MongoMemoryServer.create()
    await mongoose.connect(mongoServer.getUri())
    app = express()
    app.use(express.json())
    app.use('/api/user', userRoutes)
    app.use('/api/whatsapp', whatsappRoutes)
}, 60000)

afterEach(async () => {
    jest.restoreAllMocks()
    await Promise.all([
        User.deleteMany({}),
        SellerSubscription.deleteMany({}),
        Store.deleteMany({}),
        Product.deleteMany({}),
        Order.deleteMany({}),
        AdminWhatsAppNumber.deleteMany({}),
        ExpoPushTokenRegistration.deleteMany({}),
        SellerBalanceTransaction.deleteMany({}),
        UserBlock.deleteMany({}),
        Complaint.deleteMany({}),
    ])
})

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
    if (mongoServer) await mongoServer.stop()
}, 60000)

describe('admin user management data', () => {
    test('uses the free-trial name for newly initialized subscription documents', () => {
        const subscription = new SellerSubscription({ seller: new mongoose.Types.ObjectId() })

        expect(subscription.status).toBe('trial')
        expect(subscription.plan).toBe('free_trial')
        expect(subscription.planName).toBe('Rozare Free Trial')
    })

    test('derives legacy join dates and identifies a free trial independently of stale planName data', async () => {
        const admin = await User.create({
            username: 'admin-user',
            email: 'admin-users@test.com',
            password: 'password123',
            role: 'admin',
        })

        const joinedAt = new Date('2024-05-04T10:20:30.000Z')
        const legacySellerId = mongoose.Types.ObjectId.createFromTime(Math.floor(joinedAt.getTime() / 1000))
        await User.collection.insertOne({
            _id: legacySellerId,
            username: 'legacy-seller',
            email: 'legacy-seller@test.com',
            role: 'seller',
            status: 'active',
        })

        const trialEndDate = new Date('2024-05-19T10:20:30.000Z')
        await SellerSubscription.create({
            seller: legacySellerId,
            status: 'trial',
            plan: 'free_trial',
            planName: 'Rozare Starter',
            trialStartDate: joinedAt,
            trialEndDate,
        })

        const response = await request(app)
            .get('/api/user/get')
            .set('Authorization', tokenFor(admin))

        expect(response.status).toBe(200)
        const seller = response.body.users.find(user => user._id === legacySellerId.toString())
        expect(seller).toBeDefined()
        expect(seller.joinedAt).toBe(legacySellerId.getTimestamp().toISOString())
        expect(seller.createdAt).toBe(legacySellerId.getTimestamp().toISOString())
        expect(seller.sellerSubscription).toMatchObject({
            displayPlanName: 'Rozare Free Trial',
            displayStatus: '15-Day Free Trial',
            periodLabel: 'Trial ended',
            periodEndDate: trialEndDate.toISOString(),
        })
    })

    test('keeps a selected Starter plan distinct from its 30-day introductory free period', async () => {
        const admin = await User.create({
            username: 'second-admin',
            email: 'second-admin@test.com',
            password: 'password123',
            role: 'admin',
        })
        const seller = await User.create({
            username: 'starter-seller',
            email: 'starter-seller@test.com',
            password: 'password123',
            role: 'seller',
        })
        const freePeriodEndDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
        await SellerSubscription.create({
            seller: seller._id,
            status: 'free_period',
            plan: 'starter',
            planName: 'Rozare Starter',
            freePeriodEndDate,
        })

        const response = await request(app)
            .get('/api/user/get')
            .set('Authorization', tokenFor(admin))

        expect(response.status).toBe(200)
        const result = response.body.users.find(user => user._id === seller._id.toString())
        expect(result.joinedAt).toBeTruthy()
        expect(result.sellerSubscription).toMatchObject({
            displayPlanName: 'Rozare Starter',
            displayStatus: '30-Day Free Period',
            periodLabel: 'Free period ends',
            periodEndDate: freePeriodEndDate.toISOString(),
        })
    })

    test('deleting a seller removes marketplace inventory but preserves order evidence', async () => {
        const admin = await User.create({
            username: 'deletion-admin',
            email: 'deletion-admin@test.com',
            password: 'password123',
            role: 'admin',
        })
        const seller = await User.create({
            username: 'seller-to-delete',
            email: 'seller-to-delete@test.com',
            password: 'password123',
            role: 'seller',
            sellerInfo: {
                whatsappNumber: '+923001119999',
                whatsappDigits: '923001119999',
                whatsappVerified: true,
            },
        })
        const store = await Store.create({
            seller: seller._id,
            storeName: 'Deleted Seller Store',
            storeSlug: 'deleted-seller-store',
            isActive: true,
        })
        const product = await Product.create({
            name: 'Historical Product',
            price: 1200,
            currency: 'PKR',
            category: 'Test',
            brand: 'Test Brand',
            stock: 2,
            image: 'https://example.com/product.jpg',
            seller: seller._id,
        })
        const orderId = new mongoose.Types.ObjectId()
        await Order.collection.insertOne({
            _id: orderId,
            orderId: 'PRESERVED-ORDER-1',
            user: new mongoose.Types.ObjectId(),
            orderItems: [{
                productId: product._id,
                seller: seller._id,
                name: product.name,
                price: product.price,
                quantity: 1,
            }],
            sellerPolicies: [{
                seller: seller._id,
                store: store._id,
                storeName: store.storeName,
            }],
            paymentResult: { paymentIntentId: 'pi_historical_evidence' },
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        const ledger = await SellerBalanceTransaction.create({
            seller: seller._id,
            type: 'admin_adjustment',
            direction: 'credit',
            status: 'completed',
            amountUSD: 10,
            sourceAmount: 2800,
            sourceCurrency: 'PKR',
            referenceType: 'admin',
            referenceId: 'preserved-ledger-entry',
            description: 'Historical seller balance evidence',
        })
        const pushRegistration = await ExpoPushTokenRegistration.create({
            tokenHash: hashValue('ExpoPushToken[deleted-seller-device]'),
            revocationHash: hashValue('deleted-seller-credential'),
            user: seller._id,
        })
        const legacyAdminAuthorization = await AdminWhatsAppNumber.create({
            number: '923001119999',
            label: 'Legacy conflicting authorization',
            addedBy: admin._id,
            isActive: true,
        })

        const response = await request(app)
            .delete(`/api/user/delete/${seller._id}`)
            .set('Authorization', tokenFor(admin))

        expect(response.status).toBe(200)
        await expect(User.exists({ _id: seller._id })).resolves.toBeNull()
        await expect(Store.exists({ _id: store._id })).resolves.toBeNull()
        await expect(Product.exists({ _id: product._id })).resolves.toBeNull()
        await expect(Order.exists({ _id: orderId })).resolves.not.toBeNull()
        await expect(SellerBalanceTransaction.exists({ _id: ledger._id })).resolves.not.toBeNull()
        await expect(ExpoPushTokenRegistration.exists({ _id: pushRegistration._id })).resolves.toBeNull()
        await expect(AdminWhatsAppNumber.exists({ _id: legacyAdminAuthorization._id })).resolves.toBeNull()
        const preserved = await Order.collection.findOne({ _id: orderId })
        expect(preserved.orderItems[0]).toMatchObject({
            name: 'Historical Product',
            price: 1200,
        })
        expect(preserved.paymentResult.paymentIntentId).toBe('pi_historical_evidence')
    })

    test('self-deletion uses the same seller cleanup and evidence retention contract', async () => {
        const seller = await User.create({
            username: 'self-delete-seller',
            email: 'self-delete-seller@test.com',
            password: 'password123',
            role: 'seller',
        })
        const store = await Store.create({
            seller: seller._id,
            storeName: 'Self Delete Store',
            storeSlug: 'self-delete-store',
            isActive: true,
        })
        const product = await Product.create({
            name: 'Self Delete Product',
            price: 99,
            category: 'Test',
            brand: 'Test',
            stock: 1,
            image: 'https://example.com/self-delete.jpg',
            seller: seller._id,
        })
        const evidenceId = new mongoose.Types.ObjectId()
        await Order.collection.insertOne({
            _id: evidenceId,
            orderId: 'SELF-DELETE-EVIDENCE',
            orderItems: [{
                productId: product._id,
                seller: seller._id,
                name: product.name,
                price: product.price,
                quantity: 1,
            }],
            sellerPolicies: [{ seller: seller._id, store: store._id, storeName: store.storeName }],
            paymentResult: { paymentIntentId: 'pi_self_delete_evidence' },
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        const ledger = await SellerBalanceTransaction.create({
            seller: seller._id,
            type: 'admin_adjustment',
            direction: 'credit',
            status: 'completed',
            amountUSD: 5,
            sourceAmount: 5,
            sourceCurrency: 'USD',
            referenceType: 'admin',
            referenceId: 'self-delete-preserved-ledger',
            description: 'Self-delete historical ledger evidence',
        })
        const peer = await User.create({
            username: 'self-delete-peer',
            email: 'self-delete-peer@test.com',
            password: 'password123',
            role: 'user',
        })
        await UserBlock.create([
            { blocker: seller._id, blocked: peer._id, source: 'user' },
            { blocker: peer._id, blocked: seller._id, source: 'seller' },
        ])
        const reportBySeller = await Complaint.create({
            user: seller._id,
            category: 'ai_response',
            subject: 'Safety report by deleted account',
            message: 'Retained safety evidence',
            report: { kind: 'ai_response', reason: 'other', sourceId: 'self-delete-report', reporterType: 'account' },
        })
        const reportAboutSeller = await Complaint.create({
            user: peer._id,
            category: 'seller_complaint',
            subject: 'Safety report about deleted account',
            message: 'Retained moderation evidence',
            report: { kind: 'seller', reason: 'other', sourceId: String(seller._id), targetUser: seller._id, reporterType: 'account' },
        })

        const response = await request(app)
            .delete('/api/user/delete-account')
            .set('Authorization', tokenFor(seller))

        expect(response.status).toBe(200)
        await expect(User.exists({ _id: seller._id })).resolves.toBeNull()
        await expect(Store.exists({ _id: store._id })).resolves.toBeNull()
        await expect(Product.exists({ _id: product._id })).resolves.toBeNull()
        await expect(Order.exists({ _id: evidenceId })).resolves.not.toBeNull()
        await expect(SellerBalanceTransaction.exists({ _id: ledger._id })).resolves.not.toBeNull()
        await expect(UserBlock.countDocuments({ $or: [{ blocker: seller._id }, { blocked: seller._id }] })).resolves.toBe(0)
        const retainedReporterRecord = await Complaint.findById(reportBySeller._id).lean()
        expect(retainedReporterRecord.user).toBeNull()
        expect(retainedReporterRecord.report.reporterType).toBe('anonymous')
        const retainedTargetRecord = await Complaint.findById(reportAboutSeller._id).lean()
        expect(retainedTargetRecord.report.targetUser).toBeNull()
        const evidence = await Order.collection.findOne({ _id: evidenceId })
        expect(evidence.paymentResult.paymentIntentId).toBe('pi_self_delete_evidence')
    })

    test('seller cleanup is retry-safe after a partial marketplace deletion failure', async () => {
        const admin = await User.create({
            username: 'retry-admin',
            email: 'retry-admin@test.com',
            password: 'password123',
            role: 'admin',
        })
        const seller = await User.create({
            username: 'retry-seller',
            email: 'retry-seller@test.com',
            password: 'password123',
            role: 'seller',
        })
        await Store.create({
            seller: seller._id,
            storeName: 'Retry Store',
            storeSlug: 'retry-store',
            isActive: true,
        })
        const product = await Product.create({
            name: 'Retry Product',
            price: 20,
            category: 'Test',
            brand: 'Test',
            stock: 1,
            image: 'https://example.com/retry.jpg',
            seller: seller._id,
        })
        const deleteSpy = jest.spyOn(Product, 'deleteMany')
            .mockRejectedValueOnce(new Error('synthetic product cleanup failure'))

        const first = await request(app)
            .delete(`/api/user/delete/${seller._id}`)
            .set('Authorization', tokenFor(admin))

        expect(first.status).toBe(500)
        await expect(User.exists({ _id: seller._id })).resolves.not.toBeNull()
        const hiddenProduct = await Product.findById(product._id).lean()
        expect(hiddenProduct).toMatchObject({
            isBlocked: true,
            moderationStatus: 'blocked',
            isFeatured: false,
        })

        deleteSpy.mockRestore()
        const retry = await request(app)
            .delete(`/api/user/delete/${seller._id}`)
            .set('Authorization', tokenFor(admin))

        expect(retry.status).toBe(200)
        await expect(User.exists({ _id: seller._id })).resolves.toBeNull()
        await expect(Product.exists({ _id: product._id })).resolves.toBeNull()
    })

    test('moves one device push token to the currently signed-in account', async () => {
        const pushToken = 'ExpoPushToken[one-device-one-owner]'
        const buyerRevocationCredential = 'B'.repeat(43)
        const sellerRevocationCredential = 'S'.repeat(43)
        const buyer = await User.create({
            username: 'push-buyer',
            email: 'push-buyer@test.com',
            password: 'password123',
            role: 'user',
        })
        const seller = await User.create({
            username: 'push-seller',
            email: 'push-seller@test.com',
            password: 'password123',
            role: 'seller',
            expoPushTokens: [pushToken],
        })

        const buyerRegistration = await request(app)
            .post('/api/user/push-token')
            .set('Authorization', tokenFor(buyer))
            .send({ pushToken, revocationCredential: buyerRevocationCredential })

        expect(buyerRegistration.status).toBe(200)
        expect(buyerRegistration.body).toMatchObject({ registered: true })
        expect(buyerRegistration.body).not.toHaveProperty('revocationCredential')
        expect((await User.findById(buyer).lean()).expoPushTokens).toEqual([pushToken])
        expect((await User.findById(seller).lean()).expoPushTokens).not.toContain(pushToken)

        const sellerRegistration = await request(app)
            .post('/api/user/push-token')
            .set('Authorization', tokenFor(seller))
            .send({ pushToken, revocationCredential: sellerRevocationCredential })

        expect(sellerRegistration.status).toBe(200)
        expect(sellerRevocationCredential).not.toBe(buyerRevocationCredential)
        expect((await User.findById(seller).lean()).expoPushTokens).toEqual([pushToken])
        expect((await User.findById(buyer).lean()).expoPushTokens).not.toContain(pushToken)

        const storedRegistration = await ExpoPushTokenRegistration.findOne({})
            .select('+revocationHash')
            .lean()
        expect(storedRegistration).toMatchObject({ user: seller._id })
        expect(storedRegistration.tokenHash).not.toBe(pushToken)
        expect(storedRegistration.revocationHash).not.toBe(sellerRevocationCredential)
        expect(storedRegistration).not.toHaveProperty('credential')

        const oldCredential = await request(app)
            .post('/api/user/push-token/revoke')
            .send({ pushToken, revocationCredential: buyerRevocationCredential })
        expect(oldCredential.status).toBe(401)
        expect((await User.findById(seller).lean()).expoPushTokens).toContain(pushToken)

        const invalidCredential = await request(app)
            .post('/api/user/push-token/revoke')
            .send({ pushToken, revocationCredential: 'A'.repeat(43) })
        expect(invalidCredential.status).toBe(401)

        const publicRevoke = await request(app)
            .post('/api/user/push-token/revoke')
            .send({ pushToken, revocationCredential: sellerRevocationCredential })
        const repeatedPublicRevoke = await request(app)
            .post('/api/user/push-token/revoke')
            .send({ pushToken, revocationCredential: sellerRevocationCredential })
        expect(publicRevoke.status).toBe(200)
        expect(publicRevoke.body).toMatchObject({ revoked: true, alreadyRevoked: false })
        expect(repeatedPublicRevoke.status).toBe(200)
        expect(repeatedPublicRevoke.body).toMatchObject({ revoked: true, alreadyRevoked: true })
        expect((await User.findById(seller).lean()).expoPushTokens).not.toContain(pushToken)

        const firstUnregister = await request(app)
            .delete('/api/user/push-token')
            .set('Authorization', tokenFor(seller))
            .send({ pushToken })
        const repeatedUnregister = await request(app)
            .delete('/api/user/push-token')
            .set('Authorization', tokenFor(seller))
            .send({ pushToken })

        expect(firstUnregister.status).toBe(200)
        expect(repeatedUnregister.status).toBe(200)
        expect((await User.findById(seller).lean()).expoPushTokens).not.toContain(pushToken)
    })

    test('a client-owned credential survives a lost save response and supports ordered token refresh cleanup', async () => {
        const account = await User.create({
            username: 'push-refresh-account',
            email: 'push-refresh-account@test.com',
            password: 'password123',
            role: 'user',
        })
        const firstToken = 'ExpoPushToken[refresh-token-one]'
        const firstCredential = 'C'.repeat(43)
        const secondToken = 'ExpoPushToken[refresh-token-two]'
        const secondCredential = 'D'.repeat(43)

        // The client persists firstCredential before this request. Deliberately
        // ignore the response body to model a committed request whose response
        // was dropped by the network.
        const committedSave = await request(app)
            .post('/api/user/push-token')
            .set('Authorization', tokenFor(account))
            .send({ pushToken: firstToken, revocationCredential: firstCredential })
        expect(committedSave.status).toBe(200)

        const revokeOldToken = await request(app)
            .post('/api/user/push-token/revoke')
            .send({ pushToken: firstToken, revocationCredential: firstCredential })
        expect(revokeOldToken.status).toBe(200)

        const saveNewToken = await request(app)
            .post('/api/user/push-token')
            .set('Authorization', tokenFor(account))
            .send({ pushToken: secondToken, revocationCredential: secondCredential })
        expect(saveNewToken.status).toBe(200)
        expect((await User.findById(account).lean()).expoPushTokens).toEqual([secondToken])

        const registrations = await ExpoPushTokenRegistration.find({})
            .select('+revocationHash')
            .lean()
        const first = registrations.find(item => item.tokenHash === hashValue(firstToken))
        const second = registrations.find(item => item.tokenHash === hashValue(secondToken))
        expect(first.revokedAt).toBeInstanceOf(Date)
        expect(second.revokedAt).toBeNull()
        expect(second.revocationHash).toBe(hashValue(secondCredential))
    })

    test('legacy authenticated registration still returns a server credential for migration', async () => {
        const account = await User.create({
            username: 'legacy-push-account',
            email: 'legacy-push-account@test.com',
            password: 'password123',
            role: 'user',
        })
        const response = await request(app)
            .post('/api/user/push-token')
            .set('Authorization', tokenFor(account))
            .send({ pushToken: 'ExpoPushToken[legacy-migration-device]' })

        expect(response.status).toBe(200)
        expect(response.body.revocationCredential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    test('push-token registration still requires authentication', async () => {
        const response = await request(app)
            .post('/api/user/push-token')
            .send({ pushToken: 'ExpoPushToken[unauthenticated-device]' })

        expect(response.status).toBe(401)
        await expect(ExpoPushTokenRegistration.countDocuments({})).resolves.toBe(0)
    })

    test('public push-token revocation validates its capability body', async () => {
        const missingBody = await request(app)
            .post('/api/user/push-token/revoke')
            .send({})
        const invalidToken = await request(app)
            .post('/api/user/push-token/revoke')
            .send({
                pushToken: 'not-an-expo-token',
                revocationCredential: 'A'.repeat(43),
            })
        const invalidCredentialShape = await request(app)
            .post('/api/user/push-token/revoke')
            .send({
                pushToken: 'ExpoPushToken[body-validation-device]',
                revocationCredential: 'too-short',
            })
        const invalidAuthenticatedSave = await request(app)
            .post('/api/user/push-token')
            .set('Authorization', tokenFor(await User.create({
                username: 'invalid-credential-save',
                email: 'invalid-credential-save@test.com',
                password: 'password123',
                role: 'user',
            })))
            .send({
                pushToken: 'ExpoPushToken[invalid-credential-save-device]',
                revocationCredential: 'too-short',
            })

        expect(missingBody.status).toBe(400)
        expect(invalidToken.status).toBe(400)
        expect(invalidCredentialShape.status).toBe(400)
        expect(invalidAuthenticatedSave.status).toBe(400)
    })

    test('rejects admin WhatsApp activation when a verified seller owns the number', async () => {
        const admin = await User.create({
            username: 'whatsapp-admin',
            email: 'whatsapp-admin@test.com',
            password: 'password123',
            role: 'admin',
        })
        await User.create({
            username: 'number-owner',
            email: 'number-owner@test.com',
            password: 'password123',
            role: 'seller',
            sellerInfo: {
                whatsappNumber: '+923001234567',
                whatsappDigits: '923001234567',
                whatsappVerified: true,
            },
        })

        const response = await request(app)
            .post('/api/whatsapp/admin-numbers')
            .set('Authorization', tokenFor(admin))
            .send({ number: '+92 300 1234567', label: 'Conflicting admin' })

        expect(response.status).toBe(409)
        expect(response.body.msg).toMatch(/already verified/i)
        await expect(AdminWhatsAppNumber.exists({ number: '923001234567' })).resolves.toBeNull()
    })

    test('rejects admin WhatsApp activation when a demoted seller retains the verified number', async () => {
        const admin = await User.create({
            username: 'demoted-number-admin',
            email: 'demoted-number-admin@test.com',
            password: 'password123',
            role: 'admin',
        })
        await User.create({
            username: 'demoted-number-owner',
            email: 'demoted-number-owner@test.com',
            password: 'password123',
            role: 'user',
            sellerInfo: {
                whatsappNumber: '+923009876543',
                whatsappDigits: '923009876543',
                whatsappVerified: true,
            },
        })

        const response = await request(app)
            .post('/api/whatsapp/admin-numbers')
            .set('Authorization', tokenFor(admin))
            .send({ number: '+92 300 9876543', label: 'Demoted conflict' })

        expect(response.status).toBe(409)
        expect(response.body.msg).toMatch(/already verified/i)
        await expect(AdminWhatsAppNumber.exists({ number: '923009876543' })).resolves.toBeNull()
    })

    test('rate limits repeated public push-token revocation abuse', async () => {
        let limitedResponse = null
        for (let attempt = 0; attempt < 65; attempt += 1) {
            const response = await request(app)
                .post('/api/user/push-token/revoke')
                .send({})
            if (response.status === 429) {
                limitedResponse = response
                break
            }
        }

        expect(limitedResponse).not.toBeNull()
        expect(limitedResponse.body.msg).toMatch(/too many push-token revocation attempts/i)
    })
})
