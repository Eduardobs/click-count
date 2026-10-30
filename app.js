import { applyLanguage, setText, setLiteralText, t, formatCount } from "./i18n.js";
import { currentUser, accessToken, signIn, signUp, signOut, socialLogin, initializeAuth } from "./auth.js";
import { ClickQueue, retryDelay } from "./click-queue.js";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { compareCounters, normalizeCounter } from "./counter-utils.js";

// GitHub Pages cannot emit anti-framing response headers. The button starts disabled,
// so hiding the document before connecting is a safe fallback against clickjacking.
if (window.top !== window.self) {
  document.documentElement.hidden = true;
  throw new Error("This page cannot be embedded in a frame.");
}

const clickQueue = new ClickQueue();

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
  attempts: 0,
  queueTimer: null,
  inFlight: 0,
  connected: false,
  authReady: false,
  retryTimer: null,
  pressTimer: null,
  renderedValue: null,
};

function setConnection(status, label) {
  state.connected = status === "online";
  elements.livePill.dataset.state = status;
  setText(elements.liveLabel, label);
  elements.button.disabled = !state.connected || !state.authReady || clickQueue.size >= clickQueue.limit;
}

function renderCounter(rawValue) {
  const value = normalizeCounter(rawValue);
  // Periodic reads and mutation responses race each other.
  // Never let an older response visually roll the counter back.
  if (state.renderedValue !== null && compareCounters(value, state.renderedValue) <= 0) {
    return;
  }

  const formatted = formatCount(value);
  elements.counter.value = formatted;
  elements.counter.textContent = formatted;
  elements.counter.dataset.size = value.length > 24
    ? "very-long"
    : value.length > 10 ? "long" : "normal";
  elements.counter.setAttribute("aria-label", t("clicks", { count: formatCount(value) }));
  state.renderedValue = value;
}

function renderPending() {
  state.queued = clickQueue.size;
  elements.button.disabled = !state.connected || !state.authReady || clickQueue.size >= clickQueue.limit;
  setText(elements.pending, state.queued === 0 ? "" : state.queued === 1 ? "queuedOne" : "queuedMany", { count: formatCount(state.queued) });
}

function showError(message) {
  setText(elements.message, message);
  setConnection("error", "no connection");
}

const configured =
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) &&
  SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_");

if (!configured) {
  showError("Configure Supabase in config.js to publish the counter.");
} else {
  async function incrementCounter(click) {
    const token = await accessToken(click.userId);
    const response = await fetch(`${SUPABASE_URL}/functions/v1/increment-counter`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ request_id: click.request_id, amount: click.amount }),
      signal: AbortSignal.timeout(15000),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `Increment failed (${response.status}).`);
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        error.retryAfterMs = Math.max(1, retryAfter) * 1000;
      }
      throw error;
    }

    return payload;
  }

  async function loadCounter() {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/counter_total`,
      { method: "POST", headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000) },
    );
    const rows = await response.json().catch(() => null);
    if (!response.ok || typeof rows !== "string") {
      throw new Error(`Counter read failed (${response.status}).`);
    }
    renderCounter(rows);
  }

  async function sendQueuedClick(click) {
    state.inFlight += 1;
    try {
      const result = await incrementCounter(click);
      renderCounter(result.new_value);
      clickQueue.acknowledge(click);
      state.attempts = 0;
      if (click.userId === currentUser()?.id && result.user_clicks) renderPersonal(result.user_clicks);
      renderPending();
      if (state.retryTimer === null) setText(elements.message, "");
    } catch (error) {
      console.error("Could not register click:", error);
      setText(elements.message, "Your click is queued. Trying again…");
      clearTimeout(state.retryTimer);
      state.retryTimer = window.setTimeout(
        () => {
          state.retryTimer = null;
          processQueue();
        },
        retryDelay(state.attempts++, error.retryAfterMs),
      );
    } finally {
      state.inFlight -= 1;
      processQueue();
    }
  }

  function processQueue() {
    if (!state.connected || state.retryTimer !== null || state.inFlight || state.queueTimer !== null) return;
    if (!clickQueue.size) return;
    // Coalesce rapid clicks, bounding requests to one in flight per tab.
    state.queueTimer = window.setTimeout(() => {
      state.queueTimer = null;
      if (!state.connected || state.retryTimer !== null) return;
      const batch = clickQueue.next();
      if (batch) void sendQueuedClick(batch);
    }, 100);
  }

  elements.button.addEventListener("click", () => {
    if (!state.authReady || !state.connected || !clickQueue.push(currentUser()?.id || null)) return;
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

  let pollTimer = null;
  let polling = false;
  let pollFailures = 0;
  async function syncCounter() {
    clearTimeout(pollTimer);
    if (polling || document.hidden || !navigator.onLine) return;
    polling = true;
    try {
      await loadCounter();
      pollFailures = 0;
      setConnection("online", "live");
      if (!state.queued) setText(elements.message, "");
      processQueue();
    } catch {
      pollFailures++;
      setConnection("offline", "reconnecting");
      setText(elements.message, "Reconnecting to the counter…");
    } finally {
      polling = false;
      // Bounded read frequency independent of the global click rate, with jitter
      // to avoid synchronized waves. Hidden tabs stop polling entirely.
      if (!document.hidden) pollTimer = window.setTimeout(syncCounter,
        pollFailures ? retryDelay(pollFailures) : 2000 + Math.random() * 1000);
    }
  }
  window.addEventListener("online", () => { void syncCounter(); });
  window.addEventListener("offline", () => {
    setConnection("offline", "offline");
    setText(elements.message, "No internet. Your clicks will stay queued in this tab.");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(pollTimer);
    else void syncCounter();
  });
  void syncCounter();
}

const accountForm = document.querySelector('#accountForm');
const authMessage = document.querySelector('#modalAuthMessage');
const accountMessage = document.querySelector('#authMessage');
const authDialog = document.querySelector('#authDialog');
const openAuth = document.querySelector('#openAuth');
const accountMenu = document.querySelector('#accountMenu');
const avatarButton = document.querySelector('#avatarButton');

function positionAccountMenu() {
  const avatarBounds = avatarButton.getBoundingClientRect();
  accountMenu.style.top = `${avatarBounds.bottom + 8}px`;
  accountMenu.style.right = `${Math.max(12, document.documentElement.clientWidth - avatarBounds.right)}px`;
}

accountMenu.addEventListener('beforetoggle', event => {
  if (event.newState === 'open') positionAccountMenu();
});
function repositionOpenAccountMenu() {
  if (accountMenu.matches(':popover-open')) positionAccountMenu();
}
window.addEventListener('resize', repositionOpenAccountMenu);
window.addEventListener('scroll', repositionOpenAccountMenu, { passive: true });

let authMode = 'login';
let authBusy = false;
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  setText(document.querySelector('#authTitle'), signup ? 'Criar sua conta' : 'Entrar na sua conta');
  document.querySelector('#displayNameField').hidden = !signup;
  document.querySelector('#displayName').required = signup;
  document.querySelector('#signupHint').hidden = !signup;
  document.querySelector('#password').autocomplete = signup ? 'new-password' : 'current-password';
  document.querySelector('#password').minLength = signup ? 12 : 1;
  setText(document.querySelector('#authSubmitLabel'), signup ? 'Criar conta' : 'Entrar');
  document.querySelector('#loginTab').setAttribute('aria-pressed', String(!signup));
  document.querySelector('#signupTab').setAttribute('aria-pressed', String(signup));
}
document.querySelector('#loginTab').addEventListener('click', () => { if (!authBusy) setAuthMode('login'); });
document.querySelector('#signupTab').addEventListener('click', () => { if (!authBusy) setAuthMode('signup'); });
function showAuth(mode) {
  setText(authMessage, '');
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
  setText(summary, currentUser() ? 'personal' : '', { count: formatCount(personalValue) });
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
    if (name) setLiteralText(document.querySelector('#userName'), name);
    else setText(document.querySelector('#userName'), 'Minha conta');
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
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: '{}',
  });
  if (!response.ok) throw new Error('Não foi possível carregar os dados.');
  return response.json();
}
let rankingLoading = false;
let lastRankingRefresh = 0;
async function loadRanking() {
  if (rankingLoading || document.hidden || !navigator.onLine || Date.now() - lastRankingRefresh < 5000) return;
  rankingLoading = true;
  lastRankingRefresh = Date.now();
  const message = document.querySelector('#rankingMessage');
  const button = document.querySelector('#refreshRanking');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  setText(document.querySelector('#refreshRankingLabel'), 'Atualizando…');
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
      total.dataset.count = normalizeCounter(row.clicks);
      total.textContent = formatCount(total.dataset.count);
      entry.append(name, total); item.append(entry); list.append(item);
    }
    setText(message, rows.length ? '' : 'Seja o primeiro a participar!');
    const user = currentUser();
    if (user) {
      const value = await rpc('my_clicks', await accessToken(user.id));
      if (currentUser()?.id === user.id) renderPersonal(value);
    }
  } catch { setText(message, 'Ranking indisponível. Tente atualizar em instantes.'); }
  finally {
    rankingLoading = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    setText(document.querySelector('#refreshRankingLabel'), 'Atualizar ranking');
  }
}
accountForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (state.queued && authMode === 'signup') { setText(authMessage, 'Aguarde o envio dos cliques pendentes antes de criar outra conta.'); return; }
  if (authBusy) return;
  authBusy = true;
  const buttons = authDialog.querySelectorAll('button:not(#closeAuth)');
  buttons.forEach(button => { button.disabled = true; });
  setText(authMessage, '');
  const password = document.querySelector('#password');
  try {
    const email = document.querySelector('#email').value.trim();
    if (authMode === 'signup') {
      const name = document.querySelector('#displayName').value.trim();
      if (!name) throw new Error('Escolha um apelido público para criar a conta.');
      await signUp(email, password.value, name);
      if (currentUser()) {
        setText(accountMessage, 'Conta criada! Você já está conectado e pode contabilizar seus cliques.');
      } else {
        setAuthMode('login');
        setText(authMessage, 'Conta criada. Este servidor exige confirmação de e-mail: confirme o cadastro para entrar.');
      }
    } else { await signIn(email, password.value); setText(accountMessage, 'Você entrou na sua conta.'); }
    renderAccount();
    void loadRanking();
  } catch (error) { setText(authMessage, error.message); }
  finally { authBusy = false; password.value = ''; buttons.forEach(button => { button.disabled = false; }); }
});
logoutButton.addEventListener('click', async () => {
  accountMenu.hidePopover();
  if (state.queued) { setText(accountMessage, 'Aguarde o envio dos cliques pendentes antes de sair.'); return; }
  try {
    await signOut(); renderAccount(); setText(accountMessage, 'Você saiu da conta.');
  } catch (error) { setText(accountMessage, error.message); }
});
for (const button of document.querySelectorAll('[data-provider]')) {
  button.addEventListener('click', async () => {
    if (state.queued) { setText(authMessage, 'Aguarde o envio dos cliques pendentes antes de entrar.'); return; }
    try { await socialLogin(button.dataset.provider); }
    catch (error) { setText(authMessage, error.message); }
  });
}
document.querySelector('#refreshRanking').addEventListener('click', () => { void loadRanking(); });
setAuthMode('login');
initializeAuth().catch(() => { setText(accountMessage, 'Não foi possível restaurar o login. Entre novamente.'); }).finally(() => {
  state.authReady = true;
  elements.button.disabled = !state.connected || clickQueue.size >= clickQueue.limit;
  renderAccount();
  void loadRanking();
  const scheduleRanking = () => window.setTimeout(async () => {
    await loadRanking();
    scheduleRanking();
  }, 20000 + Math.random() * 5000);
  scheduleRanking();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadRanking(); });
});

function changeLanguage(language) {
  applyLanguage(language);
  const selected = document.documentElement.lang;
  document.querySelector('#languageCode').textContent = selected === 'pt-BR' ? 'PT' : selected.toUpperCase();
  document.querySelectorAll('[data-language]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.language === selected));
  });
  if (state.renderedValue !== null) {
    const value = state.renderedValue;
    state.renderedValue = null;
    renderCounter(value);
  }
  renderPending();
  renderPersonal(personalValue);
  document.querySelectorAll('[data-count]').forEach(element => {
    element.textContent = formatCount(element.dataset.count);
  });
}
const languagePicker = document.querySelector('#languagePicker');
const languageTrigger = languagePicker.querySelector('summary');
for (const button of languagePicker.querySelectorAll('[data-language]')) {
  button.addEventListener('click', () => {
    changeLanguage(button.dataset.language);
    languagePicker.open = false;
    languageTrigger.focus();
    try { localStorage.setItem('one-more-language', button.dataset.language); } catch { /* Storage may be unavailable. */ }
  });
}
document.addEventListener('click', event => {
  if (!languagePicker.contains(event.target)) languagePicker.open = false;
});
languagePicker.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    languagePicker.open = false;
    languageTrigger.focus();
  }
});
languagePicker.addEventListener('focusout', event => {
  if (!languagePicker.contains(event.relatedTarget)) languagePicker.open = false;
});
let savedLanguage = 'en';
try { savedLanguage = localStorage.getItem('one-more-language') || 'en'; } catch { /* Default to English. */ }
changeLanguage(savedLanguage);
