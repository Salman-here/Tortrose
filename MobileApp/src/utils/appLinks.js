const reservedHosts = new Set(['www', 'api', 'admin', 'app', 'docs', 'ai-automations', 'help', 'blog', 'mail', 'cdn', 'static']);
const mongoId = /^[a-f\d]{24}$/i;
const slugPattern = /^[a-z\d](?:[a-z\d-]{1,61}[a-z\d])$/;
const storeSlug = value => slugPattern.test(value) && !reservedHosts.has(value) ? value : null;

export function trustedRozareWebUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'rozare.com' || /^[a-z\d-]+\.rozare\.com$/.test(url.hostname)) return url;
  } catch { /* Invalid/untrusted links are not navigation authority. */ }
  return null;
}

// One normal HTTPS URL serves both native and website users. These mappings
// do not authorize purchases, confirmation actions or private order access.
export function normalizeRozareAppLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  if (/^rozare:\/\//i.test(value)) return value;
  const url = trustedRozareWebUrl(value); if (!url) return null;
  let path; try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; } catch { return null; }
  if (/[\u0000-\u001f\\]/.test(path) || path.includes('//')) return null;
  const host = url.hostname, main = ['rozare.com', 'www.rozare.com'].includes(host);
  const slug = !main ? storeSlug(host.slice(0, -'.rozare.com'.length)) : null;
  if (!main && !slug) return null;
  if (path === '/') return slug ? `rozare://store/${slug}` : 'rozare://';
  const product = path.match(/^\/single-product\/([^/]+)$/i);
  if (product) return mongoId.test(product[1]) ? `rozare://single-product/${product[1].toLowerCase()}` : null;
  const store = path.match(/^\/store\/([^/]+)$/i);
  if (store) { const target = storeSlug(store[1].toLowerCase()); return target ? `rozare://store/${target}` : null; }
  if (!main) return null;
  if (['/marketplace', '/track-order', '/orders'].includes(path)) return 'rozare:/' + path;
  if (path === '/user-dashboard/orders') return 'rozare://orders';
  const order = path.match(/^\/(?:user-dashboard\/order\/(?:detail\/)?|order\/)([^/]+)$/);
  if (order) return mongoId.test(order[1]) ? `rozare://order/${order[1].toLowerCase()}` : null;
  const confirmation = path.match(/^\/orders\/confirm\/([a-f\d]{64})$/i);
  if (confirmation) {
    const intent = url.searchParams.get('intent');
    return `rozare://orders/confirm/${confirmation[1]}${['confirm', 'cancel'].includes(intent) ? `?intent=${intent}` : ''}`;
  }
  return null;
}

export function createAppLinkHandlers({ linking, openBrowser, ownsReturn = () => false }) {
  const handle = raw => {
    // The active Safepay presenter alone owns its matching return callback.
    if (ownsReturn(raw)) return null;
    const target = normalizeRozareAppLink(raw);
    if (target) return target;
    const web = trustedRozareWebUrl(raw);
    // Unsupported pages (including admin and platform-only subdomains) stay
    // in a real browser. An explicit browser session avoids an App Link loop.
    if (web) Promise.resolve().then(() => openBrowser(web.href)).catch(() => {});
    return null;
  };
  return {
    prefixes: ['rozare://'],
    async getInitialURL() { return handle(await linking.getInitialURL()); },
    subscribe(listener) {
      const subscription = linking.addEventListener('url', event => { const target = handle(event.url); if (target) listener(target); });
      return () => subscription.remove();
    },
  };
}
