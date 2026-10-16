import axios from 'axios';
import { getAuthToken } from './cookieHelper.js';

let installed = false;

export function catalogViewerRequest(config, apiBase, tokenGetter = getAuthToken) {
  try {
    const base = new URL(apiBase);
    const url = new URL(config.url, base);
    const method = String(config.method || 'get').toLowerCase();
    if (url.origin !== base.origin || url.username || url.password || base.username || base.password || method !== 'get') return config;
    if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) return config;
    if (!/^\/api\/(products|stores)\//.test(url.pathname)) return config;
    const headers = config.headers || {};
    if (headers.has?.('Authorization') || Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) return config;
    const token = tokenGetter();
    if (typeof token !== 'string' || !token) return config;
    if (typeof headers.set === 'function') { headers.set('Authorization', 'Bearer ' + token); return { ...config, headers }; }
    return { ...config, headers: { ...headers, Authorization: 'Bearer ' + token } };
  } catch { return config; }
}

export function installCatalogViewerAuth(apiBase) {
  if (installed || !apiBase) return;
  installed = true;
  // Read the current token at dispatch time so logout/account changes cannot
  // retain an installer-time identity. Only own-origin catalogue GETs qualify.
  axios.interceptors.request.use(config => catalogViewerRequest(config, apiBase));
}
