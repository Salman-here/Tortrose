'use strict';
// Original Rozare earcons, synthesized from sine-based bell partials. No
// recordings, third-party sound samples, or another brand's audio are used.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../assets/sounds');
const rate = 44100;
function writeTone(name, duration, notes) {
  const samples = new Float64Array(Math.ceil(duration * rate));
  for (const [start, frequency, gain, decay] of notes) {
    for (let i = Math.floor(start * rate); i < samples.length; i++) {
      const t = i / rate - start;
      const attack = Math.min(1, t / 0.009);
      const envelope = attack * Math.exp(-t / decay);
      const body = Math.sin(2 * Math.PI * frequency * t)
        + 0.23 * Math.sin(2 * Math.PI * frequency * 2 * t) * Math.exp(-t / 0.11)
        + 0.055 * Math.sin(2 * Math.PI * frequency * 3 * t) * Math.exp(-t / 0.06);
      samples[i] += gain * envelope * body;
    }
  }
  const peak = samples.reduce((m, n) => Math.max(m, Math.abs(n)), 0);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const fade = Math.min(1, (samples.length - 1 - i) / (rate * 0.035));
    pcm.writeInt16LE(Math.round(samples[i] / peak * 0.62 * fade * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, name), Buffer.concat([header, pcm]));
  console.log(JSON.stringify({ sound: name, originalComposition: true, seconds: duration, sampleRate: rate, peakDbfs: -4.15 }));
}
writeTone('rozare_update_v1.wav', 0.62, [[0, 739.99, 0.65, 0.12], [0.10, 987.77, 0.48, 0.15]]);
writeTone('rozare_new_order_v1.wav', 1.12, [[0, 659.25, 0.62, 0.19], [0.105, 987.77, 0.46, 0.24], [0.21, 1318.51, 0.34, 0.26], [0.21, 659.25, 0.16, 0.25]]);
