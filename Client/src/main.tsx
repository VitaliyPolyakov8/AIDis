import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import '@fontsource-variable/onest/wght.css';
import './styles/base.css';
import './styles/login.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/voice.css';
import './styles/overlays.css';
import './styles/desktop.css';
import './styles/v040.css';
import './styles/v041.css';
import './styles/v045.css';
import './styles/v050.css';
import './styles/v051.css';
import './styles/v052.css';
import './styles/v055.css';
import './styles/v056.css';
import './styles/v058.css';
import './styles/v070.css';
import './styles/games.css';
import './styles/pwa.css';
import { App } from './App';
import { initDesktop } from './desktop/desktopStore';
import { initWebApp } from './pwa/webApp';

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

// Inside AIDis Desktop: load the encrypted session and shell settings before the first render.
// In a browser this resolves immediately.
await initDesktop();
// 0.5.9: in a browser (also the iPhone / iPad home-screen app): PWA, iOS layout and background sound.
initWebApp();

if (import.meta.env.DEV) (await import('./devHandles')).exposeDevHandles();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
