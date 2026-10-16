import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { publicPageResponse } from '../server/publicPageResponse.mjs';

export async function GET(request) {
  const url = new URL(request.url);
  return publicPageResponse({
    kind: url.searchParams.get('kind'),
    value: url.searchParams.get('value') || '',
    noindex: url.searchParams.get('noindex') === '1' || !(url.hostname === 'rozare.com' || /^[a-z\d-]+\.rozare\.com$/.test(url.hostname)),
    apiOrigin: process.env.SEO_API_ORIGIN || 'https://rozare.up.railway.app',
    appShell: () => readFile(join(process.cwd(), 'dist/index.html'), 'utf8'),
  });
}

export async function HEAD(request) {
  const response = await GET(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
