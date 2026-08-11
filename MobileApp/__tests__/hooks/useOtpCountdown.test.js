import { formatOtpCountdown, secondsUntil } from '../../src/hooks/useOtpCountdown';

describe('OTP countdown contract', () => {
  it('derives remaining time from a deadline so background time cannot pause it', () => {
    expect(secondsUntil(130_000, 10_000)).toBe(120);
    expect(secondsUntil(10_001, 10_000)).toBe(1);
    expect(secondsUntil(9_999, 10_000)).toBe(0);
  });

  it('formats expiry independently from resend cooldown', () => {
    expect(formatOtpCountdown(600)).toBe('10:00');
    expect(formatOtpCountdown(120)).toBe('2:00');
    expect(formatOtpCountdown(29)).toBe('0:29');
    expect(formatOtpCountdown(-5)).toBe('0:00');
  });
});
