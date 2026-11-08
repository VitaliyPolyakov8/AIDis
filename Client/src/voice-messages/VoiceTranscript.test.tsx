import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageAttachments } from '../components/chat/AttachmentView';
import { VoiceTranscript } from './VoiceTranscript';
import { voiceMessagesApi } from './api';
import type { Attachment } from '../api/types';

vi.mock('./api', () => ({ voiceMessagesApi: { get: vi.fn() } }));
vi.mock('../api/attachments', async original => ({
  ...await original<typeof import('../api/attachments')>(),
  attachmentStreamUrl: vi.fn(async () => 'https://local.test/protected-audio?t=signed'),
}));
const attachment: Attachment = { id: 'voice-id', uploaderId: 'author', messageId: 'message', originalName: 'voice.webm', mimeType: 'audio/webm', size: 8, createdAt: '2026-10-31T00:00:00Z', url: '/api/v1/attachments/voice-id/content' };
beforeEach(() => { vi.clearAllMocks(); });
describe('voice transcripts alongside protected audio', () => {
  it.each(['failed', 'offline'] as const)('keeps playback available when transcription is %s', async status => {
    if (status === 'offline') vi.mocked(voiceMessagesApi.get).mockRejectedValue(new Error('offline'));
    else vi.mocked(voiceMessagesApi.get).mockResolvedValue({ voiceMessage: { status: 'failed', text: null, duration: null, error: 'transcription-failed' } });
    const view = render(<MessageAttachments attachments={[attachment]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play voice.webm' }));
    await waitFor(() => expect(view.container.querySelector('audio')).toHaveAttribute('src', 'https://local.test/protected-audio?t=signed'));
    if (status === 'failed') expect(screen.getByText('Transcription unavailable. You can still play the recording.')).toBeInTheDocument();
  });

  it('renders transcript text safely and hides UI for ordinary audio without registered metadata', async () => {
    vi.mocked(voiceMessagesApi.get).mockResolvedValueOnce({ voiceMessage: { status: 'done', text: '<img src=x onerror=alert(1)> Привет', duration: 2, error: null } });
    const view = render(<VoiceTranscript attachmentId="voice-id" />);
    expect(await screen.findByText('<img src=x onerror=alert(1)> Привет')).toBeInTheDocument();
    expect(view.container.querySelector('img')).toBeNull(); view.unmount();
    vi.mocked(voiceMessagesApi.get).mockResolvedValueOnce({ voiceMessage: null });
    const plain = render(<VoiceTranscript attachmentId="plain-audio" />);
    await waitFor(() => expect(voiceMessagesApi.get).toHaveBeenCalledTimes(2));
    expect(plain.container).toBeEmptyDOMElement();
  });

  it('aborts pending transcript requests on navigation', async () => {
    vi.mocked(voiceMessagesApi.get).mockReturnValue(new Promise(() => undefined));
    const view = render(<VoiceTranscript attachmentId="voice-id" />);
    const signal = vi.mocked(voiceMessagesApi.get).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false); view.unmount(); expect(signal?.aborted).toBe(true);
  });
});
