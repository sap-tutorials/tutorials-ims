---
title: Talking to Joule
description: Every way to interact with Joule as a learner — with example prompts for search, learning paths, knowledge-graph exploration, step help, code checking, and more.
---

# Talking to Joule

Joule is the in-page AI assistant that helps you make sense of tutorials and figure out what to learn next. If you're new to it, start with [Using Joule chat](using-joule-chat.md) for the basics. This page is the **catalogue of what to ask** — one entry per capability, each with example prompts you can copy and adapt.

## How to talk to Joule

There are no special commands or syntax — just type what you want in plain language. Joule reads where you are (which tutorial, which step) and picks the right thing to do behind the scenes.

A few tips:

- **Be specific about goals.** "How do I get to building a Fiori app?" gives Joule more to work with than "Fiori."
- **You don't need to paste context on a tutorial page.** Joule already knows the tutorial and step you're on.
- **Follow up.** Joule remembers the conversation — ask it to go deeper, simplify, or pivot.

Every example below is a starting point. Rephrase freely.

---

## Finding something to learn

### Search the tutorial catalogue

Ask Joule to find tutorials, missions, or groups by topic, level, or tag. Results are marked with your own status — new, in progress, or completed — so you can see what's fresh.

> *"Find a tutorial about CAP and HANA."*
>
> *"Show me beginner missions on ABAP."*
>
> *"Any tutorials on integrating with S/4HANA?"*

### Search smarter with related concepts

Instead of matching keywords, Joule can expand your query into **related concepts from the knowledge graph** and surface the most relevant tutorials — each with a short reason why it fits. This is a great first move when you're not sure of the exact term.

> *"What should I look at if I want to learn event-driven CAP?"*
>
> *"Find tutorials around RAP and clean core."*
>
> *"I want to get into AI on BTP — where do I start?"*

Joule shows you the concepts it connected to, so you learn the right vocabulary as you go.

---

## Knowledge-graph exploration

Behind the tutorials sits a **knowledge graph** — a map of how topics, tutorials, and concepts connect. These features let you explore that map instead of hunting page by page.

### Build a learning path toward a goal

Tell Joule where you want to end up and it builds an **ordered sequence** of tutorials to get you there, walking the shortest path through the graph. If you're signed in, it starts from what you last completed.

> *"Give me a learning path to build and deploy a CAP app on BTP."*
>
> *"What should I do next after finishing the CAP intro?"*
>
> *"Map out a route from where I am to writing OData services."*

### Explore a whole topic area

Ask about an **area or cluster** — not a single tutorial — and Joule describes it: what the cluster is about, why those tutorials belong together, and which ones are in it.

> *"What's in the AI area?"*
>
> *"Show me everything around integration."*
>
> *"What does the ABAP cluster cover?"*

### Find tutorials near the one you're on

From a tutorial you're reading, ask what else lives in the same tightly-connected topic cluster — the natural neighbours of what you're currently learning.

> *"What else is like this tutorial?"*
>
> *"What are the other tutorials in this area?"*
>
> *"If I liked this, what's next in the same theme?"*

### Discover related SAP content beyond tutorials

The graph also links out to the wider SAP world. Ask Joule to pull in related **learning journeys, blog posts, Discovery Center missions, videos, API docs, code samples, help pages, and community events** on a topic.

> *"Any blog posts or videos related to this topic?"*
>
> *"Is there a learning journey for this?"*
>
> *"Show me Discovery Center missions about HANA Cloud."*
>
> *"Find code samples for this."*

---

## While you're working through a tutorial

### Understand a step

If a step's instructions or output don't click, ask Joule to explain what's happening and why — in plain language. On a tutorial page it already knows which step you mean, so you don't have to paste anything. This is also what the **"Help with this step"** button does.

> *"Explain what this step is doing."*
>
> *"Why does this command fail?"*
>
> *"What does this output mean?"*
>
> *"Break this step down for me."*

### Check your code

Paste a code snippet and Joule can grade it against what the step is asking for, returning a pass, partial, or fail verdict with feedback. Name the tutorial and step so it knows the goal to check against.

> *"Check my code for step 3 of `create-a-cap-service`:"* (then paste your snippet)
>
> *"Is this solution correct for the current step?"* (then paste it)

### Get a recommendation at a branch

Some tutorials and missions branch — for example, a cloud path versus an on-premise path. When you hit one, ask Joule which path is recommended for you and why.

> *"Which path should I take here — cloud or on-prem?"*
>
> *"Which branch is right for me?"*

---

## Keeping track of yourself

### Check your progress

Ask Joule what you're in the middle of, or what you've finished. It reads your signed-in progress across tutorials, missions, and groups.

> *"What am I in the middle of?"*
>
> *"What have I completed so far?"*
>
> *"Where did I leave off?"*

### Know where you are on the page

On a tutorial, ask Joule to orient you — handy when you've stepped away and come back.

> *"What step am I on?"*
>
> *"What's next?"*

---

## Event assistant

On the **Devtoberfest** page, Joule answers from the official event information — dates, rules, points, the gameboard, activities, legal terms, videos, and live streams.

> *"When does Devtoberfest start?"*
>
> *"How do points work?"*
>
> *"What activities can I do?"*

---

## Opening Joule quickly

- **Floating button.** A chat button appears on every tutorial page — click it to open the side panel and keep reading while you ask.
- **Global header.** Reach the same Joule from the header on any non-tutorial page — same assistant, same history if you're signed in.
- **Command palette.** Press <kbd>⌘K</kbd> / <kbd>Ctrl</kbd>+<kbd>K</kbd> and choose **"Open Joule chat"** to open it from anywhere.
- **Suggested prompts.** When you open Joule, it offers a few starter prompts tailored to the page you're on — a quick way to see what's useful to ask here.

## What Joule is not

Joule only knows the SAP tutorial corpus and a small set of related SAP documentation. Ask it about your travel plans, a generic coding puzzle, or the news and it will tell you it can't help and steer you back to learning topics.

Don't paste private data, customer data, or credentials into the chat. Treat it like any other assisted tool. Your chat history is your own — see [Using Joule chat](using-joule-chat.md#privacy) for details.

## Related

- [Using Joule chat](using-joule-chat.md) — the plain-language overview and privacy details.
- [MCP quickstart](mcp-quickstart.md) — connect the tutorial corpus to your own AI tools.
