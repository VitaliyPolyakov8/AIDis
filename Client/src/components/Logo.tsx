import { config } from '../config';
import logoUrl from '../assets/brand/aidis-logo-256.png';

/** The official AIDis logo (square PNG with transparent background; never stretched). */
export function LogoMark({ size = 28 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden="true" className="logo-mark" draggable={false} />;
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-name">{config.appName}</span>
    </span>
  );
}
