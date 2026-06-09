// srv/lib/author-ai-persist.js
// Audit persistence helper for AuthorService AI-assist flows (issue #173).
// Isolated for trivial mocking + contained failure mode (never throws).

import cds from '@sap/cds';

const LOG = cds.log('author-ai');

export async function persistAuthorAiRequest({
  requestId, userId, feature, sourceOS, targetOSes, sourceMarkdown, variants,
  tokensUsed, model, durationMs, errorCode,
}) {
  try {
    const db = await cds.connect.to('db');
    let entity = null;
    if (typeof cds.entities === 'function') {
      const ents = cds.entities('com.sap.developers.ims');
      entity = ents?.AuthorAiRequests ?? null;
    }
    if (!entity) {
      LOG.warn('AuthorAiRequests entity not found — skipping persist (unbooted CDS context?)');
      return;
    }
    const sourceLength = sourceMarkdown ? sourceMarkdown.length : 0;
    const variantsJson = variants ? JSON.stringify(variants) : '[]';
    const variantsLength = variantsJson.length;
    await db.run(INSERT.into(entity).entries({
      ID: requestId,
      authorId: userId,
      feature: feature ?? 'os-variants',
      sourceOS,
      targetOSes: Array.isArray(targetOSes) ? targetOSes.join(',') : (targetOSes ?? ''),
      sourceMarkdown: sourceMarkdown ?? null,
      variants: variantsJson,
      sourceLength,
      variantsLength,
      model: model ?? null,
      tokensUsed: tokensUsed ?? null,
      durationMs: durationMs ?? null,
      errorCode: errorCode ?? null,
    }));
  } catch (err) {
    LOG.error('persistAuthorAiRequest failed', err);
    // Never throw — persist is observability, not user-facing.
  }
}
