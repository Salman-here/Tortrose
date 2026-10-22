'use strict';

// Focused backport of Evolution's interactive relay correction, without a
// gateway-version upgrade, new licensing, or changes to customer-facing copy.
// Upstream: evolution-foundation/evolution-api, 2.4.0-rc1,
// src/api/integrations/channel/whatsapp/helpers/interactiveMessage.helper.ts.
// Only existing quick_reply messages are changed; CTA/PIX/media are untouched.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MARKER = '__rozareCodReplyEnvelopeV1';
const LEGACY_RELAY = /([\w$]+)\.viewOnceMessage\)\{let ([\w$]+)=((?:\(0,[\w$]+\.generateWAMessageFromContent\))|[\w$]+)\(([\w$]+),\1,\{timestamp:new Date,userJid:this\.instance\.wuid,messageId:([\w$]+),quoted:([\w$]+)\}\),([\w$]+)=await this\.client\.relayMessage\(\4,\1,\{messageId:\5\}\);/g;

function interactiveBizNode() {
  return { tag: 'biz', attrs: {}, content: [{ tag: 'interactive',
    attrs: { type: 'native_flow', v: '1' },
    content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
  }] };
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    if ([...source.matchAll(LEGACY_RELAY)].length) throw new Error('Mixed legacy/patched reply relay; refusing a partial patch.');
    return { source, changed: false, alreadyPatched: true };
  }
  let count = 0;
  const patched = source.replace(LEGACY_RELAY, (_match, message, generated, generate, sender, id, quoted, receipt) => {
    count += 1;
    return `${message}.viewOnceMessage){`
      + `const ${MARKER}=${message}.viewOnceMessage?.message?.interactiveMessage?.nativeFlowMessage?.buttons;`
      + `const __rozareIsReply=Array.isArray(${MARKER})&&${MARKER}.length>0&&${MARKER}.every(button=>button?.name==="quick_reply");`
      + `if(__rozareIsReply)${message}=${message}.viewOnceMessage.message;`
      + `let ${generated}=${generate}(${sender},${message},{timestamp:new Date,userJid:this.instance.wuid,messageId:${id},quoted:${quoted}});`
      + `if(__rozareIsReply&&!${generated}?.key?.id)throw new Error("Interactive reply message id was not generated");`
      + `const __rozareRelayOptions={messageId:__rozareIsReply?${generated}.key.id:${id}};`
      + `if(__rozareIsReply)__rozareRelayOptions.additionalNodes=[${JSON.stringify(interactiveBizNode())}];`
      + `let ${receipt}=await this.client.relayMessage(${sender},__rozareIsReply?${generated}.message:${message},__rozareRelayOptions);`;
  });
  if (count > 1) throw new Error('Unexpected duplicate interactive relays in one bundle.');
  if (!count && /async buttonMessage\(/.test(source) && source.includes('this.client.relayMessage(') && source.includes('.viewOnceMessage')) {
    throw new Error('Unrecognized Evolution interactive relay; refusing to modify this build.');
  }
  return { source: patched, changed: count === 1, alreadyPatched: false };
}

function collectBundles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectBundles(file);
    return entry.isFile() && /\.(mjs|js)$/.test(entry.name) ? [file] : [];
  });
}

function patchDist(distRoot = '/evolution/dist', { check = false } = {}) {
  // Validate every target before modifying any. Re-running is safe.
  const targets = collectBundles(distRoot).map(file => ({ file, ...patchSource(fs.readFileSync(file, 'utf8')) }));
  const affected = targets.filter(target => target.changed || target.alreadyPatched);
  if (!affected.length) throw new Error('No compatible Evolution reply relay found.');
  for (const target of affected) {
    if (!check && target.changed) fs.writeFileSync(target.file, target.source);
    if (!check) {
      const result = spawnSync(process.execPath, ['--check', target.file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`Patched bundle syntax check failed: ${target.file}`);
    }
  }
  return { marker: MARKER, targets: affected.length,
    changed: affected.filter(target => target.changed).length,
    alreadyPatched: affected.filter(target => target.alreadyPatched).length,
    checkOnly: check };
}

module.exports = { MARKER, patchSource, patchDist, interactiveBizNode };
if (require.main === module) {
  const result = patchDist('/evolution/dist', { check: process.argv.includes('--check') });
  console.log(JSON.stringify(result));
}
