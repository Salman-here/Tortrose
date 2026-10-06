import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCancellationQuote } from '../src/utils/cancellationQuote.js';
const args = { orderId:'o1',currency:'PKR',paymentMethod:'safepay',sellerIds:['s1'],grossMinor:1000000 };
const quote = () => ({ version:1,quoteId:'a'.repeat(64),orderId:'o1',currency:'PKR',paymentMethod:'safepay',sellerIds:['s1'],activeSellerIds:['s1'],
  grossMinor:1000000,policyVersion:1,defaultDestination:'wallet',options:[
    {destination:'wallet',label:'Rozare Wallet',amountMinor:1000000,deductionMinor:0,available:true},
    {destination:'original_card',label:'Original card',amountMinor:935000,deductionMinor:65000,available:true}] });
test('accepts the exact full-Wallet vs net-card quote',()=>assert.equal(assertCancellationQuote(quote(),args).options[1].amountMinor,935000));
test('rejects altered order/currency/scope/refund money and missing options',()=>{
  for(const mutate of [q=>q.orderId='o2',q=>q.currency='USD',q=>q.sellerIds=['s2'],q=>q.activeSellerIds.push('s2'),
    q=>q.options[0].deductionMinor=1,q=>q.options[1].amountMinor++,q=>q.options[1].deductionMinor='65000',q=>q.options.pop(),q=>q.defaultDestination='original_card']){
    const q=quote();mutate(q);assert.throws(()=>assertCancellationQuote(q,args));
  }
});
test('Wallet cancellation accepts only ONE full-Wallet option',()=>{
  const q=quote();q.paymentMethod='wallet';q.options.pop();
  assert.equal(assertCancellationQuote(q,{...args,paymentMethod:'wallet'}).options.length,1);
  q.options.push(quote().options[1]);assert.throws(()=>assertCancellationQuote(q,{...args,paymentMethod:'wallet'}));
});
test('COD and zero orders need no money refund',()=>{
  const q={...quote(),paymentMethod:'cash_on_delivery',defaultDestination:'none',options:[{destination:'none',label:'No refund required',amountMinor:0,deductionMinor:0,available:true}]};
  assert.equal(assertCancellationQuote(q,{...args,paymentMethod:'cash_on_delivery'}).options[0].amountMinor,0);
  q.paymentMethod='safepay';q.grossMinor=0;assert.equal(assertCancellationQuote(q,{...args,grossMinor:0}).options.length,1);
});
test('web and mobile enforce the same refund quote contract',()=>assert.equal(
  readFileSync(new URL('../src/utils/cancellationQuote.js',import.meta.url),'utf8'),
  readFileSync(new URL('../../MobileApp/src/utils/cancellationQuote.js',import.meta.url),'utf8')));
