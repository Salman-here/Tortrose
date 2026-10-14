import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWarrantyCoverage, inspectWarrantyList } from '../src/utils/warrantySafety.js';
const ids = { order:'64b000000000000000000001', item:'64b000000000000000000002', product:'64b000000000000000000003', seller:'64b000000000000000000004', buyer:'64b000000000000000000005', claim:'64b000000000000000000006' };
const at='2026-10-14T10:00:00.000Z', delivered='2026-10-01T10:00:00.000Z', deadline='2026-11-01T10:00:00.000Z';
const order={_id:ids.order,orderId:'ORD-WARRANTY',currency:'PKR',orderItems:[{_id:ids.item,productId:ids.product,seller:ids.seller,name:'Mug',quantity:1,price:100,lineSubtotal:100}],orderSummary:{totalAmount:100}};
const coverage={version:1,orderId:ids.order,currency:'PKR',groups:[{seller:{_id:ids.seller},items:[{orderItemId:ids.item,purchasedQuantity:1,availableQuantity:1,eligible:true,reason:'',months:1,deliveredAt:delivered,deadline}]}]};
const claim={_id:ids.claim,kind:'warranty',order:ids.order,orderId:order.orderId,buyer:ids.buyer,seller:{_id:ids.seller,username:'Seller'},store:null,storeName:'QA Store',returnNumber:'WAR-1',currency:'PKR',status:'requested',resolution:null,reasonCategory:'defective',reasonDetails:'The mug lid is faulty.',createdAt:at,updatedAt:at,requestedAt:at,eligibilityDeadline:deadline,
  warrantySnapshot:{version:1,months:1,deliveredAt:delivered,deadline},evidenceUrls:['https://example.com/evidence.png'],
  statusHistory:[{status:'requested',note:'The mug lid is faulty.',changedAt:at,changedBy:ids.buyer,actorRole:'buyer'}],
  items:[{orderItemId:ids.item,productId:ids.product,name:'Mug',image:'',quantity:1,purchasedQuantity:1,unitPrice:100,lineSubtotal:100}],
  policySnapshot:{returnsEnabled:true,returnDuration:1,refundType:'full_refund'},refund:{itemSubtotal:100,taxAmount:0,shippingAmount:0,discountAmount:0,totalAmount:100}};
test('coverage and an owned warranty use verified original order identity and money',()=>{
  assert.equal(inspectWarrantyCoverage(coverage,order).valid,true);assert.equal(inspectWarrantyList([claim],order),true);
  assert.equal(inspectWarrantyList([{ ...claim, evidenceHistory: [{ version: 0, submittedAt: at, reason: claim.reasonDetails, urls: claim.evidenceUrls }] }], order), true);
});
for(const [name,mutate] of [
  ['wrong order',row=>row.order='64b000000000000000000099'],
  ['wrong seller',row=>row.seller._id='64b000000000000000000099'],
  ['wrong currency',row=>row.currency='USD'],
  ['changed product',row=>row.items[0].productId='64b000000000000000000099'],
  ['changed original price',row=>row.items[0].unitPrice=200],
  ['unreconciled refund',row=>row.refund.totalAmount=200],
  ['invalid photo scheme',row=>row.evidenceUrls=['javascript:alert(1)']],
  ['missing approved resolution',row=>{row.status='approved';row.statusHistory.push({...row.statusHistory[0],status:'approved'});}],
  ['late original claim',row=>row.requestedAt='2026-12-01T10:00:00.000Z'],
  ['invalid prior evidence',row=>row.evidenceHistory=[{version:0,reason:'valid original reason',submittedAt:at,urls:['javascript:alert(1)']}]],
]) test('refuses warranty '+name,()=>{const row=structuredClone(claim);mutate(row);assert.equal(inspectWarrantyList([row],order),false);});
test('coverage refuses missing lines and excessive or fractional eligibility quantities',()=>{
  for(const mutate of [row=>row.groups=[],row=>row.groups[0].items[0].availableQuantity=2,row=>row.groups[0].items[0].availableQuantity=0.5,row=>row.groups[0].items[0].months=1.5]){
    const row=structuredClone(coverage);mutate(row);assert.equal(inspectWarrantyCoverage(row,order).valid,false);
  }
});
