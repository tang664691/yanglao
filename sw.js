/* ★★★ 更新说明（每次发版必读 · 机理版）★★★
   本 SW 有两条互不相同的缓存策略（见下方 fetch 分支）：
     ① 文档请求（mode==='navigate' || destination==='document'）→ network-first
        联网时**总是**取最新 HTML，与 SW_VERSION 无关。
     ② 其它同源静态资源（jpg/png/mp3/css/js…）→ cache-first
        缓存命中即返回，**永不回源**。Ctrl+F5 也清不掉 SW 缓存。

   ⇒ 结论（判据只有一条）：
      改了「被 PRECACHE 的资源」的内容，就**必须**升 SW_VERSION。
      升版后 activate 会删掉整个旧缓存并重新预缓存，老设备才拿得到新内容。
      不升版 ⇒ install 不重跑、activate 不清缓存 ⇒ 老设备**永久**是旧的。

   判据命令（命中即表示该资源被预缓存）：
      grep -oF '<资源文件名>' sw.js

   ⚠️ 本文件自身（sw.js）不在 PRECACHE 内，但它的内容变了浏览器**必然**重新安装它，
      所以改它也算「改了 SW」，同样要升版本号。
   ⚠️ 只改 index.html 内容、且未新增任何静态资源时：严格按机理**可不升版**
      （文档请求在下方 fetch 的 isDocument 分支就 return，**永不进 cache-first**；
       index.html 虽在 PRECACHE 内，但那只作**离线兜底**，不代表它被 cache-first 锁住）。
      但**只要某资源名出现在 PRECACHE 列表里**（本项目 './index.html'、'./retire-life.jpg' 等即是），
      改它内容就**必须升版**。真因＝ install 会 cache.add 整个 PRECACHE 写进新缓存名，
      activate 又只删「同前缀、不同版本号」的旧缓存 ⇒ 升版**连带清掉整个旧缓存包**，
      老设备因此不再持有旧副本，才会取到新字节（cache-first 的 jpg/mp3 尤其如此）。
      判断永远以「该资源名是否出现在 PRECACHE」为准。 */
var SW_VERSION = 'v1.0.37';

var CACHE_PREFIX = 'axyl-';
var CACHE_NAME = CACHE_PREFIX + SW_VERSION;

var PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  /* Phase 25：首页「合家欢」主图本地化（960px 压缩版，86KB）。
     原先它是全站唯一的外链（第三方 CDN，625KB）→ 离线打开必然图裂。
     预缓存它之后，全站零外链、离线完整。 */
  './hero.jpg',
  /* v1.0.26：首页底部插画由扁平矢量改为写实照片（老年夫妇公园漫步）。
     预缓存它，保证离线打开不图裂。 */
  './retire-life.jpg',
  /* Phase 24：离线语音播报资产（16 段，合计约 63KB）。
     必须预缓存 —— 目标机的自带浏览器没有 speechSynthesis，身份证逐键播报
     完全依赖这批音频；只做「按需缓存」会导致首次离线打开时静音。 */
  './voice/v0.mp3',
  './voice/v1.mp3',
  './voice/v2.mp3',
  './voice/v3.mp3',
  './voice/v4.mp3',
  './voice/v5.mp3',
  './voice/v6.mp3',
  './voice/v7.mp3',
  './voice/v8.mp3',
  './voice/v9.mp3',
  './voice/vdot.mp3',
  './voice/vdel.mp3',
  './voice/vclr.mp3',
  './voice/vok.mp3',
  './voice/vpct.mp3',
  './voice/vx.mp3'
];

/* 离线兜底页（浅蓝配色，无红色，中文；仅在断网且无缓存时显示） */
var OFFLINE_HTML =
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>暂时离线</title><style>' +
  'html,body{margin:0;padding:0;height:100%;}' +
  'body{background:#eaf1ff;color:#1f2d3d;' +
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;' +
  'display:flex;align-items:center;justify-content:center;text-align:center;}' +
  '.box{padding:28px 22px;max-width:420px;}' +
  '.box h1{font-size:20px;margin:0 0 12px;color:#1d4ed8;}' +
  '.box p{font-size:15px;line-height:1.7;margin:0 0 8px;color:#33414f;}' +
  '.tip{color:#6b7a8d;font-size:13px;}' +
  '</style></head><body><div class="box">' +
  '<h1>当前处于离线状态</h1>' +
  '<p>暂时无法连接到网络，请检查网络后重试。</p>' +
  '<p class="tip">若已添加到主屏幕，恢复联网后重新打开即可。</p>' +
  '</div></body></html>';

/* ---- 容错小工具：缓存不可用时一律降级，绝不产生未捕获的 promise 拒绝 ---- */

function safeOpenCache() {
  try {
    return caches.open(CACHE_NAME).catch(function () { return null; });
  } catch (e) {
    return Promise.resolve(null);
  }
}

function safeKeys() {
  try {
    return caches.keys().catch(function () { return []; });
  } catch (e) {
    return Promise.resolve([]);
  }
}

function safeDelete(key) {
  try {
    return caches.delete(key).catch(function () { return false; });
  } catch (e) {
    return Promise.resolve(false);
  }
}

function safeMatch(req) {
  try {
    return caches.match(req).catch(function () { return undefined; });
  } catch (e) {
    return Promise.resolve(undefined);
  }
}

function safePut(req, res) {
  try {
    safeOpenCache().then(function (cache) {
      if (cache) {
        return cache.put(req, res);
      }
      return null;
    }).catch(function () {});
  } catch (e) {}
}

/* install：逐个预缓存；单个资源失败不让整个安装失败；最后 skipWaiting */
self.addEventListener('install', function (event) {
  event.waitUntil(
    safeOpenCache().then(function (cache) {
      if (!cache) {
        return null;
      }
      return Promise.allSettled(
        PRECACHE.map(function (url) {
          return cache.add(new Request(url, { cache: 'reload' }));
        })
      );
    }).catch(function () {
      /* 缓存不可用时忽略，仍继续安装 */
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* activate：删掉所有以 CACHE_PREFIX 开头且不等于当前版本的旧缓存，并接管页面 */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    safeKeys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME) {
            return safeDelete(key);
          }
          return Promise.resolve(false);
        })
      );
    }).catch(function () {
      /* 缓存不可用时忽略 */
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* fetch：导航/HTML 走 network-first，其它同源静态资源走 cache-first */
self.addEventListener('fetch', function (event) {
  var request = event.request;

  /* 只处理 GET；其余（POST 等）直接交给浏览器默认处理 */
  if (request.method !== 'GET') {
    return;
  }

  /* 只处理同源请求；跨域请求直接交给浏览器默认处理，不 respond */
  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) {
    return;
  }

  var isDocument =
    (request.mode === 'navigate') || (request.destination === 'document');

  if (isDocument) {
    /* network-first：联网取最新 HTML 并回写缓存；断网回退缓存；再不行给离线页 */
    event.respondWith(
      fetch(new Request(request, { cache: 'no-store' }))
        .then(function (response) {
          try {
            if (response && response.status === 200) {
              safePut('./index.html', response.clone());
            }
          } catch (e) {}
          return response;
        })
        .catch(function () {
          return safeMatch('./index.html').then(function (cached) {
            return cached || new Response(OFFLINE_HTML, {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=UTF-8' }
            });
          });
        })
        .catch(function () {
          return new Response(OFFLINE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=UTF-8' }
          });
        })
    );
    return;
  }

  /* cache-first：缓存命中直接返回；未命中则取网络并回写缓存；失败回退缓存/504 */
  event.respondWith(
    safeMatch(request).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request).then(function (response) {
        try {
          if (response && response.status === 200 && response.type === 'basic') {
            safePut(request, response.clone());
          }
        } catch (e) {}
        return response;
      }).catch(function () {
        return safeMatch(request).then(function (fallback) {
          return fallback || new Response('', { status: 504, statusText: 'Offline' });
        });
      });
    }).catch(function () {
      return new Response('', { status: 504, statusText: 'Offline' });
    })
  );
});
