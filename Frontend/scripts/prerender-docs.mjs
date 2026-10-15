// Post-build prerender for the Docs subdomain.
// Reads the SSR bundle, renders <DocsPage /> to HTML, and writes
// dist/docs-prerendered.html with the head meta + rendered #root content.
// Vercel rewrites docs.rozare.com/* → /docs-prerendered.html so crawlers
// (Googlebot, GPTBot, PerplexityBot, ClaudeBot, etc.) receive fully
// rendered HTML on first byte. The client React app then hydrates.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearPrerenderSeoFallbacks } from './prerender-head.mjs';

const root = resolve(process.cwd());
const ssrPath = resolve(root, 'dist-ssr-docs/docs-ssr-entry.js');
const indexPath = resolve(root, 'dist/index.html');
const outPath = resolve(root, 'dist/docs-prerendered.html');

if (!existsSync(ssrPath)) {
  console.error('[prerender-docs] SSR bundle not found at', ssrPath);
  process.exit(1);
}
if (!existsSync(indexPath)) {
  console.error('[prerender-docs] dist/index.html not found');
  process.exit(1);
}

const { renderDocs } = await import(pathToFileURL(ssrPath).href);
const { html, helmet } = renderDocs('/');

let template = clearPrerenderSeoFallbacks(readFileSync(indexPath, 'utf8'));

// Inject Helmet-managed head tags (title, meta, link, script) into <head>.
if (helmet) {
  const headInjection = [
    helmet.title?.toString() || '',
    helmet.meta?.toString() || '',
    helmet.link?.toString() || '',
    helmet.script?.toString() || '',
  ].join('\n');
  template = template.replace('</head>', `${headInjection}\n</head>`);
}

// Inject rendered HTML into the empty <div id="root"></div>.
template = template.replace(
  '<div id="root"></div>',
  `<div id="root">${html}</div>`
);

writeFileSync(outPath, template);
console.log('[prerender-docs] wrote', outPath, `(${template.length} bytes)`);
