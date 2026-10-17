function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
}

/** Keep the game, HUD and navigation together in real native fullscreen. */
export function mountFullscreenControls(canvas: HTMLCanvasElement): () => void {
  const shell = document.querySelector<HTMLElement>("#game-shell")!;
  const button = shell.querySelector<HTMLButtonElement>("#fullscreen")!;
  const label = button.querySelector<HTMLElement>("[data-label]")!;
  const icon = button.querySelector<SVGUseElement>("use")!;
  const status = shell.querySelector<HTMLElement>("#fullscreen-status")!;
  const begin = shell.querySelector<HTMLButtonElement>("#start-button")!;
  const supported = document.fullscreenEnabled === true
    && typeof shell.requestFullscreen === "function"
    && typeof document.exitFullscreen === "function";
  let disposed = false;
  let pending = false;
  let focusFrame = 0;

  const setStatus = (message: string): void => {
    status.textContent = message;
    status.hidden = !message;
  };
  const sync = (): void => {
    const active = document.fullscreenElement === shell;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
    button.title = active ? "Exit fullscreen (F or Esc)" : "Enter fullscreen (F)";
    label.textContent = active ? "Exit fullscreen" : "Fullscreen";
    icon.setAttribute("href", active ? "#fullscreen-exit-icon" : "#fullscreen-enter-icon");
    setStatus(supported ? "" : "Native fullscreen is unavailable here. The game still fills this window.");
  };
  const focusCanvas = (): void => {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      if (!disposed) canvas.focus();
    });
  };
  const change = async (mode: "enter" | "exit" | "toggle"): Promise<void> => {
    if (disposed || pending) return;
    const active = document.fullscreenElement === shell;
    if (!supported) {
      sync();
      focusCanvas();
      return;
    }
    if ((mode === "enter" && active) || (mode === "exit" && !active)) return;
    pending = true;
    try {
      // Call before the first await: Begin/button/F retain trusted user activation.
      if (active) await document.exitFullscreen();
      else await shell.requestFullscreen({ navigationUI: "hide" });
      if (!disposed) sync();
    } catch (error) {
      if (!disposed) {
        sync();
        setStatus(document.fullscreenElement === shell
          ? "Could not exit fullscreen. Press Esc to leave."
          : "Fullscreen was blocked. The game still fills this window.");
        console.warn("Skybound fullscreen transition failed", error);
      }
    } finally {
      pending = false;
      if (!disposed) focusCanvas();
    }
  };
  const onBegin = (): void => { void change("enter"); };
  const onToggle = (): void => { void change("toggle"); };
  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) return;
    const escape = event.key === "Escape" && document.fullscreenElement === shell;
    if (event.code !== "KeyF" && !escape) return;
    event.preventDefault();
    void change(escape ? "exit" : "toggle");
  };
  const onChange = (): void => {
    sync();
    focusCanvas();
  };
  begin.addEventListener("click", onBegin, true);
  button.addEventListener("click", onToggle);
  window.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onChange);
  sync();

  return () => {
    disposed = true;
    cancelAnimationFrame(focusFrame);
    begin.removeEventListener("click", onBegin, true);
    button.removeEventListener("click", onToggle);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onChange);
    if (document.fullscreenElement === shell) void document.exitFullscreen().catch(() => undefined);
  };
}
