import React from 'react';
import { Alert, AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import BuyerReturnsSection from '../../src/components/BuyerReturnsSection';
import api from '../../src/config/api';
import Feedback from '../../src/utils/feedback';

let mockFocused = true;
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../src/utils/feedback', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/components/common/GlassPanel', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return ({ children, ...props }) => ReactModule.createElement(View, props, children);
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));

const IDS = {
  order: '64b000000000000000000101', item: '64b000000000000000000102',
  product: '64b000000000000000000103', seller: '64b000000000000000000104',
  buyer: '64b000000000000000000105', store: '64b000000000000000000106',
  request: '64b000000000000000000107',
};
const clone = value => JSON.parse(JSON.stringify(value));
const order = {
  _id: IDS.order, orderId: 'ORD-RETURN-1001', currency: 'PKR',
  orderItems: [{ _id: IDS.item, productId: IDS.product, seller: IDS.seller,
    name: 'Verified shoes', image: '', quantity: 2, price: 50, lineSubtotal: 100 }],
  orderSummary: { subtotal: 100, shippingCost: 10, tax: 5, couponDiscount: 5, totalAmount: 110 },
};
const eligibility = {
  success: true, orderId: order.orderId,
  groups: [{
    seller: { _id: IDS.seller, username: 'seller' },
    store: { _id: IDS.store, storeName: 'Verified Store' },
    policy: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
    policyVariants: ['full_refund'], policySource: 'order_snapshot',
    fulfillment: { status: 'delivered', deliveredAt: '2026-08-01T00:00:00.000Z' },
    eligibilityDeadline: '2026-08-15T00:00:00.000Z', eligible: true, reason: '',
    items: [{
      orderItemId: IDS.item, productId: IDS.product, name: 'Verified shoes', image: '',
      purchasedQuantity: 2, alreadyRequestedQuantity: 1, remainingReturnableQuantity: 1,
      unitPrice: 50, lineSubtotal: 100,
      returnPolicy: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
      eligibilityDeadline: '2026-08-15T00:00:00.000Z', eligible: true, reason: '',
    }],
  }],
};
const requested = {
  _id: IDS.request, returnNumber: 'RET-1001-A1B2C3', order: IDS.order, orderId: order.orderId,
  buyer: IDS.buyer, seller: { _id: IDS.seller, username: 'seller' },
  store: { _id: IDS.store, storeName: 'Verified Store' }, storeName: 'Verified Store', currency: 'PKR',
  items: [{ orderItemId: IDS.item, productId: IDS.product, name: 'Verified shoes', image: '',
    quantity: 1, purchasedQuantity: 2, unitPrice: 50, lineSubtotal: 50 }],
  reasonCategory: 'damaged', reasonDetails: 'The item arrived damaged.', status: 'requested',
  statusHistory: [{ status: 'requested', note: 'The item arrived damaged.', changedBy: IDS.buyer,
    actorRole: 'buyer', changedAt: '2026-08-05T00:00:00.000Z' }],
  requestedAt: '2026-08-05T00:00:00.000Z', eligibilityDeadline: '2026-08-15T00:00:00.000Z',
  policySnapshot: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' },
  refund: { itemSubtotal: 50, taxAmount: 2.5, shippingAmount: 10, discountAmount: 2.5, totalAmount: 60 },
  createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
};
const withStatus = status => status === 'requested' ? clone(requested) : {
  ...clone(requested), status, updatedAt: '2026-08-06T00:00:00.000Z',
  statusHistory: [...requested.statusHistory, { status, note: 'Verified update', changedBy: IDS.seller,
    actorRole: 'seller', changedAt: '2026-08-06T00:00:00.000Z' }],
};
const page = requests => ({ success: true, returns: requests,
  pagination: { page: 1, limit: 100, totalReturns: requests.length, totalPages: 1, hasMore: false } });
const snapshot = (status = 'requested') => ({ eligibility: clone(eligibility), requests: [withStatus(status)] });
const installSnapshot = value => api.get.mockImplementation(async url => ({
  data: url === '/api/returns/mine' ? page(value.requests) : value.eligibility,
}));
const formatMoney = amount => `PKR ${amount.toFixed(2)}`;
const props = { order, formatMoney };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async milliseconds => { await act(async () => { jest.advanceTimersByTime(milliseconds); }); };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let appStateDescriptor;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockFocused = true;
  appStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'active' });
  installSnapshot(snapshot());
});
afterEach(() => {
  jest.restoreAllMocks();
  if (appStateDescriptor) Object.defineProperty(AppState, 'currentState', appStateDescriptor);
  else delete AppState.currentState;
  jest.useRealTimers();
});

test('buyer history and return-request modal preserve the selected variants read-only', async () => {
  const value = snapshot();
  const variants = { selectedColor: 'Blue', selectedOptions: { Color: 'Blue', Size: 'Large' } };
  Object.assign(value.eligibility.groups[0].items[0], variants);
  Object.assign(value.requests[0].items[0], variants);
  installSnapshot(value);
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  expect(screen.getAllByText('Color: Blue')).toHaveLength(1);
  fireEvent.press(screen.getByText('Request'));
  expect(screen.getAllByText('Color: Blue')).toHaveLength(2);
  expect(screen.getAllByText('Size: Large')).toHaveLength(2);
  expect(api.post).not.toHaveBeenCalled();
});

test('an active requested return follows pending payment to verified Wallet completion and stops', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  expect(screen.getAllByText('Return requested').length).toBeGreaterThan(0);
  installSnapshot(snapshot('accepted_pending_payment'));
  await advance(5000);
  expect(screen.getAllByText('Accepted - refund payment pending').length).toBeGreaterThan(0);
  installSnapshot(snapshot('returned'));
  await advance(5000);
  expect(screen.getAllByText('Returned - wallet refund issued').length).toBeGreaterThan(0);
  expect(screen.queryByText('Checking seller return policies...')).toBeNull();
  expect(api.get).toHaveBeenCalledTimes(6);
  await advance(30000);
  expect(api.get).toHaveBeenCalledTimes(6);
  expect(Feedback.show).not.toHaveBeenCalled();
});

test('hidden screens and background apps do not poll; focused foreground screens resume', async () => {
  mockFocused = false;
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  await advance(15000);
  expect(api.get).toHaveBeenCalledTimes(2);
  mockFocused = true;
  screen.rerender(<BuyerReturnsSection {...props} />);
  AppState.currentState = 'background';
  await advance(10000);
  expect(api.get).toHaveBeenCalledTimes(2);
  AppState.currentState = 'active';
  await advance(5000);
  expect(api.get).toHaveBeenCalledTimes(4);
  mockFocused = false;
  screen.rerender(<BuyerReturnsSection {...props} />);
  await advance(10000);
  expect(api.get).toHaveBeenCalledTimes(4);
});

test('quiet success and network failures preserve the open form, quantity, reason and verified rows', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  fireEvent.press(screen.getByText('Request'));
  fireEvent.press(screen.UNSAFE_getByProps({ name: 'add' }));
  fireEvent.changeText(screen.getByPlaceholderText('Describe the issue clearly for the seller.'), 'Keep my return details while the seller updates another return.');
  fireEvent.press(screen.getByText('Changed mind'));
  installSnapshot(snapshot('approved'));
  await advance(5000);
  expect(screen.getByText('Request a return')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByDisplayValue('Keep my return details while the seller updates another return.')).toBeTruthy();
  expect(screen.getAllByText('Return approved').length).toBeGreaterThan(0);
  api.get.mockRejectedValue(new Error('offline'));
  await advance(5000);
  expect(screen.getByText('Request a return')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByDisplayValue('Keep my return details while the seller updates another return.')).toBeTruthy();
  expect(screen.getAllByText('Return approved').length).toBeGreaterThan(0);
  expect(screen.queryByText('Returned - wallet refund issued')).toBeNull();
  expect(Feedback.show).not.toHaveBeenCalled();
  // Submitting still uses the unchanged selected reason and draft quantity.
  api.post.mockReturnValue(new Promise(() => {}));
  fireEvent.press(screen.getByText('Submit Return Request'));
  expect(api.post).toHaveBeenCalledWith('/api/returns', expect.objectContaining({
    reasonCategory: 'changed_mind',
    reasonDetails: 'Keep my return details while the seller updates another return.',
    items: [{ orderItemId: IDS.item, quantity: 1 }],
  }), expect.any(Object));
  await advance(15000);
  expect(api.get).toHaveBeenCalledTimes(6);
});

test.each(['financial', 'pagination'])('unverified %s responses disable actions without discarding an open draft', async type => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  fireEvent.press(screen.getByText('Request'));
  fireEvent.press(screen.UNSAFE_getByProps({ name: 'add' }));
  fireEvent.changeText(screen.getByPlaceholderText('Describe the issue clearly for the seller.'), 'Keep this draft until verified return information is available.');
  const invalid = snapshot('returned');
  if (type === 'financial') {
    invalid.requests[0].refund.totalAmount = 9999;
    installSnapshot(invalid);
  } else {
    api.get.mockImplementation(async url => ({ data: url === '/api/returns/mine'
      ? { success: true, returns: invalid.requests } : eligibility }));
  }
  await advance(5000);
  expect(screen.getByText('Request a return')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByDisplayValue('Keep this draft until verified return information is available.')).toBeTruthy();
  expect(screen.getByText('Retry return information before submitting.')).toBeTruthy();
  expect(screen.queryByText('Return requested')).toBeNull();
  expect(screen.queryByText('Returned - wallet refund issued')).toBeNull();
  fireEvent.press(screen.getByText('Submit Return Request'));
  expect(api.post).not.toHaveBeenCalled();
  expect(Feedback.show).not.toHaveBeenCalled();
  installSnapshot(snapshot());
  fireEvent.press(screen.getByLabelText('Retry return information'));
  await flush();
  expect(screen.getByDisplayValue('Keep this draft until verified return information is available.')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.queryByText('Retry return information before submitting.')).toBeNull();
  api.post.mockReturnValue(new Promise(() => {}));
  fireEvent.press(screen.getByText('Submit Return Request'));
  expect(api.post).toHaveBeenCalledWith('/api/returns', expect.objectContaining({
    reasonDetails: 'Keep this draft until verified return information is available.',
    items: [{ orderItemId: IDS.item, quantity: 1 }],
  }), expect.any(Object));
});

test('a failed quiet request preserves verified state and retries without notifications', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  api.get.mockRejectedValue(new Error('offline'));
  await advance(5000);
  expect(screen.getAllByText('Return requested').length).toBeGreaterThan(0);
  expect(Feedback.show).not.toHaveBeenCalled();
  installSnapshot(snapshot('returned'));
  await advance(5000);
  expect(screen.getAllByText('Returned - wallet refund issued').length).toBeGreaterThan(0);
});

test.each(['eligibility', 'financial', 'pagination'])('a mixed %s validation failure and transient sibling failure still disables actions', async type => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  const invalid = snapshot('returned');
  invalid.eligibility.success = false;
  invalid.requests[0].refund.totalAmount = 9999;
  api.get.mockImplementation(url => {
    if (type === 'eligibility') return url === '/api/returns/mine'
      ? Promise.reject({ response: { status: 502 } }) : Promise.resolve({ data: invalid.eligibility });
    return url === '/api/returns/mine'
      ? Promise.resolve({ data: type === 'financial' ? page(invalid.requests) : { success: true, returns: [] } })
      : Promise.reject({ response: { status: 502 } });
  });
  await advance(5000);
  expect(screen.getByText('Return information unavailable')).toBeTruthy();
  expect(screen.queryByText('Return requested')).toBeNull();
  expect(screen.queryByText('Returned - wallet refund issued')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test('latest verified eligibility disables an outdated quantity while preserving the draft', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  fireEvent.press(screen.getByText('Request'));
  fireEvent.press(screen.UNSAFE_getByProps({ name: 'add' }));
  fireEvent.changeText(screen.getByPlaceholderText('Describe the issue clearly for the seller.'), 'The draft should remain when the last eligible item was requested elsewhere.');
  const next = snapshot();
  const another = { ...clone(requested), _id: '64b000000000000000000108', returnNumber: 'RET-1001-D4E5F6',
    refund: { itemSubtotal: 50, taxAmount: 2.5, shippingAmount: 0, discountAmount: 2.5, totalAmount: 50 } };
  next.requests.push(another);
  next.eligibility.groups[0].eligible = false;
  next.eligibility.groups[0].eligibilityDeadline = null;
  next.eligibility.groups[0].reason = 'All ordered items already have return requests.';
  next.eligibility.groups[0].items[0].alreadyRequestedQuantity = 2;
  next.eligibility.groups[0].items[0].remainingReturnableQuantity = 0;
  next.eligibility.groups[0].items[0].eligible = false;
  next.eligibility.groups[0].items[0].reason = 'All ordered items already have return requests.';
  installSnapshot(next);
  await advance(5000);
  expect(screen.getByText('Request a return')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByDisplayValue('The draft should remain when the last eligible item was requested elsewhere.')).toBeTruthy();
  expect(screen.getByText('Return eligibility changed. Review the available items before submitting.')).toBeTruthy();
  fireEvent.press(screen.getByText('Submit Return Request'));
  expect(api.post).not.toHaveBeenCalled();
});

test('a failed creation revalidates and retries the same request key without losing the draft', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  fireEvent.press(screen.getByText('Request'));
  fireEvent.press(screen.UNSAFE_getByProps({ name: 'add' }));
  fireEvent.changeText(screen.getByPlaceholderText('Describe the issue clearly for the seller.'), 'The pending request must use the same key after a network failure.');
  api.post.mockRejectedValueOnce(new Error('offline'));
  fireEvent.press(screen.getByText('Submit Return Request'));
  await flush();
  const firstBody = api.post.mock.calls[0][1];
  expect(screen.getByText('Retry return information before submitting.')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Retry return information'));
  await flush();
  expect(screen.getByDisplayValue('The pending request must use the same key after a network failure.')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  api.post.mockReturnValueOnce(new Promise(() => {}));
  fireEvent.press(screen.getByText('Submit Return Request'));
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post.mock.calls[1][1]).toEqual(firstBody);
});

test('slow refreshes never overlap, and unmount stops even an in-flight refresh', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  const listRead = deferred();
  api.get.mockImplementation(url => url === '/api/returns/mine'
    ? listRead.promise : Promise.resolve({ data: eligibility }));
  await advance(5000);
  await advance(30000);
  expect(api.get).toHaveBeenCalledTimes(4);
  screen.unmount();
  await act(async () => { listRead.resolve({ data: page([withStatus('returned')]) }); });
  await advance(30000);
  expect(api.get).toHaveBeenCalledTimes(4);
  expect(Feedback.show).not.toHaveBeenCalled();
});

test('an endpoint failure waits for its sibling read before another quiet refresh can start', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  const listRead = deferred();
  api.get.mockImplementation(url => url === '/api/returns/mine'
    ? listRead.promise : Promise.reject(new Error('eligibility is offline')));
  await advance(5000);
  await advance(30000);
  expect(api.get).toHaveBeenCalledTimes(4);
  expect(screen.getAllByText('Return requested').length).toBeGreaterThan(0);
  await act(async () => { listRead.resolve({ data: page([requested]) }); });
  installSnapshot(snapshot('returned'));
  await advance(5000);
  expect(api.get).toHaveBeenCalledTimes(6);
  expect(screen.getAllByText('Returned - wallet refund issued').length).toBeGreaterThan(0);
});

test('a buyer cancellation invalidates an older poll and verifies its own terminal snapshot', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  const listRead = deferred();
  api.get.mockImplementation(url => url === '/api/returns/mine'
    ? listRead.promise : Promise.resolve({ data: eligibility }));
  await advance(5000);
  const mutation = deferred();
  api.post.mockReturnValue(mutation.promise);
  fireEvent.press(screen.getByText('Cancel'));
  let cancelTask;
  await act(async () => { cancelTask = alert.mock.calls[0][2][1].onPress(); });
  expect(api.post).toHaveBeenCalledWith(`/api/returns/${IDS.request}/cancel`, {});
  await act(async () => { listRead.resolve({ data: page([withStatus('returned')]) }); });
  expect(screen.queryByText('Returned - wallet refund issued')).toBeNull();
  const cancelled = snapshot('cancelled_by_buyer');
  cancelled.eligibility.groups[0].items[0].alreadyRequestedQuantity = 0;
  cancelled.eligibility.groups[0].items[0].remainingReturnableQuantity = 2;
  installSnapshot(cancelled);
  await act(async () => {
    mutation.resolve({ data: { success: true, returnRequest: cancelled.requests[0] } });
    await cancelTask;
  });
  expect(screen.getAllByText('Cancelled by buyer').length).toBeGreaterThan(0);
  expect(Feedback.show).toHaveBeenCalledWith({ type: 'success', text1: 'Return request cancelled' });
  await advance(30000);
  expect(api.get).toHaveBeenCalledTimes(6);
});

test('leaving and reopening the same order invalidates a previous cancellation response', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  const oldMutation = deferred();
  const currentMutation = deferred();
  api.post.mockReturnValueOnce(oldMutation.promise).mockReturnValueOnce(currentMutation.promise);
  fireEvent.press(screen.getByText('Cancel'));
  let oldTask;
  await act(async () => { oldTask = alert.mock.calls[0][2][1].onPress(); });
  const nextOrder = { ...order, _id: '64b000000000000000000201', orderId: 'ORD-RETURN-2001' };
  const next = snapshot();
  next.eligibility.orderId = nextOrder.orderId;
  next.requests[0].order = nextOrder._id;
  next.requests[0].orderId = nextOrder.orderId;
  installSnapshot(next);
  screen.rerender(<BuyerReturnsSection order={nextOrder} formatMoney={formatMoney} />);
  await flush();
  installSnapshot(snapshot());
  screen.rerender(<BuyerReturnsSection {...props} />);
  await flush();
  fireEvent.press(screen.getByText('Cancel'));
  let currentTask;
  await act(async () => { currentTask = alert.mock.calls[1][2][1].onPress(); });
  const cancelled = snapshot('cancelled_by_buyer');
  cancelled.eligibility.groups[0].items[0].alreadyRequestedQuantity = 0;
  cancelled.eligibility.groups[0].items[0].remainingReturnableQuantity = 2;
  await act(async () => {
    oldMutation.resolve({ data: { success: true, returnRequest: cancelled.requests[0] } });
    await oldTask;
  });
  expect(api.get).toHaveBeenCalledTimes(6);
  expect(Feedback.show).not.toHaveBeenCalled();
  installSnapshot(cancelled);
  await act(async () => {
    currentMutation.resolve({ data: { success: true, returnRequest: cancelled.requests[0] } });
    await currentTask;
  });
  expect(api.get).toHaveBeenCalledTimes(8);
  expect(screen.getAllByText('Cancelled by buyer').length).toBeGreaterThan(0);
  expect(Feedback.show).toHaveBeenCalledTimes(1);
});

test('a new order waits for the previous reads and cannot render a stale return response', async () => {
  const screen = render(<BuyerReturnsSection {...props} />);
  await flush();
  const listRead = deferred();
  api.get.mockImplementation(url => url === '/api/returns/mine'
    ? listRead.promise : Promise.resolve({ data: eligibility }));
  await advance(5000);
  const nextOrder = { ...order, _id: '64b000000000000000000201', orderId: 'ORD-RETURN-2001' };
  const next = snapshot('approved');
  next.eligibility.orderId = nextOrder.orderId;
  next.requests[0].order = nextOrder._id;
  next.requests[0].orderId = nextOrder.orderId;
  installSnapshot(next);
  screen.rerender(<BuyerReturnsSection order={nextOrder} formatMoney={formatMoney} />);
  await flush();
  expect(api.get).toHaveBeenCalledTimes(4);
  await act(async () => { listRead.resolve({ data: page([withStatus('returned')]) }); });
  expect(api.get).toHaveBeenCalledTimes(6);
  expect(screen.getAllByText('Return approved').length).toBeGreaterThan(0);
  expect(screen.queryByText('Returned - wallet refund issued')).toBeNull();
});
