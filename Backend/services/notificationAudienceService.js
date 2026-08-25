const VALID_NOTIFICATION_ROLES = new Set(['user', 'seller', 'admin']);
const VALID_NOTIFICATION_SURFACES = new Set(['buyer', 'seller', 'admin']);
const VALID_BROADCAST_AUDIENCES = new Set(['all_users', 'all_sellers', 'both', 'specific']);

const SELLER_LINK_PATTERN = /\/(?:seller-dashboard|seller)(?:\/|$)/i;
const ADMIN_LINK_PATTERN = /\/admin-dashboard(?:\/|$)/i;

function normalizeNotificationRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_NOTIFICATION_ROLES.has(role) ? role : null;
}

function normalizeBroadcastAudience(value) {
  const audience = String(value || '').trim().toLowerCase();
  return VALID_BROADCAST_AUDIENCES.has(audience) ? audience : null;
}

function normalizeNotificationSurface(value) {
  const surface = String(value || '').trim().toLowerCase();
  return VALID_NOTIFICATION_SURFACES.has(surface) ? surface : null;
}

function notificationSurfaceAllowedForRole(surfaceValue, roleValue) {
  const surface = normalizeNotificationSurface(surfaceValue);
  const role = normalizeNotificationRole(roleValue);
  if (!surface || !role) return false;
  if (role === 'user') return surface === 'buyer';
  if (role === 'seller') return surface === 'buyer' || surface === 'seller';
  return role === 'admin' && surface === 'admin';
}

function allowedTargetRoles(role) {
  if (role === 'user') return ['user', 'both'];
  if (role === 'seller') return ['seller', 'both'];
  if (role === 'admin') return ['admin'];
  return [];
}

function allowedBroadcastAudiences(role) {
  if (role === 'user') return ['all_users', 'both'];
  if (role === 'seller') return ['all_sellers', 'both'];
  return [];
}

/**
 * Build the server-side role boundary for persistent notifications.
 *
 * New records are governed by targetRole. Legacy records did not have role
 * metadata, so they are restricted by the same category/deep-link signals the
 * mobile client understands. The legacy branch is deliberately fail-closed
 * for seller/admin routes so role changes cannot surface privileged history.
 */
function buyerLegacyIntent() {
  return {
    $and: [
      { targetRole: null },
      { $or: [{ audience: null }, { audience: 'specific' }] },
      { source: { $ne: 'admin_broadcast' } },
      { category: { $nin: ['seller', 'subscription'] } },
      { linkTo: { $not: SELLER_LINK_PATTERN } },
      { linkTo: { $not: ADMIN_LINK_PATTERN } },
    ],
  };
}

function sellerLegacyIntent() {
  return {
    $and: [
      { targetRole: null },
      { $or: [{ audience: null }, { audience: 'specific' }] },
      { source: { $ne: 'admin_broadcast' } },
      { linkTo: { $not: ADMIN_LINK_PATTERN } },
      {
        $or: [
          { category: { $in: ['seller', 'subscription'] } },
          { linkTo: SELLER_LINK_PATTERN },
        ],
      },
    ],
  };
}

function buildNotificationSurfaceFilter(role, surface) {
  if (!notificationSurfaceAllowedForRole(surface, role)) {
    return { _id: { $in: [] } };
  }

  if (surface === 'buyer') {
    if (role === 'seller') {
      // Buyer-commerce outbox rows deliberately use `both` so an account that
      // later becomes a seller can still receive its purchases. Keep those
      // rows out of the seller-business surface while retaining them here.
      return {
        $or: [
          { targetRole: 'both' },
          buyerLegacyIntent(),
        ],
      };
    }
    return buildNotificationRoleFilter(role);
  }

  if (surface === 'seller') {
    return {
      $or: [
        { targetRole: 'seller' },
        {
          $and: [
            { targetRole: null },
            { audience: { $in: ['all_sellers', 'both'] } },
          ],
        },
        sellerLegacyIntent(),
      ],
    };
  }

  return buildNotificationRoleFilter(role);
}

function buildNotificationRoleFilter(value) {
  const role = normalizeNotificationRole(value);
  if (!role) return { _id: { $in: [] } };

  const explicitTarget = { targetRole: { $in: allowedTargetRoles(role) } };
  const missingTarget = { targetRole: null };
  const roleAudiences = allowedBroadcastAudiences(role);

  const audienceFallback = roleAudiences.length
    ? {
        $and: [
          missingTarget,
          { audience: { $in: roleAudiences } },
        ],
      }
    : null;

  let legacyIntent;
  if (role === 'user') {
    // Historical broadcasts have a BroadcastJob reference but no role
    // snapshot. Their original role cannot be proven from this document, so
    // the shared legacy helper hides them rather than guessing after a role
    // change.
    legacyIntent = buyerLegacyIntent();
  } else if (role === 'seller') {
    legacyIntent = {
      $and: [
        missingTarget,
        { $or: [{ audience: null }, { audience: 'specific' }] },
        { source: { $ne: 'admin_broadcast' } },
        { linkTo: { $not: ADMIN_LINK_PATTERN } },
      ],
    };
  } else {
    legacyIntent = {
      $and: [
        missingTarget,
        { $or: [{ audience: null }, { audience: 'specific' }] },
        { source: { $ne: 'admin_broadcast' } },
        { category: { $in: ['announcement', 'system'] } },
        { linkTo: { $not: SELLER_LINK_PATTERN } },
      ],
    };
  }

  return {
    $or: [explicitTarget, audienceFallback, legacyIntent].filter(Boolean),
  };
}

function buildScopedNotificationQuery({ userId, role, read, surface } = {}) {
  const query = {
    user: userId,
    ...(surface === undefined || surface === null
      ? buildNotificationRoleFilter(role)
      : buildNotificationSurfaceFilter(role, surface)),
  };
  if (typeof read === 'boolean') query.read = read;
  return query;
}

module.exports = {
  ADMIN_LINK_PATTERN,
  SELLER_LINK_PATTERN,
  VALID_BROADCAST_AUDIENCES,
  VALID_NOTIFICATION_SURFACES,
  buildNotificationRoleFilter,
  buildNotificationSurfaceFilter,
  buildScopedNotificationQuery,
  normalizeBroadcastAudience,
  normalizeNotificationRole,
  normalizeNotificationSurface,
  notificationSurfaceAllowedForRole,
};
