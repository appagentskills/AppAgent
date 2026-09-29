# Kom godt i gang {#getting-started}

AppAgent er en AI-agent til ServiceNow, der kører som en Chrome-udvidelse. Beskriv, hvad du har brug for, med almindelige ord, og agenten forespørger data, redigerer poster, bygger apps og widgets, tester sider i din browser og rapporterer tilbage.

:::tip
**Hurtig start:** Konfigurer en model, åbn en fane på din ServiceNow-instans, skriv derefter en anmodning i chatten, og tryk på <kbd>Enter</kbd>.
:::

## Konfigurer en model {#guide-setup}

1. Åbn [Indstillinger](app:openSettingsPageView), og gå til **API-udbydere**
2. Tilføj en udbyder (Anthropic, OpenRouter eller en brugerdefineret OpenAI-kompatibel API) med din API-nøgle – eller slå **OAuth** til på en Anthropic-udbyder for at logge ind med din Claude-konto
3. Vælg den model, der skal bruges, under **Agentmodel**

Din API-nøgle gemmes kun i din browser. AI-kald går direkte fra din browser til udbyderen.

## Forbind dine instanser {#guide-instances}

AppAgent **registrerer automatisk alle ServiceNow-instanser**, du har åbne i den samme Chrome-profil – der er ingen forbindelsesstreng at indtaste. Log ind på en instans i en almindelig fane, så kan agenten arbejde på den med din brugers roller og adgangsrettigheder. Skriv *"list instances"* for at se alle registrerede instanser, dine roller og forbindelsesstatus.

Hver instans har et **tilladelsesniveau**, som du vælger i instansmenuen:

- **Manuel** – Du godkender hver skrivehandling (oprettelse, opdatering, sletning, udfyldning af formularer)
- **Auto** – Agenten beslutter selv om skrivehandlinger uden at spørge
- **Dev** – Ingen godkendelser overhovedet: alle værktøjskald på denne instans kører uden at spørge. Brug det kun på udviklingsinstanser

Læsning er altid tilladt. Se [Værktøjstilladelser](#feature-permissions) for mere detaljeret kontrol.

## Start en chat {#guide-chat}

1. Klik på **Ny chat** i sidepanelet [Start ny chat →](app:startNewChat)
2. Skriv din anmodning, for eksempel *"Vis mig alle incidents oprettet i dag"*
3. Tryk på <kbd>Enter</kbd> for at sende
4. Følg med, mens agenten arbejder: hvert værktøjskald vises i chatten, og der vises godkendelsesanmodninger, når et trin kræver dit OK

Du kan blive ved med at skrive, mens agenten arbejder: en ny besked afbryder det aktuelle trin, og **Pause** stopper kørslen.

## Vedhæft billeder og filer {#guide-images}

1. Klik på knappen **Vedhæft fil** i inputområdet for at tilføje et billede, en PDF, en CSV- eller tekstfil
2. Eller indsæt et billede fra udklipsholderen, eller træk og slip det i chatten
3. Skriv dit spørgsmål om den vedhæftede fil

:::tip
Vedhæft skærmbilleder af fejl, UI-mockups eller eksporterede data, så agenten kan se præcis det samme som dig.
:::

# Vigtigste funktioner {#features}

## Chat {#page-chat}

Hovedvisningen for samtaler. [Start ny chat →](app:startNewChat)

- **Beskedområde** – Samtalen, inklusive værktøjskald og deres resultater
- **Inputfelt** – Skriv beskeder, vedhæft filer, og send, mens agenten arbejder, for at afbryde den
- **Pause / Fortsæt / Prøv igen** – Stop agenten, genoptag den, eller prøv det seneste trin igen
- **Kontekstindikator** – Viser, hvor fyldt samtalen er; klik på den for at opsummere til en ny chat
- **Svarkort** – Et **Kort fortalt**-resumé og et **Links**-kort (poster, PR'er, dokumenter) kan vises under et svar
- **Chatoverskrift** – Omdøb eller fastgør chatten, eller åbn AppAgent i en hel browserfane med **Udvid til hel side**

## Browserstyring {#feature-browser}

Agenten kan åbne og styre browserfaner på din instans for at se og teste sider:

- **Naviger, klik, udfyld og vælg** – Realistiske hændelser, så formularer og autofuldførelsesfelter opfører sig, som om du selv skrev
- **Vent på** – Vent på et element, en tekst eller en URL i stedet for at gætte på ventetider
- **Skærmbilleder** – Tag et billede af siden, en widget eller et enkelt element til visuel kontrol
- **Inspicér** – Læs elementegenskaber, typografier, konsolfejl og netværksanmodninger
- **Efterlign bruger** – Test som en anden bruger, og skift derefter tilbage

## Rediger poster og versionshistorik {#feature-history}

Alle ændringer, agenten foretager på din instans, registreres i chattens sidepanel:

- **Fortryd** – Tilbagefør en enkelt ændring
- **Gentag** – Gendan en tilbageført ændring
- **Download XML** – Eksportér alle ændringer, for eksempel for at flytte dem til en anden instans

## Underagenter {#feature-subagents}

Til tungt eller parallelt arbejde kan agenten starte **underagenter**: baggrundsarbejdere, der kører i deres egen chat og kontekst og derefter rapporterer et kort resultat tilbage til hovedchatten.

- **Modelniveauer** – Hver underagent kører på niveauet **small**, **medium** eller **large**, eller **same** for at bruge den overordnede agents model. Tilknyt niveauer til modeller under [Indstillinger](app:openSettingsPageView) → **Modelniveauer for underagenter**
- **Arbejderbjælke** – Kørende underagenter vises som live-chips over chatinputtet; åbn en for at følge dens fremskridt eller læse dens udskrift
- **Pulje** – Antallet af samtidige underagenter er begrænset; ekstra underagenter venter i en kø

## Dashboard og widgets {#page-dashboard}

Et dashboard med interaktive widgets genereret af agenten. [Åbn dashboard →](app:openDashboardView)

1. Klik på **Tilføj widget**
2. Beskriv, hvad du ønsker, for eksempel *"Et diagram, der viser åbne incidents efter prioritet"*
3. Agenten bygger widgetten; bed om ændringer, eller klik på **Generér igen** når som helst

Widgets kan hente live-data fra din instans, så de altid er opdaterede. Træk, tilpas størrelse, importér og eksportér dem (se [Avanceret](#advanced)). Widgets, som agenten viser direkte i en chat, kan gemmes med **Fastgør til Dashboard**.

## Smarte dokumenter {#page-documents}

**Smarte dokumenter** er vedvarende Markdown-dokumenter med versioner, som agenten skriver og opdaterer – planer, rapporter, specifikationer, resultater. De vises direkte i chatten, gemmer alle versioner og kan redigeres direkte af dig. Åbn dem fra **Dokumenter** i sidepanelet. [Åbn dokumenter →](app:openDocumentsView)

## Færdigheder {#page-skills}

Færdigheder giver agenten ekstra viden og værktøjer. [Åbn færdigheder →](app:openSkillsView)

- **Aktivér / Deaktivér** – Slå færdigheder til eller fra; deaktivér dem, du ikke har brug for, så svarene holder fokus
- **Ny færdighed** – Skriv din egen færdighed i Markdown, eller brug **Rediger med agent**
- **Importér / Eksportér** – Del færdigheder som mapper
- **Færdighedshandlinger** – Nogle færdigheder tilføjer knapper på startsiden, der med ét klik starter et forudindstillet workflow

En færdighed kan levere **viden** (instruktioner, bedste praksis) og **brugerdefinerede værktøjer** (JavaScript-funktioner, der kører i en isoleret sandbox).

## Arbejdsområde og GitHub {#feature-workspace}

Hver chat har et **arbejdsområde** – et filområde, hvor agenten kan læse, skrive, redigere og sammenligne filer.

- **GitHub** – Forbind en GitHub-konto under [Indstillinger](app:openSettingsPageView) for at klone repositories ind i et arbejdsområde. Agenten kan oprette branches, pushe commits og åbne pull requests direkte fra chatten
- **Pull requests** – PR'er, der er åbnet fra en chat, vises i chattens sidepanel med knappen **Flet**
- **Beskyttelse mellem chats** – Hver fil husker, hvilken chat der ændrede den, så to chats, der arbejder parallelt, ikke i det stille overskriver hinandens arbejde
- **Automatisk synkronisering** – Klonede arbejdsområder synkroniseres med GitHub, når du navigerer, skifter chat eller vender tilbage til fanen

## Chattens sidepanel {#feature-sidebar}

Sidepanelet til højre samler alt, hvad den aktuelle chat har produceret:

- **Pull requests** – Titel, målbranch og knappen **Flet**
- **Filer i arbejdsområdet** – Åbn en fil for at se den, se dens diff eller gennemse tidligere versioner
- **Versionshistorik** – Ændringer på instansen med **Fortryd**, **Gentag** og **Download XML**
- **Arbejdere** – Kørende og afsluttede underagenter med tællere for værktøjskald, redigerede filer og åbnede PR'er

## Handlinger og live-fremskridt {#feature-actions}

Lange opgaver viser live-fremskridt i stedet for at gå i stå i stilhed:

- **Fremskridtskort** – Et enkelt kort med en farvet status (kører, sidder fast, færdig, fejl) og en liste over trin
- **Handlingsknapper** – Knapper, der med ét klik starter opfølgende workflows
- **Kørselsindikator** – Chatlisten markerer chats, hvor agenten arbejder
- **Notifikationen "Agenten er færdig"** – Hvis du skifter fane eller vindue under en kørsel, får du en skrivebordsnotifikation, når agenten er færdig

## Aktive chats og job {#feature-jobs}

Jobknappen i overskriften åbner en live-visning af dine chats og dit baggrundsarbejde:

- **Aktive chats** – Kørende chats og chats med ulæste resultater (vist med **fed**), hver med en ring, der viser kontekstforbruget
- **Underagenter** – Vises under deres overordnede chat; åbn en for at læse dens udskrift
- **Udvid** – Åbn listen som et større panel med et layout i kolonner eller sektioner

## Værktøjstilladelser {#feature-permissions}

Ud over tilladelsesniveauet pr. instans (**Manuel**, **Auto**, **Dev**) har hvert værktøj sin egen indstilling under [Indstillinger](app:openSettingsPageView) → **Værktøjstilladelser**:

- **Tillad** – Værktøjet kører altid uden at spørge
- **Auto** – Værktøjet kører uden at spørge, medmindre agenten markerer et kald som noget, der kræver din bekræftelse
- **Spørg** – Du får en godkendelsesanmodning før hvert kald
- **Fra** – Agenten kan ikke bruge værktøjet

Nogle værktøjer har mere detaljerede indstillinger: ServiceNow API pr. HTTP-metode (GET, POST, PUT, PATCH, DELETE), browserstyring pr. handling (naviger, klik, udfyld, efterlign bruger…) og administration af færdigheder pr. handling. Bekræftelsesdialoger er farvekodet efter risiko: **blå** (rutine), **orange** (forsigtighed), **rød** (destruktiv).

:::tip
Hold DELETE og andre destruktive handlinger på **Spørg**, og brug kun **Dev** på udviklingsinstanser.
:::

## Agentens værktøjer {#feature-tools}

De vigtigste værktøjer, som agenten bruger:

| Værktøj | Hvad det gør |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Læs, opret, opdater og slet poster |
| **Baggrundsscript** (`servicenow_run_script`) | Kør et script på serversiden af instansen (kræver admin-rollen) |
| **Scriptredigering** (`servicenow_diff_edit`) | Ændr scripts med præcise søg-og-erstat-redigeringer |
| **Browserstyring** (`iframe_tool`) | Naviger, klik, udfyld, inspicér og efterlign brugere i browserfaner |
| **Browserkode** (`js_eval`) | Kør JavaScript i en isoleret sandbox, der kan kalde andre værktøjer |
| **Skærmbilleder** (`take_screenshot`) | Tag et billede af siden, en widget eller et element |
| **Widgets og kort** (`html_widget`, `display`) | Vis interaktive widgets, tabeller, kort og tidslinjer i chatten |
| **Smarte dokumenter** (`document`) | Opret og opdater vedvarende Markdown-dokumenter |
| **Spørg brugeren** (`prompt_user`) | Beder dig om input via en formular direkte i chatten |
| **Underagenter** (`spawn_sub_agent`) | Uddeleger arbejde til baggrundsarbejdere |
| **Arbejdsområde** (`workspace`) | Arbejd med filer og GitHub-repositories |
| **Webhentning** (`web_fetch`) | Læs sider fra det offentlige web |
| **Færdigheder** (`get_skill`, `manage_skill`) | Læs og administrer færdigheder |

Åbn [Indstillinger](app:openSettingsPageView) → **Værktøjstilladelser** for at se alle værktøjer, deres kilde og deres tilladelse.

## Caching af stort indhold {#feature-caching}

Når et værktøjsresultat er for stort til samtalen (som standard mere end 4K tokens), cacher AppAgent det. Agenten modtager en oversigt og læser, søger i eller gennemser derefter kun de dele, den har brug for. Det holder chats hurtige og fokuserede. Du kan ændre grænsen (1K til 100K tokens) under [Indstillinger](app:openSettingsPageView) → **Caching af stort indhold**.

## Kontekstindikator {#feature-saturation}

**Kontekstindikatoren** ved siden af chatinputtet viser, hvor fyldt samtalen er. Over 50 % bliver agenten bedt om at runde af og overlade resterende tungt arbejde til underagenter; ved 100 % stopper den og rapporterer. Klik på indikatoren når som helst for at opsummere samtalen i en ny chat.

## Forbrug og hastighedsbegrænsninger {#feature-usage}

- **Forbrugsknap** – Overskriften viser dit API-forbrug og dine resterende grænser; klik på den for at se detaljer
- **Automatiske genforsøg** – Når udbyderen begrænser hastigheden eller er overbelastet (HTTP 429 / 529), venter AppAgent og prøver automatisk igen og viser en nedtælling i chatten
- **Ingen kreditter tilbage** – Når en 429 faktisk betyder, at dine kreditter er opbrugt, siger chatten det tydeligt

## Sprog {#feature-languages}

Brugerfladen findes på engelsk plus 24 sprog: arabisk, kinesisk (forenklet, traditionelt), tjekkisk, dansk, nederlandsk, finsk, fransk (Frankrig, Canada), tysk, hebraisk, ungarsk, italiensk, japansk, koreansk, norsk, polsk, portugisisk (Brasilien, Portugal), russisk, spansk, svensk, thai og tyrkisk.

Vælg et under [Indstillinger](app:openSettingsPageView) → **Sprog** eller i menuen med hurtige indstillinger i overskriften. **Auto** følger din browsers sprog og falder tilbage til engelsk. Ændringen træder i kraft med det samme uden genindlæsning.

- **Højre mod venstre** – Arabisk og hebraisk bruger et layout fra højre mod venstre
- **Lokale formater** – Datoer, klokkeslæt og tal følger dit sprog
- **Agentens svar** – Agenten svarer på det valgte sprog, medmindre du skriver på et andet. Kode samt tabel- og feltnavne forbliver uændrede
- **Denne hjælpeside** – Vises på dit sprog; ændringsloggen forbliver på engelsk

# Sider og indstillinger {#pages}

## Indstillinger {#page-settings}

[Åbn indstillinger →](app:openSettingsPageView)

- **Agentmodel** – Den model, agenten bruger
- **API-udbydere** – Anthropic, OpenRouter eller brugerdefinerede udbydere med en API-nøgle eller OAuth
- **LLM-endpoints** – Navngivne `URL + API key`-par til enhver OpenAI-kompatibel API
- **Modelniveauer for underagenter** – Tilknyt niveauerne small, medium og large til modeller, eller **Samme**
- **Ræsonnementsindsats, Maks. tokens og Tænkebudget** – Justér svarenes dybde og længde
- **Kontekstvindue** – Den kontekststørrelse, som kontekstindikatoren bruger
- **Visning** – API-statistik, kompakt tilstand, hold skærmen tændt
- **Sprog** – Brugerfladens sprog, eller **Auto**
- **Hooks** – Automatiske chattitler, notifikationer om "Agenten er færdig" og anden automatisering
- **Caching af stort indhold** – Hvornår store resultater caches
- **Værktøjstilladelser** – Hvad der kører automatisk, spørger først eller er slået fra
- **GitHub** – Forbind en GitHub-konto, og administrer klonede repositories
- **Systemprompt** – Tilpas agentens instruktioner
- **Datahåndtering** – Eksportér, importér eller slet dine data

## Historik {#page-history}

Alle dine samtaler. [Åbn historik →](app:openHistoryView)

- **Søg** – Find chats efter titel, indhold, anvendte værktøjer eller widgets
- **Fastgør** – Hold vigtige chats øverst
- **Eksportér** – Download én chat eller hele din historik
- **Statistik** – Antal chats, fastgjorte chats og samlede omkostninger

## Hjælp {#page-docs}

Denne side. [Åbn hjælp →](app:openDocsView)

- **Søg** – Filtrér hjælpeemnerne fra søgefeltet i værktøjslinjen
- **Indhold** – Hop til et afsnit fra oversigten
- **Download** – Gem dokumentationen som en Markdown-fil

# Tips og tastaturgenveje {#tips}

| Handling | Sådan gør du |
|--------|-----|
| Send besked | <kbd>Enter</kbd> |
| Ny linje | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Søg i chats | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> på Mac) |
| Luk en dialog eller menu | <kbd>Esc</kbd> |
| Gå tilbage | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Vedhæft et billede | Indsæt det, eller træk og slip det i chatten |
| Start forfra med et resumé | Klik på kontekstindikatoren |
| Afbryd agenten | Send en ny besked, eller klik på **Pause** |

:::tip
**Vær præcis.** I stedet for *"ret det her"* kan du sige *"ret null reference-fejlen på linje 42 i script include'en MyUtils"*. Nævn tabellen, posten eller siden, når du kan.
:::

- **Ét mål pr. chat** – Start en ny chat til en opgave, der ikke hænger sammen med den forrige; så forbliver agenten hurtigere og mere præcis
- **Lad den teste** – Bed agenten om at åbne siden og kontrollere sin egen ændring med et skærmbillede
- **Brug færdigheder** – Aktivér en færdighed, der passer til din opgave (for eksempel test eller revision), før du går i gang

# Fejlfinding og ofte stillede spørgsmål {#faq}

### Agenten kan ikke se min instans

Åbn instansen i en fane i den samme Chrome-profil, og sørg for, at du er logget ind, og skriv derefter *"list instances"*. Hvis den stadig ikke vises, skal du genindlæse fanen med instansen.

### Jeg får en API- eller godkendelsesfejl

Kontrollér din udbyder under [Indstillinger](app:openSettingsPageView) → **API-udbydere**: API-nøglen, det valgte endpoint og modelnavnet. Ved OAuth skal du logge ind på claude.ai igen i den samme Chrome-profil.

### Agenten siger, at hastigheden er begrænset

AppAgent prøver automatisk igen og viser en nedtælling. Hvis det bliver ved med at ske, kan du tjekke forbrugsknappen for resterende kreditter eller bruge et mindre modelniveau til underagenter.

### For mange godkendelsesanmodninger – eller for få

Skift instansens tilladelsesniveau (**Manuel**, **Auto**, **Dev**) i instansmenuen, og justér de enkelte værktøjer under [Indstillinger](app:openSettingsPageView) → **Værktøjstilladelser**.

### Svarene bliver langsommere eller mindre præcise i en lang chat

Samtalen er ved at fylde sin kontekst op. Klik på kontekstindikatoren for at fortsætte i en ny chat med et resumé.

### Hvordan fortryder jeg en ændring?

Åbn chattens sidepanel, og klik på **Fortryd** ud for ændringen i versionshistorikken. **Download XML** eksporterer alle ændringer.

### Hvor gemmes mine data?

Lokalt i din browser (IndexedDB). Chats sendes aldrig til en AppAgent-server – kun til din AI-udbyder og din ServiceNow-instans. Se [Datalagring](#adv-data-storage).

### Brugerfladen eller denne side er på det forkerte sprog

Vælg sproget under [Indstillinger](app:openSettingsPageView) → **Sprog**. **Auto** følger din browsers sprog.

# Avanceret {#advanced}

Dette afsnit dækker avancerede funktioner, knapper i overskrifter, import-/eksportformater og tekniske detaljer om, hvordan AppAgent fungerer.

## Knapper i dashboardets overskrift {#adv-dashboard-header}

Dashboardets overskrift indeholder flere handlingsknapper:

| Knap | Beskrivelse |
|--------|-------------|
| **Vis/skjul sidepanel** | Vis eller skjul navigationen i venstre sidepanel |
| **Åbn separat** | Åbn dashboardet i en ny browserfane for at se det separat |
| **Overskrifter** | Slå visningen af widgetoverskrifter på dashboardet til eller fra. Når de er skjult, vises widgets i en mere enkel visning |
| **Generér alle igen** | Generér alle widgets på dashboardet igen med agenten. Nyttigt til at opdatere data |
| **Importér** | Importér et dashboard eller en widget fra en JSON-fil |
| **Eksportér** | Eksportér hele dashboardet til en JSON-fil til sikkerhedskopiering eller deling |
| **Tilføj widget** | Åbner widgeteditoren for at oprette en ny widget med hjælp fra agenten |

## Knapper i widgetoverskrifter {#adv-widget-headers}

**Overskrifter på dashboardwidgets** (synlige, når Overskrifter er slået til):

| Knap | Beskrivelse |
|--------|-------------|
| **Trækhåndtag** | Widgetikonet fungerer som trækhåndtag til at ændre widgets rækkefølge |
| **Generér igen** | Bed agenten om at generere indholdet i denne widget igen |
| **Historik** | Se tidligere versioner af denne widget (hvis de findes) |
| **Fuld skærm** | Udvid widgetten til fuld skærm |
| **Rediger** | Åbn widgeteditoren for at ændre den via chat med agenten |
| **Slet** | Fjern widgetten fra dashboardet (med bekræftelse) |

**Overskrifter på chatwidgets** (widgets direkte i chatten):

| Knap | Beskrivelse |
|--------|-------------|
| **Fastgør til Dashboard** | Gem denne widget på dit dashboard |
| **Rediger kode** | Se og rediger widgettens HTML/CSS/JS-kode direkte |
| **Udvid/skjul** | Vis eller skjul widgettens indhold |

## Tilpas størrelse på og flyt widgets {#adv-resize-move}

**Tilpas størrelse på widgets:**

- Hver widget har et **størrelseshåndtag** i nederste højre hjørne
- Klik og træk i håndtaget for at ændre widgettens størrelse
- Bredden tilpasses et gitter med 12 kolonner (mindst 3 kolonner)
- Højden måles i enheder á 50px (mindst 2 enheder = 100px)

**Flyt widgets:**

- Slå **Overskrifter** til for at vise widgetoverskrifter
- Klik og træk i **widgetikonet** (trækhåndtaget) for at ændre rækkefølgen
- Slip widgetten på en anden widget for at bytte plads
- Widgetrækkefølgen gemmes automatisk

## Import-/eksportformater {#adv-import-export}

**Dashboardeksport** (`dashboard-YYYY-MM-DD.json`):

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

**Eksport af en enkelt widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Eksport af en enkelt chat** (`chat-title-YYYY-MM-DD.json`):

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

Chateksporter bevarer hele samtalehistorikken, inklusive alle brugerbeskeder og agentens svar. Brug chattens rullemenu (···), og vælg **Download** for at eksportere enkelte chats.

**Eksport af færdigheder** (mappestruktur):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Bemærk:** Import/eksport af færdigheder bruger File System Access API og **virker kun i Chrome eller Edge**.
:::

**Eksport af alle data** (`appagent-backup-YYYY-MM-DD.json`):

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

Den fulde sikkerhedskopi omfatter al chathistorik, indstillinger, værktøjstilladelser, dashboardwidgets og konfigurationer af API-udbydere.

## API-statistik {#adv-api-stats}

Når det er slået til i Indstillinger, vises API-statistik efter hvert svar fra agenten:

| Måling | Beskrivelse |
|--------|-------------|
| **Ind** | Inputtokens – størrelsen på den prompt, der sendes til agenten |
| **Ud** | Outputtokens – størrelsen på agentens svar |
| **I alt** | Input- og outputtokens tilsammen |
| **Cache læst/skrevet** | Tokens læst fra eller skrevet til promptcachen (reducerer omkostningerne) |
| **Ræsonnement** | Tokens brugt til intern ræsonnering (visse modeller) |
| **Omkostning** | Anslåede omkostninger for API-kaldet i USD |
| **Varighed** | Den tid, API-kaldet tog |

Ved samtaler med flere runder viser den samlede statistik totalen for alle kald.

:::tip
Slå visning af API-statistik til eller fra under [Indstillinger](app:openSettingsPageView) → Visning → Vis API-statistik.
:::

## Manuel redigering af færdigheder {#adv-skills-manual}

Færdigheder kan oprettes og redigeres manuelt eller med hjælp fra agenten:

**Opret en færdighed manuelt:**

1. Gå til [Færdigheder](app:openSkillsView), og klik på **Ny færdighed**
2. Angiv et navn og en beskrivelse til færdigheden
3. Skriv færdighedens indhold i Markdown-format
4. Klik på **Gem** for at oprette færdigheden

**SKILL.md-format:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Rediger med agenten:**

1. Klik på **Rediger med agent** på en vilkårlig færdighed
2. Beskriv, hvilke ændringer du ønsker
3. Agenten ændrer færdighedens indhold
4. Gennemse og gem ændringerne

**Færdighedsaktiver:** Færdigheder kan indeholde ekstra filer (XML, JS, MD), der giver agenten yderligere kontekst eller kode.

## Systemprompt {#adv-system-prompt}

Systemprompten definerer agentens adfærd og muligheder. Du kan tilpasse den under [Indstillinger](app:openSettingsPageView).

**Rediger systemprompten:**

1. Gå til Indstillinger → afsnittet Systemprompt
2. Klik på **Rediger** for at skifte til redigeringstilstand
3. Tilpas skabelonen efter behov
4. Klik på **Gem** for at anvende ændringerne

**Tilgængelige pladsholdere:**

| Pladsholder | Beskrivelse |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Dagens dato (ugedag, måned, dag, år) |
| `{{ORCHESTRATOR_POLICY}}` | Politik for uddelegering til underagenter – medtages i hovedchats og efterlades tom i underagentchats |
| `{{DISABLED_TOOLS}}` | Liste over deaktiverede værktøjer |
| `{{TOOL_CATALOG}}` | Katalog over udskudte værktøjer (tomt, når udskudt indlæsning af værktøjer er slået fra) |
| `{{SKILLS_SUMMARY}}` | Indholdet af aktive færdigheder |

Pladsholdere erstattes automatisk med de faktiske værdier, når der sendes til AI'en. Visningen af tokenantal viser både skabelonens størrelse og den udfoldede størrelse.

:::tip
Klik på **Gendan standard** for at gendanne den oprindelige systemprompt, hvis det er nødvendigt.
:::

## Agentens API-kald {#adv-agent-api}

AppAgent kører som en **Chrome-udvidelse**:

- AI API-kald går **direkte fra din browser til AI-udbyderen** (f.eks. Anthropic, OpenRouter)
- De går **ikke** gennem din instans eller nogen AppAgent-server
- Din API-nøgle (eller dit OAuth-token) gemmes lokalt i din browser
- Samtaledata sendes til AI-udbyderen til behandling

**Sådan fungerer det:**

1. Du skriver en besked i chatten
2. AppAgent bygger en prompt med systeminstruktioner, værktøjer og samtalehistorik
3. Prompten sendes til AI-udbyderens API
4. Agentens svar streames tilbage til din browser
5. Værktøjskald udføres i din browser og bruger din instanssession til API-kald

:::tip
**Privatliv:** Din API-nøgle og dine samtaledata håndteres på klientsiden. Værktøjskald, der interagerer med din instans, bruger dine eksisterende sessionsoplysninger.
:::

## LLM-endpoints {#adv-endpoints}

Modeller forbindes via **navngivne LLM-endpoints** – genanvendelige `URL + API key`-par. Det giver dig mulighed for at pege AppAgent mod **enhver OpenAI-kompatibel chat-completions-API**: OpenRouter, en lokal gateway, en proxy eller din egen hostede model.

1. Under [Indstillinger → LLM-endpoints](app:openSettingsPageView) skal du klikke på **Tilføj endpoint**
2. Giv det et navn, API-URL'en og en API-nøgle
3. Hver model (API-udbyder) vælger et endpoint – opdater en nøgle én gang, så opdateres alle modeller, der bruger den

:::tip
Claude-udbydere med **OAuth** bruger ikke endpoints – de kommunikerer direkte med `api.anthropic.com`.
:::

## Log ind med Claude (OAuth) {#adv-oauth}

I stedet for at indsætte en API-nøgle kan du logge ind på Anthropic-udbydere med din eksisterende claude.ai-session:

1. Under [Indstillinger → API-udbydere](app:openSettingsPageView) skal du tilføje eller redigere en Anthropic-udbyder og slå **OAuth** til
2. Udvidelsen bruger dit claude.ai-login fra den samme Chrome-profil til at oprette direkte forbindelse til Anthropic
3. Intet ekstra loginvindue og ingen AppAgent-server imellem

**Krav:**

- Du skal være logget ind på `claude.ai` i den samme Chrome-profil
- Virker med konti med single sign-on (SSO)

:::tip
OAuth-tokens fornyes automatisk. Hvis login mislykkes, skal du åbne `claude.ai` i den samme profil og logge ind igen.
:::

## Sikkerhedshensyn {#adv-security}

**Opbevaring af API-nøgle:**

- Din **API-nøgle gemmes lokalt** i din browsers IndexedDB
- Nøglen sendes aldrig til din instans eller til nogen anden server end AI-udbyderen
- Hvis du rydder browserdata, fjernes din gemte API-nøgle

**Session og tilladelser:**

- Agenten kører med din **aktuelle brugersession** og arver dine adgangsrettigheder og roller
- Alle API-kald til din instans bruger dine sessionsoplysninger
- Agenten kan kun få adgang til det, din brugerkonto har adgang til

**Miljø til udførelse af værktøjer:**

- **Browserkode (js_eval)** kører JavaScript i en **isoleret sandbox** med kun adgang til `executeTool()`
- **Widgetscripts** kører i **isolerede iframes** med kun adgang til `executeTool()` til API-kald
- **Færdighedsværktøjer** kører i **isolerede sandboxe** med kun adgang til `executeTool()`
- Al API-adgang går gennem **tilladelsessystemet** via `executeTool("servicenow_api", {...})`
- Agenten interagerer med sider i **browserfaner** på din ServiceNow-instans

**Muligheder for at ændre poster:**

- Værktøjet **ServiceNow API** understøtter metoderne POST, PATCH, PUT og DELETE, som kan ændre poster
- Agenten kan oprette og redigere poster via den **integrerede browser**, hvis den har tilladelse til værktøjerne til udfyldning og klik
- Konfigurer [Værktøjstilladelser](app:openSettingsPageView) for at styre, hvilke handlinger der kræver godkendelse

**Selvforbedring:**

- Agenten kan **administrere sine egne færdigheder** – oprette, redigere og aktivere færdigheder
- Det gør det muligt for agenten at lære og forbedre sig selv over tid
- Gennemgå ændringer i færdigheder med jævne mellemrum for at sikre, at de stemmer overens med dine forventninger

## Datalagring {#adv-data-storage}

AppAgent gemmer data lokalt i din browser ved hjælp af **IndexedDB**:

| Datatype | Lagring | Beskrivelse |
|-----------|---------|-------------|
| **Chats** | IndexedDB | Al samtalehistorik, beskeder og værktøjsresultater |
| **Indstillinger** | IndexedDB | Værktøjstilladelser, API-nøgler, modelpræferencer |
| **Dashboardwidgets** | IndexedDB | Widget-HTML, titler, størrelser og samtalehistorik |
| **Færdigheder** | IndexedDB | Definitioner, indhold og aktiver for færdigheder |
| **API-udbydere** | IndexedDB | Konfigurationer og endpoints for brugerdefinerede API-udbydere |
| **UI-tilstand** | localStorage | Sidepanelets tilstand, aktuel visning, rullepositioner |

**Download dine data:**

1. Gå til [Indstillinger](app:openSettingsPageView) → Datahåndtering
2. Klik på **Eksportér data**
3. En JSON-sikkerhedskopi downloades

**Slet dine data:**

1. Gå til [Indstillinger](app:openSettingsPageView) → Datahåndtering
2. Klik på **Slet alle data**
3. Bekræft to gange for at slette alt permanent

:::tip
**Vigtigt:** Data gemmes lokalt i udvidelsen. Hvis du rydder browserdata, afinstallerer udvidelsen eller bruger en anden browserprofil, får du separate datalagre.
:::

# Om {#about}

**Version:** v__VERSION__

**Licens:** Privat og kommerciel brug. Intern ændring tilladt. Distribution og videresalg forbudt. Alle rettigheder forbeholdes.

## Ændringslog {#changelog}

__CHANGELOG__
