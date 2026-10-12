'use strict';

const { validateStoreSlug } = require('./storeSlug');

// Public storefront routing and canonical URLs use the assigned DNS slug,
// not the store's display name or the main-site /store development route.
// A saved address does not by itself prove that a store is currently visible.
const storefrontNotificationUrl = store => {
  if (['pending', 'blocked'].includes(store?.moderationStatus)) return '';
  const validated = validateStoreSlug(store?.storeSlug);
  return validated.valid ? `https://${validated.slug}.rozare.com/` : '';
};

module.exports = { storefrontNotificationUrl };
