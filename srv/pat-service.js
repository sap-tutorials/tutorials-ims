import cds from '@sap/cds';
import { handleMintPAT, handleRevokePAT } from './lib/mcp-pat-actions.js';

export default class PatService extends cds.ApplicationService {
  async init() {
    this.on('mintPAT', handleMintPAT);
    this.on('revokePAT', handleRevokePAT);
    return super.init();
  }
}
