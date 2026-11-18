export type VoiceView = { inVoice: boolean; inPairedChannel: boolean; serverMute: boolean };
export type VoiceOps = {
  view(userId: string): VoiceView;
  setMute(userId: string, mute: boolean): Promise<void>;
};
export type MuteEvent =
  | { kind: "mute" | "unmute"; userId: string; dryRun: boolean }
  | { kind: "failed"; userId: string; mute: boolean; attempt: number; willRetry: boolean; error: unknown };
export type MuteExecutorOptions = {
  ops: VoiceOps;
  dryRun: boolean;
  log?: (event: MuteEvent) => void;
  concurrency?: number;
  retryDelaysMs?: readonly number[];
};

type Job = { userId: string; mute: boolean };

// Moves Discord server mutes toward a target state, one guild at a time.
//
// - It only lifts mutes it applied itself, so a mute from a moderator is never touched.
// - It never mutes anyone outside the paired voice channel, and it releases a mute it owns
//   once the member has left that channel.
// - It always works from the newest target and re-reads Discord's state each pass, so it
//   never replays a stale queue of changes.
// - Changes run in small batches. Failures retry with backoff, then stop until the target changes.
export class MuteExecutor {
  private readonly ops: VoiceOps;
  private readonly dryRun: boolean;
  private readonly log: (event: MuteEvent) => void;
  private readonly concurrency: number;
  private readonly retryDelaysMs: readonly number[];
  private desired = new Map<string, boolean>();
  private signature?: string;
  private readonly owned = new Set<string>();
  // Dry run applies nothing to Discord, so it tracks the mutes it would have made.
  private readonly simulated = new Map<string, boolean>();
  private readonly failures = new Map<string, number>();
  private running?: Promise<void>;
  private dirty = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(options: MuteExecutorOptions) {
    this.ops = options.ops;
    this.dryRun = options.dryRun;
    this.log = options.log ?? (() => {});
    this.concurrency = Math.max(1, options.concurrency ?? 3);
    this.retryDelaysMs = options.retryDelaysMs ?? [2_000, 5_000, 15_000];
  }

  // True when there is nothing to undo and no target to enforce.
  get isEmpty(): boolean {
    return this.owned.size === 0 && this.desired.size === 0;
  }

  ownedIds(): string[] {
    return [...this.owned];
  }

  // Repeated identical targets are ignored. The capture reports ~4 times a second.
  // `force` re-reads Discord's state, for example after someone joins or leaves voice.
  apply(target: ReadonlyMap<string, boolean>, force = false): Promise<void> {
    const signature = [...target].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([userId, mute]) => `${userId}:${mute ? 1 : 0}`).join(",");
    if (!force && signature === this.signature) return this.running ?? Promise.resolve();
    if (signature !== this.signature) this.failures.clear();
    this.signature = signature;
    this.desired = new Map(target);
    return this.kick();
  }

  // Lifts every mute this executor applied. A later identical target re-applies it.
  release(): Promise<void> {
    this.desired = new Map();
    this.signature = undefined;
    this.failures.clear();
    return this.kick();
  }

  // Stops tracking without touching Discord. Used when a person has taken over the mutes by hand,
  // so a later release cannot undo what they just did.
  forget(): void {
    this.desired = new Map();
    this.signature = undefined;
    this.failures.clear();
    this.owned.clear();
    this.simulated.clear();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private kick(): Promise<void> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.dirty = false;
          await this.reconcile();
        } while (this.dirty);
      } finally {
        this.running = undefined;
      }
    })();
    this.running = run;
    return run;
  }

  private viewOf(userId: string): VoiceView {
    const real = this.ops.view(userId);
    const simulated = this.simulated.get(userId);
    return real.inVoice && simulated !== undefined ? { ...real, serverMute: simulated } : real;
  }

  private async reconcile(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const targets = new Map(this.desired);
    for (const userId of this.owned) if (!targets.has(userId)) targets.set(userId, false);

    const jobs: Job[] = [];
    for (const [userId, wanted] of targets) {
      const view = this.viewOf(userId);
      if (!view.inVoice) {
        // Discord clears a server mute when someone disconnects, so there is nothing left to undo.
        this.owned.delete(userId);
        this.simulated.delete(userId);
        continue;
      }
      if ((this.failures.get(userId) ?? 0) > this.retryDelaysMs.length) continue;
      const mute = wanted && view.inPairedChannel;
      if (mute) {
        if (!view.serverMute) jobs.push({ userId, mute: true });
      } else if (view.serverMute) {
        if (this.owned.has(userId)) jobs.push({ userId, mute: false });
      } else {
        this.owned.delete(userId);
        this.simulated.delete(userId);
      }
    }

    for (let index = 0; index < jobs.length; index += this.concurrency) {
      await Promise.all(jobs.slice(index, index + this.concurrency).map((job) => this.execute(job)));
    }
  }

  private async execute({ userId, mute }: Job): Promise<void> {
    if (this.dryRun) {
      this.log({ kind: mute ? "mute" : "unmute", userId, dryRun: true });
      this.claim(userId, mute, true);
      return;
    }
    try {
      await this.ops.setMute(userId, mute);
    } catch (error) {
      const attempt = (this.failures.get(userId) ?? 0) + 1;
      this.failures.set(userId, attempt);
      const delay = this.retryDelaysMs[attempt - 1];
      this.log({ kind: "failed", userId, mute, attempt, willRetry: delay !== undefined, error });
      if (delay !== undefined) this.scheduleRetry(delay);
      return;
    }
    this.failures.delete(userId);
    this.claim(userId, mute, false);
    this.log({ kind: mute ? "mute" : "unmute", userId, dryRun: false });
  }

  private claim(userId: string, mute: boolean, simulate: boolean) {
    if (mute) {
      this.owned.add(userId);
      if (simulate) this.simulated.set(userId, true);
    } else {
      this.owned.delete(userId);
      this.simulated.delete(userId);
    }
  }

  private scheduleRetry(delay: number) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.kick();
    }, delay);
    this.retryTimer.unref?.();
  }
}
