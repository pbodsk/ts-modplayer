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

const transportStateEl = requireElement<HTMLElement>(app, '[data-role="transport-state"]');
const statusMessageEl = requireElement<HTMLElement>(app, '[data-role="status-message"]');
const trackTitleEl = requireElement<HTMLElement>(app, '[data-role="track-title"]');
const trackMetaEl = requireElement<HTMLElement>(app, '[data-role="track-meta"]');
const previousButton = requireElement<HTMLButtonElement>(app, '[data-action="previous"]');
const previousIconEl = requireElement<HTMLElement>(app, '[data-role="previous-icon"]');
const playPauseButton = requireElement<HTMLButtonElement>(app, '[data-action="play-pause"]');
const playPauseIconEl = requireElement<HTMLElement>(app, '[data-role="play-pause-icon"]');
const stopButton = requireElement<HTMLButtonElement>(app, '[data-action="stop"]');
const stopIconEl = requireElement<HTMLElement>(app, '[data-role="stop-icon"]');
const nextButton = requireElement<HTMLButtonElement>(app, '[data-action="next"]');
const nextIconEl = requireElement<HTMLElement>(app, '[data-role="next-icon"]');
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
const playlistEmptyTemplate = requireTemplate("playlist-empty-template");
const playlistItemTemplate = requireTemplate("playlist-item-template");
const trackerEmptyTemplate = requireTemplate("tracker-empty-template");
const trackerFrameTemplate = requireTemplate("tracker-frame-template");
const trackerRowTemplate = requireTemplate("tracker-row-template");
const trackerBlankRowTemplate = requireTemplate("tracker-blank-row-template");

previousIconEl.innerHTML = icons.previous;
playPauseIconEl.innerHTML = icons.play;
stopIconEl.innerHTML = icons.stop;
nextIconEl.innerHTML = icons.next;

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
        ? `Position ${state.currentPattern.position} • Pattern ${state.currentPattern.patternIndex} • Row ${state.playback.rowIndex}`
        : `Position ${state.playback.position} • Pattern -- • Row ${state.playback.rowIndex}`;
    renderTracker(state);

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
        trackerEl.replaceChildren(cloneTemplateRoot(trackerEmptyTemplate));
        return;
    }

    const frame = cloneTemplateRoot<HTMLElement>(trackerFrameTemplate);
    const body = requireElement<HTMLElement>(frame, '[data-role="tracker-body"]');

    for (let offset = -TRACKER_CONTEXT_ROWS; offset <= TRACKER_CONTEXT_ROWS; offset += 1) {
        const targetRowIndex = state.playback.rowIndex + offset;
        const row = state.currentPattern.rows[targetRowIndex];
        const active = offset === 0;

        if (!row) {
            body.append(createBlankTrackerRow(active));
            continue;
        }

        body.append(createTrackerRow(row, active));
    }

    trackerEl.replaceChildren(frame);
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

    if (state.playlist.length === 0) {
        playlistEl.replaceChildren(cloneTemplateRoot(playlistEmptyTemplate));
        return;
    }

    const fragment = document.createDocumentFragment();

    state.playlist.forEach((entry, index) => {
        const item = cloneTemplateRoot<HTMLElement>(playlistItemTemplate);
        const selectButton = requireElement<HTMLButtonElement>(item, '[data-action="select-track"]');
        const removeButton = requireElement<HTMLButtonElement>(item, '[data-action="remove-track"]');
        const nameEl = requireElement<HTMLElement>(item, '[data-role="playlist-item-name"]');
        const metaEl = requireElement<HTMLElement>(item, '[data-role="playlist-item-meta"]');

        item.dataset.playlistIndex = String(index);
        item.classList.toggle("playlist-item--active", index === state.activeIndex);
        item.classList.toggle("playlist-item--disabled", !entry.available);
        selectButton.dataset.index = String(index);
        removeButton.dataset.index = String(index);
        removeButton.setAttribute("aria-label", `Remove ${entry.name}`);
        nameEl.textContent = entry.name;
        metaEl.textContent = `${entry.kind === "local" ? "Local file" : "Remote URL"}${!entry.available ? " • Re-add required" : ""}`;

        fragment.append(item);
    });

    playlistEl.replaceChildren(fragment);

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

function createTrackerRow(row: NonNullable<PlayerControllerState["currentPattern"]>["rows"][number], active: boolean) {
    const element = cloneTemplateRoot<HTMLElement>(trackerRowTemplate);
    const rowIndexEl = requireElement<HTMLElement>(element, '[data-role="tracker-row-index"]');
    const cells = element.querySelectorAll<HTMLElement>('[data-role="tracker-cell"]');

    element.classList.toggle("tracker__row--active", active);
    rowIndexEl.textContent = String(row.rowIndex);

    row.channels.forEach((channel, index) => {
        const cell = cells[index];
        if (!cell) {
            return;
        }

        cell.textContent = `${channel.note} ${channel.sample} ${channel.effect}`;
    });

    return element;
}

function createBlankTrackerRow(active: boolean) {
    const element = cloneTemplateRoot<HTMLElement>(trackerBlankRowTemplate);
    element.classList.toggle("tracker__row--active", active);
    return element;
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

function requireTemplate(id: string) {
    const template = document.getElementById(id);
    if (!(template instanceof HTMLTemplateElement)) {
        throw new Error(`Missing required template: ${id}`);
    }

    return template;
}

function cloneTemplateRoot<T extends Element>(template: HTMLTemplateElement) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const element = fragment.firstElementChild;
    if (!element) {
        throw new Error(`Template has no root element: ${template.id}`);
    }

    return element as T;
}
