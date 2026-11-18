import { createHash, randomBytes } from "node:crypto";
import { parseSnapshot, type CaptureGame } from "./protocol";
import { StatusProjection, type CaptureMode, type CaptureStatus } from "./status";

const CODE_TTL = 5 * 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export type CaptureBinding = { guildId: string; textChannelId: string; voiceChannelId: string };
export type StatusSink = (status: CaptureStatus, binding: CaptureBinding) => Promise<void>;
// "ended" means the session is gone (revoked or replaced) and anything it did should be undone.
export type CaptureEvent = { kind: "snapshot" | "mode" | "ended"; binding: CaptureBinding };
export type CaptureLatest = {
  binding: CaptureBinding;
  mode: CaptureMode;
  lastSeenAt: number;
  // Raw game state, including deaths nobody has reported yet. It is only for mute decisions.
  game: CaptureGame | null | undefined;
};

class StatusPublisher {
  private pending?: { status: CaptureStatus; binding: CaptureBinding };
  private timer?: NodeJS.Timeout;
  private busy = false;
  private sent?: string;
  private revision = 0;

  constructor(private readonly sink: StatusSink) {}

  publish(status: CaptureStatus, binding: CaptureBinding, refresh = false) {
    if (refresh) this.revision++;
    this.pending = { status, binding };
    this.schedule(750);
  }

  private schedule(delay: number) {
    if (this.timer || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref();
  }

  private async flush() {
    const next = this.pending;
    this.pending = undefined;
    if (!next) return;
    const key = JSON.stringify([next.status, next.binding.voiceChannelId, this.revision]);
    if (key === this.sent) return;

    this.busy = true;
    let delay = 750;
    try {
      await this.sink(next.status, next.binding);
      this.sent = key;
    } catch {
      this.pending ??= next;
      delay = 5_000;
    } finally {
      this.busy = false;
      if (this.pending) this.schedule(delay);
    }
  }
}

type Pairing = { binding: CaptureBinding; expiresAt: number; sink: StatusSink };
type Session = {
  binding: CaptureBinding;
  publisher: StatusPublisher;
  projection: StatusProjection;
  started: boolean;
  streamId?: string;
  sequence: number;
  lastSeenAt: number;
  status?: CaptureStatus;
  game?: CaptureGame | null;
  mode: CaptureMode;
};

export class CaptureRegistry {
  private readonly pairings = new Map<string, Pairing>();
  private readonly sessions = new Map<string, Session>();
  private readonly guildTokens = new Map<string, string>();
  private readonly publishers = new Map<string, { channelId: string; publisher: StatusPublisher }>();
  private listener?: (event: CaptureEvent) => void;

  listen(listener: (event: CaptureEvent) => void) {
    this.listener = listener;
  }

  private emit(event: CaptureEvent) {
    try {
      this.listener?.(event);
    } catch {
      // A failing listener must never break authentication or the capture connection.
    }
  }

  issue(binding: CaptureBinding, sink: StatusSink): string {
    this.removePairings(binding.guildId);
    let code: string;
    let key: string;
    do {
      code = Array.from(randomBytes(10), (byte) => ALPHABET[byte & 31]).join("");
      key = digest(code);
    } while (this.pairings.has(key));
    this.pairings.set(key, { binding, sink, expiresAt: Date.now() + CODE_TTL });
    return code;
  }

  exchange(code: unknown): string | undefined {
    if (typeof code !== "string" || !/^[A-Z2-9]{10}$/i.test(code)) return;
    const key = digest(code.toUpperCase());
    const pairing = this.pairings.get(key);
    if (!pairing) return;
    this.pairings.delete(key);
    if (pairing.expiresAt <= Date.now()) return;
    const { binding, sink } = pairing;

    this.revoke(binding.guildId);
    const existing = this.publishers.get(binding.guildId);
    const publisher = existing?.channelId === binding.textChannelId ? existing.publisher : new StatusPublisher(sink);
    this.publishers.set(binding.guildId, { channelId: binding.textChannelId, publisher });
    const token = randomBytes(32).toString("base64url");
    const tokenKey = digest(token);
    this.sessions.set(tokenKey, {
      binding, publisher, projection: new StatusProjection(), started: false, sequence: 0, lastSeenAt: Date.now(),
      mode: "Manual",
    });
    this.guildTokens.set(binding.guildId, tokenKey);
    return token;
  }

  revoke(guildId: string): boolean {
    const pending = this.removePairings(guildId);
    const key = this.guildTokens.get(guildId);
    if (!key) return pending;
    const session = this.sessions.get(key);
    if (session?.started) session.publisher.publish(session.projection.waiting(), session.binding);
    this.sessions.delete(key);
    this.guildTokens.delete(guildId);
    if (session) this.emit({ kind: "ended", binding: session.binding });
    return true;
  }

  receive(authorization: string | undefined, body: unknown, heartbeat: boolean, resync = false): number {
    const token = /^Bearer ([\w-]{43})$/i.exec(authorization ?? "")?.[1];
    const session = token ? this.sessions.get(digest(token)) : undefined;
    if (!session) return 401;
    if (heartbeat) {
      session.lastSeenAt = Date.now();
      return 204;
    }

    const snapshot = parseSnapshot(body);
    if (!snapshot) return 400;
    // An exchanged credential belongs to one running capture process.
    if (session.streamId && snapshot.streamId !== session.streamId) return 409;
    session.lastSeenAt = Date.now();
    if (snapshot.sequence <= session.sequence) return 204;
    session.streamId = snapshot.streamId;
    session.sequence = snapshot.sequence;
    const status = session.projection.update(snapshot, resync);
    session.game = snapshot.game;
    if (status) {
      session.started = true;
      session.status = status;
      session.publisher.publish(status, session.binding);
    }
    this.emit({ kind: "snapshot", binding: session.binding });
    return 204;
  }

  latest(guildId: string): CaptureLatest | undefined {
    const key = this.guildTokens.get(guildId);
    const session = key ? this.sessions.get(key) : undefined;
    if (!session) return undefined;
    return { binding: session.binding, mode: session.mode, lastSeenAt: session.lastSeenAt, game: session.game };
  }

  // Returns false when there is no paired capture to change.
  setMode(guildId: string, mode: CaptureMode): boolean {
    const key = this.guildTokens.get(guildId);
    const session = key ? this.sessions.get(key) : undefined;
    if (!session) return false;
    if (session.mode === mode) return true;
    session.mode = mode;
    session.projection.mode = mode;
    if (session.status) {
      session.status = { ...session.status, mode };
      session.publisher.publish(session.status, session.binding);
    }
    this.emit({ kind: "mode", binding: session.binding });
    return true;
  }

  view(guildId: string): { binding: CaptureBinding; status: CaptureStatus } | undefined {
    const key = this.guildTokens.get(guildId);
    const session = key ? this.sessions.get(key) : undefined;
    if (session?.status) return { binding: session.binding, status: session.status };
    return undefined;
  }

  refresh(guildId: string) {
    const key = this.guildTokens.get(guildId);
    const session = key ? this.sessions.get(key) : undefined;
    if (session?.status) session.publisher.publish(session.status, session.binding, true);
  }

  private removePairings(guildId: string): boolean {
    let removed = false;
    for (const [key, entry] of this.pairings) {
      if (entry.binding.guildId === guildId || entry.expiresAt <= Date.now()) {
        this.pairings.delete(key);
        if (entry.binding.guildId === guildId && entry.expiresAt > Date.now()) removed = true;
      }
    }
    return removed;
  }
}

export const captureRegistry = new CaptureRegistry();
