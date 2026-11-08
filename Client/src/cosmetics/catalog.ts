/**
 * 0.5.1 built-in profile cosmetics: the animated banners and avatar frames shipped in
 * public/cosmetics (the original files, unchanged). The server stores only these ids.
 * GIF banners and animated WebP frames animate natively in every client (web, desktop, Android
 * WebView); nothing is re-rendered per frame by JavaScript.
 */
export const PROFILE_BANNERS = [
  { id: 'aurora', name: 'Aurora' },
  { id: 'nebula', name: 'Nebula' },
  { id: 'synthwave_grid', name: 'Synthwave' },
  { id: 'plasma', name: 'Plasma' },
  { id: 'starfall', name: 'Starfall' },
  { id: 'cyber_rain', name: 'Cyber rain' },
  { id: 'electric_storm', name: 'Electric storm' },
  { id: 'liquid_chrome', name: 'Liquid chrome' },
  { id: 'sunset_waves', name: 'Sunset waves' },
  { id: 'prism_scan', name: 'Prism scan' },
] as const;

export const AVATAR_FRAMES = [
  { id: 'neon_pulse', name: 'Neon pulse' },
  { id: 'orbit_sparks', name: 'Orbit sparks' },
  { id: 'holographic_ring', name: 'Holographic ring' },
  { id: 'tech_hex', name: 'Tech hex' },
  { id: 'fire_crown', name: 'Fire crown' },
  { id: 'frost_shards', name: 'Frost shards' },
  { id: 'sakura_petals', name: 'Sakura petals' },
  { id: 'cosmic_orbit', name: 'Cosmic orbit' },
  { id: 'rainbow_equalizer', name: 'Rainbow equalizer' },
  { id: 'arcane_sigils', name: 'Arcane sigils' },
] as const;

export type ProfileBannerId = (typeof PROFILE_BANNERS)[number]['id'];
export type AvatarFrameId = (typeof AVATAR_FRAMES)[number]['id'];

const BANNER_IDS = new Set<string>(PROFILE_BANNERS.map((b) => b.id));
const FRAME_IDS = new Set<string>(AVATAR_FRAMES.map((f) => f.id));

/** Asset base: '/' on the web, 'aidis://app/' in the desktop app, the WebView root on Android. */
function base(): string {
  return import.meta.env.BASE_URL;
}

/** URL of a known banner (unknown ids from a newer server are ignored, never turned into paths). */
export function bannerUrl(id: string | null | undefined): string | null {
  return id && BANNER_IDS.has(id) ? `${base()}cosmetics/banners/${id}.gif` : null;
}

export function frameUrl(id: string | null | undefined): string | null {
  return id && FRAME_IDS.has(id) ? `${base()}cosmetics/frames/${id}.webp` : null;
}

/** The frame image is drawn this much larger than the avatar, centred (it goes AROUND the avatar). */
export const FRAME_SCALE = 1.3;

export { FRAME_FIT, frameScale } from './frameFit';
/** Below this avatar size the frame is not drawn (too small to read, visual noise in dense lists). */
export const FRAME_MIN_SIZE = 20;
