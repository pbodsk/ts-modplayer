import { loadMod } from './loader.js';

// Make this file a module so top-level await is valid.
export {};

const audio = new AudioContext();

const workletUrl = new URL('./player-worklet.ts', import.meta.url);
await audio.audioWorklet.addModule(workletUrl.href);

const player = new AudioWorkletNode(audio, 'player-worklet');
player.connect(audio.destination);

// Load modfile
//const url = new URL('https://api.modarchive.org/downloads.php?moduleid=57925#space_debris.mod');
//const url = new URL('https://api.modarchive.org/downloads.php?moduleid=41529');
const url = new URL('https://api.modarchive.org/downloads.php?moduleid=101789#musiklinjen.mod');
//const url = new URL('https://api.modarchive.org/downloads.php?moduleid=211324#creamof.mod');
const mod = await loadMod(url);

player.port.onmessage = (event) => {
  if (event.data?.type === 'debug') {
    console.log(event.data.message);
  }
};

// Play a sample when the user clicks
window.addEventListener('click', () => {
    audio.resume();
    player.port.postMessage({
        type: 'play',
        mod: mod,
        sampleRate: audio.sampleRate
    });
});