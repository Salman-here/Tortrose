import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowGenericConfirmedBanner } from '../src/utils/orderConfirmationPresentation.js';

test('shows the generic success banner only for a currently confirmed order without a more specific banner', () => {
  assert.equal(shouldShowGenericConfirmedBanner({
    actionDone: 'confirmed',
    orderStatus: 'confirmed',
  }), true);

  assert.equal(shouldShowGenericConfirmedBanner({
    actionDone: 'confirmed',
    orderStatus: 'confirmed',
    hasSpecificConfirmationState: true,
  }), false);
});

test('never shows confirmed success after an administrator, seller, or system cancellation', () => {
  for (const hasCancellationState of [false, true]) {
    assert.equal(shouldShowGenericConfirmedBanner({
      actionDone: 'confirmed',
      orderStatus: 'cancelled',
      hasCancellationState,
    }), false);
  }
});
