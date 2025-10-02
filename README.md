# EmNet static site (dark theme)

A lightweight static site for EmNet Community Management Limited. Every page shares the same neon-accented dark theme and uses `styles/main.css` for layout, typography, and components.

## Directory structure
- `index.html` – marketing homepage with hero, service overview, practical examples, testimonials, and multiple calls-to-action that anchor back to the contact section.
- `about.html` – standalone founder story with an illustrated hero banner and long-form copy.
- `services.html` – detailed breakdown of service tiers, pricing, AIS framework highlight, and add-on offerings.
- `how-we-work.html` – explains the AIS (Audit → Implement → Sustain) workflow and the individual services list.
- `assets/`
  - Brand files (`logo.png`, `favicon.png`, `og-image.png`).
  - Section dividers, banner imagery, social icons, and signature graphics used across pages.
  - `site.js` – handles responsive navigation toggling and keeps the copyright year current.
- `styles/main.css` – shared CSS for all pages.

## Updating copy or visuals
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
- Navigation, footer, and CTA buttons are consistent across every page and pull styles from the shared CSS.
- `assets/site.js` initialises the mobile navigation toggle and updates the footer year automatically.
