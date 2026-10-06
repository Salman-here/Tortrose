import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('option-confirmation buttons add the selected variant rather than toggling it off',()=>{
  for(const file of ['../src/components/common/ProductCard.jsx','../src/pages/ProductDetailPage.jsx',
    '../../MobileApp/src/components/ProductCard.js','../../MobileApp/src/screens/ProductDetailScreen.js']){
    const source=readFileSync(new URL(file,import.meta.url),'utf8');
    assert.match(source,/const added = await handleAddToCart\([^\n]+, 'add'\)/);
  }
});
test('a stale cached removal is verified against the server and cannot silently become an add',()=>{
  const source=readFileSync(new URL('../src/contexts/GlobalContext.jsx',import.meta.url),'utf8');
  assert.match(source,/existingCartItem && currentUser && cartAction !== 'add'/);
  assert.match(source,/const authoritative = await fetchAuthoritativeCart\(owner\)/);
  assert.match(source,/if \(!existingCartItem\) \{[\s\S]*?return true;/);
  assert.match(source,/return await handleRemoveCartItem\(existingCartItem\._id\)/);
});
