import { visibleAIUserMessage, chatAttachmentDisplayType } from '../../src/utils/aiChatPresentation';

test('hides internal photo metadata from a user bubble without changing ordinary text', () => {
  const stored = 'Add my travel mug\n\n[Attached product image: https://example.com/mug.png]';
  expect(visibleAIUserMessage(stored)).toBe('Add my travel mug');
  expect(stored).toContain('[Attached product image:');
  expect(visibleAIUserMessage('Keep [special edition] in the title')).toBe('Keep [special edition] in the title');
});
test.each(['image', 'image/png', 'image/jpeg'])('renders saved and freshly uploaded %s attachments as pictures', type => {
  expect(chatAttachmentDisplayType({ type })).toBe('image');
});
test.each(['audio', 'audio/mp4'])('preserves audio attachment presentation: %s', type => {
  expect(chatAttachmentDisplayType({ type })).toBe('audio');
});
