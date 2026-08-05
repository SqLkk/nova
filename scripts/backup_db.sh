#!/usr/bin/env bash
# =============================================================================
# Supernova — Şifreli SQLite yedeği (NIS2 Art.21(1)(c) business continuity;
# ISO/IEC 27002:2022 A.8.13).
#
# Uygulama DB'sinin çevrimiçi, tutarlı bir anlık görüntüsünü alır (WAL dahil),
# gzip+sıkıştırır ve NOVA_BACKUP_PASSPHRASE ile gpg AES256 simetrik şifreler.
# Çıktı: <DEST_DIR>/nova_<UTC ts>.db.gz.gpg  (eski yedekler KEEP adede döndürülür).
#
# Gereksinimler: python3, gpg.  (sqlite3 CLI gerekmez — Python backup() kullanır.)
#
# Çevre değişkenleri:
#   NOVA_BACKUP_DB          (zorunlu) yedeklenecek SQLite dosyası
#   NOVA_BACKUP_PASSPHRASE  (zorunlu) simetrik şifreleme parolası (vault'tan)
#   NOVA_BACKUP_DIR         (opsiyonel) çıktı dizini (varsayılan: ./backups)
#   NOVA_BACKUP_KEEP        (opsiyonel) tutulacak yedek sayısı (varsayılan: 14)
#
# Kurtarma:
#   gpg --decrypt nova_*.db.gz.gpg | gunzip > restored.db
# =============================================================================
set -euo pipefail

# --- .env yükle (repo kökünde çalıştırılırsa); mevcut env baskın ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

: "${NOVA_BACKUP_DB:?NOVA_BACKUP_DB (yedeklenecek SQLite yolu) gerekli}"
if [ -z "${NOVA_BACKUP_PASSPHRASE:-}" ]; then
  echo "HATA: NOVA_BACKUP_PASSPHRASE tanımlı değil (secret manager / .env)." >&2
  exit 1
fi
if [ ! -f "$NOVA_BACKUP_DB" ]; then
  echo "HATA: Veritabanı bulunamadı: $NOVA_BACKUP_DB" >&2
  exit 1
fi
command -v gpg >/dev/null 2>&1 || { echo "HATA: gpg gerekli." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "HATA: python3 gerekli." >&2; exit 1; }

DEST_DIR="${NOVA_BACKUP_DIR:-$REPO_ROOT/backups}"
KEEP="${NOVA_BACKUP_KEEP:-14}"
mkdir -p "$DEST_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST_DIR/nova_${TS}.db.gz.gpg"
SNAP="$(mktemp -t nova_snap.XXXXXX)"
trap 'rm -f "$SNAP"' EXIT

# --- Çevrimiçi tutarlı anlık görüntü: WAL checkpoint + Python backup() ---------
# Kaynak DB açıkken güvenli; okuma kilidi kısa süreli. shellcheck: arglar bilinçli.
# shellcheck disable=SC2154
python3 - "$NOVA_BACKUP_DB" "$SNAP" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src)
try:
    s.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # WAL'i ana dosyaya boşalt
except sqlite3.DatabaseError:
    pass  # WAL modunda değilse sorun değil
d = sqlite3.connect(dst)
s.backup(d)   # çevrimiçi tutarlı kopya
d.close(); s.close()
PY

# --- Sıkıştır + şifrele (parola fd üzerinden -> ps'te görünmez) -----------------
gzip -c "$SNAP" | gpg --batch --yes --quiet \
  --symmetric --cipher-algo AES256 --passphrase-fd 3 \
  -o "$OUT" 3<<<"$NOVA_BACKUP_PASSPHRASE"
rm -f "$SNAP"

# --- Rotasyon: son KEEP yedek tutulur (taşınabilir; mapfile gerektirmez) -------
shopt -s nullglob
i=0
for f in $(ls -1t "$DEST_DIR"/nova_*.db.gz.gpg 2>/dev/null); do
  i=$((i + 1))
  [ "$i" -gt "$KEEP" ] && rm -f "$f"
done

echo "Yedek tamam: $OUT"
