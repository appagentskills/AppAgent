# Prise en main {#getting-started}

AppAgent est un agent IA pour ServiceNow qui fonctionne comme une extension Chrome. Décrivez votre besoin en langage courant : l'agent interroge les données, modifie les enregistrements, crée des applications et des widgets, teste les pages dans votre navigateur, puis vous rend compte.

:::tip
**Démarrage rapide :** configurez un modèle, ouvrez un onglet sur votre instance ServiceNow, puis saisissez une demande dans la discussion et appuyez sur <kbd>Enter</kbd>.
:::

## Configurer un modèle {#guide-setup}

1. Ouvrez les [Paramètres](app:openSettingsPageView) et accédez à **Fournisseurs d'API**
2. Ajoutez un fournisseur (Anthropic, OpenRouter ou une API personnalisée compatible OpenAI) avec votre clé API, ou activez **OAuth** sur un fournisseur Anthropic pour vous connecter avec votre compte Claude
3. Choisissez le modèle à utiliser sous **Modèle de l'agent**

Votre clé API est stockée uniquement dans votre navigateur. Les appels IA partent directement de votre navigateur vers le fournisseur.

## Connecter vos instances {#guide-instances}

AppAgent **détecte automatiquement toutes les instances ServiceNow** ouvertes dans le même profil Chrome : aucune chaîne de connexion à saisir. Connectez-vous à une instance dans un onglet normal et l'agent peut y travailler avec les rôles et les droits d'accès de votre utilisateur. Demandez *« liste les instances »* pour voir chaque instance détectée, vos rôles et l'état de la connexion.

Chaque instance a un **niveau d'autorisation**, à choisir dans le menu déroulant de l'instance :

- **Manuel** — Vous approuvez chaque opération d'écriture (création, mise à jour, suppression, remplissage de formulaires)
- **Auto** — L'agent décide seul des opérations d'écriture, sans vous demander
- **Dev** — Aucune approbation : chaque appel d'outil sur cette instance s'exécute sans demander. À utiliser uniquement sur des instances de développement

Les lectures sont toujours autorisées. Voir [Autorisations des outils](#feature-permissions) pour un contrôle plus fin.

## Démarrer une discussion {#guide-chat}

1. Cliquez sur **Nouvelle discussion** dans la barre latérale [Démarrer une nouvelle discussion →](app:startNewChat)
2. Saisissez votre demande, par exemple *« Affiche tous les incidents créés aujourd'hui »*
3. Appuyez sur <kbd>Enter</kbd> pour envoyer
4. Suivez le travail de l'agent : chaque appel d'outil apparaît dans la discussion, et des demandes d'approbation s'affichent quand une étape nécessite votre accord

Vous pouvez continuer à écrire pendant que l'agent travaille : envoyer un nouveau message interrompt l'étape en cours, et **Pause** arrête l'exécution.

## Joindre des images et des fichiers {#guide-images}

1. Cliquez sur le bouton **Joindre un fichier** dans la zone de saisie pour ajouter une image, un PDF, un CSV ou un fichier texte
2. Ou collez une image depuis le presse-papiers, ou faites-la glisser dans la discussion
3. Posez votre question sur la pièce jointe

:::tip
Joignez des captures d'écran d'erreurs, des maquettes d'interface ou des données exportées pour que l'agent voie exactement ce que vous voyez.
:::

# Fonctionnalités clés {#features}

## Discussion {#page-chat}

La vue principale de conversation. [Démarrer une nouvelle discussion →](app:startNewChat)

- **Zone des messages** — La conversation, y compris les appels d'outils et leurs résultats
- **Zone de saisie** — Écrivez vos messages, joignez des fichiers ; envoyez un message pendant que l'agent travaille pour l'interrompre
- **Pause / Continuer / Réessayer** — Arrêter l'agent, le relancer ou réessayer la dernière étape
- **Indicateur de contexte** — Montre le taux de remplissage de la conversation ; cliquez dessus pour la résumer dans une nouvelle discussion
- **Cartes de réponse** — Une carte de synthèse **En bref** et une carte **Liens** (enregistrements, PR, documents) peuvent apparaître sous une réponse
- **En-tête de la discussion** — Renommez ou épinglez la discussion, ou ouvrez AppAgent dans un onglet complet avec **Agrandir en pleine page**

## Contrôle du navigateur {#feature-browser}

L'agent peut ouvrir et piloter des onglets sur votre instance pour voir et tester les pages :

- **Naviguer, cliquer, remplir et sélectionner** — Des événements réalistes, pour que les formulaires et les champs à saisie semi-automatique réagissent comme si vous tapiez
- **Attendre** — Attendre un élément, un texte ou une URL au lieu de deviner les délais
- **Captures d'écran** — Capturer la page, un widget ou un seul élément pour des vérifications visuelles
- **Inspecter** — Lire les propriétés et les styles des éléments, les erreurs de console et les requêtes réseau
- **Emprunter une identité** — Tester en tant qu'un autre utilisateur, puis revenir à votre compte

## Modifier des enregistrements et historique des versions {#feature-history}

Chaque modification apportée par l'agent à votre instance est suivie dans la barre latérale de la discussion :

- **Annuler** — Annuler une modification précise
- **Rétablir** — Rétablir une modification annulée
- **Télécharger le XML** — Exporter toutes les modifications, par exemple pour les transférer vers une autre instance

## Sous-agents {#feature-subagents}

Pour les tâches lourdes ou parallèles, l'agent peut lancer des **sous-agents** : des exécutants en arrière-plan qui travaillent dans leur propre discussion et leur propre contexte, puis renvoient un bref résultat à la discussion principale.

- **Niveaux de modèle** — Chaque sous-agent s'exécute sur un niveau **small**, **medium** ou **large**, ou **same** pour utiliser le modèle du parent. Associez les niveaux à des modèles dans [Paramètres](app:openSettingsPageView) → **Niveaux de modèle des sous-agents**
- **Bandeau des exécutants** — Les sous-agents en cours apparaissent sous forme de pastilles dynamiques au-dessus de la zone de saisie ; ouvrez-en un pour suivre sa progression ou lire sa transcription
- **Pool** — Le nombre de sous-agents simultanés est limité ; les autres attendent dans une file

## Tableau de bord et widgets {#page-dashboard}

Un tableau de bord de widgets interactifs générés par l'agent. [Ouvrir le tableau de bord →](app:openDashboardView)

1. Cliquez sur **Ajouter un widget**
2. Décrivez ce que vous voulez, par exemple *« Un graphique des incidents ouverts par priorité »*
3. L'agent crée le widget ; demandez des modifications ou cliquez sur **Régénérer** à tout moment

Les widgets peuvent récupérer des données en direct depuis votre instance et restent donc à jour. Déplacez-les, redimensionnez-les, importez-les et exportez-les (voir [Avancé](#advanced)). Les widgets que l'agent affiche dans une discussion peuvent être enregistrés avec **Épingler au tableau de bord**.

## Documents intelligents {#page-documents}

Les **Documents intelligents** sont des documents Markdown persistants et versionnés que l'agent rédige et met à jour : plans, rapports, spécifications, conclusions. Ils s'affichent directement dans la discussion, conservent chaque version et vous pouvez les modifier vous-même. Ouvrez-les depuis **Documents** dans la barre latérale. [Ouvrir les documents →](app:openDocumentsView)

## Compétences {#page-skills}

Les compétences apportent à l'agent des connaissances et des outils supplémentaires. [Ouvrir les compétences →](app:openSkillsView)

- **Activer / Désactiver** — Activez ou désactivez les compétences ; désactivez celles dont vous n'avez pas besoin pour des réponses plus ciblées
- **Nouvelle compétence** — Rédigez votre propre compétence en Markdown, ou utilisez **Modifier avec l'agent**
- **Importer / Exporter** — Partagez des compétences sous forme de dossiers
- **Actions de compétence** — Certaines compétences ajoutent sur la page d'accueil des boutons en un clic qui lancent un workflow prédéfini

Une compétence peut fournir des **connaissances** (instructions, bonnes pratiques) et des **outils personnalisés** (fonctions JavaScript exécutées dans un bac à sable isolé).

## Espace de travail et GitHub {#feature-workspace}

Chaque discussion dispose d'un **espace de travail** : une zone de fichiers où l'agent peut lire, écrire, modifier et comparer des fichiers.

- **GitHub** — Connectez un compte GitHub dans les [Paramètres](app:openSettingsPageView) pour cloner des dépôts dans un espace de travail. L'agent peut créer des branches, pousser des commits et ouvrir des pull requests depuis la discussion
- **Pull requests** — Les PR ouvertes depuis une discussion sont listées dans la barre latérale de la discussion, avec un bouton **Fusionner**
- **Protection entre discussions** — Chaque fichier mémorise la discussion qui l'a modifié, pour que deux discussions travaillant en parallèle n'écrasent pas le travail l'une de l'autre sans prévenir
- **Synchronisation automatique** — Les espaces de travail clonés se synchronisent avec GitHub quand vous naviguez, changez de discussion ou revenez sur l'onglet

## Barre latérale de la discussion {#feature-sidebar}

La barre latérale de droite rassemble tout ce que la discussion en cours a produit :

- **Pull requests** — Titre, branche cible et bouton **Fusionner**
- **Fichiers de l'espace de travail** — Ouvrez un fichier pour l'afficher, voir ses différences ou parcourir ses versions précédentes
- **Historique des versions** — Les modifications de l'instance avec **Annuler**, **Rétablir** et **Télécharger le XML**
- **Exécutants** — Les sous-agents en cours et terminés, avec des compteurs d'appels d'outils, de fichiers modifiés et de PR ouvertes

## Actions et progression en direct {#feature-actions}

Les tâches longues affichent leur progression en direct au lieu de rester silencieuses :

- **Carte de progression** — Une carte unique avec un état en couleur (en cours, bloqué, terminé, erreur) et une liste d'étapes
- **Boutons d'action** — Des boutons en un clic qui lancent des workflows de suivi
- **Indicateur d'activité** — La liste des discussions signale celles où l'agent travaille
- **Notification « Agent terminé »** — Si vous changez d'onglet ou de fenêtre pendant une exécution, une notification de bureau vous prévient quand l'agent a fini

## Discussions actives et tâches {#feature-jobs}

La pastille des tâches dans l'en-tête ouvre une vue en direct de vos discussions et du travail en arrière-plan :

- **Discussions actives** — Les discussions en cours et celles avec des résultats non lus (affichées en **gras**), chacune avec un anneau d'utilisation du contexte
- **Sous-agents** — Listés sous leur discussion parente ; ouvrez-en un pour lire sa transcription
- **Développer** — Ouvrez la liste dans un panneau plus grand, en colonnes ou en sections

## Autorisations des outils {#feature-permissions}

En plus du niveau d'autorisation par instance (**Manuel**, **Auto**, **Dev**), chaque outil a son propre réglage dans [Paramètres](app:openSettingsPageView) → **Autorisations des outils** :

- **Autoriser** — L'outil s'exécute toujours sans demander
- **Auto** — L'outil s'exécute sans demander, sauf si l'agent signale qu'un appel nécessite votre confirmation
- **Demander** — Une demande d'approbation s'affiche avant chaque appel
- **Désactivé** — L'agent ne peut pas utiliser l'outil

Certains outils offrent des contrôles plus fins : l'API ServiceNow par méthode HTTP (GET, POST, PUT, PATCH, DELETE), le contrôle du navigateur par action (naviguer, cliquer, remplir, emprunter une identité…) et la gestion des compétences par action. Les boîtes de confirmation sont colorées selon le risque : **bleu** (routine), **orange** (prudence), **rouge** (destructif).

:::tip
Laissez DELETE et les autres opérations destructives sur **Demander**, et n'utilisez **Dev** que sur des instances de développement.
:::

## Outils de l'agent {#feature-tools}

Les principaux outils utilisés par l'agent :

| Outil | Rôle |
|------|--------------|
| **API ServiceNow** (`servicenow_api`) | Lire, créer, mettre à jour et supprimer des enregistrements |
| **Script d'arrière-plan** (`servicenow_run_script`) | Exécuter un script côté serveur sur l'instance (nécessite le rôle admin) |
| **Modifications de scripts** (`servicenow_diff_edit`) | Modifier des scripts par des remplacements ciblés (rechercher-remplacer) |
| **Contrôle du navigateur** (`iframe_tool`) | Naviguer, cliquer, remplir, inspecter et emprunter une identité dans les onglets |
| **Code navigateur** (`js_eval`) | Exécuter du JavaScript dans un bac à sable isolé qui peut appeler d'autres outils |
| **Captures d'écran** (`take_screenshot`) | Capturer la page, un widget ou un élément |
| **Widgets et cartes** (`html_widget`, `display`) | Afficher dans la discussion des widgets interactifs, des tableaux, des cartes et des chronologies |
| **Documents intelligents** (`document`) | Créer et mettre à jour des documents Markdown persistants |
| **Questions à l'utilisateur** (`prompt_user`) | Vous demander des informations via un formulaire intégré |
| **Sous-agents** (`spawn_sub_agent`) | Déléguer du travail à des exécutants en arrière-plan |
| **Espace de travail** (`workspace`) | Travailler avec des fichiers et des dépôts GitHub |
| **Récupération web** (`web_fetch`) | Lire des pages du Web public |
| **Compétences** (`get_skill`, `manage_skill`) | Lire et gérer les compétences |

Ouvrez [Paramètres](app:openSettingsPageView) → **Autorisations des outils** pour voir chaque outil, sa source et son autorisation.

## Mise en cache des contenus volumineux {#feature-caching}

Quand le résultat d'un outil est trop volumineux pour la conversation (plus de 4K jetons par défaut), AppAgent le met en cache. L'agent reçoit un plan, puis lit, recherche ou parcourt uniquement les parties dont il a besoin. Les discussions restent ainsi rapides et ciblées. Modifiez le seuil (de 1K à 100K jetons) dans [Paramètres](app:openSettingsPageView) → **Mise en cache des contenus volumineux**.

## Indicateur de contexte {#feature-saturation}

L'**indicateur de contexte**, à côté de la zone de saisie, montre le taux de remplissage de la conversation. Au-delà de 50 %, l'agent est invité à conclure et à confier le travail lourd restant à des sous-agents ; à 100 %, il s'arrête et fait son rapport. Cliquez sur l'indicateur à tout moment pour résumer la conversation dans une nouvelle discussion.

## Utilisation et limites de débit {#feature-usage}

- **Pastille d'utilisation** — L'en-tête affiche votre utilisation de l'API et les limites restantes ; cliquez dessus pour plus de détails
- **Nouvelles tentatives automatiques** — Quand le fournisseur limite le débit ou est surchargé (HTTP 429 / 529), AppAgent patiente et réessaie automatiquement, avec un compte à rebours dans la discussion
- **Crédits épuisés** — Quand une erreur 429 signifie en réalité que vos crédits sont épuisés, la discussion l'indique clairement

## Langues {#feature-languages}

L'interface est disponible en anglais et dans 24 autres langues : allemand, arabe, chinois (simplifié, traditionnel), coréen, danois, espagnol, finnois, français (France, Canada), hébreu, hongrois, italien, japonais, néerlandais, norvégien, polonais, portugais (Brésil, Portugal), russe, suédois, tchèque, thaï et turc.

Choisissez-en une dans [Paramètres](app:openSettingsPageView) → **Langue**, ou depuis le menu des réglages rapides dans l'en-tête. **Auto** suit la langue de votre navigateur et revient à l'anglais par défaut. Le changement s'applique immédiatement, sans rechargement.

- **De droite à gauche** — L'arabe et l'hébreu utilisent une mise en page de droite à gauche
- **Formats locaux** — Les dates, heures et nombres suivent votre langue
- **Réponses de l'agent** — L'agent répond dans la langue choisie, sauf si vous écrivez dans une autre. Le code et les noms de tables et de champs restent inchangés
- **Cette page d'aide** — Affichée dans votre langue ; le journal des modifications reste en anglais

# Pages et paramètres {#pages}

## Paramètres {#page-settings}

[Ouvrir les paramètres →](app:openSettingsPageView)

- **Modèle de l'agent** — Le modèle utilisé par l'agent
- **Fournisseurs d'API** — Anthropic, OpenRouter ou des fournisseurs personnalisés, avec une clé API ou OAuth
- **Points de terminaison LLM** — Des paires nommées `URL + API key` pour toute API compatible OpenAI
- **Niveaux de modèle des sous-agents** — Associez les niveaux small, medium et large à des modèles, ou à **Identique**
- **Effort de raisonnement, jetons max et budget de réflexion** — Réglez la profondeur et la longueur des réponses
- **Fenêtre de contexte** — La taille de contexte utilisée par l'indicateur de contexte
- **Affichage** — Statistiques d'API, mode compact, garder l'écran allumé
- **Langue** — La langue de l'interface, ou **Auto**
- **Hooks** — Titres de discussion automatiques, notifications « Agent terminé » et autres automatisations
- **Mise en cache des contenus volumineux** — À partir de quand les résultats volumineux sont mis en cache
- **Autorisations des outils** — Ce qui s'exécute automatiquement, demande d'abord ou est désactivé
- **GitHub** — Connectez un compte GitHub et gérez les dépôts clonés
- **Prompt système** — Personnalisez les instructions de l'agent
- **Gestion des données** — Exportez, importez ou supprimez vos données

## Historique {#page-history}

Toutes vos conversations. [Ouvrir l'historique →](app:openHistoryView)

- **Rechercher** — Trouvez des discussions par titre, contenu, outils utilisés ou widgets
- **Épingler** — Gardez les discussions importantes en haut de la liste
- **Exporter** — Téléchargez une discussion ou tout votre historique
- **Statistiques** — Nombre de discussions, de discussions épinglées et coût total

## Aide {#page-docs}

Cette page. [Ouvrir l'aide →](app:openDocsView)

- **Rechercher** — Filtrez les rubriques d'aide depuis le champ de recherche de la barre d'outils
- **Sommaire** — Accédez directement à une section depuis le plan
- **Télécharger** — Enregistrez la documentation dans un fichier Markdown

# Astuces et raccourcis clavier {#tips}

| Action | Comment |
|--------|-----|
| Envoyer un message | <kbd>Enter</kbd> |
| Nouvelle ligne | <kbd>Shift</kbd> + <kbd>Enter</kbd> |
| Rechercher dans les discussions | <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> sur Mac) |
| Fermer une boîte de dialogue ou un menu | <kbd>Esc</kbd> |
| Revenir en arrière | <kbd>Alt</kbd> + <kbd>←</kbd> |
| Joindre une image | Collez-la, ou faites-la glisser dans la discussion |
| Repartir de zéro avec un résumé | Cliquez sur l'indicateur de contexte |
| Interrompre l'agent | Envoyez un nouveau message, ou cliquez sur **Pause** |

:::tip
**Soyez précis.** Au lieu de *« corrige ça »*, dites *« corrige l'erreur de référence nulle à la ligne 42 du script include MyUtils »*. Nommez la table, l'enregistrement ou la page quand c'est possible.
:::

- **Un objectif par discussion** — Démarrez une nouvelle discussion pour une tâche sans rapport ; l'agent reste plus rapide et plus précis
- **Laissez-le tester** — Demandez à l'agent d'ouvrir la page et de vérifier sa propre modification avec une capture d'écran
- **Utilisez les compétences** — Activez une compétence adaptée à votre tâche (par exemple tests ou audit) avant de commencer

# Dépannage et FAQ {#faq}

### L'agent ne voit pas mon instance

Ouvrez l'instance dans un onglet du même profil Chrome et vérifiez que vous êtes connecté, puis demandez *« liste les instances »*. Si elle n'apparaît toujours pas, rechargez l'onglet de l'instance.

### J'obtiens une erreur d'API ou d'authentification

Vérifiez votre fournisseur dans [Paramètres](app:openSettingsPageView) → **Fournisseurs d'API** : la clé API, le point de terminaison sélectionné et le nom du modèle. Pour OAuth, reconnectez-vous à claude.ai dans le même profil Chrome.

### L'agent indique que son débit est limité

AppAgent réessaie automatiquement et affiche un compte à rebours. Si le problème persiste, consultez la pastille d'utilisation pour voir vos crédits restants, ou utilisez un niveau de modèle plus petit pour les sous-agents.

### Trop de demandes d'approbation, ou pas assez

Modifiez le niveau d'autorisation de l'instance (**Manuel**, **Auto**, **Dev**) dans le menu déroulant de l'instance, et ajustez chaque outil dans [Paramètres](app:openSettingsPageView) → **Autorisations des outils**.

### Les réponses deviennent plus lentes ou moins précises dans une longue discussion

Le contexte de la conversation se remplit. Cliquez sur l'indicateur de contexte pour continuer dans une nouvelle discussion avec un résumé.

### Comment annuler une modification ?

Ouvrez la barre latérale de la discussion et cliquez sur **Annuler** sur la modification dans l'historique des versions. **Télécharger le XML** exporte toutes les modifications.

### Où mes données sont-elles stockées ?

Localement dans votre navigateur (IndexedDB). Les discussions ne passent jamais par un serveur AppAgent : elles vont uniquement à votre fournisseur d'IA et à votre instance ServiceNow. Voir [Stockage des données](#adv-data-storage).

### L'interface ou cette page n'est pas dans la bonne langue

Choisissez la langue dans [Paramètres](app:openSettingsPageView) → **Langue**. **Auto** suit la langue de votre navigateur.

# Avancé {#advanced}

Cette section décrit les fonctionnalités avancées, les boutons des en-têtes, les formats d'import/export et des détails techniques sur le fonctionnement d'AppAgent.

## Boutons de l'en-tête du tableau de bord {#adv-dashboard-header}

L'en-tête du tableau de bord contient plusieurs boutons d'action :

| Bouton | Description |
|--------|-------------|
| **Afficher/masquer la barre latérale** | Afficher ou masquer la barre de navigation de gauche |
| **Ouvrir en mode autonome** | Ouvrir le tableau de bord dans un nouvel onglet pour un affichage autonome |
| **En-têtes** | Afficher ou masquer les en-têtes des widgets du tableau de bord. Une fois masqués, les widgets s'affichent de façon plus épurée |
| **Tout régénérer** | Régénérer tous les widgets du tableau de bord avec l'agent. Pratique pour actualiser les données |
| **Importer** | Importer un tableau de bord ou un widget depuis un fichier JSON |
| **Exporter** | Exporter tout le tableau de bord dans un fichier JSON pour le sauvegarder ou le partager |
| **Ajouter un widget** | Ouvre l'éditeur de widget pour créer un nouveau widget avec l'aide de l'agent |

## Boutons de l'en-tête des widgets {#adv-widget-headers}

**En-têtes des widgets du tableau de bord** (visibles quand l'option En-têtes est activée) :

| Bouton | Description |
|--------|-------------|
| **Poignée de déplacement** | L'icône du widget sert de poignée pour réordonner les widgets |
| **Régénérer** | Demander à l'agent de régénérer le contenu de ce widget |
| **Historique** | Voir les versions précédentes de ce widget (si disponibles) |
| **Plein écran** | Afficher le widget en plein écran |
| **Modifier** | Ouvrir l'éditeur de widget pour le modifier en discutant avec l'agent |
| **Supprimer** | Retirer le widget du tableau de bord (avec confirmation) |

**En-têtes des widgets de discussion** (widgets affichés dans la discussion) :

| Bouton | Description |
|--------|-------------|
| **Épingler au tableau de bord** | Enregistrer ce widget dans votre tableau de bord |
| **Modifier le code** | Afficher et modifier directement le code HTML/CSS/JS du widget |
| **Développer/Réduire** | Afficher ou masquer le contenu du widget |

## Redimensionner et déplacer les widgets {#adv-resize-move}

**Redimensionner les widgets :**

- Chaque widget a une **poignée de redimensionnement** dans le coin inférieur droit
- Cliquez sur la poignée et faites-la glisser pour redimensionner le widget
- La largeur s'aligne sur une grille de 12 colonnes (3 colonnes minimum)
- La hauteur se mesure en unités de 50px (2 unités minimum = 100px)

**Déplacer les widgets :**

- Activez l'option **En-têtes** pour afficher les en-têtes des widgets
- Cliquez sur l'**icône du widget** (poignée de déplacement) et faites-la glisser pour réordonner
- Déposez le widget sur un autre widget pour échanger leurs positions
- L'ordre des widgets est enregistré automatiquement

## Formats d'import/export {#adv-import-export}

**Export du tableau de bord** (`dashboard-YYYY-MM-DD.json`) :

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

**Export d'un seul widget :**

```
{
  "type": "appagent-dashboard-widget",
  "version": 1,
  "widget": { ... }
}
```

**Export d'une seule discussion** (`chat-title-YYYY-MM-DD.json`) :

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

Les exports de discussion conservent tout l'historique de la conversation, y compris tous les messages de l'utilisateur et toutes les réponses de l'agent. Utilisez le menu déroulant de la discussion (···) et sélectionnez **Télécharger** pour exporter une discussion.

**Export des compétences** (structure de dossiers) :

```
skill-name/
├── SKILL.md      # Main skill definition
├── sample.xml    # Optional XML assets
├── helper.js     # Optional JS assets
└── notes.md      # Optional MD assets
```

:::tip
**Remarque :** l'import/export des compétences utilise l'API File System Access et **fonctionne uniquement dans Chrome ou Edge**.
:::

**Export de toutes les données** (`appagent-backup-YYYY-MM-DD.json`) :

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

La sauvegarde complète inclut tout l'historique des discussions, les paramètres, les autorisations des outils, les widgets du tableau de bord et la configuration des fournisseurs d'API.

## Statistiques d'API {#adv-api-stats}

Une fois activées dans les paramètres, les statistiques d'API s'affichent après chaque réponse de l'agent :

| Mesure | Description |
|--------|-------------|
| **Entrée** | Jetons d'entrée : la taille du prompt envoyé à l'agent |
| **Sortie** | Jetons de sortie : la taille de la réponse de l'agent |
| **Total** | Somme des jetons d'entrée et de sortie |
| **Lecture/écriture du cache** | Jetons lus depuis le cache de prompt ou écrits dans celui-ci (réduit le coût) |
| **Raisonnement** | Jetons utilisés pour le raisonnement interne (certains modèles) |
| **Coût** | Coût estimé de l'appel d'API en USD |
| **Durée** | Temps pris par l'appel d'API |

Pour les conversations en plusieurs tours, des statistiques cumulées affichent le total de tous les appels.

:::tip
Activez ou désactivez l'affichage des statistiques dans [Paramètres](app:openSettingsPageView) → Affichage → Afficher les statistiques d'API.
:::

## Modifier les compétences manuellement {#adv-skills-manual}

Les compétences peuvent être créées et modifiées manuellement ou avec l'aide de l'agent :

**Créer une compétence manuellement :**

1. Ouvrez [Compétences](app:openSkillsView) et cliquez sur **Nouvelle compétence**
2. Saisissez un nom et une description
3. Rédigez le contenu de la compétence au format Markdown
4. Cliquez sur **Enregistrer** pour créer la compétence

**Format de SKILL.md :**

```
# Skill Name

Description of what this skill does.

## Instructions

Detailed instructions for the Agent...

## Examples

- Example usage 1
- Example usage 2
```

**Modifier avec l'agent :**

1. Cliquez sur **Modifier avec l'agent** sur une compétence
2. Décrivez les modifications souhaitées
3. L'agent modifie le contenu de la compétence
4. Vérifiez puis enregistrez les modifications

**Ressources des compétences :** les compétences peuvent inclure des fichiers supplémentaires (XML, JS, MD) qui apportent du contexte ou du code à l'agent.

## Prompt système {#adv-system-prompt}

Le prompt système définit le comportement et les capacités de l'agent. Vous pouvez le personnaliser dans les [Paramètres](app:openSettingsPageView).

**Modifier le prompt système :**

1. Ouvrez Paramètres → section Prompt système
2. Cliquez sur **Modifier** pour passer en mode édition
3. Adaptez le modèle selon vos besoins
4. Cliquez sur **Enregistrer** pour appliquer les modifications

**Espaces réservés disponibles :**

| Variable | Description |
|-------------|-------------|
| `{{CURRENT_DATE}}` | La date du jour (jour de la semaine, mois, jour, année) |
| `{{ORCHESTRATOR_POLICY}}` | La politique de délégation aux sous-agents : incluse dans les discussions principales, laissée vide dans celles des sous-agents |
| `{{DISABLED_TOOLS}}` | La liste des outils désactivés |
| `{{TOOL_CATALOG}}` | Le catalogue des outils différés (vide quand le chargement différé des outils est désactivé) |
| `{{SKILLS_SUMMARY}}` | Le contenu des compétences actives |

Les variables sont automatiquement remplacées par leurs valeurs réelles lors de l'envoi à l'IA. Le compteur de jetons affiche à la fois la taille du modèle et la taille après remplacement.

:::tip
Cliquez sur **Rétablir la valeur par défaut** pour restaurer le prompt système d'origine si besoin.
:::

## Appels d'API de l'agent {#adv-agent-api}

AppAgent fonctionne comme une **extension Chrome** :

- Les appels d'API IA partent **directement de votre navigateur vers le fournisseur d'IA** (par ex. Anthropic, OpenRouter)
- Ils ne passent **ni** par votre instance **ni** par un serveur AppAgent
- Votre clé API (ou jeton OAuth) est stockée localement dans votre navigateur
- Les données de conversation sont envoyées au fournisseur d'IA pour être traitées

**Fonctionnement :**

1. Vous saisissez un message dans la discussion
2. AppAgent construit un prompt avec les instructions système, les outils et l'historique de la conversation
3. Le prompt est envoyé à l'API du fournisseur d'IA
4. La réponse de l'agent est renvoyée en flux vers votre navigateur
5. Les appels d'outils s'exécutent dans votre navigateur, en utilisant votre session sur l'instance pour les appels d'API

:::tip
**Confidentialité :** votre clé API et vos données de conversation sont traitées côté client. Les appels d'outils qui interagissent avec votre instance utilisent les identifiants de votre session existante.
:::

## Points de terminaison LLM {#adv-endpoints}

Les modèles se connectent via des **points de terminaison LLM nommés** : des paires `URL + API key` réutilisables. Vous pouvez ainsi connecter AppAgent à **n'importe quelle API de chat completions compatible OpenAI** : OpenRouter, une passerelle locale, un proxy ou votre propre modèle hébergé.

1. Dans [Paramètres → Points de terminaison LLM](app:openSettingsPageView), cliquez sur **Ajouter un point de terminaison**
2. Indiquez un nom, l'URL de l'API et une clé API
3. Chaque modèle (fournisseur d'API) choisit un point de terminaison : mettez à jour une clé une seule fois et tous les modèles qui l'utilisent sont mis à jour

:::tip
Les fournisseurs Claude en **OAuth** n'utilisent pas de point de terminaison : ils communiquent directement avec `api.anthropic.com`.
:::

## Se connecter avec Claude (OAuth) {#adv-oauth}

Au lieu de coller une clé API, vous pouvez vous connecter aux fournisseurs Anthropic avec votre session claude.ai existante :

1. Dans [Paramètres → Fournisseurs d'API](app:openSettingsPageView), ajoutez ou modifiez un fournisseur Anthropic et activez **OAuth**
2. L'extension utilise votre connexion claude.ai du même profil Chrome pour se connecter directement à Anthropic
3. Aucune fenêtre de connexion supplémentaire, et aucun serveur AppAgent entre les deux

**Prérequis :**

- Vous devez être connecté à `claude.ai` dans le même profil Chrome
- Fonctionne avec les comptes en authentification unique (SSO)

:::tip
Les jetons OAuth sont actualisés automatiquement. Si la connexion échoue, ouvrez `claude.ai` dans le même profil et reconnectez-vous.
:::

## Considérations de sécurité {#adv-security}

**Stockage de la clé API :**

- Votre **clé API est stockée localement** dans l'IndexedDB de votre navigateur
- La clé n'est jamais envoyée à votre instance ni à aucun autre serveur que celui du fournisseur d'IA
- Effacer les données du navigateur supprime la clé API enregistrée

**Session et autorisations :**

- L'agent fonctionne avec votre **session utilisateur actuelle** et hérite de vos droits d'accès et de vos rôles
- Tous les appels d'API vers votre instance utilisent les identifiants de votre session
- L'agent ne peut accéder qu'à ce que votre compte utilisateur peut consulter

**Environnement d'exécution des outils :**

- **Code navigateur (js_eval)** exécute du JavaScript dans un **bac à sable isolé** avec un accès limité à `executeTool()`
- **Les scripts des widgets** s'exécutent dans des **iframes isolées** avec un accès limité à `executeTool()` pour les appels d'API
- **Les outils des compétences** s'exécutent dans des **bacs à sable isolés** avec un accès limité à `executeTool()`
- Tout accès à l'API passe par le **système d'autorisations** via `executeTool("servicenow_api", {...})`
- L'agent interagit avec les pages dans des **onglets du navigateur** sur votre instance ServiceNow

**Capacités de modification des enregistrements :**

- L'outil **API ServiceNow** prend en charge les méthodes POST, PATCH, PUT et DELETE, qui peuvent modifier des enregistrements
- L'agent peut créer et modifier des enregistrements via le **navigateur intégré** s'il dispose des autorisations pour les outils de remplissage et de clic
- Configurez les [Autorisations des outils](app:openSettingsPageView) pour choisir les opérations qui nécessitent une approbation

**Auto-amélioration :**

- L'agent peut **gérer ses propres compétences** : les créer, les modifier et les activer
- Il peut ainsi apprendre et s'améliorer au fil du temps
- Vérifiez régulièrement les modifications des compétences pour vous assurer qu'elles correspondent à vos attentes

## Stockage des données {#adv-data-storage}

AppAgent stocke les données localement dans votre navigateur avec **IndexedDB** :

| Type de données | Stockage | Description |
|-----------|---------|-------------|
| **Discussions** | IndexedDB | Tout l'historique des conversations, les messages et les résultats des outils |
| **Paramètres** | IndexedDB | Autorisations des outils, clés API, préférences de modèle |
| **Widgets du tableau de bord** | IndexedDB | HTML, titres, tailles et historique de conversation des widgets |
| **Compétences** | IndexedDB | Définitions, contenu et ressources des compétences |
| **Fournisseurs d'API** | IndexedDB | Configurations et points de terminaison des fournisseurs d'API personnalisés |
| **État de l'interface** | localStorage | État de la barre latérale, vue actuelle, positions de défilement |

**Télécharger vos données :**

1. Ouvrez [Paramètres](app:openSettingsPageView) → Gestion des données
2. Cliquez sur **Exporter des données**
3. Un fichier de sauvegarde JSON est téléchargé

**Supprimer vos données :**

1. Ouvrez [Paramètres](app:openSettingsPageView) → Gestion des données
2. Cliquez sur **Supprimer toutes les données**
3. Confirmez deux fois pour tout supprimer définitivement

:::tip
**Important :** les données sont stockées localement dans l'extension. Effacer les données du navigateur, désinstaller l'extension ou utiliser un autre profil de navigateur entraîne des espaces de stockage distincts.
:::

# À propos {#about}

**Version :** v__VERSION__

**Licence :** usage privé et commercial. Modification interne autorisée. Distribution et revente interdites. Tous droits réservés.

## Journal des modifications {#changelog}

__CHANGELOG__
