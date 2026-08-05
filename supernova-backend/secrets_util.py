#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bekleyen veri (at-rest) şifreleme yardımcıları — datasource kimlik bilgileri gibi
hassas alanların SQLite içinde Fernet (AES-128-CBC + HMAC-SHA256) ile şifrelenmesi.

NIS2 Art.21(1)(h); ISO/IEC 27002:2022 A.8.24.

Geçiş (migration): şifreli değerler `fernet:` önekiyle saklanır. Öneksiz değerler
eski düz metin olarak kabul edilir ve olduğu gibi döndürülür — böylece mevcut
datasource satırları bir sonraki yazımda kademeli olarak şifrelenir.

Anahtar: config.DATA_SECRETS_KEY (Fernet base64 32 bayt). Anahtar rotate edilirse
eski değerler çözülemez (bu durumda güvenli tarafta boş döndürülür + loglanır).
"""

import logging

from config import config

logger = logging.getLogger(__name__)

_FERNET_PREFIX = "fernet:"
_fernet = None


def _get_fernet():
    """Fernet örneğini ilk kullanımda kurar (cryptography bağımlılığını tembel yükler)."""
    global _fernet
    if _fernet is None:
        from cryptography.fernet import Fernet
        _fernet = Fernet(config.DATA_SECRETS_KEY.encode("utf-8"))
    return _fernet


def encrypt_secret(plaintext: str) -> str:
    """Düz metni şifreler → 'fernet:<token>'. Boş girdi boş döner (DB default '')."""
    if plaintext is None or plaintext == "":
        return ""
    try:
        f = _get_fernet()
        token = f.encrypt(plaintext.encode("utf-8")).decode("ascii")
        return _FERNET_PREFIX + token
    except Exception:
        logger.exception("Şifreleme başarısız; düz metin ASLA saklanmaz — hata fırlatılıyor.")
        raise


def decrypt_secret(stored: str) -> str:
    """Şifreli değeri çözer. Öneksiz (eski düz metin) değerleri olduğu gibi döndürür
    (kademeli migration). Çözümleme başarısız olursa güvenli tarafta boş döner."""
    if not stored:
        return ""
    if not stored.startswith(_FERNET_PREFIX):
        # Legacy düz metin — olduğu gibi döndür (bir sonraki yazımda şifrelenir).
        return stored
    try:
        f = _get_fernet()
        token = stored[len(_FERNET_PREFIX):].encode("ascii")
        return f.decrypt(token).decode("utf-8")
    except Exception:
        logger.warning("Datasource kimlik bilgisi çözülemedi (anahtar rotate mi?). Boş döndürülüyor.")
        return ""


def is_encrypted(stored: str) -> bool:
    return bool(stored) and stored.startswith(_FERNET_PREFIX)
