import type { PublicUser } from '../../api/types';
import { useNameStyle } from './nameStyle';

/** 0.5.6: a display name drawn in the user's name style (color, gradient, glow, font), live. */
export function StyledName({ userId, name, fallback = null }: { userId: string | null | undefined; name: string; fallback?: Partial<PublicUser> | null }) {
  const style = useNameStyle(userId, fallback);
  return (
    <span className={style.className} style={style.style}>
      {name}
    </span>
  );
}
