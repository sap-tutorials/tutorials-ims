import cds from '@sap/cds';
import { timingSafeEqual } from 'node:crypto';
import { resolveTenantSettings } from './runtime-config/tenant-settings.js';

let techUsers = null;

async function loadTechUsers() {
  if (techUsers) return techUsers;

  const raw = (await resolveTenantSettings()).techUsers;
  if (!raw) {
    techUsers = new Map();
    return techUsers;
  }

  // Format: "user1:pass1:role1,role2;user2:pass2:role3"
  // Phase A3 (#809): a role-less entry no longer silently defaults to
  // Admin. Such entries are skipped with a warning at parse time.
  // Operators must specify roles explicitly, e.g. "svc-account:pass:Admin".
  techUsers = new Map();
  for (const entry of raw.split(';')) {
    const [username, password, roles] = entry.split(':');
    if (!username || !password) continue;
    if (!roles) {
      console.warn(
        '[tech-user-auth] skipping tech-user entry with no roles -- specify roles explicitly (e.g. "user:pass:Admin") to enable this entry:',
        username
      );
      continue;
    }
    techUsers.set(username, { password, roles: roles.split(',') });
  }
  return techUsers;
}

async function loadTechUserMapping() {
  const raw = (await resolveTenantSettings()).techUsersMapping;
  if (!raw) return new Map();

  // Format: "tech_id1:real_uuid1;tech_id2:real_uuid2"
  const mapping = new Map();
  for (const entry of raw.split(';')) {
    const [techId, realUuid] = entry.split(':');
    if (techId && realUuid) mapping.set(techId, realUuid);
  }
  return mapping;
}

export async function basicAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) return next();

  const users = await loadTechUsers();
  if (users.size === 0) return next();

  try {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return next();

    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);

    const entry = users.get(username);
    if (!entry) return next();
    const expected = Buffer.from(entry.password);
    const actual = Buffer.from(password);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return next();

    const mapping = await loadTechUserMapping();
    const userId = mapping.get(username) || username;

    req.user = new cds.User({
      id: userId,
      roles: entry.roles,
      attr: { techUser: username }
    });

    next();
  } catch {
    next();
  }
}
