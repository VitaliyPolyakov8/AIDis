import { getLanguage, i18next, t } from '../i18n';
import type { ApiErrorBody } from './types';

export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'aborted';

/**
 * Every failure of the request layer is an ApiError. `code` is the server's error code
 * (INVALID_CREDENTIALS, RATE_LIMITED, ...) or a client-side one (NETWORK_ERROR, TIMEOUT,
 * SESSION_EXPIRED). Components show `friendlyError(err)` instead of raw server text.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(kind: ApiErrorKind, status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static network(): ApiError {
    return new ApiError('network', 0, 'NETWORK_ERROR', 'Network request failed');
  }

  static timeout(): ApiError {
    return new ApiError('timeout', 0, 'TIMEOUT', 'Request timed out');
  }

  static aborted(): ApiError {
    return new ApiError('aborted', 0, 'ABORTED', 'Request was cancelled');
  }

  static sessionExpired(): ApiError {
    return new ApiError('http', 401, 'SESSION_EXPIRED', 'Session expired');
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const inner = value.error;
  return typeof inner === 'object' && inner !== null && 'code' in inner && typeof inner.code === 'string';
}

function defaultCodeForStatus(status: number): string {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502 || status === 503 || status === 504) return 'SERVER_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

/** Builds an ApiError from a non-2xx response body (already parsed, may be anything). */
export function errorFromResponse(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    return new ApiError('http', status, body.error.code, body.error.message, body.error.details);
  }
  // A proxy (Nginx) answering 502/504 while the backend restarts returns HTML, not JSON.
  return new ApiError('http', status, defaultCodeForStatus(status), `HTTP ${status}`);
}

/** A short, human, localized message for any error. Never exposes raw JSON or server text. */
export function friendlyError(error: unknown, fallback?: string): string {
  const fb = fallback ?? t('errors.fallback');
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR') {
      const first = Array.isArray(error.details) ? (error.details[0] as { message?: unknown } | undefined) : undefined;
      // Server validation messages are English only; show them in English UI, a generic hint otherwise.
      return typeof first?.message === 'string' && getLanguage() === 'en' ? first.message : t('errors.validation');
    }
    // 0.7.0: "Limit reached for channels on the server: 50." when the server says which limit.
    if (error.code === 'LIMIT_REACHED') {
      const details = error.details as { key?: unknown; limit?: unknown } | undefined;
      const whatKey = typeof details?.key === 'string' ? `limits.keys.${details.key.replace(/\./g, '_')}` : null;
      if (whatKey && i18next.exists(whatKey) && typeof details?.limit === 'number') return t('limits.reached', { what: t(whatKey), limit: details.limit });
    }
    const key = `errors.${error.code}`;
    return i18next.exists(key) ? t(key) : fb;
  }
  return fb;
}
