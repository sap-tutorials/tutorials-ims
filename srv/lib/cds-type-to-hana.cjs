'use strict'

// CDS → HANA type mapping for the AnalyticsService listExposedEntities response.
// Lengths/precision/scale are read from the column metadata when present.
function cdsTypeToHana(type, length, precision, scale) {
  switch (type) {
    case 'cds.UUID':       return 'NVARCHAR(36)'
    case 'cds.String':     return length ? `NVARCHAR(${length})` : 'NVARCHAR(255)'
    case 'cds.LargeString':return 'NCLOB'
    case 'cds.Boolean':    return 'BOOLEAN'
    case 'cds.Integer':    return 'INTEGER'
    case 'cds.Int64':      return 'BIGINT'
    case 'cds.Decimal':    return precision ? `DECIMAL(${precision},${scale||0})` : 'DECIMAL'
    case 'cds.Double':     return 'DOUBLE'
    case 'cds.Date':       return 'DATE'
    case 'cds.Time':       return 'TIME'
    case 'cds.DateTime':   return 'SECONDDATE'
    case 'cds.Timestamp':  return 'TIMESTAMP'
    case 'cds.Binary':     return length ? `VARBINARY(${length})` : 'VARBINARY(255)'
    case 'cds.LargeBinary':return 'BLOB'
    default: return type || 'NVARCHAR(255)'
  }
}

module.exports = { cdsTypeToHana }
