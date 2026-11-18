import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction, type Client, type Guild,
} from "discord.js";
import { MuteExecutor, type MuteEvent, type VoiceOps } from "../among-us/muteExecutor";
import { MuteTracker } from "../among-us/muteLogic";
import { captureRegistry, type CaptureBinding, type CaptureLatest } from "../among-us/registry";
import { logger } from "../lib/logger";
import { linkedUserFor, onLinksReconciled } from "./captureLinks";

export const CAPTURE_RESUME = "capture_resume_auto";
export const CAPTURE_STAY_MANUAL = "capture_stay_manual";

// The existing /dead list, injected from the bot so this module stays free of the database.
export type DeadList = {
  mark(guild: Guild, memberId: string): Promise<unknown>;
  clear(guild: Guild, memberId: string): Promise<unknown>;
};

type MuteState = {
  binding: CaptureBinding;
  executor: MuteExecutor;
  tracker: MuteTracker;
  // Members this module put on the /dead list, so only those are taken off again.
  autoDead: Set<string>;
  // Auto was switched off because the capture went quiet, and nobody has answered yet.
  lostAuto: boolean;
  asked: boolean;
};
const states = new Map<string, MuteState>();

// Dry run is the default: dea only logs the mutes it would make until this is set to false.
export function muteDryRun(): boolean {
  return !/^(?:false|0|off|no)$/i.test((process.env.CAPTURE_MUTE_DRY_RUN ?? "").trim());
}

function silenceMs(): number {
  const seconds = Number(process.env.CAPTURE_SILENCE_SECONDS);
  return Number.isFinite(seconds) && seconds >= 5 ? seconds * 1000 : 30_000;
}

function opsFor(guild: Guild, binding: CaptureBinding, markBotVoiceChange: (guildId: string, userId: string) => void): VoiceOps {
  return {
    view(userId) {
      const voice = guild.voiceStates.cache.get(userId);
      if (!voice?.channelId) return { inVoice: false, inPairedChannel: false, serverMute: false };
      return { inVoice: true, inPairedChannel: voice.channelId === binding.voiceChannelId, serverMute: voice.serverMute === true };
    },
    async setMute(userId, mute) {
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.MuteMembers))
        throw new Error("Missing the Mute Members permission");
      const member = guild.voiceStates.cache.get(userId)?.member ?? await guild.members.fetch(userId);
      markBotVoiceChange(guild.id, userId);
      await member.voice.setMute(mute, "Among Us automatic mute");
    },
  };
}

function logEvent(guildId: string, event: MuteEvent) {
  if (event.kind === "failed") {
    logger.warn({ guildId, userId: event.userId, attempt: event.attempt, willRetry: event.willRetry, err: event.error },
      "Among Us automatic mute failed");
  } else {
    logger.info({ guildId, userId: event.userId, action: event.kind, dryRun: event.dryRun },
      event.dryRun ? "Among Us DRY RUN: would change a server mute" : "Among Us automatic server mute changed");
  }
}

let markBotVoiceChange: (guildId: string, userId: string) => void = () => {};
let deadList: DeadList | undefined;

function stateFor(guild: Guild, binding: CaptureBinding): MuteState {
  const current = states.get(guild.id);
  if (current?.binding === binding) return current;
  // A new pairing starts clean, and the old one must not leave anyone muted.
  void current?.executor.release();
  const next: MuteState = {
    binding,
    tracker: new MuteTracker(),
    executor: new MuteExecutor({
      ops: opsFor(guild, binding, markBotVoiceChange),
      dryRun: muteDryRun(),
      log: (event) => logEvent(guild.id, event),
    }),
    autoDead: new Set(),
    lostAuto: false,
    asked: false,
  };
  states.set(guild.id, next);
  return next;
}

function clearAutoDead(guild: Guild, state: MuteState) {
  for (const memberId of state.autoDead) {
    if (muteDryRun()) logger.info({ guildId: guild.id, userId: memberId }, "Among Us DRY RUN: would take a member off the dead list");
    else void deadList?.clear(guild, memberId).catch((error) => logger.warn({ err: error, guildId: guild.id }, "Could not clear the dead list"));
  }
  state.autoDead.clear();
}

// Puts players whose death a meeting has announced on the /dead list, and clears them when the round is over.
// Only announced deaths are used, so the list never shows who died before the table knows.
function syncDeadList(guild: Guild, latest: CaptureLatest, state: MuteState) {
  const game = latest.game;
  if (!game || game.phase === "menu" || game.phase === "lobby" || game.phase === "ended") {
    clearAutoDead(guild, state);
    return;
  }
  const announced = new Set(latest.deadAnnounced);
  for (const player of game.players) {
    if (!announced.has(player.id)) continue;
    const userId = linkedUserFor(guild.id, latest.binding, player);
    if (!userId || state.autoDead.has(userId)) continue;
    state.autoDead.add(userId);
    if (muteDryRun()) logger.info({ guildId: guild.id, userId }, "Among Us DRY RUN: would add a member to the dead list");
    else void deadList?.mark(guild, userId).catch((error) => logger.warn({ err: error, guildId: guild.id }, "Could not update the dead list"));
  }
}

// Works out who should be muted from the capture's latest game state and moves Discord toward it.
// Nothing happens unless the session is in Auto mode. Leaving Auto releases every mute dea applied.
export function evaluateMutes(guild: Guild, force = false) {
  const latest = captureRegistry.latest(guild.id);
  if (!latest) return;
  const state = stateFor(guild, latest.binding);
  if (latest.mode !== "Auto") {
    if (!state.executor.isEmpty) void state.executor.release();
    clearAutoDead(guild, state);
    return;
  }
  syncDeadList(guild, latest, state);
  const target = state.tracker.desired(latest.game ?? null, (player) => linkedUserFor(guild.id, latest.binding, player));
  void state.executor.apply(target, force);
}

// A person ran a manual mute or unmute in the paired channel. Auto steps aside so the two do not fight,
// and the mutes the person just set are left exactly as they are.
export function pauseAutoForManual(guildId: string, voiceChannelId: string): boolean {
  const latest = captureRegistry.latest(guildId);
  if (!latest || latest.mode !== "Auto" || latest.binding.voiceChannelId !== voiceChannelId) return false;
  const state = states.get(guildId);
  state?.executor.forget();
  state?.autoDead.clear();
  return captureRegistry.setMode(guildId, "Paused");
}

function releaseGuild(guildId: string) {
  const state = states.get(guildId);
  if (!state) return;
  void state.executor.release().finally(() => {
    if (states.get(guildId) === state && !captureRegistry.latest(guildId)) states.delete(guildId);
  });
}

async function notify(client: Client, binding: CaptureBinding, payload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }) {
  const channel = client.channels?.cache.get(binding.textChannelId);
  if (!channel?.isSendable()) return;
  try {
    await channel.send({ ...payload, allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn({ err: error, guildId: binding.guildId }, "Could not post a capture notice");
  }
}

const resumeButtons = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(CAPTURE_RESUME).setLabel("Resume Auto").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(CAPTURE_STAY_MANUAL).setLabel("Stay Manual").setStyle(ButtonStyle.Secondary),
);

// If the capture goes quiet, nobody may stay muted and Auto switches off. When it comes back dea asks
// before resuming, because the game may have moved on while it was away.
function checkSilence(client: Client) {
  for (const [guildId, state] of states) {
    const latest = captureRegistry.latest(guildId);
    const quiet = !latest || Date.now() - latest.lastSeenAt > silenceMs();
    if (quiet) {
      if (latest?.mode === "Auto") {
        logger.warn({ guildId }, "Among Us capture went quiet; switching to Manual and releasing automatic mutes");
        void state.executor.release();
        state.lostAuto = true;
        state.asked = false;
        captureRegistry.setMode(guildId, "Manual");
        void notify(client, latest.binding, {
          content: `I lost contact with the capture app for ${Math.round(silenceMs() / 1000)} seconds, so I lifted my mutes and switched to Manual. I'll ask before going back to Auto.`,
        });
      } else if (!state.executor.isEmpty) {
        logger.warn({ guildId }, "Among Us capture went quiet; releasing automatic mutes");
        void state.executor.release();
      }
      continue;
    }
    if (!state.lostAuto) continue;
    if (latest.mode === "Auto") {
      state.lostAuto = false;
    } else if (!state.asked) {
      state.asked = true;
      void notify(client, latest.binding, {
        content: "The capture app is back. Resume automatic muting? Check the game state first, since it may have moved on.",
        components: [resumeButtons()],
      });
    }
  }
}

// Handles the Resume Auto / Stay Manual buttons.
export async function handleCaptureResume(interaction: ButtonInteraction) {
  const guild = interaction.guild;
  if (!guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "You need Manage Server to do that.", flags: MessageFlags.Ephemeral });
    return;
  }
  const state = states.get(guild.id);
  if (state) state.lostAuto = false;
  if (interaction.customId === CAPTURE_RESUME) {
    const resumed = captureRegistry.setMode(guild.id, "Auto");
    await interaction.update({
      content: resumed ? "Automatic muting resumed." : "There is no active capture pairing.",
      components: [],
    });
    return;
  }
  await interaction.update({ content: "Staying in Manual. Use /capture mode Auto when you want it back.", components: [] });
}

// Wires capture events, link changes and a safety sweep to the mute logic.
export function registerCaptureMutes(client: Client, markVoiceChange: (guildId: string, userId: string) => void, dead?: DeadList) {
  markBotVoiceChange = markVoiceChange;
  deadList = dead;
  captureRegistry.listen((event) => {
    if (event.kind === "ended") {
      releaseGuild(event.binding.guildId);
      return;
    }
    const guild = client.guilds.cache.get(event.binding.guildId);
    if (guild) evaluateMutes(guild);
  });
  onLinksReconciled((guild) => evaluateMutes(guild));
  setInterval(() => checkSilence(client), 5_000).unref();
}
