# Security Policy

We take the safety of visitors and clients seriously. Please use the contact paths below to report vulnerabilities or data protection concerns.

## Reporting a vulnerability

- Email: [Emnet@emnetcm.com](mailto:Emnet@emnetcm.com)
- Preferred languages: English (en-GB)
- Optional encrypted channel: request a PGP key via email if you need to share sensitive details.

We aim to acknowledge new reports within **3 working days** and to provide a resolution plan within **10 working days**. If you have not received an acknowledgement in that timeframe, please resend your message and include "SECURITY" in the subject line.

## Scope

The following properties are in scope:

- https://www.emnetcm.com/
- https://www.emnetcm.com/*.html
- All static assets under https://www.emnetcm.com/assets/

Third-party platforms (e.g. Telegram, X) and custom bots are out of scope for this policy. Please contact their respective owners directly.

## Hardening summary

Recent changes include:

- Content Security Policy meta tags that only allow first-party assets and hashed structured data.
- Automatic removal of inline scripts in favour of deferred bundles.
- Automated linting, link checks, and Lighthouse smoke tests via GitHub Actions.

Future improvements, such as HTTP response headers (HSTS, Permissions-Policy), require CDN or origin configuration. See `docs/audit-2025-10-02.md` for details.
