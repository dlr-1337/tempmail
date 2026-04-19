import { render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CopyButton from './CopyButton.svelte';

describe('CopyButton', () => {
  const origClipboard = navigator.clipboard;

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: origClipboard,
      configurable: true
    });
  });

  it('renders the default label', () => {
    render(CopyButton, { text: 'hello@tempmail' });
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
  });

  it('calls clipboard.writeText with the prop text', async () => {
    render(CopyButton, { text: 'hello@tempmail' });
    const btn = screen.getByRole('button', { name: /copy/i });
    await fireEvent.click(btn);
    expect((navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'hello@tempmail'
    );
  });
});
