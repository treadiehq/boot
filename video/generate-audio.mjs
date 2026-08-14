import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "public");
const outputFile = path.join(outputDir, "boot-soundtrack.wav");

const sampleRate = 48_000;
const channels = 2;
const bitsPerSample = 16;
const durationSeconds = 45;
const totalSamples = sampleRate * durationSeconds;
const bytesPerSample = bitsPerSample / 8;
const dataSize = totalSamples * channels * bytesPerSample;
const output = Buffer.alloc(44 + dataSize);

const writeHeader = () => {
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataSize, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  output.writeUInt16LE(channels * bytesPerSample, 32);
  output.writeUInt16LE(bitsPerSample, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataSize, 40);
};

const midi = (note) => 440 * 2 ** ((note - 69) / 12);
const fract = (value) => value - Math.floor(value);
const noise = (index) => fract(Math.sin(index * 12.9898 + 78.233) * 43_758.5453) * 2 - 1;
const triangle = (phase) => (2 / Math.PI) * Math.asin(Math.sin(phase));
const pulseEnvelope = (time, interval, attack, release) => {
  const local = ((time % interval) + interval) % interval;
  if (local < attack) return local / attack;
  return Math.exp(-(local - attack) / release);
};
const fade = (time) => {
  const fadeIn = Math.min(1, time / 1.4);
  const fadeOut = Math.min(1, (durationSeconds - time) / 2.2);
  return Math.max(0, Math.min(fadeIn, fadeOut));
};

const chords = [
  [48, 55, 60, 64],
  [45, 52, 57, 60],
  [53, 60, 65, 69],
  [55, 62, 67, 71],
];
const arp = [60, 64, 67, 72, 67, 64, 62, 67];
const impacts = [0, 4.5, 11, 17.5, 24, 28.5, 31, 33.5, 36, 38.5, 41];

writeHeader();

for (let index = 0; index < totalSamples; index += 1) {
  const time = index / sampleRate;
  const chord = chords[Math.floor(time / 8) % chords.length];
  const masterFade = fade(time);

  let center = 0;
  for (let voice = 0; voice < chord.length; voice += 1) {
    const frequency = midi(chord[voice]);
    const phase = 2 * Math.PI * frequency * time + voice * 0.7;
    center += Math.sin(phase) * (0.018 / (voice + 1));
    center += triangle(phase * 0.5) * (0.006 / (voice + 1));
  }

  const bassFrequency = midi(chord[0] - 12);
  const bassEnvelope = pulseEnvelope(time, 2, 0.035, 0.7);
  center += Math.sin(2 * Math.PI * bassFrequency * time) * bassEnvelope * 0.085;
  center +=
    Math.sin(2 * Math.PI * bassFrequency * 2 * time) * bassEnvelope * 0.018;

  const arpStep = Math.floor(time * 2);
  const arpFrequency = midi(arp[arpStep % arp.length]);
  const arpEnvelope = pulseEnvelope(time, 0.5, 0.012, 0.16);
  const arpSignal =
    Math.sin(2 * Math.PI * arpFrequency * time) * arpEnvelope * 0.045;
  const arpPan = Math.sin(arpStep * 1.7) * 0.45;

  const tickEnvelope = pulseEnvelope(time + 0.002, 0.25, 0.002, 0.018);
  const tick = noise(index) * tickEnvelope * (arpStep % 2 === 0 ? 0.013 : 0.007);

  let impact = 0;
  for (const impactTime of impacts) {
    const local = time - impactTime;
    if (local >= 0 && local < 1.25) {
      const impactEnvelope = Math.exp(-local * 4.8);
      const pitch = 68 - local * 24;
      impact +=
        Math.sin(2 * Math.PI * pitch * local) * impactEnvelope * 0.11 +
        noise(index + Math.floor(impactTime * 1000)) *
          Math.exp(-local * 18) *
          0.026;
    }
  }

  const left = Math.tanh(
    (center + arpSignal * (1 - arpPan) + tick + impact) * masterFade,
  );
  const right = Math.tanh(
    (center + arpSignal * (1 + arpPan) + tick * 0.8 + impact) * masterFade,
  );
  const offset = 44 + index * channels * bytesPerSample;
  output.writeInt16LE(Math.round(left * 32_767), offset);
  output.writeInt16LE(Math.round(right * 32_767), offset + bytesPerSample);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, output);
console.log(`Generated ${path.relative(projectRoot, outputFile)} (${durationSeconds}s).`);
