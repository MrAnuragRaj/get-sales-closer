# AGENTS.md

## Cursor Cloud specific instructions

### Overview

GetSalesCloser is a static HTML/CSS/JS website (no build system, no package manager, no bundler). All dependencies (Tailwind CSS, Supabase JS SDK) load via CDN at runtime. The backend is a hosted Supabase instance.

### Running the dev server

Serve files with any static HTTP server. ES modules (`type="module"`) require HTTP, not `file://`.

```bash
python3 -m http.server 8080
```

Pages: `index.html` (landing), `login.html`, `signup.html`, `dashboard.html`, `pricing.html`.

### Lint / Test / Build

- **No linter, test framework, or build system** exists in this repo.
- **No `package.json`** — nothing to install.
- Manual browser testing is the only verification method.

### Gotchas

- Supabase credentials are hardcoded in multiple files (anon key is public by design).
- `payment.html` and `overview.html` are referenced in `pricing.html` but do not exist in the repo — clicking "Deploy My Closer" will 404 after the Supabase checkout flow.
- The dashboard (`dashboard.html`) requires an authenticated Supabase session to display user data; without login it shows placeholder text ("Loading profile...", "No active conversations yet").
