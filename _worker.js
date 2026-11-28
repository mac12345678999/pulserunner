// Pulse Runner: Cloudflare Pages "advanced mode" worker.
// Serves index.html and adds /api/* for accounts, cloud saves, the records board,
// and the time trial / speedrun leaderboards with the number one player's ghost.
// Needs one KV namespace bound to the Pages project with the variable name PR_KV.

const enc = new TextEncoder();
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, "0")).join("");
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

async function pbkdf2(pw, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return hex(new Uint8Array(bits));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const num = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0; };

async function limited(KV, req) {
  const ip = req.headers.get("cf-connecting-ip") || "x";
  const key = "rl:" + ip + ":" + Math.floor(Date.now() / 600000);
  const n = parseInt((await KV.get(key)) || "0", 10) + 1;
  await KV.put(key, String(n), { expirationTtl: 900 });
  return n > 30;
}
async function newToken(KV, lname) {
  const t = hex(crypto.getRandomValues(new Uint8Array(32)));
  await KV.put("t:" + t, lname, { expirationTtl: 60 * 60 * 24 * 60 });
  return t;
}
async function who(KV, req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") || "");
  return m ? await KV.get("t:" + m[1]) : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const KV = env.PR_KV;
    const route = url.pathname.slice(5);
    if (route === "ping") return J({ ok: !!KV });
    if (!KV) return J({ error: "Storage is not set up" }, 500);

    let body = {};
    if (req.method === "POST" || req.method === "PUT") {
      try { const txt = await req.text(); if (txt.length > 400000) return J({ error: "Too large" }, 413); body = JSON.parse(txt || "{}"); }
      catch (e) { return J({ error: "Bad request" }, 400); }
    }

    if (route === "register" && req.method === "POST") {
      if (await limited(KV, req)) return J({ error: "Too many tries. Wait a few minutes." }, 429);
      const name = String(body.name || ""), pw = String(body.pw || "");
      if (!NAME_RE.test(name)) return J({ error: "Username must be 3 to 16 letters, numbers or _" }, 400);
      if (pw.length < 4 || pw.length > 100) return J({ error: "Password must be 4 or more characters" }, 400);
      const ln = name.toLowerCase();
      if (await KV.get("u:" + ln)) return J({ error: "That username is taken" }, 409);
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await KV.put("u:" + ln, JSON.stringify({ name, salt, h: await pbkdf2(pw, salt), t: Date.now() }));
      return J({ name, token: await newToken(KV, ln) });
    }

    if (route === "login" && req.method === "POST") {
      if (await limited(KV, req)) return J({ error: "Too many tries. Wait a few minutes." }, 429);
      const ln = String(body.name || "").toLowerCase(), pw = String(body.pw || "");
      const raw = NAME_RE.test(ln) ? await KV.get("u:" + ln) : null;
      if (!raw) return J({ error: "Wrong username or password" }, 401);
      const u = JSON.parse(raw);
      if (!same(await pbkdf2(pw, u.salt), u.h)) return J({ error: "Wrong username or password" }, 401);
      return J({ name: u.name, token: await newToken(KV, ln) });
    }

    if (route === "board" && req.method === "GET") {
      const b = (await KV.get("board", "json")) || {};
      return J({ board: Object.values(b) });
    }

    // ---- public records (time trials and speedruns) ----
    const REC_RE = /^(tl|tp|sr|sp):[A-Za-z0-9_-]{1,24}$/;
    if (route === "recs" && req.method === "GET") {
      const k = url.searchParams.get("k") || "";
      if (!REC_RE.test(k)) return J({ error: "Bad board" }, 400);
      const b = (await KV.get("r:" + k, "json")) || {};
      return J({ list: Object.values(b).sort((a, c) => a.v - c.v || a.t - c.t).slice(0, 25) });
    }
    if (route === "ghost" && req.method === "GET") {
      const k = url.searchParams.get("k") || "";
      if (!REC_RE.test(k)) return J({ error: "Bad board" }, 400);
      return J({ g: (await KV.get("g:" + k, "json")) || null });
    }
    if (route === "top" && req.method === "GET") {
      const p = url.searchParams.get("p") || "";
      if (!/^(tl|tp|sr|sp)$/.test(p)) return J({ error: "Bad board" }, 400);
      return J({ top: (await KV.get("i:" + p, "json")) || {} });
    }

    const me = await who(KV, req);
    if (!me) return J({ error: "Sign in first" }, 401);

    if (route === "save" && req.method === "GET") return J({ d: (await KV.get("s:" + me)) || null });
    if (route === "save" && req.method === "PUT") {
      if (typeof body.d !== "string" || body.d.length > 300000) return J({ error: "Bad save" }, 400);
      await KV.put("s:" + me, body.d);
      return J({ ok: true });
    }

    if (route === "score" && req.method === "POST") {
      const ureg = JSON.parse((await KV.get("u:" + me)) || "{}");
      const clean = (o, max) => { const r = {}; if (o && typeof o === "object") for (const k of Object.keys(o).slice(0, 60)) if (/^L\d{1,2}$/.test(k)) r[k] = num(o[k], max); return r; };
      const entry = { name: ureg.name || me, score: num(body.score, 1e6), cleared: num(body.cleared, 100), coins: num(body.coins, 1000), tc: num(body.tc, 1e9), best: clean(body.best, 100), lc: clean(body.lc, 20), mc: clean(body.mc, 1e6) };
      const board = (await KV.get("board", "json")) || {};
      board[me] = entry;
      const keys = Object.keys(board);
      if (keys.length > 400) { keys.sort((a, b) => board[a].score - board[b].score); for (const k of keys.slice(0, keys.length - 400)) delete board[k]; }
      await KV.put("board", JSON.stringify(board));
      return J({ ok: true });
    }

    if (route === "rec" && req.method === "POST") {
      const k = String(body.k || "");
      if (!REC_RE.test(k)) return J({ error: "Bad board" }, 400);
      const rl = "rr:" + me + ":" + Math.floor(Date.now() / 600000);
      const cnt = parseInt((await KV.get(rl)) || "0", 10) + 1;
      await KV.put(rl, String(cnt), { expirationTtl: 900 });
      if (cnt > 60) return J({ error: "Too many posts. Wait a few minutes." }, 429);
      const kind = k.slice(0, 2);
      let v = Number(body.v);
      if (!Number.isFinite(v)) return J({ error: "Bad value" }, 400);
      if (kind === "tl") { v = Math.floor(v); if (v < 1 || v > 5000) return J({ error: "Bad value" }, 400); }
      else { v = Math.round(v * 100) / 100; if (v < 1 || v > 86400) return J({ error: "Bad value" }, 400); }
      let g = null;
      if (body.g !== undefined && body.g !== null) {
        if (!Array.isArray(body.g) || body.g.length > 4000) return J({ error: "Bad ghost" }, 400);
        g = [];
        for (const e of body.g) {
          if (!Array.isArray(e) || e.length < 2 || e.length > 4) return J({ error: "Bad ghost" }, 400);
          g.push(e.map((x) => num(x, 1e7)));
        }
      }
      const ureg = JSON.parse((await KV.get("u:" + me)) || "{}");
      const name = ureg.name || me;
      const b = (await KV.get("r:" + k, "json")) || {};
      const old = b[me];
      if (old && old.v <= v) return J({ ok: true, kept: true });
      b[me] = { name, v, t: Date.now() };
      const keys = Object.keys(b);
      if (keys.length > 100) { keys.sort((x, y) => b[x].v - b[y].v); for (const x of keys.slice(100)) delete b[x]; }
      await KV.put("r:" + k, JSON.stringify(b));
      const best = Object.values(b).sort((x, y) => x.v - y.v || x.t - y.t)[0];
      if (best && best.name === name && best.v === v) {
        if (g) await KV.put("g:" + k, JSON.stringify({ name, v, e: g }));
        const idx = (await KV.get("i:" + kind, "json")) || {};
        idx[k.slice(3)] = { name, v };
        await KV.put("i:" + kind, JSON.stringify(idx));
      }
      return J({ ok: true });
    }

    return J({ error: "Not found" }, 404);
  },
};
