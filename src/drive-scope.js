import { TimedCache } from "./subtitles.js";

const FOLDER = "application/vnd.google-apps.folder";
const BATCH_SIZE = 50;
export const parentQuery = (ids) =>
  `(${ids.map((id) => `'${id}' in parents`).join(" or ")})`;

// Drive's parent filter is not recursive: discover actual child folders first.
// Build the complete scope before exposing any results. Fail closed on limits/errors.
export function createDriveScope({ roots, recursive = true, getToken }) {
  const cache = new TimedCache(300_000, 1);
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
  return {
    folders,
    async allows(parents = []) {
      if (!roots.length) return true;
      const allowed = await folders();
      return parents.some((id) => allowed.has(id));
    },
    async queries(query) {
      if (!roots.length) return [query];
      const ids = [...(await folders())];
      const queries = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE)
        queries.push(
          `${query} and ${parentQuery(ids.slice(i, i + BATCH_SIZE))}`,
        );
      return queries;
    },
  };
}
