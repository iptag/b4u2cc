const encoder = new TextEncoder();

export interface SSEEvent<T = unknown> {
  event: string;
  data: T;
}

export class SSEWriter {
  constructor(private controller: ReadableStreamDefaultController<Uint8Array>) {}

  send(event: SSEEvent) {
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    this.controller.enqueue(encoder.encode(payload));
  }

  close() {
    this.controller.close();
  }
}
