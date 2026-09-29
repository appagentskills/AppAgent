# Aan de slag {#getting-started}

AppAgent is een AI-agent voor ServiceNow die als Chrome-extensie draait. Beschrijf in gewone taal wat u nodig hebt, en de agent vraagt gegevens op, bewerkt records, bouwt apps en widgets, test pagina's in uw browser en brengt verslag uit.

:::tip
**Snel aan de slag:** stel een model in, open een tabblad met uw ServiceNow-instantie, typ een verzoek in de chat en druk op <kbd>Enter</kbd>.
:::

## Een model instellen {#guide-setup}

1. Open [Instellingen](app:openSettingsPageView) en ga naar **API-providers**
2. Voeg een provider toe (Anthropic, OpenRouter of een aangepaste OpenAI-compatibele API) met uw API-sleutel — of schakel **OAuth** in bij een Anthropic-provider om u aan te melden met uw Claude-account
3. Kies onder **Agentmodel** het model dat u wilt gebruiken

Uw API-sleutel wordt alleen in uw browser opgeslagen. AI-aanroepen gaan rechtstreeks van uw browser naar de provider.

## Uw instanties koppelen {#guide-instances}

AppAgent **detecteert automatisch elke ServiceNow-instantie** die u in hetzelfde Chrome-profiel open hebt — u hoeft geen verbindingsreeks in te voeren. Meld u in een gewoon tabblad aan bij een instantie, en de agent kan erop werken met de rollen en toegangsrechten van uw gebruiker. Vraag *"list instances"* om alle gedetecteerde instanties, uw rollen en de verbindingsstatus te zien.

Elke instantie heeft een **machtigingsniveau**, dat u kiest in de vervolgkeuzelijst van de instantie:

- **Handmatig** — U keurt elke schrijfbewerking goed (aanmaken, bijwerken, verwijderen, formulieren invullen)
- **Auto** — De agent beslist zelf over schrijfbewerkingen, zonder te vragen
- **Dev** — Helemaal geen goedkeuringen: elke toolaanroep op deze instantie wordt zonder vragen uitgevoerd. Gebruik dit alleen op ontwikkelinstanties

Lezen is altijd toegestaan. Zie [Toolmachtigingen](#feature-permissions) voor fijnere controle.

## Een chat starten {#guide-chat}

1. Klik in de zijbalk op **Nieuwe chat** [Nieuwe chat starten →](app:startNewChat)
2. Typ uw verzoek, bijvoorbeeld *"Toon alle incidenten die vandaag zijn aangemaakt"*
3. Druk op <kbd>Enter</kbd> om te verzenden
4. Volg de agent terwijl hij werkt: elke toolaanroep verschijnt in de chat, en er verschijnen goedkeuringsvragen wanneer een stap uw akkoord nodig heeft

U kunt blijven typen terwijl de agent werkt: een nieuw bericht onderbreekt de huidige stap, en **Pauzeren** stopt de uitvoering.

## Afbeeldingen en bestanden bijvoegen {#guide-images}

1. Klik in het invoergebied op de knop **Bestand bijvoegen** om een afbeelding, pdf, csv- of tekstbestand toe te voegen
2. Of plak een afbeelding vanaf het klembord, of sleep deze naar de chat
3. Typ uw vraag over de bijlage

:::tip
Voeg screenshots van fouten, UI-mockups of geëxporteerde gegevens toe, zodat de agent precies ziet wat u ziet.
:::

# Belangrijkste functies {#features}

## Chat {#page-chat}

De hoofdweergave voor gesprekken. [Nieuwe chat starten →](app:startNewChat)

- **Berichtengebied** — Het gesprek, inclusief toolaanroepen en hun resultaten
- **Invoervak** — Typ berichten, voeg bestanden toe, en verzend terwijl de agent bezig is om hem te onderbreken
- **Pauzeren / Doorgaan / Opnieuw proberen** — Stop de agent, laat hem verdergaan of probeer de laatste stap opnieuw
- **Contextindicator** — Toont hoe vol het gesprek is; klik erop om het samen te vatten in een nieuwe chat
- **Antwoordkaarten** — Onder een antwoord kunnen een samenvatting (**Samengevat**) en een kaart met **Links** (records, PR's, documenten) verschijnen
- **Chatkoptekst** — Hernoem de chat of zet deze vast, of open AppAgent in een volledig browsertabblad met **Uitvouwen tot volledige pagina**

## Browserbesturing {#feature-browser}

De agent kan browsertabbladen op uw instantie openen en besturen om pagina's te bekijken en te testen:

- **Navigeren, klikken, invullen en selecteren** — Realistische gebeurtenissen, zodat formulieren en velden met automatisch aanvullen zich gedragen alsof u zelf typt
- **Wachten op** — Wacht op een element, een tekst of een URL in plaats van vertragingen te gokken
- **Schermafbeeldingen** — Leg de pagina, een widget of een los element vast voor visuele controles
- **Inspecteren** — Lees eigenschappen en stijlen van elementen, consolefouten en netwerkverzoeken
- **Imiteren** — Test als een andere gebruiker en schakel daarna terug

## Records bewerken en versiegeschiedenis {#feature-history}

Elke wijziging die de agent op uw instantie aanbrengt, wordt bijgehouden in de chatzijbalk:

- **Ongedaan maken** — Draai een afzonderlijke wijziging terug
- **Opnieuw uitvoeren** — Herstel een teruggedraaide wijziging
- **XML downloaden** — Exporteer alle wijzigingen, bijvoorbeeld om ze naar een andere instantie over te zetten

## Subagents {#feature-subagents}

Voor zwaar of parallel werk kan de agent **subagents** starten: achtergrondwerkers die in hun eigen chat en context draaien en daarna een kort resultaat terugmelden aan de hoofdchat.

- **Modelniveaus** — Elke subagent draait op het niveau **small**, **medium** of **large**, of op **same** om het model van de bovenliggende agent te gebruiken. Koppel niveaus aan modellen via [Instellingen](app:openSettingsPageView) → **Modelniveaus voor subagents**
- **Workers-balk** — Actieve subagents verschijnen als live chips boven het chatinvoerveld; open er een om de voortgang te volgen of het transcript te lezen
- **Pool** — Het aantal gelijktijdige subagents is begrensd; extra subagents wachten in een wachtrij

## Dashboard en widgets {#page-dashboard}

Een dashboard met interactieve widgets die door de agent zijn gegenereerd. [Dashboard openen →](app:openDashboardView)

1. Klik op **Widget toevoegen**
2. Beschrijf wat u wilt, bijvoorbeeld *"Een grafiek met open incidenten per prioriteit"*
3. De agent bouwt de widget; vraag om wijzigingen of klik op elk gewenst moment op **Opnieuw genereren**

Widgets kunnen live gegevens van uw instantie ophalen, zodat ze actueel blijven. U kunt ze verslepen, van formaat veranderen, importeren en exporteren (zie [Geavanceerd](#advanced)). Widgets die de agent inline in een chat toont, kunt u opslaan met **Vastzetten op dashboard**.

## Slimme documenten {#page-documents}

**Slimme documenten** zijn blijvende Markdown-documenten met versiebeheer die de agent schrijft en bijwerkt — plannen, rapporten, specificaties, bevindingen. Ze worden inline in de chat weergegeven, bewaren elke versie en u kunt ze zelf rechtstreeks bewerken. Open ze via **Documenten** in de zijbalk. [Documenten openen →](app:openDocumentsView)

## Skills {#page-skills}

Skills geven de agent extra kennis en tools. [Skills openen →](app:openSkillsView)

- **Activeren / Deactiveren** — Zet skills aan of uit; deactiveer de skills die u niet nodig hebt, zodat de antwoorden gericht blijven
- **Nieuwe skill** — Schrijf uw eigen skill in Markdown, of gebruik **Bewerken met agent**
- **Importeren / Exporteren** — Deel skills als mappen
- **Skill-acties** — Sommige skills voegen knoppen op de startpagina toe die met één klik een vooraf ingestelde workflow starten

Een skill kan **kennis** leveren (instructies, best practices) en **aangepaste tools** (JavaScript-functies die in een geïsoleerde sandbox draaien).

## Werkruimte en GitHub {#feature-workspace}

Elke chat heeft een **werkruimte** — een bestandsgebied waarin de agent bestanden kan lezen, schrijven, bewerken en vergelijken.

- **GitHub** — Koppel een GitHub-account in [Instellingen](app:openSettingsPageView) om repository's naar een werkruimte te klonen. De agent kan vanuit de chat branches aanmaken, commits pushen en pull requests openen
- **Pull requests** — PR's die vanuit een chat zijn geopend, staan in de chatzijbalk, met een knop **Samenvoegen**
- **Bescherming tussen chats** — Elk bestand onthoudt welke chat het heeft gewijzigd, zodat twee chats die parallel werken niet ongemerkt elkaars werk overschrijven
- **Automatisch synchroniseren** — Gekloonde werkruimten synchroniseren met GitHub wanneer u navigeert, van chat wisselt of terugkeert naar het tabblad

## Chatzijbalk {#feature-sidebar}

De zijbalk aan de rechterkant verzamelt alles wat de huidige chat heeft opgeleverd:

- **Pull requests** — Titel, doelbranch en een knop **Samenvoegen**
- **Werkruimtebestanden** — Open een bestand om het te bekijken, de diff te zien of eerdere versies door te bladeren
- **Versiegeschiedenis** — Wijzigingen op de instantie met **Ongedaan maken**, **Opnieuw uitvoeren** en **XML downloaden**
- **Workers** — Actieve en voltooide subagents, met tellers voor toolaanroepen, bewerkte bestanden en geopende PR's

## Acties en live voortgang {#feature-actions}

Lange taken tonen live voortgang in plaats van stil te vallen:

- **Voortgangskaart** — Eén kaart met een gekleurde status (bezig, vastgelopen, klaar, fout) en een lijst met stappen
- **Actieknoppen** — Knoppen die met één klik vervolgworkflows starten
- **Activiteitsindicator** — De chatlijst markeert chats waarin de agent bezig is
- **Melding "Agent klaar"** — Als u tijdens een uitvoering van tabblad of venster wisselt, laat een bureaubladmelding weten wanneer de agent klaar is

## Actieve chats en taken {#feature-jobs}

Het takenlabel in de koptekst opent een live overzicht van uw chats en achtergrondwerk:

- **Actieve chats** — Lopende chats en chats met ongelezen resultaten (**vetgedrukt** weergegeven), elk met een ring die het contextgebruik toont
- **Subagents** — Staan onder hun bovenliggende chat; open er een om het transcript te lezen
- **Uitvouwen** — Open de lijst als groter paneel met een indeling in kolommen of secties

## Toolmachtigingen {#feature-permissions}

Naast het machtigingsniveau per instantie (**Handmatig**, **Auto**, **Dev**) heeft elke tool een eigen instelling in [Instellingen](app:openSettingsPageView) → **Toolmachtigingen**:

- **Toestaan** — De tool wordt altijd zonder vragen uitgevoerd
- **Auto** — De tool wordt zonder vragen uitgevoerd, tenzij de agent een aanroep markeert als iets waarvoor uw bevestiging nodig is
- **Vragen** — U krijgt vóór elke aanroep een goedkeuringsvraag
- **Uit** — De agent kan de tool niet gebruiken

Sommige tools hebben fijnere instellingen: de ServiceNow API per HTTP-methode (GET, POST, PUT, PATCH, DELETE), browserbesturing per actie (navigeren, klikken, invullen, imiteren…) en skillbeheer per actie. Bevestigingsdialogen hebben een kleur die het risico aangeeft: **blauw** (routine), **oranje** (voorzichtig), **rood** (destructief).

:::tip
Laat DELETE en andere destructieve bewerkingen op **Vragen** staan, en gebruik **Dev** alleen op ontwikkelinstanties.
:::

## Tools van de agent {#feature-tools}

De belangrijkste tools die de agent gebruikt:

| Tool | Wat de tool doet |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Records lezen, aanmaken, bijwerken en verwijderen |
| **Achtergrondscript** (`servicenow_run_script`) | Een serverscript op de instantie uitvoeren (vereist de rol admin) |
| **Scriptbewerkingen** (`servicenow_diff_edit`) | Scripts wijzigen met nauwkeurige zoek-en-vervangbewerkingen |
| **Browserbesturing** (`iframe_tool`) | Navigeren, klikken, invullen, inspecteren en imiteren in browsertabbladen |
| **Browsercode** (`js_eval`) | JavaScript uitvoeren in een geïsoleerde sandbox die andere tools kan aanroepen |
| **Schermafbeeldingen** (`take_screenshot`) | De pagina, een widget of een element vastleggen |
| **Widgets en kaarten** (`html_widget`, `display`) | Interactieve widgets, tabellen, kaarten en tijdlijnen in de chat tonen |
| **Slimme documenten** (`document`) | Blijvende Markdown-documenten aanmaken en bijwerken |
| **Gebruiker vragen** (`prompt_user`) | U om invoer vragen met een inline formulier |
| **Subagents** (`spawn_sub_agent`) | Werk delegeren aan achtergrondwerkers |
| **Werkruimte** (`workspace`) | Werken met bestanden en GitHub-repository's |
| **Webpagina ophalen** (`web_fetch`) | Pagina's van het openbare web lezen |
| **Skills** (`get_skill`, `manage_skill`) | Skills lezen en beheren |

Open [Instellingen](app:openSettingsPageView) → **Toolmachtigingen** om elke tool te zien, met de bron en de machtiging.

## Caching van grote inhoud {#feature-caching}

Wanneer een toolresultaat te groot is voor het gesprek (standaard meer dan 4K tokens), slaat AppAgent het op in de cache. De agent krijgt een overzicht en leest, doorzoekt of doorbladert daarna alleen de delen die hij nodig heeft. Zo blijven chats snel en gericht. Wijzig de drempel (1K tot 100K tokens) in [Instellingen](app:openSettingsPageView) → **Caching van grote inhoud**.

## Contextindicator {#feature-saturation}

De **contextindicator** naast het chatinvoerveld toont hoe vol het gesprek is. Boven 50% wordt de agent gevraagd af te ronden en het resterende zware werk over te dragen aan subagents; bij 100% stopt hij en brengt hij verslag uit. Klik op elk moment op de indicator om het gesprek samen te vatten in een nieuwe chat.

## Gebruik en limieten {#feature-usage}

- **Gebruikslabel** — De koptekst toont uw API-gebruik en resterende limieten; klik erop voor details
- **Automatisch opnieuw proberen** — Als de provider een limiet oplegt of overbelast is (HTTP 429 / 529), wacht AppAgent en probeert het automatisch opnieuw, met een aftelling in de chat
- **Tegoed op** — Als een 429 eigenlijk betekent dat uw tegoed op is, meldt de chat dat duidelijk

## Talen {#feature-languages}

De interface is beschikbaar in het Engels en in 24 andere talen: Arabisch, Chinees (vereenvoudigd, traditioneel), Deens, Duits, Fins, Frans (Frankrijk, Canada), Hebreeuws, Hongaars, Italiaans, Japans, Koreaans, Nederlands, Noors, Pools, Portugees (Brazilië, Portugal), Russisch, Spaans, Thai, Tsjechisch, Turks en Zweeds.

Kies een taal in [Instellingen](app:openSettingsPageView) → **Taal**, of via het menu met snelle instellingen in de koptekst. **Auto** volgt de taal van uw browser en valt terug op het Engels. De wijziging gaat direct in, zonder opnieuw te laden.

- **Van rechts naar links** — Arabisch en Hebreeuws gebruiken een indeling van rechts naar links
- **Lokale notaties** — Datums, tijden en getallen volgen uw taal
- **Antwoorden van de agent** — De agent antwoordt in de gekozen taal, tenzij u in een andere taal schrijft. Code en namen van tabellen en velden blijven ongewijzigd
- **Deze helppagina** — Wordt in uw taal getoond; het wijzigingslogboek blijft in het Engels

# Pagina's en instellingen {#pages}

## Instellingen {#page-settings}

[Instellingen openen →](app:openSettingsPageView)

- **Agentmodel** — Het model dat de agent gebruikt
- **API-providers** — Anthropic, OpenRouter of aangepaste providers, met een API-sleutel of OAuth
- **LLM-endpoints** — Benoemde paren `URL + API key` voor elke OpenAI-compatibele API
- **Modelniveaus voor subagents** — Koppel de niveaus small, medium en large aan modellen, of aan **Hetzelfde**
- **Redeneerinspanning, max. tokens en denkbudget** — Stem de diepgang en lengte van antwoorden af
- **Contextvenster** — De contextgrootte die de contextindicator gebruikt
- **Weergave** — API-statistieken, compacte modus, scherm actief houden
- **Taal** — Taal van de interface, of **Auto**
- **Hooks** — Automatische chattitels, meldingen "Agent klaar" en andere automatisering
- **Caching van grote inhoud** — Wanneer grote resultaten in de cache worden opgeslagen
- **Toolmachtigingen** — Wat automatisch wordt uitgevoerd, eerst om toestemming vraagt of is uitgeschakeld
- **GitHub** — Koppel een GitHub-account en beheer gekloonde repository's
- **Systeemprompt** — Pas de instructies van de agent aan
- **Gegevensbeheer** — Exporteer, importeer of verwijder uw gegevens

## Geschiedenis {#page-history}

Al uw gesprekken. [Geschiedenis openen →](app:openHistoryView)

- **Zoeken** — Vind chats op titel, inhoud, gebruikte tools of widgets
- **Vastzetten** — Houd belangrijke chats bovenaan
- **Exporteren** — Download één chat of uw hele geschiedenis
- **Statistieken** — Aantal chats, vastgezette chats en totale kosten

## Help {#page-docs}

Deze pagina. [Help openen →](app:openDocsView)

- **Zoeken** — Filter de helponderwerpen via het zoekvak in de werkbalk
- **Inhoud** — Spring via het overzicht naar een sectie
- **Downloaden** — Sla de documentatie op als Markdown-bestand

# Tips en sneltoetsen {#tips}

| Actie | Hoe |
|--------|-----|
| Bericht verzenden | <kbd>Enter</kbd> |
| Nieuwe regel | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Chats zoeken | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> op Mac) |
| Een dialoogvenster of menu sluiten | <kbd>Esc</kbd> |
| Terug | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Een afbeelding bijvoegen | Plak de afbeelding, of sleep deze naar de chat |
| Opnieuw beginnen met een samenvatting | Klik op de contextindicator |
| De agent onderbreken | Verzend een nieuw bericht, of klik op **Pauzeren** |

:::tip
**Wees specifiek.** Zeg in plaats van *"los dit op"* liever *"los de null-referentiefout op regel 42 van de script include MyUtils op"*. Noem waar mogelijk de tabel, het record of de pagina.
:::

- **Eén doel per chat** — Start een nieuwe chat voor een taak die er los van staat; de agent blijft dan sneller en nauwkeuriger
- **Laat hem testen** — Vraag de agent de pagina te openen en zijn eigen wijziging met een screenshot te controleren
- **Gebruik skills** — Activeer vóór u begint een skill die bij uw taak past (bijvoorbeeld voor testen of audits)

# Probleemoplossing en veelgestelde vragen {#faq}

### De agent ziet mijn instantie niet

Open de instantie in een tabblad van hetzelfde Chrome-profiel, zorg dat u bent aangemeld en vraag dan *"list instances"*. Verschijnt de instantie nog steeds niet, laad het tabblad van de instantie dan opnieuw.

### Ik krijg een API- of authenticatiefout

Controleer uw provider in [Instellingen](app:openSettingsPageView) → **API-providers**: de API-sleutel, het geselecteerde endpoint en de modelnaam. Meld u bij OAuth opnieuw aan bij claude.ai in hetzelfde Chrome-profiel.

### De agent meldt dat er een limiet is bereikt

AppAgent probeert het automatisch opnieuw en toont een aftelling. Blijft het gebeuren, kijk dan in het gebruikslabel hoeveel tegoed er nog over is, of gebruik een kleiner modelniveau voor subagents.

### Te veel goedkeuringsvragen, of te weinig

Wijzig het machtigingsniveau van de instantie (**Handmatig**, **Auto**, **Dev**) in de vervolgkeuzelijst van de instantie, en stel afzonderlijke tools in via [Instellingen](app:openSettingsPageView) → **Toolmachtigingen**.

### Antwoorden worden trager of minder nauwkeurig in een lange chat

De context van het gesprek raakt vol. Klik op de contextindicator om verder te gaan in een nieuwe chat met een samenvatting.

### Hoe maak ik een wijziging ongedaan?

Open de chatzijbalk en klik in de versiegeschiedenis bij de wijziging op **Ongedaan maken**. Met **XML downloaden** exporteert u alle wijzigingen.

### Waar worden mijn gegevens opgeslagen?

Lokaal in uw browser (IndexedDB). Chats gaan nooit naar een AppAgent-server — alleen naar uw AI-provider en uw ServiceNow-instantie. Zie [Gegevensopslag](#adv-data-storage).

### De interface of deze pagina staat in de verkeerde taal

Kies de taal in [Instellingen](app:openSettingsPageView) → **Taal**. **Auto** volgt de taal van uw browser.

# Geavanceerd {#advanced}

Deze sectie behandelt geavanceerde functies, knoppen in de koptekst, import- en exportformaten en technische details over hoe AppAgent werkt.

## Knoppen in de dashboardkoptekst {#adv-dashboard-header}

De koptekst van het dashboard bevat verschillende actieknoppen:

| Knop | Beschrijving |
|--------|-------------|
| **Zijbalk in-/uitklappen** | De navigatiezijbalk links tonen of verbergen |
| **Zelfstandig openen** | Het dashboard openen in een nieuw browsertabblad om het los te bekijken |
| **Kopteksten** | De kopteksten van widgets op het dashboard tonen of verbergen. Als ze verborgen zijn, worden widgets in een rustigere weergave getoond |
| **Alles opnieuw genereren** | Alle widgets op het dashboard opnieuw laten genereren door de agent. Handig om gegevens te vernieuwen |
| **Importeren** | Een dashboard of widget importeren uit een JSON-bestand |
| **Exporteren** | Het volledige dashboard exporteren naar een JSON-bestand, als back-up of om te delen |
| **Widget toevoegen** | Opent de widgeteditor om met hulp van de agent een nieuwe widget te maken |

## Knoppen in de widgetkoptekst {#adv-widget-headers}

**Kopteksten van dashboardwidgets** (zichtbaar wanneer de schakelaar Kopteksten aan staat):

| Knop | Beschrijving |
|--------|-------------|
| **Sleepgreep** | Het widgetpictogram dient als sleepgreep om widgets anders te ordenen |
| **Opnieuw genereren** | De agent vragen de inhoud van deze widget opnieuw te genereren |
| **Geschiedenis** | Eerdere versies van deze widget bekijken (indien beschikbaar) |
| **Volledig scherm** | De widget uitvouwen tot volledig scherm |
| **Bewerken** | De widgeteditor openen om de widget via een chat met de agent aan te passen |
| **Verwijderen** | De widget van het dashboard verwijderen (met bevestiging) |

**Kopteksten van chatwidgets** (inline widgets in de chat):

| Knop | Beschrijving |
|--------|-------------|
| **Vastzetten op dashboard** | Deze widget op uw dashboard opslaan |
| **Code bewerken** | De HTML/CSS/JS-code van de widget rechtstreeks bekijken en bewerken |
| **Uitvouwen/samenvouwen** | De inhoud van de widget tonen of verbergen |

## Widgets van formaat veranderen en verplaatsen {#adv-resize-move}

**Widgets van formaat veranderen:**

- Elke widget heeft rechtsonder een **formaatgreep**
- Klik op de greep en sleep om het formaat van de widget te wijzigen
- De breedte klikt vast op een raster van 12 kolommen (minimaal 3 kolommen)
- De hoogte wordt gemeten in eenheden van 50px (minimaal 2 eenheden = 100px)

**Widgets verplaatsen:**

- Zet de schakelaar **Kopteksten** aan om de kopteksten van widgets te tonen
- Klik op het **widgetpictogram** (sleepgreep) en sleep om de volgorde te wijzigen
- Zet de widget neer op een andere widget om hun posities te verwisselen
- De volgorde van widgets wordt automatisch opgeslagen

## Import- en exportformaten {#adv-import-export}

**Dashboardexport** (`dashboard-YYYY-MM-DD.json`):

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

**Export van één widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Export van één chat** (`chat-title-YYYY-MM-DD.json`):

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

Chatexports bewaren de volledige gespreksgeschiedenis, inclusief alle berichten van de gebruiker en antwoorden van de agent. Gebruik het vervolgmenu van de chat (···) en kies **Downloaden** om afzonderlijke chats te exporteren.

**Skillexport** (mappenstructuur):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Let op:** het importeren en exporteren van skills gebruikt de File System Access API en **werkt alleen in Chrome of Edge**.
:::

**Export van alle gegevens** (`appagent-backup-YYYY-MM-DD.json`):

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

De volledige back-up bevat de hele chatgeschiedenis, instellingen, toolmachtigingen, dashboardwidgets en de configuratie van API-providers.

## API-statistieken {#adv-api-stats}

Als ze in Instellingen zijn ingeschakeld, worden na elk antwoord van de agent API-statistieken getoond:

| Meetwaarde | Beschrijving |
|--------|-------------|
| **In** | Invoertokens — de grootte van de prompt die naar de agent is verzonden |
| **Uit** | Uitvoertokens — de grootte van het antwoord van de agent |
| **Totaal** | Invoer- en uitvoertokens samen |
| **Cache lezen/schrijven** | Tokens die uit de promptcache zijn gelezen of ernaar zijn geschreven (verlaagt de kosten) |
| **Redeneren** | Tokens die zijn gebruikt voor intern redeneren (bij sommige modellen) |
| **Kosten** | Geschatte kosten van de API-aanroep in USD |
| **Duur** | Tijd die de API-aanroep nodig had |

Bij gesprekken met meerdere beurten tonen de samengevoegde statistieken het totaal van alle aanroepen.

:::tip
Schakel de weergave van API-statistieken in of uit via [Instellingen](app:openSettingsPageView) → Weergave → API-statistieken tonen.
:::

## Skills handmatig bewerken {#adv-skills-manual}

Skills kunnen handmatig of met hulp van de agent worden gemaakt en bewerkt:

**Handmatig een skill maken:**

1. Ga naar [Skills](app:openSkillsView) en klik op **Nieuwe skill**
2. Voer een naam en beschrijving voor de skill in
3. Schrijf de inhoud van de skill in Markdown
4. Klik op **Opslaan** om de skill te maken

**Indeling van SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Bewerken met de agent:**

1. Klik bij een skill op **Bewerken met agent**
2. Beschrijf welke wijzigingen u wilt
3. De agent past de inhoud van de skill aan
4. Controleer de wijzigingen en sla ze op

**Skill-assets:** skills kunnen extra bestanden bevatten (XML, JS, MD) die de agent extra context of code geven.

## Systeemprompt {#adv-system-prompt}

De systeemprompt bepaalt het gedrag en de mogelijkheden van de agent. U kunt deze aanpassen in [Instellingen](app:openSettingsPageView).

**De systeemprompt bewerken:**

1. Ga naar Instellingen → sectie Systeemprompt
2. Klik op **Bewerken** om naar de bewerkingsmodus te gaan
3. Pas de sjabloon naar wens aan
4. Klik op **Opslaan** om de wijzigingen toe te passen

**Beschikbare tijdelijke aanduidingen:**

| Placeholder | Beschrijving |
|-------------|-------------|
| `{{CURRENT_DATE}}` | De datum van vandaag (weekdag, maand, dag, jaar) |
| `{{ORCHESTRATOR_POLICY}}` | Beleid voor delegeren aan subagents — opgenomen in hoofdchats, leeg in chats van subagents |
| `{{DISABLED_TOOLS}}` | Lijst met uitgeschakelde tools |
| `{{TOOL_CATALOG}}` | Catalogus van uitgestelde tools (leeg als het uitgesteld laden van tools uit staat) |
| `{{SKILLS_SUMMARY}}` | Inhoud van de actieve skills |

Placeholders worden bij het verzenden naar de AI automatisch vervangen door de werkelijke waarden. De weergave van het aantal tokens toont zowel de grootte van de sjabloon als de uitgebreide grootte.

:::tip
Klik op **Standaard herstellen** om zo nodig de oorspronkelijke systeemprompt terug te zetten.
:::

## API-aanroepen van de agent {#adv-agent-api}

AppAgent draait als **Chrome-extensie**:

- AI-API-aanroepen gaan **rechtstreeks van uw browser naar de AI-provider** (bijv. Anthropic, OpenRouter)
- Ze gaan **niet** via uw instantie of een AppAgent-server
- Uw API-sleutel (of OAuth-token) wordt lokaal in uw browser opgeslagen
- Gespreksgegevens worden ter verwerking naar de AI-provider verzonden

**Zo werkt het:**

1. U typt een bericht in de chat
2. AppAgent stelt een prompt samen met systeeminstructies, tools en de gespreksgeschiedenis
3. De prompt wordt naar de API van de AI-provider verzonden
4. Het antwoord van de agent wordt teruggestreamd naar uw browser
5. Toolaanroepen worden in uw browser uitgevoerd, met uw sessie op de instantie voor API-aanroepen

:::tip
**Privacy:** uw API-sleutel en gespreksgegevens worden aan de clientzijde verwerkt. Toolaanroepen die met uw instantie werken, gebruiken de aanmeldgegevens van uw bestaande sessie.
:::

## LLM-endpoints {#adv-endpoints}

Modellen maken verbinding via **benoemde LLM-endpoints** — herbruikbare paren `URL + API key`. Zo kunt u AppAgent laten werken met **elke OpenAI-compatibele chat-completions-API**: OpenRouter, een lokale gateway, een proxy of uw eigen gehoste model.

1. Klik in [Instellingen → LLM-endpoints](app:openSettingsPageView) op **Endpoint toevoegen**
2. Geef het endpoint een naam, de API-URL en een API-sleutel
3. Elk model (API-provider) kiest een endpoint — werk een sleutel één keer bij en elk model dat deze gebruikt, wordt bijgewerkt

:::tip
Claude-providers met **OAuth** gebruiken geen endpoints — ze communiceren rechtstreeks met `api.anthropic.com`.
:::

## Aanmelden met Claude (OAuth) {#adv-oauth}

In plaats van een API-sleutel te plakken, kunt u zich bij Anthropic-providers aanmelden met uw bestaande claude.ai-sessie:

1. Voeg in [Instellingen → API-providers](app:openSettingsPageView) een Anthropic-provider toe of bewerk er een, en schakel **OAuth** in
2. De extensie gebruikt uw claude.ai-aanmelding in hetzelfde Chrome-profiel om rechtstreeks verbinding te maken met Anthropic
3. Geen extra aanmeldvenster en geen AppAgent-server ertussen

**Vereisten:**

- U moet bij `claude.ai` zijn aangemeld in hetzelfde Chrome-profiel
- Werkt met accounts met eenmalige aanmelding (SSO)

:::tip
OAuth-tokens worden automatisch vernieuwd. Mislukt het aanmelden, open dan `claude.ai` in hetzelfde profiel en meld u opnieuw aan.
:::

## Beveiligingsoverwegingen {#adv-security}

**Opslag van de API-sleutel:**

- Uw **API-sleutel wordt lokaal opgeslagen** in de IndexedDB van uw browser
- De sleutel wordt nooit naar uw instantie of naar een andere server dan de AI-provider verzonden
- Als u browsergegevens wist, wordt uw opgeslagen API-sleutel verwijderd

**Sessie en machtigingen:**

- De agent draait met uw **huidige gebruikerssessie** en neemt uw toegangsrechten en rollen over
- Alle API-aanroepen naar uw instantie gebruiken de aanmeldgegevens van uw sessie
- De agent heeft alleen toegang tot wat uw gebruikersaccount mag openen

**Uitvoeringsomgeving van tools:**

- **Browsercode (js_eval)** voert JavaScript uit in een **geïsoleerde sandbox** met alleen toegang tot `executeTool()`
- **Widgetscripts** draaien in **geïsoleerde iframes** met alleen toegang tot `executeTool()` voor API-aanroepen
- **Skill-tools** draaien in **geïsoleerde sandboxes** met alleen toegang tot `executeTool()`
- Alle API-toegang loopt via het **machtigingssysteem** met `executeTool("servicenow_api", {...})`
- De agent werkt met pagina's in **browsertabbladen** op uw ServiceNow-instantie

**Mogelijkheden om records te wijzigen:**

- De tool **ServiceNow API** ondersteunt de methoden POST, PATCH, PUT en DELETE, waarmee records kunnen worden gewijzigd
- De agent kan records aanmaken en bewerken via de **geïntegreerde browser** als hij machtigingen heeft voor de tools voor invullen en klikken
- Stel [Toolmachtigingen](app:openSettingsPageView) in om te bepalen welke bewerkingen goedkeuring vereisen

**Zelfverbetering:**

- De agent kan **zijn eigen skills beheren** — skills maken, bewerken en activeren
- Zo kan de agent in de loop van de tijd leren en zichzelf verbeteren
- Controleer wijzigingen in skills regelmatig om te zorgen dat ze aansluiten bij uw verwachtingen

## Gegevensopslag {#adv-data-storage}

AppAgent slaat gegevens lokaal in uw browser op met **IndexedDB**:

| Gegevenstype | Opslag | Beschrijving |
|-----------|---------|-------------|
| **Chats** | IndexedDB | De volledige gespreksgeschiedenis, berichten en toolresultaten |
| **Instellingen** | IndexedDB | Toolmachtigingen, API-sleutels, modelvoorkeuren |
| **Dashboardwidgets** | IndexedDB | HTML, titels, formaten en gespreksgeschiedenis van widgets |
| **Skills** | IndexedDB | Definities, inhoud en assets van skills |
| **API-providers** | IndexedDB | Configuraties en endpoints van aangepaste API-providers |
| **UI-status** | localStorage | Status van de zijbalk, huidige weergave, scrollposities |

**Uw gegevens downloaden:**

1. Ga naar [Instellingen](app:openSettingsPageView) → Gegevensbeheer
2. Klik op **Gegevens exporteren**
3. Er wordt een JSON-back-upbestand gedownload

**Uw gegevens verwijderen:**

1. Ga naar [Instellingen](app:openSettingsPageView) → Gegevensbeheer
2. Klik op **Alle gegevens verwijderen**
3. Bevestig twee keer om alles definitief te verwijderen

:::tip
**Belangrijk:** gegevens worden lokaal in de extensie opgeslagen. Als u browsergegevens wist, de extensie verwijdert of een ander browserprofiel gebruikt, krijgt u gescheiden gegevensopslag.
:::

# Over {#about}

**Versie:** v__VERSION__

**Licentie:** privé- en commercieel gebruik. Interne aanpassing toegestaan. Distributie en doorverkoop verboden. Alle rechten voorbehouden.

## Wijzigingslogboek {#changelog}

__CHANGELOG__
