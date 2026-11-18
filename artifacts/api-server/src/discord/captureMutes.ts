import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import { MuteExecutor, type MuteEvent, type VoiceOps } from "../among-us/muteExecutor";
import { MuteTracker } from "../among-us/muteLogic";
import { captureRegistry, type CaptureBinding } from "../among-us/registry";
import { logger } from "../lib/logger";
import { linkedUserFor, onLinksReconciled } from "./captureLinks";

type MuteState = { binding: CaptureBinding; executor: MuteExecutor; tracker: MuteTracker };
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
  };
  states.set(guild.id, next);
  return next;
}

// Works out who should be muted from the capture's latest game state and moves Discord toward it.
// Nothing happens unless the session is in Auto mode. Leaving Auto releases every mute dea applied.
export function evaluateMutes(guild: Guild, force = false) {
  const latest = captureRegistry.latest(guild.id);
  if (!latest) return;
  const state = stateFor(guild, latest.binding);
  if (latest.mode !== "Auto") {
    if (!state.executor.isEmpty) void state.executor.release();
    return;
  }
  const target = state.tracker.desired(latest.game ?? null, (player) => linkedUserFor(guild.id, latest.binding, player));
  void state.executor.apply(target, force);
}

function releaseGuild(guildId: string) {
  const state = states.get(guildId);
  if (!state) return;
  void state.executor.release().finally(() => {
    if (states.get(guildId) === state && !captureRegistry.latest(guildId)) states.delete(guildId);
  });
}

// Wires capture events, link changes and a safety sweep to the mute logic.
export function registerCaptureMutes(client: Client, markVoiceChange: (guildId: string, userId: string) => void) {
  markBotVoiceChange = markVoiceChange;
  captureRegistry.listen((event) => {
    if (event.kind === "ended") {
      releaseGuild(event.binding.guildId);
      return;
    }
    const guild = client.guilds.cache.get(event.binding.guildId);
    if (guild) evaluateMutes(guild);
  });
  onLinksReconciled((guild) => evaluateMutes(guild));

  // If the capture dies, nobody may stay muted. Mutes are released and re-applied if it comes back.
  setInterval(() => {
    for (const [guildId, state] of states) {
      if (state.executor.isEmpty) continue;
      const latest = captureRegistry.latest(guildId);
      if (latest && Date.now() - latest.lastSeenAt <= silenceMs()) continue;
      logger.warn({ guildId }, "Among Us capture went quiet; releasing automatic mutes");
      void state.executor.release();
    }
  }, 5_000).unref();
}
