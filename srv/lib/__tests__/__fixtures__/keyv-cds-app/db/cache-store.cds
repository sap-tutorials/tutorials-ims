namespace plugin.cds_caching;

// Mirror of cds-caching/db/cache-store.cds — minimal fixture so the real
// KeyvCDS adapter can resolve `plugin.cds_caching.CacheStore` and get a
// backing table under cds.test(). Keep the shape in sync with the plugin.
entity CacheStore {
    key ID        : String(900);
        value     : LargeString;
        expiresAt : Int64;
}
