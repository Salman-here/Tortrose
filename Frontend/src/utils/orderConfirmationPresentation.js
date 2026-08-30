export const shouldShowGenericConfirmedBanner = ({
  actionDone,
  orderStatus,
  hasSpecificConfirmationState = false,
  hasCancellationState = false,
} = {}) => actionDone === 'confirmed'
  && String(orderStatus || '').trim().toLowerCase() !== 'cancelled'
  && !hasSpecificConfirmationState
  && !hasCancellationState;
