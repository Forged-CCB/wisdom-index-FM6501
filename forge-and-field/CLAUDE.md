# Forge and Field: guide for Claude Code

Read this first. It records what has been built, what was decided and why, and what comes next.

## What this is

Forge and Field is a Bible study and teaching-prep app. It is built first for John Fariss, who teaches the "One Story" series in the Forged men's ministry at Calvary Chapel (Bakersfield, CA), and may later be offered to other churches. The aim is one tool that carries a lesson from gathering notes all week to teaching it and sharing it afterward.

The original prototype is `prototype/index.html`, a single-file web app first built as a Claude artifact; John has used it on an iPad with Apple Pencil. It is kept unchanged for reference. The live app is `public/index.html`, the same code with the artifact-only APIs replaced by calls to the server in `server/` (see "Project setup" below).

## Project setup (roadmap step 1, first pass)

- **Server:** Node 22.18+ running TypeScript directly (type stripping, no build step), with Hono. `server/app.ts` holds the routes and is exported for tests; `server/index.ts` starts it.
- **Database:** SQLite via `node:sqlite`, one file (`FF_DB`). Tables: `users`, `sessions`, `lessons(user_id, id, data, updated)`, `canvases(user_id, lesson_id, data, updated)`. Lessons and canvases are stored as whole JSON documents in the models below, so no chunking is needed. A write with an older `updated` than the stored copy gets a 409 (the client then loads the newer copy).
- **Auth:** email and password (scrypt), a random session token in an httpOnly SameSite=Lax cookie, 60-day sessions. Accounts are created by invitation with `npm run user:add`; there is no open sign-up. Every non-GET API call must send `x-ff: 1` (CSRF guard). Login is throttled per email.
- **AI:** `server/ai.ts`. The browser posts to `/api/ai/<task>` with lesson fields; prompts and output schemas live on the server, so the endpoint is not a general chatbot. Tasks: `suggest`, `study`, `idea`, `questions`, `transition`, `read-ink`. Model `FF_MODEL` (default `claude-opus-5-5`), low effort, structured outputs via Zod, server-side refusal fallback (`fallbacks: "default"`). 40 requests per user per 10 minutes.
- **Front end:** still the prototype's plain JavaScript. The integration seam is `api()` near the top of the script plus `task()` for AI. Downloads use normal browser blob downloads. Without the server (for example `python -m http.server` in `public/`), the app falls back to browser-only storage.
- **API:** `GET /api/me`, `GET /api/lessons`, `PUT|DELETE /api/lessons/:id`, `POST /api/import` (prototype backup format), `GET|PUT /api/canvas/:lessonId`, `POST /api/ai/:task`, `POST /api/login`, `POST /api/logout`.
- **Hosting:** `Dockerfile` with data on a `/data` volume; Fly.io or Render suggested. Not deployed yet.

Review notes from the move:
- The prototype's "fill passage" AI action asked the model to recite WEB text from memory. It had no button and was removed: Scripture text should come from the bundled BSB, never from the model.
- `aiStudy` and `suggHtml` are also left over from an earlier layout with no button; `study` stays as a server task in case it comes back.

Next in step 1: break `public/index.html` into modules (or move to a framework) once the native iPad plan is settled, add password reset by email, and deploy.

## How John works (design around this)

- He gathers notes, Scripture and questions through the week, often in scattered clusters rather than in order. He builds the lesson Friday to Monday, teaches on Monday, then turns the lesson into slides, a PDF for the men, and a podcast script.
- He handwrites study notes in Notability on an iPad. He likes ink that stays ink, with no conversion to text.
- He wants deliverables as HTML by default, not Word or other office formats.
- He works on a Windows desktop PC, an iPhone, and an iPad. He has no Mac yet (see the iOS note below).

## Decisions so far

- **Four tabs: Plan → Study → Build → Teach & export.**
- **Study is free-form gathering**, like a mind map or whiteboard. It is not structured boxes. Study methods (Observe-Interpret-Apply, Big Idea, need and grace, and others) are prompts in a pull-down Guides drawer, never the structure of the notes.
- **Build is where structure happens.** The lesson is a list of blocks that can be dragged to reorder. A Section heading carries its blocks with it when dragged. Every gap between two blocks has a transition slot. A transition belongs to the *pair* of blocks around it, so moving a block flags new gaps for review and keeps old transitions in case a pair comes back together.
- **Series.** Each lesson has a series name and a part number, and there are series views and a series outline export.
- **Bible text: the Berean Standard Bible (BSB)**, which is public domain and bundled with the app. The WEB could be a second option. NET, ESV, NIV and NASB need permission or a paid license (for example through API.Bible) before any paid version.
- **AI helps; it never writes the lesson.** It suggests study material, checks the big idea, drafts transitions, suggests discussion questions, and reads handwriting on request. Anything AI-made is marked and easy to delete.
- **Ink in production should be native.** The web canvas (with perfect-freehand) is good enough to test the workflow, but John says it is still slightly laggy compared with Notability. The production ink pieces (Study canvas and Bible reader) should be a native iPad app using Apple's PencilKit, sharing lesson data with the web app.
- **Live listening (later) saves no audio.** It would listen during a sermon or discussion, pop up the passages being referenced, and let John tap to add a bullet. It records no full transcript.

## What the prototype does (feature inventory)

- **Plan:** title, passage, teach date, sermon type, mode (Teach, Discuss or Solo), method, series and part number. It loads a method's starter blocks, shows a prep cycle with dates counted back from the teach date, and lists the other lessons in the same series.
- **Study canvas:**
  - Ink: pen in four colors and four sizes, with a smoothing setting; highlighter; whole-stroke eraser; lasso; arrows.
  - Note, Question and Scripture cards. A Scripture card parses references such as "He 11:24-26", "Ex 32:11-14, 30-32" or "2 Cor 12:9" and shows the BSB text.
  - Guides drawer, undo and redo, zoom and fit.
  - Quick Capture inbox for notes captured from a phone.
  - "Suggest" (AI) adds suggested cards with dashed borders.
  - Lasso a cluster, then "Send to Build" to turn it into a block. Its ink comes along as an SVG.
- **Build:**
  - Blocks with kind and tone, drag to reorder, section grouping, and transitions at every gap, with an AI "Draft" button for each.
  - Side panel: big idea (subject and complement) with an AI check, need and grace, and a meter showing how much of the lesson is trouble versus grace.
  - Discussion-question suggestions and "Read handwriting" on blocks that carry ink.
- **Teach & export:** previews as a manuscript, an outline or a note card, with a word count and estimated minutes. Exports: HTML, Markdown, copy text, a JSON backup and restore of all lessons, and a whole-series HTML outline.

## Prototype internals worth knowing

- One file with plain JavaScript (no framework) and inline CSS. The Archivo and Source Sans 3 fonts come from Google Fonts.
- **Artifact-only APIs must be replaced.** The prototype uses `window.claude.use(...)`, which only exists inside Claude artifacts:
  - `db`: per-user document store. Lessons are at `data/users/<uid>/<lessonId>`. Canvases are at `data/users/<uid>/canvas/pages/<lessonId>~<i>`, split into 180 KB string chunks because of a 256 KB document limit.
  - `sample`: calls Claude, including images for reading handwriting.
  - `downloads`: saves files.
  - `user`: user id.

  Replace these with a real backend, auth, the Anthropic API (server-side), and normal browser downloads.
- localStorage keys: `ff-lessons`, `ff-cur`, `ff-tab`, `ff-sf` (series filter), `ff-pen`, and `ff-cv-<lessonId>` (canvas).
- **Lesson model:** `{id, title, ref, date, type, method, mode, series, part, passage, obs, interp, app, xrefs, qs, subj, comp, need, grace, blocks:[{id, kind, title, body, tone, ink?}], trans:{"<blockA>><blockB>": text}, done:{phase: bool}, updated, sample?}`.
  - `obs`, `interp`, `app`, `xrefs` and `qs` are legacy study fields. They are turned into cards the first time a canvas is opened.
  - `ink` is a sanitized SVG string.
- **Canvas model:** `{v:1, u:updatedMs, strokes:[{id, c, w, h?(highlighter), f?(freehand), sl?(streamline), sp?(simulated pressure), p:[x,y,pressure,...]}], cards:[{id, k:'note'|'q'|'scr', x, y, w, t, ref?, inbox?, d?, ai?}], arrows:[{id, a:[x,y], b:[x,y], c}], view:{x,y,z}}`. Coordinates are world units, and the view is a translate plus scale.
- **Pen pipeline:** while the Pencil is down, the stroke is drawn on a 2D canvas overlay (desynchronized context) using perfect-freehand outlines, with a predicted-events tail where the browser supports it. On lift it becomes a filled SVG path. Outline paths use midpoint quadratic curves; the "T" shorthand caused jagged edges. Saving waits for about 5 seconds of no writing and also happens when the page is hidden or the tab changes. Undo copies are shallow.
- **Input rules:** the Apple Pencil draws; fingers pan and pinch once a pen has been seen; a finger tap on card text always types. Text-selection blocking is applied to the canvas but explicitly re-enabled on card text, because iOS Safari otherwise refuses to type there.
- **Bible data:** `public/bsb/<CODE>.json` is an array of chapters, each an array of verse strings. `index.json` lists `[code, name, chapterCount]` for all 66 books. It was built from github.com/crizin/bible-db (`data/bsb/bsb.jsonl`, 31,102 verses) and spot-checked against Genesis 22:14, John 3:16 and Exodus 3:11.

## Roadmap

1. **Set up the real project:** git repository, a framework, hosting, auth, a database, and a server-side Anthropic API proxy. Move the prototype's features over. Bring lesson import in from the prototype's JSON backup format.
2. **Native iPad app for ink:** Study canvas with PencilKit, sharing the lesson and canvas data model above.
   - Building iOS apps normally requires a Mac with Xcode, and John is on Windows. Options: a Mac (he's considering one), Expo or React Native with cloud builds (EAS), or a cloud Mac.
   - He also needs an Apple Developer account ($99 a year) for TestFlight or the App Store.
3. **Bible reader with ink:**
   - Highlights anchored to words.
   - Margin ink anchored to verses, which folds down to a small icon.
   - Sticky notes.
   - A fixed "printed page" journaling mode.
   - Notes surface automatically in lessons on the same passage.
4. **Import Notability PDFs** as canvas pages.
5. **Save exports straight to Box.** John's files live in Box.
6. **Phase 2:** live listening (no audio saved) and a rehearse mode that tracks pace, pauses and filler words.

## Other material

- `docs/sermon-prep-research.html`: research behind the methods (sermon types, prep frameworks, Bible study methods, delivery, speaking tips) and how each maps to app features.
- `licenses/`: third-party notices.
