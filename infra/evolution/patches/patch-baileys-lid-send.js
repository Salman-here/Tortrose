'use strict';

// LIDs are opaque WhatsApp addresses, not phone numbers. Preserve explicitly
// addressed LIDs before phone lookup/cache normalization. Phone and group
// validation is unchanged. Cover every bundle, especially the main entries.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MARKER = '__rozareExplicitLidV2';
const ROUTE = /let ([\w$]+)=\(await this\.whatsappNumber\(\{numbers:\[([\w$]+)\]\}\)\)\?\.shift\(\);(if\(!\1\.exists&&[^;{}\r\n]+;)let ([\w$]+)=(?:\1\.jid\.toLowerCase\(\)|String\(\2\|\|""\)\.toLowerCase\(\)\.includes\("@lid"\)\?String\(\2\)\.toLowerCase\(\):\1\.jid\.toLowerCase\(\));/g;
const ENTRIES = ['main.js', 'main.mjs', 'api/integrations/channel/whatsapp/whatsapp.baileys.service.js', 'api/integrations/channel/whatsapp/whatsapp.baileys.service.mjs'];

function patchSource(source) {
  if (source.includes(MARKER)) {
    if ([...source.matchAll(ROUTE)].length) throw new Error('Mixed patched/unpatched LID routes.');
    return { source, changed: false, alreadyPatched: true };
  }
  let count = 0;
  const output = source.replace(ROUTE, (_match, lookup, number, guard, destination) => {
    if (!guard.includes(`${lookup}.jid.includes("@broadcast")`) || !guard.includes('throw new ')) throw new Error('Unrecognized number-validation guard.');
    count += 1;
    return `const ${MARKER}=/^\\d+(?::\\d+)?@lid$/i.test(String(${number}||""));`
      + `let ${lookup},${destination};if(${MARKER}){${destination}=String(${number}).toLowerCase()}`
      + `else{${lookup}=(await this.whatsappNumber({numbers:[${number}]}))?.shift();${guard}${destination}=${lookup}.jid.toLowerCase();}`;
  });
  if (count > 1) throw new Error('Unexpected duplicate LID routes in a bundle.');
  if (!count && source.includes('async sendMessageWithTyping(') && source.includes('this.whatsappNumber({numbers:[')) throw new Error('Unrecognized Evolution routing build; refusing a guessed patch.');
  return { source: output, changed: count === 1, alreadyPatched: false };
}

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? collect(file) : entry.isFile() && /\.(js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

function patchDist(root = '/evolution/dist', { check = false } = {}) {
  const targets = collect(root).map(file => ({ file, ...patchSource(fs.readFileSync(file, 'utf8')) })).filter(row => row.changed || row.alreadyPatched);
  for (const entry of ENTRIES) if (!targets.some(row => row.file === path.join(root, entry))) throw new Error(`Missing covered runtime entry: ${entry}`);
  // Validate all bundle shapes and required entries before writing any file.
  for (const target of targets) {
    if (!check && target.changed) fs.writeFileSync(target.file, target.source);
    if (!check && spawnSync(process.execPath, ['--check', target.file], { encoding: 'utf8' }).status !== 0) throw new Error(`Routing bundle syntax check failed: ${target.file}`);
  }
  return { marker: MARKER, targets: targets.length, runtimeEntries: ENTRIES.length, changed: targets.filter(row => row.changed).length,
    alreadyPatched: targets.filter(row => row.alreadyPatched).length, checkOnly: check };
}

function readRoutingMethod(source) {
  const start = source.lastIndexOf('async sendMessageWithTyping('), end = source.indexOf('}async ', start + 27);
  if (start < 0 || end < 0) throw new Error('The runtime routing method was not found.');
  return source.slice(start, end + 1);
}

module.exports = { MARKER, ENTRIES, patchSource, patchDist, readRoutingMethod };
if (require.main === module) console.log(JSON.stringify(patchDist('/evolution/dist', { check: process.argv.includes('--check') })));
