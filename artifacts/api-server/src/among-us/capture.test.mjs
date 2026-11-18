import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import express from "express";
import { build } from "esbuild";

// Bundle the same TypeScript modules used by the API without starting Prisma or Discord.
const { outputFiles } = await build({
  stdin: {
    contents: `
      export { createCaptureRouter } from "../routes/capture";
      export { CaptureRegistry } from "./registry";
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
const { CaptureRegistry, createCaptureRouter, handleCaptureCommand } = module.exports;

const stream = "a".repeat(32);
const player = (id, name, colour, dead = false) => ({ id, name, colour, dead, disconnected: false });
const orbit = player(2, "Orbit", 6);
const pixel = player(1, "Pixel", 8);
const deadOrbit = { ...orbit, dead: true };
const deadPixel = { ...pixel, dead: true };
const game = (sequence, phase, players = [orbit, pixel], lobbyCode = "ABCDEF") => ({
  protocolVersion: 1, streamId: stream, sequence,
  game: { phase, lobbyCode, regionId: 2, mapId: 4, players },
  changes: [],
});

test("pairing codes expire and reissuing one invalidates the older code", (context) => {
  context.mock.method(Date, "now", () => 0);
  const registry = new CaptureRegistry();
  const binding = { guildId: "1", textChannelId: "2", voiceChannelId: "3" };
  const sink = async () => {};
  const old = registry.issue(binding, sink);
  const current = registry.issue(binding, sink);
  assert.equal(registry.exchange(old), undefined);
  Date.now.mock.mockImplementation(() => 5 * 60_000);
  assert.equal(registry.exchange(current), undefined);
});

test("Discord command pairs to its channels and authenticated snapshots edit one spoiler-safe message", async (context) => {
  const priorOrigin = process.env.CAPTURE_PUBLIC_URL;
  process.env.CAPTURE_PUBLIC_URL = "https://dea.example.org";
  context.after(() => {
    if (priorOrigin === undefined) delete process.env.CAPTURE_PUBLIC_URL;
    else process.env.CAPTURE_PUBLIC_URL = priorOrigin;
  });
  const app = express();
  app.use("/capture", createCaptureRouter());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}/capture`;
  const messages = [];
  const updates = [];
  let lastReply;
  let voice = "3";
  const command = (subcommand) => handleCaptureCommand({
    user: { id: "operator" },
    memberPermissions: { has: () => true },
    guild: { id: "1", voiceStates: { cache: { get: () => ({ channelId: voice }) } }, members: { me: {} } },
    channel: {
      id: "2", isSendable: () => true, isDMBased: () => false, isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      send: async (options) => {
        messages.push(options);
        updates.push(options);
        return { edit: async (edit) => updates.push(edit) };
      },
    },
    options: { getSubcommand: () => subcommand },
    deferReply: async ({ flags }) => assert.equal(flags, 64),
    editReply: async (reply) => { lastReply = reply; },
  });

  const post = (endpoint, body, token, extra = {}) => fetch(`${origin}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = updates.at(-1)?.embeds[0].toJSON();
      if (current && predicate(current)) return current;
      await delay(25);
    }
    assert.fail("Timed out waiting for the Discord status update.");
  };
  const field = (embed, name) => embed.fields.find((item) => item.name === name)?.value;
  const phase = (name) => (embed) => field(embed, "Phase") === name;
  const pair = async () => {
    await command("pair");
    assert.match(lastReply, /https:\/\/dea\.example\.org/);
    const code = /\*\*([A-Z2-9]{10})\*\*/.exec(lastReply)[1];
    const response = await post("pair", { code });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await post("pair", { code })).status, 401);
    return (await response.json()).token;
  };

  const token = await pair();
  const send = async (snapshot, extra) => assert.equal((await post("events", snapshot, token, extra)).status, 204);
  assert.equal((await post("heartbeat", undefined, token)).status, 204);
  assert.equal((await post("events", game(1, "lobby"))).status, 401);
  assert.equal((await post("events", game(1, "lobby", [orbit, orbit]), token)).status, 400);
  await send(game(1, "lobby"));
  const lobby = await waitFor(phase("Lobby"));
  assert.match(lobby.description, /\*\*Black\*\* · Orbit[\s\S]*\*\*Purple\*\* · Pixel/);
  assert.equal(field(lobby, "Mode"), "Manual");
  assert.equal(field(lobby, "Voice channel"), "<#3>");
  assert.equal(field(lobby, "Lobby code"), "ABCDEF");
  assert.equal(field(lobby, "Region"), "Europe");
  assert.equal(field(lobby, "Map"), "The Airship");
  assert.deepEqual(messages[0].allowedMentions, { parse: [] });

  await send(game(2, "tasks", [deadOrbit, pixel]));
  const tasks = await waitFor(phase("Tasks"));
  assert.doesNotMatch(tasks.description, /Dead|impostor/i);
  await send(game(3, "meeting", [deadOrbit, pixel]));
  const meeting = await waitFor(phase("Meeting"));
  assert.match(meeting.description, /Orbit · Dead/);
  await send(game(4, "meeting", [deadOrbit, deadPixel]));
  await send(game(5, "tasks", [deadOrbit, deadPixel]));
  const resumed = await waitFor(phase("Tasks"));
  assert.match(resumed.description, /Pixel · Alive/);
  assert.match(resumed.description, /Orbit · Dead/);
  assert.ok(updates.filter(({ embeds }) => field(embeds[0].toJSON(), "Phase") === "Meeting")
    .every(({ embeds }) => !embeds[0].toJSON().description.includes("Pixel · Dead")));
  // Even a contiguous snapshot received after a reconnect could be mid-meeting.
  await send(game(6, "meeting", [deadOrbit, deadPixel]), { "x-capture-resync": "1" });
  assert.doesNotMatch((await waitFor(phase("Meeting"))).description, /Dead/);
  // Delayed packets and duplicate delivery cannot roll the status back.
  await send(game(5, "tasks"));
  await send(game(6, "tasks"));
  await delay(850);
  assert.ok(phase("Meeting")(updates.at(-1).embeds[0].toJSON()));

  voice = "4";
  const replacement = await pair();
  assert.equal((await post("heartbeat", undefined, token)).status, 401);
  assert.equal((await post("events", game(1, "lobby"), replacement)).status, 204);
  const rebound = await waitFor(phase("Lobby"));
  assert.equal(field(rebound, "Voice channel"), "<#4>");
  assert.equal(messages.length, 1);
  await command("revoke");
  assert.equal((await post("heartbeat", undefined, replacement)).status, 401);
  await waitFor(phase("Waiting for capture"));
});
