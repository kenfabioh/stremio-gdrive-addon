import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MFResponse,
} from "miniflare";

// This test uses workerd (the actual Cloudflare runtime), not Node's fetch shim.
test(
  "workerd: authenticated stream -> sidecar download and Range proxy",
  { timeout: 30000 },
  async () => {
    const token = "runtime_test_key_0123456789abcdefghij";
    const video = {
      id: "v",
      name: "Movie.mkv",
      parents: ["folder"],
      mimeType: "video/x-matroska",
      fileExtension: "mkv",
      size: "5000000000",
    };
    const sidecar = {
      id: "s",
      name: "Movie.pt-BR.srt",
      parents: ["folder"],
      mimeType: "application/x-subrip",
    };
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nOlá!\n";
    const json = (data) =>
      new MFResponse(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: [
          { type: "ESModule", path: "src/index.js" },
          { type: "ESModule", path: "src/subtitles.js" },
        ],
        compatibilityDate: "2026-11-14",
        compatibilityFlags: ["nodejs_compat"],
        cf: false,
        bindings: {
          ADDON_TOKEN: token,
          CLIENT_ID: "client",
          CLIENT_SECRET: "secret",
          REFRESH_TOKEN: "refresh",
          DRIVE_FOLDER_IDS: "folder",
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.hostname === "oauth2.googleapis.com")
            return json({ access_token: "access", expires_in: 3600 });
          assert.equal(request.headers.get("Authorization"), "Bearer access");
          if (url.searchParams.get("alt") === "media") {
            if (url.pathname.endsWith("/s")) return new MFResponse(srt);
            assert.equal(request.headers.get("Range"), "bytes=0-2");
            return new MFResponse("abc", {
              status: 206,
              headers: {
                "Content-Range": "bytes 0-2/5000000000",
                "Content-Length": "3",
                "Content-Type": "video/x-matroska",
              },
            });
          }
          if (url.pathname.endsWith("/v")) return json(video);
          if (url.pathname.endsWith("/s")) return json(sidecar);
          if (url.pathname === "/drive/v3/files")
            return json({ files: [sidecar] });
          throw Error("Unexpected outbound request");
        },
      }),
    );
    try {
      const base = `https://worker.example/${token}`;
      assert.equal(
        (await mf.dispatchFetch("https://worker.example/manifest.json")).status,
        404,
      );
      const manifest = await (
        await mf.dispatchFetch(base + "/manifest.json")
      ).json();
      assert.ok(manifest.resources.some((r) => r.name === "subtitles"));
      const { streams } = await (
        await mf.dispatchFetch(base + "/stream/movie/gdrive:v.json")
      ).json();
      assert.equal(streams[0].subtitles[0].lang, "por");
      const sub = await mf.dispatchFetch(streams[0].subtitles[0].url);
      assert.equal(sub.status, 200);
      assert.equal(await sub.text(), srt);
      const response = await mf.dispatchFetch(streams[0].url, {
        headers: { Range: "bytes=0-2" },
      });
      assert.equal(response.status, 206);
      assert.equal(await response.text(), "abc");
      assert.equal(
        response.headers.get("Content-Range"),
        "bytes 0-2/5000000000",
      );
    } finally {
      await mf.dispose();
    }
  },
);
