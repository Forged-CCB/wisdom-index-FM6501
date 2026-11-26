import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.ts";
import { createUser } from "../server/auth.ts";
import { createApp } from "../server/app.ts";

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

function setup() {
  const db = openDb(":memory:");
  createUser(db, "john@example.com", "correct horse battery", "John");
  createUser(db, "other@example.com", "another long password", "Other");
  const app = createApp(db);
  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const headers: Record<string, string> = { "x-ff": "1" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    const r = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null), setCookie: r.headers.get("set-cookie") };
  };
  const signIn = async (email: string, password: string) => {
    const r = await call("POST", "/api/login", { email, password });
    assert.equal(r.status, 200);
    return r.setCookie!.split(";")[0];
  };
  return { db, app, call, signIn };
}

const lesson = (id: string, updated: number, title = "T") => ({ id, title, updated, blocks: [], trans: {} });

test("login rejects a wrong password and protects the API", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/login", { email: "john@example.com", password: "nope" })).status, 401);
  assert.equal((await call("GET", "/api/lessons")).status, 401);
});

test("mutations need the x-ff header", async () => {
  const { app } = setup();
  const r = await app.request("/api/login", { method: "POST", body: "{}" });
  assert.equal(r.status, 400);
});

test("lessons save, list, and stay private to each user", async () => {
  const { call, signIn } = setup();
  const a = await signIn("john@example.com", "correct horse battery");
  const b = await signIn("other@example.com", "another long password");
  assert.equal((await call("PUT", "/api/lessons/l1", lesson("l1", 100), a)).status, 200);
  assert.deepEqual((await call("GET", "/api/lessons", undefined, a)).json.lessons.map((l: any) => l.id), ["l1"]);
  assert.deepEqual((await call("GET", "/api/lessons", undefined, b)).json.lessons, []);
});

test("an older write does not overwrite a newer one", async () => {
  const { call, signIn } = setup();
  const a = await signIn("john@example.com", "correct horse battery");
  await call("PUT", "/api/lessons/l1", lesson("l1", 200, "new"), a);
  const r = await call("PUT", "/api/lessons/l1", lesson("l1", 100, "old"), a);
  assert.equal(r.status, 409);
  assert.equal(r.json.lesson.title, "new");
});

test("prototype backup import", async () => {
  const { call, signIn } = setup();
  const a = await signIn("john@example.com", "correct horse battery");
  const backup = { app: "forge-and-field", version: 1, lessons: [lesson("x1", 1), lesson("x2", 2), { id: "bad" }] };
  const r = await call("POST", "/api/import", backup, a);
  assert.deepEqual(r.json, { imported: 2, skipped: 1 });
});

test("canvas round trip, and deleting a lesson removes its canvas", async () => {
  const { call, signIn } = setup();
  const a = await signIn("john@example.com", "correct horse battery");
  const cv = { v: 1, u: 5, strokes: [{ id: "s", c: "#000", w: 2, p: [1, 2, 0.5] }], cards: [], arrows: [], view: { x: 0, y: 0, z: 1 } };
  await call("PUT", "/api/lessons/l1", lesson("l1", 1), a);
  assert.equal((await call("PUT", "/api/canvas/l1", cv, a)).status, 200);
  assert.deepEqual((await call("GET", "/api/canvas/l1", undefined, a)).json.canvas, cv);
  await call("DELETE", "/api/lessons/l1", undefined, a);
  assert.equal((await call("GET", "/api/canvas/l1", undefined, a)).json.canvas, null);
});

test("AI reports when it is not configured, and rejects unknown tasks", async () => {
  const { call, signIn } = setup();
  const a = await signIn("john@example.com", "correct horse battery");
  assert.equal((await call("POST", "/api/ai/questions", {}, a)).status, 503);
  assert.equal((await call("POST", "/api/ai/anything", {}, a)).status, 404);
  assert.equal((await call("POST", "/api/ai/idea", {}, a)).status, 400);
});

test("logout ends the session", async () => {
  const { call, signIn } = setup();
  const a = await signIn("john@example.com", "correct horse battery");
  await call("POST", "/api/logout", {}, a);
  assert.equal((await call("GET", "/api/me", undefined, a)).status, 401);
});
