/**
 * 0.7.0 mandatory update: the server refuses desktop versions below its minimumVersion (see
 * Server/src/client-version). At start the shell asks the server and, when this build is too old,
 * checks for the update at once and downloads it without waiting for the green button. Installing
 * still needs the user's click (the renderer shows a full-screen "update required" page).
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)/;

function parse(version: string): [number, number, number] | null {
  const m = VERSION.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function shouldForceUpdate(current: string, minimum: string | null): boolean {
  if (!minimum) return false;
  const a = parse(current);
  const b = parse(minimum);
  if (!a || !b) return false;
  const [a1, a2, a3] = a;
  const [b1, b2, b3] = b;
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 < b3;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** The server's minimumVersion, or null when it cannot be read (offline, old server). */
export async function fetchMinimumVersion(apiOrigin: string, fetchImpl: Fetch = fetch, timeoutMs = 10_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiOrigin}/api/v1/client/version`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { minimumVersion?: unknown };
    return typeof body.minimumVersion === 'string' ? body.minimumVersion : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
