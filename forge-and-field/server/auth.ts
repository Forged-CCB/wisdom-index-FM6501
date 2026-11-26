// Email + password accounts with server-side sessions in an httpOnly cookie.
// Accounts are created by invitation (npm run user:add), not open sign-up.
import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from "node:crypto";
import type { DB } from "./db.ts";

const SESSION_DAYS = 60;
export const COOKIE = "ff_session";

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, k] = stored.split("$");
  if (alg !== "scrypt" || !s || !k) return false;
  const want = Buffer.from(k, "base64");
  const got = scryptSync(pw, Buffer.from(s, "base64"), want.length);
  return timingSafeEqual(want, got);
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export type User = { id: string; email: string; name: string };

export function createUser(db: DB, email: string, password: string, name = ""): User {
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, email, name, pw_hash, created) VALUES (?, ?, ?, ?, ?)")
    .run(id, email.trim(), name.trim(), hashPassword(password), Date.now());
  return { id, email: email.trim(), name: name.trim() };
}

export function setPassword(db: DB, email: string, password: string): boolean {
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  const r = db.prepare("UPDATE users SET pw_hash = ? WHERE email = ?").run(hashPassword(password), email.trim());
  if (r.changes) db.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(email.trim());
  return r.changes > 0;
}

// A dummy hash so a wrong email takes as long as a wrong password.
const DUMMY = hashPassword(randomBytes(12).toString("hex"));

export function login(db: DB, email: string, password: string): { token: string; user: User } | null {
  const row = db.prepare("SELECT id, email, name, pw_hash FROM users WHERE email = ?").get(String(email).trim()) as
    | { id: string; email: string; name: string; pw_hash: string }
    | undefined;
  const ok = verifyPassword(String(password), row ? row.pw_hash : DUMMY);
  if (!row || !ok) return null;
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)")
    .run(sha(token), row.id, Date.now() + SESSION_DAYS * 864e5);
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  return { token, user: { id: row.id, email: row.email, name: row.name } };
}

export function userForToken(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  const row = db.prepare(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?",
  ).get(sha(token), Date.now()) as User | undefined;
  return row ?? null;
}

export function logout(db: DB, token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

export const sessionMaxAge = SESSION_DAYS * 86400;
