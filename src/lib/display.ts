import { MAP_WIDTH, getTerrainHeightAt, type Lander, type MapLine } from "./simulation";

export interface DisplayShip {
  id: string;
  lander: Lander;
}

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function approachBounds(ships: DisplayShip[], terrain: MapLine[]): DisplayBounds {
  const anchor = ships[0].lander.x;
  const xs = ships.map(({ lander }) => anchor + wrappedDistance(lander.x - anchor));
  const left = Math.min(...xs) - 80;
  const right = Math.max(...xs) + 80;
  const bottom = Math.min(...ships.map(({ lander }) => getTerrainHeightAt(lander.x, terrain))) - 80;
  const top = Math.max(...ships.map(({ lander }) => lander.y)) + 80;
  return {
    x: ((left + right) / 2 + MAP_WIDTH) % MAP_WIDTH,
    y: (bottom + top) / 2,
    width: Math.max(300, right - left),
    height: Math.max(240, top - bottom),
  };
}

export function wrappedDistance(distance: number): number {
  return (((distance % MAP_WIDTH) + MAP_WIDTH * 1.5) % MAP_WIDTH) - MAP_WIDTH / 2;
}

export function groupApproaches(
  ships: DisplayShip[],
  terrain: MapLine[],
  width: number,
  height: number,
): DisplayShip[][] {
  // Five simultaneous approaches always use the fleet view, even if clustered.
  if (ships.length === 0 || ships.length > 4) return [];
  const closeScale = Math.min(1.5, width / 600, height / 400);
  const fits = (group: DisplayShip[]) => {
    const bounds = approachBounds(group, terrain);
    return Math.min((width - 40) / bounds.width, (height - 80) / bounds.height) >= closeScale;
  };
  if (fits(ships)) return [ships];
  const groups: DisplayShip[][] = [];
  for (const ship of ships) {
    const nearby = groups.find((group) => fits([...group, ship]));
    if (nearby) nearby.push(ship);
    else groups.push([ship]);
  }
  return groups;
}

export function displayViewports(count: number, width: number, height: number): DisplayBounds[] {
  if (count <= 1) return [{ x: 0, y: 0, width, height }];
  if (count === 2) {
    return width >= height
      ? [0, 1].map((i) => ({ x: (i * width) / 2, y: 0, width: width / 2, height }))
      : [0, 1].map((i) => ({ x: 0, y: (i * height) / 2, width, height: height / 2 }));
  }
  return Array.from({ length: count }, (_, i) => ({
    x: count === 3 && i === 2 ? 0 : ((i % 2) * width) / 2,
    y: (Math.floor(i / 2) * height) / 2,
    width: count === 3 && i === 2 ? width : width / 2,
    height: height / 2,
  }));
}
