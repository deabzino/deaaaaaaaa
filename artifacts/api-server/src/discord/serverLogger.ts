import {
  AuditLogEvent,
  EmbedBuilder,
  ChannelType,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildDefaultMessageNotifications,
  GuildScheduledEventStatus,
  GuildScheduledEventEntityType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  StickerType,
  AutoModerationActionType,
  OverwriteType,
  type GuildChannel,
  type PermissionOverwrites,
  type PartialMessage,
  type User,
  Events,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
  type PartialUser,
  type Message,
} from "discord.js";
import { prisma } from "../lib/prisma";
import { describeVoiceChanges, summarizeVoiceChanges, VoiceLogBatcher, type VoiceLogChange } from "./voiceLogBatcher";
import { channelPermissionChanges, humanize, permissionNames, truncate, commandLogDetails, deletedByLabel, escapeMarkdown, formatRoleList, formatUser, inlineCode, optionalActorField, sanitizeLogText } from "./logFormatting";

export type LogCategory =
  | "messages"
  | "members"
  | "voice"
  | "channels"
  | "roles"
  | "server"
  | "commands"
  | "automod";

type LogSettings = {
  channelId: string | null;
  enabled: Record<LogCategory, boolean>;
  ignoredChannels: string[];
  ignoredRoles: string[];
  ignoredUsers: string[];
};

type QueueItem = { guildId: string; embed: EmbedBuilder; file?: { attachment: Buffer; name: string } };

const DEFAULT_CHANNEL_ID = "1183841843100795030";
const COLORS = { delete: 0xed4245, create: 0x57f287, update: 0xfee75c, info: 0x5865f2, command: 0x9b59b6 };
const CATEGORIES: LogCategory[] = ["messages", "members", "voice", "channels", "roles", "server", "commands", "automod"];
const queue: QueueItem[] = [];
const pendingVoiceWrites = new Set<Promise<void>>();
let draining = false;
const settingsCache = new Map<string, LogSettings>();
type MessageSnapshot = {
  id: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  content: string;
  attachments: string;
  attachmentIds: string;
  stickers: string;
  stickerIds: string;
  embeds: string;
  avatarUrl: string;
  imageUrl: string | null;
  authorBot: boolean;
};
const snapshots = new Map<string, MessageSnapshot>();
type InviteSnapshot = Map<string, { uses: number; inviter: string }>;
const inviteSnapshots = new Map<string, InviteSnapshot>();
const inviteFetchQueues = new Map<string, Promise<void>>();

const defaultSettings = (): LogSettings => ({
  channelId: null,
  enabled: Object.fromEntries(CATEGORIES.map((category) => [category, true])) as Record<LogCategory, boolean>,
  ignoredChannels: [],
  ignoredRoles: [],
  ignoredUsers: [],
});

function idText(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return `<#${value}>${idMarker("Channel", value)}`;
}

function userText(id: string, name?: string | null): string {
  if (!id) return "Unknown";
  const username = name?.split("#")[0] ?? globalClient?.users.cache.get(id)?.username ?? null;
  return `${formatUser(id, username)}${idMarker("User", id)}`;
}

function idMarker(kind: string, id: string): string { return `\u2063{${kind}:${id}}\u2063`; }

function imageUrlFromMessage(message: Message): string | null {
  return [...message.attachments.values()].find((attachment) =>
    attachment.contentType?.startsWith("image/") ||
    /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(attachment.name ?? attachment.url),
  )?.url ?? null;
}

function validMediaUrl(value?: string | null): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function avatarUrl(user: User): string {
  const url = user.displayAvatarURL({ extension: "png", size: 128 });
  return validMediaUrl(url) ? url : user.defaultAvatarURL;
}

function snapshotMessage(message: Message | PartialMessage): MessageSnapshot | undefined {
  if (message.partial || !message.guild || !message.author) return;
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorTag: message.author.tag,
    authorBot: message.author.bot,
    content: message.content,
    attachments: message.attachments.map((attachment) =>
      inlineCode(attachment.name ?? "Attachment") + " (" + (attachment.contentType ?? "Unknown type") + ")",
    ).join("\\n"),
    attachmentIds: [...message.attachments.keys()].sort().join(","),
    stickers: message.stickers.map((sticker) => escapeMarkdown(sticker.name)).join("\\n"),
    stickerIds: [...message.stickers.keys()].sort().join(","),
    embeds: message.embeds.map((item) => escapeMarkdown(item.title ?? item.provider?.name ?? item.data.type ?? "Embed")).join("\\n"),
    imageUrl: imageUrlFromMessage(message),
    avatarUrl: avatarUrl(message.author),
  };
}

function rememberMessage(snapshot: MessageSnapshot): void {
  snapshots.delete(snapshot.id);
  if (snapshots.size >= 5_000) {
    const oldest = snapshots.keys().next().value;
    if (oldest) snapshots.delete(oldest);
  }
  snapshots.set(snapshot.id, snapshot);
}

async function getSettings(guildId: string): Promise<LogSettings> {
  const cached = settingsCache.get(guildId);
  if (cached) return cached;
  const row = await prisma.$queryRaw<Array<{ channelId: string | null; enabled: string; ignoredChannels: string; ignoredRoles: string; ignoredUsers: string }>>`
    SELECT "channelId", "enabled", "ignoredChannels", "ignoredRoles", "ignoredUsers"
    FROM "ServerLogConfig" WHERE "guildId" = ${guildId} LIMIT 1
  `;
  const base = defaultSettings();
  if (row[0]) {
    try {
      base.channelId = row[0].channelId;
      base.enabled = { ...base.enabled, ...(JSON.parse(row[0].enabled) as Partial<Record<LogCategory, boolean>>) };
      base.ignoredChannels = JSON.parse(row[0].ignoredChannels) as string[];
      base.ignoredRoles = JSON.parse(row[0].ignoredRoles) as string[];
      base.ignoredUsers = JSON.parse(row[0].ignoredUsers) as string[];
    } catch (error) {
      console.error("Failed to parse server log settings", error);
    }
  }
  settingsCache.set(guildId, base);
  return base;
}

async function saveSettings(guildId: string, settings: LogSettings): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "ServerLogConfig" ("guildId", "channelId", "enabled", "ignoredChannels", "ignoredRoles", "ignoredUsers")
    VALUES (${guildId}, ${settings.channelId}, ${JSON.stringify(settings.enabled)}, ${JSON.stringify(settings.ignoredChannels)}, ${JSON.stringify(settings.ignoredRoles)}, ${JSON.stringify(settings.ignoredUsers)})
    ON CONFLICT("guildId") DO UPDATE SET "channelId" = excluded."channelId", "enabled" = excluded."enabled",
      "ignoredChannels" = excluded."ignoredChannels", "ignoredRoles" = excluded."ignoredRoles", "ignoredUsers" = excluded."ignoredUsers"
  `;
  settingsCache.set(guildId, settings);
}

export async function configureLogs(guildId: string, update: Partial<LogSettings>): Promise<LogSettings> {
  const settings = await getSettings(guildId);
  const next = { ...settings, ...update, enabled: { ...settings.enabled, ...(update.enabled ?? {}) } };
  await saveSettings(guildId, next);
  return next;
}

export async function getLogSettings(guildId: string): Promise<LogSettings> {
  return getSettings(guildId);
}

export async function toggleLogCategory(guildId: string, category: LogCategory): Promise<LogSettings> {
  const settings = await getSettings(guildId);
  return configureLogs(guildId, { enabled: { ...settings.enabled, [category]: !settings.enabled[category] } });
}

export async function ignoreLogTarget(guildId: string, kind: "channel" | "role" | "user", id: string): Promise<LogSettings> {
  const settings = await getSettings(guildId);
  const key = kind === "channel" ? "ignoredChannels" : kind === "role" ? "ignoredRoles" : "ignoredUsers";
  const values = settings[key].includes(id) ? settings[key].filter((value) => value !== id) : [...settings[key], id];
  return configureLogs(guildId, { [key]: values });
}

let warnedMissingAuditPermission = false;
async function auditActor(guild: Guild, type: AuditLogEvent, targetId: string | undefined, channelId?: string): Promise<string> {
  const me = guild.members.me;
  if (me && !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    if (!warnedMissingAuditPermission) {
      warnedMissingAuditPermission = true;
      console.warn("Server event logs cannot identify actors because the bot is missing View Audit Log permission.");
    }
    return "";
  }
  try {
    if (!targetId) return "";
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((item) => {
      const age = Date.now() - item.createdTimestamp;
      const extra = item.extra as { channel?: { id?: string } } | null;
      return age >= 0 && age <= 5_000 && item.targetId === targetId &&
        (!channelId || extra?.channel?.id === channelId);
    });
    if (entry?.executorId) return userText(entry.executorId, entry.executor?.username);
  } catch (error) {
    if ((error as { code?: number }).code === 50013 && !warnedMissingAuditPermission) {
      warnedMissingAuditPermission = true;
      console.warn("Server event logs cannot identify actors because the bot is missing View Audit Log permission.");
    }
  }
  return "";
}

function embed(guild: Guild, title: string, color: number, details: Array<[string, string]>, target?: string, imageUrl?: string | null, avatarUrl?: string | null): EmbedBuilder {
  const ids = new Map<string, string>();
  ids.set("Server ID " + guild.id, "");
  if (target) ids.set("Target ID " + target, "");
  const clean = (value: string) => sanitizeLogText(value, guild.id, ids, true);
  const titleText = truncate(clean(title), 256);
  const fields = details.filter(([, value]) => value.trim()).map(([name, value]) => ({
    name: truncate(clean(name), 256),
    value: clean(value) || "Unknown",
    inline: name !== "Permissions" && !value.includes("\\n"),
  }));
  const footer = truncate([...ids.keys()].join(" • "), 1024);
  let budget = 6000 - titleText.length - footer.length;
  const boundedFields: typeof fields = [];
  for (const field of fields.slice(0, 25)) {
    const remaining = budget - field.name.length;
    if (remaining < 60) break;
    const value = truncate(field.value, Math.min(1024, remaining - 60));
    boundedFields.push({ ...field, value });
    budget -= field.name.length + value.length;
  }
  if (boundedFields.length < fields.length) {
    if (boundedFields.length === 25) {
      boundedFields.pop();
    }
    boundedFields.push({ name: "Details", value: "...and " + (fields.length - boundedFields.length) + " more", inline: false });
  }
  const result = new EmbedBuilder()
    .setTitle(titleText)
    .setColor(color)
    .addFields(boundedFields)
    .setFooter({ text: footer })
    .setTimestamp();
  if (validMediaUrl(imageUrl)) result.setImage(imageUrl);
  if (validMediaUrl(avatarUrl)) result.setThumbnail(avatarUrl);
  return result;
}

export function logChannelId(settings: LogSettings): string {
  return settings.channelId ?? process.env.LOG_CHANNEL_ID ?? DEFAULT_CHANNEL_ID;
}

function ignored(settings: LogSettings, category: LogCategory, message?: Message | PartialMessage): boolean {
  if (!settings.enabled[category]) return true;
  if (!message) return false;
  if (message.channelId === logChannelId(settings)) return true;
  if (message.author && message.author.id === globalClient?.user?.id) return true;
  if (message.author?.bot && process.env.LOG_BOT_MESSAGES !== "true") return true;
  return settings.ignoredChannels.includes(message.channelId) ||
    (message.author ? settings.ignoredUsers.includes(message.author.id) : false) ||
    (message.member?.roles.cache.some((role) => settings.ignoredRoles.includes(role.id)) ?? false);
}

export async function enqueue(guild: Guild, category: LogCategory, item: EmbedBuilder, file?: QueueItem["file"], message?: Message | PartialMessage): Promise<void> {
  await getSettings(guild.id).then(async (settings) => {
    if (ignored(settings, category, message)) return;
    queue.push({ guildId: guild.id, embed: item, file });
    await drain();
  }).catch((error) => console.error("Failed to queue server log", error));
}

// guildId:channelId pairs that can never receive logs (channel is in another server or gone).
const unusableDestinations = new Set<string>();

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, 10);
      const grouped = new Map<string, QueueItem[]>();
      for (const item of batch) grouped.set(item.guildId, [...(grouped.get(item.guildId) ?? []), item]);
      for (const [guildId, items] of grouped) {
        try {
          const channelId = logChannelId(await getSettings(guildId));
          const destination = `${guildId}:${channelId}`;
          if (unusableDestinations.has(destination)) continue;
          let channel;
          try {
            channel = await globalClient?.guilds.cache.get(guildId)?.channels.fetch(channelId);
          } catch (error) {
            // The fallback channel belongs to another server, or the channel was deleted.
            // Remember it so this does not repeat for every log event.
            const code = (error as { code?: string | number } | null)?.code;
            if (code === "GuildChannelUnowned" || code === 10003 || code === 50001) {
              unusableDestinations.add(destination);
              console.warn(`Server logs are off for guild ${guildId}: channel ${channelId} is not usable there. Use /logs to choose a log channel.`);
              continue;
            }
            throw error;
          }
          if (!channel?.isSendable() || channel.guildId !== guildId) continue;
          let batch: QueueItem[] = [];
          let length = 0;
          const send = async () => {
            if (!batch.length) return;
            try {
              await channel.send({ embeds: batch.map((item) => item.embed), files: batch.flatMap((item) => item.file ? [item.file] : []), allowedMentions: { parse: [] } });
            } catch (error) {
              console.error("Failed to send server log", error);
            }
          };
          for (const item of items) {
            if (length + item.embed.length > 6000) {
              await send();
              batch = [];
              length = 0;
            }
            batch.push(item);
            length += item.embed.length;
          }
          await send();
        } catch (error) {
          console.error("Failed to resolve server log destination", error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    draining = false;
  }
}

let globalClient: Client | null = null;
let flushPendingVoiceLogs: () => void = () => {};
const botVoiceChanges = new Map<string, number>();
export function markVoiceChangeByBot(guildId: string, userId: string): void {
  const now = Date.now();
  for (const [key, at] of botVoiceChanges) if (now - at > 10_000) botVoiceChanges.delete(key);
  if (botVoiceChanges.size >= 1_000) botVoiceChanges.delete(botVoiceChanges.keys().next().value!);
  botVoiceChanges.set(`${guildId}:${userId}`, now);
}
export function logCommand(guild: Guild, userId: string, command: string, options: string, channelId: string, prefix = false): void {
  const user = globalClient?.users.cache.get(userId);
  const displayName = guild.members.cache.get(userId)?.displayName;
  enqueue(guild, "commands", embed(guild, `${prefix ? "Prefix" : "Slash"} command used`, COLORS.command,
    commandLogDetails(userId, command, options, channelId, prefix, user?.username, displayName)));
}

export function logCommandError(guild: Guild, userId: string, command: string, error: unknown, channelId?: string): void {
  const user = globalClient?.users.cache.get(userId);
  enqueue(guild, "commands", embed(guild, "Command error", COLORS.delete, [["Who", userText(userId, user?.username)], ["Actor", userText(userId, user?.username)], ["Command", command], ...(channelId ? [["Channel", `<#${channelId}>`] as [string, string]] : []), ["Error", error instanceof Error ? humanize(error.name) : "Unknown error"] ]));
}

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  return Reflect.get(value, key);
}

function enumLabel(values: Record<number, string>, value: unknown): string {
  return typeof value === "number" && values[value] ? humanize(values[value]!) : "Unknown";
}

const propertyLabels: Record<string, string> = {
  parentId: "Category",
  rateLimitPerUser: "Slowmode",
  nsfw: "NSFW",
  hoist: "Display separately",
  userLimit: "User limit",
};

const propertyEnums: Record<string, Record<number, string>> = {
  verificationLevel: GuildVerificationLevel,
  explicitContentFilter: GuildExplicitContentFilter,
  defaultMessageNotifications: GuildDefaultMessageNotifications,
  status: GuildScheduledEventStatus,
  entityType: GuildScheduledEventEntityType,
  eventType: AutoModerationRuleEventType,
  triggerType: AutoModerationRuleTriggerType,
};

function displayProperty(item: unknown, property: string, value: unknown): string {
  if (value === undefined) return "Unknown";
  if (value === null) return "None";
  if (property === "parentId" || property === "channelId" || property === "afkChannelId" || property === "systemChannelId") {
    const channel = (readProperty(item, "guild") as Guild | undefined)?.channels.cache.get(String(value));
    return channel ? escapeMarkdown(channel.name) + idMarker("Channel", channel.id) : idText(String(value));
  }
  if (property === "type") return enumLabel(ChannelType, value);
  const values = propertyEnums[property];
  if (values) return enumLabel(values, value);
  if (property === "name" && readProperty(item, "permissionOverwrites")) return "#" + escapeMarkdown(String(value));
  if (property === "topic") return '"' + escapeMarkdown(String(value)) + '"';
  if (property === "rateLimitPerUser" || property === "afkTimeout") return String(value) + "s";
  if (property === "bitrate") return String(Number(value) / 1000) + " kbps";
  if (property === "color") return "#" + Number(value).toString(16).padStart(6, "0").toUpperCase();
  if (property.endsWith("Timestamp") && typeof value === "number") return "<t:" + Math.floor(value / 1000) + ":F>";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string") return escapeMarkdown(value) || "None";
  if (typeof value === "number") return String(value);
  return "Unknown";
}

function genericTarget(item: unknown): string {
  const name = readProperty(item, "name") ?? readProperty(item, "code");
  const id = readProperty(item, "id");
  if (name && id && readProperty(item, "permissions") !== undefined) return `${String(name)}${idMarker("Role", String(id))}`;
  if (name && id && readProperty(item, "type") !== undefined && readProperty(item, "guild") !== undefined) return `<#${String(id)}>${idMarker("Channel", String(id))}`;
  if (name && id && globalClient?.users.cache.has(String(id))) return userText(String(id), String(name));
  if (name && id) return `${String(name)} (${String(id)})`;
  if (name) return String(name);
  return id ? String(id) : "Event target not identified";
}

function changedProperties(previous: unknown, current: unknown, properties: readonly string[]): Array<[string, string]> {
  return properties.flatMap((property): Array<[string, string]> => {
    const before = readProperty(previous, property);
    const after = readProperty(current, property);
    if (before === after) return [];
    if (property === "tags" && typeof before === "string" && typeof after === "string") {
      const tags = (value: string) => value.split(",").map((tag) => tag.trim()).sort().join(", ");
      if (tags(before) === tags(after)) return [];
    }
    if (property === "permissions") {
      const oldBits = readProperty(before, "bitfield");
      const newBits = readProperty(after, "bitfield");
      if (typeof oldBits !== "bigint" || typeof newBits !== "bigint" || oldBits === newBits) return [];
      const details = [
        ...(newBits & ~oldBits ? ["Granted " + permissionNames(newBits & ~oldBits)] : []),
        ...(oldBits & ~newBits ? ["Removed " + permissionNames(oldBits & ~newBits)] : []),
      ];
      return [["Permissions", details.join("\\n")]];
    }
    return [[propertyLabels[property] ?? humanize(property),
      displayProperty(previous, property, before) + " → " + displayProperty(current, property, after)]];
  });
}

async function withInviteFetch<T>(guild: Guild, operation: () => Promise<T>): Promise<T> {
  const previous = inviteFetchQueues.get(guild.id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  inviteFetchQueues.set(guild.id, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (inviteFetchQueues.get(guild.id) === queued) {
      inviteFetchQueues.delete(guild.id);
    }
  }
}

async function loadInviteSnapshot(guild: Guild): Promise<InviteSnapshot> {
  const invites = await guild.invites.fetch();
  return new Map(
    [...invites.values()].map((invite) => [
      invite.code,
      {
        uses: invite.uses ?? 0,
        inviter: invite.inviter ? userText(invite.inviter.id, invite.inviter.tag) : "creator not identified",
      },
    ]),
  );
}

async function identifyJoinInvite(guild: Guild): Promise<string> {
  return withInviteFetch(guild, async () => {
    const previous = inviteSnapshots.get(guild.id);
    const current = await loadInviteSnapshot(guild);
    inviteSnapshots.set(guild.id, current);
    if (!previous) return "Unknown (invite tracking is initializing)";

    const increased = [...current.entries()].filter(
      ([code, invite]) => invite.uses > (previous.get(code)?.uses ?? 0),
    );
    if (increased.length === 1 && increased[0]![1].uses - (previous.get(increased[0]![0])?.uses ?? 0) === 1) {
      const [code, invite] = increased[0]!;
      return `${code} (created by ${invite.inviter}, ${invite.uses} uses)`;
    }
    if (increased.length) return "Unknown (multiple invite uses detected)";
    return "Unknown (no invite usage increase detected)";
  });
}

export function registerServerLogger(client: Client): void {
  globalClient = client;
  client.once(Events.ClientReady, (readyClient) => {
    for (const guild of readyClient.guilds.cache.values()) {
      void withInviteFetch(guild, async () => {
        inviteSnapshots.set(guild.id, await loadInviteSnapshot(guild));
      }).catch((error) => {
        console.warn(`Could not initialize invite tracking for guild ${guild.id}`, error);
      });
    }
  });
  const safe = (event: string, handler: (...args: any[]) => Promise<void> | void) => {
    client.on(event as never, (...args: any[]) => {
      try {
        void Promise.resolve(handler(...args)).catch((error) => console.error("Server log handler failed for", event, error));
      } catch (error) {
        console.error("Server log handler failed for", event, error);
      }
    });
  };

  safe(Events.MessageDelete, async (message: Message | PartialMessage) => {
    const snapshot = snapshotMessage(message) ?? snapshots.get(message.id);
    snapshots.delete(message.id);
    const guild = message.guild;
    if (!guild) return;
    const settings = await getSettings(guild.id);
    if (ignored(settings, "messages", message)) return;
    if (snapshot && (snapshot.authorId === client.user?.id ||
        (snapshot.authorBot && process.env.LOG_BOT_MESSAGES !== "true") ||
        settings.ignoredUsers.includes(snapshot.authorId))) return;
    const actor = snapshot
      ? await auditActor(guild, AuditLogEvent.MessageDelete, snapshot.authorId, message.channelId)
      : "";
    const fields: Array<[string, string]> = [
      ["Who", snapshot ? userText(snapshot.authorId, snapshot.authorTag) : "Unknown"],
      ["Actor", deletedByLabel(Boolean(snapshot), actor)],
      ["Channel", idText(message.channelId) + idMarker("Message", message.id)],
    ];
    if (!snapshot) fields.push(["Content", "Content unavailable (message wasn't cached)"]);
    else {
      if (snapshot.content) fields.push(["Content", /^https?:\/\/\S+$/i.test(snapshot.content.trim())
        ? "Link/GIF only\\n" + escapeMarkdown(snapshot.content) : escapeMarkdown(snapshot.content)]);
      if (snapshot.attachments) fields.push(["Attachments", snapshot.attachments]);
      if (snapshot.stickers) fields.push(["Stickers", snapshot.stickers]);
      if (snapshot.embeds) fields.push(["Embeds", snapshot.embeds]);
      if (!snapshot.content && !snapshot.attachments && !snapshot.stickers && !snapshot.embeds) {
        fields.push(["Content", "No text, attachments, stickers or embeds"]);
      }
    }
    await enqueue(guild, "messages", embed(guild, "Message deleted", COLORS.delete, fields,
      undefined, snapshot?.imageUrl, snapshot?.avatarUrl), undefined, message);
  });
  safe(Events.MessageUpdate, async (oldMessage: Message | PartialMessage, message: Message | PartialMessage) => {
    const guild = message.guild;
    if (!guild) return;
    const before = snapshotMessage(oldMessage) ?? snapshots.get(message.id);
    const after = snapshotMessage(message);
    if (!after) return;
    rememberMessage(after);
    if (!before) return;
    const changes: Array<[string, string]> = [];
    if (before.content !== after.content) changes.push(
      ["Before", escapeMarkdown(before.content) || "No text"], ["After", escapeMarkdown(after.content) || "No text"],
    );
    if (before.attachmentIds !== after.attachmentIds) changes.push(["Attachments", (before.attachments || "None") + " → " + (after.attachments || "None")]);
    if (before.stickerIds !== after.stickerIds) changes.push(["Stickers", (before.stickers || "None") + " → " + (after.stickers || "None")]);
    if (!changes.length) return;
    await enqueue(guild, "messages", embed(guild, "Message updated", COLORS.update, [
      ["Who", userText(after.authorId, after.authorTag)], ["Channel", idText(message.channelId) + idMarker("Message", message.id)], ...changes,
    ], undefined, after.imageUrl, after.avatarUrl), undefined, message);
  });
  safe(Events.MessageBulkDelete, async (messages: any) => {
    const first = messages.first?.() as Message | undefined;
    if (first?.guild) {
      const settings = await getSettings(first.guild.id);
      const affectedMessages = [...messages.values()].filter((message: Message) => {
        snapshots.delete(message.id);
        return !ignored(settings, "messages", message);
      });
      if (!affectedMessages.length) return;
      const authors = affectedMessages.map((message: Message) => message.author && userText(message.author.id, message.author.tag));
      const affected = [...new Set(authors.filter(Boolean))];
      const actor = await auditActor(first.guild, AuditLogEvent.MessageBulkDelete, first.channelId);
      const who = affected.length > 10 ? `${affected.slice(0, 10).join(", ")} +${affected.length - 10} more` : affected.join(", ");
      enqueue(first.guild, "messages", embed(first.guild, "Messages bulk deleted", COLORS.delete, [
        ["Who", who || "Message authors not identified"],
        ...optionalActorField(actor), ["Channel", idText(first.channelId)], ["Count", String(affectedMessages.length)],
      ]));
    }
  });
  safe(Events.MessageReactionAdd, async (reaction: any, user: any) => {
    const message = reaction.message as Message;
    if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "Reaction added", COLORS.create, [["Who", message.author ? userText(message.author.id, message.author.username) : "Message author not identified"], ["Actor", userText(user.id, user.username)], ["Emoji", reaction.emoji.toString()], ["Message", message.id], ["Channel", idText(message.channelId)]]), undefined, message);
  });
  safe(Events.MessageReactionRemove, async (reaction: any, user: any) => {
    const message = reaction.message as Message;
    if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "Reaction removed", COLORS.delete, [["Who", message.author ? userText(message.author.id, message.author.username) : "Message author not identified"], ["Actor", userText(user.id, user.username)], ["Emoji", reaction.emoji.toString()], ["Message", message.id], ["Channel", idText(message.channelId)]]), undefined, message);
  });
  safe(Events.MessageReactionRemoveAll, async (message: Message) => { if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "All reactions removed", COLORS.delete, [["Who", message.author ? userText(message.author.id, message.author.username) : "Message author not identified"], ["Message", message.id], ["Channel", idText(message.channelId)]]), undefined, message); });
  safe(Events.MessageReactionRemoveEmoji, async (reaction: any) => { const message = reaction.message as Message; if (message.guild) enqueue(message.guild, "messages", embed(message.guild, "Reaction emoji removed", COLORS.delete, [["Who", message.author ? userText(message.author.id, message.author.username) : "Message author not identified"], ["Emoji", reaction.emoji.toString()], ["Message", message.id], ["Channel", idText(message.channelId)]]), undefined, message); });
  safe(Events.ChannelPinsUpdate, async (channel: GuildChannel) => {
    if (!channel.guild) return;
    const settings = await getSettings(channel.guild.id);
    if (channel.id === logChannelId(settings) || settings.ignoredChannels.includes(channel.id)) return;
    await enqueue(channel.guild, "messages", embed(channel.guild, "Channel pins updated", COLORS.update,
      [["Channel", idText(channel.id)]]));
  });
  safe(Events.MessageCreate, async (message: Message) => {
    const snapshot = snapshotMessage(message);
    if (snapshot && snapshot.authorId !== client.user?.id) rememberMessage(snapshot);
  });

  safe(Events.GuildMemberAdd, async (member: GuildMember) => {
    let attribution = "Unknown";
    try {
      attribution = await identifyJoinInvite(member.guild);
    } catch (error) {
      console.warn("Could not identify the invite used by a joining member", error);
    }
    enqueue(member.guild, "members", embed(member.guild, "Member joined", COLORS.create, [
      ["Who", userText(member.id, member.user.username)],
      ["Account age", `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`],
      ["Invite", attribution],
    ]));
  });
  safe(Events.GuildMemberRemove, async (member: GuildMember) => enqueue(member.guild, "members", embed(member.guild, "Member left", COLORS.delete, [["Who", userText(member.id, member.user.username)], ...optionalActorField(await auditActor(member.guild, AuditLogEvent.MemberKick, member.id)), ["Reason", "Member left or was removed"]])));
  safe(Events.GuildBanAdd, async (ban: any) => enqueue(ban.guild, "members", embed(ban.guild, "Member banned", COLORS.delete, [["Who", userText(ban.user.id, ban.user.username)], ...optionalActorField(await auditActor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id)), ["Reason", ban.reason ?? "No reason provided"]])));
  safe(Events.GuildBanRemove, async (ban: any) => enqueue(ban.guild, "members", embed(ban.guild, "Member unbanned", COLORS.create, [["Who", userText(ban.user.id, ban.user.username)], ...optionalActorField(await auditActor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id)), ["Reason", ban.reason ?? "No reason provided"]])));
  safe(Events.GuildMemberUpdate, async (oldMember: GuildMember | PartialGuildMember, member: GuildMember) => {
    if (oldMember.partial) return;
    const changes: Array<[string, string]> = [];
    if (oldMember.nickname !== member.nickname) changes.push(["Nickname", `${oldMember.nickname ?? "none"} → ${member.nickname ?? "none"}`]);
    const added = member.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id)).map((role) => role.name);
    const removed = oldMember.roles.cache.filter((role) => !member.roles.cache.has(role.id)).map((role) => role.name);
    if (added.length) changes.push(["Roles added", formatRoleList(added)]);
    if (removed.length) changes.push(["Roles removed", formatRoleList(removed)]);
    if (oldMember.communicationDisabledUntilTimestamp !== member.communicationDisabledUntilTimestamp) changes.push(["Timeout", member.communicationDisabledUntilTimestamp ? `until <t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:F>` : "removed"]);
    if (changes.length) {
      const settings = await getSettings(member.guild.id);
      if (!settings.enabled.members || settings.ignoredUsers.includes(member.id) ||
          member.roles.cache.some((role) => settings.ignoredRoles.includes(role.id))) return;
      const roleChanged = added.length || removed.length;
      const profileChanged = changes.some(([name]) => name === "Nickname" || name === "Timeout");
      const actor = roleChanged && profileChanged ? "" : await auditActor(
        member.guild, roleChanged ? AuditLogEvent.MemberRoleUpdate : AuditLogEvent.MemberUpdate, member.id,
      );
      enqueue(member.guild, "members", embed(member.guild, "Member updated", COLORS.update, [...optionalActorField(actor), ["Who", userText(member.id, member.user.username)], ...changes]));
    }
  });
  safe(Events.UserUpdate, async (oldUser: User | PartialUser, user: User) => {
    if (oldUser.partial) return;
    const fields = changedProperties(oldUser, user, ["username", "globalName"]);
    if (oldUser.avatar !== user.avatar) fields.push(["Avatar", "Changed"]);
    if (!fields.length) return;
    for (const guild of client.guilds.cache.values()) {
      if (!guild.members.cache.has(user.id)) continue;
      await enqueue(guild, "members", embed(guild, "User profile updated", COLORS.update,
        [["Who", userText(user.id, user.username)], ...fields], undefined, undefined, avatarUrl(user)));
    }
  });
  const voiceMembers = new Map<string, { guild: Guild; member: GuildMember }>();
  const voiceBatcher = new VoiceLogBatcher((key, changes) => {
    const write = logVoiceChanges(key, changes).catch((error) => console.error("Failed to log voice changes", error));
    pendingVoiceWrites.add(write);
    void write.finally(() => pendingVoiceWrites.delete(write));
  });
  async function logVoiceChanges(key: string, changes: VoiceLogChange[]): Promise<void> {
    const context = voiceMembers.get(key);
    voiceMembers.delete(key);
    if (!context || !changes.length) return;
    const summary = summarizeVoiceChanges(changes);
    if (!summary) return;
    const channelId = context.member.voice.channelId;
    const settings = await getSettings(context.guild.id);
    if (!settings.enabled.voice || settings.ignoredUsers.includes(context.member.id) ||
        (channelId && settings.ignoredChannels.includes(channelId)) ||
        context.member.roles.cache.some((role) => settings.ignoredRoles.includes(role.id))) return;
    const botDidIt = Date.now() - (botVoiceChanges.get(key) ?? 0) < 10_000;
    botVoiceChanges.delete(key);
    const hasServerChange = changes.some((change) => change.title.startsWith("Server "));
    const memberLabel = userText(context.member.id, context.member.displayName);
    let actor = "";
    if (botDidIt && hasServerChange && globalClient?.user) actor = userText(globalClient.user.id, globalClient.user.username);
    else if (hasServerChange) actor = await auditActor(context.guild, AuditLogEvent.MemberUpdate, context.member.id);
    if (actor === memberLabel || actor.includes(`{User:${context.member.id}}`)) actor = "";
    const details = [...summary.changes];
    const hasChannel = !!channelId;
    if (!hasChannel && summary.title === "Left voice channel") {
      const endpoint = changes.find((change) => change.title === "Left voice channel");
      if (endpoint) details.unshift(endpoint.text);
    }
    await enqueue(context.guild, "voice", embed(context.guild, summary.title, summary.color, [
      ["Who", memberLabel],
      ...optionalActorField(actor),
      ...(channelId ? [["Channel", idText(channelId)] as [string, string]] : []),
      ["Changes", details.join(", then ")],
    ], undefined, undefined, avatarUrl(context.member.user)));
  }
  flushPendingVoiceLogs = () => voiceBatcher.flushAll();
  safe(Events.VoiceStateUpdate, async (oldState: any, newState: any) => {
    const member = newState.member ?? oldState.member;
    if (!member || (member.user.bot && member.id !== globalClient?.user?.id && process.env.LOG_BOT_MESSAGES !== "true")) return;
    const changes = describeVoiceChanges(oldState, newState);
    if (!changes.length) return;
    const key = `${member.guild.id}:${member.id}`;
    voiceMembers.set(key, { guild: member.guild, member });
    for (const change of changes) voiceBatcher.add(key, change);
  });
  process.once("SIGINT", flushPendingVoiceLogs);
  process.once("SIGTERM", flushPendingVoiceLogs);

  safe(Events.InviteCreate, async (invite: any) => {
    const guild = invite.guild as Guild | null;
    if (!guild) return;
    inviteSnapshots.get(guild.id)?.set(invite.code, {
      uses: invite.uses ?? 0,
      inviter: invite.inviter ? userText(invite.inviter.id, invite.inviter.tag) : "creator not identified",
    });
    enqueue(guild, "server", embed(guild, "Invite created", COLORS.create, [
      ...optionalActorField(invite.inviter ? userText(invite.inviter.id, invite.inviter.username) : ""),
      ["Code", invite.code],
      ["Channel", idText(invite.channelId)],
      ["Uses", `${invite.uses ?? 0}${invite.maxUses ? ` / ${invite.maxUses}` : " / unlimited"}`],
      ["Expires", invite.maxAge ? `${invite.maxAge} seconds` : "Never"],
    ]));
  });
  safe(Events.ThreadMembersUpdate, async (added: any, removed: any, thread: any) => {
    const guild = thread?.guild as Guild | undefined;
    if (!guild) return;
    if (!added.size && !removed.size) return;
    const formatMembers = (collection: any) =>
      [...(collection?.values?.() ?? [])]
      .map((member: any) => userText(member.id, member.user?.username ?? member.username))
        .join(", ") || "none";
    enqueue(guild, "channels", embed(guild, "Thread members updated", COLORS.update, [
      ["Thread", genericTarget(thread)],
      ["Who", `Added: ${formatMembers(added)}; removed: ${formatMembers(removed)}`],
      ...optionalActorField(""),
      ...(thread.id ? [["Channel", `<#${thread.id}>`] as [string, string]] : []),
      ...(added.size ? [["Added", formatMembers(added)] as [string, string]] : []),
      ...(removed.size ? [["Removed", formatMembers(removed)] as [string, string]] : []),
    ]));
  });
  const logScheduledEventUser = (title: string, color: number) =>
    async (event: any, user: any) => {
      const guild = event?.guild as Guild | undefined;
      if (!guild) return;
      enqueue(guild, "server", embed(guild, title, color, [
        ["Event", genericTarget(event)],
        ["Who", user ? userText(user.id, user.username) : "Member not identified"],
        ...(event.channelId ? [["Channel", `<#${event.channelId}>`] as [string, string]] : []),
      ]));
    };
  safe(Events.GuildScheduledEventUserAdd, logScheduledEventUser("Scheduled event user joined", COLORS.create));
  safe(Events.GuildScheduledEventUserRemove, logScheduledEventUser("Scheduled event user left", COLORS.delete));
  safe(Events.AutoModerationActionExecution, async (execution: any) => {
    const guild = execution.guild as Guild | undefined;
    if (!guild) return;
    enqueue(guild, "automod", embed(guild, "Automod action executed", COLORS.delete, [
      ["Who", execution.user ? userText(execution.user.id, execution.user.username) : "Member not identified"],
      ["Actor", "AutoMod"], ["Rule", execution.autoModerationRule?.name ?? "Unknown rule (" + execution.ruleId + ")"],
      ...(execution.channelId ? [["Channel", `<#${execution.channelId}>`] as [string, string]] : []),
      ["Action", enumLabel(AutoModerationActionType, execution.action?.type)],
    ]));
  });

  type GenericLog = {
    event: string;
    category: LogCategory;
    title: string;
    color: number;
    auditType?: AuditLogEvent;
    update?: boolean;
  };
  const generic: GenericLog[] = [
    { event: Events.ChannelCreate, category: "channels", title: "Channel created", color: COLORS.create, auditType: AuditLogEvent.ChannelCreate },
    { event: Events.ChannelDelete, category: "channels", title: "Channel deleted", color: COLORS.delete, auditType: AuditLogEvent.ChannelDelete },
    { event: Events.ThreadCreate, category: "channels", title: "Thread created", color: COLORS.create, auditType: AuditLogEvent.ThreadCreate },
    { event: Events.ThreadDelete, category: "channels", title: "Thread deleted", color: COLORS.delete, auditType: AuditLogEvent.ThreadDelete },
    { event: Events.ThreadUpdate, category: "channels", title: "Thread updated", color: COLORS.update, auditType: AuditLogEvent.ThreadUpdate, update: true },
    { event: Events.GuildRoleCreate, category: "roles", title: "Role created", color: COLORS.create, auditType: AuditLogEvent.RoleCreate },
    { event: Events.GuildRoleDelete, category: "roles", title: "Role deleted", color: COLORS.delete, auditType: AuditLogEvent.RoleDelete },
    { event: Events.GuildRoleUpdate, category: "roles", title: "Role updated", color: COLORS.update, auditType: AuditLogEvent.RoleUpdate, update: true },
    { event: Events.GuildUpdate, category: "server", title: "Server updated", color: COLORS.update, auditType: AuditLogEvent.GuildUpdate, update: true },
    { event: Events.GuildEmojiCreate, category: "server", title: "Emoji created", color: COLORS.create, auditType: AuditLogEvent.EmojiCreate },
    { event: Events.GuildEmojiDelete, category: "server", title: "Emoji deleted", color: COLORS.delete, auditType: AuditLogEvent.EmojiDelete },
    { event: Events.GuildEmojiUpdate, category: "server", title: "Emoji updated", color: COLORS.update, auditType: AuditLogEvent.EmojiUpdate, update: true },
    { event: Events.GuildCreate, category: "server", title: "Bot added to server", color: COLORS.create, auditType: AuditLogEvent.BotAdd },
    { event: Events.GuildDelete, category: "server", title: "Bot removed from server", color: COLORS.delete },
    { event: Events.GuildStickerCreate, category: "server", title: "Sticker created", color: COLORS.create, auditType: AuditLogEvent.StickerCreate },
    { event: Events.GuildStickerDelete, category: "server", title: "Sticker deleted", color: COLORS.delete, auditType: AuditLogEvent.StickerDelete },
    { event: Events.GuildStickerUpdate, category: "server", title: "Sticker updated", color: COLORS.update, auditType: AuditLogEvent.StickerUpdate, update: true },
    { event: Events.InviteDelete, category: "server", title: "Invite deleted", color: COLORS.delete, auditType: AuditLogEvent.InviteDelete },
    { event: Events.WebhooksUpdate, category: "server", title: "Webhooks updated", color: COLORS.update },
    { event: Events.GuildIntegrationsUpdate, category: "server", title: "Integrations updated", color: COLORS.update },
    { event: Events.StageInstanceCreate, category: "voice", title: "Stage instance created", color: COLORS.create, auditType: AuditLogEvent.StageInstanceCreate },
    { event: Events.StageInstanceUpdate, category: "voice", title: "Stage instance updated", color: COLORS.update, auditType: AuditLogEvent.StageInstanceUpdate, update: true },
    { event: Events.StageInstanceDelete, category: "voice", title: "Stage instance deleted", color: COLORS.delete, auditType: AuditLogEvent.StageInstanceDelete },
    { event: Events.GuildScheduledEventCreate, category: "server", title: "Scheduled event created", color: COLORS.create, auditType: AuditLogEvent.GuildScheduledEventCreate },
    { event: Events.GuildScheduledEventDelete, category: "server", title: "Scheduled event deleted", color: COLORS.delete, auditType: AuditLogEvent.GuildScheduledEventDelete },
    { event: Events.GuildScheduledEventUpdate, category: "server", title: "Scheduled event updated", color: COLORS.update, auditType: AuditLogEvent.GuildScheduledEventUpdate, update: true },
    { event: Events.AutoModerationRuleCreate, category: "automod", title: "Automod rule created", color: COLORS.create, auditType: AuditLogEvent.AutoModerationRuleCreate },
    { event: Events.AutoModerationRuleUpdate, category: "automod", title: "Automod rule updated", color: COLORS.update, auditType: AuditLogEvent.AutoModerationRuleUpdate, update: true },
    { event: Events.AutoModerationRuleDelete, category: "automod", title: "Automod rule deleted", color: COLORS.delete, auditType: AuditLogEvent.AutoModerationRuleDelete },
  ];
  const trackedProperties: Record<LogCategory, string[]> = {
    messages: [],
    members: [],
    voice: ["topic", "channelId"],
    channels: ["name", "topic", "type", "parentId", "bitrate", "userLimit", "rateLimitPerUser", "nsfw", "archived", "locked", "invitable", "autoArchiveDuration"],
    roles: ["name", "color", "hoist", "mentionable", "permissions"],
    server: ["name", "description", "verificationLevel", "explicitContentFilter", "defaultMessageNotifications", "preferredLocale", "afkChannelId", "afkTimeout", "systemChannelId"],
    commands: [],
    automod: ["name", "enabled", "eventType", "triggerType"],
  };

  safe(Events.ChannelUpdate, async (previous: GuildChannel, channel: GuildChannel) => {
    if (!previous.permissionOverwrites || !channel.permissionOverwrites) return;
    const overwriteLabel = ({ id, type }: PermissionOverwrites) => {
      if (id === channel.guild.id) return "@everyone";
      if (type === OverwriteType.Role) return channel.guild.roles.cache.has(id)
        ? "<@&" + id + ">" : "Unknown role (" + id + ")";
      return channel.guild.members.cache.has(id) || client.users.cache.has(id)
        ? userText(id) : "Unknown user (" + id + ")";
    };
    const permissions = channelPermissionChanges(previous.permissionOverwrites.cache, channel.permissionOverwrites.cache, overwriteLabel);
    const changes = changedProperties(previous, channel, trackedProperties.channels);
    if (!permissions.length && !changes.length) return;
    const auditTypes = permissions.length
      ? [AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteDelete]
      : [];
    auditTypes.push(AuditLogEvent.ChannelUpdate);
    const actors = new Set((await Promise.all(auditTypes.map((type) => auditActor(channel.guild, type, channel.id)))).filter(Boolean));
    const actor = actors.size === 1 ? [...actors][0]! : "Unknown";
    const fields: Array<[string, string]> = [
      ["Channel", idText(channel.id) + " (" + enumLabel(ChannelType, channel.type) + ")"],
      ["Actor", actor],
      ...(permissions.length ? [["Permissions", permissions.join("\\n")] as [string, string]] : []),
      ...changes,
    ];
    await enqueue(channel.guild, "channels", embed(channel.guild, "Channel updated", COLORS.update, fields));
  });

  for (const config of generic) {
    safe(config.event, async (...args: any[]) => {
      const previous = args[0];
      const item = config.update ? args[1] : args[0];
      const guild = readProperty(item, "guild") as Guild | undefined
        ?? (readProperty(item, "guildId")
          ? globalClient?.guilds.cache.get(String(readProperty(item, "guildId")))
          : undefined)
        ?? (readProperty(item, "commands") ? item as Guild : undefined);
      if (!guild) return;

      const id = config.auditType === AuditLogEvent.BotAdd
        ? globalClient?.user?.id
        : config.auditType === AuditLogEvent.InviteDelete
          ? readProperty(item, "code") ?? readProperty(item, "id")
          : readProperty(item, "id");
      const properties = config.event === Events.GuildEmojiUpdate ? ["name", "available"]
        : config.event === Events.GuildStickerUpdate ? ["name", "description", "tags", "available"]
        : config.event === Events.GuildScheduledEventUpdate ? ["name", "description", "channelId", "scheduledStartTimestamp", "scheduledEndTimestamp", "status", "entityType"]
        : trackedProperties[config.category];
      if (config.update && readProperty(previous, "partial")) return;
      const details = config.update ? changedProperties(previous, item, properties) : [];
      if (config.update && !details.length) return;
      const actor = config.auditType ? await auditActor(guild, config.auditType, id ? String(id) : undefined) : "";
      const values: Array<[string, string]> = [
        ...optionalActorField(actor),
        ["Target", config.category === "channels" && id ? idText(String(id)) : genericTarget(item)],
      ];
      const channelId = readProperty(item, "channelId");
      if (typeof channelId === "string" && channelId) values.push(["Channel", idText(channelId)]);
      const type = readProperty(item, "type");
      if (config.category === "channels" && type !== undefined && !details.some(([name]) => name === "Type")) {
        values.push(["Type", enumLabel(ChannelType, type)]);
      }
      if ((config.event === Events.GuildStickerCreate || config.event === Events.GuildStickerDelete) && type !== undefined) {
        values.push(["Type", enumLabel(StickerType, type)]);
      }
      values.push(...details);
      enqueue(guild, config.category, embed(guild, config.title, config.color, values));
    });
  }
}

export async function flushVoiceLogs(): Promise<void> {
  flushPendingVoiceLogs();
  while (pendingVoiceWrites.size) await Promise.all([...pendingVoiceWrites]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!draining && queue.length) await drain();
  while (draining || queue.length) await new Promise((resolve) => setTimeout(resolve, 25));
}
