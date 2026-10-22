'use strict';

// Defense in depth, not a replacement for the backend's sender-envelope
// parser. An opaque LID belonging to this linked account must never be used
// as a customer's reply address. Do not guess or silently reroute a customer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MARKER = '__rozareSelfRouteV1';
const RECEIPT_MARKER = '__rozareReceiptAuditV1';
const ENTRIES = ['main.js', 'main.mjs', 'api/integrations/channel/whatsapp/whatsapp.baileys.service.js', 'api/integrations/channel/whatsapp/whatsapp.baileys.service.mjs'];

function patchSource(source) {
  if (source.includes(MARKER)) return { source, changed: false, alreadyPatched: true };
  const methods = [...source.matchAll(/async sendMessageWithTyping\(([\w$]+),[^]*?this\.logger\.verbose\(`Sending message to \$\{([\w$]+)\}`\);/g)];
  if (!methods.length) {
    if (source.includes('async sendMessageWithTyping(')) throw new Error('Unrecognized self-route guard target.');
    return { source, changed: false, alreadyPatched: false };
  }
  if (methods.length !== 1 || !methods[0][0].includes('__rozareExplicitLidV2')) throw new Error('Missing or duplicate prerequisite LID routing patch.');
  const [match, requested, target] = methods[0];
  const guard = `const ${MARKER}=v=>{let s=String(v||"").trim().toLowerCase().replace(/:\\d+(?=@)/,"");return s.includes("@")?s:/^\\+?[\\d()\\s-]+$/.test(s)?s.replace(/\\D/g,"")+"@s.whatsapp.net":s};`
    + `const __rozareSelfIds=[this.client?.user?.id,this.client?.user?.lid,this.client?.authState?.creds?.me?.id,this.client?.authState?.creds?.me?.lid,this.instance?.wuid].filter(Boolean).map(${MARKER});`
    + `if(__rozareSelfIds.includes(${MARKER}(${target}))&&(__rozareExplicitLidV2||!__rozareSelfIds.includes(${MARKER}(${requested})))){`
    + `this.logger.error("[rozare:routing] blocked unintended self recipient");throw new Error("ROZARE_SELF_RECIPIENT_BLOCKED")}`;
  const offset = methods[0].index + match.lastIndexOf('this.logger.verbose(');
  return { source: source.slice(0, offset) + guard + source.slice(offset), changed: true, alreadyPatched: false };
}

function receiptAudit(variable) {
  // Message suffixes correlate with the test receipt without logging message
  // bodies, names, phone numbers, LIDs, tokens or session credentials.
  return `const ${RECEIPT_MARKER}=Array.isArray(${variable})?${variable}:[${variable}];for(const u of ${RECEIPT_MARKER}){`
    + `const k=u?.key||{},s=u?.update?.status??u?.status;if(k.fromMe===true&&s!==undefined)console.info("[rozare:receipt] "+JSON.stringify({messageSuffix:String(k.id||"").slice(-12),status:s,recipientType:String(k.remoteJid||"").endsWith("@lid")?"lid":"phone"}))}`;
}

function patchReceiptSource(source) {
  if (source.includes(RECEIPT_MARKER)) return { source, changed: false, alreadyPatched: true };
  let count = 0;
  const output = source.replace(/if\(process\.env\.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true"\)this\.sendDataWebhook\("messages.update",([\w$]+)\);else/g,
    (_match, value) => { count++; return `if(process.env.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true"){${receiptAudit(value)}this.sendDataWebhook("messages.update",${value});}else`; })
    .replace(/if\(process\.env\.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true"\)\{this\.sendDataWebhook\("messages.update",([\w$]+)\);return\}/g,
      (_match, value) => { count++; return `if(process.env.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true"){${receiptAudit(value)}this.sendDataWebhook("messages.update",${value});return}`; });
  if (source.includes('async sendMessageWithTyping(') && count !== 2) throw new Error('Unrecognized fast receipt forwarding build.');
  return { source: output, changed: count > 0, alreadyPatched: false };
}

function collect(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? collect(file) : entry.isFile() && /\.(js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

function patchDist(root = '/evolution/dist', { check = false } = {}) {
  const targets = collect(root).map(file => {
    const first = patchSource(fs.readFileSync(file, 'utf8'));
    const second = patchReceiptSource(first.source);
    if ((first.changed || first.alreadyPatched) !== (second.changed || second.alreadyPatched)) throw new Error('Incomplete routing and receipt coverage: ' + file);
    return { file, source: second.source, covered: first.changed || first.alreadyPatched, changed: first.changed || second.changed };
  }).filter(row => row.covered);
  for (const entry of ENTRIES) if (!targets.some(row => row.file === path.join(root, entry))) throw new Error('Missing guarded runtime entry: ' + entry);
  // Validate every target before writing; reject unknown upstream bundle shapes.
  for (const target of targets) {
    if (!check && target.changed) fs.writeFileSync(target.file, target.source);
    if (!check && spawnSync(process.execPath, ['--check', target.file], { encoding: 'utf8' }).status !== 0) throw new Error('Guarded bundle syntax check failed: ' + target.file);
  }
  return { marker: MARKER, receiptMarker: RECEIPT_MARKER, targets: targets.length,
    runtimeEntries: ENTRIES.length, changed: targets.filter(row => row.changed).length, checkOnly: check };
}

module.exports = { MARKER, RECEIPT_MARKER, ENTRIES, patchSource, patchReceiptSource, patchDist, receiptAudit };
if (require.main === module) console.log(JSON.stringify(patchDist(process.argv[2]?.startsWith('/') ? process.argv[2] : '/evolution/dist', { check: process.argv.includes('--check') })));
