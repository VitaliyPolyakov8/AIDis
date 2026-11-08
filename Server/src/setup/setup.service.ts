import { readFile, unlink } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { SettingsService } from '../admin/settings.service.js';
import type { AuthService, DeviceInfo, TokenPair } from '../auth/auth.service.js';
import { CLIENT_TYPES } from '../auth/auth.service.js';
import { AppError } from '../common/errors.js';
import { parseInput, sanitizeText } from '../common/validation.js';
import type { PrismaClient } from '../db/prisma.js';
import type { GuildsService } from '../guilds/guilds.service.js';
import { newGuildTemplate } from '../guilds/template.js';
import type { InvitesService } from '../invites/invites.service.js';
import { displayNameSchema, passwordSchema, usernameSchema, type UsersService } from '../users/users.service.js';

const completeInput = z.object({
  code: z.string().trim().min(1).max(200),
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  email: z.email().max(254).optional(),
  guildName: z.string().transform(sanitizeText).pipe(z.string().min(1).max(100)),
  registrationMode: z.enum(['off', 'invite', 'open']),
  lang: z.enum(['ru', 'en']).default('en'),
  clientType: z.enum(CLIENT_TYPES).default('unknown'),
});

const setupDone = () => new AppError(403, 'SETUP_DONE', 'This AIDis is already set up');
const codeInvalid = () => new AppError(403, 'SETUP_CODE_INVALID', 'The setup code is wrong (deploy/setup.sh prints it)');

export type SetupResult = TokenPair & { guildId: string; inviteCode: string };

/**
 * First run: while there is no account at all, the person holding the one-time code that
 * deploy/setup.sh printed creates the administrator, the first server and the registration mode
 * in the browser. One backend process: requests are serialized here, so two browsers cannot both
 * become administrator.
 */
export class SetupService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UsersService,
    private readonly guilds: GuildsService,
    private readonly invites: InvitesService,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
    private readonly codeFile: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async needed(): Promise<boolean> {
    return (await this.prisma.user.count()) === 0;
  }

  complete(input: unknown, device: Omit<DeviceInfo, 'clientType'>): Promise<SetupResult> {
    const data = parseInput(completeInput, input);
    const run = this.queue.then(() => this.completeNow(data, device));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async completeNow(data: z.infer<typeof completeInput>, device: Omit<DeviceInfo, 'clientType'>): Promise<SetupResult> {
    if (!(await this.needed())) throw setupDone();
    if (!(await this.codeMatches(data.code))) throw codeInvalid();

    const admin = await this.users.create({ username: data.username, displayName: data.displayName, password: data.password, role: 'ADMIN', ...(data.email ? { email: data.email } : {}) });
    const guild = await this.guilds.createFromTemplate(admin.id, data.guildName, newGuildTemplate(data.lang));
    // Self-registration needs checked mail; until then the stored mode counts as "off" (RegistrationService.state).
    await this.settings.setValue('registration', { mode: data.registrationMode });
    const invite = await this.invites.create(admin, guild.id, { maxAgeSeconds: 0, maxUses: 0 });
    // The config folder is read-only inside the container: removing the code is best effort, the
    // wizard is closed by the existing account anyway.
    await unlink(this.codeFile).catch(() => undefined);
    this.log.info({ event: 'setup.completed', userId: admin.id, guildId: guild.id }, 'First-run setup completed');
    const tokens = await this.auth.startSession(admin, { ...device, clientType: data.clientType });
    return { ...tokens, guildId: guild.id, inviteCode: invite.code };
  }

  private async codeMatches(given: string): Promise<boolean> {
    let expected: string;
    try {
      expected = (await readFile(this.codeFile, 'utf8')).trim();
    } catch {
      return false;
    }
    if (expected.length < 16) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given.trim());
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
