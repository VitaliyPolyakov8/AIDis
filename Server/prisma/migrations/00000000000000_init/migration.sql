-- AIDis base schema (fresh installations).
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "PresenceStatus" AS ENUM ('ONLINE', 'AWAY', 'DND', 'INVISIBLE');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('TEXT', 'VOICE', 'DM', 'CATEGORY');

-- CreateEnum
CREATE TYPE "OverwriteTarget" AS ENUM ('ROLE', 'MEMBER');

-- CreateEnum
CREATE TYPE "LimitScope" AS ENUM ('GUILD', 'USER');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('PLAYING', 'COMPLETED', 'HUNDRED', 'DROPPED', 'PAUSED');

-- CreateEnum
CREATE TYPE "GamePlatform" AS ENUM ('PC', 'PLAYSTATION', 'XBOX', 'SWITCH', 'MOBILE', 'OTHER');

-- CreateEnum
CREATE TYPE "NotifyMode" AS ENUM ('ALL', 'MENTIONS', 'NONE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "username_normalized" VARCHAR(32) NOT NULL,
    "display_name" VARCHAR(64) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "avatar_attachment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "presence_status" "PresenceStatus" NOT NULL DEFAULT 'ONLINE',
    "custom_status_text" VARCHAR(128),
    "custom_status_expires_at" TIMESTAMPTZ(3),
    "custom_status_emoji" VARCHAR(16),
    "banner_attachment_id" UUID,
    "accent_color" VARCHAR(7),
    "profile_frame" VARCHAR(32),
    "profile_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nickname_color" VARCHAR(7),
    "profile_banner_id" VARCHAR(32),
    "avatar_frame_id" VARCHAR(32),
    "accent_color_2" VARCHAR(7),
    "nickname_color_2" VARCHAR(7),
    "nickname_glow" BOOLEAN NOT NULL DEFAULT false,
    "nickname_font" VARCHAR(24),
    "birthday_month" SMALLINT,
    "birthday_day" SMALLINT,
    "show_recent_games" BOOLEAN NOT NULL DEFAULT true,
    "bio" VARCHAR(190),
    "email" VARCHAR(254),
    "email_verified_at" TIMESTAMPTZ(3),
    "pending_verification" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "previous_token_hash" VARCHAR(64),
    "client_type" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "device_name" VARCHAR(100),
    "user_agent" VARCHAR(300),
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(32),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(300),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "guild_id" UUID,
    "parent_id" UUID,
    "permissions_synced" BOOLEAN NOT NULL DEFAULT true,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "title" VARCHAR(64),
    "owner_id" UUID,
    "dm_key" VARCHAR(80),
    "last_message_at" TIMESTAMPTZ(3),
    "voice_bitrate" SMALLINT,
    "voice_layout" VARCHAR(16) NOT NULL DEFAULT 'standard',
    "voice_node_id" UUID,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "nonce" VARCHAR(64),
    "reply_to_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "edited_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "embeds" JSONB,
    "mentions" UUID[] DEFAULT ARRAY[]::UUID[],
    "pinned_at" TIMESTAMPTZ(3),
    "pinned_by_id" UUID,
    "tts" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reactions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_members" (
    "channel_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("channel_id","user_id")
);

-- CreateTable
CREATE TABLE "channel_reads" (
    "user_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(3) NOT NULL,
    "notify_mode" "NotifyMode",

    CONSTRAINT "channel_reads_pkey" PRIMARY KEY ("user_id","channel_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "guild_id" UUID NOT NULL,
    "key" VARCHAR(32),
    "name" VARCHAR(32) NOT NULL,
    "color" VARCHAR(7),
    "position" INTEGER NOT NULL DEFAULT 0,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hoist" BOOLEAN NOT NULL DEFAULT false,
    "mentionable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guilds" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "icon_attachment_id" UUID,
    "banner_attachment_id" UUID,
    "owner_id" UUID NOT NULL,
    "system_channel_id" UUID,
    "default_notify_mode" "NotifyMode" NOT NULL DEFAULT 'ALL',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_members" (
    "guild_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nickname" VARCHAR(32),
    "avatar_attachment_id" UUID,
    "banner_attachment_id" UUID,
    "bio" VARCHAR(190),
    "notify_mode" "NotifyMode",
    "rail_position" INTEGER,

    CONSTRAINT "guild_members_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- CreateTable
CREATE TABLE "guild_member_roles" (
    "guild_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "guild_member_roles_pkey" PRIMARY KEY ("guild_id","user_id","role_id")
);

-- CreateTable
CREATE TABLE "invites" (
    "code" VARCHAR(16) NOT NULL,
    "guild_id" UUID NOT NULL,
    "channel_id" UUID,
    "creator_id" UUID NOT NULL,
    "max_uses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "guild_bans" (
    "guild_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" VARCHAR(300),
    "banned_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guild_bans_pkey" PRIMARY KEY ("guild_id","user_id")
);

-- CreateTable
CREATE TABLE "permission_overwrites" (
    "channel_id" UUID NOT NULL,
    "target_type" "OverwriteTarget" NOT NULL,
    "target_id" UUID NOT NULL,
    "allow" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deny" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "permission_overwrites_pkey" PRIMARY KEY ("channel_id","target_type","target_id")
);

-- CreateTable
CREATE TABLE "friendships" (
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("user_a_id","user_b_id")
);

-- CreateTable
CREATE TABLE "friend_requests" (
    "from_id" UUID NOT NULL,
    "to_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("from_id","to_id")
);

-- CreateTable
CREATE TABLE "limit_overrides" (
    "key" VARCHAR(48) NOT NULL,
    "scope" "LimitScope" NOT NULL,
    "target_id" UUID NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "limit_overrides_pkey" PRIMARY KEY ("key","scope","target_id")
);

-- CreateTable
CREATE TABLE "badges" (
    "id" UUID NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "label" VARCHAR(32) NOT NULL,
    "icon" VARCHAR(32) NOT NULL,
    "color" VARCHAR(7) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_badges" (
    "user_id" UUID NOT NULL,
    "badge_id" UUID NOT NULL,

    CONSTRAINT "user_badges_pkey" PRIMARY KEY ("user_id","badge_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "guild_id" UUID,
    "actor_id" UUID,
    "action" VARCHAR(48) NOT NULL,
    "target_type" VARCHAR(24),
    "target_id" VARCHAR(64),
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "message_id" UUID,
    "original_name" VARCHAR(255) NOT NULL,
    "stored_name" VARCHAR(80) NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_emojis" (
    "id" UUID NOT NULL,
    "guild_id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "slot" SMALLINT NOT NULL,
    "stored_name" VARCHAR(80) NOT NULL,
    "mime_type" VARCHAR(32) NOT NULL,
    "size" INTEGER NOT NULL,
    "width" SMALLINT NOT NULL,
    "height" SMALLINT NOT NULL,
    "animated" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_emojis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_games" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "game_key" VARCHAR(160) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "steam_app_id" INTEGER,
    "first_played_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_played_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_seconds" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "status" "GameStatus" NOT NULL DEFAULT 'PLAYING',
    "platform" "GamePlatform" NOT NULL DEFAULT 'PC',
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "cover_attachment_id" UUID,
    "status_changed_at" TIMESTAMPTZ(3),
    "prompted_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "voice_nodes" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "url" VARCHAR(255) NOT NULL,
    "api_key" VARCHAR(128) NOT NULL,
    "api_secret_sealed" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_check_at" TIMESTAMPTZ(3),
    "last_check_status" VARCHAR(16),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_node_guilds" (
    "node_id" UUID NOT NULL,
    "guild_id" UUID NOT NULL,

    CONSTRAINT "voice_node_guilds_pkey" PRIMARY KEY ("node_id","guild_id")
);

-- CreateTable
CREATE TABLE "email_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "new_email" VARCHAR(254),
    "invite_code" VARCHAR(16),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_sounds" (
    "id" UUID NOT NULL,
    "guild_id" UUID NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "emoji" VARCHAR(16),
    "volume" SMALLINT NOT NULL DEFAULT 100,
    "slot" SMALLINT NOT NULL,
    "stored_name" VARCHAR(80) NOT NULL,
    "mime_type" VARCHAR(32) NOT NULL,
    "size" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_sounds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_normalized_key" ON "users"("username_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_dm_key_key" ON "channels"("dm_key");

-- CreateIndex
CREATE INDEX "channels_guild_id_position_idx" ON "channels"("guild_id", "position");

-- CreateIndex
CREATE INDEX "channels_type_position_idx" ON "channels"("type", "position");

-- CreateIndex
CREATE INDEX "messages_channel_id_created_at_id_idx" ON "messages"("channel_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "messages_channel_id_pinned_at_idx" ON "messages"("channel_id", "pinned_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_author_id_nonce_key" ON "messages"("author_id", "nonce");

-- CreateIndex
CREATE INDEX "reactions_message_id_idx" ON "reactions"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "reactions_message_id_user_id_emoji_key" ON "reactions"("message_id", "user_id", "emoji");

-- CreateIndex
CREATE INDEX "channel_members_user_id_idx" ON "channel_members"("user_id");

-- CreateIndex
CREATE INDEX "roles_guild_id_position_idx" ON "roles"("guild_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "roles_guild_id_key_key" ON "roles"("guild_id", "key");

-- CreateIndex
CREATE INDEX "guild_members_user_id_idx" ON "guild_members"("user_id");

-- CreateIndex
CREATE INDEX "guild_member_roles_role_id_idx" ON "guild_member_roles"("role_id");

-- CreateIndex
CREATE INDEX "invites_guild_id_idx" ON "invites"("guild_id");

-- CreateIndex
CREATE INDEX "friendships_user_b_id_idx" ON "friendships"("user_b_id");

-- CreateIndex
CREATE INDEX "friend_requests_to_id_idx" ON "friend_requests"("to_id");

-- CreateIndex
CREATE UNIQUE INDEX "badges_key_key" ON "badges"("key");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_guild_id_created_at_idx" ON "audit_log"("guild_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_stored_name_key" ON "attachments"("stored_name");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "attachments_uploader_id_idx" ON "attachments"("uploader_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_emojis_stored_name_key" ON "server_emojis"("stored_name");

-- CreateIndex
CREATE UNIQUE INDEX "server_emojis_guild_id_name_key" ON "server_emojis"("guild_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "server_emojis_guild_id_slot_key" ON "server_emojis"("guild_id", "slot");

-- CreateIndex
CREATE INDEX "user_games_user_id_last_played_at_idx" ON "user_games"("user_id", "last_played_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_games_user_id_game_key_key" ON "user_games"("user_id", "game_key");

-- CreateIndex
CREATE UNIQUE INDEX "voice_nodes_url_key" ON "voice_nodes"("url");

-- CreateIndex
CREATE INDEX "voice_node_guilds_guild_id_idx" ON "voice_node_guilds"("guild_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "email_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_tokens_user_id_idx" ON "email_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_sounds_stored_name_key" ON "server_sounds"("stored_name");

-- CreateIndex
CREATE UNIQUE INDEX "server_sounds_guild_id_name_key" ON "server_sounds"("guild_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "server_sounds_guild_id_slot_key" ON "server_sounds"("guild_id", "slot");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_attachment_id_fkey" FOREIGN KEY ("avatar_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_banner_attachment_id_fkey" FOREIGN KEY ("banner_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_voice_node_id_fkey" FOREIGN KEY ("voice_node_id") REFERENCES "voice_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_icon_attachment_id_fkey" FOREIGN KEY ("icon_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guilds" ADD CONSTRAINT "guilds_banner_attachment_id_fkey" FOREIGN KEY ("banner_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_avatar_attachment_id_fkey" FOREIGN KEY ("avatar_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_members" ADD CONSTRAINT "guild_members_banner_attachment_id_fkey" FOREIGN KEY ("banner_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_member_roles" ADD CONSTRAINT "guild_member_roles_guild_id_user_id_fkey" FOREIGN KEY ("guild_id", "user_id") REFERENCES "guild_members"("guild_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_member_roles" ADD CONSTRAINT "guild_member_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guild_bans" ADD CONSTRAINT "guild_bans_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_overwrites" ADD CONSTRAINT "permission_overwrites_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_fkey" FOREIGN KEY ("badge_id") REFERENCES "badges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_emojis" ADD CONSTRAINT "server_emojis_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_emojis" ADD CONSTRAINT "server_emojis_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_games" ADD CONSTRAINT "user_games_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_node_guilds" ADD CONSTRAINT "voice_node_guilds_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "voice_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_node_guilds" ADD CONSTRAINT "voice_node_guilds_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_sounds" ADD CONSTRAINT "server_sounds_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_sounds" ADD CONSTRAINT "server_sounds_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Built-in profile badges (assigned by an administrator).
INSERT INTO "badges" ("id", "key", "label", "icon", "color", "position")
VALUES
  (gen_random_uuid(), 'admin', 'Admin', 'shield', '#f0b232', 0),
  (gen_random_uuid(), 'developer', 'Developer', 'code', '#5865f2', 1),
  (gen_random_uuid(), 'founder', 'Founder', 'crown', '#eb459e', 2),
  (gen_random_uuid(), 'tester', 'Tester', 'flask', '#3ba55d', 3)
ON CONFLICT ("key") DO NOTHING;
