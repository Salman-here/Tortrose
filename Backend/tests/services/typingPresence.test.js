'use strict';

const { startTypingPresence } = require('../../services/whatsapp/typingPresence');

const ENV_KEYS = [
    'WHATSAPP_AI_TYPING_ENABLED',
    'WHATSAPP_AI_TYPING_START_DELAY_MS',
    'WHATSAPP_AI_TYPING_PULSE_MS',
    'WHATSAPP_AI_TYPING_MAX_MS',
];

const flushPromises = async () => {
    for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
    }
};

describe('WhatsApp AI typing presence lifecycle', () => {
    let savedEnv;

    beforeEach(() => {
        jest.useFakeTimers();
        savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
        process.env.WHATSAPP_AI_TYPING_ENABLED = 'true';
        process.env.WHATSAPP_AI_TYPING_START_DELAY_MS = '500';
        process.env.WHATSAPP_AI_TYPING_PULSE_MS = '2000';
        process.env.WHATSAPP_AI_TYPING_MAX_MS = '5000';
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        ENV_KEYS.forEach((key) => {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        });
    });

    test('does not show typing when work finishes before the threshold', async () => {
        const sendChatPresence = jest.fn().mockResolvedValue({});
        const indicator = startTypingPresence({
            client: { sendChatPresence },
            recipient: '923001112222@s.whatsapp.net',
        });

        indicator.stop();
        jest.advanceTimersByTime(10_000);
        await flushPromises();

        expect(sendChatPresence).not.toHaveBeenCalled();
    });

    test('shows composing only during real processing and clears without blocking', async () => {
        const sendChatPresence = jest.fn().mockResolvedValue({});
        const indicator = startTypingPresence({
            client: { sendChatPresence },
            recipient: '923001112222@s.whatsapp.net',
        });

        jest.advanceTimersByTime(499);
        await flushPromises();
        expect(sendChatPresence).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await flushPromises();
        expect(sendChatPresence).toHaveBeenCalledWith(
            '923001112222@s.whatsapp.net',
            { presence: 'composing', delay: 2000 }
        );

        indicator.stop();
        await flushPromises();
        expect(sendChatPresence).toHaveBeenLastCalledWith(
            '923001112222@s.whatsapp.net',
            { presence: 'paused', delay: 0 }
        );
    });

    test('renews finite typing pulses only while work is active', async () => {
        const sendChatPresence = jest.fn((_recipient, { presence, delay }) => {
            if (presence === 'paused') return Promise.resolve({});
            return new Promise(resolve => setTimeout(() => resolve({}), delay));
        });
        const indicator = startTypingPresence({
            client: { sendChatPresence },
            recipient: '923001112222@s.whatsapp.net',
        });

        jest.advanceTimersByTime(500);
        await flushPromises();
        expect(sendChatPresence).toHaveBeenCalledTimes(1);

        // No second request can overlap the first finite Evolution pulse.
        jest.advanceTimersByTime(1999);
        await flushPromises();
        expect(sendChatPresence).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(1);
        await flushPromises();
        jest.advanceTimersByTime(250);
        await flushPromises();
        expect(sendChatPresence).toHaveBeenCalledTimes(2);

        indicator.stop();
        await flushPromises();
        const callsAfterStop = sendChatPresence.mock.calls.length;
        jest.advanceTimersByTime(10_000);
        await flushPromises();
        expect(sendChatPresence).toHaveBeenCalledTimes(callsAfterStop);
    });

    test('isolates provider failures and stops retrying presence', async () => {
        const sendChatPresence = jest.fn().mockRejectedValue(new Error('presence offline'));
        const logger = { warn: jest.fn() };
        const indicator = startTypingPresence({
            client: { sendChatPresence },
            recipient: '923001112222@s.whatsapp.net',
            logger,
        });

        jest.advanceTimersByTime(500);
        await flushPromises();
        jest.advanceTimersByTime(10_000);
        await flushPromises();

        expect(sendChatPresence).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(() => indicator.stop()).not.toThrow();
    });

    test('can be disabled without changing the AI flow', async () => {
        process.env.WHATSAPP_AI_TYPING_ENABLED = 'false';
        const sendChatPresence = jest.fn();
        const indicator = startTypingPresence({
            client: { sendChatPresence },
            recipient: '923001112222@s.whatsapp.net',
        });

        indicator.stop();
        jest.advanceTimersByTime(10_000);
        await flushPromises();
        expect(sendChatPresence).not.toHaveBeenCalled();
    });
});
