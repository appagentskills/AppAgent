# AppAgent

**Crea e gestisci app ServiceNow con un agente. Come estensione di Chrome.**

AppAgent è il tuo partner di sviluppo per ServiceNow. Può creare e gestire app ed eseguire i relativi test. Esegue i test compilando moduli e acquisendo screenshot. Non servono competenze tecniche.

Porti la tua chiave API (BYOK) e il gioco è fatto! È compatibile con OpenAI, OpenRouter, Claude API e perfino con i piani Claude Code (contattaci in privato).

È un'estensione di Chrome che conserva tutte le chat nel tuo browser (non escono mai dal browser). Interagisce soltanto con la tua istanza ServiceNow e con il provider API del tuo modello.

![Esempio di AppAgent](AppAgentExample.png)

Usa meno token di Claude Code, perché sfrutta ampiamente la cache delle API, la cache degli strumenti e il concatenamento degli strumenti (già pronti all'uso).

Puoi aggiungere skill, controlla il browser tramite le schede e offre pulsanti di annullamento meccanico per tutte le modifiche che apporta alla tua istanza.

> **Nota:** per ora AppAgent è pensato per l'uso solo su istanze di sviluppo.

## Contattaci

Compila questo modulo e ti ricontatteremo: [Modulo di contatto](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funzionalità

| Funzionalità | Cosa fa |
|---------|--------------|
| **Scegli il tuo modello** | Scegli tra Claude, GPT, Gemini, Grok e altri |
| **Accedi con Claude** | Flusso OAuth: usa il tuo piano Claude Code Personal o Enterprise, senza bisogno di una chiave API |
| **Immagini e PDF** | Allega screenshot, diagrammi o documenti da far analizzare all'agente |
| **Modifica del codice** | Legge e modifica gli script con il tracciamento completo delle versioni |
| **Controllo browser** | Verifica il proprio lavoro: naviga tra le schede, fa clic, compila moduli, acquisisce screenshot |
| **Dashboard dinamiche** | Crea widget che recuperano dati in tempo reale dalla tua istanza |
| **Skill dell'agente** | Crea le tue skill per estendere le capacità dell'agente |
| **Azioni delle skill** | Le skill possono mostrare nella home page pulsanti con un clic che avviano flussi di lavoro predefiniti |
| **Avanzamento in tempo reale** | Guarda cosa fa l'agente in tempo reale: pillole di avanzamento dinamiche con gli stati in corso/bloccato/completato/errore |
| **Workspace** | Area file per ogni chat: clona repository GitHub, leggi, scrivi, modifica, confronta e cambia branch. Più repository per chat, con protezione della proprietà tra chat |
| **Git e push su GitHub integrati** | L'agente può eseguire pull e push su GitHub, creare branch e aprire pull request direttamente dalla chat, senza terminale né IDE |
| **Documenti intelligenti** | Markdown persistente e con versioni che l'agente può modificare e richiamare tra le chat |
| **Più istanze** | Rileva automaticamente ogni istanza ServiceNow aperta nel browser; l'agente può vederle e agire su tutte da un'unica chat |
| **Sub-agenti** | Delega il lavoro pesante o parallelo ad agenti worker in background che riferiscono alla chat principale |
| **25 lingue** | Interfaccia e guida in inglese e in altre 24 lingue, tra cui arabo ed ebraico da destra a sinistra |
| **Pausa e interruzione** | Metti in pausa o invia un nuovo messaggio durante la risposta: la chiamata in corso si interrompe subito |
| **Ricerca web** | Ricerche web gratuite e senza chiave tramite Google e DuckDuckGo |
| **Annullamento meccanico** | Ogni modifica è tracciata, con ripristino in un clic |
| **Esportazione in XML** | Esporta tutte le modifiche per distribuirle su altre istanze |
| **Autorizzazioni strumenti** | Sicurezza integrata: controlla cosa può fare l'agente sull'istanza |
| **Standard aperti** | Compatibile con [OpenRouter](https://openrouter.ai) e [AgentSkills.io](https://agentskills.io) |
| **Cache del modello** | Riduce i costi fino a 10 volte grazie al prompt caching |
| **Contesto intelligente** | Carica solo le parti necessarie dei file di grandi dimensioni. Non sovraccarica il modello |
| **Zero dipendenze** | Nessuna libreria, nessun framework, solo JavaScript puro |

## Come funziona

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

AppAgent è un'estensione di Chrome con un ciclo agentico integrato. Descrivi cosa vuoi → L'agente interroga il modello → Esegue gli strumenti nel browser → Accede a ServiceNow con le autorizzazioni del tuo utente attuale. L'agente comunica direttamente con i provider API dei modelli, on-premise oppure online.

## Confronto con altri strumenti

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Utente di riferimento** | Non tecnico | Sviluppatori | Sviluppatori | Fondatori non tecnici |
| **Pensato per ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Azioni agentiche su ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Richiede un ambiente di sviluppo** | ✗ | ✓ | ✓ | ✗ |
| **Crea app** | ✓ | ✓ | ✓ | ✓ |
| **Controllo del browser per i test** | ✓ | ✗ | ✗ | ✗ |
| **Acquisisce screenshot** | ✓ | ✗ | ✗ | ✗ |
| **Attività in background** | ✓ (tramite le azioni delle skill) | ✗ | ✓ | ✗ |
| **Agenti in parallelo** | ✓ (sub-agenti) | ✗ | ✓ | ✗ |
| **Annullamento meccanico** | ✓ | ✗ | ✗ | ✗ |
| **Immagini e PDF** | ✓ | ✓ | ✓ | Limitato |
| **Dashboard intelligenti** | ✓ | ✗ | ✗ | ✓ |
| **Skill estensibili** | ✓ | ✓ | ✗ | ✗ |
| **Azioni delle skill (pulsanti con un clic)** | ✓ | ✗ | ✗ | ✗ |
| **Pillole di avanzamento in tempo reale** | ✓ | ✗ | ✗ | ✗ |
| **Supporto per più istanze** | ✓ | ✗ | ✗ | ✗ |
| **Workspace per chat** | ✓ | ✗ | ✗ | ✗ |
| **Git integrato** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push su GitHub dalla chat** | ✓ | ✓ (CLI) | Limitato | ✗ |
| **Documenti intelligenti** | ✓ | ✗ | ✗ | ✗ |
| **Pausa / interruzione durante la risposta** | ✓ | ✓ | Limitato | ✗ |
| **Ricerca web** | ✓ | ✓ | ✓ | ✗ |
| **Autorizzazioni strumenti** | ✓ | ✓ | Limitato | ✗ |
| **Esportazione delle modifiche** | ✓ XML | ✓ | ✓ | ✓ |
| **Scegli il tuo modello** | ✓ | ✗ | ✓ | ✗ |
| **Prompt caching** | ✓ | ✓ | ✓ | ✗ |
| **Contesto intelligente** | ✓ | ✓ | ✓ | ✗ |
| **Zero dipendenze** | ✓ | ✗ | ✗ | ✓ |

*Base44 non può creare app ServiceNow, ma è incluso per chi conosce già la sua esperienza d'uso.*

## Configurazione

1. **Installa**: installa l'estensione AppAgent dal Chrome Web Store (oppure caricala come estensione non pacchettizzata per lo sviluppo)
2. **Ottieni una chiave API**: registrati su [OpenRouter](https://openrouter.ai), usa direttamente Anthropic/OpenAI oppure collega il tuo abbonamento Claude Code (Enterprise o Personal)
3. **Configura**: apri l'estensione e aggiungi la tua chiave API (oppure accedi con Claude) in Impostazioni → Provider API
4. **Inizia a creare**: apri la tua istanza ServiceNow in una scheda (viene rilevata automaticamente) e inizia a chattare

## Esempi

### "Creami una semplice app per tenere traccia delle attività del team"
AppAgent creerà la tabella, aggiungerà i campi, costruirà il layout del modulo e dell'elenco e configurerà un modulo nel navigatore. Un solo prompt, un'app completa.

### "Esegui un audit completo di questa istanza"
AppAgent cercherà lacune di sicurezza, account amministratore inattivi, record obsoleti e scostamenti dalle best practice di configurazione, poi ti fornirà un rapporto con raccomandazioni.

### "Testa questa pagina e segnala eventuali problemi"
AppAgent aprirà la pagina in una scheda del browser, compilerà i moduli, farà clic sui pulsanti, acquisirà screenshot e redigerà un rapporto su tutto ciò che trova.

### "C'è un bug in questo modulo, puoi correggerlo?"
AppAgent aprirà il modulo, esaminerà gli script che lo gestiscono, individuerà il bug, correggerà il codice e ti mostrerà esattamente cosa è cambiato. Un clic per annullare, se necessario.

### "Crea un widget della dashboard per i miei ticket aperti"
AppAgent creerà un widget dinamico che recupera dati in tempo reale dalla tua istanza e li mostra nella tua dashboard.

### "Importa questo file Excel nella tabella degli utenti"
AppAgent leggerà il file, associerà le colonne ai campi e importerà i dati nella tua istanza.

### "Controlla la cronologia degli upgrade e correggi i problemi di personalizzazione"
AppAgent esaminerà cosa è cambiato con l'upgrade, troverà le personalizzazioni non più funzionanti e le correggerà.

### "Avvisa il team quando viene creato un incidente P1"
AppAgent creerà una regola di notifica che si attiva sugli incidenti P1 e invia un avviso al tuo team.

---

## La visione

Oggi Opus 4.7 è ottimo, ma ha ancora bisogno di un po' di supervisione.

Continueremo a spingere al limite ciò di cui i modelli di IA sono capaci a ogni generazione e a salire lungo la scala dell'astrazione, finché non ci fermeremo.

GPT-4 => Completamento del codice
GPT-4o => Scrive un file autonomo
Sonnet 3.5 => Modifica un file in una codebase
Opus 4.5 => Scrive una funzionalità completa
Opus 4.6 => Gestisce un'app dall'inizio alla fine
Opus 4.7 => ... (lo stiamo ancora testando)

---

## Roadmap

- RAG
- Specifiche e casi di test

In nessun ordine particolare.

Questa versione serve soprattutto a raccogliere feedback.

Le prossime versioni potrebbero non essere open source, ma continueremo a mantenere questa versione finché non sarà stabile.

---

## Linee guida per i contributi

Non aprire PR: questo è un progetto commerciale e rendiamo pubblico il codice solo per trasparenza e fiducia.

Se trovi dei bug, puoi aprire una issue o contattarci direttamente. Offriamo solo supporto commerciale, quindi correggeremo solo i bug che possono interessare altri utenti.

---

## Licenza

Uso privato e commerciale. Modifica interna consentita. Distribuzione e rivendita vietate.
