import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('inline detail options explicitly add, while product cards use the variant manager',()=>{
  for(const file of ['../src/pages/ProductDetailPage.jsx', '../../MobileApp/src/screens/ProductDetailScreen.js']){
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(source,/handleAddToCart\([^\n]+, 'add'\)/);
  }
  for(const file of ['../src/components/common/ProductCard.jsx', '../../MobileApp/src/components/ProductCard.js']) assert.match(readFileSync(new URL(file,import.meta.url),'utf8'), /<CartVariantsDialog/);
  for(const file of ['../src/components/common/CartVariantsDialog.jsx', '../../MobileApp/src/components/CartVariantsDialog.js']) {
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(source, /handleAddToCart\([^\n]+['"]add['"]\)/);
    assert.match(source, /displayView === 'edit'[\s\S]*?await handleEditCartVariant/);
    assert.match(source, /setEditing\(null\); onClose\(\)/);
  }
});
test('a stale cached removal is verified against the server and cannot silently become an add',()=>{
  const source=readFileSync(new URL('../src/contexts/GlobalContext.jsx',import.meta.url),'utf8');
  assert.match(source,/existingCartItem && currentUser && cartAction !== 'add'/);
  assert.match(source,/const authoritative = await fetchAuthoritativeCart\(owner\)/);
  assert.match(source,/if \(!existingCartItem\) \{[\s\S]*?return true;/);
  assert.match(source,/return await handleRemoveCartItem\(existingCartItem\._id\)/);
});
