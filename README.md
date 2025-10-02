# EmNet static site

A lightweight static site for EmNet Community Management Limited. Each page shares a neon-accented dark theme defined in `styles/main.css` and enhanced by unobtrusive JavaScript in `assets/site.js`.

## Directory structure
- `index.html` – marketing homepage with hero, service overview, practical examples, and multiple calls-to-action that anchor back to the contact section.
- `about.html` – standalone founder story with an illustrated hero banner and long-form copy.
- `services.html` – detailed breakdown of service tiers, pricing considerations, and AIS framework highlights.
- `how-we-work.html` – explains the AIS (Audit → Implement → Sustain) workflow and the component services list.
- `privacy.html` – privacy policy and cookie notice.
- `assets/`
  - Brand files (`logo.png`, `favicon.png`, `og-image.png`).
  - Section dividers, banner imagery, social icons, and signature graphics used across pages.
  - `site.js` – initialises responsive navigation, handles the cookie banner, intersection observer animations, and keeps the copyright year current.
- `styles/main.css` – shared CSS for layout, typography, responsive behaviour, and animation states.
- `.github/workflows/ci.yml` – GitHub Actions workflow that lint-checks HTML/CSS/JS, runs the link checker, and executes a Lighthouse smoke test.

## Getting started
1. Install Node.js 20 or newer.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Serve the site locally (any static server works). For example:
   ```bash
   npx http-server .
   ```
   Then open [http://localhost:8080](http://localhost:8080) in your browser.

## Quality checks
All automated checks can be run locally:

```bash
npm run lint         # HTMLHint, Stylelint, ESLint
npm run check:links  # Internal and external link checking
npm run lhci:ci      # Lighthouse smoke test using lighthouserc.json
```

The `ci` script (`npm run ci`) runs the full suite and mirrors the GitHub Actions workflow.

## Security and hardening
- Pages declare a restrictive Content Security Policy via `<meta http-equiv>` that allows only same-origin assets plus hashed structured-data scripts.
- Inline JavaScript has been removed in favour of the deferred bundle in `assets/site.js`.
- `.well-known/security.txt` advertises the security contact address; see [SECURITY.md](SECURITY.md) for the responsible disclosure process.
- `robots.txt` and `sitemap.xml` simplify search crawler behaviour.

Full audit notes, outstanding risks, and recommended follow-up actions live in [`docs/audit-2025-10-02.md`](docs/audit-2025-10-02.md).

## Deployment notes
The site is designed for GitHub Pages with a custom domain (see the existing `CNAME`). When hosting on GitHub Pages, HTTP response headers such as HSTS and Permissions-Policy cannot be set. If you require additional headers, place the site behind a CDN or proxy (e.g. Cloudflare, Fastly) and configure them there.

To publish with GitHub Pages:
1. Push the repository to GitHub.
2. Ensure Pages is configured to deploy from GitHub Actions.
3. Keep the provided `.github/workflows/ci.yml`; it runs on every push and pull request to guard build quality before deployment.

## Updating copy or visuals
1. Replace the logo at `assets/logo.png` (PNG or SVG).
2. Update the favicon at `assets/favicon.png`.
3. Swap the social preview image at `assets/og-image.png` if you have a different share card.
4. Edit page copy directly in the relevant HTML file. Each page includes SEO, Open Graph, and Twitter card metadata that can be adjusted as required.

## Algoland data backend
The `/algoland` dashboard now reads badge completion and entrant counts from a dedicated backend service in [`backend/`](backend/). Deploy this Express app to Render (or another Node-compatible host), configure the `INDEXER_BASE` and `ALLOWED_ORIGINS` environment variables, and point the page at the service by updating the `data-api-base` attribute on `<main data-algoland-root>`.
