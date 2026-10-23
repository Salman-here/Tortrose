'use strict';

const PLATFORM_HOSTS = new Set(['www', 'docs', 'app', 'admin', 'api', 'ai-automations']);
const SENSITIVE_QUERY = /^(?:token|email|orderid|paymentid|session_id|.*secret.*|.*password.*|.*token.*)$/i;

const isRozareUrl = url => url.hostname === 'rozare.com' || url.hostname.endsWith('.rozare.com');
const isPublicCatalogUrl = url => {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if ([...url.searchParams.keys()].some(key => SENSITIVE_QUERY.test(key))) return false;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (['rozare.com', 'www.rozare.com'].includes(url.hostname)) {
    return /^\/single-product\/[a-f\d]{24}$/i.test(path)
      || /^\/store\/[a-z\d](?:[a-z\d-]{1,61}[a-z\d])$/i.test(path);
  }
  const slug = url.hostname.slice(0, -'.rozare.com'.length);
  return (path === '/' || /^\/single-product\/[a-f\d]{24}$/i.test(path))
    && /^[a-z\d](?:[a-z\d-]{1,61}[a-z\d])$/.test(slug) && !PLATFORM_HOSTS.has(slug);
};

// Do not let order/account/reset/confirmation links produce branded cards or
// cause the gateway's preview fetcher to visit a private/token-bearing URL.
// Catalog shares retain previews; unrelated external links retain their old
// provider behavior. A mixed message containing a private link fails closed.
const messageLinkPreview = text => {
  const urls = [...String(text || '').matchAll(/https?:\/\/[^\s<>]+/gi)].flatMap(match => {
    try { return [new URL(match[0].replace(/[)\]},.;!?]+$/, ''))]; } catch (_) { return []; }
  });
  const internal = urls.filter(isRozareUrl);
  if (!internal.length) return undefined;
  return internal.every(isPublicCatalogUrl);
};

module.exports = { messageLinkPreview, isPublicCatalogUrl };
