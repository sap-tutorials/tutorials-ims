using { com.sap.developers.ims as ims } from './schema';

annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject'
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
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}

annotate ims.TaskRecords with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
}
