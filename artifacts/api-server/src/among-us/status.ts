import { COLOUR_NAMES, type CaptureGame, type CapturePlayer, type CaptureSnapshot } from "./protocol";

const REGIONS = ["North America", "Asia", "Europe"];
const MAPS = ["The Skeld", "MIRA HQ", "Polus", "dlekS", "The Airship", "The Fungle"];
const PHASE_NAMES = { menu: "Waiting for a lobby", lobby: "Lobby", tasks: "Tasks", meeting: "Meeting", ended: "Ended" };

export type CaptureStatus = {
  phase: string;
  mode: "Manual";
  lobby: string;
  region: string;
  map: string;
  roster: string[];
  rosterPlayers: Omit<CapturePlayer, "dead">[];
};

function safeName(name: string): string {
  return Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()).slice(0, 24).join("")
    .replace(/[\\*_~`|\[\]<>#]/g, "\\$&") || "Unnamed player";
}

export class StatusProjection {
  private last?: CaptureSnapshot;
  private disclosed = new Set<number>();
  private active = false;

  update(next: CaptureSnapshot, resync = false): CaptureStatus | undefined {
    const previous = this.last;
    const before = previous?.game;
    const game = next.game;
    const consecutive = !resync && previous?.streamId === next.streamId && previous.sequence + 1 === next.sequence;
    const sameLobby = !before?.lobbyCode || !game?.lobbyCode || before.lobbyCode === game.lobbyCode;
    const newRound = !sameLobby || !game || game.phase === "menu" || game.phase === "lobby" ||
      (game.phase === "tasks" && before?.phase === "ended");
    if (newRound || !consecutive) this.disclosed.clear();

    if (game?.phase === "meeting" && before?.phase === "tasks" && consecutive && sameLobby) {
      for (const player of game.players) if (player.dead) this.disclosed.add(player.id);
    }
    this.last = next;
    if (game && game.phase !== "menu") this.active = true;
    return this.active ? this.render(game) : undefined;
  }

  waiting(): CaptureStatus {
    return this.render(null);
  }

  private render(game: CaptureGame | null): CaptureStatus {
    const players = [...(game?.players ?? [])].sort((a, b) => a.colour - b.colour);
    const roster = players.map((player) => {
      const status = game?.phase === "lobby" ? "" :
        this.disclosed.has(player.id) && player.dead ? " · Dead" : " · Alive";
      return `**${COLOUR_NAMES[player.colour]}** · ${safeName(player.name)}${status}`;
    });
    return {
      phase: game ? PHASE_NAMES[game.phase] : "Waiting for capture",
      mode: "Manual",
      lobby: game?.lobbyCode ?? "—",
      region: game?.regionId == null ? "—" : REGIONS[game.regionId] ?? "Unknown",
      map: game?.mapId == null ? "—" : MAPS[game.mapId] ?? "Unknown",
      roster,
      rosterPlayers: players.map(({ id, name, colour, disconnected }) => ({ id, name, colour, disconnected })),
    };
  }
}
