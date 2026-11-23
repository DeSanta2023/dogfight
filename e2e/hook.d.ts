/** What a page exposes through `?debug=1` (window.dogfight): enough for a test to look inside the game. */
interface DogfightHook {
  session: { slot: number } | null;
  net: {
    latest: {
      snap: {
        own: { alive: boolean; x: number; y: number };
        ships: { slot: number; x: number; y: number }[];
      };
    } | null;
  } | null;
}
interface Window {
  dogfight: DogfightHook;
}
