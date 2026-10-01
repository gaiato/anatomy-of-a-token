# Contributing

The most useful contributions are **packs** and **reports from models the page has not met yet**.

- **Try it on your model.** If the scene or a step looks wrong for your architecture, open an issue with the output of `python3 -m anatomy_probe profile --config path/to/config.json --weights path/to/checkpoint` (it reads headers only and holds no paths or keys). That profile is usually enough to reproduce the problem.
- **Write a pack.** `docs/PACKS.md` explains model and hardware packs. Every note needs a source: a model card, a paper, a recipe README, or a measurement you can describe. Notes are shown with that tag, so "measured on my box" is welcome as long as it says so.
- **Share a snapshot.** `python3 -m anatomy_probe snapshot --engine URL --out web/data/NAME --prompt "…"` captures a demo others can open with `?demo&snapshot=NAME`. Use harmless prompts; snapshots keep the prompt and the reply.
- **Code.** The probe is standard-library Python 3.9+ and should stay that way. Run `python3 -m unittest discover -s probe/tests` before sending a change. The page is plain ES modules with no build step.

Keep the page usable without a mouse, with reduced motion, and at phone width; those were requirements from the start.
