class Config:
    HMAC_SECRET_KEY = "supernova_secret_key"
    FLASK_SECRET_KEY = "supernova_flask_secret"
    CORS_ALLOWED_ORIGINS = "*"
    DEBUG = True
    
    # Generic Database Configuration
    DB_USER = "admin"
    DB_PASSWORD = "password123"
    DB_HOST = "localhost"
    DB_PORT = 5432
    
    # General API Configuration
    API_PORT = 5000
    MAX_ROWS_PER_REPORT = 50000

    # Lisans/EULA politikası: preview sırasında türetilen sütun şemasını
    # (columns_meta) uygulama DB'sine KALICI yazma. Varsayılan False =
    # kaynak DB'den türetilen metadata çoğaltılmaz (lisans-safe). True yapılırsa
    # eski davranış (kalıcı saklama) geri döner.
    PERSIST_QUERY_COLUMNS_META = False

    @staticmethod
    def get_db_config(name):
        return {"primary": {}, "standby": {}}

config = Config()
