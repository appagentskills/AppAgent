# Başlarken {#getting-started}

AppAgent, Chrome uzantısı olarak çalışan bir ServiceNow yapay zeka ajanıdır. İhtiyacınızı sade bir dille anlatın; Ajan verileri sorgular, kayıtları düzenler, uygulamalar ve widget'lar oluşturur, sayfaları tarayıcınızda test eder ve size sonucu bildirir.

:::tip
**Hızlı başlangıç:** Bir model ayarlayın, ServiceNow örneğinizde bir sekme açın, ardından sohbete isteğinizi yazıp <kbd>Enter</kbd> tuşuna basın.
:::

## Model Ayarlama {#guide-setup}

1. [Ayarlar](app:openSettingsPageView) sayfasını açın ve **API Sağlayıcıları** bölümüne gidin
2. API anahtarınızla bir sağlayıcı ekleyin (Anthropic, OpenRouter veya OpenAI uyumlu özel bir API) — ya da Claude hesabınızla oturum açmak için bir Anthropic sağlayıcısında **OAuth** seçeneğini etkinleştirin
3. Kullanılacak modeli **Ajan Modeli** altından seçin

API anahtarınız yalnızca tarayıcınızda saklanır. Yapay zeka çağrıları doğrudan tarayıcınızdan sağlayıcıya gider.

## Örneklerinizi Bağlama {#guide-instances}

AppAgent, aynı Chrome profilinde açık olan **tüm ServiceNow örneklerini otomatik olarak algılar** — girmeniz gereken bir bağlantı dizesi yoktur. Normal bir sekmede bir örneğe oturum açın; Ajan, kullanıcınızın rolleri ve erişim haklarıyla o örnek üzerinde çalışabilir. Algılanan tüm örnekleri, rollerinizi ve bağlantı durumunu görmek için *"örnekleri listele"* deyin.

Her örneğin, örnek açılır menüsünden seçilen bir **izin düzeyi** vardır:

- **Manuel** — Her yazma işlemini (oluşturma, güncelleme, silme, form doldurma) siz onaylarsınız
- **Otomatik** — Yazma işlemlerine Ajan size sormadan karar verir
- **Geliştirici** — Hiç onay yoktur: bu örnekteki her araç çağrısı sormadan çalışır. Yalnızca geliştirme örneklerinde kullanın

Okuma işlemlerine her zaman izin verilir. Daha ayrıntılı denetim için [Araç İzinleri](#feature-permissions) bölümüne bakın.

## Sohbet Başlatma {#guide-chat}

1. Kenar çubuğunda **Yeni Sohbet** düğmesine tıklayın [Yeni Sohbet Başlat →](app:startNewChat)
2. İsteğinizi yazın, örneğin *"Bugün oluşturulan tüm olayları göster"*
3. Göndermek için <kbd>Enter</kbd> tuşuna basın
4. Ajan çalışırken süreci izleyin: her araç çağrısı sohbette görünür ve bir adım onayınızı gerektirdiğinde onay istemleri belirir

Ajan çalışırken yazmaya devam edebilirsiniz: yeni bir mesaj göndermek mevcut adımı keser, **Duraklat** ise çalışmayı durdurur.

## Görsel ve Dosya Ekleme {#guide-images}

1. Görsel, PDF, CSV veya metin dosyası eklemek için giriş alanındaki **Dosya ekle** düğmesine tıklayın
2. Ya da panodan bir görsel yapıştırın veya sürükleyip sohbete bırakın
3. Ekle ilgili sorunuzu yazın

:::tip
Ajan'ın sizin gördüğünüzü aynen görebilmesi için hata ekran görüntüleri, arayüz taslakları veya dışa aktarılmış veriler ekleyin.
:::

# Temel Özellikler {#features}

## Sohbet {#page-chat}

Ana konuşma görünümü. [Yeni Sohbet Başlat →](app:startNewChat)

- **Mesaj alanı** — Araç çağrıları ve sonuçları dahil tüm konuşma
- **Giriş kutusu** — Mesaj yazın, dosya ekleyin; Ajan çalışırken mesaj göndererek onu kesin
- **Duraklat / Devam et / Yeniden dene** — Ajan'ı durdurun, devam ettirin veya son adımı yeniden deneyin
- **Bağlam göstergesi** — Konuşmanın ne kadar dolduğunu gösterir; yeni bir sohbete özetlemek için tıklayın
- **Yanıt kartları** — Bir yanıtın altında **Özetle** (TL;DR) özeti ve bir **Bağlantılar** kartı (kayıtlar, PR'ler, belgeler) görünebilir
- **Sohbet başlığı** — Sohbeti yeniden adlandırın veya sabitleyin ya da **Tam sayfaya genişlet** ile AppAgent'ı tam bir tarayıcı sekmesinde açın

## Tarayıcı Denetimi {#feature-browser}

Ajan, sayfaları görmek ve test etmek için örneğinizde tarayıcı sekmeleri açıp denetleyebilir:

- **Gezinme, tıklama, doldurma ve seçme** — Gerçekçi olaylar kullanılır; böylece formlar ve otomatik tamamlama alanları siz yazıyormuşsunuz gibi davranır
- **Bekleme** — Gecikmeleri tahmin etmek yerine bir öğeyi, metni veya URL'yi bekler
- **Ekran görüntüleri** — Görsel kontroller için sayfanın, bir widget'ın veya tek bir öğenin görüntüsünü alır
- **İnceleme** — Öğe özelliklerini, stilleri, konsol hatalarını ve ağ isteklerini okur
- **Kimliğine bürünme** — Başka bir kullanıcı olarak test edip ardından geri döner

## Kayıt Düzenleme ve Sürüm Geçmişi {#feature-history}

Ajan'ın örneğinizde yaptığı her değişiklik sohbet kenar çubuğunda izlenir:

- **Geri al** — Tek bir değişikliği geri alır
- **Yinele** — Geri alınan bir değişikliği yeniden uygular
- **XML'i İndir** — Tüm değişiklikleri dışa aktarır, örneğin başka bir örneğe taşımak için

## Alt Ajanlar {#feature-subagents}

Ağır veya paralel işler için Ajan **alt ajanlar** başlatabilir: kendi sohbetlerinde ve bağlamlarında çalışan, ardından ana sohbete kısa bir sonuç bildiren arka plan çalışanları.

- **Model katmanları** — Her alt ajan **small**, **medium** veya **large** katmanında ya da üst ajanın modelini kullanmak için **same** katmanında çalışır. Katmanları modellerle [Ayarlar](app:openSettingsPageView) → **Alt Ajan Model Katmanları** bölümünde eşleyin
- **Çalışanlar şeridi** — Çalışan alt ajanlar, sohbet girişinin üstünde canlı çipler olarak görünür; ilerlemesini izlemek veya dökümünü okumak için birini açın
- **Havuz** — Eşzamanlı alt ajan sayısı sınırlıdır; fazlası bir kuyrukta bekler

## Pano ve Widget'lar {#page-dashboard}

Ajan tarafından oluşturulan etkileşimli widget'lardan oluşan bir pano. [Panoyu Aç →](app:openDashboardView)

1. **Widget Ekle** düğmesine tıklayın
2. Ne istediğinizi anlatın, örneğin *"Açık olayları önceliğe göre gösteren bir grafik"*
3. Ajan widget'ı oluşturur; istediğiniz zaman değişiklik isteyin veya **Yeniden Oluştur** düğmesine tıklayın

Widget'lar örneğinizden canlı veri çekebilir, böylece her zaman güncel kalırlar. Onları sürükleyin, yeniden boyutlandırın, içe ve dışa aktarın ([Gelişmiş](#advanced) bölümüne bakın). Ajan'ın sohbette satır içi gösterdiği widget'lar **Panoya sabitle** ile kaydedilebilir.

## Akıllı Belgeler {#page-documents}

**Akıllı Belgeler**, Ajan'ın yazıp güncellediği kalıcı ve sürümlü Markdown belgeleridir — planlar, raporlar, belirtimler, bulgular. Sohbette satır içi görüntülenir, her sürümü saklar ve doğrudan sizin tarafınızdan düzenlenebilir. Onları kenar çubuğundaki **Belgeler** bölümünden açın. [Belgeleri Aç →](app:openDocumentsView)

## Beceriler {#page-skills}

Beceriler Ajan'a ek bilgi ve araçlar kazandırır. [Becerileri Aç →](app:openSkillsView)

- **Etkinleştir / Devre dışı bırak** — Becerileri açıp kapatın; yanıtların odaklı kalması için ihtiyaç duymadıklarınızı devre dışı bırakın
- **Yeni Beceri** — Kendi becerinizi Markdown ile yazın veya **Ajanla Düzenle** seçeneğini kullanın
- **İçe Aktar / Dışa Aktar** — Becerileri klasör olarak paylaşın
- **Beceri eylemleri** — Bazı beceriler ana sayfaya, hazır bir iş akışını başlatan tek tıklamalı düğmeler ekler

Bir beceri **bilgi** (talimatlar, en iyi uygulamalar) ve **özel araçlar** (yalıtılmış bir korumalı alanda çalışan JavaScript işlevleri) sağlayabilir.

## Çalışma Alanı ve GitHub {#feature-workspace}

Her sohbetin bir **çalışma alanı** vardır — Ajan'ın dosyaları okuyabildiği, yazabildiği, düzenleyebildiği ve karşılaştırabildiği bir dosya alanı.

- **GitHub** — Depoları bir çalışma alanına klonlamak için [Ayarlar](app:openSettingsPageView) bölümünden bir GitHub hesabı bağlayın. Ajan sohbetten dallar oluşturabilir, commit'leri gönderebilir ve çekme istekleri açabilir
- **Çekme istekleri** — Bir sohbetten açılan PR'ler, **Birleştir** düğmesiyle birlikte sohbet kenar çubuğunda listelenir
- **Sohbetler arası koruma** — Her dosya onu hangi sohbetin değiştirdiğini hatırlar; böylece paralel çalışan iki sohbet birbirinin işinin üzerine sessizce yazmaz
- **Otomatik eşitleme** — Klonlanan çalışma alanları, gezindiğinizde, sohbet değiştirdiğinizde veya sekmeye döndüğünüzde GitHub ile eşitlenir

## Sohbet Kenar Çubuğu {#feature-sidebar}

Sağdaki kenar çubuğu, geçerli sohbetin ürettiği her şeyi bir araya getirir:

- **Çekme İstekleri** — Başlık, hedef dal ve bir **Birleştir** düğmesi
- **Çalışma Alanı Dosyaları** — Bir dosyayı görüntülemek, farkını görmek veya önceki sürümlerine göz atmak için açın
- **Sürüm geçmişi** — **Geri al**, **Yinele** ve **XML'i İndir** seçenekleriyle örnek değişiklikleri
- **Çalışanlar** — Araç çağrıları, düzenlenen dosyalar ve açılan PR'ler için sayaçlarla birlikte çalışan ve tamamlanmış alt ajanlar

## Eylemler ve Canlı İlerleme {#feature-actions}

Uzun görevler sessiz kalmak yerine canlı ilerleme gösterir:

- **İlerleme kartı** — Renkli bir durum (çalışıyor, takıldı, tamamlandı, hata) ve bir adım listesi içeren tek bir kart
- **Eylem düğmeleri** — Takip iş akışlarını başlatan tek tıklamalı düğmeler
- **Çalışma göstergesi** — Sohbet listesi, Ajan'ın çalıştığı sohbetleri işaretler
- **"Ajan tamamladı" bildirimi** — Çalışma sırasında sekme veya pencere değiştirirseniz, Ajan işini bitirdiğinde bir masaüstü bildirimi sizi haberdar eder

## Etkin Sohbetler ve İşler {#feature-jobs}

Başlıktaki işler etiketi, sohbetlerinizin ve arka plan işlerinizin canlı bir görünümünü açar:

- **Etkin sohbetler** — Çalışan sohbetler ve okunmamış sonuçları olan sohbetler (**kalın** gösterilir), her biri bir bağlam kullanımı halkasıyla
- **Alt ajanlar** — Üst sohbetlerinin altında listelenir; dökümünü okumak için birini açın
- **Genişlet** — Listeyi, sütun veya bölüm düzeniyle daha büyük bir panel olarak açın

## Araç İzinleri {#feature-permissions}

Örnek başına izin düzeyinin (**Manuel**, **Otomatik**, **Geliştirici**) yanı sıra, her aracın [Ayarlar](app:openSettingsPageView) → **Araç İzinleri** bölümünde kendi ayarı vardır:

- **İzin Ver** — Araç her zaman sormadan çalışır
- **Otomatik** — Ajan bir çağrıyı onayınızı gerektiren olarak işaretlemedikçe araç sormadan çalışır
- **Sor** — Her çağrıdan önce bir onay istemi alırsınız
- **Kapalı** — Ajan aracı kullanamaz

Bazı araçlarda daha ayrıntılı denetimler vardır: HTTP yöntemi başına ServiceNow API (GET, POST, PUT, PATCH, DELETE), eylem başına tarayıcı denetimi (gezinme, tıklama, doldurma, kimliğine bürünme…) ve eylem başına beceri yönetimi. Onay iletişim kutuları riske göre renklendirilir: **mavi** (rutin), **turuncu** (dikkat), **kırmızı** (yıkıcı).

:::tip
DELETE ve diğer yıkıcı işlemleri **Sor** konumunda tutun ve **Geliştirici** düzeyini yalnızca geliştirme örneklerinde kullanın.
:::

## Ajan Araçları {#feature-tools}

Ajan'ın kullandığı başlıca araçlar:

| Araç | Ne yapar |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Kayıtları okur, oluşturur, günceller ve siler |
| **Arka plan betiği** (`servicenow_run_script`) | Örnekte sunucu tarafı bir betik çalıştırır (admin rolü gerektirir) |
| **Betik düzenlemeleri** (`servicenow_diff_edit`) | Betikleri hassas bul-ve-değiştir düzenlemeleriyle değiştirir |
| **Tarayıcı denetimi** (`iframe_tool`) | Tarayıcı sekmelerinde gezinir, tıklar, doldurur, inceler ve kimliğe bürünür |
| **Tarayıcı kodu** (`js_eval`) | Diğer araçları çağırabilen yalıtılmış bir korumalı alanda JavaScript çalıştırır |
| **Ekran görüntüleri** (`take_screenshot`) | Sayfanın, bir widget'ın veya bir öğenin görüntüsünü alır |
| **Widget'lar ve kartlar** (`html_widget`, `display`) | Sohbette etkileşimli widget'lar, tablolar, kartlar ve zaman çizelgeleri gösterir |
| **Akıllı Belgeler** (`document`) | Kalıcı Markdown belgeleri oluşturur ve günceller |
| **Kullanıcıya sorma** (`prompt_user`) | Satır içi bir formla sizden girdi ister |
| **Alt ajanlar** (`spawn_sub_agent`) | İşi arka plan çalışanlarına devreder |
| **Çalışma Alanı** (`workspace`) | Dosyalar ve GitHub depolarıyla çalışır |
| **Web getirme** (`web_fetch`) | Herkese açık web'deki sayfaları okur |
| **Beceriler** (`get_skill`, `manage_skill`) | Becerileri okur ve yönetir |

Her aracı, kaynağını ve iznini görmek için [Ayarlar](app:openSettingsPageView) → **Araç İzinleri** bölümünü açın.

## Büyük İçerik Önbelleği {#feature-caching}

Bir araç sonucu konuşma için fazla büyük olduğunda (varsayılan olarak 4K token'dan fazla) AppAgent onu önbelleğe alır. Ajan bir ana hat alır, ardından yalnızca ihtiyaç duyduğu bölümleri okur, arar veya gözden geçirir. Bu, sohbetlerin hızlı ve odaklı kalmasını sağlar. Eşiği (1K ile 100K token arası) [Ayarlar](app:openSettingsPageView) → **Büyük İçerik Önbelleği** bölümünden değiştirin.

## Bağlam Göstergesi {#feature-saturation}

Sohbet girişinin yanındaki **bağlam göstergesi**, konuşmanın ne kadar dolduğunu gösterir. %50'yi geçince Ajan'dan işi toparlaması ve kalan ağır işleri alt ajanlara devretmesi istenir; %100'de durur ve rapor verir. Konuşmayı yeni bir sohbete özetlemek için göstergeye istediğiniz zaman tıklayın.

## Kullanım ve Hız Sınırları {#feature-usage}

- **Kullanım etiketi** — Başlık, API kullanımınızı ve kalan limitlerinizi gösterir; ayrıntılar için tıklayın
- **Otomatik yeniden denemeler** — Sağlayıcı hız sınırına takıldığında veya aşırı yüklendiğinde (HTTP 429 / 529) AppAgent bekler, otomatik olarak yeniden dener ve sohbette bir geri sayım gösterir
- **Kredi bitti** — Bir 429 hatası aslında kredilerinizin tükendiği anlamına geliyorsa, sohbet bunu açıkça belirtir

## Diller {#feature-languages}

Arayüz, İngilizcenin yanı sıra 24 dilde kullanılabilir: Arapça, Çince (Basitleştirilmiş, Geleneksel), Çekçe, Danca, Felemenkçe, Fince, Fransızca (Fransa, Kanada), Almanca, İbranice, Macarca, İtalyanca, Japonca, Korece, Norveççe, Lehçe, Portekizce (Brezilya, Portekiz), Rusça, İspanyolca, İsveççe, Tayca ve Türkçe.

[Ayarlar](app:openSettingsPageView) → **Dil** bölümünden veya başlıktaki hızlı ayarlar menüsünden birini seçin. **Otomatik**, tarayıcınızın dilini izler ve gerekirse İngilizceye döner. Değişiklik yeniden yükleme gerektirmeden hemen uygulanır.

- **Sağdan sola** — Arapça ve İbranice sağdan sola düzen kullanır
- **Yerel biçimler** — Tarihler, saatler ve sayılar dilinize uyar
- **Ajan yanıtları** — Siz başka bir dilde yazmadıkça Ajan seçilen dilde yanıt verir. Kod, tablo ve alan adları değişmeden kalır
- **Bu yardım sayfası** — Sizin dilinizde gösterilir; değişiklik günlüğü İngilizce kalır

# Sayfalar ve Ayarlar {#pages}

## Ayarlar {#page-settings}

[Ayarları Aç →](app:openSettingsPageView)

- **Ajan Modeli** — Ajan'ın kullandığı model
- **API Sağlayıcıları** — API anahtarı veya OAuth ile Anthropic, OpenRouter ya da özel sağlayıcılar
- **LLM Uç Noktaları** — OpenAI uyumlu herhangi bir API için adlandırılmış `URL + API key` çiftleri
- **Alt Ajan Model Katmanları** — small, medium ve large katmanlarını modellerle ya da **Aynı** seçeneğiyle eşleyin
- **Akıl Yürütme Eforu, Maks. Token ve Düşünme Bütçesi** — Yanıtın derinliğini ve uzunluğunu ayarlayın
- **Bağlam Penceresi** — Bağlam göstergesinin kullandığı bağlam boyutu
- **Görünüm** — API istatistikleri, kompakt mod, ekranı açık tutma
- **Dil** — Arayüz dili veya **Otomatik**
- **Kancalar** — Otomatik sohbet başlıkları, "Ajan tamamladı" bildirimleri ve diğer otomasyonlar
- **Büyük İçerik Önbelleği** — Büyük sonuçların ne zaman önbelleğe alınacağı
- **Araç İzinleri** — Nelerin otomatik çalışacağı, önce soracağı veya devre dışı olacağı
- **GitHub** — Bir GitHub hesabı bağlayın ve klonlanan depoları yönetin
- **Sistem İstemi** — Ajan'ın talimatlarını özelleştirin
- **Veri Yönetimi** — Verilerinizi dışa aktarın, içe aktarın veya silin

## Geçmiş {#page-history}

Tüm konuşmalarınız. [Geçmişi Aç →](app:openHistoryView)

- **Ara** — Sohbetleri başlığa, içeriğe, kullanılan araçlara veya widget'lara göre bulun
- **Sabitle** — Önemli sohbetleri en üstte tutun
- **Dışa Aktar** — Tek bir sohbeti veya tüm geçmişinizi indirin
- **İstatistikler** — Sohbet sayısı, sabitlenmiş sohbetler ve toplam maliyet

## Yardım {#page-docs}

Bu sayfa. [Yardımı Aç →](app:openDocsView)

- **Ara** — Araç çubuğundaki arama kutusundan yardım konularını filtreleyin
- **İçindekiler** — Ana hattan bir bölüme atlayın
- **İndir** — Belgeleri bir Markdown dosyası olarak kaydedin

# İpuçları ve Klavye Kısayolları {#tips}

| Eylem | Nasıl |
|--------|-----|
| Mesaj gönderme | <kbd>Enter</kbd> |
| Yeni satır | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Sohbetlerde arama | <kbd>Ctrl</kbd> + <kbd>K</kbd> (Mac'te <kbd>⌘</kbd> + <kbd>K</kbd>) |
| İletişim kutusunu veya menüyü kapatma | <kbd>Esc</kbd> |
| Geri gitme | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Görsel ekleme | Yapıştırın veya sürükleyip sohbete bırakın |
| Özetle yeniden başlama | Bağlam göstergesine tıklayın |
| Ajan'ı kesme | Yeni bir mesaj gönderin veya **Duraklat** düğmesine tıklayın |

:::tip
**Net olun.** *"bunu düzelt"* yerine *"MyUtils script include'unun 42. satırındaki null referans hatasını düzelt"* deyin. Mümkün olduğunda tabloyu, kaydı veya sayfayı adıyla belirtin.
:::

- **Sohbet başına tek hedef** — İlgisiz bir görev için yeni bir sohbet başlatın; Ajan daha hızlı ve daha isabetli kalır
- **Test etmesine izin verin** — Ajan'dan sayfayı açmasını ve kendi değişikliğini bir ekran görüntüsüyle doğrulamasını isteyin
- **Becerileri kullanın** — Başlamadan önce görevinize uygun bir beceriyi (örneğin test veya denetim) etkinleştirin

# Sorun Giderme ve SSS {#faq}

### Ajan örneğimi görmüyor

Örneği aynı Chrome profilindeki bir sekmede açın ve oturum açtığınızdan emin olun, ardından *"örnekleri listele"* deyin. Hâlâ görünmüyorsa örnek sekmesini yeniden yükleyin.

### API veya kimlik doğrulama hatası alıyorum

[Ayarlar](app:openSettingsPageView) → **API Sağlayıcıları** bölümünde sağlayıcınızı kontrol edin: API anahtarı, seçili uç nokta ve model adı. OAuth için aynı Chrome profilinde claude.ai'ye yeniden oturum açın.

### Ajan hız sınırına takıldığını söylüyor

AppAgent otomatik olarak yeniden dener ve bir geri sayım gösterir. Bu sürekli oluyorsa kalan krediler için kullanım etiketini kontrol edin veya alt ajanlar için daha küçük bir model katmanı kullanın.

### Onay istemleri çok fazla veya yetersiz

Örneğin izin düzeyini (**Manuel**, **Otomatik**, **Geliştirici**) örnek açılır menüsünden değiştirin ve tek tek araçları [Ayarlar](app:openSettingsPageView) → **Araç İzinleri** bölümünden ayarlayın.

### Uzun bir sohbette yanıtlar yavaşlıyor veya isabeti azalıyor

Konuşma bağlamını dolduruyor. Bir özetle yeni bir sohbette devam etmek için bağlam göstergesine tıklayın.

### Bir değişikliği nasıl geri alırım?

Sohbet kenar çubuğunu açın ve sürüm geçmişindeki değişiklikte **Geri al** düğmesine tıklayın. **XML'i İndir** tüm değişiklikleri dışa aktarır.

### Verilerim nerede saklanıyor?

Yerel olarak tarayıcınızda (IndexedDB). Sohbetler hiçbir zaman bir AppAgent sunucusuna gitmez — yalnızca yapay zeka sağlayıcınıza ve ServiceNow örneğinize gider. [Veri Depolama](#adv-data-storage) bölümüne bakın.

### Arayüz veya bu sayfa yanlış dilde

Dili [Ayarlar](app:openSettingsPageView) → **Dil** bölümünden seçin. **Otomatik**, tarayıcınızın dilini izler.

# Gelişmiş {#advanced}

Bu bölüm gelişmiş özellikleri, başlık düğmelerini, içe/dışa aktarma biçimlerini ve AppAgent'ın nasıl çalıştığına dair teknik ayrıntıları kapsar.

## Pano Başlık Düğmeleri {#adv-dashboard-header}

Pano başlığında birkaç eylem düğmesi bulunur:

| Düğme | Açıklama |
|--------|-------------|
| **Kenar çubuğunu aç/kapat** | Soldaki kenar çubuğu gezinmesini gösterir veya gizler |
| **Bağımsız Aç** | Panoyu bağımsız görüntüleme için yeni bir tarayıcı sekmesinde açar |
| **Başlıklar** | Panodaki widget başlıklarının görünürlüğünü açıp kapatır. Gizlendiğinde widget'lar daha sade bir görünümde gösterilir |
| **Tümünü Yeniden Oluştur** | Panodaki tüm widget'ları Ajan ile yeniden oluşturur. Verileri yenilemek için kullanışlıdır |
| **İçe Aktar** | Bir JSON dosyasından pano veya widget içe aktarır |
| **Dışa Aktar** | Yedekleme veya paylaşım için panonun tamamını bir JSON dosyasına aktarır |
| **Widget Ekle** | Ajan yardımıyla yeni bir widget oluşturmak için widget düzenleyicisini açar |

## Widget Başlık Düğmeleri {#adv-widget-headers}

**Pano Widget Başlıkları** (Başlıklar anahtarı açıkken görünür):

| Düğme | Açıklama |
|--------|-------------|
| **Sürükleme Tutamacı** | Widget simgesi, widget'ları yeniden sıralamak için sürükleme tutamacı işlevi görür |
| **Yeniden Oluştur** | Ajan'dan bu widget'ın içeriğini yeniden oluşturmasını ister |
| **Geçmiş** | Bu widget'ın önceki sürümlerini görüntüler (varsa) |
| **Tam ekran** | Widget'ı tam ekran görünüme genişletir |
| **Düzenle** | Ajan sohbetiyle değiştirmek için widget düzenleyicisini açar |
| **Sil** | Widget'ı panodan kaldırır (onay ile) |

**Sohbet Widget Başlıkları** (sohbetteki satır içi widget'lar):

| Düğme | Açıklama |
|--------|-------------|
| **Panoya sabitle** | Bu widget'ı panonuza kaydeder |
| **Kodu düzenle** | Widget'ın HTML/CSS/JS kodunu doğrudan görüntüleyip düzenler |
| **Genişlet/Daralt** | Widget içeriğinin görünürlüğünü açıp kapatır |

## Widget'ları Yeniden Boyutlandırma ve Taşıma {#adv-resize-move}

**Widget'ları yeniden boyutlandırma:**

- Her widget'ın sağ alt köşesinde bir **yeniden boyutlandırma tutamacı** vardır
- Widget'ı yeniden boyutlandırmak için tutamaca tıklayıp sürükleyin
- Genişlik 12 sütunlu bir ızgaraya hizalanır (en az 3 sütun)
- Yükseklik 50px'lik birimlerle ölçülür (en az 2 birim = 100px)

**Widget'ları taşıma:**

- Widget başlıklarını göstermek için **Başlıklar** anahtarını açın
- Yeniden sıralamak için **widget simgesine** (sürükleme tutamacı) tıklayıp sürükleyin
- Konumlarını değiştirmek için widget'ı başka bir widget'ın üzerine bırakın
- Widget sırası otomatik olarak kaydedilir

## İçe/Dışa Aktarma Biçimleri {#adv-import-export}

**Pano Dışa Aktarımı** (`dashboard-YYYY-MM-DD.json`):

```
{
  "type": "appagent-dashboard",
  "version": 1,
  "widgets": [
    {
      "id": "widget_123",
      "title": "Widget Title",
      "html": "<html>...</html>",
      "width": 6,
      "height": 8,
      "order": 0,
      "conversation": [...]
    }
  ]
}
```

**Tek Widget Dışa Aktarımı:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Tek Sohbet Dışa Aktarımı** (`chat-title-YYYY-MM-DD.json`):

```
{
  "exportType": "single_chat",
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chat": {
    "id": "chat_123",
    "title": "Chat Title",
    "messages": [
      {
        "role": "user",
        "content": "User message text"
      },
      {
        "role": "assistant",
        "content": "Agent response text"
      }
    ],
    "createdAt": 1705312200000
  }
}
```

Sohbet dışa aktarımları, tüm kullanıcı mesajları ve ajan yanıtları dahil konuşma geçmişinin tamamını korur. Tek tek sohbetleri dışa aktarmak için sohbet açılır menüsünü (···) kullanıp **İndir** seçeneğini seçin.

**Beceri Dışa Aktarımı** (klasör yapısı):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Not:** Beceri içe/dışa aktarımı File System Access API'yi kullanır ve **yalnızca Chrome veya Edge** tarayıcılarında çalışır.
:::

**Tüm Verilerin Dışa Aktarımı** (`appagent-backup-YYYY-MM-DD.json`):

```
{
  "version": 3,
  "exportDate": "2024-01-15T10:30:00.000Z",
  "chats": [...],
  "settings": [...],
  "dashboardWidgets": [...],
  "apiProviders": [...]
}
```

Tam yedekleme; tüm sohbet geçmişini, ayarları, araç izinlerini, pano widget'larını ve API sağlayıcı yapılandırmalarını içerir.

## API İstatistikleri {#adv-api-stats}

Ayarlar'da etkinleştirildiğinde, her Ajan yanıtından sonra API istatistikleri gösterilir:

| Ölçüm | Açıklama |
|--------|-------------|
| **Giriş** | Giriş token'ları — Ajan'a gönderilen istemin boyutu |
| **Çıkış** | Çıkış token'ları — Ajan'ın yanıtının boyutu |
| **Toplam** | Giriş + çıkış token'larının toplamı |
| **Önbellek Okuma/Yazma** | İstem önbelleğinden okunan veya önbelleğe yazılan token'lar (maliyeti düşürür) |
| **Akıl yürütme** | Dahili akıl yürütme için kullanılan token'lar (bazı modellerde) |
| **Maliyet** | API çağrısının USD cinsinden tahmini maliyeti |
| **Süre** | API çağrısının aldığı süre |

Çok turlu konuşmalarda toplu istatistikler, tüm çağrıların toplamını gösterir.

:::tip
API istatistiklerinin gösterimini [Ayarlar](app:openSettingsPageView) → Görünüm → API İstatistiklerini Göster bölümünden açıp kapatın.
:::

## Becerileri Elle Düzenleme {#adv-skills-manual}

Beceriler elle veya Ajan yardımıyla oluşturulup düzenlenebilir:

**Elle beceri oluşturma:**

1. [Beceriler](app:openSkillsView) sayfasına gidin ve **Yeni Beceri** düğmesine tıklayın
2. Bir beceri adı ve açıklaması girin
3. Beceri içeriğini Markdown biçiminde yazın
4. Beceriyi oluşturmak için **Kaydet** düğmesine tıklayın

**SKILL.md biçimi:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Ajanla düzenleme:**

1. Herhangi bir beceride **Ajanla Düzenle** düğmesine tıklayın
2. Hangi değişiklikleri istediğinizi anlatın
3. Ajan beceri içeriğini değiştirir
4. Değişiklikleri gözden geçirip kaydedin

**Beceri varlıkları:** Beceriler, Ajan'a ek bağlam veya kod sağlayan ek dosyalar (XML, JS, MD) içerebilir.

## Sistem İstemi {#adv-system-prompt}

Sistem istemi, Ajan'ın davranışını ve yeteneklerini tanımlar. Onu [Ayarlar](app:openSettingsPageView) bölümünden özelleştirebilirsiniz.

**Sistem İstemini düzenleme:**

1. Ayarlar → Sistem İstemi bölümüne gidin
2. Düzenleme moduna geçmek için **Düzenle** düğmesine tıklayın
3. Şablonu gerektiği gibi değiştirin
4. Değişiklikleri uygulamak için **Kaydet** düğmesine tıklayın

**Kullanılabilir Yer Tutucular:**

| Yer tutucu | Açıklama |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Bugünün tarihi (haftanın günü, ay, gün, yıl) |
| `{{ORCHESTRATOR_POLICY}}` | Alt ajan görev devri politikası — ana sohbetlere eklenir, alt ajan sohbetlerinde boş bırakılır |
| `{{DISABLED_TOOLS}}` | Devre dışı araçların listesi |
| `{{TOOL_CATALOG}}` | Ertelenmiş araç kataloğu (ertelenmiş araç yükleme kapalıyken boştur) |
| `{{SKILLS_SUMMARY}}` | Etkin becerilerin içeriği |

Yer tutucular, yapay zekaya gönderilirken otomatik olarak gerçek değerlerle değiştirilir. Token sayısı göstergesi hem şablon boyutunu hem de genişletilmiş boyutu gösterir.

:::tip
Gerekirse özgün sistem istemini geri yüklemek için **Varsayılana Dön** düğmesine tıklayın.
:::

## Ajan API Çağrıları {#adv-agent-api}

AppAgent bir **Chrome uzantısı** olarak çalışır:

- Yapay zeka API çağrıları **doğrudan tarayıcınızdan yapay zeka sağlayıcısına** gider (ör. Anthropic, OpenRouter)
- Bu çağrılar örneğinizden veya herhangi bir AppAgent sunucusundan **geçmez**
- API anahtarınız (veya OAuth token'ınız) yerel olarak tarayıcınızda saklanır
- Konuşma verileri işlenmek üzere yapay zeka sağlayıcısına gönderilir

**Nasıl çalışır:**

1. Sohbete bir mesaj yazarsınız
2. AppAgent sistem talimatları, araçlar ve konuşma geçmişiyle bir istem oluşturur
3. İstem, yapay zeka sağlayıcısının API'sine gönderilir
4. Ajan'ın yanıtı tarayıcınıza akış halinde geri gelir
5. Araç çağrıları tarayıcınızda yürütülür ve API çağrıları için örnek oturumunuz kullanılır

:::tip
**Gizlilik:** API anahtarınız ve konuşma verileriniz istemci tarafında işlenir. Örneğinizle etkileşime giren araç çağrıları mevcut oturum kimlik bilgilerinizi kullanır.
:::

## LLM Uç Noktaları {#adv-endpoints}

Modeller **adlandırılmış LLM uç noktaları** üzerinden bağlanır — yeniden kullanılabilir `URL + API key` çiftleri. Bu sayede AppAgent'ı **OpenAI uyumlu herhangi bir chat-completions API'sine** yönlendirebilirsiniz: OpenRouter, yerel bir ağ geçidi, bir proxy veya kendi barındırdığınız bir model.

1. [Ayarlar → LLM Uç Noktaları](app:openSettingsPageView) bölümünde **Uç Nokta Ekle** düğmesine tıklayın
2. Bir ad, API URL'si ve API anahtarı girin
3. Her model (API Sağlayıcısı) bir uç nokta seçer — bir anahtarı bir kez güncelleyin, onu kullanan tüm modeller güncellenir

:::tip
Claude **OAuth** sağlayıcıları uç nokta kullanmaz — doğrudan `api.anthropic.com` ile iletişim kurar.
:::

## Claude ile Oturum Açma (OAuth) {#adv-oauth}

API anahtarı yapıştırmak yerine, mevcut claude.ai oturumunuzu kullanarak Anthropic sağlayıcılarında oturum açabilirsiniz:

1. [Ayarlar → API Sağlayıcıları](app:openSettingsPageView) bölümünde bir Anthropic sağlayıcısı ekleyin veya düzenleyin ve **OAuth** seçeneğini etkinleştirin
2. Uzantı, Anthropic'e doğrudan bağlanmak için aynı Chrome profilindeki claude.ai oturumunuzu kullanır
3. Ek bir oturum açma penceresi yoktur ve arada hiçbir AppAgent sunucusu bulunmaz

**Gereksinimler:**

- Aynı Chrome profilinde `claude.ai` hesabına oturum açmış olmanız gerekir
- Çoklu oturum açma (SSO) hesaplarıyla çalışır

:::tip
OAuth token'ları otomatik olarak yenilenir. Oturum açma başarısız olursa aynı profilde `claude.ai` adresini açıp yeniden oturum açın.
:::

## Güvenlik Konuları {#adv-security}

**API Anahtarı Depolama:**

- **API anahtarınız yerel olarak** tarayıcınızın IndexedDB'sinde saklanır
- Anahtar hiçbir zaman örneğinize veya yapay zeka sağlayıcısı dışındaki herhangi bir sunucuya gönderilmez
- Tarayıcı verilerini temizlemek kayıtlı API anahtarınızı siler

**Oturum ve İzinler:**

- Ajan, erişim haklarınızı ve rollerinizi devralarak **mevcut kullanıcı oturumunuzla** çalışır
- Örneğinize yapılan tüm API çağrıları oturum kimlik bilgilerinizi kullanır
- Ajan yalnızca kullanıcı hesabınızın erişebildiği şeylere erişebilir

**Araç Yürütme Ortamı:**

- **Tarayıcı Kodu (js_eval)**, JavaScript'i yalnızca `executeTool()` erişimine sahip **yalıtılmış bir korumalı alanda** çalıştırır
- **Widget betikleri**, API çağrıları için yalnızca `executeTool()` erişimine sahip **yalıtılmış iframe'lerde** çalışır
- **Beceri araçları**, yalnızca `executeTool()` erişimine sahip **yalıtılmış korumalı alanlarda** çalışır
- Tüm API erişimi `executeTool("servicenow_api", {...})` aracılığıyla **izin sisteminden** geçer
- Ajan, ServiceNow örneğinizdeki **tarayıcı sekmelerinde** sayfalarla etkileşim kurar

**Kayıt Değiştirme Yetenekleri:**

- **ServiceNow API** aracı, kayıtları değiştirebilen POST, PATCH, PUT ve DELETE yöntemlerini destekler
- Doldurma ve tıklama araçları için izin verilirse Ajan **tümleşik tarayıcı** üzerinden kayıt oluşturup düzenleyebilir
- Hangi işlemlerin onay gerektireceğini denetlemek için [Araç İzinleri](app:openSettingsPageView) ayarlarını yapılandırın

**Kendini Geliştirme:**

- Ajan **kendi becerilerini yönetebilir** — beceri oluşturabilir, düzenleyebilir ve etkinleştirebilir
- Bu, Ajan'ın zamanla öğrenip kendini geliştirmesini sağlar
- Beklentilerinizle uyumlu olduklarından emin olmak için beceri değişikliklerini düzenli aralıklarla gözden geçirin

## Veri Depolama {#adv-data-storage}

AppAgent verileri **IndexedDB** kullanarak yerel olarak tarayıcınızda saklar:

| Veri Türü | Depolama | Açıklama |
|-----------|---------|-------------|
| **Sohbetler** | IndexedDB | Tüm konuşma geçmişi, mesajlar ve araç sonuçları |
| **Ayarlar** | IndexedDB | Araç izinleri, API anahtarları, model tercihleri |
| **Pano Widget'ları** | IndexedDB | Widget HTML'si, başlıklar, boyutlar ve konuşma geçmişi |
| **Beceriler** | IndexedDB | Beceri tanımları, içerik ve varlıklar |
| **API Sağlayıcıları** | IndexedDB | Özel API sağlayıcı yapılandırmaları ve uç noktalar |
| **Arayüz Durumu** | localStorage | Kenar çubuğu durumu, geçerli görünüm, kaydırma konumları |

**Verilerinizi indirme:**

1. [Ayarlar](app:openSettingsPageView) → Veri Yönetimi bölümüne gidin
2. **Verileri Dışa Aktar** düğmesine tıklayın
3. Bir JSON yedek dosyası indirilir

**Verilerinizi silme:**

1. [Ayarlar](app:openSettingsPageView) → Veri Yönetimi bölümüne gidin
2. **Tüm Verileri Sil** düğmesine tıklayın
3. Her şeyi kalıcı olarak silmek için iki kez onaylayın

:::tip
**Önemli:** Veriler yerel olarak uzantıda saklanır. Tarayıcı verilerini temizlemek, uzantıyı kaldırmak veya farklı bir tarayıcı profili kullanmak ayrı veri depolarıyla sonuçlanır.
:::

# Hakkında {#about}

**Sürüm:** v__VERSION__

**Lisans:** Özel ve Ticari kullanım. Dahili değişikliğe izin verilir. Dağıtım ve yeniden satış yasaktır. Tüm hakları saklıdır.

## Değişiklik Günlüğü {#changelog}

__CHANGELOG__
