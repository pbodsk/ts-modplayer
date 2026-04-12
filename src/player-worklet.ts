/// <reference lib="WebWorker" />

import { Mod } from "./mod";
import { Channel } from "./channel";

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

export class PlayerWorklet extends AudioWorkletProcessor {
  private channels: Channel[];
  private mod: Mod | null = null;
  sampleRateValue = 0;
  private bpm = 32;
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

  // nextOutput() gets called once per audio sample
  private nextOutput(): number {
    if (!this.mod || !this.playing) {
      return 0.0;
    }

    /*
      nextOutput() gets called once per audio sample, which is far too often for tracker logic. 
      So instead of calling nextTick() every time, it counts how many output samples remain before 
      the next tracker tick should happen.
    */
    if (this.outputsUntilNextTick <= 0) {
      /*
        if outputsUntilNextTick <= 0, it means the current tick’s time has run out
        then nextTick() is called to advance tracker state
        then outputsUntilNextTick is refilled with outputsPerTick
        after that, it decrements by one because this call is consuming one sample of that tick
      */
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

registerProcessor("player-worklet", PlayerWorklet);
