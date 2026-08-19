// Keep these values aligned with @solidjs/web/server-functions.
export const BODY_FORMAT_KEY = 'X-Server-Function-Format';

export const BODY_FORMAT_FILE_KEY = '__server_function_file__';

export const enum BodyFormat {
  Serialized = '0',
  String = '1',
  FormData = '2',
  URLSearchParams = '3',
  Blob = '4',
  File = '5',
  ArrayBuffer = '6',
  Uint8Array = '7',
  Json = '8',
}
