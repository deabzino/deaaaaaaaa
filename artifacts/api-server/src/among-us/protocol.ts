export const COLOUR_NAMES = [
  "Red", "Blue", "Green", "Pink", "Orange", "Yellow", "Black", "White",
  "Purple", "Brown", "Cyan", "Lime", "Maroon", "Rose", "Banana", "Gray", "Tan", "Coral",
] as const;

const PHASES = ["menu", "lobby", "tasks", "meeting", "ended"] as const;
type Phase = typeof PHASES[number];
export type CapturePlayer = { id: number; name: string; colour: number; dead: boolean; disconnected: boolean };
export type CaptureGame = {
  phase: Phase;
  lobbyCode: string | null;
  regionId: number | null;
  mapId: number | null;
  players: CapturePlayer[];
};
export type CaptureSnapshot = { streamId: string; sequence: number; game: CaptureGame | null };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseSnapshot(input: unknown): CaptureSnapshot | undefined {
  const event = object(input);
  if (!event || event.protocolVersion !== 1 || typeof event.streamId !== "string" ||
    !/^[a-f0-9]{32}$/.test(event.streamId) || !integer(event.sequence, 1, Number.MAX_SAFE_INTEGER)) return;

  const { streamId, sequence } = event;
  if (event.game === null) return { streamId, sequence, game: null };
  const game = object(event.game);
  if (!game) return;
  const { phase, lobbyCode, regionId, mapId, players } = game;
  if (!PHASES.includes(phase as Phase) ||
    (lobbyCode !== null && (typeof lobbyCode !== "string" || !/^(?:[A-Z]{4}|[A-Z]{6}|\*{6})$/.test(lobbyCode))) ||
    (regionId !== null && !integer(regionId, 0, 255)) || (mapId !== null && !integer(mapId, 0, 255)) ||
    !Array.isArray(players) || players.length > 15) return;

  const ids = new Set<number>();
  const roster: CapturePlayer[] = [];
  for (const item of players) {
    const player = object(item);
    if (!player) return;
    const { id, name, colour, dead, disconnected } = player;
    if (!integer(id, 0, 255) || ids.has(id) || typeof name !== "string" || !name.trim() || name.length > 256 ||
      !integer(colour, 0, COLOUR_NAMES.length - 1) || typeof dead !== "boolean" || typeof disconnected !== "boolean") return;
    ids.add(id);
    roster.push({ id, name, colour, dead, disconnected });
  }
  return { streamId, sequence, game: { phase: phase as Phase, lobbyCode, regionId, mapId, players: roster } };
}
