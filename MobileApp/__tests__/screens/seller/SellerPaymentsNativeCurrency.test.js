import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import SellerPaymentsScreen from '../../../src/screens/seller/SellerPaymentsScreen';
import api from '../../../src/config/api';

let mockUser = { _id: '64b000000000000000000001', role: 'seller' };
jest.mock('@expo/vector-icons',()=>({Ionicons:()=>null}));
jest.mock('react-native-safe-area-context',()=>({SafeAreaView:({children})=>children}));
jest.mock('expo-linear-gradient',()=>({LinearGradient:({children})=>children}));
jest.mock('../../../src/components/common/GlassBackground',()=>({children})=>children);
jest.mock('../../../src/components/common/GlassPanel',()=>({children})=>children);
jest.mock('../../../src/components/common/KeyboardAwareFormScrollView',()=>({children})=>children);
jest.mock('../../../src/utils/feedback',()=>({show:jest.fn()}));
jest.mock('../../../src/contexts/AuthContext',()=>({useAuth:()=>({currentUser:mockUser})}));
jest.mock('../../../src/contexts/CurrencyContext',()=>({useCurrency:()=>({currencies:[{code:'USD'},{code:'PKR'},{code:'EUR'},{code:'GBP'}],formatAmount:(amount,{targetCurrency})=>`${targetCurrency} ${Number(amount).toFixed(2)}`})}));
jest.mock('../../../src/contexts/ThemeContext',()=>({useTheme:()=>({palette:{colors:{primary:'#4338ca',text:'#111827',textSecondary:'#64748b',success:'#16a34a',warning:'#eab308',error:'#dc2626',info:'#0ea5e9'},glass:{bgSubtle:'#fafafa',bgStrong:'#fff',borderSubtle:'#ddd',borderStrong:'#ccc'}}})}));
jest.mock('@react-native-picker/picker',()=>{
  const R=require('react'),{View,Text}=require('react-native');
  const Picker=({children,...props})=>R.createElement(View,props,children);
  Picker.Item=({label})=>R.createElement(Text,null,label);
  return {Picker};
});
jest.mock('../../../src/components/seller/SellerUI',()=>{
  const R=require('react'),{Text}=require('react-native');
  return {SellerScreenHeader:({title})=>R.createElement(Text,null,title),SellerSectionHeader:({title})=>R.createElement(Text,null,title),
    SellerScreenSkeleton:()=>R.createElement(Text,null,'Loading payments'),SellerInlineError:({message})=>R.createElement(Text,null,message),
    SellerEmptyState:({title})=>R.createElement(Text,null,title)};
});
jest.mock('../../../src/config/api',()=>({__esModule:true,default:{get:jest.fn(),post:jest.fn(),put:jest.fn()},API_ENDPOINTS:{STORES:{PRODUCT_CURRENCY:'/currency'},PAYMENTS:{SELLER_SUMMARY:'/summary',SELLER_WITHDRAWALS:'/withdrawals',SELLER_ACCOUNT:'/account'}}}));

const currencyState={hasStore:true,activeCurrency:'USD',status:'active',pendingCurrency:null,previousCurrency:null,productCount:1,productCurrencies:['USD'],productCurrencyCounts:{USD:1},canAddProduct:true};
const fields=['withdrawableBalance','onlineDeliveredRevenue','onlinePendingRevenue','stripeDeliveredRevenue','stripePendingRevenue','walletDeliveredRevenue','walletPendingRevenue','codDeliveredRevenue','codPendingRevenue','totalDeliveredRevenue','estimatedRevenue','pendingWithdrawalAmount','approvedWithdrawalAmount','processingWithdrawalAmount','manualReviewWithdrawalAmount','totalWithdrawn','totalReservedOrWithdrawn','returnRefundDebits','paymentReversalDebits','balanceAdjustmentCredits','deficit','paymentRiskHeldAmount'];
function nativeResponse(sellerId=mockUser._id){
  const minima={USD:5,PKR:2000,EUR:5,GBP:5};
  const balances=Object.keys(minima).map(currency=>{
    const amount=currency==='PKR'?28000:currency==='USD'?50:0;
    return {...Object.fromEntries(fields.map(f=>[f,0])),currency,minimumWithdrawal:minima[currency],withdrawableBalance:amount,onlineDeliveredRevenue:amount,stripeDeliveredRevenue:amount,totalDeliveredRevenue:amount,estimatedRevenue:amount};
  });
  const balanceByCurrency=Object.fromEntries(balances.map(b=>[b.currency,b]));
  return {sellerId,accountingVersion:2,displayCurrency:'USD',baseCurrency:'USD',balances,balanceByCurrency,displayRevenue:{...balanceByCurrency.USD,totalDeliveredRevenue:150,estimatedRevenue:150},withdrawalLimits:{currency:'USD',baseCurrency:'USD',displayCurrency:'USD',availableDisplayAmount:50,minimumDisplayAmount:5},exchangeRateStatus:{fallback:false,source:'order-checkout-snapshots'},paymentRiskPending:false,recentOrders:{stripe:[],wallet:[],cod:[]},withdrawals:[],paymentAccount:{accountHolderName:'Seller Account',bankName:'PKR Bank',maskedAccountNumber:'**** 1234',country:'Pakistan',currency:'PKR'}};
}
beforeEach(()=>{
  mockUser={_id:'64b000000000000000000001',role:'seller'};jest.clearAllMocks();
  api.get.mockImplementation(async url=>({data:url==='/currency'?{productCurrency:currencyState}:nativeResponse()}));
  api.post.mockResolvedValue({data:{success:true}});
});
test('selects an old PKR balance, shows Rs2000 minimum and submits PKR without changing store currency',async()=>{
  const screen=render(<SellerPaymentsScreen navigation={{navigate:jest.fn()}}/>);
  const picker=await screen.findByLabelText('Withdrawal balance currency');
  fireEvent(picker,'valueChange','PKR');
  const input=await screen.findByLabelText('Withdrawal amount in PKR');
  expect(screen.getByText('Available: PKR 28000.00 - Minimum: PKR 2000.00')).toBeTruthy();
  fireEvent.changeText(input,'2000');
  fireEvent.press(screen.getByText('Send withdrawal request'));
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/withdrawals',{amount:2000,currency:'PKR'},expect.objectContaining({headers:expect.objectContaining({'Idempotency-Key':expect.any(String)})})));
  expect(api.put).not.toHaveBeenCalled();
},15000);
test('does not show a response belonging to another account',async()=>{
  api.get.mockImplementation(async url=>({data:url==='/currency'?{productCurrency:currencyState}:nativeResponse('64b000000000000000000002')}));
  const screen=render(<SellerPaymentsScreen navigation={{navigate:jest.fn()}}/>);
  await screen.findByText('Payment summary returned in an unexpected currency. Please retry.');
  expect(screen.queryByLabelText('Withdrawal balance currency')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
