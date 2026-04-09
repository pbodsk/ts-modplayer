import "./styles.css";
import { PlayerController, type PlayerControllerState } from "./player-controller";

const app = document.getElementById("app");

if (!app) {
    throw new Error("Missing app root element.");
}

const controller = new PlayerController();
const TRACKER_CONTEXT_ROWS = 16;
let playlistRenderKey = "";
let draggedPlaylistIndex: number | null = null;

const icons = {
    play: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-play-icon lucide-play"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>`,
    pause: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pause-icon lucide-pause"><rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/></svg>`,
    stop: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-square-icon lucide-square"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>`,
    next: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-skip-forward-icon lucide-skip-forward"><path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/></svg>`,
    previous: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-skip-back-icon lucide-skip-back"><path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"/><path d="M3 20V4"/></svg>`
}

app.innerHTML = `
    <main class="shell">
        <section class="hero">
            <div class="hero__copy">
                <p class="eyebrow">Browser tracker deck</p>
                <h1>MOD Player</h1>
                <p class="lede">Play classic MODs, inspect all four channels live, and build a playlist from local files or direct download URLs.</p>
            </div>
            <div class="hero__status">
                <span class="status-pill" data-role="transport-state">Idle</span>
                <p class="status-message" data-role="status-message">Load a MOD to begin.</p>
            </div>
        </section>

        <section class="panel transport">
            <div class="transport__top">
                <div>
                    <p class="section-label">Now Playing</p>
                    <h2 data-role="track-title">No track selected</h2>
                    <p class="transport__meta" data-role="track-meta">Choose a local file or add a direct MOD URL.</p>
                </div>
                <div class="transport__buttons">
                    <button type="button" data-action="previous" class="button-secondary">
                        <span class="button-icon">${icons.previous}</span>
                    </button>
                    <button type="button" data-action="play-pause">
                        <span class="button-icon" data-role="play-pause-icon">${icons.play}</span>
                    </button>
                    <button type="button" data-action="stop" class="button-secondary">
                        <span class="button-icon">${icons.stop}</span>
                    </button>
                    <button type="button" data-action="next" class="button-secondary">
                        <span class="button-icon">${icons.next}</span>
                    </button>
                </div>
            </div>

            <div class="transport__controls">
                <label class="range-field">
                    <span>Song position</span>
                    <input type="range" min="0" max="0" value="0" step="1" data-role="scrubber">
                    <small data-role="scrubber-label">Position 0, row 0</small>
                </label>

                <label class="range-field range-field--volume">
                    <span>Master volume</span>
                    <input type="range" min="0" max="100" value="100" step="1" data-role="volume">
                    <small data-role="volume-label">100%</small>
                </label>
            </div>
        </section>

        <section class="stack">
            <section class="panel panel--playlist">
                <div class="panel__header">
                    <div>
                        <p class="section-label">Playlist</p>
                        <h2>Queue</h2>
                    </div>
                    <p class="panel__caption" data-role="playlist-count">0 tracks</p>
                </div>

                <div class="playlist-actions">
                    <label class="file-picker">
                        <span>Add local files</span>
                        <input type="file" accept=".mod,audio/mod" multiple data-role="file-input">
                    </label>

                    <form class="url-form" data-role="url-form">
                        <input type="url" placeholder="https://..." data-role="url-input" required>
                        <button type="submit">Add URL</button>
                    </form>
                </div>

                <div class="playlist" data-role="playlist"></div>
            </section>

            <section class="panel">
                <div class="panel__header">
                    <div>
                        <p class="section-label">Pattern View</p>
                        <h2>Live Tracker Grid</h2>
                    </div>
                    <p class="panel__caption" data-role="position-label">Position 00 • Pattern 00 • Row 00</p>
                </div>
                <div class="tracker" data-role="tracker"></div>
            </section>
        </section>
    </main>
`;

const transportStateEl = requireElement<HTMLElement>(app, '[data-role="transport-state"]');
const statusMessageEl = requireElement<HTMLElement>(app, '[data-role="status-message"]');
const trackTitleEl = requireElement<HTMLElement>(app, '[data-role="track-title"]');
const trackMetaEl = requireElement<HTMLElement>(app, '[data-role="track-meta"]');
const previousButton = requireElement<HTMLButtonElement>(app, '[data-action="previous"]');
const playPauseButton = requireElement<HTMLButtonElement>(app, '[data-action="play-pause"]');
const playPauseIconEl = requireElement<HTMLElement>(app, '[data-role="play-pause-icon"]');
const stopButton = requireElement<HTMLButtonElement>(app, '[data-action="stop"]');
const nextButton = requireElement<HTMLButtonElement>(app, '[data-action="next"]');
const scrubber = requireElement<HTMLInputElement>(app, '[data-role="scrubber"]');
const scrubberLabel = requireElement<HTMLElement>(app, '[data-role="scrubber-label"]');
const volumeInput = requireElement<HTMLInputElement>(app, '[data-role="volume"]');
const volumeLabel = requireElement<HTMLElement>(app, '[data-role="volume-label"]');
const positionLabel = requireElement<HTMLElement>(app, '[data-role="position-label"]');
const trackerEl = requireElement<HTMLElement>(app, '[data-role="tracker"]');
const playlistCountEl = requireElement<HTMLElement>(app, '[data-role="playlist-count"]');
const playlistEl = requireElement<HTMLElement>(app, '[data-role="playlist"]');
const fileInput = requireElement<HTMLInputElement>(app, '[data-role="file-input"]');
const urlForm = requireElement<HTMLFormElement>(app, '[data-role="url-form"]');
const urlInput = requireElement<HTMLInputElement>(app, '[data-role="url-input"]');

previousButton.addEventListener("click", async () => {
    await controller.playPreviousTrack();
});

playPauseButton.addEventListener("click", async () => {
    const { transport } = controller.getState();
    if (transport === "playing") {
        controller.pause();
        return;
    }

    await controller.play();
});

stopButton.addEventListener("click", () => {
    controller.stop();
});

nextButton.addEventListener("click", async () => {
    await controller.playNextTrack();
});

volumeInput.addEventListener("input", () => {
    controller.setMasterVolume(Number(volumeInput.value) / 100);
});

scrubber.addEventListener("change", () => {
    const value = Number(scrubber.value);
    controller.seekToRow(Math.floor(value / 64), value % 64);
});

fileInput.addEventListener("change", async () => {
    if (!fileInput.files || fileInput.files.length === 0) {
        return;
    }

    await controller.addLocalFiles(fileInput.files);
    fileInput.value = "";
});

urlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = urlInput.value.trim();
    if (!value) {
        return;
    }

    await controller.addUrl(value);
    urlInput.value = "";
});

controller.subscribe((state) => {
    renderState(state);
});

function renderState(state: PlayerControllerState) {
    transportStateEl.textContent = capitalize(state.transport);
    transportStateEl.dataset.state = state.transport;
    statusMessageEl.textContent = state.error ?? statusMessage(state);

    const title = state.metadata?.title || state.currentTrack?.name || "No track selected";
    trackTitleEl.textContent = title;
    trackMetaEl.textContent = buildMetaLabel(state);

    previousButton.disabled = !controller.canGoPrevious();
    playPauseIconEl.innerHTML = state.transport === "playing" ? icons.pause : icons.play;
    playPauseButton.disabled = state.playlist.length === 0;
    stopButton.disabled = state.transport === "idle" || state.transport === "loading";
    nextButton.disabled = !controller.canGoNext();

    const totalRows = Math.max(0, ((state.metadata?.totalPositions ?? 1) * 64) - 1);
    const scrubValue = (state.playback.position * 64) + state.playback.rowIndex;
    scrubber.max = String(totalRows);
    scrubber.value = String(Math.min(scrubValue, totalRows));
    scrubber.disabled = !state.metadata;
    scrubberLabel.textContent = `Position ${state.playback.position}, row ${state.playback.rowIndex}`;

    volumeInput.value = String(Math.round(state.masterVolume * 100));
    volumeLabel.textContent = `${Math.round(state.masterVolume * 100)}%`;

    positionLabel.textContent = state.currentPattern
        ? `Position ${formatHex(state.currentPattern.position)} • Pattern ${formatHex(state.currentPattern.patternIndex)} • Row ${formatHex(state.playback.rowIndex)}`
        : `Position ${formatHex(state.playback.position)} • Pattern -- • Row ${formatHex(state.playback.rowIndex)}`;
    trackerEl.innerHTML = renderTracker(state);

    renderPlaylist(state);

}

function statusMessage(state: PlayerControllerState) {
    switch (state.transport) {
        case "idle":
            return "Load a MOD to begin.";
        case "loading":
            return "Loading track into the player.";
        case "playing":
            return "Playback is running.";
        case "paused":
            return "Playback is paused at the current row.";
        case "stopped":
            return "Playback is stopped and ready to restart.";
        case "error":
            return "The player hit an error.";
    }
}

function buildMetaLabel(state: PlayerControllerState) {
    if (!state.metadata) {
        return "Choose a local file or add a direct MOD URL.";
    }

    return `${state.metadata.instrumentCount} instruments • ${state.metadata.totalPositions} positions • ${state.metadata.patternCount} patterns`;
}

function renderTracker(state: PlayerControllerState) {
    if (!state.currentPattern) {
        return `<p class="tracker__empty">Load a MOD to see its active pattern rendered tracker-style.</p>`;
    }

    const header = `
        <div class="tracker__row tracker__row--header">
            <span class="tracker__gutter">Row</span>
            <span class="tracker__channel-heading">Channel 1</span>
            <span class="tracker__channel-heading">Channel 2</span>
            <span class="tracker__channel-heading">Channel 3</span>
            <span class="tracker__channel-heading">Channel 4</span>
        </div>
    `;

    const rows: string[] = [];

    for (let offset = -TRACKER_CONTEXT_ROWS; offset <= TRACKER_CONTEXT_ROWS; offset += 1) {
        const targetRowIndex = state.playback.rowIndex + offset;
        const row = state.currentPattern.rows[targetRowIndex];
        const active = offset === 0;

        if (!row) {
            rows.push(`
                <div class="tracker__row tracker__row--blank ${active ? "tracker__row--active" : ""}">
                    <span class="tracker__gutter">..</span>
                    <span class="tracker__cell tracker__cell--blank">... .. ...</span>
                    <span class="tracker__cell tracker__cell--blank">... .. ...</span>
                    <span class="tracker__cell tracker__cell--blank">... .. ...</span>
                    <span class="tracker__cell tracker__cell--blank">... .. ...</span>
                </div>
            `);
            continue;
        }

        rows.push(`
            <div class="tracker__row ${active ? "tracker__row--active" : ""}">
                <span class="tracker__gutter">${formatHex(row.rowIndex)}</span>
                ${row.channels.map(channel => `<span class="tracker__cell">${channel.note} ${channel.sample} ${channel.effect}</span>`).join("")}
            </div>
        `);
    }

    return `
        <div class="tracker__frame">
            ${header}
            <div class="tracker__body">
                ${rows.join("")}
            </div>
        </div>
    `;
}

function renderPlaylist(state: PlayerControllerState) {
    playlistCountEl.textContent = `${state.playlist.length} ${state.playlist.length === 1 ? "track" : "tracks"}`;

    const nextRenderKey = [
        state.activeIndex,
        ...state.playlist.map(entry => `${entry.id}:${entry.name}:${entry.available}:${entry.kind}`)
    ].join("|");

    if (nextRenderKey === playlistRenderKey) {
        return;
    }

    playlistRenderKey = nextRenderKey;

    playlistEl.innerHTML = state.playlist.length === 0
        ? `<p class="playlist__empty">No tracks yet. Add a local MOD or direct URL to start building the queue.</p>`
        : state.playlist.map((entry, index) => `
            <article class="playlist-item ${index === state.activeIndex ? "playlist-item--active" : ""} ${!entry.available ? "playlist-item--disabled" : ""}" draggable="true" data-playlist-index="${index}">
                <button type="button" class="playlist-item__select" data-action="select-track" data-index="${index}">
                    <span class="playlist-item__name">${entry.name}</span>
                    <span class="playlist-item__meta">${entry.kind === "local" ? "Local file" : "Remote URL"}${!entry.available ? " • Re-add required" : ""}</span>
                </button>
                <button type="button" class="playlist-item__remove" data-action="remove-track" data-index="${index}" aria-label="Remove ${entry.name}">Remove</button>
            </article>
        `).join("");

    playlistEl.querySelectorAll<HTMLButtonElement>('[data-action="select-track"]').forEach(button => {
        button.addEventListener("click", async () => {
            await controller.selectPlaylistItem(Number(button.dataset.index));
        });
    });

    playlistEl.querySelectorAll<HTMLButtonElement>('[data-action="remove-track"]').forEach(button => {
        button.addEventListener("click", () => {
            controller.removePlaylistItem(Number(button.dataset.index));
        });
    });

    playlistEl.querySelectorAll<HTMLElement>("[data-playlist-index]").forEach(item => {
        item.addEventListener("dragstart", (event) => {
            draggedPlaylistIndex = Number(item.dataset.playlistIndex);
            item.classList.add("playlist-item--dragging");
            event.dataTransfer?.setData("text/plain", String(draggedPlaylistIndex));
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
            }
        });

        item.addEventListener("dragend", () => {
            draggedPlaylistIndex = null;
            item.classList.remove("playlist-item--dragging");
            playlistEl.querySelectorAll(".playlist-item--drop-target").forEach(target => {
                target.classList.remove("playlist-item--drop-target");
            });
        });

        item.addEventListener("dragover", (event) => {
            event.preventDefault();
            if (draggedPlaylistIndex === null) {
                return;
            }

            playlistEl.querySelectorAll(".playlist-item--drop-target").forEach(target => {
                target.classList.remove("playlist-item--drop-target");
            });
            item.classList.add("playlist-item--drop-target");
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = "move";
            }
        });

        item.addEventListener("dragleave", () => {
            item.classList.remove("playlist-item--drop-target");
        });

        item.addEventListener("drop", (event) => {
            event.preventDefault();
            item.classList.remove("playlist-item--drop-target");
            if (draggedPlaylistIndex === null) {
                return;
            }

            const toIndex = Number(item.dataset.playlistIndex);
            controller.movePlaylistItem(draggedPlaylistIndex, toIndex);
            draggedPlaylistIndex = null;
        });
    });
}

function capitalize(value: string) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatHex(value: number) {
    return value.toString(16).toUpperCase().padStart(2, "0");
}

function requireElement<T extends Element>(parent: ParentNode, selector: string) {
    const element = parent.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Missing required UI element: ${selector}`);
    }

    return element;
}
