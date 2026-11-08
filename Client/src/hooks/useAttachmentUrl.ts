import { useEffect, useState } from 'react';
import { attachmentStreamUrl, getAttachmentObjectUrl } from '../api/attachments';

/** Object URL for an authenticated attachment (null while loading or when id is null). */
export function useAttachmentUrl(attachmentId: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; url: string | null; failed: boolean }>({
    id: null,
    url: null,
    failed: false,
  });

  useEffect(() => {
    if (!attachmentId) return;
    let cancelled = false;
    getAttachmentObjectUrl(attachmentId).then(
      (url) => {
        if (!cancelled) setState({ id: attachmentId, url, failed: false });
      },
      () => {
        if (!cancelled) setState({ id: attachmentId, url: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);

  if (!attachmentId || state.id !== attachmentId) return { url: null, failed: false };
  return { url: state.url, failed: state.failed };
}

/** 0.5.5: signed streaming URL of a video / audio attachment (null while loading or when id is null). */
export function useAttachmentStreamUrl(attachmentId: string | null): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; url: string | null; failed: boolean }>({ id: null, url: null, failed: false });
  useEffect(() => {
    if (!attachmentId) return;
    let cancelled = false;
    attachmentStreamUrl(attachmentId).then(
      (url) => {
        if (!cancelled) setState({ id: attachmentId, url, failed: false });
      },
      () => {
        if (!cancelled) setState({ id: attachmentId, url: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);
  if (!attachmentId || state.id !== attachmentId) return { url: null, failed: false };
  return { url: state.url, failed: state.failed };
}
