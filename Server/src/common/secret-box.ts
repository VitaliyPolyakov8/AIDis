import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * 0.7.1: secrets the superadmin types into the app (voice node API secrets, the SMTP password) are
 * stored sealed with AES-256-GCM. The key is derived from the server secret (JWT_ACCESS_SECRET), like
 * the games hub keys, so no new .env setting is needed. Changing that secret means re-entering these.
 * Format: base64(iv 12 bytes | auth tag 16 bytes | ciphertext).
 */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function createSecretBox(serverSecret: string): SecretBox {
  const key = createHmac('sha256', serverSecret).update('aidis-secrets-v1').digest();
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    open(sealed) {
      const raw = Buffer.from(sealed, 'base64');
      if (raw.length < 28) throw new Error('Sealed value is too short');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
