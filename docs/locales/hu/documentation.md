# Első lépések {#getting-started}

Az AppAgent egy ServiceNow-hoz készült AI-ügynök, amely Chrome-bővítményként fut. Írja le egyszerű szavakkal, mire van szüksége, és az ügynök lekérdezi az adatokat, szerkeszti a rekordokat, alkalmazásokat és widgeteket készít, teszteli az oldalakat a böngészőjében, majd beszámol az eredményről.

:::tip
**Gyors kezdés:** Állítson be egy modellt, nyisson meg egy lapot a ServiceNow-példányán, majd írja be a kérését a csevegésbe, és nyomja meg az <kbd>Enter</kbd> billentyűt.
:::

## Modell beállítása {#guide-setup}

1. Nyissa meg a [Beállításokat](app:openSettingsPageView), és lépjen az **API-szolgáltatók** részre
2. Adjon hozzá egy szolgáltatót (Anthropic, OpenRouter vagy egyéni, OpenAI-kompatibilis API) az API-kulcsával — vagy kapcsolja be az **OAuth** lehetőséget egy Anthropic-szolgáltatónál, hogy a Claude-fiókjával jelentkezzen be
3. Válassza ki a használni kívánt modellt az **Ügynökmodell** alatt

Az API-kulcsát kizárólag a böngészője tárolja. Az AI-hívások közvetlenül a böngészőjéből jutnak el a szolgáltatóhoz.

## Példányok csatlakoztatása {#guide-instances}

Az AppAgent **automatikusan felismer minden ServiceNow-példányt**, amely ugyanabban a Chrome-profilban meg van nyitva — nincs szükség kapcsolati karakterlánc megadására. Jelentkezzen be egy példányra egy normál lapon, és az ügynök a felhasználója szerepköreivel és hozzáférési jogaival dolgozhat rajta. Kérje azt, hogy *„list instances”*, és láthatja az összes felismert példányt, a szerepköreit és a kapcsolat állapotát.

Minden példánynak van egy **engedélyszintje**, amelyet a példány legördülő menüjében választhat ki:

- **Kézi** — Ön hagy jóvá minden írási műveletet (létrehozás, frissítés, törlés, űrlapkitöltés)
- **Automatikus** — Az ügynök kérdezés nélkül dönt az írási műveletekről
- **Fejlesztői** — Semmilyen jóváhagyás: ezen a példányon minden eszközhívás kérdezés nélkül lefut. Csak fejlesztői példányokon használja

Az olvasás mindig engedélyezett. A finomabb szabályozásról az [Eszközengedélyek](#feature-permissions) részben olvashat.

## Csevegés indítása {#guide-chat}

1. Kattintson az oldalsáv **Új csevegés** gombjára [Új csevegés indítása →](app:startNewChat)
2. Írja be a kérését, például: *„Mutasd a ma létrehozott összes incidenst”*
3. A küldéshez nyomja meg az <kbd>Enter</kbd> billentyűt
4. Kövesse az ügynök munkáját: minden eszközhívás megjelenik a csevegésben, és ha egy lépéshez az Ön jóváhagyása kell, jóváhagyási kérés jelenik meg

Az ügynök munkája közben is írhat: egy új üzenet elküldése megszakítja az aktuális lépést, a **Szüneteltetés** pedig leállítja a futtatást.

## Képek és fájlok csatolása {#guide-images}

1. Kattintson a beviteli mezőnél a **Fájl csatolása** gombra kép, PDF, CSV vagy szöveges fájl hozzáadásához
2. Vagy illesszen be egy képet a vágólapról, illetve húzza rá a csevegésre
3. Írja be a csatolmánnyal kapcsolatos kérdését

:::tip
Csatoljon hibáról készült képernyőképeket, felhasználóifelület-terveket vagy exportált adatokat, hogy az ügynök pontosan azt lássa, amit Ön.
:::

# Fő funkciók {#features}

## Csevegés {#page-chat}

A fő beszélgetési nézet. [Új csevegés indítása →](app:startNewChat)

- **Üzenetterület** — A beszélgetés, az eszközhívásokkal és azok eredményeivel együtt
- **Beviteli mező** — Üzenetek írása, fájlok csatolása; ha az ügynök munkája közben küld üzenetet, azzal megszakítja
- **Szüneteltetés / Folytatás / Újrapróbálás** — Az ügynök leállítása, folytatása vagy az utolsó lépés újrapróbálása
- **Kontextusjelző** — Megmutatja, mennyire telt meg a beszélgetés; kattintson rá, hogy összefoglalja egy új csevegésbe
- **Válaszkártyák** — Egy válasz alatt megjelenhet egy **Röviden** összefoglaló és egy **Hivatkozások** kártya (rekordok, PR-ek, dokumentumok)
- **Csevegés fejléce** — A csevegés átnevezése vagy kitűzése, illetve az AppAgent megnyitása egy teljes böngészőlapon a **Kibontás teljes oldalra** lehetőséggel

## Böngészővezérlés {#feature-browser}

Az ügynök böngészőlapokat nyithat meg és vezérelhet a példányán, hogy lássa és tesztelje az oldalakat:

- **Navigálás, kattintás, kitöltés és kiválasztás** — Valósághű események, így az űrlapok és az automatikus kiegészítésű mezők úgy viselkednek, mintha Ön gépelne
- **Várakozás** — Várakozás egy elemre, szövegre vagy URL-re a késleltetések találgatása helyett
- **Képernyőképek** — Az oldal, egy widget vagy egyetlen elem rögzítése vizuális ellenőrzéshez
- **Vizsgálat** — Elemtulajdonságok, stílusok, konzolhibák és hálózati kérések kiolvasása
- **Megszemélyesítés** — Tesztelés egy másik felhasználóként, majd visszaváltás

## Rekordok szerkesztése és verzióelőzmények {#feature-history}

Az ügynök által a példányon végzett minden módosítás nyomon követhető a csevegés oldalsávjában:

- **Visszavonás** — Egy adott módosítás visszaállítása
- **Újraalkalmazás** — Egy visszavont módosítás helyreállítása
- **XML letöltése** — Az összes módosítás exportálása, például egy másik példányra való áthelyezéshez

## Alügynökök {#feature-subagents}

Nagyobb vagy párhuzamos munkához az ügynök **alügynököket** indíthat: ezek háttérben futó feldolgozók, amelyek saját csevegésben és kontextusban dolgoznak, majd rövid eredményt jelentenek vissza a fő csevegésnek.

- **Modellszintek** — Minden alügynök **kicsi**, **közepes** vagy **nagy** szinten fut, vagy **azonos** szinten, hogy a szülő modelljét használja. A szinteket a [Beállítások](app:openSettingsPageView) → **Alügynök-modellszintek** részben rendelheti modellekhez
- **Feldolgozók sávja** — A futó alügynökök élő címkékként jelennek meg a csevegés beviteli mezője felett; nyisson meg egyet, hogy kövesse az előrehaladását vagy elolvassa az átiratát
- **Készlet** — Az egyidejűleg futó alügynökök száma korlátozott; a többi sorban várakozik

## Irányítópult és widgetek {#page-dashboard}

Az ügynök által készített interaktív widgetek irányítópultja. [Irányítópult megnyitása →](app:openDashboardView)

1. Kattintson a **Widget hozzáadása** gombra
2. Írja le, mit szeretne, például: *„Egy diagram a nyitott incidensekről prioritás szerint”*
3. Az ügynök elkészíti a widgetet; bármikor kérhet módosításokat, vagy kattinthat az **Újragenerálás** gombra

A widgetek élő adatokat kérhetnek le a példányáról, így mindig naprakészek maradnak. Áthúzhatja, átméretezheti, importálhatja és exportálhatja őket (lásd: [Speciális](#advanced)). Az ügynök által a csevegésben megjelenített widgeteket a **Kitűzés az irányítópultra** gombbal mentheti.

## Intelligens dokumentumok {#page-documents}

Az **Intelligens dokumentumok** tartós, verziókezelt Markdown-dokumentumok, amelyeket az ügynök ír és frissít — tervek, jelentések, specifikációk, eredmények. A csevegésben jelennek meg, minden verziójukat megőrzik, és Ön közvetlenül is szerkesztheti őket. Az oldalsáv **Dokumentumok** pontjából nyithatja meg őket. [Dokumentumok megnyitása →](app:openDocumentsView)

## Készségek {#page-skills}

A készségek további tudással és eszközökkel látják el az ügynököt. [Készségek megnyitása →](app:openSkillsView)

- **Aktiválás / Inaktiválás** — Készségek be- és kikapcsolása; inaktiválja azokat, amelyekre nincs szüksége, hogy a válaszok célzottak maradjanak
- **Új készség** — Írjon saját készséget Markdownban, vagy használja a **Szerkesztés az ügynökkel** lehetőséget
- **Importálás / Exportálás** — Készségek megosztása mappákként
- **Készségműveletek** — Egyes készségek egykattintásos gombokat adnak a kezdőlaphoz, amelyek egy előre beállított munkafolyamatot indítanak

Egy készség **tudást** (utasításokat, bevált gyakorlatokat) és **egyéni eszközöket** (elszigetelt sandboxban futó JavaScript-függvényeket) biztosíthat.

## Munkaterület és GitHub {#feature-workspace}

Minden csevegéshez tartozik egy **munkaterület** — egy fájlterület, ahol az ügynök fájlokat olvashat, írhat, szerkeszthet és összehasonlíthat.

- **GitHub** — Csatlakoztasson egy GitHub-fiókot a [Beállításokban](app:openSettingsPageView), hogy tárolókat klónozhasson egy munkaterületre. Az ügynök a csevegésből ágakat hozhat létre, commitokat küldhet fel, és pull requesteket nyithat
- **Pull requestek** — A csevegésből nyitott PR-ek a csevegés oldalsávjában jelennek meg egy **Egyesítés** gombbal
- **Védelem a csevegések között** — Minden fájl megjegyzi, melyik csevegés módosította, így két párhuzamosan dolgozó csevegés nem írja felül észrevétlenül egymás munkáját
- **Automatikus szinkronizálás** — A klónozott munkaterületek szinkronizálódnak a GitHubbal, amikor navigál, csevegést vált vagy visszatér a lapra

## Csevegés oldalsávja {#feature-sidebar}

A jobb oldali oldalsáv mindent összegyűjt, amit az aktuális csevegés létrehozott:

- **Pull requestek** — Cím, célág és egy **Egyesítés** gomb
- **Munkaterület fájljai** — Nyisson meg egy fájlt a megtekintéséhez, a különbségek megjelenítéséhez vagy a korábbi verziók böngészéséhez
- **Verzióelőzmények** — A példányon végzett módosítások a **Visszavonás**, **Újraalkalmazás** és **XML letöltése** lehetőségekkel
- **Feldolgozók** — Futó és befejezett alügynökök, az eszközhívások, a szerkesztett fájlok és a megnyitott PR-ek számlálóival

## Műveletek és élő előrehaladás {#feature-actions}

A hosszú feladatok élőben mutatják az előrehaladást, ahelyett hogy elnémulnának:

- **Folyamatkártya** — Egyetlen kártya színes állapotjelzéssel (fut, elakadt, kész, hiba) és a lépések listájával
- **Műveletgombok** — Egykattintásos gombok, amelyek további munkafolyamatokat indítanak
- **Futásjelző** — A csevegéslista megjelöli azokat a csevegéseket, amelyekben az ügynök éppen dolgozik
- **„Az ügynök végzett” értesítés** — Ha futtatás közben lapot vagy ablakot vált, egy asztali értesítés jelzi, amikor az ügynök végzett

## Aktív csevegések és feladatok {#feature-jobs}

A fejlécben lévő feladatjelző élő nézetet nyit a csevegéseiről és a háttérben futó munkákról:

- **Aktív csevegések** — A futó csevegések és az olvasatlan eredményekkel rendelkezők (**félkövéren** kiemelve), mindegyik egy kontextushasználati gyűrűvel
- **Alügynökök** — A szülő csevegésük alatt jelennek meg; nyisson meg egyet az átiratának elolvasásához
- **Kibontás** — A lista megnyitása nagyobb panelként, oszlopos vagy szakaszos elrendezésben

## Eszközengedélyek {#feature-permissions}

A példányonkénti engedélyszint (**Kézi**, **Automatikus**, **Fejlesztői**) mellett minden eszköznek saját beállítása van a [Beállítások](app:openSettingsPageView) → **Eszközengedélyek** részben:

- **Engedélyezés** — Az eszköz mindig kérdezés nélkül fut
- **Automatikus** — Az eszköz kérdezés nélkül fut, kivéve, ha az ügynök egy hívást megerősítést igénylőként jelöl meg
- **Kérdezés** — Minden hívás előtt jóváhagyási kérést kap
- **Ki** — Az ügynök nem használhatja az eszközt

Egyes eszközök finomabb beállításokkal is rendelkeznek: a ServiceNow API HTTP-metódusonként (GET, POST, PUT, PATCH, DELETE), a böngészővezérlés műveletenként (navigálás, kattintás, kitöltés, megszemélyesítés…), a készségkezelés pedig szintén műveletenként szabályozható. A megerősítő párbeszédpanelek színe a kockázatot jelzi: **kék** (rutin), **narancs** (óvatosság), **piros** (romboló).

:::tip
A DELETE és más romboló műveleteket hagyja **Kérdezés** beállításon, a **Fejlesztői** szintet pedig csak fejlesztői példányokon használja.
:::

## Az ügynök eszközei {#feature-tools}

Az ügynök által használt fő eszközök:

| Eszköz | Mire szolgál |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Rekordok olvasása, létrehozása, frissítése és törlése |
| **Háttérszkript** (`servicenow_run_script`) | Kiszolgálóoldali szkript futtatása a példányon (admin szerepkör szükséges) |
| **Szkriptszerkesztés** (`servicenow_diff_edit`) | Szkriptek módosítása pontos keresés-és-csere szerkesztésekkel |
| **Böngészővezérlés** (`iframe_tool`) | Navigálás, kattintás, kitöltés, vizsgálat és megszemélyesítés böngészőlapokon |
| **Böngészőkód** (`js_eval`) | JavaScript futtatása elszigetelt sandboxban, amely más eszközöket is meghívhat |
| **Képernyőképek** (`take_screenshot`) | Az oldal, egy widget vagy egy elem rögzítése |
| **Widgetek és kártyák** (`html_widget`, `display`) | Interaktív widgetek, táblázatok, kártyák és idővonalak megjelenítése a csevegésben |
| **Intelligens dokumentumok** (`document`) | Tartós Markdown-dokumentumok létrehozása és frissítése |
| **Felhasználói kérdés** (`prompt_user`) | Adatok bekérése Öntől egy beágyazott űrlappal |
| **Alügynökök** (`spawn_sub_agent`) | Munka átadása háttérben futó feldolgozóknak |
| **Munkaterület** (`workspace`) | Munka fájlokkal és GitHub-tárolókkal |
| **Webes lekérés** (`web_fetch`) | Oldalak olvasása a nyilvános webről |
| **Készségek** (`get_skill`, `manage_skill`) | Készségek olvasása és kezelése |

Nyissa meg a [Beállítások](app:openSettingsPageView) → **Eszközengedélyek** részt, hogy lássa az összes eszközt, a forrásukat és az engedélyüket.

## Nagy tartalmak gyorsítótárazása {#feature-caching}

Ha egy eszköz eredménye túl nagy a beszélgetéshez (alapértelmezés szerint 4K tokennél több), az AppAgent gyorsítótárba helyezi. Az ügynök egy vázlatot kap, majd csak a szükséges részeket olvassa, keresi vagy böngészi. Így a csevegések gyorsak és célzottak maradnak. A küszöbértéket (1K–100K token) a [Beállítások](app:openSettingsPageView) → **Nagy tartalmak gyorsítótárazása** részben módosíthatja.

## Kontextusjelző {#feature-saturation}

A csevegés beviteli mezője melletti **kontextusjelző** megmutatja, mennyire telt meg a beszélgetés. 50% felett az ügynök azt a kérést kapja, hogy fejezze be a munkát, és a fennmaradó nagyobb feladatokat adja át alügynököknek; 100%-nál leáll és beszámol. A jelzőre kattintva bármikor összefoglalhatja a beszélgetést egy új csevegésbe.

## Használat és sebességkorlátok {#feature-usage}

- **Használatjelző** — A fejléc mutatja az API-használatát és a fennmaradó kereteket; kattintson rá a részletekért
- **Automatikus újrapróbálás** — Ha a szolgáltató sebességkorlátot alkalmaz vagy túlterhelt (HTTP 429 / 529), az AppAgent vár, automatikusan újrapróbálkozik, és visszaszámlálót jelenít meg a csevegésben
- **Elfogyott a kredit** — Ha egy 429-es hiba valójában azt jelenti, hogy elfogytak a kreditjei, a csevegés ezt egyértelműen jelzi

## Nyelvek {#feature-languages}

A felület angolul és további 24 nyelven érhető el: arab, cseh, dán, finn, francia (Franciaország, Kanada), héber, holland, japán, kínai (egyszerűsített, hagyományos), koreai, lengyel, magyar, német, norvég, olasz, orosz, portugál (Brazília, Portugália), spanyol, svéd, thai és török.

Válasszon egyet a [Beállítások](app:openSettingsPageView) → **Nyelv** részben, vagy a fejléc gyorsbeállítások menüjében. Az **Automatikus** a böngésző nyelvét követi, ha pedig az nem érhető el, angolra vált. A módosítás azonnal, újratöltés nélkül érvénybe lép.

- **Jobbról balra** — Az arab és a héber jobbról balra haladó elrendezést használ
- **Helyi formátumok** — A dátumok, időpontok és számok az Ön nyelvét követik
- **Az ügynök válaszai** — Az ügynök a kiválasztott nyelven válaszol, hacsak Ön nem más nyelven ír. A kód, valamint a táblák és mezők nevei változatlanok maradnak
- **Ez a súgóoldal** — Az Ön nyelvén jelenik meg; a változásnapló angol marad

# Oldalak és beállítások {#pages}

## Beállítások {#page-settings}

[Beállítások megnyitása →](app:openSettingsPageView)

- **Ügynökmodell** — Az ügynök által használt modell
- **API-szolgáltatók** — Anthropic, OpenRouter vagy egyéni szolgáltatók, API-kulccsal vagy OAuth-tal
- **LLM-végpontok** — Elnevezett `URL + API key` párok bármely OpenAI-kompatibilis API-hoz
- **Alügynök-modellszintek** — A kicsi, közepes és nagy szint modellekhez rendelése, vagy **Ugyanaz**
- **Érvelési erőfeszítés, Max. tokenszám és Gondolkodási keret** — A válaszok mélységének és hosszának finomhangolása
- **Kontextusablak** — A kontextusjelző által használt kontextusméret
- **Megjelenítés** — API-statisztikák, kompakt mód, a kijelző ébren tartása
- **Nyelv** — A felület nyelve, vagy **Automatikus**
- **Hookok** — Automatikus csevegéscímek, „Az ügynök végzett” értesítések és egyéb automatizálás
- **Nagy tartalmak gyorsítótárazása** — Mikor kerülnek gyorsítótárba a nagy eredmények
- **Eszközengedélyek** — Mi fut automatikusan, mi kér előbb megerősítést, és mi van letiltva
- **GitHub** — GitHub-fiók csatlakoztatása és a klónozott tárolók kezelése
- **Rendszerprompt** — Az ügynök utasításainak testreszabása
- **Adatkezelés** — Az adatai exportálása, importálása vagy törlése

## Előzmények {#page-history}

Az összes beszélgetése. [Előzmények megnyitása →](app:openHistoryView)

- **Keresés** — Csevegések keresése cím, tartalom, használt eszközök vagy widgetek alapján
- **Kitűzés** — A fontos csevegések a lista tetején tartása
- **Exportálás** — Egy csevegés vagy a teljes előzmény letöltése
- **Statisztikák** — A csevegések, a kitűzött csevegések száma és a teljes költség

## Súgó {#page-docs}

Ez az oldal. [Súgó megnyitása →](app:openDocsView)

- **Keresés** — A súgótémák szűrése az eszköztár keresőmezőjével
- **Tartalom** — Ugrás egy szakaszra a vázlatból
- **Letöltés** — A dokumentáció mentése Markdown-fájlként

# Tippek és billentyűparancsok {#tips}

| Művelet | Hogyan |
|--------|-----|
| Üzenet küldése | <kbd>Enter</kbd> |
| Új sor | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Keresés a csevegésekben | <kbd>Ctrl</kbd> + <kbd>K</kbd> (Macen <kbd>⌘</kbd> + <kbd>K</kbd>) |
| Párbeszédpanel vagy menü bezárása | <kbd>Esc</kbd> |
| Vissza | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Kép csatolása | Illessze be, vagy húzza rá a csevegésre |
| Újrakezdés összefoglalóval | Kattintson a kontextusjelzőre |
| Az ügynök megszakítása | Küldjön új üzenetet, vagy kattintson a **Szüneteltetés** gombra |

:::tip
**Legyen konkrét.** Ahelyett, hogy *„javítsd ki”*, írja azt, hogy *„javítsd ki a null hivatkozási hibát a MyUtils script include 42. sorában”*. Ha lehet, nevezze meg a táblát, a rekordot vagy az oldalt.
:::

- **Csevegésenként egy cél** — Egy nem kapcsolódó feladathoz indítson új csevegést; így az ügynök gyorsabb és pontosabb marad
- **Hagyja tesztelni** — Kérje meg az ügynököt, hogy nyissa meg az oldalt, és egy képernyőképpel ellenőrizze a saját módosítását
- **Használjon készségeket** — Kezdés előtt aktiváljon egy, a feladatához illő készséget (például teszteléshez vagy auditáláshoz)

# Hibaelhárítás és GYIK {#faq}

### Az ügynök nem látja a példányomat

Nyissa meg a példányt ugyanannak a Chrome-profilnak egy lapján, győződjön meg róla, hogy be van jelentkezve, majd kérje azt, hogy *„list instances”*. Ha még mindig nem jelenik meg, töltse újra a példány lapját.

### API- vagy hitelesítési hibát kapok

Ellenőrizze a szolgáltatóját a [Beállítások](app:openSettingsPageView) → **API-szolgáltatók** részben: az API-kulcsot, a kiválasztott végpontot és a modell nevét. OAuth esetén jelentkezzen be újra a claude.ai oldalra ugyanabban a Chrome-profilban.

### Az ügynök szerint sebességkorlátba ütközött

Az AppAgent automatikusan újrapróbálkozik, és visszaszámlálót jelenít meg. Ha ez továbbra is előfordul, nézze meg a használatjelzőn a fennmaradó krediteket, vagy használjon kisebb modellszintet az alügynökökhöz.

### Túl sok vagy túl kevés jóváhagyási kérés

Módosítsa a példány engedélyszintjét (**Kézi**, **Automatikus**, **Fejlesztői**) a példány legördülő menüjében, és állítsa be az egyes eszközöket a [Beállítások](app:openSettingsPageView) → **Eszközengedélyek** részben.

### A válaszok lassabbak vagy pontatlanabbak egy hosszú csevegésben

A beszélgetés kezdi megtölteni a kontextusát. Kattintson a kontextusjelzőre, hogy egy összefoglalóval új csevegésben folytassa.

### Hogyan vonhatok vissza egy módosítást?

Nyissa meg a csevegés oldalsávját, és a verzióelőzményekben kattintson a módosításnál a **Visszavonás** gombra. Az **XML letöltése** az összes módosítást exportálja.

### Hol tárolódnak az adataim?

Helyben, a böngészőjében (IndexedDB). A csevegések soha nem kerülnek AppAgent-kiszolgálóra — csak az AI-szolgáltatójához és a ServiceNow-példányához. Lásd: [Adattárolás](#adv-data-storage).

### A felület vagy ez az oldal rossz nyelven jelenik meg

Válassza ki a nyelvet a [Beállítások](app:openSettingsPageView) → **Nyelv** részben. Az **Automatikus** a böngésző nyelvét követi.

# Speciális {#advanced}

Ez a szakasz a speciális funkciókat, a fejléc gombjait, az importálási/exportálási formátumokat, valamint az AppAgent működésének technikai részleteit ismerteti.

## Az irányítópult fejlécének gombjai {#adv-dashboard-header}

Az irányítópult fejlécében több műveletgomb található:

| Gomb | Leírás |
|--------|-------------|
| **Oldalsáv be/ki** | A bal oldali navigációs oldalsáv megjelenítése vagy elrejtése |
| **Megnyitás önállóan** | Az irányítópult megnyitása egy új böngészőlapon, önálló megtekintéshez |
| **Fejlécek** | A widgetfejlécek láthatóságának be- és kikapcsolása az irányítópulton. Elrejtésükkor a widgetek letisztultabb nézetben jelennek meg |
| **Összes újragenerálása** | Az irányítópult összes widgetének újragenerálása az ügynökkel. Hasznos az adatok frissítéséhez |
| **Importálás** | Irányítópult vagy widget importálása JSON-fájlból |
| **Exportálás** | A teljes irányítópult exportálása JSON-fájlba biztonsági mentéshez vagy megosztáshoz |
| **Widget hozzáadása** | Megnyitja a widgetszerkesztőt, hogy az ügynök segítségével új widgetet hozzon létre |

## A widgetfejléc gombjai {#adv-widget-headers}

**Irányítópult-widgetek fejlécei** (akkor láthatók, ha a Fejlécek kapcsoló be van kapcsolva):

| Gomb | Leírás |
|--------|-------------|
| **Fogantyú** | A widget ikonja fogantyúként szolgál a widgetek átrendezéséhez |
| **Újragenerálás** | Kérje meg az ügynököt, hogy generálja újra a widget tartalmát |
| **Előzmények** | A widget korábbi verzióinak megtekintése (ha vannak) |
| **Teljes képernyő** | A widget kibontása teljes képernyős nézetre |
| **Szerkesztés** | A widgetszerkesztő megnyitása a módosításhoz az ügynökkel csevegve |
| **Törlés** | A widget eltávolítása az irányítópultról (megerősítéssel) |

**Csevegéswidgetek fejlécei** (a csevegésben megjelenő widgetek):

| Gomb | Leírás |
|--------|-------------|
| **Kitűzés az irányítópultra** | A widget mentése az irányítópultra |
| **Kód szerkesztése** | A widget HTML/CSS/JS kódjának közvetlen megtekintése és szerkesztése |
| **Kibontás/összecsukás** | A widget tartalmának megjelenítése vagy elrejtése |

## Widgetek átméretezése és áthelyezése {#adv-resize-move}

**Widgetek átméretezése:**

- Minden widget jobb alsó sarkában van egy **átméretező fogantyú**
- Kattintson a fogantyúra, és húzza a widget átméretezéséhez
- A szélesség egy 12 oszlopos rácshoz igazodik (legalább 3 oszlop)
- A magasság 50 px-es egységekben mérhető (legalább 2 egység = 100 px)

**Widgetek áthelyezése:**

- Kapcsolja be a **Fejlécek** kapcsolót a widgetfejlécek megjelenítéséhez
- Az átrendezéshez kattintson a **widget ikonjára** (fogantyú), és húzza el
- Ejtse a widgetet egy másik widgetre a helyük felcseréléséhez
- A widgetek sorrendje automatikusan mentésre kerül

## Importálási/exportálási formátumok {#adv-import-export}

**Irányítópult exportálása** (`dashboard-YYYY-MM-DD.json`):

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

**Egyetlen widget exportálása:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Egyetlen csevegés exportálása** (`chat-title-YYYY-MM-DD.json`):

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

A csevegésexportok a teljes beszélgetési előzményt megőrzik, az összes felhasználói üzenettel és ügynökválasszal együtt. Az egyes csevegések exportálásához használja a csevegés legördülő menüjét (···), és válassza a **Letöltés** lehetőséget.

**Készségek exportálása** (mappaszerkezet):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Megjegyzés:** A készségek importálása/exportálása a File System Access API-t használja, és **csak Chrome vagy Edge** böngészőben működik.
:::

**Összes adat exportálása** (`appagent-backup-YYYY-MM-DD.json`):

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

A teljes biztonsági mentés tartalmazza az összes csevegési előzményt, a beállításokat, az eszközengedélyeket, az irányítópult widgetjeit és az API-szolgáltatók konfigurációit.

## API-statisztikák {#adv-api-stats}

Ha a Beállításokban engedélyezve van, az ügynök minden válasza után megjelennek az API-statisztikák:

| Mérőszám | Leírás |
|--------|-------------|
| **Be** | Bemeneti tokenek — az ügynöknek küldött prompt mérete |
| **Ki** | Kimeneti tokenek — az ügynök válaszának mérete |
| **Összesen** | Bemeneti + kimeneti tokenek együtt |
| **Gyorsítótár olvasás/írás** | A promptgyorsítótárból olvasott vagy oda írt tokenek (csökkenti a költséget) |
| **Érvelés** | Belső érvelésre használt tokenek (egyes modelleknél) |
| **Költség** | Az API-hívás becsült költsége USD-ben |
| **Időtartam** | Az API-hívás időtartama |

Többfordulós beszélgetéseknél az összesített statisztikák az összes hívás összegét mutatják.

:::tip
Az API-statisztikák megjelenítését a [Beállítások](app:openSettingsPageView) → Megjelenítés → API-statisztikák megjelenítése részben kapcsolhatja be vagy ki.
:::

## Készségek kézi szerkesztése {#adv-skills-manual}

A készségeket kézzel vagy az ügynök segítségével is létrehozhatja és szerkesztheti:

**Készség kézi létrehozása:**

1. Lépjen a [Készségek](app:openSkillsView) oldalra, és kattintson az **Új készség** gombra
2. Adja meg a készség nevét és leírását
3. Írja meg a készség tartalmát Markdown formátumban
4. A készség létrehozásához kattintson a **Mentés** gombra

**A SKILL.md formátuma:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Szerkesztés az ügynökkel:**

1. Kattintson bármelyik készségnél a **Szerkesztés az ügynökkel** gombra
2. Írja le, milyen módosításokat szeretne
3. Az ügynök módosítja a készség tartalmát
4. Tekintse át és mentse a módosításokat

**Készségeszközök:** A készségek további fájlokat (XML, JS, MD) is tartalmazhatnak, amelyek extra kontextust vagy kódot biztosítanak az ügynök számára.

## Rendszerprompt {#adv-system-prompt}

A rendszerprompt határozza meg az ügynök viselkedését és képességeit. A [Beállításokban](app:openSettingsPageView) testre szabhatja.

**A rendszerprompt szerkesztése:**

1. Lépjen a Beállítások → Rendszerprompt szakaszra
2. Kattintson a **Szerkesztés** gombra a szerkesztési módra váltáshoz
3. Módosítsa a sablont igény szerint
4. A módosítások alkalmazásához kattintson a **Mentés** gombra

**Elérhető helyőrzők:**

| Helyőrző | Leírás |
|-------------|-------------|
| `{{CURRENT_DATE}}` | A mai dátum (a hét napja, hónap, nap, év) |
| `{{ORCHESTRATOR_POLICY}}` | Az alügynökök delegálási szabályzata — a fő csevegésekben szerepel, az alügynök-csevegésekben üres marad |
| `{{DISABLED_TOOLS}}` | A letiltott eszközök listája |
| `{{TOOL_CATALOG}}` | A késleltetett betöltésű eszközök katalógusa (üres, ha a késleltetett eszközbetöltés ki van kapcsolva) |
| `{{SKILLS_SUMMARY}}` | Az aktív készségek tartalma |

A helyőrzők az AI-nak való küldéskor automatikusan a tényleges értékekre cserélődnek. A tokenszám-kijelző a sablon méretét és a kibontott méretet is mutatja.

:::tip
Ha szükséges, kattintson a **Visszaállítás alapértelmezettre** gombra az eredeti rendszerprompt visszaállításához.
:::

## Az ügynök API-hívásai {#adv-agent-api}

Az AppAgent **Chrome-bővítményként** fut:

- Az AI API-hívások **közvetlenül a böngészőjéből jutnak el az AI-szolgáltatóhoz** (pl. Anthropic, OpenRouter)
- **Nem** haladnak át a példányán vagy bármilyen AppAgent-kiszolgálón
- Az API-kulcsát (vagy OAuth-tokenjét) helyben, a böngészője tárolja
- A beszélgetési adatok feldolgozásra az AI-szolgáltatóhoz kerülnek

**Hogyan működik:**

1. Beír egy üzenetet a csevegésbe
2. Az AppAgent összeállít egy promptot a rendszerutasításokkal, az eszközökkel és a beszélgetési előzménnyel
3. A prompt az AI-szolgáltató API-jához kerül
4. Az ügynök válasza folyamatosan érkezik vissza a böngészőjébe
5. Az eszközhívások a böngészőjében futnak le, az API-hívásokhoz a példányon lévő munkamenetét használva

:::tip
**Adatvédelem:** Az API-kulcsát és a beszélgetési adatait az ügyféloldal kezeli. A példányával kommunikáló eszközhívások a meglévő munkamenetének hitelesítő adatait használják.
:::

## LLM-végpontok {#adv-endpoints}

A modellek **elnevezett LLM-végpontokon** keresztül kapcsolódnak — ezek újrafelhasználható `URL + API key` párok. Így az AppAgent **bármely OpenAI-kompatibilis chat-completions API-hoz** csatlakoztatható: OpenRouterhez, helyi átjáróhoz, proxyhoz vagy saját üzemeltetésű modellhez.

1. A [Beállítások → LLM-végpontok](app:openSettingsPageView) részben kattintson a **Végpont hozzáadása** gombra
2. Adjon meg egy nevet, az API URL-jét és egy API-kulcsot
3. Minden modell (API-szolgáltató) kiválaszt egy végpontot — ha egyszer frissít egy kulcsot, az összes azt használó modell frissül

:::tip
A Claude **OAuth**-szolgáltatók nem használnak végpontokat — közvetlenül az `api.anthropic.com` címmel kommunikálnak.
:::

## Bejelentkezés Claude-dal (OAuth) {#adv-oauth}

API-kulcs beillesztése helyett a meglévő claude.ai-munkamenetével is bejelentkezhet az Anthropic-szolgáltatókba:

1. A [Beállítások → API-szolgáltatók](app:openSettingsPageView) részben adjon hozzá vagy szerkesszen egy Anthropic-szolgáltatót, és kapcsolja be az **OAuth** lehetőséget
2. A bővítmény az ugyanabban a Chrome-profilban lévő claude.ai-bejelentkezését használja az Anthropichoz való közvetlen csatlakozáshoz
3. Nincs külön bejelentkezési ablak, és nincs közbeiktatott AppAgent-kiszolgáló

**Követelmények:**

- Ugyanabban a Chrome-profilban be kell jelentkeznie a `claude.ai` oldalra
- Egyszeri bejelentkezéses (SSO) fiókokkal is működik

:::tip
Az OAuth-tokenek automatikusan frissülnek. Ha a bejelentkezés sikertelen, nyissa meg a `claude.ai` oldalt ugyanabban a profilban, és jelentkezzen be újra.
:::

## Biztonsági szempontok {#adv-security}

**Az API-kulcs tárolása:**

- Az **API-kulcsát helyben tárolja** a böngésző IndexedDB-je
- A kulcs soha nem kerül el a példányához vagy az AI-szolgáltatón kívül bármely más kiszolgálóhoz
- A böngészési adatok törlése eltávolítja a tárolt API-kulcsát

**Munkamenet és engedélyek:**

- Az ügynök az Ön **aktuális felhasználói munkamenetével** fut, és örökli a hozzáférési jogait és szerepköreit
- A példányához intézett összes API-hívás az Ön munkamenetének hitelesítő adatait használja
- Az ügynök csak ahhoz fér hozzá, amihez az Ön felhasználói fiókja is

**Eszközvégrehajtási környezet:**

- A **Böngészőkód (js_eval)** **elszigetelt sandboxban** futtatja a JavaScriptet, kizárólag `executeTool()` hozzáféréssel
- A **widgetszkriptek** **elszigetelt iframe-ekben** futnak, az API-hívásokhoz kizárólag `executeTool()` hozzáféréssel
- A **készségeszközök** **elszigetelt sandboxokban** futnak, kizárólag `executeTool()` hozzáféréssel
- Minden API-hozzáférés az **engedélyrendszeren** keresztül történik, az `executeTool("servicenow_api", {...})` hívással
- Az ügynök a ServiceNow-példányán lévő **böngészőlapokon** kommunikál az oldalakkal

**Rekordmódosítási képességek:**

- A **ServiceNow API** eszköz támogatja a POST, PATCH, PUT és DELETE metódusokat, amelyek módosíthatják a rekordokat
- Az ügynök az **integrált böngészőn** keresztül is létrehozhat és szerkeszthet rekordokat, ha engedélyt kap a kitöltési és kattintási eszközökhöz
- Az [Eszközengedélyek](app:openSettingsPageView) beállításával szabályozhatja, mely műveletekhez szükséges jóváhagyás

**Önfejlesztés:**

- Az ügynök **kezelheti a saját készségeit** — létrehozhat, szerkeszthet és aktiválhat készségeket
- Így az ügynök idővel tanulhat és fejlesztheti önmagát
- Rendszeresen tekintse át a készségek módosításait, hogy megfelelnek-e az elvárásainak

## Adattárolás {#adv-data-storage}

Az AppAgent az adatokat helyben, a böngészőjében tárolja, **IndexedDB** használatával:

| Adattípus | Tárolás | Leírás |
|-----------|---------|-------------|
| **Csevegések** | IndexedDB | A teljes beszélgetési előzmény, az üzenetek és az eszközeredmények |
| **Beállítások** | IndexedDB | Eszközengedélyek, API-kulcsok, modellbeállítások |
| **Irányítópult-widgetek** | IndexedDB | A widgetek HTML-kódja, címe, mérete és beszélgetési előzménye |
| **Készségek** | IndexedDB | Készségdefiníciók, tartalom és eszközök |
| **API-szolgáltatók** | IndexedDB | Egyéni API-szolgáltatók konfigurációi és végpontjai |
| **Felhasználói felület állapota** | localStorage | Az oldalsáv állapota, az aktuális nézet, a görgetési pozíciók |

**Az adatai letöltése:**

1. Lépjen a [Beállítások](app:openSettingsPageView) → Adatkezelés részre
2. Kattintson az **Adatok exportálása** gombra
3. A rendszer letölt egy JSON-formátumú biztonsági mentési fájlt

**Az adatai törlése:**

1. Lépjen a [Beállítások](app:openSettingsPageView) → Adatkezelés részre
2. Kattintson az **Összes adat törlése** gombra
3. Erősítse meg kétszer, hogy mindent véglegesen töröljön

:::tip
**Fontos:** Az adatokat a bővítmény helyben tárolja. A böngészési adatok törlése, a bővítmény eltávolítása vagy egy másik böngészőprofil használata külön adattárakat eredményez.
:::

# Névjegy {#about}

**Verzió:** v__VERSION__

**Licenc:** Magáncélú és kereskedelmi felhasználás. Belső módosítás engedélyezett. A terjesztés és a továbbértékesítés tilos. Minden jog fenntartva.

## Változásnapló {#changelog}

__CHANGELOG__
