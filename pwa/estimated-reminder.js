(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DaozhanEstimate = factory();
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'daozhanla.foreground-estimate.v1';
  const LATE_GRACE_MS = 15000;

  // Estimates never change station progress. The anchor comes only from the
  // trip's start or latest manual confirmation, never from loading this page.
  function planFor(trip) {
    if (!trip || trip.status !== 'active' || typeof trip.id !== 'string'
      || !Array.isArray(trip.route) || !Number.isInteger(trip.currentIndex)
      || trip.currentIndex < 0 || trip.currentIndex >= trip.route.length - 1
      || !Number.isInteger(trip.remindBefore) || trip.remindBefore < 0 || trip.remindBefore > 2) return null;
    const anchor = Date.parse(trip.updatedAt);
    const reminderIndex = Math.max(0, trip.route.length - 1 - trip.remindBefore);
    const edges = trip.route.slice(trip.currentIndex, reminderIndex);
    if (!Number.isSafeInteger(anchor) || edges.some(station => !Number.isFinite(station.secondsToNext) || station.secondsToNext <= 0)) return null;
    const duration = edges.reduce((sum, station) => sum + station.secondsToNext * 1000, 0);
    if (!Number.isSafeInteger(duration) || duration > 4 * 60 * 60 * 1000) return null;
    return { key: JSON.stringify([trip.id, trip.currentIndex, trip.updatedAt, trip.remindBefore]),
      tripId: trip.id, anchor, fireAt: anchor + duration,
      inRange: trip.currentIndex >= reminderIndex, destination: trip.route.at(-1).name };
  }

  function createEstimatedReminder({ storage, now = Date.now } = {}) {
    let record = null, plan = null, status = 'off', simulation = false, storageOk = true, lastCheckedAt = null;
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (saved?.version === 1 && typeof saved.tripId === 'string' && typeof saved.enabled === 'boolean'
        && typeof saved.key === 'string' && ['scheduled', 'delivered', 'expired', 'range', 'off'].includes(saved.status)) record = saved;
    } catch { storageOk = false; }
    function persist() {
      try {
        if (record) storage.setItem(STORAGE_KEY, JSON.stringify(record));
        else storage.removeItem(STORAGE_KEY);
        storageOk = true;
      } catch {
        storageOk = false;
        // A failed update must not leave an earlier enabled plan to revive on
        // reload. Deletion may still work when a write hits the storage quota.
        try { storage.removeItem(STORAGE_KEY); }
        catch {
          // Some adapters permit overwriting when deletion fails. This marker
          // is intentionally not a restorable reminder record.
          try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, enabled: false, ended: true })); }
          catch { /* The current page still stays off/deduplicated; report failure. */ }
        }
      }
    }
    function snapshot() {
      return { status, enabled: !simulation && Boolean(record?.enabled), storageOk,
        key: plan?.key, tripId: plan?.tripId, fireAt: plan?.fireAt,
        destination: plan?.destination, remainingMs: plan ? Math.max(0, plan.fireAt - now()) : 0 };
    }
    function check({ resumed = false } = {}) {
      if (simulation || !record?.enabled || !plan || ['delivered', 'expired', 'range'].includes(status)) return snapshot();
      const timestamp = now();
      const clockWentBack = lastCheckedAt !== null && timestamp < lastCheckedAt - LATE_GRACE_MS;
      lastCheckedAt = timestamp;
      const remaining = plan.fireAt - timestamp;
      if (remaining <= 0 && (resumed || remaining < -LATE_GRACE_MS) || timestamp < plan.anchor - LATE_GRACE_MS || clockWentBack) {
        status = record.status = 'expired'; persist();
      } else status = remaining <= 0 ? 'due' : 'scheduled';
      return snapshot();
    }
    function attach(trip, options = {}) {
      simulation = options.simulation === true;
      plan = simulation ? null : planFor(trip);
      if (!plan) {
        record = null; status = simulation ? 'simulation' : trip?.status === 'arrived' ? 'complete' : 'off';
        persist(); return snapshot();
      }
      const previous = record?.tripId === trip.id ? record : null;
      const enabled = typeof options.enabled === 'boolean' ? options.enabled : previous?.enabled === true;
      const sameAnchor = previous?.key === plan.key;
      if (!sameAnchor) lastCheckedAt = null;
      // Changing a toggle does not erase a delivered/expired marker. A new
      // manual station confirmation supplies a new anchor and permits a replan.
      const savedStatus = sameAnchor && ['delivered', 'expired'].includes(previous.status) ? previous.status
        : plan.inRange ? 'range' : 'scheduled';
      record = { version: 1, tripId: trip.id, key: plan.key, enabled, status: savedStatus };
      status = enabled ? savedStatus : 'off';
      persist();
      return check({ resumed: options.restore === true });
    }
    function markShown(key) {
      if (!record?.enabled || !plan || key !== plan.key || status !== 'due') return false;
      status = record.status = 'delivered'; persist(); return true;
    }
    function end() { record = null; plan = null; simulation = false; status = 'off'; lastCheckedAt = null; persist(); return snapshot(); }
    return { attach, check, markShown, end, snapshot };
  }
  return { STORAGE_KEY, LATE_GRACE_MS, planFor, createEstimatedReminder };
}));
