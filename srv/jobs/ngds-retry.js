import { retryFailedMessages } from '../lib/ngds-client.js';

export async function retryNgds() {
  return retryFailedMessages();
}
