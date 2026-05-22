---
title: "Test Tutorial"
type: tutorials
description: "A test tutorial for verifying the Hugo layout"
slug: "test-tutorial"
private: true
stepCount: 2
time: 15
experienceLevel: "Beginner"
primaryTag: "Tutorial"
author: "Thomas Jung"
authorProfile: "https://github.com/thomasjung-sap"
createdAt: 2026-04-15
lastUpdated: 2026-05-20
contributors:
  - login: "thomasjung-sap"
    name: "Thomas Jung"
  - login: "qmacro"
    name: "DJ Adams"
  - login: "vobu"
    name: "Volker Buzek"
updated: 2026-05-20
notice: "Pilot tutorial — used for UI testing only."
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

A flowchart showing build flow:

{{< mermaid >}}
graph TD
    A[GitHub markdown] --> B[fetch-tutorials]
    B --> C[Hugo content]
    C --> D[publish-content]
    D --> E[(HANA BLOB)]
{{< /mermaid >}}

A sequence diagram showing the auth flow:

{{< mermaid >}}
sequenceDiagram
    participant U as User
    participant AR as AppRouter
    participant CAP as CAP Service
    U->>AR: GET /tutorials/foo
    AR->>CAP: /content/tutorials/foo
    CAP-->>AR: HTML (gzipped BLOB)
    AR-->>U: 200 OK
{{< /mermaid >}}

{{% option-tabs tabs="Option A,Option B" %}}

{{% tab index="0" name="Option A" %}}

Content for Option A.

{{% /tab %}}

{{% tab index="1" name="Option B" %}}

Content for Option B.

{{% /tab %}}

{{% /option-tabs %}}

{{% /tutorial-step %}}
