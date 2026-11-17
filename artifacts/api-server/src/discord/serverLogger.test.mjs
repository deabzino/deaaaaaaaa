import assert from "node:assert/strict";
import test from "node:test";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { channelPermissionChanges, truncate, commandLogDetails, escapeMarkdown, formatRoleList, formatUser, formatUserLabel, inlineCode, optionalActorField, sanitizeLogText, deletedByLabel } from "./logFormatting.ts";
import { describeVoiceChanges, summarizeVoiceChanges, VoiceLogBatcher } from "./voiceLogBatcher.ts";

const GUILD = "1014163878478884997";
const USER = "692768149665349672";

function fixture(channelId, options = {}) {
  return {
    channelId,
    channel: channelId ? { id: channelId, name: channelId === "a" ? "Voice 1" : "Voice 2" } : null,
    serverMute: false, serverDeaf: false, selfMute: false, selfDeaf: false,
    streaming: false, selfVideo: false, ...options,
  };
}

function formatFields(fields) {
  const ids = new Map();
  const output = fields.map(([name, value]) => [sanitizeLogText(name, GUILD, ids), sanitizeLogText(value, GUILD, ids)]);
  return { output, footer: [...ids.keys()].join(" • ") };
}

test("voice transitions have clear titles and no boolean text", () => {
  const cases = [
    [fixture(null), fixture("a"), "Joined voice channel"],
    [fixture("a"), fixture(null), "Left voice channel"],
    [fixture("a"), fixture("b"), "Switched voice channel"],
    [fixture("a"), fixture("a", { serverMute: true }), "Server muted"],
    [fixture("a"), fixture("a", { selfMute: true }), "Muted themselves"],
  ];
  for (const [oldState, newState, expected] of cases) {
    const changes = describeVoiceChanges(oldState, newState);
    assert.equal(changes[0]?.title, expected);
    assert.doesNotMatch(changes.map((change) => change.text).join(" "), /\b(?:true|false)\b/i);
  }
  assert.match(describeVoiceChanges(fixture(null), fixture("a"))[0].text, /Voice 1/);
  assert.match(describeVoiceChanges(fixture("a"), fixture(null))[0].text, /Left: .*Voice 1/);
  assert.match(describeVoiceChanges(fixture("a"), fixture("b"))[0].text, /From: Voice 1 → To: Voice 2/);
});

test("joins ignore stale voice flags, while same channel flag changes remain visible", () => {
  const changes = describeVoiceChanges(fixture(null, { serverMute: true, serverDeaf: true, selfMute: true, selfDeaf: true, streaming: true, selfVideo: true }), fixture("a"));
  assert.deepEqual(changes.map((change) => change.title), ["Joined voice channel"]);
  const sameChannel = describeVoiceChanges(fixture("a"), fixture("a", { serverMute: true, selfDeaf: true, streaming: true }));
  assert.deepEqual(sameChannel.map((change) => change.title), ["Server muted", "Deafened themselves", "Started streaming"]);
  assert.deepEqual(describeVoiceChanges(fixture("a", { selfMute: true }), fixture("b")), [{ title: "Switched voice channel", text: "From: Voice 1 → To: Voice 2", color: 0x5865f2 }]);
});

test("voice summary prioritizes main events and collapses reconnects and moves", () => {
  const self = { title: "Undeafened themselves", text: "Undeafened themselves", color: 2 };
  const left = { title: "Left voice channel", text: "Left: Voice 1", color: 3 };
  const joinedSame = { title: "Joined voice channel", text: "Joined Voice 1", color: 1 };
  assert.equal(summarizeVoiceChanges([self, left]).title, "Left voice channel");
  assert.deepEqual(summarizeVoiceChanges([left, joinedSame]), { title: "Reconnected to Voice 1", color: 0x57f287, changes: [] });
  assert.equal(summarizeVoiceChanges([left, { ...joinedSame, text: "Joined Voice 2" }]).title, "Moved from Voice 1 to Voice 2");
});

test("voice bursts for one member are combined in order and flush at shutdown", async () => {
  const emitted = [];
  const batcher = new VoiceLogBatcher((key, changes) => { emitted.push({ key, changes: changes.map((change) => change.text) }); }, 3_000, 4);
  batcher.add(`${GUILD}:${USER}`, { title: "Joined voice channel", text: "Joined Voice 1", color: 1 });
  batcher.add(`${GUILD}:123456789012345678`, { title: "Joined voice channel", text: "Joined Voice 2", color: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  batcher.add(`${GUILD}:${USER}`, { title: "Server muted", text: "Was server-muted by dea", color: 2 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  batcher.add(`${GUILD}:${USER}`, { title: "Muted themselves", text: "Muted themselves", color: 2 });
  assert.equal(emitted.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 3_100));
  assert.deepEqual(emitted, [
    { key: `${GUILD}:123456789012345678`, changes: ["Joined Voice 2"] },
    { key: `${GUILD}:${USER}`, changes: ["Joined Voice 1", "Was server-muted by dea", "Muted themselves"] },
  ]);

  batcher.add("shutdown-user", { title: "Left voice channel", text: "Left: Voice 1", color: 3 });
  batcher.flushAll();
  assert.equal(emitted.length, 3);
  assert.equal(batcher.size, 0);

  const capped = new VoiceLogBatcher((key, changes) => { emitted.push({ key, changes: changes.map((change) => change.text) }); }, 60_000, 1);
  capped.add("oldest", { title: "Joined voice channel", text: "Joined Voice 1", color: 1 });
  capped.add("newer", { title: "Left voice channel", text: "Left Voice 1", color: 2 });
  assert.equal(capped.size, 1);
  assert.deepEqual(emitted.at(-1), { key: "oldest", changes: ["Joined Voice 1"] });
  capped.flushAll();
});

test("message deletion wording handles audit matches, users and bots", () => {
  assert.equal(deletedByLabel(true, ""), "Unknown (likely deleted by the author)");
  assert.equal(deletedByLabel(true, "<@123456789012345678> (moderator)"), "<@123456789012345678> (moderator)");
  assert.equal(deletedByLabel(false, ""), "Unknown");
});

test("message content markdown and attachment filenames are escaped", () => {
  assert.equal(escapeMarkdown("hello_world *x*"), "hello\\_world \\*x\\*");
  const filename = "Desktop2026.11.08-_23.21.29.02.DVR.mp4";
  assert.equal(inlineCode(filename), "`Desktop2026.11.08-_23.21.29.02.DVR.mp4`");
});

test("log formatting omits empty brackets and actor placeholders", () => {
  assert.equal(formatUserLabel("Arian", "keruptedd"), "@Arian (keruptedd)");
  assert.equal(formatUserLabel("Arian", "Arian"), "@Arian");
  assert.equal(formatUserLabel("Arian", null), "@Arian");
  assert.deepEqual(optionalActorField(""), []);
  assert.deepEqual(optionalActorField(""), []); // self initiated actions omit Actor
  assert.deepEqual(optionalActorField("@Moderator"), [["Actor", "@Moderator"]]);
});

test("shared user mentions retain readable escaped usernames", () => {
  assert.equal(formatUser(USER, "raheema1x", "Raheema"), `<@${USER}> (raheema1x)`);
  assert.equal(formatUser(USER, "raheema1x", "raheema1x"), `<@${USER}>`);
  assert.equal(formatUser(USER, null, "Raheema"), `<@${USER}>`);
  assert.equal(formatUser(USER, "raheema_*x", "Raheema"), `<@${USER}> (raheema\\_\\*x)`);
});

test("command details include prefix and channel mention without empty options", () => {
  const details = commandLogDetails(USER, "nwordleaderboard", "", "1014164674679427164", true);
  assert.deepEqual(details, [
    ["Who", `<@${USER}>`],
    ["Command", "`.nwordleaderboard`"],
    ["Channel", "<#1014164674679427164>"],
  ]);
});

test("role lists are consistently sorted, markdown escaped, and capped", () => {
  const names = ["DJ", "Members", "'", "Role_3", "Role_4", "Role_5", "Role_6", "Role_7", "Role_8", "Role_9", "Role_10", "Role_11"];
  assert.equal(formatRoleList(names), "', DJ, Members, Role\\_10, Role\\_11, Role\\_3, Role\\_4, Role\\_5, Role\\_6, Role\\_7 ...and 2 more");
});

test("clean member, channel and other-event fields keep IDs in the footer only", () => {
  const { output, footer } = formatFields([
    ["Member", `@Sabbir (monkey.d.luffy)\u2063{User:${USER}}\u2063`],
    ["Channel", `🔊 Voice 1\u2063{Channel:1014164674679427164}\u2063`],
    ["Changed", "Enabled → Disabled"],
    ["Target", "#welcome 1014164674679427165"],
  ]);
  const values = output.flat().join(" ");
  assert.doesNotMatch(values, /\d{17,20}|Unavailable|undefined|null|Actor unavailable/i);
  assert.match(footer, /User ID 692768149665349672/);
  assert.match(footer, /Channel ID 1014164674679427164/);
  assert.match(footer, /ID 1014164674679427165/);
  assert.doesNotMatch(footer, new RegExp(GUILD));
});

test("marked IDs do not get duplicated in the footer and channel mentions survive sanitizing", () => {
  const ids = new Map();
  const value = sanitizeLogText(`@Arian (keruptedd)\u2063{User:${USER}}\u2063 <#1014164674679427164>`, GUILD, ids);
  assert.equal(value, "@Arian (keruptedd) <#1014164674679427164>");
  assert.deepEqual([...ids.keys()], [`User ID ${USER}`]);
});

test("overwrite diffs match targets by ID and report allow, deny, neutral and removal", () => {
  const { ViewChannel, SendMessages, ManageMessages } = PermissionFlagsBits;
  const overwrite = (id, allow = 0n, deny = 0n) => [id, {
    id, allow: new PermissionsBitField(allow), deny: new PermissionsBitField(deny),
  }];
  const before = new Map([
    overwrite("everyone", SendMessages),
    overwrite("members"),
    overwrite("muted", 0n, SendMessages),
  ]);
  const reordered = new Map([...before].reverse());
  const label = ({ id }) => "@" + id;
  assert.deepEqual(channelPermissionChanges(before, reordered, label), []);
  const after = new Map([
    overwrite("members", ViewChannel, SendMessages),
    overwrite("mods", ManageMessages),
    overwrite("everyone"),
  ]);
  assert.deepEqual(channelPermissionChanges(reordered, after, label), [
    "- @everyone: Send Messages reset to neutral",
    "- @members: allowed View Channel, denied Send Messages",
    "- @mods: new overwrite added: allowed Manage Messages",
    "- @muted: removed overwrite (no custom permissions anymore)",
  ]);
});

test("embed truncation reports omitted lines or characters and stays inside the limit", () => {
  const lines = Array.from({ length: 40 }, (_, index) => (index + 1) + " " + "x".repeat(50));
  const field = truncate(lines.join("\n"), 1024);
  const rendered = field.split("\n");
  assert.ok(field.length <= 1024);
  assert.equal(rendered.at(-1), "...and " + (lines.length - rendered.length + 1) + " more");
  const description = truncate("😀".repeat(3000), 4096);
  assert.ok(description.length <= 4096);
  assert.match(description, /\.\.\.and \d+ more$/);
  assert.doesNotMatch(description, /[\uD800-\uDBFF]\./);
});

test("unknown voice flags produce no change and switching retains other changes in the batch", () => {
  assert.deepEqual(describeVoiceChanges(fixture("a", { selfMute: null }), fixture("a")), []);
  const move = describeVoiceChanges(fixture("a"), fixture("b"));
  const mute = describeVoiceChanges(fixture("b"), fixture("b", { selfMute: true }));
  assert.deepEqual(summarizeVoiceChanges([...move, ...mute]).changes, ["Muted themselves"]);
});

test("log embeds preserve multiline user text and collect mention IDs", () => {
  const ids = new Map();
  const text = "true\nContent unavailable\n<@" + USER + ">";
  assert.equal(sanitizeLogText(text, GUILD, ids, true), text);
  assert.deepEqual([...ids.keys()], ["User ID " + USER]);
});
