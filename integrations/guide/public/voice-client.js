let recorder;
let chunks = [];

export async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.start();
}

export function stop() {
  return new Promise((resolve, reject) => {
    if (!recorder) return reject(new Error('Recording has not started'));
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      recorder.stream.getTracks().forEach((track) => track.stop());
      const dataUrl = await new Promise((done) => { const reader = new FileReader(); reader.onload = () => done(reader.result); reader.readAsDataURL(blob); });
      resolve({ dataUrl, mimeType: blob.type, seconds: 0 });
    };
    recorder.stop();
  });
}

export async function play(speechDataUrl) {
  if (!speechDataUrl) return;
  const audio = new Audio(speechDataUrl);
  await new Promise((resolve, reject) => { audio.onended = resolve; audio.onerror = reject; audio.play().catch(reject); });
}
