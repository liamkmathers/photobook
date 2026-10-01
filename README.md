# Photobook

Local, offline print layout tool for photos: 8-page fold zines plus free-form sheet layouts.

Open `index.html` in a browser (double-click works, no server needed).

- **Layouts:** 8-page fold zine, full page, split vertically/horizontally, quadrants, 2×3, 3×3, or any rows × columns. Uneven sizes via ratios (`2,1` = left column twice as wide).
- **Per cell:** photo, fill/fit, zoom, position, rotation, padding, background, text (captions or sign text).
- **Sheets:** as many as you like, each with its own layout; all export into one PDF.
- **Quality:** JPEGs go into the PDF byte-for-byte (never recompressed), PNGs stay lossless. Other formats (WebP, HEIC…) are converted once to lossless PNG. Cropping is done with PDF clipping, so originals stay intact. Each cell shows its effective print dpi.
- **Save project** writes a `.json` including the original photos, so you can reopen and keep editing.

Print the PDF at 100% / "Actual size", not "Fit to page", especially for zines.

Files: `core.js` (geometry + PDF), `app.js` (UI), `vendor/pdf-lib.min.js`.

Fonts: Archivo Black, Barlow Condensed, Coda, Courier Prime, Cutive, Jost, Oswald, Playfair Display, Press Start 2P, Special Elite and Syncopate are Google Fonts under the SIL Open Font License. The TTFs live in `vendor/fonts/` and are bundled into `vendor/fonts.js` (rebuild that file if you add fonts) so they work offline from `file://` and embed into the PDF.
