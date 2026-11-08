/**
 * 0.4.2 join / leave sounds for OTHER people in our voice channel. Decides whether a LiveKit
 * participant event is a real arrival / departure:
 *
 * - `seed()` remembers who is already there without a sound (after we connect, after a LiveKit
 *   reconnect, after a move) and keeps quiet briefly while LiveKit catches up;
 * - a join plays only for someone we did not know, a leave only for someone we did;
 * - nothing plays while the room is not stable (connecting, reconnecting, leaving).
 * Snapshots from the server never reach this (it only sees our own room's events).
 */
export class ParticipantSoundGate {
  private known = new Set<string>();
  private quietUntil = 0;
  private readonly quietMs: number;

  constructor(quietMs = 1500) {
    this.quietMs = quietMs;
  }

  seed(identities: Iterable<string>, now = Date.now()): void {
    this.known = new Set(identities);
    this.quietUntil = now + this.quietMs;
  }

  /** Returns true when the join sound should play. */
  joined(identity: string, stable: boolean, now = Date.now()): boolean {
    const isNew = !this.known.has(identity);
    this.known.add(identity);
    return isNew && stable && now >= this.quietUntil;
  }

  /** Returns true when the leave sound should play. */
  left(identity: string, stable: boolean, now = Date.now()): boolean {
    const wasKnown = this.known.delete(identity);
    return wasKnown && stable && now >= this.quietUntil;
  }
}
