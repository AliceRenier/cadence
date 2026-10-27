# Cadence

Planifie tes posts dans un calendrier. Un robot GitHub les publie à l'heure prévue, sans serveur et sans abonnement.

| Réseau | Publié par | Coût |
|---|---|---|
| Instagram | API officielle de Meta, en direct | gratuit |
| Facebook (Page) | API officielle de Meta, en direct | gratuit |
| LinkedIn | API officielle de LinkedIn, en direct | gratuit |
| TikTok | Zernio, offre gratuite | gratuit (2 comptes) |
| YouTube | Zernio, offre gratuite | gratuit (2 comptes) |
| X | toi, à la main : Cadence copie le texte en un clic | gratuit |

## Comment ça marche

1. Tu écris tes posts dans Cadence, ton site GitHub Pages. Chaque post devient un fichier `posts/<id>.json` dans ce dépôt, et son visuel va dans `media/<id>/`.
2. Toutes les heures, la tâche **Publier les posts** lance `robot/publish.mjs`. Le robot publie ce qui est dû, puis note le résultat dans le fichier du post.
3. Si une publication échoue, GitHub t'envoie un e-mail. Le post passe en « Échec » dans Cadence, avec la raison. Corrige le problème et repasse le post en « Programmé » : seuls les réseaux en échec repartent.
4. Chaque matin, **Vérifier les accès** contrôle que tes accès Meta et LinkedIn marchent encore.

---

## Mise en route (une seule fois)

Compte environ une heure. La création des apps Meta et LinkedIn prend le plus de temps.

### 1. Le dépôt et le site

1. Crée un dépôt **public** nommé `cadence` sur GitHub, puis pousse-y ce dossier.
2. **Settings → Pages** : *Deploy from a branch*, branche `main`, dossier `/ (root)`.
   Cadence sera en ligne à l'adresse `https://<ton-compte>.github.io/cadence/`.
3. Crée le jeton qui sert à te connecter à Cadence : [Jetons à grain fin](https://github.com/settings/personal-access-tokens/new).
   - *Repository access* : **Only select repositories** → `cadence`
   - *Permissions* : **Contents → Read and write**
   - Colle-le dans l'écran de connexion de Cadence. Il reste dans ton navigateur, sur cet appareil.

### 2. Meta : Instagram et Facebook

Il te faut un compte Instagram **professionnel** (Business ou Créateur) relié à ta **Page Facebook**.

1. Sur [developers.facebook.com](https://developers.facebook.com/apps), crée une app de type **Business**.
   Laisse-la en mode développement : tant que tu n'y connectes que tes propres comptes, Meta n'a rien à valider.
2. Ouvre l'[explorateur de l'API Graph](https://developers.facebook.com/tools/explorer), choisis ton app, puis génère un **jeton utilisateur** avec ces permissions :
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `publish_video`, `instagram_basic`, `instagram_content_publish`, `business_management`.
3. Colle ce jeton dans le [débogueur de jetons](https://developers.facebook.com/tools/debug/accesstoken), puis clique sur **Extend Access Token** : tu obtiens un jeton longue durée.
4. De retour dans l'explorateur, avec ce jeton longue durée, appelle `me/accounts`. Pour ta Page, note :
   - `access_token` → secret **`META_PAGE_TOKEN`**. Ce jeton de Page n'expire pas.
   - `id` → secret **`META_PAGE_ID`**
5. Appelle `<META_PAGE_ID>?fields=instagram_business_account` → l'`id` obtenu va dans le secret **`META_IG_USER_ID`**.

### 3. LinkedIn

1. Sur [linkedin.com/developers](https://www.linkedin.com/developers/apps), crée une app. LinkedIn demande de l'associer à une Page LinkedIn.
2. Onglet **Products** : ajoute **Share on LinkedIn** et **Sign In with LinkedIn using OpenID Connect**.
3. Avec le [générateur de jetons](https://www.linkedin.com/developers/tools/oauth/token-generator), crée un jeton avec les scopes `openid`, `profile` et `w_member_social`.
   - Le jeton → secret **`LINKEDIN_TOKEN`**
   - Sa date d'expiration, 60 jours plus tard, au format `AAAA-MM-JJ` → secret **`LINKEDIN_TOKEN_EXPIRES`**
4. Lance la tâche **Aide — trouver mes identifiants** → *Mon identifiant LinkedIn*. Copie le `urn:li:person:…` obtenu dans le secret **`LINKEDIN_AUTHOR`**.

> LinkedIn ne renouvelle pas cet accès tout seul. Tous les 60 jours, refais l'étape 3 et mets à jour les deux secrets. La vérification du matin te prévient 7 jours avant l'expiration.

### 4. Zernio : TikTok et YouTube

1. Crée un compte sur [zernio.com](https://zernio.com), sans carte bancaire, puis connecte TikTok et YouTube.
2. Crée une clé API → secret **`ZERNIO_API_KEY`**.
3. Lance la tâche **Aide — trouver mes identifiants** → *Mes comptes Zernio*. Copie l'identifiant TikTok dans **`ZERNIO_TIKTOK_ID`** et celui de YouTube dans **`ZERNIO_YOUTUBE_ID`**.
   Si la tâche n'y arrive pas, ces identifiants sont aussi visibles dans le tableau de bord Zernio.

### 5. Les secrets

Ajoute-les dans **Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Sert à |
|---|---|
| `META_PAGE_TOKEN` | publier sur Instagram et Facebook |
| `META_PAGE_ID` | ta Page Facebook |
| `META_IG_USER_ID` | ton compte Instagram pro |
| `LINKEDIN_TOKEN` | publier sur LinkedIn (60 jours) |
| `LINKEDIN_TOKEN_EXPIRES` | date d'expiration, pour être prévenu |
| `LINKEDIN_AUTHOR` | ton identifiant LinkedIn |
| `ZERNIO_API_KEY` | publier sur TikTok et YouTube |
| `ZERNIO_TIKTOK_ID` | ton compte TikTok chez Zernio |
| `ZERNIO_YOUTUBE_ID` | ta chaîne YouTube chez Zernio |

Les secrets ne s'affichent jamais, même dans un dépôt public.

### 6. Premier essai

Programme un post de test dans Cadence pour dans quelques minutes, puis va dans **Actions → Publier les posts → Run workflow**. Le résumé de l'exécution liste ce qui est parti.

---

## À savoir

- **Tes posts programmés sont visibles dans le dépôt public** avant leur publication. C'est nécessaire : Instagram, Facebook et Zernio téléchargent tes visuels depuis un lien public.
- **Formats de visuels** : une seule image ou une seule vidéo par post. Instagram n'accepte que le **JPEG** pour les images, et la vidéo est publiée en Reel. TikTok et YouTube exigent une vidéo.
- **LinkedIn** : texte seul ou texte + image. La vidéo n'est pas encore prise en charge.
- **Taille des vidéos** : GitHub refuse les fichiers de plus de 100 Mo. Supprimer une vidéo ne libère pas de place, car Git garde l'historique. Pour des vidéos courtes et peu nombreuses, ça va.
- **Ponctualité** : le robot passe chaque heure, à la 7e minute, et GitHub le lance parfois avec un peu de retard. Un post prévu à 9 h 00 part donc vers 9 h 10 ou un peu plus tard.
- **Plus de 48 h de retard** : un post en retard de plus de 48 h (robot en panne, par exemple) n'est pas publié. Il passe en échec pour que tu décides.
- **60 jours sans activité** : sur un dépôt public, GitHub suspend les tâches planifiées si le dépôt ne bouge pas pendant 60 jours, et prévient par e-mail. Publier régulièrement suffit à l'éviter.

## Les fichiers

```
index.html                          l'app Cadence (GitHub Pages)
posts/<id>.json                     un fichier par post
media/<id>/…                        le visuel du post
robot/publish.mjs                   le robot : publication, vérification, aides
.github/workflows/publier.yml       toutes les heures
.github/workflows/verifier-acces.yml   chaque matin
.github/workflows/aide-identifiants.yml  à la main, pendant la mise en route
```

Pour tester le robot sans rien publier :

```bash
DRY_RUN=1 GITHUB_REPOSITORY=<compte>/cadence node robot/publish.mjs
```
