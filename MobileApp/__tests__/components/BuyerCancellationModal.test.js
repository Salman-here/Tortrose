import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import BuyerCancellationModal from '../../src/components/BuyerCancellationModal';
import api from '../../src/config/api';
jest.mock('../../src/config/api', () => ({ __esModule:true,default:{post:jest.fn(),patch:jest.fn()} }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme:() => ({palette:require('../../src/styles/palettes').lightPalette}) }));
jest.mock('../../src/components/common/GlassPanel', () => { const R=require('react'),{View}=require('react-native');return ({children,...props}) => R.createElement(View,props,children); });
jest.mock('@expo/vector-icons', () => ({Ionicons:'Icon'}));
const order = method => ({ _id:'order-1',orderId:'ORD-1',currency:'PKR',paymentMethod:method,safepayPaymentRail:method==='safepay'?'card':undefined,isPaid:true,orderStatus:'confirmed',
  buyerPresentationVersion:1,sellerGroupingAvailable:true,orderItems:[{productId:'product-1',seller:'seller-1',name:'QA Mug',price:10000,lineSubtotal:10000,quantity:1}],
  orderSummary:{subtotal:10000,shippingCost:0,tax:0,couponDiscount:0,reconciliationAdjustment:0,totalAmount:10000},
  sellerGroups:[{sellerId:'seller-1',storeName:'QA Store',status:'confirmed',canCancel:true,itemIndexes:[0],itemCount:1,units:1,
    shippingMethod:{name:'Free',price:0,estimatedDays:3},summary:{subtotal:10000,shippingCost:0,tax:0,couponDiscount:0,reconciliationAdjustment:0,totalAmount:10000}}] });
function quote(method='safepay') { return {version:1,orderId:'order-1',currency:'PKR',paymentMethod:method,paymentRail:method==='safepay'?'card':'unknown',policyVersion:1,
  quoteId:'a'.repeat(64),sellerIds:['seller-1'],activeSellerIds:['seller-1'],grossMinor:1000000,defaultDestination:'wallet',
  options:[{destination:'wallet',label:'Rozare Wallet',amountMinor:1000000,deductionMinor:0,available:true},
    ...(method==='safepay'?[{destination:'original_card',label:'Original card',amountMinor:935000,deductionMinor:65000,available:true}]:[])]}; }
function cancelled(method,destination) { const value=order(method); return {...value,orderStatus:'cancelled',sellerGroups:value.sellerGroups.map(row=>({...row,status:'cancelled',canCancel:false,
  cancellation:{reference:'c1',currency:'PKR',destination,refundStatus:destination==='wallet'?'refunded':'pending',policyVersion:1,
    amountMinor:destination==='wallet'?1000000:935000,grossAmountMinor:1000000,deductionMinor:destination==='wallet'?0:65000}}))}; }
const money = amount => 'Rs'+amount.toFixed(2);
beforeEach(()=>jest.clearAllMocks());
test('Safepay shows both choices with full Wallet selected by default',async()=>{
  api.post.mockResolvedValue({data:{quote:quote()}}); api.patch.mockResolvedValue({data:{order:cancelled('safepay','wallet')}});
  const onCancelled=jest.fn(),onClose=jest.fn();
  const screen=render(<BuyerCancellationModal order={order('safepay')} formatMoney={money} onClose={onClose} onCancelled={onCancelled}/>);
  await screen.findByText('Original card'); expect(screen.getByText('Full refund')).toBeTruthy();
  expect(screen.getByText('Rs9350.00')).toBeTruthy();expect(screen.getByText('Rs650.00')).toBeTruthy();
  fireEvent.press(screen.getByText('Cancel order'));
  await waitFor(()=>expect(api.patch).toHaveBeenCalledWith('/api/order/cancel/order-1',expect.objectContaining({refundDestination:'wallet',acceptDeduction:false,quoteId:'a'.repeat(64)})));
  await waitFor(()=>expect(onCancelled).toHaveBeenCalled());expect(onClose).toHaveBeenCalled();
});
test('original-card deduction must be explicitly accepted before submitting',async()=>{
  api.post.mockResolvedValue({data:{quote:quote()}});api.patch.mockResolvedValue({data:{order:cancelled('safepay','original_card')}});
  const screen=render(<BuyerCancellationModal order={order('safepay')} formatMoney={money} onClose={jest.fn()} onCancelled={jest.fn()}/>);
  fireEvent.press(await screen.findByText('Original card'));
  fireEvent.press(screen.getByText('Cancel order'));expect(api.patch).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('I agree to the processing fee shown above.'));
  fireEvent.press(screen.getByText('Cancel order'));
  await waitFor(()=>expect(api.patch).toHaveBeenCalledWith('/api/order/cancel/order-1',expect.objectContaining({refundDestination:'original_card',acceptDeduction:true})));
});
test('Wallet-paid cancellation has only the full Wallet option',async()=>{
  api.post.mockResolvedValue({data:{quote:quote('wallet')}});api.patch.mockResolvedValue({data:{order:cancelled('wallet','wallet')}});
  const screen=render(<BuyerCancellationModal order={order('wallet')} formatMoney={money} onClose={jest.fn()} onCancelled={jest.fn()}/>);
  await screen.findByText('Rozare Wallet');expect(screen.queryByText('Original card')).toBeNull();expect(screen.queryByText('Processing fee')).toBeNull();
  expect(screen.getAllByText('Rs10000.00').length).toBeGreaterThan(0);
});
test('wrong-currency or altered total quote displays an error and blocks cancellation',async()=>{
  api.post.mockResolvedValue({data:{quote:{...quote(),currency:'USD'}}});
  const screen=render(<BuyerCancellationModal order={order('safepay')} formatMoney={money} onClose={jest.fn()} onCancelled={jest.fn()}/>);
  await screen.findByText('The cancellation refund amounts could not be verified. Refresh and try again.');
  fireEvent.press(screen.getByText('Cancel order'));expect(api.patch).not.toHaveBeenCalled();
});

test.each(['raast', 'unknown'])('native %s offers full Wallet and explains its disabled original-payment option', async paymentRail => {
  const current = { ...order('safepay'), safepayPaymentRail: paymentRail };
  const preview = quote(); preview.paymentRail = paymentRail;
  preview.options[1] = { ...preview.options[1], available: false, reason: 'Choose a full Rozare Wallet refund or contact support.' };
  api.post.mockResolvedValue({ data: { quote: preview } });
  api.patch.mockResolvedValue({ data: { order: cancelled('safepay', 'wallet') } });
  const screen = render(<BuyerCancellationModal order={current} formatMoney={money} onClose={jest.fn()} onCancelled={jest.fn()} />);
  await screen.findByText('Choose a full Rozare Wallet refund or contact support.');
  const label = paymentRail === 'raast' ? 'Original Raast payment' : 'Original payment method';
  fireEvent.press(screen.getByText(label));
  expect(screen.queryByText('Returned to the card used for this order after verification. Your bank may take additional time to display it.')).toBeNull();
  fireEvent.press(screen.getByText('Cancel order'));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/order/cancel/order-1', expect.objectContaining({ refundDestination: 'wallet', acceptDeduction: false })));
});
