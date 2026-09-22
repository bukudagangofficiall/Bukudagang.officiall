let STORE_NAME = "BUKU DAGANG";
let STORE_PHONE = "";
let STORE_EMAIL = "";

let paymentSettings = { nontunaiEnabled: false, qrisEnabled: false, onlineEnabled: false, qrisImageUrl: '' };

function showAppAlert(message) {
    const backdrop = document.getElementById('app-alert-backdrop');
    const msgEl = document.getElementById('app-alert-message');
    if (!backdrop || !msgEl) return;
    msgEl.innerText = message;
    backdrop.classList.remove('hidden');
    lucide.createIcons();
}
function closeAppAlert() {
    document.getElementById('app-alert-backdrop').classList.add('hidden');
}
window.alert = showAppAlert;

function normalizePhoneForWhatsApp(rawPhone) {
    let digits = (rawPhone || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    else if (!digits.startsWith('62')) digits = '62' + digits;
    return digits.length >= 10 ? digits : null;
}

function getPaymentProofWaNumber() {
    return normalizePhoneForWhatsApp(STORE_PHONE) || ADMIN_WA_NUMBER;
}
const ADMIN_WA_NUMBER = "62895345452412";

let products = [];
let categories = ['Makanan', 'Minuman', 'Keripik'];

let cart = [];
let selectedPayment = '';
let lastOrder = null;
let currentCategory = categories[0] || '';
let orderHistory = [];

let firestoreHasPendingWrites = false;
let firestoreListenersReady = false;

let attendanceSettingsLoaded = false;
let attendanceRequired = true; // dikontrol Admin lewat toggle Aktif/Tidak Aktif di menu QR Absen
let attendanceLogLoaded = false;

function getActiveAdminId() {
    return localStorage.getItem('activeAdminId') || null;
}
function setActiveAdminId(adminId) {
    localStorage.setItem('activeAdminId', adminId);
}
function adminPathSegments(...segments) {
    const adminId = getActiveAdminId();
    return adminId ? ['admins', adminId, ...segments] : null;
}

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
    initThemedFormControls();
    lucide.createIcons();

    setDashboardLocked(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (window.FB && window.FB.ready) {
        initFirestoreSync();
    } else {
        window.addEventListener('firebase-ready', initFirestoreSync, { once: true });
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

let adminScopedSyncReady = false;
function initFirestoreSync() {
    const adminId = getActiveAdminId();
    if (!adminId) {
        showNoStoreGate();
        return;
    }
    subscribeAdminScopedData(adminId);
}

function showNoStoreGate() {
    attendanceSettingsLoaded = true;
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

let isAdminSubscribed = false;
const SUBSCRIPTION_LIMITS = {
    produk: { free: 5, subscribed: 10 },
    kategori: { free: 2, subscribed: 5 },
    karyawan: { free: 1, subscribed: 3 }
};

function subscribeAdminScopedData(adminId) {
    if (adminScopedSyncReady) return;
    adminScopedSyncReady = true;
    firestoreListenersReady = true;
    const { db, doc, collection, onSnapshot, query, orderBy } = window.FB;
    document.getElementById('connecting-gate').classList.remove('hidden');
    const a = (...segments) => doc(db, 'admins', adminId, ...segments);
    const ac = (...segments) => collection(db, 'admins', adminId, ...segments);

    onSnapshot(doc(db, 'admins', adminId), (snap) => {
        trackPendingWrites(snap);
        isAdminSubscribed = snap.exists() && snap.data().subscribed === true;
        applySubscriptionGates();
    }, (err) => console.error('Sync status langganan gagal:', err));

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

    onSnapshot(a('config', 'employees'), (snap) => {
        trackPendingWrites(snap);
        employeesCache = (snap.exists() && Array.isArray(snap.data().items)) ? snap.data().items : [];
        try {
            renderEmployeeList();
            renderScheduleTable();
            renderRiwayatAbsenEmployeeSelect();
            if (!pinLockResolved) { renderPinLockUserList(); tryShowPinLock(); }
        } catch (err) {
            console.error('Error saat render data karyawan:', err);
        }
    }, (err) => console.error('Sync karyawan gagal:', err));

    onSnapshot(a('config', 'employeeCatalog'), (snap) => {
        trackPendingWrites(snap);
        employeeCatalogCache = snap.exists() ? snap.data() : {};
        renderCategoryTabs();
        if (document.getElementById('page-admin') && !document.getElementById('page-admin').classList.contains('hidden')) {
            renderEmployeeCatalogEditor();
            renderStockPerEmployeeTable();
        }
    }, (err) => console.error('Sync katalog karyawan gagal:', err));

    onSnapshot(ac('kasirQuotaUsage'), (snap) => {
        trackPendingWrites(snap);
        kasirQuotaUsageCache = snap.docs.map(d => d.data());
        renderCatalog();
    }, (err) => console.error('Sync kuota kasir gagal:', err));

    onSnapshot(ac('schedule'), (snap) => {
        trackPendingWrites(snap);
        scheduleCache = {};
        snap.docs.forEach(d => { scheduleCache[d.id] = d.data(); });
        renderScheduleTable();
        try { checkMandatoryMasukGate(); } catch (err) { console.error('Error re-cek gerbang absen setelah jadwal berubah:', err); }
    }, (err) => console.error('Sync jadwal karyawan gagal:', err));

    onSnapshot(a('config', 'attendanceSettings'), (snap) => {
        trackPendingWrites(snap);
        attendanceSettingsLoaded = true;
        attendanceRequired = !snap.exists() || snap.data().required !== false;
        tryCloseConnectingGate();
        try {
            refreshAttendanceAdminViews();
            checkMandatoryMasukGate();
            tryShowPinLock();
        } catch (err) {
            console.error('Error saat proses data absen (settings):', err);
        }
    }, (err) => console.error('Sync pengaturan absen gagal:', err));

    onSnapshot(a('config', 'paymentSettings'), (snap) => {
        trackPendingWrites(snap);
        const data = snap.exists() ? snap.data() : {};
        paymentSettings.nontunaiEnabled = data.nontunaiEnabled === true;
        paymentSettings.qrisEnabled = data.qrisEnabled === true;
        paymentSettings.onlineEnabled = data.onlineEnabled === true;
        paymentSettings.qrisImageUrl = data.qrisImageUrl || '';
        applyPaymentSettingsToUI();
    }, (err) => console.error('Sync pengaturan pembayaran gagal:', err));

    onSnapshot(a('config', 'storeProfile'), (snap) => {
        trackPendingWrites(snap);
        if (snap.exists()) {
            const data = snap.data();
            if (data.name) STORE_NAME = data.name;
            STORE_PHONE = data.phone || '';
            STORE_EMAIL = data.email || '';
            applyStoreName();
            applyStoreContactFields();
        }
    }, (err) => console.error('Sync profile toko gagal:', err));

    onSnapshot(a('config', 'attendanceQrToken'), (snap) => {
        trackPendingWrites(snap);
        cachedQrSalt = snap.exists() ? snap.data().salt : null;
        renderAttendanceQR();
    }, (err) => console.error('Sync QR absen gagal:', err));

    onSnapshot(ac('attendance'), (snap) => {
        trackPendingWrites(snap);
        attendanceLogCache = snap.docs.map(d => d.data());
        attendanceLogLoaded = true;
        tryCloseConnectingGate();
        try {
            renderRiwayatAbsen();
            checkMandatoryMasukGate();
            renderCategoryTabs();
            updateCashRekonLockState();
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

function switchActiveAdminAndResync(adminId) {
    setActiveAdminId(adminId);
    adminScopedSyncReady = false;
    products = []; categories = ['Makanan', 'Minuman', 'Keripik']; employeesCache = [];
    employeeCatalogCache = {}; kasirQuotaUsageCache = []; scheduleCache = {};
    orderHistory = []; attendanceLogCache = []; cashReconciliationCache = [];
    adminOnlyFirestoreSyncReady = false;
    subscribeAdminScopedData(adminId);
}

let adminOnlyFirestoreSyncReady = false;
function initAdminOnlyFirestoreSync() {
    if (adminOnlyFirestoreSyncReady) return;
    if (!window.FB || !window.FB.ready) return;
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

function tryCloseConnectingGate() {
    if (attendanceSettingsLoaded && attendanceLogLoaded) {
        document.getElementById('connecting-gate').classList.add('hidden');
    }
}

function trackPendingWrites(snap) {
    firestoreHasPendingWrites = snap.metadata.hasPendingWrites;
    updateConnectionUI();
}

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
        });
    }
}

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
    event.preventDefault();
    deferredInstallPrompt = event;
    createInstallButton();
});

window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    removeInstallButton();
    showToast('Aplikasi berhasil di-install!', 'success');
});

function renderCategoryTabs() {
    const container = document.getElementById('tabs-container');
    if (!container) return;
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

    if (!firestoreListenersReady) {
        grid.innerHTML = Array.from({ length: 6 }).map(() => `
            <div class="skeleton-card p-5 rounded-[1.75rem]">
                <div class="skeleton-line w-3/4 h-4 mb-3 rounded-full"></div>
                <div class="skeleton-line w-1/2 h-4 rounded-full"></div>
            </div>`).join('');
        return;
    }

    const visibleProducts = getVisibleProductsForCurrentKasir();
    let filtered = visibleProducts.filter(p => p.category === currentCategory);
    if (productSearchTerm) {
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
    const limit = isAdminSubscribed ? SUBSCRIPTION_LIMITS.produk.subscribed : SUBSCRIPTION_LIMITS.produk.free;
    if (products.length >= limit) {
        return alert(isAdminSubscribed
            ? `Sudah mencapai batas ${limit} produk untuk paket langganan kamu. Butuh lebih? Ajukan lewat menu Langganan Saya.`
            : `Batas gratis cuma ${limit} produk. Aktifkan langganan dulu untuk tambah hingga ${SUBSCRIPTION_LIMITS.produk.subscribed} produk.`);
    }
    const name = document.getElementById('add-name').value;
    const price = parseInt(document.getElementById('add-price').value);
    const category = document.getElementById('add-category').value;
    const variantConfig = readVariantConfig('add');

    if (!name || isNaN(price) || price < 0) return alert("Harap isi Nama dan Harga (boleh 0 untuk item pilihan rasa)!");
    if (variantConfig.enabled && !variantConfig.sourceCategory) return alert("Pilih kategori sumber untuk pilihan isi/rasa!");

    const newProduct = {
        id: Date.now(),
        name: name,
        price: price,
        category: category,
        variantConfig: variantConfig
    };

    saveProductsToFirestore([...products, newProduct]);

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
    showThemedConfirm("Hapus menu ini dari katalog?", () => {
        saveProductsToFirestore(products.filter(p => p.id !== id));
        showToast('Produk dihapus!', 'success');
    });
}

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
    const limit = isAdminSubscribed ? SUBSCRIPTION_LIMITS.kategori.subscribed : SUBSCRIPTION_LIMITS.kategori.free;
    if (categories.length >= limit) {
        return alert(isAdminSubscribed
            ? `Sudah mencapai batas ${limit} kategori untuk paket langganan kamu. Butuh lebih? Ajukan lewat menu Langganan Saya.`
            : `Batas gratis cuma ${limit} kategori. Aktifkan langganan dulu untuk tambah hingga ${SUBSCRIPTION_LIMITS.kategori.subscribed} kategori.`);
    }
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
    showThemedConfirm(`Hapus kategori "${cat}"?`, () => saveCategoriesToFirestore(categories.filter(c => c !== cat)));
}

function renderAdminTools() {
    applyStoreName();
    const select = document.getElementById('edit-select');
    select.innerHTML = products.map(p => `<option value="${p.id}">${p.name} [${p.category}]</option>`).join('');
    renderCategorySelects();
    renderCategoryList();
    renderStockEmployeeSelect();
    renderEmployeeCatalogSelect();
    renderScheduleTable();
    renderRiwayatAbsenEmployeeSelect();
    renderCashRekonFilterOptions();
    renderCashReconciliationTable();
    loadProductData();

    renderTotalPenjualanFilterOptions();
    applyTotalPenjualanFilter();

    renderProductSalesFilterOptions();
    renderProductSalesTable();
}

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

function updateCashRekonLockState() {
    const dateInput = document.getElementById('cashrek-date');
    const empSelect = document.getElementById('cashrek-employee');
    const submitBtn = document.getElementById('cashrek-submit-btn');
    const warning = document.getElementById('cashrek-lock-warning');
    if (!dateInput || !empSelect || !submitBtn || !warning) return;

    const dateStr = dateInput.value;
    const empId = empSelect.value;

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

function renderTotalPenjualanFilterOptions() {
    const select = document.getElementById('report-filter-employee');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = '<option value="">Semua Karyawan</option>' + employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;

    const monthInput = document.getElementById('report-filter-month');
    if (monthInput && !monthInput.value) monthInput.value = getTodayDateStr().slice(0, 7);
}

function getFilteredOrderHistory() {
    const empSelect = document.getElementById('report-filter-employee');
    const monthInput = document.getElementById('report-filter-month');
    const empId = empSelect ? empSelect.value : '';
    const monthVal = (monthInput && monthInput.value) ? monthInput.value : getTodayDateStr().slice(0, 7);

    return orderHistory.filter(o => {
        if (empId && o.employeeId !== empId) return false;
        if (!o.timestamp || !getTodayDateStr(new Date(o.timestamp)).startsWith(monthVal)) return false;
        return true;
    });
}

function getMonthlySalesRows() {
    const filtered = getFilteredOrderHistory();
    const groups = {};
    filtered.forEach(o => {
        const dateStr = getTodayDateStr(new Date(o.timestamp));
        const userName = o.employeeName || 'Tanpa Nama';
        const key = dateStr + '|' + userName;
        if (!groups[key]) groups[key] = { date: dateStr, user: userName, total: 0, qty: 0 };
        groups[key].total += (o.total || 0);
        groups[key].qty += 1;
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

function renderProductSalesFilterOptions() {
    const select = document.getElementById('prodsales-employee');
    const dateInput = document.getElementById('prodsales-date');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = '<option value="">Semua Karyawan</option>' + employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;

    if (dateInput && !dateInput.value) dateInput.value = getTodayDateStr();
}

function getOrdersForDate(dateStr, empId) {
    return orderHistory.filter(o => {
        if (!o.timestamp) return false;
        if (getTodayDateStr(new Date(o.timestamp)) !== dateStr) return false;
        if (empId && o.employeeId !== empId) return false;
        return true;
    });
}

function getProductSalesForDate(dateStr, empId) {
    const map = {};
    getOrdersForDate(dateStr, empId).forEach(o => {
        (o.items || []).forEach(item => {
            if (!map[item.name]) map[item.name] = { name: item.name, qty: 0, nominal: 0 };
            map[item.name].qty += item.qty;
            map[item.name].nominal += item.price * item.qty;
        });
    });
    return Object.values(map).sort((a, b) => b.qty - a.qty);
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
            const usageSnap = usageRef ? await transaction.get(usageRef) : null;
            const currentProducts = snap.exists() ? (snap.data().items || []) : [];
            const currentUsage = (usageSnap && usageSnap.exists()) ? (usageSnap.data().usage || {}) : {};

            const decreaseProductStock = (productId, qty) => {
                const idx = currentProducts.findIndex(p => p.id === productId);
                if (idx !== -1 && currentProducts[idx].stock != null) {
                    currentProducts[idx].stock = Math.max(0, currentProducts[idx].stock - qty);
                }
            };
            const addUsage = (productId, qty) => {
                if (!quotaProductIds.has(productId)) return;
                currentUsage[productId] = (currentUsage[productId] || 0) + qty;
            };

            items.forEach(item => {
                if (item.variantSelections && item.variantSelections.length) {
                    item.variantSelections.forEach(sel => {
                        if (sel.id == null) return;
                        const totalQty = sel.qty * item.qty;
                        decreaseProductStock(sel.id, totalQty);
                        addUsage(sel.id, totalQty);
                    });
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

function getTodaySalesForProduct(productId) {
    const empId = currentSessionEmployeeId;
    let qty = 0, revenue = 0;
    getTodaysOrders().forEach(order => {
        if (empId && order.employeeId !== empId) return;
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

function addToCart(id) {
    const product = products.find(p => p.id === id);
    const existing = cart.find(item => item.id === id);
    if (existing) { existing.qty++; } else { cart.push({ ...product, qty: 1 }); }
    updateCartUI();
}

function addToCartWithBump(evt, id) {
    addToCart(id);
    const card = evt.currentTarget;
    if (card) {
        card.classList.remove('card-bump');
        void card.offsetWidth;
        card.classList.add('card-bump');
    }
    const cartBtn = document.querySelector('button[onclick="openCheckout()"]');
    if (cartBtn) {
        cartBtn.classList.remove('cart-bump');
        void cartBtn.offsetWidth;
        cartBtn.classList.add('cart-bump');
    }
    if (navigator.vibrate) navigator.vibrate(15);
}

let variantModalState = { product: null, options: [], selections: {} };

function openVariantModal(productId) {
    const product = products.find(p => p.id === productId);
    if (!product || !product.variantConfig || !product.variantConfig.enabled) return addToCart(productId);

    const sourceCategory = product.variantConfig.sourceCategory;
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

    if (delta > 0 && totalSelected >= required) return;
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
        .map(o => ({ id: o.id, name: o.name, qty: state.selections[o.id] }));

    cart.push({
        id: `v_${Date.now()}`,
        productId: state.product.id,
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
    const item = cart.find(i => i.id == id);
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
    try {
        updatePaymentButtons();
    } catch (err) {
        console.error('Error saat render tombol pembayaran (diabaikan, tidak menghalangi checkout):', err);
    }
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

function applyPaymentSettingsToUI() {
    const qrisImg = document.getElementById('qris-payment-image');
    if (qrisImg) qrisImg.src = paymentSettings.qrisImageUrl || 'qris.jpg';
    const qrisThumb = document.getElementById('qris-preview-thumb');
    if (qrisThumb) qrisThumb.src = paymentSettings.qrisImageUrl || 'qris.jpg';

    const qrisUploadSection = document.getElementById('qris-upload-section');
    if (qrisUploadSection) qrisUploadSection.classList.toggle('hidden', !isAdminSubscribed);

    const methods = [
        { key: 'nontunai', enabled: paymentSettings.nontunaiEnabled, needsSub: false, toggleId: 'toggle-nontunai', btnId: 'btn-nontunai', cardId: null, sublabelId: null },
        { key: 'qris', enabled: paymentSettings.qrisEnabled, needsSub: true, toggleId: 'toggle-qris', btnId: 'btn-qr', cardId: 'payment-qris-card', sublabelId: 'payment-qris-sublabel' },
        { key: 'online', enabled: paymentSettings.onlineEnabled, needsSub: true, toggleId: 'toggle-online', btnId: 'btn-sf', cardId: 'payment-online-card', sublabelId: 'payment-online-sublabel' }
    ];

    methods.forEach(({ enabled, needsSub, toggleId, btnId, cardId, sublabelId }) => {
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.toggle('hidden', !(enabled && (!needsSub || isAdminSubscribed)));

        const toggleEl = document.getElementById(toggleId);
        if (!toggleEl) return;
        const icons = toggleEl.querySelectorAll('i');
        const locked = needsSub && !isAdminSubscribed;
        if (locked) {
            toggleEl.className = 'w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center shrink-0';
            icons[0]?.classList.add('hidden');
            icons[1]?.classList.remove('hidden');
        } else {
            toggleEl.className = enabled
                ? 'w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shrink-0'
                : 'w-6 h-6 rounded-full border-2 border-slate-300 flex items-center justify-center shrink-0';
            icons[0]?.classList.toggle('hidden', !enabled);
            icons[1]?.classList.add('hidden');
        }
        if (cardId) document.getElementById(cardId)?.classList.toggle('opacity-50', locked);
        if (sublabelId) {
            const sublabelEl = document.getElementById(sublabelId);
            if (sublabelEl) sublabelEl.innerText = locked ? 'Butuh langganan aktif' : 'Tap untuk nyalakan/matikan';
        }
    });
    lucide.createIcons();
}

function togglePaymentMethod(method) {
    if ((method === 'qris' || method === 'online') && !isAdminSubscribed) {
        const labels = { qris: 'QRIS', online: 'Online (Shopee/Gofood/Grabfood)' };
        return alert(`Pembayaran ${labels[method]} butuh langganan aktif dulu.`);
    }
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const fieldMap = { nontunai: 'nontunaiEnabled', qris: 'qrisEnabled', online: 'onlineEnabled' };
    const field = fieldMap[method];
    if (!field) return;

    const oldValue = paymentSettings[field];
    paymentSettings[field] = !oldValue;
    applyPaymentSettingsToUI();

    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'paymentSettings')), { [field]: paymentSettings[field] }, { merge: true })
        .catch((err) => {
            console.error('Gagal ubah pengaturan pembayaran:', err);
            paymentSettings[field] = oldValue;
            applyPaymentSettingsToUI();
            alert('Gagal menyimpan ke server. Kemungkinan Firestore Security Rules belum mengizinkan field ini — cek Firebase Console.');
        });
}

function compressImageToDataUrl(file, maxSize = 500) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            let { width, height } = img;
            if (width > height && width > maxSize) { height = Math.round(height * (maxSize / width)); width = maxSize; }
            else if (height > maxSize) { width = Math.round(width * (maxSize / height)); height = maxSize; }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);

            let quality = 0.8;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            while (dataUrl.length > 700000 && quality > 0.3) {
                quality -= 0.15;
                dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            if (dataUrl.length > 700000) {
                reject(new Error('Foto masih terlalu besar setelah dikompres.'));
                return;
            }
            resolve(dataUrl);
        };
        img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Gagal membaca file gambar.')); };
        img.src = objectUrl;
    });
}

function uploadQrisImage(fileInput) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const statusEl = document.getElementById('qris-upload-status');
    if (statusEl) { statusEl.innerText = 'Mengompres & mengupload...'; statusEl.classList.remove('hidden'); }

    compressImageToDataUrl(file)
        .then((dataUrl) => {
            const { db, doc, setDoc } = window.FB;
            return setDoc(doc(db, ...adminPathSegments('config', 'paymentSettings')), { qrisImageUrl: dataUrl }, { merge: true });
        })
        .then(() => {
            if (statusEl) statusEl.classList.add('hidden');
            showToast('Foto QRIS berhasil diupload.', 'success');
        })
        .catch((err) => {
            console.error('Gagal upload foto QRIS:', err);
            if (statusEl) statusEl.classList.add('hidden');
            alert(err.message === 'Foto masih terlalu besar setelah dikompres.'
                ? 'Foto masih terlalu besar walau sudah dikompres. Coba pakai foto QRIS yang lebih sederhana/kecil.'
                : 'Gagal upload foto. Coba lagi.');
        });
    fileInput.value = '';
}

function setPayment(method) {
    selectedPayment = method;
    document.getElementById('confirm-pay').disabled = false;
    try {
        updatePaymentButtons();
    } catch (err) {
        console.error('Error saat render tombol pembayaran (diabaikan, tidak menghalangi checkout):', err);
    }

    if (method === 'QRIS') {
        showQrisModal();
    }

    const cashBox = document.getElementById('cash-received-box');
    if (cashBox) {
        cashBox.classList.toggle('hidden', method !== 'Cash');
        if (method === 'Cash') {
            const cashInput = document.getElementById('cash-received-input');
            if (cashInput) {
                const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
                cashInput.value = total;
            }
            updateCashChangeDisplay();
        }
    }
}

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
    const btns = { 'Cash': 'btn-cash', 'Nontunai': 'btn-nontunai', 'QRIS': 'btn-qr', 'Shopee': 'btn-sf' };
    Object.values(btns).forEach(id => {
        document.getElementById(id).className = "pay-btn border-2 p-4 rounded-2xl text-[11px] font-bold bg-white border-slate-200 relative";
    });
    if (btns[selectedPayment]) {
        document.getElementById(btns[selectedPayment]).className = "pay-btn border-2 p-4 rounded-2xl text-[11px] font-bold bg-blue-50 border-blue-600 text-blue-700 relative";
    }
    applyPaymentSettingsToUI();

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

let activeProofId = null;

async function handleQrisPhotoCapture(event) {
    const file = event.target.files[0];
    event.target.value = '';
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

async function trySendProofWhatsApp(proof) {
    const caption = `Bukti Pembayaran QRIS - ${STORE_NAME}\nWaktu: ${new Date(proof.timestamp).toLocaleString('id-ID')}\nNominal: Rp ${proof.total.toLocaleString()}`;
    const file = dataUrlToFile(proof.dataUrl, `bukti-qris-${proof.id}.jpg`);

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
                return;
            }
        }
    }

    const waLink = `https://wa.me/${getPaymentProofWaNumber()}?text=${encodeURIComponent(caption + '\n\n(Mohon lampirkan foto bukti pembayaran yang otomatis terunduh)')}`;
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

let cachedQrSalt = null;
let attendanceLogCache = [];
let employeesCache = [];
let cashReconciliationCache = [];

let employeeCatalogCache = {};
let kasirQuotaUsageCache = [];

let currentSessionEmployeeId = null;
let currentSessionEmployeeName = null;
let pinLockResolved = false;
let pinLockPendingEmployee = null;
let pinLockEnteredDigits = '';

function getCurrentKasirEmployeeId() {
    return currentSessionEmployeeId;
}

function getVisibleProductsForCurrentKasir() {
    const empId = getCurrentKasirEmployeeId();
    if (!empId) return products;
    const assigned = employeeCatalogCache[empId];
    if (!assigned || assigned.length === 0) return products;
    const assignedIds = new Set(assigned.map(a => a.productId));
    return products.filter(p => assignedIds.has(p.id));
}

function getVisibleCategoriesForCurrentKasir() {
    const visibleProducts = getVisibleProductsForCurrentKasir();
    if (visibleProducts.length === products.length) return categories;
    const activeCats = new Set(visibleProducts.map(p => p.category));
    const filtered = categories.filter(c => activeCats.has(c));
    return filtered.length > 0 ? filtered : categories;
}

function getKasirUsageToday(employeeId, productId) {
    const todayStr = getTodayDateStr();
    const rec = kasirQuotaUsageCache.find(r => r.date === todayStr && r.employeeId === employeeId);
    return (rec && rec.usage && rec.usage[productId]) || 0;
}

function getEffectiveStockForCurrentKasir(product) {
    const empId = getCurrentKasirEmployeeId();
    if (!empId) return product.stock;
    const assigned = employeeCatalogCache[empId];
    const entry = assigned && assigned.find(a => a.productId === product.id);
    if (!entry || entry.qty == null) return product.stock;
    const usedToday = getKasirUsageToday(empId, product.id);
    const remainingQuota = Math.max(0, entry.qty - usedToday);
    if (product.stock == null) return remainingQuota;
    return Math.min(product.stock, remainingQuota);
}

function tryShowPinLock() {
    if (!attendanceSettingsLoaded || !attendanceLogLoaded) return;
    if (pinLockResolved || adminPanelOpen) return;
    renderPinLockUserList();
    const el = document.getElementById('pin-lock-screen');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    lucide.createIcons();
}

function renderPinLockUserList() {
    const input = document.getElementById('pin-lock-nik-input');
    const preview = document.getElementById('pin-lock-nik-preview');
    const continueBtn = document.getElementById('pin-lock-nik-continue');
    const emptyMsg = document.getElementById('pin-lock-no-employee-msg');
    if (input) input.value = '';
    if (preview) { preview.style.display = 'none'; preview.classList.remove('is-error'); }
    if (continueBtn) { continueBtn.disabled = true; delete continueBtn.dataset.empId; delete continueBtn.dataset.empName; }
    if (emptyMsg) emptyMsg.classList.toggle('hidden', employeesCache.length > 0);
}

function handlePinLockNikInput(rawValue) {
    const nik = rawValue.replace(/\D/g, '').slice(0, 6);
    const input = document.getElementById('pin-lock-nik-input');
    if (input && input.value !== nik) input.value = nik;
    const preview = document.getElementById('pin-lock-nik-preview');
    const continueBtn = document.getElementById('pin-lock-nik-continue');
    if (!preview || !continueBtn) return;

    if (nik.length < 6) {
        preview.style.display = 'none';
        continueBtn.disabled = true;
        return;
    }
    const emp = employeesCache.find(e => e.nik === nik);
    preview.style.display = 'flex';
    if (emp) {
        preview.classList.remove('is-error');
        preview.innerHTML = `<i data-lucide="check-circle-2" class="w-4 h-4"></i> ${emp.name}`;
        continueBtn.disabled = false;
        continueBtn.dataset.empId = emp.id;
        continueBtn.dataset.empName = emp.name;
    } else {
        preview.classList.add('is-error');
        preview.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4"></i> NIK tidak ditemukan`;
        continueBtn.disabled = true;
        delete continueBtn.dataset.empId;
        delete continueBtn.dataset.empName;
    }
    lucide.createIcons();
}

function pinLockContinueFromNik() {
    const continueBtn = document.getElementById('pin-lock-nik-continue');
    if (!continueBtn || !continueBtn.dataset.empId) return;
    pinLockSelectUser(continueBtn.dataset.empId, continueBtn.dataset.empName);
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
    renderPinLockUserList();
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
        setTimeout(pinLockVerify, 150);
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
        renderCategoryTabs();
        renderHomeGreeting();
        checkMandatoryMasukGate();
    } else {
        document.getElementById('pin-lock-error').innerText = 'PIN salah, coba lagi.';
        pinLockEnteredDigits = '';
        renderPinLockDots();
    }
}

function renderHomeGreeting() {
    const nameEl = document.getElementById('home-greeting-name');
    if (nameEl) nameEl.innerText = currentSessionEmployeeName || '-';
}

function lockPinSession() {
    if (adminPanelOpen) return;
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

function renderEmployeeList() {
    const list = document.getElementById('employee-list');
    if (!list) return;
    list.innerHTML = employeesCache.map(emp => `
        <div class="bg-white border border-slate-100 rounded-xl p-2.5">
            <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                    <span class="font-bold text-sm text-slate-800 block truncate">${emp.name}</span>
                    <span class="text-[10px] font-bold text-blue-600 tracking-widest">NIK ${emp.nik || '-'}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
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
    renderEmployeeCatalogSelect();
    renderStockEmployeeSelect();
}

function saveEmployeesToFirestore(newList) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
        return;
    }
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'employees')), { items: newList }).catch((err) => {
        console.error('Gagal simpan karyawan:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

function generateUniqueEmployeeNik() {
    let nik;
    do {
        nik = String(Math.floor(100000 + Math.random() * 900000));
    } while (employeesCache.some(e => e.nik === nik));
    return nik;
}

function addEmployee() {
    const limit = isAdminSubscribed ? SUBSCRIPTION_LIMITS.karyawan.subscribed : SUBSCRIPTION_LIMITS.karyawan.free;
    if (employeesCache.length >= limit) {
        return alert(isAdminSubscribed
            ? `Sudah mencapai batas ${limit} karyawan untuk paket langganan kamu. Butuh lebih? Ajukan lewat menu Langganan Saya.`
            : `Batas gratis cuma ${limit} karyawan. Aktifkan langganan dulu untuk tambah hingga ${SUBSCRIPTION_LIMITS.karyawan.subscribed} karyawan.`);
    }
    const nameInput = document.getElementById('new-employee-name');
    const pinInput = document.getElementById('new-employee-pin');
    const name = nameInput.value.trim();
    const pin = pinInput.value.trim();
    if (!name) return alert('Nama karyawan tidak boleh kosong!');
    if (!/^\d{4}$/.test(pin)) return alert('PIN wajib 4 digit angka!');
    if (employeesCache.some(e => e.name.toLowerCase() === name.toLowerCase())) {
        return alert('Nama karyawan tersebut sudah ada!');
    }
    const newEmployee = { id: 'emp_' + Date.now(), name, pin, nik: generateUniqueEmployeeNik() };
    saveEmployeesToFirestore([...employeesCache, newEmployee]);
    nameInput.value = '';
    pinInput.value = '';
}

function applyStoreName() {
    const headerEl = document.getElementById('store-name-header');
    if (headerEl) headerEl.innerText = STORE_NAME;
    document.title = `POS KASIR - ${STORE_NAME}`;
    const nameInput = document.getElementById('store-name-input');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = STORE_NAME;
}

function applyStoreContactFields() {
    const phoneInput = document.getElementById('store-phone-input');
    const emailInput = document.getElementById('store-email-input');
    if (phoneInput && document.activeElement !== phoneInput) phoneInput.value = STORE_PHONE;
    if (emailInput && document.activeElement !== emailInput) emailInput.value = STORE_EMAIL;
}

function saveStoreProfile() {
    const nameInput = document.getElementById('store-name-input');
    const phoneInput = document.getElementById('store-phone-input');
    const emailInput = document.getElementById('store-email-input');
    const newName = nameInput ? nameInput.value.trim() : '';
    const newPhone = phoneInput ? phoneInput.value.trim() : '';
    const newEmail = emailInput ? emailInput.value.trim() : '';
    if (!newName) return alert('Nama toko tidak boleh kosong!');
    if (newEmail && !/^\S+@\S+\.\S+$/.test(newEmail)) return alert('Format email tidak valid!');
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'storeProfile')), { name: newName, phone: newPhone, email: newEmail }).then(() => {
        showToast('Profile toko berhasil disimpan.', 'success');
    }).catch((err) => {
        console.error('Gagal simpan profile toko:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

function editEmployeeContact(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;
    const newAddress = prompt(`Alamat untuk ${emp.name} (tampil di struk):`, emp.address || '');
    if (newAddress === null) return;
    const newPhone = prompt(`No. Telp untuk ${emp.name} (tampil di struk):`, emp.phone || '');
    if (newPhone === null) return;
    saveEmployeesToFirestore(employeesCache.map(e => e.id === id ? { ...e, address: newAddress.trim(), phone: newPhone.trim() } : e));
}

function changeEmployeePin(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;
    const newPin = prompt(`PIN baru buat ${emp.name} (4 digit angka):`, '');
    if (newPin === null) return;
    if (!/^\d{4}$/.test(newPin.trim())) return alert('PIN wajib 4 digit angka!');
    saveEmployeesToFirestore(employeesCache.map(e => e.id === id ? { ...e, pin: newPin.trim() } : e));
}

function deleteEmployee(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;
    showThemedConfirm(`Hapus karyawan "${emp.name}"?`, () => {
        saveEmployeesToFirestore(employeesCache.filter(e => e.id !== id));
    });
}

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
        list.innerHTML = '<p class="text-xs text-slate-400 text-center py-6">Tambahkan karyawan dulu di "Tambah Karyawan".</p>';
        return;
    }
    if (!empId) {
        list.innerHTML = '<p class="text-xs text-slate-400 text-center py-6">Pilih karyawan dulu.</p>';
        return;
    }

    const assignedIds = new Set((employeeCatalogCache[empId] || []).map(a => a.productId));

    list.innerHTML = products.map(p => {
        const isAssigned = assignedIds.has(p.id);
        return `
        <div class="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-xl p-2.5">
            <input type="checkbox" data-empcat-product="${p.id}" ${isAssigned ? 'checked' : ''} class="empcat-checkbox w-4 h-4 accent-pink-600 shrink-0">
            <div class="min-w-0 flex-1">
                <p class="font-bold text-xs text-slate-800 truncate">${p.name}</p>
                <p class="text-[10px] text-slate-400">${p.category}</p>
            </div>
        </div>`;
    }).join('') || '<p class="text-xs text-slate-400 text-center py-6">Belum ada produk di katalog. Tambahkan produk dulu.</p>';
    lucide.createIcons();
}

function saveEmployeeCatalog() {
    const select = document.getElementById('empcat-employee-select');
    const empId = select ? select.value : '';
    if (!empId) return alert('Pilih karyawan dulu!');
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const existingQtyMap = {};
    (employeeCatalogCache[empId] || []).forEach(a => { existingQtyMap[a.productId] = a.qty; });

    const assigned = [];
    document.querySelectorAll('.empcat-checkbox:checked').forEach(cb => {
        const productId = parseInt(cb.getAttribute('data-empcat-product'));
        const qty = Object.prototype.hasOwnProperty.call(existingQtyMap, productId) ? existingQtyMap[productId] : null;
        assigned.push({ productId, qty });
    });

    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'employeeCatalog')), { [empId]: assigned }, { merge: true }).then(() => {
        const empName = (employeesCache.find(e => e.id === empId) || {}).name || '';
        showToast(`Katalog untuk ${empName} tersimpan!`, 'success');
    }).catch((err) => {
        console.error('Gagal simpan katalog karyawan:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

let scheduleCache = {};
let scheduleViewDate = new Date();
let scheduleEditingEmployeeId = null;
let scheduleEditingDateStr = null;

function scheduleDateStr(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function changeScheduleMonth(delta) {
    scheduleViewDate.setMonth(scheduleViewDate.getMonth() + delta);
    scheduleViewDate = new Date(scheduleViewDate);
    renderScheduleTable();
}

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
            const isLibur = !!(empEntry && empEntry.libur);
            const cellLabel = isLibur ? 'LIBUR' : (empEntry ? empEntry.jamMulai : '');
            const cellClass = isLibur ? 'is-libur' : (empEntry ? 'is-scheduled' : '');
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

function openScheduleCellEditor(empId, dateStr) {
    scheduleEditingEmployeeId = empId;
    scheduleEditingDateStr = dateStr;

    const emp = employeesCache.find(e => e.id === empId);
    const entry = scheduleCache[dateStr];
    const empEntry = entry && entry.employees ? entry.employees.find(e => e.id === empId) : null;
    const dateObj = new Date(dateStr + 'T00:00:00');
    const isLibur = !!(empEntry && empEntry.libur);

    document.getElementById('schedule-cell-title').innerText = `${emp ? emp.name : ''} — ${dateObj.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}`;
    document.getElementById('schedule-cell-jam-masuk').value = (empEntry && !isLibur) ? (empEntry.jamMulai || '') : '';
    document.getElementById('schedule-cell-jam-masuk').disabled = isLibur;
    document.getElementById('schedule-cell-remove-btn').classList.toggle('hidden', !empEntry);

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
    const updatedEmployees = [...existing.filter(e => e.id !== empId), { id: empId, jamMulai }];

    setDoc(doc(db, ...adminPathSegments('schedule', dateStr)), { date: dateStr, employees: updatedEmployees }).then(() => {
        showToast('Jadwal tersimpan!', 'success');
        closeScheduleCellEditor();
    }).catch((err) => {
        console.error('Gagal simpan jadwal:', err);
        showToast('Gagal menyimpan jadwal ke server.', 'warn');
    });
}

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
        ? existing.filter(e => e.id !== empId)
        : [...existing.filter(e => e.id !== empId), { id: empId, libur: true }];

    setDoc(doc(db, ...adminPathSegments('schedule', dateStr)), { date: dateStr, employees: updatedEmployees }).then(() => {
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
    showThemedConfirm('Hapus jadwal karyawan ini di tanggal ini?', () => {
        const { db, doc, setDoc, deleteDoc } = window.FB;
        const empId = scheduleEditingEmployeeId;
        const dateStr = scheduleEditingDateStr;
        const existing = (scheduleCache[dateStr] && scheduleCache[dateStr].employees) || [];
        const remaining = existing.filter(e => e.id !== empId);

        const savePromise = remaining.length > 0
            ? setDoc(doc(db, ...adminPathSegments('schedule', dateStr)), { date: dateStr, employees: remaining })
            : deleteDoc(doc(db, ...adminPathSegments('schedule', dateStr)));

        savePromise.then(() => {
            showToast('Jadwal dihapus!', 'success');
            closeScheduleCellEditor();
        }).catch((err) => {
            console.error('Gagal hapus jadwal:', err);
            showToast('Gagal menyimpan ke server.', 'warn');
        });
    });
}

function hashSaltAndDate(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36).toUpperCase();
}
function getQrToken() {
    if (!cachedQrSalt) return null;
    const todayStr = getTodayDateStr();
    return `ABSEN-${todayStr.replace(/-/g, '')}-${hashSaltAndDate(cachedQrSalt + todayStr)}`;
}

function ensureQrSaltExists() {
    if (cachedQrSalt || !adminPanelOpen) return;
    if (!window.FB || !window.FB.ready) return;
    const salt = Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'attendanceQrToken')), { salt }, { merge: true }).catch((err) => {
        console.error('Gagal membuat salt QR absen:', err);
    });
}

async function renderAttendanceQR() {
    const container = document.getElementById('qr-absen-container');
    const tokenInput = document.getElementById('qr-token-text');
    if (!container) return;
    container.innerHTML = '';
    ensureQrSaltExists();
    const token = getQrToken();
    if (!token) {
        container.innerHTML = '<p class="text-xs text-slate-400 text-center py-8">Menyiapkan QR...</p>';
        if (tokenInput) tokenInput.value = '';
        return;
    }
    container.innerHTML = '<p class="text-xs text-slate-400 text-center py-8">Memuat QR...</p>';
    await ensureQRCode();
    container.innerHTML = '';
    new QRCode(container, { text: token, width: 160, height: 160, colorDark: '#000000', colorLight: '#ffffff' });
    if (tokenInput) tokenInput.value = token;
}

function copyQrTokenText() {
    if (!isAdminSubscribed) return alert('Fitur QR Absen butuh langganan aktif dulu.');
    const tokenInput = document.getElementById('qr-token-text');
    if (!tokenInput || !tokenInput.value) return showToast('Belum ada QR untuk disalin.', 'warn');
    tokenInput.select();
    navigator.clipboard.writeText(tokenInput.value).then(() => {
        showToast('Kode berhasil disalin! Bagikan ke kasir lewat WhatsApp.', 'success');
    }).catch(() => {
        showToast('Gagal menyalin otomatis, silakan salin manual dari kotak teksnya.', 'warn');
    });
}

let qrScanStream = null;
let qrScanRAF = null;
let qrScanPendingType = null;
let qrScanPendingEmployee = null;
let qrScanHintTimeout = null;

function openEmployeePicker(type) {
    if (employeesCache.length === 0) {
        showToast('Admin belum menambahkan data karyawan. Buka Admin Panel > Karyawan > Tambah Karyawan.', 'warn');
        return;
    }
    if (!getQrToken()) {
        showToast('QR Absen belum di-generate Admin. Hubungi Admin dulu.', 'warn');
        return;
    }

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
        await ensureJsQR();
    } catch (err) {
        console.error('Gagal load jsQR:', err);
        document.getElementById('qr-scanner-status').innerText = 'Gagal memuat modul pemindai QR (cek koneksi internet kasir), coba lagi.';
        return;
    }

    try {
        document.getElementById('qr-scanner-status').innerText = 'Mengaktifkan kamera...';
        qrScanStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
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
            return;
        }
    }
    qrScanRAF = requestAnimationFrame(qrScanTick);
}

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
        const employee = qrScanPendingEmployee;
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

function refreshAttendanceAdminViews() {
    renderAttendanceQR();
    renderRiwayatAbsen();
    renderEmployeeList();
    renderScheduleTable();
    renderAttendanceRequiredToggle();
}

function renderAttendanceRequiredToggle() {
    const btn = document.getElementById('attendance-required-toggle');
    const label = document.getElementById('attendance-required-toggle-label');
    const note = document.getElementById('attendance-required-note');
    const qrContent = document.getElementById('qr-absen-content');
    const qrLock = document.getElementById('qr-absen-lock');
    if (!btn || !label) return;

    if (qrContent) qrContent.classList.toggle('hidden', !isAdminSubscribed);
    if (qrLock) qrLock.classList.toggle('hidden', isAdminSubscribed);

    if (!isAdminSubscribed) {
        btn.className = 'text-[11px] font-extrabold px-3 py-1.5 rounded-full flex items-center gap-1.5 shrink-0 bg-slate-200 text-slate-500';
        label.innerText = 'Butuh Langganan';
        btn.innerHTML = '<i data-lucide="lock" class="w-3 h-3"></i><span id="attendance-required-toggle-label">Butuh Langganan</span>';
        if (note) note.classList.add('hidden');
        lucide.createIcons();
        return;
    }

    btn.className = 'text-[11px] font-extrabold px-3 py-1.5 rounded-full flex items-center gap-1.5 shrink-0 ' +
        (attendanceRequired ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600');
    btn.innerHTML = `<i data-lucide="circle" class="w-2.5 h-2.5 ${attendanceRequired ? 'text-emerald-500 fill-emerald-500' : 'text-red-500 fill-red-500'}"></i><span id="attendance-required-toggle-label">${attendanceRequired ? 'Aktif' : 'Tidak Aktif'}</span>`;
    if (note) {
        note.classList.toggle('hidden', attendanceRequired);
        note.innerHTML = 'Absen wajib sedang <b>dimatikan</b> — kasir bisa langsung pakai POS setelah login PIN tanpa perlu absen dulu.';
    }
    lucide.createIcons();
}

function toggleAttendanceRequired() {
    const next = !attendanceRequired;
    if (next && !isAdminSubscribed) {
        return alert('Fitur QR Absen butuh langganan aktif dulu.');
    }
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'attendanceSettings')), { required: next }, { merge: true }).then(() => {
        showToast(next ? 'Absen wajib diaktifkan.' : 'Absen wajib dimatikan — kasir bisa langsung pakai POS.', 'success');
    }).catch((err) => {
        console.error('Gagal mengubah pengaturan wajib absen:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

function getTodayDateStr(date) {
    const d = date || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMyTodayAttendance() {
    const empId = getCurrentKasirEmployeeId();
    const todayStr = getTodayDateStr();
    if (!empId) return { date: todayStr, masukTime: null, keluarTime: null };
    const record = attendanceLogCache.find(r => r.date === todayStr && r.employeeId === empId);
    return record || { date: todayStr, employeeId: empId, masukTime: null, keluarTime: null };
}

let mandatoryMasukGateActive = false;
let absenPopupMandatory = false;
let shiftEndedActive = false;
let adminPanelOpen = false;

function getTodayScheduleEntryForCurrentKasir() {
    const empId = getCurrentKasirEmployeeId();
    if (!empId) return null;
    const dayEntry = scheduleCache[getTodayDateStr()];
    if (!dayEntry || !dayEntry.employees) return null;
    const empEntry = dayEntry.employees.find(e => e.id === empId);
    if (!empEntry || empEntry.libur) return null;
    return empEntry;
}

function checkMandatoryMasukGate() {
    if (!attendanceSettingsLoaded || !attendanceLogLoaded) return;
    if (!attendanceRequired || !isAdminSubscribed) {
        if (shiftEndedActive) hideShiftEndedGate();
        if (mandatoryMasukGateActive) {
            mandatoryMasukGateActive = false;
            absenPopupMandatory = false;
            closeAbsenPopupForced();
        }
        recomputeDashboardLock();
        return;
    }
    const record = getMyTodayAttendance();
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
    if (shiftEndedActive) hideShiftEndedGate();
    const empId = getCurrentKasirEmployeeId();
    const needsMasuk = !!empId && !record.masukTime;
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

function showShiftEndedGate(record) {
    shiftEndedActive = true;
    if (adminPanelOpen) return;
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
    closeAbsenPopupForced();
    const employee = currentSessionEmployeeId ? { id: currentSessionEmployeeId, name: currentSessionEmployeeName } : null;
    saveAttendanceRecord('keluar', employee);
}

function recomputeDashboardLock() {
    setDashboardLocked(shiftEndedActive || mandatoryMasukGateActive);
}

function setDashboardLocked(locked) {
    ['page-home', 'bottom-bar'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('dashboard-locked', locked);
        if (locked) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
}

function saveAttendanceRecord(type, employee) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');
        return;
    }
    const employeeId = (employee && employee.id != null) ? employee.id : null;
    if (!employeeId) {
        showToast('Identitas kasir tidak diketahui — coba login PIN ulang.', 'warn');
        return;
    }

    const todayStr = getTodayDateStr();
    const now = new Date().toISOString();
    const { db, doc, setDoc } = window.FB;
    const docId = `${todayStr}_${employeeId}`;

    const field = type === 'masuk'
        ? { masukTime: now, masukBy: employee ? employee.name : null, masukById: employeeId }
        : { keluarTime: now, keluarBy: employee ? employee.name : null, keluarById: employeeId };

    setDoc(doc(db, ...adminPathSegments('attendance', docId)), { date: todayStr, employeeId, ...field }, { merge: true }).then(() => {
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

function openAbsenPopup(mandatory) {
    absenPopupMandatory = !!mandatory;
    if (mandatory && adminPanelOpen) return;
    renderAbsenPopup();
    const modal = document.getElementById('modal-absen-popup');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('absen-popup-close-btn').classList.toggle('hidden', absenPopupMandatory);
    lucide.createIcons();
}

function closeAbsenPopup() {
    if (absenPopupMandatory) {
        showToast('Wajib absen masuk dulu sebelum bisa mulai jualan.', 'warn');
        return;
    }
    closeAbsenPopupForced();
}

function closeAbsenPopupForced() {
    const modal = document.getElementById('modal-absen-popup');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function recordAttendanceManual(type) {
    if (type === 'keluar') {
        openConfirmKeluar();
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

function renderRiwayatAbsenEmployeeSelect() {
    const select = document.getElementById('riwayat-absen-employee-select');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('') || '<option value="">Belum ada karyawan</option>';
    if (Array.from(select.options).some(o => o.value === prevValue)) select.value = prevValue;
    renderRiwayatAbsen();
}

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
    const records = empId ? getRiwayatAbsenForEmployee(empId).slice(0, 7) : [];

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
    const monthVal = (monthInput && monthInput.value) ? monthInput.value : getTodayDateStr().slice(0, 7);
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
    }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function openSalesReport() {
    renderSalesReport();
    document.getElementById('modal-sales-report').classList.remove('hidden');
    lucide.createIcons();
}

function closeSalesReport() {
    document.getElementById('modal-sales-report').classList.add('hidden');
}

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

function askConfirmOrder() {
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
    const receiptID = now.toISOString().replace(/[-:T.]/g, '').slice(2, 14) + Math.floor(Math.random() * 90 + 10);

    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const paidAmount = selectedPayment === 'Cash'
        ? (parseInt((document.getElementById('cash-received-input') || {}).value, 10) || 0)
        : total;

    lastOrder = {
        id: receiptID,
        date: now.toLocaleString('id-ID'),
        timestamp: now.toISOString(),
        total,
        paidAmount,
        change: paidAmount - total,
        method: selectedPayment,
        items: JSON.parse(JSON.stringify(cart)),
        employeeId: currentSessionEmployeeId,
        employeeName: currentSessionEmployeeName
    };

    saveOrderToFirestore(lastOrder);
    decreaseStockForOrder(lastOrder.items, getCurrentKasirEmployeeId());
    updateConnectionUI();

    document.getElementById('modal-checkout').classList.add('hidden');
    document.getElementById('modal-success').classList.remove('hidden');
    renderReceiptPreview();
    playPaymentSuccessSound();
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
    launchSuccessConfetti();
    lucide.createIcons();
}

function renderReceiptPreview() {
    const el = document.getElementById('receipt-preview');
    if (!el || !lastOrder) return;

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

function playPaymentSuccessSound() {
    try {
        const audio = new Audio('https://www.image2url.com/r2/default/audio/1788174268372-6107ba19-18b9-4c0a-ba75-f1b35c5472db.mp3');
        audio.play().catch(err => console.warn('Gagal memutar suara pembayaran berhasil:', err));
    } catch (err) {
        console.warn('Gagal memutar suara pembayaran berhasil:', err);
    }
}

function saveOrderToFirestore(order) {
    if (!window.FB || !window.FB.ready) {
        showToast('Belum terhubung ke database, transaksi akan otomatis tersimpan begitu koneksi ke server aktif.', 'warn');
        return;
    }
    const { db, collection, addDoc } = window.FB;
    addDoc(collection(db, ...adminPathSegments('sales')), order).catch((err) => {
        console.error('Gagal menyimpan transaksi:', err);
        showToast('Gagal menyimpan transaksi ke server.', 'warn');
    });
}

function finishTransaction() {
    cart = [];
    lastOrder = null;
    updateCartUI();
    document.getElementById('modal-success').classList.add('hidden');
    const visibleCategories = getVisibleCategoriesForCurrentKasir();
    filterCategory(visibleCategories.includes('Makanan') ? 'Makanan' : (visibleCategories[0] || ''));
}

async function openLoginModal() {
    document.getElementById('modal-login').classList.remove('hidden');
    resetLoginModalFields();
    renderLoginTabs();
}
function closeLoginModal() { document.getElementById('modal-login').classList.add('hidden'); }

function resetLoginModalFields() {
    ['login-user', 'login-pass', 'register-user', 'register-store-name', 'register-phone', 'register-pass', 'register-pass-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

function renderLoginTabs() {
    document.getElementById('login-tabs').classList.remove('hidden');
    document.getElementById('login-tab-btn-daftar').classList.remove('hidden');
    document.getElementById('login-panel-loading').classList.add('hidden');
    switchLoginTab('masuk');
}

const DEVICE_REGISTER_LOCK_KEY = 'bd_device_registered_v1';

function isDeviceAlreadyRegistered() {
    try { return localStorage.getItem(DEVICE_REGISTER_LOCK_KEY) === '1'; } catch (err) { return false; }
}

function markDeviceAsRegistered() {
    try { localStorage.setItem(DEVICE_REGISTER_LOCK_KEY, '1'); } catch (err) { /* localStorage tidak tersedia, abaikan */ }
}

function switchLoginTab(tab) {
    const isDaftar = tab === 'daftar';
    document.getElementById('login-panel-masuk').classList.toggle('hidden', isDaftar);
    document.getElementById('login-panel-daftar').classList.toggle('hidden', !isDaftar);
    document.getElementById('login-tab-btn-masuk').classList.toggle('is-active', !isDaftar);
    document.getElementById('login-tab-btn-daftar').classList.toggle('is-active', isDaftar);
    document.getElementById('login-modal-title').innerText = isDaftar ? 'Daftar Admin' : 'Login Admin';
    document.getElementById('login-modal-subtitle').innerText = isDaftar
        ? 'Daftar akun admin baru untuk toko kamu sendiri'
        : 'Masukkan kredensial akses';

    if (isDaftar) {
        const locked = isDeviceAlreadyRegistered();
        document.getElementById('register-device-locked-note').classList.toggle('hidden', !locked);
        document.getElementById('register-form-fields').classList.toggle('hidden', locked);
        document.getElementById('register-submit-btn').classList.toggle('hidden', locked);
        lucide.createIcons();
    }
}

async function registerFirstAdmin() {
    if (isDeviceAlreadyRegistered()) {
        return alert('Perangkat ini sudah pernah dipakai untuk mendaftar 1 akun. Satu HP hanya boleh punya 1 akun. Silakan gunakan menu Masuk.');
    }
    const email = document.getElementById('register-user').value.trim();
    const storeName = document.getElementById('register-store-name').value.trim();
    const phone = document.getElementById('register-phone').value.trim();
    const pass = document.getElementById('register-pass').value;
    const passConfirm = document.getElementById('register-pass-confirm').value;

    if (!email || !storeName || !phone || !pass || !passConfirm) return alert('Isi semua kolom dulu!');
    if (pass.length < 6) return alert('Password minimal 6 karakter.');
    if (pass !== passConfirm) return alert('Konfirmasi password tidak sama.');
    if (!/^\d{8,}$/.test(phone.replace(/\D/g, ''))) return alert('Format No. HP tidak valid.');
    if (!window.FB || !window.FB.ready) return alert('Belum terhubung ke database. Coba lagi sebentar.');

    const btn = document.getElementById('register-submit-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Mendaftarkan...'; }

    try {
        const { db, doc, setDoc, createUserWithEmailAndPassword, auth, serverTimestamp } = window.FB;
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await setDoc(doc(db, 'admins', cred.user.uid), {
            email,
            createdAt: serverTimestamp()
        });
        await setDoc(doc(db, 'admins', cred.user.uid, 'config', 'storeProfile'), {
            name: storeName,
            phone,
            email: ''
        });
        switchActiveAdminAndResync(cred.user.uid);
        markDeviceAsRegistered();

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
        const cred = await signInWithEmailAndPassword(auth, email, pass);
        if (getActiveAdminId() !== cred.user.uid) {
            switchActiveAdminAndResync(cred.user.uid);
        }
        closeLoginModal();
        showPage('admin');
    } catch (err) {
        console.error('Login admin gagal:', err);
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
function toggleAdminAccordion(bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const toggleBtn = body.previousElementSibling;
    const chevron = toggleBtn ? toggleBtn.querySelector('.admin-accordion-chevron') : null;
    const isCurrentlyOpen = !body.classList.contains('hidden');

    body.classList.toggle('hidden', isCurrentlyOpen);
    if (chevron) chevron.classList.toggle('is-open', !isCurrentlyOpen);
}
function openAdminAccordion(bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const toggleBtn = body.previousElementSibling;
    const chevron = toggleBtn ? toggleBtn.querySelector('.admin-accordion-chevron') : null;
    body.classList.remove('hidden');
    if (chevron) chevron.classList.add('is-open');
}

function toggleAdminCategory(bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const toggleBtn = body.previousElementSibling;
    const chevron = toggleBtn ? toggleBtn.querySelector('.admin-category-chevron') : null;
    const isCurrentlyOpen = !body.classList.contains('hidden');

    body.classList.toggle('hidden', isCurrentlyOpen);
    if (chevron) chevron.classList.toggle('is-open', !isCurrentlyOpen);
}
function openAdminCategory(bodyId) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    const toggleBtn = body.previousElementSibling;
    const chevron = toggleBtn ? toggleBtn.querySelector('.admin-category-chevron') : null;
    body.classList.remove('hidden');
    if (chevron) chevron.classList.add('is-open');
}

function showPage(page) {
    document.getElementById('page-home').classList.toggle('hidden', page !== 'home');
    document.getElementById('bottom-bar').classList.toggle('hidden', page !== 'home');
    document.getElementById('page-admin').classList.toggle('hidden', page !== 'admin');

    const enteringAdmin = page === 'admin';
    adminPanelOpen = enteringAdmin;

    if (enteringAdmin) {
        forceHideKasirLockScreens();
        initAdminOnlyFirestoreSync();
        renderAdminTools();
        refreshAttendanceAdminViews();
        applySubscriptionGates();
        document.getElementById('admin-sidebar-store-name').innerText = STORE_NAME;
        openAdminSidebar();
    } else {
        closeAdminSidebar();
        restoreKasirLockScreensIfNeeded();
        signBackToAnonymousIfAdmin();
    }
    lucide.createIcons();
}

function toggleAdminMenuButton() {
    const inAdmin = !document.getElementById('page-admin').classList.contains('hidden');
    if (!inAdmin) {
        openLoginModal();
        return;
    }
    const sidebar = document.getElementById('admin-sidebar');
    if (sidebar.classList.contains('is-open')) {
        closeAdminSidebar();
    } else {
        openAdminSidebar();
    }
}

function applySubscriptionGates() {
    ['jadwal-kerja', 'riwayat-absen', 'penjualan-produk', 'cashrek', 'stock'].forEach((key) => {
        const lockEl = document.getElementById(`acc-${key}-lock`);
        const contentEl = document.getElementById(`acc-${key}-content`);
        if (!lockEl || !contentEl) return;
        lockEl.classList.toggle('hidden', isAdminSubscribed);
        contentEl.classList.toggle('hidden', !isAdminSubscribed);

        const body = document.getElementById(`acc-${key}`);
        const card = body ? body.closest('.admin-accordion-card') : null;
        if (!card) return;
        card.classList.toggle('is-locked', !isAdminSubscribed);
        const lockIcon = card.querySelector(`[data-feature-lock-icon="${key}"]`);
        const chevron = card.querySelector('.admin-accordion-chevron');
        if (lockIcon) lockIcon.classList.toggle('hidden', isAdminSubscribed);
        if (chevron) chevron.classList.toggle('hidden', !isAdminSubscribed);
    });
    applyPaymentSettingsToUI();
    renderAttendanceRequiredToggle();
    lucide.createIcons();
}

function handleLanggananSekarangClick() {
    alert('Fitur pembayaran langganan masih dalam pengembangan. Coming Soon!');
}

function openAdminSidebar() {
    document.getElementById('admin-sidebar-backdrop').classList.remove('hidden');
    document.getElementById('admin-sidebar').classList.add('is-open');
}
function closeAdminSidebar() {
    document.getElementById('admin-sidebar-backdrop').classList.add('hidden');
    document.getElementById('admin-sidebar').classList.remove('is-open');
}
function showAdminSection(sectionKey) {
    document.querySelectorAll('.admin-section').forEach((el) => {
        el.classList.toggle('hidden', el.dataset.adminSection !== sectionKey);
    });
    document.querySelectorAll('.admin-sidebar-nav-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.adminNav === sectionKey);
    });

    if (sectionKey === 'profile') {
        openAdminAccordion('acc-profile-toko');
    } else if (sectionKey === 'produk') {
        openAdminCategory('cat-produk');
    } else if (sectionKey === 'karyawan') {
        openAdminCategory('cat-karyawan');
    } else if (sectionKey === 'laporan') {
        openAdminCategory('cat-laporan');
    }

    closeAdminSidebar();
    lucide.createIcons();
}
function exitAdminPanel() {
    closeAdminSidebar();
    showPage('home');
}

function signBackToAnonymousIfAdmin() {
    if (!window.FB || !window.FB.auth) return;
    const user = window.FB.auth.currentUser;
    if (user && !user.isAnonymous) {
        window.FB.signOut(window.FB.auth)
            .then(() => window.FB.signInAnonymously(window.FB.auth))
            .catch((err) => console.error('Gagal kembali ke sesi anonim:', err));
    }
}

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

function restoreKasirLockScreensIfNeeded() {
    if (!pinLockResolved) {
        tryShowPinLock();
        return;
    }
    if (shiftEndedActive) {
        const gate = document.getElementById('shift-ended-gate');
        gate.classList.remove('hidden');
        gate.classList.add('flex');
        return;
    }
    if (mandatoryMasukGateActive) {
        openAbsenPopup(true);
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

async function printReceipt() {
    await ensureJsPDF();
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

    doc.setFontSize(13).setFont(undefined, 'bold');
    doc.text(STORE_NAME, pageWidth / 2, 10, { align: "center" });
    doc.setFontSize(7).setFont(undefined, 'normal');

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

    doc.setFontSize(10).setFont(undefined, 'bold');
    doc.text(`TOTAL`, marginX, y);
    doc.text(`Rp ${lastOrder.total.toLocaleString()}`, rightX, y, { align: "right" });
    y += 5;

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

    doc.setFontSize(7).setFont(undefined, 'normal');
    doc.text("Terima kasih telah berbelanja!", pageWidth / 2, y, { align: "center" });

    doc.save(`Struk-${lastOrder.id}.pdf`);
}

async function downloadPDF() {
    await ensureJsPDF();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const monthInput = document.getElementById('report-filter-month');
    const monthVal = (monthInput && monthInput.value) ? monthInput.value : getTodayDateStr().slice(0, 7);
    const monthLabel = new Date(`${monthVal}-01T00:00:00`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    const rows = getMonthlySalesRows();
    doc.text(`Total Penjualan BUKU DAGANG - ${monthLabel}`, 10, 10);
    const data = rows.map(r => {
        const dateObj = new Date(r.date + 'T00:00:00');
        const tglLabel = dateObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
        const avg = r.qty > 0 ? Math.round(r.total / r.qty) : 0;
        return [tglLabel, r.user, `Rp ${r.total.toLocaleString()}`, r.qty, `Rp ${avg.toLocaleString()}`];
    });
    const totalSales = rows.reduce((sum, r) => sum + r.total, 0);
    const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
    const totalAvg = totalQty > 0 ? Math.round(totalSales / totalQty) : 0;
    data.push(['TOTAL', '', `Rp ${totalSales.toLocaleString()}`, totalQty, `Rp ${totalAvg.toLocaleString()}`]);

    doc.autoTable({ head: [['Tgl/Bln/Thn', 'User', 'Sales', 'Qty', 'Avg']], body: data, startY: 18 });
    doc.save(`Total-Penjualan-${monthVal}.pdf`);
}

function initThemedFormControls() {
    document.querySelectorAll('select').forEach(themifySelect);
    document.querySelectorAll('input[type="month"]').forEach(themifyMonthInput);
    document.querySelectorAll('input[type="date"]').forEach(themifyDateInput);
    window.alert = (message) => showThemedAlert(String(message));
    lucide.createIcons();
}

function showThemedAlert(message) {
    document.getElementById('theme-alert-message').innerText = message;
    const modal = document.getElementById('theme-alert-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeThemedAlert() {
    const modal = document.getElementById('theme-alert-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

let themeConfirmCallback = null;

function showThemedConfirm(message, onConfirm) {
    document.getElementById('theme-confirm-message').innerText = message;
    themeConfirmCallback = onConfirm;
    const modal = document.getElementById('theme-confirm-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeThemedConfirm() {
    const modal = document.getElementById('theme-confirm-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    themeConfirmCallback = null;
}

function themeConfirmProceed() {
    const cb = themeConfirmCallback;
    closeThemedConfirm();
    if (cb) cb();
}

function themifyDateInput(input) {
    if (input.dataset.themified) return;
    input.dataset.themified = '1';
    input.classList.add('theme-select-hidden');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = input.className.replace('theme-select-hidden', '') + ' theme-select-trigger';
    trigger.innerHTML = '<span class="theme-select-label truncate">Pilih tanggal</span><i data-lucide="calendar" class="w-3.5 h-3.5 shrink-0"></i>';
    input.insertAdjacentElement('afterend', trigger);
    const label = trigger.querySelector('.theme-select-label');
    const syncLabel = () => {
        if (!input.value) { label.innerText = 'Pilih tanggal'; return; }
        const [y, m, d] = input.value.split('-').map(Number);
        label.innerText = new Date(y, m - 1, d).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    };
    trigger.addEventListener('click', () => openThemeDateSheet(input));
    input.addEventListener('change', syncLabel);
    syncLabel();
}

let themeDateSheetViewDate = null;
let themeDateSheetTargetInput = null;

function openThemeDateSheet(input) {
    themeDateSheetTargetInput = input;
    const base = input.value ? new Date(input.value + 'T00:00:00') : new Date();
    themeDateSheetViewDate = new Date(base.getFullYear(), base.getMonth(), 1);
    renderThemeDateSheet();
    const sheet = document.getElementById('theme-date-sheet');
    sheet.classList.remove('hidden');
    sheet.classList.add('flex');
}

function closeThemeDateSheet() {
    const sheet = document.getElementById('theme-date-sheet');
    sheet.classList.add('hidden');
    sheet.classList.remove('flex');
}

function changeThemeDateSheetMonth(dir) {
    themeDateSheetViewDate = new Date(themeDateSheetViewDate.getFullYear(), themeDateSheetViewDate.getMonth() + dir, 1);
    renderThemeDateSheet();
}

function renderThemeDateSheet() {
    const label = document.getElementById('theme-date-sheet-month-label');
    const grid = document.getElementById('theme-date-sheet-grid');
    const y = themeDateSheetViewDate.getFullYear();
    const m = themeDateSheetViewDate.getMonth();
    label.innerText = themeDateSheetViewDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    const firstDayIdx = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const selected = themeDateSheetTargetInput ? themeDateSheetTargetInput.value : null;
    const todayStr = getTodayDateStr();

    let cells = '';
    for (let i = 0; i < firstDayIdx; i++) cells += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isSelected = dateStr === selected;
        const isToday = dateStr === todayStr;
        cells += `<button type="button" onclick="chooseThemeDateSheetDay('${dateStr}')" class="theme-date-cell ${isSelected ? 'is-selected' : ''} ${isToday && !isSelected ? 'is-today' : ''}">${d}</button>`;
    }
    grid.innerHTML = cells;
}

function chooseThemeDateSheetDay(dateStr) {
    if (themeDateSheetTargetInput) {
        themeDateSheetTargetInput.value = dateStr;
        themeDateSheetTargetInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeThemeDateSheet();
}

function themifySelect(select) {
    if (select.dataset.themified) return;
    select.dataset.themified = '1';
    select.classList.add('theme-select-hidden');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = select.className.replace('theme-select-hidden', '') + ' theme-select-trigger';
    trigger.innerHTML = '<span class="theme-select-label truncate">Pilih</span><i data-lucide="chevron-down" class="w-3.5 h-3.5 shrink-0"></i>';
    select.insertAdjacentElement('afterend', trigger);
    const syncLabel = () => {
        const opt = select.options[select.selectedIndex];
        trigger.querySelector('.theme-select-label').innerText = opt ? opt.text : 'Pilih';
    };
    trigger.addEventListener('click', () => openThemeSelectSheet(select));
    select.addEventListener('change', syncLabel);
    new MutationObserver(syncLabel).observe(select, { childList: true, attributes: true });
    syncLabel();
}

function openThemeSelectSheet(select) {
    const options = Array.from(select.options);
    const sheet = document.getElementById('theme-select-sheet');
    const body = document.getElementById('theme-select-sheet-body');
    document.getElementById('theme-select-sheet-title').innerText = select.getAttribute('data-sheet-title') || 'Pilih';
    body.innerHTML = options.map(o => `
        <button type="button" onclick="chooseThemeSelectOption('${select.id}', '${String(o.value).replace(/'/g, "\\'")}')" class="theme-select-option ${o.value === select.value ? 'is-selected' : ''}">
            <span>${o.text}</span>
            ${o.value === select.value ? '<i data-lucide="check" class="w-4 h-4"></i>' : ''}
        </button>`).join('') || '<p class="text-xs text-slate-400 text-center py-6">Tidak ada pilihan</p>';
    sheet.classList.remove('hidden');
    sheet.classList.add('flex');
    lucide.createIcons();
}

function chooseThemeSelectOption(selectId, value) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    closeThemeSelectSheet();
}

function closeThemeSelectSheet() {
    const sheet = document.getElementById('theme-select-sheet');
    sheet.classList.add('hidden');
    sheet.classList.remove('flex');
}

function themifyMonthInput(input) {
    if (input.dataset.themified) return;
    input.dataset.themified = '1';
    if (!input.value) {
        const now = new Date();
        input.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    input.classList.add('theme-select-hidden');
    const wrap = document.createElement('div');
    wrap.className = input.className.replace('theme-select-hidden', '') + ' theme-month-switcher flex items-center gap-2';
    wrap.innerHTML = '<button type="button" class="theme-month-btn" data-dir="-1"><i data-lucide="chevron-left" class="w-3.5 h-3.5"></i></button><span class="theme-month-label flex-1 text-center truncate"></span><button type="button" class="theme-month-btn" data-dir="1"><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i></button>';
    input.insertAdjacentElement('afterend', wrap);
    const label = wrap.querySelector('.theme-month-label');
    const syncLabel = () => {
        const [y, m] = input.value.split('-').map(Number);
        label.innerText = new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    };
    wrap.querySelectorAll('.theme-month-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const dir = parseInt(btn.getAttribute('data-dir'));
            const [y, m] = input.value.split('-').map(Number);
            const d = new Date(y, m - 1 + dir, 1);
            input.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            syncLabel();
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });
    syncLabel();
}

function renderStockEmployeeSelect() {
    const select = document.getElementById('stock-employee-select');
    if (!select) return;
    const prevValue = select.value;
    select.innerHTML = employeesCache.map(e => `<option value="${e.id}">${e.name}</option>`).join('') || '<option value="">Belum ada karyawan</option>';
    if (employeesCache.some(e => e.id === prevValue)) select.value = prevValue;
    select.dispatchEvent(new Event('change'));
    renderStockPerEmployeeTable();
}

function renderStockPerEmployeeTable() {
    const body = document.getElementById('stock-per-employee-body');
    const emptyMsg = document.getElementById('stock-per-employee-empty');
    const table = document.getElementById('stock-per-employee-table');
    if (!body) return;
    document.getElementById('stock-save-success').classList.add('hidden');
    const select = document.getElementById('stock-employee-select');
    const empId = select ? select.value : '';

    if (employeesCache.length === 0) {
        table.classList.add('hidden');
        emptyMsg.innerText = 'Tambahkan karyawan dulu di menu Karyawan.';
        emptyMsg.classList.remove('hidden');
        return;
    }
    if (!empId) {
        table.classList.add('hidden');
        emptyMsg.innerText = 'Pilih karyawan dulu.';
        emptyMsg.classList.remove('hidden');
        return;
    }
    const assigned = employeeCatalogCache[empId] || [];
    if (assigned.length === 0) {
        table.classList.add('hidden');
        emptyMsg.innerText = 'Karyawan ini belum punya item di "Katalog Per Karyawan". Atur dulu di menu itu.';
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');
    table.classList.remove('hidden');
    body.innerHTML = assigned.map((a, idx) => {
        const product = products.find(p => p.id === a.productId);
        const name = product ? product.name : `(Produk #${a.productId} sudah dihapus)`;
        return `<tr class="border-b border-slate-100 last:border-0">
            <td class="py-2.5 px-2 text-center text-xs text-slate-400 font-semibold">${idx + 1}</td>
            <td class="py-2.5 px-2 text-sm font-bold text-slate-800">${name}</td>
            <td class="py-2.5 px-2 text-right"><input type="number" min="0" data-stock-product="${a.productId}" value="${a.qty ?? ''}" placeholder="∞" class="w-20 p-2 text-center border border-blue-200 rounded-lg outline-none text-sm font-bold bg-blue-50/40"></td>
        </tr>`;
    }).join('');
}

function saveStockPerEmployee() {
    const select = document.getElementById('stock-employee-select');
    const empId = select ? select.value : '';
    if (!empId) return alert('Pilih karyawan dulu!');
    if (!window.FB || !window.FB.ready) return showToast('Belum terhubung ke database. Coba lagi sebentar.', 'warn');

    const existing = employeeCatalogCache[empId] || [];
    const updated = existing.map((item) => {
        const input = document.querySelector(`[data-stock-product="${item.productId}"]`);
        if (!input) return item;
        const raw = input.value;
        const qty = raw === '' ? null : Math.max(0, parseInt(raw) || 0);
        return { ...item, qty };
    });

    const { db, doc, setDoc } = window.FB;
    setDoc(doc(db, ...adminPathSegments('config', 'employeeCatalog')), { [empId]: updated }, { merge: true }).then(() => {
        const banner = document.getElementById('stock-save-success');
        banner.classList.remove('hidden');
        setTimeout(() => banner.classList.add('hidden'), 2500);
    }).catch((err) => {
        console.error('Gagal simpan stock per karyawan:', err);
        showToast('Gagal menyimpan ke server.', 'warn');
    });
}

init();
