#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Parola hashleme ve doğrulama — argon2id (önerilen) + kademeli (legacy) migrasyon.

NIS2 Art.21(1)(h); ISO/IEC 27002:2022 A.8.24; NIST SP 800-63B §5.1.

Eski parolalar sha256(salt:password) ile saklanıyordu — tek turlu hızlı bir hash
olduğundan kaba kuvvet / gökkuşağı saldırılarına karşı zayıftır. Bu modül:

  * Yeni parolaları argon2id ile hashler. (Opsiyonel) peper (config.ARGON2_PEPPER)
    hashlamadan ÖNCE parolaya eklenir; DB sızıntısında bile çevrimdışı kırma
    secret-manager gizlisine bağımlı hale gelir.
  * Legacy sha256 değerlerini hâlâ doğrulayabilir; başarılı doğrulamada çağırana
    "rehash gerekli" sinyali verir → login sırasında argon2id'ye göç (gradual).
  * check_needs_rehash ile argon2 parametre güncellemelerini de algılar.

Saklama: argon2id PHC string'i password_hash sütununda tek başına; salt PHC'nin
içindedir (yeni hash'ler için password_salt sütunu boş bırakılır).

PHC örneği:
  $argon2id$v=19$m=65536,t=3,p=4$<salt_b64>$<hash_b64>
"""

import hashlib
import hmac
import logging
import os
import re

from config import config

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Argon2id parametreleri (OWASP-aligned sunucu öntanımlısı; tümü sabit).
#   memory_cost : 64 MiB (KiB cinsinden) — çevrimdışı kırmayı pahalılar.
#   time_cost   : 3 yineleme.
#   parallelism : 4 iş parçacığı (server'da mevcut).
#   hash_len    : 32 bayt (256-bit) çıktı.
#   salt_len    : 16 bayt (128-bit) PHC içinde rastgele tuz.
# ---------------------------------------------------------------------------
_ARGON2_TIME_COST = 3
_ARGON2_MEMORY_COST = 65536      # KiB == 64 MiB
_ARGON2_PARALLELISM = 4
_ARGON2_HASH_LEN = 32
_ARGON2_SALT_LEN = 16

# Parola giriş üst sınırı — argon2 kendi iç sınırına ulaşmadan önce reject.
MAX_PASSWORD_LENGTH = 1024

# Her zaman reddedilen, son derece yaygın parolalar (yerleşik asgari denylist).
_BUILTIN_DENYLIST = frozenset({
    "password", "password1", "123456", "12345678", "123456789", "1234567890",
    "qwerty", "qwerty123", "abc123", "iloveyou", "letmein", "welcome",
    "admin", "admin123", "administrator", "root", "toor", "passw0rd",
    "supernova", "nova", "111111", "000000", "123123", "dragon", "monkey",
})

_HASHLIKE_RE = re.compile(r"^[0-9a-f]{64}$")  # legacy sha256 hex (128-bit görünümlü)

try:
    from argon2 import PasswordHasher
    from argon2.exceptions import (
        InvalidHashError,
        VerificationError,
        VerifyMismatchError,
    )
    _ph = PasswordHasher(
        time_cost=_ARGON2_TIME_COST,
        memory_cost=_ARGON2_MEMORY_COST,
        parallelism=_ARGON2_PARALLELISM,
        hash_len=_ARGON2_HASH_LEN,
        salt_len=_ARGON2_SALT_LEN,
    )
except ImportError as exc:  # pragma: no cover - dağıtım hatası
    raise RuntimeError(
        "argon2-cffi kurulu değil. Yükleyin: pip install 'argon2-cffi>=23.1.0'"
    ) from exc


def _pepper() -> str:
    """config.ARGON2_PEPPER (boş olabilir). Yeni hash'lerde parolaya eklenir."""
    return config.ARGON2_PEPPER or ""


# ---------------------------------------------------------------------------
# Hashleme
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    """Parolayı argon2id ile hashler → PHC string. Boş girdi reddedilir."""
    if not password:
        raise ValueError("Parola boş olamaz.")
    return _ph.hash(_pepper() + password)


def is_argon2(stored: str) -> bool:
    return bool(stored) and stored.startswith("$argon2")


def is_legacy_sha256(stored: str) -> bool:
    return bool(stored) and bool(_HASHLIKE_RE.match(stored))


# ---------------------------------------------------------------------------
# Doğrulama + migrasyon sinyali
# ---------------------------------------------------------------------------

def verify(password: str, salt: str, stored_hash: str) -> tuple:
    """Parolayı doğrular.

    Dönüş: (ok: bool, needs_rehash: bool)
      ok          — parola doğru mu.
      needs_rehash— doğruysa ama saklanan değer legacy sha256 veya eski argon2
                    parametreleriyle üretilmişse True (çağıran argon2id'ye göç
                    için UPDATE yapmalı).
    """
    if not stored_hash or not password:
        return (False, False)

    if is_argon2(stored_hash):
        try:
            _ph.verify(stored_hash, _pepper() + password)
        except VerifyMismatchError:
            return (False, False)
        except (InvalidHashError, VerificationError):
            logger.warning("Bozuk argon2 hash doğrulaması atlandı.")
            return (False, False)
        # Parametre güncellemesi gerekiyor mu? (örn. memory_cost artırılınca)
        return (True, _ph.check_needs_rehash(stored_hash))

    # Legacy sha256(salt:password) — peper UYGULANMAZ (eski hash'ler peper'siz).
    if is_legacy_sha256(stored_hash):
        actual = hashlib.sha256(f"{salt or ''}:{password}".encode("utf-8")).hexdigest()
        if hmac.compare_digest(actual, stored_hash):
            return (True, True)  # geçerli ama argon2id'ye göç edilmeli
        return (False, False)

    # Tanınmayan format — güvenli tarafta reddet.
    logger.warning("Tanınmayan parola hash formatı; reddediliyor.")
    return (False, False)


def needs_rehash(stored_hash: str) -> bool:
    """Saklanan hash'in argon2id'ye (güncel parametrelere) göç edilmesi gerekir mi?"""
    if is_argon2(stored_hash):
        return _ph.check_needs_rehash(stored_hash)
    return True  # legacy → her zaman göç edilmeli


# ---------------------------------------------------------------------------
# Parola politikası (NIST SP 800-63B: uzunluk + ihlal/denylist)
# ---------------------------------------------------------------------------

_DENYLIST_CACHE: set = None  # type: ignore
_DENYLIST_MTIME = None


def _load_denylist() -> frozenset:
    """config.PASSWORD_DENYLIST dosyasını tembel/önbellekli yükler (satır=parola)."""
    global _DENYLIST_CACHE, _DENYLIST_MTIME
    path = (config.PASSWORD_DENYLIST or "").strip()
    pool = set(_BUILTIN_DENYLIST)
    if not path:
        return frozenset(pool)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        if _DENYLIST_CACHE is None:
            return frozenset(pool)
        return _DENYLIST_CACHE  # dosya kaybolduysa eski önbellekle devam
    if _DENYLIST_CACHE is not None and _DENYLIST_MTIME == mtime:
        return frozenset(pool | _DENYLIST_CACHE)
    extra = set()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                word = raw.strip().lower()
                if word:
                    extra.add(word)
    except OSError:
        logger.warning("Parola denylist okunamadı: %s", path)
    _DENYLIST_CACHE = extra
    _DENYLIST_MTIME = mtime
    logger.info("Parola denylist yüklendi (%d ek kayıt) from %s", len(extra), path)
    return frozenset(pool | extra)


def validate_password_policy(password: str, username: str = "") -> list:
    """Parolayı politikaya göre denetler.

    Dönüş: hata mesajları listesi (boş = geçerli). Çağıran bunları birleştirip
    istemciye döner.
    """
    issues = []
    if not password:
        issues.append("Parola boş olamaz.")
        return issues

    if len(password) > MAX_PASSWORD_LENGTH:
        issues.append(f"Parola en fazla {MAX_PASSWORD_LENGTH} karakter olmalı.")

    min_len = int(getattr(config, "PASSWORD_MIN_LENGTH", 12) or 12)
    if len(password) < min_len:
        issues.append(f"Parola en az {min_len} karakter olmalı.")

    # Karakter sınıfı çeşitliliği (4'ten en az 3): küçük/büyük/basamak/sembol.
    classes = sum([
        bool(re.search(r"[a-z]", password)),
        bool(re.search(r"[A-Z]", password)),
        bool(re.search(r"[0-9]", password)),
        bool(re.search(r"[^A-Za-z0-9]", password)),
    ])
    if classes < 3:
        issues.append("Parola küçük harf, büyük harf, rakam ve sembolden en az 3 türü içermeli.")

    # Denylist / yaygın parola kontrolü.
    if password.lower() in _load_denylist():
        issues.append("Bu parola çok yaygın; daha güçlü bir parola seçin.")

    # Kullanıcı adını içeremez (basamağı engeller).
    if username and username.lower() in password.lower() and len(username) >= 3:
        issues.append("Parola kullanıcı adını içeremez.")

    return issues
