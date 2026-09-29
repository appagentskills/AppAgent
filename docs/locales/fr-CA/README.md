# AppAgent

**Créez et maintenez vos applications ServiceNow avec un agent. Sous forme d'extension Chrome.**

AppAgent est votre partenaire de développement pour ServiceNow. Il crée et maintient des applications, et les teste. Il effectue les tests en remplissant des formulaires et en prenant des captures d'écran. Aucune connaissance technique requise.

Vous apportez votre propre clé d'API (BYOK), et c'est tout! Il est compatible avec OpenAI, OpenRouter, l'API Claude et même les abonnements Claude Code (contactez-nous en privé).

C'est une extension Chrome qui stocke toutes les conversations dans votre navigateur (elles ne le quittent même pas). Elle interagit uniquement avec votre instance ServiceNow et le fournisseur d'API de votre modèle.

![Exemple AppAgent](AppAgentExample.png)

Il consomme moins de jetons que Claude Code, car il s'appuie fortement sur le cache d'API, la mise en cache des outils et l'enchaînement d'outils (prêts à l'emploi).

Vous pouvez lui ajouter des compétences, il contrôle le navigateur via des onglets et dispose de boutons d'annulation mécanique pour toutes les modifications qu'il apporte à votre instance.

> **Remarque :** pour l'instant, AppAgent est destiné uniquement aux instances de développement.

## Nous contacter

Remplissez ce formulaire et nous vous recontacterons : [Formulaire de contact](https://forms.gle/wP7CZjRJDMgQnGV9A)

## Fonctionnalités

| Fonctionnalité | Rôle |
|---------|--------------|
| **Votre propre modèle** | Choisissez parmi Claude, GPT, Gemini, Grok et d'autres |
| **Connexion avec Claude** | Flux OAuth : utilisez votre abonnement Claude Code Personal ou Enterprise existant, sans clé d'API |
| **Images et PDF** | Joignez des captures d'écran, des schémas ou des documents à faire analyser par l'agent |
| **Modification de code** | Lit et modifie les scripts avec un suivi complet des versions |
| **Contrôle du navigateur** | Teste son propre travail : navigue dans les onglets, clique, remplit des formulaires, prend des captures d'écran |
| **Tableaux de bord en direct** | Crée des widgets qui récupèrent des données en temps réel depuis votre instance |
| **Compétences de l'agent** | Créez vos propres compétences pour étendre les capacités de l'agent |
| **Actions de compétence** | Les compétences peuvent afficher sur la page d'accueil des boutons en un clic qui lancent des flux de travail prédéfinis |
| **Progression en direct** | Voyez ce que fait l'agent en temps réel : des pastilles de progression dynamiques avec les états en cours/bloqué/terminé/erreur |
| **Espaces de travail** | Un espace de fichiers par conversation : clonez des dépôts GitHub, lisez, écrivez, modifiez, comparez et changez de branche. Plusieurs dépôts par conversation, avec une protection de propriété entre conversations |
| **Git et push GitHub intégrés** | L'agent peut faire un pull depuis GitHub ou un push vers GitHub, créer des branches et ouvrir des pull requests directement depuis la conversation, sans terminal ni IDE |
| **Documents intelligents** | Du Markdown persistant et versionné que l'agent peut modifier et réutiliser d'une conversation à l'autre |
| **Multi-instance** | Détecte automatiquement chaque instance ServiceNow ouverte dans votre navigateur; l'agent peut toutes les voir et agir sur elles depuis une seule conversation |
| **Sous-agents** | Délègue le travail lourd ou parallèle à des agents exécutants en arrière-plan qui rendent compte à la conversation principale |
| **25 langues** | Interface et aide en anglais et dans 24 autres langues, dont l'arabe et l'hébreu, de droite à gauche |
| **Pause et interruption** | Mettez en pause ou envoyez un nouveau message en cours de réponse : l'appel en cours est interrompu immédiatement |
| **Recherche Web** | Recherches Web gratuites, sans clé, via Google et DuckDuckGo |
| **Annulation mécanique** | Chaque modification est suivie, retour arrière en un clic |
| **Exportation XML** | Exportez toutes les modifications pour les déployer sur d'autres instances |
| **Autorisations des outils** | Sécurité intégrée : contrôlez ce que l'agent peut faire sur l'instance |
| **Standards ouverts** | Compatible avec [OpenRouter](https://openrouter.ai) et [AgentSkills.io](https://agentskills.io) |
| **Mise en cache du modèle** | Réduit le coût jusqu'à 10 fois grâce à la mise en cache des invites |
| **Contexte intelligent** | Ne charge que les parties utiles des gros fichiers. Ne surcharge pas le modèle |
| **Zéro dépendance** | Aucune bibliothèque, aucun framework, du JavaScript natif pur |

## Fonctionnement

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

AppAgent est une extension Chrome dotée d'une boucle d'agent intégrée. Vous décrivez ce que vous voulez → l'agent interroge le modèle → exécute des outils dans le navigateur → accède à ServiceNow avec les autorisations de votre utilisateur actuel. L'agent communique directement avec les fournisseurs d'API des modèles, sur site ou en ligne.

## AppAgent face aux autres outils

| | AppAgent | Claude Code | Cursor | Base44 |
|---|---|---|---|---|
| **Utilisateur cible** | Non technique | Développeurs | Développeurs | Fondateurs non techniques |
| **Conçu pour ServiceNow** | ✓ | ✗ | ✗ | ✗ |
| **Actions ServiceNow autonomes** | ✓ | ✓ | ✗ | ✗ |
| **Environnement de dev nécessaire** | ✗ | ✓ | ✓ | ✗ |
| **Crée des applications** | ✓ | ✓ | ✓ | ✓ |
| **Contrôle du navigateur pour les tests** | ✓ | ✗ | ✗ | ✗ |
| **Prend des captures d'écran** | ✓ | ✗ | ✗ | ✗ |
| **Tâches en arrière-plan** | ✓ (via les actions de compétence) | ✗ | ✓ | ✗ |
| **Agents en parallèle** | ✓ (sous-agents) | ✗ | ✓ | ✗ |
| **Annulation mécanique** | ✓ | ✗ | ✗ | ✗ |
| **Images et PDF** | ✓ | ✓ | ✓ | Limité |
| **Tableaux de bord intelligents** | ✓ | ✗ | ✗ | ✓ |
| **Compétences extensibles** | ✓ | ✓ | ✗ | ✗ |
| **Actions de compétence (boutons en un clic)** | ✓ | ✗ | ✗ | ✗ |
| **Pastilles de progression en direct** | ✓ | ✗ | ✗ | ✗ |
| **Prise en charge multi-instance** | ✓ | ✗ | ✗ | ✗ |
| **Espaces de travail par conversation** | ✓ | ✗ | ✗ | ✗ |
| **Git intégré** | ✓ | ✓ (CLI) | ✓ (IDE) | ✗ |
| **Push vers GitHub depuis la conversation** | ✓ | ✓ (CLI) | Limité | ✗ |
| **Documents intelligents** | ✓ | ✗ | ✗ | ✗ |
| **Pause / interruption en cours de réponse** | ✓ | ✓ | Limité | ✗ |
| **Recherche Web** | ✓ | ✓ | ✓ | ✗ |
| **Autorisations des outils** | ✓ | ✓ | Limité | ✗ |
| **Exportation des modifications** | ✓ XML | ✓ | ✓ | ✓ |
| **Votre propre modèle** | ✓ | ✗ | ✓ | ✗ |
| **Mise en cache des invites** | ✓ | ✓ | ✓ | ✗ |
| **Contexte intelligent** | ✓ | ✓ | ✓ | ✗ |
| **Zéro dépendance** | ✓ | ✗ | ✗ | ✓ |

*Base44 ne permet pas de créer des applications ServiceNow, mais figure ici pour les utilisateurs qui connaissent son expérience.*

## Installation

1. **Installer** — Installez l'extension AppAgent depuis le Chrome Web Store (ou chargez-la non empaquetée pour le développement)
2. **Obtenir une clé d'API** — Inscrivez-vous sur [OpenRouter](https://openrouter.ai), utilisez directement Anthropic/OpenAI, ou connectez votre abonnement Claude Code (Enterprise ou Personal)
3. **Configurer** — Ouvrez l'extension et ajoutez votre clé d'API (ou connectez-vous avec Claude) dans Paramètres → Fournisseurs d'API
4. **Commencer** — Ouvrez votre instance ServiceNow dans un onglet (elle est détectée automatiquement) et lancez la conversation

## Exemples

### « Crée-moi une application simple pour suivre les tâches de l'équipe »
AppAgent crée la table, ajoute les champs, construit la mise en page du formulaire et de la liste, et configure un module dans le navigateur d'applications. Une seule invite, une application complète.

### « Fais un audit complet de cette instance »
AppAgent recherche les failles de sécurité, les comptes admin inactifs, les enregistrements obsolètes et vérifie les bonnes pratiques de configuration, puis vous remet un rapport avec des recommandations.

### « Teste cette page et signale les problèmes que tu trouves »
AppAgent ouvre la page dans un onglet, remplit les formulaires, clique sur les boutons, prend des captures d'écran et compile un rapport de tout ce qu'il trouve.

### « Il y a un bogue dans ce formulaire, peux-tu le corriger? »
AppAgent ouvre le formulaire, inspecte les scripts associés, identifie le bogue, corrige le code et vous montre exactement ce qui a changé. Un clic suffit pour annuler si besoin.

### « Crée un widget de tableau de bord pour mes tickets ouverts »
AppAgent crée un widget en direct qui récupère des données en temps réel depuis votre instance et les affiche dans votre tableau de bord.

### « Importe ce fichier Excel dans la table des utilisateurs »
AppAgent lit le fichier, associe les colonnes aux champs et importe les données dans votre instance.

### « Vérifie l'historique de mise à niveau et corrige les problèmes de personnalisation »
AppAgent examine ce qui a changé lors de la mise à niveau, repère les personnalisations cassées et les corrige.

### « Préviens l'équipe quand un incident P1 est créé »
AppAgent crée une règle de notification qui se déclenche sur les incidents P1 et envoie une alerte à votre équipe.

---

## La vision

Aujourd'hui, Opus 4.7 est excellent, mais il faut encore le surveiller un peu.

Nous continuerons à repousser les limites de ce dont les modèles d'IA sont capables à chaque génération, et à monter dans la pile d'abstraction, jusqu'à ce que nous soyons bloqués.

GPT-4 => Complétion de code
GPT-4o => Écrit un fichier autonome
Sonnet 3.5 => Modifie un fichier dans une base de code
Opus 4.5 => Écrit une fonctionnalité complète
Opus 4.6 => Maintient une application de bout en bout
Opus 4.7 => ... (encore en test)

---

## Feuille de route

- RAG
- Spécifications et cas de test

Sans ordre particulier.

Cette version sert surtout à recueillir des retours.

Les prochaines versions ne seront peut-être pas open source, mais nous continuerons à maintenir celle-ci jusqu'à ce qu'elle soit stable.

---

## Règles de contribution

Merci de ne pas ouvrir de PR : il s'agit d'un projet commercial, et nous publions le code uniquement par souci de visibilité et de confiance.

Si vous rencontrez des bogues, vous pouvez signaler un problème sur GitHub ou nous contacter directement. Nous proposons uniquement un soutien commercial : nous corrigerons donc seulement les bogues susceptibles d'affecter d'autres utilisateurs.

---

## Licence

Usage privé et commercial. Modification interne autorisée. Distribution et revente interdites.
