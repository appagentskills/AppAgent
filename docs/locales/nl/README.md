# AppAgent

**Bouw en onderhoud ServiceNow-apps met een agent. Als Chrome-extensie.**

AppAgent is uw ontwikkelpartner voor ServiceNow. Het kan apps maken en onderhouden, en er tests voor uitvoeren. Het test door formulieren in te vullen en screenshots te maken. Geen technische kennis vereist.

U gebruikt uw eigen API-sleutel (BYOK), en dat is alles! Het is compatibel met OpenAI, OpenRouter, de Claude API en zelfs met Claude Code-abonnementen (neem hiervoor privé contact met ons op).

Het is een Chrome-extensie die de hele chat in uw browser opslaat (niets verlaat uw browser). Het communiceert alleen met uw ServiceNow-instantie en met de API-provider van uw model.

![Voorbeeld van AppAgent](AppAgentExample.png)

Het verbruikt minder tokens dan Claude Code, omdat het standaard sterk leunt op API-cache, caching van tools en het aaneenschakelen van tools.

U kunt er skills aan toevoegen, het bestuurt de browser via tabbladen en het heeft mechanische knoppen om alle wijzigingen die het op uw instantie aanbrengt ongedaan te maken.

> **Let op:** AppAgent is voorlopig alleen bedoeld voor gebruik op ontwikkelinstanties.

## Contact

Vul dit formulier in en we nemen contact met u op: [Contactformulier](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Functies

| Functie | Wat het doet |
|---------|--------------|
| **Uw eigen model** | Kies uit Claude, GPT, Gemini, Grok en meer |
| **Aanmelden met Claude** | OAuth-flow — gebruik uw bestaande Claude Code-abonnement (Personal of Enterprise), geen API-sleutel nodig |
| **Afbeeldingen en pdf's** | Voeg screenshots, diagrammen of documenten toe die de agent kan analyseren |
| **Code bewerken** | Leest en wijzigt scripts met volledige versietracering |
| **Browserbesturing** | Test zijn eigen werk: navigeert door tabbladen, klikt, vult formulieren in, maakt screenshots |
| **Live dashboards** | Maakt widgets die realtime gegevens van uw instantie ophalen |
| **Agent-skills** | Bouw uw eigen skills om de mogelijkheden van de agent uit te breiden |
| **Skill-acties** | Skills kunnen op de startpagina knoppen tonen die met één klik vooraf ingestelde workflows starten |
| **Live voortgang** | Zie in realtime wat de agent doet — voortgangslabels die meeveranderen met de status bezig/vastgelopen/klaar/fout |
| **Werkruimten** | Kladblok voor bestanden per chat — kloon GitHub-repository's, lees, schrijf, bewerk, vergelijk en wissel van branch. Meerdere repository's per chat, met bescherming van eigenaarschap tussen chats |
| **Geïntegreerde Git en GitHub-push** | De agent kan pullen van en pushen naar GitHub, branches aanmaken en pull requests openen, rechtstreeks vanuit de chat — geen terminal, geen IDE |
| **Slimme documenten** | Blijvende Markdown met versiebeheer die de agent kan bewerken en in verschillende chats kan gebruiken |
| **Meerdere instanties** | Detecteert automatisch elke ServiceNow-instantie die in uw browser open is; de agent kan ze allemaal zien en erop werken vanuit één chat |
| **Subagents** | Delegeert zwaar of parallel werk aan achtergrondagents die verslag uitbrengen aan de hoofdchat |
| **25 talen** | Interface en help in het Engels en 24 andere talen, waaronder Arabisch en Hebreeuws van rechts naar links |
| **Pauzeren en onderbreken** | Pauzeer of verzend halverwege een nieuw bericht — de lopende aanroep wordt direct afgebroken |
| **Zoeken op het web** | Gratis zoekopdrachten op het web zonder sleutel, via Google en DuckDuckGo |
| **Mechanisch ongedaan maken** | Elke wijziging wordt bijgehouden, met terugdraaien in één klik |
| **Exporteren naar XML** | Exporteer alle wijzigingen om ze op andere instanties uit te rollen |
| **Toolmachtigingen** | Ingebouwde beveiliging: bepaal wat de agent op de instantie mag doen |
| **Open standaarden** | Compatibel met [OpenRouter](https://openrouter.ai) en [AgentSkills.io](https://agentskills.io) |
| **Modelcaching** | Verlaagt de kosten tot 10x dankzij promptcaching |
| **Slimme context** | Laadt alleen de benodigde delen van grote bestanden. Overbelast het model niet |
| **Geen afhankelijkheden** | Geen bibliotheken, geen frameworks, puur vanilla JS |

## Hoe het werkt

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

AppAgent is een Chrome-extensie met een ingebouwde agentlus. U beschrijft wat u wilt → de agent vraagt het model → voert tools uit in de browser → werkt in ServiceNow met de machtigingen van uw huidige gebruiker. De agent communiceert rechtstreeks met de API-providers van modellen, on-premises of online.

## AppAgent vergeleken

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Doelgebruiker** | Niet-technisch | Ontwikkelaars | Ontwikkelaars | Niet-technische oprichters |
| **Gebouwd voor ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Agentische acties in ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Ontwikkelomgeving nodig** | ✗ | ✓ | ✓ | ✗ |
| **Bouwt apps** | ✓ | ✓ | ✓ | ✓ |
| **Browserbesturing om te testen** | ✓ | ✗ | ✗ | ✗ |
| **Maakt screenshots** | ✓ | ✗ | ✗ | ✗ |
| **Achtergrondtaken** | ✓ (via skill-acties) | ✗ | ✓ | ✗ |
| **Parallelle agents** | ✓ (subagents) | ✗ | ✓ | ✗ |
| **Mechanisch ongedaan maken** | ✓ | ✗ | ✗ | ✗ |
| **Afbeeldingen en pdf's** | ✓ | ✓ | ✓ | Beperkt |
| **Slimme dashboards** | ✓ | ✗ | ✗ | ✓ |
| **Uitbreidbare skills** | ✓ | ✓ | ✗ | ✗ |
| **Skill-acties (knoppen met één klik)** | ✓ | ✗ | ✗ | ✗ |
| **Live voortgangslabels** | ✓ | ✗ | ✗ | ✗ |
| **Ondersteuning voor meerdere instanties** | ✓ | ✗ | ✗ | ✗ |
| **Werkruimten per chat** | ✓ | ✗ | ✗ | ✗ |
| **Geïntegreerde git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Pushen naar GitHub vanuit de chat** | ✓ | ✓ (CLI) | Beperkt | ✗ |
| **Slimme documenten** | ✓ | ✗ | ✗ | ✗ |
| **Pauzeren / halverwege onderbreken** | ✓ | ✓ | Beperkt | ✗ |
| **Zoeken op het web** | ✓ | ✓ | ✓ | ✗ |
| **Toolmachtigingen** | ✓ | ✓ | Beperkt | ✗ |
| **Wijzigingen exporteren** | ✓ XML | ✓ | ✓ | ✓ |
| **Uw eigen model** | ✓ | ✗ | ✓ | ✗ |
| **Promptcaching** | ✓ | ✓ | ✓ | ✗ |
| **Slimme context** | ✓ | ✓ | ✓ | ✗ |
| **Geen afhankelijkheden** | ✓ | ✗ | ✗ | ✓ |

*Base44 kan geen ServiceNow-apps bouwen, maar staat erbij voor gebruikers die de ervaring ervan kennen.*

## Installatie

1. **Installeren** — Installeer de AppAgent-extensie via de Chrome Web Store (of laad deze uitgepakt voor ontwikkeling)
2. **Een API-sleutel regelen** — Meld u aan bij [OpenRouter](https://openrouter.ai), gebruik Anthropic/OpenAI rechtstreeks, of koppel uw Claude Code-abonnement (Enterprise of Personal)
3. **Configureren** — Open de extensie en voeg uw API-sleutel toe (of meld u aan met Claude) via Instellingen → API-providers
4. **Beginnen met bouwen** — Open uw ServiceNow-instantie in een tabblad (deze wordt automatisch gedetecteerd) en begin met chatten

## Voorbeelden

### "Bouw een eenvoudige app om teamtaken bij te houden"
AppAgent maakt de tabel, voegt de velden toe, bouwt een formulier- en lijstindeling en zet een module op in de navigator. Eén prompt, een complete app.

### "Voer een volledige audit uit op deze instantie"
AppAgent zoekt naar beveiligingslekken, inactieve beheerdersaccounts, verouderde records en best practices voor configuratie, en geeft u daarna een rapport met aanbevelingen.

### "Test deze pagina en meld alle problemen die je vindt"
AppAgent opent de pagina in een browsertabblad, vult formulieren in, klikt op knoppen, maakt screenshots en stelt een rapport op van alles wat het vindt.

### "Er zit een bug in dit formulier, kun je die oplossen?"
AppAgent opent het formulier, inspecteert de onderliggende scripts, vindt de bug, corrigeert de code en laat u precies zien wat er is gewijzigd. Eén klik om het zo nodig ongedaan te maken.

### "Maak een dashboardwidget voor mijn open tickets"
AppAgent maakt een live widget die realtime gegevens van uw instantie ophaalt en op uw dashboard toont.

### "Importeer dit Excel-bestand in de gebruikerstabel"
AppAgent leest het bestand, koppelt kolommen aan velden en importeert de gegevens in uw instantie.

### "Controleer de upgradegeschiedenis en los problemen met aanpassingen op"
AppAgent bekijkt wat er in de upgrade is gewijzigd, vindt kapotte aanpassingen en herstelt ze.

### "Waarschuw het team wanneer er een P1-incident wordt aangemaakt"
AppAgent maakt een meldingsregel die bij P1-incidenten wordt geactiveerd en een waarschuwing naar uw team stuurt.

---

## De visie

Op dit moment is Opus 4.7 geweldig, maar het heeft nog steeds wat begeleiding nodig.

We blijven bij elke generatie de grenzen verleggen van wat AI-modellen kunnen, en blijven hogerop in de abstractielagen gaan, tot we vastlopen.

GPT-4 => Code aanvullen
GPT-4o => Schrijft een losstaand bestand
Sonnet 3.5 => Bewerkt een bestand in een codebase
Opus 4.5 => Schrijft een complete functie
Opus 4.6 => Onderhoudt een app van begin tot eind
Opus 4.7 => ... (we zijn nog aan het testen)

---

## Roadmap

- RAG
- Specificaties en testcases

In willekeurige volgorde.

Deze versie is vooral bedoeld om feedback te verzamelen.

Volgende versies zijn mogelijk niet open source, maar we blijven deze versie onderhouden tot ze stabiel is.

---

## Richtlijnen voor bijdragen

Open alstublieft geen PR's: dit is een commercieel project en we publiceren de code alleen als open source voor zichtbaarheid en vertrouwen.

Als u bugs vindt, kunt u een issue openen of rechtstreeks contact met ons opnemen. We bieden alleen commerciële ondersteuning, dus we lossen alleen bugs op die ook andere gebruikers kunnen treffen.

---

## Licentie

Privé- en commercieel gebruik. Interne aanpassing toegestaan. Distributie en doorverkoop verboden.
