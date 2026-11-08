import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, X, SendHorizontal } from 'lucide-react';
import { attachmentsApi, uploadAttachment, type UploadHandle } from '../api/attachments';
import { messagesApi } from '../api/messages';
import { useChatStore } from '../stores/chatStore';
import { VoiceRecorder, type RecordingState } from './recorder';
import { voiceMessagesApi } from './api';
import './voice-messages.css';

export function VoiceMessageRecorder({ channelId, disabled = false }: { channelId: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<RecordingState>({ status: 'idle', blob: null, seconds: 0, error: null });
  const [recorder] = useState(() => new VoiceRecorder(setState));
  const preview = useRef<HTMLAudioElement>(null);
  const [sending, setSending] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [sendError, setSendError] = useState(false);
  const upload = useRef<UploadHandle | null>(null);
  const generation = useRef(0);
  const uploaded = useRef<string | null>(null);
  const registered = useRef(false);
  const nonce = useRef(crypto.randomUUID());
  const cancel = () => {
    generation.current++; recorder.cancel(); upload.current?.abort(); upload.current = null;
    if (uploaded.current) void attachmentsApi.remove(uploaded.current).catch(() => undefined);
    uploaded.current = null; registered.current = false; nonce.current = crypto.randomUUID(); setSending(false); setCommitting(false); setSendError(false);
  };
  useEffect(() => () => {
    generation.current++; recorder.cancel(); upload.current?.abort();
    if (uploaded.current) void attachmentsApi.remove(uploaded.current).catch(() => undefined);
  }, [recorder, channelId]);
  useEffect(() => {
    const audio = preview.current;
    if (!state.blob || !audio) return;
    const url = URL.createObjectURL(state.blob); audio.src = url;
    return () => { audio.removeAttribute('src'); URL.revokeObjectURL(url); };
  }, [state.blob]);

  const send = async () => {
    if (!state.blob || sending) return;
    const ticket = generation.current; setSending(true); setSendError(false);
    try {
      let id = uploaded.current;
      if (!id) {
        const ext = state.blob.type === 'audio/mp4' ? 'm4a' : state.blob.type === 'audio/ogg' ? 'ogg' : 'webm';
        upload.current = uploadAttachment(new File([state.blob], `voice-${nonce.current}.${ext}`, { type: state.blob.type }), () => undefined);
        const attachment = await upload.current.promise;
        if (ticket !== generation.current) { void attachmentsApi.remove(attachment.id).catch(() => undefined); return; }
        id = attachment.id; uploaded.current = id;
      }
      if (!registered.current) {
        await voiceMessagesApi.register(id);
        if (ticket !== generation.current) return;
        registered.current = true;
      }
      if (ticket !== generation.current) return;
      setCommitting(true);
      const { message } = await messagesApi.send(channelId, { content: '', nonce: nonce.current, attachmentIds: [id] });
      if (ticket !== generation.current) return;
      uploaded.current = null;
      useChatStore.getState().applyCreated(message, message.author.id);
      cancel();
    } catch { if (ticket === generation.current) { setSendError(true); setSending(false); setCommitting(false); } }
  };
  const active = state.status !== 'idle' && state.status !== 'error';
  return <div className={`voice-recorder${active ? ' is-active' : ''}`}>
    {!active && <button type="button" className="icon-btn" aria-label={t('voiceMessages.record')} title={t('voiceMessages.record')} disabled={disabled} onClick={() => { setSendError(false); void recorder.start(); }}><Mic size={18} /></button>}
    {active && <div className="voice-recorder-panel">
      <span role="status">{t(state.status === 'preview' ? 'voiceMessages.preview' : state.status === 'requesting' ? 'voiceMessages.requesting' : 'voiceMessages.recording')} · {Math.floor(state.seconds / 60)}:{String(state.seconds % 60).padStart(2, '0')}</span>
      {state.status === 'recording' && <button type="button" className="icon-btn" aria-label={t('voiceMessages.stop')} onClick={() => recorder.stop()}><Square size={17} /></button>}
      {state.status === 'preview' && state.blob && <audio ref={preview} controls preload="metadata" aria-label={t('voiceMessages.preview')} />}
      {state.status === 'preview' && <button type="button" className="icon-btn" disabled={sending} aria-label={t('voiceMessages.send')} onClick={() => void send()}><SendHorizontal size={18} /></button>}
      <button type="button" className="icon-btn" aria-label={t('voiceMessages.cancel')} disabled={committing} onClick={cancel}><X size={18} /></button>
      <small>{t('voiceMessages.limits')}</small>
    </div>}
    {(state.error || sendError) && <span className="voice-recorder-error" role="alert">{t(sendError ? 'voiceMessages.sendFailed' : state.error === 'unsupported' ? 'voiceMessages.unsupported' : state.error === 'limit' ? 'voiceMessages.tooLarge' : 'voiceMessages.micFailed')}</span>}
  </div>;
}
