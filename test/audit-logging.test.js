import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

describe('Audit Logging Annotations', () => {

  beforeAll(async () => {
    const csn = await cds.load('*');
    cds.model = cds.compile.for.nodejs(csn);
  });

  it('Users entity has @PersonalData with DataSubject semantics', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    expect(Users['@PersonalData.EntitySemantics']).toBe('DataSubject');
    expect(Users['@PersonalData.DataSubjectRole']).toBe('Developer');
  });

  it('Users.ID has DataSubjectID field semantics', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const idElement = Users.elements.ID;
    expect(idElement['@PersonalData.FieldSemantics']).toBe('DataSubjectID');
  });

  it('Users personal fields are annotated as IsPotentiallyPersonal', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const personalFields = ['uuid', 'firstName', 'lastName', 'email', 'displayName', 'avatarUrl', 'sapId'];
    for (const field of personalFields) {
      expect(Users.elements[field]?.['@PersonalData.IsPotentiallyPersonal']).toBe(true,
        `Expected ${field} to have @PersonalData.IsPotentiallyPersonal`);
    }
  });

  it('UserMetaData has DataSubjectDetails semantics', async () => {
    const { UserMetaData } = cds.entities('com.sap.developers.ims');
    expect(UserMetaData['@PersonalData.EntitySemantics']).toBe('DataSubjectDetails');
  });

  it('UserMetaData.user has DataSubjectID field semantics', async () => {
    const { UserMetaData } = cds.entities('com.sap.developers.ims');
    expect(UserMetaData.elements.user['@PersonalData.FieldSemantics']).toBe('DataSubjectID');
  });

  it('TaskRecords has DataSubjectDetails semantics', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    expect(TaskRecords['@PersonalData.EntitySemantics']).toBe('DataSubjectDetails');
  });

  it('TaskRecords.user has DataSubjectID field semantics', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    expect(TaskRecords.elements.user['@PersonalData.FieldSemantics']).toBe('DataSubjectID');
  });
});

describe('Audit Logging - SecurityEvent Configuration', () => {

  it('audit-log service is configured in CDS requires', async () => {
    const auditConfig = cds.env.requires['audit-log'];
    expect(auditConfig).toBeDefined();
    expect(auditConfig.kind).toBe('audit-log-to-console');
  });

  it('audit-log service handles SecurityEvent operations', async () => {
    const auditConfig = cds.env.requires['audit-log'];
    expect(auditConfig.handle).toContain('WRITE');
  });
});
