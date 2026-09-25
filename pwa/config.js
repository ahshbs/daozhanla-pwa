// Public deployment settings. Never put VAPID private keys or access tokens here.
// Keep pushApiBase empty for same-origin hosting or a static site without push.
// With a separate push service, set its HTTPS /api/v1/push URL and configure
// PUSH_PUBLIC_ORIGIN on that server to exactly match this page's origin.
window.DAOZHAN_CONFIG = Object.freeze({
  release: '2026.09.25-push-test',
  pushApiBase: 'https://appreciated-import-skating-patio.trycloudflare.com/api/v1/push',
  // Set false before a formal release to hide the local field-test ledger.
  fieldTestMode: true
});
