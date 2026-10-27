// Cadence — robot de publication.
//
// Lancé toutes les heures par GitHub Actions (.github/workflows/publier.yml).
// Il lit chaque post de posts/*.json, publie ceux dont l'heure est passée,
// puis réécrit le fichier avec le résultat. Il ne touche jamais aux brouillons.
//
//   Instagram, Facebook : Graph API de Meta, en direct
//   YouTube             : API YouTube de Google, en direct
//   TikTok, LinkedIn    : Zernio (offre gratuite, 2 comptes) — LinkedIn publie sur ta page
//   X                   : à la main, le robot n'y touche pas
//
// Modes :
//   node robot/publish.mjs                    publie ce qui est dû
//   node robot/publish.mjs --check            vérifie que les accès sont valides
//   node robot/publish.mjs --zernio-accounts  affiche tes comptes Zernio et leurs identifiants
//
// Variables : DRY_RUN=1 valide sans rien publier ; NOW=2026-10-28T08:20:00Z simule une heure.
//
// Après chaque passage, il supprime les visuels des posts publiés depuis plus de 24 h
// (voir cleanPublished) : le dépôt ne garde que ceux qui attendent encore.

import { readdir, readFile, writeFile, appendFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "../rules.js";   // règles de chaque réseau, partagées avec l'interface

const { check: checkRules, compose, tiktokMode } = globalThis.CadenceRules;

const env = process.env;
const DRY_RUN = env.DRY_RUN === "1";
const NOW = env.NOW ? new Date(env.NOW) : new Date();
const MAX_LATE_HOURS = Number(env.MAX_LATE_HOURS || 48);
const KEEP_MEDIA_HOURS = Number(env.KEEP_MEDIA_HOURS || 24);   // le temps que chaque réseau ait fini de télécharger
const POSTS_DIR = env.POSTS_DIR || "posts";

const GRAPH = "https://graph.facebook.com/v26.0";
const GRAPH_VIDEO = "https://graph-video.facebook.com/v26.0";
const ZERNIO = "https://zernio.com/api/v1";

const NAMES = {instagram:"Instagram", facebook:"Facebook", linkedin:"LinkedIn",
               tiktok:"TikTok", youtube:"YouTube", x:"X"};
const MANUAL = new Set(["x"]);

/* ------------------------------------------------------------------ */
/* Heure                                                               */
/* ------------------------------------------------------------------ */

/** "2026-10-28T09:15" à l'heure de Paris → instant UTC, changements d'heure compris. */
export function zonedToUtc(local, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(local || ""));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess = wall - (seen - guess);
  }
  return new Date(guess);
}

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const form = obj => new URLSearchParams(
  Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

function need(...names) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) throw new Error(`secret manquant dans GitHub : ${missing.join(", ")}`);
}

/** Appel HTTP qui renvoie le corps décodé, ou lève une erreur lisible. */
async function call(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {raw: text}; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error_description || body?.message || body?.error || text.slice(0, 300);
    throw new Error(`${res.status} — ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return {res, body};
}

/**
 * Lien public vers un visuel : c'est ce lien que Meta et Zernio téléchargent.
 * ref = la branche des visuels ("media") ; sans ref, un ancien visuel rangé avec le code.
 */
function rawUrl(p, ref) {
  ref ||= env.MEDIA_REF || env.GITHUB_SHA || "main";
  const file = p.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/${ref}/${file}`;
}

/**
 * Les visuels d'un post : une vidéo, OU une à plusieurs images (carrousel),
 * plus éventuellement un PDF réservé à LinkedIn.
 */
function mediaOf(post) {
  const items = (post.media || []).filter(m => m?.path).map(m => ({
    path: m.path,
    type: m.type || (/\.(mp4|mov|m4v|webm)$/i.test(m.path) ? "video" : /\.pdf$/i.test(m.path) ? "document" : "image"),
    url: rawUrl(m.path, m.ref),
  }));
  return {
    video: items.find(i => i.type === "video") || null,
    images: items.filter(i => i.type === "image"),
    document: items.find(i => i.type === "document") || null,
  };
}

/** Les visuels au format Zernio : la vidéo, sinon les images dans l'ordre choisi. */
const zernioVisuals = m => m.video ? [{url: m.video.url, type: "video"}]
  : m.images.map(i => ({url: i.url, type: "image"}));

const firstLine = (text, max) =>
  (String(text || "").split("\n").find(l => l.trim()) || "Nouvelle vidéo").trim().slice(0, max);

/** Échange la clé longue durée de Google contre un accès valable une heure. */
async function googleAccessToken() {
  need("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN");
  const {body} = await call("https://oauth2.googleapis.com/token", {method: "POST", body: form({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  })});
  return body.access_token;
}

/* ------------------------------------------------------------------ */
/* Réseaux : chaque réseau valide d'abord, puis publie                 */
/* ------------------------------------------------------------------ */

/** Instagram télécharge puis traite chaque média : on attend qu'il soit prêt (5 min au plus). */
async function waitInstagram(containerId, access_token) {
  for (let i = 0; ; i++) {
    const {body: s} = await call(
      `${GRAPH}/${containerId}?fields=status_code&access_token=${encodeURIComponent(access_token)}`);
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED")
      throw new Error(`Instagram a refusé un média (${s.status_code}). Vérifie son format et sa taille.`);
    if (i >= 30) throw new Error("Instagram met plus de 5 minutes à traiter le média.");
    await sleep(10_000);
  }
}

const NETWORKS = {
  facebook: {
    validate() {},
    async publish(post, m) {
      need("META_PAGE_ID", "META_PAGE_TOKEN");
      const page = env.META_PAGE_ID, access_token = env.META_PAGE_TOKEN;
      const {text} = compose(post, "facebook", Boolean(m.video));
      if (m.video) {
        const {body} = await call(`${GRAPH_VIDEO}/${page}/videos`,
          {method: "POST", body: form({file_url: m.video.url, description: text, access_token})});
        return body.id;
      }
      if (m.images.length === 1) {
        const {body} = await call(`${GRAPH}/${page}/photos`,
          {method: "POST", body: form({url: m.images[0].url, message: text, access_token})});
        return body.post_id || body.id;
      }
      // Plusieurs images : on les dépose sans les publier, puis un seul post les regroupe.
      const attached = {};
      for (const [n, img] of m.images.entries()) {
        const {body} = await call(`${GRAPH}/${page}/photos`,
          {method: "POST", body: form({url: img.url, published: "false", access_token})});
        attached[`attached_media[${n}]`] = JSON.stringify({media_fbid: body.id});
      }
      const {body} = await call(`${GRAPH}/${page}/feed`,
        {method: "POST", body: form({message: text, ...attached, access_token})});
      return body.id;
    },
  },

  instagram: {
    validate(post, m) {
      if (!m.video && !m.images.length) throw new Error("Instagram exige une image ou une vidéo.");
      if (!m.video && m.images.length > 10) throw new Error("Instagram accepte 10 images au plus dans un carrousel.");
    },
    async publish(post, m) {
      need("META_IG_USER_ID", "META_PAGE_TOKEN");
      const ig = env.META_IG_USER_ID, access_token = env.META_PAGE_TOKEN;
      const caption = compose(post, "instagram", Boolean(m.video)).text;
      let params;
      if (m.video) params = {media_type: "REELS", video_url: m.video.url, caption};
      else if (m.images.length === 1) params = {image_url: m.images[0].url, caption};
      else {
        // Carrousel : un conteneur par image, puis un conteneur qui les regroupe.
        const children = [];
        for (const img of m.images) {
          const {body} = await call(`${GRAPH}/${ig}/media`,
            {method: "POST", body: form({image_url: img.url, is_carousel_item: "true", access_token})});
          await waitInstagram(body.id, access_token);
          children.push(body.id);
        }
        params = {media_type: "CAROUSEL", children: children.join(","), caption};
      }
      const {body: container} = await call(`${GRAPH}/${ig}/media`,
        {method: "POST", body: form({...params, access_token})});
      await waitInstagram(container.id, access_token);
      const {body} = await call(`${GRAPH}/${ig}/media_publish`,
        {method: "POST", body: form({creation_id: container.id, access_token})});
      return body.id;
    },
  },

  youtube: {
    validate(post, m) {
      if (!m.video) throw new Error("YouTube exige une vidéo.");
    },
    async publish(post, m) {
      const token = await googleAccessToken();
      const bytes = await readFile(m.video.path);
      const type = /\.mov$/i.test(m.video.path) ? "video/quicktime" : "video/mp4";

      // Envoi en deux temps : on décrit la vidéo, YouTube répond avec l'adresse où déposer le fichier.
      const init = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": type,
            "X-Upload-Content-Length": String(bytes.length),
          },
          body: JSON.stringify({
            snippet: {...(({title, text}) => ({title, description: text}))(compose(post, "youtube", true)), categoryId: "22"},
            status: {privacyStatus: "public", selfDeclaredMadeForKids: false},
          }),
        });
      if (!init.ok) throw new Error(`YouTube a refusé l'envoi (${init.status}) : ${(await init.text()).slice(0, 300)}`);
      const {body} = await call(init.headers.get("location"),
        {method: "PUT", headers: {"Content-Type": type}, body: bytes});
      return body.id;
    },
  },

  tiktok: {
    validate(post, m) {
      if (!m.video && !m.images.length) throw new Error("TikTok exige une vidéo ou des images.");
      if (!m.video && m.images.length > 35) throw new Error("TikTok accepte 35 images au plus dans un carrousel.");
    },
    async publish(post, m) {
      const mode = tiktokMode(post, Boolean(m.video));
      // TikTok exige ces confirmations sur chaque post (obligation légale de leur côté).
      const tiktokSettings = {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
        ...(m.video ? {allowDuet: true, allowStitch: true} : {photoCoverIndex: 0, autoAddMusic: mode === "auto"}),
        ...(mode === "draft" ? {draft: true} : {}),
        ...(mode === "music" ? {musicSoundInfo: {musicSoundId: post.tiktok.music.id}} : {}),
      };
      // Carrousel photo : un titre court (90 caractères) et la description complète, hashtags compris.
      const {title, text} = compose(post, "tiktok", Boolean(m.video));
      if (!m.video) tiktokSettings.description = text;
      const id = await zernioPost("tiktok", "ZERNIO_TIKTOK_ID", m.video ? text : title,
        zernioVisuals(m), {tiktokSettings});
      return mode === "draft" ? {id, draft: true} : id;
    },
  },

  linkedin: {
    validate() {},
    publish(post, m) {
      const {title, text} = compose(post, "linkedin", Boolean(m.video));
      // Le PDF fourni pour LinkedIn passe avant les autres visuels : c'est le format carrousel de LinkedIn.
      if (m.document) {
        return zernioPost("linkedin", "ZERNIO_LINKEDIN_ID", text,
          [{url: m.document.url, type: "document", title}], {}, {documentTitle: title});
      }
      return zernioPost("linkedin", "ZERNIO_LINKEDIN_ID", text, zernioVisuals(m));
    },
  },
};

/**
 * Publication via Zernio. Un appel par réseau : si l'un échoue, l'autre n'est pas
 * republié au prochain essai. Pour LinkedIn, la page cible a été choisie à la connexion du compte.
 */
async function zernioPost(platform, accountVar, content, mediaItems, extra = {}, platformSpecificData) {
  need("ZERNIO_API_KEY", accountVar);
  const {res, body} = await call(`${ZERNIO}/posts`, {
    method: "POST",
    headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`, "Content-Type": "application/json"},
    body: JSON.stringify({
      content,
      ...(mediaItems.length ? {mediaItems} : {}),
      platforms: [{platform, accountId: env[accountVar], ...(platformSpecificData ? {platformSpecificData} : {})}],
      publishNow: true,
      ...extra,
    }),
  });
  if (res.status === 207) throw new Error(`Zernio n'a pas pu publier : ${JSON.stringify(body).slice(0, 300)}`);
  return body?.post?._id || body?._id || body?.postId || null;
}

/* ------------------------------------------------------------------ */
/* Publication des posts dus                                           */
/* ------------------------------------------------------------------ */

async function publishDue() {
  const files = (await readdir(POSTS_DIR).catch(() => [])).filter(f => f.endsWith(".json")).sort();
  const report = [];
  let failures = 0;

  for (const f of files) {
    const file = path.join(POSTS_DIR, f);
    const post = JSON.parse(await readFile(file, "utf8"));
    if (post.status !== "scheduled") continue;

    const auto = (post.platforms || []).filter(n => !MANUAL.has(n));
    if (!auto.length) continue;          // post 100 % manuel (X seul) : rien à faire ici

    const due = zonedToUtc(post.at, post.timezone || "Europe/Paris");
    if (!due || due > NOW) continue;

    const label = firstLine(post.text, 50);
    post.results ||= {};

    const lateHours = (NOW - due) / 3_600_000;
    if (lateHours > MAX_LATE_HOURS) {
      post.status = "failed";
      post.error = `Plus de ${MAX_LATE_HOURS} h de retard : rien n'a été publié. Reprogramme-le si tu veux qu'il parte.`;
      failures++;
      report.push(`- ❌ « ${label} » : trop en retard`);
      await writeFile(file, JSON.stringify(post, null, 2) + "\n");
      continue;
    }

    const media = mediaOf(post);
    // Le poids réel des fichiers, pour vérifier les limites même sur un ancien post.
    for (const m of post.media || []) {
      if (!m?.path || m.size) continue;
      m.size = m.ref
        ? await fetch(rawUrl(m.path, m.ref), {method: "HEAD"}).then(r => Number(r.headers.get("content-length")) || undefined, () => undefined)
        : await stat(m.path).then(s => s.size, () => undefined);
    }
    const errors = [];
    for (const net of auto) {
      if (post.results[net]?.ok) continue;   // déjà publié lors d'un essai précédent
      const n = NETWORKS[net];
      try {
        if (!n) throw new Error("réseau inconnu");
        const blocking = checkRules({...post, platforms: [net]}).filter(i => i.net === net && i.level === "error");
        if (blocking.length) throw new Error(blocking.map(i => i.msg).join(" "));
        n.validate(post, media);
        const out = DRY_RUN ? "essai" : await n.publish(post, media);
        const {id, draft} = out && typeof out === "object" ? out : {id: out};
        post.results[net] = {ok: true, id: id ?? null, ...(draft ? {draft: true} : {}), at: new Date().toISOString()};
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 500);
        post.results[net] = {ok: false, error: msg, at: new Date().toISOString()};
        errors.push(`${NAMES[net] || net} : ${msg}`);
      }
    }

    post.manual = (post.platforms || []).filter(n => MANUAL.has(n) && !post.results[n]?.ok);
    if (errors.length) {
      post.status = "failed";
      post.error = errors.join("\n");
      failures++;
      report.push(`- ❌ « ${label} »\n${errors.map(e => `  - ${e}`).join("\n")}`);
    } else {
      post.status = "published";
      post.publishedAt = new Date().toISOString();
      delete post.error;
      const notes = [post.manual.length && "X reste à poster à la main",
                     post.results.tiktok?.draft && "TikTok attend dans ton app, en brouillon"].filter(Boolean);
      report.push(`- ✅ « ${label} » → ${auto.map(n => NAMES[n]).join(", ")}${notes.length ? ` (${notes.join(" ; ")})` : ""}`);
    }
    await writeFile(file, JSON.stringify(post, null, 2) + "\n");
  }

  const head = `## Cadence — ${DRY_RUN ? "essai à blanc" : "publication"} du ${NOW.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const text = [head, report.length ? report.join("\n") : "Rien à publier pour l'instant."].join("\n\n");
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + "\n");
  if (failures) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Vérification des accès (une fois par jour)                          */
/* ------------------------------------------------------------------ */

async function checkAccess() {
  const problems = [], ok = [];

  if (env.META_PAGE_TOKEN) {
    try {
      const t = encodeURIComponent(env.META_PAGE_TOKEN);
      await call(`${GRAPH}/me?fields=id&access_token=${t}`);
      // La clé s'inspecte elle-même : expires_at vaut 0 quand elle n'expire jamais.
      let expiresAt = null;
      try {
        const {body} = await call(`${GRAPH}/debug_token?input_token=${t}&access_token=${t}`);
        expiresAt = body?.data?.expires_at ?? null;
      } catch { /* l'inspection est un plus : l'accès lui-même est déjà validé */ }
      const days = expiresAt ? Math.floor((expiresAt * 1000 - NOW) / 86_400_000) : null;
      if (expiresAt === 0) ok.push("Meta (Instagram, Facebook) : accès valide, n'expire pas");
      else if (days !== null && days <= 7) problems.push(`Meta : la clé expire dans ${Math.max(days, 0)} jour${days > 1 ? "s" : ""}. Régénère META_PAGE_TOKEN.`);
      else ok.push(`Meta (Instagram, Facebook) : accès valide${days !== null ? `, encore ${days} jours` : ""}`);
    } catch (e) { problems.push(`Meta : l'accès ne fonctionne plus (${e.message}). Régénère META_PAGE_TOKEN.`); }
  }

  if (env.YOUTUBE_REFRESH_TOKEN) {
    try {
      const token = await googleAccessToken();
      const {body} = await call("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        {headers: {Authorization: `Bearer ${token}`}});
      const channel = body.items?.[0]?.snippet?.title;
      if (channel) ok.push(`YouTube : accès valide, chaîne « ${channel} »`);
      else problems.push("YouTube : l'accès marche, mais ce compte Google n'a pas de chaîne. Régénère la clé en choisissant la chaîne Risktakeur.");
    } catch (e) { problems.push(`YouTube : l'accès ne fonctionne plus (${e.message}). Régénère YOUTUBE_REFRESH_TOKEN.`); }
  }

  if (env.ZERNIO_API_KEY) {
    try {
      await call(`${ZERNIO}/accounts`, {headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`}});
      ok.push("Zernio (TikTok, LinkedIn) : clé valide");
    } catch (e) { problems.push(`Zernio : la clé ne fonctionne plus (${e.message}). Crée-en une nouvelle et remplace ZERNIO_API_KEY.`); }
  }

  const text = ["## Cadence — vérification des accès",
    ...ok.map(l => `- ✅ ${l}`), ...problems.map(l => `- ❌ ${l}`)].join("\n");
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + "\n");
  if (problems.length) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Aide à la mise en route (n'affiche jamais de secret)                */
/* ------------------------------------------------------------------ */

async function zernioAccounts() {
  need("ZERNIO_API_KEY");
  try {
    const {body} = await call(`${ZERNIO}/accounts`, {headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`}});
    const list = body.accounts || body.data || (Array.isArray(body) ? body : []);
    if (!list.length) return console.log("Aucun compte connecté chez Zernio pour l'instant.");
    for (const a of list) console.log(`${a.platform || "?"}\t${a._id || a.id}\t${a.username || a.name || ""}`);
    console.log("\nCopie l'identifiant TikTok dans ZERNIO_TIKTOK_ID et celui de LinkedIn dans ZERNIO_LINKEDIN_ID.");
  } catch (e) {
    console.log(`Impossible de lister les comptes (${e.message}). Copie les identifiants depuis le tableau de bord Zernio.`);
    process.exitCode = 1;
  }
}

/**
 * Les 100 sons tendance de TikTok (bibliothèque commerciale), avec un extrait à écouter.
 * Rangés dans music/tiktok.json, que Cadence affiche dans le composeur.
 */
async function tiktokMusic() {
  need("ZERNIO_API_KEY", "ZERNIO_TIKTOK_ID");
  const countryCode = env.MUSIC_COUNTRY || "FR";
  let out;
  try {
    const {body} = await call(
      `${ZERNIO}/accounts/${encodeURIComponent(env.ZERNIO_TIKTOK_ID)}/tiktok/commercial-music?countryCode=${countryCode}`,
      {headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`}});
    const tracks = (body.tracks || []).map(t => ({
      id: t.clip?.id || t.id,                     // l'extrait tendance publie mieux que le morceau entier
      name: t.name || "Sans titre",
      artist: t.artist || "",
      durationSec: t.clip?.durationSec || t.durationSec || null,
      previewUrl: t.clip?.previewUrl || t.previewUrl || null,
      thumbnailUrl: t.thumbnailUrl || null,
      rank: t.rank ?? null,
    })).filter(t => t.id);
    out = {updatedAt: new Date().toISOString(), countryCode, tracks};
    console.log(`${tracks.length} sons tendance récupérés (${countryCode}).`);
  } catch (e) {
    // Souvent : le compte TikTok n'est pas connecté à Zernio via l'app « TikTok for Business ».
    out = {updatedAt: new Date().toISOString(), countryCode, tracks: [], error: e.message};
    console.log(`Liste des sons indisponible : ${e.message}`);
  }
  await import("node:fs/promises").then(fs => fs.mkdir("music", {recursive: true}));
  await writeFile("music/tiktok.json", JSON.stringify(out, null, 2) + "\n");
}

/* ------------------------------------------------------------------ */
/* Ménage : les visuels des posts déjà publiés                         */
/* ------------------------------------------------------------------ */

/** Supprime un fichier de la branche des visuels, par l'API GitHub (jeton du workflow). */
async function deleteFromBranch(p, ref) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/${p.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json"};
  const found = await fetch(`${url}?ref=${encodeURIComponent(ref)}`, {headers});
  if (found.status === 404) return;   // déjà supprimé
  if (!found.ok) throw new Error(`GitHub a répondu ${found.status}`);
  const {sha} = await found.json();
  await call(url, {method: "DELETE", headers, body: JSON.stringify({message: "Robot : visuel publié supprimé", sha, branch: ref})});
}

/**
 * Les visuels d'un post publié depuis plus de KEEP_MEDIA_HOURS sont supprimés : chaque réseau
 * a gardé sa copie. On attend tant que X reste à poster à la main, puisqu'il te faut le visuel.
 * Le post garde son texte et note combien de visuels il avait.
 */
async function cleanPublished() {
  const files = (await readdir(POSTS_DIR).catch(() => [])).filter(f => f.endsWith(".json")).sort();
  let removed = 0;
  for (const f of files) {
    const file = path.join(POSTS_DIR, f);
    const post = JSON.parse(await readFile(file, "utf8"));
    if (post.status !== "published" || !post.publishedAt || !post.media?.length) continue;
    if ((post.manual || []).length) continue;
    if ((NOW - new Date(post.publishedAt)) / 3_600_000 < KEEP_MEDIA_HOURS) continue;
    if (DRY_RUN) { console.log(`Essai : supprimerait ${post.media.length} visuel(s) de « ${firstLine(post.text, 50)} »`); continue; }
    try {
      for (const m of post.media) {
        if (m.ref) await deleteFromBranch(m.path, m.ref);
        else await rm(m.path, {force: true});
      }
    } catch (e) {
      console.log(`Visuels de « ${firstLine(post.text, 50)} » gardés pour l'instant : ${e.message}`);
      continue;
    }
    post.mediaRemoved = {at: NOW.toISOString(), count: post.media.length};
    post.media = [];
    await writeFile(file, JSON.stringify(post, null, 2) + "\n");
    removed++;
  }
  if (removed) console.log(`Ménage : visuels supprimés pour ${removed} post(s) publié(s).`);
}

async function publishAndClean() {
  await publishDue();
  await cleanPublished();
}

/* ------------------------------------------------------------------ */

const mode = process.argv[2];
const run = mode === "--check" ? checkAccess
          : mode === "--zernio-accounts" ? zernioAccounts
          : mode === "--tiktok-music" ? tiktokMusic
          : publishAndClean;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => { console.error(`Erreur : ${e.message}`); process.exitCode = 1; });
}
