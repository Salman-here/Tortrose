const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')
const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')

const userRoutes = require('../../routes/userRoutes')
const User = require('../../models/User')
const SellerSubscription = require('../../models/SellerSubscription')
const Store = require('../../models/Store')

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
}, 60000)

afterEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        SellerSubscription.deleteMany({}),
        Store.deleteMany({}),
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
})
