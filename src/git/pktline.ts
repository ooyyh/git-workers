/**
 * pkt-line: git's length-prefixed line framing used in the smart protocols.
 *
 *   <4-hex-len><payload>   — a line whose total length (incl. the 4 hex chars) is len
 *   0000                    — flush-pkt (end of a section)
 *   0001                    — delim-pkt (protocol v2 section separator)
 *   0002                    — response-end-pkt (protocol v2)
 *
 * len includes the 4 bytes of the hex length itself; the payload is therefore
 * len-4 bytes. A flush-pkt is the special len==0 case.
 */

const FLUSH = "0000";
const DELIM = "0001";
const RESPONSE_END = "0002";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PKT_FLUSH = FLUSH;
export const PKT_DELIM = DELIM;
export const PKT_RESPONSE_END = RESPONSE_END;

/** Encode a payload into a pkt-line (no trailing newline unless payload has one). */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const data = typeof payload === "string" ? enc.encode(payload) : payload;
  const total = data.length + 4;
  const lenHex = total.toString(16).padStart(4, "0");
  const out = new Uint8Array(total);
  out.set(enc.encode(lenHex), 0);
  out.set(data, 4);
  return out;
}

/** Encode a payload that should end with a newline (most protocol lines do). */
export function pktLineStr(s: string): Uint8Array {
  return pktLine(s.endsWith("\n") ? s : s + "\n");
}

/** A flush-pkt as bytes. */
export function pktFlushBytes(): Uint8Array {
  return enc.encode(FLUSH);
}

export function pktDelimBytes(): Uint8Array {
  return enc.encode(DELIM);
}

/**
 * Parse a buffer of pkt-lines into a list of payloads (Uint8Array) plus markers
 * for flush/delim. Non-payload markers are emitted as sentinel strings.
 */
export type PktItem = { type: "data"; data: Uint8Array } | { type: "flush" } | { type: "delim" } | { type: "end" };

export function* parsePktLines(buf: Uint8Array): Generator<PktItem> {
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = dec.decode(buf.subarray(off, off + 4));
    const len = parseInt(lenHex, 16);
    off += 4;
    if (Number.isNaN(len)) throw new Error(`invalid pkt-line length: ${lenHex}`);
    if (len === 0) {
      yield { type: "flush" };
      continue;
    }
    if (len === 1) {
      yield { type: "delim" };
      continue;
    }
    if (len === 2) {
      yield { type: "end" };
      continue;
    }
    if (len < 4 || off + (len - 4) > buf.length) {
      throw new Error(`invalid pkt-line length ${len} at offset ${off - 4}`);
    }
    yield { type: "data", data: buf.subarray(off, off + len - 4) };
    off += len - 4;
  }
}
