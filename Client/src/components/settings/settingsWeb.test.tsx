import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsModal } from './SettingsModal';
import { isDesktop } from '../../desktop/bridge';
import { config } from '../../config';

describe('settings in the browser', () => {
  it('does not detect the desktop app and hides desktop-only sections', () => {
    expect(isDesktop).toBe(false);
    expect(config.clientType).toBe('web');
    render(<SettingsModal />);
    expect(screen.getByRole('tab', { name: 'Voice & audio' })).toBeInTheDocument();
    for (const name of ['Streaming', 'Keybinds', 'Desktop']) expect(screen.queryByRole('tab', { name })).toBeNull();
  });
});
