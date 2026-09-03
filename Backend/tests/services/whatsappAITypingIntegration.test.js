'use strict';

const mockBuyerSendText = jest.fn();
const mockBuyerClient = {
    isConfigured: jest.fn(() => true),
    sendText: mockBuyerSendText,
    sendMedia: jest.fn(),
    sendChatPresence: jest.fn(),
};
const mockSellerClient = {
    isConfigured: jest.fn(() => true),
    sendText: jest.fn(),
    sendMedia: jest.fn(),
    sendChatPresence: jest.fn(),
};
const mockStopTyping = jest.fn();
const mockStartTypingPresence = jest.fn(() => ({ stop: mockStopTyping }));

jest.mock('../../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../../models/AdminWhatsAppNumber', () => ({ findOne: jest.fn() }));
jest.mock('../../models/WhatsAppAIChatRateLimit', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../models/ChatHistory', () => ({ findOne: jest.fn() }));
jest.mock('../../controllers/aiChatController', () => ({ processAIChatMessage: jest.fn() }));
jest.mock('../../services/aiAttachmentService', () => ({ processChatAttachments: jest.fn() }));
jest.mock('../../services/whatsapp/evolutionClient', () => mockBuyerClient);
jest.mock('../../services/whatsapp/sellerEvolutionClient', () => mockSellerClient);
jest.mock('../../services/whatsapp/typingPresence', () => ({
    startTypingPresence: (...args) => mockStartTypingPresence(...args),
}));
jest.mock('../../services/whatsapp/jidRoutingStore', () => ({
    resolveOutboundRecipient: jest.fn(async (_phone, requested) => requested),
}));
jest.mock('../../services/whatsappIdentityService', () => ({
    findWhatsAppIdentityConflict: jest.fn().mockResolvedValue(null),
}));

const User = require('../../models/User');
const WhatsAppAIChatRateLimit = require('../../models/WhatsAppAIChatRateLimit');
const ChatHistory = require('../../models/ChatHistory');
const { processAIChatMessage } = require('../../controllers/aiChatController');
const { processChatAttachments } = require('../../services/aiAttachmentService');
const {
    _processIncomingWhatsAppMessageNow,
} = require('../../services/whatsapp/whatsappAIChatService');

const queryWithSelect = value => ({
    select: jest.fn().mockResolvedValue(value),
});

describe('WhatsApp AI typing integration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBuyerSendText.mockResolvedValue({ messageId: 'reply-1' });
        User.findOne.mockReturnValue(queryWithSelect({
            _id: 'buyer-1',
            role: 'user',
            status: 'active',
            username: 'Buyer',
            whatsappInfo: { number: '+923001112222', verified: true },
        }));
        WhatsAppAIChatRateLimit.findOneAndUpdate.mockResolvedValue({
            messageCount: 1,
            windowStart: new Date(),
        });
        ChatHistory.findOne.mockResolvedValue(null);
        processChatAttachments.mockResolvedValue({
            context: '',
            attachments: [],
            processed: [],
        });
        processAIChatMessage.mockResolvedValue({ responseText: 'Fast AI reply' });
    });

    test('wraps genuine AI work but stops presence before sending the reply', async () => {
        const recipient = '923001112222@s.whatsapp.net';

        await _processIncomingWhatsAppMessageNow(
            '923001112222',
            'Hello',
            'main',
            [],
            { replyTo: recipient, messageId: 'message-1' }
        );

        expect(mockStartTypingPresence).toHaveBeenCalledWith({
            client: mockBuyerClient,
            recipient,
        });
        expect(mockStopTyping).toHaveBeenCalledTimes(1);
        expect(mockBuyerSendText).toHaveBeenCalledWith(recipient, 'Fast AI reply');
        expect(mockStopTyping.mock.invocationCallOrder[0])
            .toBeLessThan(mockBuyerSendText.mock.invocationCallOrder[0]);
    });

    test('does not start typing for an immediate rate-limit response', async () => {
        WhatsAppAIChatRateLimit.findOneAndUpdate.mockResolvedValue({
            messageCount: 31,
            windowStart: new Date(),
        });

        await _processIncomingWhatsAppMessageNow(
            '923001112222',
            'Hello again',
            'main',
            [],
            { replyTo: '923001112222@s.whatsapp.net' }
        );

        expect(mockStartTypingPresence).not.toHaveBeenCalled();
        expect(processAIChatMessage).not.toHaveBeenCalled();
        expect(mockBuyerSendText).toHaveBeenCalledTimes(1);
    });

    test('still sends the AI reply if typing setup unexpectedly fails', async () => {
        mockStartTypingPresence.mockImplementationOnce(() => {
            throw new Error('presence setup failed');
        });

        await _processIncomingWhatsAppMessageNow(
            '923001112222',
            'Hello',
            'main',
            [],
            { replyTo: '923001112222@s.whatsapp.net' }
        );

        expect(processAIChatMessage).toHaveBeenCalledTimes(1);
        expect(mockBuyerSendText).toHaveBeenCalledWith(
            '923001112222@s.whatsapp.net',
            'Fast AI reply'
        );
    });
});
