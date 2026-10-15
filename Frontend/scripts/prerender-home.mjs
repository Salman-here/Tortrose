// Pre-render the home page for SEO
// Similar to prerender-docs.mjs but for the main landing page

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearPrerenderSeoFallbacks } from './prerender-head.mjs';

const root = resolve(process.cwd());
const ssrPath = resolve(root, 'dist-ssr-home/home-ssr-entry.js');
const indexPath = resolve(root, 'dist/index.html');
const outPath = resolve(root, 'dist/home-prerendered.html');

if (!existsSync(ssrPath)) {
  console.error('[prerender-home] SSR bundle not found at', ssrPath);
  process.exit(1);
}
if (!existsSync(indexPath)) {
  console.error('[prerender-home] dist/index.html not found');
  process.exit(1);
}

const { renderHome } = await import(pathToFileURL(ssrPath).href);
const { html, helmet } = renderHome('/');

let template = clearPrerenderSeoFallbacks(readFileSync(indexPath, 'utf8'));

// Inject Helmet-managed head tags
if (helmet) {
  const headInjection = [
    helmet.title?.toString() || '',
    helmet.meta?.toString() || '',
    helmet.link?.toString() || '',
    helmet.script?.toString() || '',
  ].join('\n');
  template = template.replace('</head>', `${headInjection}\n</head>`);
}

// Inject rendered HTML
template = template.replace(
  '<div id="root"></div>',
  `<div id="root">${html}</div>`
);

writeFileSync(outPath, template);
console.log('[prerender-home] wrote', outPath, `(${template.length} bytes)`);
