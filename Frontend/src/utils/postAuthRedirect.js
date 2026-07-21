const STORAGE_KEY = 'rozare_post_auth_redirect';

export const sanitizePostAuthRedirect = (value, fallback = '') => {
  if (typeof value !== 'string' || !value.trim()) return fallback;

  try {
    const base = 'https://rozare.local';
    const parsed = new URL(value.trim(), base);
    if (parsed.origin !== base || !parsed.pathname.startsWith('/')) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
};

export const rememberPostAuthRedirect = (value) => {
  const redirect = sanitizePostAuthRedirect(value);
  if (!redirect) return '';

  try {
    window.sessionStorage.setItem(STORAGE_KEY, redirect);
  } catch {
    return '';
  }
  return redirect;
};

export const consumePostAuthRedirect = (fallback = '/') => {
  try {
    const redirect = sanitizePostAuthRedirect(window.sessionStorage.getItem(STORAGE_KEY));
    window.sessionStorage.removeItem(STORAGE_KEY);
    return redirect || fallback;
  } catch {
    return fallback;
  }
};

export const clearPostAuthRedirect = () => {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};
