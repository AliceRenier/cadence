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
  // Les grosses vidéos partent en morceaux puis sont recollées dans une release GitHub : 2 Go par fichier.
  const GITHUB_MAX = 2000 * MB;

  const MP4 = "video/mp4", MOV = "video/quicktime", WEBM = "video/webm";
  const JPEG = "image/jpeg", PNG = "image/png", GIF = "image/gif", WEBP = "image/webp";

  const RULES = {
    instagram: {
      name: "Instagram", text: 2200, hashtags: 30, mentions: 20, needs: "visual",
      image: {mimes: [JPEG], maxBytes: 8 * MB, ratio: [0.8, 1.91], ratioLabel: "4:5 et 1,91:1", max: 10},
      // Au-delà de 300 Mo, le robot envoie à Instagram une copie 1080p (copyAbove) : il la réduit de toute façon en 1080p.
      video: {mimes: [MP4, MOV], maxBytes: 300 * MB, copyAbove: true, minSec: 3, maxSec: 15 * 60},
    },
    facebook: {
      name: "Facebook", text: 63206,
      image: {mimes: [JPEG, PNG], maxBytes: 10 * MB},
      video: {mimes: [MP4, MOV], maxBytes: 1000 * MB, maxSec: 20 * 60},
    },
    tiktok: {
      name: "TikTok", text: 2200, photoText: 4000, photoTitle: 90, hashtags: 5, needs: "visual",
      image: {mimes: [JPEG, PNG, WEBP], maxBytes: 20 * MB, max: 35},
      video: {mimes: [MP4, MOV, WEBM], maxBytes: 4000 * MB, minSec: 3, maxSec: 10 * 60, vertical: true},
    },
    youtube: {
      name: "YouTube", titleMax: 100, descMax: 5000, hashtags: 15, needs: "video",
      video: {mimes: [MP4, MOV], maxSec: 15 * 60, shortSec: 3 * 60},
    },
    linkedin: {
      name: "LinkedIn", text: 3000, hashtagsAdvised: 5,
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

  const TAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
  const countTags = s => (String(s).match(TAG) || []).length;
  const stripTags = s => String(s).replace(TAG, " ").replace(/\s+/g, " ").trim();
  const firstLineOf = s => (String(s || "").split("\n").find(l => l.trim()) || "").trim();

  /** Les hashtags saisis à part : « atelier, #conseils diy » → ["#atelier", "#conseils", "#diy"]. */
  function parseTags(s) {
    const tags = String(s || "").split(/[\s,;]+/).map(t => t.replace(/^#+/, "").trim()).filter(Boolean);
    return [...new Set(tags.map(t => "#" + t))];
  }

  /**
   * Identifications LinkedIn : [{name, url}], le nom tel qu'il est écrit dans le texte et le lien
   * du profil ou de la page. Zernio transforme @[Nom](lien) en vraie identification LinkedIn ;
   * 10 au plus par post. Le nom doit être celui de LinkedIn (prénom, nom, nom complet, ou nom exact
   * de la page, majuscules comprises), sinon LinkedIn affiche son nom officiel.
   */
  const LINKEDIN_URL = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|company|school|showcase)\/[^/?#\s]+\/?$/i;
  const MENTIONS_MAX = 10;
  const cleanLinkedin = url => {
    let u = String(url || "").trim().split(/[?#]/)[0];
    u = /^https?:\/\//i.test(u) ? u : "https://" + u.replace(/^\/+/, "");
    // Lien copié depuis un onglet de la page (…/company/le-crayon/home/) : on garde l'adresse de la page.
    const page = /^(https?:\/\/[^/]+\/(?:in|company|school|showcase)\/[^/]+)/i.exec(u);
    if (page) u = page[1] + "/";
    // Un lien copié depuis Safari peut garder ses accents (« moullé ») : on l'écrit comme LinkedIn (moull%C3%A9).
    try { return encodeURI(decodeURI(u)); } catch (_) { return u; }
  };
  const mentionsOf = post => (post.mentions || [])
    .map(m => ({name: String(m.name || "").trim(), url: cleanLinkedin(m.url)}))
    .filter(m => m.name && m.url !== "https://");

  /** La première fois que chaque nom apparaît, il devient une identification ; un @ tapé devant est repris. */
  function withMentions(body, mentions) {
    const done = [];
    for (const m of [...mentions].sort((a, b) => b.name.length - a.name.length)) {
      if (!LINKEDIN_URL.test(m.url) || /[[\]()]/.test(m.name)) continue;
      let i = body.indexOf(m.name);
      // Pas à l'intérieur d'une identification déjà posée (« Crayon » dans « Le Crayon »).
      while (i >= 0 && done.some(([a, b]) => i >= a && i < b)) i = body.indexOf(m.name, i + 1);
      if (i < 0) continue;
      const start = body[i - 1] === "@" ? i - 1 : i;
      const mark = `@[${m.name}](${m.url})`;
      body = body.slice(0, start) + mark + body.slice(i + m.name.length);
      const shift = mark.length - (i + m.name.length - start);
      for (const d of done) if (d[0] > start) { d[0] += shift; d[1] += shift; }
      done.push([start, start + mark.length]);
    }
    return body;
  }

  /**
   * Ce que reçoit chaque réseau à partir du titre, du texte et des hashtags.
   *   text  : le texte publié, hashtags à la fin
   *   title : YouTube (sans hashtags, 100 caractères), carrousel TikTok (90),
   *           PDF LinkedIn (titre du document). Sans titre saisi : la première ligne du texte,
   *           sauf pour TikTok, qui affiche le titre juste au-dessus du texte : il faut le saisir,
   *           sinon le début du texte apparaîtrait deux fois.
   */
  function compose(post, net, hasVideo) {
    const body = String(post.text || "").trim();
    const tagLine = parseTags(post.hashtags).join(" ");
    // Ailleurs, le nom reste en texte simple, sans le @ : sur Instagram ou X, il viserait un autre compte.
    const shown = net === "linkedin" ? withMentions(body, mentionsOf(post))
      : mentionsOf(post).reduce((t, m) => t.split("@" + m.name).join(m.name), body);
    const text = [shown, tagLine].filter(Boolean).join("\n\n");
    const rawTitle = String(post.title || "").trim() || firstLineOf(body);
    if (net === "youtube") return {
      title: stripTags(rawTitle).replace(/[<>]/g, "").slice(0, 100) || "Nouvelle vidéo",
      text: text.replace(/[<>]/g, "").slice(0, 5000),
    };
    if (net === "tiktok" && !hasVideo) return {title: stripTags(post.title || "").slice(0, 90), text};
    if (net === "linkedin") return {title: stripTags(rawTitle).slice(0, 100) || "Document", text};
    return {text};
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
    const {video, images, document, all} = split(post.media);
    const rawTitle = String(post.title || "").trim() || firstLineOf(post.text);

    // Hashtags saisis à part : un caractère interdit couperait le hashtag sur tous les réseaux
    for (const tag of parseTags(post.hashtags)) {
      if (!/^#[\p{L}\p{N}_]+$/u.test(tag))
        add("texte", "error", `Le hashtag « ${tag} » contient un caractère interdit : lettres, chiffres et _ seulement.`);
    }

    for (const net of post.platforms || []) {
      const r = RULES[net];
      if (!r) continue;
      const photoPost = net === "tiktok" && !video && images.length;
      const text = compose(post, net, Boolean(video)).text;

      // Texte, hashtags compris
      const max = photoPost ? r.photoText : r.text;
      if (max && text.length > max)
        add(net, "error", `${text.length} caractères avec les hashtags : le maximum est ${max.toLocaleString("fr-FR")}.`);
      if (r.hashtags && countTags(text) > r.hashtags)
        add(net, "error", net === "youtube"
          ? `${countTags(text)} hashtags : au-delà de ${r.hashtags}, YouTube les ignore tous. Garde-en ${r.hashtags} au plus.`
          : `${countTags(text)} hashtags : le maximum est ${r.hashtags}.`);
      if (r.hashtagsAdvised && countTags(text) > r.hashtagsAdvised)
        add(net, "info", `${countTags(text)} hashtags : ${r.name} conseille d'en mettre ${r.hashtagsAdvised} au plus.`);
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
          add(net, v.copyAbove ? "info" : "error", v.copyAbove
            ? `Vidéo de ${mo(video.size)} : ${r.name} n'en accepte que ${mo(v.maxBytes)} par ce moyen. Le robot lui enverra une copie 1080p de haute qualité ; ${r.name} réduit de toute façon chaque vidéo en 1080p. Les autres réseaux reçoivent l'originale.`
            : `Vidéo de ${mo(video.size)} : le maximum est ${mo(v.maxBytes)}.`);
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

      // LinkedIn : les identifications
      if (net === "linkedin") {
        const list = (post.mentions || []).filter(m => String(m.name || "").trim() || String(m.url || "").trim());
        if (list.length > MENTIONS_MAX) add(net, "error", `${list.length} identifications : LinkedIn en accepte ${MENTIONS_MAX} au plus par post.`);
        for (const m of list) {
          const name = String(m.name || "").trim(), url = cleanLinkedin(m.url);
          const who = name ? `« ${name} »` : "Une identification";
          if (!name) add(net, "error", `${who} n'a pas de nom : écris le nom tel qu'il apparaît dans le texte.`);
          else if (/[[\]()]/.test(name)) add(net, "error", `${who} : le nom ne doit contenir ni crochets ni parenthèses.`);
          else if (!String(post.text || "").includes(name))
            add(net, "warn", `${who} n'apparaît pas dans le texte, majuscules comprises : écris-le tel quel pour qu'il soit identifié.`);
          if (!String(m.url || "").trim()) add(net, "error", `${who} n'a pas de lien : colle le lien de son profil ou de sa page LinkedIn.`);
          else if (!LINKEDIN_URL.test(url))
            add(net, "error", `${who} : le lien doit être celui d'un profil (linkedin.com/in/…) ou d'une page (linkedin.com/company/…).`);
        }
      }

      // TikTok : la musique choisie
      if (net === "tiktok" && (video || images.length)) {
        const mode = tiktokMode(post, Boolean(video));
        if (mode === "music" && !post.tiktok?.music?.id)
          add(net, "error", "Choisis un son dans la liste, ou une autre option de musique.");
        if (mode === "draft")
          add(net, "info", "Arrivera en brouillon dans ton app TikTok : tu y choisis le son, puis tu publies.");
      }

      // Titres : YouTube, carrousel TikTok, PDF LinkedIn
      const titleMax = net === "youtube" ? r.titleMax : photoPost ? r.photoTitle : (net === "linkedin" && document) ? 100 : 0;
      if (titleMax && photoPost) {
        const title = stripTags(post.title || "");
        const start = stripTags(firstLineOf(post.text)).toLowerCase();
        if (!title) add(net, "error", "Ajoute un titre : TikTok l'affiche en gras, juste au-dessus du texte.");
        else if (start.startsWith(title.toLowerCase().slice(0, 30)))
          add(net, "warn", "Le texte commence comme le titre : TikTok l'affichera deux fois. Commence le texte par autre chose.");
        if (title.length > titleMax) add(net, "warn", `Titre de ${title.length} caractères : il sera coupé à ${titleMax}.`);
        if (countTags(post.title || "")) add(net, "info", "Les hashtags du titre en sont retirés : mets-les dans le champ Hashtags.");
      } else if (titleMax) {
        const title = stripTags(rawTitle);
        if (!title) add(net, "warn", "Pas de titre : ajoute un titre, ou une première ligne au texte.");
        else if (title.length > titleMax) add(net, "warn", `Titre de ${title.length} caractères : il sera coupé à ${titleMax}.`);
        if (countTags(rawTitle)) add(net, "info", "Les hashtags du titre en sont retirés ; ceux du champ Hashtags vont dans la description.");
      }
      if (net === "youtube") {
        if (/[<>]/.test(rawTitle + (post.text || ""))) add(net, "warn", "Les signes < et > seront retirés : YouTube les refuse.");
        if (text.length > r.descMax) add(net, "warn", `Description coupée à ${r.descMax} caractères.`);
      }
    }

    // Limite de GitHub, commune à tous les réseaux
    for (const m of all) {
      if (m.size > GITHUB_MAX)
        add("github", "error", `${String(m.path || m.name || "Un fichier").split("/").pop()} pèse ${mo(m.size)} : Cadence accepte 2 Go par fichier.`);
    }
    return issues;
  }

  const VERSION = 10;
  const api = {VERSION, RULES, check, compose, parseTags, mimeOf, tiktokMode};
  root.CadenceRules = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
