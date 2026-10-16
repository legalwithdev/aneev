// Cloudflare Pages Function — secure server-side proxy for data.gov.in
// (Open Government Data Platform India, NIC / MeitY).
//
// WHY THIS EXISTS
//   data.gov.in needs your API key as a URL query parameter (?api-key=...).
//   If that call is made from the browser, the key is PUBLIC (anyone can open
//   DevTools → Network and read it). This function keeps the key on the server,
//   so the browser only ever talks to /api/gov-data and never sees the key.
//
// SET THESE IN CLOUDFLARE PAGES (Settings → Environment variables, Production):
//   DATAGOVIN_API_KEY      = your data.gov.in API key   (mark as Secret / encrypt)
//   DATAGOVIN_RESOURCE_ID  = the dataset UUID from its data.gov.in page
//   (optional) DATAGOVIN_FIELDS = comma-separated field ids to return
//
// After adding/changing env vars, redeploy the Pages project for them to apply.

export async function onRequestGet(context) {
  const { env, request } = context;

  const key = env.DATAGOVIN_API_KEY;
  const resource = env.DATAGOVIN_RESOURCE_ID;

  // Not configured yet -> tell the client clearly, without leaking anything.
  if (!key || !resource) {
    return json({ ok: false, error: "not_configured" }, 503);
  }
  // Basic guard so a bad value can't be used to hit arbitrary paths.
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(resource)) {
    return json({ ok: false, error: "bad_resource_id" }, 400);
  }

  const url = new URL(request.url);
  const limit = clamp(url.searchParams.get("limit"), 25, 1, 100);
  const offset = clamp(url.searchParams.get("offset"), 0, 0, 100000);

  const api = new URL("https://api.data.gov.in/resource/" + resource);
  api.searchParams.set("api-key", key);
  api.searchParams.set("format", "json");
  api.searchParams.set("limit", String(limit));
  api.searchParams.set("offset", String(offset));
  if (env.DATAGOVIN_FIELDS) api.searchParams.set("fields", env.DATAGOVIN_FIELDS);

  try {
    const res = await fetch(api.toString(), {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
    if (!res.ok) {
      return json({ ok: false, error: "upstream_" + res.status }, 502);
    }
    const data = await res.json();

    const records = Array.isArray(data.records) ? data.records.slice(0, 100) : [];
    const fields = Array.isArray(data.field)
      ? data.field.map((f) => (typeof f === "string" ? f : f && f.id)).filter(Boolean)
      : [];

    const out = {
      ok: true,
      title: data.title || data.desc || "",
      total: Number.isFinite(Number(data.total)) ? Number(data.total) : records.length,
      count: records.length,
      fields,
      records,
      source: "data.gov.in — Open Government Data Platform India",
      license: "Government Open Data Licence (GODL) — India",
      fetched_at: new Date().toISOString(),
    };
    // Cache at the edge: open data is periodic, not real-time.
    return json(out, 200, { "cache-control": "public, max-age=3600" });
  } catch (e) {
    return json({ ok: false, error: "fetch_failed" }, 502);
  }
}

function clamp(raw, dflt, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8" },
      extra || {}
    ),
  });
}
