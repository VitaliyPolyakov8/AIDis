/** Fallback for a frame id this build does not know (same as the 0.5.1 size). */
export const FRAME_DEFAULT_SCALE = 1.3;

/**
 * 0.5.6: per-frame size. The frame files have very different inner holes (161-224 px of 512), so
 * one scale made some frames cover the face and left a gap around others. Each value puts the
 * frame's inner edge just outside the avatar (hole radius = 1.04 x avatar radius), measured on the
 * files themselves (10th percentile of the hole radius over 72 directions and several frames).
 */
export const FRAME_FIT: Readonly<Record<string, number>> = {
  arcane_sigils: 1.643,
  cosmic_orbit: 1.274,
  fire_crown: 1.189,
  frost_shards: 1.189,
  holographic_ring: 1.654,
  neon_pulse: 1.643,
  orbit_sparks: 1.199,
  rainbow_equalizer: 1.312,
  sakura_petals: 1.53,
  tech_hex: 1.487,
};

export function frameScale(id: string | null | undefined): number {
  return (id ? FRAME_FIT[id] : undefined) ?? FRAME_DEFAULT_SCALE;
}
