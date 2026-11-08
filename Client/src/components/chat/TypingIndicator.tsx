import { useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { describeTyping } from '../../utils/chat';
import { useTranslation } from 'react-i18next';

const EMPTY: Record<string, number> = {};


export function TypingIndicator({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const typing = useChatStore((s) => s.typing[channelId] ?? EMPTY);
  const typingStopped = useChatStore((s) => s.typingStopped);
  const users = usePresenceStore((s) => s.users);
  const [now, setNow] = useState(() => Date.now());

  // Expire entries locally in case the server's typing.stopped never arrives.
  const ids = Object.keys(typing);
  useEffect(() => {
    if (ids.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ids.length]);

  useEffect(() => {
    for (const [userId, expires] of Object.entries(typing)) {
      if (expires < now) typingStopped(channelId, userId);
    }
  }, [now, typing, channelId, typingStopped]);

  const names = ids.filter((id) => (typing[id] ?? 0) >= now).map((id) => users[id]?.displayName ?? t('typing.someone'));
  const text = describeTyping(names);
  return (
    <div className="typing-indicator" aria-live="polite">
      {text && (
        <>
          <span className="typing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>{text}</span>
        </>
      )}
    </div>
  );
}
