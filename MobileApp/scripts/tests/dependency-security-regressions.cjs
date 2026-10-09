'use strict';

// Run on a clean disposable install before applying to the working packages:
// node scripts/tests/dependency-security-regressions.cjs <disposable-project-root>
const { test,after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const hardening = require('../ensure-dependency-security');
const root = path.resolve(process.argv[2] || path.join(__dirname,'../..'));
const resolve = createRequire(path.join(root,'package.json'));
const modules = fs.realpathSync(path.join(root,'node_modules'));
const braces = resolve('braces');
const owned = [];
const baselineEntries = new WeakMap();

function temporary() {
  const directory = fs.mkdtempSync(path.join(modules,'rozare-hardening-'));
  owned.push(fs.realpathSync(directory));
  return directory;
}
after(() => {
  for (const directory of owned) {
    const verified = fs.realpathSync(directory);
    if (verified !== directory || path.dirname(verified) !== modules
        || !path.basename(verified).startsWith('rozare-hardening-')) throw new Error('Unsafe test cleanup target.');
    fs.rmSync(verified,{ recursive:true,force:false });
  }
});

function packageDirectory(name) {
  return path.dirname(resolve.resolve(name + '/package.json'));
}

function baseline(name) {
  const descriptor = hardening.patches.find(patch => patch.name === name);
  const directory = path.join(temporary(),name);
  fs.cpSync(packageDirectory(name),directory,{ recursive:true });
  for (const patch of descriptor.files) {
    const target = path.join(directory,patch.file);
    const source = fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n');
    const original = patch.undo(hardening.hardenedSource(source,patch));
    fs.writeFileSync(target,original);
  }
  const library = require(directory);
  baselineEntries.set(library,directory);
  return library;
}

function installerFixture() {
  const directory = temporary();
  const target = path.join(directory,'node_modules/braces');
  fs.mkdirSync(path.dirname(target),{ recursive:true });
  fs.cpSync(packageDirectory('braces'),target,{ recursive:true });
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({ name:'backend' }));
  fs.writeFileSync(path.join(directory,'package-lock.json'),JSON.stringify({ lockfileVersion:3,
    packages:{ 'node_modules/braces':{ version:'3.0.3' } } }));
  return directory;
}

test('installation and check-only verification are idempotent', () => {
  const first = hardening.ensureDependencySecurity(root,{ checkOnly:true });
  assert.ok(first.some(row => row.name === 'braces'));
  assert.deepEqual(hardening.ensureDependencySecurity(root),first);
  assert.deepEqual(hardening.ensureDependencySecurity(root,{ checkOnly:true }),first);
});

test('an altered upstream file fails closed before any package writes', () => {
  const fixture = installerFixture();
  const parser = path.join(fixture,'node_modules/braces/lib/parse.js');
  const compiler = path.join(fixture,'node_modules/braces/lib/compile.js');
  const parsePatch = hardening.patches[0].files[0];
  const parserBefore = parsePatch.undo(fs.readFileSync(parser,'utf8').replace(/\r\n/g,'\n'));
  fs.writeFileSync(parser,parserBefore);
  fs.appendFileSync(compiler,'\n// unexpected source\n');
  assert.throws(() => hardening.ensureDependencySecurity(fixture),/source changed/);
  assert.equal(fs.readFileSync(parser,'utf8'),parserBefore);
});

test('an unreviewed package version is rejected', () => {
  const fixture = installerFixture();
  fs.writeFileSync(path.join(fixture,'node_modules/braces/package.json'),JSON.stringify({ name:'braces',version:'3.0.4' }));
  assert.throws(() => hardening.ensureDependencySecurity(fixture),/reviewed lock/);
});

test('a traversing package-lock path is rejected before resolving a target', () => {
  const fixture = installerFixture();
  fs.writeFileSync(path.join(fixture,'package-lock.json'),JSON.stringify({ lockfileVersion:3,
    packages:{ 'node_modules/../node_modules/braces':{ version:'3.0.3' } } }));
  assert.throws(() => hardening.ensureDependencySecurity(fixture),/version\/path changed/);
});

test('a changed installed AST guard cannot silently pass verification', () => {
  const fixture = installerFixture();
  fs.appendFileSync(path.join(fixture,'node_modules/braces/lib/rozare-ast-safety.js'),'\n// unexpected guard\n');
  assert.throws(() => hardening.ensureDependencySecurity(fixture),/guard was modified/);
});

test('check-only detects a missing patch without reapplying it', () => {
  const fixture = installerFixture();
  const target = path.join(fixture,'node_modules/braces/lib/parse.js');
  const patch = hardening.patches[0].files[0];
  const original = patch.undo(fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n'));
  fs.writeFileSync(target,original);
  assert.throws(() => hardening.ensureDependencySecurity(fixture,{ checkOnly:true }),/not installed/);
  assert.equal(fs.readFileSync(target,'utf8'),original);
  hardening.ensureDependencySecurity(fixture);
  hardening.ensureDependencySecurity(fixture,{ checkOnly:true });
});

test('an unexpected AST guard asset checksum is rejected', () => {
  const directory = temporary();
  fs.cpSync(path.join(__dirname,'..'),path.join(directory,'scripts'),{ recursive:true });
  const target = path.join(directory,'scripts/security-patches/braces-ast-safety.js');
  fs.appendFileSync(target,'\n// unexpected source asset\n');
  const changed = require(path.join(directory,'scripts/ensure-dependency-security.js'));
  assert.throws(() => changed.ensureDependencySecurity(root),/guard changed/);
});

test('ordinary patterns, ranges, escaping and options retain upstream behavior', () => {
  const original = baseline('braces');
  const patterns = ['src/{buyer,seller}/**/*.js','a{1..5}b','{x,{y,z}}','a\\{b,c\\}',
    'a{b,c','{1..9..2}','${price}','[{}]','"{{{{literal}}}}"','{a,b}{c,d}',''];
  for (let i = 0; i < 100; i++) patterns.push(`folder${i}/{buyer,{seller,admin}}/{${i}..${i+3}}.js`);
  for (const pattern of patterns) {
    for (const options of [{},{ expand:true,nodupes:true },{ escapeInvalid:true,keepQuotes:true }]) {
      assert.deepEqual(braces(pattern,options),original(pattern,options),pattern);
    }
  }
});

test('real micromatch/Jest/Metro pattern callers retain matching results', () => {
  const micromatch = resolve('micromatch');
  assert.deepEqual(micromatch(['src/buyer/a.js','src/seller/b.js','src/admin/c.js'],
    'src/{buyer,seller}/*.js'),['src/buyer/a.js','src/seller/b.js']);
});

test('deep malicious strings are rejected before all recursive operations', () => {
  const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
  for (const operation of [braces,braces.parse,braces.compile,braces.stringify,braces.expand]) {
    assert.throws(() => operation(pattern),error => error instanceof SyntaxError && /safe nesting/.test(error.message));
  }
  assert.throws(() => braces.parse(pattern,{ maxDepth:Infinity,maxLength:65536 }),/safe nesting/);
});

test('deep direct ASTs and cycles cannot bypass string-parser limits', () => {
  let ast = { type:'text',value:'a' };
  for (let i = 0; i < 1000; i++) ast = { type:'root',nodes:[ast] };
  const cycle = { type:'root',nodes:[] }; cycle.nodes.push(cycle);
  for (const operation of [braces.compile,braces.stringify,braces.expand]) {
    assert.throws(() => operation(ast),/safe nesting/);
    assert.throws(() => operation(cycle),/cycle/);
  }
});

test('escaped and quoted brace characters are not counted as syntax nesting', () => {
  const quoted = '"' + '{'.repeat(4000) + '}\"';
  assert.equal(braces.stringify(quoted),'{'.repeat(4000)+'}');
  const escaped = '\\{'.repeat(4000);
  assert.equal(braces.stringify(escaped),'{'.repeat(4000));
});

test('large direct ASTs are bounded without a spread-call stack overflow', () => {
  const ast = { type:'root',nodes:new Array(262145).fill({ type:'text',value:'a' }) };
  assert.throws(() => braces.compile(ast),error => error instanceof SyntaxError && /node limit/.test(error.message));
});

test('resource-limited child reproduces stack exhaustion below the existing character limit and verifies recovery', () => {
  const original = baseline('braces');
  const program = `const b=require(process.argv[1]);const p='{'.repeat(4000)+'a,b'+'}'.repeat(4000);let error='none';try{b.compile(p);}catch(e){error=e.name;}process.stdout.write(JSON.stringify({error,following:b.expand('{buyer,seller}')}));`;
  const run = entry => JSON.parse(execFileSync(process.execPath,['--stack_size=256','-e',program,entry],{
    encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],
  }));
  assert.deepEqual(run(baselineEntries.get(original)),{ error:'RangeError',following:['buyer','seller'] });
  assert.deepEqual(run(packageDirectory('braces')),{ error:'SyntaxError',following:['buyer','seller'] });
});

let forge;
try { forge = resolve('node-forge'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const signingTest = (name,fn) => test(name,{ skip:!forge },fn);
const data = Buffer.from('Rozare isolated certificate verification regression');
let pair;
function keys() {
  if (!pair) pair = crypto.generateKeyPairSync('rsa',{ modulusLength:1024,publicExponent:3 });
  return pair;
}
function publicKey(library = forge) {
  return library.pki.publicKeyFromPem(keys().publicKey.export({ type:'spki',format:'pem' }).toString());
}
function encodedDigest(variant,algorithm = 'sha256') {
  const asn = forge.asn1;
  const element = (type,constructed,value,tagClass = asn.Class.UNIVERSAL) => asn.create(tagClass,type,constructed,value);
  const algorithmParts = [element(asn.Type.OID,false,asn.oidToDer(forge.oids[algorithm]).getBytes())];
  if (variant !== 'omitted-null') algorithmParts.push(element(asn.Type.NULL,false,variant === 'nonempty-null' ? 'x' : ''));
  if (variant === 'extra-null') algorithmParts.push(element(asn.Type.NULL,false,''));
  if (variant === 'extra-sequence') algorithmParts.push(element(asn.Type.SEQUENCE,true,[element(asn.Type.OCTETSTRING,false,'garbage')]));
  if (variant === 'constructed-null') algorithmParts[1] = element(asn.Type.NULL,true,[]);
  if (variant === 'wrong-parameter') algorithmParts[1] = element(asn.Type.OCTETSTRING,false,'garbage');
  const outer = [element(asn.Type.SEQUENCE,true,algorithmParts),
    element(asn.Type.OCTETSTRING,false,crypto.createHash(algorithm).update(data).digest().toString('binary'))];
  if (variant === 'outer-extra') outer.push(element(asn.Type.NULL,false,''));
  return Buffer.from(asn.toDer(element(asn.Type.SEQUENCE,true,outer)).getBytes(),'binary');
}
function craftedSignature(variant,algorithm = 'sha256') {
  return crypto.privateEncrypt({ key:keys().privateKey,padding:crypto.constants.RSA_PKCS1_PADDING },encodedDigest(variant,algorithm));
}
function verify(library,variant,algorithm = 'sha256') {
  return publicKey(library).verify(crypto.createHash(algorithm).update(data).digest().toString('binary'),
    craftedSignature(variant,algorithm).toString('binary'));
}

signingTest('native RSA signatures and valid algorithm identifiers still verify', () => {
  for (const algorithm of ['sha1','sha256','sha384','sha512','md5']) {
    const signature = crypto.sign(algorithm,data,keys().privateKey);
    assert.equal(publicKey().verify(crypto.createHash(algorithm).update(data).digest().toString('binary'),signature.toString('binary')),true);
    assert.equal(verify(forge,'normal',algorithm),true);
    assert.equal(crypto.verify(algorithm,data,keys().publicKey,signature),true);
  }
  assert.equal(verify(forge,'omitted-null'),true);
});

signingTest('malformed nested AlgorithmIdentifier elements are rejected', () => {
  for (const variant of ['extra-null','extra-sequence','nonempty-null','constructed-null','wrong-parameter','outer-extra']) {
    assert.throws(() => verify(forge,variant),/DigestInfo/);
  }
});

signingTest('the published baseline accepts extra nested elements but the hardening rejects them', () => {
  const original = baseline('node-forge');
  assert.equal(verify(original,'extra-null'),true);
  assert.equal(verify(original,'extra-sequence'),true);
  assert.throws(() => verify(forge,'extra-null'),/DigestInfo/);
  assert.throws(() => verify(forge,'extra-sequence'),/DigestInfo/);
});

signingTest('ordinary tampered signatures do not gain acceptance', () => {
  const signature = crypto.sign('sha256',data,keys().privateKey);
  const otherDigest = crypto.createHash('sha256').update('different message').digest().toString('binary');
  assert.equal(publicKey().verify(otherDigest,signature.toString('binary')),false);
});

signingTest('PSS signing verification remains untouched', () => {
  const signature = crypto.sign('sha256',data,{ key:keys().privateKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32 });
  const scheme = forge.pss.create({ md:forge.md.sha256.create(),mgf:forge.mgf.mgf1.create(forge.md.sha256.create()),saltLength:32 });
  assert.equal(publicKey().verify(crypto.createHash('sha256').update(data).digest().toString('binary'),signature.toString('binary'),scheme),true);
});

signingTest('legitimate Expo certificate generation and signing still work', () => {
  const expoSigning = resolve('@expo/code-signing-certificates');
  const securePair = crypto.generateKeyPairSync('rsa',{ modulusLength:2048,publicExponent:65537 });
  const keyPair = { publicKey:forge.pki.publicKeyFromPem(securePair.publicKey.export({ type:'spki',format:'pem' }).toString()),
    privateKey:forge.pki.privateKeyFromPem(securePair.privateKey.export({ type:'pkcs1',format:'pem' }).toString()) };
  const certificate = expoSigning.generateSelfSignedCodeSigningCertificate({ keyPair,validityNotBefore:new Date(Date.now()-86400000),
    validityNotAfter:new Date(Date.now()+86400000),commonName:'Rozare isolated QA signing' });
  assert.equal(certificate.verify(certificate),true);
  expoSigning.validateSelfSignedCertificate(certificate,keyPair);
  const signature = expoSigning.signBufferRSASHA256AndVerify(keyPair.privateKey,certificate,data);
  assert.ok(signature);
});

test('source copies and guard checksums match across backend and mobile', () => {
  const sibling = path.resolve(__dirname,'../../../MobileApp/scripts');
  if (!fs.existsSync(path.join(sibling,'ensure-dependency-security.js'))) return;
  assert.equal(fs.readFileSync(path.join(__dirname,'../ensure-dependency-security.js'),'utf8').replace(/\r\n/g,'\n'),
    fs.readFileSync(path.join(sibling,'ensure-dependency-security.js'),'utf8').replace(/\r\n/g,'\n'));
});
