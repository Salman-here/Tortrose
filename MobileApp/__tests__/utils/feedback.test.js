const Feedback = require('../../src/utils/feedback').default;
const { normalize } = require('../../src/utils/feedback');

describe('premium in-app feedback', () => {
  test('normalizes the legacy message shape without exposing the toast package', () => {
    expect(normalize({
      type: 'error',
      text1: 'Checkout unavailable',
      text2: 'Try again shortly.',
    })).toEqual(expect.objectContaining({
      type: 'error',
      title: 'Checkout unavailable',
      message: 'Try again shortly.',
      duration: 6500,
    }));
  });

  test('publishes notices to the app-level feedback host', () => {
    const listener = jest.fn();
    const unsubscribe = Feedback.subscribe(listener);

    Feedback.show({ type: 'success', text1: 'Saved' });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      title: 'Saved',
    }));

    unsubscribe();
  });

  test('falls back to safe information messaging for unknown types', () => {
    expect(normalize({ type: 'custom' })).toEqual(expect.objectContaining({
      type: 'info',
      title: 'Update',
    }));
  });
});
