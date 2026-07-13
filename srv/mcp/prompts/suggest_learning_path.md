---
name: suggest_learning_path
description: Suggest an ordered learning path between two tutorials using the knowledge graph.
arguments:
  - { name: from_slug, description: Starting tutorial slug, required: true }
  - { name: to_slug, description: Target tutorial slug, required: true }
---
The learner knows "{{from_slug}}" and wants to reach "{{to_slug}}". Use the kg_neighborhood tool on
each and the kg_shared_concepts tool to propose an ordered path of tutorials, explaining why each
step is a prerequisite for the next.
