import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Static checks of the deployment files (Docker is not available on the development PC,
 * so `docker compose config` cannot run here). Interpolation of ${VAR}, ${VAR:-default}
 * and ${VAR:?error} is emulated with the values from .env.example.
 */

async function loadEnvExample(): Promise<Record<string, string>> {
  const text = await readFile('.env.example', 'utf8');
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? '';
  }
  return env;
}

const ESCAPED_DOLLAR = '@@ESCAPED_DOLLAR@@';

function interpolate(text: string, env: Record<string, string>): string {
  return text
    .replace(/\$\$/g, ESCAPED_DOLLAR)
    .replace(/\$\{([A-Z0-9_]+)(?:(:-|:\?)([^}]*))?\}/g, (_m, name: string, op: string | undefined, arg: string | undefined) => {
      const value = env[name];
      if (value !== undefined && value !== '') return value;
      if (op === ':?') throw new Error(`Required variable ${name} missing: ${arg ?? ''}`);
      return op === ':-' ? (arg ?? '') : '';
    })
    .split(ESCAPED_DOLLAR)
    .join('$');
}

interface ComposeService {
  ports?: string[];
  environment?: Record<string, string>;
  networks?: string[];
  volumes?: string[];
  restart?: string;
  healthcheck?: unknown;
}

async function loadCompose(file: string, env: Record<string, string>) {
  return parse(interpolate(await readFile(file, 'utf8'), env)) as {
    name: string;
    services: Record<string, ComposeService>;
    networks: Record<string, { internal?: boolean }>;
    volumes: Record<string, unknown>;
  };
}

describe('docker-compose.yml', () => {
  it('forwards the public settings and keeps uploads on the persistent volume', async () => {
    const env = { ...(await loadEnvExample()), STEAM_ART: 'true', VOICE_NODE_DOMAIN: 'chat.example.com' };
    const backend = (await loadCompose('docker-compose.yml', env)).services.backend;
    expect(backend?.environment).toMatchObject({ STEAM_ART: true, VOICE_NODE_DOMAIN: 'chat.example.com', GIF_PROVIDER: 'none' });
    expect(Object.keys(backend?.environment ?? {}).filter((k) => /TABLETOP|GAMES_HUB|CINEMA/.test(k))).toEqual([]);
    expect(backend?.volumes).toContain('uploads:/app/storage/uploads');
    expect(backend?.volumes).toContain('./config:/app/config:ro');
  });
  it('interpolates with .env.example and has the expected services', async () => {
    const env = await loadEnvExample();
    const compose = await loadCompose('docker-compose.yml', env);
    expect(compose.name).toBe('aidis');
    expect(Object.keys(compose.services).sort()).toEqual(['backend', 'livekit', 'postgres']);
    for (const service of Object.values(compose.services)) {
      expect(service.restart).toBe('unless-stopped');
    }
    expect(Object.keys(compose.volumes).sort()).toEqual(['pgdata', 'uploads']);
  });

  it('keeps PostgreSQL internal and never claims ports 80/443', async () => {
    const env = await loadEnvExample();
    const compose = await loadCompose('docker-compose.yml', env);
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.postgres?.networks).toEqual(['internal']);
    expect(compose.networks.internal?.internal).toBe(true);

    const allPorts = Object.values(compose.services).flatMap((s) => s.ports ?? []);
    for (const mapping of allPorts) {
      const parts = mapping.split(':');
      const hostPart = parts.length === 3 ? parts[1] : parts[0];
      expect(hostPart?.split('/')[0]).not.toMatch(/^(80|443|5432)$/);
    }
    expect(compose.services.backend?.ports).toEqual(['127.0.0.1:18080:3000']);
    expect(compose.services.livekit?.ports?.[0]).toBe('127.0.0.1:17880:7880');
  });

  it('maps WebRTC/TURN ports 1:1 and builds a valid LiveKit config', async () => {
    const env = await loadEnvExample();
    const compose = await loadCompose('docker-compose.yml', env);
    const livekit = compose.services.livekit;
    expect(livekit?.ports).toContain('50000-50100:50000-50100/udp');
    expect(livekit?.ports).toContain('17881:17881/tcp');
    expect(livekit?.ports).toContain('13478:13478/udp');

    const lk = parse(livekit?.environment?.LIVEKIT_CONFIG ?? '') as {
      port: number;
      rtc: { tcp_port: number; port_range_start: number; port_range_end: number; use_external_ip: boolean };
      turn: { enabled: boolean; udp_port: number; tls_port: number; domain: string };
    };
    expect(lk.port).toBe(7880);
    expect(lk.rtc).toMatchObject({ tcp_port: 17881, port_range_start: 50000, port_range_end: 50100, use_external_ip: true });
    expect(lk.turn).toMatchObject({ enabled: true, udp_port: 13478, tls_port: 0, domain: 'chat.example.com' });
    expect(livekit?.environment?.LIVEKIT_KEYS).toBe(`${env.LIVEKIT_API_KEY ?? ''}: ${env.LIVEKIT_API_SECRET ?? ''}`);
  });

  it('0.4.7: keeps the default LiveKit codec list (hardware H.264 High needs no SFU change)', async () => {
    // An explicit enabled_codecs list with only fmtp-specific H.264 entries makes LiveKit 1.13 treat
    // H.264 as disabled and silently fall back to VP8 (verified on a real 1.13.7 SFU), so none is set.
    const env = await loadEnvExample();
    const compose = await loadCompose('docker-compose.yml', env);
    const lk = parse(compose.services.livekit?.environment?.LIVEKIT_CONFIG ?? '') as { room: Record<string, unknown> };
    expect(lk.room.enabled_codecs).toBeUndefined();
  });

  it('never passes the LiveKit secret through anything but env vars', async () => {
    const raw = await readFile('docker-compose.yml', 'utf8');
    expect(raw).not.toMatch(/secret\s*:\s*[A-Za-z0-9]{16,}/i);
  });

  it('keeps TURN/TLS disabled by default', async () => {
    const env = await loadEnvExample();
    expect(env.TURN_TLS_HOST_PORT).toBe('0');
    expect(env.COMPOSE_FILE).toBeUndefined();
    const compose = await loadCompose('docker-compose.yml', env);
    expect(compose.services.livekit?.ports?.some((p) => p.endsWith('/tcp') && p.startsWith('0:'))).toBe(false);
  });
});

describe('deploy/setup.sh pieces', () => {
  it('starts LiveKit only with voice on (COMPOSE_PROFILES=voice)', async () => {
    const compose = (await loadCompose('docker-compose.yml', await loadEnvExample())) as unknown as { services: Record<string, { profiles?: string[] }> };
    expect(compose.services.livekit?.profiles).toEqual(['voice']);
    expect(compose.services.backend?.profiles).toBeUndefined();
    expect(compose.services.postgres?.profiles).toBeUndefined();
  });

  it('Caddy: host network, the web client read-only, certificates in a volume, no other ports', async () => {
    const compose = (await loadCompose('docker-compose.caddy.yml', {})) as unknown as { services: Record<string, { network_mode?: string; ports?: string[]; volumes?: string[] }>; volumes: Record<string, unknown> };
    expect(Object.keys(compose.services)).toEqual(['caddy']);
    expect(compose.services.caddy).toMatchObject({ network_mode: 'host' });
    expect(compose.services.caddy?.ports).toBeUndefined();
    expect(compose.services.caddy?.volumes).toEqual(expect.arrayContaining(['./Caddyfile:/etc/caddy/Caddyfile:ro', './web:/srv/web:ro', 'caddy_data:/data']));
    expect(Object.keys(compose.volumes).sort()).toEqual(['caddy_config', 'caddy_data']);
  });

  it('ships an example client-version.json; the real one belongs to the installation', async () => {
    const example = JSON.parse(await readFile('config/client-version.example.json', 'utf8')) as { desktop: Record<string, unknown> };
    expect(example.desktop).toMatchObject({ latestVersion: '1.0.0', minimumVersion: '1.0.0', updateMirrorUrl: '' });
  });
});

describe('.env.example without a real installation', () => {
  it('uses example.com names and a dedicated LiveKit subdomain', async () => {
    const env = await loadEnvExample();
    expect(env.PUBLIC_BASE_URL).toBe('https://chat.example.com');
    expect(env.CORS_ORIGINS).toBe('https://chat.example.com');
    expect(env.LIVEKIT_URL).toBe('wss://rtc.chat.example.com');
    expect(env.LIVEKIT_TURN_DOMAIN).toBe('chat.example.com');
    expect(env.STEAM_ART).toBe('false');
  });

  it('docs never proxy LiveKit under a /livekit path', async () => {
    for (const file of ['.env.example', 'docker-compose.yml', 'docker/livekit/README.md']) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/location \/livekit/);
    }
  });
});
