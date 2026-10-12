'use strict';
jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const { getShippingInfo, updateShippingInfo } = require('../../controllers/userController');
const { listCountries, listStates, listCities } = require('../../services/locationCatalogService');
let mongo;
const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res); return res;
};
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await User.init();
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => { await User.deleteMany({}); });

test.each(['user', 'seller'])('%s profile stores catalog-selected address codes and reloads them for checkout', async role => {
  const owner = await User.create({ username: 'Address Test', email: `${role}-address@example.com`, role, status: 'active' });
  const other = await User.create({ username: 'Other Buyer', email: 'other-address@example.com', status: 'active' });
  const country = listCountries({ q: 'Pakistan', limit: 5 }).find(value => value.isoCode === 'PK');
  const state = listStates({ countryCode: country.isoCode, q: 'Punjab', limit: 5 }).find(value => value.isoCode === 'PB');
  const city = listCities({ countryCode: country.isoCode, stateCode: state.isoCode, q: 'Lahore', limit: 5 }).find(value => value.name === 'Lahore');
  const shippingInfo = { fullName: 'Test Buyer', email: owner.email, phone: '+923001234567', address: '12 Test Street',
    country: country.name, countryCode: country.isoCode, state: state.name, stateCode: city.stateCode,
    city: city.name, postalCode: '54000' };
  const save = response();
  await updateShippingInfo({ user: { id: owner._id }, body: { userId: other._id, shippingInfo } }, save);
  expect(save.status).toHaveBeenCalledWith(200);
  expect((await User.findById(owner._id)).savedShippingInfo.toObject()).toMatchObject(shippingInfo);
  expect((await User.findById(other._id)).savedShippingInfo.city).toBe('');
  const load = response();
  await getShippingInfo({ user: { id: owner._id } }, load);
  expect(load.status).toHaveBeenCalledWith(200);
  expect(load.json.mock.calls[0][0].shippingInfo.toObject()).toMatchObject(shippingInfo);
});
test('updating to another selected country replaces old country and state codes without changing account details', async () => {
  const owner = await User.create({ username: 'Address Test', email: 'address-switch@example.com', status: 'active',
    savedShippingInfo: { fullName: 'Test Buyer', address: '12 Test Street', country: 'Pakistan', countryCode: 'PK', state: 'Punjab', stateCode: 'PB', city: 'Lahore' } });
  const shippingInfo = { fullName: 'Test Buyer', address: '15 Test Avenue', email: owner.email, phone: '+12025550123',
    country: 'United States', countryCode: 'US', state: 'Texas', stateCode: 'TX', city: 'Austin', postalCode: '78701' };
  const res = response();
  await updateShippingInfo({ user: { id: owner._id }, body: { shippingInfo } }, res);
  const updated = await User.findById(owner._id);
  expect(updated.savedShippingInfo.toObject()).toMatchObject(shippingInfo);
  expect(updated.username).toBe(owner.username); expect(updated.email).toBe(owner.email);
});
