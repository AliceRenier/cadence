// Cadence — robot de publication.
//
// Lancé toutes les 15 minutes par GitHub Actions (.github/workflows/publier.yml).
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
// Après chaque passage, il supprime les visuels des posts publiés depuis plus de 24 h, une fois
// que chaque réseau a confirmé le post en ligne (voir cleanPublished).

import { readdir, readFile, writeFile, appendFile, stat, rm, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "../rules.js";   // règles de chaque réseau, partagées avec l'interface

const { check: checkRules, compose, tiktokMode, linkedinUrl } = globalThis.CadenceRules;

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
    ref: m.ref,
    size: m.size,
    type: m.type || (/\.(mp4|mov|m4v|webm)$/i.test(m.path) ? "video" : /\.pdf$/i.test(m.path) ? "document" : "image"),
    // Une grosse vidéo est servie depuis la release « visuels », une fois recollée par le robot.
    url: m.asset?.url || rawUrl(m.path, m.ref),
    source: m,   // l'entrée du post, pour y noter une copie préparée (Instagram)
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
/* ------------------------------------------------------------------ */
/* Grosses vidéos : la release « visuels »                             */
/* ------------------------------------------------------------------ */
//
// GitHub refuse les fichiers de plus de 100 Mo dans le code. Cadence envoie donc une grosse vidéo
// en morceaux sur la branche des visuels ; le robot les recolle, tels quels, dans un seul fichier
// de la release « visuels » (2 Go par fichier). Ce fichier est servi avec son vrai type (video/mp4),
// et il est supprimé comme les autres visuels, une fois le post confirmé en ligne.

const GH_API = () => `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
const ghHeaders = () => ({Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json"});
const MIME = {mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", pdf: "application/pdf",
              jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif"};
const mimeOfPath = p => MIME[p.split(".").pop().toLowerCase()] || "application/octet-stream";
const assetName = (p, suffix = "") => p.replace(/^media\//, "").replace(/\//g, "-") + suffix;

let release = null;
async function mediaRelease() {
  if (release) return release;
  const found = await fetch(`${GH_API()}/releases/tags/visuels`, {headers: ghHeaders()});
  if (found.ok) return (release = await found.json());
  const {body} = await call(`${GH_API()}/releases`, {method: "POST", headers: ghHeaders(), body: JSON.stringify({
    tag_name: "visuels", name: "Visuels de Cadence", prerelease: true,
    body: "Les grosses vidéos en attente de publication. Le robot les supprime une fois le post confirmé en ligne.",
  })});
  return (release = body);
}

/** Dépose un fichier dans la release « visuels » et renvoie {id, url}. Un fichier du même nom est remplacé. */
async function uploadAsset(name, bytes, type) {
  const rel = await mediaRelease();
  const send = () => fetch(`https://uploads.github.com/repos/${env.GITHUB_REPOSITORY}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
    {method: "POST", headers: {...ghHeaders(), "Content-Type": type, "Content-Length": String(bytes.length)}, body: bytes});
  let res = await send();
  if (res.status === 422) {   // déjà là, d'un essai interrompu : on le remplace
    const {body: assets} = await call(`${GH_API()}/releases/${rel.id}/assets?per_page=100`, {headers: ghHeaders()});
    const old = assets.find(a => a.name === name);
    if (old) await deleteAsset(old.id);
    res = await send();
  }
  if (!res.ok) throw new Error(`GitHub a refusé le fichier (${res.status}) : ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return {id: body.id, url: body.browser_download_url};
}

async function deleteAsset(id) {
  const res = await fetch(`${GH_API()}/releases/assets/${id}`, {method: "DELETE", headers: ghHeaders()});
  if (!res.ok && res.status !== 404) throw new Error(`GitHub a répondu ${res.status}`);
}

/** Recolle les grosses vidéos envoyées en morceaux, avant l'heure de publication. */
async function prepareMedia() {
  const files = (await readdir(POSTS_DIR).catch(() => [])).filter(f => f.endsWith(".json")).sort();
  for (const f of files) {
    const file = path.join(POSTS_DIR, f);
    const post = JSON.parse(await readFile(file, "utf8"));
    const todo = (post.media || []).filter(m => m.parts?.length && !m.asset);
    if (!todo.length || post.status === "published") continue;
    let changed = false;
    for (const m of todo) {
      if (DRY_RUN) { console.log(`Essai : recollerait ${m.parts.length} morceaux de ${m.path}`); continue; }
      try {
        const chunks = [];
        for (const p of m.parts) chunks.push(await download(rawUrl(p, m.ref)));
        const bytes = Buffer.concat(chunks);
        if (m.size && bytes.length !== m.size) throw new Error(`${bytes.length} octets recollés au lieu de ${m.size}`);
        m.asset = await uploadAsset(assetName(m.path), bytes, mimeOfPath(m.path));
        for (const p of m.parts) await deleteFromBranch(p, m.ref).catch(e => console.log(`Morceau ${p} gardé : ${e.message}`));
        delete m.parts;
        changed = true;
        console.log(`Vidéo recollée : ${m.path} (${Math.round(bytes.length / 1e6)} Mo)`);
      } catch (e) {
        console.log(`Vidéo de « ${firstLine(post.text, 50)} » pas encore recollée : ${e.message}`);
      }
    }
    if (changed) await writeFile(file, JSON.stringify(post, null, 2) + "\n");
  }
}

/* ------------------------------------------------------------------ */
/* Instagram : copie 1080p au-delà de 300 Mo                           */
/* ------------------------------------------------------------------ */

const exec = promisify(execFile);
const IG_MAX = globalThis.CadenceRules.RULES.instagram.video.maxBytes;

async function ensureFfmpeg() {
  try { await exec("ffmpeg", ["-version"]); }
  catch { await exec("sudo", ["apt-get", "update", "-qq"]); await exec("sudo", ["apt-get", "install", "-y", "-qq", "ffmpeg"]); }
}

/**
 * Instagram n'accepte pas plus de 300 Mo par ce moyen, et réduit de toute façon chaque vidéo en 1080p.
 * Pour une vidéo plus lourde (4K), on lui envoie une copie 1080p de haute qualité (H.264, CRF 18 au départ),
 * faite une seule fois et rangée à côté de l'originale. Les autres réseaux reçoivent l'originale.
 */
async function instagramCopy(video) {
  const m = video.source;
  if (m.igAsset) return m.igAsset.url;
  await ensureFfmpeg();
  const dir = await mkdtemp(path.join(os.tmpdir(), "cadence-"));
  const src = path.join(dir, "source"), out = path.join(dir, "instagram.mp4");
  try {
    await writeFile(src, await download(video.url));
    for (const crf of [18, 21, 24]) {
      await exec("ffmpeg", ["-y", "-loglevel", "error", "-i", src,
        "-vf", "scale=w='if(lt(iw,ih),min(1080,iw),-2)':h='if(lt(iw,ih),-2,min(1080,ih))'",
        "-c:v", "libx264", "-preset", "medium", "-crf", String(crf), "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-fpsmax", "60", "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-movflags", "+faststart", out],
        {maxBuffer: 1e7, timeout: 30 * 60_000});
      const size = (await stat(out)).size;
      if (size <= IG_MAX) {
        m.igAsset = await uploadAsset(assetName(m.path, "-instagram.mp4"), await readFile(out), "video/mp4");
        return m.igAsset.url;
      }
    }
    throw new Error("même en 1080p, la vidéo dépasse 300 Mo : raccourcis-la pour Instagram.");
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

/** Télécharge un visuel de la branche des visuels, tel quel. */
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`visuel introuvable (${res.status}) : ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

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
      if (m.video) params = {media_type: "REELS", caption,
        video_url: m.video.size > IG_MAX ? await instagramCopy(m.video) : m.video.url};
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
      // Le fichier d'origine, octet pour octet : rien n'est réencodé avant YouTube.
      const bytes = m.video.ref ? await download(m.video.url) : await readFile(m.video.path);
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
    async publish(post, m) {
      const {title, text: marked} = compose(post, "linkedin", Boolean(m.video));
      const {text, untagged} = await resolveMentions(marked);
      if (untagged.length) post.untagged = untagged;
      // Le PDF fourni pour LinkedIn passe avant les autres visuels : c'est le format carrousel de LinkedIn.
      if (m.document) {
        return zernioPost("linkedin", "ZERNIO_LINKEDIN_ID", text,
          [{url: m.document.url, type: "document", title}], {}, {documentTitle: title});
      }
      return zernioPost("linkedin", "ZERNIO_LINKEDIN_ID", text, zernioVisuals(m));
    },
  },
};

/* ------------------------------------------------------------------ */
/* Identifications LinkedIn                                            */
/* ------------------------------------------------------------------ */
//
// Cadence écrit chaque identification @[Nom](lien du profil ou de la page). Avant de publier, le robot
// demande à LinkedIn, via Zernio, à qui correspond chaque lien, et envoie @[Nom officiel](urn:li:…),
// que Zernio publie tel quel. Un lien introuvable devient le nom en texte simple : le post part
// quand même, et jamais avec du code visible.

const MENTION_MARK = /@\[([^\]]+)\]\((https?:[^)\s]+)\)/g;

/** {ok, urn, type, name, guessed} ou {ok: false, error}. */
async function resolveMention(url) {
  need("ZERNIO_API_KEY", "ZERNIO_LINKEDIN_ID");
  const res = await fetch(`${ZERNIO}/accounts/${encodeURIComponent(env.ZERNIO_LINKEDIN_ID)}/linkedin-mentions?url=${encodeURIComponent(url)}`,
    {headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`}});
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) return {ok: false, error: "Zernio doit être reconnecté à LinkedIn"};
  if (!res.ok || !body.urn) return {ok: false, error: `LinkedIn ne trouve pas ce profil ou cette page (${res.status})`};
  // Pour une personne, un « warning » signifie que LinkedIn n'a pas donné son vrai nom : on garde celui que tu as écrit.
  return {ok: true, urn: body.urn, type: body.type, name: String(body.displayName || "").replace(/[[\]]/g, ""), guessed: Boolean(body.warning)};
}

/** Le nom que LinkedIn affichera : le nom officiel, sauf pour une personne dont LinkedIn n'a pas donné le nom. */
const shownName = (typed, r) => (r.ok && r.name && !(r.type === "person" && r.guessed)) ? r.name : typed;

async function resolveMentions(text) {
  const untagged = [];
  let out = text;
  for (const [mark, typed, url] of [...text.matchAll(MENTION_MARK)]) {
    const r = await resolveMention(url).catch(e => ({ok: false, error: e.message}));
    if (!r.ok) untagged.push(typed);
    out = out.replace(mark, r.ok ? `@[${shownName(typed, r)}](${r.urn})` : typed);
  }
  return {text: out, untagged};
}

/**
 * Vérifie à l'avance les identifications des posts à venir : Cadence affiche, pour chaque lien,
 * le nom que LinkedIn montrera, ou le problème. Refait seulement quand les identifications changent.
 */
async function checkMentions() {
  if (!env.ZERNIO_API_KEY || !env.ZERNIO_LINKEDIN_ID) return;
  const files = (await readdir(POSTS_DIR).catch(() => [])).filter(f => f.endsWith(".json")).sort();
  for (const f of files) {
    const file = path.join(POSTS_DIR, f);
    const post = JSON.parse(await readFile(file, "utf8"));
    const list = (post.mentions || []).filter(m => m.name && m.url);
    if (post.status === "published" || !(post.platforms || []).includes("linkedin") || !list.length) continue;
    const key = JSON.stringify(list.map(m => [m.name, linkedinUrl(m.url)]));
    if (post.mentionCheck?.key === key) continue;
    const items = [];
    for (const m of list) {
      const url = linkedinUrl(m.url);
      const r = await resolveMention(url).catch(e => ({ok: false, error: e.message}));
      items.push(r.ok ? {url, ok: true, type: r.type, shown: shownName(m.name, r)} : {url, ok: false, error: r.error});
    }
    post.mentionCheck = {key, at: NOW.toISOString(), items};
    if (!DRY_RUN) await writeFile(file, JSON.stringify(post, null, 2) + "\n");
    console.log(`Identifications de « ${firstLine(post.text, 50)} » : ${items.map(i => i.ok ? `✓ ${i.shown}` : `✗ ${i.url}`).join(", ")}`);
  }
}

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

    if ((post.media || []).some(m => m.parts?.length && !m.asset)) {
      report.push(`- ⏳ « ${label} » : la vidéo n'est pas encore recollée, il partira au prochain passage`);
      continue;
    }

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
                     post.untagged?.length && `LinkedIn : ${post.untagged.join(", ")} écrit${post.untagged.length > 1 ? "s" : ""} sans identification (lien introuvable)`,
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
 * Avant de supprimer les visuels, on redemande à chaque réseau si le post est bien en ligne :
 *   "ok"      en ligne, le réseau a sa propre copie
 *   "pending" encore en traitement chez le réseau : on garde tout et on redemande au prochain passage
 *   sinon     le message d'erreur du réseau : le post repasse en échec, visuels gardés
 */
function zernioConfirm(platform) {
  return async r => {
    if (!r.id) return "ok";
    const {body} = await call(`${ZERNIO}/posts/${encodeURIComponent(r.id)}`,
      {headers: {Authorization: `Bearer ${env.ZERNIO_API_KEY}`}});
    const p = (body.post || body).platforms?.find(x => x.platform === platform);
    if (!p || p.status === "published") return "ok";
    if (p.status === "failed" || p.status === "cancelled") return p.errorMessage || "Zernio signale un échec.";
    return "pending";
  };
}

const CONFIRM = {
  // Instagram : publié seulement une fois le média traité (voir waitInstagram).
  instagram: async () => "ok",
  // Facebook : les photos sont en ligne tout de suite, une vidéo est traitée après coup.
  async facebook(r, post) {
    if (!post.media.some(m => m.type === "video")) return "ok";
    const {body} = await call(`${GRAPH}/${r.id}?fields=status&access_token=${encodeURIComponent(env.META_PAGE_TOKEN)}`);
    const s = body.status?.video_status;
    return s === "ready" ? "ok" : s === "error" ? "Facebook n'a pas pu traiter la vidéo." : "pending";
  },
  async youtube(r) {
    const token = await googleAccessToken();
    const {body} = await call(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(r.id)}`,
      {headers: {Authorization: `Bearer ${token}`}});
    const s = body.items?.[0]?.status;
    if (!s || s.uploadStatus === "processed") return "ok";   // absente : retirée de la chaîne depuis
    if (s.uploadStatus === "uploaded") return "pending";
    return `YouTube a refusé la vidéo (${s.failureReason || s.rejectionReason || s.uploadStatus}).`;
  },
  tiktok: zernioConfirm("tiktok"),
  linkedin: zernioConfirm("linkedin"),
};

/** Ce que dit chaque réseau du post : {errors, pending}. Un réseau injoignable compte comme « en attente ». */
async function confirmOnline(post) {
  const errors = [], pending = [];
  for (const [net, r] of Object.entries(post.results || {})) {
    if (!r?.ok || MANUAL.has(net)) continue;
    let state;
    try { state = await (CONFIRM[net] || (async () => "ok"))(r, post); }
    catch (e) { state = "pending"; console.log(`${NAMES[net] || net} injoignable pour l'instant : ${e.message}`); }
    if (state === "pending") pending.push(net);
    else if (state !== "ok") errors.push([net, state]);
  }
  return {errors, pending};
}

/**
 * Les visuels d'un post publié depuis plus de KEEP_MEDIA_HOURS sont supprimés, une fois que chaque
 * réseau a confirmé que le post est en ligne : il a gardé sa propre copie. Rien n'est supprimé
 * tant que X reste à poster à la main, ni pour un post en brouillon, programmé ou en échec.
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
    const label = firstLine(post.text, 50);
    const {errors, pending} = await confirmOnline(post);
    if (errors.length) {
      // Publié en apparence, refusé ensuite par le réseau : on le signale et on garde les visuels.
      for (const [net, msg] of errors) post.results[net] = {ok: false, error: msg, at: NOW.toISOString()};
      post.status = "failed";
      post.error = errors.map(([net, msg]) => `${NAMES[net] || net} : ${msg}`).join("\n");
      if (!DRY_RUN) await writeFile(file, JSON.stringify(post, null, 2) + "\n");
      console.log(`« ${label} » : refusé après coup par ${errors.map(([n]) => NAMES[n] || n).join(", ")}, visuels gardés.`);
      process.exitCode = 1;
      continue;
    }
    if (pending.length) {
      console.log(`« ${label} » : ${pending.map(n => NAMES[n] || n).join(", ")} n'a pas encore confirmé, visuels gardés.`);
      continue;
    }
    if (DRY_RUN) { console.log(`Essai : supprimerait ${post.media.length} visuel(s) de « ${label} »`); continue; }
    try {
      for (const m of post.media) {
        if (m.asset) await deleteAsset(m.asset.id);
        if (m.igAsset) await deleteAsset(m.igAsset.id);
        for (const p of m.parts || []) await deleteFromBranch(p, m.ref);
        if (m.asset || m.parts) continue;
        if (m.ref) await deleteFromBranch(m.path, m.ref);
        else await rm(m.path, {force: true});
      }
    } catch (e) {
      console.log(`Visuels de « ${label} » gardés pour l'instant : ${e.message}`);
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
  await prepareMedia();
  await checkMentions().catch(e => console.log(`Vérification des identifications reportée : ${e.message}`));
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
