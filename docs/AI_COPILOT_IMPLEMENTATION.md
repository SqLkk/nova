# SuperNova Yerel AI Copilot — Yapılacaklar

Bu liste uygulama sırasını ve doğrulanmış durumu takip eder. Model kurulumu ve
LoRA eğitimi, uygulama kodundan ayrı dağıtım adımlarıdır.

- [x] Mevcut Flask API, yetkilendirme, Python sandbox, Angular tema ve veri modellerini incele.
- [x] 1. Modelden bağımsız Gateway: config, 500 ms durum kontrolü, OpenAI/Ollama streaming, geliştirme mock'u.
- [x] 2. Domain araçları: yetkili şema keşfi, sandbox kuralları, path ve template JSON doğrulama.
- [x] 3. Modern Copilot: açık/koyu tema, dock/floating panel, sayfa bağlamı, streaming, iptal, offline deneyimi.
- [x] 4. Python ve SQL editörlerine aktar/test; Path Definer ve Template Builder'a JSON uygulama.
- [x] 5. Yerel SQLite bellek: kayıtlı script/sorgu indeksleme, kullanıcı yetkilerine göre few-shot retrieval.
- [x] 6. 1.600 örneklik JSONL üretici, veri doğrulaması, LoRA/GGUF hazırlık rehberi.
- [x] 7. Gateway, streaming, yetkilendirme, model kapalı senaryosu ve Angular build doğrulaması.
- [x] 8. Mevcut Qwen3.5-9B-MLX-4bit ile gerçek model bağlantısı, SSE, sandbox ve şema function calling doğrulaması.
- [x] 8a. Ayrı MLX runtime, yalnızca önbellekten yükleme, gelecekteki installer için opt-in profil.
- [x] 8b. Gerçek model servisini durdurup sorgu API'si ve Python sandbox'ın çalıştığını doğrula.
- [ ] 9. Gerçek LoRA eğitimi ve GGUF dağıtımı (model ağırlıkları ve eğitim donanımı gerektirir).

## Kabul ölçütleri

- AI servisi yokken standart uygulama ekranları ve API'ler çalışır.
- Durum endpoint'i model sunucusunu bekleyerek ana uygulamayı kilitlemez.
- AI istekleri mevcut Bearer kimlik doğrulamasını kullanır; veritabanı parolaları prompt'a girmez.
- Kod/sorgu testleri mevcut salt-okunur SQL ve izole Python yürütme motorlarını kullanır.
- Model çıktısı kullanıcı aksiyonu olmadan çalıştırılmaz veya kaydedilmez.
- JSON uygulanmadan önce mevcut path/template modellerine göre doğrulanır.
- SSE bağlantıları durdurma, sayfa/oturum değişimi ve ağ hatalarında kapatılır.

## Doğrulama sonuçları

- Backend: 30 otomatik test geçti; izole geçici SQLite ve sahte yerel HTTP model
  servisi. Ayrıca gerçek MLX için 2 bağlantı/araç testi ve 1 servis kapalı testi geçti.
- Angular: geliştirme ve üretim derlemeleri geçti. Üretimde initial bundle
  2 MB uyarı bütçesini yaklaşık 40 kB aşıyor; Table Explorer stil uyarısı da mevcut.
- Gerçek Chrome: açık/koyu tema, 390 px mobil panel, dock/floating,
  Router bağlamı, anlık streaming, Python/SQL editöre aktar ve gerçek test,
  Network Map JSON önizleme, Template Builder grafik ekleme ve çevrimdışı
  buton davranışı doğrulandı; çalışma zamanı hatası görülmedi.
- Dataset: 1.440 train + 160 eval; toplam 1.600 benzersiz instruction.
- Dış ağ kapalı tarayıcı doğrulaması; başlangıç CDN font/script çağrıları kaldırıldı.
- Gerçek MLX: mevcut Qwen3.5-9B 4-bit snapshot kullanıldı; yeni ağırlık indirilmedi.
  `mlx-lm==0.32.0` ayrı `.venv-ai` ortamına kuruldu. Python streaming → AST
  doğrulama → sandbox toplamı 30; gerçek şema function calling turu geçti.
- Tak-çıkar: MLX servisi durdurulduğunda AI status 2 ms içinde unavailable döndü;
  Flask health, sorgu listesi ve sandbox çalıştı. AI kapalıyken indeksleme yapılmaz.
- Yerel `.env` MLX profiline bağlandı; dağıtım varsayılanında AI kapalıdır.
  Modeli başlatmak ve durdurmak ana platformdan bağımsızdır.

Kullanım ve model kurulumu: [AI_COPILOT.md](AI_COPILOT.md).

## LoRA v2.2 hazırlığı

Veri çeşitliliği, senaryodan bağımsız tür dağılımı, sabit validasyon, tokenizer
denetimi, checkpoint seçimi ve sertleştirilmiş kabul testi araçları hazırlandı.
Bu revizyonda veri üretimi, eğitim ve testler çalıştırılmadı. Çalıştırma sırası ve
paylaşılacak çıktılar: [AI_LORA_V22.md](AI_LORA_V22.md).

v2.2 kullanıcı ölçümleri tamamlandı; çekirdek doğruluk 5/8 kaldı. Bir tam geçiş,
genişletilmiş LoRA kapasitesi ve hata düzeltme verisiyle tek kontrollü son deneme
hazırlandı; bu revizyonda çalıştırılmadı: [AI_LORA_FINAL.md](AI_LORA_FINAL.md).
