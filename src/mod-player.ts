import { loadMod, type ModSource } from "./loader";
import { Mod } from "./mod";

export type RowMessage = {
    type: "row";
    position: number;
    rowIndex: number;
};

export type NoteMessage = {
    type: "note";
    channel: number;
    sample: number | null;
    volume: number;
    period: number | null;
    effect: number | null;
};

export type PlaybackChannelState = {
    channel: number;
    sample: number | null;
    volume: number;
    period: number | null;
    note: string;
    effect: string;
    effectCode: number | null;
};

export type PlaybackState = {
    type: "playbackState";
    position: number;
    rowIndex: number;
    channels: PlaybackChannelState[];
};

export type ModMetadata = {
    title: string;
    instrumentCount: number;
    totalPositions: number;
    patternCount: number;
};

export type PatternCell = {
    channel: number;
    rowIndex: number;
    note: string;
    sample: string;
    effect: string;
    rawPeriod: number;
    rawSample: number;
    rawEffect: number;
};

export type PatternRow = {
    rowIndex: number;
    channels: PatternCell[];
};

export type CurrentPattern = {
    position: number;
    patternIndex: number;
    rows: PatternRow[];
};

type ModPlayerMessage = RowMessage | NoteMessage | PlaybackState;
type RowCallback = (position: number, rowIndex: number) => void;
type NoteCallback = (channel: number, sample: number | null, volume: number, period: number | null, effect: number | null) => void;
type PlaybackStateCallback = (state: PlaybackState) => void;

const createEmptyChannels = (): PlaybackChannelState[] =>
    Array.from({ length: 4 }, (_, index) => ({
        channel: index + 1,
        sample: null,
        volume: 0,
        period: null,
        note: "---",
        effect: "...",
        effectCode: null
    }));

export class ModPlayer {
    private mod: Mod | null = null;
    private audio: AudioContext | null = null;
    private worklet: AudioWorkletNode | null = null;
    private gainNode: GainNode | null = null;
    private playing = false;
    private rowCallbacks: Array<RowCallback> = [];
    private noteCallbacks: Array<NoteCallback> = [];
    private playbackStateCallbacks: Array<PlaybackStateCallback> = [];
    private currentPlaybackState: PlaybackState = {
        type: "playbackState",
        position: 0,
        rowIndex: 0,
        channels: createEmptyChannels()
    };

    async load(source: ModSource) {
        if (this.worklet) {
            this.unload();
        }

        this.mod = await loadMod(source);
        this.audio = new AudioContext();
        this.gainNode = this.audio.createGain();
        this.gainNode.gain.value = 1;

        const workletUrl = new URL("./player-worklet.ts", import.meta.url);
        await this.audio.audioWorklet.addModule(workletUrl.href);

        this.worklet = new AudioWorkletNode(this.audio, "player-worklet");
        this.worklet.connect(this.gainNode);
        this.gainNode.connect(this.audio.destination);
        this.worklet.port.onmessage = this.onmessage.bind(this);
        this.currentPlaybackState = {
            type: "playbackState",
            position: 0,
            rowIndex: 0,
            channels: createEmptyChannels()
        };

        this.worklet.port.postMessage({
            type: "load",
            mod: this.mod,
            sampleRate: this.audio.sampleRate
        });
        this.worklet.port.postMessage({
            type: "enablePlaybackStateSubscription"
        });
        this.publishPlaybackState();
    }

    unload() {
        if (this.playing) {
            this.stop();
        }

        this.worklet?.disconnect();
        this.gainNode?.disconnect();
        this.audio?.close();

        this.mod = null;
        this.audio = null;
        this.worklet = null;
        this.gainNode = null;
        this.playing = false;
        this.currentPlaybackState = {
            type: "playbackState",
            position: 0,
            rowIndex: 0,
            channels: createEmptyChannels()
        };
    }

    async play() {
        if (this.playing || !this.worklet || !this.audio || !this.mod) {
            return;
        }

        await this.audio.resume();
        this.worklet.port.postMessage({
            type: "play"
        });
        this.playing = true;
    }

    pause() {
        if (!this.playing) {
            return;
        }

        this.worklet?.port.postMessage({
            type: "pause"
        });
        this.playing = false;
    }

    stop() {
        this.worklet?.port.postMessage({
            type: "stop"
        });
        this.playing = false;
    }

    seek(position: number, rowIndex: number) {
        if (!this.mod) {
            return;
        }

        const safePosition = Math.min(Math.max(0, position), Math.max(0, this.mod.length - 1));
        const safeRowIndex = Math.min(Math.max(0, rowIndex), 63);
        this.worklet?.port.postMessage({
            type: "seek",
            position: safePosition,
            rowIndex: safeRowIndex
        });
    }

    setMasterVolume(value: number) {
        if (!this.gainNode) {
            return;
        }

        const volume = Math.min(Math.max(0, value), 1);
        this.gainNode.gain.value = volume;
    }

    getMetadata(): ModMetadata | null {
        if (!this.mod) {
            return null;
        }

        return {
            title: this.mod.title || "Untitled MOD",
            instrumentCount: this.mod.instruments.length,
            totalPositions: this.mod.length,
            patternCount: this.mod.patterns.length
        };
    }

    getCurrentPattern(position: number): CurrentPattern | null {
        if (!this.mod) {
            return null;
        }

        const safePosition = Math.min(Math.max(0, position), Math.max(0, this.mod.length - 1));
        const patternIndex = this.mod.patternTable[safePosition];
        const pattern = this.mod.patterns[patternIndex];
        if (!pattern) {
            return null;
        }

        return {
            position: safePosition,
            patternIndex,
            rows: pattern.rows.map((row, rowIndex) => ({
                rowIndex,
                channels: row.notes.map((note, channelIndex) => ({
                    channel: channelIndex + 1,
                    rowIndex,
                    note: this.note(note.period || null),
                    sample: this.formatSample(note.instrument),
                    effect: this.formatEffect(note.effect),
                    rawPeriod: note.period,
                    rawSample: note.instrument,
                    rawEffect: note.effect
                }))
            }))
        };
    }

    getPlaybackState(): PlaybackState {
        return {
            ...this.currentPlaybackState,
            channels: this.currentPlaybackState.channels.map(channel => ({ ...channel }))
        };
    }

    isPlaying() {
        return this.playing;
    }

    onmessage(event: MessageEvent<ModPlayerMessage>) {
        const { data } = event;

        switch (data.type) {
            case "row":
                for (const callback of this.rowCallbacks) {
                    callback(data.position, data.rowIndex);
                }
                break;
            case "note":
                for (const callback of this.noteCallbacks) {
                   callback(data.channel, data.sample, data.volume, data.period, data.effect);
                }
                break;
            case "playbackState":
                this.currentPlaybackState = {
                    ...data,
                    channels: data.channels.map(channel => ({
                        ...channel,
                        note: channel.note || this.note(channel.period),
                        effect: channel.effect || "..."
                    }))
                };
                for (const callback of this.playbackStateCallbacks) {
                    callback(this.getPlaybackState());
                }
                break;
        }
    }

    watchRows(callback: RowCallback) {
        this.worklet?.port.postMessage({
            type: "enableRowSubscription"
        });
        this.rowCallbacks.push(callback);
    }

    watchNotes(callback: NoteCallback) {
        this.worklet?.port.postMessage({
            type: "enableNoteSubscription"
        });
        this.noteCallbacks.push(callback);
    }

    watchPlaybackState(callback: PlaybackStateCallback) {
        this.worklet?.port.postMessage({
            type: "enablePlaybackStateSubscription"
        });
        this.playbackStateCallbacks.push(callback);
        callback(this.getPlaybackState());
    }

    private publishPlaybackState() {
        const snapshot = this.getPlaybackState();
        for (const callback of this.playbackStateCallbacks) {
            callback(snapshot);
        }
    }

    notePerPeriod = Array.from({ length: 65536 }, (_, p) =>
        p < 124 ? null : 24 + Math.round(12 * Math.log2(428 / p))
    );

    noteNames = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

    formatNote(note: number | null): string {
        if (note === null) {
            return "---";
        }

        const name = this.noteNames[note % 12];
        const octave = Math.floor(note / 12);
        return `${name}${octave}`;
    }

    note(period: number | null): string {
        if (period === null) {
            return "---";
        }

        const notePeriod = this.notePerPeriod[Math.round(period)];
        return this.formatNote(notePeriod);
    }

    private formatSample(sample: number) {
        return sample ? sample.toString(16).toUpperCase().padStart(2, "0") : "..";
    }

    private formatEffect(effect: number) {
        if (!effect) {
            return "...";
        }

        const effectId = ((effect >> 8) & 0x0f).toString(16).toUpperCase();
        const effectArg = (effect & 0xff).toString(16).toUpperCase().padStart(2, "0");
        return `${effectId}${effectArg}`;
    }
}
