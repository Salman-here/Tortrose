import React, { act, useState } from 'react';
import TestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import api from '../../src/config/api';
import useProductModerationUpdates from '../../src/hooks/useProductModerationUpdates';
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
let latest, update, root;
const pending = { _id: '64b000000000000000000001', moderationRevision: 'revision-a', moderationPolicyVersion: 'policy', moderationStatus: 'pending', isBlocked: true };
function Probe({ initial = [pending] }) { const [products, setProducts] = useState(initial); latest = products; update = setProducts; useProductModerationUpdates(products, setProducts); return null; }
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); AppState.currentState = 'active'; });
afterEach(() => { if (root) act(() => root.unmount()); root = null; jest.useRealTimers(); });
const mount = async initial => { await act(async () => { root = TestRenderer.create(<Probe initial={initial} />); }); };
const tick = async () => { await act(async () => { jest.advanceTimersByTime(8000); await Promise.resolve(); }); };

test('pending approval updates the saved product and reviewed image without losing stock/prices', async () => {
  api.get.mockResolvedValue({ data: { products: [{ ...pending, moderationStatus: 'approved', isBlocked: false, image: 'https://example.com/reviewed.png' }] } });
  await mount([{ ...pending, price: 20, stock: 10 }]); await tick();
  expect(latest[0]).toMatchObject({ price: 20, stock: 10, moderationStatus: 'approved', image: 'https://example.com/reviewed.png' });
  await tick(); expect(api.get).toHaveBeenCalledTimes(1);
});
test('a late approval cannot overwrite a newer edit of the same product', async () => {
  let resolve; api.get.mockReturnValue(new Promise(done => { resolve = done; }));
  await mount(); await tick();
  await act(async () => update([{ ...pending, moderationRevision: 'revision-b', name: 'New content' }]));
  await act(async () => resolve({ data: { products: [{ ...pending, moderationStatus: 'approved', isBlocked: false }] } }));
  expect(latest[0]).toMatchObject({ name: 'New content', moderationRevision: 'revision-b', moderationStatus: 'pending', isBlocked: true });
});
test('failed requests preserve the hold; background apps and already-approved legacy products do not poll', async () => {
  api.get.mockRejectedValue(new Error('offline')); await mount(); await tick();
  expect(latest[0]).toEqual(pending);
  AppState.currentState = 'background'; await tick(); expect(api.get).toHaveBeenCalledTimes(1);
  await act(async () => update([{ _id: pending._id, moderationStatus: 'approved' }]));
  AppState.currentState = 'active'; await tick(); expect(api.get).toHaveBeenCalledTimes(1);
});
test('unmount aborts a pending status request', async () => {
  api.get.mockReturnValue(new Promise(() => {})); await mount(); await tick();
  const signal = api.get.mock.calls[0][1].signal;
  act(() => root.unmount()); root = null; expect(signal.aborted).toBe(true);
});
