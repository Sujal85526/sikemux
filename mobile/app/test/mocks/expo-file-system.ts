function notMocked(name: string): never {
  throw new Error(`expo-file-system ${name} touches the phone's disk; vi.mock('expo-file-system') in the test that needs it`);
}

export const Paths = { document: { uri: 'file:///document/' }, cache: { uri: 'file:///cache/' } };

export class File {
  constructor(..._parts: unknown[]) {
    notMocked('File');
  }
}

export class Directory {
  constructor(..._parts: unknown[]) {
    notMocked('Directory');
  }
}
