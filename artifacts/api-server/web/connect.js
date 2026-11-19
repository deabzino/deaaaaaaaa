(() => {
  const APP = "http://127.0.0.1:47821";
  const CODE = /^[A-Z2-9]{10}$/;
  const input = document.getElementById("code");
  const form = document.getElementById("connect-form");
  const button = document.getElementById("connect-button");
  const result = document.getElementById("connect-result");
  const appBox = document.getElementById("app-status");
  const appText = document.getElementById("app-status-text");
  const help = document.getElementById("app-help");
  if (!input || !form || !button || !result || !appBox || !appText) return;

  let appFound = false;
  let busy = false;
  let paired = false;

  // The code can arrive in the URL hash (never sent to the server) or the query string.
  // Fill the box, then remove it from the address bar so it isn't kept in history or shared.
  // It is NOT submitted automatically: someone else's link must not be able to pair this PC.
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get("code") ?? new URLSearchParams(location.search).get("code");
    if (raw) {
      input.value = format(clean(raw));
      history.replaceState(null, "", location.pathname);
    }
  } catch {}

  function clean(value) {
    return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  }
  function format(value) {
    return value.length > 5 ? `${value.slice(0, 5)} ${value.slice(5)}` : value;
  }
  function show(kind, text) {
    result.hidden = !text;
    result.dataset.kind = kind;
    result.textContent = text ?? "";
  }
  function refresh() {
    const code = clean(input.value);
    const valid = CODE.test(code);
    input.setAttribute("aria-invalid", code.length === 10 && !valid ? "true" : "false");
    button.disabled = busy || !valid;
  }
  function setApp(state, text) {
    appBox.dataset.app = state;
    appText.textContent = text;
    appFound = state === "found";
    if (state === "missing" && help) help.open = true;
  }

  async function call(path, options = {}, timeout = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(APP + path, {
        ...options,
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        targetAddressSpace: "loopback",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function detect() {
    try {
      const response = await call("/status", {}, 1500);
      const body = await response.json();
      if (!response.ok || body?.app !== "dea-capture") throw new Error("not dea");
      if (body.state === "connected") {
        paired = true;
        setApp("found", "Capture app found. It is paired and following your game.");
      } else {
        setApp("found", "Capture app found on this computer.");
      }
    } catch {
      setApp("missing", paired ? "Lost contact with the capture app. Is it still running?" : "Capture app not found on this computer.");
    }
  }

  input.addEventListener("input", () => {
    const start = input.selectionStart;
    const before = input.value.length;
    input.value = format(clean(input.value));
    if (start !== null && input.value.length < before) input.setSelectionRange(start, start);
    show("", "");
    refresh();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = clean(input.value);
    if (busy || !CODE.test(code)) return;
    busy = true;
    refresh();
    show("", "Connecting…");
    try {
      const response = await call("/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      }, 12000);
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        paired = true;
        input.value = "";
        setApp("found", "Capture app found. It is paired and following your game.");
        show("ok", "Connected. Start Among Us and dea will follow the game. Check Discord for the status message.");
      } else if (response.status === 401) {
        show("error", "That code is invalid, expired or already used. Run /capture pair in Discord for a new one.");
      } else if (response.status === 429) {
        show("error", "Too many tries. Wait a minute, then try again.");
      } else if (response.status === 502) {
        show("error", "The capture app could not reach dea. Check your internet connection and try again.");
      } else {
        show("error", "The capture app rejected that. Check the code and try again.");
      }
    } catch {
      setApp("missing", "Capture app not found on this computer.");
      show("error", "Could not reach the capture app. Start it in listen mode, then press Connect again.");
    } finally {
      busy = false;
      refresh();
    }
  });

  refresh();
  detect();
  setInterval(() => { if (!busy && !document.hidden) detect(); }, 4000);
})();
