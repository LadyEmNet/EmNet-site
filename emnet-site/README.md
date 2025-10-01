# EmNet static site (dark theme)

Free, GitHub Pages–hosted static website with black base, grey sections, and neon pink accents to match your EmNet logo.

## Replace assets
1. Put your logo file at `assets/logo.png` (PNG or SVG works).
2. Update the favicon at `assets/favicon.png`.

## Publish on GitHub Pages
1. Create a public GitHub repo (e.g. `emnet-site`).
2. Upload these files to the `main` branch.
3. Settings → Pages → Deploy from branch → `main` / `/root`.
4. Your site will appear at `https://<username>.github.io/emnet-site/`.

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
- Edit copy in `index.html`. Styling is in `styles.css`.
- Buttons and links use neon pink (#ff2ebd). Adjust if you prefer a different accent.
