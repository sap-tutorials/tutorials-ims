---
title: "_shell"
type: "_shell"
layout: "single"
# Excluded from sitemap.xml via private (the project's custom
# hugo/layouts/_default/sitemap.xml filters on .Params.private — Hugo's
# standard `sitemap.disable` is NOT honored by that template).
# robotsNoIndex emits <meta name="robots" content="noindex, nofollow">
# so a curious crawler that hits /_shell/ doesn't index this stub.
private: true
robotsNoIndex: true
outputs: ["HTML"]
url: "/_shell/"
---
