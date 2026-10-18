export function safepayCardSetupNotice(result, refreshed) {
  if (result?.status === 'failed' && result.failureCode === 'SAFEPAY_CARD_SETUP_NOT_REUSABLE') return 'Safepay verified the card but did not save it for future payments. Please start a new secure card setup.';
  if (['failed', 'cancelled'].includes(result?.status)) return 'Card setup did not complete. You can start a new secure setup.';
  if (result?.status !== 'authorized') return 'Card setup is not complete. Retry to check the same attempt.';
  if (!Array.isArray(refreshed?.cards)) return 'Your cards could not be refreshed yet. Use Refresh saved cards to check before starting another setup.';
  const saved = result.savedPaymentMethodId && refreshed.cards.find(card => card?.id === result.savedPaymentMethodId && card.usable === true);
  if (saved) return refreshed.defaultPaymentMethodId === saved.id
    ? 'Your card is saved and set as your default for checkout.' : 'Your card is saved. Your current default card is unchanged.';
  if (!result.savedPaymentMethodId && refreshed.cards.some(card => card?.usable === true)) return 'Card verification completed. Your saved cards are listed below.';
  return 'Your saved card is not available yet. Refresh your cards to check before starting another setup.';
}
