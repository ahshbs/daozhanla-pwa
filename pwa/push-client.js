(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DaozhanPush = factory();
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'daozhanla.push.v1';
  const API = '/api/v1/push';
  function createPushClient(options = {}) {
    const env = options.env || globalThis;
    const nav = options.navigator || env.navigator || {};
    const notification = options.Notification || env.Notification;
    const storage = options.storage || env.localStorage;
    const fetcher = options.fetch || (env.fetch && env.fetch.bind(env));
    const onState = options.onState || (() => {});
    let apiBase = API, serviceScope = API, configurationError = '', serviceChanged = false;
    const configuredApi = options.apiBase ?? env.DAOZHAN_CONFIG?.pushApiBase;
    try {
      const location = env.location?.href || 'https://local.invalid/';
      const currentOrigin = new URL(location).origin;
      const configured = configuredApi === undefined || (typeof configuredApi === 'string' && !configuredApi.trim()) ? API : configuredApi;
      if (typeof configured !== 'string' || !configured.trim() || configured !== configured.trim()) throw new Error();
      const address = new URL(configured, location);
      if (address.username || address.password || address.search || address.hash || address.pathname.replace(/\/$/, '') !== API
        || (address.origin !== currentOrigin && address.protocol !== 'https:')
        || !['http:', 'https:'].includes(address.protocol)
        || (configured !== API && configured !== API + '/' && !/^https:\/\//.test(configured))) throw new Error();
      serviceScope = address.origin + API;
      apiBase = address.origin === currentOrigin ? API : serviceScope;
    } catch { configurationError = '通知服务地址配置无效，请联系维护者；尚未发送任何通知凭据。'; }
    let saved = { prompted: false, enabled: false, token: '', cancelPending: false, apiBase: serviceScope, needsResubscribe: false };
    let storageError = false, busy = false, connected = false, generation = 0;
    let job = { status: 'none' }, queue = Promise.resolve();
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (value && typeof value === 'object' && !configurationError) {
        const legacyScope = new URL(API, env.location?.href || 'https://local.invalid/').href;
        if ((value.apiBase || legacyScope) !== serviceScope) { serviceChanged = true; saved.needsResubscribe = true; }
        else saved = {
          prompted: value.prompted === true, enabled: value.enabled === true,
          token: typeof value.token === 'string' && /^[\w-]{43}$/.test(value.token) ? value.token : '',
          cancelPending: value.cancelPending === true, apiBase: serviceScope, needsResubscribe: value.needsResubscribe === true
        };
        serviceChanged ||= saved.needsResubscribe;
      }
    } catch { storageError = true; }
    let state = { code: 'off', message: '尚未开启系统通知', busy: false, connected: false, job };
    function capability() {
      if (configurationError) return { code: 'error', message: configurationError };
      const ios = /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
      const standalone = nav.standalone === true || env.matchMedia?.('(display-mode: standalone)').matches;
      if (env.isSecureContext !== true) return { code: 'insecure', message: '系统通知需要 HTTPS 网址，请使用正式安全链接打开。' };
      if (ios && !standalone) return { code: 'install', message: 'iPhone 请用 Safari 打开，点“分享 → 添加到主屏幕”，再从桌面图标进入开启通知（需要 iOS 16.4 或更新版本）。' };
      if (!notification || !nav.serviceWorker || !env.PushManager) return { code: 'unsupported', message: '当前浏览器不支持网页系统推送，请改用支持通知的浏览器；iPhone 请升级系统并从主屏幕打开。' };
      return null;
    }
    function publish(code, message) {
      state = { code, message, busy, connected, enabled: saved.enabled, apiBase: serviceScope, serviceChanged,
        permission: notification?.permission || 'unsupported', job: { ...job } };
      try { onState({ ...state }); } catch {}
      return state;
    }
    function persist() {
      try { storage.setItem(STORAGE_KEY, JSON.stringify(saved)); storageError = false; }
      catch { storageError = true; throw new Error('无法保存通知设置，暂不开启推送；请允许此网站使用本机存储后重试。'); }
    }
    function markPrompted() { if (configurationError) return false; saved.prompted = true; try { persist(); return true; } catch { return false; } }
    function shouldPrompt() { return !saved.prompted && !saved.enabled && notification?.permission !== 'denied' && notification?.permission !== 'granted'; }
    function inspect() {
      const blocked = capability();
      if (blocked) return publish(blocked.code, blocked.message);
      if (notification.permission === 'denied') { connected = false; return publish('denied', '通知权限已被拒绝。可在手机或浏览器的网站通知设置中修改；这里不会再次弹出系统请求。'); }
      if (saved.cancelPending) return publish('cancel-pending', '取消尚未同步，原预约仍可能发送。联网后会重试取消。');
      if (serviceChanged) return publish('service-changed', '通知服务已更换，请重新开启。旧预约不会转移；重新开启会先退订旧订阅。');
      if (connected) return publish('ready', '系统通知已开启；可接收已预约的提醒。');
      if (saved.enabled) return publish('unverified', '已保存通知设置，正在等待确认推送服务连接。');
      return publish('off', notification.permission === 'granted' ? '系统已允许通知，推送服务尚未接通。' : '尚未开启系统通知');
    }
    function token() {
      if (!saved.token) {
        const bytes = env.crypto.getRandomValues(new Uint8Array(32));
        saved.token = env.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        persist();
      }
      return saved.token;
    }
    async function request(path, method = 'GET', body, auth = true) {
      if (configurationError) throw new Error(configurationError);
      if (nav.onLine === false) throw new Error('当前离线，系统推送需要联网；本地人工行程仍可使用。');
      const headers = { Accept: 'application/json' };
      if (auth) headers.Authorization = 'Bearer ' + token();
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const controller = new env.AbortController();
      const timer = env.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetcher(apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(response.status === 404 || response.status === 503 ? '系统推送服务尚未接通，暂时无法预约页面外提醒。' : response.status === 409 ? '请先取消当前预约，再测试系统通知。' : '推送服务未确认本次操作，请稍后重试。');
        return data;
      } finally { env.clearTimeout(timer); }
    }
    async function registration() {
      // Do not hang forever on serviceWorker.ready when cache installation failed.
      const reg = await nav.serviceWorker.getRegistration();
      if (!reg?.active || !reg.pushManager) throw new Error('通知组件尚未准备好，请稍后重试；首次使用请保持联网。');
      return reg;
    }
    async function connect(epoch) {
      const config = await request('/config', 'GET', undefined, false);
      if (!config.enabled || typeof config.publicKey !== 'string') throw new Error('系统推送服务尚未接通，暂时无法预约页面外提醒。');
      if (epoch !== undefined && epoch !== generation) return false;
      const reg = await registration();
      if (serviceChanged) {
        const previous = await reg.pushManager.getSubscription();
        if (previous && !await previous.unsubscribe()) throw new Error('旧通知订阅未能关闭，请重试；旧预约仍可能发送。');
        if (epoch !== undefined && epoch !== generation) return false;
      }
      const encoded = config.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const key = Uint8Array.from(env.atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), char => char.charCodeAt(0));
      if (key.length !== 65) throw new Error('通知服务配置无效，请稍后重试。');
      const subscription = (!serviceChanged && await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (epoch !== undefined && epoch !== generation) return false;
      const raw = subscription.toJSON();
      // Only the push endpoint and encryption keys leave the browser. Never send a position or a route.
      const result = await request('/subscription', 'POST', { subscription: { endpoint: raw.endpoint, expirationTime: raw.expirationTime ?? null, keys: { p256dh: raw.keys?.p256dh, auth: raw.keys?.auth } } });
      if (result.enabled !== true) throw new Error('服务尚未确认通知订阅，请重试。');
      if (epoch !== undefined && epoch !== generation) return false;
      saved.enabled = true; saved.needsResubscribe = false; serviceChanged = false; persist(); connected = true;
      if (saved.cancelPending) await cancelRequest();
    }
    function enable() {
      // Called directly by the consent button: no await before the native permission prompt.
      if (busy) return Promise.resolve(state);
      const epoch = ++generation;
      const blocked = capability();
      if (blocked) return Promise.resolve(publish(blocked.code, blocked.message));
      if (!markPrompted()) return Promise.resolve(publish('error', '无法保存通知设置；请允许本机存储后重试。'));
      if (notification.permission === 'denied') return Promise.resolve(inspect());
      let permission;
      try {
        token();
        permission = notification.permission === 'granted' ? Promise.resolve('granted') : notification.requestPermission();
      } catch (error) { return Promise.resolve(publish('error', error.message)); }
      busy = true; publish('enabling', '请在系统提示中允许通知…');
      return Promise.resolve(permission).then(async result => {
        if (epoch !== generation) return publish('off', '系统推送已关闭。');
        if (result !== 'granted') { connected = false; return publish(result === 'denied' ? 'denied' : 'off', result === 'denied' ? '已拒绝通知；仍可使用前台提醒。' : '尚未同意通知；仍可使用前台提醒。'); }
        // Keep subscription writes and deletion in order, including a late POST response.
        const connectedNow = await serial(() => epoch === generation ? connect(epoch) : false);
        if (connectedNow === false || epoch !== generation) return publish('off', '系统推送已关闭。');
        return publish('ready', '系统通知已开启；可接收已预约的提醒。');
      }).catch(error => { connected = false; return publish('error', error.message); })
        .finally(() => { busy = false; publish(state.code, state.message); });
    }
    function serial(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; }
    async function cancelRequest() {
      if (!saved.token) return;
      await request('/reminder', 'DELETE');
      saved.cancelPending = false; job = { status: 'none' }; persist();
    }
    function cancel() {
      generation++;
      if (!saved.token || (!saved.enabled && !saved.cancelPending && job.status === 'none')) return Promise.resolve();
      saved.cancelPending = true;
      try { persist(); } catch {}
      return serial(async () => {
        try { await cancelRequest(); inspect(); }
        catch { publish('cancel-pending', '取消尚未同步，原预约仍可能发送。联网后会重试取消。'); }
      });
    }
    function disable() {
      generation++; saved.enabled = false; connected = false; saved.cancelPending = Boolean(saved.token);
      try { persist(); } catch {}
      return serial(async () => {
        let remoteCleared = !saved.token;
        try { if (saved.token) await request('/subscription', 'DELETE'); remoteCleared = true; } catch {}
        let localCleared = false;
        try { const sub = await (await registration()).pushManager.getSubscription(); localCleared = !sub || await sub.unsubscribe(); } catch {}
        saved.cancelPending = !remoteCleared; job = { status: 'none' }; try { persist(); } catch {}
        return publish(remoteCleared || localCleared ? 'off' : 'cancel-pending', remoteCleared ? '系统推送已关闭。' : localCleared ? '本机已退订；联网后将继续清除服务端预约。' : '关闭尚未完成，原预约仍可能发送。请联网重试。');
      });
    }
    function schedule(input) {
      const epoch = ++generation;
      // A allowlist intentionally excludes accuracy, latitude/longitude and raw trip data.
      const payload = { tripId: input.tripId, destination: input.destination, fireAt: input.fireAt, remindBefore: input.remindBefore };
      return serial(async () => {
        if (epoch !== generation) return null;
        if (!saved.enabled || !connected || notification.permission !== 'granted') throw new Error('请先开启系统通知，并确认推送服务已连接。');
        if (saved.cancelPending) await cancelRequest();
        const response = await request('/reminder', 'POST', payload);
        if (epoch !== generation) return null;
        if (response.status !== 'scheduled' || response.tripId !== payload.tripId || response.fireAt !== payload.fireAt) throw new Error('预约未被服务确认，请重试。');
        job = { status: response.status, tripId: response.tripId, fireAt: response.fireAt };
        publish('ready', '已预约系统通知。'); return { ...job };
      }).catch(error => { if (epoch === generation) publish('error', error.message); return null; });
    }
    function test() {
      const epoch = ++generation;
      return serial(async () => {
        try {
          if (epoch !== generation) return null;
          if (!saved.enabled || !connected || notification.permission !== 'granted') throw new Error('请先开启系统通知。');
          if (saved.cancelPending) await cancelRequest();
          const response = await request('/test', 'POST', {});
          if (epoch !== generation) return null;
          if (response.status !== 'scheduled' || !Number.isFinite(response.fireAt)) throw new Error('测试未被服务确认，请重试。');
          job = { status: 'scheduled', tripId: 'test', fireAt: response.fireAt };
          publish('ready', '已预约 15 秒后的测试通知，现在可以切到其他 App 查看。');
          return { ...job };
        } catch (error) { publish('error', error.message); return null; }
      });
    }
    async function refresh() {
      inspect();
      if (!saved.token || nav.onLine === false) return state;
      if (saved.cancelPending) {
        if (!saved.enabled) return disable();
        await cancel();
        if (saved.cancelPending) return state;
      }
      if (!saved.enabled || capability() || notification.permission !== 'granted') return state;
      if (busy) return state;
      const epoch = generation;
      return serial(async () => {
        if (epoch !== generation || !saved.enabled) return state;
        busy = true;
        try {
          // Reconnect existing subscriptions only; refreshing never asks permission or subscribes.
          const sub = await (await registration()).pushManager.getSubscription();
          if (epoch !== generation) return state;
          if (!sub) { connected = false; return publish('off', '通知订阅已失效，请点击重新开启。'); }
          const subscription = await request('/subscription');
          if (epoch !== generation) return state;
          if (subscription.enabled !== true) { connected = false; return publish('unverified', '通知服务尚未保存此设备订阅，请点击重新开启。'); }
          const response = await request('/reminder');
          if (epoch !== generation) return state;
          connected = true;
          job = ['none', 'scheduled', 'sent', 'expired', 'failed'].includes(response.status)
            ? { status: response.status, tripId: response.tripId, fireAt: response.fireAt } : { status: 'none' };
          return inspect();
        } catch (error) { connected = false; return publish('error', error.message); }
        finally { busy = false; publish(state.code, state.message); }
      });
    }
    inspect();
    return { enable, disable, schedule, test, cancel, refresh, inspect, capability, shouldPrompt, markPrompted, snapshot: () => ({ ...state }), storageKey: STORAGE_KEY };
  }
  return { createPushClient, STORAGE_KEY };
}));
