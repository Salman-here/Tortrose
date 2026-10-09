'use strict';

// Explicit, narrowly scoped Sandbox fixture actions. Credentials are supplied
// by the caller in memory and are never written or printed.
const base = 'https://rozare.up.railway.app';
const buyer = { email:'rozare-safepay-buyer-20260925@mailinator.com',id:'6ab6e12cba71edafe4fc6c5b' };
const qa = { email:'rozare-safepay-seller-20260925@mailinator.com',id:'6ab6e29eba71edafe4fc7596' };
const atlas = { email:'rozare.seller.82904@mailinator.com',id:'6a931e0afac20b9d5e05a1ac' };
const walletOrder = '6ac8cd31e0e3b7e7b5b90a3b';
const mug = '6ab76c69f1585bb3833af7d9';
async function request(path,{ token,method='GET',body }={}) {
  const response = await fetch(base + path,{ method,signal:AbortSignal.timeout(30000),
    headers:{ 'Content-Type':'application/json',...(token ? { Authorization:'Bearer '+token } : {}) },
    ...(body ? { body:JSON.stringify(body) } : {}) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`QA_HTTP_${response.status}_NON_JSON`);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.code || `HTTP_${response.status}`),{ code:data.code,detail:data.msg });
  return data;
}
async function signIn(account) {
  if (!process.env.ROZARE_QA_PASSWORD) throw new Error('QA_PASSWORD_REQUIRED');
  const auth = await request('/api/auth/login',{ method:'POST',body:{ email:account.email,password:process.env.ROZARE_QA_PASSWORD } });
  if (!auth.token || String(auth.user?.id) !== account.id) throw new Error('QA_IDENTITY_REQUIRED');
  return auth.token;
}
async function main() {
  const task = process.argv[2];
  if (task === 'quote-matrix') {
    const token = await signIn(buyer);
    const expected = { USD:4.34,PKR:1200,EUR:3.87,GBP:3.28 };
    for (const [currency,total] of Object.entries(expected)) {
      for (const paymentMethod of ['cash_on_delivery','wallet','safepay']) {
        const quote = await request('/api/order/quote',{ token,method:'POST',body:{ order:{
          currency,paymentMethod,orderItems:[{ id:mug,quantity:1,selectedColor:'Green',selectedOptions:{ Color:'Green' } }],
          sellerShipping:[{ seller:qa.id,shippingMethod:{ name:'standard' } }],appliedCoupons:[],
          shippingInfo:{ country:'Pakistan',countryCode:'PK',state:'Punjab',city:'Lahore' },
        } } });
        if (quote.success !== true || quote.currency !== currency || quote.orderSummary?.totalAmount !== total
            || quote.pricingPolicyVersion !== 1) throw new Error('QA_FROZEN_RATE_QUOTE_NOT_VERIFIED');
        console.log(JSON.stringify({ task,currency,paymentMethod,summary:quote.orderSummary,items:quote.orderItems.map(item => ({ quantity:item.quantity,lineSubtotal:item.lineSubtotal })) }));
      }
    }
    return;
  }
  if (task === 'find-order') {
    const reference = process.argv[3];
    if (!/^ORD-17915\d+$/.test(reference || '')) throw new Error('QA_REFERENCE_REQUIRED');
    const token = await signIn(buyer);
    const result = await request('/api/order/user-orders?search='+encodeURIComponent(reference),{ token });
    const orders = result.orders?.filter(order => order.orderId === reference);
    if (orders?.length !== 1) throw new Error('QA_ORDER_NOT_FOUND');
    console.log(JSON.stringify({ id:orders[0]._id,orderId:orders[0].orderId,currency:orders[0].currency,total:orders[0].orderSummary?.totalAmount,paymentMethod:orders[0].paymentMethod }));
    return;
  }
  if (task === 'review-return' || task === 'replay-accept') {
    const orderId = process.argv[3];
    if (!/^[a-f0-9]{24}$/.test(orderId || '')) throw new Error('QA_ORDER_REQUIRED');
    const token = await signIn(qa);
    const detail = (await request(`/api/order/detail/${orderId}?view=seller`,{ token })).order;
    if (!/^ORD-17915\d+$/.test(detail.orderId || '') || detail.currency !== 'USD'
        || detail.orderItems.some(item => String(item.productId?._id || item.productId) !== mug)
        || ![301.2,1200,2200].includes(detail.sellerCurrencyMoney?.summary?.totalAmount)) throw new Error('QA_RETURN_BINDING_REQUIRED');
    const result = await request('/api/returns/seller?search='+encodeURIComponent(detail.orderId),{ token });
    const candidates = result.returns.filter(entry => String(entry.order) === orderId
      && String(entry.seller) === qa.id && String(entry.buyer?._id || entry.buyer) === buyer.id
      && entry.currency === 'USD' && (task === 'replay-accept' ? entry.status === 'returned' : !['returned','rejected','cancelled_by_buyer'].includes(entry.status)));
    if (candidates.length !== 1) throw new Error('QA_UNIQUE_RETURN_REQUIRED');
    let entry = candidates[0];
    if (task === 'replay-accept') {
      const replay = await request(`/api/returns/${entry._id}/accept`,{ token,method:'POST',body:{ fundingSource:'seller_balance' } });
      if (replay.returnRequest?._id !== entry._id || replay.returnRequest.status !== 'returned') throw new Error('QA_REPLAY_NOT_VERIFIED');
    } else {
      const steps = ['requested','approved','pickup_scheduled','picked_up','in_transit_to_seller','received_by_seller','under_review'];
      if (!steps.includes(entry.status)) throw new Error('QA_RETURN_STATE_REQUIRED');
      for (const status of steps.slice(steps.indexOf(entry.status)+1)) {
        const updated = await request(`/api/returns/${entry._id}/status`,{ token,method:'PATCH',body:{ status,note:'Sandbox QA only: simulated return logistics and inspection. No physical shipment.' } });
        entry = updated.returnRequest;
        if (entry.status !== status) throw new Error('QA_RETURN_STATUS_NOT_VERIFIED');
      }
    }
    console.log(JSON.stringify({ task,orderId,returnId:entry._id,returnNumber:entry.returnNumber,status:entry.status,refund:entry.refund }));
    return;
  }
  if (task === 'deliver-cod-qa' || task === 'deliver-wallet-qa') {
    const orderId = process.argv[3];
    if (!/^[a-f0-9]{24}$/.test(orderId || '')) throw new Error('QA_ORDER_REQUIRED');
    const token = await signIn(qa);
    let detail = (await request(`/api/order/detail/${orderId}?view=seller`,{ token })).order;
    if (detail.paymentMethod !== (task === 'deliver-cod-qa' ? 'cash_on_delivery' : 'wallet') || detail.currency !== 'USD'
        || detail.orderItems.some(item => String(item.productId?._id || item.productId) !== mug)
        || detail.sellerCurrencyMoney?.summary?.totalAmount !== (task === 'deliver-cod-qa' ? 301.2 : 2200)
        || (task === 'deliver-cod-qa' && detail.sellerCurrencyMoney?.buyerSummary?.totalAmount !== 1.09)) throw new Error('QA_FULFILLMENT_BINDING_REQUIRED');
    const ranks = { pending:0,confirmed:1,processing:2,shipped:3,delivered:4 };
    if (!Object.hasOwn(ranks,detail.orderStatus)) throw new Error('QA_FULFILLMENT_STATE_REQUIRED');
    for (const newStatus of ['confirmed','processing','shipped','delivered']) {
      if (ranks[detail.orderStatus] >= ranks[newStatus]) continue;
      await request(`/api/order/update-status/${orderId}`,{ token,method:'PATCH',body:{ newStatus } });
      detail = (await request(`/api/order/detail/${orderId}?view=seller`,{ token })).order;
      if (detail.orderStatus !== newStatus) throw new Error('QA_FULFILLMENT_NOT_VERIFIED');
    }
    console.log(JSON.stringify({ orderId,status:detail.orderStatus,nativeTotal:detail.sellerCurrencyMoney.summary.totalAmount,buyerTotal:detail.sellerCurrencyMoney.buyerSummary.totalAmount }));
    return;
  }
  if (task === 'deliver-wallet') {
    for (const [account,expected] of [[qa,1200],[atlas,34.5]]) {
      const token = await signIn(account);
      let detail = (await request(`/api/order/detail/${walletOrder}?view=seller`,{ token })).order;
      if (detail.paymentMethod !== 'wallet' || detail.orderId !== 'ORD-1791544625014'
          || detail.sellerCurrencyMoney?.summary?.totalAmount !== expected) throw new Error('QA_ORDER_BINDING_REQUIRED');
      const ranks = { confirmed:0,processing:1,shipped:2,delivered:3 };
      if (!Object.hasOwn(ranks,detail.orderStatus)) throw new Error('QA_FULFILLMENT_STATE_REQUIRED');
      for (const newStatus of ['processing','shipped','delivered']) {
        if (ranks[detail.orderStatus] >= ranks[newStatus]) continue;
        await request(`/api/order/update-status/${walletOrder}`,{ token,method:'PATCH',body:{ newStatus } });
        detail = (await request(`/api/order/detail/${walletOrder}?view=seller`,{ token })).order;
        if (detail.orderStatus !== newStatus) throw new Error('QA_FULFILLMENT_NOT_VERIFIED');
      }
      console.log(JSON.stringify({ seller:account.id,order:walletOrder,status:detail.orderStatus,nativeTotal:detail.sellerCurrencyMoney.summary.totalAmount }));
    }
    return;
  }
  if (task === 'prepare-cart' || task === 'prepare-mug' || task === 'prepare-two-options') {
    const token = await signIn(buyer);
    const cart = await request('/api/cart/get',{ token });
    if (cart.cart?.length) throw new Error('QA_CART_NOT_EMPTY');
    const items = [{ productId:mug,qty:1,selectedColor:'Green',selectedOptions:{ Color:'Green' } },
      ...(task === 'prepare-cart' ? [{ productId:'6a931a3efac20b9d5e0581ab',qty:1 },{ productId:'6a931edefac20b9d5e05aacf',qty:1 }] : []),
      ...(task === 'prepare-two-options' ? [{ productId:mug,qty:1,selectedColor:'Blue',selectedOptions:{ Color:'Blue' } }] : [])];
    const merged = await request('/api/cart/merge',{ token,method:'POST',body:{ items } });
    if (merged.cart?.length !== items.length) throw new Error('QA_CART_NOT_VERIFIED');
    console.log(JSON.stringify({ task,prepared:merged.cart.map(item => ({ name:item.product.name,quantity:item.qty,options:item.selectedOptions })),currency:merged.totalCartCurrency }));
    return;
  }
  if (task === 'set-mug-price') {
    const price = Number(process.argv[3]);
    if (![301.2,1100,1000].includes(price)) throw new Error('QA_PRICE_NOT_ALLOWED');
    const token = await signIn(qa);
    await request('/api/products/edit/'+mug,{ token,method:'PUT',body:{ product:{ price,priceCurrency:'PKR',currency:'PKR' } } });
    const catalog = await request('/api/products/get-seller-products?currency=PKR&limit=100',{ token });
    const saved = catalog.products?.find(product => product._id === mug);
    if (!saved || saved.priceInputAmount !== price || saved.priceCurrency !== 'PKR') throw new Error('QA_PRICE_NOT_VERIFIED');
    console.log(JSON.stringify({ task,product:mug,price,currency:'PKR',restoreTo:1000 }));
    return;
  }
  throw new Error('QA_TASK_REQUIRED');
}
main().catch(error => { console.error(JSON.stringify({ error:error.code || error.message || 'QA_TASK_FAILED' }));process.exitCode=1; });
