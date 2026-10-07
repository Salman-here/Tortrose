import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
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
jest.mock('../../../src/contexts/CurrencyContext',()=>({useCurrency:()=>({currencies:{USD:{code:'USD'},PKR:{code:'PKR'},EUR:{code:'EUR'},GBP:{code:'GBP'}},formatAmount:(amount,{targetCurrency})=>`${targetCurrency} ${Number(amount).toFixed(2)}`})}));
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
const fields=['withdrawableBalance','onlineDeliveredRevenue','onlinePendingRevenue','stripeDeliveredRevenue','stripePendingRevenue','walletDeliveredRevenue','walletPendingRevenue','codDeliveredRevenue','codPendingRevenue','totalDeliveredRevenue','estimatedRevenue','pendingWithdrawalAmount','approvedWithdrawalAmount','processingWithdrawalAmount','manualReviewWithdrawalAmount','totalWithdrawn','totalReservedOrWithdrawn','returnRefundDebits','paymentReversalDebits','balanceAdjustmentCredits','deficit','paymentRiskHeldAmount','returnWindowHeldAmount'];
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
  api.put.mockResolvedValue({data:{success:true}});
});
afterEach(() => jest.restoreAllMocks());

test.each([
  ['bank currency mismatch', false, 'PKR'],
  ['payment hold', true, 'USD'],
  ['payment hold and bank currency mismatch', true, 'PKR'],
])('blocked withdrawal explains %s without claiming an FX outage', async (_reason, held, bankCurrency) => {
  const summary = nativeResponse();
  summary.paymentAccount.currency = bankCurrency;
  summary.paymentRiskPending = held;
  if (held) {
    summary.balances.forEach(balance => {
      balance.paymentRiskHeldAmount = balance.withdrawableBalance;
      balance.withdrawableBalance = 0;
    });
    summary.displayRevenue.withdrawableBalance = 0;
    summary.displayRevenue.paymentRiskHeldAmount = 50;
    summary.withdrawalLimits.availableDisplayAmount = 0;
  }
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Withdrawals are held, or your bank account currency does not match this balance. No automatic conversion is available.');
  let button = screen.getByText('Send withdrawal request');
  while (button && typeof button.props.onPress !== 'function') button = button.parent;
  expect(button).not.toBeNull();
  expect(button.props.disabled).toBe(true);
  expect(alert).not.toHaveBeenCalled();
  // The UI disables this button; invoke the handler to cover its defensive guard.
  await act(async () => { await button.props.onPress(); });
  expect(alert).toHaveBeenCalledWith(
    'Withdrawal unavailable',
    'Withdrawals are held, or your bank account currency does not match this balance. No automatic conversion is available.',
  );
  expect(api.post).not.toHaveBeenCalled();
}, 30000);

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

test.each([
  ['PKR', 1999.90, '2000.00', 2784, 'Balance below minimum', 'Your available balance is PKR 1999.90. The minimum withdrawal is PKR 2000.00. Pending and reserved funds are not withdrawable.'],
  ['USD', 96.75, '4.99', 0, 'Minimum withdrawal', 'Minimum withdrawal amount is USD 5.00'],
  ['USD', 96.75, '96.76', 0, 'Too high', 'You can withdraw up to USD 96.75'],
])('native %s available %s and input %s explains the actual rejection before any write', async (currency, available, amount, pending, title, message) => {
  const summary = nativeResponse();
  const balance = summary.balanceByCurrency[currency];
  Object.assign(balance, { withdrawableBalance: available, onlineDeliveredRevenue: available, stripeDeliveredRevenue: available,
    totalDeliveredRevenue: available, estimatedRevenue: Number((available + pending).toFixed(2)),
    onlinePendingRevenue: pending, stripePendingRevenue: pending });
  summary.paymentAccount.currency = currency;
  if (currency === 'USD') {
    summary.displayRevenue = { ...balance };
    summary.withdrawalLimits.availableDisplayAmount = available;
  }
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  const picker = await screen.findByLabelText('Withdrawal balance currency');
  fireEvent(picker, 'valueChange', currency);
  fireEvent.changeText(await screen.findByLabelText(`Withdrawal amount in ${currency}`), amount);
  fireEvent.press(screen.getByText('Send withdrawal request'));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(title, message));
  expect(api.post).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
}, 15000);

test('does not show a response belonging to another account',async()=>{
  api.get.mockImplementation(async url=>({data:url==='/currency'?{productCurrency:currencyState}:nativeResponse('64b000000000000000000002')}));
  const screen=render(<SellerPaymentsScreen navigation={{navigate:jest.fn()}}/>);
  await screen.findByText('Payment summary returned in an unexpected currency. Please retry.');
  expect(screen.queryByLabelText('Withdrawal balance currency')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test('shows the gross return hold in the selected earned currency alongside net pending funds', async () => {
  const summary = nativeResponse();
  Object.assign(summary.balanceByCurrency.USD, {
    withdrawableBalance: 37,
    returnWindowHeldAmount: 10,
    pendingOnlineBalance: 10,
    onlineFeeDeductions: 3,
    pendingOnlineFeeDeductions: 1,
    onlineGrossEarnings: 50,
    processingFeeAndTax: 4,
    pendingOnlineNetBalance: 9,
  });
  Object.assign(summary.balanceByCurrency.PKR, {
    withdrawableBalance: 27000,
    returnWindowHeldAmount: 1000,
    pendingOnlineBalance: 1000,
  });
  summary.displayRevenue.withdrawableBalance = 37;
  summary.withdrawalLimits.availableDisplayAmount = 37;
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));

  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Held for returns');
  expect(screen.getByText('USD 10.00')).toBeTruthy();
  expect(screen.getByText('USD 9.00')).toBeTruthy();
  expect(screen.getByText('Available: USD 37.00 - Minimum: USD 5.00')).toBeTruthy();

  fireEvent(screen.getByLabelText('Withdrawal balance currency'), 'valueChange', 'PKR');
  expect(screen.getByText('Held for returns')).toBeTruthy();
  expect(screen.queryByText('USD 10.00')).toBeNull();
  expect(screen.getAllByText('PKR 1000.00')).toHaveLength(2);
  expect(screen.getByText('Available: PKR 27000.00 - Minimum: PKR 2000.00')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

test.each([
  ['missing', summary => { delete summary.balanceByCurrency.USD.returnWindowHeldAmount; }],
  ['null', summary => { summary.balanceByCurrency.USD.returnWindowHeldAmount = null; }],
  ['string', summary => { summary.balanceByCurrency.USD.returnWindowHeldAmount = '0'; }],
  ['sub-cent', summary => { summary.balanceByCurrency.USD.returnWindowHeldAmount = 0.001; }],
  ['mismatched lookup', summary => { summary.balanceByCurrency.USD = { ...summary.balanceByCurrency.USD, returnWindowHeldAmount: 1 }; }],
])('does not present a %s return hold as zero or allow a withdrawal', async (_reason, mutate) => {
  const summary = nativeResponse();
  mutate(summary);
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Payment summary did not include complete authoritative money totals.');
  expect(screen.queryByText('Held for returns')).toBeNull();
  expect(screen.queryByLabelText('Withdrawal balance currency')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test('explicitly clears the saved IBAN when changing to a Pakistan account-only payout destination', async () => {
  const summary = nativeResponse();
  Object.assign(summary.paymentAccount, { bankName: 'GB Bank', currency: 'GBP', country: 'United Kingdom',
    swiftCode: 'WESTGB2L', maskedIban: '**** 5432' });
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Update');
  fireEvent.press(screen.getByText('Update'));
  fireEvent.changeText(screen.getByLabelText('Bank name'), 'Pakistan Bank');
  fireEvent.changeText(screen.getByLabelText('Bank account number'), '000012345678');
  fireEvent.changeText(screen.getByLabelText('Payout bank country'), 'Pakistan');
  fireEvent.changeText(screen.getByLabelText('SWIFT or BIC code'), '');
  fireEvent.press(screen.getByLabelText('Remove saved IBAN'));
  expect(screen.getByLabelText('Remove saved IBAN').props.accessibilityState.checked).toBe(true);
  expect(screen.getByLabelText('IBAN').props.editable).toBe(false);
  fireEvent.press(screen.getByLabelText('Payout currency PKR'));
  fireEvent.press(screen.getByText('Save payment account'));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/account', expect.objectContaining({
    bankName: 'Pakistan Bank', accountNumber: '000012345678', iban: '', clearIban: true,
    clearAccountNumber: false, country: 'Pakistan', currency: 'PKR', swiftCode: '',
  })));
  const body = api.put.mock.calls[0][1];
  expect(body).not.toHaveProperty('paymentAccountSnapshotEnvelope');
  expect(JSON.stringify(body)).not.toContain('****');
  expect(api.post).not.toHaveBeenCalled();
});

test('cannot submit removal of the only saved identifier', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Update');
  fireEvent.press(screen.getByText('Update'));
  expect(screen.queryByLabelText('Remove saved IBAN')).toBeNull();
  fireEvent.press(screen.getByLabelText('Remove saved account number'));
  fireEvent.press(screen.getByText('Save payment account'));
  expect(alert).toHaveBeenCalledWith('Missing info', 'Keep or enter at least one bank account number or IBAN.');
  expect(api.put).not.toHaveBeenCalled();
});

test('new payout accounts have no saved-identifier removal controls', async () => {
  const summary = nativeResponse();
  summary.paymentAccount = null;
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Add');
  fireEvent.press(screen.getByText('Add'));
  expect(screen.queryByLabelText('Remove saved account number')).toBeNull();
  expect(screen.queryByLabelText('Remove saved IBAN')).toBeNull();
});
