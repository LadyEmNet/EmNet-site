# EmNet static site (dark theme)

Free, GitHub Pages–hosted static website with a black base, grey sections, and neon pink accents to match your EmNet logo.

## Project structure
- `public/index.html` – page markup.
- `public/styles/main.css` – styling.
- `public/assets/` – favicon, logo, and other static files.

## Replace assets
1. Put your logo file at `public/assets/logo.png` (PNG or SVG works).
2. Update the favicon at `public/assets/favicon.png`.

## Publish on GitHub Pages
1. Create a public GitHub repo (e.g. `emnet-site`).
2. Upload these files to the `main` branch.
3. Settings → Pages → Build and deployment → Source → **GitHub Actions**. Accept the suggested workflow, then edit the `upload-pages-artifact` step so that `path: public`.
4. Commit the workflow file. On the next push your site will appear at `https://<username>.github.io/emnet-site/`.

## Custom domain
1. Create a `CNAME` file in the repo root containing just your domain, e.g.:
   ```
   emnet.example
   ```
2. In Squarespace DNS:
   - `www` CNAME → `<username>.github.io.`
   - A records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
3. Enable HTTPS in GitHub Pages once the certificate is ready.

## Notes
- Edit copy in `public/index.html`. Styling is in `public/styles/main.css`.
- Buttons and links use neon pink (#ff2ebd). Adjust if you prefer a different accent.
