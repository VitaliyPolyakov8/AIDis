/**
 * Avatar image checks (0.3.0). The real format is read from the file's bytes (never trusted from the
 * client's MIME type) together with its pixel size and whether it is animated, so an avatar cannot
 * be a huge or oversized animation that would cost every client memory and CPU.
 */
export type AvatarFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageInfo {
  format: AvatarFormat;
  width: number;
  height: number;
  animated: boolean;
}

export const AVATAR_LIMITS = {
  /** Bytes. */
  maxStaticSize: 8 * 1024 * 1024,
  maxAnimatedSize: 8 * 1024 * 1024,
  maxStaticSide: 4096,
  maxAnimatedSide: 1024,
} as const;

const MIME: Record<AvatarFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function mimeForFormat(format: AvatarFormat): string {
  return MIME[format];
}

function gifFrames(b: Buffer): number {
  // Walks the GIF block structure and counts image descriptors (0x2C).
  let p = 13;
  const flags = b[10] ?? 0;
  if (flags & 0x80) p += 3 * 2 ** ((flags & 0x07) + 1);
  let frames = 0;
  while (p < b.length) {
    const block = b[p];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      p += 2; // extension introducer + label
      while (p < b.length && b[p] !== 0) p += (b[p] ?? 0) + 1;
      p += 1;
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return frames;
      const local = b[p + 9] ?? 0;
      p += 10;
      if (local & 0x80) p += 3 * 2 ** ((local & 0x07) + 1);
      p += 1; // LZW minimum code size
      while (p < b.length && b[p] !== 0) p += (b[p] ?? 0) + 1;
      p += 1;
    } else {
      break;
    }
  }
  return frames;
}

/** Parses the header of PNG / JPEG / GIF / WebP. Returns null for anything else or a broken file. */
export function parseImageInfo(b: Buffer): ImageInfo | null {
  if (b.length < 16) return null;
  // PNG
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    if (b.toString('latin1', 12, 16) !== 'IHDR' || b.length < 24) return null;
    // APNG: an acTL chunk before the first IDAT.
    let animated = false;
    for (let p = 8; p + 8 <= b.length; ) {
      const len = b.readUInt32BE(p);
      const type = b.toString('latin1', p + 4, p + 8);
      if (type === 'acTL') animated = true;
      if (type === 'IDAT' || type === 'IEND') break;
      p += 12 + len;
    }
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), animated };
  }
  // GIF
  const head = b.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') {
    return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8), animated: gifFrames(b) > 1 };
  }
  // WebP (RIFF....WEBP)
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' && b.length >= 30) {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      const animated = ((b[20] ?? 0) & 0x02) !== 0;
      const width = 1 + b.readUIntLE(24, 3);
      const height = 1 + b.readUIntLE(27, 3);
      return { format: 'webp', width, height, animated };
    }
    if (chunk === 'VP8 ') {
      return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, animated: false };
    }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
    }
    return null;
  }
  // JPEG: scan markers for a start-of-frame segment.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null;
      const marker = b[p + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        p += 2;
        continue;
      }
      const len = b.readUInt16BE(p + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { format: 'jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7), animated: false };
      p += 2 + len;
    }
    return null;
  }
  return null;
}

/** 0.4.0 profile banners: wide images, a bit more room than avatars. */
export const BANNER_LIMITS = {
  maxStaticSize: 10 * 1024 * 1024,
  maxAnimatedSize: 8 * 1024 * 1024,
  maxStaticWidth: 4096,
  maxStaticHeight: 2048,
  maxAnimatedWidth: 1600,
} as const;

export function checkBanner(info: ImageInfo | null, size: number): AvatarProblem | null {
  if (!info) return 'format';
  if (size > (info.animated ? BANNER_LIMITS.maxAnimatedSize : BANNER_LIMITS.maxStaticSize)) return 'size';
  if (info.animated) {
    if (info.width > BANNER_LIMITS.maxAnimatedWidth || info.height > BANNER_LIMITS.maxStaticHeight) return 'dimensions';
  } else if (info.width > BANNER_LIMITS.maxStaticWidth || info.height > BANNER_LIMITS.maxStaticHeight) return 'dimensions';
  return null;
}

export type AvatarProblem = 'format' | 'size' | 'dimensions';

/** Null when the image is acceptable as an avatar. */
export function checkAvatar(info: ImageInfo | null, size: number): AvatarProblem | null {
  if (!info || info.width < 1 || info.height < 1) return 'format';
  if (size > (info.animated ? AVATAR_LIMITS.maxAnimatedSize : AVATAR_LIMITS.maxStaticSize)) return 'size';
  const side = info.animated ? AVATAR_LIMITS.maxAnimatedSide : AVATAR_LIMITS.maxStaticSide;
  if (info.width > side || info.height > side) return 'dimensions';
  return null;
}
