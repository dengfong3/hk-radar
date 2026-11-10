/* 盯盘雷达 PWA 的 service worker：
   缓存应用外壳（HTML/manifest/图标），行情接口一律直连、不缓存。
   支持页面在最小化/后台时用 showNotification 弹 Windows 系统通知，点击通知可拉回 PWA。
   注意：本 SW 不做 Web Push —— 浏览器完全退出（进程结束）后纯网页版本无法推送。 */
const CACHE = "hk-radar-shell-v2";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => undefined)   // 缺文件也不要卡住安装
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 点击桌面通知：优先聚焦已打开的 PWA 窗口，没有则新开
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || "./";
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if ("focus" in c) {
        await c.focus();
        if (c.navigate && target) {
          try { await c.navigate(target); } catch (e) {}
        }
        return;
      }
    }
    if (self.clients.openWindow) {
      try { await self.clients.openWindow(target); } catch (e) {}
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  // 行情接口（跨域）不进缓存
  if (url.hostname !== self.location.hostname) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html").then((r) => r || Response.error()))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && url.pathname.startsWith("/") && /\.(css|js|png|webmanifest|html)$/.test(url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
      }
      return res;
    }))
  );
});
