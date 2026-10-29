import { currentUser, accessToken, signIn, signUp, signOut, socialLogin, initializeAuth } from "./auth.js";
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
  clicks: [],
  inFlight: 0,
  connected: false,
  authReady: false,
  retryTimer: null,
  pressTimer: null,
  renderedValue: null,
  clicksSinceRankingRefresh: 0,
};

function setConnection(status, label) {
  state.connected = status === "online";
  elements.livePill.dataset.state = status;
  elements.liveLabel.textContent = label;
  elements.button.disabled = !state.connected || !state.authReady;
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

  async function incrementCounter(click) {
    const token = await accessToken(click.userId);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/increment-counter`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

  async function sendQueuedClick(click) {
    click.sending = true;
    state.inFlight += 1;
    try {
      const result = await incrementCounter(click);
      renderCounter(result.new_value);
      state.clicks.splice(state.clicks.indexOf(click), 1);
      state.queued -= 1;
      state.clicksSinceRankingRefresh += 1;
      if (state.clicksSinceRankingRefresh >= 10) {
        state.clicksSinceRankingRefresh = 0;
        void loadRanking();
      }
      if (click.userId === currentUser()?.id && result.user_clicks) renderPersonal(result.user_clicks);
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
      click.sending = false;
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
      const click = state.clicks.find(item => !item.sending);
      if (click) void sendQueuedClick(click);
    }
  }

  elements.button.addEventListener("click", () => {
    state.clicks.push({ userId: currentUser()?.id || null, sending: false });
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

const accountForm = document.querySelector('#accountForm');
const authMessage = document.querySelector('#modalAuthMessage');
const accountMessage = document.querySelector('#authMessage');
const authDialog = document.querySelector('#authDialog');
const openAuth = document.querySelector('#openAuth');
const accountMenu = document.querySelector('#accountMenu');
let authMode = 'login';
let authBusy = false;
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  document.querySelector('#authTitle').textContent = signup ? 'Criar sua conta' : 'Entrar na sua conta';
  document.querySelector('#displayNameField').hidden = !signup;
  document.querySelector('#displayName').required = signup;
  document.querySelector('#signupHint').hidden = !signup;
  document.querySelector('#password').autocomplete = signup ? 'new-password' : 'current-password';
  document.querySelector('#password').minLength = signup ? 12 : 1;
  document.querySelector('#authSubmitLabel').textContent = signup ? 'Criar conta' : 'Entrar';
  document.querySelector('#loginTab').setAttribute('aria-pressed', String(!signup));
  document.querySelector('#signupTab').setAttribute('aria-pressed', String(signup));
}
document.querySelector('#loginTab').addEventListener('click', () => { if (!authBusy) setAuthMode('login'); });
document.querySelector('#signupTab').addEventListener('click', () => { if (!authBusy) setAuthMode('signup'); });
function showAuth(mode) {
  authMessage.textContent = '';
  setAuthMode(mode);
  authDialog.showModal();
  document.querySelector(mode === 'signup' ? '#displayName' : '#email').focus();
}
openAuth.addEventListener('click', () => showAuth('login'));
document.querySelector('#openSignup').addEventListener('click', () => showAuth('signup'));
document.querySelector('#closeAuth').addEventListener('click', () => authDialog.close());
authDialog.addEventListener('close', () => { document.querySelector('#password').value = ''; });
const summary = document.querySelector('#accountSummary');
const logoutButton = document.querySelector('#signOut');
let personalValue = '0';
function renderPersonal(value) {
  if (compareCounters(value, personalValue) >= 0) personalValue = value;
  summary.textContent = currentUser() ? `Seus cliques: ${personalValue.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}` : '';
}
const avatars = ['🐱', '🐶', '🦊', '🐼', '🐨', '🐸', '🦁', '🐯', '🐵', '🐰', '🐻', '🐹'];
const userAvatars = new Map();
function renderAccount() {
  const user = currentUser();
  const loggedIn = Boolean(user);
  document.querySelector('#guestActions').hidden = loggedIn;
  document.querySelector('#userAccount').hidden = !loggedIn;
  accountMenu.hidePopover();
  if (user) {
    const metadata = user.user_metadata || {};
    const name = [metadata.display_name, metadata.nickname, metadata.full_name, metadata.name]
      .find(value => typeof value === 'string' && value.trim());
    document.querySelector('#userName').textContent = name || 'Minha conta';
    if (!userAvatars.has(user.id)) {
      userAvatars.set(user.id, avatars[crypto.getRandomValues(new Uint32Array(1))[0] % avatars.length]);
    }
    document.querySelector('#userAvatar').textContent = userAvatars.get(user.id);
  }
  if (loggedIn && authDialog.open) authDialog.close();
  document.querySelector('#socialLogins').hidden = loggedIn;
  logoutButton.hidden = !loggedIn;
  personalValue = '0';
  renderPersonal('0');
}
async function rpc(name, token) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: '{}',
  });
  if (!response.ok) throw new Error('Não foi possível carregar os dados.');
  return response.json();
}
let rankingLoading = false;
let rankingRefreshPending = false;
async function loadRanking() {
  if (rankingLoading) {
    rankingRefreshPending = true;
    return;
  }
  rankingLoading = true;
  const message = document.querySelector('#rankingMessage');
  const button = document.querySelector('#refreshRanking');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  document.querySelector('#refreshRankingLabel').textContent = 'Atualizando…';
  try {
    const rows = await rpc('click_leaderboard');
    const list = document.querySelector('#leaderboard');
    list.replaceChildren();
    for (const row of rows) {
      const item = document.createElement('li');
      const entry = document.createElement('div');
      entry.className = 'ranking-entry';
      const name = document.createElement('span');
      name.textContent = row.display_name;
      const total = document.createElement('strong');
      total.textContent = normalizeCounter(row.clicks).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      entry.append(name, total); item.append(entry); list.append(item);
    }
    message.textContent = rows.length ? '' : 'Seja o primeiro a participar!';
    const user = currentUser();
    if (user) {
      const value = await rpc('my_clicks', await accessToken(user.id));
      if (currentUser()?.id === user.id) renderPersonal(value);
    }
  } catch { message.textContent = 'Ranking indisponível. Tente atualizar em instantes.'; }
  finally {
    rankingLoading = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    document.querySelector('#refreshRankingLabel').textContent = 'Atualizar ranking';
    if (rankingRefreshPending) {
      rankingRefreshPending = false;
      void loadRanking();
    }
  }
}
accountForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (state.queued && authMode === 'signup') { authMessage.textContent = 'Aguarde o envio dos cliques pendentes antes de criar outra conta.'; return; }
  if (authBusy) return;
  authBusy = true;
  const buttons = authDialog.querySelectorAll('button:not(#closeAuth)');
  buttons.forEach(button => { button.disabled = true; });
  authMessage.textContent = '';
  const password = document.querySelector('#password');
  try {
    const email = document.querySelector('#email').value.trim();
    if (authMode === 'signup') {
      const name = document.querySelector('#displayName').value.trim();
      if (!name) throw new Error('Escolha um apelido público para criar a conta.');
      await signUp(email, password.value, name);
      if (currentUser()) {
        accountMessage.textContent = 'Conta criada! Você já está conectado e pode contabilizar seus cliques.';
      } else {
        setAuthMode('login');
        authMessage.textContent = 'Conta criada. Este servidor exige confirmação de e-mail: confirme o cadastro para entrar.';
      }
    } else { await signIn(email, password.value); accountMessage.textContent = 'Você entrou na sua conta.'; }
    renderAccount();
    void loadRanking();
  } catch (error) { authMessage.textContent = error.message; }
  finally { authBusy = false; password.value = ''; buttons.forEach(button => { button.disabled = false; }); }
});
logoutButton.addEventListener('click', async () => {
  accountMenu.hidePopover();
  if (state.queued) { accountMessage.textContent = 'Aguarde o envio dos cliques pendentes antes de sair.'; return; }
  try {
    await signOut(); renderAccount(); accountMessage.textContent = 'Você saiu da conta.';
  } catch (error) { accountMessage.textContent = error.message; }
});
for (const button of document.querySelectorAll('[data-provider]')) {
  button.addEventListener('click', async () => {
    if (state.queued) { authMessage.textContent = 'Aguarde o envio dos cliques pendentes antes de entrar.'; return; }
    try { await socialLogin(button.dataset.provider); }
    catch (error) { authMessage.textContent = error.message; }
  });
}
document.querySelector('#refreshRanking').addEventListener('click', () => { void loadRanking(); });
setAuthMode('login');
initializeAuth().catch(() => { accountMessage.textContent = 'Não foi possível restaurar o login. Entre novamente.'; }).finally(() => {
  state.authReady = true;
  elements.button.disabled = !state.connected;
  renderAccount();
  void loadRanking();
  window.setInterval(() => { void loadRanking(); }, 20000);
});
