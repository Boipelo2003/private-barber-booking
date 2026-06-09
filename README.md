# 💈 Private Barber — Booking System

A real-time client booking web app built for a barber based in Potchefstroom, South Africa. Clients can book appointments, view available slots, and manage their bookings — while the admin controls availability and closures from a separate dashboard.

**Live site:** [private-barber-booking.vercel.app](https://private-barber-booking.vercel.app)

---

## What It Does

**Client side**
- Browse available time slots and book an appointment in a few taps
- View and cancel upcoming bookings via the "My Bookings" tab
- Works across mobile and desktop browsers

**Admin side**
- Close specific time slots or entire days to block availability
- Changes reflect in real time for all clients — no page refresh needed

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Database | Firebase Realtime Database |
| Hosting | Vercel |
| Auth | Firebase (admin-gated dashboard) |

---

## Key Technical Decisions

**Cross-device date consistency** — Early versions used `toDateString()` to key bookings in Firebase, which produced inconsistent results across browsers (especially Android Chrome). Fixed by switching to a custom `dateToKey()` function that formats dates as `YYYY-MM-DD`, ensuring all devices read and write to the same keys regardless of locale or timezone.

**Firebase Realtime Database (not Firestore)** — Chosen for its simple structure and live sync behaviour, which makes the real-time slot updates possible without polling.

**Serverless deployment** — No backend server to manage. The app runs entirely on the client, talking directly to Firebase with security rules to prevent unauthorised writes.

---

## Local Setup

```bash
# Clone the repo
git clone https://github.com/your-username/private-barber-booking.git
cd private-barber-booking

# No build step needed — open index.html directly
# or serve with any static file server:
npx serve .
```

**Firebase config:** Create a `.env` file or replace the Firebase config object in the source with your own project credentials from the [Firebase Console](https://console.firebase.google.com).

---

## Project Structure

```
/
├── index.html          # Main booking UI
├── admin.html          # Admin dashboard
├── style.css           # Global styles
├── app.js              # Booking logic + Firebase integration
├── admin.js            # Admin slot management
└── firebase-config.js  # Firebase initialisation
```

---

## Screenshots

> *(Add screenshots here — booking page, admin dashboard, mobile view)*

<img width="954" height="908" alt="image" src="https://github.com/user-attachments/assets/6ae2e1b9-b66b-41ab-a110-8ffdf184c452" />
<img width="936" height="902" alt="image" src="https://github.com/user-attachments/assets/909a89dc-1162-4e7d-a964-b47ae23ef67e" />

<img width="917" height="837" alt="image" src="https://github.com/user-attachments/assets/794aa819-5b12-4683-9ae5-da5038c8d913" />

<img width="915" height="893" alt="image" src="https://github.com/user-attachments/assets/6e096abf-7220-481a-af3e-9386ea0a7c67" />
<img width="915" height="653" alt="image" src="https://github.com/user-attachments/assets/896e052a-500c-4b56-a3b7-cbaca33bd9e3" />

## Built By

[BBA Media](https://bbamedia.co.za) — Web design agency based in Johannesburg, South Africa.
