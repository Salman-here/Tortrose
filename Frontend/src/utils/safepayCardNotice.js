export function safepayCardSetupNotice(status, refreshedCards) {
  if (status !== 'authorized') return 'Card setup is not complete. Retry to check the same attempt; adding a card does not start a subscription.';
  if (!Array.isArray(refreshedCards)) return 'Verification completed, but your cards could not be refreshed yet. Use Refresh saved cards to check before starting another setup.';
  if (refreshedCards.some(card => card?.usable === true)) return 'Card verification completed. Your reusable cards are listed below. Subscription billing requires a separate agreement.';
  return 'Verification completed, but no reusable card was saved. Add it again and select “Securely save this card” on the Safepay form.';
}
