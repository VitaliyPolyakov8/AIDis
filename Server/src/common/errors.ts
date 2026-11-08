/**
 * Every API error is returned as:
 *   { "error": { "code": "SOME_CODE", "message": "Human readable text", "details"?: ... } }
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details?: unknown) => new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details),
  badRequest: (code: string, message: string) => new AppError(400, code, message),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  invalidRefreshToken: () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired'),
  refreshTokenReused: () => new AppError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token was already used; the session has been revoked'),
  accountDisabled: () => new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled'),
  /** 0.7.1: registered, but the e-mail is not confirmed yet. */
  emailNotVerified: () => new AppError(403, 'EMAIL_NOT_VERIFIED', 'Confirm your e-mail first: open the link from the letter'),
  forbidden: (message = 'You are not allowed to perform this action') => new AppError(403, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  /** 0.7.0: a server that does not exist or that the caller is not a member of (never reveals which). */
  guildNotFound: () => new AppError(404, 'GUILD_NOT_FOUND', 'Server not found'),
  /** 0.7.0: a configurable limit (see limits/catalog.ts) was reached. */
  limitReached: (key: string, limit: number) => new AppError(400, 'LIMIT_REACHED', `Limit reached: ${key} (${limit})`, { key, limit }),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  payloadTooLarge: (message = 'Payload too large') => new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  rateLimited: (message = 'Too many requests, please slow down') => new AppError(429, 'RATE_LIMITED', message),
  serviceUnavailable: (code: string, message: string) => new AppError(503, code, message),
};
