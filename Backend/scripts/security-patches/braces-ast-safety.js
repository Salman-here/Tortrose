'use strict';

// Traverse only child nodes: normal braces ASTs have cyclic parent/prev links.
// Run before upstream recursive walkers, including callers supplying an AST.
const MAX_AST_DEPTH = 80;
const MAX_AST_NODES = 262144;

module.exports = function assertSafeBraceAst(ast) {
  const pending = [[ast, 0]];
  const seen = new WeakSet();
  let scheduled = 1;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new SyntaxError('Invalid brace pattern AST.');
    }
    if (depth > MAX_AST_DEPTH || seen.has(node)) {
      throw new SyntaxError('Brace pattern AST exceeds safe nesting or contains a cycle.');
    }
    seen.add(node);
    if (node.nodes === undefined) continue;
    if (!Array.isArray(node.nodes) || node.nodes.length > MAX_AST_NODES - scheduled) {
      throw new SyntaxError('Brace pattern AST exceeds the safe node limit.');
    }
    scheduled += node.nodes.length;
    for (const child of node.nodes) pending.push([child, depth + 1]);
  }
};
