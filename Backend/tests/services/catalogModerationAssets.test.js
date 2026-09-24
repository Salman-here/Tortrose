'use strict';
const { isPinnedCatalogImage, pinCatalogImages } = require('../../services/catalogModerationAssets');
const cloudName = 'moderation-fixture';
const entity = { _id: '64b000000000000000000001', name: 'Cotton Travel Shirt', image: 'https://example.com/shirt.jpg',
  images: [{ url: 'https://example.com/shirt.jpg' }, { url: 'https://example.com/back.gif' }],
  catalogModeration: { revision: '12345678-1234-1234-1234-123456789012', assets: [] } };
const urlFor = publicId => `https://res.cloudinary.com/${cloudName}/image/upload/v123/${publicId}.png`;
const uploaderFor = () => ({ upload: jest.fn(async (_source, options) => ({ public_id: options.public_id, secure_url: urlFor(options.public_id) })) });

test('reviews and publishes identical immutable image copies, including every distinct gallery image', async () => {
  const uploader = uploaderFor(), persist = jest.fn();
  const result = await pinCatalogImages('product', entity, { uploader, cloudName, persist });
  expect(uploader.upload).toHaveBeenCalledTimes(2); expect(persist).toHaveBeenCalledTimes(2);
  for (const [, options] of uploader.upload.mock.calls) expect(options).toMatchObject({ overwrite: false, resource_type: 'image', format: 'png', page: 1, timeout: 20000 });
  expect(result.fields.image).toBe(result.fields.images[0].url);
  expect(result.snapshot.images.map(v => v.url)).toEqual(result.fields.images.map(v => v.url));
  expect(result.snapshot.images.every(v => isPinnedCatalogImage(v.url, cloudName))).toBe(true);
  expect(entity.image).toBe('https://example.com/shirt.jpg');
});

test('retries reuse verified copies and never overwrite the original or the review asset', async () => {
  const uploader = uploaderFor(), assets = [];
  const first = await pinCatalogImages('product', entity, { uploader, cloudName, persist: asset => assets.push(asset) });
  uploader.upload.mockClear();
  const retry = await pinCatalogImages('product', { ...entity, catalogModeration: { ...entity.catalogModeration, assets } }, { uploader, cloudName });
  expect(retry.fields).toEqual(first.fields); expect(uploader.upload).not.toHaveBeenCalled();
  await pinCatalogImages('product', { ...entity, ...first.fields }, { uploader, cloudName });
  expect(uploader.upload).not.toHaveBeenCalled();
});

test('rejects transformed, mutable, other-cloud and unexpected image-copy responses', async () => {
  const path = `Rozare/CatalogModeration/product/${entity._id}/${entity.catalogModeration.revision}/abcdef1234567890abcdef12`;
  const good = urlFor(path);
  expect(isPinnedCatalogImage(good, cloudName)).toBe(true);
  for (const value of [good + '?v=2', good + '#x', good.replace('/v123/', '/c_fill/v123/'), good.replace(cloudName, 'other-cloud'), good.replace('/v123/', '/'), good.replace('.png', '.gif')]) expect(isPinnedCatalogImage(value, cloudName)).toBe(false);
  const uploader = { upload: jest.fn(async () => ({ public_id: path, secure_url: 'https://example.com/mutable.png' })) };
  await expect(pinCatalogImages('product', entity, { uploader, cloudName })).rejects.toMatchObject({ code: 'MODERATION_IMAGE_COPY_INVALID' });
  await expect(pinCatalogImages('product', entity, { uploader, cloudName: '' })).rejects.toMatchObject({ code: 'MODERATION_IMAGE_STORAGE_UNAVAILABLE' });
});

test('an unavailable image or failed copy prevents completing the review snapshot', async () => {
  const uploader = { upload: jest.fn(async () => { throw new Error('unavailable'); }) };
  await expect(pinCatalogImages('product', entity, { uploader, cloudName })).rejects.toThrow('unavailable');
  await expect(pinCatalogImages('product', { ...entity, image: 'http://localhost/image', images: [] }, { uploader, cloudName })).rejects.toMatchObject({ code: 'MODERATION_IMAGE_INVALID' });
});
