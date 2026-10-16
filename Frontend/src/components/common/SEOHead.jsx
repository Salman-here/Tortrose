import { Helmet } from 'react-helmet-async';
import { DEFAULT_SHARE_IMAGE, publicImageUrl } from '../../utils/seoImage';
import { publicSeoPage } from '../../content/publicSeoPages';

const SITE_NAME    = 'Rozare';
const SITE_URL     = 'https://rozare.com';
const TWITTER_SITE = '@RozareHQ';
const DEFAULT_DESC = 'Rozare is an AI-powered marketplace where shoppers discover products from independent sellers and brands, while sellers manage storefronts through dashboard tools, AI chat, and WhatsApp.';
const DEFAULT_IMG  = DEFAULT_SHARE_IMAGE;
const DEFAULT_KEYWORDS = 'rozare, rozare marketplace, rozare.com, AI shopping, AI marketplace, online shopping, buy online, shop online, e-commerce, marketplace, online store, independent sellers, brands, trusted stores, secure checkout, multi-currency, coupons, electronics, fashion, home decor, beauty products, accessories, jewelry, shoes, clothing, gadgets, trending products, new arrivals, order tracking, wishlist, product reviews, seller dashboard, WhatsApp store management, AI store assistant, become a seller, sell online';

export default function SEOHead({
  page,
  title,
  description,
  canonical,
  ogType    = 'website',
  ogImage   = DEFAULT_IMG,
  ogImageAlt,
  ogImageWidth,
  ogImageHeight,
  noindex   = false,
  keywords,
  jsonLd,
  children,
}) {
  const sharedPage = publicSeoPage(page);
  title = title || sharedPage?.title;
  description = description || sharedPage?.description || DEFAULT_DESC;
  canonical = canonical || sharedPage?.path;
  const fullTitle    = title ? (/\bRozare\b/i.test(title) ? title : `${title} | ${SITE_NAME}`) : `${SITE_NAME} - AI Shopping Marketplace`;
  const canonicalUrl = canonical
    ? (/^https?:\/\//i.test(canonical)
      ? canonical
      : `${SITE_URL}${canonical.startsWith('/') ? canonical : `/${canonical}`}`)
    : null;
  const imageAlt     = ogImageAlt || fullTitle;
  const imageUrl     = publicImageUrl(ogImage) || DEFAULT_IMG;
  const allKeywords  = keywords ? `${keywords}, ${DEFAULT_KEYWORDS}` : DEFAULT_KEYWORDS;

  return (
    <Helmet>
      {/* ── Primary ───────────────────────────── */}
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta name="keywords" content={allKeywords} />
      <meta name="robots" content={noindex ? 'noindex, nofollow, noarchive, nosnippet' : 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1'} />
      {canonicalUrl && <link rel="canonical" href={canonicalUrl} />}

      {/* ── Open Graph ────────────────────────── */}
      <meta property="og:site_name"   content={SITE_NAME} />
      <meta property="og:locale"      content="en_US" />
      <meta property="og:type"        content={ogType} />
      <meta property="og:title"       content={fullTitle} />
      <meta property="og:description" content={description} />
      {canonicalUrl && <meta property="og:url" content={canonicalUrl} />}
      <meta property="og:image"       content={imageUrl} />
      {imageUrl.startsWith('https://') && <meta property="og:image:secure_url" content={imageUrl} />}
      <meta property="og:image:alt"   content={imageAlt} />
      {ogImageWidth > 0 && <meta property="og:image:width" content={String(ogImageWidth)} />}
      {ogImageHeight > 0 && <meta property="og:image:height" content={String(ogImageHeight)} />}

      {/* ── Twitter Card ──────────────────────── */}
      <meta name="twitter:card"        content="summary_large_image" />
      <meta name="twitter:site"        content={TWITTER_SITE} />
      <meta name="twitter:creator"     content={TWITTER_SITE} />
      <meta name="twitter:title"       content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image"       content={imageUrl} />
      <meta name="twitter:image:alt"   content={imageAlt} />

      {/* ── JSON-LD Structured Data ───────────── */}
      {jsonLd && (
        <script type="application/ld+json">{JSON.stringify(jsonLd).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}</script>
      )}

      {children}
    </Helmet>
  );
}
