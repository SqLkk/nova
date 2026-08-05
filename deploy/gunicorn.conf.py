# -*- coding: utf-8 -*-
"""Gunicorn üretim yapılandırması — Supernova (nova) API.

Çalıştırma:
  gunicorn -c deploy/gunicorn.conf.py 'api_server:app'

  Not: api_server modülü 'supernova-backend' içindedir; kök dizinden değil
  supernova-backend içinden başlatıyorsanız yolu ayarlayın veya PYTHONPATH'e ekleyin.

Tüm gizli anahtarlar ve bağlanma adresi config.py / çevre değişkeninden gelir
(.env veya secret manager). Burada hardcoded secret YOK (NIS2 Art.21(1)(h);
ISO/IEC 27002:2022 A.8.24). config.py, worker fork'undan önce .env'i yükler.

Flask yerleşik dev sunucusunu (app.run/debug=True) üretimde KULLANMAYIN:
Werkzeug debugger RCE riski taşır. Bu dosyayı kullanın.
"""

import multiprocessing
import os

from config import config

# --- Bağlanma adresi ---------------------------------------------------------
# Reverse proxy (nginx) arkasında 127.0.0.1 önerilir; config.validate() üretimde
# 0.0.0.0'ı reddeder. Dışa açık port doğrudan bağlanmaz.
bind = [f"{config.BIND_HOST}:{config.BIND_PORT}"]

# --- Worker sayısı -----------------------------------------------------------
# CPU başına 2 + 1 (gunicorn önerisi). Senkron worker: istekler I/O ağırlıklı
# (DB/rapor) ve her istek kendi SQLite bağlantısını açar.
workers = int(os.environ.get("NOVA_GUNICORN_WORKERS", multiprocessing.cpu_count() * 2 + 1))
worker_class = "sync"
threads = 1

# --- Süre aşımı --------------------------------------------------------------
# Uzun rapor işleme payı (varsayılan 120 sn). Üst sınır app katmanında
# MAX_CONTENT_LENGTH (10 MiB) ile zaten sınırlı.
timeout = int(os.environ.get("NOVA_GUNICORN_TIMEOUT", 120))
graceful_timeout = 30
keepalive = 5

# --- DoS: istek satırı / başlık sınırları -----------------------------------
# Varsayılan gunicorn değerleri; ayrıca uygulama MAX_CONTENT_LENGTH'i 10 MiB ile
# gövde boyutunu sınırlar (413 → global errorhandler).
limit_request_line = 8190          # istek satırı (URL) byte
limit_request_field_size = 8190    # tek başlık byte
limit_request_fields = 100         # başlık sayısı

# --- Reverse proxy güveni ----------------------------------------------------
# Yalnızca bu IP'lerden gelen X-Forwarded-* kabul edilir. Uygulamadaki ProxyFix
# (config.TRUSTED_PROXY_HOPS) ile birlikte gerçek IP/şema/host çözümlenir.
# Tek nginx arkasında "127.0.0.1". Joker ("*") güvenlik açısından kullanmayın.
forwarded_allow_ips = os.environ.get("NOVA_GUNICORN_TRUSTED_PROXIES", "127.0.0.1")

# --- Önyükleme ---------------------------------------------------------------
# Uygulamayı worker fork'undan ÖNCE import et: daha hızlı başlangıç + paylaşılan
# bellek. Her istek yine kendi SQLite bağlantısını açtığı için fork güvenli.
preload_app = True

# --- Süreç / günlük ----------------------------------------------------------
# Daemon DEĞİL: systemd / container süreç yöneticisi (PID 1) altında çalışır.
daemon = False
# Günlükleri stdout/stderr'e yaz (kapsayıcı/sistem günlüğü toplar).
accesslog = "-"
errorlog = "-"
loglevel = "warning" if config.IS_PRODUCTION else "info"
capture_output = True
proc_name = "nova-api"

# --- Güvenlik: öntanımlı ayarlar --------------------------------------------
# Hata sayfalarında sunucu imzası açma. Gunicorn çıktısını bastır.
# (default_app_module None kalır; WSGI app komut satırından verilir.)
