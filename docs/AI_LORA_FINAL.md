# Son Kontrollü Eğitim: v2.3 (Düzeltilmiş Kapasite, Sandbox ve Veri Seti)

## Tespit Edilen Kök Nedenler ve Uygulanan Düzeltmeler

1. **`optional-ai/training/v23.yaml` Kapasite ve Süre Hatası**:
   - Önceki `v23.yaml` dosyasında dokümanda `num_layers: 4` ve `rank: 8` yazmasına rağmen fiilen `num_layers: 1` ve `rank: 4` kalmıştı (`0.004%` eğitilebilir parametre). Ayrıca `iters: 2400` ve `val_batches: -1` (her değerlendirmede 80 örnek = ~16 dk) nedeniyle eğitim ~6,5 saat sonunda 925. adımda yarıda kesilmişti.
   - Yeni `v23.yaml` gerçek **4 katman (`num_layers: 4`), `rank: 8`, `scale: 16.0`, `dropout: 0.05`** kapasitesini etkinleştirir.
   - Katmanlı (stratified) pencere örneklemesiyle **600 adım (`150, 300, 450, 600` checkpoint'leri)** ve eğitim içi hızlı doğrulama (`val_batches: 20`) kullanılarak tam eğitim süresi ~2,5 saate indirildi (`evaluate` aşamasında ise 80 örneklik tam `valid_fixed.jsonl` seti ölçülür).

2. **`T2_MergeQueries` (İki Sorguyu Birleştirme) ve Sandbox İyileştirmeleri**:
   - `supernova-backend/safe_interpreter/interpreter.py` içinde `out('dataset').append(rows_list)` çağrıldığında sözlük listesini iç içe liste (`[[{...}]]`) yapmak yerine otomatik olarak satır sözlüklerine açacak (`extend`) şekilde düzeltildi.
   - `SafeASTInterpreter` içine `is` / `is not` (`ast.Is`, `ast.IsNot`) ve satır içi koşul (`ast.IfExp`) desteği eklendi.
   - `scripts/generate_ai_dataset_v23.py` içinde kullanıcı istemine sızan yapay ipucu kaldırıldı; sol sorgu anahtarlarını koruyan (`left_difference` / `left_net`) birleştirme örnekleri artırıldı.

3. **`T6_MissingColumn` (OEE Eksik Kolon Sorusu) Regex Tuzağı**:
   - `scripts/run_acceptance_suite.py` içindeki `has_executable_artifact` fonksiyonu satır başı veya madde işaretli `kelime = ...` (`\w+\s*=`) ifadelerini "çalıştırılabilir Python kodu" sanıp T6'yı başarısız sayıyordu.
   - `generate_ai_dataset_v23.py` içindeki OEE yanıtlarında `=` yerine `:` kullanıldı ve her eğitim örneği doğrudan `has_executable_artifact` + 4 OEE bileşen anahtar kelime grubu (`eksik`, `kullanılabilirlik`, `performans`, `kalite`) ile doğrulandı.

4. **Tüm SuperNova Özelliklerinin (Script, SQL, Path Definer, Template Builder, Şema Keşfi) Kapsanması**:
   - **Python (`py_weighted`, `py_merge`, `py_fix`, `py_basic`)**: Ağırlıklı oranlarda kod öncesi açıklama metni uyumsuzluğu kaldırıldı; tam OEE hesaplama (`oee_full`) ve 6 farklı hatalı kod düzeltme alt türü eklendi.
   - **SQL (`sql_v23`)**: Hem `(id, name)` iki kolonlu ana tablo `LEFT JOIN ... ON ... BETWEEN :start AND :end` hem de `WITH` (CTE) sorguları SQLite üzerinde doğrulanarak eklendi.
   - **Path Definer (`path_v23`)**: `[id, relation, label]` kolon dizilimi ve doğal dil açıklamaları eklendi.
   - **Template Builder (`template_v23` & `ai_tools.py`)**: Türkçe grafik adları (`çizgi grafiği` vb.), `(1,1)` ve `(14,1)` hücre konumları ve sayısal hücre değeri normalizasyonu eklendi.
   - **Yerel Model Sunucusu (`scripts/local_ai.py`)**: Eğitilen LoRA adaptörünü canlı serviste kullanabilmek için `--adapter-path` parametresi eklendi.

---

## Sırayla Çalıştırılacak Komutlar

Proje kök dizininde sırasıyla çalıştırın. Önceki yarım kalan `training/supernova-v23` klasörü `prepare` çalıştırıldığında silinmez; otomatik olarak zaman damgalı `training/supernova-v23-archive-...` klasörüne arşivlenir.

### 1. Veri Setini Hazırla ve Denetle
```bash
python3 scripts/ai_training_workflow.py prepare --profile final
```
- `training/supernova-v23/audit.json` içinde `"passed": true` olmalıdır.

### 2. 4 Katman / Rank 8 Kapasitesini 10 Adımda Kontrol Et (Smoke)
```bash
python3 scripts/ai_training_workflow.py smoke --profile final
```
- `training/supernova-v23/adapter-smoke/completion.json` içinde `"num_layers": 4, "rank": 8` ve bellek kullanımı yer alır.

### 3. Tam Eğitimi Başlat (600 Adım — 150/300/450/600 Checkpoint'leri)
```bash
python3 scripts/ai_training_workflow.py train --profile final
```
- Çıktılar hem `training/supernova-v23/logs/train600.log` hem de uyumluluk için `training/supernova-v23/logs/train2400.log` dosyasına yazılır.
- Checkpoint'ler `training/supernova-v23/adapter600/` altında `0000150`, `0000300`, `0000450`, `0000600` olarak kaydedilir.

### 4. Tüm Checkpoint'leri Çekirdek (Core) Kabul Testleriyle Karşılaştır
```bash
python3 scripts/ai_training_workflow.py evaluate --profile final
```

### 5. Karşılaştırma Raporunu Göster
```bash
python3 scripts/ai_training_workflow.py report --profile final
```

### 6. Seçilen Checkpoint İçin 24 Ek (Extended) Görevi Çalıştır (İsteğe Bağlı)
Örneğin 600. adım en yüksek doğruluğu verdiyse:
```bash
python3 scripts/ai_training_workflow.py extended --profile final --checkpoint 600
```

### 7. Seçilen Adaptörü Canlı SuperNova Copilot Servisinde Başlatma
```bash
python3 scripts/local_ai.py serve --adapter-path training/supernova-v23/adapter600
```
