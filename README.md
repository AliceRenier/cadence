# Cadence

Planifie tes posts dans un calendrier. Un robot GitHub les publie à l'heure prévue, sans serveur et sans abonnement.

| Réseau | Publié par | Coût |
|---|---|---|
| Instagram | API officielle de Meta, en direct | gratuit |
| Facebook (Page) | API officielle de Meta, en direct | gratuit |
| YouTube | API officielle de Google, en direct | gratuit |
| TikTok | Zernio, offre gratuite | gratuit (place 1 sur 2) |
| LinkedIn (page) | Zernio, offre gratuite | gratuit (place 2 sur 2) |
| X | toi, à la main : Cadence copie le texte en un clic | gratuit |

## Comment ça marche

1. Tu écris tes posts dans Cadence, ton site GitHub Pages. Chaque post devient un fichier `posts/<id>.json` dans ce dépôt, et son visuel va dans `media/<id>/`.
2. Toutes les heures, la tâche **Publier les posts** lance `robot/publish.mjs`. Le robot publie ce qui est dû, puis note le résultat dans le fichier du post.
3. Si une publication échoue, GitHub t'envoie un e-mail. Le post passe en « Échec » dans Cadence, avec la raison. Corrige le problème et repasse le post en « Programmé » : seuls les réseaux en échec repartent.
4. Chaque matin, **Vérifier les accès** contrôle que tes accès Meta, YouTube et Zernio marchent encore.

---

## Mise en route (une seule fois)

### 1. Le dépôt et le site

1. Crée un dépôt **public** nommé `cadence` sur GitHub et envoie-y ce dossier, par exemple avec GitHub Desktop.
2. **Settings → Pages** : *Deploy from a branch*, branche `main`, dossier `/ (root)`.
   Cadence sera en ligne à l'adresse `https://<ton-compte>.github.io/cadence/`.
3. Crée le jeton qui sert à te connecter à Cadence : [Jetons à grain fin](https://github.com/settings/personal-access-tokens/new).
   - *Repository access* : **Only select repositories** → `cadence`
   - *Permissions* : **Contents → Read and write**
   - Colle-le dans l'écran de connexion de Cadence. Il reste dans ton navigateur, sur cet appareil.

### 2. Zernio : TikTok et ta page LinkedIn

1. Crée un compte sur [zernio.com](https://zernio.com), sans carte bancaire.
2. Connecte **TikTok**, puis **LinkedIn**. Après la connexion LinkedIn, Zernio te demande où publier : choisis **ta page**, pas ton profil.
   N'en connecte pas d'autre : à partir du 3e compte, Zernio est payant.
3. Crée une clé API sur [zernio.com/dashboard/api-keys](https://zernio.com/dashboard/api-keys) → secret **`ZERNIO_API_KEY`**.
4. Lance la tâche **Aide — trouver mes identifiants**. Elle affiche tes comptes Zernio :
   - l'identifiant de la ligne `tiktok` → secret **`ZERNIO_TIKTOK_ID`**
   - l'identifiant de la ligne `linkedin` → secret **`ZERNIO_LINKEDIN_ID`**

### 3. Meta : Instagram et Facebook

Il te faut un compte Instagram **professionnel** (Business ou Créateur), relié à ta **Page Facebook**.

1. Sur [developers.facebook.com](https://developers.facebook.com/apps), crée une app. Ajoute les cas d'usage **Tout gérer sur votre Page** et **Gérer les messages et les contenus sur Instagram**, ce dernier avec la *connexion Facebook*.
   Laisse l'app en mode développement : tant que tu n'y relies que tes propres comptes, Meta n'a rien à valider.
2. Dans chaque cas d'usage, ouvre **Personnaliser** et ajoute `pages_manage_posts` et `instagram_content_publish`.
3. Dans l'[explorateur de l'API Graph](https://developers.facebook.com/tools/explorer), choisis ton app, puis **Obtenir un token d'accès utilisateur**, avec ces permissions :
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `publish_video`, `instagram_basic`, `instagram_content_publish`, `business_management`.
4. Prolonge ce jeton : clique sur **ⓘ**, puis **Ouvrir dans l'outil Token d'accès**, puis **Prolonger le token d'accès**.
5. Avec le jeton prolongé, appelle `me/accounts?fields=id,name,access_token,instagram_business_account`. Pour ta Page :
   - `access_token` → secret **`META_PAGE_TOKEN`**. Ce jeton de Page n'expire pas.
   - `id` → secret **`META_PAGE_ID`**
   - `instagram_business_account.id` → secret **`META_IG_USER_ID`**

### 4. Google : YouTube

1. Sur [console.cloud.google.com](https://console.cloud.google.com), crée un projet `Cadence`.
2. **API et services → Bibliothèque** : active **YouTube Data API v3**.
3. **Écran de consentement OAuth** (ou *Google Auth Platform*) :
   - Type d'utilisateur **Externe**. Nom de l'app `Cadence`, et ton e-mail.
   - Ajoute les champs d'application `youtube.upload` et `youtube.readonly`.
   - **Publie l'app en production.** Sans ça, ta clé expirerait au bout de 7 jours. Google affichera un avertissement « application non validée » : c'est normal pour un outil qui ne sert qu'à toi.
4. **Identifiants → Créer des identifiants → ID client OAuth** :
   - Type **Application Web**
   - URI de redirection autorisé : `https://developers.google.com/oauthplayground`
   - L'ID client → secret **`GOOGLE_CLIENT_ID`**, et le code secret du client → secret **`GOOGLE_CLIENT_SECRET`**
5. Sur l'[OAuth Playground](https://developers.google.com/oauthplayground) :
   - ⚙ → coche **Use your own OAuth credentials**, puis colle l'ID et le code secret
   - Dans le champ de l'étape 1, saisis `https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly`, puis **Authorize APIs**
   - Choisis le compte Google, puis **la chaîne Risktakeur**. Passe l'avertissement : *Paramètres avancés*, puis *Accéder à Cadence*. Autorise.
   - Étape 2 : **Exchange authorization code for tokens**. Le *Refresh token* → secret **`YOUTUBE_REFRESH_TOKEN`**

### 5. Les secrets

Ils se rangent dans **Settings → Secrets and variables → Actions → New repository secret** :

| Secret | Sert à |
|---|---|
| `META_PAGE_TOKEN` | publier sur Instagram et Facebook |
| `META_PAGE_ID` | ta Page Facebook |
| `META_IG_USER_ID` | ton compte Instagram pro |
| `GOOGLE_CLIENT_ID` | ton app Google |
| `GOOGLE_CLIENT_SECRET` | ton app Google |
| `YOUTUBE_REFRESH_TOKEN` | publier sur ta chaîne YouTube |
| `ZERNIO_API_KEY` | publier sur TikTok et LinkedIn |
| `ZERNIO_TIKTOK_ID` | ton compte TikTok chez Zernio |
| `ZERNIO_LINKEDIN_ID` | ta page LinkedIn chez Zernio |

Les secrets ne s'affichent jamais, même dans un dépôt public. Lance ensuite **Vérifier les accès** : chaque réseau doit afficher ✅.

### 6. Premier essai

Programme un post de test dans Cadence pour dans quelques minutes, puis va dans **Actions → Publier les posts → Run workflow**. Le résumé de l'exécution liste ce qui est parti.

---

## À savoir

- **Tes posts programmés sont visibles dans le dépôt public** avant leur publication. C'est nécessaire : Instagram, Facebook et Zernio téléchargent tes visuels depuis un lien public.
- **Formats de visuels** : une seule image ou une seule vidéo par post. Instagram n'accepte que le **JPEG** pour les images, et la vidéo y est publiée en Reel. TikTok et YouTube exigent une vidéo.
- **YouTube** : la première ligne du texte devient le titre (100 caractères au plus), et le texte entier la description. Une vidéo verticale de moins de 3 minutes est classée en Short.
- **LinkedIn** : un même texte publié deux fois est refusé par LinkedIn, même à plusieurs semaines d'écart.
- **Taille des vidéos** : GitHub refuse les fichiers de plus de 100 Mo. Supprimer une vidéo ne libère pas de place, car Git garde l'historique. Pour des vidéos courtes et peu nombreuses, ça va.
- **Ponctualité** : le robot passe chaque heure, à la 7e minute, et GitHub le lance parfois avec un peu de retard. Un post prévu à 9 h 00 part donc vers 9 h 10 ou un peu plus tard.
- **Plus de 48 h de retard** : un post en retard de plus de 48 h n'est pas publié. Il passe en échec pour que tu décides.
- **60 jours sans activité** : sur un dépôt public, GitHub suspend les tâches planifiées si le dépôt ne bouge pas pendant 60 jours, et prévient par e-mail. Publier régulièrement suffit à l'éviter.

## Les fichiers

```
index.html                               l'app Cadence (GitHub Pages)
posts/<id>.json                          un fichier par post
media/<id>/…                             le visuel du post
robot/publish.mjs                        le robot : publication, vérification, aide
.github/workflows/publier.yml            toutes les heures
.github/workflows/verifier-acces.yml     chaque matin
.github/workflows/aide-identifiants.yml  à la main, pendant la mise en route
```

Pour tester le robot sans rien publier :

```bash
DRY_RUN=1 GITHUB_REPOSITORY=<compte>/cadence node robot/publish.mjs
```
