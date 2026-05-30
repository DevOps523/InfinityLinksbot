export function encodeSeasonCallback(seasonId: number) {
  return `season:${seasonId}`;
}

export function decodeSeasonCallback(value: string) {
  const match = /^season:(\d+)$/.exec(value);
  return match ? Number(match[1]) : undefined;
}
