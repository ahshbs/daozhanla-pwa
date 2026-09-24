// Runs in the service worker even when no application page is open.
// It displays server-triggered estimates only; it never tracks or advances a trip.
(function (worker) {
  'use strict';

  const ENTRY = new URL('./', worker.registration.scope);
  const ICON = new URL('assets/pwa/icon-192.png', ENTRY).href;
  const TAG_PREFIX = 'daozhanla-push-';
  const pending = new Set();
  const delivered = new Set();
  const MAX_RECENT_IDS = 128;
  const VALID_ID = /^[a-zA-Z0-9:_-]{1,128}$/;

  function parsePayload(event) {
    let payload;
    try { payload = event.data && event.data.json(); } catch (_) { return null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (payload.type !== 'arrival-estimate' && payload.type !== 'test') return null;
    if (typeof payload.id !== 'string' || !VALID_ID.test(payload.id)) return null;
    if (payload.type === 'arrival-estimate' && (typeof payload.tripId !== 'string' || !VALID_ID.test(payload.tripId))) return null;
    if (payload.tripId != null && (typeof payload.tripId !== 'string' || !VALID_ID.test(payload.tripId))) return null;
    if (payload.destination != null && (typeof payload.destination !== 'string' || !payload.destination.trim()
      || !/^[\p{L}\p{N}·（）() -]{1,60}$/u.test(payload.destination))) return null;
    const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt
      : typeof payload.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(payload.expiresAt) ? Date.parse(payload.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    if (typeof payload.body !== 'string' || !payload.body.trim() || payload.body.length > 500 || /[\u0000-\u001f\u007f]/.test(payload.body)) return null;
    return {
      type: payload.type,
      id: payload.id,
      tripId: payload.tripId || null,
      destination: payload.destination ? payload.destination.trim() : null,
      expiresAt
    };
  }

  async function showPush(payload) {
    const tag = TAG_PREFIX + payload.id;
    if (pending.has(tag) || delivered.has(tag)) return;
    pending.add(tag);
    try {
      const existing = await worker.registration.getNotifications({ tag });
      // Expiry can pass while the browser is looking up existing notifications.
      if (payload.expiresAt <= Date.now() || existing.some((notification) => notification.tag === tag)) return;
      await worker.registration.showNotification(payload.type === 'test' ? '到站啦 · 测试通知' : '预计到站提醒', {
        // Server text is not allowed to turn a time estimate into an actual-arrival claim.
        body: payload.type === 'test' ? '这是一条系统测试通知。预计提醒需要联网，并受手机系统设置影响。'
          : payload.destination ? '预计接近「' + payload.destination + '」。请以车厢广播和站牌为准。'
            : '按行程预计用时，您可能即将到站。请以车厢广播和站牌为准。',
        icon: ICON,
        tag,
        renotify: false,
        data: { type: payload.type, id: payload.id, tripId: payload.tripId }
      });
      delivered.add(tag);
      if (delivered.size > MAX_RECENT_IDS) delivered.delete(delivered.values().next().value);
    } finally {
      pending.delete(tag);
    }
  }

  worker.addEventListener('push', (event) => {
    const payload = parsePayload(event);
    if (payload) event.waitUntil(showPush(payload));
  });

  function belongsToScope(client) {
    try {
      const url = new URL(client.url);
      return url.origin === ENTRY.origin && url.pathname.startsWith(ENTRY.pathname);
    } catch (_) { return false; }
  }

  async function openApp() {
    const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows.filter(belongsToScope)) {
      try {
        // Both the destination and icon are fixed to this registration's scope.
        // No payload field can redirect a notification click to another site.
        const target = typeof client.navigate === 'function' ? await client.navigate(ENTRY.href) : client;
        if (target && typeof target.focus === 'function') return await target.focus();
      } catch (_) { /* Try another application window, then open the entry. */ }
    }
    return worker.clients.openWindow(ENTRY.href);
  }

  worker.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(openApp());
  });
})(self);
