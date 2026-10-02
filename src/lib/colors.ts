import type { RGB } from "./simulation";

export const SHIP_COLORS: { name: string; color: RGB }[] = [
  { name: "GREEN", color: [0, 255, 100] },
  { name: "RED", color: [255, 80, 80] },
  { name: "BLUE", color: [80, 130, 255] },
  { name: "YELLOW", color: [255, 255, 0] },
  { name: "MAGENTA", color: [255, 0, 255] },
  { name: "CYAN", color: [0, 255, 255] },
  { name: "ORANGE", color: [255, 165, 0] },
  { name: "PINK", color: [255, 120, 200] },
  { name: "LIGHT GREEN", color: [150, 255, 150] },
  { name: "LAVENDER", color: [200, 150, 255] },
];

export function shipColorName(color: RGB): string {
  return (
    SHIP_COLORS.find((ship) => ship.color.every((value, index) => value === color[index]))?.name ??
    "SHIP"
  );
}
