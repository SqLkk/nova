# Yerel AI Copilot

Copilot bağımsız bir Flask blueprint ve Angular panelidir. Model servisi olmadan
SuperNova normal çalışır. Yeni backend bağımlılığı gerekmez; istemci Python'un
standart HTTP kütüphanesini kullanır. Sunucu başlangıcında model bağlantısı açılmaz.
Uygulama başlangıcındaki Google Fonts ve Leaflet CDN istekleri kaldırılmıştır;
arayüz sistem fontlarını ve yerel ikonları, harita widget'ı mevcut SVG görünümünü
kullanır. Böylece uygulama açılışı harici font/script servislerini beklemez.

## Bu makinedeki Qwen3.5 MLX modeli

`mlx-community/Qwen3.5-9B-MLX-4bit` ağırlıkları mevcut Hugging Face önbelleğinden
kullanılır. MLX, Flask ortamından ayrı `.venv-ai` içinde kuruludur. Bu makinenin
yerel `.env` dosyası gerçek modele bağlanacak şekilde yapılandırılmıştır;
`.env.example` ve kod varsayılanı `AI_ENABLED=false` kalır.

Repo kökünde ayrı bir terminalde:

```sh
supernova-backend/venv/bin/python scripts/local_ai.py check
supernova-backend/venv/bin/python scripts/local_ai.py serve
```

Backend'i normal başlatma komutunuzla yeniden başlatın. Model servisi
`127.0.0.1:8085/v1` üzerinde çalışır; tarayıcı mevcut kimlik doğrulamalı Flask
Gateway'ine bağlanır. İlk yüklemede veya servis yokken normal ekranlar kullanılabilir.
İstek süresi MLX profili için 120 saniyedir; durum kontrolü yine en fazla 450 ms bekler.
Yalnızca son yanıt gösterilir; Qwen thinking çıktısı kapalıdır. Bu entegrasyon metin
üretimi içindir; multimodal ağırlıkların görsel bölümü MLX-LM tarafından kullanılmaz.

Model terminalinde `Ctrl+C` AI'yı durdurur. Kalıcı olarak kapatmak için:

```sh
supernova-backend/venv/bin/python scripts/local_ai.py disable
```

Backend'i yeniden başlatın. Tekrar etkinleştirmek için `scripts/local_ai.py configure`
ve ardından `scripts/local_ai.py serve` kullanın. `configure` yalnızca `AI_*`
ayarlarını değiştirir. AI kapalıyken yeni sorgu/script kayıtları AI belleğine indekslenmez.

## İsteğe bağlı kurulum mimarisi

[mlx-qwen35.json](../optional-ai/profiles/mlx-qwen35.json) ileride installer'ın
okuyabileceği profilidir: desteklenen platform, model, ayrı runtime, başlatma
komutu ve Gateway ayarları içerir; `optional=true`, `enabled_by_default=false`.
Installer'ın “Yerel AI desteği kurulsun mu?” seçimi bu profili etkinleştirebilir.
Ana platform kurulumu, requirements ve başlangıç süreci MLX'i yüklemez veya başlatmaz.
Apple Silicon dışındaki makinelerde mevcut OpenAI/Ollama Gateway kullanılabilir.

Yeni Apple Silicon makinede yalnızca AI seçildiyse, Python 3.12+ ve `uv` ile:

```sh
uv venv --python python3.12 --no-python-downloads .venv-ai
uv pip install --python .venv-ai/bin/python --requirement optional-ai/requirements-mlx.txt
python3 scripts/local_ai.py configure
python3 scripts/local_ai.py serve
```

Air-gapped kurulumda runtime paketlerini hedef macOS/arm64 için önceden paketleyin,
`uv pip install --offline --no-index --find-links /path/to/wheels ...` ile kurun.
Ağırlık snapshot'ını **symlink hedefleri dahil** taşıyın ve gerekiyorsa
`python3 scripts/local_ai.py serve --model-path /path/to/snapshot` kullanın.
Çalıştırıcı yalnızca tam yerel snapshot kabul eder, `HF_HUB_OFFLINE=1` ve
`TRANSFORMERS_OFFLINE=1` ayarlar; eksik modeli çalışma sırasında indirmez.

MLX servis adaptörü test edilmiş `mlx-lm==0.32.0` API'sine bağlıdır. Servis
yalnızca loopback'e açılır ve seçilen modeli sunar; tarayıcı erişimi Flask'tan geçer.
Runtime güncellemesinde gerçek model testlerini tekrar çalıştırın.

## Diğer yerel model sunucuları

Repo kökündeki `.env` dosyasına `.env.example` içindeki AI ayarlarını ekleyin ve
backend'i yeniden başlatın. Varsayılan `AI_ENABLED=false` güvenli şekilde kapalıdır.

OpenAI uyumlu Ollama / vLLM / llama.cpp:

```dotenv
AI_ENABLED=true
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL_NAME=qwen3.5:9b
AI_TEMPERATURE=0.2
AI_TIMEOUT_SECONDS=30
```

Model adı, **yerel sunucuda kurulmuş modelin gerçek kimliğiyle** eşleşmelidir.
vLLM veya llama.cpp için yalnızca URL ve model kimliğini değiştirin.
Doğrudan Ollama API'si için `AI_PROVIDER=ollama` ve
`AI_BASE_URL=http://localhost:11434` kullanın. OpenAI uyumlu servislerin `/models`,
Ollama'nın `/api/tags` endpoint'i sağlık kontrolünde kullanılır.
Şirket içi ayrı bir makinedeki model servisi de yapılandırılabilir; dış ağ
kullanılmaması dağıtım ağında sağlanmalıdır. AI istemcisi proxy ortam değişkenleri
üzerinden yönlendirme yapmaz.

Geliştirme için gerçek model gerektirmeyen, **UI'da açıkça işaretlenen** önizleme:

```dotenv
AI_ENABLED=true
AI_MOCK_MODE=true
```

Mock yalnızca `NOVA_ENV=development` modunda kullanılabilir. Üretimde dikkate alınmaz.
Kurulum scripti model indirmez veya gerçek LoRA eğitimini otomatik başlatmaz.

## Kullanım

- Sağ alttaki Copilot butonu veya `Ctrl/⌘ + Shift + K` paneli açar; `Esc` kapatır.
- Yüzen panel başlığından sürüklenebilir. Raptiye ile sağa sabitlenir; geniş
  ekranlarda çalışma alanı panel için yer açar. Mobilde panel tam ekran açılır.
- Router bağlamı ve kaydedilmemiş editör kodu her mesaj gönderiminde alınır.
- Python / SQL kod kartları: kopyalama, editöre aktarma ve gerçek önizleme testi.
- Template Builder: grafik/hücre parçaları aktif sayfaya eklenir.
- Network Map: doğrulanmış yapılandırma kaydedilmeden haritada önizlenir.
- Table Explorer içindeki Path Definer: yapılandırma build formuna aktarılır.
- Model çıktısı kendiliğinden çalıştırılmaz veya kaydedilmez. Test, mevcut izole
  Python sandbox ve salt okunur SQL motorundan geçer. Test sonuçlarında ilk beş
  satır gösterilir. Parametre gerektiren SQL için editörün parametreli önizlemesini kullanın.
- Sohbet bellek içinde tutulur; sayfa veya kullanıcı değişince temizlenir.

## API

Tüm AI endpoint'leri mevcut Bearer kimlik doğrulamasını kullanır.

| Endpoint | Davranış |
| --- | --- |
| `GET /api/ai/status` (`/health` alias) | Model ve kullanılabilirlik; health beklemesi en fazla 450 ms, 3 sn cache |
| `POST /api/ai/chat/stream` (`/chat/completions` alias) | `{messages, context}` → OpenAI biçiminde SSE content deltalari |
| `GET /api/ai/schema` | Yetkili kaynak/sorgu metadata; satır verisi ve parola içermez |
| `POST /api/ai/artifacts/validate` | `{kind: python/path/template, artifact}` → doğrulanmış parça |

SSE: `metadata` ve `tool` adlandırılmış olayları, `choices[0].delta.content`
mesajları, başarıda `[DONE]`, hatada `event: error`. SSE beklerken heartbeat
gönderilir; toplam süre, eşzamanlı istek, mesaj ve yanıt boyutları sınırlıdır.
UI stream'i durdurduğunda upstream socket kapatılır.

Model kendi URL'sini/modelini değiştiremez, system mesajı gönderemez veya keyfi
fonksiyon çalıştıramaz. Tool calling iki turla sınırlıdır. Araçlar yalnızca şema
keşfi ve Python/path/template doğrulaması yapar. SQL execution modeli tarafından
çağrılabilen bir araç değildir; yalnızca kullanıcıdaki Test aksiyonudur.

Şema keşfi mevcut metadata cache ve kayıtlı sorgu sütunlarını kullanır.
Henüz keşfedilmemiş bir veri kaynağında Table Explorer'ı açın; sorgu kolonları
için Preview çalıştırın. Kaynak satırları modele otomatik gönderilmez.

## Yerel bellek

`golden_examples` tablosu SQLite uygulama DB'sinde idempotent olarak oluşturulur.
Yeni kaydedilen/güncellenen sorgu ve scriptler indekslenir. Retrieval güncel
kaynak nesnesine JOIN yapar ve mevcut ACL'yi yeniden kontrol eder; paylaşımı
geri alınmış veya silinmiş örnek başka kullanıcıya verilmez. En fazla üç kısa,
terim eşleşmesi olan örnek prompt'a eklenir. Bu few-shot bellektir; müşteride
model eğitimi yapılmaz. İndeks arızası normal kaydetme işlemini engellemez.
`AI_MEMORY_ENABLED=false` indeksleme ve retrieval'ı kapatır.

## Eğitim hazırlığı

```sh
supernova-backend/venv/bin/python scripts/generate_ai_dataset.py --output-dir /private/tmp/supernova-ai-dataset
```

1.600 JSONL kayıt: 500 Python, 500 SQL, 300 path, 300 template. Her kayıt gerçek
AST yorumlayıcısı, SQLite sorgu yürütmesi veya model doğrulayıcısı ile kontrol
edilir. `train.jsonl` (1.440), `eval.jsonl` (160), `manifest.json` üretilir.
Sentetik başlangıç seti, seri model eğitiminin kalitesini tek başına garanti etmez;
üretim eğitimi öncesinde uzman incelemesi, daha çeşitli görevler, saldırgan ve
hatalı istekler, gerçek hata/onarım senaryoları ve ayrı değerlendirme gerekir.
Her alan için bir JSONL örneği [ai-dataset.sample.jsonl](ai-dataset.sample.jsonl)
dosyasında yer alır.

LoRA/GGUF dağıtım adımları:

1. Hedef donanımın RAM/VRAM kapasitesine göre model ve nicemleme seçin;
   ağırlıkların ve veri setinin dağıtım lisansını kaydedin.
2. İlgili mimariyi destekleyen Unsloth veya Axolotl sürümünde modelin kendi chat
   template'i ve assistant-only loss ile JSONL train/eval dosyalarını kullanın.
3. Ayrı eval setinde Python sandbox geçişi, SQL şema doğruluğu, path/template
   geçerliliği ve yasak işlem reddini ölçün. Temel modelle karşılaştırın.
4. LoRA adapter'ını temel ağırlıklarla birleştirin. Mimariyi destekleyen
   llama.cpp dönüştürücüsü ile GGUF üretin ve hedef nicemlemeyi uygulayın.
5. GGUF/adapter checksum, sürüm, lisans ve değerlendirme sonuçlarını paketleyin;
   air-gapped makineye önceden temin edilmiş runtime ve ağırlıklarla kurun.
6. Yerel sunucuda `/models` veya `/api/tags` kimliğini doğrulayın, `.env` model
   kimliğini eşleştirin; model kapalı/açık testlerini tekrar çalıştırın.

Model ağırlıkları repoya eklenmez; bu makinedeki mevcut MLX snapshot'ı harici
önbellekten kullanılır. Bu çalışma LoRA eğitimi veya GGUF çıktısı içermez.

## Doğrulama

```sh
supernova-backend/venv/bin/python -m unittest discover -s tests -p 'test_ai*.py' -v
cd supernova-ui
npm run build
```

Testler geçici SQLite ve yerel sahte HTTP model sunucusu kullanır. AI kapalı,
eksik model, timeout, OpenAI/Ollama streaming, tool calling, yetki izolasyonu,
JSON doğrulama, SQL/script kaydetme ve few-shot ACL senaryolarını kapsar.

Gerçek Apple Silicon model testi (servis çalışırken):

```sh
SUPERNOVA_TEST_MLX=1 supernova-backend/venv/bin/python -m unittest discover -s tests -p 'test_ai_mlx_integration.py' -v
```

Modeli `Ctrl+C` ile durdurduktan sonra tak-çıkar testi:

```sh
SUPERNOVA_TEST_MLX=offline supernova-backend/venv/bin/python -m unittest discover -s tests -p 'test_ai_mlx_integration.py' -v
```

Gerçek Qwen streaming → sandbox Python → toplam 30 ve şema function calling
doğrulandı. Model durdurulduğunda durum endpoint'i 2 ms içinde unavailable döndü;
normal sorgu API'si ve Python sandbox çalıştı. Bunlar temel bağlantı kabul
testleridir; tüm domain görevlerinde model kalitesini ölçen kapsamlı bir eval değildir.
