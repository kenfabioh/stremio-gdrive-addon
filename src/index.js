import { createDriveScope, parentQuery } from "./drive-scope.js";
import { createSubtitleService, TimedCache } from "./subtitles.js";

class DriveListError extends Error {
  constructor(code, upstreamStatus) {
    super("Google Drive listing unavailable");
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

export function createAddon(env) {
  const CREDENTIALS = {
    clientId: env.CLIENT_ID,
    clientSecret: env.CLIENT_SECRET,
    refreshToken: env.REFRESH_TOKEN,
  };

  const CONFIG = {
    resolutions: ["2160p", "1080p", "720p", "480p", "Unknown"],
    qualities: [
      "BluRay REMUX",
      "BluRay",
      "WEB-DL",
      "WEBRip",
      "HDRip",
      "HC HD-Rip",
      "DVDRip",
      "HDTV",
      "CAM",
      "TS",
      "TC",
      "SCR",
      "Unknown",
    ],
    visualTags: ["HDR10+", "HDR10", "HDR", "DV", "IMAX", "AI"],
    sortBy: ["resolution", "visualTag", "size", "quality"],
    showAudioFiles: false,
    considerHdrTagsAsEqual: true,
    addonName: "GDrive",
    prioritiseLanguage: null,
    strictTitleCheck: false,
    tmdbApiKey: env.TMDB_API_KEY || null,
    enableSearchCatalog: true,
    enableVideoCatalog: true,
    maxFilesToFetch: 1000,
    driveQueryTerms: {
      episodeFormat: "fullText",
      titleName: "name",
    },
    driveRecursive: env.DRIVE_RECURSIVE !== "false",
    driveFolderIds: (env.DRIVE_FOLDER_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  };

  const MANIFEST = {
    id: "stremio.gdrive.worker",
    version: "1.2.1",
    name: CONFIG.addonName,
    description: "Stream your files from Google Drive within Stremio!",
    catalogs: [],
    resources: [
      {
        name: "stream",
        types: ["movie", "series", "anime"],
      },
    ],
    types: ["movie", "series"],
  };

  const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Range,If-Range",
    "Access-Control-Expose-Headers":
      "Content-Length,Content-Range,Accept-Ranges",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Max-Age": "86400",
  };

  const API_ENDPOINTS = {
    DRIVE_FETCH_FILES: "https://content.googleapis.com/drive/v3/files",
    DRIVE_FETCH_FILE: "https://content.googleapis.com/drive/v3/files/{fileId}",
    DRIVE_STREAM_FILE:
      "https://www.googleapis.com/drive/v3/files/{fileId}?alt=media&file_name={filename}",
    DRIVE_TOKEN: "https://oauth2.googleapis.com/token",
    CINEMETA: "https://v3-cinemeta.strem.io/meta/{type}/{id}.json",
    IMDB_SUGGEST: "https://v3.sg.media-imdb.com/suggestion/a/{id}.json",
    TMDB_FIND:
      "https://api.themoviedb.org/3/find/{id}?api_key={apiKey}&external_source=imdb_id",
    TMDB_DETAILS: "https://api.themoviedb.org/3/{type}/{id}?api_key={apiKey}",
  };

  const REGEX_PATTERNS = {
    validStreamRequest:
      /^\/stream\/(movie|series|anime)\/([a-zA-Z0-9%:\-_]+)\.json$/,
    validPlaybackRequest: /^\/playback\/([a-zA-Z0-9_-]+)\/(.+)$/,
    validCatalogRequest:
      /^\/catalog\/movie\/([a-zA-Z0-9%:\-_]+)(\/search=(.+))?\.json$/,
    validMetaRequest: /^\/meta\/(movie)\/([a-zA-Z0-9%:\-_]+)\.json$/,
    resolutions: {
      "2160p": /(?<![^ [(_\-.])(4k|2160p|uhd)(?=[ \)\]_.-]|$)/i,
      "1080p": /(?<![^ [(_\-.])(1080p|fhd)(?=[ \)\]_.-]|$)/i,
      "720p": /(?<![^ [(_\-.])(720p|hd)(?=[ \)\]_.-]|$)/i,
      "480p": /(?<![^ [(_\-.])(480p|sd)(?=[ \)\]_.-]|$)/i,
    },
    qualities: {
      "BluRay REMUX":
        /(?<![^ [(_\-.])((blu[ .\-_]?ray|bd|br|b|uhd)[ .\-_]?remux)(?=[ \)\]_.-]|$)/i,
      BluRay:
        /(?<![^ [(_\-.])(blu[ .\-_]?ray|((bd|br|b|uhd)[ .\-_]?(rip|r)?))(?![ .\-_]?remux)(?=[ \)\]_.-]|$)/i,
      "WEB-DL":
        /(?<![^ [(_\-.])(web[ .\-_]?(dl)?)(?![ .\-_]?DLRip)(?=[ \)\]_.-]|$)/i,
      WEBRip: /(?<![^ [(_\-.])(web[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
      HDRip:
        /(?<![^ [(_\-.])(hd[ .\-_]?rip|web[ .\-_]?dl[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
      "HC HD-Rip": /(?<![^ [(_\-.])(hc|hd[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
      DVDRip:
        /(?<![^ [(_\-.])(dvd[ .\-_]?(rip|mux|r|full|5|9))(?=[ \)\]_.-]|$)/i,
      HDTV: /(?<![^ [(_\-.])((hd|pd)tv|tv[ .\-_]?rip|hdtv[ .\-_]?rip|dsr(ip)?|sat[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
      CAM: /(?<![^ [(_\-.])(cam|hdcam|cam[ .\-_]?rip)(?=[ \)\]_.-]|$)/i,
      TS: /(?<![^ [(_\-.])(telesync|ts|hd[ .\-_]?ts|pdvd|predvd(rip)?)(?=[ \)\]_.-]|$)/i,
      TC: /(?<![^ [(_\-.])(telecine|tc|hd[ .\-_]?tc)(?=[ \)\]_.-]|$)/i,
      SCR: /(?<![^ [(_\-.])(((dvd|bd|web)?[ .\-_]?)?(scr(eener)?))(?=[ \)\]_.-]|$)/i,
    },
    visualTags: {
      "HDR10+":
        /(?<![^ [(_\-.])(hdr[ .\-_]?(10|ten)[ .\-_]?([+]|plus))(?=[ \)\]_.-]|$)/i,
      HDR10: /(?<![^ [(_\-.])(hdr10)(?=[ \)\]_.-]|$)/i,
      HDR: /(?<![^ [(_\-.])(hdr)(?=[ \)\]_.-]|$)/i,
      DV: /(?<![^ [(_\-.])(dolby[ .\-_]?vision(?:[ .\-_]?atmos)?|dv)(?=[ \)\]_.-]|$)/i,
      IMAX: /(?<![^ [(_\-.])(imax)(?=[ \)\]_.-]|$)/i,
      AI: /(?<![^ [(_\-.])(ai[ .\-_]?(upscale|enhanced|remaster))(?=[ \)\]_.-]|$)/i,
    },
    audioTags: {
      Atmos: /(?<![^ [(_\-.])(atmos)(?=[ \)\]_.-]|$)/i,
      "DD+":
        /(?<![^ [(_\-.])((?:ddp|dolby[ .\-_]?digital[ .\-_]?plus)(?:[ .\-_]?(5\.1|7\.1))?)(?=[ \)\]_.-]|$)/i,
      DD: /(?<![^ [(_\-.])((?:dd|dolby[ .\-_]?digital)(?:[ .\-_]?(5\.1|7\.1))?)(?=[ \)\]_.-]|$)/i,
      "DTS-HD MA": /(?<![^ [(_\-.])(dts[ .\-_]?hd[ .\-_]?ma)(?=[ \)\]_.-]|$)/i,
      "DTS-HD": /(?<![^ [(_\-.])(dts[ .\-_]?hd)(?![ .\-_]?ma)(?=[ \)\]_.-]|$)/i,
      DTS: /(?<![^ [(_\-.])(dts(?![ .\-_]?hd[ .\-_]?ma|[ .\-_]?hd))(?=[ \)\]_.-]|$)/i,
      TrueHD: /(?<![^ [(_\-.])(true[ .\-_]?hd)(?=[ \)\]_.-]|$)/i,
      5.1: /(?<![^ [(_\-.])((?:ddp|dd)?[ .\-_]?5\.1)(?=[ \)\]_.-]|$)/i,
      7.1: /(?<![^ [(_\-.])((?:ddp|dd)?[ .\-_]?7\.1)(?=[ \)\]_.-]|$)/i,
      AC3: /(?<![^ [(_\-.])(ac[ .\-_]?3)(?=[ \)\]_.-]|$)/i,
      AAC: /(?<![^ [(_\-.])(aac)(?=[ \)\]_.-]|$)/i,
    },
    encodes: {
      HEVC: /(?<![^ [(_\-.])(hevc|x265|h265|h\.265)(?=[ \)\]_.-]|$)/i,
      AVC: /(?<![^ [(_\-.])(avc|x264|h264|h\.264)(?=[ \)\]_.-]|$)/i,
    },
    languages: {
      Multi: /(?<![^ [(_\-.])(multi|multi[ .\-_]?audio)(?=[ \)\]_.-]|$)/i,
      "Dual Audio": /(?<![^ [(_\-.])(dual[ .\-_]?audio)(?=[ \)\]_.-]|$)/i,
      English: /(?<![^ [(_\-.])(english|eng)(?=[ \)\]_.-]|$)/i,
      Japanese: /(?<![^ [(_\-.])(japanese|jap)(?=[ \)\]_.-]|$)/i,
      Chinese: /(?<![^ [(_\-.])(chinese|chi)(?=[ \)\]_.-]|$)/i,
      Russian: /(?<![^ [(_\-.])(russian|rus)(?=[ \)\]_.-]|$)/i,
      Arabic: /(?<![^ [(_\-.])(arabic|ara)(?=[ \)\]_.-]|$)/i,
      Portuguese: /(?<![^ [(_\-.])(portuguese|por)(?=[ \)\]_.-]|$)/i,
      Spanish: /(?<![^ [(_\-.])(spanish|spa)(?=[ \)\]_.-]|$)/i,
      French: /(?<![^ [(_\-.])(french|fra)(?=[ \)\]_.-]|$)/i,
      German: /(?<![^ [(_\-.])(german|ger)(?=[ \)\]_.-]|$)/i,
      Italian: /(?<![^ [(_\-.])(italian|ita)(?=[ \)\]_.-]|$)/i,
      Korean: /(?<![^ [(_\-.])(korean|kor)(?=[ \)\]_.-]|$)/i,
      Hindi: /(?<![^ [(_\-.])(hindi|hin)(?=[ \)\]_.-]|$)/i,
      Bengali: /(?<![^ [(_\-.])(bengali|ben)(?=[ \)\]_.-]|$)/i,
      Punjabi: /(?<![^ [(_\-.])(punjabi|pan)(?=[ \)\]_.-]|$)/i,
      Marathi: /(?<![^ [(_\-.])(marathi|mar)(?=[ \)\]_.-]|$)/i,
      Gujarati: /(?<![^ [(_\-.])(gujarati|guj)(?=[ \)\]_.-]|$)/i,
      Tamil: /(?<![^ [(_\-.])(tamil|tam)(?=[ \)\]_.-]|$)/i,
      Telugu: /(?<![^ [(_\-.])(telugu|tel)(?=[ \)\]_.-]|$)/i,
      Kannada: /(?<![^ [(_\-.])(kannada|kan)(?=[ \)\]_.-]|$)/i,
      Malayalam: /(?<![^ [(_\-.])(malayalam|mal)(?=[ \)\]_.-]|$)/i,
      Thai: /(?<![^ [(_\-.])(thai|tha)(?=[ \)\]_.-]|$)/i,
      Vietnamese: /(?<![^ [(_\-.])(vietnamese|vie)(?=[ \)\]_.-]|$)/i,
      Indonesian: /(?<![^ [(_\-.])(indonesian|ind)(?=[ \)\]_.-]|$)/i,
      Turkish: /(?<![^ [(_\-.])(turkish|tur)(?=[ \)\]_.-]|$)/i,
      Hebrew: /(?<![^ [(_\-.])(hebrew|heb)(?=[ \)\]_.-]|$)/i,
      Persian: /(?<![^ [(_\-.])(persian|per)(?=[ \)\]_.-]|$)/i,
      Ukrainian: /(?<![^ [(_\-.])(ukrainian|ukr)(?=[ \)\]_.-]|$)/i,
      Greek: /(?<![^ [(_\-.])(greek|ell)(?=[ \)\]_.-]|$)/i,
      Lithuanian: /(?<![^ [(_\-.])(lithuanian|lit)(?=[ \)\]_.-]|$)/i,
      Latvian: /(?<![^ [(_\-.])(latvian|lav)(?=[ \)\]_.-]|$)/i,
      Estonian: /(?<![^ [(_\-.])(estonian|est)(?=[ \)\]_.-]|$)/i,
      Polish: /(?<![^ [(_\-.])(polish|pol)(?=[ \)\]_.-]|$)/i,
      Czech: /(?<![^ [(_\-.])(czech|cze)(?=[ \)\]_.-]|$)/i,
      Slovak: /(?<![^ [(_\-.])(slovak|slo)(?=[ \)\]_.-]|$)/i,
      Hungarian: /(?<![^ [(_\-.])(hungarian|hun)(?=[ \)\]_.-]|$)/i,
      Romanian: /(?<![^ [(_\-.])(romanian|rum)(?=[ \)\]_.-]|$)/i,
      Bulgarian: /(?<![^ [(_\-.])(bulgarian|bul)(?=[ \)\]_.-]|$)/i,
      Serbian: /(?<![^ [(_\-.])(serbian|srp)(?=[ \)\]_.-]|$)/i,
      Croatian: /(?<![^ [(_\-.])(croatian|hrv)(?=[ \)\]_.-]|$)/i,
      Slovenian: /(?<![^ [(_\-.])(slovenian|slv)(?=[ \)\]_.-]|$)/i,
      Dutch: /(?<![^ [(_\-.])(dutch|dut)(?=[ \)\]_.-]|$)/i,
      Danish: /(?<![^ [(_\-.])(danish|dan)(?=[ \)\]_.-]|$)/i,
      Finnish: /(?<![^ [(_\-.])(finnish|fin)(?=[ \)\]_.-]|$)/i,
      Swedish: /(?<![^ [(_\-.])(swedish|swe)(?=[ \)\]_.-]|$)/i,
      Norwegian: /(?<![^ [(_\-.])(norwegian|nor)(?=[ \)\]_.-]|$)/i,
      Malay: /(?<![^ [(_\-.])(malay|may)(?=[ \)\]_.-]|$)/i,
    },
  };

  function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1000;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  function formatDuration(durationMillis) {
    const seconds = Math.floor(durationMillis / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    const formattedSeconds = seconds % 60;
    const formattedMinutes = minutes % 60;

    return `${hours}:${formattedMinutes}:${formattedSeconds}`;
  }

  function createJsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 4), {
      headers: HEADERS,
      status: status,
    });
  }

  function compareLanguages(a, b) {
    if (CONFIG.prioritiseLanguage) {
      const aHasPrioritisedLanguage = a.languages.includes(
        CONFIG.prioritiseLanguage,
      );
      const bHasPrioritisedLanguage = b.languages.includes(
        CONFIG.prioritiseLanguage,
      );
      const aHasMultiLanguage = a.languages.includes("Multi");
      const bHasMultiLanguage = b.languages.includes("Multi");

      if (aHasPrioritisedLanguage && !bHasPrioritisedLanguage) return -1;
      if (!aHasPrioritisedLanguage && bHasPrioritisedLanguage) return 1;

      if (aHasMultiLanguage && !bHasMultiLanguage) return -1;
      if (!aHasMultiLanguage && bHasMultiLanguage) return 1;
    }
    return 0;
  }

  function compareByField(a, b, field) {
    if (field === "resolution") {
      return (
        CONFIG.resolutions.indexOf(a.resolution) -
        CONFIG.resolutions.indexOf(b.resolution)
      );
    } else if (field === "size") {
      return b.size - a.size;
    } else if (field === "quality") {
      return (
        CONFIG.qualities.indexOf(a.quality) -
        CONFIG.qualities.indexOf(b.quality)
      );
    } else if (field === "visualTag") {
      // Find the highest priority visual tag in each file
      const getIndexOfTag = (tag) =>
        CONFIG.considerHdrTagsAsEqual && tag.startsWith("HDR")
          ? CONFIG.visualTags.indexOf("HDR10+")
          : CONFIG.visualTags.indexOf(tag);
      const aVisualTagIndex = a.visualTags.reduce(
        (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
        CONFIG.visualTags.length,
      );

      const bVisualTagIndex = b.visualTags.reduce(
        (minIndex, tag) => Math.min(minIndex, getIndexOfTag(tag)),
        CONFIG.visualTags.length,
      );
      // Sort by the visual tag index
      return aVisualTagIndex - bVisualTagIndex;
    } else if (field === "durationAsc") {
      return a.duration - b.duration;
    } else if (field === "durationDesc") {
      return b.duration - a.duration;
    }
    return 0;
  }

  async function createStream(parsedFile, accessToken, baseUrl) {
    let name = parsedFile.type.startsWith("audio")
      ? `[🎵 Audio] ${MANIFEST.name} ${parsedFile.extension.toUpperCase()}`
      : `${MANIFEST.name} ${parsedFile.resolution}`;

    let description = `🎥 ${parsedFile.quality}   ${
      parsedFile.encode ? "🎞️ " + parsedFile.encode : ""
    }`;

    if (parsedFile.visualTags.length > 0 || parsedFile.audioTags.length > 0) {
      description += "\n";

      description +=
        parsedFile.visualTags.length > 0
          ? `📺 ${parsedFile.visualTags.join(" | ")}   `
          : "";
      description +=
        parsedFile.audioTags.length > 0
          ? `🎧 ${parsedFile.audioTags.join(" | ")}`
          : "";
    }

    description += `\n📦 ${parsedFile.formattedSize}`;
    if (parsedFile.languages.length !== 0) {
      description += `\n🔊 ${parsedFile.languages.join(" | ")}`;
    }

    description += `\n📄 ${parsedFile.name}`;

    if (parsedFile.duration) {
      description += `\n⏱️ ${formatDuration(parsedFile.duration)}`;
    }
    const combinedTags = [
      parsedFile.resolution,
      parsedFile.quality,
      parsedFile.encode,
      ...parsedFile.visualTags,
      ...parsedFile.audioTags,
      ...parsedFile.languages,
    ];

    const stream = {
      name: name,
      description: description,
      url: "",
      behaviorHints: {
        videoSize: parseInt(parsedFile.size) || 0,
        filename: parsedFile.name,
        bingeGroup: `${MANIFEST.name}|${combinedTags.join("|")}`,
      },
    };

    stream.url = `${baseUrl}/playback/${encodeURIComponent(parsedFile.id)}/${encodeURIComponent(parsedFile.name)}`;
    stream.subtitles = await safeSubtitles(parsedFile, baseUrl);

    return stream;
  }

  function createErrorStream(description) {
    return {
      name: `[⚠️] ${MANIFEST.name}`,
      description: description,
      externalUrl: "https://github.com/kenfabioh/stremio-gdrive-addon",
    };
  }

  function sortParsedFiles(parsedFiles) {
    parsedFiles.sort((a, b) => {
      const languageComparison = compareLanguages(a, b);
      if (languageComparison !== 0) return languageComparison;

      for (const sortByField of CONFIG.sortBy) {
        const fieldComparison = compareByField(a, b, sortByField);
        if (fieldComparison !== 0) return fieldComparison;
      }

      // move audio files to the end
      if (a.type.startsWith("audio") && !b.type.startsWith("audio")) return 1;
      if (!a.type.startsWith("audio") && b.type.startsWith("audio")) return -1;

      return 0;
    });
  }

  function parseAndFilterFiles(files) {
    return files
      .map((file) => parseFile(file))
      .filter(
        (parsedFile) =>
          CONFIG.resolutions.includes(parsedFile.resolution) &&
          CONFIG.qualities.includes(parsedFile.quality) &&
          parsedFile.visualTags.every((tag) => CONFIG.visualTags.includes(tag)),
      );
  }

  function parseFile(file) {
    let resolution =
      Object.entries(REGEX_PATTERNS.resolutions).find(([_, pattern]) =>
        pattern.test(file.name),
      )?.[0] || "Unknown";
    let quality =
      Object.entries(REGEX_PATTERNS.qualities).find(([_, pattern]) =>
        pattern.test(file.name),
      )?.[0] || "Unknown";
    let visualTags = Object.entries(REGEX_PATTERNS.visualTags)
      .filter(([_, pattern]) => pattern.test(file.name))
      .map(([tag]) => tag);
    let audioTags = Object.entries(REGEX_PATTERNS.audioTags)
      .filter(([_, pattern]) => pattern.test(file.name))
      .map(([tag]) => tag);
    let encode =
      Object.entries(REGEX_PATTERNS.encodes).find(([_, pattern]) =>
        pattern.test(file.name),
      )?.[0] || "";
    let languages = Object.entries(REGEX_PATTERNS.languages)
      .filter(([_, pattern]) => pattern.test(file.name))
      .map(([tag]) => tag);

    if (visualTags.includes("HDR10+")) {
      visualTags = visualTags.filter((tag) => tag !== "HDR" && tag !== "HDR10");
    } else if (visualTags.includes("HDR10")) {
      visualTags = visualTags.filter((tag) => tag !== "HDR");
    }

    return {
      id: file.id,
      name: file.name,
      parents: file.parents,
      size: file.size,
      formattedSize: parseInt(file.size)
        ? formatSize(parseInt(file.size))
        : "Unknown",
      resolution: resolution,
      quality: quality,
      languages: languages,
      encode: encode,
      audioTags: audioTags,
      visualTags: visualTags,
      duration: parseInt(file.videoMediaMetadata?.durationMillis) || undefined,
      type: file.mimeType,
      mimeType: file.mimeType,
      extension: file.fileExtension,
    };
  }

  function isConfigValid() {
    const requiredFields = [
      {
        value: CREDENTIALS.clientId,
        error: "Missing clientId. Add your client ID to the Worker bindings",
      },
      {
        value: CREDENTIALS.clientSecret,
        error:
          "Missing clientSecret! Add your client secret to the Worker bindings",
      },
      {
        value: CREDENTIALS.refreshToken,
        error:
          "Missing refreshToken! Add your refresh token to the Worker bindings",
      },
      {
        value: CONFIG.addonName,
        error: "Missing addonName! Provide it in the config object",
      },
    ];

    for (const { value, error } of requiredFields) {
      if (!value) {
        return false;
      }
    }

    const validValues = {
      resolutions: [...Object.keys(REGEX_PATTERNS.resolutions), "Unknown"],
      qualities: [...Object.keys(REGEX_PATTERNS.qualities), "Unknown"],
      sortBy: [
        "resolution",
        "size",
        "quality",
        "visualTag",
        "durationAsc",
        "durationDesc",
      ],
      languages: [...Object.keys(REGEX_PATTERNS.languages), "Unknown"],
      visualTags: [...Object.keys(REGEX_PATTERNS.visualTags)],
    };

    for (const key of ["resolutions", "qualities", "sortBy", "visualTags"]) {
      const configValue = CONFIG[key];
      if (!Array.isArray(configValue)) {
        return false;
      }
      for (const value of CONFIG[key]) {
        if (!validValues[key].includes(value)) {
          return false;
        }
      }
    }

    if (
      CONFIG.prioritiseLanguage &&
      !validValues.languages.includes(CONFIG.prioritiseLanguage)
    ) {
      return false;
    }

    return true;
  }

  async function getMetadata(type, fullId) {
    let id = fullId;

    if (id.startsWith("kitsu")) {
      id = id.split(":")[0] + ":" + id.split(":")[1]; // Remove the :1 at the end
      const meta = await getKitsuMeta(type, id);
      if (meta) {
        return meta;
      }

      return null;
    }

    if (CONFIG.tmdbApiKey) {
      try {
        const meta = await getTmdbMeta(type, fullId);
        if (meta) {
          return meta;
        }
      } catch (error) {}
    }
    try {
      const meta = await getCinemetaMeta(type, id);
      if (meta) {
        return meta;
      }
    } catch (error) {}

    try {
      const meta = await getImdbSuggestionMeta(id);
      if (meta) {
        return meta;
      }
    } catch (error) {}

    return null;
  }

  async function getKitsuMeta(type, id) {
    const url = `https://anime-kitsu.strem.fun/meta/${type}/${id}.json`;

    const response = await fetch(url);
    if (!response.ok) {
      let err = await response.text();
      throw new Error(err);
    }
    const data = await response.json();
    if (!data?.meta) {
      throw new Error("Meta object not found in response");
    }
    if (!data.meta.name || !data.meta.year) {
      throw new Error("Either name or year not found in meta object");
    }
    return {
      name: data.meta.name,
      year: data.meta.year,
    };
  }

  async function getTmdbMeta(type, id) {
    let response;
    let result;
    if (id.startsWith("tmdb")) {
      if (!CONFIG.tmdbApiKey) {
        throw new Error("TMDB ID detected but no API key provided");
      }
      const url = API_ENDPOINTS.TMDB_DETAILS.replace(
        "{type}",
        type === "movie" ? "movie" : "tv",
      )
        .replace("{id}", id.split(":")[1])
        .replace("{apiKey}", CONFIG.tmdbApiKey);

      response = await fetch(url);

      if (!response.ok) {
        let err = await response.text();
        throw new Error(`${response.status} - ${response.statusText}: ${err}`);
      }

      result = await response.json();
    } else {
      const url = API_ENDPOINTS.TMDB_FIND.replace(
        "{id}",
        id.split(":")[0],
      ).replace("{apiKey}", CONFIG.tmdbApiKey);

      response = await fetch(url);

      if (!response.ok) {
        let err = await response.text();
        throw new Error(`${response.status} - ${response.statusText}: ${err}`);
      }
      const data = await response.json();
      if (!data?.movie_results && !data?.tv_results) {
        throw new Error("No results found in response");
      }

      result = data.movie_results[0] || data.tv_results[0];
    }

    if (!result) {
      throw new Error("No results found in response");
    }

    if (
      (!result.name && !result.title) ||
      (!result.release_date && !result.first_air_date)
    ) {
      throw new Error("Either title or release date not found in result");
    }

    return {
      name: result.name || result.title,
      year: (result.release_date || result.first_air_date).split("-")[0],
    };
  }

  async function getCinemetaMeta(type, id) {
    id = id.split(":")[0];
    const response = await fetch(
      API_ENDPOINTS.CINEMETA.replace("{type}", type).replace("{id}", id),
    );
    if (!response.ok) {
      let err = await response.text();
      throw new Error(err);
    }
    const data = await response.json();
    if (!data?.meta) {
      throw new Error("Meta object not found in response");
    }
    if (!data.meta.name || !data.meta.year) {
      throw new Error("Either name or year not found in meta object");
    }
    return {
      name: data.meta.name,
      year: data.meta.year,
    };
  }

  async function getImdbSuggestionMeta(id) {
    id = id.split(":")[0];
    const response = await fetch(
      API_ENDPOINTS.IMDB_SUGGEST.replace("{id}", id),
    );
    if (!response.ok) {
      let err = await response.text();
      throw new Error(err);
    }
    const data = await response.json();
    if (!data?.d) {
      throw new Error("No suggestions in d object");
    }

    const item = data.d.find((item) => item.id === id);
    if (!item) {
      throw new Error("No matching item found with the given id");
    }

    if (!item?.l || !item?.y) {
      throw new Error("Missing name or year");
    }

    return {
      name: item.l,
      year: item.y,
    };
  }

  let tokenState;
  let tokenFlight;
  async function getAccessToken() {
    if (tokenState?.expires > Date.now()) return tokenState.value;
    if (tokenFlight) return tokenFlight;
    tokenFlight = (async () => {
      try {
        const response = await fetch(API_ENDPOINTS.DRIVE_TOKEN, {
          method: "POST",
          body: new URLSearchParams({
            client_id: CREDENTIALS.clientId,
            client_secret: CREDENTIALS.clientSecret,
            refresh_token: CREDENTIALS.refreshToken,
            grant_type: "refresh_token",
          }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (!response.ok) return undefined;
        const data = await response.json();
        if (typeof data.access_token !== "string" || !data.access_token)
          return undefined;
        tokenState = {
          value: data.access_token,
          expires:
            Date.now() +
            Math.max(0, (Number(data.expires_in) || 3600) - 60) * 1000,
        };
        return tokenState.value;
      } catch {
        return undefined;
      }
    })();
    try {
      return await tokenFlight;
    } finally {
      tokenFlight = undefined;
    }
  }
  const driveScope = createDriveScope({
    roots: CONFIG.driveFolderIds,
    recursive: CONFIG.driveRecursive,
    getToken: getAccessToken,
  });
  const metadataCache = new TimedCache(60_000, 200);
  const catalogCache = new TimedCache(60_000, 1);
  async function getProtectedFile(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id || "")) return null;
    return metadataCache.get(id, async () => {
      const token = await getAccessToken();
      if (!token) throw new Error("Google authentication unavailable");
      const file = await fetchFile(id, token);
      if (!file || file.trashed) return null;
      if (!(await driveScope.allows(file.parents))) return null;
      return file;
    });
  }
  const subtitles = createSubtitleService({
    getToken: getAccessToken,
    getFile: getProtectedFile,
    isFolderAllowed: (id) => driveScope.allows([id]),
  });
  async function safeSubtitles(video, baseUrl) {
    try {
      return await subtitles.forVideo(video, baseUrl);
    } catch {
      return [];
    } // An unavailable sidecar must not stop video playback.
  }

  async function fetchScopedFiles(fetchUrl, accessToken) {
    const baseQuery = fetchUrl.searchParams.get("q");
    const batches = await driveScope.batches(baseQuery);
    const combined = { files: [] };
    const orderBy = fetchUrl.searchParams.get("orderBy");
    const ordered = ["createdTime desc", "modifiedTime desc"].includes(orderBy);
    const sortField =
      orderBy === "modifiedTime desc" ? "modifiedTime" : "createdTime";
    const newestFirst = (a, b) =>
      (b[sortField] || b.createdTime || "").localeCompare(
        a[sortField] || a.createdTime || "",
      );
    const seen = new Set();
    for (const { query, parents } of batches) {
      const scopedUrl = new URL(fetchUrl);
      scopedUrl.searchParams.set("q", query);
      let page;
      try {
        page = await fetchFiles(scopedUrl, accessToken);
      } catch (error) {
        if (
          !ordered ||
          !(error instanceof DriveListError) ||
          !(error.upstreamStatus >= 500 && error.upstreamStatus <= 599)
        )
          throw error;
        // Prefer the actual root's corpus when the allDrives backend fails.
        // Retain the same parent filter, and avoid failing server-side sorting.
        let corpora;
        try {
          corpora = await driveScope.fallbackCorpora();
        } catch (lookupError) {
          throw new DriveListError(
            "ROOT_FOLDER_LOOKUP_FAILED",
            lookupError.upstreamStatus,
          );
        }
        const recovered = { files: [] };
        outer: for (const corpus of corpora) {
          for (let offset = 0; offset < (parents?.length || 1); offset += 5) {
            const parentGroup = parents
              ? parents.slice(offset, offset + 5)
              : null;
            const retryUrl = new URL(scopedUrl);
            retryUrl.searchParams.delete("orderBy");
            retryUrl.searchParams.delete("pageToken");
            retryUrl.searchParams.delete("driveId");
            if (parentGroup)
              retryUrl.searchParams.set(
                "q",
                `${baseQuery} and ${parentQuery(parentGroup)}`,
              );
            for (const [key, value] of Object.entries(corpus))
              retryUrl.searchParams.set(key, value);
            const result = await fetchFiles(retryUrl, accessToken);
            recovered.files.push(...result.files);
            recovered.incompleteSearch ||= result.incompleteSearch;
            if (recovered.files.length >= CONFIG.maxFilesToFetch) break outer;
          }
        }
        page = recovered;
      }
      combined.incompleteSearch ||= page.incompleteSearch;
      for (const file of page.files) {
        if (!seen.has(file.id)) {
          seen.add(file.id);
          combined.files.push(file);
        }
      }
      if (ordered) {
        // Later folder batches can contain newer files even if the first filled the limit.
        combined.files.sort(newestFirst);
        combined.files = combined.files.slice(0, CONFIG.maxFilesToFetch);
      } else if (combined.files.length >= CONFIG.maxFilesToFetch) break;
    }
    combined.files = combined.files.slice(0, CONFIG.maxFilesToFetch);
    return combined;
  }

  async function fetchFiles(fetchUrl, accessToken) {
    let pagesRead = 0;
    try {
      pagesRead++;
      const response = await fetch(fetchUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new DriveListError("DRIVE_API_ERROR", response.status);
      }
      // handle paginated results

      const results = await response.json();
      results.files ||= [];
      const visitedPages = new Set();

      while (
        results.nextPageToken &&
        results.files.length < CONFIG.maxFilesToFetch
      ) {
        if (visitedPages.has(results.nextPageToken))
          throw new DriveListError("DRIVE_PAGINATION_LOOP");
        visitedPages.add(results.nextPageToken);
        fetchUrl.searchParams.set("pageToken", results.nextPageToken);
        pagesRead++;
        const nextPageResponse = await fetch(fetchUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!nextPageResponse.ok) {
          await nextPageResponse.body?.cancel();
          throw new DriveListError("DRIVE_API_ERROR", nextPageResponse.status);
        }

        const nextPageResults = await nextPageResponse.json();
        results.files = [...results.files, ...(nextPageResults.files || [])];
        results.nextPageToken = nextPageResults.nextPageToken;

        if (results.files.length >= CONFIG.maxFilesToFetch) {
          break;
        }
        // Drive may return empty intermediate pages. Only nextPageToken marks the end.
      }

      results.files = results.files.slice(0, CONFIG.maxFilesToFetch);
      return results;
    } catch (error) {
      // Expose only bounded, non-sensitive diagnostics, never Google's response body.
      const failure =
        error instanceof DriveListError
          ? error
          : new DriveListError(
              /too many subrequests/i.test(error.message || "")
                ? "WORKER_SUBREQUEST_LIMIT"
                : "DRIVE_FETCH_FAILED",
            );
      failure.pagesRead = pagesRead;
      failure.corpus = fetchUrl.searchParams.get("corpora");
      failure.serverSorted = fetchUrl.searchParams.has("orderBy");
      throw failure;
    }
  }

  async function fetchFile(fileId, accessToken) {
    try {
      const fetchUrl = new URL(
        API_ENDPOINTS.DRIVE_FETCH_FILE.replace("{fileId}", fileId),
      );
      const searchParams = {
        supportsAllDrives: true,
        fields:
          "id,name,parents,trashed,mimeType,size,videoMediaMetadata,fileExtension,createdTime,thumbnailLink,iconLink",
      };
      fetchUrl.search = new URLSearchParams(searchParams).toString();
      const response = await fetch(fetchUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        let err = await response.text();
        throw new Error(err);
      }

      const file = await response.json();
      return file;
    } catch (error) {
      return null;
    }
  }

  function buildBaseSearchQuery(query) {
    query = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    let q = `name contains '${query}' and trashed=false and not name contains 'trailer' and not name contains 'sample'`;

    if (CONFIG.showAudioFiles) {
      q += ` and (mimeType contains 'video/' or mimeType contains 'audio/')`;
    } else {
      q += ` and mimeType contains 'video/'`;
    }

    return q;
  }

  async function buildSearchQuery(streamRequest) {
    const { name, year } = streamRequest.metadata;

    let query =
      "trashed=false and not name contains 'trailer' and not name contains 'sample'";

    query += CONFIG.showAudioFiles
      ? ` and (mimeType contains 'video/' or mimeType contains 'audio/')`
      : ` and mimeType contains 'video/'`;

    const sanitisedName = name
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/'/g, "\\'");
    const nameWithoutApostrophes = name.replace(/[^a-zA-Z0-9\s]/g, "");

    if (streamRequest.type === "movie")
      query += ` and (${CONFIG.driveQueryTerms.titleName} contains '${sanitisedName} ${year}' or ${CONFIG.driveQueryTerms.titleName} contains '${nameWithoutApostrophes} ${year}')`;
    if (streamRequest.type === "series")
      query += ` and (${CONFIG.driveQueryTerms.titleName} contains '${sanitisedName}' or ${CONFIG.driveQueryTerms.titleName} contains '${nameWithoutApostrophes}')`;

    const season = streamRequest.season;
    const episode = streamRequest.episode;
    if (!season || !episode) return query;

    const formats = [];
    let zeroPaddedSeason = season.toString().padStart(2, "0");
    let zeroPaddedEpisode = episode.toString().padStart(2, "0");

    const getFormats = (season, episode) => {
      return [
        [`s${season}e${episode}`],
        [`s${season}`, `e${episode}`],
        [`s${season}.e${episode}`],
        [`${season}x${episode}`],
        [`s${season}xe${episode}`],
        [`season ${season}`, `episode ${episode}`],
        [`s${season}`, `ep${episode}`],
      ];
    };

    formats.push(...getFormats(season, episode));

    if (zeroPaddedSeason !== season.toString()) {
      formats.push(...getFormats(zeroPaddedSeason, episode));
    }

    if (zeroPaddedEpisode !== episode.toString()) {
      formats.push(...getFormats(season, zeroPaddedEpisode));
    }

    if (
      zeroPaddedSeason !== season.toString() &&
      zeroPaddedEpisode !== episode.toString()
    ) {
      formats.push(...getFormats(zeroPaddedSeason, zeroPaddedEpisode));
    }

    query += ` and (${formats
      .map(
        (formatList) =>
          `(${formatList
            .map(
              (format) =>
                `${CONFIG.driveQueryTerms.episodeFormat} contains '${format}'`,
            )
            .join(" and ")})`,
      )
      .join(" or ")})`;

    return query;
  }

  async function handleRequest(request, baseUrl) {
    try {
      const url = new URL(request.url);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/manifest.json") {
        const manifest = { ...MANIFEST };
        manifest.catalogs = [];
        manifest.resources = [
          { name: "stream", types: ["movie", "series", "anime"] },
          { name: "subtitles", types: ["movie", "series", "anime"] },
        ];
        if (CONFIG.enableSearchCatalog) {
          manifest.catalogs.push({
            type: "movie",
            id: "gdrive_list",
            name: "Google Drive",
          });
        }
        if (CONFIG.enableVideoCatalog) {
          manifest.catalogs.push({
            type: "movie",
            id: "gdrive_search",
            name: "Google Drive Search",
            extra: [
              {
                name: "search",
                isRequired: true,
              },
            ],
          });
        }
        if (CONFIG.enableVideoCatalog || CONFIG.enableSearchCatalog) {
          manifest.resources.push({
            name: "catalog",
            types: ["movie"],
          });
          manifest.resources.push({
            name: "meta",
            types: ["movie", "series", "anime"],
            idPrefixes: ["gdrive:"],
          });
        }
        return createJsonResponse(manifest);
      }

      if (pathname === "/")
        return Response.redirect(baseUrl + "/manifest.json", 301);

      const subtitleMatch =
        /^\/subtitles\/(movie|series|anime)\/([^/]+?)(?:\/(.*))?\.json$/.exec(
          url.pathname,
        );
      const srtMatch = /^\/subtitle\/([a-zA-Z0-9_-]+)\/subtitle\.srt$/.exec(
        pathname,
      );
      if (srtMatch) return serveDriveFile(srtMatch[1], request, true);
      if (subtitleMatch) {
        let video;
        const id = decodeURIComponent(subtitleMatch[2]);
        if (id.startsWith("gdrive:")) {
          video = await getProtectedFile(id.slice(7));
        } else {
          // Resolve the selected release, not all releases for the same IMDb id.
          const extra = new URLSearchParams(subtitleMatch[3] || "");
          const filename = extra.get("filename");
          if (filename) {
            const escaped = filename
              .replace(/\\/g, "\\\\")
              .replace(/'/g, "\\'");
            const lookup = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
            let query = `trashed=false and mimeType contains 'video/' and name = '${escaped}'`;
            lookup.search = new URLSearchParams({
              q: query,
              corpora: "allDrives",
              includeItemsFromAllDrives: "true",
              supportsAllDrives: "true",
              fields: "nextPageToken,files(id,name,parents,mimeType,size)",
              pageSize: "100",
            });
            const result = await fetchScopedFiles(
              lookup,
              await getAccessToken(),
            );
            const candidates = (result?.files || []).filter(
              (f) =>
                f.name === filename &&
                (!extra.get("videoSize") || f.size === extra.get("videoSize")),
            );
            if (candidates.length === 1) video = candidates[0];
          }
        }
        return createJsonResponse({
          subtitles: video ? await safeSubtitles(video, baseUrl) : [],
        });
      }
      const streamMatch = REGEX_PATTERNS.validStreamRequest.exec(pathname);
      const playbackMatch = REGEX_PATTERNS.validPlaybackRequest.exec(pathname);
      const catalogMatch = REGEX_PATTERNS.validCatalogRequest.exec(pathname);
      const metaMatch = REGEX_PATTERNS.validMetaRequest.exec(pathname);

      if (!(playbackMatch || streamMatch || catalogMatch || metaMatch))
        return createJsonResponse({ error: "Bad request" }, 400);

      if (!isConfigValid()) {
        return createJsonResponse({
          streams: [
            createErrorStream(
              "Invalid configuration\nEnable and check the logs for more information\nClick for setup instructions",
            ),
          ],
        });
      }

      if (playbackMatch) {
        const filename = decodeURIComponent(playbackMatch[2]);
        const fileId = playbackMatch[1];
        return serveDriveFile(fileId, request, false);
      }

      const createMetaObject = (id, name, size, thumbnail, createdTime) => ({
        id: `gdrive:${id}`,
        name,
        posterShape: "landscape",
        background: thumbnail,
        poster: thumbnail,
        description:
          `Size: ${formatSize(size)}` +
          (createdTime
            ? ` | Created: ${new Date(createdTime).toLocaleDateString("en-GB", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}`
            : ""),
        type: "movie",
      });

      if (metaMatch) {
        const fileId = metaMatch[2];
        if (!fileId) {
          return createJsonResponse({ error: "File unavailable" }, 404);
        }
        const gdriveId = fileId.split(":")[1];
        const accessToken = await getAccessToken();
        if (!accessToken) {
          return createJsonResponse({ error: "File unavailable" }, 404);
        }

        const file = await getProtectedFile(gdriveId);
        if (!file) {
          return createJsonResponse({ error: "File unavailable" }, 404);
        }

        const parsedFile = parseFile(file);
        return createJsonResponse({
          meta: createMetaObject(
            parsedFile.id,
            parsedFile.name,
            parsedFile.size,
            file.thumbnailLink,
            file.createdTime,
          ),
        });
      }

      if (catalogMatch) {
        // handle catalogs
        const catalogId = catalogMatch[1];
        const searchQuery = catalogMatch[2];
        const searchTerm = searchQuery
          ? searchQuery.slice("/search=".length)
          : null;

        if (catalogId === "gdrive_list") {
          const parts = ["trashed=false", "mimeType contains 'video/'"];

          const queryParams = {
            q: parts.join(" and "),
            corpora: "allDrives",
            includeItemsFromAllDrives: "true",
            supportsAllDrives: "true",
            pageSize: "1000",
            orderBy: "modifiedTime desc",
            fields:
              "nextPageToken,incompleteSearch,files(id,name,size,videoMediaMetadata,mimeType,fileExtension,thumbnailLink,createdTime,modifiedTime)",
          };

          const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
          fetchUrl.search = new URLSearchParams(queryParams).toString();

          const accessToken = await getAccessToken();

          if (!accessToken) {
            return createJsonResponse({
              error:
                "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions",
            });
          }

          const results = await catalogCache.get("list", () =>
            fetchScopedFiles(fetchUrl, accessToken),
          );
          const metas = (results?.files || []).map((file) =>
            createMetaObject(
              file.id,
              file.name,
              file.size,
              file.thumbnailLink,
              file.createdTime,
            ),
          );

          return createJsonResponse({ metas });
        }

        if (catalogId === "gdrive_search") {
          if (!searchTerm) {
            return createJsonResponse({ metas: [] });
          }

          const queryParams = {
            q: buildBaseSearchQuery(searchTerm),
            corpora: "allDrives",
            includeItemsFromAllDrives: "true",
            supportsAllDrives: "true",
            pageSize: "1000",
            fields:
              "nextPageToken,incompleteSearch,files(id,name,parents,size,videoMediaMetadata,mimeType,fileExtension,thumbnailLink,createdTime)",
          };

          const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
          fetchUrl.search = new URLSearchParams(queryParams).toString();

          const accessToken = await getAccessToken();

          if (!accessToken) {
            return createJsonResponse({
              error:
                "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions",
            });
          }

          const results = await fetchScopedFiles(fetchUrl, accessToken);

          if (!results?.files || results.files.length === 0) {
            return createJsonResponse({ metas: [] });
          }

          const metas = (results?.files || []).map((file) =>
            createMetaObject(
              file.id,
              file.name,
              file.size,
              file.thumbnailLink,
              file.createdTime,
            ),
          );

          return createJsonResponse({ metas });
        }

        return createJsonResponse({ metas: [] });
      }

      const type = streamMatch[1];

      const fullId = streamMatch[2];
      let [season, episode] = fullId.split(":").slice(-2);

      if (fullId.startsWith("kitsu")) {
        season = 1;
      }

      if (fullId.startsWith("gdrive")) {
        const fileId = streamMatch[2].split(":")[1];
        const accessToken = await getAccessToken();
        if (!accessToken) {
          return createJsonResponse({ error: "File unavailable" }, 404);
        }

        const file = await getProtectedFile(fileId);
        if (!file) {
          return createJsonResponse({ error: "File unavailable" }, 404);
        }

        const parsedFile = parseFile(file);
        return createJsonResponse({
          streams: [await createStream(parsedFile, accessToken, baseUrl)],
        });
      }

      const metadata = await getMetadata(type, fullId);

      if (!metadata) return createJsonResponse({ streams: [] });

      const parsedStreamRequest = {
        type: type,
        id: fullId,
        season: parseInt(season) || undefined,
        episode: parseInt(episode) || undefined,
        metadata: metadata,
      };

      const streams = await getStreams(parsedStreamRequest, baseUrl);

      if (streams.length === 0) {
        return createJsonResponse({
          streams: [
            createErrorStream("No streams found\nTry joining more team drives"),
          ],
        });
      }
      return createJsonResponse({ streams: streams });
    } catch (error) {
      return createJsonResponse(
        {
          error: "Service unavailable",
          ...(error instanceof DriveListError
            ? {
                code: error.code,
                upstreamStatus: error.upstreamStatus,
                pagesRead: error.pagesRead,
                corpus: error.corpus,
                serverSorted: error.serverSorted,
              }
            : {}),
        },
        502,
      );
    }
  }

  async function serveDriveFile(fileId, request, isSubtitle) {
    try {
      const file = await getProtectedFile(fileId);
      if (
        !file ||
        (isSubtitle
          ? !/\.srt$/i.test(file.name)
          : !(
              file.mimeType?.startsWith("video/") ||
              (CONFIG.showAudioFiles && file.mimeType?.startsWith("audio/"))
            ))
      ) {
        return createJsonResponse({ error: "Not found" }, 404);
      }
      const url = new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      );
      url.search = new URLSearchParams({
        alt: "media",
        supportsAllDrives: "true",
      });
      const headers = new Headers({
        Authorization: `Bearer ${await getAccessToken()}`,
      });
      for (const name of ["Range", "If-Range"])
        if (request.headers.has(name))
          headers.set(name, request.headers.get(name));
      let target = url;
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetch(target, {
          method: request.method,
          headers,
          redirect: "manual",
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location || attempt === 3)
          throw new Error("Invalid Drive redirect");
        target = new URL(location, target);
        if (
          target.protocol !== "https:" ||
          target.username ||
          target.password ||
          !(
            target.hostname.endsWith(".googleusercontent.com") ||
            target.hostname.endsWith(".googleapis.com")
          )
        )
          throw new Error("Untrusted Drive redirect");
        // Signed Google download URLs must never receive the OAuth bearer token.
        headers.delete("Authorization");
      }
      const outgoing = new Headers(HEADERS);
      for (const name of [
        "Content-Type",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "ETag",
        "Last-Modified",
      ]) {
        if (response.headers.has(name))
          outgoing.set(name, response.headers.get(name));
      }
      if (isSubtitle) {
        outgoing.set("Content-Type", "application/x-subrip");
        outgoing.set("X-Content-Type-Options", "nosniff");
      }
      if (![200, 206, 304, 416].includes(response.status)) {
        await response.body?.cancel();
        return createJsonResponse(
          { error: "Drive file unavailable" },
          response.status === 404 ? 404 : 502,
        );
      }
      // Forward ReadableStream without buffering a video (including HEAD and Range errors).
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers: outgoing,
      });
    } catch {
      return createJsonResponse({ error: "Drive unavailable" }, 502);
    }
  }

  async function getStreams(streamRequest, baseUrl) {
    const streams = [];
    const query = await buildSearchQuery(streamRequest);

    const queryParams = {
      q: query,
      corpora: "allDrives",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      pageSize: "1000",
      fields:
        "nextPageToken,incompleteSearch,files(id,name,parents,size,videoMediaMetadata,mimeType,fileExtension)",
    };

    const fetchUrl = new URL(API_ENDPOINTS.DRIVE_FETCH_FILES);
    fetchUrl.search = new URLSearchParams(queryParams).toString();

    const accessToken = await getAccessToken();

    if (!accessToken) {
      return [
        createErrorStream(
          "Invalid Credentials\nEnable and check the logs for more information\nClick for setup instructions",
        ),
      ];
    }

    const results = await fetchScopedFiles(fetchUrl, accessToken);

    if (results?.incompleteSearch) {
    }

    if (!results?.files || results.files.length === 0) {
      return streams;
    }

    const nameRegex = new RegExp(
      "(?<![^ [(_\\-.])(" +
        streamRequest.metadata.name
          .replace(/[^\w\s]/g, "[^\\w\\s]?")
          .replace(/ /g, "[ .\\-_]?") +
        (streamRequest.type === "movie"
          ? `[ .\\-_]?${streamRequest.metadata.year}`
          : "") +
        ")(?=[ \\)\\]_.-]|$)",
      "i",
    );

    const parsedFiles = parseAndFilterFiles(
      CONFIG.strictTitleCheck
        ? results.files.filter((file) => nameRegex.test(file.name))
        : results.files,
    );

    sortParsedFiles(parsedFiles);

    for (const parsedFile of parsedFiles) {
      streams.push(await createStream(parsedFile, accessToken, baseUrl));
    }

    return streams;
  }

  return {
    async fetch(request) {
      if (
        !/^[a-zA-Z0-9_-]{32,}$/.test(env.ADDON_TOKEN || "") ||
        !CONFIG.driveFolderIds.every((id) => /^[a-zA-Z0-9_-]+$/.test(id))
      ) {
        return createJsonResponse(
          { error: "Worker configuration required" },
          503,
        );
      }
      const url = new URL(request.url);
      const prefix = "/" + env.ADDON_TOKEN;
      if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) {
        return createJsonResponse({ error: "Not found" }, 404);
      }
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: HEADERS });
      if (!["GET", "HEAD"].includes(request.method))
        return createJsonResponse({ error: "Method not allowed" }, 405);
      const baseUrl = url.origin + prefix;
      url.pathname = url.pathname.slice(prefix.length) || "/";
      let response;
      try {
        response = await handleRequest(new Request(url, request), baseUrl);
      } catch {
        response = createJsonResponse({ error: "Service unavailable" }, 502);
      }
      if (request.method === "HEAD") return new Response(null, response);
      return response;
    },
  };
}

const instances = new WeakMap();
export default {
  fetch(request, env) {
    let addon = instances.get(env);
    if (!addon) {
      addon = createAddon(env);
      instances.set(env, addon);
    }
    return addon.fetch(request);
  },
};
