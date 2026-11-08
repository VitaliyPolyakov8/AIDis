import { request } from './client';
import type { VoiceNodeView } from './types';

const base = '/api/v1/admin/voice-nodes';

/** 0.7.1 extra voice servers (superadmin), and the ones a server may use (channel settings). */
export const voiceNodesApi = {
  list(): Promise<{ main: { url: string }; nodes: VoiceNodeView[] }> {
    return request(base);
  },
  create(input: { name: string; url: string; apiKey: string; apiSecret: string }): Promise<{ node: VoiceNodeView }> {
    return request(base, { method: 'POST', body: input });
  },
  update(id: string, patch: { name?: string; enabled?: boolean; guildIds?: string[]; apiKey?: string; apiSecret?: string }): Promise<{ node: VoiceNodeView }> {
    return request(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  },
  remove(id: string): Promise<void> {
    return request(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  check(id: string): Promise<{ node: VoiceNodeView }> {
    return request(`${base}/${encodeURIComponent(id)}/check`, { method: 'POST' });
  },
  /** MANAGE_CHANNELS: nodes this server may put a voice channel on. */
  forGuild(guildId: string): Promise<{ nodes: { id: string; name: string }[] }> {
    return request(`/api/v1/guilds/${encodeURIComponent(guildId)}/voice-nodes`);
  },
};
