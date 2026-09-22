(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../miniprogram/utils/offline-trips.js'),
      require('../miniprogram/utils/field-storage.js'), require('../miniprogram/utils/reminders.js'));
  } else {
    var core = root.DaozhanCore || {};
    root.DaozhanTrips = factory(core.offlineTrips, core.fieldStorage, core.reminders);
    root.DaozhanTripStore = root.DaozhanTrips;
  }
}(typeof globalThis === 'object' ? globalThis : this, function (offline, field, reminders) {
  'use strict';

  var TRIP_KEY = 'daozhanla.pwa.trip.v1';
  function copy(value) { return value === null ? null : JSON.parse(JSON.stringify(value)); }
  function fail(code, message) { throw Object.assign(new Error(message), { code: code }); }

  function createTripStore(options) {
    options = options || {};
    var storage = options.storage;
    var now = options.now || Date.now;
    var onStatus = options.onStatus || function () {};
    var trip = null;
    var simulation = false;
    var keys = [];
    var endedInMemory = false;
    if (!offline || !field || !reminders) throw new Error('Local trip modules are required');

    function publish(status) {
      // A status label failure must never make a completed storage write fail.
      try { onStatus(status); } catch (_) { /* UI remains independently recoverable. */ }
      return status;
    }
    function requireStorage() {
      if (!storage || typeof storage.getItem !== 'function'
        || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
        throw new Error('浏览器本机存储不可用');
      }
      return storage;
    }
    var adapter = {
      getStorageSync: function () {
        var raw = requireStorage().getItem(TRIP_KEY);
        if (raw === null) return null;
        var record = JSON.parse(raw);
        if (record && record.pwaVersion === 1 && record.ended === true) return null;
        if (!record || record.pwaVersion !== 1 || typeof record.simulation !== 'boolean') {
          throw new Error('网页行程或模拟模式标记无效，请结束旧行程后重新开始');
        }
        return record;
      },
      setStorageSync: function (_, record) {
        requireStorage().setItem(TRIP_KEY, JSON.stringify(Object.assign({}, record,
          { pwaVersion: 1, simulation: simulation })));
      }
    };

    function invalidateStoredTrip() {
      try { requireStorage().removeItem(TRIP_KEY); return true; }
      catch (_) {
        // Some storage adapters permit overwriting while deletion fails. An explicit
        // tombstone is preferable to restoring a trip the user already ended.
        try {
          requireStorage().setItem(TRIP_KEY, JSON.stringify({ pwaVersion: 1, ended: true }));
          return true;
        } catch (_) { return false; }
      }
    }
    function save() {
      var result = field.saveTrip(adapter, trip, keys, now());
      if (result.ok) return publish({ ok: true, message: '行程和提醒状态已保存在本机。' });
      var cleared = invalidateStoredTrip();
      return publish({ ok: false, message: cleared
        ? '本机存储失败，已移除旧进度；本次仍可人工操作，刷新后不能保证恢复或提醒去重。'
        : '本机存储不可写；本次仍可人工操作，刷新后可能恢复旧进度或重复提醒，请重新核对站点。' });
    }
    function validate() {
      if (!trip) return { ok: false, message: '当前没有行程，请先选择站点。' };
      try {
        trip = field.validateRecoveryTrip(trip, { now: now() });
        return { ok: true, trip: copy(trip), simulation: simulation };
      } catch (error) {
        return { ok: false, message: error.message, code: error.code };
      }
    }
    function requireTrip() {
      var result = validate();
      if (!result.ok) fail(result.code || 'NO_ACTIVE_TRIP', result.message);
    }
    function restore() {
      if (endedInMemory) return { status: 'empty' };
      var result = field.readTrip(adapter, now());
      trip = null;
      keys = [];
      simulation = false;
      if (result.status === 'saved') {
        trip = result.saved.trip;
        keys = result.saved.reminderKeys.slice();
        simulation = result.saved.simulation;
        return { status: 'saved', trip: copy(trip), simulation: simulation };
      }
      if (result.status === 'invalid') {
        // Keep corrupt records intact for explicit user recovery; never silently
        // accept a partial record or fill in a missing simulation marker.
        result.message = result.message.replace('。请先保留诊断日志，再清除本机行程记录。',
          '。请结束旧行程后重新选择站点；不会静默恢复损坏或过期进度。');
        publish({ ok: false, message: result.message });
      }
      return result;
    }
    function create(input, mode) {
      mode = mode || {};
      if (mode.simulation !== undefined && typeof mode.simulation !== 'boolean') {
        fail('INVALID_SIMULATION_MODE', '请选择人工现场或独立模拟测试模式');
      }
      if (trip) fail('TRIP_ALREADY_ACTIVE', '请先结束当前行程，再创建新行程');
      trip = offline.createTrip(input, { now: now() });
      simulation = mode.simulation === true;
      keys = [];
      endedInMemory = false;
      save();
      return copy(trip);
    }
    function advance(expectedIndex, settings) {
      settings = settings || {};
      var source = settings.source === undefined ? 'manual' : settings.source;
      if (source !== 'manual' && source !== 'simulation') {
        fail('AUTOMATIC_PROGRESS_DISABLED', '定位、时间和传感器不能推进人工现场行程');
      }
      requireTrip();
      if (source === 'simulation' && !simulation) {
        fail('SIMULATION_DISABLED', '模拟推进只能用于独立模拟测试行程');
      }
      trip = offline.advanceTrip(trip, expectedIndex, { now: now() });
      save();
      return copy(trip);
    }
    function reminder(settings) {
      if (!trip || !validate().ok) return null;
      return reminders.decideReminder(trip, keys, settings || {});
    }
    function markReminder(key) {
      requireTrip();
      var normal = reminders.decideReminder(trip, [], {});
      var cautious = reminders.decideReminder(trip, [], { lowConfidence: true });
      if (typeof key !== 'string' || ![normal && normal.key, cautious && cautious.key].includes(key)) {
        fail('INVALID_REMINDER_KEY', '提醒标记不属于当前行程站点');
      }
      if (!keys.includes(key)) { keys.push(key); keys = keys.slice(-64); save(); }
      return true;
    }
    function end() {
      trip = null;
      keys = [];
      simulation = false;
      endedInMemory = true;
      var ok = invalidateStoredTrip();
      return publish({ ok: ok, message: ok ? '行程已结束，本机行程记录已清除。'
        : '行程已在当前页面结束，但本机存储不可写；刷新后可能出现旧行程，请手动结束并核对站点。' });
    }

    return { getLines: offline.getLines, create: create, advance: advance, restore: restore,
      current: function () { return copy(trip); }, reminder: reminder, markReminder: markReminder,
      end: end, validate: validate, isSimulation: function () { return simulation; } };
  }
  return { TRIP_KEY: TRIP_KEY, createTripStore: createTripStore };
}));
