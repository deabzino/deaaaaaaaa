import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

process.env.LOG_LEVEL ??= "silent";

// Bundle the same TypeScript modules used by the bot without starting Prisma or a Discord client.
const { outputFiles } = await build({
  stdin: {
    contents: `
      export { MuteTracker } from "./muteLogic";
      export { MuteExecutor } from "./muteExecutor";
      export { CaptureRegistry, captureRegistry } from "./registry";
      export { renderCaptureLinks } from "../discord/captureLinks";
      export {
        evaluateMutes, registerCaptureMutes, muteDryRun, pauseAutoForManual, handleCaptureResume, CAPTURE_RESUME, CAPTURE_STAY_MANUAL,
      } from "../discord/captureMutes";
      export { handleCaptureCommand } from "../discord/captureStatus";
    `,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "cjs",
  write: false,
});
const module = { exports: {} };
new Function("module", "exports", "require", outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const {
  MuteTracker, MuteExecutor, CaptureRegistry, captureRegistry, renderCaptureLinks,
  evaluateMutes, registerCaptureMutes, muteDryRun, handleCaptureCommand,
  pauseAutoForManual, handleCaptureResume, CAPTURE_RESUME, CAPTURE_STAY_MANUAL,
} = module.exports;

const until = async (predicate, message, timeout = 3_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
};

// ---------------------------------------------------------------- mute planner

const gamePlayer = (id, name, colour, dead = false, disconnected = false) => ({ id, name, colour, dead, disconnected });
const linkAll = (player) => `user-${player.id}`;
const snapshotGame = (phase, players) => ({ phase, lobbyCode: "ABCDEF", regionId: 2, mapId: 0, players });

test("the planner mutes by phase and keeps unreported deaths out of the mute pattern", () => {
  const tracker = new MuteTracker();
  const alive = [gamePlayer(1, "A", 0), gamePlayer(2, "B", 1)];
  const oneDead = [gamePlayer(1, "A", 0), gamePlayer(2, "B", 1, true)];
  const muted = (game) => Object.fromEntries(tracker.desired(game, linkAll));

  for (const phase of ["menu", "lobby", "ended"]) {
    assert.deepEqual(muted(snapshotGame(phase, oneDead)), { "user-1": false, "user-2": false }, phase);
  }
  assert.deepEqual(muted(null), {});

  // During tasks everyone is muted, so a mute never reveals who died.
  assert.deepEqual(muted(snapshotGame("tasks", alive)), muted(snapshotGame("tasks", oneDead)));
  assert.deepEqual(muted(snapshotGame("tasks", oneDead)), { "user-1": true, "user-2": true });

  assert.deepEqual(muted(snapshotGame("meeting", oneDead)), { "user-1": false, "user-2": true });
  // Exiled mid-meeting: stays unmuted until the next tasks phase.
  const exiled = [gamePlayer(1, "A", 0, true), gamePlayer(2, "B", 1, true)];
  assert.deepEqual(muted(snapshotGame("meeting", exiled)), { "user-1": false, "user-2": true });
  assert.deepEqual(muted(snapshotGame("tasks", exiled)), { "user-1": true, "user-2": true });
  // A new meeting starts a fresh snapshot of who is dead.
  assert.deepEqual(muted(snapshotGame("meeting", exiled)), { "user-1": true, "user-2": true });
});

test("the planner skips unlinked and disconnected players, and merges a member linked twice", () => {
  const tracker = new MuteTracker();
  const players = [gamePlayer(1, "A", 0), gamePlayer(2, "B", 1), gamePlayer(3, "C", 2, false, true), gamePlayer(4, "D", 3)];
  const link = (player) => (player.id === 2 ? undefined : player.id === 4 ? "user-1" : `user-${player.id}`);
  assert.deepEqual(Object.fromEntries(tracker.desired(snapshotGame("tasks", players), link)),
    { "user-1": true, "user-3": false });
});

// ------------------------------------------------------------------- executor

function fakeOps(initial = {}) {
  const users = new Map(Object.entries(initial));
  const calls = [];
  const failing = new Map();
  let inflight = 0;
  const ops = {
    users, calls, failing, maxInflight: 0,
    view: (id) => users.get(id) ?? { inVoice: false, inPairedChannel: false, serverMute: false },
    async setMute(id, mute) {
      inflight++;
      ops.maxInflight = Math.max(ops.maxInflight, inflight);
      await delay(5);
      inflight--;
      const remaining = failing.get(id) ?? 0;
      if (remaining > 0) {
        failing.set(id, remaining - 1);
        throw new Error("rate limited");
      }
      calls.push([id, mute]);
      users.get(id).serverMute = mute;
    },
  };
  return ops;
}
const member = (overrides = {}) => ({ inVoice: true, inPairedChannel: true, serverMute: false, ...overrides });
const target = (entries) => new Map(Object.entries(entries));

test("the executor mutes and unmutes only the members it was given, only in the paired channel", async () => {
  const ops = fakeOps({ a: member(), b: member(), outside: member({ inPairedChannel: false }) });
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ a: true, b: false, outside: true }));
  assert.deepEqual(ops.calls, [["a", true]]);
  assert.deepEqual(executor.ownedIds(), ["a"]);
  await executor.apply(target({ a: false, b: false, outside: false }));
  assert.deepEqual(ops.calls, [["a", true], ["a", false]]);
  assert.equal(executor.isEmpty, false);
  assert.deepEqual(executor.ownedIds(), []);
});

test("the executor never lifts or claims a mute it did not apply", async () => {
  const ops = fakeOps({ moderated: member({ serverMute: true }), normal: member() });
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ moderated: true, normal: true }));
  assert.deepEqual(ops.calls, [["normal", true]]);
  await executor.apply(target({ moderated: false, normal: false }));
  assert.deepEqual(ops.calls, [["normal", true], ["normal", false]]);
  assert.equal(ops.users.get("moderated").serverMute, true);
  await executor.release();
  assert.equal(ops.users.get("moderated").serverMute, true);
});

test("a member who leaves the paired channel is released and one who rejoins is muted again", async () => {
  const ops = fakeOps({ a: member() });
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ a: true }));
  ops.users.get("a").inPairedChannel = false;
  await executor.apply(target({ a: true }), true);
  assert.equal(ops.users.get("a").serverMute, false);
  ops.users.get("a").inPairedChannel = true;
  await executor.apply(target({ a: true }), true);
  assert.equal(ops.users.get("a").serverMute, true);
});

test("disconnecting from voice drops ownership because Discord clears the mute", async () => {
  const ops = fakeOps({ a: member() });
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ a: true }));
  ops.users.set("a", { inVoice: false, inPairedChannel: false, serverMute: false });
  await executor.apply(target({ a: true }), true);
  assert.deepEqual(executor.ownedIds(), []);
  assert.equal(ops.calls.length, 1);
  ops.users.set("a", member());
  await executor.apply(target({ a: true }), true);
  assert.deepEqual(ops.calls.at(-1), ["a", true]);
});

test("release lifts only its own mutes, and the same target applies again afterwards", async () => {
  const ops = fakeOps({ a: member(), b: member() });
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ a: true, b: true }));
  await executor.release();
  assert.ok(ops.users.get("a").serverMute === false && ops.users.get("b").serverMute === false);
  assert.equal(executor.isEmpty, true);
  await executor.apply(target({ a: true, b: true }));
  assert.ok(ops.users.get("a").serverMute && ops.users.get("b").serverMute);
});

test("repeated identical targets cause no extra work", async () => {
  const ops = fakeOps({ a: member(), b: member() });
  let reads = 0;
  const view = ops.view;
  ops.view = (id) => { reads++; return view(id); };
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ b: true, a: true }));
  const readsAfterFirst = reads;
  // The capture reports about four times a second, so unchanged targets must not re-read Discord.
  for (let index = 0; index < 20; index++) await executor.apply(target({ b: true, a: true }));
  assert.equal(ops.calls.length, 2);
  assert.equal(reads, readsAfterFirst);
  // A forced check does re-read, for voice joins and leaves.
  await executor.apply(target({ b: true, a: true }), true);
  assert.ok(reads > readsAfterFirst);
});

test("changes run in small batches", async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `u${index}`);
  const ops = fakeOps(Object.fromEntries(ids.map((id) => [id, member()])));
  const executor = new MuteExecutor({ ops, dryRun: false, concurrency: 3 });
  await executor.apply(new Map(ids.map((id) => [id, true])));
  assert.equal(ops.calls.length, 10);
  assert.ok(ops.maxInflight <= 3, `max in flight was ${ops.maxInflight}`);
});

test("a newer target wins over one still being applied", async () => {
  const ops = fakeOps({ a: member() });
  const executor = new MuteExecutor({ ops, dryRun: false });
  const first = executor.apply(target({ a: true }));
  const second = executor.apply(target({ a: false }));
  await Promise.all([first, second]);
  assert.equal(ops.users.get("a").serverMute, false);
  assert.deepEqual(executor.ownedIds(), []);
});

test("failures retry with backoff and then stop until the target changes", async () => {
  const events = [];
  const ops = fakeOps({ a: member(), b: member() });
  ops.failing.set("a", 2);
  const executor = new MuteExecutor({ ops, dryRun: false, retryDelaysMs: [5, 5, 5], log: (event) => events.push(event) });
  await executor.apply(target({ a: true, b: true }));
  await until(() => ops.users.get("a").serverMute, "a was never muted after retries");
  assert.deepEqual(events.filter((event) => event.kind === "failed").map((event) => event.attempt), [1, 2]);

  ops.failing.set("c", 99);
  ops.users.set("c", member());
  await executor.apply(target({ a: true, b: true, c: true }));
  await until(() => events.some((event) => event.kind === "failed" && event.userId === "c" && !event.willRetry),
    "c never reached its last attempt");
  const attempts = events.filter((event) => event.userId === "c" && event.kind === "failed").length;
  assert.equal(attempts, 4);
  await delay(60);
  assert.equal(events.filter((event) => event.userId === "c" && event.kind === "failed").length, attempts);
  assert.equal(ops.users.get("c").serverMute, false);
});

test("dry run changes nothing in Discord, logs once per change and still respects foreign mutes", async () => {
  const events = [];
  const ops = fakeOps({ a: member(), moderated: member({ serverMute: true }) });
  const executor = new MuteExecutor({ ops, dryRun: true, log: (event) => events.push(`${event.kind}:${event.userId}`) });
  await executor.apply(target({ a: true, moderated: true }));
  await executor.apply(target({ a: true, moderated: true }), true);
  assert.deepEqual(events, ["mute:a"]);
  await executor.apply(target({ a: false, moderated: false }));
  assert.deepEqual(events, ["mute:a", "unmute:a"]);
  assert.equal(ops.calls.length, 0);
  assert.equal(ops.users.get("a").serverMute, false);
});

// --------------------------------------------------------------- registry hooks

test("the registry reports snapshots, mode changes and endings, and exposes the raw game privately", () => {
  const registry = new CaptureRegistry();
  const binding = { guildId: "1", textChannelId: "2", voiceChannelId: "3" };
  const events = [];
  registry.listen((event) => events.push(event.kind));
  const token = registry.exchange(registry.issue(binding, async () => {}));
  const stream = "a".repeat(32);
  const body = (sequence, phase) => ({ protocolVersion: 1, streamId: stream, sequence, changes: [],
    game: { phase, lobbyCode: "ABCDEF", regionId: 2, mapId: 0, players: [gamePlayer(1, "Orbit", 6, true)] } });
  const auth = `Bearer ${token}`;

  assert.equal(registry.latest("1").mode, "Manual");
  assert.equal(registry.receive(auth, body(1, "tasks"), false), 204);
  assert.equal(registry.receive(auth, body(1, "tasks"), false), 204);
  assert.deepEqual(events, ["snapshot"]);
  assert.equal(registry.latest("1").game.players[0].dead, true);
  assert.doesNotMatch(JSON.stringify(registry.view("1").status), /dead/i);

  assert.equal(registry.setMode("1", "Auto"), true);
  assert.equal(registry.view("1").status.mode, "Auto");
  assert.equal(registry.setMode("1", "Auto"), true);
  assert.equal(registry.setMode("nope", "Auto"), false);
  assert.deepEqual(events, ["snapshot", "mode"]);
  registry.revoke("1");
  assert.deepEqual(events, ["snapshot", "mode", "ended"]);
  assert.equal(registry.latest("1"), undefined);
});

// ------------------------------------------- end to end with a fake Discord server

const stream = "b".repeat(32);

function fakeServer(guildId, memberSpecs) {
  const voiceStates = new Map();
  const log = { mutes: [], botChanges: [] };
  for (const spec of memberSpecs) {
    const state = {
      channelId: spec.channel ?? "voice", serverMute: spec.serverMute ?? false,
      member: {
        id: spec.id, displayName: spec.name, nickname: null, user: { username: spec.username ?? `user_${spec.id}`, bot: false },
        voice: { setMute: async (mute, reason) => {
          assert.match(reason, /Among Us automatic mute/);
          log.mutes.push([spec.id, mute]);
          state.serverMute = mute;
        } },
      },
    };
    voiceStates.set(spec.id, state);
  }
  const guild = {
    id: guildId,
    voiceStates: { cache: { get: (id) => voiceStates.get(id), values: () => voiceStates.values() } },
    members: { me: { permissions: { has: () => true } }, fetch: async (id) => voiceStates.get(id).member },
  };
  const sent = [];
  const client = {
    guilds: { cache: { get: (id) => (id === guildId ? guild : undefined) } },
    channels: { cache: { get: (id) => (id === "text" ? { isSendable: () => true, send: async (payload) => { sent.push(payload); } } : undefined) } },
  };
  const dead = {
    marks: [], clears: [],
    mark: async (target, memberId) => { dead.marks.push([target.id, memberId]); },
    clear: async (target, memberId) => { dead.clears.push([target.id, memberId]); },
  };
  const muted = () => [...voiceStates].filter(([, state]) => state.serverMute).map(([id]) => id).sort();
  return { guild, client, voiceStates, log, muted, sent, dead };
}

async function pairServer(server, context) {
  const binding = { guildId: server.guild.id, textChannelId: "text", voiceChannelId: "voice" };
  const embeds = [];
  registerCaptureMutes(server.client, (guildId, userId) => server.log.botChanges.push([guildId, userId]), server.dead);
  const code = captureRegistry.issue(binding, async (status, bound) => {
    const { roster } = await renderCaptureLinks(server.guild, bound, status);
    embeds.push({ phase: status.phase, mode: status.mode, roster });
  });
  const token = captureRegistry.exchange(code);
  context.after(() => captureRegistry.revoke(server.guild.id));
  let sequence = 0;
  return {
    embeds,
    send: (phase, players) => {
      const body = { protocolVersion: 1, streamId: stream, sequence: ++sequence, changes: [], game: snapshotGame(phase, players) };
      assert.equal(captureRegistry.receive(`Bearer ${token}`, body, false), 204);
    },
  };
}

const orbit = (overrides = {}) => ({ ...gamePlayer(2, "Orbit", 6), ...overrides });
const roster = (changes = {}) => [
  orbit(changes.orbit), { ...gamePlayer(1, "Pixel", 8), ...changes.pixel },
  gamePlayer(3, "Sam", 2), gamePlayer(4, "Rex", 11),
];
const crew = () => [
  { id: "u-orbit", name: "Orbit" }, { id: "u-pixel", name: "Pixel" },
  // Two members share the name Sam, so dea must not guess which one is the player.
  { id: "u-sam-1", name: "Sam" }, { id: "u-sam-2", name: "Sam" },
  // Rex is in another voice channel, so he cannot be linked or muted.
  { id: "u-rex", name: "Rex", channel: "elsewhere" },
];

test("auto mode follows a whole match: linking, hidden deaths, colour change, leaver, mode off, quiet capture", async (context) => {
  process.env.CAPTURE_MUTE_DRY_RUN = "false";
  context.after(() => { delete process.env.CAPTURE_MUTE_DRY_RUN; });
  assert.equal(muteDryRun(), false);
  const server = fakeServer("guild-match", crew());
  const capture = await pairServer(server, context);

  // Manual is the default: the capture can drive the status but never the mutes.
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  await delay(100);
  capture.send("tasks", roster({ pixel: { dead: true } }));
  await delay(100);
  assert.deepEqual(server.log.mutes, []);
  assert.equal(capture.embeds.at(-1).mode, "Manual");

  // Switching to Auto starts enforcing the current phase.
  assert.equal(captureRegistry.setMode("guild-match", "Auto"), true);
  await until(() => server.muted().length === 2, "linked players were not muted in tasks");
  // Orbit and Pixel are linked by name. Ambiguous Sam and out-of-channel Rex are left alone.
  assert.deepEqual(server.muted(), ["u-orbit", "u-pixel"]);
  assert.ok(capture.embeds.every((embed) => !/Dead/.test(embed.roster.join("\n"))));
  assert.ok(server.log.botChanges.length >= 2 && server.log.botChanges.every(([guildId]) => guildId === "guild-match"));

  // Meeting: the living talk and the dead stay muted. Pixel was killed earlier.
  capture.send("meeting", roster({ pixel: { dead: true } }));
  await until(() => server.muted().join() === "u-pixel", "meeting rules were not applied");
  // Orbit is exiled during the meeting but is not muted until tasks resume.
  capture.send("meeting", roster({ pixel: { dead: true }, orbit: { dead: true } }));
  await delay(100);
  assert.deepEqual(server.muted(), ["u-pixel"]);
  capture.send("tasks", roster({ pixel: { dead: true }, orbit: { dead: true, colour: 10 } }));
  await until(() => server.muted().length === 2, "everyone was not muted again after the meeting");

  // A colour change keeps the link, so no mute flaps.
  const callsAfterColour = server.log.mutes.length;
  await delay(900);
  assert.equal(server.log.mutes.length, callsAfterColour);

  // Orbit leaves the paired channel: their mute is lifted. Coming back mutes them again mid-round.
  server.voiceStates.get("u-orbit").channelId = "elsewhere";
  evaluateMutes(server.guild, true);
  await until(() => server.muted().join() === "u-pixel", "a leaver stayed muted");
  server.voiceStates.get("u-orbit").channelId = "voice";
  evaluateMutes(server.guild, true);
  await until(() => server.muted().length === 2, "a rejoiner was not muted");

  // The game ending lifts every mute dea applied.
  capture.send("ended", roster({ pixel: { dead: true } }));
  await until(() => server.muted().length === 0, "mutes survived the end of the game");
  capture.send("tasks", roster());
  await until(() => server.muted().length === 2, "the next round was not muted");

  // Turning Auto off releases everything and later snapshots change nothing.
  captureRegistry.setMode("guild-match", "Manual");
  await until(() => server.muted().length === 0, "Manual mode left mutes behind");
  const callsBeforeManual = server.log.mutes.length;
  capture.send("meeting", roster({ pixel: { dead: true } }));
  await delay(150);
  assert.equal(server.log.mutes.length, callsBeforeManual);
});

test("dry run is the default and only ever logs", async (context) => {
  delete process.env.CAPTURE_MUTE_DRY_RUN;
  assert.equal(muteDryRun(), true);
  const server = fakeServer("guild-dry", [{ id: "u-orbit", name: "Orbit" }, { id: "u-pixel", name: "Pixel" }]);
  const capture = await pairServer(server, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-dry", "Auto");
  capture.send("tasks", roster());
  await delay(300);
  assert.deepEqual(server.log.mutes, []);
  assert.deepEqual(server.muted(), []);
});

test("a quiet capture falls back to Manual, and a returning capture asks before Auto resumes", async (context) => {
  process.env.CAPTURE_MUTE_DRY_RUN = "false";
  context.after(() => { delete process.env.CAPTURE_MUTE_DRY_RUN; });
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const server = fakeServer("guild-quiet", [{ id: "u-orbit", name: "Orbit" }, { id: "u-pixel", name: "Pixel" }]);
  const capture = await pairServer(server, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-quiet", "Auto");
  capture.send("tasks", roster());
  await until(() => server.muted().length === 2, "players were not muted");

  context.mock.timers.tick(36_000);
  await until(() => server.muted().length === 0, "a silent capture left people muted");
  assert.equal(captureRegistry.latest("guild-quiet").mode, "Manual");
  assert.equal(server.sent.length, 1);
  assert.match(server.sent[0].content, /lost contact/);
  assert.equal(server.sent[0].components, undefined);

  // The capture returns: nothing is muted again by itself, and dea asks first.
  capture.send("tasks", roster());
  context.mock.timers.tick(5_000);
  await delay(50);
  assert.deepEqual(server.muted(), []);
  assert.equal(server.sent.length, 2);
  assert.match(server.sent[1].content, /Resume automatic muting/);
  const buttons = server.sent[1].components[0].toJSON().components.map((button) => button.custom_id);
  assert.deepEqual(buttons, [CAPTURE_RESUME, CAPTURE_STAY_MANUAL]);
  context.mock.timers.tick(5_000);
  await delay(20);
  assert.equal(server.sent.length, 2, "it must only ask once");

  // Someone without Manage Server cannot answer.
  const press = (customId, allowed) => {
    const result = {};
    const interaction = {
      customId, guild: { id: "guild-quiet" }, memberPermissions: { has: () => allowed },
      reply: async (options) => { result.reply = options; },
      update: async (options) => { result.update = options; },
    };
    return handleCaptureResume(interaction).then(() => result);
  };
  assert.match((await press(CAPTURE_RESUME, false)).reply.content, /Manage Server/);
  assert.equal(captureRegistry.latest("guild-quiet").mode, "Manual");

  const answer = await press(CAPTURE_RESUME, true);
  assert.match(answer.update.content, /resumed/);
  assert.equal(captureRegistry.latest("guild-quiet").mode, "Auto");
  await until(() => server.muted().length === 2, "mutes were not applied after resuming");
});

test("staying in Manual after a lost capture keeps Auto off", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 2_000_000 });
  const server = fakeServer("guild-stay", [{ id: "u-orbit", name: "Orbit" }]);
  const capture = await pairServer(server, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-stay", "Auto");
  context.mock.timers.tick(36_000);
  assert.equal(captureRegistry.latest("guild-stay").mode, "Manual");
  capture.send("tasks", roster());
  context.mock.timers.tick(5_000);
  await delay(20);
  assert.equal(server.sent.length, 2);
  const result = {};
  await handleCaptureResume({
    customId: CAPTURE_STAY_MANUAL, guild: { id: "guild-stay" }, memberPermissions: { has: () => true },
    update: async (options) => { result.update = options; },
  });
  assert.match(result.update.content, /Staying in Manual/);
  assert.equal(captureRegistry.latest("guild-stay").mode, "Manual");
});

test("a manual mute pauses Auto without undoing what the command set", async (context) => {
  process.env.CAPTURE_MUTE_DRY_RUN = "false";
  context.after(() => { delete process.env.CAPTURE_MUTE_DRY_RUN; });
  const server = fakeServer("guild-pause", [{ id: "u-orbit", name: "Orbit" }, { id: "u-pixel", name: "Pixel" }]);
  const capture = await pairServer(server, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-pause", "Auto");
  capture.send("tasks", roster());
  await until(() => server.muted().length === 2, "players were not muted");

  assert.equal(pauseAutoForManual("guild-pause", "another-channel"), false);
  assert.equal(captureRegistry.latest("guild-pause").mode, "Auto");
  assert.equal(pauseAutoForManual("guild-pause", "voice"), true);
  assert.equal(captureRegistry.latest("guild-pause").mode, "Paused");
  assert.equal(pauseAutoForManual("guild-pause", "voice"), false, "only Auto can be paused");

  // The game moves on, but the mutes the person set stay exactly as they are.
  capture.send("ended", roster());
  await delay(100);
  assert.deepEqual(server.muted(), ["u-orbit", "u-pixel"]);
  assert.equal(server.log.mutes.filter(([, mute]) => !mute).length, 0);
});

test("/capture mode pause lifts dea's mutes and stops further changes until Auto is back", async (context) => {
  process.env.CAPTURE_MUTE_DRY_RUN = "false";
  context.after(() => { delete process.env.CAPTURE_MUTE_DRY_RUN; });
  const server = fakeServer("guild-pausecmd", [{ id: "u-orbit", name: "Orbit" }]);
  const capture = await pairServer(server, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-pausecmd", "Auto");
  capture.send("tasks", roster());
  await until(() => server.muted().length === 1, "the player was not muted");

  let reply;
  await handleCaptureCommand({
    user: { id: "operator" }, memberPermissions: { has: () => true },
    guild: { id: "guild-pausecmd", voiceStates: { cache: { get: () => undefined, values: () => [] } }, members: { me: {} } },
    channel: {}, options: { getSubcommand: () => "mode", getString: () => "Pause" },
    deferReply: async () => {}, editReply: async (text) => { reply = text; },
  });
  assert.match(reply, /paused/i);
  assert.equal(captureRegistry.latest("guild-pausecmd").mode, "Paused");
  await until(() => server.muted().length === 0, "pausing did not lift the mutes");
  capture.send("meeting", roster());
  capture.send("tasks", roster());
  await delay(100);
  assert.deepEqual(server.muted(), []);
  await until(() => capture.embeds.at(-1)?.mode === "Paused", "the status never showed Paused");
});

test("announced deaths go on the dead list, hidden ones never do, and the round end clears them", async (context) => {
  process.env.CAPTURE_MUTE_DRY_RUN = "false";
  context.after(() => { delete process.env.CAPTURE_MUTE_DRY_RUN; });
  const server = fakeServer("guild-dead", [{ id: "u-orbit", name: "Orbit" }, { id: "u-pixel", name: "Pixel" }]);
  const capture = await pairServer(server, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-dead", "Auto");
  capture.send("tasks", roster());
  capture.send("tasks", roster({ orbit: { dead: true } }));
  await delay(100);
  assert.deepEqual(server.dead.marks, [], "an unannounced death must not reach the dead list");

  capture.send("meeting", roster({ orbit: { dead: true } }));
  await until(() => server.dead.marks.length === 1, "the announced death was not listed");
  assert.deepEqual(server.dead.marks, [["guild-dead", "u-orbit"]]);
  capture.send("tasks", roster({ orbit: { dead: true } }));
  capture.send("meeting", roster({ orbit: { dead: true } }));
  await delay(100);
  assert.equal(server.dead.marks.length, 1, "a death is only listed once");
  assert.deepEqual(server.dead.clears, []);

  capture.send("ended", roster({ orbit: { dead: true } }));
  await until(() => server.dead.clears.length === 1, "the dead list was not cleared at the end of the round");
  assert.deepEqual(server.dead.clears, [["guild-dead", "u-orbit"]]);
});

test("dry run never touches the dead list, and leaving Auto takes only dea's entries off it", async (context) => {
  delete process.env.CAPTURE_MUTE_DRY_RUN;
  const dry = fakeServer("guild-dead-dry", [{ id: "u-orbit", name: "Orbit" }]);
  const dryCapture = await pairServer(dry, context);
  dryCapture.send("lobby", roster());
  await until(() => dryCapture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-dead-dry", "Auto");
  dryCapture.send("tasks", roster());
  dryCapture.send("meeting", roster({ orbit: { dead: true } }));
  await delay(100);
  assert.deepEqual(dry.dead.marks, []);
  assert.deepEqual(dry.dead.clears, []);

  process.env.CAPTURE_MUTE_DRY_RUN = "false";
  context.after(() => { delete process.env.CAPTURE_MUTE_DRY_RUN; });
  const live = fakeServer("guild-dead-off", [{ id: "u-orbit", name: "Orbit" }]);
  const capture = await pairServer(live, context);
  capture.send("lobby", roster());
  await until(() => capture.embeds.length > 0, "the status never rendered");
  captureRegistry.setMode("guild-dead-off", "Auto");
  capture.send("tasks", roster());
  capture.send("meeting", roster({ orbit: { dead: true } }));
  await until(() => live.dead.marks.length === 1, "the death was not listed");
  captureRegistry.setMode("guild-dead-off", "Manual");
  await until(() => live.dead.clears.length === 1, "leaving Auto did not take dea's entries off the dead list");
});

test("forget stops tracking without lifting anything", async () => {
  const ops = fakeOps({ a: member(), b: member() });
  const executor = new MuteExecutor({ ops, dryRun: false });
  await executor.apply(target({ a: true, b: true }));
  executor.forget();
  assert.deepEqual(executor.ownedIds(), []);
  assert.equal(executor.isEmpty, true);
  await executor.release();
  assert.deepEqual(ops.calls, [["a", true], ["b", true]]);
});

test("/capture mode switches automatic muting and tells the operator about dry run", async (context) => {
  delete process.env.CAPTURE_MUTE_DRY_RUN;
  const server = fakeServer("guild-command", [{ id: "u-orbit", name: "Orbit" }]);
  await pairServer(server, context);
  let reply;
  const run = (mode, guildId = "guild-command") => handleCaptureCommand({
    user: { id: "operator" }, memberPermissions: { has: () => true },
    guild: { id: guildId, voiceStates: { cache: { get: () => undefined, values: () => [] } }, members: { me: {} } },
    channel: {},
    options: { getSubcommand: () => "mode", getString: () => mode },
    deferReply: async () => {},
    editReply: async (text) => { reply = text; },
  });
  await run("Auto");
  assert.match(reply, /dry-run/);
  assert.equal(captureRegistry.latest("guild-command").mode, "Auto");
  await run("Manual");
  assert.match(reply, /Manual/);
  assert.equal(captureRegistry.latest("guild-command").mode, "Manual");
  await run("Auto", "unpaired-guild");
  assert.match(reply, /no active capture pairing/i);
});
