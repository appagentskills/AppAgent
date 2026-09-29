# AppAgent

**Bygg och underhåll ServiceNow-appar med en agent. Som ett Chrome-tillägg.**

AppAgent är din utvecklingspartner för ServiceNow. Den kan skapa och underhålla appar och köra tester för dem. Testningen sker genom att den fyller i formulär och tar skärmbilder. Inga tekniska kunskaper krävs.

Du tar med din egen API-nyckel (BYOK), och sedan är det klart! Den är kompatibel med OpenAI, OpenRouter, Claude API och till och med Claude Code-abonnemang (kontakta oss privat).

Det är ett Chrome-tillägg som lagrar hela chatten i din webbläsare (den lämnar aldrig webbläsaren). Det interagerar bara med din ServiceNow-instans och din API-leverantör för modellen.

![Exempel på AppAgent](AppAgentExample.png)

Den använder färre token än Claude Code, eftersom den i hög grad bygger på API-cache, cachelagring av verktyg och kedjade verktygsanrop (direkt ur lådan).

Du kan lägga till färdigheter, den kan styra webbläsaren via flikar och den har mekaniska ångra-knappar för alla ändringar den gör i din instans.

> **Obs!** Tills vidare är AppAgent endast avsett för användning i utvecklingsinstanser.

## Kontakta oss

Fyll i det här formuläret så hör vi av oss: [Kontaktformulär](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funktioner

| Funktion | Vad den gör |
|---------|--------------|
| **Välj din egen modell** | Välj bland Claude, GPT, Gemini, Grok med flera |
| **Logga in med Claude** | OAuth-flöde – använd ditt befintliga Claude Code-abonnemang (Personal eller Enterprise), ingen API-nyckel behövs |
| **Bilder och PDF:er** | Bifoga skärmbilder, diagram eller dokument som agenten kan analysera |
| **Kodredigering** | Läser och ändrar skript med fullständig versionsspårning |
| **Webbläsarstyrning** | Testar sitt eget arbete: navigerar i flikar, klickar, fyller i formulär, tar skärmbilder |
| **Levande instrumentpaneler** | Skapar widgetar som hämtar realtidsdata från din instans |
| **Agentfärdigheter** | Bygg egna färdigheter för att utöka agentens förmågor |
| **Färdighetsåtgärder** | Färdigheter kan visa knappar på startsidan som startar förinställda arbetsflöden med ett klick |
| **Liveförlopp** | Se vad agenten gör i realtid – föränderliga förloppsetiketter med statusarna körs/fastnat/klar/fel |
| **Arbetsytor** | Filyta per chatt – klona GitHub-repon, läs, skriv, redigera, jämför och byt gren. Flera repon per chatt, med skydd av ägarskap mellan chattar |
| **Integrerad Git och push till GitHub** | Agenten kan hämta från och pusha till GitHub, skapa grenar och öppna pull requests direkt från chatten – ingen terminal, ingen IDE |
| **Smarta dokument** | Beständig, versionshanterad Markdown som agenten kan redigera och hänvisa till i olika chattar |
| **Flera instanser** | Identifierar automatiskt alla ServiceNow-instanser som är öppna i din webbläsare; agenten kan se och arbeta i alla från en och samma chatt |
| **Underagenter** | Delegerar tungt eller parallellt arbete till arbetaragenter i bakgrunden som rapporterar tillbaka till huvudchatten |
| **25 språk** | Gränssnitt och hjälp på engelska och 24 andra språk, inklusive arabiska och hebreiska som skrivs från höger till vänster |
| **Pausa och avbryt** | Pausa eller skicka ett nytt meddelande mitt i strömmen – det pågående anropet avbryts direkt |
| **Webbsökning** | Kostnadsfria webbsökningar utan nyckel via Google och DuckDuckGo |
| **Mekanisk ångring** | Varje ändring spåras, återställning med ett klick |
| **Export till XML** | Exportera alla ändringar för driftsättning i andra instanser |
| **Verktygsbehörigheter** | Inbyggd säkerhet – styr vad agenten får göra i instansen |
| **Öppna standarder** | Kompatibel med [OpenRouter](https://openrouter.ai) och [AgentSkills.io](https://agentskills.io) |
| **Modellcachelagring** | Sänker kostnaden upp till 10 gånger tack vare promptcachelagring |
| **Smart kontext** | Läser bara in de delar av stora filer som behövs. Överbelastar inte modellen |
| **Inga beroenden** | Inga bibliotek, inga ramverk, ren vanilla JS |

## Så fungerar det

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

AppAgent är ett Chrome-tillägg med en inbyggd agentloop. Du beskriver vad du vill ha → Agenten frågar modellen → Kör verktyg i webbläsaren → Kommer åt ServiceNow med din aktuella användares behörigheter. Agenten kommunicerar direkt med modellernas API-leverantörer, lokalt eller online.

## Så står sig AppAgent

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Målgrupp** | Icke-tekniska användare | Utvecklare | Utvecklare | Icke-tekniska grundare |
| **Byggd för ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Agentiska ServiceNow-åtgärder** | ✓ | ✓ | ✗ | ✗ |
| **Kräver utvecklingsmiljö** | ✗ | ✓ | ✓ | ✗ |
| **Bygger appar** | ✓ | ✓ | ✓ | ✓ |
| **Webbläsarstyrning för testning** | ✓ | ✗ | ✗ | ✗ |
| **Tar skärmbilder** | ✓ | ✗ | ✗ | ✗ |
| **Bakgrundsuppgifter** | ✓ (via färdighetsåtgärder) | ✗ | ✓ | ✗ |
| **Parallella agenter** | ✓ (underagenter) | ✗ | ✓ | ✗ |
| **Mekanisk ångring** | ✓ | ✗ | ✗ | ✗ |
| **Bilder och PDF:er** | ✓ | ✓ | ✓ | Begränsat |
| **Smarta instrumentpaneler** | ✓ | ✗ | ✗ | ✓ |
| **Utbyggbara färdigheter** | ✓ | ✓ | ✗ | ✗ |
| **Färdighetsåtgärder (knappar med ett klick)** | ✓ | ✗ | ✗ | ✗ |
| **Levande förloppsetiketter** | ✓ | ✗ | ✗ | ✗ |
| **Stöd för flera instanser** | ✓ | ✗ | ✗ | ✗ |
| **Arbetsytor per chatt** | ✓ | ✗ | ✗ | ✗ |
| **Integrerad git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push till GitHub från chatten** | ✓ | ✓ (CLI) | Begränsat | ✗ |
| **Smarta dokument** | ✓ | ✗ | ✗ | ✗ |
| **Pausa/avbryt mitt i strömmen** | ✓ | ✓ | Begränsat | ✗ |
| **Webbsökning** | ✓ | ✓ | ✓ | ✗ |
| **Verktygsbehörigheter** | ✓ | ✓ | Begränsat | ✗ |
| **Exportera ändringar** | ✓ XML | ✓ | ✓ | ✓ |
| **Välj din egen modell** | ✓ | ✗ | ✓ | ✗ |
| **Promptcachelagring** | ✓ | ✓ | ✓ | ✗ |
| **Smart kontext** | ✓ | ✓ | ✓ | ✗ |
| **Inga beroenden** | ✓ | ✗ | ✗ | ✓ |

*Base44 kan inte bygga ServiceNow-appar, men finns med för användare som känner till hur den fungerar.*

## Installation

1. **Installera** – Installera AppAgent-tillägget från Chrome Web Store (eller läs in det okomprimerat för utveckling)
2. **Skaffa en API-nyckel** – Registrera dig på [OpenRouter](https://openrouter.ai), använd Anthropic/OpenAI direkt eller anslut ditt Claude Code-abonnemang (Enterprise eller Personal)
3. **Konfigurera** – Öppna tillägget och lägg till din API-nyckel (eller logga in med Claude) under Inställningar → API-leverantörer
4. **Börja bygga** – Öppna din ServiceNow-instans i en flik (den identifieras automatiskt) och börja chatta

## Exempel

### "Bygg en enkel app för att följa teamets uppgifter"
AppAgent skapar tabellen, lägger till fälten, bygger en formulär- och listlayout och konfigurerar en modul i navigatorn. En prompt, en komplett app.

### "Gör en fullständig granskning av den här instansen"
AppAgent söker efter säkerhetsluckor, inaktiva administratörskonton, inaktuella poster och bästa praxis för konfigurationen, och ger dig sedan en rapport med rekommendationer.

### "Testa den här sidan och rapportera alla problem du hittar"
AppAgent öppnar sidan i en webbläsarflik, fyller i formulär, klickar på knappar, tar skärmbilder och sammanställer en rapport om allt den hittar.

### "Det finns en bugg i det här formuläret, kan du fixa den?"
AppAgent öppnar formuläret, inspekterar skripten bakom det, identifierar buggen, rättar koden och visar exakt vad som ändrades. Ett klick för att ångra vid behov.

### "Skapa en widget på instrumentpanelen för mina öppna ärenden"
AppAgent skapar en levande widget som hämtar realtidsdata från din instans och visar dem på din instrumentpanel.

### "Importera den här Excel-filen till användartabellen"
AppAgent läser filen, mappar kolumner till fält och importerar data till din instans.

### "Kontrollera uppgraderingshistoriken och åtgärda problem med anpassningar"
AppAgent går igenom vad som ändrades i uppgraderingen, hittar trasiga anpassningar och åtgärdar dem.

### "Meddela teamet när en P1-incident skapas"
AppAgent skapar en aviseringsregel som utlöses av P1-incidenter och skickar en varning till ditt team.

---

## Visionen

Just nu är Opus 4.7 riktigt bra, men den behöver fortfarande en del tillsyn.

Vi kommer att fortsätta tänja på gränserna för vad AI-modellerna klarar av i varje generation och fortsätta klättra uppåt i abstraktionsnivåerna, tills vi kör fast.

GPT-4 => Kodkomplettering
GPT-4o => Skriver en fristående fil
Sonnet 3.5 => Redigerar en fil i en kodbas
Opus 4.5 => Skriver en komplett funktion
Opus 4.6 => Underhåller en app från början till slut
Opus 4.7 => ... (vi testar fortfarande)

---

## Färdplan

- RAG
- Specifikationer och testfall

I ingen särskild ordning.

Den här versionen är främst till för att samla in feedback.

Kommande versioner kanske inte blir öppen källkod, men vi kommer att fortsätta underhålla den här versionen tills den är stabil.

---

## Riktlinjer för bidrag

Öppna inga PR:er – det här är ett kommersiellt projekt och vi publicerar bara koden som öppen källkod för transparens och förtroende.

Om du hittar buggar kan du öppna ett ärende eller kontakta oss direkt. Vi erbjuder endast kommersiell support, så vi åtgärdar bara buggar som kan påverka andra användare.

---

## Licens

Privat och kommersiell användning. Intern modifiering tillåten. Distribution och vidareförsäljning förbjuden.
