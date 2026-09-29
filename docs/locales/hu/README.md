# AppAgent

**ServiceNow-alkalmazások készítése és karbantartása egy ügynökkel. Chrome-bővítményként.**

Az AppAgent az Ön fejlesztőpartnere a ServiceNow-hoz. Képes alkalmazásokat létrehozni és karbantartani, valamint teszteket futtatni rajtuk. A tesztelést űrlapok kitöltésével és képernyőképek készítésével végzi. Nincs szükség műszaki tudásra.

Csak a saját API-kulcsát kell hoznia (BYOK), és ennyi! Kompatibilis az OpenAI-jal, az OpenRouterrel, a Claude API-val, sőt a Claude Code-előfizetésekkel is (lépjen velünk kapcsolatba privátban).

Ez egy Chrome-bővítmény, amely a teljes csevegést a böngészőjében tárolja (az adatok el sem hagyják a böngészőt). Kizárólag a ServiceNow-példányával és a modell API-szolgáltatójával kommunikál.

![AppAgent példa](AppAgentExample.png)

Kevesebb tokent használ, mint a Claude Code, mivel nagymértékben támaszkodik az API-gyorsítótárra, az eszközök gyorsítótárazására és az eszközláncolásra (alapból, beállítás nélkül).

Készségeket adhat hozzá, lapokon keresztül vezérli a böngészőt, és minden módosításához, amelyet a példányán végez, mechanikus visszavonás gomb tartozik.

> **Megjegyzés:** Egyelőre az AppAgent kizárólag fejlesztői példányokon való használatra készült.

## Kapcsolat

Töltse ki ezt az űrlapot, és felvesszük Önnel a kapcsolatot: [Kapcsolatfelvételi űrlap](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funkciók

| Funkció | Mire szolgál |
|---------|--------------|
| **Saját modell használata** | Válasszon a Claude, GPT, Gemini, Grok és más modellek közül |
| **Bejelentkezés Claude-dal** | OAuth-folyamat — használja meglévő Claude Code Personal vagy Enterprise előfizetését, API-kulcs nélkül |
| **Képek és PDF-ek** | Csatoljon képernyőképeket, diagramokat vagy dokumentumokat, hogy az ügynök elemezze őket |
| **Kódszerkesztés** | Szkripteket olvas és módosít, teljes verziókövetéssel |
| **Böngészővezérlés** | Teszteli a saját munkáját: lapokon navigál, kattint, űrlapokat tölt ki, képernyőképeket készít |
| **Élő irányítópultok** | Olyan widgeteket készít, amelyek valós idejű adatokat kérnek le a példányáról |
| **Ügynökkészségek** | Készítsen saját készségeket az ügynök képességeinek bővítéséhez |
| **Készségműveletek** | A készségek egykattintásos gombokat helyezhetnek el a kezdőlapon, amelyek előre beállított munkafolyamatokat indítanak |
| **Élő előrehaladás** | Valós időben láthatja, mit csinál az ügynök — változó folyamatjelzők fut/elakadt/kész/hiba állapotokkal |
| **Munkaterületek** | Csevegésenkénti fájlterület — GitHub-tárolók klónozása, olvasás, írás, szerkesztés, összehasonlítás és ágváltás. Csevegésenként több tároló, a csevegések közötti tulajdonjog-védelemmel |
| **Integrált Git és GitHub-feltöltés** | Az ügynök közvetlenül a csevegésből tud a GitHubról lekérni és oda feltölteni, ágakat létrehozni és pull requesteket nyitni — terminál és IDE nélkül |
| **Intelligens dokumentumok** | Tartós, verziókezelt Markdown, amelyet az ügynök szerkeszthet és csevegéseken átívelően hivatkozhat |
| **Több példány** | Automatikusan felismeri a böngészőjében megnyitott összes ServiceNow-példányt; az ügynök egyetlen csevegésből láthatja és kezelheti mindegyiket |
| **Alügynökök** | A nagyobb vagy párhuzamos munkát háttérben futó feldolgozó ügynököknek adja át, amelyek visszajelentenek a fő csevegésnek |
| **25 nyelv** | A felület és a súgó angolul és további 24 nyelven, beleértve a jobbról balra író arabot és hébert |
| **Szüneteltetés és megszakítás** | Szüneteltesse, vagy küldjön új üzenetet válasz közben — a folyamatban lévő hívás azonnal megszakad |
| **Webes keresés** | Ingyenes, kulcs nélküli webes keresés a Google-on és a DuckDuckGo-n keresztül |
| **Mechanikus visszavonás** | Minden módosítás nyomon követve, egy kattintással visszaállítható |
| **Exportálás XML-be** | Az összes módosítás exportálása más példányokra való telepítéshez |
| **Eszközengedélyek** | Beépített biztonság: szabályozza, mit tehet az ügynök a példányon |
| **Nyílt szabványok** | Kompatibilis az [OpenRouter](https://openrouter.ai) és az [AgentSkills.io](https://agentskills.io) szolgáltatással |
| **Modell-gyorsítótárazás** | A promptgyorsítótárazással akár 10-szeresére csökkenti a költségeket |
| **Intelligens kontextus** | A nagy fájloknak csak a szükséges részeit tölti be. Nem terheli túl a modellt |
| **Nulla függőség** | Nincsenek könyvtárak, nincsenek keretrendszerek, tiszta vanilla JS |

## Hogyan működik

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

Az AppAgent egy beépített ügynökciklussal rendelkező Chrome-bővítmény. Ön leírja, mit szeretne → Az ügynök megkérdezi a modellt → Eszközöket futtat a böngészőben → Az Ön aktuális felhasználói jogosultságaival fér hozzá a ServiceNow-hoz. Az ügynök közvetlenül a modell API-szolgáltatóival kommunikál, akár helyszíni, akár online szolgáltatásról van szó.

## Az AppAgent összehasonlítása

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Célfelhasználó** | Nem műszaki felhasználók | Fejlesztők | Fejlesztők | Nem műszaki alapítók |
| **ServiceNow-hoz készült** | ✓ | ✗ | ✗ | ✗ |
| **Ügynöki ServiceNow-műveletek** | ✓ | ✓ | ✗ | ✗ |
| **Fejlesztői környezet szükséges** | ✗ | ✓ | ✓ | ✗ |
| **Alkalmazásokat készít** | ✓ | ✓ | ✓ | ✓ |
| **Böngészővezérlés teszteléshez** | ✓ | ✗ | ✗ | ✗ |
| **Képernyőképeket készít** | ✓ | ✗ | ✗ | ✗ |
| **Háttérfeladatok** | ✓ (Készségműveletekkel) | ✗ | ✓ | ✗ |
| **Párhuzamos ügynökök** | ✓ (Alügynökök) | ✗ | ✓ | ✗ |
| **Mechanikus visszavonás** | ✓ | ✗ | ✗ | ✗ |
| **Képek és PDF-ek** | ✓ | ✓ | ✓ | Korlátozott |
| **Intelligens irányítópultok** | ✓ | ✗ | ✗ | ✓ |
| **Bővíthető készségek** | ✓ | ✓ | ✗ | ✗ |
| **Készségműveletek (egykattintásos gombok)** | ✓ | ✗ | ✗ | ✗ |
| **Élő folyamatjelzők** | ✓ | ✗ | ✗ | ✗ |
| **Több példány támogatása** | ✓ | ✗ | ✗ | ✗ |
| **Csevegésenkénti munkaterületek** | ✓ | ✗ | ✗ | ✗ |
| **Integrált git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Feltöltés a GitHubra a csevegésből** | ✓ | ✓ (CLI) | Korlátozott | ✗ |
| **Intelligens dokumentumok** | ✓ | ✗ | ✗ | ✗ |
| **Szüneteltetés / megszakítás válasz közben** | ✓ | ✓ | Korlátozott | ✗ |
| **Webes keresés** | ✓ | ✓ | ✓ | ✗ |
| **Eszközengedélyek** | ✓ | ✓ | Korlátozott | ✗ |
| **Módosítások exportálása** | ✓ XML | ✓ | ✓ | ✓ |
| **Saját modell használata** | ✓ | ✗ | ✓ | ✗ |
| **Promptgyorsítótárazás** | ✓ | ✓ | ✓ | ✗ |
| **Intelligens kontextus** | ✓ | ✓ | ✓ | ✗ |
| **Nulla függőség** | ✓ | ✗ | ✗ | ✓ |

*A Base44 nem tud ServiceNow-alkalmazásokat készíteni, de azok kedvéért szerepel a listában, akik ismerik a felhasználói élményét.*

## Beállítás

1. **Telepítés** — Telepítse az AppAgent bővítményt a Chrome Internetes áruházból (vagy fejlesztéshez töltse be kicsomagolva)
2. **API-kulcs beszerzése** — Regisztráljon az [OpenRouter](https://openrouter.ai) oldalon, használja közvetlenül az Anthropicot/OpenAI-t, vagy csatlakoztassa Claude Code-előfizetését (Enterprise vagy Personal)
3. **Konfigurálás** — Nyissa meg a bővítményt, és adja meg az API-kulcsát (vagy jelentkezzen be Claude-dal) a Beállítások → API-szolgáltatók részben
4. **Kezdje el az építést** — Nyissa meg a ServiceNow-példányát egy lapon (a rendszer automatikusan felismeri), és kezdjen el csevegni

## Példák

### „Készíts egy egyszerű alkalmazást a csapat feladatainak nyomon követésére”
Az AppAgent létrehozza a táblát, hozzáadja a mezőket, elkészíti az űrlap- és listaelrendezést, és beállít egy modult a navigátorban. Egyetlen prompt, teljes alkalmazás.

### „Végezz teljes auditot ezen a példányon”
Az AppAgent megvizsgálja a biztonsági réseket, az inaktív rendszergazdai fiókokat, az elavult rekordokat és a konfigurációs bevált gyakorlatokat, majd ajánlásokat tartalmazó jelentést ad.

### „Teszteld ezt az oldalt, és jelentsd a talált hibákat”
Az AppAgent megnyitja az oldalt egy böngészőlapon, kitölti az űrlapokat, gombokra kattint, képernyőképeket készít, és jelentést állít össze mindarról, amit talál.

### „Hiba van ebben az űrlapban, ki tudod javítani?”
Az AppAgent megnyitja az űrlapot, megvizsgálja a mögötte lévő szkripteket, azonosítja a hibát, kijavítja a kódot, és pontosan megmutatja, mi változott. Szükség esetén egy kattintással visszavonható.

### „Készíts egy irányítópult-widgetet a nyitott jegyeimhez”
Az AppAgent létrehoz egy élő widgetet, amely valós idejű adatokat kér le a példányáról, és megjeleníti azokat az irányítópultján.

### „Importáld ezt az Excel-fájlt a felhasználói táblába”
Az AppAgent beolvassa a fájlt, az oszlopokat mezőkhöz rendeli, és importálja az adatokat a példányára.

### „Nézd át a frissítési előzményeket, és javítsd ki a testreszabási problémákat”
Az AppAgent áttekinti, mi változott a frissítés során, megkeresi a hibás testreszabásokat, és kijavítja őket.

### „Értesítsd a csapatot, amikor P1-es incidens jön létre”
Az AppAgent létrehoz egy értesítési szabályt, amely P1-es incidenseknél aktiválódik, és riasztást küld a csapatának.

---

## A jövőkép

Jelenleg az Opus 4.7 kiváló, de még mindig igényel némi felügyeletet.

Minden generációnál tovább feszegetjük az AI-modellek képességeinek határait, és egyre feljebb lépünk az absztrakciós szinteken, amíg el nem akadunk.

GPT-4 => Kódkiegészítés
GPT-4o => Egy önálló fájlt ír meg
Sonnet 3.5 => Egy fájlt szerkeszt egy kódbázisban
Opus 4.5 => Egy teljes funkciót ír meg
Opus 4.6 => Egy alkalmazást teljes egészében karbantart
Opus 4.7 => ... (még teszteljük)

---

## Ütemterv

- RAG
- Specifikációk és tesztesetek

Nem meghatározott sorrendben.

Ez a verzió elsősorban visszajelzések gyűjtésére szolgál.

A következő verziók lehet, hogy nem lesznek nyílt forráskódúak, de ezt a verziót addig is karbantartjuk, amíg stabil nem lesz.

---

## Közreműködési irányelvek

Kérjük, ne nyisson PR-eket: ez egy kereskedelmi projekt, és a kódot csak az átláthatóság és a bizalom érdekében tesszük nyílt forráskódúvá.

Ha hibát talál, nyisson egy issue-t, vagy lépjen velünk közvetlenül kapcsolatba. Csak kereskedelmi támogatást nyújtunk, ezért csak azokat a hibákat javítjuk, amelyek más felhasználókat is érinthetnek.

---

## Licenc

Magáncélú és kereskedelmi felhasználás. Belső módosítás engedélyezett. A terjesztés és a továbbértékesítés tilos.
