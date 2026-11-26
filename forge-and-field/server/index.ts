import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { MODEL, aiConfigured } from "./ai.ts";

const port = Number(process.env.PORT || 8787);
const dbFile = process.env.FF_DB || resolve("data/forge-and-field.db");
const db = openDb(dbFile);
const app = createApp(db, {
  secureCookies: process.env.NODE_ENV === "production",
  publicDir: "./public",
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`Forge and Field on http://localhost:${port}`);
  console.log(`Database: ${dbFile}`);
  console.log(aiConfigured() ? `AI: on (${MODEL})` : "AI: off (set ANTHROPIC_API_KEY to turn it on)");
});
