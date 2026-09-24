import { createClient } from "@supabase/supabase-js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { counterSize, formatCounter, normalizeCounter } from "./counter-utils.js";

// GitHub Pages cannot emit anti-framing response headers. The button starts disabled,
// so hiding the document before connecting is a safe fallback against clickjacking.
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("This page cannot be embedded in a frame.");
}

const DEFAULT_RETRY_DELAY_MS = 2500;

const elements = {
  button: document.querySelector("#clickButton"),
  counter: document.querySelector("#counterValue"),
  liveLabel: document.querySelector("#liveLabel"),
  livePill: document.querySelector("#livePill"),
  message: document.querySelector("#message"),
  pending: document.querySelector("#pendingLabel"),
};

const state = { queued: 0, processing: false, connected: false, retryTimer: null };

function setConnection(status, label) {
  state.connected = status === "online";
  elements.livePill.dataset.state = status;
  elements.liveLabel.textContent = label;
  elements.button.disabled = !state.connected;
}

function renderCounter(rawValue) {
  const value = normalizeCounter(rawValue);
  const formatted = formatCounter(value);
  elements.counter.value = formatted;
  elements.counter.textContent = formatted;
  elements.counter.dataset.size = counterSize(value);
  elements.counter.setAttribute("aria-label", `${value} clicks`);
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
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
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
    const { data, error } = await supabase
      .from("counters")
      .select("value")
      .eq("id", "main")
      .single();
    if (error) throw error;
    renderCounter(data.value);
  }

  async function processQueue() {
    if (state.processing || state.queued === 0 || !state.connected) return;
    state.processing = true;
    clearTimeout(state.retryTimer);

    try {
      while (state.queued > 0 && state.connected) {
        const result = await incrementCounter();
        renderCounter(result.new_value);
        state.queued -= 1;
        renderPending();
      }
      elements.message.textContent = "";
    } catch (error) {
      console.error("Could not register click:", error);
      elements.message.textContent = "Your click is queued. Trying again…";
      state.retryTimer = window.setTimeout(
        processQueue,
        error.retryAfterMs || DEFAULT_RETRY_DELAY_MS,
      );
    } finally {
      state.processing = false;
    }
  }

  elements.button.addEventListener("click", () => {
    state.queued += 1;
    renderPending();
    elements.button.classList.add("is-pressed");
    window.setTimeout(() => elements.button.classList.remove("is-pressed"), 120);
    if ("vibrate" in navigator) navigator.vibrate(18);
    processQueue();
  });

  const channel = supabase
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
    supabase.removeChannel(channel);
  });
}
