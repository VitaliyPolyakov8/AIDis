import { request } from '../api/client';
export interface VoiceMessage {
  status: 'draft' | 'queued' | 'processing' | 'done' | 'failed';
  text: string | null;
  duration: number | null;
  error: string | null;
}
export const voiceMessagesApi = {
  register: (id: string) => request<{ voiceMessage: VoiceMessage }>(`/api/v1/attachments/${id}/voice-message`, { method: 'POST' }),
  get: (id: string, signal?: AbortSignal) => request<{ voiceMessage: VoiceMessage | null }>(`/api/v1/attachments/${id}/voice-message`, { signal }),
};
