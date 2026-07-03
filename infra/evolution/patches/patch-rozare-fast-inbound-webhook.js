const fs = require('fs');

const files = [
  '/evolution/dist/api/integrations/channel/whatsapp/whatsapp.baileys.service.js',
  '/evolution/dist/api/integrations/channel/whatsapp/whatsapp.baileys.service.mjs',
];

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
];

for (const file of files) {
  let source = fs.readFileSync(file, 'utf8');

  for (const patch of patches) {
    if (!source.includes(patch.before)) {
      throw new Error(`Evolution fast inbound patch target not found (${patch.name}): ${file}`);
    }

    source = source.replace(patch.before, patch.after);
    console.log(`Applied ${patch.name}: ${file}`);
  }

  fs.writeFileSync(file, source);
}
