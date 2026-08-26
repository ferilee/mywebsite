#!/usr/bin/env bash
set -euo pipefail

app_dir="${APP_DIR:-/srv/apps/ferilee}"
data_dir="${FERILEE_DATA_DIR:-/srv/data/ferilee/sqlite}"
backup_dir="${BACKUP_DIR:-/srv/backups/ferilee/sqlite}"
compose_file="$app_dir/docker-compose.yml"
timestamp="$(date +%Y%m%d-%H%M%S)"
archive="$backup_dir/ferilee-sqlite-$timestamp.tgz"

if [[ ! -f "$compose_file" ]]; then
  printf 'Compose file tidak ditemukan: %s\n' "$compose_file" >&2
  exit 1
fi

if [[ ! -f "$data_dir/sqlite.db" ]]; then
  printf 'Database tidak ditemukan: %s/sqlite.db\n' "$data_dir" >&2
  exit 1
fi

mkdir -p "$backup_dir"

website_was_running="$(docker compose -f "$compose_file" ps --status running --services | grep -Fx 'mywebsite' || true)"
bot_was_running="$(docker compose -f "$compose_file" ps --status running --services | grep -Fx 'telegram-bot' || true)"

printf 'Menghentikan service sementara agar backup SQLite konsisten...\n'
docker compose -f "$compose_file" stop telegram-bot mywebsite

restart_services() {
  if [[ -n "$website_was_running" ]]; then
    docker compose -f "$compose_file" start mywebsite >/dev/null
  fi
  if [[ -n "$bot_was_running" ]]; then
    docker compose -f "$compose_file" start telegram-bot >/dev/null
  fi
}
trap restart_services EXIT

tar -czf "$archive" -C "$data_dir" sqlite.db
printf 'Backup tersimpan: %s\n' "$archive"
