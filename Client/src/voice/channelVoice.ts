/**
 * 0.5.5 voice channel settings (set by channel managers, the same for everyone in the channel):
 * microphone bitrate and layout. The "room" layout is a 2D room: each person has a position, and
 * voices get quieter with distance (and pan left / right), so people can walk off and talk apart.
 */

/** Microphone bitrate steps (kbps), like Discord, plus 128 / 192 / 256 for music. */
export const VOICE_BITRATES = [8, 16, 24, 32, 48, 64, 80, 96, 128, 192, 256] as const;
export const DEFAULT_VOICE_BITRATE = 64;

export function bitrateIndex(kbps: number): number {
  const i = VOICE_BITRATES.findIndex((b) => b >= kbps);
  return i < 0 ? VOICE_BITRATES.length - 1 : i;
}

/** The microphone bitrate to publish with for a channel (bits per second). */
export function micBitrateBps(channelKbps: number | null | undefined): number {
  const kbps = typeof channelKbps === 'number' && Number.isFinite(channelKbps) ? Math.min(256, Math.max(8, Math.round(channelKbps))) : DEFAULT_VOICE_BITRATE;
  return kbps * 1000;
}

// ---- room layout ------------------------------------------------------------------------------

/** The room's own coordinate system (the view scales it to fit). */
export const ROOM_WIDTH = 1000;
export const ROOM_HEIGHT = 620;
/** Full volume up to this distance, silence from ROOM_SILENT_DISTANCE on. */
export const ROOM_FULL_DISTANCE = 160;
export const ROOM_SILENT_DISTANCE = 520;

export interface RoomPoint {
  x: number;
  y: number;
}

export function clampToRoom(p: RoomPoint): RoomPoint {
  return { x: Math.min(ROOM_WIDTH - 30, Math.max(30, p.x)), y: Math.min(ROOM_HEIGHT - 30, Math.max(30, p.y)) };
}

/**
 * Volume factor (0..1) and stereo pan (-1..1) of someone at `other` heard from `self`.
 * Smooth (quadratic) fade between the two distances. Pure (unit-tested).
 */
export function spatialMix(self: RoomPoint, other: RoomPoint): { gain: number; pan: number } {
  const dx = other.x - self.x;
  const dy = other.y - self.y;
  const distance = Math.hypot(dx, dy);
  let gain: number;
  if (distance <= ROOM_FULL_DISTANCE) gain = 1;
  else if (distance >= ROOM_SILENT_DISTANCE) gain = 0;
  else {
    const t = (distance - ROOM_FULL_DISTANCE) / (ROOM_SILENT_DISTANCE - ROOM_FULL_DISTANCE);
    gain = (1 - t) * (1 - t);
  }
  const pan = Math.max(-1, Math.min(1, dx / 300)) * 0.8;
  return { gain: Math.round(gain * 1000) / 1000, pan: Math.round(pan * 1000) / 1000 };
}

/** A stable starting spot for a user (spread around the middle), until they move. Pure. */
export function defaultSpot(userId: string): RoomPoint {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  const radius = 90 + ((hash >>> 8) % 80);
  return clampToRoom({ x: ROOM_WIDTH / 2 + Math.cos(angle) * radius, y: ROOM_HEIGHT / 2 + Math.sin(angle) * radius * 0.7 });
}
