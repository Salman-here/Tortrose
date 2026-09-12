'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../services/currencyService', () => ({ ...jest.requireActual('../../services/currencyService'), getExchangeRateSnapshot: jest.fn() }));
const User = require('../../models/User');
const Store = require('../../models/Store');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Coupon = require('../../models/Coupon');
const ShippingMethod = require('../../models/ShippingMethod');
const Preview = require('../../models/AIStoreCurrencyPreview');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');
const SellerSettlementLock = require('../../models/SellerSettlementLock');
const NotificationOutbox = require('../../models/NotificationOutbox');
const { getExchangeRateSnapshot } = require('../../services/currencyService');
const { requestProductCurrencyChange, withProductCurrencyWriteLock } = require('../../services/storeProductCurrencyService');
const { buildOrderSellerSettlement, buildOrderSellerCurrencyMoney } = require('../../services/orderMoneyService');
const { createWithdrawalRequest, buildSellerPaymentSummary, buildAdminPaymentsOverviewData, updateWithdrawalRequestStatus } = require('../../controllers/PaymentController');
const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
const snapshot = () => ({ base: 'USD', rates, capturedAt: new Date().toISOString(), fallback: false, source: 'test-provider' });
let replica, savedKey, savedKeyId;
beforeAll(async () => {
  savedKey=process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY; savedKeyId=process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY=Buffer.alloc(32,19).toString('base64'); process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID='native-test';
  replica=await MongoMemoryReplSet.create({replSet:{count:1}}); await mongoose.connect(replica.getUri());
  await Promise.all([User,Store,Product,Order,Coupon,ShippingMethod,Preview,SellerPaymentAccount,SellerWithdrawalRequest,SellerSettlementLock,NotificationOutbox].map(m=>m.init()));
},60000);
beforeEach(()=>getExchangeRateSnapshot.mockResolvedValue(snapshot()));
afterEach(async()=>{jest.restoreAllMocks(); await Promise.all(Object.values(mongoose.models).map(m=>m.deleteMany({})));});
afterAll(async()=>{if(savedKey===undefined)delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY=savedKey;if(savedKeyId===undefined)delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID=savedKeyId;await mongoose.disconnect();if(replica)await replica.stop();},60000);
async function fixture(currency='PKR', count=1) {
  const seller=await User.create({username:'Native Seller',email:`${new mongoose.Types.ObjectId()}@example.com`,role:'seller',currency});
  const store=await Store.create({seller:seller._id,storeName:'Native Store',storeSlug:`native-${seller._id}`,productCurrency:currency,productCurrencyStatus:'active',isActive:true});
  const products=count?await Product.create(Array.from({length:count},(_,i)=>({seller:seller._id,name:`Cup ${i}`,description:'Durable reusable cup',price:100*rates[currency],discountedPrice:80*rates[currency],currency,priceCurrency:currency,discountedPriceCurrency:currency,priceInputAmount:100*rates[currency],discountedPriceInputAmount:80*rates[currency],stock:10,category:'Drinkware',brand:'QA',image:'https://example.com/cup.png'}))):[];
  return {seller,store,products};
}
const response=()=>{const r={statusCode:200,body:null};r.status=function(s){this.statusCode=s;return this};r.json=function(b){this.body=b;return this};return r};
async function withdraw(seller,amount,currency,key='native-request') {const res=response();await createWithdrawalRequest({user:{id:String(seller._id),role:'seller',currency:seller.currency,username:seller.username},body:{amount,currency,amountUSD:999999},get:()=>key},res);return res;}
async function transition(admin,request,from,to,extra={}) {const res=response();await updateWithdrawalRequestStatus({user:{id:String(admin._id),role:'admin'},params:{id:String(request._id)},body:{expectedStatus:from,status:to,...extra},get:()=>`${request._id}-${from}-${to}`},res);return res;}
async function earned(seller,product,currency='PKR',buyerCurrency=currency) {
  const value=100*rates[buyerCurrency];
  const data={user:new mongoose.Types.ObjectId(),orderId:`ORD-${Date.now()}-${new mongoose.Types.ObjectId()}`,currency:buyerCurrency,
    orderItems:[{productId:product._id,seller:seller._id,name:product.name,image:product.image,price:value,lineSubtotal:value,sourcePrice:100*rates[currency],sourceLineSubtotal:100*rates[currency],sourceCurrency:currency,quantity:1}],
    shippingInfo:{fullName:'QA Buyer',email:'buyer@example.com',phone:'+12025550101',address:'1 QA Road',city:'Lahore',state:'Punjab',postalCode:'54000',country:'Pakistan'},
    shippingMethod:{name:'free',price:0,estimatedDays:3,seller:seller._id},sellerShipping:[{seller:seller._id,shippingMethod:{name:'free',price:0,sourceCost:0,sourceCurrency:currency,estimatedDays:3}}],
    sellerPolicies:[{seller:seller._id,productCurrency:currency}],orderSummary:{subtotal:value,shippingCost:0,tax:0,couponDiscount:0,totalAmount:value},
    paymentMethod:'stripe',isPaid:true,isDelivered:true,orderStatus:'delivered',sellerFulfillment:[{seller:seller._id,status:'delivered'}],exchangeRateSnapshot:snapshot()};
  const doc=new Order(data);doc.sellerSettlementVersion=1;doc.sellerSettlement=buildOrderSellerSettlement(doc,{requireOrderTotal:true});doc.sellerCurrencyMoneyVersion=1;doc.sellerCurrencyMoney=buildOrderSellerCurrencyMoney(doc);await doc.save();return doc;
}
const bank=(seller,currency)=>SellerPaymentAccount.create({seller:seller._id,accountHolderName:'QA Account Holder',bankName:'QA Test Bank',accountNumber:'001122334455',accountNumberLast4:'4455',country:'Pakistan',countryCode:'PK',currency,isActive:true});

test('300 products use a bounded preview; regular/sale/shipping/coupon money converts at exactly the reviewed rate',async()=>{
  const {seller,products}=await fixture('PKR',300);
  await ShippingMethod.create({seller:seller._id,methods:[{type:'standard',cost:280,currency:'PKR',costCurrency:'PKR',costInputAmount:280,deliveryDays:3,isActive:true},{type:'free',cost:0,currency:'PKR',costCurrency:'PKR',costInputAmount:0,deliveryDays:5,isActive:false}]});
  const coupon=await Coupon.create({seller:seller._id,code:'TENOFF',discountType:'percentage',discountValue:10,currency:'PKR',minOrderAmount:2800,maxDiscountAmount:560,expiryDate:new Date(Date.now()+86400000)});
  const oldOrder=await earned(seller,products[0]); const original=await Order.findById(oldOrder._id).lean();
  const preview=await requestProductCurrencyChange(seller._id,'USD');
  expect(preview.preview.productCount).toBe(300);expect(preview.preview.examples).toHaveLength(3);expect(preview.msg.length).toBeLessThan(2400);expect(preview.preview.shippingExamples).toHaveLength(2);
  expect((await Store.findOne({seller:seller._id})).productCurrency).toBe('PKR');
  getExchangeRateSnapshot.mockResolvedValue({...snapshot(),rates:{...rates,PKR:300}});
  const result=await requestProductCurrencyChange(seller._id,'USD',{confirm:true,quoteToken:preview.quoteToken});expect(result.activeCurrency).toBe('USD');
  const saved=await Product.find({seller:seller._id}).lean();expect(saved).toHaveLength(300);saved.forEach(p=>expect(p).toMatchObject({price:100,discountedPrice:80,currency:'USD',stock:10}));
  expect((await ShippingMethod.findOne({seller:seller._id})).methods[0]).toMatchObject({cost:1,currency:'USD',costInputAmount:1,deliveryDays:3});
  expect(await Coupon.findById(coupon._id).lean()).toMatchObject({discountValue:10,currency:'USD',minOrderAmount:10,maxDiscountAmount:2,usedCount:0});
  expect(await Order.findById(oldOrder._id).lean()).toEqual(original);
  const summary=await buildSellerPaymentSummary(seller._id,{displayCurrency:'USD'});expect(summary.balanceByCurrency.PKR.withdrawableBalance).toBe(28000);expect(summary.balanceByCurrency.USD.withdrawableBalance).toBe(0);expect(summary.displayRevenue.totalDeliveredRevenue).toBe(100);
},60000);

test.each(['shipping','coupon','product','new-coupon'])('%s edit after preview rejects all changes',async kind=>{
  const {seller,products}=await fixture();
  const shipping=await ShippingMethod.create({seller:seller._id,methods:[{type:'standard',cost:280,currency:'PKR',costCurrency:'PKR',costInputAmount:280,deliveryDays:3,isActive:true}]});
  const coupon=await Coupon.create({seller:seller._id,code:'FIXED',discountType:'fixed',discountValue:280,currency:'PKR',expiryDate:new Date(Date.now()+86400000)});
  const p=await requestProductCurrencyChange(seller._id,'USD');
  if(kind==='shipping')await ShippingMethod.updateOne({_id:shipping._id},{$set:{'methods.0.deliveryDays':4}});
  if(kind==='coupon')await Coupon.updateOne({_id:coupon._id},{$set:{discountValue:560}});
  if(kind==='product')await Product.updateOne({_id:products[0]._id},{$set:{stock:9}});
  if(kind==='new-coupon')await withProductCurrencyWriteLock(seller._id,'PKR',async session=>Coupon.create([{seller:seller._id,code:'NEWONE',discountType:'percentage',discountValue:5,currency:'PKR',expiryDate:new Date(Date.now()+86400000)}],{session}));
  await expect(requestProductCurrencyChange(seller._id,'USD',{confirm:true,quoteToken:p.quoteToken})).rejects.toMatchObject({code:'PRODUCT_CURRENCY_CONVERSION_CONFLICT'});
  expect((await Store.findOne({seller:seller._id})).productCurrency).toBe('PKR');
  expect((await Product.findById(products[0]._id)).currency).toBe('PKR');
});

test.each([['USD',5],['PKR',2000],['EUR',5],['GBP',5]])('%s native minimum, same-currency reservation, idempotent retries and bank mismatch',async(currency,minimum)=>{
  const {seller,products}=await fixture(currency);await earned(seller,products[0],currency);await bank(seller,currency);
  getExchangeRateSnapshot.mockRejectedValue(new Error('Live FX offline; native withdrawal must not call it'));
  expect((await withdraw(seller,minimum-0.01,currency,'under')).statusCode).toBe(400);
  const first=await withdraw(seller,minimum,currency);expect(first.statusCode).toBe(201);expect(first.body.withdrawal).toMatchObject({balanceVersion:2,amount:minimum,currency,requestedAmount:minimum,payoutAmount:minimum,payoutCurrency:currency});
  expect(first.body.withdrawal.paymentAccountSnapshotEnvelope).toBeUndefined();
  const retry=await withdraw(seller,minimum,currency);expect(retry.statusCode).toBe(200);expect(retry.body.reused).toBe(true);expect(await SellerWithdrawalRequest.countDocuments({})).toBe(1);
  const summary=await buildSellerPaymentSummary(seller._id,{displayCurrency:currency});expect(summary.balanceByCurrency[currency].withdrawableBalance).toBe(100*rates[currency]-minimum);
  const other=currency==='USD'?'EUR':'USD';expect((await withdraw(seller,5,other,'wrong-bank')).body.code).toBe('WITHDRAWAL_BANK_CURRENCY_MISMATCH');
});

test('admin approval is not payment; processing uncertainty holds funds; evidence marks paid in original currency',async()=>{
  const {seller,products}=await fixture();await earned(seller,products[0]);await bank(seller,'PKR');
  const admin=await User.create({username:'QA Admin',email:'admin-native@example.com',role:'admin'});
  const created=await withdraw(seller,2000,'PKR');expect(created.statusCode).toBe(201);const request=created.body.withdrawal;
  let res=await transition(admin,request,'pending','approved');expect(res.statusCode).toBe(200);
  expect((await SellerWithdrawalRequest.findById(request._id)).status).toBe('approved');
  res=await transition(admin,request,'approved','paid',{transferReference:'QA-BANK-0001'});expect(res.statusCode).toBeGreaterThanOrEqual(400);
  res=await transition(admin,request,'approved','processing',{payoutProvider:'Manual bank transfer',attemptId:'native-payout-1'});expect(res.statusCode).toBe(200);
  res=await transition(admin,request,'processing','manual_review',{attemptId:'native-payout-1',reconciliationNote:'Bank response uncertain; hold funds.'});expect(res.statusCode).toBe(200);
  expect((await buildSellerPaymentSummary(seller._id,{displayCurrency:'PKR'})).balanceByCurrency.PKR.withdrawableBalance).toBe(26000);
  res=await transition(admin,request,'manual_review','paid',{attemptId:'native-payout-1',payoutProvider:'Manual bank transfer',transferReference:'QA-BANK-0001',transferredAt:new Date().toISOString(),evidenceType:'provider_reference'});expect(res.statusCode).toBe(200);
  const paid=await SellerWithdrawalRequest.findById(request._id);expect(paid).toMatchObject({status:'paid',amount:2000,currency:'PKR',payoutAmount:2000,payoutCurrency:'PKR'});
  expect((await buildSellerPaymentSummary(seller._id,{displayCurrency:'PKR'})).balanceByCurrency.PKR.totalWithdrawn).toBe(2000);
});

test('concurrent withdrawals cannot reserve the same native funds twice', async () => {
  const { seller, products } = await fixture(); await earned(seller, products[0]); await bank(seller, 'PKR');
  // Create the serialization row before racing distinct intents.
  await SellerSettlementLock.create({ seller: seller._id, version: 0 });
  const results = await Promise.all([withdraw(seller,20000,'PKR','race-one'),withdraw(seller,20000,'PKR','race-two')]);
  expect(results.filter(result => result.statusCode === 201)).toHaveLength(1);
  expect(results.filter(result => result.statusCode === 400)).toHaveLength(1);
  expect(await SellerWithdrawalRequest.countDocuments({})).toBe(1);
  const summary = await buildSellerPaymentSummary(seller._id,{displayCurrency:'PKR'});
  expect(summary.balanceByCurrency.PKR.withdrawableBalance).toBe(8000);
});
test.each([true, [], ' ', -1, 0, 5.001, 1e100])('invalid withdrawal amount %j creates no reservation', async amount => {
  const { seller, products } = await fixture('USD'); await earned(seller,products[0],'USD'); await bank(seller,'USD');
  const result=await withdraw(seller,amount,'USD');
  expect(result.statusCode).toBe(400); expect(result.body.code).toBe('WITHDRAWAL_AMOUNT_INVALID');
  expect(await SellerWithdrawalRequest.countDocuments({})).toBe(0);
});

test.each(Object.keys(rates).flatMap(from => Object.keys(rates).filter(to => to !== from).map(to => [from,to])))('%s to %s converts fixed coupon and paid shipping with unchanged non-money settings', async(from,to) => {
  const { seller, products } = await fixture(from);
  await ShippingMethod.create({ seller:seller._id,methods:[{type:'standard',cost:2*rates[from],currency:from,costCurrency:from,costInputAmount:2*rates[from],deliveryDays:7,isActive:true}] });
  const coupon=await Coupon.create({seller:seller._id,code:'FIXED',discountType:'fixed',discountValue:Number((3*rates[from]).toFixed(2)),currency:from,minOrderAmount:10*rates[from],maxDiscountAmount:5*rates[from],maxUses:10,maxUsesPerUser:2,expiryDate:new Date(Date.now()+86400000)});
  const quote=await requestProductCurrencyChange(seller._id,to);
  await requestProductCurrencyChange(seller._id,to,{confirm:true,quoteToken:quote.quoteToken});
  const shipping=await ShippingMethod.findOne({seller:seller._id}).lean();
  expect(shipping.methods[0]).toMatchObject({cost:Number((2*rates[to]).toFixed(2)),currency:to,deliveryDays:7,isActive:true});
  const savedCoupon=await Coupon.findById(coupon._id).lean();
  expect(savedCoupon).toMatchObject({discountValue:Number((3*rates[to]).toFixed(2)),currency:to,minOrderAmount:10*rates[to],maxDiscountAmount:5*rates[to],maxUses:10,maxUsesPerUser:2});
  expect(savedCoupon.expiryDate).toEqual(coupon.expiryDate);
  expect((await Product.findById(products[0]._id)).stock).toBe(10);
});
test.each(['shipping','coupon'])('rejects a positive %s amount that would round to zero without partial writes',async kind=>{
  const {seller,products}=await fixture();
  if(kind==='shipping')await ShippingMethod.create({seller:seller._id,methods:[{type:'standard',cost:0.01,currency:'PKR',costCurrency:'PKR',costInputAmount:0.01,deliveryDays:3,isActive:true}]});
  else await Coupon.create({seller:seller._id,code:'TINY',discountType:'percentage',discountValue:10,currency:'PKR',maxDiscountAmount:0.01,expiryDate:new Date(Date.now()+86400000)});
  await expect(requestProductCurrencyChange(seller._id,'USD')).rejects.toThrow(/round to zero/);
  expect((await Product.findById(products[0]._id)).currency).toBe('PKR');
  expect((await Store.findOne({seller:seller._id})).lastProductCurrencyChangeAt).toBeNull();
});

test('native admin overview and both payment clients agree after a currency change and reservation', async () => {
  const { seller, products } = await fixture('PKR');
  await earned(seller, products[0]); await bank(seller, 'PKR');
  const preview = await requestProductCurrencyChange(seller._id, 'USD');
  await requestProductCurrencyChange(seller._id, 'USD', { confirm: true, quoteToken: preview.quoteToken });
  expect((await withdraw(seller, 2000, 'PKR')).statusCode).toBe(201);
  const overview = { success: true, ...await buildAdminPaymentsOverviewData() };
  expect(overview.errors).toEqual([]);
  expect(overview.summaryByCurrency.PKR).toMatchObject({ withdrawableBalance: 26000, deliveredStripeOrders: 1, totalRelevantOrders: 1 });
  expect(overview.summaryByCurrency.USD).toMatchObject({ withdrawableBalance: 0, totalRelevantOrders: 0 });
  expect(overview.sellers[0].revenue.totalDeliveredRevenue).toBe(100);
  const sellerSummary = await buildSellerPaymentSummary(seller._id, { displayCurrency: 'USD' });
  const { pathToFileURL } = require('url'), path = require('path');
  const adminUrl = pathToFileURL(path.resolve(__dirname, '../../../Frontend/src/utils/adminPaymentsSafety.js')).href;
  const webUrl = pathToFileURL(path.resolve(__dirname, '../../../Frontend/src/utils/nativeBalanceSafety.js')).href;
  const mobileUrl = pathToFileURL(path.resolve(__dirname, '../../../MobileApp/src/utils/nativeBalanceSafety.js')).href;
  const result = require('child_process').execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const [admin, web, mobile] = await Promise.all(process.argv.slice(1).map(url => import(url)));
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (!admin.adminPaymentsOverviewIsValid(input.overview) || !web.nativeBalancesAreValid(input.sellerSummary) || !mobile.nativeBalancesAreValid(input.sellerSummary)) process.exit(1);
    input.overview.sellers.push(input.overview.sellers[0]);
    if (admin.adminPaymentsOverviewIsValid(input.overview)) process.exit(2);
    console.log('native contracts verified');
  `, adminUrl, webUrl, mobileUrl], { input: JSON.stringify({ overview, sellerSummary }), encoding: 'utf8' });
  expect(result.trim()).toBe('native contracts verified');
}, 60000);

test('expired and inactive coupons stay expired/inactive, and later usage counters are preserved', async () => {
  const { seller } = await fixture('PKR');
  const past = await Coupon.create({ seller:seller._id, code:'PAST', discountType:'fixed', discountValue:280, currency:'PKR', isActive:false, startDate:new Date('2025-01-01'), expiryDate:new Date('2025-02-01') });
  const active = await Coupon.create({ seller:seller._id, code:'ACTIVE', discountType:'percentage', discountValue:10, currency:'PKR', minOrderAmount:560, maxDiscountAmount:280, expiryDate:new Date(Date.now()+86400000) });
  const preview = await requestProductCurrencyChange(seller._id,'USD');
  const buyer = new mongoose.Types.ObjectId();
  await Coupon.updateOne({_id:active._id},{$inc:{usedCount:1,__v:1},$push:{usedBy:{user:buyer,count:1}}});
  await requestProductCurrencyChange(seller._id,'USD',{confirm:true,quoteToken:preview.quoteToken});
  expect(await Coupon.findById(past._id).lean()).toMatchObject({currency:'USD',discountValue:1,isActive:false,startDate:past.startDate,expiryDate:past.expiryDate});
  expect(await Coupon.findById(active._id).lean()).toMatchObject({currency:'USD',discountValue:10,minOrderAmount:2,maxDiscountAmount:1,usedCount:1,usedBy:[expect.objectContaining({user:buyer,count:1})]});
});

test('each shipping/coupon source currency converts directly instead of being relabelled as the old store currency', async () => {
  const {seller}=await fixture('PKR');
  await ShippingMethod.create({seller:seller._id,methods:[{type:'standard',cost:2,currency:'USD',costCurrency:'USD',costInputAmount:2,deliveryDays:5}]});
  const coupon=await Coupon.create({seller:seller._id,code:'EURO',discountType:'fixed',discountValue:0.9,currency:'EUR',minOrderAmount:9,maxDiscountAmount:4.5,expiryDate:new Date(Date.now()+86400000)});
  const preview=await requestProductCurrencyChange(seller._id,'GBP');
  await requestProductCurrencyChange(seller._id,'GBP',{confirm:true,quoteToken:preview.quoteToken});
  expect((await ShippingMethod.findOne({seller:seller._id})).methods[0]).toMatchObject({cost:1.6,currency:'GBP',deliveryDays:5});
  expect(await Coupon.findById(coupon._id).lean()).toMatchObject({currency:'GBP',discountValue:0.8,minOrderAmount:8,maxDiscountAmount:4});
});
