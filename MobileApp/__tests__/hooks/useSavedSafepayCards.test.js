import { act, renderHook } from '@testing-library/react-native';
import useSavedSafepayCards from '../../src/hooks/useSavedSafepayCards';
import api from '../../src/config/api';

let mockUser = { id: 'buyerA' };
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: mockUser }) }));
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

beforeEach(() => { mockUser = { id: 'buyerA' }; api.get.mockReset(); });

test.each(['', 'pm_manual-choice'])('an explicit choice %s survives card-list refresh instead of silently selecting the default', async selected => {
  const cards = [{ id: 'pm_default-card', last4: '1005', usable: true }, { id: 'pm_manual-choice', last4: '1111', usable: true }];
  api.get.mockResolvedValue({ data: { cards, defaultPaymentMethodId: cards[0].id } });
  const hook = renderHook(() => useSavedSafepayCards()); await act(async () => {});
  expect(hook.result.current.selectedCardId).toBe(cards[0].id);
  act(() => hook.result.current.setSelectedCardId(selected));
  await act(async () => { hook.result.current.refreshCards(); });
  expect(hook.result.current.selectedCardId).toBe(selected); hook.unmount();
});

test.each([false, true])('retains authoritative profile readiness %s even when no cards exist', async ready => {
  api.get.mockResolvedValue({ data: { cards: [], billingProfileReady: ready } });
  const hook = renderHook(() => useSavedSafepayCards());
  expect(hook.result.current.billingProfileReady).toBeNull();
  await act(async () => {});
  expect(hook.result.current.billingProfileReady).toBe(ready);
  expect(hook.result.current.cards).toEqual([]);
  hook.unmount();
});

test('unknown/failed profile lookups are not misrepresented as a new billing profile', async () => {
  api.get.mockRejectedValue(new Error('Temporary outage'));
  const hook = renderHook(() => useSavedSafepayCards());
  await act(async () => {});
  expect(hook.result.current.billingProfileReady).toBeNull();
  api.get.mockResolvedValue({ data: { cards: [] } });
  await act(async () => { hook.result.current.refreshCards(); });
  expect(hook.result.current.billingProfileReady).toBeNull();
  hook.unmount();
});

test('account switches discard the previous profile and ignore late responses', async () => {
  let resolveA, resolveB;
  api.get.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
  const hook = renderHook(() => useSavedSafepayCards());
  mockUser = { id: 'buyerB' };
  hook.rerender();
  expect(hook.result.current.billingProfileReady).toBeNull();
  await act(async () => { resolveA({ data: { cards: [], billingProfileReady: true } }); });
  expect(hook.result.current.billingProfileReady).toBeNull();
  await act(async () => { resolveB({ data: { cards: [], billingProfileReady: false } }); });
  expect(hook.result.current.billingProfileReady).toBe(false);
  hook.unmount();
});

test('profile refresh after creating a customer removes the first-time name restriction', async () => {
  api.get.mockResolvedValueOnce({ data: { cards: [], billingProfileReady: false } })
    .mockResolvedValueOnce({ data: { cards: [], billingProfileReady: true } });
  const hook = renderHook(() => useSavedSafepayCards());
  await act(async () => {});
  expect(hook.result.current.billingProfileReady).toBe(false);
  await act(async () => { hook.result.current.refreshCards(); });
  expect(hook.result.current.billingProfileReady).toBe(true);
  hook.unmount();
});
