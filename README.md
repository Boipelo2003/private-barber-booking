# 💈 Private Barber — Appointment Booking App

> A modern, full-stack barber shop booking system that lets clients schedule appointments, manage bookings, and lets staff handle everything from a dedicated admin panel.

**[🌐 Live Demo](https://private-barber-booking.vercel.app)**

---

## ✂️ What It Does

Private Barber is an end-to-end appointment platform built for independent barbers and small shops. Clients can book slots in seconds, view their upcoming appointments, and get a clean confirmation — while the admin side gives the barber full control over their schedule.

**Client side:**
- Browse available time slots in real time
- Book, reschedule, or cancel appointments
- View all upcoming and past bookings under "My Bookings"

**Admin side:**
- See the full daily/weekly schedule at a glance
- Manage all bookings — approve, cancel, or reschedule
- Keeps client and booking data organised in one place

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React / Next.js |
| Styling | CSS Modules / Tailwind CSS |
| Deployment | Vercel |
| Data | REST API / Firebase / Supabase *(update to match your setup)* |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repo
git clone https://github.com/<your-username>/private-barber-booking.git
cd private-barber-booking

# Install dependencies
npm install

# Add environment variables
cp .env.example .env.local
# Fill in your API keys / DB connection string

# Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

---

## 📁 Project Structure

```
├── components/        # Reusable UI components
├── pages/             # Next.js routing (or app/ for App Router)
│   ├── index.js       # Home / landing
│   ├── bookings.js    # My Bookings view
│   └── admin.js       # Admin dashboard
├── styles/            # Global and module styles
├── lib/               # API helpers, utils
└── public/            # Static assets (logo, icons)
```

---

## 📸 Screenshots

| Home | Book Now | Admin |
|------|----------|-------|
| ![home](./screenshots/home.png) | ![book](./screenshots/book.png) | ![admin](./screenshots/admin.png) |

*(Drop screenshots into a `/screenshots` folder and the table above renders automatically.)*

---

## 🔑 Environment Variables

Create a `.env.local` file at the root with the following:

```env
NEXT_PUBLIC_API_URL=
DATABASE_URL=
AUTH_SECRET=
```

---

## 🗺️ Roadmap

- [ ] SMS / email confirmation on booking
- [ ] Google Calendar sync for the barber
- [ ] Stripe integration for deposits
- [ ] Service & pricing management in admin

---

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

---

## 📄 License

[MIT](LICENSE)
