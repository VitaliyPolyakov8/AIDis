import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { FRAME_FIT, FRAME_DEFAULT_SCALE, frameScale } = await import('./cosmetics/frameFit');
const { AVATAR_FRAMES } = await import('./cosmetics/catalog');
const { CHANGELOG, changelogFor, localized } = await import('./whatsNew/changelog');
const { shouldShowWhatsNew, useWhatsNewStore, WHATS_NEW_SEEN_KEY } = await import('./whatsNew/whatsNewStore');
const { WhatsNewDialog } = await import('./whatsNew/WhatsNew');
const { StyledName } = await import('./components/profile/StyledName');
const { usePresenceStore } = await import('./stores/presenceStore');
const { setLanguage } = await import('./i18n');
const { config } = await import('./config');
// Tests run with a fake client version; the release notes must match the real package version.
const { version } = (await import('../package.json')).default;

describe('0.5.6 frame sizes', () => {
  it('has a measured size for every shipped frame, all bigger than the avatar', () => {
    for (const frame of AVATAR_FRAMES) {
      expect(FRAME_FIT[frame.id], frame.id).toBeGreaterThan(1.1);
      expect(FRAME_FIT[frame.id], frame.id).toBeLessThan(1.8);
    }
    expect(frameScale('holographic_ring')).toBeGreaterThan(frameScale('fire_crown'));
    expect(frameScale('unknown')).toBe(FRAME_DEFAULT_SCALE);
    expect(frameScale(null)).toBe(FRAME_DEFAULT_SCALE);
  });
});

describe('0.5.6 what is new', () => {
  beforeEach(() => {
    localStorage.clear();
    useWhatsNewStore.setState({ open: false });
  });

  it('has notes for this version, newest first', () => {
    expect(CHANGELOG[0]?.version).toBe(version);
    expect(changelogFor(version)?.sections.length).toBeGreaterThan(0);
    expect(changelogFor('0.0.1')).toBeNull();
  });

  it('shows once per version and only when there are notes', () => {
    expect(shouldShowWhatsNew(version, null)).toBe(true);
    expect(shouldShowWhatsNew(version, '0.5.5')).toBe(true);
    expect(shouldShowWhatsNew(version, version)).toBe(false);
    expect(shouldShowWhatsNew('9.9.9', null)).toBe(false);
  });

  it('closing the window remembers the version', () => {
    useWhatsNewStore.getState().show();
    useWhatsNewStore.getState().hide();
    expect(localStorage.getItem(WHATS_NEW_SEEN_KEY)).toBe(config.clientVersion);
    expect(useWhatsNewStore.getState().open).toBe(false);
  });

  it('renders the notes in the UI language', () => {
    setLanguage('ru');
    // No notes for the fake test version: the newest notes are shown.
    const entry = CHANGELOG[0];
    let closed = false;
    render(<WhatsNewDialog onClose={() => (closed = true)} />);
    expect(screen.getByRole('dialog', { name: 'Что нового' })).toBeTruthy();
    expect(screen.getByText(localized(entry!.sections[0]!.items[0]!, 'ru'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
    expect(closed).toBe(true);
    expect(localized({ ru: 'а', en: 'b' }, 'de')).toBe('b');
  });
});

describe('0.5.6 styled names', () => {
  it('draws a name in the user style (gradient + font) and falls back to plain text', () => {
    usePresenceStore.setState({ users: { u1: { id: 'u1', displayName: 'Anna', nicknameColor: '#ff5577', nicknameColor2: '#55aaff', nicknameFont: 'lobster' } as never } });
    const { container, rerender } = render(<StyledName userId="u1" name="Anna" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('is-gradient');
    expect(span.className).toContain('has-font');
    expect(span.textContent).toBe('Anna');
    rerender(<StyledName userId="nobody" name="Bob" />);
    expect(container.querySelector('span')!.className).toBe('styled-name');
  });
});
