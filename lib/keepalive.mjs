import { redis } from './store.mjs';

export const keepaliveOnline=owner=>`alice:keepalive:online:${owner}`;

export async function disableKeepalive(owner) {
  await redis([['DEL',`alice:keepalive:config:${owner}`,`alice:keepalive:issued:${owner}`]],1000);
}

export async function setKeepalive(owner,enabled) {
  await disableKeepalive(owner);
  return enabled
    ? 'Периодические обращения отключены: они мешали разговору. Автоматическая доставка готовых ответов продолжает работать.'
    : 'Постоянный режим выключен.';
}

// Compatibility with existing callers and already-installed bridge clients.
// No periodic commands may be issued, even for previously enabled accounts.
export async function noteSkillActivity() {}
export async function nextKeepalive() { return null; }
export async function keepaliveStatus() { return 'Постоянный режим выключен.'; }
