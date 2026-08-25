'use strict';

const mockFindOne = jest.fn();
const mockCreate = jest.fn();

jest.mock('../../models/TaxConfig', () => ({
  findOne: mockFindOne,
  create: mockCreate,
}));

const { updateTaxConfig } = require('../../controllers/taxController');

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe('tax money input boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([true, null, '', '   ', [10], Number.POSITIVE_INFINITY])(
    'rejects non-numeric tax input %p before persistence',
    async value => {
      const res = response();
      await updateTaxConfig({
        body: { type: 'fixed', value, currency: 'USD' },
        user: { id: 'admin-1' },
      }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockFindOne).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test('rejects a fixed tax outside the safe money range', async () => {
    const res = response();
    await updateTaxConfig({
      body: { type: 'fixed', value: Number.MAX_VALUE, currency: 'USD' },
      user: { id: 'admin-1' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: 'Tax value is too large',
    }));
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  test('rejects a percentage tax with more than six decimal places', async () => {
    const res = response();
    await updateTaxConfig({
      body: { type: 'percentage', value: '7.1234567', currency: 'USD' },
      user: { id: 'admin-1' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('six decimal'),
    }));
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('persists a percentage tax that is exact to six decimal places', async () => {
    const taxConfig = {
      type: 'none',
      value: 0,
      currency: 'USD',
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(taxConfig);
    const res = response();

    await updateTaxConfig({
      body: { type: 'percentage', value: '7.123456', currency: 'PKR' },
      user: { id: 'admin-1' },
    }, res);

    expect(taxConfig).toMatchObject({
      type: 'percentage',
      value: 7.123456,
      currency: 'USD',
    });
    expect(taxConfig.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test.each(['0.004', '1.005'])(
    'rejects a fixed tax %s that is not exact to cents',
    async value => {
    const res = response();
    await updateTaxConfig({
      body: { type: 'fixed', value, currency: 'PKR' },
      user: { id: 'admin-1' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      msg: expect.stringContaining('exact amount'),
    }));
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test('keeps an explicit zero fixed tax valid', async () => {
    const taxConfig = {
      type: 'none',
      value: 1,
      currency: 'USD',
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(taxConfig);
    const res = response();

    await updateTaxConfig({
      body: { type: 'fixed', value: 0, currency: 'PKR' },
      user: { id: 'admin-1' },
    }, res);

    expect(taxConfig).toMatchObject({ value: 0, currency: 'PKR' });
    expect(taxConfig.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('canonicalizes a disabled tax type to zero instead of retaining a hidden amount', async () => {
    const taxConfig = {
      type: 'fixed',
      value: 25,
      currency: 'PKR',
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(taxConfig);
    const res = response();

    await updateTaxConfig({
      body: { type: 'none', value: 25, currency: 'PKR' },
      user: { id: 'admin-1' },
    }, res);

    expect(taxConfig).toMatchObject({ type: 'none', value: 0, currency: 'USD' });
    expect(taxConfig.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test('persists an exact-cent fixed tax without changing its amount', async () => {
    const taxConfig = {
      type: 'none',
      value: 0,
      currency: 'USD',
      save: jest.fn().mockResolvedValue(undefined),
    };
    mockFindOne.mockResolvedValue(taxConfig);
    const res = response();

    await updateTaxConfig({
      body: { type: 'fixed', value: '1.01', currency: 'USD' },
      user: { id: 'admin-1' },
    }, res);

    expect(taxConfig.value).toBe(1.01);
    expect(taxConfig.currency).toBe('USD');
    expect(taxConfig.save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
