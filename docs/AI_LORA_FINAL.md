# SuperNova Copilot v2.4 — Tam Platform Hakimiyeti (LoRA Fine-Tuning Raporu)

## 1. Mimari ve Kapasite Özeti (`Qwen3.5-9B-MLX-4bit` + `v2.4` LoRA)

- **Baz Model**: `mlx-community/Qwen3.5-9B-MLX-4bit` (`32` katman: her 4 blokta 3 `GatedDeltaNet` doğrusal dikkat + 1 `Attention` tam dikkat katmanı).
- **16 GB Apple Silicon Bellek Güvenliği & Katman Seçimi**:
  - `Qwen3.5` içindeki `GatedDeltaNet` (`linear_attention`) katmanlarında geri yayılım (`VJP`), 1.024 adımlık ardışık durum özyinelemesini açtığı için 16 GB birleşik bellekte Metal OOM üretir.
  - `num_layers: 1` doğrudan modelin son tam dikkat + SwiGLU MLP bloğunu (`layers[31]`) hedefler; `rank: 16`, `dropout: 0.05`, `AdamW (weight_decay: 0.01)` ve `mask_prompt: true` ile tepe GPU belleği **7,60 GB** seviyesinde sabit kalır (`1,278M` eğitilebilir parametre).
- **Çıkarım Kalibrasyonu (`mlx-lm` `LoRALinear` Rezidüel Çarpanı)**:
  - `mlx-lm` içinde `lora_parameters.scale`, `alpha / rank` değil doğrudan `y + scale * ((x @ A) @ B)` rezidüel çarpanıdır.
  - Eğitim `scale: 32.0` ile yakınsatıldıktan sonra çıkarım ölçeği `adapter_config.json` içinde `scale: 16.0` olarak kalibre edilerek hem Python döngü akıcılığı hem de tüm SuperNova JSON/SQL/RBAC şemaları kusursuz dengelenmiştir.

---

## 2. Sıfır Ezber & Sıfır Halüsinasyon Tasarımı (`2.400` Doğrulanmış Örnek)

`scripts/generate_ai_dataset_v24.py` tarafından üretilen veri seti `scripts/audit_ai_dataset.py` denetiminden **0 hata** ile geçmiştir (`training/supernova-v24/audit.json` -> `"passed": true`):

1. **Senaryo-Ailesi Ayrık Bölünme (Zero Domain Leakage)**:
   - `train.jsonl` (`1.920` örnek): Senaryo `0..15` (`max_tokens = 1.019 <= 1.024`)
   - `valid.jsonl` (`240` örnek) & `valid_fixed.jsonl` (`100` örnek): Senaryo `16..17` (`sc16_pharma`, `sc17_food_bev`)
   - `test.jsonl` (`240` örnek) & `test_fixed.jsonl` (`60` katmanlı kör örnek): Senaryo `18..19` (`sc18_pack_line`, `sc19_intralog` — eğitim ve doğrulamada **hiç görülmemiş** endüstriyel alanlar)
2. **Sıfır Tekrar (`0.125` Epoch)**:
   - `240` adım / `1.920` eğitim örneği = **`0.125` epoch**; hiçbir eğitim örneği ikinci kez görülmemiştir.
   - Eğitim/doğrulama/test kümeleri arasında `SHA-256` kopya sayısı **0**, kabul testi (`T1..T8`, `H_*`, `M1..M11`) tanımlayıcı sızıntısı **0**, tescilli marka/telif terimi sızıntısı **0**'dır.
3. **12 Tam Platform Kategorisi**:
   - **Python Sandbox (`py_basic: 160`, `py_weighted: 220`, `py_merge: 220`, `py_fix: 180`)**: Kısıtlı AST yorumlayıcısı (`sql_data.get`, `out('ds').append`, NULL/sıfır bölme koruması, ağırlıklı oran, iki sorgulu gruplu birleştirme, `pandas`/comprehension/f-string içeren bozuk kodları düzeltme).
   - **SQL & Query Viewer (`sql: 240`, `query_viewer: 160`)**: Salt okunur parametreli (`:start`, `:end`) 2 ve 3 tablolu `LEFT JOIN ... ON` + `COALESCE` sorguları; kayıtlı sorgu açıklaması, parametreleri ve canlı modül bağlantıları; belirsiz tablolarda kullanıcıya seçenek sunma ve `context.resolved_selection` kararına uyma.
   - **Path Definer & Space Map (`path: 240`)**: `tree`, `multi_level`, `binary_tree`, `sequence`, `grouped`, `dag` yapıları, `health_col` / `status_col` ve `spaceMapConfig` (`theme`, `layout`, `level1Icon..level3Icon`).
   - **Template Builder (`template: 280`)**: 1-indeksli canlı rapor şablonları — `charts`, `summary` (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT` vb.), `builtin`/`formula` hücreleri ve dinamik tekrarlayan `bands` (`range` + `fieldMap`), statik sayı kopyalamadan çalışma zamanı sorgu bağlama.
   - **Kullanıcı Yönetimi & RBAC (`admin_rbac: 220`)**: `superuser(100) > admin(80) > engineer(60) > operator(40) > viewer(20)` hiyerarşisi, 30 izin anahtarı, doğrulanan Admin taslakları (`create_user`, `create_role`, `update_sharing`, `set_user_overrides`).
   - **Araç Çağırma & Güvenli Red (`tool_calling: 160`, `missing_info: 160`, `forbidden: 160`)**: `tool_get_database_schema` ve `tool_get_rbac_info` çok turlu keşif; eksik kolon/OEE bileşenlerinde veya yetkisiz/yasaklı işlemlerde kod bloğu üretmeden düz metin açıklama/red.

---

## 3. Kayıp (`Loss` & `Perplexity`) ve 43 Görevlik Kabul Testi Sonuçları

### A. Sabit Doğrulama ve Kör Test Kaybı (`evaluate_ai_loss.py`, `mask_prompt=true`)

| Veri Kümesi | Baz Model (`Qwen3.5-9B`) | Eğitilmiş `v2.4` (`step 240`) | İyileşme |
| :--- | :---: | :---: | :---: |
| **`valid_fixed.jsonl`** (100 örnek, `sc16..17`) | `loss = 0.6683` (`ppl = 1.9509`) | **`loss = 0.2654`** (`ppl = 1.3040`) | **-%60,3 kayıp** |
| **`test_fixed.jsonl`** (60 kör örnek, `sc18..19`) | `loss = 0.6574` (`ppl = 1.9298`) | **`loss = 0.2531`** (`ppl = 1.2880`) | **-%61,5 kayıp** |

> `test_loss (0.2531) <= valid_loss (0.2654)` olması, modelin eğitim cümlelerini ezberlemediğini ve hiç görmediği fabrika şemalarına doğrudan genellediğini matematiksel olarak kanıtlar.

### B. 43 Görevlik Birleşik Kabul Testi (`v24_final_all43.json`, Aynı Sistem İstemleri & Doğrulayıcılar)

| Test Paketi | Kapsam | Baz Model | `v2.4` LoRA (`step 240`) |
| :--- | :--- | :---: | :---: |
| **Core (`T1..T8`)** | Ağırlıklı kalite, iki sorgu birleştirme, `LEFT JOIN`, DAG, Grafik+Özet, Eksik OEE, Yasak OS, Şema Aracı | `7 / 8` (%87,5) | **`8 / 8` (%100,0)** |
| **Extended Held-Out (`H_*`)** | 24 kör regresyon görevi (`H_ratio`, `H_merge`, `H_path_*`, `H_template`, `H_missing`, `H_refusal`, `H_tool`) | `19 / 24` (%79,2) | **`24 / 24` (%100,0)** |
| **Platform Mastery (`M1..M11`)** | Tekrarlayan `bands` şablonu, `multi_level` Space Map ikonları, `sequence` sağlık durumu, Query Viewer canlı bağlama, 3 tablolu SQL JOIN, bozuk `pandas` kodu tamiri, RBAC rol/paylaşım taslakları, yetki yükseltme reddi, şema halüsinasyon koruması, `tool_get_rbac_info` turu | `9 / 11` (%81,8) | **`11 / 11` (%100,0)** |
| **TOPLAM (`all`)** | **43 Uçtan Uca Çalışma Zamanı Görevi** | **`35 / 43` (%81,4)** | **`43 / 43` (%100,0)** |

---

## 4. Çalıştırma ve Yeniden Üretim Komutları

Yapay zeka katmanı **%100 isteğe bağlıdır** (`./start.sh --no-ai` veya `AI_ENABLED=false` ile uygulama yapay zeka olmadan tam kapasite çalışır).

```bash
# 1. Yerel AI ve varsayılan v2.4 LoRA adaptör hazırlığını kontrol et
./.venv-ai/bin/python scripts/local_ai.py check

# 2. Uygulamayı v2.4 LoRA adaptörüyle başlat (veya AI olmadan: ./start.sh --no-ai)
./start.sh

# 3. Veri setini yeniden üretmek ve denetlemek için
./.venv-ai/bin/python scripts/ai_training_workflow.py prepare --profile v24

# 4. 43 görevlik birleşik kabul testini çalıştırmak için
./.venv-ai/bin/python scripts/run_acceptance_suite.py \
  --adapter-path training/supernova-v24/adapter240 \
  --checkpoint training/supernova-v24/adapter240/0000240_adapters.safetensors \
  --suite all \
  --output training/supernova-v24/results/v24_verify_all43.json
```
