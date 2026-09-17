/* Bedtime - the shapes the modules pass between each other.
 *
 * Every module is a plain script that hangs an object on the global `App`, so
 * the compiler needs to be told what that object looks like. These are the
 * seams where a mistake used to be invisible until a phone hit it: a story
 * record missing a field, a call with the arguments the other way round.
 */

/** One imported story, as stored in IndexedDB and carried around in memory. */
interface Story {
  id: string;
  title: string;
  narrator?: string;
  album?: string;
  mood?: string;
  hue?: number;
  /** Bytes of audio held for this story. */
  size: number;
  /** Length in seconds, from the decoder rather than a guess. */
  len: number;
  /** 1 MiB pieces the audio was split into. */
  chunkCount: number;
  /** The file's own content type, kept for playback. */
  mime?: string;
  /** The size the audio was cut into, so a chunk index can be turned into bytes. */
  chunkSize?: number;
  /** How many chapters the file carried; one, for anything we can read. */
  chapters?: number;
  addedAt: number;
  /** Where playback stopped, in seconds. */
  pos?: number;
  lastPlayedAt?: number;
  fav?: boolean;
  /** When this story was put in tonight's queue; 0 or absent means it is not. */
  pickAt?: number;
  hasArt?: boolean;
  /** An artwork lookup has already been tried and found nothing. */
  artTried?: boolean;
  /** The audio is gone - iOS reclaimed it - so the row is shown but not played. */
  missing?: boolean;
}

interface Settings {
  childName: string;
  bedtime: string;
  perNight: number;
  sleepMinutes: number;
  dim: boolean;
  resume: boolean;
  artwork: boolean;
  showOurs: boolean;
}

interface WeekSummary {
  seconds: number;
  nights: number;
  slept: number;
}

interface ArtRow {
  data: ArrayBuffer;
  type: string;
}

interface FoundArtwork {
  image: { data: ArrayBuffer; type: string } | null;
  /** Whether a lookup actually reached a host, as opposed to failing offline. */
  searched: boolean;
}

interface Tags {
  title?: string;
  artist?: string;
  album?: string;
  picture?: { data: ArrayBuffer; type: string } | null;
}

/* Where the audio for a story is going to be played from. Not `MediaSource`:
 * that name is taken by the Media Source Extensions API in lib.dom, and an
 * interface of the same name merges with it rather than replacing it, so every
 * value of this type was quietly expected to have `activeSourceBuffers`. */
interface PlaybackSource {
  url: string;
  viaServiceWorker: boolean;
}

/** What the player tells the screen about. */
interface PlayerHandlers {
  tick?: (position: number, length: number) => void;
  state?: (playing: boolean) => void;
  sleep?: (secondsLeft: number) => void;
  asleep?: () => void;
  /** `carried` is seconds left in minutes mode, or stories left in story mode. */
  ended?: (carried: number) => void;
  loaded?: (story: Story) => void;
  error?: (message: string) => void;
}

interface LoadOptions {
  autoplay?: boolean;
  startAt?: number;
}

/** A row in the import screen, while a file is being copied in. */
interface ImportRow {
  key: string;
  name: string;
  art: string;
  artLabel: string;
  percent: number;
  status: string;
  state: string;
  storyId: string | null;
  done: boolean;
}

declare namespace App {
  let debug: any;
}

declare var preact: any;
declare var htm: any;

/* The modules themselves. Each file assigns one of these onto `App`. */

interface UiModule {
  $(id: string): HTMLElement;
  el(tag: string, className?: string | null, text?: string | null): HTMLElement;
  clear(node: Node): void;
  show(node: HTMLElement | null, visible: boolean): void;
  toggleClass(node: Element | null, className: string, on: boolean): void;
  text(node: HTMLElement | null, value: string): void;
  clock(seconds: number): string;
  minutes(seconds: number): string;
  bytes(size: number): string;
  stripes(seed: number, light?: boolean): string;
  paintCover(node: HTMLElement | null, story: Story, light?: boolean): void;
  toast(message: string): void;
  ring(node: Element | null, fraction: number): void;
}

interface StoreModule {
  CHUNK_SIZE: number;
  open(): Promise<IDBDatabase>;
  getStories(): Promise<Story[]>;
  getStory(id: string): Promise<Story | undefined>;
  /** Resolves with the row it wrote, not just completion. */
  putStory(story: Story): Promise<Story>;
  /** Resolves with the patched row, or null where there was nothing to patch. */
  patchStory(id: string, patch: Partial<Story>): Promise<Story | null>;
  deleteStory(id: string): Promise<void>;
  putChunk(storyId: string, index: number, buffer: ArrayBuffer): Promise<void>;
  getChunk(storyId: string, index: number): Promise<ArrayBuffer | null>;
  hasChunk(storyId: string, index: number): Promise<boolean>;
  getChunks(storyId: string, from: number, to: number): Promise<ArrayBuffer[]>;
  chunkOwners(): Promise<string[]>;
  deleteChunks(storyId: string): Promise<void>;
  putArt(storyId: string, data: ArrayBuffer, type: string): Promise<void>;
  getArt(storyId: string): Promise<ArtRow | null>;
  kvGet<T>(key: string, fallback: T): Promise<T>;
  kvSet(key: string, value: any): Promise<void>;
  /** Total bytes of audio held, counted from the stories themselves. */
  usage(): Promise<number>;
}

interface SettingsModule {
  load(): Promise<Settings>;
  get(): Settings;
  set(patch: Partial<Settings>): Settings;
  flush(): void;
  DEFAULTS: Settings;
}

interface StatsModule {
  load(): Promise<any>;
  flush(): void;
  addListening(seconds: number): void;
  recordNight(sleptThrough: boolean): void;
  week(): WeekSummary;
  storiesTonight(stories: Story[]): number;
  dayKey(when: number): string;
}

interface MediaModule {
  source(story: Story): Promise<PlaybackSource>;
  blobUrl(story: Story): Promise<string>;
  /** Asks the service worker's media route whether it works on this browser. */
  probe(): Promise<boolean>;
  /** Gives up on the service worker route for the rest of the session. */
  demote(): void;
  usingServiceWorker(): boolean | null;
  release(storyId: string): void;
  releaseAll(): void;
  artUrl(storyId: string): Promise<string | null>;
  forgetArt(storyId: string): void;
}

interface PlayerModule {
  init(): void;
  on(map: PlayerHandlers): void;
  load(story: Story, options?: LoadOptions): Promise<unknown>;
  play(): Promise<unknown>;
  pause(): void;
  toggle(): Promise<unknown>;
  unload(): void;
  seekBy(seconds: number): void;
  seekTo(seconds: number): void;
  wake(): Promise<unknown>;
  position(): number;
  duration(): number;
  playing(): boolean;
  ended(): boolean;
  currentStory(): Story | null;
  setSleepMinutes(minutes: number): void;
  setSleepStories(count: number): void;
  carrySleep(value: number): void;
  defaultSleepMinutes(minutes: number): void;
  currentSleepMinutes(): number;
  currentSleepStories(): number;
  sleepByStories(): number;
  sleepLeft(): number;
  fadeLevel(): number | null;
  isAsleep(): boolean;
  ticking(): boolean;
  checkpoint(force: boolean): void;
}

interface ImporterModule {
  importFile(file: File, onProgress: (fraction: number) => void): Promise<Story>;
  /** Resolves when the new cover is stored; what it resolves with is nobody's business. */
  setArt(storyId: string, file: File): Promise<unknown>;
  looksLikeAudio(file: File): boolean;
  titleFromName(name: string): string;
  hash(text: string): number;
}

interface ArtworkModule {
  find(title: string, narrator?: string): Promise<FoundArtwork | null>;
  shrink(data: ArrayBuffer, type: string): Promise<{ data: ArrayBuffer; type: string } | null>;
  store(storyId: string, data: ArrayBuffer, type: string): Promise<void>;
  clean(text: string): string;
  /** How much of the wanted title the found one covers, from 0 to 1. */
  match(wanted: string, found: string): number;
  upscale(url: string): string;
}

interface CapsModule {
  supports(name: string): boolean;
  readArrayBuffer(blob: Blob): Promise<ArrayBuffer>;
  idle(fn: () => void, delay: number): void;
  requestPersistence(): Promise<boolean | null>;
  persisted(): Promise<boolean | null>;
  estimate(): Promise<{ usage: number; quota: number } | null>;
  claimPlaybackAudio(): void;
  media: {
    setActions(actions: Record<string, () => void>): void;
    setMetadata(info: Record<string, string>): void;
    setPlaybackState(playing: boolean): void;
    setPosition(duration: number, position: number, rate: number): void;
    clear(): void;
  };
  onInstallAvailable(fn: (available: boolean) => void): void;
  promptInstall(): Promise<boolean>;
}

interface TagsModule {
  read(file: File): Promise<Tags>;
}

interface ViewsModule {
  rows(host: HTMLElement, list: Story[], on: any): void;
  picks(host: HTMLElement, list: Story[], on: any): void;
  moods(host: HTMLElement, names: string[], current: string, on: any): void;
  emptyState(host: HTMLElement, hiddenByParent: boolean, on: any): void;
  timerOptions(host: HTMLElement, model: any, on: any): void;
  toggles(host: HTMLElement, list: any[], on: any): void;
  storedList(host: HTMLElement, list: Story[], on: any): void;
  menuActions(host: HTMLElement, items: any[]): void;
  imports(host: HTMLElement, list: ImportRow[], on: any): void;
}

declare namespace App {
  let ui: UiModule;
  let store: StoreModule;
  let settings: SettingsModule;
  let stats: StatsModule;
  let media: MediaModule;
  let player: PlayerModule;
  let importer: ImporterModule;
  let artwork: ArtworkModule;
  let caps: CapsModule;
  let tags: TagsModule;
  let views: ViewsModule;
}
