import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import type { AppContext } from '../app-context.js';
import { getAuth } from '../auth/auth.hooks.js';
import { Errors } from '../common/errors.js';
import { parseInput } from '../common/validation.js';
import type { User } from '../generated/prisma/client.js';
import { toAttachmentView } from './attachment.dto.js';
import { isInlineSafe, parseRange } from './storage.js';

const attachmentParams = z.object({ attachmentId: z.uuid() });
const uploadParams = z.object({ uploadId: z.uuid() });
const contentQuery = z.object({ t: z.string().max(300).optional(), download: z.enum(['1']).optional() });
const linkQuery = z.object({ download: z.enum(['1']).optional() });
const startBody = z.object({
  filename: z.string().max(1000).optional(),
  mimeType: z.string().max(255).optional(),
  size: z.number().int().positive(),
});
const offsetQuery = z.object({ offset: z.coerce.number().int().min(0) });

export function attachmentsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { attachments } = ctx.services;
  const { requireAuth } = ctx.hooks;

  // 0.5.5 resumable uploads: a piece arrives as the raw request body, streamed to disk (never
  // buffered); ChunkedUploads enforces the piece size itself.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  /** multipart/form-data with a single field named "file". */
  app.post('/attachments', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!request.isMultipart()) {
      throw Errors.badRequest('MULTIPART_REQUIRED', 'Upload must be multipart/form-data with a "file" field');
    }
    // 0.7.0: the superadmin can lower this per user (never above MAX_UPLOAD_SIZE).
    const fileSize = await ctx.services.limits.resolve('upload.size', { userId: getAuth(request).user.id });
    const file = await request.file({ limits: { fileSize, files: 1 } });
    if (!file) {
      throw Errors.badRequest('FILE_REQUIRED', 'No file was uploaded');
    }
    const attachment = await attachments.upload(getAuth(request).user, {
      stream: file.file,
      filename: file.filename,
      mimeType: file.mimetype,
      wasTruncated: () => file.file.truncated,
    });
    return reply.status(201).send({ attachment: toAttachmentView(attachment) });
  });

  // ---- 0.5.5 resumable (chunked) uploads ------------------------------------------------------

  const chunked = () => {
    if (!attachments.chunked) throw Errors.notFound('Route');
    return attachments.chunked;
  };

  /** Announces a file: { filename, mimeType, size } -> { uploadId, size, received, chunkSize }. */
  app.post('/attachments/uploads', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = parseInput(startBody, request.body);
    const user = getAuth(request).user;
    const max = await ctx.services.limits.resolve('upload.largeSize', { userId: user.id });
    if (body.size > max) throw Errors.payloadTooLarge(`File is too large (max ${max} bytes)`);
    return reply.status(201).send(await chunked().start(user, body));
  });

  /** How much has arrived (resume after a broken connection or an app restart). */
  app.get('/attachments/uploads/:uploadId', { preHandler: requireAuth }, async (request) => {
    const { uploadId } = parseInput(uploadParams, request.params);
    return chunked().get(getAuth(request).user, uploadId);
  });

  /** One piece (application/octet-stream) at ?offset= (must equal "received"). */
  app.put('/attachments/uploads/:uploadId', { preHandler: requireAuth, config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (request) => {
    const { uploadId } = parseInput(uploadParams, request.params);
    const { offset } = parseInput(offsetQuery, request.query);
    const body = request.body as Readable | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') throw Errors.badRequest('OCTET_STREAM_REQUIRED', 'Send the piece as application/octet-stream');
    return chunked().append(getAuth(request).user, uploadId, offset, body);
  });

  app.post('/attachments/uploads/:uploadId/complete', { preHandler: requireAuth }, async (request, reply) => {
    const { uploadId } = parseInput(uploadParams, request.params);
    const attachment = await chunked().complete(getAuth(request).user, uploadId);
    return reply.status(201).send({ attachment: toAttachmentView(attachment) });
  });

  app.delete('/attachments/uploads/:uploadId', { preHandler: requireAuth }, async (request, reply) => {
    const { uploadId } = parseInput(uploadParams, request.params);
    await chunked().cancel(getAuth(request).user, uploadId);
    return reply.status(204).send();
  });

  // ---- reading ------------------------------------------------------------------------------

  app.get('/attachments/:attachmentId', { preHandler: requireAuth }, async (request) => {
    const { attachmentId } = parseInput(attachmentParams, request.params);
    return { attachment: toAttachmentView(await attachments.getVisible(getAuth(request).user, attachmentId)) };
  });

  /** 0.5.5: a signed URL for <video> streaming and direct downloads (see AttachmentsService.link). */
  app.get('/attachments/:attachmentId/link', { preHandler: requireAuth }, async (request) => {
    const { attachmentId } = parseInput(attachmentParams, request.params);
    const { download } = parseInput(linkQuery, request.query);
    const user = getAuth(request).user;
    const attachment = await attachments.getVisible(user, attachmentId);
    return attachments.link(user, attachment, download === '1');
  });

  /** A signed link (?t=) or the usual Bearer token; who may see the file is checked either way. */
  const contentAuth = async (request: FastifyRequest): Promise<void> => {
    const query = request.query as { t?: unknown };
    if (typeof query.t === 'string' && query.t.length > 0) return;
    await requireAuth(request);
  };

  const viewerOf = async (request: FastifyRequest, attachmentId: string, token: string | undefined): Promise<User> => {
    if (!token) return getAuth(request).user;
    const userId = attachments.verifyLink(attachmentId, token);
    const user = userId ? await ctx.prisma.user.findUnique({ where: { id: userId } }) : null;
    if (!user || user.disabled) throw Errors.unauthorized();
    return user;
  };

  app.get('/attachments/:attachmentId/content', { preHandler: contentAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { attachmentId } = parseInput(attachmentParams, request.params);
    const { t, download } = parseInput(contentQuery, request.query);
    const attachment = await attachments.getVisible(await viewerOf(request, attachmentId, t), attachmentId);
    const size = await attachments.storage.sizeOf(attachment.storedName);
    const range = parseRange(request.headers.range, size);
    const { stream } = await attachments.storage.open(attachment.storedName, range ?? undefined);
    const inline = isInlineSafe(attachment.mimeType) && download !== '1';
    const encodedName = encodeURIComponent(attachment.originalName);
    reply
      .header('Content-Type', isInlineSafe(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=86400');
    if (range) {
      return reply
        .status(206)
        .header('Content-Range', `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`)
        .header('Content-Length', range.end - range.start + 1)
        .send(stream);
    }
    return reply.header('Content-Length', size).send(stream);
  });

  app.delete('/attachments/:attachmentId', { preHandler: requireAuth }, async (request, reply) => {
    const { attachmentId } = parseInput(attachmentParams, request.params);
    await attachments.delete(getAuth(request).user, attachmentId);
    return reply.status(204).send();
  });
}
