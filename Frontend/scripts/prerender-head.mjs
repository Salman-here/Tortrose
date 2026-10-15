// Replace only fallback SEO tags; preserve app scripts, fonts and security tags.
export function clearPrerenderSeoFallbacks(template) {
  return template
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\b(?=[^>]*\bdata-rh=["']true["'])[^>]*>/gi, '')
    .replace(/<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/gi, '')
    .replace(/<script\b(?=[^>]*\bdata-rh=["']true["'])(?=[^>]*\btype=["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi, '');
}
