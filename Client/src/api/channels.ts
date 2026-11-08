import { request } from './client';
import type { Channel, NotifyMode, OverwriteView, Permission, ReadState, VoiceLayout } from './types';

export interface ChannelPatch {
  name?: string;
  description?: string | null;
  /** 0.7.0: move into a category (null = top level). */
  parentId?: string | null;
  /** 0.7.0: drop own overwrites and use the category's again. */
  syncWithParent?: true;
  /** 0.5.5 voice channels. */
  voiceBitrate?: number;
  voiceLayout?: VoiceLayout;
  /** 0.7.1 */
  voiceNodeId?: string | null;
}

/** 0.7.0: listing and creating channels is per server (guildsApi.channels / createChannel). */
export const channelsApi = {
  get(channelId: string): Promise<{ channel: Channel }> {
    return request(`/api/v1/channels/${channelId}`);
  },
  update(channelId: string, patch: ChannelPatch): Promise<{ channel: Channel }> {
    return request(`/api/v1/channels/${channelId}`, { method: 'PATCH', body: patch });
  },
  remove(channelId: string): Promise<void> {
    return request(`/api/v1/channels/${channelId}`, { method: 'DELETE' });
  },
  setOverwrite(channelId: string, targetType: OverwriteView['targetType'], targetId: string, body: { allow: Permission[]; deny: Permission[] }): Promise<{ overwrite: OverwriteView }> {
    return request(`/api/v1/channels/${channelId}/overwrites/${targetType}/${targetId}`, { method: 'PUT', body });
  },
  removeOverwrite(channelId: string, targetType: OverwriteView['targetType'], targetId: string): Promise<void> {
    return request(`/api/v1/channels/${channelId}/overwrites/${targetType}/${targetId}`, { method: 'DELETE' });
  },
  /** 0.4.0 read state. */
  reads(): Promise<{ reads: ReadState[] }> {
    return request('/api/v1/reads');
  },
  markRead(channelId: string, messageId?: string): Promise<{ read: ReadState }> {
    return request(`/api/v1/channels/${channelId}/read`, { method: 'POST', body: messageId ? { messageId } : {} });
  },
  setNotify(channelId: string, mode: NotifyMode | null): Promise<{ read: ReadState }> {
    return request(`/api/v1/channels/${channelId}/notify`, { method: 'PUT', body: { mode } });
  },
};

export const dmsApi = {
  list(): Promise<{ dms: Channel[] }> {
    return request('/api/v1/dms');
  },
  /** One user: opens (or reuses) the 1:1 DM. Several: a new group DM. 0.7.0: friends only. */
  open(userIds: string[], title?: string): Promise<{ dm: Channel }> {
    return request('/api/v1/dms', { method: 'POST', body: { userIds, ...(title ? { title } : {}) } });
  },
  update(channelId: string, input: { title?: string | null; addUserIds?: string[] }): Promise<{ dm: Channel }> {
    return request(`/api/v1/dms/${channelId}`, { method: 'PATCH', body: input });
  },
  leave(channelId: string): Promise<void> {
    return request(`/api/v1/dms/${channelId}/members/me`, { method: 'DELETE' });
  },
  ring(channelId: string): Promise<void> {
    return request(`/api/v1/dms/${channelId}/call`, { method: 'POST' });
  },
};
