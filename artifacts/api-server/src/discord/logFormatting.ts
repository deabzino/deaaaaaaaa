import { PermissionsBitField, type PermissionOverwrites } from "discord.js";

export function sanitizeLogText(raw: string, guildId: string, ids: Map<string, string>, preserveText = false): string {
  const text = raw
    .replace(/\u2063\{(User|Channel|Role|Message):([0-9]{5,})\}\u2063/g, (_all, kind: string, id: string) => { ids.set(`${kind} ID ${id}`, ""); return ""; })
    .replace(/<([#@&]+)([0-9]{17,20})>/g, (mention, prefix: string, id: string) => {
      if (preserveText) ids.set((prefix === "#" ? "Channel" : prefix === "@&" ? "Role" : "User") + " ID " + id, "");
      return mention;
    });
  if (preserveText) return text.trim();
  return text
    .replace(/(?<![#@&])\b[0-9]{17,20}\b/g, (id) => { if (id !== guildId && ![...ids.keys()].some((key) => key.endsWith(`ID ${id}`))) ids.set(`ID ${id}`, ""); return ""; })
    .replace(/\b(?:Unavailable|undefined|null)\b/gi, "Not recorded")
    .replace(/\b(true|false)\b/gi, (value) => value.toLowerCase() === "true" ? "Enabled" : "Disabled")
    .replace(/\s{2,}/g, " ").trim();
}

export function formatUserLabel(displayName: string, username?: string | null): string {
  return `@${displayName}${username && username !== displayName ? ` (${username})` : ""}`;
}

export function formatUser(userId: string, username?: string | null, displayName?: string | null): string {
  const mention = `<@${userId}>`;
  if (!username) return mention;
  return displayName === username ? mention : `${mention} (${escapeMarkdown(username)})`;
}

export function formatRoleList(names: readonly string[], limit = 10): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b));
  const visible = sorted.slice(0, limit).map((name) => name.replace(/[\\`*_{}\[\]()#+\-.!|>~]/g, "\\$&"));
  const remainder = sorted.length - visible.length;
  return remainder > 0 ? `${visible.join(", ")} ...and ${remainder} more` : visible.join(", ");
}

export function optionalActorField(actor: string): [string, string][] {
  return actor ? [["Actor", actor]] : [];
}

export function commandLogDetails(userId: string, command: string, options: string, channelId: string, prefix: boolean, username?: string | null, displayName?: string | null): [string, string][] {
  return [
    ["Who", formatUser(userId, username, displayName)],
    ["Command", `\`${prefix ? "." : "/"}${command}\``],
    ...(options.trim() ? [["Options", options.trim()] as [string, string]] : []),
    ["Channel", `<#${channelId}>`],
  ];
}

export function deletedByLabel(authorKnown: boolean, actor: string): string {
  return actor || (authorKnown ? "Unknown (likely deleted by the author)" : "Unknown");
}

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_~`|>])/g, "\\$1");
}

export function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

export function humanize(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  let length = text.length;
  for (let count = lines.length - 1; count > 0; count--) {
    length -= lines[count]!.length + 1;
    const suffix = "\n...and " + (lines.length - count) + " more";
    if (length + suffix.length <= max) return text.slice(0, length) + suffix;
  }
  const characters = Array.from(text);
  let end = Math.min(max, characters.length);
  let prefix = characters.slice(0, end).join("");
  while (end > 0) {
    const suffix = "...and " + (characters.length - end) + " more";
    if (prefix.length + suffix.length <= max) return prefix + suffix;
    prefix = prefix.slice(0, -characters[--end]!.length);
  }
  return "...";
}

export function permissionNames(bits: bigint): string {
  return new PermissionsBitField(bits).toArray().map(humanize).join(", ") || "None";
}

export function channelPermissionChanges(
  before: ReadonlyMap<string, PermissionOverwrites>,
  after: ReadonlyMap<string, PermissionOverwrites>,
  label: (overwrite: PermissionOverwrites) => string,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((id) => {
    const oldOverwrite = before.get(id);
    const newOverwrite = after.get(id);
    const overwrite = newOverwrite ?? oldOverwrite;
    if (!overwrite || !id) return [];
    const target = label(overwrite);
    if (!newOverwrite) return ["- " + target + ": removed overwrite (no custom permissions anymore)"];
    const oldAllow = oldOverwrite?.allow.bitfield ?? 0n;
    const oldDeny = oldOverwrite?.deny.bitfield ?? 0n;
    const newAllow = newOverwrite.allow.bitfield;
    const newDeny = newOverwrite.deny.bitfield;
    const allowed = newAllow & ~oldAllow;
    const denied = newDeny & ~oldDeny;
    const neutral = (oldAllow | oldDeny) & ~(newAllow | newDeny);
    const changes = [
      ...(allowed ? ["allowed " + permissionNames(allowed)] : []),
      ...(denied ? ["denied " + permissionNames(denied)] : []),
      ...(neutral ? [permissionNames(neutral) + " reset to neutral"] : []),
    ];
    if (!oldOverwrite) return ["- " + target + ": new overwrite added" + (changes.length ? ": " + changes.join(", ") : " (all permissions neutral)")];
    return changes.length ? ["- " + target + ": " + changes.join(", ")] : [];
  });
}
