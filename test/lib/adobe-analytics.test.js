import { describe, it, expect } from 'vitest';
import { buildAdobeBeacon } from '../../srv/lib/adobe-analytics.js';

describe('adobe-analytics', () => {
  describe('buildAdobeBeacon', () => {
    it('constructs XML beacon with correct eVars', () => {
      const xml = buildAdobeBeacon({
        visitorId: 'visitor-123',
        taskLegacyId: 42,
        taskType: 'TUTORIAL',
        taskTitle: 'Build a CAP App',
        reportSuiteId: 'sapdeveloperdev'
      });

      expect(xml).toContain('<reportSuiteID>sapdeveloperdev</reportSuiteID>');
      expect(xml).toContain('<eVar1>42</eVar1>');
      expect(xml).toContain('<eVar2>TUTORIAL</eVar2>');
      expect(xml).toContain('<eVar3>Build a CAP App</eVar3>');
      expect(xml).toContain('<events>event86</events>');
      expect(xml).toContain('<visitorID>visitor-123</visitorID>');
    });

    it('uses default report suite when not specified', () => {
      const xml = buildAdobeBeacon({
        visitorId: 'v1',
        taskLegacyId: 1,
        taskType: 'STEP',
        taskTitle: 'Step 1'
      });
      expect(xml).toContain('<reportSuiteID>sapdeveloperdev</reportSuiteID>');
    });

    it('escapes XML special characters in title', () => {
      const xml = buildAdobeBeacon({
        visitorId: 'v1',
        taskLegacyId: 1,
        taskType: 'TUTORIAL',
        taskTitle: 'Use <tags> & "quotes"'
      });
      expect(xml).toContain('&lt;tags&gt;');
      expect(xml).toContain('&amp;');
    });
  });
});
