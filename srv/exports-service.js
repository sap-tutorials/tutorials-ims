import cds from '@sap/cds';

export default cds.service.impl(function () {
  this.on('exportLegacyData', async (req) => {
    const format = (req.data?.format || '').toLowerCase();
    if (format !== 'csv' && format !== 'xlsx') {
      return req.reject(400, `Unsupported format: ${req.data?.format}. Use 'csv' or 'xlsx'.`);
    }
    // OData clients should not be invoking this — the UI uses the GET bridge.
    // Returning a hint keeps the metadata document honest while preventing
    // surprise OData callers from receiving a half-streamed binary they cannot
    // reassemble. The bridge is the single source of truth for streaming.
    return req.reject(501, 'Use GET /admin/exports/exportLegacyData?format=<csv|xlsx> for streaming downloads.');
  });
});
