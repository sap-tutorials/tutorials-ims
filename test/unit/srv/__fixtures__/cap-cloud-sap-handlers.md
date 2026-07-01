---
title: Event Handlers
synopsis: Register handlers on service events
---

# Event Handlers

CAP services fire events at every stage of request processing. Handlers let you
plug into that lifecycle to add validation, custom logic, projection, or side
effects.

## Before-Create

Fire before an entity is inserted into the persistence layer. Ideal for
validation and default-value assignment.

## On-Read

Fire when a `SELECT` is executed. Used to override the default persistence
handler with a custom projection.
