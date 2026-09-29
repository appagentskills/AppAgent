# AppAgent

**ServiceNow-Apps mit einem Agent erstellen und pflegen. Als Chrome-Erweiterung.**

AppAgent ist Ihr Entwicklungspartner für ServiceNow. Er kann Apps erstellen und pflegen und Tests dafür ausführen. Getestet wird, indem er Formulare ausfüllt und Screenshots aufnimmt. Technisches Wissen ist nicht nötig.

Sie bringen Ihren eigenen API-Schlüssel mit (BYOK), und das war's! AppAgent ist kompatibel mit OpenAI, OpenRouter, der Claude API und sogar mit Claude-Code-Abos (kontaktieren Sie uns privat).

Als Chrome-Erweiterung speichert AppAgent den gesamten Chat in Ihrem Browser (die Daten verlassen Ihren Browser nicht einmal). Er interagiert nur mit Ihrer ServiceNow-Instanz und dem API-Anbieter Ihres Modells.

![AppAgent-Beispiel](AppAgentExample.png)

Er verbraucht weniger Tokens als Claude Code, da er stark auf API-Cache, Tool-Caching und Tool-Verkettung setzt (standardmäßig).

Sie können Skills hinzufügen, er steuert den Browser über Tabs, und er hat mechanische Rückgängig-Schaltflächen für alle Änderungen, die er an Ihrer Instanz vornimmt.

> **Hinweis:** Derzeit ist AppAgent nur für den Einsatz auf Entwicklungsinstanzen vorgesehen.

## Kontakt

Bitte füllen Sie dieses Formular aus, und wir melden uns: [Kontaktformular](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funktionen

| Funktion | Was sie leistet |
|---------|--------------|
| **Eigenes Modell** | Wählen Sie aus Claude, GPT, Gemini, Grok und weiteren |
| **Mit Claude anmelden** | OAuth-Anmeldung – nutzen Sie Ihr bestehendes Claude-Code-Abo (Personal oder Enterprise), kein API-Schlüssel nötig |
| **Bilder & PDFs** | Screenshots, Diagramme oder Dokumente zur Analyse durch den Agent anhängen |
| **Code-Bearbeitung** | Liest und ändert Skripte mit vollständiger Versionsverfolgung |
| **Browsersteuerung** | Testet die eigene Arbeit: navigiert in Tabs, klickt, füllt Formulare aus, nimmt Screenshots auf |
| **Live-Dashboards** | Erstellt Widgets, die Echtzeitdaten aus Ihrer Instanz abrufen |
| **Agent-Skills** | Eigene Skills erstellen, um die Fähigkeiten des Agents zu erweitern |
| **Skill-Aktionen** | Skills können Ein-Klick-Schaltflächen auf der Startseite anbieten, die vordefinierte Workflows starten |
| **Live-Fortschritt** | Sehen Sie in Echtzeit, was der Agent tut – sich aktualisierende Fortschritts-Pillen mit den Status läuft/hängt/fertig/Fehler |
| **Workspaces** | Datei-Notizbereich pro Chat – GitHub-Repos klonen, lesen, schreiben, bearbeiten, vergleichen und Branches wechseln. Mehrere Repos pro Chat, mit Schutz vor Konflikten zwischen Chats |
| **Integriertes Git & GitHub-Push** | Der Agent kann direkt aus dem Chat von GitHub pullen und dorthin pushen, Branches anlegen und Pull Requests öffnen – ohne Terminal, ohne IDE |
| **Smart-Dokumente** | Dauerhaftes, versioniertes Markdown, das der Agent chatübergreifend bearbeiten und referenzieren kann |
| **Mehrere Instanzen** | Erkennt automatisch jede in Ihrem Browser geöffnete ServiceNow-Instanz; der Agent kann alle aus einem Chat heraus sehen und bearbeiten |
| **Sub-Agents** | Delegiert aufwendige oder parallele Arbeit an Hintergrund-Agents, die an den Haupt-Chat zurückmelden |
| **25 Sprachen** | Oberfläche und Hilfe auf Englisch und in 24 weiteren Sprachen, einschließlich Arabisch und Hebräisch (von rechts nach links) |
| **Pausieren & Unterbrechen** | Pausieren oder mitten im Stream eine neue Nachricht senden – der laufende Aufruf bricht sofort ab |
| **Websuche** | Kostenlose Websuche ohne Schlüssel über Google und DuckDuckGo |
| **Mechanisches Rückgängigmachen** | Jede Änderung wird erfasst, Rücknahme mit einem Klick |
| **Export als XML** | Alle Änderungen für die Bereitstellung auf anderen Instanzen exportieren |
| **Tool-Berechtigungen** | Integrierte Sicherheit: Legen Sie fest, was der Agent auf der Instanz tun darf |
| **Offene Standards** | Kompatibel mit [OpenRouter](https://openrouter.ai) und [AgentSkills.io](https://agentskills.io) |
| **Modell-Caching** | Senkt die Kosten durch Prompt-Caching um bis zum 10-Fachen |
| **Smarter Kontext** | Lädt nur die benötigten Teile großer Dateien. Überlastet das Modell nicht |
| **Keine Abhängigkeiten** | Keine Bibliotheken, keine Frameworks, reines Vanilla-JS |

## So funktioniert es

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

AppAgent ist eine Chrome-Erweiterung mit integrierter Agent-Schleife. Sie beschreiben, was Sie möchten → Der Agent fragt das Modell → Führt Tools im Browser aus → Greift mit Ihren aktuellen Benutzerberechtigungen auf ServiceNow zu. Der Agent kommuniziert direkt mit den API-Anbietern der Modelle, on-premises oder online.

## AppAgent im Vergleich

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Zielgruppe** | Nicht-Techniker | Entwickler | Entwickler | Gründer ohne Technikkenntnisse |
| **Für ServiceNow gebaut** | ✓ | ✗ | ✗ | ✗ |
| **Agentische ServiceNow-Aktionen** | ✓ | ✓ | ✗ | ✗ |
| **Entwicklungsumgebung nötig** | ✗ | ✓ | ✓ | ✗ |
| **Erstellt Apps** | ✓ | ✓ | ✓ | ✓ |
| **Browsersteuerung für Tests** | ✓ | ✗ | ✗ | ✗ |
| **Nimmt Screenshots auf** | ✓ | ✗ | ✗ | ✗ |
| **Hintergrundaufgaben** | ✓ (über Skill-Aktionen) | ✗ | ✓ | ✗ |
| **Parallele Agents** | ✓ (Sub-Agents) | ✗ | ✓ | ✗ |
| **Mechanisches Rückgängigmachen** | ✓ | ✗ | ✗ | ✗ |
| **Bilder & PDFs** | ✓ | ✓ | ✓ | Eingeschränkt |
| **Smarte Dashboards** | ✓ | ✗ | ✗ | ✓ |
| **Erweiterbare Skills** | ✓ | ✓ | ✗ | ✗ |
| **Skill-Aktionen (Ein-Klick-Schaltflächen)** | ✓ | ✗ | ✗ | ✗ |
| **Live-Fortschritts-Pillen** | ✓ | ✗ | ✗ | ✗ |
| **Unterstützung mehrerer Instanzen** | ✓ | ✗ | ✗ | ✗ |
| **Workspaces pro Chat** | ✓ | ✗ | ✗ | ✗ |
| **Integriertes Git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push zu GitHub aus dem Chat** | ✓ | ✓ (CLI) | Eingeschränkt | ✗ |
| **Smart-Dokumente** | ✓ | ✗ | ✗ | ✗ |
| **Pausieren / Unterbrechen mitten im Stream** | ✓ | ✓ | Eingeschränkt | ✗ |
| **Websuche** | ✓ | ✓ | ✓ | ✗ |
| **Tool-Berechtigungen** | ✓ | ✓ | Eingeschränkt | ✗ |
| **Änderungen exportieren** | ✓ XML | ✓ | ✓ | ✓ |
| **Eigenes Modell** | ✓ | ✗ | ✓ | ✗ |
| **Prompt-Caching** | ✓ | ✓ | ✓ | ✗ |
| **Smarter Kontext** | ✓ | ✓ | ✓ | ✗ |
| **Keine Abhängigkeiten** | ✓ | ✗ | ✗ | ✓ |

*Base44 kann keine ServiceNow-Apps erstellen, ist aber für Nutzer aufgeführt, die damit vertraut sind.*

## Einrichtung

1. **Installieren** – Installieren Sie die AppAgent-Erweiterung aus dem Chrome Web Store (oder laden Sie sie für die Entwicklung entpackt)
2. **API-Schlüssel besorgen** – Registrieren Sie sich bei [OpenRouter](https://openrouter.ai), nutzen Sie Anthropic/OpenAI direkt oder verbinden Sie Ihr Claude-Code-Abo (Enterprise oder Personal)
3. **Konfigurieren** – Öffnen Sie die Erweiterung und fügen Sie unter Einstellungen → API-Anbieter Ihren API-Schlüssel hinzu (oder melden Sie sich mit Claude an)
4. **Loslegen** – Öffnen Sie Ihre ServiceNow-Instanz in einem Tab (sie wird automatisch erkannt) und beginnen Sie zu chatten

## Beispiele

### „Erstelle mir eine einfache App, um Teamaufgaben zu verfolgen“
AppAgent erstellt die Tabelle, fügt die Felder hinzu, baut ein Formular- und Listenlayout und richtet ein Modul im Navigator ein. Ein Prompt, eine komplette App.

### „Führe ein vollständiges Audit dieser Instanz durch“
AppAgent sucht nach Sicherheitslücken, inaktiven Admin-Konten, veralteten Datensätzen und Best Practices der Konfiguration und liefert Ihnen dann einen Bericht mit Empfehlungen.

### „Teste diese Seite und melde alle gefundenen Probleme“
AppAgent öffnet die Seite in einem Browser-Tab, füllt Formulare aus, klickt Schaltflächen, nimmt Screenshots auf und stellt einen Bericht über alle Funde zusammen.

### „In diesem Formular ist ein Fehler, kannst du ihn beheben?“
AppAgent öffnet das Formular, untersucht die zugehörigen Skripte, findet den Fehler, korrigiert den Code und zeigt Ihnen genau, was sich geändert hat. Bei Bedarf mit einem Klick rückgängig zu machen.

### „Erstelle ein Dashboard-Widget für meine offenen Tickets“
AppAgent erstellt ein Live-Widget, das Echtzeitdaten aus Ihrer Instanz abruft und auf Ihrem Dashboard anzeigt.

### „Importiere diese Excel-Datei in die Benutzertabelle“
AppAgent liest die Datei, ordnet Spalten den Feldern zu und importiert die Daten in Ihre Instanz.

### „Prüfe den Upgrade-Verlauf und behebe Probleme mit Anpassungen“
AppAgent prüft, was sich im Upgrade geändert hat, findet defekte Anpassungen und behebt sie.

### „Benachrichtige das Team, wenn ein P1-Incident erstellt wird“
AppAgent erstellt eine Benachrichtigungsregel, die bei P1-Incidents auslöst und eine Meldung an Ihr Team sendet.

---

## Die Vision

Opus 4.7 ist derzeit großartig, braucht aber noch etwas Betreuung.

Wir werden mit jeder Generation weiter ausloten, was KI-Modelle leisten können, und immer weiter im Abstraktions-Stack aufsteigen, bis wir nicht mehr weiterkommen.

GPT-4 => Code-Vervollständigung
GPT-4o => Schreibt eine eigenständige Datei
Sonnet 3.5 => Bearbeitet eine Datei in einer Codebasis
Opus 4.5 => Schreibt ein vollständiges Feature
Opus 4.6 => Pflegt eine App von Anfang bis Ende
Opus 4.7 => ... (wir testen noch)

---

## Roadmap

- RAG
- Spezifikationen und Testfälle

In keiner bestimmten Reihenfolge.

Diese Version dient vor allem dazu, Feedback zu sammeln.

Künftige Versionen sind möglicherweise nicht Open Source, aber wir pflegen diese Version weiter, bis sie stabil ist.

---

## Richtlinien für Beiträge

Bitte öffnen Sie keine PRs. Dies ist ein kommerzielles Projekt, und wir veröffentlichen den Code nur aus Gründen der Transparenz und des Vertrauens.

Wenn Sie Fehler finden, können Sie ein Issue eröffnen oder uns direkt kontaktieren. Wir bieten nur kommerziellen Support an und beheben daher nur Fehler, die auch andere Nutzer betreffen können.

---

## Lizenz

Private und kommerzielle Nutzung. Interne Anpassungen erlaubt. Weitergabe und Weiterverkauf verboten.
