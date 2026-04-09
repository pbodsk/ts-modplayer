import {
    type CurrentPattern,
    ModPlayer,
    type ModMetadata,
    type PlaybackState
} from "./mod-player";

export type TransportState = "idle" | "loading" | "playing" | "paused" | "stopped" | "error";

export type PlaylistEntry = {
    id: string;
    kind: "url" | "local";
    name: string;
    source: string;
    available: boolean;
    file?: File;
};

export type PlayerControllerState = {
    transport: TransportState;
    masterVolume: number;
    playlist: PlaylistEntry[];
    activeIndex: number;
    currentTrack: PlaylistEntry | null;
    metadata: ModMetadata | null;
    playback: PlaybackState;
    currentPattern: CurrentPattern | null;
    error: string | null;
};

type StateListener = (state: PlayerControllerState) => void;

type PersistedPlaylistEntry = {
    id: string;
    kind: "url" | "local";
    name: string;
    source: string;
    available: boolean;
};

const PLAYLIST_STORAGE_KEY = "mod-player-playlist";

const createInitialPlaybackState = (): PlaybackState => ({
    type: "playbackState",
    position: 0,
    rowIndex: 0,
    channels: Array.from({ length: 4 }, (_, index) => ({
        channel: index + 1,
        sample: null,
        volume: 0,
        period: null,
        note: "---",
        effect: "...",
        effectCode: null
    }))
});

export class PlayerController {
    private player: ModPlayer;
    private state: PlayerControllerState;
    private listeners: StateListener[] = [];

    constructor(player = new ModPlayer()) {
        this.player = player;
        this.state = {
            transport: "idle",
            masterVolume: 1,
            playlist: this.loadPersistedPlaylist(),
            activeIndex: -1,
            currentTrack: null,
            metadata: null,
            playback: createInitialPlaybackState(),
            currentPattern: null,
            error: null
        };

        this.player.watchPlaybackState((playback) => {
            this.state = {
                ...this.state,
                playback,
                currentPattern: this.player.getCurrentPattern(playback.position)
            };
            this.emit();
        });
    }

    getState() {
        return this.cloneState();
    }

    canGoPrevious() {
        return this.currentPlaybackIndex() > 0;
    }

    canGoNext() {
        const currentIndex = this.currentPlaybackIndex();
        return currentIndex >= 0 && currentIndex < this.state.playlist.length - 1;
    }

    subscribe(listener: StateListener) {
        this.listeners.push(listener);
        listener(this.cloneState());

        return () => {
            this.listeners = this.listeners.filter(item => item !== listener);
        };
    }

    async loadTrack(entry: PlaylistEntry, autoplay = false) {
        this.updateState({
            transport: "loading",
            error: null,
            currentPattern: null
        });

        try {
            if (entry.kind === "local" && !entry.file) {
                throw new Error("Local files need to be re-added after a page reload.");
            }

            const source = entry.kind === "url" ? new URL(entry.source) : entry.file!;
            await this.player.load(source);
            this.player.setMasterVolume(this.state.masterVolume);

            this.updateState({
                currentTrack: entry,
                metadata: this.player.getMetadata(),
                playback: this.player.getPlaybackState(),
                currentPattern: this.player.getCurrentPattern(this.player.getPlaybackState().position),
                transport: autoplay ? "playing" : "stopped",
                error: null
            });

            if (autoplay) {
                await this.player.play();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to load track.";
            this.updateState({
                transport: "error",
                currentPattern: null,
                error: message
            });
        }
    }

    async play() {
        const current = this.state.currentTrack ?? this.currentPlaylistEntry();
        if (!current) {
            return;
        }

        if (!this.state.currentTrack || this.state.currentTrack.id !== current.id) {
            await this.loadTrack(current, true);
            if (this.state.transport === "error") {
                return;
            }
            return;
        }

        await this.player.play();
        this.updateState({
            transport: "playing",
            error: null
        });
    }

    pause() {
        this.player.pause();
        this.updateState({
            transport: this.state.currentTrack ? "paused" : "idle"
        });
    }

    stop() {
        this.player.stop();
        this.updateState({
            transport: this.state.currentTrack ? "stopped" : "idle",
            playback: this.player.getPlaybackState(),
            currentPattern: this.player.getCurrentPattern(this.player.getPlaybackState().position)
        });
    }

    setMasterVolume(value: number) {
        const masterVolume = Math.min(Math.max(0, value), 1);
        this.player.setMasterVolume(masterVolume);
        this.updateState({ masterVolume });
    }

    seekToRow(position: number, rowIndex: number) {
        this.player.seek(position, rowIndex);
    }

    async addLocalFiles(files: FileList | File[]) {
        const entries = Array.from(files).map(file => ({
            id: this.createId(),
            kind: "local" as const,
            name: file.name,
            source: file.name,
            available: true,
            file
        }));

        this.updatePlaylist([...this.state.playlist, ...entries]);

        if (this.state.activeIndex === -1 && entries.length > 0) {
            await this.selectPlaylistItem(0);
        }
    }

    async addUrl(url: string) {
        const normalizedUrl = url.trim();
        if (!normalizedUrl) {
            return;
        }

        const entry: PlaylistEntry = {
            id: this.createId(),
            kind: "url",
            name: this.nameFromUrl(normalizedUrl),
            source: normalizedUrl,
            available: true
        };

        this.updatePlaylist([...this.state.playlist, entry]);

        if (this.state.activeIndex === -1) {
            await this.selectPlaylistItem(0);
        }
    }

    async selectPlaylistItem(index: number) {
        const entry = this.state.playlist[index];
        if (!entry) {
            return;
        }

        this.updateState({
            activeIndex: index,
            error: null
        });
        await this.activateEntry(entry, {
            updateSelection: true
        });
    }

    async playNextTrack() {
        const currentIndex = this.currentPlaybackIndex();
        if (currentIndex < 0 || currentIndex >= this.state.playlist.length - 1) {
            return;
        }

        await this.activateEntry(this.state.playlist[currentIndex + 1], {
            updateSelection: true
        });
    }

    async playPreviousTrack() {
        const currentIndex = this.currentPlaybackIndex();
        if (currentIndex <= 0) {
            return;
        }

        await this.activateEntry(this.state.playlist[currentIndex - 1], {
            updateSelection: true
        });
    }

    movePlaylistItem(fromIndex: number, toIndex: number) {
        if (fromIndex === toIndex) {
            return;
        }

        const playlist = [...this.state.playlist];
        const [moved] = playlist.splice(fromIndex, 1);
        if (!moved) {
            return;
        }

        const safeTargetIndex = Math.min(Math.max(0, toIndex), playlist.length);
        playlist.splice(safeTargetIndex, 0, moved);

        const activeId = this.state.currentTrack?.id ?? this.state.playlist[this.state.activeIndex]?.id ?? null;
        const activeIndex = activeId ? playlist.findIndex(entry => entry.id === activeId) : -1;
        this.updatePlaylist(playlist, activeIndex);
    }

    removePlaylistItem(index: number) {
        const playlist = this.state.playlist.filter((_, itemIndex) => itemIndex !== index);
        let activeIndex = this.state.activeIndex;

        if (index === this.state.activeIndex) {
            this.player.stop();
            activeIndex = playlist.length === 0 ? -1 : Math.min(index, playlist.length - 1);
            this.state = {
                ...this.state,
                currentTrack: null,
                metadata: null,
                transport: playlist.length === 0 ? "idle" : "stopped",
                playback: this.player.getPlaybackState(),
                currentPattern: null,
                error: null
            };
        } else if (index < this.state.activeIndex) {
            activeIndex -= 1;
        }

        this.updatePlaylist(playlist, activeIndex);
    }

    private currentPlaylistEntry() {
        return this.state.playlist[this.state.activeIndex] ?? null;
    }

    private currentPlaybackIndex() {
        const currentId = this.state.currentTrack?.id;
        if (!currentId) {
            return this.state.activeIndex;
        }

        return this.state.playlist.findIndex(entry => entry.id === currentId);
    }

    private async activateEntry(
        entry: PlaylistEntry,
        options: { updateSelection: boolean }
    ) {
        const entryIndex = this.state.playlist.findIndex(item => item.id === entry.id);
        if (options.updateSelection) {
            this.updateState({
                activeIndex: entryIndex,
                error: null
            });
        }

        if (entry.available) {
            await this.loadTrack(entry, true);
            return;
        }

        this.updateState({
            currentTrack: null,
            metadata: null,
            transport: "error",
            currentPattern: null,
            error: "This local file is unavailable after reload. Re-add it to play again."
        });
    }

    private updatePlaylist(playlist: PlaylistEntry[], activeIndex = this.state.activeIndex) {
        this.state = {
            ...this.state,
            playlist,
            activeIndex
        };
        this.persistPlaylist();
        this.emit();
    }

    private updateState(patch: Partial<PlayerControllerState>) {
        this.state = {
            ...this.state,
            ...patch
        };
        this.emit();
    }

    private emit() {
        const snapshot = this.cloneState();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    private cloneState(): PlayerControllerState {
        return {
            ...this.state,
            playlist: this.state.playlist.map(entry => ({ ...entry })),
            currentTrack: this.state.currentTrack ? { ...this.state.currentTrack } : null,
            metadata: this.state.metadata ? { ...this.state.metadata } : null,
            playback: {
                ...this.state.playback,
                channels: this.state.playback.channels.map(channel => ({ ...channel }))
            },
            currentPattern: this.state.currentPattern ? {
                ...this.state.currentPattern,
                rows: this.state.currentPattern.rows.map(row => ({
                    ...row,
                    channels: row.channels.map(channel => ({ ...channel }))
                }))
            } : null
        };
    }

    private createId() {
        return `track-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    private nameFromUrl(url: string) {
        const value = url.split("/").pop() || url;
        return value || "Remote MOD";
    }

    private persistPlaylist() {
        const serialized: PersistedPlaylistEntry[] = this.state.playlist.map(entry => ({
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            source: entry.source,
            available: entry.kind === "url"
        }));

        localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(serialized));
    }

    private loadPersistedPlaylist(): PlaylistEntry[] {
        const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY);
        if (!raw) {
            return [];
        }

        try {
            const parsed = JSON.parse(raw) as PersistedPlaylistEntry[];
            return parsed.map(entry => ({
                ...entry,
                available: entry.kind === "url"
            }));
        } catch {
            return [];
        }
    }
}
