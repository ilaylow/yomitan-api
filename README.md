# yomitan-api

A small Fastify server that wraps [Yomitan](https://github.com/yomidevs/yomitan)'s
dictionary lookup so it can be used outside the browser extension.

Built to power [yomitan-lite-frontend](https://github.com/ilaylow/yomitan-lite-frontend),
but happy to be used standalone for anything that wants a Japanese dictionary HTTP API.

## What it does

- Imports Yomitan's term lookup modules from the upstream repo so any improvement
  in Yomitan's parsing lands here just by bumping the version
- Stores the unpacked Jitendex dictionary in SQLite via better-sqlite3
- Adds a small layer of user features on top: saved words, decks, tags, quiz
  scores, teacher / student linking, Google sign-in via JWT

## Endpoints (the public ones)

| Method | Path | What it does |
|---|---|---|
| GET | `/yomitan/api/term/simple/:term` | Dictionary lookup, simplified output |
| GET | `/yomitan/api/term/raw/:term` | Raw Yomitan output, full structure |
| POST | `/yomitan/api/tokenize` | Sentence into kuromoji morphemes |
| GET | `/yomitan/api/dictionaries` | Installed dictionaries |

Everything under `/yomitan/api/words`, `/decks`, `/tags`, `/quiz`, `/teacher`,
`/student` requires a JWT (issued by `POST /yomitan/auth/google`).

## Running it locally

```bash
npm install
node src/index.js
```

The server listens on port 3000 by default. Required env vars (set them in
`ecosystem.config.cjs` for pm2 or export them in your shell):

- `GOOGLE_CLIENT_ID` — your Google OAuth client for ID token verification
- `JWT_SECRET` — anything random and long
- `OPENAI_API_KEY` (optional) — for the AI sentence generation endpoint

Quick smoke test:

```bash
curl http://localhost:3000/yomitan/api/term/simple/犬
```

## Importing your own dictionary data

The server expects a SQLite DB at `data/app.db` with Yomitan's parsed
dictionary tables. The `cli/` directory has scripts to unpack a Jitendex zip
into that DB. Run them once before starting the server.

## Stack

- Fastify 5
- better-sqlite3
- jsonwebtoken + google-auth-library
- @sglkc/kuromoji for tokenization

## License

ISC
