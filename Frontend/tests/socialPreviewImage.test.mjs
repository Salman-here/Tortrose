import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { productShareImage, socialPreviewImage, storeShareImage } from '../src/utils/seoImage.js';

const server = createRequire(import.meta.url)('../../Backend/services/seoPageService.js');
const source = 'https://res.cloudinary.com/dyu9eaqag/image/upload/v1788025500/E-Commerce/product.png';

test('manual-share images have identical URLs and metadata before and after app hydration', () => {
  const samples = [source, source.replace('.png', '.webp'), source.replace('product.png', 'folder/my%20product.jpg'),
    source + '?token=private', source.replace('/v178', '/w_200/v178'), source.replace('/v178', '/s--signed--/v178'),
    source.replace('res.cloudinary.com', 'res.cloudinary.com.evil.example'), 'https://images.example.com/product.png',
    '/store-logo.png', '', null, 'javascript:alert(1)', 'https://user:password@images.example.com/photo.png'];
  for (const value of samples) assert.deepEqual(socialPreviewImage(value), server.socialPreviewImage(value));
  assert.deepEqual(socialPreviewImage(source), { url: 'https://res.cloudinary.com/dyu9eaqag/image/upload/c_pad,w_1200,h_630,b_white/f_jpg/q_auto:good/v1788025500/E-Commerce/product.jpg',
    mimeType: 'image/jpeg', width: 1200, height: 630 });
});

test('preview variants do not replace the original product/gallery images or store logos', () => {
  assert.equal(productShareImage({ image: source }), source);
  assert.equal(storeShareImage({ logo: source }), source);
  assert.equal(socialPreviewImage(socialPreviewImage(source).url).url, socialPreviewImage(source).url);
  assert.deepEqual(socialPreviewImage(false), { url: '' });
});
