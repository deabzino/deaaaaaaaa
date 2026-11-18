import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const after = process.argv[2];
if (!after) {
  console.error("Usage: node scripts/update-changelog.mjs <pushed-commit>");
  process.exit(2);
}

const statePath = ".github/changelog-state.json";
const changelogPath = "artifacts/api-server/web/changelog.json";
const state = JSON.parse(await readFile(statePath, "utf8"));
const before = state.lastProcessed;
if (!before || before === after) process.exit(0);

let commits;
let changedFiles;
let changes;
try {
  const output = execFileSync("git", ["log", "--reverse", "--format=%H%x00%cI%x00%s", `${before}..${after}`], { encoding: "utf8" });
  const values = output.trim().split("\n").flatMap((line) => line.split("\0")).map((value) => value.trim()).filter(Boolean);
  commits = [];
  for (let index = 0; index + 2 < values.length; index += 3) commits.push({ hash: values[index], date: values[index + 1], subject: values[index + 2] });
  changes = execFileSync("git", ["diff", "--name-status", "--no-renames", before, after], { encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0], file: rest.join("\t") };
    });
  changedFiles = changes.map(({ file }) => file);
} catch (error) {
  console.error("Could not read the pushed commits for the changelog.", error);
  process.exit(1);
}

if (!commits.length) process.exit(0);

const areas = new Map();
const addArea = (key, status) => {
  if (!areas.has(key)) areas.set(key, []);
  areas.get(key).push(status);
};
for (const { file, status } of changes) {
  if (file.startsWith("artifacts/among-us-capture/") || file.startsWith("artifacts/api-server/src/among-us/") ||
    /artifacts\/api-server\/src\/discord\/capture/.test(file)) addArea("automatic", status);
  else if (file.startsWith("artifacts/api-server/web/") && !file.endsWith("/changelog.json")) addArea("website", status);
  else if (/artifacts\/api-server\/src\/discord\/(serverLogger|voiceLogBatcher|logFormatting)/.test(file)) addArea("activity", status);
  else if (/artifacts\/api-server\/src\/discord\/(bot|commandCatalog)/.test(file)) addArea("commands", status);
  else if (file.startsWith("artifacts/api-server/src/discord/")) addArea("discord", status);
  else if (file.startsWith("artifacts/api-server/src/")) addArea("service", status);
}

const otherProjectFiles = changedFiles.filter((file) => file !== changelogPath && file !== statePath &&
  !file.startsWith(".github/") && !file.startsWith("scripts/"));
if (!areas.size && otherProjectFiles.length) addArea("service", "M");
if (!areas.size) process.exit(0);

const latest = commits.at(-1);
const date = new Date(latest.date).toISOString();
const subjects = commits.map(({ subject }) => subject.toLowerCase());
const subjectType = subjects.some((subject) => /\b(remove|removed|delete|deleted)\b/.test(subject)) ? "Removed"
  : subjects.some((subject) => /\b(fix|fixed|repair|bug)\b/.test(subject)) ? "Fixed"
    : subjects.some((subject) => /\b(add|added|new|feat|feature)\b/.test(subject)) ? "Added" : "Improved";
// An area where files were only deleted is reported as removed, whatever the commit messages say.
const typeFor = (statuses) => statuses.every((status) => status === "D") ? "Removed" : subjectType;
const copy = {
  automatic: {
    title: "Automatic Among Us muting",
    Added: "Automatic mode can follow your Among Us game and handle voice mutes for you.",
    Improved: "Automatic mode is smoother and more dependable.",
    Fixed: "Automatic mode works more reliably during a round.",
    Removed: "Unneeded automatic mode behavior has been removed.",
  },
  website: {
    title: "A smoother dea website",
    Added: "New details make the dea website more useful for your crew.",
    Improved: "The dea website is clearer and easier to browse.",
    Fixed: "The dea website works more smoothly and reliably.",
    Removed: "Unneeded website details have been removed for a clearer experience.",
  },
  activity: {
    title: "Clearer server activity",
    Added: "New activity details make it easier to follow what happens in your server.",
    Improved: "Server activity logs are clearer and easier to follow.",
    Fixed: "Server activity logs report changes more reliably.",
    Removed: "Unneeded server activity details have been removed.",
  },
  commands: {
    title: "More useful Discord commands",
    Added: "New command features give your crew more ways to manage a round.",
    Improved: "Discord commands are clearer and easier to use.",
    Fixed: "Discord commands work more reliably for your crew.",
    Removed: "Commands your crew no longer needs have been removed.",
  },
  discord: {
    title: "More from dea in Discord",
    Added: "New Discord features help your crew manage rounds together.",
    Improved: "dea's Discord features are easier to use.",
    Fixed: "dea's Discord features work more reliably.",
    Removed: "Unneeded Discord behavior has been removed.",
  },
  service: {
    title: "A more reliable dea",
    Added: "New service details help keep your server in the loop.",
    Improved: "dea's service is more reliable for your server.",
    Fixed: "Service issues have been fixed to keep dea running smoothly.",
    Removed: "Unneeded service behavior has been removed.",
  },
};

const entryChanges = [...areas].map(([area, statuses]) => ({ type: typeFor(statuses), text: copy[area][typeFor(statuses)] }));
const title = areas.size === 1 ? copy[areas.keys().next().value].title : "More updates for your crew";
const existingJson = await readFile(changelogPath, "utf8");
const entries = JSON.parse(existingJson);
if (entries.some((entry) => Date.parse(entry.date) >= Date.parse(date))) {
  console.log("The changelog already includes an entry from this time or later.");
  process.exit(0);
}

const entry = { date, title, changes: entryChanges };
const updatedJson = existingJson.replace(/^\s*\[/, `[\n  ${JSON.stringify(entry)},`);
await writeFile(changelogPath, updatedJson, "utf8");
await writeFile(statePath, `${JSON.stringify({ lastProcessed: after }, null, 2)}\n`, "utf8");
console.log(`Added a changelog entry for ${areas.size} product area${areas.size === 1 ? "" : "s"}.`);
