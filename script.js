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

// --- SINKRONISASI FIRESTORE (database bersama, real-time ke semua HP) ---
function initFirestoreSync() {
    if (firestoreListenersReady) return; // hindari daftar listener dua kali
    firestoreListenersReady = true;
    const { db, doc, collection, onSnapshot, query, orderBy } = window.FB;

    // --- Produk (satu dokumen berisi array semua produk) ---
    onSnapshot(doc(db, 'config', 'products'), (snap) => {
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
    onSnapshot(doc(db, 'config', 'categories'), (snap) => {
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
    const salesQuery = query(collection(db, 'sales'), orderBy('timestamp', 'desc'));
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

    // --- Karyawan (daftar nama & PIN, dipakai buat identifikasi saat login/absen) ---
    onSnapshot(doc(db, 'config', 'employees'), (snap) => {
        trackPendingWrites(snap);
        employeesCache = (snap.exists() && Array.isArray(snap.data().items)) ? snap.data().items : [];
        try {
            renderEmployeeList();
            renderScheduleTable(); // nama karyawan dipakai untuk baris tabel jadwal
            renderRiwayatAbsenEmployeeSelect();
            if (!pinLockResolved) { renderPinLockUserList(); tryShowPinLock(); } // daftar user di layar kunci ikut sinkron
        } catch (err) {
            console.error('Error saat render data karyawan:', err);
        }
    }, (err) => console.error('Sync karyawan gagal:', err));

    // --- Katalog Per Karyawan (produk & kuota kustom per kasir, diatur Admin) ---
    onSnapshot(doc(db, 'config', 'employeeCatalog'), (snap) => {
        trackPendingWrites(snap);
        employeeCatalogCache = snap.exists() ? snap.data() : {};
        renderCategoryTabs(); // ikut refresh tab kategori & katalog kasir yang lagi aktif
        if (document.getElementById('page-admin') && !document.getElementById('page-admin').classList.contains('hidden')) {
            renderEmployeeCatalogEditor();
        }
    }, (err) => console.error('Sync katalog karyawan gagal:', err));

    // --- Pemakaian Kuota Harian Kasir (dilacak per tanggal, otomatis "reset" tiap ganti hari) ---
    onSnapshot(collection(db, 'kasirQuotaUsage'), (snap) => {
        trackPendingWrites(snap);
        kasirQuotaUsageCache = snap.docs.map(d => d.data());
        renderCatalog();
    }, (err) => console.error('Sync kuota kasir gagal:', err));

    // --- Jadwal Kerja Karyawan (tabel nama x tanggal, koleksi per tanggal) ---
    onSnapshot(collection(db, 'schedule'), (snap) => {
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
    onSnapshot(doc(db, 'config', 'attendanceSettings'), (snap) => {
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
    onSnapshot(doc(db, 'config', 'storeProfile'), (snap) => {
        trackPendingWrites(snap);
        if (snap.exists() && snap.data().name) {
            STORE_NAME = snap.data().name;
            applyStoreName();
        }
    }, (err) => console.error('Sync profile toko gagal:', err));

    // --- Token QR Absen ---
    onSnapshot(doc(db, 'config', 'attendanceQrToken'), (snap) => {
        trackPendingWrites(snap);
        cachedQrToken = snap.exists() ? snap.data().token : null;
        renderAttendanceQR();
    }, (err) => console.error('Sync QR absen gagal:', err));

    // --- Riwayat Absensi (koleksi, doc ID = tanggal) ---
    onSnapshot(collection(db, 'attendance'), (snap) => {
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

// --- SYNC ADMIN-ONLY (baru dipasang saat Admin Panel pertama kali dibuka, bukan sejak init()) ---
let adminOnlyFirestoreSyncReady = false;
function initAdminOnlyFirestoreSync() {
    if (adminOnlyFirestoreSyncReady) return; // hindari daftar listener dua kali tiap buka Admin Panel
    if (!window.FB || !window.FB.ready) return; // belum konek, coba lagi nanti pas showPage('admin') dipanggil ulang
    adminOnlyFirestoreSyncReady = true;
    const { db, collection, onSnapshot } = window.FB;

    onSnapshot(collection(db, 'cashReconciliation'), (snap) => {
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
    setDoc(doc(db, 'config', 'products'), { items: newProducts }).catch((err) => {
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
    setDoc(doc(db, 'config', 'categories'), { items: newCategories }).catch((err) => {
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
    setDoc(doc(db, 'cashReconciliation', `${dateStr}_${empId}`), {
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
    const productsRef = doc(db, 'config', 'products');

    const todayStr = getTodayDateStr();
    const usageRef = employeeId ? doc(db, 'kasirQuotaUsage', `${todayStr}_${employeeId}`) : null;
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
// (yang tetap ada, untuk keperluan jam kerja/HR).
let currentSessionEmployeeId = null;
let currentSessionEmployeeName = null;
let pinLockResolved = false;
let pinLockPendingEmployee = null; // { id, name } — dipilih di step 1, dipakai buat cek PIN di step 2
let pinLockEnteredDigits = '';

// Karyawan yang lagi login sesi ini (lewat layar kunci PIN) — inilah yang menentukan katalog
// produk apa saja yang tampil di halaman Kasir saat ini, dan siapa yang tercatat di transaksi.
function getCurrentKasirEmployeeId() {
    return currentSessionEmployeeId;
}

// Kalau karyawan yang lagi aktif SAMA SEKALI belum diatur di "Katalog Per Karyawan" oleh Admin,
// dianggap belum dikonfigurasi -> tampilkan semua produk seperti biasa (supaya tidak macet/kosong).
function getVisibleProductsForCurrentKasir() {
    const empId = getCurrentKasirEmployeeId();
    if (!empId) return products; // Admin / belum ada kasir yang absen -> semua produk
    const assigned = employeeCatalogCache[empId];
    if (!assigned || assigned.length === 0) return products; // belum diatur Admin -> default semua produk
    const assignedIds = new Set(assigned.map(a => a.productId));
    return products.filter(p => assignedIds.has(p.id));
}

// Tab kategori ikut mengikuti: kalau katalog kasir ini difilter, tab yang ditampilkan cuma
// kategori yang memang punya produk buat kasir tsb (biar tidak ada tab kosong melompong).
function getVisibleCategoriesForCurrentKasir() {
    const visibleProducts = getVisibleProductsForCurrentKasir();
    if (visibleProducts.length === products.length) return categories; // tidak difilter -> semua kategori
    const activeCats = new Set(visibleProducts.map(p => p.category));
    const filtered = categories.filter(c => activeCats.has(c));
    return filtered.length > 0 ? filtered : categories; // jaga-jaga jangan sampai tab kosong total
}

function getKasirUsageToday(employeeId, productId) {
    const todayStr = getTodayDateStr();
    const rec = kasirQuotaUsageCache.find(r => r.date === todayStr && r.employeeId === employeeId);
    return (rec && rec.usage && rec.usage[productId]) || 0;
}

// Stock yang BENERAN boleh dijual SAAT INI oleh kasir yang lagi absen: gabungan antara stock
// global produk & kuota harian khusus (kalau Admin mengatur kuota buat karyawan ini di produk
// ini). Diambil yang PALING KECIL supaya kedua batasan itu sama-sama dihormati.
function getEffectiveStockForCurrentKasir(product) {
    const empId = getCurrentKasirEmployeeId();
    if (!empId) return product.stock; // Admin / belum ada kasir aktif -> stock global apa adanya
    const assigned = employeeCatalogCache[empId];
    const entry = assigned && assigned.find(a => a.productId === product.id);
    if (!entry || entry.qty == null) return product.stock; // tidak ada kuota khusus -> ikut stock global
    const usedToday = getKasirUsageToday(empId, product.id);
    const remainingQuota = Math.max(0, entry.qty - usedToday);
    if (product.stock == null) return remainingQuota;
    return Math.min(product.stock, remainingQuota);
}

// --- LAYAR KUNCI PIN (tampil sampai user pilih nama + masukkan PIN yang benar) ---
function tryShowPinLock() {
    if (!attendanceSettingsLoaded || !attendanceLogLoaded) return; // tunggu koneksi awal beres dulu
    if (pinLockResolved || adminPanelOpen) return;
    renderPinLockUserList();
    const el = document.getElementById('pin-lock-screen');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    lucide.createIcons();
}

function renderPinLockUserList() {
    const list = document.getElementById('pin-lock-user-list');
    if (!list) return;
    list.innerHTML = employeesCache.map(emp => `
        <button onclick="pinLockSelectUser('${emp.id}', '${emp.name.replace(/'/g, "\\'")}')" class="w-full bg-white/15 hover:bg-white/25 border border-white/20 rounded-2xl p-4 text-left font-bold text-white flex items-center justify-between transition">
            ${emp.name}
            <i data-lucide="chevron-right" class="w-4 h-4 text-white/60"></i>
        </button>
    `).join('') || '<p class="text-xs text-white/70">Admin belum menambahkan karyawan. Hubungi Admin.</p>';
    lucide.createIcons();
}

function pinLockSelectUser(id, name) {
    pinLockPendingEmployee = { id, name };
    pinLockEnteredDigits = '';
    document.getElementById('pin-lock-greeting').innerText = `Halo, ${name}!`;
    document.getElementById('pin-lock-error').innerText = '';
    document.getElementById('pin-lock-step-user').classList.add('hidden');
    document.getElementById('pin-lock-step-pin').classList.remove('hidden');
    renderPinLockDots();
    lucide.createIcons();
}

function pinLockBackToUserList() {
    pinLockPendingEmployee = null;
    pinLockEnteredDigits = '';
    document.getElementById('pin-lock-step-pin').classList.add('hidden');
    document.getElementById('pin-lock-step-user').classList.remove('hidden');
}

function renderPinLockDots() {
    const dots = document.querySelectorAll('#pin-lock-dots .pin-dot');
    dots.forEach((dot, idx) => dot.classList.toggle('filled', idx < pinLockEnteredDigits.length));
}

function pinLockInput(digit) {
    if (pinLockEnteredDigits.length >= 4) return;
    pinLockEnteredDigits += digit;
    renderPinLockDots();
    if (pinLockEnteredDigits.length === 4) {
        setTimeout(pinLockVerify, 150); // jeda kecil biar dot terakhir sempat kelihatan keisi dulu
    }
}

function pinLockBackspace() {
    pinLockEnteredDigits = pinLockEnteredDigits.slice(0, -1);
    document.getElementById('pin-lock-error').innerText = '';
    renderPinLockDots();
}

function pinLockVerify() {
    const emp = employeesCache.find(e => e.id === pinLockPendingEmployee.id);
    if (emp && emp.pin === pinLockEnteredDigits) {
        currentSessionEmployeeId = emp.id;
        currentSessionEmployeeName = emp.name;
        pinLockResolved = true;
        pinLockPendingEmployee = null;
        pinLockEnteredDigits = '';
        const el = document.getElementById('pin-lock-screen');
        el.classList.add('hidden');
        el.classList.remove('flex');
        showToast(`Selamat bekerja, ${emp.name}!`, 'success');
        renderCategoryTabs(); // katalog kasir ikut menyesuaikan user yang baru login
        renderHomeGreeting();
        checkMandatoryMasukGate();
    } else {
        document.getElementById('pin-lock-error').innerText = 'PIN salah, coba lagi.';
        pinLockEnteredDigits = '';
        renderPinLockDots();
    }
}

// Sapaan di kartu biru halaman Kasir — nama User kasir yang lagi login sesi ini (lewat PIN).
function renderHomeGreeting() {
    const nameEl = document.getElementById('home-greeting-name');
    if (nameEl) nameEl.innerText = currentSessionEmployeeName || '-';
}

// Dipakai tombol "Ganti User" di header — logout sesi kasir saat ini tanpa perlu refresh browser.
function lockPinSession() {
    if (adminPanelOpen) return; // tidak relevan buat Admin
    currentSessionEmployeeId = null;
    currentSessionEmployeeName = null;
    pinLockResolved = false;
    pinLockPendingEmployee = null;
    pinLockEnteredDigits = '';
    document.getElementById('pin-lock-step-pin').classList.add('hidden');
    document.getElementById('pin-lock-step-user').classList.remove('hidden');
    renderHomeGreeting();
    tryShowPinLock();
}

// Doc 'config/attendanceSettings' & `cachedAttendanceSettings` disisakan (walau sudah tidak ada
// isi jam yang dikonfigurasi lagi — jam masuk sekarang per karyawan lewat Jadwal Kerja Karyawan,
// dan jam pulang sudah self-service kapan saja) semata sebagai penanda "data awal termuat" untuk
// gerbang koneksi (lihat tryCloseConnectingGate & attendanceSettingsLoaded).

// --- KELOLA KARYAWAN ---
function renderEmployeeList() {
    const list = document.getElementById('employee-list');
    if (!list) return;
    list.innerHTML = employeesCache.map(emp => `
        <div class="bg-white border border-slate-100 rounded-xl p-2.5">
            <div class="flex items-center justify-between">
                <span class="font-bold text-sm text-slate-800">${emp.name}</span>
                <div class="flex items-center gap-1">
                    <button onclick="editEmployeeContact('${emp.id}')" class="text-blue-500 hover:bg-blue-50 p-1.5 rounded-lg transition" title="Alamat & No. Telp (buat struk)">
                        <i data-lucide="map-pin" class="w-4 h-4"></i>
                    </button>
                    <button onclick="changeEmployeePin('${emp.id}')" class="text-indigo-500 hover:bg-indigo-50 p-1.5 rounded-lg transition" title="Ubah PIN">
                        <i data-lucide="key-round" class="w-4 h-4"></i>
                    </button>
                    <button onclick="deleteEmployee('${emp.id}')" class="text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </div>
            </div>
            ${emp.address ? `<p class="text-[10px] text-slate-400 mt-1 leading-snug">${emp.address}${emp.phone ? ` · Hp. ${emp.phone}` : ''}</p>` : ''}
        </div>
    `).join('') || '<p class="text-xs text-slate-400">Belum ada karyawan ditambahkan</p>';
    lucide.createIcons();
    renderEmployeeCatalogSelect(); // dropdown Katalog Per Karyawan ikut sinkron dgn daftar karyawan
}

function saveEmployeesToFirestore(newList) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
        return;
    }
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, 'config', 'employees'), { items: newList }).catch((err) => {
        console.error('Gagal simpan karyawan:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

// PIN 4 digit dipakai buat login sesi kasir (layar kunci PIN). Disimpan apa adanya di data
// karyawan — cukup buat mencegah orang asal pilih nama teman kerja, bukan pengganti keamanan
// tingkat bank (perangkatnya toh fisik dipegang langsung oleh tim di toko).
function addEmployee() {
    const nameInput = document.getElementById('new-employee-name');
    const pinInput = document.getElementById('new-employee-pin');
    const name = nameInput.value.trim();
    const pin = pinInput.value.trim();
    if (!name) return alert('Nama karyawan tidak boleh kosong!');
    if (!/^\d{4}$/.test(pin)) return alert('PIN wajib 4 digit angka!');
    if (employeesCache.some(e => e.name.toLowerCase() === name.toLowerCase())) {
        return alert('Nama karyawan tersebut sudah ada!');
    }
    const newEmployee = { id: 'emp_' + Date.now(), name, pin };
    saveEmployeesToFirestore([...employeesCache, newEmployee]);
    nameInput.value = '';
    pinInput.value = '';
}

// Terapkan STORE_NAME ke semua tempat yang menampilkannya secara statis di DOM (h1 header,
// judul tab browser). Bagian yang di-generate dinamis (struk, WhatsApp, PDF) otomatis ikut
// berubah sendiri karena mereka baca variabel STORE_NAME langsung tiap kali dibuat, tidak
// perlu disentuh di sini.
function applyStoreName() {
    const headerEl = document.getElementById('store-name-header');
    if (headerEl) headerEl.innerText = STORE_NAME;
    document.title = `POS KASIR - ${STORE_NAME}`;
    const nameInput = document.getElementById('store-name-input');
    // Cuma isi otomatis kalau field-nya lagi kosong/belum disentuh admin, supaya tidak
    // menimpa ketikan admin yang lagi berlangsung kalau snapshot update di tengah proses ketik.
    if (nameInput && document.activeElement !== nameInput) nameInput.value = STORE_NAME;
}

function saveStoreProfile() {
    const input = document.getElementById('store-name-input');
    const newName = input ? input.value.trim() : '';
    if (!newName) return alert('Nama toko tidak boleh kosong!');
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, 'config', 'storeProfile'), { name: newName }).then(() => {
        showToast('Nama toko berhasil disimpan.', 'success');
    }).catch((err) => {
        console.error('Gagal simpan profile toko:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

// Alamat & No. Telp per karyawan/kasir — dipakai di struk (ganti tagline "Digital Point of
// Sales" dengan alamat kasir yang lagi jualan), karena tiap kasir ternyata punya alamat toko
// sendiri-sendiri (bukan 1 alamat toko pusat yang sama buat semua).
function editEmployeeContact(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;
    const newAddress = prompt(`Alamat untuk ${emp.name} (tampil di struk):`, emp.address || '');
    if (newAddress === null) return; // batal
    const newPhone = prompt(`No. Telp untuk ${emp.name} (tampil di struk):`, emp.phone || '');
    if (newPhone === null) return; // batal
    saveEmployeesToFirestore(employeesCache.map(e => e.id === id ? { ...e, address: newAddress.trim(), phone: newPhone.trim() } : e));
}

function changeEmployeePin(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;
    const newPin = prompt(`PIN baru buat ${emp.name} (4 digit angka):`, '');
    if (newPin === null) return; // batal
    if (!/^\d{4}$/.test(newPin.trim())) return alert('PIN wajib 4 digit angka!');
    saveEmployeesToFirestore(employeesCache.map(e => e.id === id ? { ...e, pin: newPin.trim() } : e));
}

function deleteEmployee(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;
    if (!confirm(`Hapus karyawan "${emp.name}"?`)) return;
    saveEmployeesToFirestore(employeesCache.filter(e => e.id !== id));
}

// --- KATALOG PER KARYAWAN (produk & kuota harian khusus per kasir, multi akun) ---
// Isi dropdown pilih karyawan, lalu render checklist produk buat karyawan yang lagi dipilih.
// Dipanggil ulang setiap kali daftar karyawan / produk / katalog karyawan berubah.
function renderEmployeeCatalogSelect() {
    const select = document.getElementById('empcat-employee-select');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('') || '<option value="">Belum ada karyawan</option>';
    if (employeesCache.some(e => e.id === prevValue)) select.value = prevValue;
    renderEmployeeCatalogEditor();
}

function renderEmployeeCatalogEditor() {
    const list = document.getElementById('empcat-product-list');
    if (!list) return;
    const select = document.getElementById('empcat-employee-select');
    const empId = select ? select.value : '';

    if (employeesCache.length === 0) {
        list.innerHTML = '<p class="text-xs text-slate-400 text-center py-6">Tambahkan karyawan dulu di "Kelola Karyawan".</p>';
        return;
    }
    if (!empId) {
        list.innerHTML = '<p class="text-xs text-slate-400 text-center py-6">Pilih karyawan dulu.</p>';
        return;
    }

    const assigned = employeeCatalogCache[empId] || [];
    const assignedMap = {};
    assigned.forEach(a => { assignedMap[a.productId] = a.qty; });

    list.innerHTML = products.map(p => {
        const isAssigned = Object.prototype.hasOwnProperty.call(assignedMap, p.id);
        const qty = assignedMap[p.id];
        return `
        <div class="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-xl p-2.5">
            <input type="checkbox" data-empcat-product="${p.id}" ${isAssigned ? 'checked' : ''} class="empcat-checkbox w-4 h-4 accent-pink-600 shrink-0">
            <div class="min-w-0 flex-1">
                <p class="font-bold text-xs text-slate-800 truncate">${p.name}</p>
                <p class="text-[10px] text-slate-400">${p.category}</p>
            </div>
            <input type="number" min="0" data-empcat-qty="${p.id}" value="${qty ?? ''}" placeholder="∞" title="Kuota harian khusus (kosongkan = ikut stock global)" class="w-16 p-1.5 text-center border border-slate-200 rounded-lg outline-none text-xs font-bold shrink-0">
        </div>`;
    }).join('') || '<p class="text-xs text-slate-400 text-center py-6">Belum ada produk di katalog. Tambahkan produk dulu.</p>';
    lucide.createIcons();
}

function saveEmployeeCatalog() {
    const select = document.getElementById('empcat-employee-select');
    const empId = select ? select.value : '';
    if (!empId) return alert('Pilih karyawan dulu!');
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const assigned = [];
    document.querySelectorAll('.empcat-checkbox:checked').forEach(cb => {
        const productId = parseInt(cb.getAttribute('data-empcat-product'));
        const qtyInput = document.querySelector(`[data-empcat-qty="${productId}"]`);
        const qtyRaw = qtyInput ? qtyInput.value : '';
        const qty = qtyRaw === '' ? null : Math.max(0, parseInt(qtyRaw) || 0);
        assigned.push({ productId, qty });
    });

    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, 'config', 'employeeCatalog'), { [empId]: assigned }, { merge: true }).then(() => {
        const empName = (employeesCache.find(e => e.id === empId) || {}).name || '';
        showToast(`Katalog untuk ${empName} tersimpan!`, 'success');
    }).catch((err) => {
        console.error('Gagal simpan katalog karyawan:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

// --- JADWAL KERJA KARYAWAN (TABEL: NAMA x TANGGAL, per sel = jam masuk) ---
// scheduleCache: { 'YYYY-MM-DD': { date, employees: [ { id, jamMulai } ] } }
// Jam KELUAR sengaja tidak diatur di sini — itu dicatat manual oleh kasir sendiri saat
// selesai kerja (lewat tombol Absen Keluar), bukan diatur Admin di jadwal.
let scheduleCache = {};
let scheduleViewDate = new Date(); // bulan yang sedang ditampilkan di tabel
let scheduleEditingEmployeeId = null; // dipakai sementara selagi modal edit sel jadwal terbuka
let scheduleEditingDateStr = null;

function scheduleDateStr(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function changeScheduleMonth(delta) {
    scheduleViewDate.setMonth(scheduleViewDate.getMonth() + delta);
    scheduleViewDate = new Date(scheduleViewDate); // trigger objek baru biar gampang di-render ulang
    renderScheduleTable();
}

// Tabel jadwal: baris = nama karyawan, kolom = tanggal 1..akhir bulan (scroll ke kanan-kiri
// di layar HP). Tap satu sel buat atur jam masuk karyawan itu di tanggal itu.
function renderScheduleTable() {
    const wrap = document.getElementById('schedule-table-wrap');
    const label = document.getElementById('schedule-month-label');
    if (!wrap || !label) return;

    const year = scheduleViewDate.getFullYear();
    const month = scheduleViewDate.getMonth();
    label.innerText = scheduleViewDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    if (employeesCache.length === 0) {
        wrap.innerHTML = '<p class="text-xs text-slate-400 text-center py-10">Tambahkan karyawan dulu di atas.</p>';
        return;
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = getTodayDateStr();

    let headerCells = '';
    for (let d = 1; d <= daysInMonth; d++) {
        const isToday = scheduleDateStr(year, month, d) === todayStr;
        headerCells += `<th class="schedule-table-date-col ${isToday ? 'is-today' : ''}">${d}</th>`;
    }

    const bodyRows = employeesCache.map(emp => {
        let cells = '';
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = scheduleDateStr(year, month, d);
            const entry = scheduleCache[dateStr];
            const empEntry = entry && entry.employees ? entry.employees.find(e => e.id === emp.id) : null;
            const isToday = dateStr === todayStr;
            const isLibur = !!(empEntry && empEntry.libur); // NEW
            const cellLabel = isLibur ? 'LIBUR' : (empEntry ? empEntry.jamMulai : ''); // NEW
            const cellClass = isLibur ? 'is-libur' : (empEntry ? 'is-scheduled' : ''); // NEW (ganti baris di bawah)
            cells += `<td onclick="openScheduleCellEditor('${emp.id}', '${dateStr}')" class="schedule-table-cell ${cellClass} ${isToday ? 'is-today' : ''}">${cellLabel}</td>`;
        }
        return `<tr><td class="schedule-table-name-col">${emp.name}</td>${cells}</tr>`;
    }).join('');

    wrap.innerHTML = `
    <table class="schedule-table">
        <thead><tr><th class="schedule-table-name-col">Nama</th>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
    </table>`;
}

// Diklik dari sel tabel — buka modal kecil buat atur/hapus jam masuk karyawan di tanggal itu.
function openScheduleCellEditor(empId, dateStr) {
    scheduleEditingEmployeeId = empId;
    scheduleEditingDateStr = dateStr;

    const emp = employeesCache.find(e => e.id === empId);
    const entry = scheduleCache[dateStr];
    const empEntry = entry && entry.employees ? entry.employees.find(e => e.id === empId) : null;
    const dateObj = new Date(dateStr + 'T00:00:00');
    const isLibur = !!(empEntry && empEntry.libur); // NEW: cek status libur

    document.getElementById('schedule-cell-title').innerText = `${emp ? emp.name : ''} — ${dateObj.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}`;
    document.getElementById('schedule-cell-jam-masuk').value = (empEntry && !isLibur) ? (empEntry.jamMulai || '') : '';
    document.getElementById('schedule-cell-jam-masuk').disabled = isLibur; // NEW: kunci input jam kalau lagi ditandai libur
    document.getElementById('schedule-cell-remove-btn').classList.toggle('hidden', !empEntry);

    // NEW: tombol "Tandai Libur" ganti teks/warna sesuai status saat ini
    const liburBtn = document.getElementById('schedule-cell-libur-btn');
    liburBtn.innerText = isLibur ? 'Batal Libur' : 'Tandai Libur';
    liburBtn.classList.toggle('is-active', isLibur);

    document.getElementById('modal-schedule-cell').classList.remove('hidden');
    document.getElementById('modal-schedule-cell').classList.add('flex');
    lucide.createIcons();
}

function closeScheduleCellEditor() {
    document.getElementById('modal-schedule-cell').classList.add('hidden');
    document.getElementById('modal-schedule-cell').classList.remove('flex');
    scheduleEditingEmployeeId = null;
    scheduleEditingDateStr = null;
}

function saveScheduleCellJamMasuk() {
    if (!scheduleEditingEmployeeId || !scheduleEditingDateStr) return;
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database.', 'warn');

    const jamMulai = document.getElementById('schedule-cell-jam-masuk').value;
    if (!jamMulai) return alert('Isi jam masuk kerjanya!');

    const { db, doc, setDoc } = window.FB;
    const empId = scheduleEditingEmployeeId;
    const dateStr = scheduleEditingDateStr;
    const existing = (scheduleCache[dateStr] && scheduleCache[dateStr].employees) || [];
    // libur TIDAK disertakan lagi di sini -> otomatis batal libur begitu diisi jam masuk
    const updatedEmployees = [...existing.filter(e => e.id !== empId), { id: empId, jamMulai }];

    setDoc(doc(db, 'schedule', dateStr), { date: dateStr, employees: updatedEmployees }).then(() => {
        showToast('Jadwal tersimpan!', 'success');
        closeScheduleCellEditor();
    }).catch((err) => {
        console.error('Gagal simpan jadwal:', err);
        showToast('Gagal menyimpan jadwal ke server.', 'warn');
    });
}

// NEW: tandai/batal-tandai satu sel sebagai LIBUR. Kalau ditandai libur, jamMulai dihapus
// (libur = tidak kerja, jadi tidak relevan punya jam masuk).
function toggleScheduleCellLibur() {
    if (!scheduleEditingEmployeeId || !scheduleEditingDateStr) return;
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database.', 'warn');

    const { db, doc, setDoc } = window.FB;
    const empId = scheduleEditingEmployeeId;
    const dateStr = scheduleEditingDateStr;
    const existing = (scheduleCache[dateStr] && scheduleCache[dateStr].employees) || [];
    const currentEntry = existing.find(e => e.id === empId);
    const isCurrentlyLibur = !!(currentEntry && currentEntry.libur);

    const updatedEmployees = isCurrentlyLibur
        ? existing.filter(e => e.id !== empId) // batal libur -> hapus dari jadwal (kosong lagi)
        : [...existing.filter(e => e.id !== empId), { id: empId, libur: true }]; // tandai libur

    setDoc(doc(db, 'schedule', dateStr), { date: dateStr, employees: updatedEmployees }).then(() => {
        showToast(isCurrentlyLibur ? 'Libur dibatalkan.' : 'Ditandai libur!', 'success');
        closeScheduleCellEditor();
    }).catch((err) => {
        console.error('Gagal simpan status libur:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

function removeScheduleCellJamMasuk() {
    if (!scheduleEditingEmployeeId || !scheduleEditingDateStr) return;
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database.', 'warn');
    if (!confirm('Hapus jadwal karyawan ini di tanggal ini?')) return;

    const { db, doc, setDoc, deleteDoc } = window.FB;
    const empId = scheduleEditingEmployeeId;
    const dateStr = scheduleEditingDateStr;
    const existing = (scheduleCache[dateStr] && scheduleCache[dateStr].employees) || [];
    const remaining = existing.filter(e => e.id !== empId);

    const savePromise = remaining.length > 0
        ? setDoc(doc(db, 'schedule', dateStr), { date: dateStr, employees: remaining })
        : deleteDoc(doc(db, 'schedule', dateStr)); // kosongkan doc kalau tidak ada karyawan lagi, biar rapi di database

    savePromise.then(() => {
        showToast('Jadwal dihapus!', 'success');
        closeScheduleCellEditor();
    }).catch((err) => {
        console.error('Gagal hapus jadwal:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

// --- QR CODE ABSEN (validasi kehadiran, menggantikan cek GPS) ---
function getQrToken() {
    return cachedQrToken;
}

function generateAttendanceQR() {
    const token = 'ABSEN-' + Math.random().toString(36).substring(2, 10).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database.', 'warn');
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, 'config', 'attendanceQrToken'), { token }).then(() => {
        showToast('QR baru berhasil dibuat! QR lama sudah tidak berlaku di semua HP.', 'success');
    }).catch((err) => {
        console.error('Gagal generate QR:', err);
        showToast('Gagal menyimpan QR ke server.', 'warn');
    });
}

async function renderAttendanceQR() {
    const container = document.getElementById('qr-absen-container');
    const tokenInput = document.getElementById('qr-token-text');
    if (!container) return;
    container.innerHTML = '';
    const token = getQrToken();
    if (!token) {
        container.innerHTML = '<p class="text-xs text-slate-400 text-center py-8">Belum ada QR. Tap "Generate QR Baru".</p>';
        if (tokenInput) tokenInput.value = '';
        return;
    }
    container.innerHTML = '<p class="text-xs text-slate-400 text-center py-8">Memuat QR...</p>';
    await ensureQRCode(); // library qrcodejs baru di-download di sini, bukan sejak halaman dibuka
    container.innerHTML = '';
    new QRCode(container, { text: token, width: 320, height: 320, colorDark: '#000000', colorLight: '#ffffff' });
    if (tokenInput) tokenInput.value = token;
}

function copyQrTokenText() {
    const tokenInput = document.getElementById('qr-token-text');
    if (!tokenInput || !tokenInput.value) return showToast('Belum ada QR untuk disalin.', 'warn');
    tokenInput.select();
    navigator.clipboard.writeText(tokenInput.value).then(() => {
        showToast('Kode berhasil disalin! Bagikan ke kasir lewat WhatsApp.', 'success');
    }).catch(() => {
        showToast('Gagal menyalin otomatis, silakan salin manual dari kotak teksnya.', 'warn');
    });
}

// --- SCANNER QR (kamera live, decode pakai jsQR, tidak butuh internet sama sekali) ---
let qrScanStream = null;
let qrScanRAF = null;
let qrScanPendingType = null; // 'masuk' | 'keluar'
let qrScanPendingEmployee = null; // { id, name } - dipilih lewat modal-employee-picker sebelum scan
let qrScanHintTimeout = null;

// --- PILIH NAMA KARYAWAN (wajib sebelum scan, supaya sistem tahu siapa yang absen) ---
function openEmployeePicker(type) {
    if (employeesCache.length === 0) {
        showToast('Admin belum menambahkan data karyawan. Buka Admin Panel > Kelola Karyawan.', 'warn');
        return;
    }
    if (!getQrToken()) {
        showToast('QR Absen belum di-generate Admin. Hubungi Admin dulu.', 'warn');
        return;
    }

    // Identitas kasir sudah diketahui dari login PIN sesi ini — tidak perlu tanya ulang
    // "siapa kamu", langsung lanjut ke scan QR.
    if (currentSessionEmployeeId) {
        qrScanPendingType = type;
        selectEmployeeForAttendance(currentSessionEmployeeId, currentSessionEmployeeName);
        return;
    }

    qrScanPendingType = type;
    const list = document.getElementById('employee-picker-list');
    list.innerHTML = employeesCache.map(emp => `
        <button onclick="selectEmployeeForAttendance('${emp.id}', '${emp.name.replace(/'/g, "\\'")}')" class="w-full bg-slate-50 hover:bg-indigo-50 border border-slate-100 rounded-2xl p-4 text-left font-bold text-slate-800 flex items-center justify-between transition">
            ${emp.name}
            <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300"></i>
        </button>
    `).join('');
    lucide.createIcons();

    document.getElementById('modal-employee-picker').classList.remove('hidden');
    document.getElementById('modal-employee-picker').classList.add('flex');
}

function closeEmployeePicker() {
    document.getElementById('modal-employee-picker').classList.add('hidden');
    document.getElementById('modal-employee-picker').classList.remove('flex');
}

function selectEmployeeForAttendance(id, name) {
    qrScanPendingEmployee = { id, name };
    closeEmployeePicker();
    openQrScanner(qrScanPendingType);
}

async function openQrScanner(type) {
    if (!getQrToken()) {
        showToast('QR Absen belum di-generate Admin. Hubungi Admin dulu.', 'warn');
        return;
    }

    qrScanPendingType = type;
    const modal = document.getElementById('modal-qr-scanner');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('qr-scanner-status').innerText = 'Menyiapkan pemindai...';
    lucide.createIcons();

    try {
        await ensureJsQR(); // library decoder QR baru di-download saat kasir benar-benar mau scan
    } catch (err) {
        console.error('Gagal load jsQR:', err);
        document.getElementById('qr-scanner-status').innerText = 'Gagal memuat modul pemindai QR (cek koneksi internet kasir), coba lagi.';
        return;
    }

    try {
        document.getElementById('qr-scanner-status').innerText = 'Mengaktifkan kamera...';
        // continuous autofocus diminta secara eksplisit karena live-preview kamera di browser
        // sering tidak auto-fokus dengan baik di jarak dekat (beda dengan app kamera native)
        qrScanStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                // Resolusi ideal diminta setinggi mungkin (browser akan turunkan otomatis kalau
                // kamera HP tidak sanggup). Ini PENTING khususnya untuk scan QR yang ditampilkan
                // di layar HP lain (bukan QR cetak) — makin tinggi resolusi capture, makin jelas
                // pola QR-nya buat di-decode jsQR, apalagi kalau jaraknya agak jauh.
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                advanced: [{ focusMode: 'continuous' }]
            }
        }).catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }));

        const video = document.getElementById('qr-scanner-video');
        video.srcObject = qrScanStream;
        await video.play();
        document.getElementById('qr-scanner-status').innerText = `Arahkan kamera ke QR Absen di toko (${qrScanPendingEmployee ? qrScanPendingEmployee.name : ''})`;
        qrScanRAF = requestAnimationFrame(qrScanTick);

        // Kalau 6 detik belum ke-detect, kasih hint supaya coba tombol "Ambil Foto"
        clearTimeout(qrScanHintTimeout);
        qrScanHintTimeout = setTimeout(() => {
            const statusEl = document.getElementById('qr-scanner-status');
            if (statusEl && qrScanRAF) {
                statusEl.innerText = 'Susah kebaca? Pastikan cahaya cukup & tidak ada pantulan, atau tap "Ambil Foto" di bawah';
            }
        }, 6000);
    } catch (err) {
        console.error('Gagal akses kamera:', err);
        document.getElementById('qr-scanner-status').innerText = 'Gagal akses kamera. Cek izin kamera di browser.';
    }
}

function qrScanTick() {
    const video = document.getElementById('qr-scanner-video');
    const canvas = document.getElementById('qr-scanner-canvas');
    if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) {
            handleQrScanResult(code.data);
            return; // hentikan loop, biar handleQrScanResult yang mengatur lanjutannya
        }
    }
    qrScanRAF = requestAnimationFrame(qrScanTick);
}

// Fallback: kalau live-scan susah (blur/pantulan cahaya), kasir bisa ambil 1 foto pakai
// kamera native HP (biasanya auto-fokusnya lebih baik dari live-preview browser) lalu di-decode sekali.
function handleQrFallbackPhoto(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;

    document.getElementById('qr-scanner-status').innerText = 'Memproses foto...';

    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
        img.onload = () => {
            try {
                const canvas = document.getElementById('qr-scanner-canvas');
                // PENTING: foto dari kamera native HP biasanya resolusi sangat tinggi (12MP+,
                // misal 4000x3000px). Kalau diproses jsQR di ukuran ASLI, browser bisa nge-hang
                // lama/selamanya karena baca jutaan pixel sekaligus di 1 thread — makanya status
                // "Memproses foto..." kelihatan macet padahal sebenarnya lagi struggle proses foto
                // segede itu. Solusinya: kecilkan dulu sebelum di-scan (1200px sisi terpanjang
                // masih lebih dari cukup jelas buat jsQR baca QR, tapi jauh lebih cepat diproses).
                const MAX_DIM = 1200;
                let { width, height } = img;
                if (width > MAX_DIM || height > MAX_DIM) {
                    const scale = MAX_DIM / Math.max(width, height);
                    width = Math.round(width * scale);
                    height = Math.round(height * scale);
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const imageData = ctx.getImageData(0, 0, width, height);
                const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
                if (code && code.data) {
                    handleQrScanResult(code.data);
                } else {
                    document.getElementById('qr-scanner-status').innerText = 'QR tidak terbaca dari foto. Coba lagi dengan pencahayaan lebih terang.';
                    resumeLiveQrScan();
                }
            } catch (err) {
                console.error('Gagal proses foto QR:', err);
                document.getElementById('qr-scanner-status').innerText = 'Gagal memproses foto. Coba ambil foto lagi atau pakai Input Manual.';
                resumeLiveQrScan();
            }
        };
        img.onerror = () => {
            document.getElementById('qr-scanner-status').innerText = 'Foto gagal dimuat. Coba ambil foto lagi.';
            resumeLiveQrScan();
        };
        img.src = e.target.result;
    };
    reader.onerror = () => {
        document.getElementById('qr-scanner-status').innerText = 'Gagal membaca file foto. Coba lagi.';
        resumeLiveQrScan();
    };
    reader.readAsDataURL(file);
}

// Setelah kasir balik dari app kamera native (buat ambil foto fallback), browser di beberapa
// HP otomatis MENGHENTIKAN video stream live-scan yang lagi jalan di background (preview jadi
// hitam total). Fungsi ini cek dulu apakah stream lama masih hidup — kalau sudah mati,
// nyalakan ulang kameranya sebelum lanjut live-scan, bukan asal requestAnimationFrame ke stream
// yang sudah mati (yang bikin preview tetap hitam selamanya).
async function resumeLiveQrScan() {
    const video = document.getElementById('qr-scanner-video');
    const stillAlive = qrScanStream && qrScanStream.getVideoTracks().some(t => t.readyState === 'live');
    if (stillAlive) {
        qrScanRAF = requestAnimationFrame(qrScanTick);
        return;
    }
    try {
        qrScanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
        video.srcObject = qrScanStream;
        await video.play();
        qrScanRAF = requestAnimationFrame(qrScanTick);
    } catch (err) {
        console.error('Gagal nyalakan ulang kamera:', err);
        document.getElementById('qr-scanner-status').innerText = 'Kamera live terhenti. Tap "Ambil Foto" lagi atau pakai Input Manual.';
    }
}

// Input manual: kasir ketik/tempel kode teks dari Admin (misal dikirim lewat WhatsApp),
// dipakai kalau kamera benar-benar tidak bisa scan sama sekali (rusak, gelap, dll).
function toggleManualQrInput() {
    const box = document.getElementById('qr-manual-input-box');
    const isHidden = box.classList.contains('hidden');
    if (isHidden) {
        box.classList.remove('hidden');
        box.classList.add('flex');
        document.getElementById('qr-manual-input').focus();
    } else {
        box.classList.add('hidden');
        box.classList.remove('flex');
    }
}

function submitManualQrCode() {
    const input = document.getElementById('qr-manual-input');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    handleQrScanResult(value);
}

function handleQrScanResult(scannedText) {
    clearTimeout(qrScanHintTimeout);
    const expected = getQrToken();
    if (scannedText === expected) {
        const type = qrScanPendingType;
        const employee = qrScanPendingEmployee; // ambil dulu sebelum closeQrScanner() mereset-nya
        closeQrScanner();
        saveAttendanceRecord(type, employee);
        if (document.getElementById('modal-absen-popup') && !document.getElementById('modal-absen-popup').classList.contains('hidden')) {
            renderAbsenPopup();
        }
    } else {
        document.getElementById('qr-scanner-status').innerText = 'QR tidak valid. Scan QR resmi yang ada di toko.';
        setTimeout(() => { qrScanRAF = requestAnimationFrame(qrScanTick); }, 1200);
    }
}

function closeQrScanner() {
    const modal = document.getElementById('modal-qr-scanner');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    if (qrScanRAF) cancelAnimationFrame(qrScanRAF);
    qrScanRAF = null;
    clearTimeout(qrScanHintTimeout);
    if (qrScanStream) {
        qrScanStream.getTracks().forEach(t => t.stop());
        qrScanStream = null;
    }
    qrScanPendingType = null;
    qrScanPendingEmployee = null;

    const manualBox = document.getElementById('qr-manual-input-box');
    if (manualBox) { manualBox.classList.add('hidden'); manualBox.classList.remove('flex'); }
    const manualInput = document.getElementById('qr-manual-input');
    if (manualInput) manualInput.value = '';
}

// Refresh render admin yang terkait absen (QR, riwayat, karyawan, jadwal) — dipanggil setiap
// kali data absen dari server berubah. Namanya dulu "loadAttendanceSettingsToForm" waktu masih
// ada form jendela jam; sekarang jendela jam masuk/pulang sudah dihapus semua.
function refreshAttendanceAdminViews() {
    renderAttendanceQR();
    renderRiwayatAbsen();
    renderEmployeeList();
    renderScheduleTable();
}

function getTodayDateStr(date) {
    const d = date || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Baca dari cache lokal (diisi Firestore listener) — TIDAK menulis apa pun ke server.
// PENTING: absensi sekarang PER KARYAWAN (bukan cuma per tanggal) — dulu satu dokumen dipakai
// bareng-bareng semua kasir dalam sehari, jadi begitu satu orang absen keluar, kasir LAIN yang
// belum keluar ikut ke-lock ("Shift Hari Ini Selesai") padahal bukan giliran mereka. Sekarang
// tiap kasir punya rekam absennya sendiri (doc ID `${tanggal}_${employeeId}`), jadi status
// keluar satu orang tidak memengaruhi kasir lain sama sekali.
function getMyTodayAttendance() {
    const empId = getCurrentKasirEmployeeId();
    const todayStr = getTodayDateStr();
    if (!empId) return { date: todayStr, masukTime: null, keluarTime: null };
    const record = attendanceLogCache.find(r => r.date === todayStr && r.employeeId === empId);
    return record || { date: todayStr, employeeId: empId, masukTime: null, keluarTime: null };
}

// Cek apakah waktu "now" (Date) berada di antara "HH:MM" start dan end (asumsi tidak lewat tengah malam)


let mandatoryMasukGateActive = false; // true kalau absen masuk WAJIB dilakukan dulu (belum absen hari ini)
let absenPopupMandatory = false; // true = popup absensi tidak boleh ditutup manual (lagi wajib absen masuk)
let shiftEndedActive = false; // true = absen keluar sudah dilakukan hari ini, POS tertutup sampai besok
// true selagi Admin Panel sedang dibuka. Semua "layar kunci" kasir (shift-ended-gate,
// popup absen wajib) TETAP dihitung statusnya seperti biasa di balik layar,
// tapi sengaja tidak ditampilkan secara visual selama ini true — supaya Admin Panel bisa
// diakses kapan pun tanpa pernah ketutup layar kunci kasir. Begitu Admin kembali ke halaman
// Kasir, layar kunci yang masih berlaku otomatis dimunculkan lagi lewat restoreKasirLockScreensIfNeeded().
let adminPanelOpen = false;

// Cek apakah kasir yang lagi login PIN sesi ini DIJADWALKAN kerja hari ini (via tabel Jadwal
// Kerja Karyawan) dan tidak sedang libur. Mengembalikan entry jadwalnya ({id, jamMulai}) kalau
// ada, atau null kalau tidak dijadwalkan / lagi libur hari ini — dipakai buat tentukan wajib
// absen masuk atau tidak, jadi tiap karyawan beda-beda sesuai jadwal masing-masing.
function getTodayScheduleEntryForCurrentKasir() {
    const empId = getCurrentKasirEmployeeId();
    if (!empId) return null;
    const dayEntry = scheduleCache[getTodayDateStr()];
    if (!dayEntry || !dayEntry.employees) return null;
    const empEntry = dayEntry.employees.find(e => e.id === empId);
    if (!empEntry || empEntry.libur) return null;
    return empEntry;
}

// Absen MASUK sekarang WAJIB hanya kalau kasir yang lagi login PIN sesi ini memang DIJADWALKAN
// kerja hari ini (diatur Admin di tabel Jadwal Kerja Karyawan) dan tidak sedang libur — jadi
// tiap karyawan wajib absen sesuai jadwalnya masing-masing, bukan jendela jam yang sama untuk
// semua orang. Kalau tidak dijadwalkan hari ini, dashboard tetap terbuka normal tanpa dipaksa absen.
// Absen PULANG sekarang self-service kapan saja (tidak ada jendela jam lagi) — kasir tinggal
// tap ikon fingerprint di header kapan pun setelah masuk, tanpa dipaksa layar penuh.
// Prioritas: shift sudah selesai (keluar tercatat) > wajib absen masuk.
function checkMandatoryMasukGate() {
    if (!attendanceSettingsLoaded || !attendanceLogLoaded) return;
    const record = getMyTodayAttendance();

    // Kalau sudah absen keluar hari ini, POS tertutup total - tidak perlu cek apa pun lagi
    if (record.keluarTime) {
        if (!shiftEndedActive) showShiftEndedGate(record);
        if (mandatoryMasukGateActive) {
            mandatoryMasukGateActive = false;
            absenPopupMandatory = false;
            closeAbsenPopupForced();
        }
        recomputeDashboardLock();
        return;
    }
    if (shiftEndedActive) hideShiftEndedGate(); // jaga-jaga (misal Admin reset absen manual)

    const scheduledToday = !!getTodayScheduleEntryForCurrentKasir();
    const needsMasuk = scheduledToday && !record.masukTime;
    if (needsMasuk && !mandatoryMasukGateActive) {
        mandatoryMasukGateActive = true;
        openAbsenPopup(true);
    } else if (!needsMasuk && mandatoryMasukGateActive) {
        mandatoryMasukGateActive = false;
        absenPopupMandatory = false;
        closeAbsenPopupForced();
    }
    recomputeDashboardLock();
}

// --- LAYAR SHIFT SELESAI (setelah absen keluar, POS tertutup sampai ganti hari) ---
function showShiftEndedGate(record) {
    shiftEndedActive = true;
    if (adminPanelOpen) return; // Admin Panel lagi dibuka — jangan nutupin, munculkan lagi nanti pas kembali ke Kasir
    const keluarTimeStr = record.keluarTime ? new Date(record.keluarTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
    const who = record.keluarBy ? ` oleh ${record.keluarBy}` : '';
    document.getElementById('shift-ended-subtitle').innerText = `Absen keluar tercatat pukul ${keluarTimeStr}${who}.`;
    const gate = document.getElementById('shift-ended-gate');
    gate.classList.remove('hidden');
    gate.classList.add('flex');
    lucide.createIcons();
}

function hideShiftEndedGate() {
    shiftEndedActive = false;
    const gate = document.getElementById('shift-ended-gate');
    gate.classList.add('hidden');
    gate.classList.remove('flex');
}

// --- KONFIRMASI ABSEN KELUAR (Ya/Tidak, tanpa QR) ---
let confirmKeluarPending = false;

function openConfirmKeluar() {
    document.getElementById('modal-confirm-keluar').classList.remove('hidden');
    document.getElementById('modal-confirm-keluar').classList.add('flex');
    lucide.createIcons();
}

function closeConfirmKeluar() {
    document.getElementById('modal-confirm-keluar').classList.add('hidden');
    document.getElementById('modal-confirm-keluar').classList.remove('flex');
}

function confirmKeluarYes() {
    closeConfirmKeluar();
    closeAbsenPopupForced(); // kalau dipicu dari popup manual, tutup dulu popupnya
    // Identitas "keluar" langsung dari sesi PIN yang lagi login — bukan lagi derive dari
    // record bersama (yang dulu bisa salah kena punya kasir lain).
    const employee = currentSessionEmployeeId ? { id: currentSessionEmployeeId, name: currentSessionEmployeeName } : null;
    saveAttendanceRecord('keluar', employee);
}

// Satu sumber kebenaran untuk status kunci dashboard — dipanggil setiap kali salah satu
// kondisi (shift selesai / wajib absen masuk) berubah, supaya tidak saling tabrakan.
function recomputeDashboardLock() {
    setDashboardLocked(shiftEndedActive || mandatoryMasukGateActive);
}

// Kunci sungguhan (bukan cuma visual): saat overlay/popup wajib aktif, elemen di baliknya
// dikasih pointer-events:none sekaligus inert, jadi walau ada bug CSS/z-index, dashboard TETAP
// tidak bisa disentuh sampai terkunci ini dilepas. Header TIDAK ikut dikunci (z-index lebih
// tinggi dari semua overlay ini) supaya Admin tetap bisa masuk kapan saja.
function setDashboardLocked(locked) {
    ['page-home', 'bottom-bar'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('dashboard-locked', locked);
        if (locked) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
}

// Fungsi inti penyimpanan absen, dipakai baik oleh gerbang wajib maupun popup manual di header.
// `employee` = { id, name } — WAJIB ada id sekarang, karena doc ID absen sudah per-karyawan
// (bukan cuma per-tanggal lagi), supaya absen kasir A tidak pernah menimpa/mengunci kasir B.
function saveAttendanceRecord(type, employee) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
        return;
    }
    // PENTING: Firestore MENOLAK setDoc() kalau ada field bernilai `undefined` (bukan null) —
    // seluruh write langsung gagal diam-diam. `employee.id` bisa jadi undefined/null (misal
    // sesi PIN belum jelas), jadi wajib di-guard di sini juga, bukan cuma di titik pemanggilnya.
    const employeeId = (employee && employee.id != null) ? employee.id : null;
    if (!employeeId) {
        showToast('Identitas kasir tidak diketahui — coba login PIN ulang.', 'warn');
        return;
    }

    const todayStr = getTodayDateStr();
    const now = new Date().toISOString();
    const { db, doc, setDoc } = window.FB;
    const docId = `${todayStr}_${employeeId}`; // per-tanggal DAN per-karyawan

    const field = type === 'masuk'
        ? { masukTime: now, masukBy: employee ? employee.name : null, masukById: employeeId }
        : { keluarTime: now, keluarBy: employee ? employee.name : null, keluarById: employeeId };

    setDoc(doc(db, 'attendance', docId), { date: todayStr, employeeId, ...field }, { merge: true }).then(() => {
        const who = employee ? ` (${employee.name})` : '';
        showToast((type === 'masuk' ? 'Absen masuk tercatat!' : 'Absen pulang tercatat!') + who, 'success');
    }).catch((err) => {
        console.error('Gagal simpan absen:', err);
        showToast('Gagal menyimpan absen ke server.', 'warn');
    });
}

function formatDurationHM(msDuration) {
    const totalMinutes = Math.floor(msDuration / 60000);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}j ${m}m`;
}

// --- POPUP ABSENSI (dibuka manual lewat tombol fingerprint di header, ATAU otomatis+wajib
// oleh checkMandatoryMasukGate begitu app dibuka & belum absen masuk hari itu) ---
function openAbsenPopup(mandatory) {
    absenPopupMandatory = !!mandatory;
    // Kalau ini pop-up WAJIB yang dipicu otomatis sementara Admin Panel lagi dibuka, jangan
    // ditampilkan dulu — biar Admin Panel tidak ketutup. Popup manual (klik ikon fingerprint
    // di header) tetap boleh muncul kapan saja.
    if (mandatory && adminPanelOpen) return;
    renderAbsenPopup();
    const modal = document.getElementById('modal-absen-popup');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('absen-popup-close-btn').classList.toggle('hidden', absenPopupMandatory);
    lucide.createIcons();
}

// Dipanggil dari tombol X — kalau lagi wajib (belum absen masuk), tidak boleh ditutup manual
function closeAbsenPopup() {
    if (absenPopupMandatory) {
        showToast('Wajib absen masuk dulu sebelum bisa mulai jualan.', 'warn');
        return;
    }
    closeAbsenPopupForced();
}

// Versi internal tanpa guard, dipakai saat memang boleh/perlu ditutup secara terprogram
// (absen masuk baru saja berhasil, atau lanjut ke langkah pilih karyawan)
function closeAbsenPopupForced() {
    const modal = document.getElementById('modal-absen-popup');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function recordAttendanceManual(type) {
    if (type === 'keluar') {
        openConfirmKeluar(); // absen keluar cukup konfirmasi Ya/Tidak, tanpa QR (popup ditutup di confirmKeluarYes)
        return;
    }
    closeAbsenPopupForced();
    openEmployeePicker(type);
}

function renderAbsenPopup() {
    const record = getMyTodayAttendance();
    const dateStr = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('absen-popup-date').innerText = dateStr;

    const body = document.getElementById('absen-popup-body');
    const masukStr = record.masukTime ? new Date(record.masukTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : null;
    const keluarStr = record.keluarTime ? new Date(record.keluarTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : null;

    if (!record.masukTime) {
        const scheduleEntry = getTodayScheduleEntryForCurrentKasir();
        const jadwalInfo = (scheduleEntry && scheduleEntry.jamMulai)
            ? `<p class="text-xs text-indigo-600 font-bold mt-2">Jadwal kamu hari ini: mulai ${scheduleEntry.jamMulai}</p>`
            : '';
        body.innerHTML = `
            <div class="bg-slate-50 rounded-2xl p-5 text-center mb-4">
                <i data-lucide="clock" class="w-6 h-6 text-slate-300 mx-auto mb-2"></i>
                <p class="text-sm text-slate-500 font-semibold">Belum absen masuk hari ini</p>
                ${jadwalInfo}
            </div>
            <button onclick="recordAttendanceManual('masuk')" class="w-full bg-emerald-500 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2">
                <i data-lucide="log-in" class="w-5 h-5"></i> Absen Masuk
            </button>`;
    } else if (!record.keluarTime) {
        body.innerHTML = `
            <div class="flex items-center justify-between bg-emerald-50 rounded-2xl p-4">
                <div>
                    <p class="text-[10px] text-emerald-600 font-bold uppercase">Jam Masuk${record.masukBy ? ` - ${record.masukBy}` : ''}</p>
                    <p class="text-2xl font-black text-emerald-700">${masukStr}</p>
                </div>
                <button onclick="recordAttendanceManual('keluar')" class="bg-orange-500 text-white px-5 py-3.5 rounded-xl font-bold flex items-center gap-2 shrink-0">
                    <i data-lucide="log-out" class="w-4 h-4"></i> Keluar
                </button>
            </div>`;
    } else {
        body.innerHTML = `
            <div class="grid grid-cols-2 gap-3">
                <div class="bg-emerald-50 rounded-2xl p-4 text-center">
                    <p class="text-[10px] text-emerald-600 font-bold uppercase">Masuk${record.masukBy ? ` - ${record.masukBy}` : ''}</p>
                    <p class="text-lg font-black text-emerald-700">${masukStr}</p>
                </div>
                <div class="bg-orange-50 rounded-2xl p-4 text-center">
                    <p class="text-[10px] text-orange-600 font-bold uppercase">Pulang${record.keluarBy ? ` - ${record.keluarBy}` : ''}</p>
                    <p class="text-lg font-black text-orange-700">${keluarStr}</p>
                </div>
            </div>
            <p class="text-center text-xs text-slate-400 font-semibold mt-4">Absensi hari ini sudah lengkap ✓</p>`;
    }
    lucide.createIcons();
}

// --- RIWAYAT ABSEN (per karyawan — menu terpisah, di bawah Generate QR Absen) ---
function renderRiwayatAbsenEmployeeSelect() {
    const select = document.getElementById('riwayat-absen-employee-select');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('') || '<option value="">Belum ada karyawan</option>';
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;
    renderRiwayatAbsen();
}

// Ambil riwayat absen milik satu karyawan, urut terbaru dulu. `monthFilter` opsional ('YYYY-MM')
// buat filter satu bulan penuh (dipakai saat export PDF); kalau dikosongkan, ambil semua lalu
// caller yang batasi (dipakai buat tampilan 7 hari terakhir).
function getRiwayatAbsenForEmployee(empId, monthFilter) {
    return attendanceLogCache
        .filter(r => r.masukById === empId && (!monthFilter || r.date.startsWith(monthFilter)))
        .sort((a, b) => b.date.localeCompare(a.date));
}

function renderRiwayatAbsen() {
    const body = document.getElementById('riwayat-absen-body');
    const select = document.getElementById('riwayat-absen-employee-select');
    if (!body || !select) return;
    const empId = select.value;
    const records = empId ? getRiwayatAbsenForEmployee(empId).slice(0, 7) : []; // 7 hari terakhir

    body.innerHTML = records.map(r => {
        const dateObj = new Date(r.date + 'T00:00:00');
        const hari = dateObj.toLocaleDateString('id-ID', { weekday: 'long' });
        const tanggalFormatted = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const masukStr = r.masukTime ? new Date(r.masukTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
        const keluarStr = r.keluarTime ? new Date(r.keluarTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
        return `
        <tr class="border-b border-slate-50">
            <td class="p-3 font-semibold text-slate-700">${hari}</td>
            <td class="p-3 text-slate-500">${tanggalFormatted}</td>
            <td class="p-3 text-emerald-600 font-bold">${masukStr}</td>
            <td class="p-3 text-orange-600 font-bold">${keluarStr}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="4" class="text-center p-6 text-slate-400 text-xs">${empId ? 'Belum ada riwayat absen' : 'Pilih karyawan dulu'}</td></tr>`;
}

async function downloadRiwayatAbsenPDF() {
    const select = document.getElementById('riwayat-absen-employee-select');
    const monthInput = document.getElementById('riwayat-absen-month');
    const empId = select ? select.value : '';
    if (!empId) return alert('Pilih karyawan dulu!');

    const emp = employeesCache.find(e => e.id === empId);
    const monthVal = (monthInput && monthInput.value) ? monthInput.value : getTodayDateStr().slice(0, 7); // 'YYYY-MM'
    const records = getRiwayatAbsenForEmployee(empId, monthVal).sort((a, b) => a.date.localeCompare(b.date));

    if (records.length === 0) {
        return alert('Tidak ada data absen di bulan tersebut untuk karyawan ini.');
    }

    await ensureJsPDF();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const monthLabel = new Date(`${monthVal}-01T00:00:00`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    doc.text(`Riwayat Absen - ${emp ? emp.name : ''} - ${monthLabel}`, 10, 10);

    const data = records.map(r => {
        const dateObj = new Date(r.date + 'T00:00:00');
        const hari = dateObj.toLocaleDateString('id-ID', { weekday: 'long' });
        const tgl = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const masukStr = r.masukTime ? new Date(r.masukTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
        const keluarStr = r.keluarTime ? new Date(r.keluarTime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
        return [hari, tgl, masukStr, keluarStr];
    });

    doc.autoTable({ head: [['Hari', 'Tanggal', 'Jam Masuk', 'Jam Keluar']], body: data, startY: 18 });
    doc.save(`Absen-${(emp ? emp.name : 'Karyawan').replace(/\s+/g, '_')}-${monthVal}.pdf`);
}

// --- LAPORAN SALES HARI INI (dari kotak di panel Menu Utama) ---
function isSameDay(dateA, dateB) {
    return dateA.getFullYear() === dateB.getFullYear() &&
        dateA.getMonth() === dateB.getMonth() &&
        dateA.getDate() === dateB.getDate();
}

function getTodaysOrders() {
    const today = new Date();
    return orderHistory.filter(o => {
        const ts = o.timestamp ? new Date(o.timestamp) : null;
        return ts && !isNaN(ts) && isSameDay(ts, today);
    }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // terbaru di atas
}

function openSalesReport() {
    renderSalesReport();
    document.getElementById('modal-sales-report').classList.remove('hidden');
    lucide.createIcons();
}

function closeSalesReport() {
    document.getElementById('modal-sales-report').classList.add('hidden');
}

// Otomatis pakai kasir yang lagi login PIN sesi ini — tanpa dropdown filter apa pun.
function renderSalesReport() {
    const empId = currentSessionEmployeeId;

    const allTodaysOrders = getTodaysOrders();
    const todaysOrders = empId ? allTodaysOrders.filter(o => o.employeeId === empId) : allTodaysOrders;
    const total = todaysOrders.reduce((sum, o) => sum + o.total, 0);

    const dateLabel = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('sales-report-date').innerText = currentSessionEmployeeName ? `${dateLabel} · ${currentSessionEmployeeName}` : dateLabel;
    document.getElementById('sales-report-total').innerText = `Rp ${total.toLocaleString()}`;
    document.getElementById('sales-report-count').innerText = todaysOrders.length;

    const body = document.getElementById('sales-report-body');

    if (todaysOrders.length === 0) {
        body.innerHTML = `<tr><td colspan="4" class="text-center p-8 text-slate-400 text-xs">Belum ada transaksi hari ini</td></tr>`;
        return;
    }

    body.innerHTML = todaysOrders.map(o => {
        const time = new Date(o.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const itemText = o.items.map(i => `${i.name} x${i.qty}`).join(', ');
        return `
        <tr class="border-b border-slate-100">
            <td class="p-3 align-top font-semibold text-slate-500 whitespace-nowrap">${time}</td>
            <td class="p-3 align-top text-slate-800">${itemText}</td>
            <td class="p-3 align-top">
                <span class="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-[10px] font-bold">${o.method}</span>
            </td>
            <td class="p-3 align-top text-right font-bold text-blue-600 whitespace-nowrap">Rp ${o.total.toLocaleString()}</td>
        </tr>`;
    }).join('');
}

// Jeda konfirmasi: tampilkan modal "Yakin lanjut?" sebelum benar-benar memproses pesanan
function askConfirmOrder() {
    // Kalau bayar Cash, uang diterima wajib diisi & harus cukup — supaya kembalian yang
    // tercetak di struk selalu akurat, bukan asumsi/kosong.
    if (selectedPayment === 'Cash') {
        const received = parseInt((document.getElementById('cash-received-input') || {}).value, 10) || 0;
        const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
        if (received <= 0) return alert('Isi dulu nominal uang yang diterima!');
        if (received < total) return alert('Uang diterima kurang dari total belanja!');
    }
    document.getElementById('modal-confirm-order').classList.remove('hidden');
    lucide.createIcons();
}

function cancelConfirmOrder() {
    document.getElementById('modal-confirm-order').classList.add('hidden');
}

function processOrder() {
    document.getElementById('modal-confirm-order').classList.add('hidden');

    const now = new Date();
    // ID struk berbasis waktu (bukan counter manual) supaya tidak pernah tabrakan
    // walau ada beberapa HP kasir membuat transaksi di saat yang hampir bersamaan.
    const receiptID = now.toISOString().replace(/[-:T.]/g, '').slice(2, 14) + Math.floor(Math.random() * 90 + 10);

    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    // Cash: pakai nominal yang diketik kasir di "Uang Diterima".
    // QRIS/Shopee: uang yang "diterima" otomatis dianggap pas sejumlah Total (tidak ada uang
    // fisik/kembalian beneran), supaya baris Bayar & Kembali tetap konsisten muncul di struk
    // untuk semua metode pembayaran, bukan cuma Cash.
    const paidAmount = selectedPayment === 'Cash'
        ? (parseInt((document.getElementById('cash-received-input') || {}).value, 10) || 0)
        : total;

    lastOrder = {
        id: receiptID,
        date: now.toLocaleString('id-ID'),
        timestamp: now.toISOString(), // dipakai untuk filter laporan "Sales Hari Ini" secara akurat
        total,
        paidAmount,
        change: paidAmount - total,
        method: selectedPayment,
        items: JSON.parse(JSON.stringify(cart)),
        employeeId: currentSessionEmployeeId, // identitas kasir yang lagi login PIN sesi ini
        employeeName: currentSessionEmployeeName
    };

    saveOrderToFirestore(lastOrder);
    decreaseStockForOrder(lastOrder.items, getCurrentKasirEmployeeId());
    updateConnectionUI();

    document.getElementById('modal-checkout').classList.add('hidden');
    document.getElementById('modal-success').classList.remove('hidden');
    renderReceiptPreview();
    playPaymentSuccessSound();
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]); // pola getar pendek-jeda-pendek, terasa beda dari getar biasa
    launchSuccessConfetti();
    lucide.createIcons();
}

// Preview struk visual gaya thermal printer (Toko / tanggal / item / total), ditampilkan
// langsung di modal sukses — bukan cuma teks polos "Berhasil!" seperti sebelumnya.
// Catatan: kolom "Bayar"/"Kembali" tidak ditampilkan karena app ini belum ada input
// jumlah uang tunai diterima (cuma pilih metode pembayaran), jadi datanya memang belum ada.
function renderReceiptPreview() {
    const el = document.getElementById('receipt-preview');
    if (!el || !lastOrder) return;

    // Alamat & no. telp ikut kasir yang transaksi ini (bukan 1 alamat toko pusat yang sama),
    // fallback ke tagline default kalau kasirnya belum diisi alamat di Admin Panel.
    const kasirEmp = employeesCache.find(e => e.id === lastOrder.employeeId);
    const addressHtml = (kasirEmp && kasirEmp.address)
        ? `<div class="rc-sub">${kasirEmp.address}${kasirEmp.phone ? `, ${kasirEmp.phone}` : ''}</div>`
        : `<div class="rc-sub">Digital Point of Sales</div>`;

    const itemsHtml = lastOrder.items.map((i) => {
        const variantLines = i.variantSelections
            ? `<div class="rc-item-variant">${i.variantSelections.map(v => `${v.name} x${v.qty}`).join(', ')}</div>`
            : '';
        return `
        <div class="rc-item-row">
            <div>
                <div class="rc-item-name">${i.name}</div>
                <div class="rc-item-sub">Rp${i.price.toLocaleString()} x ${i.qty}</div>
                ${variantLines}
            </div>
            <div class="rc-item-total">Rp${(i.qty * i.price).toLocaleString()}</div>
        </div>`;
    }).join('');

    // Bayar & Kembali cuma relevan untuk Cash (ada uang fisik diterima + kembalian).
    // QRIS/Shopee: pas (uang langsung masuk sistem, tidak ada kembalian).
    const paymentRowsHtml = lastOrder.paidAmount != null
        ? `
        <div class="rc-row"><span>Bayar</span><span class="rc-bold">Rp${lastOrder.paidAmount.toLocaleString()}</span></div>
        <div class="rc-row"><span>Kembali</span><span class="rc-bold">Rp${lastOrder.change.toLocaleString()}</span></div>`
        : '';

    el.innerHTML = `
        <div class="rc-center">
            <div class="rc-store-name">${STORE_NAME}</div>
            ${addressHtml}
        </div>
        <div class="rc-hr"></div>
        <div class="rc-row"><span>No</span><span class="rc-bold">${lastOrder.id}</span></div>
        <div class="rc-row"><span>Tanggal</span><span class="rc-bold">${lastOrder.date}</span></div>
        <div class="rc-row"><span>Kasir</span><span class="rc-bold">${lastOrder.employeeName || '-'}</span></div>
        <div class="rc-row"><span>Pembayaran</span><span class="rc-bold">${lastOrder.method}</span></div>
        <div class="rc-hr"></div>
        ${itemsHtml}
        <div class="rc-hr"></div>
        <div class="rc-row"><span class="rc-bold" style="font-size:15px;">Total</span><span class="rc-bold" style="font-size:15px;">Rp${lastOrder.total.toLocaleString()}</span></div>
        ${paymentRowsHtml}
        <div class="rc-hr"></div>
        <div class="rc-center" style="font-size:12px;color:#64748b;">Terimakasih telah berbelanja</div>`;
}

// Confetti ringan pakai DOM+CSS saja (bukan library eksternal), biar tidak nambah beban
// download. Muncul cuma di momen transaksi berhasil, hilang otomatis setelah animasi selesai.
function launchSuccessConfetti() {
    const modal = document.querySelector('#modal-success');
    if (!modal) return;
    const colors = ['#2563eb', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4'];
    const holder = document.createElement('div');
    holder.className = 'confetti-holder';
    for (let i = 0; i < 24; i++) {
        const piece = document.createElement('span');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[i % colors.length];
        piece.style.animationDelay = (Math.random() * 0.3) + 's';
        piece.style.transform = `rotate(${Math.random() * 360}deg)`;
        holder.appendChild(piece);
    }
    modal.appendChild(holder);
    setTimeout(() => holder.remove(), 1600);
}

// Suara notifikasi "pembayaran berhasil". Dibuat baru tiap panggil (bukan elemen <audio> statis)
// supaya kalau kasir checkout beberapa kali cepat berturut-turut, suara sebelumnya tidak
// nge-block/ke-cut suara berikutnya. Kalau browser memblokir autoplay audio (jarang terjadi
// karena ini dipicu langsung dari tap tombol user), errornya cukup di-log saja, tidak mengganggu transaksi.
function playPaymentSuccessSound() {
    try {
        const audio = new Audio('https://www.image2url.com/r2/default/audio/1788174268372-6107ba19-18b9-4c0a-ba75-f1b35c5472db.mp3');
        audio.play().catch(err => console.warn('Gagal memutar suara pembayaran berhasil:', err));
    } catch (err) {
        console.warn('Gagal memutar suara pembayaran berhasil:', err);
    }
}

// Simpan transaksi ke koleksi 'sales' di Firestore. Tabel riwayat & laporan penjualan
// otomatis ke-update lewat onSnapshot listener di initFirestoreSync (tidak perlu push manual
// ke array orderHistory di sini, supaya tidak dobel begitu listener-nya jalan).
function saveOrderToFirestore(order) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database, transaksi akan otomatis tersimpan begitu koneksi ke server aktif.', 'warn');
        return;
    }
    const { db, collection, addDoc } = window.FB;
    addDoc(collection(db, 'sales'), order).catch((err) => {
        console.error('Gagal menyimpan transaksi:', err);
        showToast('Gagal menyimpan transaksi ke server.', 'warn');
    });
}

function finishTransaction() {
    cart = [];
    lastOrder = null;
    updateCartUI();
    document.getElementById('modal-success').classList.add('hidden');
    // Kembali ke kategori "Makanan" kalau memang ada & tampil buat kasir ini; kalau tidak
    // (misal katalog kasir ini tidak termasuk kategori itu), pakai kategori pertama yang tampil.
    const visibleCategories = getVisibleCategoriesForCurrentKasir();
    filterCategory(visibleCategories.includes('Makanan') ? 'Makanan' : (visibleCategories[0] || ''));
}

// --- PRINT & LOGIN ---
// Menandakan apakah admin pertama sudah pernah daftar (dicek dari doc config/adminSetup).
// null = belum dicek, true/false = hasil pengecekan terakhir.
let adminAlreadyRegistered = null;

async function openLoginModal() {
    document.getElementById('modal-login').classList.remove('hidden');
    resetLoginModalFields();
    await refreshAdminSetupStatusAndRenderTabs();
}
function closeLoginModal() { document.getElementById('modal-login').classList.add('hidden'); }

function resetLoginModalFields() {
    ['login-user', 'login-pass', 'register-user', 'register-pass', 'register-pass-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

// Cek ke Firestore apakah sudah ada admin yang terdaftar (doc config/adminSetup, field `registered`).
// Berdasarkan hasilnya, tampilkan tab yang sesuai: kalau BELUM ada admin sama sekali, buka
// otomatis ke tab "Daftar" (karena belum ada akun buat login). Kalau SUDAH ada, sembunyikan
// total tab "Daftar" supaya form pendaftaran cuma bisa dipakai sekali seumur hidup aplikasi.
async function refreshAdminSetupStatusAndRenderTabs() {
    const tabsEl = document.getElementById('login-tabs');
    const loadingEl = document.getElementById('login-panel-loading');
    const masukPanel = document.getElementById('login-panel-masuk');
    const daftarPanel = document.getElementById('login-panel-daftar');

    tabsEl.classList.add('hidden');
    masukPanel.classList.add('hidden');
    daftarPanel.classList.add('hidden');
    loadingEl.classList.remove('hidden');

    try {
        if (!window.FB || !window.FB.ready) {
            // Belum terhubung ke Firebase, tunggu event 'firebase-ready' lalu coba lagi.
            await new Promise((resolve) => {
                window.addEventListener('firebase-ready', resolve, { once: true });
            });
        }
        const { db, doc, getDoc } = window.FB;
        const snap = await getDoc(doc(db, 'config', 'adminSetup'));
        adminAlreadyRegistered = snap.exists() && snap.data().registered === true;
    } catch (err) {
        console.error('Gagal memeriksa status pendaftaran admin:', err);
        // Kalau gagal cek (misal offline), amankan dengan anggap SUDAH terdaftar supaya
        // form Daftar tidak nongol sembarangan tanpa kepastian.
        adminAlreadyRegistered = true;
    } finally {
        loadingEl.classList.add('hidden');
    }

    if (adminAlreadyRegistered) {
        // Admin sudah ada -> tab Daftar disembunyikan total, langsung ke Login.
        document.getElementById('login-tab-btn-daftar').classList.add('hidden');
        switchLoginTab('masuk');
    } else {
        // Belum ada admin sama sekali -> tampilkan kedua tab, tapi buka di Daftar dulu.
        document.getElementById('login-tab-btn-daftar').classList.remove('hidden');
        switchLoginTab('daftar');
    }
    tabsEl.classList.remove('hidden');
}

function switchLoginTab(tab) {
    const isDaftar = tab === 'daftar';
    document.getElementById('login-panel-masuk').classList.toggle('hidden', isDaftar);
    document.getElementById('login-panel-daftar').classList.toggle('hidden', !isDaftar);
    document.getElementById('login-tab-btn-masuk').classList.toggle('is-active', !isDaftar);
    document.getElementById('login-tab-btn-daftar').classList.toggle('is-active', isDaftar);
    document.getElementById('login-modal-title').innerText = isDaftar ? 'Daftar Admin' : 'Login Admin';
    document.getElementById('login-modal-subtitle').innerText = isDaftar
        ? 'Buat akun admin pertama untuk toko ini'
        : 'Masukkan kredensial akses';
}

// Pendaftaran admin PERTAMA KALI SAJA. Begitu berhasil dibuat 1 akun, doc config/adminSetup
// ditandai registered:true (dan rules Firestore mengunci supaya doc ini tidak bisa dibuat ulang
// atau diubah lagi), jadi tombol ini otomatis tidak akan bisa dipakai lagi oleh siapa pun setelahnya.
async function registerFirstAdmin() {
    const email = document.getElementById('register-user').value.trim();
    const pass = document.getElementById('register-pass').value;
    const passConfirm = document.getElementById('register-pass-confirm').value;

    if (!email || !pass || !passConfirm) return alert('Isi semua kolom dulu!');
    if (pass.length < 6) return alert('Password minimal 6 karakter.');
    if (pass !== passConfirm) return alert('Konfirmasi password tidak sama.');
    if (!window.FB || !window.FB.ready) return alert('Belum terhubung ke database. Coba lagi sebentar.');

    const btn = document.getElementById('register-submit-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Memeriksa...'; }

    try {
        // Cek ulang tepat sebelum daftar (mengurangi celah race condition kalau ada 2 device
        // yang buka form Daftar bersamaan) — kalau ternyata sudah keburu ada admin lain, batalkan.
        const { db, doc, getDoc, setDoc, createUserWithEmailAndPassword, auth, serverTimestamp } = window.FB;
        const setupSnap = await getDoc(doc(db, 'config', 'adminSetup'));
        if (setupSnap.exists() && setupSnap.data().registered === true) {
            alert('Sudah ada admin yang terdaftar duluan. Silakan gunakan menu Masuk.');
            adminAlreadyRegistered = true;
            switchLoginTab('masuk');
            document.getElementById('login-tab-btn-daftar').classList.add('hidden');
            return;
        }

        if (btn) btn.innerText = 'Mendaftarkan...';
        await createUserWithEmailAndPassword(auth, email, pass);
        // Tandai di Firestore bahwa admin pertama sudah dibuat, supaya form Daftar terkunci selamanya.
        await setDoc(doc(db, 'config', 'adminSetup'), {
            registered: true,
            email,
            registeredAt: serverTimestamp()
        });

        alert('Akun admin berhasil dibuat! Kamu langsung masuk sebagai admin.');
        closeLoginModal();
        showPage('admin');
    } catch (err) {
        console.error('Daftar admin gagal:', err);
        const friendlyMessages = {
            'auth/email-already-in-use': 'Email ini sudah terdaftar. Coba menu Masuk.',
            'auth/invalid-email': 'Format email tidak valid.',
            'auth/weak-password': 'Password terlalu lemah, minimal 6 karakter.',
            'auth/network-request-failed': 'Koneksi internet bermasalah, coba lagi.'
        };
        alert(friendlyMessages[err.code] || 'Gagal mendaftar. Coba lagi.');
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = 'Daftar'; }
    }
}

async function checkLogin() {
    const email = document.getElementById('login-user').value.trim();
    const pass = document.getElementById('login-pass').value;
    if (!email || !pass) return alert('Isi email & password dulu!');
    if (!window.FB || !window.FB.ready) return alert('Belum terhubung ke database. Coba lagi sebentar.');

    const loginBtn = document.getElementById('login-submit-btn');
    if (loginBtn) { loginBtn.disabled = true; loginBtn.innerText = 'Memeriksa...'; }

    try {
        const { auth, signInWithEmailAndPassword } = window.FB;
        await signInWithEmailAndPassword(auth, email, pass);
        closeLoginModal();
        showPage('admin');
    } catch (err) {
        console.error('Login admin gagal:', err);
        // Terjemahkan kode error Firebase yang paling umum ke pesan yang gampang dipahami.
        const friendlyMessages = {
            'auth/invalid-email': 'Format email tidak valid.',
            'auth/user-not-found': 'Akun admin ini belum terdaftar di Firebase.',
            'auth/wrong-password': 'Password salah.',
            'auth/invalid-credential': 'Email atau password salah.',
            'auth/too-many-requests': 'Terlalu banyak percobaan gagal. Coba lagi beberapa saat lagi.',
            'auth/network-request-failed': 'Koneksi internet bermasalah, coba lagi.'
        };
        alert(friendlyMessages[err.code] || 'Akses Ditolak!');
    } finally {
        if (loginBtn) { loginBtn.disabled = false; loginBtn.innerText = 'Masuk'; }
    }
}
// --- ACCORDION MENU ADMIN PANEL (judul aja yang tampil, tap buat buka/tutup isinya) ---
function toggleAdminAccordion(bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const toggleBtn = body.previousElementSibling; // tombol judul, selalu tepat sebelum body di HTML
    const chevron = toggleBtn ? toggleBtn.querySelector('.admin-accordion-chevron') : null;
    const isCurrentlyOpen = !body.classList.contains('hidden');

    body.classList.toggle('hidden', isCurrentlyOpen);
    if (chevron) chevron.classList.toggle('is-open', !isCurrentlyOpen);
}

// --- KATEGORI MENU ADMIN PANEL (grup 2 level: tap kategori dulu, baru muncul daftar menu di dalamnya) ---
function toggleAdminCategory(bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const toggleBtn = body.previousElementSibling;
    const chevron = toggleBtn ? toggleBtn.querySelector('.admin-category-chevron') : null;
    const isCurrentlyOpen = !body.classList.contains('hidden');

    body.classList.toggle('hidden', isCurrentlyOpen);
    if (chevron) chevron.classList.toggle('is-open', !isCurrentlyOpen);
}

function showPage(page) {
    document.getElementById('page-home').classList.toggle('hidden', page !== 'home');
    document.getElementById('bottom-bar').classList.toggle('hidden', page !== 'home');
    document.getElementById('page-admin').classList.toggle('hidden', page !== 'admin');

    const enteringAdmin = page === 'admin';
    adminPanelOpen = enteringAdmin;

    if (enteringAdmin) {
        // Admin Panel harus selalu bisa diakses & terlihat penuh, kapan pun — termasuk saat
        // kasir sedang dalam kondisi terkunci (absen keluar / wajib absen masuk / jendela absen
        // pulang). Sembunyikan dulu layar kunci kasir yang mungkin masih aktif di baliknya.
        forceHideKasirLockScreens();
        initAdminOnlyFirestoreSync(); // pasang listener admin-only baru sekarang, sekali saja
        renderAdminTools();
        refreshAttendanceAdminViews();
    } else {
        // Balik ke halaman Kasir — munculkan lagi layar kunci kasir kalau kondisinya masih berlaku.
        restoreKasirLockScreensIfNeeded();
        signBackToAnonymousIfAdmin(); // device balik jadi identitas anonim biasa, bukan admin lagi
    }
    lucide.createIcons();
}

// Setelah admin login pakai email/password (Firebase Auth), device ini "menjadi" akun admin
// itu. Begitu admin keluar dari Admin Panel, kembalikan device ke identitas anonim biasa
// (sama seperti kasir lain) supaya nggak nyangkut sebagai sesi admin terus-terusan.
function signBackToAnonymousIfAdmin() {
    if (!window.FB || !window.FB.auth) return;
    const user = window.FB.auth.currentUser;
    if (user && !user.isAnonymous) {
        window.FB.signOut(window.FB.auth)
            .then(() => window.FB.signInAnonymously(window.FB.auth))
            .catch((err) => console.error('Gagal kembali ke sesi anonim:', err));
    }
}

// Sembunyikan SECARA VISUAL SAJA gate/popup kunci kasir (tanpa mengubah flag state-nya),
// dipanggil setiap kali Admin Panel dibuka supaya tidak pernah ketutup layar kunci kasir.
function forceHideKasirLockScreens() {
    const gate = document.getElementById('shift-ended-gate');
    gate.classList.add('hidden');
    gate.classList.remove('flex');

    const popup = document.getElementById('modal-absen-popup');
    if (popup) {
        popup.classList.add('hidden');
        popup.classList.remove('flex');
    }

    const pinLock = document.getElementById('pin-lock-screen');
    if (pinLock) {
        pinLock.classList.add('hidden');
        pinLock.classList.remove('flex');
    }
}

// Dipanggil saat keluar dari Admin Panel (kembali ke halaman Kasir) — cek flag state yang
// sudah dihitung di balik layar tadi, lalu munculkan lagi layar kunci yang sesuai kalau masih berlaku.
function restoreKasirLockScreensIfNeeded() {
    // Identitas sesi kasir (PIN) diverifikasi PALING DULUAN, sebelum layar kunci lain — supaya
    // Admin yang masuk lewat header (tanpa lewat PIN) tetap diminta login PIN begitu kembali ke Kasir.
    if (!pinLockResolved) {
        tryShowPinLock();
        return;
    }
    if (shiftEndedActive) {
        const gate = document.getElementById('shift-ended-gate');
        gate.classList.remove('hidden');
        gate.classList.add('flex');
        return; // shift selesai = POS tertutup total, gate lain tidak relevan lagi
    }
    if (mandatoryMasukGateActive) {
        openAbsenPopup(true); // adminPanelOpen sudah false di titik ini, jadi popup beneran muncul
    }
}

function sendWhatsApp() {
    if (!lastOrder) return;
    let phone = document.getElementById('wa-number').value.replace(/[^0-9]/g, "");
    if (phone.startsWith("0")) phone = "62" + phone.slice(1);
    let text = `*STRUK ${STORE_NAME}*%0A------------------%0A`;
    lastOrder.items.forEach(i => {
        text += `${i.name} x${i.qty} = ${i.price * i.qty}%0A`;
        if (i.variantSelections) {
            text += i.variantSelections.map(v => `  - ${v.name} x${v.qty}`).join('%0A') + '%0A';
        }
    });
    text += `------------------%0A*TOTAL: Rp ${lastOrder.total.toLocaleString()}*`;
    if (lastOrder.paidAmount != null) {
        text += `%0ABayar: Rp ${lastOrder.paidAmount.toLocaleString()}%0AKembali: Rp ${lastOrder.change.toLocaleString()}`;
    }
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
}

// Cetak struk PDF dengan garis pemisah (dashed) agar terlihat rapi seperti struk kasir asli
async function printReceipt() {
    await ensureJsPDF(); // jsPDF baru di-download di sini, bukan sejak halaman dibuka
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: [80, 150] });
    const pageWidth = 80;
    const marginX = 5;
    const rightX = pageWidth - marginX;

    const drawDashedLine = (y) => {
        doc.setLineDashPattern([1, 1], 0);
        doc.setDrawColor(120, 120, 120);
        doc.line(marginX, y, rightX, y);
        doc.setLineDashPattern([], 0);
    };

    // HEADER
    doc.setFontSize(13).setFont(undefined, 'bold');
    doc.text(STORE_NAME, pageWidth / 2, 10, { align: "center" });
    doc.setFontSize(7).setFont(undefined, 'normal');

    // Alamat & no. telp ikut kasir yang transaksi ini (bukan 1 alamat toko pusat yang sama),
    // fallback ke tagline default kalau kasirnya belum diisi alamat di Admin Panel.
    const kasirEmpPdf = employeesCache.find(e => e.id === lastOrder.employeeId);
    let y = 15;
    if (kasirEmpPdf && kasirEmpPdf.address) {
        doc.text(kasirEmpPdf.address, pageWidth / 2, y, { align: "center" });
        y += 4;
        if (kasirEmpPdf.phone) {
            doc.text(`Hp. ${kasirEmpPdf.phone}`, pageWidth / 2, y, { align: "center" });
            y += 4;
        }
    } else {
        doc.text("Digital Point of Sales", pageWidth / 2, y, { align: "center" });
        y += 5;
    }

    drawDashedLine(y);
    y += 5;

    doc.setFontSize(8);
    doc.text(`No: ${lastOrder.id}`, marginX, y);
    doc.text(`${lastOrder.date}`, rightX, y, { align: "right" });
    y += 4;
    doc.text(`Metode: ${lastOrder.method}`, marginX, y);
    y += 3;

    drawDashedLine(y);
    y += 6;

    // ITEMS
    lastOrder.items.forEach(i => {
        doc.setFont(undefined, 'normal').setFontSize(8);
        doc.text(`${i.name} x${i.qty}`, marginX, y);
        doc.text(`${(i.price * i.qty).toLocaleString()}`, rightX, y, { align: "right" });
        y += 5;
        if (i.variantSelections) {
            doc.setFontSize(6.5);
            i.variantSelections.forEach(v => {
                doc.text(`- ${v.name} x${v.qty}`, marginX + 2, y);
                y += 3.5;
            });
        }
        y += 2;
    });

    drawDashedLine(y);
    y += 6;

    // TOTAL
    doc.setFontSize(10).setFont(undefined, 'bold');
    doc.text(`TOTAL`, marginX, y);
    doc.text(`Rp ${lastOrder.total.toLocaleString()}`, rightX, y, { align: "right" });
    y += 5;

    // BAYAR & KEMBALI (cuma untuk Cash — QRIS/Shopee tidak ada kembalian)
    if (lastOrder.paidAmount != null) {
        doc.setFontSize(8).setFont(undefined, 'normal');
        doc.text(`Bayar`, marginX, y);
        doc.text(`Rp ${lastOrder.paidAmount.toLocaleString()}`, rightX, y, { align: "right" });
        y += 4;
        doc.text(`Kembali`, marginX, y);
        doc.text(`Rp ${lastOrder.change.toLocaleString()}`, rightX, y, { align: "right" });
        y += 3;
    }

    drawDashedLine(y);
    y += 6;

    // FOOTER
    doc.setFontSize(7).setFont(undefined, 'normal');
    doc.text("Terima kasih telah berbelanja!", pageWidth / 2, y, { align: "center" });

    doc.save(`Struk-${lastOrder.id}.pdf`);
}

async function downloadPDF() {
    await ensureJsPDF(); // jsPDF + autotable baru di-download di sini
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const monthInput = document.getElementById('report-filter-month');
    const monthVal = (monthInput && monthInput.value) ? monthInput.value : getTodayDateStr().slice(0, 7);
    const monthLabel = new Date(`${monthVal}-01T00:00:00`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    const rows = getMonthlySalesRows(); // ikut filter karyawan/bulan yang lagi aktif di Total Penjualan
    doc.text(`Total Penjualan BUKU DAGANG - ${monthLabel}`, 10, 10);
    const data = rows.map(r => {
        const dateObj = new Date(r.date + 'T00:00:00');
        const tglLabel = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const avg = r.qty > 0 ? Math.round(r.total / r.qty) : 0;
        return [tglLabel, r.user, `Rp ${r.total.toLocaleString()}`, r.qty, `Rp ${avg.toLocaleString()}`];
    });
    // Baris TOTAL di paling bawah, sama seperti tampilan tabelnya di layar
    const totalSales = rows.reduce((sum, r) => sum + r.total, 0);
    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
    const totalAvg = totalQty > 0 ? Math.round(totalSales / totalQty) : 0;
    data.push(['TOTAL', '', `Rp ${totalSales.toLocaleString()}`, totalQty, `Rp ${totalAvg.toLocaleString()}`]);

    doc.autoTable({ head: [['Tgl/Bln/Thn', 'User', 'Sales', 'Qty', 'Avg']], body: data, startY: 18 });
    doc.save(`Total-Penjualan-${monthVal}.pdf`);
}

init();
