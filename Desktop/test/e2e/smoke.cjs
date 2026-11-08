// End-to-end smoke test of the built AIDis Desktop (production mode, aidis://app).
// Run `npm run build` first, then `npm run test:e2e`. Uses an isolated profile in build/e2e-profile,
// talks to the server in AIDIS_E2E_SERVER (no login; API checks are skipped without it), sends real
// key presses and captures the primary screen.
const { _electron: electron } = require('playwright-core');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..');
const VERSION = require(path.join(APP, 'package.json')).version;
const PROFILE = path.join(APP, 'build', 'e2e-profile');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Real keyboard events (keybd_event) via a tiny PowerShell helper; virtual-key codes in hex.
function sendKeys(vks) {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'keys.ps1'), vks]);
}

async function launch() {
  const app = await electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron.exe'),
    args: [APP],
    env: { ...process.env, AIDIS_USER_DATA_DIR: PROFILE, AIDIS_QUIET: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  let { app, page } = await launch();

  // ---- loading & security ----
  await page.waitForSelector('.login-card, .splash', { timeout: 20000 });
  check('loads bundled client from aidis://app', page.url().startsWith('aidis://app/'), page.url());
  const sec = await page.evaluate(() => ({
    isDesktop: window.aidisDesktop?.isDesktop,
    keys: Object.keys(window.aidisDesktop ?? {}),
    require: typeof window.require,
    process: typeof window.process,
    ipc: typeof window.ipcRenderer,
    electron: typeof window.electron,
    secure: window.isSecureContext,
  }));
  check('desktop bridge exposed', sec.isDesktop === true, sec.keys.join(','));
  check('no Node APIs in page', sec.require === 'undefined' && sec.process === 'undefined' && sec.ipc === 'undefined', JSON.stringify(sec));
  check('secure context', sec.secure === true);
  // 0.3.1: RNNoise needs WebAssembly under the strict CSP ('wasm-unsafe-eval'). (JS eval cannot be
  // probed from here: DevTools evaluation is exempt from CSP; the header check below covers it.)
  const wasmOk = await page.evaluate(() => {
    try {
      new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      return true;
    } catch {
      return false;
    }
  });
  check('CSP allows WebAssembly (noise suppression)', wasmOk);
  const csp = await page.evaluate(async () => (await fetch('/index.html')).headers.get('content-security-policy'));
  check('CSP header on bundled files', !!csp && csp.includes("script-src 'self'") && !csp.includes("'unsafe-eval'"), csp ?? 'missing');
  const traversal = await page.evaluate(async () => (await fetch('/..%2f..%2fpackage.json')).status);
  check('path traversal blocked', traversal === 404, `status ${traversal}`);
  const loginText = await page.textContent('body');
  check('login screen rendered', /AIDis/.test(loginText ?? ''));
  const logo = await page.evaluate(() => {
    const img = document.querySelector('img.logo-mark');
    return img ? { w: img.naturalWidth, h: img.naturalHeight, cw: img.clientWidth, ch: img.clientHeight } : null;
  });
  check('new logo shown on login (not stretched)', !!logo && logo.w === logo.h && logo.cw === logo.ch, JSON.stringify(logo));

  // ---- API through the CORS bridge (the server in AIDIS_E2E_SERVER, chosen in the app first) ----
  const server = process.env.AIDIS_E2E_SERVER;
  if (server) {
    const api = await page.evaluate(async (origin) => {
      const r = await fetch(`${origin}/api/v1/client/config`);
      return { status: r.status, body: await r.json().catch(() => null) };
    }, server);
    check('API reachable from aidis://app (CORS bridge)', api.status === 200, JSON.stringify(api.body));
    const sock = await page.evaluate(async (origin) => {
      const r = await fetch(`${origin}/socket.io/?EIO=4&transport=polling`);
      return { status: r.status, text: (await r.text()).slice(0, 60) };
    }, server);
    check('Socket.IO handshake reachable (CORS bridge)', sock.status === 200 && sock.text.startsWith('0{'), sock.text);
  } else {
    console.log('SKIP API checks (set AIDIS_E2E_SERVER=https://your.server and pick it in the app)');
  }
  const blocked = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return 'allowed';
    } catch {
      return 'blocked';
    }
  });
  check('CSP blocks other hosts', blocked === 'blocked');

  // ---- microphone pipeline worklet loads under the production CSP ----
  const workletFile = fs.readdirSync(path.join(APP, 'build', 'renderer', 'assets')).find((f) => f.startsWith('micGate.worklet'));
  const worklet = await page.evaluate(async (file) => {
    try {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(`/assets/${file}`);
      const node = new AudioWorkletNode(ctx, 'aidis-mic-gate');
      node.disconnect();
      await ctx.close();
      return 'ok';
    } catch (e) {
      return String(e);
    }
  }, workletFile);
  check('mic gate worklet loads under CSP', worklet === 'ok', `${workletFile}: ${worklet}`);
  const updates = await page.evaluate(() => window.aidisDesktop.updates.getState());
  check('updater off in a development run', updates.status === 'unsupported', JSON.stringify(updates));

  // ---- settings, info, storage ----
  const info = await page.evaluate(() => window.aidisDesktop.app.getInfo());
  check('app info', info.appVersion === VERSION, `${info.appVersion}, Electron ${info.electronVersion}, secureStorage ${info.secureStorage}`);
  const settings = await page.evaluate(() => window.aidisDesktop.settings.get());
  check('default keybinds', settings.keybinds.toggleMute === 'Ctrl+Shift+M' && settings.keybinds.pushToTalk === null, JSON.stringify(settings.keybinds));
  const conflict = await page.evaluate(() => window.aidisDesktop.settings.update({ keybinds: { toggleDeafen: 'Ctrl+Shift+M' } }));
  check('duplicate keybind rejected', conflict.ok === false && conflict.error === 'conflict', JSON.stringify(conflict));
  const bad = await page.evaluate(() => window.aidisDesktop.settings.update({ keybinds: { toggleMute: 'Space' } }));
  check('typing-breaking single key rejected', bad.ok === false && bad.error === 'reserved');
  const single = await page.evaluate(() => window.aidisDesktop.settings.update({ keybinds: { disconnectVoice: 'F8' } }));
  check('single-key hotkey accepted', single.ok === true);
  await page.evaluate(() => window.aidisDesktop.settings.update({ keybinds: { disconnectVoice: null } }));
  const clamp = await page.evaluate(() => window.aidisDesktop.settings.update({ streaming: { bitrateMode: 'custom', customBitrateMbps: 999 } }));
  check('custom bitrate clamped', clamp.ok && clamp.settings.streaming.customBitrateMbps === 30);
  await page.evaluate(() => window.aidisDesktop.settings.update({ streaming: { bitrateMode: 'auto' } }));

  await page.evaluate(() => window.aidisDesktop.auth.save({ refreshToken: 'test-refresh-token-not-real-123456', sessionId: 'test-session' }));
  const raw = fs.readFileSync(path.join(PROFILE, 'session.bin'));
  check('session stored encrypted (DPAPI)', !raw.toString('latin1').includes('test-refresh-token'), `${raw.length} bytes`);
  const loaded = await page.evaluate(() => window.aidisDesktop.auth.load());
  check('session decrypts', loaded?.refreshToken === 'test-refresh-token-not-real-123456');
  await page.evaluate(() => window.aidisDesktop.auth.clear());
  check('session cleared', !fs.existsSync(path.join(PROFILE, 'session.bin')));

  // ---- hotkeys (real key presses; skipped while another AIDis is running, it owns the hotkeys) ----
  const otherAidis = require('node:child_process').execSync('tasklist /FI "IMAGENAME eq AIDis.exe"').toString().includes('AIDis.exe');
  if (otherAidis) {
    console.log('SKIP hotkey and key-press checks: an installed AIDis is running (it would receive the key presses)');
  } else {
    const registered = await app.evaluate(({ globalShortcut }) => ({
      mute: globalShortcut.isRegistered('Ctrl+Shift+M'),
      deafen: globalShortcut.isRegistered('Ctrl+Shift+D'),
      window: globalShortcut.isRegistered('Ctrl+Alt+Shift+A'),
    }));
    check('global shortcuts registered', registered.mute && registered.deafen && registered.window, JSON.stringify(registered));
    await app.evaluate(({ ipcMain }) => {
      globalThis.__states = [];
      ipcMain.on('voice:state', (_e, s) => globalThis.__states.push(s));
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await page.waitForTimeout(500);
    sendKeys('11,10,4D');
    await page.waitForTimeout(800);
    let states = await app.evaluate(() => globalThis.__states);
    check('mute hotkey works while minimized/unfocused', states.some((s) => s.micEnabled === false), JSON.stringify(states));
    sendKeys('11,10,44');
    await page.waitForTimeout(800);
    states = await app.evaluate(() => globalThis.__states);
    check('deafen hotkey works while minimized/unfocused', states.some((s) => s.deafened === true), JSON.stringify(states.at(-1)));
    sendKeys('11,10,44');
    await page.waitForTimeout(400);
    sendKeys('11,10,4D');
    await page.waitForTimeout(600);

    // single-key global hotkey (0.2.3): F8 alone toggles deafen while minimized
    await page.evaluate(() => window.aidisDesktop.settings.update({ keybinds: { toggleDeafen: 'F8' } }));
    await page.waitForTimeout(300);
    const before = (await app.evaluate(() => globalThis.__states)).length;
    sendKeys('77');
    await page.waitForTimeout(800);
    const afterF8 = await app.evaluate(() => globalThis.__states);
    check('single-key hotkey (F8) works while minimized', afterF8.length > before && afterF8.at(-1).deafened === true, JSON.stringify(afterF8.at(-1)));
    sendKeys('77');
    await page.waitForTimeout(400);
    await page.evaluate(() => window.aidisDesktop.settings.update({ keybinds: { toggleDeafen: 'Ctrl+Shift+D' } }));

    // uiohook sees key down AND up globally (the mechanism behind PTT)
    await app.evaluate((_e, hookPath) => {
      globalThis.__aidisHookPath = hookPath;
    }, path.join(APP, 'node_modules', 'uiohook-napi'));
    const hook = await app.evaluate(async () => {
      const { uIOhook, UiohookKey } = process.mainModule.require(globalThis.__aidisHookPath);
      globalThis.__hook = [];
      const down = (e) => e.keycode === UiohookKey.F13 && globalThis.__hook.push('down');
      const up = (e) => e.keycode === UiohookKey.F13 && globalThis.__hook.push('up');
      uIOhook.on('keydown', down);
      uIOhook.on('keyup', up);
      uIOhook.start();
      globalThis.__stopHook = () => {
        uIOhook.off('keydown', down);
        uIOhook.off('keyup', up);
        uIOhook.stop();
      };
      return true;
    });
    sendKeys('7C');
    await page.waitForTimeout(500);
    const hookEvents = await app.evaluate(() => {
      globalThis.__stopHook();
      return globalThis.__hook;
    });
    check('global key down/up hook (PTT mechanism) receives events', hook && hookEvents.includes('down') && hookEvents.includes('up'), JSON.stringify(hookEvents));

  }

  // ---- capture ----
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
  const sources = await page.evaluate(() => window.aidisDesktop.capture.getSources());
  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind === 'window');
  check('source picker lists screens and windows', screens.length > 0, `${screens.length} screens, ${windows.length} windows, thumbnails ${sources.filter((s) => s.thumbnail).length}`);
  const ownListed = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMediaSourceId());
  check('own window excluded from picker', !sources.some((s) => s.id === ownListed));
  const unarmed = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      return 'granted';
    } catch (e) {
      return e.name;
    }
  });
  check('getDisplayMedia without a picked source is denied', unarmed !== 'granted', unarmed);

  for (const [w, h, fps] of [
    [1280, 720, 30],
    [1920, 1080, 60],
    [2560, 1440, 60],
  ]) {
    const r = await page.evaluate(
      async ({ id, w, h, fps }) => {
        const ok = await window.aidisDesktop.capture.select({ sourceId: id, audio: true });
        if (!ok) return { error: 'select failed' };
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { max: w }, height: { max: h }, frameRate: { ideal: fps, max: Math.min(120, fps * 2) } },
          audio: { restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const v = stream.getVideoTracks()[0];
        await new Promise((r) => setTimeout(r, 1200));
        v.contentHint = 'motion';
        const motionHint = v.contentHint;
        v.contentHint = 'text';
        const textHint = v.contentHint;
        const s = v.getSettings();
        const a = stream.getAudioTracks()[0];
        const out = { width: s.width, height: s.height, frameRate: s.frameRate, audio: a ? a.getSettings().restrictOwnAudio : null, hints: `${motionHint}/${textHint}` };
        stream.getTracks().forEach((t) => t.stop());
        return out;
      },
      { id: screens[0].id, w, h, fps },
    );
    check(`capture ${h}p${fps}`, !r.error && r.width <= w && r.height <= h && r.frameRate <= Math.min(120, fps * 2) && r.hints === 'motion/text', JSON.stringify(r));
  }

  // ---- window state + close to tray ----
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 140, y: 120, width: 1111, height: 777 }));
  await page.waitForTimeout(800);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(500);
  const hidden = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { exists: !!w, visible: w?.isVisible() };
  });
  check('close button hides to tray (app keeps running)', hidden.exists && hidden.visible === false, JSON.stringify(hidden));

  // single instance: a second launch must exit and show the existing window
  const second = spawn(path.join(APP, 'node_modules/electron/dist/electron.exe'), [APP], {
    env: { ...process.env, AIDIS_USER_DATA_DIR: PROFILE },
  });
  const code = await new Promise((r) => second.on('exit', r));
  await page.waitForTimeout(800);
  const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  check('second instance exits and focuses the first', code === 0 && shown, `exit ${code}, visible ${shown}`);

  // real quit (tray "Quit" path): process must exit
  const pid = app.process().pid;
  await app.evaluate(({ app: a }) => {
    a.quit();
  });
  await new Promise((r) => setTimeout(r, 2500));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  check('quit terminates the process', !alive);

  ({ app, page } = await launch());
  await page.waitForTimeout(1500);
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  // Display scaling can round the restored size by a few pixels.
  const near = (a, b) => Math.abs(a - b) <= 4;
  check('window size/position restored', near(bounds.width, 1111) && near(bounds.height, 777) && near(bounds.x, 140), JSON.stringify(bounds));
  const log = fs.readFileSync(path.join(PROFILE, 'logs', 'main.log'), 'utf8');
  check('log written, no token leaked', log.includes(`AIDis Desktop ${VERSION} starting`) && !log.includes('test-refresh-token'), `${log.split('\n').length} lines`);
  await app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
