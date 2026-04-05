import { ModPlayer } from './mod-player';

const modPlayer = new ModPlayer();

const loadButton = document.getElementById('btnLoad');
const playButton = document.getElementById('btnPlay');
const stopButton = document.getElementById('btnStop');
const unloadButton = document.getElementById('btnUnload');
const watchRowsButton = document.getElementById('btnWatchRows');
const watchNotesButton = document.getElementById('btnWatchNotes');

const output = document.getElementById('output') as HTMLTextAreaElement | null;

//const url = new URL('https://api.modarchive.org/downloads.php?moduleid=57925#space_debris.mod');
//const url = new URL('https://api.modarchive.org/downloads.php?moduleid=41529');
const url = new URL('https://api.modarchive.org/downloads.php?moduleid=101789#musiklinjen.mod');
//const url = new URL('https://api.modarchive.org/downloads.php?moduleid=211324#creamof.mod');

loadButton?.addEventListener('click', async () => {
    await modPlayer.load(url);
})

playButton?.addEventListener('click', async () => {
    await modPlayer.play();
})

stopButton?.addEventListener('click', async () =>{
    await modPlayer.stop();
})

unloadButton?.addEventListener('click', async () => {
    await modPlayer.unload();
})

watchRowsButton?.addEventListener('click', () => {
    if(output) {
        modPlayer.watchRows((position, rowIndex) => {
            output.value = `Position ${position}, index: ${rowIndex}`
        });
    }
});

watchNotesButton?.addEventListener('click', () => {
    if(output) {
        modPlayer.watchNotes((channel, sample, volume, period) => {
            console.log(`channel: ${channel}, sample: ${sample}, volume: ${volume}, note: ${modPlayer.note(period)}`)
        })
    }
});