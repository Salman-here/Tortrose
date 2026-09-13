import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCurrencyCode } from '../src/utils/currencySafety.js';
import { inspectSellerProductCurrencyState } from '../src/utils/productFormCurrency.js';

const source = readFileSync(new URL('../src/components/layout/StoreSettings.jsx', import.meta.url), 'utf8');
const update = source.slice(source.indexOf('const requestProductCurrencyChange ='), source.indexOf('const handleProductCurrencySelect ='));

test('currency confirmation submits its exact reviewed quote', () => {
  assert.match(update, /quoteToken: confirm \? productCurrencyConfirm\?\.quoteToken : undefined/);
});

test('a confirmed currency save cannot be presented as cancelled while it is in flight', () => {
  assert.match(source, /const cancelProductCurrencyConfirmation = \(\) => \{\s*if \(productCurrencySaving\) return;/);
  assert.match(source, /disabled=\{productCurrencySaving\} onClick=\{cancelProductCurrencyConfirmation\}/);
});

test('the real currency-save handler refreshes local analytics after a successful switch', async () => {
  const state = code => ({ hasStore:true,canAddProduct:true,activeCurrency:code,status:'active',pendingCurrency:null,previousCurrency:null,productCount:3,productCurrencies:[code],productCurrencyCounts:{[code]:3} });
  let displayedState = state('PKR'), analyticsRefreshes = 0, requestBody;
  const noop = () => {};
  const bindings = {
    normalizeCurrencyCode, inspectSellerProductCurrencyState, productCurrencyInfo:displayedState, productCurrencyError:'',
    productCurrencyConfirm:{quoteToken:'reviewed-test-quote'}, productCurrencyRequestRef:{current:0}, getAuthToken:()=> 'test-only',
    axios:{patch:async (_url, body) => {requestBody=body;return {data:{requiresConfirmation:false,productCurrency:state('USD')}};}},
    setProductCurrencySaving:noop,setProductCurrencyLoading:noop,setProductCurrencyDraft:noop,setProductCurrencyConfirm:noop,setProductCurrencyError:noop,
    setProductCurrencyInfo:next=>{displayedState=next;}, clearPersistedProductCurrency:()=>{throw new Error('Unexpected failure');},
    fetchAnalytics:()=>{analyticsRefreshes++;},outletContext:{},toast:{success:noop,error:noop},
  };
  const expression = update.replace('const requestProductCurrencyChange =', 'return').replaceAll('import.meta.env.VITE_API_URL', "'https://local.test/'");
  const handler = new Function(...Object.keys(bindings), expression)(...Object.values(bindings));
  await handler('USD', true);
  assert.equal(displayedState.activeCurrency, 'USD');
  assert.equal(requestBody.quoteToken, 'reviewed-test-quote');
  assert.equal(analyticsRefreshes, 1, 'local settings analytics must be fetched again in the new store currency');
  assert.match(source, /analytics && analytics.currency === productCurrencyInfo\?\.activeCurrency/);
});
