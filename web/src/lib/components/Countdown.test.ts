import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Countdown from './Countdown.svelte';

describe('Countdown', () => {
  it('renders mm:ss from expiresAt vs now', () => {
    const now = Date.parse('2026-04-18T12:00:00Z');
    const expiresAt = new Date(now + 90_000).toISOString();
    const { container } = render(Countdown, { expiresAt, now });
    expect(container.textContent).toContain('01:30');
  });

  it('clamps to 00:00 when expired', () => {
    const now = Date.parse('2026-04-18T12:00:00Z');
    const expiresAt = new Date(now - 5000).toISOString();
    const { container } = render(Countdown, { expiresAt, now });
    expect(container.textContent).toContain('00:00');
  });

  it('renders 00:00 when expiresAt is null', () => {
    const { container } = render(Countdown, { expiresAt: null, now: Date.now() });
    expect(container.textContent).toContain('00:00');
  });
});
