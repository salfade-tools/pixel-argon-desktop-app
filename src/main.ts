import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ImageInfo {
  width: number;
  height: number;
  data_url: string;
}

interface PixelateStroke {
  points: [number, number][];
  radius: number;
}

interface AppState {
  sourcePath: string | null;
  imageWidth: number;
  imageHeight: number;
  tool: "select" | "crop" | "pixelate" | "eyedropper";

  // View
  zoom: number;
  panX: number;
  panY: number;

  // Crop (normalized 0..1)
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;

  // Target size
  targetWidth: number;
  targetHeight: number;
  lockAspect: boolean;
  scaleMode: string;

  // Edits
  grayscale: boolean;
  brightness: number;
  contrast: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;

  // Pixelate
  pixelateStrokes: PixelateStroke[];
  pixelateRedoStack: PixelateStroke[];
  pixelateBrushSize: number;
  pixelateBlockSize: number;
  isPixelatePainting: boolean;
  currentStroke: PixelateStroke | null;

  // Background removal
  bgEnabled: boolean;
  bgColor: [number, number, number];
  bgTolerance: number;
}

// ─── State ───────────────────────────────────────────────────────────────────

const state: AppState = {
  sourcePath: null,
  imageWidth: 0,
  imageHeight: 0,
  tool: "select",
  zoom: 1,
  panX: 0,
  panY: 0,
  cropX: 0.1,
  cropY: 0.1,
  cropW: 0.8,
  cropH: 0.8,
  targetWidth: 800,
  targetHeight: 600,
  lockAspect: false,
  scaleMode: "scale_then_crop",
  grayscale: false,
  brightness: 0,
  contrast: 0,
  rotation: 0,
  flipH: false,
  flipV: false,
  pixelateStrokes: [],
  pixelateRedoStack: [],
  pixelateBrushSize: 20,
  pixelateBlockSize: 10,
  isPixelatePainting: false,
  currentStroke: null,
  bgEnabled: false,
  bgColor: [0, 0, 0],
  bgTolerance: 30,
};

let loadedImage: HTMLImageElement | null = null;

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

function initApp() {
  // Tool buttons
  document.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tool = btn.dataset.tool as AppState["tool"];
      setTool(tool);
    });
  });

  // Theme toggle
  initTheme();
  $("btn-theme").addEventListener("click", toggleTheme);

  // Open / Export
  $("btn-open").addEventListener("click", openFile);
  $("btn-export").addEventListener("click", showExportModal);

  // Recents
  $("btn-recents").addEventListener("click", showRecentsModal);
  $("btn-recents-close").addEventListener("click", () => {
    $("recents-modal").style.display = "none";
  });

  // Update
  $("btn-update").addEventListener("click", showUpdateModal);
  $("btn-update-close").addEventListener("click", () => {
    $("update-modal").style.display = "none";
  });

  // Crop controls
  $("crop-preset").addEventListener("change", onCropPresetChange);
  $("crop-width").addEventListener("change", onCropSizeChange);
  $("crop-height").addEventListener("change", onCropSizeChange);
  $("lock-aspect").addEventListener("change", () => {
    state.lockAspect = ($("lock-aspect") as HTMLInputElement).checked;
  });
  $("scale-mode").addEventListener("change", () => {
    state.scaleMode = ($("scale-mode") as HTMLSelectElement).value;
  });

  // Edit controls
  $("edit-grayscale").addEventListener("change", () => {
    state.grayscale = ($("edit-grayscale") as HTMLInputElement).checked;
    renderCanvas();
  });
  $("edit-brightness").addEventListener("input", () => {
    const v = parseInt(($("edit-brightness") as HTMLInputElement).value);
    state.brightness = v / 100;
    $("brightness-val").textContent = String(v);
    renderCanvas();
  });
  $("edit-contrast").addEventListener("input", () => {
    const v = parseInt(($("edit-contrast") as HTMLInputElement).value);
    state.contrast = v / 100;
    $("contrast-val").textContent = String(v);
    renderCanvas();
  });
  $("btn-rotate-left").addEventListener("click", () => {
    state.rotation = (state.rotation - 90 + 360) % 360;
    renderCanvas();
  });
  $("btn-rotate-right").addEventListener("click", () => {
    state.rotation = (state.rotation + 90) % 360;
    renderCanvas();
  });
  $("btn-flip-h").addEventListener("click", () => {
    state.flipH = !state.flipH;
    renderCanvas();
  });
  $("btn-flip-v").addEventListener("click", () => {
    state.flipV = !state.flipV;
    renderCanvas();
  });

  // Apply button
  $("btn-apply").addEventListener("click", applyEdits);

  // Pixelate controls
  $("pixelate-size").addEventListener("input", () => {
    state.pixelateBrushSize = parseInt(
      ($("pixelate-size") as HTMLInputElement).value
    );
    $("pixelate-size-val").textContent = String(state.pixelateBrushSize);
  });
  $("pixelate-block").addEventListener("input", () => {
    state.pixelateBlockSize = parseInt(
      ($("pixelate-block") as HTMLInputElement).value
    );
    $("pixelate-block-val").textContent = String(state.pixelateBlockSize);
  });
  $("btn-undo-stroke").addEventListener("click", undoStroke);
  $("btn-redo-stroke").addEventListener("click", redoStroke);

  // BG removal
  $("bg-enabled").addEventListener("change", () => {
    state.bgEnabled = ($("bg-enabled") as HTMLInputElement).checked;
  });
  $("bg-tolerance").addEventListener("input", () => {
    state.bgTolerance = parseInt(
      ($("bg-tolerance") as HTMLInputElement).value
    );
    $("bg-tolerance-val").textContent = String(state.bgTolerance);
  });

  // Export modal
  $("btn-export-cancel").addEventListener("click", () => {
    $("export-modal").style.display = "none";
  });
  $("btn-export-confirm").addEventListener("click", doExport);
  $("export-format").addEventListener("change", () => {
    const fmt = ($("export-format") as HTMLSelectElement).value;
    $("jpeg-quality-field").style.display = fmt === "jpeg" ? "block" : "none";
  });
  $("jpeg-quality").addEventListener("input", () => {
    $("jpeg-quality-val").textContent = ($("jpeg-quality") as HTMLInputElement).value;
  });

  // Zoom controls
  $("btn-fit").addEventListener("click", zoomFit);
  $("btn-100").addEventListener("click", () => setZoom(1));
  $("btn-zoom-in").addEventListener("click", () =>
    setZoom(state.zoom * 1.25)
  );
  $("btn-zoom-out").addEventListener("click", () =>
    setZoom(state.zoom / 1.25)
  );
  $("zoom-slider").addEventListener("input", () => {
    setZoom(parseInt(($("zoom-slider") as HTMLInputElement).value) / 100);
  });

  // Canvas interaction
  const container = $("canvas-container");
  container.addEventListener("mousedown", onCanvasMouseDown);
  container.addEventListener("mousemove", onCanvasMouseMove);
  container.addEventListener("mouseup", onCanvasMouseUp);
  container.addEventListener("mouseleave", onCanvasMouseUp);
  container.addEventListener("wheel", onCanvasWheel, { passive: false });

  // Drop zone (Tauri native drag-and-drop)
  const dropZone = $("drop-zone");
  const appWindow = getCurrentWebviewWindow();
  appWindow.onDragDropEvent((event) => {
    if (event.payload.type === "over") {
      dropZone.classList.add("drag-over");
    } else if (event.payload.type === "drop") {
      dropZone.classList.remove("drag-over");
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        const ext = paths[0].split(".").pop()?.toLowerCase();
        if (["png", "jpg", "jpeg", "webp"].includes(ext || "")) {
          loadImage(paths[0]);
        }
      }
    } else {
      dropZone.classList.remove("drag-over");
    }
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", onKeyDown);
}

// ─── Tools ───────────────────────────────────────────────────────────────────

function setTool(tool: AppState["tool"]) {
  state.tool = tool;
  document.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });

  $("crop-panel").style.display = tool === "crop" ? "block" : "none";
  $("pixelate-panel").style.display = tool === "pixelate" ? "block" : "none";
  $("crop-overlay").style.display = tool === "crop" && loadedImage ? "block" : "none";

  const container = $("canvas-container");
  if (tool === "pixelate") {
    container.style.cursor = "crosshair";
  } else if (tool === "eyedropper") {
    container.style.cursor = "crosshair";
  } else if (tool === "crop") {
    container.style.cursor = "default";
  } else {
    container.style.cursor = "grab";
  }

  if (tool === "crop") updateCropOverlay();
}

// ─── File Operations ─────────────────────────────────────────────────────────

async function openFile() {
  const path = await dialogOpen({
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
    ],
    multiple: false,
    directory: false,
  });
  if (path) {
    await loadImage(path as string);
  }
}

async function loadImage(path: string) {
  try {
    const info: ImageInfo = await invoke("open_image", { path });
    state.sourcePath = path;
    state.imageWidth = info.width;
    state.imageHeight = info.height;
    state.rotation = 0;
    state.flipH = false;
    state.flipV = false;
    state.grayscale = false;
    state.brightness = 0;
    state.contrast = 0;
    state.pixelateStrokes = [];
    state.pixelateRedoStack = [];
    state.cropX = 0;
    state.cropY = 0;
    state.cropW = 1;
    state.cropH = 1;
    state.targetWidth = info.width;
    state.targetHeight = info.height;

    ($("edit-brightness") as HTMLInputElement).value = "0";
    ($("edit-contrast") as HTMLInputElement).value = "0";
    ($("edit-grayscale") as HTMLInputElement).checked = false;
    $("brightness-val").textContent = "0";
    $("contrast-val").textContent = "0";
    ($("crop-width") as HTMLInputElement).value = String(info.width);
    ($("crop-height") as HTMLInputElement).value = String(info.height);

    const img = new Image();
    img.onload = () => {
      loadedImage = img;
      $("drop-zone").classList.add("hidden");
      ($("btn-export") as HTMLButtonElement).disabled = false;
      $("image-info").textContent = `${info.width} × ${info.height} — ${path.split("/").pop() || path.split("\\").pop()}`;
      zoomFit();
      renderCanvas();
      if (state.tool === "crop") {
        $("crop-overlay").style.display = "block";
        updateCropOverlay();
      }
    };
    img.src = info.data_url;

    // Update recents
    addToRecents(path);
  } catch (e: any) {
    showToast("Failed to open image: " + e, "error");
  }
}

async function addToRecents(path: string) {
  try {
    let files: string[] = await invoke("get_recent_files");
    files = files.filter((f) => f !== path);
    files.unshift(path);
    if (files.length > 10) files = files.slice(0, 10);
    await invoke("set_recent_files", { files });
  } catch (_) {}
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderCanvas() {
  if (!loadedImage) return;

  const canvas = $("main-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;

  const w = state.imageWidth;
  const h = state.imageHeight;

  // Account for rotation
  const isRotated = state.rotation === 90 || state.rotation === 270;
  const dw = isRotated ? h : w;
  const dh = isRotated ? w : h;

  canvas.width = dw;
  canvas.height = dh;

  ctx.clearRect(0, 0, dw, dh);
  ctx.save();

  // Apply transforms
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate((state.rotation * Math.PI) / 180);
  if (state.flipH) ctx.scale(-1, 1);
  if (state.flipV) ctx.scale(1, -1);

  // Build filter string
  let filter = "";
  if (state.grayscale) filter += "grayscale(1) ";
  if (state.brightness !== 0)
    filter += `brightness(${1 + state.brightness}) `;
  if (state.contrast !== 0) filter += `contrast(${1 + state.contrast}) `;
  ctx.filter = filter.trim() || "none";

  ctx.drawImage(loadedImage, -w / 2, -h / 2, w, h);
  ctx.restore();

  // Draw pixelate strokes preview
  if (state.pixelateStrokes.length > 0) {
    drawPixelatePreview(ctx, dw, dh);
  }

  // Position canvas
  const container = $("canvas-container");
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const scale = state.zoom;

  canvas.style.width = dw * scale + "px";
  canvas.style.height = dh * scale + "px";
  canvas.style.left = cw / 2 + state.panX - (dw * scale) / 2 + "px";
  canvas.style.top = ch / 2 + state.panY - (dh * scale) / 2 + "px";
}

function drawPixelatePreview(ctx: CanvasRenderingContext2D, dw: number, dh: number) {
  const blockSize = state.pixelateBlockSize;
  const imageData = ctx.getImageData(0, 0, dw, dh);
  const data = imageData.data;

  for (const stroke of state.pixelateStrokes) {
    for (const [nx, ny] of stroke.points) {
      const cx = Math.round(nx * dw);
      const cy = Math.round(ny * dh);
      const r = Math.round(stroke.radius * Math.max(dw, dh));

      const x1 = Math.max(0, cx - r);
      const y1 = Math.max(0, cy - r);
      const x2 = Math.min(dw, cx + r);
      const y2 = Math.min(dh, cy + r);

      for (let bx = x1; bx < x2; bx += blockSize) {
        for (let by = y1; by < y2; by += blockSize) {
          const bx2 = Math.min(bx + blockSize, x2);
          const by2 = Math.min(by + blockSize, y2);
          let rr = 0, gg = 0, bb = 0, aa = 0, count = 0;
          for (let py = by; py < by2; py++) {
            for (let px = bx; px < bx2; px++) {
              const idx = (py * dw + px) * 4;
              rr += data[idx];
              gg += data[idx + 1];
              bb += data[idx + 2];
              aa += data[idx + 3];
              count++;
            }
          }
          if (count > 0) {
            rr = Math.round(rr / count);
            gg = Math.round(gg / count);
            bb = Math.round(bb / count);
            aa = Math.round(aa / count);
            for (let py = by; py < by2; py++) {
              for (let px = bx; px < bx2; px++) {
                const idx = (py * dw + px) * 4;
                data[idx] = rr;
                data[idx + 1] = gg;
                data[idx + 2] = bb;
                data[idx + 3] = aa;
              }
            }
          }
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ─── Zoom & Pan ──────────────────────────────────────────────────────────────

function setZoom(z: number) {
  state.zoom = Math.max(0.1, Math.min(5, z));
  ($("zoom-slider") as HTMLInputElement).value = String(
    Math.round(state.zoom * 100)
  );
  $("zoom-label").textContent = Math.round(state.zoom * 100) + "%";
  renderCanvas();
  if (state.tool === "crop") updateCropOverlay();
}

function zoomFit() {
  if (!loadedImage) return;
  const container = $("canvas-container");
  const cw = container.clientWidth;
  const ch = container.clientHeight;

  const isRotated = state.rotation === 90 || state.rotation === 270;
  const iw = isRotated ? state.imageHeight : state.imageWidth;
  const ih = isRotated ? state.imageWidth : state.imageHeight;

  const scale = Math.min((cw - 40) / iw, (ch - 40) / ih, 1);
  state.panX = 0;
  state.panY = 0;
  setZoom(scale);
}

// ─── Canvas Mouse Interaction ────────────────────────────────────────────────

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;

// Crop dragging
let cropDragMode: string | null = null;
let cropStartX = 0;
let cropStartY = 0;
let cropStartCropX = 0;
let cropStartCropY = 0;
let cropStartCropW = 0;
let cropStartCropH = 0;

function getCanvasCoords(e: MouseEvent): [number, number] {
  const canvas = $("main-canvas") as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const isRotated = state.rotation === 90 || state.rotation === 270;
  const dw = isRotated ? state.imageHeight : state.imageWidth;
  const dh = isRotated ? state.imageWidth : state.imageHeight;
  const scaleX = dw / rect.width;
  const scaleY = dh / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  return [x / dw, y / dh]; // normalized
}

function onCanvasMouseDown(e: MouseEvent) {
  if (!loadedImage) return;

  if (state.tool === "select") {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = state.panX;
    dragStartPanY = state.panY;
    return;
  }

  if (state.tool === "pixelate") {
    const [nx, ny] = getCanvasCoords(e);
    if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
      state.isPixelatePainting = true;
      const isRotated = state.rotation === 90 || state.rotation === 270;
      const maxDim = Math.max(
        isRotated ? state.imageHeight : state.imageWidth,
        isRotated ? state.imageWidth : state.imageHeight
      );
      state.currentStroke = {
        points: [[nx, ny]],
        radius: state.pixelateBrushSize / maxDim,
      };
      state.pixelateRedoStack = [];
    }
    return;
  }

  if (state.tool === "eyedropper") {
    pickColor(e);
    return;
  }

  if (state.tool === "crop") {
    // Check if clicking on handle or crop rect
    const target = e.target as HTMLElement;
    const handle = target.dataset?.handle;
    if (handle) {
      cropDragMode = handle;
    } else if (target.id === "crop-rect") {
      cropDragMode = "move";
    } else {
      return;
    }
    cropStartX = e.clientX;
    cropStartY = e.clientY;
    cropStartCropX = state.cropX;
    cropStartCropY = state.cropY;
    cropStartCropW = state.cropW;
    cropStartCropH = state.cropH;
    e.preventDefault();
  }
}

function onCanvasMouseMove(e: MouseEvent) {
  if (state.tool === "select" && isDragging) {
    state.panX = dragStartPanX + (e.clientX - dragStartX);
    state.panY = dragStartPanY + (e.clientY - dragStartY);
    renderCanvas();
    updateCropOverlay();
    return;
  }

  if (state.tool === "pixelate" && state.isPixelatePainting && state.currentStroke) {
    const [nx, ny] = getCanvasCoords(e);
    if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
      state.currentStroke.points.push([nx, ny]);
      // Live preview
      state.pixelateStrokes.push(state.currentStroke);
      renderCanvas();
      state.pixelateStrokes.pop();
    }
    return;
  }

  if (state.tool === "crop" && cropDragMode) {
    const canvas = $("main-canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - cropStartX) / rect.width;
    const dy = (e.clientY - cropStartY) / rect.height;

    handleCropDrag(dx, dy);
    updateCropOverlay();
  }
}

function onCanvasMouseUp(_e: MouseEvent) {
  isDragging = false;

  if (state.isPixelatePainting && state.currentStroke) {
    state.pixelateStrokes.push(state.currentStroke);
    state.currentStroke = null;
    state.isPixelatePainting = false;
    renderCanvas();
  }

  cropDragMode = null;
}

function onCanvasWheel(e: WheelEvent) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  setZoom(state.zoom * delta);
}

function pickColor(e: MouseEvent) {
  if (!loadedImage) return;
  const canvas = $("main-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height);

  if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    state.bgColor = [pixel[0], pixel[1], pixel[2]];
    const hex = `#${pixel[0].toString(16).padStart(2, "0")}${pixel[1].toString(16).padStart(2, "0")}${pixel[2].toString(16).padStart(2, "0")}`;
    $("bg-color-preview").style.background = hex;
    $("bg-color-text").textContent = hex;
    showToast(`Color picked: ${hex}`, "success");
  }
}

// ─── Crop Handling ───────────────────────────────────────────────────────────

function handleCropDrag(dx: number, dy: number) {
  const mode = cropDragMode!;
  let { cropX: x, cropY: y, cropW: w, cropH: h } = {
    cropX: cropStartCropX,
    cropY: cropStartCropY,
    cropW: cropStartCropW,
    cropH: cropStartCropH,
  };

  if (mode === "move") {
    x += dx;
    y += dy;
  } else {
    if (mode.includes("w")) {
      x += dx;
      w -= dx;
    }
    if (mode.includes("e")) {
      w += dx;
    }
    if (mode.includes("n")) {
      y += dy;
      h -= dy;
    }
    if (mode.includes("s")) {
      h += dy;
    }
  }

  // Enforce aspect ratio if locked
  if (state.lockAspect && mode !== "move") {
    const aspect = state.targetWidth / state.targetHeight;
    if (mode.includes("e") || mode.includes("w")) {
      h = w / aspect;
    } else {
      w = h * aspect;
    }
  }

  // Clamp
  w = Math.max(0.02, Math.min(1, w));
  h = Math.max(0.02, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));

  state.cropX = x;
  state.cropY = y;
  state.cropW = w;
  state.cropH = h;
}

function updateCropOverlay() {
  if (!loadedImage) return;

  const canvas = $("main-canvas") as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const container = $("canvas-container");
  const containerRect = container.getBoundingClientRect();

  const cropRect = $("crop-rect");
  const offsetX = rect.left - containerRect.left;
  const offsetY = rect.top - containerRect.top;

  cropRect.style.left = offsetX + state.cropX * rect.width + "px";
  cropRect.style.top = offsetY + state.cropY * rect.height + "px";
  cropRect.style.width = state.cropW * rect.width + "px";
  cropRect.style.height = state.cropH * rect.height + "px";
}

function onCropPresetChange() {
  const preset = ($("crop-preset") as HTMLSelectElement).value;
  if (preset === "free") {
    state.lockAspect = false;
    ($("lock-aspect") as HTMLInputElement).checked = false;
    return;
  }
  if (preset === "custom") return;

  const [w, h] = preset.split(":").map(Number);
  state.targetWidth = ($("crop-width") as HTMLInputElement).valueAsNumber || w * 100;
  state.targetHeight = Math.round(state.targetWidth * (h / w));
  ($("crop-height") as HTMLInputElement).value = String(state.targetHeight);
  state.lockAspect = true;
  ($("lock-aspect") as HTMLInputElement).checked = true;

  // Adjust crop rect to match aspect
  const aspect = w / h;
  if (state.cropW / state.cropH > aspect) {
    state.cropW = state.cropH * aspect;
  } else {
    state.cropH = state.cropW / aspect;
  }
  state.cropX = Math.min(state.cropX, 1 - state.cropW);
  state.cropY = Math.min(state.cropY, 1 - state.cropH);
  updateCropOverlay();
}

function onCropSizeChange() {
  state.targetWidth = ($("crop-width") as HTMLInputElement).valueAsNumber || 800;
  state.targetHeight = ($("crop-height") as HTMLInputElement).valueAsNumber || 600;
}

// ─── Pixelate Undo/Redo ──────────────────────────────────────────────────────

function undoStroke() {
  if (state.pixelateStrokes.length > 0) {
    state.pixelateRedoStack.push(state.pixelateStrokes.pop()!);
    renderCanvas();
  }
}

function redoStroke() {
  if (state.pixelateRedoStack.length > 0) {
    state.pixelateStrokes.push(state.pixelateRedoStack.pop()!);
    renderCanvas();
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

function showExportModal() {
  if (!state.sourcePath) return;
  $("export-size-info").textContent = `${state.targetWidth} × ${state.targetHeight}`;
  $("export-modal").style.display = "flex";
}

async function doExport() {
  if (!state.sourcePath) return;

  const format = ($("export-format") as HTMLSelectElement).value;
  const ext = format === "jpeg" ? "jpg" : "png";
  const quality = parseInt(($("jpeg-quality") as HTMLInputElement).value);

  const outputPath = await dialogSave({
    filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    defaultPath: `export.${ext}`,
  });

  if (!outputPath) return;

  $("export-modal").style.display = "none";

  try {
    await invoke("export_image", {
      payload: {
        source_path: state.sourcePath,
        output_path: outputPath,
        output_format: format,
        jpeg_quality: quality,
        target_width: state.targetWidth,
        target_height: state.targetHeight,
        crop:
          state.cropW < 1 || state.cropH < 1 || state.cropX > 0 || state.cropY > 0
            ? {
                x: state.cropX,
                y: state.cropY,
                width: state.cropW,
                height: state.cropH,
              }
            : null,
        rotation: state.rotation,
        flip_h: state.flipH,
        flip_v: state.flipV,
        grayscale: state.grayscale,
        brightness: state.brightness,
        contrast: state.contrast,
        pixelate_strokes: state.pixelateStrokes,
        pixelate_block_size: state.pixelateBlockSize,
        bg_removal: state.bgEnabled
          ? {
              enabled: true,
              color: state.bgColor,
              tolerance: state.bgTolerance / 100,
            }
          : null,
        mode: state.scaleMode,
      },
    });

    showToast("Exported to " + outputPath, "success");
  } catch (e: any) {
    showToast("Export failed: " + e, "error");
  }
}

// ─── Recents ─────────────────────────────────────────────────────────────────

async function showRecentsModal() {
  $("recents-modal").style.display = "flex";
  try {
    const files: string[] = await invoke("get_recent_files");
    const list = $("recents-list");
    if (files.length === 0) {
      list.innerHTML = '<div class="recents-empty">No recent files</div>';
    } else {
      list.innerHTML = files
        .map(
          (f) =>
            `<div class="recent-item" data-path="${f.replace(/"/g, "&quot;")}">${f.split("/").pop() || f}<br/><small style="color:var(--text-muted)">${f}</small></div>`
        )
        .join("");
      list.querySelectorAll<HTMLDivElement>(".recent-item").forEach((item) => {
        item.addEventListener("click", async () => {
          $("recents-modal").style.display = "none";
          await loadImage(item.dataset.path!);
        });
      });
    }
  } catch (_) {
    $("recents-list").innerHTML = '<div class="recents-empty">Failed to load recents</div>';
  }
}

// ─── Updates ─────────────────────────────────────────────────────────────────

async function showUpdateModal() {
  $("update-modal").style.display = "flex";
  $("btn-update-install").style.display = "none";

  try {
    // Try to use tauri updater if available
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      $("update-content").innerHTML = `
        <p><strong>Update available!</strong></p>
        <p>Current: v0.1.0</p>
        <p>Latest: v${update.version}</p>
      `;
      $("btn-update-install").style.display = "inline-block";
      $("btn-update-install").onclick = async () => {
        $("update-content").innerHTML = "<p>Downloading and installing...</p>";
        $("btn-update-install").style.display = "none";
        try {
          await update.downloadAndInstall();
          $("update-content").innerHTML = "<p>Update installed! Restart the app to use the new version.</p>";
        } catch (e: any) {
          $("update-content").innerHTML = `<p>Update failed: ${e}</p>`;
        }
      };
    } else {
      $("update-content").innerHTML = "<p>You're up to date!</p>";
    }
  } catch (_) {
    $("update-content").innerHTML = "<p>Auto-updater not available in dev mode. You're up to date!</p>";
  }
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent) {
  const ctrl = e.metaKey || e.ctrlKey;

  if (ctrl && e.key === "o") {
    e.preventDefault();
    openFile();
  } else if (ctrl && e.key === "s") {
    e.preventDefault();
    if (state.sourcePath) showExportModal();
  } else if (ctrl && e.shiftKey && e.key === "z") {
    e.preventDefault();
    redoStroke();
  } else if (ctrl && e.key === "z") {
    e.preventDefault();
    undoStroke();
  } else if (e.key === "1" && !ctrl) {
    zoomFit();
  } else if (e.key === "2" && !ctrl) {
    setZoom(1);
  }
}

// ─── Apply Edits ─────────────────────────────────────────────────────────────

async function applyEdits() {
  if (!state.sourcePath) return;

  const hasEdits =
    state.rotation !== 0 ||
    state.flipH ||
    state.flipV ||
    state.grayscale ||
    state.brightness !== 0 ||
    state.contrast !== 0 ||
    state.pixelateStrokes.length > 0;

  if (!hasEdits) {
    showToast("No adjustments to apply", "error");
    return;
  }

  try {
    const info: ImageInfo = await invoke("apply_edits", {
      payload: {
        source_path: state.sourcePath,
        rotation: state.rotation,
        flip_h: state.flipH,
        flip_v: state.flipV,
        grayscale: state.grayscale,
        brightness: state.brightness,
        contrast: state.contrast,
        pixelate_strokes: state.pixelateStrokes,
        pixelate_block_size: state.pixelateBlockSize,
      },
    });

    // Update source to the applied temp file
    const appliedPath: string = await invoke("get_applied_path");
    state.sourcePath = appliedPath;
    state.imageWidth = info.width;
    state.imageHeight = info.height;

    // Reset all adjustments
    state.rotation = 0;
    state.flipH = false;
    state.flipV = false;
    state.grayscale = false;
    state.brightness = 0;
    state.contrast = 0;
    state.pixelateStrokes = [];
    state.pixelateRedoStack = [];

    ($("edit-brightness") as HTMLInputElement).value = "0";
    ($("edit-contrast") as HTMLInputElement).value = "0";
    ($("edit-grayscale") as HTMLInputElement).checked = false;
    $("brightness-val").textContent = "0";
    $("contrast-val").textContent = "0";

    // Reload the canvas with the new image
    const img = new Image();
    img.onload = () => {
      loadedImage = img;
      $("image-info").textContent = `${info.width} × ${info.height} — Applied`;
      renderCanvas();
      if (state.tool === "crop") updateCropOverlay();
    };
    img.src = info.data_url;

    showToast("Adjustments applied", "success");
  } catch (e: any) {
    showToast("Apply failed: " + e, "error");
  }
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function showToast(message: string, type: "success" | "error" = "success") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = "toast show " + type;
  setTimeout(() => {
    toast.className = "toast";
  }, 3000);
}

// ─── Theme ───────────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem("pixelargon-theme");
  if (saved === "light") {
    document.documentElement.classList.add("light");
    $("btn-theme").textContent = "Dark";
  }
}

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle("light");
  $("btn-theme").textContent = isLight ? "Dark" : "Light";
  localStorage.setItem("pixelargon-theme", isLight ? "light" : "dark");
}

// ─── Init ────────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", initApp);
