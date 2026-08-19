export class SerovalChunkReader {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer = new Uint8Array(0);
  done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readChunk() {
    const chunk = await this.reader.read();
    if (chunk.done) {
      this.done = true;
      return;
    }
    const buffer = new Uint8Array(this.buffer.length + chunk.value.length);
    buffer.set(this.buffer);
    buffer.set(chunk.value, this.buffer.length);
    this.buffer = buffer;
  }

  async next(): Promise<{ done: true; value: undefined } | { done: false; value: string }> {
    while (this.buffer.length === 0 && !this.done) await this.readChunk();
    if (this.buffer.length === 0) return { done: true, value: undefined };

    const head = new TextDecoder().decode(this.buffer.subarray(1, 11));
    const bytes = Number.parseInt(head, 16);
    if (Number.isNaN(bytes)) throw new Error('Malformed server function stream.');

    while (bytes > this.buffer.length - 12) {
      if (this.done) throw new Error('Malformed server function stream.');
      await this.readChunk();
    }

    const value = new TextDecoder().decode(this.buffer.subarray(12, 12 + bytes));
    this.buffer = this.buffer.subarray(12 + bytes);
    return { done: false, value };
  }

  async drain(interpret: (chunk: string) => void) {
    while (true) {
      const result = await this.next();
      if (result.done) return;
      interpret(result.value);
    }
  }
}
