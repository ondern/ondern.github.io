# Fonts

Google Sans (variable, weight 400-700), self-hosted as two WOFF2 subsets. A normal page load makes no request to Google or any CDN.

- `google-sans-latin.woff2`: Latin (English, German).
- `google-sans-latin-ext.woff2`: Latin Extended, which adds the Turkish letters; the browser downloads it only for pages that use them.

## Licence (verified from the primary source)

- SIL Open Font License 1.1, copyright 2025 The Google Sans Project Authors (https://github.com/googlefonts/googlesans).
- Verified in the Google Fonts repository: `ofl/googlesans/OFL.txt` and `METADATA.pb` (license "OFL", axes wght 400-700,
  designer Google). Source: https://github.com/google/fonts/tree/main/ofl/googlesans
- The licence text is in `OFL.txt` in this folder and must stay with the fonts.
- The OFL names no Reserved Font Name. "Google" and "Google Sans" remain trademarks of Google LLC (see TRADEMARKS.md in the
  repository above); this site is not affiliated with or endorsed by Google. Google Product Sans is a different font with different
  terms and is not used.
- Not verified: the Google Fonts FAQ page and the font-selection/embed page (https://fonts.google.com/selection/embed) render with
  JavaScript and could not be read in this environment, so the "available under the OFL since November 2025" statement was not
  confirmed from those pages; the licence files above are the evidence used.

## Where the files come from

The two WOFF2 files were downloaded once from the Google Fonts CDN (fonts.gstatic.com, Google Sans v76, weight axis 400-700,
subsets "latin" and "latin-ext"). They are used unmodified. The CDN is used only at download time, never when visitors load the site.

## Fallback stack

`"Google Sans", "Inter", "Source Sans 3", Arial, Helvetica, sans-serif`

Inter and Source Sans 3 are not bundled: if the Google Sans files fail to load, the files hosted next to them would fail as well, so
bundling a second family would only add weight. They are used only if already installed on the visitor's device; otherwise
Arial or Helvetica is used. Measured text width of Google Sans relative to Arial is 0.99-1.02 (en, de, tr; weights 400 and 700),
so the fallback keeps line breaks and page height nearly unchanged.

## Updating

Fetch the CSS from https://fonts.googleapis.com/css2?family=Google+Sans:wght@400..700 with a current browser user agent, download
the "latin" and "latin-ext" woff2 files it lists, and keep the `unicode-range` values in `css/styles.css` in sync.
