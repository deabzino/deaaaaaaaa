import type { MatchStore } from "./matchStore";
import type { CapturePlayer } from "./protocol";

export type VoicePlayer = { id: string; names: string[] };
export type LinkResult = { linked: boolean; saved: boolean };
type RosterPlayer = Omit<CapturePlayer, "dead">;

export function normalizePlayerName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, "");
}

export class ColourLinks {
  private readonly links = new Map<number, { userId: string; name: string }>();
  private readonly blocked = new Set<string>();
  private readonly known = new Map<string, string | undefined>();
  private retryAt = 0;

  constructor(private readonly guildId: string, private readonly store: MatchStore) {}

  userFor(player: RosterPlayer): string | undefined {
    const link = this.links.get(player.id);
    return link?.name === player.name ? link.userId : undefined;
  }

  async reconcile(players: RosterPlayer[], members: VoicePlayer[]) {
    const roster = players.filter((player) => !player.disconnected);
    for (const [id, link] of this.links) {
      if (!roster.some((player) => player.id === id && player.name === link.name)) this.links.delete(id);
    }
    if (!members.length || !roster.length) return;

    const unique = roster.filter((player) => this.uniqueName(player, roster));
    const pending = unique.map((player) => normalizePlayerName(player.name)).filter((name) => !this.known.has(name));
    if (pending.length && Date.now() >= this.retryAt) {
      try {
        const saved = new Map((await this.store.find(this.guildId, pending)).map(
          ({ normalizedName, userId }) => [normalizedName, userId],
        ));
        for (const name of pending) this.known.set(name, saved.get(name));
      } catch {
        this.retryAt = Date.now() + 30_000;
      }
    }

    const occupied = new Set([...this.links.values()].map((link) => link.userId));
    const candidates = unique.filter((player) => !this.links.has(player.id)).map((player) => {
      const name = normalizePlayerName(player.name);
      const remembered = this.known.get(name);
      const matching = members.filter((member) =>
        remembered ? member.id === remembered : member.names.some((alias) => normalizePlayerName(alias) === name));
      return { player, matching, remembered };
    });
    const saves: Promise<boolean>[] = [];
    for (const { player, matching, remembered } of candidates) {
      if (matching.length !== 1) continue;
      const user = matching[0]!;
      if (this.blocked.has(user.id) || occupied.has(user.id) || candidates.some((other) => other.player.id !== player.id &&
        other.matching.some((member) => member.id === user.id))) continue;
      this.links.set(player.id, { userId: user.id, name: player.name });
      occupied.add(user.id);
      if (!remembered) saves.push(this.remember(player, user.id, false));
    }
    await Promise.all(saves);
  }

  async confirm(player: RosterPlayer, roster: RosterPlayer[], userId: string, replace: boolean): Promise<LinkResult> {
    const taken = this.userFor(player);
    const otherColour = [...this.links].some(([id, link]) => id !== player.id && link.userId === userId);
    if (player.disconnected || (!replace && ((taken && taken !== userId) || otherColour)))
      return { linked: false, saved: false };
    this.removeLink(userId);
    this.blocked.delete(userId);
    this.links.set(player.id, { userId, name: player.name });
    const saved = this.uniqueName(player, roster) && await this.remember(player, userId, true);
    return { linked: true, saved };
  }

  async unlink(userId: string, forget: boolean, name?: string): Promise<boolean> {
    this.removeLink(userId);
    this.blocked.add(userId);
    if (!forget) return true;
    // A missing name means forget all of this member's saved names in this guild.
    for (const [normalized, saved] of this.known) {
      if (saved === userId && (!name || normalized === name)) this.known.delete(normalized);
    }
    try {
      return await this.store.remove(this.guildId, userId, name ? [name] : undefined);
    } catch {
      return false;
    }
  }

  private removeLink(userId: string) {
    for (const [id, link] of this.links) if (link.userId === userId) this.links.delete(id);
  }

  private uniqueName(player: RosterPlayer, roster: RosterPlayer[]): boolean {
    const name = normalizePlayerName(player.name);
    return !!name && roster.filter((other) => !other.disconnected && normalizePlayerName(other.name) === name).length === 1;
  }

  private async remember(player: RosterPlayer, userId: string, overwrite: boolean): Promise<boolean> {
    const normalizedName = normalizePlayerName(player.name);
    // Keep the confirmed match in this pairing even when storage is unavailable.
    this.known.set(normalizedName, userId);
    try {
      return await this.store.save(this.guildId, { normalizedName, userId }, overwrite);
    } catch {
      return false;
    }
  }
}
