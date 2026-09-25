/* Browser entry, using the existing index UI and canonical offline core. */
'use strict';
const activeOscillators = new Set();
let effectsGeneration = 0, locationWanted = false, wakeLock = null, wakeGeneration = 0;
let swRegistration = null, foregroundPaused = false;
const effectStates = {};
const tripStore = DaozhanTrips.createTripStore({
  storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) },
  onStatus: status => { $('storageStatus').textContent = status.ok ? '' : status.message; }
});
const estimatedReminder = DaozhanEstimate.createEstimatedReminder({
  storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key) }
});
let estimateTimer = null;
const CORRECTION_STORAGE_PREFIX = 'daozhanla.field-corrections.v1.';
let correctionTripId = '', correctionRecords = [];

function correctionStorageKey(tripId) {
  return CORRECTION_STORAGE_PREFIX + encodeURIComponent(String(tripId));
}

function loadCorrectionRecords(trip) {
  correctionTripId = trip?.id || '';
  correctionRecords = [];
  if (!correctionTripId) return;
  try {
    const value = JSON.parse(localStorage.getItem(correctionStorageKey(correctionTripId)) || '[]');
    if (Array.isArray(value)) correctionRecords = value.filter(record => record && typeof record === 'object'
      && typeof record.from === 'string' && typeof record.to === 'string'
      && Number.isSafeInteger(record.confirmedAt) && Number.isSafeInteger(record.plannedSeconds)
      && Number.isSafeInteger(record.actualSeconds) && Number.isSafeInteger(record.deltaSeconds)).slice(-64);
  } catch {}
}

function saveCorrectionRecords() {
  if (!correctionTripId) return;
  try { localStorage.setItem(correctionStorageKey(correctionTripId), JSON.stringify(correctionRecords)); }
  catch { /* The trip itself remains usable when the optional log cannot be saved. */ }
}

function formatCorrectionDelta(seconds) {
  if (seconds === 0) return '与计划一致';
  return seconds > 0 ? `晚 ${seconds} 秒` : `早 ${Math.abs(seconds)} 秒`;
}

function formatCorrectionClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderCorrectionLog() {
  const summary = $('correctionSummary'), log = $('correctionLog');
  if (!summary || !log) return;
  log.replaceChildren();
  if (!correctionRecords.length) {
    summary.textContent = '尚未记录本次行程的实际站间用时。';
    return;
  }
  const totalDelta = correctionRecords.reduce((sum, record) => sum + record.deltaSeconds, 0);
  const averageDelta = Math.round(totalDelta / correctionRecords.length);
  const last = correctionRecords.at(-1);
  summary.textContent = `已记录 ${correctionRecords.length} 段；平均偏差 ${formatCorrectionDelta(averageDelta)}。最近一段 ${last.from} → ${last.to}：${formatCorrectionDelta(last.deltaSeconds)}。后续预计已按本次确认时间重算。`;
  correctionRecords.forEach((record, index) => {
    const line = document.createElement('p');
    line.textContent = `${index + 1}. ${record.from} → ${record.to} · 实际 ${record.actualSeconds} 秒 / 计划 ${record.plannedSeconds} 秒 · ${formatCorrectionDelta(record.deltaSeconds)} · ${formatCorrectionClock(record.confirmedAt)}`;
    log.append(line);
  });
}

function attachCorrectionLog(trip) {
  if (!trip?.id) return;
  if (correctionTripId !== trip.id) loadCorrectionRecords(trip);
  renderCorrectionLog();
}

function recordManualCorrection(before, after, confirmedAt) {
  if (!before || !after || before.status !== 'active' || before.currentIndex === after.currentIndex
    || !before.currentStation || !Number.isInteger(before.currentStation.secondsToNext)) return;
  const anchor = Date.parse(before.updatedAt);
  const plannedSeconds = before.currentStation.secondsToNext;
  const actualSeconds = Number.isSafeInteger(anchor) ? Math.max(0, Math.round((confirmedAt - anchor) / 1000)) : 0;
  const record = {
    from: before.currentStation.name,
    to: after.currentStation.name,
    confirmedAt,
    plannedSeconds,
    actualSeconds,
    deltaSeconds: actualSeconds - plannedSeconds
  };
  if (correctionTripId !== before.id) loadCorrectionRecords(before);
  correctionRecords.push(record);
  correctionRecords = correctionRecords.slice(-64);
  saveCorrectionRecords();
  renderCorrectionLog();
}

function clearEstimateTimer() { clearTimeout(estimateTimer); estimateTimer = null; }
function updateEstimatedStatus() {
  const state = estimatedReminder.snapshot();
  const clockTime = state.fireAt ? new Date(state.fireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  const minutes = Math.floor(Math.ceil(state.remainingMs / 1000) / 60), seconds = Math.ceil(state.remainingMs / 1000) % 60;
  const messages = {
    off: '前台预计提醒未开启；人工过站提醒仍可使用。',
    simulation: '模拟行程只使用独立演示推进，不计算真实行程的预计时间。',
    complete: '本次行程已人工确认到达，前台计时已结束。',
    scheduled: `预计 ${clockTime} 提醒，还剩 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒；不是实时到站。`,
    due: '预计提醒时间已到，正在准备提示；请核对广播和站牌。',
    delivered: '已展示本次预计提醒。请核对广播和站牌，经过车站后人工校正。',
    expired: '预计提醒时间已过或计时中断；请核对当前车站，并在经过下一站后人工校正。不会补发过期到站提示。',
    range: '按人工确认的进度已进入提醒范围；请直接留意广播和站牌。'
  };
  $('localEstimateStatus').textContent = (messages[state.status] || messages.off)
    + (state.enabled && document.hidden && state.status === 'scheduled' ? ' 页面在后台，本地提醒暂停。' : '')
    + (state.storageOk ? '' : ' 本机存储失败，刷新后无法保证恢复和提醒去重。');
  $('localEstimateStatus').dataset.warning = String(state.status === 'expired' || !state.storageOk);
  $('localEstimateToggle').textContent = state.enabled ? '关闭前台预计提醒' : '开启前台预计提醒';
  $('localEstimateToggle').disabled = !currentTrip || currentTrip.status !== 'active' || tripStore.isSimulation();
}
function scheduleEstimateTick() {
  clearEstimateTimer();
  if (document.hidden || foregroundPaused || !['scheduled', 'due'].includes(estimatedReminder.snapshot().status)) return;
  estimateTimer = setTimeout(runEstimateTick, 1000);
}
function runEstimateTick({ resumed = false } = {}) {
  clearEstimateTimer();
  if (!currentTrip || document.hidden || foregroundPaused) return;
  const state = estimatedReminder.check({ resumed });
  updateEstimatedStatus();
  if (state.status === 'due' && $('arrivalModalLayer').hidden) {
    openArrivalModal({ ...currentTrip, estimateKey: state.key, alertTitle: '预计临近，请核对车站',
      alertMessage: `按开始行程或最近人工过站的时间估算，可能即将到达「${state.destination}」。这不是实时到站，也不会自动更新站点；请以广播和站牌为准。` });
  }
  scheduleEstimateTick();
}
function startEstimatedReminder(trip) {
  estimatedReminder.attach(trip, { enabled: $('useLocalReminder').checked, simulation: tripStore.isSimulation() });
  scheduleEstimateTick();
}
function restoreEstimatedReminder(trip) {
  estimatedReminder.attach(trip, { simulation: tripStore.isSimulation(), restore: true });
  scheduleEstimateTick();
}
function stopEstimatedReminder() { clearEstimateTimer(); estimatedReminder.end(); updateEstimatedStatus(); }
$('localEstimateToggle').onclick = () => {
  if (!currentTrip || tripStore.isSimulation()) return;
  prepareAlertAudio();
  estimatedReminder.attach(currentTrip, { enabled: !estimatedReminder.snapshot().enabled, restore: true });
  updateEstimatedStatus(); scheduleEstimateTick();
};

function setEffectStatus(kind, text) {
  effectStates[kind] = text;
  $('effectStatus').textContent = Object.values(effectStates).join('；');
}
function stopAlertEffects() {
  effectsGeneration++;
  clearTimeout(arrivalSoundTimer); arrivalSoundTimer = null;
  for (const oscillator of activeOscillators) { try { oscillator.stop(); } catch {} }
  activeOscillators.clear();
  try { if (navigator.vibrate) navigator.vibrate(0); } catch {}
}
async function requestWakeLock() {
  if (document.hidden || currentTrip?.status !== 'active' || wakeLock) return;
  const generation = ++wakeGeneration;
  if (!navigator.wakeLock?.request) { $('wakeStatus').textContent = '此浏览器不支持保持亮屏，请手动保持屏幕亮起。'; return; }
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (generation !== wakeGeneration || document.hidden || currentTrip?.status !== 'active') { await lock.release(); return; }
    wakeLock = lock;
    $('wakeStatus').textContent = '已请求保持亮屏；系统仍可能中断，请保持前台。';
    lock.addEventListener('release', () => { if (wakeLock === lock) { wakeLock = null; $('wakeStatus').textContent = '亮屏请求已释放，请保持屏幕亮起。'; } });
  } catch { $('wakeStatus').textContent = '无法保持亮屏，请手动保持屏幕亮起；人工行程仍可用。'; }
}
function releaseWakeLock() {
  wakeGeneration++;
  const lock = wakeLock; wakeLock = null;
  if (lock) Promise.resolve(lock.release()).catch(() => {});
}

const locationLabels = {
  idle: '尚未启用前台定位', waiting: '等待前台定位样本…', normal: '定位质量正常（不代表已确定所在车站）',
  unstable: '定位不准确：连续低质量，请留意站牌并人工校正', interrupted: '定位中断：超过 15 秒没有新回调，请人工核对',
  paused: '定位已暂停；返回前台后重新监听', denied: '定位权限被拒绝；人工行程可继续，可在 Safari 设置中修改权限',
  unsupported: '浏览器不支持定位；人工行程可继续', insecure: '定位需要 HTTPS；人工行程可继续',
  timeout: '定位请求超时；等待新样本或点击重试', unavailable: '暂时无法获取位置；人工行程可继续', error: '定位失败；人工行程可继续'
};
const locationController = DaozhanLocation.createLocationController({
  geolocation: navigator.geolocation, isSecureContext: window.isSecureContext,
  onState(state) {
    $('foregroundLocationState').textContent = locationLabels[state.state] || '定位暂不可用';
    $('locationAccuracy').textContent = Number.isFinite(state.accuracy) ? `系统报告精度：±${Math.round(state.accuracy)} 米；仅为质量参考` : '';
    $('locationStatus').textContent = state.active ? '观察中' : '未监听';
    $('locationToggleBtn').textContent = state.active ? '暂停定位观察' : '启用 / 重试前台定位';
  },
  onAlert() {
    if (document.hidden || !currentTrip || tripStore.isSimulation() || !$('arrivalModalLayer').hidden || activePickerSelect) return false;
    const tripId = currentTrip.id;
    const nextAlert = tripStore.reminder({ lowConfidence: true });
    openArrivalModal({ ...currentTrip, alertTitle: '定位不准确，请留意车厢广播',
      alertMessage: nextAlert ? nextAlert.message : '连续定位样本精度不足。当前不会自动判断过站，请确认站牌后使用“我刚刚经过一站”。',
      reminderKey: nextAlert?.key });
    return new Promise(resolve => requestAnimationFrame(() => resolve(!document.hidden && currentTrip?.id === tripId && !$('arrivalModalLayer').hidden)));
  }
});
function updatePwaTripUI() {
  const simulation = Boolean(currentTrip && tripStore.isSimulation());
  $('tripWorkMode').textContent = simulation ? '模拟测试行程 / 非真实位置' : '本地人工进度 / 定位观察可选';
  document.querySelector('.simulation-control').hidden = !simulation;
  $('locationToggleBtn').disabled = !currentTrip || currentTrip.status !== 'active' || simulation;
  $('updateAppBtn').disabled = Boolean(currentTrip);
  if (simulation) { $('foregroundLocationState').textContent = '模拟行程禁止启动真实定位'; $('locationAccuracy').textContent = ''; }
  if(isSilentMode())$('effectStatus').textContent='静音模式：仅弹窗，不请求声音或震动';
}
function toggleForegroundLocation() {
  if (!currentTrip || currentTrip.status !== 'active') { toast('请先开始行程'); return; }
  if (tripStore.isSimulation()) { toast('模拟行程不启用真实定位'); return; }
  if (locationController.snapshot().active) { locationWanted = false; locationController.pause(); return; }
  if (!window.confirm('仅在前台获取位置，用于本机即时判断定位质量；不保存原始经纬度或轨迹、不上传。坐标尚未核验，不自动过站。是否同意并启用？')) return;
  prepareAlertAudio(); locationWanted = true; locationController.start(currentTrip.id); requestWakeLock();
}
function pauseForeground() {
  foregroundPaused = true;
  clearEstimateTimer(); updateEstimatedStatus();
  locationController.pause();
  if(arrivalTrip && !arrivalTrip.presented) closeArrivalModal({restoreFocus:false});
  if (simulationRunning) pauseSimulation({ statusKey: 'simulationPausedHidden' });
  stopAlertEffects(); releaseWakeLock();
}
function resumeForeground() {
  if (document.hidden) return;
  const wasPaused = foregroundPaused;
  foregroundPaused = false;
  if (!currentTrip) return;
  try { DaozhanCore.fieldStorage.validateRecoveryTrip(currentTrip); }
  catch (error) { locationWanted = false; locationController.stop(); pauseSimulation(); void endCurrentTrip(); $('storageStatus').textContent = error.message; return; }
  if (locationWanted && !tripStore.isSimulation() && currentTrip.status === 'active') locationController.resume();
  requestWakeLock();
  showTripAlert(currentTrip);
  runEstimateTick({ resumed: wasPaused });
}

async function setupOfflineCache() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { $('cacheStatus').textContent = '离线安装需要 HTTPS（电脑本地 localhost 可预览）。本页未确认离线缓存。'; return; }
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const showUpdate = () => {
      if (swRegistration.waiting) { $('updateAppBtn').hidden = false; updatePwaTripUI(); $('cacheStatus').textContent = '有新版本等待；不会刷新进行中的行程。结束后可主动更新。'; }
    };
    swRegistration.addEventListener('updatefound', () => {
      const worker = swRegistration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') showUpdate(); if (worker.state === 'redundant') $('cacheStatus').textContent = '本次缓存未完成，请联网重新打开。'; });
    });
    await navigator.serviceWorker.ready;
    $('cacheStatus').textContent = '离线缓存已完成，可离线重新打开基本功能（系统清理网站数据后需重新联网）。';
    showUpdate();
  } catch { $('cacheStatus').textContent = '离线缓存失败，当前未保证离线重开；请联网重新打开。'; }
}
$('updateAppBtn').onclick = () => {
  if (currentTrip) { toast('请先结束行程再更新'); return; }
  if (!swRegistration?.waiting) return;
  $('startBtn').disabled = true;
  const worker = swRegistration.waiting;
  worker.addEventListener('statechange', () => {
    // User initiated only; never force a refresh while there is a trip.
    if (worker.state === 'activated' && !currentTrip) window.location.reload();
    if (worker.state === 'redundant') { $('startBtn').disabled = false; $('cacheStatus').textContent = '更新失败，保留当前版本，请稍后重试。'; }
  });
  worker.postMessage({ type: 'SKIP_WAITING', tripActive: false });
};

Object.assign(dictionaries['zh-CN'], {
  adjustAnytime: '开始前可调整',
  tripCreated: '本机行程已创建，请核对车站并人工过站', staticManualProgress: '本地人工进度 / 非实时', staticSimulationProgress: '模拟测试 / 非真实位置',
  backendOffline: '本地线路加载失败', mediumConfidence: '人工确认进度', manualConfidenceReason: '定位只观察质量，不自动过站；计划时间不是实时 ETA',
  homeConfidence: '不依赖 GPS 的预计时间提醒 + 人工过站校正；不是实时列车位置。', tripRestored: '已恢复上次行程，请核对当前站',
  locationPermissionHint: '行程中主动启用或暂停前台定位', backgroundLockHint: '仅支持网页前台提醒，不保证后台、锁屏或系统级闹钟必达。',
  arrivalModalMessage: '行程记录已到目标站，请结合车厢广播和站牌确认。',
  howItWorksBody: '前台预计提醒按行程开始或最近人工过站的时间，加上站间计划用时计算；可离线使用，不需要 GPS。页面离开后本地提醒暂停，错过时间须核对车站。系统预计通知需另外预约、联网并允许通知。定位只观察质量，不自动过站；预计提醒不代表实际到站。',
  previewArrival: '测试提醒（不改变进度）', locationDataHint: '原始位置仅在本机即时处理；不上传、不保存轨迹',
  notificationPermission: '系统通知', notificationPermissionHint: '开启后可预约离开页面时的预计提醒', notificationPausedHint: '静音模式取消系统预约',
  backgroundLockHint: '预约成功后可接收系统预计提醒；需要联网，受系统通知设置影响。不是实时到站。', foregroundFirst: '预计提醒',
  connecting: '正在加载内置线路…', localMode: 'PWA 本地版', helpToast: '请保持前台和屏幕亮起，经过车站后人工确认；自动过站尚不可用'
});
Object.assign(dictionaries.en, { tripCreated: 'Local trip created; confirm each station manually', staticManualProgress: 'Local manual progress; not live',
  adjustAnytime: 'Adjust before starting',
  staticSimulationProgress: 'Simulation test; not real position', mediumConfidence: 'Manual progress',
  backgroundLockHint: 'Foreground web alerts only. No background, lock-screen or system alarm guarantee.',
  arrivalModalMessage: 'Trip record reached the target. Check station signs and announcements.',
  previewArrival: 'Test alert (no progress change)', manualConfidenceReason: 'Location quality observation only; no automatic station advance',
  notificationPermission: 'System notifications', notificationPermissionHint: 'Enable scheduled alerts outside the app', backgroundLockHint: 'Scheduled system alerts need a network connection and system permission. These are estimates, not live arrivals.', foregroundFirst: 'Estimated',
  homeConfidence: 'GPS-free time estimates + manual station confirmation; not live train tracking',
  howItWorksBody: 'Foreground estimates use the trip start or latest manual station confirmation plus scheduled travel time, without GPS or a network connection. Local alerts pause outside the page. System estimates need a separate reservation and network access. Neither changes station progress or confirms actual arrival.' });
$('locationToggleBtn').onclick = toggleForegroundLocation;
$('locationPermission').onclick = toggleForegroundLocation;
$('notificationPermission').onclick = () => toast('只使用前台弹窗；不保证后台、锁屏提醒');
$('notificationStatus').textContent = '仅前台';
$('clearLocalTripBtn').onclick = () => { if (window.confirm('清除本机当前行程与已展示提醒状态？偏好不删除；本应用不保存定位轨迹。')) void endCurrentTrip(); };
$('simulationEntry').onchange = () => { const simulation = $('simulationEntry').checked; $('enableForegroundLocation').disabled = simulation; $('useLocalReminder').disabled = simulation; $('useSystemReminder').disabled = simulation; if (simulation) { $('enableForegroundLocation').checked = false; $('useSystemReminder').checked = false; } };
document.addEventListener('visibilitychange', () => document.hidden ? pauseForeground() : resumeForeground());
window.addEventListener('pagehide', pauseForeground);
window.addEventListener('pageshow', resumeForeground);

// Optional page-external reminders. The browser remains the source of the local
// trip; this client only schedules a bounded estimate with the configured push
// service. It never sends coordinates, accuracy, or a route.
const PUSH_TRIP_KEY = 'daozhanla.push-trip.v1';
let armedPush = null, notificationReturnFocus = null;
let pushState = { code: 'off', connected: false, enabled: false, job: { status: 'none' } };
try {
  const record = JSON.parse(localStorage.getItem(PUSH_TRIP_KEY) || 'null');
  if (record && typeof record.tripId === 'string' && Number.isSafeInteger(record.fireAt)) armedPush = record;
} catch {}
function saveArmedPush() {
  try {
    if (armedPush) localStorage.setItem(PUSH_TRIP_KEY, JSON.stringify(armedPush));
    else localStorage.removeItem(PUSH_TRIP_KEY);
    return true;
  } catch { $('pushTripStatus').textContent = '无法保存系统提醒设置；请允许本机存储后重试。'; return false; }
}
function updatePushTripStatus() {
  const status = $('pushTripStatus');
  if (!status) return;
  const job = pushState.job || {};
  let message = '本次尚未预约系统提醒。';
  if (pushState.code === 'cancel-pending') message = pushState.message;
  else if (pushState.serviceChanged) message = pushState.message;
  else if (currentTrip && tripStore.isSimulation()) message = '模拟行程不预约真实到站通知；可在设置里测试系统通知。';
  else if (isSilentMode()) message = '静音模式仅显示应用内弹窗，系统预约已暂停。';
  else if (currentTrip && job.tripId === currentTrip.id && job.status === 'scheduled') {
    message = `预计 ${new Date(job.fireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 发送提醒 · 不是实时到站。`;
  } else if (currentTrip && job.tripId === currentTrip.id && job.status === 'sent') {
    message = '预计提醒已交给推送服务；请确认手机通知并核对站牌。';
  } else if (currentTrip && job.tripId === currentTrip.id && job.status === 'expired') {
    message = '本次预约已过期，不再补发；请核对当前车站。';
  } else if (currentTrip && job.tripId === currentTrip.id && job.status === 'failed') {
    message = '系统预计提醒发送失败，请保持页面前台并核对广播和站牌；可联网重试预约。';
  } else if (['error', 'unverified'].includes(pushState.code)) message = pushState.message;
  status.textContent = message;
  status.dataset.warning = String(pushState.code === 'cancel-pending' || pushState.serviceChanged || job.status === 'failed');
  const canSchedule = Boolean(currentTrip && currentTrip.status === 'active' && !tripStore.isSimulation() && !isSilentMode());
  $('schedulePushBtn').disabled = !canSchedule;
  $('schedulePushBtn').textContent = job.tripId === currentTrip?.id && job.status === 'scheduled' ? '更新预计时间' : '预约预计提醒';
  $('cancelPushBtn').hidden = !(armedPush || job.status === 'scheduled' || pushState.code === 'cancel-pending');
}
function displayPushState(state) {
  pushState = state;
  if (state.serviceChanged) { armedPush = null; saveArmedPush(); $('useSystemReminder').checked = false; }
  const labels = { ready: '已连接', enabling: '开启中', install: '需安装', insecure: '需 HTTPS', unsupported: '不支持', denied: '已拒绝', error: '未连接', 'cancel-pending': '待取消', unverified: '待确认', off: '未开启' };
  $('notificationStatus').textContent = labels[state.code] || '未开启';
  $('notificationStatus').className = `status-pill ${state.connected ? 'ok' : ''}`;
  $('pushSettingsStatus').textContent = state.message;
  $('notificationPromptStatus').textContent = state.message;
  $('notificationEnableBtn').disabled = state.busy || ['insecure', 'install', 'unsupported', 'denied'].includes(state.code);
  $('notificationEnableBtn').textContent = state.busy ? '正在开启…' : state.connected ? '已开启通知' : state.permission === 'granted' ? '连接通知服务' : '开启系统通知';
  $('testPushBtn').disabled = !state.connected || state.busy || isSilentMode();
  $('disablePushBtn').hidden = !state.enabled && !['cancel-pending', 'unverified'].includes(state.code);
  updatePushTripStatus();
}
const pushClient = DaozhanPush.createPushClient({ onState: displayPushState });
function showNotificationPrompt() {
  if (!$('notificationLayer').hidden || !$('arrivalModalLayer').hidden || activePickerSelect || document.hidden) return;
  pushClient.markPrompted();
  pushClient.inspect();
  notificationReturnFocus = document.activeElement;
  $('notificationLayer').hidden = false; setAppInert(true, 'notificationLayer');
  ($('notificationEnableBtn').disabled ? $('notificationLaterBtn') : $('notificationEnableBtn')).focus();
}
function closeNotificationPrompt({ restoreFocus = true } = {}) {
  if ($('notificationLayer').hidden) return;
  $('notificationLayer').hidden = true; setAppInert(false);
  if (restoreFocus && $('arrivalModalLayer').hidden && !activePickerSelect && notificationReturnFocus?.isConnected && !notificationReturnFocus.disabled) notificationReturnFocus.focus();
  notificationReturnFocus = null;
}
async function scheduleCurrentPush() {
  const trip = currentTrip;
  if (!trip || trip.status !== 'active' || tripStore.isSimulation() || isSilentMode()) { updatePushTripStatus(); return; }
  if (!pushState.connected) { showNotificationPrompt(); return; }
  const fireAt = DaozhanEstimate.planFor(trip)?.fireAt;
  const now = Date.now();
  if (!Number.isSafeInteger(fireAt) || fireAt < now + 5000 || fireAt > now + 4 * 60 * 60 * 1000) {
    await cancelPushTrip();
    $('pushTripStatus').textContent = '计划提醒时间已到或不在可预约范围，请确认当前车站后再预约。';
    return;
  }
  armedPush = { tripId: trip.id, fireAt };
  if (!saveArmedPush()) { armedPush = null; return; }
  $('pushTripStatus').textContent = '正在预约，请等待服务确认…';
  const result = await pushClient.schedule({ tripId: trip.id, destination: trip.route.at(-1).name, fireAt, remindBefore: trip.remindBefore });
  if (!result && currentTrip?.id === trip.id) $('pushTripStatus').textContent = `${pushClient.snapshot().message} 本次未确认预约成功。`;
}
async function cancelPushTrip() {
  armedPush = null; saveArmedPush();
  await pushClient.cancel();
  updatePushTripStatus();
}
async function reconcilePush() {
  await pushClient.refresh();
  const job = pushClient.snapshot().job;
  if (job?.status === 'scheduled' && job.tripId !== 'test' && (!currentTrip || currentTrip.id !== job.tripId || currentTrip.status !== 'active' || isSilentMode() || !armedPush)) await cancelPushTrip();
  updatePushTripStatus();
}
$('notificationPermission').onclick = showNotificationPrompt;
$('notificationLaterBtn').onclick = closeNotificationPrompt;
$('notificationEnableBtn').onclick = () => {
  // This call stays directly in the click handler for iOS's user-gesture rule.
  void pushClient.enable().then(state => {
    if (state.connected) {
      closeNotificationPrompt();
      $('useSystemReminder').checked = true;
      toast('系统通知已开启，可为本次行程预约预计提醒。');
      if (currentTrip && $('useSystemReminder').checked) void scheduleCurrentPush();
    }
  });
};
$('notificationLaterBtn').onclick = closeNotificationPrompt;
$('notificationLayer').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeNotificationPrompt(); return; }
  if (event.key !== 'Tab') return;
  const buttons = [$('notificationEnableBtn'), $('notificationLaterBtn')].filter(button => !button.disabled);
  const index = buttons.indexOf(document.activeElement);
  if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1).focus(); }
  else if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0].focus(); }
};
$('schedulePushBtn').onclick = () => void scheduleCurrentPush();
$('cancelPushBtn').onclick = () => void cancelPushTrip();
$('testPushBtn').onclick = () => { if (!isSilentMode()) void pushClient.test().then(result => { if (result) $('pushSettingsStatus').textContent = '已预约 15 秒后的测试通知，现在可以切到其他 App 查看。'; }); };
$('disablePushBtn').onclick = () => { armedPush = null; saveArmedPush(); $('useSystemReminder').checked = false; void pushClient.disable(); };
$('useSystemReminder').onchange = () => { if ($('useSystemReminder').checked) { if (currentTrip) void scheduleCurrentPush(); else showNotificationPrompt(); } else void cancelPushTrip(); };

// Existing handlers are retained; these wrappers keep a system estimate in sync
// after the user manually confirms a station or switches reminder mode.
const originalAdvanceCurrentTrip = advanceCurrentTrip;
advanceCurrentTrip = async function (source) {
  const before = currentTrip;
  const confirmedAt = Date.now();
  await originalAdvanceCurrentTrip(source);
  if (currentTrip?.id === before?.id && currentTrip?.currentIndex !== before?.currentIndex) {
    attachCorrectionLog(currentTrip);
    if (source === 'manual') recordManualCorrection(before, currentTrip, confirmedAt);
    estimatedReminder.attach(currentTrip, { simulation: tripStore.isSimulation() });
    updateEstimatedStatus(); scheduleEstimateTick();
    if (currentTrip.status === 'arrived') await cancelPushTrip();
    else if (armedPush?.tripId === currentTrip.id) await scheduleCurrentPush();
  }
  updatePushTripStatus();
};
const originalSetAlertMode = setAlertMode;
setAlertMode = function (mode) { originalSetAlertMode(mode); if (mode === 'silent') void cancelPushTrip(); displayPushState(pushState); };
const originalRenderTrip = renderTrip;
renderTrip = function (trip) { originalRenderTrip(trip); attachCorrectionLog(trip); updatePushTripStatus(); updateEstimatedStatus(); };
window.addEventListener('online', () => void reconcilePush());
window.addEventListener('pageshow', () => void reconcilePush());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void reconcilePush(); });
// Initialize only once every optional controller and modal callback is ready;
// restore can synchronously render a trip and its pending manual reminder.
$('releaseVersion').textContent = window.DAOZHAN_CONFIG?.release || '2026.09.23-integrated';
setupMobileSelects(); applyTheme(); applyLanguage(); updateSwitches(); loadData(); setupOfflineCache();
setTimeout(() => {
  void reconcilePush();
  if (!currentTrip && pushClient.shouldPrompt()) showNotificationPrompt();
}, 700);
