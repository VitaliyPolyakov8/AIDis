import { memo, type MouseEvent } from 'react';
import { linkify } from '../../utils/linkify';
import { usePresenceStore } from '../../stores/presenceStore';
import { openProfile } from '../profile/profileState';
import { EmojiText } from '../../emojis/EmojiImage';

/** @username tokens (same rule as the server's mention parser). */
export const MENTION_PATTERN = /(^|[^\w@])@([A-Za-z0-9_.-]{2,32})/g;

type Part = { type: 'text'; value: string } | { type: 'mention'; value: string; userId: string; name: string };

function splitMentions(text: string, byUsername: Map<string, { id: string; displayName: string }>): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const [, prefix = '', username = ''] = match;
    const user = byUsername.get(username.toLowerCase());
    if (!user) continue;
    const start = match.index + prefix.length;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({ type: 'mention', value: `@${username}`, userId: user.id, name: user.displayName });
    last = start + username.length + 1;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** Plain-text message rendering with clickable http(s) links and @mentions. Never interprets HTML. */
export const MessageText = memo(function MessageText({ text }: { text: string }) {
  const users = usePresenceStore((s) => s.users);
  const byUsername = new Map(Object.values(users).map((u) => [u.username.toLowerCase(), u]));
  const hasAt = text.includes('@');
  return (
    <span className="message-text">
      {linkify(text).map((part, i) =>
        part.type === 'link' ? (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">
            {part.value}
          </a>
        ) : hasAt ? (
          splitMentions(part.value, byUsername).map((p, j) =>
            p.type === 'mention' ? (
              <button
                key={`${i}-${j}`}
                type="button"
                className="mention"
                title={p.value}
                onClick={(e: MouseEvent) => openProfile(e, p.userId)}
              >
                @{p.name}
              </button>
            ) : (
              <EmojiText key={`${i}-${j}`} text={p.value} />
            ),
          )
        ) : (
          <EmojiText key={i} text={part.value} />
        ),
      )}
    </span>
  );
});
