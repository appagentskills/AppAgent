# Aloitus {#getting-started}

AppAgent on ServiceNow'n tekoälyagentti, joka toimii Chrome-laajennuksena. Kuvaile tavallisella kielellä, mitä tarvitset, niin agentti hakee tietoja, muokkaa tietueita, rakentaa sovelluksia ja pienoisohjelmia, testaa sivuja selaimessasi ja raportoi tulokset.

:::tip
**Pikaopas:** Määritä malli, avaa ServiceNow-instanssisi välilehdelle, kirjoita pyyntö keskusteluun ja paina <kbd>Enter</kbd>.
:::

## Mallin määrittäminen {#guide-setup}

1. Avaa [Asetukset](app:openSettingsPageView) ja siirry kohtaan **API-palveluntarjoajat**
2. Lisää palveluntarjoaja (Anthropic, OpenRouter tai mukautettu OpenAI-yhteensopiva API) API-avaimellasi — tai ota **OAuth** käyttöön Anthropic-palveluntarjoajalle, niin voit kirjautua Claude-tililläsi
3. Valitse käytettävä malli kohdassa **Agentin malli**

API-avaimesi tallennetaan vain selaimeesi. Tekoälykutsut kulkevat suoraan selaimestasi palveluntarjoajalle.

## Instanssien yhdistäminen {#guide-instances}

AppAgent **tunnistaa automaattisesti jokaisen ServiceNow-instanssin**, joka on avoinna samassa Chrome-profiilissa — yhteysmerkkijonoa ei tarvitse syöttää. Kirjaudu instanssiin tavallisessa välilehdessä, niin agentti voi työskennellä siinä käyttäjäsi rooleilla ja käyttöoikeuksilla. Pyydä *”luettele instanssit”* nähdäksesi kaikki tunnistetut instanssit, roolisi ja yhteyden tilan.

Jokaisella instanssilla on **käyttöoikeustaso**, joka valitaan instanssin pudotusvalikosta:

- **Manuaalinen** — Hyväksyt jokaisen kirjoitustoiminnon (luonti, päivitys, poisto, lomakkeiden täyttö)
- **Auto** — Agentti päättää kirjoitustoiminnoista kysymättä
- **Kehitys** — Ei hyväksyntöjä lainkaan: jokainen työkalukutsu tässä instanssissa suoritetaan kysymättä. Käytä vain kehitysinstansseissa

Lukeminen on aina sallittua. Tarkempaa hallintaa varten katso [Työkalujen käyttöoikeudet](#feature-permissions).

## Keskustelun aloittaminen {#guide-chat}

1. Napsauta sivupalkissa **Uusi keskustelu** [Aloita uusi keskustelu →](app:startNewChat)
2. Kirjoita pyyntösi, esimerkiksi *”Näytä kaikki tänään luodut häiriöt”*
3. Lähetä painamalla <kbd>Enter</kbd>
4. Seuraa agentin työtä: jokainen työkalukutsu näkyy keskustelussa, ja hyväksyntäpyynnöt tulevat esiin, kun vaihe vaatii lupasi

Voit jatkaa kirjoittamista agentin työskennellessä: uuden viestin lähettäminen katkaisee nykyisen vaiheen, ja **Keskeytä** pysäyttää suorituksen.

## Kuvien ja tiedostojen liittäminen {#guide-images}

1. Napsauta syöttöalueen **Liitä tiedosto** -painiketta lisätäksesi kuvan, PDF-, CSV- tai tekstitiedoston
2. Tai liitä kuva leikepöydältä tai vedä ja pudota se keskusteluun
3. Kirjoita kysymyksesi liitteestä

:::tip
Liitä virheiden kuvakaappauksia, käyttöliittymäluonnoksia tai vietyä dataa, jotta agentti näkee täsmälleen saman kuin sinä.
:::

# Tärkeimmät ominaisuudet {#features}

## Keskustelu {#page-chat}

Pääkeskustelunäkymä. [Aloita uusi keskustelu →](app:startNewChat)

- **Viestialue** — Keskustelu, mukaan lukien työkalukutsut ja niiden tulokset
- **Syöttökenttä** — Kirjoita viestejä, liitä tiedostoja; lähetä viesti agentin työskennellessä katkaistaksesi sen
- **Keskeytä / Jatka / Yritä uudelleen** — Pysäytä agentti, jatka sitä tai yritä viimeistä vaihetta uudelleen
- **Kontekstin ilmaisin** — Näyttää, kuinka täynnä keskustelu on; napsauta sitä tiivistääksesi keskustelun uuteen keskusteluun
- **Vastauskortit** — Vastauksen alle voi ilmestyä **Lyhyesti**-yhteenveto ja **Linkit**-kortti (tietueet, PR:t, asiakirjat)
- **Keskustelun otsikkopalkki** — Nimeä keskustelu uudelleen tai kiinnitä se, tai avaa AppAgent koko selainvälilehdelle valinnalla **Laajenna koko sivulle**

## Selaimen hallinta {#feature-browser}

Agentti voi avata ja hallita instanssisi selainvälilehtiä nähdäkseen ja testatakseen sivuja:

- **Siirtyminen, napsautus, täyttö ja valinta** — Realistiset tapahtumat, joten lomakkeet ja automaattisen täydennyksen kentät toimivat kuin olisit itse kirjoittanut
- **Odotus** — Odota elementtiä, tekstiä tai URL-osoitetta viiveiden arvailun sijaan
- **Kuvakaappaukset** — Tallenna sivu, pienoisohjelma tai yksittäinen elementti visuaalista tarkistusta varten
- **Tarkastelu** — Lue elementtien ominaisuuksia, tyylejä, konsolivirheitä ja verkkopyyntöjä
- **Toisena käyttäjänä esiintyminen** — Testaa toisena käyttäjänä ja vaihda sitten takaisin

## Tietueiden muokkaus ja versiohistoria {#feature-history}

Jokainen agentin instanssiisi tekemä muutos seurataan keskustelun sivupalkissa:

- **Kumoa** — Peru yksittäinen muutos
- **Tee uudelleen** — Palauta peruttu muutos
- **Lataa XML** — Vie kaikki muutokset, esimerkiksi siirtääksesi ne toiseen instanssiin

## Aliagentit {#feature-subagents}

Raskasta tai rinnakkaista työtä varten agentti voi käynnistää **aliagentteja**: taustalla toimivia työntekijöitä, jotka toimivat omassa keskustelussaan ja kontekstissaan ja raportoivat sitten lyhyen tuloksen takaisin pääkeskusteluun.

- **Mallitasot** — Jokainen aliagentti toimii tasolla **pieni**, **keskitaso** tai **suuri**, tai tasolla **sama**, jolloin se käyttää emoagentin mallia. Yhdistä tasot malleihin kohdassa [Asetukset](app:openSettingsPageView) → **Aliagenttien mallitasot**
- **Työntekijäpalkki** — Käynnissä olevat aliagentit näkyvät reaaliaikaisina merkkeinä keskustelun syöttökentän yläpuolella; avaa yksi seurataksesi sen edistymistä tai lukeaksesi sen keskustelulokin
- **Allas** — Samanaikaisten aliagenttien määrä on rajoitettu; ylimääräiset odottavat jonossa

## Koontinäyttö ja pienoisohjelmat {#page-dashboard}

Koontinäyttö agentin luomille interaktiivisille pienoisohjelmille. [Avaa koontinäyttö →](app:openDashboardView)

1. Napsauta **Lisää pienoisohjelma**
2. Kuvaile, mitä haluat, esimerkiksi *”Kaavio avoimista häiriöistä prioriteetin mukaan”*
3. Agentti rakentaa pienoisohjelman; pyydä muutoksia tai napsauta **Luo uudelleen** milloin tahansa

Pienoisohjelmat voivat hakea reaaliaikaista dataa instanssistasi, joten ne pysyvät ajan tasalla. Voit vetää, muuttaa kokoa, tuoda ja viedä niitä (katso [Lisäasetukset](#advanced)). Pienoisohjelmat, jotka agentti näyttää suoraan keskustelussa, voi tallentaa valinnalla **Kiinnitä koontinäytölle**.

## Älyasiakirjat {#page-documents}

**Älyasiakirjat** ovat pysyviä, versioituja Markdown-asiakirjoja, joita agentti kirjoittaa ja päivittää — suunnitelmia, raportteja, määrittelyjä, havaintoja. Ne näytetään suoraan keskustelussa, niiden jokainen versio säilytetään, ja voit muokata niitä itse. Avaa ne sivupalkin kohdasta **Asiakirjat**. [Avaa asiakirjat →](app:openDocumentsView)

## Taidot {#page-skills}

Taidot antavat agentille lisätietoa ja -työkaluja. [Avaa taidot →](app:openSkillsView)

- **Ota käyttöön / Poista käytöstä** — Kytke taitoja päälle tai pois; poista tarpeettomat käytöstä, jotta vastaukset pysyvät kohdennettuina
- **Uusi taito** — Kirjoita oma taitosi Markdownilla tai käytä valintaa **Muokkaa agentilla**
- **Tuo / Vie** — Jaa taitoja kansioina
- **Taitojen toiminnot** — Jotkin taidot lisäävät aloitussivulle yhden napsautuksen painikkeita, jotka käynnistävät valmiin työnkulun

Taito voi tarjota **tietoa** (ohjeita, parhaita käytäntöjä) ja **mukautettuja työkaluja** (JavaScript-funktioita, jotka suoritetaan eristetyssä hiekkalaatikossa).

## Työtila ja GitHub {#feature-workspace}

Jokaisella keskustelulla on **työtila** — tiedostoalue, jossa agentti voi lukea, kirjoittaa, muokata ja vertailla tiedostoja.

- **GitHub** — Yhdistä GitHub-tili kohdassa [Asetukset](app:openSettingsPageView) kloonataksesi repositorioita työtilaan. Agentti voi luoda haaroja, pushata committeja ja avata pull requesteja suoraan keskustelusta
- **Pull requestit** — Keskustelusta avatut PR:t luetellaan keskustelun sivupalkissa **Yhdistä**-painikkeen kanssa
- **Suojaus keskustelujen välillä** — Jokainen tiedosto muistaa, mikä keskustelu sitä muutti, joten kaksi rinnakkain työskentelevää keskustelua eivät huomaamatta kirjoita toistensa työn päälle
- **Automaattinen synkronointi** — Kloonatut työtilat synkronoidaan GitHubin kanssa, kun siirryt sivulta toiselle, vaihdat keskustelua tai palaat välilehdelle

## Keskustelun sivupalkki {#feature-sidebar}

Oikeanpuoleinen sivupalkki kokoaa kaiken, mitä nykyinen keskustelu on tuottanut:

- **Pull requestit** — Otsikko, kohdehaara ja **Yhdistä**-painike
- **Työtilan tiedostot** — Avaa tiedosto katsellaksesi sitä, nähdäksesi sen muutokset tai selataksesi aiempia versioita
- **Versiohistoria** — Instanssin muutokset toiminnoilla **Kumoa**, **Tee uudelleen** ja **Lataa XML**
- **Työntekijät** — Käynnissä olevat ja valmiit aliagentit sekä laskurit työkalukutsuille, muokatuille tiedostoille ja avatuille PR:ille

## Toiminnot ja reaaliaikainen edistyminen {#feature-actions}

Pitkät tehtävät näyttävät edistymisensä reaaliajassa sen sijaan, että hiljenisivät:

- **Edistymiskortti** — Yksi kortti, jossa on värikoodattu tila (käynnissä, jumissa, valmis, virhe) ja vaiheluettelo
- **Toimintopainikkeet** — Yhden napsautuksen painikkeet, jotka käynnistävät jatkotyönkulkuja
- **Käynnissä-ilmaisin** — Keskusteluluettelo merkitsee keskustelut, joissa agentti työskentelee
- **”Agentti valmis” -ilmoitus** — Jos vaihdat välilehteä tai ikkunaa suorituksen aikana, työpöytäilmoitus kertoo, kun agentti on valmis

## Aktiiviset keskustelut ja työt {#feature-jobs}

Otsikkopalkin töiden merkki avaa reaaliaikaisen näkymän keskusteluihisi ja taustatöihisi:

- **Aktiiviset keskustelut** — Käynnissä olevat keskustelut ja keskustelut, joissa on lukemattomia tuloksia (näytetään **lihavoituna**), kukin kontekstin käyttöä kuvaavan renkaan kanssa
- **Aliagentit** — Luetellaan emokeskustelunsa alla; avaa yksi lukeaksesi sen keskustelulokin
- **Laajenna** — Avaa luettelo suurempana paneelina sarake- tai osioasettelulla

## Työkalujen käyttöoikeudet {#feature-permissions}

Instanssikohtaisen käyttöoikeustason (**Manuaalinen**, **Auto**, **Kehitys**) lisäksi jokaisella työkalulla on oma asetuksensa kohdassa [Asetukset](app:openSettingsPageView) → **Työkalujen käyttöoikeudet**:

- **Salli** — Työkalu suoritetaan aina kysymättä
- **Auto** — Työkalu suoritetaan kysymättä, ellei agentti merkitse kutsua vahvistustasi vaativaksi
- **Kysy** — Saat hyväksyntäpyynnön ennen jokaista kutsua
- **Pois** — Agentti ei voi käyttää työkalua

Joillakin työkaluilla on tarkemmat asetukset: ServiceNow API HTTP-metodeittain (GET, POST, PUT, PATCH, DELETE), selaimen hallinta toiminnoittain (siirtyminen, napsautus, täyttö, toisena käyttäjänä esiintyminen…) ja taitojen hallinta toiminnoittain. Vahvistusikkunat on värikoodattu riskin mukaan: **sininen** (rutiini), **oranssi** (varovaisuutta), **punainen** (tuhoava).

:::tip
Pidä DELETE ja muut tuhoavat toiminnot asetuksella **Kysy**, ja käytä tasoa **Kehitys** vain kehitysinstansseissa.
:::

## Agentin työkalut {#feature-tools}

Agentin tärkeimmät työkalut:

| Työkalu | Mitä se tekee |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Lukee, luo, päivittää ja poistaa tietueita |
| **Taustaskripti** (`servicenow_run_script`) | Suorittaa palvelinpuolen skriptin instanssissa (vaatii admin-roolin) |
| **Skriptien muokkaus** (`servicenow_diff_edit`) | Muuttaa skriptejä tarkoilla haku ja korvaa -muokkauksilla |
| **Selaimen hallinta** (`iframe_tool`) | Siirtyy, napsauttaa, täyttää, tarkastelee ja esiintyy toisena käyttäjänä selainvälilehdillä |
| **Selainkoodi** (`js_eval`) | Suorittaa JavaScriptiä eristetyssä hiekkalaatikossa, josta voi kutsua muita työkaluja |
| **Kuvakaappaukset** (`take_screenshot`) | Tallentaa sivun, pienoisohjelman tai elementin |
| **Pienoisohjelmat ja kortit** (`html_widget`, `display`) | Näyttää keskustelussa interaktiivisia pienoisohjelmia, taulukoita, kortteja ja aikajanoja |
| **Älyasiakirjat** (`document`) | Luo ja päivittää pysyviä Markdown-asiakirjoja |
| **Käyttäjältä kysyminen** (`prompt_user`) | Pyytää sinulta tietoja upotetulla lomakkeella |
| **Aliagentit** (`spawn_sub_agent`) | Delegoi työtä taustatyöntekijöille |
| **Työtila** (`workspace`) | Käsittelee tiedostoja ja GitHub-repositorioita |
| **Verkkohaku** (`web_fetch`) | Lukee sivuja julkisesta verkosta |
| **Taidot** (`get_skill`, `manage_skill`) | Lukee ja hallitsee taitoja |

Avaa [Asetukset](app:openSettingsPageView) → **Työkalujen käyttöoikeudet** nähdäksesi jokaisen työkalun, sen lähteen ja käyttöoikeuden.

## Suuren sisällön välimuistitus {#feature-caching}

Kun työkalun tulos on liian suuri keskusteluun (oletuksena yli 4K tokenia), AppAgent tallentaa sen välimuistiin. Agentti saa rakenteen ja lukee, hakee tai selaa sitten vain tarvitsemiaan osia. Näin keskustelut pysyvät nopeina ja kohdennettuina. Muuta kynnysarvoa (1K–100K tokenia) kohdassa [Asetukset](app:openSettingsPageView) → **Suuren sisällön välimuistitus**.

## Kontekstin ilmaisin {#feature-saturation}

Keskustelun syöttökentän vieressä oleva **kontekstin ilmaisin** näyttää, kuinka täynnä keskustelu on. Kun 50 % ylittyy, agenttia pyydetään viimeistelemään työ ja siirtämään jäljellä oleva raskas työ aliagenteille; 100 %:ssa se pysähtyy ja raportoi. Napsauta ilmaisinta milloin tahansa tiivistääksesi keskustelun uuteen keskusteluun.

## Käyttö ja käyttörajat {#feature-usage}

- **Käyttömerkki** — Otsikkopalkki näyttää API-käyttösi ja jäljellä olevat rajat; napsauta sitä nähdäksesi lisätiedot
- **Automaattiset uudelleenyritykset** — Kun palveluntarjoaja rajoittaa pyyntöjä tai on ylikuormittunut (HTTP 429 / 529), AppAgent odottaa ja yrittää automaattisesti uudelleen sekä näyttää keskustelussa lähtölaskennan
- **Krediitit loppu** — Kun 429 tarkoittaa, että krediittisi ovat lopussa, keskustelu kertoo sen selkeästi

## Kielet {#feature-languages}

Käyttöliittymä on saatavilla englanniksi ja 24 muulla kielellä: arabia, kiina (yksinkertaistettu, perinteinen), tšekki, tanska, hollanti, suomi, ranska (Ranska, Kanada), saksa, heprea, unkari, italia, japani, korea, norja, puola, portugali (Brasilia, Portugali), venäjä, espanja, ruotsi, thai ja turkki.

Valitse kieli kohdassa [Asetukset](app:openSettingsPageView) → **Kieli** tai otsikkopalkin pika-asetusvalikosta. **Auto** seuraa selaimesi kieltä ja käyttää varalla englantia. Muutos tulee voimaan heti ilman uudelleenlatausta.

- **Oikealta vasemmalle** — Arabia ja heprea käyttävät oikealta vasemmalle -asettelua
- **Paikalliset muodot** — Päivämäärät, kellonajat ja numerot noudattavat kieltäsi
- **Agentin vastaukset** — Agentti vastaa valitulla kielellä, ellet kirjoita jollain toisella. Koodi sekä taulukoiden ja kenttien nimet pysyvät ennallaan
- **Tämä ohjesivu** — Näytetään omalla kielelläsi; muutosloki pysyy englanninkielisenä

# Sivut ja asetukset {#pages}

## Asetukset {#page-settings}

[Avaa asetukset →](app:openSettingsPageView)

- **Agentin malli** — Malli, jota agentti käyttää
- **API-palveluntarjoajat** — Anthropic, OpenRouter tai mukautetut palveluntarjoajat, API-avaimella tai OAuthilla
- **LLM-päätepisteet** — Nimettyjä `URL + API key` -pareja mille tahansa OpenAI-yhteensopivalle API:lle
- **Aliagenttien mallitasot** — Yhdistä pieni, keskitaso ja suuri taso malleihin tai valitse **Sama**
- **Päättelyn taso, tokenien enimmäismäärä ja ajattelubudjetti** — Säädä vastausten syvyyttä ja pituutta
- **Konteksti-ikkuna** — Kontekstin koko, jota kontekstin ilmaisin käyttää
- **Näyttö** — API-tilastot, kompakti tila, näytön pitäminen päällä
- **Kieli** — Käyttöliittymän kieli tai **Auto**
- **Koukut** — Automaattiset keskustelujen otsikot, ”Agentti valmis” -ilmoitukset ja muu automaatio
- **Suuren sisällön välimuistitus** — Milloin suuret tulokset tallennetaan välimuistiin
- **Työkalujen käyttöoikeudet** — Mikä suoritetaan automaattisesti, mikä kysyy ensin ja mikä on poistettu käytöstä
- **GitHub** — Yhdistä GitHub-tili ja hallitse kloonattuja repositorioita
- **Järjestelmäkehote** — Mukauta agentin ohjeita
- **Tietojen hallinta** — Vie, tuo tai poista tietosi

## Historia {#page-history}

Kaikki keskustelusi. [Avaa historia →](app:openHistoryView)

- **Haku** — Etsi keskusteluja otsikon, sisällön, käytettyjen työkalujen tai pienoisohjelmien perusteella
- **Kiinnitä** — Pidä tärkeät keskustelut ylimpänä
- **Vie** — Lataa yksi keskustelu tai koko historiasi
- **Tilastot** — Keskustelujen ja kiinnitettyjen keskustelujen määrä sekä kokonaiskustannus

## Ohje {#page-docs}

Tämä sivu. [Avaa ohje →](app:openDocsView)

- **Haku** — Suodata ohjeaiheita työkalupalkin hakukentästä
- **Sisältö** — Siirry osioon sisällysluettelon kautta
- **Lataa** — Tallenna dokumentaatio Markdown-tiedostona

# Vinkit ja pikanäppäimet {#tips}

| Toiminto | Miten |
|--------|-----|
| Lähetä viesti | <kbd>Enter</kbd> |
| Uusi rivi | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Hae keskusteluja | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> Macissa) |
| Sulje valintaikkuna tai valikko | <kbd>Esc</kbd> |
| Palaa takaisin | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Liitä kuva | Liitä se tai vedä ja pudota se keskusteluun |
| Aloita alusta yhteenvedon kanssa | Napsauta kontekstin ilmaisinta |
| Katkaise agentin työ | Lähetä uusi viesti tai napsauta **Keskeytä** |

:::tip
**Ole täsmällinen.** Sen sijaan, että sanot *”korjaa tämä”*, sano *”korjaa null-viittausvirhe MyUtils-skripti-includen rivillä 42”*. Nimeä taulukko, tietue tai sivu aina kun voit.
:::

- **Yksi tavoite keskustelua kohden** — Aloita uusi keskustelu, kun tehtävä ei liity edelliseen; agentti pysyy nopeampana ja tarkempana
- **Anna sen testata** — Pyydä agenttia avaamaan sivu ja varmistamaan oma muutoksensa kuvakaappauksella
- **Käytä taitoja** — Ota ennen aloittamista käyttöön tehtävääsi sopiva taito (esimerkiksi testaus tai auditointi)

# Vianmääritys ja usein kysytyt kysymykset {#faq}

### Agentti ei näe instanssiani

Avaa instanssi saman Chrome-profiilin välilehdelle ja varmista, että olet kirjautunut sisään, ja pyydä sitten *”luettele instanssit”*. Jos se ei vieläkään näy, lataa instanssin välilehti uudelleen.

### Saan API- tai todennusvirheen

Tarkista palveluntarjoajasi kohdassa [Asetukset](app:openSettingsPageView) → **API-palveluntarjoajat**: API-avain, valittu päätepiste ja mallin nimi. OAuthia käyttäessäsi kirjaudu uudelleen claude.ai-palveluun samassa Chrome-profiilissa.

### Agentti ilmoittaa käyttörajoituksesta

AppAgent yrittää automaattisesti uudelleen ja näyttää lähtölaskennan. Jos tätä tapahtuu jatkuvasti, tarkista jäljellä olevat krediitit käyttömerkistä tai käytä aliagenteille pienempää mallitasoa.

### Liian monta hyväksyntäpyyntöä, tai liian vähän

Muuta instanssin käyttöoikeustasoa (**Manuaalinen**, **Auto**, **Kehitys**) instanssin pudotusvalikosta ja säädä yksittäisiä työkaluja kohdassa [Asetukset](app:openSettingsPageView) → **Työkalujen käyttöoikeudet**.

### Vastaukset hidastuvat tai muuttuvat epätarkemmiksi pitkässä keskustelussa

Keskustelun konteksti on täyttymässä. Napsauta kontekstin ilmaisinta jatkaaksesi uudessa keskustelussa yhteenvedon kanssa.

### Miten kumoan muutoksen?

Avaa keskustelun sivupalkki ja napsauta versiohistoriassa muutoksen kohdalla **Kumoa**. **Lataa XML** vie kaikki muutokset.

### Missä tietoni tallennetaan?

Paikallisesti selaimeesi (IndexedDB). Keskustelut eivät koskaan päädy AppAgentin palvelimelle — vain tekoälypalveluntarjoajallesi ja ServiceNow-instanssiisi. Katso [Tietojen tallennus](#adv-data-storage).

### Käyttöliittymä tai tämä sivu on väärällä kielellä

Valitse kieli kohdassa [Asetukset](app:openSettingsPageView) → **Kieli**. **Auto** seuraa selaimesi kieltä.

# Lisäasetukset {#advanced}

Tässä osiossa käsitellään lisäominaisuuksia, otsikkopalkin painikkeita, tuonti- ja vientimuotoja sekä teknisiä yksityiskohtia AppAgentin toiminnasta.

## Koontinäytön otsikkopalkin painikkeet {#adv-dashboard-header}

Koontinäytön otsikkopalkissa on useita toimintopainikkeita:

| Painike | Kuvaus |
|--------|-------------|
| **Näytä tai piilota sivupalkki** | Näytä tai piilota vasemman reunan sivupalkkinavigointi |
| **Avaa erillisenä** | Avaa koontinäyttö uudelle selainvälilehdelle erillistä katselua varten |
| **Otsakkeet** | Näytä tai piilota koontinäytön pienoisohjelmien otsakkeet. Kun ne on piilotettu, pienoisohjelmat näytetään selkeämmässä näkymässä |
| **Luo kaikki uudelleen** | Luo kaikki koontinäytön pienoisohjelmat uudelleen agentin avulla. Hyödyllinen datan päivittämiseen |
| **Tuo** | Tuo koontinäyttö tai pienoisohjelma JSON-tiedostosta |
| **Vie** | Vie koko koontinäyttö JSON-tiedostoon varmuuskopiointia tai jakamista varten |
| **Lisää pienoisohjelma** | Avaa pienoisohjelmaeditorin uuden pienoisohjelman luomiseksi agentin avustuksella |

## Pienoisohjelmien otsakkeiden painikkeet {#adv-widget-headers}

**Koontinäytön pienoisohjelmien otsakkeet** (näkyvissä, kun Otsakkeet-valinta on päällä):

| Painike | Kuvaus |
|--------|-------------|
| **Vetokahva** | Pienoisohjelman kuvake toimii vetokahvana pienoisohjelmien järjestyksen muuttamiseen |
| **Luo uudelleen** | Pyydä agenttia luomaan tämän pienoisohjelman sisältö uudelleen |
| **Historia** | Näytä tämän pienoisohjelman aiemmat versiot (jos saatavilla) |
| **Koko näyttö** | Laajenna pienoisohjelma koko näytön näkymään |
| **Muokkaa** | Avaa pienoisohjelmaeditori muokataksesi agenttikeskustelun avulla |
| **Poista** | Poista pienoisohjelma koontinäytöltä (vahvistuksen kanssa) |

**Keskustelun pienoisohjelmien otsakkeet** (keskusteluun upotetut pienoisohjelmat):

| Painike | Kuvaus |
|--------|-------------|
| **Kiinnitä koontinäytölle** | Tallenna tämä pienoisohjelma koontinäytöllesi |
| **Muokkaa koodia** | Näytä ja muokkaa pienoisohjelman HTML/CSS/JS-koodia suoraan |
| **Laajenna/Tiivistä** | Näytä tai piilota pienoisohjelman sisältö |

## Pienoisohjelmien koon muuttaminen ja siirtäminen {#adv-resize-move}

**Pienoisohjelmien koon muuttaminen:**

- Jokaisen pienoisohjelman oikeassa alakulmassa on **koonmuutoskahva**
- Muuta pienoisohjelman kokoa napsauttamalla ja vetämällä kahvaa
- Leveys kohdistuu 12 sarakkeen ruudukkoon (vähintään 3 saraketta)
- Korkeus mitataan 50 px:n yksiköissä (vähintään 2 yksikköä = 100 px)

**Pienoisohjelmien siirtäminen:**

- Ota **Otsakkeet**-valinta käyttöön näyttääksesi pienoisohjelmien otsakkeet
- Muuta järjestystä napsauttamalla ja vetämällä **pienoisohjelman kuvaketta** (vetokahvaa)
- Pudota pienoisohjelma toisen pienoisohjelman päälle vaihtaaksesi niiden paikkaa
- Pienoisohjelmien järjestys tallennetaan automaattisesti

## Tuonti- ja vientimuodot {#adv-import-export}

**Koontinäytön vienti** (`dashboard-YYYY-MM-DD.json`):

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

**Yksittäisen pienoisohjelman vienti:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Yksittäisen keskustelun vienti** (`chat-title-YYYY-MM-DD.json`):

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

Keskustelujen viennit säilyttävät koko keskusteluhistorian, mukaan lukien kaikki käyttäjän viestit ja agentin vastaukset. Vie yksittäisiä keskusteluja valitsemalla keskustelun pudotusvalikosta (···) **Lataa**.

**Taitojen vienti** (kansiorakenne):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Huomautus:** Taitojen tuonti ja vienti käyttää File System Access API:a ja **toimii vain Chrome- tai Edge-selaimessa**.
:::

**Kaikkien tietojen vienti** (`appagent-backup-YYYY-MM-DD.json`):

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

Täysi varmuuskopio sisältää koko keskusteluhistorian, asetukset, työkalujen käyttöoikeudet, koontinäytön pienoisohjelmat ja API-palveluntarjoajien määritykset.

## API-tilastot {#adv-api-stats}

Kun ne on otettu käyttöön asetuksissa, API-tilastot näytetään jokaisen agentin vastauksen jälkeen:

| Mittari | Kuvaus |
|--------|-------------|
| **Sisään** | Syötetokenit — agentille lähetetyn kehotteen koko |
| **Ulos** | Tulostetokenit — agentin vastauksen koko |
| **Yhteensä** | Syöte- ja tulostetokenit yhteensä |
| **Välimuistin luku/kirjoitus** | Kehotevälimuistista luetut tai sinne kirjoitetut tokenit (vähentää kustannuksia) |
| **Päättely** | Sisäiseen päättelyyn käytetyt tokenit (joillakin malleilla) |
| **Kustannus** | API-kutsun arvioitu hinta Yhdysvaltain dollareina |
| **Kesto** | API-kutsuun kulunut aika |

Monivaiheisissa keskusteluissa koostetilastot näyttävät kaikkien kutsujen kokonaismäärän.

:::tip
Ota API-tilastojen näyttö käyttöön tai pois kohdassa [Asetukset](app:openSettingsPageView) → Näyttö → Näytä API-tilastot.
:::

## Taitojen manuaalinen muokkaus {#adv-skills-manual}

Taitoja voi luoda ja muokata manuaalisesti tai agentin avustuksella:

**Taidon luominen manuaalisesti:**

1. Siirry kohtaan [Taidot](app:openSkillsView) ja napsauta **Uusi taito**
2. Anna taidolle nimi ja kuvaus
3. Kirjoita taidon sisältö Markdown-muodossa
4. Luo taito napsauttamalla **Tallenna**

**SKILL.md-muoto:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Muokkaus agentin avulla:**

1. Napsauta minkä tahansa taidon kohdalla **Muokkaa agentilla**
2. Kuvaile haluamasi muutokset
3. Agentti muokkaa taidon sisältöä
4. Tarkista ja tallenna muutokset

**Taitojen resurssit:** Taitoihin voi sisältyä lisätiedostoja (XML, JS, MD), jotka tarjoavat agentille lisäkontekstia tai koodia.

## Järjestelmäkehote {#adv-system-prompt}

Järjestelmäkehote määrittää agentin toiminnan ja kyvyt. Voit mukauttaa sitä kohdassa [Asetukset](app:openSettingsPageView).

**Järjestelmäkehotteen muokkaaminen:**

1. Siirry kohtaan Asetukset → Järjestelmäkehote
2. Siirry muokkaustilaan napsauttamalla **Muokkaa**
3. Muokkaa mallipohjaa tarpeen mukaan
4. Ota muutokset käyttöön napsauttamalla **Tallenna**

**Käytettävissä olevat paikkamerkit:**

| Paikkamerkki | Kuvaus |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Tämän päivän päivämäärä (viikonpäivä, kuukausi, päivä, vuosi) |
| `{{ORCHESTRATOR_POLICY}}` | Aliagenteille delegoinnin käytäntö — sisällytetään pääkeskusteluihin, jätetään tyhjäksi aliagenttien keskusteluissa |
| `{{DISABLED_TOOLS}}` | Luettelo käytöstä poistetuista työkaluista |
| `{{TOOL_CATALOG}}` | Viivästetysti ladattavien työkalujen luettelo (tyhjä, kun työkalujen viivästetty lataus on pois päältä) |
| `{{SKILLS_SUMMARY}}` | Käytössä olevien taitojen sisältö |

Paikkamerkit korvataan automaattisesti todellisilla arvoilla, kun kehote lähetetään tekoälylle. Tokenmäärän näyttö näyttää sekä mallipohjan koon että laajennetun koon.

:::tip
Napsauta **Palauta oletus** palauttaaksesi alkuperäisen järjestelmäkehotteen tarvittaessa.
:::

## Agentin API-kutsut {#adv-agent-api}

AppAgent toimii **Chrome-laajennuksena**:

- Tekoälyn API-kutsut kulkevat **suoraan selaimestasi tekoälypalveluntarjoajalle** (esim. Anthropic, OpenRouter)
- Ne **eivät** kulje instanssisi tai minkään AppAgent-palvelimen kautta
- API-avaimesi (tai OAuth-tunnuksesi) tallennetaan paikallisesti selaimeesi
- Keskustelun tiedot lähetetään tekoälypalveluntarjoajalle käsiteltäviksi

**Näin se toimii:**

1. Kirjoitat viestin keskusteluun
2. AppAgent kokoaa kehotteen järjestelmäohjeista, työkaluista ja keskusteluhistoriasta
3. Kehote lähetetään tekoälypalveluntarjoajan API:in
4. Agentin vastaus virtaa takaisin selaimeesi
5. Työkalukutsut suoritetaan selaimessasi, ja API-kutsuissa käytetään instanssisi istuntoa

:::tip
**Yksityisyys:** API-avaintasi ja keskustelutietojasi käsitellään asiakaspuolella. Instanssiisi kohdistuvat työkalukutsut käyttävät olemassa olevan istuntosi tunnistetietoja.
:::

## LLM-päätepisteet {#adv-endpoints}

Mallit yhdistetään **nimettyjen LLM-päätepisteiden** kautta — uudelleenkäytettävien `URL + API key` -parien. Näin voit ohjata AppAgentin **mihin tahansa OpenAI-yhteensopivaan chat-completions-API:in**: OpenRouteriin, paikalliseen yhdyskäytävään, välityspalvelimeen tai omaan isännöityyn malliisi.

1. Napsauta kohdassa [Asetukset → LLM-päätepisteet](app:openSettingsPageView) **Lisää päätepiste**
2. Anna sille nimi, API:n URL-osoite ja API-avain
3. Jokainen malli (API-palveluntarjoaja) valitsee päätepisteen — päivitä avain kerran, niin jokainen sitä käyttävä malli päivittyy

:::tip
Clauden **OAuth**-palveluntarjoajat eivät käytä päätepisteitä — ne ovat yhteydessä suoraan osoitteeseen `api.anthropic.com`.
:::

## Kirjaudu Claudella (OAuth) {#adv-oauth}

API-avaimen liittämisen sijaan voit kirjautua Anthropic-palveluntarjoajiin olemassa olevalla claude.ai-istunnollasi:

1. Lisää tai muokkaa kohdassa [Asetukset → API-palveluntarjoajat](app:openSettingsPageView) Anthropic-palveluntarjoajaa ja ota **OAuth** käyttöön
2. Laajennus käyttää saman Chrome-profiilin claude.ai-kirjautumistasi ja muodostaa yhteyden suoraan Anthropiciin
3. Ei ylimääräistä kirjautumisikkunaa eikä AppAgent-palvelinta välissä

**Vaatimukset:**

- Sinun on oltava kirjautuneena palveluun `claude.ai` samassa Chrome-profiilissa
- Toimii kertakirjautumistilien (SSO) kanssa

:::tip
OAuth-tunnukset päivitetään automaattisesti. Jos kirjautuminen epäonnistuu, avaa `claude.ai` samassa profiilissa ja kirjaudu uudelleen.
:::

## Tietoturvanäkökohdat {#adv-security}

**API-avaimen tallennus:**

- **API-avaimesi tallennetaan paikallisesti** selaimesi IndexedDB:hen
- Avainta ei koskaan lähetetä instanssiisi tai millekään muulle palvelimelle kuin tekoälypalveluntarjoajalle
- Selaimen tietojen tyhjentäminen poistaa tallennetun API-avaimesi

**Istunto ja käyttöoikeudet:**

- Agentti toimii **nykyisellä käyttäjäistunnollasi** ja perii käyttöoikeutesi ja roolisi
- Kaikki instanssiisi kohdistuvat API-kutsut käyttävät istuntosi tunnistetietoja
- Agentti pääsee käsiksi vain siihen, mihin käyttäjätililläsi on pääsy

**Työkalujen suoritusympäristö:**

- **Selainkoodi (js_eval)** suorittaa JavaScriptiä **eristetyssä hiekkalaatikossa**, jossa on pääsy vain `executeTool()`-funktioon
- **Pienoisohjelmien skriptit** suoritetaan **eristetyissä iframe-kehyksissä**, joissa API-kutsuihin on pääsy vain `executeTool()`-funktion kautta
- **Taitojen työkalut** suoritetaan **eristetyissä hiekkalaatikoissa**, joissa on pääsy vain `executeTool()`-funktioon
- Kaikki API-käyttö kulkee **käyttöoikeusjärjestelmän** kautta kutsulla `executeTool("servicenow_api", {...})`
- Agentti käyttää sivuja ServiceNow-instanssisi **selainvälilehdillä**

**Tietueiden muokkausmahdollisuudet:**

- **ServiceNow API** -työkalu tukee POST-, PATCH-, PUT- ja DELETE-metodeja, jotka voivat muuttaa tietueita
- Agentti voi luoda ja muokata tietueita **integroidun selaimen** kautta, jos sille on annettu täyttö- ja napsautustyökalujen käyttöoikeudet
- Määritä [Työkalujen käyttöoikeudet](app:openSettingsPageView) hallitaksesi, mitkä toiminnot vaativat hyväksynnän

**Itsensä kehittäminen:**

- Agentti voi **hallita omia taitojaan** — luoda, muokata ja ottaa käyttöön taitoja
- Näin agentti voi oppia ja kehittää itseään ajan mittaan
- Tarkista taitojen muutokset säännöllisesti varmistaaksesi, että ne vastaavat odotuksiasi

## Tietojen tallennus {#adv-data-storage}

AppAgent tallentaa tiedot paikallisesti selaimeesi käyttäen **IndexedDB**:tä:

| Tietotyyppi | Tallennus | Kuvaus |
|-----------|---------|-------------|
| **Keskustelut** | IndexedDB | Koko keskusteluhistoria, viestit ja työkalujen tulokset |
| **Asetukset** | IndexedDB | Työkalujen käyttöoikeudet, API-avaimet, mallivalinnat |
| **Koontinäytön pienoisohjelmat** | IndexedDB | Pienoisohjelmien HTML, otsikot, koot ja keskusteluhistoria |
| **Taidot** | IndexedDB | Taitojen määritelmät, sisältö ja resurssit |
| **API-palveluntarjoajat** | IndexedDB | Mukautettujen API-palveluntarjoajien määritykset ja päätepisteet |
| **Käyttöliittymän tila** | localStorage | Sivupalkin tila, nykyinen näkymä, vierityskohdat |

**Tietojesi lataaminen:**

1. Siirry kohtaan [Asetukset](app:openSettingsPageView) → Tietojen hallinta
2. Napsauta **Vie tiedot**
3. JSON-varmuuskopiotiedosto ladataan

**Tietojesi poistaminen:**

1. Siirry kohtaan [Asetukset](app:openSettingsPageView) → Tietojen hallinta
2. Napsauta **Poista kaikki tiedot**
3. Vahvista kahdesti poistaaksesi kaiken pysyvästi

:::tip
**Tärkeää:** Tiedot tallennetaan paikallisesti laajennukseen. Selaimen tietojen tyhjentäminen, laajennuksen poistaminen tai eri selainprofiilin käyttäminen johtaa erillisiin tietovarastoihin.
:::

# Tietoja {#about}

**Versio:** v__VERSION__

**Lisenssi:** Yksityinen ja kaupallinen käyttö. Sisäinen muokkaaminen sallittu. Levittäminen ja jälleenmyynti kielletty. Kaikki oikeudet pidätetään.

## Muutosloki {#changelog}

__CHANGELOG__
