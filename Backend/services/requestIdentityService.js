'use strict';

/** Express computes req.ip from the socket and the configured trust-proxy hop
 * count. Reading forwarding-provider headers directly here would let a client
 * rotate a caller-supplied header and bypass IP rate limits/deduplication. */
const trustedRequestIp = req => String(
  req?.ip || req?.socket?.remoteAddress || 'unknown'
).trim().toLowerCase();

const authenticatedAccountOrIpKey = req => String(
  req?.user?.id || req?.user?._id || trustedRequestIp(req)
);

module.exports = {
  trustedRequestIp,
  authenticatedAccountOrIpKey,
};
