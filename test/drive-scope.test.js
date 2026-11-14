import { test } from "node:test";
import assert from "node:assert/strict";
import { createDriveScope } from "../src/drive-scope.js";
const MIME = "application/vnd.google-apps.folder";
const folder = (id, ...parents) => ({ id, parents, mimeType: MIME });
function fixture(t, graph, options = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (options.reply) return options.reply(url);
    const ids = [
      ...url.searchParams.get("q").matchAll(/'([^']+)' in parents/g),
    ].map((m) => m[1]);
    return Response.json({
      files: graph.filter((f) => f.parents.some((p) => ids.includes(p))),
    });
  });
  return {
    scope: createDriveScope({
      roots: ["root"],
      getToken: async () => "fake",
      ...options,
    }),
    calls,
  };
}

test("recursive scope discovers series/seasons, deduplicates cycles and caches traversal", async (t) => {
  const { scope, calls } = fixture(t, [
    folder("series", "root"),
    folder("season", "series"),
    folder("root", "season"),
    folder("elsewhere", "unrelated"),
  ]);
  assert.deepEqual([...(await scope.folders())], ["root", "series", "season"]);
  assert.equal(await scope.allows(["season"]), true);
  assert.equal(await scope.allows(["unrelated"]), false);
  assert.equal(await scope.allows([]), false);
  await Promise.all([scope.queries("video"), scope.queries("video")]);
  assert.equal(calls.length, 3);
});

test("recursive scope follows empty discovery pages and rejects incomplete results", async (t) => {
  const { scope } = fixture(t, [], {
    reply: (url) => {
      const q = url.searchParams.get("q");
      if (q.includes("'root' in parents") && !url.searchParams.has("pageToken"))
        return Response.json({ nextPageToken: "next" });
      if (q.includes("'root' in parents"))
        return Response.json({ files: [folder("child", "root")] });
      return Response.json({ files: [] });
    },
  });
  assert.equal(await scope.allows(["child"]), true);
});

test("scope never widens access if folder discovery fails; failed results can be retried", async (t) => {
  let attempts = 0;
  const { scope } = fixture(t, [], {
    reply: () =>
      ++attempts === 1
        ? new Response(null, { status: 503 })
        : Response.json({ files: [] }),
  });
  await assert.rejects(scope.queries("video"), /discovery failed/);
  assert.deepEqual(await scope.queries("video"), [
    "video and ('root' in parents)",
  ]);
});

test("incomplete discovery is rejected rather than cached as an incomplete scope", async (t) => {
  const { scope } = fixture(t, [], {
    reply: () => Response.json({ files: [], incompleteSearch: true }),
  });
  await assert.rejects(scope.folders(), /incomplete/);
});

test("discovery batches broad folder trees and media filters into bounded URL sizes", async (t) => {
  const children = Array.from({ length: 105 }, (_, i) =>
    folder("child" + i, "root"),
  );
  const { scope, calls } = fixture(t, children);
  const queries = await scope.queries("video");
  assert.equal(queries.length, 3);
  for (const q of queries)
    assert.ok([...q.matchAll(/in parents/g)].length <= 50);
  assert.equal(calls.length, 4); // one root request + 3 batches of leaf folders
  assert.equal(await scope.allows(["child104"]), true);
});

test("direct-only mode and unrestricted mode avoid folder discovery", async (t) => {
  const { scope, calls } = fixture(t, [], { recursive: false });
  assert.equal(await scope.allows(["root"]), true);
  assert.equal(await scope.allows(["child"]), false);
  const unrestricted = createDriveScope({
    roots: [],
    getToken: async () => {
      throw Error("unused");
    },
  });
  assert.deepEqual(await unrestricted.queries("video"), ["video"]);
  assert.equal(await unrestricted.allows(["anywhere"]), true);
  assert.equal(calls.length, 0);
});

test("shortcuts and unrelated folders are not treated as authorized descendants", async (t) => {
  const { scope } = fixture(t, [
    {
      id: "shortcut",
      parents: ["root"],
      mimeType: "application/vnd.google-apps.shortcut",
    },
    folder("outside", "different"),
  ]);
  assert.deepEqual([...(await scope.folders())], ["root"]);
  assert.equal(await scope.allows(["shortcut"]), false);
});

test("excessively deep discovery stops with an error rather than silently truncating", async (t) => {
  const graph = Array.from({ length: 30 }, (_, i) =>
    folder("level" + i, i ? "level" + (i - 1) : "root"),
  );
  const { scope, calls } = fixture(t, graph);
  await assert.rejects(scope.folders(), /request limit/);
  assert.equal(calls.length, 24);
});

test("fallback corpora identify personal and shared roots, deduplicate drives and cache metadata", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    reads++;
    const id = new URL(input).pathname.split("/").at(-1);
    return Response.json({
      id,
      mimeType: MIME,
      ...(id === "personal" ? {} : { driveId: "sharedDrive" }),
    });
  });
  const scope = createDriveScope({
    roots: ["personal", "shared1", "shared2"],
    getToken: async () => "fake",
  });
  assert.deepEqual(await scope.fallbackCorpora(), [
    { corpora: "user" },
    { corpora: "drive", driveId: "sharedDrive" },
  ]);
  await scope.fallbackCorpora();
  assert.equal(reads, 3);
});
