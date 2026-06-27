# Competitor Research — `developers.sap.com/` Homepage Redesign

**Date:** 2026-06-27
**Issue:** [#639](https://github.com/sap-tutorials/tutorials-ims/issues/639)
**Phase:** Brainstorming — input material, not a recommendation

Comparison of 10 developer landing pages to inform the redesign. Two fetches partially failed and are noted in their sections.

---

## 1. developer.microsoft.com

**Above-the-fold composition.** Full-width hero carousel pinned to Microsoft Build 2026; primary headline is the eyebrow word **"MICROSOFT BUILD"** above the line **"Revisit the keynote and select sessions from Build 2026."** The carousel rotates through ~5 featured announcements each with image + headline + "Read more" link. No search box, no product chooser, no persona selector above the fold — only the horizontal top nav.

**Primary IA spine.** Eight stacked sections below the fold, each a carousel or tile grid: Featured Products (4 product carousels), News & Updates (3 articles), Languages (6 tiles), Communities (8 cards), Hubs (3 cards + a developer story), Blogs (1 featured + 3 recent), Events (5-item carousel), Learn (3 tracks × ~10 modules). Depth is mostly 2 levels — section → linked destination.

**Persona / lane treatment.** Implicit, via the Learn section's three named tracks: **AI**, **DevOps**, **Security**. No explicit persona chooser; segmentation lives in section labels.

**Tone & density.** Marketing-forward with a moderate code-zero hero. Quote: *"Build any type of application. Work together in real time."* Subtle social proof via named developer quotes (e.g. Thiago Lacopini, Kumulus). Image-heavy hero, text-and-tile body.

**Does well.** Carousels are restrained — one per topic, not stacked carousels-of-carousels. The Hubs section as a separate IA layer (somewhere between a product and a track) is a useful third concept beyond "product" and "topic."

**Does badly / avoid.** Hero is 100% event-promotion; a returning developer learns nothing about Microsoft's platform from the first scroll. The conference takeover crowds out the IA. Eight stacked carousels also feels infinite-scroll-y rather than navigable.

**Visual signature.** Cool blue/gray, sans-serif, card-contained sections on light backgrounds, carousel motion as the dominant interaction — a clean, corporate, mid-density feel.

---

## 2. cloud.google.com/developers

**Fetch note.** Page content was truncated on both fetch attempts; I cannot quote hero copy verbatim. What is observable: the page is the "Developer Center | Google Cloud" hub and uses Google Cloud's standard chrome.

**What is inferable from Google Cloud's design system (use cautiously).** Above-the-fold typically: top utility bar, primary nav, hero with a single bold sentence + dual CTA (Start free / Contact sales), no inline search, no persona selector. Below the fold the standard GCP pattern is product-family card grids (Compute, Data, AI/ML, etc.) plus a "What's new" strip and a customer-logo wall. Persona treatment on GCP properties is almost always implicit via product category, not explicit chooser.

**Tone & density.** Marketing-heavy; GCP landing pages reliably feature customer logos, gradient hero photography, and enterprise CTAs.

**Does well (inferred).** Strong product taxonomy — users who know GCP can find a service in two clicks.

**Does badly / avoid (inferred).** Enterprise-sales overlay (Contact sales, customer logos) tends to dominate; the "developer" framing is weaker than at `developers.google.com`. This is a marketing surface dressed as a developer hub.

**Visual signature.** Google Sans, multi-color accent palette (the four Google colors), generous whitespace, soft gradients, restrained motion — clean but corporate.

---

## 3. developers.google.com

**Above-the-fold composition.** Top nav, then hero with a value-prop sentence: *"Unlock AI models to build innovative apps and transform development workflows with tools across platforms."* Immediately below: a 6-tile product card grid (Google AI Studio, Antigravity, Google Cloud, Android Developers, Gemini API, Chrome for Developers, Gemini Enterprise Agent Platform). Then a Gemini API section with **inline code samples in 5 language tabs** (Python, JS, Go, Java, REST) — code is present on the landing page, above the second fold.

**Primary IA spine.** Three horizontal sections: News & Announcements (7 thumbnail items), Community & Events (3 cards), Google Developer Program promo block. Footer has 3 columns (Engage / Connect / Build) of 15+ links + a language selector. Mostly 1 level deep — cards link straight out.

**Persona / lane treatment.** No persona segmentation. Audience unified; segmentation is by **product/platform** (Android vs. Cloud vs. Chrome vs. Gemini), not by role or skill.

**Tone & density.** Marketing with technical signaling. Quote: *"Unleash the full potential"* / *"Discover how your web applications can perform AI tasks."* Image-light, logo/icon-driven. Code on the landing is the most reference-y signal.

**Does well.** **Code-tabs on the landing page** — answers "what does this feel like to use" without a click. Six-tile platform chooser is a clean way to fork into product universes.

**Does badly / avoid.** No deeper IA — everything is "click out to a product site," so the hub feels like a directory page with marketing chrome rather than a destination.

**Visual signature.** Google's 4-color brand palette on white, Google Sans, flat icons, generous whitespace — engineering-forward but unmistakably Google-marketing.

---

## 4. developer.hashicorp.com

**Above-the-fold composition.** Live-event ribbon (HashiConf 2025), then hero with the tagline *"Step inside. Define your path."* Below the tagline: a **9-tile product grid** (HCP, Packer, Terraform, Consul, Boundary, Vault, Nomad, Waypoint, Vagrant). Then a "Search with ease" block showing 4 sample search result cards (not a working search bar — exploratory examples). No persona chooser, no code samples above the fold.

**Primary IA spine.** Below the product grid: certification card, HCP onboarding card, Well-Architected Framework card, support/resources footer. Top nav has 2 levels: Products bifurcates into Infrastructure Lifecycle Management vs. Security Lifecycle Management; Learn splits into Certifications / Tutorials / Patterns / Framework.

**Persona / lane treatment.** Implicit via product *category* (infra vs. security), not via user role. No explicit chooser.

**Tone & density.** Marketing-forward with reference signaling. Quotes: *"Define your path"*, *"Field-tested patterns"*, *"Get started in minutes."* No code on landing.

**Does well.** **Product grid as the spine** — 9 tiles is the IA, the hero is decoration. A SAP analog ("here are our 9 platforms") would be honest and scannable. Also: the Learn nav's named buckets (Certifications / Tutorials / Patterns / Framework) is a clean four-way carve of learning content.

**Does badly / avoid.** "Search with ease" with mock results instead of a real search box is a UX tease. Hero tagline is empty calories — *"Define your path"* doesn't tell anyone what HashiCorp does.

**Visual signature.** High whitespace, restrained typography, icon-only product tiles, neutral palette with one purple accent — professional-enterprise, slightly cold.

---

## 5. learn.microsoft.com

**Above-the-fold composition.** IE deprecation banner, then hero headline **"Build with answers in reach"** with subline *"Dive into official documentation, practical answers, and expert guidance for working and troubleshooting with Microsoft."* **A prominent centered search bar** sits directly under the hero — the single most important above-the-fold action. Below: a 3-column intro card section labeled "Popular technical resources and training."

**Primary IA spine.** Three parallel card tracks, each one level deep: "Discover AI, Azure, and Copilot essentials" (4 product cards) / "Take in-demand training" (4 training items) / "Additional resources" (4 text links). Then a Microsoft Learn MCP Server promo block. Footer is standard.

**Persona / lane treatment.** No explicit persona chooser. Implicit student call-out ("Get student certifications") and implicit developer/IT-pro/business-decision-maker via the cards.

**Tone & density.** Career-outcomes framing — *"Advance your technical career"*, *"Stand out to hiring managers."* No code samples. Image-light — 9 small SVG icons + text. Reference-marketing hybrid leaning marketing.

**Does well.** **Search-first hero** — for a learning portal where users arrive with intent ("how do I deploy a function app"), centering the search box is the right altitude. Three parallel tracks instead of a sequential scroll respects user choice.

**Does badly / avoid.** Career-outcomes copy ("Stand out to hiring managers") feels like a bootcamp pitch — fine for upskilling, wrong for a developer reference hub.

**Visual signature.** Azure blue-teal, high whitespace around card groups, icon+text card pairs, no animation — modular, calm, Microsoft-2026-clean.

---

## 6. developer.salesforce.com

**Above-the-fold composition.** Stacked promotional cards, NOT a hero: (1) "Take the Agentforce Vibes Quest" with CTA, (2) "Unlock the power of Enterprise Vibe Coding" linking out to YouTube, (3) "Attend an Agentforce NOW event," (4) "Introducing Agent Script Recipes — 20+ practical examples." No search bar, no product chooser, no persona selector. Hero copy: *"Pick a prompt, get vibing, and show off your vibe coding skills"* and *"learn how to build enterprise-grade apps and agents using natural language."*

**Primary IA spine.** Below the promo stack: "Explore developer centers" (each center exposes Overview / Guides / Reference triplet), "Browse all APIs" heading, newsletter signup module. Depth ~2–3 levels.

**Persona / lane treatment.** No explicit segmentation. Lanes are implicit by *campaign* (quest-takers, video viewers, event attendees, recipe explorers) — each with its own CTA.

**Tone & density.** Heavy marketing. Tonal collision between casual ("get vibing") and enterprise ("enterprise-grade agents"). No code on landing. Astrobot mascot imagery dominates.

**Does well.** The **"Overview / Guides / Reference" triplet per developer-center** is a clean repeated micro-IA — once you know the pattern, you can navigate any center the same way.

**Does badly / avoid (enterprise-y tells).**
- **Campaign stacking instead of an IA.** The first scroll is four marketing CTAs in a row — a returning developer cannot find docs.
- **Newsletter signup gating.** "Sign up now" capture form on the hub itself screams marketing funnel.
- **Contest-as-hook.** *"chance to score a TDX 2026 pass"* is conference-marketing, not developer hospitality.
- **Mascot + slang ("vibing") fighting with "enterprise-grade"** — neither audience is served.
- **No search, no code, no version info** above the fold.

**Visual signature.** Modular cards, blue Salesforce palette, mascot illustration, conversion-button styling — campaign-page aesthetic, not a developer hub.

---

## 7. docs.anthropic.com → platform.claude.com/docs/en/intro

**Fetch note.** `docs.anthropic.com` 301-redirects to `platform.claude.com/docs/`; the homepage there 404'd, but the canonical intro page at `/docs/en/intro` is reachable and is the de-facto docs landing.

**Above-the-fold composition.** Title **"Intro to Claude"** then one-sentence definition: *"Claude is a highly performant, trustworthy, and intelligent AI platform built by Anthropic."* Immediately a **Tip callout** listing the current model family (Fable 5, Mythos 5, Opus 4.8, Sonnet 4.6, Haiku 4.5) with announcement links. A left sidebar nav and a top-bar search are persistent (typical Mintlify chrome). No hero image, no code in the very first viewport — model picker is the hero.

**Primary IA spine.** Two-column doc shell. A **two-row comparison table** (Messages API vs. Claude Managed Agents) is the first content block — explicit "pick a build path." Then a numbered **Steps** component ("Make your first API call → Understand the Messages API → Choose the right model → Explore features"). Then **CardGroup** sections for Developer Console / API Reference / Cookbook, and Text-and-code / Vision, and Help / Status.

**Persona / lane treatment.** Build-path chooser (Messages API vs. Managed Agents) is the segmentation — by **technical pattern**, not by role.

**Tone & density.** Reference-first, near-zero marketing. Quotes: *"Recommended path for new developers"*, *"Follow these steps to go from zero to a working Claude integration."* Text-dense, no imagery, no social proof, no testimonials. The "marketing" is the model-list callout.

**Does well.** **Numbered Steps component as the spine** for new-developer onboarding — turns a docs landing into a guided journey without losing reference density. **Comparison-table-as-decision-aid** in the first scroll is honest and useful. Persistent search + sidebar means navigation is never more than one keystroke away.

**Does badly / avoid.** Heavy reliance on Mintlify components means visual signature is generic to anyone who's seen another Mintlify site. The model-callout-as-hero is invisible to first-time visitors who don't know the model names.

**Visual signature.** White background, single accent color, monospace for code, serif-free typography, near-zero motion, sidebar-dominant chrome — austere reference aesthetic.

---

## 8. anthropic.com

**Above-the-fold composition.** Hero headline: **"AI research and products that put safety at the frontier."** Mission supporting line. Featured content block: **"What 81,000 people want from AI"** (research piece as the hook, not a product CTA). No search, no product chooser, no persona selector, no code.

**Primary IA spine.** Stacked sections: Latest releases (3 dated announcements) → value section *"At Anthropic, we build AI to serve humanity's long-term well-being"* clustering 5 initiative cards (Core Views, RSP, Academy, Economic Index, Constitution) → 8-column footer (Products / Models / Solutions / Claude Platform / Resources / Help+Security / Company / Terms).

**Persona / lane treatment.** No on-page persona segmentation. The audience fork lives in the top nav: **"Try Claude"** (consumer) vs. **"Developer docs"** under Learn (developer). The footer's "Claude Platform" column reinforces the developer route.

**Tone & density.** Editorial-marketing. Quotes: *"put safety at the frontier"*, *"serve humanity's long-term well-being."* Mission-and-research-driven, not feature-driven. Image-light, text-medium.

**Marketing → developer seam.** Explicit and labeled: a "Developer docs" link under Learn, mirrored in the footer "Claude Platform" column with a direct doc link plus API pricing. The two surfaces are distinct (anthropic.com is mission, platform.claude.com/docs is reference) — the seam is a labeled door rather than a blended hand-off.

**Does well.** **Research-as-hero** instead of product-as-hero — feels like a publication, not a sales page. The labeled doors to consumer vs. developer surfaces are honest.

**Does badly / avoid.** A first-time developer arriving here has to know to look for "Developer docs" — there is no developer-facing affordance above the fold.

**Visual signature.** Cream/off-white background, large serif headlines (Anthropic's signature is a serif display face), generous whitespace, very low motion — a publication or institute aesthetic, not a SaaS one.

---

## 9. platform.openai.com/docs → developers.openai.com/api/docs/overview

**Fetch note.** `platform.openai.com/docs` 301-redirects to `developers.openai.com/api/docs/overview`; that page fetched cleanly.

**Above-the-fold composition.** OpenAI Developers wordmark, then **"API Platform"** with subhead **"Developer quickstart"** and the line *"Make your first API request in minutes. Learn the basics of the OpenAI platform."* Two CTAs: **Get started** and **Create API key**. Then a **language switcher** (curl / JS / Python / C# / Java / Go / Ruby / CLI) and a live code sample showing a Responses-API call. Code is in the very first viewport.

**Primary IA spine.** "Build Paths" section with two cards (Responses API vs. Agents SDK), then a Models carousel (GPT-5.5, GPT-5.4, GPT-5.4 mini + "View all"), then a "Start Building" 8-card capability grid (text / vision / images / audio / agents / reasoning / structured output / optimization), then Support row (Help / Forum / Cookbook / Status), then an interactive **Docs Agent** footer component. Top-nav → section → guide is 3 levels.

**Persona / lane treatment.** Two simultaneous segmentations: **by language** (7 SDKs + CLI tabs on the code block) and **by build path** (Responses API vs. Agents SDK). No named human personas; lanes are technical patterns.

**Tone & density.** Reference + marketing balance. Quotes: *"Make your first API request in minutes"* (action), *"A new class of intelligence"* (aspirational). ~60/40 text-to-code. Minimal social proof above the fold.

**Does well.** **"Create API key" as a primary CTA on the docs landing** — the docs are also the activation surface; no hunt for a console. **Live, language-switchable code in the hero** sets the floor for what "developer-first" means. **Docs Agent** footer (an interactive chat over the docs themselves) is a third channel beyond search and nav.

**Does badly / avoid.** Two simultaneous segmentations (language tabs and build-path cards) can confuse newcomers who haven't yet picked either axis. Capability grid (8 cards) and Build Paths (2 cards) overlap conceptually.

**Visual signature.** Black-and-white with monochrome accents, monospace code on light backgrounds, sans-serif body, generous whitespace, near-zero motion — a deliberate "terminal-meets-publication" aesthetic.

---

## 10. openai.com/developers/

**Fetch note.** Both `openai.com/developers/` and the fallback `openai.com/api/` returned HTTP 403 (likely Cloudflare bot challenge). I could not fetch this surface. Adjacent surface (`developers.openai.com`, section 9) is the live developer destination this URL would link to, and `openai.com` itself is the marketing seam analog to anthropic.com (section 8) — those two together cover what this URL's role would be in OpenAI's architecture (marketing-side door to the developer surface). No verbatim hero quote available.

---

## Patterns recurring across 3+ sites

1. **Hero is a single short sentence, not a paragraph** — MS Learn, HashiCorp, Anthropic, OpenAI docs all hero with one line under ~12 words.
2. **Product/platform grid as the IA spine** — Google Developers (6 tiles), HashiCorp (9 tiles), MS Learn (4 cards), OpenAI capability grid (8 cards). The grid IS the page.
3. **No explicit "pick your role" persona chooser** — every site uses implicit segmentation via product, technical pattern, or skill-level instead. SAP's instinct to add a persona selector is not supported by any of the 10 sites.
4. **Code on the landing page is the strongest "developer-first" signal** — Google Developers, OpenAI docs, and (indirectly via the comparison table) Anthropic docs all show code or a code-shaped artifact above the fold. Microsoft, MS Learn, HashiCorp, Salesforce do not — and read as marketing.
5. **Sequential numbered onboarding ("Step 1 → Step 4")** — Anthropic docs (Steps component) and OpenAI (Build Paths → Models → capabilities) both linearize the new-developer path.
6. **Carousel-heavy hubs feel like directories, not destinations** — Microsoft and Salesforce both stack carousels/cards and lose IA clarity.
7. **Search bar in the hero appears only on learning portals** — MS Learn centers it; reference docs (Anthropic, OpenAI) put it in persistent chrome; product hubs (HashiCorp, Google Developers, MS Developer) omit it from the hero entirely.
8. **Marketing-to-docs seam is a labeled door, not a blend** — Anthropic and (by analogy) OpenAI keep mission/marketing and developer surfaces visually distinct and link between them explicitly. Salesforce blends them and pays for it.
9. **News/announcements get one row, not the whole hero** — Anthropic, Google Developers, MS Learn give news a dedicated band well below the fold; Microsoft is the outlier that turns the whole hero into a Build 2026 carousel.
10. **Generous whitespace + sans-serif + restrained motion is universal** — every modern surface looks calmer than developers.sap.com does today.

## Anti-patterns to avoid

- **Conference / campaign hero takeovers** (Microsoft Build hero, Salesforce's stacked Agentforce/Vibes/event/recipes promos) — the first scroll teaches a returning developer nothing about the platform's IA.
- **Newsletter signup capture forms on the developer hub itself** (Salesforce) — reads as marketing-funnel, not developer hospitality. Any email capture belongs in a clearly separate "stay updated" surface.
- **Mascot + slang fighting with "enterprise" copy** (Salesforce's Astrobot + "get vibing" + "enterprise-grade" in the same hero) — pick one register. SAP's "less enterprise" goal will fail the same way if it lands on slang.
- **Stacked carousels-of-carousels** (Microsoft's eight-section, multi-carousel body) — IA disappears into infinite-scroll; users cannot form a mental map.
- **Mock search results instead of a real search box** (HashiCorp's "Search with ease" block) — looks helpful, isn't; either ship real search or don't gesture at it.
- **Empty-calorie hero taglines** (HashiCorp's *"Define your path"*, Salesforce's *"Pick a prompt, get vibing"*) — tells a 20-year ABAP developer nothing about what they're looking at. The hero sentence has to name the thing.
