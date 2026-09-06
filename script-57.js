// STORE_NAME sekarang bisa berubah (bukan konstanta tetap) — nilai default ini cuma fallback
// sebelum data dari Firestore config/storeProfile sempat sync, atau kalau memang belum pernah
// diisi lewat menu "Profile Toko" di Admin Panel.
let STORE_NAME = "BUKU DAGANG";
// Login Admin sekarang pakai Firebase Authentication (email + password) — lihat checkLogin().
// Kelola akun admin (tambah/reset password) langsung dari Firebase Console -> Authentication.
const ADMIN_WA_NUMBER = "62895345452412"; // nomor WhatsApp admin tujuan bukti pembayaran QRIS

// DATA PRODUK & KATEGORI — diisi lewat Firestore real-time listener (lihat initFirestoreSync),
// nilai default di sini hanya dipakai sesaat sebelum data dari cloud pertama kali masuk.
let products = [];
let categories = ['Makanan', 'Minuman', 'Keripik'];

let cart = [];
let selectedPayment = '';
let lastOrder = null;
let currentCategory = categories[0] || '';
let orderHistory = []; // diisi via Firestore listener koleksi 'sales'

// Status sinkronisasi Firestore (dipakai buat indikator di tombol "Transfer Data")
let firestoreHasPendingWrites = false;
let firestoreListenersReady = false;

// Status "sudah dapat data ASLI dari server" — overlay wajib TIDAK BOLEH mengambil keputusan
// sebelum kedua ini true, supaya tidak salah pakai jam default sementara saat baru connect.
let attendanceSettingsLoaded = false;
let attendanceLogLoaded = false;

// --- MULTI-TENANT: setiap admin (akun email, diwakili uid Firebase Auth) punya ruang data
// SENDIRI di Firestore, disimpan di bawah admins/{adminId}/... (produk, kategori, karyawan,
// penjualan, absensi, dst — semuanya ter-scope, tidak lagi 1 toko global untuk semua orang).
// Device/browser ini "terikat" ke SATU admin/toko lewat localStorage (activeAdminId), diisi
// otomatis begitu ada admin yang berhasil login/daftar di device ini. Kasir yang login pakai
// NIK+PIN di device yang sama otomatis ikut memakai stok & karyawan milik admin tsb, tanpa
// perlu login email/password lagi — makanya NIK karyawan "mengikuti adminnya masing-masing".
function getActiveAdminId() {
    return localStorage.getItem('activeAdminId') || null;
}
function setActiveAdminId(adminId) {
    localStorage.setItem('activeAdminId', adminId);
}
// Path Firestore ter-scope ke admin aktif device ini. Return null kalau belum ada admin yang
// pernah login di device ini sama sekali — pemanggil WAJIB cek null ini sebelum baca/tulis.
function adminPathSegments(...segments) {
    const adminId = getActiveAdminId();
    return adminId ? ['admins', adminId, ...segments] : null;
}

// --- LAZY-LOAD LIBRARY BERAT (jsPDF, qrcodejs, jsQR) ---
// Library ini TIDAK dimuat lagi di <head> index.html, supaya app terasa ringan saat pertama
// dibuka (kasir/pelanggan yang cuma belanja tidak perlu download library cetak PDF/scan QR).
// Baru di-download sekali saat fitur terkait benar-benar dipakai, lalu di-cache di browser
// (request kedua dst tinggal ambil dari cache, tidak download ulang).
const _loadedScriptPromises = {};
function loadScriptOnce(src) {
    if (_loadedScriptPromises[src]) return _loadedScriptPromises[src];
    _loadedScriptPromises[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => { delete _loadedScriptPromises[src]; reject(new Error('Gagal memuat: ' + src)); };
        document.head.appendChild(s);
    });
    return _loadedScriptPromises[src];
}

async function ensureJsPDF() {
    if (window.jspdf) return;
    showToast('Menyiapkan modul cetak PDF...', 'info');
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.23/jspdf.plugin.autotable.min.js');
}

async function ensureQRCode() {
    if (window.QRCode) return;
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
}

async function ensureJsQR() {
    if (window.jsQR) return;
    await loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jsqr/1.4.0/jsQR.js');
}

// --- SEARCH PRODUK (debounce 250ms, biar tidak render ulang tiap ketikan huruf) ---
let productSearchTerm = '';
let _productSearchDebounce = null;
function handleProductSearchInput(value) {
    clearTimeout(_productSearchDebounce);
    _productSearchDebounce = setTimeout(() => {
        productSearchTerm = value.trim().toLowerCase();
        renderCatalog();
    }, 250);
}

function init() {
    renderCategoryTabs();
    renderCategorySelects();
    filterCategory(currentCategory);
    updateCartUI();
    startClock();
    updateConnectionUI();
    updateProofBadge();
    renderHomeGreeting();
    registerServiceWorker();
    lucide.createIcons();

    // Kunci dashboard SEJAK AWAL (sebelum data absen dari server termuat) — baru dilepas oleh
    // checkMandatoryMasukGate() setelah dipastikan memang tidak perlu absen saat ini.
    setDashboardLocked(true);

    // Pantau perubahan koneksi internet HP ini
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Firestore butuh proses login anonim dulu (async) sebelum bisa dipakai.
    // Kalau sudah siap duluan, langsung jalan; kalau belum, tunggu event 'firebase-ready'.
    if (window.FB && window.FB.ready) {
        initFirestoreSync();
    } else {
        window.addEventListener('firebase-ready', initFirestoreSync, { once: true });
        // Jaga-jaga kalau Firebase gagal total dimuat (misal offline saat pertama kali buka
        // & belum pernah ke-cache), supaya UI tetap jalan dengan data kosong daripada macet.
        setTimeout(() => {
            if (!firestoreListenersReady) {
                document.getElementById('connecting-gate').innerHTML = `
                    <button onclick="openLoginModal()" class="absolute top-5 left-5 text-white/80 hover:text-white p-2 flex items-center gap-1.5 text-xs font-bold">
                        <i data-lucide="lock" class="w-4 h-4"></i> Admin
                    </button>
                    <div class="text-center text-white px-6">
                        <i data-lucide="wifi-off" class="w-10 h-10 mx-auto mb-4"></i>
                        <p class="font-bold mb-2">Gagal terhubung ke database</p>
                        <p class="text-sm opacity-80">Cek koneksi internet, lalu refresh halaman ini.</p>
                    </div>`;
                lucide.createIcons();
            }
        }, 10000);
    }
}

// --- SINKRONISASI FIRESTORE (database bersama, real-time ke semua HP — TER-SCOPE PER ADMIN) ---
// initFirestoreSync jalan begitu Firebase siap. Kalau device ini BELUM pernah ada admin yang
// login/daftar (activeAdminId kosong), tampilkan gerbang "Belum ada toko terhubung" dan JANGAN
// subscribe apapun dulu — begitu admin login/daftar (lihat checkLogin & registerFirstAdmin),
// subscribeAdminScopedData() dipanggil ulang dengan adminId yang baru didapat.
let adminScopedSyncReady = false;
function initFirestoreSync() {
    const adminId = getActiveAdminId();
    if (!adminId) {
        showNoStoreGate();
        return;
    }
    subscribeAdminScopedData(adminId);
}

// Gerbang khusus: device ini belum terhubung ke toko/admin manapun. Dipakai baik saat pertama
// kali buka app di device baru, maupun setelah logout total dari sesi admin.
function showNoStoreGate() {
    attendanceSettingsLoaded = true; // tidak ada data absen yang relevan tanpa toko -> anggap "termuat" biar tidak macet
    attendanceLogLoaded = true;
    const gate = document.getElementById('connecting-gate');
    if (!gate) return;
    gate.innerHTML = `
        <div class="text-center text-white px-6">
            <i data-lucide="store" class="w-10 h-10 mx-auto mb-4"></i>
            <p class="font-bold mb-2">Belum ada toko terhubung di perangkat ini</p>
            <p class="text-sm opacity-80 mb-5">Login atau daftar sebagai Admin dulu untuk menghubungkan toko kamu.</p>
            <button onclick="openLoginModal()" class="bg-white text-blue-600 px-6 py-3 rounded-2xl font-bold text-sm">Login / Daftar Admin</button>
        </div>`;
    gate.classList.remove('hidden');
    lucide.createIcons();
}

function subscribeAdminScopedData(adminId) {
    if (adminScopedSyncReady) return; // hindari daftar listener dua kali
    adminScopedSyncReady = true;
    firestoreListenersReady = true;
    const { db, doc, collection, onSnapshot, query, orderBy } = window.FB;
    document.getElementById('connecting-gate').classList.remove('hidden'); // tampil lagi sebentar sampai data toko baru ini termuat
    const a = (...segments) => doc(db, 'admins', adminId, ...segments);
    const ac = (...segments) => collection(db, 'admins', adminId, ...segments);

    // --- Produk (satu dokumen berisi array semua produk) ---
    onSnapshot(a('config', 'products'), (snap) => {
        trackPendingWrites(snap);
        if (snap.exists() && Array.isArray(snap.data().items)) {
            products = snap.data().items;
        } else {
            products = [];
        }
        renderCatalog();
        if (document.getElementById('page-admin') && !document.getElementById('page-admin').classList.contains('hidden')) {
            renderAdminTools();
        }
    }, (err) => console.error('Sync produk gagal:', err));

    // --- Kategori ---
    onSnapshot(a('config', 'categories'), (snap) => {
        trackPendingWrites(snap);
        if (snap.exists() && Array.isArray(snap.data().items) && snap.data().items.length > 0) {
            categories = snap.data().items;
        }
        if (!currentCategory || !categories.includes(currentCategory)) {
            currentCategory = categories[0] || '';
        }
        renderCategoryTabs();
        renderCategorySelects();
        filterCategory(currentCategory);
        if (document.getElementById('page-admin') && !document.getElementById('page-admin').classList.contains('hidden')) {
            renderCategoryList();
        }
    }, (err) => console.error('Sync kategori gagal:', err));

    // --- Riwayat Penjualan (koleksi, urut waktu terbaru) ---
    const salesQuery = query(ac('sales'), orderBy('timestamp', 'desc'));
    onSnapshot(salesQuery, (snap) => {
        trackPendingWrites(snap);
        orderHistory = snap.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
        if (document.getElementById('page-admin') && !document.getElementById('page-admin').classList.contains('hidden')) {
            renderAdminTools();
        }
        if (document.getElementById('modal-sales-report') && !document.getElementById('modal-sales-report').classList.contains('hidden')) {
            renderSalesReport();
        }
    }, (err) => console.error('Sync riwayat penjualan gagal:', err));

    // --- Karyawan (daftar nama, NIK & PIN, dipakai buat identifikasi saat login/absen) ---
    onSnapshot(a('config', 'employees'), (snap) => {
        trackPendingWrites(snap);
        employeesCache = (snap.exists() && Array.isArray(snap.data().items)) ? snap.data().items : [];
        try {
            renderEmployeeList();
            renderScheduleTable(); // nama karyawan dipakai untuk baris tabel jadwal
            renderRiwayatAbsenEmployeeSelect();
            if (!pinLockResolved) { renderPinLockUserList(); tryShowPinLock(); } // layar kunci NIK ikut sinkron
        } catch (err) {
            console.error('Error saat render data karyawan:', err);
        }
    }, (err) => console.error('Sync karyawan gagal:', err));

    // --- Katalog Per Karyawan (produk & kuota kustom per kasir, diatur Admin) ---
    onSnapshot(a('config', 'employeeCatalog'), (snap) => {
        trackPendingWrites(snap);
        employeeCatalogCache = snap.exists() ? snap.data() : {};
        renderCategoryTabs(); // ikut refresh tab kategori & katalog kasir yang lagi aktif
        if (document.getElementById('page-admin') && !document.getElementById('page-admin').classList.contains('hidden')) {
            renderEmployeeCatalogEditor();
        }
    }, (err) => console.error('Sync katalog karyawan gagal:', err));

    // --- Pemakaian Kuota Harian Kasir (dilacak per tanggal, otomatis "reset" tiap ganti hari) ---
    onSnapshot(ac('kasirQuotaUsage'), (snap) => {
        trackPendingWrites(snap);
        kasirQuotaUsageCache = snap.docs.map(d => d.data());
        renderCatalog();
    }, (err) => console.error('Sync kuota kasir gagal:', err));

    // --- Jadwal Kerja Karyawan (tabel nama x tanggal, koleksi per tanggal) ---
    onSnapshot(ac('schedule'), (snap) => {
        trackPendingWrites(snap);
        scheduleCache = {};
        snap.docs.forEach(d => { scheduleCache[d.id] = d.data(); });
        renderScheduleTable();
        try { checkMandatoryMasukGate(); } catch (err) { console.error('Error re-cek gerbang absen setelah jadwal berubah:', err); } // jadwal hari ini bisa berubah kapan saja -> wajib-absen ikut ter-update real-time
    }, (err) => console.error('Sync jadwal karyawan gagal:', err));

    // Catatan: listener 'cashReconciliation' SENGAJA dipindah ke initAdminOnlyFirestoreSync()
    // di bawah — koleksi ini cuma dipakai di tabel "Input Total Penjualan Hari Ini" (Admin Panel),
    // jadi tidak perlu kasir yang cuma jualan ikut subscribe ke sini sejak buka aplikasi.
    // Koleksi lain (schedule, kasirQuotaUsage, employeeCatalog, dst) TETAP di sini karena
    // memang dipakai langsung di alur kasir (gerbang wajib absen, kuota harian, katalog per kasir).

    // --- Pengaturan Absen (penanda "data awal sudah dimuat", dipakai bareng attendanceLogLoaded
    //     untuk keputusan gerbang wajib absen. Jendela absen pulang sudah dihapus — absen pulang
    //     sekarang self-service kapan saja lewat tombol fingerprint di header, sama seperti masuk.) ---
    onSnapshot(a('config', 'attendanceSettings'), (snap) => {
        trackPendingWrites(snap);
        attendanceSettingsLoaded = true;
        tryCloseConnectingGate(); // ditaruh PALING DULUAN: gerbang wajib tertutup begitu data masuk,
        // supaya kalau ada bug di render di bawah ini, app tidak macet selamanya di "Menghubungkan..."
        try {
            refreshAttendanceAdminViews();
            checkMandatoryMasukGate();
            tryShowPinLock();
        } catch (err) {
            console.error('Error saat proses data absen (settings):', err);
        }
    }, (err) => console.error('Sync pengaturan absen gagal:', err));

    // --- Profile Toko (nama toko dinamis) ---
    onSnapshot(a('config', 'storeProfile'), (snap) => {
        trackPendingWrites(snap);
        if (snap.exists() && snap.data().name) {
            STORE_NAME = snap.data().name;
            applyStoreName();
        }
    }, (err) => console.error('Sync profile toko gagal:', err));

    // --- Token QR Absen ---
    onSnapshot(a('config', 'attendanceQrToken'), (snap) => {
        trackPendingWrites(snap);
        cachedQrToken = snap.exists() ? snap.data().token : null;
        renderAttendanceQR();
    }, (err) => console.error('Sync QR absen gagal:', err));

    // --- Riwayat Absensi (koleksi, doc ID = tanggal) ---
    onSnapshot(ac('attendance'), (snap) => {
        trackPendingWrites(snap);
        attendanceLogCache = snap.docs.map(d => d.data());
        attendanceLogLoaded = true;
        tryCloseConnectingGate(); // sama seperti di atas: tutup gerbang duluan sebelum render lain
        try {
            renderRiwayatAbsen();
            checkMandatoryMasukGate();
            renderCategoryTabs(); // kasir aktif bisa berganti (absen masuk/keluar) -> katalog ikut berubah
            updateCashRekonLockState(); // status kunci "Input Total Penjualan" ikut update real-time
            tryShowPinLock();
            if (document.getElementById('modal-absen-popup') && !document.getElementById('modal-absen-popup').classList.contains('hidden')) {
                renderAbsenPopup();
            }
        } catch (err) {
            console.error('Error saat proses data absen (riwayat):', err);
        }
    }, (err) => console.error('Sync absensi gagal:', err));

    updateConnectionUI();
}

// Dipanggil begitu ada admin BARU yang login/daftar di device ini (adminId berubah) — misal
// device sebelumnya kosong, atau sebelumnya dipakai toko lain. Reset semua cache & listener
// lama, lalu subscribe ulang dari nol ke data milik admin yang baru ini.
function switchActiveAdminAndResync(adminId) {
    setActiveAdminId(adminId);
    adminScopedSyncReady = false;
    products = []; categories = ['Makanan', 'Minuman', 'Keripik']; employeesCache = [];
    employeeCatalogCache = {}; kasirQuotaUsageCache = []; scheduleCache = {};
    orderHistory = []; attendanceLogCache = []; cashReconciliationCache = [];
    adminOnlyFirestoreSyncReady = false;
    subscribeAdminScopedData(adminId);
}

// --- SYNC ADMIN-ONLY (baru dipasang saat Admin Panel pertama kali dibuka, bukan sejak init()) ---
let adminOnlyFirestoreSyncReady = false;
function initAdminOnlyFirestoreSync() {
    if (adminOnlyFirestoreSyncReady) return; // hindari daftar listener dua kali tiap buka Admin Panel
    if (!window.FB || !window.FB.ready) return; // belum konek, coba lagi nanti pas showPage('admin') dipanggil ulang
    const adminId = getActiveAdminId();
    if (!adminId) return;
    adminOnlyFirestoreSyncReady = true;
    const { db, collection, onSnapshot } = window.FB;

    onSnapshot(collection(db, 'admins', adminId, 'cashReconciliation'), (snap) => {
        trackPendingWrites(snap);
        cashReconciliationCache = snap.docs.map(d => d.data());
        try { renderCashReconciliationTable(); } catch (err) { console.error('Error render tabel input sales:', err); }
    }, (err) => console.error('Sync input sales gagal:', err));
}

// Gerbang tunggu hanya boleh ditutup kalau KEDUA data (jam kerja & riwayat absen hari ini)
// sudah benar-benar termuat dari server — supaya overlay wajib tidak pernah salah keputusan
// gara-gara masih pakai data lama/kosong sesaat setelah halaman dibuka.
function tryCloseConnectingGate() {
    if (attendanceSettingsLoaded && attendanceLogLoaded) {
        document.getElementById('connecting-gate').classList.add('hidden');
    }
}

// Update indikator "ada perubahan yang belum tersimpan permanen ke server" (masih di cache lokal)
function trackPendingWrites(snap) {
    firestoreHasPendingWrites = snap.metadata.hasPendingWrites;
    updateConnectionUI();
}

// --- JAM & TANGGAL DIGITAL ---
function startClock() {
    updateClock();
    setInterval(updateClock, 1000);
}

function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = now.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const clockEl = document.getElementById('live-clock');
    const dateEl = document.getElementById('live-date');
    if (clockEl) clockEl.innerText = time;
    if (dateEl) dateEl.innerText = date;

    checkMandatoryMasukGate();
}

// --- KONEKSI & STATUS SINKRONISASI FIRESTORE ---
// Semua data (produk, kategori, penjualan, stock, absen) sekarang tersimpan di Firestore
// (database cloud bersama), dengan offline persistence bawaan: tetap bisa dipakai walau
// offline, lalu otomatis sinkron ke server & ke semua HP lain begitu online kembali.
// Tombol "Transfer Data" di header sekarang murni indikator status sinkronisasi ini.

function updateConnectionUI() {
    const btn = document.getElementById('btn-transfer');
    const badge = document.getElementById('pending-badge');
    if (!btn) return;

    btn.classList.remove('is-online', 'is-offline', 'is-syncing');
    const icon = btn.querySelector('i');

    if (!navigator.onLine) {
        btn.classList.add('is-offline');
        if (icon) icon.setAttribute('data-lucide', 'cloud-off');
    } else if (firestoreHasPendingWrites) {
        btn.classList.add('is-syncing');
        if (icon) icon.setAttribute('data-lucide', 'refresh-cw');
    } else {
        btn.classList.add('is-online');
        if (icon) icon.setAttribute('data-lucide', 'cloud-check');
    }

    // Badge dipakai untuk kondisi "ada perubahan lokal yang belum tersimpan permanen ke server"
    if (badge) {
        if (firestoreHasPendingWrites) {
            badge.textContent = '!';
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
    lucide.createIcons();
}

function showToast(message, type = '') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// Firestore otomatis menyimpan & menyinkronkan data (termasuk saat offline, lalu otomatis
// terkirim ke server begitu online lagi) — jadi tombol ini sekarang murni indikator status,
// bukan tombol aksi manual lagi seperti sebelumnya.
function transferData() {
    if (!navigator.onLine) {
        showToast('Sedang offline. Perubahan tersimpan di HP ini dan akan otomatis sinkron ke server saat online kembali.', 'warn');
    } else if (firestoreHasPendingWrites) {
        showToast('Sedang menyinkronkan data ke server...', '');
    } else {
        showToast('Semua data sudah tersinkron ke server.', 'success');
    }
}

function handleOnline() {
    updateConnectionUI();
    showToast('Koneksi online kembali. Menyinkronkan data...', 'success');

    // Ingatkan kasir kalau ada foto bukti bayar QRIS yang belum sempat dikirim saat offline.
    // Browser tidak mengizinkan mengirim ke WhatsApp otomatis tanpa sentuhan pengguna,
    // jadi kita tampilkan pengingat + badge supaya kasir tinggal 1x tap untuk mengirim.
    const pending = getPendingProofs();
    if (pending.length > 0) {
        showToast(`${pending.length} bukti bayar QRIS menunggu dikirim. Tap ikon kamera di pojok kanan atas.`, 'warn');
    }
}

function handleOffline() {
    updateConnectionUI();
    showToast('Koneksi terputus. Aplikasi tetap bisa digunakan (offline), data akan sinkron otomatis nanti.', 'warn');
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {
            // Diam-diam abaikan jika gagal (misal dibuka langsung dari file://)
        });
    }
}

// --- TOMBOL INSTALL PWA MELAYANG ---
// Chrome TIDAK otomatis menampilkan banner/tombol install lagi kecuali kita sendiri yang
// menangkap event 'beforeinstallprompt' dan menyediakan tombolnya. Tombol ini dibuat lewat
// JS (bukan ditulis manual di index.html) supaya tidak perlu edit HTML sama sekali.
let deferredInstallPrompt = null;

function createInstallButton() {
    if (document.getElementById('btn-install-app')) return;
    const btn = document.createElement('button');
    btn.id = 'btn-install-app';
    btn.innerHTML = '<i data-lucide="download" class="w-4 h-4"></i><span>Install App</span>';
    btn.style.cssText = 'position:fixed;bottom:110px;right:16px;z-index:60;display:flex;align-items:center;gap:8px;background:#2563eb;color:#fff;font-weight:700;font-size:13px;padding:12px 18px;border-radius:9999px;box-shadow:0 8px 20px rgba(37,99,235,0.35);border:none;cursor:pointer;';
    btn.onclick = async () => {
        if (!deferredInstallPrompt) return;
        btn.disabled = true;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (outcome !== 'accepted') btn.disabled = false;
    };
    document.body.appendChild(btn);
    if (window.lucide) lucide.createIcons();
}

function removeInstallButton() {
    const btn = document.getElementById('btn-install-app');
    if (btn) btn.remove();
}

window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // cegah mini-infobar bawaan browser, kita pakai tombol sendiri
    deferredInstallPrompt = event;
    createInstallButton();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    removeInstallButton();
    showToast('Aplikasi berhasil di-install!', 'success');
});

// --- KATEGORI & KATALOG ---
function renderCategoryTabs() {
    const container = document.getElementById('tabs-container');
    if (!container) return;
    // Tab yang ditampilkan mengikuti katalog kasir yang lagi absen (kalau Admin sudah atur
    // Katalog Per Karyawan buat dia) — supaya kasir cuma lihat kategori yang relevan buat dia.
    const visibleCategories = getVisibleCategoriesForCurrentKasir();
    if (!visibleCategories.includes(currentCategory)) {
        currentCategory = visibleCategories[0] || '';
    }
    container.innerHTML = visibleCategories.map(cat => `
        <button onclick="filterCategory('${cat.replace(/'/g, "\\'")}')" id="tab-${cat}" class="category-tab whitespace-nowrap ${cat === currentCategory ? 'active' : ''}">${cat}</button>
    `).join('');
    renderCatalog();
}

function filterCategory(cat) {
    currentCategory = cat;
    document.querySelectorAll('.category-tab').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeTab = document.getElementById(`tab-${cat}`);
    if (activeTab) activeTab.classList.add('active');
    renderCatalog();
}

function renderCatalog() {
    const grid = document.getElementById('catalog-grid');
    if (!grid) return;

    // Skeleton loading: sebelum listener 'config/products' pertama kali dapat data dari
    // Firestore (bukan cuma kosong beneran), tampilkan placeholder pulsing daripada grid kosong
    // polos, biar terasa "lagi memuat" bukan "produknya memang tidak ada".
    if (!firestoreListenersReady) {
        grid.innerHTML = Array.from({ length: 6 }).map(() => `
            <div class="skeleton-card p-5 rounded-[1.75rem]">
                <div class="skeleton-line w-3/4 h-4 mb-3 rounded-full"></div>
                <div class="skeleton-line w-1/2 h-4 rounded-full"></div>
            </div>`).join('');
        return;
    }

    // Katalog yang tampil mengikuti kasir yang lagi absen — kalau Admin sudah setting produk
    // & kuota khusus buat dia di "Katalog Per Karyawan", cuma itu yang muncul di sini.
    const visibleProducts = getVisibleProductsForCurrentKasir();
    let filtered = visibleProducts.filter(p => p.category === currentCategory);
    if (productSearchTerm) {
        // Search lintas kategori: kalau lagi cari, abaikan filter kategori aktif supaya
        // produk ketemu walau lagi di tab kategori lain.
        filtered = visibleProducts.filter(p => p.name.toLowerCase().includes(productSearchTerm));
    }
    grid.innerHTML = filtered.map((p, idx) => {
        const hasVariant = p.variantConfig && p.variantConfig.enabled;
        const effectiveStock = getEffectiveStockForCurrentKasir(p);
        const isOutOfStock = effectiveStock != null && effectiveStock <= 0;
        const clickAction = isOutOfStock ? '' : (hasVariant ? `openVariantModal(${p.id})` : `addToCartWithBump(event, ${p.id})`);
        return `
        <div onclick="${clickAction}" style="animation-delay:${idx * 0.03}s" class="product-card p-5 rounded-[1.75rem] relative ${isOutOfStock ? 'opacity-50 grayscale cursor-not-allowed' : 'cursor-pointer'}">
            ${isOutOfStock ? `<span class="absolute top-3 right-3 bg-red-100 text-red-600 text-[9px] font-bold px-2 py-1 rounded-full">HABIS</span>` : hasVariant ? `<span class="absolute top-3 right-3 bg-blue-100 text-blue-600 text-[9px] font-bold px-2 py-1 rounded-full">PILIH ISI</span>` : ''}
            <h3 class="font-extrabold text-slate-800 text-sm mb-2 leading-tight pr-2">${p.name}</h3>
            <p class="text-blue-600 font-black">Rp ${p.price.toLocaleString()}</p>
            ${(!isOutOfStock && effectiveStock != null) ? `<p class="text-[10px] text-slate-400 font-semibold mt-1">Sisa ${effectiveStock}</p>` : ''}
        </div>`;
    }).join('') || `<div class="col-span-full text-center py-10 text-slate-400 text-sm">${productSearchTerm ? 'Produk tidak ditemukan' : 'Belum ada menu di kategori ini'}</div>`;
}

// --- ADMIN FUNCTIONS (TAMBAH, EDIT, HAPUS) ---
function toggleVariantFields(prefix) {
    const enabled = document.getElementById(`${prefix}-variant-enabled`).checked;
    document.getElementById(`${prefix}-variant-fields`).classList.toggle('hidden', !enabled);
}

function readVariantConfig(prefix) {
    const enabled = document.getElementById(`${prefix}-variant-enabled`).checked;
    if (!enabled) return { enabled: false };
    const count = parseInt(document.getElementById(`${prefix}-variant-count`).value) || 1;
    const sourceCategory = document.getElementById(`${prefix}-variant-source`).value;
    return { enabled: true, count, sourceCategory };
}

function addProduct() {
    const name = document.getElementById('add-name').value;
    const price = parseInt(document.getElementById('add-price').value);
    const category = document.getElementById('add-category').value;
    const variantConfig = readVariantConfig('add');

    if (!name || isNaN(price) || price < 0) return alert("Harap isi Nama dan Harga (boleh 0 untuk item pilihan rasa)!");
    if (variantConfig.enabled && !variantConfig.sourceCategory) return alert("Pilih kategori sumber untuk pilihan isi/rasa!");

    const newProduct = {
        id: Date.now(), // Unique ID
        name: name,
        price: price,
        category: category,
        variantConfig: variantConfig
    };

    saveProductsToFirestore([...products, newProduct]);

    // Reset Form
    document.getElementById('add-name').value = '';
    document.getElementById('add-price').value = '';
    document.getElementById('add-variant-enabled').checked = false;
    document.getElementById('add-variant-count').value = '';
    toggleVariantFields('add');
    alert("Produk berhasil ditambahkan!");
}

function loadProductData() {
    const id = parseInt(document.getElementById('edit-select').value);
    const product = products.find(p => p.id === id);
    if (product) {
        document.getElementById('edit-name').value = product.name;
        document.getElementById('edit-price').value = product.price;
        document.getElementById('edit-category').value = product.category;

        const vc = product.variantConfig || { enabled: false };
        document.getElementById('edit-variant-enabled').checked = !!vc.enabled;
        document.getElementById('edit-variant-count').value = vc.count || '';
        toggleVariantFields('edit');
        if (vc.sourceCategory) document.getElementById('edit-variant-source').value = vc.sourceCategory;
    }
}

function updateProduct() {
    const id = parseInt(document.getElementById('edit-select').value);
    const idx = products.findIndex(p => p.id === id);
    const variantConfig = readVariantConfig('edit');
    if (variantConfig.enabled && !variantConfig.sourceCategory) return alert("Pilih kategori sumber untuk pilihan isi/rasa!");
    if (idx !== -1) {
        const updated = [...products];
        updated[idx] = {
            ...updated[idx],
            name: document.getElementById('edit-name').value,
            price: parseInt(document.getElementById('edit-price').value),
            category: document.getElementById('edit-category').value,
            variantConfig: variantConfig
        };
        saveProductsToFirestore(updated);
        alert('Berhasil diperbarui!');
    }
}

function deleteProduct() {
    const id = parseInt(document.getElementById('edit-select').value);
    if (confirm("Hapus menu ini dari katalog?")) {
        saveProductsToFirestore(products.filter(p => p.id !== id));
        alert('Produk dihapus!');
    }
}

// Simpan seluruh array produk ke Firestore. Tampilan (renderCatalog, dsb) di-update
// otomatis lewat onSnapshot listener di initFirestoreSync — tidak perlu dipanggil manual di sini.
function saveProductsToFirestore(newProducts) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
        return;
    }
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'products')), { items: newProducts }).catch((err) => {
        console.error('Gagal simpan produk:', err);
        showToast('Gagal menyimpan produk ke server.', 'warn');
    });
}

// --- PENGATURAN KATEGORI ---
function renderCategorySelects() {
    const options = categories.map(c => `<option value="${c}">${c}</option>`).join('');
    const addSelect = document.getElementById('add-category');
    const editSelect = document.getElementById('edit-category');
    const addVariantSource = document.getElementById('add-variant-source');
    const editVariantSource = document.getElementById('edit-variant-source');
    if (addSelect) addSelect.innerHTML = options;
    if (editSelect) editSelect.innerHTML = options;
    if (addVariantSource) addVariantSource.innerHTML = options;
    if (editVariantSource) editVariantSource.innerHTML = options;
}

function renderCategoryList() {
    const list = document.getElementById('category-list');
    if (!list) return;
    list.innerHTML = categories.map(cat => {
        const count = products.filter(p => p.category === cat).length;
        return `
        <div class="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-xl p-3">
            <div>
                <span class="font-bold text-sm text-slate-800">${cat}</span>
                <span class="text-[10px] text-slate-400 ml-2">${count} produk</span>
            </div>
            <button onclick="deleteCategory('${cat.replace(/'/g, "\\'")}')" class="text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
        </div>`;
    }).join('') || '<p class="text-xs text-slate-400">Belum ada kategori</p>';
    lucide.createIcons();
}

function saveCategoriesToFirestore(newCategories) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
        return;
    }
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'categories')), { items: newCategories }).catch((err) => {
        console.error('Gagal simpan kategori:', err);
        showToast('Gagal menyimpan kategori ke server.', 'warn');
    });
}

function addCategory() {
    const input = document.getElementById('new-category-name');
    const name = input.value.trim();
    if (!name) return alert('Nama kategori tidak boleh kosong!');
    if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
        return alert('Kategori tersebut sudah ada!');
    }
    saveCategoriesToFirestore([...categories, name]);
    input.value = '';
}

function deleteCategory(cat) {
    const used = products.filter(p => p.category === cat).length;
    if (used > 0) {
        return alert(`Kategori "${cat}" masih dipakai oleh ${used} produk. Pindahkan atau hapus produk tersebut dulu sebelum menghapus kategorinya.`);
    }
    if (!confirm(`Hapus kategori "${cat}"?`)) return;
    saveCategoriesToFirestore(categories.filter(c => c !== cat));
}

function renderAdminTools() {
    applyStoreName(); // isi field "Nama Toko" dengan nilai terkini tiap panel admin dibuka
    const select = document.getElementById('edit-select');
    select.innerHTML = products.map(p => `<option value="${p.id}">${p.name} [${p.category}]</option>`).join('');
    renderCategorySelects();
    renderCategoryList();
    renderStockManageList();
    renderEmployeeCatalogSelect();
    renderScheduleTable();
    renderRiwayatAbsenEmployeeSelect();
    renderCashRekonFilterOptions();
    renderCashReconciliationTable();
    loadProductData();

    // Total Penjualan (dengan filter per karyawan / bulan)
    renderTotalPenjualanFilterOptions();
    applyTotalPenjualanFilter();

    // Penjualan Produk (rincian per item, filter tanggal + user)
    renderProductSalesFilterOptions();
    renderProductSalesTable();
}

// --- INPUT TOTAL PENJUALAN HARI INI (rekonsiliasi uang cash manual vs sistem) ---
// Cuma uang CASH yang dihitung/dicocokkan di sini (QRIS/Shopee tidak, karena uangnya tidak
// dipegang fisik sama kasir). Admin/kasir input nominal uang cash yang benar-benar dihitung di
// tangan; sistem bandingkan dengan total penjualan cash yang tercatat otomatis dari transaksi.
function getCashSalesForEmployeeDate(empId, dateStr) {
    return orderHistory
        .filter(o => o.employeeId === empId && o.method === 'Cash' && o.timestamp && getTodayDateStr(new Date(o.timestamp)) === dateStr)
        .reduce((sum, o) => sum + (o.total || 0), 0);
}

function renderCashRekonFilterOptions() {
    const select = document.getElementById('cashrek-employee');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = '<option value="">Pilih Karyawan</option>' + employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;

    const dateInput = document.getElementById('cashrek-date');
    if (dateInput && !dateInput.value) dateInput.value = getTodayDateStr();

    updateCashRekonLockState();
}

// Input "Total Penjualan Hari Ini" cuma boleh diisi SETELAH kasir yang bersangkutan absen
// keluar di tanggal itu — supaya nggak ada input hasil hitung cash duluan sebelum shift-nya
// beneran selesai (data cash masih bisa berubah selama kasir masih jualan).
function updateCashRekonLockState() {
    const dateInput = document.getElementById('cashrek-date');
    const empSelect = document.getElementById('cashrek-employee');
    const submitBtn = document.getElementById('cashrek-submit-btn');
    const warning = document.getElementById('cashrek-lock-warning');
    if (!dateInput || !empSelect || !submitBtn || !warning) return;

    const dateStr = dateInput.value;
    const empId = empSelect.value;

    // Belum pilih karyawan/tanggal -> tombol nonaktif juga (submitCashReconciliation sudah
    // validasi ini juga, tapi biar tombolnya konsisten kelihatan nonaktif dari awal).
    if (!dateStr || !empId) {
        submitBtn.disabled = true;
        warning.classList.add('hidden');
        return;
    }

    const record = attendanceLogCache.find(r => r.date === dateStr && r.employeeId === empId);
    const empName = (employeesCache.find(e => e.id === empId) || {}).name || 'Karyawan ini';

    if (!record || !record.keluarTime) {
        submitBtn.disabled = true;
        warning.textContent = `${empName} belum absen keluar di tanggal ${dateStr}. Input baru bisa diisi setelah shift-nya selesai.`;
        warning.classList.remove('hidden');
    } else {
        submitBtn.disabled = false;
        warning.classList.add('hidden');
    }
}

function submitCashReconciliation() {
    const dateInput = document.getElementById('cashrek-date');
    const empSelect = document.getElementById('cashrek-employee');
    const nominalInput = document.getElementById('cashrek-nominal');

    const dateStr = dateInput ? dateInput.value : '';
    const empId = empSelect ? empSelect.value : '';
    const nominal = nominalInput ? parseInt(nominalInput.value, 10) : NaN;

    if (!dateStr) return alert('Pilih tanggal dulu!');
    if (!empId) return alert('Pilih karyawan dulu!');

    // Cek ulang di sini juga (bukan cuma andalkan tombol disabled), jaga-jaga kalau ada yang
    // coba submit lewat cara lain (misal tombol sempat aktif lalu attendance baru saja masuk).
    const record = attendanceLogCache.find(r => r.date === dateStr && r.employeeId === empId);
    if (!record || !record.keluarTime) {
        return alert('Karyawan ini belum absen keluar di tanggal tersebut. Input baru bisa diisi setelah shift-nya selesai.');
    }

    if (isNaN(nominal) || nominal < 0) return alert('Isi nominal uang cash yang benar!');
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const actualCash = getCashSalesForEmployeeDate(empId, dateStr);
    renderCashReconciliationResult(nominal, actualCash);

    const empName = (employeesCache.find(e => e.id === empId) || {}).name || '';
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('cashReconciliation', `${dateStr}_${empId}`)), {
        date: dateStr,
        employeeId: empId,
        employeeName: empName,
        inputAmount: nominal,
        timestamp: new Date().toISOString()
    }).catch((err) => {
        console.error('Gagal simpan input sales:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

function formatSelisih(selisih) {
    if (selisih === 0) return 'Rp 0';
    return selisih > 0 ? `+Rp ${selisih.toLocaleString()}` : `-Rp ${Math.abs(selisih).toLocaleString()}`;
}

// Hasilnya cuma keluar SETELAH tombol "Cetak Hasil" ditekan (bukan otomatis dari awal).
function renderCashReconciliationResult(inputAmount, actualCash) {
    const box = document.getElementById('cashrek-result');
    if (!box) return;
    box.classList.remove('hidden');
    const selisih = inputAmount - actualCash;

    if (selisih === 0) {
        box.innerHTML = `
        <div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
            <p class="text-2xl font-black text-emerald-700">Rp ${inputAmount.toLocaleString()} <span>&#9989;</span></p>
            <p class="text-xs text-emerald-600 font-semibold mt-1">Sesuai dengan penjualan cash tercatat</p>
        </div>`;
    } else {
        box.innerHTML = `
        <div class="bg-red-50 border border-red-200 rounded-2xl p-5 text-center">
            <p class="text-2xl font-black text-red-600">${formatSelisih(selisih)} <span>&#10060;</span></p>
            <p class="text-xs text-red-500 font-semibold mt-1">Selisih dari penjualan cash tercatat</p>
            <p class="text-xs text-slate-500 font-semibold mt-2">Total seharusnya: <span class="font-bold text-slate-700">Rp ${actualCash.toLocaleString()}</span></p>
        </div>`;
    }
}

// Tabel riwayat 7 input terakhir (semua karyawan/tanggal, terbaru dulu)
function renderCashReconciliationTable() {
    const tbody = document.getElementById('cashrek-history-body');
    if (!tbody) return;

    const rows = cashReconciliationCache.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);

    tbody.innerHTML = rows.map(r => {
        const actualCash = getCashSalesForEmployeeDate(r.employeeId, r.date);
        const selisih = (r.inputAmount || 0) - actualCash;
        const dateObj = new Date(r.date + 'T00:00:00');
        const tglLabel = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const selisihClass = selisih === 0 ? 'text-emerald-600' : 'text-red-600';
        return `
        <tr class="border-b border-slate-100">
            <td class="p-3 font-semibold text-slate-700 whitespace-nowrap">${tglLabel}</td>
            <td class="p-3 text-slate-600 whitespace-nowrap">${r.employeeName || '-'}</td>
            <td class="p-3 text-right text-slate-600 whitespace-nowrap">Rp ${actualCash.toLocaleString()}</td>
            <td class="p-3 text-right text-slate-600 whitespace-nowrap">Rp ${(r.inputAmount || 0).toLocaleString()}</td>
            <td class="p-3 text-right font-bold ${selisihClass} whitespace-nowrap">${formatSelisih(selisih)}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="5" class="text-center p-6 text-slate-400 text-xs">Belum ada input sales</td></tr>`;
}

async function downloadCashReconciliationPDF() {
    const dateInput = document.getElementById('cashrek-date');
    const monthVal = (dateInput && dateInput.value) ? dateInput.value.slice(0, 7) : getTodayDateStr().slice(0, 7);
    const rows = cashReconciliationCache.filter(r => r.date.startsWith(monthVal)).sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length === 0) return alert('Tidak ada data input sales di bulan ini.');

    await ensureJsPDF();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const monthLabel = new Date(`${monthVal}-01T00:00:00`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    doc.text(`Input Total Penjualan - ${monthLabel}`, 10, 10);

    const data = rows.map(r => {
        const actualCash = getCashSalesForEmployeeDate(r.employeeId, r.date);
        const selisih = (r.inputAmount || 0) - actualCash;
        const dateObj = new Date(r.date + 'T00:00:00');
        const tglLabel = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        return [tglLabel, r.employeeName || '-', `Rp ${actualCash.toLocaleString()}`, `Rp ${(r.inputAmount || 0).toLocaleString()}`, formatSelisih(selisih)];
    });

    doc.autoTable({ head: [['Tgl/Bln/Thn', 'User', 'Cash Penjualan', 'Input', 'Selisih']], body: data, startY: 18 });
    doc.save(`Input-Sales-${monthVal}.pdf`);
}

// --- TOTAL PENJUALAN (dulu "Total Transaksi") — filter per karyawan & bulan, tabel harian ---
function renderTotalPenjualanFilterOptions() {
    const select = document.getElementById('report-filter-employee');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = '<option value="">Semua Karyawan</option>' + employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;

    // Default bulan filter = bulan berjalan (kalau belum pernah diisi)
    const monthInput = document.getElementById('report-filter-month');
    if (monthInput && !monthInput.value) monthInput.value = getTodayDateStr().slice(0, 7);
}

function getFilteredOrderHistory() {
    const empSelect = document.getElementById('report-filter-employee');
    const monthInput = document.getElementById('report-filter-month');
    const empId = empSelect ? empSelect.value : '';
    const monthVal = (monthInput && monthInput.value) ? monthInput.value : getTodayDateStr().slice(0, 7); // 'YYYY-MM'

    return orderHistory.filter(o => {
        if (empId && o.employeeId !== empId) return false;
        if (!o.timestamp || !getTodayDateStr(new Date(o.timestamp)).startsWith(monthVal)) return false;
        return true;
    });
}

// Kelompokkan transaksi per (tanggal + user) — satu baris tabel per hari per kasir, jadi
// "Semua Karyawan" otomatis menampilkan tiap kasir di baris terpisah per harinya, dan begitu
// admin pilih satu user, tabel tinggal ke-filter ke baris user itu saja.
// Diurutkan KRONOLOGIS (tanggal lama -> baru), jadi baris TOTAL wajar ditaruh di paling bawah.
function getMonthlySalesRows() {
    const filtered = getFilteredOrderHistory();
    const groups = {};
    filtered.forEach(o => {
        const dateStr = getTodayDateStr(new Date(o.timestamp));
        const userName = o.employeeName || 'Tanpa Nama';
        const key = dateStr + '|' + userName;
        if (!groups[key]) groups[key] = { date: dateStr, user: userName, total: 0, qty: 0 };
        groups[key].total += (o.total || 0);
        groups[key].qty += 1; // Qty = jumlah transaksi hari itu
    });
    return Object.values(groups).sort((a, b) => a.date === b.date ? a.user.localeCompare(b.user) : a.date.localeCompare(b.date));
}

function applyTotalPenjualanFilter() {
    const rows = getMonthlySalesRows();
    const tbody = document.getElementById('total-penjualan-body');
    if (!tbody) return;

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center p-6 text-slate-400 text-xs">Belum ada transaksi di bulan ini</td></tr>`;
        return;
    }

    const bodyRows = rows.map(r => {
        const dateObj = new Date(r.date + 'T00:00:00');
        const tglLabel = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const avg = r.qty > 0 ? Math.round(r.total / r.qty) : 0;
        return `
        <tr class="border-b border-slate-100">
            <td class="p-3 font-semibold text-slate-700 whitespace-nowrap">${tglLabel}</td>
            <td class="p-3 text-slate-600 whitespace-nowrap">${r.user}</td>
            <td class="p-3 text-right font-bold text-emerald-600 whitespace-nowrap">Rp ${r.total.toLocaleString()}</td>
            <td class="p-3 text-right text-slate-500">${r.qty}</td>
            <td class="p-3 text-right text-slate-500 whitespace-nowrap">Rp ${avg.toLocaleString()}</td>
        </tr>`;
    }).join('');

    // Baris TOTAL di paling bawah — Sales, Qty, dan Avg keseluruhan digabung dalam satu baris.
    const totalSales = rows.reduce((sum, r) => sum + r.total, 0);
    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
    const totalAvg = totalQty > 0 ? Math.round(totalSales / totalQty) : 0;
    const totalRow = `
    <tr class="bg-emerald-50 border-t-2 border-emerald-200">
        <td class="p-3 font-black text-emerald-800" colspan="2">TOTAL</td>
        <td class="p-3 text-right font-black text-emerald-800 whitespace-nowrap">Rp ${totalSales.toLocaleString()}</td>
        <td class="p-3 text-right font-black text-emerald-800">${totalQty}</td>
        <td class="p-3 text-right font-black text-emerald-800 whitespace-nowrap">Rp ${totalAvg.toLocaleString()}</td>
    </tr>`;

    tbody.innerHTML = bodyRows + totalRow;
}

function resetTotalPenjualanFilter() {
    const empSelect = document.getElementById('report-filter-employee');
    const monthInput = document.getElementById('report-filter-month');
    if (empSelect) empSelect.value = '';
    if (monthInput) monthInput.value = getTodayDateStr().slice(0, 7);
    applyTotalPenjualanFilter();
}

// --- PENJUALAN PRODUK (rincian per item, filter tanggal + user, 1 hari penuh) ---
function renderProductSalesFilterOptions() {
    const select = document.getElementById('prodsales-employee');
    const dateInput = document.getElementById('prodsales-date');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = '<option value="">Semua Karyawan</option>' + employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;

    // Default tanggal = hari ini (kalau belum pernah diisi)
    if (dateInput && !dateInput.value) dateInput.value = getTodayDateStr();
}

// Ambil semua transaksi PERSIS di 1 tanggal tertentu (bukan bulan), opsional difilter per kasir.
function getOrdersForDate(dateStr, empId) {
    return orderHistory.filter(o => {
        if (!o.timestamp) return false;
        if (getTodayDateStr(new Date(o.timestamp)) !== dateStr) return false;
        if (empId && o.employeeId !== empId) return false;
        return true;
    });
}

// Kelompokkan item yang terjual di tanggal itu per nama produk — paket varian (misal
// "Cireng Kuah Keju 4Pcs") dihitung sebagai barisnya sendiri, sama seperti yang tampil di
// keranjang, bukan dipecah ke komponen isinya.
function getProductSalesForDate(dateStr, empId) {
    const map = {};
    getOrdersForDate(dateStr, empId).forEach(o => {
        (o.items || []).forEach(item => {
            if (!map[item.name]) map[item.name] = { name: item.name, qty: 0, nominal: 0 };
            map[item.name].qty += item.qty;
            map[item.name].nominal += item.price * item.qty;
        });
    });
    return Object.values(map).sort((a, b) => b.qty - a.qty); // terlaris di atas
}

function renderProductSalesTable() {
    const dateInput = document.getElementById('prodsales-date');
    const empSelect = document.getElementById('prodsales-employee');
    const tbody = document.getElementById('prodsales-body');
    if (!tbody) return;

    const dateStr = (dateInput && dateInput.value) ? dateInput.value : getTodayDateStr();
    const empId = empSelect ? empSelect.value : '';
    const rows = getProductSalesForDate(dateStr, empId);

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="text-center p-6 text-slate-400 text-xs">Belum ada penjualan di tanggal ini</td></tr>`;
        return;
    }

    const bodyRows = rows.map(r => `
        <tr class="border-b border-slate-100">
            <td class="p-3 font-semibold text-slate-700">${r.name}</td>
            <td class="p-3 text-right text-slate-600">${r.qty}</td>
            <td class="p-3 text-right font-bold text-emerald-600 whitespace-nowrap">Rp ${r.nominal.toLocaleString()}</td>
        </tr>`).join('');

    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
    const totalNominal = rows.reduce((sum, r) => sum + r.nominal, 0);
    const totalRow = `
    <tr class="bg-emerald-50 border-t-2 border-emerald-200">
        <td class="p-3 font-black text-emerald-800">TOTAL</td>
        <td class="p-3 text-right font-black text-emerald-800">${totalQty}</td>
        <td class="p-3 text-right font-black text-emerald-800 whitespace-nowrap">Rp ${totalNominal.toLocaleString()}</td>
    </tr>`;

    tbody.innerHTML = bodyRows + totalRow;
}

// --- KELOLA STOCK (Admin) ---
// stock null/undefined = tidak dilacak (dianggap tidak terbatas, selalu bisa dijual)
function renderStockManageList() {
    const list = document.getElementById('stock-manage-list');
    if (!list) return;
    list.innerHTML = products.map(p => `
        <div class="flex items-center justify-between gap-3 bg-slate-50 border border-slate-100 rounded-xl p-3">
            <div class="min-w-0">
                <p class="font-bold text-sm text-slate-800 truncate">${p.name}</p>
                <p class="text-[10px] text-slate-400">${p.category}</p>
            </div>
            <input
                type="number"
                min="0"
                value="${p.stock ?? ''}"
                placeholder="∞"
                onchange="updateProductStock(${p.id}, this.value)"
                class="w-20 p-2 text-center border border-slate-200 rounded-lg outline-none text-sm font-bold shrink-0"
            >
        </div>
    `).join('') || '<p class="text-xs text-slate-400 text-center py-6">Belum ada produk</p>';
}

function updateProductStock(id, value) {
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) return;
    const updated = [...products];
    if (value === '' || value === null) {
        const { stock, ...rest } = updated[idx];
        updated[idx] = rest; // kosongkan = tidak dilacak / tidak terbatas
    } else {
        updated[idx] = { ...updated[idx], stock: Math.max(0, parseInt(value) || 0) };
    }
    saveProductsToFirestore(updated);
    showToast('Stock diperbarui!', 'success');
}

// Pakai Firestore transaction supaya aman kalau ada 2+ HP jual produk yang sama secara bersamaan
// (transaction otomatis baca data TERBARU dari server & retry kalau ada tabrakan, jadi stock
// tidak pernah salah kurang gara-gara race condition antar device).
//
// Item PAKET (punya variantSelections, misal "Cireng Kuah Keju" isi 4pcs) TIDAK mengurangi
// stock produk paketnya sendiri — melainkan mengurangi stock produk SATUAN yang dipilih di
// dalamnya (sesuai isi/rasa yang di-tap kasir). Ini berlaku otomatis untuk paket APAPUN yang
// dibuat Admin (bukan cuma "Cireng Kuah Keju"), karena logikanya generik berdasarkan
// variantSelections, bukan nama produk tertentu.
//
// `employeeId` (opsional) = kasir yang lagi absen saat transaksi ini dibuat. Kalau dia punya
// kuota harian khusus di produk tertentu (diatur Admin di "Katalog Per Karyawan"), pemakaian
// kuotanya ikut dicatat di koleksi 'kasirQuotaUsage' (terpisah dari stock global).
async function decreaseStockForOrder(items, employeeId) {
    if (!window.FB || !window.FB.ready) return;
    const { db, doc, runTransaction } = window.FB;
    const productsRef = doc(db, ...adminPathSegments('config', 'products'));

    const todayStr = getTodayDateStr();
    const usageRef = employeeId ? doc(db, ...adminPathSegments('kasirQuotaUsage', `${todayStr}_${employeeId}`)) : null;
    const employeeAssignments = employeeId ? (employeeCatalogCache[employeeId] || []) : [];
    const quotaProductIds = new Set(employeeAssignments.filter(a => a.qty != null).map(a => a.productId));

    try {
        await runTransaction(db, async (transaction) => {
            const snap = await transaction.get(productsRef);
            const usageSnap = usageRef ? await transaction.get(usageRef) : null; // semua read harus sebelum write
            const currentProducts = snap.exists() ? (snap.data().items || []) : [];
            const currentUsage = (usageSnap && usageSnap.exists()) ? (usageSnap.data().usage || {}) : {};

            const decreaseProductStock = (productId, qty) => {
                const idx = currentProducts.findIndex(p => p.id === productId);
                if (idx !== -1 && currentProducts[idx].stock != null) {
                    currentProducts[idx].stock = Math.max(0, currentProducts[idx].stock - qty);
                }
            };
            const addUsage = (productId, qty) => {
                if (!quotaProductIds.has(productId)) return; // cuma dilacak kalau memang ada kuota khusus di produk ini
                currentUsage[productId] = (currentUsage[productId] || 0) + qty;
            };

            items.forEach(item => {
                if (item.variantSelections && item.variantSelections.length) {
                    // PAKET: kurangi stock & kuota dari tiap produk satuan yang dipilih di dalamnya
                    item.variantSelections.forEach(sel => {
                        if (sel.id == null) return; // jaga-jaga data lama sebelum field id ditambahkan
                        const totalQty = sel.qty * item.qty;
                        decreaseProductStock(sel.id, totalQty);
                        addUsage(sel.id, totalQty);
                    });
                    // Kuota kasir di level paketnya sendiri (kalau Admin aturnya di situ, bukan di satuan)
                    addUsage(item.productId, item.qty);
                } else {
                    decreaseProductStock(item.id, item.qty);
                    addUsage(item.id, item.qty);
                }
            });

            transaction.set(productsRef, { items: currentProducts });
            if (usageRef) {
                transaction.set(usageRef, { date: todayStr, employeeId, usage: currentUsage }, { merge: true });
            }
        });
    } catch (err) {
        console.error('Gagal mengurangi stock:', err);
    }
}

// --- SALES ITEM (read-only, dibuka dari tombol di panel Menu Utama) ---
// Nama tombol & modal "Sales Item", tapi ID function/element tetap pakai nama lama
// (StockKasir) supaya tidak perlu ubah banyak referensi lain yang sudah stabil.
function openStockKasir() {
    renderStockKasir();
    const subtitle = document.getElementById('stock-kasir-subtitle');
    if (subtitle) {
        subtitle.innerText = currentSessionEmployeeName
            ? `Penjualan per item hari ini & sisa stock · ${currentSessionEmployeeName}`
            : 'Penjualan per item hari ini & sisa stock';
    }
    const modal = document.getElementById('modal-stock-kasir');
    modal.classList.remove('hidden');
    lucide.createIcons();
}

function closeStockKasir() {
    document.getElementById('modal-stock-kasir').classList.add('hidden');
}

// Jumlah terjual & total omzet HARI INI untuk satu produk, khusus milik kasir yang lagi
// login PIN sesi ini (bukan gabungan semua kasir) — sama seperti filter di "Sales Hari Ini".
// Item varian/paket (misal "Cireng Kuah Keju 4Pcs") disimpan di cart dengan field
// `productId` mengarah ke produk aslinya, sedangkan produk biasa pakai `id` langsung —
// makanya dicek productId dulu, baru fallback ke id.
function getTodaySalesForProduct(productId) {
    const empId = currentSessionEmployeeId;
    let qty = 0, revenue = 0;
    getTodaysOrders().forEach(order => {
        if (empId && order.employeeId !== empId) return; // bukan transaksi kasir ini, skip
        (order.items || []).forEach(item => {
            const itemProductId = item.productId != null ? item.productId : item.id;
            if (itemProductId === productId) {
                qty += item.qty;
                revenue += item.price * item.qty;
            }
        });
    });
    return { qty, revenue };
}

function renderStockKasir() {
    const body = document.getElementById('stock-kasir-body');
    if (!body) return;
    // Ikut katalog kasir yang lagi absen, sama seperti halaman menu utama.
    const visibleProducts = getVisibleProductsForCurrentKasir();
    body.innerHTML = visibleProducts.map(p => {
        const effectiveStock = getEffectiveStockForCurrentKasir(p);
        const hasStock = effectiveStock != null;
        const isEmpty = hasStock && effectiveStock <= 0;
        const badgeClass = isEmpty ? 'bg-red-100 text-red-600' : hasStock ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400';
        const stockLabel = hasStock ? effectiveStock : '∞';

        const { qty: soldQty, revenue: soldRevenue } = getTodaySalesForProduct(p.id);
        const salesCell = soldQty > 0
            ? `<span class="font-bold text-slate-700">${soldQty}x</span><br><span class="text-[10px] text-blue-600 font-semibold">Rp ${soldRevenue.toLocaleString()}</span>`
            : `<span class="text-slate-300 font-semibold">0</span>`;

        return `
        <tr class="border-b border-slate-50">
            <td class="p-3 font-semibold text-slate-700">${p.name}</td>
            <td class="p-3 text-right leading-tight">${salesCell}</td>
            <td class="p-3 text-right">
                <span class="${badgeClass} px-2.5 py-1 rounded-full font-bold text-[11px]">${stockLabel}</span>
            </td>
        </tr>`;
    }).join('') || `<tr><td colspan="3" class="text-center p-8 text-slate-400 text-xs">Belum ada produk</td></tr>`;
}

// --- TRANSAKSI FUNCTIONS ---
function addToCart(id) {
    const product = products.find(p => p.id === id);
    const existing = cart.find(item => item.id === id);
    if (existing) { existing.qty++; } else { cart.push({ ...product, qty: 1 }); }
    updateCartUI();
}

// Sama seperti addToCart, tapi kasih feedback visual: kartu produk "mengecil-sebentar" pas
// ditap, dan ikon keranjang di header ikut mantul — biar tap terasa direspon (bukan cuma
// angka badge yang tiba-tiba berubah).
function addToCartWithBump(evt, id) {
    addToCart(id);
    const card = evt.currentTarget;
    if (card) {
        card.classList.remove('card-bump');
        void card.offsetWidth; // restart animasi kalau tap berkali-kali cepat
        card.classList.add('card-bump');
    }
    const cartBtn = document.querySelector('button[onclick="openCheckout()"]');
    if (cartBtn) {
        cartBtn.classList.remove('cart-bump');
        void cartBtn.offsetWidth;
        cartBtn.classList.add('cart-bump');
    }
    if (navigator.vibrate) navigator.vibrate(15); // getar halus, cuma di HP yang support
}

// --- PILIH VARIAN/ISI (misal paket "Cireng Kuah Keju 4Pcs" -> pilih 4 rasa dari kategori "Cireng/Pcs") ---
let variantModalState = { product: null, options: [], selections: {} };

function openVariantModal(productId) {
    const product = products.find(p => p.id === productId);
    if (!product || !product.variantConfig || !product.variantConfig.enabled) return addToCart(productId);

    const sourceCategory = product.variantConfig.sourceCategory;
    // Pilihan isi/rasa juga ikut katalog kasir yang lagi absen, supaya isi paket yang bisa
    // dipilih tetap sesuai dengan produk yang memang diaktifkan Admin buat kasir tsb.
    const options = getVisibleProductsForCurrentKasir().filter(p => p.category === sourceCategory);

    if (options.length === 0) {
        return alert(`Belum ada menu di kategori "${sourceCategory}" untuk dipilih. Tambahkan dulu menunya lewat Admin Panel, atau aktifkan produk kategori tersebut untuk karyawan ini di "Katalog Per Karyawan".`);
    }

    variantModalState = { product, options, selections: {} };
    options.forEach(o => variantModalState.selections[o.id] = 0);

    document.getElementById('variant-title').innerText = `Pilih Isi - ${product.name}`;
    renderVariantOptions();
    document.getElementById('modal-variant').classList.remove('hidden');
    lucide.createIcons();
}

function closeVariantModal() {
    document.getElementById('modal-variant').classList.add('hidden');
}

function adjustVariantQty(optionId, delta) {
    const state = variantModalState;
    const required = state.product.variantConfig.count;
    const totalSelected = Object.values(state.selections).reduce((a, b) => a + b, 0);

    if (delta > 0 && totalSelected >= required) return; // sudah penuh, tidak bisa nambah lagi
    const next = (state.selections[optionId] || 0) + delta;
    if (next < 0) return;
    state.selections[optionId] = next;
    renderVariantOptions();
}

function renderVariantOptions() {
    const state = variantModalState;
    const required = state.product.variantConfig.count;
    const totalSelected = Object.values(state.selections).reduce((a, b) => a + b, 0);

    document.getElementById('variant-subtitle').innerText = `Dipilih ${totalSelected}/${required}`;
    document.getElementById('variant-options').innerHTML = state.options.map(o => `
        <div class="flex items-center justify-between bg-white p-4 rounded-2xl border border-slate-100">
            <span class="font-bold text-sm text-slate-800">${o.name}</span>
            <div class="flex items-center gap-3 bg-slate-50 p-1 rounded-xl font-bold">
                <button onclick="adjustVariantQty(${o.id}, -1)" class="qty-btn w-8 h-8 text-slate-400">-</button>
                <span>${state.selections[o.id] || 0}</span>
                <button onclick="adjustVariantQty(${o.id}, 1)" class="qty-btn w-8 h-8 text-slate-400">+</button>
            </div>
        </div>
    `).join('');

    const confirmBtn = document.getElementById('variant-confirm-btn');
    confirmBtn.disabled = totalSelected !== required;
    lucide.createIcons();
}

function confirmVariantSelection() {
    const state = variantModalState;
    const required = state.product.variantConfig.count;
    const totalSelected = Object.values(state.selections).reduce((a, b) => a + b, 0);
    if (totalSelected !== required) return;

    const chosen = state.options
        .filter(o => state.selections[o.id] > 0)
        .map(o => ({ id: o.id, name: o.name, qty: state.selections[o.id] })); // id dipakai buat kurangi stock satuan yang tepat

    cart.push({
        id: `v_${Date.now()}`,
        productId: state.product.id, // referensi ke produk asli, dipakai untuk pengurangan stock
        name: state.product.name,
        price: state.product.price,
        category: state.product.category,
        qty: 1,
        variantSelections: chosen
    });

    updateCartUI();
    closeVariantModal();
}

function updateQty(id, delta) {
    const item = cart.find(i => i.id == id); // '==' agar id numerik produk & id string varian ('v_...') tetap cocok
    if (item) {
        item.qty += delta;
        if (item.qty <= 0) cart = cart.filter(i => i.id != id);
    }
    updateCartUI();
    renderCartItems();
}

function updateCartUI() {
    const count = cart.reduce((sum, item) => sum + item.qty, 0);
    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    document.getElementById('cart-count').innerText = count;
    document.getElementById('total-price').innerText = `Rp ${total.toLocaleString()}`;
}

function openCheckout() {
    if (cart.length === 0) return alert('Pilih produk dulu!');
    document.getElementById('modal-checkout').classList.remove('hidden');
    renderCartItems();
}

function closeCheckout() {
    document.getElementById('modal-checkout').classList.add('hidden');
    selectedPayment = '';
    updatePaymentButtons();
    const cashInput = document.getElementById('cash-received-input');
    if (cashInput) cashInput.value = '';
    const cashBox = document.getElementById('cash-received-box');
    if (cashBox) cashBox.classList.add('hidden');
    const cashDisplay = document.getElementById('cash-change-display');
    if (cashDisplay) cashDisplay.innerHTML = '';
}

function renderCartItems() {
    const container = document.getElementById('cart-items');
    container.innerHTML = cart.map(item => {
        const variantNote = item.variantSelections
            ? `<p class="text-[11px] text-slate-500 mt-1">${item.variantSelections.map(v => `${v.name} x${v.qty}`).join(', ')}</p>`
            : '';
        return `
        <div class="flex items-center justify-between bg-white p-4 rounded-2xl border border-slate-100 text-sm">
            <div class="pr-3">
                <p class="font-bold text-slate-800">${item.name}</p>
                ${variantNote}
                <p class="text-blue-600 font-bold mt-1">Rp ${(item.price * item.qty).toLocaleString()}</p>
            </div>
            <div class="flex items-center gap-3 bg-slate-50 p-1 rounded-xl font-bold shrink-0">
                <button onclick="updateQty('${item.id}', -1)" class="qty-btn w-8 h-8 text-slate-400">-</button>
                <span>${item.qty}</span>
                <button onclick="updateQty('${item.id}', 1)" class="qty-btn w-8 h-8 text-slate-400">+</button>
            </div>
        </div>`;
    }).join('');
}

function setPayment(method) {
    selectedPayment = method;
    updatePaymentButtons();
    document.getElementById('confirm-pay').disabled = false;

    // Kalau metode QRIS dipilih, langsung tampilkan kode QRIS agar bisa discan pembeli
    if (method === 'QRIS') {
        showQrisModal();
    }

    // Input "Uang Diterima" cuma relevan untuk Cash — QRIS/Shopee nggak ada uang fisik
    // diterima jadi nggak ada konsep kembalian.
    const cashBox = document.getElementById('cash-received-box');
    if (cashBox) {
        cashBox.classList.toggle('hidden', method !== 'Cash');
        if (method === 'Cash') updateCashChangeDisplay();
    }
}

// Update tampilan kembalian secara real-time begitu kasir ngetik nominal uang diterima
function updateCashChangeDisplay() {
    const input = document.getElementById('cash-received-input');
    const display = document.getElementById('cash-change-display');
    if (!input || !display) return;
    const received = parseInt(input.value, 10) || 0;
    const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    const change = received - total;
    if (received === 0) {
        display.innerHTML = '';
        return;
    }
    display.innerHTML = change >= 0
        ? `<span class="text-slate-500">Kembalian</span><span class="text-emerald-600">Rp ${change.toLocaleString()}</span>`
        : `<span class="text-slate-500">Kurang</span><span class="text-red-500">Rp ${Math.abs(change).toLocaleString()}</span>`;
}

function updatePaymentButtons() {
    const btns = { 'Cash': 'btn-cash', 'QRIS': 'btn-qr', 'Shopee': 'btn-sf' };
    Object.values(btns).forEach(id => {
        document.getElementById(id).className = "pay-btn border-2 p-4 rounded-2xl text-[11px] font-bold bg-white border-slate-200 relative";
    });
    if (btns[selectedPayment]) {
        document.getElementById(btns[selectedPayment]).className = "pay-btn border-2 p-4 rounded-2xl text-[11px] font-bold bg-blue-50 border-blue-600 text-blue-700 relative";
    }

    // Ikon mata kecil di tombol QRIS untuk membuka ulang kode QR kapan saja setelah dipilih
    const qrisEye = document.getElementById('qris-eye');
    if (qrisEye) {
        qrisEye.classList.toggle('hidden', selectedPayment !== 'QRIS');
        qrisEye.classList.toggle('flex', selectedPayment === 'QRIS');
    }
    lucide.createIcons();
}

function showQrisModal() {
    document.getElementById('modal-qris').classList.remove('hidden');
    lucide.createIcons();
}

function closeQrisModal() {
    document.getElementById('modal-qris').classList.add('hidden');
}

// --- BUKTI PEMBAYARAN QRIS (foto -> simpan offline -> kirim WhatsApp Admin) ---
// Catatan teknis: browser TIDAK mengizinkan sebuah web app mengirim pesan/gambar WhatsApp
// secara diam-diam di background tanpa sentuhan pengguna (baik pakai Web Share API maupun
// link wa.me). Jadi alurnya: foto selalu tersimpan otomatis (walau offline), dan begitu ada
// koneksi + ada aksi pengguna (ambil foto, atau tap ikon kamera saat online kembali),
// aplikasi langsung membuka share/WhatsApp dengan sekali tap.

function getPendingProofs() {
    return JSON.parse(localStorage.getItem('pos_pending_proofs')) || [];
}

function savePendingProofs(list) {
    localStorage.setItem('pos_pending_proofs', JSON.stringify(list));
    updateProofBadge();
}

function updateProofBadge() {
    const count = getPendingProofs().length;
    const btn = document.getElementById('btn-proof');
    const badge = document.getElementById('proof-badge');
    if (!btn) return;
    btn.classList.toggle('hidden', count === 0);
    if (badge) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.toggle('hidden', count === 0);
    }
}

// Kompres foto sebelum disimpan supaya tidak cepat memenuhi kuota localStorage
function compressImage(file, maxWidth = 1000, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxWidth / img.width);
                const canvas = document.createElement('canvas');
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function dataUrlToFile(dataUrl, filename) {
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) { u8arr[n] = bstr.charCodeAt(n); }
    return new File([u8arr], filename, { type: mime });
}

let activeProofId = null; // proof yang sedang ditampilkan di modal aksi (kirim ke WhatsApp)

async function handleQrisPhotoCapture(event) {
    const file = event.target.files[0];
    event.target.value = ''; // reset supaya bisa ambil foto lagi nanti
    if (!file) return;

    const label = document.getElementById('qris-capture-label');
    label.innerHTML = `<i data-lucide="loader-2" class="w-5 h-5 animate-spin"></i> Menyimpan foto...`;
    lucide.createIcons();

    try {
        const dataUrl = await compressImage(file);
        const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
        const proof = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            dataUrl,
            total
        };

        const list = getPendingProofs();
        list.push(proof);
        savePendingProofs(list);

        closeQrisModal();

        if (navigator.onLine) {
            openProofActionModal(proof.id);
        } else {
            showToast('Offline - foto tersimpan. Nanti diingatkan untuk dikirim/disimpan saat online kembali.', 'warn');
        }
    } catch (err) {
        showToast('Gagal menyimpan foto, coba lagi.', 'warn');
    } finally {
        label.innerHTML = `<i data-lucide="camera" class="w-5 h-5"></i> Ambil Gambar/Foto`;
        lucide.createIcons();
    }
}

// --- MODAL PILIHAN TUJUAN (muncul begitu foto selesai diambil, saat online) ---
function openProofActionModal(proofId) {
    activeProofId = proofId;
    document.getElementById('modal-proof-action').classList.remove('hidden');
    lucide.createIcons();
}

function closeProofActionModal() {
    activeProofId = null;
    document.getElementById('modal-proof-action').classList.add('hidden');
}

function handleActionSend(channel) {
    const proof = getPendingProofs().find(p => p.id === activeProofId);
    closeProofActionModal();
    if (!proof) return;
    if (channel === 'wa') trySendProofWhatsApp(proof);
}

// --- KIRIM VIA WHATSAPP ---
async function trySendProofWhatsApp(proof) {
    const caption = `Bukti Pembayaran QRIS - ${STORE_NAME}\nWaktu: ${new Date(proof.timestamp).toLocaleString('id-ID')}\nNominal: Rp ${proof.total.toLocaleString()}`;
    const file = dataUrlToFile(proof.dataUrl, `bukti-qris-${proof.id}.jpg`);

    // Cara terbaik: Web Share API langsung ke WhatsApp (kalau didukung HP-nya)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title: 'Bukti Pembayaran QRIS',
                text: caption
            });
            removePendingProof(proof.id);
            showToast('Bukti pembayaran terkirim!', 'success');
            return;
        } catch (err) {
            if (err.name === 'AbortError') {
                // Kasir membatalkan share, foto tetap disimpan sebagai pending
                return;
            }
            // Kalau share gagal karena sebab lain, lanjut ke fallback di bawah
        }
    }

    // Fallback: buka chat WhatsApp Admin dengan teks siap kirim + unduh fotonya
    // (link wa.me tidak bisa melampirkan gambar otomatis, jadi foto diunduh untuk dilampirkan manual)
    const waLink = `https://wa.me/${ADMIN_WA_NUMBER}?text=${encodeURIComponent(caption + '\n\n(Mohon lampirkan foto bukti pembayaran yang otomatis terunduh)')}`;
    window.open(waLink, '_blank');

    const downloadLink = document.createElement('a');
    downloadLink.href = proof.dataUrl;
    downloadLink.download = `bukti-qris-${proof.id}.jpg`;
    downloadLink.click();

    removePendingProof(proof.id);
    showToast('WhatsApp Admin dibuka & foto terunduh. Silakan lampirkan fotonya.', 'success');
}

function removePendingProof(id) {
    const list = getPendingProofs().filter(p => p.id !== id);
    savePendingProofs(list);
    if (document.getElementById('modal-proof-list') && !document.getElementById('modal-proof-list').classList.contains('hidden')) {
        renderProofList();
    }
}

function openPendingProofs() {
    renderProofList();
    document.getElementById('modal-proof-list').classList.remove('hidden');
    lucide.createIcons();
}

function closePendingProofs() {
    document.getElementById('modal-proof-list').classList.add('hidden');
}

function proofActionFromList(id, channel) {
    const proof = getPendingProofs().find(p => p.id === id);
    if (!proof) return;
    if (channel === 'wa') trySendProofWhatsApp(proof);
}

function renderProofList() {
    const list = getPendingProofs();
    const body = document.getElementById('proof-list-body');
    body.innerHTML = list.map(p => `
        <div class="border border-slate-100 rounded-2xl overflow-hidden">
            <img src="${p.dataUrl}" class="w-full h-40 object-cover">
            <div class="p-4">
                <p class="text-xs text-slate-500 font-semibold">${new Date(p.timestamp).toLocaleString('id-ID')}</p>
                <p class="text-blue-600 font-black text-sm mt-0.5">Rp ${p.total.toLocaleString()}</p>
                <div class="flex gap-2 mt-3">
                    <button onclick="removePendingProof(${p.id})" class="bg-red-50 text-red-500 p-3 rounded-xl shrink-0"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                    <button onclick="proofActionFromList(${p.id}, 'wa')" class="flex-1 bg-emerald-500 text-white py-3 rounded-xl font-bold text-[11px] flex items-center justify-center gap-1.5">
                        <i data-lucide="message-circle" class="w-4 h-4"></i> WhatsApp
                    </button>
                </div>
            </div>
        </div>
    `).join('') || `<p class="text-center text-slate-400 text-sm py-10">Tidak ada bukti pembayaran yang menunggu dikirim/disimpan</p>`;
    lucide.createIcons();
}

// --- ABSENSI KARYAWAN (wajib absen masuk sesuai jadwal masing-masing, absen pulang self-service) ---
// Cache lokal yang diisi lewat Firestore onSnapshot listener (lihat initFirestoreSync)
let cachedQrToken = null;
let attendanceLogCache = [];
let employeesCache = [];
let cashReconciliationCache = []; // input manual "Total Penjualan Hari Ini" per (tanggal, karyawan)

// --- KATALOG PER KARYAWAN (multi akun kasir) ---
// employeeCatalogCache: { [employeeId]: [ { productId, qty } ] }
//   - productId ada di array ini artinya produk itu DIAKTIFKAN buat karyawan tsb.
//   - qty null/undefined = aktif tapi TANPA kuota khusus (ikut stock global apa adanya).
//   - qty angka = kuota harian khusus buat karyawan ini di produk ini.
// kasirQuotaUsageCache: [{ date, employeeId, usage: { [productId]: qtyTerjualHariIni } }]
//   Dipakai buat lacak pemakaian kuota harian. Karena doc ID-nya berbasis tanggal (sama pola
//   dengan absensi), kuota otomatis "reset" tiap ganti hari tanpa perlu job reset manual.
let employeeCatalogCache = {};
let kasirQuotaUsageCache = [];

// --- LOGIN PIN SESI (beda dengan absen harian di bawah!) ---
// Ini identitas SESI BROWSER SAAT INI: siapa yang sedang pegang HP/perangkat ini. Selalu
// harus login ulang (pilih nama + PIN 4 digit) tiap kali halaman di-refresh, karena disimpan
// di variabel JS biasa (BUKAN localStorage/sessionStorage) yang otomatis kosong lagi tiap kali
// script dimuat ulang. Inilah yang dipakai untuk tentukan katalog produk siapa yang tampil,
// dan siapa yang tercatat sebagai kasir di setiap transaksi — terpisah dari absen QR harian
// (yang tetap ada, untuk keperluan jam k                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       