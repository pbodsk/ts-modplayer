import { loadMod } from "./loader";
import { Mod } from './mod';

export type RowMessage = {
    type: 'row';
    position: number;
    rowIndex: number;
};

export type NoteMessage = {
    type: 'note';
    channel: number;
    sample: number;
    volume: number;
    period: number;
};

type RowCallback = (position: number, rowIndex: number) => void;
type NoteCallback = (channel: number, sample: number, volume: number, period: number) => void;

export class ModPlayer {
    private mod: Mod | null = null;
    private audio: AudioContext | null = null;
    private worklet: AudioWorkletNode | null = null;
    private playing = false;
    private rowCallbacks: Array<RowCallback> = [];
    private noteCallbacks: Array<NoteCallback> = [];

    async load(url: URL) {
        if (this.worklet) this.unload();
        if (this.playing) this.stop();

        this.mod = await loadMod(url);
        this.audio = new AudioContext();
        const workletUrl = new URL('./player-worklet.ts', import.meta.url);
        await this.audio.audioWorklet.addModule(workletUrl.href);
        this.worklet = new AudioWorkletNode(this.audio, 'player-worklet');
        this.worklet.connect(this.audio.destination);

        this.worklet.port.onmessage = this.onmessage.bind(this);
    }

    unload() {
        if (this.playing) this.stop();

        this.worklet?.disconnect();
        this.audio?.close();

        this.mod = null;
        this.audio = null;
        this.worklet = null;
    }

    async play() {
        if (this.playing) return;
        if (!this.worklet) return;
        if (!this.audio) return;

        this.audio.resume();

        this.worklet?.port.postMessage({
            type: 'play',
            mod: this.mod,
            sampleRate: this.audio.sampleRate
        });

        this.playing = true;
    }

    async stop() {
        if (!this.playing) return;

        this.worklet?.port.postMessage({
            type: 'stop'
        });

        this.playing = false;
    }

    // Listen for events
    onmessage(event: MessageEvent<RowMessage | NoteMessage>) {
        const { data } = event;
        switch (data.type) {
            case 'row':
                for (let callback of this.rowCallbacks) {
                    callback(data.position, data.rowIndex);
                }
                break;
            case 'note':
                for (let callback of this.noteCallbacks) {
                    callback(data.channel, data.sample, data.volume, data.period);
                }
                break;
        }
    }

    watchRows(callback: RowCallback) {
        this.worklet?.port.postMessage({
            type: 'enableRowSubscription'
        });
        this.rowCallbacks.push(callback);
    }

    watchNotes(callback: NoteCallback) {
        this.worklet?.port.postMessage({
            type: 'enableNoteSubscription'
        });
        this.noteCallbacks.push(callback);
    }

    notePerPeriod = Array.from({ length: 65536 }, (_, p) =>
        p < 124 ? null : 24 + Math.round(12 * Math.log2(428 / p))
    );

    noteNames = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

    formatNote(note: number | null): string {
        if (note === null) {
            return '---';
        }

        const name = this.noteNames[note % 12];
        const octave = Math.floor(note / 12);
        return `${name}${octave}`;
    }

    note(period: number): string {
        const notePeriod = this.notePerPeriod[period];
        return this.formatNote(notePeriod)
    }
};