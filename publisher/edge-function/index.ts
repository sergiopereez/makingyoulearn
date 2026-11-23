// Supabase Edge Function «tiktok-publisher»: small backend for the Making You Learn
// Publisher web page. TikTok's API has no CORS, and the client secret must never reach
// the browser, so the page calls this function, which forwards to TikTok.
// The client key/secret are read from the private storage bucket tt-auth/tt-app.json.
const ORIGIN = "https://sergiopereez.github.io";
const REDIRECT = "https://sergiopereez.github.io/makingyoulearn/publisher/";
const API = "https://open.tiktokapis.com/v2";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "content-type,x-tt-token,x-upload-url,content-range",
  "Access-Control-Allow-Methods": "POST,PUT,OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

let app: { client_key: string; client_secret: string } | null = null;
async function getApp() {
  if (app) return app;
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const r = await fetch(`${url}/storage/v1/object/tt-auth/tt-app.json`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  });
  app = await r.json();
  return app!;
}

async function tt(path: string, token: string, body: unknown) {
  const r = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body ?? {}),
  });
  return json(await r.json(), r.status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const action = new URL(req.url).searchParams.get("action");
  const token = req.headers.get("x-tt-token") ?? "";

  if (action === "config") {
    const a = await getApp();
    return json({ client_key: a.client_key, redirect_uri: REDIRECT });
  }
  if (action === "exchange") {
    const { code } = await req.json();
    const a = await getApp();
    const r = await fetch(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: a.client_key, client_secret: a.client_secret, code,
        grant_type: "authorization_code", redirect_uri: REDIRECT,
      }),
    });
    const t = await r.json();
    // Only the short-lived access token goes back to the page; the refresh token is dropped.
    return json({ access_token: t.access_token, expires_in: t.expires_in, scope: t.scope, error: t.error, error_description: t.error_description }, r.status);
  }
  if (action === "creator_info") return tt("post/publish/creator_info/query/", token, {});
  if (action === "init") return tt("post/publish/video/init/", token, await req.json());
  if (action === "inbox") return tt("post/publish/inbox/video/init/", token, await req.json());
  if (action === "status") return tt("post/publish/status/fetch/", token, await req.json());
  if (action === "upload") {
    const target = req.headers.get("x-upload-url") ?? "";
    if (!target.startsWith("https://open-upload.tiktokapis.com/")) return json({ error: "bad upload url" }, 400);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const r = await fetch(target, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Range": req.headers.get("content-range") ?? "" },
      body: bytes,
    });
    return json({ status: r.status, body: await r.text() }, r.ok ? 200 : r.status);
  }
  return json({ error: "unknown action" }, 400);
});
