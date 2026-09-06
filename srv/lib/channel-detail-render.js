// srv/lib/channel-detail-render.js
//
// HTML body renderer for per-channel detail pages (/channels/:slug/).
// Mirrors topic-detail-render.js: returns { body, contentHash } where body
// is the page's <main> element and contentHash is sha256 hex of body.
// The caller (publish-channels.js) wraps body in the __shell__ chrome via
// composeShell before gzip+base64 storage.

import { createHash } from 'node:crypto';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const OWNER_BADGE = {
  SAP_Official: 'SAP',
  SAP_Developer_Advocate: 'SAP Advocate',
  User_Group: 'User Group',
  Community_Member: 'Community',
  Community_Organization: 'Community',
};

function ownerBadge(ownerType) {
  return OWNER_BADGE[ownerType] ?? 'Third-party';
}

export function renderChannelDetail(channel) {
  if (!channel?.slug || !channel?.name) throw new Error('renderChannelDetail: slug and name required');

  const topicItems = (channel.topics || []).map((t) => `
    <li class="channel-topics__item">
      <a href="/topics/${esc(t.slug)}/">${esc(t.label)}</a>
      <span class="channel-topics__count">${esc(String(t.tutorialCount ?? 0))} tutorial${t.tutorialCount === 1 ? '' : 's'}</span>
    </li>`).join('');

  const topicsSection = topicItems
    ? `<section class="channel-topics" aria-labelledby="channel-topics-h">
        <h2 id="channel-topics-h">Topics covered</h2>
        <ul class="channel-topics__list" role="list">${topicItems}</ul>
      </section>`
    : `<section class="channel-topics"><p class="channel-topics__empty">No topic crosswalk data yet.</p></section>`;

  const purposeHtml = channel.purpose
    ? `<p class="channel-detail__purpose">${esc(channel.purpose)}</p>`
    : '';

  const body = `<main>
  <article class="channel-detail">
    <nav class="channel-breadcrumb" aria-label="Breadcrumb">
      <ol class="channel-breadcrumb__list">
        <li><a href="/">Home</a></li>
        <li><a href="/channels/">Channels</a></li>
        <li aria-current="page">${esc(channel.name)}</li>
      </ol>
    </nav>
    <header class="channel-detail__header">
      <h1 class="channel-detail__title">${esc(channel.name)}</h1>
      <span class="channel-detail__badge" data-owner="${esc(channel.ownerType || '')}">${esc(ownerBadge(channel.ownerType))}</span>
      ${purposeHtml}
      <a class="channel-detail__link" href="${esc(channel.url)}" rel="noopener" target="_blank">Visit channel</a>
    </header>
    ${topicsSection}
  </article>
</main>`;

  const contentHash = createHash('sha256').update(body, 'utf-8').digest('hex');
  return { body, contentHash };
}
