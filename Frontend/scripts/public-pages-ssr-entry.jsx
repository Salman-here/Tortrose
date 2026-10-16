import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import SEOHead from '../src/components/common/SEOHead.jsx';
import TestPhaseNotice from '../src/components/common/TestPhaseNotice.jsx';
import { publicSeoPages } from '../src/content/publicSeoPages.js';
import { commerceFaqCategories } from '../../MobileApp/src/content/commerceHelpContent.js';
import { policyConfig } from '../../MobileApp/src/content/commercePolicies.js';

export const publicPageRoutes = publicSeoPages;
export function renderPublicPage(key) {
  const page = publicSeoPages.find(candidate => candidate.key === key);
  if (!page) throw Error('Unknown public page');
  const context = {};
  const jsonLd = page.key === 'faq'
    ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: commerceFaqCategories.flatMap(category => category.questions.map(item => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } }))) }
    : { '@context': 'https://schema.org', '@type': page.key === 'about' ? 'AboutPage' : page.key === 'contact' ? 'ContactPage' : 'WebPage', name: page.title, description: page.description, url: 'https://rozare.com' + page.path };
  const html = renderToString(<HelmetProvider context={context}><StaticRouter location={page.path}>
    <SEOHead page={page.path} jsonLd={jsonLd} />
    <TestPhaseNotice />
    <main data-commerce-content className="max-w-4xl mx-auto px-4 py-10">
      <nav aria-label="Site navigation" className="flex flex-wrap gap-5 mb-8"><a href="/">Rozare</a><a href="/marketplace">Stores</a><a href="/faq">Help</a></nav>
      <section className="glass-panel p-6 sm:p-9"><h1 className="text-3xl font-bold mb-5">{page.heading}</h1>
        {page.paragraphs.map(paragraph => <p key={paragraph} className="mb-4 leading-relaxed">{paragraph}</p>)}
        {page.key === 'contact' && <p><a href={'mailto:' + policyConfig.supportEmail}>{policyConfig.supportEmail}</a></p>}
        {page.key === 'faq' && commerceFaqCategories.map(category => <section key={category.id} className="mt-8"><h2 className="text-xl font-semibold mb-4">{category.category}</h2>{category.questions.map(item => <details key={item.id} className="glass-inner p-4 mb-3" open><summary className="font-semibold">{item.q}</summary><p className="mt-3">{item.a}</p><nav className="flex flex-wrap gap-4 mt-3">{item.links.map(link => <a key={link.path} href={link.path}>{link.label}</a>)}</nav></details>)}</section>)}
        {page.key === 'selling' && <p><a href="/become-seller">Open seller registration</a></p>}
        {page.key === 'tracking' && <p><a href="/user-dashboard/orders">Open Your Orders</a></p>}
        <nav aria-label="Policies" className="flex flex-wrap gap-4 mt-8 text-sm"><a href="/terms">Terms and Conditions</a><a href="/refund-policy">Returns and Refunds</a><a href="/privacy">Privacy</a><a href="/contact">Contact</a></nav>
      </section>
    </main>
  </StaticRouter></HelmetProvider>);
  return { html, helmet: context.helmet };
}
