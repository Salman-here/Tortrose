import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQueryParams, getPriceFilterMax, filterValues, filterValueSelected, toggleFilterValue } from '../src/utils/catalogFilterQuery.js';
const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('one-brand and Other-only checkboxes retain array semantics and case-insensitive selection', () => {
  assert.deepEqual(toggleFilterValue([], 'Atlas'), ['Atlas']);
  assert.equal(filterValueSelected(['Atlas'], 'atlas'), true);
  assert.deepEqual(toggleFilterValue(['Atlas'], 'atlas'), []);
  assert.deepEqual(toggleFilterValue([], '__other_brands__'), ['__other_brands__']);
  assert.deepEqual(filterValues(false), []);
  assert.deepEqual(filterValues('Atlas'), ['Atlas']);
  assert.doesNotMatch(read('../src/components/Products.jsx'), /register\('brands'\)/);
});

test('URL filters preserve arrays, punctuation, zero prices and the owning buyer currency', () => {
  assert.deepEqual(parseQueryParams('?categories=Home&categories=Books&brands=A%2BB&search=%5B&priceRange=0,0&currency=PKR', 'PKR'), {
    categories: ['Home', 'Books'], brands: ['A+B'], search: '[', priceRange: ['0', '0'],
  });
  assert.deepEqual(parseQueryParams('?priceRange=1000,2000&currency=PKR', 'USD').priceRange, ['0', String(getPriceFilterMax('USD'))]);
});
test('invalid URL ranges are reset rather than silently interpreted as unrelated prices', () => {
  for (const range of ['-1,2', '3,2', 'word,5', '1,2,3']) assert.deepEqual(parseQueryParams('?priceRange=' + range, 'PKR').priceRange, ['0', '1500000']);
});
test('Home uses stable filter content, controlled slider state and full reset/search page resets', () => {
  const source = read('../src/components/Products.jsx');
  assert.match(source, /const renderFilterSidebarContent/); assert.doesNotMatch(source, /<FilterSidebarContent/);
  assert.match(source, /value=\{Number\(filterPriceRange\[0\]\) \|\| 0\}/);
  assert.match(source, /const submitSearch = [\s\S]*?currentPageRef\.current = 1/);
  assert.match(source, /const resetAllFilters = [\s\S]*?sortByRef\.current = 'relevance'/);
});
test('all web catalog screens discard obsolete responses and distinguish request failures', () => {
  for (const relative of ['../src/components/Products.jsx', '../src/pages/StoresListing.jsx', '../src/pages/StorePage.jsx']) {
    const source = read(relative); assert.match(source, /requestId !== \w+\.current/);
    assert.match(source, /requestId === \w+\.current/);
  }
  assert.match(read('../src/pages/StoresListing.jsx'), /loadError \? \(/);
  const store = read('../src/pages/StorePage.jsx');
  assert.match(store, /productsError \? \(/);
  assert.match(store, /debouncedSearch \|\| selectedCategory !== 'all' \? 'No products match your filters'/);
});
test('store product screens reset pagination with query identity and pass buyer currency', () => {
  for (const file of ['../src/pages/StorePage.jsx', '../../MobileApp/src/screens/StoreScreen.js']) {
    const source = read(file);
    assert.match(source, /productQueryRef/); assert.match(source, /productPage !== 1/);
    assert.match(source, /params\.set\('currency', currency\)/);
  }
});
test('mobile resets numeric thresholds when currency changes and preserves a genuine zero maximum', () => {
  const source = read('../../MobileApp/src/screens/HomeScreen.js');
  assert.match(source, /previousCurrencyRef\.current = currency;[\s\S]*?setPriceRange\(DEFAULT_PRICE_RANGE\)/);
  assert.match(source, /requestFilters\.priceRange\.max \?\? 'Infinity'/);
  assert.match(source, /priceFilterError\(filterDraft\.priceRange\)/);
});
