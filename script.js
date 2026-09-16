/* =========================================================
   1. KONFIGURASI FIREBASE
========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyDVeIIU55tsW18eAFIP5uWzpKGtC20RUh8",
  authDomain: "sert-pondoksepangindah2.firebaseapp.com",
  projectId: "sert-pondoksepangindah2",
  storageBucket: "sert-pondoksepangindah2.firebasestorage.app",
  messagingSenderId: "239962454498",
  appId: "1:239962454498:web:169713ef331f4a1e8aa1bb",
  measurementId: "G-TQT03Z6NLY"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
const cloudFunctions = firebase.functions();

/* =========================================================
   2. DAFTAR RT / BLOK & FUNGSI BANTU UMUM
========================================================= */
const DAFTAR_RT = ['001','002','003','004','005','006','007','008','009','010'];
const DAFTAR_BLOK = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const NAMA_BULAN_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

function isiOpsiRT(selectEl, includeSemua){
  if(!selectEl) return;
  selectEl.innerHTML = '';
  if(includeSemua){
    const opt = document.createElement('option');
    opt.value = 'semua';
    opt.textContent = 'Semua RT';
    selectEl.appendChild(opt);
  }
  DAFTAR_RT.forEach(rt => {
    const opt = document.createElement('option');
    opt.value = rt;
    opt.textContent = 'RT ' + rt;
    selectEl.appendChild(opt);
  });
}
function isiOpsiBlok(selectEl){
  if(!selectEl) return;
  selectEl.innerHTML = '';
  DAFTAR_BLOK.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    selectEl.appendChild(opt);
  });
}

function formatRupiah(angka){
  return 'Rp ' + Number(angka || 0).toLocaleString('id-ID');
}
function labelTanggalDate(d){
  return d.getDate() + ' ' + NAMA_BULAN_ID[d.getMonth()] + ' ' + d.getFullYear();
}
function labelTanggalHariIni(){
  return labelTanggalDate(new Date());
}
function periodeBulanIni(){
  const d = new Date();
  return NAMA_BULAN_ID[d.getMonth()] + ' ' + d.getFullYear();
}
function nomorWhatsApp(nomor){
  let n = (nomor || '').replace(/\D/g, '');
  if(n.startsWith('0')) n = '62' + n.slice(1);
  else if(!n.startsWith('62')) n = '62' + n;
  return n;
}
function renderQRProfil(uid){
  const el = document.getElementById('profile-qr-code');
  if(!el || typeof QRCode === 'undefined') return;
  el.innerHTML = '';
  new QRCode(el, {
    text: 'SERT-WARGA:' + uid,
    width: 42,
    height: 42,
    correctLevel: QRCode.CorrectLevel.M
  });
}
function urutkanBerdasarkanTanggal(docs, field){
  return docs.slice().sort((a, b) => {
    const ta = a.data()[field], tb = b.data()[field];
    const ma = (ta && typeof ta.toMillis === 'function') ? ta.toMillis() : 0;
    const mb = (tb && typeof tb.toMillis === 'function') ? tb.toMillis() : 0;
    return mb - ma;
  });
}
function tampilkanErrorMuat(elId, err){
  console.error(err);
  const el = document.getElementById(elId);
  if(el) el.innerHTML = '<p class="empty-state">Gagal memuat data. Periksa aturan keamanan Firestore atau koneksi internet.</p>';
}
function tampilkanErrorSimpan(elId, err){
  console.error(err);
  const el = document.getElementById(elId);
  if(el) el.textContent = 'Gagal menyimpan. Periksa aturan keamanan Firestore Anda.';
}

/* ---- Modal kustom bertema aplikasi (pengganti alert/confirm bawaan browser) ---- */
function tampilkanAlert(pesan, sukses){
  return new Promise(resolve => {
    const overlay = document.getElementById('app-modal-overlay');
    const icon = document.getElementById('app-modal-icon');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const okBtn = document.getElementById('app-modal-ok');
    document.getElementById('app-modal-message').textContent = pesan;
    icon.className = 'app-modal-icon' + (sukses ? ' app-modal-icon-green' : '');
    icon.innerHTML = ICONS[sukses ? 'check' : 'info'] || '';
    cancelBtn.hidden = true;
    overlay.hidden = false;
    const selesai = () => {
      overlay.hidden = true;
      okBtn.removeEventListener('click', selesai);
      resolve();
    };
    okBtn.addEventListener('click', selesai);
  });
}

function tampilkanKonfirmasi(pesan){
  return new Promise(resolve => {
    const overlay = document.getElementById('app-modal-overlay');
    const icon = document.getElementById('app-modal-icon');
    const cancelBtn = document.getElementById('app-modal-cancel');
    const okBtn = document.getElementById('app-modal-ok');
    document.getElementById('app-modal-message').textContent = pesan;
    icon.className = 'app-modal-icon';
    icon.innerHTML = ICONS.info || '';
    cancelBtn.hidden = false;
    overlay.hidden = false;
    const selesai = (hasil) => {
      overlay.hidden = true;
      okBtn.removeEventListener('click', okHandler);
      cancelBtn.removeEventListener('click', cancelHandler);
      resolve(hasil);
    };
    const okHandler = () => selesai(true);
    const cancelHandler = () => selesai(false);
    okBtn.addEventListener('click', okHandler);
    cancelBtn.addEventListener('click', cancelHandler);
  });
}

/* =========================================================
   3. ICON SET SEDERHANA (inline SVG, tanpa dependency luar)
========================================================= */
const ICONS = {
  home: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
  logout: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  receipt: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 3h16v18l-3-2-3 2-3-2-3 2-3-2-1 2z"/><path d="M8 8h8M8 12h8"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>',
  file: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  video: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-4v12l-6-4"/></svg>',
  phone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2z"/></svg>',
  wallet: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/><path d="M18 12h.01"/><path d="M2 9h18a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4"/></svg>',
  report: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>',
  user: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  menu: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  users: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5"/><circle cx="17.5" cy="9" r="2.6"/><path d="M15.5 14.3c2.7.4 4.5 2.2 4.5 5"/></svg>',
  message: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/></svg>',
  idbadge: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M6 16c0-1.7 1.3-3 3-3s3 1.3 3 3"/><path d="M14 9h4M14 13h4"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
};
function renderIkonBaru(){
  document.querySelectorAll('[data-icon]').forEach(el => { if(!el.innerHTML) el.innerHTML = ICONS[el.getAttribute('data-icon')] || ''; });
}
renderIkonBaru();

/* =========================================================
   4. NAVIGASI ANTAR HALAMAN
========================================================= */
function showView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if(el) el.classList.add('active');
}

document.querySelectorAll('.menu-tile').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.getAttribute('data-view');
    showView(view);
    loadDataFor(view);
  });
});

document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.getAttribute('data-back') || 'dashboard'));
});

function loadDataFor(view){
  if(view === 'tagihan') loadTagihan();
  if(view === 'informasi') loadInformasi();
  if(view === 'surat') loadSurat();
  if(view === 'lapor') loadLapor();
  if(view === 'cctv') loadCctv();
  if(view === 'kontak') loadKontak();
  if(view === 'kas') loadKas();
  if(view === 'pengeluaran') loadPengeluaran();
  if(view === 'profil') bukaProfil();
  if(view === 'sa-tagihan') loadSaTagihan();
  if(view === 'sa-warga-rt') loadSaWargaRT();
  if(view === 'sa-informasi') loadSaInformasi();
  if(view === 'sa-informasi-rt') loadSaInformasiRT();
  if(view === 'sa-pengeluaran') loadSaPengeluaran();
  if(view === 'sa-kontak') loadSaKontak();
  if(view === 'rt-warga-saya') loadRtWargaSaya();
  if(view === 'rt-informasi') loadRtInformasi();
  if(view === 'rt-surat') loadRtSurat();
  if(view === 'rt-lapor') loadRtLapor();
  if(view === 'rt-cctv') loadRtCctv();
  if(view === 'rt-kontak') loadRtKontak();
  if(view === 'rt-kas') loadRtKas();
  if(view === 'rt-pusat') loadRtPusat();
}

/* =========================================================
   5. FORM PENDAFTARAN: isi opsi Blok & RT
========================================================= */
isiOpsiBlok(document.getElementById('register-blok'));
isiOpsiRT(document.getElementById('register-rt'), false);

/* =========================================================
   6. AUTENTIKASI
========================================================= */
document.getElementById('btn-login').addEventListener('click', () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  if(!email || !password){
    errorEl.textContent = 'Isi email dan kata sandi terlebih dahulu.';
    return;
  }
  auth.signInWithEmailAndPassword(email, password)
    .catch(err => errorEl.textContent = terjemahkanErrorAuth(err));
});

document.getElementById('btn-register').addEventListener('click', () => {
  const nama = document.getElementById('register-nama').value.trim();
  const blok = document.getElementById('register-blok').value;
  const noRumah = document.getElementById('register-no').value.trim();
  const rt = document.getElementById('register-rt').value;
  const rw = document.getElementById('register-rw').value.trim() || '001';
  const hp = document.getElementById('register-hp').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const errorEl = document.getElementById('register-error');
  errorEl.textContent = '';
  if(!nama || !noRumah || !hp || !email || password.length < 6){
    errorEl.textContent = 'Semua kolom wajib diisi dan kata sandi minimal 6 karakter.';
    return;
  }
  auth.createUserWithEmailAndPassword(email, password)
    .then(cred => {
      return db.collection('warga').doc(cred.user.uid).set({
        nama, blok, noRumah, rt, rw, hp,
        contactEmail: '',
        role: 'warga'
      });
    })
    .catch(err => errorEl.textContent = terjemahkanErrorAuth(err));
});

document.getElementById('btn-logout').addEventListener('click', () => auth.signOut());
document.getElementById('btn-logout-superadmin').addEventListener('click', () => auth.signOut());
document.getElementById('btn-logout-adminrt').addEventListener('click', () => auth.signOut());

document.getElementById('link-to-register').addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('login-error').textContent = '';
  showView('register');
});
document.getElementById('link-to-login').addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('register-error').textContent = '';
  showView('login');
});

function terjemahkanErrorAuth(err){
  const map = {
    'auth/user-not-found': 'Akun tidak ditemukan.',
    'auth/wrong-password': 'Kata sandi salah.',
    'auth/email-already-in-use': 'Email sudah terdaftar.',
    'auth/invalid-email': 'Format email tidak valid.'
  };
  return map[err.code] || 'Terjadi kesalahan, coba lagi.';
}

let currentProfileData = {};
let currentRole = 'warga';

/* ---- Splash screen: tampil minimal 4 detik sebelum pindah ke view lain ---- */
let splashSelesai = false;
let splashPendingView = null;
let splashPendingAksi = null;

function tampilkanSetelahSplash(viewName, aksi){
  splashPendingView = viewName;
  splashPendingAksi = aksi || null;
  if(splashSelesai) terapkanViewSetelahSplash();
}
function terapkanViewSetelahSplash(){
  if(splashPendingView){
    showView(splashPendingView);
    if(splashPendingAksi) splashPendingAksi();
    splashPendingView = null;
    splashPendingAksi = null;
  }
}
setTimeout(() => {
  splashSelesai = true;
  terapkanViewSetelahSplash();
}, 3000);

auth.onAuthStateChanged(user => {
  if(user){
    db.collection('warga').doc(user.uid).get().then(doc => {
      const data = doc.exists ? doc.data() : { nama: 'Warga', blok: '-', rt: '-', rw: '-', role: 'warga' };
      currentProfileData = data;
      currentRole = data.role || 'warga';
      if(currentRole === 'super_admin'){
        tampilkanSetelahSplash('superadmin-dashboard');
      } else if(currentRole === 'admin_rt'){
        document.getElementById('adminrt-header-label').textContent = 'Dashboard Admin RT ' + (data.rt || '');
        tampilkanSetelahSplash('adminrt-dashboard', () => {
          loadAdminRTBadges();
          loadBannerInformasiRT();
        });
      } else {
        tampilkanSetelahSplash('dashboard', () => {
          renderProfileHeader(data);
          loadBannerInformasi();
          loadInformasiBadge();
          loadTagihanBadge();
          cekPopupTagihanBelumLunas();
        });
      }
    }).catch(err => {
      console.error(err);
      tampilkanAlert('Gagal memuat data profil. Periksa aturan keamanan Firestore Anda.');
    });
  } else {
    tampilkanSetelahSplash('login');
  }
});

/* =========================================================
   7. PROFIL (dipakai bersama oleh warga, admin RT, dan super admin)
========================================================= */
function renderProfileHeader(data){
  document.getElementById('profile-name').textContent = data.nama || 'Warga';
  document.getElementById('profile-blok').textContent = 'Blok ' + (data.blok || '-') + ' No.' + (data.noRumah || '-');
  document.getElementById('profile-rt').textContent = 'RT ' + (data.rt || '-');
  document.getElementById('profile-rw').textContent = 'RW ' + (data.rw || '-');
  const initials = (data.nama || 'W A').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('profile-avatar').textContent = initials;
  renderQRProfil(auth.currentUser.uid);
}

function bukaProfil(){
  const titleEl = document.getElementById('profil-title');
  const backBtn = document.getElementById('profil-back-btn');
  if(currentRole === 'super_admin'){
    titleEl.textContent = 'Profil Super admin';
    backBtn.setAttribute('data-back', 'superadmin-dashboard');
  } else if(currentRole === 'admin_rt'){
    titleEl.textContent = 'Profil RT';
    backBtn.setAttribute('data-back', 'adminrt-dashboard');
  } else {
    titleEl.textContent = 'Profil';
    backBtn.setAttribute('data-back', 'dashboard');
  }
  loadProfilWarga();
}

document.getElementById('btn-open-profil').addEventListener('click', () => {
  showView('profil');
  bukaProfil();
});

function loadProfilWarga(){
  const data = currentProfileData || {};
  document.getElementById('pw-nama').value = data.nama || '';
  document.getElementById('pw-blok').value = data.blok || '';
  document.getElementById('pw-no').value = data.noRumah || '';
  document.getElementById('pw-rt').value = data.rt || '';
  document.getElementById('pw-rw').value = data.rw || '';
  document.getElementById('pw-hp').value = data.hp || '';
  document.getElementById('pw-email').value = data.contactEmail || auth.currentUser.email || '';
}

document.getElementById('form-profil-warga').addEventListener('submit', e => {
  e.preventDefault();
  const nama = document.getElementById('pw-nama').value.trim();
  const errorEl = document.getElementById('profil-warga-error');
  if(!nama){
    errorEl.textContent = 'Nama wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  const payload = {
    nama,
    blok: document.getElementById('pw-blok').value.trim(),
    noRumah: document.getElementById('pw-no').value.trim(),
    hp: document.getElementById('pw-hp').value.trim(),
    contactEmail: document.getElementById('pw-email').value.trim()
  };
  db.collection('warga').doc(auth.currentUser.uid).set(payload, { merge: true }).then(() => {
    currentProfileData = Object.assign({}, currentProfileData, payload);
    if(currentRole === 'warga') renderProfileHeader(currentProfileData);
    const successEl = document.getElementById('profil-warga-success');
    successEl.textContent = 'Berhasil tersimpan!';
    setTimeout(() => { successEl.textContent = ''; }, 2500);
  }).catch(err => tampilkanErrorSimpan('profil-warga-error', err));
});

/* =========================================================
   8. BANNER INFORMASI WARGA (carousel otomatis)
========================================================= */
let bannerInterval = null;
let bannerIndex = 0;

function periodeInformasiAktif(d){
  if(!d.tayangMulai && !d.tayangSampai) return true;
  const hariIni = new Date();
  hariIni.setHours(0, 0, 0, 0);
  if(d.tayangMulai){
    const mulai = new Date(d.tayangMulai);
    mulai.setHours(0, 0, 0, 0);
    if(hariIni < mulai) return false;
  }
  if(d.tayangSampai){
    const sampai = new Date(d.tayangSampai);
    sampai.setHours(23, 59, 59, 999);
    if(hariIni > sampai) return false;
  }
  return true;
}

function informasiRelevanUntukSaya(d){
  if(!periodeInformasiAktif(d)) return false;
  if(d.tujuan === 'rt') return d.rtTarget === currentProfileData.rt;
  return true;
}

function loadBannerInformasi(){
  renderBannerCarousel('banner-wrap', 'banner-track');
}
function loadBannerInformasiRT(){
  renderBannerCarousel('banner-wrap-rt', 'banner-track-rt');
}

function renderBannerCarousel(wrapId, trackId){
  db.collection('informasi').orderBy('tanggal', 'desc').limit(50).get().then(snap => {
    const relevanBerfoto = snap.docs.map(d => d.data()).filter(d => d.gambarUrl && informasiRelevanUntukSaya(d));

    // Batasi maksimal 1 slide aktif per admin_rt (dan 1 untuk super admin), supaya adil untuk semua RT
    const sudahAdaSumber = new Set();
    const dataBerfoto = [];
    relevanBerfoto.forEach(d => {
      const sumber = d.dariRole === 'admin_rt' ? ('rt-' + d.dariRT) : 'pusat';
      if(sudahAdaSumber.has(sumber)) return;
      if(dataBerfoto.length >= 5) return;
      sudahAdaSumber.add(sumber);
      dataBerfoto.push(d);
    });

    const wrap = document.getElementById(wrapId);
    const track = document.getElementById(trackId);
    if(!wrap || !track) return;
    clearInterval(bannerInterval);
    bannerIndex = 0;
    wrap.hidden = false;
    if(dataBerfoto.length === 0){
      track.innerHTML = '<div class="banner-slide banner-slide-empty"><p class="empty-state" style="padding:0;">Belum ada informasi/iklan dari RT.</p></div>';
      track.style.transform = 'translateX(0%)';
      return;
    }
    track.innerHTML = dataBerfoto.map(d => `
      <div class="banner-slide">
        <img class="banner-photo" src="${d.gambarUrl}" alt="${d.judul}" />
        <p class="banner-caption">${d.judul}</p>
      </div>`).join('');
    track.style.transform = 'translateX(0%)';
    if(dataBerfoto.length > 1){
      bannerInterval = setInterval(() => {
        bannerIndex = (bannerIndex + 1) % dataBerfoto.length;
        track.style.transform = `translateX(-${bannerIndex * 100}%)`;
      }, 5000);
    }
  }).catch(err => console.error(err));
}

/* =========================================================
   9. TAGIHAN BULANAN (warga)
========================================================= */
function loadTagihan(){
  const uid = auth.currentUser.uid;
  db.collection('tagihan').where('uid', '==', uid).get()
    .then(snap => {
      const riwayatEl = document.getElementById('tagihan-riwayat');
      riwayatEl.innerHTML = '';
      if(snap.empty){
        riwayatEl.innerHTML = '<p class="empty-state">Belum ada data tagihan.</p>';
        tagihanTerpilihDoc = null;
        tampilkanTagihanTerpilih({ total: 0, jatuhTempo: '-', rincian: [] });
        return;
      }
      const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada');
      tagihanTerpilihDoc = docs.find(d => d.data().status !== 'Lunas') || docs[0];
      tampilkanTagihanTerpilih(tagihanTerpilihDoc.data());
      docs.forEach(d => {
        const t = d.data();
        const bisaPilih = t.status !== 'Lunas';
        riwayatEl.innerHTML += `
          <div class="list-item">
            <div><p class="title">${t.periode}</p><p class="subtitle">${formatRupiah(t.total)}</p></div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="pill ${t.status === 'Lunas' ? 'pill-green' : 'pill-red'}">${t.status}</span>
              ${bisaPilih ? `<button class="chip-btn chip-btn-blue" data-pilih-tagihan="${d.id}">Pilih</button>` : ''}
            </div>
          </div>`;
      });
      document.querySelectorAll('[data-pilih-tagihan]').forEach(btn => {
        btn.addEventListener('click', () => {
          const dipilih = docs.find(x => x.id === btn.getAttribute('data-pilih-tagihan'));
          if(dipilih){
            tagihanTerpilihDoc = dipilih;
            tampilkanTagihanTerpilih(dipilih.data());
            document.querySelector('#view-tagihan .app-shell').scrollIntoView({ behavior: 'smooth' });
          }
        });
      });
    })
    .catch(err => tampilkanErrorMuat('tagihan-riwayat', err));
  loadRiwayatPembayaran();
  loadTagihanBadge();
}

function loadTagihanBadge(){
  db.collection('tagihan').where('uid', '==', auth.currentUser.uid).get().then(snap => {
    const belumLunas = snap.docs.filter(d => d.data().status !== 'Lunas').length;
    setBadge('badge-tagihan', belumLunas);
  }).catch(err => console.error(err));
}

/* =========================================================
   9a. POPUP TAGIHAN MELAYANG (muncul sekali saat login jika ada tagihan belum lunas)
========================================================= */
function cekPopupTagihanBelumLunas(){
  db.collection('tagihan').where('uid', '==', auth.currentUser.uid).get().then(snap => {
    const belumLunas = snap.docs.map(d => d.data()).filter(t => t.status !== 'Lunas');
    if(belumLunas.length === 0) return;
    const total = belumLunas.reduce((sum, t) => sum + Number(t.total || 0), 0);
    tampilkanPopupTagihan(total, belumLunas.length);
  }).catch(err => console.error(err));
}

function tampilkanPopupTagihan(total, jumlahTagihan){
  const overlay = document.getElementById('popup-tagihan-overlay');
  const corner = document.getElementById('popup-tagihan-corner');
  document.getElementById('popup-tagihan-total').textContent = formatRupiah(total);
  document.getElementById('popup-tagihan-sub').textContent = jumlahTagihan + ' tagihan menunggu pembayaran';
  corner.textContent = '5';
  corner.classList.remove('ptl-close');
  overlay.hidden = false;

  let sisa = 5;
  const timer = setInterval(() => {
    sisa -= 1;
    if(sisa > 0){
      corner.textContent = sisa;
    } else {
      clearInterval(timer);
      corner.textContent = '\u2715';
      corner.classList.add('ptl-close');
      corner.addEventListener('click', () => { overlay.hidden = true; }, { once: true });
    }
  }, 1000);
}

document.getElementById('btn-popup-bayar-sekarang').addEventListener('click', () => {
  document.getElementById('popup-tagihan-overlay').hidden = true;
  showView('tagihan');
  loadDataFor('tagihan');
});

function tampilkanTagihanTerpilih(t){
  document.getElementById('tagihan-total').textContent = formatRupiah(t.total);
  document.getElementById('tagihan-jatuhtempo').textContent = 'Jatuh tempo ' + (t.jatuhTempo || '-');
  const detailEl = document.getElementById('tagihan-detail');
  detailEl.innerHTML = '';
  (t.rincian || []).forEach(item => {
    detailEl.innerHTML += `<div class="detail-row"><span>${item.nama}</span><span>${formatRupiah(item.jumlah)}</span></div>`;
  });
}

/* =========================================================
   9a. BAYAR TAGIHAN VIA XENDIT (Model A: tanpa saldo tersimpan)
========================================================= */
let currentPembayaranId = null;
let tagihanTerpilihDoc = null;

document.getElementById('btn-bayar-tagihan').addEventListener('click', bukaBayarTagihan);

function bukaBayarTagihan(){
  const errorEl = document.getElementById('bayar-error');
  errorEl.textContent = '';
  currentPembayaranId = null;
  document.getElementById('bayar-pilihan-box').hidden = false;
  document.getElementById('struk-box').hidden = true;
  const linkInvoice = document.getElementById('link-buka-invoice');
  linkInvoice.setAttribute('href', '#');
  linkInvoice.classList.add('btn-disabled');
  showView('tagihan-bayar');

  if(!tagihanTerpilihDoc){
    errorEl.textContent = 'Tidak ada tagihan yang perlu dibayar.';
    document.getElementById('bayar-nominal').textContent = formatRupiah(0);
    return;
  }
  if(tagihanTerpilihDoc.data().status === 'Lunas'){
    errorEl.textContent = 'Tagihan yang dipilih sudah lunas.';
    document.getElementById('bayar-nominal').textContent = formatRupiah(tagihanTerpilihDoc.data().total);
    return;
  }

  document.getElementById('bayar-nominal').textContent = formatRupiah(tagihanTerpilihDoc.data().total);

  const buatInvoice = cloudFunctions.httpsCallable('buatTagihanXendit');
  buatInvoice({ tagihanId: tagihanTerpilihDoc.id }).then(result => {
    const data = result.data || {};
    currentPembayaranId = data.pembayaranId;
    if(data.invoiceUrl){
      linkInvoice.setAttribute('href', data.invoiceUrl);
      linkInvoice.classList.remove('btn-disabled');
    }
  }).catch(err => {
    console.error(err);
    errorEl.textContent = 'Pembayaran online belum tersedia. Cloud Function/Xendit belum aktif — hubungi admin.';
  });
}

document.getElementById('btn-cek-status-bayar').addEventListener('click', () => {
  const errorEl = document.getElementById('bayar-error');
  if(!currentPembayaranId){
    errorEl.textContent = 'Belum ada pembayaran yang dibuat. Coba buka ulang halaman ini.';
    return;
  }
  errorEl.textContent = 'Memeriksa status...';
  db.collection('pembayaran').doc(currentPembayaranId).get().then(doc => {
    if(!doc.exists){
      errorEl.textContent = 'Data pembayaran tidak ditemukan.';
      return;
    }
    const d = doc.data();
    if(d.status === 'Berhasil'){
      errorEl.textContent = '';
      tampilkanStrukPembayaran(d);
    } else if(d.status === 'Gagal'){
      errorEl.textContent = 'Pembayaran gagal. Silakan ulangi lewat tombol "Buka halaman pembayaran".';
    } else {
      errorEl.textContent = 'Pembayaran masih menunggu konfirmasi. Coba cek lagi sebentar setelah membayar.';
    }
  }).catch(err => tampilkanErrorSimpan('bayar-error', err));
});

function tampilkanStrukPembayaran(d){
  document.getElementById('bayar-pilihan-box').hidden = true;
  const strukBox = document.getElementById('struk-box');
  strukBox.hidden = false;
  const statusBox = document.getElementById('status-box');
  statusBox.className = 'status-box ' + (d.status === 'Berhasil' ? 'status-box-green' : 'status-box-red');
  document.getElementById('status-text').textContent = 'Status: ' + d.status;
  const tgl = (d.tanggal && typeof d.tanggal.toDate === 'function') ? d.tanggal.toDate() : new Date();
  document.getElementById('struk-detail').innerHTML = `
    <div class="struk-row"><span>Tanggal</span><span>${labelTanggalDate(tgl)}</span></div>
    <div class="struk-row"><span>Jenis pembayaran</span><span>Tagihan bulanan</span></div>
    <div class="struk-row"><span>Metode</span><span>${d.metode || '-'}</span></div>
    <div class="struk-row"><span>Nominal</span><span>${formatRupiah(d.nominal)}</span></div>
    <div class="struk-row"><span>Status</span><span class="pill-sm ${d.status === 'Berhasil' ? 'pill-sm-green' : 'pill-sm-red'}">${d.status}</span></div>
  `;
}

/* =========================================================
   9b. RIWAYAT PEMBAYARAN (filter tanggal, maksimal 30 hari)
========================================================= */
function loadRiwayatPembayaran(){
  const dariInput = document.getElementById('riwayat-dari');
  const sampaiInput = document.getElementById('riwayat-sampai');
  if(!dariInput.value || !sampaiInput.value){
    const hariIni = new Date();
    const tujuhHariLalu = new Date();
    tujuhHariLalu.setDate(hariIni.getDate() - 6);
    dariInput.value = tujuhHariLalu.toISOString().slice(0, 10);
    sampaiInput.value = hariIni.toISOString().slice(0, 10);
  }
  terapkanFilterRiwayatPembayaran();
}

function terapkanFilterRiwayatPembayaran(){
  const errorEl = document.getElementById('riwayat-pembayaran-error');
  const body = document.getElementById('riwayat-pembayaran-body');
  const dariVal = document.getElementById('riwayat-dari').value;
  const sampaiVal = document.getElementById('riwayat-sampai').value;
  if(!dariVal || !sampaiVal){
    errorEl.textContent = 'Isi kedua tanggal terlebih dahulu.';
    return;
  }
  const dari = new Date(dariVal);
  const sampai = new Date(sampaiVal);
  sampai.setHours(23, 59, 59, 999);
  if(dari > sampai){
    errorEl.textContent = 'Tanggal "Dari" tidak boleh setelah "Sampai".';
    return;
  }
  const selisihHari = Math.round((sampai - dari) / 86400000);
  if(selisihHari > 30){
    errorEl.textContent = 'Rentang filter maksimal 30 hari.';
    return;
  }
  errorEl.textContent = '';
  db.collection('pembayaran').where('uid', '==', auth.currentUser.uid).get().then(snap => {
    body.innerHTML = '';
    const docsFiltered = snap.docs.filter(doc => {
      const t = doc.data().tanggal;
      if(!t || typeof t.toDate !== 'function') return false;
      const tgl = t.toDate();
      return tgl >= dari && tgl <= sampai;
    });
    if(docsFiltered.length === 0){
      body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:16px;">Tidak ada riwayat pada rentang ini.</td></tr>';
      return;
    }
    urutkanBerdasarkanTanggal(docsFiltered, 'tanggal').forEach(doc => {
      const d = doc.data();
      const tgl = d.tanggal.toDate();
      const pillClass = d.status === 'Berhasil' ? 'pill-sm-green' : (d.status === 'Pending' ? 'pill-sm-amber' : 'pill-sm-red');
      body.innerHTML += `<tr><td>${labelTanggalDate(tgl)}</td><td>${formatRupiah(d.nominal)}</td><td><span class="pill-sm ${pillClass}">${d.status}</span></td></tr>`;
    });
  }).catch(err => {
    console.error(err);
    body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:16px;">Gagal memuat riwayat.</td></tr>';
  });
}

document.getElementById('btn-terapkan-filter').addEventListener('click', terapkanFilterRiwayatPembayaran);

/* =========================================================
   10. INFORMASI (warga)
========================================================= */
function loadInformasi(){
  db.collection('informasi').orderBy('tanggal', 'desc').get().then(snap => {
    const el = document.getElementById('informasi-list');
    el.innerHTML = '';
    const relevan = snap.docs.map(d => d.data()).filter(informasiRelevanUntukSaya);
    if(relevan.length === 0){
      el.innerHTML = '<p class="empty-state">Belum ada informasi.</p>';
    } else {
      relevan.forEach(d => {
        el.innerHTML += `
          <div class="list-item" style="flex-direction:column;align-items:flex-start;">
            <span class="pill pill-green">${d.kategori || 'Info'}</span>
            <p class="title" style="margin-top:8px;">${d.judul}</p>
            <p class="subtitle">${d.isi}</p>
          </div>`;
      });
    }
  }).catch(err => tampilkanErrorMuat('informasi-list', err));

  // Tandai sudah dibaca supaya badge notifikasi hilang
  const waktuBaca = firebase.firestore.FieldValue.serverTimestamp();
  db.collection('warga').doc(auth.currentUser.uid).set({ terakhirBacaInformasi: waktuBaca }, { merge: true })
    .then(() => { currentProfileData.terakhirBacaInformasi = { toMillis: () => Date.now() }; })
    .catch(err => console.error(err));
  setBadge('badge-informasi', 0);
}

function loadInformasiBadge(){
  const terakhirBaca = currentProfileData.terakhirBacaInformasi;
  const batasWaktu = (terakhirBaca && typeof terakhirBaca.toMillis === 'function') ? terakhirBaca.toMillis() : 0;
  db.collection('informasi').orderBy('tanggal', 'desc').limit(100).get().then(snap => {
    const belumDibaca = snap.docs.filter(doc => {
      const d = doc.data();
      if(!informasiRelevanUntukSaya(d)) return false;
      const waktu = (d.tanggal && typeof d.tanggal.toMillis === 'function') ? d.tanggal.toMillis() : 0;
      return waktu > batasWaktu;
    });
    setBadge('badge-informasi', belumDibaca.length);
  }).catch(err => console.error(err));
}

/* =========================================================
   11. BUAT SURAT (warga)
========================================================= */
document.getElementById('form-surat').addEventListener('submit', e => {
  e.preventDefault();
  const jenis = document.getElementById('surat-jenis').value;
  const keperluan = document.getElementById('surat-keperluan').value.trim();
  const errorEl = document.getElementById('surat-error');
  if(!keperluan){
    errorEl.textContent = 'Isi keperluan surat terlebih dahulu.';
    return;
  }
  errorEl.textContent = '';
  db.collection('surat').add({
    uid: auth.currentUser.uid,
    namaWarga: currentProfileData.nama || 'Warga',
    rt: currentProfileData.rt || '',
    jenis, keperluan,
    status: 'Diajukan',
    dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => {
    document.getElementById('surat-keperluan').value = '';
    loadSurat();
  }).catch(err => tampilkanErrorSimpan('surat-error', err));
});

function loadSurat(){
  const uid = auth.currentUser.uid;
  db.collection('surat').where('uid', '==', uid).get().then(snap => {
    const el = document.getElementById('surat-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada pengajuan surat.</p>';
      return;
    }
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada');
    docs.forEach(doc => {
      const d = doc.data();
      const pillClass = d.status === 'Disetujui' ? 'pill-green' : 'pill-red';
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.jenis}</p><p class="subtitle">${d.keperluan}</p></div>
          <span class="pill ${pillClass}">${d.status}</span>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('surat-list', err));
}

/* =========================================================
   12. LAPOR (warga)
========================================================= */
document.getElementById('form-lapor').addEventListener('submit', e => {
  e.preventDefault();
  const kategori = document.getElementById('lapor-kategori').value;
  const lokasi = document.getElementById('lapor-lokasi').value.trim();
  const deskripsi = document.getElementById('lapor-deskripsi').value.trim();
  const errorEl = document.getElementById('lapor-error');
  if(!lokasi || !deskripsi){
    errorEl.textContent = 'Lokasi dan deskripsi wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  db.collection('laporan').add({
    uid: auth.currentUser.uid,
    namaWarga: currentProfileData.nama || 'Warga',
    rt: currentProfileData.rt || '',
    kategori, lokasi, deskripsi,
    status: 'Diterima',
    dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => {
    document.getElementById('lapor-lokasi').value = '';
    document.getElementById('lapor-deskripsi').value = '';
    loadLapor();
  }).catch(err => tampilkanErrorSimpan('lapor-error', err));
});

function loadLapor(){
  const uid = auth.currentUser.uid;
  db.collection('laporan').where('uid', '==', uid).get().then(snap => {
    const el = document.getElementById('lapor-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada laporan yang dikirim.</p>';
      return;
    }
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada');
    docs.forEach(doc => {
      const d = doc.data();
      const pillClass = d.status === 'Selesai' ? 'pill-green' : 'pill-red';
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.kategori} &middot; ${d.lokasi}</p><p class="subtitle">${d.deskripsi}</p></div>
          <span class="pill ${pillClass}">${d.status}</span>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('lapor-list', err));
}

/* =========================================================
   13. CCTV (warga, baca saja - global)
========================================================= */
function loadCctv(){
  db.collection('cctv').get().then(snap => {
    const el = document.getElementById('cctv-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada data CCTV.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div class="left-row">
            <span class="icon-circle icon-circle-blue">${ICONS.video}</span>
            <p class="title">${d.lokasi}</p>
          </div>
          <a href="${d.link}" target="_blank" rel="noopener" class="pill pill-green" style="text-decoration:none;">Buka</a>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('cctv-list', err));
}

/* =========================================================
   14. KONTAK DARURAT (warga, baca saja - global, langsung ke WhatsApp)
========================================================= */
function loadKontak(){
  db.collection('kontakDarurat').get().then(snap => {
    const el = document.getElementById('kontak-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada kontak darurat.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.nama}</p><p class="subtitle">${d.nomor}</p></div>
          <a href="https://wa.me/${nomorWhatsApp(d.nomor)}" target="_blank" rel="noopener" class="btn-hubungi">${ICONS.phone} Hubungi</a>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('kontak-list', err));
}

/* =========================================================
   15. KAS WARGA (baca saja, per-RT)
========================================================= */
function renderDaftarKas(elId, docs){
  const el = document.getElementById(elId);
  el.innerHTML = '';
  let saldo = 0;
  if(docs.length === 0){
    el.innerHTML = '<p class="empty-state">Belum ada transaksi.</p>';
  }
  docs.forEach(doc => {
    const d = doc.data();
    saldo += d.jumlah;
    const tgl = (d.tanggal && typeof d.tanggal.toDate === 'function') ? labelTanggalDate(d.tanggal.toDate()) : (d.tanggalLabel || '');
    el.innerHTML += `
      <div class="list-item">
        <div><p class="title">${d.keterangan}</p><p class="subtitle">${tgl}</p></div>
        <span class="${d.jumlah >= 0 ? 'amount-green' : 'amount-red'}">${d.jumlah >= 0 ? '+' : '-'}${formatRupiah(Math.abs(d.jumlah))}</span>
      </div>`;
  });
  return saldo;
}

function loadKas(){
  db.collection('kas').where('kategori', '==', 'umum').get().then(snap => {
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'tanggal');
    const saldo = renderDaftarKas('kaswarga-list', docs);
    document.getElementById('kaswarga-saldo').textContent = formatRupiah(saldo);
  }).catch(err => tampilkanErrorMuat('kaswarga-list', err));

  const rt = currentProfileData.rt;
  db.collection('kas').where('kategori', '==', 'perRT').where('rt', '==', rt).get().then(snap => {
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'tanggal');
    const saldo = renderDaftarKas('iuranrt-list', docs);
    document.getElementById('iuranrt-saldo').textContent = formatRupiah(saldo);
  }).catch(err => tampilkanErrorMuat('iuranrt-list', err));
}

/* =========================================================
   16. RINCIAN PENGELUARAN (baca saja, terpisah Kas Warga & Iuran Per-RT)
========================================================= */
function renderDaftarPengeluaran(elId, docs){
  const el = document.getElementById(elId);
  el.innerHTML = '';
  let total = 0;
  if(docs.length === 0){
    el.innerHTML = '<p class="empty-state">Belum ada data pengeluaran.</p>';
  }
  docs.forEach(doc => {
    const d = doc.data();
    total += d.jumlah;
    const tgl = (d.tanggal && typeof d.tanggal.toDate === 'function') ? labelTanggalDate(d.tanggal.toDate()) : (d.tanggalLabel || '');
    el.innerHTML += `
      <div class="list-item">
        <div><p class="title">${d.keterangan}</p><p class="subtitle">${tgl}</p></div>
        <span class="title">${formatRupiah(d.jumlah)}</span>
      </div>`;
  });
  return total;
}

function loadPengeluaran(){
  db.collection('pengeluaran').where('kategori', '==', 'umum').get().then(snap => {
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'tanggal');
    const total = renderDaftarPengeluaran('pengeluaran-kaswarga-list', docs);
    document.getElementById('pengeluaran-kaswarga-total').textContent = formatRupiah(total);
  }).catch(err => tampilkanErrorMuat('pengeluaran-kaswarga-list', err));

  const rt = currentProfileData.rt;
  db.collection('pengeluaran').where('kategori', '==', 'perRT').where('rt', '==', rt).get().then(snap => {
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'tanggal');
    const total = renderDaftarPengeluaran('pengeluaran-iuranrt-list', docs);
    document.getElementById('pengeluaran-iuranrt-total').textContent = formatRupiah(total);
  }).catch(err => tampilkanErrorMuat('pengeluaran-iuranrt-list', err));
}

/* =========================================================
   17. PWA: DAFTARKAN SERVICE WORKER
========================================================= */
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* =========================================================
   18. PWA: TOMBOL INSTAL DI HALAMAN DAFTAR
========================================================= */
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btn-install-app');
  if(btn) btn.hidden = false;
});

const btnInstallApp = document.getElementById('btn-install-app');
if(btnInstallApp){
  btnInstallApp.addEventListener('click', async () => {
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    btnInstallApp.hidden = true;
  });
}

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if(btnInstallApp) btnInstallApp.hidden = true;
});

/* =========================================================
   19. FUNGSI UPLOAD FOTO INFORMASI (dipakai super admin & admin RT)
========================================================= */
function unggahFotoInformasi(file, onDone, onError, progressElId){
  const progressEl = document.getElementById(progressElId);
  if(progressEl) progressEl.textContent = 'Mengunggah foto...';
  const ref = storage.ref('informasi/' + Date.now() + '_' + file.name);
  ref.put(file)
    .then(snapshot => snapshot.ref.getDownloadURL())
    .then(url => {
      if(progressEl) progressEl.textContent = '';
      onDone(url);
    })
    .catch(err => {
      if(progressEl) progressEl.textContent = '';
      onError(err);
    });
}

/* =========================================================
   20. SUPER ADMIN: KELOLA TAGIHAN
========================================================= */
isiOpsiRT(document.getElementById('atr-rt'), false);

function loadSaTagihan(){
  db.collection('pengaturan').doc('tagihan').get().then(doc => {
    document.getElementById('at-tanggal').value = doc.exists ? (doc.data().tanggalPenagihan || 10) : 10;
  }).catch(err => console.error(err));
  db.collection('jenisTagihan').get().then(snap => {
    const el = document.getElementById('at-jenis-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada jenis tagihan. Tambahkan lewat form di bawah.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.nama}</p><p class="subtitle">${formatRupiah(d.jumlah)} / bulan</p></div>
          <i data-icon="trash" data-del-jenis="${doc.id}" style="cursor:pointer;color:var(--text-muted);"></i>
        </div>`;
    });
    renderIkonBaru();
    document.querySelectorAll('[data-del-jenis]').forEach(icon => {
      icon.addEventListener('click', () => {
        db.collection('jenisTagihan').doc(icon.getAttribute('data-del-jenis')).delete().then(loadSaTagihan).catch(err => tampilkanAlert('Gagal menghapus: ' + err.message));
      });
    });
  }).catch(err => tampilkanErrorMuat('at-jenis-list', err));
  loadAtrRiwayat();
}

document.getElementById('at-simpan-tanggal').addEventListener('click', () => {
  const tanggal = Number(document.getElementById('at-tanggal').value);
  if(!tanggal || tanggal < 1 || tanggal > 28) return;
  db.collection('pengaturan').doc('tagihan').set({ tanggalPenagihan: tanggal }, { merge: true })
    .then(() => tampilkanAlert('Tanggal penagihan tersimpan.', true))
    .catch(err => tampilkanAlert('Gagal menyimpan: ' + err.message));
});

document.getElementById('form-jenis-tagihan').addEventListener('submit', e => {
  e.preventDefault();
  const nama = document.getElementById('at-nama').value.trim();
  const jumlah = Number(document.getElementById('at-jumlah').value);
  const errorEl = document.getElementById('at-error');
  if(!nama || !jumlah){
    errorEl.textContent = 'Nama dan jumlah wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  db.collection('jenisTagihan').add({ nama, jumlah }).then(() => {
    document.getElementById('at-nama').value = '';
    document.getElementById('at-jumlah').value = '';
    loadSaTagihan();
  }).catch(err => tampilkanErrorSimpan('at-error', err));
});

document.getElementById('at-generate').addEventListener('click', async () => {
  const ok = await tampilkanKonfirmasi('Buat tagihan bulan ini untuk semua warga di semua RT berdasarkan jenis tagihan yang ada?');
  if(!ok) return;
  Promise.all([
    db.collection('jenisTagihan').get(),
    db.collection('pengaturan').doc('tagihan').get(),
    db.collection('warga').where('role', '==', 'warga').get()
  ]).then(([jenisSnap, tanggalDoc, wargaSnap]) => {
    const rincian = jenisSnap.docs.map(d => ({ nama: d.data().nama, jumlah: d.data().jumlah }));
    const total = rincian.reduce((sum, r) => sum + Number(r.jumlah), 0);
    const tanggal = tanggalDoc.exists ? (tanggalDoc.data().tanggalPenagihan || 10) : 10;
    const periode = periodeBulanIni();
    const batch = db.batch();
    wargaSnap.forEach(wDoc => {
      const ref = db.collection('tagihan').doc();
      batch.set(ref, {
        uid: wDoc.id,
        rt: wDoc.data().rt || '',
        kategori: 'umum',
        periode,
        total,
        status: 'Belum lunas',
        jatuhTempo: 'Tanggal ' + tanggal,
        rincian,
        dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    return batch.commit();
  }).then(() => tampilkanAlert('Tagihan bulan ini berhasil dibuat untuk semua warga.', true))
    .catch(err => tampilkanAlert('Gagal membuat tagihan: ' + err.message));
});

document.getElementById('form-tagihan-per-rt').addEventListener('submit', async e => {
  e.preventDefault();
  const rt = document.getElementById('atr-rt').value;
  const nama = document.getElementById('atr-nama').value.trim();
  const jumlah = Number(document.getElementById('atr-jumlah').value);
  const errorEl = document.getElementById('atr-error');
  if(!nama || !jumlah){
    errorEl.textContent = 'Nama iuran dan jumlah wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  const ok = await tampilkanKonfirmasi(`Buat tagihan "${nama}" sebesar ${formatRupiah(jumlah)} untuk semua warga RT ${rt}?`);
  if(!ok) return;
  Promise.all([
    db.collection('pengaturan').doc('tagihan').get(),
    db.collection('warga').where('role', '==', 'warga').where('rt', '==', rt).get()
  ]).then(([tanggalDoc, wargaSnap]) => {
    if(wargaSnap.empty){
      errorEl.textContent = 'Belum ada warga terdaftar di RT ini.';
      return;
    }
    const tanggal = tanggalDoc.exists ? (tanggalDoc.data().tanggalPenagihan || 10) : 10;
    const periode = periodeBulanIni();
    const batch = db.batch();
    wargaSnap.forEach(wDoc => {
      const ref = db.collection('tagihan').doc();
      batch.set(ref, {
        uid: wDoc.id,
        rt,
        kategori: 'perRT',
        periode,
        total: jumlah,
        status: 'Belum lunas',
        jatuhTempo: 'Tanggal ' + tanggal,
        rincian: [{ nama, jumlah }],
        dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    batch.set(db.collection('riwayatTagihanRT').doc(), {
      rt, nama, jumlah,
      jumlahWarga: wargaSnap.size,
      dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
    });
    return batch.commit();
  }).then(() => {
    if(!errorEl.textContent){
      tampilkanAlert('Tagihan per-RT berhasil dibuat untuk RT ' + rt + '.', true);
      document.getElementById('atr-nama').value = '';
      document.getElementById('atr-jumlah').value = '';
      loadAtrRiwayat();
    }
  }).catch(err => tampilkanErrorSimpan('atr-error', err));
});

function loadAtrRiwayat(){
  db.collection('riwayatTagihanRT').get().then(snap => {
    const el = document.getElementById('atr-riwayat');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada riwayat pembuatan tagihan per-RT.</p>';
      return;
    }
    urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada').forEach(doc => {
      const d = doc.data();
      const tgl = (d.dibuatPada && typeof d.dibuatPada.toDate === 'function') ? labelTanggalDate(d.dibuatPada.toDate()) : '';
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">RT ${d.rt} &middot; ${d.nama}</p><p class="subtitle">${formatRupiah(d.jumlah)} &times; ${d.jumlahWarga} warga &middot; ${tgl}</p></div>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('atr-riwayat', err));
}

/* =========================================================
   21. SUPER ADMIN: WARGA PER-RT
========================================================= */
isiOpsiRT(document.getElementById('swr-rt'), false);
document.getElementById('swr-rt').addEventListener('change', loadSaWargaRT);

function loadSaWargaRT(){
  const rt = document.getElementById('swr-rt').value;
  document.getElementById('swr-rt-label').textContent = 'RT ' + rt;
  db.collection('warga').where('role', '==', 'warga').where('rt', '==', rt).get().then(snap => {
    const el = document.getElementById('swr-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada warga terdaftar di RT ini.</p>';
      return;
    }
    let no = 1;
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${no}. ${d.nama}</p><p class="subtitle">Blok ${d.blok || '-'} No.${d.noRumah || '-'} &middot; ${d.hp || '-'}</p></div>
          <a href="https://wa.me/${nomorWhatsApp(d.hp)}" target="_blank" rel="noopener" class="icon-circle icon-circle-green" style="text-decoration:none;">${ICONS.phone}</a>
        </div>`;
      no++;
    });
  }).catch(err => tampilkanErrorMuat('swr-list', err));
}

/* =========================================================
   22. SUPER ADMIN: INFORMASI WARGA (broadcast)
========================================================= */
isiOpsiRT(document.getElementById('sai-rt'), false);

document.getElementById('sai-tujuan').addEventListener('change', () => {
  document.getElementById('sai-rt-wrap').hidden = document.getElementById('sai-tujuan').value !== 'rt';
});

function loadSaInformasi(){
  db.collection('informasi').orderBy('tanggal', 'desc').get().then(snap => {
    const el = document.getElementById('sai-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada informasi yang dipublikasikan.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      const tujuanLabel = d.tujuan === 'rt' ? ('RT ' + d.rtTarget) : 'Semua warga';
      el.innerHTML += `
        <div class="list-item">
          <div class="left-row">
            ${d.gambarUrl ? `<img src="${d.gambarUrl}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover;flex-shrink:0;" />` : ''}
            <div><p class="title">${d.judul}</p><p class="subtitle">${d.kategori || 'Info'} &middot; ${tujuanLabel}</p></div>
          </div>
          <i data-icon="trash" data-del-sai="${doc.id}" style="cursor:pointer;color:var(--text-muted);"></i>
        </div>`;
    });
    renderIkonBaru();
    document.querySelectorAll('[data-del-sai]').forEach(icon => {
      icon.addEventListener('click', () => {
        db.collection('informasi').doc(icon.getAttribute('data-del-sai')).delete().then(loadSaInformasi).catch(err => tampilkanAlert('Gagal menghapus: ' + err.message));
      });
    });
  }).catch(err => tampilkanErrorMuat('sai-list', err));
}

document.getElementById('form-sa-informasi').addEventListener('submit', e => {
  e.preventDefault();
  const judul = document.getElementById('sai-judul').value.trim();
  const isi = document.getElementById('sai-isi').value.trim();
  const kategori = document.getElementById('sai-kategori').value;
  const tujuan = document.getElementById('sai-tujuan').value;
  const rtTarget = tujuan === 'rt' ? document.getElementById('sai-rt').value : null;
  const tayangMulai = document.getElementById('sai-tayang-mulai').value || null;
  const tayangSampai = document.getElementById('sai-tayang-sampai').value || null;
  const fileInput = document.getElementById('sai-foto');
  const file = fileInput.files[0];
  const errorEl = document.getElementById('sai-error');
  if(!judul || !isi){
    errorEl.textContent = 'Judul dan isi wajib diisi.';
    return;
  }
  if(tayangMulai && tayangSampai && tayangMulai > tayangSampai){
    errorEl.textContent = 'Tanggal "Tayang mulai" tidak boleh setelah "Tayang sampai".';
    return;
  }
  errorEl.textContent = '';

  const simpan = (gambarUrl) => {
    db.collection('informasi').add({
      judul, isi, kategori, tujuan, rtTarget,
      dariRole: 'super_admin',
      tayangMulai, tayangSampai,
      gambarUrl: gambarUrl || null,
      tanggal: firebase.firestore.FieldValue.serverTimestamp()
    }).then(() => {
      document.getElementById('sai-judul').value = '';
      document.getElementById('sai-isi').value = '';
      document.getElementById('sai-tayang-mulai').value = '';
      document.getElementById('sai-tayang-sampai').value = '';
      fileInput.value = '';
      loadSaInformasi();
    }).catch(err => tampilkanErrorSimpan('sai-error', err));
  };

  if(file){
    unggahFotoInformasi(file, simpan, err => tampilkanErrorSimpan('sai-error', err), 'sai-foto-progress');
  } else {
    simpan(null);
  }
});

/* =========================================================
   23. SUPER ADMIN: INFORMASI RT (kanal permintaan per-RT)
========================================================= */
isiOpsiRT(document.getElementById('sar-rt'), false);
document.getElementById('sar-rt').addEventListener('change', loadSaInformasiRT);

function loadSaInformasiRT(){
  const rt = document.getElementById('sar-rt').value;
  db.collection('permintaanRT').where('rt', '==', rt).get().then(snap => {
    const el = document.getElementById('sar-riwayat');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada riwayat pesan dengan RT ini.</p>';
      return;
    }
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada');
    docs.forEach(doc => {
      const d = doc.data();
      const dariLabel = d.dariRole === 'super_admin' ? 'Pusat' : ('RT ' + d.rt);
      el.innerHTML += `
        <div class="list-item" style="flex-direction:column;align-items:stretch;">
          <p class="title">${dariLabel}</p>
          <p class="subtitle">${d.pesan}</p>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('sar-riwayat', err));
}

document.getElementById('form-sa-permintaan').addEventListener('submit', e => {
  e.preventDefault();
  const rt = document.getElementById('sar-rt').value;
  const pesan = document.getElementById('sar-pesan').value.trim();
  const errorEl = document.getElementById('sar-error');
  if(!pesan){
    errorEl.textContent = 'Pesan tidak boleh kosong.';
    return;
  }
  errorEl.textContent = '';
  db.collection('permintaanRT').add({
    rt, pesan,
    dariRole: 'super_admin',
    dariNama: currentProfileData.nama || 'Super admin',
    dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => {
    document.getElementById('sar-pesan').value = '';
    loadSaInformasiRT();
  }).catch(err => tampilkanErrorSimpan('sar-error', err));
});

/* =========================================================
   23a. SUPER ADMIN: PENGELUARAN TAGIHAN (Kas Warga & Iuran Per-RT)
========================================================= */
isiOpsiRT(document.getElementById('pir-rt'), false);

function loadSaPengeluaran(){
  db.collection('pengeluaran').where('kategori', '==', 'umum').get().then(snap => {
    const el = document.getElementById('pkw-riwayat');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada pengeluaran Kas Warga.</p>';
      return;
    }
    urutkanBerdasarkanTanggal(snap.docs, 'tanggal').forEach(doc => {
      const d = doc.data();
      const tgl = (d.tanggal && typeof d.tanggal.toDate === 'function') ? labelTanggalDate(d.tanggal.toDate()) : '';
      el.innerHTML += `<div class="list-item"><div><p class="title">${d.keterangan}</p><p class="subtitle">${tgl}</p></div><span class="amount-red">-${formatRupiah(d.jumlah)}</span></div>`;
    });
  }).catch(err => tampilkanErrorMuat('pkw-riwayat', err));

  db.collection('pengeluaran').where('kategori', '==', 'perRT').get().then(snap => {
    const el = document.getElementById('pir-riwayat');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada pengeluaran Iuran Per-RT.</p>';
      return;
    }
    urutkanBerdasarkanTanggal(snap.docs, 'tanggal').forEach(doc => {
      const d = doc.data();
      const tgl = (d.tanggal && typeof d.tanggal.toDate === 'function') ? labelTanggalDate(d.tanggal.toDate()) : '';
      el.innerHTML += `<div class="list-item"><div><p class="title">RT ${d.rt} &middot; ${d.keterangan}</p><p class="subtitle">${tgl}</p></div><span class="amount-red">-${formatRupiah(d.jumlah)}</span></div>`;
    });
  }).catch(err => tampilkanErrorMuat('pir-riwayat', err));
}

document.getElementById('form-pengeluaran-kaswarga').addEventListener('submit', async e => {
  e.preventDefault();
  const nominal = Number(document.getElementById('pkw-nominal').value);
  const pesan = document.getElementById('pkw-pesan').value.trim();
  const errorEl = document.getElementById('pkw-error');
  if(!nominal || !pesan){
    errorEl.textContent = 'Nominal dan keterangan wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  const ok = await tampilkanKonfirmasi(`Catat pengeluaran Kas Warga sebesar ${formatRupiah(nominal)} untuk "${pesan}"?`);
  if(!ok) return;
  const tanggalLabel = labelTanggalHariIni();
  const batch = db.batch();
  batch.set(db.collection('kas').doc(), {
    keterangan: pesan, jumlah: -Math.abs(nominal), kategori: 'umum',
    tanggal: firebase.firestore.FieldValue.serverTimestamp(), tanggalLabel
  });
  batch.set(db.collection('pengeluaran').doc(), {
    keterangan: pesan, jumlah: Math.abs(nominal), kategori: 'umum',
    tanggal: firebase.firestore.FieldValue.serverTimestamp(), tanggalLabel
  });
  batch.commit().then(() => {
    document.getElementById('pkw-nominal').value = '';
    document.getElementById('pkw-pesan').value = '';
    tampilkanAlert('Pengeluaran Kas Warga berhasil dicatat.', true);
    loadSaPengeluaran();
  }).catch(err => tampilkanErrorSimpan('pkw-error', err));
});

document.getElementById('form-pengeluaran-iuranrt').addEventListener('submit', async e => {
  e.preventDefault();
  const rt = document.getElementById('pir-rt').value;
  const nominal = Number(document.getElementById('pir-nominal').value);
  const pesan = document.getElementById('pir-pesan').value.trim();
  const errorEl = document.getElementById('pir-error');
  if(!nominal || !pesan){
    errorEl.textContent = 'Nominal dan keterangan wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  const ok = await tampilkanKonfirmasi(`Catat pengeluaran Iuran Per-RT sebesar ${formatRupiah(nominal)} untuk RT ${rt} - "${pesan}"?`);
  if(!ok) return;
  const tanggalLabel = labelTanggalHariIni();
  const batch = db.batch();
  batch.set(db.collection('kas').doc(), {
    keterangan: pesan, jumlah: -Math.abs(nominal), kategori: 'perRT', rt,
    tanggal: firebase.firestore.FieldValue.serverTimestamp(), tanggalLabel
  });
  batch.set(db.collection('pengeluaran').doc(), {
    keterangan: pesan, jumlah: Math.abs(nominal), kategori: 'perRT', rt,
    tanggal: firebase.firestore.FieldValue.serverTimestamp(), tanggalLabel
  });
  batch.commit().then(() => {
    document.getElementById('pir-nominal').value = '';
    document.getElementById('pir-pesan').value = '';
    tampilkanAlert('Pengeluaran Iuran Per-RT berhasil dicatat.', true);
    loadSaPengeluaran();
  }).catch(err => tampilkanErrorSimpan('pir-error', err));
});

/* =========================================================
   23b. SUPER ADMIN: KONTAK DARURAT (global, dikelola bersama)
========================================================= */
function loadSaKontak(){
  db.collection('kontakDarurat').get().then(snap => {
    const el = document.getElementById('sak-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada kontak darurat.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.nama}</p><p class="subtitle">${d.nomor}</p></div>
          <i data-icon="trash" data-del-kontak-sa="${doc.id}" style="cursor:pointer;color:var(--text-muted);"></i>
        </div>`;
    });
    renderIkonBaru();
    document.querySelectorAll('[data-del-kontak-sa]').forEach(icon => {
      icon.addEventListener('click', () => {
        db.collection('kontakDarurat').doc(icon.getAttribute('data-del-kontak-sa')).delete().then(loadSaKontak).catch(err => tampilkanAlert('Gagal menghapus: ' + err.message));
      });
    });
  }).catch(err => tampilkanErrorMuat('sak-list', err));
}

document.getElementById('form-sa-kontak').addEventListener('submit', e => {
  e.preventDefault();
  const nama = document.getElementById('sak-nama').value.trim();
  const nomor = document.getElementById('sak-nomor').value.trim();
  const errorEl = document.getElementById('sak-error');
  if(!nama || !nomor){
    errorEl.textContent = 'Nama dan no. HP wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  db.collection('kontakDarurat').add({ nama, nomor, darurat: true }).then(() => {
    document.getElementById('sak-nama').value = '';
    document.getElementById('sak-nomor').value = '';
    loadSaKontak();
  }).catch(err => tampilkanErrorSimpan('sak-error', err));
});

/* =========================================================
   24. ADMIN RT: BADGE NOTIFIKASI
========================================================= */
function loadAdminRTBadges(){
  const rt = currentProfileData.rt;
  db.collection('surat').where('status', '==', 'Diajukan').where('rt', '==', rt).get().then(snap => {
    setBadge('badge-rt-surat', snap.size);
  }).catch(err => console.error(err));
  db.collection('laporan').where('status', '==', 'Diterima').where('rt', '==', rt).get().then(snap => {
    setBadge('badge-rt-lapor', snap.size);
  }).catch(err => console.error(err));
}
function setBadge(id, count){
  const el = document.getElementById(id);
  if(!el) return;
  if(count > 0){
    el.textContent = count > 99 ? '99+' : count;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* =========================================================
   25. ADMIN RT: WARGA SAYA
========================================================= */
function loadRtWargaSaya(){
  const rt = currentProfileData.rt;
  document.getElementById('rt-warga-title').textContent = 'Warga saya RT ' + rt;
  db.collection('warga').where('role', '==', 'warga').where('rt', '==', rt).get().then(snap => {
    const el = document.getElementById('rws-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada warga terdaftar di RT ini.</p>';
      return;
    }
    let no = 1;
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${no}. ${d.nama}</p><p class="subtitle">Blok ${d.blok || '-'} No.${d.noRumah || '-'} &middot; ${d.hp || '-'}</p></div>
          <a href="https://wa.me/${nomorWhatsApp(d.hp)}" target="_blank" rel="noopener" class="icon-circle icon-circle-green" style="text-decoration:none;">${ICONS.phone}</a>
        </div>`;
      no++;
    });
  }).catch(err => tampilkanErrorMuat('rws-list', err));
}

/* =========================================================
   26. ADMIN RT: INFORMASI RT (broadcast ke warga)
========================================================= */
function loadRtInformasi(){
  const rt = currentProfileData.rt;
  db.collection('informasi').orderBy('tanggal', 'desc').get().then(snap => {
    const el = document.getElementById('rti-list');
    el.innerHTML = '';
    const relevan = snap.docs.filter(doc => {
      const d = doc.data();
      return d.tujuan === 'semua' || d.rtTarget === rt;
    });
    if(relevan.length === 0){
      el.innerHTML = '<p class="empty-state">Belum ada informasi yang dipublikasikan.</p>';
      return;
    }
    relevan.forEach(doc => {
      const d = doc.data();
      const tujuanLabel = d.tujuan === 'rt' ? ('RT ' + d.rtTarget) : 'Semua RT';
      const bisaHapus = d.dariRole === 'admin_rt' && d.rtTarget === rt;
      el.innerHTML += `
        <div class="list-item">
          <div class="left-row">
            ${d.gambarUrl ? `<img src="${d.gambarUrl}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover;flex-shrink:0;" />` : ''}
            <div><p class="title">${d.judul}</p><p class="subtitle">${d.kategori || 'Info'} &middot; ${tujuanLabel}</p></div>
          </div>
          ${bisaHapus ? `<i data-icon="trash" data-del-rti="${doc.id}" style="cursor:pointer;color:var(--text-muted);"></i>` : ''}
        </div>`;
    });
    renderIkonBaru();
    document.querySelectorAll('[data-del-rti]').forEach(icon => {
      icon.addEventListener('click', () => {
        db.collection('informasi').doc(icon.getAttribute('data-del-rti')).delete().then(loadRtInformasi).catch(err => tampilkanAlert('Gagal menghapus: ' + err.message));
      });
    });
  }).catch(err => tampilkanErrorMuat('rti-list', err));
}

document.getElementById('form-rt-informasi').addEventListener('submit', e => {
  e.preventDefault();
  const judul = document.getElementById('rti-judul').value.trim();
  const isi = document.getElementById('rti-isi').value.trim();
  const kategori = document.getElementById('rti-kategori').value;
  const target = document.getElementById('rti-target').value;
  const rt = currentProfileData.rt;
  const tujuan = target === 'semua' ? 'semua' : 'rt';
  const rtTarget = target === 'semua' ? null : rt;
  const tayangMulai = document.getElementById('rti-tayang-mulai').value || null;
  const tayangSampai = document.getElementById('rti-tayang-sampai').value || null;
  const fileInput = document.getElementById('rti-foto');
  const file = fileInput.files[0];
  const errorEl = document.getElementById('rti-error');
  if(!judul || !isi){
    errorEl.textContent = 'Judul dan isi wajib diisi.';
    return;
  }
  if(tayangMulai && tayangSampai && tayangMulai > tayangSampai){
    errorEl.textContent = 'Tanggal "Tayang mulai" tidak boleh setelah "Tayang sampai".';
    return;
  }
  errorEl.textContent = '';

  const simpan = (gambarUrl) => {
    db.collection('informasi').add({
      judul, isi, kategori, tujuan, rtTarget,
      dariRole: 'admin_rt',
      dariRT: rt,
      tayangMulai, tayangSampai,
      gambarUrl: gambarUrl || null,
      tanggal: firebase.firestore.FieldValue.serverTimestamp()
    }).then(() => {
      document.getElementById('rti-judul').value = '';
      document.getElementById('rti-isi').value = '';
      document.getElementById('rti-tayang-mulai').value = '';
      document.getElementById('rti-tayang-sampai').value = '';
      fileInput.value = '';
      loadRtInformasi();
      loadBannerInformasiRT();
    }).catch(err => tampilkanErrorSimpan('rti-error', err));
  };

  if(file){
    unggahFotoInformasi(file, simpan, err => tampilkanErrorSimpan('rti-error', err), 'rti-foto-progress');
  } else {
    simpan(null);
  }
});

/* =========================================================
   27. ADMIN RT: ACC SURAT (per-RT)
========================================================= */
function loadRtSurat(){
  const rt = currentProfileData.rt;
  db.collection('surat').where('rt', '==', rt).get().then(snap => {
    const elMenunggu = document.getElementById('rt-surat-list');
    const elRiwayat = document.getElementById('rt-surat-riwayat');
    elMenunggu.innerHTML = '';
    elRiwayat.innerHTML = '';
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada');
    const menunggu = docs.filter(d => d.data().status === 'Diajukan');
    const riwayat = docs.filter(d => d.data().status !== 'Diajukan');

    if(menunggu.length === 0){
      elMenunggu.innerHTML = '<p class="empty-state">Tidak ada pengajuan surat yang menunggu.</p>';
    }
    menunggu.forEach(doc => {
      const d = doc.data();
      elMenunggu.innerHTML += `
        <div class="list-item" style="flex-direction:column;align-items:stretch;">
          <div style="display:flex;justify-content:space-between;"><p class="title">${d.namaWarga || 'Warga'}</p><span class="pill pill-red">Menunggu</span></div>
          <p class="subtitle">${d.jenis} &middot; ${d.keperluan}</p>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn btn-primary" style="margin:0;flex:1;" data-acc="${doc.id}">ACC</button>
            <button class="btn btn-secondary" style="margin:0;flex:1;" data-tolak="${doc.id}">Tolak</button>
          </div>
        </div>`;
    });
    document.querySelectorAll('[data-acc]').forEach(btn => {
      btn.addEventListener('click', () => {
        db.collection('surat').doc(btn.getAttribute('data-acc')).update({ status: 'Disetujui' })
          .then(() => { loadRtSurat(); loadAdminRTBadges(); })
          .catch(err => tampilkanAlert('Gagal menyetujui: ' + err.message));
      });
    });
    document.querySelectorAll('[data-tolak]').forEach(btn => {
      btn.addEventListener('click', () => {
        db.collection('surat').doc(btn.getAttribute('data-tolak')).update({ status: 'Ditolak' })
          .then(() => { loadRtSurat(); loadAdminRTBadges(); })
          .catch(err => tampilkanAlert('Gagal menolak: ' + err.message));
      });
    });

    if(riwayat.length === 0){
      elRiwayat.innerHTML = '<p class="empty-state">Belum ada riwayat ACC surat.</p>';
    }
    riwayat.forEach(doc => {
      const d = doc.data();
      const pillClass = d.status === 'Disetujui' ? 'pill-green' : 'pill-red';
      elRiwayat.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.namaWarga || 'Warga'} &middot; ${d.jenis}</p><p class="subtitle">${d.keperluan}</p></div>
          <span class="pill ${pillClass}">${d.status}</span>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('rt-surat-list', err));
}

/* =========================================================
   28. ADMIN RT: LAPORAN WARGA (per-RT, otomatis pindah ke riwayat saat Selesai)
========================================================= */
function loadRtLapor(){
  const rt = currentProfileData.rt;
  db.collection('laporan').where('rt', '==', rt).get().then(snap => {
    const elAktif = document.getElementById('rt-lapor-list');
    const elRiwayat = document.getElementById('rt-lapor-riwayat');
    elAktif.innerHTML = '';
    elRiwayat.innerHTML = '';
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada').slice(0, 60);
    const aktif = docs.filter(d => d.data().status !== 'Selesai');
    const riwayat = docs.filter(d => d.data().status === 'Selesai');

    if(aktif.length === 0){
      elAktif.innerHTML = '<p class="empty-state">Tidak ada laporan yang sedang berjalan.</p>';
    }
    aktif.forEach(doc => {
      const d = doc.data();
      elAktif.innerHTML += `
        <div class="list-item" style="flex-direction:column;align-items:stretch;">
          <div style="display:flex;justify-content:space-between;"><p class="title">${d.namaWarga || 'Warga'} &middot; ${d.kategori}</p></div>
          <p class="subtitle">${d.lokasi} &middot; ${d.deskripsi}</p>
          <select data-status-id="${doc.id}" style="margin-top:8px;">
            <option value="Diterima" ${d.status === 'Diterima' ? 'selected' : ''}>Diterima</option>
            <option value="Diproses" ${d.status === 'Diproses' ? 'selected' : ''}>Diproses</option>
            <option value="Selesai" ${d.status === 'Selesai' ? 'selected' : ''}>Selesai</option>
          </select>
        </div>`;
    });
    document.querySelectorAll('[data-status-id]').forEach(sel => {
      const nilaiAwal = sel.value;
      sel.addEventListener('change', () => {
        db.collection('laporan').doc(sel.getAttribute('data-status-id')).update({ status: sel.value })
          .then(() => { loadAdminRTBadges(); loadRtLapor(); })
          .catch(err => { tampilkanAlert('Gagal menyimpan status: ' + err.message); sel.value = nilaiAwal; });
      });
    });

    if(riwayat.length === 0){
      elRiwayat.innerHTML = '<p class="empty-state">Belum ada laporan yang selesai.</p>';
    }
    riwayat.forEach(doc => {
      const d = doc.data();
      elRiwayat.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.namaWarga || 'Warga'} &middot; ${d.kategori}</p><p class="subtitle">${d.lokasi} &middot; ${d.deskripsi}</p></div>
          <span class="pill pill-green">Selesai</span>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('rt-lapor-list', err));
}

/* =========================================================
   29. ADMIN RT: CCTV (global, dikelola bersama)
========================================================= */
function loadRtCctv(){
  db.collection('cctv').get().then(snap => {
    const el = document.getElementById('rtc-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada CCTV terdaftar.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.lokasi}</p><p class="subtitle">${d.link || '-'}</p></div>
          <i data-icon="trash" data-del-cctv="${doc.id}" style="cursor:pointer;color:var(--text-muted);"></i>
        </div>`;
    });
    renderIkonBaru();
    document.querySelectorAll('[data-del-cctv]').forEach(icon => {
      icon.addEventListener('click', () => {
        db.collection('cctv').doc(icon.getAttribute('data-del-cctv')).delete().then(loadRtCctv).catch(err => tampilkanAlert('Gagal menghapus: ' + err.message));
      });
    });
  }).catch(err => tampilkanErrorMuat('rtc-list', err));
}

document.getElementById('form-rt-cctv').addEventListener('submit', e => {
  e.preventDefault();
  const lokasi = document.getElementById('rtc-lokasi').value.trim();
  const link = document.getElementById('rtc-link').value.trim();
  const errorEl = document.getElementById('rtc-error');
  if(!lokasi || !link){
    errorEl.textContent = 'Nama lokasi dan link wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  db.collection('cctv').add({ lokasi, link, status: 'Aktif' }).then(() => {
    document.getElementById('rtc-lokasi').value = '';
    document.getElementById('rtc-link').value = '';
    loadRtCctv();
  }).catch(err => tampilkanErrorSimpan('rtc-error', err));
});

/* =========================================================
   30. ADMIN RT: KONTAK DARURAT (global, dikelola bersama)
========================================================= */
function loadRtKontak(){
  db.collection('kontakDarurat').get().then(snap => {
    const el = document.getElementById('rtk-list');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada kontak darurat.</p>';
      return;
    }
    snap.forEach(doc => {
      const d = doc.data();
      el.innerHTML += `
        <div class="list-item">
          <div><p class="title">${d.nama}</p><p class="subtitle">${d.nomor}</p></div>
          <i data-icon="trash" data-del-kontak="${doc.id}" style="cursor:pointer;color:var(--text-muted);"></i>
        </div>`;
    });
    renderIkonBaru();
    document.querySelectorAll('[data-del-kontak]').forEach(icon => {
      icon.addEventListener('click', () => {
        db.collection('kontakDarurat').doc(icon.getAttribute('data-del-kontak')).delete().then(loadRtKontak).catch(err => tampilkanAlert('Gagal menghapus: ' + err.message));
      });
    });
  }).catch(err => tampilkanErrorMuat('rtk-list', err));
}

document.getElementById('form-rt-kontak').addEventListener('submit', e => {
  e.preventDefault();
  const nama = document.getElementById('rtk-nama').value.trim();
  const nomor = document.getElementById('rtk-nomor').value.trim();
  const errorEl = document.getElementById('rtk-error');
  if(!nama || !nomor){
    errorEl.textContent = 'Nama dan no. HP wajib diisi.';
    return;
  }
  errorEl.textContent = '';
  db.collection('kontakDarurat').add({ nama, nomor, darurat: true }).then(() => {
    document.getElementById('rtk-nama').value = '';
    document.getElementById('rtk-nomor').value = '';
    loadRtKontak();
  }).catch(err => tampilkanErrorSimpan('rtk-error', err));
});

/* =========================================================
   31. ADMIN RT: KAS RT (read-only — Kas Warga global + Iuran Per-RT milik RT sendiri)
========================================================= */
function loadRtKas(){
  db.collection('kas').where('kategori', '==', 'umum').get().then(snap => {
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'tanggal');
    const saldo = renderDaftarKas('rt-kaswarga-list', docs);
    document.getElementById('rt-kaswarga-saldo').textContent = formatRupiah(saldo);
  }).catch(err => tampilkanErrorMuat('rt-kaswarga-list', err));

  const rt = currentProfileData.rt;
  db.collection('kas').where('kategori', '==', 'perRT').where('rt', '==', rt).get().then(snap => {
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'tanggal');
    const saldo = renderDaftarKas('rt-iuranrt-list', docs);
    document.getElementById('rt-iuranrt-saldo').textContent = formatRupiah(saldo);
  }).catch(err => tampilkanErrorMuat('rt-iuranrt-list', err));
}

/* =========================================================
   32. ADMIN RT: AJUKAN KE PUSAT (kanal permintaan)
========================================================= */
function loadRtPusat(){
  const rt = currentProfileData.rt;
  db.collection('permintaanRT').where('rt', '==', rt).get().then(snap => {
    const el = document.getElementById('rtp-riwayat');
    el.innerHTML = '';
    if(snap.empty){
      el.innerHTML = '<p class="empty-state">Belum ada riwayat pesan.</p>';
      return;
    }
    const docs = urutkanBerdasarkanTanggal(snap.docs, 'dibuatPada');
    docs.forEach(doc => {
      const d = doc.data();
      const dariLabel = d.dariRole === 'super_admin' ? 'Pusat' : 'Saya';
      el.innerHTML += `
        <div class="list-item" style="flex-direction:column;align-items:stretch;">
          <p class="title">${dariLabel}</p>
          <p class="subtitle">${d.pesan}</p>
        </div>`;
    });
  }).catch(err => tampilkanErrorMuat('rtp-riwayat', err));
}

document.getElementById('form-rt-permintaan').addEventListener('submit', e => {
  e.preventDefault();
  const pesan = document.getElementById('rtp-pesan').value.trim();
  const errorEl = document.getElementById('rtp-error');
  if(!pesan){
    errorEl.textContent = 'Pesan tidak boleh kosong.';
    return;
  }
  errorEl.textContent = '';
  db.collection('permintaanRT').add({
    rt: currentProfileData.rt,
    pesan,
    dariRole: 'admin_rt',
    dariNama: currentProfileData.nama || 'Admin RT',
    dibuatPada: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => {
    document.getElementById('rtp-pesan').value = '';
    loadRtPusat();
  }).catch(err => tampilkanErrorSimpan('rtp-error', err));
});
