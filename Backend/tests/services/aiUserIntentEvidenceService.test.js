'use strict';
const { trustedVoiceIntentText } = require('../../services/aiUserIntentEvidenceService');
const { isCommerceConfirmation } = require('../../services/aiCommercePreviewService');
test('a successful current voice transcription can confirm the reviewed action, without wrapper metadata', () => {
  const text = trustedVoiceIntentText('Voice message', [{ type: 'audio', success: true, transcript: 'Yes, confirm the withdrawal of 5 USD.' }]);
  expect(text).toBe('Yes, confirm the withdrawal of 5 USD.'); expect(isCommerceConfirmation(text)).toBe(true);
});
test('a typed refusal is not overridden by a spoken yes', () => {
  const text = trustedVoiceIntentText('No, wait', [{ type: 'audio', success: true, transcript: 'Yes' }]);
  expect(isCommerceConfirmation(text)).toBe(false);
});
test.each([[{ type: 'image', success: true, transcript: 'Yes' }], [{ type: 'audio', success: false, transcript: 'Yes' }],
  [{ type: 'audio', success: true, transcript: '' }], [{ type: 'audio', success: true, transcript: 'Yes' }, { type: 'image', success: true }]])('does not authorize financial actions from image/file/failed or ambiguous evidence', processed => {
  expect(trustedVoiceIntentText('', processed)).toBe(null);
});
