import nodemailer, { type SendMailOptions } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { SettingsService } from '../admin/settings.service.js';
import { AppError } from '../common/errors.js';
import type { SecretBox } from '../common/secret-box.js';
import { parseInput } from '../common/validation.js';
import { renderLetter, type MailLang, type MailTemplate } from './templates.js';

export type { MailLang, MailTemplate } from './templates.js';

const KEY = 'mail';

export type MailSecurity = 'none' | 'starttls' | 'tls';

interface StoredMail {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  passwordSealed: string | null;
  fromName: string;
  fromAddress: string;
  verifiedAt: string | null;
}

/** What the admin panel sees: never the password. */
export interface MailSettingsView {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  hasPassword: boolean;
  fromName: string;
  fromAddress: string;
  verifiedAt: string | null;
}

export interface MailTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
}
export type TransportFactory = (options: SMTPTransport.Options) => MailTransport;

const mailInput = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(['none', 'starttls', 'tls']),
  username: z.string().trim().max(254).default(''),
  /** Missing = keep the stored password; '' = no password. */
  password: z.string().max(512).optional(),
  fromName: z.string().trim().max(100).default('AIDis'),
  fromAddress: z.email().max(254),
});
const testInput = z.object({ to: z.email().max(254) });

export const mailFailed = (message = 'The mail server did not accept the letter') => new AppError(502, 'MAIL_FAILED', message);
export const mailNotConfigured = () => new AppError(409, 'MAIL_NOT_CONFIGURED', 'Mail is not set up or not checked with a test letter');

/** 0.7.1 SMTP mail: settings in app_settings (password sealed), letters from templates.ts. */
export class MailService {
  private factory: TransportFactory = (options) => nodemailer.createTransport(options);

  constructor(
    private readonly settings: SettingsService,
    private readonly box: SecretBox,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Tests swap the SMTP transport (nodemailer jsonTransport or a failing fake). */
  setTransportFactory(factory: TransportFactory): void {
    this.factory = factory;
  }

  private async stored(): Promise<StoredMail | null> {
    const raw = await this.settings.getValue<StoredMail>(KEY);
    return raw && typeof raw.host === 'string' ? raw : null;
  }

  private view(s: StoredMail): MailSettingsView {
    return { host: s.host, port: s.port, security: s.security, username: s.username, hasPassword: !!s.passwordSealed, fromName: s.fromName, fromAddress: s.fromAddress, verifiedAt: s.verifiedAt };
  }

  async get(): Promise<MailSettingsView | null> {
    const s = await this.stored();
    return s ? this.view(s) : null;
  }

  /** Changing the server, port, security, login or password needs a new test letter. */
  async save(input: unknown): Promise<MailSettingsView> {
    const data = parseInput(mailInput, input);
    const old = await this.stored();
    const passwordSealed = data.password === undefined ? (old?.passwordSealed ?? null) : data.password === '' ? null : this.box.seal(data.password);
    const sameServer = !!old && old.host === data.host && old.port === data.port && old.security === data.security && old.username === data.username && data.password === undefined;
    const next: StoredMail = {
      host: data.host,
      port: data.port,
      security: data.security,
      username: data.username,
      passwordSealed,
      fromName: data.fromName,
      fromAddress: data.fromAddress,
      verifiedAt: sameServer ? old.verifiedAt : null,
    };
    await this.settings.setValue(KEY, next);
    return this.view(next);
  }

  async configured(): Promise<boolean> {
    const s = await this.stored();
    return !!s && !!s.verifiedAt;
  }

  /** Sends a test letter; success marks the settings checked (registration can be turned on). */
  async sendTest(input: unknown): Promise<MailSettingsView> {
    const { to } = parseInput(testInput, input);
    const s = await this.stored();
    if (!s) throw mailNotConfigured();
    await this.deliver(s, to, { kind: 'test' }, 'ru');
    const next = { ...s, verifiedAt: new Date().toISOString() };
    await this.settings.setValue(KEY, next);
    return this.view(next);
  }

  async send(to: string, template: MailTemplate, lang: MailLang): Promise<void> {
    const s = await this.stored();
    if (!s || !s.verifiedAt) throw mailNotConfigured();
    await this.deliver(s, to, template, lang);
  }

  private async deliver(s: StoredMail, to: string, template: MailTemplate, lang: MailLang): Promise<void> {
    let pass: string | undefined;
    if (s.passwordSealed) {
      try {
        pass = this.box.open(s.passwordSealed);
      } catch {
        // JWT_ACCESS_SECRET changed: the stored password cannot be read any more.
        throw mailFailed('The stored SMTP password cannot be read; enter it again');
      }
    }
    const transport = this.factory({
      host: s.host,
      port: s.port,
      secure: s.security === 'tls',
      requireTLS: s.security === 'starttls',
      ignoreTLS: s.security === 'none',
      auth: s.username ? { user: s.username, pass: pass ?? '' } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const letter = renderLetter(template, lang);
    try {
      await transport.sendMail({ from: { name: s.fromName, address: s.fromAddress }, to, subject: letter.subject, text: letter.text, html: letter.html });
    } catch (err) {
      const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
      this.log.warn({ kind: template.kind, reason }, 'mail: sending failed');
      throw mailFailed(`The mail server did not accept the letter: ${reason}`);
    }
  }
}
