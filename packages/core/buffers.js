import { Readable } from 'node:stream';

/**
 * Coerce data into a Buffer. Accepts a Buffer, a Node.js Readable stream,
 * or any value accepted by Buffer.from() (string, ArrayBuffer, etc.).
 * @param {Buffer|Readable|*} data
 * @returns {Promise<Buffer>}
 */
export async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Readable) {
    const chunks = [];
    for await (const chunk of data) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return Buffer.from(data);
}
