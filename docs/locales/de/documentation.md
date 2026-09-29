# Erste Schritte {#getting-started}

AppAgent ist ein KI-Agent für ServiceNow, der als Chrome-Erweiterung läuft. Beschreiben Sie in einfachen Worten, was Sie brauchen: Der Agent fragt Daten ab, bearbeitet Datensätze, erstellt Apps und Widgets, testet Seiten in Ihrem Browser und berichtet Ihnen das Ergebnis.

:::tip
**Schnellstart:** Richten Sie ein Modell ein, öffnen Sie einen Tab mit Ihrer ServiceNow-Instanz, geben Sie dann eine Anfrage im Chat ein und drücken Sie <kbd>Enter</kbd>.
:::

## Modell einrichten {#guide-setup}

1. Öffnen Sie die [Einstellungen](app:openSettingsPageView) und gehen Sie zu **API-Anbieter**
2. Fügen Sie einen Anbieter (Anthropic, OpenRouter oder eine eigene OpenAI-kompatible API) mit Ihrem API-Schlüssel hinzu – oder aktivieren Sie **OAuth** bei einem Anthropic-Anbieter, um sich mit Ihrem Claude-Konto anzumelden
3. Wählen Sie unter **Agent-Modell** das zu verwendende Modell aus

Ihr API-Schlüssel wird nur in Ihrem Browser gespeichert. KI-Aufrufe gehen direkt von Ihrem Browser an den Anbieter.

## Instanzen verbinden {#guide-instances}

AppAgent **erkennt automatisch jede ServiceNow-Instanz**, die Sie im selben Chrome-Profil geöffnet haben – Sie müssen keine Verbindungsdaten eingeben. Melden Sie sich in einem normalen Tab bei einer Instanz an, und der Agent kann mit den Rollen und Zugriffsrechten Ihres Benutzers darauf arbeiten. Fragen Sie *„Instanzen auflisten“*, um alle erkannten Instanzen, Ihre Rollen und den Verbindungsstatus zu sehen.

Jede Instanz hat eine **Berechtigungsstufe**, die Sie im Instanz-Dropdown auswählen:

- **Manuell** – Sie genehmigen jeden Schreibvorgang (Erstellen, Aktualisieren, Löschen, Formulareingaben)
- **Auto** – Der Agent entscheidet ohne Rückfrage über Schreibvorgänge
- **Dev** – Keinerlei Genehmigungen: Jeder Tool-Aufruf auf dieser Instanz läuft ohne Rückfrage. Nur auf Entwicklungsinstanzen verwenden

Lesezugriffe sind immer erlaubt. Eine feinere Steuerung finden Sie unter [Tool-Berechtigungen](#feature-permissions).

## Chat starten {#guide-chat}

1. Klicken Sie in der Seitenleiste auf **Neuer Chat** [Neuen Chat starten →](app:startNewChat)
2. Geben Sie Ihre Anfrage ein, zum Beispiel *„Zeige mir alle heute erstellten Incidents“*
3. Drücken Sie <kbd>Enter</kbd> zum Senden
4. Verfolgen Sie die Arbeit des Agents: Jeder Tool-Aufruf erscheint im Chat, und Genehmigungsanfragen erscheinen, wenn ein Schritt Ihre Zustimmung braucht

Sie können weiterschreiben, während der Agent arbeitet: Eine neue Nachricht unterbricht den aktuellen Schritt, und **Pausieren** hält den Lauf an.

## Bilder und Dateien anhängen {#guide-images}

1. Klicken Sie im Eingabebereich auf **Datei anhängen**, um ein Bild, eine PDF-, CSV- oder Textdatei hinzuzufügen
2. Oder fügen Sie ein Bild aus der Zwischenablage ein bzw. ziehen Sie es per Drag-and-drop in den Chat
3. Stellen Sie Ihre Frage zum Anhang

:::tip
Hängen Sie Screenshots von Fehlern, UI-Entwürfe oder exportierte Daten an, damit der Agent genau sieht, was Sie sehen.
:::

# Hauptfunktionen {#features}

## Chat {#page-chat}

Die Hauptansicht für Unterhaltungen. [Neuen Chat starten →](app:startNewChat)

- **Nachrichtenbereich** – Die Unterhaltung, einschließlich Tool-Aufrufen und ihrer Ergebnisse
- **Eingabefeld** – Nachrichten eingeben, Dateien anhängen; senden Sie während der Arbeit des Agents, um ihn zu unterbrechen
- **Pausieren / Fortfahren / Wiederholen** – Den Agent anhalten, fortsetzen oder den letzten Schritt wiederholen
- **Kontextanzeige** – Zeigt, wie voll die Unterhaltung ist; ein Klick fasst sie in einem neuen Chat zusammen
- **Antwortkarten** – Unter einer Antwort können eine **Kurzfassung** und eine **Links**-Karte (Datensätze, PRs, Dokumente) erscheinen
- **Chat-Kopfzeile** – Chat umbenennen oder anheften oder AppAgent mit **Auf ganze Seite erweitern** in einem vollständigen Browser-Tab öffnen

## Browsersteuerung {#feature-browser}

Der Agent kann Browser-Tabs auf Ihrer Instanz öffnen und steuern, um Seiten zu sehen und zu testen:

- **Navigieren, klicken, ausfüllen und auswählen** – Realistische Ereignisse, sodass sich Formulare und Autovervollständigungsfelder verhalten, als hätten Sie selbst getippt
- **Warten auf** – Auf ein Element, einen Text oder eine URL warten, statt Verzögerungen zu raten
- **Screenshots** – Die Seite, ein Widget oder ein einzelnes Element für visuelle Prüfungen aufnehmen
- **Untersuchen** – Elementeigenschaften, Styles, Konsolenfehler und Netzwerkanfragen auslesen
- **Identität annehmen** – Als anderer Benutzer testen und dann zurückwechseln

## Datensätze bearbeiten & Versionsverlauf {#feature-history}

Jede Änderung, die der Agent an Ihrer Instanz vornimmt, wird in der Chat-Seitenleiste festgehalten:

- **Rückgängig** – Eine einzelne Änderung zurücknehmen
- **Wiederholen** – Eine zurückgenommene Änderung wiederherstellen
- **XML herunterladen** – Alle Änderungen exportieren, zum Beispiel um sie auf eine andere Instanz zu übertragen

## Sub-Agents {#feature-subagents}

Für aufwendige oder parallele Arbeit kann der Agent **Sub-Agents** starten: Hintergrund-Worker, die in einem eigenen Chat und Kontext laufen und dann ein kurzes Ergebnis an den Haupt-Chat zurückmelden.

- **Modellstufen** – Jeder Sub-Agent läuft auf der Stufe **small**, **medium** oder **large** oder mit **same**, um das Modell des übergeordneten Agents zu nutzen. Ordnen Sie die Stufen in den [Einstellungen](app:openSettingsPageView) → **Modellstufen für Sub-Agents** Modellen zu
- **Worker-Leiste** – Laufende Sub-Agents erscheinen als Live-Chips über der Chat-Eingabe; öffnen Sie einen, um seinen Fortschritt zu verfolgen oder sein Protokoll zu lesen
- **Pool** – Die Zahl gleichzeitiger Sub-Agents ist begrenzt; weitere warten in einer Warteschlange

## Dashboard & Widgets {#page-dashboard}

Ein Dashboard mit interaktiven, vom Agent erstellten Widgets. [Dashboard öffnen →](app:openDashboardView)

1. Klicken Sie auf **Widget hinzufügen**
2. Beschreiben Sie, was Sie möchten, zum Beispiel *„Ein Diagramm der offenen Incidents nach Priorität“*
3. Der Agent erstellt das Widget; bitten Sie jederzeit um Änderungen oder klicken Sie auf **Neu generieren**

Widgets können Live-Daten aus Ihrer Instanz abrufen und bleiben so aktuell. Sie können sie verschieben, in der Größe ändern, importieren und exportieren (siehe [Erweitert](#advanced)). Widgets, die der Agent direkt im Chat anzeigt, lassen sich mit **An Dashboard anheften** speichern.

## Smart-Dokumente {#page-documents}

**Smart-Dokumente** sind dauerhafte, versionierte Markdown-Dokumente, die der Agent schreibt und aktualisiert – Pläne, Berichte, Spezifikationen, Ergebnisse. Sie werden direkt im Chat angezeigt, behalten jede Version und können von Ihnen direkt bearbeitet werden. Öffnen Sie sie über **Dokumente** in der Seitenleiste. [Dokumente öffnen →](app:openDocumentsView)

## Skills {#page-skills}

Skills geben dem Agent zusätzliches Wissen und zusätzliche Tools. [Skills öffnen →](app:openSkillsView)

- **Aktivieren / Deaktivieren** – Skills ein- oder ausschalten; deaktivieren Sie nicht benötigte Skills, damit die Antworten fokussiert bleiben
- **Neuer Skill** – Schreiben Sie Ihren eigenen Skill in Markdown oder nutzen Sie **Mit Agent bearbeiten**
- **Importieren / Exportieren** – Skills als Ordner teilen
- **Skill-Aktionen** – Manche Skills fügen der Startseite Ein-Klick-Schaltflächen hinzu, die einen vordefinierten Workflow starten

Ein Skill kann **Wissen** (Anweisungen, Best Practices) und **eigene Tools** (JavaScript-Funktionen, die in einer isolierten Sandbox laufen) bereitstellen.

## Workspace & GitHub {#feature-workspace}

Jeder Chat hat einen **Workspace** – einen Dateibereich, in dem der Agent Dateien lesen, schreiben, bearbeiten und vergleichen kann.

- **GitHub** – Verbinden Sie in den [Einstellungen](app:openSettingsPageView) ein GitHub-Konto, um Repositorys in einen Workspace zu klonen. Der Agent kann direkt aus dem Chat Branches erstellen, Commits pushen und Pull Requests öffnen
- **Pull Requests** – Aus einem Chat geöffnete PRs werden in der Chat-Seitenleiste mit einer **Mergen**-Schaltfläche aufgeführt
- **Schutz zwischen Chats** – Jede Datei merkt sich, welcher Chat sie geändert hat, sodass zwei parallel arbeitende Chats nicht unbemerkt gegenseitig ihre Arbeit überschreiben
- **Auto-Sync** – Geklonte Workspaces synchronisieren sich mit GitHub, wenn Sie navigieren, den Chat wechseln oder zum Tab zurückkehren

## Chat-Seitenleiste {#feature-sidebar}

Die rechte Seitenleiste sammelt alles, was der aktuelle Chat erzeugt hat:

- **Pull Requests** – Titel, Ziel-Branch und eine **Mergen**-Schaltfläche
- **Workspace-Dateien** – Eine Datei öffnen, um sie anzusehen, ihren Diff zu sehen oder frühere Versionen durchzusehen
- **Versionsverlauf** – Änderungen an der Instanz mit **Rückgängig**, **Wiederholen** und **XML herunterladen**
- **Worker** – Laufende und abgeschlossene Sub-Agents mit Zählern für Tool-Aufrufe, bearbeitete Dateien und geöffnete PRs

## Aktionen & Live-Fortschritt {#feature-actions}

Lange Aufgaben zeigen den Fortschritt live, statt still zu bleiben:

- **Fortschrittskarte** – Eine einzelne Karte mit farbigem Status (läuft, hängt, fertig, Fehler) und einer Liste von Schritten
- **Aktionsschaltflächen** – Ein-Klick-Schaltflächen, die Folge-Workflows starten
- **Laufanzeige** – Die Chatliste markiert Chats, in denen der Agent gerade arbeitet
- **Benachrichtigung „Agent fertig“** – Wenn Sie während eines Laufs Tab oder Fenster wechseln, meldet eine Desktop-Benachrichtigung, wann der Agent fertig ist

## Aktive Chats & Jobs {#feature-jobs}

Die Jobs-Pille in der Kopfzeile öffnet eine Live-Ansicht Ihrer Chats und Hintergrundarbeiten:

- **Aktive Chats** – Laufende Chats und Chats mit ungelesenen Ergebnissen (**fett** dargestellt), jeweils mit einem Ring für die Kontextauslastung
- **Sub-Agents** – Unter ihrem übergeordneten Chat aufgeführt; öffnen Sie einen, um sein Protokoll zu lesen
- **Erweitern** – Die Liste als größeres Panel mit Spalten- oder Abschnittslayout öffnen

## Tool-Berechtigungen {#feature-permissions}

Zusätzlich zur Berechtigungsstufe pro Instanz (**Manuell**, **Auto**, **Dev**) hat jedes Tool eine eigene Einstellung unter [Einstellungen](app:openSettingsPageView) → **Tool-Berechtigungen**:

- **Erlauben** – Das Tool läuft immer ohne Rückfrage
- **Auto** – Das Tool läuft ohne Rückfrage, es sei denn, der Agent markiert einen Aufruf als bestätigungspflichtig
- **Fragen** – Vor jedem Aufruf erhalten Sie eine Genehmigungsanfrage
- **Aus** – Der Agent kann das Tool nicht verwenden

Manche Tools lassen sich feiner steuern: die ServiceNow API pro HTTP-Methode (GET, POST, PUT, PATCH, DELETE), die Browsersteuerung pro Aktion (navigieren, klicken, ausfüllen, Identität annehmen …) und die Skill-Verwaltung pro Aktion. Bestätigungsdialoge sind nach Risiko farblich gekennzeichnet: **blau** (Routine), **orange** (Vorsicht), **rot** (destruktiv).

:::tip
Belassen Sie DELETE und andere destruktive Vorgänge auf **Fragen**, und verwenden Sie **Dev** nur auf Entwicklungsinstanzen.
:::

## Agent-Tools {#feature-tools}

Die wichtigsten Tools, die der Agent verwendet:

| Tool | Funktion |
|------|--------------|
| **ServiceNow API** (`servicenow_api`) | Datensätze lesen, erstellen, aktualisieren und löschen |
| **Hintergrundskript** (`servicenow_run_script`) | Ein serverseitiges Skript auf der Instanz ausführen (erfordert die Rolle admin) |
| **Skriptänderungen** (`servicenow_diff_edit`) | Skripte mit präzisen Suchen-und-Ersetzen-Änderungen anpassen |
| **Browsersteuerung** (`iframe_tool`) | In Browser-Tabs navigieren, klicken, ausfüllen, untersuchen und Identität annehmen |
| **Browser-Code** (`js_eval`) | JavaScript in einer isolierten Sandbox ausführen, die andere Tools aufrufen kann |
| **Screenshots** (`take_screenshot`) | Die Seite, ein Widget oder ein Element aufnehmen |
| **Widgets und Karten** (`html_widget`, `display`) | Interaktive Widgets, Tabellen, Karten und Zeitleisten im Chat anzeigen |
| **Smart-Dokumente** (`document`) | Dauerhafte Markdown-Dokumente erstellen und aktualisieren |
| **Benutzer fragen** (`prompt_user`) | Sie über ein Formular im Chat um Eingaben bitten |
| **Sub-Agents** (`spawn_sub_agent`) | Arbeit an Hintergrund-Worker delegieren |
| **Workspace** (`workspace`) | Mit Dateien und GitHub-Repositorys arbeiten |
| **Web-Abruf** (`web_fetch`) | Seiten aus dem öffentlichen Web lesen |
| **Skills** (`get_skill`, `manage_skill`) | Skills lesen und verwalten |

Öffnen Sie [Einstellungen](app:openSettingsPageView) → **Tool-Berechtigungen**, um jedes Tool mit seiner Quelle und seiner Berechtigung zu sehen.

## Caching großer Inhalte {#feature-caching}

Wenn ein Tool-Ergebnis zu groß für die Unterhaltung ist (standardmäßig mehr als 4K Tokens), speichert AppAgent es im Cache. Der Agent erhält eine Gliederung und liest, durchsucht oder durchblättert dann nur die Teile, die er braucht. So bleiben Chats schnell und fokussiert. Den Schwellenwert (1K bis 100K Tokens) ändern Sie unter [Einstellungen](app:openSettingsPageView) → **Caching großer Inhalte**.

## Kontextanzeige {#feature-saturation}

Die **Kontextanzeige** neben der Chat-Eingabe zeigt, wie voll die Unterhaltung ist. Ab 50 % wird der Agent gebeten, zum Abschluss zu kommen und verbleibende aufwendige Arbeit an Sub-Agents abzugeben; bei 100 % hält er an und berichtet. Klicken Sie jederzeit auf die Anzeige, um die Unterhaltung in einem neuen Chat zusammenzufassen.

## Nutzung & Ratenlimits {#feature-usage}

- **Nutzungs-Pille** – Die Kopfzeile zeigt Ihre API-Nutzung und die verbleibenden Limits; ein Klick zeigt Details
- **Automatische Wiederholungen** – Wenn der Anbieter ein Ratenlimit meldet oder überlastet ist (HTTP 429 / 529), wartet AppAgent, versucht es automatisch erneut und zeigt einen Countdown im Chat
- **Kein Guthaben mehr** – Wenn ein 429 tatsächlich bedeutet, dass Ihr Guthaben aufgebraucht ist, sagt der Chat das klar

## Sprachen {#feature-languages}

Die Oberfläche ist auf Englisch und in 24 weiteren Sprachen verfügbar: Arabisch, Chinesisch (vereinfacht, traditionell), Tschechisch, Dänisch, Niederländisch, Finnisch, Französisch (Frankreich, Kanada), Deutsch, Hebräisch, Ungarisch, Italienisch, Japanisch, Koreanisch, Norwegisch, Polnisch, Portugiesisch (Brasilien, Portugal), Russisch, Spanisch, Schwedisch, Thai und Türkisch.

Wählen Sie eine unter [Einstellungen](app:openSettingsPageView) → **Sprache** oder im Schnelleinstellungsmenü in der Kopfzeile. **Auto** folgt der Sprache Ihres Browsers und fällt auf Englisch zurück. Die Änderung wirkt sofort, ohne Neuladen.

- **Rechts nach links** – Arabisch und Hebräisch verwenden ein Layout von rechts nach links
- **Lokale Formate** – Datum, Uhrzeit und Zahlen richten sich nach Ihrer Sprache
- **Antworten des Agents** – Der Agent antwortet in der gewählten Sprache, sofern Sie nicht in einer anderen schreiben. Code-, Tabellen- und Feldnamen bleiben unverändert
- **Diese Hilfeseite** – Wird in Ihrer Sprache angezeigt; das Changelog bleibt auf Englisch

# Seiten & Einstellungen {#pages}

## Einstellungen {#page-settings}

[Einstellungen öffnen →](app:openSettingsPageView)

- **Agent-Modell** – Das Modell, das der Agent verwendet
- **API-Anbieter** – Anthropic, OpenRouter oder eigene Anbieter, mit API-Schlüssel oder OAuth
- **LLM-Endpunkte** – Benannte `URL + API key`-Paare für jede OpenAI-kompatible API
- **Modellstufen für Sub-Agents** – Die Stufen small, medium und large Modellen zuordnen oder **Gleich** wählen
- **Reasoning-Aufwand, Max. Tokens & Denk-Budget** – Tiefe und Länge der Antworten abstimmen
- **Kontextfenster** – Die Kontextgröße, die die Kontextanzeige verwendet
- **Anzeige** – API-Statistiken, Kompaktmodus, Bildschirm aktiv halten
- **Sprache** – Sprache der Oberfläche oder **Auto**
- **Hooks** – Automatische Chat-Titel, Benachrichtigungen „Agent fertig“ und weitere Automatisierungen
- **Caching großer Inhalte** – Wann große Ergebnisse zwischengespeichert werden
- **Tool-Berechtigungen** – Was automatisch läuft, vorher fragt oder deaktiviert ist
- **GitHub** – Ein GitHub-Konto verbinden und geklonte Repositorys verwalten
- **System-Prompt** – Die Anweisungen des Agents anpassen
- **Datenverwaltung** – Ihre Daten exportieren, importieren oder löschen

## Verlauf {#page-history}

Alle Ihre Unterhaltungen. [Verlauf öffnen →](app:openHistoryView)

- **Suchen** – Chats nach Titel, Inhalt, verwendeten Tools oder Widgets finden
- **Anheften** – Wichtige Chats oben halten
- **Exportieren** – Einen Chat oder Ihren gesamten Verlauf herunterladen
- **Statistik** – Anzahl der Chats, angehefteten Chats und Gesamtkosten

## Hilfe {#page-docs}

Diese Seite. [Hilfe öffnen →](app:openDocsView)

- **Suchen** – Die Hilfethemen über das Suchfeld in der Symbolleiste filtern
- **Inhalt** – Über die Gliederung zu einem Abschnitt springen
- **Herunterladen** – Die Dokumentation als Markdown-Datei speichern

# Tipps & Tastenkombinationen {#tips}

| Aktion | So geht's |
|--------|-----|
| Nachricht senden | <kbd>Enter</kbd> |
| Neue Zeile | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Chats durchsuchen | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> auf dem Mac) |
| Dialog oder Menü schließen | <kbd>Esc</kbd> |
| Zurück | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Bild anhängen | Einfügen oder per Drag-and-drop in den Chat ziehen |
| Neu beginnen mit Zusammenfassung | Auf die Kontextanzeige klicken |
| Agent unterbrechen | Eine neue Nachricht senden oder auf **Pausieren** klicken |

:::tip
**Seien Sie konkret.** Statt *„behebe das“* sagen Sie *„behebe den Null-Reference-Fehler in Zeile 42 des Script Includes MyUtils“*. Nennen Sie wenn möglich die Tabelle, den Datensatz oder die Seite.
:::

- **Ein Ziel pro Chat** – Starten Sie für eine andere Aufgabe einen neuen Chat; der Agent bleibt so schneller und genauer
- **Testen lassen** – Bitten Sie den Agent, die Seite zu öffnen und seine eigene Änderung mit einem Screenshot zu prüfen
- **Skills nutzen** – Aktivieren Sie vor dem Start einen passenden Skill für Ihre Aufgabe (zum Beispiel für Tests oder Audits)

# Fehlerbehebung & FAQ {#faq}

### Der Agent sieht meine Instanz nicht

Öffnen Sie die Instanz in einem Tab desselben Chrome-Profils, stellen Sie sicher, dass Sie angemeldet sind, und fragen Sie dann *„Instanzen auflisten“*. Erscheint sie immer noch nicht, laden Sie den Tab der Instanz neu.

### Ich erhalte einen API- oder Authentifizierungsfehler

Prüfen Sie Ihren Anbieter unter [Einstellungen](app:openSettingsPageView) → **API-Anbieter**: den API-Schlüssel, den gewählten Endpunkt und den Modellnamen. Bei OAuth melden Sie sich im selben Chrome-Profil erneut bei claude.ai an.

### Der Agent meldet ein Ratenlimit

AppAgent versucht es automatisch erneut und zeigt einen Countdown. Passiert das häufiger, prüfen Sie in der Nutzungs-Pille Ihr verbleibendes Guthaben oder verwenden Sie für Sub-Agents eine kleinere Modellstufe.

### Zu viele oder zu wenige Genehmigungsanfragen

Ändern Sie die Berechtigungsstufe der Instanz (**Manuell**, **Auto**, **Dev**) im Instanz-Dropdown, und passen Sie einzelne Tools unter [Einstellungen](app:openSettingsPageView) → **Tool-Berechtigungen** an.

### Antworten werden in einem langen Chat langsamer oder ungenauer

Der Kontext der Unterhaltung füllt sich. Klicken Sie auf die Kontextanzeige, um mit einer Zusammenfassung in einem neuen Chat weiterzumachen.

### Wie mache ich eine Änderung rückgängig?

Öffnen Sie die Chat-Seitenleiste und klicken Sie im Versionsverlauf bei der Änderung auf **Rückgängig**. **XML herunterladen** exportiert alle Änderungen.

### Wo werden meine Daten gespeichert?

Lokal in Ihrem Browser (IndexedDB). Chats gehen nie an einen AppAgent-Server – nur an Ihren KI-Anbieter und Ihre ServiceNow-Instanz. Siehe [Datenspeicherung](#adv-data-storage).

### Die Oberfläche oder diese Seite ist in der falschen Sprache

Wählen Sie die Sprache unter [Einstellungen](app:openSettingsPageView) → **Sprache**. **Auto** folgt der Sprache Ihres Browsers.

# Erweitert {#advanced}

Dieser Abschnitt behandelt erweiterte Funktionen, Schaltflächen in Kopfzeilen, Import-/Exportformate und technische Details zur Funktionsweise von AppAgent.

## Schaltflächen in der Dashboard-Kopfzeile {#adv-dashboard-header}

Die Kopfzeile des Dashboards enthält mehrere Aktionsschaltflächen:

| Schaltfläche | Beschreibung |
|--------|-------------|
| **Seitenleiste ein-/ausblenden** | Die linke Navigationsleiste ein- oder ausblenden |
| **Eigenständig öffnen** | Das Dashboard zur eigenständigen Ansicht in einem neuen Browser-Tab öffnen |
| **Kopfzeilen** | Widget-Kopfzeilen auf dem Dashboard ein- oder ausblenden. Ohne Kopfzeilen werden Widgets übersichtlicher angezeigt |
| **Alle neu generieren** | Alle Widgets auf dem Dashboard vom Agent neu generieren lassen. Nützlich, um Daten zu aktualisieren |
| **Importieren** | Ein Dashboard oder Widget aus einer JSON-Datei importieren |
| **Exportieren** | Das gesamte Dashboard als JSON-Datei zur Sicherung oder Weitergabe exportieren |
| **Widget hinzufügen** | Öffnet den Widget-Editor, um mit Unterstützung des Agents ein neues Widget zu erstellen |

## Schaltflächen in Widget-Kopfzeilen {#adv-widget-headers}

**Kopfzeilen von Dashboard-Widgets** (sichtbar, wenn **Kopfzeilen** eingeschaltet ist):

| Schaltfläche | Beschreibung |
|--------|-------------|
| **Ziehgriff** | Das Widget-Symbol dient als Ziehgriff zum Umsortieren von Widgets |
| **Neu generieren** | Den Agent bitten, den Inhalt dieses Widgets neu zu generieren |
| **Verlauf** | Frühere Versionen dieses Widgets ansehen (falls vorhanden) |
| **Vollbild** | Das Widget in der Vollbildansicht anzeigen |
| **Bearbeiten** | Den Widget-Editor öffnen, um es per Agent-Chat zu ändern |
| **Löschen** | Das Widget vom Dashboard entfernen (mit Bestätigung) |

**Kopfzeilen von Chat-Widgets** (Widgets direkt im Chat):

| Schaltfläche | Beschreibung |
|--------|-------------|
| **An Dashboard anheften** | Dieses Widget auf Ihrem Dashboard speichern |
| **Code bearbeiten** | Den HTML/CSS/JS-Code des Widgets direkt ansehen und bearbeiten |
| **Ein-/Ausklappen** | Den Widget-Inhalt ein- oder ausblenden |

## Widgets in der Größe ändern & verschieben {#adv-resize-move}

**Größe von Widgets ändern:**

- Jedes Widget hat unten rechts einen **Größengriff**
- Klicken und ziehen Sie den Griff, um die Größe des Widgets zu ändern
- Die Breite rastet in einem 12-Spalten-Raster ein (mindestens 3 Spalten)
- Die Höhe wird in Einheiten von 50px gemessen (mindestens 2 Einheiten = 100px)

**Widgets verschieben:**

- Schalten Sie **Kopfzeilen** ein, um die Widget-Kopfzeilen anzuzeigen
- Klicken und ziehen Sie das **Widget-Symbol** (Ziehgriff), um die Reihenfolge zu ändern
- Legen Sie das Widget auf einem anderen Widget ab, um die Positionen zu tauschen
- Die Reihenfolge der Widgets wird automatisch gespeichert

## Import-/Exportformate {#adv-import-export}

**Dashboard-Export** (`dashboard-YYYY-MM-DD.json`):

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

**Export eines einzelnen Widgets:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Export eines einzelnen Chats** (`chat-title-YYYY-MM-DD.json`):

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

Chat-Exporte enthalten den vollständigen Gesprächsverlauf mit allen Nachrichten des Benutzers und Antworten des Agents. Um einzelne Chats zu exportieren, öffnen Sie das Chat-Dropdown-Menü (···) und wählen Sie **Herunterladen**.

**Skills-Export** (Ordnerstruktur):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Hinweis:** Import und Export von Skills nutzen die File System Access API und **funktionieren nur in Chrome oder Edge**.
:::

**Export aller Daten** (`appagent-backup-YYYY-MM-DD.json`):

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

Die vollständige Sicherung umfasst den gesamten Chatverlauf, Einstellungen, Tool-Berechtigungen, Dashboard-Widgets und die Konfiguration der API-Anbieter.

## API-Statistiken {#adv-api-stats}

Wenn sie in den Einstellungen aktiviert sind, werden nach jeder Antwort des Agents API-Statistiken angezeigt:

| Kennzahl | Beschreibung |
|--------|-------------|
| **In** | Eingabe-Tokens – die Größe des an den Agent gesendeten Prompts |
| **Out** | Ausgabe-Tokens – die Größe der Antwort des Agents |
| **Gesamt** | Eingabe- und Ausgabe-Tokens zusammen |
| **Cache Read/Write** | Aus dem Prompt-Cache gelesene oder in ihn geschriebene Tokens (senkt die Kosten) |
| **Reasoning** | Für internes Nachdenken verwendete Tokens (bei manchen Modellen) |
| **Kosten** | Geschätzte Kosten des API-Aufrufs in USD |
| **Dauer** | Dauer des API-Aufrufs |

Bei Unterhaltungen mit mehreren Runden zeigen zusammengefasste Statistiken die Summe über alle Aufrufe.

:::tip
Die Anzeige der API-Statistiken schalten Sie unter [Einstellungen](app:openSettingsPageView) → Anzeige → API-Statistiken anzeigen ein oder aus.
:::

## Skills manuell bearbeiten {#adv-skills-manual}

Skills lassen sich manuell oder mit Unterstützung des Agents erstellen und bearbeiten:

**Skill manuell erstellen:**

1. Gehen Sie zu [Skills](app:openSkillsView) und klicken Sie auf **Neuer Skill**
2. Geben Sie einen Namen und eine Beschreibung für den Skill ein
3. Schreiben Sie den Inhalt des Skills im Markdown-Format
4. Klicken Sie auf **Speichern**, um den Skill zu erstellen

**SKILL.md-Format:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Mit dem Agent bearbeiten:**

1. Klicken Sie bei einem beliebigen Skill auf **Mit Agent bearbeiten**
2. Beschreiben Sie die gewünschten Änderungen
3. Der Agent passt den Inhalt des Skills an
4. Prüfen und speichern Sie die Änderungen

**Skill-Assets:** Skills können zusätzliche Dateien (XML, JS, MD) enthalten, die dem Agent weiteren Kontext oder Code liefern.

## System-Prompt {#adv-system-prompt}

Der System-Prompt legt Verhalten und Fähigkeiten des Agents fest. Sie können ihn in den [Einstellungen](app:openSettingsPageView) anpassen.

**System-Prompt bearbeiten:**

1. Gehen Sie zu Einstellungen → Abschnitt System-Prompt
2. Klicken Sie auf **Bearbeiten**, um in den Bearbeitungsmodus zu wechseln
3. Passen Sie die Vorlage nach Bedarf an
4. Klicken Sie auf **Speichern**, um die Änderungen zu übernehmen

**Verfügbare Platzhalter:**

| Platzhalter | Beschreibung |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Heutiges Datum (Wochentag, Monat, Tag, Jahr) |
| `{{ORCHESTRATOR_POLICY}}` | Richtlinie zur Delegation an Sub-Agents – in Haupt-Chats enthalten, in Sub-Agent-Chats leer |
| `{{DISABLED_TOOLS}}` | Liste der deaktivierten Tools |
| `{{TOOL_CATALOG}}` | Katalog der verzögert geladenen Tools (leer, wenn das verzögerte Laden von Tools aus ist) |
| `{{SKILLS_SUMMARY}}` | Inhalt der aktiven Skills |

Platzhalter werden beim Senden an die KI automatisch durch die tatsächlichen Werte ersetzt. Die Token-Anzeige zeigt sowohl die Größe der Vorlage als auch die expandierte Größe.

:::tip
Klicken Sie bei Bedarf auf **Auf Standard zurücksetzen**, um den ursprünglichen System-Prompt wiederherzustellen.
:::

## API-Aufrufe des Agents {#adv-agent-api}

AppAgent läuft als **Chrome-Erweiterung**:

- KI-API-Aufrufe gehen **direkt von Ihrem Browser an den KI-Anbieter** (z. B. Anthropic, OpenRouter)
- Sie laufen **nicht** über Ihre Instanz oder einen AppAgent-Server
- Ihr API-Schlüssel (oder OAuth-Token) wird lokal in Ihrem Browser gespeichert
- Gesprächsdaten werden zur Verarbeitung an den KI-Anbieter gesendet

**So funktioniert es:**

1. Sie geben eine Nachricht im Chat ein
2. AppAgent erstellt einen Prompt mit Systemanweisungen, Tools und Gesprächsverlauf
3. Der Prompt wird an die API des KI-Anbieters gesendet
4. Die Antwort des Agents wird an Ihren Browser zurückgestreamt
5. Tool-Aufrufe werden in Ihrem Browser ausgeführt und nutzen für API-Aufrufe Ihre Instanz-Sitzung

:::tip
**Datenschutz:** Ihr API-Schlüssel und Ihre Gesprächsdaten werden clientseitig verarbeitet. Tool-Aufrufe, die mit Ihrer Instanz interagieren, verwenden Ihre bestehenden Sitzungsdaten.
:::

## LLM-Endpunkte {#adv-endpoints}

Modelle verbinden sich über **benannte LLM-Endpunkte** – wiederverwendbare `URL + API key`-Paare. So können Sie AppAgent auf **jede OpenAI-kompatible Chat-Completions-API** ausrichten: OpenRouter, ein lokales Gateway, einen Proxy oder Ihr eigenes gehostetes Modell.

1. Klicken Sie in [Einstellungen → LLM-Endpunkte](app:openSettingsPageView) auf **Endpunkt hinzufügen**
2. Geben Sie einen Namen, die API-URL und einen API-Schlüssel ein
3. Jedes Modell (API-Anbieter) wählt einen Endpunkt – aktualisieren Sie einen Schlüssel einmal, und jedes Modell, das ihn verwendet, ist aktualisiert

:::tip
Claude-**OAuth**-Anbieter verwenden keine Endpunkte – sie kommunizieren direkt mit `api.anthropic.com`.
:::

## Mit Claude anmelden (OAuth) {#adv-oauth}

Statt einen API-Schlüssel einzufügen, können Sie sich bei Anthropic-Anbietern mit Ihrer bestehenden claude.ai-Sitzung anmelden:

1. Fügen Sie in [Einstellungen → API-Anbieter](app:openSettingsPageView) einen Anthropic-Anbieter hinzu oder bearbeiten Sie einen und aktivieren Sie **OAuth**
2. Die Erweiterung nutzt Ihre claude.ai-Anmeldung aus demselben Chrome-Profil, um sich direkt mit Anthropic zu verbinden
3. Kein zusätzliches Anmeldefenster und kein AppAgent-Server dazwischen

**Voraussetzungen:**

- Sie müssen im selben Chrome-Profil bei `claude.ai` angemeldet sein
- Funktioniert mit Single-Sign-on-Konten (SSO)

:::tip
OAuth-Tokens werden automatisch erneuert. Schlägt die Anmeldung fehl, öffnen Sie `claude.ai` im selben Profil und melden Sie sich erneut an.
:::

## Sicherheitshinweise {#adv-security}

**Speicherung des API-Schlüssels:**

- Ihr **API-Schlüssel wird lokal** in der IndexedDB Ihres Browsers gespeichert
- Der Schlüssel wird nie an Ihre Instanz oder einen anderen Server außer dem KI-Anbieter gesendet
- Beim Löschen der Browserdaten wird Ihr gespeicherter API-Schlüssel entfernt

**Sitzung & Berechtigungen:**

- Der Agent läuft mit Ihrer **aktuellen Benutzersitzung** und erbt Ihre Zugriffsrechte und Rollen
- Alle API-Aufrufe an Ihre Instanz verwenden Ihre Sitzungsdaten
- Der Agent kann nur auf das zugreifen, worauf Ihr Benutzerkonto zugreifen kann

**Ausführungsumgebung der Tools:**

- **Browser-Code (js_eval)** führt JavaScript in einer **isolierten Sandbox** aus, die nur Zugriff auf `executeTool()` hat
- **Widget-Skripte** laufen in **isolierten iframes** und haben für API-Aufrufe nur Zugriff auf `executeTool()`
- **Skill-Tools** laufen in **isolierten Sandboxes** mit ausschließlichem Zugriff auf `executeTool()`
- Jeder API-Zugriff läuft über das **Berechtigungssystem** via `executeTool("servicenow_api", {...})`
- Der Agent interagiert mit Seiten in **Browser-Tabs** auf Ihrer ServiceNow-Instanz

**Möglichkeiten zur Änderung von Datensätzen:**

- Das Tool **ServiceNow API** unterstützt die Methoden POST, PATCH, PUT und DELETE, die Datensätze verändern können
- Der Agent kann Datensätze über den **integrierten Browser** erstellen und bearbeiten, wenn er Berechtigungen für die Tools zum Ausfüllen und Klicken hat
- Legen Sie in den [Tool-Berechtigungen](app:openSettingsPageView) fest, welche Vorgänge eine Genehmigung erfordern

**Selbstverbesserung:**

- Der Agent kann **seine eigenen Skills verwalten** – Skills erstellen, bearbeiten und aktivieren
- So kann der Agent mit der Zeit dazulernen und sich selbst verbessern
- Prüfen Sie Skill-Änderungen regelmäßig, um sicherzustellen, dass sie Ihren Erwartungen entsprechen

## Datenspeicherung {#adv-data-storage}

AppAgent speichert Daten lokal in Ihrem Browser mit **IndexedDB**:

| Datentyp | Speicher | Beschreibung |
|-----------|---------|-------------|
| **Chats** | IndexedDB | Gesamter Gesprächsverlauf, Nachrichten und Tool-Ergebnisse |
| **Einstellungen** | IndexedDB | Tool-Berechtigungen, API-Schlüssel, Modelleinstellungen |
| **Dashboard-Widgets** | IndexedDB | Widget-HTML, Titel, Größen und Gesprächsverlauf |
| **Skills** | IndexedDB | Skill-Definitionen, Inhalte und Assets |
| **API-Anbieter** | IndexedDB | Konfigurationen und Endpunkte eigener API-Anbieter |
| **UI-Zustand** | localStorage | Zustand der Seitenleiste, aktuelle Ansicht, Scrollpositionen |

**Ihre Daten herunterladen:**

1. Gehen Sie zu [Einstellungen](app:openSettingsPageView) → Datenverwaltung
2. Klicken Sie auf **Daten exportieren**
3. Eine JSON-Sicherungsdatei wird heruntergeladen

**Ihre Daten löschen:**

1. Gehen Sie zu [Einstellungen](app:openSettingsPageView) → Datenverwaltung
2. Klicken Sie auf **Alle Daten löschen**
3. Bestätigen Sie zweimal, um alles endgültig zu löschen

:::tip
**Wichtig:** Die Daten werden lokal in der Erweiterung gespeichert. Wenn Sie Browserdaten löschen, die Erweiterung deinstallieren oder ein anderes Browserprofil verwenden, entstehen getrennte Datenspeicher.
:::

# Über {#about}

**Version:** v__VERSION__

**Lizenz:** Private und kommerzielle Nutzung. Interne Anpassungen erlaubt. Weitergabe und Weiterverkauf verboten. Alle Rechte vorbehalten.

## Changelog {#changelog}

__CHANGELOG__
