import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact';

/**
 * Small file logger: %APPDATA%\AIDis\logs\main.log (one rotated copy, 2 MB each).
 * Every line goes through redact() so a token that slips into an error message is never written.
 */
type Level = 'info' | 'warn' | 'error';

const MAX_BYTES = 2 * 1024 * 1024;
let file: string | null = null;

export function initLogger(logsDir: string): string {
  mkdirSync(logsDir, { recursive: true });
  file = join(logsDir, 'main.log');
  return file;
}

function rotate(target: string): void {
  try {
    if (statSync(target).size < MAX_BYTES) return;
    const old = `${target}.1`;
    rmSync(old, { force: true });
    renameSync(target, old);
  } catch {
    /* no file yet */
  }
}

export function log(level: Level, scope: string, message: string, error?: unknown): void {
  const detail = error instanceof Error ? ` (${error.name}: ${error.message})` : typeof error === 'string' || typeof error === 'number' ? ` (${String(error)})` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(message + detail)}\n`;
  if (level === 'error') process.stderr.write(line);
  else if (!process.env.AIDIS_QUIET) process.stdout.write(line);
  if (!file) return;
  try {
    rotate(file);
    appendFileSync(file, line, 'utf8');
  } catch {
    /* logging must never crash the app */
  }
}

export const logger = {
  info: (scope: string, message: string) => log('info', scope, message),
  warn: (scope: string, message: string, error?: unknown) => log('warn', scope, message, error),
  error: (scope: string, message: string, error?: unknown) => log('error', scope, message, error),
};
