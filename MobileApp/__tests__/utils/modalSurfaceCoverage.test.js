import fs from 'node:fs';
import path from 'node:path';
const { parse } = require('@babel/parser');
const root = path.resolve(__dirname, '../../src');
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const filename = path.join(directory, entry.name);
  return entry.isDirectory() ? files(filename) : filename.endsWith('.js') ? [filename] : [];
});
const walk = (node, callback) => {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const [key, child] of Object.entries(node)) if (!['loc', 'comments', 'tokens'].includes(key)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, callback));
    else if (child && typeof child === 'object') walk(child, callback);
  }
};
const name = node => node?.type === 'JSXIdentifier' ? node.name : '';
const attribute = (node, key) => node.openingElement?.attributes.find(item => item.type === 'JSXAttribute' && item.name.name === key);

test('all native modal windows use the shared window context instead of raw imports', () => {
  let count = 0;
  for (const file of files(root)) {
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    const native = ast.program.body.find(node => node.type === 'ImportDeclaration' && node.source.value === 'react-native'
      && node.specifiers.some(item => item.imported?.name === 'Modal'));
    if (file.endsWith(`${path.sep}AppModal.js`)) continue;
    expect(native).toBeUndefined();
    const shared = ast.program.body.some(node => node.type === 'ImportDeclaration' && node.source.value.endsWith('/AppModal'));
    walk(ast, node => {
      if (node.type === 'JSXElement' && name(node.openingElement.name) === 'Modal') {
        expect(shared).toBe(true); count++;
      }
    });
  }
  expect(count).toBeGreaterThanOrEqual(26);
});
test('modal glass dialog shells are explicitly opaque; full-screen return cards stay ordinary cards', () => {
  let count = 0;
  for (const file of files(root)) {
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    walk(ast, node => {
      if (node.type !== 'JSXElement' || name(node.openingElement.name) !== 'Modal') return;
      if (file.endsWith(`${path.sep}BuyerReturnsSection.js`)) return;
      let first = null;
      walk(node, child => { if (!first && child.type === 'JSXElement' && name(child.openingElement.name) === 'GlassPanel') first = child; });
      if (!first) return;
      expect(attribute(first, 'variant')?.value?.value).toBe('modal'); count++;
    });
  }
  expect(count).toBeGreaterThanOrEqual(18);
});
