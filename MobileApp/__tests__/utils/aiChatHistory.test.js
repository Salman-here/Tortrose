import {
  formatConversationTimestamp,
  getConversationGroupLabel,
  groupConversationSessions,
  normalizeChatHistoryMessage,
} from '../../src/utils/aiChatHistory';

describe('AI chat history utilities', () => {
  const now = new Date('2035-06-15T12:00:00.000Z');

  it('groups, sorts, and searches conversation summaries', () => {
    const conversations = [
      {
        _id: 'older',
        title: 'Summer style ideas',
        preview: 'Try a linen overshirt',
        messageCount: 4,
        lastActive: '2035-06-07T12:00:00.000Z',
        source: 'web',
      },
      {
        _id: 'recent',
        title: 'Order help',
        preview: 'Your parcel is on the way',
        messageCount: 2,
        lastActive: '2035-06-15T11:45:00.000Z',
        source: 'mobile',
      },
      {
        _id: 'yesterday',
        title: 'Wedding outfit',
        preview: 'A navy suit would work well',
        messageCount: 6,
        lastActive: '2035-06-14T10:00:00.000Z',
      },
    ];

    const sections = groupConversationSessions(conversations, '', now);
    expect(sections.map(section => section.title)).toEqual(['Today', 'Yesterday', 'This Month']);
    expect(sections[0].data[0]).toEqual(expect.objectContaining({
      _id: 'recent',
      source: 'mobile',
    }));

    const searched = groupConversationSessions(conversations, 'linen', now);
    expect(searched).toHaveLength(1);
    expect(searched[0].data.map(conversation => conversation._id)).toEqual(['older']);
  });

  it('formats stable group and relative-time labels', () => {
    expect(getConversationGroupLabel('2035-06-15T08:00:00.000Z', now)).toBe('Today');
    expect(getConversationGroupLabel('2035-06-14T08:00:00.000Z', now)).toBe('Yesterday');
    expect(formatConversationTimestamp('2035-06-15T11:45:00.000Z', now)).toBe('15m ago');
    expect(formatConversationTimestamp('2035-06-13T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('restores persisted attachments and safe visual tool results', () => {
    const message = normalizeChatHistoryMessage({
      _id: 'message-1',
      role: 'assistant',
      content: 'Here is a complete look.',
      attachments: [{ type: 'image', url: 'https://example.com/look.jpg', name: 'Look' }],
      toolEvents: [
        { type: 'tool_result', tool: 'search_products', result: { success: true } },
        { type: 'client_action', action: 'show_style_advice', args: { occasion: 'Dinner' } },
        { type: 'client_action', action: 'navigate', args: { route: '/orders' } },
      ],
    }, 0, 'conversation-1');

    expect(message).toEqual(expect.objectContaining({
      id: 'message-1',
      role: 'assistant',
      attachments: [expect.objectContaining({
        id: 'conversation-1-0-attachment-0',
        url: 'https://example.com/look.jpg',
      })],
      toolResults: [
        { name: 'search_products', result: { success: true } },
        { name: 'show_style_advice', result: { styleAdvice: { occasion: 'Dinner' } } },
      ],
    }));
  });
});
