/// <reference lib="WebWorker" />

import { Mod } from './mod';

const PAULA_FREQUENCY = 3546894.6;

type Instrument = Mod['instruments'][number];
type Note = Mod['patterns'][number]['rows'][number]['notes'][number];

type PlayerMessage = {
  type?: 'play' | 'stop' | 'enableRowSubscription' | 'disableRowSubscription' | 'enableNoteSubscription';
  mod?: Mod;
  sampleRate?: number;
};

class PlayerWorklet extends AudioWorkletProcessor {
  private channels: Array<Channel>;
  private mod: Mod | null = null;
  sampleRateValue = 0;
  private bpm = 125;
  private position = -1;
  private rowIndex = 63;
  tick = 0;
  private outputsUntilNextTick = 0;
  private ticksPerRow = 0;
  private outputsPerTick = 0;
  private patternBreak: number | null = null;
  private playing = false;
  publishRow = false;
  publishNote = false;

  constructor() {
    super();
    this.port.onmessage = this.onmessage.bind(this);
    this.channels = [new Channel(this, 1), new Channel(this, 2), new Channel(this, 3), new Channel(this, 4)];
  }

  private onmessage(e: MessageEvent<PlayerMessage>): void {
    switch (e.data.type) {
      case 'play':
        if (!e.data.mod || !e.data.sampleRate) return;
        this.mod = e.data.mod;
        this.sampleRateValue = e.data.sampleRate;

        this.setBpm(125);
        this.setTicksPerRow(6);

        // Start at the last tick of the pattern "before the first pattern".
        this.position = -1;
        this.rowIndex = 63;
        this.tick = 5;
        this.ticksPerRow = 6;
        this.playing = true;


        // Immediately move to the first row of the first pattern.
        this.outputsUntilNextTick = 0;
        break;
      case 'stop':
        this.playing = false;
        break;
      case 'enableRowSubscription':
        this.publishRow = true;
        break;
      case 'disableRowSubscription':
        this.publishRow = false;
        break;
      case 'enableNoteSubscription':
        this.publishNote = true;
        break;
    }
  }

  private nextRow(): void {
    if (!this.mod) {
      return;
    }

    ++this.rowIndex;
    if (this.patternBreak !== null) {
      this.rowIndex = this.patternBreak;
      ++this.position;
      this.patternBreak = null
    } else if (this.rowIndex === 64) {
      this.rowIndex = 0;
      ++this.position;
    }
    if (this.position >= this.mod.length) {
      this.port.postMessage({
        type: 'debug',
        message: `End of song!`,
      });

      this.position = 0;
    }

    const patternIndex = this.mod.patternTable[this.position];
    const pattern = this.mod.patterns[patternIndex];
    const row = pattern?.rows[this.rowIndex];

    if (!row) { return }

    for (let i = 0; i < 4; ++i) {
      this.channels[i].play(row.notes[i], this.mod, this.sampleRateValue);
    }

    if (this.publishRow) {
      this.port.postMessage({
        type: 'row',
        position: this.position,
        rowIndex: this.rowIndex
      });
    }
  }

  private nextOutput(): number {
    if (!this.mod) {
      return 0.0;
    }
    if (!this.playing) return 0.0;

    if (this.outputsUntilNextTick <= 0) {
      this.nextTick();
      this.outputsUntilNextTick += this.outputsPerTick;
    }

    this.outputsUntilNextTick--;

    // This is where we combine/reduce the output for each channel into one value
    const rawOutput = this.channels.reduce((acc, channel) => acc + channel.nextOutput(), 0.0);
    return Math.tanh(rawOutput);
  }

  nextTick() {
    ++this.tick;
    if (this.tick == this.ticksPerRow) {
      // start over
      this.tick = 0;
      this.nextRow();
    }

    for (let i = 0; i < 4; ++i) {
      this.channels[i].performTick();
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const channel = output?.[0];
    if (!channel) {
      return true;
    }

    for (let i = 0; i < channel.length; i += 1) {
      // Note, these are not _our_ channels, but the process channel, there's only one
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
    this.patternBreak = row
  }
}

class Channel {
  private worklet: PlayerWorklet;
  private channelIndex: number;
  private instrument: Instrument | null = null;
  private period: number | null = null;
  private sampleSpeed: number = 0.0;
  private sampleIndex: number = 0;
  private volume: number = 64;
  private unimplementedEffects: Set<number> = new Set<number>();
  private currentVolume: number = 0;
  private volumeSlide: number = 0;
  private currentPeriod: number | null = null;
  private periodDelta: number | null = null;
  private portamentoSpeed: number = 0;
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


  // Effects
  private ARPEGGIO: number = 0x00;
  private SLIDE_UP: number = 0x01;
  private SLIDE_DOWN: number = 0x02;
  private TONE_PORTAMENTO: number = 0x03;
  private VIBRATO: number = 0x04;
  private TONE_PORTAMENTO_WITH_VOLUME_SLIDE: number = 0x05;
  private VIBRATO_WITH_VOLUME_SLIDE: number = 0x06;
  private SAMPLE_OFFSET: number = 0x09;
  private VOLUME_SLIDE: number = 0x0a;
  private SET_VOLUME: number = 0x0c;
  private PATTERN_BREAK: number = 0x0d;
  private EXTENDED: number = 0x0e;
  private SET_SPEED: number = 0x0f;
  private RETRIGGER_NOTE: number = 0xe9;
  private VOLUME_SLIDE_UP_FINE = 0xea;
  private VOLUME_SLIDE_DOWN_FINE = 0xeb;
  private DELAY_NOTE: number = 0xed;

  constructor(worklet: PlayerWorklet, channelIndex: number) {
    this.worklet = worklet;
    this.channelIndex = channelIndex;
  }

  // step 1. play() changes state
  play(note: Note, mod: Mod, outputSampleRate: number): void {
    let publishNote = false;
    this.setInstrument = false;
    this.setVolume = false;
    this.setPeriod = false;
    this.delayNote = false;

    this.setSampleIndex = false;
    this.setCurrentPeriod = false;

    if (note.instrument) {
      // instruments array is zero-based, but MOD instrument numbers are one-based, therefore the - 1
      this.setInstrument = mod.instruments[note.instrument - 1] ?? null;
      if (this.setInstrument) {
        this.setVolume = this.setInstrument.volume;
      }
    }

    // period = pitch
    // - lower period -> higher pitch
    // - higher period -> lower pitch
    if (note.period) {
      const instrument = this.setInstrument || this.instrument;
      const finetune = instrument?.finetune ?? 0;
      this.setPeriod = note.period - finetune;
      // Set this to true, but it may potentially be overwritten if there are
      // TONE_PORTAMENTO or TONE_PORTAMENTO_WITH_SLIDE effects for this note
      this.setCurrentPeriod = true;
      this.setSampleIndex = 0;
      publishNote = true;
    }

    if (note.effect) {
      this.effect(note.effect);
    }

    if (this.delayNote) {
      // Note is delayed, nothing to do here for now
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

    if(this.worklet.publishNote && publishNote) {
      this.worklet.port.postMessage({
        type: 'note',
        channel: this.channelIndex,
        sample: this.instrument?.index,
        volume: this.currentVolume,
        period: this.period
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
    if (id == this.EXTENDED) {
      // EXTENDED ID can be E0..FF
      id = (id << 4) | (data >> 4);
      data = data & 0x0f;
    }

    this.worklet.port.postMessage({
      type: 'debug',
      message: `Here's effect ${id.toString(16)}`,
    });

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
      case this.PATTERN_BREAK:
        const row = (data >> 4) * 10 + (data & 0x0f);
        this.worklet.setPatternBreak(row);
        break;
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
      case this.VIBRATO:
        const speed = data >> 4;
        const depth = data & 0x0f;
        if (speed) this.vibratoSpeed = speed;
        if (depth) this.vibratoDepth = depth;
        this.vibrato = true;
        break;
      case this.TONE_PORTAMENTO_WITH_VOLUME_SLIDE:
        this.portamento = true;
        this.setCurrentPeriod = false;
        this.setSampleIndex = false;
        this.periodDelta = this.portamentoSpeed;
        if (data & 0xf0) {
          this.volumeSlide = data >> 4;
        }
        else if (data & 0x0f) {
          this.volumeSlide = -(data & 0x0f);
        }
        break;
      case this.VIBRATO_WITH_VOLUME_SLIDE:
        this.vibrato = true;
        if (data & 0xf0) {
          this.volumeSlide = data >> 4;
        }
        else if (data & 0x0f) {
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
        if (!this.unimplementedEffects.has(id)) {
          this.unimplementedEffects.add(id);
          this.worklet.port.postMessage({
            type: 'debug',
            message: `Unimplemented effect ${id.toString(16)}`,
          });
        }
        break;
    }
  }

  // step 2. performTick() evolves state
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
    } else if (this.retrigger && (this.worklet.tick % this.retrigger) == 0) {
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
    // Clamp between 133 (B-3) and 856 (C-1)
    this.currentPeriod = Math.min(Math.max(113, this.currentPeriod), 856);

    const sampleRate = PAULA_FREQUENCY / this.currentPeriod;
    this.sampleSpeed = sampleRate / this.worklet.sampleRateValue;
  }

  // step 3 - nextOutput() renders state
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
}

registerProcessor('player-worklet', PlayerWorklet);
