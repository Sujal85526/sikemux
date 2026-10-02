const TAGS = ['Refused', 'WrongCode', 'Connection', 'Invalid', 'Outdated'] as const;
type Tag = (typeof TAGS)[number];

class FakeMobileError extends Error {
  constructor(
    readonly tag: Tag,
    readonly inner: { message: string },
  ) {
    super(`MobileError.${tag}`);
  }
}

function variant(tag: Tag) {
  return {
    new: (inner: { message: string } = { message: tag }) => new FakeMobileError(tag, inner),
    instanceOf: (error: unknown): error is FakeMobileError => error instanceof FakeMobileError && error.tag === tag,
  };
}

export const MobileError = Object.fromEntries(TAGS.map((tag) => [tag, variant(tag)])) as Record<Tag, ReturnType<typeof variant>>;

function notMocked(name: string): never {
  throw new Error(`@sikemux/native ${name} runs Rust; vi.mock('@sikemux/native') in the test that needs it`);
}

export const newDeviceKey = (): ArrayBuffer => new Uint8Array(32).buffer;
export const parsePairingLink = (_text: string): undefined => undefined;

export class Device {
  constructor() {
    notMocked('Device');
  }
}
