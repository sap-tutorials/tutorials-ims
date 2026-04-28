---
title: "Test Tutorial"
type: tutorials
description: "A test tutorial for verifying the Hugo layout"
slug: "test-tutorial"
stepCount: 2
time: 15
experienceLevel: "Beginner"
primaryTag: "Tutorial"
youWillLearn:
  - "How Hugo layouts work"
  - "How shortcodes render"
steps:
  - number: 1
    title: "First Step"
  - number: 2
    title: "Second Step"
---

{{% tutorial-step number="1" title="First Step" %}}

This is the first step content with **bold** and `code`.

{{% /tutorial-step %}}

{{% tutorial-step number="2" title="Second Step" %}}

This is the second step.

{{% option-tabs tabs="Option A,Option B" %}}

{{% tab index="0" name="Option A" %}}

Content for Option A.

{{% /tab %}}

{{% tab index="1" name="Option B" %}}

Content for Option B.

{{% /tab %}}

{{% /option-tabs %}}

{{% /tutorial-step %}}
