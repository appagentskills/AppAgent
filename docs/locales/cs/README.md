# AppAgent

**Vytvářejte a udržujte aplikace ServiceNow pomocí agenta. Jako rozšíření Chrome.**

AppAgent je váš vývojový partner pro ServiceNow. Umí vytvářet a udržovat aplikace a spouštět pro ně testy. Testuje tak, že vyplňuje formuláře a pořizuje snímky obrazovky. Nejsou potřeba žádné technické znalosti.

Stačí vlastní klíč API (BYOK) a je to! Je kompatibilní s OpenAI, OpenRouter, Claude API a dokonce i s plány Claude Code (kontaktujte nás soukromě).

Jde o rozšíření Chrome, které celý chat ukládá ve vašem prohlížeči (data prohlížeč vůbec neopustí). Komunikuje pouze s vaší instancí ServiceNow a s poskytovatelem API vašeho modelu.

![Ukázka AppAgent](AppAgentExample.png)

Spotřebuje méně tokenů než Claude Code, protože hojně využívá mezipaměť API, ukládání nástrojů do mezipaměti a řetězení nástrojů (přímo po instalaci).

Můžete do něj přidávat dovednosti, ovládá prohlížeč přes karty a pro všechny změny, které na vaší instanci provede, má mechanická tlačítka pro vrácení zpět.

> **Poznámka:** AppAgent je zatím určen pouze pro vývojové instance.

## Kontaktujte nás

Vyplňte prosím tento formulář a ozveme se vám: [Kontaktní formulář](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funkce

| Funkce | Co dělá |
|---------|--------------|
| **Vlastní model** | Vyberte si z modelů Claude, GPT, Gemini, Grok a dalších |
| **Přihlášení přes Claude** | Přihlášení přes OAuth — použijte svůj stávající plán Claude Code Personal nebo Enterprise, klíč API není potřeba |
| **Obrázky a PDF** | Přiložte snímky obrazovky, diagramy nebo dokumenty, které agent analyzuje |
| **Úpravy kódu** | Čte a upravuje skripty s úplným sledováním verzí |
| **Ovládání prohlížeče** | Testuje vlastní práci: přechází mezi kartami, kliká, vyplňuje formuláře, pořizuje snímky obrazovky |
| **Živé nástěnky** | Vytváří widgety, které načítají data z vaší instance v reálném čase |
| **Dovednosti agenta** | Vytvářejte vlastní dovednosti a rozšiřujte schopnosti agenta |
| **Akce dovedností** | Dovednosti mohou na domovské stránce zobrazit tlačítka, která jedním kliknutím spustí přednastavené pracovní postupy |
| **Živý průběh** | Sledujte, co agent právě dělá — štítky průběhu se mění podle stavu běží/zaseknuto/hotovo/chyba |
| **Pracovní prostory** | Souborový prostor pro každý chat — klonování repozitářů GitHub, čtení, zápis, úpravy, porovnávání a přepínání větví. Více repozitářů v jednom chatu s ochranou vlastnictví mezi chaty |
| **Integrovaný Git a odesílání na GitHub** | Agent umí přímo z chatu stahovat z GitHubu a odesílat na něj, zakládat větve a otevírat pull requesty — bez terminálu a bez IDE |
| **Chytré dokumenty** | Trvalý Markdown s historií verzí, který agent může upravovat a odkazovat na něj napříč chaty |
| **Více instancí** | Automaticky rozpozná každou instanci ServiceNow otevřenou v prohlížeči; agent je všechny vidí a může s nimi pracovat z jednoho chatu |
| **Subagenti** | Deleguje náročnou nebo paralelní práci na agenty pracující na pozadí, kteří výsledky hlásí do hlavního chatu |
| **25 jazyků** | Rozhraní a nápověda v angličtině a 24 dalších jazycích včetně arabštiny a hebrejštiny psaných zprava doleva |
| **Pozastavení a přerušení** | Pozastavte agenta nebo odešlete novou zprávu uprostřed streamu — probíhající volání se okamžitě přeruší |
| **Hledání na webu** | Bezplatné vyhledávání na webu bez klíče přes Google a DuckDuckGo |
| **Mechanické vrácení zpět** | Každá změna je sledována, vrácení jedním kliknutím |
| **Export do XML** | Export všech změn pro nasazení na jiné instance |
| **Oprávnění nástrojů** | Vestavěné zabezpečení — určete, co agent na instanci smí dělat |
| **Otevřené standardy** | Kompatibilní s [OpenRouter](https://openrouter.ai) a [AgentSkills.io](https://agentskills.io) |
| **Ukládání modelu do mezipaměti** | Díky mezipaměti promptů snižuje náklady až 10× |
| **Chytrý kontext** | Načítá jen potřebné části velkých souborů. Model nepřetíží |
| **Žádné závislosti** | Žádné knihovny, žádné frameworky, čistý vanilla JS |

## Jak to funguje

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

AppAgent je rozšíření Chrome s vestavěnou smyčkou agenta. Popíšete, co chcete → agent se zeptá modelu → spustí nástroje v prohlížeči → přistupuje k ServiceNow s oprávněními vašeho aktuálního uživatele. Agent komunikuje přímo s poskytovateli API modelů, ať už místními, nebo online.

## Srovnání AppAgent s ostatními

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Cílový uživatel** | Netechnický | Vývojáři | Vývojáři | Netechničtí zakladatelé |
| **Vytvořeno pro ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Agentní akce v ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Vyžaduje vývojové prostředí** | ✗ | ✓ | ✓ | ✗ |
| **Vytváří aplikace** | ✓ | ✓ | ✓ | ✓ |
| **Ovládání prohlížeče pro testování** | ✓ | ✗ | ✗ | ✗ |
| **Pořizuje snímky obrazovky** | ✓ | ✗ | ✗ | ✗ |
| **Úlohy na pozadí** | ✓ (přes akce dovedností) | ✗ | ✓ | ✗ |
| **Paralelní agenti** | ✓ (subagenti) | ✗ | ✓ | ✗ |
| **Mechanické vrácení zpět** | ✓ | ✗ | ✗ | ✗ |
| **Obrázky a PDF** | ✓ | ✓ | ✓ | Omezeně |
| **Chytré nástěnky** | ✓ | ✗ | ✗ | ✓ |
| **Rozšiřitelné dovednosti** | ✓ | ✓ | ✗ | ✗ |
| **Akce dovedností (tlačítka na jedno kliknutí)** | ✓ | ✗ | ✗ | ✗ |
| **Živé štítky průběhu** | ✓ | ✗ | ✗ | ✗ |
| **Podpora více instancí** | ✓ | ✗ | ✗ | ✗ |
| **Pracovní prostory pro každý chat** | ✓ | ✗ | ✗ | ✗ |
| **Integrovaný git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Odesílání na GitHub z chatu** | ✓ | ✓ (CLI) | Omezeně | ✗ |
| **Chytré dokumenty** | ✓ | ✗ | ✗ | ✗ |
| **Pozastavení / přerušení uprostřed streamu** | ✓ | ✓ | Omezeně | ✗ |
| **Hledání na webu** | ✓ | ✓ | ✓ | ✗ |
| **Oprávnění nástrojů** | ✓ | ✓ | Omezeně | ✗ |
| **Export změn** | ✓ XML | ✓ | ✓ | ✓ |
| **Vlastní model** | ✓ | ✗ | ✓ | ✗ |
| **Mezipaměť promptů** | ✓ | ✓ | ✓ | ✗ |
| **Chytrý kontext** | ✓ | ✓ | ✓ | ✗ |
| **Žádné závislosti** | ✓ | ✗ | ✗ | ✓ |

*Base44 neumí vytvářet aplikace ServiceNow, ale je uveden pro uživatele, kteří ho znají.*

## Nastavení

1. **Instalace** — Nainstalujte rozšíření AppAgent z Internetového obchodu Chrome (nebo ho pro vývoj načtěte jako rozbalené)
2. **Získání klíče API** — Zaregistrujte se na [OpenRouter](https://openrouter.ai), použijte přímo Anthropic/OpenAI, nebo připojte své předplatné Claude Code (Enterprise nebo Personal)
3. **Konfigurace** — Otevřete rozšíření a v Nastavení → Poskytovatelé API přidejte svůj klíč API (nebo se přihlaste přes Claude)
4. **Začněte tvořit** — Otevřete svou instanci ServiceNow v kartě (rozpozná se automaticky) a začněte chatovat

## Příklady

### „Vytvoř mi jednoduchou aplikaci pro sledování týmových úkolů“
AppAgent vytvoří tabulku, přidá pole, sestaví rozložení formuláře a seznamu a nastaví modul v navigátoru. Jeden prompt, celá aplikace.

### „Proveď úplný audit této instance“
AppAgent vyhledá bezpečnostní mezery, neaktivní administrátorské účty, zastaralé záznamy a prověří osvědčené postupy konfigurace, a pak vám předá zprávu s doporučeními.

### „Otestuj tuto stránku a nahlas všechny problémy, které najdeš“
AppAgent otevře stránku v kartě prohlížeče, vyplní formuláře, klikne na tlačítka, pořídí snímky obrazovky a sestaví zprávu o všem, co najde.

### „V tomto formuláři je chyba, můžeš ji opravit?“
AppAgent otevře formulář, prozkoumá skripty za ním, najde chybu, opraví kód a přesně vám ukáže, co se změnilo. V případě potřeby vše vrátíte jedním kliknutím.

### „Vytvoř widget na nástěnku pro moje otevřené tikety“
AppAgent vytvoří živý widget, který načítá data z vaší instance v reálném čase a zobrazuje je na vaší nástěnce.

### „Importuj tento soubor Excel do tabulky uživatelů“
AppAgent přečte soubor, namapuje sloupce na pole a importuje data do vaší instance.

### „Zkontroluj historii upgradu a oprav problémy s přizpůsobeními“
AppAgent projde, co se při upgradu změnilo, najde nefunkční přizpůsobení a opraví je.

### „Upozorni tým, když vznikne incident P1“
AppAgent vytvoří pravidlo oznámení, které se spustí u incidentů P1 a pošle vašemu týmu upozornění.

---

## Vize

Opus 4.7 je teď skvělý, ale pořád potřebuje trochu hlídat.

S každou generací budeme dál posouvat hranice toho, co modely AI zvládnou, a stoupat výš po úrovních abstrakce, dokud nenarazíme na strop.

GPT-4 => Doplňování kódu
GPT-4o => Napíše samostatný soubor
Sonnet 3.5 => Upraví soubor v kódové základně
Opus 4.5 => Napíše celou funkci
Opus 4.6 => Udržuje aplikaci od začátku do konce
Opus 4.7 => ... (stále testujeme)

---

## Plán vývoje

- RAG
- Specifikace a testovací případy

V libovolném pořadí.

Tato verze slouží hlavně ke sběru zpětné vazby.

Další verze nemusí být open source, ale tuto verzi budeme dál udržovat, dokud nebude stabilní.

---

## Pravidla pro přispívání

Neotevírejte prosím žádné PR — jde o komerční projekt a kód zveřejňujeme jen kvůli transparentnosti a důvěře.

Pokud najdete chyby, můžete otevřít issue nebo nás kontaktovat přímo. Nabízíme pouze komerční podporu, takže budeme opravovat jen chyby, které mohou ovlivnit další uživatele.

---

## Licence

Soukromé a komerční použití. Interní úpravy povoleny. Distribuce a další prodej zakázány.
