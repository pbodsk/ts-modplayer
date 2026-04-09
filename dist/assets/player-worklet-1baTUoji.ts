/// <reference lib="WebWorker" />

import { Mod } from "./mod";

const PAULA_FREQUENCY = 3546894.6;

type Instrument = Mod["instruments"][number];
type Note = Mod["patterns"][number]["rows"][number]["notes"][number];

type PlayerMessage = {
  type?:
    | "load"
    | "play"
    | "pause"
    | "stop"
    | "seek"
    | "enableRowSubscription"
    | "disableRowSubscription"
    | "enableNoteSubscription"
    | "enablePlaybackStateSubscription";
  mod?: Mod;
  sampleRate?: number;
  position?: number;
  rowIndex?: number;
};

type PlaybackChannelSnapshot = {
  channel: number;
  sample: number | null;
  volume: number;
  period: number | null;
  effectCode: number | null;
  effect: string;
  note: string;
};

class PlayerWorklet extends AudioWorkletProcessor {
  private channels: Channel[];
  private mod: Mod | null = null;
  sampleRateValue = 0;
  private bpm = 125;
  private position = -1;
  private rowIndex = 63;
  tick = 0;
  private outputsUntilNextTick = 0;
  private ticksPerRow = 6;
  private outputsPerTick = 0;
  private patternBreak: number | null = null;
  private playing = false;
  publishRow = false;
  publishNote = false;
  publishPlaybackState = false;
  private pendingJump: { position: number; rowIndex: number } | null = null;

  constructor() {
    super();
    this.port.onmessage = this.onmessage.bind(this);
    this.channels = [new Channel(this, 1), new Channel(this, 2), new Channel(this, 3), new Channel(this, 4)];
  }

  private onmessage(e: MessageEvent<PlayerMessage>): void {
    switch (e.data.type) {
      case "load":
        if (!e.data.mod || !e.data.sampleRate) return;
        this.mod = e.data.mod;
        this.sampleRateValue = e.data.sampleRate;
        this.setBpm(125);
        this.setTicksPerRow(6);
        this.resetPlaybackState();
        this.publishCurrentPlaybackState();
        break;
      case "play":
        if (!this.mod) return;
        this.playing = true;
        break;
      case "pause":
        this.playing = false;
        break;
      case "stop":
        this.playing = false;
        this.resetPlaybackState();
        this.publishCurrentPlaybackState();
        break;
      case "seek":
        if (!this.mod || e.data.position === undefined || e.data.rowIndex === undefined) return;
        this.seek(e.data.position, e.data.rowIndex);
        break;
      case "enableRowSubscription":
        this.publishRow = true;
        break;
      case "disableRowSubscription":
        this.publishRow = false;
        break;
      case "enableNoteSubscription":
        this.publishNote = true;
        break;
      case "enablePlaybackStateSubscription":
        this.publishPlaybackState = true;
        this.publishCurrentPlaybackState();
        break;
    }
  }

  private resetPlaybackState() {
    this.position = -1;
    this.rowIndex = 63;
    this.tick = this.ticksPerRow - 1;
    this.patternBreak = null;
    this.outputsUntilNextTick = 0;
    this.pendingJump = null;

    for (const channel of this.channels) {
      channel.reset();
    }
  }

  private seek(position: number, rowIndex: number) {
    if (!this.mod) {
      return;
    }

    const safePosition = Math.min(Math.max(0, position), Math.max(0, this.mod.length - 1));
    const safeRowIndex = Math.min(Math.max(0, rowIndex), 63);

    this.position = safePosition;
    this.rowIndex = safeRowIndex;
    this.tick = 0;
    this.patternBreak = null;
    this.outputsUntilNextTick = this.outputsPerTick;
    this.pendingJump = { position: safePosition, rowIndex: safeRowIndex };

    for (const channel of this.channels) {
      channel.reset();
    }

    this.applyCurrentRow();
  }

  private nextRow(): void {
    if (!this.mod) {
      return;
    }

    if (this.pendingJump) {
      this.pendingJump = null;
    } else {
      ++this.rowIndex;
      if (this.patternBreak !== null) {
        this.rowIndex = this.patternBreak;
        ++this.position;
        this.patternBreak = null;
      } else if (this.rowIndex === 64) {
        this.rowIndex = 0;
        ++this.position;
      }

      if (this.position >= this.mod.length) {
        this.position = 0;
      }
    }

    this.applyCurrentRow();
  }

  private applyCurrentRow() {
    if (!this.mod) {
      return;
    }

    const patternIndex = this.mod.patternTable[this.position];
    const pattern = this.mod.patterns[patternIndex];
    const row = pattern?.rows[this.rowIndex];

    if (!row) {
      return;
    }

    for (let i = 0; i < 4; ++i) {
      this.channels[i].play(row.notes[i], this.mod);
    }

    if (this.publishRow) {
      this.port.postMessage({
        type: "row",
        position: this.position,
        rowIndex: this.rowIndex
      });
    }

    this.publishCurrentPlaybackState();
  }

  private nextOutput(): number {
    if (!this.mod || !this.playing) {
      return 0.0;
    }

    if (this.outputsUntilNextTick <= 0) {
      this.nextTick();
      this.outputsUntilNextTick += this.outputsPerTick;
    }

    this.outputsUntilNextTick--;

    const rawOutput = this.channels.reduce((acc, channel) => acc + channel.nextOutput(), 0.0);
    return Math.tanh(rawOutput);
  }

  nextTick() {
    ++this.tick;
    if (this.tick === this.ticksPerRow) {
      this.tick = 0;
      this.nextRow();
    }

    for (const channel of this.channels) {
      channel.performTick();
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const channel = output?.[0];
    if (!channel) {
      return true;
    }

    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = this.nextOutput();
    }

    return true;
  }

  setTicksPerRow(ticksPerRow: number) {
    this.ticksPerRow = ticksPerRow;
  }

  setBpm(bpm: number) {
    this.bpm = bpm;
    this.outputsPerTick = this.sampleRateValue * 60 / this.bpm / 4 / 6;
  }

  setPatternBreak(row: number) {
    this.patternBreak = row;
  }

  private publishCurrentPlaybackState() {
    if (!this.publishPlaybackState) {
      return;
    }

    this.port.postMessage({
      type: "playbackState",
      position: Math.max(0, this.position),
      rowIndex: this.position < 0 ? 0 : this.rowIndex,
      channels: this.channels.map(channel => channel.snapshot())
    });
  }
}

class Channel {
  private worklet: PlayerWorklet;
  private channelIndex: number;
  private instrument: Instrument | null = null;
  private period: number | null = null;
  private sampleSpeed = 0.0;
  private sampleIndex = 0;
  private volume = 64;
  private unimplementedEffects = new Set<number>();
  private currentVolume = 0;
  private volumeSlide = 0;
  private currentPeriod: number | null = null;
  private periodDelta: number | null = null;
  private portamentoSpeed = 0;
  private portamento = false;
  private vibratoDepth = 0;
  private vibratoSpeed = 0;
  private vibratoIndex = 0;
  private vibrato = false;
  private arpeggio: number[] | null = null;
  private retrigger: number | null = null;
  private setVolume: number | false = false;
  private setSampleIndex: number | false = false;
  private setCurrentPeriod = false;
  private setInstrument: Instrument | false = false;
  private setPeriod: number | false = false;
  private delayNote: number | false = false;
  private currentEffectCode: number | null = null;

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
  private VOLUME_SLIDE_UP_FINE = 0xea;
  private VOLUME_SLIDE_DOWN_FINE = 0xeb;
  private DELAY_NOTE = 0xed;

  constructor(worklet: PlayerWorklet, channelIndex: number) {
    this.worklet = worklet;
    this.channelIndex = channelIndex;
  }

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
    this.setVolume = false;
    this.setSampleIndex = false;
    this.setCurrentPeriod = false;
    this.setInstrument = false;
    this.setPeriod = false;
    this.delayNote = false;
    this.currentEffectCode = null;
  }

  play(note: Note, mod: Mod): void {
    let publishNote = false;
    this.setInstrument = false;
    this.setVolume = false;
    this.setPeriod = false;
    this.delayNote = false;
    this.setSampleIndex = false;
    this.setCurrentPeriod = false;

    if (note.instrument) {
      this.setInstrument = mod.instruments[note.instrument - 1] ?? null;
      if (this.setInstrument) {
        this.setVolume = this.setInstrument.volume;
      }
    }

    if (note.period) {
      const instrument = this.setInstrument || this.instrument;
      const finetune = instrument?.finetune ?? 0;
      this.setPeriod = note.period - finetune;
      this.setCurrentPeriod = true;
      this.setSampleIndex = 0;
      publishNote = true;
    }

    this.currentEffectCode = note.effect ? this.normalizedEffectCode(note.effect) : null;

    if (note.effect) {
      this.effect(note.effect);
    }

    if (this.delayNote) {
      return;
    }

    if (this.setInstrument) {
      this.instrument = this.setInstrument;
    }

    if (this.setVolume !== false) {
      this.volume = this.setVolume;
      this.currentVolume = this.volume;
    }

    if (this.setPeriod !== false) {
      this.period = this.setPeriod;
    }

    if (this.setCurrentPeriod) {
      this.currentPeriod = this.period;
    }

    if (this.setSampleIndex !== false) {
      this.sampleIndex = this.setSampleIndex;
    }

    if (this.worklet.publishNote && publishNote) {
      this.worklet.port.postMessage({
        type: "note",
        channel: this.channelIndex,
        sample: this.instrument?.index ?? null,
        volume: this.currentVolume,
        period: this.period,
        effect: this.currentEffectCode
      });
    }
  }

  effect(raw: number) {
    this.volumeSlide = 0;
    this.periodDelta = 0;
    this.portamento = false;
    this.vibrato = false;
    this.arpeggio = null;
    this.retrigger = null;
    this.delayNote = false;

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
        this.setSampleIndex = data * 256;
        break;
      case this.SET_VOLUME:
        this.setVolume = data;
        break;
      case this.PATTERN_BREAK: {
        const row = (data >> 4) * 10 + (data & 0x0f);
        this.worklet.setPatternBreak(row);
        break;
      }
      case this.VOLUME_SLIDE:
        if (data & 0xf0) {
          this.volumeSlide = data >> 4;
        } else if (data & 0x0f) {
          this.volumeSlide = -(data & 0x0f);
        }
        break;
      case this.SLIDE_UP:
        this.periodDelta = -data;
        break;
      case this.SLIDE_DOWN:
        this.periodDelta = data;
        break;
      case this.TONE_PORTAMENTO:
        this.portamento = true;
        if (data) this.portamentoSpeed = data;
        this.periodDelta = this.portamentoSpeed;
        this.setCurrentPeriod = false;
        this.setSampleIndex = false;
        break;
      case this.VIBRATO: {
        const speed = data >> 4;
        const depth = data & 0x0f;
        if (speed) this.vibratoSpeed = speed;
        if (depth) this.vibratoDepth = depth;
        this.vibrato = true;
        break;
      }
      case this.TONE_PORTAMENTO_WITH_VOLUME_SLIDE:
        this.portamento = true;
        this.setCurrentPeriod = false;
        this.setSampleIndex = false;
        this.periodDelta = this.portamentoSpeed;
        if (data & 0xf0) {
          this.volumeSlide = data >> 4;
        } else if (data & 0x0f) {
          this.volumeSlide = -(data & 0x0f);
        }
        break;
      case this.VIBRATO_WITH_VOLUME_SLIDE:
        this.vibrato = true;
        if (data & 0xf0) {
          this.volumeSlide = data >> 4;
        } else if (data & 0x0f) {
          this.volumeSlide = -(data & 0x0f);
        }
        break;
      case this.ARPEGGIO:
        this.arpeggio = [0, data >> 4, data & 0x0f];
        break;
      case this.RETRIGGER_NOTE:
        this.retrigger = data;
        break;
      case this.DELAY_NOTE:
        this.delayNote = data;
        break;
      case this.VOLUME_SLIDE_UP_FINE:
        this.setVolume = Math.min(64, this.volume + data);
        break;
      case this.VOLUME_SLIDE_DOWN_FINE:
        this.setVolume = Math.max(0, this.volume - data);
        break;
      default:
        this.unimplementedEffects.add(id);
        break;
    }
  }

  performTick() {
    if (this.volumeSlide && this.worklet.tick > 0) {
      this.currentVolume += this.volumeSlide;
      this.currentVolume = Math.min(Math.max(0, this.currentVolume), 64);
    }

    if (this.vibrato && this.period !== null) {
      this.vibratoIndex = (this.vibratoIndex + this.vibratoSpeed) % 64;
      this.currentPeriod = this.period + Math.sin(this.vibratoIndex / 64 * Math.PI * 2) * this.vibratoDepth;
    } else if (this.periodDelta !== null && this.currentPeriod !== null && this.period !== null) {
      if (this.portamento) {
        if (this.currentPeriod !== this.period) {
          const sign = Math.sign(this.period - this.currentPeriod);
          const distance = Math.abs(this.currentPeriod - this.period);
          const diff = Math.min(distance, this.periodDelta);
          this.currentPeriod += sign * diff;
        }
      } else {
        this.currentPeriod += this.periodDelta;
      }
    } else if (this.arpeggio && this.period !== null) {
      const index = this.worklet.tick % this.arpeggio.length;
      const halfNotes = this.arpeggio[index];
      this.currentPeriod = this.period / Math.pow(2, halfNotes / 12);
    } else if (this.retrigger && (this.worklet.tick % this.retrigger) === 0) {
      this.sampleIndex = 0;
    } else if (this.delayNote === this.worklet.tick) {
      this.instrument = this.setInstrument || this.instrument;
      if (this.setVolume !== false) {
        this.volume = this.setVolume;
        this.currentVolume = this.volume;
      }
      if (this.setPeriod !== false) {
        this.period = this.setPeriod;
        this.currentPeriod = this.period;
      }
      this.sampleIndex = 0;
    }

    if (this.currentPeriod === null) {
      return;
    }

    this.currentPeriod = Math.min(Math.max(113, this.currentPeriod), 856);

    const sampleRate = PAULA_FREQUENCY / this.currentPeriod;
    this.sampleSpeed = sampleRate / this.worklet.sampleRateValue;
  }

  nextOutput(): number {
    if (!this.instrument || this.currentPeriod === null) return 0.0;

    if (this.sampleIndex >= this.instrument.bytes.length) {
      return 0.0;
    }

    const sample = this.instrument.bytes[this.sampleIndex | 0];
    this.sampleIndex += this.sampleSpeed;

    if (this.instrument.isLooped) {
      if (this.sampleIndex >= this.instrument.repeatOffset + this.instrument.repeatLength) {
        this.sampleIndex = this.instrument.repeatOffset;
      } else if (this.sampleIndex >= this.instrument.length) {
        return 0.0;
      }
    }

    return sample / 256.0 * this.currentVolume / 64;
  }

  snapshot(): PlaybackChannelSnapshot {
    return {
      channel: this.channelIndex,
      sample: this.instrument?.index ?? null,
      volume: this.currentVolume,
      period: this.currentPeriod,
      effectCode: this.currentEffectCode,
      effect: this.effectLabel(),
      note: this.noteLabel()
    };
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
    if (this.currentEffectCode === null) {
      return "...";
    }

    return this.currentEffectCode.toString(16).toUpperCase().padStart(2, "0");
  }

  private noteLabel() {
    if (this.currentPeriod === null) {
      return "---";
    }

    const note = 24 + Math.round(12 * Math.log2(428 / this.currentPeriod));
    const names = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
    const name = names[((note % 12) + 12) % 12];
    const octave = Math.floor(note / 12);
    return `${name}${octave}`;
  }
}

registerProcessor("player-worklet", PlayerWorklet);
