// Cadence — robot de publication.
//
// Lancé toutes les heures par GitHub Actions (.github/workflows/publier.yml).
// Il lit chaque post de posts/*.json, publie ceux dont l'heure est passée,
// puis réécrit le fichier avec le résultat. Il ne touche jamais aux brouillons.
//
//   Instagram, Facebook : Graph API de Meta, en direct
//   LinkedIn            : API officielle, en direct
//   TikTok, YouTube     : Zernio (offre gratuite, 2 comptes)
//   X                   : à la main, le robot n'y touche pas
//
// Modes :
//   node robot/publish.mjs                    publie ce qui est dû
//   node robot/publish.mjs --check            vérifie que les accès sont valides
//   node robot/publish.mjs --zernio-accounts  affiche tes comptes Zernio et leurs identifiants
//   node robot/publish.mjs --linkedin-me      affiche ton identifiant LinkedIn (urn:li:person:…)
//
// Variables : DRY_RUN=1 valide sans rien publier ; NOW=2026-10-28T08:20:00Z simule une heure.

import { readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const DRY_RUN = env.DRY_RUN === "1";
const NOW = env.NOW ? new Date(env.NOW) : new Date();
const MAX_LATE_HOURS = Number(env.MAX_LATE_HOURS || 48);
const POSTS_DIR = env.POSTS_DIR || "posts";

const GRAPH = "https://graph.facebook.com/v26.0";
const GRAPH_VIDEO = "https://graph-video.facebook.com/v26.0";
const LINKEDIN_VERSION = env.LINKEDIN_VERSION || "202610";
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
    const msg = body?.error?.message || body?.message || body?.error || text.slice(0, 300);
    throw new Error(`${res.status} — ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return {res, body};
}

/** Lien public vers un fichier du dépôt : c'est ce lien que Meta et Zernio téléchargent. */
function rawUrl(p) {
  const ref = env.MEDIA_REF || env.GITHUB_SHA || "main";
  const file = p.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY}/${ref}/${file}`;
}

function mediaOf(post) {
  const m = (post.media || [])[0];
  if (!m?.path) return null;
  const type = m.type || (/\.(mp4|mov|m4v|webm)$/i.test(m.path) ? "video" : "image");
  return {path: m.path, type, url: rawUrl(m.path)};
}

const firstLine = (text, max) =>
  (String(text || "").split("\n").find(l => l.trim()) || "Nouvelle vidéo").trim().slice(0, max);

/** LinkedIn interprète certains caractères ; une parenthèse non échappée coupe le post. */
const escapeLinkedIn = s => String(s).replace(/[\\|{}@[\]()<>*_~]/g, c => "\\" + c);

/* ------------------------------------------------------------------ */
/* Réseaux : chaque réseau valide d'abord, puis publie                 */
/* ------------------------------------------------------------------ */

const NETWORKS = {
  facebook: {
    validate() {},
    async publish(post, media) {
      need("META_PAGE_ID", "META_PAGE_TOKEN");
      const page = env.META_PAGE_ID, access_token = env.META_PAGE_TOKEN;
      if (!media) {
        const {body} = await call(`${GRAPH}/${page}/feed`,
          {method: "POST", body: form({message: post.text, access_token})});
        return body.id;
      }
      if (media.type === "video") {
        const {body} = await call(`${GRAPH_VIDEO}/${page}/videos`,
          {method: "POST", body: form({file_url: media.url, description: post.text, access_token})});
        return body.id;
      }
      const {body} = await call(`${GRAPH}/${page}/photos`,
        {method: "POST", body: form({url: media.url, message: post.text, access_token})});
      return body.post_id || body.id;
    },
  },

  instagram: {
    validate(post, media) {
      if (!media) throw new Error("Instagram exige une image ou une vidéo.");
    },
    async publish(post, media) {
      need("META_IG_USER_ID", "META_PAGE_TOKEN");
      const ig = env.META_IG_USER_ID, access_token = env.META_PAGE_TOKEN;
      const params = media.type === "video"
        ? {media_type: "REELS", video_url: media.url, caption: post.text}
        : {image_url: media.url, caption: post.text};
      const {body: container} = await call(`${GRAPH}/${ig}/media`,
        {method: "POST", body: form({...params, access_token})});

      // Instagram télécharge puis traite le média : on attend qu'il soit prêt (5 min au plus).
      for (let i = 0; ; i++) {
        const {body: s} = await call(
          `${GRAPH}/${container.id}?fields=status_code&access_token=${encodeURIComponent(access_token)}`);
        if (s.status_code === "FINISHED") break;
        if (s.status_code === "ERROR" || s.status_code === "EXPIRED")
          throw new Error(`Instagram a refusé le média (${s.status_code}). Vérifie son format et sa taille.`);
        if (i >= 30) throw new Error("Instagram met plus de 5 minutes à traiter le média.");
        await sleep(10_000);
      }
      const {body} = await call(`${GRAPH}/${ig}/media_publish`,
        {method: "POST", body: form({creation_id: container.id, access_token})});
      return body.id;
    },
  },

  linkedin: {
    validate(post, media) {
      if (media?.type === "video")
        throw new Error("Cadence ne sait pas encore envoyer de vidéo sur LinkedIn : retire LinkedIn de ce post ou publie-le à la main.");
    },
    async publish(post, media) {
      need("LINKEDIN_TOKEN", "LINKEDIN_AUTHOR");
      const headers = {
        Authorization: `Bearer ${env.LINKEDIN_TOKEN}`,
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
      };
      let content;
      if (media) {
        const {body: init} = await call("https://api.linkedin.com/rest/images?action=initializeUpload",
          {method: "POST", headers, body: JSON.stringify({initializeUploadRequest: {owner: env.LINKEDIN_AUTHOR}})});
        const up = await fetch(init.value.uploadUrl, {
          method: "PUT", headers: {Authorization: `Bearer ${env.LINKEDIN_TOKEN}`},
          body: await readFile(media.path),
        });
        if (!up.ok) throw new Error(`LinkedIn a refusé l'image (${up.status}).`);
        content = {media: {id: init.value.image}};
      }
      const {res} = await call("https://api.linkedin.com/rest/posts", {
        method: "POST", headers,
        body: JSON.stringify({
          author: env.LINKEDIN_AUTHOR,
          commentary: escapeLinkedIn(post.text),
          visibility: "PUBLIC",
          distribution: {feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: []},
          ...(content ? {content} : {}),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      });
      return res.headers.get("x-restli-id");
    },
  },

  tiktok: zernioNetwork("tiktok", "ZERNIO_TIKTOK_ID"),
  youtube: zernioNetwork("youtube", "ZERNIO_YOUTUBE_ID"),
};

function zernioNetwork(platform, accountVar) {
  return {
    validate(post, media) {
      if (media?.type !== "video") throw new Error(`${NAMES[platform]} exige une vidéo.`);
    },
    async publish(post, media) {
      need("ZERNIO_API_KEY", accountVar);
      const target = {platform, accountId: env[accountVar]};
      if (platform === "youtube") target.platformSpecificData = {title: firstLine(post.text, 100)};
      // Un appel par réseau : si l'un échoue, l'autre n'est pas republié au prochain essai.
      const {res, body} = await call(`${ZERNIO}/posts`, {
        method: "POST",
        headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`, "Content-Type": "application/json"},
        body: JSON.stringify({
          content: post.text,
          mediaItems: [{url: media.url, type: "video"}],
          platforms: [target],
          publishNow: true,
        }),
      });
      if (res.status === 207) throw new Error(`Zernio n'a pas pu publier : ${JSON.stringify(body).slice(0, 300)}`);
      return body?.post?._id || body?._id || body?.postId || null;
    },
  };
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
    const errors = [];
    for (const net of auto) {
      if (post.results[net]?.ok) continue;   // déjà publié lors d'un essai précédent
      const n = NETWORKS[net];
      try {
        if (!n) throw new Error("réseau inconnu");
        n.validate(post, media);
        const id = DRY_RUN ? "essai" : await n.publish(post, media);
        post.results[net] = {ok: true, id: id ?? null, at: new Date().toISOString()};
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
      report.push(`- ✅ « ${label} » → ${auto.map(n => NAMES[n]).join(", ")}${post.manual.length ? " (X reste à poster à la main)" : ""}`);
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
      await call(`${GRAPH}/me?fields=id&access_token=${encodeURIComponent(env.META_PAGE_TOKEN)}`);
      ok.push("Meta (Instagram, Facebook) : accès valide");
    } catch (e) { problems.push(`Meta : l'accès ne fonctionne plus (${e.message}). Régénère META_PAGE_TOKEN.`); }
  }

  if (env.LINKEDIN_TOKEN) {
    const until = env.LINKEDIN_TOKEN_EXPIRES ? new Date(env.LINKEDIN_TOKEN_EXPIRES + "T00:00:00Z") : null;
    if (!until || isNaN(until)) {
      problems.push("LinkedIn : renseigne LINKEDIN_TOKEN_EXPIRES (AAAA-MM-JJ) pour être prévenu avant l'expiration.");
    } else {
      const days = Math.floor((until - NOW) / 86_400_000);
      if (days < 0) problems.push("LinkedIn : l'accès a expiré. Reconnecte-toi et remplace LINKEDIN_TOKEN.");
      else if (days <= 7) problems.push(`LinkedIn : l'accès expire dans ${days} jour${days > 1 ? "s" : ""}. Reconnecte-toi et remplace LINKEDIN_TOKEN.`);
      else ok.push(`LinkedIn : accès valide encore ${days} jours`);
    }
  }

  const text = ["## Cadence — vérification des accès",
    ...ok.map(l => `- ✅ ${l}`), ...problems.map(l => `- ❌ ${l}`)].join("\n");
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + "\n");
  if (problems.length) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Aides à la mise en route (n'affichent jamais de secret)             */
/* ------------------------------------------------------------------ */

async function zernioAccounts() {
  need("ZERNIO_API_KEY");
  try {
    const {body} = await call(`${ZERNIO}/accounts`, {headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`}});
    const list = body.accounts || body.data || (Array.isArray(body) ? body : []);
    if (!list.length) return console.log("Aucun compte connecté chez Zernio pour l'instant.");
    for (const a of list) console.log(`${a.platform || "?"}\t${a._id || a.id}\t${a.username || a.name || ""}`);
    console.log("\nCopie l'identifiant TikTok dans ZERNIO_TIKTOK_ID et celui de YouTube dans ZERNIO_YOUTUBE_ID.");
  } catch (e) {
    console.log(`Impossible de lister les comptes (${e.message}). Copie les identifiants depuis le tableau de bord Zernio.`);
    process.exitCode = 1;
  }
}

async function linkedinMe() {
  need("LINKEDIN_TOKEN");
  const {body} = await call("https://api.linkedin.com/v2/userinfo",
    {headers: {Authorization: `Bearer ${env.LINKEDIN_TOKEN}`}});
  console.log(`Ton identifiant LinkedIn : urn:li:person:${body.sub}`);
  console.log("Copie-le dans le secret LINKEDIN_AUTHOR.");
}

/* ------------------------------------------------------------------ */

const mode = process.argv[2];
const run = mode === "--check" ? checkAccess
          : mode === "--zernio-accounts" ? zernioAccounts
          : mode === "--linkedin-me" ? linkedinMe
          : publishDue;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(e => { console.error(`Erreur : ${e.message}`); process.exitCode = 1; });
}
