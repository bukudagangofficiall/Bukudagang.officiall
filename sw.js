// Service Worker untuk POS Kasir OKTSHOP17
//
// PENTING: setiap kali kamu update index.html/script.js/style.css dan upload ke GitHub,
// GANTI ANGKA VERSI DI BAWAH INI (misal 'v1' jadi 'v2'). Kalau tidak diganti, HP yang sudah
// install app ini bisa tetap memuat kode LAMA dari cache selama beberapa saat, walau kamu
// sudah replace file di GitHub.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `bukudagang-pos-${CACHE_VERSION}`;

// File "app shell" yang di-precache saat install, supaya aplikasi tetap bisa dibuka walau
// sedang offline (data transaksi/produk tetap butuh internet karena disimpan di Firestore).
const APP_SHELL = [
    './',
    './index.html',
    './script.js',
    './style.css',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
            // Diam-diam abaikan kalau ada file yang gagal di-precache (misal offline saat install pertama)
        })
    );
    self.skipWaiting(); // langsung aktifkan service worker baru tanpa nunggu tab lama ditutup
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim(); // ambil alih tab yang sudah terbuka, tidak perlu refresh manual
});

// Strategi: NETWORK-FIRST untuk file app shell sendiri (index.html/script.js/style.css) —
// supaya begitu online, versi TERBARU dari server selalu diutamakan (bukan versi lama di
// cache). Kalau lagi offline, baru fallback ke cache biar app tetap bisa dibuka.
// Request ke domain LAIN (Firestore, CDN library, dst) dibiarkan lewat langsung tanpa
// campur tangan service worker ini, supaya tidak mengganggu offline persistence Firestore
// yang sudah punya mekanismenya sendiri.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return; // biarkan request cross-origin lewat apa adanya
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
