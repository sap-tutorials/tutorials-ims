@requires : 'Admin'
service DataPrivacyService @(path : '/admin/data-privacy') {
  function exportDataSubject(userId : String) returns LargeString;
}
