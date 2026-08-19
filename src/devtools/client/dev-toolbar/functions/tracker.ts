export type ServerFunctionRequest = {
  type: 'request';
  id: string;
  instance: string;
  source: Request;
  meta?: { readonly name?: string; readonly [key: string]: unknown };
  time: number;
};
export type ServerFunctionResponse = {
  type: 'response';
  id: string;
  instance: string;
  source: Response;
  meta?: { readonly name?: string; readonly [key: string]: unknown };
  time: number;
};

export type ServerFunctionCall = ServerFunctionRequest | ServerFunctionResponse;

export type ServerFunctionCallListener = (event: ServerFunctionCall) => void;

const LISTENERS = new Set<ServerFunctionCallListener>();

export function captureServerFunctionCall(listener: ServerFunctionCallListener): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

export function pushServerFunctionCall(event: ServerFunctionCall): void {
  for (const listener of new Set(LISTENERS)) {
    listener(event);
  }
}
