# AppAgent

**Rakenna ja ylläpidä ServiceNow-sovelluksia agentin avulla. Chrome-laajennuksena.**

AppAgent on kehityskumppanisi ServiceNow'ssa. Se osaa luoda ja ylläpitää sovelluksia sekä ajaa niille testejä. Testaus tapahtuu täyttämällä lomakkeita ja ottamalla kuvakaappauksia. Teknistä osaamista ei tarvita.

Tuot oman API-avaimesi (BYOK), ja siinä kaikki! Yhteensopiva OpenAI:n, OpenRouterin, Claude API:n ja jopa Claude Code -tilausten kanssa (ota meihin yhteyttä yksityisesti).

Kyseessä on Chrome-laajennus, joka tallentaa koko keskustelun selaimeesi (tiedot eivät edes poistu selaimestasi). Se on yhteydessä vain ServiceNow-instanssiisi ja mallisi API-palveluntarjoajaan.

![AppAgent-esimerkki](AppAgentExample.png)

Se käyttää vähemmän tokeneita kuin Claude Code, koska se hyödyntää vahvasti API-välimuistia, työkalujen välimuistitusta ja työkalujen ketjutusta (valmiina heti käyttöönotosta).

Voit lisätä siihen taitoja, se hallitsee selainta välilehtien kautta, ja siinä on mekaaniset kumoamispainikkeet kaikille muutoksille, joita se tekee instanssiisi.

> **Huomautus:** Toistaiseksi AppAgent on tarkoitettu käytettäväksi vain kehitysinstansseissa.

## Ota yhteyttä

Täytä tämä lomake, niin otamme sinuun yhteyttä: [Yhteydenottolomake](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Ominaisuudet

| Ominaisuus | Mitä se tekee |
|---------|--------------|
| **Oma malli** | Valitse Claude, GPT, Gemini, Grok ja muita |
| **Kirjaudu Claudella** | OAuth-kulku — käytä olemassa olevaa Claude Code Personal- tai Enterprise-tilaustasi, API-avainta ei tarvita |
| **Kuvat ja PDF:t** | Liitä kuvakaappauksia, kaavioita tai asiakirjoja agentin analysoitavaksi |
| **Koodin muokkaus** | Lukee ja muokkaa skriptejä täydellä versioseurannalla |
| **Selaimen ohjaus** | Testaa oman työnsä: siirtyy välilehdillä, napsauttaa, täyttää lomakkeita ja ottaa kuvakaappauksia |
| **Reaaliaikaiset koontinäytöt** | Luo pienoisohjelmia, jotka hakevat reaaliaikaista dataa instanssistasi |
| **Agentin taidot** | Rakenna omia taitoja agentin kykyjen laajentamiseksi |
| **Taitojen toiminnot** | Taidot voivat lisätä aloitussivulle yhden napsautuksen painikkeita, jotka käynnistävät valmiita työnkulkuja |
| **Reaaliaikainen edistyminen** | Näe reaaliajassa, mitä agentti tekee — muuttuvat edistymismerkit tiloilla käynnissä/jumissa/valmis/virhe |
| **Työtilat** | Keskustelukohtainen tiedostojen luonnosalue — kloonaa GitHub-repositorioita, lue, kirjoita, muokkaa, vertaile ja vaihda haaroja. Useita repositorioita keskustelua kohden, ja suojaus keskustelujen välisiä päällekkäisiä muutoksia vastaan |
| **Integroitu Git ja GitHub-push** | Agentti voi hakea GitHubista ja pushata sinne, luoda haaroja ja avata pull requesteja suoraan keskustelusta — ilman terminaalia tai IDE:tä |
| **Älyasiakirjat** | Pysyviä, versioituja Markdown-asiakirjoja, joita agentti voi muokata ja joihin se voi viitata eri keskusteluissa |
| **Useita instansseja** | Tunnistaa automaattisesti jokaisen selaimessasi avoinna olevan ServiceNow-instanssin; agentti näkee ne kaikki ja voi toimia niissä yhdestä keskustelusta |
| **Aliagentit** | Siirtää raskaan tai rinnakkaisen työn taustalla toimiville työntekijäagenteille, jotka raportoivat takaisin pääkeskusteluun |
| **25 kieltä** | Käyttöliittymä ja ohjeet englanniksi ja 24 muulla kielellä, mukaan lukien oikealta vasemmalle kirjoitettavat arabia ja heprea |
| **Keskeytä ja katkaise** | Keskeytä tai lähetä uusi viesti kesken vastauksen — käynnissä oleva kutsu keskeytyy heti |
| **Verkkohaku** | Ilmaiset verkkohaut ilman avainta Googlen ja DuckDuckGon kautta |
| **Mekaaninen kumoaminen** | Jokainen muutos seurataan, peruutus yhdellä napsautuksella |
| **Vienti XML:ksi** | Vie kaikki muutokset käyttöönottoa varten muihin instansseihin |
| **Työkalujen käyttöoikeudet** | Sisäänrakennettu tietoturva: hallitse, mitä agentti saa tehdä instanssissa |
| **Avoimet standardit** | Yhteensopiva [OpenRouterin](https://openrouter.ai) ja [AgentSkills.io:n](https://agentskills.io) kanssa |
| **Mallin välimuistitus** | Vähentää kustannuksia jopa 10-kertaisesti kehotteiden välimuistituksen ansiosta |
| **Älykäs konteksti** | Lataa suurista tiedostoista vain tarvittavat osat. Ei ylikuormita mallia |
| **Ei riippuvuuksia** | Ei kirjastoja, ei kehyksiä, puhdasta vanilla JS:ää |

## Näin se toimii

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

AppAgent on Chrome-laajennus, jossa on sisäänrakennettu agenttisilmukka. Kuvailet, mitä haluat → agentti kysyy mallilta → suorittaa työkaluja selaimessa → käyttää ServiceNow'ta nykyisillä käyttäjäoikeuksillasi. Agentti kommunikoi suoraan mallien API-palveluntarjoajien kanssa, olivat ne sitten paikallisia tai verkossa.

## AppAgent verrattuna muihin

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Kohdekäyttäjä** | Ei-tekninen | Kehittäjät | Kehittäjät | Ei-tekniset perustajat |
| **Tehty ServiceNow'lle** | ✓ | ✗ | ✗ | ✗ |
| **Agenttiset ServiceNow-toiminnot** | ✓ | ✓ | ✗ | ✗ |
| **Vaatii kehitysympäristön** | ✗ | ✓ | ✓ | ✗ |
| **Rakentaa sovelluksia** | ✓ | ✓ | ✓ | ✓ |
| **Selaimen hallinta testaukseen** | ✓ | ✗ | ✗ | ✗ |
| **Ottaa kuvakaappauksia** | ✓ | ✗ | ✗ | ✗ |
| **Taustatehtävät** | ✓ (taitojen toimintojen kautta) | ✗ | ✓ | ✗ |
| **Rinnakkaiset agentit** | ✓ (aliagentit) | ✗ | ✓ | ✗ |
| **Mekaaninen kumoaminen** | ✓ | ✗ | ✗ | ✗ |
| **Kuvat ja PDF:t** | ✓ | ✓ | ✓ | Rajoitettu |
| **Älykkäät koontinäytöt** | ✓ | ✗ | ✗ | ✓ |
| **Laajennettavat taidot** | ✓ | ✓ | ✗ | ✗ |
| **Taitojen toiminnot (yhden napsautuksen painikkeet)** | ✓ | ✗ | ✗ | ✗ |
| **Reaaliaikaiset edistymismerkit** | ✓ | ✗ | ✗ | ✗ |
| **Useiden instanssien tuki** | ✓ | ✗ | ✗ | ✗ |
| **Keskustelukohtaiset työtilat** | ✓ | ✗ | ✗ | ✗ |
| **Integroitu git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push GitHubiin keskustelusta** | ✓ | ✓ (CLI) | Rajoitettu | ✗ |
| **Älyasiakirjat** | ✓ | ✗ | ✗ | ✗ |
| **Keskeytys kesken vastauksen** | ✓ | ✓ | Rajoitettu | ✗ |
| **Verkkohaku** | ✓ | ✓ | ✓ | ✗ |
| **Työkalujen käyttöoikeudet** | ✓ | ✓ | Rajoitettu | ✗ |
| **Muutosten vienti** | ✓ XML | ✓ | ✓ | ✓ |
| **Oma malli** | ✓ | ✗ | ✓ | ✗ |
| **Kehotteiden välimuistitus** | ✓ | ✓ | ✓ | ✗ |
| **Älykäs konteksti** | ✓ | ✓ | ✓ | ✗ |
| **Ei riippuvuuksia** | ✓ | ✗ | ✗ | ✓ |

*Base44 ei pysty rakentamaan ServiceNow-sovelluksia, mutta se on mukana niitä käyttäjiä varten, joille sen käyttökokemus on tuttu.*

## Käyttöönotto

1. **Asenna** — Asenna AppAgent-laajennus Chrome Web Storesta (tai lataa se pakkaamattomana kehitystä varten)
2. **Hanki API-avain** — Rekisteröidy [OpenRouteriin](https://openrouter.ai), käytä Anthropicia/OpenAI:ta suoraan tai yhdistä Claude Code -tilauksesi (Enterprise tai Personal)
3. **Määritä** — Avaa laajennus ja lisää API-avaimesi (tai kirjaudu Claudella) kohdassa Asetukset → API-palveluntarjoajat
4. **Aloita rakentaminen** — Avaa ServiceNow-instanssisi välilehdelle (se tunnistetaan automaattisesti) ja aloita keskustelu

## Esimerkkejä

### ”Rakenna minulle yksinkertainen sovellus tiimin tehtävien seurantaan”
AppAgent luo taulukon, lisää kentät, rakentaa lomake- ja luettelonäkymän ja luo moduulin navigaattoriin. Yksi kehote, valmis sovellus.

### ”Tee tälle instanssille täydellinen auditointi”
AppAgent etsii tietoturva-aukkoja, passiivisia järjestelmänvalvojan tilejä, vanhentuneita tietueita ja poikkeamia määritysten parhaista käytännöistä, ja antaa sitten raportin suosituksineen.

### ”Testaa tämä sivu ja raportoi löytämäsi ongelmat”
AppAgent avaa sivun selaimen välilehdelle, täyttää lomakkeita, napsauttaa painikkeita, ottaa kuvakaappauksia ja kokoaa raportin kaikesta löytämästään.

### ”Tässä lomakkeessa on virhe, voitko korjata sen?”
AppAgent avaa lomakkeen, tutkii sen taustalla olevat skriptit, tunnistaa virheen, korjaa koodin ja näyttää tarkalleen, mitä muuttui. Tarvittaessa kumoat muutoksen yhdellä napsautuksella.

### ”Luo koontinäytön pienoisohjelma avoimille tiketeilleni”
AppAgent luo reaaliaikaisen pienoisohjelman, joka hakee ajantasaista dataa instanssistasi ja näyttää sen koontinäytölläsi.

### ”Tuo tämä Excel-tiedosto käyttäjätaulukkoon”
AppAgent lukee tiedoston, yhdistää sarakkeet kenttiin ja tuo tiedot instanssiisi.

### ”Tarkista päivityshistoria ja korjaa mukautusten ongelmat”
AppAgent käy läpi, mitä päivityksessä muuttui, etsii rikkoutuneet mukautukset ja korjaa ne.

### ”Ilmoita tiimille, kun P1-häiriö luodaan”
AppAgent luo ilmoitussäännön, joka laukeaa P1-häiriöistä ja lähettää hälytyksen tiimillesi.

---

## Visio

Tällä hetkellä Opus 4.7 on erinomainen, mutta vaatii silti jonkin verran valvontaa.

Jatkamme sen rajojen koettelemista, mihin tekoälymallit kussakin sukupolvessa pystyvät, ja nousemme abstraktiotasoja ylöspäin, kunnes törmäämme seinään.

GPT-4 => Koodin täydennys
GPT-4o => Kirjoittaa itsenäisen tiedoston
Sonnet 3.5 => Muokkaa tiedostoa koodikannassa
Opus 4.5 => Kirjoittaa kokonaisen ominaisuuden
Opus 4.6 => Ylläpitää sovellusta alusta loppuun
Opus 4.7 => ... (testaamme vielä)

---

## Tiekartta

- RAG
- Määrittelyt ja testitapaukset

Ei missään tietyssä järjestyksessä.

Tämä versio on pääasiassa palautteen keräämistä varten.

Seuraavat versiot eivät välttämättä ole avointa lähdekoodia, mutta jatkamme tämän version ylläpitoa, kunnes se on vakaa.

---

## Ohjeet osallistujille

Älä avaa pull requesteja: tämä on kaupallinen projekti, ja julkaisemme koodin avoimesti vain läpinäkyvyyden ja luottamuksen vuoksi.

Jos löydät virheitä, voit avata issuen tai ottaa meihin yhteyttä suoraan. Tarjoamme vain kaupallista tukea, joten korjaamme vain virheet, jotka voivat vaikuttaa muihin käyttäjiin.

---

## Lisenssi

Yksityinen ja kaupallinen käyttö. Sisäinen muokkaaminen sallittu. Levittäminen ja jälleenmyynti kielletty.
