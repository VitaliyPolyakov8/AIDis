import type { z } from 'zod';
import { Errors } from './errors.js';

/** Parses untrusted input with a zod schema, throwing a VALIDATION_ERROR AppError on failure. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

// C0 control characters except TAB (0x09) and LF (0x0A), plus DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Normalises user-supplied text: CRLF -> LF, strips control characters and trims.
 * The text is stored as plain text; clients must render it as text, never as HTML.
 */
export function sanitizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
}

/** No control characters (C0, DEL, C1): for short display texts such as a custom status. */
export function isPrintable(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return false;
  }
  return true;
}
