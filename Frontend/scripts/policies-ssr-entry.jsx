import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import CommercePolicyPage from '../src/pages/CommercePolicyPage.jsx';
import PrivacyPolicy from '../src/pages/PrivacyPolicy.jsx';
import { commercePolicies } from '../../MobileApp/src/content/commercePolicies.js';

export const policyRoutes = [...Object.entries(commercePolicies).map(([key, document]) => ({ key, path: document.path })), { key: 'privacy', path: '/privacy' }];
export function renderPolicy(key, path) {
  const context = {};
  const html = renderToString(<HelmetProvider context={context}><StaticRouter location={path}>{key === 'privacy' ? <PrivacyPolicy /> : <CommercePolicyPage policy={key} />}</StaticRouter></HelmetProvider>);
  return { html, helmet: context.helmet };
}
