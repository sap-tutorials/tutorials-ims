# Mascot Assets

## kasimir-tuxedo.png

**PLACEHOLDER** — This is a minimal 1x1 transparent PNG created as a build-safe placeholder.

Replace with the real tuxedo-Kasimir mascot image (issue #2865).

The app references this asset at `/drawings-ui/kasimir-tuxedo.png`.

## Post-deploy smoke check

The post-deploy `e2e` job should hit `/drawings-ui/` to verify the app loads; it is an XSUAA-protected operator screen so full interaction requires auth.

