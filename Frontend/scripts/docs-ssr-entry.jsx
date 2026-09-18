// SSR entry used by `vite build --ssr` to pre-render the Docs page.
// Output is consumed by scripts/prerender-docs.mjs which injects the
// rendered HTML into a copy of dist/index.html as dist/docs-prerendered.html.

import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import DocsPage from '../src/pages/DocsPage.jsx';
import TestPhaseNotice from '../src/components/common/TestPhaseNotice.jsx';

export function renderDocs(url = '/') {
  const helmetContext = {};
  const html = renderToString(
    <HelmetProvider context={helmetContext}>
      <StaticRouter location={url}>
        <TestPhaseNotice />
        <DocsPage />
      </StaticRouter>
    </HelmetProvider>
  );
  return { html, helmet: helmetContext.helmet };
}
