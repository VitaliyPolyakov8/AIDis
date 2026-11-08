import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PrismaClient } from '../db/prisma.js';
import type { Attachment, User } from '../generated/prisma/client.js';
import { Errors } from '../common/errors.js';
import { LocalFileStorage, sanitizeFilename, sanitizeMimeType } from './storage.js';
import type { ChunkedUploads } from './chunked.js';
import type { PermissionsService } from '../permissions/permissions.service.js';

/** 0.5.5: lifetime of a signed content link (video playback, downloads). */
export const LINK_TTL_SECONDS = 6 * 3600;

export class AttachmentsService {
  private readonly linkKey: Buffer;

  constructor(
    private readonly prisma: PrismaClient,
    readonly storage: LocalFileStorage,
    private readonly permissions: PermissionsService | null = null,
    linkSecret = 'aidis-test-link-secret',
    /** 0.5.5 resumable uploads (null in tests that do not need them). */
    readonly chunked: ChunkedUploads | null = null,
  ) {
    // Separate key derived from the server secret, used for nothing else.
    this.linkKey = createHmac('sha256', linkSecret).update('aidis-attachment-link-v1').digest();
  }

  private linkSignature(attachmentId: string, userId: string, expires: number): string {
    return createHmac('sha256', this.linkKey)
      .update(`${attachmentId}:${userId}:${String(expires)}`)
      .digest('base64url')
      .slice(0, 32);
  }

  /**
   * 0.5.5: a time-limited URL for one viewer, so <video> can stream with Range requests and a
   * large file downloads straight to disk (both without the Authorization header). The token is
   * bound to the attachment AND the user: visibility is checked again on every request.
   */
  link(user: User, attachment: Attachment, download: boolean, now = Date.now()): { url: string; expiresAt: string } {
    const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
    const token = `${Buffer.from(user.id).toString('base64url')}.${String(expires)}.${this.linkSignature(attachment.id, user.id, expires)}`;
    return {
      url: `/api/v1/attachments/${attachment.id}/content?t=${token}${download ? '&download=1' : ''}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  /** The user a link token was issued to, or null when it is invalid or expired. */
  verifyLink(attachmentId: string, token: string, now = Date.now()): string | null {
    const [encodedUser, expiresText, signature] = token.split('.');
    if (!encodedUser || !expiresText || !signature || !/^\d{1,12}$/.test(expiresText)) return null;
    const expires = Number(expiresText);
    if (expires * 1000 < now) return null;
    const userId = Buffer.from(encodedUser, 'base64url').toString('utf8');
    const expected = Buffer.from(this.linkSignature(attachmentId, userId, expires));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
  }

  /**
   * 0.4.0: a file is only served to people who may see it: its uploader; everyone for profile
   * pictures / banners; otherwise whoever can see the channel or DM of the message it belongs to.
   * Anything else answers NOT_FOUND (does not reveal that the file exists).
   */
  async getVisible(user: User, id: string): Promise<Attachment> {
    const attachment = await this.get(id);
    if (attachment.uploaderId === user.id) return attachment;
    const profileUse = await this.prisma.user.count({ where: { OR: [{ avatarAttachmentId: id }, { bannerAttachmentId: id }] } });
    if (profileUse > 0) return attachment;
    // 0.7.0: server icon / banner: everyone signed in (invite previews show them to non-members).
    if ((await this.prisma.guild.count({ where: { OR: [{ iconAttachmentId: id }, { bannerAttachmentId: id }] } })) > 0) return attachment;
    // 0.7.0: a server-profile picture: members of that server (and the superadmin).
    const memberUses = await this.prisma.guildMember.findMany({ where: { OR: [{ avatarAttachmentId: id }, { bannerAttachmentId: id }] }, select: { guildId: true } });
    for (const { guildId } of memberUses) {
      if (user.role === 'ADMIN' || (this.permissions && (await this.permissions.isMember(user.id, guildId)))) return attachment;
    }
    if (attachment.messageId && this.permissions) {
      const message = await this.prisma.message.findUnique({ where: { id: attachment.messageId }, include: { channel: true } });
      if (message && !message.deletedAt && (await this.permissions.canView(user, message.channel))) return attachment;
    }
    throw Errors.notFound('Attachment');
  }

  async upload(uploader: User, file: { stream: Readable; filename?: string; mimeType?: string; wasTruncated?: () => boolean }): Promise<Attachment> {
    const saved = await this.storage.save(file.stream);
    // The multipart parser stops (truncates) the stream at MAX_UPLOAD_SIZE instead of failing it.
    if (file.wasTruncated?.() === true) {
      await this.storage.remove(saved.storedName);
      throw Errors.payloadTooLarge('Uploaded file is too large');
    }
    if (saved.size === 0) {
      await this.storage.remove(saved.storedName);
      throw Errors.badRequest('EMPTY_FILE', 'Uploaded file is empty');
    }
    try {
      return await this.prisma.attachment.create({
        data: {
          uploaderId: uploader.id,
          originalName: sanitizeFilename(file.filename),
          storedName: saved.storedName,
          mimeType: sanitizeMimeType(file.mimeType),
          size: BigInt(saved.size),
          sha256: saved.sha256,
        },
      });
    } catch (error) {
      await this.storage.remove(saved.storedName);
      throw error;
    }
  }

  async get(id: string): Promise<Attachment> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw Errors.notFound('Attachment');
    return attachment;
  }

  /** 0.5.8 admin panel: the biggest files, newest first among equal sizes. */
  async largest(limit = 50) {
    const rows = await this.prisma.attachment.findMany({
      orderBy: [{ size: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, Math.min(200, limit)),
      include: { uploader: { select: { id: true, displayName: true } }, message: { select: { id: true, channelId: true, deletedAt: true } } },
    });
    return rows.map((a) => ({
      id: a.id,
      originalName: a.originalName,
      mimeType: a.mimeType,
      size: Number(a.size),
      createdAt: a.createdAt.toISOString(),
      uploader: a.uploader,
      messageId: a.message && !a.message.deletedAt ? a.message.id : null,
      channelId: a.message && !a.message.deletedAt ? a.message.channelId : null,
    }));
  }

  /** 0.5.8 admin panel: totals for the storage card. */
  async totals(): Promise<{ count: number; bytes: number }> {
    const sum = await this.prisma.attachment.aggregate({ _count: { _all: true }, _sum: { size: true } });
    return { count: sum._count._all, bytes: Number(sum._sum.size ?? 0) };
  }

  /**
   * 0.5.8 admin panel: deletes any file, also one used by a message (the message stays, without
   * the file) or as an avatar / banner. Returns the message id whose view changed, if any.
   */
  async adminRemove(id: string): Promise<{ messageId: string | null; originalName: string }> {
    const attachment = await this.get(id);
    await this.prisma.user.updateMany({ where: { avatarAttachmentId: id }, data: { avatarAttachmentId: null } });
    await this.prisma.user.updateMany({ where: { bannerAttachmentId: id }, data: { bannerAttachmentId: null } });
    await this.prisma.attachment.delete({ where: { id } });
    await this.storage.remove(attachment.storedName);
    return { messageId: attachment.messageId, originalName: attachment.originalName };
  }

  /** Only unused uploads can be deleted (by their uploader or an ADMIN). */
  async delete(actor: User, id: string): Promise<void> {
    const attachment = await this.get(id);
    if (attachment.uploaderId !== actor.id && actor.role !== 'ADMIN') {
      throw Errors.forbidden('You can only delete your own uploads');
    }
    if (attachment.messageId !== null) {
      throw Errors.conflict('ATTACHMENT_IN_USE', 'Delete the message that uses this attachment first');
    }
    await this.prisma.user.updateMany({ where: { avatarAttachmentId: id }, data: { avatarAttachmentId: null } });
    await this.prisma.user.updateMany({ where: { bannerAttachmentId: id }, data: { bannerAttachmentId: null } });
    await this.prisma.attachment.delete({ where: { id } });
    await this.storage.remove(attachment.storedName);
  }
}
