/** Video container timing and WebM duration helpers. */
"use strict";

const MocapMedia = (() => {
  function isWebmBlob(file) {
    if (!file) return false;
    if (file.type && /webm/i.test(file.type)) return true;
    return /\.webm$/i.test(file.name || "");
  }

  function readEbmlId(view, offset) {
    const first = view.getUint8(offset);
    let width = 1;
    let mask = 0x80;
    while (width < 4 && !(first & mask)) {
      width += 1;
      mask >>= 1;
    }
    if (!(first & mask)) throw new Error("bad id");
    let id = 0;
    for (let i = 0; i < width; i += 1) id = (id << 8) | view.getUint8(offset + i);
    return { id, width };
  }

  function readEbmlSize(view, offset) {
    const first = view.getUint8(offset);
    let width = 1;
    let mask = 0x80;
    while (width < 8 && !(first & mask)) {
      width += 1;
      mask >>= 1;
    }
    if (!(first & mask)) throw new Error("bad size");
    const dataMask = mask - 1;
    let unknown = (first & dataMask) === dataMask;
    let value = first & dataMask;
    for (let i = 1; i < width; i += 1) {
      const byte = view.getUint8(offset + i);
      if (byte !== 0xff) unknown = false;
      value = value * 256 + byte;
    }
    return { value, width, unknown };
  }

  function readEbmlVint(view, offset) {
    const first = view.getUint8(offset);
    let width = 1;
    let mask = 0x80;
    while (width < 8 && !(first & mask)) {
      width += 1;
      mask >>= 1;
    }
    let value = first & (mask - 1);
    for (let i = 1; i < width; i += 1) value = value * 256 + view.getUint8(offset + i);
    return { value, width };
  }

  function readEbmlUint(view, offset, length) {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = value * 256 + view.getUint8(offset + i);
    return value;
  }

  function readWebmTiming(buffer) {
    const view = new DataView(buffer);
    const end = view.byteLength;
    let scale = 1000000;
    let duration = 0;
    let clusterTs = 0;
    let lastBlock = 0;
    let prevBlock = 0;
    let offset = 0;
    while (offset + 2 < end) {
      let id;
      let size;
      try {
        id = readEbmlId(view, offset);
        size = readEbmlSize(view, offset + id.width);
      } catch (_) {
        break;
      }
      const payload = offset + id.width + size.width;
      if (id.id === 0x2ad7b1 && !size.unknown && size.value > 0 && payload + size.value <= end) {
        const value = readEbmlUint(view, payload, size.value);
        if (value > 0) scale = value;
      } else if (id.id === 0x4489 && !size.unknown && (size.value === 4 || size.value === 8) && payload + size.value <= end) {
        duration = size.value === 8 ? view.getFloat64(payload) : view.getFloat32(payload);
      } else if (id.id === 0xe7 && !size.unknown && size.value > 0 && payload + size.value <= end) {
        clusterTs = readEbmlUint(view, payload, size.value);
      } else if ((id.id === 0xa3 || id.id === 0xa1) && !size.unknown && payload + 3 <= end) {
        try {
          const track = readEbmlVint(view, payload);
          const absoluteTs = clusterTs + view.getInt16(payload + track.width);
          if (absoluteTs > lastBlock) {
            prevBlock = lastBlock;
            lastBlock = absoluteTs;
          }
        } catch (_) { /* skip a truncated block */ }
      }
      const enter = id.id === 0x18538067 || id.id === 0x1549a966 || id.id === 0x1f43b675
        || id.id === 0xa0 || id.id === 0x1c53bb6b || id.id === 0xbb || size.unknown;
      offset = enter ? payload : payload + size.value;
    }
    const fromDuration = duration > 0 ? (duration * scale) / 1e9 : 0;
    const lastDelta = lastBlock > prevBlock ? lastBlock - prevBlock : 0;
    const fromBlocks = lastBlock > 0 ? ((lastBlock + lastDelta) * scale) / 1e9 : 0;
    return Math.max(fromDuration, fromBlocks);
  }

  async function webmDurationSeconds(file) {
    try {
      return readWebmTiming(await file.arrayBuffer());
    } catch (_) {
      return 0;
    }
  }

  function readFourCC(view, offset) {
    if (offset + 4 > view.byteLength) return "";
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  }

  function walkIsoBoxes(view, start, end, onBox) {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = readFourCC(view, offset + 4);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (!Number.isFinite(size) || size < header) break;
      const boxEnd = Math.min(end, offset + size);
      const payload = offset + header;
      const enter = onBox(type, payload, boxEnd);
      if (enter) walkIsoBoxes(view, payload, boxEnd, onBox);
      if (size === 0) break;
      offset = boxEnd;
    }
  }

  function findIsoBoxOffset(view, type) {
    for (let i = 4; i + 4 <= view.byteLength; i += 1) {
      if (readFourCC(view, i) === type) return Math.max(0, i - 4);
    }
    return -1;
  }

  function parseMp4Timing(buffer) {
    const view = new DataView(buffer);
    const tracks = [];

    const readTrack = (payload, boxEnd) => {
      const track = { vide: false, timescale: 0, duration: 0, samples: 0, delta: 0, codec: "" };
      walkIsoBoxes(view, payload, boxEnd, (type, position, end) => {
        if (type === "mdia" || type === "minf" || type === "stbl") return true;
        if (type === "hdlr" && position + 12 <= end) {
          if (readFourCC(view, position + 8) === "vide") track.vide = true;
        } else if (type === "mdhd" && position + 4 <= end) {
          const version = view.getUint8(position);
          if (version === 1 && position + 32 <= end) {
            track.timescale = view.getUint32(position + 20);
            const duration = Number(view.getBigUint64(position + 24));
            if (duration > 0) track.duration = duration;
          } else if (position + 20 <= end) {
            track.timescale = view.getUint32(position + 12);
            const duration = view.getUint32(position + 16);
            if (duration > 0) track.duration = duration;
          }
        } else if (type === "stts" && position + 8 <= end) {
          const count = view.getUint32(position + 4);
          let samples = 0;
          let weighted = 0;
          let firstDelta = 0;
          for (let i = 0; i < count; i += 1) {
            const entry = position + 8 + i * 8;
            if (entry + 8 > end) break;
            const number = view.getUint32(entry);
            const delta = view.getUint32(entry + 4);
            samples += number;
            weighted += number * delta;
            if (!firstDelta && delta) firstDelta = delta;
          }
          track.samples = samples;
          track.delta = samples ? weighted / samples : firstDelta;
        } else if (type === "stsd" && position + 16 <= end) {
          track.codec = readFourCC(view, position + 12);
        }
        return false;
      });
      return track;
    };

    const scan = (start) => {
      walkIsoBoxes(view, start, view.byteLength, (type, payload, boxEnd) => {
        if (type === "moov") return true;
        if (type === "trak") {
          tracks.push(readTrack(payload, boxEnd));
          return false;
        }
        return false;
      });
    };
    scan(0);
    if (!tracks.length) {
      const moovAt = findIsoBoxOffset(view, "moov");
      if (moovAt >= 0) scan(moovAt);
    }

    const videoTrack = tracks.find((track) => track.vide && track.timescale > 0)
      || tracks.find((track) => track.timescale > 0);
    if (!videoTrack) return { fps: 0, duration: 0, codec: "" };
    let fps = 0;
    if (videoTrack.duration > 0 && videoTrack.samples > 1) {
      fps = (videoTrack.samples * videoTrack.timescale) / videoTrack.duration;
    } else if (videoTrack.delta > 0 && videoTrack.timescale > 0) {
      fps = videoTrack.timescale / videoTrack.delta;
    }
    const duration = videoTrack.timescale > 0 && videoTrack.duration > 0
      ? videoTrack.duration / videoTrack.timescale
      : 0;
    if (!(fps >= 1 && fps <= 240)) fps = 0;
    return { fps, duration, codec: videoTrack.codec || "" };
  }

  function parseWebmTimingInfo(buffer) {
    const duration = readWebmTiming(buffer);
    const view = new DataView(buffer);
    const end = view.byteLength;
    let defaultDuration = 0;
    let offset = 0;
    while (offset + 2 < end) {
      let id;
      let size;
      try {
        id = readEbmlId(view, offset);
        size = readEbmlSize(view, offset + id.width);
      } catch (_) {
        break;
      }
      const payload = offset + id.width + size.width;
      if (id.id === 0x23e383 && !size.unknown && size.value > 0 && payload + size.value <= end) {
        defaultDuration = readEbmlUint(view, payload, size.value);
      }
      const enter = id.id === 0x18538067 || id.id === 0x1549a966 || id.id === 0x1f43b675
        || id.id === 0x1654ae6b || id.id === 0xae
        || id.id === 0xa0 || id.id === 0x1c53bb6b || id.id === 0xbb || size.unknown;
      offset = enter ? payload : payload + size.value;
    }
    let fps = defaultDuration > 0 ? 1e9 / defaultDuration : 0;
    if (!(fps >= 1 && fps <= 240)) fps = 0;
    return { fps, duration, codec: "vp8" };
  }

  async function detectMediaTiming(file) {
    const empty = { fps: 0, duration: 0, codec: "" };
    if (!file) return empty;
    try {
      const chunk = 8 * 1024 * 1024;
      const head = await file.slice(0, Math.min(file.size, chunk)).arrayBuffer();
      const parse = (buffer) => (isWebmBlob(file) ? parseWebmTimingInfo(buffer) : parseMp4Timing(buffer));
      let timing = parse(head);
      if (timing.fps > 0 || timing.duration > 0) return timing;
      if (file.size > chunk) {
        const tail = await file.slice(Math.max(0, file.size - chunk)).arrayBuffer();
        timing = parse(tail);
        if (timing.fps > 0 || timing.duration > 0) return timing;
      }
    } catch (_) { /* fall through */ }
    return empty;
  }

  function writeEbmlSize(value, width) {
    const bytes = new Uint8Array(width);
    let remaining = value;
    for (let i = width - 1; i >= 0; i -= 1) {
      bytes[i] = remaining & 0xff;
      remaining >>= 8;
    }
    bytes[0] |= 1 << (8 - width);
    return bytes;
  }

  async function withWebmDuration(blob, durationSec) {
    if (!(durationSec > 0) || !isWebmBlob(blob)) return blob;
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let scale = 1000000;
    let infoPayload = -1;
    let infoSizeOffset = -1;
    let infoSizeWidth = 0;
    let infoSizeUnknown = false;
    let infoEnd = -1;
    let durationAt = -1;
    let durationLen = 0;
    let offset = 0;
    const end = bytes.length;
    while (offset + 2 < end) {
      let id;
      let size;
      try {
        id = readEbmlId(view, offset);
        size = readEbmlSize(view, offset + id.width);
      } catch (_) {
        break;
      }
      const payload = offset + id.width + size.width;
      if (id.id === 0x1549a966) {
        infoPayload = payload;
        infoSizeOffset = offset + id.width;
        infoSizeWidth = size.width;
        infoSizeUnknown = size.unknown;
        infoEnd = size.unknown ? end : payload + size.value;
      } else if (id.id === 0x2ad7b1 && !size.unknown && payload + size.value <= end) {
        const value = readEbmlUint(view, payload, size.value);
        if (value > 0) scale = value;
      } else if (id.id === 0x4489 && !size.unknown) {
        durationAt = payload;
        durationLen = size.value;
      }
      if (id.id === 0x18538067 || id.id === 0x1549a966) offset = payload;
      else if (size.unknown) offset = payload;
      else offset = payload + size.value;
      if (infoPayload >= 0 && !infoSizeUnknown && offset >= infoEnd) break;
    }
    const durationValue = (durationSec * 1e9) / scale;
    if (durationAt >= 0 && (durationLen === 4 || durationLen === 8)) {
      const out = bytes.slice();
      const outView = new DataView(out.buffer);
      if (durationLen === 8) outView.setFloat64(durationAt, durationValue);
      else outView.setFloat32(durationAt, durationValue);
      return new Blob([out], { type: blob.type });
    }
    if (infoPayload < 0) return blob;
    const durationElement = new Uint8Array(11);
    durationElement[0] = 0x44;
    durationElement[1] = 0x89;
    durationElement[2] = 0x88;
    new DataView(durationElement.buffer).setFloat64(3, durationValue);
    const before = bytes.subarray(0, infoPayload);
    const after = bytes.subarray(infoPayload);
    if (!infoSizeUnknown && infoSizeWidth > 0) {
      const oldSize = readEbmlSize(view, infoSizeOffset).value;
      const sizeBytes = writeEbmlSize(oldSize + durationElement.length, infoSizeWidth);
      if (sizeBytes.length === infoSizeWidth) {
        const patched = bytes.slice();
        patched.set(sizeBytes, infoSizeOffset);
        const merged = new Uint8Array(patched.length + durationElement.length);
        merged.set(patched.subarray(0, infoPayload), 0);
        merged.set(durationElement, infoPayload);
        merged.set(patched.subarray(infoPayload), infoPayload + durationElement.length);
        return new Blob([merged], { type: blob.type });
      }
    }
    const merged = new Uint8Array(before.length + durationElement.length + after.length);
    merged.set(before, 0);
    merged.set(durationElement, before.length);
    merged.set(after, before.length + durationElement.length);
    return new Blob([merged], { type: blob.type });
  }

  return { isWebmBlob, webmDurationSeconds, detectMediaTiming, withWebmDuration };
})();
