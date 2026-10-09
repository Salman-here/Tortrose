'use strict';

// Narrow, reproducible mitigations for GHSA-vfj7-8cjw-p6xm and
// GHSA-86w9-cpqp-85rv. Keep the current framework and upstream licenses.
// npm audit still reports the published versions; no advisory is suppressed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const normalize = source => source.replace(/\r\n/g, '\n');
const digest = source => crypto.createHash('sha256').update(normalize(source)).digest('hex');
const GUARD_HASH = 'afd354ea8836c450a23f62990e9bdb8a2d2b54588c4d3bfac684d2ee4a38346d';
const MAX_BRACE_DEPTH = 64;

const parserBefore = '    if (value === CHAR_LEFT_CURLY_BRACE) {\n      depth++;';
const parserAfter = `${parserBefore}\n      // Rozare: bound actual syntax nesting before constructing recursive ASTs.\n      if (depth > ${MAX_BRACE_DEPTH}) {\n        throw new SyntaxError('Brace pattern exceeds the safe nesting limit.');\n      }`;
const guardImport = "const assertSafeBraceAst = require('./rozare-ast-safety');\n";
const rsaBefore = `          // validate DigestInfo structure and element count
          var capture = {};
          var errors = [];
          if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||
            obj.value.length !== 2) {`;
const rsaAfter = `          // Validate both levels, not only the outer DigestInfo element count.
          // RSA verification must not accept extra AlgorithmIdentifier elements.
          var capture = {};
          var errors = [];
          var algorithmElements = obj.value && obj.value[0] && obj.value[0].value;
          if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||
            obj.value.length !== 2 || !Array.isArray(algorithmElements) ||
            (algorithmElements.length !== 1 && algorithmElements.length !== 2) ||
            (algorithmElements.length === 2 &&
              (algorithmElements[1].tagClass !== asn1.Class.UNIVERSAL ||
                algorithmElements[1].type !== asn1.Type.NULL ||
                algorithmElements[1].constructed !== false ||
                algorithmElements[1].value !== ''))) {`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed dependency patch anchor changed.');
  return source.replace(before, after);
}

function walkerPatch(anchor) {
  return {
    apply(source) {
      let result = replaceOnce(source, "'use strict';\n\n", "'use strict';\n\n" + guardImport);
      return replaceOnce(result, anchor, anchor + '\n  assertSafeBraceAst(ast);');
    },
    undo(source) {
      let result = replaceOnce(source, "'use strict';\n\n" + guardImport, "'use strict';\n\n");
      return replaceOnce(result, anchor + '\n  assertSafeBraceAst(ast);', anchor);
    },
  };
}

const patches = [
  { name:'braces', version:'3.0.3', files:[
    { file:'lib/parse.js', hash:'e572166565f15fa6ad9865ae49d678218e32aabfd1b3720f6d0d43d39800d310',
      apply:source => replaceOnce(source,parserBefore,parserAfter),
      undo:source => replaceOnce(source,parserAfter,parserBefore) },
    { file:'lib/compile.js', hash:'dc98f22eee3d511785d92a00758d5f0d48efed5f5813bdecc2de430c529b5c9f',
      ...walkerPatch('const compile = (ast, options = {}) => {') },
    { file:'lib/expand.js', hash:'41ccc196ebfa7b7781a634e721eb744e4e7bcb54cba427a7e3d6806a1b9e58f7',
      ...walkerPatch('const expand = (ast, options = {}) => {') },
    { file:'lib/stringify.js', hash:'379f22d77bfa1478341ccd49c5e4267464aabcbba03558bab332aac23fc6f23a',
      ...walkerPatch('module.exports = (ast, options = {}) => {') },
  ] },
  { name:'node-forge', version:'1.4.0', files:[
    { file:'lib/rsa.js', hash:'fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50',
      apply:source => replaceOnce(source,rsaBefore,rsaAfter),
      undo:source => replaceOnce(source,rsaAfter,rsaBefore) },
  ] },
];

function hardenedSource(source, patch) {
  source = normalize(source);
  if (digest(source) === patch.hash) return patch.apply(source);
  let original;
  try { original = patch.undo(source); } catch (_) {
    throw new Error('Reviewed dependency source changed; review before installing.');
  }
  if (digest(original) !== patch.hash || patch.apply(original) !== source) {
    throw new Error('Reviewed dependency source changed; review before installing.');
  }
  return source;
}

function inside(directory, target) {
  const relative = path.relative(directory,target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function ensureDependencySecurity(root = path.resolve(__dirname,'..'), { checkOnly = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if (!['backend','mobile-app'].includes(manifest.name)) throw new Error('Unexpected dependency hardening project.');
  const lock = JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Reviewed dependency lock is required.');
  const modules = fs.realpathSync(path.join(root,'node_modules'));
  const guard = normalize(fs.readFileSync(path.join(__dirname,'security-patches/braces-ast-safety.js'),'utf8'));
  if (digest(guard) !== GUARD_HASH) throw new Error('Dependency AST guard changed; review its checksum.');
  const writes = [];
  const results = [];
  for (const descriptor of patches) {
    const suffix = 'node_modules/' + descriptor.name;
    const entries = Object.entries(lock.packages).filter(([key]) => key === suffix || key.endsWith('/' + suffix));
    for (const [key,entry] of entries) {
      if (entry.version !== descriptor.version || key.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Dependency version/path changed; review hardening compatibility.');
      }
      const installed = path.resolve(root,...key.split('/'));
      if (!fs.existsSync(installed)) {
        if (entry.dev === true || entry.optional === true) continue;
        throw new Error('Required dependency is missing; run a clean installation.');
      }
      const directory = fs.realpathSync(installed);
      if (!inside(modules,directory)) throw new Error('Dependency hardening target escaped project modules.');
      const packageManifest = JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
      if (packageManifest.name !== descriptor.name || packageManifest.version !== descriptor.version) {
        throw new Error('Installed dependency disagrees with the reviewed lock.');
      }
      // Preflight EVERY package/file before modifying any of them.
      if (descriptor.name === 'braces') {
        const target = path.join(directory,'lib/rozare-ast-safety.js');
        if (!inside(directory,fs.realpathSync(path.dirname(target))) ||
            (fs.existsSync(target) && !inside(directory,fs.realpathSync(target)))) {
          throw new Error('Dependency AST guard target escaped its package.');
        }
        if (fs.existsSync(target) && digest(fs.readFileSync(target,'utf8')) !== GUARD_HASH) {
          throw new Error('Installed dependency AST guard was modified.');
        }
        if (!fs.existsSync(target)) writes.push({ target,source:guard });
      }
      const sourceHashes = {};
      for (const patch of descriptor.files) {
        const target = fs.realpathSync(path.join(directory,...patch.file.split('/')));
        if (!inside(directory,target)) throw new Error('Dependency source target escaped its package.');
        const original = fs.readFileSync(target,'utf8');
        const source = hardenedSource(original,patch);
        sourceHashes[patch.file] = digest(source);
        if (normalize(original) !== source) writes.push({ target,source });
      }
      results.push({ name:descriptor.name,version:descriptor.version,path:key,sourceHashes });
    }
  }
  if (checkOnly && writes.length) throw new Error('Required dependency security hardening is not installed.');
  if (!checkOnly) {
    for (const { target,source } of writes) {
      const temporary = target + '.rozare-security-' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(temporary,source,{ flag:'wx' });
      fs.renameSync(temporary,target);
    }
  }
  return results;
}

if (require.main === module) {
  const results = ensureDependencySecurity(undefined,{ checkOnly:process.argv.includes('--check') });
  console.log('Reviewed dependency security hardening verified: ' + (results.map(row => row.name + '@' + row.version).join(', ') || 'no affected installed tools'));
}
module.exports = { ensureDependencySecurity,hardenedSource,patches,MAX_BRACE_DEPTH,GUARD_HASH };
