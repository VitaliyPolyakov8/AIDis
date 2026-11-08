import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { voiceMessagesApi, type VoiceMessage } from './api';

/** Ordinary audio has no registration and shows no transcription UI. Playback is independent. */
export function VoiceTranscript({ attachmentId }: { attachmentId: string }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState<VoiceMessage | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { voiceMessage } = await voiceMessagesApi.get(attachmentId, controller.signal);
        if (controller.signal.aborted) return;
        setMessage(voiceMessage);
        if (voiceMessage && ['draft', 'queued', 'processing'].includes(voiceMessage.status)) timer = setTimeout(() => void poll(), 5000);
      } catch { /* No transcript is revealed when access is revoked; audio authorization is separate. */
        if (!controller.signal.aborted) setMessage(null);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attachmentId]);
  if (!message) return null;
  return <div className="voice-transcript" aria-live="polite">
    {message.status === 'done'
      ? <details><summary>{t('voiceMessages.transcript')}{message.duration ? ` · ${Math.ceil(message.duration)} s` : ''}</summary><p>{message.text || t('voiceMessages.noSpeech')}</p></details>
      : <span>{t(message.status === 'failed' ? 'voiceMessages.failed' : 'voiceMessages.pending')}</span>}
  </div>;
}
