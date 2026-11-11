let adminLoggedIn = false;

// ══════════════════════════════════════
// FIREBASE CONFIG
// ══════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBRN5PhEmpum14ah3E779CaUnDbfYo_otI",
  authDomain:        "private-barber.firebaseapp.com",
  databaseURL:       "https://private-barber-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "private-barber",
  storageBucket:     "private-barber.firebasestorage.app",
  messagingSenderId: "848104934755",
  appId:             "1:848104934755:web:ce20fa74d23f6d4b051756"
};

// ══════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════
const OPEN_HOUR      = 8;            // first slot 08:00
const LAST_HOUR      = 19;           // last slot 19:00 (carries the late-slot fee)
const TZ_OFFSET      = '+02:00';     // South Africa (SAST — no daylight saving)
const TERMS_VERSION  = '2026-11-08c'; // keep in sync with "Last updated" on the Terms page
const STATUSES       = ['pending', 'confirmed', 'cancelled'];
const LATE_FEE          = 50;   // extra charged for the 19:00 slot

// ══════════════════════════════════════
// SAFETY HELPERS
// ══════════════════════════════════════
// Escape anything user-supplied before it goes into innerHTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// IDs end up inside inline onclick="…" attributes, so keep them to safe characters.
function safeId(id) { return String(id ?? '').replace(/[^A-Za-z0-9_-]/g, ''); }
// encodeURIComponent leaves ' untouched, which breaks onclick="window.open('…')" strings.
function waEnc(msg) { return encodeURIComponent(msg).replace(/'/g, '%27'); }

// Coerce a record from the database into something safe to render. Returns null if unusable.
function cleanBooking(b) {
  if (!b || typeof b !== 'object' || !/^PB[A-Z0-9]+$/.test(String(b.id || ''))) return null;
  const out = {
    ...b,
    id:         String(b.id),
    name:       String(b.name ?? ''),
    phone:      String(b.phone ?? ''),
    email:      String(b.email ?? ''),
    service:    String(b.service ?? ''),
    date:       String(b.date ?? ''),
    dateStr:    String(b.dateStr ?? ''),
    time:       /^\d{2}:\d{2}$/.test(String(b.time)) ? String(b.time) : '00:00',
    status:     STATUSES.includes(b.status) ? b.status : 'pending',
    totalPrice: Number(b.totalPrice) || 0,
    createdAt:  Number(b.createdAt) || 0,
    cutStatus:  ['done', 'noshow'].includes(b.cutStatus) ? b.cutStatus : ''
  };
  out.dateKey = b.dateKey || normalizeDateStr(out.dateStr);
  return out;
}
function bookingKey(b) { return b.dateKey || normalizeDateStr(b.dateStr); }
function bookingMs(b) { return slotMs(bookingKey(b), b.time); }

function effectiveStatus(b) { return STATUSES.includes(b.status) ? b.status : 'pending'; }
function statusBadge(b, admin = false) {
  let cls = effectiveStatus(b);
  let label = cls.charAt(0).toUpperCase() + cls.slice(1);
  if (admin && b.cutStatus === 'noshow') { cls = 'cancelled'; label = 'Didn’t come'; }
  else if (admin && b.status !== 'cancelled') {
    if (b.cutStatus === 'done')          { cls = 'confirmed'; label = 'Done'; }
    else if (bookingMs(b) <= Date.now()) { cls = 'pending';   label = 'Not done'; }
  }
  return `<div class="status-badge ${cls}">${label}</div>`;
}

// Hash of an email address — the "My Bookings" lookup index is keyed by this, never by the plain email.
async function emailHash(email) {
  const data = new TextEncoder().encode(String(email).trim().toLowerCase());
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
function isRealEmail(e) { return !/@privatebarber\.local$/i.test(String(e)); }

// "2026-11-07" + "09:00" → ms, always interpreted in South African time
function slotMs(dateKey, time) { return new Date(`${dateKey}T${time}:00${TZ_OFFSET}`).getTime(); }

// ══════════════════════════════════════
// FIREBASE STATE
// ══════════════════════════════════════
let _db            = null;
let _auth          = null;
let _fbReady       = false;   // slot data has loaded
let _fbConnected   = false;
let _loadFailed    = false;
let _slotsMap      = {};      // { "2026-11-07": Set(["09:00", ...]) }  ← public, times only (no personal data)
let _closedDates   = new Set();
let _closedSlots   = {};      // { "2026-11-07": Set(["09:00"]) }
let _availSelectedDate = null;
let _notices      = {};      // notice board: { id: { text, createdAt } }  ← public, written by the admin
let _slotState    = {};      // { "2026-11-08": { "1300": "done" } }  ← public, set by the admin

let _bookingsCache = [];      // ADMIN ONLY — filled after admin sign-in
let _adminRef      = null;
let _adminFirstSnap = true;
let _locksSynced   = false;
let _idxDone       = new Set(JSON.parse(localStorage.getItem('pb_idx_done') || '[]'));

let _debts         = {};      // MONEY OWED (admin only): { emailHash: { email, amount, note, createdAt, updatedAt } }
let _debtsRef      = null;
let _debtsLoaded   = false;   // so a card never says "owes nothing" before the list has loaded
let _lastBooking   = null;    // the booking just made (for the confirmation screen's calendar buttons)
let _myBookings    = {};      // bookings this device created / looked up, keyed by id
const _myWatchers  = {};
let _bookingInFlight = false;

// ── Bookings this device knows about (IDs only are kept in localStorage) ───
function getMyIds() {
  try {
    return JSON.parse(localStorage.getItem('pb_my_ids') || '[]').filter(id => /^PB[A-Z0-9]+$/.test(id));
  } catch { return []; }
}
function addMyId(id) {
  const ids = getMyIds();
  if (!ids.includes(id)) { ids.push(id); localStorage.setItem('pb_my_ids', JSON.stringify(ids)); }
  watchMyBooking(id);
}
function watchMyBooking(id) {
  if (!_db || _myWatchers[id]) return;
  const ref = _db.ref('pb_bookings/' + id);
  const cb = snap => {
    const b = cleanBooking(snap.val());
    if (b) _myBookings[id] = b; else delete _myBookings[id];
    if (state.currentPage === 'bookings') renderMyBookings();
  };
  ref.on('value', cb, err => console.warn('Could not read booking', id, err.code));
  _myWatchers[id] = { ref, cb };
}
function unwatchAllMine() {
  Object.keys(_myWatchers).forEach(k => { _myWatchers[k].ref.off('value', _myWatchers[k].cb); delete _myWatchers[k]; });
}

// ── Init ──────────────────────────────────────────────────────────────────
function initFirebase() {
  try {
    localStorage.removeItem('pb_bookings');   // purge customer data cached by the old version
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    _db   = firebase.database();
    _auth = firebase.auth();
    window._auth = _auth;

    // PUBLIC: which time slots are taken (no names / phones / emails)
    _db.ref('pb_slots').on('value', snap => {
      const val = snap.val() || {};
      _slotsMap = {};
      Object.keys(val).forEach(dk => {
        _slotsMap[dk] = new Set(Object.keys(val[dk] || {}).map(t => t.slice(0, 2) + ':' + t.slice(2)));
      });
      _fbReady = true; _loadFailed = false;
      refreshOpenGrids();
    }, err => { console.warn('Slots read failed', err); _loadFailed = true; refreshOpenGrids(); });

    _db.ref('.info/connected').on('value', snap => {
      _fbConnected = snap.val() === true;
      updateConnectionBadge(_fbConnected);
    });

    _db.ref('pb_closed_dates').on('value', snap => {
      const val = snap.val() || {};
      _closedDates = new Set(Object.keys(val).filter(k => val[k] === true));
      if (state.currentPage === 'booking') renderBookingCalendar();
      refreshOpenGrids();
    });

    _db.ref('pb_closed_slots').on('value', snap => {
      const val = snap.val() || {};
      _closedSlots = {};
      Object.keys(val).forEach(dateKey => {
        _closedSlots[dateKey] = new Set(
          Object.keys(val[dateKey]).filter(t => val[dateKey][t] === true).map(t => t.slice(0, 2) + ':' + t.slice(2))
        );
      });
      if (state.currentPage === 'booking') renderBookingCalendar();
      refreshOpenGrids();
    });

    _db.ref('pb_slotstate').on('value', snap => {
      _slotState = snap.val() || {};
      refreshOpenGrids();
    });

    _db.ref('pb_notices').on('value', snap => {
      _notices = snap.val() || {};
      renderNotices();
    });

    // If availability hasn't loaded after 10s, say so instead of spinning forever
    setTimeout(() => { if (!_fbReady) { _loadFailed = true; refreshOpenGrids(); } }, 10000);

    startAuthWatcher();
  } catch (err) {
    console.warn('Firebase init failed', err);
    _fbConnected = false; _loadFailed = true;
    updateConnectionBadge(false);
  }
}

// Re-draw any time grid that is currently on screen
function refreshOpenGrids() {
  const b = state.booking;
  if (state.currentPage === 'booking' && b.step === 2 && b.date) {
    if (b.time && !isSlotAvailable(dateToKey(b.date), b.time)) {
      b.time = null; b.lateFee = false;
      const n = document.getElementById('next-2'); if (n) n.disabled = true;
    }
    buildTimeGrid('time-grid', b.date, b.time, 'selectTime');
  }
  const rm = document.getElementById('reschedule-modal');
  if (rm && rm.classList.contains('open') && state.reschedule.date) {
    buildTimeGrid('reschedule-time-grid', state.reschedule.date, state.reschedule.time, 'selectRescheduleTime');
  }
  const mm = document.getElementById('manual-booking-modal');
  if (mm && mm.classList.contains('open') && state.manualBooking.date) {
    buildTimeGrid('manual-time-grid', state.manualBooking.date, state.manualBooking.time, 'selectManualTime', { ignoreNotice: true });
  }
  if (adminLoggedIn && _availSelectedDate) {
    renderAvailabilityCalendar();
    renderAvailabilityTimeGrid(_availSelectedDate);
  }
}

// ── Slot availability ─────────────────────────────────────────────────────
function getBookedSlots(dateKey) { return Array.from(_slotsMap[dateKey] || []); }

function isSlotAvailable(dateKey, time, opts = {}) {
  if (_closedDates.has(dateKey)) return false;
  if ((_closedSlots[dateKey] || new Set()).has(time)) return false;
  if (getBookedSlots(dateKey).includes(time)) return false;
  return true;
}

// ── Admin: live bookings (only runs while an admin is signed in) ──────────
function startAdminSync(attempt = 0) {
  if (!_db || _adminRef) return;
  _adminFirstSnap = true;
  const ref = _db.ref('pb_bookings');
  _adminRef = ref;
  ref.on('value', snap => {
    const raw      = snap.val();
    const incoming = raw ? Object.values(raw).map(cleanBooking).filter(Boolean) : [];
    const known    = new Set(_bookingsCache.map(b => b.id));
    const added    = _adminFirstSnap ? [] : incoming.filter(b => !known.has(b.id));
    _bookingsCache = incoming;
    if (_adminFirstSnap) { _adminFirstSnap = false; syncSlotLocks(); }
    added.forEach(b => pushLiveAlert(b));
    added.forEach(b => { const d = isRealEmail(b.email) && debtFor(b.email); if (d) toast(`⚠️ ${b.name} still owes R${d.amount}`, 'error', '💸'); });
    updateAdminBadge();
    if (adminLoggedIn) renderAdminDashboard();
  }, err => {
    // Right after sign-in the database can still be using the old (anonymous) login for a moment,
    // which makes this read fail once. Detach and retry a few times before giving up.
    console.warn('Admin bookings read failed (attempt ' + (attempt + 1) + ')', err.code || err);
    ref.off();
    if (_adminRef === ref) _adminRef = null;
    if (adminLoggedIn && attempt < 4) {
      setTimeout(() => startAdminSync(attempt + 1), 1000 * (attempt + 1));
    } else if (adminLoggedIn) {
      toast('Cannot read bookings — check the database rules (admin UID).', 'error', '🚫');
      const uid = (_auth && _auth.currentUser) ? _auth.currentUser.uid : '?';
      const box = document.getElementById('admin-live-alerts');
      if (box) box.innerHTML = `<div style="margin-bottom:16px;padding:14px 16px;border:1px solid #e05252;border-radius:8px;color:#e07060;font-size:0.82rem;line-height:1.6">🚫 Can’t read bookings (${esc(err.code || 'error')}).<br>You are signed in with UID <strong style="word-break:break-all">${esc(uid)}</strong>.<br>This must match the UID in your Firebase rules.</div>`;
    }
  });
}

function stopAdminSync() {
  if (_adminRef) { _adminRef.off(); _adminRef = null; }
  _bookingsCache = []; _locksSynced = false;
  liveAlerts.length = 0;
  ['admin-bookings-list', 'admin-stats', 'admin-live-alerts'].forEach(id => {
    const el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  updateAdminBadge();
}

// One-time per admin session: make sure every existing booking has a slot lock and a dateKey
// (bookings created before this update don't have them).
async function syncSlotLocks() {
  if (_locksSynced || !_db) return;
  _locksSynced = true;
  for (const b of _bookingsCache) {
    try {
      const key = bookingKey(b);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      if (!b.dateKey) await _db.ref(`pb_bookings/${b.id}/dateKey`).set(key);
      if (isRealEmail(b.email) && !_idxDone.has(b.id)) {
        await _db.ref(`pb_by_email/${await emailHash(b.email)}/${b.id}`).set(true);
        _idxDone.add(b.id);
        localStorage.setItem('pb_idx_done', JSON.stringify([..._idxDone].slice(-5000)));
      }
      if (b.status === 'cancelled' || slotMs(key, b.time) < Date.now() - 86400000) continue;
      await _db.ref(`pb_slots/${key}/${b.time.replace(':', '')}`)
        .transaction(cur => cur === null ? b.id : undefined);
    } catch (e) { console.warn('Slot sync skipped for', b.id, e.code || e.message); }
  }
}

function getBookings() { return _bookingsCache; }                       // admin view
function findBooking(id) { return _bookingsCache.find(b => b.id === id) || _myBookings[id] || null; }

// ── Writes ────────────────────────────────────────────────────────────────
async function ensureAuth() {
  if (!_auth) throw new Error('NO_AUTH');
  if (_auth.currentUser) return _auth.currentUser;
  return (await _auth.signInAnonymously()).user;
}

// Claim the slot atomically, then save the booking. If two people click at the same
// moment, exactly one transaction commits and the other gets SLOT_TAKEN.
async function createBookingWithLock(booking) {
  await ensureAuth();
  const lock = _db.ref(`pb_slots/${booking.dateKey}/${booking.time.replace(':', '')}`);
  const res  = await lock.transaction(cur => cur === null ? booking.id : undefined);
  if (!res.committed) throw new Error('SLOT_TAKEN');
  try {
    const updates = {};
    updates[`pb_bookings/${booking.id}`] = booking;
    if (isRealEmail(booking.email)) updates[`pb_by_email/${await emailHash(booking.email)}/${booking.id}`] = true;
    await _db.ref().update(updates);
  } catch (e) {
    await lock.remove().catch(() => {});
    throw e;
  }
}

function releaseLock(dateKey, time, id) {
  return _db.ref(`pb_slots/${dateKey}/${time.replace(':', '')}`)
    .transaction(cur => cur === id ? null : undefined)
    .catch(e => console.warn('Lock release failed', e));
}

function updateBooking(id, patch) { return _db.ref('pb_bookings/' + id).update(patch); }

// Admin: change status; cancelling frees the slot again
async function saveBookingStatus(id, status) {
  const b = _bookingsCache.find(x => x.id === id);
  if (!b || !_db) return;
  try {
    await _db.ref(`pb_bookings/${id}/status`).set(status);
    if (status === 'cancelled') {
      await releaseLock(bookingKey(b), b.time, id);
      await _db.ref(`pb_slotstate/${bookingKey(b)}/${b.time.replace(':', '')}`).remove().catch(() => {});
    }
  } catch (e) {
    console.error(e);
    toast('Update failed: ' + (e.code || e.message), 'error', '⚠️');
  }
}

// Admin: "done" (click again to undo) or "noshow" (client didn't come → booking cancelled, slot reopened)
async function setCutStatus(id, state) {
  const b = _bookingsCache.find(x => x.id === id);
  if (!b || !_db) return;
  const key = bookingKey(b), t4 = b.time.replace(':', '');
  try {
    if (state === 'noshow') {
      if (!confirm(`Mark ${b.name} as not coming?\n\nThis reopens the ${b.time} slot so other customers can book it.`)) return;
      await _db.ref().update({
        [`pb_bookings/${id}/status`]:      'cancelled',
        [`pb_bookings/${id}/cutStatus`]:   'noshow',
        [`pb_bookings/${id}/cancelledAt`]: Date.now(),
        [`pb_slotstate/${key}/${t4}`]:     null
      });
      await releaseLock(key, b.time, id);
      toast(`${b.name} didn’t come — the ${b.time} slot is open again.`, 'success', '🔓');
    } else {
      const next = b.cutStatus === 'done' ? null : 'done';
      await _db.ref().update({ [`pb_bookings/${id}/cutStatus`]: next, [`pb_slotstate/${key}/${t4}`]: next });
      if (next) toast(`Done cutting ${b.name} ✓`, 'success', '✅');
    }
  } catch (e) {
    console.error(e);
    toast('Could not update: ' + (e.code || e.message), 'error', '⚠️');
  }
}

// ── Connection status dot (admin only) ────────────────────────────────────
function updateConnectionBadge(connected) {
  const dot = document.getElementById('fb-status-dot');
  if (!dot) return;
  dot.style.display    = adminLoggedIn ? 'block' : 'none';
  dot.title            = connected ? 'Live sync: Online' : 'Live sync: Offline';
  dot.style.background = connected ? '#27ae60' : '#e05252';
}


// ══════════════════════════════════════
// AVAILABILITY TOGGLES
// ══════════════════════════════════════
function toggleClosedDate(dateStr) {
  const key = dateToKey(dateStr);
  const isCurrentlyClosed = _closedDates.has(key);
  const newValue = isCurrentlyClosed ? null : true;

  if (!_db) {
    toast('Not connected to database — cannot update availability.', 'error', '⚠️');
    return;
  }

  _db.ref(`pb_closed_dates/${key}`).set(newValue)
    .then(() => {
      // Only update local state after the write is confirmed
      if (isCurrentlyClosed) _closedDates.delete(key);
      else _closedDates.add(key);
      renderAvailabilityCalendar();
      renderAvailabilityTimeGrid(key);
      toast(isCurrentlyClosed ? 'Day reopened.' : 'Day closed.', 'success', '✓');
    })
    .catch(err => {
      console.error('toggleClosedDate failed:', err);
      if (err.code === 'PERMISSION_DENIED') {
        toast('Permission denied — check Firebase rules for pb_closed_dates.', 'error', '🚫');
      } else {
        toast('Failed to update availability: ' + err.message, 'error', '⚠️');
      }
      // Re-render with the unchanged (real) state so UI doesn't show a false toggle
      renderAvailabilityCalendar();
      renderAvailabilityTimeGrid(key);
    });
}

function toggleClosedSlot(dateStr, time) {
  const key = dateToKey(dateStr);
  const slots = _closedSlots[key] || new Set();
  const isClosed = slots.has(time);
  const newValue = isClosed ? null : true;

  if (!_db) {
    toast('Not connected to database — cannot update availability.', 'error', '⚠️');
    return;
  }

  _db.ref(`pb_closed_slots/${key}/${time.replace(':', '')}`).set(newValue)
    .then(() => {
      if (!_closedSlots[key]) _closedSlots[key] = new Set();
      if (isClosed) _closedSlots[key].delete(time);
      else _closedSlots[key].add(time);
      renderAvailabilityTimeGrid(key);
      toast(isClosed ? 'Slot reopened.' : 'Slot closed.', 'success', '✓');
    })
    .catch(err => {
      console.error('toggleClosedSlot failed:', err);
      if (err.code === 'PERMISSION_DENIED') {
        toast('Permission denied — check Firebase rules for pb_closed_slots.', 'error', '🚫');
      } else {
        toast('Failed to update slot: ' + err.message, 'error', '⚠️');
      }
      renderAvailabilityTimeGrid(key);
    });
}

// ══════════════════════════════════════
// WHATSAPP HELPERS
// ══════════════════════════════════════
const ADMIN_WA = '27768502521';

/**
 * Normalise a South African phone number to WhatsApp international format.
 * Note: replace(/\D/g,'') already strips +, so the + check is not needed.
 */
function formatWANumber(raw) {
  let num = String(raw).replace(/\D/g, '');
  if (num.startsWith('0')) num = '27' + num.slice(1);
  if (!num.startsWith('27') && num.length === 9) num = '27' + num;
  return num;
}

function openWhatsApp(number, message) {
  const waNum   = formatWANumber(number);
  const encoded = encodeURIComponent(message);
  window.open(`https://wa.me/${waNum}?text=${encoded}`, '_blank');
}

function buildNewBookingMsg(booking) {
  const late = booking.lateFee ? `\n🌙 Late Fee: +R${LATE_FEE}` : '';
  return `🆕 *NEW BOOKING — PRIVATE BARBER 💈*\n\n` +
    `👤 *Name:* ${booking.name}\n` +
    `📞 *Phone:* ${booking.phone}\n` +
    `✂️ *Service:* ${booking.service}\n` +
    `📅 *Date:* ${booking.date}\n` +
    `🕐 *Time:* ${booking.time}${late}\n` +
    `💰 *Total:* R${booking.totalPrice}\n` +
    `🔖 *Booking ID:* ${booking.id}\n\n` +
    `_Please confirm or follow up with the client._`;
}

function buildCustomerConfirmMsg(booking) {
  return `Hello ${booking.name} 👋, thank you for booking with *PRIVATE BARBER 💈*!\n\n` +
    `Here are your booking details:\n` +
    `✂️ *Service:* ${booking.service}\n` +
    `📅 *Date:* ${booking.date}\n` +
    `🕐 *Time:* ${booking.time}\n` +
    `💰 *Total:* R${booking.totalPrice}\n` +
    `🔖 *Booking ID:* ${booking.id}\n\n` +
    `We look forward to seeing you! If you need to reschedule, please contact us. 😊`;
}

function buildAdminCancelMsg(booking) {
  return `Hello ${booking.name} 👋, this is *PRIVATE BARBER 💈*.\n\n` +
    `Unfortunately, your booking for *${booking.service}* on *${booking.date}* at *${booking.time}* has been *cancelled*.\n\n` +
    `Please choose another available time — we apologise for the inconvenience and hope to see you soon! 🙏`;
}

function buildAdminConfirmMsg(booking) {
  return `Hello ${booking.name} 👋, this is *PRIVATE BARBER 💈*.\n\n` +
    `✅ Your appointment has been *confirmed*!\n\n` +
    `✂️ *Service:* ${booking.service}\n` +
    `📅 *Date:* ${booking.date}\n` +
    `🕐 *Time:* ${booking.time}\n` +
    `💰 *Total:* R${booking.totalPrice}\n\n` +
    `See you soon! 💈`;
}

function buildAdminReschedMsg(booking) {
  return `Hello ${booking.name} 👋, this is *PRIVATE BARBER 💈*.\n\n` +
    `🔁 We need to *reschedule* your appointment that was booked for *${booking.date}* at *${booking.time}*.\n\n` +
    `Please reply with a new date and time that works for you and we will lock it in right away. Sorry for any inconvenience! 🙏`;
}


// ══════════════════════════════════════
// STATE
// ══════════════════════════════════════
const state = {
  currentPage: 'home',
  booking: {
    step: 1,
    date: null,
    time: null,
    service: null,
    name: '', phone: '', email: '',
    lateFee: false,
    totalPrice: 0
  },
  calendar:    { year: 0, month: 0 },
  reschedule:  { bookingId: null, date: null, time: null, calYear: 0, calMonth: 0 },
  manualBooking: { date: null, time: null, service: null, calYear: 0, calMonth: 0 },
  cancelTarget:     null,
  cancelFeeApplied: false,   // FIX: declared here, not dynamically assigned later
  adminFilter: 'all',
  termsReturn: null          // 'booking' when the Terms page was opened from the booking modal
};


// ══════════════════════════════════════
// PAGE ROUTING
// ══════════════════════════════════════
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  state.currentPage = name;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'booking')  initBookingPage();
  if (name === 'bookings') {
    const li = document.getElementById('lookup-id'); if (li) li.value = '';
    document.getElementById('lookup-email').value = '';
    renderMyBookings();
  }
  if (name === 'admin') { initAdminPage(); clearLiveAlerts(); }
  if (name === 'home')  initReveal();
  updateAdminBadge();
}


// ══════════════════════════════════════
// NAV SCROLL
// ══════════════════════════════════════
window.addEventListener('scroll', () => {
  document.getElementById('nav').classList.toggle('scrolled', window.scrollY > 40);
});


// ══════════════════════════════════════
// REVEAL ANIMATION
// ══════════════════════════════════════
function initReveal() {
  setTimeout(() => {
    const els = document.querySelectorAll('.reveal');
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    els.forEach(el => obs.observe(el));
  }, 100);
}
initReveal();


// ══════════════════════════════════════
// TOAST
// ══════════════════════════════════════
function toast(msg, type = 'default', icon = '💬') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = document.createElement('span'); ic.className = 'toast-icon'; ic.textContent = icon;
  const tx = document.createElement('span'); tx.textContent = msg;
  el.append(ic, tx);
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s forwards';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}


// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════
function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  if (!d) return '—';
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateShort(d) {
  if (!d) return '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`;
}

// Unguessable: the Booking ID is what lets a customer open / change their own booking.
function generateId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';       // 32 chars → no modulo bias
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return 'PB' + Array.from(bytes, b => chars[b % 32]).join('');
}

function getServiceLabel(svc) { return svc === 'dye' ? 'Haircut with Dye' : 'Haircut without Dye'; }
function getServicePrice(svc) { return svc === 'dye' ? 100 : 80; }

// ✅ Normalizes any date string to "Mon Jun 02 2026" format (zero-padded day)
// Ensures Safari/Chrome/Android all produce identical keys for Firebase lookups
// ✅ Produces "2026-06-02" format — consistent on every browser/device
function normalizeDateStr(dateStr) {
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;  // already a key
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ✅ Use this when you already have a Date object (year, month, day)
// Never parses a string — 100% consistent on every device
function dateToKey(date) { return normalizeDateStr(date); }   // accepts a Date, a key, or a toDateString()


// ══════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════
function buildCalendar(containerId, year, month, selectedDate, onSelect, opts = {}) {
  // opts.disableClosed: default true (client calendars can't select a closed day).
  // Pass { disableClosed: false } for the admin availability calendar so closed
  // days stay CLICKABLE — otherwise, once a day is closed, the admin can never
  // click it again in the calendar grid to reopen it.
  const disableClosed = opts.disableClosed !== false;
  const container    = document.getElementById(containerId);
  const now          = new Date();
  const today        = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const firstDay     = new Date(year, month, 1).getDay();
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  let html = `<div class="cal-header">
    <button class="cal-nav" aria-label="Previous month" onclick="${onSelect.nav}(-1)">‹</button>
    <div class="cal-month">${months[month]} ${year}</div>
    <button class="cal-nav" aria-label="Next month" onclick="${onSelect.nav}(1)">›</button>
  </div>
  <div class="cal-grid">
    <div class="cal-day-label">Su</div><div class="cal-day-label">Mo</div>
    <div class="cal-day-label">Tu</div><div class="cal-day-label">We</div>
    <div class="cal-day-label">Th</div><div class="cal-day-label">Fr</div>
    <div class="cal-day-label">Sa</div>`;

  for (let i = 0; i < firstDay; i++) html += `<div class="cal-day empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const thisDate = new Date(year, month, d);
    const isPast   = thisDate < today;
   // ✅ FIXED
// ✅ Use dateToKey from the Date object directly — never toDateString()
const isClosed = _closedDates && _closedDates.has(dateToKey(thisDate));
    const disabled = isPast || (isClosed && disableClosed);
    const isToday  = thisDate.getTime() === today.getTime();
    const isSel    = selectedDate && thisDate.toDateString() === selectedDate.toDateString();
    const cls = ['cal-day',
      disabled              ? 'disabled'   : '',
      isToday               ? 'today'      : '',
      isSel                 ? 'selected'   : '',
      isClosed && !isPast   ? 'closed-day' : ''
    ].filter(Boolean).join(' ');
    const click = disabled ? 'aria-disabled="true"' : `role="button" tabindex="0" onclick="${onSelect.click}(${year},${month},${d})"`;
    html += `<div class="${cls}" ${click}>${d}</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── Main booking calendar ─────────────────────────────────────────────────
function initBookingCalendar() {
  const now = new Date();
  state.calendar.year  = now.getFullYear();
  state.calendar.month = now.getMonth();
  renderBookingCalendar();
}
function navBookingCal(dir) {
  state.calendar.month += dir;
  if (state.calendar.month > 11) { state.calendar.month = 0;  state.calendar.year++; }
  if (state.calendar.month < 0)  { state.calendar.month = 11; state.calendar.year--; }
  renderBookingCalendar();
}
function renderBookingCalendar() {
  buildCalendar('calendar', state.calendar.year, state.calendar.month, state.booking.date, {
    nav: 'navBookingCal', click: 'selectBookingDate'
  });
}
function selectBookingDate(y, m, d) {
  state.booking.date = new Date(y, m, d);
  renderBookingCalendar();
  document.getElementById('selected-date-display').textContent = '📅 ' + formatDate(state.booking.date);
  document.getElementById('next-1').disabled = false;
}

// ── Availability calendar (admin) ─────────────────────────────────────────
let _availCal = { year: new Date().getFullYear(), month: new Date().getMonth() };

function renderAvailabilityCalendar() {
  buildCalendar('availability-calendar', _availCal.year, _availCal.month, null, {
    nav: 'navAvailCal', click: 'adminToggleDate'
  }, { disableClosed: false });
}

function renderAvailabilityTimeGrid(dateStr) {
  const container = document.getElementById('availability-time-grid');
  if (!container) return;

  const key         = dateToKey(dateStr);
  const bookedSlots = getBookedSlots(key);
  const closedSlots = _closedSlots[key] || new Set();
  const isDayClosed = _closedDates.has(key);

  const [ky, km, kd] = key.split('-').map(Number);
  const d      = new Date(ky, km - 1, kd);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateLabel = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;

  const slots = [];
  for (let h = OPEN_HOUR; h <= LAST_HOUR; h++) slots.push(`${pad2(h)}:00`);

  let html = `
    <div class="avail-date-heading">📅 ${dateLabel}</div>
    <div class="avail-toggle-row">
      <button onclick="toggleClosedDate('${key}')"
              class="avail-day-btn ${isDayClosed ? 'reopen' : 'close'}">
        ${isDayClosed ? '🟢 Reopen Entire Day' : '🔴 Close Entire Day'}
      </button>
      <span class="avail-toggle-hint">or toggle individual slots below</span>
    </div>
    <div class="avail-slots-grid">
  `;

  slots.forEach(slot => {
    const isBooked = bookedSlots.includes(slot);
    const isClosed = closedSlots.has(slot) || isDayClosed;
    const isLate   = slot === '19:00';

    let stateClass, slotLabel;
    if (isBooked) {
      stateClass = 'avail-slot-booked';
      slotLabel  = `${slot}<br><span class="avail-slot-sub">Booked</span>`;
    } else if (isClosed) {
      stateClass = 'avail-slot-closed';
      slotLabel  = `${slot}<br><span class="avail-slot-sub">Closed</span>`;
    } else {
      stateClass = 'avail-slot-open';
      slotLabel  = `${slot}${isLate ? '<br><span class="avail-slot-sub">+R' + LATE_FEE + '</span>' : ''}`;
    }

    const clickable = !isBooked && !isDayClosed;
    const onclick   = clickable ? `role="button" tabindex="0" onclick="toggleClosedSlot('${key}','${slot}')"` : '';

    html += `<div ${onclick} class="avail-slot ${stateClass}${clickable ? '' : ' avail-slot-disabled'}">${slotLabel}</div>`;
  });

  html += `</div>
    <div class="avail-legend">
      <span class="avail-legend-open">🟢 Open</span>
      <span class="avail-legend-closed">🔴 Closed</span>
      <span>⬛ Booked by client</span>
    </div>
  `;

  container.innerHTML = html;
}

function navAvailCal(dir) {
  _availCal.month += dir;
  if (_availCal.month > 11) { _availCal.month = 0;  _availCal.year++; }
  if (_availCal.month < 0)  { _availCal.month = 11; _availCal.year--; }
  renderAvailabilityCalendar();
}

function adminToggleDate(y, m, d) {
  const key = dateToKey(new Date(y, m, d));
  _availSelectedDate = key;
  renderAvailabilityCalendar();
  renderAvailabilityTimeGrid(key);
  document.getElementById('availability-time-panel').style.display = 'block';
}

// ══════════════════════════════════════
// TIME SLOTS
// ══════════════════════════════════════
// FIX: removed inner <div class="time-grid"> wrapper — the container
// already has the class in HTML for #time-grid.
// For #reschedule-time-grid: add class="time-grid" to that element in index.html.
function buildTimeGrid(containerId, date, selectedTime, onSelect, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!_fbReady) {
    el.innerHTML = _loadFailed
      ? '<div style="text-align:center;padding:20px;color:#e07060">⚠️ Couldn’t load availability. Check your connection and refresh the page.</div>'
      : '<div style="text-align:center;padding:20px;color:var(--gold)">⏳ Loading slots...</div>';
    return;
  }

  const dateKey     = dateToKey(date);
  const taken       = getBookedSlots(dateKey);
  const isDayClosed = _closedDates.has(dateKey);
  const closedSet   = _closedSlots[dateKey] || new Set();

  let html = '';
  for (let h = OPEN_HOUR; h <= LAST_HOUR; h++) {
    const slot           = `${pad2(h)}:00`;
    const isClientBooked = taken.includes(slot);
    const isSlotClosed   = isDayClosed || closedSet.has(slot);
    const unavailable    = isClientBooked || isSlotClosed;
    const isSel          = slot === selectedTime;

    const cls = ['time-slot', unavailable ? 'booked' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
    const attrs = unavailable ? 'aria-disabled="true"' : `role="button" tabindex="0" onclick="${onSelect}('${slot}')"`;

    let badge = '';
    if (isClientBooked && slotMs(dateKey, slot) <= Date.now()) {
      const st = (_slotState[dateKey] || {})[slot.replace(':', '')];
      badge = `<span class="late-badge">${st === 'done' ? 'Done ✓' : 'Not done'}</span>`;
    }
    else if (isSlotClosed && !isClientBooked)      badge = `<span class="late-badge">Closed</span>`;
    else if (isLateSlot(slot) && !unavailable) badge = `<span class="late-badge">+R${LATE_FEE} late</span>`;

    html += `<div class="${cls}" ${attrs}>${slot}${badge}</div>`;
  }
  el.innerHTML = html;
}

function isLateSlot(slot) {
  const [h] = slot.split(':').map(Number);
  return h > 18; // only 19:00 qualifies
}

function selectTime(slot) {
  state.booking.time    = slot;
  state.booking.lateFee = isLateSlot(slot);
  const dateStr = state.booking.date ? state.booking.date.toDateString() : '';
  buildTimeGrid('time-grid', dateStr, slot, 'selectTime');
  document.getElementById('next-2').disabled = false;
}


// ══════════════════════════════════════
// SERVICES
// ══════════════════════════════════════
function selectService(svc) {
  state.booking.service = svc;
  document.querySelectorAll('.service-option').forEach(el => el.classList.remove('selected'));
  document.getElementById('svc-' + svc).classList.add('selected');
  document.getElementById('next-3').disabled = false;
}


// ══════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════
function updateSummary() {
  const b = state.booking;
  document.getElementById('sum-date').textContent    = b.date    ? formatDate(b.date)       : '—';
  document.getElementById('sum-time').textContent    = b.time    || '—';
  document.getElementById('sum-service').textContent = b.service ? getServiceLabel(b.service) : '—';
  const price = b.service ? getServicePrice(b.service) : 0;
  document.getElementById('sum-price').textContent   = b.service ? `R${price}` : '—';
  const lateRow = document.getElementById('sum-late-row');
  lateRow.style.display = b.lateFee ? 'flex' : 'none';
  const total = price + (b.lateFee ? LATE_FEE : 0);
  const sl = document.getElementById('sum-late'); if (sl) sl.textContent = '+R' + LATE_FEE;
  state.booking.totalPrice = total;
  document.getElementById('sum-total').textContent   = b.service ? `R${total}` : '—';
}


// ══════════════════════════════════════
// BOOKING FLOW
// ══════════════════════════════════════
function initBookingPage() {
  if (state.booking.step === 5) return; // keep confirmation visible
  goStep(1);
}

function goStep(n) {
  state.booking.step = n;
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');

  // Step indicator dots
  for (let i = 1; i <= 5; i++) {
    const dot = document.getElementById('sdot-' + i);
    dot.classList.remove('active', 'done');
    if (i < n)      { dot.classList.add('done');   dot.textContent = '✓'; }
    else if (i === n) { dot.classList.add('active'); dot.textContent = i; }
    else dot.textContent = i;
  }
  // Step indicator lines
  for (let i = 1; i <= 4; i++) {
    document.getElementById('sline-' + i).classList.toggle('done', i < n);
  }

  if (n === 1) initBookingCalendar();

  if (n === 2) {
    const dateStr = state.booking.date ? state.booking.date.toDateString() : '';
    buildTimeGrid('time-grid', dateStr, state.booking.time, 'selectTime');
  }

  // FIX: restore pre-selected service visual when arriving from a home-page service card
  if (n === 3 && state.booking.service) {
    document.getElementById('svc-' + state.booking.service)?.classList.add('selected');
    document.getElementById('next-3').disabled = false;
  }

  if (n === 4) updateSummary();
}

function resetBooking() {
  state.booking = {
    step: 1, date: null, time: null, service: null,
    name: '', phone: '', email: '', lateFee: false, totalPrice: 0
  };
}

function startBookingWithService(svc) {
  resetBooking();
  showPage('booking');
  state.booking.service = svc;
}

function openTermsGate() {
  const name  = document.getElementById('inp-name').value.trim();
  const phone = document.getElementById('inp-phone').value.trim();
  const email = document.getElementById('inp-email').value.trim();

  if (!name || !phone || !email) {
    toast('Please fill in all required fields.', 'error', '⚠️'); return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('Please enter a valid email address.', 'error', '⚠️'); return;
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 9 || cleanPhone.length > 13) {
    toast('Please enter a valid phone number.', 'error', '⚠️'); return;
  }

  state.booking.name  = name;
  state.booking.phone = phone;
  state.booking.email = email;

  document.getElementById('terms-checkbox').checked = false;
  document.getElementById('terms-accept-btn').disabled = true;
  openModal('terms-modal');
}

function toggleTermsAcceptBtn() {
  document.getElementById('terms-accept-btn').disabled =
    !document.getElementById('terms-checkbox').checked;
}

function declineTerms() {
  closeModal('terms-modal');
  toast('You must accept the Terms & Conditions to book.', 'default', 'ℹ️');
}

function acceptTermsAndBook() {
  if (!document.getElementById('terms-checkbox').checked) return;
  closeModal('terms-modal');
  confirmBooking();
}

function setBookingBusy(busy) {
  const n4 = document.getElementById('next-4');
  if (n4) { n4.disabled = busy; n4.textContent = busy ? 'Booking…' : 'Confirm Booking ✓'; }
}

async function confirmBooking() {
  if (_bookingInFlight) return;
  const b = state.booking;
  if (!b.date || !b.time || !b.service) { toast('Please complete all steps.', 'error', '⚠️'); return; }

  const dateKey = dateToKey(b.date);
  if (!isSlotAvailable(dateKey, b.time)) {
    toast('That slot is no longer available — please pick another.', 'error', '⚠️');
    b.time = null; b.lateFee = false; goStep(2); return;
  }

  const id      = generateId();
  const lateFee = isLateSlot(b.time);
  const booking = {
    id, name: b.name, phone: b.phone, email: b.email,
    date:       formatDate(b.date),
    dateStr:    b.date.toDateString(),
    dateKey,
    time:       b.time,
    service:    getServiceLabel(b.service),
    serviceKey: b.service,
    lateFee,
    totalPrice: getServicePrice(b.service) + (lateFee ? LATE_FEE : 0),
    status:     'pending',
    createdAt:  Date.now(),
    termsAccepted:   true,
    termsAcceptedAt: Date.now(),
    termsVersion:    TERMS_VERSION
  };

  _bookingInFlight = true; setBookingBusy(true);
  try {
    await createBookingWithLock(booking);
  } catch (err) {
    if (err.message === 'SLOT_TAKEN') {
      toast('Sorry — that slot was just taken. Please pick another.', 'error', '⚠️');
      b.time = null; b.lateFee = false; goStep(2);
    } else {
      console.error('Booking failed', err);
      toast('Could not save your booking. Check your connection and try again.', 'error', '⚠️');
    }
    return;
  } finally {
    _bookingInFlight = false; setBookingBusy(false);
  }

  addMyId(id);
  b.totalPrice = booking.totalPrice;

  document.getElementById('confirm-id').textContent = id;
  document.getElementById('confirm-summary').innerHTML = `
    <div class="summary-row"><span>👤 Name</span><span>${esc(booking.name)}</span></div>
    <div class="summary-row"><span>📞 Phone</span><span>${esc(booking.phone)}</span></div>
    <div class="summary-row"><span>📅 Date</span><span>${esc(booking.date)}</span></div>
    <div class="summary-row"><span>🕐 Time</span><span>${esc(booking.time)}</span></div>
    <div class="summary-row"><span>✂️ Service</span><span>${esc(booking.service)}</span></div>
    ${lateFee ? `<div class="summary-row"><span>🌙 Late Fee</span><span>+R${LATE_FEE}</span></div>` : ''}
    <div class="summary-row total"><span>Total</span><span>R${booking.totalPrice}</span></div>
  `;

  const waAdminMsg  = waEnc(buildNewBookingMsg(booking));
  const waClientMsg = waEnc(buildCustomerConfirmMsg(booking));
  const clientWaNum = formatWANumber(booking.phone);

  document.getElementById('confirm-wa-buttons').innerHTML = `
    <button class="btn-wa btn-wa-confirm"
      style="width:100%;justify-content:center;margin-bottom:8px;padding:12px 16px;font-size:0.8rem;"
      onclick="window.open('https://wa.me/${ADMIN_WA}?text=${waAdminMsg}','_blank','noopener')">
      📲 Notify Barber via WhatsApp
    </button>
    <button class="btn-wa btn-wa-reschedule"
      style="width:100%;justify-content:center;padding:12px 16px;font-size:0.8rem;"
      onclick="window.open('https://wa.me/${clientWaNum}?text=${waClientMsg}','_blank','noopener')">
      💬 Send Booking Details to Myself
    </button>
  `;

  _lastBooking = booking;
  document.getElementById('confirm-wa-buttons').insertAdjacentHTML('afterbegin',
    `<button class="btn-gold" style="width:100%;justify-content:center;margin-bottom:8px" onclick="addToCalendar('${safeId(id)}')">📅 Add to Calendar</button>
     <button class="btn-outline" style="width:100%;margin-bottom:14px" onclick="addToGoogleCalendar('${safeId(id)}')">Open in Google Calendar</button>`);

  goStep(5);
  toast('Booking confirmed! 🎉', 'success', '✅');
}


// ══════════════════════════════════════
// MY BOOKINGS
// Bookings made on this device show automatically. On another device the
// customer enters the email they booked with (looked up through a hashed email index).
// ══════════════════════════════════════
function renderMyBookings() {
  const container = document.getElementById('bookings-results');
  if (!container) return;
  const list = Object.values(_myBookings).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  container.innerHTML = list.length
    ? list.map(buildBookingCard).join('')
    : `<div class="empty-state"><div class="icon">📭</div>No bookings saved on this device yet.<br>Enter the email you booked with above to find them.</div>`;
}

async function lookupBookings() {
  const email = (document.getElementById('lookup-email').value || '').trim().toLowerCase();
  if (!email) { renderMyBookings(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Please enter a valid email address.', 'error', '⚠️'); return; }
  try {
    await ensureAuth();
    const idx = (await _db.ref('pb_by_email/' + await emailHash(email)).once('value')).val() || {};
    const ids = Object.keys(idx).filter(id => /^PB[A-Z0-9]+$/.test(id)).slice(0, 50);
    const found = [];
    for (const id of ids) {
      const b = cleanBooking((await _db.ref('pb_bookings/' + id).once('value')).val());
      if (b && b.email.toLowerCase() === email) { _myBookings[id] = b; found.push(id); }
    }
    if (!found.length) { toast('No bookings found for that email.', 'error', '⚠️'); return; }
    found.forEach(addMyId);
    renderMyBookings();
  } catch (e) {
    console.error(e);
    toast('Lookup failed. Please try again.', 'error', '⚠️');
  }
}

function buildBookingCard(b) {
  const isActive = effectiveStatus(b) !== 'cancelled' && parseDateTimeMs(b.dateStr, b.time) > Date.now();
  const id = safeId(b.id);
  const st = effectiveStatus(b);

  const actions = isActive ? `
    <button class="btn-sm btn-sm-reschedule" onclick="addToCalendar('${id}')">📅 Calendar</button>
    <button class="btn-sm btn-sm-reschedule" onclick="openReschedule('${id}')">🔁 Reschedule</button>
    <button class="btn-sm btn-sm-cancel"     onclick="openCancel('${id}')">✕ Cancel</button>
  ` : '';

  return `<div class="booking-card" id="bc-${id}">
    <div class="bc-header">
      <div>
        <div class="bc-id">ID: ${esc(b.id)}</div>
        <div class="bc-name">${esc(b.name)}</div>
      </div>
      ${statusBadge(b)}
    </div>
    <div class="bc-details">
      <div class="bc-detail">📅 <strong>${esc(b.date)}</strong></div>
      <div class="bc-detail">🕐 <strong>${esc(b.time)}</strong></div>
      <div class="bc-detail">✂️ <strong>${esc(b.service)}</strong></div>
      <div class="bc-detail">📧 <strong>${esc(b.email)}</strong></div>
    </div>
    <div class="bc-price">Total: R${b.totalPrice}</div>
    ${actions ? `<div class="bc-actions">${actions}</div>` : ''}
  </div>`;
}

// Works with a "YYYY-MM-DD" key or a legacy toDateString(); always South African time.
function parseDateTimeMs(dateStr, time) {
  return slotMs(normalizeDateStr(dateStr), time);
}


// ══════════════════════════════════════
// CANCEL
// ══════════════════════════════════════
function openCancel(id) {
  const b = findBooking(id);
  if (!b) { toast('Booking not found.', 'error', '⚠️'); return; }
  state.cancelTarget = id;
  document.getElementById('cancel-warning-text').textContent =
    `Are you sure you want to cancel your ${b.service} on ${b.date} at ${b.time}?`;
  const fw = document.getElementById('cancel-fee-warning'); if (fw) fw.style.display = 'none';
  openModal('cancel-modal');
}

async function proceedCancel() {
  const b = findBooking(state.cancelTarget);
  if (!b) { closeModal('cancel-modal'); return; }
  try {
    await ensureAuth();
    await updateBooking(b.id, { status: 'cancelled', cancelledAt: Date.now() });
    await releaseLock(bookingKey(b), b.time, b.id);
    toast('Booking cancelled successfully.', 'default', '✓');
  } catch (e) {
    console.error(e);
    toast('Could not cancel — please try again or message us on WhatsApp.', 'error', '⚠️');
  }
  closeModal('cancel-modal');
  renderMyBookings();
}


// ══════════════════════════════════════
// RESCHEDULE
// ══════════════════════════════════════
function openReschedule(id) {
  const b = findBooking(id);
  if (!b) { toast('Booking not found.', 'error', '⚠️'); return; }
  state.reschedule.bookingId = id;
  state.reschedule.date      = null;
  state.reschedule.time      = null;
  const now = new Date();
  state.reschedule.calYear  = now.getFullYear();
  state.reschedule.calMonth = now.getMonth();
  renderRescheduleCalendar();
  document.getElementById('reschedule-time-grid').innerHTML = '';
  openModal('reschedule-modal');
}

function navRescheduleCal(dir) {
  state.reschedule.calMonth += dir;
  if (state.reschedule.calMonth > 11) { state.reschedule.calMonth = 0;  state.reschedule.calYear++; }
  if (state.reschedule.calMonth < 0)  { state.reschedule.calMonth = 11; state.reschedule.calYear--; }
  renderRescheduleCalendar();
}

function renderRescheduleCalendar() {
  buildCalendar('reschedule-calendar', state.reschedule.calYear, state.reschedule.calMonth, state.reschedule.date, {
    nav: 'navRescheduleCal', click: 'selectRescheduleDate'
  });
}

function selectRescheduleDate(y, m, d) {
  state.reschedule.date = new Date(y, m, d);
  state.reschedule.time = null;
  renderRescheduleCalendar();
  buildTimeGrid('reschedule-time-grid', state.reschedule.date.toDateString(), null, 'selectRescheduleTime');
}

function selectRescheduleTime(slot) {
  state.reschedule.time = slot;
  const dateStr = state.reschedule.date ? state.reschedule.date.toDateString() : '';
  buildTimeGrid('reschedule-time-grid', dateStr, slot, 'selectRescheduleTime');
}

async function confirmReschedule() {
  const r = state.reschedule;
  if (!r.date || !r.time) { toast('Please select a new date and time.', 'error', '⚠️'); return; }
  const b = findBooking(r.bookingId);
  if (!b) return;

  const newKey = dateToKey(r.date), oldKey = bookingKey(b);
  if (newKey === oldKey && r.time === b.time) { toast('That is already your current slot.', 'default', 'ℹ️'); return; }
  if (!isSlotAvailable(newKey, r.time)) {
    toast('That slot is no longer available — please pick another.', 'error', '⚠️');
    r.time = null;
    buildTimeGrid('reschedule-time-grid', r.date, null, 'selectRescheduleTime');
    return;
  }

  const lateFee = isLateSlot(r.time);
  const patch = {
    dateStr: r.date.toDateString(), dateKey: newKey, date: formatDate(r.date), time: r.time,
    lateFee, totalPrice: getServicePrice(b.serviceKey) + (lateFee ? LATE_FEE : 0),
    status: 'pending'
  };
  const newLock = _db.ref(`pb_slots/${newKey}/${r.time.replace(':', '')}`);

  try {
    await ensureAuth();
    const res = await newLock.transaction(cur => cur === null ? b.id : undefined);
    if (!res.committed) {
      toast('Sorry — that slot was just taken. Please pick another.', 'error', '⚠️');
      r.time = null;
      buildTimeGrid('reschedule-time-grid', r.date, null, 'selectRescheduleTime');
      return;
    }
    try { await updateBooking(b.id, patch); }
    catch (e) { await newLock.remove().catch(() => {}); throw e; }
    await releaseLock(oldKey, b.time, b.id);        // free the old slot only after the move succeeded
    toast('Booking rescheduled! ✓', 'success', '🔁');
    closeModal('reschedule-modal');
    renderMyBookings();
  } catch (e) {
    console.error(e);
    toast('Could not reschedule — please try again.', 'error', '⚠️');
  }
}

// ══════════════════════════════════════
// MANUAL / WALK-IN BOOKING (admin-side)
// ══════════════════════════════════════
function openManualBooking() {
  const now = new Date();
  state.manualBooking = {
    date: null, time: null, service: null,
    calYear: now.getFullYear(), calMonth: now.getMonth()
  };
  document.getElementById('manual-inp-name').value = '';
  document.getElementById('manual-inp-phone').value = '';
  document.getElementById('manual-inp-email').value = '';
  document.querySelectorAll('#manual-service-options .service-option').forEach(el => el.classList.remove('selected'));
  document.getElementById('manual-time-grid').innerHTML =
    '<div style="color:var(--white3);font-size:0.8rem;padding:10px 0">Select a date first</div>';
  renderManualCalendar();
  openModal('manual-booking-modal');
}

function navManualCal(dir) {
  state.manualBooking.calMonth += dir;
  if (state.manualBooking.calMonth > 11) { state.manualBooking.calMonth = 0;  state.manualBooking.calYear++; }
  if (state.manualBooking.calMonth < 0)  { state.manualBooking.calMonth = 11; state.manualBooking.calYear--; }
  renderManualCalendar();
}

function renderManualCalendar() {
  buildCalendar('manual-calendar', state.manualBooking.calYear, state.manualBooking.calMonth, state.manualBooking.date, {
    nav: 'navManualCal', click: 'selectManualDate'
  });
}

function selectManualDate(y, m, d) {
  state.manualBooking.date = new Date(y, m, d);
  state.manualBooking.time = null;
  renderManualCalendar();
  buildTimeGrid('manual-time-grid', state.manualBooking.date.toDateString(), null, 'selectManualTime', { ignoreNotice: true });
}

function selectManualTime(slot) {
  state.manualBooking.time = slot;
  const dateStr = state.manualBooking.date ? state.manualBooking.date.toDateString() : '';
  buildTimeGrid('manual-time-grid', dateStr, slot, 'selectManualTime', { ignoreNotice: true });
}

function selectManualService(svc) {
  state.manualBooking.service = svc;
  document.querySelectorAll('#manual-service-options .service-option').forEach(el => el.classList.remove('selected'));
  document.getElementById('manual-svc-' + svc).classList.add('selected');
}

async function confirmManualBooking() {
  const mb    = state.manualBooking;
  const name  = document.getElementById('manual-inp-name').value.trim();
  const phone = document.getElementById('manual-inp-phone').value.trim();
  const email = document.getElementById('manual-inp-email').value.trim();

  if (!mb.date)    { toast('Please select a date.', 'error', '⚠️'); return; }
  if (!mb.time)    { toast('Please select a time slot.', 'error', '⚠️'); return; }
  if (!mb.service) { toast('Please select a service.', 'error', '⚠️'); return; }
  if (!name)       { toast("Please enter the client's name.", 'error', '⚠️'); return; }
  if (!phone)      { toast('Please enter a phone number.', 'error', '⚠️'); return; }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 9 || cleanPhone.length > 13) {
    toast('Please enter a valid phone number.', 'error', '⚠️'); return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('Please enter a valid email address.', 'error', '⚠️'); return;
  }

  const dateKey = dateToKey(mb.date);
  if (!isSlotAvailable(dateKey, mb.time, { ignoreNotice: true })) {
    toast('That slot is no longer available — please pick another.', 'error', '⚠️');
    mb.time = null;
    buildTimeGrid('manual-time-grid', mb.date, null, 'selectManualTime', { ignoreNotice: true });
    return;
  }

  const lateFee    = isLateSlot(mb.time);
  const totalPrice = getServicePrice(mb.service) + (lateFee ? LATE_FEE : 0);
  const id         = generateId();

  const booking = {
    id, name, phone,
    email:      email || `no-email-${id.toLowerCase()}@privatebarber.local`,
    date:       formatDate(mb.date),
    dateStr:    mb.date.toDateString(),
    dateKey,
    time:       mb.time,
    service:    getServiceLabel(mb.service),
    serviceKey: mb.service,
    lateFee,
    totalPrice,
    status:     'confirmed',
    createdAt:  Date.now(),
    manualEntry: true
  };

  try {
    await createBookingWithLock(booking);
  } catch (err) {
    if (err.message === 'SLOT_TAKEN') {
      toast('That slot was just taken — please pick another.', 'error', '⚠️');
      mb.time = null;
      buildTimeGrid('manual-time-grid', mb.date, null, 'selectManualTime', { ignoreNotice: true });
    } else {
      console.error(err);
      toast('Could not save booking: ' + (err.code || err.message), 'error', '⚠️');
    }
    return;
  }

  toast(`Booking added for ${name}.`, 'success', '✅');
  closeModal('manual-booking-modal');
}


// ══════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});


// ══════════════════════════════════════
// ADMIN
// ══════════════════════════════════════
function showAdminLoginForm() {
  document.getElementById('admin-login-panel').style.display = 'block';
  document.getElementById('admin-dashboard').style.display   = 'none';
}

function showAdminDashboard() {
  document.getElementById('admin-login-panel').style.display = 'none';
  document.getElementById('admin-dashboard').style.display   = 'block';
  renderAdminDashboard();
  renderAvailabilityCalendar();
}

function initAdminPage() {
  // onAuthStateChanged watcher handles show/hide; just make sure the numbers are current
  if (adminLoggedIn) renderAdminDashboard();
}

async function adminLogin() {
  const email    = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value;
  if (!email || !password) { toast('Please enter your email and password.', 'error'); return; }
  try {
    await window._auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    toast('Incorrect email or password.', 'error');
    console.error(err);
  }
}

async function adminLogout() {
  try {
    await window._auth.signOut();
    toast('Logged out successfully.', 'success');
    showPage('home');
  } catch (err) {
    toast('Logout failed. Try again.', 'error');
    console.error(err);
  }
}

function startAuthWatcher() {
  _auth.onAuthStateChanged(user => {
    adminLoggedIn = !!user && !user.isAnonymous;      // customers are signed in anonymously
    unwatchAllMine();

    if (adminLoggedIn) { startAdminSync(); startDebtSync(); showAdminDashboard(); }
    else               { stopAdminSync();  stopDebtSync();  showAdminLoginForm(); }

    if (user) getMyIds().forEach(watchMyBooking);
    else _auth.signInAnonymously().catch(err => console.warn('Anonymous sign-in failed', err));

    updateConnectionBadge(_fbConnected);
  });
}

function renderAdminDashboard() {
  if (!adminLoggedIn) return;
  const bookings = getBookings();
  const now      = Date.now();
  const todayStr = normalizeDateStr(new Date().toDateString());

  const total      = bookings.length;
  const pending    = bookings.filter(b => b.status === 'pending').length;
  const todayCount = bookings.filter(b => normalizeDateStr(b.dateStr) === todayStr && b.status !== 'cancelled').length;

  // Split revenue: completed (appointment time already passed) vs upcoming (still to happen)
  const nonCancelled   = bookings.filter(b => b.status !== 'cancelled');
  const revenueDone    = nonCancelled
    .filter(b => b.cutStatus === 'done')
    .reduce((s, b) => s + b.totalPrice, 0);
  const revenueUpcoming = nonCancelled
    .filter(b => parseDateTimeMs(b.dateStr, b.time) > now)
    .reduce((s, b) => s + b.totalPrice, 0);

  document.getElementById('admin-stats').innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">Total Bookings</div></div>
    <div class="stat-card"><div class="stat-num">${todayCount}</div><div class="stat-label">Today's Appointments</div></div>
    <div class="stat-card"><div class="stat-num">${pending}</div><div class="stat-label">Pending</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:1.6rem">R${revenueDone}</div><div class="stat-label">Revenue (Completed)</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:1.6rem">R${revenueUpcoming}</div><div class="stat-label">Revenue (Upcoming)</div></div>
  `;

  renderAdminBookings();
}

if (document.getElementById('availability-calendar')) renderAvailabilityCalendar();

function adminFilter(f) {
  state.adminFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  const fb = document.getElementById('af-' + f); if (fb) fb.classList.add('active');
  renderAdminBookings();
}

// Two buttons on today's and earlier bookings: "I'm done cutting" and "Client didn't come" (reopens the slot)
function adminCutRow(b) {
  if (b.status === 'cancelled' || bookingKey(b) > dateToKey(new Date())) return '';
  const id   = safeId(b.id);
  const done = b.cutStatus === 'done';
  const doneBtn = `<button class="btn-wa btn-wa-confirm" style="${done ? 'box-shadow:0 0 0 2px var(--gold);' : ''}" onclick="setCutStatus('${id}','done')">${done ? '● ' : ''}✅ I’m done cutting</button>`;
  const noBtn   = done ? '' : `<button class="btn-wa btn-wa-cancel" onclick="setCutStatus('${id}','noshow')">🚫 Client didn’t come</button>`;
  return `<div class="abc-actions" style="margin-top:8px">${doneBtn}${noBtn}</div>`;
}

function renderAdminBookings() {
  if (!adminLoggedIn) return;
  let bookings = getBookings();
  if (state.adminFilter === 'notdone') {
    bookings = bookings.filter(b => b.status !== 'cancelled' && bookingMs(b) <= Date.now() && b.cutStatus !== 'done');
  } else if (state.adminFilter !== 'all') {
    bookings = bookings.filter(b => b.status === state.adminFilter);
  }

  const searchInput = document.getElementById('admin-search');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (query) {
    bookings = bookings.filter(b =>
      b.name.toLowerCase().includes(query) ||
      b.phone.replace(/\D/g, '').includes(query.replace(/\D/g, '')) ||
      b.id.toLowerCase().includes(query)
    );
  }

  bookings.sort((a, b) => parseDateTimeMs(b.dateStr, b.time) - parseDateTimeMs(a.dateStr, a.time));

  const container = document.getElementById('admin-bookings-list');
  if (bookings.length === 0) {
    container.innerHTML = query
      ? `<div class="empty-state"><div class="icon">🔍</div>No bookings match "${esc(searchInput.value)}".</div>`
      : `<div class="empty-state"><div class="icon">📋</div>No bookings found.</div>`;
    return;
  }

  container.innerHTML = bookings.map(b => {
    const id         = safeId(b.id);
    const clientNum  = formatWANumber(b.phone);
    const confirmMsg = encodeURIComponent(buildAdminConfirmMsg(b));
    const cancelMsg  = encodeURIComponent(buildAdminCancelMsg(b));
    const reschedMsg = encodeURIComponent(buildAdminReschedMsg(b));
    const isFuture   = parseDateTimeMs(b.dateStr, b.time) > Date.now();

    const actionBtns = (b.status !== 'cancelled' && isFuture) ? `
      <a class="btn-wa btn-wa-confirm"
         href="https://wa.me/${clientNum}?text=${confirmMsg}" target="_blank" rel="noopener noreferrer"
         onclick="return adminAction('${id}','confirmed')">✅ Confirm</a>
      <a class="btn-wa btn-wa-reschedule"
         href="https://wa.me/${clientNum}?text=${reschedMsg}" target="_blank" rel="noopener noreferrer">🔁 Reschedule</a>
      <a class="btn-wa btn-wa-cancel"
         href="https://wa.me/${clientNum}?text=${cancelMsg}" target="_blank" rel="noopener noreferrer"
         onclick="return adminAction('${id}','cancelled')">❌ Cancel</a>`
    : `<span style="font-size:0.72rem;color:var(--white3);padding:4px 0">${b.status === 'cancelled' ? '🚫 Cancelled' : '⏰ Past appointment'}</span>`;

    return `<div class="admin-booking-card" id="abc-${id}">
      <div class="abc-top">
        <div>
          <div class="abc-name">${esc(b.name)}</div>
          <div class="abc-phone">
            📞 <a href="https://wa.me/${clientNum}" target="_blank" rel="noopener noreferrer"
                  style="color:var(--gold);text-decoration:none;">${esc(b.phone)}</a>
            &nbsp;·&nbsp; 📧 ${esc(b.email)}
          </div>
        </div>
        ${statusBadge(b, true)}
      </div>
      <div class="abc-info">
        <span>📅 <strong>${esc(b.date)}</strong></span>
        <span>🕐 <strong>${esc(b.time)}</strong></span>
        <span>✂️ <strong>${esc(b.service)}</strong></span>
        <span>💰 <strong>R${b.totalPrice}</strong></span>
        <span>🔖 <strong>${esc(b.id)}</strong></span>
      </div>
      ${debtBanner(b)}
      <div class="abc-actions">${actionBtns}</div>${adminCutRow(b)}${adminDebtRow(b)}
    </div>`;
  }).join('');
}

// Called from the WhatsApp buttons. Cancelling asks first; returning false stops the link opening.
function adminAction(id, status) {
  if (status === 'cancelled' && !confirm('Cancel this booking? The time slot will be freed.')) return false;
  setTimeout(() => saveBookingStatus(id, status), 300);
  return true;
}
function adminUpdateStatus(id, status) { saveBookingStatus(id, status); }

function adminMsgToday() {
  const todayKey = dateToKey(new Date());
  const todayBookings = getBookings()
    .filter(b => bookingKey(b) === todayKey && b.status !== 'cancelled')
    .sort((a, b) => a.time.localeCompare(b.time));
  if (todayBookings.length === 0) { toast('No appointments today.', 'default', '📅'); return; }

  const messages = todayBookings.map(b => {
    const msg = `Hello ${b.name} 👋, this is *PRIVATE BARBER 💈*!\n\n` +
      `Just a reminder that your appointment is *TODAY* 🎉\n` +
      `🕐 *Time:* ${b.time}\n✂️ *Service:* ${b.service}\n\nSee you soon! 💈`;
    return { booking: b, msg };
  });

  showBulkWhatsAppModal(`Today's Clients (${messages.length})`, messages);
}

function adminRemindUpcoming() {
  const now = Date.now();
  const upcoming = getBookings()
    .filter(b => parseDateTimeMs(b.dateStr, b.time) > now && b.status !== 'cancelled')
    .sort((a, b) => parseDateTimeMs(a.dateStr, a.time) - parseDateTimeMs(b.dateStr, b.time));
  if (upcoming.length === 0) { toast('No upcoming appointments.', 'default', '📅'); return; }

  const messages = upcoming.map(b => {
    const msg = `Hello ${b.name} 👋, this is *PRIVATE BARBER 💈*!\n\n` +
      `🔔 Friendly reminder of your upcoming appointment:\n` +
      `📅 *Date:* ${b.date}\n🕐 *Time:* ${b.time}\n✂️ *Service:* ${b.service}\n\n` +
      `See you then! If anything changes please let us know. 💈`;
    return { booking: b, msg };
  });

  showBulkWhatsAppModal(`Upcoming Clients (${messages.length})`, messages);
}

// ══════════════════════════════════════
// BULK WHATSAPP MODAL
// (browsers block auto-opened popups after the first one in a loop,
// so each message needs its own user click to open reliably)
// ══════════════════════════════════════
function showBulkWhatsAppModal(title, messages) {
  let overlay = document.getElementById('bulk-wa-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'bulk-wa-modal';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <button class="modal-close" onclick="closeModal('bulk-wa-modal')">✕</button>
        <div class="modal-title" id="bulk-wa-title"></div>
        <div class="modal-sub">Click each button below to send — browsers block auto-sending multiple messages at once.</div>
        <div id="bulk-wa-list" style="display:flex;flex-direction:column;gap:10px;margin-top:16px"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  }

  document.getElementById('bulk-wa-title').textContent = title;
  document.getElementById('bulk-wa-list').innerHTML = messages.map(({ booking, msg }) => {
    const num = formatWANumber(booking.phone);
    const encoded = encodeURIComponent(msg);
    return `
      <a class="btn-wa btn-wa-confirm" style="justify-content:space-between"
         href="https://wa.me/${num}?text=${encoded}" target="_blank" rel="noopener noreferrer">
        <span>📲 ${esc(booking.name)} — ${esc(booking.time)}</span>
        <span>Send →</span>
      </a>`;
  }).join('');

  openModal('bulk-wa-modal');
}


// ══════════════════════════════════════
// LIVE ADMIN SYNC
// ══════════════════════════════════════
const liveAlerts = [];

function pushLiveAlert(booking) {
  liveAlerts.unshift(booking);
  if (adminLoggedIn && state.currentPage === 'admin') {
    renderLiveAlerts();
    renderAdminDashboard();
    document.querySelectorAll('.stat-card').forEach(c => {
      c.classList.remove('flash');
      void c.offsetWidth; // reflow to restart animation
      c.classList.add('flash');
    });
  }
}

function renderLiveAlerts() {
  const container = document.getElementById('admin-live-alerts');
  if (!container || liveAlerts.length === 0) return;
  container.innerHTML = liveAlerts.map((b, idx) => `
    <div class="live-booking-alert" id="lba-${idx}">
      <div class="live-dot"></div>
      <div class="lba-icon">🆕</div>
      <div class="lba-body">
        <div class="lba-title">New Booking — ${esc(b.name)}</div>
        <div class="lba-meta">
          ✂️ ${esc(b.service)} &nbsp;·&nbsp; 📅 ${esc(b.date)} at ${esc(b.time)}<br>
          📞 ${esc(b.phone)} &nbsp;·&nbsp; 💰 R${b.totalPrice} &nbsp;·&nbsp; 🔖 ${esc(b.id)}
        </div>
      </div>
      <button class="lba-dismiss" onclick="dismissAlert(${idx})" title="Dismiss">✕</button>
    </div>
  `).join('');
}

function dismissAlert(idx) {
  liveAlerts.splice(idx, 1);
  renderLiveAlerts();
  updateAdminBadge();
}

function clearLiveAlerts() {
  liveAlerts.length = 0;
  const c = document.getElementById('admin-live-alerts');
  if (c) c.innerHTML = '';
  updateAdminBadge();
}

function updateAdminBadge() {
  const badge = document.getElementById('admin-nav-badge');
  if (!badge) return;
  const pendingCount = getBookings().filter(b => b.status === 'pending').length;
  const alertCount   = liveAlerts.length;
  const count = state.currentPage === 'admin' ? alertCount : pendingCount;
  if (count > 0) {
    badge.textContent  = count > 99 ? '99+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

updateAdminBadge();

// ══════════════════════════════════════
// TERMS PAGE NAVIGATION
// (opened from the booking modal → "Back" returns to step 4 with everything still filled in)
// ══════════════════════════════════════
function openTerms(fromBooking) {
  state.termsReturn = fromBooking ? 'booking' : null;
  closeModal('terms-modal');
  showPage('terms');
}
function closeTerms() {
  if (state.termsReturn === 'booking') { state.termsReturn = null; showPage('booking'); goStep(4); }
  else showPage('home');
}

// ══════════════════════════════════════
// KEYBOARD ACCESSIBILITY
// ══════════════════════════════════════
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"]')) {
    e.preventDefault(); e.target.click();
  }
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(o => o.classList.remove('open'));
});

// ══════════════════════════════════════
// NOTICE BOARD
// The admin writes notices in the Admin page; they appear on the home page and booking page.
// ══════════════════════════════════════
function noticeList() {
  return Object.entries(_notices)
    .filter(([id, n]) => n && typeof n.text === 'string' && n.text.trim())
    .map(([id, n]) => ({ id, text: n.text, createdAt: Number(n.createdAt) || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function noticeDate(ms) {
  return new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderNotices() {
  const list = noticeList();

  const card = n => `<div style="border:1px solid rgba(201,168,76,0.35);border-left:3px solid var(--gold);border-radius:10px;padding:14px 18px;margin-bottom:10px;background:rgba(201,168,76,0.05)">
      <div style="font-size:0.68rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--gold);margin-bottom:6px">📢 ${esc(noticeDate(n.createdAt))}</div>
      <div style="white-space:pre-wrap;line-height:1.7;color:var(--white2);font-size:0.9rem">${esc(n.text)}</div>
    </div>`;

  const home = document.getElementById('notice-board-home');
  if (home) {
    home.innerHTML = list.length
      ? `<div style="max-width:720px;margin:40px auto 0;padding:0 5%">
           <div class="section-label" style="margin-bottom:14px">Notice Board</div>
           ${list.slice(0, 5).map(card).join('')}
         </div>`
      : '';
  }

  const booking = document.getElementById('notice-board-booking');
  if (booking) {
    booking.innerHTML = list.length
      ? `<div style="margin-bottom:20px">${list.slice(0, 2).map(card).join('')}</div>`
      : '';
  }

  const admin = document.getElementById('admin-notices-list');
  if (admin) {
    admin.innerHTML = list.length
      ? list.map(n => `<div style="display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:12px 0;border-top:1px solid rgba(255,255,255,0.08)">
            <div style="min-width:0">
              <div style="font-size:0.7rem;color:var(--white3);margin-bottom:4px">${esc(noticeDate(n.createdAt))}</div>
              <div style="white-space:pre-wrap;line-height:1.6;font-size:0.85rem;word-break:break-word">${esc(n.text)}</div>
            </div>
            <button class="btn-sm btn-sm-cancel" onclick="removeNotice('${safeId(n.id)}')">✕ Remove</button>
          </div>`).join('')
      : `<div style="font-size:0.82rem;color:var(--white3)">No notices posted. Clients see nothing until you post one.</div>`;
  }
}

async function postNotice() {
  const input = document.getElementById('notice-input');
  const text  = (input ? input.value : '').trim();
  if (!adminLoggedIn || !_db) { toast('Please sign in as admin first.', 'error', '⚠️'); return; }
  if (!text)                  { toast('Write your notice first.', 'error', '⚠️'); return; }
  if (text.length > 400)      { toast('Please keep notices under 400 characters.', 'error', '⚠️'); return; }
  try {
    await _db.ref('pb_notices').push({ text, createdAt: Date.now() });
    input.value = '';
    toast('Notice posted — clients can see it now.', 'success', '📢');
  } catch (e) {
    console.error(e);
    toast('Could not post: ' + (e.code || e.message), 'error', '⚠️');
  }
}

async function removeNotice(id) {
  if (!adminLoggedIn || !_db) return;
  if (!confirm('Remove this notice from the client side?')) return;
  try {
    await _db.ref('pb_notices/' + id).remove();
    toast('Notice removed.', 'default', '✓');
  } catch (e) {
    console.error(e);
    toast('Could not remove: ' + (e.code || e.message), 'error', '⚠️');
  }
}

// ══════════════════════════════════════
// ADD TO CALENDAR
// Downloads an .ics file (iPhone, Android, Outlook, Apple Calendar) with reminders 1 day and 2 hours before,
// or opens a pre-filled Google Calendar event.
// ══════════════════════════════════════
const SHOP_ADDRESS = '924 Mosidisi St, Ikageng, Potchefstroom, 2539, South Africa';

function calendarBooking(id) {
  const b = findBooking(id) || (_lastBooking && _lastBooking.id === id ? cleanBooking(_lastBooking) : null);
  if (!b) { toast('Booking not found.', 'error', '⚠️'); return null; }
  return b;
}
function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }   // 20261110T080000Z
function icsText(t)   { return String(t).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
function icsFold(line) {                                  // lines must be ≤75 bytes; continue on the next line with a space
  const out = []; let rest = line;
  while (rest.length > 60) { out.push(rest.slice(0, 60)); rest = ' ' + rest.slice(60); }
  out.push(rest);
  return out.join('\r\n');
}
function calendarDetails(b) {
  return `${b.service} — R${b.totalPrice}\nBooking ID: ${b.id}\nPlease arrive 15–20 minutes before your appointment.\nPrivate Barber, ${SHOP_ADDRESS}`;
}
function buildIcs(b) {
  const start = bookingMs(b), end = start + 60 * 60000;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Private Barber//Booking//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@private-barber`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText('Haircut at Private Barber')}`,
    `LOCATION:${icsText(SHOP_ADDRESS)}`,
    `DESCRIPTION:${icsText(calendarDetails(b))}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Haircut tomorrow at ' + b.time)}`, 'TRIGGER:-P1D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText('Haircut in 2 hours (' + b.time + ')')}`, 'TRIGGER:-PT2H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
function addToCalendar(id) {
  const b = calendarBooking(id); if (!b) return;
  const blob = new Blob([buildIcs(b)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'private-barber-appointment.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Open the downloaded file to add it to your calendar.', 'success', '📅');
}
function googleCalendarUrl(b) {
  const start = bookingMs(b), end = start + 60 * 60000;
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text='     + encodeURIComponent('Haircut at Private Barber')
    + '&dates='    + icsStamp(start) + '/' + icsStamp(end)
    + '&details='  + encodeURIComponent(calendarDetails(b))
    + '&location=' + encodeURIComponent(SHOP_ADDRESS);
}
function addToGoogleCalendar(id) {
  const b = calendarBooking(id); if (!b) return;
  window.open(googleCalendarUrl(b), '_blank', 'noopener');
}

// ══════════════════════════════════════
// MONEY OWED  (admin only — clients never see this)
// Matched by email. When a client who owes books again, their booking card shows a red "Owes R__" banner.
// ══════════════════════════════════════
function debtFor(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return Object.values(_debts).find(d => d && String(d.email).toLowerCase() === e) || null;
}

function startDebtSync(attempt = 0) {
  if (!_db || _debtsRef) return;
  const ref = _db.ref('pb_debts');
  _debtsRef = ref;
  ref.on('value', snap => {
    _debts = snap.val() || {};
    _debtsLoaded = true;
    renderDebts();
    if (adminLoggedIn && state.currentPage === 'admin') renderAdminBookings();
  }, err => {
    console.warn('Money-owed read failed (attempt ' + (attempt + 1) + ')', err.code || err);
    ref.off();
    if (_debtsRef === ref) _debtsRef = null;
    if (adminLoggedIn && attempt < 4) setTimeout(() => startDebtSync(attempt + 1), 1000 * (attempt + 1));
  });
}
function stopDebtSync() {
  if (_debtsRef) { _debtsRef.off(); _debtsRef = null; }
  _debts = {}; _debtsLoaded = false;
  const l = document.getElementById('debt-list'); if (l) l.innerHTML = '';
}

function debtBanner(b) {
  if (!isRealEmail(b.email)) return `<div style="margin:10px 0 2px;font-size:0.74rem;color:var(--white3)">No email saved — can’t track money owed</div>`;
  if (!_debtsLoaded)         return `<div style="margin:10px 0 2px;font-size:0.74rem;color:var(--white3)">⏳ Checking money owed…</div>`;
  const d = debtFor(b.email);
  if (!d) return `<div style="margin:10px 0 2px;font-size:0.8rem;color:#6fcf97">✅ Owes nothing</div>`;
  return `<div style="margin:12px 0 4px;padding:10px 14px;border:1px solid #e05252;border-radius:8px;background:rgba(224,82,82,0.08);color:#e07060;font-size:0.84rem">⚠️ <strong>Still owes R${Number(d.amount) || 0}</strong>${d.note ? ' — ' + esc(d.note) : ''}</div>`;
}
function adminDebtRow(b) {
  if (!isRealEmail(b.email)) return '';
  const id = safeId(b.id);
  const owes = !!debtFor(b.email);
  return `<div class="abc-actions" style="margin-top:8px">${owes
    ? `<button class="btn-wa btn-wa-confirm" onclick="debtQuick('${id}')">✅ Mark as paid</button>`
    : `<button class="btn-wa btn-wa-cancel" onclick="debtQuick('${id}')">💸 They owe</button>`}</div>`;
}

function renderDebts() {
  const list  = Object.entries(_debts).filter(([k, d]) => d && d.email).sort((a, b) => (Number(b[1].amount) || 0) - (Number(a[1].amount) || 0));
  const total = list.reduce((n, [k, d]) => n + (Number(d.amount) || 0), 0);
  const t = document.getElementById('debt-total'); if (t) t.textContent = list.length ? `· R${total} owed by ${list.length}` : '';
  const el = document.getElementById('debt-list');
  if (el) {
    el.innerHTML = list.length ? list.map(([k, d]) => `<div style="display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:12px 0;border-top:1px solid rgba(255,255,255,0.08)">
        <div style="min-width:0">
          <div style="font-size:0.88rem;word-break:break-all">${esc(d.email)}</div>
          <div style="font-size:0.8rem;color:#e07060;margin-top:2px"><strong>R${Number(d.amount) || 0}</strong>${d.note ? ' — ' + esc(d.note) : ''}</div>
          <div style="font-size:0.7rem;color:var(--white3);margin-top:2px">since ${esc(noticeDate(Number(d.createdAt) || Number(d.updatedAt) || Date.now()))}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn-sm btn-sm-reschedule" onclick="debtFill('${safeId(k)}')">✎ Edit</button>
          <button class="btn-sm btn-sm-reschedule" onclick="debtPaidKey('${safeId(k)}')">✅ Paid</button>
        </div>
      </div>`).join('')
      : `<div style="font-size:0.82rem;color:var(--white3)">Nobody owes you anything right now.</div>`;
  }
  debtCheck();
}

// Live status under the email box
function debtCheck() {
  const inp = document.getElementById('debt-email'), out = document.getElementById('debt-status');
  if (!inp || !out) return;
  const email = inp.value.trim().toLowerCase();
  if (!email.includes('@')) { out.innerHTML = ''; return; }
  const d = debtFor(email);
  out.innerHTML = d
    ? `⚠️ <strong style="color:#e07060">Owes R${Number(d.amount) || 0}</strong> since ${esc(noticeDate(Number(d.createdAt) || Date.now()))}${d.note ? ' — ' + esc(d.note) : ''}`
    : `<span style="color:#6fcf97">✅ Owes nothing</span>`;
}
function debtFill(key) {
  const d = _debts[key]; if (!d) return;
  document.getElementById('debt-email').value  = d.email;
  document.getElementById('debt-amount').value = d.amount;
  document.getElementById('debt-note').value   = d.note || '';
  debtCheck();
  document.getElementById('debt-email').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function debtWrite(email, amount, note) {
  const key = await emailHash(email);
  const old = _debts[key];
  await _db.ref('pb_debts/' + key).set({
    email, amount, note: String(note || '').slice(0, 120),
    createdAt: old && old.createdAt ? old.createdAt : Date.now(), updatedAt: Date.now()
  });
}

// "They owe" button in the Money Owed box (also updates the amount if they already owe)
async function debtSave() {
  if (!adminLoggedIn || !_db) return;
  const email  = document.getElementById('debt-email').value.trim().toLowerCase();
  const amount = Math.round(Number(document.getElementById('debt-amount').value));
  const note   = document.getElementById('debt-note').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter the client’s email address.', 'error', '⚠️'); return; }
  if (!(amount > 0 && amount <= 100000))          { toast('Enter how much they owe (R).', 'error', '⚠️'); return; }
  try {
    await debtWrite(email, amount, note);
    toast(`${email} owes R${amount}.`, 'success', '💸');
    document.getElementById('debt-amount').value = '';
    document.getElementById('debt-note').value   = '';
  } catch (e) { console.error(e); toast('Could not save: ' + (e.code || e.message), 'error', '⚠️'); }
}

async function debtRemove(email, key) {
  try {
    await _db.ref('pb_debts/' + (key || await emailHash(email))).remove();
    toast(`${email} is paid up ✅`, 'success', '✅');
  } catch (e) { console.error(e); toast('Could not update: ' + (e.code || e.message), 'error', '⚠️'); }
}
// "Paid in full" button in the Money Owed box
async function debtPaid() {
  if (!adminLoggedIn || !_db) return;
  const email = document.getElementById('debt-email').value.trim().toLowerCase();
  if (!email.includes('@')) { toast('Enter the client’s email address.', 'error', '⚠️'); return; }
  const d = debtFor(email);
  if (!d) { toast('That email doesn’t owe anything.', 'default', 'ℹ️'); return; }
  if (!confirm(`Mark ${email} as fully paid (R${d.amount})?`)) return;
  await debtRemove(email);
  document.getElementById('debt-amount').value = ''; document.getElementById('debt-note').value = '';
}
async function debtPaidKey(key) {
  const d = _debts[key]; if (!d || !adminLoggedIn) return;
  if (!confirm(`Mark ${d.email} as fully paid (R${d.amount})?`)) return;
  await debtRemove(d.email, key);
}

// Button on each booking card
async function debtQuick(id) {
  const b = _bookingsCache.find(x => x.id === id);
  if (!b || !adminLoggedIn || !_db) return;
  const d = debtFor(b.email);
  if (d) {
    if (!confirm(`Mark ${b.email} as fully paid (R${d.amount})?`)) return;
    await debtRemove(b.email);
    return;
  }
  const raw = prompt(`How much does ${b.name} owe (R)?`, String(b.totalPrice));
  if (raw === null) return;
  const amount = Math.round(Number(raw));
  if (!(amount > 0 && amount <= 100000)) { toast('Enter a valid amount.', 'error', '⚠️'); return; }
  try {
    await debtWrite(b.email.trim().toLowerCase(), amount, '');
    toast(`${b.name} owes R${amount}.`, 'success', '💸');
  } catch (e) { console.error(e); toast('Could not save: ' + (e.code || e.message), 'error', '⚠️'); }
}

// Start Firebase last, once every function/const above exists
initFirebase();