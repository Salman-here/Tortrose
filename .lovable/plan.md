

# Professional SEO Plan for Tortrose

## Current State

- Basic meta tags exist in `index.html` (title, viewport)
- No `robots.txt` or `sitemap.xml`
- No per-page dynamic meta tags (all pages share the same `<title>`)
- No JSON-LD structured data
- No canonical URLs
- Duplicate font preconnects
- No PWA manifest
- The `sw.js` is an ad service worker, not a real PWA service worker

## Plan

### 1. Enhanced `index.html` Meta Tags
- Add comprehensive Open Graph and Twitter Card meta tags
- Add canonical link tag
- Add `theme-color` meta tag
- Add `apple-mobile-web-app` meta tags
- Remove duplicate font preconnects
- Optimize title to include keyword-rich description

### 2. Create `react-helmet-async` SEO Component
Install `react-helmet-async` to enable per-page dynamic `<title>`, `<meta description>`, Open Graph, and canonical tags. Create a reusable `<SEOHead>` component that each page can use with custom props.

Pages that will get unique SEO metadata:
- Home (Products) — "Shop Unique Products from Trusted Independent Sellers"
- Product Detail — dynamic product name + description
- Store Page — dynamic store name
- Stores Listing — "Browse All Stores"
- About, Contact, FAQ, Terms, Privacy — static per-page metadata
- Login/Signup — "Sign In / Create Account"

### 3. Create `public/robots.txt`
Allow all crawlers, disallow dashboard routes (`/admin-dashboard`, `/seller-dashboard`, `/user-dashboard`, `/checkout`), and reference the sitemap.

### 4. Create `public/sitemap.xml`
Static sitemap covering all public routes: `/`, `/stores`, `/about`, `/contact`, `/faq`, `/terms`, `/privacy`, `/become-seller`.

### 5. Add JSON-LD Structured Data
- **Organization schema** on the home page (name, logo, URL, social links)
- **BreadcrumbList schema** on key pages
- **WebSite schema** with SearchAction for sitelinks search box

### 6. Create `public/manifest.json`
Proper PWA manifest with app name, icons, theme color, and display mode for better mobile indexing and install prompts.

### 7. Performance SEO in `index.html`
- Add `dns-prefetch` for API domain
- Add `preload` for critical font weights only (trim unused font families from the Google Fonts URL)

## Files to Create
- `Frontend/src/components/common/SEOHead.jsx` — reusable helmet component
- `public/robots.txt`
- `public/sitemap.xml`
- `public/manifest.json`

## Files to Modify
- `index.html` — enhanced meta tags, manifest link, trimmed fonts, structured data
- `Frontend/src/App.jsx` — wrap with `HelmetProvider`
- `Frontend/src/pages/MainLayoutPage.jsx` — add default SEOHead
- Key page components — add `<SEOHead>` with page-specific metadata
- `Frontend/src/pages/ProductDetailPage.jsx` — dynamic product SEO
- `Frontend/src/pages/StorePage.jsx` — dynamic store SEO

## New Dependency
- `react-helmet-async`

