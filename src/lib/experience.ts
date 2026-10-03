import { startGame } from "./game";
import { normalizeName } from "./names";

const NAME_STORAGE_KEY = "lunar-player-name";

export function startExperience(
  canvas: HTMLCanvasElement,
  host: string,
  form: HTMLFormElement | null,
): void {
  if (canvas.dataset.display === "true") {
    startGame(canvas, host, { display: true });
    return;
  }
  let savedName = "";
  try {
    savedName = normalizeName(localStorage.getItem(NAME_STORAGE_KEY));
  } catch {
    // Players can still join when browser storage is unavailable.
  }
  if (savedName) {
    if (form) form.hidden = true;
    startGame(canvas, host, { name: savedName });
    return;
  }
  if (!form) throw new Error("Player name form is missing");
  const input = form.elements.namedItem("name") as HTMLInputElement;
  form.hidden = false;
  input.focus();
  input.addEventListener("input", () => input.setCustomValidity(""));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = normalizeName(input.value);
    if (!name) {
      input.setCustomValidity("Enter your name to launch.");
      input.reportValidity();
      return;
    }
    if (form.hidden) return;
    try {
      localStorage.setItem(NAME_STORAGE_KEY, name);
    } catch {
      // Saving is optional; the name is still sent to the game server.
    }
    form.hidden = true;
    startGame(canvas, host, { name });
  });
}
