/* Cadence — les règles de chaque réseau.
 *
 * Un seul fichier, lu par l'interface (index.html) et par le robot
 * (robot/publish.mjs). Quand un réseau change ses limites, c'est ici
 * qu'on les met à jour, et les deux en tiennent compte.
 *
 * check(post) renvoie la liste des points à signaler, réseau par réseau :
 *   {net, level, msg}  level = "error" (bloque la publication), "warn" ou "info"
 * Les messages ne nomment pas le réseau : l'affichage s'en charge.
 *
 * À chaque modification de ce fichier, augmente VERSION ici ET dans index.html
 * (balise <script src="rules.js?v=…"> et RULES_VERSION) : le navigateur garde
 * les fichiers en mémoire 10 minutes, et une page récente ne doit jamais
 * tourner avec un ancien rules.js.
 */
(function (root) {
  "use strict";

  const MB = 1e6;
  const GITHUB_MAX = 95 * MB;   // GitHub refuse les fichiers de plus de 100 Mo

  const MP4 = "video/mp4", MOV = "video/quicktime", WEBM = "video/webm";
  const JPEG = "image/jpeg", PNG = "image/png", GIF = "image/gif", WEBP = "image/webp";

  const RULES = {
    instagram: {
      name: "Instagram", text: 2200, hashtags: 30, mentions: 20, needs: "visual",
      image: {mimes: [JPEG], maxBytes: 8 * MB, ratio: [0.8, 1.91], ratioLabel: "4:5 et 1,91:1", max: 10},
      video: {mimes: [MP4, MOV], maxBytes: 300 * MB, minSec: 3, maxSec: 15 * 60},
    },
    facebook: {
      name: "Facebook", text: 63206,
      image: {mimes: [JPEG, PNG], maxBytes: 10 * MB},
      video: {mimes: [MP4, MOV], maxBytes: 1000 * MB, maxSec: 20 * 60},
    },
    tiktok: {
      name: "TikTok", text: 2200, photoText: 4000, needs: "visual",
      image: {mimes: [JPEG, PNG, WEBP], maxBytes: 20 * MB, max: 35},
      video: {mimes: [MP4, MOV, WEBM], maxBytes: 4000 * MB, minSec: 3, maxSec: 10 * 60, vertical: true},
    },
    youtube: {
      name: "YouTube", titleMax: 100, descMax: 5000, needs: "video",
      video: {mimes: [MP4, MOV], maxSec: 15 * 60, shortSec: 3 * 60},
    },
    linkedin: {
      name: "LinkedIn", text: 3000,
      image: {mimes: [JPEG, PNG, GIF], maxBytes: 8 * MB, max: 20},
      video: {mimes: [MP4, MOV], maxBytes: 5000 * MB, minSec: 3, maxSec: 30 * 60},
      document: {mimes: ["application/pdf"], maxBytes: 100 * MB},
    },
    x: {name: "X", text: 280},
  };

  const EXT = {jpg: JPEG, jpeg: JPEG, png: PNG, gif: GIF, webp: WEBP,
               mp4: MP4, m4v: MP4, mov: MOV, webm: WEBM, pdf: "application/pdf"};

  /** Type de fichier, déduit de l'extension quand il n'a pas été enregistré. */
  function mimeOf(m) {
    if (m.mime) return m.mime;
    const ext = String(m.path || m.name || "").split(".").pop().toLowerCase();
    return EXT[ext] || "";
  }

  const label = mime => ({[JPEG]: "JPEG", [PNG]: "PNG", [GIF]: "GIF", [WEBP]: "WebP", [MP4]: "MP4",
    [MOV]: "MOV", [WEBM]: "WebM", "application/pdf": "PDF"}[mime] || mime || "inconnu");
  const mo = b => `${Math.round(b / MB)} Mo`;
  const dur = s => s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${Math.round(s % 60)} s` : ""}` : `${Math.round(s)} s`;

  /**
   * Musique d'un post TikTok :
   *   draft : arrive en brouillon dans l'app TikTok, on y choisit le son puis on publie
   *   music : son choisi dans Cadence parmi les tendances, publication automatique
   *   auto  : TikTok choisit le son (carrousel photo seulement)
   *   none  : aucun son ajouté (une vidéo garde le sien)
   * Par défaut : brouillon pour un carrousel photo, son d'origine pour une vidéo.
   */
  function tiktokMode(post, hasVideo) {
    const mode = post.tiktok?.mode;
    if (mode === "auto" && hasVideo) return "none";
    return mode || (hasVideo ? "none" : "draft");
  }

  function split(media) {
    const items = (media || []).map(m => ({...m, mime: mimeOf(m)}));
    return {
      video: items.find(m => m.type === "video") || null,
      images: items.filter(m => m.type === "image"),
      document: items.find(m => m.type === "document") || null,
      all: items,
    };
  }

  function check(post) {
    const issues = [];
    const add = (net, level, msg, code) => issues.push({net, level, msg, code});
    const text = String(post.text || "");
    const {video, images, document, all} = split(post.media);

    for (const net of post.platforms || []) {
      const r = RULES[net];
      if (!r) continue;

      // Texte
      if (r.text && text.length > r.text)
        add(net, "error", `${text.length} caractères : le maximum est ${r.text.toLocaleString("fr-FR")}.`);
      if (r.hashtags) {
        const n = (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;
        if (n > r.hashtags) add(net, "error", `${n} hashtags : le maximum est ${r.hashtags}.`);
      }
      if (r.mentions) {
        const n = (text.match(/(^|\s)@[\w.]+/g) || []).length;
        if (n > r.mentions) add(net, "error", `${n} mentions : le maximum est ${r.mentions}.`);
      }

      // Visuel obligatoire
      if (r.needs === "visual" && !video && !images.length)
        add(net, "error", "Il faut une vidéo ou au moins une image.", "needs");
      if (r.needs === "video" && !video)
        add(net, "error", "Il faut une vidéo.", "needs");

      // Vidéo
      if (video && r.video) {
        const v = r.video;
        if (video.mime && !v.mimes.includes(video.mime))
          add(net, "error", `Vidéo au format ${label(video.mime)} : formats acceptés ${v.mimes.map(label).join(", ")}.`);
        if (v.maxBytes && video.size > v.maxBytes)
          add(net, "error", `Vidéo de ${mo(video.size)} : le maximum est ${mo(v.maxBytes)}.`);
        if (v.minSec && video.duration && video.duration < v.minSec)
          add(net, "error", `Vidéo de ${dur(video.duration)} : il faut au moins ${dur(v.minSec)}.`);
        if (v.maxSec && video.duration > v.maxSec)
          add(net, "error", net === "youtube"
            ? `Vidéo de ${dur(video.duration)} : au-delà de 15 min, ta chaîne doit être vérifiée par téléphone (youtube.com/verify).`
            : `Vidéo de ${dur(video.duration)} : le maximum est ${dur(v.maxSec)}.`);
        if (net === "youtube" && video.duration && video.width && video.height) {
          const shortable = video.duration <= v.shortSec && video.height >= video.width;
          add(net, "info", shortable ? "Sera publiée en Short (verticale, 3 min au plus)."
                                     : "Sera publiée en vidéo classique, pas en Short.");
        }
        if (v.vertical && video.width > video.height)
          add(net, "warn", "Vidéo horizontale : elle s'affichera avec des bandes. Le format vertical 9:16 est conseillé.");
      }

      // Images : servent quand il n'y a pas de vidéo (et, pour LinkedIn, pas de PDF)
      const usesImages = !video && images.length && !(net === "linkedin" && document);
      if (usesImages && r.image) {
        const im = r.image;
        if (im.max && images.length > im.max)
          add(net, "error", `${images.length} images : le maximum est ${im.max} par carrousel.`);
        images.forEach((m, i) => {
          const n = images.length > 1 ? `L'image n°${i + 1}` : "L'image";
          if (m.mime && !im.mimes.includes(m.mime))
            add(net, "error", `${n} est en ${label(m.mime)} : formats acceptés ${im.mimes.map(label).join(", ")}.`);
          if (im.maxBytes && m.size > im.maxBytes)
            add(net, "error", `${n} pèse ${mo(m.size)} : le maximum est ${mo(im.maxBytes)}.`);
          if (im.ratio && m.width && m.height) {
            const ratio = m.width / m.height;
            if (ratio < im.ratio[0] - 0.01 || ratio > im.ratio[1] + 0.01)
              add(net, "error", `${n} est trop ${ratio < im.ratio[0] ? "haute" : "large"} : les proportions doivent rester entre ${im.ratioLabel}. Recadre-la, par exemple en 4:5.`);
          }
        });
        if (net === "tiktok" && text.length > r.photoText)
          add(net, "error", `${text.length} caractères : le maximum est ${r.photoText} pour un carrousel photo.`);
      }

      // PDF LinkedIn
      if (net === "linkedin" && document) {
        const d = r.document;
        if (document.mime && !d.mimes.includes(document.mime))
          add(net, "error", "Le document doit être un PDF.");
        if (document.size > d.maxBytes)
          add(net, "error", `PDF de ${mo(document.size)} : le maximum est ${mo(d.maxBytes)}.`);
        if (!video && images.length) add(net, "info", "Publiera le PDF en carrousel, pas les images.");
      }

      // TikTok : la musique choisie
      if (net === "tiktok" && (video || images.length)) {
        const mode = tiktokMode(post, Boolean(video));
        if (mode === "music" && !post.tiktok?.music?.id)
          add(net, "error", "Choisis un son dans la liste, ou une autre option de musique.");
        if (mode === "draft")
          add(net, "info", "Arrivera en brouillon dans ton app TikTok : tu y choisis le son, puis tu publies.");
      }

      // YouTube : titre et description
      if (net === "youtube") {
        const title = (text.split("\n").find(l => l.trim()) || "").trim();
        if (title.length > r.titleMax)
          add(net, "warn", `Titre de ${title.length} caractères : il sera coupé à ${r.titleMax}.`);
        if (/[<>]/.test(text)) add(net, "warn", "Les signes < et > seront retirés : YouTube les refuse.");
        if (text.length > r.descMax) add(net, "warn", `Description coupée à ${r.descMax} caractères.`);
      }
    }

    // Limite de GitHub, commune à tous les réseaux
    for (const m of all) {
      if (m.size > GITHUB_MAX)
        add("github", "error", `${String(m.path || m.name || "Un fichier").split("/").pop()} pèse ${mo(m.size)} : GitHub refuse les fichiers de plus de 100 Mo.`);
    }
    return issues;
  }

  const VERSION = 4;
  const api = {VERSION, RULES, check, mimeOf, tiktokMode};
  root.CadenceRules = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
