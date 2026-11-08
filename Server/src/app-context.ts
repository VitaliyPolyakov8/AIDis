import type { GamesService } from './games/games.service.js';
import type { SetupService } from './setup/setup.service.js';
import type { SoundsService } from './sounds/sounds.service.js';
import type { RegistrationService } from './registration/registration.service.js';
import type { MailService } from './mail/mail.service.js';
import type { VoiceNodesService } from './voice-nodes/voice-nodes.service.js';
import type { SecretBox } from './common/secret-box.js';
import type { AppConfig } from './config/env.js';
import type { PrismaClient } from './db/prisma.js';
import type { AuthHooks } from './auth/auth.hooks.js';
import type { AuthService } from './auth/auth.service.js';
import type { UsersService } from './users/users.service.js';
import type { ChannelsService } from './channels/channels.service.js';
import type { MessagesService } from './messages/messages.service.js';
import type { PresenceService } from './presence/presence.service.js';
import type { VoiceService } from './voice/voice.service.js';
import type { AttachmentsService } from './attachments/attachments.service.js';
import type { ClientVersionService } from './client-version/client-version.js';
import type { EventPublisher } from './realtime/events.js';
import type { PermissionsService } from './permissions/permissions.service.js';
import type { ReadsService } from './reads/reads.service.js';
import type { AuditService } from './audit/audit.service.js';
import type { GameHistoryService } from './presence/game-history.js';
import type { RolesService } from './roles/roles.service.js';
import type { SettingsService } from './admin/settings.service.js';
import type { ConnectionView } from './realtime/gateway.js';
import type { ChunkedUploads } from './attachments/chunked.js';
import type { VoiceMessages } from './voice-messages/service.js';
import type { EmojisService } from './emojis/service.js';
import type { GuildsService } from './guilds/guilds.service.js';
import type { LimitsService } from './limits/limits.service.js';
import type { ModerationService } from './guilds/moderation.service.js';
import type { OverwritesService } from './channels/overwrites.service.js';
import type { InvitesService } from './invites/invites.service.js';
import type { FriendsService } from './friends/friends.service.js';

/** Everything route modules need, wired once in app.ts. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  hooks: AuthHooks;
  publisher: EventPublisher;
  /** 0.5.8: live realtime connections (filled in once the gateway exists). */
  realtime: { connections(): ConnectionView[] };
  /** 0.5.8: when this backend process started (admin panel uptime). */
  startedAt: number;
  services: {
    auth: AuthService;
    users: UsersService;
    channels: ChannelsService;
    messages: MessagesService;
    presence: PresenceService;
    voice: VoiceService;
    attachments: AttachmentsService;
    clientVersion: ClientVersionService;
    permissions: PermissionsService;
    reads: ReadsService;
    audit: AuditService;
    roles: RolesService;
    /** 0.5.5 */
    games: GameHistoryService;
    tracker: GamesService;
    /** 0.5.8 */
    settings: SettingsService;
    chunkedUploads: ChunkedUploads;
    /** 0.5.9 */
    voiceMessages?: VoiceMessages;
    emojis: EmojisService;
    sounds: SoundsService;
    /** 0.7.0 */
    guilds: GuildsService;
    limits: LimitsService;
    moderation: ModerationService;
    overwrites: OverwritesService;
    invites: InvitesService;
    friends: FriendsService;
    /** 0.7.1 */
    voiceNodes: VoiceNodesService;
    secretBox: SecretBox;
    mail: MailService;
    registration: RegistrationService;
    setup: SetupService;
  };
}
