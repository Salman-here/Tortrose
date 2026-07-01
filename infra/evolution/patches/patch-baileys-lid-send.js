const fs = require('fs');

const patches = [
  {
    file: '/evolution/dist/api/integrations/channel/whatsapp/whatsapp.baileys.service.js',
    before:
      'let n=(await this.whatsappNumber({numbers:[e]}))?.shift();if(!n.exists&&!(0,R.isJidGroup)(n.jid)&&!n.jid.includes("@broadcast"))throw new f(n);let r=n.jid.toLowerCase();',
    after:
      'let n=(await this.whatsappNumber({numbers:[e]}))?.shift();if(!n.exists&&!(0,R.isJidGroup)(n.jid)&&!n.jid.includes("@broadcast"))throw new f(n);let r=String(e||"").toLowerCase().includes("@lid")?String(e).toLowerCase():n.jid.toLowerCase();',
  },
  {
    file: '/evolution/dist/api/integrations/channel/whatsapp/whatsapp.baileys.service.mjs',
    before:
      'let n=(await this.whatsappNumber({numbers:[e]}))?.shift();if(!n.exists&&!Te(n.jid)&&!n.jid.includes("@broadcast"))throw new f(n);let r=n.jid.toLowerCase();',
    after:
      'let n=(await this.whatsappNumber({numbers:[e]}))?.shift();if(!n.exists&&!Te(n.jid)&&!n.jid.includes("@broadcast"))throw new f(n);let r=String(e||"").toLowerCase().includes("@lid")?String(e).toLowerCase():n.jid.toLowerCase();',
  },
];

for (const patch of patches) {
  const source = fs.readFileSync(patch.file, 'utf8');
  if (!source.includes(patch.before)) {
    throw new Error(`Evolution LID send patch target not found: ${patch.file}`);
  }

  fs.writeFileSync(patch.file, source.replace(patch.before, patch.after));
  console.log(`Applied LID send patch: ${patch.file}`);
}
