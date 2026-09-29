# Pierwsze kroki {#getting-started}

AppAgent to agent AI dla ServiceNow działający jako rozszerzenie Chrome. Opisz zwykłym językiem, czego potrzebujesz, a agent wyszuka dane, zmodyfikuje rekordy, zbuduje aplikacje i widżety, przetestuje strony w Twojej przeglądarce i przedstawi wyniki.

:::tip
**Szybki start:** Skonfiguruj model, otwórz kartę ze swoją instancją ServiceNow, a następnie wpisz polecenie w czacie i naciśnij <kbd>Enter</kbd>.
:::

## Konfiguracja modelu {#guide-setup}

1. Otwórz [Ustawienia](app:openSettingsPageView) i przejdź do sekcji **Dostawcy API**
2. Dodaj dostawcę (Anthropic, OpenRouter lub własne API zgodne z OpenAI) wraz z kluczem API — albo włącz **OAuth** u dostawcy Anthropic, aby zalogować się kontem Claude
3. Wybierz model w sekcji **Model agenta**

Klucz API jest przechowywany wyłącznie w Twojej przeglądarce. Wywołania AI trafiają bezpośrednio z przeglądarki do dostawcy.

## Łączenie instancji {#guide-instances}

AppAgent **automatycznie wykrywa każdą instancję ServiceNow** otwartą w tym samym profilu Chrome — nie trzeba wpisywać żadnych danych połączenia. Zaloguj się do instancji w zwykłej karcie, a agent będzie mógł na niej pracować z rolami i uprawnieniami Twojego użytkownika. Napisz *„list instances”*, aby zobaczyć wszystkie wykryte instancje, swoje role i stan połączenia.

Każda instancja ma **poziom uprawnień**, wybierany z listy rozwijanej instancji:

- **Ręcznie** — Zatwierdzasz każdą operację zapisu (tworzenie, aktualizację, usuwanie, wypełnianie formularzy)
- **Auto** — Agent sam decyduje o operacjach zapisu, bez pytania
- **Dev** — Żadnych zatwierdzeń: każde wywołanie narzędzia w tej instancji jest wykonywane bez pytania. Używaj tylko w instancjach deweloperskich

Odczyt jest zawsze dozwolony. Dokładniejszą kontrolę zapewniają [Uprawnienia narzędzi](#feature-permissions).

## Rozpoczynanie czatu {#guide-chat}

1. Kliknij **Nowy czat** na pasku bocznym [Rozpocznij nowy czat →](app:startNewChat)
2. Wpisz polecenie, na przykład *„Pokaż wszystkie incydenty utworzone dzisiaj”*
3. Naciśnij <kbd>Enter</kbd>, aby wysłać
4. Śledź pracę agenta: każde wywołanie narzędzia pojawia się w czacie, a gdy krok wymaga Twojej zgody, wyświetla się prośba o zatwierdzenie

Możesz pisać dalej, gdy agent pracuje: wysłanie nowej wiadomości przerywa bieżący krok, a **Wstrzymaj** zatrzymuje przebieg.

## Załączanie obrazów i plików {#guide-images}

1. Kliknij przycisk **Załącz plik** w polu wprowadzania, aby dodać obraz, plik PDF, CSV lub tekstowy
2. Możesz też wkleić obraz ze schowka albo przeciągnąć go i upuścić na czat
3. Wpisz pytanie dotyczące załącznika

:::tip
Załączaj zrzuty ekranu z błędami, makiety interfejsu lub wyeksportowane dane, aby agent widział dokładnie to, co Ty.
:::

# Najważniejsze funkcje {#features}

## Czat {#page-chat}

Główny widok rozmowy. [Rozpocznij nowy czat →](app:startNewChat)

- **Obszar wiadomości** — Rozmowa wraz z wywołaniami narzędzi i ich wynikami
- **Pole wprowadzania** — Wpisuj wiadomości, załączaj pliki; wyślij wiadomość w trakcie pracy agenta, aby go przerwać
- **Wstrzymaj / Kontynuuj / Ponów** — Zatrzymaj agenta, wznów jego pracę lub ponów ostatni krok
- **Wskaźnik kontekstu** — Pokazuje stopień zapełnienia rozmowy; kliknij go, aby podsumować ją w nowym czacie
- **Karty odpowiedzi** — Pod odpowiedzią może pojawić się podsumowanie **W skrócie** oraz karta **Linki** (rekordy, PR, dokumenty)
- **Nagłówek czatu** — Zmień nazwę czatu lub go przypnij albo otwórz AppAgent w pełnej karcie przeglądarki za pomocą **Rozwiń na całą stronę**

## Sterowanie przeglądarką {#feature-browser}

Agent może otwierać karty przeglądarki z Twoją instancją i nimi sterować, aby oglądać i testować strony:

- **Nawigacja, klikanie, wypełnianie i wybieranie** — Realistyczne zdarzenia, dzięki którym formularze i pola z autouzupełnianiem zachowują się tak, jakbyś pisał sam
- **Oczekiwanie** — Czekanie na element, tekst lub adres URL zamiast zgadywania opóźnień
- **Zrzuty ekranu** — Przechwytywanie strony, widżetu lub pojedynczego elementu do kontroli wizualnej
- **Inspekcja** — Odczyt właściwości i stylów elementów, błędów konsoli oraz żądań sieciowych
- **Personifikacja** — Testowanie jako inny użytkownik, a potem powrót do własnego konta

## Edycja rekordów i historia wersji {#feature-history}

Każda zmiana wprowadzona przez agenta w Twojej instancji jest śledzona na pasku bocznym czatu:

- **Cofnij** — Wycofaj pojedynczą zmianę
- **Ponów** — Przywróć wycofaną zmianę
- **Pobierz XML** — Wyeksportuj wszystkie zmiany, na przykład aby przenieść je do innej instancji

## Podagenci {#feature-subagents}

Przy ciężkiej lub równoległej pracy agent może uruchamiać **podagentów**: procesy robocze w tle, które działają we własnym czacie i kontekście, a następnie przekazują krótki wynik do głównego czatu.

- **Poziomy modeli** — Każdy podagent działa na poziomie **małym**, **średnim** lub **dużym** albo na poziomie **taki sam**, czyli z modelem czatu nadrzędnego. Przypisz modele do poziomów w [Ustawieniach](app:openSettingsPageView) → **Poziomy modeli podagentów**
- **Pasek procesów roboczych** — Działający podagenci są widoczni jako aktualizowane na żywo etykiety nad polem wprowadzania; otwórz jedną z nich, aby śledzić postęp lub przeczytać zapis rozmowy
- **Pula** — Liczba jednocześnie działających podagentów jest ograniczona; pozostali czekają w kolejce

## Pulpit i widżety {#page-dashboard}

Pulpit z interaktywnymi widżetami generowanymi przez agenta. [Otwórz pulpit →](app:openDashboardView)

1. Kliknij **Dodaj widżet**
2. Opisz, czego potrzebujesz, na przykład *„Wykres otwartych incydentów według priorytetu”*
3. Agent zbuduje widżet; w każdej chwili możesz poprosić o zmiany lub kliknąć **Wygeneruj ponownie**

Widżety mogą pobierać dane z Twojej instancji na żywo, więc są zawsze aktualne. Możesz je przeciągać, zmieniać ich rozmiar, importować i eksportować (zobacz [Zaawansowane](#advanced)). Widżety wyświetlane przez agenta bezpośrednio w czacie można zapisać za pomocą **Przypnij do pulpitu**.

## Inteligentne dokumenty {#page-documents}

**Inteligentne dokumenty** to trwałe, wersjonowane dokumenty Markdown, które agent pisze i aktualizuje — plany, raporty, specyfikacje, ustalenia. Wyświetlają się bezpośrednio w czacie, zachowują każdą wersję i możesz je edytować samodzielnie. Otwierasz je z sekcji **Dokumenty** na pasku bocznym. [Otwórz dokumenty →](app:openDocumentsView)

## Umiejętności {#page-skills}

Umiejętności dają agentowi dodatkową wiedzę i narzędzia. [Otwórz umiejętności →](app:openSkillsView)

- **Aktywuj / Dezaktywuj** — Włączaj i wyłączaj umiejętności; dezaktywuj niepotrzebne, aby odpowiedzi były bardziej trafne
- **Nowa umiejętność** — Napisz własną umiejętność w Markdown lub użyj opcji **Edytuj z agentem**
- **Importuj / Eksportuj** — Udostępniaj umiejętności jako foldery
- **Akcje umiejętności** — Niektóre umiejętności dodają na stronie głównej przyciski, które jednym kliknięciem uruchamiają gotowy przepływ pracy

Umiejętność może zapewniać **wiedzę** (instrukcje, dobre praktyki) oraz **niestandardowe narzędzia** (funkcje JavaScript uruchamiane w izolowanej piaskownicy).

## Obszar roboczy i GitHub {#feature-workspace}

Każdy czat ma **obszar roboczy** — przestrzeń na pliki, w której agent może je odczytywać, zapisywać, edytować i porównywać.

- **GitHub** — Połącz konto GitHub w [Ustawieniach](app:openSettingsPageView), aby klonować repozytoria do obszaru roboczego. Agent może tworzyć gałęzie, wypychać commity i otwierać pull requesty z poziomu czatu
- **Pull requesty** — PR otwarte z czatu są wyświetlane na pasku bocznym czatu wraz z przyciskiem **Scal**
- **Ochrona między czatami** — Każdy plik pamięta, który czat go zmienił, więc dwa czaty pracujące równolegle nie nadpiszą po cichu swojej pracy
- **Automatyczna synchronizacja** — Sklonowane obszary robocze synchronizują się z GitHub, gdy nawigujesz, przełączasz czaty lub wracasz do karty

## Pasek boczny czatu {#feature-sidebar}

Prawy pasek boczny zbiera wszystko, co wytworzył bieżący czat:

- **Pull requesty** — Tytuł, gałąź docelowa i przycisk **Scal**
- **Pliki obszaru roboczego** — Otwórz plik, aby go wyświetlić, zobaczyć różnice lub przejrzeć wcześniejsze wersje
- **Historia wersji** — Zmiany w instancji z przyciskami **Cofnij**, **Ponów** i **Pobierz XML**
- **Procesy robocze** — Działający i zakończeni podagenci z licznikami wywołań narzędzi, edytowanych plików i otwartych PR

## Akcje i postęp na żywo {#feature-actions}

Długie zadania pokazują postęp na żywo, zamiast milczeć:

- **Karta postępu** — Pojedyncza karta z kolorowym stanem (w toku, zablokowane, gotowe, błąd) i listą kroków
- **Przyciski akcji** — Przyciski uruchamiające jednym kliknięciem kolejne przepływy pracy
- **Wskaźnik działania** — Lista czatów oznacza czaty, w których agent właśnie pracuje
- **Powiadomienie „Agent zakończył pracę”** — Jeśli podczas przebiegu przełączysz kartę lub okno, powiadomienie na pulpicie systemu poinformuje Cię, gdy agent skończy

## Aktywne czaty i zadania {#feature-jobs}

Znacznik zadań w nagłówku otwiera widok na żywo Twoich czatów i pracy w tle:

- **Aktywne czaty** — Działające czaty i czaty z nieprzeczytanymi wynikami (wyróżnione **pogrubieniem**), każdy z pierścieniem wykorzystania kontekstu
- **Podagenci** — Wyświetlani pod swoim czatem nadrzędnym; otwórz jednego z nich, aby przeczytać zapis rozmowy
- **Rozwiń** — Otwórz listę jako większy panel w układzie kolumn lub sekcji

## Uprawnienia narzędzi {#feature-permissions}

Oprócz poziomu uprawnień dla instancji (**Ręcznie**, **Auto**, **Dev**) każde narzędzie ma własne ustawienie w [Ustawieniach](app:openSettingsPageView) → **Uprawnienia narzędzi**:

- **Zezwól** — Narzędzie zawsze działa bez pytania
- **Auto** — Narzędzie działa bez pytania, chyba że agent oznaczy wywołanie jako wymagające Twojego potwierdzenia
- **Pytaj** — Przed każdym wywołaniem pojawia się prośba o zatwierdzenie
- **Wył.** — Agent nie może używać narzędzia

Niektóre narzędzia mają dokładniejsze ustawienia: API ServiceNow według metody HTTP (GET, POST, PUT, PATCH, DELETE), sterowanie przeglądarką według akcji (nawigacja, klikanie, wypełnianie, personifikacja…) oraz zarządzanie umiejętnościami według akcji. Okna potwierdzeń są oznaczone kolorami według ryzyka: **niebieski** (rutynowe), **pomarańczowy** (ostrożnie), **czerwony** (destrukcyjne).

:::tip
Pozostaw DELETE i inne destrukcyjne operacje na poziomie **Pytaj**, a poziomu **Dev** używaj tylko w instancjach deweloperskich.
:::

## Narzędzia agenta {#feature-tools}

Główne narzędzia, z których korzysta agent:

| Narzędzie | Co robi |
|------|--------------|
| **API ServiceNow** (`servicenow_api`) | Odczyt, tworzenie, aktualizacja i usuwanie rekordów |
| **Skrypt w tle** (`servicenow_run_script`) | Uruchamianie skryptu po stronie serwera w instancji (wymaga roli admin) |
| **Edycja skryptów** (`servicenow_diff_edit`) | Zmiana skryptów za pomocą precyzyjnych edycji typu „znajdź i zamień” |
| **Sterowanie przeglądarką** (`iframe_tool`) | Nawigacja, klikanie, wypełnianie, inspekcja i personifikacja w kartach przeglądarki |
| **Kod w przeglądarce** (`js_eval`) | Uruchamianie JavaScriptu w izolowanej piaskownicy, która może wywoływać inne narzędzia |
| **Zrzuty ekranu** (`take_screenshot`) | Przechwytywanie strony, widżetu lub elementu |
| **Widżety i karty** (`html_widget`, `display`) | Wyświetlanie w czacie interaktywnych widżetów, tabel, kart i osi czasu |
| **Inteligentne dokumenty** (`document`) | Tworzenie i aktualizowanie trwałych dokumentów Markdown |
| **Pytanie użytkownika** (`prompt_user`) | Prośba o dane za pomocą formularza w czacie |
| **Podagenci** (`spawn_sub_agent`) | Przekazywanie pracy procesom roboczym w tle |
| **Obszar roboczy** (`workspace`) | Praca z plikami i repozytoriami GitHub |
| **Pobieranie z sieci** (`web_fetch`) | Odczyt stron z publicznego internetu |
| **Umiejętności** (`get_skill`, `manage_skill`) | Odczyt umiejętności i zarządzanie nimi |

Otwórz [Ustawienia](app:openSettingsPageView) → **Uprawnienia narzędzi**, aby zobaczyć każde narzędzie, jego źródło i uprawnienie.

## Buforowanie dużych treści {#feature-caching}

Gdy wynik narzędzia jest zbyt duży dla rozmowy (domyślnie ponad 4K tokenów), AppAgent go buforuje. Agent otrzymuje zarys, a następnie odczytuje, przeszukuje lub przegląda tylko potrzebne fragmenty. Dzięki temu czaty pozostają szybkie i skupione na zadaniu. Próg (od 1K do 100K tokenów) zmienisz w [Ustawieniach](app:openSettingsPageView) → **Buforowanie dużych treści**.

## Wskaźnik kontekstu {#feature-saturation}

**Wskaźnik kontekstu** obok pola wprowadzania pokazuje, w jakim stopniu rozmowa jest zapełniona. Po przekroczeniu 50% agent jest proszony o zakończenie pracy i przekazanie pozostałych ciężkich zadań podagentom; przy 100% zatrzymuje się i przedstawia raport. W każdej chwili możesz kliknąć wskaźnik, aby podsumować rozmowę w nowym czacie.

## Użycie i limity {#feature-usage}

- **Znacznik użycia** — Nagłówek pokazuje wykorzystanie API i pozostałe limity; kliknij, aby zobaczyć szczegóły
- **Automatyczne ponowienia** — Gdy dostawca ogranicza liczbę żądań lub jest przeciążony (HTTP 429 / 529), AppAgent czeka i automatycznie ponawia próbę, wyświetlając w czacie odliczanie
- **Brak środków** — Gdy błąd 429 oznacza w rzeczywistości wyczerpanie środków, czat jasno to komunikuje

## Języki {#feature-languages}

Interfejs jest dostępny po angielsku i w 24 innych językach: arabskim, chińskim (uproszczonym i tradycyjnym), czeskim, duńskim, niderlandzkim, fińskim, francuskim (Francja, Kanada), niemieckim, hebrajskim, węgierskim, włoskim, japońskim, koreańskim, norweskim, polskim, portugalskim (Brazylia, Portugalia), rosyjskim, hiszpańskim, szwedzkim, tajskim i tureckim.

Wybierz język w [Ustawieniach](app:openSettingsPageView) → **Język** lub w menu szybkich ustawień w nagłówku. Opcja **Auto** korzysta z języka przeglądarki, a w razie jego braku z angielskiego. Zmiana obowiązuje natychmiast, bez przeładowania.

- **Od prawej do lewej** — Arabski i hebrajski mają układ od prawej do lewej
- **Formaty lokalne** — Daty, godziny i liczby są wyświetlane zgodnie z Twoim językiem
- **Odpowiedzi agenta** — Agent odpowiada w wybranym języku, chyba że piszesz w innym. Kod oraz nazwy tabel i pól pozostają bez zmian
- **Ta strona pomocy** — Wyświetlana w Twoim języku; dziennik zmian pozostaje po angielsku

# Strony i ustawienia {#pages}

## Ustawienia {#page-settings}

[Otwórz ustawienia →](app:openSettingsPageView)

- **Model agenta** — Model, którego używa agent
- **Dostawcy API** — Anthropic, OpenRouter lub własni dostawcy, z kluczem API lub OAuth
- **Punkty końcowe LLM** — Nazwane pary `URL + API key` dla dowolnego API zgodnego z OpenAI
- **Poziomy modeli podagentów** — Przypisz modele do poziomów mały, średni i duży albo wybierz **Taki sam**
- **Poziom rozumowania, Maks. tokenów i Budżet myślenia** — Dostosuj głębię i długość odpowiedzi
- **Okno kontekstu** — Rozmiar kontekstu używany przez wskaźnik kontekstu
- **Wyświetlanie** — Statystyki API, tryb kompaktowy, niewygaszanie ekranu
- **Język** — Język interfejsu lub **Auto**
- **Hooki** — Automatyczne tytuły czatów, powiadomienia „Agent zakończył pracę” i inna automatyzacja
- **Buforowanie dużych treści** — Kiedy duże wyniki są buforowane
- **Uprawnienia narzędzi** — Co działa automatycznie, co najpierw pyta, a co jest wyłączone
- **GitHub** — Połącz konto GitHub i zarządzaj sklonowanymi repozytoriami
- **Prompt systemowy** — Dostosuj instrukcje agenta
- **Zarządzanie danymi** — Eksportuj, importuj lub usuń swoje dane

## Historia {#page-history}

Wszystkie Twoje rozmowy. [Otwórz historię →](app:openHistoryView)

- **Szukaj** — Znajduj czaty według tytułu, treści, użytych narzędzi lub widżetów
- **Przypnij** — Utrzymuj ważne czaty na górze listy
- **Eksportuj** — Pobierz jeden czat lub całą historię
- **Statystyki** — Liczba czatów, przypiętych czatów i łączny koszt

## Pomoc {#page-docs}

Ta strona. [Otwórz pomoc →](app:openDocsView)

- **Szukaj** — Filtruj tematy pomocy za pomocą pola wyszukiwania na pasku narzędzi
- **Spis treści** — Przejdź do sekcji z poziomu spisu
- **Pobierz** — Zapisz dokumentację jako plik Markdown

# Wskazówki i skróty klawiszowe {#tips}

| Akcja | Jak |
|--------|-----|
| Wyślij wiadomość | <kbd>Enter</kbd> |
| Nowy wiersz | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Szukaj czatów | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> na Macu) |
| Zamknij okno dialogowe lub menu | <kbd>Esc</kbd> |
| Wróć | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Załącz obraz | Wklej go albo przeciągnij i upuść na czat |
| Zacznij od nowa z podsumowaniem | Kliknij wskaźnik kontekstu |
| Przerwij pracę agenta | Wyślij nową wiadomość lub kliknij **Wstrzymaj** |

:::tip
**Bądź konkretny.** Zamiast *„napraw to”* napisz *„napraw błąd null reference w wierszu 42 skryptu include MyUtils”*. Gdy to możliwe, podaj nazwę tabeli, rekordu lub strony.
:::

- **Jeden cel na czat** — Rozpocznij nowy czat dla niezwiązanego zadania; agent będzie wtedy szybszy i dokładniejszy
- **Pozwól mu testować** — Poproś agenta, aby otworzył stronę i zweryfikował swoją zmianę zrzutem ekranu
- **Korzystaj z umiejętności** — Przed rozpoczęciem aktywuj umiejętność pasującą do zadania (na przykład testowanie lub audyt)

# Rozwiązywanie problemów i FAQ {#faq}

### Agent nie widzi mojej instancji

Otwórz instancję w karcie tego samego profilu Chrome i upewnij się, że jesteś zalogowany, a następnie napisz *„list instances”*. Jeśli nadal się nie pojawia, przeładuj kartę z instancją.

### Pojawia się błąd API lub uwierzytelniania

Sprawdź dostawcę w [Ustawieniach](app:openSettingsPageView) → **Dostawcy API**: klucz API, wybrany punkt końcowy i nazwę modelu. W przypadku OAuth zaloguj się ponownie do claude.ai w tym samym profilu Chrome.

### Agent zgłasza przekroczenie limitu żądań

AppAgent automatycznie ponawia próby i wyświetla odliczanie. Jeśli problem się powtarza, sprawdź pozostałe środki w znaczniku użycia albo użyj mniejszego poziomu modelu dla podagentów.

### Za dużo próśb o zatwierdzenie albo za mało

Zmień poziom uprawnień instancji (**Ręcznie**, **Auto**, **Dev**) na liście rozwijanej instancji i dostosuj poszczególne narzędzia w [Ustawieniach](app:openSettingsPageView) → **Uprawnienia narzędzi**.

### W długim czacie odpowiedzi są wolniejsze lub mniej trafne

Kontekst rozmowy się zapełnia. Kliknij wskaźnik kontekstu, aby kontynuować w nowym czacie z podsumowaniem.

### Jak cofnąć zmianę?

Otwórz pasek boczny czatu i kliknij **Cofnij** przy zmianie w historii wersji. **Pobierz XML** eksportuje wszystkie zmiany.

### Gdzie są przechowywane moje dane?

Lokalnie w Twojej przeglądarce (IndexedDB). Czaty nigdy nie trafiają na serwer AppAgent — tylko do Twojego dostawcy AI i Twojej instancji ServiceNow. Zobacz [Przechowywanie danych](#adv-data-storage).

### Interfejs lub ta strona jest w złym języku

Wybierz język w [Ustawieniach](app:openSettingsPageView) → **Język**. Opcja **Auto** korzysta z języka przeglądarki.

# Zaawansowane {#advanced}

Ta sekcja opisuje funkcje zaawansowane, przyciski w nagłówkach, formaty importu i eksportu oraz szczegóły techniczne działania AppAgent.

## Przyciski w nagłówku pulpitu {#adv-dashboard-header}

Nagłówek pulpitu zawiera kilka przycisków akcji:

| Przycisk | Opis |
|--------|-------------|
| **Przełącz pasek boczny** | Pokaż lub ukryj lewy pasek nawigacji |
| **Otwórz osobno** | Otwórz pulpit w nowej karcie przeglądarki jako osobny widok |
| **Nagłówki** | Przełącz widoczność nagłówków widżetów na pulpicie. Po ich ukryciu widżety wyświetlają się w bardziej przejrzystym widoku |
| **Wygeneruj ponownie wszystkie** | Wygeneruj ponownie za pomocą agenta wszystkie widżety na pulpicie. Przydatne do odświeżenia danych |
| **Importuj** | Zaimportuj pulpit lub widżet z pliku JSON |
| **Eksportuj** | Wyeksportuj cały pulpit do pliku JSON jako kopię zapasową lub w celu udostępnienia |
| **Dodaj widżet** | Otwiera edytor widżetów, w którym utworzysz nowy widżet z pomocą agenta |

## Przyciski w nagłówku widżetu {#adv-widget-headers}

**Nagłówki widżetów na pulpicie** (widoczne, gdy przełącznik Nagłówki jest włączony):

| Przycisk | Opis |
|--------|-------------|
| **Uchwyt przeciągania** | Ikona widżetu służy jako uchwyt do przeciągania i zmiany kolejności widżetów |
| **Wygeneruj ponownie** | Poproś agenta o ponowne wygenerowanie zawartości tego widżetu |
| **Historia** | Wyświetl poprzednie wersje tego widżetu (jeśli są dostępne) |
| **Pełny ekran** | Rozwiń widżet na pełny ekran |
| **Edytuj** | Otwórz edytor widżetu, aby zmodyfikować go w czacie z agentem |
| **Usuń** | Usuń widżet z pulpitu (z potwierdzeniem) |

**Nagłówki widżetów w czacie** (widżety wyświetlane w rozmowie):

| Przycisk | Opis |
|--------|-------------|
| **Przypnij do pulpitu** | Zapisz ten widżet na swoim pulpicie |
| **Edytuj kod** | Wyświetl i edytuj bezpośrednio kod HTML/CSS/JS widżetu |
| **Rozwiń/zwiń** | Przełącz widoczność zawartości widżetu |

## Zmiana rozmiaru i przenoszenie widżetów {#adv-resize-move}

**Zmiana rozmiaru widżetów:**

- Każdy widżet ma w prawym dolnym rogu **uchwyt zmiany rozmiaru**
- Kliknij i przeciągnij uchwyt, aby zmienić rozmiar widżetu
- Szerokość jest przyciągana do siatki 12 kolumn (minimum 3 kolumny)
- Wysokość jest mierzona w jednostkach po 50px (minimum 2 jednostki = 100px)

**Przenoszenie widżetów:**

- Włącz przełącznik **Nagłówki**, aby wyświetlić nagłówki widżetów
- Kliknij i przeciągnij **ikonę widżetu** (uchwyt przeciągania), aby zmienić kolejność
- Upuść widżet na inny widżet, aby zamienić je miejscami
- Kolejność widżetów jest zapisywana automatycznie

## Formaty importu i eksportu {#adv-import-export}

**Eksport pulpitu** (`dashboard-YYYY-MM-DD.json`):

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

**Eksport pojedynczego widżetu:**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Eksport pojedynczego czatu** (`chat-title-YYYY-MM-DD.json`):

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

Eksport czatu zachowuje pełną historię rozmowy, w tym wszystkie wiadomości użytkownika i odpowiedzi agenta. Aby wyeksportować pojedynczy czat, otwórz menu rozwijane czatu (···) i wybierz **Pobierz**.

**Eksport umiejętności** (struktura folderów):

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Uwaga:** Import i eksport umiejętności korzysta z File System Access API i **działa tylko w przeglądarkach Chrome i Edge**.
:::

**Eksport wszystkich danych** (`appagent-backup-YYYY-MM-DD.json`):

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

Pełna kopia zapasowa obejmuje całą historię czatów, ustawienia, uprawnienia narzędzi, widżety pulpitu i konfiguracje dostawców API.

## Statystyki API {#adv-api-stats}

Po włączeniu w Ustawieniach statystyki API są wyświetlane po każdej odpowiedzi agenta:

| Wskaźnik | Opis |
|--------|-------------|
| **Wejście** | Tokeny wejściowe — rozmiar promptu wysłanego do agenta |
| **Wyjście** | Tokeny wyjściowe — rozmiar odpowiedzi agenta |
| **Łącznie** | Suma tokenów wejściowych i wyjściowych |
| **Odczyt/zapis bufora** | Tokeny odczytane z bufora promptów lub w nim zapisane (obniża koszty) |
| **Rozumowanie** | Tokeny użyte na wewnętrzne rozumowanie (niektóre modele) |
| **Koszt** | Szacunkowy koszt wywołania API w USD |
| **Czas trwania** | Czas wykonania wywołania API |

W rozmowach wieloetapowych statystyki zbiorcze pokazują sumę ze wszystkich wywołań.

:::tip
Wyświetlanie statystyk API włączysz w [Ustawieniach](app:openSettingsPageView) → Wyświetlanie → Pokaż statystyki API.
:::

## Ręczna edycja umiejętności {#adv-skills-manual}

Umiejętności można tworzyć i edytować ręcznie lub z pomocą agenta:

**Ręczne tworzenie umiejętności:**

1. Przejdź do [Umiejętności](app:openSkillsView) i kliknij **Nowa umiejętność**
2. Wpisz nazwę i opis umiejętności
3. Napisz treść umiejętności w formacie Markdown
4. Kliknij **Zapisz**, aby utworzyć umiejętność

**Format SKILL.md:**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Edycja z agentem:**

1. Kliknij **Edytuj z agentem** przy dowolnej umiejętności
2. Opisz, jakie zmiany chcesz wprowadzić
3. Agent zmodyfikuje treść umiejętności
4. Przejrzyj i zapisz zmiany

**Zasoby umiejętności:** Umiejętności mogą zawierać dodatkowe pliki (XML, JS, MD), które dostarczają agentowi dodatkowego kontekstu lub kodu.

## Prompt systemowy {#adv-system-prompt}

Prompt systemowy określa zachowanie i możliwości agenta. Możesz go dostosować w [Ustawieniach](app:openSettingsPageView).

**Edycja promptu systemowego:**

1. Przejdź do Ustawienia → sekcja Prompt systemowy
2. Kliknij **Edytuj**, aby przejść do trybu edycji
3. Zmodyfikuj szablon według potrzeb
4. Kliknij **Zapisz**, aby zastosować zmiany

**Dostępne symbole zastępcze:**

| Symbol zastępczy | Opis |
|-------------|-------------|
| `{{CURRENT_DATE}}` | Dzisiejsza data (dzień tygodnia, miesiąc, dzień, rok) |
| `{{ORCHESTRATOR_POLICY}}` | Zasady delegowania do podagentów — dołączane w głównych czatach, puste w czatach podagentów |
| `{{DISABLED_TOOLS}}` | Lista wyłączonych narzędzi |
| `{{TOOL_CATALOG}}` | Katalog narzędzi odroczonych (pusty, gdy odroczone ładowanie narzędzi jest wyłączone) |
| `{{SKILLS_SUMMARY}}` | Treść aktywnych umiejętności |

Symbole zastępcze są automatycznie zastępowane rzeczywistymi wartościami podczas wysyłania do AI. Licznik tokenów pokazuje zarówno rozmiar szablonu, jak i rozmiar po rozwinięciu.

:::tip
W razie potrzeby kliknij **Przywróć domyślny**, aby przywrócić oryginalny prompt systemowy.
:::

## Wywołania API agenta {#adv-agent-api}

AppAgent działa jako **rozszerzenie Chrome**:

- Wywołania API AI trafiają **bezpośrednio z Twojej przeglądarki do dostawcy AI** (np. Anthropic, OpenRouter)
- **Nie** przechodzą przez Twoją instancję ani przez żaden serwer AppAgent
- Twój klucz API (lub token OAuth) jest przechowywany lokalnie w przeglądarce
- Dane rozmowy są wysyłane do dostawcy AI w celu przetworzenia

**Jak to działa:**

1. Wpisujesz wiadomość w czacie
2. AppAgent tworzy prompt z instrukcjami systemowymi, narzędziami i historią rozmowy
3. Prompt jest wysyłany do API dostawcy AI
4. Odpowiedź agenta jest strumieniowo przesyłana z powrotem do Twojej przeglądarki
5. Wywołania narzędzi są wykonywane w przeglądarce, a wywołania API korzystają z sesji Twojej instancji

:::tip
**Prywatność:** Twój klucz API i dane rozmowy są przetwarzane po stronie klienta. Wywołania narzędzi komunikujące się z instancją korzystają z poświadczeń Twojej bieżącej sesji.
:::

## Punkty końcowe LLM {#adv-endpoints}

Modele łączą się przez **nazwane punkty końcowe LLM** — wielokrotnego użytku pary `URL + API key`. Dzięki temu możesz skierować AppAgent do **dowolnego API chat completions zgodnego z OpenAI**: OpenRouter, lokalnej bramy, serwera proxy lub własnego hostowanego modelu.

1. W [Ustawieniach → Punkty końcowe LLM](app:openSettingsPageView) kliknij **Dodaj punkt końcowy**
2. Podaj nazwę, adres URL API i klucz API
3. Każdy model (dostawca API) wybiera punkt końcowy — zaktualizuj klucz raz, a zmiana obejmie każdy model, który z niego korzysta

:::tip
Dostawcy Claude z **OAuth** nie używają punktów końcowych — komunikują się bezpośrednio z `api.anthropic.com`.
:::

## Logowanie przez Claude (OAuth) {#adv-oauth}

Zamiast wklejać klucz API, możesz zalogować się do dostawców Anthropic, korzystając z istniejącej sesji claude.ai:

1. W [Ustawieniach → Dostawcy API](app:openSettingsPageView) dodaj lub edytuj dostawcę Anthropic i włącz **OAuth**
2. Rozszerzenie używa Twojego logowania do claude.ai z tego samego profilu Chrome, aby połączyć się bezpośrednio z Anthropic
3. Bez dodatkowego okna logowania i bez pośredniczącego serwera AppAgent

**Wymagania:**

- Musisz być zalogowany do `claude.ai` w tym samym profilu Chrome
- Działa z kontami logowania jednokrotnego (SSO)

:::tip
Tokeny OAuth są odświeżane automatycznie. Jeśli logowanie się nie powiedzie, otwórz `claude.ai` w tym samym profilu i zaloguj się ponownie.
:::

## Kwestie bezpieczeństwa {#adv-security}

**Przechowywanie klucza API:**

- Twój **klucz API jest przechowywany lokalnie** w bazie IndexedDB przeglądarki
- Klucz nigdy nie jest wysyłany do Twojej instancji ani na żaden serwer poza dostawcą AI
- Wyczyszczenie danych przeglądarki usunie zapisany klucz API

**Sesja i uprawnienia:**

- Agent działa w ramach Twojej **bieżącej sesji użytkownika**, dziedzicząc Twoje uprawnienia i role
- Wszystkie wywołania API do Twojej instancji korzystają z poświadczeń Twojej sesji
- Agent ma dostęp tylko do tego, do czego ma dostęp Twoje konto użytkownika

**Środowisko wykonywania narzędzi:**

- **Kod w przeglądarce (js_eval)** uruchamia JavaScript w **izolowanej piaskownicy** z dostępem wyłącznie do `executeTool()`
- **Skrypty widżetów** działają w **izolowanych ramkach iframe** z dostępem wyłącznie do `executeTool()` na potrzeby wywołań API
- **Narzędzia umiejętności** działają w **izolowanych piaskownicach** z dostępem wyłącznie do `executeTool()`
- Cały dostęp do API przechodzi przez **system uprawnień** za pomocą `executeTool("servicenow_api", {...})`
- Agent działa na stronach w **kartach przeglądarki** z Twoją instancją ServiceNow

**Możliwości modyfikowania rekordów:**

- Narzędzie **API ServiceNow** obsługuje metody POST, PATCH, PUT i DELETE, które mogą zmieniać rekordy
- Agent może tworzyć i edytować rekordy przez **zintegrowaną przeglądarkę**, jeśli ma uprawnienia do narzędzi wypełniania i klikania
- Skonfiguruj [Uprawnienia narzędzi](app:openSettingsPageView), aby określić, które operacje wymagają zatwierdzenia

**Samodoskonalenie:**

- Agent może **zarządzać własnymi umiejętnościami** — tworzyć, edytować i aktywować umiejętności
- Dzięki temu agent może z czasem się uczyć i doskonalić
- Regularnie przeglądaj zmiany w umiejętnościach, aby upewnić się, że są zgodne z Twoimi oczekiwaniami

## Przechowywanie danych {#adv-data-storage}

AppAgent przechowuje dane lokalnie w Twojej przeglądarce, korzystając z **IndexedDB**:

| Typ danych | Magazyn | Opis |
|-----------|---------|-------------|
| **Czaty** | IndexedDB | Cała historia rozmów, wiadomości i wyniki narzędzi |
| **Ustawienia** | IndexedDB | Uprawnienia narzędzi, klucze API, preferencje modeli |
| **Widżety pulpitu** | IndexedDB | Kod HTML widżetów, tytuły, rozmiary i historia rozmów |
| **Umiejętności** | IndexedDB | Definicje, treść i zasoby umiejętności |
| **Dostawcy API** | IndexedDB | Konfiguracje i punkty końcowe własnych dostawców API |
| **Stan interfejsu** | localStorage | Stan paska bocznego, bieżący widok, pozycje przewijania |

**Pobieranie danych:**

1. Przejdź do [Ustawień](app:openSettingsPageView) → Zarządzanie danymi
2. Kliknij **Eksportuj dane**
3. Zostanie pobrany plik kopii zapasowej JSON

**Usuwanie danych:**

1. Przejdź do [Ustawień](app:openSettingsPageView) → Zarządzanie danymi
2. Kliknij **Usuń wszystkie dane**
3. Potwierdź dwukrotnie, aby trwale usunąć wszystko

:::tip
**Ważne:** Dane są przechowywane lokalnie w rozszerzeniu. Wyczyszczenie danych przeglądarki, odinstalowanie rozszerzenia lub użycie innego profilu przeglądarki spowoduje, że dane będą przechowywane oddzielnie.
:::

# Informacje {#about}

**Wersja:** v__VERSION__

**Licencja:** Użytek prywatny i komercyjny. Modyfikacje na potrzeby wewnętrzne dozwolone. Dystrybucja i odsprzedaż zabronione. Wszelkie prawa zastrzeżone.

## Dziennik zmian {#changelog}

__CHANGELOG__
