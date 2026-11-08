import { z } from 'zod';
import { isPrintable, sanitizeText } from '../common/validation.js';

/** 0.7.0 server nickname: up to 32 printable characters; null or '' clears it. */
export const nickname = z.string().transform(sanitizeText).pipe(z.string().max(32, 'Nickname must be at most 32 characters').refine(isPrintable, 'Nickname contains invalid characters')).nullable();
