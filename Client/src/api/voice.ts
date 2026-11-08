import { request } from './client';
import type { VoiceParticipantView, VoiceTokenResponse } from './types';

export const voiceApi = {
  token(channelId: string): Promise<VoiceTokenResponse> {
    return request('/api/v1/voice/token', { method: 'POST', body: { channelId } });
  },
  participants(channelId: string, signal?: AbortSignal): Promise<{ participants: VoiceParticipantView[] }> {
    return request(`/api/v1/voice/channels/${channelId}/participants`, { signal, timeoutMs: 10_000 });
  },
  /** 0.4.0 MOVE_USERS: moves a user to another voice channel (LiveKit moves their connection). */
  moveParticipant(channelId: string, userId: string, targetChannelId: string): Promise<{ moved: boolean; method: string }> {
    return request(`/api/v1/voice/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}/move`, { method: 'POST', body: { targetChannelId } });
  },
  /** 0.5.5: our newest stream preview (small JPEG / WebP), shown when people hover our LIVE badge. */
  putStreamThumbnail(image: Blob): Promise<void> {
    return request('/api/v1/voice/stream-thumbnail', { method: 'PUT', body: image, timeoutMs: 10_000 });
  },
  clearStreamThumbnail(): Promise<void> {
    return request('/api/v1/voice/stream-thumbnail', { method: 'DELETE', timeoutMs: 10_000 });
  },
  /** 0.7.0 MUTE_MEMBERS: server mute (no microphone on this server until lifted). */
  serverMute(channelId: string, userId: string, muted: boolean): Promise<void> {
    return request(`/api/v1/voice/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}/server-mute`, { method: 'PUT', body: { muted } });
  },
  /** 0.7.0 DEAFEN_MEMBERS: server deafen (the target's client goes silent). */
  serverDeafen(channelId: string, userId: string, deafened: boolean): Promise<void> {
    return request(`/api/v1/voice/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}/server-deafen`, { method: 'PUT', body: { deafened } });
  },
  /** DISCONNECT_USERS (enforced by the server): removes a user from the voice channel. Not a ban. */
  disconnectParticipant(channelId: string, userId: string): Promise<void> {
    return request(
      `/api/v1/voice/channels/${encodeURIComponent(channelId)}/participants/${encodeURIComponent(userId)}/disconnect`,
      { method: 'POST' },
    );
  },
};
