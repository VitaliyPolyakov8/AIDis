import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../stores/settingsStore';
import { useNow } from '../hooks/useNow';
import { activeSeason, type Season } from '../utils/season';
import { HalloweenCorner } from './seasonal/HalloweenCorner';
import '../styles/halloween.css';

/**
 * 0.5.5 seasonal decorations that switch on by themselves (Settings -> Appearance can force or
 * disable them): falling snow around New Year, pumpkins and bats around Halloween. The season is
 * also set as data-season on <html>. Halloween occupies its own shelf in the sidebar;
 * snow stays a non-interactive overlay. Reduced motion disables decorative movement.
 */
export function SeasonalDecor() {
  const setting = useSettingsStore((s) => s.seasonalTheme);
  // Re-checked once an hour (crossing midnight into a season).
  const now = useNow(3600_000, setting === 'auto');
  const season = activeSeason(setting, new Date(now));

  useEffect(() => {
    if (season) document.documentElement.setAttribute('data-season', season);
    else document.documentElement.removeAttribute('data-season');
    return () => document.documentElement.removeAttribute('data-season');
  }, [season]);

  if (!season) return null;
  return season === 'newyear' ? <Snow /> : <HalloweenCorner />;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Light snowfall on a canvas (about 70 flakes, ~30 FPS, paused while the window is hidden). */
function Snow() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || prefersReducedMotion()) return;
    let width = 0;
    let height = 0;
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    const flakes = Array.from({ length: 70 }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 1 + Math.random() * 2.4,
      speed: 0.35 + Math.random() * 0.9,
      drift: Math.random() * Math.PI * 2,
    }));
    let frame = 0;
    let last = 0;
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (document.hidden || time - last < 33) return;
      last = time;
      context.clearRect(0, 0, width, height);
      context.fillStyle = 'rgba(255, 255, 255, 0.75)';
      for (const f of flakes) {
        f.y += f.speed;
        f.drift += 0.01;
        f.x += Math.sin(f.drift) * 0.4;
        if (f.y > height + 4) {
          f.y = -4;
          f.x = Math.random() * width;
        }
        context.beginPath();
        context.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        context.fill();
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return createPortal(<canvas ref={ref} className="seasonal-snow" aria-hidden="true" />, document.body);
}

export type { Season };
