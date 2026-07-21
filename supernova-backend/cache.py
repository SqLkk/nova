#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Process-içi, TTL'li (yaşam süresi) önbellek.

Tasarım notu (lisans güvenliği):
  - SADECE metadata (tablo adları, sütun tanımları) için kullanılır.
  - Kaynak DB'den satır verisi (row data) ASLA önbelleğe alınmaz.
  - Hiçbir şey diske / uygulama DB'sine yazılmaz — yalnızca RAM'de tutulur,
    process ölünce kaybolur. Bu, "veri çoğaltma" değil "geçici sorgu
    sonuç memoization" sayılır; lisans/EULA ihlali oluşturmaz.
  - Çok-işçili (gunicorn) kurulumda her işçi kendi önbelleğine sahiptir
    (paylaşımsız) — metadata için kabul edilebilir.
"""

import threading
import time


class TTLCache:
    def __init__(self, ttl: float = 60.0):
        self._ttl = ttl
        self._store: dict = {}
        self._lock = threading.Lock()

    def get(self, key: str):
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            value, expires_at = entry
            if time.time() > expires_at:
                self._store.pop(key, None)
                return None
            return value

    def set(self, key: str, value):
        with self._lock:
            self._store[key] = (value, time.time() + self._ttl)

    def invalidate(self, key: str | None = None):
        with self._lock:
            if key is None:
                self._store.clear()
            else:
                self._store.pop(key, None)

    def stats(self) -> dict:
        with self._lock:
            return {"entries": len(self._store), "ttl_seconds": self._ttl}


# Metadata önbelleği (tablo listeleri, sütun şemaları). TTL 60 sn.
metadata_cache = TTLCache(ttl=60.0)
