import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RotateCcw } from 'lucide-react';

/** Small, self-contained toy: never captures a click outside its own shelf. */
export function HalloweenCorner() {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(true);
  const [lit, setLit] = useState(false);
  const [potion, setPotion] = useState(0);
  const [candies, setCandies] = useState(0);
  const [ghost, setGhost] = useState(0);
  const [message, setMessage] = useState('hint');
  const complete = candies === 5;
  const label = (key: string) => t(`halloween.${key}`);

  return (
    <section className={`halloween-corner${lit ? ' is-lit' : ''}${complete ? ' is-complete' : ''}`} aria-label={label('title')}>
      <button type="button" className="halloween-heading" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="halloween-heading-dot" aria-hidden="true" />
        <span>{label('title')}</span>
        <ChevronDown size={14} className={open ? '' : 'is-closed'} aria-hidden="true" />
      </button>
      {open && <div id={id}>
        <div className="halloween-scene" data-potion={potion}>
          <svg className="halloween-backdrop" viewBox="0 0 240 136" fill="none" aria-hidden="true">
            <path d="M144 92V42a30 30 0 0 1 60 0v50z" fill="#27223d" stroke="#54405f" strokeWidth="2" />
            <path d="M174 13v79m-30-43h60" stroke="#54405f" strokeWidth="2" />
            <path d="M188 23a14 14 0 1 0 9 23 15 15 0 0 1-9-23" fill="#f6daa1" />
            <path d="m151 67 4-7 4 7-4-2zm29 12 4-7 4 7-4-2z" fill="#9374a6" />
            <path d="M3 8q115 30 234 0" stroke="#786074" />
            <g fill="#d99a54"><path d="m17 11 9 2-6 15zM68 21l9 1-5 14zM169 20l9-1-3 15zM218 12l9-2-1 16z" /></g>
            <g fill="#9b7ab5"><path d="m42 17 9 1-5 15zM93 24h9l-5 14zM144 24l9-1-4 15zM194 17l9-1-3 15z" /></g>
            <g fill="#e2c6a1"><circle cx="22" cy="57" r="1.3"/><circle cx="121" cy="57" r="1"/><path d="m108 30 1.5 4.5L114 36l-4.5 1.5L108 42l-1.5-4.5L102 36l4.5-1.5z"/></g>
            <ellipse cx="69" cy="121" rx="47" ry="5" fill="#090910" opacity=".5" />
            <ellipse cx="172" cy="121" rx="38" ry="5" fill="#090910" opacity=".5" />
            <path d="M8 125h224l-5 8H13z" fill="#5c3f45"/><path d="M8 125h224" stroke="#be8657" strokeWidth="2"/>
          </svg>
          <button type="button" className="halloween-toy halloween-ghost" aria-label={label('ghost')} title={label('ghost')} onClick={() => { setGhost((n) => n + 1); setMessage(ghost % 2 ? 'ghostShy' : 'ghostHello'); }}>
            <svg key={ghost} viewBox="0 0 56 64" aria-hidden="true" className={ghost ? 'halloween-hello' : ''}>
              <path d="M10 54V28C10 3 47 3 47 28v26l-10-6-8 7-9-6z" fill="#ece4f4" />
              <path d="M10 37 3 42m43-5 7-6" stroke="#ece4f4" strokeWidth="6" strokeLinecap="round" />
              <ellipse cx="23" cy="28" rx="2.3" ry={ghost % 2 ? 1 : 3.5} fill="#3b304e"/><ellipse cx="36" cy="28" rx="2.3" ry={ghost % 2 ? 1 : 3.5} fill="#3b304e"/>
              <path d="M26 37q4 5 8 0" fill="none" stroke="#3b304e" strokeWidth="2" strokeLinecap="round"/>
              <g fill="#d49fb8" opacity=".65"><ellipse cx="17" cy="35" rx="4" ry="2"/><ellipse cx="42" cy="35" rx="4" ry="2"/></g>
            </svg>
          </button>
          <button type="button" className="halloween-toy halloween-lantern" aria-label={label('pumpkin')} aria-pressed={lit} title={label('pumpkin')} onClick={() => { setLit(!lit); setMessage(lit ? 'lightsOff' : 'lightsOn'); }}>
            <svg viewBox="0 0 94 88" aria-hidden="true">
              <path d="M47 23q-3-14 9-17" fill="none" stroke="#79936a" strokeWidth="6" strokeLinecap="round"/>
              <path d="M49 16q13-10 19-3-7 8-19 3" fill="#597951"/>
              <ellipse cx="29" cy="52" rx="23" ry="29" fill="#c45b29"/><ellipse cx="65" cy="52" rx="23" ry="29" fill="#ce642b"/>
              <ellipse cx="47" cy="52" rx="25" ry="32" fill="#ee8637"/>
              <path d="M43 22c-13 17-14 43-3 60m13-60c13 17 14 43 3 60" stroke="#d66c2a" strokeWidth="2" fill="none"/>
              <g className="halloween-carving"><path d="m24 47 13-9 2 13zm46 0-13-9-2 13zM25 60l10 4 3-5 7 7h5l7-7 3 5 10-4q-6 20-23 17Q30 77 25 60"/></g>
              <path d="M18 35q3-6 8-7" stroke="#ffb161" strokeWidth="3" strokeLinecap="round"/>
            </svg>
          </button>
          <button type="button" className="halloween-toy halloween-cauldron" aria-label={label('potion')} title={label('potion')} onClick={() => { const next = (potion + 1) % 3; setPotion(next); setMessage(`potion${next}`); }}>
            <svg viewBox="0 0 82 92" aria-hidden="true">
              <g className="halloween-bubbles" key={potion}><circle cx="28" cy="19" r="4"/><circle cx="48" cy="10" r="3"/><circle cx="53" cy="27" r="5"/></g>
              <path d="m22 78-5 9m43-9 5 9" stroke="#74647f" strokeWidth="5" strokeLinecap="round"/>
              <path d="M15 41C-3 51 9 69 17 61m50-20c18 10 6 28-2 20" stroke="#756583" strokeWidth="4" fill="none"/>
              <path d="M17 37C-8 81 23 87 41 87s49-6 24-50" fill="#393047" stroke="#756583" strokeWidth="2"/>
              <ellipse cx="41" cy="38" rx="27" ry="8" fill="#796287"/><ellipse cx="41" cy="37" rx="22" ry="5" className="halloween-brew"/>
              <path d="m40 53 3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#be9e74"/>
              <path d="M22 51q-4 12 3 18" stroke="#9680a7" strokeWidth="3" fill="none" strokeLinecap="round"/>
            </svg>
          </button>
          <button type="button" className="halloween-toy halloween-candy" aria-label={label('candy')} title={label('candy')} disabled={complete} onClick={() => { const next = candies + 1; setCandies(next); setMessage(next === 5 ? 'complete' : `candy${next}`); }}>
            <svg viewBox="0 0 60 44" aria-hidden="true">
              <path d="m8 17-5-9 12 2m30 7 11-7-1 13" fill="#ce91b5"/><rect x="10" y="9" width="18" height="11" rx="4" fill="#b5a0e9" transform="rotate(-20 19 14)"/><rect x="31" y="12" width="18" height="11" rx="4" fill="#efb864" transform="rotate(15 40 17)"/>
              <path d="M5 20h50l-9 19H14z" fill="#976184"/><path d="M5 20h50" stroke="#e4adcd" strokeWidth="3"/><path d="M25 25v8m9-8v8" stroke="#cb97bb" strokeWidth="2"/>
            </svg>
            <span className="halloween-candy-count">{candies}/5</span>
          </button>
          {complete && <div className="halloween-reward" aria-hidden="true"><span>✧</span><span>✦</span><span>✧</span><span>✦</span><span>✧</span></div>}
        </div>
        <div className="halloween-caption">
          <p role="status" aria-live="polite">{label(message)}</p>
          {complete && <button type="button" className="halloween-reset" aria-label={label('reset')} title={label('reset')} onClick={() => { setCandies(0); setMessage('hint'); }}><RotateCcw size={14} /></button>}
        </div>
      </div>}
    </section>
  );
}
