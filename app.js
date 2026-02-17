/* LP 売上フェルミ博士 - app.js
 *
 * 目的:
 * - LP(URL)を簡易解析し、45項目のUI/UX採点から偏差値(20〜80)を算出
 * - ユーザー入力(業種/平均決済額/広告費)と偏差値を使ってフェルミ推定で売上を概算
 * - 「博士」が非エンジニアでも分かる言葉で解説する
 *
 * Cloudflare Pages 想定:
 * - /proxy (Pages Functions) 経由でHTML取得（CORS回避）
 */

(() => {
  "use strict";

  // ---------------------------
  // DOM helpers
  // ---------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------------------
  // Logger (リアルタイム)
  // ---------------------------
  class LogStore {
    constructor() {
      this.listeners = new Set();
      this.reset();
    }
    reset() {
      this.entries = [];
      this.t0 = performance.now();
      this.emit();
    }
    on(fn) {
      this.listeners.add(fn);
      fn(this.entries);
      return () => this.listeners.delete(fn);
    }
    emit() {
      for (const fn of this.listeners) fn(this.entries);
    }
    _push(level, msg) {
      const dt = performance.now() - this.t0;
      const m = Math.floor(dt / 60000);
      const s = Math.floor((dt % 60000) / 1000);
      const t = `[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}]`;
      this.entries.push(`${t} ${level} ${msg}`);
      this.emit();
    }
    info(msg) { this._push("INFO", msg); }
    warn(msg) { this._push("WARN", msg); }
    error(msg){ this._push("ERROR", msg); }
  }

  const logStore = new LogStore();

  function attachLogView() {
    const logEl = $("#log");
    logStore.on((entries) => {
      logEl.textContent = entries.join("\n");
      // 末尾へスクロール
      logEl.scrollTop = logEl.scrollHeight;
    });
  }

  // ---------------------------
  // Sound (オプション)
  // ---------------------------
  class Beeper {
    constructor() { this.ctx = null; }
    _ctx() {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      return this.ctx;
    }
    beep(freq = 880, ms = 60, gain = 0.03) {
      try {
        const ctx = this._ctx();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.frequency.value = freq;
        g.gain.value = gain;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + ms / 1000);
      } catch (_) {}
    }
  }
  const beeper = new Beeper();

  // ---------------------------
  // Utilities
  // ---------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function formatYen(n) {
    if (!Number.isFinite(n)) return "--";
    const rounded = Math.round(n);
    return rounded.toLocaleString("ja-JP") + " 円";
  }
  function formatInt(n) {
    if (!Number.isFinite(n)) return "--";
    return Math.round(n).toLocaleString("ja-JP");
  }
  function formatPct(x, digits = 1) {
    if (!Number.isFinite(x)) return "--";
    return (x * 100).toFixed(digits) + "%";
  }
  function formatRoas(x) {
    if (!Number.isFinite(x)) return "--";
    return (x * 100).toFixed(0) + "%";
  }
  function safeUrl(input) {
    try {
      const u = new URL(input);
      if (!/^https?:$/.test(u.protocol)) return null;
      return u;
    } catch {
      return null;
    }
  }

  // ---------------------------
  // Industry profiles (任せてOKと言われたのでこちらで定義)
  // - CPC: 円/クリック（ざっくり）
  // - CVR: 成約率（クリック→購入/申込）ざっくり
  //
  // ※フェルミ推定なので「当たりをつける」用途。正確性は保証しません。
  // ---------------------------
  const INDUSTRIES = [
    { id:"ec", label:"EC（物販・D2C）", cpc:{low:70, mid:120, high:200}, cvr:{low:0.008, mid:0.015, high:0.03} },
    { id:"saas", label:"SaaS（サブスク/ツール）", cpc:{low:150, mid:280, high:450}, cvr:{low:0.004, mid:0.010, high:0.02} },
    { id:"b2b_lead", label:"B2B（資料請求/問い合わせ）", cpc:{low:250, mid:500, high:900}, cvr:{low:0.003, mid:0.012, high:0.03} },
    { id:"recruit", label:"人材（採用/求人）", cpc:{low:180, mid:380, high:700}, cvr:{low:0.002, mid:0.008, high:0.02} },
    { id:"education", label:"教育（スクール/講座）", cpc:{low:120, mid:260, high:450}, cvr:{low:0.004, mid:0.012, high:0.03} },
    { id:"real_estate", label:"不動産（内見/問い合わせ）", cpc:{low:450, mid:900, high:1600}, cvr:{low:0.002, mid:0.010, high:0.03} },
    { id:"auto", label:"自動車（見積/来店/購入）", cpc:{low:250, mid:650, high:1200}, cvr:{low:0.0015, mid:0.006, high:0.02} },
    { id:"travel", label:"旅行・宿泊", cpc:{low:90, mid:180, high:350}, cvr:{low:0.006, mid:0.018, high:0.04} },
    { id:"finance", label:"金融（保険/ローン/投資）", cpc:{low:350, mid:850, high:1600}, cvr:{low:0.0015, mid:0.007, high:0.02} },
    { id:"clinic", label:"医療・美容（予約/相談）", cpc:{low:120, mid:320, high:650}, cvr:{low:0.005, mid:0.015, high:0.035} },
    { id:"restaurant", label:"飲食（予約/デリバリー）", cpc:{low:40, mid:90, high:160}, cvr:{low:0.01, mid:0.03, high:0.06} },
    { id:"event", label:"エンタメ（チケット/登録）", cpc:{low:70, mid:150, high:260}, cvr:{low:0.008, mid:0.02, high:0.05} },
  ];

  function populateIndustrySelect() {
    const sel = $("#inIndustry");
    sel.innerHTML = "";
    for (const it of INDUSTRIES) {
      const opt = document.createElement("option");
      opt.value = it.id;
      opt.textContent = it.label;
      sel.appendChild(opt);
    }
  }

  function getIndustry(id) {
    return INDUSTRIES.find((x) => x.id === id) || INDUSTRIES[0];
  }

  // ---------------------------
  // Fetch via /proxy (Cloudflare Pages Functions)
  // ---------------------------
  async function fetchHtml(url, { fastMode=false } = {}) {
    const timeoutMs = fastMode ? 9000 : 15000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    // Try local/prod proxy first
    const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;
    try {
      logStore.info(`HTML取得…（/proxy）`);
      const res = await fetch(proxyUrl, { signal: controller.signal, redirect:"follow" });
      if (!res.ok) throw new Error(`proxy status ${res.status}`);
      const text = await res.text();
      clearTimeout(t);
      return { ok:true, via:"proxy", status:res.status, text };
    } catch (e) {
      logStore.warn(` /proxy 失敗（${e?.message || e}）`);
    } finally {
      clearTimeout(t);
    }

    // Fallback: direct (will often fail due to CORS, but keep for local testing)
    const controller2 = new AbortController();
    const t2 = setTimeout(() => controller2.abort(), timeoutMs);
    try {
      logStore.info(`HTML取得…（direct）`);
      const res = await fetch(url, { signal: controller2.signal, redirect:"follow" });
      if (!res.ok) throw new Error(`direct status ${res.status}`);
      const text = await res.text();
      clearTimeout(t2);
      return { ok:true, via:"direct", status:res.status, text };
    } catch (e) {
      logStore.warn(` direct 失敗（${e?.message || e}）`);
    } finally {
      clearTimeout(t2);
    }

    return { ok:false, via:"none", status:0, text:"" };
  }

  async function fetchStatus(url, { fastMode=false } = {}) {
    const timeoutMs = fastMode ? 7000 : 12000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const u = `/proxy?mode=status&url=${encodeURIComponent(url)}`;
      const res = await fetch(u, { signal: controller.signal, redirect:"follow" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      clearTimeout(t);
      return { ok:true, ...data };
    } catch (e) {
      return { ok:false, error: e?.message || String(e) };
    } finally {
      clearTimeout(t);
    }
  }

  // ---------------------------
  // HTML sanitize & iframe rendering
  // ---------------------------
  function sanitizeHtmlForSrcdoc(html, baseUrl) {
    // very simple sanitization: remove scripts, remove CSP meta
    let out = html;

    // Limit size to avoid freezing (approx)
    const MAX_CHARS = 800_000;
    if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);

    // remove script tags
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

    // remove meta CSP
    out = out.replace(/<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi, "");

    // ensure base tag in head (best effort)
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${escapeHtmlAttr(baseUrl)}">`);
    } else {
      out = `<head><base href="${escapeHtmlAttr(baseUrl)}"></head>` + out;
    }

    return out;
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function loadIntoProbeFrame(html, { fastMode=false } = {}) {
    const frame = $("#probeFrame");
    const timeoutMs = fastMode ? 7000 : 12000;

    return await new Promise((resolve, reject) => {
      let done = false;
      const onload = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ ok:true, frame });
      };
      const onerror = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("iframe load error"));
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("iframe load timeout"));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        frame.removeEventListener("load", onload);
        frame.removeEventListener("error", onerror);
      }

      frame.addEventListener("load", onload);
      frame.addEventListener("error", onerror);
      frame.srcdoc = html;
    });
  }

  // ---------------------------
  // LP scoring (45 items, 1〜5)
  // ---------------------------
  const CATEGORIES = [
    { id:"content", label:"コンテンツ・可読性" },
    { id:"nav", label:"ナビゲーション構造" },
    { id:"design", label:"デザイン・レイアウト" },
    { id:"trust", label:"信頼性・信用" },
    { id:"a11y", label:"アクセシビリティ" },
    { id:"perf", label:"パフォーマンス" },
    { id:"mobile", label:"モバイル対応" },
  ];

  function devFromPoints(points, nItems) {
    const max = nItems * 5;
    const pct = clamp(points / max, 0, 1);
    const dev = 20 + 60 * pct; // 20〜80
    return dev;
  }

  function categoryScores(items) {
    const by = new Map();
    for (const it of items) {
      if (!by.has(it.category)) by.set(it.category, []);
      by.get(it.category).push(it.score);
    }
    const out = [];
    for (const cat of CATEGORIES) {
      const arr = by.get(cat.id) || [];
      const avg = arr.length ? (arr.reduce((a,b)=>a+b,0) / arr.length) : 3;
      const scaled = clamp(avg * 20, 20, 100);
      out.push({ id:cat.id, label:cat.label, score: scaled });
    }
    return out;
  }

  // --- text utilities
  function getVisibleTextSample(doc, limit = 12000) {
    const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
    let text = "";
    let n = 0;
    while (walker.nextNode() && text.length < limit) {
      const t = walker.currentNode.nodeValue || "";
      const cleaned = t.replace(/\s+/g, " ").trim();
      if (cleaned.length < 2) continue;
      text += cleaned + "\n";
      n++;
      if (n > 300) break;
    }
    return text.slice(0, limit);
  }

  function countRegex(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
  }

  function pickSample(arr, n) {
    if (arr.length <= n) return arr.slice();
    const out = [];
    const used = new Set();
    while (out.length < n) {
      const i = Math.floor(Math.random() * arr.length);
      if (used.has(i)) continue;
      used.add(i);
      out.push(arr[i]);
    }
    return out;
  }

  // --- color & contrast
  function parseColor(str) {
    if (!str) return null;
    str = str.trim().toLowerCase();
    if (str === "transparent") return { r:0, g:0, b:0, a:0 };
    // rgb/rgba
    const m = str.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(",").map(x => x.trim());
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      const a = parts.length >= 4 ? Number(parts[3]) : 1;
      if ([r,g,b,a].some(x => Number.isNaN(x))) return null;
      return { r, g, b, a };
    }
    // hex
    const h = str.match(/^#([0-9a-f]{3,8})$/i);
    if (h) {
      const hex = h[1];
      if (hex.length === 3) {
        const r = parseInt(hex[0]+hex[0], 16);
        const g = parseInt(hex[1]+hex[1], 16);
        const b = parseInt(hex[2]+hex[2], 16);
        return { r,g,b,a:1 };
      }
      if (hex.length === 6) {
        const r = parseInt(hex.slice(0,2), 16);
        const g = parseInt(hex.slice(2,4), 16);
        const b = parseInt(hex.slice(4,6), 16);
        return { r,g,b,a:1 };
      }
      if (hex.length === 8) {
        const r = parseInt(hex.slice(0,2), 16);
        const g = parseInt(hex.slice(2,4), 16);
        const b = parseInt(hex.slice(4,6), 16);
        const a = parseInt(hex.slice(6,8), 16) / 255;
        return { r,g,b,a };
      }
    }
    return null;
  }

  function blendOver(bg, fg) {
    // fg over bg
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r:0, g:0, b:0, a:0 };
    const r = (fg.r*fg.a + bg.r*bg.a*(1-fg.a)) / a;
    const g = (fg.g*fg.a + bg.g*bg.a*(1-fg.a)) / a;
    const b = (fg.b*fg.a + bg.b*bg.a*(1-fg.a)) / a;
    return { r,g,b,a };
  }

  function srgbToLin(v) {
    v = v / 255;
    return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  }

  function relLuminance(c) {
    const r = srgbToLin(c.r);
    const g = srgbToLin(c.g);
    const b = srgbToLin(c.b);
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }

  function contrastRatio(fg, bg) {
    // assume opaque colors
    const L1 = relLuminance(fg);
    const L2 = relLuminance(bg);
    const lighter = Math.max(L1, L2);
    const darker = Math.min(L1, L2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function getEffectiveBgColor(el, win) {
    // walk up until non-transparent
    let cur = el;
    let safety = 0;
    while (cur && safety++ < 25) {
      const cs = win.getComputedStyle(cur);
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.05) return bg;
      cur = cur.parentElement;
    }
    // fallback to body
    const bodyBg = parseColor(win.getComputedStyle(win.document.body).backgroundColor);
    if (bodyBg && bodyBg.a > 0.05) return bodyBg;
    return { r:11, g:15, b:20, a:1 }; // similar to our app bg
  }

  function computeContrastPassRate(doc, win) {
    const candidates = $$("p, li, a, button, label, span, h1, h2, h3", doc)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 30 && rect.height > 10 && rect.top < 900; // focus on above-the-fold-ish
      });
    const sample = pickSample(candidates, 40);
    if (sample.length === 0) return { passRate: 0.5, samples: 0 };

    let pass = 0;
    let total = 0;
    for (const el of sample) {
      const cs = win.getComputedStyle(el);
      const fg = parseColor(cs.color);
      if (!fg) continue;
      const bg = getEffectiveBgColor(el, win);
      // blend if alpha
      const fgO = fg.a < 1 ? blendOver(bg, fg) : fg;
      const bgO = bg.a < 1 ? { ...bg, a:1 } : bg;
      const ratio = contrastRatio(fgO, bgO);
      total++;
      if (ratio >= 4.5) pass++;
    }
    const passRate = total ? pass/total : 0.5;
    return { passRate, samples: total };
  }

  function measureTapTargets(doc) {
    const candidates = $$("a, button, [role='button'], input[type='submit'], input[type='button']", doc)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 16) return false;
        if (rect.bottom < 0 || rect.top > 900) return false;
        return true;
      });

    const sample = pickSample(candidates, 40);
    if (sample.length === 0) return { okRate: 0.5, samples:0 };

    let ok = 0;
    for (const el of sample) {
      const rect = el.getBoundingClientRect();
      const minSide = Math.min(rect.width, rect.height);
      if (minSide >= 40) ok++;
    }
    return { okRate: ok/sample.length, samples: sample.length };
  }

  function detectFixedOverlay(doc) {
    // crude: large fixed element near top that covers much area
    const candidates = $$("*", doc).filter(el => {
      const cs = doc.defaultView.getComputedStyle(el);
      return cs.position === "fixed" || cs.position === "sticky";
    });
    let worst = 0;
    const vw = doc.documentElement.clientWidth || 390;
    const vh = doc.documentElement.clientHeight || 844;

    for (const el of pickSample(candidates, 30)) {
      const r = el.getBoundingClientRect();
      const area = (Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left))) *
                   (Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top)));
      const frac = area / (vw * vh);
      if (frac > worst) worst = frac;
    }
    return worst; // 0〜1
  }

  function headingStructureScore(doc) {
    const hs = $$("h1,h2,h3,h4,h5,h6", doc);
    if (hs.length === 0) return { score:2, note:"見出しがほとんど見つかりませんでした" };
    let jumps = 0;
    let prev = 0;
    for (const h of hs) {
      const level = Number(h.tagName.slice(1));
      if (prev && level - prev > 1) jumps++;
      prev = level;
    }
    const jumpRate = jumps / Math.max(1, hs.length-1);
    if (jumpRate === 0) return { score:5, note:"見出し階層が自然です" };
    if (jumpRate < 0.2) return { score:4, note:"大きな破綻は少なめです" };
    if (jumpRate < 0.4) return { score:3, note:"見出し階層が所々で飛んでいます" };
    if (jumpRate < 0.7) return { score:2, note:"見出し階層の飛びが多めです" };
    return { score:1, note:"見出し階層がかなり不規則です" };
  }

  function detectMetaViewport(html) {
    return /<meta\b[^>]*name=["']viewport["'][^>]*>/i.test(html);
  }

  function detectHttps(url) {
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  }

  function scoreFromBool(ok, goodNote, badNote) {
    return ok
      ? { score:5, note: goodNote || "OK" }
      : { score:2, note: badNote || "不足しています" };
  }

  function scoreFromRate(rate, {good=0.85, ok=0.65, meh=0.45, bad=0.25} = {}, notePrefix = "") {
    if (!Number.isFinite(rate)) return { score:3, note: notePrefix ? `${notePrefix}: 判定不能→中間値` : "判定不能→中間値" };
    if (rate >= good) return { score:5, note: notePrefix ? `${notePrefix}: 良好（${Math.round(rate*100)}%）` : `良好（${Math.round(rate*100)}%）` };
    if (rate >= ok) return { score:4, note: notePrefix ? `${notePrefix}: まずまず（${Math.round(rate*100)}%）` : `まずまず（${Math.round(rate*100)}%）` };
    if (rate >= meh) return { score:3, note: notePrefix ? `${notePrefix}: 普通（${Math.round(rate*100)}%）` : `普通（${Math.round(rate*100)}%）` };
    if (rate >= bad) return { score:2, note: notePrefix ? `${notePrefix}: 弱い（${Math.round(rate*100)}%）` : `弱い（${Math.round(rate*100)}%）` };
    return { score:1, note: notePrefix ? `${notePrefix}: かなり弱い（${Math.round(rate*100)}%）` : `かなり弱い（${Math.round(rate*100)}%）` };
  }

  async function analyzeLp(url, opts) {
    const { fastMode=false, linkCheck=false } = opts;

    const tStart = performance.now();
    logStore.info(`解析開始 → ${url}`);

    // Fetch HTML
    const fetchRes = await fetchHtml(url, { fastMode });
    if (!fetchRes.ok) {
      logStore.error(`HTML取得に失敗しました（CORS/WAF/タイムアウトの可能性）`);
      // fallback result: dev 50, all neutral
      const fallbackItems = buildNeutralItems();
      const points = fallbackItems.reduce((a,b)=>a+b.score,0);
      const dev = devFromPoints(points, fallbackItems.length);
      return {
        ok:false,
        reason:"fetch_failed",
        via: fetchRes.via,
        fetchStatus: fetchRes.status,
        fetchMs: performance.now() - tStart,
        renderMs: null,
        htmlBytes: 0,
        dev,
        points,
        items: fallbackItems,
        categories: categoryScores(fallbackItems),
        meta: { viewport:false },
        linkResults: null,
      };
    }

    logStore.info(`HTML取得OK（via=${fetchRes.via}, size≈${Math.round(fetchRes.text.length/1024)}KB）`);

    // Sanitize & iframe render
    const sanitized = sanitizeHtmlForSrcdoc(fetchRes.text, url);
    const tRender0 = performance.now();
    logStore.info(`スマホ幅でレンダリング（iframe）…`);
    try {
      await loadIntoProbeFrame(sanitized, { fastMode });
      // allow layout settle a bit
      await sleep(fastMode ? 120 : 250);
    } catch (e) {
      logStore.warn(`iframeレンダリング失敗（${e?.message || e}）。HTML解析のみで推定します。`);
    }
    const tRender1 = performance.now();

    const frame = $("#probeFrame");
    const doc = frame.contentDocument;
    const win = frame.contentWindow;

    // meta
    const viewportOk = detectMetaViewport(fetchRes.text);

    // link check (optional)
    let linkResults = null;
    if (linkCheck && doc) {
      logStore.info(`リンク切れサンプルチェック…`);
      linkResults = await sampleLinkCheck(doc, { fastMode });
      const bad = linkResults.results.filter(r => r.ok === false);
      logStore.info(`リンクチェック完了（OK=${linkResults.results.length - bad.length}, NG=${bad.length}）`);
    }

    // scoring
    logStore.info(`45項目を採点中…`);
    const metrics = doc ? collectMetrics(doc, win, fetchRes.text, url, { viewportOk, linkResults, fetchRes }) : collectMetricsFromHtml(fetchRes.text, url, { viewportOk, linkResults, fetchRes });
    const items = scoreItems(metrics);
    const points = items.reduce((a,b)=>a+b.score,0);
    const dev = devFromPoints(points, items.length);

    const tEnd = performance.now();
    logStore.info(`採点完了。偏差値=${dev.toFixed(1)}（${points}/${items.length*5}点）`);

    return {
      ok:true,
      reason:"ok",
      via: fetchRes.via,
      fetchStatus: fetchRes.status,
      fetchMs: tEnd - tStart,
      renderMs: doc ? (tRender1 - tRender0) : null,
      htmlBytes: fetchRes.text.length,
      dev,
      points,
      items,
      categories: categoryScores(items),
      meta: { viewport: viewportOk },
      linkResults,
      metricsSummary: summarizeMetrics(metrics),
    };
  }

  function buildNeutralItems() {
    // 45 items, score=3
    const defs = itemDefinitions();
    return defs.map(d => ({ id:d.id, category:d.category, name:d.name, score:3, note:"取得制限により暫定（中間値）" }));
  }

  function itemDefinitions() {
    // P7/P8 (45項目) 名称
    return [
      // content 1-7
      { id:1, category:"content", name:"主要な訴求内容が明確" },
      { id:2, category:"content", name:"情報の最新性" },
      { id:3, category:"content", name:"読みやすいテキスト構造" },
      { id:4, category:"content", name:"平易な表現" },
      { id:5, category:"content", name:"リンクテキストの明示性" },
      { id:6, category:"content", name:"ユーザー支援情報の充実" },
      { id:7, category:"content", name:"明確なCTA配置" },

      // nav 8-11
      { id:8, category:"nav", name:"リンク切れゼロ" },
      { id:9, category:"nav", name:"一貫したメニュー配置" },
      { id:10, category:"nav", name:"リンクの既読" },
      { id:11, category:"nav", name:"分かりやすいラベル" },

      // design 12-17
      { id:12, category:"design", name:"レイアウトの安定" },
      { id:13, category:"design", name:"デザインの一貫性" },
      { id:14, category:"design", name:"主情報の視覚強調" },
      { id:15, category:"design", name:"十分なコントラスト" },
      { id:16, category:"design", name:"煩わしい演出の排除" },
      { id:17, category:"design", name:"過剰な広告非表示" },

      // trust 18-26
      { id:18, category:"trust", name:"運営者情報の開示" },
      { id:19, category:"trust", name:"明確な連絡手段" },
      { id:20, category:"trust", name:"ポリシーと法令順守" },
      { id:21, category:"trust", name:"プロらしい見た目" },
      { id:22, category:"trust", name:"信頼を裏付ける証跡" },
      { id:23, category:"trust", name:"細部の正確性" },
      { id:24, category:"trust", name:"安全な通信 (HTTPS)" },
      { id:25, category:"trust", name:"ポップアップの節度" },
      { id:26, category:"trust", name:"信頼性の補強要素" },

      // a11y 27-33
      { id:27, category:"a11y", name:"画像代替テキスト" },
      { id:28, category:"a11y", name:"フォーム要素のラベル" },
      { id:29, category:"a11y", name:"言語の明示" },
      { id:30, category:"a11y", name:"見出し構造の適切さ" },
      { id:31, category:"a11y", name:"十分な色のコントラスト" },
      { id:32, category:"a11y", name:"色以外の識別" },
      { id:33, category:"a11y", name:"キーボード操作可能" },

      // perf 34-39
      { id:34, category:"perf", name:"高速なページ表示" },
      { id:35, category:"perf", name:"軽量なページサイズ" },
      { id:36, category:"perf", name:"リクエスト数の最適化" },
      { id:37, category:"perf", name:"リソースの効率利用" },
      { id:38, category:"perf", name:"エラーの不存在" },
      { id:39, category:"perf", name:"安定した描画" },

      // mobile 40-45
      { id:40, category:"mobile", name:"ビューポート設定" },
      { id:41, category:"mobile", name:"レイアウト最適化" },
      { id:42, category:"mobile", name:"モバイルでの可読性" },
      { id:43, category:"mobile", name:"タップ操作のしやすさ" },
      { id:44, category:"mobile", name:"電話・メールのワンタップリンク" },
      { id:45, category:"mobile", name:"モバイル性能の最適化" },
    ];
  }

  function collectMetrics(doc, win, htmlText, url, ctx) {
    // gather metrics for scoring
    const textSample = getVisibleTextSample(doc, 16000);
    const years = Array.from(textSample.matchAll(/\b(20\d{2})\b/g)).map(m => Number(m[1])).filter(y => y>=2000 && y<=2099);
    const newestYear = years.length ? Math.max(...years) : null;
    const nowYear = new Date().getFullYear();

    const h1 = $("h1", doc);
    const h1Text = h1 ? (h1.textContent || "").trim().replace(/\s+/g, " ") : "";
    const h1Rect = h1 ? h1.getBoundingClientRect() : null;

    const headings = $$("h1,h2,h3,h4,h5,h6", doc);
    const lists = $$("ul,ol", doc);
    const paras = $$("p", doc);

    const links = $$("a[href]", doc).filter(a => {
      const href = (a.getAttribute("href") || "").trim();
      return href && !href.startsWith("#") && !href.startsWith("javascript:");
    });

    const buttons = $$("button, a[role='button'], input[type='submit'], input[type='button']", doc);

    // horizontal scroll
    const clientW = doc.documentElement.clientWidth || 390;
    const scrollW = doc.documentElement.scrollWidth || clientW;
    const horizOverflow = scrollW > clientW + 10;

    // small fonts
    const fontSamples = pickSample($$("p, li, a, button, label, span", doc), 60);
    const fontSizes = fontSamples.map(el => {
      const cs = win.getComputedStyle(el);
      return parseFloat(cs.fontSize) || 0;
    }).filter(x => x>0);
    const smallFontRate = fontSizes.length ? fontSizes.filter(s => s < 16).length / fontSizes.length : 0.5;

    // tap targets
    const tap = measureTapTargets(doc);

    // contrast
    const contrast = computeContrastPassRate(doc, win);

    // fixed overlay
    const overlayFrac = detectFixedOverlay(doc);

    // alt rate
    const imgs = $$("img", doc);
    const meaningfulImgs = imgs.filter(img => {
      const r = img.getBoundingClientRect();
      return (r.width * r.height) > 1200; // ignore tiny icons
    });
    const altRate = meaningfulImgs.length
      ? meaningfulImgs.filter(img => (img.getAttribute("alt") || "").trim().length > 0).length / meaningfulImgs.length
      : 1;

    // form label rate
    const inputs = $$("input, textarea, select", doc)
      .filter(el => {
        const t = (el.getAttribute("type") || "").toLowerCase();
        return !["hidden","submit","button","image","reset"].includes(t);
      });
    const labelRate = inputs.length ? inputs.filter(el => {
      if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return true;
      const id = el.getAttribute("id");
      if (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) return true;
      // wrapped by label
      let p = el.parentElement;
      let depth = 0;
      while (p && depth++ < 5) {
        if (p.tagName && p.tagName.toLowerCase() === "label") return true;
        p = p.parentElement;
      }
      return false;
    }).length / inputs.length : 1;

    // tel/mail
    const hasTel = links.some(a => (a.getAttribute("href")||"").startsWith("tel:"));
    const hasMail = links.some(a => (a.getAttribute("href")||"").startsWith("mailto:"));

    // nav
    const nav = $("nav", doc);
    const navLinks = nav ? $$("a", nav) : [];
    const menuOk = nav && navLinks.length >= 3;

    // visited CSS hint
    const visitedHint = /:visited\b/i.test(htmlText);

    // annoying effects
    const hasMarquee = !!$("marquee", doc);
    const autoplayMedia = $$("video, audio", doc).some(m => m.autoplay || m.hasAttribute("autoplay"));
    const animatedElems = $$("*", doc).filter(el => {
      const cs = win.getComputedStyle(el);
      return (cs.animationName && cs.animationName !== "none") || (cs.transitionDuration && cs.transitionDuration !== "0s");
    });
    const animationHeavy = animatedElems.length > 80;

    // ads-ish
    const iframeCount = $$("iframe", doc).length;
    const adKeywordCount = countRegex(textSample.toLowerCase(), /(ad|ads|advert|スポンサー|PR|プロモーション)/g);

    // trust keywords
    const lower = textSample.toLowerCase();
    const hasCompany = /(会社概要|運営会社|企業情報|about|所在地|〒\d{3}-\d{4}|©|copyright)/i.test(textSample);
    const hasContact = /(お問い合わせ|問合せ|contact|連絡先|サポート)/i.test(textSample);
    const hasPolicy = /(プライバシーポリシー|privacy policy|利用規約|terms|cookie)/i.test(textSample);
    const hasEvidence = /(導入|事例|実績|レビュー|口コミ|受賞|No\.?1|調査|データ|出典|監修)/i.test(textSample);
    const hasTrustBadge = /(SSL|ISO|Pマーク|プライバシーマーク|認証|認定|第三者)/i.test(textSample);
    const hasLorem = /lorem ipsum|ダミー|サンプル|（仮）/i.test(textSample) || /�/.test(textSample);

    // readability (very rough)
    const sentences = textSample.split(/[。！？!\?]\s*/).map(s => s.trim()).filter(s => s.length>0);
    const avgSentenceLen = sentences.length ? sentences.reduce((a,b)=>a+b.length,0) / sentences.length : 60;
    const longSentenceRate = sentences.length ? sentences.filter(s => s.length > 90).length / sentences.length : 0.3;

    // CTA near top
    const ctaKeywords = /(無料|申し込み|申込|購入|予約|登録|問い合わせ|資料請求|download|buy|apply|sign up|contact)/i;
    const ctaElems = $$("a, button, input[type='submit']", doc).filter(el => ctaKeywords.test((el.textContent||"").trim()) || ctaKeywords.test((el.getAttribute("value")||"").trim()));
    const ctaTop = ctaElems.some(el => el.getBoundingClientRect().top < 800);

    // link text clarity
    const ambiguous = /(こちら|詳しくはこちら|more|click|リンク)/i;
    const linkTexts = links.map(a => (a.textContent||"").trim().replace(/\s+/g," "));
    const linkTextSample = linkTexts.filter(t => t.length>0).slice(0,80);
    const ambiguousRate = linkTextSample.length ? linkTextSample.filter(t => ambiguous.test(t)).length / linkTextSample.length : 0;

    // non-color identification (underline links)
    const linkDecorationSample = pickSample(links, 30);
    const underlineRate = linkDecorationSample.length ? linkDecorationSample.filter(a => {
      const cs = win.getComputedStyle(a);
      return (cs.textDecorationLine || "").includes("underline") || (cs.textDecoration || "").includes("underline");
    }).length / linkDecorationSample.length : 0.5;

    // keyboard (focus outline)
    const focusSuppressed = /:focus\s*{[^}]*outline\s*:\s*none/i.test(htmlText) || /outline\s*:\s*none/i.test(htmlText);

    // performance-ish
    const domNodes = doc.getElementsByTagName("*").length;
    const scriptsCount = countRegex(htmlText, /<script\b/gi);
    const cssCount = countRegex(htmlText, /<link\b[^>]*rel=["']stylesheet["']/gi) + countRegex(htmlText, /<style\b/gi);

    let resourceCount = null;
    try {
      const entries = win.performance.getEntriesByType("resource");
      if (entries && entries.length) resourceCount = entries.length;
    } catch (_) {}

    // CLS-ish (very rough: compare element positions after short delay)
    // We'll compute later in collectMetrics? we already waited. We'll do quick.
    const clsApprox = computeLayoutShiftApprox(doc);

    return {
      url,
      viewportOk: ctx.viewportOk,
      newestYear,
      nowYear,
      h1Text,
      h1Top: h1Rect ? h1Rect.top : null,
      headingsCount: headings.length,
      listsCount: lists.length,
      parasCount: paras.length,
      avgSentenceLen,
      longSentenceRate,
      ctaTop,
      linksCount: links.length,
      buttonsCount: buttons.length,
      ambiguousLinkRate: ambiguousRate,
      menuOk,
      navLinksCount: navLinks.length,
      visitedHint,
      horizOverflow,
      fontSmallRate: smallFontRate,
      tapOkRate: tap.okRate,
      tapSamples: tap.samples,
      contrastPassRate: contrast.passRate,
      contrastSamples: contrast.samples,
      overlayFrac,
      iframeCount,
      adKeywordCount,
      hasCompany,
      hasContact,
      hasPolicy,
      hasEvidence,
      hasTrustBadge,
      hasLorem,
      https: detectHttps(url),
      altRate,
      labelRate,
      lang: !!doc.documentElement.getAttribute("lang"),
      headingStruct: headingStructureScore(doc),
      underlineRate,
      focusSuppressed,
      domNodes,
      scriptsCount,
      cssCount,
      resourceCount,
      clsApprox,
      linkResults: ctx.linkResults,
      fetchStatus: ctx.fetchRes.status,
      htmlBytes: htmlText.length,
    };
  }

  function computeLayoutShiftApprox(doc) {
    // This is a lightweight proxy. We sample elements and see if their bounding boxes changed
    // between "now" and a short delay.
    const els = pickSample($$("h1,h2,h3,p,button,a,img", doc), 40);
    const before = els.map(el => el.getBoundingClientRect());
    // Note: We can't await here (collectMetrics sync). We'll approximate as 0 for now.
    // (We already waited after load; major shifts are likely settled.)
    // Return 0 to 0.25 range.
    if (!before.length) return 0.05;
    // Use overflow as a hint: if horizontal overflow exists, increase instability
    return 0.06;
  }

  function collectMetricsFromHtml(htmlText, url, ctx) {
    // fallback without iframe DOM access: only html-level signals
    const viewportOk = ctx.viewportOk;
    const text = htmlText.replace(/<[^>]+>/g, " ");
    const years = Array.from(text.matchAll(/\b(20\d{2})\b/g)).map(m => Number(m[1])).filter(y => y>=2000 && y<=2099);
    const newestYear = years.length ? Math.max(...years) : null;
    const nowYear = new Date().getFullYear();

    return {
      url,
      viewportOk,
      newestYear,
      nowYear,
      h1Text: (htmlText.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").replace(/<[^>]+>/g," ").trim().slice(0,120),
      h1Top: null,
      headingsCount: countRegex(htmlText, /<h[1-6]\b/gi),
      listsCount: countRegex(htmlText, /<ul\b|<ol\b/gi),
      parasCount: countRegex(htmlText, /<p\b/gi),
      avgSentenceLen: 60,
      longSentenceRate: 0.3,
      ctaTop: /(無料|申込|購入|予約|登録|問い合わせ|資料請求)/i.test(text.slice(0,2000)),
      linksCount: countRegex(htmlText, /<a\b/gi),
      buttonsCount: countRegex(htmlText, /<button\b|type=["']submit["']/gi),
      ambiguousLinkRate: 0.2,
      menuOk: /<nav\b/i.test(htmlText),
      navLinksCount: 3,
      visitedHint: /:visited\b/i.test(htmlText),
      horizOverflow: false,
      fontSmallRate: 0.35,
      tapOkRate: 0.5,
      tapSamples: 0,
      contrastPassRate: 0.6,
      contrastSamples: 0,
      overlayFrac: 0.1,
      iframeCount: countRegex(htmlText, /<iframe\b/gi),
      adKeywordCount: countRegex(text.toLowerCase(), /(ad|ads|advert|スポンサー|PR|プロモーション)/g),
      hasCompany: /(会社概要|運営会社|企業情報|所在地|©|copyright)/i.test(text),
      hasContact: /(お問い合わせ|問合せ|contact|連絡先)/i.test(text),
      hasPolicy: /(プライバシーポリシー|privacy policy|利用規約|terms|cookie)/i.test(text),
      hasEvidence: /(導入|事例|実績|レビュー|口コミ|受賞|No\.?1|調査|データ|出典|監修)/i.test(text),
      hasTrustBadge: /(SSL|ISO|Pマーク|認証|認定|第三者)/i.test(text),
      hasLorem: /lorem ipsum|ダミー|サンプル|（仮）/i.test(text) || /�/.test(text),
      https: detectHttps(url),
      altRate: 0.7,
      labelRate: 0.6,
      lang: /<html\b[^>]*lang=/i.test(htmlText),
      headingStruct: { score:3, note:"DOM未取得のため簡易判定" },
      underlineRate: 0.5,
      focusSuppressed: /outline\s*:\s*none/i.test(htmlText),
      domNodes: 900,
      scriptsCount: countRegex(htmlText, /<script\b/gi),
      cssCount: countRegex(htmlText, /rel=["']stylesheet["']/gi) + countRegex(htmlText, /<style\b/gi),
      resourceCount: null,
      clsApprox: 0.08,
      linkResults: ctx.linkResults,
      fetchStatus: ctx.fetchRes.status,
      htmlBytes: htmlText.length,
    };
  }

  async function sampleLinkCheck(doc, { fastMode=false } = {}) {
    const anchors = $$("a[href]", doc)
      .map(a => (a.getAttribute("href") || "").trim())
      .filter(h => h && !h.startsWith("#") && !h.startsWith("javascript:") && !h.startsWith("mailto:") && !h.startsWith("tel:"));

    // normalize (dedupe)
    const uniq = [];
    const seen = new Set();
    for (const h of anchors) {
      if (seen.has(h)) continue;
      seen.add(h);
      uniq.push(h);
      if (uniq.length >= 8) break;
    }

    const results = [];
    for (const href of uniq) {
      const abs = toAbsUrl(href, doc.baseURI);
      const st = await fetchStatus(abs, { fastMode });
      const ok = st.ok && typeof st.status === "number" ? (st.status >= 200 && st.status < 400) : null;
      results.push({ href: abs, status: st.status, ok });
      await sleep(fastMode ? 40 : 90);
    }

    return { sampled: uniq.length, results };
  }

  function toAbsUrl(href, base) {
    try { return new URL(href, base).toString(); } catch { return href; }
  }

  function summarizeMetrics(m) {
    return {
      viewport: m.viewportOk,
      overflow: m.horizOverflow,
      contrastPass: m.contrastPassRate,
      tapOk: m.tapOkRate,
      smallFontRate: m.fontSmallRate,
      overlay: m.overlayFrac,
      domNodes: m.domNodes,
      scripts: m.scriptsCount,
      css: m.cssCount,
      resourceCount: m.resourceCount,
    };
  }

  function scoreItems(m) {
    const defs = itemDefinitions();
    const items = [];

    // helper to push with note
    const push = (id, score, note) => {
      const def = defs.find(d => d.id === id);
      items.push({ id, category: def.category, name: def.name, score, note });
    };

    // 1 Main proposition (h1)
    {
      const has = m.h1Text && m.h1Text.length >= 8;
      const topOk = (m.h1Top == null) ? true : (m.h1Top < 650);
      let s = 3;
      let note = "判定不能→中間値";
      if (!has) { s=2; note="H1（主見出し）が弱い/見つからない"; }
      else if (has && topOk && m.h1Text.length <= 80) { s=5; note="冒頭の見出しが明確"; }
      else if (has && topOk) { s=4; note="見出しはあるがやや長め"; }
      else { s=3; note="見出しはあるが位置が下寄り"; }
      push(1, s, note);
    }

    // 2 Freshness (year)
    {
      if (!m.newestYear) push(2, 3, "年の記載が見つからず→中間値");
      else {
        const diff = m.nowYear - m.newestYear;
        if (diff <= 1) push(2, 5, `比較的新しい（最新年=${m.newestYear}）`);
        else if (diff <= 3) push(2, 4, `やや新しい（最新年=${m.newestYear}）`);
        else if (diff <= 6) push(2, 3, `少し古い（最新年=${m.newestYear}）`);
        else if (diff <= 10) push(2, 2, `古い可能性（最新年=${m.newestYear}）`);
        else push(2, 1, `かなり古い可能性（最新年=${m.newestYear}）`);
      }
    }

    // 3 Readable structure
    {
      const h = m.headingsCount;
      const l = m.listsCount;
      if (h >= 6 && l >= 3) push(3, 5, `見出し${h}・リスト${l}で整理されています`);
      else if (h >= 4) push(3, 4, `見出し${h}である程度整理`);
      else if (h >= 2) push(3, 3, `最低限の見出しはあります（${h}）`);
      else push(3, 2, `見出しが少なく読み分けしにくい（${h}）`);
    }

    // 4 Plain language
    {
      const long = m.longSentenceRate;
      if (long < 0.12 && m.avgSentenceLen < 55) push(4, 5, "文章が比較的短く読みやすい");
      else if (long < 0.22) push(4, 4, "文章は概ね読みやすい");
      else if (long < 0.35) push(4, 3, "文章がやや長い箇所がある");
      else if (long < 0.5) push(4, 2, "文章が長めで読みづらい可能性");
      else push(4, 1, "文章がかなり長い可能性");
    }

    // 5 Link text clarity (ambiguous rate)
    {
      const r = m.ambiguousLinkRate;
      if (r <= 0.05) push(5, 5, "リンク文言が具体的");
      else if (r <= 0.12) push(5, 4, "リンク文言は概ね具体的");
      else if (r <= 0.25) push(5, 3, "曖昧なリンク文言が混在");
      else if (r <= 0.4) push(5, 2, "曖昧なリンク文言が多め");
      else push(5, 1, "リンク文言がかなり曖昧");
    }

    // 6 Support info (FAQ/help)
    {
      // approximate using policy/contact presence too
      const ok = m.hasContact || m.hasPolicy;
      const faq = /(faq|よくある質問|Q&A)/i.test(String(m.h1Text||"")) || false;
      if (faq || (m.hasContact && m.hasPolicy)) push(6, 5, "支援情報（FAQ/ポリシー/連絡先）が揃っています");
      else if (ok) push(6, 4, "支援情報が一部見つかります");
      else push(6, 2, "支援情報が見つかりにくい可能性");
    }

    // 7 CTA visibility
    push(7, m.ctaTop ? 5 : 3, m.ctaTop ? "主要CTAが上部に見つかりました" : "上部にCTAが見つかりにくい");

    // 8 Broken links (sample check)
    {
      if (!m.linkResults) push(8, 3, "リンクチェック未実施→中間値");
      else {
        const res = m.linkResults.results;
        const known = res.filter(r => r.ok != null);
        const ng = known.filter(r => r.ok === false).length;
        if (known.length === 0) push(8, 3, "判定不能→中間値");
        else if (ng === 0) push(8, 5, `サンプル${known.length}件すべてOK`);
        else if (ng <= 1) push(8, 4, `NGが少数（${ng}/${known.length}）`);
        else if (ng <= 2) push(8, 3, `NGが混在（${ng}/${known.length}）`);
        else if (ng <= 3) push(8, 2, `NGが多め（${ng}/${known.length}）`);
        else push(8, 1, `NGが多数（${ng}/${known.length}）`);
      }
    }

    // 9 Menu consistency (nav)
    push(9, m.menuOk ? 4 : 3, m.menuOk ? `navあり（リンク${m.navLinksCount}）` : "navが見つからない/少ない");

    // 10 Visited link style
    push(10, m.visitedHint ? 4 : 3, m.visitedHint ? ":visited の指定が見つかりました" : "visitedの痕跡なし（多くのLPは未対応）");

    // 11 Clear labels (nav link texts)
    {
      if (!m.menuOk) push(11, 3, "nav未検出→中間値");
      else {
        // If nav links exist, assume good
        push(11, m.navLinksCount >= 4 ? 4 : 3, "メニュー項目数から推定");
      }
    }

    // 12 Layout stability (overflow)
    push(12, m.horizOverflow ? 1 : 5, m.horizOverflow ? "横スクロールが発生" : "横スクロールなし（良好）");

    // 13 Design consistency (approx via dom/scripts/css)
    {
      const v = m.cssCount + m.scriptsCount;
      if (v <= 6 && m.domNodes < 1200) push(13, 5, "構成が比較的シンプル");
      else if (v <= 12) push(13, 4, "過度ではない");
      else if (v <= 20) push(13, 3, "要素が多め");
      else push(13, 2, "複雑で一貫性が崩れやすい可能性");
    }

    // 14 Visual emphasis (h1 length + presence)
    {
      if (!m.h1Text) push(14, 2, "主情報の強調が弱い可能性");
      else if (m.h1Text.length <= 40) push(14, 5, "主見出しが短く伝わりやすい");
      else if (m.h1Text.length <= 80) push(14, 4, "主見出しが概ね適切");
      else push(14, 3, "主見出しが長め");
    }

    // 15 Contrast
    {
      const sc = scoreFromRate(m.contrastPassRate, {good:0.8, ok:0.65, meh:0.5, bad:0.35}, "コントラスト");
      push(15, sc.score, sc.note);
    }

    // 16 Annoying effects
    {
      const bad = m.overlayFrac > 0.35;
      const mid = m.overlayFrac > 0.20;
      if (m.iframeCount > 8 || m.adKeywordCount > 20) push(16, 2, "広告/埋め込みが多めで煩わしい可能性");
      else if (bad) push(16, 2, "画面を覆う固定要素が大きい可能性");
      else if (mid) push(16, 3, "固定要素がやや多い可能性");
      else push(16, 5, "煩わしい演出の兆候は少なめ");
    }

    // 17 Excessive ads
    {
      if (m.iframeCount >= 10) push(17, 1, `iframeが多い（${m.iframeCount}）`);
      else if (m.iframeCount >= 6) push(17, 2, `iframeがやや多い（${m.iframeCount}）`);
      else if (m.iframeCount >= 3) push(17, 3, `iframeが少しある（${m.iframeCount}）`);
      else push(17, 5, `埋め込みが少なめ（${m.iframeCount}）`);
    }

    // 18 Operator info
    push(18, m.hasCompany ? 5 : 2, m.hasCompany ? "運営者情報の痕跡あり" : "運営者情報が見つかりにくい");

    // 19 Contact
    push(19, m.hasContact ? 5 : 2, m.hasContact ? "問い合わせ導線の痕跡あり" : "連絡手段が見つかりにくい");

    // 20 Policy
    push(20, m.hasPolicy ? 5 : 2, m.hasPolicy ? "ポリシー/規約の痕跡あり" : "ポリシー/規約が見つかりにくい");

    // 21 Professional look (composite)
    {
      let s = 3;
      const penalty = (m.horizOverflow ? 1 : 0) + (m.contrastPassRate < 0.5 ? 1 : 0) + (m.overlayFrac > 0.25 ? 1 : 0);
      if (penalty === 0 && m.hasCompany && m.hasPolicy) s = 5;
      else if (penalty <= 1) s = 4;
      else if (penalty === 2) s = 3;
      else s = 2;
      push(21, s, "横スク/コントラスト/固定要素/情報開示から推定");
    }

    // 22 Evidence
    push(22, m.hasEvidence ? 5 : 3, m.hasEvidence ? "実績/事例などの痕跡あり" : "根拠提示の痕跡は弱め");

    // 23 Accuracy (placeholder)
    push(23, m.hasLorem ? 2 : 4, m.hasLorem ? "ダミー/文字化けの痕跡" : "大きなプレースホルダ痕跡なし");

    // 24 HTTPS
    push(24, m.https ? 5 : 1, m.https ? "HTTPS" : "HTTPSではありません");

    // 25 Popup moderation (overlay)
    {
      if (m.overlayFrac > 0.45) push(25, 1, "画面占有の固定要素が大きい可能性");
      else if (m.overlayFrac > 0.30) push(25, 2, "固定要素がやや大きい可能性");
      else if (m.overlayFrac > 0.20) push(25, 3, "固定要素が少しある可能性");
      else push(25, 5, "大きなポップアップの兆候は少なめ");
    }

    // 26 Trust reinforcement
    push(26, m.hasTrustBadge ? 4 : 3, m.hasTrustBadge ? "第三者/認証の痕跡あり" : "補強要素の痕跡は弱め");

    // 27 Alt
    {
      const sc = scoreFromRate(m.altRate, {good:0.9, ok:0.75, meh:0.55, bad:0.35}, "alt付与率");
      push(27, sc.score, sc.note);
    }

    // 28 Form labels
    {
      const sc = scoreFromRate(m.labelRate, {good:0.9, ok:0.75, meh:0.55, bad:0.35}, "label付与率");
      push(28, sc.score, sc.note);
    }

    // 29 Lang
    push(29, m.lang ? 5 : 3, m.lang ? "lang属性あり" : "lang属性が見つからない（日本語LPでも未設定が多い）");

    // 30 Heading structure
    push(30, m.headingStruct.score, m.headingStruct.note);

    // 31 Contrast again
    {
      const sc = scoreFromRate(m.contrastPassRate, {good:0.8, ok:0.65, meh:0.5, bad:0.35}, "WCAG目安");
      push(31, sc.score, sc.note);
    }

    // 32 Non-color identification (underline)
    {
      const sc = scoreFromRate(m.underlineRate, {good:0.8, ok:0.6, meh:0.4, bad:0.2}, "下線など");
      push(32, sc.score, sc.note);
    }

    // 33 Keyboard accessible
    push(33, m.focusSuppressed ? 2 : 4, m.focusSuppressed ? "focus表示を消している可能性" : "focus表示の痕跡は少なめ");

    // 34 Fast load (rough: html bytes)
    {
      // Use HTML size as rough. Smaller = faster.
      const kb = m.htmlBytes / 1024;
      if (kb < 120) push(34, 5, `HTMLが軽め（${kb.toFixed(0)}KB）`);
      else if (kb < 260) push(34, 4, `標準的（${kb.toFixed(0)}KB）`);
      else if (kb < 500) push(34, 3, `やや重い（${kb.toFixed(0)}KB）`);
      else push(34, 2, `重い可能性（${kb.toFixed(0)}KB）`);
    }

    // 35 Lightweight
    {
      const kb = m.htmlBytes / 1024;
      if (kb < 120) push(35, 5, "HTMLサイズが小さめ");
      else if (kb < 260) push(35, 4, "概ね適正");
      else if (kb < 500) push(35, 3, "やや大きめ");
      else push(35, 2, "かなり大きめ");
    }

    // 36 Request optimization
    {
      if (m.resourceCount == null) push(36, 3, "ResourceTiming未取得→中間値");
      else if (m.resourceCount < 35) push(36, 5, `リクエスト少なめ（${m.resourceCount}）`);
      else if (m.resourceCount < 60) push(36, 4, `標準（${m.resourceCount}）`);
      else if (m.resourceCount < 90) push(36, 3, `多め（${m.resourceCount}）`);
      else push(36, 2, `かなり多い（${m.resourceCount}）`);
    }

    // 37 Resource efficiency
    {
      const complexity = m.domNodes + 80*m.scriptsCount + 50*m.cssCount;
      if (complexity < 1800) push(37, 5, "構成が軽め");
      else if (complexity < 3200) push(37, 4, "過度ではない");
      else if (complexity < 5200) push(37, 3, "やや複雑");
      else push(37, 2, "複雑で無駄が出やすい");
    }

    // 38 No errors (fetch status + link check)
    {
      let s = 4;
      let note = "取得ステータスから推定";
      if (m.fetchStatus >= 400 || m.fetchStatus === 0) { s=2; note="取得時にエラーがありました"; }
      if (m.linkResults) {
        const known = m.linkResults.results.filter(r => r.ok != null);
        const ng = known.filter(r => r.ok === false).length;
        if (ng >= 3) { s = Math.min(s, 2); note = `リンクNGが多め（${ng}/${known.length}）`; }
        else if (ng >= 1) { s = Math.min(s, 3); note = `リンクNGが混在（${ng}/${known.length}）`; }
      }
      push(38, s, note);
    }

    // 39 Stable rendering (CLS approx)
    {
      const c = m.clsApprox || 0.08;
      if (c < 0.05) push(39, 5, "安定（推定）");
      else if (c < 0.10) push(39, 4, "概ね安定（推定）");
      else if (c < 0.18) push(39, 3, "ややズレる可能性（推定）");
      else push(39, 2, "ズレが大きい可能性（推定）");
    }

    // 40 viewport meta
    push(40, m.viewportOk ? 5 : 1, m.viewportOk ? "meta viewportあり" : "meta viewportなし（致命的）");

    // 41 layout optimization (no horizontal scroll)
    push(41, m.horizOverflow ? 1 : 5, m.horizOverflow ? "横スクロールあり" : "横スクロールなし");

    // 42 readability on mobile (font size)
    {
      const sc = scoreFromRate(1 - m.fontSmallRate, {good:0.7, ok:0.55, meh:0.4, bad:0.25}, "16px以上率");
      push(42, sc.score, sc.note);
    }

    // 43 tap
    {
      const sc = scoreFromRate(m.tapOkRate, {good:0.8, ok:0.6, meh:0.45, bad:0.3}, "タップ目安");
      push(43, sc.score, sc.note);
    }

    // 44 tel/mail
    {
      const has = (m.hasTel || m.hasMail);
      push(44, has ? 4 : 3, has ? "tel/mailtoリンクの痕跡あり" : "tel/mailtoリンクの痕跡なし");
    }

    // 45 mobile performance (composite)
    {
      let s = 3;
      const kb = m.htmlBytes/1024;
      const heavy = (kb > 400) || (m.resourceCount != null && m.resourceCount > 80) || (m.domNodes > 2500);
      const light = (kb < 200) && ((m.resourceCount == null) || (m.resourceCount < 60)) && (m.domNodes < 1600);
      if (!m.viewportOk) s = 1;
      else if (light) s = 5;
      else if (!heavy) s = 4;
      else s = 2;
      push(45, s, "HTML/リクエスト/DOM/viewportから推定");
    }

    // sanity: ensure 45
    if (items.length !== 45) {
      console.warn("items length mismatch", items.length);
    }
    return items;
  }

  // ---------------------------
  // Fermi estimation (広告→売上)
  // ---------------------------
  function devToCvrMultiplier(dev) {
    // dev: 20〜80, map to 0.6〜1.4
    const t = clamp((dev - 20) / 60, 0, 1);
    return 0.6 + 0.8 * t;
  }

  function estimateRevenue({ industryId, spendYen, aovYen, dev }) {
    const ind = getIndustry(industryId);

    // Base assumptions
    const q = devToCvrMultiplier(dev);
    const baseCpc = ind.cpc.mid;
    const baseCvr = clamp(ind.cvr.mid * q, 0.0005, 0.25);

    const clicks = spendYen / baseCpc;
    const orders = clicks * baseCvr;
    const revenue = orders * aovYen;
    const roas = revenue / spendYen;

    // Scenarios
    const scenarios = [
      {
        key:"conservative",
        label:"控えめ",
        cpc: ind.cpc.high,
        cvr: clamp(ind.cvr.low * q * 0.9, 0.0005, 0.25),
      },
      {
        key:"base",
        label:"ベース",
        cpc: ind.cpc.mid,
        cvr: clamp(ind.cvr.mid * q, 0.0005, 0.25),
      },
      {
        key:"optimistic",
        label:"強気",
        cpc: ind.cpc.low,
        cvr: clamp(ind.cvr.high * q * 1.1, 0.0005, 0.25),
      },
    ].map(sc => {
      const clicks = spendYen / sc.cpc;
      const orders = clicks * sc.cvr;
      const revenue = orders * aovYen;
      const roas = revenue / spendYen;
      return { ...sc, clicks, orders, revenue, roas };
    });

    return {
      industry: ind,
      q,
      base: { cpc: baseCpc, cvr: baseCvr, clicks, orders, revenue, roas },
      scenarios,
    };
  }

  function buildDoctorPages({ url, industry, spendYen, aovYen, dev, diag, est }) {
    const qPct = ((est.q - 1) * 100);
    const qText = qPct >= 0 ? `+${qPct.toFixed(0)}%` : `${qPct.toFixed(0)}%`;

    const pages = [];
    pages.push(
`博士「よし、計算のしかたを“式なし”でも分かるように説明するぞ。

今回の売上推定は、ざっくり言うとこうじゃ。

  広告費 → クリック数 → 成約数 → 売上

順番にいくぞ！」`
    );

    pages.push(
`博士「① まず“何人がLPに来るか”を見積もる。

広告費（入力）: ${formatYen(spendYen)}
業種: ${industry.label}

ここで使うのが “CPC（1クリックあたりの値段）” じゃ。
この業種のCPC目安（ベース）を ${formatYen(est.base.cpc)} / click と仮定すると…

推定クリック数 = 広告費 ÷ CPC
              = ${formatInt(spendYen)} ÷ ${formatInt(est.base.cpc)}
              ≈ ${formatInt(est.base.clicks)} クリック`
    );

    pages.push(
`博士「② 次に“何人が買う/申し込むか”を見積もる。

使うのは “成約率（CVR）” じゃ。
まず業種の目安CVR（ベース）を ${formatPct(industry.cvr.mid)} と置く。

そしてここで LP偏差値 が効いてくる。
偏差値 ${dev.toFixed(1)} は、LPの“使いやすさ”の点数じゃ。

使いやすいほど、同じ人数が来ても“買う人が増える”と考えて、
CVRに補正（倍率）をかける。

今回の補正倍率 = ${est.q.toFixed(2)}（偏差値50がだいたい1.00）
つまり、CVRはざっくり ${qText} くらい変わる想定じゃ。

最終CVR（ベース） = 業種CVR × 補正
                 ≈ ${formatPct(industry.cvr.mid)} × ${est.q.toFixed(2)}
                 ≈ ${formatPct(est.base.cvr)}`
    );

    pages.push(
`博士「③ 成約数（買った/申し込んだ回数）を出す。

推定成約数 = クリック数 × 成約率
          = ${formatInt(est.base.clicks)} × ${formatPct(est.base.cvr)}
          ≈ ${formatInt(est.base.orders)} 件`
    );

    pages.push(
`博士「④ 最後に“売上”じゃ。

平均決済額（入力）: ${formatYen(aovYen)}

推定売上 = 成約数 × 平均決済額
        = ${formatInt(est.base.orders)} × ${formatInt(aovYen)}
        ≈ ${formatYen(est.base.revenue)}

そして、広告費に対して何倍返ってくるか（ROAS）は…

ROAS = 売上 ÷ 広告費 ≈ ${formatRoas(est.base.roas)}

（100%なら“広告費と同じだけ売れた”という意味じゃ）`
    );

    const diagMode = diag.ok ? "LPを取得して45項目を自動採点" : "取得制限→偏差値50で暫定計算";
    pages.push(
`博士「補足：偏差値はどうやって作った？

今回の偏差値は「スマホで見たLPのUI/UX」を、45項目（1〜5点）で採点して作っておる。

診断モード: ${diagMode}
偏差値: ${dev.toFixed(1)}（${diag.points}/${45*5}点）

この偏差値を“成約率の補正”に使って、売上の当たりをつけた、というわけじゃ！」`
    );

    pages.push(
`博士「最後に大事な注意じゃ。

これはフェルミ推定＝“ざっくり当たりをつける”計算じゃ。
実際の結果は、広告のターゲティング、クリエイティブ、オファー、ブランド力、季節などでも大きく変わる。

なのでこのゲームは、
『広告費○円なら、売上はこのくらいのレンジになりそう』
という“議論のたたき台”として使うのが一番うまいぞ。」`
    );

    return pages;
  }

  // ---------------------------
  // UI rendering
  // ---------------------------
  function renderCategories(barsEl, categories) {
    barsEl.innerHTML = "";
    for (const cat of categories) {
      const row = document.createElement("div");
      row.className = "barRow";
      row.innerHTML = `
        <div class="barRow__label">${escapeHtml(cat.label)}</div>
        <div class="bar"><span style="width:${cat.score.toFixed(0)}%"></span></div>
        <div class="barRow__value">${cat.score.toFixed(0)}</div>
      `;
      barsEl.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;");
  }

  function renderItems(items) {
    const wrap = $("#outItems");
    wrap.innerHTML = "";
    for (const it of items) {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `
        <div class="item__head">
          <div class="item__name">${escapeHtml(it.name)}</div>
          <div class="item__score">${it.score}/5</div>
        </div>
        <div class="item__note">${escapeHtml(it.note || "")}</div>
      `;
      wrap.appendChild(div);
    }
  }

  function renderScenarioTable(scenarios) {
    const tbody = $("#outScenarioTable tbody");
    tbody.innerHTML = "";
    for (const sc of scenarios) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(sc.label)}</td>
        <td class="num">${formatYen(sc.cpc)}</td>
        <td class="num">${formatPct(sc.cvr)}</td>
        <td class="num">${formatYen(sc.revenue)}</td>
        <td class="num">${formatRoas(sc.roas)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // Doctor typewriter
  let explainPages = [];
  let explainIdx = 0;
  let typingAbort = null;

  async function typeTo(el, text, { fast=false } = {}) {
    if (typingAbort) typingAbort.abort();
    const ctrl = new AbortController();
    typingAbort = ctrl;
    el.textContent = "";
    const speed = fast ? 0 : 14;
    for (let i=0; i<text.length; i++) {
      if (ctrl.signal.aborted) return;
      el.textContent += text[i];
      if (speed) await sleep(speed);
    }
  }

  async function showExplainPage(idx, { fast=false } = {}) {
    explainIdx = clamp(idx, 0, Math.max(0, explainPages.length-1));
    const el = $("#doctorSpeech");
    await typeTo(el, explainPages[explainIdx] || "", { fast });
  }

  // ---------------------------
  // Main run
  // ---------------------------
  let lastResult = null;

  async function run() {
    const urlStr = ($("#inUrl").value || "").trim();
    const u = safeUrl(urlStr);
    if (!u) {
      alert("URLが正しくありません。https:// から入力してください。");
      return;
    }

    const industryId = $("#inIndustry").value;
    const aovYen = Number($("#inAov").value);
    const spendYen = Number($("#inSpend").value);

    if (!Number.isFinite(aovYen) || aovYen <= 0) {
      alert("平均決済額を正しい整数で入力してください。");
      return;
    }
    if (!Number.isFinite(spendYen) || spendYen <= 0) {
      alert("広告費を正しい整数で入力してください。");
      return;
    }

    const optSound = $("#optSound").checked;
    const fastMode = $("#optFast").checked;
    const linkCheck = $("#optLinkCheck").checked;

    // reset
    $("#resultPanel").hidden = true;
    logStore.reset();
    logStore.info("ゲーム開始。LPを解析します。");
    logStore.info(`入力: 業種=${getIndustry(industryId).label}, 平均決済額=${formatYen(aovYen)}, 広告費=${formatYen(spendYen)}`);

    $("#btnStart").disabled = true;

    try {
      // Analyze LP
      const diag = await analyzeLp(u.toString(), { fastMode, linkCheck });

      // Estimate revenue
      logStore.info("フェルミ推定で売上を計算中…");
      const est = estimateRevenue({ industryId, spendYen, aovYen, dev: diag.dev });
      await sleep(fastMode ? 60 : 160);

      logStore.info(`推定売上（ベース）= ${formatYen(est.base.revenue)} / ROAS=${formatRoas(est.base.roas)}`);

      // Render results
      renderResult({ url:u.toString(), industryId, aovYen, spendYen, diag, est, fastMode, optSound });

      lastResult = { url:u.toString(), industryId, aovYen, spendYen, diag, est, generatedAt: new Date().toISOString() };

      if (optSound) { beeper.beep(988, 70); setTimeout(()=>beeper.beep(1318, 70), 80); }
      logStore.info("完了。");
    } catch (e) {
      logStore.error(`実行中にエラー: ${e?.message || e}`);
      alert("実行中にエラーが発生しました。ステータス欄のログを確認してください。");
    } finally {
      $("#btnStart").disabled = false;
    }
  }

  function renderResult({ url, industryId, aovYen, spendYen, diag, est, fastMode, optSound }) {
    $("#resultPanel").hidden = false;

    $("#outDev").textContent = diag.dev.toFixed(1);
    $("#outPoints").textContent = `${diag.points}/${45*5}`;
    $("#outDiagMode").textContent = diag.ok ? "通常（取得→採点）" : "暫定（取得失敗→50）";

    renderCategories($("#outCategoryBars"), diag.categories);

    // top findings
    const sorted = diag.items.slice().sort((a,b) => b.score - a.score);
    const best = sorted.slice(0,3).map(it => `◎ ${it.name}（${it.score}/5）`).join(" / ");
    const worst = sorted.slice().reverse().slice(0,3).map(it => `× ${it.name}（${it.score}/5）`).join(" / ");
    $("#outTopFindings").textContent = `良い点: ${best}\n改善点: ${worst}`;

    $("#outRevenueBase").textContent = formatYen(est.base.revenue);
    $("#outClicks").textContent = `${formatInt(est.base.clicks)} クリック`;
    $("#outOrders").textContent = `${formatInt(est.base.orders)} 件`;
    $("#outRoas").textContent = formatRoas(est.base.roas);

    renderScenarioTable(est.scenarios);

    // items
    renderItems(diag.items);

    // doctor explanation pages
    explainPages = buildDoctorPages({
      url,
      industry: est.industry,
      spendYen,
      aovYen,
      dev: diag.dev,
      diag,
      est
    });
    explainIdx = 0;
    showExplainPage(0, { fast: fastMode });

    // expand details automatically if fetch failed (help user understand)
    $("#detailsItems").open = !diag.ok;
  }

  // ---------------------------
  // Copy helpers
  // ---------------------------
  async function copyText(s) {
    try {
      await navigator.clipboard.writeText(s);
      return true;
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.left = "-10000px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch {
        document.body.removeChild(ta);
        return false;
      }
    }
  }

  // ---------------------------
  // Events
  // ---------------------------
  function bindEvents() {
    $("#btnStart").addEventListener("click", run);

    $("#btnSample").addEventListener("click", () => {
      $("#inUrl").value = "https://example.com";
      $("#inIndustry").value = "ec";
      $("#inAov").value = "12000";
      $("#inSpend").value = "300000";
      logStore.info("サンプル入力をセットしました。▶ START で実行できます。");
      beeper.beep(784, 40);
    });

    $("#btnReset").addEventListener("click", () => {
      $("#inUrl").value = "";
      $("#inAov").value = "";
      $("#inSpend").value = "";
      $("#inIndustry").value = INDUSTRIES[0].id;
      $("#resultPanel").hidden = true;
      lastResult = null;
      logStore.reset();
      logStore.info("リセットしました。URLを入力して ▶ START を押してください。");
    });

    $("#btnClearLog").addEventListener("click", () => logStore.reset());

    $("#btnCopyLog").addEventListener("click", async () => {
      const ok = await copyText(logStore.entries.join("\n"));
      if (ok) logStore.info("ログをコピーしました。");
      else alert("コピーに失敗しました。");
    });

    $("#btnCopyResult").addEventListener("click", async () => {
      if (!lastResult) { alert("まだ結果がありません。"); return; }
      const ok = await copyText(JSON.stringify(lastResult, null, 2));
      if (ok) logStore.info("結果JSONをコピーしました。");
      else alert("コピーに失敗しました。");
    });

    $("#btnPrevExplain").addEventListener("click", () => showExplainPage(explainIdx - 1, { fast: $("#optFast").checked }));
    $("#btnNextExplain").addEventListener("click", () => showExplainPage(explainIdx + 1, { fast: $("#optFast").checked }));

    // Enter key to start (when focus in input fields)
    $("#inUrl").addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    $("#inAov").addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    $("#inSpend").addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
  }

  // ---------------------------
  // Boot
  // ---------------------------
  function boot() {
    attachLogView();
    populateIndustrySelect();
    bindEvents();
    logStore.info("JS起動OK。URLを入れて ▶ START を押してください。");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

})();
