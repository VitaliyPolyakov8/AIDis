import { useEffect, useState } from 'react';
import { useEmojiStore } from './store';
import { emojiImageUrl } from './images';
import { splitEmojiTokens } from './tokens';
import './emojis.css';

export function EmojiImage({ id, name = 'emoji' }: { id: string; name?: string }) {
  const emoji = useEmojiStore(s => s.emojis.find(e => e.id === id));
  const revision = useEmojiStore(s => s.revision);
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const knownId = emoji?.id;
  useEffect(() => {
    if (!knownId) return;
    let live = true;
    void emojiImageUrl(knownId).then(url => { if (live) { setImage({ id: knownId, url }); setFailed(null); } }, () => { if (live) setFailed(knownId); });
    return () => { live = false; };
  }, [knownId, revision]);
  const label = `:${emoji?.name ?? name}:`;
  if (!emoji || image?.id !== id || failed === id) return <span className="server-emoji-fallback" title={label}>{label}</span>;
  return <img className="server-emoji" src={image.url} alt={label} title={label} width="24" height="24" loading="lazy" draggable={false} onError={() => setFailed(id)} />;
}
export function EmojiGlyph({ value }: { value: string }) {
  return value.startsWith('custom:') ? <EmojiImage id={value.slice(7)} /> : <>{value}</>;
}
export function EmojiText({ text }: { text: string }) {
  return <>{splitEmojiTokens(text).map((part, index) => part.type === 'text' ? <span key={index}>{part.text}</span> : <EmojiImage key={index} id={part.id} name={part.name} />)}</>;
}
