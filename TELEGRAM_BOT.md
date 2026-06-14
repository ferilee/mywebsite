# Telegram Bot – Auto Create Blog Posts

Dokumen ini menjelaskan cara menjalankan bot Telegram sederhana (tanpa library) yang dapat membuat blog post di aplikasi ini melalui endpoint integrasi yang aman.

## Gambaran

Alur kerja:
1. Bot Telegram menerima perintah (command) dari kamu.
2. Bot memanggil endpoint aplikasi: `POST /api/integrations/telegram/blog`.
3. Aplikasi menyimpan blog post ke tabel `blog_posts`.

Bot **tidak** mengakses `/admin` (HTML + session). Bot menggunakan endpoint khusus dengan token.

## File yang terlibat

- `telegram-bot.ts` — proses bot Telegram (long polling `getUpdates`).
- `src/index.tsx` — endpoint integrasi Telegram.

## Environment Variables

### Wajib

- `TELEGRAM_BOT_TOKEN`
  - Token bot dari BotFather.

- `TELEGRAM_BOT_ADMIN_TOKEN`
  - Token rahasia untuk mengamankan endpoint integrasi.
  - Harus sama nilainya di sisi **server** dan **bot**.

- `APP_BASE_URL`
  - Base URL aplikasi yang akan dipanggil bot.
  - Contoh local: `http://localhost:3000`
  - Contoh production: `https://domain-kamu.com`

### Disarankan

- `TELEGRAM_ALLOWED_USER_IDS`
  - Daftar user id Telegram yang diizinkan memakai bot.
  - Format: koma-separated.
  - Contoh: `"12345678,98765432"`

Jika `TELEGRAM_ALLOWED_USER_IDS` dikosongkan, bot akan menerima command dari siapa pun yang bisa chat bot tersebut.

## Menjalankan (Local)

1) Jalankan server:

```bash
bun run dev
```

2) Export env untuk bot (di terminal baru):

```bash
export TELEGRAM_BOT_TOKEN="<token-dari-botfather>"
export TELEGRAM_BOT_ADMIN_TOKEN="<token-rahasia-kamu>"
export APP_BASE_URL="http://localhost:3000"
export TELEGRAM_ALLOWED_USER_IDS="12345678"  # opsional tapi disarankan
```

3) Jalankan bot:

```bash
bun run bot:telegram
```

## Cara Pakai di Telegram

### `/start`
Bot akan membalas daftar command.

### `/post`
Format dasar:

```
/post <title>

<content>
```

Contoh:

```
/post Judul Post

Ini isi post dalam markdown.
- bullet 1
- bullet 2
```

#### Header opsional di awal content
Kamu bisa menambahkan metadata di awal content (maksimal beberapa baris awal). Format:

```
category: Tech
tags: bun,hono,status
tatus: draft|published
```

Contoh lengkap:

```
/post Judul Post

category: Tech
tags: bun,hono
status: draft

Ini isi post dalam markdown.
```

Catatan:
- Jika `status` tidak diisi, default bot/server adalah `draft`.

## Endpoint Integrasi (Server)

### `POST /api/integrations/telegram/blog`

Header:

- `Authorization: Bearer <TELEGRAM_BOT_ADMIN_TOKEN>`
- `Content-Type: application/json`

Body JSON:

```json
{
  "title": "Judul",
  "content": "Isi markdown",
  "category": "Opsional",
  "tags": "Opsional (string)",
  "coverImage": "Opsional (url/path)",
  "status": "draft",
  "slug": "opsional"
}
```

Response sukses:

```json
{ "ok": true, "slug": "..." }
```

Jika `slug` tidak dikirim, server membuat slug otomatis dari judul + timestamp agar unik.

## Catatan Keamanan

- Jangan commit token apa pun ke git.
- Wajib set `TELEGRAM_BOT_ADMIN_TOKEN` yang panjang dan random.
- Sangat disarankan mengisi `TELEGRAM_ALLOWED_USER_IDS` untuk membatasi siapa yang boleh membuat post.

## Troubleshooting

- Bot tidak merespon:
  - Pastikan `TELEGRAM_BOT_TOKEN` benar.
  - Pastikan proses `bun run bot:telegram` berjalan dan tidak crash.

- Gagal membuat post (Unauthorized):
  - Pastikan `TELEGRAM_BOT_ADMIN_TOKEN` di bot sama dengan yang dipakai server.

- Gagal konek ke server:
  - Pastikan `APP_BASE_URL` benar dan server sudah berjalan.
