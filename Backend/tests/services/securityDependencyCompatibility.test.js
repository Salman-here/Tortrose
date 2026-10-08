'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const JSZip = require('jszip');

test('installed runtime dependencies meet the audited compatible security floors', () => {
  const floors = { axios: [1, 20, 0], multer: [2, 4, 0], 'proxy-addr': [2, 0, 8],
    qs: [6, 16, 0], '@xmldom/xmldom': [0, 8, 15] };
  for (const [name, floor] of Object.entries(floors)) {
    const version = require(`${name}/package.json`).version.split('.').map(Number);
    const ordered = version[0] > floor[0] || version[0] === floor[0]
      && (version[1] > floor[1] || version[1] === floor[1] && version[2] >= floor[2]);
    expect({ name, version: version.join('.'), secureFloorMet: ordered }).toMatchObject({ secureFloorMet: true });
  }
});

test('real DOCX extraction remains compatible with patched XML parsing and does not load vulnerable CLI formatting', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Security compatibility ✓ — پاکستان</w:t></w:r></w:p></w:body></w:document>');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const program = `const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',async()=>{try{const result=await require('mammoth').extractRawText({buffer:Buffer.concat(chunks)});console.log(JSON.stringify({text:result.value,cliFormatterLoaded:Object.keys(require.cache).some(p=>/[\\\\/]node_modules[\\\\/](?:argparse|sprintf-js)[\\\\/]/.test(p))}));}catch(e){console.error('DOCX_COMPATIBILITY_FAILED');process.exitCode=1;}});`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', program], {
    cwd: path.resolve(__dirname, '../..'), input: buffer, encoding: 'utf8', timeout: 10000,
  }));
  expect(result.text).toContain('Security compatibility ✓ — پاکستان');
  expect(result.cliFormatterLoaded).toBe(false);
});
