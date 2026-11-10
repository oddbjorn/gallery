# Gallery site

This repository contains only the generated, deployable gallery. It is created
by the project repository; it contains no source photographs or build tooling.

- `site/` — the published static site.
- `.github/workflows/pages.yml` — GitHub Pages deployment of `site/`.
- `statichost.yml` — optional statichost.eu configuration (`public: site`).

Update by rebuilding the project and committing the changed `site/`.
