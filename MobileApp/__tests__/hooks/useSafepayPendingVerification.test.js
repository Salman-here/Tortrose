import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import useSafepayPendingVerification from '../../src/hooks/useSafepayPendingVerification';
import api from '../../src/config/api';
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const id = 'a'.repeat(24);
const pending = { paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', paymentId: id, environment: 'sandbox', purpose: 'order',
  currency: 'PKR', amountMinor: 10000, status: 'pending', isPaid: false };
const paid = { ...pending, status: 'paid', isPaid: true, webhookProcessed: true };
const notice = { paymentId: id, safepay: true, owner: 'buyerA', status: 'pending', expectedPayment: pending };
let foreground, remove;
beforeEach(() => {
  jest.useFakeTimers(); api.get.mockReset(); AppState.currentState = 'active'; remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, handler) => { foreground = handler; return { remove }; });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test('a delayed confirmed payment is delivered automatically without a new presenter or payment', async () => {
  api.get.mockResolvedValueOnce({ data: pending }).mockResolvedValueOnce({ data: paid });
  const verified = jest.fn(), hook = renderHook(() => useSafepayPendingVerification({ payment: notice, owner: 'buyerA', onVerified: verified }));
  await act(async () => { await jest.advanceTimersByTimeAsync(1500); });
  expect(verified).toHaveBeenCalledTimes(1); expect(verified).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid', paymentId: id }));
  expect(api.get).toHaveBeenCalledTimes(2); expect(hook.result.current).toBe(false); hook.unmount(); expect(remove).toHaveBeenCalled();
});
test('unmounting cancels the active read and ignores even a late paid response', async () => {
  let finish; api.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const verified = jest.fn(), hook = renderHook(() => useSafepayPendingVerification({ payment: notice, owner: 'buyerA', onVerified: verified }));
  await act(async () => {}); const signal = api.get.mock.calls[0][1].signal;
  hook.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => { finish({ data: paid }); await jest.advanceTimersByTimeAsync(0); });
  expect(verified).not.toHaveBeenCalled(); expect(api.get).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});
test('an account switch cannot confirm the previous owner payment', async () => {
  let finish; api.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const verified = jest.fn(), hook = renderHook(({ owner }) => useSafepayPendingVerification({ payment: notice, owner, onVerified: verified }), { initialProps: { owner: 'buyerA' } });
  await act(async () => {}); hook.rerender({ owner: 'buyerB' });
  await act(async () => { finish({ data: paid }); }); expect(verified).not.toHaveBeenCalled(); expect(api.get).toHaveBeenCalledTimes(1); hook.unmount();
});
test('verification pauses for a presenter/background and restarts on foreground return', async () => {
  api.get.mockResolvedValue({ data: pending });
  const verified = jest.fn(), hook = renderHook(({ paused }) => useSafepayPendingVerification({ payment: notice, owner: 'buyerA', paused, onVerified: verified }), { initialProps: { paused: true } });
  await act(async () => {}); expect(api.get).not.toHaveBeenCalled();
  hook.rerender({ paused: false }); await act(async () => {}); expect(api.get).toHaveBeenCalledTimes(1);
  await act(async () => { foreground('background'); });
  api.get.mockResolvedValue({ data: paid }); await act(async () => { foreground('active'); });
  expect(verified).toHaveBeenCalledWith(expect.objectContaining({ status: 'paid' })); hook.unmount();
});
test('uncertain/offline payments stay pending and polling is bounded', async () => {
  api.get.mockRejectedValue(new Error('Offline'));
  const verified = jest.fn(), hook = renderHook(() => useSafepayPendingVerification({ payment: notice, owner: 'buyerA', onVerified: verified }));
  await act(async () => { await jest.runAllTimersAsync(); });
  expect(api.get).toHaveBeenCalledTimes(6); expect(verified).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', isPaid: false }));
  expect(hook.result.current).toBe(false); hook.unmount(); expect(jest.getTimerCount()).toBe(0);
});
test.each(['manual_review', 'refund_pending', 'reversed', 'refunded', 'paid'])('a %s payment is not polled as an unconfirmed checkout', async status => {
  const hook = renderHook(() => useSafepayPendingVerification({ payment: { ...notice, status }, owner: 'buyerA', onVerified: jest.fn() }));
  await act(async () => {}); expect(api.get).not.toHaveBeenCalled(); hook.unmount();
});
