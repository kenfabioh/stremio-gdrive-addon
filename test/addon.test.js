import { test } from "node:test";
import assert from "node:assert/strict";
import { createAddon } from "../src/index.js";
import { matchSubtitle, TimedCache } from "../src/subtitles.js";

const token = "test_install_key_0123456789abcdefghijk";
const env = {
  CLIENT_ID: "test-client",
  CLIENT_SECRET: "test-secret",
  REFRESH_TOKEN: "test-refresh",
  ADDON_TOKEN: token,
  DRIVE_FOLDER_IDS: "folder",
  DRIVE_RECURSIVE: "false",
};
const base = `https://addon.example/${token}`;
const video = {
  id: "video",
  name: "Avatar.2009.mkv",
  parents: ["folder"],
  mimeType: "video/x-matroska",
  size: "5000000000",
  fileExtension: "mkv",
};
const sidecar = (id, name, parent = "folder") => ({
  id,
  name,
  parents: [parent],
  mimeType: "application/x-subrip",
});
const subs = [
  sidecar("plain", "Avatar.2009.srt"),
  sidecar("pt", "Avatar.2009.pt-BR.srt"),
  sidecar("en", "Avatar.2009.en.srt"),
  sidecar("wrong", "Avatar.2009.extended.en.srt"),
  sidecar("elsewhere", "Avatar.2009.es.srt", "other"),
];
const srt = "1\n00:00:01,000 --> 00:00:02,000\nOlá, mundo!\n";
function setup(t, overrides = {}) {
  const calls = [];
  const files = {
    video,
    folder: { id: "folder", mimeType: "application/vnd.google-apps.folder" },
    ...Object.fromEntries(subs.map((s) => [s.id, s])),
    private: { ...video, id: "private", parents: ["other"] },
    gone: { ...video, id: "gone", trashed: true },
    text: { ...video, id: "text", name: "notes.txt", mimeType: "text/plain" },
  };
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (overrides.handle) {
      const response = await overrides.handle(url, options);
      if (response) return response;
    }
    if (url.hostname === "oauth2.googleapis.com") {
      assert.equal(
        new URLSearchParams(options.body).get("grant_type"),
        "refresh_token",
      );
      return Response.json({
        access_token: "google-access-secret",
        expires_in: 3600,
      });
    }
    if (url.hostname === "v3-cinemeta.strem.io")
      return Response.json({ meta: { name: "Avatar", year: 2009 } });
    assert.ok(
      ["content.googleapis.com", "www.googleapis.com"].includes(url.hostname),
      url.toString(),
    );
    assert.equal(
      new Headers(options.headers).get("Authorization"),
      "Bearer google-access-secret",
    );
    if (url.searchParams.get("alt") === "media") {
      const id = url.pathname.split("/").at(-1);
      const range = new Headers(options.headers).get("Range");
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      if (range === "bytes=999-")
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": "bytes */100" },
        });
      const isSrt = id !== "video";
      return new Response(
        options.method === "HEAD" ? null : isSrt ? srt : "abc",
        {
          status: range ? 206 : 200,
          headers: {
            "Content-Type": isSrt ? "text/plain" : "video/x-matroska",
            "Content-Length": isSrt ? String(Buffer.byteLength(srt)) : "3",
            "Accept-Ranges": "bytes",
            ...(range ? { "Content-Range": "bytes 0-2/5000000000" } : {}),
          },
        },
      );
    }
    if (url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q");
      if (q.includes("in parents") && q.includes(".srt"))
        return Response.json({ files: subs });
      return Response.json({ files: [video] });
    }
    const file = files[url.pathname.split("/").at(-1)];
    return file ? Response.json(file) : new Response(null, { status: 404 });
  });
  const addon = createAddon({ ...env, ...overrides.env });
  return {
    addon,
    calls,
    request: (path, options) => addon.fetch(new Request(base + path, options)),
  };
}

test("filename matching: exact release, languages, case, and unrelated files", () => {
  for (const [name, lang] of [
    ["Avatar.2009.srt", "und"],
    ["Avatar.2009.pt-BR.srt", "por"],
    ["Avatar.2009.pt.srt", "por"],
    ["Avatar.2009.en.srt", "eng"],
    ["Avatar.2009.fr.srt", "fre"],
    ["AVATAR.2009.EN.SRT", "eng"],
    ["Avatar.2009.en.sdh.srt", "eng"],
  ]) {
    assert.equal(matchSubtitle(video.name, name)?.lang, lang);
  }
  for (const name of [
    "Avatar.2009.extended.en.srt",
    "Avatar.20090.srt",
    "Avatar.2009.en.ass",
    "Other.en.srt",
    "Avatar.2009.evil.srt",
  ])
    assert.equal(matchSubtitle(video.name, name), null);
  assert.equal(matchSubtitle("Show.S01E01.mkv", "Show.S01E02.en.srt"), null);
});

test("bounded cache deduplicates in-flight requests, expires and retries errors", async () => {
  let now = 0,
    loads = 0;
  const cache = new TimedCache(10, 2, () => now);
  const load = async () => ++loads;
  assert.deepEqual(
    await Promise.all([cache.get("a", load), cache.get("a", load)]),
    [1, 1],
  );
  now = 11;
  assert.equal(await cache.get("a", load), 2);
  await cache.get("b", load);
  await cache.get("c", load);
  assert.equal(cache.items.size, 2);
  await assert.rejects(
    cache.get("bad", () => {
      throw Error("network");
    }),
  );
  assert.equal(await cache.get("bad", load), 5);
});

test("protected manifest, redirect, CORS preflight, HEAD, and method rejection", async (t) => {
  const { addon, request, calls } = setup(t);
  assert.equal(
    (await addon.fetch(new Request("https://addon.example/manifest.json")))
      .status,
    404,
  );
  assert.equal(
    (
      await addon.fetch(
        new Request("https://addon.example/wrong/manifest.json"),
      )
    ).status,
    404,
  );
  const response = await request("/manifest.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const manifest = await response.json();
  assert.equal(manifest.id, "stremio.gdrive.worker");
  assert.ok(manifest.resources.some((r) => r.name === "subtitles"));
  assert.equal(manifest.catalogs.length, 2);
  const redirect = await request("/");
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get("location"), base + "/manifest.json");
  assert.equal(
    (await request("/manifest.json", { method: "HEAD" })).body,
    null,
  );
  const preflight = await request("/subtitle/pt/subtitle.srt", {
    method: "OPTIONS",
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /Range/);
  assert.equal(
    (await request("/manifest.json", { method: "POST" })).status,
    405,
  );
  assert.equal(calls.length, 0);
});

test("missing installation key fails closed", async () => {
  const addon = createAddon({ ...env, ADDON_TOKEN: "" });
  assert.equal(
    (await addon.fetch(new Request(base + "/manifest.json"))).status,
    503,
  );
});

test("catalog, meta, stream-specific subtitles and subtitle resource", async (t) => {
  const { request, calls } = setup(t);
  const catalog = await (
    await request("/catalog/movie/gdrive_list.json")
  ).json();
  assert.equal(catalog.metas[0].id, "gdrive:video");
  const meta = await (await request("/meta/movie/gdrive:video.json")).json();
  assert.equal(meta.meta.id, "gdrive:video");
  const response = await request("/stream/movie/gdrive:video.json");
  const raw = await response.text();
  assert.doesNotMatch(
    raw,
    /google-access-secret|test-secret|test-refresh|googleapis\.com/,
  );
  const stream = JSON.parse(raw).streams[0];
  assert.equal(stream.url, base + "/playback/video/Avatar.2009.mkv");
  assert.equal(stream.behaviorHints.filename, video.name);
  assert.deepEqual(
    stream.subtitles.map((s) => s.lang),
    ["und", "por", "eng"],
  );
  assert.ok(
    stream.subtitles.every(
      (s) => s.id && s.url.startsWith(base + "/subtitle/"),
    ),
  );
  assert.deepEqual(
    (await (await request("/subtitles/movie/gdrive:video.json")).json())
      .subtitles,
    stream.subtitles,
  );
  await request("/stream/movie/gdrive:video.json");
  assert.equal(
    calls.filter((c) => c.url.hostname === "oauth2.googleapis.com").length,
    1,
  );
  assert.equal(
    calls.filter((c) => c.url.searchParams.get("q")?.includes(".srt")).length,
    1,
  );
  assert.equal(
    calls.filter((c) => c.url.searchParams.get("alt") === "media").length,
    0,
  );
});

test("IMDb stream lookup preserves attached subtitles", async (t) => {
  const { request } = setup(t);
  const result = await (await request("/stream/movie/tt0499549.json")).json();
  assert.equal(result.streams[0].subtitles.length, 3);
});

test("subtitle handler uses filename and size for non-Drive IDs; absent filename returns empty", async (t) => {
  const { request } = setup(t);
  const extra = new URLSearchParams({
    filename: video.name,
    videoSize: video.size,
  });
  assert.equal(
    (await (await request(`/subtitles/movie/tt0499549/${extra}.json`)).json())
      .subtitles.length,
    3,
  );
  assert.deepEqual(
    await (await request("/subtitles/movie/tt0499549.json")).json(),
    { subtitles: [] },
  );
});

test("ambiguous duplicate filenames do not attach subtitles from another folder", async (t) => {
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.searchParams.get("q")?.includes("name ="))
        return Response.json({ files: [video, { ...video, id: "duplicate" }] });
    },
  });
  assert.deepEqual(
    await (
      await request("/subtitles/movie/tt0499549/filename=Avatar.2009.mkv.json")
    ).json(),
    { subtitles: [] },
  );
});

test("missing sidecars and subtitle list failures do not prevent streaming", async (t) => {
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.searchParams.get("q")?.includes(".srt"))
        return new Response(null, { status: 503 });
    },
  });
  const result = await (
    await request("/stream/movie/gdrive:video.json")
  ).json();
  assert.equal(result.streams.length, 1);
  assert.deepEqual(result.streams[0].subtitles, []);
});

test("empty subtitle folder remains valid and cached", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.searchParams.get("q")?.includes(".srt"))
        return Response.json({ files: [] });
    },
  });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      (await (await request("/stream/movie/gdrive:video.json")).json())
        .streams[0].subtitles,
      [],
    );
  assert.equal(
    calls.filter((c) => c.url.searchParams.get("q")?.includes(".srt")).length,
    1,
  );
});

test("paginated subtitle folders include later-page languages", async (t) => {
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.searchParams.get("q")?.includes(".srt"))
        return Response.json(
          url.searchParams.has("pageToken")
            ? { files: [subs[2]] }
            : { files: [subs[0]], nextPageToken: "page2" },
        );
    },
  });
  const result = await (
    await request("/subtitles/movie/gdrive:video.json")
  ).json();
  assert.deepEqual(
    result.subtitles.map((s) => s.lang),
    ["und", "eng"],
  );
});

test("serves protected SRT with CORS without exposing OAuth", async (t) => {
  const { addon, request, calls } = setup(t);
  const unauthorized = await addon.fetch(
    new Request("https://addon.example/subtitle/pt/subtitle.srt"),
  );
  assert.equal(unauthorized.status, 404);
  assert.equal(calls.length, 0);
  const response = await request("/subtitle/pt/subtitle.srt");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/x-subrip");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await response.text(), srt);
  assert.equal(response.headers.get("Authorization"), null);
});

test("video streams Range and HEAD with original status and headers; 416 preserved", async (t) => {
  const { request, calls } = setup(t);
  const response = await request("/playback/video/Avatar.2009.mkv", {
    headers: { Range: "bytes=0-2", "If-Range": "etag" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 0-2/5000000000");
  assert.equal(response.headers.get("Content-Length"), "3");
  assert.equal(response.headers.get("Content-Type"), "video/x-matroska");
  assert.equal(await response.text(), "abc");
  const upstream = calls.find((c) => c.url.searchParams.get("alt") === "media");
  assert.equal(new Headers(upstream.options.headers).get("If-Range"), "etag");
  const head = await request("/playback/video/Avatar.2009.mkv", {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  const invalid = await request("/playback/video/Avatar.2009.mkv", {
    headers: { Range: "bytes=999-" },
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("Content-Range"), "bytes */100");
});

test("folder restrictions, deleted and non-media files cannot be served by guessing IDs", async (t) => {
  const { request, calls } = setup(t);
  for (const id of ["private", "gone", "text", "nonexistent"])
    assert.equal((await request(`/playback/${id}/x.mkv`)).status, 404);
  assert.equal((await request("/subtitle/video/subtitle.srt")).status, 404);
  assert.equal(
    (await request("/stream/movie/gdrive:private.json")).status,
    404,
  );
  assert.equal(
    calls.filter((c) => c.url.searchParams.get("alt") === "media").length,
    0,
  );
});

test("Google errors do not leak response bodies, keys, or crash error parsing", async (t) => {
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.hostname === "oauth2.googleapis.com")
        throw Error("private-secret-response");
    },
  });
  const response = await request("/stream/movie/gdrive:video.json");
  assert.doesNotMatch(
    await response.text(),
    /private-secret-response|test-secret|test-refresh/,
  );
});

test("media redirects strip OAuth and preserve Range; unrelated hosts are rejected", async (t) => {
  let signedCalls = 0;
  const { request } = setup(t, {
    handle: async (url, options) => {
      if (url.searchParams.get("alt") === "media")
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://download.googleusercontent.com/signed-media",
          },
        });
      if (url.hostname === "download.googleusercontent.com") {
        signedCalls++;
        assert.equal(new Headers(options.headers).get("Authorization"), null);
        assert.equal(new Headers(options.headers).get("Range"), "bytes=0-2");
        assert.equal(options.redirect, "manual");
        return new Response("abc", {
          status: 206,
          headers: { "Content-Range": "bytes 0-2/100" },
        });
      }
    },
  });
  assert.equal(
    (
      await request("/playback/video/x.mkv", {
        headers: { Range: "bytes=0-2" },
      })
    ).status,
    206,
  );
  assert.equal(signedCalls, 1);
});

test("untrusted Drive download redirect is not followed or exposed", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.searchParams.get("alt") === "media")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/steal" },
        });
    },
  });
  const response = await request("/playback/video/x.mkv");
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /attacker|access-secret/);
  assert.ok(!calls.some((c) => c.url.hostname === "attacker.example"));
});

test("proxy forwards a live stream without waiting for the full video", async (t) => {
  let cancelled = false;
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.searchParams.get("alt") === "media")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first chunk"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "video/mp4" } },
        );
    },
  });
  const response = await request("/playback/video/x.mkv");
  const reader = response.body.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "first chunk",
  );
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("video catalog paginates and escaped search preserves special characters", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      const q = url.searchParams.get("q");
      if (url.pathname === "/drive/v3/files" && q && !q.includes(".srt")) {
        return Response.json(
          url.searchParams.has("pageToken")
            ? { files: [{ ...video, id: "v2" }] }
            : { files: [video], nextPageToken: "next" },
        );
      }
    },
  });
  const list = await (await request("/catalog/movie/gdrive_list.json")).json();
  assert.deepEqual(
    list.metas.map((m) => m.id),
    ["gdrive:video", "gdrive:v2"],
  );
  const term = "L'été 100% = yes";
  const response = await request(
    `/catalog/movie/gdrive_search/search=${encodeURIComponent(term)}.json`,
  );
  assert.equal(response.status, 200);
  const search = calls.find((c) =>
    c.url.searchParams.get("q")?.includes("100%"),
  );
  assert.ok(search);
  assert.ok(search.url.searchParams.get("q").includes("L\\'été 100% = yes"));
});

test("origins remain request-local when concurrent streams share a Worker instance", async (t) => {
  const { addon } = setup(t);
  const results = await Promise.all(
    ["first.example", "second.example"].map(async (host) => {
      const response = await addon.fetch(
        new Request(`https://${host}/${token}/stream/movie/gdrive:video.json`),
      );
      return { host, body: await response.json() };
    }),
  );
  for (const { host, body } of results) {
    assert.equal(new URL(body.streams[0].url).hostname, host);
    assert.ok(
      body.streams[0].subtitles.every((s) => new URL(s.url).hostname === host),
    );
  }
});

test("Drive pagination continues through empty pages with a nextPageToken", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.pathname !== "/drive/v3/files") return;
      const page = url.searchParams.get("pageToken");
      if (!page)
        return Response.json({ files: [], nextPageToken: "empty-page" });
      if (page === "empty-page")
        return Response.json({ nextPageToken: "video-page" });
      assert.equal(page, "video-page");
      return Response.json({ files: [video] });
    },
  });
  const result = await (
    await request("/catalog/movie/gdrive_list.json")
  ).json();
  assert.deepEqual(
    result.metas.map((m) => m.id),
    ["gdrive:video"],
  );
  assert.equal(
    calls.filter((c) => c.url.pathname === "/drive/v3/files").length,
    3,
  );
});

test("Drive repeated pagination token fails safely without looping", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.pathname === "/drive/v3/files")
        return Response.json({ files: [], nextPageToken: "repeat" });
    },
  });
  const response = await request("/catalog/movie/gdrive_list.json");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "Service unavailable");
  assert.equal(
    calls.filter((c) => c.url.pathname === "/drive/v3/files").length,
    2,
  );
});

function recursiveSetup(t, extra = {}) {
  const deepVideo = { ...video, parents: ["season"] };
  const deepSubs = subs.map((s) => ({
    ...s,
    parents: s.id === "elsewhere" ? ["other"] : ["season"],
  }));
  const graph = [
    {
      id: "series",
      parents: ["folder"],
      mimeType: "application/vnd.google-apps.folder",
    },
    {
      id: "season",
      parents: ["series"],
      mimeType: "application/vnd.google-apps.folder",
    },
  ];
  return setup(t, {
    env: { DRIVE_RECURSIVE: undefined, ...extra.env },
    handle: async (url, options) => {
      const q = url.searchParams.get("q");
      if (q?.includes("application/vnd.google-apps.folder")) {
        if (extra.folderError) return new Response(null, { status: 503 });
        const ids = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
        return Response.json({
          files: graph.filter((f) => f.parents.some((p) => ids.includes(p))),
        });
      }
      if (url.searchParams.get("alt") === "media") return;
      if (url.pathname.endsWith("/video")) return Response.json(deepVideo);
      const sidecar = deepSubs.find((s) => url.pathname.endsWith("/" + s.id));
      if (sidecar) return Response.json(sidecar);
      if (q?.includes(".srt")) return Response.json({ files: deepSubs });
      if (url.pathname === "/drive/v3/files")
        return Response.json({
          files: q?.includes("'season' in parents") ? [deepVideo] : [],
        });
    },
  });
}

test("default recursion covers nested catalog/search/IMDb streams, metadata, subtitles and playback", async (t) => {
  const { request, calls } = recursiveSetup(t);
  for (const path of [
    "/catalog/movie/gdrive_list.json",
    "/catalog/movie/gdrive_search/search=Avatar.json",
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).metas[0].id, "gdrive:video");
  }
  assert.equal(
    (await (await request("/meta/movie/gdrive:video.json")).json()).meta.id,
    "gdrive:video",
  );
  for (const path of [
    "/stream/movie/gdrive:video.json",
    "/stream/movie/tt0499549.json",
  ]) {
    const result = await (await request(path)).json();
    assert.equal(result.streams[0].subtitles.length, 3);
  }
  assert.equal(
    (await (await request("/subtitles/movie/gdrive:video.json")).json())
      .subtitles.length,
    3,
  );
  assert.equal(
    (
      await (
        await request(
          "/subtitles/movie/tt0499549/filename=Avatar.2009.mkv.json",
        )
      ).json()
    ).subtitles.length,
    3,
  );
  assert.equal(
    (
      await request("/playback/video/x.mkv", {
        headers: { Range: "bytes=0-2" },
      })
    ).status,
    206,
  );
  assert.equal(await (await request("/subtitle/pt/subtitle.srt")).text(), srt);
  assert.equal((await request("/playback/private/x.mkv")).status, 404);
  assert.equal((await request("/subtitle/elsewhere/subtitle.srt")).status, 404);
  assert.equal(
    calls.filter((c) =>
      c.url.searchParams
        .get("q")
        ?.includes("application/vnd.google-apps.folder"),
    ).length,
    3,
  );
});

test("explicit direct-only setting excludes videos in nested folders", async (t) => {
  const { request, calls } = recursiveSetup(t, {
    env: { DRIVE_RECURSIVE: "false" },
  });
  assert.deepEqual(
    await (await request("/catalog/movie/gdrive_list.json")).json(),
    { metas: [] },
  );
  assert.equal((await request("/stream/movie/gdrive:video.json")).status, 404);
  assert.equal(
    calls.filter((c) =>
      c.url.searchParams
        .get("q")
        ?.includes("application/vnd.google-apps.folder"),
    ).length,
    0,
  );
});

test("recursive listing and playback fail closed when folder discovery is unavailable", async (t) => {
  const { request, calls } = recursiveSetup(t, { folderError: true });
  assert.equal((await request("/catalog/movie/gdrive_list.json")).status, 502);
  assert.equal((await request("/playback/video/x.mkv")).status, 502);
  assert.equal(
    calls.filter((c) => c.url.searchParams.get("alt") === "media").length,
    0,
  );
});

test("recursive catalog keeps global newest-first order across folder batches at the file limit", async (t) => {
  const graph = Array.from({ length: 51 }, (_, i) => ({
    id: "child" + i,
    parents: ["folder"],
    mimeType: "application/vnd.google-apps.folder",
  }));
  const { request } = setup(t, {
    env: { DRIVE_RECURSIVE: undefined },
    handle: async (url) => {
      const q = url.searchParams.get("q");
      if (q?.includes("application/vnd.google-apps.folder"))
        return Response.json({
          files: q.includes("'folder' in parents") ? graph : [],
        });
      if (url.pathname === "/drive/v3/files") {
        if (q.includes("'child50' in parents"))
          return Response.json({
            files: [
              { ...video, id: "newest", createdTime: "2026-01-01T00:00:00Z" },
            ],
          });
        return Response.json({
          files: Array.from({ length: 1000 }, (_, i) => ({
            ...video,
            id: "old" + i,
            createdTime: "2020-01-01T00:00:00Z",
          })),
        });
      }
    },
  });
  const result = await (
    await request("/catalog/movie/gdrive_list.json")
  ).json();
  assert.equal(result.metas.length, 1000);
  assert.equal(result.metas[0].id, "gdrive:newest");
});

test("catalog uses the recommended Drive modifiedTime order and requests that field", async (t) => {
  const { request, calls } = setup(t);
  assert.equal((await request("/catalog/movie/gdrive_list.json")).status, 200);
  const list = calls.find((c) => c.url.pathname === "/drive/v3/files");
  assert.equal(list.url.searchParams.get("orderBy"), "modifiedTime desc");
  assert.match(list.url.searchParams.get("fields"), /modifiedTime/);
});

test("Drive API failures return an error instead of an empty successful catalog", async (t) => {
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.pathname === "/drive/v3/files")
        return new Response("private upstream detail test-secret", {
          status: 503,
        });
    },
  });
  const response = await request("/catalog/movie/gdrive_list.json");
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /test-secret|private upstream/);
  assert.equal(JSON.parse(body).error, "Service unavailable");
  assert.equal(JSON.parse(body).upstreamStatus, 503);
  assert.equal(JSON.parse(body).code, "DRIVE_API_ERROR");
});

test("subrequest limit diagnostics contain no raw error details or credentials", async (t) => {
  const { request } = setup(t, {
    handle: async (url) => {
      if (url.pathname === "/drive/v3/files")
        throw Error("Too many subrequests. private test-secret");
    },
  });
  const response = await request("/catalog/movie/gdrive_list.json");
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.doesNotMatch(body, /private|test-secret/);
  assert.equal(JSON.parse(body).code, "WORKER_SUBREQUEST_LIMIT");
  assert.equal(JSON.parse(body).pagesRead, 1);
});

test("catalog retries Google 5xx once without sorting and sorts returned videos locally", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.pathname !== "/drive/v3/files") return;
      if (url.searchParams.has("orderBy"))
        return new Response(null, { status: 500 });
      return Response.json({
        files: [
          { ...video, id: "old", modifiedTime: "2020-01-01T00:00:00Z" },
          { ...video, id: "new", modifiedTime: "2026-01-01T00:00:00Z" },
        ],
      });
    },
  });
  const response = await request("/catalog/movie/gdrive_list.json");
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).metas.map((m) => m.id),
    ["gdrive:new", "gdrive:old"],
  );
  const queries = calls.filter((c) => c.url.pathname === "/drive/v3/files");
  assert.equal(queries.length, 2);
  assert.equal(queries[0].url.searchParams.get("orderBy"), "modifiedTime desc");
  assert.equal(queries[1].url.searchParams.has("orderBy"), false);
  assert.equal(
    queries[1].url.searchParams.get("q"),
    queries[0].url.searchParams.get("q"),
  );
});

test("catalog does not retry authentication errors or change scope on failure", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.pathname === "/drive/v3/files")
        return new Response(null, { status: 403 });
    },
  });
  const response = await request("/catalog/movie/gdrive_list.json");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).upstreamStatus, 403);
  assert.equal(
    calls.filter((c) => c.url.pathname === "/drive/v3/files").length,
    1,
  );
});

test("catalog fallback targets the shared drive of its configured root", async (t) => {
  const { request, calls } = setup(t, {
    handle: async (url) => {
      if (url.pathname === "/drive/v3/files/folder")
        return Response.json({
          id: "folder",
          mimeType: "application/vnd.google-apps.folder",
          driveId: "sharedDrive",
        });
      if (url.pathname === "/drive/v3/files") {
        if (url.searchParams.get("corpora") === "allDrives")
          return new Response(null, { status: 500 });
        assert.equal(url.searchParams.get("corpora"), "drive");
        assert.equal(url.searchParams.get("driveId"), "sharedDrive");
        assert.equal(url.searchParams.has("orderBy"), false);
        return Response.json({ files: [video] });
      }
    },
  });
  const response = await request("/catalog/movie/gdrive_list.json");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).metas[0].id, "gdrive:video");
  const lists = calls.filter((c) => c.url.pathname === "/drive/v3/files");
  assert.equal(
    lists[0].url.searchParams.get("q"),
    lists[1].url.searchParams.get("q"),
  );
});

test("failed broad queries recover in small folder batches and the successful catalog is cached", async (t) => {
  const graph = Array.from({ length: 6 }, (_, i) => ({
    id: "child" + i,
    parents: ["folder"],
    mimeType: "application/vnd.google-apps.folder",
  }));
  const { request, calls } = setup(t, {
    env: { DRIVE_RECURSIVE: undefined },
    handle: async (url) => {
      const q = url.searchParams.get("q");
      if (url.pathname === "/drive/v3/files/folder")
        return Response.json({
          id: "folder",
          mimeType: "application/vnd.google-apps.folder",
          driveId: "sharedDrive",
        });
      if (q?.includes("application/vnd.google-apps.folder"))
        return Response.json({
          files: q.includes("'folder' in parents") ? graph : [],
        });
      if (url.pathname === "/drive/v3/files") {
        if (url.searchParams.get("corpora") === "allDrives")
          return new Response(null, { status: 500 });
        const parents = [...q.matchAll(/'([^']+)' in parents/g)].map(
          (m) => m[1],
        );
        assert.ok(parents.length <= 5);
        assert.equal(url.searchParams.get("driveId"), "sharedDrive");
        return Response.json({
          files: parents
            .filter((id) => id !== "folder")
            .map((id) => ({ ...video, id: "video_" + id, parents: [id] })),
        });
      }
    },
  });
  const first = await (await request("/catalog/movie/gdrive_list.json")).json();
  assert.equal(first.metas.length, 6);
  const reads = calls.length;
  assert.deepEqual(
    await (await request("/catalog/movie/gdrive_list.json")).json(),
    first,
  );
  assert.equal(calls.length, reads);
  assert.equal(
    calls.filter((c) => c.url.searchParams.get("corpora") === "drive").length,
    2,
  );
});
