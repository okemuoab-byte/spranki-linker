// Module-level state — persists across re-renders within the same page load
let dragAbortController: AbortController | null = null;
let overlayPosition: { left: number; top: number } | null = null;

export function makeDraggable(el: HTMLElement): void {
  // Abort stale listeners from previous render
  if (dragAbortController) dragAbortController.abort();
  dragAbortController = new AbortController();
  const { signal } = dragAbortController;

  // Restore last known drag position so overlay doesn't jump on re-render
  if (overlayPosition) {
    el.style.left = `${overlayPosition.left}px`;
    el.style.top = `${overlayPosition.top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  const header = el.querySelector<HTMLElement>(".spranki-header")!;
  header.style.cursor = "grab";

  header.addEventListener(
    "mousedown",
    (e) => {
      if ((e.target as Element).closest("button")) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      header.style.cursor = "grabbing";
    },
    { signal }
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!isDragging) return;
      const left = origLeft + e.clientX - startX;
      const top = origTop + e.clientY - startY;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      overlayPosition = { left, top };
    },
    { signal }
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (!isDragging) return;
      isDragging = false;
      header.style.cursor = "grab";
    },
    { signal }
  );
}
