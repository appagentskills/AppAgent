# AppAgent

**Byg og vedligehold ServiceNow-apps med en agent. Som en Chrome-udvidelse.**

AppAgent er din udviklingspartner til ServiceNow. Den kan oprette og vedligeholde apps og køre test af dem. Den tester ved at udfylde formularer og tage skærmbilleder. Ingen teknisk viden påkrævet.

Du medbringer din egen API-nøgle (BYOK), og så er det det! Den er kompatibel med OpenAI, OpenRouter, Claude API og endda Claude Code-abonnementer (kontakt os privat).

Det er en Chrome-udvidelse, der gemmer hele chatten i din browser (den forlader slet ikke din browser). Den interagerer kun med din ServiceNow-instans og din modeludbyders API.

![Eksempel på AppAgent](AppAgentExample.png)

Den bruger færre tokens end Claude Code, fordi den i høj grad udnytter API-cache, caching af værktøjer og kædning af værktøjer (direkte fra start).

Du kan tilføje færdigheder til den, den har browserstyring via faner, og den har mekaniske fortrydknapper for alle de ændringer, den foretager på din instans.

> **Bemærk:** Indtil videre er AppAgent kun beregnet til brug på udviklingsinstanser.

## Kontakt os

Udfyld denne formular, så kontakter vi dig: [Kontaktformular](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funktioner

| Funktion | Hvad den gør |
|---------|--------------|
| **Medbring din egen model** | Vælg mellem Claude, GPT, Gemini, Grok og flere |
| **Log ind med Claude** | OAuth-flow – brug dit eksisterende Claude Code Personal- eller Enterprise-abonnement, ingen API-nøgle nødvendig |
| **Billeder og PDF'er** | Vedhæft skærmbilleder, diagrammer eller dokumenter, som agenten kan analysere |
| **Koderedigering** | Læser og ændrer scripts med fuld versionssporing |
| **Browserstyring** | Tester sit eget arbejde: navigerer i faner, klikker, udfylder formularer, tager skærmbilleder |
| **Live-dashboards** | Opretter widgets, der henter data i realtid fra din instans |
| **Agentfærdigheder** | Byg dine egne færdigheder for at udvide agentens muligheder |
| **Færdighedshandlinger** | Færdigheder kan vise knapper på startsiden, der med ét klik starter forudindstillede workflows |
| **Live-fremskridt** | Se, hvad agenten laver i realtid – fremskridtsmærker, der skifter mellem statusserne kører/sidder fast/færdig/fejl |
| **Arbejdsområder** | Filkladde pr. chat – klon GitHub-repos, læs, skriv, rediger, sammenlign og skift branches. Flere repos pr. chat med beskyttelse af ejerskab på tværs af chats |
| **Integreret Git og GitHub-push** | Agenten kan hente fra og pushe til GitHub, oprette branches og åbne pull requests direkte fra chatten – ingen terminal, ingen IDE |
| **Smarte dokumenter** | Vedvarende Markdown med versioner, som agenten kan redigere og henvise til på tværs af chats |
| **Flere instanser** | Registrerer automatisk alle ServiceNow-instanser, der er åbne i din browser; agenten kan se og handle på dem alle fra én chat |
| **Underagenter** | Uddelegerer tungt eller parallelt arbejde til agenter i baggrunden, der rapporterer tilbage til hovedchatten |
| **25 sprog** | Brugerflade og hjælp på engelsk plus 24 sprog, herunder arabisk og hebraisk, der skrives fra højre mod venstre |
| **Pause og afbrydelse** | Sæt på pause, eller send en ny besked midt i et svar – det igangværende kald afbrydes med det samme |
| **Websøgning** | Gratis websøgninger uden nøgle via Google og DuckDuckGo |
| **Mekanisk fortrydelse** | Alle ændringer spores, tilbagerulning med ét klik |
| **Eksport til XML** | Eksportér alle ændringer til udrulning på andre instanser |
| **Værktøjstilladelser** | Indbygget sikkerhed – styr, hvad agenten må gøre på instansen |
| **Åbne standarder** | Kompatibel med [OpenRouter](https://openrouter.ai) og [AgentSkills.io](https://agentskills.io) |
| **Modelcaching** | Reducerer omkostningerne op til 10 gange via prompt caching |
| **Smart kontekst** | Indlæser kun de nødvendige dele af store filer. Overbelaster ikke modellen |
| **Ingen afhængigheder** | Ingen biblioteker, ingen frameworks, ren vanilla JS |

## Sådan fungerer det

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

AppAgent er en Chrome-udvidelse med en indbygget agentløkke. Du beskriver, hvad du vil have → Agenten spørger modellen → Udfører værktøjer i browseren → Tilgår ServiceNow med dine aktuelle brugertilladelser. Agenten kommunikerer direkte med modellernes API-udbydere, lokalt eller online.

## Sådan klarer AppAgent sig i sammenligning

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Målgruppe** | Ikke-tekniske | Udviklere | Udviklere | Ikke-tekniske iværksættere |
| **Bygget til ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Agentiske ServiceNow-handlinger** | ✓ | ✓ | ✗ | ✗ |
| **Kræver udviklingsmiljø** | ✗ | ✓ | ✓ | ✗ |
| **Bygger apps** | ✓ | ✓ | ✓ | ✓ |
| **Browserstyring til test** | ✓ | ✗ | ✗ | ✗ |
| **Tager skærmbilleder** | ✓ | ✗ | ✗ | ✗ |
| **Baggrundsopgaver** | ✓ (via færdighedshandlinger) | ✗ | ✓ | ✗ |
| **Parallelle agenter** | ✓ (underagenter) | ✗ | ✓ | ✗ |
| **Mekanisk fortrydelse** | ✓ | ✗ | ✗ | ✗ |
| **Billeder og PDF'er** | ✓ | ✓ | ✓ | Begrænset |
| **Smarte dashboards** | ✓ | ✗ | ✗ | ✓ |
| **Udvidelige færdigheder** | ✓ | ✓ | ✗ | ✗ |
| **Færdighedshandlinger (knapper med ét klik)** | ✓ | ✗ | ✗ | ✗ |
| **Live-fremskridtsmærker** | ✓ | ✗ | ✗ | ✗ |
| **Understøttelse af flere instanser** | ✓ | ✗ | ✗ | ✗ |
| **Arbejdsområder pr. chat** | ✓ | ✗ | ✗ | ✗ |
| **Integreret git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push til GitHub fra chatten** | ✓ | ✓ (CLI) | Begrænset | ✗ |
| **Smarte dokumenter** | ✓ | ✗ | ✗ | ✗ |
| **Pause/afbrydelse midt i et svar** | ✓ | ✓ | Begrænset | ✗ |
| **Websøgning** | ✓ | ✓ | ✓ | ✗ |
| **Værktøjstilladelser** | ✓ | ✓ | Begrænset | ✗ |
| **Eksport af ændringer** | ✓ XML | ✓ | ✓ | ✓ |
| **Medbring din egen model** | ✓ | ✗ | ✓ | ✗ |
| **Prompt caching** | ✓ | ✓ | ✓ | ✗ |
| **Smart kontekst** | ✓ | ✓ | ✓ | ✗ |
| **Ingen afhængigheder** | ✓ | ✗ | ✗ | ✓ |

*Base44 kan ikke bygge ServiceNow-apps, men er medtaget for brugere, der kender oplevelsen derfra.*

## Opsætning

1. **Installér** – Installér AppAgent-udvidelsen fra Chrome Web Store (eller indlæs den upakket til udvikling)
2. **Skaf en API-nøgle** – Opret en konto hos [OpenRouter](https://openrouter.ai), brug Anthropic/OpenAI direkte, eller forbind dit Claude Code-abonnement (Enterprise eller Personal)
3. **Konfigurer** – Åbn udvidelsen, og tilføj din API-nøgle (eller log ind med Claude) under Indstillinger → API-udbydere
4. **Begynd at bygge** – Åbn din ServiceNow-instans i en fane (den registreres automatisk), og begynd at chatte

## Eksempler

### "Byg en simpel app til at holde styr på teamets opgaver"
AppAgent opretter tabellen, tilføjer felterne, bygger et formular- og listelayout og opsætter et modul i navigatoren. Én prompt, en komplet app.

### "Lav en fuld revision af denne instans"
AppAgent scanner efter sikkerhedshuller, inaktive administratorkonti, forældede poster og bedste praksis for konfiguration og giver dig derefter en rapport med anbefalinger.

### "Test denne side, og rapportér eventuelle problemer, du finder"
AppAgent åbner siden i en browserfane, udfylder formularer, klikker på knapper, tager skærmbilleder og samler en rapport over alt, hvad den finder.

### "Der er en fejl i denne formular – kan du rette den?"
AppAgent åbner formularen, inspicerer de scripts, der ligger bag, finder fejlen, retter koden og viser dig præcis, hvad der er ændret. Ét klik for at fortryde, hvis det er nødvendigt.

### "Opret en dashboardwidget til mine åbne sager"
AppAgent opretter en live-widget, der henter data i realtid fra din instans og viser dem på dit dashboard.

### "Importér denne Excel-fil til brugertabellen"
AppAgent læser filen, tilknytter kolonner til felter og importerer dataene til din instans.

### "Tjek opgraderingshistorikken, og ret problemer med tilpasninger"
AppAgent gennemgår, hvad der er ændret i opgraderingen, finder ødelagte tilpasninger og retter dem.

### "Giv teamet besked, når der oprettes en P1-incident"
AppAgent opretter en notifikationsregel, der udløses af P1-incidents og sender en advarsel til dit team.

---

## Visionen

Lige nu er Opus 4.7 fremragende, men har stadig brug for lidt opsyn.

Vi vil blive ved med at presse grænserne for, hvad AI-modellerne kan i hver generation, og fortsætte op ad abstraktionsstakken, indtil vi går i stå.

GPT-4 => Kodefuldførelse
GPT-4o => Skriver en selvstændig fil
Sonnet 3.5 => Redigerer en fil i en kodebase
Opus 4.5 => Skriver en komplet funktion
Opus 4.6 => Vedligeholder en app fra ende til anden
Opus 4.7 => ... (vi tester stadig)

---

## Køreplan

- RAG
- Specifikationer og testcases

I vilkårlig rækkefølge.

Denne version er primært til at indsamle feedback.

Fremtidige versioner er måske ikke open source, men vi bliver ved med at vedligeholde denne version, indtil den er stabil.

---

## Retningslinjer for bidrag

Åbn venligst ikke nogen PR'er – dette er et kommercielt projekt, og vi offentliggør kun koden af hensyn til synlighed og tillid.

Hvis du finder fejl, kan du oprette et issue eller kontakte os direkte. Vi tilbyder kun kommerciel support, så vi retter kun fejl, der kan påvirke andre brugere.

---

## Licens

Privat og kommerciel brug. Intern ændring tilladt. Distribution og videresalg forbudt.
