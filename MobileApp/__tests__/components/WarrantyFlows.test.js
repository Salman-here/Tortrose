import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import BuyerWarrantySection from '../../src/components/BuyerWarrantySection';
import SellerAfterSalesActionModal from '../../src/components/SellerAfterSalesActionModal';
import api from '../../src/config/api';
import * as ImagePicker from 'expo-image-picker';

jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() }, API_UPLOAD_TIMEOUT_MS: 60000 }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/utils/feedback', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../src/components/common/AppModal', () => ({ visible, children }) => visible ? children : null);
jest.mock('../../src/components/common/KeyboardAwareFormScrollView', () => ({ children }) => children);
const ids = { order: '64b000000000000000000001', item: '64b000000000000000000002', product: '64b000000000000000000003',
  seller: '64b000000000000000000004', buyer: '64b000000000000000000005', claim: '64b000000000000000000006', photo: '64b000000000000000000007' };
const at = '2026-10-14T10:00:00.000Z', delivered = '2026-10-01T10:00:00.000Z', deadline = '2026-11-01T10:00:00.000Z';
const order = { _id: ids.order, orderId: 'ORD-WARRANTY-MOBILE', currency: 'PKR', user: ids.buyer,
  orderItems: [{ _id: ids.item, productId: ids.product, seller: ids.seller, name: 'Purchased mug', image: '', quantity: 1, lineSubtotal: 100, price: 100 }],
  orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 100 } };
const claim = { _id: ids.claim, kind: 'warranty', order: ids.order, orderId: order.orderId, buyer: ids.buyer,
  seller: { _id: ids.seller, username: 'QA Seller' }, store: null, storeName: 'QA Store', currency: 'PKR', returnNumber: 'WAR-MOBILE-1',
  items: [{ orderItemId: ids.item, productId: ids.product, name: 'Purchased mug', image: '', quantity: 1, purchasedQuantity: 1, lineSubtotal: 100, unitPrice: 100 }],
  reasonCategory: 'defective', reasonDetails: 'The original mug lid leaks.', status: 'requested', resolution: null,
  warrantySnapshot: { version: 1, months: 1, deliveredAt: delivered, deadline }, requestedAt: at, eligibilityDeadline: deadline,
  evidence: [ids.photo], evidenceUrls: ['https://example.com/owned-photo.png'], appealVersion: 0, decisionReason: '',
  createdAt: at, updatedAt: at, statusHistory: [{ status: 'requested', changedAt: at, changedBy: ids.buyer, actorRole: 'buyer', note: 'The original mug lid leaks.' }],
  policySnapshot: { returnsEnabled: true, returnDuration: 1, refundType: 'full_refund' },
  refund: { itemSubtotal: 100, taxAmount: 0, shippingAmount: 0, discountAmount: 0, totalAmount: 100 } };
const coverage = { success: true, version: 1, orderId: ids.order, currency: 'PKR', groups: [{ seller: { _id: ids.seller, username: 'QA Seller' }, store: { storeName: 'QA Store' }, items: [{ orderItemId: ids.item, name: 'Purchased mug', purchasedQuantity: 1, availableQuantity: 1, eligible: true, reason: '', months: 1, deliveredAt: delivered, deadline, description: 'Manufacturing defects' }] }] };
const list = rows => ({ success: true, returns: rows, pagination: { page: 1, totalPages: 1, totalReturns: rows.length, limit: 100, hasMore: false } });
beforeEach(() => { jest.clearAllMocks(); api.get.mockImplementation(async path => ({ data: path.includes('/eligibility') ? coverage : list([]) })); });

test('buyer sees per-product coverage, uploads a photo and submits the original order/quantity with an idempotency key', async () => {
  ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
  ImagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///qa-photo.png', fileName: 'qa-photo.png', mimeType: 'image/png', fileSize: 100 }] });
  api.post.mockImplementation(async path => {
    if (path.endsWith('/evidence')) return { data: { success: true, evidence: { _id: ids.photo, url: claim.evidenceUrls[0] } } };
    api.get.mockImplementation(async route => ({ data: route.includes('/eligibility') ? { ...coverage, groups: [{ ...coverage.groups[0], items: [{ ...coverage.groups[0].items[0], eligible: false, availableQuantity: 0, reason: 'An active claim uses this unit.' }] }] } : list([claim]) }));
    return { data: { success: true, returnRequest: claim } };
  });
  const screen = render(<BuyerWarrantySection order={order} formatMoney={value => `PKR ${value}`} />);
  await waitFor(() => expect(screen.getByText('Claim warranty')).toBeTruthy());
  fireEvent.press(screen.getByText('Claim warranty'));
  fireEvent.changeText(screen.getByLabelText('Warranty reason'), 'The original mug lid leaks.');
  await act(async () => { fireEvent.press(screen.getByText('Add photos (0/6)')); });
  await waitFor(() => expect(screen.getByText('Add photos (1/6)')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByText('Submit warranty claim')); });
  expect(api.post).toHaveBeenCalledWith('/api/warranties', expect.objectContaining({ orderId: ids.order, sellerId: ids.seller,
    items: [{ orderItemId: ids.item, quantity: 1 }], evidenceIds: [ids.photo], requestKey: '00000000-0000-4000-8000-000000000001' }));
  await waitFor(() => expect(screen.getByText('Claim #WAR-MOBILE-1')).toBeTruthy());
});

test('buyer cannot submit without photo evidence and a clear reason', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  try {
    const screen = render(<BuyerWarrantySection order={order} formatMoney={value => `PKR ${value}`} />);
    await waitFor(() => expect(screen.getByText('Claim warranty')).toBeTruthy());
    fireEvent.press(screen.getByText('Claim warranty')); fireEvent.press(screen.getByText('Submit warranty claim'));
    expect(alert).toHaveBeenCalledWith('Complete the claim', expect.any(String)); expect(api.post).not.toHaveBeenCalled();
  } finally { alert.mockRestore(); }
});

test('seller must explicitly declare a resolution and reason before approval; the real modal calls the warranty endpoint', async () => {
  const onSuccess = jest.fn(), onClose = jest.fn();
  api.post.mockResolvedValue({ data: { success: true, returnRequest: { ...claim, status: 'approved', resolution: 'refund' } } });
  const screen = render(<SellerAfterSalesActionModal action={{ type: 'decision', status: 'approved', request: claim }} kind="warranty" onClose={onClose} onSuccess={onSuccess} />);
  fireEvent.press(screen.getByText('Confirm decision')); expect(api.post).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Refund to Rozare Wallet'));
  fireEvent.changeText(screen.getByLabelText('Decision reason (required)'), 'We will refund the original faulty product.');
  await act(async () => { fireEvent.press(screen.getByText('Confirm decision')); });
  expect(api.post).toHaveBeenCalledWith(`/api/warranties/${ids.claim}/decision`, { outcome: 'approve', resolution: 'refund',
    reason: 'We will refund the original faulty product.', expectedUpdatedAt: at });
  expect(onSuccess).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
});

test('expired rejected original claim still offers an appeal, with its original quantities and photos', async () => {
  const rejected = { ...claim, status: 'rejected', decisionReason: 'Please clarify the fault.',
    warrantySnapshot: { ...claim.warrantySnapshot, deliveredAt: '2026-01-01T10:00:00.000Z', deadline: '2026-02-01T10:00:00.000Z' },
    requestedAt: '2026-01-10T10:00:00.000Z', eligibilityDeadline: '2026-02-01T10:00:00.000Z', createdAt: '2026-01-10T10:00:00.000Z',
    statusHistory: [{ status: 'requested', changedAt: '2026-01-10T10:00:00.000Z', changedBy: ids.buyer, actorRole: 'buyer', note: claim.reasonDetails }, { status: 'rejected', changedAt: at, changedBy: ids.seller, actorRole: 'seller', note: 'Please clarify the fault.' }] };
  api.get.mockImplementation(async path => ({ data: path.includes('/eligibility') ? { ...coverage, groups: [{ ...coverage.groups[0], items: [{ ...coverage.groups[0].items[0], eligible: false, reason: 'Warranty expired.' }] }] } : list([rejected]) }));
  const screen = render(<BuyerWarrantySection order={order} formatMoney={value => `PKR ${value}`} />);
  await waitFor(() => expect(screen.getByText('Appeal original claim')).toBeTruthy());
  fireEvent.press(screen.getByText('Appeal original claim'));
  expect(screen.getByText('This appeal keeps the original claim and warranty deadline.')).toBeTruthy();
  expect(screen.queryByLabelText('Claim quantity')).toBeNull();
  expect(screen.getByText('Add photos (1/6)')).toBeTruthy();
});
