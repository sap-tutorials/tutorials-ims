import { createHash } from 'node:crypto';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderTopicDetail(topic) {
  if (!topic?.slug || !topic?.label) throw new Error('renderTopicDetail: slug and label required');
  const tutorials = (topic.tutorials || []).map(t => `
      <li class="topic-tutorials__item">
        <a class="topic-tutorials__link" href="${esc(t.href)}">${esc(t.title)}</a>
        ${t.isNew ? '<span class="topic-tutorials__new">NEW</span>' : ''}
        ${t.level ? `<span class="topic-tutorials__level">${esc(t.level)}</span>` : ''}
      </li>`).join('');
  const concepts = (topic.concepts || []).map(c => `
      <li class="topic-concepts__item"><a href="/concepts/${esc(c.slug)}/">${esc(c.name)}</a></li>`).join('');
  const related = (topic.relatedTags || []).map(r => `
      <li class="topic-related__item"><a href="/topics/${esc(r.slug)}/">${esc(r.label)}</a></li>`).join('');

  const conceptsSection = concepts
    ? `<section class="topic-concepts" aria-labelledby="topic-concepts-h">
        <h2 id="topic-concepts-h">Concepts in this topic</h2>
        <ul class="topic-concepts__list" role="list">${concepts}</ul>
      </section>`
    : '';
  const relatedSection = related
    ? `<section class="topic-related" aria-labelledby="topic-related-h">
        <h2 id="topic-related-h">Related topics</h2>
        <ul class="topic-related__list" role="list">${related}</ul>
      </section>`
    : '';

  const body = `<main>
  <article class="topic-detail">
    <nav class="topic-breadcrumb" aria-label="Breadcrumb">
      <ol class="topic-breadcrumb__list">
        <li><a href="/">Home</a></li>
        <li><a href="/topics/">Topics</a></li>
        <li aria-current="page">${esc(topic.label)}</li>
      </ol>
    </nav>
    <header class="topic-detail__header">
      <h1 class="topic-detail__title">${esc(topic.label)}</h1>
      <p class="topic-detail__facet">${esc(topic.facet)}</p>
    </header>
    <section class="topic-tutorials" aria-labelledby="topic-tutorials-h">
      <h2 id="topic-tutorials-h">Tutorials</h2>
      <ul class="topic-tutorials__list" role="list">${tutorials || '<li>No tutorials yet.</li>'}</ul>
    </section>
    ${conceptsSection}
    ${relatedSection}
  </article>
</main>`;
  const contentHash = createHash('sha256').update(body).digest('hex');
  return { body, contentHash };
}
