import { hash, verify, type Algorithm } from '@node-rs/argon2';

// Algorithm is an ambient const enum in @node-rs/argon2; 2 === Algorithm.Argon2id.
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- const enum cannot be imported here
const ARGON2ID = 2 as Algorithm;

/**
 * Argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations).
 * The algorithm and parameters are encoded in the hash string, so they can be
 * raised later without invalidating existing hashes.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a verification against a throwaway hash so that "unknown user" takes
 * about as long as "wrong password" (prevents username enumeration by timing).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('aidis-timing-equaliser');
  await verifyPassword(await dummyHash, password);
}
