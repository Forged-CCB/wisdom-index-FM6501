# Forge and Field

A Bible study and teaching-prep app for men's ministry: gather notes and ink all week, build the lesson from blocks, then teach and export.

## Run it on your computer (Windows, Mac or Linux)

You need [Node.js](https://nodejs.org) 22.18 or newer (the LTS installer is fine).

```
cd forge-and-field
npm install
npm run user:add -- you@example.com "Your Name"     # asks for a password (10+ characters)
npm start
```

Open http://localhost:8787 and sign in.

To turn on the AI help, copy `.env.example` to `.env` and put your Anthropic API key in it, then restart. Without a key, everything else works and the AI buttons say AI isn't set up.

Other commands:

- `npm run dev`: restarts the server when you change server code.
- `npm run user:password -- you@example.com`: set a new password (signs out old sessions).
- `npm test`: server tests. `npm run typecheck`: TypeScript check.

## Bring lessons over from the prototype

In the old prototype, open Teach & export and download the JSON backup. In the new app, use "Restore backup" on the same tab and pick that file. Lessons are saved to your account.

## Put it online

The app is one small Node server plus one SQLite file, so any host that runs a Docker container with a persistent disk works. The included `Dockerfile` stores data in `/data`.

- **Fly.io** or **Render**: create the app from this folder, attach a volume at `/data`, and set `ANTHROPIC_API_KEY` as a secret. Then create your account with `npm run user:add` in the host's console.
- Keep HTTPS on (both hosts do this by default). Sign-in cookies are marked secure when `NODE_ENV=production`.
- Back up `/data/forge-and-field.db`.

## What's inside

- `server/`: the Node server (Hono). `app.ts` has the routes, `auth.ts` the accounts, `db.ts` the SQLite tables, `ai.ts` the Claude calls.
- `public/`: the web app (`index.html`), the sign-in page and the bundled Berean Standard Bible (`bsb/`).
- `prototype/index.html`: the original artifact prototype, kept unchanged for reference.
- `test/`: server tests.
- `CLAUDE.md`: decisions, data model and roadmap. `docs/`: research. `licenses/`: third-party notices.
