BoligPortal Monitor

Quick script to poll the BoligPortal search page and print the last 5 postings every 10s, marking new postings since last scan.

Usage:

1. Install dependencies:

```bash
cd /Users/benceszabo/Downloads/boligportal-project
npm install
```

2. Run:

```bash
npm start
```

Configuration:

- Copy `.env.example` to `.env` and fill your SMTP credentials (do not commit `.env`).
- Required for email notifications: `SMTP_USER`, `SMTP_PASS`, and `SENDER` in `.env`.

Subscribe (frontend):

- Open http://localhost:3000, enter your email in the Subscribe box and click `Subscribe` to receive a confirmation email. New-post alerts will be emailed to subscribed addresses.

Files:

- `index.js`: main monitor and server
- `public/index.html`: frontend + SSE + subscribe UI
- `seen.json`: tracks seen postings (auto-deleted on shutdown)
- `subscribers.json`: stores subscribed emails
- `config.js` and `.env`: configuration


Notes:
- The script fetches the search URL and extracts the embedded JSON in the `<script id="store" type="application/json">` block.
- Seen IDs are stored in `seen.json` in the project folder.
