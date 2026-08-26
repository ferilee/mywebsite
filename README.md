# Ferilee Portfolio App

A high-performance, mobile-first portfolio and blog application built with **Bun**, **Hono**, and **Drizzle ORM**.

## 🚀 Fitur Utama
- **Tech Stack**: Bun, Hono (JSX), Drizzle ORM, SQLite.
- **Styling**: Tailwind CSS (via CDN) dengan desain premium dan glassmorphism.
- **Blog Engine**: Dukungan Markdown dengan `marked`.
- **Admin CMS**: Dashboard sederhana untuk mengelola konten.

## 🛠️ Prasyarat
Pastikan Anda sudah menginstal **Bun** di sistem Anda. Jika belum, instal dengan:
```bash
curl -fsSL https://bun.sh/install | bash
```

## 🏃 Cara Menjalankan Secara Lokal

1. **Instal Dependensi**
   ```bash
   bun install
   ```

2. **Setup Database**
   Inisialisasi database SQLite dan push skema menggunakan Drizzle:
   ```bash
   bun run db:push
   ```

3. **Jalankan Aplikasi**
   Jalankan server pengembangan dengan mode *hot reload*:
   ```bash
   bun run dev
   ```
   Aplikasi akan berjalan di `http://localhost:4128`.

## 🐳 Menjalankan dengan Docker

Jika Anda ingin menjalankan aplikasi menggunakan Docker:

1. **Build dan Jalankan Container**
   ```bash
   docker-compose up --build -d
   ```

2. **Akses Aplikasi**
Buka `http://localhost:4128` di browser Anda.

## 🚀 Deployment ke Proxmox

Panduan migrasi dari VPS ke VM Linux di Proxmox tersedia di
[`DEPLOYMENT_PROXMOX.md`](DEPLOYMENT_PROXMOX.md). Aplikasi dan Telegram bot
dijalankan melalui Docker Compose, sedangkan RustFS/S3 tetap menjadi storage
eksternal.

## 📁 Struktur Proyek
- `src/index.tsx`: Titik masuk utama aplikasi (Routing & Page Logic).
- `src/components/`: Komponen UI (Layout, dll).
- `src/db/`: Skema database dan konfigurasi Drizzle.
- `public/`: Asset statis (Gambar, CSS).

## 🔑 Admin Login
Untuk mengakses dashboard admin:
- URL: `/admin/login`
- Kredensial: Gunakan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` yang dikonfigurasi di file `.env`.

---
Built with ❤️ by Ferilee
