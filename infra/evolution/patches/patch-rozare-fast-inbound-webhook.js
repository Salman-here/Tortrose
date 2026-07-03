const fs = require('fs');
const path = require('path');

const distRoot = '/evolution/dist';

function collectCompiledFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCompiledFiles(full));
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const patches = [
  {
    name: 'do not await inbound read receipts',
    before:
      'this.localSettings.readMessages&&n.key.id!=="status@broadcast"&&await this.client.readMessages([n.key]),this.localSettings.readStatus&&n.key.id==="status@broadcast"&&await this.client.readMessages([n.key]),',
    after:
      'this.localSettings.readMessages&&n.key.id!=="status@broadcast"&&this.client.readMessages([n.key]).catch(()=>{}),this.localSettings.readStatus&&n.key.id==="status@broadcast"&&this.client.readMessages([n.key]).catch(()=>{}),',
  },
  {
    name: 'skip post-webhook contact sync for Baileys inbound messages',
    before:
      'this.sendDataWebhook("messages.upsert",c),await ',
    after:
      'this.sendDataWebhook("messages.upsert",c);if(process.env.ROZARE_FAST_INBOUND_WEBHOOK==="true")continue;await ',
  },
  {
    name: 'skip non-critical Baileys message update work',
    before:
      'if(e["messages.update"]){let i=e["messages.update"];await this.messageHandle["messages.update"](i,o)}',
    after:
      'if(e["messages.update"]){let i=e["messages.update"];if(process.env.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true")this.sendDataWebhook("messages.update",i);else await this.messageHandle["messages.update"](i,o)}',
  },
  {
    name: 'guard Baileys message update handler entry',
    before:
      '"messages.update":async(e,t)=>{this.logger.verbose(`Update messages ${JSON.stringify(e,void 0,2)}`);',
    after:
      '"messages.update":async(e,t)=>{if(process.env.ROZARE_SKIP_MESSAGE_UPDATE_WORK==="true"){this.sendDataWebhook("messages.update",e);return}this.logger.verbose(`Update messages ${JSON.stringify(e,void 0,2)}`);',
  },
];

const files = collectCompiledFiles(distRoot);
for (const patch of patches) patch.applied = 0;

for (const file of files) {
  const original = fs.readFileSync(file, 'utf8');
  let source = original;

  for (const patch of patches) {
    let count = 0;
    while (source.includes(patch.before)) {
      source = source.replace(patch.before, patch.after);
      count += 1;
    }

    if (count > 0) {
      patch.applied += count;
      console.log(`Applied ${patch.name} (${count}): ${file}`);
    }
  }

  if (source !== original) fs.writeFileSync(file, source);
}

for (const patch of patches) {
  if (!patch.applied) {
    throw new Error(`Evolution fast inbound patch target not found: ${patch.name}`);
  }
}
