import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceMessageRecorder } from './VoiceMessageRecorder';
import { uploadAttachment, attachmentsApi } from '../api/attachments';
import { voiceMessagesApi } from './api';
import { messagesApi } from '../api/messages';

vi.mock('../api/attachments', () => ({ uploadAttachment: vi.fn(), attachmentsApi: { remove: vi.fn(async () => undefined) } }));
vi.mock('./api', () => ({ voiceMessagesApi: { register: vi.fn(async () => ({})) } }));
vi.mock('../api/messages', () => ({ messagesApi: { send: vi.fn() } }));
vi.mock('../stores/chatStore', () => ({ useChatStore: { getState: () => ({ applyCreated: vi.fn() }) } }));

const track = { stop: vi.fn() };
let media: { ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null };
function capture(value: typeof media) { media = value; }
async function recordPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
  await screen.findByRole('button', { name: 'Stop recording' });
  act(() => media.ondataavailable?.({ data: new Blob(['sound']) }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
  act(() => media.onstop?.());
  await screen.findByRole('button', { name: 'Send voice message' });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(voiceMessagesApi.register).mockResolvedValue({} as never);
  vi.mocked(messagesApi.send).mockResolvedValue({ message: { id: 'message', author: { id: 'author' } } } as never);
  vi.mocked(uploadAttachment).mockReturnValue({ promise: Promise.resolve({ id: 'audio' } as never), abort: vi.fn(), suspend: vi.fn() });
  vi.stubGlobal('MediaRecorder', Object.assign(class {
    state = 'inactive'; mimeType = 'audio/webm;codecs=opus'; ondataavailable = null; onstop = null;
    constructor() { capture(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }, { isTypeSupported: () => true }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
});

describe('voice preview and explicit send', () => {
  it('uploads and registers only after Send, then sends to the original channel', async () => {
    render(<VoiceMessageRecorder channelId="channel-a" />); await recordPreview();
    expect(track.stop).toHaveBeenCalledOnce(); expect(uploadAttachment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await waitFor(() => expect(messagesApi.send).toHaveBeenCalledWith('channel-a', expect.objectContaining({ attachmentIds: ['audio'], content: '' })));
    expect(voiceMessagesApi.register).toHaveBeenCalledWith('audio');
    await screen.findByRole('button', { name: 'Record voice message' });
    expect(attachmentsApi.remove).not.toHaveBeenCalled();
  });

  it('keeps the same upload and nonce when sending fails so retry cannot duplicate a message', async () => {
    vi.mocked(messagesApi.send).mockRejectedValueOnce(new Error('offline'));
    render(<VoiceMessageRecorder channelId="channel-a" />); await recordPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await screen.findByRole('button', { name: 'Record voice message' });
    expect(uploadAttachment).toHaveBeenCalledOnce(); expect(voiceMessagesApi.register).toHaveBeenCalledOnce();
    expect(vi.mocked(messagesApi.send).mock.calls[1]).toEqual(vi.mocked(messagesApi.send).mock.calls[0]);
  });

  it('disables discard once the authorized message commit has started', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(messagesApi.send).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<VoiceMessageRecorder channelId="channel-a" />); await recordPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await waitFor(() => expect(messagesApi.send).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Discard recording' })).toBeDisabled();
    await act(async () => resolve({ message: { id: 'sent', author: { id: 'author' } } } as never));
    expect(attachmentsApi.remove).not.toHaveBeenCalled();
  });

  it('cancels a pending upload and discards a late completed upload without sending', async () => {
    let resolve!: (value: never) => void; const abort = vi.fn();
    vi.mocked(uploadAttachment).mockReturnValue({ promise: new Promise(r => { resolve = r; }), abort, suspend: vi.fn() });
    render(<VoiceMessageRecorder channelId="channel-a" />); await recordPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    expect(abort).toHaveBeenCalledOnce();
    await act(async () => resolve({ id: 'late-audio' } as never));
    expect(attachmentsApi.remove).toHaveBeenCalledWith('late-audio'); expect(messagesApi.send).not.toHaveBeenCalled();
  });

  it('navigation during registration prevents sending into either channel', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(voiceMessagesApi.register).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const view = render(<VoiceMessageRecorder key="a" channelId="channel-a" />); await recordPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await waitFor(() => expect(voiceMessagesApi.register).toHaveBeenCalled());
    view.rerender(<VoiceMessageRecorder key="b" channelId="channel-b" />);
    await act(async () => resolve({} as never));
    expect(messagesApi.send).not.toHaveBeenCalled(); expect(attachmentsApi.remove).toHaveBeenCalledWith('audio');
  });

  it('late registration after cancellation cannot skip registration of a fresh recording', async () => {
    let resolve!: (value: never) => void;
    vi.mocked(voiceMessagesApi.register).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<VoiceMessageRecorder channelId="channel-a" />); await recordPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await waitFor(() => expect(voiceMessagesApi.register).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Discard recording' }));
    await act(async () => resolve({} as never));
    await recordPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice message' }));
    await screen.findByRole('button', { name: 'Record voice message' });
    expect(voiceMessagesApi.register).toHaveBeenCalledTimes(2);
  });
});
