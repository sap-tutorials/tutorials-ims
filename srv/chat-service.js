import cds from '@sap/cds';

export default class ChatService extends cds.ApplicationService {
  async init() {
    // intentionally empty — the streaming hot path is a custom Express route
    // registered in srv/server.js. This class exists so CAP wires up ORD/audit
    // metadata symmetrically with the other services.
    return super.init();
  }
}
