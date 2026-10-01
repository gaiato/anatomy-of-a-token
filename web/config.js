/* Deployment settings. The defaults suit the probe serving this folder itself (python3 -m anatomy_probe serve --web web).
 *   api       where the probe's /api/ is, relative to this page
 *   snapshot  saved profile + traces, used when no probe answers (demo mode)
 *   maxTokens reply length for a traced question (the probe caps it too)
 *   backLink  optional {href, label} button in the top bar
 *   repo      where "Run the probe" points in demo mode */
window.ANATOMY = {
  api: 'api/',
  snapshot: 'data/snapshot/',
  maxTokens: 32,
  repo: 'https://github.com/gaiato/anatomy-of-a-token#quick-start',
};
