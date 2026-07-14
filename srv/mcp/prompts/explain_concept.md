---
name: explain_concept
description: Explain a knowledge-graph concept and how it connects to tutorials that teach it.
arguments:
  - { name: concept_id, description: Concept id or slug, required: true }
---
Read the concept://{{concept_id}} resource. Explain the concept in two paragraphs: first what it
is, then why it matters for an SAP developer. End with a bulleted list of the tutorials that teach it.
