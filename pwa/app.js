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
  $('tripWorkMode').textContent = simulation ? '模拟测试行程 / 非真实位置' : '本地人工进度 / 真实前台定位观察';
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
  locationController.pause();
  if(arrivalTrip && !arrivalTrip.presented) closeArrivalModal({restoreFocus:false});
  if (simulationRunning) pauseSimulation({ statusKey: 'simulationPausedHidden' });
  stopAlertEffects(); releaseWakeLock();
}
function resumeForeground() {
  if (document.hidden || !currentTrip) return;
  foregroundPaused = false;
  try { DaozhanCore.fieldStorage.validateRecoveryTrip(currentTrip); }
  catch (error) { locationWanted = false; locationController.stop(); pauseSimulation(); void endCurrentTrip(); $('storageStatus').textContent = error.message; return; }
  if (locationWanted && !tripStore.isSimulation() && currentTrip.status === 'active') locationController.resume();
  requestWakeLock();
  showTripAlert(currentTrip);
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
  tripCreated: '本机行程已创建，请核对车站并人工过站', staticManualProgress: '本地人工进度 / 非实时', staticSimulationProgress: '模拟测试 / 非真实位置',
  backendOffline: '本地线路加载失败', mediumConfidence: '人工确认进度', manualConfidenceReason: '定位只观察质量，不自动过站；计划时间不是实时 ETA',
  homeConfidence: '前台定位观察 + 人工过站；定位不代表实时列车位置。', tripRestored: '已恢复上次行程，请核对当前站',
  locationPermissionHint: '行程中主动启用或暂停前台定位', backgroundLockHint: '仅支持网页前台提醒，不保证后台、锁屏或系统级闹钟必达。',
  arrivalModalMessage: '行程记录已到目标站，请结合车厢广播和站牌确认。',
  howItWorksBody: '持续前台定位用于质量观察。站点坐标系待核验，禁止定位自动过站。按人工确认进度显示计划剩余时长并提醒；不提供实时 ETA、后台或锁屏闹钟。',
  previewArrival: '测试提醒（不改变进度）', locationDataHint: '原始位置仅在本机即时处理；不上传、不保存轨迹',
  notificationPermission: '前台提醒边界', notificationPermissionHint: '无需通知权限；不依赖后台推送', notificationPausedHint: '静音仅弹窗；无后台通知',
  connecting: '正在加载内置线路…', localMode: 'PWA 本地版', helpToast: '请保持前台和屏幕亮起，经过车站后人工确认；自动过站尚不可用'
});
Object.assign(dictionaries.en, { tripCreated: 'Local trip created; confirm each station manually', staticManualProgress: 'Local manual progress; not live',
  staticSimulationProgress: 'Simulation test; not real position', mediumConfidence: 'Manual progress',
  backgroundLockHint: 'Foreground web alerts only. No background, lock-screen or system alarm guarantee.',
  arrivalModalMessage: 'Trip record reached the target. Check station signs and announcements.',
  previewArrival: 'Test alert (no progress change)', manualConfidenceReason: 'Location quality observation only; no automatic station advance',
  notificationPermission: 'Foreground alerts only', notificationPermissionHint: 'No notification permission needed; no background push',
  homeConfidence: 'Foreground location observation + manual station confirmation',
  howItWorksBody: 'Location observes quality only. Station coordinates remain unverified. Progress is manual; static remaining time is not live ETA.' });
$('locationToggleBtn').onclick = toggleForegroundLocation;
$('locationPermission').onclick = toggleForegroundLocation;
$('notificationPermission').onclick = () => toast('只使用前台弹窗；不保证后台、锁屏提醒');
$('notificationStatus').textContent = '仅前台';
$('clearLocalTripBtn').onclick = () => { if (window.confirm('清除本机当前行程与已展示提醒状态？偏好不删除；本应用不保存定位轨迹。')) void endCurrentTrip(); };
$('simulationEntry').onchange = () => { const simulation = $('simulationEntry').checked; $('enableForegroundLocation').disabled = simulation; if (simulation) $('enableForegroundLocation').checked = false; };
document.addEventListener('visibilitychange', () => document.hidden ? pauseForeground() : resumeForeground());
window.addEventListener('pagehide', pauseForeground);
window.addEventListener('pageshow', resumeForeground);
setupMobileSelects(); applyTheme(); applyLanguage(); updateSwitches(); loadData(); setupOfflineCache();
