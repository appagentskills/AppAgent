# AppAgent

**Twórz i utrzymuj aplikacje ServiceNow z pomocą agenta. Jako rozszerzenie Chrome.**

AppAgent to Twój partner w tworzeniu rozwiązań dla ServiceNow. Potrafi tworzyć i utrzymywać aplikacje oraz uruchamiać dla nich testy. Testuje, wypełniając formularze i robiąc zrzuty ekranu. Nie potrzebujesz żadnej wiedzy technicznej.

Wystarczy Twój własny klucz API (BYOK) i gotowe! Działa z OpenAI, OpenRouter, Claude API, a nawet z planami Claude Code (skontaktuj się z nami prywatnie).

To rozszerzenie Chrome, które przechowuje cały czat w Twojej przeglądarce (dane nawet jej nie opuszczają). Komunikuje się wyłącznie z Twoją instancją ServiceNow i dostawcą API modelu.

![Przykład AppAgent](AppAgentExample.png)

Zużywa mniej tokenów niż Claude Code, ponieważ w dużym stopniu korzysta z pamięci podręcznej API, buforowania narzędzi i łączenia wywołań narzędzi (od razu po instalacji).

Możesz dodawać do niego umiejętności, steruje przeglądarką przez karty i ma mechaniczne przyciski cofania dla wszystkich zmian, które wprowadza w Twojej instancji.

> **Uwaga:** Na razie AppAgent jest przeznaczony wyłącznie do instancji deweloperskich.

## Kontakt

Wypełnij ten formularz, a odezwiemy się: [Formularz kontaktowy](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Funkcje

| Funkcja | Co robi |
|---------|--------------|
| **Własny model** | Wybierz spośród Claude, GPT, Gemini, Grok i innych |
| **Logowanie przez Claude** | Przepływ OAuth — korzystaj z istniejącego planu Claude Code Personal lub Enterprise, bez klucza API |
| **Obrazy i pliki PDF** | Załączaj zrzuty ekranu, diagramy lub dokumenty do analizy przez agenta |
| **Edycja kodu** | Odczytuje i modyfikuje skrypty z pełnym śledzeniem wersji |
| **Sterowanie przeglądarką** | Sam testuje swoją pracę: przełącza karty, klika, wypełnia formularze, robi zrzuty ekranu |
| **Pulpity na żywo** | Tworzy widżety pobierające dane z Twojej instancji w czasie rzeczywistym |
| **Umiejętności agenta** | Twórz własne umiejętności, aby rozszerzać możliwości agenta |
| **Akcje umiejętności** | Umiejętności mogą dodawać na stronie głównej przyciski uruchamiające jednym kliknięciem gotowe przepływy pracy |
| **Postęp na żywo** | Zobacz w czasie rzeczywistym, co robi agent — zmieniające się znaczniki postępu ze stanami: w toku, zablokowany, gotowy, błąd |
| **Obszary robocze** | Brudnopis plików dla każdego czatu — klonuj repozytoria GitHub, odczytuj, zapisuj, edytuj, porównuj i przełączaj gałęzie. Wiele repozytoriów na czat, z ochroną własności plików między czatami |
| **Zintegrowany Git i wypychanie do GitHub** | Agent może pobierać z GitHub i wypychać do niego zmiany, tworzyć gałęzie i otwierać pull requesty bezpośrednio z czatu — bez terminala i bez IDE |
| **Inteligentne dokumenty** | Trwałe, wersjonowane dokumenty Markdown, które agent może edytować i przywoływać w różnych czatach |
| **Wiele instancji** | Automatycznie wykrywa każdą instancję ServiceNow otwartą w przeglądarce; agent widzi je wszystkie i może na nich działać z jednego czatu |
| **Podagenci** | Przekazuje ciężką lub równoległą pracę agentom roboczym w tle, którzy raportują wyniki do głównego czatu |
| **25 języków** | Interfejs i pomoc po angielsku i w 24 innych językach, w tym w pisanych od prawej do lewej arabskim i hebrajskim |
| **Wstrzymywanie i przerywanie** | Wstrzymaj lub wyślij nową wiadomość w trakcie odpowiedzi — bieżące wywołanie zostaje natychmiast przerwane |
| **Wyszukiwanie w sieci** | Darmowe wyszukiwanie w sieci bez klucza przez Google i DuckDuckGo |
| **Mechaniczne cofanie** | Każda zmiana jest śledzona, wycofanie jednym kliknięciem |
| **Eksport do XML** | Eksportuj wszystkie zmiany, aby wdrożyć je w innych instancjach |
| **Uprawnienia narzędzi** | Wbudowane zabezpieczenia: kontroluj, co agent może robić w instancji |
| **Otwarte standardy** | Zgodność z [OpenRouter](https://openrouter.ai) i [AgentSkills.io](https://agentskills.io) |
| **Buforowanie modelu** | Nawet 10-krotnie niższe koszty dzięki buforowaniu promptów |
| **Inteligentny kontekst** | Wczytuje tylko potrzebne fragmenty dużych plików. Nie przeciąża modelu |
| **Zero zależności** | Bez bibliotek i frameworków, czysty JavaScript (vanilla JS) |

## Jak to działa

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

AppAgent to rozszerzenie Chrome z wbudowaną pętlą agenta. Opisujesz, czego potrzebujesz → agent pyta model → wykonuje narzędzia w przeglądarce → korzysta z ServiceNow z uprawnieniami Twojego bieżącego użytkownika. Agent komunikuje się bezpośrednio z dostawcami API modeli, lokalnymi lub w chmurze.

## AppAgent na tle innych narzędzi

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Docelowy użytkownik** | Osoby nietechniczne | Programiści | Programiści | Nietechniczni założyciele firm |
| **Stworzony dla ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Agentowe działania w ServiceNow** | ✓ | ✓ | ✗ | ✗ |
| **Wymaga środowiska programistycznego** | ✗ | ✓ | ✓ | ✗ |
| **Tworzy aplikacje** | ✓ | ✓ | ✓ | ✓ |
| **Sterowanie przeglądarką do testów** | ✓ | ✗ | ✗ | ✗ |
| **Robi zrzuty ekranu** | ✓ | ✗ | ✗ | ✗ |
| **Zadania w tle** | ✓ (przez akcje umiejętności) | ✗ | ✓ | ✗ |
| **Agenci równolegli** | ✓ (podagenci) | ✗ | ✓ | ✗ |
| **Mechaniczne cofanie** | ✓ | ✗ | ✗ | ✗ |
| **Obrazy i pliki PDF** | ✓ | ✓ | ✓ | Ograniczone |
| **Inteligentne pulpity** | ✓ | ✗ | ✗ | ✓ |
| **Rozszerzalne umiejętności** | ✓ | ✓ | ✗ | ✗ |
| **Akcje umiejętności (przyciski jednym kliknięciem)** | ✓ | ✗ | ✗ | ✗ |
| **Znaczniki postępu na żywo** | ✓ | ✗ | ✗ | ✗ |
| **Obsługa wielu instancji** | ✓ | ✗ | ✗ | ✗ |
| **Obszary robocze dla każdego czatu** | ✓ | ✗ | ✗ | ✗ |
| **Zintegrowany git** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Wypychanie do GitHub z czatu** | ✓ | ✓ (CLI) | Ograniczone | ✗ |
| **Inteligentne dokumenty** | ✓ | ✗ | ✗ | ✗ |
| **Wstrzymywanie / przerywanie w trakcie odpowiedzi** | ✓ | ✓ | Ograniczone | ✗ |
| **Wyszukiwanie w sieci** | ✓ | ✓ | ✓ | ✗ |
| **Uprawnienia narzędzi** | ✓ | ✓ | Ograniczone | ✗ |
| **Eksport zmian** | ✓ XML | ✓ | ✓ | ✓ |
| **Własny model** | ✓ | ✗ | ✓ | ✗ |
| **Buforowanie promptów** | ✓ | ✓ | ✓ | ✗ |
| **Inteligentny kontekst** | ✓ | ✓ | ✓ | ✗ |
| **Zero zależności** | ✓ | ✗ | ✗ | ✓ |

*Base44 nie tworzy aplikacji ServiceNow, ale uwzględniliśmy go dla osób, które znają to narzędzie.*

## Konfiguracja

1. **Zainstaluj** — Zainstaluj rozszerzenie AppAgent z Chrome Web Store (lub wczytaj je jako rozpakowane na potrzeby programowania)
2. **Zdobądź klucz API** — Zarejestruj się w [OpenRouter](https://openrouter.ai), skorzystaj bezpośrednio z Anthropic/OpenAI lub połącz subskrypcję Claude Code (Enterprise lub Personal)
3. **Skonfiguruj** — Otwórz rozszerzenie i dodaj klucz API (lub zaloguj się przez Claude) w sekcji Ustawienia → Dostawcy API
4. **Zacznij tworzyć** — Otwórz swoją instancję ServiceNow w karcie (zostanie wykryta automatycznie) i zacznij czatować

## Przykłady

### „Zbuduj mi prostą aplikację do śledzenia zadań zespołu”
AppAgent utworzy tabelę, doda pola, zbuduje układ formularza i listy oraz skonfiguruje moduł w nawigatorze. Jeden prompt, cała aplikacja.

### „Przeprowadź pełny audyt tej instancji”
AppAgent wyszuka luki w zabezpieczeniach, nieaktywne konta administratorów, nieaktualne rekordy i odstępstwa od dobrych praktyk konfiguracji, a następnie przygotuje raport z rekomendacjami.

### „Przetestuj tę stronę i zgłoś wszystkie znalezione problemy”
AppAgent otworzy stronę w karcie przeglądarki, wypełni formularze, kliknie przyciski, zrobi zrzuty ekranu i przygotuje raport ze wszystkim, co znajdzie.

### „W tym formularzu jest błąd, możesz go naprawić?”
AppAgent otworzy formularz, przeanalizuje stojące za nim skrypty, zidentyfikuje błąd, poprawi kod i pokaże dokładnie, co się zmieniło. W razie potrzeby cofniesz to jednym kliknięciem.

### „Utwórz widżet pulpitu z moimi otwartymi zgłoszeniami”
AppAgent utworzy widżet na żywo, który pobiera dane z Twojej instancji w czasie rzeczywistym i wyświetla je na pulpicie.

### „Zaimportuj ten plik Excel do tabeli użytkowników”
AppAgent odczyta plik, przypisze kolumny do pól i zaimportuje dane do Twojej instancji.

### „Sprawdź historię aktualizacji i napraw problemy z dostosowaniami”
AppAgent przejrzy, co zmieniło się podczas aktualizacji, znajdzie uszkodzone dostosowania i je naprawi.

### „Powiadom zespół, gdy zostanie utworzony incydent P1”
AppAgent utworzy regułę powiadomień, która uruchamia się przy incydentach P1 i wysyła alert do Twojego zespołu.

---

## Wizja

Obecnie Opus 4.7 jest świetny, ale nadal wymaga pewnego nadzoru.

Z każdą generacją będziemy dalej przesuwać granice możliwości modeli AI i wspinać się coraz wyżej po stosie abstrakcji, aż utkniemy.

GPT-4 => Uzupełnianie kodu
GPT-4o => Pisze samodzielny plik
Sonnet 3.5 => Edytuje plik w bazie kodu
Opus 4.5 => Pisze kompletną funkcję
Opus 4.6 => Utrzymuje aplikację od początku do końca
Opus 4.7 => ... (wciąż testujemy)

---

## Plan rozwoju

- RAG
- Specyfikacje i przypadki testowe

W dowolnej kolejności.

Ta wersja służy głównie do zbierania opinii.

Kolejne wersje mogą nie być open source, ale będziemy utrzymywać tę wersję, dopóki nie będzie stabilna.

---

## Zasady współpracy

Prosimy nie otwierać żadnych PR — to projekt komercyjny, a kod udostępniamy publicznie wyłącznie dla przejrzystości i budowania zaufania.

Jeśli znajdziesz błędy, możesz zgłosić issue lub skontaktować się z nami bezpośrednio. Oferujemy wyłącznie wsparcie komercyjne, dlatego naprawiamy tylko błędy, które mogą dotyczyć innych użytkowników.

---

## Licencja

Użytek prywatny i komercyjny. Modyfikacje na potrzeby wewnętrzne dozwolone. Dystrybucja i odsprzedaż zabronione.
