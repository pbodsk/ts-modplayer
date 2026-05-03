import { Mod } from './mod.js';

export type ModSource = URL | File;

const loadArrayBuffer = async (source: ModSource) => {
    if (source instanceof URL) {
        const response = await fetch(source);
        const arrayBuffer = await response.arrayBuffer();
        return arrayBuffer;
    }

    return source.arrayBuffer();
};

// Load MOD file from a browser-supported source.
export const loadMod = async (source: ModSource) => {
    const arrayBuffer = await loadArrayBuffer(source);
    return new Mod(arrayBuffer);
};
