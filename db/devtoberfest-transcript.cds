namespace com.sap.developers.ims;

/**
 * Cached YouTube captions for Devtoberfest session videos.
 *
 * segments is a gzip-compressed JSON array of [{ start: number, text: string }]
 * fetched from the YouTube Data API (or the uploaded-caption endpoint).
 * source indicates caption provenance: 'uploaded' = manually uploaded,
 * 'auto' = auto-generated, 'none' = unavailable at fetch time.
 */
entity Transcript {
  key videoId   : String(20);
      source    : String(10);  // 'uploaded' | 'auto' | 'none'
      lang      : String(10);
      segments  : LargeBinary; // gzip of [{ start, text }]
      fetchedAt : Timestamp;
}
