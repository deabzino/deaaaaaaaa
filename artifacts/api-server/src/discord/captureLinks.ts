import { createHash } from "node:crypto";
import {
  ActionRowBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type Guild, type StringSelectMenuInteraction,
} from "discord.js";
import { ColourLinks, normalizePlayerName } from "../among-us/colourLinks";
import { createMatchStore } from "../among-us/matchStore";
import { COLOUR_NAMES } from "../among-us/protocol";
import { captureRegistry, type CaptureBinding } from "../among-us/registry";
import type { CaptureStatus } from "../among-us/status";
import { logger } from "../lib/logger";

export const CAPTURE_COLOUR_PICKER = "capture-colour";
export const linkCommand = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link a Discord member to an Among Us colour")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption((option) => option.setName("user").setDescription("Member in the paired voice channel").setRequired(true))
  .addIntegerOption((option) => option.setName("colour").setDescription("The player's in-game colour").setRequired(true)
    .addChoices(...COLOUR_NAMES.map((name, value) => ({ name, value }))))
  .toJSON();

export const unlinkCommand = new SlashCommandBuilder()
  .setName("unlink")
  .setDescription("Unlink your colour or forget saved Among Us names")
  .addUserOption((option) => option.setName("user").setDescription("Another member (requires Manage Server)"))
  .addBooleanOption((option) => option.setName("forget").setDescription("Also delete saved names for this member in this server"))
  .addStringOption((option) => option.setName("name").setDescription("Delete only this saved in-game name").setMaxLength(256))
  .toJSON();

const store = createMatchStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, (operation) => {
  logger.warn({ operation }, "Among Us name storage unavailable; using session links");
});
type LinkState = { binding?: CaptureBinding; links: ColourLinks; messageId?: string };
const states = new Map<string, LinkState>();
const queues = new Map<string, Promise<unknown>>();

function inOrder<T>(guildId: string, run: () => Promise<T>): Promise<T> {
  const result = (queues.get(guildId) ?? Promise.resolve()).then(run);
  const tail = result.catch(() => undefined).finally(() => {
    if (queues.get(guildId) === tail) queues.delete(guildId);
  });
  queues.set(guildId, tail);
  return result;
}

function stateFor(guildId: string, binding?: CaptureBinding): LinkState {
  const current = states.get(guildId);
  if (current && current.binding === binding) return current;
  const next = { binding, links: new ColourLinks(guildId, store) };
  states.set(guildId, next);
  return next;
}

function pickerValue(player: CaptureStatus["rosterPlayers"][number]): string {
  const nameHash = createHash("sha256").update(player.name).digest("hex").slice(0, 12);
  return `${player.id}:${player.colour}:${nameHash}`;
}

function voiceRoster(guild: Guild, channelId: string) {
  return Array.from(guild.voiceStates.cache.values()).flatMap((state) => {
    const member = state.member;
    if (state.channelId !== channelId || !member || member.user.bot) return [];
    return [{ id: member.id, names: [member.user.username, member.displayName, member.nickname ?? ""] }];
  });
}

export function renderCaptureLinks(guild: Guild, binding: CaptureBinding, status: CaptureStatus) {
  return inOrder(guild.id, async () => {
    if (captureRegistry.view(guild.id)?.binding !== binding || status.phase === "Waiting for capture")
      return { roster: status.roster, components: [] };
    const { links } = stateFor(guild.id, binding);
    await links.reconcile(status.rosterPlayers, voiceRoster(guild, binding.voiceChannelId));
    const roster = status.roster.map((row, index) => {
      const userId = links.userFor(status.rosterPlayers[index]!);
      return userId ? `${row} · <@${userId}>` : row;
    });
    const unlinked = status.rosterPlayers.filter((player) => !player.disconnected && !links.userFor(player));
    if (!unlinked.length) return { roster, components: [] };
    const picker = new StringSelectMenuBuilder().setCustomId(CAPTURE_COLOUR_PICKER)
      .setPlaceholder("Choose your Among Us colour")
      .addOptions(unlinked.map((player) => ({
        label: COLOUR_NAMES[player.colour]!,
        value: pickerValue(player),
      })));
    return { roster, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker)] };
  });
}

export function noteCaptureMessage(binding: CaptureBinding, messageId: string) {
  if (captureRegistry.view(binding.guildId)?.binding === binding) stateFor(binding.guildId, binding).messageId = messageId;
}

export async function handleCaptureLink(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply("Use this in a Discord server.");
    return;
  }
  const text = await inOrder(guild.id, async () => {
    const view = captureRegistry.view(guild.id);
    const state = stateFor(guild.id, view?.binding);
    const picker = interaction.isStringSelectMenu();
    const userId = picker ? interaction.user.id : interaction.options.getUser("user")?.id ?? interaction.user.id;
    const moderator = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if ((!picker && interaction.commandName === "link" && !moderator) || (userId !== interaction.user.id && !moderator)) {
      return "You need Manage Server to change another member’s link.";
    }

    if (!picker && interaction.commandName === "unlink") {
      const name = interaction.options.getString("name");
      const normalized = name === null ? undefined : normalizePlayerName(name);
      if (name !== null && !normalized) return "Enter an in-game name containing letters or numbers.";
      const forget = interaction.options.getBoolean("forget") === true || normalized !== undefined;
      const removed = await state.links.unlink(userId, forget, normalized);
      captureRegistry.refresh(guild.id);
      if (!forget) return "Session colour unlinked. Use forget:True to delete saved names too.";
      return removed ? (normalized ? "Saved name removed for this member." : "Saved names removed for this member in this server.")
        : "Session colour unlinked. Saved names could not be removed. Try again when storage is available.";
    }

    if (!view || interaction.channelId !== view.binding.textChannelId) {
      return "Run this in the paired text channel while the capture is showing a game.";
    }
    if (!voiceRoster(guild, view.binding.voiceChannelId).some((member) => member.id === userId)) {
      return "The member must be in the paired voice channel.";
    }
    const roster = view.status.rosterPlayers;
    const player = picker
      ? roster.find((entry) => interaction.message.id === state.messageId && interaction.values[0] === pickerValue(entry))
      : roster.find((entry) => entry.colour === interaction.options.getInteger("colour", true));
    if (!player) return "That colour is no longer available. Check the latest status message.";
    const result = await state.links.confirm(player, roster, userId, !picker);
    if (!result.linked) return "That colour is unavailable or already linked.";
    captureRegistry.refresh(guild.id);
    return result.saved ? "Colour linked and name saved for future games." : "Colour linked for this session. The name could not be saved.";
  });
  await interaction.editReply(text);
}
