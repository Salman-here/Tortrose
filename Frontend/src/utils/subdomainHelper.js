// Helper functions for subdomain detection and handling

export const getSubdomain = () => {
    const host = window.location.hostname;
    const parts = host.split('.');
    
    // If localhost or IP, no subdomain
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return null;
    }
    
    // Skip preview/deployment platforms
    const skipDomains = ['lovableproject.com', 'lovable.app', 'vercel.app', 'netlify.app', 'pages.dev'];
    if (skipDomains.some(domain => host.endsWith(domain))) {
        return null;
    }
    
    // If more than 2 parts (e.g., storename.rozare.com)
    if (parts.length > 2) {
        const subdomain = parts[0];
        
        // Skip common subdomains (incl. reserved system subdomains like docs)
        if (RESERVED_SUBDOMAINS.includes(subdomain.toLowerCase())) {
            return null;
        }
        
        return subdomain;
    }
    
    return null;
};

// Subdomains that are NOT stores — system/reserved
export const RESERVED_SUBDOMAINS = ['www', 'api', 'admin', 'app', 'docs', 'ai-automations', 'help', 'blog', 'mail', 'cdn', 'static'];

// Detect if current host is the docs subdomain (docs.rozare.com)
export const isDocsSubdomain = () => {
    const host = window.location.hostname;
    const parts = host.split('.');
    return parts.length > 2 && parts[0].toLowerCase() === 'docs';
};

// Build the docs URL — subdomain in production, /docs path locally
export const getDocsUrl = (path = '') => {
    const host = window.location.hostname;
    const protocol = window.location.protocol;
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return `/docs${path}`;
    }
    const skipDomains = ['lovableproject.com', 'lovable.app', 'vercel.app', 'netlify.app', 'pages.dev'];
    if (skipDomains.some(d => host.endsWith(d))) {
        return `/docs${path}`;
    }
    const mainDomain = getMainDomain();
    return `${protocol}//docs.${mainDomain}${path}`;
};

export const isSubdomain = () => {
    return getSubdomain() !== null;
};

export const getMainDomain = () => {
    const host = window.location.hostname;
    
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return `${host}${window.location.port ? `:${window.location.port}` : ''}`;
    }
    
    const parts = host.split('.');
    
    // Return last two parts (e.g., rozare.com)
    if (parts.length >= 2) {
        return parts.slice(-2).join('.');
    }
    
    return host;
};

export const redirectToMainDomain = (path = '/') => {
    window.location.href = getMainDomainUrl(path);
};

export const getMainDomainUrl = (path = '/') => {
    const mainDomain = getMainDomain();
    const protocol = window.location.protocol;
    const safePath = path.startsWith('/') ? path : `/${path}`;
    return `${protocol}//${mainDomain}${safePath}`;
};

export const getStoreSubdomainUrl = (storeSlug) => {
    const protocol = window.location.protocol;
    const mainDomain = getMainDomain();
    
    if (mainDomain.includes('localhost')) {
        // For local development, use path-based routing
        return `/store/${storeSlug}`;
    }
    
    return `${protocol}//${storeSlug}.${mainDomain}`;
};

// Navigate to a store using the appropriate URL strategy.
// In production -> full page load to subdomain. In local -> SPA navigate.
export const navigateToStore = (storeSlug, navigate) => {
    const url = getStoreSubdomainUrl(storeSlug);
    if (url.startsWith('http')) {
        window.location.href = url;
    } else if (typeof navigate === 'function') {
        navigate(url);
    } else {
        window.location.href = url;
    }
};

// Navigate to main domain (remove subdomain) for non-store pages
export const navigateToMainDomainPath = (path = '/') => {
    const currentSubdomain = getSubdomain();
    
    // If not on a subdomain, use normal navigation
    if (!currentSubdomain) {
        return null; // Let React Router handle it
    }
    
    // If on a subdomain, redirect to main domain
    const mainDomain = getMainDomain();

    // For localhost, just navigate normally
    if (mainDomain.includes('localhost')) {
        return null;
    }
    
    // Full redirect to main domain
    window.location.href = getMainDomainUrl(path);
    return true; // Indicate redirect happened
};

export const isStorefrontSubdomainPath = (path = '/') => {
    if (path === '/' || path === '') return true;
    if (/^\/single-product\/[^/]+\/?$/.test(path)) return true;
    if (/^\/store\/[^/]+\/?$/.test(path)) return true;
    return false;
};
