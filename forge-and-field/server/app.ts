import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { DB } from "./db.ts";
import { COOKIE, login, logout, sessionMaxAge, userForToken, type User } from "./auth.ts";
import { AiError, AiInput, aiConfigured, runTask } from "./ai.ts";

type Env = { Variables: { user: User } };

const ID = z.string().min(1).max(120).regex(/^[\w\-~.]+$/);
const MAX_LESSON = 5_000_000; // bytes of JSON
const MAX_CANVAS = 25_000_000;

export function createApp(db: DB, opts: { secureCookies?: boolean; publicDir?: string } = {}) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
  });

  // Mutating API calls must carry this header. Browsers will not send a custom
  // header cross-site without CORS approval, which closes off CSRF.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.header("x-ff") !== "1") return c.json({ error: "bad_request" }, 400);
    await next();
  });

  // ---------- auth ----------
  const attempts = new Map<string, { n: number; t: number }>();
  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email || "").slice(0, 200);
    const key = email.toLowerCase();
    const a = attempts.get(key);
    if (a && a.n >= 8 && Date.now() - a.t < 15 * 60e3) return c.json({ error: "Too many tries. Wait 15 minutes." }, 429);
    const r = login(db, email, String(body.password || "").slice(0, 500));
    if (!r) {
      attempts.set(key, { n: (a && Date.now() - a.t < 15 * 60e3 ? a.n : 0) + 1, t: Date.now() });
      return c.json({ error: "That email and password do not match." }, 401);
    }
    attempts.delete(key);
    setCookie(c, COOKIE, r.token, {
      httpOnly: true, sameSite: "Lax", secure: opts.secureCookies ?? false, path: "/", maxAge: sessionMaxAge,
    });
    return c.json({ user: r.user });
  });

  app.post("/api/logout", (c) => {
    logout(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const requireUser = async (c: Context<Env>, next: Next) => {
    const u = userForToken(db, getCookie(c, COOKIE));
    if (!u) return c.json({ error: "signed_out" }, 401);
    c.set("user", u);
    await next();
  };
  for (const p of ["/api/me", "/api/lessons", "/api/lessons/*", "/api/canvas/*", "/api/ai/*", "/api/import"]) app.use(p, requireUser);

  app.get("/api/me", (c) => c.json({ user: c.get("user"), ai: aiConfigured() }));

  // ---------- lessons ----------
  app.get("/api/lessons", (c) => {
    const rows = db.prepare("SELECT data FROM lessons WHERE user_id = ? ORDER BY updated DESC").all(c.get("user").id) as { data: string }[];
    return c.json({ lessons: rows.map((r) => JSON.parse(r.data)) });
  });

  const putLesson = (uid: string, l: any): "ok" | "stale" => {
    const updated = Number(l.updated) || Date.now();
    const cur = db.prepare("SELECT updated FROM lessons WHERE user_id = ? AND id = ?").get(uid, l.id) as { updated: number } | undefined;
    if (cur && cur.updated > updated) return "stale";
    db.prepare(
      "INSERT INTO lessons (user_id, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
    ).run(uid, l.id, JSON.stringify({ ...l, updated }), updated);
    return "ok";
  };

  const validLesson = (l: any) => l && typeof l === "object" && ID.safeParse(l.id).success && Array.isArray(l.blocks);

  app.put("/api/lessons/:id", async (c) => {
    const raw = await c.req.text();
    if (raw.length > MAX_LESSON) return c.json({ error: "too_large" }, 413);
    let l: any;
    try { l = JSON.parse(raw); } catch { return c.json({ error: "bad_json" }, 400); }
    if (!validLesson(l) || l.id !== c.req.param("id")) return c.json({ error: "bad_lesson" }, 400);
    delete l.sample;
    const r = putLesson(c.get("user").id, l);
    if (r === "stale") {
      const row = db.prepare("SELECT data FROM lessons WHERE user_id = ? AND id = ?").get(c.get("user").id, l.id) as { data: string };
      return c.json({ error: "stale", lesson: JSON.parse(row.data) }, 409);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/lessons/:id", (c) => {
    const uid = c.get("user").id, id = c.req.param("id");
    db.prepare("DELETE FROM lessons WHERE user_id = ? AND id = ?").run(uid, id);
    db.prepare("DELETE FROM canvases WHERE user_id = ? AND lesson_id = ?").run(uid, id);
    return c.json({ ok: true });
  });

  // Bulk import of a prototype backup file: {app:"forge-and-field", version:1, lessons:[...]} or a bare array.
  app.post("/api/import", async (c) => {
    const raw = await c.req.text();
    if (raw.length > 50_000_000) return c.json({ error: "too_large" }, 413);
    let j: any;
    try { j = JSON.parse(raw); } catch { return c.json({ error: "bad_json" }, 400); }
    const list = Array.isArray(j) ? j : j && j.lessons;
    if (!Array.isArray(list)) return c.json({ error: "not_a_backup" }, 400);
    let imported = 0, skipped = 0;
    db.exec("BEGIN");
    try {
      for (const l of list) {
        if (!validLesson(l)) { skipped++; continue; }
        delete l.sample;
        if (putLesson(c.get("user").id, l) === "ok") imported++; else skipped++;
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return c.json({ imported, skipped });
  });

  // ---------- canvases ----------
  app.get("/api/canvas/:id", (c) => {
    const row = db.prepare("SELECT data FROM canvases WHERE user_id = ? AND lesson_id = ?").get(c.get("user").id, c.req.param("id")) as { data: string } | undefined;
    if (!row) return c.json({ canvas: null });
    return c.body(`{"canvas":${row.data}}`, 200, { "content-type": "application/json" });
  });

  app.put("/api/canvas/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID.safeParse(id).success) return c.json({ error: "bad_id" }, 400);
    const raw = await c.req.text();
    if (raw.length > MAX_CANVAS) return c.json({ error: "too_large" }, 413);
    let cv: any;
    try { cv = JSON.parse(raw); } catch { return c.json({ error: "bad_json" }, 400); }
    if (!cv || !Array.isArray(cv.strokes) || !Array.isArray(cv.cards)) return c.json({ error: "bad_canvas" }, 400);
    const uid = c.get("user").id, u = Number(cv.u) || Date.now();
    const cur = db.prepare("SELECT updated FROM canvases WHERE user_id = ? AND lesson_id = ?").get(uid, id) as { updated: number } | undefined;
    if (cur && cur.updated > u) return c.json({ error: "stale" }, 409);
    db.prepare(
      "INSERT INTO canvases (user_id, lesson_id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, lesson_id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
    ).run(uid, id, raw, u);
    return c.json({ ok: true });
  });

  // ---------- AI ----------
  const aiUse = new Map<string, number[]>();
  app.post("/api/ai/:task", async (c) => {
    const uid = c.get("user").id, now = Date.now();
    const recent = (aiUse.get(uid) || []).filter((t) => now - t < 10 * 60e3);
    if (recent.length >= 40) return c.json({ error: "rate_limited", message: "Too many AI requests. Try again in a few minutes." }, 429);
    recent.push(now);
    aiUse.set(uid, recent);
    const parsed = AiInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad_input", message: "That request was not understood." }, 400);
    try {
      return c.json(await runTask(c.req.param("task"), parsed.data));
    } catch (e) {
      if (e instanceof AiError) return c.json({ error: e.code, message: e.message }, e.status as 400);
      console.error(e);
      return c.json({ error: "server", message: "Something went wrong." }, 500);
    }
  });

  // ---------- static app ----------
  if (opts.publicDir) {
    const root = opts.publicDir;
    app.use("/bsb/*", async (c, next) => { await next(); c.header("Cache-Control", "public, max-age=604800"); });
    app.use("/*", serveStatic({ root }));
  }

  return app;
}
