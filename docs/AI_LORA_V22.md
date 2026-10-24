# SuperNova LoRA v2.2 çalıştırma rehberi

Bu değişiklikte veri üretimi, eğitim, model servisi veya testler çalıştırılmadı.
Komutları proje kökünde sırayla siz çalıştırın. Her aşama tamamlanmadan diğerini
başlatmayın. Hatalı aşamada durun ve o aşamanın logunu paylaşın.

## Hazırlanan değişiklikler

- Yeni v2.2 veri üreticisi: 2.400 train / 300 valid / 300 test. Senaryo aileleri
  ayrık kalır; işlem türü senaryo indeksinden bağımsız seçilir. Her split'te bütün
  Python, SQL, Path, grafik, ret ve araç turu varyantları bulunur.
- Ağırlıklı oran: pay ve payda ayrı biriktirilir; bölme döngü bittikten sonra yapılır.
  Kolon adları, çıktı alanları ve anlatımlar çeşitlenir. NULL/eksik değerler,
  eşit olmayan ağırlıklar, pozitif payla sıfır payda ve boş veri kontrol edilir.
- Birleştirme: iki sorgu ayrı gruplanır; yinelenen anahtar tek çıktı satırı verir.
  Aynı/farklı miktar kolonları, sol eşleme ve tam eşleme açıkça ayrılır. Her iki
  tarafta tekrar, NULL, eksik eşleme ve tek tarafın boş olması kontrol edilir.
- Path: beş yapı tipi her split'te bulunur; kolon isimleri değişir ve gerçek
  motorun parent/children ilişkileri doğrulanır.
- CPU tokenizer denetimi: 1024 sınırı, assistant başlangıcı, prompt maskesi,
  EOS, araç tanımları ve SHA256. Denetim geçmeden yeni eğitim başlamaz.
- Aynı 80 kayıttan oluşan kategori dengeli validasyon her değerlendirmede tamamen
  kullanılır. Eğitim ve validasyon RNG'leri ayrıdır. Dataset/tokenizer kimliği
  adapter yanında `training_provenance.json` dosyasına yazılır.
- Kabul testi v2.2: kesin yüzde, NULL ve boş veri, iki tarafta tekrar, SQL'in gerçek
  sıfır çıktısı, DAG kolon eşlemesi, grafik konumları, çalıştırılabilir kod sızıntısı,
  gerçek araç çağrısı ve şema dönüşünün kullanılması kontrol edilir.
- `--checkpoint` ile ara ağırlık doğrudan seçilir; asıl adapter dosyası değiştirilmez.
  Raporlarda finish_reason, tokenler, süre, bellek ve doğrulayıcı kimlikleri yer alır.
- Eğitim dışındaki 24 ek görev ayrı `extended` aşamasındadır. Bunlar veri
  üreticisine eklenmemiştir; yeni bağımsız müşteri görevleriyle test yine gereklidir.

Üretici referans fixture kontrollerini yalnızca **prepare komutunu siz çalıştırdığınızda**
yürütür. Model ağırlığı yüklemez. Tokenizer denetimi de yalnız CPU kullanır.
Bu araçlar uygulama başlangıcına veya `.env` ayarlarına bağlanmamıştır.

## 1. Veri setini hazırla ve denetle

```bash
python3 scripts/ai_training_workflow.py prepare
```

Bu komut yeni `training/supernova-v22/` klasörünü oluşturur. Mevcut v2.1 verisini
ve adapter'larını kullanarak üzerine yazmaz. Klasör zaten varsa işlemi durdurur.
Yeniden denemede yeni ad seçebilirsiniz:

```bash
python3 scripts/ai_training_workflow.py prepare --experiment-root training/supernova-v22-r2
```

İncelenecek dosyalar:

- `training/supernova-v22/manifest.json`: split sayıları, tür dağılımı, fixture
  kontrol sayıları, SHA256 ve sabit validasyon seçimi.
- `training/supernova-v22/audit.json`: `passed: true`, 1024 üzerinde kayıt olmaması,
  assistant hedefi ve EOS hatası olmaması.
- `training/supernova-v22-preparation-logs/generate.log` ve `audit.log`.

Denetim hata verirse eğitime geçmeyin; sınırı yükseltmeden önce hatalı örnekleri
inceleyelim. Üretilen dosyalar henüz bu çalışma sırasında denenmemiştir.

## 2. Temel modelden 150 adım eğit

```bash
python3 scripts/ai_training_workflow.py train
```

`optional-ai/training/v22.yaml`: batch 1, rank 4, son 1 katman, öğrenme oranı
1e-5, gradient checkpoint, prompt masking, düşünme kapalı. 50/100/150 adımlarında
checkpoint kaydedilir; aynı sabit 80 kayıt değerlendirilir. Bu değerlendirmeler
önceki 16 kayıt ölçümlerinden daha uzun sürer; eski loss ile doğrudan kıyaslanmaz.

Çıktılar: `training/supernova-v22/adapter150/` ve `logs/train150.log`.
Yeni modelin davranışını görmeden 300 adıma otomatik geçiş yoktur. Eğitim yeniden
başlatılacaksa yeni deney klasörü kullanın; optimizer devamı varsayılmaz.

MLX servisiniz açıksa bellekte iki model tutmamak için önce kendi çalıştırdığınız
servisi durdurun. Core Flask/Angular uygulamasını bu araçlar başlatmaz/durdurmaz.

## 3. Aynı doğrulayıcıyla karşılaştır

```bash
python3 scripts/ai_training_workflow.py evaluate
```

Sırayla baseline, v2.1 adapter150 ve yeni 50/100/150 checkpoint'leri çalışır.
Her model için 8 çekirdek kabul görevi ve aynı `valid_fixed.jsonl` üzerinde loss
ölçümü yapılır. Modeller sırayla yüklenir. Bu aşama eğitim yapmaz; birkaç dakika
ile sınırlı olduğu varsayılmamalıdır.

Çıktılar: `training/supernova-v22/results/*_core.json`, `*_fixed_loss.json`,
ilgili loglar ve `comparison.txt`. Sertleşen doğrulayıcı nedeniyle eski 6/8
raporunu doğrudan yeni skorla kıyaslamayın; v2.1 adapter150 yeniden ölçülür.

Yarım kalan değerlendirmeyi yeniden çalıştırmak için yeni rapor klasörü kullanın:

```bash
python3 scripts/ai_training_workflow.py evaluate --results-dir training/supernova-v22/results-r2
```

## 4. Seçilen checkpoint'i 24 ek görevde ölç

Çekirdek 8/8 ve ret/eksik bilgi/araç davranışı korunursa en iyi checkpoint'i seçin.
Örneğin 100. adım için:

```bash
python3 scripts/ai_training_workflow.py extended --checkpoint 100
```

Bu komut baseline ve seçilen checkpoint'i aynı 24 görevde karşılaştırır.
`results/step100_extended.json` ve `.log` dosyalarını oluşturur. Token bütçesi
çekirdek testteki gibi 512, araç turları 256; sıcaklık 0, düşünme kapalı kalır.

## 5. Raporu göster ve paylaş

```bash
python3 scripts/ai_training_workflow.py report
```

Paylaşılacaklar: `manifest.json`, `audit.json`, `logs/train150.log`,
`results/comparison.txt`, `*_core.json`, `*_fixed_loss.json` ve varsa ek görev raporu.
Model ağırlıklarını paylaşmanız gerekmez.

## İsteğe bağlı eski 225 checkpoint ölçümü

Yeni eğitime başlamadan eski 225'i denemek isterseniz klasör kopyalamaya gerek yok:

```bash
.venv-ai/bin/python scripts/run_acceptance_suite.py \
  --adapter-path training/supernova-v21/adapter300 \
  --checkpoint training/supernova-v21/adapter300/0000225_adapters.safetensors \
  --skip-baseline --suite core \
  --output training/supernova-v21/logs/acceptance225_v22validators.json
```

Bu sonuç da yeni doğrulayıcıya aittir. Yeni eğitim için zorunlu adım değildir.

## Geçiş koşulu

Loss tek başına model seçmez. Çekirdek görevlerin gerçek çıktısı, ek görevlerdeki
doğruluk, ret/eksik bilgi/araç davranışı ve kesilme olmaması birlikte değerlendirilir.
Ürün entegrasyonunda AI kapalıyken sorgu, sandbox ve normal sayfa akışları ayrıca
doğrulanmalıdır. Fuse/GGUF/üretim ayarı değişikliği bu komutlarda yoktur; bu aşamaya
başarılı değerlendirmeden sonra karar verilir. Kurulu MLX sürümünün GGUF aktarımı
Qwen3.5 mimarisini desteklemediğinden GGUF ayrı bir dönüşüm işidir.
