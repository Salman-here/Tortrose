// SSR entry for the home page (Products grid)
// Pre-renders the initial shell with SEO metadata for crawlers

import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import SEOHead from '../src/components/common/SEOHead.jsx';
import TestPhaseNotice from '../src/components/common/TestPhaseNotice.jsx';

// Minimal home page shell for SSR
function HomePageShell() {
  const schemaData = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Rozare',
    url: 'https://rozare.com',
    description: 'Rozare is an AI-powered marketplace where shoppers discover products and sellers manage stores through dashboard tools, AI chat, and WhatsApp.',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: 'https://rozare.com/products?search={search_term_string}'
      },
      'query-input': 'required name=search_term_string'
    },
    publisher: {
      '@type': 'Organization',
      name: 'Rozare',
      url: 'https://rozare.com',
      logo: {
        '@type': 'ImageObject',
        url: 'https://rozare.com/rozare-logo.svg'
      }
    }
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: 'https://rozare.com/'
      }
    ]
  };

  return (
    <>
      <SEOHead
        title="Rozare - AI Shopping Marketplace for Buyers & Sellers"
        description="Rozare is an AI-powered marketplace where shoppers discover products from independent sellers and brands, while sellers manage stores through dashboard tools, AI chat, and WhatsApp."
        canonical="/"
        jsonLd={[schemaData, breadcrumbSchema]}
      />
      <TestPhaseNotice />
      <div className="min-h-screen">
        {/* SSR shell - React will hydrate this on client */}
        <div id="products-loading" style={{ 
          minHeight: '60vh', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          opacity: 0.5
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ 
              width: '40px', 
              height: '40px', 
              border: '3px solid rgba(255,255,255,0.1)',
              borderTop: '3px solid #fff',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto'
            }}></div>
            <p style={{ marginTop: '16px', color: 'rgba(255,255,255,0.7)' }}>Loading products...</p>
          </div>
        </div>
      </div>
    </>
  );
}

export function renderHome(url = '/') {
  const helmetContext = {};
  const html = renderToString(
    <HelmetProvider context={helmetContext}>
      <StaticRouter location={url}>
        <HomePageShell />
      </StaticRouter>
    </HelmetProvider>
  );
  return { html, helmet: helmetContext.helmet };
}
