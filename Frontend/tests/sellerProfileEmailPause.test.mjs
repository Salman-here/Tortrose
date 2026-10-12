import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const walk = (node, callback, parents = []) => {
  if (!node || typeof node !== 'object') return;
  callback(node, parents);
  for (const [key, child] of Object.entries(node)) if (!['loc', 'comments', 'tokens'].includes(key)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, callback, [...parents, node]));
    else if (child && typeof child === 'object') walk(child, callback, [...parents, node]);
  }
};
const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('seller email-change UI stays disabled while retaining its OTP implementation', () => {
  const source = read('../src/components/layout/SellerProfile.jsx');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  let toggleCount = 0;
  walk(ast, (node, parents) => {
    if (node.type === 'VariableDeclarator' && node.id.name === 'SELLER_EMAIL_CHANGES_ENABLED') {
      assert.equal(node.init.type, 'BooleanLiteral');
      assert.equal(node.init.value, false);
    }
    if (node.type === 'CallExpression' && node.callee.name === 'setShowEmailChange'
        && node.arguments[0]?.value === true) {
      toggleCount++;
      assert.ok(parents.some(parent => parent.type === 'LogicalExpression'
        && source.slice(parent.start, parent.end).startsWith('SELLER_EMAIL_CHANGES_ENABLED &&')));
    }
  });
  assert.equal(toggleCount, 1, 'the original change action is preserved for future use');
  assert.match(source, /SELLER_EMAIL_CHANGES_ENABLED && showEmailChange &&/);
  assert.match(source, /Email changes are currently unavailable\./);
  assert.match(source, /const handleInitiateEmailChange = async/);
  assert.match(source, /const handleVerifyEmailChange = async/);
  assert.match(source, /!showWhatsAppChange &&/);
});

test('notification preferences have a distinct icon in both seller menus', () => {
  const source = read('../src/components/layout/SellerDashboard.jsx');
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  const icons = { 'notif-settings': [], store: [], notifications: [] };
  walk(ast, node => {
    if (node.type !== 'ObjectExpression') return;
    const id = node.properties.find(prop => prop.key?.name === 'id')?.value?.value;
    if (!Object.hasOwn(icons, id)) return;
    const icon = node.properties.find(prop => prop.key?.name === 'icon')?.value;
    icons[id].push(icon?.openingElement?.name?.name);
  });
  assert.deepEqual(icons['notif-settings'], ['SlidersHorizontal', 'SlidersHorizontal']);
  assert.deepEqual(icons.store, ['Settings', 'Settings']);
  assert.deepEqual(icons.notifications, ['Bell', 'Bell']);
});
