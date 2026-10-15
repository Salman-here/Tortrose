import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
async function shared(file) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(`../../MobileApp/src/content/${file}`, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const { commercePolicies, checkoutPolicyNotice, policyConfig } = await shared('commercePolicies.js');
const { commerceFaqCategories, commerceGuides, formatSubscriptionGuide } = await shared('commerceHelpContent.js');
const { privacySections, paymentPrivacyNotice } = await shared('privacyContent.js');
const content = (policy, id) => commercePolicies[policy].sections.find(section => section.id === id).content;

test('policy sections have unique stable anchors and complete published content', () => {
  assert.equal(policyConfig.updatedAt, 'October 16, 2026');
  for (const document of Object.values(commercePolicies)) {
    assert.equal(new Set(document.sections.map(section => section.id)).size, document.sections.length);
    for (const section of document.sections) { assert.match(section.id, /^[a-z][a-z-]+$/); assert(section.content.length > 80); assert(!/undefined|TODO|lorem ipsum/i.test(section.content)); }
  }
  assert.equal(new Set(privacySections.map(section => section.id)).size, privacySections.length);
});

test('seller terms preserve the fixed financial rule without obsolete Payments-box promises', () => {
  const fees = content('terms', 'seller-fees'), funds = content('terms', 'seller-funds');
  assert.match(fees, /6\.2%.*PKR30 once per checkout/); assert.match(fees, /share the deduction proportionally/); assert.match(fees, /COD.*excluded/); assert.match(fees, /Withdrawals do not charge.*again/);
  assert.match(funds, /All-time totals are independent/); assert.match(funds, /UTC calendar-day/);
  assert.doesNotMatch(funds, /Payments shows gross|combined deduction box/);
  assert.match(content('terms', 'payment-reviews'), /final provider decision with supporting evidence/);
  assert.match(content('terms', 'payment-reviews'), /Future eligible earnings first cover/);
  const accounting = source('../../Backend/services/onlineOrderFeeService.js');
  assert.match(accounting, /RATE_BPS = 620/); assert.match(accounting, /FIXED_PKR_MINOR = 3000/);
});

test('native subscription formatting improves paragraphs without changing the catalog terms', () => {
  const original = 'Trial access. Paid Starter costs $9.99. Paid Elite costs $21.65. The first 100 qualify. Upgrades use a quote. When access ends data stays. A Starter seller can renew.';
  const formatted = formatSubscriptionGuide(original);
  assert.match(formatted, /\n\nPaid Starter/);
  assert.equal(formatted.replace(/\s+/g, ' '), original);
});

test('refund policies distinguish Wallet, original-card cancellation and Raast-only Wallet flow', () => {
  assert.match(content('refunds', 'wallet-refunds'), /credited to your Rozare Wallet in the saved order currency/);
  assert.match(content('refunds', 'wallet-refunds'), /no buyer processing deduction/);
  assert.match(content('cancellation', 'refund-choices'), /Raast cancellation flow is Wallet-only/);
  assert.match(content('cancellation', 'refund-choices'), /original-card refund less/);
  assert.match(content('cancellation', 'card-deduction'), /does not apply to a full Wallet/);
});

test('return, replacement and warranty disclosures preserve the implemented decision boundaries', () => {
  assert.match(content('refunds', 'request-review'), /1 to 6.*photos/); assert.match(content('refunds', 'request-review'), /before collection or return shipment/);
  assert.match(content('refunds', 'approved-return'), /does not allow.*reject an already approved return/);
  assert.match(content('refunds', 'replacements'), /does not.*create a money refund/);
  assert.match(content('refunds', 'warranty-claims'), /duration starts from delivery/);
  assert.match(content('refunds', 'warranty-claims'), /Before approving.*declares the resolution/);
  assert.match(content('refunds', 'warranty-appeals'), /even if the warranty expires/);
  assert.match(content('refunds', 'warranty-funding'), /claim alone does not reserve or hold/);
});

test('checkout is one short notice plus working policy links, with detailed fees only on pages', () => {
  const links = [checkoutPolicyNotice.terms, ...checkoutPolicyNotice.links];
  assert.equal(links.length, 5);
  assert(checkoutPolicyNotice.introduction.split(/\s+/).length < 15);
  assert.doesNotMatch(JSON.stringify(checkoutPolicyNotice), /6\.2|PKR30|support review|processing deduction|approved product returns/i);
  const screens = new Map(Object.values(commercePolicies).map(document => [document.path, document.screen])); screens.set('/privacy', 'PrivacyPolicy');
  links.forEach(link => assert.equal(link.screen, screens.get(link.path)));
  const web = source('../src/components/common/CheckoutPolicyLinks.jsx');
  const native = source('../../MobileApp/src/components/common/CheckoutPolicyNotice.js');
  assert.match(web, /checkoutPolicyNotice\.links\.map/); assert.match(native, /checkoutPolicyNotice\.links\.map/);
  assert.match(source('../../MobileApp/src/screens/CheckoutScreen.js'), /<CheckoutPolicyNotice onOpenPolicy/);
});

test('FAQ and guide links resolve to public policies and both surfaces consume shared data', () => {
  const allowed = new Map(Object.values(commercePolicies).map(document => [document.path, document.screen])); allowed.set('/privacy', 'PrivacyPolicy'); allowed.set('/contact', 'Contact');
  const questions = commerceFaqCategories.flatMap(category => category.questions);
  assert.equal(new Set(questions.map(item => item.id)).size, questions.length);
  for (const item of [...questions, ...Object.values(commerceGuides)]) for (const link of item.links) assert.equal(link.screen, allowed.get(link.path));
  for (const path of ['../src/pages/FAQPage.jsx', '../../MobileApp/src/screens/FAQScreen.js']) assert.match(source(path), /commerceFaqCategories\.map/);
  for (const path of ['../src/pages/DocsPage.jsx', '../../MobileApp/src/screens/DocsScreen.js']) for (const guide of ['payments', 'returns', 'warranties', 'sellerMoney']) assert(source(path).includes(`commerceGuides.${guide}`));
  for (const path of ['../src/pages/PrivacyPolicy.jsx', '../../MobileApp/src/screens/PrivacyPolicyScreen.js']) assert.match(source(path), /privacySections\.map/);
  assert.match(paymentPrivacyNotice, /not your full card number or CVV/);
});

test('all legal pages are prerendered and docs app links have a canonical SSR destination', () => {
  const config = JSON.parse(source('../vercel.json'));
  for (const [path, destination] of [['/terms', 'terms'], ['/refund-policy', 'refunds'], ['/shipping-policy', 'shipping'], ['/cancellation-policy', 'cancellation'], ['/privacy', 'privacy']]) assert(config.rewrites.some(rule => rule.source === path && rule.destination === `/policy-${destination}.html`));
  assert.match(source('../scripts/policies-ssr-entry.jsx'), /key: 'privacy', path: '\/privacy'/);
  assert.match(source('../src/pages/DocsPage.jsx'), /typeof window === 'undefined'\) return `https:\/\/rozare\.com\$\{path\}`/);
  assert.match(source('../src/pages/CommercePolicyPage.jsx'), /getElementById\(sectionId\)/);
});
