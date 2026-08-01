const MAGIC = Uint8Array.from([72, 65, 67, 66]);
const VERSION = 1;
const SECTION_COUNT = 2;
const EMAIL_TAG = 1;
const PASSWORD_TAG = 2;
const EMAIL_MAX_BYTES = 320;
const PASSWORD_MAX_BYTES = 4096;
const HEADER_BYTES = MAGIC.byteLength + 2;
const SECTION_HEADER_BYTES = 5;

export interface AccountCredentialBytesV1 {
  readonly email: Readonly<Uint8Array>;
  readonly password: Readonly<Uint8Array>;
}

export function encodeAccountCredentialBundleV1(
  value: AccountCredentialBytesV1,
): Uint8Array | null {
  if (
    typeof value !== "object" || value === null ||
    !(value.email instanceof Uint8Array) ||
    !(value.password instanceof Uint8Array)
  ) return null;
  if (
    !validField(value.email, EMAIL_MAX_BYTES) ||
    !validField(value.password, PASSWORD_MAX_BYTES)
  ) return null;

  const output = Buffer.allocUnsafe(
    HEADER_BYTES + SECTION_HEADER_BYTES * SECTION_COUNT +
      value.email.byteLength + value.password.byteLength,
  );
  output.set(MAGIC, 0);
  output[MAGIC.byteLength] = VERSION;
  output[MAGIC.byteLength + 1] = SECTION_COUNT;
  let offset = HEADER_BYTES;
  offset = writeSection(output, offset, EMAIL_TAG, value.email);
  writeSection(output, offset, PASSWORD_TAG, value.password);
  return output;
}

export function decodeAccountCredentialBundleV1(
  payload: Readonly<Uint8Array>,
): { readonly email: Uint8Array; readonly password: Uint8Array } | null {
  if (payload.byteLength < HEADER_BYTES + SECTION_HEADER_BYTES * SECTION_COUNT + 2) {
    return null;
  }
  for (let index = 0; index < MAGIC.byteLength; index += 1) {
    if (payload[index] !== MAGIC[index]) return null;
  }
  if (
    payload[MAGIC.byteLength] !== VERSION ||
    payload[MAGIC.byteLength + 1] !== SECTION_COUNT
  ) return null;

  const input = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const email = readSection(input, HEADER_BYTES, EMAIL_TAG, EMAIL_MAX_BYTES);
  if (email === null) return null;
  const password = readSection(
    input,
    email.nextOffset,
    PASSWORD_TAG,
    PASSWORD_MAX_BYTES,
  );
  if (password === null || password.nextOffset !== input.byteLength) return null;

  const emailBytes = new Uint8Array(input.subarray(email.start, email.nextOffset));
  const passwordBytes = new Uint8Array(
    input.subarray(password.start, password.nextOffset),
  );
  if (!validUtf8(emailBytes) || !validUtf8(passwordBytes)) {
    emailBytes.fill(0);
    passwordBytes.fill(0);
    return null;
  }
  return { email: emailBytes, password: passwordBytes };
}

function writeSection(
  output: Buffer,
  offset: number,
  tag: number,
  value: Readonly<Uint8Array>,
): number {
  output[offset] = tag;
  output.writeUInt32LE(value.byteLength, offset + 1);
  const start = offset + SECTION_HEADER_BYTES;
  output.set(value, start);
  return start + value.byteLength;
}

function readSection(
  input: Buffer,
  offset: number,
  tag: number,
  bound: number,
): { readonly start: number; readonly nextOffset: number } | null {
  if (offset + SECTION_HEADER_BYTES > input.byteLength || input[offset] !== tag) {
    return null;
  }
  const length = input.readUInt32LE(offset + 1);
  const start = offset + SECTION_HEADER_BYTES;
  if (length < 1 || length > bound || start + length > input.byteLength) return null;
  return { start, nextOffset: start + length };
}

function validField(value: Readonly<Uint8Array>, bound: number): boolean {
  return value.byteLength > 0 && value.byteLength <= bound && validUtf8(value);
}

function validUtf8(value: Readonly<Uint8Array>): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return true;
  } catch {
    return false;
  }
}
