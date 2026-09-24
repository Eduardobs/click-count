import { RealtimeClient } from "@supabase/realtime-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { compareCounters, normalizeCounter } from "./counter-utils.js";

// GitHub Pages cannot emit anti-framing response headers. The button starts disabled,
// so hiding the document before connecting is a safe fallback against clickjacking.
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("This page cannot be embedded in a frame.");
}

const DEFAULT_RETRY_DELAY_MS = 2500;
const MAX_CONCURRENT_REQUESTS = 3;

const elements = {
  button: document.querySelector("#clickButton"),
  counter: document.querySelector("#counterValue"),
  liveLabel: document.querySelector("#liveLabel"),
  livePill: document.querySelector("#livePill"),
  message: document.querySelector("#message"),
  pending: document.querySelector("#pendingLabel"),
};

const state = {
  queued: 0,
  inFlight: 0,
  connected: false,
  retryTimer: null,
  pressTimer: null,
  renderedValue: null,
};

function setConnection(status, label) {
  state.connected = status === "online";
  elements.livePill.dataset.state = status;
  elements.liveLabel.textContent = label;
  elements.button.disabled = !state.connected;
}

function renderCounter(rawValue) {
  const value = normalizeCounter(rawValue);
  // Initial reads, mutation responses, and Realtime updates race each other.
  // Never let an older response visually roll the counter back.
  if (state.renderedValue !== null && compareCounters(value, state.renderedValue) <= 0) {
    return;
  }

  const formatted = value.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  elements.counter.value = formatted;
  elements.counter.textContent = formatted;
  elements.counter.dataset.size = value.length > 24
    ? "very-long"
    : value.length > 10 ? "long" : "normal";
  elements.counter.setAttribute("aria-label", `${value} clicks`);
  state.renderedValue = value;
}

function renderPending() {
  elements.pending.textContent = state.queued === 0
    ? ""
    : `${state.queued} ${state.queued === 1 ? "click queued" : "clicks queued"}`;
}

function showError(message) {
  elements.message.textContent = message;
  setConnection("error", "no connection");
}

const configured =
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) &&
  SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_");

if (!configured) {
  showError("Configure Supabase in config.js to publish the counter.");
} else {
  const realtimeUrl = `${SUPABASE_URL.replace("https://", "wss://")}/realtime/v1`;
  const realtime = new RealtimeClient(realtimeUrl, {
    accessToken: async () => SUPABASE_PUBLISHABLE_KEY,
    params: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      eventsPerSecond: 10,
    },
  });

  async function incrementCounter() {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/increment-counter`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `Increment failed (${response.status}).`);
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (response.status === 429 && Number.isFinite(retryAfter)) {
        error.retryAfterMs = Math.max(1, retryAfter) * 1000;
      }
      throw error;
    }

    return payload;
  }

  async function loadCounter() {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/counters?id=eq.main&select=value&limit=1`,
      { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } },
    );
    const rows = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(rows) || rows.length !== 1) {
      throw new Error(`Counter read failed (${response.status}).`);
    }
    renderCounter(rows[0].value);
  }

  async function sendQueuedClick() {
    state.inFlight += 1;
    try {
      const result = await incrementCounter();
      renderCounter(result.new_value);
      state.queued -= 1;
      renderPending();
      if (state.retryTimer === null) elements.message.textContent = "";
    } catch (error) {
      console.error("Could not register click:", error);
      elements.message.textContent = "Your click is queued. Trying again…";
      clearTimeout(state.retryTimer);
      state.retryTimer = window.setTimeout(
        () => {
          state.retryTimer = null;
          processQueue();
        },
        error.retryAfterMs || DEFAULT_RETRY_DELAY_MS,
      );
    } finally {
      state.inFlight -= 1;
      processQueue();
    }
  }

  function processQueue() {
    if (!state.connected || state.retryTimer !== null) return;

    const waiting = state.queued - state.inFlight;
    const availableSlots = MAX_CONCURRENT_REQUESTS - state.inFlight;
    const requestsToStart = Math.min(waiting, availableSlots);
    for (let index = 0; index < requestsToStart; index += 1) {
      void sendQueuedClick();
    }
  }

  elements.button.addEventListener("click", () => {
    state.queued += 1;
    renderPending();
    elements.button.classList.add("is-pressed");
    clearTimeout(state.pressTimer);
    state.pressTimer = window.setTimeout(
      () => elements.button.classList.remove("is-pressed"),
      120,
    );
    if ("vibrate" in navigator) navigator.vibrate(18);
    processQueue();
  });

  const channel = realtime
    .channel("public-counter")
    .on("postgres_changes", {
      event: "UPDATE", schema: "public", table: "counters", filter: "id=eq.main",
    }, (payload) => renderCounter(payload.new.value))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setConnection("online", "live");
        elements.message.textContent = "";
        processQueue();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setConnection("offline", "reconnecting");
        elements.message.textContent = "Reconnecting to the counter…";
      } else if (status === "CLOSED") {
        setConnection("offline", "offline");
      }
    });

  window.addEventListener("online", () => {
    elements.message.textContent = "Connection restored. Syncing…";
    loadCounter().then(processQueue).catch(() => {
      elements.message.textContent = "Still unable to sync.";
    });
  });

  window.addEventListener("offline", () => {
    setConnection("offline", "offline");
    elements.message.textContent = "No internet. Your clicks will stay queued in this tab.";
  });

  loadCounter().catch((error) => {
    console.error("Could not load the counter:", error);
    showError("Could not access the counter. Check the configuration.");
    realtime.removeChannel(channel);
  });
}
