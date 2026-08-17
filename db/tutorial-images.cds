using { Attachments } from '@cap-js/attachments';
// Adaptation: the main schema uses namespace com.sap.developers.ims, not sap.tutorials.
// We import Tutorials under its actual fully-qualified name.
using { com.sap.developers.ims.Tutorials } from './schema';

namespace sap.tutorials;

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
