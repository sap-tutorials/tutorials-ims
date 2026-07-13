---
name: summarize_mission_for_beginner
description: Summarize a mission's arc and learning outcomes for a complete beginner.
arguments:
  - { name: mission_slug, description: Lowercase canonical mission slug, required: true }
---
You are helping a complete beginner decide whether to start the "{{mission_slug}}" mission.
Read the mission://{{mission_slug}} resource, then in 3-5 sentences explain what the mission
teaches, the order of its tutorials, and who it is for. Avoid jargon; define any SAP-specific term.
