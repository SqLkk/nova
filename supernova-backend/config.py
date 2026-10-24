#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Supernova merkezi konfigürasyonu — tüm gizli anahtarlar çevre değişkeninden
veya (geliştirme kolaylığı için) repo kökündeki .env dosyasından okunur.

Güvenlik (NIS2 Art.21(1)(h); ISO/IEC 27002:2022 A.8.24):
  * Hardcoded secret YOK. Üretimde tüm anahtarlar env/secret-manager'dan gelir.
  * production modunda Config.validate() eksik/zayıf anahtarı veya DEBUG=True'ı
    reddeder (fail-fast). development modunda eksik anahtar için geçici rastgele
    değer üretilir ve uyarılır (restart'ta oturumlar geçersiz olur — dev için kabul).

Kullanım:  from config import config   →   config.HMAC_SECRET_KEY
"""

import base64
import logging
import os
import secrets as _secrets

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# .env yükleme (python-dotenv olmadan, bağımlılıksız). Zaten set edilmiş gerçek
# çevre değişkenlerini EZMEZ (üretim env'i baskın).
# ---------------------------------------------------------------------------

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_BACKEND_DIR)


def _load_dotenv() -> None:
    candidates = []
    env_file = os.environ.get("NOVA_ENV_FILE")
    if env_file:
        candidates.append(env_file)
    candidates.append(os.path.join(_REPO_ROOT, ".env"))
    candidates.append(os.path.join(_BACKEND_DIR, ".env"))

    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for raw in fh:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
            logger.info("Loaded environment from %s", path)
            return  # ilk bulunan .env yeterli
        except OSError:
            continue


_load_dotenv()


# ---------------------------------------------------------------------------
# Çevre değişkeni yardımcıları
# ---------------------------------------------------------------------------

def _str(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning("Geçersiz tamsayı için %s=%r; varsayılan %d kullanılıyor.", name, raw, default)
        return default


def _bool(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
        return value if value == value and abs(value) != float('inf') else default
    except (TypeError, ValueError):
        return default


def _list(name: str, default: list) -> list:
    raw = os.environ.get(name)
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


def _rand_urlsafe(nbytes: int = 48) -> str:
    return _secrets.token_urlsafe(nbytes)


def _rand_fernet() -> str:
    return base64.urlsafe_b64encode(_secrets.token_bytes(32)).decode("ascii")


# ---------------------------------------------------------------------------
# Konfigürasyon
# ---------------------------------------------------------------------------

_DEV_ORIGINS = [
    "http://localhost:4201", "http://127.0.0.1:4201",
    "http://localhost:4200", "http://127.0.0.1:4200",
]


class Config:
    def __init__(self):
        # --- Çalışma modu ---
        self.ENV = _str("NOVA_ENV", "development").lower().strip()
        self.IS_PRODUCTION = self.ENV in ("production", "prod")
        self.IS_STAGING = self.ENV in ("staging", "stage")
        self.IS_DEVELOPMENT = self.ENV in ("development", "dev", "local")
        self._strict = self.IS_PRODUCTION or self.IS_STAGING

        # --- Kriptografik anahtarlar ---
        self.HMAC_SECRET_KEY = self._secret("NOVA_HMAC_SECRET", min_len=32)
        self.FLASK_SECRET_KEY = self._secret("NOVA_FLASK_SECRET", min_len=32)
        self.DATA_SECRETS_KEY = self._secret_fernet("NOVA_DATA_SECRETS_KEY")
        self.ARGON2_PEPPER = os.environ.get("NOVA_ARGON2_PEPPER", "")  # opsiyonel

        # --- CORS / ağ ---
        self.CORS_ALLOWED_ORIGINS = _list(
            "NOVA_CORS_ORIGINS", _DEV_ORIGINS if self.IS_DEVELOPMENT else [])
        self.DEBUG = _bool("NOVA_DEBUG", self.IS_DEVELOPMENT)
        self.BIND_HOST = _str("NOVA_BIND_HOST", "127.0.0.1")
        self.BIND_PORT = _int("NOVA_BIND_PORT", 5001)
        self.API_PORT = self.BIND_PORT  # geri uyumluluk
        self.TRUSTED_PROXY_HOPS = _int("NOVA_TRUSTED_PROXY_HOPS", 1)

        # --- HSTS (yalnızca TLS arkasında) ---
        self.HSTS_ENABLED = _bool("NOVA_HSTS_ENABLED", self.IS_PRODUCTION)
        self.HSTS_MAX_AGE = _int("NOVA_HSTS_MAX_AGE", 31536000)

        # --- Oturum / token ---
        self.TOKEN_ACCESS_TTL = _int("NOVA_TOKEN_ACCESS_TTL", 900)       # 15 dk
        self.TOKEN_REFRESH_TTL = _int("NOVA_TOKEN_REFRESH_TTL", 28800)   # 8 saat

        # --- Şifre politikası ---
        self.PASSWORD_MIN_LENGTH = _int("NOVA_PASSWORD_MIN_LENGTH", 12)
        self.PASSWORD_DENYLIST = os.environ.get("NOVA_PASSWORD_DENYLIST", "")

        # --- Rate limiting ---
        self.RATELIMIT_STORAGE_URI = _str(
            "NOVA_RATELIMIT_STORAGE_URI",
            "redis://localhost:6379/nova" if self._strict else "memory://")
        # Tüm uç noktalar: IP başına dakika (DoS tabanı). Üretimde paylaşımlı redis
        # olmadan memory:// worker başına ayrı sayar — yalnızca development.
        self.RATELIMIT_GLOBAL_PER_MIN = _int("NOVA_RATELIMIT_GLOBAL_PER_MIN", 300)
        # /api/auth/login: IP başına dakika (kaba kuvvet tabanı).
        self.RATELIMIT_LOGIN_PER_MIN = _int("NOVA_RATELIMIT_LOGIN_PER_MIN", 10)
        self.LOGIN_MAX_ATTEMPTS = _int("NOVA_LOGIN_MAX_ATTEMPTS", 5)
        self.LOGIN_WINDOW_SECONDS = _int("NOVA_LOGIN_WINDOW_SECONDS", 300)
        self.LOGIN_LOCKOUT_SECONDS = _int("NOVA_LOGIN_LOCKOUT_SECONDS", 900)

        # --- Denetim logu ---
        self.AUDIT_LOG_RETENTION_DAYS = _int("NOVA_AUDIT_LOG_RETENTION_DAYS", 365)

        # --- Sandbox ---
        self.SANDBOX_USER = os.environ.get("NOVA_SANDBOX_USER", "")

        # --- Genel DB (vestiyal; app DB SQLite) ---
        self.DB_USER = os.environ.get("NOVA_DB_USER", "")
        self.DB_PASSWORD = os.environ.get("NOVA_DB_PASSWORD", "")
        self.DB_HOST = os.environ.get("NOVA_DB_HOST", "localhost")
        self.DB_PORT = _int("NOVA_DB_PORT", 5432)

        # --- Rapor/veri davranışı (mevcut arayüz korunur) ---
        self.MAX_ROWS_PER_REPORT = _int("NOVA_MAX_ROWS_PER_REPORT", 50000)
        # Lisans-safe: preview sırasında türetilen sütun şemasını app DB'sine
        # kalıcı yazma. False = kaynak DB verisi çoğaltılmaz.
        self.PERSIST_QUERY_COLUMNS_META = _bool("NOVA_PERSIST_QUERY_COLUMNS_META", False)
        # Demo parola reset'i yalnızca development'ta. production/staging'de kapalı.
        self.RESET_DEMO_PASSWORDS = _bool("NOVA_RESET_DEMO_PASSWORDS", self.IS_DEVELOPMENT)

        # --- Tak-çıkar yerel AI; başlangıçta modele bağlantı kurulmaz. ---
        self.AI_ENABLED = _bool("AI_ENABLED", False)
        self.AI_PROVIDER = _str("AI_PROVIDER", "openai").lower()
        self.AI_BASE_URL = _str("AI_BASE_URL", "http://localhost:11434/v1").rstrip('/')
        self.AI_MODEL_NAME = _str("AI_MODEL_NAME", "qwen3.5:9b")
        self.AI_API_KEY = _str("AI_API_KEY", "")
        self.AI_TEMPERATURE = max(0.0, min(2.0, _float("AI_TEMPERATURE", 0.2)))
        self.AI_TIMEOUT_SECONDS = max(1.0, min(300.0, _float("AI_TIMEOUT_SECONDS", 120)))
        self.AI_MAX_TOKENS = max(128, min(8192, _int("AI_MAX_TOKENS", 2048)))
        self.AI_MAX_CONCURRENT = max(1, min(8, _int("AI_MAX_CONCURRENT", 2)))
        self.AI_MEMORY_ENABLED = _bool("AI_MEMORY_ENABLED", True)
        self.AI_TOOLS_ENABLED = _bool("AI_TOOLS_ENABLED", True)
        # Mock açıkça development'ta etkinleştirilir; gerçek modelmiş gibi sunulmaz.
        self.AI_MOCK_MODE = _bool("AI_MOCK_MODE", False) and self.IS_DEVELOPMENT

        # Fail-fast doğrulama (en sonda).
        self.validate()

    # --- Gizli anahtar çözümleme (strict modda fail-fast, dev'de ephemeral) ---
    def _secret(self, name: str, min_len: int = 32) -> str:
        val = os.environ.get(name, "").strip()
        if val:
            if len(val) < min_len:
                if self._strict:
                    raise RuntimeError(
                        f"{name} çok kısa (min {min_len} karakter). Güçlü bir anahtar üretin: "
                        f"python3 scripts/generate_secret.py")
                logger.warning("%s zayıf (uzunluk %d < %d).", name, len(val), min_len)
            return val
        if self._strict:
            raise RuntimeError(
                f"{name} tanımlı değil. .env/secret-manager'a güçlü bir anahtar koyun: "
                f"python3 scripts/generate_secret.py")
        # Geliştirme: geçici rastgele anahtar (restart'ta oturumlar geçersiz olur).
        ephemeral = _rand_urlsafe(48)
        logger.warning(
            "%s tanımlı değil; geliştirme için GEÇİCİ rastgele anahtar üretildi. "
            "Restart'ta tüm oturumlar geçersiz olur. Üretimde KULLANMAYIN.", name)
        return ephemeral

    def _secret_fernet(self, name: str) -> str:
        val = os.environ.get(name, "").strip()
        if val:
            return val
        if self._strict:
            raise RuntimeError(
                f"{name} tanımlı değil. Fernet anahtarı üretin: "
                f"python3 scripts/generate_secret.py --fernet")
        ephemeral = _rand_fernet()
        logger.warning(
            "%s tanımlı değil; geliştirme için GEÇİCİ Fernet anahtarı üretildi. "
            "Daha önce şifrelenmiş datasource kimlik bilgileri çözülemeyebilir.", name)
        return ephemeral

    def validate(self) -> None:
        """Üretim zorunlu güvenlik kontrolleri. Geçersizse RuntimeError fırlatır."""
        problems = []
        if self._strict:
            if self.DEBUG:
                problems.append("DEBUG üretimde açık olamaz (Werkzeug debugger RCE riski).")
            if "*" in self.CORS_ALLOWED_ORIGINS or not self.CORS_ALLOWED_ORIGINS:
                problems.append("CORS_ALLOWED_ORIGINS üretimde joker içermemeli ve boş olmamalı.")
            if self.BIND_HOST == "0.0.0.0":
                problems.append("BIND_HOST üretimde 0.0.0.0 olmamalı (reverse proxy arkası 127.0.0.1).")
            if self.RESET_DEMO_PASSWORDS:
                problems.append("RESET_DEMO_PASSWORDS üretimde kapalı olmalı.")
        # HMAC/Flask/Fernet anahtarları _secret/_secret_fernet içinde doğrulanır.
        if problems:
            raise RuntimeError("Güvenlik yapılandırması geçersiz:\n  - " + "\n  - ".join(problems))

    def get_db_config(self, name: str) -> dict:
        """Geri uyumluluk için; app DB SQLite kullanır."""
        return {"primary": {}, "standby": {}}


config = Config()
