import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { policyRoutes, renderPolicy } = await import(pathToFileURL(resolve('dist-ssr-policies/policies-ssr-entry.js')));
const template = readFileSync(resolve('dist/index.html'), 'utf8');
for (const { key, path } of policyRoutes) {
  const { html, helmet } = renderPolicy(key, path);
  const head = [helmet.title, helmet.meta, helmet.link, helmet.script].map(value => value?.toString() || '').join('\n');
  // Remove the generic home title/meta so crawlers receive one authoritative policy head.
  const page = template.replace(/<title>[\s\S]*?<\/title>/i, '').replace(/<meta[^>]+name=["'](?:description|robots)["'][^>]*>/gi, '')
    .replace('</head>', `${head}\n</head>`).replace('<div id="root"></div>', `<div id="root">${html}</div>`);
  writeFileSync(resolve(`dist/policy-${key}.html`), page);
  console.log(`Prerendered ${path}`);
}
