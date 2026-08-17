'use strict'

/**
 * Build the CAP image-source endpoint URL for a given original image URL.
 *
 * @param {string} u       - The original image URL (e.g. https://raw.githubusercontent.com/...)
 * @param {string} srvUrl  - Base URL of the CAP srv (e.g. https://my-srv.cfapps.eu10.hana.ondemand.com)
 * @returns {string}
 */
function buildImageOriginUrl(u, srvUrl) {
  return `${srvUrl}/content/image-source?u=${encodeURIComponent(u)}`
}

module.exports = { buildImageOriginUrl }
