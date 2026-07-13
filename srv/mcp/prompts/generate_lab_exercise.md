---
name: generate_lab_exercise
description: Generate a hands-on lab exercise derived from a tutorial (optionally a single step).
arguments:
  - { name: tutorial_slug, description: Lowercase canonical tutorial slug, required: true }
  - { name: step, description: Optional 1-indexed step number to focus on, required: false }
---
Using the tutorial://{{tutorial_slug}} resource{{step}}, design one hands-on lab exercise that
reinforces the key skill. Include: a short scenario, the task, the expected outcome, and a hint.
Keep it doable in under 20 minutes.
