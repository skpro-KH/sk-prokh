// Render the Khmer Short (1080x1920 MP4).
// Usage: node render.js [--voice path/to/voice.wav] [--out ../why-sky-blue.mp4] [--fps 30]
// With --voice: silence is cut from the WAV and every scene is stretched to fit the cleaned voice length.
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = __dirname, BUILD = path.join(DIR, "build");
const FPS = +arg("--fps", 30), OUT = path.resolve(arg("--out", path.join(DIR, "..", "why-sky-blue.mp4")));
const VOICE = arg("--voice", null);
fs.mkdirSync(BUILD, { recursive: true });
const ff = a => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...a], { stdio: "inherit" });
const dur = f => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim();

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(DIR, "scenes.json"), "utf8"));
  let scale = 1, voiceClean = null;
  if (VOICE) {
    voiceClean = path.join(BUILD, "voice_clean.wav");
    // cut silences longer than 0.35s below -40dB (start, middle, end), keep 0.12s of breath
    ff(["-i", VOICE, "-af",
      "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.1:stop_periods=-1:stop_duration=0.35:stop_threshold=-40dB:stop_silence=0.12,loudnorm=I=-16:TP=-1.5",
      "-ar", "48000", "-ac", "2", voiceClean]);
    scale = dur(voiceClean) / data.total;
    console.log(`voice cleaned: ${dur(VOICE).toFixed(2)}s -> ${dur(voiceClean).toFixed(2)}s (scale ${scale.toFixed(3)})`);
  }
  const total = data.total * scale, frames = Math.round(total * FPS);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(DIR, "index.html"));
  const cues = await page.evaluate(([d, s]) => window.setup(d, s), [data, scale]);
  await page.evaluate(async () => { await document.fonts.load('700 80px "Kantumruy Pro"'); await document.fonts.load('500 40px "Kantumruy Pro"'); await document.fonts.ready; });
  console.log("whoosh cues:", cues.join(", "));

  const silent = path.join(BUILD, "video.mp4");
  const enc = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), silent], { stdio: ["pipe", "inherit", "inherit"] });
  const stage = await page.$("#stage");
  for (let f = 0; f < frames; f++) {
    await page.evaluate(t => window.renderAt(t), f / FPS);
    const buf = await stage.screenshot({ type: "jpeg", quality: 92 });
    if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once("drain", r));
    if (f % 150 === 0) console.log(`frame ${f}/${frames}`);
  }
  enc.stdin.end(); await new Promise(r => enc.on("close", r)); await browser.close();

  // --- audio: synthesized whoosh + soft music bed (+ voice) ---
  const whoosh = path.join(BUILD, "whoosh.wav"), bed = path.join(BUILD, "bed.wav"), mix = path.join(BUILD, "mix.wav");
  ff(["-f", "lavfi", "-i", "anoisesrc=color=pink:duration=0.75:amplitude=0.9:sample_rate=48000",
    "-af", "highpass=f=350,lowpass=f=4500,afade=t=in:st=0:d=0.42:curve=exp,afade=t=out:st=0.42:d=0.33:curve=exp,apulsator=hz=1.6:amount=0.6,volume=1.6",
    "-ac", "2", whoosh]);
  const T = total.toFixed(3);
  ff(["-f", "lavfi", "-i",
    `aevalsrc='0.05*(sin(2*PI*220*t)+0.8*sin(2*PI*277.2*t)+0.7*sin(2*PI*329.6*t)+0.4*sin(2*PI*440*t))*(0.7+0.3*sin(2*PI*0.25*t))':s=48000:d=${T}`,
    "-af", `lowpass=f=1800,aecho=0.8:0.6:300:0.3,afade=t=in:d=1,afade=t=out:st=${(total - 1.5).toFixed(3)}:d=1.5`, "-ac", "2", bed]);
  const inputs = ["-i", bed, ...cues.flatMap(() => ["-i", whoosh])], fc = [], ms = c => Math.max(0, Math.round(c * 1000 - 300));
  cues.forEach((c, i) => fc.push(`[${i + 1}]adelay=${ms(c)}|${ms(c)}[w${i}]`));
  let labels = "[0]" + cues.map((_, i) => `[w${i}]`).join("");
  if (voiceClean) { inputs.push("-i", voiceClean); labels += `[${cues.length + 1}]`; }
  const nIn = cues.length + 1 + (voiceClean ? 1 : 0);
  fc.push(`${labels}amix=inputs=${nIn}:duration=first:normalize=0,alimiter=limit=0.95[a]`);
  ff([...inputs, "-filter_complex", fc.join(";"), "-map", "[a]", "-t", T, mix]);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  ff(["-i", silent, "-i", mix, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", OUT]);
  console.log("done:", OUT, dur(OUT).toFixed(2) + "s");
})();
