# 💈 Private Barber — Appointment Booking App

> A premium, single-page booking app for a private barber — built with vanilla HTML, CSS, and JavaScript, backed by Firebase in real time.

**[🌐 Live Demo](https://private-barber-booking.vercel.app)**

---

## 📸 Preview

> *Drop a screenshot here — it's the single biggest thing that makes a recruiter stop scrolling.*
> Save one as `preview.png` in the root and replace this block with:
> `![App Preview](preview.png)`

---

## ✂️ What It Does

Private Barber is a fully functional, zero-install booking system. Clients fill in their details, pick a date and time, and submit — the booking lands in Firebase instantly. The barber opens the admin view and sees every booking in real time, with a live badge count showing how many are pending.

**Client flow:**
- Landing page with hero section and brand identity
- Booking form — name, date, time slot, optional note
- "My Bookings" page to view upcoming appointments

**Admin flow:**
- Protected admin panel with live pending-booking count
- View and manage all submitted bookings
- Real-time sync via Firebase Realtime Database — no page refresh needed

---

## 🛠️ Tech Stack

| Layer       | Technology                            |
|-------------|---------------------------------------|
| Frontend    | Vanilla HTML5, CSS3, JavaScript (ES6) |
| Database    | Firebase Realtime Database            |
| Auth        | Firebase Authentication               |
| Fonts       | Cormorant Garamond + Jost (Google Fonts) |
| Hosting     | Vercel (static deploy)                |

No frameworks. No build tools. No `node_modules`. Just three files and a Firebase project.

---

## 📁 Project Structure

```
private-barber-booking/
├── index.html      # Full SPA — all pages in one file, shown/hidden via JS
├── script.js       # All logic: Firebase reads/writes, routing, form handling
└── styles.css      # Styling — luxury dark aesthetic, responsive layout
```

The app uses a simple JavaScript router (`showPage()`) to switch between the Home, Booking, My Bookings, and Admin views without any page reloads.

---

## 🚀 Running It Locally

No install required.

```bash
git clone https://github.com/Boipelo2003/private-barber-booking.git
cd private-barber-booking
```

Then open `index.html` in your browser — or use a local server for best results:

```bash
# With VS Code: install the Live Server extension and click "Go Live"

# Or with Python:
python3 -m http.server 3000
# then open http://localhost:3000
```

> **Firebase note:** The app connects to a live Firebase project. To run your own instance, swap the Firebase config object in `script.js` with your own project credentials from the [Firebase Console](https://console.firebase.google.com).

---

## 🔥 Firebase Setup (optional — to use your own backend)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project
2. Enable **Realtime Database** and **Authentication**
3. Copy your config and replace the `firebaseConfig` object in `script.js`:

```js
const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  ...
};
```

4. Set your Realtime Database rules to allow reads/writes as needed for development

---

## 🗺️ Possible Next Steps

- [ ] Email confirmation after booking
- [ ] Date picker with blocked-out unavailable slots
- [ ] Admin ability to approve / reject bookings
- [ ] SMS reminder via Twilio or Firebase Extensions
- [ ] Mobile-first PWA with offline support

---

## 📄 License

[MIT](LICENSE)
READMEEOF
echo "Done"
Output
