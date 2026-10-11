# NeoGuard

NeoGuard est une application web mobile, locale et hors ligne, conçue comme une **aide à la surveillance** : son interface présente des mesures simulées, des tendances et des alertes illustratives. Elle ne remplace ni la vigilance des parents, ni le suivi médical.

> **Avertissement important :** ce dépôt est un prototype pédagogique. Les capteurs sont simulés, les seuils sont provisoires et aucune alerte ne peut garantir la sécurité d'un enfant. En cas d'inquiétude, contactez un professionnel de santé ou les services d'urgence locaux. Ne retardez jamais une intervention en vous fiant à l'application.

L'application n'envoie pas les données du profil ou de surveillance à un serveur. Le stockage est local au navigateur (IndexedDB, avec repli mémoire si indisponible). Le mode test est isolé et ses données sont destinées à disparaître lorsque l'on quitte ce mode.

## Contenu du dépôt

```text
.
├── index.html             Structure des écrans et identifiants communs
├── style.css              Styles mobiles, thèmes et états visuels
├── main.js                Démarrage, navigation et orchestration des modules
├── state.js               État de l'application et séparation live/test
├── sensors.js             Interface capteur et source simulée
├── ai.js                  Règles d'évaluation et baseline indicative
├── alerts.js              Alertes, sons, notifications et rappels
├── charts.js              Graphiques canvas et vues d'historique
├── demo.js                Tableau de test et scénarios
├── db.js                  IndexedDB locale et repli en mémoire
├── manifest.json          Métadonnées de la PWA
├── sw.js                  Cache hors ligne et notifications locales
├── assets/icons/
│   ├── logo-icon-192.png  Icône de l'application (192 × 192)
│   ├── logo-neoguard-512.png  Icône de l'application (512 × 512)
│   └── logo-neoguard.svg  Icône vectorielle source
└── README.md              Ce guide
```

Le manifeste PWA utilise les icônes PNG `assets/icons/logo-icon-192.png` et `assets/icons/logo-neoguard-512.png`, ainsi que la source SVG `assets/icons/logo-neoguard.svg`. La balise `apple-touch-icon` utilise également l'icône PNG de 192 × 192 pixels. Ces chemins correspondent aux fichiers présents dans le dépôt.

## Lancer en local

### Avec Live Server dans VS Code

1. Ouvrez le dossier du projet dans VS Code.
2. Installez l'extension **Live Server** si nécessaire.
3. Ouvrez `index.html`, puis choisissez **Open with Live Server**.
4. Le navigateur s'ouvre sur une adresse locale, typiquement `http://127.0.0.1:5500`.

Ne lancez pas la page en ouvrant directement le fichier `index.html` avec `file://` : les modules ES, le service worker et le stockage ne fonctionneront pas tous comme sur un serveur web.

### Essai sur un téléphone du même réseau

1. Connectez l'ordinateur et le téléphone au même Wi-Fi.
2. Dans VS Code, configurez Live Server pour écouter sur toutes les interfaces réseau (`useLocalIp`/`0.0.0.0` selon la version), puis autorisez son port dans le pare-feu si nécessaire.
3. Repérez l'adresse IP locale de l'ordinateur (par exemple `192.168.1.20`) et ouvrez `http://192.168.1.20:5500` sur le téléphone.

Cet accès HTTP sert à vérifier l'affichage et les interactions. Sur un téléphone, cette adresse IP n'est généralement **pas** considérée comme un contexte sécurisé : service worker, installation PWA et notifications peuvent être refusés. `localhost` bénéficie d'une exception de sécurité sur l'appareil lui-même, pas sur l'autre appareil qui visite l'adresse LAN.

### HTTPS et notifications

Les notifications web et les service workers exigent un contexte sécurisé : HTTPS est nécessaire hors `localhost`. Pour les tester sur téléphone, publiez une branche de test sur GitHub Pages, Netlify ou Cloudflare Pages (voir ci-dessous), ou configurez un certificat HTTPS de développement que le téléphone accepte et auquel il fait confiance. Un certificat auto-signé non approuvé ne suffit pas. Les notifications doivent aussi être autorisées dans le navigateur et activées dans **Réglages** de NeoGuard.

## Utilisation

### Créer le profil

Au premier lancement, remplissez le prénom, la date de naissance et le sexe, puis cochez le consentement. La date doit être valide, ne pas être dans le futur et correspondre à un âge de 24 mois ou moins. Le champ des antécédents est facultatif ; les pastilles ajoutent des exemples. Le bouton d'audio permet de déverrouiller le son après une action explicite.

### Tableau de bord

Le tableau de bord présente la FC, la respiration, l'orientation, le sommeil, l'âge du patch, les courbes et le niveau évalué par les règles locales. Dans cette version, les valeurs proviennent du simulateur logiciel ; aucun patch physique n'est connecté.

### Mode test sans enregistrement

Touchez **Test** dans la navigation. Le bandeau **MODE TEST — rien n'est enregistré** indique le mode isolé. Les variations de test ne sont pas destinées à l'historique médical. Utilisez **Réinitialiser le test** pour revenir à l'état normal, puis **Quitter le mode test** pour revenir au suivi. Les données de test sont volatiles et ne doivent pas être exportées.

### Alertes et notifications

Les alertes visuelles s'affichent selon le résultat des règles. Une notification système ne s'affiche que si le navigateur la prend en charge, si sa permission est accordée et si le réglage correspondant est activé. Les notifications de la démo doivent être identifiées comme tests. Le son et la vibration dépendent des réglages, du navigateur et de l'état de l'appareil ; ils ne constituent pas une alarme garantie.

### Appel du SAMU

Le bouton d'urgence ouvre le composeur téléphonique via un lien `tel:` ; il ne déclenche pas l'appel automatiquement. Vérifiez et adaptez le numéro d'urgence dans les réglages au pays où vous vous trouvez. En mode test, l'action d'appel est simulée et ne doit pas lancer un appel réel.

### Rappel des 24 heures

Le rappel de remplacement de la partie collante est prévu après 24 h, puis périodiquement tant que la date n'est pas actualisée. Le bouton **J'ai changé la partie collante** réinitialise son horodatage. Les rappels restent dépendants de l'exécution de l'application et des capacités du navigateur.

## Que se passe-t-il si je change X ?

Ces contrôles se trouvent dans l'écran **Test**. Les effets décrits sont des résultats attendus du modèle de démonstration, pas une prédiction médicale. Les graphes et indicateurs peuvent évoluer avec les entrées ; une notification ou un son n'est pas garanti à chaque déplacement de curseur : ils dépendent du niveau effectivement calculé, de l'anti-répétition, des permissions et des réglages.

| Contrôle | Effet attendu sur les graphes et l'état | Notification et son |
|---|---|---|
| **FC** (`demo-hr`) | Le rythme ECG simulé change : les pics sont plus rapprochés quand la FC monte. Une valeur hors de la plage indicative par âge peut faire passer le badge à vigilance ; les scénarios dédiés illustrent des valeurs extrêmes. | Seulement si l'évaluation déclenche une alerte et que la permission/réglage le permet. Vigilance : signal doux ; urgence : overlay et son en boucle tant que l'app est ouverte et le son déverrouillé. |
| **RR** (`demo-rr`) | La fréquence de l'onde respiratoire suit la valeur ; une valeur nulle représente une pause simulée et aplatit l'onde. Une pause prolongée peut être classée comme urgence par les règles. | Même condition : selon niveau, permissions, réglage et anti-répétition. La notification n'est pas une alarme de secours. |
| **Mouvement** (`demo-motion`) | Le mouvement influe sur l'amplitude respiratoire et l'indication calme/agité ; il peut modifier l'interprétation de la FC/RR. | Le mouvement seul ne garantit pas une notification. Son et notification suivent le niveau évalué, s'ils sont activés. |
| **Orientation** (`demo-orientation`) | L'orientation et son libellé/icône changent. Le scénario « sur le ventre » illustre la vigilance ou l'urgence selon la durée simulée. | Alerte seulement si le moteur classe effectivement la situation et que le système peut la présenter. |
| **Patch connecté** (`demo-patch-connected`) | Déconnecté, le suivi des mesures est interrompu ou signalé comme indisponible ; le tableau ne doit pas être interprété comme ayant des mesures récentes. | Une vigilance de déconnexion peut apparaître après le délai de règle. Aucune notification immédiate n'est garantie. |
| **Âge du patch** (`demo-patch-hours`) | Le compteur d'heures affiché change ; une pose simulée au-delà de 24 h sert à illustrer le rappel. | Rappel doux attendu lorsqu'il est effectivement évalué, si notifications/son sont activés. Le scénario **Rappel des 24 h** est le raccourci prévu pour l'essai. |

**Important pour ce prototype :** certains seuils comportent une durée de persistance et la démo n'est pas un banc de validation médicale. Vérifiez le comportement à l'aide du journal de test et de `selfTest()` dans la console du navigateur ; ne concluez pas à la présence ou à l'absence d'un problème de santé à partir de ces scénarios.

## Déploiement gratuit

Publiez uniquement le contenu statique du projet. Les plateformes ci-dessous fournissent automatiquement une adresse HTTPS. Aucune commande de build n'est nécessaire.

### GitHub Pages

1. Créez un dépôt GitHub et ajoutez les fichiers du projet, en incluant les PNG d'icônes générés.
2. Dans le dépôt, ouvrez **Settings → Pages**.
3. Dans **Build and deployment**, sélectionnez **Deploy from a branch**, puis la branche (par exemple `main`) et le dossier `/ (root)`.
4. Enregistrez. Attendez le déploiement et ouvrez l'URL affichée par GitHub Pages.
5. Dans **Settings → Pages**, activez **Enforce HTTPS** si cette option est proposée. Le site est alors servi sous HTTPS.

Le service worker utilise des chemins relatifs, adaptés à un site GitHub Pages publié sous un chemin de dépôt. Après chaque mise à jour, rechargez la page ; si nécessaire, fermez puis rouvrez l'application pour remplacer l'ancien cache.

### Netlify

1. Connectez votre compte Netlify à GitHub et choisissez **Add new site → Import an existing project**, ou déposez le dossier de site sur Netlify Drop.
2. Pour ce projet statique, laissez la commande de build vide et choisissez le dossier publié correspondant à la racine du dépôt.
3. Déployez, puis ouvrez le domaine `*.netlify.app` attribué.
4. Dans les réglages du domaine, associez éventuellement un domaine personnel. Netlify provisionne automatiquement HTTPS ; attendez que le certificat soit actif avant de tester.

### Cloudflare Pages

1. Dans le tableau de bord Cloudflare, ouvrez **Workers & Pages → Create application → Pages**.
2. Connectez le dépôt Git ou téléversez les fichiers statiques.
3. Choisissez le dossier racine comme répertoire de sortie ; aucune commande de build n'est requise.
4. Déployez, puis testez l'URL `*.pages.dev`. HTTPS est fourni automatiquement.

### Checklist avant publication

- [ ] Le manifeste est valide, servi avec le bon type MIME et `start_url`/`scope` fonctionnent à l'URL réelle.
- [ ] Les fichiers `assets/icons/logo-icon-192.png` et `logo-neoguard-512.png` sont présents et référencés dans le manifeste.
- [ ] Le chemin de l'icône `apple-touch-icon` dans `index.html` pointe vers `assets/icons/logo-icon-192.png`.
- [ ] Le site est servi en HTTPS ; service worker activé et cache vérifié après un rechargement.
- [ ] Le parcours d'installation, l'ouverture hors ligne et la mise à jour du cache ont été testés sur ordinateur et téléphone.
- [ ] Les permissions de notification sont demandées après une action de l'utilisateur et peuvent être refusées sans bloquer le reste.
- [ ] Le mode test ne laisse aucune donnée de démonstration dans la base, l'historique ou l'export.
- [ ] Les textes médicaux, le numéro d'urgence local, la politique de confidentialité et les coordonnées de contact ont été revus.
- [ ] Aucune clé, donnée personnelle réelle, capture contenant des données privées ou secret n'est publié dans Git.
- [ ] Des essais d'accessibilité, de navigation clavier, de contraste et de réduction des animations ont été effectués.

## Feuille de route

1. Connexion à un capteur réel : prototype Web Bluetooth lorsque les plateformes le permettent, ou application native Android/iOS pour l'accès matériel et les alertes fiables.
2. Web Push avec un serveur HTTPS, abonnements chiffrés et clés VAPID, après étude de sécurité et de confidentialité.
3. Modèle d'apprentissage validé remplaçant éventuellement les règles (par exemple TensorFlow.js), avec données représentatives, audit et supervision clinique ; un modèle ne devient pas médicalement fiable par sa seule implémentation.
4. Synchronisation cloud chiffrée, consentement clair, gestion des clés, suppression et politique de conservation.
5. Validation clinique, étude de risques, conformité réglementaire et marquage CE si le produit est destiné à être mis sur le marché comme dispositif médical. Ces étapes nécessitent des spécialistes et une évaluation formelle ; elles ne sont pas couvertes par ce prototype.

## Limites connues

- Les capteurs, les valeurs et les événements sont **simulés** : il n'y a pas de mesure physiologique réelle ni de connexion Bluetooth à un patch.
- Les règles et seuils sont des valeurs de démonstration à faire valider par un pédiatre et des spécialistes avant tout usage clinique. Le résultat peut être erroné, tardif ou absent.
- Une page web ne peut pas garantir le fonctionnement d'une alerte lorsque l'appareil est verrouillé, que l'application est suspendue, que le navigateur est fermé ou que le système économise la batterie. Le Web ne peut pas forcer un son fort. Une application native ou une architecture Web Push adaptée serait nécessaire pour un produit de production, sans garantir à elle seule la sécurité.
- Les notifications exigent un navigateur compatible, une permission accordée et généralement HTTPS. Sur iOS/iPadOS, les notifications web nécessitent l'ajout à l'écran d'accueil et une version compatible du système. La vibration n'est pas disponible dans iOS Safari.
- Le son fort de l'overlay nécessite l'application ouverte et un geste utilisateur préalable pour déverrouiller l'audio. Les réglages du système et du navigateur peuvent réduire ou supprimer son, vibration et notifications.
- En cas d'indisponibilité d'IndexedDB, le repli mémoire perd les données à la fermeture/rechargement. Les données stockées par le navigateur peuvent également être supprimées par l'utilisateur ou le système.
- Cette application n'est pas un service d'urgence. Le lien téléphonique ouvre un composeur ; l'utilisateur doit vérifier le numéro et confirmer l'appel.

## `.gitignore`

Le fichier [.gitignore](.gitignore) exclut les fichiers temporaires du système et de l'éditeur, les journaux, dépendances et sorties de build, ainsi que les fichiers locaux contenant des secrets. Les fichiers PNG d'icônes sont versionnés : ils sont nécessaires au manifeste.

## Licence suggérée

Pour un prototype de code sans dépendances, la licence **MIT** est une option permissive simple. Avant de l'ajouter, vérifiez que vous détenez les droits sur tout le code, les textes, les polices, les illustrations et autres ressources. Les fichiers de polices Google Fonts sont chargés depuis Google Fonts par la page et ne sont pas embarqués dans ce dépôt. N'ajoutez une licence que si vous souhaitez réellement autoriser les usages qu'elle décrit. Pour un produit médical, faites vérifier les conséquences juridiques et réglementaires avant toute diffusion.
