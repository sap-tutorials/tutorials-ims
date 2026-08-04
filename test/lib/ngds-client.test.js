import { describe, it, expect } from 'vitest';
import { buildNgdsPayload, formatNgdsDate } from '../../srv/lib/ngds-client.js';

// The payload MUST reproduce the legacy Java IMS MessageModel wire shape so the
// NGDS receiver can match incoming events against IMS reference data. Field
// names/keys are the Java @SerializedName values; ground truth is
// com.sap.developers.ims NGDSSenderServiceImpl.java + model/ngds/*.java.
describe('ngds-client', () => {
  describe('formatNgdsDate', () => {
    it('formats to the zone-less millisecond legacy pattern', () => {
      expect(formatNgdsDate('2026-04-28T10:30:00Z')).toBe('2026-04-28T10:30:00.000');
    });
    it('returns undefined for falsy/invalid input', () => {
      expect(formatNgdsDate(null)).toBeUndefined();
      expect(formatNgdsDate('not-a-date')).toBeUndefined();
    });
  });

  describe('buildNgdsPayload', () => {
    it('produces the legacy MessageModel shape for a completed tutorial', () => {
      const payload = buildNgdsPayload({
        userId: 'S0012345678',
        adobeId: 'visitor-abc',
        tracking: 'sub-123',
        eventDate: formatNgdsDate('2026-04-28T10:30:00Z'),
        imsId: 42,
        imsName: 'Build a CAP App',
        taskType: 'TUTORIAL',
        completed: true,
        contentLanguage: 'en',
        siteLanguage: 'en',
      });

      // context
      expect(payload.context).toEqual({ adobe_id: 'visitor-abc', user_id: 'S0012345678' });
      // trackingInfo
      expect(payload.trackingInfo.tracking).toBe('sub-123');
      expect(payload.trackingInfo.url).toBe('https://developers.sap.com');
      expect(payload.trackingInfo.eventDate).toBe('2026-04-28T10:30:00.000');
      // imsData — IMSID is a STRING; InquiryType is the title-case display name
      expect(payload.imsData.IMSID).toBe('42');
      expect(payload.imsData.IMSName).toBe('Build a CAP App');
      expect(payload.imsData.InquiryType).toBe('Tutorial');
      expect(payload.imsData.CommunityID).toBeUndefined();
      // interactionData — constants + COMP/START-derived IA_REASON
      expect(payload.interactionData.IA_TYPE).toBe('YY_DEV_WEB_IA');
      expect(payload.interactionData.COMM_MEDIUM).toBe('WEB');
      expect(payload.interactionData.SYSTEM_ID).toBe('Developers');
      expect(payload.interactionData.IA_REASON).toBe('COMP_DEV_TUTORIAL');
      expect(payload.interactionData.SiteLanguage).toBe('en');
      expect(payload.interactionData.ContentLanguage).toBe('en');
      // envelope
      expect(payload.isSmcServiceEnabled).toBe(false);
    });

    it('sets imsData.CommunityID for missions (the mission match key)', () => {
      const payload = buildNgdsPayload({
        userId: 'S001',
        imsId: 777,
        imsName: 'Learn RAP',
        taskType: 'MISSION',
        communityId: 'comm-mission-9',
        completed: true,
      });
      expect(payload.imsData.CommunityID).toBe('comm-mission-9');
      expect(payload.imsData.InquiryType).toBe('Mission');
      expect(payload.interactionData.IA_REASON).toBe('COMP_DEV_MISSION');
    });

    it('uses START in IA_REASON for a not-yet-completed record', () => {
      const payload = buildNgdsPayload({
        userId: 'S001', imsId: 5, taskType: 'GROUP', completed: false,
      });
      expect(payload.interactionData.IA_REASON).toBe('START_DEV_GROUP');
      expect(payload.imsData.InquiryType).toBe('Group');
    });

    it('omits absent optional fields (Gson null-omission parity)', () => {
      const payload = buildNgdsPayload({
        userId: 'S001', imsId: 1, taskType: 'TUTORIAL', completed: true,
      });
      expect(payload.context.adobe_id).toBeUndefined();
      expect(payload.trackingInfo.tracking).toBeUndefined();
      expect(payload.imsData.IMSName).toBeUndefined();
      expect(payload.interactionData.INTEREST_ITEM).toBeUndefined();
    });
  });
});
