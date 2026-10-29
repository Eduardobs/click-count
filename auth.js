import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

// Keep app sessions in tab storage; never persist provider API credentials.
const memory = new Map();
const storage = {
  getItem(key) {
    try { return sessionStorage.getItem(key); } catch { return memory.get(key) ?? null; }
  },
  setItem(key, value) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        delete parsed.provider_token;
        delete parsed.provider_refresh_token;
        value = JSON.stringify(parsed);
      }
    } catch { /* PKCE verifier storage also contains plain strings. */ }
    try { sessionStorage.setItem(key, value); } catch { memory.set(key, value); }
  },
  removeItem(key) {
    memory.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* In-memory fallback. */ }
  },
};
const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'pkce', storage, storageKey: 'one-more-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
let user = null;
client.auth.onAuthStateChange((_event, session) => { user = session?.user || null; });
export function currentUser() { return user; }
export async function initializeAuth() {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  user = data.session?.user || null;
  // Remove callback parameters once the SDK has exchanged the PKCE code.
  const url = new URL(window.location.href);
  if (url.searchParams.has('code')) {
    url.searchParams.delete('code');
    history.replaceState(null, '', url);
  }
}
export async function accessToken(userId) {
  if (!userId) return null;
  const { data, error } = await client.auth.getSession();
  if (error || data.session?.user?.id !== userId) throw new Error('Entre novamente para enviar seus cliques pendentes.');
  return data.session.access_token;
}
export async function signIn(email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Não foi possível entrar. Confira suas credenciais e a confirmação do e-mail.');
  user = data.user;
}
export async function signUp(email, password, displayName) {
  const { data, error } = await client.auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
  if (error) throw new Error('Não foi possível criar a conta. Confira os dados e tente novamente.');
  user = data.session?.user || null;
}
export async function signOut() {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) throw new Error('Não foi possível sair. Tente novamente.');
  user = null;
}
export async function socialLogin(provider) {
  if (!['google', 'facebook', 'x'].includes(provider)) throw new Error('Provedor inválido.');
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}${window.location.pathname}` },
  });
  if (error) throw new Error('Login social indisponível. Tente outra opção.');
}
