import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { initials } from '../../utils/avatar';

/** A server's icon, or its initials. */
export function GuildIcon({ name, iconAttachmentId, size }: { name: string; iconAttachmentId: string | null; size?: number }) {
  const { url } = useAttachmentUrl(iconAttachmentId);
  const style = size ? { width: size, height: size, fontSize: Math.max(11, Math.round(size / 3.2)) } : undefined;
  return url ? (
    <img className="guild-icon-img" src={url} alt="" draggable={false} style={style} />
  ) : (
    <span className="guild-icon-initials" style={style}>
      {initials(name)}
    </span>
  );
}
