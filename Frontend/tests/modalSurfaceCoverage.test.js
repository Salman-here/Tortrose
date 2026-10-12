import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? files(path) : /\.(jsx|js)$/.test(path) ? [path] : [];
});
const walk = (node, callback) => {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const [key, child] of Object.entries(node)) if (!['loc', 'comments', 'tokens'].includes(key)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, callback));
    else if (child && typeof child === 'object') walk(child, callback);
  }
};
const attribute = (node, name) => node.openingElement?.attributes.find(value => value.type === 'JSXAttribute' && value.name.name === name)?.value;
const value = node => node?.type === 'StringLiteral' ? node.value : node?.type === 'JSXExpressionContainer' && node.expression.type === 'TemplateLiteral'
  ? node.expression.quasis.map(item => item.value.raw).join(' ') : '';

test('every web dialog glass shell above a full-screen overlay uses the modal surface', () => {
  let covered = 0;
  for (const file of files(sourceRoot)) {
    const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
    walk(ast, node => {
      if (node.type !== 'JSXElement') return;
      const classes = value(attribute(node, 'className'));
      if (classes.includes('modal-surface')) covered++;
      if (!/\bfixed\b/.test(classes) || !/\binset-0\b/.test(classes) || classes.includes('pointer-events-none')) return;
      const inspect = child => {
        if (!child || typeof child !== 'object') return;
        if (child !== node && child.type === 'JSXElement') {
          const className = value(attribute(child, 'className'));
          if (value(attribute(child, 'role')) === 'dialog' || value(attribute(child, 'aria-modal')) === 'true'
              || /glass-(panel|card|floating)/.test(className) && /max-w-|w-full/.test(className)) {
            assert.match(className, /\bmodal-surface\b/, `${file}:${child.loc.start.line} has a transparent dialog shell`);
            return;
          }
        }
        for (const [key, item] of Object.entries(child)) if (!['loc', 'comments', 'tokens'].includes(key)) {
          if (Array.isArray(item)) item.forEach(inspect); else if (item && typeof item === 'object') inspect(item);
        }
      };
      inspect(node);
    });
  }
  assert.ok(covered >= 42, `Expected full dialog, drawer and popover coverage, got ${covered}`);
});

test('modal theme is scoped, opaque and independent of the backdrop in both modes', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /\.glass-panel\s*\{\s*background: var\(--glass-bg\)/, 'ordinary page cards stay translucent');
  assert.match(css, /\.modal-surface\s*\{[^}]*--modal-surface-color:\s*#f8fbff;/);
  assert.match(css, /\.dark \.modal-surface\s*\{[^}]*--modal-surface-color:\s*#182238;/);
  assert.match(css, /background-color:\s*var\(--modal-surface-color\)\s*!important/);
  assert.match(css, /\.modal-surface\s*\{[^}]*--modal-backdrop-filter:\s*none/);
  assert.match(css, /\.modal-surface\s*\{[^}]*backdrop-filter:\s*var\(--modal-backdrop-filter\)\s*!important/);
  assert.match(css, /\.modal-surface :is\(input, textarea\)::placeholder/);
});
