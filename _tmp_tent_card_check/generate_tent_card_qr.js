const fs = require("fs");
const path = require("path");
const { createCanvas } = require("canvas");

const targetUrl = "https://share.google/C8MdfQlbhVsRVLksN";
const width = 1500;
const height = 5400;
const dpi = 300;
const outPath = path.join(__dirname, "wooden-street-review-tent-card.png");

const QR_VERSION = 5;
const QR_SIZE = 17 + QR_VERSION * 4;
const ECC_CODEWORDS_PER_BLOCK = 18;
const NUM_ERROR_CORRECTION_BLOCKS = 4;
const NUM_RAW_CODEWORDS = 134;
const NUM_DATA_CODEWORDS = 62;
const ECL_FORMAT_BITS = 3; // QR error correction level Q.

function reedSolomonMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonComputeDivisor(degree) {
  const result = Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++) {
      result[i] ^= reedSolomonMultiply(divisor[i], factor);
    }
  }
  return result;
}

function appendBits(bits, val, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
}

function makeDataCodewords(text) {
  const bytes = Buffer.from(text, "utf8");
  const bits = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  for (const b of bytes) appendBits(bits, b, 8);
  const capacity = NUM_DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const result = [];
  for (let i = 0; i < bits.length; i += 8) {
    result.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; result.length < NUM_DATA_CODEWORDS; pad ^= 0xec ^ 0x11) {
    result.push(pad);
  }
  return result;
}

function addEccAndInterleave(dataCodewords) {
  const divisor = reedSolomonComputeDivisor(ECC_CODEWORDS_PER_BLOCK);
  const blocks = [];
  const numShortBlocks = NUM_ERROR_CORRECTION_BLOCKS - (NUM_RAW_CODEWORDS % NUM_ERROR_CORRECTION_BLOCKS);
  const shortBlockDataLen = Math.floor(NUM_RAW_CODEWORDS / NUM_ERROR_CORRECTION_BLOCKS) - ECC_CODEWORDS_PER_BLOCK;

  let k = 0;
  for (let i = 0; i < NUM_ERROR_CORRECTION_BLOCKS; i++) {
    const dataLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const data = dataCodewords.slice(k, k + dataLen);
    k += dataLen;
    blocks.push({ data, ecc: reedSolomonComputeRemainder(data, divisor) });
  }

  const result = [];
  const maxDataLen = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i]);
    }
  }
  for (let i = 0; i < ECC_CODEWORDS_PER_BLOCK; i++) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return result;
}

function makeMatrix() {
  const modules = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
  const isFunction = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));

  function setFunction(x, y, dark) {
    if (x < 0 || x >= QR_SIZE || y < 0 || y >= QR_SIZE) return;
    modules[y][x] = dark;
    isFunction[y][x] = true;
  }

  function drawFinder(x, y) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
  }

  function drawFormatBits(mask) {
    const data = (ECL_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) setFunction(QR_SIZE - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, QR_SIZE - 15 + i, getBit(bits, i));
    setFunction(8, QR_SIZE - 8, true);
  }

  drawFinder(0, 0);
  drawFinder(QR_SIZE - 7, 0);
  drawFinder(0, QR_SIZE - 7);
  drawAlignment(30, 30);
  for (let i = 0; i < QR_SIZE; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFormatBits(0);

  const allCodewords = addEccAndInterleave(makeDataCodewords(targetUrl));
  let bitIndex = 0;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < QR_SIZE; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? QR_SIZE - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < allCodewords.length * 8) {
          modules[y][x] = ((allCodewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function cloneWithMask(mask) {
    const m = modules.map((row) => row.slice());
    for (let y = 0; y < QR_SIZE; y++) {
      for (let x = 0; x < QR_SIZE; x++) {
        if (!isFunction[y][x] && maskBit(mask, x, y)) m[y][x] = !m[y][x];
      }
    }
    return m;
  }

  function penalty(m) {
    let result = 0;
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < QR_SIZE; i++) {
        let runColor = false;
        let runLen = 0;
        for (let j = 0; j < QR_SIZE; j++) {
          const color = axis === 0 ? m[i][j] : m[j][i];
          if (j === 0 || color !== runColor) {
            if (runLen >= 5) result += runLen - 2;
            runColor = color;
            runLen = 1;
          } else {
            runLen++;
          }
        }
        if (runLen >= 5) result += runLen - 2;
      }
    }
    for (let y = 0; y < QR_SIZE - 1; y++) {
      for (let x = 0; x < QR_SIZE - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }
    const dark = m.flat().filter(Boolean).length;
    result += Math.floor(Math.abs(dark * 20 - QR_SIZE * QR_SIZE * 10) / (QR_SIZE * QR_SIZE)) * 10;
    return result;
  }

  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const p = penalty(cloneWithMask(mask));
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
    }
  }

  const finalModules = cloneWithMask(bestMask);
  const savedModules = modules;
  for (let y = 0; y < QR_SIZE; y++) modules[y] = finalModules[y].slice();
  drawFormatBits(bestMask);
  return modules;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawGoogle(ctx, x, y, size) {
  const letters = [
    ["G", "#4285f4"],
    ["o", "#ea4335"],
    ["o", "#fbbc05"],
    ["g", "#4285f4"],
    ["l", "#34a853"],
    ["e", "#ea4335"],
  ];
  ctx.save();
  ctx.font = `700 ${size}px Arial, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  let offset = 0;
  for (const [letter, color] of letters) {
    ctx.fillStyle = color;
    ctx.fillText(letter, x + offset, y);
    offset += ctx.measureText(letter).width - size * 0.04;
  }
  ctx.restore();
}

function drawWoodenStreetLogo(ctx, centerX, y, scale) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#1f1b19";
  ctx.font = `700 ${86 * scale}px Arial, sans-serif`;
  ctx.fillText("Wooden Street", centerX, y);
  ctx.fillStyle = "#7a6a5f";
  ctx.font = `${25 * scale}px Arial, sans-serif`;
  ctx.fillText("Furniture... bonded with love", centerX, y + 44 * scale);
  ctx.fillStyle = "#e56b22";
  ctx.beginPath();
  ctx.moveTo(centerX + 245 * scale, y - 54 * scale);
  ctx.lineTo(centerX + 285 * scale, y - 82 * scale);
  ctx.lineTo(centerX + 325 * scale, y - 54 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawQr(ctx, matrix, centerX, y, size) {
  const quiet = 4;
  const cells = matrix.length + quiet * 2;
  const module = Math.floor(size / cells);
  const actual = module * cells;
  const x = Math.round(centerX - actual / 2);

  ctx.save();
  ctx.strokeStyle = "#d5d5d5";
  ctx.lineWidth = 5;
  roundedRect(ctx, x - 40, y - 40, actual + 80, actual + 80, 34);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, actual, actual);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix.length; col++) {
      if (matrix[row][col]) {
        ctx.fillRect(x + (col + quiet) * module, y + (row + quiet) * module, module, module);
      }
    }
  }
  ctx.restore();
  return { x, y, size: actual };
}

function drawPanel(ctx, matrix, topY) {
  const centerX = width / 2;
  ctx.save();
  ctx.translate(0, topY);

  drawWoodenStreetLogo(ctx, centerX, 255, 1);
  ctx.fillStyle = "#666666";
  ctx.textAlign = "center";
  ctx.font = "400 43px Arial, sans-serif";
  ctx.fillText("WE'D LOVE TO HEAR FROM YOU!", centerX, 620);

  drawGoogle(ctx, 326, 1035, 205);

  ctx.fillStyle = "#f5a623";
  ctx.font = "700 104px Arial, sans-serif";
  ctx.fillText("★ ★ ★ ★ ★", centerX, 1255);

  ctx.fillStyle = "#777777";
  ctx.font = "400 34px Arial, sans-serif";
  ctx.fillText("We put our heart to make your furniture perfect", centerX, 1455);
  ctx.fillText("Review us and share your experience!", centerX, 1512);

  drawQr(ctx, matrix, centerX, 1650, 645);
  ctx.fillStyle = "#888888";
  ctx.font = "400 22px Arial, sans-serif";
  ctx.fillText("SCAN ME", centerX, 2350);
  ctx.font = "400 30px Arial, sans-serif";
  ctx.fillText("share.google/C8MdfQlbhVsRVLksN", centerX, 2448);

  ctx.restore();
}

const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, width, height);

const matrix = makeMatrix();

ctx.save();
ctx.translate(width, 2700);
ctx.rotate(Math.PI);
drawPanel(ctx, matrix, 0);
ctx.restore();

drawPanel(ctx, matrix, 2700);

ctx.strokeStyle = "#eeeeee";
ctx.lineWidth = 3;
ctx.beginPath();
ctx.moveTo(260, 2700);
ctx.lineTo(1240, 2700);
ctx.stroke();

const png = canvas.toBuffer("image/png", {
  resolution: dpi,
  compressionLevel: 9,
});
fs.writeFileSync(outPath, png);
console.log(outPath);
