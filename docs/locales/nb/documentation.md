# Kom i gang {#getting-started}

AppAgent er en AI-agent for ServiceNow som kjører som en Chrome-utvidelse. Beskriv hva du trenger med vanlige ord, så søker agenten i data, redigerer poster, bygger apper og widgeter, tester sider i nettleseren din og rapporterer tilbake.

:::tip
**Hurtigstart:** Sett opp en modell, åpne en fane med ServiceNow-instansen din, skriv deretter en forespørsel i chatten og trykk <kbd>Enter</kbd>.
:::

## Sett opp en modell {#guide-setup}

1. Åpne [Innstillinger](app:openSettingsPageView) og gå til **API-leverandører**
2. Legg til en leverandør (Anthropic, OpenRouter eller et egendefinert OpenAI-kompatibelt API) med API-nøkkelen din – eller aktiver **OAuth** på en Anthropic-leverandør for å logge på med Claude-kontoen din
3. Velg modellen som skal brukes, under **Agentmodell**

API-nøkkelen din lagres bare i nettleseren din. AI-kall går direkte fra nettleseren din til leverandøren.

## Koble til instansene dine {#guide-instances}

AppAgent **oppdager automatisk alle ServiceNow-instanser** du har åpne i den samme Chrome-profilen – du trenger ikke å oppgi noen tilkoblingsstreng. Logg på en instans i en vanlig fane, så kan agenten jobbe på den med rollene og tilgangsrettighetene til brukeren din. Skriv *«list instances»* for å se alle oppdagede instanser, rollene dine og tilkoblingsstatusen.

Hver instans har et **tillatelsesnivå**, som du velger i instansmenyen:

- **Manuell** – Du godkjenner hver skriveoperasjon (opprette, oppdatere, slette, fylle ut skjemaer)
- **Auto** – Agenten avgjør skriveoperasjoner uten å spørre
- **Dev** – Ingen godkjenninger i det hele tatt: hvert verktøykall på denne instansen kjøres uten å spørre. Bruk det bare på utviklingsinstanser

Lesing er alltid tillatt. Se [Verktøytillatelser](#feature-permissions) for mer detaljert kontroll.

## Start en chat {#guide-chat}

1. Klikk **Ny chat** i sidepanelet [Start ny chat →](app:startNewChat)
2. Skriv forespørselen din, for eksempel *«Vis meg alle hendelser som ble opprettet i dag»*
3. Trykk <kbd>Enter</kbd> for å sende
4. Følg med mens agenten jobber: hvert verktøykall vises i chatten, og godkjenningsforespørsler dukker opp når et trinn trenger din godkjenning

Du kan fortsette å skrive mens agenten jobber: en ny melding avbryter det gjeldende trinnet, og **Pause** stopper kjøringen.

## Legg ved bilder og filer {#guide-images}

1. Klikk på knappen **Legg ved fil** i inndataområdet for å legge til et bilde, en PDF, en CSV-fil eller en tekstfil
2. Eller lim inn et bilde fra utklippstavlen, eller dra og slipp det i chatten
3. Skriv spørsmålet ditt om vedlegget

:::tip
Legg ved skjermbilder av feil, UI-skisser eller eksporterte data, så ser agenten nøyaktig det du ser.
:::

# Hovedfunksjoner {#features}

## Chat {#page-chat}

Hovedvisningen for samtaler. [Start ny chat →](app:startNewChat)

- **Meldingsområde** – Samtalen, inkludert verktøykall og resultatene av dem
- **Inndatafelt** – Skriv meldinger, legg ved filer, og send mens agenten jobber for å avbryte den
- **Pause / Fortsett / Prøv igjen** – Stopp agenten, la den fortsette, eller prøv siste trinn på nytt
- **Kontekstindikator** – Viser hvor full samtalen er; klikk på den for å oppsummere til en ny chat
- **Svarkort** – Et **Kort fortalt**-sammendrag og et **Lenker**-kort (poster, PR-er, dokumenter) kan vises under et svar
- **Chatoverskrift** – Gi chatten nytt navn eller fest den, eller åpne AppAgent i en hel nettleserfane med **Utvid til helside**

## Nettleserstyring {#feature-browser}

Agenten kan åpne og styre nettleserfaner på instansen din for å se og teste sider:

- **Navigere, klikke, fylle ut og velge** – Realistiske hendelser, så skjemaer og autofullføringsfelt oppfører seg som om du skrev selv
- **Vente på** – Vent på et element, en tekst eller en URL i stedet for å gjette på ventetider
- **Skjermbilder** – Ta bilde av siden, en widget eller ett enkelt element for visuelle kontroller
- **Inspisere** – Les elementegenskaper, stiler, konsollfeil og nettverksforespørsler
- **Etterligne** – Test som en annen bruker, og bytt deretter tilbake

## Rediger poster og versjonshistorikk {#feature-history}

Hver endring agenten gjør på instansen din, spores i sidepanelet i chatten:

- **Angre** – Tilbakestill en enkelt endring
- **Gjør om** – Gjenopprett en endring som ble angret
- **Last ned XML** – Eksporter alle endringer, for eksempel for å flytte dem til en annen instans

## Underagenter {#feature-subagents}

For tungt eller parallelt arbeid kan agenten starte **underagenter**: arbeidere i bakgrunnen som kjører i sin egen chat og kontekst, og deretter rapporterer et kort resultat tilbake til hovedchatten.

- **Modellnivåer** – Hver underagent kjører på nivået **small**, **medium** eller **large**, eller **same** for å bruke modellen til overordnet agent. Knytt nivåene til modeller under [Innstillinger](app:openSettingsPageView) → **Modellnivåer for underagenter**
- **Arbeiderstripe** – Underagenter som kjører, vises som levende brikker over inndatafeltet i chatten; åpne en for å følge fremdriften eller lese samtaleloggen
- **Utvalg** – Antallet underagenter som kan kjøre samtidig, er begrenset; de øvrige venter i kø

## Dashbord og widgeter {#page-dashboard}

Et dashbord med interaktive widgeter laget av agenten. [Åpne dashbord →](app:openDashboardView)

1. Klikk **Legg til widget**
2. Beskriv hva du vil ha, for eksempel *«Et diagram som viser åpne hendelser etter prioritet»*
3. Agenten bygger widgeten; be om endringer eller klikk **Generer på nytt** når som helst

Widgeter kan hente levende data fra instansen din, så de holder seg oppdatert. Dra, endre størrelse på, importer og eksporter dem (se [Avansert](#advanced)). Widgeter som agenten viser direkte i en chat, kan lagres med **Fest til Dashbord**.

## Smarte dokumenter {#page-documents}

**Smarte dokumenter** er varige Markdown-dokumenter med versjoner som agenten skriver og oppdaterer – planer, rapporter, spesifikasjoner, funn. De vises direkte i chatten, tar vare på alle versjoner og kan redigeres direkte av deg. Åpne dem fra **Dokumenter** i sidepanelet. [Åpne dokumenter →](app:openDocumentsView)

## Ferdigheter {#page-skills}

Ferdigheter gir agenten ekstra kunnskap og verktøy. [Åpne ferdigheter →](app:openSkillsView)

- **Aktiver / Deaktiver** – Slå ferdigheter av eller på; deaktiver dem du ikke trenger, så holder svarene seg fokuserte
- **Ny ferdighet** – Skriv din egen ferdighet i Markdown, eller bruk **Rediger med agent**
- **Importer / Eksporter** – Del ferdigheter som mapper
- **Ferdighetshandlinger** – Noen ferdigheter legger til ettklikksknapper på startsiden som starter en forhåndsdefinert arbeidsflyt

En ferdighet kan tilby **kunnskap** (instruksjoner, beste praksis) og **egendefinerte verktøy** (JavaScript-funksjoner som kjører i en isolert sandkasse).

## Arbeidsområde og GitHub {#feature-workspace}

Hver chat har et **arbeidsområde** – et filområde der agenten kan lese, skrive, redigere og sammenligne filer.

- **GitHub** – Koble til en GitHub-konto under [Innstillinger](app:openSettingsPageView) for å klone repoer til et arbeidsområde. Agenten kan opprette grener, pushe commits og åpne pull requests fra chatten
- **Pull requests** – PR-er som åpnes fra en chat, vises i sidepanelet i chatten med en **Flett**-knapp
- **Beskyttelse mellom chatter** – Hver fil husker hvilken chat som endret den, så to chatter som jobber parallelt, ikke overskriver hverandres arbeid i det stille
- **Automatisk synkronisering** – Klonede arbeidsområder synkroniseres med GitHub når du navigerer, bytter chat eller går tilbake til fanen

## Sidepanelet i chatten {#feature-sidebar}

Sidepanelet til høyre samler alt den gjeldende chatten har produsert:

- **Pull requests** – Tittel, målgren og en **Flett**-knapp
- **Filer i arbeidsområdet** – Åpne en fil for å se den, se diff-en eller bla gjennom tidligere versjoner
- **Versjonshistorikk** – Endringer på instansen med **Angre**, **Gjør om** og **Last ned XML**
- **Arbeidere** – Underagenter som kjører og som er ferdige, med tellere for verktøykall, redigerte filer og åpnede PR-er

## Handlinger og fremdrift i sanntid {#feature-actions}

Lange oppgaver viser fremdrift i sanntid i stedet for å bli stille:

- **Fremdriftskort** – Ett enkelt kort med fargekodet tilstand (kjører, står fast, ferdig, feil) og en liste over trinn
- **Handlingsknapper** – Ettklikksknapper som starter oppfølgende arbeidsflyter
- **Kjøreindikator** – Chatlisten markerer chatter der agenten jobber
- **Varselet «Agenten er ferdig»** – Hvis du bytter fane eller vindu under en kjøring, gir et skrivebordsvarsel beskjed når agenten er ferdig

## Aktive chatter og jobber {#feature-jobs}

Jobbpillen i toppfeltet åpner en levende oversikt over chattene dine og arbeidet i bakgrunnen:

- **Aktive chatter** – Chatter som kjører, og chatter med uleste resultater (vist i **fet skrift**), hver med en ring som viser kontekstbruken
- **Underagenter** – Vises under chatten de tilhører; åpne en for å lese samtaleloggen
- **Utvid** – Åpne listen som et større panel med kolonne- eller seksjonsoppsett

## Verktøytillatelser {#feature-permissions}

I tillegg til tillatelsesnivået per instans (**Manuell**, **Auto**, **Dev**) har hvert verktøy sin egen innstilling under [Innstillinger](app:openSettingsPageView) → **Verktøytillatelser**:

- **Tillat** – Verktøyet kjøres alltid uten å spørre
- **Auto** – Verktøyet kjøres uten å spørre, med mindre agenten markerer at et kall trenger din bekreftelse
- **Spør** – Du får en godkjenningsforespørsel før hvert kall
- **Av** – Agenten kan ikke bruke verktøyet

Noen verktøy har mer detaljerte innstillinger: ServiceNow-API-et per HTTP-metode (GET, POST, PUT, PATCH, DELETE), nettleserstyring per handling (navigere, klikke, fylle ut, etterligne …) og administrasjon av ferdigheter per handling. Bekreftelsesdialoger er fargekodet etter risiko: **blå** (rutine), **oransje** (forsiktighet), **rød** (destruktiv).

:::tip
La DELETE og andre destruktive operasjoner stå på **Spør**, og bruk **Dev** bare på utviklingsinstanser.
:::

## Agentens verktøy {#feature-tools}

De viktigste verktøyene agenten bruker:

| Verktøy | Hva det gjør |
|------|--------------|
| **ServiceNow-API** (`servicenow_api`) | Lese, opprette, oppdatere og slette poster |
| **Bakgrunnsskript** (`servicenow_run_script`) | Kjøre et skript på serversiden av instansen (krever admin-rollen) |
| **Skriptredigering** (`servicenow_diff_edit`) | Endre skript med presise søk-og-erstatt-redigeringer |
| **Nettleserstyring** (`iframe_tool`) | Navigere, klikke, fylle ut, inspisere og etterligne i nettleserfaner |
| **Nettleserkode** (`js_eval`) | Kjøre JavaScript i en isolert sandkasse som kan kalle andre verktøy |
| **Skjermbilder** (`take_screenshot`) | Ta bilde av siden, en widget eller et element |
| **Widgeter og kort** (`html_widget`, `display`) | Vise interaktive widgeter, tabeller, kort og tidslinjer i chatten |
| **Smarte dokumenter** (`document`) | Opprette og oppdatere varige Markdown-dokumenter |
| **Spør brukeren** (`prompt_user`) | Be deg om inndata med et skjema direkte i chatten |
| **Underagenter** (`spawn_sub_agent`) | Delegere arbeid til arbeidere i bakgrunnen |
| **Arbeidsområde** (`workspace`) | Jobbe med filer og GitHub-repoer |
| **Netthenting** (`web_fetch`) | Lese sider fra det åpne nettet |
| **Ferdigheter** (`get_skill`, `manage_skill`) | Lese og administrere ferdigheter |

Åpne [Innstillinger](app:openSettingsPageView) → **Verktøytillatelser** for å se hvert verktøy, kilden og tillatelsen.

## Hurtigbufring av stort innhold {#feature-caching}

Når et verktøyresultat er for stort for samtalen (mer enn 4K tokener som standard), hurtigbufrer AppAgent det. Agenten får en disposisjon og leser, søker i eller blar deretter bare gjennom de delene den trenger. Dette holder chattene raske og fokuserte. Endre terskelen (1K til 100K tokener) under [Innstillinger](app:openSettingsPageView) → **Hurtigbufring av stort innhold**.

## Kontekstindikator {#feature-saturation}

**Kontekstindikatoren** ved siden av inndatafeltet i chatten viser hvor full samtalen er. Over 50 % blir agenten bedt om å avslutte og overlate resten av det tunge arbeidet til underagenter; ved 100 % stopper den og rapporterer. Klikk på indikatoren når som helst for å oppsummere samtalen til en ny chat.

## Bruk og grenser for forespørsler {#feature-usage}

- **Brukspille** – Toppfeltet viser API-bruken din og gjenværende grenser; klikk på den for detaljer
- **Automatiske nye forsøk** – Når leverandøren begrenser forespørsler eller er overbelastet (HTTP 429 / 529), venter AppAgent og prøver automatisk på nytt, og viser en nedtelling i chatten
- **Tom for kreditt** – Når en 429 faktisk betyr at kreditten din er brukt opp, sier chatten det tydelig

## Språk {#feature-languages}

Grensesnittet er tilgjengelig på engelsk pluss 24 språk: arabisk, kinesisk (forenklet, tradisjonell), tsjekkisk, dansk, nederlandsk, finsk, fransk (Frankrike, Canada), tysk, hebraisk, ungarsk, italiensk, japansk, koreansk, norsk, polsk, portugisisk (Brasil, Portugal), russisk, spansk, svensk, thai og tyrkisk.

Velg et språk under [Innstillinger](app:openSettingsPageView) → **Språk**, eller fra hurtiginnstillingsmenyen i toppfeltet. **Auto** følger språket i nettleseren din og faller tilbake til engelsk. Endringen trer i kraft umiddelbart, uten å laste inn på nytt.

- **Høyre mot venstre** – Arabisk og hebraisk bruker et oppsett fra høyre mot venstre
- **Lokale formater** – Datoer, klokkeslett og tall følger språket ditt
- **Agentens svar** – Agenten svarer på det valgte språket med mindre du skriver på et annet. Kode, tabellnavn og feltnavn forblir uendret
- **Denne hjelpesiden** – Vises på ditt språk; endringsloggen forblir på engelsk

# Sider og innstillinger {#pages}

## Innstillinger {#page-settings}

[Åpne innstillinger →](app:openSettingsPageView)

- **Agentmodell** – Modellen agenten bruker
- **API-leverandører** – Anthropic, OpenRouter eller egendefinerte leverandører, med API-nøkkel eller OAuth
- **LLM-endepunkter** – Navngitte `URL + API key`-par for alle OpenAI-kompatible API-er
- **Modellnivåer for underagenter** – Knytt nivåene small, medium og large til modeller, eller til **Samme**
- **Resonneringsinnsats, Maks tokener og Tenkebudsjett** – Juster dybden og lengden på svarene
- **Kontekstvindu** – Kontekststørrelsen som kontekstindikatoren bruker
- **Visning** – API-statistikk, kompakt modus, hold skjermen våken
- **Språk** – Grensesnittspråk, eller **Auto**
- **Kroker** – Automatiske chattitler, varsler om at agenten er ferdig, og annen automatisering
- **Hurtigbufring av stort innhold** – Når store resultater hurtigbufres
- **Verktøytillatelser** – Hva som kjøres automatisk, spør først eller er deaktivert
- **GitHub** – Koble til en GitHub-konto og administrer klonede repoer
- **Systemprompt** – Tilpass instruksjonene til agenten
- **Databehandling** – Eksporter, importer eller slett dataene dine

## Historikk {#page-history}

Alle samtalene dine. [Åpne historikk →](app:openHistoryView)

- **Søk** – Finn chatter etter tittel, innhold, brukte verktøy eller widgeter
- **Fest** – Hold viktige chatter øverst
- **Eksporter** – Last ned én chat eller hele historikken din
- **Statistikk** – Antall chatter, festede chatter og total kostnad

## Hjelp {#page-docs}

Denne siden. [Åpne hjelp →](app:openDocsView)

- **Søk** – Filtrer hjelpeemnene fra søkefeltet i verktøylinjen
- **Innhold** – Gå til en seksjon fra innholdsoversikten
- **Last ned** – Lagre dokumentasjonen som en Markdown-fil

# Tips og hurtigtaster {#tips}

| Handling | Slik gjør du |
|--------|-----|
| Send melding | <kbd>Enter</kbd> |
| Ny linje | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Søk i chatter | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> på Mac) |
| Lukk en dialog eller meny | <kbd>Esc</kbd> |
| Gå tilbake | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Legg ved et bilde | Lim det inn, eller dra og slipp det i chatten |
| Start på nytt med et sammendrag | Klikk på kontekstindikatoren |
| Avbryt agenten | Send en ny melding, eller klikk **Pause** |

:::tip
**Vær konkret.** I stedet for *«rett dette»* kan du si *«rett null-referansefeilen på linje 42 i skriptinkluderingen MyUtils»*. Oppgi tabellen, posten eller siden når du kan.
:::

- **Ett mål per chat** – Start en ny chat for en oppgave som ikke henger sammen med den forrige; da er agenten raskere og mer nøyaktig
- **La den teste** – Be agenten åpne siden og bekrefte sin egen endring med et skjermbilde
- **Bruk ferdigheter** – Aktiver en ferdighet som passer til oppgaven (for eksempel testing eller revisjon) før du begynner

# Feilsøking og vanlige spørsmål {#faq}

### Agenten ser ikke instansen min

Åpne instansen i en fane i den samme Chrome-profilen og sørg for at du er logget på, og skriv deretter *«list instances»*. Hvis den fortsatt ikke vises, laster du inn instansfanen på nytt.

### Jeg får en API- eller autentiseringsfeil

Kontroller leverandøren din under [Innstillinger](app:openSettingsPageView) → **API-leverandører**: API-nøkkelen, det valgte endepunktet og modellnavnet. For OAuth logger du på claude.ai på nytt i den samme Chrome-profilen.

### Agenten sier at forespørslene er begrenset

AppAgent prøver automatisk på nytt og viser en nedtelling. Hvis det skjer gjentatte ganger, kan du sjekke gjenværende kreditt i brukspillen, eller bruke et mindre modellnivå for underagenter.

### For mange godkjenningsforespørsler, eller for få

Endre tillatelsesnivået for instansen (**Manuell**, **Auto**, **Dev**) i instansmenyen, og juster enkeltverktøy under [Innstillinger](app:openSettingsPageView) → **Verktøytillatelser**.

### Svarene blir tregere eller mindre nøyaktige i en lang chat

Samtalen holder på å fylle opp konteksten. Klikk på kontekstindikatoren for å fortsette i en ny chat med et sammendrag.

### Hvordan angrer jeg en endring?

Åpne sidepanelet i chatten og klikk **Angre** på endringen i versjonshistorikken. **Last ned XML** eksporterer alle endringer.

### Hvor lagres dataene mine?

Lokalt i nettleseren din (IndexedDB). Chatter sendes aldri til en AppAgent-server – bare til AI-leverandøren din og ServiceNow-instansen din. Se [Datalagring](#adv-data-storage).

### Grensesnittet eller denne siden er på feil språk

Velg språket under [Innstillinger](app:openSettingsPageView) → **Språk**. **Auto** følger språket i nettleseren din.

# Avansert {#advanced}

Denne delen tar for seg avanserte funksjoner, knapper i toppfeltet, import- og eksportformater og tekniske detaljer om hvordan AppAgent fungerer.

## Knapper i toppfeltet på dashbordet {#adv-dashboard-header}

Toppfeltet på dashbordet inneholder flere handlingsknapper:

| Knapp | Beskrivelse |
|--------|-------------|
| **Vis/skjul sidepanel** | Vis eller skjul navigasjonen i sidepanelet til venstre |
| **Åpne frittstående** | Åpne dashbordet i en ny nettleserfane for frittstående visning |
| **Overskrifter** | Vis eller skjul widgetoverskriftene på dashbordet. Når de er skjult, vises widgetene i en ryddigere visning |
| **Generer alle på nytt** | Generer alle widgetene på dashbordet på nytt ved hjelp av agenten. Nyttig for å oppdatere data |
| **Importer** | Importer et dashbord eller en widget fra en JSON-fil |
| **Eksporter** | Eksporter hele dashbordet til en JSON-fil for sikkerhetskopi eller deling |
| **Legg til widget** | Åpner widgetredigeringen for å lage en ny widget med hjelp fra agenten |

## Knapper i widgetoverskrifter {#adv-widget-headers}

**Widgetoverskrifter på dashbordet** (synlige når Overskrifter er slått på):

| Knapp | Beskrivelse |
|--------|-------------|
| **Drahåndtak** | Widgetikonet fungerer som et drahåndtak for å endre rekkefølgen på widgetene |
| **Generer på nytt** | Be agenten generere innholdet i denne widgeten på nytt |
| **Historikk** | Vis tidligere versjoner av denne widgeten (hvis tilgjengelig) |
| **Fullskjerm** | Utvid widgeten til fullskjermvisning |
| **Rediger** | Åpne widgetredigeringen for å endre den via chat med agenten |
| **Slett** | Fjern widgeten fra dashbordet (med bekreftelse) |

**Widgetoverskrifter i chatten** (widgeter direkte i chatten):

| Knapp | Beskrivelse |
|--------|-------------|
| **Fest til Dashbord** | Lagre denne widgeten på dashbordet ditt |
| **Rediger kode** | Vis og rediger HTML/CSS/JS-koden til widgeten direkte |
| **Utvid/skjul** | Vis eller skjul innholdet i widgeten |

## Endre størrelse på og flytte widgeter {#adv-resize-move}

**Endre størrelse på widgeter:**

- Hver widget har et **størrelseshåndtak** nederst i høyre hjørne
- Klikk og dra håndtaket for å endre størrelsen på widgeten
- Bredden festes til et rutenett med 12 kolonner (minst 3 kolonner)
- Høyden måles i enheter på 50px (minst 2 enheter = 100px)

**Flytte widgeter:**

- Slå på **Overskrifter** for å vise widgetoverskriftene
- Klikk og dra **widgetikonet** (drahåndtaket) for å endre rekkefølgen
- Slipp widgeten på en annen widget for å bytte plass
- Rekkefølgen på widgetene lagres automatisk

## Import- og eksportformater {#adv-import-export}

**Eksport av dashbord** (`dashboard-YYYY-MM-DD.json`):

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

**Eksport av én widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Eksport av én chat** (`chat-title-YYYY-MM-DD.json`):

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

Chateksporter bevarer hele samtalehistorikken, inkludert alle brukermeldinger og svar fra agenten. Bruk rullegardinmenyen for chatten (···) og velg **Last ned** for å eksportere enkeltchatter.

**Eksport av ferdigheter** (mappestruktur):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Merk:** Import og eksport av ferdigheter bruker File System Access API og **fungerer bare i nettleserne Chrome og Edge**.
:::

**Eksport av alle data** (`appagent-backup-YYYY-MM-DD.json`):

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

Den fullstendige sikkerhetskopien inneholder all chathistorikk, innstillinger, verktøytillatelser, dashbordwidgeter og konfigurasjoner av API-leverandører.

## API-statistikk {#adv-api-stats}

Når API-statistikk er aktivert i innstillingene, vises den etter hvert svar fra agenten:

| Måltall | Beskrivelse |
|--------|-------------|
| **Inn** | Inndatatokener – størrelsen på prompten som sendes til agenten |
| **Ut** | Utdatatokener – størrelsen på svaret fra agenten |
| **Totalt** | Inndata- og utdatatokener til sammen |
| **Hurtigbuffer lest/skrevet** | Tokener som er lest fra eller skrevet til prompthurtigbufferen (reduserer kostnaden) |
| **Resonnering** | Tokener brukt til intern resonnering (enkelte modeller) |
| **Kostnad** | Beregnet kostnad for API-kallet i USD |
| **Varighet** | Tiden API-kallet tok |

For samtaler med flere runder viser samlet statistikk totalen for alle kall.

:::tip
Slå visningen av API-statistikk av eller på under [Innstillinger](app:openSettingsPageView) → Visning → Vis API-statistikk.
:::

## Manuell redigering av ferdigheter {#adv-skills-manual}

Ferdigheter kan opprettes og redigeres manuelt eller med hjelp fra agenten:

**Opprette en ferdighet manuelt:**

1. Gå til [Ferdigheter](app:openSkillsView) og klikk **Ny ferdighet**
2. Skriv inn et navn og en beskrivelse for ferdigheten
3. Skriv innholdet i ferdigheten i Markdown-format
4. Klikk **Lagre** for å opprette ferdigheten

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

**Redigere med agenten:**

1. Klikk **Rediger med agent** på en ferdighet
2. Beskriv hvilke endringer du vil ha
3. Agenten endrer innholdet i ferdigheten
4. Gå gjennom og lagre endringene

**Ressurser for ferdigheter:** Ferdigheter kan inneholde flere filer (XML, JS, MD) som gir agenten ekstra kontekst eller kode.

## Systemprompt {#adv-system-prompt}

Systemprompten bestemmer hvordan agenten oppfører seg og hva den kan. Du kan tilpasse den under [Innstillinger](app:openSettingsPageView).

**Redigere systemprompten:**

1. Gå til Innstillinger → delen Systemprompt
2. Klikk **Rediger** for å gå over til redigeringsmodus
3. Endre malen etter behov
4. Klikk **Lagre** for å ta i bruk endringene

**Tilgjengelige plassholdere:**

| Plassholder | Beskrivelse |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Dagens dato (ukedag, måned, dag, år) |
| `{{ORCHESTRATOR_POLICY}}` | Policy for delegering til underagenter – tas med i hovedchatter, står tom i chatter for underagenter |
| `{{DISABLED_TOOLS}}` | Liste over deaktiverte verktøy |
| `{{TOOL_CATALOG}}` | Katalog over utsatte verktøy (tom når utsatt innlasting av verktøy er slått av) |
| `{{SKILLS_SUMMARY}}` | Innholdet i aktive ferdigheter |

Plassholderne erstattes automatisk med faktiske verdier når prompten sendes til AI-en. Tokentellingen viser både størrelsen på malen og den utvidede størrelsen.

:::tip
Klikk **Tilbakestill til standard** for å gjenopprette den opprinnelige systemprompten om nødvendig.
:::

## API-kall fra agenten {#adv-agent-api}

AppAgent kjører som en **Chrome-utvidelse**:

- AI-API-kall går **direkte fra nettleseren din til AI-leverandøren** (f.eks. Anthropic, OpenRouter)
- De går **ikke** via instansen din eller noen AppAgent-server
- API-nøkkelen din (eller OAuth-tokenet) lagres lokalt i nettleseren din
- Samtaledata sendes til AI-leverandøren for behandling

**Slik fungerer det:**

1. Du skriver en melding i chatten
2. AppAgent bygger en prompt med systeminstruksjoner, verktøy og samtalehistorikk
3. Prompten sendes til API-et til AI-leverandøren
4. Svaret fra agenten strømmes tilbake til nettleseren din
5. Verktøykall kjøres i nettleseren din, og API-kall bruker økten din på instansen

:::tip
**Personvern:** API-nøkkelen og samtaledataene dine håndteres på klientsiden. Verktøykall som samhandler med instansen din, bruker påloggingsinformasjonen fra den eksisterende økten din.
:::

## LLM-endepunkter {#adv-endpoints}

Modeller kobles til via **navngitte LLM-endepunkter** – gjenbrukbare `URL + API key`-par. Dermed kan du koble AppAgent til **et hvilket som helst OpenAI-kompatibelt API for chat-completions**: OpenRouter, en lokal gateway, en proxy eller din egen hostede modell.

1. Under [Innstillinger → LLM-endepunkter](app:openSettingsPageView) klikker du **Legg til endepunkt**
2. Gi det et navn, API-URL-en og en API-nøkkel
3. Hver modell (API-leverandør) velger et endepunkt – oppdater en nøkkel én gang, så oppdateres alle modellene som bruker den

:::tip
Claude-leverandører med **OAuth** bruker ikke endepunkter – de kommuniserer direkte med `api.anthropic.com`.
:::

## Logg på med Claude (OAuth) {#adv-oauth}

I stedet for å lime inn en API-nøkkel kan du logge på Anthropic-leverandører med den eksisterende claude.ai-økten din:

1. Under [Innstillinger → API-leverandører](app:openSettingsPageView) legger du til eller redigerer en Anthropic-leverandør og aktiverer **OAuth**
2. Utvidelsen bruker claude.ai-påloggingen din fra den samme Chrome-profilen for å koble direkte til Anthropic
3. Ingen ekstra påloggingsvindu, og ingen AppAgent-server imellom

**Krav:**

- Du må være logget på `claude.ai` i den samme Chrome-profilen
- Fungerer med kontoer som bruker enkel pålogging (SSO)

:::tip
OAuth-tokener fornyes automatisk. Hvis påloggingen mislykkes, åpner du `claude.ai` i den samme profilen og logger på igjen.
:::

## Sikkerhetshensyn {#adv-security}

**Lagring av API-nøkkel:**

- **API-nøkkelen din lagres lokalt** i IndexedDB i nettleseren din
- Nøkkelen sendes aldri til instansen din eller til noen annen server enn AI-leverandøren
- Hvis du sletter nettleserdata, fjernes den lagrede API-nøkkelen

**Økt og tillatelser:**

- Agenten kjører med **den gjeldende brukerøkten din** og arver tilgangsrettighetene og rollene dine
- Alle API-kall til instansen din bruker påloggingsinformasjonen fra økten din
- Agenten har bare tilgang til det brukerkontoen din har tilgang til

**Kjøremiljø for verktøy:**

- **Nettleserkode (js_eval)** kjører JavaScript i en **isolert sandkasse** med bare tilgang til `executeTool()`
- **Widgetskript** kjører i **isolerte iframes** med bare tilgang til `executeTool()` for API-kall
- **Ferdighetsverktøy** kjører i **isolerte sandkasser** med bare tilgang til `executeTool()`
- All API-tilgang går gjennom **tillatelsessystemet** via `executeTool("servicenow_api", {...})`
- Agenten samhandler med sider i **nettleserfaner** på ServiceNow-instansen din

**Muligheter for å endre poster:**

- Verktøyet **ServiceNow-API** støtter metodene POST, PATCH, PUT og DELETE, som kan endre poster
- Agenten kan opprette og redigere poster via **den integrerte nettleseren** hvis den har tillatelse til å bruke verktøyene for utfylling og klikk
- Konfigurer [Verktøytillatelser](app:openSettingsPageView) for å styre hvilke operasjoner som krever godkjenning

**Selvforbedring:**

- Agenten kan **administrere sine egne ferdigheter** – opprette, redigere og aktivere ferdigheter
- Dette gjør at agenten kan lære og forbedre seg selv over tid
- Gå jevnlig gjennom endringer i ferdighetene for å sikre at de samsvarer med forventningene dine

## Datalagring {#adv-data-storage}

AppAgent lagrer data lokalt i nettleseren din ved hjelp av **IndexedDB**:

| Datatype | Lagring | Beskrivelse |
|-----------|---------|-------------|
| **Chatter** | IndexedDB | All samtalehistorikk, meldinger og verktøyresultater |
| **Innstillinger** | IndexedDB | Verktøytillatelser, API-nøkler, modellpreferanser |
| **Dashbordwidgeter** | IndexedDB | Widget-HTML, titler, størrelser og samtalehistorikk |
| **Ferdigheter** | IndexedDB | Definisjoner, innhold og ressurser for ferdigheter |
| **API-leverandører** | IndexedDB | Konfigurasjoner og endepunkter for egendefinerte API-leverandører |
| **UI-tilstand** | localStorage | Tilstanden til sidepanelet, gjeldende visning, rulleposisjoner |

**Laste ned dataene dine:**

1. Gå til [Innstillinger](app:openSettingsPageView) → Databehandling
2. Klikk **Eksporter data**
3. En JSON-fil med sikkerhetskopi lastes ned

**Slette dataene dine:**

1. Gå til [Innstillinger](app:openSettingsPageView) → Databehandling
2. Klikk **Slett alle data**
3. Bekreft to ganger for å slette alt permanent

:::tip
**Viktig:** Dataene lagres lokalt i utvidelsen. Hvis du sletter nettleserdata, avinstallerer utvidelsen eller bruker en annen nettleserprofil, får du separate datalagre.
:::

# Om {#about}

**Versjon:** v__VERSION__

**Lisens:** Privat og kommersiell bruk. Intern endring er tillatt. Distribusjon og videresalg er forbudt. Med enerett.

## Endringslogg {#changelog}

__CHANGELOG__
