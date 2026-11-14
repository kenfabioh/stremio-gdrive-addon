import { TimedCache } from "./subtitles.js";

const FOLDER = "application/vnd.google-apps.folder";
const BATCH_SIZE = 50;
export const parentQuery = (ids) =>
  `(${ids.map((id) => `'${id}' in parents`).join(" or ")})`;

// Drive's parent filter is not recursive: discover actual child folders first.
// Build the complete scope before exposing any results. Fail closed on limits/errors.
export function createDriveScope({ roots, recursive = true, getToken }) {
  const cache = new TimedCache(300_000, 1);
  const corpusCache = new TimedCache(300_000, 1);
  async function folders() {
    if (!roots.length || !recursive) return new Set(roots);
    return cache.get("tree", async () => {
      const found = new Set(roots);
      let frontier = [...found];
      let requests = 0;
      const token = await getToken();
      if (!token) throw new Error("Google authentication unavailable");
      while (frontier.length) {
        const next = [];
        for (let offset = 0; offset < frontier.length; offset += BATCH_SIZE) {
          const parents = frontier.slice(offset, offset + BATCH_SIZE);
          const parentSet = new Set(parents);
          const url = new URL("https://content.googleapis.com/drive/v3/files");
          url.search = new URLSearchParams({
            q: `trashed=false and mimeType='${FOLDER}' and ${parentQuery(parents)}`,
            corpora: "allDrives",
            includeItemsFromAllDrives: "true",
            supportsAllDrives: "true",
            pageSize: "1000",
            fields: "nextPageToken,incompleteSearch,files(id,parents,mimeType)",
          });
          const pages = new Set();
          do {
            if (++requests > 24)
              throw new Error("Folder discovery request limit exceeded");
            const response = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!response.ok) throw new Error("Folder discovery failed");
            const data = await response.json();
            if (data.incompleteSearch)
              throw new Error("Folder discovery incomplete");
            for (const folder of data.files || []) {
              if (
                folder.mimeType !== FOLDER ||
                !folder.parents?.some((id) => parentSet.has(id))
              )
                continue;
              if (!/^[a-zA-Z0-9_-]+$/.test(folder.id))
                throw new Error("Invalid folder id");
              if (found.has(folder.id)) continue;
              found.add(folder.id);
              next.push(folder.id);
              if (found.size > 1000)
                throw new Error("Folder discovery size limit exceeded");
            }
            if (!data.nextPageToken) break;
            if (pages.has(data.nextPageToken))
              throw new Error("Repeated folder page token");
            pages.add(data.nextPageToken);
            url.searchParams.set("pageToken", data.nextPageToken);
          } while (true);
        }
        frontier = next;
      }
      return found;
    });
  }
  async function batches(query) {
    if (!roots.length) return [{ query, parents: null }];
    const ids = [...(await folders())];
    const result = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const parents = ids.slice(i, i + BATCH_SIZE);
      result.push({ query: `${query} and ${parentQuery(parents)}`, parents });
    }
    return result;
  }
  return {
    folders,
    async fallbackCorpora() {
      if (!roots.length) return [{ corpora: "allDrives" }];
      return corpusCache.get("corpora", async () => {
        const token = await getToken();
        if (!token) throw new Error("Google authentication unavailable");
        const corpora = new Map();
        for (const id of new Set(roots)) {
          const url = new URL(
            `https://content.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
          );
          url.search = new URLSearchParams({
            fields: "id,mimeType,driveId,trashed",
            supportsAllDrives: "true",
          });
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok)
            throw Object.assign(new Error("Root folder metadata unavailable"), {
              upstreamStatus: response.status,
            });
          const folder = await response.json();
          if (folder.trashed || folder.mimeType !== FOLDER)
            throw new Error("Invalid root folder");
          if (folder.driveId) {
            if (!/^[a-zA-Z0-9_-]+$/.test(folder.driveId))
              throw new Error("Invalid drive id");
            corpora.set(folder.driveId, {
              corpora: "drive",
              driveId: folder.driveId,
            });
          } else corpora.set("user", { corpora: "user" });
        }
        return [...corpora.values()];
      });
    },
    async allows(parents = []) {
      if (!roots.length) return true;
      const allowed = await folders();
      return parents.some((id) => allowed.has(id));
    },
    batches,
    async queries(query) {
      return (await batches(query)).map((batch) => batch.query);
    },
  };
}
