import { apiUrl } from '../config';
import { getValidAccessToken, refreshAccessToken, request, requestBlob } from './client';
import { ApiError, errorFromResponse } from './errors';
import type { Attachment } from './types';

export interface UploadHandle {
  promise: Promise<Attachment>;
  abort: () => void;
  /** 0.5.5 resumable uploads: stop sending but keep what arrived (the same file continues later). */
  suspend?: () => void;
}

/**
 * 0.5.5: files above this size go through the resumable upload (pieces of 8 MiB, up to 5 GiB);
 * smaller ones keep the single multipart request.
 */
export const LARGE_UPLOAD_THRESHOLD = 40 * 1024 * 1024;
/** 0.5.5: the largest file the resumable upload accepts (the server may be configured lower). */
export const MAX_LARGE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/** Uploads one file: small files in one request, large ones in resumable pieces (0.5.5). */
export function uploadAttachment(file: File, onProgress: (fraction: number) => void, onRetry?: (waitingMs: number) => void): UploadHandle {
  return file.size > LARGE_UPLOAD_THRESHOLD ? uploadLarge(file, onProgress, onRetry) : uploadSmall(file, onProgress);
}

/** One multipart request. XHR is used because fetch has no upload progress. */
function uploadSmall(file: File, onProgress: (fraction: number) => void): UploadHandle {
  let xhr: XMLHttpRequest | null = null;
  const state = { aborted: false };

  const attempt = (token: string): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const req = new XMLHttpRequest();
      xhr = req;
      req.open('POST', apiUrl('/api/v1/attachments'));
      req.setRequestHeader('Authorization', `Bearer ${token}`);
      req.responseType = 'json';
      req.timeout = 30 * 60 * 1000;
      req.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      req.onload = () => {
        resolve({ status: req.status, body: req.response as unknown });
      };
      req.onerror = () => {
        reject(ApiError.network());
      };
      req.ontimeout = () => {
        reject(ApiError.timeout());
      };
      req.onabort = () => {
        reject(ApiError.aborted());
      };
      const form = new FormData();
      form.append('file', file, file.name);
      req.send(form);
    });

  const promise = (async () => {
    let token = await getValidAccessToken();
    if (!token) throw ApiError.sessionExpired();
    let result = await attempt(token);
    if (result.status === 401 && !state.aborted) {
      token = await refreshAccessToken();
      if (!token) throw ApiError.sessionExpired();
      onProgress(0);
      result = await attempt(token);
    }
    if (result.status < 200 || result.status >= 300) throw errorFromResponse(result.status, result.body);
    return (result.body as { attachment: Attachment }).attachment;
  })();

  return {
    promise,
    abort: () => {
      state.aborted = true;
      xhr?.abort();
    },
  };
}

// ---- 0.5.5 resumable uploads -------------------------------------------------------------------

interface UploadStatus {
  uploadId: string;
  size: number;
  received: number;
  chunkSize: number;
}

const RESUME_KEY = 'aidis.uploads';
/** Waits between attempts after a network error (the last one repeats until the user cancels). */
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];

/** The same file picked again (name, size, modification time) continues where it stopped. */
export function resumeKeyOf(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}|${String(file.size)}|${String(file.lastModified)}`;
}

function readResume(): Record<string, string> {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeResume(key: string, uploadId: string | null): void {
  try {
    const map = readResume();
    if (uploadId) map[key] = uploadId;
    else Reflect.deleteProperty(map, key);
    localStorage.setItem(RESUME_KEY, JSON.stringify(map));
  } catch {
    /* storage blocked: resuming after a restart is not available, everything else works */
  }
}

/** Errors worth another attempt: no connection, timeouts, server overload / restart. */
export function isRetryableUploadError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
  return error.status === 502 || error.status === 503 || error.status === 504 || error.status === 429;
}

async function authorizedFetch(path: string, init: RequestInit): Promise<Response> {
  let token = await getValidAccessToken();
  if (!token) throw ApiError.sessionExpired();
  const send = async (t: string) => {
    try {
      return await fetch(apiUrl(path), { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${t}` } });
    } catch {
      if (init.signal?.aborted) throw ApiError.aborted();
      throw ApiError.network();
    }
  };
  let res = await send(token);
  if (res.status === 401) {
    token = await refreshAccessToken();
    if (!token) throw ApiError.sessionExpired();
    res = await send(token);
  }
  return res;
}

async function readJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw errorFromResponse(res.status, body);
  return body as T;
}

/**
 * Resumable upload: announce, send pieces at the offset the server reports, complete. A broken
 * connection is retried by itself (the piece in flight is resent from what really arrived), and
 * picking the same file again after a restart continues the earlier upload.
 */
function uploadLarge(file: File, onProgress: (fraction: number) => void, onRetry?: (waitingMs: number) => void): UploadHandle {
  const controller = new AbortController();
  /** Read through a function: the flag changes while we wait (TS would narrow a direct read). */
  const isAborted = () => controller.signal.aborted;
  const key = resumeKeyOf(file);
  let uploadId: string | null = null;

  const withRetry = async <T>(step: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await step();
      } catch (error) {
        if (controller.signal.aborted) throw ApiError.aborted();
        if (!isRetryableUploadError(error)) throw error;
        const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
        onRetry?.(wait);
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (isAborted()) throw ApiError.aborted();
      }
    }
  };
  const statusOf = async (id: string) => readJson<UploadStatus>(await authorizedFetch(`/api/v1/attachments/uploads/${id}`, { method: 'GET', signal: controller.signal }));

  const promise = (async () => {
    let status: UploadStatus | null = null;
    const previous = readResume()[key];
    if (previous) {
      status = await withRetry(async () => {
        const res = await authorizedFetch(`/api/v1/attachments/uploads/${previous}`, { method: 'GET', signal: controller.signal });
        if (res.status === 404) return null;
        return readJson<UploadStatus>(res);
      });
      if (status && status.size !== file.size) status = null;
    }
    status ??= await withRetry(async () =>
      readJson<UploadStatus>(
        await authorizedFetch('/api/v1/attachments/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, mimeType: file.type || undefined, size: file.size }),
          signal: controller.signal,
        }),
      ),
    );
    const id = status.uploadId;
    uploadId = id;
    writeResume(key, id);
    let received = status.received;
    const chunkSize = status.chunkSize;
    onProgress(received / file.size);
    while (received < file.size) {
      const offset = received;
      const piece = file.slice(offset, Math.min(file.size, offset + chunkSize));
      received = await withRetry(async () => {
        const res = await authorizedFetch(`/api/v1/attachments/uploads/${id}?offset=${String(offset)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: piece,
          signal: controller.signal,
        });
        // Out of step (an earlier attempt partly arrived): continue from the server's position.
        if (res.status === 409) return (await statusOf(id)).received;
        return (await readJson<UploadStatus>(res)).received;
      });
      onProgress(received / file.size);
    }
    const done = await withRetry(async () =>
      readJson<{ attachment: Attachment }>(await authorizedFetch(`/api/v1/attachments/uploads/${id}/complete`, { method: 'POST', signal: controller.signal })),
    );
    writeResume(key, null);
    return done.attachment;
  })();

  return {
    promise,
    abort: () => {
      controller.abort();
      writeResume(key, null);
      if (uploadId) void authorizedFetch(`/api/v1/attachments/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => undefined);
    },
    suspend: () => {
      controller.abort();
    },
  };
}

export const attachmentsApi = {
  /** 0.5.5: time-limited URL for streaming (<video> with Range) or a direct download. */
  link(attachmentId: string, download = false): Promise<{ url: string; expiresAt: string }> {
    return request(`/api/v1/attachments/${attachmentId}/link${download ? '?download=1' : ''}`);
  },

  /** Deletes an upload that was never attached to a message. */
  remove(attachmentId: string): Promise<void> {
    return request(`/api/v1/attachments/${attachmentId}`, { method: 'DELETE' });
  },
};

// ---- authenticated object URLs ------------------------------------------------

const MAX_CACHED = 60;
const cache = new Map<string, Promise<string>>();

/**
 * Downloads an attachment with the Bearer token and returns an object URL.
 * A small LRU keeps recently shown images; evicted URLs are revoked.
 */
export function getAttachmentObjectUrl(attachmentId: string): Promise<string> {
  const hit = cache.get(attachmentId);
  if (hit) {
    cache.delete(attachmentId);
    cache.set(attachmentId, hit);
    return hit;
  }
  const promise = requestBlob(`/api/v1/attachments/${attachmentId}/content`).then((blob) => URL.createObjectURL(blob));
  promise.catch(() => cache.delete(attachmentId));
  cache.set(attachmentId, promise);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    void entry?.then((url) => {
      URL.revokeObjectURL(url);
    });
  }
  return promise;
}

/** Revokes every cached object URL (on logout). */
export function clearAttachmentCache(): void {
  for (const entry of cache.values()) {
    void entry.then(
      (url) => {
        URL.revokeObjectURL(url);
      },
      () => undefined,
    );
  }
  cache.clear();
}

/** 0.5.5: above this size a download goes straight to disk (signed link), not through memory. */
export const DIRECT_DOWNLOAD_THRESHOLD = 20 * 1024 * 1024;

/** 0.5.5: absolute signed URL of an attachment (for <video> / <audio> streaming or downloads). */
export async function attachmentStreamUrl(attachmentId: string, download = false): Promise<string> {
  const { url } = await attachmentsApi.link(attachmentId, download);
  return new URL(apiUrl(url), window.location.href).href;
}

/** Saves an attachment to disk: small files via an object URL, large ones directly (0.5.5). */
export async function downloadAttachment(attachment: Attachment): Promise<void> {
  if (attachment.size > DIRECT_DOWNLOAD_THRESHOLD) {
    const url = await attachmentStreamUrl(attachment.id, true);
    const desktop = (window as unknown as { aidisDesktop?: { app?: { downloadUrl?: (u: string) => void } } }).aidisDesktop;
    if (desktop?.app?.downloadUrl) {
      desktop.app.downloadUrl(url);
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const blob = await requestBlob(`/api/v1/attachments/${attachment.id}/content`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = attachment.originalName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
