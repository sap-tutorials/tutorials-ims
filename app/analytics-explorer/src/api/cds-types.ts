const MAP: Record<string, string> = {
  'cds.String': 'NVARCHAR',
  'cds.LargeString': 'NCLOB',
  'cds.Integer': 'INTEGER',
  'cds.Integer64': 'BIGINT',
  'cds.Decimal': 'DECIMAL',
  'cds.Double': 'DOUBLE',
  'cds.Boolean': 'BOOLEAN',
  'cds.UUID': 'NVARCHAR',
  'cds.Date': 'DATE',
  'cds.DateTime': 'TIMESTAMP',
  'cds.Timestamp': 'TIMESTAMP',
  'cds.Time': 'TIME',
  'cds.Binary': 'VARBINARY',
  'cds.LargeBinary': 'BLOB',
}
export function cdsTypeToHanaType(cdsType: string): string {
  return MAP[cdsType] || 'NVARCHAR'
}
