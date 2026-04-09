class Instrument {
    name: string;
    index: number;
    length: number;
    finetune: number;
    volume: number;
    repeatOffset: number;
    repeatLength: number;
    isLooped: boolean
    bytes: Int8Array

    constructor(modfile: ArrayBuffer, index: number, sampleStart: number) {
        this.index = index;
        // Instrument data starts at byte 20 and each instrument is 30 bytes long
        /*
            instrument 0 starts at 20 + 0 * 30 = 20
            instrument 1 starts at 20 + 1 * 30 = 50
            instrument 2 starts at 20 + 2 * 30 = 80
        */
        const data = new Uint8Array(modfile, 20 + index * 30, 30);

        // Trim trailing null bytes
        const nameBytes = data.slice(0, 21).filter(a => !!a);

        // ...nameBytes takes an array and spreads it out as individual values, so [1, 2, 3] becomes 1, 2, 3
        this.name = String.fromCodePoint(...nameBytes).trim();

        // get high and low bit from locations 22 and 23. Multiply by two because these are stored
        // as words and a word = 2 bytes. So...to go from words -> bytes we need to multiply by two
        // 1 byte = 8 bits
        // 1 word = 16 bits
        this.length = 2 * (data[22] * 256 + data[23]);

        // finetune is stored in 4 bits, we therefore take the 4 lowest bits out of data[24]
        /*
            example
            value 0101 0101
            mask  0000 1111
            res.  0000 0101
        */
        this.finetune = data[24] & 0x0f;
        // convert to value in range -8, 7 (signed int)
        if(this.finetune > 7) { this.finetune -= 16};

        this.volume = data[25];
        this.repeatOffset = 2 * (data[26] * 256 + data[27]);
        this.repeatLength = 2 * (data[28] * 256 + data[29]);
        this.isLooped = this.repeatOffset != 0 || this.repeatLength > 2;
        this.bytes = new Int8Array(modfile, sampleStart, this.length);
    }
}

class Note {
    instrument: number;
    period: number;
    effect: number;

    constructor(noteData: Uint8Array) {
        this.instrument = (noteData[0] & 0xf0) | (noteData[2] >> 4);
        this.period = (noteData[0] & 0x0f) * 256 + noteData[1];
        this.effect = (noteData[2] & 0x0f) * 256 + noteData[3];
    }
}

class Row {
    notes: Array<Note>

    constructor(rowData: Uint8Array) {
        this.notes = [];

        for(let i = 0; i < 16; i += 4) {
            const noteData = rowData.slice(i, i + 4);
            this.notes.push(new Note(noteData));
        }
    }
}

class Pattern {
    rows: Array<Row>

    constructor(modfile: ArrayBuffer, index: number) {
        const data = new Uint8Array(modfile, 1084 + index * 1024, 1024);
        this.rows = [];
        
        for(let i = 0; i < 64; ++i) {
            const rowData = data.slice(i * 16, i * 16 + 16);
            this.rows.push(new Row(rowData))
        }
    }
}

export class Mod {
    title: string;
    patternTable: Uint8Array;
    instruments: Array<Instrument>;
    patterns: Array<Pattern>;
    length: number;

    constructor(modfile: ArrayBuffer) {
        const titleBytes = new Uint8Array(modfile, 0, 20);
        this.title = String.fromCodePoint(...titleBytes.filter(a => !!a)).trim();
        this.length = new Uint8Array(modfile, 950, 1)[0];

        // Store pattern table
        /*
            Why 952?

            The pattern table starts after:

            song name: 20 bytes
            31 instrument headers: 31 * 30 = 930 bytes
            total: 20 + 930 = 950
            Then there are:

            1 byte song length at offset 950
            1 byte unused/legacy byte at offset 951
        */
        this.patternTable = new Uint8Array(modfile, 952, 128);

        // Find highest pattern number
        const maxPatternIndex = Math.max(...this.patternTable);

        // Extract all instruments
        this.instruments = [];
        /*
            Why 1084?
                
            After the 128-byte pattern table, there is also a 4-byte signature, typically something like "M.K.".
                
            So:
                
            song name: 20
            instruments: 930
            song length + unused byte: 2
            pattern table: 128
            signature: 4
            Total:
                
            20 + 930 + 2 + 128 + 4 = 1084
            That means byte 1084 is where pattern data begins.
        */
        let sampleStart = 1084 + (maxPatternIndex + 1) * 1024;
        for(let i = 0; i < 31; i++) {
            const instrument = new Instrument(modfile, i, sampleStart);
            this.instruments.push(instrument);
            sampleStart += instrument.length;
        }

        this.patterns = [];
        for(let i = 0; i <= maxPatternIndex; i++) {
            const pattern = new Pattern(modfile, i);
            this.patterns.push(pattern);
        }
    }
}
