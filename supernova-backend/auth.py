#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Token tabanlı kimlik doğrulama yardımcıları.

HMAC-SHA256 ile imzalanmış, base64url kodlanmış, JWT-benzeri bearer token.
Harici bağımlılık yok (PyJWT gerekmez). config.HMAC_SECRET_KEY kullanır.

Token formatı:  <base64url(payload)>.<base64url(hmac)>

Payload: {"uid", "u" (username), "role", "iat", "exp"}
"""

import base64
import hashlib
import hmac
import json
import secrets as _secrets
import time

from config import config
import passwords as _pw  # argon2id + legacy sha256 doğrulama/migrasyon

_SECRET = (config.HMAC_SECRET_KEY or "").encode("utf-8")
if not config.HMAC_SECRET_KEY:
    # Boş secret_production'da olmamalı; burada sadece uyarı.
    raise RuntimeError("config.HMAC_SECRET_KEY boş olamaz.")

# Erişim token ömrü kısa (varsayılan 15 dk); süre dolumunda istemci refresh ile
# yeniler. config.TOKEN_ACCESS_TTL (saniye).
_TOKEN_TTL = int(getattr(config, "TOKEN_ACCESS_TTL", 900))


def _b64(data: bytes) -> str:
    """bytes -> base64url (padding'siz)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _ub64(s: str) -> bytes:
    """base64url (padding'siz) -> bytes."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def hash_password(password: str, salt: str = None) -> str:
    """argon2id PHC string döndürür. (salt geri uyumluluk için yok sayılır —
    argon2id tuzunu PHC içinde üretir.) Detay için passwords.hash_password."""
    return _pw.hash_password(password)


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    """Parolayı doğrular (argon2id + legacy sha256). Rehash ihtiyacını bildirmez;
    göç sinyali gerekiyorsa doğrudan passwords.verify() kullanın."""
    ok, _needs_rehash = _pw.verify(password, salt, expected_hash)
    return ok


def create_token(user_id: str, username: str, role: str, level: int = 0, ttl: int = _TOKEN_TTL) -> str:
    now = int(time.time())
    payload = {
        "uid": user_id,
        "u": username,
        "role": role,
        "level": level,
        "iat": now,
        "exp": now + ttl,
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64(hmac.new(_SECRET, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_token(token: str) -> dict | None:
    """Token'ı doğrula; geçerliyse payload, değilse None döndür."""
    if not token or "." not in token:
        return None
    try:
        body, sig = token.split(".", 1)
        expected = _b64(hmac.new(_SECRET, body.encode("ascii"), hashlib.sha256).digest())
        # Sabit zamanlı karşılaştırma (timing attack koruması).
        if not hmac.compare_digest(expected, sig):
            return None
        payload = json.loads(_ub64(body))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Refresh token (Faz 4) — opak, DB'de HASH olarak saklanır.
# ---------------------------------------------------------------------------
# Erişim token'ı stateless ve kısa ömürlüdür; refresh token ise DB tarafında
# doğrulanır, her kullanımda DÖNDÜRÜLÜR (rotation) ve yeniden kullanım tüm aileyi
# iptal eder (token theft mitigation). Token'ın kendisi DB'ye YAZILMAZ; yalnızca
# sha256(token) saklanır → DB sızıntısında token kullanılamaz.

def create_refresh_token() -> tuple:
    """Yeni opak refresh token üretir.

    Dönüş: (token, token_hash)
      token      — istemciye verilecek opak string (DB'ye YAZILMAZ).
      token_hash — DB'ye saklanacak sha256(token).
    """
    token = _secrets.token_urlsafe(48)
    return token, hash_refresh_token(token)


def hash_refresh_token(token: str) -> str:
    """Opak refresh token'ın sha256 özetini döndürür (DB aramaları için)."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()
