import { useMemo } from 'react';

const COLORS = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#c56cf0', '#ff9f43', '#54a0ff'];

/** Deterministic pseudo-random numbers (the same confetti on every render). */
function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

/**
 * 0.5.5 birthday confetti: a few dozen pieces falling over the profile card. CSS only, no canvas;
 * reduced motion shows them resting at the top instead of falling.
 */
export function Confetti({ count = 36 }: { count?: number }) {
  const pieces = useMemo(() => {
    const rnd = seeded(7);
    return Array.from({ length: count }, (_, i) => ({
      left: `${Math.round(rnd() * 100)}%`,
      delay: `${(rnd() * 2.4).toFixed(2)}s`,
      duration: `${(2.6 + rnd() * 2).toFixed(2)}s`,
      color: COLORS[i % COLORS.length] ?? '#feca57',
      rotate: `${Math.round(rnd() * 360)}deg`,
      round: rnd() > 0.7,
    }));
  }, [count]);
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`confetti-piece${p.round ? ' is-round' : ''}`}
          style={{ left: p.left, background: p.color, animationDelay: p.delay, animationDuration: p.duration, rotate: p.rotate }}
        />
      ))}
    </div>
  );
}
