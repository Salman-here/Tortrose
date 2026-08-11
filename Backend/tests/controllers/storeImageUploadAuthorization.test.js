const { storeImage } = require('../../controllers/uploadController');
const { seller } = require('../../middleware/authMiddleware');
const uploadRoutes = require('../../routes/uploadRoutes');

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

describe('store image upload contract', () => {
  test('rejects non-sellers before multipart upload parsing', () => {
    const routeLayer = uploadRoutes.stack.find((layer) => layer.route?.path === '/store-image');
    expect(routeLayer).toBeTruthy();
    expect(routeLayer.route.stack[1].handle).toBe(seller);
    expect(routeLayer.route.stack[2].name).toBe('multerMiddleware');
  });

  test.each([undefined, 'user', 'admin'])(
    'rejects %s role before accepting an uploaded image',
    async (role) => {
      const response = responseMock();
      await storeImage({
        user: role ? { id: 'user-1', role } : undefined,
        file: { path: 'https://cdn.example.com/not-allowed.jpg' },
      }, response);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(response.json).toHaveBeenCalledWith({ msg: 'Seller access required' });
    },
  );

  test('requires a file for authenticated sellers', async () => {
    const response = responseMock();
    await storeImage({ user: { id: 'seller-1', role: 'seller' } }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ msg: 'No file uploaded' });
  });

  test('returns the secure image URL contract used by store settings', async () => {
    const response = responseMock();
    const imageUrl = 'https://res.cloudinary.com/example/image/upload/store.jpg';
    await storeImage({
      user: { id: 'seller-1', role: 'seller' },
      file: { path: imageUrl },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      message: 'Store image uploaded successfully',
      imageUrl,
    });
  });
});
