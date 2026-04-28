import cds from '@sap/cds';

let techUsers = null;

function loadTechUsers() {
  if (techUsers) return techUsers;

  const raw = process.env.TECH_USERS;
  if (!raw) {
    techUsers = new Map();
    return techUsers;
  }

  // Format: "user1:pass1:role1,role2;user2:pass2:role3"
  techUsers = new Map();
  for (const entry of raw.split(';')) {
    const [username, password, roles] = entry.split(':');
    if (username && password) {
      techUsers.set(username, {
        password,
        roles: roles ? roles.split(',') : ['Admin']
      });
    }
  }
  return techUsers;
}

function loadTechUserMapping() {
  const raw = process.env.TECH_USERS_MAPPING;
  if (!raw) return new Map();

  // Format: "tech_id1:real_uuid1;tech_id2:real_uuid2"
  const mapping = new Map();
  for (const entry of raw.split(';')) {
    const [techId, realUuid] = entry.split(':');
    if (techId && realUuid) mapping.set(techId, realUuid);
  }
  return mapping;
}

export function basicAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) return next();

  const users = loadTechUsers();
  if (users.size === 0) return next();

  try {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return next();

    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);

    const entry = users.get(username);
    if (!entry || entry.password !== password) return next();

    const mapping = loadTechUserMapping();
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
