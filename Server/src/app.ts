import { SERVER_VERSION } from './health/health.routes.js';
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config/env.js';
import type { PrismaClient } from './db/prisma.js';
import type { AppContext } from './app-context.js';
import { AppError, Errors } from './common/errors.js';
import { buildLoggerOptions } from './common/logger.js';
import { AccessTokenService } from './auth/tokens.js';
import { AuthService } from './auth/auth.service.js';
import { createAuthHooks } from './auth/auth.hooks.js';
import { authRoutes } from './auth/auth.routes.js';
import { UsersService } from './users/users.service.js';
import { usersRoutes } from './users/users.routes.js';
import { ChannelsService } from './channels/channels.service.js';
import { channelsRoutes } from './channels/channels.routes.js';
import { MessagesService } from './messages/messages.service.js';
import { messagesRoutes } from './messages/messages.routes.js';
import { galleryRoutes } from './gallery/gallery.routes.js';
import { PresenceService } from './presence/presence.service.js';
import { ImageSigner } from './embeds/embeds.js';
import { setEmbedImageSigner } from './embeds/embed-views.js';
import { embedsRoutes } from './embeds/embeds.routes.js';
import { GifService } from './embeds/gif.service.js';
import { LinkPreviewService } from './embeds/link-preview.service.js';
import { presenceRoutes } from './presence/presence.routes.js';
import { VoiceService } from './voice/voice.service.js';
import { voiceRoutes } from './voice/voice.routes.js';
import { AttachmentsService } from './attachments/attachments.service.js';
import { VoiceMessages } from './voice-messages/service.js';
import { localWhisperWorker } from './voice-messages/worker.js';
import { voiceMessageRoutes } from './voice-messages/routes.js';
import { attachmentsRoutes } from './attachments/attachments.routes.js';
import { LocalFileStorage } from './attachments/storage.js';
import { ClientVersionService, clientConfigRoutes, clientVersionRoutes } from './client-version/client-version.js';
import { createSecretBox } from './common/secret-box.js';
import { VoiceNodesService } from './voice-nodes/voice-nodes.service.js';
import { voiceNodesRoutes } from './voice-nodes/voice-nodes.routes.js';
import { mailRoutes } from './mail/mail.routes.js';
import { MailService } from './mail/mail.service.js';
import { SoundsService } from './sounds/sounds.service.js';
import { GamesService } from './games/games.service.js';
import { gamesRoutes } from './games/games.routes.js';
import { soundsRoutes } from './sounds/sounds.routes.js';
import { RegistrationService } from './registration/registration.service.js';
import { registrationRoutes } from './registration/registration.routes.js';
import { SetupService } from './setup/setup.service.js';
import { setupRoutes } from './setup/setup.routes.js';
import { adminRoutes } from './admin/admin.routes.js';
import { healthRoutes } from './health/health.routes.js';
import { RealtimeGateway } from './realtime/gateway.js';
import { noopPublisher, type EventPublisher, type MemberRemovedReason, type MessageDeletedEvent, type PresenceView, type ReactionsUpdatedEvent } from './realtime/events.js';
import type { GuildView, MemberView, MyGuildView } from './guilds/guild.dto.js';
import { GuildsService } from './guilds/guilds.service.js';
import { guildsRoutes } from './guilds/guilds.routes.js';
import { ModerationService } from './guilds/moderation.service.js';
import { OverwritesService } from './channels/overwrites.service.js';
import { InvitesService } from './invites/invites.service.js';
import { invitesRoutes } from './invites/invites.routes.js';
import { FriendsService } from './friends/friends.service.js';
import { friendsRoutes } from './friends/friends.routes.js';
import { limitsRoutes } from './limits/limits.routes.js';
import { LimitsService } from './limits/limits.service.js';
import { PermissionsService } from './permissions/permissions.service.js';
import { ReadsService, type ReadStateView } from './reads/reads.service.js';
import { AuditService } from './audit/audit.service.js';
import { RolesService } from './roles/roles.service.js';
import { rolesRoutes } from './roles/roles.routes.js';
import { dmsRoutes } from './channels/dms.routes.js';
import type { MessageView } from './messages/message.dto.js';
import type { PublicUser } from './users/user.dto.js';
import { GameHistoryService } from './presence/game-history.js';
import { ChunkedUploads } from './attachments/chunked.js';
import { VoiceSessionTracker, type VoiceMemberEvent, type VoiceSessionView } from './voice/voice-sessions.js';
import { SettingsService, type AnnouncementView } from './admin/settings.service.js';
import { EmojisService } from './emojis/service.js';
import { emojisRoutes } from './emojis/routes.js';
import type { ConnectionView } from './realtime/gateway.js';

/** Forwards domain events to whatever publisher is attached (the Socket.IO gateway once it exists). */
class EventBus implements EventPublisher {
  private target: EventPublisher = noopPublisher;
  attach(target: EventPublisher): void {
    this.target = target;
  }
  messageCreated(message: MessageView): void {
    this.target.messageCreated(message);
  }
  messageUpdated(message: MessageView): void {
    this.target.messageUpdated(message);
  }
  messageDeleted(event: MessageDeletedEvent): void {
    this.target.messageDeleted(event);
  }
  userUpdated(user: PublicUser): void {
    this.target.userUpdated(user);
  }
  presenceUpdated(presence: PresenceView): void {
    this.target.presenceUpdated(presence);
  }
  reactionsUpdated(event: ReactionsUpdatedEvent): void {
    this.target.reactionsUpdated(event);
  }
  channelsChanged(scope: 'channels' | 'dms', userIds?: string[], guildId?: string): void {
    this.target.channelsChanged(scope, userIds, guildId);
  }
  rolesChanged(guildId: string): void {
    this.target.rolesChanged(guildId);
  }
  emojisChanged(guildId: string): void {
    this.target.emojisChanged(guildId);
  }

  soundsChanged(guildId: string): void {
    this.target.soundsChanged(guildId);
  }

  gamesChanged(userId: string): void {
    this.target.gamesChanged(userId);
  }
  guildJoined(userId: string, guild: MyGuildView): void {
    this.target.guildJoined(userId, guild);
  }
  guildUpdated(guild: GuildView, userIds: string[]): void {
    this.target.guildUpdated(guild, userIds);
  }
  guildDeleted(guildId: string, userIds: string[]): void {
    this.target.guildDeleted(guildId, userIds);
  }
  memberAdded(guildId: string, member: MemberView, userIds: string[]): void {
    this.target.memberAdded(guildId, member, userIds);
  }
  memberUpdated(guildId: string, member: MemberView, userIds: string[]): void {
    this.target.memberUpdated(guildId, member, userIds);
  }
  memberRemoved(guildId: string, userId: string, reason: MemberRemovedReason, userIds: string[]): void {
    this.target.memberRemoved(guildId, userId, reason, userIds);
  }
  friendsChanged(userIds: string[]): void {
    this.target.friendsChanged(userIds);
  }
  voiceServerState(guildId: string, userId: string, flags: { muted: boolean; deafened: boolean }): void {
    this.target.voiceServerState(guildId, userId, flags);
  }
  readUpdated(userId: string, state: ReadStateView): void {
    this.target.readUpdated(userId, state);
  }
  voiceMove(userId: string, channelId: string, rejoin?: boolean): void {
    this.target.voiceMove(userId, channelId, rejoin);
  }
  callRing(channelId: string, fromUserId: string, userIds: string[]): void {
    this.target.callRing(channelId, fromUserId, userIds);
  }
  voiceSession(session: VoiceSessionView): void {
    this.target.voiceSession(session);
  }
  voiceMember(event: VoiceMemberEvent): void {
    this.target.voiceMember(event);
  }
  accessChanged(): void {
    this.target.accessChanged();
  }
  disconnectSession(sessionId: string, reason: string): void {
    this.target.disconnectSession(sessionId, reason);
  }
  disconnectUser(userId: string, reason: string): void {
    this.target.disconnectUser(userId, reason);
  }
  announcementChanged(announcement: AnnouncementView | null): void {
    this.target.announcementChanged(announcement);
  }

  voiceNodesChanged(): void {
    this.target.voiceNodesChanged();
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  prisma: PrismaClient;
  /** Override the logger (tests pass `false`). */
  logger?: FastifyServerOptions['logger'];
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  gateway: RealtimeGateway;
}

const FASTIFY_CLIENT_ERRORS: Record<string, { code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
  FST_REQ_FILE_TOO_LARGE: { code: 'PAYLOAD_TOO_LARGE', message: 'Uploaded file is too large' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: 'BAD_REQUEST', message: 'Request body is empty' },
  FST_ERR_CTP_INVALID_JSON_BODY: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' },
  FST_INVALID_MULTIPART_CONTENT_TYPE: { code: 'MULTIPART_REQUIRED', message: 'Request is not multipart' },
  FST_FILES_LIMIT: { code: 'TOO_MANY_FILES', message: 'Only one file per upload is allowed' },
  FST_PARTS_LIMIT: { code: 'TOO_MANY_PARTS', message: 'Too many multipart parts' },
};

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config, prisma } = options;

  let logger: FastifyServerOptions['logger'] = options.logger;
  if (logger === undefined) {
    const base = buildLoggerOptions(config);
    logger = config.nodeEnv === 'development' ? { ...base, transport: { target: 'pino-pretty' } } : base;
  }

  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Fastify's own per-request lines are replaced by the compact onResponse log below.
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.decorateRequest('auth', null);

  // ---- services -------------------------------------------------------------
  const bus = new EventBus();
  const storage = new LocalFileStorage(config.uploadDirectory);
  await storage.init();
  const accessTokens = new AccessTokenService(config.jwtAccessSecret, config.accessTokenTtlSeconds);
  const auth = new AuthService(prisma, accessTokens, config.refreshTokenTtlSeconds, bus, app.log);
  const users = new UsersService(prisma, (storedName, maxBytes) => storage.readHead(storedName, maxBytes));
  const permissions = new PermissionsService(prisma);
  const audit = new AuditService(prisma, app.log);
  const limits = new LimitsService(prisma, config);
  const guilds = new GuildsService(prisma, permissions, limits, bus, audit, storage, app.log);
  const reads = new ReadsService(prisma);
  const roles = new RolesService(prisma, permissions, limits);
  const moderation = new ModerationService(prisma, permissions, guilds, audit, bus);
  const channels = new ChannelsService(prisma, permissions, limits);
  const overwrites = new OverwritesService(prisma, permissions);
  const imageSigner = new ImageSigner(config.jwtAccessSecret);
  setEmbedImageSigner(imageSigner);
  const linkPreviews = new LinkPreviewService(config.linkPreviews, app.log);
  const gifs = new GifService(config.gifs.provider, config.gifs.apiKey, config.gifs.locale);
  // Provider name only; the key is never logged.
  if (config.gifs.configError) app.log.error({ event: 'gifs.config' }, config.gifs.configError);
  else if (gifs.enabled) app.log.info({ event: 'gifs.config' }, `GIF provider: ${config.gifs.provider.toUpperCase()}`);
  const messages = new MessagesService(prisma, channels, bus, config.maxMessageLength, linkPreviews, config.gifs.provider, permissions, audit);
  messages.limits = limits;
  const games = new GameHistoryService(prisma, app.log);
  const tracker = new GamesService(prisma, users);
  games.onChanged = (userId) => { bus.gamesChanged(userId); };
  tracker.onChanged = (userId) => { bus.gamesChanged(userId); };
  const presence = new PresenceService(prisma, app.log, games);
  // 0.7.1: extra voice servers; their secrets (and the SMTP password) are sealed with a key from the server secret.
  const secretBox = createSecretBox(config.jwtAccessSecret);
  const voiceNodes = new VoiceNodesService(prisma, secretBox, config, bus, app.log);
  const voice = new VoiceService(config.livekit, channels, app.log, permissions);
  // 0.4.1: voice session timers (in memory, rebuilt from LiveKit after a restart).
  const voiceSessions = new VoiceSessionTracker(
    voice,
    (session) => {
      bus.voiceSession(session);
    },
    app.log,
    (event) => {
      bus.voiceMember(event);
    },
  );
  voice.attachSessions(voiceSessions);
  // 0.7.1: calls follow their channel's voice server; when a channel moves to another one (or its
  // server goes away) the people in it rejoin, which connects them to the right LiveKit.
  voice.attachNodes(voiceNodes);
  channels.attachVoiceNodes(voiceNodes);
  const rejoinChannels = (channelIds: string[]) => {
    for (const session of voiceSessions.snapshot()) {
      if (!channelIds.includes(session.channelId)) continue;
      for (const p of session.participants) bus.voiceMove(p.identity, session.channelId, true);
    }
  };
  voiceNodes.onFallback = ({ channelIds }) => {
    rejoinChannels(channelIds);
  };
  channels.onVoiceNodeChanged = (channelId) => {
    rejoinChannels([channelId]);
  };
  // 0.5.5: resumable uploads up to MAX_LARGE_UPLOAD_SIZE (partial files under <upload dir>/.partial).
  const chunkedUploads = new ChunkedUploads(prisma, storage, config.maxLargeUploadSize, app.log);
  await chunkedUploads.init();
  const attachments = new AttachmentsService(prisma, storage, permissions, config.jwtAccessSecret, chunkedUploads);
  const emojis = new EmojisService(prisma, storage, permissions, bus, audit, limits);
  // 0.7.1 soundboard (presses go through the gateway).
  const sounds = new SoundsService(prisma, storage, permissions, bus, audit, limits, voice);
  messages.emojis = emojis;
  const transcription = config.voiceTranscription;
  const voiceMessages = new VoiceMessages(prisma, attachments, permissions, localWhisperWorker(transcription?.python ?? '', transcription?.script ?? '', transcription?.model ?? ''));
  await voiceMessages.init();
  const clientVersion = new ClientVersionService(config.clientVersionFile, app.log);
  // 0.5.8 admin panel settings.
  const settings = new SettingsService(prisma);
  // 0.7.1 SMTP mail (registration letters, password reset).
  const mail = new MailService(settings, secretBox, app.log);
  guilds.checkImage = (userId, attachmentId, kind) => users.checkImage(userId, attachmentId, kind);
  const friends = new FriendsService(prisma, permissions, limits, bus);
  channels.attachFriends(friends);
  const invites = new InvitesService(prisma, permissions, limits, guilds);
  // 0.7.1 self-registration (off by default), e-mail links, password reset.
  const registration = new RegistrationService(prisma, settings, mail, users, auth, invites, bus, config.publicBaseUrl, app.log);
  // First-run wizard (open only while there is no account).
  const setup = new SetupService(prisma, users, guilds, invites, settings, auth, config.setupCodeFile, app.log);
  invites.countOnline = (ids) => ids.filter((id) => presence.isOnline(id)).length;
  // 0.7.0: someone kicked / banned from a server leaves its voice channel at once.
  // 0.7.0: kick / ban / leave / permission changes cut voice through voice.enforceAccess (called by the gateway).
  voice.userLookup = (ids) => prisma.user.findMany({ where: { id: { in: ids }, disabled: false }, select: { id: true, role: true } });
  const realtime = { connections: (): ConnectionView[] => [] };

  const ctx: AppContext = {
    config,
    prisma,
    hooks: createAuthHooks(auth),
    publisher: bus,
    realtime,
    startedAt: Date.now(),
    services: {
      auth,
      users,
      channels,
      messages,
      presence,
      voice,
      attachments,
      clientVersion,
      permissions,
      reads,
      audit,
      roles,
      games,
      tracker,
      settings,
      chunkedUploads,
      voiceMessages,
      emojis,
      sounds,
      guilds,
      limits,
      moderation,
      overwrites,
      invites,
      friends,
      voiceNodes,
      mail,
      registration,
      setup,
      secretBox,
    },
  };

  // ---- plugins --------------------------------------------------------------
  await app.register(helmet, {
    // Clients (browser, Electron, Android) live on other origins; API responses are JSON or files.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => Errors.rateLimited(`Too many requests, retry in ${Math.ceil(context.ttl / 1000)}s`),
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadSize, files: 1, fields: 5, parts: 6 },
  });

  // ---- logging, errors ------------------------------------------------------
  app.addHook('onResponse', (request, reply, done) => {
    const path = request.url.split('?')[0] ?? request.url;
    const entry = {
      method: request.method,
      path,
      statusCode: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      userId: request.auth?.user.id,
    };
    if (path === '/health' || path === '/ready') request.log.debug(entry, 'request');
    else request.log.info(entry, 'request');
    done();
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      const body: { code: string; message: string; details?: unknown } = { code: error.code, message: error.message };
      if (error.details !== undefined) body.details = error.details;
      return reply.status(error.statusCode).send({ error: body });
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      const known = FASTIFY_CLIENT_ERRORS[error.code];
      return reply.status(status).send({
        error: known ?? { code: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: 'Bad request' },
      });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_request, reply) => {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ---- routes ---------------------------------------------------------------
  healthRoutes(app, ctx);
  await app.register(
    (api, _opts, done) => {
      authRoutes(api, ctx);
      guildsRoutes(api, ctx);
      invitesRoutes(api, ctx);
      registrationRoutes(api, ctx);
      setupRoutes(api, ctx);
      friendsRoutes(api, ctx);
      limitsRoutes(api, ctx);
      usersRoutes(api, ctx);
      channelsRoutes(api, ctx);
      messagesRoutes(api, ctx);
      galleryRoutes(api, ctx);
      presenceRoutes(api, ctx);
      voiceRoutes(api, ctx);
      attachmentsRoutes(api, ctx);
      voiceMessageRoutes(api, ctx);
      clientVersionRoutes(api, ctx);
      clientConfigRoutes(api, ctx, SERVER_VERSION);
      embedsRoutes(api, ctx, gifs, imageSigner, linkPreviews);
      adminRoutes(api, ctx);
      rolesRoutes(api, ctx);
      dmsRoutes(api, ctx);
      emojisRoutes(api, ctx);
      soundsRoutes(api, ctx);
      gamesRoutes(api, ctx);
      voiceNodesRoutes(api, ctx);
      mailRoutes(api, ctx);
      done();
    },
    { prefix: '/api/v1' },
  );

  // ---- realtime -------------------------------------------------------------
  const gateway = new RealtimeGateway(app.server, {
    corsOrigins: config.corsOrigins,
    auth,
    presence,
    channels,
    permissions,
    log: app.log,
    voice,
    voiceSessions,
    friends,
    clientVersion,
    sounds,
  });
  bus.attach(gateway);
  realtime.connections = () => gateway.connections();
  if (config.livekit.enabled) voiceSessions.start();
  if (config.nodeEnv !== 'test') voiceNodes.start();
  if (config.nodeEnv !== 'test') registration.start();
  app.addHook('onClose', async () => {
    await voiceMessages.close();
    chunkedUploads.dispose();
    voiceNodes.stop();
    registration.stop();
    voiceSessions.stop();
    await gateway.close();
  });

  return { app, ctx, gateway };
}
