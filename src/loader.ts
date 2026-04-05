import { Mod } from './mod.js';

// Load MOD file from an URL
export const loadMod = async (url: URL) => {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const mod = new Mod(arrayBuffer);
    return mod;
};