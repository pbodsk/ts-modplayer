import { Mod } from "./mod";
import { PlayerWorklet } from "./player-worklet";

type Instrument = Mod["instruments"][number];
type Note = Mod["patterns"][number]["rows"][number]["notes"][number];

const PAULA_FREQUENCY = 3546894.6;

type PlaybackChannelSnapshot = {
    channel: number;
    sample: number | null;
    volume: number;
    period: number | null;
    effectCode: number | null;
    effect: string;
    note: string;
};

type PendingRowChanges = {
    instrument?: Instrument | null;
    volume?: number;
    period?: number;
    sampleIndex?: number;
    refreshCurrentPeriod: boolean;
    publishNote: boolean;
};

class ChannelState {
    instrument: Instrument | null = null;
    period: number | null = null;
    sampleSpeed = 0.0;
    sampleIndex = 0;
    volume = 64;
    currentVolume = 0;
    volumeSlide = 0;
    currentPeriod: number | null = null;
    periodDelta: number | null = null;
    portamentoSpeed = 0;
    portamento = false;
    vibratoDepth = 0;
    vibratoSpeed = 0;
    vibratoIndex = 0;
    vibrato = false;
    arpeggio: number[] | null = null;
    retrigger: number | null = null;
    delayNoteTick: number | null = null;
    currentEffectCode: number | null = null;
    deferredRowChanges: PendingRowChanges | null = null;
    lastPortamentoSpeed = 0;
    lastVibratoSpeed = 0;
    lastVibratoDepth = 0;
    lastVolumeSlide = 0;
    vibratoWaveform = 0;
    vibratoRetrigger = true;

    reset() {
        this.instrument = null;
        this.period = null;
        this.sampleSpeed = 0;
        this.sampleIndex = 0;
        this.volume = 64;
        this.currentVolume = 0;
        this.volumeSlide = 0;
        this.currentPeriod = null;
        this.periodDelta = null;
        this.portamentoSpeed = 0;
        this.portamento = false;
        this.vibratoDepth = 0;
        this.vibratoSpeed = 0;
        this.vibratoIndex = 0;
        this.vibrato = false;
        this.arpeggio = null;
        this.retrigger = null;
        this.delayNoteTick = null;
        this.currentEffectCode = null;
        this.deferredRowChanges = null;
        this.lastPortamentoSpeed = 0;
        this.lastVibratoSpeed = 0;
        this.lastVibratoDepth = 0;
        this.lastVolumeSlide = 0;
        this.vibratoWaveform = 0;
        this.vibratoRetrigger = true;
    }
}

export class Channel {
    private worklet: PlayerWorklet;
    private channelIndex: number;
    private state = new ChannelState();
    private unimplementedEffects = new Set<number>();

    private ARPEGGIO = 0x00;
    private SLIDE_UP = 0x01;
    private SLIDE_DOWN = 0x02;
    private TONE_PORTAMENTO = 0x03;
    private VIBRATO = 0x04;
    private TONE_PORTAMENTO_WITH_VOLUME_SLIDE = 0x05;
    private VIBRATO_WITH_VOLUME_SLIDE = 0x06;
    private SAMPLE_OFFSET = 0x09;
    private VOLUME_SLIDE = 0x0a;
    private SET_VOLUME = 0x0c;
    private PATTERN_BREAK = 0x0d;
    private EXTENDED = 0x0e;
    private SET_SPEED = 0x0f;
    private RETRIGGER_NOTE = 0xe9;
    private SET_VIBRATO_WAVEFORM = 0xe4;
    private VOLUME_SLIDE_UP_FINE = 0xea;
    private VOLUME_SLIDE_DOWN_FINE = 0xeb;
    private DELAY_NOTE = 0xed;

    constructor(worklet: PlayerWorklet, channelIndex: number) {
        this.worklet = worklet;
        this.channelIndex = channelIndex;
    }

    reset() {
        this.state.reset();
    }

    play(note: Note, mod: Mod): void {
        const pending = this.createPendingRowChanges(note, mod);
        const hasNewNote = note.period !== 0;
        this.resetRowEffects();

        this.state.currentEffectCode = note.effect ? this.normalizedEffectCode(note.effect) : null;

        if (hasNewNote && this.state.vibratoRetrigger) {
            this.state.vibratoIndex = 0;
        }

        if (note.effect) {
            this.applyEffect(note.effect, pending);
        }

        if (this.state.delayNoteTick !== null) {
            this.state.deferredRowChanges = pending;
            return;
        }

        this.applyPendingRowChanges(pending);
    }

    performTick() {
        const state = this.state;
        let pitchChangedThisTick = false;

        if (state.volumeSlide && this.worklet.tick > 0) {
            state.currentVolume += state.volumeSlide;
            state.currentVolume = Math.min(Math.max(0, state.currentVolume), 64);
        }

        if (state.vibrato && state.period !== null) {
            if (this.worklet.tick > 0) {
                state.currentPeriod = state.period + this.vibratoDelta(state.vibratoIndex, state.vibratoDepth);
                state.vibratoIndex = (state.vibratoIndex + state.vibratoSpeed) % 64;
                pitchChangedThisTick = true;
            }
        }

        if (state.periodDelta !== null && state.currentPeriod !== null && state.period !== null) {
            if (state.portamento) {
                if (state.currentPeriod !== state.period) {
                    const sign = Math.sign(state.period - state.currentPeriod);
                    const distance = Math.abs(state.currentPeriod - state.period);
                    const diff = Math.min(distance, state.periodDelta);
                    state.currentPeriod += sign * diff;
                    pitchChangedThisTick = true;
                }
            } else {
                state.currentPeriod += state.periodDelta;
                pitchChangedThisTick = true;
            }
        }

        if (state.arpeggio && state.period !== null) {
            const index = this.worklet.tick % state.arpeggio.length;
            const halfNotes = state.arpeggio[index];
            state.currentPeriod = state.period / Math.pow(2, halfNotes / 12);
            pitchChangedThisTick = true;
        }

        if (state.retrigger && (this.worklet.tick % state.retrigger) === 0) {
            state.sampleIndex = 0;
        }

        if (state.delayNoteTick === this.worklet.tick) {
            this.applyDeferredRowChanges();
        }

        if (!pitchChangedThisTick && state.period !== null) {
            state.currentPeriod = state.period;
        }

        this.updateSampleSpeed();
    }

    nextOutput(): number {
        const state = this.state;
        const instrument = state.instrument;

        if (!instrument || state.currentPeriod === null) {
            return 0.0;
        }

        if (state.sampleIndex >= instrument.bytes.length) {
            return 0.0;
        }

        const sample = instrument.bytes[state.sampleIndex | 0];
        state.sampleIndex += state.sampleSpeed;

        if (instrument.isLooped) {
            if (state.sampleIndex >= instrument.repeatOffset + instrument.repeatLength) {
                state.sampleIndex = instrument.repeatOffset;
            } else if (state.sampleIndex >= instrument.length) {
                return 0.0;
            }
        }

        return sample / 256.0 * state.currentVolume / 64;
    }

    snapshot(): PlaybackChannelSnapshot {
        return {
            channel: this.channelIndex,
            sample: this.state.instrument?.index ?? null,
            volume: this.state.currentVolume,
            period: this.state.currentPeriod,
            effectCode: this.state.currentEffectCode,
            effect: this.effectLabel(),
            note: this.noteLabel()
        };
    }

    private createPendingRowChanges(note: Note, mod: Mod): PendingRowChanges {
        const pending: PendingRowChanges = {
            refreshCurrentPeriod: false,
            publishNote: false
        };

        if (note.instrument) {
            pending.instrument = mod.instruments[note.instrument - 1] ?? null;
            if (pending.instrument) {
                pending.volume = pending.instrument.volume;
            }
        }

        if (note.period) {
            const instrument = pending.instrument ?? this.state.instrument;
            const finetune = instrument?.finetune ?? 0;
            pending.period = note.period - finetune;
            pending.refreshCurrentPeriod = true;
            pending.sampleIndex = 0;
            pending.publishNote = true;
        }

        return pending;
    }

    private applyPendingRowChanges(pending: PendingRowChanges) {
        const state = this.state;

        if (pending.instrument !== undefined) {
            state.instrument = pending.instrument;
        }

        if (pending.volume !== undefined) {
            state.volume = pending.volume;
            state.currentVolume = state.volume;
        }

        if (pending.period !== undefined) {
            state.period = pending.period;
        }

        if (pending.refreshCurrentPeriod) {
            state.currentPeriod = state.period;
        }

        if (pending.sampleIndex !== undefined) {
            state.sampleIndex = pending.sampleIndex;
        }

        if (this.worklet.publishNote && pending.publishNote) {
            this.worklet.port.postMessage({
                type: "note",
                channel: this.channelIndex,
                sample: state.instrument?.index ?? null,
                volume: state.currentVolume,
                period: state.period,
                effect: state.currentEffectCode
            });
        }
    }

    private applyDeferredRowChanges() {
        const state = this.state;
        const pending = state.deferredRowChanges;

        if (!pending) {
            state.delayNoteTick = null;
            return;
        }

        if (pending.instrument !== undefined) {
            state.instrument = pending.instrument;
        }

        if (pending.volume !== undefined) {
            state.volume = pending.volume;
            state.currentVolume = state.volume;
        }

        if (pending.period !== undefined) {
            state.period = pending.period;
            state.currentPeriod = state.period;
        }

        state.sampleIndex = 0;
        state.deferredRowChanges = null;
        state.delayNoteTick = null;
    }

    private applyEffect(raw: number, pending: PendingRowChanges) {
        const state = this.state;

        let id = raw >> 8;
        let data = raw & 0xff;
        if (id === this.EXTENDED) {
            id = (id << 4) | (data >> 4);
            data = data & 0x0f;
        }

        switch (id) {
            case this.SET_SPEED:
                if (data >= 1 && data <= 31) {
                    this.worklet.setTicksPerRow(data);
                } else {
                    this.worklet.setBpm(data);
                }
                break;
            case this.SAMPLE_OFFSET:
                pending.sampleIndex = data * 256;
                break;
            case this.SET_VOLUME:
                pending.volume = data;
                break;
            case this.PATTERN_BREAK: {
                const row = (data >> 4) * 10 + (data & 0x0f);
                this.worklet.setPatternBreak(row);
                break;
            }
            case this.VOLUME_SLIDE:
                this.setVolumeSlideFromData(data);
                break;
            case this.SLIDE_UP:
                state.periodDelta = -data;
                break;
            case this.SLIDE_DOWN:
                state.periodDelta = data;
                break;
            case this.TONE_PORTAMENTO:
                state.portamento = true;
                if (data) {
                    state.lastPortamentoSpeed = data;
                }
                state.portamentoSpeed = state.lastPortamentoSpeed;
                state.periodDelta = state.lastPortamentoSpeed;
                pending.refreshCurrentPeriod = false;
                pending.sampleIndex = undefined;
                break;
            case this.VIBRATO: {
                const speed = data >> 4;
                const depth = data & 0x0f;
                if (speed) {
                    state.lastVibratoSpeed = speed;
                }
                if (depth) {
                    state.lastVibratoDepth = depth;
                }
                state.vibrato = true;
                state.vibratoSpeed = state.lastVibratoSpeed;
                state.vibratoDepth = state.lastVibratoDepth;
                break;
            }
            case this.SET_VIBRATO_WAVEFORM:
                state.vibratoWaveform = data & 0x03;
                state.vibratoRetrigger = (data & 0x04) === 0;
                break;
            case this.TONE_PORTAMENTO_WITH_VOLUME_SLIDE:
                state.portamento = true;
                pending.refreshCurrentPeriod = false;
                pending.sampleIndex = undefined;
                state.portamentoSpeed = state.lastPortamentoSpeed;
                state.periodDelta = state.lastPortamentoSpeed;
                if (data) {
                    state.lastVolumeSlide = data;
                }
                this.setVolumeSlideFromData(data);
                break;
            case this.VIBRATO_WITH_VOLUME_SLIDE:
                state.vibrato = true;
                state.vibratoSpeed = state.lastVibratoSpeed;
                state.vibratoDepth = state.lastVibratoDepth;
                if (data) {
                    state.lastVolumeSlide = data;
                }
                this.setVolumeSlideFromData(data);
                break;
            case this.ARPEGGIO:
                state.arpeggio = [0, data >> 4, data & 0x0f];
                break;
            case this.RETRIGGER_NOTE:
                state.retrigger = data;
                break;
            case this.DELAY_NOTE:
                state.delayNoteTick = data;
                break;
            case this.VOLUME_SLIDE_UP_FINE:
                pending.volume = Math.min(64, state.volume + data);
                break;
            case this.VOLUME_SLIDE_DOWN_FINE:
                pending.volume = Math.max(0, state.volume - data);
                break;
            default:
                this.unimplementedEffects.add(id);
                break;
        }
    }

    private updateSampleSpeed() {
        const state = this.state;

        if (state.currentPeriod === null) {
            return;
        }

        state.currentPeriod = Math.min(Math.max(113, state.currentPeriod), 856);

        const sampleRate = PAULA_FREQUENCY / state.currentPeriod;
        state.sampleSpeed = sampleRate / this.worklet.sampleRateValue;
    }

    private resetRowEffects() {
        const state = this.state;
        state.volumeSlide = 0;
        state.periodDelta = null;
        state.portamento = false;
        state.vibrato = false;
        state.arpeggio = null;
        state.retrigger = null;
        state.delayNoteTick = null;
    }

    private setVolumeSlideFromData(data: number) {
        const up = data >> 4;
        const down = data & 0x0f;

        if (up > 0) {
            this.state.volumeSlide = up;
        } else if (down > 0) {
            this.state.volumeSlide = -down;
        } else {
            this.state.volumeSlide = 0;
        }
    }

    private vibratoDelta(index: number, depth: number) {
        const step = index & 63;
        const signedAmplitude = this.vibratoAmplitude(step);
        return (signedAmplitude * depth * 2) >> 7;
    }

  private vibratoAmplitude(step: number) {
    switch (this.state.vibratoWaveform) {
      case 1:
        return 255 - (step * 8);
      case 2:
      case 3:
        return step < 32 ? 255 : -255;
      default:
        return Math.round(Math.sin(step / 64 * Math.PI * 2) * 255);
    }
  }

    private normalizedEffectCode(raw: number) {
        let id = raw >> 8;
        const data = raw & 0xff;
        if (id === this.EXTENDED) {
            id = (id << 4) | (data >> 4);
        }
        return id;
    }

    private effectLabel() {
        if (this.state.currentEffectCode === null) {
            return "...";
        }

        return this.state.currentEffectCode.toString(16).toUpperCase().padStart(2, "0");
    }

    private noteLabel() {
        if (this.state.currentPeriod === null) {
            return "---";
        }

        const note = 24 + Math.round(12 * Math.log2(428 / this.state.currentPeriod));
        const names = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
        const name = names[((note % 12) + 12) % 12];
        const octave = Math.floor(note / 12);
        return `${name}${octave}`;
    }
}
