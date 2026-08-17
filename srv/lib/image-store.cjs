'use strict'
const cds = require('@sap/cds')
const { Readable } = require('node:stream')

// Metadata on TutorialImages; original bytes in its Attachments composition
// (HANA DB for Plan 1, Object Store in Plan 2 — transparent here).
//
// API:
//   head(sourceUrl)   → Promise<{ exists, ID?, contentHash?, mimeType? }>
//   put(sourceUrl, { buffer, mimeType, contentHash, slug, channel }) → Promise<void>
//   getStream(sourceUrl) → Promise<{ stream: Readable, mimeType: string } | null>
//   remove(sourceUrl)    → Promise<void>

function linkedContent() {
  return cds.linked(cds.model).definitions['com.sap.developers.ims.TutorialImages.content']
}

async function head(sourceUrl) {
  const { TutorialImages } = cds.entities('com.sap.developers.ims')
  const row = await SELECT.one.from(TutorialImages)
    .columns('ID', 'contentHash', 'mimeType').where({ sourceUrl })
  return row
    ? { exists: true, ID: row.ID, contentHash: row.contentHash, mimeType: row.mimeType }
    : { exists: false }
}

async function put(sourceUrl, { buffer, mimeType, contentHash, slug, channel }) {
  const { TutorialImages } = cds.entities('com.sap.developers.ims')
  // R5: delete-then-insert avoids the NonUpdatableProperties:[content] 409 on overwrite
  await remove(sourceUrl)
  const parentID = cds.utils.uuid()
  await INSERT.into(TutorialImages).entries({ ID: parentID, sourceUrl, slug, channel, contentHash, mimeType })
  const AttachmentsSrv = await cds.connect.to('attachments')
  await AttachmentsSrv.put(linkedContent(), {
    ID: cds.utils.uuid(),
    up__ID: parentID,
    url: cds.utils.uuid(),
    content: Readable.from(buffer),   // Readable works on both SQLite and Object Store (S3)
    mimeType,
    filename: sourceUrl.split('/').pop(),
    status: 'Clean',
  })
}

async function getStream(sourceUrl) {
  const meta = await head(sourceUrl)
  if (!meta.exists) return null
  const Content = linkedContent()
  const att = await SELECT.one.from(Content).columns('ID').where({ up__ID: meta.ID })
  if (!att) return null
  const AttachmentsSrv = await cds.connect.to('attachments')
  const stream = await AttachmentsSrv.get(Content, { ID: att.ID })  // → Node Readable
  return stream ? { stream, mimeType: meta.mimeType } : null
}

async function remove(sourceUrl) {
  const { TutorialImages } = cds.entities('com.sap.developers.ims')
  // Composition cascades content delete
  await DELETE.from(TutorialImages).where({ sourceUrl })
}

module.exports = { head, put, getStream, remove }
