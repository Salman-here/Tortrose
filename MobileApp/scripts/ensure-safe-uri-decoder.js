'use strict';
// React Navigation 6 -> query-string 7 synchronously requires a callable CJS
// decoder. The security-fixed upstream decoder 0.5.0 is ESM-only. Keep its
// audited algorithm and MIT license intact; change only module packaging.
// This runs after npm ci/install (including EAS), is idempotent, and fails
// closed if the exact reviewed upstream source or package contract changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const VERSION = '0.5.0';
const ORIGINAL_HASH = '9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa';
const COMMONJS_HASH = '684ba79779327ba789733a3a563050370a928a57eb7dd33d19b346f43b32cbb7';
const hash = source => crypto.createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');

function commonJsSource(source) {
  const digest = hash(source);
  if (digest === COMMONJS_HASH) return source;
  if (digest !== ORIGINAL_HASH) throw new Error('Audited URI decoder source changed; review before building.');
  const converted = source.replace('export default function decodeUriComponent(', 'module.exports = function decodeUriComponent(');
  if (hash(converted) !== COMMONJS_HASH) throw new Error('URI decoder packaging verification failed.');
  return converted;
}

function ensureDecoder(root = path.resolve(__dirname, '..')) {
  const resolve = createRequire(path.join(root, 'package.json'));
  const entry = resolve.resolve('decode-uri-component');
  const manifestPath = path.join(path.dirname(entry), 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'decode-uri-component' || manifest.version !== VERSION
    || manifest.exports?.default !== './index.js' || !['module', 'commonjs'].includes(manifest.type)) {
    throw new Error('Unexpected URI decoder package; retain the reviewed dependency lock.');
  }
  const original = fs.readFileSync(entry, 'utf8');
  const converted = commonJsSource(original);
  if (converted !== original) fs.writeFileSync(entry, converted);
  if (manifest.type !== 'commonjs') {
    manifest.type = 'commonjs';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { version: VERSION, sourceHash: hash(converted) };
}

if (require.main === module) {
  ensureDecoder();
  console.log('Audited URI decoder security fix and CommonJS compatibility verified.');
}
module.exports = { commonJsSource, ensureDecoder, VERSION, ORIGINAL_HASH, COMMONJS_HASH };
