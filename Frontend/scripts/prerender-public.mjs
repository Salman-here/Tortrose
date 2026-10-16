import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clearPrerenderSeoFallbacks } from './prerender-head.mjs';

const { publicPageRoutes, renderPublicPage } = await import(pathToFileURL(resolve('dist-ssr-public/public-pages-ssr-entry.js')));
const template = readFileSync(resolve('dist/index.html'), 'utf8');
for (const page of publicPageRoutes) {
  const { html, helmet } = renderPublicPage(page.key);
  const head = [helmet.title, helmet.meta, helmet.link, helmet.script].map(value => value?.toString() || '').join('\n');
  const document = clearPrerenderSeoFallbacks(template).replace('</head>', `${head}\n</head>`)
    .replace('<div id="root"></div>', `<div id="root">${html}</div>`);
  writeFileSync(resolve(`dist/public-${page.key}.html`), document);
  console.log(`Prerendered ${page.path}`);
}
