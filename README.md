# EmNet static site (dark theme)

A lightweight, single-folder site for EmNet Community Management Limited. All pages share a dark palette with neon pink accents that match the EmNet logo.

## Pages & assets
- `index.html` – homepage with hero, services overview, and contact call-to-action.
- `about.html` – background on EmNet's approach to operational community growth.
- `how-we-work.html` – breakdown of the audit, implement, sustain process with a next-step CTA.
- `styles/main.css` – shared styling for layout, typography, and components.
- `assets/` – logos, favicons, and the `og-image.png` used for social cards.

## Update copy or visuals
1. Replace the logo at `assets/logo.png` (PNG or SVG).
2. Update the favicon at `assets/favicon.png`.
3. Swap the social preview image at `assets/og-image.png` if you have a different share card.
4. Edit page copy directly in the relevant HTML file. Each page already includes SEO, Open Graph, and Twitter card metadata.

## Publish on GitHub Pages
1. Create a public GitHub repository (for example, `emnet-site`).
2. Upload all files from this directory to the `main` branch.
3. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. Accept the suggested workflow.
4. In the generated workflow file, set `upload-pages-artifact` → `path: .` so the action publishes the repository root.
5. Commit the workflow file. The next push will deploy the site at `https://<username>.github.io/<repository>/`.

## Custom domain (optional)
1. Add a `CNAME` file in the repo root containing your domain, for example:
   ```
   emnet.example
   ```
2. In your DNS provider, create records:
   - `www` CNAME → `<username>.github.io.`
   - A records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
3. Once DNS has propagated, enable HTTPS in GitHub Pages settings.

## Notes
- Buttons and links use neon pink (`#ff2ebd`). Adjust `styles/main.css` if you want a different accent colour.
- All pages share a footer script that keeps the copyright year current.
