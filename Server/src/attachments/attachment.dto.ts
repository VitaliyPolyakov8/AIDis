import type { Attachment } from '../generated/prisma/client.js';

export interface AttachmentView {
  id: string;
  uploaderId: string;
  messageId: string | null;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** Relative URL; requires the same Bearer token as the rest of the API. */
  url: string;
}

export function toAttachmentView(attachment: Attachment): AttachmentView {
  return {
    id: attachment.id,
    uploaderId: attachment.uploaderId,
    messageId: attachment.messageId,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: Number(attachment.size),
    createdAt: attachment.createdAt.toISOString(),
    url: `/api/v1/attachments/${attachment.id}/content`,
  };
}
