# AppAgent

**ServiceNow uygulamalarını bir Ajan ile oluşturun ve bakımını yapın. Bir Chrome uzantısı olarak.**

AppAgent, ServiceNow için geliştirme ortağınızdır. Uygulamalar oluşturabilir, bakımlarını yapabilir ve onlar için testler çalıştırabilir. Testleri formları doldurarak ve ekran görüntüleri alarak yapar. Teknik bilgi gerekmez.

Kendi API anahtarınızı getirmeniz (BYOK) yeterli! OpenAI, OpenRouter, Claude API ve hatta Claude Code planlarıyla uyumludur (bizimle özel olarak iletişime geçin).

Tüm sohbeti tarayıcınızda saklayan bir Chrome uzantısıdır (veriler tarayıcınızdan dışarı bile çıkmaz). Yalnızca ServiceNow örneğiniz ve model API sağlayıcınızla etkileşim kurar.

![AppAgent Örneği](AppAgentExample.png)

API önbelleğine, araç önbelleğine ve araç zincirlemeye (kutudan çıktığı gibi) büyük ölçüde dayandığı için Claude Code'dan daha az token kullanır.

Ona beceriler ekleyebilirsiniz; sekmeler aracılığıyla tarayıcı denetimi vardır ve örneğinizde yaptığı tüm değişiklikler için mekanik geri alma düğmeleri sunar.

> **Not:** Şimdilik AppAgent yalnızca geliştirme örneklerinde kullanılmak üzere tasarlanmıştır.

## Bize Ulaşın

Lütfen bu formu doldurun, size ulaşalım: [İletişim Formu](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Özellikler

| Özellik | Ne Yapar |
|---------|--------------|
| **Kendi Modelinizi Getirin** | Claude, GPT, Gemini, Grok ve daha fazlası arasından seçim yapın |
| **Claude ile Oturum Açma** | OAuth akışı — mevcut Claude Code Personal veya Enterprise planınızı kullanın, API anahtarı gerekmez |
| **Görseller ve PDF'ler** | Ajan'ın analiz etmesi için ekran görüntüleri, diyagramlar veya belgeler ekleyin |
| **Kod Düzenleme** | Betikleri tam sürüm takibiyle okur ve değiştirir |
| **Tarayıcı Denetimi** | Kendi işini test eder: Sekmelerde gezinir, tıklar, form doldurur, ekran görüntüsü alır |
| **Canlı Panolar** | Örneğinizden gerçek zamanlı veri çeken widget'lar oluşturur |
| **Ajan Becerileri** | Ajan'ın yeteneklerini genişletmek için kendi becerilerinizi oluşturun |
| **Beceri Eylemleri** | Beceriler, ana sayfada hazır iş akışlarını tetikleyen tek tıklamalı düğmeler sunabilir |
| **Canlı İlerleme** | Ajan'ın ne yaptığını gerçek zamanlı görün — çalışıyor/takıldı/tamamlandı/hata durumlarıyla değişen ilerleme etiketleri |
| **Çalışma Alanları** | Sohbet başına dosya karalama alanı — GitHub depolarını klonlayın, okuyun, yazın, düzenleyin, karşılaştırın ve dal değiştirin. Sohbet başına birden çok depo ve sohbetler arası sahiplik koruması |
| **Tümleşik Git ve GitHub Push** | Ajan, sohbetten doğrudan GitHub'dan çekebilir / GitHub'a gönderebilir, dal oluşturabilir ve çekme istekleri açabilir — terminal yok, IDE yok |
| **Akıllı Belgeler** | Ajan'ın sohbetler arasında düzenleyip başvurabildiği kalıcı, sürümlü Markdown |
| **Çoklu Örnek** | Tarayıcınızda açık olan tüm ServiceNow örneklerini otomatik algılar; Ajan hepsini tek bir sohbetten görebilir ve üzerlerinde işlem yapabilir |
| **Alt Ajanlar** | Ağır veya paralel işleri, ana sohbete rapor veren arka plan çalışan ajanlarına devreder |
| **25 Dil** | Sağdan sola Arapça ve İbranice dahil, İngilizcenin yanı sıra 24 dilde arayüz ve yardım |
| **Duraklatma ve Kesme** | Akış sırasında duraklatın veya yeni bir mesaj gönderin — devam eden çağrı anında iptal edilir |
| **Web Araması** | Google ve DuckDuckGo üzerinden ücretsiz, anahtarsız web aramaları |
| **Mekanik Geri Alma** | Her değişiklik izlenir, tek tıkla geri alınır |
| **XML'e Aktarma** | Diğer örneklere dağıtım için tüm değişiklikleri dışa aktarın |
| **Araç İzinleri** | Yerleşik güvenlik; Ajan'ın örnekte neler yapabileceğini denetleyin |
| **Açık Standartlar** | [OpenRouter](https://openrouter.ai) ve [AgentSkills.io](https://agentskills.io) ile uyumlu |
| **Model Önbelleği** | İstem önbelleği sayesinde maliyeti 10 kata kadar düşürür |
| **Akıllı Bağlam** | Büyük dosyaların yalnızca gereken bölümlerini yükler. Modeli aşırı yüklemez |
| **Sıfır Bağımlılık** | Kütüphane yok, çerçeve yok, saf vanilla JS |

## Nasıl Çalışır

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│              │      │              │      │              │
│   Chrome     │◀────▶│    Model     │      │  ServiceNow  │
│  Extension   │      │   (Claude,   │      │   Instance   │
│              │      │   GPT, etc)  │      │              │
│  [AppAgent]  │      └──────────────┘      │              │
│              │◀──────────────────────────▶│              │
└──────────────┘                            └──────────────┘
```

AppAgent, yerleşik bir ajan döngüsüne sahip bir Chrome uzantısıdır. Ne istediğinizi anlatırsınız → Ajan modele sorar → Araçları tarayıcıda yürütür → Mevcut kullanıcı izinlerinizle ServiceNow'a erişir. Ajan, şirket içi veya çevrimiçi model API sağlayıcılarıyla doğrudan iletişim kurar.

## AppAgent Karşılaştırması

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Hedef kullanıcı** | Teknik olmayan | Geliştiriciler | Geliştiriciler | Teknik olmayan kurucular |
| **ServiceNow için tasarlandı** | ✓ | ✗ | ✗ | ✗ |
| **Ajan tabanlı ServiceNow eylemleri** | ✓ | ✓ | ✗ | ✗ |
| **Geliştirme ortamı gerekir** | ✗ | ✓ | ✓ | ✗ |
| **Uygulama oluşturur** | ✓ | ✓ | ✓ | ✓ |
| **Test için tarayıcı denetimi** | ✓ | ✗ | ✗ | ✗ |
| **Ekran görüntüsü alır** | ✓ | ✗ | ✗ | ✗ |
| **Arka plan görevleri** | ✓ (Beceri Eylemleri ile) | ✗ | ✓ | ✗ |
| **Paralel ajanlar** | ✓ (Alt Ajanlar) | ✗ | ✓ | ✗ |
| **Mekanik geri alma** | ✓ | ✗ | ✗ | ✗ |
| **Görseller ve PDF'ler** | ✓ | ✓ | ✓ | Sınırlı |
| **Akıllı Panolar** | ✓ | ✗ | ✗ | ✓ |
| **Genişletilebilir Beceriler** | ✓ | ✓ | ✗ | ✗ |
| **Beceri Eylemleri (tek tıklamalı düğmeler)** | ✓ | ✗ | ✗ | ✗ |
| **Canlı İlerleme Etiketleri** | ✓ | ✗ | ✗ | ✗ |
| **Çoklu örnek desteği** | ✓ | ✗ | ✗ | ✗ |
| **Sohbet Başına Çalışma Alanları** | ✓ | ✗ | ✗ | ✗ |
| **Tümleşik git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Sohbetten GitHub'a gönderme** | ✓ | ✓ (CLI) | Sınırlı | ✗ |
| **Akıllı Belgeler** | ✓ | ✗ | ✗ | ✗ |
| **Akış sırasında Duraklatma / Kesme** | ✓ | ✓ | Sınırlı | ✗ |
| **Web Araması** | ✓ | ✓ | ✓ | ✗ |
| **Araç İzinleri** | ✓ | ✓ | Sınırlı | ✗ |
| **Değişiklikleri dışa aktarma** | ✓ XML | ✓ | ✓ | ✓ |
| **Kendi modelinizi getirin** | ✓ | ✗ | ✓ | ✗ |
| **İstem Önbelleği** | ✓ | ✓ | ✓ | ✗ |
| **Akıllı Bağlam** | ✓ | ✓ | ✓ | ✗ |
| **Sıfır Bağımlılık** | ✓ | ✗ | ✗ | ✓ |

*Base44 ServiceNow uygulamaları oluşturamaz, ancak onun deneyimine aşina kullanıcılar için listeye eklenmiştir.*

## Kurulum

1. **Yükleyin** — AppAgent uzantısını Chrome Web Mağazası'ndan yükleyin (veya geliştirme için paketlenmemiş olarak yükleyin)
2. **API Anahtarı Edinin** — [OpenRouter](https://openrouter.ai) üzerinde kaydolun, doğrudan Anthropic/OpenAI kullanın veya Claude Code aboneliğinizi (Enterprise veya Personal) bağlayın
3. **Yapılandırın** — Uzantıyı açın ve Ayarlar → API Sağlayıcıları bölümünde API anahtarınızı ekleyin (veya Claude ile oturum açın)
4. **Oluşturmaya Başlayın** — ServiceNow örneğinizi bir sekmede açın (otomatik olarak algılanır) ve sohbete başlayın

## Örnekler

### "Ekip görevlerini takip etmek için bana basit bir uygulama oluştur"
AppAgent tabloyu oluşturur, alanları ekler, bir form ve liste düzeni hazırlar ve gezginde bir modül ayarlar. Tek istem, eksiksiz uygulama.

### "Bu örnekte tam bir denetim yap"
AppAgent güvenlik açıklarını, etkin olmayan yönetici hesaplarını, eskimiş kayıtları ve yapılandırma en iyi uygulamalarını tarar, ardından size önerilerle birlikte bir rapor sunar.

### "Bu sayfayı test et ve bulduğun sorunları bildir"
AppAgent sayfayı bir tarayıcı sekmesinde açar, formları doldurur, düğmelere tıklar, ekran görüntüleri alır ve bulduğu her şeyin raporunu derler.

### "Bu formda bir hata var, düzeltebilir misin?"
AppAgent formu açar, arkasındaki betikleri inceler, hatayı tespit eder, kodu düzeltir ve tam olarak neyin değiştiğini size gösterir. Gerekirse tek tıkla geri alınır.

### "Açık kayıtlarım için bir pano widget'ı oluştur"
AppAgent, örneğinizden gerçek zamanlı veri çeken ve bunu panonuzda gösteren canlı bir widget oluşturur.

### "Bu Excel dosyasını kullanıcı tablosuna aktar"
AppAgent dosyayı okur, sütunları alanlarla eşler ve verileri örneğinize aktarır.

### "Yükseltme geçmişini kontrol et ve özelleştirme sorunlarını düzelt"
AppAgent yükseltmede nelerin değiştiğini inceler, bozulan özelleştirmeleri bulur ve düzeltir.

### "Bir P1 olayı oluşturulduğunda ekibi bilgilendir"
AppAgent, P1 olaylarında tetiklenen ve ekibinize uyarı gönderen bir bildirim kuralı oluşturur.

---

## Vizyon

Şu anda Opus 4.7 harika, ancak hâlâ biraz gözetim gerektiriyor.

Her nesilde yapay zeka modellerinin yapabileceklerinin sınırlarını zorlamaya ve takılıp kalana kadar soyutlama katmanlarında yukarı çıkmaya devam edeceğiz.

GPT-4 => Kod tamamlama
GPT-4o => Bağımsız bir dosya yazar
Sonnet 3.5 => Bir kod tabanındaki dosyayı düzenler
Opus 4.5 => Eksiksiz bir özellik yazar
Opus 4.6 => Bir uygulamanın uçtan uca bakımını yapar
Opus 4.7 => ... (hâlâ test ediyoruz)

---

## Yol Haritası

- RAG
- Belirtimler ve test senaryoları

Belirli bir sıra yoktur.

Bu sürüm çoğunlukla geri bildirim toplamak içindir.

Sonraki sürümler açık kaynak olmayabilir, ancak bu sürüm kararlı hale gelene kadar bakımını sürdüreceğiz.

---

## Katkı Yönergeleri

Lütfen PR açmayın; bu ticari bir projedir ve kodu yalnızca görünürlük ve güven için açık kaynak olarak paylaşıyoruz.

Herhangi bir hata bulursanız bir issue açabilir veya doğrudan bizimle iletişime geçebilirsiniz. Yalnızca ticari destek sunuyoruz, bu nedenle yalnızca diğer kullanıcıları etkileyebilecek hataları düzelteceğiz.

---

## Lisans

Özel ve Ticari kullanım. Dahili değişikliğe izin verilir. Dağıtım ve yeniden satış yasaktır.
