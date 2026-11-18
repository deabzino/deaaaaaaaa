import type { CaptureGame, CapturePlayer } from "./protocol";

type RosterPlayer = Pick<CapturePlayer, "id" | "name" | "colour" | "disconnected">;

// Decides who should be server-muted for the current game state, keyed by Discord user ID.
//
// This reads the raw `dead` flags, which include kills nobody has reported yet. Its output
// must only ever drive voice mutes. It must never feed a Discord message or the status embed.
// That is safe because every linked player is muted during tasks, so a mute never shows who died.
export class MuteTracker {
  // Deaths are frozen when a meeting starts so someone exiled mid-meeting is not muted
  // before the ejection is announced. They are muted when the next tasks phase begins.
  private meetingDead?: Set<number>;

  desired(game: CaptureGame | null, userFor: (player: RosterPlayer) => string | undefined): Map<string, boolean> {
    const targets = new Map<string, boolean>();
    if (!game) {
      this.meetingDead = undefined;
      return targets;
    }
    if (game.phase === "meeting") {
      this.meetingDead ??= new Set(game.players.filter((player) => player.dead).map((player) => player.id));
    } else {
      this.meetingDead = undefined;
    }

    for (const player of game.players) {
      const userId = userFor(player);
      if (!userId) continue;
      const muted = !player.disconnected && (
        game.phase === "tasks" || (game.phase === "meeting" && !!this.meetingDead?.has(player.id)));
      // A member linked to two players stays muted if either rule says so.
      targets.set(userId, (targets.get(userId) ?? false) || muted);
    }
    return targets;
  }
}
