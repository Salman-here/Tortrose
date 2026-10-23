export const ANDROID_PACKAGE = 'com.rozare.app';
// Public certificate from the verified Expo production APK, not a private key.
export const ANDROID_CERTIFICATES = [
  'FB:16:CC:DD:8C:7C:F8:35:B5:A8:23:20:B2:1B:1D:7C:5E:9E:70:73:44:F6:20:A4:6F:1E:C1:35:70:EF:14:72',
  // Current Play app-signing certificate, verified in Rozare's Play Console.
  'BA:03:70:7C:C6:FB:6D:E5:6D:47:A8:EA:25:8E:6A:BC:8E:F8:79:BA:93:4A:62:2D:8D:D2:6E:2C:50:40:52:BE',
];
export const APP_LINK_PATHS = ['/', '/single-product/*', '/store/*', '/marketplace', '/track-order', '/orders', '/user-dashboard/orders', '/user-dashboard/order/*', '/order/*', '/orders/confirm/*'];
export const androidAssociations = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_CERTIFICATES },
  relation_extensions: { 'delegate_permission/common.handle_all_urls': {
    dynamic_app_link_components: [...APP_LINK_PATHS.map(path => ({ '/': path })), { '/': '*', exclude: true }],
  } },
}];

export function appAssociationResponse(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/.well-known/assetlinks.json') return null;
  if (!(url.hostname === 'rozare.com' || /^[a-z\d-]+\.rozare\.com$/.test(url.hostname))) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(androidAssociations), { headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
  } });
}
