using { Attachments } from '@cap-js/attachments';
// Import schema.cds so the compiler resolves Tutorials (same namespace).
using { com.sap.developers.ims.Tutorials } from './schema';

namespace com.sap.developers.ims;

entity TutorialImages {
  key ID        : UUID;
      sourceUrl   : String(1024) @assert.unique.sourceUrl;  // raw.githubusercontent.com URL (business key)
      tutorial    : Association to Tutorials on tutorial.slug = slug;
      slug        : String(255);             // lowercase canonical
      channel     : String(8);               // 'prod' | 'qa'
      contentHash : String(64);              // sha-256 of the stored original
      mimeType    : String(128);
      content     : Composition of many Attachments;
}
