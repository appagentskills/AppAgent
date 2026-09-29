# Kom igång {#getting-started}

AppAgent är en AI-agent för ServiceNow som körs som ett Chrome-tillägg. Beskriv vad du behöver med vanliga ord, så hämtar agenten data, redigerar poster, bygger appar och widgetar, testar sidor i din webbläsare och rapporterar tillbaka.

:::tip
**Snabbstart:** Konfigurera en modell, öppna en flik med din ServiceNow-instans, skriv sedan en begäran i chatten och tryck på <kbd>Enter</kbd>.
:::

## Konfigurera en modell {#guide-setup}

1. Öppna [Inställningar](app:openSettingsPageView) och gå till **API-leverantörer**
2. Lägg till en leverantör (Anthropic, OpenRouter eller ett eget OpenAI-kompatibelt API) med din API-nyckel – eller aktivera **OAuth** för en Anthropic-leverantör för att logga in med ditt Claude-konto
3. Välj vilken modell som ska användas under **Agentmodell**

Din API-nyckel lagras bara i din webbläsare. AI-anropen går direkt från din webbläsare till leverantören.

## Anslut dina instanser {#guide-instances}

AppAgent **identifierar automatiskt alla ServiceNow-instanser** som du har öppna i samma Chrome-profil – du behöver inte ange någon anslutningssträng. Logga in på en instans i en vanlig flik, så kan agenten arbeta i den med din användares roller och åtkomsträttigheter. Fråga *"lista instanser"* för att se alla identifierade instanser, dina roller och anslutningsstatusen.

Varje instans har en **behörighetsnivå** som du väljer i instansmenyn:

- **Manuell** – Du godkänner varje skrivåtgärd (skapa, uppdatera, ta bort, fylla i formulär)
- **Auto** – Agenten bestämmer själv över skrivåtgärder utan att fråga
- **Dev** – Inga godkännanden alls: alla verktygsanrop på den här instansen körs utan att fråga. Använd det bara på utvecklingsinstanser

Läsning är alltid tillåten. Se [Verktygsbehörigheter](#feature-permissions) för mer detaljerad styrning.

## Starta en chatt {#guide-chat}

1. Klicka på **Ny chatt** i sidofältet [Starta ny chatt →](app:startNewChat)
2. Skriv din begäran, till exempel *"Visa alla incidenter som skapats i dag"*
3. Tryck på <kbd>Enter</kbd> för att skicka
4. Följ agentens arbete: varje verktygsanrop visas i chatten, och en godkännandefråga visas när ett steg behöver ditt OK

Du kan fortsätta skriva medan agenten arbetar: ett nytt meddelande avbryter det pågående steget, och **Pausa** stoppar körningen.

## Bifoga bilder och filer {#guide-images}

1. Klicka på knappen **Bifoga fil** i inmatningsområdet för att lägga till en bild, PDF, CSV eller textfil
2. Eller klistra in en bild från urklipp, eller dra och släpp den i chatten
3. Skriv din fråga om bilagan

:::tip
Bifoga skärmbilder av fel, UI-skisser eller exporterade data så att agenten ser exakt det du ser.
:::

# Huvudfunktioner {#features}

## Chatt {#page-chat}

Huvudvyn för konversationen. [Starta ny chatt →](app:startNewChat)

- **Meddelandeområde** – Konversationen, inklusive verktygsanrop och deras resultat
- **Inmatningsfält** – Skriv meddelanden, bifoga filer, skicka medan agenten arbetar för att avbryta den
- **Pausa / Fortsätt / Försök igen** – Stoppa agenten, återuppta den eller försök igen med det senaste steget
- **Kontextindikator** – Visar hur full konversationen är; klicka på den för att sammanfatta till en ny chatt
- **Svarskort** – En sammanfattning (**Kort sagt**) och ett **Länkar**-kort (poster, PR:er, dokument) kan visas under ett svar
- **Chatthuvud** – Byt namn på eller fäst chatten, eller öppna AppAgent i en hel webbläsarflik med **Expandera till helsida**

## Webbläsarstyrning {#feature-browser}

Agenten kan öppna och styra webbläsarflikar på din instans för att se och testa sidor:

- **Navigera, klicka, fylla i och välja** – Realistiska händelser, så att formulär och autokompletteringsfält beter sig som om du skrev själv
- **Vänta på** – Vänta på ett element, en text eller en URL i stället för att gissa fördröjningar
- **Skärmbilder** – Ta en bild av sidan, en widget eller ett enskilt element för visuella kontroller
- **Inspektera** – Läs elementegenskaper, stilar, konsolfel och nätverksförfrågningar
- **Personifiera** – Testa som en annan användare och växla sedan tillbaka

## Redigera poster och versionshistorik {#feature-history}

Varje ändring som agenten gör i din instans spåras i chattens sidofält:

- **Ångra** – Återställ en enskild ändring
- **Gör om** – Återinför en ångrad ändring
- **Ladda ned XML** – Exportera alla ändringar, till exempel för att flytta dem till en annan instans

## Underagenter {#feature-subagents}

För tungt eller parallellt arbete kan agenten starta **underagenter**: bakgrundsarbetare som körs i en egen chatt med egen kontext och sedan rapporterar ett kort resultat tillbaka till huvudchatten.

- **Modellnivåer** – Varje underagent körs på nivån **small**, **medium** eller **large**, eller **same** för att använda huvudchattens modell. Koppla nivåerna till modeller i [Inställningar](app:openSettingsPageView) → **Modellnivåer för underagenter**
- **Arbetarfältet** – Underagenter som körs visas som levande etiketter ovanför chattens inmatningsfält; öppna en för att följa förloppet eller läsa dess transkript
- **Pool** – Antalet samtidiga underagenter är begränsat; övriga väntar i en kö

## Instrumentpanel och widgetar {#page-dashboard}

En instrumentpanel med interaktiva widgetar som agenten har skapat. [Öppna instrumentpanelen →](app:openDashboardView)

1. Klicka på **Lägg till widget**
2. Beskriv vad du vill ha, till exempel *"Ett diagram som visar öppna incidenter per prioritet"*
3. Agenten bygger widgeten; be om ändringar eller klicka på **Regenerera** när som helst

Widgetar kan hämta live-data från din instans, så att de hålls uppdaterade. Dra, ändra storlek, importera och exportera dem (se [Avancerat](#advanced)). Widgetar som agenten visar direkt i en chatt kan sparas med **Fäst på instrumentpanelen**.

## Smarta dokument {#page-documents}

**Smarta dokument** är beständiga, versionshanterade Markdown-dokument som agenten skriver och uppdaterar – planer, rapporter, specifikationer, resultat. De visas direkt i chatten, sparar varje version och kan redigeras direkt av dig. Öppna dem från **Dokument** i sidofältet. [Öppna dokument →](app:openDocumentsView)

## Färdigheter {#page-skills}

Färdigheter ger agenten extra kunskap och verktyg. [Öppna färdigheter →](app:openSkillsView)

- **Aktivera / Inaktivera** – Slå på eller av färdigheter; inaktivera dem du inte behöver för att hålla svaren fokuserade
- **Ny färdighet** – Skriv en egen färdighet i Markdown, eller använd **Redigera med agent**
- **Importera / Exportera** – Dela färdigheter som mappar
- **Färdighetsåtgärder** – Vissa färdigheter lägger till knappar på startsidan som startar ett förinställt arbetsflöde med ett klick

En färdighet kan tillhandahålla **kunskap** (instruktioner, bästa praxis) och **egna verktyg** (JavaScript-funktioner som körs i en isolerad sandlåda).

## Arbetsyta och GitHub {#feature-workspace}

Varje chatt har en **arbetsyta** – ett filområde där agenten kan läsa, skriva, redigera och jämföra filer.

- **GitHub** – Anslut ett GitHub-konto i [Inställningar](app:openSettingsPageView) för att klona repon till en arbetsyta. Agenten kan skapa grenar, pusha commits och öppna pull requests direkt från chatten
- **Pull requests** – PR:er som öppnats från en chatt listas i chattens sidofält, med en **Sammanfoga**-knapp
- **Skydd mellan chattar** – Varje fil kommer ihåg vilken chatt som ändrade den, så att två chattar som arbetar parallellt inte skriver över varandras arbete i tysthet
- **Automatisk synkning** – Klonade arbetsytor synkroniseras med GitHub när du navigerar, byter chatt eller går tillbaka till fliken

## Chattens sidofält {#feature-sidebar}

Sidofältet till höger samlar allt som den aktuella chatten har tagit fram:

- **Pull requests** – Titel, målgren och en **Sammanfoga**-knapp
- **Filer i arbetsytan** – Öppna en fil för att visa den, se dess diff eller bläddra bland tidigare versioner
- **Versionshistorik** – Ändringar i instansen med **Ångra**, **Gör om** och **Ladda ned XML**
- **Arbetare** – Underagenter som körs eller är klara, med räknare för verktygsanrop, redigerade filer och öppnade PR:er

## Åtgärder och liveförlopp {#feature-actions}

Långa uppgifter visar förloppet live i stället för att tystna:

- **Förloppskort** – Ett enda kort med en färgad status (körs, fastnat, klar, fel) och en lista med steg
- **Åtgärdsknappar** – Knappar som startar uppföljande arbetsflöden med ett klick
- **Körningsindikator** – Chattlistan markerar chattar där agenten arbetar
- **Aviseringen "Agenten är klar"** – Om du byter flik eller fönster under en körning får du en skrivbordsavisering när agenten är klar

## Aktiva chattar och jobb {#feature-jobs}

Jobbetiketten i sidhuvudet öppnar en livevy över dina chattar och ditt bakgrundsarbete:

- **Aktiva chattar** – Chattar som körs och chattar med olästa resultat (visas i **fetstil**), var och en med en ring som visar kontextanvändningen
- **Underagenter** – Listas under sin överordnade chatt; öppna en för att läsa dess transkript
- **Expandera** – Öppna listan som en större panel med kolumn- eller avsnittslayout

## Verktygsbehörigheter {#feature-permissions}

Utöver behörighetsnivån per instans (**Manuell**, **Auto**, **Dev**) har varje verktyg en egen inställning i [Inställningar](app:openSettingsPageView) → **Verktygsbehörigheter**:

- **Tillåt** – Verktyget körs alltid utan att fråga
- **Auto** – Verktyget körs utan att fråga, såvida inte agenten markerar ett anrop som att det behöver din bekräftelse
- **Fråga** – Du får en godkännandefråga före varje anrop
- **Av** – Agenten kan inte använda verktyget

Vissa verktyg har mer detaljerade inställningar: ServiceNow-API:t per HTTP-metod (GET, POST, PUT, PATCH, DELETE), webbläsarstyrning per åtgärd (navigera, klicka, fylla i, personifiera …) och hantering av färdigheter per åtgärd. Bekräftelsedialoger är färgkodade efter risk: **blå** (rutin), **orange** (varsamhet), **röd** (destruktiv).

:::tip
Låt DELETE och andra destruktiva åtgärder stå på **Fråga**, och använd **Dev** bara på utvecklingsinstanser.
:::

## Agentens verktyg {#feature-tools}

De viktigaste verktygen som agenten använder:

| Verktyg | Vad det gör |
|------|--------------|
| **ServiceNow-API** (`servicenow_api`) | Läser, skapar, uppdaterar och tar bort poster |
| **Bakgrundsskript** (`servicenow_run_script`) | Kör ett serverskript på instansen (kräver rollen admin) |
| **Skriptredigering** (`servicenow_diff_edit`) | Ändrar skript med exakta sök-och-ersätt-redigeringar |
| **Webbläsarstyrning** (`iframe_tool`) | Navigerar, klickar, fyller i, inspekterar och personifierar i webbläsarflikar |
| **Webbläsarkod** (`js_eval`) | Kör JavaScript i en isolerad sandlåda som kan anropa andra verktyg |
| **Skärmbilder** (`take_screenshot`) | Tar en bild av sidan, en widget eller ett element |
| **Widgetar och kort** (`html_widget`, `display`) | Visar interaktiva widgetar, tabeller, kort och tidslinjer i chatten |
| **Smarta dokument** (`document`) | Skapar och uppdaterar beständiga Markdown-dokument |
| **Fråga användaren** (`prompt_user`) | Ber dig om indata via ett formulär i chatten |
| **Underagenter** (`spawn_sub_agent`) | Delegerar arbete till bakgrundsarbetare |
| **Arbetsyta** (`workspace`) | Arbetar med filer och GitHub-repon |
| **Webbhämtning** (`web_fetch`) | Läser sidor från den publika webben |
| **Färdigheter** (`get_skill`, `manage_skill`) | Läser och hanterar färdigheter |

Öppna [Inställningar](app:openSettingsPageView) → **Verktygsbehörigheter** för att se alla verktyg, deras källa och deras behörighet.

## Cachelagring av stort innehåll {#feature-caching}

När ett verktygsresultat är för stort för konversationen (mer än 4K token som standard) cachelagrar AppAgent det. Agenten får en översikt och läser, söker i eller bläddrar sedan bara bland de delar den behöver. Det håller chattarna snabba och fokuserade. Ändra tröskelvärdet (1K till 100K token) i [Inställningar](app:openSettingsPageView) → **Cachelagring av stort innehåll**.

## Kontextindikator {#feature-saturation}

**Kontextindikatorn** bredvid chattens inmatningsfält visar hur full konversationen är. Över 50 % ombeds agenten att avrunda och lämna över återstående tungt arbete till underagenter; vid 100 % stoppar den och rapporterar. Klicka på indikatorn när som helst för att sammanfatta konversationen i en ny chatt.

## Användning och hastighetsgränser {#feature-usage}

- **Användningsetikett** – Sidhuvudet visar din API-användning och återstående gränser; klicka på den för detaljer
- **Automatiska nya försök** – När leverantören begränsar hastigheten eller är överbelastad (HTTP 429 / 529) väntar AppAgent och försöker igen automatiskt, och visar en nedräkning i chatten
- **Slut på krediter** – När en 429 faktiskt betyder att dina krediter är slut står det tydligt i chatten

## Språk {#feature-languages}

Gränssnittet finns på engelska och 24 andra språk: arabiska, kinesiska (förenklad, traditionell), tjeckiska, danska, nederländska, finska, franska (Frankrike, Kanada), tyska, hebreiska, ungerska, italienska, japanska, koreanska, norska, polska, portugisiska (Brasilien, Portugal), ryska, spanska, svenska, thailändska och turkiska.

Välj språk i [Inställningar](app:openSettingsPageView) → **Språk**, eller i snabbinställningsmenyn i sidhuvudet. **Auto** följer webbläsarens språk och faller tillbaka på engelska. Ändringen gäller direkt, utan omladdning.

- **Höger till vänster** – Arabiska och hebreiska använder en layout från höger till vänster
- **Lokala format** – Datum, tider och tal följer ditt språk
- **Agentens svar** – Agenten svarar på det valda språket om du inte skriver på ett annat. Kod, tabell- och fältnamn förblir oförändrade
- **Den här hjälpsidan** – Visas på ditt språk; ändringsloggen förblir på engelska

# Sidor och inställningar {#pages}

## Inställningar {#page-settings}

[Öppna inställningar →](app:openSettingsPageView)

- **Agentmodell** – Modellen som agenten använder
- **API-leverantörer** – Anthropic, OpenRouter eller egna leverantörer, med API-nyckel eller OAuth
- **LLM-slutpunkter** – Namngivna par av `URL + API key` för valfritt OpenAI-kompatibelt API
- **Modellnivåer för underagenter** – Koppla nivåerna small, medium och large till modeller, eller **Samma**
- **Resonemangsnivå, Max antal token och Tankebudget** – Justera svarens djup och längd
- **Kontextfönster** – Kontextstorleken som kontextindikatorn använder
- **Visning** – API-statistik, kompakt läge, håll skärmen vaken
- **Språk** – Gränssnittets språk, eller **Auto**
- **Hookar** – Automatiska chattitlar, aviseringar om att agenten är klar och annan automatisering
- **Cachelagring av stort innehåll** – När stora resultat cachelagras
- **Verktygsbehörigheter** – Vad som körs automatiskt, frågar först eller är inaktiverat
- **GitHub** – Anslut ett GitHub-konto och hantera klonade repon
- **Systemprompt** – Anpassa agentens instruktioner
- **Datahantering** – Exportera, importera eller ta bort dina data

## Historik {#page-history}

Alla dina konversationer. [Öppna historik →](app:openHistoryView)

- **Sök** – Hitta chattar efter titel, innehåll, använda verktyg eller widgetar
- **Fäst** – Håll viktiga chattar överst
- **Exportera** – Ladda ned en chatt eller hela din historik
- **Statistik** – Antal chattar, fästa chattar och total kostnad

## Hjälp {#page-docs}

Den här sidan. [Öppna hjälp →](app:openDocsView)

- **Sök** – Filtrera hjälpavsnitten med sökrutan i verktygsfältet
- **Innehåll** – Hoppa till ett avsnitt från innehållsförteckningen
- **Ladda ned** – Spara dokumentationen som en Markdown-fil

# Tips och kortkommandon {#tips}

| Åtgärd | Hur |
|--------|-----|
| Skicka meddelande | <kbd>Enter</kbd> |
| Ny rad | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Sök i chattar | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> på Mac) |
| Stäng en dialogruta eller meny | <kbd>Esc</kbd> |
| Gå tillbaka | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Bifoga en bild | Klistra in den, eller dra och släpp den i chatten |
| Börja om med en sammanfattning | Klicka på kontextindikatorn |
| Avbryt agenten | Skicka ett nytt meddelande, eller klicka på **Pausa** |

:::tip
**Var specifik.** I stället för *"fixa det här"*, skriv *"fixa null reference-felet på rad 42 i script include MyUtils"*. Ange tabellen, posten eller sidan när du kan.
:::

- **Ett mål per chatt** – Starta en ny chatt för en orelaterad uppgift; agenten blir snabbare och mer träffsäker
- **Låt den testa** – Be agenten att öppna sidan och verifiera sin egen ändring med en skärmbild
- **Använd färdigheter** – Aktivera en färdighet som passar din uppgift (till exempel testning eller granskning) innan du börjar

# Felsökning och vanliga frågor {#faq}

### Agenten ser inte min instans

Öppna instansen i en flik i samma Chrome-profil och kontrollera att du är inloggad, fråga sedan *"lista instanser"*. Om den fortfarande inte visas laddar du om instansfliken.

### Jag får ett API- eller autentiseringsfel

Kontrollera din leverantör i [Inställningar](app:openSettingsPageView) → **API-leverantörer**: API-nyckeln, den valda slutpunkten och modellnamnet. För OAuth loggar du in på claude.ai igen i samma Chrome-profil.

### Agenten säger att hastigheten är begränsad

AppAgent försöker igen automatiskt och visar en nedräkning. Om det fortsätter att hända kan du kontrollera återstående krediter i användningsetiketten, eller använda en mindre modellnivå för underagenter.

### För många godkännandefrågor, eller för få

Ändra instansens behörighetsnivå (**Manuell**, **Auto**, **Dev**) i instansmenyn, och justera enskilda verktyg i [Inställningar](app:openSettingsPageView) → **Verktygsbehörigheter**.

### Svaren blir långsammare eller mindre träffsäkra i en lång chatt

Konversationen håller på att fylla sin kontext. Klicka på kontextindikatorn för att fortsätta i en ny chatt med en sammanfattning.

### Hur ångrar jag en ändring?

Öppna chattens sidofält och klicka på **Ångra** vid ändringen i versionshistoriken. **Ladda ned XML** exporterar alla ändringar.

### Var lagras mina data?

Lokalt i din webbläsare (IndexedDB). Chattar skickas aldrig till en AppAgent-server – bara till din AI-leverantör och din ServiceNow-instans. Se [Datalagring](#adv-data-storage).

### Gränssnittet eller den här sidan visas på fel språk

Välj språk i [Inställningar](app:openSettingsPageView) → **Språk**. **Auto** följer webbläsarens språk.

# Avancerat {#advanced}

Det här avsnittet beskriver avancerade funktioner, knappar i sidhuvudet, format för import/export och tekniska detaljer om hur AppAgent fungerar.

## Knappar i instrumentpanelens sidhuvud {#adv-dashboard-header}

Instrumentpanelens sidhuvud innehåller flera åtgärdsknappar:

| Knapp | Beskrivning |
|--------|-------------|
| **Visa/dölj sidofältet** | Visa eller dölj navigeringen i det vänstra sidofältet |
| **Öppna fristående** | Öppna instrumentpanelen i en ny webbläsarflik för fristående visning |
| **Rubriker** | Växla synligheten för widgetrubriker på instrumentpanelen. När de är dolda visas widgetarna i en renare vy |
| **Regenerera alla** | Låt agenten regenerera alla widgetar på instrumentpanelen. Praktiskt för att uppdatera data |
| **Importera** | Importera en instrumentpanel eller widget från en JSON-fil |
| **Exportera** | Exportera hela instrumentpanelen till en JSON-fil för säkerhetskopiering eller delning |
| **Lägg till widget** | Öppnar widgetredigeraren för att skapa en ny widget med hjälp av agenten |

## Knappar i widgetrubriker {#adv-widget-headers}

**Widgetrubriker på instrumentpanelen** (synliga när reglaget Rubriker är på):

| Knapp | Beskrivning |
|--------|-------------|
| **Draghandtag** | Widgetikonen fungerar som draghandtag för att ändra ordningen på widgetar |
| **Regenerera** | Be agenten att regenerera widgetens innehåll |
| **Historik** | Visa tidigare versioner av widgeten (om sådana finns) |
| **Helskärm** | Expandera widgeten till helskärmsvy |
| **Redigera** | Öppna widgetredigeraren för att ändra den via chatt med agenten |
| **Ta bort** | Ta bort widgeten från instrumentpanelen (med bekräftelse) |

**Widgetrubriker i chatten** (widgetar som visas direkt i chatten):

| Knapp | Beskrivning |
|--------|-------------|
| **Fäst på instrumentpanelen** | Spara widgeten på din instrumentpanel |
| **Redigera kod** | Visa och redigera widgetens HTML/CSS/JS-kod direkt |
| **Expandera/fäll ihop** | Växla synligheten för widgetens innehåll |

## Ändra storlek på och flytta widgetar {#adv-resize-move}

**Ändra storlek på widgetar:**

- Varje widget har ett **storlekshandtag** i det nedre högra hörnet
- Klicka och dra i handtaget för att ändra widgetens storlek
- Bredden fäster mot ett rutnät med 12 kolumner (minst 3 kolumner)
- Höjden mäts i enheter om 50px (minst 2 enheter = 100px)

**Flytta widgetar:**

- Slå på reglaget **Rubriker** för att visa widgetrubriker
- Klicka och dra i **widgetikonen** (draghandtaget) för att ändra ordningen
- Släpp widgeten på en annan widget för att byta plats på dem
- Widgetarnas ordning sparas automatiskt

## Format för import/export {#adv-import-export}

**Export av instrumentpanel** (`dashboard-YYYY-MM-DD.json`):

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

**Export av en enskild widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Export av en enskild chatt** (`chat-title-YYYY-MM-DD.json`):

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

Chattexporter bevarar hela konversationshistoriken, inklusive alla användarmeddelanden och agentens svar. Använd chattens rullgardinsmeny (···) och välj **Ladda ned** för att exportera enskilda chattar.

**Export av färdigheter** (mappstruktur):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Obs!** Import/export av färdigheter använder File System Access API och **fungerar bara i webbläsarna Chrome och Edge**.
:::

**Export av alla data** (`appagent-backup-YYYY-MM-DD.json`):

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

Den fullständiga säkerhetskopian innehåller hela chatthistoriken, inställningar, verktygsbehörigheter, widgetar på instrumentpanelen och konfigurationer för API-leverantörer.

## API-statistik {#adv-api-stats}

När API-statistik är aktiverad i Inställningar visas den efter varje svar från agenten:

| Mått | Beskrivning |
|--------|-------------|
| **In** | Indatatoken – storleken på prompten som skickas till agenten |
| **Ut** | Utdatatoken – storleken på agentens svar |
| **Totalt** | Indata- och utdatatoken sammanlagt |
| **Cache läs/skriv** | Token som lästs från eller skrivits till promptcachen (sänker kostnaden) |
| **Resonemang** | Token som används för internt resonemang (vissa modeller) |
| **Kostnad** | Uppskattad kostnad för API-anropet i USD |
| **Varaktighet** | Tid det tog för API-anropet |

För konversationer med flera turer visar den sammanlagda statistiken totalen för alla anrop.

:::tip
Slå på eller av visningen av API-statistik i [Inställningar](app:openSettingsPageView) → Visning → Visa API-statistik.
:::

## Redigera färdigheter manuellt {#adv-skills-manual}

Färdigheter kan skapas och redigeras manuellt eller med hjälp av agenten:

**Skapa en färdighet manuellt:**

1. Gå till [Färdigheter](app:openSkillsView) och klicka på **Ny färdighet**
2. Ange ett namn och en beskrivning för färdigheten
3. Skriv färdighetens innehåll i Markdown-format
4. Klicka på **Spara** för att skapa färdigheten

**Formatet för SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Redigera med agenten:**

1. Klicka på **Redigera med agent** för valfri färdighet
2. Beskriv vilka ändringar du vill ha
3. Agenten ändrar färdighetens innehåll
4. Granska och spara ändringarna

**Färdighetens tillgångar:** Färdigheter kan innehålla ytterligare filer (XML, JS, MD) som ger agenten extra kontext eller kod.

## Systemprompt {#adv-system-prompt}

Systemprompten styr agentens beteende och förmågor. Du kan anpassa den i [Inställningar](app:openSettingsPageView).

**Redigera systemprompten:**

1. Gå till Inställningar → avsnittet Systemprompt
2. Klicka på **Redigera** för att växla till redigeringsläge
3. Ändra mallen efter behov
4. Klicka på **Spara** för att tillämpa ändringarna

**Tillgängliga platshållare:**

| Platshållare | Beskrivning |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Dagens datum (veckodag, månad, dag, år) |
| `{{ORCHESTRATOR_POLICY}}` | Policy för delegering till underagenter – ingår i huvudchattar, lämnas tom i underagenters chattar |
| `{{DISABLED_TOOLS}}` | Lista över inaktiverade verktyg |
| `{{TOOL_CATALOG}}` | Katalog över uppskjutna verktyg (tom när uppskjuten inläsning av verktyg är avstängd) |
| `{{SKILLS_SUMMARY}}` | Innehållet i aktiva färdigheter |

Platshållarna ersätts automatiskt med faktiska värden när prompten skickas till AI:n. Tokenräknaren visar både mallens storlek och den expanderade storleken.

:::tip
Klicka på **Återgå till standard** för att återställa den ursprungliga systemprompten vid behov.
:::

## Agentens API-anrop {#adv-agent-api}

AppAgent körs som ett **Chrome-tillägg**:

- AI-API-anrop går **direkt från din webbläsare till AI-leverantören** (t.ex. Anthropic, OpenRouter)
- De går **inte** via din instans eller någon AppAgent-server
- Din API-nyckel (eller OAuth-token) lagras lokalt i din webbläsare
- Konversationsdata skickas till AI-leverantören för bearbetning

**Så fungerar det:**

1. Du skriver ett meddelande i chatten
2. AppAgent bygger en prompt med systeminstruktioner, verktyg och konversationshistorik
3. Prompten skickas till AI-leverantörens API
4. Agentens svar strömmas tillbaka till din webbläsare
5. Verktygsanrop körs i din webbläsare och använder din instanssession för API-anrop

:::tip
**Integritet:** Din API-nyckel och dina konversationsdata hanteras på klientsidan. Verktygsanrop som interagerar med din instans använder dina befintliga sessionsuppgifter.
:::

## LLM-slutpunkter {#adv-endpoints}

Modeller ansluter via **namngivna LLM-slutpunkter** – återanvändbara par av `URL + API key`. Det gör att du kan peka AppAgent mot **valfritt OpenAI-kompatibelt chat-completions-API**: OpenRouter, en lokal gateway, en proxy eller din egen driftade modell.

1. I [Inställningar → LLM-slutpunkter](app:openSettingsPageView) klickar du på **Lägg till slutpunkt**
2. Ange ett namn, API-URL:en och en API-nyckel
3. Varje modell (API-leverantör) väljer en slutpunkt – uppdatera en nyckel en gång, så uppdateras alla modeller som använder den

:::tip
Claude-leverantörer med **OAuth** använder inga slutpunkter – de kommunicerar direkt med `api.anthropic.com`.
:::

## Logga in med Claude (OAuth) {#adv-oauth}

I stället för att klistra in en API-nyckel kan du logga in hos Anthropic-leverantörer med din befintliga claude.ai-session:

1. I [Inställningar → API-leverantörer](app:openSettingsPageView) lägger du till eller redigerar en Anthropic-leverantör och aktiverar **OAuth**
2. Tillägget använder din claude.ai-inloggning från samma Chrome-profil för att ansluta direkt till Anthropic
3. Inget extra inloggningsfönster och ingen AppAgent-server emellan

**Krav:**

- Du måste vara inloggad på `claude.ai` i samma Chrome-profil
- Fungerar med konton som använder enkel inloggning (SSO)

:::tip
OAuth-token förnyas automatiskt. Om inloggningen misslyckas öppnar du `claude.ai` i samma profil och loggar in igen.
:::

## Säkerhetsaspekter {#adv-security}

**Lagring av API-nyckel:**

- Din **API-nyckel lagras lokalt** i webbläsarens IndexedDB
- Nyckeln skickas aldrig till din instans eller till någon annan server än AI-leverantören
- Om du rensar webbläsardata tas din lagrade API-nyckel bort

**Session och behörigheter:**

- Agenten körs med din **aktuella användarsession** och ärver dina åtkomsträttigheter och roller
- Alla API-anrop till din instans använder dina sessionsuppgifter
- Agenten kommer bara åt det som ditt användarkonto kommer åt

**Körmiljö för verktyg:**

- **Webbläsarkod (js_eval)** kör JavaScript i en **isolerad sandlåda** med endast åtkomst till `executeTool()`
- **Widgetskript** körs i **isolerade iframes** med endast åtkomst till `executeTool()` för API-anrop
- **Färdighetsverktyg** körs i **isolerade sandlådor** med endast åtkomst till `executeTool()`
- All API-åtkomst går genom **behörighetssystemet** via `executeTool("servicenow_api", {...})`
- Agenten interagerar med sidor i **webbläsarflikar** på din ServiceNow-instans

**Möjligheter att ändra poster:**

- Verktyget **ServiceNow-API** stöder metoderna POST, PATCH, PUT och DELETE, som kan ändra poster
- Agenten kan skapa och redigera poster via den **integrerade webbläsaren** om den har behörighet för verktygen för att fylla i och klicka
- Konfigurera [Verktygsbehörigheter](app:openSettingsPageView) för att styra vilka åtgärder som kräver godkännande

**Självförbättring:**

- Agenten kan **hantera sina egna färdigheter** – skapa, redigera och aktivera färdigheter
- Det gör att agenten kan lära sig och förbättra sig själv över tid
- Granska ändringar i färdigheter regelbundet för att säkerställa att de stämmer med dina förväntningar

## Datalagring {#adv-data-storage}

AppAgent lagrar data lokalt i din webbläsare med **IndexedDB**:

| Datatyp | Lagring | Beskrivning |
|-----------|---------|-------------|
| **Chattar** | IndexedDB | Hela konversationshistoriken, meddelanden och verktygsresultat |
| **Inställningar** | IndexedDB | Verktygsbehörigheter, API-nycklar, modellinställningar |
| **Widgetar på instrumentpanelen** | IndexedDB | Widgetarnas HTML, titlar, storlekar och konversationshistorik |
| **Färdigheter** | IndexedDB | Definitioner, innehåll och tillgångar för färdigheter |
| **API-leverantörer** | IndexedDB | Konfigurationer och slutpunkter för egna API-leverantörer |
| **UI-tillstånd** | localStorage | Sidofältets läge, aktuell vy, rullningspositioner |

**Ladda ned dina data:**

1. Gå till [Inställningar](app:openSettingsPageView) → Datahantering
2. Klicka på **Exportera data**
3. En JSON-fil med säkerhetskopian laddas ned

**Ta bort dina data:**

1. Gå till [Inställningar](app:openSettingsPageView) → Datahantering
2. Klicka på **Ta bort alla data**
3. Bekräfta två gånger för att ta bort allt permanent

:::tip
**Viktigt:** Data lagras lokalt i tillägget. Om du rensar webbläsardata, avinstallerar tillägget eller använder en annan webbläsarprofil får du separata datalager.
:::

# Om {#about}

**Version:** v__VERSION__

**Licens:** Privat och kommersiell användning. Intern modifiering tillåten. Distribution och vidareförsäljning förbjuden. Med ensamrätt.

## Ändringslogg {#changelog}

__CHANGELOG__
