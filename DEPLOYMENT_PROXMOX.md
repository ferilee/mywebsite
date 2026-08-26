# Deployment on Proxmox

This application is intended to run in a Linux VM on Proxmox. Docker runs the
web application and the Telegram bot, Nginx Proxy Manager handles HTTPS and
reverse proxying, and RustFS/S3 remains an external service.

## Target VM

Start with:

- 2 vCPU
- 2–4 GB RAM
- 20–30 GB OS disk
- a separate backup target if available
- Ubuntu or Debian LTS

Expose only SSH, HTTP, and HTTPS from the VM. The application itself listens
on `127.0.0.1:4128` and is reached through the existing Nginx Proxy Manager.

## First-time setup

Install Docker and Compose using the official instructions for the selected OS,
then create the deployment directory:

```sh
sudo mkdir -p /srv/apps/ferilee /srv/data/ferilee/sqlite /srv/backups/ferilee/sqlite
sudo chown -R "$USER":"$USER" /srv/apps/ferilee /srv/data/ferilee /srv/backups/ferilee
cd /srv/apps/ferilee
```

Copy `docker-compose.yml` and `.env` into `/srv/apps/ferilee`. Create `.env` from
`.env.example`, then replace every placeholder with the production value. Do
not commit `.env`. Set this value in `.env`:

```dotenv
FERILEE_DATA_DIR=/srv/data/ferilee/sqlite
```

If the GHCR package is private, authenticate the VM with a GitHub token that
has read-only package access:

```sh
docker login ghcr.io
```

## Restore the database

Stop writes on the old VPS before taking the final backup. The production
database is `data/sqlite.db` inside the application deployment directory.

On the old VPS, from its deployment directory:

```sh
docker compose stop telegram-bot mywebsite
tar -czf /tmp/ferilee-data.tgz -C data sqlite.db
```

Transfer the archive to the Proxmox VM, then restore it into the active data
directory:

```sh
scp old-vps:/tmp/ferilee-data.tgz /tmp/
tar -xzf /tmp/ferilee-data.tgz -C /srv/data/ferilee/sqlite
cp /tmp/ferilee-data.tgz "/srv/backups/ferilee/sqlite/ferilee-$(date +%Y%m%d-%H%M%S).tgz"
```

If the old deployment uses a different host path or database filename, first
locate the mounted volume with `docker inspect mywebsite` and copy the actual
SQLite database to `/srv/data/ferilee/sqlite/sqlite.db`.

## Start the application

Use an immutable image tag for a migration or rollback. For example:

```sh
cd /srv/apps/ferilee
export IMAGE_TAG=sha-<commit-sha>
docker compose config
docker compose pull
docker compose run --rm mywebsite bun run db:push
docker compose up -d mywebsite
curl --fail http://127.0.0.1:4128/healthz
docker compose up -d telegram-bot
docker compose ps
```

The schema command is deliberately separate from the container startup. A
normal restart must not mutate the production database.

## Nginx Proxy Manager

Buat Proxy Host baru di Nginx Proxy Manager dengan nilai:

- Domain Names: domain produksi Ferilee
- Forward Hostname/IP: alamat host Docker yang dapat dijangkau NPM
- Forward Port: `4128`
- Scheme: `http`
- SSL: sertifikat Let's Encrypt dan Force SSL

Jika Nginx Proxy Manager berjalan sebagai container bridge, `127.0.0.1` di
dalam NPM menunjuk ke container NPM, bukan ke VM. Gunakan salah satu pola ini:

1. Tambahkan `host.docker.internal:host-gateway` pada service NPM lalu gunakan
   `host.docker.internal` sebagai Forward Hostname/IP; atau
2. Gunakan IP bridge/LAN VM sebagai Forward Hostname/IP dan pastikan firewall
   hanya mengizinkan port 4128 dari jaringan Docker NPM.

Jangan membuka port 4128 ke internet secara publik.

## Validation checklist

Before changing DNS, verify through the VM:

- `GET /healthz` returns `{ "ok": true }`.
- The home, project, blog, and contact pages load.
- Admin login works.
- A blog post can be created and edited.
- A cover image uploads successfully to RustFS.
- Google OAuth callback uses the production redirect URI.
- Contact/newsletter email integrations work.
- Telegram `/start` responds and `/post` creates a draft.
- Only one Telegram bot process is polling `getUpdates`.
- Restarting `mywebsite` does not remove `/srv/data/ferilee/sqlite/sqlite.db`.
- An existing RustFS object is reachable through its public URL.
- Nginx Proxy Manager meneruskan request ke port 4128 dan HTTPS aktif.

After validation, point the existing DNS record to the Proxmox public IP and
repeat the checks over HTTPS.

## Rollback

If rollback is needed, stop the new bot first, point DNS back to the old VPS,
and start the old application and bot. If new writes were accepted on the new
VM, do not blindly switch databases: restore the agreed backup or reconcile
the new writes before reactivating the old instance.

Keep the old VPS and its final backup available until the new deployment has
been stable for several days.
