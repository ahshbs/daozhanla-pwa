(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../miniprogram/utils/location-health.js'));
  } else {
    root.DaozhanLocation = factory(root.DaozhanCore && root.DaozhanCore.locationHealth);
  }
}(typeof globalThis === 'object' ? globalThis : this, function (healthModule) {
  'use strict';

  // Positions are deliberately reduced to accuracy at the browser boundary.
  // Unknown station coordinates must never be projected or advance a trip here.
  function createLocationController(options) {
    options = options || {};
    var geolocation = options.geolocation === undefined
      ? (typeof navigator === 'object' ? navigator.geolocation : null) : options.geolocation;
    var createHealth = options.createHealth || (healthModule && healthModule.createLocationHealth);
    if (typeof createHealth !== 'function') throw new Error('Location health module is required');
    var now = options.now || Date.now;
    var schedule = options.setInterval || options.setIntervalFn || globalThis.setInterval.bind(globalThis);
    var unschedule = options.clearInterval || options.clearIntervalFn || globalThis.clearInterval.bind(globalThis);
    var secure = options.isSecureContext === undefined
      ? (options.secureContext === undefined ? globalThis.isSecureContext !== false : options.secureContext)
      : options.isSecureContext;
    var onState = options.onState || function () {};
    var onAlert = options.onAlert || function () { return false; };
    var health = createHealth({ now: now });
    var tripId = null;
    var active = false;
    var paused = false;
    var blocked = false;
    var destroyed = false;
    var generation = 0;
    var watchId = null;
    var timerId = null;
    var override = 'idle';
    var errorCode = null;
    var lastReceivedAt = null;
    var presenting = false;
    var presentationId = 0;

    function snapshot() {
      var quality = health.snapshot();
      return {
        state: override || quality.state,
        healthState: quality.state,
        tripId: tripId,
        active: active,
        paused: paused,
        accuracy: quality.accuracy,
        unstable: quality.unstable,
        lowCount: quality.lowCount,
        goodCount: quality.goodCount,
        lastReceivedAt: lastReceivedAt,
        errorCode: errorCode,
        locationAutoAdvance: false
      };
    }

    function emit() {
      var state = snapshot();
      // A rendering failure must not strand a browser watcher or timer.
      try { onState(state); } catch (_) {}
      return state;
    }

    function retryAlert() {
      if (!active || presenting || !health.takeAlert({ deferCommit: true })) return false;
      var alertHealth = health;
      var alertGeneration = generation;
      presenting = true;
      var accepted = false;
      var id = ++presentationId;
      function settle(value) {
        if (id !== presentationId) return false;
        presenting = false;
        if (value === true && active && alertGeneration === generation) alertHealth.confirmAlert();
        else alertHealth.cancelAlert();
        return value === true;
      }
      try {
        accepted = onAlert({
          kind: 'location-quality',
          title: '定位不准确',
          message: '连续定位精度较低，请查看车内报站并人工校正。当前定位仅观察，不会自动推进。',
          tripId: tripId,
          accuracy: health.snapshot().accuracy
        });
      } catch (_) {
        accepted = false;
      }
      if (accepted && typeof accepted.then === 'function') {
        Promise.resolve(accepted).then(settle, function () { settle(false); });
        return false;
      }
      return settle(accepted);
    }

    function clearResources() {
      generation += 1;
      presentationId += 1;
      presenting = false;
      active = false;
      if (watchId !== null) {
        try { geolocation.clearWatch(watchId); } catch (_) {}
        watchId = null;
      }
      if (timerId !== null) {
        unschedule(timerId);
        timerId = null;
      }
      health.cancelAlert();
      health.stop();
    }

    function begin() {
      if (active || destroyed || !tripId) return snapshot();
      paused = false;
      errorCode = null;
      if (!secure) {
        override = 'insecure';
        blocked = true;
        return emit();
      }
      if (!geolocation || typeof geolocation.watchPosition !== 'function'
        || typeof geolocation.clearWatch !== 'function') {
        override = 'unsupported';
        blocked = true;
        return emit();
      }
      active = true;
      override = null;
      health.start();
      var token = ++generation;
      emit();
      try {
        var newWatchId = geolocation.watchPosition(function (position) {
          if (!active || token !== generation) return;
          override = null;
          errorCode = null;
          lastReceivedAt = now();
          health.sample({ accuracy: position && position.coords && position.coords.accuracy });
          emit();
          retryAlert();
        }, function (error) {
          if (!active || token !== generation) return;
          var code = error && error.code;
          errorCode = code === 1 || code === 2 || code === 3 ? code : null;
          if (code === 1) {
            clearResources();
            blocked = true;
            override = 'denied';
          } else {
            override = code === 3 ? 'timeout' : 'unavailable';
          }
          emit();
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
        // Test doubles (and unusual implementations) may synchronously deny.
        if (!active || token !== generation) {
          try { geolocation.clearWatch(newWatchId); } catch (_) {}
          return snapshot();
        }
        watchId = newWatchId;
        timerId = schedule(function () {
          if (!active || token !== generation) return;
          health.checkTimeout();
          emit();
        }, 1000);
      } catch (error) {
        clearResources();
        override = error && error.name === 'SecurityError' ? 'denied' : 'unavailable';
        blocked = override === 'denied';
        errorCode = blocked ? 1 : null;
        emit();
      }
      return snapshot();
    }

    function start(nextTripId) {
      if (destroyed) return snapshot();
      if (typeof nextTripId !== 'string' || !nextTripId.trim()) throw new TypeError('A trip ID is required');
      if (tripId === nextTripId && active) return snapshot();
      if (tripId !== nextTripId) {
        clearResources();
        health = createHealth({ now: now });
        lastReceivedAt = null;
      }
      tripId = nextTripId;
      blocked = false;
      return begin();
    }

    function stop() {
      clearResources();
      tripId = null;
      paused = false;
      blocked = false;
      override = 'idle';
      errorCode = null;
      lastReceivedAt = null;
      return emit();
    }

    function pause() {
      if (!tripId || destroyed) return snapshot();
      clearResources();
      paused = true;
      if (!blocked) override = 'paused';
      return emit();
    }

    function resume() {
      // A rejected permission must not generate a new prompt on each tab focus.
      if (!paused || blocked || destroyed) return snapshot();
      return begin();
    }

    function destroy() {
      stop();
      destroyed = true;
      return snapshot();
    }

    return { start: start, stop: stop, pause: pause, resume: resume, destroy: destroy,
      snapshot: snapshot, retryAlert: retryAlert };
  }

  return { createLocationController: createLocationController };
}));
