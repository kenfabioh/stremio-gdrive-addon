// ISO 639-2/B codes expected by Stremio. Region/SDH/forced remain in labels.
const languages = {
  pt: "por",
  por: "por",
  pob: "por",
  portuguese: "por",
  en: "eng",
  eng: "eng",
  english: "eng",
  es: "spa",
  spa: "spa",
  fr: "fre",
  fra: "fre",
  fre: "fre",
  de: "ger",
  deu: "ger",
  ger: "ger",
  it: "ita",
  ita: "ita",
  ja: "jpn",
  jpn: "jpn",
  ko: "kor",
  kor: "kor",
  zh: "chi",
  zho: "chi",
  chi: "chi",
  ru: "rus",
  rus: "rus",
  ar: "ara",
  ara: "ara",
  hi: "hin",
  hin: "hin",
  nl: "dut",
  nld: "dut",
  dut: "dut",
  tr: "tur",
  tur: "tur",
  pl: "pol",
  pol: "pol",
  uk: "ukr",
  ukr: "ukr",
  sv: "swe",
  swe: "swe",
  no: "nor",
  nor: "nor",
  da: "dan",
  dan: "dan",
  fi: "fin",
  fin: "fin",
  he: "heb",
  heb: "heb",
  el: "gre",
  ell: "gre",
  gre: "gre",
  cs: "cze",
  ces: "cze",
  cze: "cze",
  ro: "rum",
  ron: "rum",
  rum: "rum",
  hu: "hun",
  hun: "hun",
  th: "tha",
  tha: "tha",
  vi: "vie",
  vie: "vie",
  id: "ind",
  ind: "ind",
  fa: "per",
  fas: "per",
  per: "per",
};
const normalize = (s) => s.normalize("NFC").toLowerCase();
export function matchSubtitle(videoName, subtitleName) {
  if (!/\.srt$/i.test(subtitleName)) return null;
  const base = normalize(videoName.replace(/\.[^.]+$/, ""));
  const sub = normalize(subtitleName.slice(0, -4));
  if (sub === base) return { lang: "und", label: subtitleName };
  // Do not match other cuts, releases, or episodes by a loose title prefix.
  if (!sub.startsWith(base + ".")) return null;
  const suffix = sub.slice(base.length + 1);
  const match =
    /^([a-z]{2,3})(?:-([a-z]{2}|\d{3}))?(?:[._-](?:forced|sdh|cc|hi))*$/.exec(
      suffix,
    );
  if (!match || !languages[match[1]]) return null;
  return { lang: languages[match[1]], label: subtitleName };
}

// Bounded, expiring, single-flight caches. Failed loads are never cached.
export class TimedCache {
  constructor(ttl = 300_000, limit = 100, now = Date.now) {
    this.ttl = ttl;
    this.limit = limit;
    this.now = now;
    this.items = new Map();
  }
  async get(key, load) {
    const old = this.items.get(key);
    if (old && old.expires > this.now()) return old.value;
    const entry = { expires: this.now() + this.ttl };
    entry.value = Promise.resolve()
      .then(load)
      .catch((error) => {
        if (this.items.get(key) === entry) this.items.delete(key);
        throw error;
      });
    this.items.delete(key);
    this.items.set(key, entry);
    while (this.items.size > this.limit)
      this.items.delete(this.items.keys().next().value);
    return entry.value;
  }
}

export function createSubtitleService({ getToken, getFile, isFolderAllowed }) {
  const folders = new TimedCache(300_000, 32);
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  async function listFolder(id) {
    return folders.get(id, async () => {
      const token = await getToken();
      if (!token) throw new Error("Google authentication unavailable");
      const url = new URL("https://content.googleapis.com/drive/v3/files");
      url.search = new URLSearchParams({
        q: `'${escape(id)}' in parents and trashed=false and (name contains '.srt' or name contains '.SRT' or mimeType='application/x-subrip')`,
        corpora: "allDrives",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        pageSize: "1000",
        fields:
          "nextPageToken,incompleteSearch,files(id,name,parents,mimeType)",
      });
      const files = [];
      do {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("Subtitle list failed");
        const data = await response.json();
        if (data.incompleteSearch)
          throw new Error("Incomplete subtitle search");
        files.push(...(data.files || []));
        if (files.length > 2_000) throw new Error("Subtitle folder too large");
        if (!data.nextPageToken) break;
        url.searchParams.set("pageToken", data.nextPageToken);
      } while (true);
      return files;
    });
  }
  return {
    async forVideo(video, baseUrl) {
      if (!video.parents) video = await getFile(video.id);
      if (!video || !video.mimeType?.startsWith("video/")) return [];
      const parents = [];
      for (const id of video.parents || [])
        if (await isFolderAllowed(id)) parents.push(id);
      const seen = new Set();
      const result = [];
      for (const parent of parents) {
        for (const file of await listFolder(parent)) {
          if (!file.parents?.includes(parent) || seen.has(file.id)) continue;
          const matched = matchSubtitle(video.name, file.name);
          if (!matched) continue;
          seen.add(file.id);
          result.push({
            id: `gdrive:${file.id}`,
            lang: matched.lang,
            label: matched.label,
            url: `${baseUrl}/subtitle/${encodeURIComponent(file.id)}/subtitle.srt`,
          });
        }
      }
      return result;
    },
  };
}
