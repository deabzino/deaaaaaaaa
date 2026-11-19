import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import test, { after, before } from "node:test";

let child;
let base;

before(async () => {
  const portProbe = createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), WEBSITE_PREVIEW: "true", DATABASE_URL: "postgresql://preview:preview@127.0.0.1:5432/preview", DISCORD_BOT_TOKEN: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview server exited before listening: ${stderr}`);
    try { const response = await fetch(`${base}/api/healthz`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Preview server did not start: ${stderr}`);
});

after(() => { if (child && child.exitCode === null) child.kill("SIGTERM"); });

test("connect page loads, keeps the code private and links its assets", async () => {
  const response = await fetch(`${base}/connect`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex");
  const body = await response.text();
  assert.match(body, /<title>Connect — dea<\/title>/);
  assert.match(body, /name="referrer" content="no-referrer"/);
  assert.match(body, /id="code"/);
  assert.match(body, /\/connect\.js\?v=1/);
  assert.doesNotMatch(body, /__SITE_URL__/);
  for (const asset of ["/connect.js", "/connect.css", "/shared.js"]) {
    assert.equal((await fetch(`${base}${asset}`)).status, 200, `${asset} should load`);
  }
  assert.match(await (await fetch(`${base}/shared.js`)).text(), /\["Connect", "\/connect"/);
});

test("connect script only talks to the local capture app and never auto-submits", async () => {
  const script = await (await fetch(`${base}/connect.js`)).text();
  assert.match(script, /http:\/\/127\.0\.0\.1:47821/);
  assert.equal([...script.matchAll(/https?:\/\/[^"'`\s)]+/g)].every(([url]) => url.startsWith("http://127.0.0.1:47821")), true);
  assert.match(script, /history\.replaceState/);
  assert.doesNotMatch(script, /form\.requestSubmit|form\.submit\(/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|console\./);
});
