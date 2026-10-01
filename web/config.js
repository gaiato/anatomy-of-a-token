/* Deployment settings. The defaults suit the probe serving this folder itself (python3 -m anatomy_probe serve --web web).
 *   api       where the probe's /api/ is, relative to this page
 *   snapshot  saved profile + traces, used when no probe answers (demo mode)
 *   maxTokens reply length for a traced question (the probe caps it too)
 *   backLink  optional {href, label} button in the top bar
 *   repo      where "Run the probe" points in demo mode
 *   sky       the view from orbit behind the scene: { orbit: URL of live elements (CelesTrak OMM JSON) or null for the
 *             bundled ones, pitch: degrees the view tilts toward Earth, places: [{ name, points: [[lat, lon], …], km }]
 *             to mark passes over on the time slider }, or null for a plain dark background */
window.ANATOMY = {
  api: 'api/',
  snapshot: 'data/snapshot/',
  maxTokens: 32,
  repo: 'https://github.com/gaiato/anatomy-of-a-token#quick-start',
  sky: { orbit: 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json', pitch: 0 },
};
