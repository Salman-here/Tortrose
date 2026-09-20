import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQueryParams, filterValues, filterValueSelected, toggleFilterValue } from '../src/utils/catalogFilterQuery.js';
import { readPriceRange } from '../src/utils/priceFilters.js';
import { verifiedBrandOptions, verifiedBrandLabel } from '../src/utils/verifiedBrandFilters.js';
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
  assert.deepEqual(parseQueryParams('?categories=Home&categories=Books&brandStores=1234567890abcdef12345678&search=%5B&priceRange=0,0&currency=PKR', 'PKR'), {
    categories: ['Home', 'Books'], brands: ['1234567890abcdef12345678'], search: '[', priceRange: ['0', '0'],
  });
  assert.deepEqual(parseQueryParams('?priceRange=1000,2000&currency=PKR', 'USD').priceRange, ['0', '']);
  assert.deepEqual(parseQueryParams('?priceRange=10,&currency=USD', 'USD').priceRange, ['10', '']);
  assert.deepEqual(parseQueryParams('?brands=Unverified&brandStores=bogus', 'USD').brands, []);
});
test('invalid URL ranges are reset rather than silently interpreted as unrelated prices', () => {
  for (const range of ['-1,2', '3,2', 'word,5', '1,2,3']) assert.deepEqual(parseQueryParams('?priceRange=' + range, 'PKR').priceRange, ['0', '']);
});
test('Home uses stable filter content, controlled slider state and full reset/search page resets', () => {
  const source = read('../src/components/Products.jsx');
  assert.match(source, /const renderFilterSidebarContent/); assert.doesNotMatch(source, /<FilterSidebarContent/);
  assert.match(source, /<PriceRangeFilter key=\{`\$\{currency\}-\$\{priceResetKey\}`\}/);
  assert.match(read('../src/components/common/PriceRangeFilter.jsx'), /step='0.01' value=\{min\}/);
  assert.match(source, /const submitSearch = [\s\S]*?currentPageRef\.current = 1/);
  assert.match(source, /const resetAllFilters = [\s\S]*?sortByRef\.current = 'relevance'/);
});

test('price fields support min-only, max-only, zero and decimals without stepper buttons', () => {
  assert.deepEqual(readPriceRange(['', '']), { min: 0, max: null, error: '' });
  assert.deepEqual(readPriceRange(['1.25', '']), { min: 1.25, max: null, error: '' });
  assert.deepEqual(readPriceRange(['1,000.50', '2,000']), { min: 1000.5, max: 2000, error: '' });
  assert.deepEqual(readPriceRange(['', '0']), { min: 0, max: 0, error: '' });
  for (const values of [['2', '1'], ['-1', '2'], ['oops', ''], ['Infinity', ''], ['1e2', '']]) assert.ok(readPriceRange(values).error);
  assert.doesNotMatch(read('../src/components/common/PriceRangeFilter.jsx'), /<button|stepPriceRange/);
});

test('both clients bind brand choices to verified profile IDs, with no Other brands escape', () => {
  const verified = { value: '1234567890abcdef12345678', label: 'Verified example', verified: true };
  assert.deepEqual(verifiedBrandOptions([verified, { ...verified, verified: false }, { value: 'fake', label: 'Fake', verified: true }, verified]), [verified]);
  assert.equal(verifiedBrandLabel([verified], verified.value), 'Verified example');
  assert.equal(verifiedBrandLabel([], verified.value), 'Unavailable brand');
  for (const file of ['../src/components/Products.jsx', '../../MobileApp/src/screens/HomeScreen.js']) {
    const source = read(file);
    assert.match(source, /verifiedBrandOptions\(res\.data\.verifiedBrands\)/);
    assert.match(source, /brandStores/);
    assert.doesNotMatch(source, /otherBrandsCount|__other_brands__/);
  }
});

test('native highest/newest/most sorting matches the corrected descending API direction', () => {
  const source = read('../../MobileApp/src/screens/HomeScreen.js');
  for (const field of ['rating', 'newest', 'popular', 'sales']) assert.match(source, new RegExp(`field: '${field}', order: 'desc'`));
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

test('storefront controls remain mounted after zero matches and store totals are not filtered totals', () => {
  for (const file of ['../src/pages/StorePage.jsx', '../../MobileApp/src/screens/StoreScreen.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /\{\(?products\.length > 0/);
    assert.match(source, /setCatalogTotal\(Number\.isSafeInteger\(res\.data\.catalogTotal\)/);
    assert.match(source, /catalogTotal \?\? '—'/);
  }
});

test('phone-width filter drawer is portalled above navigation and has an accessible close button', () => {
  const source = read('../src/components/Products.jsx');
  assert.match(source, /createPortal\(<AnimatePresence>/);
  assert.match(source, /z-\[71\]/);
  assert.match(source, /aria-label='Close product filters'/);
  assert.match(source, /100dvh - 24px/);
});
