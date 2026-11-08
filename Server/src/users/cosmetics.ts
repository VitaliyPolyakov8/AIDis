/**
 * 0.5.1 built-in profile cosmetics (the files ship with the clients under /cosmetics/...). The
 * server stores only these identifiers: never a path, URL, HTML or CSS.
 */
export const PROFILE_BANNER_IDS = [
  'aurora',
  'nebula',
  'synthwave_grid',
  'plasma',
  'starfall',
  'cyber_rain',
  'electric_storm',
  'liquid_chrome',
  'sunset_waves',
  'prism_scan',
] as const;

export const AVATAR_FRAME_IDS = [
  'neon_pulse',
  'orbit_sparks',
  'holographic_ring',
  'tech_hex',
  'fire_crown',
  'frost_shards',
  'sakura_petals',
  'cosmic_orbit',
  'rainbow_equalizer',
  'arcane_sigils',
] as const;

export type ProfileBannerId = (typeof PROFILE_BANNER_IDS)[number];
export type AvatarFrameId = (typeof AVATAR_FRAME_IDS)[number];
