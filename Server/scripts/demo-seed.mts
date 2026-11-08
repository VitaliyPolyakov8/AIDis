// Fills a FRESH AIDis with demo data for screenshots and for trying things out: people bob, carol and
// dave, a server "Demo" with channels, roles and a conversation, custom statuses and games in the
// tracker. It talks to the server over its normal HTTP API as an administrator.
//
// Never run it against an installation used by real people: it creates accounts with a known password.
//
//   npx tsx scripts/demo-seed.mts <server address> <admin login> <admin password>
//   npx tsx scripts/demo-seed.mts http://localhost:3000 alice 'alice-password-1'
//
// The demo accounts get the password from DEMO_PASSWORD (default: demo-password-1).

const [base = '', adminLogin = '', adminPassword = ''] = process.argv.slice(2);
if (!/^https?:\/\//.test(base) || !adminLogin || !adminPassword) {
  console.error('Usage: npx tsx scripts/demo-seed.mts <http(s)://server> <admin login> <admin password>');
  process.exit(1);
}
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-1';
const API = `${base.replace(/\/+$/, '')}/api/v1`;

interface Json {
  [key: string]: unknown;
}

async function call<T = Json>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const login = async (username: string, password: string) =>
  (await call<{ accessToken: string }>(null, 'POST', '/auth/login', { username, password, clientType: 'web' })).accessToken;

const admin = await login(adminLogin, adminPassword);

// ---- people ----------------------------------------------------------------------------------------------
const people = [
  { username: 'bob', displayName: 'Bob' },
  { username: 'carol', displayName: 'Carol' },
  { username: 'dave', displayName: 'Dave' },
];
for (const p of people) {
  try {
    await call(admin, 'POST', '/admin/users', { ...p, password: PASSWORD });
  } catch (error) {
    if (!String(error).includes('409')) throw error;
  }
}
const token: Record<string, string> = { [adminLogin]: admin };
for (const p of people) token[p.username] = await login(p.username, PASSWORD);

// ---- the server --------------------------------------------------------------------------------------------
// The server made in the first-run wizard is reused when it is called "Demo".
const mine = (await call<{ guilds: { id: string; name: string }[] }>(admin, 'GET', '/guilds')).guilds;
const guild = mine.find((g) => g.name === 'Demo') ?? (await call<{ guild: { id: string } }>(admin, 'POST', '/guilds', { name: 'Demo' })).guild;
const { invite } = await call<{ invite: { code: string } }>(admin, 'POST', `/guilds/${guild.id}/invites`, { maxAgeSeconds: 0, maxUses: 0 });
for (const p of people) await call(token[p.username] ?? '', 'POST', `/invites/${invite.code}/accept`);

type Channel = { id: string; type: string; name: string };
const existing = (await call<{ channels: Channel[] }>(admin, 'GET', `/guilds/${guild.id}/channels`)).channels;
const channel = async (type: 'TEXT' | 'VOICE' | 'CATEGORY', name: string, parentId?: string) =>
  existing.find((c) => c.type === type && c.name === name) ?? (await call<{ channel: Channel }>(admin, 'POST', `/guilds/${guild.id}/channels`, { type, name, parentId })).channel;

const general = existing.find((c) => c.type === 'TEXT') ?? (await channel('TEXT', 'general'));
const games = await channel('CATEGORY', 'Games');
const raids = await channel('TEXT', 'raid-planning', games.id);
await channel('TEXT', 'screenshots', games.id);
await channel('VOICE', 'Lounge');
await channel('VOICE', 'Raid night', games.id);

// ---- roles -------------------------------------------------------------------------------------------------
const role = async (name: string, color: string, permissions: string[]) =>
  (await call<{ role: { id: string } }>(admin, 'POST', `/guilds/${guild.id}/roles`, { name, color, permissions, hoist: true, mentionable: true })).role;
const moderators = await role('Moderators', '#5eb3f6', ['MANAGE_MESSAGES', 'KICK_MEMBERS', 'MOVE_USERS', 'MUTE_MEMBERS']);
const raidTeam = await role('Raid team', '#f4a261', []);
const me = async (t: string) => (await call<{ user: { id: string } }>(t, 'GET', '/auth/me')).user.id;
const ids: Record<string, string> = {};
for (const name of Object.keys(token)) ids[name] = await me(token[name] ?? '');
await call(admin, 'PUT', `/guilds/${guild.id}/members/${ids.bob}/roles`, { roleIds: [moderators.id, raidTeam.id] });
await call(admin, 'PUT', `/guilds/${guild.id}/members/${ids.carol}/roles`, { roleIds: [raidTeam.id] });

// ---- a conversation ----------------------------------------------------------------------------------------
const say = async (who: string, channelId: string, content: string) =>
  (await call<{ message: { id: string } }>(token[who] ?? '', 'POST', `/channels/${channelId}/messages`, { content })).message;
const react = (who: string, messageId: string, emoji: string) => call(token[who] ?? '', 'PUT', `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);

await say(adminLogin, general.id, 'Welcome to our own corner of the internet! Same server, our rules.');
const hi = await say('bob', general.id, 'Finally. No more "this server is full" messages.');
await react('carol', hi.id, '😂');
await say('carol', general.id, 'Who is up for a game tonight? I can host at 9.');
const plan = await say('dave', general.id, 'In! I will be a bit late, still finishing work.');
await react('bob', plan.id, '👍');
await say('bob', general.id, 'Lounge voice channel at 21:00 then. Bring snacks.');
await say(adminLogin, raids.id, 'Raid night checklist: repair gear, bring potions, nobody pulls before the countdown.');
const ready = await say('carol', raids.id, 'Countdown is my job. 3... 2...');
await react('dave', ready.id, '🔥');
await react(adminLogin, ready.id, '🔥');

// ---- statuses and games ------------------------------------------------------------------------------------
const status = (who: string, text: string, emoji: string) => call(token[who] ?? '', 'PATCH', '/users/me/status', { customStatus: { text, emoji, expiresAt: null } });
await status('bob', 'Moderating with snacks', '🍿');
await status('carol', 'Hosting at 21:00', '🎮');

const game = (who: string, name: string, platform: string, status: string) => call(token[who] ?? '', 'POST', '/users/me/games', { name, platform, status });
const shelf: [string, string, string, string][] = [
  [adminLogin, 'Hollow Lantern', 'PC', 'PLAYING'],
  [adminLogin, 'Skyline Racers', 'PLAYSTATION', 'COMPLETED'],
  [adminLogin, 'Farm Story Deluxe', 'SWITCH', 'HUNDRED'],
  [adminLogin, 'Deep Space Miner', 'PC', 'PAUSED'],
  [adminLogin, 'Puzzle Tower', 'MOBILE', 'DROPPED'],
  ['bob', 'Hollow Lantern', 'PC', 'COMPLETED'],
  ['bob', 'Castle Siege Online', 'PC', 'PLAYING'],
  ['carol', 'Skyline Racers', 'XBOX', 'PLAYING'],
  ['carol', 'Farm Story Deluxe', 'SWITCH', 'PLAYING'],
  ['dave', 'Castle Siege Online', 'PC', 'PLAYING'],
];
for (const [who, name, platform, st] of shelf) await game(who, name, platform, st);

console.log(`Demo data ready on ${base}: server "Demo", people bob / carol / dave (password ${PASSWORD}), invite ${base.replace(/\/+$/, '')}/invite/${invite.code}`);
