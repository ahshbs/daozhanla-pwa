// Generated PWA shell cache. Location never runs in this worker.
'use strict';
const ASSETS=["assets/pwa/icon-180.png","assets/pwa/icon-192.png","assets/pwa/icon-512.png","icons/arrow-right.svg","icons/bell-ring.svg","icons/circle-check.svg","icons/circle-dot.svg","icons/circle-help.svg","icons/circle-plus.svg","icons/flag.svg","icons/history.svg","icons/languages.svg","icons/map-pin.svg","icons/monitor.svg","icons/moon.svg","icons/navigation.svg","icons/play.svg","icons/rotate-ccw.svg","icons/route.svg","icons/settings.svg","icons/sun.svg","icons/train-front.svg","icons/volume-2.svg","icons/x.svg","index.html","manifest.webmanifest","pwa/app.js","pwa/config.js","pwa/core.js","pwa/estimated-reminder.js","pwa/location-controller.js","pwa/push-client.js","pwa/push-worker.js","pwa/trip-store.js"];
const BASE=new URL('./',self.location.href);
importScripts(new URL('pwa/push-worker.js',BASE).href);
const CACHE_PREFIX='daozhanla-pwa-shell-'+encodeURIComponent(BASE.pathname)+'-';
const CACHE_NAME=CACHE_PREFIX+"45f570d86565edb1c678";
const URLS=ASSETS.map(file=>new URL(file,BASE).href);
const SHELL=new Set(URLS);
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    try{await cache.addAll(URLS.map(url=>new Request(url,{cache:'reload'})));}
    catch(error){await caches.delete(CACHE_NAME);throw error;}
  })());
});
// No skipWaiting/clients.claim on install: an update cannot replace an active trip.
self.addEventListener('message',event=>{
  if(event.data&&event.data.type==='SKIP_WAITING'&&event.data.tripActive===false){
    event.waitUntil(self.skipWaiting());
  }
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    // Preserve caches while any old page remains open; it may contain an active trip.
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    if(windows.length===0){
      const keys=await caches.keys();
      await Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE_NAME).map(key=>caches.delete(key)));
    }
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==BASE.origin||!url.pathname.startsWith(BASE.pathname))return;
  const isEntry=request.mode==='navigate'&&(url.pathname===BASE.pathname||url.pathname===BASE.pathname+'index.html');
  const key=isEntry?new URL('index.html',BASE).href:url.href;
  if(!isEntry&&!SHELL.has(key))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(key);
    return cached||fetch(request);
  })());
});
