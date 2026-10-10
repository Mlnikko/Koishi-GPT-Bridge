'use strict';
const { deflateSync } = require('node:zlib');

// Deterministic, decodable visual test input: a red square and blue circle.
// No labels disclose the colors to the language model.
function visionPng({ width = 640, height = 400, variant = 0 } = {}) {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([name, body])));
    return Buffer.concat([size, name, body, crc]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      let color;
      if (Math.abs(x - width * 0.25) < height * 0.25 && Math.abs(y - height * 0.5) < height * 0.25)
        color = variant ? [20, 170, 50] : [230, 25, 30];
      if ((x - width * 0.73) ** 2 + (y - height * 0.5) ** 2 < (height * 0.23) ** 2)
        color = [30, 90, 235];
      if (color) for (let channel = 0; channel < 3; channel++) raw[y * (width * 3 + 1) + 1 + x * 3 + channel] = color[channel];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { visionPng };
