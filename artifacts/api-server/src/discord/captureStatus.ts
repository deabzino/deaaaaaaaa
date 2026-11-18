import {
  DiscordAPIError, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder,
  type ChatInputCommandInteraction, type Message,
} from "discord.js";
import { captureRegistry } from "../among-us/registry";
import { logger } from "../lib/logger";
import { noteCaptureMessage, renderCaptureLinks } from "./captureLinks";

export const captureCommand = new SlashCommandBuilder()
  .setName("capture")
  .setDescription("Pair or revoke an Among Us capture app")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((command) => command.setName("pair").setDescription("Create a one-time Windows capture pairing code"))
  .addSubcommand((command) => command.setName("revoke").setDescription("Disconnect the capture app and revoke its credential"))
  .toJSON();

export async function handleCaptureCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild, channel } = interaction;
  if (!guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply("You need Manage Server to configure capture.");
    return;
  }
  if (interaction.options.getSubcommand() === "revoke") {
    const revoked = captureRegistry.revoke(guild.id);
    await interaction.editReply(revoked ? "Capture pairing revoked." : "There is no active capture pairing.");
    return;
  }

  const baseUrl = captureBaseUrl();
  if (!baseUrl) {
    await interaction.editReply("Capture pairing needs CAPTURE_PUBLIC_URL set to this dea server’s HTTPS origin.");
    return;
  }
  const voiceChannelId = guild.voiceStates.cache.get(interaction.user.id)?.channelId;
  if (!voiceChannelId) {
    await interaction.editReply("Join the voice channel you want to pair first.");
    return;
  }
  const bot = guild.members.me;
  if (!channel?.isSendable() || channel.isDMBased() || !bot || !channel.permissionsFor(bot)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
  ])) {
    await interaction.editReply("Choose a text channel where I can send messages and embed links.");
    return;
  }

  let message: Message | undefined;
  const code = captureRegistry.issue({ guildId: guild.id, textChannelId: channel.id, voiceChannelId }, async (status, binding) => {
    const { roster, components } = await renderCaptureLinks(guild, binding, status);
    const embed = new EmbedBuilder()
      .setTitle("Among Us")
      .addFields(
        { name: "Phase", value: status.phase, inline: true },
        { name: "Mode", value: status.mode, inline: true },
        { name: "Voice channel", value: `<#${binding.voiceChannelId}>`, inline: true },
        { name: "Lobby code", value: status.lobby, inline: true },
        { name: "Region", value: status.region, inline: true },
        { name: "Map", value: status.map, inline: true },
      )
      .setDescription(roster.length ? roster.join("\n") : "Waiting for players.");
    const options = { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
    try {
      if (message) {
        try {
          await message.edit(options);
          noteCaptureMessage(binding, message.id);
          return;
        } catch (error) {
          if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
          message = undefined;
        }
      }
      message = await channel.send(options);
      noteCaptureMessage(binding, message.id);
    } catch (error) {
      logger.warn({ guildId: guild.id, channelId: channel.id, code: error instanceof DiscordAPIError ? error.code : undefined },
        "Capture status message update failed");
      throw error;
    }
  });
  await interaction.editReply(
    `Enter **${code}** in the capture app with server **${baseUrl}**. This code can be used once and expires in five minutes.`,
  );
}

function captureBaseUrl(): string | undefined {
  try {
    const url = new URL(process.env.CAPTURE_PUBLIC_URL ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash)
      return url.origin;
  } catch {
    // An absent or invalid URL leaves pairing disabled.
  }
  return undefined;
}
