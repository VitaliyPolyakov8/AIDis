import { uploadAttachment } from '../../api/attachments';

/** Same rules as avatars on the server: PNG, JPEG, GIF or WebP, up to 8 MB. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageProblem = 'type' | 'size' | null;

export function checkImage(file: File): ImageProblem {
  if (!IMAGE_TYPES.includes(file.type)) return 'type';
  if (file.size > MAX_IMAGE_BYTES) return 'size';
  return null;
}

/** Uploads a server icon / banner / profile image and returns its attachment id. */
export async function uploadImage(file: File): Promise<string> {
  const attachment = await uploadAttachment(file, () => undefined).promise;
  return attachment.id;
}
