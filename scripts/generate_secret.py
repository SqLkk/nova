#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Güçlü rastgele kriptografik anahtarlar üretir.

Kullanım:
  python3 scripts/generate_secret.py             # url-safe base64 (HMAC/Flask)
  python3 scripts/generate_secret.py --fernet     # Fernet anahtarı (datasource-at-rest)
  python3 scripts/generate_secret.py --pepper     # Argon2 peper
  python3 scripts/generate_secret.py --all        # hepsini .env formatında

Bu betik yalnızca standart kütüphane kullanır; `secrets` modülü CSPRNG'dir.
Çıktıyı kopyalayıp .env içine yapıştırın. .env asla commit edilmez.
"""

import argparse
import base64
import os
import sys


def gen_urlsafe(num_bytes: int = 48) -> str:
    """URL güvenli base64 (HMAC/Flask secret için)."""
    import secrets
    return secrets.token_urlsafe(num_bytes)  # ~64 karakter


def gen_fernet() -> str:
    """Fernet anahtarı: 32 url-safe base64 bayt (cryptography.fernet formatı)."""
    import secrets
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")


def gen_pepper(num_bytes: int = 32) -> str:
    """Argon2 peper (şifre hash için ek gizli)."""
    import secrets
    return secrets.token_urlsafe(num_bytes)


def main() -> int:
    parser = argparse.ArgumentParser(description="Güçlü kriptografik anahtar üretici")
    parser.add_argument("--fernet", action="store_true", help="Fernet anahtarı üret")
    parser.add_argument("--pepper", action="store_true", help="Argon2 peper üret")
    parser.add_argument("--all", action="store_true", help="Tüm anahtarları .env formatında üret")
    parser.add_argument("--bytes", type=int, default=48, help="URL-safe anahtar bayt sayısı (varsayılan 48)")
    args = parser.parse_args()

    if args.all:
        print("# .env dosyanıza kopyalayın. Üretimde tek tek rotate edebilirsiniz.")
        print(f"NOVA_HMAC_SECRET={gen_urlsafe(args.bytes)}")
        print(f"NOVA_FLASK_SECRET={gen_urlsafe(args.bytes)}")
        print(f"NOVA_DATA_SECRETS_KEY={gen_fernet()}")
        print(f"NOVA_ARGON2_PEPPER={gen_pepper()}")
        return 0

    if args.fernet:
        print(gen_fernet())
    elif args.pepper:
        print(gen_pepper())
    else:
        print(gen_urlsafe(args.bytes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
