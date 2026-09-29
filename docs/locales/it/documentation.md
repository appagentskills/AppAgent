# Per iniziare {#getting-started}

AppAgent è un agente di IA per ServiceNow che funziona come estensione di Chrome. Descrivi ciò che ti serve in linguaggio naturale e l'agente interroga i dati, modifica i record, crea app e widget, testa le pagine nel tuo browser e ti riferisce i risultati.

:::tip
**Avvio rapido:** configura un modello, apri una scheda sulla tua istanza ServiceNow, poi scrivi una richiesta nella chat e premi <kbd>Enter</kbd>.
:::

## Configura un modello {#guide-setup}

1. Apri le [Impostazioni](app:openSettingsPageView) e vai a **Provider API**
2. Aggiungi un provider (Anthropic, OpenRouter o un'API personalizzata compatibile con OpenAI) con la tua chiave API, oppure attiva **OAuth** su un provider Anthropic per accedere con il tuo account Claude
3. Scegli il modello da usare in **Modello dell'agente**

La tua chiave API è memorizzata solo nel tuo browser. Le chiamate all'IA passano direttamente dal browser al provider.

## Collega le tue istanze {#guide-instances}

AppAgent **rileva automaticamente ogni istanza ServiceNow** aperta nello stesso profilo di Chrome: non c'è nessuna stringa di connessione da inserire. Accedi a un'istanza in una normale scheda e l'agente potrà lavorarci con i ruoli e i diritti di accesso del tuo utente. Chiedi *"elenca le istanze"* per vedere ogni istanza rilevata, i tuoi ruoli e lo stato della connessione.

Ogni istanza ha un **livello di autorizzazione**, che si sceglie dal menu a discesa dell'istanza:

- **Manuale**: approvi tu ogni operazione di scrittura (creazione, aggiornamento, eliminazione, compilazione di moduli)
- **Auto**: l'agente decide sulle operazioni di scrittura senza chiedere
- **Dev**: nessuna approvazione, ogni chiamata a uno strumento su questa istanza viene eseguita senza chiedere. Usalo solo su istanze di sviluppo

Le letture sono sempre consentite. Vedi [Autorizzazioni strumenti](#feature-permissions) per un controllo più preciso.

## Avvia una chat {#guide-chat}

1. Fai clic su **Nuova chat** nella barra laterale [Avvia una nuova chat →](app:startNewChat)
2. Scrivi la tua richiesta, per esempio *"Mostrami tutti gli incidenti creati oggi"*
3. Premi <kbd>Enter</kbd> per inviare
4. Segui il lavoro dell'agente: ogni chiamata a uno strumento compare nella chat e, quando un passaggio richiede il tuo consenso, compare una richiesta di approvazione

Puoi continuare a scrivere mentre l'agente lavora: inviare un nuovo messaggio interrompe il passaggio in corso e **Pausa** ferma l'esecuzione.

## Allega immagini e file {#guide-images}

1. Fai clic sul pulsante **Allega file** nell'area di inserimento per aggiungere un'immagine, un PDF, un CSV o un file di testo
2. Oppure incolla un'immagine dagli appunti, o trascinala nella chat
3. Scrivi la tua domanda sull'allegato

:::tip
Allega screenshot di errori, mockup dell'interfaccia o dati esportati, così l'agente vede esattamente ciò che vedi tu.
:::

# Funzionalità principali {#features}

## Chat {#page-chat}

La vista principale della conversazione. [Avvia una nuova chat →](app:startNewChat)

- **Area dei messaggi**: la conversazione, comprese le chiamate agli strumenti e i relativi risultati
- **Casella di inserimento**: scrivi i messaggi, allega file, invia mentre l'agente lavora per interromperlo
- **Pausa / Continua / Riprova**: ferma l'agente, riprendi l'esecuzione o riprova l'ultimo passaggio
- **Indicatore di contesto**: mostra quanto è piena la conversazione; fai clic per riassumerla in una nuova chat
- **Schede di risposta**: sotto una risposta possono comparire un riepilogo **In breve** e una scheda **Link** (record, PR, documenti)
- **Intestazione della chat**: rinomina o fissa la chat, oppure apri AppAgent in una scheda completa del browser con **Espandi a pagina intera**

## Controllo del browser {#feature-browser}

L'agente può aprire e controllare le schede del browser sulla tua istanza per vedere e testare le pagine:

- **Navigare, fare clic, compilare e selezionare**: eventi realistici, così moduli e campi con completamento automatico si comportano come se scrivessi tu
- **Attendere**: attende un elemento, un testo o un URL invece di indovinare i tempi
- **Screenshot**: acquisisce la pagina, un widget o un singolo elemento per i controlli visivi
- **Ispezionare**: legge proprietà e stili degli elementi, errori della console e richieste di rete
- **Impersonare**: esegue test come un altro utente, poi torna indietro

## Modifica dei record e cronologia versioni {#feature-history}

Ogni modifica che l'agente apporta alla tua istanza viene tracciata nella barra laterale della chat:

- **Annulla**: annulla una singola modifica
- **Ripeti**: ripristina una modifica annullata
- **Scarica XML**: esporta tutte le modifiche, per esempio per spostarle su un'altra istanza

## Sub-agenti {#feature-subagents}

Per il lavoro pesante o parallelo, l'agente può avviare dei **sub-agenti**: worker in background che vengono eseguiti in una propria chat e con un proprio contesto, poi riportano un breve risultato alla chat principale.

- **Livelli di modello**: ogni sub-agente viene eseguito su un livello **small**, **medium** o **large**, oppure **same** per usare il modello dell'agente principale. Associa i livelli ai modelli in [Impostazioni](app:openSettingsPageView) → **Livelli di modello dei sub-agent**
- **Barra dei worker**: i sub-agenti in esecuzione compaiono come chip dinamici sopra la casella della chat; aprine uno per seguirne l'avanzamento o leggerne la trascrizione
- **Pool**: il numero di sub-agenti simultanei è limitato; quelli in eccesso attendono in coda

## Dashboard e widget {#page-dashboard}

Una dashboard di widget interattivi generati dall'agente. [Apri dashboard →](app:openDashboardView)

1. Fai clic su **Aggiungi widget**
2. Descrivi ciò che vuoi, per esempio *"Un grafico degli incidenti aperti per priorità"*
3. L'agente crea il widget; chiedi modifiche o fai clic su **Rigenera** in qualsiasi momento

I widget possono recuperare dati in tempo reale dalla tua istanza, quindi restano sempre aggiornati. Puoi trascinarli, ridimensionarli, importarli ed esportarli (vedi [Avanzate](#advanced)). I widget che l'agente mostra all'interno di una chat possono essere salvati con **Fissa nella dashboard**.

## Documenti intelligenti {#page-documents}

I **Documenti intelligenti** sono documenti Markdown persistenti e con versioni che l'agente scrive e aggiorna: piani, rapporti, specifiche, risultati. Vengono visualizzati direttamente nella chat, conservano ogni versione e puoi modificarli tu stesso. Aprili da **Documenti** nella barra laterale. [Apri documenti →](app:openDocumentsView)

## Skill {#page-skills}

Le skill forniscono all'agente conoscenze e strumenti aggiuntivi. [Apri skill →](app:openSkillsView)

- **Attiva / Disattiva**: attiva o disattiva le skill; disattiva quelle che non ti servono per mantenere le risposte mirate
- **Nuova skill**: scrivi una skill personalizzata in Markdown, oppure usa **Modifica con l'agente**
- **Importa / Esporta**: condividi le skill come cartelle
- **Azioni delle skill**: alcune skill aggiungono nella home page pulsanti con un clic che avviano un flusso di lavoro predefinito

Una skill può fornire **conoscenze** (istruzioni, best practice) e **strumenti personalizzati** (funzioni JavaScript eseguite in una sandbox isolata).

## Workspace e GitHub {#feature-workspace}

Ogni chat ha un **workspace**: un'area file in cui l'agente può leggere, scrivere, modificare e confrontare file.

- **GitHub**: collega un account GitHub nelle [Impostazioni](app:openSettingsPageView) per clonare repository in un workspace. L'agente può creare branch, eseguire il push dei commit e aprire pull request dalla chat
- **Pull request**: le PR aperte da una chat sono elencate nella barra laterale della chat, con un pulsante **Merge**
- **Protezione tra chat**: ogni file ricorda quale chat lo ha modificato, così due chat che lavorano in parallelo non sovrascrivono di nascosto il lavoro l'una dell'altra
- **Sincronizzazione automatica**: i workspace clonati si sincronizzano con GitHub quando navighi, cambi chat o torni alla scheda

## Barra laterale della chat {#feature-sidebar}

La barra laterale destra raccoglie tutto ciò che la chat corrente ha prodotto:

- **Pull request**: titolo, branch di destinazione e un pulsante **Merge**
- **File del workspace**: apri un file per visualizzarlo, vederne le differenze o sfogliarne le versioni precedenti
- **Cronologia versioni**: le modifiche all'istanza con **Annulla**, **Ripeti** e **Scarica XML**
- **Worker**: i sub-agenti in esecuzione e terminati, con i contatori di chiamate agli strumenti, file modificati e PR aperte

## Azioni e avanzamento in tempo reale {#feature-actions}

Le attività lunghe mostrano l'avanzamento in tempo reale invece di restare in silenzio:

- **Scheda di avanzamento**: un'unica scheda con uno stato colorato (in corso, bloccato, completato, errore) e un elenco di passaggi
- **Pulsanti di azione**: pulsanti con un clic che avviano i flussi di lavoro successivi
- **Indicatore di esecuzione**: l'elenco delle chat segnala quelle in cui l'agente sta lavorando
- **Notifica "Agente terminato"**: se cambi scheda o finestra durante un'esecuzione, una notifica sul desktop ti avvisa quando l'agente ha finito

## Chat e processi attivi {#feature-jobs}

La pillola dei processi nell'intestazione apre una vista in tempo reale delle tue chat e delle attività in background:

- **Chat attive**: le chat in esecuzione e quelle con risultati non letti (in **grassetto**), ciascuna con un anello di utilizzo del contesto
- **Sub-agenti**: elencati sotto la chat principale da cui dipendono; aprine uno per leggerne la trascrizione
- **Espandi**: apri l'elenco in un pannello più grande, con layout a colonne o a sezioni

## Autorizzazioni strumenti {#feature-permissions}

Oltre al livello di autorizzazione per istanza (**Manuale**, **Auto**, **Dev**), ogni strumento ha una propria impostazione in [Impostazioni](app:openSettingsPageView) → **Autorizzazioni strumenti**:

- **Consenti**: lo strumento viene sempre eseguito senza chiedere
- **Auto**: lo strumento viene eseguito senza chiedere, a meno che l'agente non segnali che una chiamata richiede la tua conferma
- **Chiedi**: ricevi una richiesta di approvazione prima di ogni chiamata
- **Disattivato**: l'agente non può usare lo strumento

Alcuni strumenti offrono controlli più precisi: l'API di ServiceNow per metodo HTTP (GET, POST, PUT, PATCH, DELETE), il controllo del browser per azione (navigazione, clic, compilazione, impersonificazione…) e la gestione delle skill per azione. Le finestre di conferma hanno un colore in base al rischio: **blu** (ordinaria amministrazione), **arancione** (attenzione), **rosso** (distruttiva).

:::tip
Lascia DELETE e le altre operazioni distruttive su **Chiedi** e usa **Dev** solo su istanze di sviluppo.
:::

## Strumenti dell'agente {#feature-tools}

I principali strumenti usati dall'agente:

| Strumento | Cosa fa |
|------|--------------|
| **API di ServiceNow** (`servicenow_api`) | Legge, crea, aggiorna ed elimina record |
| **Script in background** (`servicenow_run_script`) | Esegue uno script lato server sull'istanza (richiede il ruolo admin) |
| **Modifiche agli script** (`servicenow_diff_edit`) | Modifica gli script con sostituzioni cerca-e-sostituisci precise |
| **Controllo del browser** (`iframe_tool`) | Naviga, fa clic, compila, ispeziona e impersona nelle schede del browser |
| **Codice nel browser** (`js_eval`) | Esegue JavaScript in una sandbox isolata che può chiamare altri strumenti |
| **Screenshot** (`take_screenshot`) | Acquisisce la pagina, un widget o un elemento |
| **Widget e schede** (`html_widget`, `display`) | Mostra nella chat widget interattivi, tabelle, schede e timeline |
| **Documenti intelligenti** (`document`) | Crea e aggiorna documenti Markdown persistenti |
| **Richiesta all'utente** (`prompt_user`) | Ti chiede informazioni con un modulo nella chat |
| **Sub-agenti** (`spawn_sub_agent`) | Delega il lavoro a worker in background |
| **Workspace** (`workspace`) | Lavora con file e repository GitHub |
| **Recupero web** (`web_fetch`) | Legge pagine del web pubblico |
| **Skill** (`get_skill`, `manage_skill`) | Legge e gestisce le skill |

Apri [Impostazioni](app:openSettingsPageView) → **Autorizzazioni strumenti** per vedere ogni strumento, la sua origine e la sua autorizzazione.

## Cache dei contenuti di grandi dimensioni {#feature-caching}

Quando il risultato di uno strumento è troppo grande per la conversazione (oltre 4K token per impostazione predefinita), AppAgent lo memorizza nella cache. L'agente riceve una struttura riassuntiva e poi legge, cerca o sfoglia solo le parti che gli servono. In questo modo le chat restano veloci e mirate. Modifica la soglia (da 1K a 100K token) in [Impostazioni](app:openSettingsPageView) → **Cache dei contenuti di grandi dimensioni**.

## Indicatore di contesto {#feature-saturation}

L'**indicatore di contesto** accanto alla casella della chat mostra quanto è piena la conversazione. Oltre il 50% all'agente viene chiesto di concludere e di affidare il lavoro pesante rimanente ai sub-agenti; al 100% si ferma e riferisce. Fai clic sull'indicatore in qualsiasi momento per riassumere la conversazione in una nuova chat.

## Utilizzo e limiti di frequenza {#feature-usage}

- **Pillola di utilizzo**: l'intestazione mostra il tuo utilizzo delle API e i limiti rimanenti; fai clic per i dettagli
- **Nuovi tentativi automatici**: quando il provider applica limiti di frequenza o è sovraccarico (HTTP 429 / 529), AppAgent attende e riprova automaticamente, mostrando un conto alla rovescia nella chat
- **Crediti esauriti**: quando un errore 429 significa in realtà che i tuoi crediti sono esauriti, la chat lo indica chiaramente

## Lingue {#feature-languages}

L'interfaccia è disponibile in inglese e in altre 24 lingue: arabo, ceco, cinese (semplificato, tradizionale), coreano, danese, ebraico, finlandese, francese (Francia, Canada), giapponese, italiano, norvegese, olandese, polacco, portoghese (Brasile, Portogallo), russo, spagnolo, svedese, tailandese, tedesco, turco e ungherese.

Sceglila in [Impostazioni](app:openSettingsPageView) → **Lingua**, oppure dal menu delle impostazioni rapide nell'intestazione. **Auto** segue la lingua del browser e, se non è disponibile, usa l'inglese. La modifica si applica subito, senza ricaricare.

- **Da destra a sinistra**: arabo ed ebraico usano un layout da destra a sinistra
- **Formati locali**: date, orari e numeri seguono la tua lingua
- **Risposte dell'agente**: l'agente risponde nella lingua scelta, a meno che tu non scriva in un'altra. Codice, nomi di tabelle e di campi restano invariati
- **Questa pagina della guida**: viene mostrata nella tua lingua; il changelog resta in inglese

# Pagine e impostazioni {#pages}

## Impostazioni {#page-settings}

[Apri impostazioni →](app:openSettingsPageView)

- **Modello dell'agente**: il modello usato dall'agente
- **Provider API**: Anthropic, OpenRouter o provider personalizzati, con chiave API o OAuth
- **Endpoint LLM**: coppie `URL + API key` con nome per qualsiasi API compatibile con OpenAI
- **Livelli di modello dei sub-agent**: associa i livelli small, medium e large ai modelli, oppure scegli **Stesso**
- **Impegno di ragionamento, Token massimi e Budget di thinking**: regola profondità e lunghezza delle risposte
- **Finestra di contesto**: la dimensione del contesto usata dall'indicatore di contesto
- **Visualizzazione**: statistiche API, modalità compatta, mantieni lo schermo attivo
- **Lingua**: la lingua dell'interfaccia, oppure **Auto**
- **Hook**: titoli automatici delle chat, notifiche "Agente terminato" e altre automazioni
- **Cache dei contenuti di grandi dimensioni**: quando i risultati di grandi dimensioni vengono memorizzati nella cache
- **Autorizzazioni strumenti**: cosa viene eseguito automaticamente, cosa chiede prima e cosa è disattivato
- **GitHub**: collega un account GitHub e gestisci i repository clonati
- **Prompt di sistema**: personalizza le istruzioni dell'agente
- **Gestione dei dati**: esporta, importa o elimina i tuoi dati

## Cronologia {#page-history}

Tutte le tue conversazioni. [Apri cronologia →](app:openHistoryView)

- **Cerca**: trova le chat per titolo, contenuto, strumenti usati o widget
- **Fissa**: tieni in cima le chat importanti
- **Esporta**: scarica una singola chat o l'intera cronologia
- **Statistiche**: numero di chat, chat fissate e costo totale

## Guida {#page-docs}

Questa pagina. [Apri guida →](app:openDocsView)

- **Cerca**: filtra gli argomenti della guida dalla casella di ricerca nella barra degli strumenti
- **Indice**: passa a una sezione dalla struttura della pagina
- **Scarica**: salva la documentazione come file Markdown

# Suggerimenti e scorciatoie da tastiera {#tips}

| Azione | Come |
|--------|-----|
| Inviare un messaggio | <kbd>Enter</kbd> |
| Andare a capo | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Cercare nelle chat | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> su Mac) |
| Chiudere una finestra di dialogo o un menu | <kbd>Esc</kbd> |
| Tornare indietro | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Allegare un'immagine | Incollala, oppure trascinala nella chat |
| Ricominciare con un riepilogo | Fai clic sull'indicatore di contesto |
| Interrompere l'agente | Invia un nuovo messaggio, oppure fai clic su **Pausa** |

:::tip
**Sii specifico.** Invece di *"correggi questo"*, scrivi *"correggi l'errore di riferimento null alla riga 42 della script include MyUtils"*. Quando puoi, indica la tabella, il record o la pagina.
:::

- **Un obiettivo per chat**: avvia una nuova chat per un'attività non correlata; l'agente resta più veloce e preciso
- **Lascialo testare**: chiedi all'agente di aprire la pagina e di verificare la propria modifica con uno screenshot
- **Usa le skill**: prima di iniziare, attiva una skill adatta alla tua attività (per esempio test o audit)

# Risoluzione dei problemi e domande frequenti {#faq}

### L'agente non vede la mia istanza

Apri l'istanza in una scheda dello stesso profilo di Chrome e assicurati di aver effettuato l'accesso, poi chiedi *"elenca le istanze"*. Se ancora non compare, ricarica la scheda dell'istanza.

### Ricevo un errore dell'API o di autenticazione

Controlla il tuo provider in [Impostazioni](app:openSettingsPageView) → **Provider API**: la chiave API, l'endpoint selezionato e il nome del modello. Per OAuth, accedi di nuovo a claude.ai nello stesso profilo di Chrome.

### L'agente dice di aver raggiunto un limite di frequenza

AppAgent riprova automaticamente e mostra un conto alla rovescia. Se succede spesso, controlla i crediti rimanenti nella pillola di utilizzo, oppure usa un livello di modello più piccolo per i sub-agenti.

### Troppe richieste di approvazione, o troppo poche

Cambia il livello di autorizzazione dell'istanza (**Manuale**, **Auto**, **Dev**) dal menu a discesa dell'istanza e regola i singoli strumenti in [Impostazioni](app:openSettingsPageView) → **Autorizzazioni strumenti**.

### In una chat lunga le risposte diventano più lente o meno precise

La conversazione sta riempiendo il suo contesto. Fai clic sull'indicatore di contesto per continuare in una nuova chat con un riepilogo.

### Come annullo una modifica?

Apri la barra laterale della chat e fai clic su **Annulla** accanto alla modifica nella cronologia versioni. **Scarica XML** esporta tutte le modifiche.

### Dove sono memorizzati i miei dati?

In locale nel tuo browser (IndexedDB). Le chat non passano mai da un server di AppAgent, ma solo dal tuo provider di IA e dalla tua istanza ServiceNow. Vedi [Archiviazione dei dati](#adv-data-storage).

### L'interfaccia o questa pagina è nella lingua sbagliata

Scegli la lingua in [Impostazioni](app:openSettingsPageView) → **Lingua**. **Auto** segue la lingua del browser.

# Avanzate {#advanced}

Questa sezione tratta le funzionalità avanzate, i pulsanti delle intestazioni, i formati di importazione/esportazione e i dettagli tecnici sul funzionamento di AppAgent.

## Pulsanti dell'intestazione della dashboard {#adv-dashboard-header}

L'intestazione della dashboard contiene diversi pulsanti di azione:

| Pulsante | Descrizione |
|--------|-------------|
| **Mostra/nascondi barra laterale** | Mostra o nasconde la barra di navigazione laterale sinistra |
| **Apri in una pagina separata** | Apre la dashboard in una nuova scheda del browser per una visualizzazione autonoma |
| **Intestazioni** | Mostra o nasconde le intestazioni dei widget nella dashboard. Quando sono nascoste, i widget appaiono in una vista più pulita |
| **Rigenera tutto** | Rigenera con l'agente tutti i widget della dashboard. Utile per aggiornare i dati |
| **Importa** | Importa una dashboard o un widget da un file JSON |
| **Esporta** | Esporta l'intera dashboard in un file JSON per backup o condivisione |
| **Aggiungi widget** | Apre l'editor dei widget per creare un nuovo widget con l'aiuto dell'agente |

## Pulsanti dell'intestazione dei widget {#adv-widget-headers}

**Intestazioni dei widget della dashboard** (visibili quando l'opzione Intestazioni è attiva):

| Pulsante | Descrizione |
|--------|-------------|
| **Maniglia di trascinamento** | L'icona del widget funge da maniglia per riordinare i widget |
| **Rigenera** | Chiede all'agente di rigenerare il contenuto di questo widget |
| **Cronologia** | Mostra le versioni precedenti di questo widget (se disponibili) |
| **Schermo intero** | Espande il widget a schermo intero |
| **Modifica** | Apre l'editor dei widget per modificarlo tramite la chat con l'agente |
| **Elimina** | Rimuove il widget dalla dashboard (con conferma) |

**Intestazioni dei widget della chat** (widget all'interno della chat):

| Pulsante | Descrizione |
|--------|-------------|
| **Fissa nella dashboard** | Salva questo widget nella tua dashboard |
| **Modifica codice** | Mostra e modifica direttamente il codice HTML/CSS/JS del widget |
| **Espandi/Comprimi** | Mostra o nasconde il contenuto del widget |

## Ridimensionare e spostare i widget {#adv-resize-move}

**Ridimensionare i widget:**

- Ogni widget ha una **maniglia di ridimensionamento** nell'angolo in basso a destra
- Fai clic sulla maniglia e trascinala per ridimensionare il widget
- La larghezza si allinea a una griglia di 12 colonne (minimo 3 colonne)
- L'altezza si misura in unità da 50px (minimo 2 unità = 100px)

**Spostare i widget:**

- Attiva l'opzione **Intestazioni** per mostrare le intestazioni dei widget
- Fai clic sull'**icona del widget** (maniglia di trascinamento) e trascinala per riordinare
- Rilascia il widget su un altro widget per scambiarne la posizione
- L'ordine dei widget viene salvato automaticamente

## Formati di importazione/esportazione {#adv-import-export}

**Esportazione della dashboard** (`dashboard-YYYY-MM-DD.json`):

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

**Esportazione di un singolo widget:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Esportazione di una singola chat** (`chat-title-YYYY-MM-DD.json`):

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

Le esportazioni delle chat conservano l'intera cronologia della conversazione, compresi tutti i messaggi dell'utente e le risposte dell'agente. Usa il menu a discesa della chat (···) e seleziona **Scarica** per esportare singole chat.

**Esportazione delle skill** (struttura delle cartelle):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Nota:** l'importazione/esportazione delle skill usa la File System Access API e **funziona solo nei browser Chrome o Edge**.
:::

**Esportazione di tutti i dati** (`appagent-backup-YYYY-MM-DD.json`):

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

Il backup completo include tutta la cronologia delle chat, le impostazioni, le autorizzazioni degli strumenti, i widget della dashboard e le configurazioni dei provider API.

## Statistiche API {#adv-api-stats}

Se attivate nelle Impostazioni, le statistiche API vengono mostrate dopo ogni risposta dell'agente:

| Metrica | Descrizione |
|--------|-------------|
| **In** | Token di input: la dimensione del prompt inviato all'agente |
| **Out** | Token di output: la dimensione della risposta dell'agente |
| **Totale** | Somma dei token di input e di output |
| **Lettura/scrittura cache** | Token letti dalla cache dei prompt o scritti in essa (riduce i costi) |
| **Ragionamento** | Token usati per il ragionamento interno (alcuni modelli) |
| **Costo** | Costo stimato della chiamata API in USD |
| **Durata** | Tempo impiegato dalla chiamata API |

Per le conversazioni con più turni, le statistiche aggregate mostrano il totale di tutte le chiamate.

:::tip
Attiva o disattiva la visualizzazione delle statistiche API in [Impostazioni](app:openSettingsPageView) → Visualizzazione → Mostra statistiche API.
:::

## Modifica manuale delle skill {#adv-skills-manual}

Le skill si possono creare e modificare manualmente o con l'aiuto dell'agente:

**Creare una skill manualmente:**

1. Vai a [Skill](app:openSkillsView) e fai clic su **Nuova skill**
2. Inserisci un nome e una descrizione per la skill
3. Scrivi il contenuto della skill in formato Markdown
4. Fai clic su **Salva** per creare la skill

**Formato di SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Modificare con l'agente:**

1. Fai clic su **Modifica con l'agente** su una skill qualsiasi
2. Descrivi le modifiche che desideri
3. L'agente modificherà il contenuto della skill
4. Controlla e salva le modifiche

**Risorse delle skill:** le skill possono includere file aggiuntivi (XML, JS, MD) che forniscono all'agente contesto o codice extra.

## Prompt di sistema {#adv-system-prompt}

Il prompt di sistema definisce il comportamento e le capacità dell'agente. Puoi personalizzarlo nelle [Impostazioni](app:openSettingsPageView).

**Modificare il prompt di sistema:**

1. Vai alla sezione Impostazioni → Prompt di sistema
2. Fai clic su **Modifica** per passare alla modalità di modifica
3. Modifica il modello come necessario
4. Fai clic su **Salva** per applicare le modifiche

**Segnaposto disponibili:**

| Segnaposto | Descrizione |
|-------------|-------------|
| `{{CURRENT_DATE}}` | La data di oggi (giorno della settimana, mese, giorno, anno) |
| `{{ORCHESTRATOR_POLICY}}` | Criterio di delega ai sub-agenti: incluso nelle chat principali, lasciato vuoto nelle chat dei sub-agenti |
| `{{DISABLED_TOOLS}}` | Elenco degli strumenti disattivati |
| `{{TOOL_CATALOG}}` | Catalogo degli strumenti differiti (vuoto quando il caricamento differito degli strumenti è disattivato) |
| `{{SKILLS_SUMMARY}}` | Contenuto delle skill attive |

I segnaposto vengono sostituiti automaticamente con i valori effettivi al momento dell'invio all'IA. Il conteggio dei token mostra sia la dimensione del modello sia quella espansa.

:::tip
Se necessario, fai clic su **Ripristina predefinito** per ripristinare il prompt di sistema originale.
:::

## Chiamate API dell'agente {#adv-agent-api}

AppAgent funziona come **estensione di Chrome**:

- Le chiamate alle API di IA passano **direttamente dal tuo browser al provider di IA** (ad es. Anthropic, OpenRouter)
- **Non** passano dalla tua istanza né da alcun server di AppAgent
- La tua chiave API (o il token OAuth) è memorizzata in locale nel tuo browser
- I dati della conversazione vengono inviati al provider di IA per l'elaborazione

**Come funziona:**

1. Scrivi un messaggio nella chat
2. AppAgent costruisce un prompt con le istruzioni di sistema, gli strumenti e la cronologia della conversazione
3. Il prompt viene inviato all'API del provider di IA
4. La risposta dell'agente arriva in streaming nel tuo browser
5. Le chiamate agli strumenti vengono eseguite nel tuo browser, usando la sessione della tua istanza per le chiamate API

:::tip
**Privacy:** la tua chiave API e i dati della conversazione vengono gestiti lato client. Le chiamate agli strumenti che interagiscono con la tua istanza usano le credenziali della sessione già attiva.
:::

## Endpoint LLM {#adv-endpoints}

I modelli si collegano tramite **endpoint LLM con nome**: coppie `URL + API key` riutilizzabili. In questo modo puoi indirizzare AppAgent verso **qualsiasi API di chat completion compatibile con OpenAI**: OpenRouter, un gateway locale, un proxy o un modello ospitato da te.

1. In [Impostazioni → Endpoint LLM](app:openSettingsPageView), fai clic su **Aggiungi endpoint**
2. Assegnagli un nome, l'URL dell'API e una chiave API
3. Ogni modello (provider API) sceglie un endpoint: aggiorna una chiave una sola volta e tutti i modelli che la usano vengono aggiornati

:::tip
I provider Claude con **OAuth** non usano gli endpoint: comunicano direttamente con `api.anthropic.com`.
:::

## Accedi con Claude (OAuth) {#adv-oauth}

Invece di incollare una chiave API, puoi accedere ai provider Anthropic usando la tua sessione claude.ai esistente:

1. In [Impostazioni → Provider API](app:openSettingsPageView), aggiungi o modifica un provider Anthropic e attiva **OAuth**
2. L'estensione usa il tuo accesso a claude.ai dallo stesso profilo di Chrome per collegarsi direttamente ad Anthropic
3. Nessuna finestra di accesso aggiuntiva e nessun server di AppAgent nel mezzo

**Requisiti:**

- Devi aver effettuato l'accesso a `claude.ai` nello stesso profilo di Chrome
- Funziona con gli account Single Sign-On (SSO)

:::tip
I token OAuth vengono aggiornati automaticamente. Se l'accesso non riesce, apri `claude.ai` nello stesso profilo e accedi di nuovo.
:::

## Considerazioni sulla sicurezza {#adv-security}

**Archiviazione della chiave API:**

- La tua **chiave API è memorizzata in locale** nell'IndexedDB del browser
- La chiave non viene mai inviata alla tua istanza né ad altri server oltre al provider di IA
- Cancellando i dati del browser verrà rimossa la chiave API memorizzata

**Sessione e autorizzazioni:**

- L'agente lavora con la tua **sessione utente corrente**, ereditandone diritti di accesso e ruoli
- Tutte le chiamate API alla tua istanza usano le credenziali della tua sessione
- L'agente può accedere solo a ciò a cui può accedere il tuo account utente

**Ambiente di esecuzione degli strumenti:**

- **Codice nel browser (js_eval)** esegue JavaScript in una **sandbox isolata** con accesso solo a `executeTool()`
- Gli **script dei widget** vengono eseguiti in **iframe isolati** con accesso solo a `executeTool()` per le chiamate API
- Gli **strumenti delle skill** vengono eseguiti in **sandbox isolate** con accesso solo a `executeTool()`
- Ogni accesso alle API passa dal **sistema di autorizzazioni** tramite `executeTool("servicenow_api", {...})`
- L'agente interagisce con le pagine nelle **schede del browser** sulla tua istanza ServiceNow

**Capacità di modifica dei record:**

- Lo strumento **API di ServiceNow** supporta i metodi POST, PATCH, PUT e DELETE, che possono modificare i record
- L'agente può creare e modificare record tramite il **browser integrato**, se ha le autorizzazioni per gli strumenti di compilazione e clic
- Configura le [Autorizzazioni strumenti](app:openSettingsPageView) per stabilire quali operazioni richiedono approvazione

**Auto-miglioramento:**

- L'agente può **gestire le proprie skill**: crearle, modificarle e attivarle
- Questo gli consente di imparare e migliorarsi nel tempo
- Controlla periodicamente le modifiche alle skill per assicurarti che siano in linea con le tue aspettative

## Archiviazione dei dati {#adv-data-storage}

AppAgent memorizza i dati in locale nel tuo browser usando **IndexedDB**:

| Tipo di dati | Archiviazione | Descrizione |
|-----------|---------|-------------|
| **Chat** | IndexedDB | Tutta la cronologia delle conversazioni, i messaggi e i risultati degli strumenti |
| **Impostazioni** | IndexedDB | Autorizzazioni degli strumenti, chiavi API, preferenze sui modelli |
| **Widget della dashboard** | IndexedDB | HTML, titoli, dimensioni e cronologia delle conversazioni dei widget |
| **Skill** | IndexedDB | Definizioni, contenuti e risorse delle skill |
| **Provider API** | IndexedDB | Configurazioni ed endpoint dei provider API personalizzati |
| **Stato dell'interfaccia** | localStorage | Stato della barra laterale, vista corrente, posizioni di scorrimento |

**Scaricare i tuoi dati:**

1. Vai a [Impostazioni](app:openSettingsPageView) → Gestione dei dati
2. Fai clic su **Esporta dati**
3. Verrà scaricato un file di backup JSON

**Eliminare i tuoi dati:**

1. Vai a [Impostazioni](app:openSettingsPageView) → Gestione dei dati
2. Fai clic su **Elimina tutti i dati**
3. Conferma due volte per eliminare tutto in modo definitivo

:::tip
**Importante:** i dati sono memorizzati in locale nell'estensione. Cancellando i dati del browser, disinstallando l'estensione o usando un profilo del browser diverso si otterranno archivi di dati separati.
:::

# Informazioni {#about}

**Versione:** v__VERSION__

**Licenza:** uso privato e commerciale. Modifica interna consentita. Distribuzione e rivendita vietate. Tutti i diritti riservati.

## Changelog {#changelog}

__CHANGELOG__
