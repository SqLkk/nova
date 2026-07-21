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
import time

from config import config

_SECRET = (config.HMAC_SECRET_KEY or "").encode("utf-8")
if not config.HMAC_SECRET_KEY:
    # Boş secret_production'da olmamalı; burada sadece uyarı.
    raise RuntimeError("config.HMAC_SECRET_KEY boş olamaz.")

_TOKEN_TTL = 12 * 3600  # 12 saat


def _b64(data: bytes) -> str:
    """bytes -> base64url (padding'siz)."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _ub64(s: str) -> bytes:
    """base64url (padding'siz) -> bytes."""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def hash_password(password: str, salt: str) -> str:
    """database._hash_password ile aynı algoritma — sha256(salt:password)."""
    return hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()


def verify_password(password: str, salt: str, expected_hash: str) -> bool:
    actual = hash_password(password, salt or "")
    return hmac.compare_digest(actual, expected_hash or "")


def create_token(user_id: str, username: str, role: str, ttl: int = _TOKEN_TTL) -> str:
    now = int(time.time())
    payload = {
        "uid": user_id,
        "u": username,
        "role": role,
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
