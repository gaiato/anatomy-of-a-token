/* The hosted demo (GitHub Pages): no probe, so the page always shows the saved snapshot.
 * The orbit comes from data/sky/iss.json, refreshed daily by .github/workflows/pages.yml, so visitors'
 * browsers make no outside requests. See web/config.js for every setting. */
window.ANATOMY = {
  api: null,
  snapshot: 'data/snapshot/',
  maxTokens: 32,
  repo: 'https://github.com/gaiato/anatomy-of-a-token#2-see-your-own-model-live',
  sky: { orbit: null, pitch: 0 },
};
