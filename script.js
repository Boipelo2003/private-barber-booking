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
// FIREBASE INIT + STORAGE
// ══════════════════════════════════════
let _db         = null;
let _bookingsCache = [];
let _fbReady    = false;
let _fbConnected = false;

function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    _db = firebase.database();

    _db.ref('pb_bookings').on('value', (snapshot) => {
      const raw      = snapshot.val();
      const incoming = raw ? Object.values(raw) : [];
      const cachedIds = new Set(_bookingsCache.map(b => b.id));
      const added    = incoming.filter(b => !cachedIds.has(b.id));

      _bookingsCache = incoming;
      _fbReady       = true;
      _fbConnected   = true;

      if (state.currentPage === 'booking' && state.booking.step === 2 && state.booking.date) {
    buildTimeGrid('time-grid', state.booking.date.toDateString(), state.booking.time, 'selectTime');
  }

      localStorage.setItem('pb_bookings', JSON.stringify(_bookingsCache));

      added.forEach(b => {
        if (!_justCreatedIds.has(b.id)) pushLiveAlert(b);
        _justCreatedIds.delete(b.id);
      });

      updateAdminBadge();

      if (adminLoggedIn && state.currentPage === 'admin') renderAdminDashboard();
      if (state.currentPage === 'bookings') {
        const email = document.getElementById('lookup-email').value.trim();
        if (email) lookupBookings();
      }
    });

    _db.ref('.info/connected').on('value', (snap) => {
      _fbConnected = snap.val() === true;
      updateConnectionBadge(_fbConnected);
    });

  _db.ref('pb_closed_dates').on('value', (snap) => {
  const val = snap.val() || {};
  // ✅ normalize all keys on read
  _closedDates = new Set(
    Object.keys(val)
      .filter(k => val[k] === true)
      .map(k => normalizeDateStr(k.replace(/_/g, ' ')))
  );
  if (state.currentPage === 'booking') {
    renderBookingCalendar();
    if (state.booking.step === 2 && state.booking.date) {
      buildTimeGrid('time-grid', state.booking.date.toDateString(), state.booking.time, 'selectTime');
    }
  }
});

_db.ref('pb_closed_slots').on('value', (snap) => {
  const val = snap.val() || {};
  _closedSlots = {};
  Object.keys(val).forEach(dateKey => {
    const rawDateStr = dateKey.replace(/_/g, ' ');
    const normalized = normalizeDateStr(rawDateStr);  // ✅ normalize on read
    _closedSlots[normalized] = new Set(
      Object.keys(val[dateKey])
        .filter(t => val[dateKey][t] === true)
        .map(t => t.slice(0, 2) + ':' + t.slice(2))
    );
  });
  if (state.currentPage === 'booking') {
    renderBookingCalendar();
    if (state.booking.step === 2 && state.booking.date) {
      buildTimeGrid('time-grid', state.booking.date.toDateString(), state.booking.time, 'selectTime');
    }
  }
  if (state.reschedule.date) {
    buildTimeGrid('reschedule-time-grid', state.reschedule.date.toDateString(), state.reschedule.time, 'selectRescheduleTime');
  }
});

    console.log('🔥 Firebase connected');
    window._auth = firebase.auth();
    startAuthWatcher();

  } catch (err) {
    console.warn('Firebase init failed — using localStorage fallback', err);
    _fbConnected = false;
    updateConnectionBadge(false);
  }
}

// Track IDs we just created so we don't double-alert ourselves
const _justCreatedIds = new Set();

// ── Read bookings ─────────────────────────────────────────────────────────
function getBookings() {
  if (_fbReady) return _bookingsCache;
  return JSON.parse(localStorage.getItem('pb_bookings') || '[]');
}

// ── Write all bookings ────────────────────────────────────────────────────
function saveBookings(list) {
  _bookingsCache = list;
  localStorage.setItem('pb_bookings', JSON.stringify(list));
  if (_db) {
    const updates = {};
    list.forEach(b => { updates[`pb_bookings/${b.id}`] = b; });
    _db.ref('/').update(updates).catch(err => console.warn('Firebase write failed', err));
  }
}

// ── Update a single booking's status ─────────────────────────────────────
function saveBookingStatus(id, status) {
  const bookings = getBookings();
  const idx = bookings.findIndex(b => b.id === id);
  if (idx === -1) return;
  bookings[idx].status = status;
  _bookingsCache = bookings;
  localStorage.setItem('pb_bookings', JSON.stringify(bookings));
  if (_db) {
    _db.ref(`pb_bookings/${id}/status`).set(status)
      .catch(err => console.warn('Firebase status update failed', err));
  }
}

// ── Connection status dot ─────────────────────────────────────────────────
function updateConnectionBadge(connected) {
  const dot = document.getElementById('fb-status-dot');
  if (!dot) return;
  dot.title = connected ? 'Live sync: Online' : 'Live sync: Offline (localStorage only)';
  dot.style.background = connected ? '#27ae60' : '#e05252';
}

let _closedDates      = new Set();
let _closedSlots      = {};        // { "Mon May 26 2026": Set(["09:00","14:00"]) }
let _availSelectedDate = null;

// Start Firebase
initFirebase();


// ══════════════════════════════════════
// AVAILABILITY TOGGLES
// ══════════════════════════════════════
function toggleClosedDate(dateStr) {
  const normalized = normalizeDateStr(dateStr);
  const key = normalized.replace(/\s/g, '_');
  const isCurrentlyClosed = _closedDates.has(normalized);
  if (_db) {
    _db.ref(`pb_closed_dates/${key}`).set(isCurrentlyClosed ? null : true);
  }
  if (isCurrentlyClosed) _closedDates.delete(normalized);
  else _closedDates.add(normalized);
  renderAvailabilityCalendar();
  renderAvailabilityTimeGrid(normalized);
}

function toggleClosedSlot(dateStr, time) {
  const normalized = normalizeDateStr(dateStr);
  const key = normalized.replace(/\s/g, '_');
  const slots = _closedSlots[normalized] || new Set();
  const isClosed = slots.has(time);
  if (_db) {
    _db.ref(`pb_closed_slots/${key}/${time.replace(':', '')}`).set(isClosed ? null : true);
  }
  if (!_closedSlots[normalized]) _closedSlots[normalized] = new Set();
  if (isClosed) _closedSlots[normalized].delete(time);
  else _closedSlots[normalized].add(time);
  renderAvailabilityTimeGrid(normalized);
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
  const late = booking.lateFee ? '\n🌙 Late Fee: +R20' : '';
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
    `Unfortunately, your booking for *${booking.service}* on *${booking.date}* at *${booking.time}* has been *cancelled* because the schedule is full.\n\n` +
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
  cancelTarget:     null,
  cancelFeeApplied: false,   // FIX: declared here, not dynamically assigned later
  adminFilter: 'all'
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
    document.getElementById('bookings-results').innerHTML = '';
    document.getElementById('lookup-email').value = '';
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
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${msg}</span>`;
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

function generateId() {
  return 'PB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 5).toUpperCase();
}

function getServiceLabel(svc) { return svc === 'dye' ? 'Haircut with Dye' : 'Haircut without Dye'; }
function getServicePrice(svc) { return svc === 'dye' ? 100 : 80; }

// ✅ Normalizes any date string to "Mon Jun 02 2026" format (zero-padded day)
// Ensures Safari/Chrome/Android all produce identical keys for Firebase lookups
function normalizeDateStr(dateStr) {
  const d = new Date(dateStr);
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${pad2(d.getDate())} ${d.getFullYear()}`;
}

function getBookedSlots(dateStr) {
  const normalized = normalizeDateStr(dateStr);
  return getBookings()
    .filter(b => normalizeDateStr(b.dateStr) === normalized && b.status !== 'cancelled')
    .map(b => b.time);
}


// ══════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════
function buildCalendar(containerId, year, month, selectedDate, onSelect) {
  const container    = document.getElementById(containerId);
  const now          = new Date();
  const today        = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysInMonth  = new Date(year, month + 1, 0).getDate();
  const firstDay     = new Date(year, month, 1).getDay();
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  let html = `<div class="cal-header">
    <button class="cal-nav" onclick="${onSelect.nav}(-1)">‹</button>
    <div class="cal-month">${months[month]} ${year}</div>
    <button class="cal-nav" onclick="${onSelect.nav}(1)">›</button>
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
    const isClosed = _closedDates && _closedDates.has(thisDate.toDateString());
    const disabled = isPast || isClosed;
    const isToday  = thisDate.getTime() === today.getTime();
    const isSel    = selectedDate && thisDate.toDateString() === selectedDate.toDateString();
    const cls = ['cal-day',
      disabled              ? 'disabled'   : '',
      isToday               ? 'today'      : '',
      isSel                 ? 'selected'   : '',
      isClosed && !isPast   ? 'closed-day' : ''
    ].filter(Boolean).join(' ');
    const click = disabled ? '' : `onclick="${onSelect.click}(${year},${month},${d})"`;
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
  });
}

function renderAvailabilityTimeGrid(dateStr) {
  const container = document.getElementById('availability-time-grid');
  if (!container) return;

  const bookedSlots = getBookedSlots(dateStr);
  const closedSlots = _closedSlots[dateStr] || new Set();
  const isDayClosed = _closedDates.has(dateStr);

  const d      = new Date(dateStr);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateLabel = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;

  const slots = [];
  for (let h = 8; h <= 19; h++) slots.push(`${pad2(h)}:00`);

  // NOTE: The inline styles here have been converted to CSS classes.
  // Add the matching .avail-* rules from the CSS block provided in the review notes.
  let html = `
    <div class="avail-date-heading">📅 ${dateLabel}</div>
    <div class="avail-toggle-row">
      <button onclick="toggleClosedDate('${dateStr}')"
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
      slotLabel  = `${slot}${isLate ? '<br><span class="avail-slot-sub">+R20</span>' : ''}`;
    }

    const clickable = !isBooked && !isDayClosed;
    const onclick   = clickable ? `onclick="toggleClosedSlot('${dateStr}','${slot}')"` : '';

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
  const dateStr      = new Date(y, m, d).toDateString();
  _availSelectedDate = dateStr;
  renderAvailabilityCalendar();
  renderAvailabilityTimeGrid(dateStr);
  document.getElementById('availability-time-panel').style.display = 'block';
}


// ══════════════════════════════════════
// TIME SLOTS
// ══════════════════════════════════════
// FIX: removed inner <div class="time-grid"> wrapper — the container
// already has the class in HTML for #time-grid.
// For #reschedule-time-grid: add class="time-grid" to that element in index.html.
function buildTimeGrid(containerId, dateStr, selectedTime, onSelect) {
  if (!_fbReady) {
    document.getElementById(containerId).innerHTML =
      '<div style="text-align:center;padding:20px;color:var(--gold)">⏳ Loading slots...</div>';
    return;
  }

  const normalized = normalizeDateStr(dateStr);
  const booked      = getBookedSlots(normalized);
  const isDayClosed = _closedDates && _closedDates.has(normalized);
  const slots       = [];

  for (let h = 8; h <= 19; h++) slots.push(`${pad2(h)}:00`);

  let html = '';
  slots.forEach(slot => {
    const isClientBooked = booked.includes(slot);
    const isSlotClosed   = isDayClosed || (_closedSlots[normalized] && _closedSlots[normalized].has(slot));
    const unavailable    = isClientBooked || isSlotClosed;
    const isLate         = isLateSlot(slot);
    const isSel          = slot === selectedTime;

    const cls   = ['time-slot', unavailable ? 'booked' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
    const click = unavailable ? '' : `onclick="${onSelect}('${slot}')"`;

    let badge = '';
    if (isSlotClosed && !isClientBooked) badge = `<span class="late-badge">Closed</span>`;
    else if (isLate && !unavailable)     badge = `<span class="late-badge">+R20 late</span>`;

    html += `<div class="${cls}" ${click}>${slot}${badge}</div>`;
  });

  document.getElementById(containerId).innerHTML = html;
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
  const total = price + (b.lateFee ? 20 : 0);
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

function confirmBooking() {
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

  const b       = state.booking;
  const id      = generateId();
  const dateStr = b.date.toDateString();
  const booking = {
    id, name, phone, email,
    date:       formatDate(b.date),
    dateStr,
    time:       b.time,
    service:    getServiceLabel(b.service),
    serviceKey: b.service,
    lateFee:    b.lateFee,
    totalPrice: b.totalPrice,
    status:     'pending',
    createdAt:  Date.now()
  };

  _justCreatedIds.add(id);
  _bookingsCache.push(booking);
  localStorage.setItem('pb_bookings', JSON.stringify(_bookingsCache));
  if (_db) {
    _db.ref(`pb_bookings/${id}`).set(booking)
      .catch(err => console.warn('Firebase write failed', err));
  }

  // Step 5 — confirmation screen
  document.getElementById('confirm-id').textContent = id;
  document.getElementById('confirm-summary').innerHTML = `
    <div class="summary-row"><span>👤 Name</span><span>${name}</span></div>
    <div class="summary-row"><span>📞 Phone</span><span>${phone}</span></div>
    <div class="summary-row"><span>📅 Date</span><span>${booking.date}</span></div>
    <div class="summary-row"><span>🕐 Time</span><span>${b.time}</span></div>
    <div class="summary-row"><span>✂️ Service</span><span>${booking.service}</span></div>
    ${b.lateFee ? `<div class="summary-row"><span>🌙 Late Fee</span><span>+R20</span></div>` : ''}
    <div class="summary-row total"><span>Total</span><span>R${b.totalPrice}</span></div>
  `;

  const waAdminMsg  = encodeURIComponent(buildNewBookingMsg(booking));
  const waClientMsg = encodeURIComponent(buildCustomerConfirmMsg(booking));
  const clientWaNum = formatWANumber(phone);

  document.getElementById('confirm-wa-buttons').innerHTML = `
    <button class="btn-wa btn-wa-confirm"
      style="width:100%;justify-content:center;margin-bottom:8px;padding:12px 16px;font-size:0.8rem;"
      onclick="window.open('https://wa.me/${ADMIN_WA}?text=${waAdminMsg}','_blank')">
      📲 Notify Barber via WhatsApp
    </button>
    <button class="btn-wa btn-wa-reschedule"
      style="width:100%;justify-content:center;padding:12px 16px;font-size:0.8rem;"
      onclick="window.open('https://wa.me/${clientWaNum}?text=${waClientMsg}','_blank')">
      💬 Send Booking Details to Myself
    </button>
  `;

  goStep(5);
  toast('Booking confirmed! 🎉', 'success', '✅');
  pushLiveAlert(booking);
  updateAdminBadge();

  // REMOVED: auto-open WhatsApp setTimeout — the manual "Notify Barber" button
  // on Step 5 is sufficient. Keeping both caused the admin to receive two messages.
}


// ══════════════════════════════════════
// MY BOOKINGS
// ══════════════════════════════════════
function lookupBookings() {
  const email = document.getElementById('lookup-email').value.trim().toLowerCase();
  if (!email) { toast('Please enter your email.', 'error', '⚠️'); return; }

  const all       = getBookings().filter(b => b.email.toLowerCase() === email);
  const container = document.getElementById('bookings-results');

  if (all.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📭</div>No bookings found for this email address.</div>`;
    return;
  }

  all.sort((a, b) => b.createdAt - a.createdAt);
  container.innerHTML = all.map(b => buildBookingCard(b)).join('');
}

function buildBookingCard(b) {
  const now      = Date.now();
  const apptTime = parseDateTimeMs(b.dateStr, b.time);
  const isFuture = apptTime > now;
  const isActive = b.status !== 'cancelled' && isFuture;
  // REMOVED: isPast — was declared but never used

  const actions = isActive ? `
    <button class="btn-sm btn-sm-reschedule" onclick="openReschedule('${b.id}')">🔁 Reschedule</button>
    <button class="btn-sm btn-sm-cancel"     onclick="openCancel('${b.id}')">✕ Cancel</button>
  ` : '';

  return `<div class="booking-card" id="bc-${b.id}">
    <div class="bc-header">
      <div>
        <div class="bc-id">ID: ${b.id}</div>
        <div class="bc-name">${b.name}</div>
      </div>
      <div class="status-badge ${b.status}">${b.status.charAt(0).toUpperCase()+b.status.slice(1)}</div>
    </div>
    <div class="bc-details">
      <div class="bc-detail">📅 <strong>${b.date}</strong></div>
      <div class="bc-detail">🕐 <strong>${b.time}</strong></div>
      <div class="bc-detail">✂️ <strong>${b.service}</strong></div>
      <div class="bc-detail">📧 <strong>${b.email}</strong></div>
    </div>
    <div class="bc-price">Total: R${b.totalPrice}</div>
    ${actions ? `<div class="bc-actions">${actions}</div>` : ''}
  </div>`;
}

function parseDateTimeMs(dateStr, time) {
  const d      = new Date(dateStr);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}


// ══════════════════════════════════════
// CANCEL
// ══════════════════════════════════════
function openCancel(id) {
  state.cancelTarget = id;
  const b          = getBookings().find(x => x.id === id);
  const apptMs     = parseDateTimeMs(b.dateStr, b.time);
  const now        = Date.now();
  const hoursUntil = (apptMs - now) / (1000 * 60 * 60);
  const within5    = hoursUntil < 5 && hoursUntil > 0;

  document.getElementById('cancel-warning-text').textContent =
    `Are you sure you want to cancel your ${b.service} on ${b.date} at ${b.time}?`;
  document.getElementById('cancel-fee-warning').style.display = within5 ? 'flex' : 'none';
  openModal('cancel-modal');
  state.cancelFeeApplied = within5;
}

function proceedCancel() {
  const bookings = getBookings();
  const idx      = bookings.findIndex(b => b.id === state.cancelTarget);
  if (idx > -1) {
    bookings[idx].status = 'cancelled';
    if (state.cancelFeeApplied) {
      bookings[idx].cancellationFee = 20;
      toast('Booking cancelled. R20 fee applied.', 'warning', '⚠️');
    } else {
      toast('Booking cancelled successfully.', 'default', '✓');
    }
    saveBookings(bookings);
  }
  closeModal('cancel-modal');
  const email = document.getElementById('lookup-email').value.trim();
  if (email) lookupBookings();
}


// ══════════════════════════════════════
// RESCHEDULE
// ══════════════════════════════════════
function openReschedule(id) {
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

function confirmReschedule() {
  if (!state.reschedule.date || !state.reschedule.time) {
    toast('Please select a new date and time.', 'error', '⚠️'); return;
  }
  const bookings = getBookings();
  const idx      = bookings.findIndex(b => b.id === state.reschedule.bookingId);
  if (idx > -1) {
    bookings[idx].dateStr     = state.reschedule.date.toDateString();
    bookings[idx].date        = formatDate(state.reschedule.date);
    bookings[idx].time        = state.reschedule.time;
    bookings[idx].lateFee     = isLateSlot(state.reschedule.time);
    const basePrice           = bookings[idx].serviceKey === 'dye' ? 100 : 80;
    bookings[idx].totalPrice  = basePrice + (bookings[idx].lateFee ? 20 : 0);
    bookings[idx].status      = 'pending';
    saveBookings(bookings);
    toast('Booking rescheduled! ✓', 'success', '🔁');
    closeModal('reschedule-modal');
    const email = document.getElementById('lookup-email').value.trim();
    if (email) lookupBookings();
  }
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
  // onAuthStateChanged watcher handles show/hide automatically
}

async function adminLogin() {
  const email    = document.getElementById('admin-email').value.trim();
  const password = document.getElementById('admin-password').value.trim();
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
  window._auth.onAuthStateChanged((user) => {
    if (user) { adminLoggedIn = true;  showAdminDashboard(); }
    else       { adminLoggedIn = false; showAdminLoginForm(); }
  });
}

function renderAdminDashboard() {
  const bookings = getBookings();
  const today    = new Date(); today.setHours(0,0,0,0);
  const todayStr = today.toDateString();

  // REMOVED: unused variables 'now', 'confirmed', 'cancelled'
  const total      = bookings.length;
  const pending    = bookings.filter(b => b.status === 'pending').length;
  const todayCount = bookings.filter(b => b.dateStr === todayStr && b.status !== 'cancelled').length;
  const revenue    = bookings.filter(b => b.status !== 'cancelled').reduce((s, b) => s + b.totalPrice, 0);

  document.getElementById('admin-stats').innerHTML = `
    <div class="stat-card"><div class="stat-num">${total}</div><div class="stat-label">Total Bookings</div></div>
    <div class="stat-card"><div class="stat-num">${todayCount}</div><div class="stat-label">Today's Appointments</div></div>
    <div class="stat-card"><div class="stat-num">${pending}</div><div class="stat-label">Pending</div></div>
    <div class="stat-card"><div class="stat-num" style="font-size:1.6rem">R${revenue}</div><div class="stat-label">Total Revenue</div></div>
  `;

  renderAdminBookings();
}

if (document.getElementById('availability-calendar')) renderAvailabilityCalendar();

function adminFilter(f) {
  state.adminFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('af-' + f).classList.add('active');
  renderAdminBookings();
}

function renderAdminBookings() {
  let bookings = getBookings();
  if (state.adminFilter !== 'all') bookings = bookings.filter(b => b.status === state.adminFilter);
  bookings.sort((a, b) => parseDateTimeMs(b.dateStr, b.time) - parseDateTimeMs(a.dateStr, a.time));

  const container = document.getElementById('admin-bookings-list');
  if (bookings.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📋</div>No bookings found.</div>`;
    return;
  }

  container.innerHTML = bookings.map(b => {
    const clientNum  = formatWANumber(b.phone);
    const confirmMsg = encodeURIComponent(buildAdminConfirmMsg(b));
    const cancelMsg  = encodeURIComponent(buildAdminCancelMsg(b));
    const reschedMsg = encodeURIComponent(buildAdminReschedMsg(b));

    const now      = Date.now();
    const isFuture = parseDateTimeMs(b.dateStr, b.time) > now;

    const actionBtns = (b.status !== 'cancelled' && isFuture) ? `
      <a class="btn-wa btn-wa-confirm"
         href="https://wa.me/${clientNum}?text=${confirmMsg}" target="_blank"
         onclick="adminUpdateStatus('${b.id}','confirmed')">✅ Confirm</a>
      <a class="btn-wa btn-wa-reschedule"
         href="https://wa.me/${clientNum}?text=${reschedMsg}" target="_blank">🔁 Reschedule</a>
      <a class="btn-wa btn-wa-cancel"
         href="https://wa.me/${clientNum}?text=${cancelMsg}" target="_blank"
         onclick="adminUpdateStatus('${b.id}','cancelled')">❌ Cancel</a>`
    : `<span style="font-size:0.72rem;color:var(--white3);padding:4px 0">${b.status === 'cancelled' ? '🚫 Cancelled' : '⏰ Past appointment'}</span>`;

    return `<div class="admin-booking-card" id="abc-${b.id}">
      <div class="abc-top">
        <div>
          <div class="abc-name">${b.name}</div>
          <div class="abc-phone">
            📞 <a href="https://wa.me/${clientNum}" target="_blank"
                  style="color:var(--gold);text-decoration:none;">${b.phone}</a>
            &nbsp;·&nbsp; 📧 ${b.email}
          </div>
        </div>
        <div class="status-badge ${b.status}">${b.status.charAt(0).toUpperCase()+b.status.slice(1)}</div>
      </div>
      <div class="abc-info">
        <span>📅 <strong>${b.date}</strong></span>
        <span>🕐 <strong>${b.time}</strong></span>
        <span>✂️ <strong>${b.service}</strong></span>
        <span>💰 <strong>R${b.totalPrice}</strong></span>
        <span>🔖 <strong>${b.id}</strong></span>
      </div>
      <div class="abc-actions">${actionBtns}</div>
    </div>`;
  }).join('');
}

function adminUpdateStatus(id, status) {
  setTimeout(() => {
    saveBookingStatus(id, status);
    renderAdminDashboard();
  }, 500);
}

function adminMsgToday() {
  const todayStr     = new Date().toDateString();
  const todayBookings = getBookings().filter(b => b.dateStr === todayStr && b.status !== 'cancelled');
  if (todayBookings.length === 0) { toast('No appointments today.', 'default', '📅'); return; }
  todayBookings.forEach((b, i) => {
    const msg = `Hello ${b.name} 👋, this is *PRIVATE BARBER 💈*!\n\n` +
      `Just a reminder that your appointment is *TODAY* 🎉\n` +
      `🕐 *Time:* ${b.time}\n✂️ *Service:* ${b.service}\n\nSee you soon! 💈`;
    setTimeout(() => openWhatsApp(b.phone, msg), i * 500);
  });
  toast(`Messaging ${todayBookings.length} client(s) for today.`, 'success', '📲');
}

function adminRemindUpcoming() {
  const now      = Date.now();
  const upcoming = getBookings().filter(b => parseDateTimeMs(b.dateStr, b.time) > now && b.status !== 'cancelled');
  if (upcoming.length === 0) { toast('No upcoming appointments.', 'default', '📅'); return; }
  upcoming.slice(0, 5).forEach((b, i) => {
    const msg = `Hello ${b.name} 👋, this is *PRIVATE BARBER 💈*!\n\n` +
      `🔔 Friendly reminder of your upcoming appointment:\n` +
      `📅 *Date:* ${b.date}\n🕐 *Time:* ${b.time}\n✂️ *Service:* ${b.service}\n\n` +
      `See you then! If anything changes please let us know. 💈`;
    setTimeout(() => openWhatsApp(b.phone, msg), i * 500);
  });
  toast(`Reminders sent to ${Math.min(upcoming.length, 5)} upcoming client(s).`, 'success', '🔔');
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
        <div class="lba-title">New Booking — ${b.name}</div>
        <div class="lba-meta">
          ✂️ ${b.service} &nbsp;·&nbsp; 📅 ${b.date} at ${b.time}<br>
          📞 ${b.phone} &nbsp;·&nbsp; 💰 R${b.totalPrice} &nbsp;·&nbsp; 🔖 ${b.id}
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
