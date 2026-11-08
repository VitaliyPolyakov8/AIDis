import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

const { bannerUrl, frameUrl, PROFILE_BANNERS, AVATAR_FRAMES, frameScale } = await import('./cosmetics/catalog');
const { Avatar } = await import('./components/Avatar');
const { PlatformIcons } = await import('./components/profile/PlatformIcons');
const { usePresenceStore } = await import('./stores/presenceStore');
const { phoneCameraLabel } = await import('./voice/camera');
const { setLanguage } = await import('./i18n');
const { config } = await import('./config');

describe('0.5.1 cosmetics catalog', () => {
  it('maps the 10 banners and 10 frames to the shipped files and ignores unknown ids', () => {
    expect(PROFILE_BANNERS).toHaveLength(10);
    expect(AVATAR_FRAMES).toHaveLength(10);
    expect(bannerUrl('aurora')).toBe('/cosmetics/banners/aurora.gif');
    expect(frameUrl('neon_pulse')).toBe('/cosmetics/frames/neon_pulse.webp');
    expect(bannerUrl('../../secret')).toBeNull();
    expect(frameUrl('<img onerror=1>')).toBeNull();
    expect(bannerUrl(null)).toBeNull();
  });
});

describe('0.5.1 avatar frames', () => {
  it('draws the user frame around the avatar (bigger, centred) and below the presence dot', () => {
    usePresenceStore.setState({ users: { u1: { id: 'u1', displayName: 'Anna', avatarFrameId: 'fire_crown' } as never } });
    const { container } = render(<Avatar userId="u1" name="Anna" size={40} status="online" />);
    const avatar = container.querySelector('.avatar');
    const frame = container.querySelector('.avatar-cosmetic-frame') as HTMLImageElement;
    expect(frame.getAttribute('src')).toBe('/cosmetics/frames/fire_crown.webp');
    // 0.5.6: each frame has its own size (its inner edge sits just outside the avatar).
    const scale = frameScale('fire_crown');
    expect(frame.style.width).toBe(`${40 * scale}px`);
    expect(frame.style.left).toBe(`${(40 - 40 * scale) / 2}px`);
    // Order: image/initials, frame, presence dot (dot drawn last = on top).
    const kids = [...(avatar?.children ?? [])].map((c) => c.className);
    expect(kids.indexOf('avatar-cosmetic-frame')).toBeLessThan(kids.findIndex((c) => c.includes('presence-dot')));
  });

  it('skips the frame on tiny avatars and when a preview asks for none', () => {
    usePresenceStore.setState({ users: { u1: { id: 'u1', displayName: 'Anna', avatarFrameId: 'fire_crown' } as never } });
    expect(render(<Avatar userId="u1" name="Anna" size={16} />).container.querySelector('.avatar-cosmetic-frame')).toBeNull();
    expect(render(<Avatar userId="u1" name="Anna" size={52} frame={false} />).container.querySelector('.avatar-cosmetic-frame')).toBeNull();
    expect(
      render(<Avatar userId="u1" name="Anna" size={52} frame="tech_hex" />)
        .container.querySelector('.avatar-cosmetic-frame')
        ?.getAttribute('src'),
    ).toBe('/cosmetics/frames/tech_hex.webp');
  });
});

describe('0.5.1 device icons', () => {
  it('shows one icon per active client kind with an accessible label, none when offline', () => {
    setLanguage('en');
    usePresenceStore.setState({ presence: { u1: { userId: 'u1', status: 'online', lastSeenAt: null, platforms: ['desktop', 'web', 'android'] } } });
    const { container, rerender } = render(<PlatformIcons userId="u1" />);
    expect([...container.querySelectorAll('.platform-icon')].map((e) => e.getAttribute('aria-label'))).toEqual(['Connected via Desktop app', 'Connected via Web', 'Connected via Android']);
    expect([...container.querySelectorAll('.platform-icon')].map((e) => e.getAttribute('title'))).toEqual(['Desktop app', 'Web', 'Android']);
    usePresenceStore.setState({ presence: { u1: { userId: 'u1', status: 'offline', lastSeenAt: null, platforms: [] } } });
    rerender(<PlatformIcons userId="u1" />);
    expect(container.querySelector('.platform-icons')).toBeNull();
  });

  it('the web build identifies itself as web (never guessed from the user agent)', () => {
    expect(config.platform).toBe('web');
  });
});

describe('0.5.1 Android camera names', () => {
  it('turns Android camera labels into Front / Rear camera', () => {
    document.documentElement.lang = 'en';
    expect(phoneCameraLabel('camera2 1, facing front')).toBe('Front camera');
    expect(phoneCameraLabel('camera 0, facing back')).toBe('Rear camera');
    expect(phoneCameraLabel('Logitech C920')).toBeNull();
  });
});
