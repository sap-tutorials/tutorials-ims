using { com.sap.developers.ims as ims } from './schema';

annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject',
  cascade: 'identity-replace'
} {
  ID          @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid        @PersonalData.IsPotentiallyPersonal;
  firstName   @PersonalData.IsPotentiallyPersonal;
  lastName    @PersonalData.IsPotentiallyPersonal;
  email       @PersonalData.IsPotentiallyPersonal;
  displayName @PersonalData.IsPotentiallyPersonal;
  avatarUrl   @PersonalData.IsPotentiallyPersonal;
  sapId       @PersonalData.IsPotentiallyPersonal;
}

annotate ims.UserMetaData with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'audit-only'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

annotate ims.CodeCheckSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user          @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedCode @PersonalData.IsPotentiallyPersonal;
}

annotate ims.ValidateAnswerSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user            @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedAnswer @PersonalData.IsPotentiallyPersonal;
}

annotate ims.AuthorAiRequests with @PersonalData: {
  EntitySemantics: 'Other'
} {
  authorId       @PersonalData.FieldSemantics: 'DataSubjectID';
  sourceMarkdown @PersonalData.IsPotentiallyPersonal;
  variants       @PersonalData.IsPotentiallyPersonal;
}

annotate ims.BranchDecisions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
