import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './logger';

/**
 * Game activity detection (0.3.0). Strictly external and read-only:
 *
 *  1. Steam: Steam itself records the game it launched in the registry
 *     (HKCU\Software\Valve\Steam\RunningAppID). The id is resolved to the game's name from Steam's
 *     own local files (libraryfolders.vdf + appmanifest_<id>.acf). No Steam login, API or network.
 *  2. Other launchers: the list of running process *image names* (tasklist.exe, the same list Task
 *     Manager shows) matched against a small built-in table of known games.
 *
 * Nothing is injected, no game process is opened, no memory is read, no handles are kept.
 * Unknown programs are never reported.
 *
 * 0.4.1: besides the display name the detector keeps a small GameInfo (Steam AppID, executable
 * image name, Steam install folder, when the game started). Only the name, the AppID and the start
 * time are ever published; the image name and folder stay on this PC (window matching for
 * "Stream <game>", the local executable icon).
 */

export const SCAN_INTERVAL_MS = 10_000;

/** Known games by executable (lower-case image name). Extend freely. */
export const KNOWN_GAMES: Readonly<Record<string, string>> = {
  'valorant-win64-shipping.exe': 'VALORANT',
  'league of legends.exe': 'League of Legends',
  'leagueoflegends.exe': 'League of Legends',
  'fortniteclient-win64-shipping.exe': 'Fortnite',
  'genshinimpact.exe': 'Genshin Impact',
  'starrail.exe': 'Honkai: Star Rail',
  'zenlesszonezero.exe': 'Zenless Zone Zero',
  'overwatch.exe': 'Overwatch 2',
  'wow.exe': 'World of Warcraft',
  'diablo iv.exe': 'Diablo IV',
  'hearthstone.exe': 'Hearthstone',
  'r5apex.exe': 'Apex Legends',
  'r5apex_dx12.exe': 'Apex Legends',
  'cs2.exe': 'Counter-Strike 2',
  'dota2.exe': 'Dota 2',
  'helldivers2.exe': 'Helldivers 2',
  'eldenring.exe': 'Elden Ring',
  'rocketleague.exe': 'Rocket League',
  'gta5.exe': 'Grand Theft Auto V',
  'gta5_enhanced.exe': 'Grand Theft Auto V',
  'rdr2.exe': 'Red Dead Redemption 2',
  'minecraft.windows.exe': 'Minecraft',
  'robloxplayerbeta.exe': 'Roblox',
  'osu!.exe': 'osu!',
  'escapefromtarkov.exe': 'Escape from Tarkov',
  'tslgame.exe': 'PUBG: Battlegrounds',
  'phasmophobia.exe': 'Phasmophobia',
  'lethal company.exe': 'Lethal Company',
  'deadbydaylight-win64-shipping.exe': 'Dead by Daylight',
  'rainbowsix.exe': 'Rainbow Six Siege',
  'rainbowsix_vulkan.exe': 'Rainbow Six Siege',
  'witcher3.exe': 'The Witcher 3',
  'cyberpunk2077.exe': 'Cyberpunk 2077',
  'bg3.exe': "Baldur's Gate 3",
  'bg3_dx11.exe': "Baldur's Gate 3",
  'factorio.exe': 'Factorio',
  'terraria.exe': 'Terraria',
  'stardew valley.exe': 'Stardew Valley',
  'warframe.x64.exe': 'Warframe',
  'destiny2.exe': 'Destiny 2',
  'pathofexile.exe': 'Path of Exile',
  'pathofexile_x64.exe': 'Path of Exile',
  'pathofexilesteam.exe': 'Path of Exile',
  'marvel-win64-shipping.exe': 'Marvel Rivals',
  'tf_win64.exe': 'Team Fortress 2',
  'left4dead2.exe': 'Left 4 Dead 2',
  'valheim.exe': 'Valheim',
  'rustclient.exe': 'Rust',
  'dayz_x64.exe': 'DayZ',
  'arma3_x64.exe': 'Arma 3',
  'palworld-win64-shipping.exe': 'Palworld',
  'sotgame.exe': 'Sea of Thieves',
  'starfield.exe': 'Starfield',
  'fallout4.exe': 'Fallout 4',
  'skyrimse.exe': 'The Elder Scrolls V: Skyrim',
  'hogwartslegacy.exe': 'Hogwarts Legacy',
  'monsterhunterwilds.exe': 'Monster Hunter Wilds',
  'monsterhunterworld.exe': 'Monster Hunter: World',
  'fsd-win64-shipping.exe': 'Deep Rock Galactic',
  'among us.exe': 'Among Us',
  'fallguys_client_game.exe': 'Fall Guys',
  'brawlhalla.exe': 'Brawlhalla',
  'factorygame-win64-shipping.exe': 'Satisfactory',
  'cod.exe': 'Call of Duty',
  'bf2042.exe': 'Battlefield 2042',
  'thefinals.exe': 'THE FINALS',
  'discovery.exe': 'THE FINALS',
  'wuthering waves.exe': 'Wuthering Waves',
};

/**
 * Official Steam AppIDs of known games, so their Steam artwork shows even when the game was not
 * started through Steam (or Steam did not record it). Games not on Steam are simply absent.
 */
export const KNOWN_STEAM_IDS: Readonly<Record<string, number>> = {
  'Overwatch 2': 2357570,
  'Diablo IV': 2344520,
  'Apex Legends': 1172470,
  'Counter-Strike 2': 730,
  'Dota 2': 570,
  'Helldivers 2': 553850,
  'Elden Ring': 1245620,
  'Rocket League': 252950,
  'Grand Theft Auto V': 271590,
  'Red Dead Redemption 2': 1174180,
  'PUBG: Battlegrounds': 578080,
  Phasmophobia: 739630,
  'Lethal Company': 1966720,
  'Dead by Daylight': 381210,
  'Rainbow Six Siege': 359550,
  'The Witcher 3': 292030,
  'Cyberpunk 2077': 1091500,
  "Baldur's Gate 3": 1086940,
  Factorio: 427520,
  Terraria: 105600,
  'Stardew Valley': 413150,
  Warframe: 230410,
  'Destiny 2': 1085660,
  'Path of Exile': 238960,
  'Marvel Rivals': 2767030,
  'Team Fortress 2': 440,
  'Left 4 Dead 2': 550,
  Valheim: 892970,
  Rust: 252490,
  DayZ: 221100,
  'Arma 3': 107410,
  Palworld: 1623730,
  'Sea of Thieves': 1172620,
  Starfield: 1716740,
  'Fallout 4': 377160,
  'The Elder Scrolls V: Skyrim': 489830,
  'Hogwarts Legacy': 990080,
  'Monster Hunter Wilds': 2246340,
  'Monster Hunter: World': 582010,
  'Deep Rock Galactic': 548430,
  'Among Us': 945360,
  'Fall Guys': 1097150,
  Brawlhalla: 291550,
  Satisfactory: 526870,
  'Call of Duty': 1938090,
  'Battlefield 2042': 1517290,
  'THE FINALS': 2073850,
};

/** What the detector knows about the running game. */
export interface GameInfo {
  name: string;
  /** Steam AppID (from Steam's own registry value, or the known table). */
  steamAppId: number | null;
  /** Lower-case executable image name, e.g. "eldenring.exe" (local only). */
  exe: string | null;
  /** Steam install folder of the game (local only). */
  installDir: string | null;
  /** When this game was first seen (ms). Kept across re-scans; a different game starts a new time. */
  startedAt: number;
}

/** Steam app ids that are tools, not games. */
const STEAM_TOOLS = new Set([228980, 1070560, 1391110, 1493710, 1628350, 250820, 1826330]);

// ---- pure parsers (unit-tested) -------------------------------------------------------

/** `reg query ... /v Name` output -> the value as text (REG_DWORD as a decimal string). */
export function parseRegValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line);
    if (!m || m[1]?.toLowerCase() !== name.toLowerCase()) continue;
    const value = (m[3] ?? '').trim();
    if (m[2] === 'REG_DWORD') return String(parseInt(value, 16));
    return value;
  }
  return null;
}

/** `tasklist /fo csv /nh` -> lower-case image names. */
export function parseTasklist(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m?.[1]) names.push(m[1].toLowerCase());
  }
  return names;
}

/** Library paths from Steam's libraryfolders.vdf (both the old and the new format). */
export function parseLibraryFolders(vdf: string): string[] {
  const paths: string[] = [];
  for (const m of vdf.matchAll(/"(?:path|\d+)"\s+"([^"]+)"/g)) {
    const value = (m[1] ?? '').replace(/\\\\/g, '\\');
    if (/^[a-zA-Z]:[\\/]/.test(value)) paths.push(value);
  }
  return [...new Set(paths)];
}

/** "installdir" from an appmanifest_<id>.acf (a folder name under steamapps/common). */
export function parseAppManifestInstallDir(acf: string): string | null {
  const m = /"installdir"\s+"([^"]+)"/.exec(acf);
  const dir = m?.[1]?.trim();
  return dir && !/[\\/]|\.\./.test(dir) ? dir : null;
}

/** "name" from an appmanifest_<id>.acf. */
export function parseAppManifestName(acf: string): string | null {
  const m = /"name"\s+"([^"]+)"/.exec(acf);
  return m?.[1] ? cleanGameName(m[1]) : null;
}

/** Trademark signs and stray whitespace removed; length-limited. */
export function cleanGameName(name: string): string {
  return name
    .replace(/[™®©]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** First known game among running image names. */
export function matchKnownGame(imageNames: readonly string[], table: Readonly<Record<string, string>> = KNOWN_GAMES): string | null {
  return matchKnownGameExe(imageNames, table)?.name ?? null;
}

/** First known game among running image names, with the image name that matched. */
export function matchKnownGameExe(imageNames: readonly string[], table: Readonly<Record<string, string>> = KNOWN_GAMES): { name: string; exe: string } | null {
  for (const exe of imageNames) {
    const name = table[exe];
    if (name) return { name, exe };
  }
  return null;
}

/**
 * The next GameInfo: same game (by name) keeps its start time and fills in what it did not know
 * yet; another game, or none before, starts now.
 */
export function nextGameInfo(previous: GameInfo | null, found: Omit<GameInfo, 'startedAt'> | null, now = Date.now()): GameInfo | null {
  if (!found) return null;
  if (previous?.name === found.name) {
    return {
      ...previous,
      steamAppId: found.steamAppId ?? previous.steamAppId,
      exe: found.exe ?? previous.exe,
      installDir: found.installDir ?? previous.installDir,
    };
  }
  return { ...found, startedAt: now };
}

// ---- detector ---------------------------------------------------------------------------

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

export class GameDetector extends EventEmitter<{ change: [string | null]; info: [GameInfo | null] }> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private steamPath: string | null | undefined;
  private readonly steamApps = new Map<number, { name: string; installDir: string | null } | null>();
  current: string | null = null;
  /** 0.4.1: details of the current game (null when none). */
  info: GameInfo | null = null;

  start(): void {
    if (this.timer || process.platform !== 'win32') return;
    this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setCurrent(null);
  }

  async scan(): Promise<string | null> {
    if (this.running) return this.current;
    this.running = true;
    try {
      const steam = await this.steamGame();
      let found: Omit<GameInfo, 'startedAt'> | null = steam;
      if (!found) {
        const known = matchKnownGameExe(parseTasklist(await run('tasklist.exe', ['/fo', 'csv', '/nh'])));
        // 0.5.8: games found by their process get their Steam id from the installed Steam games
        // (by name), so their artwork shows everywhere even when Steam did not start them.
        if (known) found = { name: known.name, exe: known.exe, steamAppId: KNOWN_STEAM_IDS[known.name] ?? (await this.steamIdByName(known.name)), installDir: null };
      }
      this.setInfo(nextGameInfo(this.info, found));
    } catch (error) {
      logger.warn('activity', 'Game scan failed', error);
    } finally {
      this.running = false;
    }
    return this.current;
  }

  private setCurrent(game: string | null): void {
    this.setInfo(game ? nextGameInfo(this.info, { name: game, steamAppId: null, exe: null, installDir: null }) : null);
  }

  private setInfo(info: GameInfo | null): void {
    const changedGame = (info?.name ?? null) !== this.current;
    const changedInfo = JSON.stringify(info) !== JSON.stringify(this.info);
    this.info = info;
    if (changedGame) {
      this.current = info?.name ?? null;
      logger.info('activity', info ? `Game detected: ${info.name}${info.steamAppId ? ` (Steam ${String(info.steamAppId)})` : ''}` : 'Game closed');
      this.emit('change', this.current);
    }
    if (changedGame || changedInfo) this.emit('info', info);
  }

  private installedByName: { at: number; byName: Map<string, number> } | null = null;

  private async steamGame(): Promise<Omit<GameInfo, 'startedAt'> | null> {
    const out = await run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID']);
    const id = Number(parseRegValue(out, 'RunningAppID') ?? 0);
    if (!Number.isInteger(id) || id <= 0 || STEAM_TOOLS.has(id)) return null;
    if (!this.steamApps.has(id)) this.steamApps.set(id, await this.steamApp(id));
    const app = this.steamApps.get(id);
    return app ? { name: app.name, steamAppId: id, exe: null, installDir: app.installDir } : null;
  }

  /** Steam library folders of this PC (main install first); [] without Steam. */
  private async steamLibraries(): Promise<string[]> {
    if (this.steamPath === undefined) {
      const out = await run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
      this.steamPath = parseRegValue(out, 'SteamPath');
    }
    if (!this.steamPath) return [];
    const libraries = [this.steamPath];
    try {
      libraries.push(...parseLibraryFolders(await readFile(join(this.steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
    } catch {
      /* no library file: only the main library */
    }
    return [...new Set(libraries)];
  }

  /** 0.5.8: Steam id of an installed game by its name (manifests read at most every 10 minutes). */
  private async steamIdByName(name: string): Promise<number | null> {
    if (!this.installedByName || Date.now() - this.installedByName.at > 10 * 60_000) {
      const byName = new Map<string, number>();
      for (const library of await this.steamLibraries()) {
        const dir = join(library, 'steamapps');
        const files = await readdir(dir).catch(() => [] as string[]);
        for (const file of files) {
          const id = /^appmanifest_(\d+)\.acf$/.exec(file)?.[1];
          if (!id) continue;
          const acf = await readFile(join(dir, file), 'utf8').catch(() => '');
          const title = parseAppManifestName(acf);
          if (title) byName.set(normalizeGameName(title), Number(id));
        }
      }
      this.installedByName = { at: Date.now(), byName };
    }
    return this.installedByName.byName.get(normalizeGameName(name)) ?? null;
  }

  private async steamApp(id: number): Promise<{ name: string; installDir: string | null } | null> {
    for (const library of await this.steamLibraries()) {
      try {
        const acf = await readFile(join(library, 'steamapps', `appmanifest_${String(id)}.acf`), 'utf8');
        const name = parseAppManifestName(acf);
        const dir = parseAppManifestInstallDir(acf);
        if (name) return { name, installDir: dir ? join(library, 'steamapps', 'common', dir) : null };
      } catch {
        /* not in this library */
      }
    }
    return null;
  }
}

/** Lower-case name without marks and punctuation ("HADES™" and "Hades" are the same game). */
export function normalizeGameName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
