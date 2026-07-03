# test/load — k6 load-test suite

Quick start. Full docs: [docs/developers/operations/load-testing.md](../../docs/developers/operations/load-testing.md).

## Install k6

```
winget install k6.k6         # Windows
brew install k6              # macOS
```

Or use the pinned Docker image directly:

```
docker run --rm -i grafana/k6:0.51.0 run - < test/load/scenarios/01-smoke.js
```

## Run

```
npm run loadtest:smoke       # 30 s sanity check
npm run loadtest:baseline    # 2 min steady load
npm run loadtest:ramp        # 15 min — regressions only
npm run loadtest:tutorials   # HANA/LRU path, LOAD_MODE=hot|cold
npm run loadtest:ws          # Socket.IO handshake churn
```

Target another env with `LOAD_BASE_URL`. See `config.js` for all `LOAD_*` env vars.

## Do not

- Run in a `pre-commit` hook. Load runs take minutes.
- Run against PROD. Spec pins DEV-only for v1.
- Hardcode thresholds in scenario files. Thresholds live in `config.js`.
- Add a "run everything" script. Scenarios are intentionally separate.
