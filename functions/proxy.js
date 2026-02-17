// Cloudflare Pages Functions: /proxy
//
// Purpose:
// - Fetch remote HTML (CORS/WAF restrictions may still apply)
// - Return HTML to same-origin frontend for analysis
//
// Security notes:
// - Basic SSRF mitigation: block localhost/private IP literals.
// - Limit body size to avoid abuse.
// - Only allow http(s).
//
// Usage:
// - /proxy?url=https%3A%2F%2Fexample.com
// - /proxy?mode=status&url=...
//
// Ref: https://developers.cloudflare.com/pages/functions/

const MAX_BYTES = 1_200_000; // ~1.2MB (enough for most LP HTML)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function onRequest(context) {
  const req = context.request;

  // CORS preflight (not strictly needed for same-origin, but safe)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { searchParams } = new URL(req.url);
  const target = searchParams.get("url") || "";
  const mode = (searchParams.get("mode") || "").toLowerCase();

  if (!target) {
    return json({ ok:false, error:"Missing url" }, 400);
  }

  let u;
  try {
    u = new URL(target);
  } catch {
    return json({ ok:false, error:"Invalid url" }, 400);
  }

  if (!(u.protocol === "http:" || u.protocol === "https:")) {
    return json({ ok:false, error:"Only http/https allowed" }, 400);
  }

  if (isBlockedHost(u.hostname)) {
    return json({ ok:false, error:"Blocked host" }, 403);
  }

  // STATUS MODE
  if (mode === "status") {
    const res = await fetchUpstream(u.toString(), { method:"HEAD" });
    // Some servers disallow HEAD
    if (res && res.status === 405) {
      const res2 = await fetchUpstream(u.toString(), { method:"GET" });
      return json({
        ok:true,
        status: res2?.status || 0,
        finalUrl: res2?.url || u.toString(),
        contentType: res2?.headers?.get("content-type") || "",
      }, 200);
    }
    return json({
      ok:true,
      status: res?.status || 0,
      finalUrl: res?.url || u.toString(),
      contentType: res?.headers?.get("content-type") || "",
    }, 200);
  }

  // HTML MODE
  const upstream = await fetchUpstream(u.toString(), { method:"GET" });
  if (!upstream) {
    return json({ ok:false, error:"Upstream fetch failed" }, 502);
  }

  const contentType = upstream.headers.get("content-type") || "";
  const buf = await readLimited(upstream, MAX_BYTES);
  if (buf.aborted) {
    return json({ ok:false, error:"Response too large" }, 413);
  }

  const text = new TextDecoder("utf-8", { fatal:false }).decode(buf.bytes);

  // Allow only HTML-ish responses
  const looksHtml = /<\s*html\b/i.test(text) || /<!doctype\s+html/i.test(text) || /<\s*head\b/i.test(text);
  const isHtmlCt = /text\/html|application\/xhtml\+xml/i.test(contentType);

  if (!(looksHtml || isHtmlCt)) {
    return json({ ok:false, error:`Unsupported content-type: ${contentType}` }, 415);
  }

  const headers = {
    ...corsHeaders(),
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };

  return new Response(text, { status: upstream.status, headers });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    }
  });
}

async function fetchUpstream(url, { method="GET" } = {}) {
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8",
      }
    });
  } catch {
    return null;
  }
}

async function readLimited(res, maxBytes) {
  // Stream read up to maxBytes
  const reader = res.body?.getReader?.();
  if (!reader) {
    // fallback
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > maxBytes) return { aborted:true, bytes: bytes.slice(0, maxBytes) };
    return { aborted:false, bytes };
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { reader.cancel(); } catch {}
      return { aborted:true, bytes: concatChunks(chunks) };
    }
    chunks.push(value);
  }
  return { aborted:false, bytes: concatChunks(chunks) };
}

function concatChunks(chunks) {
  const total = chunks.reduce((a,c)=>a+c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function isBlockedHost(host) {
  const h = host.toLowerCase().trim();

  // localhost names
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;

  // IPv6 localhost
  if (h === "::1") return true;

  // If host is an IPv4 literal, block private ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(x => Number(x));
    if (o.some(x => x<0 || x>255)) return true;
    const [a,b] = o;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
  }

  // IPv6 private ranges (very rough check for literal)
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;

  return false;
}
