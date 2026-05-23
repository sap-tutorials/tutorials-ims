@requires : 'Admin'
service ExportsService @(path : '/admin/exports') {
  action exportLegacyData(format : String) returns LargeBinary;
}
