# AppAgent

**Bygg og vedlikehold ServiceNow-apper med en agent. Som en Chrome-utvidelse.**

AppAgent er utviklingspartneren din for ServiceNow. Den kan lage og vedlikeholde apper, og kjøre tester for dem. Den tester ved å fylle ut skjemaer og ta skjermbilder. Du trenger ingen tekniske kunnskaper.

Du tar med din egen API-nøkkel (BYOK), og det er alt! Den er kompatibel med OpenAI, OpenRouter, Claude API og til og med Claude Code-abonnementer (kontakt oss privat).

Det er en Chrome-utvidelse som lagrer hele chatten i nettleseren din (den forlater ikke engang nettleseren). Den kommuniserer bare med ServiceNow-instansen din og API-leverandøren for modellen din.

![Eksempel på AppAgent](AppAgentExample.png)

Den bruker færre tokener enn Claude Code, fordi den i stor grad utnytter API-hurtigbuffer, hurtigbufring av verktøy og kjeding av verktøy (rett ut av esken).

Du kan legge til ferdigheter, den kan styre nettleseren via faner, og den har mekaniske angreknapper for alle endringene den gjør på instansen din.

> **Merk:** Foreløpig er AppAgent kun ment for bruk på utviklingsinstanser.

## Kontakt oss

Fyll ut dette skjemaet, så tar vi kontakt: [Kontaktskjema](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funksjoner

| Funksjon | Hva den gjør |
|---------|--------------|
| **Ta med din egen modell** | Velg blant Claude, GPT, Gemini, Grok og flere |
| **Logg på med Claude** | OAuth-flyt – bruk ditt eksisterende Claude Code Personal- eller Enterprise-abonnement, uten API-nøkkel |
| **Bilder og PDF-er** | Legg ved skjermbilder, diagrammer eller dokumenter som agenten kan analysere |
| **Koderedigering** | Leser og endrer skript med full versjonssporing |
| **Nettleserkontroll** | Tester sitt eget arbeid: navigerer i faner, klikker, fyller ut skjemaer og tar skjermbilder |
| **Levende dashbord** | Lager widgeter som henter sanntidsdata fra instansen din |
| **Agentferdigheter** | Bygg dine egne ferdigheter for å utvide agentens evner |
| **Ferdighetshandlinger** | Ferdigheter kan vise ettklikksknapper på startsiden som starter forhåndsdefinerte arbeidsflyter |
| **Fremdrift i sanntid** | Se hva agenten gjør i sanntid – fremdriftspiller som skifter mellom tilstandene kjører, står fast, ferdig og feil |
| **Arbeidsområder** | Kladdeområde for filer per chat – klon GitHub-repoer, les, skriv, rediger, se diff og bytt gren. Flere repoer per chat, med eierskapsbeskyttelse på tvers av chatter |
| **Integrert Git og push til GitHub** | Agenten kan hente fra og pushe til GitHub, opprette grener og åpne pull requests direkte fra chatten – uten terminal og uten IDE |
| **Smarte dokumenter** | Varige Markdown-dokumenter med versjoner som agenten kan redigere og henvise til på tvers av chatter |
| **Flere instanser** | Oppdager automatisk alle ServiceNow-instanser som er åpne i nettleseren; agenten kan se og jobbe med alle fra én chat |
| **Underagenter** | Delegerer tungt eller parallelt arbeid til arbeideragenter i bakgrunnen som rapporterer tilbake til hovedchatten |
| **25 språk** | Grensesnitt og hjelp på engelsk pluss 24 språk, inkludert arabisk og hebraisk med skrift fra høyre mot venstre |
| **Pause og avbrudd** | Sett på pause eller send en ny melding underveis – kallet som pågår, avbrytes umiddelbart |
| **Nettsøk** | Gratis nettsøk uten nøkkel via Google og DuckDuckGo |
| **Mekanisk angring** | Hver endring spores, og kan rulles tilbake med ett klikk |
| **Eksport til XML** | Eksporter alle endringer for utrulling til andre instanser |
| **Verktøytillatelser** | Innebygd sikkerhet – styr hva agenten kan gjøre på instansen |
| **Åpne standarder** | Kompatibel med [OpenRouter](https://openrouter.ai) og [AgentSkills.io](https://agentskills.io) |
| **Modellhurtigbufring** | Reduserer kostnaden med opptil 10 ganger gjennom hurtigbufring av prompter |
| **Smart kontekst** | Laster bare inn de delene av store filer som trengs. Overbelaster ikke modellen |
| **Ingen avhengigheter** | Ingen biblioteker, ingen rammeverk, bare ren JavaScript |

## Slik fungerer det

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

AppAgent er en Chrome-utvidelse med innebygd agentløkke. Du beskriver hva du vil ha → agenten spør modellen → kjører verktøy i nettleseren → får tilgang til ServiceNow med tillatelsene til brukeren du er logget på med. Agenten kommuniserer direkte med API-leverandørene for modellene, enten de kjører lokalt eller på nettet.

## Slik står AppAgent seg

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Målgruppe** | Ikke-tekniske brukere | Utviklere | Utviklere | Ikke-tekniske gründere |
| **Bygd for ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Agentiske ServiceNow-handlinger** | ✓ | ✓ | ✗ | ✗ |
| **Krever utviklingsmiljø** | ✗ | ✓ | ✓ | ✗ |
| **Bygger apper** | ✓ | ✓ | ✓ | ✓ |
| **Nettleserstyring for testing** | ✓ | ✗ | ✗ | ✗ |
| **Tar skjermbilder** | ✓ | ✗ | ✗ | ✗ |
| **Bakgrunnsoppgaver** | ✓ (via ferdighetshandlinger) | ✗ | ✓ | ✗ |
| **Parallelle agenter** | ✓ (underagenter) | ✗ | ✓ | ✗ |
| **Mekanisk angring** | ✓ | ✗ | ✗ | ✗ |
| **Bilder og PDF-er** | ✓ | ✓ | ✓ | Begrenset |
| **Smarte dashbord** | ✓ | ✗ | ✗ | ✓ |
| **Utvidbare ferdigheter** | ✓ | ✓ | ✗ | ✗ |
| **Ferdighetshandlinger (ettklikksknapper)** | ✓ | ✗ | ✗ | ✗ |
| **Fremdriftspiller i sanntid** | ✓ | ✗ | ✗ | ✗ |
| **Støtte for flere instanser** | ✓ | ✗ | ✗ | ✗ |
| **Arbeidsområder per chat** | ✓ | ✗ | ✗ | ✗ |
| **Integrert Git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push til GitHub fra chatten** | ✓ | ✓ (CLI) | Begrenset | ✗ |
| **Smarte dokumenter** | ✓ | ✗ | ✗ | ✗ |
| **Pause/avbrudd underveis** | ✓ | ✓ | Begrenset | ✗ |
| **Nettsøk** | ✓ | ✓ | ✓ | ✗ |
| **Verktøytillatelser** | ✓ | ✓ | Begrenset | ✗ |
| **Eksport av endringer** | ✓ XML | ✓ | ✓ | ✓ |
| **Ta med din egen modell** | ✓ | ✗ | ✓ | ✗ |
| **Hurtigbufring av prompter** | ✓ | ✓ | ✓ | ✗ |
| **Smart kontekst** | ✓ | ✓ | ✓ | ✗ |
| **Ingen avhengigheter** | ✓ | ✗ | ✗ | ✓ |

*Base44 kan ikke bygge ServiceNow-apper, men er tatt med for brukere som kjenner opplevelsen derfra.*

## Oppsett

1. **Installer** – Installer AppAgent-utvidelsen fra Chrome Nettmarked (eller last den inn upakket for utvikling)
2. **Skaff en API-nøkkel** – Registrer deg hos [OpenRouter](https://openrouter.ai), bruk Anthropic/OpenAI direkte, eller koble til Claude Code-abonnementet ditt (Enterprise eller Personal)
3. **Konfigurer** – Åpne utvidelsen og legg til API-nøkkelen din (eller logg på med Claude) under Innstillinger → API-leverandører
4. **Begynn å bygge** – Åpne ServiceNow-instansen din i en fane (den oppdages automatisk) og begynn å chatte

## Eksempler

### «Lag en enkel app for å følge opp teamets oppgaver»
AppAgent lager tabellen, legger til feltene, bygger et skjema- og listeoppsett og setter opp en modul i navigatoren. Én prompt, en komplett app.

### «Gjør en full revisjon av denne instansen»
AppAgent søker etter sikkerhetshull, inaktive administratorkontoer, utdaterte poster og beste praksis for konfigurasjon, og gir deg deretter en rapport med anbefalinger.

### «Test denne siden og rapporter eventuelle problemer du finner»
AppAgent åpner siden i en nettleserfane, fyller ut skjemaer, klikker på knapper, tar skjermbilder og setter sammen en rapport over alt den finner.

### «Det er en feil i dette skjemaet, kan du rette den?»
AppAgent åpner skjemaet, undersøker skriptene bak det, finner feilen, retter koden og viser deg nøyaktig hva som ble endret. Ett klikk for å angre om nødvendig.

### «Lag en dashbordwidget for de åpne sakene mine»
AppAgent lager en levende widget som henter sanntidsdata fra instansen din og viser dem på dashbordet ditt.

### «Importer denne Excel-filen til brukertabellen»
AppAgent leser filen, knytter kolonnene til felt og importerer dataene til instansen din.

### «Sjekk oppgraderingshistorikken og rett problemer med tilpasninger»
AppAgent går gjennom hva som ble endret i oppgraderingen, finner ødelagte tilpasninger og retter dem.

### «Varsle teamet når en P1-hendelse opprettes»
AppAgent lager en varslingsregel som utløses ved P1-hendelser og sender et varsel til teamet ditt.

---

## Visjonen

Akkurat nå er Opus 4.7 svært god, men trenger fortsatt litt barnevakt.

Vi vil fortsette å flytte grensene for hva AI-modellene får til i hver generasjon, og fortsette oppover i abstraksjonsnivåene til vi står fast.

GPT-4 => Kodefullføring
GPT-4o => Skriver en frittstående fil
Sonnet 3.5 => Redigerer en fil i en kodebase
Opus 4.5 => Skriver en komplett funksjon
Opus 4.6 => Vedlikeholder en app fra start til slutt
Opus 4.7 => ... (vi tester fortsatt)

---

## Veikart

- RAG
- Spesifikasjoner og testtilfeller

I tilfeldig rekkefølge.

Denne versjonen er hovedsakelig for å samle inn tilbakemeldinger.

Neste versjoner blir kanskje ikke åpen kildekode, men vi vil fortsette å vedlikeholde denne versjonen til den er stabil.

---

## Retningslinjer for bidrag

Ikke åpne noen PR-er. Dette er et kommersielt prosjekt, og vi publiserer koden som åpen kildekode kun for åpenhet og tillit.

Hvis du finner feil, kan du opprette en sak (issue) eller kontakte oss direkte. Vi tilbyr bare kommersiell støtte, så vi retter bare feil som kan påvirke andre brukere.

---

## Lisens

Privat og kommersiell bruk. Intern endring er tillatt. Distribusjon og videresalg er forbudt.
