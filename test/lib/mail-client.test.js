import { describe, it, expect } from 'vitest';
import { loadTemplate, resolveTemplate } from '../../srv/lib/mail-client.js';
import { determineRecipients } from '../../srv/lib/contributor-notifications.js';

describe('mail-client', () => {
  describe('loadTemplate', () => {
    it('loads first notification template', () => {
      const html = loadTemplate(0);
      expect(html).toContain('first reminder');
      expect(html).toContain('ninety days');
    });

    it('loads second notification template', () => {
      const html = loadTemplate(1);
      expect(html).toContain('second reminder');
      expect(html).toContain('sixty days');
    });

    it('loads third notification template', () => {
      const html = loadTemplate(2);
      expect(html).toContain('third and final reminder');
      expect(html).toContain('thirty days');
    });

    it('loads final notification template', () => {
      const html = loadTemplate(3);
      expect(html).toContain('Dear Team');
      expect(html).toContain('deadline');
    });

    it('throws on invalid level', () => {
      expect(() => loadTemplate(4)).toThrow('Invalid notification level');
      expect(() => loadTemplate(-1)).toThrow('Invalid notification level');
    });
  });

  describe('resolveTemplate', () => {
    it('replaces variables in template HTML', () => {
      const html = '<a href="${dashboardUrl}">Click</a>';
      const result = resolveTemplate(html, { dashboardUrl: 'https://example.com/dashboard' });
      expect(result).toBe('<a href="https://example.com/dashboard">Click</a>');
    });

    it('replaces unknown variables with empty string', () => {
      const html = 'Hello ${name}, welcome to ${place}!';
      const result = resolveTemplate(html, { name: 'Alice' });
      expect(result).toBe('Hello Alice, welcome to !');
    });

    it('handles template with no variables', () => {
      const html = '<p>No placeholders here</p>';
      const result = resolveTemplate(html, { foo: 'bar' });
      expect(result).toBe('<p>No placeholders here</p>');
    });
  });
});

describe('contributor-notifications', () => {
  describe('determineRecipients', () => {
    const baseNotification = {
      contributors: [
        { name: 'Alice', email: 'alice@sap.com', role: 'OWNER' },
        { name: 'Bob', email: 'bob@sap.com', role: 'CONTRIBUTOR' }
      ],
      repoOwner: 'carol@sap.com'
    };
    const adminEmails = ['admin1@sap.com', 'admin2@sap.com'];

    it('level 0: sends only to owner', () => {
      const { to, cc } = determineRecipients({ ...baseNotification, notificationLevel: 0 }, adminEmails);
      expect(to).toEqual(['alice@sap.com']);
      expect(cc).toEqual([]);
    });

    it('level 1: sends to owner, CCs repo owner', () => {
      const { to, cc } = determineRecipients({ ...baseNotification, notificationLevel: 1 }, adminEmails);
      expect(to).toEqual(['alice@sap.com']);
      expect(cc).toEqual(['carol@sap.com']);
    });

    it('level 2: sends to owner, CCs repo owner and admins', () => {
      const { to, cc } = determineRecipients({ ...baseNotification, notificationLevel: 2 }, adminEmails);
      expect(to).toEqual(['alice@sap.com']);
      expect(cc).toEqual(['carol@sap.com', 'admin1@sap.com', 'admin2@sap.com']);
    });

    it('level 3: sends only to admins', () => {
      const { to, cc } = determineRecipients({ ...baseNotification, notificationLevel: 3 }, adminEmails);
      expect(to).toEqual(['admin1@sap.com', 'admin2@sap.com']);
      expect(cc).toEqual([]);
    });

    it('handles missing owner gracefully', () => {
      const notification = { contributors: [], repoOwner: null, notificationLevel: 0 };
      const { to, cc } = determineRecipients(notification, adminEmails);
      expect(to).toEqual([]);
      expect(cc).toEqual([]);
    });

    it('handles missing repo owner at level 1', () => {
      const notification = { ...baseNotification, repoOwner: null, notificationLevel: 1 };
      const { to, cc } = determineRecipients(notification, adminEmails);
      expect(to).toEqual(['alice@sap.com']);
      expect(cc).toEqual([]);
    });

    it('handles level > 3 as empty', () => {
      const { to, cc } = determineRecipients({ ...baseNotification, notificationLevel: 4 }, adminEmails);
      expect(to).toEqual([]);
      expect(cc).toEqual([]);
    });
  });
});
