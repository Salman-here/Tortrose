'use strict';

jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/tiktokEventsApi', () => ({ trackCompleteRegistration: jest.fn() }));
jest.mock('../../services/metaConversionsApi', () => ({ trackSellerLead: jest.fn() }));
let mockGoogleVerify, mockGoogleOptions;
jest.mock('passport-google-oauth20', () => ({ Strategy: class {
  constructor(options, verify) { mockGoogleOptions = options; mockGoogleVerify = verify; }
} }));
jest.mock('passport', () => ({ use: jest.fn(), authenticate: jest.fn((_strategy, options) => (_req, res) => res.json({ state: options.state })) }));

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const OTP = require('../../models/OTP');
const { sendEmail } = require('../../controllers/mailController');
const { mobileGoogleRegistration } = require('../../services/registrationCurrencyService');
const previous = { ...process.env };
const app = express(); app.use(express.json()); app.use('/auth', require('../../routes/authRoutes'));
let database;
beforeAll(async () => {
  Object.assign(process.env, { JWT_SECRET: 'registration-currency-qa-secret', clientID: 'registration-qa-client',
    clientSecret: 'registration-qa-secret', GOOGLE_CALLBACK_URL: 'https://example.test/auth/google/callback' });
  require('../../middleware/googleStreatgy');
  database = await MongoMemoryServer.create(); await mongoose.connect(database.getUri());
  await Promise.all([User.init(), OTP.init()]);
}, 120000);
beforeEach(async () => { jest.clearAllMocks(); await User.deleteMany({}); await OTP.deleteMany({}); });
afterAll(async () => { process.env = previous; await mongoose.disconnect(); await database?.stop(); });
const signup = currency => ({ username: 'Currency QA', email: 'registration-currency@example.test', password: 'Registration-QA-123',
  ...(currency === undefined ? {} : { currency }) });

test.each(['PKR', 'EUR', 'GBP', 'USD'])('email signup freezes %s in the OTP and returns that currency for the new session', async currency => {
  await request(app).post('/auth/send-otp').send(signup(currency)).expect(200);
  const challenge = await OTP.findOne({ email: signup().email });
  expect(challenge.userData.currency).toBe(currency);
  // Verification cannot substitute a different currency or elevate the role.
  const verified = await request(app).post('/auth/verify-otp').send({ email: signup().email, otp: challenge.otp, currency: 'GBP', role: 'admin' }).expect(200);
  expect(verified.body.user).toMatchObject({ currency, role: 'user' });
  const saved = await User.findOne({ email: signup().email });
  expect(saved.currency).toBe(currency); expect(saved.role).toBe('user');
  expect(await OTP.countDocuments()).toBe(0);
});

test('legacy clients without a supplied currency can still finish signup', async () => {
  await request(app).post('/auth/send-otp').send(signup()).expect(200);
  const challenge = await OTP.findOne({ email: signup().email });
  const verified = await request(app).post('/auth/verify-otp').send({ email: signup().email, otp: challenge.otp }).expect(200);
  expect(verified.body.user.currency).toBe('USD');
});

test.each(['CAD', '', null, ['PKR'], { currency: 'PKR' }])('invalid signup currency %p is rejected before sending mail or saving a code', async currency => {
  await request(app).post('/auth/send-otp').send(signup(currency)).expect(400);
  expect(await OTP.countDocuments()).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
});

test('a duplicate signup cannot replace an existing account currency', async () => {
  await User.create({ ...signup('EUR'), isVerified: true });
  await request(app).post('/auth/send-otp').send(signup('PKR')).expect(409);
  expect((await User.findOne({ email: signup().email })).currency).toBe('EUR');
  expect(sendEmail).not.toHaveBeenCalled();
});

test.each(['PKR', 'EUR', 'GBP', 'USD'])('mobile Google signup carries only the supported %s preference in its state', async currency => {
  const response = await request(app).get('/auth/google/mobile').query({ currency }).expect(200);
  expect(response.body.state).toBe(`mobile:${currency}`);
  expect(mobileGoogleRegistration(response.body.state)).toEqual({ isMobile: true, currency });
});

test.each(['mobile', 'mobile:PKR'])('Google creates a new account using the optional mobile signup preference %s', async state => {
  expect(mockGoogleOptions.passReqToCallback).toBe(true);
  const done = jest.fn();
  await mockGoogleVerify({ query: { state } }, 'unused-access', 'unused-refresh', {
    displayName: 'Google Currency QA', emails: [{ value: signup().email }], photos: [{ value: 'https://example.test/avatar.png' }],
  }, done);
  expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ currency: state === 'mobile' ? 'USD' : 'PKR' }));
  expect((await User.findOne({ email: signup().email })).currency).toBe(state === 'mobile' ? 'USD' : 'PKR');
});

test('Google sign-in never replaces an existing USD preference with the new-device PKR hint', async () => {
  await User.create({ ...signup('USD'), isVerified: true }); const done = jest.fn();
  await mockGoogleVerify({ query: { state: 'mobile:PKR' } }, 'unused-access', 'unused-refresh', {
    displayName: 'Google Currency QA', emails: [{ value: signup().email }], photos: [],
  }, done);
  expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ currency: 'USD' }));
  expect((await User.findOne({ email: signup().email })).currency).toBe('USD');
});

test.each(['mobile:CAD', 'mobile:PKR:admin', 'seller', 'https://example.test', ['mobile']])('unrecognized Google state %p never supplies a currency', state => {
  expect(mobileGoogleRegistration(state)).toEqual({ isMobile: false, currency: undefined });
});
