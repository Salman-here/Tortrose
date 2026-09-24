'use strict';
const crypto = require('node:crypto');
const { cloudinary } = require('../utils/cloudinary');
const { contentSnapshot, publicImageUrl } = require('./catalogContentPolicy');

function isPinnedCatalogImage(value, cloudName = process.env.CLOUDINARY_CLOUD_NAME) {
  if (!cloudName) return false;
  try {
    const url = new URL(value);
    const escaped = String(cloudName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return url.origin === 'https://res.cloudinary.com' && !url.search && !url.hash
      && new RegExp(`^/${escaped}/image/upload/v\\d+/Rozare/CatalogModeration/(?:product|store)/[a-f\\d]{24}/[a-f\\d-]{36}/[a-f\\d]{24}\\.png$`).test(url.pathname);
  } catch (_) { return false; }
}

async function pinCatalogImages(kind, entity, { persist = async () => {}, uploader = cloudinary.uploader, cloudName = process.env.CLOUDINARY_CLOUD_NAME } = {}) {
  const snapshot = contentSnapshot(kind, entity);
  if (!snapshot.images.length) return { snapshot, fields: {} };
  if (!cloudName) throw Object.assign(new Error('Catalog image storage unavailable'), { code: 'MODERATION_IMAGE_STORAGE_UNAVAILABLE' });
  const mappings = new Map((entity.catalogModeration?.assets || [])
    .filter(asset => isPinnedCatalogImage(asset.reviewUrl, cloudName)).map(asset => [asset.sourceUrl, asset.reviewUrl]));
  const pending = snapshot.images.filter(image => !mappings.has(image.url) && !isPinnedCatalogImage(image.url, cloudName));
  let cursor = 0;
  // Bounded concurrency and deterministic IDs avoid duplicate copies when a
  // network retry interrupts a batch. Original uploads are never overwritten.
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (cursor < pending.length) {
      const source = pending[cursor++].url;
      if (!publicImageUrl(source)) throw Object.assign(new Error('Invalid catalog image'), { code: 'MODERATION_IMAGE_INVALID' });
      const digest = crypto.createHash('sha256').update(source).digest('hex').slice(0, 24);
      const publicId = `Rozare/CatalogModeration/${kind}/${entity._id}/${entity.catalogModeration.revision}/${digest}`;
      const uploaded = await uploader.upload(source, { public_id: publicId, resource_type: 'image', overwrite: false,
        // A single static frame prevents unchecked later animation frames.
        format: 'png', page: 1, timeout: 20000 });
      const reviewUrl = uploaded?.secure_url;
      if (uploaded?.public_id !== publicId || !isPinnedCatalogImage(reviewUrl, cloudName)) throw Object.assign(new Error('Unverified image-copy response'), { code: 'MODERATION_IMAGE_COPY_INVALID' });
      await persist({ sourceUrl: source, reviewUrl, publicId });
      mappings.set(source, reviewUrl);
    }
  }));
  const replace = value => mappings.get(String(value || '').trim()) || value;
  const fields = kind === 'product'
    ? { image: replace(entity.image), images: (entity.images || []).map(image => ({ url: replace(typeof image === 'string' ? image : image.url) })) }
    : { logo: replace(entity.logo || ''), banner: replace(entity.banner || '') };
  return { fields, snapshot: contentSnapshot(kind, { ...entity, ...fields }) };
}
module.exports = { isPinnedCatalogImage, pinCatalogImages };
