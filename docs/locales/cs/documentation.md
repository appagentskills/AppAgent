# Začínáme {#getting-started}

AppAgent je AI agent pro ServiceNow, který běží jako rozšíření Chrome. Popište běžnými slovy, co potřebujete, a agent se dotáže na data, upraví záznamy, vytvoří aplikace a widgety, otestuje stránky ve vašem prohlížeči a podá vám zprávu.

:::tip
**Rychlý start:** Nastavte model, otevřete kartu s vaší instancí ServiceNow, pak do chatu napište požadavek a stiskněte <kbd>Enter</kbd>.
:::

## Nastavení modelu {#guide-setup}

1. Otevřete [Nastavení](app:openSettingsPageView) a přejděte do části **Poskytovatelé API**
2. Přidejte poskytovatele (Anthropic, OpenRouter nebo vlastní API kompatibilní s OpenAI) se svým klíčem API — nebo u poskytovatele Anthropic zapněte **OAuth** a přihlaste se svým účtem Claude
3. V části **Model agenta** vyberte model, který se má používat

Váš klíč API je uložen pouze ve vašem prohlížeči. Volání AI jdou přímo z vašeho prohlížeče k poskytovateli.

## Připojení instancí {#guide-instances}

AppAgent **automaticky rozpozná každou instanci ServiceNow**, kterou máte otevřenou ve stejném profilu Chrome — není potřeba zadávat žádný připojovací řetězec. Přihlaste se k instanci v běžné kartě a agent na ní může pracovat s rolemi a přístupovými právy vašeho uživatele. Požádejte *„vypiš instance“* a uvidíte všechny rozpoznané instance, své role a stav připojení.

Každá instance má **úroveň oprávnění**, kterou zvolíte v rozbalovací nabídce instance:

- **Ručně** — Každou operaci zápisu (vytvoření, aktualizace, odstranění, vyplnění formuláře) schvalujete vy
- **Automaticky** — O operacích zápisu rozhoduje agent bez ptaní
- **Vývoj** — Žádná schvalování: každé volání nástroje na této instanci proběhne bez ptaní. Používejte jen na vývojových instancích

Čtení je vždy povoleno. Jemnější nastavení najdete v části [Oprávnění nástrojů](#feature-permissions).

## Zahájení chatu {#guide-chat}

1. Na postranním panelu klikněte na **Nový chat** [Začít nový chat →](app:startNewChat)
2. Napište svůj požadavek, například *„Ukaž mi všechny incidenty vytvořené dnes“*
3. Stisknutím <kbd>Enter</kbd> jej odešlete
4. Sledujte, jak agent pracuje: každé volání nástroje se zobrazí v chatu a když krok potřebuje váš souhlas, objeví se žádost o schválení

Během práce agenta můžete dál psát: odesláním nové zprávy přerušíte aktuální krok a tlačítkem **Pozastavit** běh zastavíte.

## Přikládání obrázků a souborů {#guide-images}

1. Tlačítkem **Přiložit soubor** v oblasti vstupu přidáte obrázek, PDF, CSV nebo textový soubor
2. Nebo obrázek vložte ze schránky či ho přetáhněte do chatu
3. Napište svůj dotaz k příloze

:::tip
Přiložte snímky obrazovky s chybami, návrhy UI nebo exportovaná data, aby agent viděl přesně to, co vidíte vy.
:::

# Klíčové funkce {#features}

## Chat {#page-chat}

Hlavní zobrazení konverzace. [Začít nový chat →](app:startNewChat)

- **Oblast zpráv** — Konverzace včetně volání nástrojů a jejich výsledků
- **Vstupní pole** — Pište zprávy, přikládejte soubory; odesláním zprávy během práce agenta ho přerušíte
- **Pozastavit / Pokračovat / Opakovat** — Zastavte agenta, nechte ho pokračovat nebo zopakujte poslední krok
- **Indikátor kontextu** — Ukazuje, jak je konverzace zaplněná; kliknutím ji shrnete do nového chatu
- **Karty odpovědí** — Pod odpovědí se může zobrazit shrnutí **Ve zkratce** a karta **Odkazy** (záznamy, PR, dokumenty)
- **Záhlaví chatu** — Přejmenujte nebo připněte chat, nebo otevřete AppAgent v plné kartě prohlížeče pomocí **Rozbalit na celou stránku**

## Ovládání prohlížeče {#feature-browser}

Agent může otevírat a ovládat karty prohlížeče s vaší instancí, aby stránky viděl a otestoval:

- **Navigace, kliknutí, vyplnění a výběr** — Realistické události, takže se formuláře a pole s automatickým doplňováním chovají, jako byste psali vy
- **Čekání na** — Čekání na prvek, text nebo URL místo odhadování prodlev
- **Snímky obrazovky** — Zachycení stránky, widgetu nebo jednotlivého prvku pro vizuální kontrolu
- **Prozkoumání** — Čtení vlastností prvků, stylů, chyb konzole a síťových požadavků
- **Zosobnění** — Testování jako jiný uživatel a poté návrat zpět

## Úpravy záznamů a historie verzí {#feature-history}

Každá změna, kterou agent na vaší instanci provede, se sleduje na postranním panelu chatu:

- **Zpět** — Vrácení jednotlivé změny
- **Znovu** — Obnovení vrácené změny
- **Stáhnout XML** — Export všech změn, například pro přenos na jinou instanci

## Subagenti {#feature-subagents}

Na náročnou nebo paralelní práci může agent spustit **subagenty**: pracovníky na pozadí, kteří běží ve vlastním chatu a kontextu a do hlavního chatu pak vrátí krátký výsledek.

- **Úrovně modelů** — Každý subagent běží na úrovni **small**, **medium** nebo **large**, případně **same**, kdy použije model nadřazeného chatu. Úrovně přiřadíte modelům v [Nastavení](app:openSettingsPageView) → **Úrovně modelů subagentů**
- **Pás pracovníků** — Běžící subagenti se zobrazují jako živé štítky nad vstupem chatu; otevřením jednoho sledujete jeho průběh nebo čtete jeho přepis
- **Fond** — Počet souběžných subagentů je omezen; další čekají ve frontě

## Nástěnka a widgety {#page-dashboard}

Nástěnka interaktivních widgetů vytvořených agentem. [Otevřít nástěnku →](app:openDashboardView)

1. Klikněte na **Přidat widget**
2. Popište, co chcete, například *„Graf otevřených incidentů podle priority“*
3. Agent widget vytvoří; kdykoli můžete požádat o změny nebo kliknout na **Vygenerovat znovu**

Widgety mohou načítat živá data z vaší instance, takže zůstávají aktuální. Můžete je přetahovat, měnit jejich velikost, importovat a exportovat (viz [Pokročilé](#advanced)). Widgety, které agent zobrazí přímo v chatu, lze uložit tlačítkem **Připnout na nástěnku**.

## Chytré dokumenty {#page-documents}

**Chytré dokumenty** jsou trvalé dokumenty v Markdownu s historií verzí, které agent píše a aktualizuje — plány, zprávy, specifikace, zjištění. Zobrazují se přímo v chatu, uchovávají každou verzi a můžete je sami přímo upravovat. Otevřete je z položky **Dokumenty** na postranním panelu. [Otevřít dokumenty →](app:openDocumentsView)

## Dovednosti {#page-skills}

Dovednosti dávají agentovi další znalosti a nástroje. [Otevřít dovednosti →](app:openSkillsView)

- **Aktivovat / Deaktivovat** — Zapínejte a vypínejte dovednosti; ty, které nepotřebujete, deaktivujte, aby odpovědi zůstaly cílené
- **Nová dovednost** — Napište vlastní dovednost v Markdownu, nebo použijte **Upravit pomocí agenta**
- **Importovat / Exportovat** — Sdílejte dovednosti jako složky
- **Akce dovedností** — Některé dovednosti přidávají na domovskou stránku tlačítka, která jedním kliknutím spustí přednastavený pracovní postup

Dovednost může poskytovat **znalosti** (pokyny, osvědčené postupy) a **vlastní nástroje** (funkce JavaScriptu, které běží v izolovaném sandboxu).

## Pracovní prostor a GitHub {#feature-workspace}

Každý chat má **pracovní prostor** — oblast souborů, ve které může agent soubory číst, zapisovat, upravovat a porovnávat.

- **GitHub** — Připojte účet GitHub v [Nastavení](app:openSettingsPageView) a klonujte repozitáře do pracovního prostoru. Agent může přímo z chatu vytvářet větve, odesílat commity a otevírat pull requesty
- **Pull requesty** — PR otevřené z chatu jsou uvedeny na postranním panelu chatu s tlačítkem **Sloučit**
- **Ochrana mezi chaty** — Každý soubor si pamatuje, který chat ho změnil, takže dva paralelně pracující chaty si navzájem tiše nepřepíšou práci
- **Automatická synchronizace** — Naklonované pracovní prostory se synchronizují s GitHubem, když přejdete jinam, přepnete chat nebo se vrátíte na kartu

## Postranní panel chatu {#feature-sidebar}

Pravý postranní panel shromažďuje vše, co aktuální chat vytvořil:

- **Pull requesty** — Název, cílová větev a tlačítko **Sloučit**
- **Soubory pracovního prostoru** — Otevřete soubor a zobrazte ho, jeho rozdíly nebo starší verze
- **Historie verzí** — Změny instance s tlačítky **Zpět**, **Znovu** a **Stáhnout XML**
- **Pracovníci** — Běžící a dokončení subagenti s počty volání nástrojů, upravených souborů a otevřených PR

## Akce a živý průběh {#feature-actions}

Dlouhé úlohy zobrazují živý průběh, místo aby mlčely:

- **Karta průběhu** — Jediná karta s barevným stavem (běží, zaseknuto, hotovo, chyba) a seznamem kroků
- **Tlačítka akcí** — Tlačítka, která jedním kliknutím spustí navazující pracovní postupy
- **Indikátor běhu** — Seznam chatů označuje chaty, ve kterých agent pracuje
- **Oznámení „Agent dokončil práci“** — Pokud během běhu přepnete kartu nebo okno, oznámení na ploše vám dá vědět, až agent skončí

## Aktivní chaty a úlohy {#feature-jobs}

Štítek úloh v záhlaví otevře živý přehled vašich chatů a práce na pozadí:

- **Aktivní chaty** — Běžící chaty a chaty s nepřečtenými výsledky (zobrazené **tučně**), každý s kroužkem využití kontextu
- **Subagenti** — Uvedeni pod svým nadřazeným chatem; otevřením jednoho si přečtete jeho přepis
- **Rozbalit** — Otevře seznam jako větší panel s rozložením do sloupců nebo oddílů

## Oprávnění nástrojů {#feature-permissions}

Kromě úrovně oprávnění pro jednotlivé instance (**Ručně**, **Automaticky**, **Vývoj**) má každý nástroj vlastní nastavení v [Nastavení](app:openSettingsPageView) → **Oprávnění nástrojů**:

- **Povolit** — Nástroj vždy běží bez ptaní
- **Automaticky** — Nástroj běží bez ptaní, pokud agent volání neoznačí jako vyžadující vaše potvrzení
- **Zeptat se** — Před každým voláním dostanete žádost o schválení
- **Vypnuto** — Agent nástroj nemůže používat

Některé nástroje mají jemnější nastavení: ServiceNow API podle metody HTTP (GET, POST, PUT, PATCH, DELETE), ovládání prohlížeče podle akce (navigace, kliknutí, vyplnění, zosobnění…) a správa dovedností podle akce. Potvrzovací dialogy jsou barevně odlišeny podle rizika: **modrá** (běžné), **oranžová** (opatrnost), **červená** (destruktivní).

:::tip
DELETE a další destruktivní operace nechte na **Zeptat se** a **Vývoj** používejte jen na vývojových instancích.
:::

## Nástroje agenta {#feature-tools}

Hlavní nástroje, které agent používá:

| Nástroj | Co dělá |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Čte, vytváří, aktualizuje a odstraňuje záznamy |
| **Skript na pozadí** (`servicenow_run_script`) | Spustí na instanci skript na straně serveru (vyžaduje roli admin) |
| **Úpravy skriptů** (`servicenow_diff_edit`) | Mění skripty přesnými úpravami typu hledat a nahradit |
| **Ovládání prohlížeče** (`iframe_tool`) | Naviguje, kliká, vyplňuje, zkoumá a zosobňuje v kartách prohlížeče |
| **Kód v prohlížeči** (`js_eval`) | Spouští JavaScript v izolovaném sandboxu, který může volat další nástroje |
| **Snímky obrazovky** (`take_screenshot`) | Zachytí stránku, widget nebo prvek |
| **Widgety a karty** (`html_widget`, `display`) | Zobrazují v chatu interaktivní widgety, tabulky, karty a časové osy |
| **Chytré dokumenty** (`document`) | Vytvářejí a aktualizují trvalé dokumenty v Markdownu |
| **Dotaz na uživatele** (`prompt_user`) | Požádá vás o vstup pomocí formuláře přímo v chatu |
| **Subagenti** (`spawn_sub_agent`) | Deleguje práci na pracovníky na pozadí |
| **Pracovní prostor** (`workspace`) | Práce se soubory a repozitáři GitHub |
| **Načtení webu** (`web_fetch`) | Čte stránky z veřejného webu |
| **Dovednosti** (`get_skill`, `manage_skill`) | Čte a spravuje dovednosti |

Otevřete [Nastavení](app:openSettingsPageView) → **Oprávnění nástrojů** a uvidíte každý nástroj, jeho zdroj a jeho oprávnění.

## Ukládání velkého obsahu do mezipaměti {#feature-caching}

Když je výsledek nástroje pro konverzaci příliš velký (ve výchozím nastavení více než 4K tokenů), AppAgent ho uloží do mezipaměti. Agent dostane osnovu a pak čte, prohledává nebo prochází jen ty části, které potřebuje. Chaty tak zůstávají rychlé a cílené. Práh (1K až 100K tokenů) změníte v [Nastavení](app:openSettingsPageView) → **Ukládání velkého obsahu do mezipaměti**.

## Indikátor kontextu {#feature-saturation}

**Indikátor kontextu** vedle vstupu chatu ukazuje, jak je konverzace zaplněná. Po překročení 50 % je agent požádán, aby práci dokončil a zbývající náročnou práci předal subagentům; při 100 % se zastaví a podá zprávu. Kliknutím na indikátor můžete konverzaci kdykoli shrnout do nového chatu.

## Využití a limity rychlosti {#feature-usage}

- **Štítek využití** — Záhlaví ukazuje využití API a zbývající limity; kliknutím zobrazíte podrobnosti
- **Automatické opakování** — Když je poskytovatel omezen limitem rychlosti nebo přetížen (HTTP 429 / 529), AppAgent počká, automaticky to zkusí znovu a v chatu zobrazí odpočet
- **Vyčerpaný kredit** — Když chyba 429 ve skutečnosti znamená, že vám došel kredit, chat to jasně sdělí

## Jazyky {#feature-languages}

Rozhraní je k dispozici v angličtině a 24 dalších jazycích: arabštině, čínštině (zjednodušené, tradiční), češtině, dánštině, nizozemštině, finštině, francouzštině (Francie, Kanada), němčině, hebrejštině, maďarštině, italštině, japonštině, korejštině, norštině, polštině, portugalštině (Brazílie, Portugalsko), ruštině, španělštině, švédštině, thajštině a turečtině.

Jazyk zvolíte v [Nastavení](app:openSettingsPageView) → **Jazyk** nebo v nabídce rychlého nastavení v záhlaví. Možnost **Automaticky** se řídí jazykem prohlížeče a jinak použije angličtinu. Změna se projeví okamžitě, bez znovunačtení.

- **Zprava doleva** — Arabština a hebrejština používají rozložení zprava doleva
- **Místní formáty** — Data, časy a čísla se řídí vaším jazykem
- **Odpovědi agenta** — Agent odpovídá ve zvoleném jazyce, pokud nepíšete v jiném. Kód a názvy tabulek a polí zůstávají beze změny
- **Tato stránka nápovědy** — Zobrazuje se ve vašem jazyce; přehled změn zůstává v angličtině

# Stránky a nastavení {#pages}

## Nastavení {#page-settings}

[Otevřít nastavení →](app:openSettingsPageView)

- **Model agenta** — Model, který agent používá
- **Poskytovatelé API** — Anthropic, OpenRouter nebo vlastní poskytovatelé s klíčem API nebo OAuth
- **Endpointy LLM** — Pojmenované dvojice `URL + API key` pro jakékoli API kompatibilní s OpenAI
- **Úrovně modelů subagentů** — Přiřazení úrovní small, medium a large k modelům, nebo **Stejný**
- **Úroveň uvažování, Max. tokenů a Rozpočet uvažování** — Nastavení hloubky a délky odpovědí
- **Kontextové okno** — Velikost kontextu, kterou používá indikátor kontextu
- **Zobrazení** — Statistiky API, kompaktní režim, nevypínat displej
- **Jazyk** — Jazyk rozhraní, nebo **Automaticky**
- **Háčky** — Automatické názvy chatů, oznámení „Agent dokončil práci“ a další automatizace
- **Ukládání velkého obsahu do mezipaměti** — Kdy se velké výsledky ukládají do mezipaměti
- **Oprávnění nástrojů** — Co běží automaticky, co se nejdřív ptá a co je vypnuté
- **GitHub** — Připojení účtu GitHub a správa naklonovaných repozitářů
- **Systémový prompt** — Přizpůsobení pokynů agenta
- **Správa dat** — Export, import nebo odstranění vašich dat

## Historie {#page-history}

Všechny vaše konverzace. [Otevřít historii →](app:openHistoryView)

- **Hledat** — Hledání chatů podle názvu, obsahu, použitých nástrojů nebo widgetů
- **Připnout** — Důležité chaty zůstanou nahoře
- **Exportovat** — Stažení jednoho chatu nebo celé historie
- **Statistiky** — Počet chatů, připnutých chatů a celková cena

## Nápověda {#page-docs}

Tato stránka. [Otevřít nápovědu →](app:openDocsView)

- **Hledat** — Filtrování témat nápovědy pomocí vyhledávacího pole na panelu nástrojů
- **Obsah** — Přechod na oddíl z osnovy
- **Stáhnout** — Uložení dokumentace jako souboru Markdown

# Tipy a klávesové zkratky {#tips}

| Akce | Jak |
|--------|-----|
| Odeslat zprávu | <kbd>Enter</kbd> |
| Nový řádek | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Hledat v chatech | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> na Macu) |
| Zavřít dialog nebo nabídku | <kbd>Esc</kbd> |
| Zpět | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Přiložit obrázek | Vložte ho, nebo ho přetáhněte do chatu |
| Začít znovu se shrnutím | Klikněte na indikátor kontextu |
| Přerušit agenta | Odešlete novou zprávu, nebo klikněte na **Pozastavit** |

:::tip
**Buďte konkrétní.** Místo *„oprav to“* napište *„oprav chybu null reference na řádku 42 v script include MyUtils“*. Pokud můžete, uveďte tabulku, záznam nebo stránku.
:::

- **Jeden cíl na chat** — Pro nesouvisející úlohu začněte nový chat; agent zůstane rychlejší a přesnější
- **Nechte ho testovat** — Požádejte agenta, aby otevřel stránku a svou změnu ověřil snímkem obrazovky
- **Používejte dovednosti** — Než začnete, aktivujte dovednost odpovídající vaší úloze (například testování nebo audit)

# Řešení potíží a časté dotazy {#faq}

### Agent nevidí moji instanci

Otevřete instanci v kartě stejného profilu Chrome, ujistěte se, že jste přihlášeni, a pak požádejte *„vypiš instance“*. Pokud se stále nezobrazuje, znovu načtěte kartu s instancí.

### Zobrazuje se mi chyba API nebo ověření

Zkontrolujte svého poskytovatele v [Nastavení](app:openSettingsPageView) → **Poskytovatelé API**: klíč API, zvolený endpoint a název modelu. U OAuth se znovu přihlaste na claude.ai ve stejném profilu Chrome.

### Agent hlásí omezení rychlosti

AppAgent to automaticky zkouší znovu a zobrazuje odpočet. Pokud se to opakuje, zkontrolujte ve štítku využití zbývající kredit, nebo pro subagenty použijte nižší úroveň modelu.

### Příliš mnoho žádostí o schválení, nebo naopak málo

Změňte úroveň oprávnění instance (**Ručně**, **Automaticky**, **Vývoj**) v rozbalovací nabídce instance a jednotlivé nástroje upravte v [Nastavení](app:openSettingsPageView) → **Oprávnění nástrojů**.

### V dlouhém chatu jsou odpovědi pomalejší nebo méně přesné

Konverzace zaplňuje svůj kontext. Klikněte na indikátor kontextu a pokračujte v novém chatu se shrnutím.

### Jak vrátím změnu zpět?

Otevřete postranní panel chatu a u změny v historii verzí klikněte na **Zpět**. **Stáhnout XML** exportuje všechny změny.

### Kde jsou uložena moje data?

Lokálně ve vašem prohlížeči (IndexedDB). Chaty nikdy nejdou na server AppAgent — pouze k vašemu poskytovateli AI a do vaší instance ServiceNow. Viz [Ukládání dat](#adv-data-storage).

### Rozhraní nebo tato stránka je ve špatném jazyce

Zvolte jazyk v [Nastavení](app:openSettingsPageView) → **Jazyk**. Možnost **Automaticky** se řídí jazykem prohlížeče.

# Pokročilé {#advanced}

Tento oddíl popisuje pokročilé funkce, tlačítka v záhlaví, formáty importu a exportu a technické podrobnosti o tom, jak AppAgent funguje.

## Tlačítka v záhlaví nástěnky {#adv-dashboard-header}

Záhlaví nástěnky obsahuje několik tlačítek akcí:

| Tlačítko | Popis |
|--------|-------------|
| **Přepnout postranní panel** | Zobrazí nebo skryje levý navigační postranní panel |
| **Otevřít samostatně** | Otevře nástěnku v nové kartě prohlížeče pro samostatné zobrazení |
| **Záhlaví** | Přepíná viditelnost záhlaví widgetů na nástěnce. Když jsou skrytá, widgety se zobrazují přehledněji |
| **Vygenerovat vše znovu** | Nechá agenta znovu vygenerovat všechny widgety na nástěnce. Hodí se k obnovení dat |
| **Importovat** | Importuje nástěnku nebo widget ze souboru JSON |
| **Exportovat** | Exportuje celou nástěnku do souboru JSON pro zálohu nebo sdílení |
| **Přidat widget** | Otevře editor widgetů a vytvoří nový widget s pomocí agenta |

## Tlačítka v záhlaví widgetů {#adv-widget-headers}

**Záhlaví widgetů na nástěnce** (viditelná, když je zapnutý přepínač Záhlaví):

| Tlačítko | Popis |
|--------|-------------|
| **Úchyt pro přetažení** | Ikona widgetu slouží jako úchyt pro přetažení a změnu pořadí widgetů |
| **Vygenerovat znovu** | Požádá agenta o nové vygenerování obsahu tohoto widgetu |
| **Historie** | Zobrazí předchozí verze tohoto widgetu (jsou-li k dispozici) |
| **Celá obrazovka** | Rozbalí widget na celou obrazovku |
| **Upravit** | Otevře editor widgetů pro úpravy pomocí chatu s agentem |
| **Odstranit** | Odebere widget z nástěnky (s potvrzením) |

**Záhlaví widgetů v chatu** (widgety přímo v chatu):

| Tlačítko | Popis |
|--------|-------------|
| **Připnout na nástěnku** | Uloží tento widget na vaši nástěnku |
| **Upravit kód** | Zobrazí a přímo upraví kód HTML/CSS/JS widgetu |
| **Rozbalit/sbalit** | Přepíná viditelnost obsahu widgetu |

## Změna velikosti a přesouvání widgetů {#adv-resize-move}

**Změna velikosti widgetů:**

- Každý widget má v pravém dolním rohu **úchyt pro změnu velikosti**
- Kliknutím a tažením úchytu změníte velikost widgetu
- Šířka se přichytává k mřížce o 12 sloupcích (minimálně 3 sloupce)
- Výška se měří v jednotkách po 50px (minimálně 2 jednotky = 100px)

**Přesouvání widgetů:**

- Zapněte přepínač **Záhlaví**, aby se zobrazila záhlaví widgetů
- Kliknutím a tažením **ikony widgetu** (úchytu pro přetažení) změníte pořadí
- Pusťte widget na jiný widget a jejich pozice se prohodí
- Pořadí widgetů se ukládá automaticky

## Formáty importu a exportu {#adv-import-export}

**Export nástěnky** (`dashboard-YYYY-MM-DD.json`):

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

**Export jednoho widgetu:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Export jednoho chatu** (`chat-title-YYYY-MM-DD.json`):

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

Exporty chatů zachovávají celou historii konverzace včetně všech zpráv uživatele a odpovědí agenta. Chcete-li exportovat jednotlivé chaty, použijte rozbalovací nabídku chatu (···) a zvolte **Stáhnout**.

**Export dovedností** (struktura složek):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Poznámka:** Import a export dovedností používá File System Access API a **funguje pouze v prohlížečích Chrome nebo Edge**.
:::

**Export všech dat** (`appagent-backup-YYYY-MM-DD.json`):

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

Úplná záloha obsahuje celou historii chatů, nastavení, oprávnění nástrojů, widgety nástěnky a konfigurace poskytovatelů API.

## Statistiky API {#adv-api-stats}

Když je tato možnost zapnutá v Nastavení, zobrazují se po každé odpovědi agenta statistiky API:

| Metrika | Popis |
|--------|-------------|
| **Vstup** | Vstupní tokeny — velikost promptu odeslaného agentovi |
| **Výstup** | Výstupní tokeny — velikost odpovědi agenta |
| **Celkem** | Součet vstupních a výstupních tokenů |
| **Čtení/zápis mezipaměti** | Tokeny načtené z mezipaměti promptů nebo do ní zapsané (snižuje cenu) |
| **Uvažování** | Tokeny použité na interní uvažování (některé modely) |
| **Cena** | Odhadovaná cena volání API v USD |
| **Doba trvání** | Čas, který volání API zabralo |

U vícekolových konverzací ukazují souhrnné statistiky součet za všechna volání.

:::tip
Zobrazení statistik API přepnete v [Nastavení](app:openSettingsPageView) → Zobrazení → Zobrazit statistiky API.
:::

## Ruční úpravy dovedností {#adv-skills-manual}

Dovednosti lze vytvářet a upravovat ručně nebo s pomocí agenta:

**Ruční vytvoření dovednosti:**

1. Přejděte do [Dovedností](app:openSkillsView) a klikněte na **Nová dovednost**
2. Zadejte název a popis dovednosti
3. Napište obsah dovednosti ve formátu Markdown
4. Kliknutím na **Uložit** dovednost vytvoříte

**Formát SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Úpravy pomocí agenta:**

1. U libovolné dovednosti klikněte na **Upravit pomocí agenta**
2. Popište, jaké změny chcete
3. Agent obsah dovednosti upraví
4. Zkontrolujte a uložte změny

**Prostředky dovedností:** Dovednosti mohou obsahovat další soubory (XML, JS, MD), které agentovi poskytují doplňující kontext nebo kód.

## Systémový prompt {#adv-system-prompt}

Systémový prompt určuje chování a schopnosti agenta. Můžete ho přizpůsobit v [Nastavení](app:openSettingsPageView).

**Úprava systémového promptu:**

1. Přejděte do Nastavení → oddíl Systémový prompt
2. Kliknutím na **Upravit** přepnete do režimu úprav
3. Upravte šablonu podle potřeby
4. Kliknutím na **Uložit** změny použijete

**Dostupné zástupné symboly:**

| Zástupný symbol | Popis |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Dnešní datum (den v týdnu, měsíc, den, rok) |
| `{{ORCHESTRATOR_POLICY}}` | Zásady delegování na subagenty — vkládají se do hlavních chatů, v chatech subagentů zůstávají prázdné |
| `{{DISABLED_TOOLS}}` | Seznam vypnutých nástrojů |
| `{{TOOL_CATALOG}}` | Katalog odložených nástrojů (prázdný, když je odložené načítání nástrojů vypnuté) |
| `{{SKILLS_SUMMARY}}` | Obsah aktivních dovedností |

Zástupné symboly se při odesílání do AI automaticky nahradí skutečnými hodnotami. Zobrazení počtu tokenů ukazuje velikost šablony i rozbalenou velikost.

:::tip
Kliknutím na **Vrátit na výchozí** v případě potřeby obnovíte původní systémový prompt.
:::

## Volání API agenta {#adv-agent-api}

AppAgent běží jako **rozšíření Chrome**:

- Volání AI API jdou **přímo z vašeho prohlížeče k poskytovateli AI** (např. Anthropic, OpenRouter)
- **Neprocházejí** vaší instancí ani žádným serverem AppAgent
- Váš klíč API (nebo token OAuth) je uložen lokálně ve vašem prohlížeči
- Data konverzace se odesílají ke zpracování poskytovateli AI

**Jak to funguje:**

1. Napíšete zprávu do chatu
2. AppAgent sestaví prompt se systémovými pokyny, nástroji a historií konverzace
3. Prompt se odešle do API poskytovatele AI
4. Odpověď agenta se streamuje zpět do vašeho prohlížeče
5. Volání nástrojů se provádějí ve vašem prohlížeči a pro volání API používají relaci vaší instance

:::tip
**Soukromí:** Váš klíč API a data konverzace se zpracovávají na straně klienta. Volání nástrojů, která pracují s vaší instancí, používají přihlašovací údaje vaší stávající relace.
:::

## Endpointy LLM {#adv-endpoints}

Modely se připojují přes **pojmenované endpointy LLM** — opakovaně použitelné dvojice `URL + API key`. Díky tomu můžete AppAgent nasměrovat na **jakékoli API chat-completions kompatibilní s OpenAI**: OpenRouter, místní bránu, proxy nebo vlastní hostovaný model.

1. V [Nastavení → Endpointy LLM](app:openSettingsPageView) klikněte na **Přidat endpoint**
2. Zadejte název, URL API a klíč API
3. Každý model (poskytovatel API) si vybere endpoint — klíč aktualizujete jednou a aktualizuje se každý model, který ho používá

:::tip
Poskytovatelé Claude s **OAuth** endpointy nepoužívají — komunikují přímo s `api.anthropic.com`.
:::

## Přihlášení přes Claude (OAuth) {#adv-oauth}

Místo vkládání klíče API se můžete k poskytovatelům Anthropic přihlásit pomocí stávající relace claude.ai:

1. V [Nastavení → Poskytovatelé API](app:openSettingsPageView) přidejte nebo upravte poskytovatele Anthropic a zapněte **OAuth**
2. Rozšíření použije vaše přihlášení ke claude.ai ze stejného profilu Chrome a připojí se přímo k Anthropic
3. Žádné další přihlašovací okno a žádný server AppAgent mezi tím

**Požadavky:**

- Musíte být přihlášeni ke `claude.ai` ve stejném profilu Chrome
- Funguje s účty jednotného přihlašování (SSO)

:::tip
Tokeny OAuth se obnovují automaticky. Pokud se přihlášení nezdaří, otevřete `claude.ai` ve stejném profilu a znovu se přihlaste.
:::

## Bezpečnostní hlediska {#adv-security}

**Ukládání klíče API:**

- Váš **klíč API je uložen lokálně** v IndexedDB vašeho prohlížeče
- Klíč se nikdy neodesílá do vaší instance ani na žádný jiný server než k poskytovateli AI
- Vymazáním dat prohlížeče se uložený klíč API odstraní

**Relace a oprávnění:**

- Agent běží s vaší **aktuální uživatelskou relací** a přebírá vaše přístupová práva a role
- Všechna volání API do vaší instance používají přihlašovací údaje vaší relace
- Agent má přístup jen k tomu, k čemu má přístup váš uživatelský účet

**Prostředí pro spouštění nástrojů:**

- **Kód v prohlížeči (js_eval)** spouští JavaScript v **izolovaném sandboxu** s přístupem pouze k `executeTool()`
- **Skripty widgetů** běží v **izolovaných iframech** s přístupem pouze k `executeTool()` pro volání API
- **Nástroje dovedností** běží v **izolovaných sandboxech** s přístupem pouze k `executeTool()`
- Veškerý přístup k API prochází **systémem oprávnění** přes `executeTool("servicenow_api", {...})`
- Agent pracuje se stránkami v **kartách prohlížeče** na vaší instanci ServiceNow

**Možnosti úprav záznamů:**

- Nástroj **ServiceNow API** podporuje metody POST, PATCH, PUT a DELETE, které mohou měnit záznamy
- Agent může vytvářet a upravovat záznamy přes **integrovaný prohlížeč**, pokud má oprávnění pro nástroje vyplňování a klikání
- Nastavte [Oprávnění nástrojů](app:openSettingsPageView), abyste určili, které operace vyžadují schválení

**Sebezdokonalování:**

- Agent může **spravovat vlastní dovednosti** — vytvářet, upravovat a aktivovat je
- Díky tomu se agent může časem učit a zlepšovat
- Pravidelně kontrolujte změny dovedností, aby odpovídaly vašim očekáváním

## Ukládání dat {#adv-data-storage}

AppAgent ukládá data lokálně ve vašem prohlížeči pomocí **IndexedDB**:

| Typ dat | Úložiště | Popis |
|-----------|---------|-------------|
| **Chaty** | IndexedDB | Celá historie konverzací, zprávy a výsledky nástrojů |
| **Nastavení** | IndexedDB | Oprávnění nástrojů, klíče API, předvolby modelů |
| **Widgety nástěnky** | IndexedDB | HTML widgetů, názvy, velikosti a historie konverzací |
| **Dovednosti** | IndexedDB | Definice, obsah a prostředky dovedností |
| **Poskytovatelé API** | IndexedDB | Konfigurace vlastních poskytovatelů API a endpointy |
| **Stav UI** | localStorage | Stav postranního panelu, aktuální zobrazení, pozice posouvání |

**Stažení vašich dat:**

1. Přejděte do [Nastavení](app:openSettingsPageView) → Správa dat
2. Klikněte na **Exportovat data**
3. Stáhne se záložní soubor JSON

**Odstranění vašich dat:**

1. Přejděte do [Nastavení](app:openSettingsPageView) → Správa dat
2. Klikněte na **Odstranit všechna data**
3. Dvojím potvrzením vše trvale odstraníte

:::tip
**Důležité:** Data jsou uložena lokálně v rozšíření. Vymazání dat prohlížeče, odinstalace rozšíření nebo použití jiného profilu prohlížeče povede k oddělenému úložišti dat.
:::

# O aplikaci {#about}

**Verze:** v__VERSION__

**Licence:** Soukromé a komerční použití. Interní úpravy povoleny. Distribuce a další prodej zakázány. Všechna práva vyhrazena.

## Přehled změn {#changelog}

__CHANGELOG__
