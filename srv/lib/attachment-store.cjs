'use strict'
const cds = require('@sap/cds')
const { Readable } = require('node:stream')

// Metadata on TutorialAssets; original bytes in its Attachments composition.
// Mirror of image-store.cjs — see that file for the withCtx/tenant rationale.
//
// API:
//   head(sourceUrl)   → Promise<{ exists, ID?, contentHash?, mimeType?, filename? }>
//   put(sourceUrl, { buffer, mimeType, contentHash, slug, channel, filename }) → Promise<void>
//   getStream(sourceUrl) → Promise<{ stream: Readable, mimeType: string, filename: string } | null>
//   remove(sourceUrl)    → Promise<void>

function linkedContent() {
  return cds.linked(cds.model).definitions['com.sap.developers.ims.TutorialAssets.content']
}

// The @cap-js/attachments S3 (and standard) provider reads `cds.context.tenant`
// unconditionally on every put/get. The warm path and serve routes both run
// OUTSIDE a CDS request context, so `cds.context` is undefined. Wrapping each
// store op in cds.tx() establishes a (tenant-less) context.
// Harmless on the SQLite basic provider used by unit tests, which never reads it.
function withCtx(fn) {
  return cds.context ? fn() : cds.tx(fn)
}

async function head(sourceUrl) {
  return withCtx(async () => {
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(TutorialAssets)
      .columns('ID', 'contentHash', 'mimeType', 'filename').where({ sourceUrl })
    return row
      ? { exists: true, ID: row.ID, contentHash: row.contentHash, mimeType: row.mimeType, filename: row.filename }
      : { exists: false }
  })
}

async function put(sourceUrl, { buffer, mimeType, contentHash, slug, channel, filename, byteSize }) {
  return withCtx(async () => {
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    // delete-then-insert avoids NonUpdatableProperties:[content] 409 on overwrite
    await remove(sourceUrl)
    const parentID = cds.utils.uuid()
    const name = filename || sourceUrl.split('/').pop()
    const bs = byteSize != null ? byteSize : (Buffer.isBuffer(buffer) ? buffer.length : null)
    await INSERT.into(TutorialAssets).entries({ ID: parentID, sourceUrl, slug, channel, contentHash, mimeType, filename: name, byteSize: bs })
    const AttachmentsSrv = await cds.connect.to('attachments')
    await AttachmentsSrv.put(linkedContent(), {
      ID: cds.utils.uuid(),
      up__ID: parentID,
      url: cds.utils.uuid(),
      content: Readable.from(buffer),   // Readable works on both SQLite and Object Store (S3)
      mimeType,
      filename: name,
      status: 'Clean',
    })
  })
}

async function getStream(sourceUrl) {
  return withCtx(async () => {
    const meta = await head(sourceUrl)
    if (!meta.exists) return null
    const Content = linkedContent()
    const att = await SELECT.one.from(Content).columns('ID').where({ up__ID: meta.ID })
    if (!att) return null
    const AttachmentsSrv = await cds.connect.to('attachments')
    const stream = await AttachmentsSrv.get(Content, { ID: att.ID })  // → Node Readable
    return stream ? { stream, mimeType: meta.mimeType, filename: meta.filename } : null
  })
}

async function remove(sourceUrl) {
  return withCtx(async () => {
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    // Composition cascades content delete
    await DELETE.from(TutorialAssets).where({ sourceUrl })
  })
}

module.exports = { head, put, getStream, remove }
