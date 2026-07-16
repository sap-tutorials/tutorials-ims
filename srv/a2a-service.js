import cds from '@sap/cds';

export default class A2aService extends cds.ApplicationService {
  async init() {
    // intentionally empty — the live A2A path is a custom JSON-RPC Express
    // router registered in srv/server.js (see makeA2aRouter). This class
    // exists so CAP wires up ORD/audit metadata symmetrically with the other
    // services.
    return super.init();
  }
}
