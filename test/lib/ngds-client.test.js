import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// ---------------------------------------------------------------------------
// postPayload — manual token handling (Basic-auth → JWT → Bearer)
// ---------------------------------------------------------------------------

// Fake destination returned by the getDestination mock. This mirrors the REAL
// shape `@sap-cloud-sdk/connectivity` getDestination() produces for the
// BasicAuthentication `ngds-destination`: credentials are top-level
// username/password (NOT under a `destinationConfiguration` wrapper — that
// property only exists on the raw destination-service REST response, never on
// the normalized SDK Destination object). Regressing to a
// `destinationConfiguration`-shaped mock is what let the prod bug through.
const FAKE_DEST = {
  url: 'https://api2.services.sap.com',
  authentication: 'BasicAuthentication',
  username: 'ims-user',
  password: 'ims-secret',
};

// Build a minimal fetch Response stub.
function makeResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const TOKEN_RESPONSE = { access_token: 'jwt-abc', expires_in: 3600 };

const getDestinationSpy = vi.fn();
vi.mock('@sap-cloud-sdk/connectivity', () => ({
  getDestination: (...a) => getDestinationSpy(...a),
}));

describe('postPayload', () => {
  let postPayload;

  beforeEach(async () => {
    // Reset module to clear the in-module token cache between tests.
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
    getDestinationSpy.mockReset();
    getDestinationSpy.mockResolvedValue(FAKE_DEST);
    ({ postPayload } = await import('../../srv/lib/ngds-client.js'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('Basic-auths username/password to the auth-service, then POSTs with Bearer', async () => {
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))  // token fetch
      .mockResolvedValueOnce(makeResponse(200));                  // payload POST

    await postPayload({ context: {}, imsData: {} });

    // Token fetch: default auth-service URL on the destination host + Basic auth
    // built from username/password (matches the working manual curl).
    const [tokenUrl, tokenOpts] = fetch.mock.calls[0];
    expect(tokenUrl).toBe(
      'https://api2.services.sap.com/auth-service/oauth/token?grant_type=client_credentials'
    );
    expect(tokenOpts.headers.Authorization).toBe(
      `Basic ${Buffer.from('ims-user:ims-secret').toString('base64')}`
    );

    // Payload POST must use Authorization: Bearer on the NGDS path
    const [postUrl, postOpts] = fetch.mock.calls[1];
    expect(postUrl).toBe('https://api2.services.sap.com/ngds/developers/ims');
    expect(postOpts.headers.Authorization).toBe('Bearer jwt-abc');
    expect(postOpts.method).toBe('POST');
    expect(JSON.parse(postOpts.body)).toEqual({ context: {}, imsData: {} });
  });

  it('reads creds from originalProperties when top-level fields are absent', async () => {
    getDestinationSpy.mockResolvedValue({
      url: 'https://api2.services.sap.com',
      originalProperties: { User: 'ims-user', Password: 'ims-secret' },
    });
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(200));

    await postPayload({});

    const [, tokenOpts] = fetch.mock.calls[0];
    expect(tokenOpts.headers.Authorization).toBe(
      `Basic ${Buffer.from('ims-user:ims-secret').toString('base64')}`
    );
  });

  it('falls back to OAuth2 clientId/clientSecret + tokenServiceUrl if reconfigured', async () => {
    getDestinationSpy.mockResolvedValue({
      url: 'https://ngds.example.com',
      authentication: 'OAuth2ClientCredentials',
      clientId: 'oauth-id',
      clientSecret: 'oauth-secret',
      tokenServiceUrl: 'https://token.example.com/oauth/token',
    });
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(200));

    await postPayload({});

    const [tokenUrl, tokenOpts] = fetch.mock.calls[0];
    expect(tokenUrl).toBe('https://token.example.com/oauth/token?grant_type=client_credentials');
    expect(tokenOpts.headers.Authorization).toBe(
      `Basic ${Buffer.from('oauth-id:oauth-secret').toString('base64')}`
    );
  });

  it('caches the token — second postPayload call does NOT re-fetch the token', async () => {
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))  // first token fetch
      .mockResolvedValue(makeResponse(200));                      // all subsequent POSTs

    await postPayload({ context: {} });
    await postPayload({ context: {} });

    // fetch called 3 times: 1 token + 2 payload POSTs (no second token fetch)
    expect(fetch).toHaveBeenCalledTimes(3);
    const calls = fetch.mock.calls;
    expect(calls[0][0]).toContain('/auth-service/oauth/token'); // first call = token
    expect(calls[1][0]).toContain('/ngds/');    // second = payload
    expect(calls[2][0]).toContain('/ngds/');    // third = payload (cached token reused)
  });

  it('on 401, invalidates cache, refreshes token, and retries once', async () => {
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))              // initial token fetch
      .mockResolvedValueOnce(makeResponse(401))                              // first POST → 401
      .mockResolvedValueOnce(makeResponse(200, { ...TOKEN_RESPONSE, access_token: 'jwt-fresh' })) // re-fetch token
      .mockResolvedValueOnce(makeResponse(200));                             // retry POST → success

    await postPayload({ context: {} });

    expect(fetch).toHaveBeenCalledTimes(4);
    // Retry POST must use the fresh token
    const retryOpts = fetch.mock.calls[3][1];
    expect(retryOpts.headers.Authorization).toBe('Bearer jwt-fresh');
  });

  it('throws with the HTTP status when NGDS returns non-200 after retry', async () => {
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(500, { message: 'internal error' }));

    await expect(postPayload({})).rejects.toThrow('NGDS POST HTTP 500');
  });

  it('throws immediately on 401 if the refreshed token also yields 401', async () => {
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(401))
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(401));

    await expect(postPayload({})).rejects.toThrow('NGDS POST HTTP 401');
  });

  it('throws when destination is not found', async () => {
    getDestinationSpy.mockResolvedValue(null);
    await expect(postPayload({})).rejects.toThrow("Destination 'ngds-destination' not found");
  });

  it('throws when destination has a URL but no resolvable credentials', async () => {
    getDestinationSpy.mockResolvedValue({ url: 'https://api2.services.sap.com' }); // no user/pass
    await expect(postPayload({})).rejects.toThrow('missing token credentials');
  });

  it('honors an explicit tokenServiceUrl override and appends grant_type', async () => {
    getDestinationSpy.mockResolvedValue({
      ...FAKE_DEST,
      tokenServiceUrl: 'https://token.example.com/oauth/token',
    });
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(200));

    await postPayload({});

    const [tokenUrl] = fetch.mock.calls[0];
    expect(tokenUrl).toBe('https://token.example.com/oauth/token?grant_type=client_credentials');
  });

  it('does NOT double-append grant_type when the token URL already has it', async () => {
    getDestinationSpy.mockResolvedValue({
      ...FAKE_DEST,
      tokenServiceUrl: 'https://token.example.com/oauth/token?grant_type=client_credentials',
    });
    fetch
      .mockResolvedValueOnce(makeResponse(200, TOKEN_RESPONSE))
      .mockResolvedValueOnce(makeResponse(200));

    await postPayload({});

    const [tokenUrl] = fetch.mock.calls[0];
    expect((tokenUrl.match(/grant_type/g) ?? []).length).toBe(1);
  });
});
